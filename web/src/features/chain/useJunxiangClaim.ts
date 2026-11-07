/**
 * 军饷领取状态机：读取清单证明 + 链上前置检查 → 可领取额 → 发送 ClaimJunxiang。
 * 「可领取」只在 cumulativeRaw > claimedRaw 且清单根与链上一致时为真；发送后等待链上 claimedRaw 追平再解除按钮，
 * 防止同一证明被重复提交（重复提交会被合约拒绝，TON 留在记录合约里）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { sendTonConnectTransaction } from '../wallet';
import { ApiError, payoutApi } from '../../lib/api';
import type { ChainConfig } from './config';
import { toChainError } from './errors';
import { prepareJunxiangClaimTransaction } from './junxiang';
import { fetchClaimedRaw, fetchDistributorRoot, rootValueOf } from './junxiangClaim';
import { validateClaim, type WalletContext } from './transactions';

export type JunxiangPhase = 'idle' | 'loading' | 'ready' | 'not-listed' | 'not-published' | 'error';

interface Snapshot {
  phase: JunxiangPhase;
  error: string | null;
  listId: number | null;
  cumulativeRaw: bigint;
  claimedRaw: bigint;
  claimableRaw: bigint;
  proof: string[];
}

const EMPTY: Snapshot = {
  phase: 'idle',
  error: null,
  listId: null,
  cumulativeRaw: 0n,
  claimedRaw: 0n,
  claimableRaw: 0n,
  proof: [],
};

/** 发送后等待链上追平的最长时间（超时后解除按钮，由用户自行重试）。 */
const AWAIT_CHAIN_MS = 180_000;
const AWAIT_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;

async function loadSnapshot(chain: ChainConfig, address: string): Promise<Snapshot> {
  let proof;
  try {
    proof = await payoutApi.proof(address);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') {
      return { ...EMPTY, phase: 'not-listed' };
    }
    throw error;
  }
  const [chainRoot, claimedRaw] = await Promise.all([fetchDistributorRoot(chain), fetchClaimedRaw(chain, address)]);
  const apiRoot = rootValueOf(proof.root);
  if (apiRoot === null || apiRoot !== chainRoot) {
    return { ...EMPTY, phase: 'not-published', listId: proof.listId };
  }
  const cumulativeRaw = BigInt(proof.cumulativeRaw);
  const claimableRaw = cumulativeRaw > claimedRaw ? cumulativeRaw - claimedRaw : 0n;
  return {
    phase: 'ready',
    error: null,
    listId: proof.listId,
    cumulativeRaw,
    claimedRaw,
    claimableRaw,
    proof: proof.proof,
  };
}

export interface UseJunxiangClaim extends Snapshot {
  busy: boolean;
  /** 已发送、等待链上确认（期间不可再次领取） */
  awaitingChain: boolean;
  /** 本次会话内已成功发送的领取（用于分享提示） */
  sentRaw: bigint | null;
  txError: string | null;
  refresh: () => void;
  claim: () => Promise<boolean>;
}

export interface UseJunxiangClaimOptions {
  chain: ChainConfig;
  address: string;
  demo: boolean;
  tonBalance: string | null;
}

export function useJunxiangClaim({ chain, address, demo, tonBalance }: UseJunxiangClaimOptions): UseJunxiangClaim {
  const enabled = !!chain.junxiangDistributor && !!address && !demo;
  // ChainConfig 每次渲染都是新对象：依赖项只用稳定的字段，完整对象走 ref，避免无限刷新
  const chainKey = `${chain.network}|${chain.junxiangDistributor}|${chain.toncenterBaseUrl}|${chain.toncenterApiKey ?? ''}`;
  const chainRef = useRef(chain);
  chainRef.current = chain;
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ cumulativeRaw: bigint; amountRaw: bigint; at: number } | null>(null);
  const seqRef = useRef(0);
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;

  const refresh = useCallback(() => {
    if (!enabled) {
      setSnapshot({ ...EMPTY, phase: 'idle' });
      return;
    }
    const seq = ++seqRef.current;
    setSnapshot((prev) => (prev.phase === 'ready' ? prev : { ...EMPTY, phase: 'loading' }));
    loadSnapshot(chainRef.current, address)
      .then((next) => {
        if (seq === seqRef.current) setSnapshot(next);
      })
      .catch((error: unknown) => {
        if (seq !== seqRef.current) return;
        const text = error instanceof Error ? error.message : String(error);
        setSnapshot({ ...EMPTY, phase: 'error', error: text });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey, address, enabled]);

  useEffect(() => {
    refresh();
    if (!enabled) return undefined;
    const timer = setInterval(refresh, sent ? AWAIT_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, enabled, sent]);

  // 发送后：链上 claimedRaw 追平即解除等待；超时也解除
  const awaitingChain = sent !== null && snapshot.claimedRaw < sent.cumulativeRaw && Date.now() - sent.at < AWAIT_CHAIN_MS;
  useEffect(() => {
    if (sent === null) return undefined;
    if (snapshot.claimedRaw >= sent.cumulativeRaw) {
      setSent(null);
      return undefined;
    }
    const timer = setTimeout(() => setSent(null), AWAIT_CHAIN_MS);
    return () => clearTimeout(timer);
  }, [sent, snapshot.claimedRaw]);

  const claim = useCallback(async (): Promise<boolean> => {
    const snap = snapRef.current;
    if (!enabled || busy || awaitingChain || snap.phase !== 'ready' || snap.claimableRaw <= 0n) return false;
    setBusy(true);
    setTxError(null);
    try {
      const wallet: WalletContext = { address, demo, tonBalance };
      const current = chainRef.current;
      validateClaim({ chain: current, wallet });
      const prepared = prepareJunxiangClaimTransaction({
        chain: current,
        wallet,
        cumulativeRaw: snap.cumulativeRaw,
        proofHex: snap.proof,
      });
      await sendTonConnectTransaction(prepared.request);
      setSent({ cumulativeRaw: snap.cumulativeRaw, amountRaw: snap.claimableRaw, at: Date.now() });
      return true;
    } catch (error) {
      const chainErr = toChainError(error);
      if (chainErr.code !== 'WALLET_REJECTED') setTxError(chainErr.message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [enabled, busy, awaitingChain, address, demo, tonBalance]);

  return {
    ...snapshot,
    busy,
    awaitingChain,
    sentRaw: sent ? sent.amountRaw : null,
    txError,
    refresh,
    claim,
  };
}
