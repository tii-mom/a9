# ops/ — A9 测试网部署与运营资产（v10）

本目录是 A9 协议（引信机制）**测试网阶段**的部署脚本、运营手册、监控告警与密钥托管资产。合约为 v10（D-42）：3 个合约，无 admin，单 keeper 热钱包运营。

- **权威业务口径**：docs/00_DECISIONS_V2.md 的 D-42；contracts/README.md（v10 ABI）；docs/34_V10_MIGRATION.md（下游改造清单）。参数与规则冲突时以 docs/00 与 contracts/README 为准。
- **只写 ops/**：不改 contracts/、web/、worker/、shared/、docs/；需要共享变更先联系 Lead。
- **不含任何真实私钥**：所有敏感信息通过环境变量传入；脚本默认 DRY-RUN。

---

## 1. 快速开始

~~~bash
cd /Users/yu1/Desktop/BAM

# 1) 自测（离线，不需要网络或私钥；约 30 秒）
node ops/scripts/selftest.mjs

# 2) 参数与工具链检查（不发交易）
node ops/scripts/00_preflight.mjs

# 3) 全流程 dry-run（在未部署的空登记表上也能跑通）
node ops/scripts/deploy_all.mjs

# 4) 真实部署（整体 deploy-emulation：JettonMaster + mint-once + RC + 钱包推导校验 + 82 亿注资）
#    详细顺序与注意事项见 runbooks/01_deploy_testnet.md
OPS_EXECUTE=1 node ops/scripts/15_deploy_contracts.mjs --execute
node ops/scripts/40_init_params.mjs --execute --online
OPS_CONFIRM=YES node ops/scripts/55_fund_ton.mjs --execute
OPS_CONFIRM=YES node ops/scripts/50_fund_vaults.mjs --execute --all
node ops/scripts/60_verify_and_register.mjs --execute
node ops/scripts/verify_deployment.mjs --online --save
# ↑ 默认 STRICT：开轮前必检项必须全部 PASS；FAIL 时禁止开 R1。
#   --lenient 仅排查用，输出不得作为开轮或上线依据。
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<keeper> node ops/scripts/80_admin_ops.mjs --action open-round --round 1 --twap24h <USD_E8>

# 备选：Jetton 分步（位置参数；RC 仍用 15 整体部署）
# node ops/scripts/10_deploy_jetton.mjs --execute
# node ops/scripts/11_mint_and_lock_jetton.mjs --execute

# 5) 运营期
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<keeper> node ops/scripts/80_admin_ops.mjs --action submit-candle --round 1 --candle 0 --twap 232000 --digest <64hex> --observation-start <unix>   # 先 dry-run
node ops/scripts/monitor_check.mjs                    # 监控（只读）
node ops/scripts/reconcile.mjs --chain                # 对账（只读）
node ops/scripts/announcement.mjs --type open --round 1 --lang both   # 公告渲染
~~~

---

## 2. 目录结构

~~~text
ops/
├── README.md                        本文件（索引与使用说明）
├── .gitignore                       忽略 records/ 生成产物
├── config/
│   ├── testnet.params.json          唯一参数输入（v10；含命令模板、opcodes、监控阈值）
│   ├── testnet.registry.json        地址登记表（唯一事实来源；部署时由脚本写入）
│   ├── testnet.registry.template.json  空登记表模板
│   ├── testnet.addresses.template.json 人工填写地址模板（说明用途）
│   └── archive/v8.9/                旧版（v8.x）登记表，只作历史
├── scripts/
│   ├── lib/                         共用库（config / log / cli / ton / registry / toolchain / step / verify）
│   ├── 00_preflight.mjs             前置检查（参数、地址、密钥存在性、工具链、钱包）
│   ├── 10_deploy_jetton.mjs         JettonMaster（分步备选；位置参数；产物 build/JettonMaster.json）
│   ├── 11_mint_and_lock_jetton.mjs  分步 mint-once（同一笔交易关闭铸造）
│   ├── 15_deploy_contracts.mjs      整体部署 deploy-emulation：JettonMaster + mint-once + RC + 钱包推导校验 + 82 亿注资（forward 0）
│   ├── 30_deploy_round_controller.mjs RC（整体部署已覆盖；仅 --adopt 与核对）
│   ├── 40_init_params.mjs           参数快照 + 链上 get_protocol_config 比对（只读）
│   ├── 55_fund_ton.mjs              TON gas 充值（RC ≥ 20、keeper ≥ 2）
│   ├── 50_fund_vaults.mjs           注资登记；--all 另转内盘 8 亿、流动性 5 亿、营销 5 亿（首笔 1 A9 试探）
│   ├── 60_verify_and_register.mjs   登记表定稿 + 地址簿生成
│   ├── 80_admin_ops.mjs             keeper 与公共操作（status / open-round / submit-candle / close-staking / abort-technical / retry-settlement）
│   ├── keeper-candles.mjs           keeper 循环：只发 OpenRound / CloseStaking / SubmitCandle；见到 SettlementBounced 调用 RetrySettlement
│   ├── 90_mainnet_ceremony.mjs      主网仪式 P0 ~ P6（--dry-run 不发网络写操作）
│   ├── deploy_all.mjs               按 deployPlan 串联（默认 whole；--mode jetton；默认 dry-run）
│   ├── verify_deployment.mjs        全量验收（默认 STRICT；--offline 跳过网络；--lenient 仅排查）
│   ├── reconcile.mjs                对账 CSV（RC 钱包公式、供应量；支持 --snapshot 离线）
│   ├── monitor_check.mjs            监控告警（支持 --snapshot / --json / --notify）
│   ├── announcement.mjs             公告渲染（模板库 templates/announcements.json）
│   └── selftest.mjs                 离线自测（参数、地址、公告、对账、监控、登记表、脚本语法）
├── runbooks/
│   ├── 01_deploy_testnet.md         部署 Runbook（整体部署、回滚与重建、常见故障）
│   ├── 02_round_operations.md       10 轮运营手册（SOP 与五条路径）
│   ├── 03_monitoring_alerting.md    监控告警方案（指标、阈值、渠道、值班、事故分级）
│   ├── 04_key_custody_admin.md      测试网密钥托管与 keeper 操作（技术终止演练）
│   ├── 05_announcements.md          公告与沟通手册
│   └── 06_mainnet_admin.md          主网 keeper 与资金钱包权限（无 admin）
├── templates/
│   ├── announcements.json           公告模板（中英 + 强制风险提示）
│   ├── reconciliation.csv           对账表模板（与 reconcile.mjs 字段一致）
│   ├── kpi-dashboard.md             KPI 看板字段定义
│   ├── round-schedule.md            10 轮排期模板（含失败同档规则）
│   ├── shift-schedule.csv           值班表模板
│   └── incident-log.csv             事故记录模板
├── drills/                          演练计划与记录（模板 + 开 R1 前演练清单）
├── records/                         生成产物（对账 CSV、地址簿、公告、验收报告；git 忽略）
└── tests/
    ├── README.md                    夹具说明
    └── fixtures/                    对账与监控离线测试数据（健康 + 故障）
~~~

---

## 3. 交付对照

| 任务交付项 | 对应文件 | 验证方式 |
| --- | --- | --- |
| ① 测试网部署脚本 | scripts/00、15、40、50、55、60、80、90，deploy_all.mjs，lib/* | selftest 的 dry-run 用例 + 01 部署 Runbook |
| ① 地址登记表 | config/testnet.registry.json、addresses.template.json、60 生成地址簿 | 60_verify_and_register + verify_deployment |
| ② 10 轮运营手册（每轮 SOP） | runbooks/02_round_operations.md | 覆盖成功、失败、无人质押、技术终止、结算重试五条路径 |
| ② 公告模板 | templates/announcements.json + runbooks/05 | selftest 渲染各类 × 中英 + 风险提示 |
| ② 对账表模板 | templates/reconciliation.csv + reconcile.mjs | selftest reconcile.healthy |
| ② KPI 字段 | templates/kpi-dashboard.md | 人工评审 + 每轮更新 |
| ③ 监控告警方案 | runbooks/03 + monitor_check.mjs | selftest monitor.healthy / monitor.faults |
| ④ 密钥托管与 keeper 操作手册 | runbooks/04 | 含 keeper 失联应急、技术终止演练步骤与验收标准 |
| ⑤ 主网 keeper 与资金钱包权限 | runbooks/06 + runbooks/07 | 人工评审；主网仪式 90 --dry-run |

---

## 4. 运行模式与安全约定

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| DRY-RUN（默认） | 无环境变量 | 只校验并打印计划，不发请求或交易 |
| EXECUTE | OPS_EXECUTE=1 + 脚本 --execute | 执行链上部署、注资或 keeper 操作 |
| 写操作二次确认 | 另加 OPS_CONFIRM=YES | 不可逆操作（注资、开轮、提交 K 线、公告发送） |
| 只读运营 | 无 | monitor、reconcile、announcement（不带发送）、verify --offline 可随时运行 |

**安全红线**：

- 助记词、私钥、API key 只从环境变量或本地 keystore 读取；脚本不打印、不落盘、不写入登记表。
- 不要使用裸私钥（64 位 hex）；优先 Acton 项目钱包（acton wallet import 交互导入）。
- 团队、营销、流动性、内盘地址不公开；只在登记表和内部地址簿出现。
- 任何不可逆操作（注资、开轮、提交 K 线、技术终止、重试结算）必须双人核对并留痕（见 04）。
- keeper 钱包只放 gas，不放 A9。

---

## 5. 单位与参数约定

- 代币金额：raw 字符串（1 A9 = 1e9）；脚本用 BigInt，禁止浮点。
- 价格：USD_E8 字符串（$0.00116 = 116000）；P0 = 116000，倍数 2。目标价 = max(P0 × 2^tier, 2 × 24h TWAP)。
- 时间：链上 Unix 秒；运营文档统一 UTC。
- 关键参数：
  - PREVIEW 12h（43200s），R1 无预告期；
  - 报名 36h（129600s）；
  - 观察 24 根 × 1h（每根 3600s），阈值 16：第 24 根提交即判定，≥ 16 成功，≤ 15 失败；
  - 单轮约 72h，10 轮约 30 天；
  - 技术终止：观察应结束后 7 天，或预告结束后 7 天。
- 质押限额：单笔 ≥ 100,000 A9；单地址每轮固定上限 2,000 万 A9；本轮 ≤ 2 亿 A9。
- 奖励与团队：每轮奖励池 7 亿 A9；团队额度 1.2 亿 A9（成功轮 RC 直接转 teamWallet）。
- 初始分配：mint 100 亿到 treasury；RC 82 亿（70 亿奖励池 + 12 亿团队额度，forward 0）；内盘 8 亿、流动性 5 亿、营销 5 亿。
- 流动性：5 亿 A9 额度；冷启动池 2 亿 A9 + $232,000 USDT（同价 $0.00116，占 40%，剩余 3 亿后续加池）。
- TON gas：RC ≥ 20 TON；keeper ≥ 2 TON。
- Jetton：mint-once op 0x00000015，金额 1e19，同一笔交易关闭铸造（mintable = false，二次 mint 报 MintClosed(75)）；burn_notification 标准 op 0x7bdd97de。
- 配置哈希：scripts/lib/config.mjs 对协议关键参数做 canonical JSON + sha256；部署前写入登记表并公示。
- 参数变更后必须重跑：selftest → preflight → dry-run → 重新生成配置哈希。

---

## 6. 已知限制与待对接

1. **部署命令模板**：Acton script 只接受位置参数。deploy-emulation.tolk 是整体顺序部署，没有分步子命令。测试网走 15_deploy_contracts.mjs；分步只保留 Jetton 两步（10、11）。keeper 操作与注资通过 fund_jetton、fund_ton、admin_op 脚本执行：A9_SIGNER_WALLET 指定签名钱包，OPS_EXECUTE=1 与 OPS_CONFIRM=YES 才广播。本地验证广播可加 OPS_ALLOW_EMULATION=true。
2. **keeper 不可更换**：keeper 地址在部署时写入 RC，合约没有 setAdmin 或 setKeeper。keeper 泄露只能整套重建（见 04 §9、01 §9）。
3. **结算退回**：结算转账或销毁在第一跳被退回时，合约发出 SettlementBounced，需调用 RetrySettlement；UnexpectedBounce 需人工核查。
4. **链上事件级指标**：monitor 与 reconcile 的事件级指标（销毁明细、领取事件、退回事件）依赖 worker 索引器；过渡期用 API 汇总加链上 total_supply 交叉核对。
5. **夹具待改写**：ops/tests/fixtures/ 中的数据仍是 v8.9 字段，改写前不能作为 v10 验收依据（见 tests/README）。
6. **脚本待对齐**：ops/scripts 下的脚本与本文档同步改写中；以脚本的 --help 与 selftest 结果为准。
7. **Acton 钱包**：部署前需在 contracts/ 下导入项目钱包；00_preflight 会检查，但不会读取私钥。
8. **公告发送**：默认只渲染不发送；发送需 TELEGRAM_* 与 OPS_CONFIRM=YES，且人工审批文案。
9. **真实地址未写入**：testnet.registry.json 初始为 not_deployed。整体部署由 15 写入；分步由 10、11、30 与 50、60 写入。

---

## 7. 验证命令

~~~bash
# 全部离线自测（每次改动后运行）
node ops/scripts/selftest.mjs

# 参数与工具链检查
node ops/scripts/00_preflight.mjs

# 编排 dry-run（未部署也可跑通；最后的验收步骤会提示预期失败）
node ops/scripts/deploy_all.mjs

# 对账与监控夹具
node ops/scripts/reconcile.mjs --snapshot ops/tests/fixtures/worker-snapshot.json
node ops/scripts/monitor_check.mjs --snapshot ops/tests/fixtures/worker-snapshot.json
node ops/scripts/monitor_check.mjs --snapshot ops/tests/fixtures/worker-snapshot-bad.json   # 期望 exit 2
~~~

---

## 8. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1.0 | 2026-11-05 | 初版：部署脚本、地址登记、10 轮 SOP、监控告警、密钥与权限手册、公告模板、selftest |
| 0.2.0 | 2026-11-06 | v10（D-42）：合约改为 JettonMaster + JettonWallet + RoundController 三个合约，无 admin，单 keeper；删除团队合约与预言机合约相关脚本和步骤；部署改为 15 整体部署（82 亿，forward 0）；运营改为 keeper 开轮与提交 K 线，判定在第 24 根；结算退回改用 RetrySettlement；监控与对账口径同步更新；06 改为主网 keeper 与资金钱包权限 |

---

*维护：testnet-ops。任何参数或合约接口变更，先更新参数与模板，再同步文档与 selftest，最后通知 Lead。*
