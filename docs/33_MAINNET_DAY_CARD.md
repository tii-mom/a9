# 33 — 主网部署当天执行卡（A9）

> **本卡是 `docs/29_MAINNET_CUTOVER.md` 的压缩版，冲突以 docs/29 为准。** 基线：`v8.9-audit-fixed` @ `58d0be8`；179 tests / 18 files。主网当天只照本卡走，不翻 600 行。
> **不可逆（先记住）**：① 合约部署；② admin / wiring 写入；③ A9 注资/分配；④ 已开轮。**出错立即停，不二次转账“补救”。**

**三个必查坑**：
1. **成功判据 = 日志出现 `Funded RC Jetton Wallet`，不是 exit 0**（mint forward <0.35 会让钱包部署失败但脚本看着还在跑）。
2. **注资遇 seqno 冲突/exit 33**：回读余额 → 全 0 才可重试一次 → 部分到账按差额手工补；**禁止整笔重发**。
3. **部署后先用主网 toncenter 查合约 active**：若 `--net` 错发测试网，主网查不到 → 立即停。

**当天终端先填一次**（后面命令直接复制）：
~~~bash
export A9_MAINNET_RPC=https://toncenter.com/api/v2 A9_MAINNET_API=https://toncenter.com/api/v3 TONCENTER_API_KEY=<mainnet key>
export RC=<RC> TV=<TV> JM=<JettonMaster> OA=<OracleAdapter> JW=<JettonWallet> ADMIN_ADDRESS=<冷钱包>
export PROD_D1_ID=<a9-mainnet-id> A9_SIGNER_WALLET=<signer> OPS_RECORDS_DIR=$PWD/ops/records/mainnet-$(date +%Y%m%d)
export PROD_ROUND_CONTROLLER_ADDRESS=<RC-raw> PROD_TEAM_VAULT_ADDRESS=<TV-raw> PROD_JETTON_MASTER_ADDRESS=<JM-raw> PROD_ORACLE_CONFIG_HASH=<sha256:...>
~~~

---

[ ] 1. 物料核对（5 样）
    命令：`test -n "$TONCENTER_API_KEY" && test -n "$ADMIN_ADDRESS" && test -n "$PROD_D1_ID" && grep -q "可上线" docs/22_EXTERNAL_AUDIT_REPORT.md && echo MATERIALS_OK`
    期望：`MATERIALS_OK`（主网 key 有效 / 冷钱包地址已双人核对 / deployer ≥7 GRAM / D1 库 ID 已建 / 审计 PASS 有签字）
    失败：缺任何一项 → **停止**（见 docs/29 §1 G4/G5/G6/G7）
    可逆：—

[ ] 2. preflight 全绿
    命令：`node worker/scripts/preflight-mainnet.mjs --tag=v8.9-audit-fixed`
    期望：`结果：PASS（8 项全部通过，可以进入部署流程）`
    失败：任何 `FAIL` → **停止**，按脚本报的项修（尤其 ops `--net testnet` / 生产 D1 与 demo 同 id）
    可逆：是（只读）

[ ] 3. 建 D1 a9-mainnet → apply 0001-0009 → 空库
    命令：`cd worker && wrangler d1 create a9-mainnet && wrangler d1 migrations apply a9-mainnet --remote && wrangler d1 execute a9-mainnet --remote --command "SELECT COUNT(*) FROM rounds;"`
    期望：只列 `0001_init.sql`…`0009_chain_indexer.sql`；`rounds=0`、`trades/claims/stakes/burn_ledger` 全 0；**绝不 seed**
    失败：出现非编号 SQL 或业务表非空 → **停止**，清库/移文件后重来
    可逆：是（新库，可删重建）

[ ] 4. 部署 4 个合约（JM/OA/TV/RC；wallet 由 code 派生）
    命令：`OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/15_deploy_contracts.mjs --execute 2>&1 | tee "$OPS_RECORDS_DIR/15_deploy.log"; grep -F "Funded RC Jetton Wallet" "$OPS_RECORDS_DIR/15_deploy.log"`
    期望：**`Funded RC Jetton Wallet with 7000000000000000000 raw A9, TV Jetton Wallet with 1200000000000000000 raw A9`**（坑①；exit 0 不算数）
    失败：无该行/地址未 active → **停止**（查 mint forward ≥0.35）；exit 33 → 坑②；日志在 `ops/records/deploy-emulation-*.log`
    可逆：**否（地址/代码永久）**

[ ] 5. 5 个 hash + RC.get_jetton_wallet_code_hash
    命令：`for a in $JM $TV $RC $OA; do acton rpc info "$a" --net mainnet | grep -E "Status|Code Hash"; done; node ops/scripts/verify_deployment.mjs --online | grep -E "jettonWalletCode|codeHash"`
    期望：4 个 `active` + hash 与 docs/29 §4.2 逐字一致；`RC.get_jetton_wallet_code_hash == JettonWallet hash`（坑③：必须主网 toncenter 查，测试网查不到）
    失败：任一 hash 不一 / 查不到 → **停止**；错发测试网则按「新实例重部署」处理
    可逆：**否**

[ ] 6. get_protocol_config 槽 12-17
    命令：`node --input-type=module -e 'const j=await(await fetch(process.env.A9_MAINNET_RPC+"/runGetMethod",{method:"POST",headers:{"Content-Type":"application/json","X-API-Key":process.env.TONCENTER_API_KEY},body:JSON.stringify({address:process.env.RC,method:"get_protocol_config",stack:[]})})).json(); console.log(j.result.stack.slice(12,18).map(x=>parseInt(x[1],16)).join("/"))'`
    期望：`43200/129600/3600/24/16/86400`（preview/stake/candleSeconds/candleCount/minQualified/observation）
    失败：任一不符 → **停止**，参数签名与链上不一致，不得开轮
    可逆：否（配置已写入合约）

