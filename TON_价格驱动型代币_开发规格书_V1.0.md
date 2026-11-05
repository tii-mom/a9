# TON 价格驱动型代币协议 --- 智能合约开发规格书 V1.0

> 本文档由分册规格合并而成。上线阻断项必须在主网部署前确认。

------------------------------------------------------------------------

# TON 价格驱动型代币协议：开发文档包

**版本：** V1.0 Draft\
**日期：** 2026-11-04\
**目标网络：** TON\
**文档语言：** 中文\
**用途：** 产品、合约、前端、预言机、测试和审计团队的共同实现基线

> 本包是可进入工程实现阶段的技术规格草案，不是已经审计的生产代码。凡标记为"上线阻断项"的参数，必须在主网部署前由项目方书面确认并写入不可随意修改的链上配置。

## 1. 已确认的业务规则

  -------------------------------------------------------------------------------------------------
  项目                                已确认规则
  ----------------------------------- -------------------------------------------------------------
  初始发行量                          100亿枚

  内盘及流动性                        10% = 10亿枚

  营销推广                            5% = 5亿枚

  团队                                10% = 10亿枚

  目标解锁奖励                        75% = 75亿枚

  解锁轮数                            10轮

  每轮奖励预算                        7.5亿枚

  价格阶梯                            每轮目标较上一轮翻倍

  第n轮目标                           P0 × 2\^n，n从1开始

  观察期                              连续48小时

  K线周期                             4小时，共12根

  通过条件                            12根中至少8根有效K线达到或超过目标价

  失败处理                            永久关闭该轮；销毁本轮7.5亿奖励额度及该轮全部已接受质押本金

  后续轮次                            按原定阶梯继续，不回滚、不补发、不重开失败轮次
  -------------------------------------------------------------------------------------------------

## 2. 关键技术原则

1.  用户质押资产必须实际转入协议控制的 Jetton
    Wallet；不得假设合约可以从用户个人钱包强制扣款。
2.  价格数据必须来自可验证的预言机/签名数据源；普通网页 API
    或单一后台数据库不能直接作为链上最终裁决依据。
3.  TON
    合约间通过异步消息交互。质押入账、返还、销毁和奖励支付必须采用可重试、幂等的多阶段结算。
4.  失败销毁必须是实际 Jetton burn，并确认 Jetton Master 的 total_supply
    已减少；不能仅把余额记为"不可用"就宣称已销毁。
5.  合约不得遍历全体用户进行批量派发。采用用户主动领取（pull
    claim）模式。
6.  任何预言机故障、数据缺失或合约技术故障，不得伪装成价格考核失败并销毁本金。
7.  用户质押前必须明确确认"本轮失败时，本轮全部质押本金可能100%销毁"。

## 3. 文档目录

-   `docs/01_TOKENOMICS.md`：发行分配、价格阶梯、质押及奖励计算。
-   `docs/02_STATE_MACHINE.md`：轮次状态机、时间边界、成功/失败流程。
-   `docs/03_ORACLE_SPEC.md`：价格源、TWAP、K线数据格式及故障处理。
-   `docs/04_CONTRACT_ABI.md`：合约模块、存储结构、消息接口及伪代码。
-   `docs/05_SECURITY_TESTS.md`：威胁模型、不变量、测试用例及审计要求。
-   `docs/06_DEPLOYMENT.md`：开发、测试网、主网部署与运维流程。
-   `docs/07_OPEN_DECISIONS.md`：上线阻断项及建议默认值。
-   `docs/08_REFERENCES.md`：TON 官方技术资料。

根目录另含合并版 `TON_价格驱动型代币_开发规格书_V1.0.md`。

## 4. 规范用语

-   **MUST / 必须**：实现不可违反的要求。
-   **SHOULD / 应当**：强烈建议，偏离时必须记录原因。
-   **MAY / 可以**：可选实现。
-   **上线阻断项**：未确认前可以开发接口和测试桩，但不得部署主网或开放真实质押。
-   **建议参数**：供项目方决策，不代表已获确认。

## 5. 推荐技术栈

截至本文日期，TON 官方文档推荐使用 Tolk 编写智能合约，并推荐 Acton
作为合约开发、构建、测试和部署工具链。团队可以采用其他成熟工具，但必须锁定编译器、工具链和依赖版本，并在
CI 中可重复构建。

## 6. 核心风险提示

本协议具有极高风险：市场考核失败将导致参与该轮的用户损失全部质押本金。价格翻倍阶梯也意味着第10轮目标为初始参考价的1024倍。该机制不保证价格上涨、不保证奖励实现，也不能保证防止抛售或操纵。

本文件不能替代法律意见、经济模型审查、智能合约审计或市场操纵风险评估。

------------------------------------------------------------------------

# 01 --- 代币经济与业务规则

## 1. 目标与范围

本文定义代币供应、分配、价格目标、每轮奖励预算、质押本金和失败销毁的业务规则。合约实现必须以本文件和经项目方签署的最终参数表为准。

## 2. 初始供应量与分配

初始发行量固定为：

`INITIAL_SUPPLY = 10,000,000,000 tokens`

  分配类别             占比     人类可读数量
  ------------------ ------ ----------------
  内盘及流动性          10%    1,000,000,000
  营销推广               5%      500,000,000
  团队                  10%    1,000,000,000
  十轮目标解锁奖励      75%    7,500,000,000
  合计                 100%   10,000,000,000

