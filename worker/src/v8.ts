/**
 * V8 权重制 / 奖励三态 / 邀请 / 解锁 / K 线滚动哈希 —— 纯计算 + D1 读写的领域模块。
 * 口径与合约 V8 一一对应（contracts/RoundController.tolk, docs/17）：
 *   ownWeight = amount × (10000 + streak×1000)/10000
 *   bonus(邀请人) = min(20% × 被邀请人本轮质押, 邀请人本轮自己的质押额)   // 入账顺序累计，不追溯
 *   reward = floor(rewardBudget × (ownWeight + bonus) / totalWeight)
 */
import type { Env } from './env';
import type { ReferralInfo, RoundReward, RoundState, RewardStateCode, UnlockInfo } from '@shared/types';
import {
  CANDLE_COUNT,
  MAX_TOTAL_STAKE_RAW,
  ROLLOVER_CAP_PER_ADDRESS_RAW,
  UNLOCK_DURATION_SECONDS,
  ownWeightFor,
  weightBpsForStreak,
  type Params,
} from './protocol';
import * as store from './store';
import type { CandleRow, RoundRow, RoundRewardRow, StakeRow } from './store';
import { mulDivFloor, toBigInt } from './util';

export interface AddressWeight {
  amount: bigint;
  ownWeight: bigint;
  bonus: bigint;
  weight: bigint;
}

export interface RoundWeights {
  totalWeight: bigint;
  byAddress: Map<string, AddressWeight>;
}

/**
 * 计算某轮所有地址的权重（按入账顺序累计邀请加成，和合约一致）。
 * stake.weight_raw 为入账时算好的 own weight；缺省时按 streak 重算。
 */
export function computeRoundWeights(params: Params, stakes: StakeRow[]): RoundWeights {
  const ordered = [...stakes].sort((a, b) => a.accepted_at - b.accepted_at || a.id - b.id);
  const byAddress = new Map<string, AddressWeight>();
  const get = (address: string): AddressWeight => {
    let entry = byAddress.get(address);
    if (!entry) {
      entry = { amount: 0n, ownWeight: 0n, bonus: 0n, weight: 0n };
      byAddress.set(address, entry);
    }
    return entry;
  };
  const bonusSoFar = new Map<string, bigint>();
  let totalWeight = 0n;

  for (const stake of ordered) {
    const amount = toBigInt(stake.amount_raw);
    const streak = typeof stake.streak === 'number' && stake.streak > 0 ? stake.streak : 1;
    const ownWeight = toBigInt(stake.weight_raw) || ownWeightFor(amount, streak);
    const entry = get(stake.address);
    entry.amount += amount;
    entry.ownWeight += ownWeight;
    entry.weight += ownWeight;
    totalWeight += ownWeight;

    const referrer = stake.referred_by ?? null;
    if (!referrer) continue;
    if (amount < params.minStakeRaw) continue;
    const refEntry = get(referrer);
    const already = bonusSoFar.get(referrer) ?? 0n;
    // 合约口径：room = 邀请人「当前已入账」的质押额 - 已发放加成；不追溯后续加仓
    const room = refEntry.amount > already ? refEntry.amount - already : 0n;
    const rawAdd = (amount * BigInt(params.referralBonusBps)) / 10_000n;
    const add = rawAdd < room ? rawAdd : room;
    if (add > 0n) {
      refEntry.bonus += add;
      refEntry.weight += add;
      totalWeight += add;
      bonusSoFar.set(referrer, already + add);
    }
  }

  return { totalWeight, byAddress };
}

/** 结算成功时生成每地址奖励（保留已有的三态/已领金额，便于幂等重放）。 */
export function buildRewardRows(
  params: Params,
  round: RoundRow,
  weights: RoundWeights,
  now: number,
  existing: RoundRewardRow[] = [],
): RoundRewardRow[] {
  const budget = toBigInt(round.reward_budget_raw);
  const existingByAddress = new Map(existing.map((row) => [row.address, row]));
  const rows: RoundRewardRow[] = [];
  for (const [address, entry] of weights.byAddress) {
    const reward = weights.totalWeight > 0n ? (budget * entry.weight) / weights.totalWeight : 0n;
    const prev = existingByAddress.get(address);
    rows.push({
      round_id: round.round_id,
      address,
      weight_raw: entry.weight.toString(),
      reward_raw: reward.toString(),
      state: prev?.state ?? 0,
      paid_raw: prev?.paid_raw ?? '0',
      locked_raw: prev?.locked_raw ?? '0',
      rolled_raw: prev?.rolled_raw ?? '0',
      created_at: prev?.created_at ?? now,
      updated_at: now,
    });
  }
  return rows;
}

