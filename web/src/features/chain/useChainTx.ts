/**
 * 链上交易状态机：待签名 → 已发送 → 已上链 → 失败重试。
 * 一次只跟踪一笔交易；重复提交会取消上一笔的轮询（不会重复发送）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoundSummary } from '@shared/types';
import { sendTonConnectTransaction } from '../wallet';
import { parseTonAddress, toRawAddress } from './address';
import type { ChainConfig } from './config';
import { explorerTxUrl } from './config';
import { decodeJettonNotification } from './decode';
import { ChainError, chainError, exitCodeError, toChainError } from './errors';
import { RECEIPT_POLL_INTERVAL_MS, RECEIPT_TIMEOUT_MS, REFUND_ROUND_ID } from './protocol';
import { matchesUserAction, resolveJettonWalletAddress, waitForTransaction } from './rpc';
import { saveChainTx, type StoredChainTx } from './storage';
import {
  prepareClaimRefundTransaction,
  prepareClaimTransaction,
  prepareClaimUnlockedTransaction,
  prepareRewardActionTransaction,
  prepareSetReferrerTransaction,
  prepareStakeTransaction,
  validateClaim,
  validateRewardAction,
  validateStake,
  type ClaimKind,
  type PreparedTx,
  type RewardActionKind,
  type TonConnectTxRequest,
  type WalletContext,
} from './transactions';

export type ChainTxKind =
  | 'stake'
  | 'claimPrincipal'
  | 'claimReward'
  | 'claimAll'
  | 'claimRewardEarly'
  | 'rollReward'
  | 'setReferrer'
  | 'claimUnlocked'
  | 'claimRefund';

export type ChainTxPhase =
  | 'idle'
  | 'preparing'
  | 'awaiting-signature'
  | 'sent'
  | 'confirming'
  | 'confirmed'
  | 'rejected'
  | 'failed';

export interface ChainTxResult {
  hash: string;
  explorerUrl: string | null;
  /** contract = 合约侧已确认；wallet = 仅确认外部消息已上链 */
  stage: 'contract' | 'wallet';
  utime: number | null;
}

export interface ChainTxState {
  phase: ChainTxPhase;
  kind: ChainTxKind | null;
  error: ChainError | null;
  result: ChainTxResult | null;
  startedAt: number | null;
  roundId: number | null;
  amountRaw: string | null;
  depositNonce: string | null;
}

const INITIAL: ChainTxState = {
  phase: 'idle',
  kind: null,
  error: null,
  result: null,
  startedAt: null,
  roundId: null,
  amountRaw: null,
  depositNonce: null,
};

export interface ChainTxOptions {
  chain: ChainConfig;
  wallet: WalletContext;
  /** 交易确认/失败后回调（用于刷新 /api/me、/api/rounds） */
  onSettled?: (kind: ChainTxKind) => void;
}

export interface SubmitStakeParams {
  round: RoundSummary;
  amountRaw: bigint;
  myStakeRaw?: bigint;
}

export interface SubmitClaimParams {
  kind: ClaimKind;
  roundId?: number | null;
}

interface RunContext {
  kind: ChainTxKind;
  prepared: PreparedTx;
  match: (tx: import('./rpc').OnchainTx) => boolean;
}

/** PreparedTx.meta.queryId（十进制字符串）→ bigint；'0'/空值表示该消息没有 queryId（如 SetReferrer）。 */
function queryIdOf(prepared: PreparedTx): bigint | null {
  try {
    const text = String(prepared.meta.queryId ?? '').trim();
    return text && text !== '0' ? BigInt(text) : null;
  } catch {
    return null;
  }
}

export interface SubmitRewardActionParams {
  kind: RewardActionKind;
  roundId: number;
}

export interface SubmitReferrerParams {
  referrer: string;
}

