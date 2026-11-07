# 08 — 主网上线操作手册（v11，唯一有效版本）

> 取代：docs/06、docs/29、docs/33、ops/runbooks/06、07（均为 v8–v10 口径，含 TeamVault / OracleAdapter / 旧限额，**不要照做**）。
> 玩法：docs/35；合约与哈希：contracts/README.md；参数：ops/config/mainnet.params.json。
> 原则：每一步先 dry-run，核对输出，再 `OPS_EXECUTE=1 OPS_CONFIRM=YES OPS_CONFIRM_MAINNET=YES` 真发；部署类操作两人复核。
> 网络币 TON 已更名 GRAM（下文 GRAM = 原生币，gas 与内盘付款都用它）。

## 0. 上线门禁（全部打勾才进入第 2 节）

- [ ] 外部审计完成，Critical/High 全部修复或书面接受；最终 tag `v11-audit-fixed`
- [ ] 在该 tag 上：`cd contracts && acton test`（全过）、`acton check`（0/0）、`acton build --info` 哈希与 contracts/README 一致
- [ ] 测试网用**生产时序**完成至少 1 轮真实时长回归（keeper / 索引器 / 机器人推送稳定）
- [ ] **生产价格 keeper 就绪**（读官方 STON.fi 池算 1h TWAP 并自动提交 K 线；见 §6，当前缺失）
- [ ] 第 1 节所有值已由创始人填好并复核

## 1. 创始人需要提供的值

| # | 值 | 去处 | 可改？ |
|---|---|---|---|
| 1 | keeper 地址（新热钱包，只放 gas） | `A9_KEEPER_ADDRESS`；GitHub Var `PROD_KEEPER_ADDRESS` | **部署后不可改** |
| 2 | 团队收款地址 | `A9_TEAM_WALLET_ADDRESS`；`PROD_TEAM_WALLET_ADDRESS` | **不可改** |
| 3 | 军饷 publisher 地址（与 keeper 分开的热钱包） | `A9_JUNXIANG_PUBLISHER_ADDRESS` | **不可改** |
| 4 | P0（USD×1e8；当前占位 116000 = $0.00116） | `ops/config/mainnet.params.json` price.p0UsdE8 → 部署传 `A9_DEPLOY_P0_USD_E8` | **不可改** |
| 5 | treasury / deployer 钱包（助记词只走本地环境，不入库） | `TON_TREASURY_ADDRESS`、`TON_DEPLOYER_WALLET` | — |
| 6 | 内盘收款钱包、营销钱包、流动性钱包 | `ops/records/mainnet.registry.json`（内盘地址公开） | — |
| 7 | 内盘兑换比例（默认 1 GRAM = 1000 A9） | `internal_sale.mjs --rate` | 可 |
| 8 | 正式机器人用户名（不带 @） | GitHub Var `PROD_TG_BOT_USERNAME`（Worker var + 前端 `VITE_TG_BOT_USERNAME`） | 可 |
| 9 | 生产 D1 id | GitHub Var `PROD_D1_DATABASE_ID` | — |
| 10 | 生产 secrets | `wrangler secret put --env production`：ADMIN_TOKEN、TONCENTER_API_KEY、TG_BOT_TOKEN、TG_WEBHOOK_SECRET | 可 |
| 11 | Jetton 元数据 URI（默认 https://a9.lat/a9.json，须可访问） | `A9_DEPLOY_METADATA_URI` | **不可改** |
| 12 | 运维告警（可选）：TELEGRAM_OPS_CHAT_ID 等 | mainnet.params.json alerts | 可 |

部署脚本在 `--net` 下会**拒绝**：缺 keeper / publisher / team / P0，或时序为测试快档（stake < 1h、abort/fallback < 1 天）。

## 2. 部署前（D-1）

```bash
git checkout v11-audit-fixed
export OPS_PARAMS=ops/config/mainnet.params.json
node ops/scripts/selftest.mjs            # 49/49
node ops/scripts/00_preflight.mjs        # 环境、参数、钱包、工具链
cd contracts && acton script scripts/deploy-emulation.tolk   # 本地仿真；写 deploy/*.emulation.addr，不碰正式地址
```

