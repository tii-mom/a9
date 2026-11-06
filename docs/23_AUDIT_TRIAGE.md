# 23 — 两份审计报告的交叉核实与合并修复计划

> 输入：① `docs/22_EXTERNAL_AUDIT_REPORT.md`（2 Critical / 4 High / 4 Medium / 4 Low）
> ② 第二份外部审计（对话提供，3 High / 3 Medium / 2 Low / 1 Info）
> 方法：**逐条读源码核实**，不采信任何一份报告的结论。

## 1. 核实结论总表

| 发现（合并去重后） | 来源 | 我的核实结论 | 证据 |
| --- | --- | --- | --- |
| **A. `sendExcessesTo` 被打成困惑副手，可伪造 `ReturnExcessesBack` 抢跑结算** | 22-CRIT-01 + ②HIGH-01 | ✅ **真的，且比两份报告写的更严重** | 见 §2 |
| **B. `refundStake` 零倒贴可抽干 RC TON** | 22-CRIT-02 | ✅ **真的** | `refundStake` 每次从 RC 余额支出 0.1 TON，excess 退回 owner 而非 RC；`handleTransferNotification` 不校验入站 value |
| **C. 销毁二跳 bounce 无通知 → 永久卡 SETTLING_*** | 22-HIGH-01 + ②HIGH-02 | ✅ **真的** | `JettonWallet.onBouncedMessage` 只为 `InternalTransferStep` 发通知，**未覆盖 `BurnNotificationForMinter`**；RC/TV 无对应回滚分支 |
| **D. PauseOracle→ResumeOracle 后 OA 与 RC K 线游标永久失步** | 22-HIGH-02 + ②HIGH-03 | ✅ **真的** | `handleResumeOracle`(RC:703-706) 把 `candlesSeen/qualifiedCandles/candleHash` 清零，但 OA 的 `lastCandle`/`usedMask` 无人重置 → 之后任何 index 都被两边互相拒绝 |
| **E. 领取/预言机入口缺入站金额校验** | 22-HIGH-04 | ✅ **真的** | 5 个领取入口与 3 个 OA 入口均无 `valueCoins` 下限断言 |
| **F. `SetTeamWalletJettonWallet` 运行期可改** | 22-MED-01 + ②MEDIUM-01 | ✅ **真的** | `TeamVault.tolk:50-58` 只校验 admin + 非空，**没有** `controller == null` 或 `rounds.isEmpty()` 锁；改完会让 `ReturnExcessesBack` 校验全部失败 → SETTLING_SUCCESS 永久卡死 |
| **G. `MintOnce` 先置空 admin 再发转账，bounce 即永久报废** | ②LOW-01 | ✅ **真的** | `JettonMaster.tolk:75-79` 先 `adminAddress = null`，`:84-97` 才发 `InternalTransferStep` |
| **H. `handleOpenRound` 延迟开窗 36h 临界断崖** | 22-MED-02 | ✅ **真的** | 晚开窗会把 `stakeCloseAt` 压在 `stakeOpenAt+36h`，但 `stakeOpenAt` 未重锚 → 质押窗口被压缩到接近 0 |
| **I. `handleRollReward` 未校验 `minStakeRaw`** | 22-MED-03 | ✅ **真的** | 只校验 `rollAmount > 0`，1 raw unit 也能滚入并维持 streak |
| **J. `handleRetryPendingActions` 团队路径无 Dispatched 节流** | 22-MED-01 + ②MEDIUM-01 | ⚠️ **部分准确** | 团队 release/burn 分支确实只有 `!confirmed` 没有 `!dispatched`（可被反复触发）；但「无 gas 校验」这条**不成立**——`RC:1334` 已有 `assert (valueCoins >= ton("0.3"))` |
| **K. R10 终态后 `ClaimAll` 仍走 50% 早领** | ②MEDIUM-02 | ❌ **不成立（假阳性）** | `RoundController.tolk:1171` 的条件已含 `ex.unlockStart == 0`；`payEarlyReward`(1427) 也有同一断言。**两条路径都已锁死** |
| **L. `SetJettonWalletCode` 未锁 `currentRoundId == 0`** | 22-MED-01 | ❌ **不成立（假阳性）** | `RoundController.tolk:1019` 已有 `assert (s.currentRoundId == 0)` |
| **M. Pause/Resume 可无限重置 AbortTechnical 计时** | ②MEDIUM-03 | ⚠️ **准确但优先级低** | `handleResumeOracle` 无次数上限；但调用者必须是 admin 或 OA，属已披露的 admin 权限范围 |
| **N. TECHNICAL_ABORTED 轮导致老用户 streak 断签** | ②MEDIUM-03 | ⚠️ **准确，但是设计选择** | `streakForRound` 只认 `prev.lastRound + 1 == roundId`；作废轮用户无法参与 → 断签。这是「连续参与」语义的直接后果，不是漏洞，建议按 Low 记并给产品决策 |
| **O. 5 类状态变更无 external-out 事件** | ②INFO-01 | ✅ **准确，建议采纳** | `rollbackPendingClaim` 回滚无事件 → 纯事件流索引器会假阳性入账；我们的索引器已按 getter 为准，但补事件更稳 |

