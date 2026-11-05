/**
 * 演示数据集重置（DEMO_AUTOPLAY 循环展示用）。
 *
 * 十轮全部进入终态后，Worker 用同一套确定性算法重建初始演示数据：
 *   R1 SUCCEEDED(10/12)、R2 FAILED_PERMANENT(6/12，销毁 991.5M)、R3 OBSERVING(6/12 已收盘，4 根达标)、
 *   R4..R10 UNOPENED。
 *
 * 与 worker/scripts/generate-seed.mjs 保持同一份「演示数据集定义」：
 *   - 12 个确定性 UQ 地址（SHA-256("fuse-protocol-demo-wallet-{i}") → base64url）
 *   - 每轮总质押：R1 214.8M / R2 241.5M / R3 386.2M，按固定 bps 权重拆分
 *   - R2 两笔销毁：700,000,000 奖励 + 241,500,000 本金
 * 差异仅在于时间锚点（重置时刻 vs seed 执行时刻）与成交/盘口由 demo source 现场生成。
 */
import type { Env } from './env';
import { CANDLE_COUNT, ROUND_COUNT, TOKEN_SCALE, type Params } from './protocol';
import * as store from './store';
import type { BookRow, CandleRow, RoundRow } from './store';
import { getSource } from './sources';
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
/** R3 初始已收盘 6 根，其中 4 根达标（对应原型 4 hit / 2 miss）。 */
const R3_SEEDED_CANDLES = 6;

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

