/**
 * A9 链上协议常量（前端侧）。
 * 与 docs/04_CONTRACT_ABI.md §19 对齐；contract-dev 的 contracts/README 为最终 ABI。
 */

/** 消息 opcode（uint32）。 */
export const OPCODES = {
  /** 质押：Jetton transfer（TEP-74）的 forward payload */
  STAKE_DEPOSIT: 0x5254000f,
  /** 领取本金（用户 → RoundController） */
  CLAIM_PRINCIPAL: 0x52540006,
  /** 领取奖励（用户 → RoundController） */
  CLAIM_REWARD: 0x52540007,
  /** 合并领取本金 + 奖励（用户 → RoundController，≤10 轮） */
  CLAIM_ALL: 0x5254000e,
  /** V8：早领 50%（PENDING → EARLY），用户 → RoundController */
  CLAIM_REWARD_EARLY: 0x52540017,
  /** V8：滚存（PENDING → ROLLED，全额进下一轮），用户 → RoundController */
  ROLL_REWARD: 0x52540018,
  /** V8：绑定邀请人（一次性、不可改），用户 → RoundController */
  SET_REFERRER: 0x52540019,
  /** V8：R10 终态后按 12 个月线性领取解锁池，用户 → RoundController */
  CLAIM_UNLOCKED: 0x5254001a,
  /**
   * v8.7：重置 OracleAdapter 的 K 线游标（OA admin 或 RC 发送 → OracleAdapter，body roundId:u8）。
   * 前端不调用，仅 ABI 登记；来源 contracts/contracts/constants.tolk OP_RESET_ROUND_CANDLES。
   */
  RESET_ROUND_CANDLES: 0x52540028,
} as const;

/**
 * v8.7：ClaimPrincipal 的 refund 账本 roundId。
 * ClaimPrincipal{roundId:0} = 领取 A9-CRIT-02 退款账本（低 gas/退款 bounce 记入的 A9），
 * round 0 不是真实轮次；必须显式传该常量，禁止复用其它默认值。
 */
export const REFUND_ROUND_ID = 0;

/** v8.7：合约内部 claim kind = REFUND:5（仅用于文档/对账，不进入 payload）。 */
export const CLAIM_KIND_REFUND = 5;

/** V8 奖励三态（合约 StakePosition.rewardState，0/1/2）。 */
export const REWARD_STATE = {
  PENDING: 0,
  ROLLED: 1,
  EARLY: 2,
} as const;

/** V8 早领比例：立即支付 50%，另 50% 进解锁池（不销毁）。 */
export const EARLY_CLAIM_BPS = 5000;
/** V8 权重：连续参与每轮 +10%，封顶 10 轮（+100%）。 */
export const STREAK_BONUS_BPS = 1000;
export const STREAK_CAP = 10;
/** V8 权重：直接邀请加成 20% × 被邀请人质押，封顶邀请人自己质押。 */
export const REFERRAL_BONUS_BPS = 2000;
/** V8 解锁期：R10 终态后 12 × 30 天线性（每月 1/12）。 */
export const UNLOCK_MONTHS = 12;
export const UNLOCK_MONTH_SECONDS = 30 * 24 * 3600;
export const UNLOCK_PERIOD_SECONDS = UNLOCK_MONTHS * UNLOCK_MONTH_SECONDS;

/** 标准 TEP-74 Jetton transfer opcode。 */
export const JETTON_TRANSFER_OP = 0x0f8a7ea5;

/** StakePayload 结构版本。 */
export const STAKE_PAYLOAD_VERSION = 1;

/** 风险披露确认：1 = 已确认（失败轮本金 100% 销毁、质押不可取消）。 */
export const ACCEPT_FULL_PRINCIPAL_BURN = 1;

/** Jetton transfer 内转发给合约的 TON（0.05 TON，合约不强制，用于触发通知与后续处理）。 */
export const DEFAULT_FORWARD_TON_NANO = 50_000_000n;

/** 质押消息本身携带的 TON（覆盖 Jetton 转账 + forward + 合约处理 gas）。 */
export const DEFAULT_STAKE_MESSAGE_TON_NANO = 200_000_000n;

/**
 * 领取/退款/绑定类消息携带的 TON。
 * v8.7 合约对 ClaimPrincipal / ClaimAll / ClaimUnlocked / SetReferrer 断言 valueCoins >= 0.15 TON
 * （RoundController.tolk:1141/1199/1497/1705），低于阈值会抛 BadConfig(250)，因此固定 0.2 TON。
 */
export const DEFAULT_CLAIM_MESSAGE_TON_NANO = 200_000_000n;

/** 交易 validUntil：当前时间 + 5 分钟。 */
export const TX_VALID_FOR_SECONDS = 300;

/** 回执轮询参数。 */
export const RECEIPT_POLL_INTERVAL_MS = 4_000;
export const RECEIPT_TIMEOUT_MS = 150_000;

/** 本地预检：钱包 TON 余额建议值（低于此值提示余额不足；需覆盖消息 value + gas）。 */
export const MIN_STAKE_TON_BALANCE = 0.35;
export const MIN_CLAIM_TON_BALANCE = 0.3;

/** 业务默认值（后端配置未下发时的兜底，与 docs/04 §18 一致）。 */
export const DEFAULT_TOKEN_DECIMALS = 9;
/** 单笔最低质押：10,000 A9 */
export const DEFAULT_MIN_STAKE_TOKENS = 10_000n;
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
 * 定稿来源：contracts/README.md §4.5。
 */
export const EVENT_OPCODES = {
  TARGET_PRICE_SET: 0x52540101,
  ROUND_SETTLED: 0x52540102,
  DEPOSIT_ACCEPTED: 0x52540103,
  TECHNICAL_ABORTED: 0x52540104,
  TEAM_RELEASED: 0x52540201,
  TEAM_BURNED: 0x52540202,
  // V8
  REWARD_ROLLED: 0x52540105,
  REWARD_EARLY: 0x52540106,
  REFERRER_SET: 0x52540107,
  UNLOCK_CLAIMED: 0x52540108,
  // v8.7（audit fixes；前端无事件解析，仅 ABI 登记，供索引器/日志核对）
  CLAIM_ROLLED_BACK: 0x52540109,
  PRINCIPAL_CLAIMED: 0x5254010a,
  STAKING_CLOSED: 0x5254010b,
  CANDLE_SUBMITTED: 0x5254010c,
  ORACLE_PAUSE_CHANGED: 0x5254010d,
} as const;

/**
 * 合约 get methods 名称（定稿来源：contracts/deploy/abi/*.json + contracts/README.md §4.6）。
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
    roundCandle: 'get_round_candle',
    userStake: 'get_user_stake',
    roundTotalStake: 'get_round_total_stake',
    userRewardEstimate: 'get_user_reward_estimate',
    claimableAll: 'get_claimable_all',
    roundBurnStatus: 'get_round_burn_status',
    // V8
    rewardState: 'get_reward_state',
    unlockInfo: 'get_unlock_info',
    referral: 'get_referral',
    streak: 'get_streak',
    userWeight: 'get_user_weight',
    totalWeight: 'get_total_weight',
  },
  teamVault: {
    teamVaultState: 'get_team_vault_state',
    roundState: 'get_round_state',
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
