/**
 * 链上交易模块（task-7）。
 * 对外职责：
 *   - 从 /api/config 读取测试网合约地址；未配置时整体降级（页面保持演示模式）
 *   - 构造 TON Connect 交易（Jetton transfer + StakePayload / ClaimPrincipal / ClaimReward / ClaimAll）
 *   - 发送（复用 wallet 模块的 TonConnectUI 单实例）、回执轮询、状态机与错误提示
 *   - 「我的质押」页嵌入组件 <ChainMePanel />
 *
 * 关键约定见同目录 README.md 与 docs/04_CONTRACT_ABI.md §19。
 */

export { ChainMePanel } from './ChainMePanel';
export type { ChainMePanelProps } from './ChainMePanel';
export { RewardReferralPanel } from './RewardReferralPanel';
export type { RewardReferralPanelProps } from './RewardReferralPanel';
export { RefundClaimPanel } from './RefundClaimPanel';
export type { RefundClaimPanelProps } from './RefundClaimPanel';
export { TxStatusView } from './TxStatus';
export type { TxStatusProps } from './TxStatus';

export { useChainConfig, deriveChainConfig, explorerTxUrl, explorerAddressUrl, toExplorerHash } from './config';
export type { ChainConfig, ChainConfigState, ChainNetwork, ChainDisabledReason } from './config';

export { useChainTx, phaseKey, kindLabel } from './useChainTx';
export type {
  ChainTxKind,
  ChainTxPhase,
  ChainTxResult,
  ChainTxState,
  SubmitStakeParams,
  SubmitClaimParams,
  SubmitRewardActionParams,
  SubmitReferrerParams,
  UseChainTx,
} from './useChainTx';

export { CHAIN_I18N } from './i18n';
export type { ChainDict } from './i18n';

export {
  OPCODES,
  JETTON_TRANSFER_OP,
  STAKE_PAYLOAD_VERSION,
  ACCEPT_FULL_PRINCIPAL_BURN,
  DEFAULT_FORWARD_TON_NANO,
  DEFAULT_STAKE_MESSAGE_TON_NANO,
  DEFAULT_CLAIM_MESSAGE_TON_NANO,
  MIN_STAKE_TON_BALANCE,
  MIN_CLAIM_TON_BALANCE,
  nextDepositNonce,
  nextQueryId,
  EVENT_OPCODES,
  GET_METHODS,
  REWARD_STATE,
  EARLY_CLAIM_BPS,
  STREAK_BONUS_BPS,
  STREAK_CAP,
  REFERRAL_BONUS_BPS,
  UNLOCK_MONTHS,
  UNLOCK_PERIOD_SECONDS,
  REFUND_ROUND_ID,
  CLAIM_KIND_REFUND,
} from './protocol';

export {
  buildStakePayloadCell,
  buildJettonTransferCell,
  buildClaimPayloadCell,
  buildClaimRewardEarlyCell,
  buildRollRewardCell,
  buildSetReferrerCell,
  buildUnlockCell,
  buildClaimRewardEarly,
  buildRollReward,
  buildSetReferrer,
  buildClaimUnlocked,
  buildClaimUnlockedCell,
} from './payload';
export type { StakePayloadParams, JettonTransferParams, ClaimPayloadParams } from './payload';
export { beginCell, serializeCellToBoc, toBocBase64, parseBocBase64, CellSlice } from './cell';
export type { ChainCell, ParsedCell } from './cell';
export { parseTonAddress, toFriendlyAddress, toRawAddress, shortenAddress, looksLikeRawAddress } from './address';
export type { TonAddress } from './address';
export { formatRawAmount, parseAmountToRaw, isValidAmountInput } from './amount';

export { ChainError, chainError, toChainError, isUserRejection } from './errors';
export type { ChainErrorCode } from './errors';

export {
  prepareStakeTransaction,
  prepareClaimTransaction,
  prepareRewardActionTransaction,
  prepareSetReferrerTransaction,
  prepareClaimUnlockedTransaction,
  prepareClaimRefundTransaction,
  validateStake,
  validateClaim,
  validateRewardAction,
  tonBalanceToNumber,
} from './transactions';
export type {
  ClaimKind,
  RewardActionKind,
  PreparedTx,
  TonConnectMessage,
  TonConnectTxRequest,
  WalletContext,
} from './transactions';

export { resolveJettonWalletAddress, fetchRecentTransactions, waitForTransaction, fetchRefundLedger, parseRefundLedgerStack } from './rpc';
export type { OnchainTx, RefundLedgerView, ResolvedJettonWallet, WaitForTxOptions, WaitForTxResult } from './rpc';
export {
  decodeStakePayload,
  decodeJettonNotification,
  decodeClaimMessage,
  decodeUserAction,
  decodeOpcode,
} from './decode';
export type { UserActionMessage } from './decode';
export {
  captureInviteFromLocation,
  clearPendingReferrer,
  currentWeightMultiplierBps,
  displayAddress,
  inviteCodeFor,
  inviteLinkFor,
  multiplierText,
  parseInviteCode,
  readPendingReferrer,
  readReferralInfo,
  readRewardRows,
  readStreakInfo,
  readUnlockInfo,
  shortAddress,
} from './rewards';
export type { ReferralView, RewardRowView, RewardStateName, StreakView, UnlockView } from './rewards';
export { loadLastChainTx, saveChainTx, clearChainTx } from './storage';
export type { StoredChainTx } from './storage';
