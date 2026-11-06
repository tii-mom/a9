# 07 — 主网部署全流程手册（MAINNET-RUNBOOK）

> 状态：**REVIEWED（lead，2026-11-06）**。目标：从「测试网 v8.6 验收通过」到「主网可交易」。
> 已并入：索引器引导步骤（§6.4）、开轮 twap 来源规则（§9.1）、FIX-5 失败回执现场验收（§7.5）、主网参数默认值（§10）。
> 主网三件不可逆的事：**合约部署、admin 写入（InitController / SetJettonWallet*）、资金注入**。每一步必须先做前置检查、先小额验证、失败立即停。

## 0. TL;DR

1. 冻结 v8.6 tag，核对 5 个 build code hash（见 §3.1）。
2. 新建主网 D1 库，只 apply 0001–0009 迁移，**绝不执行 seed.sql**。
3. 生成全新主网密钥（**严禁复用测试网密钥**），完成离线备份；**admin = 单一冷钱包（D-36 已定案，方案 B）**，见 §3.3 的强制要求。
4. 全新部署 JettonMaster → RC/TV/OracleAdapter → wiring → 注资 70 亿/12 亿/8 亿/5 亿/5 亿。
5. verify_deployment **STRICT 全 PASS** 后才允许开 R1（默认即是 STRICT；--lenient 输出不得作为上线依据）。
6. 部署 Worker（chain 模式、真实地址、关闭 demo 写接口）→ health/version/rounds 验证。
7. 小额真实资金全链路冒烟 → 公告 → 开 R1 → 按计划开放内盘/流动性。

## 1. 前置门禁（全部满足才允许开始）

| # | 门禁 | 检查命令/证据 | 负责人 |
| --- | --- | --- | --- |
| 0 | **外部安全审计已完成并复核**（D-37） | `docs/21_AUDIT_RFP.md` 执行完毕；审计报告 + 复核报告归档；所有 Critical/High 已修复或书面接受 | 项目方 / 审计方 |
| 1 | 合约 tag 已冻结（审计后为 `v8.7-audit-fixed`） | git rev-parse + tag 指向 commit 由 lead 书面确认 | lead/contract-dev |
| 2 | 5 个 code hash 与冻结基线一致 | §3.1 的 build 产物 hash 截图/日志 | contract-dev |
| 3 | 测试网权威 10 轮验收通过 | ops/records/fasttest-v86-rounds.md，含 C-1、R10 解锁、总量守恒 | testnet-ops |
| 4 | 索引器对账 diff=0 | `node worker/src/indexer/tools/chain-reconcile.mjs --network testnet --rc <addr> --tv <addr> --jm <addr>`，diff 计数必须为 0（任何 getter 失败 CLI 直接 exit 1） | testnet-ops |
| 5 | verify_deployment STRICT 全 PASS（测试网实例） | node ops/scripts/verify_deployment.mjs --online，严格模式 ON、requiredFail=0 | testnet-ops |
| 6 | 主网 admin 方案已定 | **D-36：方案 B 单一冷钱包**；硬件钱包地址已生成、助记词离线备份、双人核对；风险已书面接受 | lead + 项目方 |
| 7 | TONCENTER_API_KEY 已申请 | 主网 key 写入 secret，1 RPS 限制解除 | lead |
| 8 | 演示数据不会进主网 D1 | CI guard 已生效（migrations 只允许 NNNN_*.sql） | app-dev |
| 9 | 域名/证书可用 | a9.lat / www.a9.lat DNS 指向 Cloudflare，证书 Active | 项目方 |

**任一不满足 → 停止，不要用 TODO 或口头确认替代。**

### 1.1 已知血泪教训（写进 checklist，不是故事）
- **seed.sql 曾被当成迁移**：任何非迁移 SQL 混入 worker/migrations 都会被 wrangler 当迁移执行。主网 apply 前必须执行 §2.2 的守卫命令。
- **JettonWallet 代码变更会改所有 jetton wallet 地址**：v8.6 的 JettonWallet hash 与 v8.5 不同，必须**全新部署** JettonMaster/RC/TV/OA，禁止 resume 旧实例。
- **用户钱包 TON 会耗尽**：测试中 runner 因 C 钱包 TON 0.251 < stake value 0.35 失败退出。主网必须提前估算每用户 gas 并预留。
- **STRICT 默认**：--lenient 只用于排查；主网开轮依据必须是 STRICT 全 PASS。