/**
 * 幂等同步每轮总权重 / 已成功轮次的奖励账本 / K 线滚动哈希。
 * 返回是否有写库变更。
 */
export async function syncV8Rounds(
  env: Env,
  params: Params,
  rounds: RoundRow[],
  allStakes: StakeRow[],
  candlesByRound: Map<number, CandleRow[]>,
  now: number,
): Promise<boolean> {
  let changed = false;
  const rewardRows = await store.listAllRoundRewards(env);
  const rewardsByRound = new Map<number, RoundRewardRow[]>();
  for (const row of rewardRows) {
    const list = rewardsByRound.get(row.round_id);
    if (list) list.push(row);
    else rewardsByRound.set(row.round_id, [row]);
  }

  for (const round of rounds) {
    if (round.state === 'UNOPENED') continue;
    const stakes = allStakes.filter((stake) => stake.round_id === round.round_id);
    if (!stakes.length) continue;

    // B3：chain 模式的 total_weight_raw / K 线哈希 / round_rewards 全部由索引器按链上 get_round 写入，
    // 本地不得用 stakes 重算覆盖（与 H-7 candle_hash 同类问题）。
    // 单一写者约定：chain 模式这些字段的唯一写者是 worker/src/indexer（indexer-dev）；
    // 本函数未来若要在 chain 下恢复部分逻辑，必须先与索引器侧确认，不能再出现双写。
    if (params.dataSource === 'chain') continue;

    const weights = computeRoundWeights(params, stakes);
    const totalWeightRaw = weights.totalWeight.toString();
    // 注意：必须在修改 round.total_weight_raw 之前记录差异，否则下面的落库条件永远为 false
    const weightChanged = round.total_weight_raw !== totalWeightRaw;
    if (weightChanged) {
      round.total_weight_raw = totalWeightRaw;
      changed = true;
    }

    if (round.state === 'SUCCEEDED') {
      const existing = rewardsByRound.get(round.round_id) ?? [];
      const rows = buildRewardRows(params, round, weights, now, existing);
      const missing = rows.length > 0 && existing.length === 0;
      const drift =
        !missing &&
        rows.some((row) => {
          const prev = existing.find((item) => item.address === row.address);
          return !prev || prev.reward_raw !== row.reward_raw || prev.weight_raw !== row.weight_raw;
        });
      if (missing || drift) {
        await store.replaceRoundRewards(env, round.round_id, rows);
        rewardsByRound.set(round.round_id, rows);
        changed = true;
      }
    }

    // H-7：demo 模式仍由本地重算 V8 字符串滚动哈希（sha256(prev|index|twap|digest)）并落库；
    // chain 模式已在函数开头 return，保留链上 TON cell 滚动哈希。
    const candles = candlesByRound.get(round.round_id) ?? [];
    const hash = candles.length > 0 ? await computeCandleHash(candles) : null;
    let hashChanged = false;
    if (round.candle_hash !== hash) {
      round.candle_hash = hash;
      hashChanged = true;
      changed = true;
    }

    if (weightChanged || hashChanged) {
      await store.updateRoundWeightHash(env, round.round_id, totalWeightRaw, round.candle_hash ?? null, now);
    }
  }
  return changed;
}

/* ------------------------------------------------------------------ *
 * K 线滚动哈希（与 seed 生成器同公式）：
 *   hash_0 = 0x00..0
 *   hash_i = sha256( hex(hash_{i-1}) | candleIndex | twapUsdE8 | dataDigest )
 * 返回 "0x" + 64 hex。
 * ------------------------------------------------------------------ */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export async function computeCandleHash(candles: CandleRow[]): Promise<string> {
  let hash = '0x' + '0'.repeat(64);
  const ordered = [...candles].sort((a, b) => a.candle_index - b.candle_index);
  for (const candle of ordered) {
    hash = '0x' + (await sha256Hex(hash + '|' + candle.candle_index + '|' + candle.twap_price_usd_e8 + '|' + candle.data_digest));
  }
  return hash;
}

