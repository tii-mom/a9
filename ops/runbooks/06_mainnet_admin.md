# 06 — 主网 admin 权限与多签方案（调研结论，待用户拍板）

> 状态：**只读调研 + 方案文档**，不含实现代码、不部署、不改合约。
> 适用基线：合约冻结版 `v8.6-audit-fixed` @ `c24809a`（154 tests / 15 files）。
> 决策目标：在主网部署**之前**确定 `RoundController` / `TeamVault` 的 admin 地址（部署后永久不可改）。
> 关联：D-21 / D-23（原「不设多签」结论）、D-24（不可升级）、D-35（主网前修复窗口）。

---

## 0. TL;DR（给用户的一句话）

**推荐方案 A：用 TON 官方 Multisig v2（2-of-3，硬件钱包签名）作为主网 `RoundController` + `TeamVault`（建议同时 `OracleAdapter`）的 admin；Jetton Master admin 保持部署 EOA 并在 mint 时永久归零。**
代价：ops 工具链改造 **8.5–12 人天** + 部署流程改为「先部署多签 → 合约 admin 指向多签 → wiring 用一个多签订单执行」+ 上线推迟约 1–2 天；收益：彻底消除「单个私钥泄露/丢失即永久失去协议控制权」的不可逆风险。

---

## 1. 硬约束（代码证据，非推测）

| 合约 | admin 写入方式 | 之后能否改 | 证据 |
|---|---|---|---|
| RoundController | 部署时写入 `ProtocolAddresses.admin`（`deploy-emulation.tolk` 的 `scripts.wallet("admin")`） | **不能**（全仓无 SetAdmin/ChangeAdmin 消息；`RoundControllerAllowedMessage` 无该 op，`requireAdmin` 只读） | `contracts/contracts/RoundController.tolk` §handler 列表、`deploy-emulation.tolk` L222/L380 |
| TeamVault | 部署时写入 `config.admin` | **不能**（allowed messages 无改 admin；`InitController` 只写 `controller`，且一次性） | `TeamVault.tolk` L11-12、L44-64 |
| OracleAdapter | 部署时写入 `config.admin` | **能**：`SetOracleAdmin`（当前 admin 签名即可转移） | `OracleAdapter.tolk` L241-253 |
| Jetton Master | 部署时写入 admin，**mint 同一逻辑内永久置 null** | 无（admin=null，mint 关闭） | `deploy-emulation.tolk` L259-275 |

> 说明：Lead 提到的「只能通过 `InitController` 写一次」严格来说属于 **TeamVault.controller**（把 TV 绑定到 RC，一次性且不可改）；`RoundController.admin` 是**部署构造参数**，效果相同——**主网上线后永久不可改**。两者都要求「部署时就必须是最终地址」。
> **推论：不能采用「先用 EOA 部署、再迁移给多签」的路径**（没有 SetAdmin），必须从第一次部署起就让 admin = 多签地址。

---

## 2. 当前 admin 权限清单（决定「为什么必须多签」）

### 2.1 RoundController（admin = 永久）

| 操作 | opcode | 权限条件 | 生效窗口 | 资金影响 | 可替代性 |
|---|---|---|---|---|---|
| `SetJettonWallet` | 0x52540016 | **仅 admin** | `currentRoundId == 0`（开 R1 前） | 决定质押 Jetton Wallet（收用户本金） | 无（R1 后永久冻结） |
| `SetJettonWalletCode` | 0x5254001B | **仅 admin** | `currentRoundId == 0` | 决定 Jetton Wallet code hash | 无（R1 后永久冻结） |
| `OpenRound` | 0x52540001 | admin **或** oracle | 每轮 | 锁定目标价/奖励预算 | oracle（3/5 签名） |
| `CloseStaking`（到期关窗） | 0x52540002 | **任何人** | 到点 | 无 | M-1 逃生舱 |
| `CloseStaking`（触价早关） | 0x52540002 | admin **或** oracle | 报名期内 | 提前进观察 | oracle |
| `SubmitCandle` | 0x52540003 | admin **或** oracle | 观察期 | 决定达标计数（销毁判定） | oracle |
| `PauseOracle` / `ResumeOracle` | 0x5254000A/B | admin **或** oracle | 观察期（每轮仅一次 pause） | 暂停不销毁本金 | **仅 admin 实际可做**（OA 无 pause 转发） |
| `StartObservation` | — | **任何人** | 关窗后到点 | 无 | 逃生舱 |
| `FinalizeRound` | 0x52540005 | **任何人** | SETTLING_* 且销毁确认 | 固化成功/失败 | 逃生舱（任何人可推） |
| `AbortTechnical` | 0x52540010 | **任何人** | 连续暂停 ≥14d 或观察超时 ≥7d | 退 100% 本金、不销毁 | 逃生舱 |
| `RetryPendingActions` | — | **任何人** | 任意（value ≥0.3 TON） | 重试卡住的跨合约动作 | 逃生舱 |

