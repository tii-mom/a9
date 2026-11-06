/**
 * 链上消息解码（回执校验用）。
 * 只解析本项目关心的消息：
 *   - TEP-74 transfer_notification（Jetton 到账通知，携带 StakePayload）
 *   - TicketClaim / TicketRestake（用户 → 自己的攻城令，v11）
 */

import { parseTonAddress, type TonAddress } from './address';
import { CellSlice, parseBocBase64, type ParsedCell } from './cell';
import { OPCODES } from './protocol';

export const JETTON_TRANSFER_NOTIFICATION_OP = 0x7362d09c;

export interface StakeForwardPayload {
  op: number;
  /** v11 = 2 */
  version: number;
  roundId: number;
  riskDisclosureVersion: number;
  acceptFullPrincipalBurn: number;
  /** 受益人；null = 记在转账发起人名下（addr_none） */
  beneficiary: TonAddress | null;
}

/** 解析 StakePayload cell；op 不匹配返回 null。 */
export function decodeStakePayload(cell: ParsedCell | null | undefined): StakeForwardPayload | null {
  if (!cell) return null;
  try {
    const slice = new CellSlice(cell);
    const op = slice.loadUintNumber(32);
    if (op !== OPCODES.STAKE_DEPOSIT) return null;
    const version = slice.loadUintNumber(8);
    const roundId = slice.loadUintNumber(8);
    const riskDisclosureVersion = slice.loadUintNumber(16);
    const acceptFullPrincipalBurn = slice.loadUintNumber(8);
    // beneficiary: addr_none = 00；addr_std = 10 | anycast(0) | workchain(8) | hash(256)
    const tag = slice.loadUintNumber(2);
    let beneficiary: TonAddress | null = null;
    if (tag === 2) {
      if (slice.loadBit()) return null;
      const wcRaw = slice.loadUintNumber(8);
      const workchain = wcRaw > 127 ? wcRaw - 256 : wcRaw;
      const hash = slice.loadUint(256).toString(16).padStart(64, '0');
      beneficiary = parseTonAddress(workchain + ':' + hash);
    } else if (tag !== 0) {
      return null;
    }
    return { op, version, roundId, riskDisclosureVersion, acceptFullPrincipalBurn, beneficiary };
  } catch {
    return null;
  }
}

export interface JettonNotification {
  queryId: bigint;
  amountRaw: bigint;
  sender: TonAddress | null;
  forwardPayload: ParsedCell | null;
  stake: StakeForwardPayload | null;
}

/** 解析 base64 BOC 形式的 transfer_notification 消息体。 */
export function decodeJettonNotification(bodyBase64: string | null | undefined): JettonNotification | null {
  if (!bodyBase64) return null;
  let roots: ParsedCell[];
  try {
    roots = parseBocBase64(bodyBase64);
  } catch {
    return null;
  }
  const root = roots[0];
  if (!root) return null;
  try {
    const slice = new CellSlice(root);
    const op = slice.loadUintNumber(32);
    if (op !== JETTON_TRANSFER_NOTIFICATION_OP) return null;
    const queryId = slice.loadUint(64);
    const amountRaw = slice.loadCoins();
    const sender = slice.loadAddress();
    const isRef = slice.loadBit();
    let forwardPayload: ParsedCell | null = null;
    if (isRef) {
      forwardPayload = root.refs[0] ?? null;
    } else {
      forwardPayload = { bits: slice.readRemainingBits(), refs: [] };
    }
    return { queryId, amountRaw, sender, forwardPayload, stake: decodeStakePayload(forwardPayload) };
  } catch {
    return null;
  }
}

export interface ClaimMessage {
  op: number;
  queryId: bigint;
  /** 攻城令消息不携带 roundId（攻城令地址即轮次身份） */
  roundId: number | null;
}

/** 解析攻城令消息体（TicketClaim / TicketRestake）。 */
export function decodeClaimMessage(bodyBase64: string | null | undefined): ClaimMessage | null {
  if (!bodyBase64) return null;
  let roots: ParsedCell[];
  try {
    roots = parseBocBase64(bodyBase64);
  } catch {
    return null;
  }
  const root = roots[0];
  if (!root) return null;
  try {
    const slice = new CellSlice(root);
    const op = slice.loadUintNumber(32);
    if (op !== OPCODES.TICKET_CLAIM && op !== OPCODES.TICKET_RESTAKE) return null;
    return { op, queryId: slice.loadUint(64), roundId: null };
  } catch {
    return null;
  }
}

/** 用户 → 攻城令的操作消息（v11：TicketClaim / TicketRestake）。 */
export interface UserActionMessage {
  op: number;
  queryId: bigint | null;
  roundId: number | null;
}

const ROUND_ACTION_OPS: readonly number[] = [OPCODES.TICKET_CLAIM, OPCODES.TICKET_RESTAKE];

/** 解析用户操作消息体（回执匹配用；未知 op 返回 null）。 */
export function decodeUserAction(bodyBase64: string | null | undefined): UserActionMessage | null {
  if (!bodyBase64) return null;
  let roots: ParsedCell[];
  try {
    roots = parseBocBase64(bodyBase64);
  } catch {
    return null;
  }
  const root = roots[0];
  if (!root) return null;
  try {
    const slice = new CellSlice(root);
    const op = slice.loadUintNumber(32);
    if (ROUND_ACTION_OPS.includes(op)) {
      return { op, queryId: slice.loadUint(64), roundId: null };
    }
    return null;
  } catch {
    return null;
  }
}

/** 读取消息体 opcode（失败返回 null）。 */
export function decodeOpcode(bodyBase64: string | null | undefined): number | null {
  if (!bodyBase64) return null;
  try {
    const roots = parseBocBase64(bodyBase64);
    const root = roots[0];
    if (!root) return null;
    return new CellSlice(root).loadUintNumber(32);
  } catch {
    return null;
  }
}