## 2. 发现 A 的准确攻击模型（合并两份报告后）

两份报告描述的是**同一条根因的两条利用路径**，都必须封：

**路径 1（转账路径，②报告）**：攻击者向「受害者的 jetton wallet」转 1 nano-A9，参数 `sendExcessesTo = RC`、`queryId = 目标 queryId`。受害者钱包收到后，向 RC 发出 `ReturnExcessesBack{queryId}`。RC 的第二分支校验 `sender == calcAddressOfJettonWallet(p.owner)` —— **sender 正是受害者钱包，校验通过** → 提前 `settlePendingClaim`。随后真正的 `TransferBounced` 到达时，`pending` 已被删除，回滚被忽略 → **用户资金永久锁死在金库**。

**路径 2（销毁路径，22 报告）**：攻击者销毁自己的 A9，参数 `sendExcessesTo = RC`、`queryId = (roundId<<16)|(kind<<8)`。JettonMaster 把该 queryId 原样放进 `ReturnExcessesBack` 发给 RC。RC 第三分支只校验 `sender == jettonMaster` → `confirmBurn(..., checkAmount = false)` → **伪造三笔销毁确认**。

**为什么一份报告漏了另一条**：22 报告只看了 burn 路径，②报告只看了 transfer 路径。两条都真。

## 3. 合并后的修复计划（按优先级，共 12 项）

### P0 — 必须修（阻断主网）

| # | 项 | 改哪里 | 关键测试 |
| --- | --- | --- | --- |
| **F1** | 封死 `sendExcessesTo` 困惑副手（覆盖路径 1+2） | `JettonWallet`：AskToTransfer/AskToBurn 断言 `sendExcessesTo == null \|\| == ownerAddress`；`JettonMaster.handleBurnNotification` 同理断言 `== burnInitiator`；`RC.confirmBurn` 加 `*BurnDispatched` 断言 | ① 攻击者指定 `=RC` 必须被拒（真钱包）② master 侧伪造必须被拒 ③ `=null` 仍允许 ④ **前端正常质押路径必须仍成功** |
| **F2** | `refundStake` 零倒贴 + 退款账本 | `handleTransferNotification` 传入 `in.valueCoins`；`refundStake` 按阈值分流（≥0.12 正常退款且 excess 回 RC / <0.12 记入 `stakes[0]` 账本）；`rollbackPendingClaim` 加 REFUND 分支；`handleClaimPrincipal(0)` 支持领取 | ① 低 gas 无效质押不抽干 RC ② 足 gas 退款 RC 净不减少 ③ 一跳/两跳 bounce 后进账本可领回（**用真 JettonWallet**） |
| **F3** | 补齐销毁二跳 bounce 通知 | `JettonWallet.onBouncedMessage` 把 `BurnNotificationForMinter` 也纳入 `TransferBounced` 通知；`RC.handleTransferBounced` 与 `TV` 的 TransferBounced 分支按 queryId 的 kind 同时支持回滚 REWARD/PRINCIPAL/TEAM 销毁 | ②报告给的 PoC：二跳 burn bounce 后，`RetryPendingActions` 必须能重新派发并最终 finalize |
| **F4** | 二跳 OOG 下保底送达 | ① `jetton.tolk` 的转账附带值 0.1（原 0.05）② `fees-management` 预留 bounce + 通知的最低费用，保证钱包始终有 ≥0.015 TON ③ `ReturnExcessesBack`/`TransferBounced` 用 `CARRY_ALL_BALANCE`（现已是）+ 明确 `BOUNCE_ON_ACTION_FAIL` | 模拟钱包余额趋零时，通知仍能送达 |
| **F5** | OA/RC K 线游标同步 | `handleResumeOracle` 重置 RC 侧时，**必须同时触发 OA 侧重置**（新增 OA 的 `ResetRoundCandles`，只有 RC 或 OA admin 可调）；`OA.onBouncedMessage` 只允许回滚 `bouncedCandleIndex == 当前 lastCandle` 的回滚 | ②报告 PoC：pause→resume 后能重新从 index 0 提交满 24 根并成功结算 |
| **F6** | 补入站金额下限 | RC 5 个领取入口 + OA 3 个签名入口加 `assert (valueCoins >= 最小值)` | 低于阈值的调用必须被拒且不产生出站 |
| **F7** | `SetTeamWalletJettonWallet` 一次性锁 | `TeamVault` 加 `assert (st.config.controller == null)`（或 `rounds.isEmpty()`） | 运行期调用必须被拒 |
| **F8** | `MintOnce` 防 bounce 报废 | 先断言 `msg.tonAmount >= ton("0.1") && in.valueCoins >= msg.tonAmount + ton("0.05")`，**再**置空 admin；或把置空放到发送成功之后（同 tx 无法回滚，所以只能靠入参断言） | 入参不足时必须整笔失败而不是半完成 |

