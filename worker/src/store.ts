/**
 * D1 读写层（唯一允许拼 SQL 的地方）。
 * 口径：金额一律以 TEXT 保存 raw units 字符串（1e19 超出 int64，禁止用 SQL SUM）；
 *       价格 TEXT 保存 USD_E8；时间 INTEGER 毫秒。
 */
import type { Env } from './env';
import { toBigInt } from './util';

export type RoundStateName =
  | 'UNOPENED'
  | 'STAKING_OPEN'
  | 'STAKING_CLOSED'
  | 'OBSERVING'
  | 'ORACLE_PAUSED'
  | 'SETTLING_SUCCESS'
  | 'SETTLING_FAILURE'
  | 'SUCCEEDED'
  | 'FAILED_PERMANENT'
  | 'TECHNICAL_ABORTED';

export interface ConfigRow {
  key: string;
  value: string;
}

export interface RoundRow {
  round_id: number;
  state: RoundStateName;
  target_price_usd_e8: string;
  reward_budget_raw: string;
  stake_open_at: number | null;
  stake_close_at: number | null;
  observation_start: number | null;
  observation_end: number | null;
  candles_seen: number;
  qualified_candles: number;
  total_accepted_stake_raw: string;
  staker_count: number;
  result: 'SUCCESS' | 'FAILURE' | 'TECHNICAL_ABORT' | null;
  burned_raw: string | null;
  updated_at: number;
}

export interface CandleRow {
  round_id: number;
  candle_index: number;
  period_start: number;
  period_end: number;
  twap_price_usd_e8: string;
  qualified: number;
  coverage_bps: number;
  valid_source_count: number;
  data_digest: string;
  recorded_at?: number;
}

export interface StakeRow {
  id: number;
  round_id: number;
  address: string;
  amount_raw: string;
  weight_raw: string;
  nonce: string;
  risk_disclosure_version: number;
  accept_full_principal_burn: number;
  principal_claimed: number;
  reward_claimed: number;
  accepted_at: number;
}

export interface ClaimRow {
  id: number;
  round_id: number;
  address: string;
  kind: 'principal' | 'reward';
  amount_raw: string;
  claimed_at: number;
}

export interface TradeRow {
  id: number;
  ts: number;
  side: 'BUY' | 'SELL';
  amount_raw: string;
  price_usd_e8: string;
  value_usd_e8: string;
  big: number;
}

export interface BookRow {
  id: number;
  side: 'ask' | 'bid';
  price_usd_e8: string;
  amount_raw: string;
  seq: number;
}

export interface BurnRow {
  id: number;
  round_id: number;
  kind: 'reward' | 'principal';
  amount_raw: string;
  burn_ref: string;
  confirmed: number;
  created_at: number;
  confirmed_at: number | null;
}

export interface EventRow {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  actor: string;
  action: string;
  detail: string;
}

type Bind = string | number | null;

async function all<T>(env: Env, sql: string, ...binds: Bind[]): Promise<T[]> {
  const stmt = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
  const res = await stmt.all<T>();
  return res.results ?? [];
}

async function first<T>(env: Env, sql: string, ...binds: Bind[]): Promise<T | null> {
  const stmt = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
  return (await stmt.first<T>()) ?? null;
}

async function run(env: Env, sql: string, ...binds: Bind[]): Promise<number> {
  const stmt = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
  const res = await stmt.run();
  return res.meta?.changes ?? 0;
}

/* ------------------------------------------------------------------ *
 * 健康检查
 * ------------------------------------------------------------------ */

export async function dbPing(env: Env): Promise<boolean> {
  try {
    const row = await first<{ ok: number }>(env, 'SELECT 1 AS ok');
    return row?.ok === 1;
  } catch (error) {
    console.error('[d1] ping failed', error);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * config / metrics（key-value）
 * ------------------------------------------------------------------ */

/** 一条 SQL 同时读 config 与 metrics，减少 D1 往返。 */
export async function getKeyValues(env: Env): Promise<Map<string, string>> {
  const rows = await all<ConfigRow>(
    env,
    `SELECT key, value FROM config
     UNION ALL
     SELECT key, value FROM metrics`,
  );
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.key, row.value);
  return map;
}

export async function setConfigValues(env: Env, entries: Record<string, string>, now: number): Promise<void> {
  const keys = Object.keys(entries);
  if (!keys.length) return;
  const statements = keys.map((key) =>
    env.DB.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)').bind(key, entries[key], now),
  );
  await env.DB.batch(statements);
}

