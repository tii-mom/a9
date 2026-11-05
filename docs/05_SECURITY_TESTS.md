# 05 --- 安全要求、威胁模型与测试清单

> **口径声明（V6.1）**：已确认 D-28 同档重试、D-30 不做时间加权、质押上下限（10,000 A9 / 单地址≤10% / 本轮≤2 亿 A9）、技术终止（暂停14天或观察超时7天，任何人可触发，退100%本金、不销毁奖励/团队、不消耗档位）。观察 **72h = 18 根 4h / 阈值 12（容错 6 根）**；目标价**开窗时锁定 `max(阶梯 P0×2^tier, 2×开窗 24h TWAP)`**、锁定后不可改；**95% 闸门与 7 天提档已取消**；**24h PREVIEW 预告期已确认**；保留触价提前关窗；单轮 7 天 / 10 轮 70 天；分配 70/8+5/12/5；P0 = $0.00116；团队 12 亿 TeamVault 托管；不允许取消质押（仅技术终止退本金）；奖励 pull claim / claimAll。与 docs/00 冲突以其为准。

## 1. 威胁模型

  -------------------------------------------------------------------------------------------
  风险                    攻击/故障示例                必须采取的措施
  ----------------------- ---------------------------- --------------------------------------
  伪造 Jetton             攻击者发送同名假币           验证 canonical Jetton Wallet 地址

  伪造质押人              伪造 transfer_notification   校验消息来源与 owner 字段
                          sender                       

  重放质押                重复提交同一 nonce           nonce 去重、幂等记账

  迟到质押                质押窗口关闭后到账           按到账处理时间验证并退款

  预言机操纵              单池短时拉价                 多源、TWAP、流动性和成交量阈值

  数据重放                重复提交同一K线              roundId/index/time/nonce/digest 去重

  过期价格                提交旧价格                   validUntil、periodEnd、数据年龄检查

  消息丢失/失败           跨合约消息 bounce            pending 状态、可重试、幂等

  重复销毁                同一轮多次 burn              唯一 burnId、burn 状态机

  重复领取                用户多次调用 claim           claimed/pending 状态与唯一 claimId

  管理员滥权              修改价格目标或恢复失败轮次   不可变配置、单密钥 owner 权限最小化、终态不可逆

  单密钥泄露/丢失          owner 私钥或托管钱包失窃      硬件钱包、冷热分离、热钱包最小余额、至少向审计/交易所披露、密钥备份与轮换演练、控制器不可升级

  伪造团队指令            非 RoundController 向 TeamVault 发指令   TeamVault 校验 sender = RoundController，其余拒绝

  领取重放/越界           重复 claim、单次遍历超 10 轮   (round,owner,type) 幂等标记；claimAll 固定上界 10 轮；金额先校验后合并一笔转账

  资金卡死                预言机长期不可用             ORACLE_PAUSED 与技术性退款路径

  Sybil                   多钱包拆分质押               每地址上限只能缓解，不能证明真人唯一

  舍入攻击                小额拆分改变权重             整数计算、明确 floor
                                                       规则、聚合地址余额
  -------------------------------------------------------------------------------------------

## 2. 必须保持的不变量

