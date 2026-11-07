/**
 * v11 每城拆分的纯函数（无 I/O）：20% 立即、80% 压城、解锁与可领。与合约 rewardSplit / unlockedLocked 同口径
 * （contracts/contracts/RoundController.tolk），供 views.ts 的 /api/me 与 index.ts 的演示领取共用。
 */
import type { RoundPosition, RoundState } from '@shared/types';

/** 破城奖励的立即可领比例（20%）。 */
export const IMMEDIATE_REWARD_BPS = 2000n;
export const BPS = 10000n;
/** 压城兜底线性解锁窗口（第 10 城结束后，秒）。主网 30 天；测试网快速档以 metrics chain:fallback_unlock_seconds 覆盖。 */
export const DEFAULT_FALLBACK_UNLOCK_SECONDS = 30 * 24 * 3600;

/**
 * 兜底解锁窗口：读取 metrics `chain:fallback_unlock_seconds`（索引器从 get_protocol_state 第 7 槽写入）。
 * 缺失、非数字或非正数时回退默认值（主网 30 天），不让 /api/me 因旧数据报错。
 */
export function fallbackUnlockSecondsOf(raw: string | undefined): number {
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_FALLBACK_UNLOCK_SECONDS;
}

/** 压城解锁所需的链上锚点（unix 秒）。 */
export interface UnlockContext {
  lastSuccessRound: number;
  endAt: number;
  nowSec: number;
  fallbackSec: number;
}

/** 压城已解锁累计（与合约 unlockedLocked 同口径）：后续任一城破城即全部解锁；否则第 10 城后线性解锁。 */
export function unlockedLockedRaw(locked: bigint, roundId: number, ctx: UnlockContext): bigint {
  if (ctx.lastSuccessRound > roundId) return locked;
  if (ctx.endAt === 0 || ctx.nowSec <= ctx.endAt) return 0n;
  const elapsed = ctx.nowSec - ctx.endAt;
  if (ctx.fallbackSec <= 0 || elapsed >= ctx.fallbackSec) return locked;
  return (locked * BigInt(elapsed)) / BigInt(ctx.fallbackSec);
}

/**
 * 单城拆分（docs/35 §3.4）。奖励全额 = 索引器 round_rewards（链上 floor(budget × weight / totalWeight)）；
 * 首次领取同时付本金与 20%，之后只付压城解锁增量，因此 压城已领 = 领取奖励合计 − 已付的 20%。
 */
export function roundPositionOf(input: {
  roundId: number;
  state: RoundState;
  principalRaw: bigint;
  principalClaimed: boolean;
  rewardRaw: bigint;
  rewardClaimedRaw: bigint;
  ctx: UnlockContext;
}): RoundPosition {
  const { roundId, state, principalRaw, principalClaimed, ctx } = input;
  const rewarded = state === 'SUCCEEDED';
  const reward = rewarded ? input.rewardRaw : 0n;
  const immediate = (reward * IMMEDIATE_REWARD_BPS) / BPS;
  const locked = reward - immediate;
  const unlocked = rewarded ? unlockedLockedRaw(locked, roundId, ctx) : 0n;
  let lockedClaimed = input.rewardClaimedRaw - (principalClaimed ? immediate : 0n);
  if (lockedClaimed < 0n) lockedClaimed = 0n;
  if (lockedClaimed > locked) lockedClaimed = locked;
  const principalDue = !principalClaimed && (rewarded || state === 'TECHNICAL_ABORTED') ? principalRaw : 0n;
  const immediateDue = rewarded && !principalClaimed ? immediate : 0n;
  const lockedDue = rewarded && unlocked > lockedClaimed ? unlocked - lockedClaimed : 0n;
  const rewardDue = immediateDue + lockedDue;
  return {
    roundId,
    state,
    principalRaw: principalRaw.toString(),
    principalClaimed,
    immediateRaw: immediate.toString(),
    lockedRaw: locked.toString(),
    unlockedRaw: unlocked.toString(),
    lockedClaimedRaw: lockedClaimed.toString(),
    claimableRaw: (principalDue + rewardDue).toString(),
    claimablePrincipalRaw: principalDue.toString(),
    claimableRewardRaw: rewardDue.toString(),
  };
}
