# 26 — 审计 M4 复核包（v8.7 修复后）

> 用途：发给两位审计方执行 M4（复核）阶段。所有材料均已入库，路径直接可用。
> 冻结版本：`v8.7-audit-fixed` @ `e6c4278`

## 1. 给审计方的材料清单

| # | 文件 | 用途 |
| --- | --- | --- |
| 1 | `docs/18_AUDIT_BRIEF.md` **§16** | v8.7 冻结基线（5 个 code hash）、11 项修复清单、3 项明确不修及理由 |
| 2 | `docs/23_AUDIT_TRIAGE.md` | 两份报告的**交叉核实结论**（含 2 项假阳性的判定依据）与合并后的 12 项修复计划 |
| 3 | `docs/25_V87_ACCEPTANCE.md` | 测试网 10 轮回归验收（守恒误差 0 raw、专项探针结果、局限如实记录） |
| 4 | `docs/22_EXTERNAL_AUDIT_REPORT.md` | 第一份审计报告（供对照自己的发现） |
| 5 | 第二份审计报告（对话提供，未入库） | 请审计方自行对照 |
| 6 | `contracts/` 源码 + `contracts/tests/` | 175 个测试，含 21 条新增审计回归测试 |

## 2. 每条发现的处置结论（请逐条确认）

| 原发现 | 处置 | 修复位置 | 回归测试 |
| --- | --- | --- | --- |
| 22-CRIT-01 / ②HIGH-01（困惑副手） | **已修** | `JettonWallet` 限制 `sendExcessesTo`；`JettonMaster` 限制 `burnInitiator`；`RC.confirmBurn` 断言 `*BurnDispatched` | `jetton-integration.test.tolk` 转账+销毁双路径伪造 |
| 22-CRIT-02（退款零倒贴） | **已修** | `refundStake` 阈值分流 + `stakes[0]` 账本 + `ClaimPrincipal(0)` | 低 gas / 足 gas / 一跳 / 二跳 |
| 22-HIGH-01 / ②HIGH-02（销毁二跳无通知） | **已修** | `JettonWallet` 覆盖 `BurnNotificationForMinter`；RC/TV 幂等清 dispatched | 真钱包二跳 bounce → Retry 重发 |
| 22-HIGH-02 / ②HIGH-03（OA 游标失步） | **已修** | OA `ResetRoundCandles(0x52540028)` + RC resume 通知（`IGNORE_ERRORS`） | 真 RC pause→resume + FIFO 双 bounce |
| 22-HIGH-03（OOG 静默丢弃） | **已修** | 预留存储 + 0.015 TON；`CARRY_ALL_BALANCE \| IGNORE_ERRORS` | 趋零余额通知测试 |
| 22-HIGH-04（缺入站金额） | **已修** | RC 领取 ≥0.15 TON；OA 签名入口 ≥0.25 TON | `f6.test.tolk` |
| 22-MED-01 / ②MEDIUM-01（TV setter） | **已修** | `SetTeamWalletJettonWallet` 加 `controller == null` 锁 | `f7.test.tolk` |
| 22-MED-02（36h 断崖） | **已修** | `handleOpenRound` 无条件锚定 `stakeOpenAt = now` | `f9.test.tolk` |
| 22-MED-03（滚存 minStake） | **已修** | `rollAmount >= minStakeRaw` | `rewards-v8.test.tolk` |
| ②LOW-01（MintOnce 报废） | **已修** | 先断言资金再清 admin | `f8` 测试 |
| ②INFO-01（缺事件） | **已修** | 新增事件 `0x52540109`–`0x5254010D` | — |
| **②MEDIUM-02（R10 后早领）** | ❌ **假阳性，未改** | `RC:1171` 与 `payEarlyReward:1427` 均有 `unlockStart == 0` 断言 | — |
| **22-MED-01 中的「SetJettonWalletCode 未锁」** | ❌ **假阳性，未改** | `RC:1019` 已有 `currentRoundId == 0` | — |
| **F11（retry team 节流）** | ❌ **评审后否决** | `TeamVault` 释放幂等，反复调用亏本且 RC 净赚；加节流需 TV→RC 反向通知，通知丢失即永久卡死 | — |
| ②MEDIUM-03 后半（作废轮 streak 断签） | ⚠️ **设计选择，不改** | 「连续参与」语义；写入用户风险披露 | — |

## 3. 请审计方复核的重点

1. **F1 的修复是否覆盖两条路径**：① 攻击者销毁自己 A9 让 master 回传伪造 queryId ② 攻击者向受害者钱包转 1 nano-A9 指定 `sendExcessesTo=RC`。两条都应在钱包层被 `NotOwner` 拦住。
2. **F2 的退款账本是否可能有资金错账**：`stakes[0]` 复用是否与 1..10 轮的逻辑串味、`roundId=0` 是否可能在别处被误当作真实轮次。
3. **F5 的 `ResetRoundCandles` 权限**：只允许 OA admin 或 RC，确认无第三方可调用。
4. **F3 的幂等清 dispatched**：重复通知 / 已确认后到达的迟到通知是否无害。
5. **对两项假阳性的判定**是否同意（若不同意请给出行号级反驳）。

## 4. 复现方式

```bash
git checkout v8.7-audit-fixed
cd contracts
acton build --clear-cache
acton check          # 期望 0 error 0 warning
acton test           # 期望 175 passed / 18 files
```

链上核对（测试网实例仍在，地址见 `ops/config/fasttest-v87.registry.json`）：
```bash
acton rpc info <addr> --net testnet    # 比对 Code Hash 与 docs/18 §16.1
```

## 5. 已知局限（请勿重复报告）

- **F10 只有单元测试覆盖**：链上需要「成功轮 + 用户可滚额 ∈ (0, minStakeRaw)」才能触发，本实例奖励远大于门槛构造不出；且 F10 与 F-05 错误码同为 `RollNotAvailable(266)`，链上不可区分。
- **R9/R10 为 PARTIAL**（B/C 钱包 TON 耗尽缺席），已如实标注，不计入干净样本。
- **生产时序（12h/36h/24h）** 仍只在 emulation 验证。
- **OA 的 3/5 签名路径** 只在单测与 emulation 覆盖（本轮 K 线由 admin 直提）。