**结论**：R1 开轮后 RC admin 剩下的真实权力主要是「OpenRound/早关/Pause/Resume/SubmitCandle」——这些 **oracle（3/5 签名）都可替代**，且失败/超时都有 permissionless 逃生舱。admin 泄露的后果是 **grief（扰轮次、抬成本、毁信誉）而非直接盗币**——但仍足以毁掉项目，且 admin 永久不可换。

### 2.2 TeamVault（admin = 永久，风险被低估）

| 操作 | 权限 | 生效窗口 | 影响 |
|---|---|---|---|
| `SetJettonWallet` | 仅 admin | `controller == null`（wiring 前） | TV 的 Jetton Wallet |
| `SetTeamWalletJettonWallet` | **仅 admin** | **任何时间**（无 controller-null 限制） | **可把团队 12% 额度收款地址改到任意 Jetton Wallet**（提议者需自行构造合法钱包地址） |
| `InitController` | 仅 admin | 一次性（controller==null） | 绑定 RC（不可逆） |

**结论**：TV admin 是**可造成资金去向改变的永久权限**（团队额度重定向）。当前部署脚本里 RC admin 与 TV admin 是同一个 `admin` 钱包，所以「admin 泄露」不只 grief，还包含团队额度的托管风险。这一条是推荐多签的最强理由。

### 2.3 OracleAdapter（admin 可转移）

`SetSignerSet`（更新 3/5 签名人 + chainId + configVersion）、`SetOracleController`（一次性）、`SetOracleAdmin`（转移 admin）。若主网 oracle 走 3/5 独立签名方（docs/10 §2），OA admin 也应指向多签，否则单个 OA admin 私钥可替换全部签名人。

### 2.4 非协议权限（无需多签）

treasury / teamWallet / marketingWallet / liquidityWallet / teamInternalWallet 只是 A9 持币钱包，**没有合约权限**；它们的托管策略（冷/热钱包、是否披露）不改变协议安全模型，可继续按 D-21 决策执行。

---

## 3. TON Multisig v2 可行性

**合约**：`ton-blockchain/multisig-contract-v2`（TON Core 官方，Safe{Wallet} 风格）。