## 2. 主网 D1 新库

### 2.1 创建
~~~bash
cd worker
wrangler d1 create a9-mainnet
# 把返回的 database_id 写入 wrangler.toml 的 [[d1_databases]]，binding 保持 DB
~~~
期望：输出 database_id；wrangler.toml 中 database_name=a9-mainnet，database_id 为新值。
失败：名称冲突/权限不足 → 换名或检查 Cloudflare 账号；**不要复用测试库**。

### 2.2 migrations 守卫 + apply
~~~bash
cd worker
ls migrations | sort
# 必须恰好是 0001_init.sql ... 0009_chain_indexer.sql，且无其他 .sql
for f in migrations/*.sql; do case "$(basename "$f")" in [0-9][0-9][0-9][0-9]_*.sql) ;; *) echo "BAD: $f"; exit 1;; esac; done
wrangler d1 migrations apply a9-mainnet --remote
~~~
期望：apply 只列 0001–0009；无 seed 内容；无报错。
失败：出现非编号文件 → 立即停止，删除/移出 migrations 后重跑；**绝不执行 seed.sql**。

### 2.3 验证空库
~~~bash
wrangler d1 execute a9-mainnet --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
wrangler d1 execute a9-mainnet --remote --command "SELECT COUNT(*) AS rounds FROM rounds;"
wrangler d1 execute a9-mainnet --remote --command "SELECT COUNT(*) AS trades FROM trades;"
~~~
期望：表存在；rounds=0、trades=0、claims/stakes/burn_ledger 全 0。
失败：任何业务表非空 → 立即停止，禁止上线（可能是 seed 被灌入）。
TODO（app-dev）：CI 已加 migrations guard，主网部署前再贴一次 CI 运行链接作为证据。

## 3. 主网密钥与 admin 方案

### 3.1 冻结基线（写入部署记录）
~~~text
JettonMaster    0x876F21A1A516FB0449A1D0AF5DBECEB8639373F947949C5AE8E1E9DBB769D64F
JettonWallet    0x394E4E8D40B5D3D97D12AA950B99EA9A53387DDAC331BAAAC8923F0E6E6849A4
TeamVault       0xCF3E6C7C9DC045F392F35E79E20AA6EDAAF9064D538CA4E78B6D1FE1443158B4
RoundController 0xC5AD291469C3BEADBDC26A6F1733004D433F12B15B025D88B983DF098BA11500
OracleAdapter   0x539F3597357943584A596DA2B40F901B4984D8C8307E63CE81A67F131EAB8CBA
~~~
核对命令（contracts 目录）：
~~~bash
node -e "for (const n of ['JettonMaster','JettonWallet','TeamVault','RoundController','OracleAdapter']) { const j=require('./build/'+n+'.json'); console.log(n,j.hash); }"
~~~
期望：逐字匹配。失败：tag 或 build 产物不对 → 停止，不要部署。

### 3.2 生成主网钱包（严格隔离）
- 使用新助记词/new hardware wallet，只在一台离线机器生成；**禁止复用测试网任何 mnemonic/私钥**。
- 角色：deployer / admin（或多签）/ treasury / team / marketing / liquidity / internal；至少 deployer、admin、treasury 三者分离。
- 备份：助记词离线纸质/金属，分地点保存；密码管理器只存地址与标签，不存助记词。
- 记录：写入 ops/records/mainnet-addresses.md（**不提交私钥**），包含角色、地址、生成日期、备份位置编号。

### 3.3 admin 方案：**已定案 = 方案 B（单一冷钱包）**（D-36，2026-11-06）

项目方明确选择 **B：单一冷钱包（硬件钱包离线保管）**，不做多签。**这是已书面记录的永久风险，部署前必须再确认一次**：

| 风险 | 说明 | 是否有补救 |
| --- | --- | --- |
| RC / TeamVault admin 永久不可改 | 无 `SetAdmin` / `ChangeAdmin`，`InitController` 只写一次 | **无** |
| TV admin 可改 `teamWalletJettonWallet` | 即重定向团队 12% 额度的收款地址 | **无** |
| OA admin 可 `SetOracleAdmin` 换人 | 单钥泄露 = 可换掉全部 3/5 预言机签名人 = 伪造结果 | **无** |
| 单密钥丢失 | 无法执行 admin 操作 | 仅依赖合约逃生舱（到期任何人可关窗、SETTLING_* 任何人可推、观察超时可技术中止） |
| 单密钥泄露 | **不可直接转走资金，但可强制任意轮次判负，销毁该轮 100% 用户本金与奖励**（SubmitCandle 低价 K 线）；足以毁掉项目 | **无** |

**因此本节强制要求：**
1. admin 私钥必须生成在**硬件钱包**上，助记词离线抄写、异地存放 ≥2 份，**绝不进入任何联网设备、绝不复用测试网密钥**；
2. admin 地址的生成过程需**双人在场**，生成后立刻离线核对地址（首尾各 6 字符 + CRC）；
3. 部署完成后，`verify_deployment` 必须核对 `RC.get_protocol_config().admin` == 该冷钱包地址，且该地址在链上**从未发出过任何交易**（证明是全新冷钱包）；
4. 主网上线后 admin 私钥**永久离线保存**，仅在需要执行 admin 操作时使用，每次使用后重新归零；
5. 多签方案（Multisig v2，实测 7.5–9.5 人天、gas 可忽略）技术验证已完成，工具保留在 `ops/scripts/91_deploy_multisig.mjs` / `92_multisig_order.mjs`，**供未来版本升级时启用**（需重新部署合约）。

详见 `runbooks/06_mainnet_admin.md`。

## 4. 合约部署（全新，禁止 resume）

### 4.1 准备 mainnet 参数
- 复制 ops/config/testnet.params.json → ops/config/mainnet.params.json（TODO：lead 确认主网值：P0、时间参数、奖励/团队额度、限额）。
- 地址/网络字段改为 mainnet；registry 用新文件 ops/config/mainnet.registry.json，**不要覆盖测试网**。
- preflight：node ops/scripts/00_preflight.mjs（0 阻断）。

### 4.2 TON 预算（主网按实际 gas 重算）
- 部署：JettonMaster / OA / TV / RC 的 value 用 A9_DEPLOY_TON_* 显式指定（不要用测试网压缩值，TODO：估算后 lead 审批）。
- admin 钱包需覆盖：mint 0.55 + wiring 5×0.2 + 注资 5 笔 TON 费；RC/TV 需预留跨合约消息 gas。
- **用户钱包 TON**：主网用户至少预留 0.5 TON 用于 stake/claim；产品侧在 UI 明确提示。
- 失败：余额不足 → 停止，补足后重跑；不要降低合约 value 到不安全水平。

### 4.3 部署命令
~~~bash
export OPS_NETWORK=mainnet
export A9_DEPLOY_TON_JETTON_MASTER=<审批值>
export A9_DEPLOY_TON_ORACLE_ADAPTER=<审批值>
export A9_DEPLOY_TON_TEAM_VAULT=<审批值>
export A9_DEPLOY_TON_ROUND_CONTROLLER=<审批值>
OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/15_deploy_contracts.mjs --execute
~~~
说明：15 会调用 contracts/scripts/deploy-emulation.tolk（mainnet）。**禁止 resume 旧实例**；v8.6 JettonWallet 代码变 → master/wallet 地址全变。
期望：脚本打印 6 个地址；15 的链上硬门禁逐个 active + code hash 匹配才登记。
失败：任一地址未激活/code hash 不匹配 → 15 会 FAIL 且不登记；停止，检查部署 TON/参数，不要手工填地址。

### 4.4 手工核对（不看 exit 0）
~~~bash
cd contracts
acton rpc info <addr> --net mainnet | grep -E 'Status|Code Hash|Last Tx Hash'
~~~
逐个核对 4 个合约 hash（§3.1）与 RC.get_jetton_wallet_code_hash = 0x394E…。
失败：hash 不符 → 停止，不能开轮。

### 4.5 wiring（多签时打包）
- 全新部署脚本已包含 SetJettonWallet / SetJettonWalletCode / SetTeamWalletJettonWallet / InitController。
- 若 admin 是多签：把上述消息按顺序打包成一个多签订单（顺序不可乱：SetJettonWallet* → InitController），附完整地址与金额，双人核对后再签。
- 核对：RC.oracle=OA；RC.stakingJettonWallet=RC wallet；RC.teamVault=TV；TV.controller=RC；TV.jettonWallet=TV wallet；TV.teamWalletJettonWallet=team canonical wallet。
- 失败：任一 wiring 未完成 → 停止；InitController 不可逆，**绝不重复发**。

### 4.6 注资（不可逆）
~~~bash
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<admin> node ops/scripts/50_fund_vaults.mjs --execute --all --probe
~~~
金额：RC 70 亿 A9、TV 12 亿、内盘 8 亿、流动 5 亿、营销 5 亿（合计 100 亿）。
- 每笔先 1 A9 probe，链上确认目标钱包 +1 A9 后才发剩余；
- 每笔后 get_wallet_data 核对增量；admin A9 归零。
失败：任何一笔金额/地址不符 → 立即停；已错投不可逆（见 §8）。

## 5. verify_deployment（严格）

~~~bash
node ops/scripts/verify_deployment.mjs --online --save
~~~
期望：严格模式 ON；requiredFail=0；无 FAIL；所有 gate.WARN 已人工确认。
- 必看：5 个 code hash、RC jettonWalletCode、TV teamWalletJettonWallet、funding 5 项、registry digest、账号 active。
- **--lenient 只能排查，不得作为开轮/上线依据**。
失败：任何必检项 FAIL → 停止；修复后重跑。

## 6. Worker 部署

### 6.1 D1 与 secrets
~~~bash
cd worker
wrangler secret put ADMIN_TOKEN            # 强随机 ≥32 bytes，只存密码管理器
wrangler secret put TONCENTER_API_KEY      # 主网 key
# 可选增加：TONCENTER_V2_URL/TONCENTER_V3_URL（默认公共端点）
~~~
环境变量（`wrangler.toml` 的 **`[env.production.vars]`**，不是顶层 demo `[vars]`）必须满足：
- DATA_SOURCE=chain
- CHAIN_NETWORK=mainnet
- JETTON_MASTER_ADDRESS / ROUND_CONTROLLER_ADDRESS / TEAM_VAULT_ADDRESS（主网地址）
- ORACLE_CONFIG_VERSION / ORACLE_CONFIG_HASH（与链上一致）
- DEMO_ALLOW_UNSIGNED_WRITES=false（且 DEMO_AUTOPLAY=false）
- ALLOWED_ORIGINS=https://a9.lat,https://www.a9.lat
- TON_PROOF_DOMAINS=a9.lat,www.a9.lat（去掉 localhost）
- RATE_LIMIT_* 生产值
- TONCENTER_V2_URL / TONCENTER_V3_URL（主网端点）
- VERSION（部署时可覆盖 GIT_SHA/DEPLOYED_AT）

> **D-38（仓库公开）**：主网合约地址 / oracle config hash **只以占位符**提交在
> `wrangler.toml [env.production.vars]`（`0:__ROUND_CONTROLLER_ADDRESS__` 等）。
> 部署时由 CI 从 **GitHub Variables**（`PROD_ROUND_CONTROLLER_ADDRESS`、
> `PROD_TEAM_VAULT_ADDRESS`、`PROD_JETTON_MASTER_ADDRESS`、`PROD_ORACLE_CONFIG_HASH`）
> 通过 `--var` 注入；**禁止把真实地址提交进仓库**。
> `TONCENTER_API_KEY` / `ADMIN_TOKEN` 仍用 `wrangler secret put`（不进 toml、不进仓库）。

### 6.2 部署（必须 `--env production` + 门禁）
~~~bash
pnpm -C web build
cd worker
# CI 自动执行：wrangler deploy --env production（地址由 GitHub Variables 注入）
# 手工部署同一口径（示例）：
wrangler deploy --env production \
  --var ROUND_CONTROLLER_ADDRESS:"$PROD_ROUND_CONTROLLER_ADDRESS" \
  --var TEAM_VAULT_ADDRESS:"$PROD_TEAM_VAULT_ADDRESS" \
  --var JETTON_MASTER_ADDRESS:"$PROD_JETTON_MASTER_ADDRESS" \
  --var ORACLE_CONFIG_HASH:"$PROD_ORACLE_CONFIG_HASH"
~~~
- CI 在 deploy **之前**有硬门禁（`.github/workflows/ci.yml`）：读取 `[env.production.vars]` +
  GitHub Variables，若 `DATA_SOURCE != chain` 或 `DEMO_ALLOW_UNSIGNED_WRITES != false` 或
  `CHAIN_NETWORK != mainnet`，或地址/哈希仍是占位符 → **直接 fail 并打印原因**。
- 唯一绕过方式：`workflow_dispatch` 勾选 `allow_demo_deploy=true`（仅演示用途，会在日志留痕）。
- 顶层 `[vars]` 仍是 **demo 配置**，只给本地 `wrangler dev` 用；**严禁**用默认环境部署生产。

期望：Worker 版本号输出；自定义域名 a9.lat / www 生效。
失败：门禁失败（打印 demo 配置原因）/ D1 id/绑定错误 / assets 缺失 / 证书未 Active → 停止，**不要回滚到 demo**。

### 6.3 验证
~~~bash
curl -s https://a9.lat/api/health
curl -s https://a9.lat/api/version
curl -s https://a9.lat/api/rounds | head
~~~
期望：health ok；version 与部署 sha 一致；rounds 返回链上真数据（roundId/status/target 与 RC getter 一致），不是 demo 数据。
失败：若看到 demo 数据/假余额 → 立即停止，检查 DATA_SOURCE 与地址，禁止公告。

### 6.4 引导索引器（**这一步不做，全站会 503**）

chain 模式下有 **11 个关键配置键**必须由索引器从链上 `get_protocol_config` 落进 D1：
`p0_usd_e8` / `round_reward_raw` / `total_supply_raw` / `min_stake_raw` / `max_total_stake_raw` / `candle_count` / `candle_seconds` / `min_qualified_candles` / `observation_seconds` / `stake_duration_seconds` / `risk_disclosure_version`。

缺任何一个，worker 都会返回 `ORACLE_PAUSED`（health 200 但 `oracle.reason` 列出缺键，其余 API 503）——**这是设计如此，不是故障**。

~~~bash
# 1) 手动触发一次索引（B6 门对 /api/admin/indexer/* 豁免，否则无法首启）
curl -s -X POST https://a9.lat/api/admin/indexer/tick \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# 2) 确认缺键已清空（reason 字段应为空）
curl -s https://a9.lat/api/health | jq '.data.oracle'
# 3) 确认数据已经是链上真值
curl -s https://a9.lat/api/rounds | jq '.[0]'
curl -s https://a9.lat/api/config | jq
~~~

期望：health 的 `oracle.paused=false`（或 reason 为空）；`/api/rounds` 的 roundId/status/target 与 RC `get_round` 逐字段一致；`/api/config` 的 14 个参数与 `get_protocol_config` 一致。
失败：仍报缺键 → 看 `admin_events` 里的 `INDEXER_TICK_WARN/ERROR`；确认 `ROUND_CONTROLLER_ADDRESS` 等环境变量正确、`TONCENTER_API_KEY` 有效。
**顺序不能反**：必须先让索引器落库，再对外公告。否则用户进来会看到 503 或空数据。

## 7. 冒烟（必须用真实小额资金）

1. 准备一个新的真实钱包（非 admin），充值少量 TON + A9。
2. 质押 ≥ minStake（主网 10,000 A9）→ 等/触发关窗 → keeper 提交 24 根 K 线 → 结算。
3. 领取：ClaimRewardEarly / ClaimPrincipal / ClaimAll；核对 pendingQueryId 归零、余额变化与 getter 一致。
4. R10 后 ClaimUnlocked 连续两次（第二次 claimedRaw 增加）。
5. **故意发一笔必然失败的交易**（例如重复领取已领过的轮次），确认前端显示**失败**并带错误码，而不是显示成功。这是审查报告第 5 项（前端把失败回执当成功）的现场验收，单测覆盖不了。
6. e2e 指向主网 URL：`node qa/e2e.mjs https://a9.lat`（缺 `ADMIN_TOKEN` 时后台用例会跳过，必须带）。
失败：任一失败 → 停止并回滚 Worker；合约问题不可回滚，需评估应急公告。

## 8. 回滚与应急

### 8.1 可回滚
- Worker：wrangler rollback 到上一版本；D1：升级前 wrangler d1 export 备份，必要时恢复。
- 域名/DNS/证书可调整。
### 8.2 不可逆
- 合约部署地址、admin 写入（InitController / SetJettonWallet*）、A9 注资/销毁。
### 8.3 止血
- Oracle 异常/价格异常：admin PauseOracle（0x5254000A）→ 公告 → 排查 → ResumeOracle；必要时 AbortTechnical。
- Worker 被攻击/异常：rollback + 临时关闭写接口（维护页/401）；保留日志。
- 资金错投/异常：立即停止所有签名操作，按 runbooks/03 升级；**不要尝试二次转账“补救”**。
- 公告模板：见 runbooks/05_announcements.md；客服口径：只陈述已确认事实、不承诺赔付/时间表（TODO lead 确认）。

## 9. 上线顺序

1. 合约 + wiring + 注资 + verify STRICT 全 PASS。
2. Worker chain 模式部署 + health/version/rounds 验证。
3. 小额真实资金全链路冒烟通过。
4. 公告（H1 必须是「押多少你定，赌 72 小时内至少翻倍。」），开 R1。

### 9.1 开 R1 的 twap24hUsdE8 来源（**必须事先定死，不能临时决定**）

RC 的 `OpenRound(roundId, twap24hUsdE8)` 会用该值锁定目标价：`target = max(2 × twap, ladderFloor[tier])`。我们没有接预言机，因此这个输入必须由人工按固定规则产生并双人复核：

1. 取主网流动性池开盘后 **连续 24 个整点的 TWAP 中位数**（不足 24 小时则用开盘以来的全部整点）；
2. 若开盘不足 1 小时、样本不足，**不允许开轮** —— 等够数据再说，不要用单一价格顶替；
3. 双人独立计算，结果必须一致；不一致则停止并排查；
4. 把 twap 值、采样区间、数据来源、计算人、复核人写入部署记录，作为 R1 开轮的审批附件；
5. 开轮后立刻用 `get_round(1)` 回读 `target`，确认等于 `max(2 × twap, floor)`。

**为什么不留 TODO**：这个数字直接决定 R1 是成功还是失败，也决定第一批用户的输赢。留成 TODO 就等于上线当天临时拍脑袋。
5. R1 稳定运行 ≥ 一个完整观察窗后，再开放内盘/流动性（TODO 项目方决定时间）。
6. 首日值班：monitor_check + reconcile 每 10 分钟；P0 立即停轮。

## 10. TODO / 待拍板（不得自行编答案）

| # | 事项 | 决策人 | 阻塞级别 |
| --- | --- | --- | --- |
| 1 | ~~admin 方案~~ **已定案 D-36 = B 单一冷钱包**（风险已书面接受） | 项目方 | 已解除 |
| 2 | 主网参数**复核确认**（默认值见 docs/00 V7：P0=116000 USD_E8、roundReward=7e17 raw、teamRound=1.2e17 raw、minStake=1e13 raw、maxTotalStake=2e17 raw、maxStakePerAddressBps=1000、preview 12h / stake 36h / candle 1h×24 / minQualified 16 / observation 24h、riskDisclosureVersion=1、configVersion=1） | lead + 项目方 双人复核 | 阻塞 preflight |
| 3 | 主网 TON 预算（部署、wiring、RC/TV gas、用户 gas 补贴） | lead | 阻塞部署 |
| 4 | TONCENTER_API_KEY 申请/付费 RPC | 项目方 | 阻塞 Worker/keeper |
| 5 | 域名/证书与公告审批 | 项目方 | 阻塞上线 |
| 6 | 内盘/流动性开放时间与价格 | 项目方 | 非阻塞合约 |
| 7 | 应急公告/客服口径法律审阅 | 项目方 | 阻塞公告 |

## 11. 签字

- 部署负责人：__________ 日期：__________
- 复核人（双人）：__________ 日期：__________
- 已知不可逆操作清单已阅读：deployer/admin/treasury 三方各签一次。
