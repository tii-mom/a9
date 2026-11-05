/**
 * 交易准备：参数校验 + 构造 TON Connect 消息。
 * 发送由 wallet 模块的 sendTonConnectTransaction 完成（复用同一个 TonConnectUI 实例）。
 */

import type { RoundSummary } from '@shared/types';
import { parseTonAddress, toRawAddress, type TonAddress } from './address';
import { toBocBase64 } from './cell';
import type { ChainConfig } from './config';
import { chainError, ChainError } from './errors';
import { buildClaimPayloadCell, buildJettonTransferCell, buildSetReferrerCell, buildStakePayloadCell, buildUnlockCell } from './payload';
import {
  DEFAULT_CLAIM_MESSAGE_TON_NANO,
  DEFAULT_FORWARD_TON_NANO,
  DEFAULT_STAKE_MESSAGE_TON_NANO,
  MIN_CLAIM_TON_BALANCE,
  MIN_STAKE_TON_BALANCE,
  OPCODES,
  TX_VALID_FOR_SECONDS,
  nextDepositNonce,
  nextQueryId,
} from './protocol';

export interface TonConnectMessage {
  address: string;
  /** nanoTon，字符串 */
  amount: string;
  payload?: string;
  stateInit?: string;
}

export interface TonConnectTxRequest {
  validUntil?: number;
  network?: string;
  from?: string;
  messages: TonConnectMessage[];
}

export interface WalletContext {
  address: string;
  demo: boolean;
  /** 人类可读 TON 余额（如 "1,250.00"），未知为 null */
  tonBalance: string | null;
}

export type ChainTxKind =
  | 'stake'
  | 'claimPrincipal'
  | 'claimReward'
  | 'claimAll'
  | 'claimRewardEarly'
  | 'rollReward'
  | 'setReferrer'
  | 'claimUnlocked';

export type ClaimKind = 'claimPrincipal' | 'claimReward' | 'claimAll';

/** V8 单轮奖励操作。 */
export type RewardActionKind = 'claimRewardEarly' | 'rollReward';

const CLAIM_OPCODE: Record<ClaimKind, number> = {
  claimPrincipal: OPCODES.CLAIM_PRINCIPAL,
  claimReward: OPCODES.CLAIM_REWARD,
  claimAll: OPCODES.CLAIM_ALL,
};

const REWARD_ACTION_OPCODE: Record<RewardActionKind, number> = {
  claimRewardEarly: OPCODES.CLAIM_REWARD_EARLY,
  rollReward: OPCODES.ROLL_REWARD,
};

export interface PreparedTx {
  request: TonConnectTxRequest;
  meta: {
    kind: ChainTxKind;
    opcode: number;
    roundId: number | null;
    amountRaw: string | null;
    depositNonce: string | null;
    queryId: string;
    contract: string;
    requiresJettonWallet: boolean;
    /** 仅 SetReferrer：被邀请人地址（raw） */
    referrer: string | null;
  };
}

/** TON 余额字符串 → 数字（解析失败返回 null）。 */
export function tonBalanceToNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const value = Number(String(text).replace(/,/g, '').trim());
  return Number.isFinite(value) ? value : null;
}

/** 解析配置/钱包地址；非法时给 BAD_CONFIG（避免原始 CRC 报错直达 UI）。 */
function requireTonAddress(value: string, label: string): TonAddress {
  try {
    return parseTonAddress(value);
  } catch {
    throw chainError('BAD_CONFIG', '地址不合法: ' + label, value);
  }
}

function assertWalletReady(chain: ChainConfig, wallet: WalletContext): void {
  if (!chain.configured) throw chainError('CHAIN_NOT_CONFIGURED');
  if (!wallet.address) throw chainError('WALLET_NOT_CONNECTED');
  if (wallet.demo) throw chainError('DEMO_WALLET');
}

function assertGas(chain: ChainConfig, wallet: WalletContext, minimum: number): void {
  const balance = tonBalanceToNumber(wallet.tonBalance);
  if (balance === null) return; // 余额未知时不阻断，由钱包端最终校验
  if (balance < minimum) {
    throw chainError('INSUFFICIENT_BALANCE', 'TON 余额不足', '需要 ≥ ' + minimum + ' TON（当前 ' + balance + ' TON）');
  }
}

