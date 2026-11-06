# 01 — A9 测试网部署 Runbook（TON testnet，v10）

**版本**：v10（2026-11-06，D-42）
**Owner**：testnet-ops
**权威口径**：contracts/README.md（§0–§5）、docs/34_V10_MIGRATION.md §4、docs/00 的 D-42
**对应脚本**：00_preflight → 15_deploy_contracts → 40 → 55 → 50 → 60 → verify_deployment → 80（open-round R1）
**默认模式**：所有脚本默认 **DRY-RUN**；只有 OPS_EXECUTE=1（写操作再加 OPS_CONFIRM=YES）才广播交易。

---

## 0. TL;DR（有合约构建产物后）

~~~bash
cd /Users/yu1/Desktop/BAM

# 0) 参数与工具链检查（不发交易）
node ops/scripts/00_preflight.mjs

# 1) 全流程 dry-run，逐条核对命令与地址
node ops/scripts/deploy_all.mjs

# 2) 真实部署（整体 deploy-emulation：JettonMaster + mint-once + RC + 钱包推导校验 + 82 亿注资）
export OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<acton-wallet-name>
node ops/scripts/15_deploy_contracts.mjs --execute
node ops/scripts/40_init_params.mjs --execute --online
OPS_CONFIRM=YES node ops/scripts/55_fund_ton.mjs --execute
OPS_CONFIRM=YES node ops/scripts/50_fund_vaults.mjs --execute --all
node ops/scripts/60_verify_and_register.mjs --execute
node ops/scripts/verify_deployment.mjs --online --save
# ↑ 默认 STRICT：必检项必须全部 PASS；任一 FAIL 不得开 R1。
#   --lenient 仅用于排查，输出不得作为开轮或上线依据。

# 3) 开 R1（R1 无预告期，部署后由 keeper 直接 OpenRound）
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<keeper-wallet-name> node ops/scripts/80_admin_ops.mjs --action open-round --round 1 --twap24h <USD_E8>

# 备选：只做 Jetton 分步（10/11，位置参数），RC 仍用 15 部署
# node ops/scripts/10_deploy_jetton.mjs --execute
# node ops/scripts/11_mint_and_lock_jetton.mjs --execute
~~~

> **注意**：v10 **没有 admin**，RC 不可升级。keeper 地址与 teamWallet 地址在部署时写入 RC，之后**无法修改**。部署前必须在登记表核对 `wallets.keeper` 与 `wallets.teamWallet`；宁可停在 dry-run 也不要试错。
>
> 15 完成后 RC 已持有 82 亿 A9，**不需要单独的接线步骤**（RC 在链上自行推导自己的 Jetton 钱包）。

---

## 1. 前置条件（缺一不可）

| # | 前置条件 | 检查方式 | 负责 |
| --- | --- | --- | --- |
| 1 | 参数已冻结并签字（P0=116000、倍数 2、12h/36h/24h、24 根/阈值 16、最低质押 10 万 A9、单地址每轮 2,000 万 A9、本轮总额 2 亿 A9） | `node ops/scripts/00_preflight.mjs` 全 PASS；参数哈希记入签字单 | 项目方 |
| 2 | 合约已构建并通过测试（JettonMaster、JettonWallet、RoundController 三个） | `cd contracts && acton build && acton check && acton test`；code hash 与 contracts/README §0 一致 | 合约负责人 |
| 3 | 部署脚本存在（contracts/scripts/deploy-emulation.tolk；scripts/deploy/fund_jetton.tolk、fund_ton.tolk、admin_op.tolk） | `ls contracts/scripts`；与命令模板逐条比对 | 合约负责人 |
| 4 | Acton 版本锁定（1.1.0 / Tolk 1.4.1，与 contracts/Acton.toml 一致） | `acton --version`；`ops/config/testnet.params.json` 的 toolchain.pinnedVersion | 部署者 |
| 5 | Acton 项目钱包已导入（助记词只在本地交互输入） | `cd contracts && acton wallet list` | 部署者 |
| 6 | 部署者钱包测试网 TON 足够（建议 ≥25 TON） | 浏览器或 acton wallet 查询；00_preflight 会提示 | 部署者 |
| 7 | 收款与运营地址已登记：keeper、treasury、teamWallet、marketingWallet、liquidityWallet、teamInternalWallet | 登记表 `wallets` 段；不公开地址至少向审计方披露 | 项目方 |
| 8 | 参数哈希、时间窗、公告排期、值班人已确认 | 本 runbook §11 签字表 | Lead |
| 9 | Worker API 已就绪（展示与对账用，不阻断部署） | `curl /api/health` | 后端 |

