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
  /** V8：Σ(own weight + 邀请加成) */
  total_weight_raw: string;
  /** V8：K 线滚动哈希（链上只存此值） */
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
  /** V8 own weight（含 streak 加成，不含邀请加成） */
  weight_raw: string;
  nonce: string;
  risk_disclosure_version: number;
  accept_full_principal_burn: number;
  /** V8 连续参与轮次（入账时判定） */
  streak: number;
  /** V8 奖励三态：0 PENDING / 1 ROLLED / 2 EARLY（按轮聚合同值） */
  reward_state: number;
  /** V8 绑定邀请人快照（入账时） */
  referred_by: string | null;
  principal_claimed: number;
  reward_claimed: number;
  accepted_at: number;
}

export interface ClaimRow {
  id: number;
  round_id: number;
  address: string;
  kind: 'principal' | 'reward' | 'unlock';
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
         total_weight_raw, candle_hash, staker_count, result, burned_raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  /** V8 连续轮次（入账时判定） */
  streak: number;
  /** V8 邀请人快照 */
  referred_by: string | null;
  /** V8 奖励三态 */
  reward_state: number;
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
         accept_full_principal_burn, streak, reward_state, referred_by,
         principal_claimed, reward_claimed, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.round_id,
      row.address,
      row.amount_raw,
      row.weight_raw,
      row.nonce,
      row.risk_disclosure_version,
      row.streak,
      row.reward_state,
      row.referred_by,
      row.principal_claimed,
      row.reward_claimed,
      row.accepted_at,
    ),
  );
  await runBatches(env, statements);
}

export async function insertClaimsBulk(
  env: Env,
  rows: { round_id: number; address: string; kind: 'principal' | 'reward' | 'unlock'; amount_raw: string; claimed_at: number }[],
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
    env.DB.prepare('DELETE FROM referrals'),
    env.DB.prepare('DELETE FROM rounds'),
    env.DB.prepare('DELETE FROM trades'),
    env.DB.prepare('DELETE FROM book_levels'),
    env.DB.prepare("INSERT OR REPLACE INTO unlock_pool (id, start_at, total_locked_raw, claimed_raw, updated_at) VALUES (1, 0, '0', '0', 0)"),
  ]);
}

/* ------------------------------------------------------------------ *
 * V8：每轮奖励三态（round_rewards）
 * ------------------------------------------------------------------ */

export interface RoundRewardRow {
  round_id: number;
  address: string;
  /** own weight + 邀请加成（对齐合约 get_user_weight） */
  weight_raw: string;
  /** floor(rewardBudget × weight / totalWeight) */
  reward_raw: string;
  /** 0 PENDING / 1 ROLLED / 2 EARLY */
  state: number;
  paid_raw: string;
  locked_raw: string;
  rolled_raw: string;
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        roundId,
        row.address,
        row.weight_raw,
        row.reward_raw,
        row.state,
        row.paid_raw,
        row.locked_raw,
        row.rolled_raw,
        row.created_at,
        row.updated_at,
      ),
    );
  }
  await runBatches(env, statements);
}

export async function updateRoundReward(
  env: Env,
  input: { roundId: number; address: string; state?: number; paidRaw?: string; lockedRaw?: string; rolledRaw?: string; now: number },
): Promise<void> {
  const sets: string[] = ['updated_at = ?'];
  const binds: Bind[] = [input.now];
  if (input.state !== undefined) {
    sets.push('state = ?');
    binds.push(input.state);
  }
  if (input.paidRaw !== undefined) {
    sets.push('paid_raw = ?');
    binds.push(input.paidRaw);
  }
  if (input.lockedRaw !== undefined) {
    sets.push('locked_raw = ?');
    binds.push(input.lockedRaw);
  }
  if (input.rolledRaw !== undefined) {
    sets.push('rolled_raw = ?');
    binds.push(input.rolledRaw);
  }
  binds.push(input.roundId, input.address);
  await run(env, `UPDATE round_rewards SET ${sets.join(', ')} WHERE round_id = ? AND address = ?`, ...binds);
}

/** 演示数据重建：整批写入每轮奖励三态。 */
export async function insertRoundRewardsBulk(env: Env, rows: RoundRewardRow[]): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO round_rewards
         (round_id, address, weight_raw, reward_raw, state, paid_raw, locked_raw, rolled_raw, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.round_id,
      row.address,
      row.weight_raw,
      row.reward_raw,
      row.state,
      row.paid_raw,
      row.locked_raw,
      row.rolled_raw,
      row.created_at,
      row.updated_at,
    ),
  );
  await runBatches(env, statements);
}

/* ------------------------------------------------------------------ *
 * V8：邀请关系（一层、一次性绑定，对齐合约 extras.referrer）
 * ------------------------------------------------------------------ */

export interface ReferralRow {
  address: string;
  referrer: string;
  created_at: number;
}

export async function listReferrals(env: Env): Promise<ReferralRow[]> {
  return all<ReferralRow>(env, 'SELECT * FROM referrals ORDER BY created_at ASC');
}

export async function getReferralOf(env: Env, address: string): Promise<ReferralRow | null> {
  return first<ReferralRow>(env, 'SELECT * FROM referrals WHERE address = ?', address);
}

