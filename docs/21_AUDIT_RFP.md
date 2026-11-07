# 21 — 主网前外部安全审计任务书（AUDIT RFP，v11）

> 状态：**待执行（v11 玩法重构后重写；取代 v8.6 版任务书）**
> 玩法权威：[docs/35_GAMEPLAY_V11.md](35_GAMEPLAY_V11.md)（D-43 ~ D-50）
> 合约权威：[contracts/README.md](../contracts/README.md)（v11 ABI、代码哈希、信任模型）
> 被审计版本：审计启动时冻结的 commit，并打 tag（冻结后审计期间除审计发现外不得改动）；本文哈希为 contracts/README 写作时的值，**冻结时必须用 `acton build --info` 重新核对**。
> 本文是**交给审计方执行的任务书**。

## 1. 项目概述

A9 是一个部署在 TON 上的高风险链上游戏协议。核心机制一句话：

> 1 GRAM 上车，大家一起把价格推过城门；城门一开，奖池分给攻城的人。没打下来，奖池一半滚到下一城。

规则要点（以 docs/35 为准）：

- 10 城（10 轮），每城 = 12h 集结（PREVIEW）+ 36h 攻城（STAKING_OPEN）+ 24 根 1h K 线守城（≥16 根达标即破城）。
- 目标价开城时锁定：`max(P0 × 2^tier, 2 × 开窗 24h TWAP)`，`tier = 1 + 已破城数`，失败同档重试。
- 战力 = 本金 × 时机系数（攻城期三等分：1.5 / 1.2 / 1.0），奖池按战力占比分配。
- 破城：本金立即全额可领；奖励 20% 立即可领，80% 压城，此后任意一城破城即解锁，第 10 城结束后仍未解锁的在 30 天内线性解锁。
- 城没破：本金 100% 销毁；奖池一半销毁、一半滚入下一城；团队 1.2 亿销毁。
- 团队 1.2 亿晚一轮发放（下一次破城时发）。
- 代币：标准 TEP-74 Jetton，总量 100 亿 A9，一次性铸造后关闭铸造。treasury 向 RC 转入 82 亿 A9（70 亿奖励 = 7 亿 × 10 城，加 12 亿团队额度 = 1.2 亿 × 10 城），见 contracts/README §6。

## 2. 审计范围（4 个自研合约 + 2 个标准模板）

### 2.1 自研合约（必须深度审计）

| 合约 | 源文件 | 行数 | code hash | 资金风险 |
| --- | --- | --- | --- | --- |
| **RoundController** | `contracts/contracts/RoundController.tolk`（共享：`types.tolk`、`constants.tolk`、`jetton.tolk`、`ticket.tolk`） | 847 | `0x74FCF17AAE8C029033AC0CEA75903BB4E1091464C27C423637BC490833EFE0D1` | **最高**：托管奖池（7 亿/城 + 滚存）、全部用户本金、团队额度 |
| **StakeTicket**（攻城令） | `contracts/contracts/StakeTicket.tolk`、`contracts/contracts/ticket.tolk` | 123 + 91 | `0x0F00D2995452947199CE5887B17C3F0BF502ECAE1D9A439A74A8D32E7EBD3DBC` | 高：每人每城一个，持有本金与奖励的领取状态；不持有 Jetton，但决定 RC 的请求来源 |
| **JunxiangDistributor**（军饷分发） | `contracts/contracts/JunxiangDistributor.tolk`、`contracts/contracts/junxiang.tolk` | 86 + 120 | `0x7FD6F461CF14393C3BB0FECB1208EB9B796A974D84B140EE9FCE9B10B14932AF` | 高：托管军饷 A9，按累计默克尔根支付 |
| **ClaimRecord**（军饷领取记录） | `contracts/contracts/ClaimRecord.tolk` | 40 | `0xA74D51786D46FE16A749D92D71D5479A6D10689C5542D3A46D6B7E42FD302C43` | 中：每个钱包一个，记录已领累计额，决定单调性 |

