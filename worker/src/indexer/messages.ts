/**
 * 链上入站消息（用户/keeper/Jetton 钱包 → RoundController）的 body 解码。
 * 用途：SubmitCandle 是 chain 模式 K 线的唯一权威来源（合约不逐根存 K 线，只存 rolling hash）。
 * 所有布局对齐 contracts/contracts/types.tolk（v10）；opcode 见 contracts/README §4.1。
 * v10 只剩下列入站 opcode：OpenRound / CloseStaking / SubmitCandle / Claim / ClaimAll /
 * StakeDeposit（forward_payload 内）/ AbortTechnical / RetrySettlement + transfer_notification。
 */
import { BitReader, parseBocBytes, base64ToBytes, type BocBag, type BocCell } from './boc';

export const TX_OP = {
  openRound: 0x52540001,
  closeStaking: 0x52540002,
  submitCandle: 0x52540003,
  /** Claim(roundId)：本金 + 全额奖励；roundId 0 = 退款账本 */
  claim: 0x52540006,
  /** ClaimAll：0..10 轮全部 + 退款账本（roundId 字段忽略） */
  claimAll: 0x5254000e,
  /** 质押 payload 的 op（只出现在 transfer_notification.forward_payload 内） */
  stakeDeposit: 0x5254000f,
  abortTechnical: 0x52540010,
  retrySettlement: 0x52540015,
  transferNotification: 0x7362d09c,
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
  /** v10 忽略（没有提前关窗） */
  twap1hUsdE8: bigint;
}

export interface RoundIdMessage extends InboundMessageBase {
  opcode: typeof TX_OP.claim | typeof TX_OP.claimAll | typeof TX_OP.retrySettlement;
  queryId: bigint;
  roundId: number;
}

export interface AbortTechnicalMessage extends InboundMessageBase {
  opcode: typeof TX_OP.abortTechnical;
  queryId: bigint;
}

export interface StakePayload {
  version: number;
  roundId: number;
  depositNonce: bigint;
  riskDisclosureVersion: number;
  acceptFullPrincipalBurn: number;
}

export interface TransferNotificationMessage extends InboundMessageBase {
  opcode: typeof TX_OP.transferNotification;
  queryId: bigint;
  jettonAmount: bigint;
  transferInitiator: { workchain: number; hashHex: string; raw: string } | null;
  /** forward_payload 是质押 payload 时解析出的字段；否则 null（合约会走退款路径） */
  stake: StakePayload | null;
}

export type DecodedInboundMessage =
  | SubmitCandleMessage
  | OpenRoundMessage
  | CloseStakingMessage
  | RoundIdMessage
  | AbortTechnicalMessage
  | TransferNotificationMessage;

export interface RawMessageInput {
  opcode: number;
  /** message_content.body（BOC base64） */
  body: string;
}

function readerOf(body: string): BitReader {
  const bag = parseBocBytes(base64ToBytes(body));
  return new BitReader(bag.cells[bag.rootIndex]);
}

/** 读 TL-B coins（VarUInteger 16：4 bit 字节数 + 大端值）。 */
function readCoins(reader: BitReader): bigint {
  const len = reader.uNumber(4);
  return len === 0 ? 0n : reader.u(len * 8);
}

function parseStakePayload(cell: BocCell, startBit: number): StakePayload | null {
  const reader = new BitReader(cell);
  if (startBit > 0) reader.skip(startBit);
  if (reader.remaining < 136) return null;
  const op = reader.uNumber(32);
  if (op !== TX_OP.stakeDeposit) return null;
  return {
    version: reader.uNumber(8),
    roundId: reader.uNumber(8),
    depositNonce: reader.u(64),
    riskDisclosureVersion: reader.uNumber(16),
    acceptFullPrincipalBurn: reader.uNumber(8),
  };
}

function decodeTransferNotification(body: string): TransferNotificationMessage | null {
  const bag: BocBag = parseBocBytes(base64ToBytes(body));
  const root = bag.cells[bag.rootIndex];
  const reader = new BitReader(root);
  if (reader.uNumber(32) !== TX_OP.transferNotification) return null;
  const queryId = reader.u(64);
  const jettonAmount = readCoins(reader);
  // 标准 Jetton 钱包总是填 addr_std 的 initiator
  const transferInitiator = reader.address();
  let stake: StakePayload | null = null;
  if (reader.remaining >= 1) {
    const inRef = reader.u(1) === 1n;
    if (inRef) {
      const refIndex = root.refIndexes[0];
      const ref = refIndex === undefined ? undefined : bag.cells[refIndex];
      if (ref) stake = parseStakePayload(ref, 0);
    } else {
      stake = parseStakePayload(root, reader.position);
    }
  }
  return { opcode: TX_OP.transferNotification, body, queryId, jettonAmount, transferInitiator, stake };
}

/** 解码一条消息 body；未识别的 opcode 返回 null（调用方计入 unknown_ops）。 */
export function decodeInboundMessage(input: RawMessageInput): DecodedInboundMessage | null {
  const body = input.body;
  if (!body) return null;
  switch (input.opcode) {
    case TX_OP.submitCandle: {
      const reader = readerOf(body);
      if (reader.uNumber(32) !== TX_OP.submitCandle) return null;
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
      if (reader.uNumber(32) !== TX_OP.openRound) return null;
      return { opcode: TX_OP.openRound, body, queryId: reader.u(64), twap24hUsdE8: reader.u(128) };
    }
    case TX_OP.closeStaking: {
      const reader = readerOf(body);
      if (reader.uNumber(32) !== TX_OP.closeStaking) return null;
      return { opcode: TX_OP.closeStaking, body, queryId: reader.u(64), twap1hUsdE8: reader.u(128) };
    }
    case TX_OP.claim:
    case TX_OP.claimAll:
    case TX_OP.retrySettlement: {
      const reader = readerOf(body);
      const op = reader.uNumber(32);
      if (op !== input.opcode) return null;
      return { opcode: op as RoundIdMessage['opcode'], body, queryId: reader.u(64), roundId: reader.uNumber(8) };
    }
    case TX_OP.abortTechnical: {
      const reader = readerOf(body);
      if (reader.uNumber(32) !== TX_OP.abortTechnical) return null;
      return { opcode: TX_OP.abortTechnical, body, queryId: reader.u(64) };
    }
    case TX_OP.transferNotification:
      return decodeTransferNotification(body);
    default:
      return null;
  }
}
