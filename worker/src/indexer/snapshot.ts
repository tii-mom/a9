/**
 * 链上快照 → D1 行 的映射（唯一映射点，便于单测与对账）。
 *
 * 口径：
 *  - 链上时间是秒，D1 是毫秒，全部在这里换算；
 *  - 链上 0 表示「未设置」→ D1 NULL（不能写成 1970 年）；
 *  - PREVIEW(1) 在 D1 用 UNOPENED 表达（D1 状态机没有 PREVIEW；前端用 lastSettledAt+previewSeconds 倒计时）；
 *  - 终态只前进不回退；链上 qualifiedCandles 被合约封顶在 minQualifiedCandles，
 *    D1 存「实际达标根数」（由 candles 表统计），对账时用 min(d1, threshold) 比较。
 */
import type { RoundStateName } from '../store';
import type { CandleRow, RoundChainPatch, RoundRow } from '../store';
import type { SubmitCandleMessage } from './messages';
import type { ChainRoundView } from './getters';
import type { ProtocolConfigFields } from './config';

const ZERO_HASH = '0x' + '0'.repeat(64);

/**
 * 链上 RoundData.status → D1 RoundStateName；PREVIEW 映射为 UNOPENED。
 * v10 只会出现 0/1/2/4/8/9/10；3/5/6/7（STAKING_CLOSED / ORACLE_PAUSED / SETTLING_*）已删除，返回 null（索引器告警）。
 */
export function chainStatusToRoundState(status: number): RoundStateName | null {
  switch (status) {
    case 0:
    case 1:
      return 'UNOPENED';
    case 2:
      return 'STAKING_OPEN';
    case 4:
      return 'OBSERVING';
    case 8:
      return 'SUCCEEDED';
    case 9:
      return 'FAILED_PERMANENT';
    case 10:
      return 'TECHNICAL_ABORTED';
    default:
      return null;
  }
}

export function isTerminalChainStatus(status: number): boolean {
  return status === 8 || status === 9 || status === 10;
}

export function isActiveChainStatus(status: number): boolean {
  return status === 2 || status === 4;
}

function isZeroHash(hash: string): boolean {
  return hash === ZERO_HASH;
}

/** 链上秒时间 → D1 毫秒；0 视为未设置 → null。 */
export function secondsToMs(value: number): number | null {
  return value > 0 ? value * 1000 : null;
}

export function resultForStatus(status: number): 'SUCCESS' | 'FAILURE' | 'TECHNICAL_ABORT' | null {
  if (status === 8) return 'SUCCESS';
  if (status === 9) return 'FAILURE';
  if (status === 10) return 'TECHNICAL_ABORT';
  return null;
}

export interface RoundSnapshotInput {
  view: ChainRoundView;
  config: ProtocolConfigFields;
  /** D1 当前行（可为 null：首次引导） */
  previous: RoundRow | null;
  /** 该轮已落库 K 线（用于统计实际达标根数与最近一根 TWAP） */
  candles: CandleRow[];
  /** burn 确认后的 burnedRaw；未确认传 null（保持原值，绝不提前显示已销毁） */
  burnedRaw: string | null;
  now: number;
}

/**
 * 构造只包含「发生变化字段」的 patch（D1 写放大控制；每 tick 无变化时不写库）。
 */
