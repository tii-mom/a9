# 01 — A9 测试网部署 Runbook（TON testnet）

**版本**：V6.2 · 2026-11-05
**Owner**：testnet-ops
**权威口径**：docs/00_DECISIONS_V2.md（V6.2）、docs/06_DEPLOYMENT.md、docs/11_CONTRACT_PLAN.md
**对应脚本**：ops/scripts/00_preflight.mjs → 60_verify_and_register.mjs → verify_deployment.mjs
**默认模式**：所有脚本默认 **DRY-RUN**；只有 OPS_EXECUTE=1（写操作再加 OPS_CONFIRM=YES）才广播交易。

---

## 0. TL;DR（有合约构建产物后）

~~~bash
cd /Users/yu1/Desktop/BAM

# 0) 参数检查 + 工具链/钱包检查（不发交易）
node ops/scripts/00_preflight.mjs

# 1) 完整演练：所有步骤 dry-run，逐条核对命令与地址
node ops/scripts/deploy_all.mjs

# 2) 真实部署（每步会要求人工确认；建议逐步执行，不要一把梭）
export OPS_EXECUTE=1
node ops/scripts/10_deploy_jetton.mjs --execute
node ops/scripts/11_mint_and_lock_jetton.mjs --execute
node ops/scripts/20_deploy_teamvault.mjs --execute
node ops/scripts/30_deploy_round_controller.mjs --execute
node ops/scripts/40_init_params.mjs --execute --online
OPS_CONFIRM=YES node ops/scripts/70_bind_roles.mjs --execute
node ops/scripts/50_fund_vaults.mjs --execute --all
node ops/scripts/60_verify_and_register.mjs --execute
node ops/scripts/verify_deployment.mjs --online --save
~~~

> 注意：**70_bind_roles.mjs 的 InitController 不可逆**（TeamVault.controller 一旦写入不可改），执行前必须双人核对两个地址；宁可停在 dry-run 也不要试错。

---

## 1. 前置条件（缺一不可）