export interface UseChainTx {
  state: ChainTxState;
  busy: boolean;
  submitStake: (params: SubmitStakeParams) => Promise<ChainTxResult | null>;
  submitClaim: (params: SubmitClaimParams) => Promise<ChainTxResult | null>;
  /** V8：早领 50% / 滚存 */
  submitRewardAction: (params: SubmitRewardActionParams) => Promise<ChainTxResult | null>;
  /** V8：首次质押前绑定邀请人（一次性） */
  submitSetReferrer: (params: SubmitReferrerParams) => Promise<ChainTxResult | null>;
  /** V8：R10 终态后领取解锁池 */
  submitClaimUnlocked: () => Promise<ChainTxResult | null>;
  /** v8.7：领取退款账本（ClaimPrincipal{roundId:0}） */
  submitClaimRefund: () => Promise<ChainTxResult | null>;
  reset: () => void;
}

const KIND_LABEL: Record<ChainTxKind, string> = {
  stake: '质押',
  claimPrincipal: '领取本金',
  claimReward: '领取奖励',
  claimAll: '合并领取',
  claimRewardEarly: '早领 50%',
  rollReward: '滚存奖励',
  setReferrer: '绑定邀请人',
  claimUnlocked: '领取解锁',
  claimRefund: '取回 A9',
};

