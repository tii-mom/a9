/**
 * 协议常量与纯函数（不含 IO）。
 * 数值口径：金额 raw units（TOKEN_DECIMALS = 9），价格 USD_E8（1e8 = $1），时间毫秒。
 */
import type { DataSource, RoundState } from '@shared/types';

export const TOKEN_DECIMALS = 9;
export const TOKEN_SCALE = 1_000_000_000n;
export const USD_SCALE = 100_000_000n;

/** P0 = $0.00116（1 GRAM = 1000 A9，GRAM=$1.16）→ USD_E8；第 10 轮目标 = 1024 × P0 = $1.18784 */
export const P0_USD_E8 = 116_000n;
export const PRICE_MULTIPLIER = 2;
/**
 * 目标价模式（V5 待决策，先用配置开关，避免定案后改合约参数名）：
 * - FIXED_LADDER：target = P0 × 2^n（当前口径）
 * - RELATIVE_DOUBLE：target = 报名截止时的参考 TWAP × 2（方案 A，待项目方确认后启用）
 */
export type TargetMode = 'FIXED_LADDER' | 'RELATIVE_DOUBLE';
export const DEFAULT_TARGET_MODE: TargetMode = 'FIXED_LADDER';
export const ROUND_COUNT = 10;

/** 每轮奖励预算 700,000,000 A9（raw）：70% 奖励池 ÷ 10 轮 */
export const ROUND_REWARD_RAW = 700_000_000n * TOKEN_SCALE;
/** 团队额度每轮释放/销毁量 = 12% ÷ 10 轮 = 120,000,000 A9（raw） */
export const TEAM_ROUND_RAW = 120_000_000n * TOKEN_SCALE;
/** 初始总供应 10,000,000,000 A9（raw） */
export const TOTAL_SUPPLY_RAW = 10_000_000_000n * TOKEN_SCALE;

/** 真实规格：4 小时一根，共 12 根，至少 8 根达标 */
export const CANDLE_SECONDS = 3_600;
export const CANDLE_COUNT = 24;
export const MIN_QUALIFIED_CANDLES = 16;
export const OBSERVATION_SECONDS = CANDLE_SECONDS * CANDLE_COUNT;
/** 真实规格：报名窗口 72 小时（V5 口径：上一轮结算后即开启，窗口 72h） */
export const STAKE_DURATION_SECONDS = 36 * 3600;
/** 轮次间隔：上一轮结算完成后开启下一轮报名的缓冲（V5 暂定 0，价格闸门方案待定） */
export const STAKE_GAP_SECONDS = 12 * 3600; // 结算后 12h 预告期，再开启下一轮质押
export const RISK_DISCLOSURE_VERSION = 1;

/** 演示预告期：默认 90s（仅 demo，用于展示倒计时） */
export const DEFAULT_DEMO_PREVIEW_SECONDS = 90;

/** 演示加速：默认 90s / 根（wrangler.toml 可覆盖） */
export const DEFAULT_DEMO_CANDLE_SECONDS = 90;

// ---------------------------------------------------------------------------
// v10（docs/00 D-42、docs/34）：奖励纯按质押比例，没有权重 / 邀请 / 连续参与 / 滚存 / 早领 / 解锁池
// ---------------------------------------------------------------------------

/** 单笔最低有效质押（v11：1,000 A9；chain 模式以链上配置为准） */
export const MIN_STAKE_RAW = 1_000n * TOKEN_SCALE;
export const MAX_TOTAL_STAKE_RAW = 200_000_000n * TOKEN_SCALE;

/** 合约 rewardOf：floor(本轮奖励 × 我的质押 / 本轮总质押)。 */
export function rewardFor(rewardBudgetRaw: bigint, stakeRaw: bigint, totalStakeRaw: bigint): bigint {
  if (totalStakeRaw <= 0n || stakeRaw <= 0n) return 0n;
  return (rewardBudgetRaw * stakeRaw) / totalStakeRaw;
}

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

/**
 * 目标价档位（D-28 / V6.1 已确认，勿按轮次号算）：
 *   tier = 1 + 已成功轮数
 *   - 失败轮不升档：下一轮沿用同一 tier（同档重试）；
 *   - 成功轮才升档：tier += 1；
 *   - 10 轮 ≠ 10 档位（失败会占用轮次）。
 * 目标价 = P0 × 2^tier（链上开窗时再取 max(阶梯, 2 × 开窗 24h TWAP) 锁定，锁定后本轮不可改）。
 */
export function targetPriceFor(tier: number, p0: bigint = P0_USD_E8): bigint {
  return p0 * (1n << BigInt(tier));
}

export function priceMultiplierFor(tier: number): number {
  return Math.pow(PRICE_MULTIPLIER, tier);
}

/** 开轮时的档位 = 1 + 已成功轮数（D-28）。 */
export function tierForOpening(successCount: number): number {
  return successCount + 1;
}

/** 兜底推导（仅在 rounds.target_tier 为 0 的旧数据上使用）：已开启轮次 = 1 + 更早轮次中 SUCCEEDED 的数量。 */
export function tierForRound(roundId: number, rounds: { round_id: number; state: string }[]): number {
  let successes = 0;
  for (const round of rounds) {
    if (round.round_id >= roundId) continue;
    if (round.state === 'SUCCEEDED') successes++;
  }
  return successes + 1;
}

/** UNOPENED 轮次的乐观投影档位（假设更早的非失败轮次都成功），仅用于阶梯展示。 */
export function projectedTierForRound(roundId: number, rounds: { round_id: number; state: string }[]): number {
  let successes = 0;
  for (const round of rounds) {
    if (round.round_id >= roundId) continue;
    if (round.state !== 'FAILED_PERMANENT' && round.state !== 'TECHNICAL_ABORTED') successes++;
  }
  return successes + 1;
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
  /** 目标价模式（V5 待决策） */
  targetMode: TargetMode;
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
  /** 结算后到下一轮开启的预告期（秒）：demo 用 DEMO_PREVIEW_SECONDS，chain 用 12h */
  previewSeconds: number;
  /** 协议口径的预告期（秒），恒为 43200（12h），不受 demo 压缩影响；用于 /api/config 展示 */
  previewProtocolSeconds: number;
  minStakeRaw: bigint;
  maxTotalStakeRaw: bigint;
  /** B6：chain 模式缺失的关键链上配置键（非空时 API 必须 ORACLE_PAUSED，不得回退本地常量） */
  chainConfigMissing: string[];
  now: number;
}