export async function listInvitees(env: Env, referrer: string): Promise<ReferralRow[]> {
  return all<ReferralRow>(env, 'SELECT * FROM referrals WHERE referrer = ? ORDER BY created_at ASC', referrer);
}

export async function insertReferralsBulk(env: Env, rows: ReferralRow[]): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map((row) =>
    env.DB.prepare('INSERT OR REPLACE INTO referrals (address, referrer, created_at) VALUES (?, ?, ?)').bind(
      row.address,
      row.referrer,
      row.created_at,
    ),
  );
  await runBatches(env, statements);
}

/** 返回 false 表示已绑定/非法（幂等拒绝）；调用方负责自邀/互绑校验。 */
export async function insertReferral(env: Env, address: string, referrer: string, now: number): Promise<boolean> {
  const changes = await run(
    env,
    'INSERT OR IGNORE INTO referrals (address, referrer, created_at) VALUES (?, ?, ?)',
    address,
    referrer,
    now,
  );
  return changes > 0;
}

/* ------------------------------------------------------------------ *
 * V8：R10 后线性解锁池（单例）
 * ------------------------------------------------------------------ */

export interface UnlockPoolRow {
  id: number;
  start_at: number;
  total_locked_raw: string;
  claimed_raw: string;
  updated_at: number;
}

export async function getUnlockPool(env: Env): Promise<UnlockPoolRow> {
  const row = await first<UnlockPoolRow>(env, 'SELECT * FROM unlock_pool WHERE id = 1');
  return row ?? { id: 1, start_at: 0, total_locked_raw: '0', claimed_raw: '0', updated_at: 0 };
}

export async function updateUnlockPool(
  env: Env,
  patch: { startAt?: number; totalLockedRaw?: string; claimedRaw?: string },
  now: number,
): Promise<void> {
  const sets: string[] = ['updated_at = ?'];
  const binds: Bind[] = [now];
  if (patch.startAt !== undefined) {
    sets.push('start_at = ?');
    binds.push(patch.startAt);
  }
  if (patch.totalLockedRaw !== undefined) {
    sets.push('total_locked_raw = ?');
    binds.push(patch.totalLockedRaw);
  }
  if (patch.claimedRaw !== undefined) {
    sets.push('claimed_raw = ?');
    binds.push(patch.claimedRaw);
  }
  await run(env, `UPDATE unlock_pool SET ${sets.join(', ')} WHERE id = 1`, ...binds);
}

/** 演示数据重建：写入解锁池单例行。 */
export async function setUnlockPool(
  env: Env,
  row: { startAt: number; totalLockedRaw: string; claimedRaw: string },
  now: number,
): Promise<void> {
  await run(
    env,
    'INSERT OR REPLACE INTO unlock_pool (id, start_at, total_locked_raw, claimed_raw, updated_at) VALUES (1, ?, ?, ?, ?)',
    row.startAt,
    row.totalLockedRaw,
    row.claimedRaw,
    now,
  );
}

/* ------------------------------------------------------------------ *
 * V8：轮次总权重 / K 线滚动哈希
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

/** 一次查询取出全部质押（V8 需要 weight/streak/referred_by 全字段）。 */
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
  /** V8 连续轮次（入账时按 lastRound/count 推导） */
  streak: number;
  /** V8 邀请人快照 */
  referredBy: string | null;
}

/** 返回 false 表示 nonce 重复（幂等拒绝）。 */
export async function insertStake(env: Env, input: StakeInsertInput): Promise<boolean> {
  const changes = await run(
    env,
    `INSERT OR IGNORE INTO stakes
       (round_id, address, amount_raw, weight_raw, nonce, risk_disclosure_version,
        accept_full_principal_burn, streak, reward_state, referred_by,
        principal_claimed, reward_claimed, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?)`,
    input.roundId,
    input.address,
    input.amountRaw.toString(),
    input.weightRaw.toString(),
    input.nonce,
    input.riskDisclosureVersion,
    input.acceptFullPrincipalBurn ? 1 : 0,
    input.streak,
    input.referredBy,
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

export async function getClaim(
  env: Env,
  roundId: number,
  address: string,
  kind: 'principal' | 'reward' | 'unlock',
): Promise<ClaimRow | null> {
  return first<ClaimRow>(env, 'SELECT * FROM claims WHERE round_id = ? AND address = ? AND kind = ?', roundId, address, kind);
}

/** 幂等领取：claims 唯一键兜底，并同步 stake 的领取标记。 */
export async function recordClaim(
  env: Env,
  input: { roundId: number; address: string; kind: 'principal' | 'reward' | 'unlock'; amountRaw: bigint; claimedAt: number },
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

/** 原子消费一次性 nonce：仅当存在、未用、未过期且 address 匹配时成功。 */
export async function consumeAuthNonce(
  env: Env,
  input: { nonce: string; address: string; now: number },
): Promise<boolean> {
  const changes = await run(
    env,
    'UPDATE auth_nonces SET used_at = ? WHERE nonce = ? AND address = ? AND used_at IS NULL AND expires_at > ?',
    input.now,
    input.nonce,
    input.address,
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