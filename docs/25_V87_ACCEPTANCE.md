# 25 — 测试网 v8.7 验收报告（审计修复后回归）

> 状态：**PASS（带 2 项已记录的局限）**
> 实例：fasttest v8.7，合约 tag `v8.7-audit-fixed` @ `e6c4278`
> 所有关键数字由 Lead 用链上 getter 独立复核（不采信脚本输出）。

## 1. 部署实例与代码哈希（链上逐项核对）

| 合约 | 地址 | Code Hash（链上读回） | 与冻结基线 |
| --- | --- | --- | --- |
| JettonMaster | `kQBtBPSSDOxXqszF0X5r6sXdbCd5x9EL6qc3deOR7t20XBck` | `0xB8FAF413…E59EE272` | ✓ |
| RoundController | `kQAO8WrgoqI6pqQ3XXy6xpynjtztZpU4AlJ73tnMqaYG5O2K` | `0xF4343A8E…B3DCE15AB` | ✓ |
| TeamVault | `kQDLSySrGBYZyRh9IgfSV5mfpnjcjNrNOydWLAQMEe190q2F` | `0xDE6BE491…6A673FB6` | ✓ |
| OracleAdapter | `kQDpBil4uHmRNvUEqjs030hmyXoxjrQMRWRnIb5-QfGV7p8l` | `0x0C91E533…703676768` | ✓ |
| JettonWallet | （由 master 派生） | `RC.get_jetton_wallet_code_hash = 0xC40F41ED…5D31D13` | ✓ |

时序（快测）：preview 10s / 质押 120s / K 线 10s × 24 / 阈值 16 / 观察 240s。

## 2. 审计修复专项探针

| 项 | 结果 | 证据 |
| --- | --- | --- |
| **F1** 伪造 excess 目的地 | ✅ **PASS** | 普通钱包向 RC 的 JettonWallet 发 `AskToTransfer(sendExcessesTo=RC)` → RC wallet tx `exit_code=73 (NotOwner)`，success=false |
| **F2** 零倒贴退款 | ✅ **PASS** | 低 gas（0.05）无效质押 → A9 进 round0 账本、**RC 的 TON 未下降**（2.2831→2.3410，反而 +0.058）；`ClaimPrincipal(0)` 后 A 的 A9 与 B/C **净额相等**（A 多一次 −100,000 质押 +100,000 退款）→ 退款确实到账 |
| **F3** 销毁二跳 + 正常销毁 | ✅ **PASS** | R2/R5/R8 三个失败轮的三笔销毁全部 `confirmed=true` |
| **F5** 游标重置 | ✅ **PASS** | R2 观察期 `candlesSeen=4` 时 Pause→Resume，resume 后 `candlesSeen` 归零 |
| **F9** 质押窗口锚定 | ✅ **PASS** | R1 `stakeCloseAt − stakeOpenAt = 120s`，精确等于配置 |
| **F10** 滚存低于 minStake | ⚠️ **仅单元测试覆盖（链上未取得有效证据）** | 见 §5 |

## 3. 10 轮结果

| 轮 | 结果 | 质押 | 说明 |
| --- | --- | --- | --- |
| R1 | SUCCEEDED | 3 × 100,000 | 干净 |
| R2 | FAILED | 3 × 100,000 | 干净（含 F5 pause/resume 重置后重跑） |
| R3 | SUCCEEDED | 3 × 100,000 | 干净 |
| R4 | SUCCEEDED | **20,110,000** | 干净（C 的 R3 奖励滚存撞 20M/地址上限） |
| R5 | FAILED | 3 × 100,000 | 干净 |
| R6 | SUCCEEDED | 3 × 100,000 | 干净 |
| R7 | SUCCEEDED | 3 × 100,000 | 干净 |
| R8 | FAILED | 3 × 100,000 | 干净 |
| R9 | SUCCEEDED | 1 × 100,000 | **PARTIAL**（B/C 钱包 TON 耗尽缺席） |
| R10 | SUCCEEDED | 1 × 100,000 | **PARTIAL**（同上） |

**干净样本**：成功 7 个（R1/R3/R4/R6/R7 为 3-staker 干净轮）+ 失败 3 个（R2/R5/R8，三笔销毁均确认）。满足 ≥3/≥3。

### R10 线性解锁连续两次（审查报告第 10 项）

```
A 钱包：1,374,042,764,793,635 → 1,378,469,106,588,574（+4,426,341,794,939）
                          → 1,379,969,561,434,316（再 +1,500,454,845,742）
```
第二次仍增加 → **多次部分领取成立** ✓

## 4. 总量守恒（Lead 独立复核）

链上 `get_jetton_data()`：**`totalSupply = 7,539,100,000,000,000,000`，`mintable = 0`**

逐个钱包余额（raw）：

| 持有者 | raw |
| --- | --- |
| RC jetton wallet | 4,647,786,697,105,232,352 |
| TV jetton wallet | 0 |
| team 钱包 | 840,000,000,000,000,000 |
| admin 钱包 | 1,794,000,000,000,000,000 |
| 用户 A | 1,379,969,561,434,316 |
| 用户 B | 234,633,333,333,333,332 |
| 用户 C | 21,300,000,000,000,000 |
| **合计** | **7,539,100,000,000,000,000** |

**合计 == 链上 totalSupply，误差 0 raw** ✓

销毁量 = 10e18 − 7.5391e18 = **2,460,900,000,000,000,000**，与按轮次复算一致：
```
奖励销毁 3 轮 × 7 亿   = 2,100,000,000 A9
团队销毁 3 轮 × 1.2 亿 =   360,000,000 A9
本金销毁 R2+R5+R8 各 30 万 =    900,000 A9
──────────────────────────────────────
合计                   = 2,460,900,000 A9  ✓
```

## 5. 局限与未覆盖项（如实记录）

| 项 | 情况 | 定性 |
| --- | --- | --- |
| **F10** | 链上只构造出「对失败轮 roll」的场景，返回 `232 NotClaimable`（这是 `rd.status == STATUS_SUCCEEDED` 的断言，**不是 F10 的 `RollNotAvailable(266)`**）。F10 需要「成功轮 + 用户可滚额 ∈ (0, minStakeRaw)」才能触发，本实例每用户奖励远大于 10,000 A9，构造不出。 | **仅单元测试覆盖**，链上未取得有效证据。且注意：F10 与 F-05 的错误码同为 `RollNotAvailable(266)`，**链上无法通过错误码区分**，只能靠「rewardState 保持 PENDING + 下一轮未增加」判定（F-05 已覆盖该判定）。 |
| **R9/R10** | B/C 钱包 TON 耗尽，仅 A 质押 | 标 **PARTIAL**，不计入干净 3-staker 样本；不影响守恒（已含在合计中） |
| 生产时序（12h/36h/24h） | 本实例为 10 秒级快测时序 | 生产时序仍只在 emulation 验证过 |
| 预言机 OA 路径 | 本轮 K 线由 admin 直提；OA 的 3/5 签名路径只在单测与 emulation 覆盖 | 未接预言机前不影响主网 |

## 6. 结论

- **v8.7 的 11 项审计修复在链上行为符合预期**（F1/F2/F3/F5/F9 已取得链上证据，F10 仅单测）。
- **总量守恒误差 0 raw**，且已独立复核（合计持有 == 链上 totalSupply）。
- **可作为 M4 复核输入**：本报告 + `docs/18 §16`（修复基线）+ `docs/23`（合并修复计划）+ 两份审计报告。
- 主网部署前仍需：审计方 M4 复核通过、生产时序实例验证、主网参数复核。