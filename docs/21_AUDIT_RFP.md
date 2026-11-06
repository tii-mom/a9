# 21 — 主网前外部安全审计任务书（AUDIT RFP）

> 状态：**待执行（D-37 已定：选择全量外部审计，主网推迟 3–4 周）**
> 被审计版本：tag `v8.6-audit-fixed` @ `c24809a`（**冻结，审计期间除审计发现外不得改动**）
> 技术细节见 [docs/18_AUDIT_BRIEF.md](18_AUDIT_BRIEF.md)；本文是**交给审计方执行的任务书**。

## 1. 项目概述

A9 是一个部署在 TON 上的高风险质押协议。核心机制一句话：

> 用户押上本金，赌「72 小时内价格至少翻倍」。赢了分走本轮 7 亿枚 A9，输了本轮全部本金 100% 销毁。共 10 轮 30 天。

时间参数（V7）：12h PREVIEW + 36h 质押窗口 + 24h 观察（24 根 × 1h K 线，≥16 根达标即成功）= 72h/轮。

代币经济：总量 100 亿 A9，**铸造后永久关闭增发**。分配：奖励 70% / 团队 12% / 内盘 8% / 流动性 5% / 营销 5%。

## 2. 审计范围（5 个合约，全部 Tolk 语言）

| 合约 | 源文件 | 行数 | code hash | 资金风险 |
| --- | --- | --- | --- | --- |
| **RoundController** | `contracts/contracts/RoundController.tolk` | 1,938 | `0xC5AD291469C3BEADBDC26A6F1733004D433F12B15B025D88B983DF098BA11500` | **最高**：托管 70 亿 A9 奖励池 + 全部用户本金 |
| **TeamVault** | `contracts/contracts/TeamVault.tolk` | 359 | `0xCF3E6C7C9DC045F392F35E79E20AA6EDAAF9064D538CA4E78B6D1FE1443158B4` | 高：托管 12 亿团队额度 |
| **OracleAdapter** | `contracts/contracts/OracleAdapter.tolk` | 449 | `0x539F3597357943584A596DA2B40F901B4984D8C8307E63CE81A67F131EAB8CBA` | 中：决定每轮输赢的签名聚合 |
| **JettonMaster** | `contracts/contracts/jetton/JettonMaster.tolk` | 246 | `0x876F21A1A516FB0449A1D0AF5DBECEB8639373F947949C5AE8E1E9DBB769D64F` | 高：**100 亿枚代币发行**与总量不可变 |
| **JettonWallet** | `contracts/contracts/jetton/JettonWallet.tolk` | 206 | `0x394E4E8D40B5D3D97D12AA950B99EA9A53387DDAC331BAAAC8923F0E6E6849A4` | 中：所有 A9 余额的持有者 |

共享定义（也请审阅）：`contracts/contracts/types.tolk`（785 行数据结构）、`contracts/contracts/constants.tolk`（214 行常量与错误码）、`contracts/contracts/jetton.tolk`（109 行消息构造）。

**测试基线**：`acton test` → **154 passed / 15 files**；`acton check` → **0 error 0 warning**。测试源码在 `contracts/tests/`，其中 `jetton-integration.test.tolk` 使用**真实 Jetton 合约**做集成测试。

## 3. 明确不在范围

- 前端（`web/`）、Cloudflare Worker 后端（`worker/`）—— 若预算允许可单独报价，但不是本次必需
- TON 公链本身、TON 官方标准库
- 经济模型是否可持续（**已由项目方确认接受**：2× 倍数下理性用户 EV 为负，属于已披露的产品选择，不是缺陷）

## 4. 重点攻击面（建议审计方优先投入）

以下是我们自己识别出的高风险区，请重点验证：

