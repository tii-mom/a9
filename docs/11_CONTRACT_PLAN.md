# 11 — 合约技术方案：语言、清单与官方复用策略

**版本**：V1.0 · 2026-11-05
**关联**：[docs/00_DECISIONS_V2.md](00_DECISIONS_V2.md)（V3 口径）、[docs/04_CONTRACT_ABI.md](04_CONTRACT_ABI.md)（接口）、[docs/06_DEPLOYMENT.md](06_DEPLOYMENT.md)（部署）

---

## 1. 语言选型

| 语言 | 定位 | 优点 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **Tolk** | TON 官方推荐的新一代合约语言（FunC 的继任者） | 语法更接近现代语言、官方文档与 Acton 工具链主推、静态检查强 | 生态样例比 FunC 少、部分审计方经验较浅 | ✅ 自研合约（RoundController）首选 |
| **FunC** | 老牌合约语言，TON 官方参考合约（Jetton / Lockup / Multisig）都是 FunC | 参考实现可直接复用、审计经验最多 | 语法晦涩、易出错 | ✅ 官方复用合约保持 FunC 原样，不改写 |
| **Tact** | 高层合约语言（TS 风格） | 开发快、可读性好 | 编译器生成代码面更大、审计需看生成代码 | ⚠️ 备选，不推荐用于资金核心逻辑 |

**推荐组合**：官方合约用 FunC 原样复用（不改一行）+ 自研 RoundController 用 Tolk 编写。两者通过消息 cell 交互，语言不同不影响互操作。

工具链：Acton（官方推荐的构建/测试/部署工具链）+ 锁定编译器版本 + CI 可重复构建。若审计机构只接受 FunC，则 RoundController 改用 FunC 重写（逻辑不变）。

---

## 2. 合约清单（要部署几个）

### 2.1 主网目标架构

| # | 合约 | 来源 | 数量（实例） | 说明 |
| --- | --- | --- | --- | --- |
| 1 | Jetton Master | 官方复用（ton-blockchain/jetton-contract） | 1 | TEP-74，铸造 100 亿、关闭 mint 或移交多签 |
| 2 | Jetton Wallet | 官方复用（同上） | N | 每个持币地址 1 个；协议侧约 13 个（10 个轮次质押钱包 + 奖励钱包 + 运营钱包等）+ 用户钱包 |
| 3 | Multisig v2 | 官方复用（ton-blockchain/multisig-contract-v2） | 2 | ① 管理员/升级 ② 国库（3/5） |
| 4 | Lockup / Vesting Wallet | 官方复用（ton-blockchain/lockup-wallet-contract） | 3 | 团队 12%、营销 5%、流动性 10% 的锁仓与线性释放 |
| 5 | **RoundController** | 自研（Tolk） | 1 | 轮次状态机 + 12 根 K 线计数 + 结算指令 + 领取记账（预计 500~700 行） |
| 6 | OracleAdapter（可选） | 自研（Tolk，第二阶段） | 1 | 签名验证；本期手动模式不部署 |

**结论**：

- 合约「种类」= 5 类，其中 **4 类直接复用官方**（Jetton Master/Wallet、Multisig v2、Lockup Wallet），**只有 RoundController 需要自研**（+ 未来 OracleAdapter）。
- 部署实例数 ≈ 1（Jetton Master）+ 约 13（协议侧 Jetton Wallet）+ 2（多签）+ 3（锁仓）+ 1（RoundController）= 约 20 个实例，但真正需要审计的新代码只有 1 个合约。

### 2.2 测试网 MVP（零自研，最快跑通）

用户要求「先完成测试网的所有工作」。测试网可以直接用**多签手动执行**全部流程，自研合约数 = **0**：

| 步骤 | 执行方 | 链上动作 |
| --- | --- | --- |
| 开轮/关报名 | 3/5 多签提案 | 记录开轮公告 + 报名截止（可用多签签名的时间戳） |
| 质押 | 用户 | 标准 Jetton transfer 到本轮指定钱包（forward payload 写 roundId/nonce/riskVersion） |
| 提交 K 线 | 任意白名单地址 | 提交 12 根 K 线数据（链下公开可复核） |
| 判定 | 多签 | 根据 12 根数据决定成功/失败 |
| 成功结算 | 多签 | 奖励钱包按质押比例批量签名转账（或用户申请后逐个转） |
| 失败结算 | 多签 | 调用标准 Jetton burn 销毁奖励 + 全部质押本金，链上核对 total_supply |
| 开下一轮 | 多签 | 重复 |

