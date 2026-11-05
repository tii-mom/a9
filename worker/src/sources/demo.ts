/**
 * 演示数据源：全部数值由 (roundId, candleIndex, epoch) 确定性推导，
 * 因此 cron / admin tick / 页面请求可以各自独立推进而结果一致（幂等）。
 *
 * 判定规则与真实规则完全一致：TWAP >= target 记达标，12 根中 >= 8 根达标则成功。
 * 演示加速只改变“一根 K 线走完需要多少真实秒数”（DEMO_CANDLE_SECONDS），不改变阈值与销毁语义。
 */
import type { OracleStatus } from '@shared/types';
import type { Params } from '../protocol';
import { CANDLE_COUNT } from '../protocol';
import type { BookRow, CandleRow, RoundRow, TradeRow } from '../store';
import { clampInt, toBigInt, toHex32 } from '../util';
import type { MarketSource } from './types';

/** 每轮演示用的达标 K 线下标（R1 10/12 成功、R2 6/12 失败、R3+ 9/12 成功）。 */
const QUALIFIED_PATTERN: Record<number, number[]> = {
  // 24 根：R1 20 根达标（成功）、R2 12 根达标（失败）
  1: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19],
  2: [0,2,4,6,8,10,12,14,16,18,20,22],
};
/**
 * R3+ 默认模式：前 12 根 8 根达标（与 seed 一致），后 12 根再补 9 根 → 共 17/24 达标（成功），
 * 用于演示「观察期继续推进后可能通过」。
 */
const DEFAULT_PATTERN = [0,1,2,4,6,7,8,10,12,13,14,15,16,17,18,19,20];

function patternFor(roundId: number): number[] {
  return QUALIFIED_PATTERN[roundId] ?? DEFAULT_PATTERN;
}

function hash32(...parts: number[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    let x = part >>> 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
      x >>>= 8;
    }
  }
  return h >>> 0;
}

