/**
 * A9 链上协议常量（前端侧）。
 * v10（D-42）：以 contracts/README.md §4 为准。
 */

/** 用户侧消息 opcode（uint32），v10 ABI 见 contracts/README.md §4.1。 */
export const OPCODES = {
  /** 质押：Jetton transfer（TEP-74）的 forward payload */
  STAKE_DEPOSIT: 0x5254000f,
  /** Claim(roundId)：领取该轮本金 + 全额奖励；roundId = 0 为退款账本（用户 → RoundController） */
  CLAIM: 0x52540006,
  /** ClaimAll：领取 1..10 轮全部 + 退款账本（用户 → RoundController） */
  CLAIM_ALL: 0x5254000e,
} as const;

/**
 * Claim{roundId:0} = 领取退款账本（低 TON / 失败质押记入的 A9）。
 * round 0 不是真实轮次；必须显式传该常量，禁止复用其它默认值。
 */
export const REFUND_ROUND_ID = 0;

/** 标准 TEP-74 Jetton transfer opcode。 */
export const JETTON_TRANSFER_OP = 0x0f8a7ea5;

/** StakePayload 结构版本。 */
export const STAKE_PAYLOAD_VERSION = 1;

/** 风险披露确认：1 = 已确认（失败轮本金 100% 销毁、质押不可取消）。 */
export const ACCEPT_FULL_PRINCIPAL_BURN = 1;

/**
 * Jetton transfer 内转发给合约的 TON。v10 合约要求 ≥ 0.1 TON（用于无效质押的即时退回）；
 * 不足时质押记入退款账本，低于最低质押的零头不退。取 0.12 TON 留余量。
 */
export const DEFAULT_FORWARD_TON_NANO = 120_000_000n;

/** 质押消息本身携带的 TON（覆盖 Jetton 转账 + forward + 合约处理 gas）。 */
export const DEFAULT_STAKE_MESSAGE_TON_NANO = 300_000_000n;

/** 领取/退款消息携带的 TON：v10 合约要求 Claim / ClaimAll ≥ 0.1 TON，建议 0.2 TON。 */
export const DEFAULT_CLAIM_MESSAGE_TON_NANO = 200_000_000n;

/** 交易 validUntil：当前时间 + 5 分钟。 */
export const TX_VALID_FOR_SECONDS = 300;

/** 回执轮询参数。 */
export const RECEIPT_POLL_INTERVAL_MS = 4_000;
export const RECEIPT_TIMEOUT_MS = 150_000;

/** 本地预检：钱包 TON 余额建议值（低于此值提示余额不足；需覆盖消息 value + gas）。 */
export const MIN_STAKE_TON_BALANCE = 0.45;
export const MIN_CLAIM_TON_BALANCE = 0.3;

/** 业务默认值（后端配置未下发时的兜底，与 docs/04 §18 一致）。 */
export const DEFAULT_TOKEN_DECIMALS = 9;
/** 单笔最低质押：100,000 A9（v10 / D-42） */
export const DEFAULT_MIN_STAKE_TOKENS = 100_000n;
/** 本轮总质押上限：200,000,000 A9 */
export const DEFAULT_MAX_TOTAL_STAKE_TOKENS = 200_000_000n;
/** 单地址 ≤ 本轮总质押的 10%（bps = 1000，旧口径，仅为兼容保留） */
export const DEFAULT_MAX_STAKE_PER_ADDRESS_BPS = 1000;
/** V6.1 定稿：单地址固定硬顶 20,000,000 A9（= 本轮总上限 200,000,000 的 10%） */
export const DEFAULT_MAX_STAKE_PER_ADDRESS_TOKENS = 20_000_000n;
/** 轮次上限（claimAll 有界循环上界） */
export const ROUND_COUNT_MAX = 10;

/**
 * 事件 opcode（external-out logs，供索引器/日志解析；前端当前不直接消费）。
 * 定稿来源：contracts/README.md §4.3（v10）。
 */
export const EVENT_OPCODES = {
  TARGET_PRICE_SET: 0x52540101,
  ROUND_SETTLED: 0x52540102,
  DEPOSIT_ACCEPTED: 0x52540103,
  TECHNICAL_ABORTED: 0x52540104,
  STAKING_CLOSED: 0x5254010b,
  CANDLE_SUBMITTED: 0x5254010c,
  CLAIMED: 0x5254010e,
  DEPOSIT_REFUNDED: 0x5254010f,
  SETTLEMENT_BOUNCED: 0x52540110,
  UNEXPECTED_BOUNCE: 0x52540111,
} as const;

/**
 * RoundController get methods（定稿来源：contracts/README.md §4.4，v10）。
 * 注意：get_round_target_price 在 PREVIEW / UNOPENED 期间返回 0，UI 应显示「待开窗锁定」。
 * 当前前端轮次数据仍走 worker API；接链读取时按下表调用。
 */
export const GET_METHODS = {
  roundController: {
    protocolConfig: 'get_protocol_config',
    currentRound: 'get_current_round',
    successCount: 'get_success_count',
    round: 'get_round',
    roundStatus: 'get_round_status',
    roundTargetPrice: 'get_round_target_price',
    roundTotalStake: 'get_round_total_stake',
    roundStakerCount: 'get_round_staker_count',
    userStake: 'get_user_stake',
    userRewardEstimate: 'get_user_reward_estimate',
    claimableAll: 'get_claimable_all',
    jettonWalletAddress: 'get_jetton_wallet_address',
  },
} as const;

/** 生成 uint64 查询 id（回执关联用，合约不做唯一性强制）。 */
export function nextQueryId(now: number = Date.now()): bigint {
  const random = Math.floor(Math.random() * 1024);
  return (BigInt(now) * 1024n + BigInt(random)) & 0xffffffffffffffffn;
}

/**
 * 生成 uint64 depositNonce：时间戳毫秒（单调）+ 随机低位，跨设备也不易重复。
 * 合约按 (roundId, owner, nonce) 去重，重复会被退款。
 */
export function nextDepositNonce(now: number = Date.now()): bigint {
  const random = Math.floor(Math.random() * 4096);
  return BigInt(now) * 4096n + BigInt(random);
}