- **安全审计**：Zellic、Trail of Bits 双审计（仓库 `audits/` 内有 PDF）。
- **不可升级**：README 明确「Logic of multisignature wallet can not be changed after deploy」——与「admin 永久」的诉求匹配（多签本身也不会被偷偷换逻辑）。
- **任意动作**：Order 可包含任意 `send_message`（发送 TON/Jetton/调用任意合约）与 `update_multisig_params`（改阈值/签名人/提议人）。
- **流程**：`propose（任何人可发起吗？→ 仅 signers/proposers）→ signers 逐个 approve → 达到 threshold → 执行`；Order 为独立子合约，有 48-bit 过期时间；每个 Order 最多 255 条 transfer，超出自动拆到 `execute_internal` 续执行。
- **地址稳定性**：地址由「code hash + 初始 data（阈值/签名人）」推导；部署后**改签名人只改 storage**，地址不变；重新部署不同配置才会得到新地址。
- **费用**：wrapper 默认 propose 附带 **1 TON**、approve **0.1 TON**（可按需下调，需实测）；每个 action 自身还要带目标消息 value（现有 admin 消息为 **0.3 TON/条**）。建议多签约 **30–50 TON** 余额（部署 + 10 轮运维 + 应急 + 订单存储）。
- **延迟**：等于「收集 threshold 个真人签名」的时间（分钟~小时级）；订单过期需重新提案（过期订单可通过再执行把 TON 退回多签约）。
- **工具链现状（2026-11 调研）**：官方**未发布独立 npm SDK**；仓库提供 `wrappers/Multisig.ts`、`wrappers/Order.ts`（依赖 `@ton/core`，需 blueprint/自建打包）+ `scripts`；opcode/TL-B 公开（`new_order 0xf718510f`、`execute 0x75097f5d`、`execute_internal 0xa32c59bf`、`order.approve 0xa762230f`、`send_message 0xf1381e5b`、`update_multisig_params 0x1d0cfbd3`）。
  - 落地方式二选一：
    - **A-JS**：vendor `wrappers/` + `@ton/core`/`@ton/crypto`/`@ton/ton`，在 ops 里用硬件钱包/TON Connect 签名（推荐，生态成熟）。
    - **A-Tolk**：用 acton 自建多签 TL-B（复用现有 acton keystore 签名钱包），无新 JS 依赖，但需自测 cell 编码，风险更高。
- **已知注意点**：Order 内容不受限 → 签名人必须在钱包/工具里**完整解析订单 actions** 再签名；签名人集合变更会使未执行订单失效；threshold 必须 1..N。

---

## 4. 与现有 ops 工具链的兼容性与改造工作量

### 4.1 现状

- `ops/scripts/80_admin_ops.mjs` → acton `contracts/scripts/deploy/admin_op.tolk`，使用 `A9_SIGNER_WALLET`（acton 本地 keystore 钱包）**直接**向 RC/TV 发消息，每条 0.3 TON；dry-run 默认。
- `ops/scripts/15_deploy_contracts.mjs` → `deploy-emulation.tolk`：用 `scripts.wallet("admin")` 同时作为「admin 地址」和「wiring 消息发送方」。
- `ops/scripts/verify_deployment.mjs`：目前**没有**校验 admin 是否为多签/签名人集合。

### 4.2 必须改造的点

1. **部署参数拆分**：`adminAddress`（指向多签）与「部署签名钱包」解耦；RC/TV/OA 部署时 admin = 多签地址；Jetton Master admin 保持部署 EOA（mint 后永久 null，不进多签）。
2. **wiring 改为多签订单**：`RC.SetJettonWallet`、`RC.SetJettonWalletCode`、`TV.SetJettonWallet`、`TV.SetTeamWalletJettonWallet`、`TV.InitController`、`OA.SetOracleController`、`OA.SetSignerSet` 打包为 **1 个 Order**（≤255 actions 内），部署后由 2/3 签名执行；否则这些消息会因 sender≠admin 被拒。
3. **新脚本 `ops/scripts/90_multisig.mjs`**：`deploy / status / list-orders / get-order / propose / approve / execute / update-signers / estimate / demo`；dry-run 必须打印每个 action 的 `target/opcode/value/body 摘要/风险标签`。
4. **`80_admin_ops.mjs` 增加多签路由**：`--via multisig`（默认 dry-run 生成订单计划；`--propose-only / --approve --seqno / --execute --seqno`），保留 acton 直发路径给测试网/EOA 场景。
5. **`verify_deployment.mjs` 新增强制门禁**（STRICT）：
   - `admin.address`：RC/TV/OA 的 admin == 登记多签地址；
   - `admin.code_hash`：多签 code hash == 审计版本（Zellic/ToB 对应 commit）；
   - `admin.threshold/signers`：与登记的 2/3 或 3/5 一致；
   - `multisig.pending_orders`：无未执行/未过期订单（部署前）。
6. **密钥托管 SOP**：3 个签名人 = 3 套独立硬件钱包 + 离线助记词备份（异地/托管）；签名动作两人复核；禁止在仓库/CI 存放主网助记词。
   - ⚠️ **现状风险（本次调研发现）**：`contracts/global.wallets.toml` 内含 `a9-deployer` / `a9-admin` 的**明文助记词**（当前是测试网钱包）。主网**严禁复用**这两个密钥；仓库若将公开，需先清理历史/轮换（建议 Lead 单独处置）。

