# 主网彩排 B：Cloudflare 链路（D1 + Worker + 索引器）演练记录

- 日期：2026-11-06
- 执行：backend-dev（task-59）
- 隔离：Worker `fuse-protocol-drill`、D1 `a9-drill`；**未触碰** `fuse-protocol` / `b5945609-…` / a9.lat routes
- 账号：`ff431aed46e94b0593b8b1ee48842c7a`（OAuth）
- 配置：`worker/wrangler.drill.toml`（无 routes、workers.dev）
- 测试网 v8.9 实例（task-59 提供）：RC `kQD9TXvfEbAAIEW-Oyj58V4TO7b5HGALQgmPh-Ja1tRRcYAK` / TV `kQCjfgro1mAnrScsAvTN5-sE9BDw4f7U_1mq3fD9fvZgO10h` / JM `kQBnEm-jgkTMnKORlgSft2NB10meB0jtLqTH0zbRR2edE60u` / OA `kQD49Jh93W21bhf_Y3lWvG7mNx651bAvxoh4irUkEr6hNR5F`

## 实际资源 ID
- D1 `a9-drill`: `035c6db5-076b-4e04-b95f-d70731839eca`（region APAC）
- Worker `fuse-protocol-drill`: `https://fuse-protocol-drill.348421501.workers.dev`
- 首次版本：`8ff6b764-e86d-4f70-bb7d-462fef34a543`

## 执行序列（可重复）
~~~bash
cd worker

# 1) 建库（确认名称含 drill）
wrangler d1 create a9-drill
# → database_id = 035c6db5-076b-4e04-b95f-d70731839eca

# 2) 迁移（仅 0001–0009；绝不 seed）
wrangler d1 migrations apply a9-drill --remote --config wrangler.drill.toml

# 3) 空库校验
wrangler d1 execute a9-drill --remote --config wrangler.drill.toml \
  --command "SELECT (SELECT COUNT(*) FROM rounds) AS rounds,(SELECT COUNT(*) FROM stakes) AS stakes,(SELECT COUNT(*) FROM claims) AS claims,(SELECT COUNT(*) FROM trades) AS trades,(SELECT COUNT(*) FROM candles) AS candles"

# 4) 构建 + 部署（无 routes；workers.dev）
pnpm -C web build
wrangler deploy --config wrangler.drill.toml

# 5) secret（强随机 ≥32 bytes；不打印）
wrangler secret put ADMIN_TOKEN --config wrangler.drill.toml

# 6) 部署后、引导前：health/version 正常，业务 API 因缺 chain config 返回 503（预期）
curl -s https://fuse-protocol-drill.348421501.workers.dev/api/health
curl -s https://fuse-protocol-drill.348421501.workers.dev/api/version   # schemaVersion=9

# 7) 索引器引导（H-8 豁免，允许在缺配置时手动 tick）
curl -s -X POST https://fuse-protocol-drill.348421501.workers.dev/api/admin/indexer/tick \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 8) 11 个 chain config key 落库（注意：在 config 表，不是 metrics 表）
wrangler d1 execute a9-drill --remote --config wrangler.drill.toml \
  --command "SELECT key FROM config WHERE key IN ('p0_usd_e8','round_reward_raw','total_supply_raw','min_stake_raw','max_total_stake_raw','candle_count','candle_seconds','min_qualified_candles','observation_seconds','stake_duration_seconds','risk_disclosure_version')"

# 9) 对账
node src/indexer/tools/chain-reconcile.mjs --network testnet \
  --api https://fuse-protocol-drill.348421501.workers.dev \
  --rc kQD9TXvfEbAAIEW-Oyj58V4TO7b5HGALQgmPh-Ja1tRRcYAK \
  --tv kQCjfgro1mAnrScsAvTN5-sE9BDw4f7U_1mq3fD9fvZgO10h \
  --jm kQBnEm-jgkTMnKORlgSft2NB10meB0jtLqTH0zbRR2edE60u
~~~

