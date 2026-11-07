> ⚠️ **已作废（v8–v10 口径）**：主网上线请只按 [08_mainnet_v11.md](08_mainnet_v11.md) 执行。本文仅供溯源。

# 07 — 主网部署全流程手册（MAINNET-RUNBOOK，v10）

> 状态：**草案（2026-11-06）**，待 Lead 复核。目标：从「测试网 v10 验收通过」到「主网可交易」。
> 主网三件不可逆的事：**合约部署（含 82 亿注资路径）、资金注入、keeper 地址与 teamWallet 地址写入 RC**。每一步必须先做前置检查，先小额验证，失败立即停。

## 0. TL;DR

1. 冻结 v10 代码的 tag，核对 3 个合约的 code hash（见 §3.1）。
2. 新建主网 D1 库，只 apply 编号迁移，**绝不执行 seed.sql**。
3. 生成全新主网密钥（**严禁复用测试网密钥**），完成离线备份。keeper 与 teamWallet 地址在部署时写死，需双人核对。
4. 运行 `90_mainnet_ceremony.mjs`：先 `--dry-run` 跑通全部阶段，再执行真实部署（P0 → P6，见 §4.7）。
5. verify_deployment **STRICT 全 PASS** 后才允许开 R1（默认即 STRICT；--lenient 输出不得作为上线依据）。
6. 部署 Worker（chain 模式、真实地址、关闭演示写接口），验证 health、version、rounds。
7. 小额真实资金全链路冒烟 → 公告审批 → keeper 开 R1 → 按计划开放内盘与流动性。

## 1. 前置门禁（全部满足才允许开始）

| # | 门禁 | 检查命令或证据 | 负责人 |
| --- | --- | --- | --- |
| 0 | **v10 外部安全审计已完成并复核**（范围：RoundController，以及 Jetton 的两处改动，见 docs/34 §5） | 审计报告与复核报告归档；所有 Critical / High 已修复或书面接受 | 项目方 / 审计方 |
| 1 | 合约 tag 已冻结 | `git rev-parse` 与 tag 指向的 commit 由 Lead 书面确认 | Lead / 合约负责人 |
| 2 | 3 个合约的 code hash 与冻结基线一致 | §3.1 的 build 产物 hash 截图或日志 | 合约负责人 |
| 3 | 测试网 v10 完整 10 轮验收通过 | 测试网验收记录（成功、失败、0 质押、技术终止、结算重试各至少一次；见 docs/34 §5） | testnet-ops |
| 4 | 索引器对账差异为 0 | worker 的 chain-reconcile 工具（参数以 worker 当前 CLI 为准），差异计数为 0；任何 getter 失败时 CLI 直接 exit 1 | testnet-ops |
| 5 | verify_deployment STRICT 全 PASS（测试网实例） | `node ops/scripts/verify_deployment.mjs --online`，严格模式，requiredFail = 0 | testnet-ops |
| 6 | keeper 与资金钱包方案已定 | 06 的 §2、§3 已确认；keeper 与 teamWallet 地址双人核对并签字 | Lead + 项目方 |
| 7 | TONCENTER_API_KEY 已申请 | 主网 key 写入 secret，1 RPS 限制解除 | Lead |
| 8 | 演示数据不会进入主网 D1 | CI guard 生效（migrations 只允许 NNNN_*.sql） | app-dev |
| 9 | 域名与证书可用 | a9.lat / www.a9.lat DNS 指向 Cloudflare，证书 Active | 项目方 |

**任一不满足 → 停止。不要用 TODO 或口头确认替代。**

### 1.1 已知教训（写进 checklist）

- **非迁移 SQL 混入会被当成迁移**：任何非迁移 SQL 混入 worker/migrations 都会被 wrangler 执行。主网 apply 前必须执行 §2.2 的守卫命令。
- **Jetton 代码或参数变化会改变所有地址**：必须全新部署 JettonMaster 与 RC，禁止 resume 旧实例。
- **用户钱包 TON 会耗尽**：测试中出现过钱包 TON 低于 stake value 而失败。主网必须提前估算每用户的 gas，并在 UI 提示。
- **STRICT 默认**：--lenient 只用于排查；主网开轮依据必须是 STRICT 全 PASS。
- **注资按接收 owner 填写**：见 01 §8.2 的事故复盘。