这样测试网阶段**不写任何新合约**，只验证产品、经济与流程；规则稳定后再实现 RoundController 并审计。

---

## 3. 官方复用明细与核对清单

| 组件 | 仓库（需在实现前锁定 commit） | 复用什么 | 必须核对 |
| --- | --- | --- | --- |
| Jetton | ton-blockchain/jetton-contract | Master + Wallet 代码、TEP-74 消息格式 | ① 最新 release/commit ② 是否有对应审计报告 ③ mint 权限关闭方式 ④ burn 行为与 total_supply 更新 |
| Multisig | ton-blockchain/multisig-contract-v2 | 提案/确认/执行流程 | 阈值、签名人轮换、提案过期、gas |
| Lockup | ton-blockchain/lockup-wallet-contract | 线性归属、cliff、领取 | 归属曲线参数、能否提前撤销、审计报告版本 |
| 标准 Jetton Wallet 作金库 | 同 Jetton | 不写新合约，直接作为质押/奖励钱包 | owner 设置（控制器或多签）、payload 解析 |

> ⚠️ 说明：以上仓库是 TON 生态的官方/标准实现，被大量项目使用；但「已审计」要落到具体版本。本轮联网检索受限，未能核对审计报告编号——测试网 W1 的第一项任务就是逐个核对 commit 与审计报告覆盖范围，并把结论写回本文件。

---

## 4. 自研范围（RoundController）

**只做四件事**：

1. 轮次状态机：UNOPENED → STAKING_OPEN（48h）→ STAKING_CLOSED → OBSERVING（48h / 12 根）→ SETTLING_SUCCESS / SETTLING_FAILURE → SUCCEEDED / FAILED_PERMANENT（含 ORACLE_PAUSED 分支）。
2. K 线记录与计数：仅接受 12 个固定 index、严格时间区间、去重；达标数 >= 8 通过。
3. 结算指令：成功 → 允许按质押比例领奖（一次性）+ 领回本金；失败 → 发出 burn 指令（奖励 + 全部本金），确认后置终态。
4. 领取记账：按（round, owner, type）幂等标记，pull claim 模式。

**不做**：价格聚合（手动/预言机提交）、做市、治理、升级代理。

代码量估计 500~700 行 Tolk + 约 40 个测试用例（成功/失败/无质押/暂停恢复/重复领取/重复销毁/边界）。

---

## 5. 审计范围与预算

| 项 | 范围 | 说明 |
| --- | --- | --- |
| 必审 | RoundController（自研） | 资金安全核心：销毁、领取、状态机不可逆 |
| 必审 | 复用合约的集成方式 | Jetton 转账/销毁、多签权限、锁仓参数 |
| 可选 | OracleAdapter（未来） | 签名验证 |
| 预算 | $8k~25k（自研面小，比全自研低） | 2 周~4 周 |
| 交付 | 审计报告 + 修复复审 + 代码哈希 | 与部署版本一致 |

---

## 6. 实施顺序（与 docs/10 时间表对齐）

1. **W1**：锁定官方合约 commit + 审计报告核对；测试网多签 MVP 部署。
2. **W2**：多签 MVP 跑通成功轮 / 失败轮 / 故障暂停恢复；链上核对 burn 后 total_supply 下降。
3. **W3~W4**：RoundController（Tolk）实现 + 测试（本地 sandbox + 测试网）。
4. **W5**：Testnet 全流程演练（报名→观察→结算→开下一轮），覆盖无质押分支。
5. **W6**：审计 → 修复 → 主网排期。

---

## 7. 待确认

1. 审计机构是否接受 Tolk（否则 RoundController 改 FunC）。
2. 奖励领取方式：多签批量转账（简单、gas 低、但中心化）vs 控制器 pull claim（去信任、gas 由用户付）。
3. 测试网是否走「零自研多签 MVP」路径（推荐）。
4. 团队/营销/流动性锁仓的具体曲线（cliff 与线性时长）。