每轮社区奖励预算：

`ROUND_REWARD = 750,000,000 tokens`

十轮预算合计：

`10 × 750,000,000 = 7,500,000,000 tokens`

### 2.1 精度与原始单位

Jetton decimals 尚未由项目方确认。所有合约内部计算必须使用整数 raw
units，不得使用浮点数。

定义：

`TOKEN_SCALE = 10 ^ TOKEN_DECIMALS`

`raw_amount = human_amount × TOKEN_SCALE`

建议评估 `TOKEN_DECIMALS = 9`，但这是上线阻断项，必须在 Jetton Master
部署前确认。部署后不得更改精度。

### 2.2 初始铸造与分仓

建议一次性铸造固定总量，并转入公开、可验证的分配金库。75亿奖励额度应在
RewardVault 中按轮次记账，每轮7.5亿。

分仓建议： - Liquidity/Initial Distribution Vault：10亿。 - Marketing
Treasury：5亿。 - Team Vesting Vault：10亿。 - Community Reward
Vault：75亿。

如果项目方选择先铸造后分配，必须提供完整的链上资金流和地址清单。关闭
mint 权限或将其不可逆地移交至受约束的控制机制，是主网部署前的必要决策。

## 3. 价格目标

设 `P0` 为固定初始参考价格，`n` 为轮次编号（1至10）：

`targetPrice[n] = P0 × 2^n`

    轮次      目标价      奖励预算
  ------ ----------- -------------
       1      2 × P0   750,000,000
       2      4 × P0   750,000,000
       3      8 × P0   750,000,000
       4     16 × P0   750,000,000
       5     32 × P0   750,000,000
       6     64 × P0   750,000,000
       7    128 × P0   750,000,000
       8    256 × P0   750,000,000
       9    512 × P0   750,000,000
      10   1024 × P0   750,000,000

目标价格只在部署时根据已确认的 P0 和公式写入，之后不可由管理员任意修改。

价格建议使用固定点整数，例如 `USD_PRICE_SCALE = 10^8`。`P0`、TWAP
和目标价格均以同一精度保存。比较时使用整数比较，不使用浮点数。

## 4. P0 初始参考价格

P0 的计算方法尚未确认，是上线阻断项。

建议方案： 1. 代币在指定的合格市场完成初始流动性部署。 2.
观察一个预先公布的基准期（建议7×24小时）。 3.
使用预先公布的多个市场数据计算聚合 TWAP。 4.
过滤流动性不足、异常成交量和价格离群的市场。 5. 由预言机签名并将
P0、数据区间、来源列表摘要和配置哈希写入链上。 6. P0
一旦冻结，十轮目标均由公式计算，不允许人工重设。

不得在看到市场表现后选择有利于项目方的时间点追溯确定 P0。

## 5. 每轮质押

每轮质押独立记账。用户必须在对应轮次质押窗口内，将本项目 Jetton 转入对应
StakingVault，才具备本轮奖励资格。

### 5.1 质押资金的控制权

-   质押必须通过 Jetton Transfer 将代币实际转入 StakingVault 所拥有的
    Jetton Wallet。
-   合约不得也不能任意从用户个人 Jetton Wallet 中扣币。
-   只有成功完成转账、并被 StakingVault 验证入账的数量才算"已接受质押"。
-   用户必须在转账 payload 中明确携带风险确认字段。
-   不符合条件或无法识别的转账，应进入退款流程，不得默默记入质押。

### 5.2 用户风险确认

每笔质押 payload 至少包含： - `round_id` - `deposit_nonce` -
`risk_disclosure_version` - `accept_full_principal_burn = true`

如果风险确认版本不匹配或 `accept_full_principal_burn` 不是
true，StakingVault 不得接受该笔质押，必须按退款流程处理。

### 5.3 质押锁定

质押窗口关闭后，用户不能追加、转移或提前提取该轮质押本金。资金一直锁定至本轮完成成功或失败结算。

-   本轮成功：本金可按成功结算规则领取返还。
-   本轮价格考核失败：该轮全部已接受质押本金销毁。
-   技术性预言机故障：不得按价格失败处理；按 `03_ORACLE_SPEC.md`
    的暂停/恢复规则执行。

## 6. 48小时价格考核

48小时由12个连续的完整4小时观察区间构成。

-   4小时长度：14,400秒。
-   48小时长度：172,800秒。
-   合格K线数量阈值：8。
-   判定条件：`qualified_candles >= 8`。
-   每根K线达标条件：该区间的有效 TWAP `>= targetPrice`。

K线不要求连续达标；只要求同一观察窗口内至少8根达标。

观察窗口必须由12个完整4小时区间组成，不得使用部分K线。

## 7. 成功时的资金处理

本轮成功后： 1. 本轮状态进入 `SUCCEEDED`。 2.
本轮7.5亿奖励预算开放给符合资格的质押用户。 3.
本轮质押本金不销毁，用户可按成功结算规则领取返还。 4.
奖励按已冻结的权重公式计算，采用用户主动领取。 5.
奖励领取、质押本金返还均需有独立的幂等状态记录。

