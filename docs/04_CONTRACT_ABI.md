# 04 --- 智能合约架构、存储与消息接口

> **口径声明（V4）**：RewardVault 70 亿 / 每轮 7 亿；团队每轮 1.2 亿随轮次释放/销毁；失败销毁三笔（奖励 + 团队 + 本金）；报名窗口 48h；无人质押启动观察（0 人通过 → 奖励销毁）；**不设多签**，管理员为单密钥 owner；奖励领取方式待定（推荐 pull claim）。与 `docs/00_DECISIONS_V2.md` 冲突时以其为准。

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

团队 / 营销 / 流动性（V4）：
+------------------------+
| 个人钱包（非合约）      |
| team / marketing / liq |
| no multisig / no lockup|
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
Master 的结算确认。 - **团队额度释放/销毁**：成功时向团队钱包转出本轮
1.2 亿；失败时发起团队额度 1.2 亿 burn（kind = `team`）。 -
**单密钥 owner 权限最小化**：owner 不能转移用户质押本金，不能修改已开轮的目标价 /
阈值 / oracle config hash；不设多签、不设升级代理。

### 2.3 StakingVault

职责： - 接收本项目 Jetton。 - 验证 Jetton Wallet 来源。 - 验证
roundId、nonce 和风险确认 payload。 - 记录每轮每个用户的质押本金。 -
关闭质押后冻结 ledger。 - 成功时允许用户领取本金。 -
失败时将本轮全部本金提交 burn。 - 处理退款、重复消息和失败重试。

### 2.4 RewardVault

职责： - 持有70亿社区奖励。 - 维护十轮独立的700,000,000（7亿）奖励账本。 -
成功时允许符合资格的用户一次性领取（无归属期）。 - 失败时销毁对应轮次的7亿奖励。 -
不允许将失败轮次额度转移到其他轮次。

### 2.5 OracleAdapter

职责： - 验证价格数据签名或对接可信预言机合约。 - 验证
feedId、有效期、nonce、配置版本。 - 向 RoundController 提供经过验证的
Candle 结果。 - 防止未授权来源伪造数据。

### 2.6 团队 / 营销 / 流动性钱包（个人钱包，非合约）

V4 决策：**项目不部署多签，也不部署 Lockup/Vesting**。

- 团队 12%：**由 RoundController 持有的 Jetton Wallet 托管**（控制器才有 burn 权限）；成功轮转出 1.2 亿到团队个人收款钱包，失败轮销毁 1.2 亿。
- 营销 5%、流动性 10%：**个人钱包**持有，无链上治理约束。
- 合约不假设存在多签或时间锁；相关密钥管理要求见 docs/06 §8 与 docs/10 §9。
- ContributionRegistry 已在 V2 删除，不再作为可选模块。

## 3. 推荐存储结构

以下为逻辑结构，实际 Tolk cell/dictionary 布局由开发团队优化。

