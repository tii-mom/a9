# A9 Protocol — 合约 v10

**版本**：v10（2026-11-06，接手重构；取代 v8.9 `v8.9-audit-fixed`）
**状态**：代码完成、本地测试通过；**尚未外部审计、尚未部署测试网**。
**权威口径**：docs/00 的 D-42（v10 重构决策）> 本 README > 其余历史文档。

---

## 0. 一句话

3 个合约：**标准 Jetton Master + 标准 Jetton Wallet + 一个 RoundController**。一个 keeper 热钱包运营，没有 admin、没有升级、没有提现函数、没有参数修改入口。

| 合约 | 来源 | 代码哈希（acton build --info） |
| --- | --- | --- |
| JettonWallet | Acton 官方 TEP-74 模板，未改动 | `0xD06DAA57ED188CE9CB6CA596DD2111347433BF335223AC66C0D713C8E3DB74F4` |
| JettonMaster | Acton 官方模板 + 一次性铸造 100 亿后关闭 | `0x76B56D9A6301223F1201D719E2F4A3FB84E08D7D701CB93BB43C9D0208E5E241` |
| RoundController | 自研（约 730 行 + 类型/常量约 520 行） | `0x628E3A638D1B749C1D012D61A3F1E296BEC4AE3D586B4DCB4E733A169A32C16D` |

```
cd contracts
export PATH="$HOME/.acton/bin:$PATH"
acton build && acton check && acton test      # 25 passed / 2 files
```

## 1. 和 v8.9 比，改了什么、为什么

| 改动 | 原因 |
| --- | --- |
| Jetton 钱包恢复标准 TEP-74（允许第三方 `response_destination`，去掉 TransferBounced 通知） | v8.9 的限制让 STON.fi 等 DEX 无法把 A9 付给买家（已对照 STON.fi v1 源码确认） |
| 删除 TeamVault：12 亿团队额度直接放在 RC 的 Jetton 钱包 | 少一个合约、两跳跨合约消息和一套确认/回滚逻辑 |
| 删除 OracleAdapter：价格由一个 keeper 热钱包提交 | 项目只要单签；v8.9 中 admin 本来就能绕过它 |
| 没有 admin：RC 用内置钱包代码在链上推导自己的 Jetton 钱包地址 | 去掉 SetJettonWallet 等部署接线步骤和对应权限 |
| 奖励 = 按质押占比分本轮 7 亿，**本金 + 奖励一次全额领取** | 去掉邀请加成、连续参与倍数、滚存、早领 50%、R10 后解锁（复杂、可被小号套利，也占存储） |
| 第 24 根 K 线提交时直接判定成败 | 去掉 SETTLING_* 中间态和 FinalizeRound；结算转账/销毁不再阻塞轮次 |
| 失败轮一笔销毁 = 奖励 + 团队 + 全部本金 | 原来三笔销毁、三套确认 |
| 转账发出即记账；只有结算转账/销毁在第一跳被退回时才标记重试 | 去掉 pending 表、余额回执确认、回滚互斥（历次严重审计问题都出在这里） |
| 最低质押 1 万 → **10 万 A9** | 保证存储有上限：10 轮满额最多 2 万个仓位 ≈ 4 万 cell，低于账户上限 65,536（实测每仓位约 2 cell） |
| 去掉触价提前关窗和预言机暂停 | 目标价开窗时已锁定为 max(阶梯, 2×TWAP)；K 线可补交；超时统一用技术终止 |

## 2. 规则（链上实现）

- **10 轮**；`tier = 1 + 已成功轮数`；失败同档重试，成功升档。
- **目标价**：开轮时锁定 `max(P0 × 2^tier, 2 × 开窗 24h TWAP)`，P0 = 116000（USD_E8）。
- **时间线**：结算 → 12h 预告（PREVIEW）→ keeper 开轮（OpenRound）→ 报名 36h → 观察 24 根 1h K 线 → 第 24 根提交时判定。
- **判定**：≥ 16 根 TWAP ≥ 目标价为成功，否则失败。
- **成功**：质押人按 `floor(7亿 × 我的质押 / 本轮总质押)` 分奖励（尾差留在合约）；本金 + 奖励随时一次领走；1.2 亿团队额度转到团队钱包。0 人质押且成功：7 亿奖励销毁，团队额度照常释放。
- **失败**：一笔销毁 7 亿奖励 + 1.2 亿团队额度 + 全部本金，total_supply 真实减少；不可领取。
- **技术终止**（任何人可调用）：
  - 报名/观察阶段在应结束时间后 7 天仍未判定 → 本轮终止，本金可领，不销毁、不消耗档位；
  - 下一轮在预告结束后 7 天仍未开轮（keeper 失联）→ 跳到该轮并终止，保证协议能走完 10 轮。
  - 终止轮的 7 亿奖励和 1.2 亿团队额度留在合约，不分配也不销毁（沿用 D-39）。