export async function setMetrics(env: Env, entries: Record<string, string>, now: number): Promise<void> {
  const keys = Object.keys(entries);
  if (!keys.length) return;
  const statements = keys.map((key) =>
    env.DB.prepare('INSERT OR REPLACE INTO metrics (key, value, updated_at) VALUES (?, ?, ?)').bind(key, entries[key], now),
  );
  await env.DB.batch(statements);
}

/* ------------------------------------------------------------------ *
 * rounds
 * ------------------------------------------------------------------ */

export async function listRounds(env: Env): Promise<RoundRow[]> {
  return all<RoundRow>(env, 'SELECT * FROM rounds ORDER BY round_id ASC');
}

export async function getRound(env: Env, roundId: number): Promise<RoundRow | null> {
  return first<RoundRow>(env, 'SELECT * FROM rounds WHERE round_id = ?', roundId);
}

/** CAS：仅当当前状态等于 from 时才能迁移，返回是否迁移成功。 */
export async function casRoundState(env: Env, roundId: number, from: RoundStateName, to: RoundStateName, now: number): Promise<boolean> {
  const changes = await run(
    env,
    'UPDATE rounds SET state = ?, updated_at = ? WHERE round_id = ? AND state = ?',
    to,
    now,
    roundId,
    from,
  );
  return changes > 0;
}

export async function updateRoundCandles(env: Env, roundId: number, seen: number, qualified: number, now: number): Promise<void> {
  await run(
    env,
    'UPDATE rounds SET candles_seen = ?, qualified_candles = ?, updated_at = ? WHERE round_id = ?',
    seen,
    qualified,
    now,
    roundId,
  );
}

export interface FinalizeSuccessInput {
  roundId: number;
  now: number;
  candlesSeen: number;
  qualifiedCandles: number;
}

export async function finalizeSuccess(env: Env, input: FinalizeSuccessInput): Promise<boolean> {
  const { roundId, now, candlesSeen, qualifiedCandles } = input;
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE rounds
          SET state = 'SUCCEEDED', result = 'SUCCESS', burned_raw = NULL,
              candles_seen = ?, qualified_candles = ?, updated_at = ?
        WHERE round_id = ? AND state = 'SETTLING_SUCCESS'`,
    ).bind(candlesSeen, qualifiedCandles, now, roundId),
  ]);
  return (result[0]?.meta?.changes ?? 0) > 0;
}

export interface FinalizeFailureInput {
  roundId: number;
  now: number;
  candlesSeen: number;
  qualifiedCandles: number;
  rewardBurnRaw: string;
  teamBurnRaw: string;
  principalBurnRaw: string;
  burnedRaw: string;
}

/** 失败终态：写入两笔销毁账本 + 轮次 FAILED_PERMANENT，单事务批量执行（幂等）。 */
export async function finalizeFailure(env: Env, input: FinalizeFailureInput): Promise<boolean> {
  const { roundId, now, candlesSeen, qualifiedCandles, rewardBurnRaw, teamBurnRaw, principalBurnRaw, burnedRaw } = input;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO burn_ledger
         (round_id, kind, amount_raw, burn_ref, confirmed, created_at, confirmed_at)
       VALUES (?, 'reward', ?, ?, 1, ?, ?)`,
    ).bind(roundId, rewardBurnRaw, `R${roundId}:reward`, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO burn_ledger
         (round_id, kind, amount_raw, burn_ref, confirmed, created_at, confirmed_at)
       VALUES (?, 'team', ?, ?, 1, ?, ?)`,
    ).bind(roundId, teamBurnRaw, `R${roundId}:team`, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO burn_ledger
         (round_id, kind, amount_raw, burn_ref, confirmed, created_at, confirmed_at)
       VALUES (?, 'principal', ?, ?, 1, ?, ?)`,
    ).bind(roundId, principalBurnRaw, `R${roundId}:principal`, now, now),
    env.DB.prepare(
      `UPDATE rounds
          SET state = 'FAILED_PERMANENT', result = 'FAILURE', burned_raw = ?,
              candles_seen = ?, qualified_candles = ?, updated_at = ?
        WHERE round_id = ? AND state = 'SETTLING_FAILURE'`,
    ).bind(burnedRaw, candlesSeen, qualifiedCandles, now, roundId),
  ]);
  return (results[2]?.meta?.changes ?? 0) > 0;
}

