/**
 * 真实链上数据源（只读适配器）—— **纯同步、零网络**。
 *
 * 分工（Lead 明确定死）：
 *  - 所有 toncenter 请求都在 worker/src/indexer/sync.ts 的 tick 里完成；
 *  - 本文件只读 D1 已落库的链上快照（rounds 行 + metrics 健康键），供 views/state 同步调用；
 *  - K 线由索引器从链上 SubmitCandle 消息落进 candles 表，因此 derivesCandles=false。
 *
 * 价格口径（"宁可空，不可假"）：
 *  - 现价 = 最近一根已上链 K 线 TWAP；观察期开始前回退到开窗锁定的 24h TWAP；
 *  - 两者都没有 → 返回 0n，并且 oracleStatus 报 paused（前端显示数据不可用），
 *    **绝不插值、不做正弦抖动、绝不回退 demo 值**。
 */
import type { DataSource, OracleStatus } from '@shared/types';
import type { Params } from '../protocol';
import type { BookRow, CandleRow, RoundRow, TradeRow } from '../store';
import { ApiError } from '../http';
import { toBigInt } from '../util';
import { readChainHealth } from '../indexer/health';
import type { MarketSource } from './types';

interface ChainRoundRow extends RoundRow {
  last_candle_twap_usd_e8?: string | null;
  last_candle_at?: number | null;
  target_twap24h_usd_e8?: string | null;
  chain_status?: number | null;
}

/** 链上快照里最后一根已上链 K 线 TWAP；观察期前回退到开窗 24h TWAP；都没有返回 0n。 */
function snapshotPrice(round: RoundRow): bigint {
  const row = round as ChainRoundRow;
  const last = toBigInt(row.last_candle_twap_usd_e8 ?? '0');
  if (last > 0n) return last;
  return toBigInt(row.target_twap24h_usd_e8 ?? '0');
}

function notImplementedInChainSource(feature: string): never {
  // 这些方法只在 demo 数据源（derivesCandles=true）被调用；chain 模式调到这里说明有代码路径写错了
  throw new ApiError('INTERNAL', '链上数据源不提供「' + feature + '」：K 线/价格由链上索引器落库后读取');
}

export const chainSource: MarketSource = {
  kind: 'chain' as DataSource,
  derivesCandles: false,

  buildCandle(_params: Params, _round: RoundRow, _candleIndex: number): CandleRow {
    return notImplementedInChainSource('buildCandle');
  },

  candleTwap(_params: Params, round: RoundRow, _candleIndex: number): bigint {
    void _candleIndex;
    return snapshotPrice(round);
  },

  /** 现价：最近一根已上链 K 线 TWAP（无数据返回 0n + ORACLE_PAUSED）。 */
  currentPrice(_params: Params, round: RoundRow, _now: number): bigint {
    return snapshotPrice(round);
  },

  /** 进行中 K 线：链上无「未收盘 TWAP」，这里返回最近一根已上链 K 线 TWAP，不插值。 */
  liveTwap(_params: Params, round: RoundRow, _candleIndex: number, _progressBps: number): bigint {
    return snapshotPrice(round);
  },

  /** 终态轮次展示价：最后一根已上链 K 线 TWAP。 */
  terminalPrice(_params: Params, round: RoundRow): bigint {
    return snapshotPrice(round);
  },

  /** 预言机健康：完全由索引器写入的 D1 健康键决定（同步读，无网络）。 */
  oracleStatus(params: Params, kv: Map<string, string>, now: number): OracleStatus {
    const health = readChainHealth(kv);
    const age = health.lastOkAt > 0 ? now - health.lastOkAt : Number.POSITIVE_INFINITY;
    const staleAfterMs = Math.max(2 * params.candleMs, 10 * 60 * 1000);
    const paused = params.paused || !health.healthy || health.configMismatch || age > staleAfterMs;
    const online = !paused && health.lastOkAt > 0;
    return {
      online,
      // 链上模式只有一个「链上提交者」（测试网手动 keeper）；不谎称多源
      validSources: online ? 1 : 0,
      totalSources: 1,
      coverageBps: online ? 10_000 : 0,
      configVersion: health.configHash
        ? 'chain:v' + health.configVersion + (health.configMismatch ? ':mismatch' : '')
        : 'chain:v' + health.configVersion,
      lastUpdate: health.lastOkAt > 0 ? health.lastOkAt : now,
      paused,
    };
  },

  /** 链上模式不生成成交（没有可验证的二级市场时留空，绝不用假数据填充）。 */
  buildTrades(_params: Params, _round: RoundRow, _count: number, _fromTs: number, _now: number): TradeRow[] {
    return [];
  },

  /** 链上模式不生成盘口（同上）。 */
  bookRows(_params: Params, _midUsdE8: bigint, _levels: number): BookRow[] {
    return [];
  },
};

/** 供 chain 模式预留：把链上 raw 供应量转成文本。 */
export function chainSupplyRaw(row: { total_supply?: string }): string {
  return toBigInt(row.total_supply).toString();
}