## 2. 主网 D1 新库

### 2.1 创建

~~~bash
cd worker
wrangler d1 create a9-mainnet
# 把返回的 database_id 写入 wrangler.toml 的 [[d1_databases]]，binding 保持 DB
~~~

期望：输出 database_id；wrangler.toml 中 database_name = a9-mainnet，database_id 为新值。
失败：名称冲突或权限不足 → 换名，或检查 Cloudflare 账号；**不要复用测试库**。

### 2.2 migrations 守卫与 apply

~~~bash
cd worker
ls migrations | sort
# 只允许 NNNN_*.sql 编号文件，且无其他 .sql
for f in migrations/*.sql; do case "$(basename "$f")" in [0-9][0-9][0-9][0-9]_*.sql) ;; *) echo "BAD: $f"; exit 1;; esac; done
wrangler d1 migrations apply a9-mainnet --remote
~~~

期望：apply 只列出编号迁移；无 seed 内容；无报错。
失败：出现非编号文件 → 立即停止，移出 migrations 后重跑。**绝不执行 seed.sql**。

### 2.3 验证空库

~~~bash
wrangler d1 execute a9-mainnet --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
wrangler d1 execute a9-mainnet --remote --command "SELECT COUNT(*) AS rounds FROM rounds;"
wrangler d1 execute a9-mainnet --remote --command "SELECT COUNT(*) AS trades FROM trades;"
~~~

期望：表存在；rounds = 0，trades = 0，claims、stakes、burn 相关表全部为 0。
失败：任何业务表非空 → 立即停止，禁止上线（可能是 seed 被灌入）。
TODO（app-dev）：CI 已加 migrations guard，主网部署前再贴一次 CI 运行链接作为证据。

## 3. 主网密钥与权限

### 3.1 冻结基线（写入部署记录）

以 contracts/README.md §0 的 `acton build --info` 为准：

~~~text
JettonMaster     0x76B56D9A6301223F1201D719E2F4A3FB84E08D7D701CB93BB43C9D0208E5E241
JettonWallet     0xD06DAA57ED188CE9CB6CA596DD2111347433BF335223AC66C0D713C8E3DB74F4
RoundController  0x628E3A638D1B749C1D012D61A3F1E296BEC4AE3D586B4DCB4E733A169A32C16D
~~~

核对命令（contracts 目录）：

~~~bash
node -e "for (const n of ['JettonMaster','JettonWallet','RoundController']) { const j=require('./build/'+n+'.json'); console.log(n,j.hash); }"
~~~

期望：逐字匹配。失败：tag 或 build 产物不对 → 停止，不要部署。

### 3.2 生成主网钱包（严格隔离）

- 使用新助记词或新硬件钱包，只在一台离线机器生成；**禁止复用测试网任何助记词或私钥**。
- 角色：deployer、keeper、treasury、teamWallet、marketingWallet、liquidityWallet、teamInternalWallet。deployer、keeper、treasury 三者必须分离。
- 备份：助记词离线（纸质或金属），分地点保存；密码管理器只存地址与标签，不存助记词。
- 记录：写入 ops/records/mainnet-addresses.md（**不提交私钥**），包含角色、地址、生成日期、备份位置编号。
- keeper 与 teamWallet 地址生成后双人核对（首尾各 6 字符与校验码），并写入签字单。

### 3.3 权限说明（v10）

- **没有 admin**。RC 部署时写入 keeper 与 teamWallet，之后不可修改。
- RC 不可升级，没有提现函数，没有参数修改入口。
- JettonMaster 的铸造在部署交易里关闭。
- 因此：部署前的核对是唯一的纠错机会。详见 06。

## 4. 合约部署（全新，禁止 resume）

### 4.1 准备主网参数

- 复制 ops/config/testnet.params.json 为 ops/config/mainnet.params.json。主网值待 Lead 确认：P0、时间参数、奖励与团队额度、限额（见 §10 第 2 项）。
- 网络与地址字段改为 mainnet；登记表使用 ops/config/mainnet.registry.json，**不要覆盖测试网**。
- 预检：`node ops/scripts/00_preflight.mjs`（0 阻断）。

### 4.2 TON 预算

- 部署：JettonMaster 与 RC 的 value 用 `A9_DEPLOY_TON_JETTON_MASTER`、`A9_DEPLOY_TON_ROUND_CONTROLLER` 显式指定（不要用测试网的压缩值；数值待 Lead 审批）。
- deployer 钱包需覆盖：mint、部署、82 亿注资与其余三笔注资的 TON 费用。
- RC 充值（脚本门槛 ≥ 20 TON）与 keeper 充值（≥ 2 TON）按 01 Step 55 执行。
- **用户钱包 TON**：主网用户至少预留 0.5 TON 用于质押与领取；产品侧在 UI 明确提示。
- 余额不足 → 停止，补足后重跑；不要降低 value 到不安全的水平。

### 4.3 部署命令

~~~bash
export OPS_NETWORK=mainnet
export A9_DEPLOY_TON_JETTON_MASTER=<审批值>
export A9_DEPLOY_TON_ROUND_CONTROLLER=<审批值>
OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/15_deploy_contracts.mjs --execute
~~~

说明：15 调用 contracts/scripts/deploy-emulation.tolk（mainnet）。15 会写入 keeper 与 teamWallet（来自登记表 `wallets.keeper`、`wallets.teamWallet`）。**这两个地址此后不可修改。**
期望：脚本打印 JettonMaster、RC 与推导出的 Jetton 钱包地址；每个地址在链上 active 且 code hash 匹配后才登记。
失败：任一地址未激活，或 code hash 不匹配 → 15 会 FAIL 且不登记；停止，检查 TON 与参数，不要手工填地址。

### 4.4 手工核对（不看 exit 0）

~~~bash
cd contracts
acton rpc info <addr> --net mainnet | grep -E 'Status|Code Hash|Last Tx Hash'
~~~

- 逐个核对 3 个合约的 code hash（§3.1）。
- 核对 RC 的 `get_jetton_wallet_address()` = JettonMaster 的 `get_wallet_address(RC)`。
- 核对 RC 中的 keeper 与 teamWallet 地址与签字单逐字节一致。
失败：任一不符 → 停止，不能开轮。

### 4.5 无 wiring 步骤

v10 没有接线消息：RC 在链上自行推导自己的 Jetton 钱包。**不需要**任何设置或初始化交易。本节仅为核对。

### 4.6 注资（不可逆）

- **RC 注资 82 亿 A9，forward_ton_amount = 0**（deploy-emulation 已完成，50 只检测并登记）。
- 其余三笔（内盘 8 亿、流动性 5 亿、营销 5 亿）：

~~~bash
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<deployer> node ops/scripts/50_fund_vaults.mjs --execute --all
~~~

- 每笔先 1 A9 试探，链上确认目标钱包增加 1 A9 后才发剩余金额。
- 每笔后用 `get_wallet_data` 核对增量；treasury 的 A9 余额归零。
- 注资前按 01 §8.2 逐项核对接收 owner、推导值、链上返回值与登记表。
失败：任何一笔的金额或地址不符 → 立即停；已错投不可逆（见 §8）。

### 4.7 90_mainnet_ceremony（主网仪式）

`ops/scripts/90_mainnet_ceremony.mjs` 按阶段执行，每个阶段需要双人确认：

| 阶段 | 内容 | 通过条件 |
| --- | --- | --- |
| P0 | preflight-mainnet | 0 阻断 |
| P0.5 | 检查 treasury 与 keeper 钱包：active、TON ≥ 2、A9 = 0 | 全部满足，且为全新钱包 |
| P1 | deploy（15） | 地址全部 active |
| P2 | 核对 code hash（JettonMaster、RoundController、JettonWallet） | 与 §3.1 一致 |
| P3 | get_protocol_config：判定时间、keeper、teamWallet、JettonMaster 地址 | 与签字单一致 |
| P4 | RC 钱包推导一致；RC 余额 = 82 亿 | 一致 |
| P5 | 内盘 8 亿、流动性 5 亿、营销 5 亿，各含 1 A9 试探 | 每笔到账核对 |
| P6 | 守恒核对：treasury A9 = 0；total_supply = 100 亿；当前轮次 = 0 | 全部满足 |

- `--dry-run` 跑完全部阶段，不发任何网络写操作。主网执行前必须先跑一次 dry-run 并留存输出。

## 5. verify_deployment（严格）

~~~bash
node ops/scripts/verify_deployment.mjs --online --save
~~~

期望：严格模式开启；requiredFail = 0；无 FAIL；所有 WARN 已人工确认。

- 必看：3 个合约的 code hash、RC 的 JettonWallet code hash、RC 钱包余额、注资记录、registry digest、账户 active 状态、keeper 与 teamWallet 地址。
- **--lenient 只能用于排查**，不得作为开轮或上线依据。

失败：任何必检项 FAIL → 停止；修复后重跑。

## 6. Worker 部署

### 6.1 D1 与 secrets

~~~bash
cd worker
wrangler secret put ADMIN_TOKEN            # 强随机 ≥ 32 bytes，只存密码管理器
wrangler secret put TONCENTER_API_KEY      # 主网 key
# 可选：TONCENTER_V2_URL / TONCENTER_V3_URL（默认公共端点）
~~~

环境变量（`wrangler.toml` 的 **`[env.production.vars]`**，不是顶层 demo `[vars]`）必须满足：

- DATA_SOURCE = chain
- CHAIN_NETWORK = mainnet
- JETTON_MASTER_ADDRESS、ROUND_CONTROLLER_ADDRESS（主网地址）
- DEMO_ALLOW_UNSIGNED_WRITES = false，且 DEMO_AUTOPLAY = false
- ALLOWED_ORIGINS = https://a9.lat,https://www.a9.lat
- TON_PROOF_DOMAINS = a9.lat,www.a9.lat（去掉 localhost）
- RATE_LIMIT_* 生产值
- TONCENTER_V2_URL / TONCENTER_V3_URL（主网端点）
- VERSION（部署时可覆盖 GIT_SHA、DEPLOYED_AT）

> 上表已去掉 v8.9 的团队合约与预言机配置键。Worker 是否还需要 teamWallet 地址，以 worker 改造后的配置为准（见 §10）。

> **D-38（仓库公开）**：主网合约地址只以占位符提交在 `wrangler.toml [env.production.vars]`（如 `0:__ROUND_CONTROLLER_ADDRESS__`）。部署时由 CI 从 **GitHub Variables**（`PROD_ROUND_CONTROLLER_ADDRESS`、`PROD_JETTON_MASTER_ADDRESS`）通过 `--var` 注入。**禁止把真实地址提交进仓库。** TONCENTER_API_KEY 与 ADMIN_TOKEN 仍用 `wrangler secret put`。

### 6.2 部署（必须 `--env production` 并通过门禁）

~~~bash
pnpm -C web build
cd worker
# CI 自动执行：wrangler deploy --env production（地址由 GitHub Variables 注入）
# 手工部署同一口径（示例）：
wrangler deploy --env production \
  --var ROUND_CONTROLLER_ADDRESS:"$PROD_ROUND_CONTROLLER_ADDRESS" \
  --var JETTON_MASTER_ADDRESS:"$PROD_JETTON_MASTER_ADDRESS"
~~~

- CI 在 deploy 之前设有硬门禁（`.github/workflows/ci.yml`）：`DATA_SOURCE != chain`、`DEMO_ALLOW_UNSIGNED_WRITES != false`、`CHAIN_NETWORK != mainnet`，或地址仍为占位符，任一成立即 fail 并打印原因。
- 唯一绕过方式：`workflow_dispatch` 勾选 `allow_demo_deploy=true`（仅演示用途，会在日志留痕）。
- 顶层 `[vars]` 仍是 demo 配置，只给本地 `wrangler dev` 用；**严禁**用默认环境部署生产。

期望：Worker 版本号输出；自定义域名 a9.lat、www 生效。
失败：门禁失败、D1 id 或绑定错误、assets 缺失、证书未 Active → 停止，**不要回滚到 demo**。

### 6.3 验证

~~~bash
curl -s https://a9.lat/api/health
curl -s https://a9.lat/api/version
curl -s https://a9.lat/api/rounds | head
~~~

期望：health 正常；version 与部署 sha 一致；rounds 返回链上真实数据（roundId、status、target 与 RC getter 一致），不是演示数据。
失败：出现演示数据或假余额 → 立即停止，检查 DATA_SOURCE 与地址，禁止公告。

### 6.4 引导索引器（**这一步不做，全站会返回 503**）

chain 模式下，索引器必须把链上 `get_protocol_config` 的关键配置键落进 D1。具体键清单以 worker 当前代码为准。缺任何一个键，worker 都会报告配置不完整（health 返回 200，但 reason 列出缺键，其余 API 返回 503）。**这是设计如此，不是故障。**

~~~bash
# 1) 手动触发一次索引（管理接口的首启豁免见 worker 配置）
curl -s -X POST https://a9.lat/api/admin/indexer/tick \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# 2) 确认缺键已清空（reason 字段应为空）
curl -s https://a9.lat/api/health | jq '.data.oracle'
# 3) 确认数据已是链上真值
curl -s https://a9.lat/api/rounds | jq '.[0]'
curl -s https://a9.lat/api/config | jq
~~~

期望：health 无缺键；`/api/rounds` 的 roundId、status、target 与 RC `get_round` 逐字段一致；`/api/config` 与 `get_protocol_config` 一致。
失败：仍报缺键 → 查 admin_events 中的 INDEXER_TICK_WARN 与 ERROR；确认 ROUND_CONTROLLER_ADDRESS 等变量与 TONCENTER_API_KEY。
**顺序不能反**：必须先让索引器落库，再对外公告。

## 7. 冒烟（必须用真实小额资金）

1. 准备一个新的真实钱包（非 keeper、非资金钱包），充值少量 TON 与 A9。
2. 质押 ≥ 100,000 A9（最低质押）→ 报名到期后关窗 → keeper 提交 24 根 K 线 → 第 24 根判定。
3. 领取：`Claim(roundId)`（本金 + 全额奖励）；核对余额变化与 getter 一致。
4. 退款路径：如有无效质押或 TON 不足的记录，用 `Claim(0)` 或 `ClaimAll` 领取，核对金额。
5. **故意发一笔必然失败的交易**（例如重复领取已领过的轮次），确认前端显示**失败**并带错误码，而不是显示成功。这是现场验收，单测覆盖不了。
6. e2e 指向主网：`node qa/e2e.mjs https://a9.lat`（缺 ADMIN_TOKEN 时后台用例会跳过，必须带上）。

失败：任一失败 → 停止并回滚 Worker；合约问题不可回滚，需评估应急公告。

## 8. 回滚与应急

### 8.1 可回滚

- Worker：`wrangler rollback` 到上一版本；D1 在升级前用 `wrangler d1 export` 备份，必要时恢复。
- 域名、DNS、证书可调整。

### 8.2 不可逆

- 合约部署地址；RC 中的 keeper 与 teamWallet 地址；A9 注资与销毁。

### 8.3 止血

- **合约没有暂停功能**。发现异常时：停止前端质押入口（运维开关）；停止 keeper 提交；发布临时声明（见 05 §6）。
- keeper 异常或疑似泄露：见 04 §9；技术终止由任何人在条件满足后调用 AbortTechnical。
- Worker 被攻击或异常：rollback，临时关闭写接口（维护页或 401），保留日志。
- 资金错投或异常：立即停止所有签名操作，按 03 §7 升级；**不要尝试二次转账“补救”**。
- 公告模板见 05；客服口径只陈述已确认事实，不承诺赔付或时间表（待 Lead 确认）。

## 9. 上线顺序

1. 合约 + 注资 + verify STRICT 全 PASS。
2. Worker chain 模式部署，health、version、rounds 验证通过。
3. 小额真实资金全链路冒烟通过。
4. 公告按 05 手册审批（标题与正文不得出现收益承诺）；keeper 开 R1。
5. R1 稳定运行一个完整观察窗（约 72 小时）后，再开放内盘与流动性（时间由项目方决定，见 §10）。
6. 首日值班：monitor_check 与 reconcile 每 10 分钟运行一次；出现 P0 立即停止相关入口。

### 9.1 开 R1 的 twap24hUsdE8 来源（**必须事先定死，不能临时决定**）

RC 的 `OpenRound(roundId, twap24hUsdE8)` 会锁定目标价：`target = max(P0 × 2^tier, 2 × twap)`。tier 1 时即 `max(232000, 2 × twap)`。这个输入没有链上来源，必须由人工按固定规则产生，并双人复核：

1. 取主网流动性池开盘后，连续 24 个整点 TWAP 的中位数（不足 24 小时则用开盘以来的全部整点）。
2. 若开盘不足 1 小时、样本不足，**不允许开轮**。等够数据再说，不要用单一价格顶替。
3. 双人独立计算，结果必须一致；不一致则停止并排查。
4. 把 twap 值、采样区间、数据来源、计算人、复核人写入部署记录，作为 R1 开轮的审批附件。
5. 开轮后立刻用 `get_round(1)` 回读 target，确认等于 `max(232000, 2 × twap)`。

**为什么不留 TODO**：这个数字直接决定 R1 的目标价，也决定第一批用户的输赢。留成 TODO 就等于上线当天临时拍脑袋。

## 10. TODO 与待拍板

| # | 事项 | 决策人 | 阻塞级别 |
| --- | --- | --- | --- |
| 1 | 主网参数复核（默认值见 docs/00 的 D-42 与 contracts/README §2）：P0 = 116000 USD_E8；每轮奖励 7 亿 A9（7e17 raw）；团队额度 1.2 亿（1.2e17 raw）；最低质押 100,000 A9（1e14 raw）；单地址每轮上限 2,000 万 A9（2e16 raw）；本轮总额上限 2 亿 A9（2e17 raw）；PREVIEW 12h、报名 36h、观察 24 根 × 1h、判定阈值 16；风险披露版本 1 | Lead + 项目方双人复核 | 阻塞 preflight |
| 2 | 主网 TON 预算（部署、RC 与 keeper gas、用户 gas 补贴） | Lead | 阻塞部署 |
| 3 | TONCENTER_API_KEY 申请或付费 RPC | 项目方 | 阻塞 Worker 与 keeper |
| 4 | 域名、证书与公告审批 | 项目方 | 阻塞上线 |
| 5 | 内盘与流动性开放时间与价格 | 项目方 | 不阻塞合约 |
| 6 | 应急公告与客服口径的法律审阅 | 项目方 | 阻塞公告 |
| 7 | keeper 托管方案与运维负责人（见 06 §9） | 项目方 | 阻塞部署 |
| 8 | teamWallet 地址是否在 Worker 与公告中展示（与“团队地址不公开”的规则需对齐） | 项目方 | 阻塞 Worker 配置 |
| 9 | 多签工具脚本 91、92 是否随 v10 保留（06 §8） | Lead | 不阻塞 |

## 11. 签字

- 部署负责人：__________ 日期：__________
- 复核人（双人）：__________ 日期：__________
- keeper 地址与 teamWallet 地址双人核对：__________ 日期：__________
- 已知不可逆操作清单已阅读：deployer、keeper、treasury 三方各签一次。
