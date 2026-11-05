# 02 --- 轮次状态机与结算流程

> **口径声明（V5）**：报名窗口 **72h**（上一轮结算后立即开启，无间隔）、观察窗口 48h、每轮奖励 7 亿、无人质押照常启动观察、0 人质押且通过 → 奖励销毁、团队每轮 1.2 亿由 TeamVault 释放/销毁、失败销毁三笔、奖励 pull claim（可跨轮累积）。与 `docs/00_DECISIONS_V2.md` 冲突时以其为准。

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

  `PREVIEW`                           **可选阶段**（仅 D-26 方案 B+ / D-27 建议）：结算后 24h 预告期，
                                      公布下一轮参数与倒计时；结束后自动做价格闸门检查再开窗
  ----------------------------------------------------------------------------------------

终态只允许
`SUCCEEDED`、`FAILED_PERMANENT`、`TECHNICAL_ABORTED`。普通管理员不得将终态改回活动状态。

> **PREVIEW（预告期）说明**：这是 D-27 建议方案引入的**可选阶段**（D-26 选 B+ 时配合使用），当前**未定案、不实现**。若采纳：结算后进入 PREVIEW（固定 24h，链上可验证：`previewEnd = settledAt + 24h`），前端显示倒计时与分享卡片；结束后自动做价格闸门检查，满足则进入 `STAKING_OPEN`，不满足则进入等待态（每 4h 检查、最长 7 天、超时提档）。管理员只能延后开轮（单次 ≤24h、累计 ≤7 天、链上公告事件），不能提前或跳过轮次。详见 docs/00 §7.8。

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
   | 本金返还/奖励可领取      | 奖励 7 亿+团队 1.2 亿+全部本金 burn
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

## 4. 质押窗口（V5：72 小时）

V5 已确认报名窗口为 **72 小时（259,200 秒）**，在**上一轮结算完成后立即开启**（无间隔）。

参数： - `stakeOpenAt` - `stakeCloseAt` - `stakeDuration` - `stakeGap` - `roundId` - `prevSettledAt`

时间定义：

``` text
stakeOpenAt  = prevSettledAt + STAKE_GAP_SECONDS      // STAKE_GAP_SECONDS = 0：结算后立即开启；R1 由项目方指定
stakeCloseAt = stakeOpenAt + STAKE_DURATION_SECONDS   // 报名窗口 72h
stakeDuration = stakeCloseAt - stakeOpenAt = 259,200  // 秒
```

规则： 1. 只有 `STAKING_OPEN` 状态接受新质押。 2. 当前链上时间必须满足
`stakeOpenAt <= now < stakeCloseAt`。 3.
质押窗口结束后，所有新质押都必须拒绝并退款。 4.
同一地址可多次质押，但每笔必须使用不同
nonce；合约将其聚合到该地址的总质押。 5.
若没有任何有效质押，**本轮照常启动并进入观察**（V3 已裁决，见 §4.2）；不跳过轮次、不延长窗口、不视为价格失败。
6. 第 1 轮的 `stakeOpenAt` 由项目方在 P0 冻结、配置校验通过后指定；之后各轮全部由上一轮结算时间推导，不人工指定。

### 4.1 方案 B+ 时间线与状态（Lead 建议，待 D-26 定案）

若项目方选定 docs/00 §7 的**方案 B+（Lead 推荐）**，在现有状态机基础上增加「等闸门」与「提前关窗」语义（**未定案前不实现**）：

``` text
T0  结算（SUCCEEDED / FAILED_PERMANENT；TeamVault 释放或销毁）
     |
     | PREVIEW 预告期 24h（可选，D-27 建议：公告 / 领奖 / 流动性调整 +
     |                        公布下一轮参数与倒计时 / 分享卡片）
     v
WAITING_GATE（新增概念）  每 4h 检查 1h TWAP
     |  TWAP <= target × 95%            | 满 7 天仍 > 95%
     v                                  v
STAKING_OPEN（最长 72h）          目标价提档到 P0×2^(n+1) → 再检查
     |  1h TWAP >= target → 提前关窗   | 到 72h → 正常关窗
     v
STAKING_CLOSED
     |  下一个 UTC 4h 边界
     v
OBSERVING（48h / 12 根，不缩短）
```

- 提前关窗只是「提前进入 STAKING_CLOSED」，**观察窗口仍为 48h / 12 根**。
- 24h 缓冲 / PREVIEW 预告期期间不开放新质押；领奖不受影响。
- 当前基线（D-26 未定案前）：结算后立即开启、报名 72h、关窗即观察（无 WAITING_GATE），见 §4/§5。

### 4.2 无人质押分支

1.  报名窗口关闭时 `totalAcceptedStake == 0`，仍进入 `STAKING_CLOSED` → `OBSERVING`。
2.  观察与判定与正常轮次一致（12 根 4 小时 K 线，≥8 根达标即通过）。
3.  **失败**：照常销毁本轮 7 亿奖励（无本金可销毁），进入 `FAILED_PERMANENT`。
4.  **通过**：奖励按质押比例分配；1 名质押人获得全部奖励；0 名质押人时本轮 **7 亿奖励销毁**（D-18b 已定：不回流、不留存、不补发）。

