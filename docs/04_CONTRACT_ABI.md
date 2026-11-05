# 04 --- 智能合约架构、存储与消息接口

> **口径声明（V5.3）**：RewardVault 70 亿 / 每轮 7 亿；观察 12 根 / 48h / 8 根（已确认不变）；**不允许取消质押（仅 TECHNICAL_ABORTED 退本金）**；D-28/29/30 待确认；团队 12 亿由**独立 TeamVault** 托管、每轮 1.2 亿释放/销毁；失败销毁三笔（奖励 + 团队 + 本金）；**报名窗口 72h**（结算后立即开启）；无人质押启动观察（0 人通过 → 奖励销毁）；**不设多签**，管理员为单密钥 owner、**RoundController 不可升级**；奖励为 **pull claim**（可跨轮累积、≤10 轮有界、一次合并转账）；收款钱包热钱包且地址不公开。与 `docs/00_DECISIONS_V2.md` 冲突时以其为准。

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

团队额度（V5）：
+------------------------+
|       TeamVault        |
| 12 亿 Jetton Wallet 托管 |
| 只接受 RoundController  |
| 每轮：转出 1.2 亿 / 销毁  |
+------------------------+
              |
+-------------v-----------------------------+
| 收款钱包（个人热钱包，地址不公开）          |
| team / marketing / liquidity              |
| 不部署 multisig / lockup                   |
+-------------------------------------------+
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
Master 的结算确认。 - **向 TeamVault 下发团队额度指令**：成功时 `ReleaseTeamQuota`
（转 1.2 亿到团队收款钱包）；失败时 `BurnTeamQuota`（销毁 1.2 亿，kind = `team`）。 -
**pull claim / claimAll**：按（round, owner, type）做幂等记账，一次最多遍历 10 轮，合并为一笔转账。 -
**单密钥 owner 权限最小化**：owner 仅能开轮、关报名、暂停/恢复预言机、必要时触发结算；
不能转移用户质押本金，不能修改已开轮的目标价 / 阈值 / oracle config hash。 -
**不可升级**（D-24）：无升级代理；不设多签。 -
**目标价写入（V5.4 已确认）**：合约**不预存 10 轮价格**；P0 与倍数是不
可变常量、只存档位计数与每轮 `targetPriceUsdE8`。第 N 轮结算时写入
第 N+1 轮 `targetPrice = P0 × 2^(下一档位)`，写入后不可改，并发出
`TargetPriceSet(roundId, targetPriceUsdE8, tier)` 事件供索引/前端；若采用
D-26 的「开窗闸门 + 超时提档」，提档目标价在**开轮交易**写入（仍在质押开始前、写入后不可改）。

### 2.3 StakingVault

职责： - 接收本项目 Jetton。 - 验证 Jetton Wallet 来源。 - 验证
roundId、nonce 和风险确认 payload。 - 记录每轮每个用户的质押本金。 -
关闭质押后冻结 ledger。 - 成功时允许用户领取本金。 -
失败时将本轮全部本金提交 burn。 - 处理退款、重复消息和失败重试。 -
**V5.3 已确认：不提供取消/提前退出通道**（无 `CancelStake` / `Withdraw` 消息）；
只在 `TECHNICAL_ABORTED` 时按控制器指令退还全部本金。

### 2.4 RewardVault

职责： - 持有70亿社区奖励。 - 维护十轮独立的700,000,000（7亿）奖励账本。 -
成功时允许符合资格的用户一次性领取（无归属期）。 - 失败时销毁对应轮次的7亿奖励。 -
不允许将失败轮次额度转移到其他轮次。

### 2.5 OracleAdapter

职责： - 验证价格数据签名或对接可信预言机合约。 - 验证
feedId、有效期、nonce、配置版本。 - 向 RoundController 提供经过验证的
Candle 结果。 - 防止未授权来源伪造数据。

### 2.6 TeamVault（团队金库，自研）

V5 决策：团队额度**不再放在 RoundController 钱包**，改由独立 TeamVault 合约托管。

