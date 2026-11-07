/** 链上模块中英双语文案。 */

import type { ChainErrorCode } from './errors';
import type { ChainTxPhase } from './useChainTx';

export interface ChainDict {
  title: string;
  desc: string;
  networkLabel: string;
  mainnet: string;
  testnet: string;
  roundController: string;
  jettonMaster: string;
  viewExplorer: string;
  unconfiguredTitle: string;
  unconfiguredDemo: string;
  unconfiguredNoContracts: string;
  unconfiguredNoConfig: string;
  unconfiguredHint: string;
  retry: string;
  dataSourceDemoWarn: string;
  demoClaimWarn: string;
  walletDemoTitle: string;
  walletDemoDesc: string;
  switchWallet: string;
  walletNetMismatch: string;
  tonBalance: string;
  a9Balance: string;
  stakeTitle: string;
  stakeDesc: string;
  currentRound: string;
  noOpenRound: string;
  roundState: string;
  amount: string;
  amountPlaceholder: string;
  minStake: string;
  maxStake: string;
  maxPerAddress: string;
  capRefundNote: string;
  failLoss: string;
  shareEst: string;
  myStake: string;
  riskAck: string;
  riskAckShort: string;
  previewTitle: string;
  previewOp: string;
  previewRound: string;
  previewNonce: string;
  previewNoncePending: string;
  previewContract: string;
  previewJettonWallet: string;
  previewGas: string;
  previewNote: string;
  stakeAction: string;
  stakeSigning: string;
  claimTitle: string;
  claimDesc: string;
  claimAll: string;
  claimAllNote: string;
  claimRoundAction: string;
  claimEmpty: string;
  claimEmptyDesc: string;
  claimRound: string;
  txLast: string;
  txHash: string;
  txView: string;
  confirmedByContract: string;
  confirmedByWallet: string;
  txRetry: string;
  txDismiss: string;
  refreshStatus: string;
  phases: Record<ChainTxPhase, string>;
  errors: Record<ChainErrorCode, string>;
  // ---- 退款账本 ----
  refundTitle: string;
  refundDesc: string;
  refundAmountLabel: string;
  refundAction: string;
  refundError: string;
  refundRetry: string;
  refundDemoNote: string;
  refundWalletNote: string;
  refundDemoDone: string;
  refundRecovered: string;
}

