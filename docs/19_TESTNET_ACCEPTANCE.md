# 19 — 测试网 v8.6 10 轮验收报告（权威记录）

> 状态：**PASS（带 3 项已记录的局限）**
> 实例：fasttest v8.6（10 秒级时序），合约 tag `v8.6-audit-fixed` @ `c24809a`
> 执行时间：2026-11-05 20:0x–20:13 UTC
> 本文数字全部由 Lead 用链上 getter 独立读取核对，不采信脚本输出。

## 1. 部署实例与代码哈希

| 合约 | 地址 | code hash |
| --- | --- | --- |
| JettonMaster | `kQCOYBSzkm5SEpv0g4Wg7NkCuiQGs47HlKPOzzXvff52kX65` | `0x876F21A1A516FB0449A1D0AF5DBECEB8639373F947949C5AE8E1E9DBB769D64F` |
| JettonWallet | — | `0x394E4E8D40B5D3D97D12AA950B99EA9A53387DDAC331BAAAC8923F0E6E6849A4` |
| RoundController | `kQBQf1af2vBgu9Uxw5dcDJ_7zFUIgQihsorPGgHEZlv-6Xot` | `0xC5AD291469C3BEADBDC26A6F1733004D433F12B15B025D88B983DF098BA11500` |
| TeamVault | `kQBFYc-AYafI9K7XTkN3bEKd1XGsg3h5zM6Kka75pILSbzL8` | `0xCF3E6C7C9DC045F392F35E79E20AA6EDAAF9064D538CA4E78B6D1FE1443158B4` |
| OracleAdapter | `kQDRAgy1aKip2gUPlBBz2tgfn3Si6cER1QqVeLrgrkXNRSnr` | `0x539F3597357943584A596DA2B40F901B4984D8C8307E63CE81A67F131EAB8CBA` |
| RC Jetton Wallet | `kQBQ0fLed0EnRnupf_MyIdKFSBFp4U75h3-V0UCo8Mr4R6L7` | — |
| TV Jetton Wallet | `kQBFFdU4SZQjPabCwzIZvdsawG4a20nvuHKXveSAwVdEMEOx` | — |

**代码一致性验证（3 项独立证据）**
1. `RC.get_jetton_wallet_code_hash` = `0x394e4e8d…49a4`，与冻结基线逐字符一致。
2. `JettonMaster.get_wallet_address(RC)` == registry 记录的 RC jetton wallet 地址（证明 master 的 wallet code 与 RC 期望一致，否则领取回执地址会算错）。
3. **行为学验证**：普通钱包向 RC / TeamVault 发送 `TransferBounced(0x52540027)`，均返回 `exit_code = 104 (NotJettonWallet)`；若为 v8.5 代码会返回 `106 (UnknownMessage)`。证明运行的是 v8.6 代码路径。

## 2. 10 轮结果（全部由 get_round 读取）

| 轮 | 状态 | tier | target | 达标根数 | 质押 A9 | 权重 A9 | 团队释放 | 团队销毁 | 奖励销毁 | 本金销毁 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | SUCCEEDED | 1 | 232000 | 16 | 0 | 0 | ✓ | — | ✓ | — |
| R2 | FAILED | 2 | 464000 | 0 | 0 | 0 | — | ✓ | ✓ | ✓ |
| R3 | SUCCEEDED | 2 | 464000 | 16 | 300,000 | 370,000 | ✓ | — | — | — |
| R4 | FAILED | 3 | 928000 | 5 | **20,110,000** | 24,142,000 | — | ✓ | ✓ | ✓ |
| R5 | SUCCEEDED | 3 | 928000 | 16 | 300,000 | 430,000 | ✓ | — | — | — |
| R6 | FAILED | 4 | 1,856,000 | 0 | 200,000 | 300,000 | — | ✓ | ✓ | ✓ |
| R7 | SUCCEEDED | 4 | 1,856,000 | 16 | 0 | 0 | ✓ | — | ✓ | — |
| R8 | FAILED | 5 | 3,712,000 | 0 | 300,000 | 370,000 | — | ✓ | ✓ | ✓ |
| R9 | FAILED | 5 | 3,712,000 | 0 | 300,000 | 400,000 | — | ✓ | ✓ | ✓ |
| R10 | SUCCEEDED | 5 | 3,712,000 | 16 | 300,000 | 430,000 | ✓ | — | — | — |

