/**
 * A9 引信协议 — 前后端共享 API 契约
 * 所有金额均为「raw units」字符串（避免 JS number 精度问题）。
 * 价格统一为 USD_E8（1e8 = $1.00）。
 * 本文件由 web/ 与 worker/ 同时引用，修改时必须两端口径一致。
 */

/**
 * 轮次状态。v10 合约（docs/34）链上只会出现 0/1/2/4/8/9/10，对应
 * UNOPENED（含 PREVIEW）/ STAKING_OPEN / OBSERVING / SUCCEEDED / FAILED_PERMANENT / TECHNICAL_ABORTED；
 * STAKING_CLOSED / ORACLE_PAUSED / SETTLING_* 只在 demo 数据源的本地状态机里短暂出现。
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
  /** 单笔最低有效质押，raw units（v10：100,000 A9） */
  minStakeRaw: string;
  /** 每轮团队额度，raw units（成功轮 RC 直接转团队钱包；失败轮随本轮一起销毁） */
  teamRoundRaw: string;
  network: 'mainnet' | 'testnet' | 'demo';
  dataSource: DataSource;
  demo: { candleSeconds: number; speed: number; epochMs: number; previewSeconds: number } | null;
  contracts: {
    jettonMaster: string | null;
    roundController: string | null;
    stakingVault: string | null;
    rewardVault: string | null;
    codeHash: string | null;
    oracleConfigHash: string | null;
    /** v10 唯一运营密钥（开轮 / 提交 K 线）；合约没有 admin */
    keeper: string | null;
    /** 团队收款钱包（每轮成功由 RoundController 直接转入 1.2 亿） */
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
  /** K 线滚动哈希（链上只存这一个值；逐条 K 线在链下 API/归档） */
  candleHash: string | null;
  stakerCount: number;
  result: 'SUCCESS' | 'FAILURE' | 'TECHNICAL_ABORT' | null;
  /**
   * 本轮已确认销毁总额：失败轮 = 7 亿奖励 + 1.2 亿团队 + 本轮全部质押（v10 一笔 burn）；
   * 0 质押成功轮 = 7 亿奖励；其他为 null
   */
  burnedRaw: string | null;
  /** 成功轮已转团队钱包的 1.2 亿（RoundSettled.teamReleasedRaw）；未结算 / 失败 / 转账被退回待重试为 null */
  teamReleasedRaw: string | null;
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
  /** chain 模式下拿不到真实池子流动性时为 null（宁可空，不可假） */
  liquidityUsdE8: string | null;
  priceUsdE8: string;
  /** chain 模式下拿不到 24h 前真实 TWAP 时为 null（宁可空，不可假） */
  price24hAgoUsdE8: string | null;
  oracle: OracleStatus;
  /** 下一轮质押预计开启时间（unix ms）；无活跃轮次时为结算时间 + 预告期，否则为 null */
  nextStakeOpenAt: number | null;
}

/** 单个 (用户, 轮次) 的仓位（v10：奖励按质押比例，一次 Claim 同时领本金 + 全额奖励）。 */
export interface StakePosition {
  roundId: number;
  address: string;
  /** 本轮质押本金 */
  amountRaw: string;
  /** 本轮全额奖励：仅 SUCCEEDED 时 = floor(本轮奖励 × 我的质押 / 总质押)，其他状态 "0" */
  rewardRaw: string;
  /** 本轮状态 */
  state: RoundState;
  /** 已领取（本金 + 奖励一起） */
  claimed: boolean;
  /** 现在可领取：SUCCEEDED（本金 + 奖励）或 TECHNICAL_ABORTED（只退本金）且未领取 */
  claimable: boolean;
  acceptedAt: number;
}

/** 可领取条目；roundId = 0 表示退款账本（state 固定 'UNOPENED'，rewardRaw "0"）。 */
export interface Claimable {
  roundId: number;
  principalRaw: string;
  rewardRaw: string;
  state: RoundState;
}

/** 退款账本（合约 round 0）：质押失败且未即时退回的金额，用 Claim(0) 或 ClaimAll 领回。 */
export interface RefundLedger {
  /** 当前待领余额 */
  pendingRaw: string;
  /** 历史累计记入 */
  creditedRaw: string;
  /** 历史累计已领 */
  claimedRaw: string;
}

export interface MeResponse {
  address: string;
  stakes: StakePosition[];
  claimable: Claimable[];
  refund: RefundLedger;
  /** 与链上 get_claimable_all 同口径：ClaimAll 现在会付的金额；roundsMask bit r-1 = 第 r 轮，bit 15 = 退款账本 */
  claimableAll: { principalRaw: string; rewardRaw: string; roundsMask: number };
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
  stake: '/api/stake',
  claim: '/api/claim',
  adminOverview: '/api/admin/overview',
  adminTick: '/api/admin/tick',
  adminPauseOracle: '/api/admin/oracle/pause',
  adminResumeOracle: '/api/admin/oracle/resume',
  adminAdvance: '/api/admin/rounds/advance'
} as const;

/* ------------------------------------------------------------------ *
 * 社交层（docs/35 §4，链下）：/api/social/*、/s/:code、/og/:code.png
 * 金额一律 raw 字符串；比例 bps；USD 为 number（展示用）。
 * ------------------------------------------------------------------ */

export type SocialSource = 'tg' | 'x' | 'web';

/** 城门阶段：preview 预告 / staking 报名 / observing 观察 / settled 已结算（成功或失败） */
export type SocialRoundPhase = 'preview' | 'staking' | 'observing' | 'settled';

