/**
 * 链上事件（external-out log）解码。
 * 事件 opcode 与字段布局见 contracts/README §4.3 与 contracts/contracts/types.tolk（v10）：
 *   0x52540101 TargetPriceSet / 0x52540102 RoundSettled / 0x52540103 DepositAccepted /
 *   0x52540104 TechnicalAborted / 0x5254010E Claimed / 0x5254010F DepositRefunded /
 *   0x52540110 SettlementBounced / 0x52540111 UnexpectedBounce
 * StakingClosed(0x5254010B) / CandleSubmitted(0x5254010C) 不解码：轮次时间与 K 线分别由 get_round
 * 与 SubmitCandle 入站消息提供（与 v8.9 相同）。
 * 事件是 external-out 消息（v3 transactions 的 out_msgs 里 destination=null）。
 */
import { BitReader, rootCellFromBase64 } from './boc';

export const EVENT_OP = {
  targetPriceSet: 0x52540101,
  roundSettled: 0x52540102,
  depositAccepted: 0x52540103,
  technicalAborted: 0x52540104,
  claimed: 0x5254010e,
  depositRefunded: 0x5254010f,
  settlementBounced: 0x52540110,
  unexpectedBounce: 0x52540111,
} as const;

const EVENT_OPCODES = new Set<number>(Object.values(EVENT_OP));

export function isEventOpcode(opcode: number): boolean {
  return EVENT_OPCODES.has(opcode);
}

/** roundsMask 中退款账本（round 0）的位。 */
export const REFUND_LEDGER_BIT = 1 << 15;

/** SettlementBounced.action：1 团队转账 / 2 销毁（与合约 ACTION_* 同口径）。 */
export const SETTLE_ACTION = { teamTransfer: 1, burn: 2 } as const;

export interface ChainAddressValue {
  workchain: number;
  hashHex: string;
  raw: string;
}

export interface EventBase {
  opcode: number;
  /** 事件来源（RoundController）的 raw 地址 */
  emitter: string;
  /** 所在交易：lt + hash，用于幂等/审计 */
  txLt: string;
  txHash: string;
  /** 链上事件时间（秒） */
  txNow: number;
  body: string;
}

export interface TargetPriceSetEvent extends EventBase {
  opcode: typeof EVENT_OP.targetPriceSet;
  roundId: number;
  tier: number;
  targetPriceUsdE8: bigint;
  twap24hUsdE8: bigint;
}

export interface RoundSettledEvent extends EventBase {
  opcode: typeof EVENT_OP.roundSettled;
  roundId: number;
  status: number;
  qualifiedCandles: number;
  candlesSeen: number;
  totalAcceptedStakeRaw: bigint;
  tierAfter: number;
  /** 本轮奖励销毁额（失败轮 / 0 质押成功轮 = 7 亿，否则 0） */
  rewardBurnRaw: bigint;
  /** 团队额度销毁额（仅失败轮 = 1.2 亿） */
  teamBurnRaw: bigint;
  /** 本金销毁额（仅失败轮 = 本轮总质押） */
  principalBurnRaw: bigint;
  /** 团队释放额（成功轮 = 1.2 亿，RC 直接转团队钱包） */
  teamReleasedRaw: bigint;
}

export interface DepositAcceptedEvent extends EventBase {
  opcode: typeof EVENT_OP.depositAccepted;
  roundId: number;
  owner: ChainAddressValue;
  amountRaw: bigint;
  totalAcceptedStakeRaw: bigint;
}

export interface TechnicalAbortedEvent extends EventBase {
  opcode: typeof EVENT_OP.technicalAborted;
  roundId: number;
  reason: number;
  at: number;
}

export interface ClaimedEvent extends EventBase {
  opcode: typeof EVENT_OP.claimed;
  owner: ChainAddressValue;
  /** bit (r-1) = 第 r 轮；bit 15 = 退款账本 */
  roundsMask: number;
  principalRaw: bigint;
  rewardRaw: bigint;
}

export interface DepositRefundedEvent extends EventBase {
  opcode: typeof EVENT_OP.depositRefunded;
  owner: ChainAddressValue;
  amountRaw: bigint;
  /** true：即时退回；false：记入退款账本（或零头留存，见 recorded） */
  instant: boolean;
  /** false：低于最低质押且 TON 不足的零头，合约留存、不退 */
  recorded: boolean;
}

