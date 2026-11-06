# 27 — 第三份审查报告的核实结论

> 被核实对象：对话中提供的第三份代码审查报告（4 个并行代理中途撞限额，由主审自行核实后产出）
> 核实基线：**当前代码 = `v8.7-audit-fixed` @ `e6c4278`**（RoundController 2,164 行，175 tests）
> 核实方式：逐条读当前源码，不采信任何一方结论。

## 0. 总体判定：**报告不满足「可直接采纳」的条件，但其中有 6 项仍然有效且值得修**

**根本问题**：这份报告审的是 **v8.5 之前的代码**，不是当前版本。它引用的行号（RC 1,924 行）、「`onBouncedMessage` 为空」、「RollReward 不检查 stakeCloseAt」、「team 消息 0.05 + NoBounce」等，都是我们在 v8.6/v8.7 已经修掉的。

它**没有读** `docs/18 §16`（v8.7 修复基线）、`docs/22`、`docs/23`——否则不会把已修项重新报一遍。

因此：**不能当作「新发现的 P0 清单」直接用**；但把它仍然成立的部分挑出来，是有价值的补充。

## 1. 逐条核实表

| 报告结论 | 当前代码（v8.7） | 判定 |
| --- | --- | --- |
| **P0-1** `handleReturnExcesses` master 分支可伪造销毁确认 | `confirmBurn` 已断言 `*BurnDispatched`（F1）；`JettonMaster` 断言 `sendExcessesTo == burnInitiator`；`JettonWallet` 断言 `sendExcessesTo == owner` | ❌ **已修复（v8.6 C-1~C-4 / v8.7 F1）** |
| **P0-1 兼容分支**「RC 自己钱包的 excess 直接结算 pending claim」 | 分支仍在（`RC:1141-1145`），但攻击者已**无法让 RC 的钱包发出该消息**——`JettonWallet` 限制发送方只能把 excess 指定给 owner，攻击者的钱包 owner 是自己，不是 RC | ⚠️ **不可利用，但建议删除该分支**（纵深防御） |
| **P0-1 TeamVault 同构问题** | 同上：`sendExcessesTo` 已在钱包层锁死，攻击者无法让 teamWallet 的钱包把 excess 发给 TV | ❌ **已修复（同一处 F1 修复覆盖）** |
| **P0-2 生产部署是 demo 数据源 + 无签名写入开放** | `worker/wrangler.toml`：`DATA_SOURCE="demo"`、`DEMO_ALLOW_UNSIGNED_WRITES="true"`；CI deploy job（`ci.yml:243`）直接 `wrangler deploy`，无 `--var` 覆盖 | ✅ **仍然成立，必须修** |
| **P0-3 SubmitCandle 无时间上界** | `RC:565` 只有 `assert (now >= expectedEnd)`，**没有上界** | ⚠️ **成立**（在「admin/oracle 可信提交」前提下危害有限，但建议加上界） |
| **P0-3 OracleAdapter 转发前推进 lastCandle，bounce 后不回滚** | v8.6 C-3 已加 `pending` + `onBouncedMessage` 精确回滚；v8.7 F5 又修了 `lastCandle` 语义与 FIFO 乱序 | ❌ **已修复** |
| **P0-3 预言机未接入** | 设计如此（D-36 期间的决定：先 admin 手动提交），OA 已部署但未设签名人 | ⚠️ **成立但已知**（用户已明确「链上预言机还是需要的」，列入上线后阶段） |
| **P1-1 技术终止永久消耗一轮，8.2 亿滞留** | `handleAbortTechnical`（`RC:766-830`）：状态置 `TECHNICAL_ABORTED`、`currentRoundId` 推进、下一轮建成 PREVIEW；**该轮的 7 亿奖励与 1.2 亿团队额度既不分配也不销毁，留在 RC/TV 钱包里** | ✅ **仍然成立**——这不是安全漏洞（守恒仍成立），而是**业务规则缺口** |
| **P1-2 RollReward 绕过质押窗口与最低质押** | v8.6 C-1 已加 `now < nextRd.stakeCloseAt`；v8.7 F10 已加 `rollAmount >= minStakeRaw` | ❌ **已修复** |
| **P1-3 团队消息 0.05 TON + NoBounce** | `sendTeamRelease`/`sendTeamBurn`（`RC:1781-1789`）仍是 `ton("0.05")` + `BounceMode.NoBounce` | ✅ **仍然成立**（与 F-04「不得静默丢弃完成信号」的原则不一致） |
| **P1-4 docs/00 D-14 写「纯质押比例」，与权重公式冲突** | `docs/00` D-14 原文确实仍是「纯质押比例」，权重制写在 docs/17 与代码里 | ✅ **仍然成立**（决策登记缺项） |
| **P1-5 docs/02 时间口径自相矛盾** | 确认：同一文件里 PREVIEW 有 24h（:41）和 12h（:52/:106）、报名有 72h（:104/:106）；观察阈值 12/16 并存 | ✅ **仍然成立** |
| **P1-6 worker candle_hash 与链上算法不一致** | v8.7 H-7 已让 **chain 模式跳过本地哈希**，只认索引器写入的链上 TON cell 哈希；demo 模式仍用字符串哈希（仅演示） | ❌ **已修复（chain 模式）** |
| **P1-7 审计简报数字过时** | `docs/18 §16` 已补 v8.7 基线（2,164 行 / 175 tests），但**前面章节仍保留旧的 1,744 行、114/130/132 测试数** | ⚠️ **部分成立**（§16 是权威，旧章节需标注 superseded） |
| **P2 ClaimReward 与 ClaimRewardEarly 行为相同** | 确认两者都调 `payEarlyReward`（`RC:1554-1560`） | ✅ **成立但是设计**：阶梯期内领取一律 50% + 50% 锁仓，命名有误导但不是 bug |
| **P2 仓库跟踪 77 个开发产物** | 确认：`git ls-files` 命中 `.playwright-cli` 日志与 `qa/` 截图 | ✅ **仍然成立** |
| **P2 死代码**（AbortTechnical 的 PREVIEW 分支、TopUpTons 空操作等） | 部分仍成立（PREVIEW 分支现在**可达**了——M-1 修复后专门处理「pending next PREVIEW」的卡死，所以这条**已不成立**） | ⚠️ **部分准确** |
## 2. 报告里**明确错误**的三处