export interface OpenRoundInput {
  roundId: number;
  now: number;
  targetPriceUsdE8: string;
  rewardBudgetRaw: string;
  stakeOpenAt: number;
  stakeCloseAt: number;
  observationStart: number;
  observationEnd: number;
}

export async function openRound(env: Env, input: OpenRoundInput): Promise<boolean> {
  const changes = await run(
    env,
    `UPDATE rounds
        SET state = 'STAKING_OPEN', stake_open_at = ?, stake_close_at = ?,
            observation_start = ?, observation_end = ?, updated_at = ?
      WHERE round_id = ? AND state = 'UNOPENED'`,
    input.stakeOpenAt,
    input.stakeCloseAt,
    input.observationStart,
    input.observationEnd,
    input.now,
    input.roundId,
  );
  return changes > 0;
}

/** 预言机恢复：丢弃旧窗口并重启完整 12 根观察（不清空销毁账本，不改变轮次终态）。 */
export async function resetRoundWindow(env: Env, roundId: number, observationStart: number, observationEnd: number, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM candles WHERE round_id = ?').bind(roundId),
    env.DB.prepare(
      `UPDATE rounds
          SET observation_start = ?, observation_end = ?, candles_seen = 0, qualified_candles = 0,
              state = 'OBSERVING', updated_at = ?
        WHERE round_id = ?`,
    ).bind(observationStart, observationEnd, now, roundId),
  ]);
}

/* ------------------------------------------------------------------ *
 * 批量写入（演示数据重置用；D1 batch 分片发送）
 * ------------------------------------------------------------------ */

async function runBatches(env: Env, statements: D1PreparedStatement[], chunkSize = 40): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await env.DB.batch(statements.slice(i, i + chunkSize));
  }
}

export async function insertRounds(env: Env, rows: RoundRow[]): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO rounds
        (round_id, state, target_price_usd_e8, reward_budget_raw, stake_open_at, stake_close_at,
         observation_start, observation_end, candles_seen, qualified_candles, total_accepted_stake_raw,
         staker_count, result, burned_raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.round_id,
      row.state,
      row.target_price_usd_e8,
      row.reward_budget_raw,
      row.stake_open_at,
      row.stake_close_at,
      row.observation_start,
      row.observation_end,
      row.candles_seen,
      row.qualified_candles,
      row.total_accepted_stake_raw,
      row.staker_count,
      row.result,
      row.burned_raw,
      row.updated_at,
    ),
  );
  await runBatches(env, statements);
}

export interface StakeSeedRow {
  round_id: number;
  address: string;
  amount_raw: string;
  weight_raw: string;
  nonce: string;
  risk_disclosure_version: number;
  principal_claimed: number;
  reward_claimed: number;
  accepted_at: number;
}

export async function insertStakesBulk(env: Env, rows: StakeSeedRow[]): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO stakes
        (round_id, address, amount_raw, weight_raw, nonce, risk_disclosure_version,
         accept_full_principal_burn, principal_claimed, reward_claimed, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      row.round_id,
      row.address,
      row.amount_raw,
      row.weight_raw,
      row.nonce,
      row.risk_disclosure_version,
      row.principal_claimed,
      row.reward_claimed,
      row.accepted_at,
    ),
  );
  await runBatches(env, statements);
}

