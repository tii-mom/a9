# ops/ — A9 测试网部署与运营资产

本目录是 A9 协议（引信机制）**测试网阶段**的部署脚本、运营手册、监控告警与密钥/权限操作资产。

- **权威业务口径**：docs/00_DECISIONS_V2.md（V7 时间参数）。本目录不重新定义业务规则；参数与规则冲突时以 docs/00 为准。
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

# 4) 真实部署（推荐整体 deploy-emulation：Jetton + mint + TV + RC + 绑定）
#    详细顺序与注意事项见 runbooks/01_deploy_testnet.md
OPS_EXECUTE=1 node ops/scripts/15_deploy_contracts.mjs --execute
OPS_EXECUTE=1 node ops/scripts/65_set_jetton_wallets.mjs --execute --query-only   # 只查询/登记三地址
node ops/scripts/70_bind_roles.mjs --mark-bound-only                              # 15 已 InitController，只记录
# ... 然后 40 → 55 → 50 → 60 → verify_deployment → 80 open-round R1
node ops/scripts/verify_deployment.mjs --online --save
# ↑ 默认 STRICT：开轮前必检项必须全部 PASS；FAIL 时禁止开 R1。
#   --lenient 仅排查用，输出不得作为开轮或上线依据。

# 备选：Jetton 分步（位置参数；TV/RC 仍用 15 整体部署）
# node ops/scripts/10_deploy_jetton.mjs --execute
# node ops/scripts/11_mint_and_lock_jetton.mjs --execute

# 4.1) 发布/开轮门禁（verify_deployment 默认 STRICT）
#   - 开轮前必检项必须全部 PASS：协议配置 17 项、Jetton Wallet code hash、
#     TeamVault pending 清零（get_round_state 1..10 枚举）、TeamVault.controller=RC、注资登记等。
#   - getter 缺失 / 返回栈异常 / 必检分支未执行（gate.missing）一律 FAIL。
#   - code hash 不一致 = 线上实例与 contracts/build 不一致（通常未重部署）→ 必须重部署后再开轮。
#   - --lenient 只用于排查，输出不得作为开轮或上线依据；--offline 不覆盖链上状态。