### 4.3 工作量估计（人天，不含多方协调时间）

| # | 工作项 | 人天 |
|---|---|---|
| 1 | 多签部署工具（vendor wrappers / blueprint 脚本、部署 + 地址/代码哈希校验、testnet 验证） | 1.0–1.5 |
| 2 | `90_multisig.mjs`（propose/approve/execute/list/status/estimate、actions 解析与 dry-run 明细） | 2.5–3.5 |
| 3 | `80_admin_ops.mjs` 多签路由 + dry-run 订单计划（保留 direct 路径） | 0.5–1.0 |
| 4 | 部署脚本拆分 admin/签名人 + wiring 订单构建 | 1.0–1.5 |
| 5 | `verify_deployment.mjs` admin/multisig 门禁 | 0.5–1.0 |
| 6 | Testnet 全流程演练（新实例：多签部署→wiring 订单→R1→一次管理操作→缺签/过期/换签名人演练） | 2.0–3.0 |
| 7 | Runbook/SOP/密钥托管与应急演练文档 | 1.0–1.5 |
| **合计** | 方案 A（多签） | **8.5–12 人天** |
| B | 单一冷钱包（硬件签名路径 + SOP） | 0.5–1.5 人天 |
| C | 混合（A + 金库独立冷钱包策略） | 8.5–12.5 人天 |

---

## 5. 三个方案

### 方案 A — TON Multisig v2 作为 admin（2-of-3 或 3-of-5）

- **架构**：多签部署在 TON 主网；3（或 5）个硬件钱包签名人，阈值 2（或 3）；RC/TV/OA admin = 多签地址；Jetton Master admin 仍为部署 EOA（mint 后归零）。
- **优点**：单私钥泄露不致命（需 2 把=2-of-3 才可动）；私钥丢失可通过 `update_multisig_params` 换人（需旧集合共识）；逻辑不可升级，行为可预期。
- **缺点**：部署流程重构（wiring 走订单）；每次 admin 操作需 2 人签名（分钟~小时级）；新增工具链与 SOP；多签本身 gas 成本。

### 方案 B — 单一冷钱包（硬件）作为 admin + 逃生舱

- **优点**：零改造（沿用 acton admin_op）；操作最快；gas 最低。
- **缺点**：**永久单点**——私钥丢失/持有人失联 = 永久失去 OpenRound/暂停/早关能力（虽仍有逃生舱，但协议节奏失控、可能被迫技术中止退款）；私钥泄露/内鬼 = 可永久 grief + **TV 团队额度重定向**；无追责分离。
- **逃生舱**：到期关窗（任何人）、SETTLING_* finalize（任何人）、技术中止超时（任何人）、retry pending（任何人）、oracle 3/5 覆盖 open/close/candle —— 协议**不会永久死锁**，但「及时性操作」会受影响。

### 方案 C — 混合：admin 多签 + 金库独立冷钱包

- **架构**：同 A（RC/TV/OA admin = 多签），另外 treasury/team/marketing/liquidity 用独立冷钱包（互不共用密钥），OA 3/5 签名人与多签签名人分离（避免同一批人既管 admin 又管 oracle）。
- **优点**：权限分离最彻底；单点事故影响面最小。
- **缺点**：A 的全部成本 + 密钥/主体更多、协调更重；小团队可能难长期维持 3 套独立硬件钱包。

---

## 6. 风险对照表

| 场景 | A. 多签（2-of-3） | B. 单一冷钱包 | C. 混合 |
|---|---|---|---|
| **私钥丢失** | 丢 1 把仍可执行（2/3）；丢 2 把才失能；可用旧集合换人 | **直接永久失能**：无法 OpenRound/暂停/早关；只能靠 oracle 与逃生舱，最终可能中止退款 | 同 A；金库另有多套独立备份 |
| **私钥泄露** | 攻击者需 2 把才能动；泄露 1 把可被替换（旧集合签名更新）；有响应窗口 | **单点全失**：TV 团队额度可被重定向、轮次可被持续 grief、无可撤销 | 同 A；且金库密钥与 admin 分离，损失面更小 |
| **单人跑路** | 1 人跑路 = 损失 1 票，剩余 2 票仍可执行 + 换人 | **协议控制权随人走**：跑路即永久失控 | 同 A；金库另有独立托管 |
| **多签方失联导致紧急操作无法执行** | 2-of-3 需 2 人；紧急场景可由 oracle 3/5 覆盖 open/close/candle + permissionless 逃生舱兜底；风险主要是「及时性」而非「安全性」 | 无此问题（单人可动），但换来前两项的致命风险 | 同 A；可加「紧急单人 break-glass」但会削弱多签价值，不建议 |