export interface SettlementBouncedEvent extends EventBase {
  opcode: typeof EVENT_OP.settlementBounced;
  roundId: number;
  action: number;
}

export interface UnexpectedBounceEvent extends EventBase {
  opcode: typeof EVENT_OP.unexpectedBounce;
  op: number;
  queryId: bigint;
}

export type ChainEvent =
  | TargetPriceSetEvent
  | RoundSettledEvent
  | DepositAcceptedEvent
  | TechnicalAbortedEvent
  | ClaimedEvent
  | DepositRefundedEvent
  | SettlementBouncedEvent
  | UnexpectedBounceEvent;

export interface RawEventInput {
  /** 发出事件的合约 raw 地址 */
  emitter: string;
  txLt: string;
  txHash: string;
  txNow: number;
  /** out_msg.opcode（0x… 十六进制字符串或 number） */
  opcode: number;
  /** out_msg.message_content.body（BOC base64） */
  body: string;
}

/** 解码一条事件；未知 opcode 或 body 解析失败返回 null。 */
export function decodeEvent(input: RawEventInput): ChainEvent | null {
  const base: EventBase = {
    opcode: input.opcode,
    emitter: input.emitter,
    txLt: input.txLt,
    txHash: input.txHash,
    txNow: input.txNow,
    body: input.body,
  };
  const reader = new BitReader(rootCellFromBase64(input.body));
  const op = Number(reader.u(32));
  if (op !== input.opcode) return null;
  switch (op) {
    case EVENT_OP.targetPriceSet:
      return {
        ...base,
        opcode: EVENT_OP.targetPriceSet,
        roundId: reader.uNumber(8),
        tier: reader.uNumber(8),
        targetPriceUsdE8: reader.u(128),
        twap24hUsdE8: reader.u(128),
      };
    case EVENT_OP.roundSettled:
      return {
        ...base,
        opcode: EVENT_OP.roundSettled,
        roundId: reader.uNumber(8),
        status: reader.uNumber(8),
        qualifiedCandles: reader.uNumber(8),
        candlesSeen: reader.uNumber(8),
        totalAcceptedStakeRaw: reader.u(128),
        tierAfter: reader.uNumber(8),
        rewardBurnRaw: reader.u(128),
        teamBurnRaw: reader.u(128),
        principalBurnRaw: reader.u(128),
        teamReleasedRaw: reader.u(128),
      };
    case EVENT_OP.depositAccepted:
      return {
        ...base,
        opcode: EVENT_OP.depositAccepted,
        roundId: reader.uNumber(8),
        owner: reader.address(),
        amountRaw: reader.u(128),
        totalAcceptedStakeRaw: reader.u(128),
      };
    case EVENT_OP.technicalAborted:
      return {
        ...base,
        opcode: EVENT_OP.technicalAborted,
        roundId: reader.uNumber(8),
        reason: reader.uNumber(8),
        at: reader.uNumber(64),
      };
    case EVENT_OP.claimed:
      return {
        ...base,
        opcode: EVENT_OP.claimed,
        owner: reader.address(),
        roundsMask: reader.uNumber(16),
        principalRaw: reader.u(128),
        rewardRaw: reader.u(128),
      };
    case EVENT_OP.depositRefunded:
      return {
        ...base,
        opcode: EVENT_OP.depositRefunded,
        owner: reader.address(),
        amountRaw: reader.u(128),
        instant: reader.u(1) === 1n,
        recorded: reader.u(1) === 1n,
      };
    case EVENT_OP.settlementBounced:
      return {
        ...base,
        opcode: EVENT_OP.settlementBounced,
        roundId: reader.uNumber(8),
        action: reader.uNumber(8),
      };
    case EVENT_OP.unexpectedBounce:
      return {
        ...base,
        opcode: EVENT_OP.unexpectedBounce,
        op: reader.uNumber(32),
        queryId: reader.u(64),
      };
    default:
      return null;
  }
}

/** roundsMask → 轮次号列表（1..10；退款账本 bit 15 不在其中，用 REFUND_LEDGER_BIT 单独判断）。 */
export function roundsInMask(mask: number): number[] {
  const rounds: number[] = [];
  for (let roundId = 1; roundId <= 10; roundId++) {
    if (mask & (1 << (roundId - 1))) rounds.push(roundId);
  }
  return rounds;
}
