/**
 * Demo wallet switch. The demo wallet is a dev and QA affordance only:
 * production builds never offer it, never restore it, and never show its
 * fixed balances (250,000 A9 / 1,250 TON). QA builds opt in with
 * VITE_ENABLE_DEMO_WALLET=1. Mainnet readiness: docs/30 §3 #4.
 */
export const DEMO_WALLET_ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO_WALLET === '1';