### 2.2 标准模板（核对未改动即可，不做深度逻辑审计）

| 合约 | 来源 | code hash | 审计要求 |
| --- | --- | --- | --- |
| **JettonMaster** | Acton 官方模板（`contracts/contracts/jetton/JettonMaster.tolk`，238 行） | `0x76B56D9A6301223F1201D719E2F4A3FB84E08D7D701CB93BB43C9D0208E5E241` | 与官方模板做逐字 diff，确认未改动；确认一次性铸造 100 亿后铸造权限关闭 |
| **JettonWallet** | Acton 官方 TEP-74 模板（`contracts/contracts/jetton/JettonWallet.tolk`，179 行） | `0xD06DAA57ED188CE9CB6CA596DD2111347433BF335223AC66C0D713C8E3DB74F4` | 同上；确认 RC 与分发合约通过 `calcAddressOfJettonWallet` 推导的钱包与链上一致 |

### 2.3 测试基线

- `acton test`：contracts/README 状态行写 **30 个通过（含军饷 4 个）**，§0 与 §7 的分项写 26 个（RC 相关）。**审计启动前以 `acton test` 实际输出为准**，并在交接材料中写明。
- `acton check`：0 error 0 warning（审计启动时重新确认）。
- 测试源码：`contracts/tests/`（`round.test.tolk`、`junxiang.test.tolk`、`jetton.test.tolk`、`helpers.tolk`）。RC 测试覆盖 10 轮代币守恒（奖励 + 滚存 + 销毁 + 团队，最终 RC 余额为 0）。
- 部署 ABI：`contracts/deploy/abi/*.json`。

## 3. 明确不在范围

- 前端（`web/`）、Cloudflare Worker 后端与索引器（`worker/`）、运维脚本（`ops/`）—— 若预算允许可单独报价，但不是本次必需。链下只需审计方确认“链下对合约事件/ABI 的解析与合约一致”这一条，不做深度审计。
- 军饷默克尔根的**生成**逻辑（`worker/src/social/merkle.ts`、`payout.ts`）：仅审计其与合约叶子/证明编码的一致性（见 §4.3），不审计链下分配规则。
- TON 公链本身、TON 官方标准库、STON.fi 路由合约。
- 经济模型是否可持续、战力公式是否“公平”（产品选择，见 §5）。
- 法律与合规。

## 4. 重点攻击面（建议审计方优先投入）

以下是项目方自行识别的高风险区，请重点验证。每一项都请给出“结论 + 依据（文件:行号）”，即使结论是“无问题”。

### 4.1 攻城令（StakeTicket）地址与请求来源

1. **地址推导**：攻城令地址 = `calcTicketAddress(rc, owner, roundId, ticketCode)`，stateInit 数据只含 `(rc, owner, roundId)` 与零值字段。验证：是否存在与推导地址相同、但 code 或初始 data 不同的可部署合约；`get_ticket_address` 与链上实际部署地址是否在所有 `roundId` 取值（1..10）下一致；`roundId` 为 `uint8` 时是否有截断或越界。
2. **TicketRequest 伪造**：RC 只验证 `sender == calcTicketAddress(RC, msg.owner, msg.roundId, ticketCode)`，而 `amountRaw / weightRaw / principalDone / lockedClaimedRaw / restake` 全部取自请求体。验证：攻击者能否构造与真实攻城令共享地址的请求；攻城令的存储能否被除 RC 外的消息改写（`TicketAddStake` / `TicketUpdate` 仅接受 `sender == rc`）；`TicketClaim` / `TicketRestake` 的 owner 校验是否可绕过。
3. **受益人入账（beneficiary）**：第三方付款可把本金记到任意基础链地址名下（赠送攻城令，D-49）。验证：受益人地址的校验（basechain、addr_none 回落到付款人）；受益人为无法发送 `TicketClaim` 的合约时资金是否永久锁定（作为设计结果记录，不作为缺陷，除非可被第三方利用）。

### 4.2 pending 标志与 bounce