| # | 报告说法 | 实际情况 |
| --- | --- | --- |
| 1 | 「早领 50% 是罚款进池，不是锁定给本人」（后已自行撤回） | 撤回正确。50% 留在本人名下、R10 后线性解锁 |
| 2 | 「AbortTechnical 的 PREVIEW 分支不可达」 | **已可达**：M-1 修复后专门处理「已结算但下一轮 PREVIEW 卡住」的情况（`RC:789-811`） |
| 3 | 「OracleAdapter 签名事后仍然有效」 | 部分不准：`checkTimestamp`（`OA:155-162`）有 ±`SIGNED_TIMESTAMP_WINDOW` 新鲜度校验，不是永久有效；但**确实没有把签名绑定到 K 线的 period** |

## 3. 仍然有效的 6 项 —— 建议怎么处理

| # | 项 | 建议 | 优先级 |
| --- | --- | --- | --- |
| 1 | **P0-2 CI 自动部署 demo 配置到生产** | CI deploy job 必须改成显式传 `--var DATA_SOURCE:chain --var DEMO_ALLOW_UNSIGNED_WRITES:false` 等，且从 `mainnet.params` 生成；**在此之前禁止 push 到 main 触发部署** | **P0，立刻** |
| 2 | **P1-1 技术终止的资产去向** | 业务决策：中止轮的 7 亿奖励 + 1.2 亿团队是否应销毁（使 supply 反映现实），还是明确「留在金库作为后续轮次缓冲区」。**不改合约就无法改变**，所以必须在主网前定 | **P0（业务决策）** |
| 3 | **P1-3 团队消息 gas + NoBounce** | 与 F-04 对齐：`0.05 → 0.1`、`NoBounce → Only256BitsOfBody` + bounce 回滚。属于合约改动，要跟下一批补丁一起做 | P1 |
| 4 | **P1-4 / P1-5 文档口径** | docs/00 决策表补 D-39（权重制），docs/02 整体按 V7 重写；旧数字标注 superseded | P1（文档，不影响代码） |
| 5 | **SubmitCandle 时间上界** | 加 `assert (now <= expectedEnd + 某窗口)`；需合约改动 | P2 |
| 6 | **仓库瘦身** | 把 `.playwright-cli` / `qa/` 截图移出版本控制 | P2 |

## 4. 对报告方法的评价

**做得好的地方**：
- 独立推导了结算数学（weight+bonus 之和恒等于 totalWeight，Σreward ≤ 预算），这个验证角度我们之前没做过
- 识别出「异步消息的信任边界」是这套合约的核心风险面——方向完全正确
- 对 P0-1 的攻击构造（用自己的 burn、response_destination 填 RC、queryId 自选）是准确的，这正是我们 v8.7 F1 修的同一个洞

**方法缺陷**：
- **没有对照当前版本**：报告基于 RC 1,924 行，当前是 2,164 行；至少 6 项已修
- 没读 `docs/18 §16` / `docs/22` / `docs/23`，导致重复报告已修项
- 「未完整覆盖」的部分包含 worker 3,500 行、前端、ops——这些恰好是我们已经用索引器对账（DIFFS=0）和 10 轮链上用验证过的区域

## 5. 结论

- **不能作为新一版审计报告直接采纳**（基线过时，6 项已修）。
- **但它贡献了 1 个新的 P0（CI 部署安全）和 1 个我们此前只讨论过、没记录的 P0 级业务缺口（技术终止资产去向）**，这两项是真的有价值。
- 建议：把这 6 项并入下一步行动，其余作为「已在 v8.6/v8.7 修复」的对照记录。