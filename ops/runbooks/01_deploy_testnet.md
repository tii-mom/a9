# 01 — A9 测试网部署 Runbook（TON testnet）

**版本**：V7（时间参数）· 2026-11-05
**Owner**：testnet-ops
**权威口径**：docs/00_DECISIONS_V2.md（V7 时间参数）、docs/06_DEPLOYMENT.md、docs/11_CONTRACT_PLAN.md
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

# 2) 真实部署（推荐：整体 deploy-emulation；会部署 Jetton + mint + TV + RC + 绑定）
export OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<acton-wallet-name>
node ops/scripts/15_deploy_contracts.mjs --execute   # acton script --net testnet scripts/deploy-emulation.tolk
node ops/scripts/65_set_jetton_wallets.mjs --execute --query-only   # 只查询/登记三个 canonical 钱包（整体部署已内置 wiring）
node ops/scripts/70_bind_roles.mjs --mark-bound-only                # 记录绑定并人工核对（15 已执行 InitController）
node ops/scripts/40_init_params.mjs --execute --online
OPS_CONFIRM=YES node ops/scripts/55_fund_ton.mjs --execute
OPS_CONFIRM=YES node ops/scripts/50_fund_vaults.mjs --execute --all
node ops/scripts/60_verify_and_register.mjs --execute
node ops/scripts/verify_deployment.mjs --online --save
# 最后：开 R1（R1 无 PREVIEW，需 admin 手动 OpenRound）
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<acton-wallet-name> node ops/scripts/80_admin_ops.mjs --action open-round --round 1 --twap24h <USD_E8>

# 备选：只做 Jetton 分步（10/11，位置参数），TV/RC 仍用 15 整体部署
# node ops/scripts/10_deploy_jetton.mjs --execute
# node ops/scripts/11_mint_and_lock_jetton.mjs --execute
~~~

> 注意：**整体部署会执行 InitController（不可逆，TeamVault.controller 一旦写入不可改）**；脚本签名前必须在硬件钱包屏幕核对 TeamVault/RoundController 两个地址。宁可停在 dry-run 也不要试错。

---

## 1. 前置条件（缺一不可）

| # | 前置条件 | 检查方式 | 负责 |
| --- | --- | --- | --- |
| 1 | 参数已冻结并签字（V7：P0=116000、2×、12h/36h/24h、24 根/16、限额、技术终止） | node ops/scripts/00_preflight.mjs 全 PASS；参数哈希记入签字单 | 项目方 |
| 2 | 合约源码已构建、单元/集成测试通过 | cd contracts && acton build && acton test | 合约负责人 |
| 3 | 部署脚本已存在（contracts/scripts/deploy-emulation.tolk、contracts/scripts/deploy/deploy_jetton_master.tolk、mint_and_lock_jetton.tolk） | ls contracts/scripts；与命令模板逐条比对 | 合约负责人 |
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
| A9_SIGNER_WALLET | a9-deployer / treasury | 广播脚本签名钱包名（fund_jetton/fund_ton/admin_op），缺省 TON_DEPLOYER_WALLET | 否 |
| OPS_ALLOW_EMULATION | true | 本地验证广播（不真实上链，可打印 trace hash） | 否 |
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
node ops/scripts/deploy_all.mjs                     # whole：15 → 40 → 55 → 50 → 60 → 90（dry-run）
node ops/scripts/deploy_all.mjs --mode jetton       # jetton：10 → 11（dry-run）
node ops/scripts/10_deploy_jetton.mjs
node ops/scripts/11_mint_and_lock_jetton.mjs
node ops/scripts/15_deploy_contracts.mjs
node ops/scripts/40_init_params.mjs
node ops/scripts/20_deploy_teamvault.mjs
node ops/scripts/30_deploy_round_controller.mjs
node ops/scripts/65_set_jetton_wallets.mjs
node ops/scripts/70_bind_roles.mjs
node ops/scripts/55_fund_ton.mjs
node ops/scripts/50_fund_vaults.mjs --all
node ops/scripts/60_verify_and_register.mjs
node ops/scripts/verify_deployment.mjs --offline
~~~