4. **pending 卡死**：攻城令发出 `TicketRequest` 后置 `pending = true`，只有 RC 的 `TicketUpdate`（NoBounce）或 `TicketRequest` 的 bounce 能清除。验证：RC 成功处理后，`TicketUpdate` 因攻城令 TON 不足或 gas 不足而失败时，pending 永久为真，剩余 80% 压城奖励是否永久不可领；`VALUE_TICKET_MSG` 与攻城令存储保留是否足够。
5. **bounce 与 action phase 失败**：RC 的 `throw` 与 action phase 失败都会让 `TicketRequest` 弹回（`BounceMode.Only256BitsOfBody`）。验证：action phase 失败（例如 RC 余额不足以发出转账）时，状态回滚与 bounce 是否一致，是否可能出现“RC 已转出资金但攻城令 pending 被清除”或“攻城令清除 pending 但 RC 未转出、用户重复请求”的组合。
6. **Claim 转账的 bounce 未处理**：RC 向自己的 Jetton 钱包发 `buildJettonTransferBody(CLAIM_QUERY_TAG, ...)`，`BounceMode.Only256BitsOfBody`，但 `onBouncedMessage` 只处理 `SETTLE_QUERY_TAG` 的转账/销毁，其余仅发 `UnexpectedBounce` 事件。验证：领取转账 bounce 时，攻城令已经记录 `principalDone / lockedClaimedRaw`（即已领），资金是否滞留在 RC，用户是否无法补领。contracts/README §3 写的是“Claims cannot bounce in practice”，请验证该假设（RC 钱包余额不变量在所有路径下是否成立，包括滚存与团队额度共用同一钱包）。
7. **bounce 体截断**：攻城令与 RC 之间的 bounce 仅保留 256 bit 体。验证：`onBouncedMessage` 读取 `op(32) + queryId(64)`，团队转账 bounce 还要读 `amount`（coins），在 256 bit 截断下是否总能读到正确金额；截断体不足时的分支（`remainingBitsCount < 96` 直接 return）是否会静默吞掉需要恢复的状态。

### 4.3 TON 预留与发送模式（handleTicketRequest）

8. **`reserveToncoinsOnBalance(contract.getOriginalBalance() - valueCoins, RESERVE_MODE_AT_MOST)`**：这是“RC 不用请求的 TON 支付 gas 以外的部分”的唯一保护。验证：`getOriginalBalance()` 是否包含本条入站消息的价值（它应当包含）；bounce、退款、`TopUpTons` 进入的 TON 是否会被错误地算进或算出可用余额；当 `valueCoins` 很小时，`CARRY_ALL_BALANCE` 转出的净值是否会被 gas 吃光导致 action phase 失败（见第 5 条）。
9. **发送模式组合**：恢复路径（restake）中 `sendAddStake(VALUE_TICKET_DEPLOY, PAY_FEES_SEPARATELY)`、`sendTicketUpdate(VALUE_TICKET_MSG, PAY_FEES_SEPARATELY)`、`sendClaimTransfer(CARRY_ALL_BALANCE)` 的顺序与模式组合。验证：有奖励与无奖励两个分支的 TON 是否都足够；`CARRY_ALL_BALANCE` 是否会把 RC 的预留之外的 TON 也带走（尤其在 `reserveToncoinsOnBalance` 之后的任何 `send`）；Restaked 与 DepositAccepted 两个事件的顺序是否影响 indexer 对账。

### 4.4 奖励舍入与守恒

