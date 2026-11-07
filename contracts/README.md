# A9 Protocol — 合约 v11

**版本**：v11（2026-11-06，玩法重构，取代 v10）
**状态**：代码完成、本地 30 个测试全部通过（含军饷分发 4 个）；**尚未外部审计；已部署测试网（极速档，见 ops/config/testnet.registry.json）**。
**权威口径**：docs/35（v11 玩法规格，D-43 ~ D-50）> 本 README > 其余历史文档。

---

## 0. 一句话

4 个合约：**标准 Jetton Master + 标准 Jetton Wallet + RoundController + StakeTicket（攻城令）**。一个 keeper 热钱包运营；没有 admin、没有升级、没有提现函数、没有参数修改入口。

| 合约 | 来源 | 代码哈希（acton build --info） |
| --- | --- | --- |
| JettonWallet | Acton 官方 TEP-74 模板，未改动 | `0xD06DAA57ED188CE9CB6CA596DD2111347433BF335223AC66C0D713C8E3DB74F4` |
| JettonMaster | Acton 官方模板，一次性铸造 100 亿后关闭 | `0x76B56D9A6301223F1201D719E2F4A3FB84E08D7D701CB93BB43C9D0208E5E241` |
| RoundController | 自研 | `0x905F62F5CF3B114E94F195E25319F58A505FBFCD78EA3997AE8E26D285D5C96B` |
| StakeTicket | 自研（约 120 行） | `0x0F00D2995452947199CE5887B17C3F0BF502ECAE1D9A439A74A8D32E7EBD3DBC` |

```
cd contracts
export PATH="$HOME/.acton/bin:$PATH"
acton build && acton check && acton test      # 30 passed / 3 files
```

## 1. 和 v10 比，改了什么、为什么

| 改动 | 原因 |
| --- | --- |
| 仓位放进每人每城一个 StakeTicket 子合约，RC 只存每城汇总；删除 RC 内的仓位表和退款账本 | v10 每轮最多 2,000 个地址（D-48）；RC 存储现在与人数无关（≤ 11 轮的数据） |
| 最低质押 10 万 → **1,000 A9**；取消单地址上限和每轮总额上限 | 无门槛；巨鲸开窗抢满额度的问题随之消失 |
| 质押 payload v2：去掉 nonce，加受益人字段 | 一键上车（经 DEX 转入）、赠送攻城令（D-49） |
| 战力 = 本金 × 时机系数（36h 窗口三等分：1.5 / 1.2 / 1.0），按战力分奖 | 解决末段搭便车；按 12h 分档，抢开窗第一秒没有意义（D-44） |
| 奖励 20% 立即可领，80% 等之后任意一城破城时解锁；第 10 城后 30 天线性兜底 | 防止"赢了就崩盘"（D-45） |
| 失败只销毁一半奖池，另一半滚入下一城；0 人破城和技术终止时全额滚入；第 10 城后剩余全部销毁 | 奖池滚存（D-46） |
| 团队 1.2 亿晚一轮：本城破城时不发，下一次破城才发；最后一笔在第 10 城 30 天后由任何人触发释放 | 团队永远晚玩家一轮（D-47） |
| 一键续战：用旧攻城令把本金直接转进当前城（本金不出合约） | 连战又不引入复利（D-50） |

## 2. 规则（链上实现）

- **10 轮**；`tier = 1 + 已破城数`；失败同档重试。
- **目标价**：开城时锁定 `max(P0 × 2^tier, 2 × 开窗 24h TWAP)`。
- **时间线**：结算 → 12h 集结（PREVIEW）→ keeper 开城 → 攻城 36h → 守城 24 根 1h K 线 → 第 24 根提交时判定（≥ 16 根成功）。
- **开城**：`rewardBudget = 7 亿 + carry`，carry 清零。
- **破城**：`reward = budget × weight / totalWeight`（向下取整，尾差留在合约）；`immediate = 20%`、`locked = 80%`；上一次破城的团队额度此时转出，本城的团队额度挂起。
- **城没破**：一笔销毁 `budget/2 + 1.2 亿 + 全部本金`；`carry += budget − budget/2`。
- **第 10 城结算或终止**：`endAt = now`，剩余 carry 并入销毁。
- **技术终止**（任何人可调用，7 天超时）：已开城的退本金、`carry += budget`；集结期被跳过的城 `carry += 7 亿`；团队额度留存（D-39）。

## 3. 资金流

```
用户 --TEP-74 transfer(payload v2)--> RC 的 Jetton 钱包 --notification--> RC
RC: 累加本城 totalStake / totalWeight，向 Ticket(受益人, 城) 发 TicketAddStake（带 stateInit，自动部署）

领取:  用户 --TicketClaim--> Ticket --TicketRequest(全部状态)--> RC
       RC 校验 发送者 == 推导出的 Ticket 地址 -> 计算 -> TicketUpdate 回 Ticket + 转 A9 给用户
       RC 拒绝时抛错 -> 请求 bounce 回 Ticket -> 清除 pending
续战:  用户 --TicketRestake--> Ticket --TicketRequest(restake)--> RC
       本金计入当前城（时机系数按当时）+ 向 Ticket(用户, 当前城) 发 AddStake；20% 奖励照常转出
```

