/**
 * API DTO 组装（shared/types.ts 契约的唯一出口）。
 * 金额保持 raw units 字符串，价格保持 USD_E8 字符串，时间保持 unix ms。
 * 轮次聚合统一取自 state.stakeAgg（stakes 表单一事实源），保证 rounds / detail / leaderboard / me 口径一致。
 */
import type {
  AdminOverview,
  Candle,
  HealthResponse,
  LeaderboardRow,
  MeResponse,
  OrderBook,
  OrderBookLevel,
  ProtocolConfig,
  ProtocolStats,
  RoundDetail,
  RoundSummary,
  RoundState,
  StakePosition,
  Trade,
} from '@shared/types';
import type { Env } from './env';
import { DEFAULT_VERSION, SCHEMA_VERSION, uptimeSeconds } from './env';
import { isActive, isTerminal, priceMultiplierFor } from './protocol';
import * as store from './store';
import type { CandleRow, RoundRow, TradeRow } from './store';
import { getSource } from './sources';
import type { ReconcileResult } from './state';
import { clampInt, mulDivFloor, toBigInt } from './util';

const DAY_MS = 24 * 3600 * 1000;

function totals(row: RoundRow, state: ReconcileResult): { totalAcceptedStakeRaw: string; stakerCount: number } {
  const aggregate = state.stakeAgg.get(row.round_id);
  if (!aggregate) return { totalAcceptedStakeRaw: row.total_accepted_stake_raw, stakerCount: row.staker_count };
  return { totalAcceptedStakeRaw: aggregate.totalRaw.toString(), stakerCount: aggregate.stakerCount };
}

export function buildRoundSummary(row: RoundRow, state: ReconcileResult): RoundSummary {
  const aggregate = totals(row, state);
  return {
    roundId: row.round_id,
    state: row.state,
    priceMultiplier: priceMultiplierFor(row.round_id),
    targetPriceUsdE8: row.target_price_usd_e8,
    rewardBudgetRaw: row.reward_budget_raw,
    stakeOpenAt: row.stake_open_at,
    stakeCloseAt: row.stake_close_at,
    observationStart: row.observation_start,
    observationEnd: row.observation_end,
    candlesSeen: row.candles_seen,
    qualifiedCandles: row.qualified_candles,
    totalAcceptedStakeRaw: aggregate.totalAcceptedStakeRaw,
    stakerCount: aggregate.stakerCount,
    result: row.result,
    burnedRaw: row.burned_raw,
    updatedAt: row.updated_at,
  };
}

export function buildCandles(rows: CandleRow[]): Candle[] {
  return rows.map((row) => ({
    roundId: row.round_id,
    candleIndex: row.candle_index,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    twapPriceUsdE8: row.twap_price_usd_e8,
    qualified: row.qualified === 1,
    coverageBps: row.coverage_bps,
    validSourceCount: row.valid_source_count,
    dataDigest: row.data_digest,
  }));
}

function priceFor(state: ReconcileResult, row: RoundRow): bigint {
  const source = getSource(state.params.dataSource);
  if (isTerminal(row.state)) return source.terminalPrice(state.params, row);
  return source.currentPrice(state.params, row, state.now);
}

/** 当前「焦点轮次」：进行中的最高轮，否则最近一个已开启轮次，否则 R1。 */
function focusRound(state: ReconcileResult): RoundRow | undefined {
  const opened = state.rounds.filter((row) => row.state !== 'UNOPENED');
  const active = opened.filter((row) => isActive(row.state));
  if (active.length) return active[active.length - 1];
  if (opened.length) return opened[opened.length - 1];
  return state.rounds[0];
}