10. **奖励舍入**：`reward = budget × weight / totalWeight`（向下取整），`immediate = reward × 20%`，`locked = reward − immediate`。验证：所有攻城令的 `Σ reward ≤ budget`；舍入尾差（dust）留在 RC 余额中，**不属于任何账本**，是否会在多轮后累积为不可回收的余额；dust 是否可能被后续轮次的预算或销毁重复计入。
11. **权重与时机系数**：`weight = amount × timingBps / 10000`，`timingBps` 按 `stakeDurationSeconds / 3` 三等分（整除截断）。验证：三等分边界（`elapsed < third`、`< 2·third`）；`stakeDurationSeconds` 不能被 3 整除时，最后一段的长度是否与设计一致；入账与续战使用的 `now` 是否一致。
12. **守恒不变量**：验证以下关系在 settle、abort、claim、restake 所有路径下成立（RC 实际余额 = 未领本金 + 未领奖励 + carry + teamPending + dust）：
    - 成功轮：`budget = Σ reward + dust`，`carry` 在 `totalStakeRaw == 0` 时整体滚存；
    - 失败轮：`budget = burn(half) + carry(budget − half)`，`principalBurn = totalStakeRaw`，`teamBurn = teamRoundRaw`；
    - 第 10 城结算或终止：`carry` 全部并入销毁并清零；
    - 技术终止：observation 超时 `carry += budget`；preview 超时 `carry += 7 亿`（该城未开，其 7 亿滚存）。
    请特别核对：`rewardBudgetRaw` 在 `handleOpenRound` 中 `= roundRewardRaw + carry` 并清零 carry，与各终止路径中 `carry +=` 的顺序是否可能重复计入同一笔资金。
13. **本金销毁一次性**：`principalBurn = rd.totalStakeRaw` 是失败时一次性销毁。验证：RESTAKE 把本金从失败的旧轮移入当前轮后，旧轮的 `totalStakeRaw` 是否仍包含该本金（它不应再被销毁两次）；当前轮若随后失败，被续战的本金是否只销毁一次。

### 4.5 解锁链与回退时间

14. **解锁链**：`unlockedLocked(s, r, locked, now)`：若 `lastSuccessRound > r` 则全部解锁；否则在第 10 城结束（`endAt`）后按 `fallbackUnlockSeconds` 线性解锁。验证：`lastSuccessRound` 在任一破城（包括 0 人破城）时更新是否符合 D-45；第 10 城本身破城时 `lastSuccessRound = 10` 对第 10 城自身 80% 的处理（仅靠线性回退）；线性解锁的 `locked × elapsed / window` 是否单调、是否可超过 `locked`。
15. **领取单调性**：`unlocked = max(unlocked, lockedClaimedRaw)`，`lockedClaimedRaw` 由 RC 回写到攻城令。验证：在链上时间推进后再次领取是否只付增量；攻城令的 `lockedClaimedRaw` 被伪造或回滚（bounce 后未回写）时是否可重复领取。
16. **0 人破城的副作用**：`totalStakeRaw == 0` 的破城仍会更新 `lastSuccessRound`、解锁前序轮的 80%、发放上一次破城的团队额度、并设置新的团队额度（D-46 的字面含义）。验证：这一副作用是否可被利用（例如攻击者在无人参与的城市推动解锁或团队发放的时序）；是否与 D-46 的意图一致。

### 4.6 团队额度（晚一轮）

17. **teamPendingRaw 覆盖写**：破城时 `teamReleased = teamPendingRaw`，随后 `teamPendingRaw = teamRoundRaw`。验证：同一笔交易内是否可能覆盖未发出的额度；`sendTeamTransfer` 失败（bounce）时 `retryMask` 与 `teamTransferRaw` 的恢复路径是否能恢复正确金额。
18. **最终释放**：`handleReleaseTeam` 要求 `endAt != 0 && now ≥ endAt + fallbackUnlockSeconds`，任何人可触发；bounce 时在 `roundId == 0 && action == ACTION_TEAM_TRANSFER` 分支恢复 `teamPendingRaw`。验证：ReleaseTeam 与第 10 城结算（`endAt` 设置）之间的顺序；bounce 恢复后能否再次释放（不得双花）。
19. **技术终止不清 teamPending**：验证 abort 路径不改变 `teamPendingRaw`，且 round 10 abort 时不会错误销毁它。

### 4.7 续战（restake）

