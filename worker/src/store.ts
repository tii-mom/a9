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
  /** D-28 档位：tier = 1 + 已成功轮数（失败不升档）；开轮时锁定，不随后续轮次变化 */
  target_tier: number;
  target_price_usd_e8: string;
  reward_budget_raw: string;
  stake_open_at: number | null;
  stake_close_at: number | null;
  observation_start: number | null;
  observation_end: number | null;
  candles_seen: number;
  qualified_candles: number;
  total_accepted_stake_raw: string;
  /** v10 = 总质押（权重已删除；列保留以兼容 get_round.totalWeight 槽位） */
  total_weight_raw: string;
  /** K 线滚动哈希（链上只存此值） */
  candle_hash: string | null;
  /** chain 模式（索引器落库）：最近一根已收盘 K 线 TWAP / 时间（USD_E8 / unix ms） */
  last_candle_twap_usd_e8?: string | null;
  last_candle_at?: number | null;
  /** chain 模式：开窗时锁定的 24h TWAP 参考价（USD_E8），用于 /api/stats 的 price24hAgoUsdE8 */
  target_twap24h_usd_e8?: string | null;
  /** chain 模式：链上原始状态码（RoundController get_round_status），用于对账/审计 */
  chain_status?: number | null;
  staker_count: number;
  result: 'SUCCESS' | 'FAILURE' | 'TECHNICAL_ABORT' | null;
  burned_raw: string | null;
  /** v10：成功轮团队释放额（RoundSettled.teamReleasedRaw；链上确认后写入，未结算/被退回为 NULL） */
  team_released_raw?: string | null;
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
  /** v10 = amount_raw（列保留） */
  weight_raw: string;
  nonce: string;
  risk_disclosure_version: number;
  accept_full_principal_burn: number;
  /** 本金已领取（或已一键续战转入下一城）；v11 Claimed/Restaked 事件置 1 */
  principal_claimed: number;
  /** 奖励已领取过至少一部分（v11：20% 立即部分或压城解锁部分） */
  reward_claimed: number;
  accepted_at: number;
  /** v11（migrations/0012）：deposit = 转账入金；restake = 一键续战滚入。缺省视为 deposit */
  source?: 'deposit' | 'restake' | null;
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
  kind: 'reward' | 'principal' | 'team';
  amount_raw: string;
  burn_ref: string;
  confirmed: number;
  created_at: number;
  confirmed_at: number | null;
  /** chain 模式：链上 burn 交易哈希（BurnAck 对账） */
  chain_tx_hash?: string | null;
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
  /** 成功轮团队释放额（v10：RC 直接转团队钱包） */
  teamReleasedRaw: string;
}

export async function finalizeSuccess(env: Env, input: FinalizeSuccessInput): Promise<boolean> {
  const { roundId, now, candlesSeen, qualifiedCandles, teamReleasedRaw } = input;
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE rounds
          SET state = 'SUCCEEDED', result = 'SUCCESS', burned_raw = NULL, team_released_raw = ?,
              candles_seen = ?, qualified_candles = ?, updated_at = ?
        WHERE round_id = ? AND state = 'SETTLING_SUCCESS'`,
    ).bind(teamReleasedRaw, candlesSeen, qualifiedCandles, now, roundId),
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

/** 失败终态：写入销毁账本（v10 链上是一笔 burn，账本按 reward/team/principal 拆分记录）+ 轮次 FAILED_PERMANENT，单事务批量执行（幂等）。 */
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
  /** 开轮档位（tier = 1 + 已成功轮数，D-28） */
  targetTier: number;
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
        SET state = 'STAKING_OPEN', target_tier = ?, target_price_usd_e8 = ?,
            stake_open_at = ?, stake_close_at = ?,
            observation_start = ?, observation_end = ?, updated_at = ?
      WHERE round_id = ? AND state = 'UNOPENED'`,
    input.targetTier,
    input.targetPriceUsdE8,
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
        (round_id, state, target_tier, target_price_usd_e8, reward_budget_raw, stake_open_at, stake_close_at,
         observation_start, observation_end, candles_seen, qualified_candles, total_accepted_stake_raw,
         total_weight_raw, candle_hash, staker_count, result, burned_raw, team_released_raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.round_id,
      row.state,
      row.target_tier,
      row.target_price_usd_e8,
      row.reward_budget_raw,
      row.stake_open_at,
      row.stake_close_at,
      row.observation_start,
      row.observation_end,
      row.candles_seen,
      row.qualified_candles,
      row.total_accepted_stake_raw,
      row.total_weight_raw,
      row.candle_hash,
      row.staker_count,
      row.result,
      row.burned_raw,
      row.team_released_raw ?? null,
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
    env.DB.prepare('DELETE FROM round_rewards'),
    env.DB.prepare('DELETE FROM refund_ledger'),
    env.DB.prepare('DELETE FROM rounds'),
    env.DB.prepare('DELETE FROM trades'),
    env.DB.prepare('DELETE FROM book_levels'),
  ]);
}

