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
} as const;

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

/** 领取消息携带的 TON（合约建议 0.1 TON，最低 0.05）。 */
export const DEFAULT_CLAIM_MESSAGE_TON_NANO = 100_000_000n;

/** 交易 validUntil：当前时间 + 5 分钟。 */
export const TX_VALID_FOR_SECONDS = 300;

/** 回执轮询参数。 */
export const RECEIPT_POLL_INTERVAL_MS = 4_000;
export const RECEIPT_TIMEOUT_MS = 150_000;

/** 本地预检：钱包 TON 余额建议值（低于此值提示余额不足）。 */
export const MIN_STAKE_TON_BALANCE = 0.25;
export const MIN_CLAIM_TON_BALANCE = 0.15;

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
