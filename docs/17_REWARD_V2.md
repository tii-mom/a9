# 17 — 奖励机制 V2（权重制）与合约改动规格

**版本**：V8.6 · 2026-11-06
**状态**：**已实现并冻结**（tag `v8.6-audit-fixed` @ `c24809a`；154 tests / 15 files）
**上游**：[docs/00](00_DECISIONS_V2.md)（V7 一句话机制）、[docs/01](01_TOKENOMICS.md)（分配）、[docs/16](16_REWARD_EXAMPLES.md)（收益示例）
**目标**：在不增发、不增加新合约的前提下，把「7 亿怎么分」从「纯按金额」升级为「按贡献权重」，并解决奖励抛压自毁问题。

---

## 0. 为什么改（一句话）

V7 的机制有一个结构性死结：**奖励以 A9 发放，而每轮 7 亿奖励是池子深度的 7–158 倍**（docs/16 §4）。赢的那一刻就是价格归零的那一刻。

V8 只做两件事：

1. **让奖励不进入市场**（滚存 / 早领罚没 / 锁到 R10 后）
2. **让奖励不只按金额分**（邀请 + 连续参与 → 权重）

其余全部不变：10 轮、2×、24 根 1h / 16 阈值、12h + 36h + 24h、100% 罚没、三笔销毁、TeamVault、pull claim。

---

## 1. 五条规则（最终版）

| # | 规则 | 一句话 |
| --- | --- | --- |
| R1 | **下注** | 押本金，赌 72 小时内价格**至少翻倍**（24 根 1h K 线，TWAP ≥ 目标价至少 16 根） |
| R2 | **结算** | 赢：7 亿按权重分；输：本金 + 本轮奖励 + 团队额度**全部销毁** |
| R3 | **奖励三态** | 滚存（全额进下一轮）/ 早领（拿 50%）/ 不动（锁到 R10 后 12 个月线性）。**旧接口 ClaimReward / ClaimAll 的奖励部分在阶梯期同样只付 50%**（本金 ClaimPrincipal 100% 不变），不留后门 |
| R4 | **权重** | `权重 = 质押 × (1 + 10% × 连续轮次) + min(20% × 被邀请人质押, 自己的质押)` |
| R5 | **零增发** | 所有加成只改变 7 亿池内的分配比例，**不额外印一枚币** |

> **R4 的连续轮次封顶 10 轮**（即最高 +100%，权重 2.0×）。

---

## 2. 权重公式（精确）

对第 `r` 轮的用户 `u`：

```
base_u      = stake_u(r) × (1 + 0.10 × min(streak_u, 10))
bonus_u     = min(0.20 × referredStake_u(r), stake_u(r))     // 推荐加成封顶 = 自己的质押额
weight_u    = base_u + bonus_u
reward_u    = 700,000,000 × weight_u / Σ weight
```

### 2.1 连续轮次（streak）定义

- 每次质押入账时判定：`streak = (lastStakeRound == r-1) ? streak+1 : 1`
- **滚存也算一次参与**（不中断连续）
- 某轮完全没有有效质押（既没新押也没滚存）→ streak 清零
- 封顶 10 轮

| 连续轮次 | 权重加成 | 倍数 |
| --- | --- | --- |
| 1 | +10% | 1.10× |
| 2 | +20% | 1.20× |
| 3 | +30% | 1.30× |
| 5 | +50% | 1.50× |
| 10 | **+100%** | **2.00×** |

### 2.2 邀请规则（一层，不可改）

- 用户主动发 `SetReferrer` 绑定邀请人，**一次性、不可改**，禁止自邀、禁止互相绑定（A→B 后 B 不能再→A）
- 只有「直接邀请人」享受加成（一层，无多级分销）
- 被邀请人必须 ≥ 10,000 A9（最低质押额）才算有效
- 加成封顶 = 邀请人自己的质押额（即最多让自己的权重翻倍）

### 2.3 稀释量化（必须向用户披露）

R10 时，若 50% 质押来自「10 轮老兵」、50% 来自新人：

| 群体 | 质押占比 | 权重倍数 | 奖励份额 | 每单位 A9 的相对收益 |
| --- | --- | --- | --- | --- |
| 老兵 | 50% | 2.00× | 64.5% | **1.29×** |
| 新人 | 50% | 1.10× | 35.5% | **0.71×** |

> 新人每单位 A9 的收益是老兵的 55%。这是「大胆」的代价，也是老兵的留存钩子。新人可以通过**邀请**把权重补回来。