/* ------------------------------------------------------------------ *
 * 每轮奖励账本（round_rewards）：v10 只用 weight_raw（= 质押额）与 reward_raw（全额奖励）。
 * V8 的 state/paid/locked/rolled 列保留在库里，写入时固定为默认值。
 * ------------------------------------------------------------------ */

export interface RoundRewardRow {
  round_id: number;
  address: string;
  /** v10 = 本轮质押额 */
  weight_raw: string;
  /** floor(rewardBudget × stake / totalStake)（合约 rewardOf 同口径） */
  reward_raw: string;
  created_at: number;
  updated_at: number;
}

export async function listRoundRewards(env: Env, roundId: number): Promise<RoundRewardRow[]> {
  return all<RoundRewardRow>(env, 'SELECT * FROM round_rewards WHERE round_id = ? ORDER BY address ASC', roundId);
}

export async function listAllRoundRewards(env: Env): Promise<RoundRewardRow[]> {
  return all<RoundRewardRow>(env, 'SELECT * FROM round_rewards ORDER BY round_id ASC, address ASC');
}

export async function listRoundRewardsForAddress(env: Env, address: string): Promise<RoundRewardRow[]> {
  return all<RoundRewardRow>(env, 'SELECT * FROM round_rewards WHERE address = ? ORDER BY round_id ASC', address);
}

/** 结算时整轮重建（幂等；结算后 reward 金额不可变）。 */
export async function replaceRoundRewards(env: Env, roundId: number, rows: RoundRewardRow[]): Promise<void> {
  const statements = [env.DB.prepare('DELETE FROM round_rewards WHERE round_id = ?').bind(roundId)];
  for (const row of rows) {
    statements.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO round_rewards
           (round_id, address, weight_raw, reward_raw, state, paid_raw, locked_raw, rolled_raw, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, '0', '0', '0', ?, ?)`,
      ).bind(
        roundId,
        row.address,
        row.weight_raw,
        row.reward_raw,
        row.created_at,
        row.updated_at,
      ),
    );
  }
  await runBatches(env, statements);
}

/** 演示数据重建：整批写入每轮奖励。 */
export async function insertRoundRewardsBulk(env: Env, rows: RoundRewardRow[]): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO round_rewards
         (round_id, address, weight_raw, reward_raw, state, paid_raw, locked_raw, rolled_raw, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, '0', '0', '0', ?, ?)`,
    ).bind(
      row.round_id,
      row.address,
      row.weight_raw,
      row.reward_raw,
      row.created_at,
      row.updated_at,
    ),
  );
  await runBatches(env, statements);
}

/* ------------------------------------------------------------------ *
 * 轮次总权重（v10 = 总质押）/ K 线滚动哈希
 * ------------------------------------------------------------------ */

export async function updateRoundWeightHash(
  env: Env,
  roundId: number,
  totalWeightRaw: string,
  candleHash: string | null,
  now: number,
): Promise<void> {
  await run(
    env,
    'UPDATE rounds SET total_weight_raw = ?, candle_hash = ?, updated_at = ? WHERE round_id = ?',
    totalWeightRaw,
    candleHash,
    now,
    roundId,
  );
}

