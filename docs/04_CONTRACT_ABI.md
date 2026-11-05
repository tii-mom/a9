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

---

## 9. V2 变更注记（2026-11-05）

- **ContributionRegistry（§2.6）已移除**：奖励算法确定为纯质押比例，不再引入 AI 对战/贡献积分。若未来重启该方向，须重新走 D-15 决策与反作弊设计。
- **OracleAdapter（§2.5）本期不接入第三方预言机**：K 线由任意用户手动触发提交（测试网模式），适配器保留接口与配置版本字段，主网前必须恢复签名验证（见 docs/00 §3 第 3 条）。
- **burn acknowledgement 扩展（§2.1、§7）**：优先采用「标准 TEP-74 burn + 链下对账 + 多签确认」替代自研 ack 回调；如确需扩展，控制在最小回调面并单独审计（见 docs/00 §5）。
- 其余消息接口（opcode 表）与存储结构不变。

