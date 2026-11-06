/**
 * 战力（docs/35 §1 D-44、§4.1）：战力 = Σ 本金 × 时机系数。
 * 攻城期 36h 分三档：前 12h ×1.5、中 12h ×1.2、后 12h ×1.0。
 * 纯函数，无 I/O。链上索引器已落库 weightRaw（= 金额 × 时机系数，docs/35 D-44）：有 weightRaw 时直接求和，
 * 否则按报名时刻回退到时机表（demo 数据沿用此路径）。
 */

const HOUR_MS = 3_600_000;
const EARLY_END_MS = 12 * HOUR_MS;
const MID_END_MS = 24 * HOUR_MS;

/** 时机系数（bps，10000 = ×1.0） */
export const TIMING_BPS_EARLY = 15_000n;
export const TIMING_BPS_MID = 12_000n;
export const TIMING_BPS_LATE = 10_000n;

export interface PowerDeposit {
  /** 本金（raw） */
  amountRaw: bigint;
  /** 报名时刻（毫秒） */
  acceptedAt: number;
  /** 链上权重（raw，已含时机系数）；缺省或 null 时按时机表计算 */
  weightRaw?: bigint | null;
}

/**
 * 单笔存款的时机系数（bps）。
 * stakeOpenAt 为空（链上未给出开窗时间）时统一 ×1.0，避免伪造加成。
 * 开窗前的记录（理论上不应出现）归入前 12h 档。
 */
export function timingBps(acceptedAt: number, stakeOpenAt: number | null): bigint {
  if (stakeOpenAt === null) return TIMING_BPS_LATE;
  const elapsed = acceptedAt - stakeOpenAt;
  if (elapsed < EARLY_END_MS) return TIMING_BPS_EARLY;
  if (elapsed < MID_END_MS) return TIMING_BPS_MID;
  return TIMING_BPS_LATE;
}

/** 某钱包在某一轮的战力（raw）。每笔按 floor(amount × bps / 10000) 计，再求和。 */
export function powerOf(deposits: readonly PowerDeposit[], stakeOpenAt: number | null): bigint {
  let total = 0n;
  for (const deposit of deposits) {
    if (deposit.amountRaw <= 0n) continue;
    if (deposit.weightRaw !== undefined && deposit.weightRaw !== null) {
      if (deposit.weightRaw > 0n) total += deposit.weightRaw;
      continue;
    }
    total += (deposit.amountRaw * timingBps(deposit.acceptedAt, stakeOpenAt)) / 10_000n;
  }
  return total;
}

/**
 * 竞争排名（同分同名次）：返回 wallet 的 1 基名次；战力为 0 或不在表中返回 null。
 */
export function rankOf(powers: ReadonlyMap<string, bigint>, wallet: string): number | null {
  const own = powers.get(wallet);
  if (own === undefined || own <= 0n) return null;
  let higher = 0;
  for (const value of powers.values()) if (value > own) higher++;
  return higher + 1;
}

/** 阵亡勋章 = 本人报名过的失败轮数（按轮去重）。 */
export function medalsOf(stakedRounds: ReadonlySet<number>, failedRounds: ReadonlySet<number>): number {
  let count = 0;
  for (const roundId of stakedRounds) if (failedRounds.has(roundId)) count++;
  return count;
}

/** 连战：从 latestRoundId 往回数连续报名的轮数（输了也算）。 */
export function streakOf(stakedRounds: ReadonlySet<number>, latestRoundId: number): number {
  let streak = 0;
  for (let roundId = latestRoundId; roundId >= 1 && stakedRounds.has(roundId); roundId--) streak++;
  return streak;
}
