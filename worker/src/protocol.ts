/**
 * 协议常量与纯函数（不含 IO）。
 * 数值口径：金额 raw units（TOKEN_DECIMALS = 9），价格 USD_E8（1e8 = $1），时间毫秒。
 */
import type { DataSource, RoundState } from '@shared/types';

export const TOKEN_DECIMALS = 9;
export const TOKEN_SCALE = 1_000_000_000n;
export const USD_SCALE = 100_000_000n;

/** P0 = $0.001 → USD_E8（V3：第 10 轮目标 = 1024 × P0 = $1.024） */
export const P0_USD_E8 = 100_000n;
export const PRICE_MULTIPLIER = 2;
export const ROUND_COUNT = 10;

/** 每轮奖励预算 700,000,000 A9（raw）：70% 奖励池 ÷ 10 轮 */
export const ROUND_REWARD_RAW = 700_000_000n * TOKEN_SCALE;
/** 团队额度每轮释放/销毁量 = 12% ÷ 10 轮 = 120,000,000 A9（raw） */
export const TEAM_ROUND_RAW = 120_000_000n * TOKEN_SCALE;
/** 初始总供应 10,000,000,000 A9（raw） */
export const TOTAL_SUPPLY_RAW = 10_000_000_000n * TOKEN_SCALE;

/** 真实规格：4 小时一根，共 12 根，至少 8 根达标 */
export const CANDLE_SECONDS = 14_400;
export const CANDLE_COUNT = 12;
export const MIN_QUALIFIED_CANDLES = 8;
export const OBSERVATION_SECONDS = CANDLE_SECONDS * CANDLE_COUNT;
/** 真实规格：报名窗口 48 小时（V3 决策：上一轮结算后 48h 开启，窗口 48h） */
export const STAKE_DURATION_SECONDS = 48 * 3600;
/** 轮次间隔：上一轮结算完成后 48 小时开启下一轮报名 */
export const STAKE_GAP_SECONDS = 48 * 3600;
export const RISK_DISCLOSURE_VERSION = 1;

/** 演示加速：默认 90s / 根（wrangler.toml 可覆盖） */
export const DEFAULT_DEMO_CANDLE_SECONDS = 90;

export const TERMINAL_STATES: readonly RoundState[] = [
  'SUCCEEDED',
  'FAILED_PERMANENT',
  'TECHNICAL_ABORTED',
];

export function isTerminal(state: RoundState | string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** 已开启但未终态（参与「本轮进行中」聚合） */
export function isActive(state: RoundState | string): boolean {
  return (
    state === 'STAKING_OPEN' ||
    state === 'STAKING_CLOSED' ||
    state === 'OBSERVING' ||
    state === 'ORACLE_PAUSED' ||
    state === 'SETTLING_SUCCESS' ||
    state === 'SETTLING_FAILURE'
  );
}

export function targetPriceFor(roundId: number, p0: bigint = P0_USD_E8): bigint {
  return p0 * (1n << BigInt(roundId));
}

export function priceMultiplierFor(roundId: number): number {
  return Math.pow(PRICE_MULTIPLIER, roundId);
}

/** 一轮协议参数的运行时快照（由 config/metrics + env 合并得出）。 */
export interface Params {
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  p0UsdE8: bigint;
  usdPriceScale: number;
  priceMultiplier: number;
  roundCount: number;
  roundRewardRaw: bigint;
  totalSupplyRaw: bigint;
  /** 真实规格 4h */
  candleSeconds: number;
  candleCount: number;
  minQualifiedCandles: number;
  riskDisclosureVersion: number;
  /** 真实规格报名窗口（秒）：48h */
  stakeDurationSeconds: number;
  /** 轮次间隔（秒）：上一轮结算后 48h 开启下一轮 */
  stakeGapSeconds: number;
  /** 团队每轮额度（raw）：达标释放、失败销毁 */
  teamRoundRaw: bigint;
  observationSeconds: number;
  dataSource: DataSource;
  network: 'mainnet' | 'testnet' | 'demo';
  /** 演示模式下 1 根 K 线秒数 */
  demoCandleSeconds: number;
  /** 实际使用的 K 线长度（毫秒）：demo → demoCandleSeconds，chain → candleSeconds */
  candleMs: number;
  demoEpochMs: number;
  tonUsdE8: string;
  tonConnectManifestUrl: string | null;
  /** 预言机是否暂停 */
  paused: boolean;
  /** 演示钱包余额（raw） */
  demoWalletBalanceRaw: bigint;
  /** DEMO_AUTOPLAY：演示模式下自动开下一轮 / 十轮结束后重置演示（chain 模式强制关闭） */
  autoplay: boolean;
  /** DEMO_STAKE_SECONDS：演示模式质押窗口时长（秒） */
  demoStakeSeconds: number;
  now: number;
}