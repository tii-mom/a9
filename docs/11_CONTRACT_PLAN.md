# 11 — 合约技术方案：语言、清单与官方复用策略

**版本**：V5.4 · 2026-11-05
**关联**：[docs/00_DECISIONS_V2.md](00_DECISIONS_V2.md)（V5 口径）、[docs/04_CONTRACT_ABI.md](04_CONTRACT_ABI.md)（接口）、[docs/06_DEPLOYMENT.md](06_DEPLOYMENT.md)（部署）

---

## 1. 语言选型

| 语言 | 定位 | 优点 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **Tolk** | TON 官方推荐的新一代合约语言（FunC 的继任者） | 语法更接近现代语言、官方文档与 Acton 工具链主推、静态检查强 | 生态样例比 FunC 少、部分审计方经验较浅 | ✅ 自研合约（RoundController + TeamVault）首选 |
| **FunC** | 老牌合约语言，TON 官方参考合约（Jetton 等）都是 FunC | 参考实现可直接复用、审计经验最多 | 语法晦涩、易出错 | ✅ 官方复用合约保持 FunC 原样，不改写 |
| **Tact** | 高层合约语言（TS 风格） | 开发快、可读性好 | 编译器生成代码面更大、审计需看生成代码 | ⚠️ 备选，不推荐用于资金核心逻辑 |

**推荐组合**：官方 Jetton 用 FunC 原样复用（不改一行）+ 自研 RoundController / TeamVault 用 Tolk 编写。消息 cell 交互，语言不同不影响互操作。

工具链：Acton（官方推荐的构建/测试/部署工具链）+ 锁定编译器版本 + CI 可重复构建。若审计机构只接受 FunC，则自研合约改用 FunC 重写（逻辑不变）。

### 1.1 官方成熟合约覆盖结论（V5）

| 能力 | 官方成熟实现 | 本项目是否采用 | 结论 |
| --- | --- | --- | --- |
| Jetton（TEP-74） | ton-blockchain/jetton-contract | ✅ 采用 | 成熟、可复用；Master + Wallet 原样使用 |
| Multisig v2 | ton-blockchain/multisig-contract-v2 | ❌ 不采用 | 官方有，但**本项目不设多签**（收款钱包个人热钱包、管理员单密钥 owner） |
| Lockup / Vesting | ton-blockchain/lockup-wallet-contract | ❌ 不采用 | 官方有，但**团队改为 TeamVault 轮次释放/销毁**，不需要归属曲线 |
| 轮次状态机 / K 线计数 | 无 | ⚠️ 自研 | 没有官方成熟合约（RoundController） |
| 成功按质押比例认领 / claimAll | 无 | ⚠️ 自研 | 没有官方成熟合约（RoundController，≤10 轮有界） |
| 失败三笔销毁（奖励 + 团队 + 本金） | 无 | ⚠️ 自研 | 没有官方成熟合约（RoundController 主导） |
| 团队额度托管 / 按轮释放销毁 | 无 | ⚠️ 自研 | 没有官方成熟合约（**TeamVault**） |
| 预言机签名验证（可选） | 无统一标准 | ⚠️ 可选自研 | 二期 OracleAdapter，本期不部署 |

**结论：需要自研的合约数量 = 2（RoundController + TeamVault）；可选 = 1（OracleAdapter，二期）。** 官方复用收敛为 Jetton Master / Wallet 一类。

---

## 2. 合约清单（要部署几个）

### 2.1 主网目标架构（V5）

| # | 合约 | 来源 | 数量（实例） | 说明 |
| --- | --- | --- | --- | --- |
| 1 | Jetton Master | 官方复用（ton-blockchain/jetton-contract） | 1 | TEP-74，铸造 100 亿、关闭 mint |
| 2 | Jetton Wallet | 官方复用（同上） | N ≈ 13 | 每个持币地址 1 个；协议侧约 13 个（奖励金库、质押金库、TeamVault、团队/营销/流动性收款、运营等）+ 用户钱包 |
| 3 | **RoundController** | 自研（Tolk） | 1 | 轮次状态机 + 12 根 K 线计数 + 成功结算 + 失败结算 + 指向 TeamVault 的释放/销毁 + claimAll；预计 500~700 行 |
| 4 | **TeamVault** | 自研（Tolk） | 1 | 托管 12 亿 Jetton Wallet（owner = TeamVault）；只接受 RC 指令，按轮释放/销毁 1.2 亿，幂等互斥；预计 150~250 行 |
| 5 | Multisig v2 | 官方有，**不采用** | **0** | 项目不设多签（V4/V5） |
| 6 | Lockup / Vesting | 官方有，**不采用** | **0** | 团队改为 TeamVault 轮次释放/销毁（V5） |
| 7 | OracleAdapter（可选） | 自研（Tolk，第二阶段） | 0（二期 1） | 签名验证；本期手动模式不部署 |