**红线**：不要向任何人索要主网私钥；不要使用裸私钥（64 位 hex）；不要在共享屏幕或终端历史里粘贴助记词。

---

## 2. 环境变量（只作占位，绝不写入仓库）

| 变量 | 示例（占位） | 用途 | 是否敏感 |
| --- | --- | --- | --- |
| OPS_EXECUTE | 1 | 开启真实链上操作 | 否 |
| OPS_CONFIRM | YES | 不可逆或写操作的二次确认 | 否 |
| OPS_REGISTRY | ops/config/testnet.registry.json | 登记表路径（selftest 用临时文件） | 否 |
| TON_DEPLOYER_WALLET | a9-deployer | Acton 项目钱包名（私钥在本地 keystore） | 否 |
| A9_SIGNER_WALLET | a9-deployer / keeper | 广播脚本的签名钱包名，缺省 TON_DEPLOYER_WALLET | 否 |
| A9_KEEPER_ADDRESS | （由 15 从登记表 `wallets.keeper` 读取） | 传给 deploy-emulation，作为 RC 的 keeper | 否（地址） |
| A9_TEAM_WALLET_ADDRESS | （由 15 从登记表 `wallets.teamWallet` 读取） | 传给 deploy-emulation，作为 RC 的团队收款钱包 | 否（地址，但不公开） |
| TON_TREASURY_ADDRESS | <treasury address> | 100 亿 mint 的接收地址 | 是（不公开） |
| OPS_ALLOW_EMULATION | true | 本地验证广播（不真实上链，可打印 trace hash） | 否 |
| TON_DEPLOYER_MNEMONIC | <24-word mnemonic> | **仅非 Acton 工具链**使用，由密码管理器或硬件钱包提供 | **是** |
| TONCENTER_API_KEY | <testnet key> | TON Center 只读查询（无 key 限速 1 RPS） | **是** |
| TELEGRAM_BOT_TOKEN / TELEGRAM_OPS_CHAT_ID | <token> / <chat id> | 告警与公告发送 | **是** |
| ADMIN_TOKEN | <worker admin token> | Worker 管理接口（监控可选） | **是** |

推荐做法：用 `acton wallet import` 交互导入助记词，**不设置** TON_DEPLOYER_MNEMONIC；只有非 Acton 工具链才用环境变量，用完立即 unset。

---

## 3. 工具链锁定

~~~bash
export PATH=$HOME/.acton/bin:$PATH
acton --version          # 期望 acton 1.1.0
cd contracts && acton build && acton check && acton test
~~~

- 构建产物在 contracts/build/（JSON/ABI）与 contracts/build/abi/（消息 ABI）。
- 升级工具链：更新 contracts/Acton.toml → 重新构建 → 重跑测试 → 更新 toolchain.pinnedVersion → 重新生成配置哈希。
- 命令模板在 ops/config/testnet.params.json → toolchain.adapters.acton.commands；与 contracts/scripts 实际参数不一致时**先改模板**，不要手工改脚本逻辑。

---

## 4. Dry-run 演练（强制）