/* ------------------------------------------------------------------ *
 * 链上索引器配套（indexer-dev / task-39；签名以 indexer-dev 契约为准）
 * ------------------------------------------------------------------ */

/** 原子获取索引器租约（单写者）：value = now + ttl；value 仍大于 now 时抢不到。 */
export async function tryAcquireLease(
  env: Env,
  key: string,
  now: number,
  ttlMs = 120_000,
): Promise<boolean> {
  const expiresAt = now + ttlMs;
  const sql =
    'INSERT INTO metrics (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at ' +
    'WHERE CAST(metrics.value AS INTEGER) < ?';
  const changes = await run(env, sql, key, String(expiresAt), now, now);
  return changes > 0;
}

/** 释放租约（仅持有者调用；直接写 0）。 */
export async function releaseLease(env: Env, key: string, now: number): Promise<void> {
  await run(env, 'UPDATE metrics SET value = ?, updated_at = ? WHERE key = ?', '0', now, key);
}

/** 链上快照 → rounds 行的部分更新（chain 模式唯一写 rounds 的链上入口）。 */
export interface RoundChainPatch {
  state?: RoundStateName;
  target_tier?: number;
  target_price_usd_e8?: string;
  target_twap24h_usd_e8?: string | null;
  reward_budget_raw?: string;
  stake_open_at?: number | null;
  stake_close_at?: number | null;
  observation_start?: number | null;
  observation_end?: number | null;
  candles_seen?: number;
  qualified_candles?: number;
  total_accepted_stake_raw?: string;
  staker_count?: number;
  total_weight_raw?: string;
  candle_hash?: string | null;
  result?: 'SUCCESS' | 'FAILURE' | 'TECHNICAL_ABORT' | null;
  burned_raw?: string | null;
  team_released_raw?: string | null;
  chain_status?: number | null;
  last_candle_twap_usd_e8?: string | null;
  last_candle_at?: number | null;
}

export async function patchRoundChain(
  env: Env,
  roundId: number,
  patch: RoundChainPatch,
  now: number,
): Promise<number> {
  const sets: string[] = ['updated_at = ?'];
  const binds: Bind[] = [now];
  const add = (column: string, value: Bind): void => {
    sets.push(column + ' = ?');
    binds.push(value);
  };
  if (patch.state !== undefined) add('state', patch.state);
  if (patch.target_tier !== undefined) add('target_tier', patch.target_tier);
  if (patch.target_price_usd_e8 !== undefined) add('target_price_usd_e8', patch.target_price_usd_e8);
  if (patch.target_twap24h_usd_e8 !== undefined) add('target_twap24h_usd_e8', patch.target_twap24h_usd_e8);
  if (patch.reward_budget_raw !== undefined) add('reward_budget_raw', patch.reward_budget_raw);
  if (patch.stake_open_at !== undefined) add('stake_open_at', patch.stake_open_at);
  if (patch.stake_close_at !== undefined) add('stake_close_at', patch.stake_close_at);
  if (patch.observation_start !== undefined) add('observation_start', patch.observation_start);
  if (patch.observation_end !== undefined) add('observation_end', patch.observation_end);
  if (patch.candles_seen !== undefined) add('candles_seen', patch.candles_seen);
  if (patch.qualified_candles !== undefined) add('qualified_candles', patch.qualified_candles);
  if (patch.total_accepted_stake_raw !== undefined) add('total_accepted_stake_raw', patch.total_accepted_stake_raw);
  if (patch.staker_count !== undefined) add('staker_count', patch.staker_count);
  if (patch.total_weight_raw !== undefined) add('total_weight_raw', patch.total_weight_raw);
  if (patch.candle_hash !== undefined) add('candle_hash', patch.candle_hash);
  if (patch.result !== undefined) add('result', patch.result);
  if (patch.burned_raw !== undefined) add('burned_raw', patch.burned_raw);
  if (patch.team_released_raw !== undefined) add('team_released_raw', patch.team_released_raw);
  if (patch.chain_status !== undefined) add('chain_status', patch.chain_status);
  if (patch.last_candle_twap_usd_e8 !== undefined) add('last_candle_twap_usd_e8', patch.last_candle_twap_usd_e8);
  if (patch.last_candle_at !== undefined) add('last_candle_at', patch.last_candle_at);
  if (sets.length === 1) return 0;
  binds.push(roundId);
  return run(env, 'UPDATE rounds SET ' + sets.join(', ') + ' WHERE round_id = ?', ...binds);
}