- **质押限制**：单笔 ≥ 10 万 A9；单地址每轮 ≤ 2,000 万；每轮总额 ≤ 2 亿；不允许撤回。
- **退款**：任何无效质押都会退回。转账附带 ≥ 0.1 TON 时立即原路退回；不足时，≥ 10 万的金额记入退款账本（round 0），用 `Claim(0)` 或 `ClaimAll` 领取；**低于 10 万且 TON 不足的零头不退**（为保证存储有上限，需在前端和风险披露中说明）。

## 3. 信任模型（必须对外披露）

- keeper 是**单个热钱包**，提交开窗 TWAP 和每根 K 线，**链上无法验证价格真实性**。
- keeper 私钥泄露后，攻击者可以伪造 K 线决定任意一轮的成败，包括让自己质押的轮次成功、从而拿走该轮奖励池。合约没有任何人能修改规则或提走资金，但无法防止伪造价格。
- 缓解：keeper 钱包只放少量 gas、服务器加固；所有 K 线以事件形式公开（含 `dataDigest` 和滚动哈希 `candleHash`），任何人都可以用公开行情复核；去掉提前关窗后，攻击者无法把其他人挡在报名窗口外。

## 4. ABI

### 4.1 入站消息（RoundController）

| Opcode | 消息 | 谁可以发 | Body（op 之后） |
| --- | --- | --- | --- |
| 0x52540001 | OpenRound | keeper | queryId:u64, twap24hUsdE8:u128 |
| 0x52540002 | CloseStaking | 任何人（报名窗口结束后） | queryId:u64, twap1hUsdE8:u128（忽略） |
| 0x52540003 | SubmitCandle | keeper | queryId:u64, roundId:u8, candleIndex:u8, periodStart:u32, periodEnd:u32, twapPriceUsdE8:u128, dataDigest:u256 |
| 0x52540006 | Claim | 用户（≥ 0.1 TON） | queryId:u64, roundId:u8（0 = 退款账本） |
| 0x5254000E | ClaimAll | 用户（≥ 0.1 TON） | queryId:u64, roundId:u8（忽略；领取 0..10 全部） |
| 0x52540010 | AbortTechnical | 任何人 | queryId:u64 |
| 0x52540015 | RetrySettlement | 任何人（≥ 0.3 TON） | queryId:u64, roundId:u8 |
| 0x7362d09c | transfer_notification | RC 自己的 Jetton 钱包 | 质押入口，见 4.2 |
| 0xd372158c | TopUpTons | 任何人 | — |

v8.9 中的 ClaimReward、ClaimRewardEarly、RollReward、SetReferrer、ClaimUnlocked、FinalizeRound、StartObservation、PauseOracle、ResumeOracle、SetJettonWallet、SetJettonWalletCode、BurnAck 以及 TeamVault/OracleAdapter 的全部消息已删除。

### 4.2 质押（格式与 v8.9 相同，前端 payload 不用改）

用户向自己的 Jetton 钱包发标准 transfer：`destination = RC 地址`，`forward_ton_amount ≥ 0.1 TON`（用于失败时的即时退款），`forward_payload` = Either right ref cell（136 bit）：

```
op:u32 = 0x5254000F | version:u8 = 1 | roundId:u8 | depositNonce:u64（同轮同地址递增）
| riskDisclosureVersion:u16 = 1 | acceptFullPrincipalBurn:u8 = 1
```

### 4.3 事件（external-out）

| Opcode | 事件 | 字段 |
| --- | --- | --- |
| 0x52540101 | TargetPriceSet | roundId, tier, targetPriceUsdE8, twap24hUsdE8 |
| 0x52540102 | RoundSettled | roundId, status, qualifiedCandles, candlesSeen, totalAcceptedStakeRaw, tierAfter, rewardBurnRaw, teamBurnRaw, principalBurnRaw, teamReleasedRaw |
| 0x52540103 | DepositAccepted | roundId, owner, amountRaw, totalAcceptedStakeRaw |
| 0x52540104 | TechnicalAborted | roundId, reason(2 观察超时 / 3 预告超时), at |
| 0x5254010B | StakingClosed | roundId, closeAt, early(恒 false), twap1hUsdE8(恒 0) |
| 0x5254010C | CandleSubmitted | roundId, candleIndex, periodStart, periodEnd, twapPriceUsdE8, dataDigest, candleHash |
| 0x5254010E | Claimed | owner, roundsMask, principalRaw, rewardRaw |
| 0x5254010F | DepositRefunded | owner, amountRaw, instant, recorded |
| 0x52540110 | SettlementBounced | roundId, action(1 团队转账 / 2 销毁) |
| 0x52540111 | UnexpectedBounce | op, queryId |