~~~bash
node ops/scripts/00_preflight.mjs
node ops/scripts/deploy_all.mjs                    # 默认整体部署：00 → 15 → 40 → 55 → 50 → 60 → verify（dry-run）
node ops/scripts/deploy_all.mjs --mode jetton      # 分步备选：10 → 11（dry-run）
node ops/scripts/15_deploy_contracts.mjs
node ops/scripts/40_init_params.mjs
node ops/scripts/55_fund_ton.mjs
node ops/scripts/50_fund_vaults.mjs --all
node ops/scripts/60_verify_and_register.mjs
node ops/scripts/verify_deployment.mjs --offline   # 默认 STRICT；离线只覆盖不变量与登记表
~~~

> **验收模式（STRICT / LENIENT）**：`verify_deployment.mjs` 默认 STRICT。`--lenient` 仅用于排查，**输出不得作为开轮或上线依据**。`--offline` 不覆盖链上状态，**开轮前必须再跑 `--online` 且必检项全 PASS**。

验收 dry-run 输出：

- [ ] 每个脚本打印 [DRY-RUN]，退出码 0，没有发任何交易。
- [ ] 40 生成 ops/records/params-snapshot.json 与 round-controller.init.json，字段与 contracts/README §4 一致（12h / 36h / 24h、24 根 × 1h、阈值 16、最低质押 100000 A9）。
- [ ] 50 `--all` 显示 8 亿（内盘）、5 亿（流动性）、5 亿（营销）三笔；与 15 的 82 亿合计 100 亿。
- [ ] 命令模板中的占位符（{contractsDir}、{treasury} 等）全部被替换，无 `{...}` 残留。
- [ ] 登记表未被静默改写（60 在 dry-run 只校验，不落真实地址）。

---

## 5. 部署步骤（整体部署是唯一推荐路径）

> **唯一推荐部署路径（测试网）**：
> `15_deploy_contracts.mjs --execute` → `40_init_params.mjs --execute --online` → `55_fund_ton.mjs` → `50_fund_vaults.mjs --all` → `60_verify_and_register.mjs --execute` → `verify_deployment.mjs --online --save` → `80 open-round R1`

### Step 0 — preflight

~~~bash
node ops/scripts/00_preflight.mjs
~~~

检查：参数不变量、登记表结构、密钥来源是否存在（不读取内容）、Acton 钱包、工具链、合约目录。

失败处理：
- 参数不变量失败：修正 ops/config/testnet.params.json，重跑 selftest，**不要**绕过。
- contracts/ 或 build/ 不存在：等合约负责人完成构建。
- 未发现 Acton 钱包：`cd contracts && acton wallet import`（交互）；仅测试时可 `acton wallet new`。

### Step 15 — 整体部署（deploy-emulation）

~~~bash
node ops/scripts/15_deploy_contracts.mjs --execute
# 等价：cd contracts && acton script --net testnet scripts/deploy-emulation.tolk
~~~

顺序（脚本内完成，无分步子命令）：

1. 部署 **JettonMaster**，mint 100 亿 A9 到 treasury。**mint-once**：op 0x00000015，金额必须 1e19，**同一笔交易**内关闭铸造（admin 置 null），二次 mint 会报 MintClosed(75)。
2. 部署 **RoundController**：keeper、jettonMaster、teamWallet、协议参数、JettonWallet 代码都写在初始数据里。
3. RC 在链上推导自己的 Jetton 钱包，并与 `JettonMaster.get_wallet_address(RC)` 比对，必须一致。
4. treasury 向 RC 转 **82 亿 A9**（8200000000000000000 raw：70 亿奖励池 + 12 亿团队额度），**forward_ton_amount = 0**。

- forward 必须为 0：否则 RC 会把这笔当作质押并退回。
- 脚本把地址写入登记表 `contracts`：jettonMaster、jettonMasterTreasuryWallet、roundController、roundControllerJettonWallet、teamWalletJettonWallet。
- 链上复核：JettonMaster 的 total_supply = 1e19、mintable = false、admin = null；RC 钱包余额 = 82 亿 A9。
- 失败时用 `--from-log <日志>` 重新解析登记（不重新部署）。

### Step 40 — 参数校验（只读）

~~~bash
node ops/scripts/40_init_params.mjs --execute --online
~~~

