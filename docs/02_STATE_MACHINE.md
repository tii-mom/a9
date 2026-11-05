# 02 --- 轮次状态机与结算流程

> **口径声明（V6.1）**：V6.1 已确认 D-28 同档重试、D-30 不做时间加权、质押上下限（10,000 A9 / 单地址≤10% / 本轮≤2 亿 A9）、技术终止（暂停14天或观察超时7天，任何人可触发，退100%本金、不消耗档位）。**观察 72h = 18 根 4h / 阈值 12（容错 6 根）**；**目标价开窗时锁定 `max(阶梯 P0×2^tier, 2×开窗 24h TWAP)`**、锁定后不可改；**取消 95% 闸门与 7 天提档**；**24h PREVIEW 预告期已确认**，结算→预告→自动开窗；保留触价提前关窗；时间线单轮 7 天 / 10 轮 70 天；P0 = $0.00116；分配 70/8+5/12/5；**不允许取消质押（仅技术终止退本金）**；奖励 pull claim。与 `docs/00_DECISIONS_V2.md` 冲突时以其为准。

## 1. 状态定义

每轮独立状态：

  ----------------------------------------------------------------------------------------
  状态                                含义
  ----------------------------------- ----------------------------------------------------
  `UNOPENED`                          尚未开启

  `STAKING_OPEN`                      允许本轮质押

  `STAKING_CLOSED`                    质押窗口已关闭，等待观察开始

  `OBSERVING`                         正在收集18根4小时价格观察数据

  `ORACLE_PAUSED`                     预言机数据异常，价格考核暂停

  `SETTLING_SUCCESS`                  价格通过，正在处理本金返还和奖励领取状态

  `SETTLING_FAILURE`                  价格失败，正在提交奖励和质押本金销毁

  `SUCCEEDED`                         成功终态

  `FAILED_PERMANENT`                  失败永久关闭终态

  `TECHNICAL_ABORTED`                 经定义的技术性终止；不属于价格失败，不销毁用户本金

  `PREVIEW`                           **V6 已确认阶段**：结算后固定 24h 预告期，公布下一轮参数与倒计时；
                                      结束后**自动开窗**（无价格闸门），开窗交易锁定目标价
  ----------------------------------------------------------------------------------------

终态只允许
`SUCCEEDED`、`FAILED_PERMANENT`、`TECHNICAL_ABORTED`。普通管理员不得将终态改回活动状态。

> **V6 已确认**：① 观察窗口固定 **18 根 / 72h / 12 阈值（容错 6 根）**；② **不允许取消质押**——状态机没有 cancel/withdraw 通道，唯一退款路径是 `TECHNICAL_ABORTED`（退还全部本金）。

> **PREVIEW（预告期）说明（V6 已确认）**：结算后进入 **PREVIEW（固定 24h，链上可验证：`previewEnd = settledAt + 24h`）**，前端展示「距离下一轮质押开始」倒计时与分享卡片；期间不许质押；**结束后自动进入 `STAKING_OPEN`（无价格闸门）**，并在开窗交易中锁定目标价。**95% 闸门、7 天等待/提档已取消。**

## 2. 状态转移

``` text
UNOPENED
   |
   | openRound（必须满足上一轮已终态）
   v
SUCCEEDED / FAILED_PERMANENT
   |
   | PREVIEW 24h（V6 已确认：公布下一轮参数与倒计时）
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
   | 有效18根，达标>=12        | 有效18根，达标<=11（18 根齐备即判定，无中间态）
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

目标价（**V6 定稿**）：

`target = max(P0 × 2^tier, 2 × 开窗时 24h TWAP)`

- **开窗交易中计算并锁定**，锁定后本轮不可改；`tier` 为档位（当前基线 tier = 轮次，D-28 若采纳改为「1 + 已成功轮数」）。
- 合约不预存 10 轮价格；只存 P0、倍数（不可变）、档位计数与每轮 `target_price`；锁定后发出 `TargetPriceSet` 事件。
- **V6 已取消**：95% 开窗闸门、每 4h 检查、最长 7 天等待、超时提档。
- **保留触价提前关窗**：报名期内 1h TWAP ≥ 目标价 → 立即关窗进入观察。

> **D-28 已确认（V6.1）：成功升档、失败同档重试**——
> 本轮成功 → 下一轮目标升到下一档 `P0 × 2^(tier+1)`；本轮失败 → 下一轮**沿用同一目标价**。
> 例：R3 目标 $0.008 失败 → R4 仍是 $0.008。由此引入「**档位 tier = 1 + 已成功轮数**」概念，10 轮 ≠ 10 档位（失败占轮次）。
> **状态机实现**：失败轮 `tier` 不变、下一轮沿用同一目标档；成功轮 `tier += 1`；前端按「档位」展示。

## 4. 质押窗口（V6：24h 预告 + 72h 报名）

V6 已确认：上一轮结算后进入 **24 小时预告期（PREVIEW）**，预告结束**自动开窗**；报名窗口 **72 小时（259,200 秒）**。

参数： - `stakeOpenAt` - `stakeCloseAt` - `stakeDuration` - `stakeGap` - `roundId` - `prevSettledAt`

时间定义：

``` text
previewEnd   = prevSettledAt + PREVIEW_SECONDS        // 24h 预告期（V6）
stakeOpenAt  = previewEnd                             // 预告结束自动开窗
stakeCloseAt = stakeOpenAt + STAKE_DURATION_SECONDS   // 报名窗口 72h（触价可提前关窗）
stakeDuration = stakeCloseAt - stakeOpenAt = 259,200  // 秒
```

规则： 1. 只有 `STAKING_OPEN` 状态接受新质押。 2. 当前链上时间必须满足
`stakeOpenAt <= now < stakeCloseAt`。 3.
质押窗口结束后，所有新质押都必须拒绝并退款。 4.
同一地址可多次质押，但每笔必须使用不同
nonce；合约将其聚合到该地址的总质押。 5.
若没有任何有效质押，**本轮照常启动并进入观察**（V3 已裁决，见 §4.2）；不跳过轮次、不延长窗口、不视为价格失败。
6. 第 1 轮的 `stakeOpenAt` 由项目方在 P0 冻结、配置校验通过后指定；之后各轮全部由上一轮结算时间推导，不人工指定。

### 4.1 V6 时间线与状态（已定稿）

``` text
T0  结算（SUCCEEDED / FAILED_PERMANENT；TeamVault 释放或销毁；进入领取）
     |
     | PREVIEW 预告期 24h（公布下一轮参数 + 三个倒计时；期间不许质押）
     v
