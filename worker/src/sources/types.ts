/**
 * 数据适配层接口：demo 与 chain 两种数据源必须实现同一套能力。
 * store/state/views 只依赖本接口，切换 DATA_SOURCE 不需要改业务逻辑。
 */
import type { DataSource, OracleStatus } from '@shared/types';
import type { Params } from '../protocol';
import type { BookRow, CandleRow, RoundRow, TradeRow } from '../store';

export interface MarketSource {
  readonly kind: DataSource;
  /** demo=true 可按时间确定性推导 K 线；chain=false 必须由链上 indexer 同步进 candles 表 */
  readonly derivesCandles: boolean;
  /** 为一根已收盘的 K 线生成落库记录 */
  buildCandle(params: Params, round: RoundRow, candleIndex: number): CandleRow;
  /** 某根 K 线的最终 TWAP（USD_E8） */
  candleTwap(params: Params, round: RoundRow, candleIndex: number): bigint;
  /** 当前现价（USD_E8） */
  currentPrice(params: Params, round: RoundRow, now: number): bigint;
  /** 进行中 K 线的滚动 TWAP（USD_E8） */
  liveTwap(params: Params, round: RoundRow, candleIndex: number, progressBps: number): bigint;
  /** 终态轮次展示用价格（最后一根 K 线 TWAP） */
  terminalPrice(params: Params, round: RoundRow): bigint;
  /** 预言机健康快照 */
  oracleStatus(params: Params, kv: Map<string, string>, now: number): OracleStatus;
  /** 演示成交（chain 模式返回空数组，成交来自链上同步） */
  buildTrades(params: Params, round: RoundRow, count: number, fromTs: number, now: number): TradeRow[];
  /** 盘口快照（chain 模式返回空数组，深度来自链上同步） */
  bookRows(params: Params, midUsdE8: bigint, levels: number): BookRow[];
}
