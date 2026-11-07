/**
 * 战队等级与排名的纯函数（无 I/O，便于单测）。
 * 等级按本城上车人数（distinct 报名地址）：5 / 20 / 100 / 500 → Lv1..Lv4（见 docs/35 §4.3）。
 */
import { parseTonAddress } from '../indexer/address';

/** 各等级所需人数（Lv1..Lv4） */
export const SQUAD_LEVELS = [5, 20, 100, 500] as const;

/** 战队码字母表：去掉 0/1/I/L/O，避免口头报码时混淆；共 31 个字符 */
export const SQUAD_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SQUAD_CODE_LENGTH = 6;
/** 拒绝采样上限：256 的最大 31 倍数以下的字节才取模，消除偏差 */
const UNBIASED_LIMIT = 256 - (256 % SQUAD_CODE_ALPHABET.length);

export interface LevelInfo {
  /** 当前等级：0 = 未成团，1..4 = Lv1..Lv4 */
  level: number;
  /** 下一级所需人数；已满级为 null */
  nextAt: number | null;
  /** 还差几人升级；已满级为 0 */
  remaining: number;
}

export function levelInfo(members: number): LevelInfo {
  const count = Math.max(0, Math.floor(members));
  let level = 0;
  for (let i = 0; i < SQUAD_LEVELS.length; i++) {
    if (count >= SQUAD_LEVELS[i]) level = i + 1;
  }
  if (level >= SQUAD_LEVELS.length) return { level, nextAt: null, remaining: 0 };
  const nextAt = SQUAD_LEVELS[level];
  return { level, nextAt, remaining: nextAt - count };
}

/** 竞争排名：1 + 人数严格多于自己的战队数（同分同名次）。 */
export function competitionRank(members: number, allMembers: number[]): number {
  let ahead = 0;
  for (const m of allMembers) if (m > members) ahead++;
  return ahead + 1;
}

/**
 * 用随机字节生成战队码（拒绝采样，无偏差）。字节不够凑满 6 位时返回 null。
 * 调用方负责提供密码学随机字节。
 */
export function squadCodeFromBytes(bytes: Uint8Array): string | null {
  let out = '';
  for (const b of bytes) {
    if (b >= UNBIASED_LIMIT) continue;
    out += SQUAD_CODE_ALPHABET[b % SQUAD_CODE_ALPHABET.length];
    if (out.length === SQUAD_CODE_LENGTH) return out;
  }
  return null;
}

/** 生成一个随机战队码（crypto.getRandomValues）。 */
export function newSquadCode(): string {
  for (;;) {
    const bytes = new Uint8Array(SQUAD_CODE_LENGTH * 2);
    crypto.getRandomValues(bytes);
    const code = squadCodeFromBytes(bytes);
    if (code) return code;
  }
}

/** 地址归一键：友好地址 / raw 地址统一成 raw，与 social/snapshot.ts 的 addressKey 同口径。 */
function addressKeyOf(address: string): string {
  return parseTonAddress(address)?.raw ?? address;
}

/**
 * 本城上车人数按战队计数（纯函数）。同一地址只计一次；地址不属于任何战队的不计。
 * 与 social/snapshot.ts 的 stakersBySquad 同口径（地址归一后按 users.squad_code 归队）。
 */
export function countStakersBySquad(
  stakerAddresses: readonly string[],
  users: ReadonlyArray<{ wallet: string; squadCode: string }>,
): Map<string, number> {
  const squadByKey = new Map<string, string>();
  for (const user of users) squadByKey.set(addressKeyOf(user.wallet), user.squadCode);
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const address of stakerAddresses) {
    const key = addressKeyOf(address);
    if (seen.has(key)) continue;
    seen.add(key);
    const code = squadByKey.get(key);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}