1.  `initialMinted <= 100亿 × TOKEN_SCALE`。
2.  `sum(roundRewardBudget[1..10]) == 70亿 × TOKEN_SCALE`。
3.  每轮 `rewardBudget == 7亿 × TOKEN_SCALE`。
4.  每轮价格目标在开窗时锁定为 `max(P0 × 2^tier, 2 × 开窗 24h TWAP)`；锁定后本轮不可改。
5.  一轮最多有18个有效 candle index。
6.  一个 candle index 最多成功计数一次。
7.  `qualifiedCandles` 不超过12。
8.  `qualifiedCandles >= 12` 才能通过。
9.  `qualifiedCandles <= 6` 且18根有效K线齐备，才可判市场失败。
10. 预言机故障不得触发本金销毁。
11. 成功轮次不得销毁本轮本金。
12. 失败轮次不得返还本轮本金。
13. 一笔 stake 不得同时被返还和销毁。
14. 一个 reward pool 不得被重复领取或重复销毁。
15. 失败轮次必须永久关闭。
16. 下一轮目标价不得因上一轮失败而重置。
17. 实际 burn 必须使 Jetton Master total_supply 减少。
18. 管理员不得更改已开始轮次的目标价、K线阈值或 oracle config hash。
19. 无人质押的轮次也必须完成完整观察窗口（18 根 K 线），不得跳过、延期或直接判负。
20. 团队额度每轮上限为 `1.2亿 × TOKEN_SCALE`，十轮释放 + 销毁合计等于 `12亿 × TOKEN_SCALE`。
21. 同一轮的团队额度不得同时释放和销毁；每轮最多发生一次。
22. 成功轮团队释放量精确等于 1.2 亿；失败轮团队 burn 量精确等于 1.2 亿。
23. 0 人质押且轮次通过时，本轮 7 亿奖励必须销毁（不得留存、回流或转移）。
24. TeamVault 只执行 RoundController 的指令；其他发送者一律拒绝。
25. 同一轮团队额度的释放与销毁互斥且幂等（每轮最多一次，重复指令返回已有结果）。
26. `claimAll` 单次最多遍历 10 轮，逐轮幂等，合并为一笔 Jetton 转账；重复调用不得重复派发。
27. 报名窗口严格为 72 小时（259,200 秒），`stakeOpenAt = prevSettledAt`（间隔 0），观察起点 = 报名截止时刻。
28. RoundController 不可升级；管理员不得修改已开轮参数或转移用户质押本金。
29. 质押不可取消：不存在取消/提现消息；唯一退款路径是 `TECHNICAL_ABORTED`（退还全部本金，不销毁）。
30. 观察窗口固定为 **18 根 / 72h / 12 阈值（容错 6 根）**（V6 已确认）。
31. （D-28 若采纳）目标价按 tier 语义：`tier = 1 + 已成功轮数`，失败不升档、成功才升档；未采纳前按轮次 `P0 × 2^roundId`。
32. 目标价写入时机：第 N 轮结算写入第 N+1 轮 `targetPrice`；写入后不可改；每次写入必须发 `TargetPriceSet` 事件。
33. 合约不得预存 10 轮价格数组；只存 P0、倍数（不可变）、档位计数、每轮 `target_price`。
34. 任何人可用 `P0 × 2^(tier)` 离线校验链上写入的目标价；不一致即告警。
35. 质押校验：单笔 ≥ 10,000 A9；单地址累计 ≤ 本轮总质押 10%；本轮总质押 ≤ 200,000,000 A9。
36. 技术终止：连续暂停 14 天或观察超时 7 天可由任何人触发；退 100% 本金、不销毁奖励/团队额度、不消耗档位。
37. 失败轮 tier 不变、成功轮 tier+1；同一轮 target 按锁定值不可改。
38. 分配总和恒为 100%：奖励 70% + 内盘销售 8% + 流动性 5% + 团队 12% + 营销 5%（V5.5 定案，8%+5%=13%）。
36. 内盘销售额度 = 800,000,000、流动性额度 = 500,000,000；冷启动池 100,000,000 A9 + $116,000 不超过流动性额度（占比 20%）。

## 3. 单元测试

### 3.1 价格公式

-   Round 1 = 2×P0。
-   Round 2 = 4×P0。
-   Round 10 = 1024×P0。
-   P0 为0时拒绝初始化。
-   超出整数位宽时拒绝初始化。

### 3.2 K线判定

-   12/18 达标：成功。
-   7/12 达标：失败。
-   12/12 达标：成功。
-   0/12 达标：失败。
-   恰好等于目标价：达标。
-   低一个最小价格单位：不达标。
-   candle index 重复：拒绝或幂等，不增加计数。
-   candle 时间范围错误：拒绝。
-   仅有11根有效K线：不得判定市场失败。
-   任一数据源无效：按预言机故障处理，不得自动当作未达标。

### 3.3 质押

-   合法 Jetton、合法 payload：记账成功。
-   非本项目 Jetton：拒绝。
-   非 canonical wallet 发消息：拒绝。
-   风险确认字段 false：退款。
-   风险版本不匹配：退款。
-   质押窗口外：退款。
-   重复 nonce：不得重复计账。
-   同地址多笔不同 nonce：正确累加。
-   0金额：拒绝。
-   超过最大限额：按配置拒绝或拆分处理，不能静默少记。
-   取消质押请求：**不存在该消息类型**；任何试图提前退出的调用被拒绝（V5.3 已确认）。
-   管理员尝试手工退款/解锁：无此权限，必须拒绝。
-   技术性终止：`TECHNICAL_ABORTED` 时全部本金退还给原质押人，奖励额度不销毁、不发放。