### 7.1 奖励分配公式：待项目方最终确认

为了让开发团队能够先搭建接口，V1.0
可暂用以下"按有效质押数量比例分配"的默认算法：

`weight[user] = acceptedStake[user]`

`totalWeight = Σ weight[user]`

`reward[user] = floor(ROUND_REWARD × weight[user] / totalWeight)`

注意： - 这是开发建议，不是用户已明确确认的最终奖励算法。 - 如果需要结合
AI
对战、数学赏金题或其他社区贡献，应另行定义可验证的贡献积分、反作弊和权重公式。 -
不得在轮次结束后临时更改公式。 -
合约不应尝试遍历全部用户进行派发；用户调用 `claimReward` 自行领取。 -
舍入余数保留在奖励金库，不自动转移到其他轮次，也不应被管理员提走。

**上线阻断：**
项目方必须确认最终奖励算法、每地址上限、最低质押量及是否引入贡献积分。

## 8. 失败时的资金处理

若12根有效K线中达标数量少于8根，则本轮市场考核失败。

本轮销毁量：

`burnAmount = ROUND_REWARD + roundTotalAcceptedStake`

其中： - `ROUND_REWARD = 750,000,000 tokens` - `roundTotalAcceptedStake`
为该轮所有已接受质押本金之和。

失败后的强制规则： - 本轮奖励额度永久销毁。 -
本轮全部已接受质押本金永久销毁。 - 本轮永久标记为 `FAILED_PERMANENT`。 -
本轮不得重新开放、不得重试、不得补发、不得由管理员恢复。 -
其他轮次、其他轮次质押、历史已归属奖励不受影响。 -
下一轮继续使用原定价格阶梯。

### 8.1 后续轮次价格不回滚

例如第一轮失败，第二轮目标仍为 `4 × P0`，而不是重设为 `2 × P0`。

下一轮必须等上一轮完成终态结算后才可开启。若价格已高于下一轮目标，仍须按下一轮自己的质押窗口和完整48小时考核流程执行。

## 9. 供应量不变量

合约及链下监控必须持续验证：

1.  初始铸造总量不超过100亿枚。
2.  十轮奖励预算总和严格等于75亿枚。
3.  单轮奖励预算始终为7.5亿枚。
4.  任一轮奖励最多销毁一次。
5.  任一笔质押本金最多返还一次或销毁一次，不可同时发生。
6.  成功轮次质押本金总返还量应等于该轮已接受质押总量。
7.  失败轮次质押本金销毁量应等于该轮已接受质押总量。
8.  失败轮次奖励销毁量应等于7.5亿枚。
9.  销毁必须反映在 Jetton Master 的 `total_supply` 下降中。
10. 已销毁代币不得重新铸造或从其他金库补回。

------------------------------------------------------------------------

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

------------------------------------------------------------------------

# 03 --- 价格预言机与K线验证规格

## 1. 目标

价格预言机决定每轮能否通过考核，是协议最关键的外部依赖。任何单一项目方后台、单一交易池或单笔交易都不得直接决定解锁结果。

TON 官方文档说明，链上合约需要通过预言机将外部数据带入链上；在 TON
的异步执行模型下，常见模式为请求-响应（pull）流程。具体预言机服务商和价格源必须由项目方在上线前选定。

## 2. 价格单位

建议采用 USD 计价。

固定点精度建议： `USD_PRICE_SCALE = 100,000,000`

例如，真实价格为 USD 0.01234567，则： `priceUsdE8 = 1,234,567`

所有价格均使用无符号整数，禁止浮点数。

## 3. 价格源配置

上线前必须确定： - `feedId` - 代币交易对（例如 TOKEN/USD 或 TOKEN/USDT
加独立 USD 兑换率） - 价格源/交易市场白名单 - 最少有效数据源数量 -
最低池子流动性 - 最低观察区间成交量 - 允许的最大来源偏差 -
4小时数据覆盖率阈值 - 数据最大延迟 - 签名验证合约地址 - oracle config
version/hash

建议至少使用多个独立来源，并采用中位数或经过审计的加权中位数聚合。若市场结构无法满足来源数量，应先设计明确的单源风险披露和额外保护，不得假称"多源去中心化"。

## 4. 4小时TWAP定义

每个4小时区间对应一份聚合数据。

单一市场的时间加权平均价格可表示为：

`TWAP = Σ(price_j × duration_j) / Σ(duration_j)`

其中： - `price_j` 是该区间内某个有效采样价格； - `duration_j`
是该价格代表的时间长度； - 覆盖范围必须属于该4小时区间。

聚合器必须： 1. 仅使用白名单市场。 2. 验证每个市场在区间内有足够流动性。
3. 排除异常成交、短暂价格尖峰和明显离群源。 4. 验证采样覆盖率。 5.
计算每个来源的4小时TWAP。 6. 根据已锁定规则聚合为最终 `twapPriceUsdE8`。
7. 输出来源数量、成交量、流动性和数据摘要。

不能用K线最高价、单笔成交价或瞬时价格代替TWAP。

## 5. Oracle Candle 数据结构

每根K线的数据至少包含：

