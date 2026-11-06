# 28 — M4.1 定向复核包（v8.8 delta）

> 用途：M4 复核结论为 **PASS**，但发现 1 项 Critical 资金漏洞 + 1 项口径不一致。已修复为 **v8.8**，请做定向复核（只需看 2 个 commit 的 diff）。
> 冻结版本：`v8.8-audit-fixed` @ `fb6bb45`

## 1. M4 复核结论摘要（已确认）

| 项 | 复核方结论 | 我方处置 |
| --- | --- | --- |
| F1 双路径困惑副手 | PASS（销毁路径 + 转账路径均封堵） | 无需改动 |
| F3 幂等清 dispatched | PASS（重复/迟到/终态后通知均无害） | 无需改动 |
| F4 OOG 保底送达 | PASS（`BOUNCE_NOTIFICATION_RESERVE = 0.015 TON`） | 无需改动 |
| F5 ResetRoundCandles 权限 | PASS（仅 OA admin / RC） | 无需改动 |
| F6 入站金额下限 | PASS | 无需改动 |
| F7 / F8 / F9 / F10 / F12 | PASS | 无需改动 |
| F11 | 同意不改 | 无需改动 |
| 假阳性 K（R10 后 ClaimAll 早领） | 确认不成立（三处守卫） | 无需改动 |
| 假阳性 L（SetJettonWalletCode 未锁） | 确认不成立（`currentRoundId == 0` 断言存在） | 无需改动 |
| **F2 细节 A（Critical）** | **已领取的旧退款余额被重复计入 → 可从 RC 抽走 A9** | ✅ **已修（A9-M4-01）** |
| **F2 细节 B（口径）** | `get_claimable_all` 计入 round 0，但 `ClaimAll` 不扫 round 0 | ✅ **已修（A9-M4-02）** |

## 2. v8.8 的两处改动（完整 diff 范围）

### A9-M4-01（commit `7445a8d`）— Critical

`RoundController.tolk` `creditRefundLedger`：

```tolk
// 修复前：已领取的旧余额被重复累计
pos.amountRaw = pos.amountRaw + (amount as uint128);

// 修复后：已领走的旧余额不参与累计
val carry: uint128 = pos.principalClaimed ? 0 as uint128 : pos.amountRaw;
pos.amountRaw = carry + (amount as uint128);
pos.principalClaimed = false;
```

正确性论证：
- `claimed=true`（已领走）→ carry=0，只累计新退款 ✓
- `claimed=false`（未领）→ carry=旧余额，正确累加 ✓
- 领取后 bounce → `rollbackPendingClaim` 把 `claimed` 置回 false，`amountRaw` 未被改动，仍可领取 ✓

### A9-M4-02（commit `eeba2e1`）— 口径一致性

`get_claimable_all` 移除 round 0 退款计入，与 `handleClaimAll`（只扫 1..10）一致；退款统一走 `ClaimPrincipal(roundId=0)`。

## 3. 回归测试（新增 2 条，均为真 JettonWallet）

| 测试 | 断言 |
| --- | --- |
| `M4-01 claimed refund carry cannot be withdrawn twice` | 1000 退款 → 领取 → 再 2000 退款 → 账本 = **2000**（不是 3000）；二次领取只得 2000；`get_claimable_all.principalRaw == 0` |
| `M4-01 refund claim bounce preserves ledger amount and claimability` | 领取 bounce 后 `amountRaw=1000`、`claimed=false`，可再次领取 |

**修复前失败证据**：临时回退 carry 修复后运行第一条测试 → 实际 **3000** vs 期望 **2000**，确认测试能捕获该漏洞。

## 4. 链上回归（测试网 v8.8 实例）

实例：RC `kQAIVoxXHrWkiH88k9yq_DPKiJR8-IfIf2BdeoocUsgGJs6F`，code hash `0x4EE42C5C…3EF8`（其余 4 合约与 v8.7 相同）。

攻击链实测（攻击者 A，初始 A9 = 800,000）：

| 步骤 | 结果 |
| --- | --- |
| 1. 低 gas 无效质押 X = 100,000 | `get_user_stake(0).amountRaw = 100,000` |
| 2. `ClaimPrincipal(0)` | A9 700,000 → 800,000（+100,000）|
| 3. 再低 gas 无效质押 Y = 200,000 | **`amountRaw = 200,000`（不是 300,000）** ← 修复生效 |
| 4. `ClaimPrincipal(0)` | A9 600,000 → 800,000（+200,000）|
| 5. 最终 | A9 = 800,000，**净收益 0** |
| 6. `get_claimable_all.principalRaw` | 领取前后均为 **0**（第二处修复生效）|
| 7. RC 的 TON | 未下降（0.768 → 1.307，低 gas 留存 + claim 附值）|

**Lead 独立复核**：查询 A 的 round-0 账本，`amountRaw = 200,000 A9`、`principalClaimed = true`，与上述一致。

## 5. v8.8 冻结基线

| 合约 | Code Hash | 与 v8.7 |
| --- | --- | --- |
| RoundController | `0x4EE42C5C0EB13CDB6689823BEA883D30E852EEA066D3C108A6531A69D4093EF8` | **变更** |
| JettonWallet | `0xC40F41ED05BEFFB7EF17E25FA0D1BB2AFDA72C567052546A2E310C0275D31D13` | 不变 |
| JettonMaster | `0xB8FAF413176C6329A98B2474FEDF765A796A14EDA96C031EE1FE5B27E59EE272` | 不变 |
| TeamVault | `0xDE6BE49154E3024C9B6945EA81E7181F3E1D04FECC85DBC629C08EDE6A673FB6` | 不变 |
| OracleAdapter | `0x0C91E5338E00F18B5FFC7C5C26B510424775D8089588F4147E5B667703676768` | 不变 |

验证：`acton check` 0 error 0 warning；`acton test` **177 passed / 18 files**。

## 6. 请复核方确认

1. **A9-M4-01 的修复是否彻底**：`carry` 逻辑在「已领 → 再退 → 再领」循环下是否恒定正确；是否存在第三条产生重复余额的路径（例如 `debitRefundLedger` 与 `creditRefundLedger` 交错）。
2. **bounce 路径**：领取后 bounce 把 `claimed` 置回 false、`amountRaw` 不变——是否与新的 carry 逻辑组合出意外状态。
3. **A9-M4-02** 是否同意「round-0 退款不进 `get_claimable_all`」这一口径（vs 让 `ClaimAll` 也处理 round 0）。
4. 是否同意 v8.8 只需定向复核（diff 仅 2 处，RoundController 一个 hash 变化），无需重跑完整 M4。

## 7. 复现

```bash
git checkout v8.8-audit-fixed
cd contracts && acton build --clear-cache && acton check && acton test   # 期望 177 passed / 18 files
```

diff：`git diff v8.7-audit-fixed v8.8-audit-fixed -- contracts/`