20. **本金不出合约**：续战将 `principal` 计入当前轮 `totalStakeRaw / totalWeightRaw`，并向 `Ticket(owner, cur)` 发 `TicketAddStake`。验证：当前轮的 `totalStakeRaw` 与 RC 余额一致（本金只是账本转移）；续战后原轮攻城令的 `principalDone = true` 能阻止原轮再次返还；续战本金不会进入奖励基数（`reward` 只由原轮 `budget × weight` 决定）。
21. **奖励不复利**：验证 `principal` 与 `reward` 严格分离；immediate 奖励照常转出；续战的 `weight` 按当前轮时机系数，不继承原权重。
22. **前置条件**：`cur != msg.roundId`、`inStakingWindow(cr, now)`、`principal > 0`。验证：攻城令在 PREVIEW/OBSERVING 期发起续战是否被拒并正确 bounce 清 pending；`currentRoundId == 0` 时 `s.rounds.get(0).loadValue()` 是否不可达。

### 4.8 充值入口与无效充值

23. **payload v2 解析**：`op(32) | version(8) | roundId(8) | riskDisclosureVersion(16) | acceptFullPrincipalBurn(8) | beneficiary(Either addr)`。验证：`forwardPayload` 的 Either 位（inline / ref）解析；addr_none（2 bit）与 addr_std（267 bit）的长度判断；`remainingRefsCount() == 0` 的约束是否能挡住带额外 ref 的载荷；`riskDisclosureVersion` 与部署配置一致性。
24. **无效充值保留**：附带 TON < 0.1 时不退款，代币留在 RC（见 §5）。验证：这种“保留”是否会破坏 §4.4 的守恒不变量（留存代币是否进入任何账本，若不进入则应记为已知留存，而不是被后续轮次的预算“回收”）；`refundDeposit` 的退款 transfer 失败（bounce）时资金去向。
25. **amount = 0 与非 RC 钱包通知**：`amount == 0` 直接 return（不退款、不入账，是否可能用于刷事件或消耗 gas）；仅 RC 自己的 Jetton 钱包可以触发 `handleDeposit`（`sender == ownWallet`），验证 `ownWallet` 推导的正确性。

### 4.9 军饷默克尔领取（JunxiangDistributor + ClaimRecord）

26. **叶子与证明编码**：叶子 = `sha256(wc:int8 ‖ addrHash:uint256 ‖ cumulative:uint128)`（49 字节）；父节点 = `sha256(min ‖ max)`；证明为自下而上的兄弟哈希，每 cell 3 个 `uint256`（`cs.remainingBitsCount() >= 256` 循环），下一 cell 放 ref 0。验证：（a）证明 cell 中剩余 `< 256` bit 的尾部是否被静默忽略，是否允许构造同根的不同证明；（b）单叶树（空证明）的行为；（c）叶子与内部节点的域分离（叶子 49 字节、内部节点 64 字节，验证不存在长度层面的第二原像）；（d）`levels <= 32` 的检查是否在所有循环退出路径执行；（e）链下 `worker/src/social/merkle.ts` 的编码与合约是否逐字节一致（链下编码非审计对象，仅核对一致性）。
27. **ClaimRecord 单调性**：`assert (msg.cumulativeRaw > st.claimedRaw)`，失败时 `throw 271`，`ClaimJunxiang` 为 `NoBounce`。验证：重放、乱序、并发的 `RecordAdvance` 是否只能推进一次；`throw 271` 时用户附带的 TON 滞留在 ClaimRecord（`NoBounce`），是否构成用户资金损失（应记录为缺陷或已知行为）；`ClaimRecord` 的 `reserveToncoinsOnBalance(0.01 TON)` 与 `CARRY_ALL_BALANCE` 组合是否会在低余额时失败。
28. **分发合约充值不足**：`RecordPay` 发出 jetton transfer 时，分发合约钱包余额不足会 bounce；此时 `totalPaidRaw` 与 `ClaimRecord.claimedRaw` 已推进。验证：bounce 是否被记录、是否可恢复（见 §5 第 6 条，已接受）；是否存在通过“故意让分发合约余额不足”而造成其他用户损失的路径（例如不同钱包的 `RecordPay` 次序）。
29. **根发布**：`SetRoot` 要求 `listId` 严格递增，只有最新根有效；在途的 `ClaimJunxiang` 在新根生效后处理时以新根校验。验证：在途请求的竞态结果；publisher 发布的根中某钱包累计额低于其已领额时的行为（应不付款且不回退）；publisher 可发布任意大的累计额（信任模型，见 §4.10）。

