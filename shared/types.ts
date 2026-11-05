/**
 * A9 引信协议 — 前后端共享 API 契约
 * 所有金额均为「raw units」字符串（避免 JS number 精度问题）。
 * 价格统一为 USD_E8（1e8 = $1.00）。
 * 本文件由 web/ 与 worker/ 同时引用，修改时必须两端口径一致。
 */

export type RoundState =
  | 'UNOPENED'
  | 'STAKING_OPEN'
  | 'STAKING_CLOSED'
  | 'OBSERVING'
  | 'ORACLE_PAUSED'
  | 'SETTLING_SUCCESS'
  | 'SETTLING_FAILURE'
  | 'SUCCEEDED'
  | 'FAILED_PERMANENT'
  | 'TECHNICAL_ABORTED';

export type DataSource = 'demo' | 'chain';

export interface ProtocolConfig {
  token: { name: string; symbol: string; decimals: number };
  /** 初始参考价，USD_E8 */
  p0UsdE8: string;
  usdPriceScale: number;
  priceMultiplier: number;
  roundCount: number;
  /** 每轮奖励预算，raw units */
  roundRewardRaw: string;
  totalSupplyRaw: string;
  candleSeconds: number;
  candleCount: number;
  minQualifiedCandles: number;
  riskDisclosureVersion: number;
  stakeDurationSeconds: number;
  observationSeconds: number;
  network: 'mainnet' | 'testnet' | 'demo';
  dataSource: DataSource;
  demo: { candleSeconds: number; speed: number; epochMs: number } | null;
  contracts: {
    jettonMaster: string | null;
    roundController: string | null;
    stakingVault: string | null;
    rewardVault: string | null;
    oracleAdapter: string | null;
    codeHash: string | null;
    oracleConfigHash: string | null;
    /** 管理员 owner（单密钥，项目不设多签） */
    adminOwner: string | null;
    /** 团队额度托管合约地址（TeamVault，持有 12 亿） */
    teamVault: string | null;
    /** 团队收款钱包（每轮成功由 TeamVault 转入 1.2 亿） */
    teamWallet: string | null;
    auditReportUrl: string | null;
  };
  tonConnectManifestUrl: string | null;
  /** TON/USD 报价汇率，USD_E8（"300000000" = $3.00）。演示环境固定，主网上线后改为预言机/行情源 */
  tonUsdE8: string;
  /** 上线阻断项完成度：已冻结/待确认 */
  frozenParams: { key: string; label: string; status: 'frozen' | 'pending'; value: string }[];
}

export interface RoundSummary {
  roundId: number;
  state: RoundState;
  priceMultiplier: number;
  targetPriceUsdE8: string;
  rewardBudgetRaw: string;
  stakeOpenAt: number | null;
  stakeCloseAt: number | null;
  observationStart: number | null;
  observationEnd: number | null;
  candlesSeen: number;
  qualifiedCandles: number;
  totalAcceptedStakeRaw: string;
  stakerCount: number;
  result: 'SUCCESS' | 'FAILURE' | 'TECHNICAL_ABORT' | null;
  burnedRaw: string | null;
  /** 最近一次更新的 unix ms */
  updatedAt: number;
}

export interface Candle {
  roundId: number;
  candleIndex: number;
  periodStart: number;
  periodEnd: number;
  twapPriceUsdE8: string;
  qualified: boolean;
  coverageBps: number;
  validSourceCount: number;
  dataDigest: string;
}

export interface RoundDetail extends RoundSummary {
  candles: Candle[];
  /** 当前正在累计的 K 线（未收盘）*/
  live: { candleIndex: number; twapPriceUsdE8: string; progressBps: number; qualifiedTentative: boolean } | null;
  /** 当前现价 */
  priceUsdE8: string;
  /** 距离下一阶段还剩秒数 */
  secondsRemaining: number | null;
  nextState: RoundState | null;
}

export interface LeaderboardRow {
  rank: number;
  address: string;
  amountRaw: string;
  shareBps: number;
  rewardEstimateRaw: string;
  acceptedAt: number;
}

export interface Trade {
  id: number;
  ts: number;
  side: 'BUY' | 'SELL';
  amountRaw: string;
  priceUsdE8: string;
  valueUsdE8: string;
  big: boolean;
}

export interface OrderBookLevel {
  priceUsdE8: string;
  amountRaw: string;
  cumulativePct: number;
}

export interface OrderBook {
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  midUsdE8: string;
}

export interface OracleStatus {
  online: boolean;
  validSources: number;
  totalSources: number;
  coverageBps: number;
  configVersion: string;
  lastUpdate: number;
  paused: boolean;
}

export interface ProtocolStats {
  supplyRaw: string;
  burnedRaw: string;
  lockedStakeRaw: string;
  stakerCount: number;
  volume24hUsdE8: string;
  liquidityUsdE8: string;
  priceUsdE8: string;
  price24hAgoUsdE8: string;
  oracle: OracleStatus;
}

export interface StakePosition {
  roundId: number;
  address: string;
  amountRaw: string;
  weightRaw: string;
  principalClaimed: boolean;
  rewardClaimed: boolean;
  acceptedAt: number;
}

export interface Claimable {
  roundId: number;
  principalRaw: string;
  rewardRaw: string;
  state: RoundState;
}

export interface MeResponse {
  address: string;
  stakes: StakePosition[];
  claimable: Claimable[];
  totals: { stakedRaw: string; rewardRaw: string; claimedRaw: string };
}

export interface AdminOverview {
  rounds: RoundSummary[];
  events: AdminEvent[];
  oracle: OracleStatus;
  stats: ProtocolStats;
  worker: { uptimeSeconds: number; now: number; dataSource: DataSource; demoCandleSeconds: number | null };
}

export interface AdminEvent {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  actor: string;
  action: string;
  detail: string;
}

export interface HealthResponse {
  ok: boolean;
  now: number;
  db: boolean;
  dataSource: DataSource;
  version: string;
  uptimeSeconds: number;
}

export type ApiOk<T> = { ok: true; data: T; ts: number };
export type ApiErr = { ok: false; error: { code: string; message: string } };
export type ApiResponse<T> = ApiOk<T> | ApiErr;

export const ENDPOINTS = {
  health: '/api/health',
  config: '/api/config',
  stats: '/api/stats',
  rounds: '/api/rounds',
  round: (id: number) => `/api/rounds/${id}`,
  candles: (id: number) => `/api/rounds/${id}/candles`,
  leaderboard: (id: number) => `/api/rounds/${id}/leaderboard`,
  trades: '/api/trades',
  book: '/api/book',
  me: (address: string) => `/api/me?address=${encodeURIComponent(address)}`,
  stake: '/api/stake',
  claim: '/api/claim',
  adminOverview: '/api/admin/overview',
  adminTick: '/api/admin/tick',
  adminPauseOracle: '/api/admin/oracle/pause',
  adminResumeOracle: '/api/admin/oracle/resume',
  adminAdvance: '/api/admin/rounds/advance'
} as const;