/* ------------------------------------------------------------------ *
 * 用户维度：streak / 权重倍数
 * ------------------------------------------------------------------ */

export interface StakeStreakSummary {
  lastRound: number;
  count: number;
  weightMultiplierBps: number;
}

export function streakSummaryFromStakes(stakes: StakeRow[], fallbackStreak = 1): StakeStreakSummary {
  if (!stakes.length) {
    return { lastRound: 0, count: fallbackStreak, weightMultiplierBps: weightBpsForStreak(fallbackStreak) };
  }
  const ordered = [...stakes].sort((a, b) => a.round_id - b.round_id || a.id - b.id);
  const last = ordered[ordered.length - 1];
  const lastRound = last.round_id;
  let count = 1;
  for (const stake of ordered) {
    if (stake.round_id === lastRound && typeof stake.streak === 'number' && stake.streak > count) count = stake.streak;
  }
  return { lastRound, count, weightMultiplierBps: weightBpsForStreak(count) };
}

/* ------------------------------------------------------------------ *
 * 奖励三态视图
 * ------------------------------------------------------------------ */

export interface RoundRewardsView {
  rewards: RoundReward[];
}

export function buildRoundRewardsView(
  params: Params,
  rounds: RoundRow[],
  roundsById: Map<number, RoundRow>,
  rewards: RoundRewardRow[],
  stakes: StakeRow[],
  unlockStarted: boolean,
): RoundReward[] {
  const rows: RoundReward[] = [];
  for (const reward of rewards) {
    const round = roundsById.get(reward.round_id);
    if (!round) continue;
    const amount = toBigInt(reward.reward_raw);
    const state = (reward.state === 1 ? 1 : reward.state === 2 ? 2 : 0) as RewardStateCode;
    let rollable = 0n;
    if (state === 0 && round.state === 'SUCCEEDED' && reward.round_id < params.roundCount && !unlockStarted) {
      const next = roundsById.get(reward.round_id + 1);
      if (next && next.state === 'STAKING_OPEN') {
        const nextStake = stakes
          .filter((stake) => stake.round_id === next.round_id && stake.address === reward.address)
          .reduce((sum, stake) => sum + toBigInt(stake.amount_raw), 0n);
        const roomAddr = ROLLOVER_CAP_PER_ADDRESS_RAW > nextStake ? ROLLOVER_CAP_PER_ADDRESS_RAW - nextStake : 0n;
        const nextTotal = toBigInt(next.total_accepted_stake_raw);
        const roomTotal = MAX_TOTAL_STAKE_RAW > nextTotal ? MAX_TOTAL_STAKE_RAW - nextTotal : 0n;
        rollable = amount;
        if (rollable > roomAddr) rollable = roomAddr;
        if (rollable > roomTotal) rollable = roomTotal;
      }
    }
    rows.push({
      roundId: reward.round_id,
      state,
      amountRaw: amount.toString(),
      rollableRaw: rollable.toString(),
      earlyAmountRaw: (amount / 2n).toString(),
      paidRaw: reward.paid_raw ?? '0',
      lockedRaw: reward.locked_raw ?? '0',
      rolledRaw: reward.rolled_raw ?? '0',
    });
  }
  rows.sort((a, b) => a.roundId - b.roundId);
  return rows;
}

/* ------------------------------------------------------------------ *
 * 解锁池（R10 终态后 12 × 30 天线性；合约 get_unlock_info 同口径）
 * ------------------------------------------------------------------ */

function vestingProgress(unlockStart: number, now: number, durationSeconds: number): { progressBps: number; vestedRatioBps: number } {
  if (unlockStart <= 0 || now < unlockStart) return { progressBps: 0, vestedRatioBps: 0 };
  const elapsed = Math.min(now - unlockStart, durationSeconds * 1000);
  const ratio = Math.floor((elapsed / (durationSeconds * 1000)) * 10000);
  return { progressBps: ratio, vestedRatioBps: ratio };
}

