# 01 — A9 测试网部署 Runbook（TON testnet，v11）

**版本**：v11（2026-11-07，玩法 docs/35，D-43 ~ D-50）
**Owner**：testnet-ops
**权威口径**：docs/35_GAMEPLAY_V11.md、contracts/README.md（§5 ABI、§6 部署、§7.1 军饷合约）、本文
**脚本与命令**：以 `ops/README.md` 为准（§1.1 部署顺序、§1.2 快测档、§5.3 军饷充值与发根）。本文命令与该 README 一致，环境变量见 §2.0。
**默认模式**：所有脚本默认 DRY-RUN。真实广播需要 `OPS_EXECUTE=1`；注资、开轮、提交 K 线、军饷发根等写操作另需 `OPS_CONFIRM=YES`。

---

## 0. 总览

部署顺序（测试网）：

1. 部署 JettonMaster，同一笔交易 mint 100 亿 A9 到 treasury 并关闭铸造
2. 部署 RoundController（RC），初始数据写入 keeper、teamWallet、协议参数、JettonWallet 与 StakeTicket 代码
3. 核对 RC 推导的 Jetton 钱包与 Master 返回值一致，核对 ticket code hash
4. treasury 向 RC 转 **82 亿 A9**（`forward_ton_amount` = 0）
5. 给 RC 充 TON
6. 部署 JunxiangDistributor（军饷分发合约）。此时不注资，不发根
7. 部署后检查（§3），全部 PASS 才继续
8. 部署测试网 Worker（D1、secrets、vars、GitHub 变量）、设置 Telegram webhook、创建 STON.fi 测试池、部署 Web
9. 开 R1，见 `02_round_operations.md`

> RC 的 keeper 与 teamWallet 写死在部署数据里，之后无法修改。部署前必须在登记表核对这两个地址；宁可停在 dry-run，也不要试错。

---

## 1. 前置条件（缺一不可）

| # | 前置条件 | 检查方式 | 负责 |
| --- | --- | --- | --- |
| 1 | **Toncenter 测试网 API key**（只读查询用，存入本地环境或 secret，不进仓库） | 查询接口返回正常 | 部署者 |
| 2 | **三个热钱包**：deployer / treasury（同一个或分开，需登记）、keeper（只放 gas）、junxiang publisher（只发根） | 地址登记 + 双人核对 | 项目方 |
| 3 | **团队钱包（team wallet）**：接收团队额度，地址部署时写死 | 地址登记 + 双人核对 | 项目方 |
| 4 | **测试网 TON**：从测试网 faucet 领取。deployer 建议 ≥ 25 TON；keeper ≥ 2 TON；RC 见 §4 | 钱包余额查询 | 部署者 |
| 5 | **合约构建与代码哈希**：`cd contracts && acton build && acton check && acton test` 全部通过；代码哈希与 contracts/README §0、§7.1 一致（见下表） | 构建产物哈希比对 | 合约负责人 |
| 6 | **参数**：v11 参数表已签字，记录参数哈希。`abortTimeoutSeconds` 按档位确定（正式测试网 604800 秒 = 7 天；快速演练档见 drill）；最低质押 1,000 A9 | `node ops/scripts/00_preflight.mjs`（快测档前加 `OPS_PARAMS=ops/config/testnet-fast.params.json`） | 项目方 |
| 7 | **新建测试网 D1 数据库**。不复用主网库，也不复用旧 v8.9 彩排库 `a9-drill`（其配置 `worker/wrangler.drill.toml` 已删除；测试网用 `worker/wrangler.toml` 的 `[env.testnet]`） | 数据库名与 ID 登记 | 后端 |
| 8 | **Telegram 测试 bot**（BotFather 创建）与 1–2 个测试群 | bot 能收发消息 | 运营 |
| 9 | **STON.fi 测试网池**（§6） | 池子地址登记 | 运营 |

**红线**：

- 不向任何人索要主网私钥；不使用裸私钥（64 位 hex）。
- 助记词只在本地交互输入，不粘贴进终端历史、截图或聊天。
- 不把任何 API key、token、secret 写进仓库或 wrangler.toml。

### 代码哈希（contracts/README §0、§7.1）