- Ticket 不持有任何 Jetton，只是 RC 通过地址推导验证的收据。
- 同一时间只允许一个请求在途（`pending`），防止并发重复领取。
- RC 处理请求时先预留自己原有的 TON 余额；请求附带的 TON 用于所有转出消息，所以领取不会消耗 RC 的 gas 储备。

## 4. 信任模型（必须对外披露）

- keeper 是**单个热钱包**，负责提交开窗 TWAP 和每根 K 线，**链上无法验证价格真实性**。私钥泄露后，攻击者可以伪造 K 线，决定任意一轮的成败。
- 合约里没有任何人能修改规则或提走资金。
- 缓解措施：K 线以事件公开（含 `dataDigest` 和滚动哈希），任何人可以复核；keeper 钱包只放少量 gas；keeper 2-of-3 列为后续。

## 5. ABI

### 5.1 RoundController 入站

| Opcode | 消息 | 谁可以发 | Body |
| --- | --- | --- | --- |
| 0x52540001 | OpenRound | keeper | queryId:u64, twap24hUsdE8:u128 |
| 0x52540002 | CloseStaking | 任何人（窗口结束后） | queryId:u64, twap1hUsdE8:u128（忽略） |
| 0x52540003 | SubmitCandle | keeper | queryId, roundId:u8, candleIndex:u8, periodStart:u32, periodEnd:u32, twapPriceUsdE8:u128, dataDigest:u256 |
| 0x52540305 | TicketRequest | 仅 StakeTicket（按地址校验） | queryId, owner, roundId, amountRaw, weightRaw, principalDone, lockedClaimedRaw, restake |
| 0x52540010 | AbortTechnical | 任何人 | queryId |
| 0x52540015 | RetrySettlement | 任何人（≥ 0.3 TON） | queryId, roundId |
| 0x52540016 | ReleaseTeam | 任何人（第 10 城结束 30 天后，≥ 0.1 TON） | queryId |
| 0x7362d09c | transfer_notification | RC 自己的 Jetton 钱包 | 质押入口 |
| 0xd372158c | TopUpTons | 任何人 | — |

v10 的 Claim(0x52540006) 和 ClaimAll(0x5254000E) 已删除，领取一律通过攻城令。

### 5.2 StakeTicket 入站

| Opcode | 消息 | 谁可以发 | 附带 TON |
| --- | --- | --- | --- |
| 0x52540303 | TicketClaim | 攻城令主人 | ≥ 0.15（建议 0.2） |
| 0x52540304 | TicketRestake | 攻城令主人 | ≥ 0.25（建议 0.3） |
| 0x52540301 | TicketAddStake | 仅 RC | — |
| 0x52540302 | TicketUpdate | 仅 RC | — |

Get：`get_ticket_data()` → (rc, owner, roundId, amountRaw, weightRaw, principalDone, lockedClaimedRaw, pending)。

### 5.3 质押 payload v2

标准 transfer：`destination = RC`，`forward_ton_amount ≥ 0.1 TON`（建议 0.12），消息总额建议 0.3 TON。`forward_payload` 为 Either 右引用 cell：

```
op:u32 = 0x5254000F | version:u8 = 2 | roundId:u8 | riskDisclosureVersion:u16 = 1
| acceptFullPrincipalBurn:u8 = 1 | beneficiary:MsgAddress（addr_none = 记在转账发起人名下）
```

无效质押：附带 TON ≥ 0.1 时原路退回给转账发起人；不足时**不退**（没有退款账本，前端必须足额附带）。受益人必须在 basechain。

### 5.4 事件

| Opcode | 事件 | 字段 |
| --- | --- | --- |
| 0x52540101 | TargetPriceSet | roundId, tier, targetPriceUsdE8, twap24hUsdE8 |
| 0x52540102 | RoundSettled | roundId, status, qualifiedCandles, candlesSeen, totalAcceptedStakeRaw, tierAfter, rewardBurnRaw, teamBurnRaw, principalBurnRaw, teamReleasedRaw, rewardBudgetRaw, carryAfterRaw |
| 0x52540103 | DepositAccepted | roundId, owner, amountRaw, weightRaw, totalAcceptedStakeRaw, totalWeightRaw（续战也会发） |
| 0x52540104 | TechnicalAborted | roundId, reason, at |
| 0x5254010B | StakingClosed | roundId, closeAt, early（恒 false）, twap1hUsdE8（恒 0） |
| 0x5254010C | CandleSubmitted | roundId, candleIndex, periodStart, periodEnd, twapPriceUsdE8, dataDigest, candleHash |
| 0x5254010E | Claimed | owner, roundId, principalRaw, rewardRaw |
| 0x5254010F | DepositRefunded | owner, amountRaw, instant |
| 0x52540110 | SettlementBounced | roundId, action |
| 0x52540111 | UnexpectedBounce | op, queryId |
| 0x52540112 | Restaked | owner, fromRound, toRound, amountRaw, weightRaw |
| 0x52540113 | TeamReleased | roundId（0 = 最终释放）, amountRaw |