| # | 前置条件 | 检查方式 | 负责 |
| --- | --- | --- | --- |
| 1 | 参数已冻结并签字（V6.2：P0=116000、2×、18/72h/12、限额、技术终止） | node ops/scripts/00_preflight.mjs 全 PASS；参数哈希记入签字单 | 项目方 |
| 2 | 合约源码已构建、单元/集成测试通过 | cd contracts && acton build && acton test | 合约负责人 |
| 3 | 部署脚本已存在（contracts/scripts/deploy/*.tolk、contracts/scripts/ops/*.tolk） | ls contracts/scripts；与命令模板逐条比对 | 合约负责人 |
| 4 | Acton 版本锁定（当前 1.1.0 / Tolk 1.4.1，与 contracts/Acton.toml 一致） | acton --version；ops/config/testnet.params.json 的 toolchain.pinnedVersion | 部署者 |
| 5 | Acton 项目钱包已导入（助记词只本地交互输入） | cd contracts && acton wallet list | 部署者 |
| 6 | 部署者钱包测试网 TON 余额足够（建议 ≥25 TON） | 浏览器/acton wallet 查询；00_preflight 会提示 | 部署者 |
| 7 | 收款地址已提供并登记：admin owner、treasury、teamWallet、marketingWallet、liquidityWallet、teamInternalWallet | 登记表/环境变量；不公开地址至少向审计/交易所披露 | 项目方 |
| 8 | 参数哈希、部署时间窗、公告排期、值班人已确认 | 本 runbook §11 签字表 | Lead |
| 9 | Worker API 已就绪（用于展示/对账；非部署阻断） | curl /api/health | 后端 |

**红线**：不要因为没有测试网 TON 而向任何人索要主网私钥；不要使用裸私钥（64 位 hex）；不要在共享屏幕/终端历史中粘贴助记词。

---

## 2. 环境变量（只作占位，绝不写入仓库）

| 变量 | 示例（占位） | 用途 | 是否敏感 |
| --- | --- | --- | --- |
| OPS_EXECUTE | 1 | 开启真实链上操作 | 否 |
| OPS_CONFIRM | YES | 不可逆/写操作二次确认 | 否 |
| OPS_REGISTRY | ops/config/testnet.registry.json | 登记表路径（selftest 用临时文件） | 否 |
| TON_DEPLOYER_WALLET | a9-deployer | Acton 项目钱包名（私钥在本地 keystore） | 否 |
| TON_DEPLOYER_MNEMONIC | <24-word mnemonic> | **仅非 Acton 适配器**使用；由密码管理器/硬件钱包提供 | **是** |
| TON_ADMIN_OWNER_ADDRESS | <admin owner address> | RC 单密钥 owner | 是（地址本身不敏感，但关联身份） |
| TON_TREASURY_ADDRESS | <treasury address> | 初始 100 亿接收地址 | 是（不公开） |
| TONCENTER_API_KEY | <testnet key> | TON Center 只读查询（无 key 限速 1 RPS） | **是** |
| TELEGRAM_BOT_TOKEN / TELEGRAM_OPS_CHAT_ID | <token> / <chat id> | 告警与公告发送 | **是** |
| ADMIN_TOKEN | <worker admin token> | Worker admin API（监控可选） | **是** |

推荐做法：使用 acton wallet import 交互导入助记词，**不设置** TON_DEPLOYER_MNEMONIC；只有非 Acton 工具链才用环境变量，并在使用后立即 unset。

---

## 3. 工具链锁定

~~~bash
export PATH=$HOME/.acton/bin:$PATH
acton --version          # 期望 acton 1.1.0
cd contracts && acton build && acton test
~~~

- 构建产物在 contracts/build/（JSON/ABI）与 contracts/build/abi/（消息 ABI）。
- 任何升级必须：更新 contracts/Acton.toml 的 acton 版本 → 重新构建 → 重跑测试 → 更新 toolchain.pinnedVersion → 重新生成配置哈希。
- 部署脚本命令模板在 ops/config/testnet.params.json → toolchain.adapters.acton.commands；与 contracts/scripts 实际参数不一致时**先改模板**，不要手工改脚本逻辑。

---

## 4. Dry-run 演练（强制）

~~~bash
node ops/scripts/00_preflight.mjs
node ops/scripts/10_deploy_jetton.mjs
node ops/scripts/11_mint_and_lock_jetton.mjs
node ops/scripts/20_deploy_teamvault.mjs
node ops/scripts/30_deploy_round_controller.mjs
node ops/scripts/40_init_params.mjs
node ops/scripts/70_bind_roles.mjs
node ops/scripts/50_fund_vaults.mjs --all
node ops/scripts/60_verify_and_register.mjs
node ops/scripts/verify_deployment.mjs --offline
~~~

验收 dry-run 输出：

- [ ] 每个脚本打印 [DRY-RUN]，退出码 0；没有发任何交易。
- [ ] 40_init_params 生成 ops/records/params-snapshot.json 与 ops/records/round-controller.init.json，字段与 V6.2 一致。
- [ ] 50_fund_vaults --all 显示五笔合计 = 100 亿 A9。
- [ ] 命令模板中的 {contractsDir}、{treasury}、{initDataFile} 等全部被替换（无 {...} 残留）。
- [ ] 登记表未被静默改写（60 在 dry-run 只校验，不落真实地址）。

---

## 5. 部署步骤（逐步执行）

### Step 0 — preflight

~~~bash
node ops/scripts/00_preflight.mjs
~~~

检查：参数不变量、登记表结构、密钥来源存在性（不读取内容）、Acton 钱包、工具链、合约目录。

失败处理：
- 参数不变量失败：修正 ops/config/testnet.params.json，重跑 selftest，**不要**绕过。
- contracts/ 或 build/ 不存在：等合约负责人完成构建。
- 未发现 Acton 钱包：cd contracts && acton wallet import（交互），或 acton wallet new（仅测试）。

### Step 10 — Jetton Master（TEP-74）

~~~bash
node ops/scripts/10_deploy_jetton.mjs --execute
~~~

- 部署参数来自 ops/config/testnet.params.json 的 token（A9 / A9 / 9 位）。
- 成功后脚本从命令输出解析地址并写入 contracts.jettonMaster；解析失败时用 --adopt <address> 手工登记。
- 立即验证：get_jetton_data 的 total_supply 应为 0（未铸造），mint 权限属于 treasury/部署者。

### Step 11 — 初始铸造 100 亿 + 关闭 mint

~~~bash
node ops/scripts/11_mint_and_lock_jetton.mjs --execute
~~~

- 铸造 100 亿 A9 到 treasury（冷钱包）。
- **必须**在同一窗口关闭 mint（admin 置空）；否则 verify_deployment 会 FAIL，不得继续。
- 链上复核：total_supply = 10000000000000000000、mintable = false。

### Step 20 — TeamVault（controller=null 部署）

~~~bash
node ops/scripts/20_deploy_teamvault.mjs --execute
~~~

- 部署时 controller 必须为 **null**（contracts/contracts/TeamVault.tolk 注释：随后通过 InitController 一次绑定）。
- 参数：admin、teamWallet、teamRoundRaw = 120000000000000000。
- 此时**不要**注入 12 亿；先完成 RC 部署与 InitController，再注资。

### Step 30 — RoundController

~~~bash
node ops/scripts/30_deploy_round_controller.mjs --execute
~~~

- 脚本先生成 ops/records/round-controller.init.json（addresses / vaults / econ / timing），再调用部署命令。
- 关键常量：P0=116000、2×、PREVIEW 86400、报名 259200、18 根 × 14400、阈值 12、限额（10000 / 1000 bps / 2 亿）、技术终止（14 天 / 7 天）。
- RC **不可升级**（无代理）；部署即终局，参数写错只能重新部署一套（见 §9）。

### Step 40 — 参数初始化校验

~~~bash
node ops/scripts/40_init_params.mjs --execute --online
~~~

- 生成 ops/records/params-snapshot.json（配置哈希、opcodes、阶梯）。
- --online：调用 get_protocol_config 逐字段比对（17 个数值字段）；任一不匹配 → FAIL，禁止开轮。
- 若 RC 初始化数据含 stakingJettonWallet（RC 的 Jetton Wallet）：需在 RC 部署后解析并回填，与合约负责人确认派生方式。

### Step 70 — 角色绑定（不可逆）

~~~bash
OPS_CONFIRM=YES node ops/scripts/70_bind_roles.mjs --execute
~~~

- 发送 InitController(roundController) 给 TeamVault，调用者必须是 TeamVault.admin。
- 双人核对：TeamVault 地址、RC 地址、admin 钱包来源；核对后登记表写入 bindings.teamVaultAcceptsOnly。
- 复核：get_config 的 controller 必须等于 RC；建议截图 + 交易哈希归档。
- 失败/填错：controller 不可改 → 只能废弃 TeamVault，**在注资前**重新部署（注资后极难恢复）。

### Step 50 — 注资与初始分配

~~~bash
node ops/scripts/50_fund_vaults.mjs --execute --all
~~~

五笔分配（合计 100 亿）：

| 分配 | 金额 (A9) | 接收方 |
| --- | --- | --- |
| 十轮奖励 | 7,000,000,000 | RC 的奖励金库 Jetton Wallet（owner = RC） |
| 团队 | 1,200,000,000 | TeamVault 的 Jetton Wallet（owner = TeamVault） |
| 内盘销售 | 800,000,000 | 团队内盘管理钱包（公开可查） |
| 流动性 | 500,000,000 | 流动性热钱包 |
| 营销 | 500,000,000 | 营销热钱包 |

- TEP-74 转账目标是**接收者的 Jetton Wallet**，脚本会先解析再转；解析失败即终止（避免转错）。
- 每笔成功后写 registry.funding，60 会核对五笔是否全部 CONFIRMED。
- 可分步：先只做奖励 + 团队（不加 --all），确认后再补分配。

### Step 60 — 登记表定稿 + 地址簿

~~~bash
node ops/scripts/60_verify_and_register.mjs --execute
~~~

- 写入 paramsDigest、校验地址/资金、生成 ops/records/address-book.testnet.md 与 .json。
- 地址簿含合约、钱包（标注公开性）、注资记录、配置哈希与登记表摘要。
- 团队/营销/流动性地址：**不公开**，只出现在内部地址簿；对外透明页只写“项目方热钱包持有”。

### Step 90 — 全量验收

~~~bash
node ops/scripts/verify_deployment.mjs --online --save
~~~

- 离线：参数、阶梯、分配、登记表结构、资金记录。
- 在线：合约账户 active、Jetton supply/mintable、RC 配置逐字段、R1 窗口与 target 锁定、TeamVault 参数。
- 任一 FAIL → 不得开 R1；先按失败项回退（§9）。

---

## 6. 手工部署 / --adopt 路径

若 Acton 部署脚本尚未交付或不可用：

1. 由合约负责人在钱包/IDE 完成部署，记录地址、交易哈希、code hash。
2. 用 --adopt 登记（脚本只做 CRC 校验，不发交易）：

~~~bash
node ops/scripts/10_deploy_jetton.mjs --adopt <jettonMaster>
node ops/scripts/20_deploy_teamvault.mjs --adopt <teamVault>
node ops/scripts/30_deploy_round_controller.mjs --adopt <roundController>
~~~

3. 其余步骤（40/70/50/60/90）不变。
4. adopt 地址必须是**测试网地址**（address flag 含 testnet）；主网地址会被拒绝。

---

## 7. 地址登记表工作流

~~~text
ops/config/testnet.addresses.template.json   // 人工填写模板（说明用途）
        │
        ├─ 10/20/30 --adopt 或部署输出解析 ──► ops/config/testnet.registry.json（唯一事实来源）
        │
        └─ 60_verify_and_register ──► ops/records/address-book.testnet.{md,json}
~~~

- 登记表字段：地址、raw、deployTxHash、codeHash、deployedAt、funding、bindings、paramsDigest、verification digest。
- registryDigest = 合约+钱包+绑定+配置哈希的 sha256，用于对外公布“地址与配置未被篡改”。
- 每次写登记表都更新时间戳；不要把私钥、助记词、API key 写入登记表。
- 地址变更（例如重建部署）必须先人工确认旧地址作废，再清空对应字段；不要覆盖式静默替换。

---

## 8. 部署后演练（开 R1 前必须完成）

对应 docs/06 §5 / docs/10 §10：

- [ ] 成功轮：18 根中 ≥12 达标 → 本金可领取、7 亿奖励可 claimAll、TeamVault 释放 1.2 亿且只释放一次。
- [ ] 失败轮：三笔销毁（7 亿 + 1.2 亿 + 全部本金）→ total_supply 实际减少，三笔独立确认。
- [ ] 无人质押轮：照常 18 根观察；失败销毁奖励 + 团队额度；通过时 0 人则销毁 7 亿（D-18b）。
- [ ] 预言机暂停/恢复：暂停不判负、不销毁；恢复后重收满 18 根。
- [ ] claimAll 跨轮（2~10 轮）合并一笔、幂等、重复调用不重复派发。
- [ ] TeamVault 非 RC 指令被拒；同轮 release/burn 互斥幂等。
- [ ] 技术终止：需 14 天暂停或观察超时 7 天才能触发；若测试网无法等待，使用独立的短参数测试部署演练，**不要**改主测试网参数。
- [ ] 每次演练都用 reconcile.mjs 对账，并把 CSV 归档到 ops/records/。

---

## 9. 回滚与重建策略（RC 不可升级）

**核心约束**：RoundController / TeamVault 都不可升级；TeamVault.controller 一旦 InitController 不可改。因此只能“修参数后重建”，不能热修。

| 阶段 | 可回滚程度 | 处理 |
| --- | --- | --- |
| 部署 Jetton 后、注资前 | 高 | 废弃 Jetton（测试网），重新部署；或继续用该 Jetton 但重建其他合约 |
| TeamVault 部署后、InitController 前 | 高 | 重新部署 TeamVault |
| InitController 后、注资前 | 中 | 重新部署 TeamVault + RC（旧 TeamVault 空置），重新 InitController |
| 注资后、开 R1 前 | 低 | 资金已进入不可改合约；若参数错误，只能重建整套并用新 Jetton 重新分配（测试网推荐），或按错误参数跑完演练后重建 |
| R1 开轮后 | 极低 | 不热修；记录问题 → 按规则结算/技术终止 → 下一套部署修复 |

**重建检查**：新 Jetton 意味着新的 total_supply；旧的测试数据保留作历史，不要混用地址。重建后必须更新登记表、地址簿、配置哈希，并公告。

---

## 10. 常见故障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 未发现 Acton 钱包 a9-deployer | 未 import / 钱包名不同 | cd contracts && acton wallet list；acton wallet import；或设置 TON_DEPLOYER_WALLET |
| 部署命令 exit≠0 | 工具链参数与模板不一致 / 余额不足 / RPC 限速 | 对照 contracts/scripts 实际参数更新模板；充值 gas；配置 TONCENTER_API_KEY |
| 地址解析失败 | 部署脚本输出格式变化 | 用 --adopt <address> 登记，并把输出片段反馈给合约负责人 |
| InitController revert | 调用者不是 admin / 已初始化 / controller 为空 | 核对 admin 钱包；已初始化则**不要**重试，检查 get_config |
| 注资时 Jetton Wallet 解析失败 | TON Center v3 不可用 / owner 地址错误 | 配置 API key；人工用 get_wallet_address 核对；解析失败禁止盲转 |
| verify_deployment FAIL mintable=true | 忘记关闭 mint | 立即关闭 mint；未关闭前不得注资/开轮 |
| supply 不一致 | 手工转账绕过脚本 / 分配漏记 | 停止后续步骤，用 reconcile.mjs --chain 对账，补记录或重建 |

---

## 11. 签字与证据归档

| 项 | 记录 | 负责人 | 时间 |
| --- | --- | --- | --- |
| 参数哈希（paramsDigest） | sha256:... | 部署者 | |
| 合约 code hash（Jetton/RC/TeamVault） | | 合约负责人 | |
| 部署交易哈希（每步） | | 部署者 | |
| 登记表摘要（registryDigest） | | 部署者 | |
| 地址簿 ops/records/address-book.testnet.md | 归档链接 | Ops | |
| 验收报告 ops/records/verify-deployment-YYYY-MM-DD.json | 归档链接 | Ops | |
| 演练记录（成功/失败/暂停/技术终止） | ops/drills/ | Ops | |
| 双人核对签字（InitController） | 截图 + 交易哈希 | 部署者 + 复核人 | |

> 证据保留至少到主网后 90 天；所有对外披露只使用链上可验证字段。

---

*本 runbook 与 ops/config/testnet.params.json、脚本输出一一对应；参数变更后必须重新生成配置哈希并重跑 dry-run 与 selftest。*
