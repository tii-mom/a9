/**
 * 演示数据集重置（DEMO_AUTOPLAY 循环展示用）。
 *
 * 十轮全部进入终态后，Worker 用同一套确定性算法重建初始演示数据：
 *   R1 SUCCEEDED(20/24)、R2 FAILED_PERMANENT(12/24，三笔销毁)、
 *   R3 OBSERVING(12/24 已收盘、8 根达标，第 13 根为 live)、R4..R10 UNOPENED。
 *
 * 与 worker/scripts/generate-seed.mjs 保持同一份「演示数据集定义」：
 *   - 12 个确定性 UQ 地址（SHA-256("fuse-protocol-demo-wallet-{i}") → base64url）
 *   - 目标价档位按 D-28（tier = 1 + 已成功轮数；失败不升档）
 *   - V8 权重制（docs/17）：A0 为 10 轮老兵（R1/R2/R3 streak 8/9/10 → 2.00×）；
 *     2 组邀请（A5→A0、A6→A1）；A1 的 R1 奖励已滚存进 R2；A2 的 R1 奖励已早领 50%；
 *     解锁池预置 3/12（90 天）线性解锁样例；K 线滚动哈希落库。
 * 差异仅在于时间锚点（重置时刻 vs seed 执行时刻）与成交/盘口由 demo source 现场生成。
 */
import type { Env } from './env';
import { CANDLE_COUNT, ROUND_COUNT, TOKEN_SCALE, ownWeightFor, type Params } from './protocol';
import * as store from './store';
import type { BookRow, CandleRow, RoundRewardRow, RoundRow, StakeRow } from './store';
import { getSource } from './sources';
import * as v8 from './v8';
import { toBigInt } from './util';

const DAY = 86_400_000;
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** 与 generate-seed.mjs 完全一致的地址权重（bps，合计 10000）。 */
const WEIGHT_BPS = [1680, 1420, 1260, 1040, 920, 810, 680, 570, 490, 410, 350, 370];
const STAKE_TOTALS_TOKENS: Record<number, bigint> = {
  1: 214_800_000n,
  2: 241_500_000n,
  3: 386_200_000n,
};
/** R3 初始已收盘 12 根（24 根过半），其中 8 根达标（低于 16 阈值，仍在观察中）。 */
const R3_SEEDED_CANDLES = 12;
/** 演示夹具：A0 为「10 轮老兵」（streak 8/9/10）；其余地址从 R1 起连续参与（1/2/3）。 */
const V8_STREAKS: Record<number, Record<number, number>> = { 0: { 1: 8, 2: 9, 3: 10 } };
/** 演示夹具：两组邀请关系（被邀请人 index → 邀请人 index）。 */
const V8_REFERRALS: Record<number, number> = { 5: 0, 6: 1 };
/** 解锁池样例：seed 时刻已过 90 天（3/12 进度）。 */
const UNLOCK_SAMPLE_DAYS = 90;

function tierForRound(roundId: number): number {
  if (roundId <= 1) return 1;
  if (roundId === 2) return 2;
  if (roundId === 3) return 2;
  return 2 + (roundId - 3);
}

function streakForSeed(roundId: number, index: number): number {
  const fixed = V8_STREAKS[index];
  if (fixed && fixed[roundId]) return fixed[roundId];
  return roundId;
}

async function demoAddresses(count: number): Promise<string[]> {
  const encoder = new TextEncoder();
  const addresses: string[] = [];
  for (let index = 0; index < count; index++) {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode('fuse-protocol-demo-wallet-' + index)),
    );
    let address = 'UQ';
    for (let k = 0; k < 46; k++) address += B64URL[digest[k % digest.length] % 64];
    addresses.push(address);
  }
  return addresses;
}

function splitAmount(totalTokens: bigint): bigint[] {
  const amounts = WEIGHT_BPS.map((bps) => (totalTokens * BigInt(bps)) / 10000n);
  const sum = amounts.reduce((acc, value) => acc + value, 0n);
  amounts[0] += totalTokens - sum;
  return amounts;
}

interface StakeRecord {
  roundId: number;
  index: number;
  address: string;
  amountRaw: bigint;
  weightRaw: bigint;
  streak: number;
  referredBy: string | null;
  acceptedAt: number;
  isRoll?: boolean;
  rewardState: number;
  principalClaimed: number;
  rewardClaimed: number;
}