export function buildRoundPatch(input: RoundSnapshotInput): RoundChainPatch {
  const { view, config, previous, candles, burnedRaw } = input;
  const patch: RoundChainPatch = {};
  const put = <K extends keyof RoundChainPatch>(key: K, value: RoundChainPatch[K]): void => {
    patch[key] = value;
  };

  const mappedState = chainStatusToRoundState(view.status);
  if (mappedState) {
    const previousState = previous?.state ?? null;
    const terminal = previousState === 'SUCCEEDED' || previousState === 'FAILED_PERMANENT' || previousState === 'TECHNICAL_ABORTED';
    if (!terminal && previousState !== mappedState) put('state', mappedState);
  }
  if ((previous?.chain_status ?? null) !== view.status) put('chain_status', view.status);
  if ((previous?.target_tier ?? 0) !== view.targetTier) put('target_tier', view.targetTier);

  const targetPrice = view.targetPriceUsdE8.toString();
  if ((previous?.target_price_usd_e8 ?? '0') !== targetPrice) put('target_price_usd_e8', targetPrice);

  const targetTwap = view.targetTwap24hUsdE8 > 0n ? view.targetTwap24hUsdE8.toString() : null;
  if ((previous?.target_twap24h_usd_e8 ?? null) !== targetTwap) put('target_twap24h_usd_e8', targetTwap);

  const rewardBudget = (view.rewardBudgetRaw > 0n ? view.rewardBudgetRaw : BigInt(config.roundRewardRaw)).toString();
  if ((previous?.reward_budget_raw ?? '0') !== rewardBudget) put('reward_budget_raw', rewardBudget);

  const stakeOpen = secondsToMs(view.stakeOpenAt);
  if ((previous?.stake_open_at ?? null) !== stakeOpen) put('stake_open_at', stakeOpen);
  const stakeClose = secondsToMs(view.stakeCloseAt);
  if ((previous?.stake_close_at ?? null) !== stakeClose) put('stake_close_at', stakeClose);
  const obsStart = secondsToMs(view.observationStart);
  if ((previous?.observation_start ?? null) !== obsStart) put('observation_start', obsStart);
  const obsEnd = secondsToMs(view.observationEnd);
  if ((previous?.observation_end ?? null) !== obsEnd) put('observation_end', obsEnd);

  if ((previous?.candles_seen ?? 0) !== view.candlesSeen) put('candles_seen', view.candlesSeen);

  // 实际达标根数：有已落库 K 线时用真实统计（链上值被封顶），否则沿用链上值
  const qualifiedActual = candles.length
    ? candles.reduce((sum, candle) => sum + (candle.qualified === 1 ? 1 : 0), 0)
    : view.qualifiedCandles;
  if ((previous?.qualified_candles ?? 0) !== qualifiedActual) put('qualified_candles', qualifiedActual);

  const candleHash = isZeroHash(view.candleHash) ? (previous?.candle_hash ?? null) : view.candleHash;
  if ((previous?.candle_hash ?? null) !== candleHash) put('candle_hash', candleHash);

  // chain 模式 rewards.syncRoundLedgers 会整体跳过，total_weight（v10 = 总质押）由链上 get_round 写入
  const totalWeight = view.totalWeight.toString();
  if ((previous?.total_weight_raw ?? '0') !== totalWeight) put('total_weight_raw', totalWeight);

  const result = resultForStatus(view.status);
  if (result !== null && (previous?.result ?? null) !== result) put('result', result);
  if (result === 'TECHNICAL_ABORT' && (previous?.result ?? null) !== 'TECHNICAL_ABORT') put('result', 'TECHNICAL_ABORT');

  if (burnedRaw !== null && (previous?.burned_raw ?? null) !== burnedRaw) put('burned_raw', burnedRaw);

  const latest = candles.length ? candles[candles.length - 1] : null;
  const lastTwap = latest ? latest.twap_price_usd_e8 : null;
  if ((previous?.last_candle_twap_usd_e8 ?? null) !== lastTwap) put('last_candle_twap_usd_e8', lastTwap);
  const lastAt = latest ? latest.period_end : null;
  if ((previous?.last_candle_at ?? null) !== lastAt) put('last_candle_at', lastAt);

  return patch;
}

/** 把一条 SubmitCandle 链上消息转成 candles 行（coverage=时间全覆盖，来源数=1，真实不夸大）。 */
export function buildCandleRow(message: SubmitCandleMessage, targetPriceUsdE8: bigint, now: number): CandleRow {
  const twap = message.twapPriceUsdE8;
  return {
    round_id: message.roundId,
    candle_index: message.candleIndex,
    period_start: message.periodStart * 1000,
    period_end: message.periodEnd * 1000,
    twap_price_usd_e8: twap.toString(),
    qualified: twap >= targetPriceUsdE8 ? 1 : 0,
    // 合约强制 periodStart/End 精确等于 observationStart + index×candleSeconds，因此时间覆盖率 100%
    coverage_bps: 10_000,
    // 测试网为单一链上提交人（手动 keeper 模式）；不谎称多源
    valid_source_count: 1,
    data_digest: '0x' + message.dataDigest.toString(16).padStart(64, '0'),
    recorded_at: now,
  };
}

/** K 线的链上滚动哈希校验：按合约同口径重算并与 get_round.candleHash 比较。 */
export async function verifyCandleHash(candles: CandleRow[], expectedHash: string): Promise<boolean> {
  const { rollingCandleHash, bytesToHex } = await import('./boc');
  let hash: Uint8Array<ArrayBufferLike> = new Uint8Array(32);
  const ordered = [...candles].sort((a, b) => a.candle_index - b.candle_index);
  for (const candle of ordered) {
    const digest = BigInt(candle.data_digest.startsWith('0x') ? candle.data_digest : '0x' + candle.data_digest);
    hash = await rollingCandleHash(hash, candle.candle_index, BigInt(candle.twap_price_usd_e8), digest);
  }
  return '0x' + bytesToHex(hash) === expectedHash;
}
