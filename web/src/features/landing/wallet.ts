import { useWallet } from '../wallet';
import type { WalletState } from '../wallet';

/**
 * Landing 侧钱包适配层：直接复用 app-dev 的 features/wallet 契约（Lead docs/09 §12）。
 * 保留这一层是为了让 landing 组件只依赖本地接口，后续钱包实现变化时无需改动组件。
 */
export type LandingWallet = WalletState;

export function useLandingWallet(): LandingWallet {
  return useWallet();
}