| 合约 | 代码哈希 |
| --- | --- |
| JettonWallet | `0xD06DAA57ED188CE9CB6CA596DD2111347433BF335223AC66C0D713C8E3DB74F4` |
| JettonMaster | `0x76B56D9A6301223F1201D719E2F4A3FB84E08D7D701CB93BB43C9D0208E5E241` |
| RoundController | `0x1037BACD95A773F713A506A81C8009D7858B6005CFCB97D2A58E7F438FDBD226` |
| StakeTicket | `0xB04B6A611A93401F40B10274D85E72EAAF9624553F546FAC7C4CDCD7555A4F91` |
| JunxiangDistributor | `0x9E07E813F0081B715C084BCF479C35E94BA4A711CAF4844C68112B5565B742D8` |
| ClaimRecord | `0x8DB60A5B92079367C80AAA9856B2CDDABAFB0667F0C1CEC0CBF19359D8388D61` |

> `contracts/deploy/params.testnet.json` 仍是 v6 旧参数（有 `<PLACEHOLDER>`，且仍写着单地址上限、总额上限）。v11 不能直接用它，必须按 v11 参数重新生成，并核对 `ticketCodeHash` 等新字段。

---

## 2. 部署步骤

### 2.0 环境与整体部署命令（对应 ops/README.md §1.1）

钱包先在 `contracts/` 下用 `acton wallet import` 交互导入（名字：`deployer`、`admin`；keeper 钱包名为 `<keeper 钱包名>`，导入时自定）。环境变量只放在当前 shell，不写入文件。

~~~bash
cd <repo root>
export A9_KEEPER_ADDRESS=<keeper 测试网地址>            # 写入 RC，部署后不可改
export A9_TEAM_WALLET_ADDRESS=<teamWallet 测试网地址>    # 写入 RC，部署后不可改
export A9_JUNXIANG_PUBLISHER_ADDRESS=<publisher 测试网地址>   # 可选，默认 = keeper
export TON_DEPLOYER_WALLET=deployer                    # 部署者（mint-once、注资）
export A9_SIGNER_WALLET=deployer                       # 每一步改成对应签名钱包
export OPS_PARAMS=ops/config/testnet-fast.params.json  # 快测档；正式档不设置

node ops/scripts/selftest.mjs
node ops/scripts/00_preflight.mjs                      # 必须无阻断项
node ops/scripts/15_deploy_contracts.mjs --execute     # JettonMaster → mint-once → RC → 82 亿注资 → JunxiangDistributor（不注资）
~~~

以下 2.1–2.4 都由上面这一条 `15_deploy_contracts.mjs --execute` 完成，逐项说明保留作为核对依据。

### 2.1 JettonMaster（mint once）

- 命令：由 `15_deploy_contracts.mjs --execute` 完成（§2.0）。
- 动作：部署 JettonMaster，mint 100 亿 A9（1e19 raw）到 treasury，**同一笔交易内关闭铸造**（admin 置空）。
- 预期（链上回读）：
  - total_supply = 1e19 raw
  - mintable = false
  - admin = null
  - decimals = 9，symbol = A9
- 记录：部署交易哈希、JettonMaster 地址、code hash。

### 2.2 RoundController

- 初始数据：keeper 地址、JettonMaster 地址、teamWallet 地址、协议参数（含 `abortTimeoutSeconds`、时长、阈值）、`codes = { JettonWallet 代码, StakeTicket 代码 }`。
- 初始状态：carry、lastSuccessRound、teamPending、endAt 均为 0。
- 命令：同 §2.0（`15_deploy_contracts.mjs --execute`）。部署后核对：`node ops/scripts/30_deploy_round_controller.mjs`（初始数据快照，只读核对清单）。
- 部署前双人核对：keeper、teamWallet 地址与登记表一致。

### 2.3 JunxiangDistributor

- 初始数据：publisher（军饷发布热钱包）、JettonMaster 地址、ClaimRecord 代码。
- 命令：同 §2.0（`15_deploy_contracts.mjs --execute` 内完成，读回 `get_distributor`）。
- 本步不注资，不发根。第一份根在第一次军饷结算时发布（见 `02_round_operations.md` §4）。

### 2.4 注资 RC 82 亿 A9