**结论**：B 在「可用性」上最优、在「不可逆安全」上最差；A 把不可逆风险从「1 把钥匙」提升到「2 把钥匙」，且协议本身已有 permissionless 逃生舱与 oracle 3/5 兜底，**A 的可用性代价可控**。

---

## 7. 推荐

**推荐方案 A（TON Multisig v2，起步 2-of-3）**，理由：

1. RC/TV admin **永久不可改**，一旦部署没有回头路；单密钥的不可逆风险与 8.5–12 人天 + 1–2 天上线延迟相比，**成本可接受、风险不可接受**。
2. TV admin 可**重定向团队 12% 额度**——这不是 grief，是资金去向风险，必须有分权。
3. 多签延迟不影响轮次主流程：OpenRound/早关/SubmitCandle 由 **OracleAdapter 3/5 签名**覆盖；到期关窗、finalize、技术中止、retry 均为 **permissionless**；多签只在「pre-R1 wiring」和「PauseOracle/换签名人」等低频场景需要人工确认。
4. Multisig v2 为 TON Core 官方、Zellic + Trail of Bits 双审计、逻辑不可升级，符合「不可升级 + 行为可预期」的协议调性。

**代价与前提**：
- 部署流程重构：**先部署多签 → 合约 admin 指向多签 → wiring 用 1 个多签订单执行**（不能再由 `deploy-emulation.tolk` 的 admin 钱包直接发 wiring）；
- ops 工具链改造 8.5–12 人天（§4.3），主网上线整体推迟约 1–2 天；
- 3 名签名人（建议：2 名项目核心 + 1 名外部/法律/顾问），全部硬件钱包，异地离线备份；
- 多签常备 30–50 TON gas；
- 若用户倾向更高安全，可升级为 3-of-5（成本不变，协调更重）。

**若用户拒绝多签（方案 B）**：必须书面接受「单密钥永久风险」，并强制执行：硬件钱包冷存、离线多份备份、admin 操作双人复核、监控异常 admin 操作、主网前完成一次密钥恢复演练；同时把该风险写入 docs/10 风险登记册。

---

## 8. 上线前 checklist（采用方案 A 时）

- [ ] 多签合约部署到 TON 主网（或先 testnet 全流程演练），记录地址 + code hash（与审计版本一致）
- [ ] 登记 `adminMultisig` 地址到 `ops/config/mainnet.registry.json` 与 D1 `contracts` 表
- [ ] 部署 Jetton Master（admin=部署 EOA）→ mint 10 亿 + admin=null（同笔）
- [ ] 部署 TeamVault / RoundController / OracleAdapter，admin 一律 = 多签地址
- [ ] 向多签注资（gas）并验证多签 getter：threshold=2、signers=3、地址正确
- [ ] 用**一个多签订单**执行 wiring：RC.SetJettonWallet / RC.SetJettonWalletCode / TV.SetJettonWallet / TV.SetTeamWalletJettonWallet / TV.InitController / OA.SetOracleController / OA.SetSignerSet
- [ ] `verify_deployment.mjs --online`（STRICT）全 PASS（含新增 admin/multisig 门禁）
- [ ] 演练：2 人签名执行一次 OpenRound；故意缺 1 签确认无法执行；订单过期后重提案；替换一个失联签名人（update_multisig_params）
- [ ] 密钥托管：3 套硬件钱包、离线备份异地存放、签名双人复核、紧急联系人与恢复流程上墙
- [ ] 公开透明页补充：多签地址、阈值、审计报告链接（docs/10 §透明页要求）