function toStakeRows(records: StakeRecord[]): StakeRow[] {
  return records.map((record, id) => ({
    id: id + 1,
    round_id: record.roundId,
    address: record.address,
    amount_raw: record.amountRaw.toString(),
    weight_raw: record.weightRaw.toString(),
    nonce: record.isRoll ? 'roll-r1-1' : 'seed-r' + record.roundId + '-' + record.index,
    risk_disclosure_version: 1,
    accept_full_principal_burn: 1,
    streak: record.streak,
    reward_state: record.rewardState,
    referred_by: record.referredBy,
    principal_claimed: record.principalClaimed,
    reward_claimed: record.rewardClaimed,
    accepted_at: record.acceptedAt,
  }));
}

function emptyRound(roundId: number, params: Params): RoundRow {
  const tier = tierForRound(roundId);
  return {
    round_id: roundId,
    state: 'UNOPENED',
    target_tier: tier,
    target_price_usd_e8: (params.p0UsdE8 * (1n << BigInt(tier))).toString(),
    reward_budget_raw: params.roundRewardRaw.toString(),
    stake_open_at: null,
    stake_close_at: null,
    observation_start: null,
    observation_end: null,
    candles_seen: 0,
    qualified_candles: 0,
    total_accepted_stake_raw: '0',
    total_weight_raw: '0',
    candle_hash: null,
    last_candle_twap_usd_e8: null,
    last_candle_at: null,
    target_twap24h_usd_e8: null,
    chain_status: null,
    staker_count: 0,
    result: null,
    burned_raw: null,
    updated_at: params.now,
  };
}

/**
 * 清空业务表并重建演示数据（保留 admin_events 审计日志与 config/metrics）。
 * 调用方负责并发租约（state.autoplay 的 demo_reset_at）。
 */
