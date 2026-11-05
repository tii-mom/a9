/**
 * 链上事件（external-out log）解码。
 * 事件 opcode 定义见 contracts/README §4.5：
 *   0x52540101 TargetPriceSet / 0x52540102 RoundSettled / 0x52540103 DepositAccepted /
 *   0x52540104 TechnicalAborted / 0x52540105 RewardRolled / 0x52540106 RewardEarly /
 *   0x52540107 ReferrerSet / 0x52540108 UnlockClaimed /
 *   0x52540201 TeamReleased（TeamVault）/ 0x52540202 TeamBurned（TeamVault）
 * 事件是 external-out 消息（v3 transactions 的 out_msgs 里 destination=null）。
 */
import { BitReader, rootCellFromBase64 } from './boc';

export const EVENT_OP = {
  targetPriceSet: 0x52540101,
  roundSettled: 0x52540102,
  depositAccepted: 0x52540103,
  technicalAborted: 0x52540104,
  rewardRolled: 0x52540105,
  rewardEarly: 0x52540106,
  referrerSet: 0x52540107,
  unlockClaimed: 0x52540108,
  teamReleased: 0x52540201,
  teamBurned: 0x52540202,
} as const;

const EVENT_OPCODES = new Set<number>(Object.values(EVENT_OP));

export function isEventOpcode(opcode: number): boolean {
  return EVENT_OPCODES.has(opcode);
}

export interface ChainAddressValue {
  workchain: number;
  hashHex: string;
  raw: string;
}

export interface EventBase {
  opcode: number;
  /** 事件来源（RC 或 TeamVault）的 raw 地址 */
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

export interface RewardRolledEvent extends EventBase {
  opcode: typeof EVENT_OP.rewardRolled;
  roundId: number;
  owner: ChainAddressValue;
  amountRaw: bigint;
  nextRoundId: number;
}

export interface RewardEarlyEvent extends EventBase {
  opcode: typeof EVENT_OP.rewardEarly;
  roundId: number;
  owner: ChainAddressValue;
  paidRaw: bigint;
  lockedRaw: bigint;
}

export interface ReferrerSetEvent extends EventBase {
  opcode: typeof EVENT_OP.referrerSet;
  owner: ChainAddressValue;
  referrer: ChainAddressValue;
}

export interface UnlockClaimedEvent extends EventBase {
  opcode: typeof EVENT_OP.unlockClaimed;
  owner: ChainAddressValue;
  amountRaw: bigint;
}

export interface TeamReleasedEvent extends EventBase {
  opcode: typeof EVENT_OP.teamReleased;
  roundId: number;
  amountRaw: bigint;
  to: ChainAddressValue;
}

export interface TeamBurnedEvent extends EventBase {
  opcode: typeof EVENT_OP.teamBurned;
  roundId: number;
  amountRaw: bigint;
  burnId: bigint;
}

export type ChainEvent =
  | TargetPriceSetEvent
  | RoundSettledEvent
  | DepositAcceptedEvent
  | TechnicalAbortedEvent
  | RewardRolledEvent
  | RewardEarlyEvent
  | ReferrerSetEvent
  | UnlockClaimedEvent
  | TeamReleasedEvent
  | TeamBurnedEvent;

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
    case EVENT_OP.rewardRolled:
      return {
        ...base,
        opcode: EVENT_OP.rewardRolled,
        roundId: reader.uNumber(8),
        owner: reader.address(),
        amountRaw: reader.u(128),
        nextRoundId: reader.uNumber(8),
      };
    case EVENT_OP.rewardEarly:
      return {
        ...base,
        opcode: EVENT_OP.rewardEarly,
        roundId: reader.uNumber(8),
        owner: reader.address(),
        paidRaw: reader.u(128),
        lockedRaw: reader.u(128),
      };
    case EVENT_OP.referrerSet:
      return {
        ...base,
        opcode: EVENT_OP.referrerSet,
        owner: reader.address(),
        referrer: reader.address(),
      };
    case EVENT_OP.unlockClaimed:
      return {
        ...base,
        opcode: EVENT_OP.unlockClaimed,
        owner: reader.address(),
        amountRaw: reader.u(128),
      };
    case EVENT_OP.teamReleased:
      return {
        ...base,
        opcode: EVENT_OP.teamReleased,
        roundId: reader.uNumber(8),
        amountRaw: reader.u(128),
        to: reader.address(),
      };
    case EVENT_OP.teamBurned:
      return {
        ...base,
        opcode: EVENT_OP.teamBurned,
        roundId: reader.uNumber(8),
        amountRaw: reader.u(128),
        burnId: reader.u(256),
      };
    default:
      return null;
  }
}