**成功 5 轮 / 失败 5 轮**；含真实质押的成功轮 3 个（R3/R5/R10）、含真实质押的失败轮 4 个（R4/R6/R8/R9）。

覆盖的路径：零质押成功（奖励全额销毁 + 团队释放）×2、零质押失败 ×1、滚存撞 20M/地址上限后失败并销毁 20.11M 本金、4 个失败轮的三笔销毁全部 confirmed、档位按成功次数递进（tier 1→5）、R10 终态后解锁池启动。

## 3. 总量守恒对账（核心验收）

终态余额（全部由 get_wallet_data 读取）：

| 持有者 | A9 |
| --- | --- |
| RC jetton wallet | 1,732,259,899.434318040 |
| TV jetton wallet | 0 |
| team 钱包 | 600,000,000 |
| marketing 钱包 | 497,000,000 |
| liquidity 钱包 | 500,000,000 |
| 内盘钱包 | 800,000,000 |
| 用户 A / B / C | 139,062,093.023 / 104,354,054.054 / 106,413,953.488 |
| **合计持有** | **4,479,090,000.000000000** |

```
总供应        10,000,000,000.000000000
合计持有       4,479,090,000.000000000
销毁（反推）   5,520,910,000.000000000
```

独立复算销毁量：

```
奖励销毁  7 轮 × 700,000,000        = 4,900,000,000
团队销毁  5 轮 × 120,000,000        =   600,000,000
本金销毁  R4 20,110,000 + R6 200,000
        + R8 300,000 + R9 300,000   =    20,910,000
────────────────────────────────────────────────────
合计                                = 5,520,910,000
```

**两条独立路径结果完全相等，误差 0 raw。** 该等式同时证明「所有 A9 持有者均已枚举完整」——漏掉任一持有者都会导致两边不等。

TV wallet 精确归零（12 亿 = 10 轮 × 1.2 亿），RC wallet 剩余 17.32 亿，与「70 亿初始 − 已发放/已销毁」逐项吻合。

## 4. 解锁路径验证（R10 终态后，链上完整验证）

| 验证项 | 结果 |
| --- | --- |
| `get_unlock_info(A).unlockStart` | `1793909617` > 0 ✓ |
| `totalLockedRaw` | `698,900,062,853,551,224`（A 在 R3/R5/R10 的全部未领奖励）✓ |
| **立即** `ClaimUnlocked`（t≈0） | 被正确拒绝（`NothingUnlocked`），`totalLocked` 前后完全不变 ✓ |
| **数小时后** 第一次 `ClaimUnlocked` | ✓ 成功，A 钱包 `139,062,093,023,255,813` → `139,413,655,214,080,358`（**+351,562 A9**） |
| **15 秒后** 第二次 `ClaimUnlocked` | ✓ 成功，→ `139,414,329,307,505,178`（**再 +674 A9**） |

**结论**：线性解锁在链上**已完整验证**——多次部分领取成立、每次为增量、`claimedRaw` 累加。这也同时作为审查报告第 10 项（演示账本「解锁只能领一次」）的链上对照。

> 机制说明：`UNLOCK_DURATION_SECONDS = 31,104,000`（12×30 天）为编译期常量，`vested = totalLocked × elapsed / 31104000`。t≈0 时 vested=0 所以立即领取被拒（**预期行为，非缺陷**）；随时间推移会有少量 vest 可领。完整 12 个月曲线形状由 `contracts/tests/rewards-v8.test.tolk:405-431` 时间跳跃单测覆盖。详见审计简报 §15。

