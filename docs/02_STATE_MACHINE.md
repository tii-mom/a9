# 02 --- 轮次状态机与结算流程

## 1. 状态定义

每轮独立状态：

  ----------------------------------------------------------------------------------------
  状态                                含义
  ----------------------------------- ----------------------------------------------------
  `UNOPENED`                          尚未开启

  `STAKING_OPEN`                      允许本轮质押

  `STAKING_CLOSED`                    质押窗口已关闭，等待观察开始

  `OBSERVING`                         正在收集12根4小时价格观察数据

  `ORACLE_PAUSED`                     预言机数据异常，价格考核暂停

  `SETTLING_SUCCESS`                  价格通过，正在处理本金返还和奖励领取状态

  `SETTLING_FAILURE`                  价格失败，正在提交奖励和质押本金销毁

  `SUCCEEDED`                         成功终态

  `FAILED_PERMANENT`                  失败永久关闭终态

  `TECHNICAL_ABORTED`                 经定义的技术性终止；不属于价格失败，不销毁用户本金
  ----------------------------------------------------------------------------------------

终态只允许
`SUCCEEDED`、`FAILED_PERMANENT`、`TECHNICAL_ABORTED`。普通管理员不得将终态改回活动状态。

## 2. 状态转移

``` text
UNOPENED
   |
   | openRound（必须满足上一轮已终态）
   v
STAKING_OPEN
   |
   | closeStaking（截止时间到）
   v
STAKING_CLOSED
   |
   | observationStart 到达
   v
OBSERVING
   |                         |
   | 有效12根，达标>=8        | 有效12根，达标<=7
   v                         v
SETTLING_SUCCESS       SETTLING_FAILURE
   |                         |
   | 本金返还/奖励可领取      | 奖励池+全部质押本金 burn
   v                         v
SUCCEEDED              FAILED_PERMANENT
```

预言机异常分支：

``` text
OBSERVING -> ORACLE_PAUSED -> OBSERVING
```

`ORACLE_PAUSED`
不得触发失败销毁。恢复时按本文件规定重新启动完整有效观察窗口，或走技术性终止退款流程。

## 3. 轮次顺序

-   Round 1 可在 P0 冻结、配置校验通过后开启。
-   Round n（n\>1）只有在 Round n-1 进入终态后才能开启。
-   上一轮成功或失败都不改变本轮目标价格公式。
-   不允许跳过未终态轮次。
-   不允许重开 `FAILED_PERMANENT` 轮次。

目标价：

`targetPrice[n] = P0 × 2^n`

轮次编号从1开始。

## 4. 质押窗口

建议默认质押期为7天，但该值尚未获用户确认，必须作为部署配置。

参数： - `stakeOpenAt` - `stakeCloseAt` - `stakeDuration` - `roundId`

规则： 1. 只有 `STAKING_OPEN` 状态接受新质押。 2. 当前链上时间必须满足
`stakeOpenAt <= now < stakeCloseAt`。 3.
质押窗口结束后，所有新质押都必须拒绝并退款。 4.
同一地址可多次质押，但每笔必须使用不同
nonce；合约将其聚合到该地址的总质押。 5.
若没有任何有效质押，不启动价格观察，不视为价格失败，不销毁奖励额度；应按预先配置的无参与者处理流程重新开放或等待项目方确认。此行为属于上线阻断参数。

## 5. 48小时观察窗口的精确边界

为避免部分K线和时区歧义，建议以 UTC 4小时边界对齐。

定义： - `CANDLE_SECONDS = 14,400` - `CANDLE_COUNT = 12` -
`OBSERVATION_SECONDS = 172,800`

质押关闭后，观察开始时间取不早于 `stakeCloseAt` 的下一个UTC 4小时边界：

`observationStart = ceil(stakeCloseAt / 14400) × 14400`

第 i 根K线（i从0开始）： -
`periodStart = observationStart + i × 14400` -
`periodEnd = periodStart + 14400`

第12根结束时间： `observationEnd = observationStart + 172800`

观察窗口必须使用12个连续完整区间。不得由前端或管理员任意指定起止时间。

