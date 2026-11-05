/**
 * 链上入站消息（用户/keeper → RoundController/TeamVault）的 body 解码。
 * 用途：SubmitCandle 是 chain 模式 K 线的唯一权威来源（V8 合约不再逐根存 K 线，只存 rolling hash）。
 * 所有布局对齐 contracts/contracts/types.tolk；opcode 见 contracts/README §4.1。
 */
import { BitReader, rootCellFromBase64 } from './boc';

export const TX_OP = {
  openRound: 0x52540001,
  closeStaking: 0x52540002,
  submitCandle: 0x52540003,
  finalizeRound: 0x52540005,
  claimPrincipal: 0x52540006,
  claimReward: 0x52540007,
  burnAck: 0x52540009,
  pauseOracle: 0x5254000a,
  resumeOracle: 0x5254000b,
  releaseTeamQuota: 0x5254000c,
  burnTeamQuota: 0x5254000d,
  claimAll: 0x5254000e,
  stakeDeposit: 0x5254000f,
  abortTechnical: 0x52540010,
  startObservation: 0x52540011,
  teamReleasedAck: 0x52540013,
  teamBurnedAck: 0x52540014,
  retryPendingActions: 0x52540015,
  claimRewardEarly: 0x52540017,
  rollReward: 0x52540018,
  setReferrer: 0x52540019,
  claimUnlocked: 0x5254001a,
  askToTransfer: 0x0f8a7ea5,
  askToBurn: 0x595f07bc,
  transferNotification: 0x7362d09c,
  returnExcessesBack: 0xd53276db,
  transferBounced: 0x52540027,
} as const;

export interface InboundMessageBase {
  opcode: number;
  /** 原始 body（BOC base64），保留用于审计/复算 */
  body: string;
}

export interface SubmitCandleMessage extends InboundMessageBase {
  opcode: typeof TX_OP.submitCandle;
  queryId: bigint;
  roundId: number;
  candleIndex: number;
  periodStart: number;
  periodEnd: number;
  twapPriceUsdE8: bigint;
  dataDigest: bigint;
}

export interface OpenRoundMessage extends InboundMessageBase {
  opcode: typeof TX_OP.openRound;
  queryId: bigint;
  twap24hUsdE8: bigint;
}

export interface CloseStakingMessage extends InboundMessageBase {
  opcode: typeof TX_OP.closeStaking;
  queryId: bigint;
  twap1hUsdE8: bigint;
}

export interface RoundIdMessage extends InboundMessageBase {
  opcode:
    | typeof TX_OP.finalizeRound
    | typeof TX_OP.claimPrincipal
    | typeof TX_OP.claimReward
    | typeof TX_OP.claimAll
    | typeof TX_OP.claimRewardEarly
    | typeof TX_OP.rollReward
    | typeof TX_OP.startObservation;
  queryId: bigint;
  roundId: number;
}

export interface ClaimUnlockedMessage extends InboundMessageBase {
  opcode: typeof TX_OP.claimUnlocked;
  queryId: bigint;
}

export interface SetReferrerMessage extends InboundMessageBase {
  opcode: typeof TX_OP.setReferrer;
  referrer: { workchain: number; hashHex: string; raw: string };
}

export interface BurnAckMessage extends InboundMessageBase {
  opcode: typeof TX_OP.burnAck;
  roundId: number;
  kind: number;
  amountRaw: bigint;
  burnId: bigint;
}

export interface TeamReleasedAckMessage extends InboundMessageBase {
  opcode: typeof TX_OP.teamReleasedAck;
  queryId: bigint;
  roundId: number;
  amountRaw: bigint;
}

export interface TeamBurnedAckMessage extends InboundMessageBase {
  opcode: typeof TX_OP.teamBurnedAck;
  queryId: bigint;
  roundId: number;
  amountRaw: bigint;
  burnId: bigint;
}

export interface AskToBurnMessage extends InboundMessageBase {
  opcode: typeof TX_OP.askToBurn;
  queryId: bigint;
  amountRaw: bigint;
  responseDestination: { workchain: number; hashHex: string; raw: string } | null;
}

export interface ReturnExcessesBackMessage extends InboundMessageBase {
  opcode: typeof TX_OP.returnExcessesBack;
  queryId: bigint;
}

export type DecodedInboundMessage =
  | SubmitCandleMessage
  | OpenRoundMessage
  | CloseStakingMessage
  | RoundIdMessage
  | ClaimUnlockedMessage
  | SetReferrerMessage
  | BurnAckMessage
  | TeamReleasedAckMessage
  | TeamBurnedAckMessage
  | AskToBurnMessage
  | ReturnExcessesBackMessage;

export interface RawMessageInput {
  opcode: number;
  /** message_content.body（BOC base64） */
  body: string;
}

function readerOf(body: string): BitReader {
  return new BitReader(rootCellFromBase64(body));
}