export function buildProtocolConfig(state: ReconcileResult): ProtocolConfig {
  const { params, kv } = state;
  const contract = (key: string): string | null => {
    const value = kv.get(key);
    return value && value.trim() ? value.trim() : null;
  };
  return {
    token: { name: params.tokenName, symbol: params.tokenSymbol, decimals: params.tokenDecimals },
    p0UsdE8: params.p0UsdE8.toString(),
    usdPriceScale: params.usdPriceScale,
    priceMultiplier: params.priceMultiplier,
    roundCount: params.roundCount,
    roundRewardRaw: params.roundRewardRaw.toString(),
    totalSupplyRaw: params.totalSupplyRaw.toString(),
    candleSeconds: params.candleSeconds,
    candleCount: params.candleCount,
    minQualifiedCandles: params.minQualifiedCandles,
    riskDisclosureVersion: params.riskDisclosureVersion,
    stakeDurationSeconds: params.stakeDurationSeconds,
    observationSeconds: params.observationSeconds,
    network: params.network,
    dataSource: params.dataSource,
    demo:
      params.dataSource === 'demo'
        ? {
            candleSeconds: params.demoCandleSeconds,
            speed: Math.max(1, Math.round(params.candleSeconds / params.demoCandleSeconds)),
            epochMs: params.demoEpochMs,
          }
        : null,
    contracts: {
      jettonMaster: contract('contract_jetton_master'),
      roundController: contract('contract_round_controller'),
      stakingVault: contract('contract_staking_vault'),
      rewardVault: contract('contract_reward_vault'),
      oracleAdapter: contract('contract_oracle_adapter'),
      codeHash: contract('contract_code_hash'),
      oracleConfigHash: contract('contract_oracle_config_hash'),
      multisig: contract('contract_multisig'),
      auditReportUrl: contract('contract_audit_report_url'),
    },
    tonConnectManifestUrl: params.tonConnectManifestUrl,
    tonUsdE8: params.tonUsdE8,
    frozenParams: [
      { key: 'P0_USD_E8', label: 'P0 初始参考价', status: 'frozen', value: '$' + (Number(params.p0UsdE8) / params.usdPriceScale).toFixed(5) },
      { key: 'ROUND_REWARD_RAW', label: '每轮奖励预算', status: 'frozen', value: '750,000,000 FUSE × 10 轮 = 7,500,000,000' },
      { key: 'PRICE_LADDER', label: '价格阶梯 P0×2ⁿ', status: 'frozen', value: '10 轮 / 最高 1024×P0' },
      { key: 'MIN_QUALIFIED_CANDLES', label: '达标 K 线阈值', status: 'frozen', value: params.minQualifiedCandles + ' / ' + params.candleCount + '（不足即永久关闭并销毁本金）' },
      { key: 'BURN_SEMANTICS', label: '失败销毁语义', status: 'frozen', value: '奖励额度 + 本轮全部已接受质押本金' },
      { key: 'TOKEN_DECIMALS', label: 'Jetton 精度（D-02）', status: 'pending', value: params.tokenDecimals + ' 位（建议值，待项目方确认）' },
      { key: 'ORACLE_CONFIG', label: '预言机与数据源（D-04~D-09）', status: 'pending', value: '待选定（演示数据源不具链上效力）' },
      { key: 'REWARD_FORMULA', label: '奖励分配公式（D-14）', status: 'pending', value: 'MVP 默认：按有效质押数量比例' },
      { key: 'MULTISIG', label: '多签阈值（D-23）', status: 'pending', value: '建议 3/5 或等效独立治理' },
      { key: 'AUDIT', label: '合约审计（D-24 前置）', status: 'pending', value: '待审计 / 待发布报告' },
    ],
  };
}

export function buildOracleStatus(state: ReconcileResult) {
  return getSource(state.params.dataSource).oracleStatus(state.params, state.kv, state.now);
}

export async function buildStats(env: Env, state: ReconcileResult): Promise<ProtocolStats> {
  const { params, rounds, now, stakeAgg } = state;
  const burned = await store.totalConfirmedBurned(env);
  const tradeValues = await store.listTradeValuesSince(env, now - DAY_MS);
  let volume = 0n;
  for (const value of tradeValues) volume += toBigInt(value);

  let locked = 0n;
  let stakers = 0;
  for (const row of rounds) {
    if (!isActive(row.state)) continue;
    const aggregate = stakeAgg.get(row.round_id);
    if (aggregate) {
      locked += aggregate.totalRaw;
      stakers += aggregate.stakerCount;
    } else {
      locked += toBigInt(row.total_accepted_stake_raw);
      stakers += row.staker_count;
    }
  }

  const focus = focusRound(state);
  const price = focus ? priceFor(state, focus) : 0n;
  const supply = params.totalSupplyRaw > burned ? params.totalSupplyRaw - burned : 0n;
  const liquidity = toBigInt(state.kv.get('liquidity_usd_e8') ?? '180000000000000');

  return {
    supplyRaw: supply.toString(),
    burnedRaw: burned.toString(),
    lockedStakeRaw: locked.toString(),
    stakerCount: stakers,
    volume24hUsdE8: volume.toString(),
    liquidityUsdE8: liquidity.toString(),
    priceUsdE8: price.toString(),
    price24hAgoUsdE8: ((price * 962n) / 1000n).toString(),
    oracle: buildOracleStatus(state),
  };
}