---

## 3. 奖励三态状态机

每个 (用户, 轮次) 的奖励只有一个状态：

| 状态 | 值 | 触发 | 结果 |
| --- | --- | --- | --- |
| `PENDING` | 0 | 默认（结算时写入） | 锁到 R10 结束后 12 个月线性解锁，100% |
| `ROLLED` | 1 | `RollReward(roundId)` | 全额计入下一轮质押，**下一轮可归零** |
| `EARLY` | 2 | `ClaimRewardEarly(roundId)` | 立即领 **50%**，另 50% 留在金库（不归团队、不销毁、计入 R10 后解锁池） |

- 三态互斥、幂等（重复调用返回错误或空操作）
- 状态只能从 `PENDING` 迁出，**不可回退**
- 早领的 50% 罚没部分进入「R10 后解锁池」，与 PENDING 奖励一起线性解锁（**不是销毁**，避免激励不一致）

### 3.1 滚存上限（关键约束）

| 约束 | 值 | 说明 |
| --- | --- | --- |
| 单地址单轮滚存上限 | 20,000,000 A9 | 与单地址质押硬顶一致 |
| 单轮总质押上限 | 200,000,000 A9 | 滚存 + 新押合计 |
| 超出部分 | 自动转为 `PENDING` | 锁到 R10 后，不会丢失 |

### 3.2 安全性证明：滚存不会超过每轮奖励

```
滚存总额 ≤ 单轮总质押上限 200,000,000 A9
每轮奖励池 = 700,000,000 A9
→ 滚存 / 奖励 = 28.6%  <  100%   ✅ 永不超发
```

极端情形（单人押满 20M、连赢 10 轮，滚存封顶 20M）：

| 轮次 | 质押 | 奖励 | 滚存 | 锁定累计 |
| --- | --- | --- | --- | --- |
| R1 | 20M | 700M | 20M | 0.68B |
| R5 | 20M | 700M | 20M | 3.40B |
| R10 | 20M | 700M | 20M | 6.80B |
| **合计** | — | **7.0B** | 200M | 6.80B |

10 轮总奖励 7.0B A9 **正好等于 70% 奖励池**，无超发。

### 3.3 现实情形（赢 1 轮，概率 ~0.1%）

奖励 700M → 滚存 20M + 锁定 680M → 12 个月线性 = **每月 5,670 万 A9**（按 R1 目标价 $0.00232 ≈ **$13.1 万/月**）。

> **已确认（V8）**：冷启动池从 1 亿 A9 提到 **2 亿 A9 + $232,000 USDT**（占流动性额度 40%，剩余 3 亿 A9 后续加池）。解锁期**维持 12 个月线性**（风险已记录：赢 1 轮时每月 5,670 万 A9 卖压，需靠做市与加池承接）。

---

## 4. 合约改动规格

### 4.1 不新增合约，不拆合约

| 合约 | 是否改动 | 说明 |
| --- | --- | --- |
| RoundController | **改** | 权重、三态、滚存、连续、邀请 |
| TeamVault | 不改 | — |
| JettonMaster / JettonWallet | 不改 | — |

**为什么不在链上拆出「奖励合约」**：拆分会新增 2 条跨合约消息路径、2 个失败重试点、审计面翻倍，收益只有「代码行数变少」。

### 4.2 新增 opcode

| opcode | 名称 | 参数 | 权限 |
| --- | --- | --- | --- |
| `0x52540017` | `ClaimRewardEarly` | roundId | 本人 |
| `0x52540018` | `RollReward` | roundId | 本人 |
| `0x52540019` | `SetReferrer` | referrer | 本人（一次性） |
| `0x5254001A` | `ClaimUnlocked` | 无 | 本人（R10 后按线性解锁领取） |

### 4.3 新增 get 方法

| 方法 | 返回 |
| --- | --- |
| `get_reward_state(owner, roundId)` | (amount, state, rollable, earlyAmount) |
| `get_unlock_info()` | (unlockStart, totalLocked, claimed) |
| `get_referral(owner)` | (referrer, referredStakeThisRound, bonusThisRound) |
| `get_streak(owner)` | (lastRound, count) |

### 4.4 Storage 变更

