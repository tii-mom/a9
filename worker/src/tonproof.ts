/**
 * 写接口鉴权（P1-A）：TON Connect ton_proof 本地验签 + 一次性 nonce 防重放。
 *
 * 消息按 TON Connect ton_proof v2 规范构造：
 *   message = "ton-proof-item-v2/" || workchain(int32 BE) || addressHash(32B) || domainLen(int32 BE)
 *             || domain(utf8) || timestamp(int64 BE) || payload(utf8)
 *   signature = ed25519_sign(sha256(message))
 *
 * 说明 / TODO(chain 模式)：
 *  - 演示模式（DATA_SOURCE=demo 且 DEMO_ALLOW_UNSIGNED_WRITES=true）允许无签名写接口；
 *    生产/chain 模式必须带签名，且 chain 模式的写接口本身返回 501（请直接与合约交互）。
 *  - 当前 publicKey 由客户端提供并与地址做「首次绑定」（TOFU，D1 wallet_bindings）。
 *    严格版应从 ton_proof.state_init 解析钱包公钥并校验地址=hash(state_init)，或调用
 *    tonapi /v2/account/verify；该替换点已集中在 resolvePublicKey()，接入时无需改调用方。
 */
import type { Env } from './env';
import type { TonProof } from '@shared/types';
import * as store from './store';
import { ApiError, badRequest, unauthorized } from './http';

const DEFAULT_PROOF_DOMAINS = 'a9.lat,www.a9.lat,localhost,127.0.0.1';
const MAX_SKEW_SECONDS = 300;
const NONCE_TTL_MS = 5 * 60 * 1000;