export function useChainTx(options: ChainTxOptions): UseChainTx {
  const [state, setState] = useState<ChainTxState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const patch = useCallback((next: Partial<ChainTxState>) => {
    if (!mountedRef.current) return;
    setState((current) => ({ ...current, ...next }));
  }, []);

  const finish = useCallback(
    async (context: RunContext) => {
      const { chain, wallet } = optionsRef.current;
      const sinceSec = Math.floor(Date.now() / 1000) - 5;
      const controller = new AbortController();
      abortRef.current = controller;
      let walletTx: import('./rpc').OnchainTx | null = null;

      patch({ phase: 'sent', startedAt: Date.now() });
      const settle = await waitForTransaction({
        chain,
        targetAddress: context.prepared.meta.contract,
        walletAddress: wallet.address,
        sinceSec,
        match: context.match,
        timeoutMs: RECEIPT_TIMEOUT_MS,
        intervalMs: RECEIPT_POLL_INTERVAL_MS,
        signal: controller.signal,
        onWalletTx: (tx) => {
          walletTx = tx;
          patch({
            phase: 'confirming',
            result: {
              hash: tx.hash,
              explorerUrl: explorerTxUrl(chain, tx.hash),
              stage: 'wallet',
              utime: tx.utime || null,
            },
          });
        },
      });

      if (!mountedRef.current) return null;
      if (settle.stage === 'contract' && settle.tx) {
        const result: ChainTxResult = {
          hash: settle.tx.hash,
          explorerUrl: explorerTxUrl(chain, settle.tx.hash),
          stage: 'contract',
          utime: settle.tx.utime || null,
        };
        patch({ phase: 'confirmed', result, error: null });
        persist(context, result);
        optionsRef.current.onSettled?.(context.kind);
        return result;
      }
      if (settle.stage === 'failed') {
        // 身份命中但合约执行失败（aborted / bounced / 非 0 exit_code）：
        // 绝不能置为 confirmed，也不能持久化为成功回执。
        const error = exitCodeError(settle.tx?.exitCode ?? null);
        patch({ phase: 'failed', error });
        optionsRef.current.onSettled?.(context.kind);
        return null;
      }
      if (settle.stage === 'wallet' && settle.tx) {
        // 已上链但尚未看到合约侧消息：保持「已发送」，可稍后刷新回执
        const result: ChainTxResult = {
          hash: settle.tx.hash,
          explorerUrl: explorerTxUrl(chain, settle.tx.hash),
          stage: 'wallet',
          utime: settle.tx.utime || null,
        };
        patch({ phase: 'sent', result, error: null });
        persist(context, result);
        optionsRef.current.onSettled?.(context.kind);
        return result;
      }
      const error = chainError(
        'TX_TIMEOUT',
        '交易已签名发出，但暂未观察到链上确认',
        walletTx ? '可在浏览器中查看钱包交易，确认后刷新页面' : null,
      );
      patch({ phase: 'failed', error });
      return null;
    },
    [patch],
  );

  const persist = useCallback((context: RunContext, result: ChainTxResult) => {
    const { chain, wallet } = optionsRef.current;
    try {
      const stored: StoredChainTx = {
        address: wallet.address,
        kind: context.kind,
        hash: result.hash,
        explorerUrl: result.explorerUrl,
        at: Date.now(),
        network: chain.network,
        amountRaw: context.prepared.meta.amountRaw ?? undefined,
        roundId: context.prepared.meta.roundId ?? undefined,
      };
      saveChainTx(stored);
    } catch {
      /* 存储失败不影响交易状态 */
    }
  }, []);

  const begin = useCallback(
    async (kind: ChainTxKind, meta: Partial<ChainTxState>, build: () => Promise<RunContext>) => {
      abortRef.current?.abort();
      patch({ ...INITIAL, ...meta, kind, phase: 'preparing' });
      try {
        const context = await build();
        if (!mountedRef.current) return null;
        patch({ phase: 'awaiting-signature' });
        await sendTonConnectTransaction(context.prepared.request as TonConnectTxRequest);
        if (!mountedRef.current) return null;
        return await finish(context);
      } catch (error) {
        if (!mountedRef.current) return null;
        const chainErr = toChainError(error);
        patch({ phase: chainErr.code === 'WALLET_REJECTED' ? 'rejected' : 'failed', error: chainErr });
        optionsRef.current.onSettled?.(kind);
        return null;
      }
    },
    [finish, patch],
  );

  const submitStake = useCallback(
    async (params: SubmitStakeParams) => {
      const { chain, wallet } = optionsRef.current;
      return begin('stake', { roundId: params.round.roundId, amountRaw: params.amountRaw.toString() }, async () => {
        validateStake({
          chain,
          wallet,
          round: params.round,
          amountRaw: params.amountRaw,
          myStakeRaw: params.myStakeRaw,
        });
        if (!chain.roundController || !chain.jettonMaster) throw chainError('CHAIN_NOT_CONFIGURED');
        const jettonWallet = await resolveJettonWalletAddress({
          chain,
          jettonMaster: chain.jettonMaster,
          owner: wallet.address,
        });
        const prepared = await prepareStakeTransaction({
          chain,
          wallet,
          round: params.round,
          amountRaw: params.amountRaw,
          riskDisclosureVersion: chain.riskDisclosureVersion,
          jettonWalletFriendly: jettonWallet.friendly,
        });
        const nonce = prepared.meta.depositNonce ? BigInt(prepared.meta.depositNonce) : null;
        const match = (tx: import('./rpc').OnchainTx): boolean => {
          const notification = decodeJettonNotification(tx.inBody);
          if (!notification?.stake) return false;
          return nonce !== null && notification.stake.depositNonce === nonce;
        };
        return { kind: 'stake', prepared, match } satisfies RunContext;
      });
    },
    [begin],
  );

  const submitClaim = useCallback(
    async (params: SubmitClaimParams) => {
      const { chain, wallet } = optionsRef.current;
      return begin(params.kind, { roundId: params.kind === 'claimAll' ? 0 : Number(params.roundId ?? 0) }, async () => {
        validateClaim({ chain, wallet });
        const prepared = prepareClaimTransaction({
          chain,
          wallet,
          kind: params.kind,
          roundId: params.roundId ?? 0,
        });
        const expectedOp = prepared.meta.opcode;
        const expectedRound = prepared.meta.roundId ?? 0;
        const userRaw = toRawAddress(parseTonAddress(wallet.address));
        const match = (tx: import('./rpc').OnchainTx): boolean =>
          matchesUserAction(tx, {
            sourceRaw: userRaw,
            op: expectedOp,
            roundId: expectedRound,
            // 快速重试时区分本次与上一笔：必须带本次 queryId
            queryId: queryIdOf(prepared),
          });
        return { kind: params.kind, prepared, match } satisfies RunContext;
      });
    },
    [begin],
  );

  const submitRewardAction = useCallback(
    async (params: SubmitRewardActionParams) => {
      const { chain, wallet } = optionsRef.current;
      return begin(params.kind, { roundId: params.roundId }, async () => {
        validateRewardAction({ chain, wallet });
        const prepared = prepareRewardActionTransaction({
          chain,
          wallet,
          kind: params.kind,
          roundId: params.roundId,
        });
        const expectedOp = prepared.meta.opcode;
        const expectedRound = params.roundId;
        const userRaw = toRawAddress(parseTonAddress(wallet.address));
        const match = (tx: import('./rpc').OnchainTx): boolean =>
          matchesUserAction(tx, {
            sourceRaw: userRaw,
            op: expectedOp,
            roundId: expectedRound,
            queryId: queryIdOf(prepared),
          });
        return { kind: params.kind, prepared, match } satisfies RunContext;
      });
    },
    [begin],
  );

  const submitSetReferrer = useCallback(
    async (params: SubmitReferrerParams) => {
      const { chain, wallet } = optionsRef.current;
      return begin('setReferrer', {}, async () => {
        validateRewardAction({ chain, wallet });
        const prepared = prepareSetReferrerTransaction({ chain, wallet, referrer: params.referrer });
        const userRaw = toRawAddress(parseTonAddress(wallet.address));
        const referrerRaw = prepared.meta.referrer;
        const match = (tx: import('./rpc').OnchainTx): boolean =>
          matchesUserAction(tx, {
            sourceRaw: userRaw,
            op: prepared.meta.opcode,
            // SetReferrer payload 本身没有 queryId，用 referrer 地址区分身份
            referrerRaw,
          });
        return { kind: 'setReferrer', prepared, match } satisfies RunContext;
      });
    },
    [begin],
  );

  const submitClaimRefund = useCallback(async () => {
    const { chain, wallet } = optionsRef.current;
    return begin('claimRefund', { roundId: REFUND_ROUND_ID }, async () => {
      validateClaim({ chain, wallet });
      const prepared = prepareClaimRefundTransaction({ chain, wallet });
      const userRaw = toRawAddress(parseTonAddress(wallet.address));
      // FIX-5：身份匹配必须带本次 queryId；成功判定由 waitForTransaction 的 aborted/exit_code 门负责
      const match = (tx: import('./rpc').OnchainTx): boolean =>
        matchesUserAction(tx, {
          sourceRaw: userRaw,
          op: prepared.meta.opcode,
          roundId: REFUND_ROUND_ID,
          queryId: queryIdOf(prepared),
        });
      return { kind: 'claimRefund', prepared, match } satisfies RunContext;
    });
  }, [begin]);

  const submitClaimUnlocked = useCallback(async () => {
    const { chain, wallet } = optionsRef.current;
    return begin('claimUnlocked', {}, async () => {
      validateRewardAction({ chain, wallet });
      const prepared = prepareClaimUnlockedTransaction({ chain, wallet });
      const userRaw = toRawAddress(parseTonAddress(wallet.address));
      const match = (tx: import('./rpc').OnchainTx): boolean =>
        matchesUserAction(tx, {
          sourceRaw: userRaw,
          op: prepared.meta.opcode,
          queryId: queryIdOf(prepared),
        });
      return { kind: 'claimUnlocked', prepared, match } satisfies RunContext;
    });
  }, [begin]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(INITIAL);
  }, []);

  const busy =
    state.phase === 'preparing' || state.phase === 'awaiting-signature' || state.phase === 'sent' || state.phase === 'confirming';

  return {
    state,
    busy,
    submitStake,
    submitClaim,
    submitRewardAction,
    submitSetReferrer,
    submitClaimUnlocked,
    submitClaimRefund,
    reset,
  };
}

/** 交易阶段的本地化 key（i18n 用）。 */
export function phaseKey(phase: ChainTxPhase): string {
  return 'phase.' + phase;
}

export function kindLabel(kind: ChainTxKind): string {
  return KIND_LABEL[kind];
}