[ ] 7. TV.get_config().controller == RC
    命令：`node ops/scripts/verify_deployment.mjs --online | grep -iE "teamVault.controller|TV.*controller"`
    期望：`teamVault.controller = <RC>`（相等）
    失败：不相等/未绑定 → **停止**；`InitController` 不可逆，**绝不重复发**
    可逆：**否**

[ ] 8. A9 五笔分发（RC 70 亿 / TV 12 亿 / 内盘 8 亿 / 流动 5 亿 / 营销 5 亿）
    命令：`OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<signer> node ops/scripts/50_fund_vaults.mjs --execute --all --probe 2>&1 | tee "$OPS_RECORDS_DIR/50_fund.log"`
    期望：首笔 1 A9 probe 到账 → 发余量；5 笔 `get_wallet_data` 增量精确匹配；末尾 5 项 `>= 注资额`
    失败：金额/地址不符 → **立即停**；**exit 33** → 回读 5 个钱包+admin：全 0 才重试一次；部分到账按差额手工补（`fund_jetton.tolk <owner> <remainingRaw>`），**禁止整笔重发**（坑②）
    可逆：**否**

[ ] 9. admin 清零 + totalSupply == 100 亿
    命令：`node ops/scripts/verify_deployment.mjs --online | grep -E "total_supply|admin"`
    期望：`total_supply = 10000000000000000000`（100 亿）；admin A9 余额 = 0（或书面保留 gas 额）
    失败：不一致 → **停止**，查 §8 差额；**不要补发整笔**
    可逆：**否**

[ ] 10. Worker 部署（必须 production）
    命令：`cd worker && wrangler secret put ADMIN_TOKEN --env production && wrangler secret put TONCENTER_API_KEY --env production && cd .. && npm run build && cd worker && wrangler deploy --env production --var ROUND_CONTROLLER_ADDRESS:"$PROD_ROUND_CONTROLLER_ADDRESS" --var TEAM_VAULT_ADDRESS:"$PROD_TEAM_VAULT_ADDRESS" --var JETTON_MASTER_ADDRESS:"$PROD_JETTON_MASTER_ADDRESS" --var ORACLE_CONFIG_HASH:"$PROD_ORACLE_CONFIG_HASH"`
    期望：CI 生产门禁通过（`DATA_SOURCE=chain`/`CHAIN_NETWORK=mainnet`/`DEMO_ALLOW_UNSIGNED_WRITES=false`），输出新版本号
    失败：门禁 fail / 仍 demo → **停止**；**禁止不带 `--env production`**；可 `wrangler rollback`
    可逆：是（Worker 可回滚）

[ ] 11. 线上接口验证
    命令：`curl -s https://a9.lat/api/health | jq; curl -s https://a9.lat/api/version | jq '.data.schemaVersion // .schemaVersion'; curl -s https://a9.lat/api/config | jq '.data.p0UsdE8'`
    期望：health ok；`schemaVersion=9`；config 的 P0 等 14 参数与 `get_protocol_config` 一致；rounds 是链上真值
    失败：demo 数据/版本不符 → **停止**，查 `DATA_SOURCE`/地址；**禁止公告**
    可逆：是

[ ] 12. 索引器 tick → 11 个 chain config key → health 无缺键
    命令：`curl -s -X POST https://a9.lat/api/admin/indexer/tick -H "Authorization: Bearer $ADMIN_TOKEN" | jq; curl -s https://a9.lat/api/health | jq '.data.oracle'`
    期望：`paused=false`、`reason=[]`；11 键全落库（p0/roundReward/totalSupply/minStake/maxTotalStake/candleCount/candleSeconds/minQualified/observation/stakeDuration/riskDisclosureVersion）
    失败：仍缺键 → 看 `admin_events` 的 INDEXER_TICK_WARN/ERROR；**先修索引器再公告**
    可逆：是（只读链上重建）

[ ] 13. 开 R1（无 PREVIEW；twap 双人复核）
    命令：`OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<admin> node ops/scripts/80_admin_ops.mjs --action open-round --round 1 --twap24h <USD_E8>`
    期望：`get_round(1).targetPriceUsdE8 == max(2*twap,232000)`；`stakeCloseAt == stakeOpenAt + 129600`；`TargetPriceSet` 事件
    失败：target/时间不符 → **停止并公告**；R1 已开不可重开（终态不可逆）；twap 规则见 docs/29 §8.1
    可逆：**否（已开轮）**

[ ] 14. 部署后 24h 巡检
    命令：`while true; do curl -s https://a9.lat/api/rounds | jq '.[0] | {candlesSeen, observationEnd}'; curl -s https://a9.lat/api/health | jq '.data.oracle.paused'; sleep 3600; done`
    期望：`candlesSeen` 每小时 +1 且单调递增（24 根齐备）；索引器 `paused=false`；结算三笔/告警正常
    失败：K 线停/缺键/卡 SETTLING → 立即 P0（docs/29 §9/§10）；必要时 Pause + 公告
    可逆：—（运维动作）

---

**签字**：部署负责人 ____　复核人（双人）____ / ____　日期 ____　已读不可逆清单（deployer/admin/treasury 三方各签一次）：____
