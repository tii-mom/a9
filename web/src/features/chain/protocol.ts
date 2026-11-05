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
/** 单地址 ≤ 本轮总质押的 10%（bps = 1000） */
export const DEFAULT_MAX_STAKE_PER_ADDRESS_BPS = 1000;
/** 轮次上限（claimAll 有界循环上界） */
export const ROUND_COUNT_MAX = 10;

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