### 3.9 目标价写入（V5.4）

-   结算轮 N 后：`round[N+1].targetPrice == P0 × 2^(下一档位)`，且 `targetWrittenAt > round[N].settledAt`。
-   写入后再次尝试修改：拒绝（不可变）。
-   未结算时读取下一轮 target：为空/未写入，前端应显示「待结算写入」。
-   事件 `TargetPriceSet(roundId, targetPriceUsdE8, tier)` 必须与链上存储一致。
-   若采用 D-26 闸门+超时提档：提档 target 在开轮交易写入，且 `writtenAt < stakeOpenAt`；开窗后不得再改。
-   离线校验：按 P0 与倍数重算的 10 轮表与链上逐轮写入值一致。

### 3.4 成功结算（含 TeamVault 释放与 claimAll）

-   质押本金总返还量等于已接受质押总量。
-   每个用户只能领取一次本金。
-   每个用户只能领取一次奖励。
-   权重总和为0时不能进入正常成功分配。
-   奖励总分配不超过7亿。
-   舍入余数留在奖励金库。
-   失败轮次不能领取奖励。
-   成功轮团队额度精确释放 1.2 亿，且只释放一次。
-   团队释放失败（bounce）时可重试且不重复释放。
-   0 人质押且通过：7 亿奖励全部销毁，无任何领取记录。
-   **TeamVault 释放**：RoundController 指令成功 → TeamVault 转出 1.2 亿；非 RC 来源指令被拒；重复指令不重复转出。
-   **claimAll**：跨 2~10 轮一次性领取，金额等于各轮 `floor(reward×weight/totalWeight)` 之和；每轮标记后不可重复领取；超过 10 轮的输入被拒绝或截断（固定上界）。
-   **claimAll 合并转账**：多轮金额只产生一笔 Jetton transfer；gas 由用户承担；bounce 时不丢状态，可重试。
-   **claimAll 部分成功**：任一金额校验失败时整笔回滚，不得出现半领取。

### 3.5 失败结算

-   失败时奖励 burn 金额精确等于7亿（kind = reward）。
-   失败时团队 burn 金额精确等于1.2亿（kind = team）。
-   失败时质押 burn 金额精确等于 roundTotalStake（kind = principal）。
-   **三笔** burn ack 缺一不可。
-   重复 BurnAck 不会重复计账。
-   burn 消息 bounce 时可安全重试。
-   burn 未确认时轮次不得标记为最终失败。
-   失败终态不能重新打开。
-   下一轮价格目标保持原公式。
-   TeamVault 销毁由 RoundController 的 `BurnTeamQuota` 触发；非 RC 指令不得销毁。
-   TeamVault 销毁失败/未确认时，轮次不得标记为最终失败。

### 3.6 无人质押（V3，V4/V5 补充）

-   报名关闭时 `totalAcceptedStake == 0`：仍进入 `OBSERVING`，不跳过、不延期。
-   `stakeOpenAt = prevSettledAt`（间隔 0）、`stakeCloseAt = stakeOpenAt + 72h`（259,200 秒）、`observationStart = stakeCloseAt` 三个时间点必须精确。
-   无人质押 + 失败：奖励 burn 金额精确等于 7 亿、团队 burn 1.2 亿，本金 burn 金额为 0。
-   无人质押 + 通过：奖励按质押比例分配；单一质押人获得全部 7 亿；**0 名质押人时本轮 7 亿奖励销毁**（D-18b 已定，不得留存或转移），且不得死锁轮次。
-   无人质押不得导致轮次卡在 `STAKING_CLOSED` 或重复开轮。

### 3.7 TeamVault 与领取边界（V5）

-   TeamVault 余额初始化精确等于 12 亿；十轮累计释放 + 销毁 = 12 亿。
-   成功轮 TeamVault 转出 1.2 亿后余额减少；失败轮销毁 1.2 亿后 total_supply 减少。
-   TeamVault 收到非 RoundController 指令：拒绝且不改变状态。
-   TeamVault 同一轮先 release 后 burn（或反之）：第二次指令返回已有结果，不重复执行。
-   claimAll 传入空列表 / 全为已领轮次：返回 0，不发转账，不消耗多余 gas。
-   claimAll 传入包含未结算轮次：拒绝该轮（或整笔拒绝），不得提前领取。
-   历史未领奖励可累积：隔多轮后一次 claimAll，金额与逐轮领取之和一致。