export function buildRoundDetail(state: ReconcileResult, row: RoundRow): RoundDetail {
  const { params, now } = state;
  const source = getSource(params.dataSource);
  const candles = state.candlesByRound.get(row.round_id) ?? [];
  const summary = buildRoundSummary(row, state);
  const price = priceFor(state, row);
  const target = toBigInt(row.target_price_usd_e8);

  let live: RoundDetail['live'] = null;
  if (row.state === 'OBSERVING' && row.candles_seen < params.candleCount && row.observation_start !== null) {
    const candleIndex = row.candles_seen;
    const periodStart = row.observation_start + candleIndex * params.candleMs;
    const progressBps = clampInt(
      Math.floor(((now - periodStart) / Math.max(1, params.candleMs)) * 10000),
      0,
      9999,
    );
    live = {
      candleIndex,
      twapPriceUsdE8: source.liveTwap(params, row, candleIndex, progressBps).toString(),
      progressBps,
      qualifiedTentative: price >= target,
    };
  }

  let secondsRemaining: number | null = null;
  let nextState: RoundState | null = null;
  const secondsTo = (ts: number | null): number | null => (ts === null ? null : Math.max(0, Math.ceil((ts - now) / 1000)));

  switch (row.state) {
    case 'STAKING_OPEN':
      secondsRemaining = secondsTo(row.stake_close_at);
      nextState = 'STAKING_CLOSED';
      break;
    case 'STAKING_CLOSED':
      secondsRemaining = secondsTo(row.observation_start);
      nextState = 'OBSERVING';
      break;
    case 'OBSERVING': {
      secondsRemaining = secondsTo(row.observation_end);
      const remaining = Math.max(0, params.candleCount - row.candles_seen);
      if (row.qualified_candles >= params.minQualifiedCandles) nextState = 'SETTLING_SUCCESS';
      else if (row.qualified_candles + remaining < params.minQualifiedCandles) nextState = 'SETTLING_FAILURE';
      else nextState = null;
      break;
    }
    case 'ORACLE_PAUSED':
      secondsRemaining = null;
      nextState = 'OBSERVING';
      break;
    default:
      secondsRemaining = null;
      nextState = null;
  }

  return {
    ...summary,
    candles: buildCandles(candles),
    live,
    priceUsdE8: price.toString(),
    secondsRemaining,
    nextState,
  };
}

/** 排行榜与 /api/me 共用同一份聚合：amount/占比/预计奖励公式完全一致。 */
export function buildLeaderboard(state: ReconcileResult, roundId: number): LeaderboardRow[] {
  const aggregate = state.stakeAgg.get(roundId);
  if (!aggregate || aggregate.totalRaw === 0n) return [];
  const round = state.rounds.find((item) => item.round_id === roundId);
  const rewarded = round ? round.result !== 'FAILURE' : true;
  const rewardBudget = rewarded && round ? toBigInt(round.reward_budget_raw) : 0n;

  return [...aggregate.byAddress.entries()]
    .sort((a, b) => (a[1].amountRaw === b[1].amountRaw ? a[0].localeCompare(b[0]) : a[1].amountRaw > b[1].amountRaw ? -1 : 1))
    .slice(0, 50)
    .map(([address, entry], index) => ({
      rank: index + 1,
      address,
      amountRaw: entry.amountRaw.toString(),
      shareBps: Number((entry.amountRaw * 10000n) / aggregate.totalRaw),
      rewardEstimateRaw: mulDivFloor(rewardBudget, entry.amountRaw, aggregate.totalRaw).toString(),
      acceptedAt: entry.acceptedAt,
    }));
}