STAKING_OPEN（自动开窗；开窗交易锁定 target = max(阶梯, 2×24h TWAP)）
     |  1h TWAP >= target → 触价提前关窗
     |  到 72h → 正常关窗
     v
STAKING_CLOSED
     |
     | observationStart = stakeCloseAt
     v
OBSERVING（18 根 / 72h，不缩短）
     |
     | qualified >= 12 成功 / <= 6 失败（18 根齐备）
     v
SETTLING_SUCCESS / SETTLING_FAILURE
```

- **无价格闸门、无 7 天等待/提档**（V6 取消）。
- 提前关窗只是「提前进入 STAKING_CLOSED」，**观察窗口仍为 72h / 18 根**。
- PREVIEW 期间不开放新质押；领奖不受影响。
- 前端三个倒计时：距下一轮质押开始 / 距质押结束 / 距判定。

### 4.2 无人质押分支

1.  报名窗口关闭时 `totalAcceptedStake == 0`，仍进入 `STAKING_CLOSED` → `OBSERVING`。
2.  观察与判定与正常轮次一致（18 根 4 小时 K 线，≥12 根达标即通过）。
3.  **失败**：照常销毁本轮 7 亿奖励（无本金可销毁），进入 `FAILED_PERMANENT`。
4.  **通过**：奖励按质押比例分配；1 名质押人获得全部奖励；0 名质押人时本轮 **7 亿奖励销毁**（D-18b 已定：不回流、不留存、不补发）。

## 5. 72 小时观察窗口的精确边界（V6）

V6 已确认：**报名窗口关闭即进入观察**（提前关窗则从提前关窗时刻开始），不做 4 小时边界取整。

定义： - `CANDLE_SECONDS = 14,400` - `CANDLE_COUNT = 18` -
`OBSERVATION_SECONDS = 259,200`

`observationStart = stakeCloseAt`

第 i 根K线（i从0开始）： -
`periodStart = observationStart + i × 14400` -
`periodEnd = periodStart + 14400`

第18根结束时间： `observationEnd = observationStart + 259200`

主网如要求 K 线对齐 UTC 4 小时边界，应在**结算时**让 `prevSettledAt` 落在 UTC 4h 边界（从而
`previewEnd = prevSettledAt + 24h` 也落在边界）；**不得对 `observationStart` 做额外 `ceil` 平移**（会产生空窗），提前关窗时同样以实际关窗时刻为观察起点。

观察窗口必须使用 18 个连续完整区间。不得由前端或管理员任意指定起止时间。

## 6. K线计数

每根观察数据必须通过预言机验证，且必须与指定
`roundId`、`candleIndex`、`periodStart`、`periodEnd` 匹配。

若： - TWAP \>= 本轮目标价格； -
数据覆盖率、来源数、流动性、成交量及时间戳均通过配置校验；

则该根计为达标。

最终： `qualifiedCount = Σ (candleQualified[i] ? 1 : 0)`

-   `qualifiedCount >= 12`：进入 `SETTLING_SUCCESS`。
-   `qualifiedCount <= 6`：进入 `SETTLING_FAILURE`。

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
4小时边界重新收集完整18根K线。 5. 不因预言机故障销毁质押本金或奖励额度。

**V6.1 已确认（技术终止）**：**连续暂停 14 天** 或 **观察结束超时 7 天** → **任何人**可触发 `TECHNICAL_ABORTED`：退还 **100% 本金**，**不销毁奖励/团队额度**，**不消耗档位**；轮次不得被标记为市场失败。该逻辑需审计。

> **V5.3 已确认**：**质押不可取消**；`TECHNICAL_ABORTED` 是**唯一**退还本金的路径（退款不经管理员手工操作、不可提前触发）。

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

上一轮进入 `SUCCEEDED` 或 `FAILED_PERMANENT` 后，进入 **24h PREVIEW 预告期**，随后**自动开窗**；报名窗口 72 小时。**单轮 7 天，10 轮 70 天。**

失败轮次不会导致价格阶梯重置： - Round 1 失败，Round 2 目标仍为 4×P0。 -
Round 2 失败，Round 3 目标仍为 8×P0。 - 依此类推。

> **D-28 已确认（V6.1）**：Round 1 失败 → Round 2 **同档**（目标按 `max(阶梯, 2×开窗 TWAP)` 重新锁定，但 tier 不变）；只有成功才升到下一档。

V6 目标价已含「2× 开窗 24h TWAP」下限，价格高于阶梯时目标随之上移，不再依赖外部闸门。