``` text
OracleCandle {
    roundId: uint8
    candleIndex: uint8          // 0..11
    periodStart: uint64         // UTC Unix seconds
    periodEnd: uint64
    twapPriceUsdE8: uint128
    volumeUsdE8: uint128
    liquidityUsdE8: uint128
    validSourceCount: uint16
    coverageBps: uint16
    feedId: uint32
    oracleConfigVersion: uint32
    dataDigest: uint256
    nonce: uint64
    validUntil: uint64
}
```

`coverageBps` 以 10,000 为100%。最低覆盖率由配置决定。

## 6. 提交与验证流程

推荐使用可验证签名的 pull-oracle 流程：

1.  链下聚合器从预先公布的市场收集价格数据。
2.  聚合器计算完整4小时TWAP和质量指标。
3.  数据提供方对 `OracleCandle` 摘要签名。
4.  任意 keeper 或用户可以提交该数据，不应只有项目方单一后台有权提交。
5.  协议向 OracleAdapter 发出验证请求，或调用已经验证签名的适配器接口。
6.  OracleAdapter 检查签名、feedId、时间范围、有效期和配置版本。
7.  RoundController 检查发送方是否为指定 OracleAdapter。
8.  验证成功后，记录该 candle，并按阈值计数。

任何用户都可以提交有效数据，但不能提交未签名、过期或属于其他轮次的数据。

## 7. 重放与重复提交保护

必须验证： - `roundId` 与当前轮次一致。 - `candleIndex` 在0至11之间。 -
`periodStart` 和 `periodEnd` 精确匹配预期时间区间。 - `nonce` 未使用。 -
`dataDigest` 未处理。 - 当前 candle index 尚未成功记录。 - `validUntil`
未过期。 - `feedId` 与配置一致。 - `oracleConfigVersion`
与本轮冻结版本一致。

同一 candle 的重复提交应幂等返回，不得重复增加 `qualifiedCount`。

## 8. 数据质量阈值

以下参数尚未确定，属于上线阻断项：

  参数                         说明
  ---------------------------- -------------------
  `MIN_VALID_SOURCES`          最少有效来源数
  `MIN_LIQUIDITY_USD`          最低流动性
  `MIN_VOLUME_USD_4H`          每4小时最低成交量
  `MAX_SOURCE_DEVIATION_BPS`   来源间最大偏差
  `MIN_COVERAGE_BPS`           TWAP数据覆盖率
  `MAX_DATA_AGE_SECONDS`       数据最大延迟
  `MAX_VALIDITY_SECONDS`       签名数据有效期限

不得在观察窗口开始后修改这些参数。

## 9. P0 计算

P0 的最终算法仍需项目方确认。建议： - 预先公布初始观察期； -
采用多个合格来源的聚合TWAP； - 公开所有来源、观察时间和聚合算法； - 将
P0 和 config hash 写入链上； - P0 冻结后不得回溯修改。

## 10. 故障处理

以下情况进入 `ORACLE_PAUSED`： - 签名验证服务不可用； -
有效来源数不足； - 数据过期或缺失； - 观察区间时间戳不匹配； -
价格源被暂停或存在异常； - OracleAdapter 消息未能成功完成。

暂停期间： - 不增加达标K线数量； - 不把缺失数据当成未达标K线； -
不触发失败销毁； - 记录暂停原因和链上事件。

恢复时建议重新开始完整12根K线窗口，以免混合不同数据配置或不完整观察区间。

## 11. 防操纵建议

-   价格来源多样化。
-   最低流动性与成交量阈值。
-   4小时TWAP而非瞬时价格。
-   对来源偏差进行过滤。
-   不允许项目方在窗口中更换价格源。
-   每个窗口冻结 oracle config hash。
-   对异常成交、闪电贷影响和单池价格偏移进行监控。
-   公布可复核的价格数据摘要。

TWAP只能提高操纵成本，不能保证市场价格无法被操纵。

------------------------------------------------------------------------

# 04 --- 智能合约架构、存储与消息接口

## 1. 推荐架构

建议采用模块化合约，避免单一合约承担全部逻辑。

``` text
                 +----------------------+
                 |      Jetton Master   |
                 | supply / burn / meta |
                 +----------+-----------+
                            |
                  TEP-74 Jetton Wallets
                            |
          +-----------------+------------------+
          |                                    |
+---------v----------+              +----------v---------+
|   StakingVault     |              |    RewardVault     |
| round stake ledger |              | 10 x reward pools  |
+---------+----------+              +----------+---------+
          |                                    |
          +----------------+-------------------+
                           |
                 +---------v----------+
                 |   RoundController  |
                 | state / target /   |
                 | candle count       |
                 +---------+----------+
                           |
                 +---------v----------+
                 |    OracleAdapter   |
                 | signature / feed   |
                 +--------------------+

Optional:
+------------------------+
| ContributionRegistry   |
| AI/math/community score|
+------------------------+
```

## 2. 合约模块

### 2.1 Jetton Master / Jetton Wallet

职责： - 遵循 TEP-74 兼容的 Jetton 交互。 - 保存 total_supply 和
metadata。 - 管理对应 Jetton Wallet。 - 接收 `burn_notification` 并减少
total_supply。 - 若协议需要链上确认销毁完成，建议在项目自有 Jetton
实现中增加受审计的 burn acknowledgement 扩展。

