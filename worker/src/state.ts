/**
 * 轮次状态机与演示推进（永不依赖「读的时候刚好有请求」——cron 与 admin tick 都能独立推进）。
 *
 * 关键不可变语义（docs/02、docs/09 §6）：
 *  - UNOPENED → STAKING_OPEN → STAKING_CLOSED → OBSERVING → SETTLING_* → SUCCEEDED / FAILED_PERMANENT
 *  - ORACLE_PAUSED 不推进 K 线、不销毁本金、不判失败；恢复后重启完整 12 根窗口。
 *  - 12 根满后 qualified >= 8 才成功；否则两笔销毁（reward 7.5e8 + 本轮全部本金）且不可逆。
 *  - 所有推进都用 CAS（UPDATE ... WHERE state = 期望值）+ INSERT OR IGNORE，cron 与手动 tick 并发安全。
 *  - 轮次聚合（总质押 / 地址数 / 每地址明细）只从 stakes 表派生，一次查询聚合，四处接口共用。
 */
import type { Env } from './env';
import {
  CANDLE_COUNT,
  DEFAULT_DEMO_CANDLE_SECONDS,
  MIN_QUALIFIED_CANDLES,
  P0_USD_E8,
  ROUND_REWARD_RAW,
  STAKE_DURATION_SECONDS,
  STAKE_GAP_SECONDS,
  TEAM_ROUND_RAW,
  TOTAL_SUPPLY_RAW,
  RISK_DISCLOSURE_VERSION,
  CANDLE_SECONDS,
  isTerminal,
  targetPriceFor,
  type Params,
} from './protocol';
import * as store from './store';
import type { CandleRow, RoundRow, StakeAggregates } from './store';
import { getSource, type MarketSource } from './sources';
import { resetDemoData } from './demo-cycle';
import { ApiError, conflict } from './http';
import { ceilTo, clampInt, toBigInt } from './util';

export interface ReconcileResult {
  params: Params;
  kv: Map<string, string>;
  rounds: RoundRow[];
  /** 每轮质押聚合（总质押 / 去重地址数 / 地址明细）：所有接口的唯一事实源 */
  stakeAgg: StakeAggregates;
  /** 已落库 K 线（按轮分组），一次查询加载 */
  candlesByRound: Map<number, CandleRow[]>;
  now: number;
  changed: boolean;
}