function decodeRoundIdMessage(opcode: number, body: string): DecodedInboundMessage | null {
  const reader = readerOf(body);
  const op = Number(reader.u(32));
  if (op !== opcode) return null;
  const queryId = reader.u(64);
  const roundId = reader.uNumber(8);
  return {
    opcode: op as RoundIdMessage['opcode'],
    body,
    queryId,
    roundId,
  };
}

/** 解码一条消息 body；未识别的 opcode 返回 null（调用方计入 unknown_ops）。 */
export function decodeInboundMessage(input: RawMessageInput): DecodedInboundMessage | null {
  const body = input.body;
  if (!body) return null;
  switch (input.opcode) {
    case TX_OP.submitCandle: {
      const reader = readerOf(body);
      const op = Number(reader.u(32));
      if (op !== TX_OP.submitCandle) return null;
      return {
        opcode: TX_OP.submitCandle,
        body,
        queryId: reader.u(64),
        roundId: reader.uNumber(8),
        candleIndex: reader.uNumber(8),
        periodStart: reader.uNumber(32),
        periodEnd: reader.uNumber(32),
        twapPriceUsdE8: reader.u(128),
        dataDigest: reader.u(256),
      };
    }
    case TX_OP.openRound: {
      const reader = readerOf(body);
      const op = Number(reader.u(32));
      if (op !== TX_OP.openRound) return null;
      return { opcode: TX_OP.openRound, body, queryId: reader.u(64), twap24hUsdE8: reader.u(128) };
    }
    case TX_OP.closeStaking: {
      const reader = readerOf(body);
      const op = Number(reader.u(32));
      if (op !== TX_OP.closeStaking) return null;
      return { opcode: TX_OP.closeStaking, body, queryId: reader.u(64), twap1hUsdE8: reader.u(128) };
    }
    case TX_OP.finalizeRound:
    case TX_OP.claimPrincipal:
    case TX_OP.claimReward:
    case TX_OP.claimAll:
    case TX_OP.claimRewardEarly:
    case TX_OP.rollReward:
    case TX_OP.startObservation:
      return decodeRoundIdMessage(input.opcode, body);
    case TX_OP.claimUnlocked: {
      const reader = readerOf(body);
      const op = Number(reader.u(32));
      if (op !== TX_OP.claimUnlocked) return null;
      return { opcode: TX_OP.claimUnlocked, body, queryId: reader.u(64) };
    }
    case TX_OP.setReferrer: {
      const reader = readerOf(body);
      const op = Number(reader.u(32));
      if (op !== TX_OP.setReferrer) return null;
      return { opcode: TX_OP.setReferrer, body, referrer: reader.address() };
    }
    case TX_OP.burnAck: {
      const reader = readerOf(body);
      const op = Number(reader.u(32));
      if (op !== TX_OP.burnAck) return null;
      return {
        opcode: TX_OP.burnAck,
        body,
        roundId: reader.uNumber(8),
        kind: reader.uNumber(8),
        amountRaw: reader.u(128),
        burnId: reader.u(256),
      };
    }
    case TX_OP.teamReleasedAck: {
      const reader = readerOf(body);
      const op = Number(reader.u(32));
      if (op !== TX_OP.teamReleasedAck) return null;
      return { opcode: TX_OP.teamReleasedAck, body, queryId: reader.u(64), roundId: reader.uNumber(8), amountRaw: reader.u(128) };
    }
    case TX_OP.teamBurnedAck: {
      const reader = readerOf(body);
      const op = Number(reader.u(32));
      if (op !== TX_OP.teamBurnedAck) return null;
      return {
        opcode: TX_OP.teamBurnedAck,
        body,
        queryId: reader.u(64),
        roundId: reader.uNumber(8),
        amountRaw: reader.u(128),
        burnId: reader.u(256),
      };
    }
    case TX_OP.askToBurn: {
      const reader = readerOf(body);
      const op = Number(reader.u(32));
      if (op !== TX_OP.askToBurn) return null;
      const queryId = reader.u(64);
      const amountRaw = reader.u(128);
      // sendExcessesTo: Maybe address（0 = none）
      let responseDestination: AskToBurnMessage['responseDestination'] = null;
      if (reader.remaining > 2 && reader.u(1) === 1n) responseDestination = reader.address();
      return { opcode: TX_OP.askToBurn, body, queryId, amountRaw, responseDestination };
    }
    case TX_OP.returnExcessesBack: {
      const reader = readerOf(body);
      const op = Number(reader.u(32));
      if (op !== TX_OP.returnExcessesBack) return null;
      return { opcode: TX_OP.returnExcessesBack, body, queryId: reader.u(64) };
    }
    default:
      return null;
  }
}

/** burn queryId 口径：roundId<<16 | kind<<8 | nonce（contracts RoundController.burnQueryId）。 */
export function burnQueryRoundId(queryId: bigint): number {
  return Number((queryId >> 16n) & 0xffn);
}

/** burn kind：1 = reward，2 = team，3 = principal（BurnAck.kind 同口径）。 */
export function burnKindName(kind: number): 'reward' | 'team' | 'principal' | null {
  if (kind === 1) return 'reward';
  if (kind === 2) return 'team';
  if (kind === 3) return 'principal';
  return null;
}