/* ----------------------------- 编解码 ----------------------------- */

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function decodePublicKey(publicKey: string): Uint8Array | null {
  const hex = hexToBytes(publicKey);
  if (hex && hex.length === 32) return hex;
  try {
    const raw = base64ToBytes(publicKey);
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

function i32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

function i64be(value: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  const big = BigInt(Math.trunc(value));
  view.setUint32(0, Number((big >> 32n) & 0xffffffffn), false);
  view.setUint32(4, Number(big & 0xffffffffn), false);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 解析 TON 用户友好地址（UQ/EQ, 48 chars base64url）→ workchain + 32 字节 hash。 */
export function decodeTonAddress(address: string): { workchain: number; hash: Uint8Array } | null {
  try {
    const raw = base64ToBytes(address);
    if (raw.length < 36) return null;
    let workchain = raw[1];
    if (workchain > 127) workchain -= 256;
    const hash = raw.slice(2, 34);
    if (hash.length !== 32) return null;
    return { workchain, hash };
  } catch {
    return null;
  }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

/** TON Connect ton_proof v2 的待签名摘要（sha256 后由 ed25519 签名）。 */
export async function buildTonProofDigest(input: {
  address: string;
  domain: string;
  domainLengthBytes: number;
  timestamp: number;
  payload: string;
}): Promise<Uint8Array> {
  const parsed = decodeTonAddress(input.address);
  if (!parsed) throw unauthorized();
  const encoder = new TextEncoder();
  const message = concatBytes([
    encoder.encode('ton-proof-item-v2/'),
    i32be(parsed.workchain),
    parsed.hash,
    i32be(input.domainLengthBytes),
    encoder.encode(input.domain),
    i64be(input.timestamp),
    encoder.encode(input.payload),
  ]);
  return sha256(message);
}

async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
  } catch (error) {
    console.error('[tonproof] ed25519 verify unavailable', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/* ----------------------------- 业务 ----------------------------- */

/** 解析 proof：body.proof 优先，其次 X-Ton-Proof（base64 JSON）。 */
function resolveProof(request: Request, body: Record<string, unknown>): TonProof | null {
  const fromBody = body.proof;
  if (fromBody && typeof fromBody === 'object') return fromBody as TonProof;
  const header = request.headers.get('x-ton-proof');
  if (header) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(header)));
      if (parsed && typeof parsed === 'object') return parsed as TonProof;
    } catch {
      return null;
    }
  }
  return null;
}

export function noncePayload(nonce: string): string {
  return 'a9-auth:' + nonce;
}

/** GET /api/auth/nonce：下发 5 分钟有效、一次性 nonce。 */
export async function issueAuthNonce(env: Env, address: string, now = Date.now()) {
  const nonce = crypto.randomUUID().replace(/-/g, '') + Math.random().toString(36).slice(2, 10);
  const expiresAt = now + NONCE_TTL_MS;
  await store.insertAuthNonce(env, { nonce, address, createdAt: now, expiresAt });
  return { address, nonce, expiresAt };
}

function allowedProofDomains(env: Env): string[] {
  return (env.TON_PROOF_DOMAINS ?? DEFAULT_PROOF_DOMAINS)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * 写接口鉴权。规则：
 *  - chain 模式：调用方应先返回 501（不进入本函数）；
 *  - demo 且 DEMO_ALLOW_UNSIGNED_WRITES=true：无 proof 时放行（演示宽松路径）；
 *  - 其余：必须带合法 ton_proof，否则 401（不泄露细节）。
 */
export async function requireWriteAuth(
  env: Env,
  request: Request,
  body: Record<string, unknown>,
  address: string,
  now = Date.now(),
): Promise<{ signed: boolean; ip: string }> {
  const ip = clientIp(request);
  const proof = resolveProof(request, body);
  const unsignedAllowed = env.DEMO_ALLOW_UNSIGNED_WRITES === 'true';
  if (!proof) {
    if (unsignedAllowed) return { signed: false, ip };
    throw unauthorized();
  }

  if (typeof proof.timestamp !== 'number' || !Number.isFinite(proof.timestamp)) throw unauthorized();
  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(nowSeconds - proof.timestamp) > MAX_SKEW_SECONDS) throw unauthorized();

  const domain = proof.domain && typeof proof.domain.value === 'string' ? proof.domain.value : '';
  const domainLengthBytes = proof.domain && typeof proof.domain.lengthBytes === 'number' ? proof.domain.lengthBytes : -1;
  if (!domain || !allowedProofDomains(env).includes(domain.toLowerCase())) throw unauthorized();
  if (domainLengthBytes !== new TextEncoder().encode(domain).length) throw unauthorized();

  if (typeof proof.payload !== 'string' || !proof.payload) throw unauthorized();
  if (typeof proof.signature !== 'string' || !proof.signature) throw unauthorized();
  if (typeof proof.publicKey !== 'string' || !proof.publicKey) throw unauthorized();

  const publicKey = decodePublicKey(proof.publicKey);
  if (!publicKey) throw unauthorized();
  const publicKeyHex = bytesToHex(publicKey);

  // 地址 ↔ 公钥绑定：首次成功绑定；后续必须一致，且同一公钥只能绑定一个地址。
  const binding = await store.getWalletBinding(env, address);
  if (binding && binding.public_key.toLowerCase() !== publicKeyHex) throw unauthorized();

  let signature: Uint8Array;
  try {
    signature = base64ToBytes(proof.signature);
  } catch {
    throw unauthorized();
  }
  if (signature.length !== 64) throw unauthorized();

  const digest = await buildTonProofDigest({
    address,
    domain,
    domainLengthBytes,
    timestamp: proof.timestamp,
    payload: proof.payload,
  });
  const valid = await verifyEd25519(publicKey, signature, digest);
  if (!valid) throw unauthorized();

  // 签名通过后再消费一次性 nonce（payload = "a9-auth:<nonce>"），防重放
  const nonce = proof.payload.startsWith('a9-auth:') ? proof.payload.slice('a9-auth:'.length) : proof.payload;
  const consumed = await store.consumeAuthNonce(env, { nonce, address, now });
  if (!consumed) throw unauthorized();

  if (!binding) {
    const bound = await store.insertWalletBinding(env, { address, publicKey: publicKeyHex, now });
    if (!bound) throw unauthorized();
  }
  return { signed: true, ip };
}

/** 限流：/api/admin/*、/api/stake、/api/claim。超阈值抛 429（RATE_LIMITED）。 */
export async function enforceRateLimit(env: Env, request: Request, scope: string, now = Date.now()): Promise<void> {
  const limit = Number(env.RATE_LIMIT_PER_MINUTE ?? '30');
  if (!Number.isFinite(limit) || limit <= 0) return;
  const result = await store.hitRateLimit(env, {
    key: clientIp(request) + '|' + scope,
    now,
    limit,
  });
  if (result.limited) {
    throw new ApiError('RATE_LIMITED', '请求过于频繁，请稍后重试');
  }
}

/** 便捷校验：拒绝显然非法的 proof 字段（用于测试/调试时给出 400 而非 401）。 */
export function assertProofShape(proof: unknown): asserts proof is TonProof {
  if (!proof || typeof proof !== 'object') throw badRequest('proof 必须是对象');
}