### 4.10 信任模型与权限

30. **单 keeper**：keeper 负责 `OpenRound`（提供 `twap24hUsdE8`）与 `SubmitCandle`（提供每根 K 线的 `twapPriceUsdE8`，链上无法验证价格真实性）。验证：keeper 之外的任何人能否伪造 `SubmitCandle` 或 `OpenRound`（`requireKeeper` 覆盖所有入口）；`CloseStaking` 与 `SubmitCandle` 的隐式关窗是否有时序攻击；`candleIndex` 严格递增、`periodStart/periodEnd` 与 `stakeCloseAt` 的绑定是否严格。
31. **单 publisher**：只有 publisher 能发布军饷根，决定分配。验证：publisher 的权限边界是否仅限 `SetRoot`；publisher 的地址与 `listId` 在部署后是否不可改（设计：无 SetAdmin）。
32. **无 admin、无升级、无提现**：验证 RC、StakeTicket、JunxiangDistributor、ClaimRecord 的所有入站消息分派（`match` + `else => throw`）中，不存在能改配置、改代码、提走 RC/分发合约 Jetton 余额或 TON 的路径。特别核对：`TopUpTons` 与 `ReturnExcessesBack` 的空分支是否可用于绕过；`ReturnExcessesBack`（TEP-74 excesses）的 `ReturnExcessesBackTicket` 是否只会把攻城令多余 TON 返回给 owner。
33. **死代码**：`constants.tolk` 中仍保留 v10 的 `OP_CLAIM` (`0x52540006`) 与 `OP_CLAIM_ALL` (`0x5254000E`) 常量，注释亦提及旧的 refund 账本。验证：RC 与攻城令的分派中没有任何路径能接受这两个操作码，且无其他合约依赖它们。

### 4.11 时间参数（部署时配置）

34. **时间参数是 deploy-time config**，存放在 `ProtocolTiming` 中，部署后不可修改（无 setter）。验证：
    - 部署路径（`ops/config/mainnet.params.json` 经 `contracts/deploy/params.mainnet.template.json` 注入）没有任何会改变运行时语义的运行时覆盖；
    - 缺少上下界校验：`candleCount == 0`、`candleSeconds == 0`、`stakeDurationSeconds < 3`、`minQualifiedCandles > candleCount`、`fallbackUnlockSeconds == 0`（线性解锁的除数）、`abortTimeoutSeconds == 0`、`previewSeconds == 0` 等错误配置的后果；
    - `riskDisclosureVersion` 在 payload 校验与配置中的一致性（当前为 1，见 §4.8）；
    - 测试网快速档（`ops/config/testnet-fast.params.json`，秒级 fallback）与主网参数（分钟/天级）之间的差异不会误入主网部署（部署脚本与参数文件的隔离）。
    审计方需给出主网参数文件的最终值，并把“配置错误会导致什么”写入报告。

## 5. 已知问题与已接受风险（**不要重复报告**）

以下事项项目方已确认并书面接受（或属于 docs/35 写明的设计），审计报告请勿列为发现；如认为其有缺陷，请在附录说明理由。