const ZH: ChainDict = {
  title: '链上交易',
  desc: '通过 TON Connect 对测试网合约发起真实质押与领取；所有交易由你的钱包签名，gas 自付。',
  networkLabel: '网络',
  mainnet: '主网',
  testnet: '测试网',
  roundController: 'RoundController',
  jettonMaster: 'Jetton Master',
  viewExplorer: '浏览器查看',
  unconfiguredTitle: '链上交易未启用',
  unconfiguredDemo: '当前为演示网络，未配置测试网合约地址。页面保持演示模式，不发起任何链上交易。',
  unconfiguredNoContracts: '尚未配置 RoundController / Jetton Master 地址。页面保持演示模式，合约部署后自动启用。',
  unconfiguredNoConfig: '无法读取协议配置（接口不可用）。页面保持演示模式。',
  unconfiguredHint: '启用条件：/api/config 的 contracts.roundController 与 contracts.jettonMaster 均非空，且 network 为 testnet 或 mainnet。',
  retry: '重试',
  dataSourceDemoWarn: '后端当前使用演示数据源：轮次状态、可领取金额来自演示数据，链上实际状态以合约 get method 为准。',
  demoClaimWarn: '注意：本面板的按钮会发起真实链上交易；链上模式下页面不会显示演示领取按钮，所有领取都在本面板完成。',
  walletDemoTitle: '演示钱包无法签名',
  walletDemoDesc: '演示账户可能采用公开榜单地址展示示例记录，不能签名交易。请切换为真实 GRAM 钱包后再进行链上质押/领取。',
  switchWallet: '连接真实钱包',
  walletNetMismatch: '钱包网络与合约网络不一致',
  tonBalance: 'GRAM 余额',
  a9Balance: 'A9 余额',
  stakeTitle: '链上质押',
  stakeDesc: 'Jetton transfer + 攻城令 payload v2（可选受益人）；城没破时本金 100% 销毁（输了归零），上车后不可取消。',
  currentRound: '当前城',
  noOpenRound: '当前没有处于攻城期的城（STAKING_OPEN）。',
  roundState: '城状态',
  amount: '上车数量',
  amountPlaceholder: '例如 1000',
  minStake: '单笔最低',
  maxStake: '本城总额上限（已取消）',
  maxPerAddress: '单地址上限（已取消）',
  capRefundNote: '单笔最低 1,000 A9；无单地址上限、无本城总额上限。无效上车（低于最低、不在攻城期内、payload 错误）在附带足够 GRAM（forward ≥ 0.1）时整笔退回；GRAM 不足时不退回，代币留在协议中，因此请务必足额附带 GRAM。',
  failLoss: '失败损失',
  shareEst: '预计占比',
  myStake: '本城已有上车',
  riskAck: '我已阅读风险披露：上车不可取消；城没破时本金 100% 销毁（输了归零）；价格由单一 keeper 提交；军饷由单一发布者决定；破城奖励 20% 立即可领、80% 压城；技术终止时退回本金。',
  riskAckShort: '已确认风险（acceptFullPrincipalBurn = 1）',
  previewTitle: '消息预览',
  previewOp: 'opcode',
  previewRound: 'roundId',
  previewNonce: 'beneficiary（受益人）',
  previewNoncePending: 'addr · 留空 = 记在本人名下',
  previewContract: '接收合约',
  previewJettonWallet: 'Jetton Wallet',
  previewGas: '附带 GRAM',
  previewNote: 'payload 在点击按钮后按上述结构生成（Cell/BOC 编码），由钱包展示并签名。',
  stakeAction: '签名并发起质押',
  stakeSigning: '等待钱包签名…',
  claimTitle: '链上领取',
  claimDesc: '破城后本金与 20% 即时奖励可领；80% 压城随后续破城或第 10 城后 30 天线性解锁',
  claimAll: '全部领取',
  claimAllNote: '每张攻城令（每城一张）分别领取：本金与即时 20% 奖励，加已解锁的压城奖励。gas 自付（附带 0.2 GRAM）。',
  claimRoundAction: '领取本金 + 即时奖励',
  claimEmpty: '暂无可领取',
  claimEmptyDesc: '请等待合约结算与索引器同步后再检查；暂无权益时不会发送付费领取交易。',
  claimRound: '轮次',
  txLast: '最近交易',
  txHash: '交易哈希',
  txView: '浏览器查看',
  confirmedByContract: '已上链，合约侧已确认',
  confirmedByWallet: '已上链（钱包交易已确认，等待合约侧回执）',
  txRetry: '重新发送',
  txDismiss: '关闭提示',
  refreshStatus: '刷新状态',
  refundTitle: '无效上车的代币（v11 无退款账本）',
  refundDesc: 'v11 不再记入退款账本：无效上车若附带 GRAM ≥ 0.1 已原路退回；GRAM 不足时代币留在协议中，不可取回。',
  refundAmountLabel: '待取回',
  refundAction: '取回 A9',
  refundError: '暂时无法查询退款账本，请稍后重试。',
  refundRetry: '重新查询',
  refundDemoNote: '演示模式：模拟操作，不会发送链上交易。',
  refundWalletNote: '连接真实 GRAM 钱包后可取回。',
  refundDemoDone: '演示模式：已模拟取回，未上链。',
  refundRecovered: '已取回',
  phases: {
    idle: '待发起',
    preparing: '准备交易…',
    'awaiting-signature': '等待钱包签名…',
    sent: '已发送，等待上链确认…',
    confirming: '已上链，等待合约回执…',
    pending: '结果待确认 · 请检查原交易',
    confirmed: '交易已确认',
    rejected: '已在钱包中拒绝',
    failed: '交易失败',
  },
  errors: {
    CHAIN_NOT_CONFIGURED: '链上交易未配置（合约地址缺失），当前保持演示模式。',
    WALLET_NOT_CONNECTED: '请先连接 GRAM 钱包。',
    DEMO_WALLET: '演示钱包不能签名，请切换为真实 GRAM 钱包。',
    TONCONNECT_UNAVAILABLE: 'TON Connect 不可用（SDK 未加载或环境不支持）。',
    WALLET_REJECTED: '你在钱包中取消了签名，未发送任何交易。',
    INSUFFICIENT_BALANCE: 'GRAM 余额不足，无法支付 gas 与转发费用。',
    ROUND_NOT_OPEN: '当前城不在攻城期内，无法上车。',
    AMOUNT_INVALID: '质押数量格式不正确。',
    AMOUNT_TOO_SMALL: '低于单笔最低上车量（1,000 A9）。',
    AMOUNT_TOO_LARGE: '数量超出允许范围。',
    JETTON_WALLET_UNRESOLVED: '无法解析你的 Jetton Wallet 地址，请稍后重试。',
    NETWORK_ERROR: '网络请求失败（toncenter / tonapi / TON Connect），请检查网络后重试。',
    TX_TIMEOUT: '交易已发出但暂未观察到链上确认，请稍后在浏览器中查看。',
    CONTRACT_REJECTED: '合约拒绝了这笔交易（compute phase 失败，资金未发生变化）。',
    BAD_CONFIG: '配置异常（roundId / 地址不合法）。',
    UNKNOWN: '未知错误，请重试或查看浏览器。',
  },
};