验收 dry-run 输出：

- [ ] 每个脚本打印 [DRY-RUN]，退出码 0；没有发任何交易。
- [ ] 40_init_params 生成 ops/records/params-snapshot.json 与 ops/records/round-controller.init.json，字段与 V7 一致（12h/36h/24h、24 根 × 1h、阈值 16）。
- [ ] 50_fund_vaults --all 显示五笔合计 = 100 亿 A9。
- [ ] 命令模板中的 {contractsDir}、{treasury}、{initDataFile} 等全部被替换（无 {...} 残留）。
- [ ] 登记表未被静默改写（60 在 dry-run 只校验，不落真实地址）。

---

## 5. 部署步骤（整体部署是唯一推荐路径；Jetton 分步仅用于组建测试）

> **唯一推荐部署路径（测试网）**：
> `15_deploy_contracts.mjs --execute`（deploy-emulation，含 Jetton + mint + TV + RC + SetJettonWallet + **SetJettonWalletCode** + **SetTeamWalletJettonWallet** + InitController）
> → `65_set_jetton_wallets.mjs --execute --query-only`（只查询/登记 RC/TV/teamWallet 三个 canonical 钱包）
> → `70_bind_roles.mjs --mark-bound-only`（记录绑定并人工核对；15 已 InitController，不要再发）
> → `40`（参数校验）→ `55`（TON gas）→ `50`（注资）→ `60`（登记表/地址簿）→ `90`（验收）→ `80 open-round R1`。
> **stepwise 65 广播 BLOCKED**：admin_op 不提供 set-jetton-wallet-code / set-team-wallet-jetton-wallet（contract-dev 确认不补）。

### Step 0 — preflight

~~~bash
node ops/scripts/00_preflight.mjs
~~~

检查：参数不变量、登记表结构、密钥来源存在性（不读取内容）、Acton 钱包、工具链、合约目录。

失败处理：
- 参数不变量失败：修正 ops/config/testnet.params.json，重跑 selftest，**不要**绕过。
- contracts/ 或 build/ 不存在：等合约负责人完成构建。
- 未发现 Acton 钱包：cd contracts && acton wallet import（交互），或 acton wallet new（仅测试）。

### Step 15 — 整体部署（推荐；Jetton + TeamVault + RC + 绑定一次完成）

~~~bash
node ops/scripts/15_deploy_contracts.mjs --execute
# 等价：cd contracts && acton script --net testnet scripts/deploy-emulation.tolk
~~~

- 顺序：JettonMaster → mint 100 亿（**mint-once：op 0x00000015，金额必须 1e19，同一笔交易内 admin 置 null**，二次 mint 报 MintClosed(75)）→ TeamVault → RoundController → get_wallet_address → SetJettonWallet → **SetJettonWalletCode（RC，0x5254001B）** → **SetTeamWalletJettonWallet（TV，0x5254001C）** → InitController（不带 teamWallet 参数）。
- P0 修复（ReturnExcessesBack 发送方是接收方钱包）：RC 通过 SetJettonWalletCode(0x5254001B) 存 JettonWallet code；TV 通过独立消息 SetTeamWalletJettonWallet(0x5254001C) 存 teamWallet 的 canonical Jetton Wallet（**不是 InitController 参数**）。15 的整体脚本已内置这两笔 wiring；只需 65 --query-only 登记地址。stepwise 65 广播 BLOCKED（见 §5 唯一推荐路径）。
- 该脚本是整体顺序部署，**没有分步子命令**；支持 --net testnet。
- 脚本输出 JettonMaster / TeamVault / RoundController / RC Jetton Wallet / TV Jetton Wallet 地址；ops 的 15 脚本会解析这些地址写入登记表（失败时用 --from-log <日志> 重试，或 10/20/30 的 adopt 模式手工登记）。
- 链上复核：total_supply=10000000000000000000、mintable=false、admin=null（verify_deployment 会检查）。
- 成功后 TV/RC 与两笔一次性 wiring（SetJettonWalletCode / SetTeamWalletJettonWallet）均已就位；接着执行 **65 --query-only**（只查询/登记 canonical 钱包）与 **70 --mark-bound-only**（记录绑定），再做 40/55/50/60/90。
- **stepwise 65 广播已 BLOCKED**（admin_op 未实现对应 op），不要尝试 65 --execute。整体部署是测试网唯一推荐路径。

