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
  // ---- V8 奖励三态 ----
  rewardTitle: string;
  rewardDesc: string;
  rollWarning: string;
  rewardEmpty: string;
  rewardEmptyDesc: string;
  statePending: string;
  stateRolled: string;
  stateEarly: string;
  stateUnlocked: string;
  statePendingHint: string;
  stateRolledHint: string;
  stateEarlyHint: string;
  optRoll: string;
  optRollHint: string;
  optEarly: string;
  optEarlyHint: string;
  optHold: string;
  optHoldHint: string;
  rollableLabel: string;
  earlyAmountLabel: string;
  lockedLabel: string;
  rewardDemoNote: string;
  rewardWalletNote: string;
  unlockTitle: string;
  unlockInactive: string;
  unlockActive: string;
  unlockMeta: string;
  unlockAction: string;
  unlockNothing: string;
  // ---- V8 邀请 ----
  inviteTitle: string;
  inviteDesc: string;
  inviteCodeLabel: string;
  inviteLinkLabel: string;
  inviteCopy: string;
  inviteCopied: string;
  inviteNote: string;
  boundLabel: string;
  boundNote: string;
  unboundLabel: string;
  pendingLabel: string;
  pendingNote: string;
  bindAction: string;
  bindInputPlaceholder: string;
  bindInvalid: string;
  bindSelf: string;
  streakLabel: string;
  streakValue: string;
  weightLabel: string;
  referralBonusLabel: string;
  referralStakeLabel: string;
  invitedCountLabel: string;
  referralBonusValue: string;
  rewardDemoBound: string;
  claimUnlockedDemo: string;
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
  walletDemoDesc: '演示账户可能采用公开榜单地址展示示例记录，不能签名交易。请切换为真实 TON 钱包后再进行链上质押/领取。',
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
  capRefundNote: '两个上限独立校验：单地址累计 ≤ 20,000,000 A9、本轮总质押 ≤ 200,000,000 A9。超出上限的交易会被合约整笔原路退款（本金不损失，但会消耗 gas），因此前端会提前拦截。',
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
  claimDesc: '本金可全领；奖励早领仅50%立即到账，剩余50%继续锁定。也可按轮只领本金。',
  claimAll: '领本金＋奖励早领50%',
  claimAllNote: 'ClaimAll会对未选择的奖励执行不可回退的EARLY选择；另外50%进入R10后解锁池。gas自付。',
  claimPrincipal: '领取本金',
  claimReward: '奖励早领50%',
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
  rewardTitle: '奖励处理',
  rewardDesc: '每轮奖励三态：滚存 / 早领 50% / 不动；三态互斥、不可回退',
  rollWarning: '滚存 = 把赢来的再押一次，可能归零。想落袋就选早领（拿 50%）。',
  rewardEmpty: '暂无可处理奖励',
  rewardEmptyDesc: '本轮结算成功后，奖励会出现在这里；失败轮次没有奖励。',
  statePending: '未处理',
  stateRolled: '已滚存',
  stateEarly: '已早领',
  stateUnlocked: '已解锁',
  statePendingHint: '默认不动：锁到 R10 结束后，12 个月线性解锁。',
  stateRolledHint: '已滚存 {amount} A9 进入下一轮质押；若下一轮失败，这部分会随本金一起销毁。',
  stateEarlyHint: '已早领 {paid} A9，另 {locked} A9 进入 R10 后的解锁池（不销毁）。',
  optRoll: '滚存',
  optRollHint: '全额进下一轮，可能归零',
  optEarly: '早领 50%',
  optEarlyHint: '立即拿 {amount} A9，另 {locked} A9 锁到 R10 后',
  optHold: '不动',
  optHoldHint: '默认：锁到 R10 后 12 个月线性',
  rollableLabel: '可滚存',
  earlyAmountLabel: '早领可得',
  lockedLabel: '进入解锁池',
  rewardDemoNote: '演示模式：按钮为模拟操作，不会发送链上交易。',
  rewardWalletNote: '连接真实 TON 钱包后可发起链上交易（当前为只读/演示）。',
  unlockTitle: '解锁进度',
  unlockInactive: 'R10 结束后开始 12 个月线性解锁（当前锁定 {amount} A9）。',
  unlockActive: '已解锁 {pct}% · 可领取 {amount} A9',
  unlockMeta: '锁定 {locked} A9 · 已领 {claimed} A9 · 共 12 个月线性释放',
  unlockAction: '领取解锁',
  unlockNothing: '暂无可领取的解锁额度',
  inviteTitle: '邀请关系',
  inviteDesc: '邀请码与邀请链接；被邀请人首次质押前绑定邀请人，绑定后不可修改。',
  inviteCodeLabel: '我的邀请码',
  inviteLinkLabel: '邀请链接',
  inviteCopy: '复制',
  inviteCopied: '已复制',
  inviteNote: '邀请加成 = 被邀请人质押 × {bonusPct}%，封顶自己质押；只算直接邀请（一层）。',
  boundLabel: '已绑定邀请人',
  boundNote: '已绑定，不可修改',
  unboundLabel: '未绑定邀请人',
  pendingLabel: '待绑定邀请人',
  pendingNote: '检测到邀请链接：请在首次质押前绑定（绑定后不可修改）。',
  bindAction: '绑定邀请人',
  bindInputPlaceholder: '粘贴邀请码或邀请人地址',
  bindInvalid: '邀请码/地址无效',
  bindSelf: '不能绑定自己',
  streakLabel: '连续参与',
  streakValue: '{count} 轮 · 权重 {multi}',
  weightLabel: '当前权重倍数',
  referralBonusLabel: '本轮邀请加成',
  referralStakeLabel: '被邀请人本轮质押',
  invitedCountLabel: '已邀请人数',
  referralBonusValue: '{amount} A9 · {count} 人 · 被邀请人质押 {stake} A9',
  rewardDemoBound: '演示模式：已模拟绑定（未上链）。',
  claimUnlockedDemo: '演示模式：已模拟领取解锁额度（未上链）。',
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
  demoClaimWarn: 'Note: the buttons in this panel send real on-chain transactions. In chain mode the demo Claim buttons are hidden; all claims happen here.',
  walletDemoTitle: 'Demo wallet cannot sign',
  walletDemoDesc: 'The demo account may show a public leaderboard address and cannot sign transactions. Connect a real TON wallet to stake or claim on-chain.',
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
  capRefundNote: 'The two caps are enforced independently: per-address cumulative ≤ 20,000,000 A9 and round total ≤ 200,000,000 A9. A transaction exceeding either cap is refunded in full by the contract (principal is safe, but gas is spent), so the UI blocks it up front.',
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
  claimDesc: 'Claim principal in full; early rewards pay 50% now and lock the remainder. You can claim principal separately.',
  claimAll: 'Principal + 50% early reward',
  claimAllNote: 'ClaimAll irreversibly chooses EARLY for pending rewards. The other 50% enters the post-R10 unlock pool. You pay gas.',
  claimPrincipal: 'Claim principal',
  claimReward: 'Claim 50% early reward',
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
  rewardTitle: 'Reward handling',
  rewardDesc: 'Per-round reward: roll over, early claim 50%, or hold. Mutually exclusive and irreversible.',
  rollWarning: 'Roll = stake your winnings again; it can go to zero. If you want to lock it in, choose early claim (50%).',
  rewardEmpty: 'No rewards to handle',
  rewardEmptyDesc: 'Rewards appear here after a round settles successfully. Failed rounds have no reward.',
  statePending: 'Pending',
  stateRolled: 'Rolled',
  stateEarly: 'Early claimed',
  stateUnlocked: 'Unlocked',
  statePendingHint: 'Default hold: locked until R10 ends, then linear over 12 months.',
  stateRolledHint: 'Rolled {amount} A9 into the next round staking; if that round fails this amount is burned with principal.',
  stateEarlyHint: 'Early claimed {paid} A9; {locked} A9 entered the post-R10 unlock pool (not burned).',
  optRoll: 'Roll over',
  optRollHint: 'Full amount into next round; may go to zero',
  optEarly: 'Early claim 50%',
  optEarlyHint: 'Get {amount} A9 now; {locked} A9 locked until after R10',
  optHold: 'Hold',
  optHoldHint: 'Default: locked until after R10, then linear over 12 months',
  rollableLabel: 'Rollable',
  earlyAmountLabel: 'Early claim amount',
  lockedLabel: 'To unlock pool',
  rewardDemoNote: 'Demo mode: buttons are simulated and send no on-chain transaction.',
  rewardWalletNote: 'Connect a real TON wallet to send on-chain transactions (currently read-only/demo).',
  unlockTitle: 'Unlock progress',
  unlockInactive: 'Unlock starts after R10 ends: linear over 12 months ({amount} A9 locked now).',
  unlockActive: '{pct}% unlocked · {amount} A9 claimable',
  unlockMeta: '{locked} A9 locked · {claimed} A9 claimed · linear over 12 months',
  unlockAction: 'Claim unlocked',
  unlockNothing: 'Nothing claimable yet',
  inviteTitle: 'Referral',
  inviteDesc: 'Invite code and link. Your invitee binds a referrer before their first stake; binding cannot be changed.',
  inviteCodeLabel: 'My invite code',
  inviteLinkLabel: 'Invite link',
  inviteCopy: 'Copy',
  inviteCopied: 'Copied',
  inviteNote: 'Referral bonus = {bonusPct}% of invitee stake, capped at your own stake; direct invitees only (one level).',
  boundLabel: 'Bound referrer',
  boundNote: 'Bound; cannot be changed',
  unboundLabel: 'No referrer bound',
  pendingLabel: 'Pending referrer',
  pendingNote: 'Invite link detected. Bind before your first stake (cannot be changed afterwards).',
  bindAction: 'Bind referrer',
  bindInputPlaceholder: 'Paste invite code or referrer address',
  bindInvalid: 'Invalid invite code or address',
  bindSelf: 'Cannot bind yourself',
  streakLabel: 'Streak',
  streakValue: '{count} rounds · weight {multi}',
  weightLabel: 'Current weight',
  referralBonusLabel: 'Referral bonus this round',
  referralStakeLabel: 'Invitee stake this round',
  invitedCountLabel: 'Invitees',
  referralBonusValue: '{amount} A9 · {count} invitees · invitee stake {stake} A9',
  rewardDemoBound: 'Demo mode: binding simulated (not on-chain).',
  claimUnlockedDemo: 'Demo mode: unlock claim simulated (not on-chain).',
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