**部署实例数（V5）**：1（Jetton Master）+ 约 13（Jetton Wallet）+ 1（RoundController）+ 1（TeamVault）≈ **16 个**（再加每个用户 1 个 Jetton Wallet）。
**自研合约 = 2 个（RoundController + TeamVault）**，可选 1 个（OracleAdapter，二期）。

### 2.2 测试网方案（V5）

测试网直接按最终架构执行（项目不设多签，不再走「多签手动 MVP」）：

| 步骤 | 执行方 | 链上动作 |
| --- | --- | --- |
| 开轮/关报名 | RoundController（单密钥 owner 触发） | 记录开轮时间、报名截止（报名窗口 72h，结算后立即开启） |
| 质押 | 用户 | 标准 Jetton transfer 到本轮质押钱包（forward payload 写 roundId/nonce/riskVersion） |
| 提交 K 线 | 任意白名单地址（测试网手动模式） | 提交 12 根 K 线数据（链下公开可复核） |
| 判定/结算 | RoundController | 8/12 判定；成功：指令 TeamVault 释放 1.2 亿 + 开放 claimAll；失败：发起三笔 burn（含 TeamVault 销毁团队额度） |
| 领取 | 用户 | claimAll（可跨轮累积，≤10 轮，合并一笔，用户付 gas） |
| 开下一轮 | RoundController | 上一轮终态后**立即**开启（间隔 0） |

- 测试网阶段自研合约数 = **2（RoundController + TeamVault）**；不再使用多签。
- **启动前置（用户明确）**：等所有文档与细节敲定、参数签字（含 **D-26 目标价语义决策**）后再启动测试网，见 docs/10 §7。

---

## 3. 官方复用明细与核对清单

| 组件 | 仓库（需在实现前锁定 commit） | 复用什么 | 必须核对 |
| --- | --- | --- | --- |
| Jetton | ton-blockchain/jetton-contract | Master + Wallet 代码、TEP-74 消息格式 | ① 最新 release/commit ② 对应审计报告 ③ mint 权限关闭方式 ④ burn 行为与 total_supply 更新 |
| 标准 Jetton Wallet 作金库 | 同 Jetton | 不写新合约，直接作为质押/奖励/TeamVault/收款钱包 | owner 设置（RoundController / TeamVault / 个人热钱包）、payload 解析 |

> 说明：官方复用只有 Jetton 一类；Multisig 与 Lockup 官方虽有，但本项目 **V4/V5 决定不使用**，不列入复用清单，也不需核对它们的审计版本。
> 「已审计」要落到具体版本：测试网 W1 的第一项任务仍是核对 Jetton 的 commit 与审计报告覆盖范围，并把结论写回本文件。

---

## 4. 自研范围（RoundController + TeamVault）

### 4.1 RoundController（约 500~700 行）

1. 轮次状态机：UNOPENED → STAKING_OPEN（**72h**）→ STAKING_CLOSED → OBSERVING（48h / 12 根）→ SETTLING_SUCCESS / SETTLING_FAILURE → SUCCEEDED / FAILED_PERMANENT（含 ORACLE_PAUSED 分支）。
2. K 线记录与计数：仅接受 12 个固定 index、严格时间区间、去重；达标数 >= 8 通过。
3. 成功结算：按质押比例开放领取 + 领回本金；指令 **TeamVault 释放 1.2 亿**到团队收款钱包。
4. 失败结算：发出**三笔** burn（奖励 7 亿 + 指令 TeamVault 销毁团队 1.2 亿 + 全部本金），确认后置终态；0 人质押且通过时销毁 7 亿奖励。
5. **claimAll**：按（round, owner, type）幂等标记；单次最多遍历 10 轮；合并为一笔 Jetton 转账；gas 由用户承担。
6. 管理员最小权限 + **不可升级**：仅开轮/关报名/暂停恢复/必要时触发结算；不得修改已开轮参数、不得转移用户质押本金；无升级代理。
7. **不允许取消质押**（V5.3 已确认）：不实现 cancel/withdraw；唯一退款路径是 `TECHNICAL_ABORTED`。
8. **targetPrice 语义（D-28 待确认）**：当前按轮次 `P0 × 2^roundId`；若采纳同档重试，改为按 tier（`tier = 1 + 已成功轮数`），失败不升档、成功才升档，需新增 `RoundData.tier`。
9. **目标价写入（V5.4 已确认）**：合约只存 P0（$0.00116）、倍数（2，不可变）、档位计数与每轮 `target_price`；第 N 轮结算写第 N+1 轮 target，写入后不可改并发事件；不预存 10 轮价格。