- 生成 ops/records/params-snapshot.json。
- 调用 RC 的 `get_protocol_config` 逐字段比对；任一不匹配 → FAIL，禁止开轮。
- 本步骤**不发送交易**：v10 没有初始化消息。

### Step 55 — TON gas 充值

~~~bash
OPS_CONFIRM=YES node ops/scripts/55_fund_ton.mjs --execute
~~~

- 脚本门槛：**RC ≥ 20 TON、keeper ≥ 2 TON**。contracts/README §5 写的建议值是 ≥ 5 TON；两者以较大者为准，即按 20 TON 执行。
- RC 的 TON 不足时，结算转账和销毁会失败（见 02 的 SettlementBounced），轮次无法正常结算。
- 实际调用：`cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<name> acton script --net testnet scripts/deploy/fund_ton.tolk <toAddress> <amountTon>`；amountTon 为整数 TON，脚本自动加 1 TON 缓冲。
- 地址优先读登记表。

### Step 50 — 注资与初始分配

~~~bash
OPS_CONFIRM=YES node ops/scripts/50_fund_vaults.mjs --execute --all
~~~

| 分配 | 金额 (A9) | 接收方 | 来源 |
| --- | --- | --- | --- |
| 奖励池 + 团队额度 | 8,200,000,000 | RC 的 Jetton 钱包（owner = RC） | 15 已完成，50 只检测并登记 |
| 内盘销售 | 800,000,000 | teamInternalWallet（公开可查） | treasury，`--all` 时执行 |
| 流动性 | 500,000,000 | liquidityWallet | treasury，`--all` 时执行 |
| 营销 | 500,000,000 | marketingWallet | treasury，`--all` 时执行 |

- 合计 100 亿 A9；执行后 treasury 余额应为 0（60 会核对）。
- 第一笔自动以 1 A9 试探；链上确认目标钱包增加 1 A9 后才发剩余金额。每笔后用 `get_wallet_data` 核对增量。
- 每笔成功后写 registry.funding；60 核对全部笔数是否 CONFIRMED。
- 可分步：先只做 RC 检测与登记，确认后再补 `--all`。
- 实际调用（单笔）：`cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<name> JETTON_MASTER_ADDRESS=<master> acton script --net testnet scripts/deploy/fund_jetton.tolk <recipientOwner> <amountRaw>`。**位置参数必须是接收 owner（RC、热钱包地址），不是 Jetton Wallet 地址**；传钱包地址会被发送方再次推导，造成错投（见 §8.2）。
- 广播前脚本校验 signer 的 A9 余额，不足则可读报错并 exit 1。

### Step 60 — 登记表定稿 + 地址簿

~~~bash
node ops/scripts/60_verify_and_register.mjs --execute
~~~

- 写入 paramsDigest，校验地址与资金，生成 ops/records/address-book.testnet.md 与 .json。
- 团队、营销、流动性、内盘地址：**不公开**，只出现在内部地址簿；对外只写“项目方热钱包持有”。

### Step 80 — 开 R1（keeper 手动开轮）

~~~bash
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<keeper-wallet-name> node ops/scripts/80_admin_ops.mjs --action open-round --round 1 --twap24h <USD_E8>
~~~

- R1 无预告期：部署完成后 keeper 直接 OpenRound，交易中锁定 target = max(P0 × 2^1, 2 × twap24h)。
- twap24h 的来源与双人复核见 07 §9.1，不得临时决定。
- 开轮前确认：RC 与 keeper 的 TON 充足、82 亿已登记、公告已发、值班已就位。
- 开轮后核对 TargetPriceSet 事件与 `get_round(1)` 回读的 target。
- 实际调用：`cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<name> ROUND_CONTROLLER_ADDRESS=<rc> acton script --net testnet scripts/deploy/admin_op.tolk open-round 1 <twap24h>`。
- RC 地址优先读登记表，缺失时回退 contracts/deploy/round-controller.addr。

### Step 90 — 全量验收（STRICT 门禁）

~~~bash
node ops/scripts/verify_deployment.mjs --online --save   # 默认 STRICT；必检项必须全部 PASS
~~~