重要：标准 Jetton 结构为 Master + 每个持币者对应的
Wallet。协议不得假设用户代币余额集中在 Master 合约。

### 2.2 RoundController

职责： - 保存 P0、目标价公式和轮次状态。 - 开启/关闭轮次。 -
记录观察窗口时间和12根K线结果。 - 统计达标数量。 - 进入成功/失败结算。 -
验证后续轮次只能按顺序开启。 - 接收 RewardVault、StakingVault 和 Jetton
Master 的结算确认。

### 2.3 StakingVault

职责： - 接收本项目 Jetton。 - 验证 Jetton Wallet 来源。 - 验证
roundId、nonce 和风险确认 payload。 - 记录每轮每个用户的质押本金。 -
关闭质押后冻结 ledger。 - 成功时允许用户领取本金。 -
失败时将本轮全部本金提交 burn。 - 处理退款、重复消息和失败重试。

### 2.4 RewardVault

职责： - 持有75亿社区奖励。 - 维护十轮独立的750,000,000奖励账本。 -
成功时允许符合资格的用户领取。 - 失败时销毁对应轮次的7.5亿奖励。 -
不允许将失败轮次额度转移到其他轮次。

### 2.5 OracleAdapter

职责： - 验证价格数据签名或对接可信预言机合约。 - 验证
feedId、有效期、nonce、配置版本。 - 向 RoundController 提供经过验证的
Candle 结果。 - 防止未授权来源伪造数据。

### 2.6 ContributionRegistry（可选）

如果未来采用AI对战、数学赏金题或社区任务积分，则使用独立模块保存经过验证的贡献分数。

不得在第一版中未经定义就将链下积分直接当作链上奖励权重。

## 3. 推荐存储结构

以下为逻辑结构，实际 Tolk cell/dictionary 布局由开发团队优化。

``` text
ProtocolConfig {
    jettonMaster: address
    jettonWalletOfStakingVault: address
    jettonWalletOfRewardVault: address
    roundController: address
    oracleAdapter: address
    p0UsdE8: uint128
    tokenDecimals: uint8
    roundRewardRaw: uint128
    candleSeconds: uint32       // 14400
    candleCount: uint8          // 12
    minQualifiedCandles: uint8  // 8
    oracleConfigHash: uint256
    configVersion: uint32
}

RoundData {
    roundId: uint8
    targetPriceUsdE8: uint128
    rewardBudgetRaw: uint128
    status: uint8
    stakeOpenAt: uint64
    stakeCloseAt: uint64
    observationStart: uint64
    observationEnd: uint64
    candlesSeen: uint8
    qualifiedCandles: uint8
    totalAcceptedStakeRaw: uint128
    totalRewardWeight: uint128
    oracleConfigVersion: uint32
    failureBurnId: uint256
    rewardBurnConfirmed: bool
    stakeBurnConfirmed: bool
}

StakePosition {
    owner: address
    amountRaw: uint128
    rewardWeight: uint128
    principalClaimed: bool
    rewardClaimed: bool
    lastDepositNonce: uint64
}

CandleRecord {
    periodStart: uint64
    periodEnd: uint64
    twapPriceUsdE8: uint128
    qualified: bool
    dataDigest: uint256
}
```

建议使用字典按 `roundId`、`owner` 和 `candleIndex`
索引。不要把无限增长的用户数组放入单个 cell，也不要在链上进行无界遍历。

## 4. Jetton 质押入账

用户通过 Jetton Transfer 将代币转入 StakingVault 的 Jetton Wallet，并在
`forward_payload` 中附带协议 payload。

建议 payload：

``` text
StakePayload {
    op: uint32                  // STAKE_DEPOSIT
    version: uint8
    roundId: uint8
    depositNonce: uint64
    riskDisclosureVersion: uint16
    acceptFullPrincipalBurn: bool
}
```

StakingVault 必须： 1. 验证 incoming notification 来自本项目 Jetton
Master 对应的 canonical Jetton Wallet。 2. 解析原始发送者 owner
address。 3. 验证 roundId 当前为 `STAKING_OPEN`。 4.
验证当前时间在质押窗口内。 5. 验证 nonce 未使用。 6. 验证风险版本一致且
`acceptFullPrincipalBurn == true`。 7. 验证数量大于0及任何已配置上下限。
8. 将金额加到该用户本轮 stake。 9. 更新总质押量。 10. 记录
DepositAccepted 事件。

如果任一条件失败，必须执行退款流程。不能因为 payload
无效而把用户代币永久留在协议中。

## 5. 建议消息接口（逻辑 ABI）

以下 opcode 是项目自定义建议值，正式开发时必须统一登记，确保无冲突并生成
ABI 文档。

  --------------------------------------------------------------------------------------------------
  消息                               建议 Opcode 发送者                   接收者
  ------------------------ --------------------- ------------------------ --------------------------
  `OpenRound`                       `0x52540001` Controller/权限角色      RoundController

  `CloseStaking`                    `0x52540002` 任意调用者/keeper        RoundController

  `SubmitCandle`                    `0x52540003` 任意提交者               OracleAdapter/Controller

  `OracleCandleVerified`            `0x52540004` OracleAdapter            RoundController

  `FinalizeRound`                   `0x52540005` 任意调用者               RoundController

  `ClaimPrincipal`                  `0x52540006` 用户                     StakingVault

  `ClaimReward`                     `0x52540007` 用户                     RewardVault

  `StartFailureBurn`                `0x52540008` RoundController          Vault

  `BurnAck`                         `0x52540009` Jetton Master 扩展       RoundController

  `PauseOracle`                     `0x5254000A` OracleAdapter/Guardian   RoundController

  `ResumeOracle`                    `0x5254000B` 经验证的恢复流程         RoundController
  --------------------------------------------------------------------------------------------------