---

## 9. 待用户拍板的问题

1. 阈值与签名人构成：**2-of-3**（推荐，日常可执行）还是 **3-of-5**（更安全、协调更重）？签名人分别是谁？
2. 是否同意 **8.5–12 人天 + 上线推迟 1–2 天**换永久 admin 安全？
3. OracleAdapter admin 是否与 RC/TV 用同一多签，还是另设（建议同址，减少主体数量）？
4. treasury/team/marketing/liquidity 是否维持独立冷钱包（方案 C 的金库部分，无协议权限）？
5. 是否需要对多签工具链（自建 propose/approve 脚本）做第三方代码审计？
6. 是否公开 admin 多签地址与审计报告（透明度 vs 安全）。

---

## 10. 参考

- 合约与审计：`https://github.com/ton-blockchain/multisig-contract-v2`
  - Zellic 审计：`audits/Multisig_Zellic_Audit_Report.pdf`
  - Trail of Bits 审计：`audits/202403TON_Foundation_Multisignature_Wallet_Report_+_Fix_Review.pdf`
  - Wrapper API：`wrappers/Multisig.ts`、`wrappers/Order.ts`、`wrappers/Constants.ts`
- 本仓库相关：
  - `contracts/contracts/RoundController.tolk`（admin 权限与逃生舱）
  - `contracts/contracts/TeamVault.tolk`（InitController / SetTeamWalletJettonWallet）
  - `contracts/contracts/OracleAdapter.tolk`（SetSignerSet / SetOracleAdmin）
  - `contracts/scripts/deploy-emulation.tolk`、`ops/scripts/15_deploy_contracts.mjs`、`ops/scripts/80_admin_ops.mjs`
  - `docs/07_OPEN_DECISIONS.md`（D-21/D-23 原结论）、`docs/10_LAUNCH_READINESS.md`（风险登记册）

---

## 11. 测试网演练步骤（spike 已验证，task-45）

> 前提：用户尚未拍板方案 A；以下 spike 工具是**纯加法**，删除 `ops/scripts/91_/92_` 与 `ops/spike-multisig/` 即可回滚，不影响现有 EOA 流程。

1. 安装 spike 依赖：`cd ops/spike-multisig && pnpm install`
2. 准备官方源码/预编译产物：`node ops/scripts/91_deploy_multisig.mjs --prepare`（下载到 `ops/spike-multisig/.cache/`，不改根依赖）
3. 部署 2-of-3 多签（测试网）：
   ```bash
   node ops/scripts/91_deploy_multisig.mjs --signers a9-test-a,a9-test-b,a9-test-c --threshold 2          # dry-run
   OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/91_deploy_multisig.mjs --signers a9-test-a,a9-test-b,a9-test-c --threshold 2 --value 0.3 --execute
   ```
   产物：`ops/records/multisig-registry.json`（地址、code hash、signers、threshold）。
4. 发起 1 个订单（可含多条 action；`--transfer 地址,金额TON` 可重复）：
   ```bash
   node ops/scripts/92_multisig_order.mjs propose --signer a9-test-a --expiration 3600 --transfer <addr1>,0.02 --transfer <addr2>,0.02
   ```
5. 第 2 个签名人确认（达到阈值即自动执行）：
   ```bash
   OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/92_multisig_order.mjs approve --signer a9-test-b --seqno 0
   ```
6. 查询：`status` / `list` / `order-status --seqno N`；`ops/records/multisig-rehearsal.jsonl` 会记录每步 tx 与费用。
7. 负向验证（每次演练必做）：
   - 只发 1 个签名 → `executed=false`，无转账；
   - 订单过期后再 approve → 多签执行 tx `out_msgs=0`（expired 111），无转账；
   - `update-signers` 更换签名人 → 多签地址不变、`get_multisig_data` 更新。
8. 实测 gas（2026-11 测试网，详见 `ops/records/multisig-rehearsal.md`）：propose ≈0.002 TON、approve+execute ≈0.002 TON、部署 ≈0.0021 TON；多签需常备 ≥0.3 TON（建议 1 TON 以上）作为 order 执行/存储 gas。