export async function buildMe(env: Env, state: ReconcileResult, address: string): Promise<MeResponse> {
  const rows = await store.listStakesForAddress(env, address);
  const claims = await store.listClaimsForAddress(env, address);

  const perRound = new Map<
    number,
    { amount: bigint; weight: bigint; acceptedAt: number; principalClaimed: boolean; rewardClaimed: boolean }
  >();
  for (const row of rows) {
    const current = perRound.get(row.round_id);
    const amount = toBigInt(row.amount_raw);
    const weight = toBigInt(row.weight_raw);
    if (current) {
      current.amount += amount;
      current.weight += weight;
      current.acceptedAt = Math.min(current.acceptedAt, row.accepted_at);
      current.principalClaimed = current.principalClaimed && row.principal_claimed === 1;
      current.rewardClaimed = current.rewardClaimed && row.reward_claimed === 1;
    } else {
      perRound.set(row.round_id, {
        amount,
        weight,
        acceptedAt: row.accepted_at,
        principalClaimed: row.principal_claimed === 1,
        rewardClaimed: row.reward_claimed === 1,
      });
    }
  }

  const stakes: StakePosition[] = [...perRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([roundId, entry]) => ({
      roundId,
      address,
      amountRaw: entry.amount.toString(),
      weightRaw: entry.weight.toString(),
      principalClaimed: entry.principalClaimed,
      rewardClaimed: entry.rewardClaimed,
      acceptedAt: entry.acceptedAt,
    }));

  const claimable: MeResponse['claimable'] = [];
  let claimedTotal = 0n;
  for (const claim of claims) claimedTotal += toBigInt(claim.amount_raw);

  let rewardTotal = 0n;
  for (const [roundId, entry] of perRound) {
    const round = state.rounds.find((item) => item.round_id === roundId);
    if (!round) continue;
    const aggregate = state.stakeAgg.get(roundId);
    const roundTotal = aggregate ? aggregate.totalRaw : toBigInt(round.total_accepted_stake_raw);
    if (round.state === 'SUCCEEDED') {
      const reward = mulDivFloor(toBigInt(round.reward_budget_raw), entry.amount, roundTotal);
      rewardTotal += reward;
      const principalRaw = entry.principalClaimed ? 0n : entry.amount;
      const rewardRaw = entry.rewardClaimed ? 0n : reward;
      if (principalRaw > 0n || rewardRaw > 0n) {
        claimable.push({
          roundId,
          principalRaw: principalRaw.toString(),
          rewardRaw: rewardRaw.toString(),
          state: round.state,
        });
      }
    }
  }

  let stakedTotal = 0n;
  for (const entry of perRound.values()) stakedTotal += entry.amount;

  return {
    address,
    stakes,
    claimable,
    totals: {
      stakedRaw: stakedTotal.toString(),
      rewardRaw: rewardTotal.toString(),
      claimedRaw: claimedTotal.toString(),
    },
  };
}

export function buildOrderBook(state: ReconcileResult, rows: store.BookRow[]): OrderBook {
  const focus = focusRound(state);
  const mid = focus ? priceFor(state, focus) : 0n;
  const asksRaw = rows.filter((row) => row.side === 'ask').sort((a, b) => a.seq - b.seq);
  const bidsRaw = rows.filter((row) => row.side === 'bid').sort((a, b) => a.seq - b.seq);
  const toLevels = (list: store.BookRow[]): OrderBookLevel[] => {
    let total = 0n;
    for (const row of list) total += toBigInt(row.amount_raw);
    let cumulative = 0n;
    return list.map((row) => {
      const amount = toBigInt(row.amount_raw);
      cumulative += amount;
      const pct = total > 0n ? Number((cumulative * 10000n) / total) / 100 : 0;
      return {
        priceUsdE8: row.price_usd_e8,
        amountRaw: row.amount_raw,
        cumulativePct: Math.round(pct * 10) / 10,
      };
    });
  };
  return { asks: toLevels(asksRaw), bids: toLevels(bidsRaw), midUsdE8: mid.toString() };
}

export function buildTrades(rows: TradeRow[]): Trade[] {
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    side: row.side,
    amountRaw: row.amount_raw,
    priceUsdE8: row.price_usd_e8,
    valueUsdE8: row.value_usd_e8,
    big: row.big === 1,
  }));
}

export async function buildAdminOverview(env: Env, state: ReconcileResult): Promise<AdminOverview> {
  const [events, stats] = await Promise.all([store.listEvents(env, 60), buildStats(env, state)]);
  return {
    rounds: state.rounds.map((row) => buildRoundSummary(row, state)),
    events: events.map((row) => ({
      id: row.id,
      ts: row.ts,
      level: row.level,
      actor: row.actor,
      action: row.action,
      detail: row.detail,
    })),
    oracle: buildOracleStatus(state),
    stats,
    worker: {
      uptimeSeconds: uptimeSeconds(state.now),
      now: state.now,
      dataSource: state.params.dataSource,
      demoCandleSeconds: state.params.dataSource === 'demo' ? state.params.demoCandleSeconds : null,
    },
  };
}

export function buildHealth(env: Env, db: boolean, dataSource: 'demo' | 'chain'): HealthResponse {
  const sha = (env.GIT_SHA ?? '').trim();
  const version = (env.VERSION ?? DEFAULT_VERSION).trim() + (sha ? '+' + sha.slice(0, 7) : '');
  return {
    ok: db,
    now: Date.now(),
    db,
    dataSource,
    version,
    uptimeSeconds: uptimeSeconds(Date.now()),
  };
}

export function buildVersionInfo(env: Env, dataSource: 'demo' | 'chain') {
  const now = Date.now();
  return {
    version: (env.VERSION ?? DEFAULT_VERSION).trim(),
    gitSha: (env.GIT_SHA ?? '').trim() || null,
    deployedAt: (env.DEPLOYED_AT ?? '').trim() || null,
    dataSource,
    schemaVersion: SCHEMA_VERSION,
    now,
    uptimeSeconds: uptimeSeconds(now),
  };
}
