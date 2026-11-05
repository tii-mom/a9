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
  claimPrincipal: string;
  claimReward: string;
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
  demoClaimWarn: '注意：本面板的按钮会发起真实链上交易；页面下方的「可领取」演示按钮仍走后端演示接口，不会上链，请勿混淆。',
  walletDemoTitle: '演示钱包无法签名',
  walletDemoDesc: '演示钱包地址是本地生成的，不能签名交易。请切换为真实 TON 钱包后再进行链上质押/领取。',
  switchWallet: '连接真实钱包',
  walletNetMismatch: '钱包网络与合约网络不一致',
  tonBalance: 'TON 余额',
  a9Balance: 'A9 余额',
  stakeTitle: '链上质押',
  stakeDesc: 'Jetton transfer + forward payload；失败轮本金 100% 销毁，质押后不可取消。',
  currentRound: '当前轮次',
  noOpenRound: '当前没有处于报名窗口的轮次（STAKING_OPEN）。',
  roundState: '轮次状态',
  amount: '质押数量',
  amountPlaceholder: '例如 100000',
  minStake: '单笔最低',
  maxStake: '本轮总上限',
  maxPerAddress: '单地址上限',
  failLoss: '失败损失',
  shareEst: '预计占比',
  myStake: '本轮已有质押',
  riskAck: '我已阅读风险披露：质押不可取消；本轮考核失败时，本轮全部质押本金 100% 销毁；预言机技术故障不销毁本金。',
  riskAckShort: '已确认风险（acceptFullPrincipalBurn = 1）',
  previewTitle: '消息预览',
  previewOp: 'opcode',
  previewRound: 'roundId',
  previewNonce: 'depositNonce',
  previewNoncePending: 'uint64 · 签名时生成',
  previewContract: '接收合约',
  previewJettonWallet: 'Jetton Wallet',
  previewGas: '附带 TON',
  previewNote: 'payload 在点击按钮后按上述结构生成（Cell/BOC 编码），由钱包展示并签名。',
  stakeAction: '签名并发起质押',
  stakeSigning: '等待钱包签名…',
  claimTitle: '链上领取',
  claimDesc: 'ClaimAll 一次领取全部已结算轮次（≤10 轮，本金 + 奖励合并一笔）；也可按轮单独领取。',
  claimAll: '一键领取全部（ClaimAll）',
  claimAllNote: 'ClaimAll 由合约扫描已结算未领取轮次，单笔交易、gas 自付、幂等。',
  claimPrincipal: '领取本金',
  claimReward: '领取奖励',
  claimEmpty: '暂无可领取',
  claimEmptyDesc: '链上可领取金额需要等合约结算后由索引器/接口同步；也可以直接点击 ClaimAll 尝试领取。',
  claimRound: '轮次',
  txLast: '最近交易',
  txHash: '交易哈希',
  txView: '浏览器查看',
  confirmedByContract: '已上链，合约侧已确认',
  confirmedByWallet: '已上链（钱包交易已确认，等待合约侧回执）',
  txRetry: '重新发送',
  txDismiss: '关闭提示',
  refreshStatus: '刷新状态',
  phases: {
    idle: '待发起',
    preparing: '准备交易…',
    'awaiting-signature': '等待钱包签名…',
    sent: '已发送，等待上链确认…',
    confirming: '已上链，等待合约回执…',
    confirmed: '交易已确认',
    rejected: '已在钱包中拒绝',
    failed: '交易失败',
  },
  errors: {
    CHAIN_NOT_CONFIGURED: '链上交易未配置（合约地址缺失），当前保持演示模式。',
    WALLET_NOT_CONNECTED: '请先连接 TON 钱包。',
    DEMO_WALLET: '演示钱包不能签名，请切换为真实 TON 钱包。',
    TONCONNECT_UNAVAILABLE: 'TON Connect 不可用（SDK 未加载或环境不支持）。',
    WALLET_REJECTED: '你在钱包中取消了签名，未发送任何交易。',
    INSUFFICIENT_BALANCE: 'TON 余额不足，无法支付 gas 与转发费用。',
    ROUND_NOT_OPEN: '当前轮不在报名窗口内，无法质押。',
    AMOUNT_INVALID: '质押数量格式不正确。',
    AMOUNT_TOO_SMALL: '低于单笔最低质押量。',
    AMOUNT_TOO_LARGE: '超过本轮限额或单地址占比上限。',
    JETTON_WALLET_UNRESOLVED: '无法解析你的 Jetton Wallet 地址，请稍后重试。',
    NETWORK_ERROR: '网络请求失败（toncenter / tonapi / TON Connect），请检查网络后重试。',
    TX_TIMEOUT: '交易已发出但暂未观察到链上确认，请稍后在浏览器中查看。',
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
  demoClaimWarn: 'Note: the buttons in this panel send real on-chain transactions. The demo Claim buttons elsewhere on this page still call the backend demo API and do not go on-chain.',
  walletDemoTitle: 'Demo wallet cannot sign',
  walletDemoDesc: 'The demo address is generated locally and cannot sign transactions. Connect a real TON wallet to stake or claim on-chain.',
  switchWallet: 'Connect a real wallet',
  walletNetMismatch: 'Wallet network differs from the contract network',
  tonBalance: 'TON balance',
  a9Balance: 'A9 balance',
  stakeTitle: 'On-chain stake',
  stakeDesc: 'Jetton transfer + forward payload. On failure 100% of principal is burned; staking cannot be cancelled.',
  currentRound: 'Current round',
  noOpenRound: 'No round is currently in its staking window (STAKING_OPEN).',
  roundState: 'Round state',
  amount: 'Stake amount',
  amountPlaceholder: 'e.g. 100000',
  minStake: 'Minimum per stake',
  maxStake: 'Round cap',
  maxPerAddress: 'Per-address cap',
  failLoss: 'On failure',
  shareEst: 'Estimated share',
  myStake: 'Already staked this round',
  riskAck: 'I have read the risk disclosure: staking cannot be cancelled; if this round fails, 100% of all principal staked in this round is burned; oracle technical failures never burn principal.',
  riskAckShort: 'Risk acknowledged (acceptFullPrincipalBurn = 1)',
  previewTitle: 'Message preview',
  previewOp: 'opcode',
  previewRound: 'roundId',
  previewNonce: 'depositNonce',
  previewNoncePending: 'uint64 · generated at signing',
  previewContract: 'Contract',
  previewJettonWallet: 'Jetton Wallet',
  previewGas: 'Attached TON',
  previewNote: 'The payload is built with this layout (Cell/BOC) when you press the button, then shown and signed by your wallet.',
  stakeAction: 'Sign & stake',
  stakeSigning: 'Waiting for wallet signature…',
  claimTitle: 'On-chain claim',
  claimDesc: 'ClaimAll collects every settled round in one transaction (≤10 rounds, principal + reward); individual rounds can be claimed too.',
  claimAll: 'Claim all (ClaimAll)',
  claimAllNote: 'ClaimAll lets the contract scan settled, unclaimed rounds: one transaction, gas paid by you, idempotent.',
  claimPrincipal: 'Claim principal',
  claimReward: 'Claim reward',
  claimEmpty: 'Nothing to claim',
  claimEmptyDesc: 'On-chain claimable amounts appear once an indexer syncs settled rounds; you can also press ClaimAll directly.',
  claimRound: 'Round',
  txLast: 'Latest transaction',
  txHash: 'Transaction hash',
  txView: 'View in explorer',
  confirmedByContract: 'Confirmed on-chain (contract side)',
  confirmedByWallet: 'Included on-chain (wallet tx confirmed, awaiting contract receipt)',
  txRetry: 'Send again',
  txDismiss: 'Dismiss',
  refreshStatus: 'Refresh status',
  phases: {
    idle: 'Ready',
    preparing: 'Preparing…',
    'awaiting-signature': 'Waiting for wallet signature…',
    sent: 'Sent, waiting for inclusion…',
    confirming: 'Included, waiting for contract receipt…',
    confirmed: 'Transaction confirmed',
    rejected: 'Rejected in wallet',
    failed: 'Transaction failed',
  },
  errors: {
    CHAIN_NOT_CONFIGURED: 'On-chain mode is not configured (missing contract addresses); staying in demo mode.',
    WALLET_NOT_CONNECTED: 'Connect a TON wallet first.',
    DEMO_WALLET: 'The demo wallet cannot sign. Switch to a real TON wallet.',
    TONCONNECT_UNAVAILABLE: 'TON Connect is unavailable (SDK failed to load or unsupported environment).',
    WALLET_REJECTED: 'You cancelled the signature in your wallet; nothing was sent.',
    INSUFFICIENT_BALANCE: 'Not enough TON for gas and forwarding fees.',
    ROUND_NOT_OPEN: 'The round is not in its staking window.',
    AMOUNT_INVALID: 'Invalid stake amount.',
    AMOUNT_TOO_SMALL: 'Below the minimum stake amount.',
    AMOUNT_TOO_LARGE: 'Exceeds the round cap or the per-address share limit.',
    JETTON_WALLET_UNRESOLVED: 'Could not resolve your Jetton Wallet address. Try again shortly.',
    NETWORK_ERROR: 'Network request failed (toncenter / tonapi / TON Connect). Check your connection and retry.',
    TX_TIMEOUT: 'The transaction was sent but no on-chain confirmation was observed yet. Check the explorer shortly.',
    BAD_CONFIG: 'Bad configuration (invalid roundId / address).',
    UNKNOWN: 'Unknown error. Retry or check the explorer.',
  },
};

export const CHAIN_I18N: Record<'zh' | 'en', ChainDict> = { zh: ZH, en: EN };