### P1 — 强烈建议同批修

| # | 项 | 改哪里 |
| --- | --- | --- |
| **F9** | `handleOpenRound` 延迟开窗断崖（22-MED-02） | 无条件锚定 `stakeOpenAt = now`，保证质押窗口恒为 36h |
| **F10** | `handleRollReward` 补 `minStakeRaw`（22-MED-03） | 滚入额低于 `minStakeRaw` 时按「无额度」处理，不进质押、不续 streak |
| **F11** | `handleRetryPendingActions` 团队路径加 dispatched 节流（部分准确的 J） | 参考 reward/principal 的 `*BurnDispatched`，给 team release/burn 加在途标记 |
| **F12** | `rollbackPendingClaim` 等 5 类状态变更补 external-out 事件（INFO-01） | 便于索引器避免假阳性入账 |

### 不修（记录为设计选择或假阳性）

| 项 | 处理 |
| --- | --- |
| **K. R10 后 ClaimAll 早领** | ❌ 假阳性，代码已有 `ex.unlockStart == 0` 双保险 |
| **L. SetJettonWalletCode 未锁** | ❌ 假阳性，`RC:1019` 已有 `currentRoundId == 0` |
| **N. 作废轮导致 streak 断签** | 记为**产品设计选择**（连续参与语义），不改合约；在用户风险披露里写清「轮次未开启/被技术中止时，该轮不计入连胜」 |
| **F11. `handleRetryPendingActions` 团队路径加 dispatched 节流** | ❌ **评审后否决（Lead 决定）**。理由：`TeamVault.ReleaseTeamQuota`（`TeamVault.tolk:75-93`）已有完整幂等保护——已 released 只重发 ack 不转账、pending in-flight 直接 return 不重复转账；且 `handleRetryPendingActions` 要求调用者附 0.3 TON（打进 RC，RC 仅花 0.05 转发），**刷这个调用是亏钱的，RC 反而净赚**。若再加 dispatched 节流，必须配一条 TV→RC 的反向通知来清标志；这条通知一旦丢失（TON 上永远有可能）就会从「无害重复」变成「永久卡死」。**负收益改动，不做。** |
| **M. Pause/Resume 无次数上限** | 低优先级；若 F5 已实现 OA 重置，可评估是否顺带加上限 |

## 4. 对两份审计报告本身的评价

- **22 报告**：结构完整、有攻击面矩阵、有 PoC 骨架，**但漏了转账路径的伪造**（只看到 burn 路径），且把两处已有防护的项列为 Medium（L 假阳性）。
- **②报告**：**攻击模型更准确**（转账路径才是主路径，因为不需要碰 master），对 TON 异步消息的理解更深（Out-of-Gas、SEND_MODE、二跳语义）；但有 1 项明确假阳性（K）和 1 项部分不准确（J 的 gas 校验部分）。
- **结论：两份报告互补，合并后的 12 项才是完整清单。** 任何一份单独拿来修都会留下缺口——22 报告修完仍可被转账路径打，②报告修完仍可被销毁路径的 `confirmBurn` 打。

## 5. 修复后的验证要求

1. 每条修复必须有**修复前失败、修复后通过**的回归测试；
2. 所有 F1~F4 的测试必须使用**真实 JettonMaster + JettonWallet**，禁止用 mock（C-4 曾因 mock 漏测）；
3. `acton check` 0 error 0 warning；`acton test` 154 + 新增全绿；
4. 输出 `v8.7-audit-fixed` 的 5 个新 code hash；
5. **全新部署测试网实例**（改 JettonWallet 会变所有钱包地址，不能 resume），重跑 10 轮链上验收 + `chain-reconcile.mjs` 对账 DIFFS=0；
6. 把两份报告的**复核请求**一起发回给两位审计方，让他们确认各自的发现已被覆盖。