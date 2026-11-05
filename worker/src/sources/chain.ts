/**
 * 真实链上数据源 —— 适配器桩（TODO）。
 *
 * 设计原则（见 docs/03、docs/04）：
 *  - 链上状态是唯一权威；Worker 只做只读镜像 + 缓存，不能把链下推算当成链上终态。
 *  - K 线必须来自 OracleAdapter 已验证的签名数据，不能由前端/后台自行推导。
 *  - 失败销毁必须等待 Jetton Master 的 total_supply 实际减少（BurnAck），
 *    不能仅凭 keeper 声明把轮次改成 FAILED_PERMANENT。
 *  - 预言机故障期间禁止推进达标计数，恢复后必须重新收集完整 12 根窗口。
 *
 * TODO（按优先级）：
 *  1. TON RPC：toncenter v3 / v4 读取 Jetton Master total_supply、decimals 与 RoundController 状态；
 *  2. Get methods：get_protocol_config / get_round / get_round_status / get_round_target_price /
 *     get_round_candle / get_user_stake / get_round_total_stake / get_user_reward_estimate /
 *     get_round_burn_status / get_total_burned_by_round；
 *  3. OracleAdapter：拉取 4h TWAP、coverageBps、validSourceCount、dataDigest，
 *     校验 feedId / oracleConfigVersion / validUntil / dataDigest 重放；
 *  4. 同步器：把已验证 Candle 写入 candles 表（derivesCandles=false），并把链上事件写 admin_events；
 *  5. BurnAck：核对 burn_ledger.burn_ref 与链上 burnId/amount，写入 confirmed/chain_tx_hash；
 *  6. P0 冻结校验：比较 ORACLE_CONFIG_HASH 与链上配置哈希，不一致时拒绝返回协议数据；
 *  7. 质押/领取：链上模式下 POST /api/stake、/api/claim 必须返回 501/409（只读 Worker），
 *     由前端构造 Jetton Transfer 由用户钱包签名，Worker 不做任何签名或代扣；
 *  8. 观测：为 RPC 失败、数据过期、来源不足接 ORACLE_PAUSED 状态机（已由 state.ts 实现）。
 */
import type { DataSource, OracleStatus } from '@shared/types';
import type { Params } from '../protocol';
import type { BookRow, CandleRow, RoundRow, TradeRow } from '../store';
import { ApiError } from '../http';
import { toBigInt } from '../util';
import type { MarketSource } from './types';

function notImplemented(feature: string): never {
  throw new ApiError('INTERNAL', `链上数据源尚未接入（${feature}），请配置 DATA_SOURCE=demo`);
}

export const chainSource: MarketSource = {
  kind: 'chain' as DataSource,
  derivesCandles: false,
  buildCandle(_params: Params, _round: RoundRow, _candleIndex: number): CandleRow {
    return notImplemented('buildCandle / OracleAdapter 同步');
  },
  candleTwap(_params: Params, _round: RoundRow, _candleIndex: number): bigint {
    return notImplemented('candleTwap / OracleAdapter 查询');
  },
  currentPrice(_params: Params, _round: RoundRow, _now: number): bigint {
    return notImplemented('currentPrice / DEX 行情');
  },
  liveTwap(_params: Params, _round: RoundRow, _candleIndex: number, _progressBps: number): bigint {
    return notImplemented('liveTwap / OracleAdapter 查询');
  },
  terminalPrice(_params: Params, _round: RoundRow): bigint {
    return notImplemented('terminalPrice / 链上结算快照');
  },
  oracleStatus(_params: Params, kv: Map<string, string>, now: number): OracleStatus {
    return {
      online: false,
      validSources: 0,
      totalSources: Number(kv.get('oracle_total_sources') ?? '0') || 0,
      coverageBps: 0,
      configVersion: kv.get('oracle_config_version') ?? 'unconfigured',
      lastUpdate: now,
      paused: true,
    };
  },
  buildTrades(_params: Params, _round: RoundRow, _count: number, _fromTs: number, _now: number): TradeRow[] {
    return [];
  },
  bookRows(_params: Params, _midUsdE8: bigint, _levels: number): BookRow[] {
    return [];
  },
};

/** 供 chain 模式预留：把链上 raw 供应量转成文本。 */
export function chainSupplyRaw(row: { total_supply?: string }): string {
  return toBigInt(row.total_supply).toString();
}