```tolk
// 新增到 Storage（各自独立 ref，不挤主 cell）
referrer: map<address, address>              // 一次性绑定
streaks:  map<address, StreakInfo>           // {lastRound: uint8, count: uint8}

// RoundData 变更
- candles: map<uint8, CandleRecord>          // 删除（见 §4.5）
+ candleHash: uint256                        // 滚动哈希
+ totalWeight: uint128                       // Σ weight（含所有加成）
+ bonus: map<address, uint128>               // 邀请加成累计（已封顶）

// StakePosition 变更
+ weight: uint128                            // 入账时算好的 ownWeight
+ rewardState: uint8                         // 0 PENDING / 1 ROLLED / 2 EARLY
```

### 4.5 优化 ①：K 线逐条存储 → 滚动哈希（−40 行，存储 −240 条）

```
SubmitCandle(roundId, candleIndex, periodStart, periodEnd, twapUsdE8, dataDigest):
    require candleIndex == candlesSeen            // 必须顺序提交
    require periodStart == observationStart + candleIndex × 3600
    candleHash = sha256(candleHash ‖ index ‖ twap ‖ digest)
    candlesSeen++
    if twap >= targetPrice: qualifiedCandles++
```

- 逐条 K 线数据留在**链下公开可查**（worker API + 归档）
- 任何人可用公开的 24 条数据重算 `candleHash` 与链上对账
- **可验证性不降级，链上存储从 240 条降到 10 条**

### 4.6 优化 ②：领取接口保持 ABI 不变（**不做三合一**）

原计划把 `ClaimPrincipal` / `ClaimReward` / `ClaimAll` 合成一个，**决定放弃**：

- 合并会改 ABI → 前端 BOC 构造要改 → 已完成的链上模块要重测
- 省 40 行代码，换来一次前端回归 + 一次 ABI 变更，**不划算**

改为**纯增量**：保留 3 个旧 opcode，新增 4 个 opcode（§4.2）。旧接口语义不变。

### 4.7 权重计算位置（性能关键）

**不遍历**：在质押入账时增量累计，结算/领取时只做除法。

```
onDeposit(u, amount, round):
    streak = (lastRound[u] == round-1) ? streak[u]+1 : 1
    ownWeight = amount × (1 + 0.10 × min(streak,10))
    stake[u].weight += ownWeight
    round.totalWeight += ownWeight

    if referrer[u] != null and amount >= MIN_STAKE:
        room  = stake[referrer[u]].amount - round.bonus[referrer[u]]
        add   = min(0.20 × amount, room)
        round.bonus[referrer[u]] += add
        round.totalWeight += add

reward(u, round) = 700M × (stake[u].weight + round.bonus[u]) / round.totalWeight
```

复杂度：每次质押 O(1)，结算 O(1)，领取 O(1)。**无循环、无遍历、gas 与用户数无关。**

### 4.8 Gas 估算

| 操作 | 现状 | V8 | 变化 |
| --- | --- | --- | --- |
| 质押入账 | ~0.05 TON | ~0.06 TON | +1 次 map 写（streak） |
| SubmitCandle | ~0.05 TON | ~0.045 TON | 少写 1 条记录 |
| ClaimReward | ~0.05 TON | ~0.05 TON | 不变 |
| RollReward | — | ~0.06 TON | 新增 |
| ClaimRewardEarly | — | ~0.05 TON | 新增 |

> 全部 < 0.1 TON，用户可接受；首次质押 gas 代付预算按 0.1 TON/人估算。

---

## 5. 测试清单（新增 ≥ 18 个用例）

### 权重
1. 连续 1/2/3/5/10 轮 → 权重 1.10/1.20/1.30/1.50/2.00×
2. 断一轮 → streak 归零
3. 滚存不中断 streak
4. 邀请加成 = 20% × 被邀请人质押
5. 邀请加成封顶 = 自己质押额
6. 自邀被拒 / 互相绑定被拒 / 二次绑定被拒
7. 被邀请人 < 10,000 A9 不计入

### 三态
8. PENDING → ROLLED（全额进下一轮质押）
9. PENDING → EARLY（只付 50%）
10. ROLLED 后再 Claim 被拒（幂等）
11. EARLY 后再 Roll 被拒（互斥）
12. 滚存后下一轮失败 → 滚入的 A9 被销毁
13. 滚存超过 20M → 截断，超出转 PENDING
14. 滚存导致总质押超 200M → 截断

### 解锁
15. R10 前 `ClaimUnlocked` 被拒
16. R10 后按 12 个月线性释放（1/12 每月）
17. 早领罚没的 50% 计入解锁池