export async function resetDemoData(env: Env, params: Params, now: number): Promise<void> {
  const source = getSource('demo');
  const candleMs = params.candleMs;
  const addresses = await demoAddresses(12);

  const r1Close = now - 21 * DAY;
  const r2Close = now - 14 * DAY;
  const r3Start = now - R3_SEEDED_CANDLES * candleMs;
  const r3Close = r3Start;

  const rounds: RoundRow[] = [];
  for (let roundId = 1; roundId <= ROUND_COUNT; roundId++) {
    const row = emptyRound(roundId, params);
    if (roundId === 1) {
      row.state = 'SUCCEEDED';
      row.stake_open_at = r1Close - 3 * DAY;
      row.stake_close_at = r1Close;
      row.observation_start = r1Close;
      row.observation_end = r1Close + CANDLE_COUNT * candleMs;
      row.candles_seen = CANDLE_COUNT;
      row.qualified_candles = 20;
      row.result = 'SUCCESS';
      row.updated_at = r1Close + CANDLE_COUNT * candleMs;
    } else if (roundId === 2) {
      row.state = 'FAILED_PERMANENT';
      row.stake_open_at = r2Close - 3 * DAY;
      row.stake_close_at = r2Close;
      row.observation_start = r2Close;
      row.observation_end = r2Close + CANDLE_COUNT * candleMs;
      row.candles_seen = CANDLE_COUNT;
      row.qualified_candles = 12;
      row.result = 'FAILURE';
      row.updated_at = r2Close + CANDLE_COUNT * candleMs;
    } else if (roundId === 3) {
      row.state = 'OBSERVING';
      row.stake_open_at = r3Close - 3 * DAY;
      row.stake_close_at = r3Close;
      row.observation_start = r3Start;
      row.observation_end = r3Start + CANDLE_COUNT * candleMs;
      row.candles_seen = R3_SEEDED_CANDLES;
      row.qualified_candles = 8;
      row.updated_at = now;
    }
    rounds.push(row);
  }
  const roundsById = new Map(rounds.map((row) => [row.round_id, row]));

  // 质押记录（V8：streak / 邀请快照 / own weight）
  const records: StakeRecord[] = [];
  for (const roundId of [1, 2, 3]) {
    const amounts = splitAmount(STAKE_TOTALS_TOKENS[roundId]);
    const openAt = roundId === 1 ? r1Close - 3 * DAY : roundId === 2 ? r2Close - 3 * DAY : r3Close - 3 * DAY;
    addresses.forEach((address, index) => {
      const amountRaw = amounts[index] * TOKEN_SCALE;
      const streak = streakForSeed(roundId, index);
      records.push({
        roundId,
        index,
        address,
        amountRaw,
        weightRaw: ownWeightFor(amountRaw, streak),
        streak,
        referredBy: V8_REFERRALS[index] !== undefined ? addresses[V8_REFERRALS[index]] : null,
        acceptedAt: openAt + index * 3600_000 + ((index * 7919) % 3_600_000),
        rewardState: 0,
        principalClaimed: 0,
        rewardClaimed: 0,
      });
    });
  }

  // R1 权重与奖励（邀请加成按入账顺序累计，与合约 / seed 生成器同口径）
  const r1Records = records.filter((record) => record.roundId === 1);
  const r1Weights = v8.computeRoundWeights(params, toStakeRows(r1Records));
  const rewardByAddress = new Map<string, bigint>();
  for (const [address, entry] of r1Weights.byAddress) {
    rewardByAddress.set(address, (params.roundRewardRaw * entry.weight) / r1Weights.totalWeight);
  }

  // 夹具 1：A1 的 R1 奖励滚存进 R2（单地址上限 2000 万，超出部分进解锁池）
  const rollAddress = addresses[1];
  const rollReward = rewardByAddress.get(rollAddress) ?? 0n;
  const rollAmount = rollReward > params.rolloverCapPerAddressRaw ? params.rolloverCapPerAddressRaw : rollReward;
  const rollLocked = rollReward - rollAmount;
  if (rollAmount > 0n) {
    const rollStreak = streakForSeed(2, 1);
    records.push({
      roundId: 2,
      index: 1,
      address: rollAddress,
      amountRaw: rollAmount,
      weightRaw: ownWeightFor(rollAmount, rollStreak),
      streak: rollStreak,
      referredBy: null,
      acceptedAt: r2Close - 3 * DAY + 1,
      isRoll: true,
      rewardState: 0,
      principalClaimed: 0,
      rewardClaimed: 0,
    });
  }

  // 夹具 2：A2 的 R1 奖励已早领（立即 50%，另 50% 进解锁池）
  const earlyAddress = addresses[2];
  const earlyReward = rewardByAddress.get(earlyAddress) ?? 0n;
  const earlyPaid = earlyReward / 2n;
  const earlyLocked = earlyReward - earlyPaid;

  // 每轮总质押 / 总权重
  for (const round of rounds) {
    if (round.state === 'UNOPENED') continue;
    const roundRecords = records.filter((record) => record.roundId === round.round_id);
    let total = 0n;
    const unique = new Set<string>();
    for (const record of roundRecords) {
      total += record.amountRaw;
      unique.add(record.address);
    }
    round.total_accepted_stake_raw = total.toString();
    round.staker_count = unique.size;
    const weights = v8.computeRoundWeights(params, toStakeRows(roundRecords));
    round.total_weight_raw = weights.totalWeight.toString();
  }
  // R2 三笔销毁：奖励 7 亿 + 团队额度 + 本轮本金（含滚存进来的 2000 万）
  const r2Row = roundsById.get(2)!;
  const r2Total = toBigInt(r2Row.total_accepted_stake_raw);
  r2Row.burned_raw = (params.roundRewardRaw + params.teamRoundRaw + r2Total).toString();

  // V8 奖励三态账本（只对已成功的 R1 生成）
  const rewardRows: RoundRewardRow[] = [];
  for (const [address, entry] of r1Weights.byAddress) {
    const reward = rewardByAddress.get(address) ?? 0n;
    let state = 0;
    let paid = 0n;
    let locked = 0n;
    let rolled = 0n;
    if (address === rollAddress) {
      state = 1;
      rolled = rollAmount;
      locked = rollLocked;
    } else if (address === earlyAddress) {
      state = 2;
      paid = earlyPaid;
      locked = earlyLocked;
    }
    rewardRows.push({
      round_id: 1,
      address,
      weight_raw: entry.weight.toString(),
      reward_raw: reward.toString(),
      state,
      paid_raw: paid.toString(),
      locked_raw: locked.toString(),
      rolled_raw: rolled.toString(),
      created_at: r1Close + CANDLE_COUNT * candleMs,
      updated_at: now,
    });
  }
  for (const record of records) {
    if (record.roundId === 1 && record.address === rollAddress) {
      record.rewardState = 1;
      record.rewardClaimed = 1;
    } else if (record.roundId === 1 && record.address === earlyAddress) {
      record.rewardState = 2;
      record.rewardClaimed = 1;
    } else if (record.roundId === 1 && record.index === 0) {
      record.principalClaimed = 1;
    }
  }

  // 领取记录：A0 已领 R1 本金；A2 已早领 50%
  const a0 = r1Records.find((record) => record.index === 0);
  const claims: { round_id: number; address: string; kind: 'principal' | 'reward'; amount_raw: string; claimed_at: number }[] = [];
  if (a0) claims.push({ round_id: 1, address: addresses[0], kind: 'principal', amount_raw: a0.amountRaw.toString(), claimed_at: r1Close + 9 * DAY });
  claims.push({
    round_id: 1,
    address: earlyAddress,
    kind: 'reward',
    amount_raw: earlyPaid.toString(),
    claimed_at: r1Close + CANDLE_COUNT * candleMs + 2 * DAY,
  });

  // 邀请关系（2 组，一层、不可改）
  const referrals: store.ReferralRow[] = Object.entries(V8_REFERRALS).map(([inviteeIndex, referrerIndex]) => ({
    address: addresses[Number(inviteeIndex)],
    referrer: addresses[referrerIndex],
    created_at: now - 5 * DAY,
  }));

  // K 线 + 滚动哈希（链上只存哈希）
  const candles: CandleRow[] = [];
  for (const row of rounds) {
    if (row.observation_start === null) continue;
    const limit = row.state === 'OBSERVING' ? R3_SEEDED_CANDLES : CANDLE_COUNT;
    const roundCandles: CandleRow[] = [];
    for (let index = 0; index < limit; index++) {
      roundCandles.push(source.buildCandle({ ...params, now }, row, index));
    }
    row.candle_hash = await v8.computeCandleHash(roundCandles);
    candles.push(...roundCandles);
  }

  const burnAt = r2Close + CANDLE_COUNT * candleMs;
  const burns = [
    { round_id: 2, kind: 'reward' as const, amount_raw: params.roundRewardRaw.toString(), burn_ref: 'R2:reward', confirmed: 1, created_at: burnAt, confirmed_at: burnAt + 60_000 },
    { round_id: 2, kind: 'team' as const, amount_raw: params.teamRoundRaw.toString(), burn_ref: 'R2:team', confirmed: 1, created_at: burnAt, confirmed_at: burnAt + 60_000 },
    { round_id: 2, kind: 'principal' as const, amount_raw: r2Total.toString(), burn_ref: 'R2:principal', confirmed: 1, created_at: burnAt, confirmed_at: burnAt + 60_000 },
  ];

  const r3Row = roundsById.get(3)!;
  const trades = source.buildTrades({ ...params, now }, r3Row, 80, now - DAY, now);
  const mid = toBigInt(r3Row.target_price_usd_e8);
  const book: BookRow[] = source.bookRows({ ...params, now }, mid, 10);

  await store.clearDemoData(env);
  await store.insertRounds(env, rounds);
  await store.insertStakesBulk(env, toStakeRows(records));
  await store.insertClaimsBulk(env, claims);
  await store.insertRoundRewardsBulk(env, rewardRows);
  await store.insertReferralsBulk(env, referrals);
  await store.setUnlockPool(
    env,
    { startAt: now - UNLOCK_SAMPLE_DAYS * DAY, totalLockedRaw: (rollLocked + earlyLocked).toString(), claimedRaw: '0' },
    now,
  );
  await store.insertBurnsBulk(env, burns);
  await store.insertCandles(
    env,
    candles.map((row) => ({ ...row, recorded_at: now })),
  );
  await store.insertTrades(env, trades);
  await store.insertBookLevels(env, book);

  // 时间锚点更新：config + metrics（oracle_paused 复位、解锁池标记 = R10 已终态样例）
  await store.setConfigValues(env, { demo_epoch_ms: String(now) }, now);
  await store.setMetrics(
    env,
    {
      demo_epoch_ms: String(now),
      demo_candle_seconds: String(params.demoCandleSeconds),
      demo_stake_seconds: String(params.demoStakeSeconds),
      unlock_start_round: 'sample',
      unlock_started_at: String(now - UNLOCK_SAMPLE_DAYS * DAY),
      oracle_paused: '0',
      oracle_last_update: String(now - 2500),
      seed_applied_at: String(now),
    },
    now,
  );
}