### 4.4 Get 方法（返回结构沿用 v8.9 形状）

| 方法 | 说明 |
| --- | --- |
| get_protocol_config() | 同 v8.9 字段顺序；admin/oracle = keeper，teamVault = 团队钱包，两个超时字段 = 7 天 |
| get_round(roundId) | 同 v8.9 RoundView；*Confirmed = 对应动作已发出且未被退回；failureBurnId = 0；totalWeight = 总质押 |
| get_round_status / get_round_target_price / get_round_total_stake / get_round_staker_count | — |
| get_user_stake(roundId, owner) | 同 v8.9 形状；principalClaimed = rewardClaimed = 已领取；weight = 质押额；rewardState = 0 |
| get_user_reward_estimate(roundId, owner) | 仅 SUCCEEDED 时有值 |
| get_claimable_all(owner) | principalRaw, rewardRaw（全额，不再是 50%）, roundsMask（bit r-1 = 第 r 轮；bit 15 = 退款账本） |
| get_current_round / get_success_count / get_jetton_wallet_address / get_jetton_wallet_code_hash | — |

已删除：get_reward_state、get_unlock_info、get_referral、get_streak、get_user_weight、get_total_weight、get_round_burn_status、get_claim_counter、has_pending_claim。

### 4.5 状态值（数值沿用 v8.9）

0 UNOPENED · 1 PREVIEW · 2 STAKING_OPEN · 4 OBSERVING · 8 SUCCEEDED · 9 FAILED_PERMANENT · 10 TECHNICAL_ABORTED（3/5/6/7 不再出现）。

## 5. 部署

1. 部署 JettonMaster，MintOnce 100 亿到 treasury（同一笔交易关闭铸造）。
2. 部署 RoundController（keeper、jettonMaster、teamWallet、参数、JettonWallet 代码都写进初始数据）。
3. 核对 `RC.get_jetton_wallet_address()` == `Master.get_wallet_address(RC)`。
4. 从 treasury 向 RC 转 **82 亿 A9**（70 亿奖励池 + 12 亿团队额度），**forward_ton_amount 必须为 0**，否则会被当作质押退回。
5. 给 RC 充值 TON（结算每次动作约 0.1 TON，建议 ≥ 5 TON）。
6. keeper 调用 OpenRound 开第一轮。

脚本：`acton script scripts/deploy-emulation.tolk`（本地模拟 / `--net testnet`）；运维：`scripts/deploy/admin_op.tolk <open-round|close-staking|submit-candle|abort-technical|retry-settlement> <roundId> <extra>`。

## 6. 测试覆盖（25 个，全部用真实 Jetton 合约）

部署与钱包推导；只有 keeper 能开轮/交 K 线；目标价两种取值；R1 前质押退款；限额（单笔、单地址、总额、nonce）；各类无效质押退款；TON 不足时进退款账本、零头不退；K 线顺序/对齐/收盘/价格；任何人到期关窗；成功轮按比例全额领取 + 团队释放；失败轮一笔销毁且 total_supply 减少；0 人质押成功/失败；观察超时与预告超时的技术终止；结算第一跳退回后任何人重试；领取 TON 不足、观察中不可领；10 轮完整跑完余额归零、第 11 轮被拒；第三方 response_destination 的标准转账（DEX 出款）；masterchain 地址领取被拒；每个仓位约 2 cell；一次性铸造；销毁减少供应量；非持有人不能转账。

## 7. 上主网前还要做的

- [ ] 外部审计（v10 是新代码，v8.9 的审计结论不适用）。
- [ ] 后端索引器、前端、ops 脚本按 v10 ABI 更新（见 docs/00 D-42 的跟进清单）。
- [ ] 测试网完整跑 10 轮，并在测试网 DEX 上验证 A9 买卖。
- [ ] 风险披露更新：单 keeper 信任模型、低于 10 万且 TON 不足的零头不退、奖励规则改为一次全额领取。