## 5. 48小时观察窗口的精确边界

V3 已确认：**报名窗口关闭即进入观察**，不额外等待、不做 4 小时边界取整。

定义： - `CANDLE_SECONDS = 14,400` - `CANDLE_COUNT = 12` -
`OBSERVATION_SECONDS = 172,800`

`observationStart = stakeCloseAt`

第 i 根K线（i从0开始）： -
`periodStart = observationStart + i × 14400` -
`periodEnd = periodStart + 14400`

第12根结束时间： `observationEnd = observationStart + 172800`

若主网要求 K 线对齐 UTC 4 小时边界：因间隔为 0，应在**结算时**让 `prevSettledAt` 落在 UTC 4h 边界（从而
`stakeOpenAt = prevSettledAt`、`stakeCloseAt = prevSettledAt + 72h` 自然对齐）；禁止在报名结束后对 `observationStart` 做 `ceil` 平移（会产生无观察数据的空窗）。

观察窗口必须使用12个连续完整区间。不得由前端或管理员任意指定起止时间。

> **条件分支（仅 D-26 选定方案 B+ 时）**：`observationStart` 改为**关窗后的下一个 UTC 4 小时边界**（此时允许并要求 ceil 对齐，因为报名可能触价提前关闭）；观察仍为 48h / 12 根。未定案前保持 `observationStart = stakeCloseAt`。

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

建议设置技术性终止阈值，例如连续暂停14天后，经预先定义的技术终止流程（owner 签名 + 公开证据/审计证明）触发
`TECHNICAL_ABORTED`：退还全部质押本金，不销毁奖励额度，轮次不得被错误标记为市场失败。该机制必须在部署前确认并审计。

## 8. 成功结算

进入 `SETTLING_SUCCESS` 后： 1. 禁止继续质押。 2. 固化
`totalStake`、用户 stake 账本及奖励权重快照。 3. 本金变为可领取状态。 4.
奖励池变为可领取状态（本轮 7 亿；**一次性发放、无归属期**，D-16/D-17 已确认）。 5. 用户主动调用 `claimPrincipal` / `claimReward`；奖励采用 **pull claim（D-25 已定）**：可带 roundId 列表或 `claimAll`，一次领走多轮，最多遍历 10 轮，合并为一笔转账，gas 由用户付。 6. 每个用户、每轮、每种领取类型均有独立幂等标记。 7.
**团队 1.2 亿立即转出**：RoundController 指令 **TeamVault** 转到团队收款钱包（D-20，无 cliff / 无线性；释放记录幂等）。 8.
全部操作完成后可标记 `SUCCEEDED`；采用 pull claim 时状态可先进入
`SUCCEEDED`，未领取余额继续留在金库。

## 9. 失败结算

进入 `SETTLING_FAILURE` 后： 1. 立即冻结该轮所有质押和奖励领取。 2.
冻结本轮用户 stake ledger。 3. 计算
`expectedStakeBurn = totalAcceptedStake`。 4. 请求销毁本轮 `700,000,000`
奖励（kind = `reward`）。 5. 指令 **TeamVault** 销毁本轮团队额度 `120,000,000`（kind = `team`）。 6. 请求销毁本轮全部已接受质押本金（kind = `principal`）。 7. 每个 burn 请求必须有唯一
`burnId`。 8. Jetton Master 确认供应量已减少后，向协议发送 burn
acknowledgement。 9. 协议核对**三笔**销毁金额和 burnId。 10.
全部销毁确认后，标记 `FAILED_PERMANENT`。 11. 下一轮按固定价格阶梯开放。

不得仅凭 keeper 的普通消息将状态直接改为 `FAILED_PERMANENT`。

## 10. 多阶段结算与幂等

TON 合约之间异步交互，不得假设多个合约可以在同一原子事务中完成。

每个外部动作均需： - 唯一 `operationId` 或 `burnId`； - 状态记录； -
重复消息检测； - 失败/退回处理； - 可重试流程； - 可查询的最终结果。

失败销毁推荐状态（每笔独立：reward / team / principal）：

`BURN_NOT_STARTED -> BURN_REQUESTED -> BURN_ACKED -> ROUND_FINALIZED`

同一个 `burnId` 重复到达时，必须返回已有结果，不得重复扣减或重复销毁。

## 11. 后续轮次

上一轮进入 `SUCCEEDED` 或 `FAILED_PERMANENT` 后，**立即开启下一轮报名**（间隔 0），报名窗口 72 小时。

失败轮次不会导致价格阶梯重置： - Round 1 失败，Round 2 目标仍为 4×P0。 -
Round 2 失败，Round 3 目标仍为 8×P0。 - 依此类推。

即使市场价格已高于下一轮目标，也必须完成该轮自己的报名窗口和完整 48 小时考核（该「现价已超目标价」问题列为 V5 待决策，见 docs/00 §7）。