/** 引导：为链上尚不存在的轮次插入 UNOPENED 行（必须 INSERT OR IGNORE，防 REPLACE 级联删子表）。 */
export interface RoundChainSeed {
  round_id: number;
  state: RoundStateName;
  target_price_usd_e8: string;
  reward_budget_raw: string;
  chain_status?: number | null;
  updated_at: number;
}

export async function ensureRoundRows(env: Env, rows: RoundChainSeed[]): Promise<void> {
  if (!rows.length) return;
  const sql =
    'INSERT OR IGNORE INTO rounds ' +
    '(round_id, state, target_price_usd_e8, reward_budget_raw, chain_status, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?)';
  const statements = rows.map((row) =>
    env.DB.prepare(sql).bind(
      row.round_id,
      row.state,
      row.target_price_usd_e8,
      row.reward_budget_raw,
      row.chain_status ?? null,
      row.updated_at,
    ),
  );
  await runBatches(env, statements);
}

/** 销毁三态（dispatched = confirmed:0 → confirmed:1）；只允许 0→1，单调不可回退。 */
export interface BurnLedgerUpsert {
  roundId: number;
  kind: 'reward' | 'principal' | 'team';
  amountRaw: string;
  burnRef: string;
  confirmed: boolean;
  txHash?: string | null;
  now: number;
}

export async function upsertBurnLedger(env: Env, input: BurnLedgerUpsert): Promise<boolean> {
  const sql =
    'INSERT INTO burn_ledger ' +
    '(round_id, kind, amount_raw, burn_ref, confirmed, created_at, confirmed_at, chain_tx_hash) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(burn_ref) DO UPDATE SET ' +
    'confirmed = excluded.confirmed, confirmed_at = excluded.confirmed_at, ' +
    'chain_tx_hash = excluded.chain_tx_hash ' +
    'WHERE burn_ledger.confirmed < excluded.confirmed';
  const changes = await run(
    env,
    sql,
    input.roundId,
    input.kind,
    input.amountRaw,
    input.burnRef,
    input.confirmed ? 1 : 0,
    input.now,
    input.confirmed ? input.now : null,
    input.txHash ?? null,
  );
  return changes > 0;
}

