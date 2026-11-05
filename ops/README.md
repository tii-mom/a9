# ops/ — A9 测试网部署与运营资产

本目录是 A9 协议（引信机制）**测试网阶段**的部署脚本、运营手册、监控告警与密钥/权限操作资产。

- **权威业务口径**：docs/00_DECISIONS_V2.md（V6.2）。本目录不重新定义业务规则；参数与规则冲突时以 docs/00 为准。
- **只写 ops/**：不改 contracts/、web/、worker/、shared/、docs/；需要共享变更先联系 Lead。
- **不含任何真实私钥**：所有敏感信息通过环境变量传入；脚本默认 DRY-RUN。

---

## 1. 快速开始

~~~bash
cd /Users/yu1/Desktop/BAM

# 1) 自测（离线，不需要网络/私钥；约 30 秒）
node ops/scripts/selftest.mjs

# 2) 参数与工具链检查（不发交易）
node ops/scripts/00_preflight.mjs

# 3) 全流程 dry-run 演练（在未部署的空登记表上也能跑通）
node ops/scripts/deploy_all.mjs

# 4) 真实部署（有合约构建产物、参数签字、地址就绪后）
#    详细顺序与注意事项见 runbooks/01_deploy_testnet.md
OPS_EXECUTE=1 node ops/scripts/10_deploy_jetton.mjs --execute
# ... 逐步执行 11 → 20 → 30 → 40 → 70 → 50 → 60
node ops/scripts/verify_deployment.mjs --online --save

# 5) 运营期
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
│   ├── testnet.params.json          唯一参数输入（V6.2；含命令模板、opcodes、监控阈值）
│   ├── testnet.registry.json        地址登记表（唯一事实来源；部署时由脚本写入）
│   ├── testnet.registry.template.json  空登记表模板
│   └── testnet.addresses.template.json 人工填写地址模板（说明用途）
├── scripts/
│   ├── lib/                         共用库（config/log/cli/ton/registry/toolchain/step/verify）
│   ├── 00_preflight.mjs             前置检查（参数/地址/密钥存在性/工具链/钱包）
│   ├── 10_deploy_jetton.mjs         Jetton Master（TEP-74）
│   ├── 11_mint_and_lock_jetton.mjs  初始铸造 100 亿 + 关闭 mint
│   ├── 20_deploy_teamvault.mjs      TeamVault（controller=null 部署）
│   ├── 30_deploy_round_controller.mjs RoundController + 初始化数据
│   ├── 40_init_params.mjs           参数快照 + 链上 get_protocol_config 比对
│   ├── 50_fund_vaults.mjs           注资（70 亿奖励 + 12 亿团队；--all 含 8/5/5 亿分配）
│   ├── 60_verify_and_register.mjs   登记表定稿 + 地址簿生成
│   ├── 70_bind_roles.mjs            TeamVault.InitController（不可逆，双人核对）
│   ├── 80_admin_ops.mjs             最小权限操作（status/开轮/关窗/暂停恢复/结算/提交K线/技术终止）
│   ├── deploy_all.mjs               按 deployPlan 串联（默认 dry-run）
│   ├── verify_deployment.mjs        全量验收（--offline 跳过网络）
│   ├── reconcile.mjs                对账 CSV（支持 --snapshot 离线）
│   ├── monitor_check.mjs            监控告警（支持 --snapshot/--json/--notify）
│   ├── announcement.mjs             七类公告渲染（模板库 templates/announcements.json）
│   └── selftest.mjs                 离线自测（参数/地址/公告/对账/监控/登记表/脚本语法）
├── runbooks/
│   ├── 01_deploy_testnet.md         部署 Runbook（含回滚/重建、常见故障）
│   ├── 02_round_operations.md       10 轮运营手册（8 阶段 SOP + 五条路径）
│   ├── 03_monitoring_alerting.md    监控告警方案（指标/阈值/渠道/值班/事故分级）
│   ├── 04_key_custody_admin.md      单密钥托管与权限操作（紧急暂停/技术终止演练）
│   └── 05_announcements.md          公告与沟通手册（六类/七模板）
├── templates/
│   ├── announcements.json           七类公告模板（中英 + 强制风险提示）
│   ├── reconciliation.csv           对账表模板（与 reconcile.mjs 字段一致）
│   ├── kpi-dashboard.md             KPI 看板字段定义
│   ├── round-schedule.md            10 轮排期模板（含失败同档规则）
│   ├── shift-schedule.csv           值班表模板
│   └── incident-log.csv             事故记录模板
├── drills/                          演练计划/记录（模板 + 开轮前演练清单）
├── records/                         生成产物（对账 CSV、地址簿、公告、验收报告；git 忽略）
└── tests/
    ├── README.md                    夹具说明
    └── fixtures/                    对账/监控离线测试数据（健康 + 故障）
~~~

---

## 3. 交付对照

| 任务交付项 | 对应文件 | 验证方式 |
| --- | --- | --- |
| ① 测试网部署脚本 | scripts/00~70、deploy_all.mjs、lib/* | selftest 的 dry-run 用例 + 01 部署 Runbook |
| ① 地址登记表 | config/testnet.registry.json、addresses.template.json、60 生成地址簿 | 60_verify_and_register + verify_deployment |
| ② 10 轮运营手册（每轮 SOP） | runbooks/02_round_operations.md | 覆盖成功/失败/无人/暂停恢复/技术终止五条路径 |
| ② 六类公告模板 | templates/announcements.json（7 模板）+ runbooks/05 | selftest 渲染 7 类 × 中英 + 风险提示 |
| ② 对账表模板 | templates/reconciliation.csv + reconcile.mjs | selftest reconcile.healthy |
| ② KPI 字段 | templates/kpi-dashboard.md（43 字段） | 人工评审 + 每轮更新 |
| ③ 监控告警方案 | runbooks/03 + monitor_check.mjs | selftest monitor.healthy / monitor.faults |
| ④ 密钥托管与权限手册 | runbooks/04 | 含紧急暂停 SOP、技术终止演练步骤与验收标准 |

---

## 4. 运行模式与安全约定

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| DRY-RUN（默认） | 无环境变量 | 只校验/打印计划，不发请求/交易 |
| EXECUTE | OPS_EXECUTE=1 + 脚本 --execute | 执行链上部署/注资/绑定 |
| 写操作二次确认 | 另加 OPS_CONFIRM=YES | 不可逆操作（InitController/管理员写操作/公告发送） |
| 只读运营 | 无 | monitor/reconcile/announcement（不带发送）/verify --offline 可随时运行 |

**安全红线**：
- 助记词/私钥/API key 只从环境变量或本地 keystore 读取；脚本不打印、不落盘、不写入登记表。
- 不要使用裸私钥（64 位 hex）；优先 Acton 项目钱包（acton wallet import 交互导入）。
- 团队/营销/流动性地址不公开；只在登记表/内部地址簿出现。
- 任何不可逆操作（InitController、暂停、结算、技术终止）必须双人核对并留痕（见 04 手册）。

---

## 5. 单位与参数约定

- 代币金额：raw units 字符串（1 A9 = 1e9）；脚本用 BigInt，禁止浮点。
- 价格：USD_E8 字符串（$0.00116 = 116000）；P0 = 116000，倍数 2（不可变）。
- 时间：链上 Unix 秒；运营文档统一 UTC。
- 关键参数：PREVIEW 86400s、报名 259200s、观察 259200s（18 根 × 14400s，阈值 12）、单轮 604800s、10 轮 6048000s。
- 配置哈希：scripts/lib/config.mjs 对协议关键参数做 canonical JSON + sha256；部署前写入登记表并公示。
- 参数变更后必须重跑：selftest → preflight → dry-run → 重新生成配置哈希。

---

## 6. 已知限制 / 待对接

1. **部署命令模板依赖 contracts/scripts**：当前 ops 的 Acton 命令模板按约定路径编写；contract-dev 交付实际脚本后需核对参数（在 config/testnet.params.json 的 toolchain.commands 中修改模板，不改脚本逻辑）。
2. **chain 适配器尚未实现**：monitor/reconcile 的链上事件级指标（三笔 burn 明细、claim 事件）在 worker 切真链后补齐；当前用 API 汇总 + 链上 total_supply 交叉核对。
3. **技术终止 14 天/7 天不可压缩**：测试网演练需用独立短参数部署（或真实等待），见 04 手册 §8。
4. **Acton 钱包**：部署前需在 contracts/ 下导入项目钱包；00_preflight 会检查但不会读取私钥。
5. **公告发送**：默认只渲染不发送；发送需 TELEGRAM_* + OPS_CONFIRM=YES，且人工审批文案。
6. **真实地址未写入**：testnet.registry.json 初始为 not_deployed（部署时由 10/20/30/60 写入）。

---

## 7. 验证命令

~~~bash
# 全部离线自测（推荐每次改动后运行）
node ops/scripts/selftest.mjs

# 参数/工具链检查
node ops/scripts/00_preflight.mjs

# 编排 dry-run（未部署也可跑通；最后验收步骤会提示预期失败）
node ops/scripts/deploy_all.mjs

# 对账/监控夹具
node ops/scripts/reconcile.mjs --snapshot ops/tests/fixtures/worker-snapshot.json
node ops/scripts/monitor_check.mjs --snapshot ops/tests/fixtures/worker-snapshot.json
node ops/scripts/monitor_check.mjs --snapshot ops/tests/fixtures/worker-snapshot-bad.json   # 期望 exit 2
~~~

---

## 8. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1.0 | 2026-11-05 | 初版：部署脚本、地址登记、10 轮 SOP、监控告警、密钥/权限手册、公告模板、selftest |

---

*维护：testnet-ops。任何参数或合约接口变更，先更新 params/模板，再同步文档与 selftest，最后通知 Lead。*