### 4.2 TeamVault（约 150~250 行）

1. 托管 12 亿对应的 Jetton Wallet（owner = TeamVault）。
2. 只接受 **RoundController** 指令（校验 sender）；其他来源拒绝。
3. ReleaseTeamQuota(roundId)：把该轮 1.2 亿转出到团队收款钱包。
4. BurnTeamQuota(roundId)：销毁该轮 1.2 亿（kind = team）。
5. 同轮释放/销毁互斥且幂等；重复指令返回已有结果。

**不做**：多签、归属/锁仓曲线、价格聚合（手动/预言机提交）、做市、治理、升级代理。

代码量合计约 650~950 行 Tolk + 约 50 个测试用例（成功/失败/无质押/0 人通过/暂停恢复/重复领取/claimAll 跨轮/重复销毁/TeamVault 非授权指令/团队释放重复/边界）。

---

## 5. 审计范围与预算

| 项 | 范围 | 说明 |
| --- | --- | --- |
| 必审 | RoundController（自研） | 资金安全核心：三笔销毁、领取/claimAll、状态机不可逆、0 人质押分支、权限边界 |
| 必审 | TeamVault（自研） | 12 亿托管、只认 RC 指令、释放/销毁互斥幂等 |
| 必审 | 复用合约的集成方式 | Jetton 转账/销毁、owner 权限、payload 解析 |
| 可选 | OracleAdapter（未来） | 签名验证 |
| 预算 | **$12k~35k**（自研面 2 个合约） | 3 周~5 周 |
| 交付 | 审计报告 + 修复复审 + 代码哈希 | 与部署版本一致 |

> 注意：审计覆盖代码逻辑，**不覆盖单密钥托管、个人热钱包与地址不公开的运营风险**；该风险已由 V4/V5 接受，缓解见 docs/10 §9。

---

## 6. 实施顺序（与 docs/10 时间表对齐）

1. **W1**：锁定 Jetton 官方 commit + 审计报告核对；确认「不部署多签/锁仓」的最终参数。
2. **W2**：文档定稿 + 参数签字（含 **D-26 目标价语义**、D-25 已定的 pull claim）；Jetton 部署脚本与收款钱包地址登记（不公开）。
3. **W3~W4**：RoundController + TeamVault（Tolk）实现 + 测试（本地 sandbox）。
4. **W5**：Testnet 启动（前置：文档定稿 + 参数签字 + D-26 已定）→ 全流程演练（报名→观察→结算→TeamVault 释放/三笔销毁→claimAll→开下一轮），覆盖无人质押与 0 人通过分支。
5. **W6**：审计 → 修复 → 主网排期。

---

## 7. 待确认

1. 审计机构是否接受 Tolk（否则自研合约改 FunC）。
2. **D-26 解锁窗口与目标价冲突**（最高优先级）：**方案 B+（Lead 推荐：固定阶梯 + 1h TWAP 闸门 + 触价提前关窗 + 24h 缓冲）** / A 相对翻倍 / C 短窗+随机截止，见 docs/00 §7；**未定案前不要按新语义实现**（当前 FIXED_LADDER）。
3. 团队 / 营销 / 流动性**收款钱包地址**（由项目方部署前提供，**不对外披露**，仅向审计/交易所披露）。
4. 预言机长期故障阈值（D-19）等其余上线参数。
5. **D-28 失败同档重试 / D-29 R1 启动规则 / D-30 搭便车时间加权**（Lead 建议，待项目方确认，见 docs/00 §7.9~§7.11 与 docs/12 P0-5/P0-1/P1-3）；定案后需同步改 targetPrice 语义、首轮目标、奖励权重与测试。
6. **D-32 已定案（V5.5）**：内盘销售 8%（8 亿 A9）+ 流动性 5%（5 亿 A9），8%+5%=13% 不变，奖励 70%/团队 12%/营销 5% 不变。**V5.6 内盘销售规则已确认**（见 docs/00 §7.13）：可售上限 8 亿硬顶、不可超卖；实际销量由项目方决定、可分批；未售/撤回转团队内盘管理钱包（公开可查），仅加池/OTC/公告后使用；**合约不承担销售逻辑**，只在 config 登记 `internalSaleCapRaw` 与 `teamInternalWallet`。
