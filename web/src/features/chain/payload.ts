/**
 * 交易消息体构造（payload @ TON Connect）。
 * 位布局见 docs/04 §19 与 web/src/features/chain/README.md：
 *
 * StakePayload (136 bit)
 *   op:uint32=0x5254000F | version:uint8=1 | roundId:uint8
 *   | depositNonce:uint64 | riskDisclosureVersion:uint16
 *   | acceptFullPrincipalBurn:uint8(1)
 *
 * JettonTransfer (TEP-74 0xF8A7EA5)
 *   op:uint32 | queryId:uint64 | amount:Coins | destination:MsgAddress
 *   | response_destination:MsgAddress | custom_payload:(Maybe ^Cell)=0
 *   | forward_ton_amount:Coins | forward_payload:(Either Cell ^Cell)=ref
 *
 * ClaimPayload (104 bit)
 *   op:uint32 | queryId:uint64 | roundId:uint8  (ClaimAll: roundId=0 → 扫描 ≤10 轮)
 */

import type { TonAddress } from './address';
import { beginCell, type ChainCell } from './cell';
import { ACCEPT_FULL_PRINCIPAL_BURN, JETTON_TRANSFER_OP, STAKE_PAYLOAD_VERSION } from './protocol';

export interface StakePayloadParams {
  roundId: number;
  depositNonce: bigint | number | string;
  riskDisclosureVersion: number;
  version?: number;
  acceptFullPrincipalBurn?: number;
}

/** StakePayload cell（作为 Jetton transfer 的 forward_payload 引用）。 */
export function buildStakePayloadCell(params: StakePayloadParams): ChainCell {
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId < 0 || roundId > 255) throw new Error('roundId 非法: ' + params.roundId);
  const version = params.version ?? STAKE_PAYLOAD_VERSION;
  const accept = params.acceptFullPrincipalBurn ?? ACCEPT_FULL_PRINCIPAL_BURN;
  if (accept !== 0 && accept !== 1) throw new Error('acceptFullPrincipalBurn 必须是 0/1');
  const riskVersion = Number(params.riskDisclosureVersion);
  if (!Number.isInteger(riskVersion) || riskVersion < 0 || riskVersion > 0xffff) throw new Error('riskDisclosureVersion 非法: ' + params.riskDisclosureVersion);

  return beginCell()
    .writeUint(0x5254000f, 32)
    .writeUint(version, 8)
    .writeUint(roundId, 8)
    .writeUint(params.depositNonce, 64)
    .writeUint(riskVersion, 16)
    .writeUint(accept, 8)
    .end();
}

export interface JettonTransferParams {
  /** 本次转移的 A9 数量（raw units） */
  amountRaw: bigint | string;
  /** Jetton 的接收方 owner 地址（本项目为 RoundController） */
  destination: TonAddress;
  /** 退款 / 回执地址（用户本人） */
  responseDestination: TonAddress;
  /** 随 transfer 转发给 destination 的 TON，用于触发 transfer_notification */
  forwardTonNano: bigint | string;
  /** 随通知一起转发的协议 payload（StakePayload） */
  forwardPayload: ChainCell;
  queryId?: bigint | number | string;
}

/** 标准 Jetton transfer 消息体。 */
export function buildJettonTransferCell(params: JettonTransferParams): ChainCell {
  const queryId = params.queryId ?? 0n;
  return beginCell()
    .writeUint(JETTON_TRANSFER_OP, 32)
    .writeUint(queryId, 64)
    .writeCoins(params.amountRaw)
    .writeAddress(params.destination)
    .writeAddress(params.responseDestination)
    .writeBit(0) // custom_payload: Maybe ^Cell = none
    .writeCoins(params.forwardTonNano)
    .writeBit(1) // forward_payload: Either Cell ^Cell → 用引用承载
    .ref(params.forwardPayload)
    .end();
}

export interface ClaimPayloadParams {
  op: number;
  queryId: bigint | number | string;
  /** ClaimAll 时 0 表示扫描全部已结算轮次（≤10） */
  roundId: number;
}

/** 领取（ClaimPrincipal / ClaimReward / ClaimAll）消息体。 */
export function buildClaimPayloadCell(params: ClaimPayloadParams): ChainCell {
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId < 0 || roundId > 255) throw new Error('roundId 非法: ' + params.roundId);
  return beginCell().writeUint(params.op, 32).writeUint(params.queryId, 64).writeUint(roundId, 8).end();
}
