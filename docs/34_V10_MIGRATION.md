# 34 — v10 合约上线前的下游改造清单

**依据**：docs/00 D-42、[contracts/README.md](../contracts/README.md)（v10 ABI 以它为准）。
**原则**：合约 ABI 尽量沿用 v8.9 的 opcode 和 get 方法返回结构，下游只需**删掉已移除的功能**，并改下面列出的少数几处语义。

## 1. 共同变化（所有下游都要知道）

| 项 | v8.9 | v10 |
| --- | --- | --- |
| 合约 | JettonMaster, JettonWallet, RoundController, TeamVault, OracleAdapter | JettonMaster, JettonWallet, RoundController |
| 运营角色 | admin + oracle（OracleAdapter） | 一个 keeper；没有 admin |
| 团队额度 | TeamVault 钱包 12 亿 | RC 钱包内（RC 共持有 82 亿 = 70 亿奖励 + 12 亿团队）；成功轮 RC 直接转 1.2 亿给团队钱包 |
| 最低质押 | 10,000 A9 | **100,000 A9** |
| 质押 forward_ton_amount | 0.05 TON | **≥ 0.1 TON**（建议 0.12；不足时无效质押不会即时退回，而是进退款账本；低于 10 万的零头不退） |
| 质押消息总 TON | 0.2 | 建议 0.3 |
| 领取 | ClaimPrincipal / ClaimReward(50%) / ClaimAll(本金+50%) / ClaimRewardEarly / RollReward / ClaimUnlocked | **Claim(roundId)**（opcode 0x52540006，原 ClaimPrincipal）= 本金 + 全额奖励；**ClaimAll**(0x5254000E) = 0..10 轮全部 + 退款账本；附带 ≥ 0.1 TON（建议 0.2） |
| 邀请 / 连续参与 / 滚存 / 早领 / 解锁池 | 有 | **全部删除** |
| 结算 | SETTLING_SUCCESS/FAILURE → FinalizeRound → 终态 | 第 24 根 K 线提交时直接到 SUCCEEDED(8)/FAILED_PERMANENT(9)，下一轮立即 PREVIEW |
| 状态值 | 0..10 | 0,1,2,4,8,9,10（3/5/6/7 不再出现） |
| 失败销毁 | 三笔 burn + 三个确认标志 | **一笔 burn**，金额 = 7 亿 + 1.2 亿 + 本轮总质押；RoundSettled 事件带 rewardBurnRaw/teamBurnRaw/principalBurnRaw/teamReleasedRaw |
| 提前关窗 / 预言机暂停 | 有 | 删除；CloseStaking 只在 36h 到期后任何人可调 |
| 技术终止 | 暂停 14 天 / 观察超时 7 天 / 预告超时 | 统一 7 天：观察应结束后 7 天、或预告结束后 7 天 |
| roundsMask | bit r-1 = 第 r 轮 | 同左；**bit 15 = 退款账本** |
| get_claimable_all.rewardRaw | 奖励的 50% | **全额奖励** |

## 2. 后端 worker（索引器 + API）

- `indexer/events.ts`：删除 0x52540105~0x52540108、0x52540201/0x52540202 解码；RoundSettled 增加 4 个 uint128 字段；新增 Claimed(0x5254010E: owner, roundsMask:u16, principalRaw:u128, rewardRaw:u128)、DepositRefunded(0x5254010F: owner, amountRaw:u128, instant:bool, recorded:bool)、SettlementBounced(0x52540110: roundId:u8, action:u8)、UnexpectedBounce(0x52540111: op:u32, queryId:u64)；StakingClosed/CandleSubmitted 不变。
- `indexer/messages.ts`：入站 opcode 只剩 0x52540001/02/03/06/0E/0F/10/15 + 0x7362d09c；删除其余（含 TeamVault/OracleAdapter）。
- `indexer/getters.ts`、`config.ts`、`ledger.ts`、`sync.ts`、`snapshot.ts`：删除 TeamVault 账户同步、get_reward_state/get_unlock_info/get_referral/get_streak/get_user_weight/get_total_weight/get_round_burn_status/has_pending_claim/get_claim_counter 调用；团队释放从 RoundSettled.teamReleasedRaw 读取；对账公式改为「RC 钱包余额 = 82 亿 − 已释放团队 − 已销毁 − 已领取奖励 + 未领取本金」（终止轮的 8.2 亿留存不变）。
- `v8.ts`、`state.ts`、`protocol.ts`、`views.ts`、`index.ts`、`shared/types.ts`：删除 V8 奖励三态、邀请、解锁相关接口与字段；`/api/me` 返回每轮 `principal`、`reward`、`claimed` 即可；配置里去掉 teamVault/oracleAdapter 键，增加 teamWallet。
- 验收：`npm run typecheck`、索引器 unit/selfcheck 工具按新 fixture 通过。

## 3. 前端 web

- `chain/protocol.ts`：删除 REWARD_STATE / EARLY_CLAIM_BPS / STREAK_* / REFERRAL_* / UNLOCK_*、opcode 表里已删除的项；`DEFAULT_MIN_STAKE_TOKENS = 100_000n`；`DEFAULT_FORWARD_TON_NANO = 120_000_000n`；`DEFAULT_STAKE_MESSAGE_TON_NANO = 300_000_000n`。
- `chain/transactions.ts`：保留 prepareStakeTransaction（payload 不变）、prepareClaimTransaction（发 Claim(roundId) 或 ClaimAll）、prepareClaimRefundTransaction（Claim(0)）；删除 prepareRewardActionTransaction / prepareSetReferrerTransaction / prepareClaimUnlockedTransaction。
- 删除 `RewardReferralPanel.tsx`、`rewards.ts` 中的邀请/连续/解锁逻辑及邀请链接捕获；`MePage` / `ChainMePanel` 只展示每轮本金、奖励、可领取。
- 文案：奖励「成功后本金 + 奖励一次全额领取」；最低质押 10 万；风险披露加「单 keeper 提交价格」「低于 10 万且 TON 不足的零头不退」。
- 验收：tsc、vite build、qa/frontend-ux.mjs 全部通过。

## 4. 运维 ops

- 部署：删除 20_deploy_teamvault、65_set_jetton_wallets、70_bind_roles 中 TeamVault/OracleAdapter/SetJettonWallet/InitController 步骤；部署顺序见 contracts/README §5（RC 注资 82 亿且 forward_ton_amount = 0）。
- `lib/config.mjs`、参数文件：minStake 改 100,000；去掉 teamVault / oracleAdapter 地址，增加 teamWallet、keeper。
- keeper（keeper-candles.mjs、80_admin_ops.mjs、tolk/fast_admin.tolk）：只用 OpenRound / CloseStaking / SubmitCandle / AbortTechnical / RetrySettlement；删除 FinalizeRound / StartObservation / Pause / Resume / RetryPendingActions。
- 监控与对账：监听 SettlementBounced（出现即调用 RetrySettlement）与 UnexpectedBounce（出现即人工核查）。
- 删除 tolk/query_tv.tolk 和 user_op/query_user 中的 V8 操作；ceremony（90_mainnet_ceremony）去掉 TeamVault/OracleAdapter 阶段。

## 5. 上主网前

1. 外部审计 v10（范围：RoundController + Jetton 的两处改动）。
2. 测试网完整跑 10 轮（成功、失败、0 质押、技术终止、结算重试各至少一次）。
3. 测试网 DEX（STON.fi / DeDust）建池并验证买入、卖出、退款。
