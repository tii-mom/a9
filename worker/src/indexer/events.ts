/**
 * 链上事件（external-out log）解码。
 * 事件 opcode 与字段布局见 contracts/contracts/types.tolk（v11）：
 *   0x52540101 TargetPriceSet / 0x52540102 RoundSettled / 0x52540103 DepositAccepted /
 *   0x52540104 TechnicalAborted / 0x5254010E Claimed / 0x5254010F DepositRefunded /
 *   0x52540110 SettlementBounced / 0x52540111 UnexpectedBounce / 0x52540112 Restaked /
 *   0x52540113 TeamReleased
 * StakingClosed(0x5254010B) / CandleSubmitted(0x5254010C) 不解码：轮次时间与 K 线分别由 get_round
 * 与 SubmitCandle 入站消息提供。
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
  restaked: 0x52540112,
  teamReleased: 0x52540113,
} as const;

const EVENT_OPCODES = new Set<number>(Object.values(EVENT_OP));

export function isEventOpcode(opcode: number): boolean {
  return EVENT_OPCODES.has(opcode);
}

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
  /** 销毁额：失败轮 = 半额奖励；第 10 城结束时 = 留存滚存（成功轮可能非 0） */
  rewardBurnRaw: bigint;
  /** 团队额度销毁额（失败轮 = 1.2 亿，与半额奖励、本金同一笔 burn） */
  teamBurnRaw: bigint;
  /** 本金销毁额（仅失败轮 = 本轮总质押） */
  principalBurnRaw: bigint;
  /** 团队释放额 = 上一次成功轮的团队额度（RC 直接转团队钱包） */
  teamReleasedRaw: bigint;
  /** 本轮奖励预算（7 亿 + 滚入的 carry） */
  rewardBudgetRaw: bigint;
  /** 结算后待滚入下一城的 carry */
  carryAfterRaw: bigint;
}

export interface DepositAcceptedEvent extends EventBase {
  opcode: typeof EVENT_OP.depositAccepted;
  roundId: number;
  owner: ChainAddressValue;
  amountRaw: bigint;
  /** 权重 = 金额 × 时机系数（1.5 / 1.2 / 1.0） */
  weightRaw: bigint;
  totalAcceptedStakeRaw: bigint;
  totalWeightRaw: bigint;
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
  roundId: number;
  /** 本次领取的本金（已领过本金时为 0） */
  principalRaw: bigint;
  /** 本次领取的奖励：首次为 20% 立即部分，之后为压城部分的新解锁额 */
  rewardRaw: bigint;
}

export interface DepositRefundedEvent extends EventBase {
  opcode: typeof EVENT_OP.depositRefunded;
  owner: ChainAddressValue;
  amountRaw: bigint;
  /** true：即时退回；false：留存在 RC（TON 不足，无退款账本） */
  instant: boolean;
}

export interface RestakedEvent extends EventBase {
  opcode: typeof EVENT_OP.restaked;
  owner: ChainAddressValue;
  fromRound: number;
  toRound: number;
  amountRaw: bigint;
  weightRaw: bigint;
}

export interface TeamReleasedEvent extends EventBase {
  opcode: typeof EVENT_OP.teamReleased;
  /** 释放额所属轮次（0 = 最后一笔 ReleaseTeam） */
  roundId: number;
  amountRaw: bigint;
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
  | RestakedEvent
  | TeamReleasedEvent
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
        rewardBudgetRaw: reader.u(128),
        carryAfterRaw: reader.u(128),
      };
    case EVENT_OP.depositAccepted:
      return {
        ...base,
        opcode: EVENT_OP.depositAccepted,
        roundId: reader.uNumber(8),
        owner: reader.address(),
        amountRaw: reader.u(128),
        weightRaw: reader.u(128),
        totalAcceptedStakeRaw: reader.u(128),
        totalWeightRaw: reader.u(128),
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
        roundId: reader.uNumber(8),
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
      };
    case EVENT_OP.restaked:
      return {
        ...base,
        opcode: EVENT_OP.restaked,
        owner: reader.address(),
        fromRound: reader.uNumber(8),
        toRound: reader.uNumber(8),
        amountRaw: reader.u(128),
        weightRaw: reader.u(128),
      };
    case EVENT_OP.teamReleased:
      return {
        ...base,
        opcode: EVENT_OP.teamReleased,
        roundId: reader.uNumber(8),
        amountRaw: reader.u(128),
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