核对仿真输出：时序为 `preview=43200 stake=129600 candle=3600 count=24 minQ=16 abortTimeout=604800`，fallbackUnlock 2592000，minStake 1,000 A9，`p0UsdE8` 为第 1 节的值。

## 3. 部署（D0）

1. 给 deployer 准备 GRAM（按 mainnet.params.json deployer 预算）。
2. 部署全部合约（JettonMaster → mint 100 亿 → RoundController → RC 注资 82 亿 → JunxiangDistributor）：
   ```bash
   OPS_EXECUTE=1 OPS_CONFIRM=YES OPS_CONFIRM_MAINNET=YES node ops/scripts/15_deploy_contracts.mjs
   ```
   期望日志：`JettonMaster minted 100e9 A9 ... mint is now permanently closed`、`Funded RC Jetton Wallet with 8200000000000000000 raw A9 (balance verified ...)`、ticket code hash = StakeTicket 哈希、`get_distributor publisher=<#3>`。
3. 核对：`node ops/scripts/60_verify_and_register.mjs`（地址、哈希、RC 余额 82 亿、get_protocol_state 时序）。
4. 分配：`node ops/scripts/50_fund_vaults.mjs --all`（内盘 8 亿 / 流动性 5 亿 / 营销 5 亿；首笔 1 A9 试探）。
5. GRAM gas：`node ops/scripts/55_fund_ton.mjs`（RC ≥ 20、keeper ≥ 预算）。

## 4. 链下上线

1. GitHub Variables：`PROD_ROUND_CONTROLLER_ADDRESS`、`PROD_JETTON_MASTER_ADDRESS`、`PROD_JUNXIANG_DISTRIBUTOR_ADDRESS`、`PROD_KEEPER_ADDRESS`、`PROD_TEAM_WALLET_ADDRESS`、`PROD_ORACLE_CONFIG_HASH`、`PROD_D1_DATABASE_ID`、`PROD_TG_BOT_USERNAME`。CI 门禁缺任一项会失败。
2. secrets（第 1 节 #10），然后跑 CI 的 production 部署（会先 apply D1 migrations）。
3. 机器人：BotFather `/newapp`（URL `https://a9.lat/app`，短名 `app`），然后：
   ```bash
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://a9.lat/api/admin/tg/setup
   ```
   返回 webhook ok、menu ok、info.url = `https://a9.lat/api/tg/webhook`。
4. 检查：`https://a9.lat/tonconnect-manifest.json` 的 url 为 `https://a9.lat`；钱包登录一次并确认登录成功（数据库 `auth_nonces.used_at` 有值）。

## 5. 流动性与内盘

1. 内盘：买家付 GRAM 到内盘钱包（附言 = 收 A9 地址），发放：
   ```bash
   node ops/scripts/internal_sale.mjs --wallet <内盘钱包> --rate <比例>            # 预览
   OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/internal_sale.mjs --wallet <内盘钱包> --rate <比例> --signer <内盘钱包名>
   ```
   按到账金额发放；重跑不会重复发；累计超 8 亿拒绝。
2. STON.fi 官方池（v2.2，主网 UI 建池）：冷启动按 mainnet.params.json liquidity（2 亿 A9 + 等值）。建好后把池地址填入生产 var `STONFI_POOL_ADDRESS` 并重新部署 Worker。
3. 小额实测一键上车与赠送（受益人）各 1 次，再对外公布。

## 6. 开轮与日常（keeper）

- **生产价格 keeper（缺失，上线阻断项）**：现有 `keeper-candles.mjs` 只有测试模式（--mode success/failure），不能用于主网。需要：定时采样官方池储备 → 每小时算 TWAP（USD×1e8）与数据摘要 → `SubmitCandle`；开轮时算 24h TWAP → `OpenRound`；失联告警。
- 手动兜底：`80_admin_ops.mjs --action submit-candle --twap <USD_E8> --digest <64hex>`（runbook 02）。
- 团队额度：`80_admin_ops.mjs --action release-team`（第 10 城后 30 天任何人可释放最后一笔）。
- 军饷：每周 compute → 先充值分发合约 → `junxiang-set-root`。

## 7. 上线后 24 小时

- 监控：keeper 心跳与余额、索引器延迟、RC 余额对账、机器人推送；告警配置见 runbook 03。
- 首轮第一个 K 线提交后人工复核 TWAP 与摘要。
