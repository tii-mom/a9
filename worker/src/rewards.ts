/**
 * v10 奖励账本 / K 线滚动哈希 —— 纯计算 + D1 读写的领域模块。
 * 口径与合约 v10 一一对应（contracts/contracts/RoundController.tolk rewardOf）：
 *   reward = floor(rewardBudget × 我的质押 / 本轮总质押)，仅 SUCCEEDED 轮；一次 Claim 同时领本金 + 全额奖励。
 * V8 的权重 / 邀请 / 连续参与 / 滚存 / 早领 / 解锁池全部删除（docs/00 D-42）。
 */
import type { Env } from './env';
import { rewardFor, type Params } from './protocol';
import * as store from './store';
import type { CandleRow, RoundRow, RoundRewardRow, StakeRow } from './store';
import { toBigInt } from './util';

export interface RoundStakeTotals {
  totalStake: bigint;
  byAddress: Map<string, bigint>;
}

/** 某轮每地址质押合计。 */
export function roundStakeTotals(stakes: StakeRow[]): RoundStakeTotals {
  const byAddress = new Map<string, bigint>();
  let totalStake = 0n;
  for (const stake of stakes) {
    const amount = toBigInt(stake.amount_raw);
    totalStake += amount;
    byAddress.set(stake.address, (byAddress.get(stake.address) ?? 0n) + amount);
  }
  return { totalStake, byAddress };
}

/**
 * 成功轮每地址奖励行（幂等重放：保留 created_at）。
 * totalStakeOverride：chain 模式以链上 get_round.totalAcceptedStakeRaw 为分母。
 */
export function buildRewardRows(
  round: RoundRow,
  totals: RoundStakeTotals,
  now: number,
  existing: RoundRewardRow[] = [],
  totalStakeOverride?: bigint,
): RoundRewardRow[] {
  const budget = toBigInt(round.reward_budget_raw);
  const total = totalStakeOverride && totalStakeOverride > 0n ? totalStakeOverride : totals.totalStake;
  const existingByAddress = new Map(existing.map((row) => [row.address, row]));
  const rows: RoundRewardRow[] = [];
  for (const [address, amount] of totals.byAddress) {
    rows.push({
      round_id: round.round_id,
      address,
      weight_raw: amount.toString(),
      reward_raw: rewardFor(budget, amount, total).toString(),
      created_at: existingByAddress.get(address)?.created_at ?? now,
      updated_at: now,
    });
  }
  return rows;
}

/** 奖励行与已有账本是否不同（缺行 / 金额漂移）。 */
export function rewardRowsDrifted(rows: RoundRewardRow[], existing: RoundRewardRow[]): boolean {
  if (rows.length !== existing.length) return true;
  return rows.some((row) => {
    const prev = existing.find((item) => item.address === row.address);
    return !prev || prev.reward_raw !== row.reward_raw || prev.weight_raw !== row.weight_raw;
  });
}

/** 某地址在某轮的全额奖励：优先读账本，否则按质押比例现算（仅 SUCCEEDED）。 */
export function rewardOfAddress(
  round: RoundRow,
  address: string,
  stakes: StakeRow[],
  rewardRows: RoundRewardRow[],
): bigint {
  if (round.state !== 'SUCCEEDED') return 0n;
  const row = rewardRows.find((item) => item.round_id === round.round_id && item.address === address);
  if (row) return toBigInt(row.reward_raw);
  const totals = roundStakeTotals(stakes.filter((stake) => stake.round_id === round.round_id));
  return rewardFor(toBigInt(round.reward_budget_raw), totals.byAddress.get(address) ?? 0n, totals.totalStake);
}

/**
 * demo 模式幂等同步：每轮 total_weight_raw（= 总质押）/ 成功轮奖励账本 / K 线滚动哈希。
 * chain 模式这些字段的唯一写者是 worker/src/indexer（单一写者约定），这里直接跳过。
 * 返回是否有写库变更。
 */
export async function syncRoundLedgers(
  env: Env,
  params: Params,
  rounds: RoundRow[],
  allStakes: StakeRow[],
  candlesByRound: Map<number, CandleRow[]>,
  now: number,
): Promise<boolean> {
  if (params.dataSource === 'chain') return false;
  let changed = false;
  const rewardRows = await store.listAllRoundRewards(env);

  for (const round of rounds) {
    if (round.state === 'UNOPENED') continue;
    const stakes = allStakes.filter((stake) => stake.round_id === round.round_id);
    if (!stakes.length) continue;

    const totals = roundStakeTotals(stakes);
    const totalWeightRaw = totals.totalStake.toString();
    const weightChanged = round.total_weight_raw !== totalWeightRaw;
    if (weightChanged) {
      round.total_weight_raw = totalWeightRaw;
      changed = true;
    }

    if (round.state === 'SUCCEEDED') {
      const existing = rewardRows.filter((row) => row.round_id === round.round_id);
      const rows = buildRewardRows(round, totals, now, existing);
      if (rewardRowsDrifted(rows, existing)) {
        await store.replaceRoundRewards(env, round.round_id, rows);
        changed = true;
      }
    }

    // demo 用字符串滚动哈希（sha256(prev|index|twap|digest)）；chain 模式保留链上 TON cell 滚动哈希
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
 * demo K 线滚动哈希（与 seed 生成器同公式）：
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
