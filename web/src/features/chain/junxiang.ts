/**
 * 军饷（junxiang）领取消息构造（docs/35 §4.4；合约 contracts/contracts/junxiang.tolk 与 JunxiangDistributor.tolk）。
 *
 * ClaimJunxiang（用户钱包 → 军饷分发合约，附 0.2 TON）
 *   op:uint32=0x4A580002 | queryId:uint64 | cumulativeRaw:uint128 | proof:(Maybe ^Cell)
 *
 * proof 编码：兄弟哈希（uint256，自底向上）每格打包 3 个，按给定顺序；
 *   后一格挂在前一格的 ref 0 上；数组为空时 proof 为 null（1 bit = 0，不带 ref）。
 *
 * 纯函数，不做网络请求；链上前置检查见 junxiangClaim.ts。
 */

import type { TonAddress } from './address';
import { parseTonAddress, toRawAddress } from './address';
import { beginCell, toBocBase64, type ChainCell } from './cell';
import type { ChainConfig } from './config';
import { chainError } from './errors';
import { nextQueryId, TX_VALID_FOR_SECONDS } from './protocol';
import type { TonConnectTxRequest, WalletContext } from './transactions';

/** ClaimJunxiang 的 opcode（与合约 struct (0x4a580002) 一致）。 */
export const JUNXIANG_CLAIM_OP = 0x4a580002;

/** 领取消息携带的 TON（合约 MIN_JUNXIANG_CLAIM_VALUE = 0.15 TON，此处取 0.2 TON 留余量）。 */
export const JUNXIANG_CLAIM_TON_NANO = 200_000_000n;

/** 每个 proof cell 装载的哈希数（3 × 256 bit = 768 bit，单 cell 上限 1023 bit）。 */
export const PROOF_HASHES_PER_CELL = 3;

/** 军饷分发合约的 getter 名（与合约 get fun 一致）。 */
export const JUNXIANG_GET = {
  distributor: 'get_distributor',
  recordAddress: 'get_record_address',
  record: 'get_record',
} as const;

/** 64 位 hex → uint256 数值；格式非法抛 BAD_CONFIG。 */
export function parseHash256(hex: string): bigint {
  const text = String(hex ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw chainError('BAD_CONFIG', 'merkle proof 节点必须是 64 位 hex', text);
  return BigInt('0x' + text);
}

/**
 * proof 链式 cell：按 3 个一组切分，末尾组在最深层，前一组的 ref 0 指向后一组。
 * 空数组返回 null（由调用方写入 Maybe 的 0 bit）。
 */
export function buildProofCell(proofHex: readonly string[]): ChainCell | null {
  if (proofHex.length === 0) return null;
  const hashes = proofHex.map(parseHash256);
  const groups: bigint[][] = [];
  for (let i = 0; i < hashes.length; i += PROOF_HASHES_PER_CELL) {
    groups.push(hashes.slice(i, i + PROOF_HASHES_PER_CELL));
  }
  let next: ChainCell | null = null;
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const builder = beginCell();
    for (const value of groups[g]) builder.writeUint(value, 256);
    if (next) builder.ref(next);
    next = builder.end();
  }
  return next;
}

export interface ClaimJunxiangBodyParams {
  /** 终身累计军饷（raw，uint128） */
  cumulativeRaw: bigint | string;
  /** 兄弟哈希（hex，自底向上） */
  proofHex: readonly string[];
  queryId?: bigint;
}

/** ClaimJunxiang 消息体。 */
export function buildClaimJunxiangBody(params: ClaimJunxiangBodyParams): ChainCell {
  const queryId = params.queryId ?? nextQueryId();
  const builder = beginCell()
    .writeUint(JUNXIANG_CLAIM_OP, 32)
    .writeUint(queryId, 64)
    .writeUint(BigInt(params.cumulativeRaw), 128);
  const proof = buildProofCell(params.proofHex);
  if (proof) {
    builder.writeBit(1).ref(proof);
  } else {
    builder.writeBit(0);
  }
  return builder.end();
}

export interface PreparedJunxiangClaim {
  request: TonConnectTxRequest;
  meta: {
    opcode: number;
    queryId: string;
    /** 军饷分发合约（接收 ClaimJunxiang 的地址，raw 形式） */
    contract: string;
    cumulativeRaw: string;
  };
}

/** 解析配置中的分发合约地址；未配置或非法抛 CHAIN_NOT_CONFIGURED / BAD_CONFIG。 */
export function junxiangDistributorAddress(chain: ChainConfig): TonAddress {
  if (!chain.junxiangDistributor) throw chainError('CHAIN_NOT_CONFIGURED', '军饷合约未配置');
  try {
    return parseTonAddress(chain.junxiangDistributor);
  } catch {
    throw chainError('BAD_CONFIG', '地址不合法: junxiangDistributor', chain.junxiangDistributor);
  }
}

/** 构造领取军饷交易（用户钱包 → 分发合约，附 0.2 TON）。 */
export function prepareJunxiangClaimTransaction(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  cumulativeRaw: bigint | string;
  proofHex: readonly string[];
  queryId?: bigint;
  now?: number;
}): PreparedJunxiangClaim {
  const { chain, wallet } = params;
  const distributor = junxiangDistributorAddress(chain);
  if (!wallet.address) throw chainError('WALLET_NOT_CONNECTED');
  const queryId = params.queryId ?? nextQueryId();
  const body = buildClaimJunxiangBody({ cumulativeRaw: params.cumulativeRaw, proofHex: params.proofHex, queryId });
  const validUntil = Math.floor((params.now ?? Date.now()) / 1000) + TX_VALID_FOR_SECONDS;
  return {
    request: {
      validUntil,
      network: chain.chainId ?? undefined,
      from: toRawAddress(parseTonAddress(wallet.address)),
      messages: [
        {
          address: toRawAddress(distributor),
          amount: JUNXIANG_CLAIM_TON_NANO.toString(),
          payload: toBocBase64(body),
        },
      ],
    },
    meta: {
      opcode: JUNXIANG_CLAIM_OP,
      queryId: queryId.toString(),
      contract: toRawAddress(distributor),
      cumulativeRaw: BigInt(params.cumulativeRaw).toString(),
    },
  };
}