const EN: ChainDict = {
  title: 'On-chain transactions',
  desc: 'Real staking and claiming against the testnet contracts via TON Connect. Every transaction is signed by your wallet; you pay gas.',
  networkLabel: 'Network',
  mainnet: 'Mainnet',
  testnet: 'Testnet',
  roundController: 'RoundController',
  jettonMaster: 'Jetton Master',
  viewExplorer: 'View in explorer',
  unconfiguredTitle: 'On-chain transactions disabled',
  unconfiguredDemo: 'This is the demo network and no testnet contract address is configured. The page stays in demo mode and sends no on-chain transactions.',
  unconfiguredNoContracts: 'RoundController / Jetton Master addresses are not configured yet. The page stays in demo mode and enables itself after deployment.',
  unconfiguredNoConfig: 'Protocol config is unavailable. The page stays in demo mode.',
  unconfiguredHint: 'Enablement: /api/config must expose non-empty contracts.roundController and contracts.jettonMaster with network testnet or mainnet.',
  retry: 'Retry',
  dataSourceDemoWarn: 'The backend still uses the demo data source: round state and claimable amounts are demo data. The on-chain state from contract get methods is authoritative.',
  demoClaimWarn: 'Note: the buttons in this panel send real on-chain transactions. In chain mode the demo Claim buttons are hidden; all claims happen here.',
  walletDemoTitle: 'Demo wallet cannot sign',
  walletDemoDesc: 'The demo account may show a public leaderboard address and cannot sign transactions. Connect a real GRAM wallet to stake or claim on-chain.',
  switchWallet: 'Connect a real wallet',
  walletNetMismatch: 'Wallet network differs from the contract network',
  tonBalance: 'GRAM balance',
  a9Balance: 'A9 balance',
  stakeTitle: 'On-chain stake',
  stakeDesc: 'Jetton transfer + gate-ticket payload v2 (optional beneficiary). If the gate holds, 100% of principal is burned (losing means zero); entry cannot be cancelled.',
  currentRound: 'Current round',
  noOpenRound: 'No gate is currently in its staking window (STAKING_OPEN).',
  roundState: 'Round state',
  amount: 'Stake amount',
  amountPlaceholder: 'e.g. 1000',
  minStake: 'Minimum per stake',
  maxStake: 'Gate total cap (removed)',
  maxPerAddress: 'Per-address cap (removed)',
  capRefundNote: 'Minimum 1,000 A9 per stake; there is no per-address cap and no per-gate total cap. An invalid stake (below the minimum, outside the window, malformed payload) is returned in full when at least 0.1 GRAM is attached (forward ≥ 0.1). With less GRAM it is not refunded and the tokens stay in the protocol, so always attach enough GRAM.',
  failLoss: 'On failure',
  shareEst: 'Estimated share',
  myStake: 'Already staked this round',
  riskAck: 'I have read the risk disclosure: entry cannot be cancelled; if the gate holds, 100% of principal is burned (losing means zero); prices are submitted by a single keeper; allocations are decided by a single publisher; on a break, 20% of the reward is claimable at once and 80% stays locked; a technical abort returns principal in full.',
  riskAckShort: 'Risk acknowledged (acceptFullPrincipalBurn = 1)',
  previewTitle: 'Message preview',
  previewOp: 'opcode',
  previewRound: 'roundId',
  previewNonce: 'beneficiary',
  previewNoncePending: 'addr · empty = payer',
  previewContract: 'Contract',
  previewJettonWallet: 'Jetton Wallet',
  previewGas: 'Attached GRAM',
  previewNote: 'The payload is built with this layout (Cell/BOC) when you press the button, then shown and signed by your wallet.',
  stakeAction: 'Sign & stake',
  stakeSigning: 'Waiting for wallet signature…',
  claimTitle: 'On-chain claim',
  claimDesc: 'Principal and the 20% immediate reward are claimable once the gate breaks; the 80% locked part unlocks on a later success or linearly over 30 days after round 10',
  claimAll: 'Claim all',
  claimAllNote: 'Each gate ticket (one per gate) is claimed separately: principal and the 20% immediate reward, plus any unlocked part of the 80%. You pay gas (0.2 GRAM attached).',
  claimRoundAction: 'Claim principal + immediate reward',
  claimEmpty: 'Nothing to claim',
  claimEmptyDesc: 'On-chain claimable amounts appear once an indexer syncs settled rounds. Review the amounts before requesting a claim.',
  claimRound: 'Round',
  txLast: 'Latest transaction',
  txHash: 'Transaction hash',
  txView: 'View in explorer',
  confirmedByContract: 'Confirmed on-chain (contract side)',
  confirmedByWallet: 'Included on-chain (wallet tx confirmed, awaiting contract receipt)',
  txRetry: 'Send again',
  txDismiss: 'Dismiss',
  refreshStatus: 'Refresh status',
  refundTitle: 'Invalid-entry tokens (no refund ledger in v11)',
  refundDesc: 'v11 keeps no refund ledger: an invalid entry with at least 0.1 GRAM attached is returned in the same transaction; with less GRAM the tokens stay in the protocol and cannot be recovered.',
  refundAmountLabel: 'To get back',
  refundAction: 'Get A9 back',
  refundError: "Couldn't load your refundable balance right now. Please retry shortly.",
  refundRetry: 'Check again',
  refundDemoNote: 'Demo mode: simulated action, no on-chain transaction.',
  refundWalletNote: 'Connect a real GRAM wallet to get it back.',
  refundDemoDone: 'Demo mode: simulated recovery (not on-chain).',
  refundRecovered: 'Recovered',
  phases: {
    idle: 'Ready',
    preparing: 'Preparing…',
    'awaiting-signature': 'Waiting for wallet signature…',
    sent: 'Sent, waiting for inclusion…',
    confirming: 'Included, waiting for contract receipt…',
    pending: 'Result pending · check original transaction',
    confirmed: 'Transaction confirmed',
    rejected: 'Rejected in wallet',
    failed: 'Transaction failed',
  },
  errors: {
    CHAIN_NOT_CONFIGURED: 'On-chain mode is not configured (missing contract addresses); staying in demo mode.',
    WALLET_NOT_CONNECTED: 'Connect a GRAM wallet first.',
    DEMO_WALLET: 'The demo wallet cannot sign. Switch to a real GRAM wallet.',
    TONCONNECT_UNAVAILABLE: 'TON Connect is unavailable (SDK failed to load or unsupported environment).',
    WALLET_REJECTED: 'You cancelled the signature in your wallet; nothing was sent.',
    INSUFFICIENT_BALANCE: 'Not enough GRAM for gas and forwarding fees.',
    ROUND_NOT_OPEN: 'The gate is not in its staking window.',
    AMOUNT_INVALID: 'Invalid stake amount.',
    AMOUNT_TOO_SMALL: 'Below the minimum entry amount (1,000 A9).',
    AMOUNT_TOO_LARGE: 'The amount is outside the allowed range.',
    JETTON_WALLET_UNRESOLVED: 'Could not resolve your Jetton Wallet address. Try again shortly.',
    NETWORK_ERROR: 'Network request failed (toncenter / tonapi / TON Connect). Check your connection and retry.',
    TX_TIMEOUT: 'The transaction was sent but no on-chain confirmation was observed yet. Check the explorer shortly.',
    CONTRACT_REJECTED: 'The contract rejected this transaction (compute phase failed; funds unchanged).',
    BAD_CONFIG: 'Bad configuration (invalid roundId / address).',
    UNKNOWN: 'Unknown error. Retry or check the explorer.',
  },
};

export const CHAIN_I18N: Record<'zh' | 'en', ChainDict> = { zh: ZH, en: EN };