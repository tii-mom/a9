/**
 * 命令解析、Webhook 密钥校验、小程序链接拼装（纯函数）。
 */

export interface ParsedCommand {
  /** 小写命令名，不带 / 和 @bot */
  name: string;
  /** 命令后面的原文（已去掉首尾空白） */
  args: string;
}

/**
 * 解析 Telegram 文本命令。
 * - 非 / 开头返回 null；
 * - 群里 `/team@OtherBot` 这种指向别的机器人的命令返回 null；
 * - `/team@A9Bot` 与 `/team` 等价。
 */
export function parseCommand(text: string | undefined, botUsername?: string): ParsedCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  const [rawName, mention] = head.slice(1).split('@');
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) return null;
  const name = (rawName ?? '').toLowerCase();
  if (!name) return null;
  return { name, args: rest.join(' ') };
}

/** /start 的第一个参数，只允许 Mini App startapp 的安全字符集。不合规则丢弃。 */
export function sanitizeStartPayload(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const first = raw.trim().split(/\s+/)[0];
  return /^[A-Za-z0-9_-]{1,64}$/.test(first) ? first : undefined;
}

/**
 * 校验 X-Telegram-Bot-Api-Secret-Token。
 * 未配置 expected 时一律拒绝（fail closed）；比较用定长异或，避免时序侧信道。
 */
export function verifyWebhookSecret(header: string | null, expected: string | undefined): boolean {
  if (!expected || !header) return false;
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** Mini App 链接：https://t.me/<bot>/app，可带 startapp 参数。 */
export function appLink(username: string, startapp?: string): string {
  const base = `https://t.me/${username}/app`;
  return startapp ? `${base}?startapp=${encodeURIComponent(startapp)}` : base;
}

/** 战队邀请链接：startapp=s_<战队码>（与 docs/35 §4.1 一致）。 */
export function squadInviteLink(username: string, squadCode: string): string {
  return appLink(username, `s_${squadCode}`);
}