### 3.8 V5 待决策的价格语义

-   当前仍按固定阶梯 `P0 × 2^n` 测试（`targetMode = FIXED_LADDER`）。
-   若项目方选定 docs/00 §7 的方案 A（相对翻倍）：需新增「报名截止时锁定目标价 = 2 × 参考 TWAP」的测试、参考窗口/覆盖率校验、锁定后不可改的测试。
-   若选定 **方案 B+（Lead 推荐）**：需新增「1h TWAP 闸门（≤ 目标×95%）/ 每 4h 检查 / 最长 7 天 / 提档 P0×2^(n+1)」「触价提前关窗」「关窗后下一个 UTC 4h 边界开始 72h 观察」「结算后 24h 缓冲」的测试。方案 C 同理。选定前不要按新语义写测试。
-   若选定 **D-28 失败同档重试**：需新增「失败 → 下一轮 targetPrice 不变、tier 不变」「成功 → tier+1、targetPrice ×2」「10 轮 ≠ 10 档位」的测试；若选定 **D-29 R1 启动规则**：需覆盖 R1 特殊目标（1.3~1.5× 基准 TWAP 或空跑）的测试；若选定 **D-30 时间加权**：需覆盖前 24h/后 48h 两档权重的测试。**均未定案，当前不写。**

## 4. 集成测试

必须覆盖完整跨合约消息链： 1. 用户钱包 -\> 用户 Jetton Wallet -\>
StakingVault Jetton Wallet -\> StakingVault notification。 2.
StakingVault -\> RoundController stake ledger 更新。 3. Keeper -\>
OracleAdapter -\> RoundController candle 记录。 4. RoundController -\>
RewardVault/TeamVault/StakingVault 的 burn 或 release request。 5. Vault owner -\> Jetton Wallet
burn。 6. Jetton Wallet -\> Jetton Master burn_notification。 7. Jetton
Master -\> RoundController BurnAck（三笔）。 8. 成功轮：RoundController -\>
TeamVault（1.2 亿释放到团队收款钱包）。 9. 用户 claimAll -\> RoundController -\> Vault -\> Jetton
transfer -\> 用户 Jetton Wallet（合并一笔）。

每个环节都要测试成功、bounce、重复消息、超时和重试。

## 5. 模糊测试与属性测试

建议对以下输入做 fuzz： - 随机 stake amount； - 随机 nonce； -
任意顺序提交 candle； - 重复和乱序消息； - 过期时间戳； -
极端价格数值； - 大额 totalStake； - 多轮并发消息； - 恶意构造
payload； - 任意 bounce 状态。

使用 property-based tests 检查第2节所有不变量。

## 6. 主网前安全要求

-   第三方智能合约安全审计（自研面 **RoundController + TeamVault**，含团队释放/销毁、0 人质押分支、claimAll、不可升级与权限边界）。
-   Jetton Master/Wallet 及自定义 burn ack 扩展专项审计。
-   密钥托管专项检查：单密钥 owner 与个人热钱包的权限最小化、硬件钱包与备份流程、地址不公开情况下的审计披露路径。
-   OracleAdapter 签名验证专项审计。
-   经济攻击模拟（低流动性拉盘、价格回落、预言机延迟）。
-   大额质押与失败销毁压力测试。
-   退款、返还、burn 和 claim 的消息追踪测试。
-   Testnet 完整演练至少覆盖一轮成功和一轮失败。
-   发布合约源码、编译版本、代码哈希和审计报告。
-   公开用户风险确认界面和不可逆损失说明。

## 7. 用户界面风险确认

质押 UI 必须在签名交易前显示： - 本轮目标价格； -
报名窗口 72 小时；观察 72 小时 / 18 根 K 线 / 至少 12 根达标规则； - **高风险提示：可能损失全部本金**； - 失败后奖励额度销毁； -
失败后本轮全部质押本金100%销毁； - 技术故障与市场失败的区别； -
该轮失败永久关闭； - 用户质押数量及预计承担的最大本金损失； -
奖励领取方式：pull claim（用户自付 gas，可跨轮累积、一次领取）。

用户必须主动勾选风险确认，且确认版本写入链上 stake payload。**V6.2（D-34）**：风险披露须写明「项目方不提供外部法律意见，合规风险由项目方承担；机制为高风险实验，可能损失全部本金」。