- 来源：treasury → RC 的 Jetton 钱包（owner = RC）。
- 金额：**8,200,000,000 A9**（raw 8200000000000000000）。
- `forward_ton_amount` 必须为 **0**。
- 命令：同 §2.0（`15_deploy_contracts.mjs --execute` 内完成，forward 为 0）。
- 注资后核对（只读）：`node ops/scripts/40_init_params.mjs --execute --online`。

**注资防呆（沿用 2026-11-05 注资事故教训，完整记录见 `ops/records/incident-2026-11-05-funding-misallocation.md`）**：

1. 接收参数必须是**接收 owner（RC 合约地址）**，不能是 Jetton Wallet 地址。传错会被发送方再推导一次，资金错投且不可找回。
2. 注资前四者必须一致并逐项打印核对：
   - 接收 owner（RC 地址）
   - 脚本推导的 expected wallet
   - `JettonMaster.get_wallet_address(RC)` 的链上返回值
   - 登记表中记录的 canonical wallet
3. 第一笔先发 **1 A9** 试探，确认 RC 钱包余额增加 1 A9 后才发大额。
4. 每笔后独立查询目标钱包余额，与"转前余额 + 金额"精确比对，不一致立即停止。
5. dry-run 不能替代小额实盘验证。

### 2.5 treasury 分配（测试网）

- 内盘、流动性、营销等分配按测试网分配单执行，地址只记在内部登记表。
- 命令（快测档 / 正式档相同，`OPS_PARAMS` 已在 §2.0 设置）：

  ~~~bash
  OPS_CONFIRM=YES node ops/scripts/50_fund_vaults.mjs --execute --probe --all
  node ops/scripts/60_verify_and_register.mjs --execute
  ~~~

- 测试网演练用的 A9 测试钱包余额（drill §2）也从这里分发，分发记录写入登记表。

---

## 3. 部署后检查（全部 PASS 才继续）

按顺序执行（ops/README.md §1.1）：

~~~bash
node ops/scripts/40_init_params.mjs --execute --online                     # get_protocol_config 逐项比对 + ticket code hash
OPS_CONFIRM=YES node ops/scripts/50_fund_vaults.mjs --execute --probe --all   # 内盘 / 流动性 / 营销核对
node ops/scripts/60_verify_and_register.mjs --execute                       # 登记表定稿 + 地址簿
node ops/scripts/verify_deployment.mjs --online --save                      # STRICT：必须 0 FAIL 才允许开 R1
~~~

`verify_deployment` 有 FAIL 时不得开 R1。`--lenient` 只用于排查，输出不作为开轮依据。

- [ ] `RC.get_jetton_wallet_address()` = `JettonMaster.get_wallet_address(RC)`
- [ ] `RC.get_ticket_code_hash()` = `0xB04B6A61…5A4F91`（与 §1 一致）
- [ ] `RC.get_jetton_wallet_code_hash()` 与 JettonWallet 代码哈希一致
- [ ] `RC.get_protocol_config()` 各字段与参数签字单一致，尤其：
  - `abortTimeoutSeconds`（正式档 604800；快速档按 drill）
  - `minStake` = 1,000 A9
  - previewSeconds、stakeDurationSeconds、candleSeconds、candleCount（24）、minQualifiedCandles（16）
- [ ] `RC.get_protocol_state()`：carry = 0、lastSuccessRound = 0、teamPending = 0、endAt = 0、successCount = 0、currentRoundId = 0
- [ ] RC 的 Jetton 钱包余额 = **8,200,000,000 A9**（raw 8200000000000000000）
- [ ] JettonMaster：total_supply = 1e19、mintable = false、admin = null
- [ ] `JunxiangDistributor.get_distributor()`：publisher、JettonMaster 正确；分发钱包余额为 0（首次注资前）
- [ ] `JunxiangDistributor` 的 ClaimRecord 代码哈希与 §1 一致
- [ ] 地址全部登记；内盘、流动性、营销等非公开地址不对外公开

---

## 4. RC 充 TON

- RC 每次结算的销毁与团队转账都要 TON。领取与续战的 TON 由用户附带（见 contracts/README §3）。
- 门槛：脚本门槛沿用既有值，RC ≥ **20 TON**、keeper ≥ 2 TON。contracts/README §6 建议 ≥ 5 TON，两者取较大者，即 RC ≥ 20 TON。
- 命令（脚本检查 RC ≥ 20 TON、keeper ≥ 2 TON，不足则补充）：

  ~~~bash
  OPS_CONFIRM=YES node ops/scripts/55_fund_ton.mjs --execute
  ~~~