export async function insertClaimsBulk(
  env: Env,
  rows: { round_id: number; address: string; kind: 'principal' | 'reward'; amount_raw: string; claimed_at: number }[],
): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map((row) =>
    env.DB.prepare('INSERT OR REPLACE INTO claims (round_id, address, kind, amount_raw, claimed_at) VALUES (?, ?, ?, ?, ?)').bind(
      row.round_id,
      row.address,
      row.kind,
      row.amount_raw,
      row.claimed_at,
    ),
  );
  await runBatches(env, statements);
}

export async function insertBurnsBulk(
  env: Env,
  rows: { round_id: number; kind: 'reward' | 'principal' | 'team'; amount_raw: string; burn_ref: string; confirmed: number; created_at: number; confirmed_at: number }[],
): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO burn_ledger (round_id, kind, amount_raw, burn_ref, confirmed, created_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.round_id, row.kind, row.amount_raw, row.burn_ref, row.confirmed, row.created_at, row.confirmed_at),
  );
  await runBatches(env, statements);
}

/** D-18b：0 人质押且本轮通过 → 本轮奖励销毁；记录销毁并回写轮次 burned_raw。 */
export async function recordNoStakerRewardBurn(env: Env, roundId: number, amountRaw: string, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO burn_ledger
         (round_id, kind, amount_raw, burn_ref, confirmed, created_at, confirmed_at)
       VALUES (?, 'reward', ?, ?, 1, ?, ?)`,
    ).bind(roundId, amountRaw, `R${roundId}:reward_nostaker`, now, now),
    env.DB.prepare('UPDATE rounds SET burned_raw = ?, updated_at = ? WHERE round_id = ?').bind(amountRaw, now, roundId),
  ]);
}

export async function insertBookLevels(env: Env, rows: BookRow[]): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map((row) =>
    env.DB.prepare('INSERT INTO book_levels (side, price_usd_e8, amount_raw, seq) VALUES (?, ?, ?, ?)').bind(
      row.side,
      row.price_usd_e8,
      row.amount_raw,
      row.seq,
    ),
  );
  await runBatches(env, statements);
}

export async function clearDemoData(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM claims'),
    env.DB.prepare('DELETE FROM stakes'),
    env.DB.prepare('DELETE FROM burn_ledger'),
    env.DB.prepare('DELETE FROM candles'),
    env.DB.prepare('DELETE FROM rounds'),
    env.DB.prepare('DELETE FROM trades'),
    env.DB.prepare('DELETE FROM book_levels'),
  ]);
}

/* ------------------------------------------------------------------ *
 * candles
 * ------------------------------------------------------------------ */

/** 一次读出全部 K 线（最多 10×12 行），避免按轮 N+1 查询。 */
export async function listCandlesAll(env: Env): Promise<CandleRow[]> {
  return all<CandleRow>(env, 'SELECT * FROM candles ORDER BY round_id ASC, candle_index ASC');
}

export async function listCandles(env: Env, roundId: number): Promise<CandleRow[]> {
  return all<CandleRow>(env, 'SELECT * FROM candles WHERE round_id = ? ORDER BY candle_index ASC', roundId);
}

export async function insertCandles(env: Env, rows: CandleRow[]): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO candles
         (round_id, candle_index, period_start, period_end, twap_price_usd_e8, qualified,
          coverage_bps, valid_source_count, data_digest, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.round_id,
      row.candle_index,
      row.period_start,
      row.period_end,
      row.twap_price_usd_e8,
      row.qualified,
      row.coverage_bps,
      row.valid_source_count,
      row.data_digest,
      row.recorded_at ?? Date.now(),
    ),
  );
  await env.DB.batch(statements);
}

/* ------------------------------------------------------------------ *
 * stakes / claims
 * ------------------------------------------------------------------ */

/* ------------------------- 轮次质押聚合（单一事实源） ------------------------- */

export interface StakeAggregateInputRow {
  round_id: number;
  address: string;
  amount_raw: string;
  accepted_at: number;
}

export interface AddressStake {
  amountRaw: bigint;
  acceptedAt: number;
}

export interface RoundAggregate {
  totalRaw: bigint;
  stakerCount: number;
  byAddress: Map<string, AddressStake>;
}

export type StakeAggregates = Map<number, RoundAggregate>;

/** 一次查询取出全部质押，聚合出每轮总质押 / 去重地址数 / 地址明细（避免各处口径不一）。 */
export async function listAllStakes(env: Env): Promise<StakeAggregateInputRow[]> {
  return all<StakeAggregateInputRow>(env, 'SELECT round_id, address, amount_raw, accepted_at FROM stakes');
}

export function buildStakeAggregates(rows: StakeAggregateInputRow[]): StakeAggregates {
  const result: StakeAggregates = new Map();
  for (const row of rows) {
    let round = result.get(row.round_id);
    if (!round) {
      round = { totalRaw: 0n, stakerCount: 0, byAddress: new Map() };
      result.set(row.round_id, round);
    }
    const amount = toBigInt(row.amount_raw);
    round.totalRaw += amount;
    const entry = round.byAddress.get(row.address);
    if (entry) {
      entry.amountRaw += amount;
      entry.acceptedAt = Math.min(entry.acceptedAt, row.accepted_at);
    } else {
      round.byAddress.set(row.address, { amountRaw: amount, acceptedAt: row.accepted_at });
    }
    round.stakerCount = round.byAddress.size;
  }
  return result;
}

export async function updateRoundAggregate(env: Env, roundId: number, totalRaw: string, stakerCount: number, now: number): Promise<void> {
  await run(
    env,
    'UPDATE rounds SET total_accepted_stake_raw = ?, staker_count = ?, updated_at = ? WHERE round_id = ?',
    totalRaw,
    stakerCount,
    now,
    roundId,
  );
}

export async function listStakesForRound(env: Env, roundId: number): Promise<StakeRow[]> {
  return all<StakeRow>(env, 'SELECT * FROM stakes WHERE round_id = ? ORDER BY accepted_at ASC, id ASC', roundId);
}

export async function listStakesForAddress(env: Env, address: string): Promise<StakeRow[]> {
  return all<StakeRow>(env, 'SELECT * FROM stakes WHERE address = ? ORDER BY round_id ASC, accepted_at ASC', address);
}

export async function hasNonce(env: Env, roundId: number, address: string, nonce: string): Promise<boolean> {
  const row = await first<{ n: number }>(
    env,
    'SELECT COUNT(*) AS n FROM stakes WHERE round_id = ? AND address = ? AND nonce = ?',
    roundId,
    address,
    nonce,
  );
  return (row?.n ?? 0) > 0;
}

export interface StakeInsertInput {
  roundId: number;
  address: string;
  amountRaw: bigint;
  weightRaw: bigint;
  nonce: string;
  riskDisclosureVersion: number;
  acceptFullPrincipalBurn: boolean;
  acceptedAt: number;
}

/** 返回 false 表示 nonce 重复（幂等拒绝）。 */
export async function insertStake(env: Env, input: StakeInsertInput): Promise<boolean> {
  const changes = await run(
    env,
    `INSERT OR IGNORE INTO stakes
       (round_id, address, amount_raw, weight_raw, nonce, risk_disclosure_version,
        accept_full_principal_burn, principal_claimed, reward_claimed, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    input.roundId,
    input.address,
    input.amountRaw.toString(),
    input.weightRaw.toString(),
    input.nonce,
    input.riskDisclosureVersion,
    input.acceptFullPrincipalBurn ? 1 : 0,
    input.acceptedAt,
  );
  return changes > 0;
}