/** 质押前置校验（金额、窗口、限额、gas）。 */
export function validateStake(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  round: RoundSummary;
  amountRaw: bigint;
  myStakeRaw?: bigint;
  now?: number;
}): void {
  const { chain, wallet, round, amountRaw } = params;
  const now = params.now ?? Date.now();
  assertWalletReady(chain, wallet);
  if (round.state !== 'STAKING_OPEN') throw chainError('ROUND_NOT_OPEN', '当前轮不在报名窗口', round.state);
  if (round.stakeOpenAt !== null && now < round.stakeOpenAt) throw chainError('ROUND_NOT_OPEN', '报名窗口尚未开启');
  if (round.stakeCloseAt !== null && now >= round.stakeCloseAt) throw chainError('ROUND_NOT_OPEN', '报名窗口已关闭');
  if (amountRaw <= 0n) throw chainError('AMOUNT_INVALID');
  if (amountRaw < chain.minStakeRaw) {
    throw chainError('AMOUNT_TOO_SMALL', '低于单笔最低质押', '最低 ' + chain.minStakeRaw.toString());
  }
  if (amountRaw > chain.maxTotalStakeRaw) {
    throw chainError('AMOUNT_TOO_LARGE', '超过本轮总质押上限', '上限 ' + chain.maxTotalStakeRaw.toString());
  }
  // 单地址累计 ≤ 固定硬顶（V6.1：20,000,000 A9，不随本轮总量浮动）
  const mine = (params.myStakeRaw ?? 0n) + amountRaw;
  if (chain.maxStakePerAddressRaw > 0n && mine > chain.maxStakePerAddressRaw) {
    throw chainError(
      'AMOUNT_TOO_LARGE',
      '单地址质押超过硬顶',
      '单地址上限 ' + chain.maxStakePerAddressRaw.toString() + ' raw（含本轮已有质押）',
    );
  }
  assertGas(chain, wallet, MIN_STAKE_TON_BALANCE);
}

/** 领取前置校验（钱包、gas）。 */
export function validateClaim(params: { chain: ChainConfig; wallet: WalletContext }): void {
  assertWalletReady(params.chain, params.wallet);
  assertGas(params.chain, params.wallet, MIN_CLAIM_TON_BALANCE);
}

function validUntilSeconds(): number {
  return Math.floor(Date.now() / 1000) + TX_VALID_FOR_SECONDS;
}

/**
 * 构造质押交易：
 *   用户钱包 → 用户 Jetton Wallet（TEP-74 transfer）
 *   destination = RoundController，forward_payload = StakePayload
 */
export async function prepareStakeTransaction(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  round: RoundSummary;
  amountRaw: bigint;
  riskDisclosureVersion: number;
  jettonWalletFriendly: string;
  depositNonce?: bigint;
  signal?: AbortSignal;
}): Promise<PreparedTx> {
  const { chain, wallet, round, amountRaw } = params;
  if (!chain.roundController) throw chainError('CHAIN_NOT_CONFIGURED');
  const nonce = params.depositNonce ?? nextDepositNonce();
  const roundId = round.roundId;
  const stakePayload = buildStakePayloadCell({
    roundId,
    depositNonce: nonce,
    riskDisclosureVersion: params.riskDisclosureVersion,
  });
  const transferCell = buildJettonTransferCell({
    amountRaw,
    destination: requireTonAddress(chain.roundController, 'roundController'),
    responseDestination: requireTonAddress(wallet.address, 'wallet'),
    forwardTonNano: DEFAULT_FORWARD_TON_NANO,
    forwardPayload: stakePayload,
  });
  const request: TonConnectTxRequest = {
    validUntil: validUntilSeconds(),
    network: chain.chainId ?? undefined,
    from: toRawAddress(requireTonAddress(wallet.address, 'wallet')),
    messages: [
      {
        address: params.jettonWalletFriendly,
        amount: DEFAULT_STAKE_MESSAGE_TON_NANO.toString(),
        payload: toBocBase64(transferCell),
      },
    ],
  };
  return {
    request,
    meta: {
      kind: 'stake',
      opcode: OPCODES.STAKE_DEPOSIT,
      roundId,
      amountRaw: amountRaw.toString(),
      depositNonce: nonce.toString(),
      queryId: '0',
      contract: chain.roundController,
      requiresJettonWallet: true,
      referrer: null,
    },
  };
}

/** 构造领取交易（ClaimPrincipal / ClaimReward / ClaimAll → RoundController）。 */
export function prepareClaimTransaction(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  kind: ClaimKind;
  roundId?: number | null;
  queryId?: bigint;
}): PreparedTx {
  const { chain, wallet, kind } = params;
  if (!chain.roundController) throw chainError('CHAIN_NOT_CONFIGURED');
  const roundId = kind === 'claimAll' ? 0 : Number(params.roundId ?? 0);
  if (kind !== 'claimAll' && (roundId <= 0 || roundId > 255)) throw chainError('BAD_CONFIG', 'roundId 非法: ' + roundId);
  const queryId = params.queryId ?? nextQueryId();
  const payload = buildClaimPayloadCell({ op: CLAIM_OPCODE[kind], queryId, roundId });
  const request: TonConnectTxRequest = {
    validUntil: validUntilSeconds(),
    network: chain.chainId ?? undefined,
    from: toRawAddress(requireTonAddress(wallet.address, 'wallet')),
    messages: [
      {
        address: chain.roundController,
        amount: DEFAULT_CLAIM_MESSAGE_TON_NANO.toString(),
        payload: toBocBase64(payload),
      },
    ],
  };
  return {
    request,
    meta: {
      kind,
      opcode: CLAIM_OPCODE[kind],
      roundId: kind === 'claimAll' ? 0 : roundId,
      amountRaw: null,
      depositNonce: null,
      queryId: queryId.toString(),
      contract: chain.roundController,
      requiresJettonWallet: false,
      referrer: null,
    },
  };
}