- 离线：参数、登记表结构、资金记录（**离线通过不构成开轮依据**）。
- 在线：合约账户 active；RC 与 JettonWallet 的 code hash 与 contracts/build 一致；JettonMaster 的 total_supply、mintable、admin；RC 钱包余额；RC 配置逐字段；RC 推导的钱包地址与 JettonMaster 返回值一致。
- 门禁语义：
  - **默认 STRICT**：必检项必须全部 PASS；getter 缺失、返回栈异常、必检分支未执行，一律 FAIL。
  - **`--lenient` 仅用于排查**：必检项降为 WARN，输出不得作为开轮依据。
  - **code hash 不一致** = 线上实例与 contracts/build 不一致，**必须重部署到当前构建后再开轮**，不得用 `--lenient` 掩盖。
  - 结尾做覆盖审计（`gate.missing.*`）：关键分支被跳过也会 FAIL。
- 任一 FAIL → 不得开 R1；先按 §10 排查。

#### Step 90 必检项（STRICT 全 PASS 才允许开 R1）

- [ ] `params.digest`：登记表参数哈希 = 当前 ops/config（漂移则重跑 40/60）。
- [ ] `registry.structure`：JettonMaster、RoundController 两个合约，以及 jettonMasterTreasuryWallet、roundControllerJettonWallet、teamWalletJettonWallet 地址均已登记，且为测试网地址。
- [ ] `funding.*`：RC 82 亿（forward 0）已登记；`--all` 时内盘 8 亿、流动性 5 亿、营销 5 亿已确认。
- [ ] `account.*`：JettonMaster、RC、RC 的 Jetton 钱包 `state=active`。
- [ ] `jetton.total_supply` = 1e19（若已有销毁，核对销毁记录后再放行）；`jetton.mintable = false`；`jetton.admin_null = true`。
- [ ] `roundController.code_hash` 与 `jettonWallet.code_hash` 与 contracts/build 的 JSON 完全一致（不一致 = 未重部署）。
- [ ] RC 推导的 Jetton 钱包地址 = `JettonMaster.get_wallet_address(RC)`。
- [ ] `rc.get_protocol_config`：全部字段与参数一致（P0、倍数、每轮奖励与团队额、最低质押 100000 A9、单地址与本轮上限、PREVIEW / 报名 / 观察 / K 线 / 阈值、技术终止时长、风险披露版本）。
- [ ] RC 钱包余额 = 8,200,000,000 A9（forward 0 注资后，未有其他流入流出）。
- [ ] `gate.missing.*`：无「必检项未执行」记录；出现即禁止开轮。

> 报告落盘：`--save` 会在 `ops/records/verify-deployment-<date>.json` 记录 STRICT 模式、FAIL/WARN 与必检项通过数，作为开轮审批附件。

---

## 6. 手工部署与 --adopt 路径

若部署脚本不可用，由合约负责人在钱包或 IDE 完成部署，记录地址、交易哈希与 code hash，然后用 --adopt 登记（只做校验，不发交易）：

~~~bash
node ops/scripts/10_deploy_jetton.mjs --adopt <jettonMaster>
node ops/scripts/30_deploy_round_controller.mjs --adopt <roundController>
~~~

- 其余步骤（40、55、50、60、verify）不变。
- adopt 地址必须是**测试网地址**；主网地址会被拒绝。
- 若已有整体部署日志：`node ops/scripts/15_deploy_contracts.mjs --from-log <日志>` 可解析并登记地址（不重新部署）。

---

## 7. 地址登记表工作流

~~~text
ops/config/testnet.addresses.template.json   // 人工填写模板（说明用途）
        │
        ├─ 15 整体部署输出解析 / 10、30 --adopt ──► ops/config/testnet.registry.json（唯一事实来源）
        │
        └─ 60_verify_and_register ──► ops/records/address-book.testnet.{md,json}
~~~

登记表结构（键名）：

