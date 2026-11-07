/**
 * 链上入站消息（用户/keeper/Jetton 钱包/攻城令 → RoundController）的 body 解码。
 * 用途：SubmitCandle 是 chain 模式 K 线的唯一权威来源（合约不逐根存 K 线，只存 rolling hash）。
 * 所有布局对齐 contracts/contracts/types.tolk 与 ticket.tolk（v11）。
 * v11 的入站 opcode：OpenRound / CloseStaking / SubmitCandle / AbortTechnical / RetrySettlement /
 * ReleaseTeam / TicketRequest（攻城令 → RC）+ transfer_notification（forward_payload 内为 StakePayload v2）。
 * Claim / ClaimAll 已从 RC 移除（用户直接发 TicketClaim / TicketRestake 给自己的攻城令）。
 */
import { BitReader, parseBocBytes, base64ToBytes, type BocBag, type BocCell } from './boc';

export const TX_OP = {
  openRound: 0x52540001,
  closeStaking: 0x52540002,
  submitCandle: 0x52540003,
  /** 质押 payload 的 op（只出现在 transfer_notification.forward_payload 内） */
  stakeDeposit: 0x5254000f,
  abortTechnical: 0x52540010,
  retrySettlement: 0x52540015,
  releaseTeam: 0x52540016,
  /** 攻城令 → RC：领取 / 续战请求 */
  ticketRequest: 0x52540305,
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
  /** 合约忽略（没有提前关窗） */
  twap1hUsdE8: bigint;
}

export interface RetrySettlementMessage extends InboundMessageBase {
  opcode: typeof TX_OP.retrySettlement;
  queryId: bigint;
  roundId: number;
}

export interface QueryOnlyMessage extends InboundMessageBase {
  opcode: typeof TX_OP.releaseTeam | typeof TX_OP.abortTechnical;
  queryId: bigint;
}

export interface TicketRequestMessage extends InboundMessageBase {
  opcode: typeof TX_OP.ticketRequest;
  queryId: bigint;
  owner: { workchain: number; hashHex: string; raw: string };
  roundId: number;
  amountRaw: bigint;
  weightRaw: bigint;
  principalDone: boolean;
  lockedClaimedRaw: bigint;
  restake: boolean;
}

/** StakePayload v2（docs/35 §3.2）：beneficiary = null 时记在转账发起人名下。 */
export interface StakePayload {
  version: number;
  roundId: number;
  riskDisclosureVersion: number;
  acceptFullPrincipalBurn: number;
  beneficiary: { workchain: number; hashHex: string; raw: string } | null;
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
  | RetrySettlementMessage
  | QueryOnlyMessage
  | TicketRequestMessage
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

/** StakePayload v2：op(32) version(8)=2 roundId(8) riskVersion(16) acceptBurn(8) beneficiary(addr_none | addr_std)。 */
function parseStakePayload(cell: BocCell, startBit: number): StakePayload | null {
  const reader = new BitReader(cell);
  if (startBit > 0) reader.skip(startBit);
  if (reader.remaining < 74) return null;
  const op = reader.uNumber(32);
  if (op !== TX_OP.stakeDeposit) return null;
  const version = reader.uNumber(8);
  const roundId = reader.uNumber(8);
  const riskDisclosureVersion = reader.uNumber(16);
  const acceptFullPrincipalBurn = reader.uNumber(8);
  let beneficiary: StakePayload['beneficiary'] = null;
  const head = reader.preloadUint(2);
  if (head === 0) {
    reader.skip(2);
  } else if (head === 2 && reader.remaining === 267) {
    beneficiary = reader.address();
  } else {
    return null;
  }
  if (reader.remaining !== 0) return null;
  return { version, roundId, riskDisclosureVersion, acceptFullPrincipalBurn, beneficiary };
}

function decodeTicketRequest(body: string): TicketRequestMessage | null {
  const reader = readerOf(body);
  if (reader.uNumber(32) !== TX_OP.ticketRequest) return null;
  return {
    opcode: TX_OP.ticketRequest,
    body,
    queryId: reader.u(64),
    owner: reader.address(),
    roundId: reader.uNumber(8),
    amountRaw: reader.u(128),
    weightRaw: reader.u(128),
    principalDone: reader.u(1) === 1n,
    lockedClaimedRaw: reader.u(128),
    restake: reader.u(1) === 1n,
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
    case TX_OP.retrySettlement: {
      const reader = readerOf(body);
      if (reader.uNumber(32) !== TX_OP.retrySettlement) return null;
      return { opcode: TX_OP.retrySettlement, body, queryId: reader.u(64), roundId: reader.uNumber(8) };
    }
    case TX_OP.releaseTeam:
    case TX_OP.abortTechnical: {
      const reader = readerOf(body);
      if (reader.uNumber(32) !== input.opcode) return null;
      return { opcode: input.opcode as QueryOnlyMessage['opcode'], body, queryId: reader.u(64) };
    }
    case TX_OP.ticketRequest:
      return decodeTicketRequest(body);
    case TX_OP.transferNotification:
      return decodeTransferNotification(body);
    default:
      return null;
  }
}