# 5) 运营期
node ops/scripts/80_admin_ops.mjs --action submit-candle --round 1 --candle 0 --twap 232000 --digest <64hex> --observation-start <unix>  # K 线 dry-run
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
│   ├── testnet.params.json          唯一参数输入（V7；含命令模板、opcodes、监控阈值）
│   ├── testnet.registry.json        地址登记表（唯一事实来源；部署时由脚本写入）
│   ├── testnet.registry.template.json  空登记表模板
│   └── testnet.addresses.template.json 人工填写地址模板（说明用途）
├── scripts/
│   ├── lib/                         共用库（config/log/cli/ton/registry/toolchain/step/verify）
│   ├── 00_preflight.mjs             前置检查（参数/地址/密钥存在性/工具链/钱包）
│   ├── 10_deploy_jetton.mjs         Jetton Master（分步；位置参数；产物 build/JettonMaster.json）
│   ├── 11_mint_and_lock_jetton.mjs  分步 mint-once（op 0x15，同笔 admin 置 null）
│   ├── 15_deploy_contracts.mjs      整体部署 deploy-emulation（Jetton+mint+TV+RC+SetJettonWallet+InitController）
│   ├── 20_deploy_teamvault.mjs      TeamVault（整体部署已覆盖；仅 --adopt/核对）
│   ├── 30_deploy_round_controller.mjs RoundController（整体部署已覆盖；仅 --adopt/核对）
│   ├── 40_init_params.mjs           参数快照 + 链上 get_protocol_config 比对
│   ├── 55_fund_ton.mjs              TON gas 充值（RC ≥20 / TV ≥10）
│   ├── 65_set_jetton_wallets.mjs    SetJettonWallet(0x52540016)：RC/TV 绑定 canonical Jetton Wallet
│   ├── 50_fund_vaults.mjs           注资（70 亿奖励 + 12 亿团队；--all 含 8/5/5 亿分配）
│   ├── 60_verify_and_register.mjs   登记表定稿 + 地址簿生成
│   ├── 70_bind_roles.mjs            TeamVault.InitController（不可逆，双人核对）
│   ├── 80_admin_ops.mjs             最小权限操作（status/开轮/关窗/暂停恢复/结算/提交K线/技术终止）
│   ├── deploy_all.mjs               按 deployPlan 串联（默认 dry-run）
│   ├── verify_deployment.mjs        全量验收（默认 STRICT；--offline 跳过网络；--lenient 仅排查）
│   ├── reconcile.mjs                对账 CSV（支持 --snapshot 离线）
│   ├── monitor_check.mjs            监控告警（支持 --snapshot/--json/--notify）
│   ├── announcement.mjs             七类公告渲染（模板库 templates/announcements.json）
│   └── selftest.mjs                 离线自测（参数/地址/公告/对账/监控/登记表/脚本语法）
├── runbooks/
│   ├── 01_deploy_testnet.md         部署 Runbook（含回滚/重建、常见故障）
│   ├── 02_round_operations.md       10 轮运营手册（8 阶段 SOP + 五条路径）
│   ├── 03_monitoring_alerting.md    监控告警方案（指标/阈值/渠道/值班/事故分级）
│   ├── 04_key_custody_admin.md      单密钥托管与权限操作（紧急暂停/技术终止演练）
│   ├── 05_announcements.md          公告与沟通手册（六类/七模板）
│   └── 06_mainnet_admin.md          主网 admin 权限与多签方案（调研结论：推荐 Multisig v2 2-of-3）
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
| ① 测试网部署脚本 | scripts/00~90（含 15 整体部署、55/65）、deploy_all.mjs（whole/jetton 模式）、lib/* | selftest 的 dry-run 用例 + 01 部署 Runbook |
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
- 关键参数：PREVIEW 43200s/12h（R1 无 PREVIEW）、报名 129600s/36h、观察 86400s/24h（24 根 × 3600s，阈值 16；24 根齐备后 ≥16 成功、≤15 失败）、单轮 259200s/72h、10 轮 2592000s/30 天。
- 质押限额：单笔 ≥10,000 A9；单地址固定硬顶 20,000,000 A9（contracts/README §9.1）；本轮 ≤200,000,000 A9。
- 流动性：5 亿 A9 额度；冷启动池 2 亿 A9 + $232,000 USDT（同价 $0.00116，占 40%，剩余 3 亿后续加池）。
- TON gas：RC ≥20 TON、TeamVault ≥10 TON（每条跨合约指令约 0.05 TON）。
- Jetton：mint-once op 0x00000015，金额 1e19，同笔交易 admin 置 null（mintable=false，二次 mint 报 MintClosed(75)）；burn_notification 标准 op 0x7bdd97de。
- 配置哈希：scripts/lib/config.mjs 对协议关键参数做 canonical JSON + sha256；部署前写入登记表并公示。
- 参数变更后必须重跑：selftest → preflight → dry-run → 重新生成配置哈希。

---

## 6. 已知限制 / 待对接

1. **部署命令模板已与真实脚本对齐**：Acton script 只接受位置参数；deploy-emulation.tolk 是整体顺序部署（无分步子命令）。测试网走 15_deploy_contracts.mjs；分步只保留 Jetton 两步（10/11，位置参数）。注资/TON 充值/OpenRound 已接线 fund_jetton / fund_ton / admin_op：A9_SIGNER_WALLET 指定签名钱包，OPS_EXECUTE=1 + OPS_CONFIRM=YES 才广播，真实网络由模板带 --net testnet；本地验证广播可加 OPS_ALLOW_EMULATION=true。
2. **与 contract README 的实现差异**：无独立 StakingVault/RewardVault（RC 单 Jetton Wallet）；单地址固定硬顶 20M；24 根后 <16 即失败；R1 无 PREVIEW 需手动开轮；SetJettonWallet 一次性；测试网 BurnAck 由 jettonMaster 充当 ack 权威（主网阻塞项）。详见 runbooks/01 §8.1 与 02 §12。
3. **chain 适配器尚未实现**：monitor/reconcile 的链上事件级指标（三笔 burn 明细、claim 事件）在 worker 切真链后补齐；当前用 API 汇总 + 链上 total_supply 交叉核对。
4. **BurnAck 信任模型**：测试网由部署方 jettonMaster 地址充当 ack 权威；主网前必须改为受审计扩展或“标准 burn + 链下对账 + 单密钥 owner 确认”。
5. **晚开窗兜底**：keeper 错过 36h 报名窗口时 OpenRound 重锚 stakeOpenAt；监控三倒计时，异常即公告。
6. **技术终止 14 天/7 天不可压缩**：测试网演练需用独立短参数部署（或真实等待），见 04 手册 §8。
7. **Acton 钱包**：部署前需在 contracts/ 下导入项目钱包；00_preflight 会检查但不会读取私钥。
8. **公告发送**：默认只渲染不发送；发送需 TELEGRAM_* + OPS_CONFIRM=YES，且人工审批文案。
9. **真实地址未写入**：testnet.registry.json 初始为 not_deployed（整体部署由 15 解析写入；分步由 10/11/20/30/65/70 与 50/60 写入）。

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
