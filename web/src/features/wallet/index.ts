export { WalletButton } from './WalletButton';
export { WalletProvider } from './WalletProvider';
export { useWallet } from './useWallet';
export type { WalletState } from './useWallet';
export { DEMO_WALLET_ENABLED } from './flags';
export {
  connect,
  connectDemo,
  disconnect,
  refreshBalances,
  resetDemoWallet,
  ensureWalletInit,
  sendTonConnectTransaction,
  getTonConnectState,
} from './store';
export type {
  TonConnectTxMessage,
  TonConnectTxRequest,
  TonConnectTxResult,
  TonConnectState,
} from './store';