## 实测结果
- 迁移：0001–0009 全部 ✅，`d1_migrations` = 9
- 空库：rounds/stakes/claims/trades/candles = 0
- 部署：成功，`/api/health` 200（`oracle.paused=true`，缺 11 key）、`/api/version` 200 且 `schemaVersion=9`；`/api/config`、`/api/rounds` = 503 ORACLE_PAUSED（引导前预期）
- 索引器 tick：HTTP 200，`{ok:true,pages:3,writes:127,events:112,candles:72,stakes:8,healthy:true,nextPollMs:600000}`，耗时 **76.7s**（公共 testnet toncenter，无限流 key）
- 引导后：health `oracle={paused:false,reason:null}`；`/api/config` 200（network=testnet）；`/api/rounds` 200（10 轮，R1 SUCCEEDED / R2,R3 FAILED_PERMANENT）；`config` 表 11 个 chain 键齐全
- 对账：`DIFFS (0) ✅ 链上与 API 完全一致`；configHash `sha256:3226dccfd78c6c5a5faad38cc8ac2139e43364a4a12f1482997ba1e2c95433dd`

## 与 docs/29 §2/§6/§7 不一致（重点）
1. **§2.1 迁移/写 D1 的方式过时**：文档让把 database_id 写进顶层 `[[d1_databases]]`；现状生产绑定在 `[env.production.d1_databases]`，且仓库只放全 0 占位符，真实 ID 由 CI 从 GitHub Variable `PROD_D1_DATABASE_ID` 注入。照文档手写会指向 demo 库或无效 UUID。
2. **§2.2 命令缺 `--env production`/显式配置**：本次演练必须 `--config wrangler.drill.toml`；主网等价命令应明确 `--env production`（或注入后的显式 config），否则 wrangler 可能按顶层 demo 绑定/名称解析，风险高。
3. **§6.2 Variables 少一个**：文档只列 4 个地址类 Variables；CI 门禁现在还强制 `PROD_D1_DATABASE_ID`（第 5 个），未列会 fail。
4. **§6.3 手动部署命令缺 D1 注入步骤**：文档命令 `wrangler deploy --env production --var …` 未包含 CI 的 `Inject production D1 database id`；手工照抄会拿占位符 D1 去部署。且文档未说明 `[env.production]` 与顶层 demo 的关系。
5. **§6.4 验证顺序矛盾**：文档在 §6.4 就要求 `/api/rounds` 返回链上真值，但此时索引器尚未引导（§7），实测 `/api/rounds`、`/api/config` 均 503 ORACLE_PAUSED。正确顺序：§6.4 只验 health/version；`/api/config`、`/api/rounds` 必须放到 §7 引导之后。
6. **§7.1 tick 返回结构与耗时**：实际是嵌套 `data.{ok,pages,writes,events,candles,stakes,healthy,nextPollMs}`，不是「ok / 索引条数」；本次 76.7s（公共端点）。主网需预留 ≥180s 超时并配 key，文档未写。
7. **§7.1/§7.2 无 `/api/admin/indexer/health` 路由**：task-59 要求该端点，实测 **404 接口不存在**；缺键状态只能看 `/api/health.data.oracle.reason` + D1 `config` 表。
8. **§7.2 「11 键落库」未写表名**：实际在 **`config` 表**（不是 `metrics`）；按 metrics 查会误判为缺失。
9. **§7.3 「/api/config 14 参数」与实际字段数不符**：实际 28 个顶层字段；且 `contracts` 只有 `jettonMaster/roundController/teamVault/oracleConfigHash` 有值，`stakingVault/rewardVault/oracleAdapter/codeHash/adminOwner/teamWallet/auditReportUrl` 为 null。索引器当前只写 4 个 contract_* 键；**OracleAdapter 地址（task 给的 4 个地址之一）worker 侧没有对应 env/配置键，`/api/config.contracts.oracleAdapter` 恒为 null**，与 §6.3/task 步骤 5「地址齐全」不符。
10. **§2.4 备份步骤未演练**：本次未执行 `d1 export`（演练库可重建）；主网切换前必须单独验证 export 权限/产物大小。

## 需要人工完成（无法脚本化/仓库内完成）
- 主网全新的 `ADMIN_TOKEN`(≥32B) 与 `TONCENTER_API_KEY`（`wrangler secret put --env production`）
- GitHub Variables：4 个 `PROD_*` 地址/哈希 + **`PROD_D1_DATABASE_ID`**
- 建主网 D1 后把 id 配进 GitHub Variable（不要提交仓库）
- 域名/证书/公告（G11）与主网冷钱包（G5）等非本次演练范围