### 5.5 Get 方法

`get_protocol_config`（v10 形状；两个上限字段恒为 0）、`get_protocol_state`（carryRaw, lastSuccessRound, teamPendingRaw, endAt, successCount, currentRoundId）、`get_round`（v10 形状；rewardBudgetRaw 为本城奖池，集结期显示 7 亿 + carry；totalWeight 为总战力）、`get_round_status / target_price / total_stake`、`get_round_staker_count`（uint32，含义改为入账次数）、`get_ticket_address(owner, roundId)`、`get_reward_preview(roundId, weightRaw)` → (rewardRaw, immediateRaw, lockedRaw, unlockedLockedRaw)、`get_current_round`、`get_success_count`、`get_jetton_wallet_address`、`get_jetton_wallet_code_hash`、`get_ticket_code_hash`。

## 6. 部署

1. 部署 JettonMaster，MintOnce 100 亿到 treasury（同一笔交易关闭铸造）。
2. 部署 RoundController，初始数据里写入 keeper、jettonMaster、teamWallet、参数，以及 `codes = {JettonWallet 代码, StakeTicket 代码}`；carry / lastSuccessRound / teamPending / endAt 均为 0。
3. 核对 `RC.get_jetton_wallet_address() == Master.get_wallet_address(RC)`，以及 `get_ticket_code_hash` 与本 README 一致。
4. treasury 向 RC 转 **82 亿 A9**，`forward_ton_amount` 必须为 0。
5. 给 RC 充值 TON（结算每次动作约 0.1 TON，建议 ≥ 5 TON）。
6. keeper 调用 OpenRound。

## 7. 测试覆盖（RoundController 23 个 + Jetton 3 个 + 军饷分发 4 个，另见 §7.1）

部署与无上限配置；keeper 权限与目标价；开城前质押退款；攻城令创建与三档时机战力；各类无效质押退款、TON 不足不退、masterchain 受益人；受益人拥有攻城令、只有主人能领；伪造 TicketRequest 被拒；K 线校验；到期关窗；破城 20% 即领、80% 在下一次破城解锁、团队晚一轮；失败销毁一半并滚存；0 人破城全额滚存并升档；0 人失败；观察超时终止（经攻城令退本金、滚存）；集结超时终止（滚存该城 7 亿）；销毁 bounce 后任何人重试；领取 TON 不足、守城期不可领、bounce 后清除 pending；一键续战（集结期被拒、按时机系数、20% 照付、不可重复）；第 10 城后 30 天线性解锁；10 轮全流程代币守恒（奖励 + 滚存 + 销毁 + 团队，最终 RC 余额为 0）；DEX 第三方 response_destination；RC 存储不随人数增长。

## 7.1 军饷领取合约（JunxiangDistributor + ClaimRecord）

| 合约 | 代码哈希 |
| --- | --- |
| JunxiangDistributor | `0x7FD6F461CF14393C3BB0FECB1208EB9B796A974D84B140EE9FCE9B10B14932AF` |
| ClaimRecord | `0xA74D51786D46FE16A749D92D71D5479A6D10689C5542D3A46D6B7E42FD302C43` |

- **累计默克尔**：每周根承诺每个钱包的**终身累计**应得额；ClaimRecord(钱包) 记录已领额，领取支付 `累计 − 已领`；只有最新根有效，重放与旧证明一律无效。
- 叶子 = `sha256(wc:int8 ‖ addrHash:uint256 ‖ cumulative:uint128)`；父节点 = `sha256(min ‖ max)`；证明为自下而上的兄弟哈希，每 cell 3 个，下一 cell 放 ref 0。链下实现见 `worker/src/social/merkle.ts`，两边编码必须一致。
- 消息：SetRoot `0x4a580001`（publisher，listId 严格递增）、ClaimJunxiang `0x4a580002`（领取人，≥ 0.15 TON）、RecordAdvance/RecordPay（合约之间，按地址推导校验）。
- 信任：publisher 单热钱包决定分配；无 admin、无提现。**运维规则：先给分发合约钱包充足额的 A9，再发布新根**（余额不足时 jetton 转账会 bounce，该笔领取额度视为已领）。
- 测试：4 个（publisher 权限与递增、累计只付增量且一次、错误金额/冒用/旧证明被拒、伪造 RecordPay 被拒）。

## 8. 上主网前

- [ ] 外部审计 v11（RoundController、StakeTicket、JunxiangDistributor、ClaimRecord 都是新代码）。
- [ ] 后端索引器、前端、ops 按 v11 ABI 更新（进行中）。
- [ ] 测试网完整跑 10 轮，并在 STON.fi 测试网验证一键上车（swap 后带受益人 payload 转入 RC）。
- [ ] 更新风险披露：单 keeper、TON 不足不退、20/80 解锁、团队晚一轮。
- [ ] `worker/scripts/preflight-mainnet.mjs` 和部署脚本改为 v11 的 hash，以及 StakeTicket 代码参数。