### Step 10 — Jetton Master（分步备选，位置参数）

~~~bash
node ops/scripts/10_deploy_jetton.mjs --execute
# 脚本实际执行：acton script scripts/deploy/deploy_jetton_master.tolk <treasury> 10000000000000000000
~~~

- 构建产物：contracts/build/JettonMaster.json（Acton 输出 JSON，不是 boc）。
- 部署后地址写入 contracts/deploy/jetton-master.addr（文本地址）；ops 10 脚本自动读取并登记，也可用 --adopt 手工登记。
- 部署时 treasury 作为 admin；此时 total_supply=0。

### Step 11 — 初始铸造 100 亿 + 关闭 mint（分步备选）

~~~bash
node ops/scripts/11_mint_and_lock_jetton.mjs --execute
# 脚本实际执行：acton script scripts/deploy/mint_and_lock_jetton.tolk <master> <treasury> 10000000000000000000
~~~

- **mint-once**：op 0x00000015，金额必须 1e19；mint 与 admin 置 null 必须**同一笔交易**完成；二次 mint 会报 MintClosed(75)。
- 链上复核：total_supply=10000000000000000000、mintable=false、admin=null。
- burn_notification 标准 op 为 0x7bdd97de（旧别名 0x7bcdefa0 也接受）；链上对账按标准 op 过滤。

### Step 20/30 — 已由整体部署覆盖（仅保留 adopt/核对）

- 整体 deploy-emulation 已部署 TeamVault 与 RoundController；20/30 仅用于 --adopt 手工登记与核对。

### Step 65 — 只查询/登记三个 canonical Jetton Wallet（整体部署路径；stepwise 广播 BLOCKED）

~~~bash
node ops/scripts/65_set_jetton_wallets.mjs --execute --query-only
~~~

- 15 整体部署已内置 **SetJettonWalletCode(RC, 0x5254001B)** 与 **SetTeamWalletJettonWallet(TV, 0x5254001C)**，本步骤**不再发交易**，只查询并登记：
  - RoundController / TeamVault / teamWallet 的 canonical Jetton Wallet（get_wallet_address / TON Center v3）；
  - teamWalletJettonWallet 写入 registry，供 70 核对与 verify_deployment 校验。
- **stepwise 65 广播 BLOCKED**：不要运行 65 --execute（admin_op 未实现这两个一次性 op）；runbook 已按整体部署路径改写。
- 校验：verify_deployment 用 `get_jetton_wallet_code_hash()`（RC，uint256）与 `get_team_wallet_jetton_wallet()`（TV，address）硬校验。

### Step 70 — InitController（不可逆；不再带 teamWallet 参数）

~~~bash
OPS_CONFIRM=YES node ops/scripts/70_bind_roles.mjs --execute
~~~

- InitController **不带** teamWallet 参数（teamWalletJettonWallet 已由整体部署的 TV.SetTeamWalletJettonWallet(0x5254001C) 写入）；脚本只要求 RC/TV canonical 钱包已登记。
- **整体部署路径已由 15 完成 InitController**：这里只跑 `--mark-bound-only` 记录绑定并人工核对；只有手工分步部署（未 init）才执行真实 InitController。
- 双人核对 TeamVault 地址、RC 地址。

### Step 40 — 参数初始化校验

~~~bash
node ops/scripts/40_init_params.mjs --execute --online
~~~

- 生成 ops/records/params-snapshot.json（配置哈希、opcodes、阶梯）。
- 整体部署已完成 RC 初始化，本步骤只做链上校验，不发送初始化交易。
- --online：调用 get_protocol_config 逐字段比对（17 个数值字段）；任一不匹配 → FAIL，禁止开轮。
- stakingJettonWallet 地址字段用 Acton rpc 人工核对（整体部署已 SetJettonWallet）。