职责： - 持有 12 亿对应的 Jetton Wallet（owner = TeamVault 合约）。 - **只接受
RoundController 的指令**，其他来源消息一律拒绝。 - `ReleaseTeamQuota(roundId)`：
把本轮 1.2 亿转出到团队收款钱包（成功结算）。 - `BurnTeamQuota(roundId)`：
销毁本轮 1.2 亿（失败结算，kind = `team`）。 - 同一轮释放/销毁**互斥且幂等**：
重复指令返回已有结果，每轮最多一次。 - 团队收款钱包地址在部署前写入 TeamVault
的 config（个人热钱包，地址不对外披露）。

### 2.7 收款钱包（团队 / 营销 / 流动性，个人热钱包）

- 团队收款钱包、营销 5%、流动性 10% 均为**个人热钱包**（非合约）。
- **地址不对外披露**：项目方部署前提供并填入 config；至少向审计方/交易所披露。
- 项目不部署 Multisig，也不部署 Lockup/Vesting；合约不假设存在多签或时间锁。
- 密钥与风险要求见 docs/06 §8 与 docs/10 §9；ContributionRegistry 已在 V2 删除。

## 3. 推荐存储结构

以下为逻辑结构，实际 Tolk cell/dictionary 布局由开发团队优化。

``` text
ProtocolConfig {
    jettonMaster: address
    jettonWalletOfStakingVault: address
    jettonWalletOfRewardVault: address
    roundController: address
    oracleAdapter: address
    teamVault: address           // TeamVault 合约（持有 12 亿）
    teamWallet: address          // 团队收款钱包（个人热钱包，地址不公开）
    adminOwner: address          // 单密钥 owner（最小权限，不可升级）
    p0UsdE8: uint128            // 不可变常量：$0.00116 → 116,000
    priceMultiplier: uint8      // 不可变常量：2（V5.4 最终确认）
    tokenDecimals: uint8
    roundRewardRaw: uint128     // 700,000,000 × 10^decimals
    teamRoundRaw: uint128       // 120,000,000 × 10^decimals（每轮）
    stakeDurationSeconds: uint32 // 259200：报名窗口 72h
    stakeGapSeconds: uint32      // 0：上一轮结算后立即开启报名
    candleSeconds: uint32       // 14400
    candleCount: uint8          // 12
    minQualifiedCandles: uint8  // 8
    oracleConfigHash: uint256
    configVersion: uint32
}

ProtocolState {
    tier: uint8                  // 当前档位（= 1 + 已成功轮数；D-28 若采纳则用于同档重试）
    currentRoundId: uint8
}

RoundData {
    roundId: uint8
    targetPriceUsdE8: uint128    // 由上一轮结算时写入；不可改
    targetTier: uint8            // 写入时的档位
    targetWrittenAt: uint64      // 写入交易时间
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
    teamReleaseConfirmed: bool
    teamBurnConfirmed: bool
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

> **targetPrice 语义（D-28 待确认，Lead 建议：失败同档重试）**：当前 `RoundData.targetPriceUsdE8` 按「轮次」写入（`P0 × 2^roundId`，失败进入下一阶）。若采纳 D-28，需改为按「**档位 tier**」写入：
> `targetPrice = P0 × 2^tier`，`tier = 1 + 已成功轮数`；失败轮不升档（下一轮沿用同一 targetPrice），成功才 `tier += 1`。`RoundData` 需增加 `tier: uint8` 字段（D-28 定案后）。**未定案前不要改存储结构。**

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

> **V5.3 已确认**：质押一旦被接受即不可取消——**没有取消质押的消息类型**；用户只能在成功轮领取本金、或在失败轮被销毁。唯一例外：整个轮次进入 `TECHNICAL_ABORTED` 时由控制器指令退还本金（这是唯一退款路径，管理员不得手工解锁）。

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

  `ReleaseTeamQuota`                `0x5254000C` RoundController          TeamVault（成功转 1.2 亿到团队收款钱包）

  `BurnTeamQuota`                   `0x5254000D` RoundController          TeamVault（失败销毁 1.2 亿）

  `ClaimAll`                        `0x5254000E` 用户                     RoundController（多轮奖励合并领取，≤10 轮）

  `CancelStake`                      **无此消息**                          ——（V5.3 已确认：不支持取消质押）
  --------------------------------------------------------------------------------------------------

## 6. 关键 Get Methods

建议公开： - `get_protocol_config()` - `get_round(round_id)` -
`get_round_status(round_id)` - `get_round_target_price(round_id)` -
`get_round_candle(round_id, candle_index)` -
`get_user_stake(round_id, owner)` - `get_round_total_stake(round_id)` -
`get_user_reward_estimate(round_id, owner)` -
`get_claimable_all(owner)`（返回所有已结算轮次的未领金额，供前端展示/claimAll 使用） -
`get_round_burn_status(round_id)` -
`get_total_burned_by_round(round_id)` -
`get_team_vault_state()`（TeamVault 余额、已释放/已销毁轮次）

Get method 只读，不能被其他合约当作同步跨合约调用使用。

## 7. 失败销毁的两阶段执行

### 7.1 为什么需要两阶段

TON 合约间通过异步消息交互。Controller
发出消息不代表另一个合约已经完成状态变更。失败销毁必须等待**三个资金来源**（奖励池 /
团队额度 / 质押本金）都完成实际 burn。

### 7.2 推荐流程

1.  Controller 将轮次设为 `SETTLING_FAILURE`，冻结所有 claim。
2.  Controller 创建唯一 `burnId = hash(roundId, failure, configHash)`。
3.  RewardVault 对本轮7亿发送 burn 请求（kind = `reward`）。
4.  RoundController 向 **TeamVault** 发 `BurnTeamQuota`，由 TeamVault 销毁其持有的本轮 1.2 亿（kind = `team`）。
5.  StakingVault 对本轮 `totalAcceptedStakeRaw` 发送 burn 请求（kind = `principal`）。
6.  Jetton Wallet 执行标准 burn 操作。
7.  Jetton Master 接收 `burn_notification` 并减少 total_supply。
8.  项目自有 Jetton Master 可增加受审计的 `BurnAck` 扩展，确认
    burnId、amount、owner vault 和 roundId。
9.  Controller 验证**三笔** BurnAck 的来源和金额。
10. 三笔 burn 均确认后，将本轮状态设为 `FAILED_PERMANENT`。

如果采用未经扩展的第三方 Jetton
Master，必须另行设计可信的销毁确认方案；不能把普通 keeper
的声明当作链上销毁证明。

## 8. 成功奖励领取

采用 **pull claim**（D-25 已确认，见 §8.1），避免链上无界循环。

V3 已确认的纯质押比例公式（D-14，不再叠加任何贡献积分）：

`weight[user] = acceptedStake[user]`

`reward[user] = floor(roundReward × weight[user] / totalWeight)`

用户调用 `ClaimReward(roundId)` 时： 1. 验证轮次状态为成功。 2.
验证用户有有效 stake。 3. 验证 rewardClaimed 为 false。 4.
计算应得金额。 5. 写入领取状态/待处理状态。 6. 发出 Jetton transfer。 7.
通过回执或可重试的 pending-transfer 机制完成最终确认。

本金返还同样使用用户主动领取。转账操作必须幂等，避免重复领取。

### 8.1 奖励领取方式（D-25，V5 已确认：pull claim）

**结论：采用方案 B（控制器 pull claim）**，不采用方案 A 批量转账（无多签 → 单私钥手动操作，中心化）。

已确认的领取设计：

1. 前端展示**所有已结算轮次（含历史未领）**的可领金额（含本金与奖励分别列示）。
2. 用户一次调用 `claim`：携带 roundId 列表（或 `claimAll` 自动扫描已结算未领轮次）。
3. 合约内部**最多遍历 10 轮**（固定上界，不做无界循环；轮次数本身就是 10）。
4. 每轮按（round, owner, type）做**幂等标记**，重复调用不得重复派发。
5. 多轮金额**合并为一笔 Jetton 转账**（降低 gas）；gas 由用户承担。
6. 本金与奖励可以一次领取或分开领取，但都走同一套幂等状态。

方案对比（存档）：

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A. 结算后批量转账 | 管理员按质押比例批量转账 | ❌ 无多签 = 单私钥手动操作，中心化、易错、用户不能自助；不采用 |
| B. 控制器 pull claim | 用户自助领取、逐轮幂等、可跨轮合并 | ✅ V5 已确认采用 |

RoundController 中实现要点：`ClaimRecord[roundId][owner][type] = claimed`；`claimAll`
循环上限 10；先全部校验再发一笔转账，失败回滚状态；pending 状态用于消息重试。

## 9. TON 异步消息安全

-   验证每条内部消息的 sender。
-   正确处理 bounced messages。
-   不要把"消息已发送"当作"目标合约已完成"。
-   关键操作使用唯一 query_id / operation_id。
-   失败消息应能安全重试。
-   任何状态更新与发消息的顺序都必须经过交易追踪测试。
-   为每个 Vault 保留足够 TON 用于 gas 和消息转发。
-   不得接受其他 Jetton 的伪造 transfer_notification。

---

## 10. V2 变更注记（2026-11-05）

- **ContributionRegistry（§2.6）已移除**：奖励算法确定为纯质押比例，不再引入 AI 对战/贡献积分。若未来重启该方向，须重新走 D-15 决策与反作弊设计。
- **OracleAdapter（§2.5）本期不接入第三方预言机**：K 线由任意用户手动触发提交（测试网模式），适配器保留接口与配置版本字段，主网前必须恢复签名验证（见 docs/00 §3 第 3 条）。
- **burn acknowledgement 扩展（§2.1、§7）**：优先采用「标准 TEP-74 burn + 链下对账 + 单密钥 owner 确认」替代自研 ack 回调；如确需扩展，控制在最小回调面并单独审计（见 docs/00 §5）。
- 其余消息接口（opcode 表）与存储结构不变。

---

## 11. V3 变更注记（2026-11-05）

- **奖励金库总量**：RewardVault 持有 **70 亿**（原 75 亿），十轮独立账本每轮 **700,000,000**（7 亿），合计 10 × 7 亿 = 70 亿。
- **报名窗口参数**：新增 `stakeDurationSeconds = 172,800`（48h）与 `stakeGapSeconds = 172,800`（上一轮结算后 48h 开启）；`stakeOpenAt = prevSettledAt + stakeGap`，`stakeCloseAt = stakeOpenAt + stakeDuration`，报名关闭即进入观察（`observationStart = stakeCloseAt`）。（**V5 已改为 72h / gap 0**，见 §13）
- **无人质押分支**：报名关闭时 `totalAcceptedStake == 0` 仍启动观察（不跳过、不延期、不判负）；失败照常销毁本轮 7 亿奖励，通过则按质押比例分配（0 人质押且通过时奖励销毁，D-18b 已定，见 §12）。
- **奖励领取**：成功后**一次性发放、无归属期**（D-16/D-17 已定）；`ClaimReward` 仍是 pull claim，需幂等。
- **价格参数（V5.3 时点）**：`p0UsdE8 = 100,000`（P0 = $0.001），`target(roundId) = P0 × 2^roundId`，R10 = $1.024；`roundRewardRaw = 700,000,000 × 10^decimals`。（**V5.4 已改为 P0 = 116,000**，见 §15）
- **销毁口径**：失败轮销毁 `ROUND_REWARD + totalAcceptedStake`；无人质押时本金部分为 0。（V4 已更新为三笔，见 §12）

---

## 12. V4 变更注记（2026-11-05）

- **团队额度**：新增 `teamWallet`（团队个人钱包）与 `teamRoundRaw = 120,000,000 × 10^decimals`；成功轮释放本轮 1.2 亿（`ReleaseTeamQuota`），失败轮销毁 1.2 亿（kind = `team`）。不部署 Lockup/Vesting 合约。（**V5 已改为独立 TeamVault 托管**，见 §13）
- **失败销毁三笔**：`reward`（7 亿）+ `team`（1.2 亿）+ `principal`（本轮本金），三笔独立 burnId 与确认状态；`RoundData` 增加 `teamReleaseConfirmed` / `teamBurnConfirmed`。
- **不设多签**：移除 Multisig 相关假设；架构中的营销/流动性/团队为**个人钱包**（非合约）；管理员为 RoundController 单密钥 owner，权限最小化、控制器不可升级（待 D-24 最终确认）。
- **D-18b**：0 人质押且本轮通过 → 本轮 7 亿奖励销毁（不回流、不留存、不补发）。
- **奖励领取方式**：见 §8.1，方案 A（批量转账，与无多签冲突，不推荐）/ 方案 B（pull claim，推荐），当时**待确认**。

---

## 13. V5 变更注记（2026-11-05）

- **团队额度改为 TeamVault 合约托管**：新增 `TeamVault`（自研）与 `teamVault` 地址；12 亿存于 TeamVault 的 Jetton Wallet（owner = TeamVault）。RoundController 通过 `ReleaseTeamQuota` / `BurnTeamQuota` 指令控制，TeamVault **只接受 RoundController**、同轮释放/销毁互斥且幂等。团队收款钱包为个人热钱包、地址不公开。
- **报名窗口 72h**：`stakeDurationSeconds = 259,200`；`stakeGapSeconds = 0`（上一轮结算后立即开启）；观察窗口仍 48h / 12 根 4h。
- **奖励领取确定 pull claim（D-25）**：新增 `ClaimAll`（0x5254000E）与 `get_claimable_all(owner)`；单次最多遍历 10 轮、逐轮幂等、合并为一笔转账、gas 由用户承担。方案 A 不采用。
- **D-24 已确认不可升级**：RoundController 无升级代理；管理员仅保留开轮/关报名/暂停恢复/触发结算的最小权限。
- **收款钱包**：团队/营销/流动性均为个人热钱包，地址不对外披露（部署前填入 config，至少向审计/交易所披露）；相应风险登记见 docs/10 §9。
- **待决策**：报名窗口 72h 下的「现价已超目标价 → 无风险白拿」问题（方案 A / **B+（Lead 推荐）** / C）见 docs/00 §7，尚未定案，当前仍按 `FIXED_LADDER` 运行。

---

## 14. V5.3 变更注记（2026-11-05）

- **已确认（定稿）**：① 观察窗口保持 **12 根 / 48h / 8 根**（不做 18/72/12）；② **不允许取消质押**——没有 `CancelStake`/withdraw 消息，唯一退款路径是 `TECHNICAL_ABORTED`（退还全部本金）。
- **新增待确认建议（Lead 建议，未定案）**：
  - **D-28 失败同档重试**：`targetPrice` 改按 tier 语义（`tier = 1 + 已成功轮数`），失败沿用同档、成功才升档；需新增 `RoundData.tier` 与前端阶梯改「档位」视图。
  - **D-29 R1 启动规则**：Lead 推荐 R1 目标 = 1.3~1.5 × 上市基准 TWAP，之后每轮 ×2（当前仍 R1 = 2×P0）。
  - **D-30 搭便车时间加权**：Lead 建议第一版不做（方案 A）；方案 B 为报名前 24h 1.0× / 后 48h 0.5×。
- 与 [docs/12_DESIGN_REVIEW.md](12_DESIGN_REVIEW.md) 的 P0-5 / P0-1 / P1-3 对齐；未定案前保持现有存储与状态机。

---

## 15. V5.4 变更注记（2026-11-05）

- **P0 与比价**：**1 GRAM = 1000 A9** 固定比价 → P0 = **$0.00116**（USD_E8 = 116,000），FDV $11.6M，R1 $0.00232 → R10 $1.18784。**P0 与倍数（2×）均为不可变常量**。
- **目标价写入时机**：合约**不预存 10 个价格**，只存 P0、倍数、档位计数、每轮 `targetPriceUsdE8`；**第 N 轮结算时写入第 N+1 轮目标价**，写入后不可改并发出 `TargetPriceSet`；R1 目标在部署/首轮开启时写入；闸门超时提档在开轮交易写入（质押开始前）。前端/文档阶梯由 `P0 × 2^n` 离线计算，任何人可用 P0 与倍数校验。
- **冷启动池（已确认）**：1 亿 A9 + **$116,000** USDT @ $0.00116（与内盘价一致）；内盘募得 GRAM 部分换 USDT 进池、部分留营销。运营细则（分阶段双边加池、未售内盘转公开团队钱包）见 docs/01 §10 / docs/00 §7.13。
- **D-31**：2× 最终确认，不再改动；docs/13 蒙特卡洛「2× 通过率≈0」结论保留为风险记录。
- **D-32 待确认**：内盘/流动性比例调整（10%+5%，需减 2 点；A/B/C 三候选），当前基线仍是 70/13/12/5。

