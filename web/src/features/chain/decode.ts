/**
 * 链上消息解码（回执校验用）。
 * 只解析本项目关心的消息：
 *   - TEP-74 transfer_notification（Jetton 到账通知，携带 StakePayload）
 *   - ClaimPrincipal / ClaimReward / ClaimAll（用户 → RoundController）
 */

import type { TonAddress } from './address';
import { CellSlice, parseBocBase64, type ParsedCell } from './cell';
import { OPCODES } from './protocol';

export const JETTON_TRANSFER_NOTIFICATION_OP = 0x7362d09c;

export interface StakeForwardPayload {
  op: number;
  version: number;
  roundId: number;
  depositNonce: bigint;
  riskDisclosureVersion: number;
  acceptFullPrincipalBurn: number;
}

/** 解析 StakePayload cell；op 不匹配返回 null。 */
export function decodeStakePayload(cell: ParsedCell | null | undefined): StakeForwardPayload | null {
  if (!cell) return null;
  try {
    const slice = new CellSlice(cell);
    const op = slice.loadUintNumber(32);
    if (op !== OPCODES.STAKE_DEPOSIT) return null;
    return {
      op,
      version: slice.loadUintNumber(8),
      roundId: slice.loadUintNumber(8),
      depositNonce: slice.loadUint(64),
      riskDisclosureVersion: slice.loadUintNumber(16),
      acceptFullPrincipalBurn: slice.loadUintNumber(8),
    };
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
  roundId: number;
}

/** 解析领取消息体（ClaimPrincipal / ClaimReward / ClaimAll）。 */
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
    if (op !== OPCODES.CLAIM_PRINCIPAL && op !== OPCODES.CLAIM_REWARD && op !== OPCODES.CLAIM_ALL) return null;
    return { op, queryId: slice.loadUint(64), roundId: slice.loadUintNumber(8) };
  } catch {
    return null;
  }
}

/** V8：用户 → RoundController 的通用操作消息（含新增 4 个 opcode）。 */
export interface UserActionMessage {
  op: number;
  queryId: bigint | null;
  roundId: number | null;
  /** 仅 SetReferrer */
  referrer: TonAddress | null;
}

const ROUND_ACTION_OPS: readonly number[] = [
  OPCODES.CLAIM_PRINCIPAL,
  OPCODES.CLAIM_REWARD,
  OPCODES.CLAIM_ALL,
  OPCODES.CLAIM_REWARD_EARLY,
  OPCODES.ROLL_REWARD,
];

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
    if (op === OPCODES.SET_REFERRER) {
      return { op, queryId: null, roundId: null, referrer: slice.loadAddress() };
    }
    if (op === OPCODES.CLAIM_UNLOCKED) {
      return { op, queryId: slice.loadUint(64), roundId: null, referrer: null };
    }
    if (ROUND_ACTION_OPS.includes(op)) {
      return { op, queryId: slice.loadUint(64), roundId: slice.loadUintNumber(8), referrer: null };
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