- `contracts`：jettonMaster、jettonMasterTreasuryWallet、roundController、roundControllerJettonWallet、teamWalletJettonWallet
- `wallets`：keeper、treasury、teamWallet、marketingWallet、liquidityWallet、teamInternalWallet

其他规则：

- 每次写登记表都更新时间戳；不要把私钥、助记词、API key 写入登记表。
- registryDigest = 合约 + 钱包 + 配置哈希的 sha256，用于对外公布“地址与配置未被篡改”。
- 地址变更（例如重建部署）必须先人工确认旧地址作废，再清空对应字段；不要覆盖式静默替换。
- 旧版（v8.x）登记表已移到 ops/config/archive/v8.9/，不再使用。

---

## 8. 部署后演练（开 R1 前必须完成）

对应 docs/34 §5 与 ops/drills/2026-11_prelaunch_drill_plan.md：

- [ ] 成功轮：24 根齐备且 ≥16 达标 → 本金 + 奖励由 `Claim(roundId)` 一次领取；RC 向 teamWallet 直接转 1.2 亿，且只转一次。
- [ ] 失败轮：一笔销毁（7 亿 + 1.2 亿 + 全部本金）→ total_supply 实际减少；不可领取。
- [ ] 无人质押轮：照常 24 根观察；成功 → 7 亿销毁、团队额度照常释放；失败 → 销毁 7 亿 + 1.2 亿。
- [ ] 技术终止：观察应结束后 7 天或预告结束后 7 天仍未推进，任何人可触发；本金可领；7 亿与 1.2 亿留在 RC（不分配、不销毁）。
- [ ] 结算重试：出现 SettlementBounced 后调用 RetrySettlement（≥0.3 TON）。若测试网无法复现，记录为“未演练”，不得省略不写。
- [ ] 第三方 response_destination 的标准转账（DEX 出款）：测试网 DEX 建池后验证买入、卖出、退款。
- [ ] 每次演练后用 reconcile.mjs 对账，CSV 归档到 ops/records/。
- [ ] 测试网完整跑满 10 轮（docs/34 §5）。

---

## 8.1 v10 部署与运营要点（与旧口径的差异）

1. **三个合约**：JettonMaster、标准 JettonWallet、RoundController。没有团队合约，也没有预言机合约。
2. **没有 admin**：RC 不可升级、无提现、无参数修改入口；keeper 与 teamWallet 部署时写死。
3. **没有接线步骤**：RC 在链上推导自己的 Jetton 钱包，部署后不需要任何设置消息。
4. **82 亿注资 forward 0**：RC 同时托管 70 亿奖励池和 12 亿团队额度；成功轮 RC 直接转 1.2 亿给 teamWallet。
5. **最低质押 10 万 A9**；质押 forward_ton_amount ≥ 0.1 TON（建议 0.12），质押消息总额建议 0.3 TON。
6. **判定点**：第 24 根 K 线提交时直接判定为 SUCCEEDED 或 FAILED_PERMANENT，没有结算中间态。
7. **结算退回**：只有结算转账或销毁在第一跳被退回时才需要 RetrySettlement；其他情况不需要人工干预。
8. **Jetton mint-once**：op 0x00000015，金额 1e19，同一笔交易关闭铸造；verify 检查 total_supply、mintable、admin、decimals=9、symbol=A9。

---

## 8.2 注资事故复盘与防呆检查清单（2026-11-05）

2026-11-05 测试网注资时，70 亿 A9 被转入一个 owner 为 RC Jetton 钱包地址的错误钱包（不可找回）。根因是 fund_jetton 的位置参数要求**接收 owner**，而操作时传入的是**目标 Jetton Wallet 地址**，发送方钱包于是又推导了一次（wallet-of-wallet）。完整记录见 ops/records/incident-2026-11-05-funding-misallocation.md。

**注资前必须逐项打印并人工核对（四者必须一致）**：

1. 接收 owner 地址（RC / teamWallet / 热钱包）
2. 接收 owner → expected wallet（fund_jetton 脚本打印的推导值）
3. JettonMaster.get_wallet_address(owner) 的链上返回值
4. 登记表 `wallets` 或 `contracts` 段中记录的 canonical wallet

