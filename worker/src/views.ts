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
  RoundPosition,
  RoundSummary,
  RoundState,
  StakePosition,
  Trade,
} from '@shared/types';
import type { Env } from './env';
import { DEFAULT_VERSION, SCHEMA_VERSION, uptimeSeconds } from './env';
import { isActive, isTerminal, priceMultiplierFor, projectedTierForRound, rewardFor, tierForRound } from './protocol';
import * as store from './store';
import type { CandleRow, RoundRow, TradeRow } from './store';
import { getSource } from './sources';
import * as rewards from './rewards';
import type { ReconcileResult } from './state';
import { fallbackUnlockSecondsOf, roundPositionOf, type UnlockContext } from './me-position';
import { clampInt, mulDivFloor, toBigInt } from './util';

const DAY_MS = 24 * 3600 * 1000;

function totals(row: RoundRow, state: ReconcileResult): { totalAcceptedStakeRaw: string; stakerCount: number } {
  const aggregate = state.stakeAgg.get(row.round_id);
  if (!aggregate) return { totalAcceptedStakeRaw: row.total_accepted_stake_raw, stakerCount: row.staker_count };
  return { totalAcceptedStakeRaw: aggregate.totalRaw.toString(), stakerCount: aggregate.stakerCount };
}

export function buildRoundSummary(row: RoundRow, state: ReconcileResult): RoundSummary {
  const aggregate = totals(row, state);
  const chainMode = state.params.dataSource === 'chain';
  // D-28：档位随轮次落库（target_tier），禁止用 roundId 推导；只有 demo 旧数据才走兜底。
  const tierKnown = row.target_tier > 0;
  // B7：chain 模式未开轮且索引器还没写 target_tier/target_price 时，不投影、不猜档位；
  // 返回 0 并用 targetLocked=false 明确标注「目标未锁定」（demo 行为保持不变）。
  const targetLocked = !chainMode || (tierKnown && toBigInt(row.target_price_usd_e8) > 0n);
  const tier = tierKnown
    ? row.target_tier
    : chainMode
      ? 0
      : row.state === 'UNOPENED'
        ? projectedTierForRound(row.round_id, state.rounds)
        : tierForRound(row.round_id, state.rounds);
  return {
    roundId: row.round_id,
    state: row.state,
    priceMultiplier: targetLocked ? priceMultiplierFor(tier) : 0,
    targetPriceUsdE8: targetLocked ? row.target_price_usd_e8 : '0',
    rewardBudgetRaw: row.reward_budget_raw,
    stakeOpenAt: row.stake_open_at,
    stakeCloseAt: row.stake_close_at,
    observationStart: row.observation_start,
    observationEnd: row.observation_end,
    candlesSeen: row.candles_seen,
    qualifiedCandles: row.qualified_candles,
    totalAcceptedStakeRaw: aggregate.totalAcceptedStakeRaw,
    candleHash: row.candle_hash ?? null,
    stakerCount: aggregate.stakerCount,
    result: row.result,
    burnedRaw: row.burned_raw,
    teamReleasedRaw: row.team_released_raw ?? null,
    updatedAt: row.updated_at,
    // 额外字段（shared/types 暂未声明）：chain 未锁定目标时前端应显示「待链上开轮」
    targetLocked,
  } as RoundSummary & { targetLocked: boolean };
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
    previewSeconds: params.previewProtocolSeconds,
    minStakeRaw: params.minStakeRaw.toString(),
    teamRoundRaw: params.teamRoundRaw.toString(),
    network: params.network,
    dataSource: params.dataSource,
    demo:
      params.dataSource === 'demo'
        ? {
            candleSeconds: params.demoCandleSeconds,
            speed: Math.max(1, Math.round(params.candleSeconds / params.demoCandleSeconds)),
            epochMs: params.demoEpochMs,
            previewSeconds: params.previewSeconds,
          }
        : null,
    contracts: {
      jettonMaster: contract('contract_jetton_master'),
      roundController: contract('contract_round_controller'),
      junxiangDistributor: contract('contract_junxiang_distributor'),
      stakingVault: contract('contract_staking_vault'),
      rewardVault: contract('contract_reward_vault'),
      codeHash: contract('contract_code_hash'),
      oracleConfigHash: contract('contract_oracle_config_hash'),
      keeper: contract('contract_keeper'),
      teamWallet: contract('contract_team_wallet'),
      auditReportUrl: contract('contract_audit_report_url'),
    },
    tonConnectManifestUrl: params.tonConnectManifestUrl,
    tonUsdE8: params.tonUsdE8,
    frozenParams: [
      { key: 'P0_USD_E8', label: 'P0 初始参考价', status: 'frozen', value: '$' + (Number(params.p0UsdE8) / params.usdPriceScale).toFixed(5) },
      { key: 'ROUND_REWARD_RAW', label: '每轮奖励预算', status: 'frozen', value: '700,000,000 A9 × 10 轮 = 7,000,000,000' },
      { key: 'PRICE_LADDER', label: '目标价档位 P0×2^tier（D-28）', status: 'frozen', value: 'tier = 1 + 已成功轮数；失败不升档（同档重试），成功才升档；10 轮 ≠ 10 档位' },
      { key: 'MIN_QUALIFIED_CANDLES', label: '达标 K 线阈值', status: 'frozen', value: params.minQualifiedCandles + ' / ' + params.candleCount + '（不足即永久关闭并销毁本金）' },
      { key: 'BURN_SEMANTICS', label: '失败销毁语义', status: 'frozen', value: '本轮奖励 7 亿 + 团队额度 1.2 亿 + 本轮全部已接受质押本金（一笔 burn）' },
      { key: 'TOKEN_DECIMALS', label: 'Jetton 精度（D-02）', status: 'frozen', value: params.tokenDecimals + ' 位（已确认）' },
      { key: 'ORACLE_CONFIG', label: '预言机与数据源（D-04~D-09）', status: 'pending', value: '待选定（演示数据源不具链上效力）' },
      { key: 'REWARD_FORMULA', label: '奖励分配公式（D-14）', status: 'frozen', value: '纯质押比例：floor(本轮奖励 × 我的质押 / 总质押)，一次性发放' },
      { key: 'CUSTODY', label: '托管与权限（D-42）', status: 'frozen', value: '合约没有 admin；单一 keeper 只能开轮与提交 K 线；奖励与团队额度都在 RoundController 钱包' },
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

  // 下一轮质押开启倒计时：无活跃轮次时 = 最后结算时间 + 预告期
  const activeRound = rounds.find((row) => isActive(row.state));
  let nextStakeOpenAt: number | null = null;
  if (!activeRound) {
    const lastSettledAt = rounds
      .filter((row) => isTerminal(row.state))
      .reduce((max, row) => Math.max(max, row.updated_at), 0);
    if (lastSettledAt > 0) nextStakeOpenAt = lastSettledAt + params.previewSeconds * 1000;
  }

  const focus = focusRound(state);
  const price = focus ? priceFor(state, focus) : 0n;
  const supply = params.totalSupplyRaw > burned ? params.totalSupplyRaw - burned : 0n;

  // H-5：demo 用演示流动性；chain 模式只认单独的 chain_liquidity_usd_e8（ops/索引器写入），
  // 不读演示键 liquidity_usd_e8（避免 chain 部署误加载 demo seed 时把 1.8e14 当成真实流动性）。
  const liquidityKey = params.dataSource === 'chain' ? 'chain_liquidity_usd_e8' : 'liquidity_usd_e8';
  const liquidityOverride = state.kv.get(liquidityKey);
  const liquidity: bigint | null =
    liquidityOverride !== undefined && liquidityOverride !== ''
      ? toBigInt(liquidityOverride)
      : params.dataSource === 'demo'
        ? 180_000_000_000_000n
        : null;

  // H-5：demo 用 −3.8% 演示估算；chain 模式取真实 24h 前 K 线 TWAP（metrics 或 candles），拿不到就 null
  const price24hAgo = resolvePrice24hAgo(state, focus, price);

  return {
    supplyRaw: supply.toString(),
    burnedRaw: burned.toString(),
    lockedStakeRaw: locked.toString(),
    stakerCount: stakers,
    volume24hUsdE8: volume.toString(),
    // H-5：chain 模式未知值返回 null（shared/types 已放宽为 string | null，前端展示「数据不可用」）
    liquidityUsdE8: liquidity === null ? null : liquidity.toString(),
    priceUsdE8: price.toString(),
    price24hAgoUsdE8: price24hAgo === null ? null : price24hAgo.toString(),
    oracle: buildOracleStatus(state),
    nextStakeOpenAt,
  };
}

/**
 * 24h 前真实参考价：
 *  1) 索引器写入 metrics.price_24h_ago_usd_e8（USD_E8）；
 *  2) chain 模式回退到当前轮 candles 中覆盖 (now - 24h) 的那根 K 线 TWAP；
 *  3) demo 模式保留演示估算（price × 0.962，仅演示，不可用于主网展示）；
 *  4) 无法取得 → null（chain 模式下禁止返回假数字）。
 */
function resolvePrice24hAgo(state: ReconcileResult, focus: RoundRow | undefined, price: bigint): bigint | null {
  const fromMetrics = state.kv.get('price_24h_ago_usd_e8');
  if (fromMetrics !== undefined && fromMetrics !== '') return toBigInt(fromMetrics);
  const dataSource = state.params.dataSource;
  if (dataSource === 'demo') return (price * 962n) / 1000n;
  if (!focus) return null;
  const cutoff = state.now - DAY_MS;
  const candles = state.candlesByRound.get(focus.round_id) ?? [];
  const candle = candles.find((row) => row.period_start <= cutoff && row.period_end > cutoff);
  return candle ? toBigInt(candle.twap_price_usd_e8) : null;
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

/** 排行榜与 /api/me 共用同一份聚合：amount/占比/预计奖励公式完全一致（v10：按质押比例）。 */
export function buildLeaderboard(state: ReconcileResult, roundId: number): LeaderboardRow[] {
  const aggregate = state.stakeAgg.get(roundId);
  if (!aggregate || aggregate.totalRaw === 0n) return [];
  const round = state.rounds.find((item) => item.round_id === roundId);
  const rewarded = round ? round.result !== 'FAILURE' && round.result !== 'TECHNICAL_ABORT' : true;
  const rewardBudget = rewarded && round ? toBigInt(round.reward_budget_raw) : 0n;
  // B4：chain 模式 rewardEstimateRaw 是本地估算（非链上可领取额），带 estimate:true 供前端标注
  return [...aggregate.byAddress.entries()]
    .sort((a, b) => (a[1].amountRaw === b[1].amountRaw ? a[0].localeCompare(b[0]) : a[1].amountRaw > b[1].amountRaw ? -1 : 1))
    .slice(0, 50)
    .map(([address, entry], index) => ({
      rank: index + 1,
      address,
      amountRaw: entry.amountRaw.toString(),
      shareBps: Number((entry.amountRaw * 10000n) / aggregate.totalRaw),
      rewardEstimateRaw: rewardFor(rewardBudget, entry.amountRaw, aggregate.totalRaw).toString(),
      acceptedAt: entry.acceptedAt,
      estimate: state.params.dataSource === 'chain',
    }));
}

function unlockContextOf(state: ReconcileResult): UnlockContext {
  const { kv, rounds, now } = state;
  const chainLast = kv.get('chain:last_success_round');
  const chainEnd = kv.get('chain:end_at');
  const successIds = rounds.filter((row) => row.state === 'SUCCEEDED').map((row) => row.round_id);
  const lastSuccessRound = chainLast !== undefined ? Number(chainLast) || 0 : Math.max(0, ...successIds);
  let endAt = chainEnd !== undefined ? Number(chainEnd) || 0 : 0;
  if (chainEnd === undefined) {
    // demo 没有链上 endAt：第 10 城进入终态的时刻近似为 endAt
    const last = rounds.find((row) => row.round_id === 10);
    if (last && isTerminal(last.state)) endAt = Math.floor(last.updated_at / 1000);
  }
  const fallback = kv.get('chain:fallback_unlock_seconds');
  const fallbackSec = fallbackUnlockSecondsOf(fallback);
  return { lastSuccessRound, endAt, nowSec: Math.floor(now / 1000), fallbackSec };
}

export async function buildMe(env: Env, state: ReconcileResult, address: string): Promise<MeResponse> {
  const [rows, claims, refundRows] = await Promise.all([
    store.listStakesForAddress(env, address),
    store.listClaimsForAddress(env, address),
    store.listRefundEntries(env, address),
  ]);
  const roundsById = new Map(state.rounds.map((row) => [row.round_id, row]));

  // 本金按城汇总（deposit + 续战滚入）；principal_claimed 为 1 当且仅当该城本金已付或已续战转出
  const perRound = new Map<number, { amount: bigint; acceptedAt: number; principalClaimed: boolean }>();
  for (const row of rows) {
    const current = perRound.get(row.round_id);
    const amount = toBigInt(row.amount_raw);
    const claimed = row.principal_claimed === 1;
    if (current) {
      current.amount += amount;
      current.acceptedAt = Math.min(current.acceptedAt, row.accepted_at);
      current.principalClaimed = current.principalClaimed && claimed;
    } else {
      perRound.set(row.round_id, { amount, acceptedAt: row.accepted_at, principalClaimed: claimed });
    }
  }
  const rewardClaimedByRound = new Map<number, bigint>();
  for (const claim of claims) {
    if (claim.kind !== 'reward') continue;
    rewardClaimedByRound.set(claim.round_id, (rewardClaimedByRound.get(claim.round_id) ?? 0n) + toBigInt(claim.amount_raw));
  }

  const ctx = unlockContextOf(state);
  const stakes: StakePosition[] = [];
  const claimable: MeResponse['claimable'] = [];
  const rounds: RoundPosition[] = [];
  let stakedTotal = 0n;
  let rewardTotal = 0n;
  let mask = 0;
  let claimablePrincipal = 0n;
  let claimableReward = 0n;
  for (const [roundId, entry] of [...perRound.entries()].sort((a, b) => a[0] - b[0])) {
    const round = roundsById.get(roundId);
    const roundState = round?.state ?? 'UNOPENED';
    const reward = round ? rewards.rewardOfAddress(round, address, state.stakeRows, state.rewardRows) : 0n;
    const position = roundPositionOf({
      roundId,
      state: roundState,
      principalRaw: entry.amount,
      principalClaimed: entry.principalClaimed,
      rewardRaw: reward,
      rewardClaimedRaw: rewardClaimedByRound.get(roundId) ?? 0n,
      ctx,
    });
    const claimableRaw = toBigInt(position.claimableRaw);
    stakedTotal += entry.amount;
    rewardTotal += reward;
    rounds.push(position);
    stakes.push({
      roundId,
      address,
      amountRaw: entry.amount.toString(),
      rewardRaw: reward.toString(),
      state: roundState,
      claimed: entry.principalClaimed && claimableRaw === 0n,
      claimable: claimableRaw > 0n,
      acceptedAt: entry.acceptedAt,
    });
    if (claimableRaw > 0n) {
      claimable.push({
        roundId,
        principalRaw: position.claimablePrincipalRaw,
        rewardRaw: position.claimableRewardRaw,
        state: roundState,
      });
      mask |= 1 << (roundId - 1);
      claimablePrincipal += toBigInt(position.claimablePrincipalRaw);
      claimableReward += toBigInt(position.claimableRewardRaw);
    }
  }

  // v11 没有退款账本：历史 refund 行只做展示（不进入 claimable / roundsMask）
  const refund = store.refundBalance(refundRows);

  let claimedTotal = 0n;
  for (const claim of claims) claimedTotal += toBigInt(claim.amount_raw);
  claimedTotal += refund.claimed;

  return {
    address,
    stakes,
    claimable,
    rounds,
    refund: {
      pendingRaw: refund.pending.toString(),
      creditedRaw: refund.credited.toString(),
      claimedRaw: refund.claimed.toString(),
    },
    claimableAll: {
      principalRaw: claimablePrincipal.toString(),
      rewardRaw: claimableReward.toString(),
      roundsMask: mask,
    },
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

export function buildHealth(
  env: Env,
  db: boolean,
  dataSource: 'demo' | 'chain',
  configError: string | null = null,
): HealthResponse & { oracle: { paused: boolean; reason: string | null } } {
  const sha = (env.GIT_SHA ?? '').trim();
  const version = (env.VERSION ?? DEFAULT_VERSION).trim() + (sha ? '+' + sha.slice(0, 7) : '');
  return {
    ok: db,
    now: Date.now(),
    db,
    dataSource,
    version,
    uptimeSeconds: uptimeSeconds(Date.now()),
    // H-6：配置缺失时 health 仍 200，但明确告知 oracle 暂停原因（外部监控可区分）
    oracle: { paused: configError !== null, reason: configError },
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