## 6. K线计数

每根观察数据必须通过预言机验证，且必须与指定
`roundId`、`candleIndex`、`periodStart`、`periodEnd` 匹配。

若： - TWAP \>= 本轮目标价格； -
数据覆盖率、来源数、流动性、成交量及时间戳均通过配置校验；

则该根计为达标。

最终： `qualifiedCount = Σ (candleQualified[i] ? 1 : 0)`

-   `qualifiedCount >= 8`：进入 `SETTLING_SUCCESS`。
-   `qualifiedCount <= 7`：进入 `SETTLING_FAILURE`。

价格比较为包含等号，即 TWAP 恰好等于目标价也算达标。

## 7. 缺失数据与预言机故障

必须区分市场失败和数据/技术失败。

以下情况不得计入未达标K线，也不得触发销毁： - 预言机没有提交数据。 -
数据签名验证失败。 - 数据时间戳过期。 - 来源数不足。 -
价格源发生故障。 - TON 消息未成功交付。 -
协议合约或预言机合约出现可验证技术故障。

推荐处理： 1. 进入 `ORACLE_PAUSED`。 2.
禁止继续使用不完整窗口做市场失败判定。 3. 记录故障时间、最后有效 candle
和 oracle config hash。 4. 故障修复后，从新的UTC
4小时边界重新收集完整12根K线。 5. 不因预言机故障销毁质押本金或奖励额度。

建议设置技术性终止阈值，例如连续暂停14天后，经预先定义的多签/审计证明流程触发
`TECHNICAL_ABORTED`：退还全部质押本金，不销毁奖励额度，轮次不得被错误标记为市场失败。该机制必须在部署前确认并审计。

## 8. 成功结算

进入 `SETTLING_SUCCESS` 后： 1. 禁止继续质押。 2. 固化
`totalStake`、用户 stake 账本及奖励权重快照。 3. 本金变为可领取状态。 4.
奖励池变为可领取状态。 5. 用户主动调用 `claimPrincipal` 和
`claimReward`。 6. 每个用户、每轮、每种领取类型均有独立幂等标记。 7.
全部操作完成后可标记 `SUCCEEDED`；如果采用 pull claim，状态可先进入
`SUCCEEDED`，未领取余额继续留在金库。

## 9. 失败结算

进入 `SETTLING_FAILURE` 后： 1. 立即冻结该轮所有质押和奖励领取。 2.
冻结本轮用户 stake ledger。 3. 计算
`expectedStakeBurn = totalAcceptedStake`。 4. 请求销毁本轮 `750,000,000`
奖励。 5. 请求销毁本轮全部已接受质押本金。 6. 每个 burn 请求必须有唯一
`burnId`。 7. Jetton Master 确认供应量已减少后，向协议发送 burn
acknowledgement。 8. 协议核对两类销毁金额和 burnId。 9.
全部销毁确认后，标记 `FAILED_PERMANENT`。 10. 下一轮按固定价格阶梯开放。

不得仅凭 keeper 的普通消息将状态直接改为 `FAILED_PERMANENT`。

## 10. 多阶段结算与幂等

TON 合约之间异步交互，不得假设多个合约可以在同一原子事务中完成。

每个外部动作均需： - 唯一 `operationId` 或 `burnId`； - 状态记录； -
重复消息检测； - 失败/退回处理； - 可重试流程； - 可查询的最终结果。

失败销毁推荐状态：

`BURN_NOT_STARTED -> BURN_REQUESTED -> BURN_ACKED -> ROUND_FINALIZED`

同一个 `burnId` 重复到达时，必须返回已有结果，不得重复扣减或重复销毁。

## 11. 后续轮次

上一轮进入 `SUCCEEDED` 或 `FAILED_PERMANENT` 后，才允许开启下一轮。

失败轮次不会导致价格阶梯重置： - Round 1 失败，Round 2 目标仍为 4×P0。 -
Round 2 失败，Round 3 目标仍为 8×P0。 - 依此类推。

即使市场价格已高于下一轮目标，也必须完成该轮自己的质押窗口和完整48小时考核。