## 6. 关键 Get Methods

建议公开： - `get_protocol_config()` - `get_round(round_id)` -
`get_round_status(round_id)` - `get_round_target_price(round_id)` -
`get_round_candle(round_id, candle_index)` -
`get_user_stake(round_id, owner)` - `get_round_total_stake(round_id)` -
`get_user_reward_estimate(round_id, owner)` -
`get_round_burn_status(round_id)` -
`get_total_burned_by_round(round_id)`

Get method 只读，不能被其他合约当作同步跨合约调用使用。

## 7. 失败销毁的两阶段执行

### 7.1 为什么需要两阶段

TON 合约间通过异步消息交互。Controller
发出消息不代表另一个合约已经完成状态变更。失败销毁必须等待两个资金来源都完成实际
burn。

### 7.2 推荐流程

1.  Controller 将轮次设为 `SETTLING_FAILURE`，冻结所有 claim。
2.  Controller 创建唯一 `burnId = hash(roundId, failure, configHash)`。
3.  RewardVault 对本轮7.5亿发送 burn 请求。
4.  StakingVault 对本轮 `totalAcceptedStakeRaw` 发送 burn 请求。
5.  Jetton Wallet 执行标准 burn 操作。
6.  Jetton Master 接收 `burn_notification` 并减少 total_supply。
7.  项目自有 Jetton Master 可增加受审计的 `BurnAck` 扩展，确认
    burnId、amount、owner vault 和 roundId。
8.  Controller 验证两笔 BurnAck 的来源和金额。
9.  两笔 burn 均确认后，将本轮状态设为 `FAILED_PERMANENT`。

如果采用未经扩展的第三方 Jetton
Master，必须另行设计可信的销毁确认方案；不能把普通 keeper
的声明当作链上销毁证明。

## 8. 成功奖励领取

为避免链上无界循环，采用 pull claim。

暂定的 MVP 权重公式（需项目方确认）：

`weight[user] = acceptedStake[user]`

`reward[user] = floor(roundReward × weight[user] / totalWeight)`

用户调用 `ClaimReward(roundId)` 时： 1. 验证轮次状态为成功。 2.
验证用户有有效 stake。 3. 验证 rewardClaimed 为 false。 4.
计算应得金额。 5. 写入领取状态/待处理状态。 6. 发出 Jetton transfer。 7.
通过回执或可重试的 pending-transfer 机制完成最终确认。

本金返还同样使用用户主动领取。转账操作必须幂等，避免重复领取。

## 9. TON 异步消息安全

-   验证每条内部消息的 sender。
-   正确处理 bounced messages。
-   不要把"消息已发送"当作"目标合约已完成"。
-   关键操作使用唯一 query_id / operation_id。
-   失败消息应能安全重试。
-   任何状态更新与发消息的顺序都必须经过交易追踪测试。
-   为每个 Vault 保留足够 TON 用于 gas 和消息转发。
-   不得接受其他 Jetton 的伪造 transfer_notification。

------------------------------------------------------------------------

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

------------------------------------------------------------------------

# 06 --- 开发、测试与部署 Runbook

## 1. 推荐工具链

根据 TON 官方智能合约文档： - Tolk 是官方推荐的智能合约语言。 - Acton
是推荐的合约全生命周期工具链，可用于项目初始化、构建、测试、脚本、调试和部署。

团队也可选择其他成熟 TON 工具链，但必须锁定： - Tolk/编译器版本； -
Acton/构建工具版本； - SDK 版本； - Node.js 版本； - 所有依赖锁文件； -
构建环境和 CI 镜像。

## 2. 建议代码仓库结构

``` text
project/
  contracts/
    jetton/
      jetton_master.tolk
      jetton_wallet.tolk
    protocol/
      round_controller.tolk
      staking_vault.tolk
      reward_vault.tolk
      oracle_adapter.tolk
      contribution_registry.tolk   # optional
    shared/
      messages.tolk
      storage.tolk
      errors.tolk
      math.tolk
  tests/
    unit/
    integration/
    fuzz/
    invariants/
  scripts/
    deploy_testnet/
    deploy_mainnet/
    verify/
    seed_vaults/
  frontend/
  oracle-service/
  docs/
  config/
    testnet/
    mainnet/
```

## 3. 阶段一：规格冻结

主网部署前必须完成： 1. 代币名称、符号、decimals。 2. P0
算法和初始基准期。 3. 价格来源和预言机供应商/验证模式。 4.
最低来源数、流动性、成交量、偏差和覆盖率。 5.
质押窗口、最低/最高质押量和单地址限制。 6. 奖励分配算法。 7.
奖励领取/归属规则。 8. 技术性预言机终止流程。 9. 团队归属规则。 10.
营销及内盘/流动性资金管理规则。 11. 多签角色和紧急暂停权限。 12.
用户风险披露文本及版本号。

