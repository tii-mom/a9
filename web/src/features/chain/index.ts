/**
 * 链上交易模块（task-7）。
 * 对外职责：
 *   - 从 /api/config 读取测试网合约地址；未配置时整体降级（页面保持演示模式）
 *   - 构造 TON Connect 交易（Jetton transfer + StakePayload / Claim(roundId) / ClaimAll / Claim(0) 退款账本）
 *   - 发送（复用 wallet 模块的 TonConnectUI 单实例）、回执轮询、状态机与错误提示
 *   - 「我的质押」页嵌入组件 <ChainMePanel />
 *
 * 关键约定见同目录 README.md 与 docs/04_CONTRACT_ABI.md §19。
 */

export { ChainMePanel } from './ChainMePanel';
export { JunxiangCard } from './JunxiangCard';
export type { JunxiangCardProps } from './JunxiangCard';
export { prepareJunxiangClaimTransaction, buildClaimJunxiangBody, buildProofCell } from './junxiang';
export type { ChainMePanelProps } from './ChainMePanel';
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
  SubmitTicketParams,
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
  DEFAULT_TICKET_CLAIM_TON_NANO,
  DEFAULT_TICKET_RESTAKE_TON_NANO,
  DEFAULT_MIN_STAKE_TOKENS,
  MIN_STAKE_TON_BALANCE,
  MIN_CLAIM_TON_BALANCE,
  MIN_RESTAKE_TON_BALANCE,
  TIMING_BPS,
  IMMEDIATE_REWARD_BPS,
  nextQueryId,
  EVENT_OPCODES,
  GET_METHODS,
} from './protocol';

export {
  buildStakePayloadCell,
  buildJettonTransferCell,
  buildTicketPayloadCell,
} from './payload';
export type { StakePayloadParams, JettonTransferParams, TicketPayloadParams } from './payload';
export { beginCell, serializeCellToBoc, toBocBase64, parseBocBase64, CellSlice } from './cell';
export type { ChainCell, ParsedCell } from './cell';
export { parseTonAddress, toFriendlyAddress, toRawAddress, shortenAddress, looksLikeRawAddress } from './address';
export type { TonAddress } from './address';
export { formatRawAmount, parseAmountToRaw, isValidAmountInput } from './amount';

export { ChainError, chainError, toChainError, isUserRejection } from './errors';
export type { ChainErrorCode } from './errors';

export {
  prepareStakeTransaction,
  prepareTicketClaimTransaction,
  prepareTicketRestakeTransaction,
  validateStake,
  validateClaim,
  validateRestake,
  tonBalanceToNumber,
} from './transactions';
export type {
  PreparedTx,
  TonConnectMessage,
  TonConnectTxRequest,
  WalletContext,
} from './transactions';

export {
  resolveJettonWalletAddress,
  fetchRecentTransactions,
  waitForTransaction,
  fetchTicketAddress,
  fetchTicketState,
  fetchRewardPreview,
} from './rpc';
export type { OnchainTx, TicketStateView, RewardPreviewView, ResolvedJettonWallet, WaitForTxOptions, WaitForTxResult } from './rpc';
export {
  decodeStakePayload,
  decodeJettonNotification,
  decodeClaimMessage,
  decodeUserAction,
  decodeOpcode,
} from './decode';
export type { UserActionMessage } from './decode';
export { loadLastChainTx, saveChainTx, clearChainTx } from './storage';
export type { StoredChainTx } from './storage';