### Step 55 — TON gas 充值（RC ≥20 TON / TeamVault ≥10 TON）

~~~bash
OPS_CONFIRM=YES node ops/scripts/55_fund_ton.mjs --execute
~~~

- contracts/deploy/params.testnet.json 要求 RC ≥20 TON、TV ≥10 TON；每条跨合约指令约 0.05 TON。
- 余额不足时跨合约消息（release/burn/ack）会失败，轮次卡在 SETTLING。
- 实际调用：`cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<name> acton script --net testnet scripts/deploy/fund_ton.tolk <toAddress> <amountTon 整数>`；amountTon 为整数 TON（20/10），脚本自动加 1 TON 缓冲。
- 本地验证广播：加 OPS_ALLOW_EMULATION=true（不真实上链，可打印 trace hash）；真实网络必须 --net testnet。
- 地址优先读登记表，缺失时回退 contracts/deploy/{round-controller,team-vault}.addr。

### Step 50 — 注资与初始分配

~~~bash
OPS_CONFIRM=YES node ops/scripts/50_fund_vaults.mjs --execute --all
~~~

五笔分配（合计 100 亿）：

| 分配 | 金额 (A9) | 接收方 |
| --- | --- | --- |
| 十轮奖励 | 7,000,000,000 | RC Jetton Wallet（owner = RC，同时托管本金+奖励） |
| 团队 | 1,200,000,000 | TeamVault Jetton Wallet（owner = TeamVault） |
| 内盘销售 | 800,000,000 | 团队内盘管理钱包（公开可查） |
| 流动性 | 500,000,000 | 流动性热钱包 |
| 营销 | 500,000,000 | 营销热钱包 |

- TEP-74 转账的链上目标是**接收者的 Jetton Wallet**（由发送方钱包内部用 calcDeployedJettonWallet(owner) 推导）；脚本会先解析并逐笔核对余额。
- 每笔成功后写 registry.funding，60 会核对五笔是否全部 CONFIRMED。
- 可分步：先只做奖励 + 团队（不加 --all），确认后再补分配。
- 流动性：5 亿 A9 全额转 liquidityWallet（不变）；冷启动池用其中 **2 亿 A9 + $232,000 USDT**（同价 $0.00116，占流动性额度 **40%**，剩余 **3 亿 A9** 后续加池）。
- 实际调用：`cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<name> JETTON_MASTER_ADDRESS=<master> acton script --net testnet scripts/deploy/fund_jetton.tolk <recipientOwner> <amountRaw>`。**位置参数必须是接收 owner（RC/TV/热钱包地址），不是 Jetton Wallet 地址**；传钱包地址会被发送方再次推导成 wallet-of-wallet（2026-11-05 事故根因，见 ops/records/incident-2026-11-05-funding-misallocation.md）。
- 首次向未部署的 Jetton Wallet 转账会由发送方附带 state init 部署该钱包；建议第一笔先用 1 raw 小额试探，确认 `get_wallet_data` 到账后再发全额。
- master 也可由 contracts/deploy/jetton-master.addr 自动提供；脚本会校验 signer 的 A9 余额并在每笔后暂停核对接收钱包余额。
- 广播前脚本校验 signer 的 A9 余额，不足会可读报错并 exit 1；每笔成功后写 registry.funding。

### Step 60 — 登记表定稿 + 地址簿

~~~bash
node ops/scripts/60_verify_and_register.mjs --execute
~~~

- 写入 paramsDigest、校验地址/资金、生成 ops/records/address-book.testnet.md 与 .json。
- 地址簿含合约、钱包（标注公开性）、注资记录、配置哈希与登记表摘要。
- 团队/营销/流动性地址：**不公开**，只出现在内部地址簿；对外透明页只写“项目方热钱包持有”。

### Step 95 — 开 R1（R1 无 PREVIEW）

~~~bash
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<acton-wallet-name> node ops/scripts/80_admin_ops.mjs --action open-round --round 1 --twap24h <USD_E8>
~~~