任何一项未确定，不得开放主网质押。

## 4. 阶段二：本地开发

-   建立 Tolk/Acton 工程。
-   编写 Jetton Master/Wallet。
-   编写 RoundController。
-   编写 StakingVault 和 RewardVault。
-   编写 OracleAdapter。
-   编写单元测试、集成测试和不变量测试。
-   生成 ABI、部署脚本和前端类型。
-   CI 中强制格式化、静态分析、构建和测试。

## 5. 阶段三：Testnet

部署顺序建议： 1. Jetton Master/Wallet。 2. RewardVault。 3.
StakingVault。 4. OracleAdapter。 5. RoundController。 6.
配置各合约地址与权限。 7. 向 RewardVault 注入75亿奖励池。 8.
验证10个轮次各有7.5亿独立预算。 9. 验证初始分配总和为100亿。 10.
执行完整模拟轮次。

至少演练： - 一轮成功：8/12或以上。 - 一轮失败：7/12或以下。 -
预言机故障暂停和恢复。 - 失败销毁两笔 burn 和 supply 变化。 -
成功本金返还和奖励领取。 - 重复消息和 bounce 重试。

## 6. 阶段四：主网部署

部署前检查： - 所有参数已签署并冻结。 - 审计报告无未解决的 Critical/High
问题。 - 代码哈希与审计版本一致。 - 多签地址和阈值已公开。 - Jetton
Master mint 权限策略已确认。 - 预言机签名验证已在主网可用。 -
资金金库地址已验证。 - 所有交易均有足够 TON 支付 gas。 -
用户风险披露已在前端显示。 - 应急联系人和监控系统已就绪。

部署后： 1. 公布所有合约地址。 2. 公布源代码和代码哈希。 3.
公布初始供应量和分配交易。 4. 冻结 P0 及 oracle config hash。 5. 开启
Round 1。 6. 开放链上状态查询和事件索引。

## 7. 运维与监控

监控指标： - Jetton Master total_supply。 - 每个金库 Jetton 余额。 -
每轮状态。 - 每轮 stake 总额和参与地址数。 - 12根K线提交情况。 -
预言机数据延迟、有效来源数和偏差。 - pending burn 数量和确认状态。 -
pending refund/claim 数量。 - 合约 TON 余额和 gas 余量。 -
bounce、异常消息和失败交易。

告警： - oracle stale； - candle 缺失； - 质押窗口结束但仍收到入账； -
burn pending 超时； - total_supply 与账本不一致； - 非预期管理员操作； -
金库余额不足； - 合约暂停。

## 8. 密钥与权限

-   生产密钥不得存放在代码仓库。
-   多签私钥由不同责任人独立保管。
-   管理员不得拥有任意转移用户质押本金的权限。
-   紧急暂停不得直接改变价格判定结果。
-   任何配置变更必须经过时间锁和公开公告；核心规则最好在部署时固定不可升级。
-   若选择可升级架构，必须明确升级权限、延迟、治理流程和用户退出安排。

## 9. 发布验收标准

只有同时满足以下条件，才能宣布主网可用： - 编译可重复； -
全部测试通过； - 不变量测试通过； - 安全审计完成； -
预言机数据验证可用； - Testnet 成功和失败两种路径均完成； -
失败销毁实际减少 total_supply； - 质押本金返还与销毁互斥； -
用户风险披露和交易 payload 一致； - 所有待确认参数已冻结。

------------------------------------------------------------------------

# 07 --- 上线阻断项与建议默认值

本文件列出目前仍未由项目方明确确认的参数。开发团队可以先实现配置接口、mock
和测试，但在本表未完成前不得开放主网质押。

## 1. 上线阻断项

  ID     决策项                当前状态   建议默认值/说明
  ------ --------------------- ---------- ----------------------------------
  D-01   代币名称、符号        待定       项目方确认
  D-02   Jetton decimals       待定       可评估9位；部署后不可改
  D-03   P0 计算方式           待定       多源7日TWAP，冻结上链
  D-04   价格预言机            待定       TON 可验证签名/请求响应方案
  D-05   价格来源数量          待定       尽可能多个独立来源
  D-06   最低流动性            待定       按实际池深和市场规模定
  D-07   最低4小时成交量       待定       按实际市场规模定
  D-08   来源最大偏差          待定       以基点配置
  D-09   TWAP数据覆盖率        待定       必须足够覆盖完整4小时
  D-10   质押报名期            待定       建议7天
  D-11   单笔最低质押          待定       需兼顾gas与参与门槛
  D-12   单地址最大质押        待定       限制单地址权重；不能防多钱包
  D-13   全轮最大质押          待定       需评估潜在本金销毁规模
  D-14   奖励分配公式          未确认     MVP建议按有效质押数量比例
  D-15   社区贡献积分          未确认     可作为后续版本，需防作弊
  D-16   奖励归属/领取期限     待定       可评估12个月线性释放
  D-17   成功后本金返还时点    待定       建议成功终态后用户主动领取
  D-18   无人质押时处理        待定       不启动观察、不算失败、不销毁
  D-19   预言机长期故障        待定       建议暂停；超时技术终止时退还本金
  D-20   团队归属规则          待定       可评估12个月cliff+36个月线性
  D-21   营销金库管理          待定       建议多签及公开支出
  D-22   10%内盘与流动性拆分   待定       用户目前只确认合计10%
  D-23   多签阈值              待定       建议至少3/5或等效独立治理
  D-24   合约升级策略          待定       核心经济规则优先不可升级