- 充值后回读 RC 余额并登记。

RC 余额不足时，结算转账和销毁会失败，出现 SettlementBounced（见 `02_round_operations.md`）。

---

## 5. Worker 部署（测试网）

### 5.1 D1 迁移

- 迁移文件：`worker/migrations/` 下 **0001–0012、0014、0015**。
- **注意：仓库里没有 0013。** 这是有意留空还是漏文件，需要先确认。wrangler 按文件名顺序执行，缺号本身不影响执行。不要为了凑号新建空文件。
- **不要直接运行根目录的 `npm run db:migrate`**。它指向顶层 `[[d1_databases]]` 绑定（`fuse-protocol`，database_id `b5945609…`，即演示库），会误操作演示库。
- 新建测试网 D1（只做一次）：

  ~~~bash
  cd worker
  ./node_modules/.bin/wrangler d1 create a9-testnet     # 把返回的 database_id 写入 wrangler.toml 的 [env.testnet] 绑定
  ./node_modules/.bin/wrangler d1 migrations apply a9-testnet --env testnet --remote
  ~~~

- 禁止使用根目录 `npm run db:migrate`（指向演示库）。
- 验收：列出已应用迁移，确认 0001–0012、0014、0015 全部已应用（0013 待确认）。

### 5.2 Secrets（wrangler secret，不写入 wrangler.toml 与仓库）

| 名称 | 用途 | 说明 |
| --- | --- | --- |
| `SESSION_SECRET` | TON Proof 登录后的 7 天会话签名 | 未配置时写接口的 Bearer 登录不可用 |
| `TG_BOT_TOKEN` | 调用 Telegram Bot API | 只放 secret |
| `TG_WEBHOOK_SECRET` | 校验 Telegram 回调头 `X-Telegram-Bot-Api-Secret-Token` | 必须与 §5.5 的 `secret_token` 一致 |
| `ADMIN_TOKEN` | 管理接口（军饷 compute、payout build 等）的鉴权 | 不在清单三项里，但 `requireAdmin` 需要，必须另设 |

- 命令（每条会提示输入值，值不要粘贴进聊天或命令历史）：

  ~~~bash
  cd worker
  ./node_modules/.bin/wrangler secret put SESSION_SECRET --env testnet
  ./node_modules/.bin/wrangler secret put ADMIN_TOKEN --env testnet
  ./node_modules/.bin/wrangler secret put TG_BOT_TOKEN --env testnet
  ./node_modules/.bin/wrangler secret put TG_WEBHOOK_SECRET --env testnet
  ~~~
- 设置后只记录"已设置"，不记录值。

### 5.3 Vars（非机密，测试网环境）

| 变量 | 测试网取值 | 说明 |
| --- | --- | --- |
| `DATA_SOURCE` | `chain` | 不能是 `demo` |
| `CHAIN_NETWORK` | `testnet` | 不能是 `mainnet` |
| `DEMO_ALLOW_UNSIGNED_WRITES` | `false` | 测试网也关闭无签名写入 |
| `DEMO_AUTOPLAY` | `false` | 链上模式关闭演示自动推进 |
| `ROUND_CONTROLLER_ADDRESS` | §2.2 的 RC 地址 | 测试网地址 |
| `KEEPER_ADDRESS` | keeper 地址 | 测试网地址 |
| `TEAM_WALLET_ADDRESS` | teamWallet 地址 | 测试网地址 |
| `JETTON_MASTER_ADDRESS` | §2.1 的 JettonMaster 地址 | 测试网地址 |
| `JUNXIANG_DISTRIBUTOR_ADDRESS` | §2.3 的分发合约地址 | 测试网地址 |
| `TONCENTER_V2_URL` / `TONCENTER_V3_URL` | 测试网 Toncenter 地址 | 主网地址不要用 |
| `TG_BOT_USERNAME` | 测试 bot 用户名（不带 @） | 用于生成小程序与群链接 |
| `STONFI_POOL_ADDRESS` | §6 的测试池地址 | **未设时不发守城补贴，且不报错**，容易漏，部署后必须确认 |
| `TON_PROOF_DOMAINS` | 测试站域名，逗号分隔 | 默认值含 `a9.lat`，测试网必须改成测试站域名，不要保留生产域名 |