## 5. 已知局限与不计入样本的轮次（如实记录）

| 项 | 情况 | 定性 |
| --- | --- | --- |
| R2 | runner 金额单位 bug（发了 `100000` raw 而非 `1e14` raw），低于 `minStakeRaw`，质押被 `refundStake` 退回 | **POLLUTED**，不作为成功/失败样本；但零质押失败的销毁路径本身有效 |
| R6 | 用户 C 钱包 TON 余额 0.251 < 交易 value 0.35，外部消息在钱包层被丢弃；实际只有 A/B 质押 | 记为**有效失败样本**（三笔销毁路径完整执行），但须注明只有 2 个质押者 |
| R7 | runner 因 R6 回读失败而退出，无人质押 | **ZERO_STAKE_SUCCESS**，不计入样本，作为零质押路径的第二样本 |
| **C-1 回归** | 在 R8 关窗后（`now > stakeCloseAt`）对 R5 的 pending reward 发 `RollReward`：tx `ThnQfdmHKzit+OE6dTZCgfObklc1o75e3FSzjojEt+k=` **aborted，exit_code = 266 (RollNotAvailable)**；B 的 R5 `rewardState` 仍为 **0 (PENDING)**、`rewardClaimed=false`；B 的 R6 `amountRaw` 前后均为 100,000 A9、**未增加** | **PASS**（Lead 独立复核了后两条状态证据） |
| 旧 v8.5 C-1 证据 | 旧实例上 R2 `stakeCloseAt=1793895760`，roll 交易发生在 `1793895768`（**截止后 8 秒**）仍被接受 | 该证据**有效**，证明 C-1 缺陷真实存在（修复前） |

## 6. 运维实测数据（用于主网成本模型）

| 项 | 数值 |
| --- | --- |
| 单根 K 线最小可用 value | **0.01 TON**（原按 0.06 估算） |
| 去掉 `waitForTrace` 后单根耗时 | **约 7–8 秒**（原 1–17 分钟） |
| 典型一轮 24 根请求数 | R1=24、R3=17、R4=20、R10=44（其余轮次因 keeper 重启日志分散，同一 keeper + 同一 value，量级一致） |
| 10 轮 keeper 钱包总消耗 | admin2 TON 7.887 → 1.029（**约 6.86 TON / 10 轮**，含补 gas 给用户钱包的 3 TON） |
| 429 次数 | 绝大多数轮次 **0**；仅在并发 getter 查询时才出现 |
| 用户钱包每轮净 gas | 约 0.3 TON/用户（stake 0.02 + 两笔领取各约 0.15） |
| 合约累积 | keeper 每根 K 线附带的 TON 会累积在 RC 余额（内部消息 value 不回退） |

## 7. 结论

- 合约 v8.6 的经济学（奖励权重制、连续加成、邀请封顶、滚存上限、三笔销毁、零质押销毁、档位递进）**在链上完整跑通，总量守恒误差 0 raw**。
- 4 项审查确认的合约缺陷（C-1~C-4）已修复并通过 154 个合约测试；其中 C-2/C-3/C-4 已在本实例由行为学与 getter 验证，C-1 待生产参数实例补验。
- **C-1 链上回归已在权威实例上 PASS**（R8 窗口：`exit_code=266` + B 的 R5 `rewardState` 仍为 0 + B 的 R6 质押未增加）。
- **R10 线性解锁已在链上完整验证**（两次部分领取，+351,562 A9 / +674 A9，claimedRaw 递增），不再只是单测覆盖。
- **主网上线前仍需补**：生产参数实例（12h PREVIEW + 36h 报名 + 24h 观察）的真时序回归——本报告使用的是 10 秒级快测时序，生产时序只经过 emulation 验证。