/** V8：构造单轮奖励操作（ClaimRewardEarly / RollReward → RoundController）。 */
export function prepareRewardActionTransaction(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  kind: RewardActionKind;
  roundId: number;
  queryId?: bigint;
}): PreparedTx {
  const { chain, wallet, kind } = params;
  if (!chain.roundController) throw chainError('CHAIN_NOT_CONFIGURED');
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId <= 0 || roundId > 255) throw chainError('BAD_CONFIG', 'roundId 非法: ' + params.roundId);
  const queryId = params.queryId ?? nextQueryId();
  const payload = buildClaimPayloadCell({ op: REWARD_ACTION_OPCODE[kind], queryId, roundId });
  return {
    request: {
      validUntil: validUntilSeconds(),
      network: chain.chainId ?? undefined,
      from: toRawAddress(requireTonAddress(wallet.address, 'wallet')),
      messages: [
        {
          address: chain.roundController,
          amount: DEFAULT_CLAIM_MESSAGE_TON_NANO.toString(),
          payload: toBocBase64(payload),
        },
      ],
    },
    meta: {
      kind,
      opcode: REWARD_ACTION_OPCODE[kind],
      roundId,
      amountRaw: null,
      depositNonce: null,
      queryId: queryId.toString(),
      contract: chain.roundController,
      requiresJettonWallet: false,
      referrer: null,
    },
  };
}

/** V8：构造绑定邀请人（SetReferrer → RoundController，一次性）。 */
export function prepareSetReferrerTransaction(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  referrer: string;
}): PreparedTx {
  const { chain, wallet } = params;
  if (!chain.roundController) throw chainError('CHAIN_NOT_CONFIGURED');
  const referrer = requireTonAddress(params.referrer, 'referrer');
  const self = requireTonAddress(wallet.address, 'wallet');
  if (toRawAddress(referrer) === toRawAddress(self)) throw chainError('BAD_CONFIG', '不能绑定自己为邀请人');
  const payload = buildSetReferrerCell(referrer);
  return {
    request: {
      validUntil: validUntilSeconds(),
      network: chain.chainId ?? undefined,
      from: toRawAddress(self),
      messages: [
        {
          address: chain.roundController,
          amount: DEFAULT_CLAIM_MESSAGE_TON_NANO.toString(),
          payload: toBocBase64(payload),
        },
      ],
    },
    meta: {
      kind: 'setReferrer',
      opcode: OPCODES.SET_REFERRER,
      roundId: null,
      amountRaw: null,
      depositNonce: null,
      queryId: '0',
      contract: chain.roundController,
      requiresJettonWallet: false,
      referrer: toRawAddress(referrer),
    },
  };
}

/** V8：构造领取解锁池（ClaimUnlocked → RoundController，R10 终态后）。 */
export function prepareClaimUnlockedTransaction(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  queryId?: bigint;
}): PreparedTx {
  const { chain, wallet } = params;
  if (!chain.roundController) throw chainError('CHAIN_NOT_CONFIGURED');
  const queryId = params.queryId ?? nextQueryId();
  const payload = buildUnlockCell(queryId);
  return {
    request: {
      validUntil: validUntilSeconds(),
      network: chain.chainId ?? undefined,
      from: toRawAddress(requireTonAddress(wallet.address, 'wallet')),
      messages: [
        {
          address: chain.roundController,
          amount: DEFAULT_CLAIM_MESSAGE_TON_NANO.toString(),
          payload: toBocBase64(payload),
        },
      ],
    },
    meta: {
      kind: 'claimUnlocked',
      opcode: OPCODES.CLAIM_UNLOCKED,
      roundId: null,
      amountRaw: null,
      depositNonce: null,
      queryId: queryId.toString(),
      contract: chain.roundController,
      requiresJettonWallet: false,
      referrer: null,
    },
  };
}

/** V8：奖励操作 / 邀请绑定 / 解锁 的共同前置校验（钱包、gas）。 */
export function validateRewardAction(params: { chain: ChainConfig; wallet: WalletContext }): void {
  assertWalletReady(params.chain, params.wallet);
  assertGas(params.chain, params.wallet, MIN_CLAIM_TON_BALANCE);
}

/** 是否为 ChainError（供 hook / UI 判定）。 */
export function isChainError(error: unknown): error is ChainError {
  return error instanceof ChainError;
}