**强制流程**：

- 第一笔必须 ≤ 1 A9 试探；链上确认 `get_wallet_data(dest).jettonBalance` 增加 1 A9 后，才允许发大额。
- 每笔转账后独立查询 `get_wallet_data(dest)`，与“转前余额 + 金额”精确比对；不一致立即停止。
- dry-run 不解析发送方推导，**不能替代**小额实盘验证。

---

## 9. 回滚与重建策略（RC 不可升级）

**核心约束**：RoundController 不可升级，keeper 与 teamWallet 写死在部署数据里。因此只能“修正后整套重建”，不能热修。

| 阶段 | 可回滚程度 | 处理 |
| --- | --- | --- |
| JettonMaster 部署后、注资前 | 高 | 废弃该 Jetton（测试网），整套重新部署 |
| 15 完成（82 亿已注资）后、开 R1 前 | 低 | 资金已进入不可改合约。参数、keeper 或 teamWallet 错误时，只能整套重建（新 Jetton、新 RC），旧地址作废并公告 |
| R1 开轮后 | 极低 | 不热修；记录问题；按规则判定、结算或技术终止；下一套部署修复 |

**重建检查**：新 Jetton 意味着新的 total_supply；旧测试数据保留作历史，不要混用地址。重建后必须更新登记表、地址簿与配置哈希，并公告。

---

## 10. 常见故障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 未发现 Acton 钱包 | 未导入，或钱包名不同 | `cd contracts && acton wallet list`；`acton wallet import`；或设置 TON_DEPLOYER_WALLET |
| 部署命令 exit≠0 | 工具链参数与模板不一致、余额不足、RPC 限速 | 对照 contracts/scripts 实际参数更新模板；充值 gas；配置 TONCENTER_API_KEY |
| 15 报钱包推导不一致 | RC 推导值与 JettonMaster 返回值不同 | 立即停止，不做注资；交合约负责人排查 |
| 地址解析失败 | 部署输出格式变化 | 用 --adopt 登记，并把输出片段反馈给合约负责人 |
| verify FAIL：mintable=true | 铸造未关闭 | 立即停止；未确认关闭前不得注资或开轮；按整套重建处理 |
| RC 钱包余额 ≠ 82 亿 | 注资金额或 forward 参数错误 | 立即停止后续注资；按 §8.2 核对；不得再次转账“补齐” |
| 注资时 Jetton 钱包解析失败 | TON Center v3 不可用，或 owner 地址错误 | 配置 API key；用 get_wallet_address 人工核对；解析失败禁止盲转 |
| 供应量不一致 | 手工转账绕过脚本，或分配漏记 | 停止后续步骤；用 reconcile.mjs --chain 对账；补记录或重建 |

---

## 11. 签字与证据归档

| 项 | 记录 | 负责人 | 时间 |
| --- | --- | --- | --- |
| 参数哈希（paramsDigest） | sha256:... | 部署者 | |
| 合约 code hash（JettonMaster / RoundController / JettonWallet） | | 合约负责人 | |
| keeper 地址与 teamWallet 地址（部署时写入 RC，不可改） | 地址 + 双人核对 | 部署者 + 复核人 | |
| 部署交易哈希（每步） | | 部署者 | |
| 登记表摘要（registryDigest） | | 部署者 | |
| 地址簿 ops/records/address-book.testnet.md | 归档链接 | Ops | |
| 验收报告 ops/records/verify-deployment-YYYY-MM-DD.json | 归档链接 | Ops | |
| 演练记录 | ops/drills/ | Ops | |
| R1 开轮 twap24h 审批附件（见 07 §9.1） | 计算过程与双人签字 | Ops + 复核人 | |

> 证据保留至少到主网后 90 天；所有对外披露只使用链上可验证字段。

---

*本 runbook 与 ops/config/testnet.params.json、脚本输出一一对应；参数变更后必须重新生成配置哈希并重跑 dry-run 与 selftest。*
