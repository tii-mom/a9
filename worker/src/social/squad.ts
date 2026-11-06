/**
 * 战队规则（docs/35 §4.3）。纯函数，无 I/O。
 * 等级按当前轮报名的不同人数：5 / 20 / 100 / 500 → Lv1..Lv4，全队军饷 +3% / +6% / +10% / +15%。
 */
import { randomCode, SQUAD_CODE_LENGTH } from './common';

export const SQUAD_LEVEL_THRESHOLDS = [5, 20, 100, 500] as const;
/** 等级 → 军饷加成（bps）；索引即等级，0 = 未成团 */
export const SQUAD_BONUS_BPS = [0, 300, 600, 1_000, 1_500] as const;

export interface SquadLevel {
  level: number;
  bonusBps: number;
}

/**
 * 战队进度（后端唯一来源，前端与机器人直接展示，不再自行重算）。
 * stakersThisRound = 本城上车人数（distinct 报名地址）；等级与「还差」都按它算。
 */
export interface SquadProgress {
  stakersThisRound: number;
  level: number;
  /** 下一等级（1..4）；已满级为 null */
  nextLevel: number | null;
  /** 距下一等级还差几人 = 下一档门槛 − stakersThisRound；已满级为 null */
  remainingToNext: number | null;
}

export function squadLevel(distinctStakers: number): SquadLevel {
  const count = Number.isFinite(distinctStakers) ? Math.max(0, Math.floor(distinctStakers)) : 0;
  let level = 0;
  for (let i = 0; i < SQUAD_LEVEL_THRESHOLDS.length; i++) {
    if (count >= SQUAD_LEVEL_THRESHOLDS[i]) level = i + 1;
  }
  return { level, bonusBps: SQUAD_BONUS_BPS[level] };
}

export function squadProgress(distinctStakers: number): SquadProgress {
  const count = Number.isFinite(distinctStakers) ? Math.max(0, Math.floor(distinctStakers)) : 0;
  const { level } = squadLevel(count);
  if (level >= SQUAD_LEVEL_THRESHOLDS.length) {
    return { stakersThisRound: count, level, nextLevel: null, remainingToNext: null };
  }
  return {
    stakersThisRound: count,
    level,
    nextLevel: level + 1,
    remainingToNext: SQUAD_LEVEL_THRESHOLDS[level] - count,
  };
}

export function newSquadCode(): string {
  return randomCode(SQUAD_CODE_LENGTH);
}

export interface SquadSwitchInput {
  /** 用户当前所在战队（null = 未入队） */
  currentSquadCode: string | null;
  /** 用户是否为当前战队的团长（团长不能离队） */
  isLeaderOfCurrent: boolean;
  /** 上一次换队所在赛季（null = 从未换过） */
  squadChangedSeason: number | null;
  /** 当前赛季 */
  season: number;
  targetCode: string;
}

export type SquadSwitchVerdict =
  | { ok: true; noop: boolean; markSeason: boolean }
  | { ok: false; reason: string };

/**
 * 入队 / 换队规则：
 *  - 一人一队；首次入队不计入换队次数；
 *  - 从已有战队换到另一队视为一次换队，每赛季最多一次；
 *  - 团长不能离开自己的战队。
 */
export function squadSwitchVerdict(input: SquadSwitchInput): SquadSwitchVerdict {
  if (input.currentSquadCode === input.targetCode) return { ok: true, noop: true, markSeason: false };
  if (input.currentSquadCode === null) return { ok: true, noop: false, markSeason: false };
  if (input.isLeaderOfCurrent) return { ok: false, reason: '团长不能离开自己的战队' };
  if (input.squadChangedSeason === input.season) return { ok: false, reason: '本赛季已换过战队' };
  return { ok: true, noop: false, markSeason: true };
}