- contracts/README §3.2：R1 无 PREVIEW，OpenRound 交易中 stakeOpenAt = now，并锁定 target = max(P0×2^tier, 2×TWAP24h)。
- 开轮前确认：TeamVault 绑定、SetJettonWallet、TON gas、奖励池/团队池已注资、公告已发、值班已就位。
- 实际调用：`cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<name> ROUND_CONTROLLER_ADDRESS=<rc> acton script --net testnet scripts/deploy/admin_op.tolk open-round 1 <twap24h>`。
- op 映射：open-round(extra=twap24h)、close-staking(extra=twap1h)、start-observation(roundId)、finalize-round(roundId)、pause-oracle(extra=reason)、resume-oracle、abort-technical、retry-pending(roundId，无权限/任何人可触发，消息 value ≥0.3 TON)；set-jetton-wallet / set-jetton-wallet-code / set-team-wallet-jetton-wallet / init-controller 分别由 65/70 脚本调用（A9_TARGET_ADDRESS+A9_JETTON_WALLET_ADDRESS、A9_JETTON_WALLET_CODE_BOC64、A9_TEAM_WALLET_JETTON_WALLET、TEAM_VAULT_ADDRESS+A9_CONTROLLER_ADDRESS）。
- RC 地址优先读登记表，缺失时回退 contracts/deploy/round-controller.addr。
- 开轮后核对 TargetPriceSet 事件与 RoundView 时间字段。
- 开轮后核对 TargetPriceSet 事件与 RoundView 时间字段。

### Step 90 — 全量验收

~~~bash
node ops/scripts/verify_deployment.mjs --online --save
~~~

- 离线：参数、阶梯、分配、登记表结构、资金记录。
- 在线：合约账户 active、RC/TV code hash 与 build 一致、Jetton supply/mintable/admin=null、RC jettonWalletCode hash 与 JettonWallet.json 一致、TV teamWalletJettonWallet = get_wallet_address(teamWallet)、pendingQueryId 全 0、RC 配置逐字段、R1 窗口与 target 锁定、TeamVault 参数。
- 任一 FAIL → 不得开 R1；先按失败项回退（§9）。

---

## 6. 手工部署 / --adopt 路径

若 Acton 部署脚本尚未交付或不可用：

1. 由合约负责人在钱包/IDE 完成整体部署（deploy-emulation）或分步 Jetton 部署，记录地址、交易哈希、code hash。
   若已有整体部署日志：node ops/scripts/15_deploy_contracts.mjs --from-log <日志> 可解析并登记地址（不重新部署）。
2. 用 --adopt 登记（脚本只做 CRC 校验，不发交易）：

~~~bash
node ops/scripts/10_deploy_jetton.mjs --adopt <jettonMaster>
node ops/scripts/20_deploy_teamvault.mjs --adopt <teamVault>
node ops/scripts/30_deploy_round_controller.mjs --adopt <roundController>
~~~

3. 其余步骤（40/65/70/55/50/60/90）不变；65 的 Jetton Wallet 地址可由 v3 / get_wallet_address 解析。
4. adopt 地址必须是**测试网地址**（address flag 含 testnet）；主网地址会被拒绝。

---

## 7. 地址登记表工作流

~~~text
ops/config/testnet.addresses.template.json   // 人工填写模板（说明用途）
        │
        ├─ 15 整体部署输出解析 / 10/20/30 --adopt ──► ops/config/testnet.registry.json（唯一事实来源）
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