function numberFrom(kv: Map<string, string>, key: string, fallback: number): number {
  const raw = kv.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bigintFrom(kv: Map<string, string>, key: string, fallback: bigint): bigint {
  const raw = kv.get(key);
  if (raw === undefined || raw === '') return fallback;
  const value = toBigInt(raw);
  return value > 0n ? value : fallback;
}

function stringFrom(kv: Map<string, string>, key: string, fallback: string): string {
  const raw = kv.get(key);
  return raw && raw.length ? raw : fallback;
}

function groupCandles(rows: CandleRow[]): Map<number, CandleRow[]> {
  const map = new Map<number, CandleRow[]>();
  for (const row of rows) {
    const list = map.get(row.round_id);
    if (list) list.push(row);
    else map.set(row.round_id, [row]);
  }
  for (const list of map.values()) list.sort((a, b) => a.candle_index - b.candle_index);
  return map;
}

/** 合并 env（部署变量）+ config/metrics（D1）成运行时参数快照。 */
export function buildParams(env: Env, now: number, kv: Map<string, string>): Params {
  const envSource = (env.DATA_SOURCE ?? '').trim();
  const dataSource: 'demo' | 'chain' =
    envSource === 'chain' || (envSource !== 'demo' && kv.get('data_source') === 'chain') ? 'chain' : 'demo';

  const candleSeconds = numberFrom(kv, 'candle_seconds', CANDLE_SECONDS);
  const demoCandleSeconds = clampInt(
    Number(env.DEMO_CANDLE_SECONDS ?? kv.get('demo_candle_seconds') ?? DEFAULT_DEMO_CANDLE_SECONDS),
    1,
    86_400,
  );
  const candleMs = dataSource === 'demo' ? demoCandleSeconds * 1000 : candleSeconds * 1000;
  const networkValue = stringFrom(kv, 'network', dataSource === 'demo' ? 'demo' : 'testnet');

  return {
    tokenName: stringFrom(kv, 'token_name', 'A9'),
    tokenSymbol: stringFrom(kv, 'token_symbol', 'A9'),
    tokenDecimals: numberFrom(kv, 'token_decimals', 9),
    p0UsdE8: bigintFrom(kv, 'p0_usd_e8', P0_USD_E8),
    usdPriceScale: 100_000_000,
    priceMultiplier: numberFrom(kv, 'price_multiplier', 2),
    roundCount: numberFrom(kv, 'round_count', 10),
    roundRewardRaw: bigintFrom(kv, 'round_reward_raw', ROUND_REWARD_RAW),
    totalSupplyRaw: bigintFrom(kv, 'total_supply_raw', TOTAL_SUPPLY_RAW),
    candleSeconds,
    candleCount: numberFrom(kv, 'candle_count', CANDLE_COUNT),
    minQualifiedCandles: numberFrom(kv, 'min_qualified_candles', MIN_QUALIFIED_CANDLES),
    riskDisclosureVersion: numberFrom(kv, 'risk_disclosure_version', RISK_DISCLOSURE_VERSION),
    stakeDurationSeconds: numberFrom(kv, 'stake_duration_seconds', STAKE_DURATION_SECONDS),
    stakeGapSeconds: numberFrom(kv, 'stake_gap_seconds', STAKE_GAP_SECONDS),
    teamRoundRaw: bigintFrom(kv, 'team_round_raw', TEAM_ROUND_RAW),
    observationSeconds: numberFrom(kv, 'observation_seconds', candleSeconds * CANDLE_COUNT),
    dataSource,
    network: networkValue === 'mainnet' ? 'mainnet' : networkValue === 'demo' ? 'demo' : 'testnet',
    demoCandleSeconds,
    candleMs,
    demoEpochMs: numberFrom(kv, 'demo_epoch_ms', now),
    tonUsdE8: stringFrom(kv, 'ton_usd_e8', '300000000'),
    tonConnectManifestUrl: (env.TONCONNECT_MANIFEST_URL ?? stringFrom(kv, 'tonconnect_manifest_url', '')).trim() || null,
    paused: kv.get('oracle_paused') === '1',
    demoWalletBalanceRaw: toBigInt(env.DEMO_WALLET_BALANCE ?? kv.get('demo_wallet_balance') ?? '250000000000000'),
    autoplay: parseAutoplay(env, kv) && dataSource === 'demo',
    demoStakeSeconds: clampInt(
      Number(env.DEMO_STAKE_SECONDS ?? kv.get('demo_stake_seconds') ?? 900),
      30,
      86_400,
    ),
    now,
  };
}

/** DEMO_AUTOPLAY 开关：env 优先，其次 D1 config；默认开启，仅 demo 数据源生效。 */
function parseAutoplay(env: Env, kv: Map<string, string>): boolean {
  const raw = (env.DEMO_AUTOPLAY ?? kv.get('demo_autoplay') ?? 'true').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

/** 单次请求的完整状态快照：kv(1) + rounds(1) + stakes(1) + candles(1) = 4 次 D1 读取，无 N+1。 */
export async function loadState(env: Env, now = Date.now()): Promise<ReconcileResult> {
  const [kv, rounds, stakeRows, candleRows] = await Promise.all([
    store.getKeyValues(env),
    store.listRounds(env),
    store.listAllStakes(env),
    store.listCandlesAll(env),
  ]);
  const params = buildParams(env, now, kv);
  return {
    params,
    kv,
    rounds,
    stakeAgg: store.buildStakeAggregates(stakeRows),
    candlesByRound: groupCandles(candleRows),
    now,
    changed: false,
  };
}

function closedCandleCount(params: Params, round: RoundRow, now: number): number {
  const start = round.observation_start;
  if (start === null || start === undefined) return 0;
  if (now < start) return 0;
  const elapsed = now - start;
  return clampInt(Math.floor(elapsed / Math.max(1, params.candleMs)), 0, params.candleCount);
}

/** 把已经走完的 K 线幂等落库；chain 模式下只统计 indexer 已同步的记录。 */
async function syncRoundCandles(
  env: Env,
  params: Params,
  source: MarketSource,
  round: RoundRow,
  now: number,
  existing: CandleRow[],
): Promise<{ seen: number; qualified: number; inserted: number }> {
  let seen = existing.length;
  let qualified = existing.reduce((sum, row) => sum + (row.qualified === 1 ? 1 : 0), 0);

  const pausedActive = params.paused && !isTerminal(round.state);
  const due = closedCandleCount(params, round, now);
  let inserted = 0;

  if (source.derivesCandles && !pausedActive && due > existing.length) {
    const have = new Set(existing.map((row) => row.candle_index));
    const missing: CandleRow[] = [];
    for (let index = 0; index < due; index++) {
      if (have.has(index)) continue;
      const row = source.buildCandle(params, round, index);
      missing.push(row);
      existing.push(row);
      if (row.qualified === 1) qualified++;
      seen++;
    }
    if (missing.length) {
      await store.insertCandles(env, missing);
      existing.sort((a, b) => a.candle_index - b.candle_index);
      inserted = missing.length;
    }
  }

  return { seen: Math.min(seen, params.candleCount), qualified, inserted };
}

/** 成功结算：SETTLING_SUCCESS → SUCCEEDED（本金与奖励转为可领取）。 */
async function settleSuccess(env: Env, params: Params, round: RoundRow, now: number): Promise<boolean> {
  const moved = await store.casRoundState(env, round.round_id, 'OBSERVING', 'SETTLING_SUCCESS', now);
  if (!moved) return false;
  await store.logEvent(
    env,
    'info',
    'system',
    'SETTLING_SUCCESS',
    `R${round.round_id} 12/12 根完成，${round.qualified_candles} 根达标（阈值 ${params.minQualifiedCandles}），进入成功结算`,
  );
  const done = await store.finalizeSuccess(env, {
    roundId: round.round_id,
    now,
    candlesSeen: round.candles_seen,
    qualifiedCandles: round.qualified_candles,
  });
  if (done) {
    await store.logEvent(
      env,
      'info',
      'system',
      'ROUND_SUCCEEDED',
      `R${round.round_id} SUCCEEDED：本金不销毁，${params.roundRewardRaw.toString()} raw 奖励开放领取；团队轮次额度 ${params.teamRoundRaw.toString()} raw 已释放`,
    );
    round.state = 'SUCCEEDED';
    round.result = 'SUCCESS';
    round.burned_raw = null;
    round.updated_at = now;
    // D-18b：0 人质押且本轮通过 → 本轮奖励无接收人，直接销毁（不回流、不留存）
    const staked = toBigInt(round.total_accepted_stake_raw);
    if (staked === 0n) {
      await store.recordNoStakerRewardBurn(env, round.round_id, params.roundRewardRaw.toString(), now);
      round.burned_raw = params.roundRewardRaw.toString();
      await store.logEvent(
        env,
        'warn',
        'system',
        'REWARD_BURNED_NO_STAKER',
        `R${round.round_id} 0 人质押且本轮达标：本轮奖励 ${params.roundRewardRaw.toString()} raw 无接收人，已销毁（D-18b）`,
      );
    }
  }
  return done;
}

/** 失败结算：两笔销毁写入 burn_ledger 后 → FAILED_PERMANENT（不可逆，不得重开/补发）。 */
async function settleFailure(env: Env, params: Params, round: RoundRow, now: number): Promise<boolean> {
  const moved = await store.casRoundState(env, round.round_id, 'OBSERVING', 'SETTLING_FAILURE', now);
  if (!moved) return false;
  const principal = toBigInt(round.total_accepted_stake_raw);
  const reward = params.roundRewardRaw;
  const team = params.teamRoundRaw;
  const burned = reward + team + principal;
  await store.logEvent(
    env,
    'warn',
    'system',
    'SETTLING_FAILURE',
    `R${round.round_id} 12/12 根完成，仅 ${round.qualified_candles} 根达标（阈值 ${params.minQualifiedCandles}），进入失败结算`,
  );
  const done = await store.finalizeFailure(env, {
    roundId: round.round_id,
    now,
    candlesSeen: round.candles_seen,
    qualifiedCandles: round.qualified_candles,
    rewardBurnRaw: reward.toString(),
    teamBurnRaw: team.toString(),
    principalBurnRaw: principal.toString(),
    burnedRaw: burned.toString(),
  });
  if (done) {
    await store.logEvent(
      env,
      'error',
      'system',
      'ROUND_FAILED_PERMANENT',
      `R${round.round_id} FAILED_PERMANENT：销毁奖励 ${reward.toString()} + 团队轮次额度 ${team.toString()} + 质押本金 ${principal.toString()} = ${burned.toString()} raw，永久关闭`,
    );
    await store.logEvent(
      env,
      'warn',
      'system',
      'BURN_CONFIRMED',
      `R${round.round_id} burnId R${round.round_id}:reward / :team / :principal 已确认（demo 模拟 JetMaster burn ack）`,
    );
    round.state = 'FAILED_PERMANENT';
    round.result = 'FAILURE';
    round.burned_raw = burned.toString();
    round.updated_at = now;
  }
  return done;
}

/** 状态机主循环：cron / admin tick / 每个 API 请求都会调用，幂等。 */
export async function reconcile(env: Env, now = Date.now()): Promise<ReconcileResult> {
  const state = await loadState(env, now);
  const { params, rounds } = state;
  let changed = state.changed;

  // 0) 轮次聚合列与 stakes 事实源对齐（只在漂移时写库）
  for (const round of rounds) {
    const aggregate = state.stakeAgg.get(round.round_id);
    if (!aggregate) continue;
    const totalRaw = aggregate.totalRaw.toString();
    if (round.total_accepted_stake_raw !== totalRaw || round.staker_count !== aggregate.stakerCount) {
      round.total_accepted_stake_raw = totalRaw;
      round.staker_count = aggregate.stakerCount;
      await store.updateRoundAggregate(env, round.round_id, totalRaw, aggregate.stakerCount, now);
      changed = true;
    }
  }

  // 1) 按时间推进状态（不含 K 线）
  for (const round of rounds) {
    if (round.state === 'UNOPENED') continue;
    if (isTerminal(round.state)) continue;

    if (params.paused && round.state === 'OBSERVING') {
      if (await store.casRoundState(env, round.round_id, 'OBSERVING', 'ORACLE_PAUSED', now)) {
        round.state = 'ORACLE_PAUSED';
        round.updated_at = now;
        changed = true;
        await store.logEvent(env, 'warn', 'oracle', 'ORACLE_PAUSED', `R${round.round_id} 预言机暂停，K 线计数冻结（不销毁本金）`);
      }
      continue;
    }
    if (round.state === 'ORACLE_PAUSED') continue;

    if (round.state === 'STAKING_OPEN' && round.stake_close_at !== null && now >= round.stake_close_at) {
      if (await store.casRoundState(env, round.round_id, 'STAKING_OPEN', 'STAKING_CLOSED', now)) {
        round.state = 'STAKING_CLOSED';
        round.updated_at = now;
        changed = true;
        await store.logEvent(env, 'info', 'system', 'STAKING_CLOSED', `R${round.round_id} 质押窗口关闭，共 ${round.staker_count} 个地址`);
      }
    }
    if (round.state === 'STAKING_CLOSED' && round.observation_start !== null && now >= round.observation_start) {
      if (await store.casRoundState(env, round.round_id, 'STAKING_CLOSED', 'OBSERVING', now)) {
        round.state = 'OBSERVING';
        round.updated_at = now;
        changed = true;
        await store.logEvent(env, 'info', 'oracle', 'OBSERVATION_STARTED', `R${round.round_id} 观察窗口开始（${params.candleCount} 根 × ${params.candleMs / 1000}s）`);
      }
    }
  }

  // 2) K 线落库 + 结算
  const source = getSource(params.dataSource);
  for (const round of rounds) {
    if (round.state === 'UNOPENED') continue;
    if (round.observation_start === null) continue;
    const existing = state.candlesByRound.get(round.round_id) ?? [];
    const { seen, qualified, inserted } = await syncRoundCandles(env, params, source, round, now, existing);
    state.candlesByRound.set(round.round_id, existing);
    if (inserted > 0) changed = true;
    if (seen !== round.candles_seen || qualified !== round.qualified_candles) {
      round.candles_seen = seen;
      round.qualified_candles = qualified;
      changed = true;
      await store.updateRoundCandles(env, round.round_id, seen, qualified, now);
    }

    if (round.state !== 'OBSERVING') continue;
    if (seen < params.candleCount) continue;
    const settled = qualified >= params.minQualifiedCandles
      ? await settleSuccess(env, params, round, now)
      : await settleFailure(env, params, round, now);
    if (settled) changed = true;
  }

  return { ...state, changed };
}

/** 演示成交 / 盘口保鲜：仅 cron 与 admin tick 调用，避免读请求写库。 */
export async function refreshDemoMarket(env: Env, state: ReconcileResult): Promise<boolean> {
  const { params, rounds, now } = state;
  if (params.dataSource !== 'demo') return false;
  const source = getSource(params.dataSource);
  const opened = rounds.filter((round) => round.state !== 'UNOPENED');
  if (!opened.length) return false;
  const round = opened[opened.length - 1];

  const lastTs = await store.latestTradeTs(env);
  if (lastTs > 0 && now - lastTs < 8000) return false;
  const count = clampInt(Math.floor((now - (lastTs || now - 60000)) / 12000), 1, 4);
  const rows = source.buildTrades(params, round, count, lastTs, now);
  if (!rows.length) return false;
  await store.insertTrades(env, rows);
  await store.trimTrades(env, now - 24 * 3600 * 1000);
  return true;
}

function stakeWindowMs(params: Params): number {
  if (params.dataSource === 'demo') return Math.max(60_000, params.demoStakeSeconds * 1000);
  return params.stakeDurationSeconds * 1000;
}

/** 管理端：开启下一轮（必须上一轮已终态、不得跳轮、不得重开失败轮）。 */
export async function advanceRound(env: Env, actor: string, now = Date.now()): Promise<ReconcileResult> {
  const state = await reconcile(env, now);
  const { params, rounds } = state;

  const active = rounds.find((round) => round.state !== 'UNOPENED' && !isTerminal(round.state));
  if (active) {
    throw conflict(`R${active.round_id} 当前状态 ${active.state}，必须先结算为终态才能开启下一轮`);
  }

  const opened = rounds.filter((round) => round.state !== 'UNOPENED');
  const lastId = opened.reduce((max, round) => Math.max(max, round.round_id), 0);
  if (lastId >= params.roundCount) throw conflict(`${params.roundCount} 轮已全部结束`);

  const next = rounds.find((round) => round.round_id === lastId + 1);
  if (!next) throw conflict('下一轮不存在，请检查 rounds 初始化数据');
  if (next.state !== 'UNOPENED') throw conflict(`R${next.round_id} 不是 UNOPENED 状态，无法开启`);

  const openedId = await openRoundAt(env, params, next.round_id, now, actor);
  if (!openedId) throw conflict(`R${next.round_id} 开启失败（并发冲突），请刷新后重试`);
  return loadState(env, now);
}

/** 开启指定轮次（admin advance 与 demo autoplay 共用；CAS 保证并发幂等）。 */
async function openRoundAt(env: Env, params: Params, roundId: number, now: number, actor: string): Promise<number> {
  // V3：真实模式下一轮报名在「上一轮结算后 48h」开启；演示模式立即开启便于循环展示。
  const stakeOpenAt = params.dataSource === 'demo' ? now : now + params.stakeGapSeconds * 1000;
  const stakeCloseAt = stakeOpenAt + stakeWindowMs(params);
  const observationStart = ceilTo(stakeCloseAt, params.candleMs);
  const observationEnd = observationStart + params.candleCount * params.candleMs;
  const target = targetPriceFor(roundId, params.p0UsdE8);

  const opened = await store.openRound(env, {
    roundId,
    now,
    targetPriceUsdE8: target.toString(),
    rewardBudgetRaw: params.roundRewardRaw.toString(),
    stakeOpenAt,
    stakeCloseAt,
    observationStart,
    observationEnd,
  });
  if (!opened) return 0;

  await store.logEvent(
    env,
    'info',
    actor,
    'ROUND_OPENED',
    `R${roundId} 质押窗口开启：target=${target.toString()} USD_E8，window=${Math.round((stakeCloseAt - stakeOpenAt) / 1000)}s（source=${params.dataSource}）`,
  );
  return roundId;
}

/**
 * 演示自维持（DEMO_AUTOPLAY，仅 DATA_SOURCE=demo；chain 模式强制关闭）：
 *  1. 已开启轮次全部终态且还有剩余轮次 → 自动开启下一轮（actor=cron）；
 *  2. 十轮全部终态 → 重置演示数据集，回到 R1/R2 已结算、R3 观察中的初始态，循环展示。
 * 并发安全：openRound 依赖 CAS(UNOPENED→STAKING_OPEN)，重置依赖 demo_reset_at 租约 + 幂等重建。
 */
export async function autoplay(env: Env, now = Date.now()): Promise<{ acted: boolean; action: string | null }> {
  const state = await reconcile(env, now);
  const { params } = state;
  if (!params.autoplay) return { acted: false, action: null };

  const opened = state.rounds.filter((round) => round.state !== 'UNOPENED');
  if (!opened.length) return { acted: false, action: null };
  const active = opened.find((round) => !isTerminal(round.state));
  if (active) return { acted: false, action: null };

  const lastId = opened.reduce((max, round) => Math.max(max, round.round_id), 0);
  if (lastId < params.roundCount) {
    const nextId = await openRoundAt(env, params, lastId + 1, now, 'cron');
    if (!nextId) return { acted: false, action: null };
    await store.logEvent(env, 'info', 'cron', 'DEMO_AUTOPLAY_OPEN', `R${nextId} 由演示自维持自动开启（上一轮 R${lastId} 已终态）`);
    return { acted: true, action: 'OPEN_NEXT_ROUND' };
  }

  // 十轮全部终态 → 重置演示（120s 租约，避免 cron 与 admin tick 并发重复重建）
  const lockAt = Number(state.kv.get('demo_reset_at') ?? '0');
  if (lockAt > 0 && now - lockAt < 120_000) return { acted: false, action: null };
  const cycle = Number(state.kv.get('demo_cycle') ?? '0') + 1;
  await store.setMetrics(env, { demo_reset_at: String(now), demo_cycle: String(cycle) }, now);
  await resetDemoData(env, params, now);
  await store.logEvent(
    env,
    'info',
    'cron',
    'DEMO_CYCLE_RESET',
    `十轮全部终态，演示数据已重置（第 ${cycle} 个循环：R1/R2 已结算、R3 观察中 6 根）`,
  );
  return { acted: true, action: 'DEMO_CYCLE_RESET' };
}

/** 管理端：暂停预言机（不推进 K 线、不销毁本金）。 */
export async function pauseOracle(env: Env, actor: string, reason: string, now = Date.now()): Promise<ReconcileResult> {
  await reconcile(env, now);
  await store.setMetrics(
    env,
    {
      oracle_paused: '1',
      oracle_paused_at: String(now),
      oracle_pause_reason: reason.slice(0, 240),
    },
    now,
  );
  const rounds = await store.listRounds(env);
  const observing = rounds.find((round) => round.state === 'OBSERVING');
  if (observing) {
    await store.casRoundState(env, observing.round_id, 'OBSERVING', 'ORACLE_PAUSED', now);
  }
  await store.logEvent(
    env,
    'warn',
    actor,
    'ORACLE_PAUSE',
    observing ? `R${observing.round_id} 暂停：${reason.slice(0, 160)}` : `预言机暂停（当前无观察中轮次）：${reason.slice(0, 160)}`,
  );
  return loadState(env, now);
}

/** 管理端：恢复预言机 → 丢弃旧窗口，从当前时刻重启完整 12 根观察。 */
export async function resumeOracle(env: Env, actor: string, now = Date.now()): Promise<ReconcileResult> {
  const state = await loadState(env, now);
  const pausedRound = state.rounds.find((round) => round.state === 'ORACLE_PAUSED');
  if (!pausedRound && !state.params.paused) {
    throw new ApiError('CONFLICT', '预言机当前未处于暂停状态');
  }
  await store.setMetrics(env, { oracle_paused: '0', oracle_resumed_at: String(now) }, now);
  if (pausedRound) {
    const observationStart = now;
    const observationEnd = now + state.params.candleCount * state.params.candleMs;
    await store.resetRoundWindow(env, pausedRound.round_id, observationStart, observationEnd, now);
    await store.logEvent(
      env,
      'info',
      actor,
      'ORACLE_RESUME',
      `R${pausedRound.round_id} 恢复：丢弃旧窗口，从 ${new Date(observationStart).toISOString()} 重启完整 ${state.params.candleCount} 根观察（不销毁本金）`,
    );
  } else {
    await store.logEvent(env, 'info', actor, 'ORACLE_RESUME', '预言机恢复（无暂停中的轮次）');
  }
  return loadState(env, now);
}