| # | 事项 | 依据 |
| --- | --- | --- |
| 1 | **单 keeper 热钱包**：链上无法验证价格真实性。私钥泄露后，攻击者可以伪造 K 线、决定任意一轮成败、伪造开窗 TWAP。K 线以事件公开（含 `dataDigest` 与滚动 `candleHash`）供任何人复核；keeper 钱包只放少量 gas | contracts/README §4；D-41 |
| 2 | **keeper 2-of-3 多签未做**（列为后续） | contracts/README §4；docs/35 §5 |
| 3 | **单 publisher 决定军饷分配**：publisher 私钥泄露或误发根，可以改变任意钱包的累计额（仅能增不能减，已领部分不可回收）。无 admin、无提现。运维规则：先给分发合约充值，再发布根 | contracts/README §7.1；ops/README §5.3 |
| 4 | **无效充值且 TON 不足 0.1 时代币不退**（无退款账本，前端必须足额附带 TON）；这部分代币留在 RC | contracts/README §5.3；docs/35 §3.2 |
| 5 | **分发合约余额不足时，领取记为已领**：`RecordPay` 的 jetton 转账 bounce 后，`claimedRaw` 与 `totalPaidRaw` 已推进，该笔额度视为已领。运维先充值、再发根以避免 | contracts/README §7.1 |
| 6 | **2× 倍数下理性用户 EV 为负**（产品选择，机制依赖上车与人数，不依赖正期望） | D-33（docs/00）；docs/35 维持不变 |
| 7 | **不做法律意见书**，合规风险由项目方自担 | D-34（docs/00） |
| 8 | **输了归零**：失败轮本金 100% 销毁，无稳健/梭哈模式、无复活、无免死 | D-43（docs/35） |
| 9 | **失败轮 50% 奖池销毁、50% 滚存；团队 1.2 亿销毁；第 10 城结束后剩余滚存全部销毁** | D-46（docs/35） |
| 10 | **0 人上车但破城**：奖池 100% 滚存、解锁前序轮 80%、团队额度照常发放（见 §4.5 第 16 条的意图确认，本条只接受“意图”，副作用的可利用性仍需验证） | D-46（docs/35） |
| 11 | **团队额度晚一轮**：第 r 城破城不发，下一次破城才发；最后一笔在第 10 城 30 天后任何人可释放 | D-47（docs/35） |
| 12 | **续战（一键）只续本金，奖励不复利**；续战本金的失败风险与原轮一致（新轮失败即销毁） | D-50（docs/35） |
| 13 | **受益人赠送攻城令**：第三方可把本金记到任意基础链地址名下 | D-49（docs/35） |
| 14 | **80% 压城奖励的线性回退**：第 10 城结束后仍未解锁的部分，在 30 天内线性释放，期间立即领取可能只得到部分解锁额 | D-45（docs/35） |
| 15 | **生产时序（12h / 36h / 24h，fallback 30 天）只经过仿真验证**；主网前的测试网 10 轮演练记录见 `ops/drills/2026-11_testnet_v11_10round_drill.md`，以该演练的实际结果为准 | ops/drills；docs/35 |

## 6. 交付物要求

审计方需交付：
1. **审计报告**（PDF/Markdown），按严重度分级：Critical / High / Medium / Low / Informational
2. 每条发现包含：标题、位置（文件:行号）、影响描述、**可复现的攻击场景或 PoC**、修复建议
3. **概念验证代码**：Critical 与 High 级别必须提供可运行的 PoC（Tolk 测试或脚本），不接受纯文字描述；PoC 应放在 `contracts/tests/` 下可由 `acton test` 运行
4. **复核报告**（项目方修复后的第二轮）：确认每条发现已修复或明确标记为「接受风险」
5. 审计方法论说明（用了哪些工具、覆盖了哪些路径、未覆盖什么）
6. **§4 每一条的结论表**：每条给出“确认有问题 / 无问题（依据）/ 不适用”，便于项目方对账

## 7. 严重度定义（请严格按此分级）

| 级别 | 定义 |
| --- | --- |
| **Critical** | 可直接导致用户或协议资金被盗/永久锁定，无需特殊条件 |
| **High** | 在特定条件下（如特定时序、特定用户行为）可导致资金损失或永久拒绝服务 |
| **Medium** | 可导致部分功能失效、数据不一致，但不直接造成资金损失 |
| **Low** | 代码质量、边界条件、gas 优化等 |
| **Informational** | 建议与注释 |