- 测试网 Worker 名：`a9-testnet`（workers.dev，`routes = []`，不会碰 a9.lat）。
- **前置改动（未在本次完成）**：`worker/wrangler.toml` 目前只有 `[env.production]`。需要先新增 `[env.testnet]`：`[[env.testnet.d1_databases]]` 绑定 `a9-testnet` 的 database_id、`routes = []`、`[env.testnet.vars]`（见下表）。由 Worker 负责人补上后再执行本节命令。
- **测试网 Worker 不能部署到生产 Worker 名 `fuse-protocol`（a9.lat）上。** 生产环境有门禁（要求 chain、mainnet、无无签名写入、生产 D1 独立）；测试网需要独立的 Worker 名和 D1。

### 5.4 GitHub 变量（合约地址）

- CI 当前读取的变量名是 `PROD_ROUND_CONTROLLER_ADDRESS`、`PROD_TEAM_WALLET_ADDRESS`、`PROD_KEEPER_ADDRESS`、`PROD_JETTON_MASTER_ADDRESS`、`PROD_ORACLE_CONFIG_HASH`、`PROD_D1_DATABASE_ID`。这些都是生产门禁用的。
- **不要把测试网地址填进 `PROD_*`**。那样生产门禁会放行，但指向的是测试合约。
- 测试网不走 CI，不使用 GitHub Variables。地址直接写在 `[env.testnet.vars]`。
- 地址来源：`contracts/deploy/round-controller.addr`、`contracts/deploy/jetton-master.addr`；keeper、teamWallet、分发合约等其余地址从 `ops/config/testnet.registry.json` 取。
- 军饷分发合约地址：变量名 `JUNXIANG_DISTRIBUTOR_ADDRESS`，写入 `[env.testnet.vars]`（§5.3 表中已列）。
- 部署：`wrangler deploy --env testnet`（§7）。

  ~~~bash
  cd worker && ./node_modules/.bin/wrangler deploy --env testnet
  ~~~

### 5.5 Telegram webhook（setWebhook，带 secret_token）

1. 确认 Worker 已部署，`https://<测试站域名>/api/tg/webhook` 可以访问。
2. 调用 Telegram Bot API `setWebhook`：
   - `url` = 上面的地址
   - `secret_token` = `TG_WEBHOOK_SECRET` 的值
   - 用环境变量传入 token 与 secret，不要把它们写进命令历史、截图或聊天。

  ~~~bash
  # TG_BOT_TOKEN、TG_WEBHOOK_SECRET 已放在当前 shell 的环境变量里
  curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook" \
    -d "url=https://<测试站或 workers.dev 域名>/api/tg/webhook" \
    -d "secret_token=${TG_WEBHOOK_SECRET}"
  curl -s "https://api.telegram.org/bot${TG_BOT_TOKEN}/getWebhookInfo"
  ~~~
3. 调用 `getWebhookInfo` 验收：
   - `url` 正确
   - `last_error_message` 为空
   - `pending_update_count` 正常（不持续增长）
4. 在测试群发送 `/team` 或 `/gate`，确认 bot 有回复（完整检查见 drill §4 Phase 0）。
5. 不带正确 `secret_token` 的请求不得被处理（见 `03_monitoring_alerting.md` 的 webhook 健康检查）。

### 5.6 Worker 部署后检查

- [ ] `GET /api/health` 返回 ok
- [ ] `GET /api/rounds` 返回的链上配置与 §3 一致（链上模式，不是演示数据）
- [ ] `GET /api/social/gate` 返回有效的 gate 状态
- [ ] 管理接口不带 `ADMIN_TOKEN` 时被拒绝
- [ ] cron 在测试网环境中生效。顶层 `[triggers]` 是每分钟一次；测试网环境要单独确认配置了，不要只看顶层

---

## 6. STON.fi 测试网池

