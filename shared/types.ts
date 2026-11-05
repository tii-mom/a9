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
  /** PREVIEW 等待（结算后到下一轮报名开启），秒；R1 无 PREVIEW */
  previewSeconds: number;
  // ---- V8 权重制 / 奖励三态 / 邀请 / 解锁（docs/17，合约 V8 已定稿） ----
  /** 连续参与每轮权重加成（bps）：1000 = +10% */
  streakBonusBps: number;
  /** 连续参与加成封顶轮次：10（最高 +100% = 2.00×） */
  streakMaxRounds: number;
  /** 直接邀请人权重加成（bps）：2000 = 被邀请人质押的 20% */
  referralBonusBps: number;
  /** 邀请加成封顶 = 邀请人自己质押额的比例（bps）：10000 = 1.0× */
  referralCapMultiple: number;
  /** 早领罚没（bps）：5000 = 立即领 50%，另 50% 进入解锁池 */
  earlyClaimPenaltyBps: number;
  /** 单地址单轮滚存上限（raw units）：2000 万 A9 */
  rolloverCapPerAddressRaw: string;
  /** R10 终态后线性解锁时长（秒）：12 × 30 天 */
  unlockDurationSeconds: number;
  network: 'mainnet' | 'testnet' | 'demo';
  dataSource: DataSource;
  demo: { candleSeconds: number; speed: number; epochMs: number; previewSeconds: number } | null;
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
  /** V8：本轮总权重 Σ(own weight + 邀请加成) */
  totalWeightRaw: string;
  /** V8：K 线滚动哈希（链上只存这一个值；逐条 K 线在链下 API/归档） */
  candleHash: string | null;
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

// ---- V8：奖励三态 / 权重 / 邀请 / 解锁 ----

/** 奖励状态：0 PENDING（不动，锁到 R10 后）/ 1 ROLLED（全额滚存进下一轮）/ 2 EARLY（早领 50%） */
export type RewardStateCode = 0 | 1 | 2;

/** 单个 (用户, 轮次) 的奖励三态信息（对齐合约 get_reward_state） */
export interface RoundReward {
  roundId: number;
  state: RewardStateCode;
  /** 本轮应得奖励（PENDING 且未领时为待领取额；已滚存/已早领后为原始应得额） */
  amountRaw: string;
  /** 可滚存额度（PENDING 且下一轮为 PREVIEW/STAKING_OPEN 时 > 0；已按 2000 万上限/轮次上限截断） */
  rollableRaw: string;
  /** 早领可得（floor(amount / 2)） */
  earlyAmountRaw: string;
  /** 已早领到账金额 */
  paidRaw: string;
  /** 进入 R10 后解锁池的金额（早领的另一半 / 滚存超上限部分 / 未领取 PENDING） */
  lockedRaw: string;
  /** 已滚存进下一轮质押的金额 */
  rolledRaw: string;
}

/** 解锁池信息（对齐合约 get_unlock_info）：R10 任一终态后开始 12×30 天线性释放 */
export interface UnlockInfo {
  active: boolean;
  /** 解锁开始时间 unix ms；0 = 未开始 */
  unlockStart: number;
  endAt: number;
  durationSeconds: number;
  totalLockedRaw: string;
  claimedRaw: string;
  claimableRaw: string;
  /** 已解锁进度 0..10000（按时间线性） */
  progressBps: number;
}

/** 用户邀请关系与加成（对齐合约 get_referral） */
export interface ReferralInfo {
  referrer: string | null;
  /** 直接邀请人数（一层） */
  invitedCount: number;
  /** 被邀请人本轮有效质押额 */
  invitedStakeRaw: string;
  /** 本轮我作为邀请人获得的权重加成（raw units） */
  bonusThisRoundRaw: string;
  /** 历史累计邀请加成（raw units） */
  bonusTotalRaw: string;
}

/** GET /api/referral/:address —— 邀请关系与加成明细 */
export interface ReferralResponse {
  address: string;
  referrer: string | null;
  /** 绑定时间 unix ms（未绑定为 null） */
  boundAt: number | null;
  invitees: { address: string; roundId: number; stakeRaw: string; bonusRaw: string }[];
  invitedCount: number;
  /** 被邀请人本轮有效质押合计 */
  invitedStakeRaw: string;
  /** 本轮我获得的邀请加成 */
  bonusThisRoundRaw: string;
  /** 历史累计邀请加成 */
  bonusTotalRaw: string;
  config: { referralBonusBps: number; referralCapMultiple: number; minStakeRaw: string };
}

export interface ProtocolStats {
  supplyRaw: string;
  burnedRaw: string;
  lockedStakeRaw: string;
  stakerCount: number;
  volume24hUsdE8: string;
  /** chain 模式下拿不到真实池子流动性时为 null（宁可空，不可假） */
  liquidityUsdE8: string | null;
  priceUsdE8: string;
  /** chain 模式下拿不到 24h 前真实 TWAP 时为 null（宁可空，不可假） */
  price24hAgoUsdE8: string | null;
  oracle: OracleStatus;
  /** 下一轮质押预计开启时间（unix ms）；无活跃轮次时为结算时间 + 预告期，否则为 null */
  nextStakeOpenAt: number | null;
  /** V8：已进入 R10 后解锁池的奖励总额（raw units） */
  lockedRewardRaw: string;
  /** V8：解锁池全局进度（R10 终态后线性 12 个月） */
  unlock: UnlockInfo;
}

export interface StakePosition {
  roundId: number;
  address: string;
  amountRaw: string;
  /** V8 own weight（含 streak 加成，不含邀请加成） */
  weightRaw: string;
  /** V8 权重倍数 bps（weightRaw / amountRaw × 10000，约 11000..20000） */
  weightMultiplierBps: number;
  /** V8 本轮质押时的连续轮次 */
  streak: number;
  /** V8 本轮奖励状态（0/1/2） */
  rewardState: RewardStateCode;
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
  /** V8：每轮奖励三态（含可滚存 / 早领可得 / 已锁定额） */
  rewards: RoundReward[];
  /** V8：连续参与（streak）与当前权重倍数 */
  stake: { lastRound: number; count: number; weightMultiplierBps: number };
  /** V8：邀请关系与加成 */
  referral: ReferralInfo;
  /** V8：R10 后线性解锁进度 */
  unlock: UnlockInfo;
  totals: { stakedRaw: string; rewardRaw: string; claimedRaw: string; lockedRewardRaw: string };
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

/** TON Connect ton_proof：写接口（stake/claim）签名校验用 */
export interface TonProof {
  /** unix 秒 */
  timestamp: number;
  domain: { lengthBytes: number; value: string };
  /** 服务端下发的一次性 nonce（GET /api/auth/nonce） */
  payload: string;
  /** ed25519 签名（base64） */
  signature: string;
  /** 公钥（hex）；严格版应从 state_init 解析（TODO chain 模式） */
  publicKey: string;
  stateInit?: string;
}

/** GET /api/auth/nonce 返回：5 分钟有效、一次性使用 */
export interface AuthNonceResponse {
  address: string;
  nonce: string;
  expiresAt: number;
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
  authNonce: (address: string) => `/api/auth/nonce?address=${encodeURIComponent(address)}`,
  referral: (address: string) => `/api/referral/${encodeURIComponent(address)}`,
  stake: '/api/stake',
  claim: '/api/claim',
  adminOverview: '/api/admin/overview',
  adminTick: '/api/admin/tick',
  adminPauseOracle: '/api/admin/oracle/pause',
  adminResumeOracle: '/api/admin/oracle/resume',
  adminAdvance: '/api/admin/rounds/advance'
} as const;