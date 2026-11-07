/**
 * A9 链上协议常量（前端侧）。
 * v11（docs/35 §3）：以 contracts/contracts/{types,ticket,constants}.tolk 为准。
 * 攻城令（StakeTicket）每人每城一个合约；领取 / 续战发给攻城令，不再发给 RoundController。
 */

/** 用户侧消息 opcode（uint32），v11 ABI 见 contracts/contracts/constants.tolk。 */
export const OPCODES = {
  /** 质押：Jetton transfer（TEP-74）的 forward payload（StakePayload v2） */
  STAKE_DEPOSIT: 0x5254000f,
  /** 攻城令：领取本金（+ 立即 20%）与已解锁的压城奖励（用户 → 自己的攻城令） */
  TICKET_CLAIM: 0x52540303,
  /** 攻城令：一键续战，本金滚入当前攻城城（用户 → 自己的攻城令） */
  TICKET_RESTAKE: 0x52540304,
} as const;

/** 标准 TEP-74 Jetton transfer opcode。 */
export const JETTON_TRANSFER_OP = 0x0f8a7ea5;

/** StakePayload 结构版本（v11 = 2）。 */
export const STAKE_PAYLOAD_VERSION = 2;

/** 风险披露确认：1 = 已确认（失败轮本金 100% 销毁、质押不可取消）。 */
export const ACCEPT_FULL_PRINCIPAL_BURN = 1;

/**
 * Jetton transfer 内转发给合约的 TON。v11 合约要求 ≥ 0.1 TON（无效质押的即时退回依赖它）；取 0.12 TON 留余量。
 */
export const DEFAULT_FORWARD_TON_NANO = 120_000_000n;

/** 质押消息本身携带的 TON（docs/35 §3.5：总消息 0.3 TON）。 */
export const DEFAULT_STAKE_MESSAGE_TON_NANO = 300_000_000n;

/** 攻城令领取消息携带的 TON（docs/35 §3.5 建议 0.2 TON）。 */
export const DEFAULT_TICKET_CLAIM_TON_NANO = 200_000_000n;

/** 攻城令一键续战消息携带的 TON（docs/35 §3.5 建议 0.3 TON）。 */
export const DEFAULT_TICKET_RESTAKE_TON_NANO = 300_000_000n;

/** 交易 validUntil：当前时间 + 5 分钟。 */
export const TX_VALID_FOR_SECONDS = 300;

/** 回执轮询参数。 */
export const RECEIPT_POLL_INTERVAL_MS = 4_000;
export const RECEIPT_TIMEOUT_MS = 150_000;

/** 本地预检：钱包 TON 余额建议值（低于此值提示余额不足；需覆盖消息 value + gas）。 */
export const MIN_STAKE_TON_BALANCE = 0.45;
export const MIN_CLAIM_TON_BALANCE = 0.3;
export const MIN_RESTAKE_TON_BALANCE = 0.45;

/** 业务默认值（后端配置未下发时的兜底，与 docs/35 §3 一致）。 */
export const DEFAULT_TOKEN_DECIMALS = 9;
/** 单笔最低质押：1,000 A9（v11）。无单地址 / 单轮总量上限。 */
export const DEFAULT_MIN_STAKE_TOKENS = 1_000n;
/** 轮次上限（攻城 10 城）。 */
export const ROUND_COUNT_MAX = 10;

/** 时机系数（bps）：攻城期前 / 中 / 后各 12h。 */
export const TIMING_BPS = { first: 15_000, second: 12_000, last: 10_000 } as const;
/** 压城奖励中立即可领的比例（bps）。 */
export const IMMEDIATE_REWARD_BPS = 2_000;

/**
 * 事件 opcode（external-out logs，供索引器/日志解析；前端当前不直接消费）。
 * 定稿来源：contracts/contracts/constants.tolk（v11）。
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
  RESTAKED: 0x52540112,
  TEAM_RELEASED: 0x52540113,
} as const;

/**
 * RoundController / StakeTicket get methods（定稿来源：contracts/contracts/RoundController.tolk、ticket.tolk，v11）。
 * v11 移除了 get_user_stake / get_user_reward_estimate / get_claimable_all：每人每城的仓位读攻城令。
 */
export const GET_METHODS = {
  roundController: {
    protocolConfig: 'get_protocol_config',
    protocolState: 'get_protocol_state',
    currentRound: 'get_current_round',
    successCount: 'get_success_count',
    round: 'get_round',
    roundStatus: 'get_round_status',
    roundTotalStake: 'get_round_total_stake',
    roundStakerCount: 'get_round_staker_count',
    rewardPreview: 'get_reward_preview',
    ticketAddress: 'get_ticket_address',
    ticketCodeHash: 'get_ticket_code_hash',
    jettonWalletAddress: 'get_jetton_wallet_address',
  },
  ticket: {
    ticketData: 'get_ticket_data',
  },
} as const;

/** 生成 uint64 查询 id（回执关联用，合约不做唯一性强制）。 */
export function nextQueryId(now: number = Date.now()): bigint {
  const random = Math.floor(Math.random() * 1024);
  return (BigInt(now) * 1024n + BigInt(random)) & 0xffffffffffffffffn;
}