### 4.1 资金与记账一致性（RoundController）
1. **本轮累计值的舍入与封顶**：`totalAcceptedStake`、`totalWeight`、`qualifiedCandles`（封顶 16）在多用户、多轮、滚存叠加后是否与真实资金一致
2. **权重公式**：`weight = amount × (1 + streak×10%)`，streak 上限 10 轮；邀请加成 `min(referredStake×20%, 自身质押×2)`。多个加成叠加、跨轮滚存时是否会超出奖励池
3. **奖励三态**（PENDING / ROLLED / RECLAIMED）的状态机是否可达错误状态；滚存撞 20,000,000 A9/地址上限后，超出部分是否正确地进入锁定池而不是丢失或重复计入
4. **领取幂等**：`pendingQueryId` 互斥 + `ReturnExcessesBack` 结算 + bounce 回滚三条路径的组合是否存在双花或永久卡死
5. **失败轮销毁**：奖励销毁、团队额度销毁、本金销毁三笔是否可能重复执行、漏执行、或对同一笔本金销毁两次

### 4.2 异步消息（TON 特有风险，历史 P0 重灾区）
6. **Jetton 两跳 bounce**：发送方钱包 → 接收方钱包的 `InternalTransferStep` 被 bounce 时，`pendingQueryId` 是否能恢复（v8.6 已加 `TransferBounced` 通知，请验证是否覆盖全部路径）
7. **`ReturnExcessesBack` 的发送方校验**：必须来自「接收方的 jetton wallet」而非自己的钱包（v8.4 曾因这个错误导致所有领取 100% 失败，请验证修复完整）
8. **action phase 失败导致的状态回滚**：任何 `send()` 失败都会回滚整笔交易。检查所有 `send()` 是否会因余额不足而意外回滚本应保留的状态变更（v8.6 已为 `TransferBounced` 加 `IGNORE_ERRORS`，请检查其他地方）

### 4.3 权限与不可逆操作
9. **admin 权限边界**：admin 能做/不能做哪些（见 docs/00 `permissions` 字段）。特别是 `SetJettonWalletCode` / `SetTeamWalletJettonWallet` 是否可能被滥用
10. **admin 永久不可改**（无 SetAdmin）—— 请确认这是设计而非遗漏，并评估单密钥风险
11. **逃生舱**：到期后任何人可关窗、`SETTLING_*` 任何人可推动、观察超时可技术中止 —— 验证这些路径不会被恶意利用（例如攻击者故意触发技术中止来退本金）

### 4.4 预言机（OracleAdapter）
12. **签名重放**：`usedMask` 与 `lastCandle` 的回滚逻辑（bounce 时）是否存在重放窗口
13. **3/5 阈值**：签名去重、签名人索引、阈值变更的边界
14. **K 线顺序**：`candleIndex` 严格递增 + 首根 0 的语义

### 4.5 代币合约
15. **mint-once 是否真的不可逆**：`adminAddress` 与 `nextAdminAddress` 在同一笔交易置空后，`ClaimMinterAdmin` / `ChangeMinterAdmin` 是否还有路径恢复
16. **JettonWallet 的 owner 校验**：`InternalTransferStep` 的 `transferInitiator` 校验是否可绕过（伪造他人钱包转入）
17. **bounce 恢复**：余额回滚是否正确，是否会重复加回

## 5. 已知问题与已接受风险（**不要重复报告**）

以下问题项目方**已确认并书面接受**，审计报告请勿列为发现（如需可在附录提及）：

| # | 事项 | 决策依据 |
| --- | --- | --- |
| 1 | **2× 倍数下理性用户 EV 为负**（−89%~−99%），机制依赖 FOMO 而非正期望 | D-33（docs/00） |
| 2 | **不做法律意见书**，合规风险由项目方自担 | D-34 |
| 3 | **主网 admin 采用单一冷钱包**（不做多签）。风险：admin 永久不可改 / TV 可重定向团队额度 / OA 可换签名人 / 单钥无补救 | D-36 |
| 4 | **不接预言机时，admin 可手动提交 K 线**，技术上可操控单轮输赢 | 已写进用户风险披露 |
| 5 | **R10 线性解锁立即领取会返回 `NothingUnlocked`** | 预期行为，见 docs/18 §15 |
| 6 | 生产参数时序（12h/36h/24h）只经过 emulation 验证，尚未在真实链上跑完整一轮 | 已知，主网后首轮会验证 |