export function lockedRewardFor(
  rewards: RoundRewardRow[],
  roundsById: Map<number, RoundRow>,
  address?: string,
): bigint {
  let locked = 0n;
  for (const reward of rewards) {
    if (address && reward.address !== address) continue;
    locked += toBigInt(reward.locked_raw);
    const round = roundsById.get(reward.round_id);
    // 合约 get_unlock_info：SUCCEEDED 且仍未领取（PENDING）的奖励在 R10 后自动进入锁定池
    if (round && round.state === 'SUCCEEDED' && reward.state === 0) locked += toBigInt(reward.reward_raw);
  }
  return locked;
}

/**
 * V8 ClaimUnlocked 线性解锁视图。
 *
 * 注意（链上验收口径，已写入审计简报）：`UNLOCK_DURATION_SECONDS = 31,104,000`（12×30 天）是
 * 编译期常量，快测无法压缩。主网/测试网 R10 后立刻 ClaimUnlocked 会正确返回 NothingUnlocked
 * （t≈0 时 nothing vested），这是预期行为、不是 bug。链上只能验证：
 *   - get_unlock_info().unlockStart > 0（R10 终态后已设置起点）；
 *   - totalLockedRaw 与未领奖励一致；
 *   - ClaimUnlocked 在未 vest 时被正确拒绝。
 * vesting 数学由 contracts/tests/rewards-v8.test.tolk 的时间跳跃单测覆盖。
 */
export async function buildUnlockInfo(
  env: Env,
  params: Params,
  rewards: RoundRewardRow[],
  roundsById: Map<number, RoundRow>,
  address: string,
  now: number,
): Promise<UnlockInfo> {
  const pool = await store.getUnlockPool(env);
  const claims = await store.listClaimsForAddress(env, address);
  let claimed = 0n;
  for (const claim of claims) if (claim.kind === 'unlock') claimed += toBigInt(claim.amount_raw);
  const locked = lockedRewardFor(rewards, roundsById, address);
  const { progressBps, vestedRatioBps } = vestingProgress(pool.start_at, now, params.unlockDurationSeconds);
  const vested = (locked * BigInt(vestedRatioBps)) / 10000n;
  const claimable = vested > claimed ? vested - claimed : 0n;
  return {
    active: pool.start_at > 0 && now >= pool.start_at,
    unlockStart: pool.start_at,
    endAt: pool.start_at > 0 ? pool.start_at + params.unlockDurationSeconds * 1000 : 0,
    durationSeconds: params.unlockDurationSeconds,
    totalLockedRaw: locked.toString(),
    claimedRaw: claimed.toString(),
    claimableRaw: claimable.toString(),
    progressBps,
  };
}

