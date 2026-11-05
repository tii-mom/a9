import { useMemo, useSyncExternalStore } from 'react';
import { connect, disconnect, getWalletSnapshot, refreshBalances, subscribe } from './store';
import type { WalletStoreState } from './store';

/** 全站统一钱包契约（Lead 定稿）。交易一律禁用：合约部署后开放。 */
export interface WalletState {
  /** TON 友好地址（UQ.../EQ...），可直接传给 api.me(address)；未连接为 null */
  address: string | null;
  connected: boolean;
  connecting: boolean;
  /** true = 演示钱包（真实钱包不可用/被拒绝时降级） */
  demo: boolean;
  /** 人类可读 TON 余额，例如 "1,250.00"；查询失败为 null */
  tonBalance: string | null;
  /** FUSE 余额 raw units（9 位）；真实钱包在 Jetton 上线前为 null */
  fuseBalance: string | null;
  error: string | null;
  connect(): void;
  disconnect(): void;
  refreshBalances(): void;
}

const ACTIONS = { connect, disconnect, refreshBalances };

/**
 * 钱包状态 hook。无需 Provider：内部是模块级 store + useSyncExternalStore，
 * 因此在任意页面/组件调用都安全，地址变化会自动通知所有订阅者。
 */
export function useWallet(): WalletState {
  const snapshot = useSyncExternalStore(subscribe, getWalletSnapshot, getWalletSnapshot);
  return useMemo<WalletState>(
    () => ({
      address: snapshot.address,
      connected: snapshot.status === 'connected' && !!snapshot.address,
      connecting: snapshot.status === 'connecting' || snapshot.status === 'restoring',
      demo: snapshot.mode === 'demo',
      tonBalance: snapshot.tonBalance,
      fuseBalance: snapshot.fuseBalance,
      error: snapshot.error,
      connect: ACTIONS.connect,
      disconnect: ACTIONS.disconnect,
      refreshBalances: ACTIONS.refreshBalances,
    }),
    [snapshot],
  );
}

/** 内部用：额外暴露连接方式、网络、钱包名与降级提示，供 WalletButton / 应用页展示。 */
export function useWalletStore(): WalletStoreState {
  return useSyncExternalStore(subscribe, getWalletSnapshot, getWalletSnapshot);
}