## 6. 交付物要求

审计方需交付：
1. **审计报告**（PDF/Markdown），按严重度分级：Critical / High / Medium / Low / Informational
2. 每条发现包含：标题、位置（文件:行号）、影响描述、**可复现的攻击场景或 PoC**、修复建议
3. **概念验证代码**：Critical 与 High 级别必须提供可运行的 PoC（Tolk 测试或脚本），不接受纯文字描述
4. **复核报告**（项目方修复后的第二轮）：确认每条发现已修复或明确标记为「接受风险」
5. 审计方法论说明（用了哪些工具、覆盖了哪些路径、未覆盖什么）

## 7. 严重度定义（请严格按此分级）

| 级别 | 定义 |
| --- | --- |
| **Critical** | 可直接导致用户或协议资金被盗/永久锁定，无需特殊条件 |
| **High** | 在特定条件下（如特定时序、特定用户行为）可导致资金损失或永久拒绝服务 |
| **Medium** | 可导致部分功能失效、数据不一致，但不直接造成资金损失 |
| **Low** | 代码质量、边界条件、gas 优化等 |
| **Informational** | 建议与注释 |

## 8. 时间与里程碑

| 阶段 | 内容 | 预期时长 |
| --- | --- | --- |
| M0 | 材料交接 + 启动会（30 分钟） | Day 0 |
| M1 | 静态审计 + 威胁建模，输出初步发现清单 | Week 1 |
| M2 | 深入验证 + PoC 编写，输出完整报告 | Week 2–3 |
| M3 | 项目方修复（仅审计发现，不改其他逻辑） | Week 3–4 |
| M4 | 复核 + 最终报告 | Week 4 |

**总周期 3–4 周**。修复期间项目方会打新 tag（`v8.7-audit-fixed`），并**重跑全部 154+ 测试、重新部署测试网实例、重新跑 10 轮链上验收**。

## 9. 项目方提供的材料

1. 代码仓库（含完整 git 历史与 tag）
2. `docs/00_DECISIONS_V2.md` —— 全部产品与安全决策（D-01~D-36）
3. `docs/11_CONTRACT_PLAN.md` —— 合约设计与偏离说明（含 Jetton 用 Tolk 重写的理由）
4. `docs/17_REWARD_V2.md` —— 奖励权重制完整规格（含 20 个测试用例说明）
5. `docs/18_AUDIT_BRIEF.md` —— 技术审计简报（冻结基线、修复历史、测试清单、验收命令）
6. `docs/19_TESTNET_ACCEPTANCE.md` —— 测试网 10 轮链上验收报告（守恒误差 0 raw）
7. `docs/20_INDEXER_RECONCILE.md` —— 索引器全生命周期对账（DIFFS = 0）
8. 测试网实例地址与 code hash（可自行上链核对）

## 10. 验收标准（什么算审计完成）

- [ ] 5 个合约全部覆盖，每个合约明确标注审计深度
- [ ] Critical / High 全部有 PoC
- [ ] 报告明确列出「未覆盖范围」
- [ ] 复核报告确认所有 Critical/High 已修复或书面接受
- [ ] 审计方对「已知接受风险」清单无异议（或明确说明为何有异议）

## 11. 关键提醒给审计方

**这是不可升级合约。** `RoundController` 与 `TeamVault` 的代码与 admin 一旦部署就永久不可改，没有代理、没有迁移、没有 SetAdmin。**上线后发现的任何缺陷都永久无法修复。** 请按「错了就没有第二次机会」的标准执行。

历史上我们自己做的三轮内部审查共发现 **20+ 个真实缺陷，其中 4 个 Critical**（解锁双花、`ReturnExcessesBack` 发送方校验错误导致 100% 领取失败、开窗永久死锁、团队释放 bounce 无回滚）。**同类问题很可能还有**，请假设代码里仍藏着至少一个 Critical。