## 8. 时间与里程碑

| 阶段 | 内容 | 预期时长 |
| --- | --- | --- |
| M0 | 材料交接 + 启动会（30 分钟），冻结 commit，核对 code hash | Day 0 |
| M1 | 静态审计 + 威胁建模，输出初步发现清单 | Week 1 |
| M2 | 深入验证 + PoC 编写，输出完整报告 | Week 2–3 |
| M3 | 项目方修复（仅审计发现，不改其他逻辑） | Week 3–4 |
| M4 | 复核 + 最终报告 | Week 4 |

**总周期 3–4 周**。修复期间项目方会打新 tag，审计通过的最终版本 tag 为 **`v11-audit-fixed`**；修复后重跑 `acton test` 与 `acton check`，重新部署测试网实例，重新跑 10 轮链上验收（`ops/drills/`）。

## 9. 项目方提供的材料

1. 代码仓库（含完整 git 历史），审计分支与冻结 commit
2. `docs/35_GAMEPLAY_V11.md` —— v11 玩法规格（D-43 ~ D-50，权威）
3. `contracts/README.md` —— v11 合约 ABI、代码哈希、资金流、信任模型（权威）
4. `docs/00_DECISIONS_V2.md` —— 全部产品与安全决策（§0 为 v11 口径，其余为历史决策）
5. `contracts/tests/` —— 合约测试（含 10 轮代币守恒）
6. `contracts/deploy/abi/*.json` 与 `contracts/deploy/params.*.json` —— 部署 ABI 与参数模板
7. `ops/config/mainnet.params.json`（主网参数最终值）与 `ops/config/testnet-fast.params.json`（测试网快速档，仅供对照）
8. `ops/drills/2026-11_testnet_v11_10round_drill.md` —— v11 测试网 10 轮演练计划与记录
9. `worker/src/indexer/tools/fixtures/v11-synthetic.json` —— 合成事件夹具（链下解析对照用）
10. 测试网实例地址与 code hash（可自行上链核对）
11. 历史材料（v8.6/v8.9/v10，仅供溯源，**不适用于 v11**）：`docs/18_AUDIT_BRIEF.md`、`docs/19_TESTNET_ACCEPTANCE.md`、`docs/20_INDEXER_RECONCILE.md`、`docs/17_REWARD_V2.md`

## 10. 验收标准（什么算审计完成）

- [ ] 4 个自研合约全部覆盖，每个合约明确标注审计深度；2 个标准模板完成逐字 diff
- [ ] §4 所有条目都有结论（确认 / 无问题 + 依据 / 不适用）
- [ ] Critical / High 全部有 PoC，且 PoC 可由 `acton test` 运行
- [ ] 报告明确列出「未覆盖范围」（至少包括链下 `worker/`、`web/`、`ops/`，以及 STON.fi 路由）
- [ ] 复核报告确认所有 Critical/High 已修复或书面接受；修复后的最终版本打 tag `v11-audit-fixed`
- [ ] 审计方对 §5「已知问题与已接受风险」清单无异议（或明确说明为何有异议）
- [ ] 修复后 `acton test` 与 `acton check` 全部通过，测试网重新部署并完成 10 轮演练

## 11. 关键提醒给审计方

**这是不可升级合约。** `RoundController`、`StakeTicket`、`JunxiangDistributor`、`ClaimRecord` 的代码与配置一旦部署就永久不可改，没有代理、没有迁移、没有 SetAdmin、没有提现入口。**上线后发现的任何缺陷都永久无法修复。** 请按「错了就没有第二次机会」的标准执行。

v10 时代的内部审查曾发现多个 Critical 级缺陷（解锁双花、领取发送方校验错误、开窗永久死锁、团队释放 bounce 无回滚）。v11 重写了资金路径（攻城令、续战、解锁链、团队晚一轮、军饷默克尔），这些都是新代码，**同类问题很可能再次出现**。请假设代码里仍藏着至少一个 Critical。