### 不变量
18. **每轮 Σ reward ≤ 700M 且永不超发**（floor 派发 + 余数留金库；等权重时精确等于 700M。**不要求链上恒等**——否则需要结算遍历，gas 随用户数增长，违背 O(1) 红线）
19. 滚存总额 ≤ 200M（< 700M，永不超发）
20. streak / weight / bonus 的单调性与幂等性

---

## 6. 迁移与回滚

| 项 | 方案 |
| --- | --- |
| 已部署测试网实例 | **必须重新部署**（RC 不可升级，storage 布局变了） |
| 前端 | 新增 4 个 opcode 的 BOC 构造 + 三态 UI；旧接口不动 |
| worker / D1 | 新增字段：weight、streak、referrer、rewardState、unlockStart |
| 回滚 | 无链上回滚；保留旧版本 code hash 与地址，必要时重新部署旧版 |

---

## 7. 与 V7 的差异汇总

| 项 | V7 | V8 |
| --- | --- | --- |
| 奖励分配 | 纯按质押比例 | **按权重**（质押 × 连续 + 邀请） |
| 奖励领取 | 结算后可立即全额领取 | **三态**：滚存 / 早领 50% / 锁到 R10 后 |
| K 线存储 | 24 条/轮逐条上链 | **每轮 1 个滚动哈希** |
| 领取 ABI | 3 个 opcode | **不变**（新增 4 个） |
| 每轮奖励 | 700M | **不变** |
| 2× / 24 根 / 16 阈值 / 时间线 / 罚没 / TeamVault | — | **全部不变** |

---

## 8. 待确认（实现前必须拍板）

1. 连续档位 **10%/轮封顶 10 轮（+100%）** 是否最终确认？（稀释代价见 §2.3）
2. 早领罚没的 50% 进入「R10 后解锁池」而不是销毁 —— 确认？
3. ~~流动性~~ **已确认**：2 亿 A9 + $232,000 USDT（§3.3）；解锁期 **12 个月线性不变**。


---

## 9. 实施与冻结状态

- 本规格（V8 权重制 + 奖励三态）**已实现并冻结**：tag `v8.6-audit-fixed` @ `c24809a`（HEAD）。
- 自研合约：RoundController、TeamVault、OracleAdapter；Jetton Master/Wallet 为 Tolk 复刻。
- 冻结基线与 5 个 code hash 见 **docs/18 §8**（以该表为准；OracleAdapter hash 以 c24809a 版本为准）。
- 验证：`acton check` 0 error 0 warning；`acton test` **154 passed / 15 files**；`acton build --clear-cache` OK。

## 10. 测试与部署基线

- 测试：154 passed / 15 files（含 C-1~C-4 新增用例与真 Jetton 两跳集成测试）。
- 部署：`deploy-emulation.tolk` 支持**全新空链一条命令完整部署**（JettonMaster → mint 100 亿并永久关闭 → OracleAdapter/TeamVault/RoundController → 全套 wiring → RC 7e18 / TV 1.2e18 raw A9 注入 + 回读校验）。
- **运维要点：JettonWallet 代码变更会导致所有 jetton wallet 地址变化，必须干净重部署，不能 resume。**

## 11. Arch-fix log（合约冻结后补丁）

### C-1 滚存必须在合约内校验报名截止时间（P1）

- **缺陷**：`RollReward` 仅校验下一轮为 PREVIEW / STAKING_OPEN，**未校验 STAKING_OPEN 轮的 `stakeCloseAt`**；keeper 未及时关窗时，过期轮仍接受奖励滚存。
- **影响**：奖励进入已过期轮次，状态/资金归属错误；不能只依赖 keeper 及时关窗。
- **修复**：`STAKING_OPEN` 分支增加 `assert(now < nextRd.stakeCloseAt) throw RollNotAvailable`。
- **测试**：`C-1 roll into an expired open round is rejected`（`contracts/tests/rewards-v8.test.tolk`）。
- **链上证据**：旧 v8.5 在 testnet-ops 实测关窗后 RollReward 返回 `accepted:true`（`ops/records/fasttest-runner-2026-11-05T16-17-19-990Z.jsonl` 的 `defect-roll-after-close`），新实例必须 `accepted:false`。
- **完整修复批 C-1~C-4**（含 C-2 OracleAdapter 首根 K 线 / C-3 转发失败回滚 / C-4 两跳 bounce）见 **docs/18 §14**。