export async function buildUnlockStats(
  env: Env,
  params: Params,
  rewards: RoundRewardRow[],
  roundsById: Map<number, RoundRow>,
  now: number,
): Promise<{ lockedRewardRaw: string; unlock: UnlockInfo }> {
  const pool = await store.getUnlockPool(env);
  const claims = await store.listClaimsForAddress(env, '');
  void claims;
  const claimedRows = await env.DB.prepare("SELECT amount_raw FROM claims WHERE kind = 'unlock'").all<{ amount_raw: string }>();
  let claimed = 0n;
  for (const row of claimedRows.results ?? []) claimed += toBigInt(row.amount_raw);
  const locked = lockedRewardFor(rewards, roundsById);
  const { progressBps, vestedRatioBps } = vestingProgress(pool.start_at, now, params.unlockDurationSeconds);
  const vested = (locked * BigInt(vestedRatioBps)) / 10000n;
  return {
    lockedRewardRaw: locked.toString(),
    unlock: {
      active: pool.start_at > 0 && now >= pool.start_at,
      unlockStart: pool.start_at,
      endAt: pool.start_at > 0 ? pool.start_at + params.unlockDurationSeconds * 1000 : 0,
      durationSeconds: params.unlockDurationSeconds,
      totalLockedRaw: locked.toString(),
      claimedRaw: claimed.toString(),
      claimableRaw: vested > claimed ? (vested - claimed).toString() : '0',
      progressBps,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 邀请
 * ------------------------------------------------------------------ */

/** 当前轮（有质押的最高轮）的邀请数据。 */
export function buildReferralInfo(
  params: Params,
  address: string,
  referrals: { address: string; referrer: string }[],
  stakes: StakeRow[],
  rounds: RoundRow[],
): ReferralInfo {
  const referrer = referrals.find((row) => row.address === address)?.referrer ?? null;
  const invitees = new Set(referrals.filter((row) => row.referrer === address).map((row) => row.address));
  const currentRoundId = rounds
    .filter((round) => round.state !== 'UNOPENED')
    .reduce((max, round) => Math.max(max, round.round_id), 0);
  const currentRound = rounds.find((round) => round.round_id === currentRoundId) ?? null;

  let invitedStake = 0n;
  let bonusThisRound = 0n;
  if (currentRound) {
    const roundStakes = stakes.filter((stake) => stake.round_id === currentRound.round_id);
    const weights = computeRoundWeights(params, roundStakes);
    bonusThisRound = weights.byAddress.get(address)?.bonus ?? 0n;
    for (const stake of roundStakes) {
      if (stake.referred_by === address && toBigInt(stake.amount_raw) >= params.minStakeRaw) {
        invitedStake += toBigInt(stake.amount_raw);
      }
    }
  }

  // 历史累计邀请加成：逐轮按同一算法累计
  let bonusTotal = 0n;
  for (const round of rounds) {
    if (round.state === 'UNOPENED') continue;
    const roundStakes = stakes.filter((stake) => stake.round_id === round.round_id);
    if (!roundStakes.length) continue;
    const weights = computeRoundWeights(params, roundStakes);
    bonusTotal += weights.byAddress.get(address)?.bonus ?? 0n;
  }

  return {
    referrer,
    invitedCount: invitees.size,
    invitedStakeRaw: invitedStake.toString(),
    bonusThisRoundRaw: bonusThisRound.toString(),
    bonusTotalRaw: bonusTotal.toString(),
  };
}

/** GET /api/referral/:address 明细：我邀请的人 × 每轮产生的加成。 */
export function buildReferralInvitees(
  params: Params,
  address: string,
  referrals: { address: string; referrer: string }[],
  stakes: StakeRow[],
  rounds: RoundRow[],
): { address: string; roundId: number; stakeRaw: string; bonusRaw: string }[] {
  const invitees = referrals.filter((row) => row.referrer === address).map((row) => row.address);
  if (!invitees.length) return [];
  const rows: { address: string; roundId: number; stakeRaw: string; bonusRaw: string }[] = [];
  for (const round of rounds) {
    if (round.state === 'UNOPENED') continue;
    const roundStakes = stakes.filter((stake) => stake.round_id === round.round_id);
    if (!roundStakes.length) continue;
    const ordered = [...roundStakes].sort((a, b) => a.accepted_at - b.accepted_at || a.id - b.id);
    const bonusSoFar = new Map<string, bigint>();
    const perInvitee = new Map<string, bigint>();
    const amounts = new Map<string, bigint>();
    for (const stake of ordered) {
      const amount = toBigInt(stake.amount_raw);
      const current = amounts.get(stake.address) ?? 0n;
      amounts.set(stake.address, current + amount);
      const referrer = stake.referred_by;
      if (!referrer || amount < params.minStakeRaw) continue;
      const already = bonusSoFar.get(referrer) ?? 0n;
      const room = (amounts.get(referrer) ?? 0n) > already ? (amounts.get(referrer) ?? 0n) - already : 0n;
      const rawAdd = (amount * BigInt(params.referralBonusBps)) / 10_000n;
      const add = rawAdd < room ? rawAdd : room;
      if (add <= 0n) continue;
      bonusSoFar.set(referrer, already + add);
      if (referrer === address && invitees.includes(stake.address)) {
        perInvitee.set(stake.address, (perInvitee.get(stake.address) ?? 0n) + add);
      }
    }
    for (const [invitee, bonus] of perInvitee) {
      rows.push({
        address: invitee,
        roundId: round.round_id,
        stakeRaw: roundStakes
          .filter((stake) => stake.address === invitee)
          .reduce((sum, stake) => sum + toBigInt(stake.amount_raw), 0n)
          .toString(),
        bonusRaw: bonus.toString(),
      });
    }
  }
  return rows;
}

export { CANDLE_COUNT, UNLOCK_DURATION_SECONDS, mulDivFloor, toBigInt };