``` text
ProtocolConfig {
    jettonMaster: address
    jettonWalletOfStakingVault: address
    jettonWalletOfRewardVault: address
    roundController: address
    oracleAdapter: address
    teamWallet: address          // 团队个人钱包（单密钥持有）
    p0UsdE8: uint128
    tokenDecimals: uint8
    roundRewardRaw: uint128     // 700,000,000 × 10^decimals
    teamRoundRaw: uint128       // 120,000,000 × 10^decimals（每轮）
    stakeDurationSeconds: uint32 // 172800：报名窗口 48h
    stakeGapSeconds: uint32      // 172800：上一轮结算后 48h 开启下一轮
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

  `ReleaseTeamQuota`                `0x5254000C` RoundController          团队收款钱包（成功转出 1.2 亿）
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
发出消息不代表另一个合约已经完成状态变更。失败销毁必须等待**三个资金来源**（奖励池 /
团队额度 / 质押本金）都完成实际 burn。

### 7.2 推荐流程

1.  Controller 将轮次设为 `SETTLING_FAILURE`，冻结所有 claim。
2.  Controller 创建唯一 `burnId = hash(roundId, failure, configHash)`。
3.  RewardVault 对本轮7亿发送 burn 请求（kind = `reward`）。
4.  RoundController 从团队额度钱包（owner = RoundController）销毁本轮 1.2 亿（kind = `team`）。
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

为避免链上无界循环，**推荐**采用 pull claim（D-25 待确认，见 §8.1）。

V3 已确认的纯质押比例公式（D-14，不再叠加任何贡献积分）：

`weight[user] = acceptedStake[user]`

`reward[user] = floor(roundReward × weight[user] / totalWeight)`

用户调用 `ClaimReward(roundId)` 时： 1. 验证轮次状态为成功。 2.
验证用户有有效 stake。 3. 验证 rewardClaimed 为 false。 4.
计算应得金额。 5. 写入领取状态/待处理状态。 6. 发出 Jetton transfer。 7.
通过回执或可重试的 pending-transfer 机制完成最终确认。

本金返还同样使用用户主动领取。转账操作必须幂等，避免重复领取。

### 8.1 奖励领取方式（D-25，待确认）

两种候选方案，V4 文档同时列出并标注待确认：

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 结算后批量转账 | 管理员在结算后按质押比例批量转账给质押人 | 简单、无新增代码、gas 由项目方承担 | **本项目无多签 → 等于单私钥手动操作**；中心化、易出错、用户不能自助、无法保证及时性 | ❌ 与本项目「不设多签」决策冲突，**不推荐** |
| B. 控制器 pull claim | 用户调用 `ClaimReward(roundId)` 自助领取，按质押比例、幂等 | 去信任、可自助、可审计、无需人工 | 需在 RoundController 实现领取逻辑（约 100~150 行）与 pending 状态 | ✅ **推荐** |

推荐采用 **方案 B（pull claim）**，并纳入 RoundController 的最小自研范围；若最终选 A，
必须在文档中明确记录「单私钥手动操作」的中心化风险与运营要求。

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
- **报名窗口参数**：新增 `stakeDurationSeconds = 172,800`（48h）与 `stakeGapSeconds = 172,800`（上一轮结算后 48h 开启）；`stakeOpenAt = prevSettledAt + stakeGap`，`stakeCloseAt = stakeOpenAt + stakeDuration`，报名关闭即进入观察（`observationStart = stakeCloseAt`）。
- **无人质押分支**：报名关闭时 `totalAcceptedStake == 0` 仍启动观察（不跳过、不延期、不判负）；失败照常销毁本轮 7 亿奖励，通过则按质押比例分配（0 人质押且通过时奖励销毁，D-18b 已定，见 §12）。
- **奖励领取**：成功后**一次性发放、无归属期**（D-16/D-17 已定）；`ClaimReward` 仍是 pull claim，需幂等。
- **价格参数**：`p0UsdE8 = 100,000`（P0 = $0.001），`target(roundId) = P0 × 2^roundId`，R10 = $1.024；`roundRewardRaw = 700,000,000 × 10^decimals`。
- **销毁口径**：失败轮销毁 `ROUND_REWARD + totalAcceptedStake`；无人质押时本金部分为 0。（V4 已更新为三笔，见 §12）

---

## 12. V4 变更注记（2026-11-05）

- **团队额度**：新增 `teamWallet`（团队个人钱包）与 `teamRoundRaw = 120,000,000 × 10^decimals`；成功轮释放本轮 1.2 亿（新增 `ReleaseTeamQuota` opcode），失败轮销毁 1.2 亿（kind = `team`）。不部署 Lockup/Vesting 合约。
- **失败销毁三笔**：`reward`（7 亿）+ `team`（1.2 亿）+ `principal`（本轮本金），三笔独立 burnId 与确认状态；`RoundData` 增加 `teamReleaseConfirmed` / `teamBurnConfirmed`。
- **不设多签**：移除 Multisig 相关假设；架构中的营销/流动性/团队为**个人钱包**（非合约）；管理员为 RoundController 单密钥 owner，权限最小化、控制器不可升级（待 D-24 最终确认）。
- **D-18b**：0 人质押且本轮通过 → 本轮 7 亿奖励销毁（不回流、不留存、不补发）。
- **奖励领取方式**：见 §8.1，方案 A（批量转账，与无多签冲突，不推荐）/ 方案 B（pull claim，推荐），**待确认**。