## 2. 必须特别确认的经济问题

### 2.1 奖励分配

用户已经确定"质押本轮才有奖励资格"，但尚未最终确定质押用户之间如何分配7.5亿枚。

选择之一： - 纯质押比例分配； - 质押权重 + AI对战/数学任务贡献分； -
固定奖励名额/抽签； - 分层奖励池。

这不是小参数，而是核心经济规则。不得由开发人员自行决定。

### 2.2 质押本金销毁的法律与市场风险

失败时销毁所有本轮质押本金是协议已确认的业务规则，但风险极高： -
参与者可能损失100%质押本金； - 价格可能被第三方操纵； -
质押者可能提前卖出或拒绝参与； -
该机制可能触及不同司法辖区的金融产品、博彩、促销或消费者保护规则。

必须由专业律师和独立经济风险顾问审查，并在用户签名前充分披露。

### 2.3 失败轮次永久关闭与技术故障

"市场考核失败"永久关闭；"预言机故障"不能伪装成市场失败。

应当区分： - 市场数据有效且12根完整K线中少于8根达标：永久失败并销毁。 -
预言机/链上技术故障：暂停或技术终止，不能销毁本金。 -
无人质押：不启动市场考核，不视为失败。

## 3. 建议参数配置模板

``` text
TOKEN_DECIMALS = TBD
P0_USD_E8 = TBD
ROUND_REWARD_RAW = 750000000 * 10^TOKEN_DECIMALS
ROUND_COUNT = 10
PRICE_MULTIPLIER = 2
CANDLE_SECONDS = 14400
CANDLE_COUNT = 12
MIN_QUALIFIED_CANDLES = 8
STAKE_DURATION_SECONDS = TBD
MIN_STAKE_RAW = TBD
MAX_STAKE_PER_ADDRESS_RAW = TBD
MAX_TOTAL_STAKE_RAW = TBD
MIN_VALID_SOURCES = TBD
MIN_LIQUIDITY_USD_E8 = TBD
MIN_VOLUME_4H_USD_E8 = TBD
MAX_SOURCE_DEVIATION_BPS = TBD
MIN_COVERAGE_BPS = TBD
REWARD_DISTRIBUTION_MODE = TBD
REWARD_VESTING_SECONDS = TBD
ORACLE_PAUSE_TIMEOUT_SECONDS = TBD
```

## 4. 冻结流程

1.  产品负责人确认经济规则。
2.  经济顾问审查激励和操纵风险。
3.  律师审查发行、质押、本金销毁和奖励机制。
4.  技术负责人确认预言机和 TON 消息架构。
5.  将最终参数生成配置哈希。
6.  在 Testnet 验证配置哈希与运行结果。
7.  审计机构审查同一版本代码和参数。
8.  主网部署并公布参数哈希。

任何部署后变更都必须遵循预先公开的治理与时间锁规则。

------------------------------------------------------------------------

# 08 --- 技术参考资料

以下资料用于 TON
标准与工具链实现参考。开发时应以官方文档和对应标准的最新版本为准。

1.  TON Smart Contracts Overview\
    https://docs.ton.org/contracts/overview\
    智能合约开发、工具链和标准合约概览。

2.  TON Tolk Overview\
    https://docs.ton.org/tolk/overview\
    Tolk 语言说明。

3.  TON Jetton Standard Overview\
    https://docs.ton.org/contracts/standard/tokens/jettons/overview\
    Jetton（TEP-74）架构概览。

4.  How Jetton Works\
    https://docs.ton.org/contracts/standard/tokens/jettons/how-it-works\
    Jetton Master、Jetton Wallet、转账通知和 burn 消息流程。

5.  How to Burn Jettons\
    https://docs.ton.org/contracts/standard/tokens/jettons/burn\
    Jetton 销毁流程及工具参考。

6.  TON Oracles\
    https://docs.ton.org/onboarding/oracles\
    预言机基础、push/pull 模式以及 TON 的请求-响应交互建议。

7.  TON Internal Messages\
    https://docs.ton.org/foundations/messages/internal\
    内部消息和 bounce 行为。

8.  TON Smart Contract Security\
    https://docs.ton.org/v3/guidelines/smart-contracts/security/common-vulnerabilities/\
    智能合约安全风险参考；若路径调整，请从 TON
    官方文档导航查找当前安全章节。

9.  TEP-74 Jetton Standard\
    https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md\
    Jetton 标准原文。

## 重要说明

-   TEP-74 定义通用交互标准，但具体 Jetton Master/Wallet
    实现仍需检查代码。
-   项目自定义 burn acknowledgement 扩展必须经过独立审计。
-   预言机服务商、价格源、签名格式和链上适配器必须在部署时明确。
-   本文未将任何第三方价格服务标记为已选定或已集成。
