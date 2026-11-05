/** 链上交易本地记录（刷新后仍能看到最近一笔交易哈希与状态）。 */

import type { ChainTxKind } from './useChainTx';

const KEY = 'fuse.chain.lastTx.v1';

export interface StoredChainTx {
  address: string;
  kind: ChainTxKind;
  hash: string;
  explorerUrl: string | null;
  at: number;
  network: string;
  amountRaw?: string;
  roundId?: number;
}

type Store = Record<string, StoredChainTx>;

function readStore(): Store {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* 隐私模式忽略 */
  }
}

function keyOf(address: string, kind: ChainTxKind): string {
  return String(address).trim().toLowerCase() + '|' + kind;
}

export function loadLastChainTx(address: string | null | undefined, kind: ChainTxKind): StoredChainTx | null {
  if (!address) return null;
  return readStore()[keyOf(address, kind)] ?? null;
}

export function saveChainTx(tx: StoredChainTx): void {
  if (!tx.address) return;
  const store = readStore();
  store[keyOf(tx.address, tx.kind)] = tx;
  writeStore(store);
}

export function clearChainTx(address: string | null | undefined, kind: ChainTxKind): void {
  if (!address) return;
  const store = readStore();
  delete store[keyOf(address, kind)];
  writeStore(store);
}