export type SocialLeaderboardType = 'squad' | 'power' | 'recruit';
export type SocialLeaderboardScope = 'round' | 'season';

export interface SocialSquadBrief {
  code: string;
  name: string;
  /** 0 = 未成团，1..4 = Lv1..Lv4（按本城上车人数 stakersThisRound） */
  level: number;
  /** 成员总数（users.squad_code 计数，与等级无关）；展示文案用「成员」 */
  memberCount: number;
  /** 本城（当前轮）上车人数，distinct 报名地址；展示文案用「本城上车」，等级与 remainingToNext 都按它算 */
  stakersThisRound: number;
  /** 下一等级（1..4）；已满级为 null */
  nextLevel: number | null;
  /** 距下一等级还差几人 = 下一档门槛 − stakersThisRound；已满级为 null */
  remainingToNext: number | null;
}

export interface SocialSquadDetail extends SocialSquadBrief {
  leaderWallet: string | null;
  tgChatId: string | null;
}

/** GET /api/social/me */
export interface SocialMeResponse {
  wallet: string;
  inviteCode: string;
  referrer: string | null;
  squad: SocialSquadBrief | null;
  stats: {
    /** 当前轮战力（raw，字符串） */
    power: string;
    recruits: number;
    recruitsFromX: number;
    /** 阵亡勋章 = 本人报名过的失败轮数 */
    medals: number;
    /** 截至最新轮的连续报名轮数 */
    streak: number;
  };
}

/** POST /api/social/bind */
export interface SocialBindRequest {
  wallet: string;
  referralCode?: string;
  squadCode?: string;
  source: SocialSource;
  /** Telegram WebApp.initData 原文；服务端校验后取得 tgUserId（请求体不接受 tgUserId） */
  tgInitData?: string;
  /** TON Proof（写接口鉴权）；也可放在 X-Ton-Proof 头（base64 JSON） */
  proof?: TonProof;
}

export interface SocialBindResponse {
  wallet: string;
  inviteCode: string;
  referrer: string | null;
  refSource: SocialSource | null;
  squad: SocialSquadBrief | null;
  /** 本次请求是否真正写入了邀请人 / 战队 */
  bound: { referrer: boolean; squad: boolean };
  /** 业务规则拒绝原因（不影响 200 返回）；null = 无拒绝 */
  rejected: { referral: string | null; squad: string | null };
}

/** POST /api/social/squads（创建者自动成为团长并入队） */
export interface SocialSquadCreateRequest {
  wallet: string;
  name: string;
  tgChatId?: string;
  proof?: TonProof;
}

/** POST /api/social/squads/:code/join */
export interface SocialSquadJoinRequest {
  wallet: string;
  proof?: TonProof;
}

/** POST /api/social/squads 与 POST /api/social/squads/:code/join */
export interface SocialSquadResponse {
  squad: SocialSquadDetail;
  /** 本次请求是否改变了该用户的战队归属 */
  changed: boolean;
}

export interface SocialLeaderboardRow {
  rank: number;
  /** 战队码（type=squad）或脱敏钱包（其它类型） */
  key: string;
  name: string | null;
  /** power：战力 raw；recruit：拉新积分（X 来源 ×2）；squad：全队战力 raw */
  score: string;
}

/** GET /api/social/leaderboard（最多 100 行） */
export interface SocialLeaderboardResponse {
  type: SocialLeaderboardType;
  scope: SocialLeaderboardScope;
  roundId: number | null;
  season: number;
  rows: SocialLeaderboardRow[];
}

/** GET /api/social/gate */
export interface SocialGateResponse {
  roundId: number | null;
  phase: SocialRoundPhase;
  /** 城门价（USD）；轮次未开放时为 null */
  gatePriceUsd: number | null;
  /** 最近一根已收盘 K 线 TWAP（USD）；无数据为 null */
  priceUsd: number | null;
  /** STON.fi 池子 USDT 侧储备（USD）；未配置 STONFI_POOL_ADDRESS 或拉取失败为 null */
  poolUsdt: number | null;
  /** poolUsdt * (sqrt(gate / price) - 1)，下限 0；缺少价格或池子数据时为 null */
  remainingUsd: number | null;
  litCandles: number;
  candlesSeen: number;
  rewardBudgetRaw: string;
  stakeCount: number;
  /** 当前阶段结束时刻（unix 秒）；无法确定时为 null */
  phaseEndsAt: number | null;
}

/** POST /api/social/guess {wallet, roundId, lit}（lit = 0..24） */
export interface SocialGuessRequest {
  wallet: string;
  roundId: number;
  lit: number;
}

/** POST / GET /api/social/guess；未猜过时 lit 与 createdAt 为 null（GET） */
export interface SocialGuessResponse {
  roundId: number;
  wallet: string;
  lit: number | null;
  createdAt: number | null;
}

/** GET /api/social/payout/latest：最新累计军饷清单（金额为终身累计，raw） */
export interface SocialPayoutLatestResponse {
  listId: number;
  root: string;
  fromRound: number;
  toRound: number;
  leafCount: number;
  totalRaw: string;
  createdAt: number;
}

/** GET /api/social/payout/proof?wallet= ：叶子下标与 leafCount 用于判断晋级层，见 merkle.ts 文件头 */
export interface SocialPayoutProofResponse {
  listId: number;
  root: string;
  cumulativeRaw: string;
  proof: string[];
  index: number;
  leafCount: number;
}

/** POST /api/admin/payout/build（管理员）返回的清单摘要 */
export type AdminPayoutBuildResponse = SocialPayoutLatestResponse;