/** 单次确定性随机 [0,1)。 */
function rand01(seed: number): number {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function isQualified(roundId: number, candleIndex: number): boolean {
  return patternFor(roundId).includes(candleIndex);
}

/** 某根 K 线的最终 TWAP：达标线上下 0.2%~6% 的确定性偏移。 */
function candleTwap(params: Params, round: RoundRow, candleIndex: number): bigint {
  const target = toBigInt(round.target_price_usd_e8);
  const qualified = isQualified(round.round_id, candleIndex);
  const r = rand01(hash32(round.round_id, candleIndex, 11));
  const deltaBps = qualified ? 20 + Math.floor(r * 380) : -(60 + Math.floor(r * 640));
  const delta = (target * BigInt(deltaBps)) / 10000n;
  return target + delta;
}

function buildCandle(params: Params, round: RoundRow, candleIndex: number): CandleRow {
  const start = round.observation_start ?? params.now;
  const periodStart = start + candleIndex * params.candleMs;
  const periodEnd = periodStart + params.candleMs;
  const r = rand01(hash32(round.round_id, candleIndex, 23));
  const digest = ['a', 'b'].map((salt, i) =>
    toHex32(hash32(round.round_id, candleIndex, salt.charCodeAt(0), i)) +
    toHex32(hash32(round.round_id, candleIndex, salt.charCodeAt(0) + 7, i)),
  ).join('');
  return {
    round_id: round.round_id,
    candle_index: candleIndex,
    period_start: periodStart,
    period_end: periodEnd,
    twap_price_usd_e8: candleTwap(params, round, candleIndex).toString(),
    qualified: isQualified(round.round_id, candleIndex) ? 1 : 0,
    coverage_bps: 9700 + Math.floor(r * 290),
    valid_source_count: 4 + (r > 0.5 ? 1 : 0),
    data_digest: '0x' + digest,
    recorded_at: params.now,
  };
}

/** 进行中 K 线的滚动 TWAP：上一根收盘值 → 本轮收盘值的线性插值。 */
function liveTwap(params: Params, round: RoundRow, candleIndex: number, progressBps: number): bigint {
  const target = toBigInt(round.target_price_usd_e8);
  const current = candleTwap(params, round, candleIndex);
  const previous = candleIndex > 0 ? candleTwap(params, round, candleIndex - 1) : (target * 995n) / 1000n;
  const progress = BigInt(clampInt(progressBps, 0, 9999));
  return previous + ((current - previous) * progress) / 10000n;
}

/** 当前现价：K 线路径 + ±1.5% 正弦抖动，观感接近真实行情但不影响判定。 */
function currentPrice(params: Params, round: RoundRow, now: number): bigint {
  const target = toBigInt(round.target_price_usd_e8);
  const start = round.observation_start;
  if (start === null || start === undefined || now < start) {
    // 报名期：价格在目标价的 47% 附近缓慢漂移
    const wobble = 1 + 0.008 * Math.sin(now / 47000 + round.round_id * 1.3);
    const factor = BigInt(Math.round(wobble * 1000));
    return ((target * 47n) / 100n * factor) / 1000n;
  }
  const elapsed = Math.max(0, now - start);
  const rawIndex = Math.floor(elapsed / Math.max(1, params.candleMs));
  const index = clampInt(rawIndex, 0, CANDLE_COUNT - 1);
  const frac = params.candleMs > 0 ? (elapsed % params.candleMs) / params.candleMs : 1;
  const current = candleTwap(params, round, index);
  const previous = index > 0 ? candleTwap(params, round, index - 1) : (target * 995n) / 1000n;
  const progress = BigInt(Math.round(frac * 10000));
  const base = previous + ((current - previous) * progress) / 10000n;
  const wobbleBps = Math.round(150 * Math.sin(now / 19000 + index * 1.7));
  return base + (base * BigInt(wobbleBps)) / 10000n;
}

function terminalPrice(params: Params, round: RoundRow): bigint {
  return candleTwap(params, round, CANDLE_COUNT - 1);
}

function oracleStatus(params: Params, kv: Map<string, string>, now: number): OracleStatus {
  const paused = params.paused;
  const totalSources = Number(kv.get('oracle_total_sources') ?? '5') || 5;
  const validSources = paused ? 0 : Number(kv.get('oracle_valid_sources') ?? '5') || 5;
  const coverageBps = paused ? 0 : Number(kv.get('oracle_coverage_bps') ?? '9950') || 9950;
  const pausedAt = Number(kv.get('oracle_paused_at') ?? '0') || now;
  return {
    online: !paused && validSources >= 3,
    validSources,
    totalSources,
    coverageBps,
    configVersion: kv.get('oracle_config_version') ?? 'v1.0.0-demo',
    lastUpdate: paused ? pausedAt : Math.max(0, now - 2500),
    paused,
  };
}

/**
 * 演示成交：主体 2,000 ~ 200,000 A9（对齐原型 2k~200k），约 10% 为 30 万+ 大单并标记 big。
 * 成交额 = amountRaw × price / 1e9（USD_E8），与价格自洽。
 */
function buildTrades(params: Params, round: RoundRow, count: number, fromTs: number, now: number): TradeRow[] {
  const target = toBigInt(round.target_price_usd_e8);
  const rows: TradeRow[] = [];
  const baseTs = Math.max(fromTs, now - count * 1000);
  for (let i = 0; i < count; i++) {
    const seed = hash32(round.round_id, Math.floor(baseTs / 1000), i, 31);
    const r1 = rand01(seed);
    const r2 = rand01(hash32(seed, 3));
    const r3 = rand01(hash32(seed, 5));
    const whale = rand01(hash32(seed, 7)) > 0.9;
    const ts = now - Math.floor((count - i) * (14000 + r1 * 26000));
    const tokens = whale ? 300_000 + Math.floor(r2 * 150_000) : 2_000 + Math.floor(r2 * 198_000);
    const priceBps = Math.round((r3 - 0.5) * 240); // ±1.2%
    const price = target + (target * BigInt(priceBps)) / 10000n;
    const amountRaw = BigInt(tokens) * 1_000_000_000n;
    const valueUsdE8 = (amountRaw * price) / 1_000_000_000n;
    rows.push({
      id: 0,
      ts,
      side: r1 > 0.45 ? 'BUY' : 'SELL',
      amount_raw: amountRaw.toString(),
      price_usd_e8: price.toString(),
      value_usd_e8: valueUsdE8.toString(),
      big: tokens >= 300_000 ? 1 : 0,
    });
  }
  return rows;
}

/** 盘口快照：围绕 mid 的 10 档买卖，价差 0.06%/档。 */
function bookRows(params: Params, midUsdE8: bigint, levels: number): BookRow[] {
  const rows: BookRow[] = [];
  for (let i = 0; i < levels; i++) {
    const seedAsk = hash32(7, i, 41);
    const seedBid = hash32(7, i, 43);
    const askPrice = midUsdE8 + (midUsdE8 * BigInt(6 * (i + 1))) / 10000n;
    const bidPrice = midUsdE8 - (midUsdE8 * BigInt(6 * (i + 1))) / 10000n;
    // 档位量级对齐原型：40,000 ~ 300,000 A9 / 档
    const askAmount = BigInt(40_000 + Math.floor(rand01(seedAsk) * 260_000)) * 1_000_000_000n;
    const bidAmount = BigInt(40_000 + Math.floor(rand01(seedBid) * 260_000)) * 1_000_000_000n;
    rows.push({ id: 0, side: 'ask', price_usd_e8: askPrice.toString(), amount_raw: askAmount.toString(), seq: i });
    rows.push({ id: 0, side: 'bid', price_usd_e8: bidPrice.toString(), amount_raw: bidAmount.toString(), seq: i });
  }
  return rows;
}

export const demoSource: MarketSource = {
  kind: 'demo',
  derivesCandles: true,
  buildCandle,
  candleTwap,
  currentPrice,
  liveTwap,
  terminalPrice,
  oracleStatus,
  buildTrades,
  bookRows,
};