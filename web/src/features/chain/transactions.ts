/**
 * 交易准备：参数校验 + 构造 TON Connect 消息。
 * 发送由 wallet 模块的 sendTonConnectTransaction 完成（复用同一个 TonConnectUI 实例）。
 * v11：质押 payload v2（可选受益人）；领取 / 续战发给用户自己的攻城令（StakeTicket），不再有 ClaimAll / 退款账本。
 */

import type { RoundSummary } from '@shared/types';
import { parseTonAddress, toRawAddress, type TonAddress } from './address';
import { toBocBase64 } from './cell';
import type { ChainConfig } from './config';
import { chainError, ChainError } from './errors';
import { buildJettonTransferCell, buildStakePayloadCell, buildTicketPayloadCell } from './payload';
import {
  DEFAULT_FORWARD_TON_NANO,
  DEFAULT_STAKE_MESSAGE_TON_NANO,
  DEFAULT_TICKET_CLAIM_TON_NANO,
  DEFAULT_TICKET_RESTAKE_TON_NANO,
  MIN_CLAIM_TON_BALANCE,
  MIN_RESTAKE_TON_BALANCE,
  MIN_STAKE_TON_BALANCE,
  OPCODES,
  TX_VALID_FOR_SECONDS,
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

/** 链上交易类型：质押（转账入金）/ 攻城令领取 / 攻城令一键续战。 */
export type ChainTxKind = 'stake' | 'ticketClaim' | 'ticketRestake';

export interface PreparedTx {
  request: TonConnectTxRequest;
  meta: {
    kind: ChainTxKind;
    opcode: number;
    roundId: number | null;
    amountRaw: string | null;
    queryId: string;
    /** 交易接收合约：质押 = RoundController（经用户 Jetton 钱包）；领取 / 续战 = 该轮攻城令 */
    contract: string;
    requiresJettonWallet: boolean;
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
    throw chainError('INSUFFICIENT_BALANCE', 'GRAM 余额不足', '需要 ≥ ' + minimum + ' GRAM（当前 ' + balance + ' GRAM）');
  }
}

/** 质押前置校验（金额、窗口、gas）。v11 无单轮 / 单地址上限。 */
export function validateStake(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  round: RoundSummary;
  amountRaw: bigint;
  now?: number;
}): void {
  const { chain, wallet, round, amountRaw } = params;
  const now = params.now ?? Date.now();
  assertWalletReady(chain, wallet);
  if (round.state !== 'STAKING_OPEN') throw chainError('ROUND_NOT_OPEN', '当前轮不在攻城窗口', round.state);
  if (round.stakeOpenAt !== null && now < round.stakeOpenAt) throw chainError('ROUND_NOT_OPEN', '攻城窗口尚未开启');
  if (round.stakeCloseAt !== null && now >= round.stakeCloseAt) throw chainError('ROUND_NOT_OPEN', '攻城窗口已关闭');
  if (amountRaw <= 0n) throw chainError('AMOUNT_INVALID');
  if (amountRaw < chain.minStakeRaw) {
    throw chainError('AMOUNT_TOO_SMALL', '低于单笔最低质押', '最低 ' + chain.minStakeRaw.toString());
  }
  assertGas(chain, wallet, MIN_STAKE_TON_BALANCE);
}

/** 领取 / 续战前置校验（钱包、gas）。 */
export function validateClaim(params: { chain: ChainConfig; wallet: WalletContext }): void {
  assertWalletReady(params.chain, params.wallet);
  assertGas(params.chain, params.wallet, MIN_CLAIM_TON_BALANCE);
}

export function validateRestake(params: { chain: ChainConfig; wallet: WalletContext }): void {
  assertWalletReady(params.chain, params.wallet);
  assertGas(params.chain, params.wallet, MIN_RESTAKE_TON_BALANCE);
}

function validUntilSeconds(): number {
  return Math.floor(Date.now() / 1000) + TX_VALID_FOR_SECONDS;
}

/**
 * 构造质押交易（v11 StakePayload v2）：
 *   用户钱包 → 用户 Jetton Wallet（TEP-74 transfer）
 *   destination = RoundController，forward_payload = StakePayload v2（beneficiary 缺省 = 本人）
 */
export async function prepareStakeTransaction(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  round: RoundSummary;
  amountRaw: bigint;
  riskDisclosureVersion: number;
  jettonWalletFriendly: string;
  /** 一键上车 / 赠送攻城令：受益人地址（友好或 raw）；缺省 = 本人 */
  beneficiary?: string | null;
  signal?: AbortSignal;
}): Promise<PreparedTx> {
  const { chain, wallet, round, amountRaw } = params;
  if (!chain.roundController) throw chainError('CHAIN_NOT_CONFIGURED');
  const roundId = round.roundId;
  const beneficiary = params.beneficiary ? requireTonAddress(params.beneficiary, 'beneficiary') : null;
  const stakePayload = buildStakePayloadCell({
    roundId,
    riskDisclosureVersion: params.riskDisclosureVersion,
    beneficiary,
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
      queryId: '0',
      contract: chain.roundController,
      requiresJettonWallet: true,
    },
  };
}

/** 构造攻城令领取交易（TicketClaim → 用户自己的攻城令，附 0.2 TON）。 */
export function prepareTicketClaimTransaction(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  roundId: number;
  ticketAddress: string;
  queryId?: bigint;
}): PreparedTx {
  return prepareTicketTx({ ...params, kind: 'ticketClaim' });
}

/** 构造攻城令一键续战交易（TicketRestake → 用户自己的攻城令，附 0.3 TON）。 */
export function prepareTicketRestakeTransaction(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  roundId: number;
  ticketAddress: string;
  queryId?: bigint;
}): PreparedTx {
  return prepareTicketTx({ ...params, kind: 'ticketRestake' });
}

function prepareTicketTx(params: {
  chain: ChainConfig;
  wallet: WalletContext;
  roundId: number;
  ticketAddress: string;
  queryId?: bigint;
  kind: 'ticketClaim' | 'ticketRestake';
}): PreparedTx {
  const { chain, wallet, kind } = params;
  if (!chain.roundController) throw chainError('CHAIN_NOT_CONFIGURED');
  if (!Number.isInteger(params.roundId) || params.roundId < 1 || params.roundId > 255) {
    throw chainError('BAD_CONFIG', 'roundId 非法: ' + params.roundId);
  }
  const ticket = requireTonAddress(params.ticketAddress, 'ticket');
  const opcode = kind === 'ticketClaim' ? OPCODES.TICKET_CLAIM : OPCODES.TICKET_RESTAKE;
  const amount = kind === 'ticketClaim' ? DEFAULT_TICKET_CLAIM_TON_NANO : DEFAULT_TICKET_RESTAKE_TON_NANO;
  const queryId = params.queryId ?? nextQueryId();
  const payload = buildTicketPayloadCell({ op: opcode, queryId });
  const request: TonConnectTxRequest = {
    validUntil: validUntilSeconds(),
    network: chain.chainId ?? undefined,
    from: toRawAddress(requireTonAddress(wallet.address, 'wallet')),
    messages: [
      {
        address: toRawAddress(ticket),
        amount: amount.toString(),
        payload: toBocBase64(payload),
      },
    ],
  };
  return {
    request,
    meta: {
      kind,
      opcode,
      roundId: params.roundId,
      amountRaw: null,
      queryId: queryId.toString(),
      contract: toRawAddress(ticket),
      requiresJettonWallet: false,
    },
  };
}

/** 是否为 ChainError（供 hook / UI 判定）。 */
export function isChainError(error: unknown): error is ChainError {
  return error instanceof ChainError;
}
