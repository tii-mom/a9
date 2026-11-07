/**
 * 社交层公共常量与小工具（纯函数，无 I/O）。
 * 社交层只读取既有 rounds / stakes / candles 表，写自己的 users / squads / share_clicks / junxiang 表。
 */
import type { Env } from '../env';

/** 社交层需要的额外绑定变量（env.ts 未声明，lead 在 wrangler vars / secrets 中配置）。 */
export interface SocialEnv extends Env {
  /** STON.fi GRAM/USDT 池子地址；未设置则城门接口的 poolUsdt / remainingUsd 返回 null */
  STONFI_POOL_ADDRESS?: string;
  /** Telegram 机器人用户名（不带 @），用于 /s/:code 落地页按钮 */
  TG_BOT_USERNAME?: string;
  /** Telegram 机器人 token：校验 WebApp initData（social/initdata.ts）；与 bot 共用同一 secret */
  TG_BOT_TOKEN?: string;
}

/** TON 上 USDT Jetton master（用于从 STON.fi 池子里取 USDT 侧储备）。 */
export const USDT_MASTER_ADDRESS = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
export const USDT_DECIMALS = 6;

/** 一个赛季 = 10 城（docs/35 §4.3）。 */
export const ROUNDS_PER_SEASON = 10;

/**
 * 邀请码 / 战队码共用的字母表：去掉 0/O/1/I/L，共 31 个字符。
 * 31 不整除 256，生成时用拒绝采样（见 randomCode），避免取模偏差。
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 8;
export const SQUAD_CODE_LENGTH = 6;

const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/;

export function seasonOfRound(roundId: number): number {
  return Math.floor((roundId - 1) / ROUNDS_PER_SEASON) + 1;
}

export function isSquadCode(value: string): boolean {
  return value.length === SQUAD_CODE_LENGTH && CODE_RE.test(value);
}

export function isInviteCode(value: string): boolean {
  return value.length === INVITE_CODE_LENGTH && CODE_RE.test(value);
}

/** 随机码（战队码）：拒绝采样，只接受 < 248（31 × 8）的字节，保证均匀。crypto 在 Workers 与 Node 下都是全局对象。 */
export function randomCode(length: number): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    const bytes = new Uint8Array(length * 2);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit && out.length < length) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return out;
}

/**
 * 邀请码：钱包地址的 SHA-256 前 8 个字节映射到字母表（确定性，GET 无需写库；哈希输出取模的偏差可忽略）。
 * salt 用于极小概率的 invite_code 冲突时重算。
 */
export async function inviteCodeOf(wallet: string, salt = ''): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wallet + '|' + salt)));
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) out += CODE_ALPHABET[digest[i] % CODE_ALPHABET.length];
  return out;
}

/** 对外展示用的脱敏钱包（排行榜）。 */
export function maskWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

/** HTML / SVG 文本转义。 */
export function escapeMarkup(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