- 在 STON.fi testnet 创建 A9 与 TON（或测试 USDT）的池子，并注入初始流动性。
- 池子地址写入 Worker 变量 `STONFI_POOL_ADDRESS`。
- 池子用途有两个：守城补贴读取池子储备；一键上车（drill g）。
- 创建步骤：ops 仓库里没有 STON.fi 池的脚本。在 STON.fi testnet 界面人工创建 A9 / TON（或测试 USDT）池，并记录池子地址，写入 `[env.testnet.vars]` 的 `STONFI_POOL_ADDRESS`。
- 验收：
  - Worker 能读到池子数据：`GET /api/social/gate` 返回的池子美元储备非空（未设置 `STONFI_POOL_ADDRESS` 时守城补贴不发，且不报错）
  - 池子地址与登记表一致
- 只能用测试网池子。不要在主网地址上做任何测试。

---

## 7. Web 部署

- 根目录 `npm run build` 生成 `web/dist`。Worker 通过 ASSETS 托管 `web/dist`，所以部署 Worker 时用的必须是新构建。
- 构建时的变量：`web/src` 里唯一用到的构建变量是 `VITE_ENABLE_DEMO_WALLET`，测试网不设置（或留空）。其余无需设置。
- 构建与部署命令（根目录构建，Worker 托管 `web/dist`）：

  ~~~bash
  npm run build
  cd worker && ./node_modules/.bin/wrangler deploy --env testnet
  ~~~
- 验收：
  - 测试站页面打开正常，显示测试网
  - `/tonconnect-manifest.json` 可读
  - TON Connect 能连接测试网钱包

---

## 8. 部署后验收

本文到此为止是"能跑起来"的检查。完整的链上与社交验收见 `ops/drills/2026-11_testnet_v11_10round_drill.md` 的 Phase 0。

- [ ] §3 全部 PASS
- [ ] §5.6 全部 PASS
- [ ] Telegram webhook 健康（§5.5）
- [ ] STON.fi 池可读（§6）
- [ ] 签字（§10）

---

## 9. 常见故障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 迁移报错或版本顺序不对 | 误用了演示库，或迁移文件缺失 | 确认目标库是测试网新库；确认 0013 状态；不要改已应用的迁移 |
| `npm run db:migrate` 碰了演示库 | 根脚本指向顶层绑定 | 立即停止，不要再运行；用测试网命令（§5.1） |
| webhook 收不到消息 | `url` 错误，或 `secret_token` 不一致 | 看 `getWebhookInfo` 的 `last_error_message`；核对 `TG_WEBHOOK_SECRET` |
| 写接口返回未授权 | `SESSION_SECRET` 未设，或域名不在 `TON_PROOF_DOMAINS` | 补 secret 或改域名变量，然后重新登录 |
| 守城补贴没有发 | `STONFI_POOL_ADDRESS` 未设（这种情况不报错） | 补变量，并核对池子能读到储备 |
| RC 注资后余额不对 | 金额、forward 或接收参数错误 | 立即停止后续注资；按 §2.4 核对；不得再次转账"补齐" |
| 部署 Worker 时门禁失败 | 变量仍是占位符，或误用了生产配置 | 核对 §5.3、§5.4；不要放行门禁 |
| 部署后 cron 不运行 | 测试网环境没有配置 cron | 按 §5.6 补配置 |

---

## 10. 签字与证据归档

| 项 | 记录 | 负责人 | 时间 |
| --- | --- | --- | --- |
| 参数签字单与参数哈希 | sha256:... | 部署者 | |
| 合约 code hash（JettonMaster / RC / JettonWallet / StakeTicket / JunxiangDistributor / ClaimRecord） | 与 §1 对比结果 | 合约负责人 | |
| keeper 地址与 teamWallet 地址（部署时写入 RC，不可改） | 地址 + 双人核对 | 部署者 + 复核人 | |
| 部署交易哈希（每步） | | 部署者 | |
| 登记表与地址簿 | 归档位置 | Ops | |
| §3 检查结果 | 截图或 JSON | Ops | |
| Telegram webhook 与 STON.fi 池检查 | 截图 | 运营 | |

> 证据保留至少到主网后 90 天。对外只披露链上可验证的字段。

---

*本 runbook 与 `ops/README.md`、contracts/README 对应。脚本参数以 ops/README 与脚本 `--help` 输出为准。*