## D1 备份 / 恢复演练（2026-11-06 补充）
- 导出：`wrangler d1 export a9-drill --remote --config wrangler.drill.toml --output=/tmp/a9-drill-export.sql --skip-confirmation`
  - 耗时 **7s**，产物 **49,452 bytes / 325 行**，17 张表、158 条 INSERT（rounds 10 / stakes 8 / candles 72 / config 21 / metrics 18 / claims 0 / burn_ledger 6 / d1_migrations 9）
- ⚠️ **单文件恢复失败**：把默认 export 直接 `d1 execute --file` 灌入新库报 `no such table: main.rounds`（export 按字母序输出，先 INSERT `burn_ledger` 再 CREATE `rounds`，FK 检查在跨语句时不受 `PRAGMA defer_foreign_keys` 保护）。
- ✅ 可用恢复流程（本次演练通过）：
  ~~~bash
  # 1) 结构
  wrangler d1 export a9-drill --remote --config wrangler.drill.toml --output=/tmp/a9-drill-schema-only.sql --no-data --skip-confirmation
  # 2) 数据（前置关闭 FK 再导入）
  wrangler d1 export a9-drill --remote --config wrangler.drill.toml --output=/tmp/a9-drill-data-only.sql --no-schema --skip-confirmation
  { echo 'PRAGMA foreign_keys=OFF;'; cat /tmp/a9-drill-data-only.sql; } > /tmp/a9-drill-data-fkoff.sql
  wrangler d1 create a9-drill-restore
  wrangler d1 execute a9-drill-restore --remote --config wrangler.drill.toml --file=/tmp/a9-drill-schema-only.sql
  wrangler d1 execute a9-drill-restore --remote --config wrangler.drill.toml --file=/tmp/a9-drill-data-fkoff.sql
  ~~~
- 实测恢复耗时：schema 导入 **5s** + data 导入 **5s**（export 侧 7s）；恢复后行数与 a9-drill **完全一致**（rounds 10 / stakes 8 / candles 72 / config 21 / metrics 18 / claims 0 / burns 6 / migrations 9），抽样 R1 state/target/candleHash 也一致。
- 主网估算：export 时间≈云任务固定开销 + 数据量；本次 49KB 仅 7s，主网库在预加载时接近空库（同量级），但**开轮后库会增长**，建议上线前/首次开轮前各备份一次，并按「结构/数据两阶段 + FK OFF」写入 runbook；恢复演练必须在主网前再做一次（目标库用 a9-mainnet-restore，勿覆盖生产）。

## 索引器 SubmitCandle 是否依赖发送方地址（Lead 确认点）
- **不依赖发送方**。索引器按 `transactions({account: RC, sort:'asc'})` 拉取**目标为 RoundController 的全部交易**（toncenter v3），不按 in_msg.source 过滤。
- 入站解码 `inboundOfTx(tx, rcRaw)` 仅校验：该 tx 有 `in_msg`、`destination === RC raw`、opcode 可解析；随后按 `TX_OP.submitCandle` 解码 body（roundId/candleIndex/periodStart/periodEnd/twap/digest），**没有任何 sender/source 判断**（见 `worker/src/indexer/sync.ts:169-180, 405-415`）。
- 因此主网接 OracleAdapter 后，无论发送方是 OA、admin 还是其它地址，只要消息发到 RC 且 opcode/布局正确就会被索引；发送方鉴权由合约负责，索引器不重复校验，也不会漏事件。
- 唯一注意：索引器依赖 toncenter `account=RC` 的交易索引；若 RPC 漏页/分页异常会由 cursor 重试（已有退避/健康上报），与发送方无关。

## 收尾决策：保留 drill 资源
保留 `fuse-protocol-drill` + `a9-drill` 供主网当天二次彩排/回归复用。理由：无自定义域名、仅 testnet chain 只读 + admin 索引器；ADMIN_TOKEN 为随机 ≥32B secret；成本可忽略。主网切换完成后如不再需要，用以下命令删除：
~~~bash
cd worker
wrangler delete --config wrangler.drill.toml
wrangler d1 delete a9-drill
~~~
