# 05 --- 安全要求、威胁模型与测试清单

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

  管理员滥权              修改价格目标或恢复失败轮次   不可变配置、受限多签、终态不可逆

  资金卡死                预言机长期不可用             ORACLE_PAUSED 与技术性退款路径

  Sybil                   多钱包拆分质押               每地址上限只能缓解，不能证明真人唯一

  舍入攻击                小额拆分改变权重             整数计算、明确 floor
                                                       规则、聚合地址余额
  -------------------------------------------------------------------------------------------

## 2. 必须保持的不变量

1.  `initialMinted <= 100亿 × TOKEN_SCALE`。
2.  `sum(roundRewardBudget[1..10]) == 75亿 × TOKEN_SCALE`。
3.  每轮 `rewardBudget == 7.5亿 × TOKEN_SCALE`。
4.  每轮价格目标等于 `P0 × 2^roundId`。
5.  一轮最多有12个有效 candle index。
6.  一个 candle index 最多成功计数一次。
7.  `qualifiedCandles` 不超过12。
8.  `qualifiedCandles >= 8` 才能通过。
9.  `qualifiedCandles <= 7` 且12根有效K线齐备，才可判市场失败。
10. 预言机故障不得触发本金销毁。
11. 成功轮次不得销毁本轮本金。
12. 失败轮次不得返还本轮本金。
13. 一笔 stake 不得同时被返还和销毁。
14. 一个 reward pool 不得被重复领取或重复销毁。
15. 失败轮次必须永久关闭。
16. 下一轮目标价不得因上一轮失败而重置。
17. 实际 burn 必须使 Jetton Master total_supply 减少。
18. 管理员不得更改已开始轮次的目标价、K线阈值或 oracle config hash。

## 3. 单元测试

### 3.1 价格公式

-   Round 1 = 2×P0。
-   Round 2 = 4×P0。
-   Round 10 = 1024×P0。
-   P0 为0时拒绝初始化。
-   超出整数位宽时拒绝初始化。

### 3.2 K线判定

-   8/12 达标：成功。
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

### 3.4 成功结算

-   质押本金总返还量等于已接受质押总量。
-   每个用户只能领取一次本金。
-   每个用户只能领取一次奖励。
-   权重总和为0时不能进入正常成功分配。
-   奖励总分配不超过7.5亿。
-   舍入余数留在奖励金库。
-   失败轮次不能领取奖励。

### 3.5 失败结算

-   失败时奖励 burn 金额精确等于7.5亿。
-   失败时质押 burn 金额精确等于 roundTotalStake。
-   两笔 burn ack 缺一不可。
-   重复 BurnAck 不会重复计账。
-   burn 消息 bounce 时可安全重试。
-   burn 未确认时轮次不得标记为最终失败。
-   失败终态不能重新打开。
-   下一轮价格目标保持原公式。

## 4. 集成测试

必须覆盖完整跨合约消息链： 1. 用户钱包 -\> 用户 Jetton Wallet -\>
StakingVault Jetton Wallet -\> StakingVault notification。 2.
StakingVault -\> RoundController stake ledger 更新。 3. Keeper -\>
OracleAdapter -\> RoundController candle 记录。 4. RoundController -\>
RewardVault/StakingVault burn request。 5. Vault owner -\> Jetton Wallet
burn。 6. Jetton Wallet -\> Jetton Master burn_notification。 7. Jetton
Master -\> RoundController BurnAck。 8. 用户 claim -\> Vault -\> Jetton
transfer -\> 用户 Jetton Wallet。

每个环节都要测试成功、bounce、重复消息、超时和重试。

## 5. 模糊测试与属性测试

建议对以下输入做 fuzz： - 随机 stake amount； - 随机 nonce； -
任意顺序提交 candle； - 重复和乱序消息； - 过期时间戳； -
极端价格数值； - 大额 totalStake； - 多轮并发消息； - 恶意构造
payload； - 任意 bounce 状态。

使用 property-based tests 检查第2节所有不变量。

## 6. 主网前安全要求

-   第三方智能合约安全审计。
-   Jetton Master/Wallet 及自定义 burn ack 扩展专项审计。
-   OracleAdapter 签名验证专项审计。
-   经济攻击模拟（低流动性拉盘、价格回落、预言机延迟）。
-   大额质押与失败销毁压力测试。
-   退款、返还、burn 和 claim 的消息追踪测试。
-   Testnet 完整演练至少覆盖一轮成功和一轮失败。
-   发布合约源码、编译版本、代码哈希和审计报告。
-   公开用户风险确认界面和不可逆损失说明。

## 7. 用户界面风险确认

质押 UI 必须在签名交易前显示： - 本轮目标价格； -
48小时/12根K线/至少8根达标规则； - 失败后奖励额度销毁； -
失败后本轮全部质押本金100%销毁； - 技术故障与市场失败的区别； -
该轮失败永久关闭； - 用户质押数量及预计承担的最大本金损失。

用户必须主动勾选风险确认，且确认版本写入链上 stake payload。
