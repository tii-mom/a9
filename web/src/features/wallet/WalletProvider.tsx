import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { ensureWalletInit } from './store';

/**
 * 可选的钱包初始化容器（无 Context 依赖，挂不挂都能用）。
 * 挂载后会在应用启动时恢复上次的钱包模式（TON Connect 会话 / 演示钱包）。
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void ensureWalletInit();
  }, []);
  return <>{children}</>;
}