/** 重算轮次聚合（stake 表为唯一事实来源，避免 TEXT 列做 SQL 求和丢精度）。 */
export async function refreshRoundStakeTotals(env: Env, roundId: number, now: number): Promise<void> {
  const rows = await listStakesForRound(env, roundId);
  let total = 0n;
  const addresses = new Set<string>();
  for (const row of rows) {
    total += toBigInt(row.amount_raw);
    addresses.add(row.address);
  }
  await run(
    env,
    'UPDATE rounds SET total_accepted_stake_raw = ?, staker_count = ?, updated_at = ? WHERE round_id = ?',
    total.toString(),
    addresses.size,
    now,
    roundId,
  );
}

export async function listClaimsForAddress(env: Env, address: string): Promise<ClaimRow[]> {
  return all<ClaimRow>(env, 'SELECT * FROM claims WHERE address = ? ORDER BY round_id ASC, kind ASC', address);
}

export async function getClaim(env: Env, roundId: number, address: string, kind: 'principal' | 'reward'): Promise<ClaimRow | null> {
  return first<ClaimRow>(env, 'SELECT * FROM claims WHERE round_id = ? AND address = ? AND kind = ?', roundId, address, kind);
}

/** 幂等领取：claims 唯一键兜底，并同步 stake 的领取标记。 */
export async function recordClaim(
  env: Env,
  input: { roundId: number; address: string; kind: 'principal' | 'reward'; amountRaw: bigint; claimedAt: number },
): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO claims (round_id, address, kind, amount_raw, claimed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(input.roundId, input.address, input.kind, input.amountRaw.toString(), input.claimedAt),
    env.DB.prepare(
      input.kind === 'principal'
        ? 'UPDATE stakes SET principal_claimed = 1 WHERE round_id = ? AND address = ?'
        : 'UPDATE stakes SET reward_claimed = 1 WHERE round_id = ? AND address = ?',
    ).bind(input.roundId, input.address),
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

/* ------------------------------------------------------------------ *
 * trades / book
 * ------------------------------------------------------------------ */

export async function listTrades(env: Env, limit: number): Promise<TradeRow[]> {
  return all<TradeRow>(env, 'SELECT * FROM trades ORDER BY ts DESC, id DESC LIMIT ?', limit);
}

export async function listTradeValuesSince(env: Env, since: number): Promise<string[]> {
  const rows = await all<{ value_usd_e8: string }>(env, 'SELECT value_usd_e8 FROM trades WHERE ts >= ?', since);
  return rows.map((row) => row.value_usd_e8);
}

export async function latestTradeTs(env: Env): Promise<number> {
  const row = await first<{ ts: number | null }>(env, 'SELECT MAX(ts) AS ts FROM trades');
  return row?.ts ?? 0;
}

export async function insertTrades(env: Env, rows: TradeRow[]): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map((row) =>
    env.DB.prepare(
      'INSERT INTO trades (ts, side, amount_raw, price_usd_e8, value_usd_e8, big) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(row.ts, row.side, row.amount_raw, row.price_usd_e8, row.value_usd_e8, row.big),
  );
  await env.DB.batch(statements);
}

export async function trimTrades(env: Env, before: number): Promise<void> {
  await run(env, 'DELETE FROM trades WHERE ts < ?', before);
}

export async function listBook(env: Env): Promise<BookRow[]> {
  return all<BookRow>(env, 'SELECT * FROM book_levels ORDER BY side ASC, seq ASC');
}

/* ------------------------------------------------------------------ *
 * burn ledger
 * ------------------------------------------------------------------ */

export async function listBurns(env: Env, roundId?: number): Promise<BurnRow[]> {
  if (typeof roundId === 'number') {
    return all<BurnRow>(env, 'SELECT * FROM burn_ledger WHERE round_id = ? ORDER BY id ASC', roundId);
  }
  return all<BurnRow>(env, 'SELECT * FROM burn_ledger ORDER BY round_id ASC, kind ASC');
}

export async function totalConfirmedBurned(env: Env): Promise<bigint> {
  const rows = await all<{ amount_raw: string }>(env, 'SELECT amount_raw FROM burn_ledger WHERE confirmed = 1');
  let total = 0n;
  for (const row of rows) total += toBigInt(row.amount_raw);
  return total;
}

/* ------------------------------------------------------------------ *
 * admin events
 * ------------------------------------------------------------------ */

export async function logEvent(
  env: Env,
  level: 'info' | 'warn' | 'error',
  actor: string,
  action: string,
  detail: string,
  ts = Date.now(),
): Promise<void> {
  await run(
    env,
    'INSERT INTO admin_events (ts, level, actor, action, detail) VALUES (?, ?, ?, ?, ?)',
    ts,
    level,
    actor,
    action,
    detail,
  );
}

export async function listEvents(env: Env, limit = 50): Promise<EventRow[]> {
  return all<EventRow>(env, 'SELECT * FROM admin_events ORDER BY ts DESC, id DESC LIMIT ?', limit);
}