/** 兼容 task-42 最小约定：按 burn_ref 确认销毁（等价于 upsertBurnLedger confirmed=true）。 */
export async function updateBurnConfirmed(
  env: Env,
  input: { burnRef: string; chainTxHash: string; now: number },
): Promise<boolean> {
  const changes = await run(
    env,
    'UPDATE burn_ledger SET confirmed = 1, chain_tx_hash = ?, confirmed_at = ? WHERE burn_ref = ? AND confirmed = 0',
    input.chainTxHash,
    input.now,
    input.burnRef,
  );
  return changes > 0;
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

/** 一次查询取出全部质押。 */
export async function listAllStakes(env: Env): Promise<StakeRow[]> {
  return all<StakeRow>(env, 'SELECT * FROM stakes');
}

export function buildStakeAggregates(rows: StakeAggregateInputRow[] | StakeRow[]): StakeAggregates {
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
  /** 缺省 deposit；一键续战（DepositAccepted 同交易含 Restaked）传 restake */
  source?: 'deposit' | 'restake';
}

/** 返回 false 表示 nonce 重复（幂等拒绝）。 */
export async function insertStake(env: Env, input: StakeInsertInput): Promise<boolean> {
  const changes = await run(
    env,
    `INSERT OR IGNORE INTO stakes
       (round_id, address, amount_raw, weight_raw, nonce, risk_disclosure_version,
        accept_full_principal_burn, principal_claimed, reward_claimed, accepted_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    input.roundId,
    input.address,
    input.amountRaw.toString(),
    input.weightRaw.toString(),
    input.nonce,
    input.riskDisclosureVersion,
    input.acceptFullPrincipalBurn ? 1 : 0,
    input.acceptedAt,
    input.source ?? 'deposit',
  );
  return changes > 0;
}

/** 按 (round, address) 标记本金 / 奖励已领取（幂等：只会 0→1）。 */
export async function markStakesClaimed(
  env: Env,
  roundId: number,
  address: string,
  flags: { principal: boolean; reward: boolean },
): Promise<void> {
  await run(
    env,
    `UPDATE stakes SET
       principal_claimed = CASE WHEN ? = 1 THEN 1 ELSE principal_claimed END,
       reward_claimed = CASE WHEN ? = 1 THEN 1 ELSE reward_claimed END
     WHERE round_id = ? AND address = ?`,
    flags.principal ? 1 : 0,
    flags.reward ? 1 : 0,
    roundId,
    address,
  );
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

/** v11 领取流水（migrations/0012）：事件 → 按 (round, address) 聚合成 principal / reward 两行（金额 BigInt 相加，不用 SQL SUM）。 */
interface ClaimEventRow {
  tx_lt: string;
  address: string;
  round_id: number;
  principal_raw: string;
  reward_raw: string;
  claimed_at: number;
}

function aggregateClaimEvents(rows: ClaimEventRow[]): ClaimRow[] {
  const totals = new Map<string, { roundId: number; address: string; principal: bigint; reward: bigint; claimedAt: number }>();
  for (const row of rows) {
    const key = row.round_id + '|' + row.address;
    const entry = totals.get(key) ?? { roundId: row.round_id, address: row.address, principal: 0n, reward: 0n, claimedAt: 0 };
    entry.principal += toBigInt(row.principal_raw);
    entry.reward += toBigInt(row.reward_raw);
    entry.claimedAt = Math.max(entry.claimedAt, row.claimed_at);
    totals.set(key, entry);
  }
  const out: ClaimRow[] = [];
  for (const entry of totals.values()) {
    if (entry.principal > 0n) out.push({ id: 0, round_id: entry.roundId, address: entry.address, kind: 'principal', amount_raw: entry.principal.toString(), claimed_at: entry.claimedAt });
    if (entry.reward > 0n) out.push({ id: 0, round_id: entry.roundId, address: entry.address, kind: 'reward', amount_raw: entry.reward.toString(), claimed_at: entry.claimedAt });
  }
  return out.sort((a, b) => a.round_id - b.round_id || a.address.localeCompare(b.address) || a.kind.localeCompare(b.kind));
}

export async function listAllClaims(env: Env): Promise<ClaimRow[]> {
  const legacy = await all<ClaimRow>(env, 'SELECT * FROM claims ORDER BY round_id ASC, address ASC, kind ASC');
  const events = await all<ClaimEventRow>(env, 'SELECT tx_lt, address, round_id, principal_raw, reward_raw, claimed_at FROM claim_events');
  return [...legacy, ...aggregateClaimEvents(events)];
}

export async function listClaimsForAddress(env: Env, address: string): Promise<ClaimRow[]> {
  const legacy = await all<ClaimRow>(env, 'SELECT * FROM claims WHERE address = ? ORDER BY round_id ASC, kind ASC', address);
  const events = await all<ClaimEventRow>(
    env,
    'SELECT tx_lt, address, round_id, principal_raw, reward_raw, claimed_at FROM claim_events WHERE address = ?',
    address,
  );
  return [...legacy, ...aggregateClaimEvents(events)];
}

/**
 * 记录一笔 v11 Claimed 事件（幂等键 tx_lt+address+round）。返回 false = 已记录过（重放）。
 * 同一笔交易的重放不会二次累加；聚合在读取时完成。
 */
export async function recordClaimEvent(
  env: Env,
  input: { txLt: string; roundId: number; address: string; principalRaw: bigint; rewardRaw: bigint; claimedAt: number },
): Promise<boolean> {
  const changes = await run(
    env,
    'INSERT OR IGNORE INTO claim_events (tx_lt, address, round_id, principal_raw, reward_raw, claimed_at) VALUES (?, ?, ?, ?, ?, ?)',
    input.txLt,
    input.address,
    input.roundId,
    input.principalRaw.toString(),
    input.rewardRaw.toString(),
    input.claimedAt,
  );
  return changes > 0;
}

export async function getClaim(
  env: Env,
  roundId: number,
  address: string,
  kind: 'principal' | 'reward',
): Promise<ClaimRow | null> {
  return first<ClaimRow>(env, 'SELECT * FROM claims WHERE round_id = ? AND address = ? AND kind = ?', roundId, address, kind);
}

/**
 * 记录一轮领取（v10 Claim：本金 + 全额奖励一次领完）。
 * claims 唯一键 (round, address, kind) 兜底幂等：principal 行已存在则返回 false。
 * rewardRaw 为 0（技术终止轮）时不写 reward 行。
 */
export async function recordRoundClaim(
  env: Env,
  input: { roundId: number; address: string; principalRaw: bigint; rewardRaw: bigint; claimedAt: number },
): Promise<boolean> {
  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO claims (round_id, address, kind, amount_raw, claimed_at)
       VALUES (?, ?, 'principal', ?, ?)`,
    ).bind(input.roundId, input.address, input.principalRaw.toString(), input.claimedAt),
  ];
  if (input.rewardRaw > 0n) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO claims (round_id, address, kind, amount_raw, claimed_at)
         VALUES (?, ?, 'reward', ?, ?)`,
      ).bind(input.roundId, input.address, input.rewardRaw.toString(), input.claimedAt),
    );
  }
  statements.push(
    env.DB.prepare('UPDATE stakes SET principal_claimed = 1, reward_claimed = 1 WHERE round_id = ? AND address = ?').bind(
      input.roundId,
      input.address,
    ),
  );
  const results = await env.DB.batch(statements);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

/* ------------------------------------------------------------------ *
 * 退款账本（v10 合约 round 0；migrations/0010）
 * ------------------------------------------------------------------ */

export type RefundKind = 'credit' | 'instant' | 'dust' | 'claim';

export interface RefundLedgerRow {
  tx_lt: string;
  address: string;
  kind: RefundKind;
  amount_raw: string;
  created_at: number;
}

export async function listRefundEntries(env: Env, address?: string): Promise<RefundLedgerRow[]> {
  if (address) {
    return all<RefundLedgerRow>(env, 'SELECT * FROM refund_ledger WHERE address = ? ORDER BY created_at ASC, tx_lt ASC', address);
  }
  return all<RefundLedgerRow>(env, 'SELECT * FROM refund_ledger ORDER BY created_at ASC, tx_lt ASC');
}

/** 幂等写入（主键 tx_lt+address+kind）；返回实际新增行数。 */
export async function insertRefundEntry(env: Env, row: RefundLedgerRow): Promise<boolean> {
  const changes = await run(
    env,
    'INSERT OR IGNORE INTO refund_ledger (tx_lt, address, kind, amount_raw, created_at) VALUES (?, ?, ?, ?, ?)',
    row.tx_lt,
    row.address,
    row.kind,
    row.amount_raw,
    row.created_at,
  );
  return changes > 0;
}

export interface RefundBalance {
  pending: bigint;
  credited: bigint;
  claimed: bigint;
  instant: bigint;
  dust: bigint;
}

/** 账本余额 = Σcredit − Σclaim（合约领取时整条删除，所以 claim 金额 = 领取前余额）。 */
export function refundBalance(rows: RefundLedgerRow[]): RefundBalance {
  const out: RefundBalance = { pending: 0n, credited: 0n, claimed: 0n, instant: 0n, dust: 0n };
  for (const row of rows) {
    const amount = toBigInt(row.amount_raw);
    if (row.kind === 'credit') out.credited += amount;
    else if (row.kind === 'claim') out.claimed += amount;
    else if (row.kind === 'instant') out.instant += amount;
    else out.dust += amount;
  }
  out.pending = out.credited > out.claimed ? out.credited - out.claimed : 0n;
  return out;
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

/* ------------------------------------------------------------------ *
 * 安全：一次性 nonce / 地址↔公钥绑定 / 最简限流（migration 0007）
 * ------------------------------------------------------------------ */

export interface AuthNonceRow {
  nonce: string;
  address: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export async function insertAuthNonce(
  env: Env,
  input: { nonce: string; address: string; createdAt: number; expiresAt: number },
): Promise<void> {
  await run(
    env,
    'INSERT OR REPLACE INTO auth_nonces (nonce, address, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)',
    input.nonce,
    input.address,
    input.createdAt,
    input.expiresAt,
  );
}

/** 不绑定地址的 nonce（登录挑战 GET /api/auth/challenge）存放的占位 address；用户地址不可能是 '*'。 */
export const AUTH_NONCE_ANY_ADDRESS = '*';

/**
 * 原子消费一次性 nonce：仅当存在、未用、未过期且 address 匹配时成功。
 * 地址绑定的 nonce 只能被同一地址消费；存为 AUTH_NONCE_ANY_ADDRESS 的 nonce 可被任意地址消费一次。
 */
export async function consumeAuthNonce(
  env: Env,
  input: { nonce: string; address: string; now: number },
): Promise<boolean> {
  const changes = await run(
    env,
    'UPDATE auth_nonces SET used_at = ? WHERE nonce = ? AND (address = ? OR address = ?) AND used_at IS NULL AND expires_at > ?',
    input.now,
    input.nonce,
    input.address,
    AUTH_NONCE_ANY_ADDRESS,
    input.now,
  );
  return changes > 0;
}

export async function pruneAuthNonces(env: Env, before: number): Promise<void> {
  await run(env, 'DELETE FROM auth_nonces WHERE expires_at < ?', before);
}

export interface WalletBindingRow {
  address: string;
  public_key: string;
  bound_at: number;
}

export async function getWalletBinding(env: Env, address: string): Promise<WalletBindingRow | null> {
  return first<WalletBindingRow>(env, 'SELECT * FROM wallet_bindings WHERE address = ?', address);
}

/** 首次验签通过后绑定；同一公钥只能绑定一个地址（UNIQUE 冲突返回 false）。 */
export async function insertWalletBinding(
  env: Env,
  input: { address: string; publicKey: string; now: number },
): Promise<boolean> {
  const changes = await run(
    env,
    'INSERT OR IGNORE INTO wallet_bindings (address, public_key, bound_at) VALUES (?, ?, ?)',
    input.address,
    input.publicKey,
    input.now,
  );
  return changes > 0;
}

export interface RateLimitResult {
  limited: boolean;
  count: number;
}

/**
 * 最简限流：key = ip|path|minuteBucket。D1 原子 upsert + RETURNING count。
 * 仅用于 /api/admin/*、/api/stake、/api/claim。
 */
export async function hitRateLimit(
  env: Env,
  input: { key: string; now: number; limit: number; windowMs?: number },
): Promise<RateLimitResult> {
  const windowMs = input.windowMs && input.windowMs > 0 ? input.windowMs : 60_000;
  const bucket = Math.floor(input.now / windowMs) * windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limit (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limit.window_start = excluded.window_start THEN rate_limit.count + 1 ELSE 1 END,
       window_start = CASE WHEN rate_limit.window_start = excluded.window_start THEN rate_limit.window_start ELSE excluded.window_start END
     RETURNING count`,
  )
    .bind(input.key + '|' + bucket, bucket)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return { limited: count > input.limit, count };
}

export async function pruneRateLimit(env: Env, before: number): Promise<void> {
  await run(env, 'DELETE FROM rate_limit WHERE window_start < ?', before);
}