function emptyRound(roundId: number, params: Params): RoundRow {
  return {
    round_id: roundId,
    state: 'UNOPENED',
    target_price_usd_e8: (params.p0UsdE8 * (1n << BigInt(roundId))).toString(),
    reward_budget_raw: params.roundRewardRaw.toString(),
    stake_open_at: null,
    stake_close_at: null,
    observation_start: null,
    observation_end: null,
    candles_seen: 0,
    qualified_candles: 0,
    total_accepted_stake_raw: '0',
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
  const r3Close = r3Start - 30 * 60_000;

  const rounds: RoundRow[] = [];
  const stakes: store.StakeSeedRow[] = [];
  const claims: { round_id: number; address: string; kind: 'principal' | 'reward'; amount_raw: string; claimed_at: number }[] = [];
  const roundTotals = new Map<number, bigint>();

  for (let roundId = 1; roundId <= ROUND_COUNT; roundId++) {
    const row = emptyRound(roundId, params);
    if (roundId === 1) {
      row.state = 'SUCCEEDED';
      row.stake_open_at = r1Close - 7 * DAY;
      row.stake_close_at = r1Close;
      row.observation_start = r1Close;
      row.observation_end = r1Close + CANDLE_COUNT * candleMs;
      row.candles_seen = CANDLE_COUNT;
      row.qualified_candles = 10;
      row.result = 'SUCCESS';
      row.updated_at = r1Close + CANDLE_COUNT * candleMs;
    } else if (roundId === 2) {
      row.state = 'FAILED_PERMANENT';
      row.stake_open_at = r2Close - 7 * DAY;
      row.stake_close_at = r2Close;
      row.observation_start = r2Close;
      row.observation_end = r2Close + CANDLE_COUNT * candleMs;
      row.candles_seen = CANDLE_COUNT;
      row.qualified_candles = 6;
      row.result = 'FAILURE';
      row.burned_raw = (params.roundRewardRaw + STAKE_TOTALS_TOKENS[2] * TOKEN_SCALE).toString();
      row.updated_at = r2Close + CANDLE_COUNT * candleMs;
    } else if (roundId === 3) {
      row.state = 'OBSERVING';
      row.stake_open_at = r3Close - 3 * DAY;
      row.stake_close_at = r3Close;
      row.observation_start = r3Start;
      row.observation_end = r3Start + CANDLE_COUNT * candleMs;
      row.candles_seen = R3_SEEDED_CANDLES;
      row.qualified_candles = 4;
      row.updated_at = now;
    }
    rounds.push(row);
    if (roundId <= 3) roundTotals.set(roundId, STAKE_TOTALS_TOKENS[roundId] * TOKEN_SCALE);
  }

  // 质押（R1/R2/R3 各 12 地址）+ R1 两个地址已领取本金与奖励
  const claimedAddresses = new Set([addresses[0], addresses[1]]);
  const r1Total = roundTotals.get(1) ?? 0n;
  const r1Claims: typeof claims = [];
  for (const roundId of [1, 2, 3]) {
    const amounts = splitAmount(STAKE_TOTALS_TOKENS[roundId]);
    const openAt = roundId === 1 ? r1Close - 7 * DAY : roundId === 2 ? r2Close - 7 * DAY : r3Close - 3 * DAY;
    amounts.forEach((tokens, index) => {
      const amountRaw = tokens * TOKEN_SCALE;
      const claimed = roundId === 1 && claimedAddresses.has(addresses[index]) ? 1 : 0;
      stakes.push({
        round_id: roundId,
        address: addresses[index],
        amount_raw: amountRaw.toString(),
        weight_raw: amountRaw.toString(),
        nonce: 'seed-r' + roundId + '-' + index,
        risk_disclosure_version: params.riskDisclosureVersion,
        principal_claimed: claimed,
        reward_claimed: claimed,
        accepted_at: openAt + index * 3600_000 + ((index * 7919) % 3_600_000),
      });
      if (claimed === 1) {
        const rewardRaw = (params.roundRewardRaw * amountRaw) / r1Total;
        r1Claims.push({ round_id: 1, address: addresses[index], kind: 'principal', amount_raw: amountRaw.toString(), claimed_at: r1Close + 9 * DAY });
        r1Claims.push({ round_id: 1, address: addresses[index], kind: 'reward', amount_raw: rewardRaw.toString(), claimed_at: r1Close + 9 * DAY + 60_000 });
      }
    });
  }
  claims.push(...r1Claims);

  // 轮次聚合列与 stakes 对齐
  for (const row of rounds) {
    const aggregate = stakes.filter((stake) => stake.round_id === row.round_id);
    if (!aggregate.length) continue;
    let total = 0n;
    const unique = new Set<string>();
    for (const stake of aggregate) {
      total += toBigInt(stake.amount_raw);
      unique.add(stake.address);
    }
    row.total_accepted_stake_raw = total.toString();
    row.staker_count = unique.size;
  }

  // K 线：R1/R2 全 12 根、R3 前 6 根（优先级更高的推进由 reconcile 继续）
  const candles: CandleRow[] = [];
  for (const row of rounds) {
    if (row.observation_start === null) continue;
    const limit = row.state === 'OBSERVING' ? R3_SEEDED_CANDLES : CANDLE_COUNT;
    for (let index = 0; index < limit; index++) candles.push(source.buildCandle({ ...params, now }, row, index));
  }

  const burnAt = r2Close + CANDLE_COUNT * candleMs;
  const burns = [
    {
      round_id: 2,
      kind: 'reward' as const,
      amount_raw: params.roundRewardRaw.toString(),
      burn_ref: 'R2:reward',
      confirmed: 1,
      created_at: burnAt,
      confirmed_at: burnAt + 60_000,
    },
    {
      round_id: 2,
      kind: 'principal' as const,
      amount_raw: (STAKE_TOTALS_TOKENS[2] * TOKEN_SCALE).toString(),
      burn_ref: 'R2:principal',
      confirmed: 1,
      created_at: burnAt,
      confirmed_at: burnAt + 60_000,
    },
  ];

  const roundsById = new Map(rounds.map((row) => [row.round_id, row]));
  const r3Row = roundsById.get(3)!;
  const trades = source.buildTrades({ ...params, now }, r3Row, 80, now - DAY, now);
  const mid = toBigInt(r3Row.target_price_usd_e8);
  const book: BookRow[] = source.bookRows({ ...params, now }, mid, 10);

  await store.clearDemoData(env);
  await store.insertRounds(env, rounds);
  await store.insertStakesBulk(env, stakes);
  await store.insertClaimsBulk(env, claims);
  await store.insertBurnsBulk(env, burns);
  await store.insertCandles(
    env,
    candles.map((row) => ({ ...row, recorded_at: now })),
  );
  await store.insertTrades(env, trades);
  await store.insertBookLevels(env, book);

  // 时间锚点更新：config + metrics（oracle_paused 复位、报价/流动性保持配置值）
  await store.setConfigValues(env, { demo_epoch_ms: String(now) }, now);
  await store.setMetrics(
    env,
    {
      demo_epoch_ms: String(now),
      demo_candle_seconds: String(params.demoCandleSeconds),
      demo_stake_seconds: String(params.demoStakeSeconds),
      oracle_paused: '0',
      oracle_last_update: String(now - 2500),
      seed_applied_at: String(now),
    },
    now,
  );
}