- [ ] 成功轮：24 根齐备且 ≥16 达标 → 本金可领取、7 亿奖励可 claimAll、TeamVault 释放 1.2 亿且只释放一次；<16 即失败（V7 口径：≥16 成功、≤15 失败，无中间态）。
- [ ] 失败轮：三笔销毁（7 亿 + 1.2 亿 + 全部本金）→ total_supply 实际减少，三笔独立确认。
- [ ] 无人质押轮：照常 24 根观察；失败销毁奖励 + 团队额度；通过时 0 人则销毁 7 亿（D-18b）。
- [ ] 预言机暂停/恢复：暂停不判负、不销毁；恢复后重收满 24 根。
- [ ] claimAll 跨轮（2~10 轮）合并一笔、幂等、重复调用不重复派发。
- [ ] TeamVault 非 RC 指令被拒；同轮 release/burn 互斥幂等。
- [ ] 技术终止：需 14 天暂停或观察超时 7 天才能触发；若测试网无法等待，使用独立的短参数测试部署演练，**不要**改主测试网参数。
- [ ] 每次演练都用 reconcile.mjs 对账，并把 CSV 归档到 ops/records/。

---

## 8.1 与 contracts/README 的工程裁决（部署/运营必须知悉）

1. **无独立 StakingVault / RewardVault 地址**：RC 只有一个 Jetton Wallet，同时托管质押本金 + 每轮 7 亿奖励；不要部署/登记不存在的 vault 地址。
2. **单地址限额为固定硬顶 20,000,000 A9**（= 200M × 10%，contracts/README §9.1），不是动态 10%。
3. **24 根齐备后 ≥16 成功、≤15 失败**（无中间态，V7 口径）；ops 公告与对账按此口径。
4. **R1 无 PREVIEW**：需 admin 手动 OpenRound（带 twap24h）。
5. **SetJettonWallet 一次性**（0x52540016），必须早于 InitController/第一轮。
6. **Burn ack 信任模型（测试网）**：BurnAck 来自 config.jettonMaster（部署方充当 ack 权威）；burn_notification 标准 op 为 0x7bdd97de（旧别名 0x7bcdefa0 也接受），对账按标准 op 过滤；主网前必须改为受审计扩展或“标准 burn + 链下对账 + owner 确认”。
7. **晚开窗兜底**：keeper 错过整个 36h 报名窗口时 OpenRound 会重锚 stakeOpenAt；正常路径不触发，监控三倒计时。
8. **Jetton mint-once**：op 0x00000015，金额 1e19，admin 置 null 必须同笔交易；二次 mint 报 MintClosed(75)。verify_deployment 检查 total_supply=1e19 / mintable=false / admin=null / decimals=9 / symbol=A9。
9. **P0 修复 ReturnExcessesBack**：真实 TEP-74 退款由接收方钱包发出；RC 必须 SetJettonWalletCode(0x5254001B) 存 JettonWallet code，TV 必须通过 SetTeamWalletJettonWallet(0x5254001C) 存 teamWallet canonical 钱包；verify_deployment 用 get_jetton_wallet_code / get_team_wallet_jetton_wallet 硬校验，并检查 pendingQueryId 全 0。

---

## 8.2 注资事故复盘与防呆检查清单（2026-11-05）

2026-11-05 测试网注资时，70 亿 A9 被转入一个 owner 为 RC Jetton Wallet 地址的错误钱包（不可找回）。根因是 fund_jetton 的位置参数是 **接收 owner**，而 ops 把 **目标 Jetton Wallet 地址** 传了进去，发送方钱包于是又推导了一次（wallet-of-wallet）。完整记录见 ops/records/incident-2026-11-05-funding-misallocation.md。

**注资前必须逐项打印并人工核对（四者必须一致）**：
1. 接收 owner 地址（RC / TeamVault / 热钱包）
2. 接收 owner → expected wallet（fund_jetton 脚本打印的推导值）
3. JettonMaster.get_wallet_address(owner) 的链上返回值
4. ops registry / ops/records/funding-recipients.json 里登记的 canonical wallet

**强制流程**：
- 第一笔必须 ≤ 1 A9 小额试探；链上确认 `get_wallet_data(dest).jettonBalance` 确实 +1 A9 后，才允许发大额。
- 每笔转账后独立查询 `get_wallet_data(dest)`，与「转前余额 + 金额」精确比对；不一致立即停止。
- **dry-run 不解析发送方推导，不能替代小额实盘验证**。
- 真实注资命令必须带 `--probe`：`OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/50_fund_vaults.mjs --execute --all --probe`。

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
