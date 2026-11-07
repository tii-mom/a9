/**
 * Telegram WebApp initData 服务端校验（纯函数 + Web Crypto，无 I/O 之外的副作用）。
 *
 * 规则（https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app）：
 *   secret_key       = HMAC_SHA256(key = "WebAppData", msg = bot_token)
 *   data_check_string = 除 hash 外的所有 key=value（value 为 URL 解码后的原文），按 key 升序，以 \n 连接
 *   hash             = hex(HMAC_SHA256(key = secret_key, msg = data_check_string))
 * 另外要求 auth_date 距今不超过 24 小时，防止旧的 initData 被重放。
 *
 * 只有通过校验的 initData 才能证明 Telegram 用户身份；客户端传来的 tgUserId 一律不可信。
 */

/** initData 最长有效期（秒）。 */
export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
/** 允许服务端时钟领先客户端的容差（秒）。 */
const CLOCK_SKEW_SECONDS = 60;

export type InitDataCheck = { ok: true; tgUserId: string; authDate: number } | { ok: false; reason: string };

const encoder = new TextEncoder();

async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** 定长比较（逐字符异或），避免按位置提前返回泄露 hash 前缀。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 生成 data_check_string。出现重复 key 时返回 null（Telegram 不会产生重复 key，视为伪造）。
 * 导出仅为便于测试。
 */
export function buildDataCheckString(params: URLSearchParams): string | null {
  const keys = [...new Set(params.keys())];
  if (keys.length !== [...params.keys()].length) return null;
  return keys
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${params.get(key) ?? ''}`)
    .join('\n');
}

/** 从 user 字段（JSON）取正整数 id，返回十进制字符串；非法返回 null。 */
function parseUserId(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  return String(id);
}

/**
 * 校验 initData。成功时返回已验证的 Telegram 用户 id（十进制字符串）。
 * @param nowSeconds 当前 unix 秒（由调用方注入，便于测试）
 */
export async function verifyTgInitData(initData: string, botToken: string, nowSeconds: number): Promise<InitDataCheck> {
  const fail = (reason: string): InitDataCheck => ({ ok: false, reason });
  if (!botToken) return fail('no-bot-token');

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return fail('bad-hash');

  const dataCheckString = buildDataCheckString(params);
  if (dataCheckString === null) return fail('duplicate-key');

  const secretKey = await hmacSha256(encoder.encode('WebAppData'), botToken);
  const expected = bytesToHex(await hmacSha256(secretKey, dataCheckString));
  if (!constantTimeEqual(expected, hash.toLowerCase())) return fail('bad-signature');

  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate <= 0) return fail('bad-auth-date');
  const age = nowSeconds - authDate;
  if (age > INIT_DATA_MAX_AGE_SECONDS) return fail('expired');
  if (age < -CLOCK_SKEW_SECONDS) return fail('future');

  const tgUserId = parseUserId(params.get('user'));
  if (!tgUserId) return fail('no-user');

  return { ok: true, tgUserId, authDate };
}
