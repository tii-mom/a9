# ops/ — A9 测试网部署与运营资产（v11）

本目录是 A9 协议（引信机制）**测试网阶段**的部署脚本、运营手册、监控告警与密钥托管资产。合约为 v11（docs/35 D-43 ~ D-50）：JettonMaster + JettonWallet + RoundController（+ StakeTicket 攻城令）+ JunxiangDistributor（+ ClaimRecord 军饷领取）。无 admin，单 keeper 热钱包运营。

- **权威口径**：docs/35_GAMEPLAY_V11.md；contracts/README.md（v11 ABI、部署步骤、代码哈希、§7.1 军饷分发）。参数与规则冲突时以 docs/35 与 contracts/README 为准。
- **只写 ops/**：不改 contracts/*.tolk、contracts/tests、web/、worker/src、docs/；`ops/runbooks/`、`ops/drills/` 由文档组维护。
- **不含任何真实私钥或助记词**：所有敏感信息只通过环境变量或 Acton 项目钱包（本地 keystore）传入；脚本默认 DRY-RUN。

---

## 1. 快速开始

~~~bash
cd <repo root>

# 1) 离线自测（不联网、不用私钥）
node ops/scripts/selftest.mjs

# 2) 参数与工具链检查（不发交易）
node ops/scripts/00_preflight.mjs

# 3) 全流程 dry-run（未部署也能跑通）
node ops/scripts/deploy_all.mjs
~~~

### 1.1 测试网真实部署顺序（生产时序）

环境变量只放在当前 shell，不写入文件；钱包用 `acton wallet import` 交互导入（contracts/ 目录下）。

~~~bash
# 0) 必填：keeper / teamWallet 写入 RC 初始数据，部署后永久不可改
export A9_KEEPER_ADDRESS=<keeper 测试网地址>
export A9_TEAM_WALLET_ADDRESS=<teamWallet 测试网地址>
# 可选：军饷 publisher（默认 = keeper）
export A9_JUNXIANG_PUBLISHER_ADDRESS=<publisher 测试网地址>
export TON_DEPLOYER_WALLET=<acton 钱包名>        # 部署者（mint-once 与注资）
export A9_SIGNER_WALLET=<acton 钱包名>           # 广播签名钱包（keeper 操作用 keeper 钱包）

node ops/scripts/00_preflight.mjs                 # 必须无阻断项
node ops/scripts/15_deploy_contracts.mjs --execute   # = OPS_EXECUTE=1；JettonMaster → mint-once → RC → 82 亿注资 → JunxiangDistributor（不注资）→ 读回 ticket hash / get_distributor
node ops/scripts/40_init_params.mjs --execute --online   # get_protocol_config 逐项比对 + RC.get_ticket_code_hash
OPS_CONFIRM=YES node ops/scripts/55_fund_ton.mjs --execute          # RC ≥ 20 TON、keeper ≥ 2 TON
OPS_CONFIRM=YES node ops/scripts/50_fund_vaults.mjs --execute --probe --all   # 内盘 8 亿 / 流动性 5 亿 / 营销 5 亿（RC 82 亿已由部署注资，只核对）
node ops/scripts/60_verify_and_register.mjs --execute              # 登记表定稿 + 地址簿
node ops/scripts/verify_deployment.mjs --online --save             # STRICT：必检项全部 PASS 才允许开轮

# 军饷分发：注资 publisher 不需要；分发合约 A9 钱包由运维充值（见 §5.3）。
# 开第一轮（keeper，--twap24h 为开窗 24h TWAP，USD_E8）
OPS_CONFIRM=YES A9_SIGNER_WALLET=<keeper> node ops/scripts/80_admin_ops.mjs --action open-round --round 1 --twap24h <USD_E8> --execute
~~~

### 1.2 快测档（10 轮约 11 小时）

快测档只用于测试网演练：PREVIEW 600s、报名 1800s、K 线 60s × 24、阈值 16、技术终止超时 900s。参数文件是 `ops/config/testnet-fast.params.json`。

~~~bash
OPS_PARAMS=ops/config/testnet-fast.params.json node ops/scripts/15_deploy_contracts.mjs --execute
~~~

时序环境变量（deploy-emulation.tolk 读取；15 会用参数文件的值自动填充，显式设置的环境变量优先）：

| 环境变量 | 含义 | 生产档默认 | 快测档 |
| --- | --- | --- | --- |
| `A9_TIMING_PREVIEW_SECONDS` | PREVIEW（预告） | 43200 | 600 |
| `A9_TIMING_STAKE_SECONDS` | 报名窗口 | 129600 | 1800 |
| `A9_TIMING_CANDLE_SECONDS` | 单根 K 线周期 | 3600 | 60 |
| `A9_TIMING_CANDLE_COUNT` | 观察根数 | 24 | 24 |
| `A9_TIMING_MIN_QUALIFIED` | 达标阈值（≥ 根数一半且 ≤ 根数） | 16 | 16 |
| `A9_TIMING_ABORT_TIMEOUT_SECONDS` | 技术终止超时（观察 / 预告共用） | 604800 | 900 |
| `A9_TIMING_OBSERVATION_SECONDS` | 可选；必须等于 候选 × 根数，不一致即失败 | — | 1440（可不设） |

直接调用 Acton（不经 15）时同样生效：

~~~bash
cd contracts && A9_TIMING_PREVIEW_SECONDS=600 A9_TIMING_STAKE_SECONDS=1800 A9_TIMING_CANDLE_SECONDS=60 \
  A9_TIMING_CANDLE_COUNT=24 A9_TIMING_MIN_QUALIFIED=16 A9_TIMING_ABORT_TIMEOUT_SECONDS=900 \
  acton script --net testnet scripts/deploy-emulation.tolk
~~~

快测档的保护：`validateParams` 只允许 `network.net = testnet`、`chainId = -3`；主网参数文件带 fast-cycle 会直接报错。配置哈希包含时序档位，快测与生产哈希不同。

---

## 2. 目录结构

~~~text
ops/
├── README.md                          本文件（索引与使用说明）
├── Makefile                           make -f ops/Makefile selftest / preflight / dryrun / verify / reconcile / monitor / announce
├── config/
│   ├── testnet.params.json            唯一参数输入（v11 生产时序；命令模板、opcodes、军饷、监控阈值）
│   ├── testnet-fast.params.json       快测档（fast-cycle）：仅测试网演练，§1.2
│   ├── mainnet.params.json            主网参数（BLOCKED_PENDING_AUDIT：未审计前不得执行）
│   ├── ceremony.params.json / prodtest.params.json / ceremony-rehearsal.params.json   仪式与演练参数（同口径）
│   ├── testnet.registry.json          地址登记表（唯一事实来源；部署时由脚本写入）
│   ├── testnet.registry.template.json 空登记表模板（v11 键）
│   ├── testnet.addresses.template.json 人工填写地址模板（说明用途）
│   └── archive/v8.9/                  旧版登记表，只作历史
├── scripts/
│   ├── lib/                           共用库（config / log / cli / ton / registry / toolchain / step / verify / ledger）
│   ├── 00_preflight.mjs               前置检查（参数、地址、密钥存在性、工具链、钱包）
│   ├── 10_deploy_jetton.mjs           JettonMaster（分步备选）
│   ├── 11_mint_and_lock_jetton.mjs    分步 mint-once（同一笔交易关闭铸造）
│   ├── 15_deploy_contracts.mjs        整体部署 deploy-emulation：JettonMaster + mint-once + RC + 82 亿注资 + JunxiangDistributor（不注资）
│   ├── 30_deploy_round_controller.mjs RC 初始数据快照（核对清单）+ --adopt 登记
│   ├── 40_init_params.mjs             参数快照 + get_protocol_config 比对 + get_ticket_code_hash（--online）
│   ├── 55_fund_ton.mjs                TON gas 充值（RC ≥ 20、keeper ≥ 2）
│   ├── 50_fund_vaults.mjs             注资核对；--all 另转内盘 8 亿、流动性 5 亿、营销 5 亿（首笔 1 A9 试探）
│   ├── 60_verify_and_register.mjs     登记表定稿 + 地址簿生成
│   ├── 80_admin_ops.mjs               keeper / 公共操作：status / open-round / close-staking / submit-candle / abort-technical / retry-settlement / release-team / junxiang-set-root
│   ├── keeper-candles.mjs             keeper 循环（快测 / 演练）：OpenRound / CloseStaking / SubmitCandle / RetrySettlement（失败轮销毁）
│   ├── fasttest-runner.mjs            10 轮用户侧演练：质押（含低于 1,000 A9 的退款探针）+ TicketClaim
│   ├── 90_mainnet_ceremony.mjs        主网仪式 P0 ~ P6（--dry-run 不发网络写操作）
│   ├── deploy_all.mjs                 按 deployPlan 串联（默认 whole；--mode jetton；默认 dry-run）
│   ├── verify_deployment.mjs          全量验收（默认 STRICT；--offline；含 StakeTicket 与军饷分发合约核对）
│   ├── reconcile.mjs                  对账 CSV（销毁 / 团队释放 / RC 钱包公式）
│   ├── monitor_check.mjs              监控告警（--snapshot / --json / --notify）
│   ├── announcement.mjs               公告渲染（模板库 templates/announcements.json）
│   └── selftest.mjs                   离线自测（参数、档位、地址、公告、对账、监控、登记表、脚本语法）
├── tolk/                              （scripts/tolk/）链上小工具：user_op（stake / claim / restake）、query_user、fast_admin、fast_candle、query_one_wallet
├── runbooks/                          （文档组维护）部署、运营、监控、密钥、公告、主网权限
├── templates/                         公告模板、对账表模板、KPI、排期、值班、事故记录
├── drills/                            演练计划与记录（文档组维护）
├── records/                           生成产物（对账 CSV、地址簿、公告、验收报告；git 忽略）
└── tests/                             对账与监控离线夹具（README 说明状态）
~~~

合约侧的脚本在 `contracts/scripts/`：`deploy-emulation.tolk`（整体部署）、`deploy/admin_op.tolk`（open-round / close-staking / submit-candle / abort-technical / retry-settlement / release-team）、`deploy/junxiang_op.tolk`（junxiang-set-root）、`deploy/fund_jetton.tolk` 与 `fund_ton.tolk`。

---

## 3. 交付对照

| 任务交付项 | 对应文件 | 验证方式 |
| --- | --- | --- |
| ① 测试网部署脚本 | scripts/00、15、40、50、55、60、80，deploy_all.mjs，lib/* | selftest 的 dry-run 用例 + §1.1 顺序 |
| ① 地址登记表 | config/testnet.registry.json、addresses.template.json、60 生成地址簿 | 60 + verify_deployment |
| ② 10 轮运营 | keeper-candles.mjs、80_admin_ops.mjs、fasttest-runner.mjs；快测档 §1.2 | 快测档 10 轮演练（文档组 drills） |
| ② 公告模板 | templates/announcements.json | selftest 渲染各类 × 中英 + 风险提示 |
| ③ 监控告警 | monitor_check.mjs | selftest monitor.healthy / monitor.faults |
| ④ 军饷分发 | 80 junxiang-set-root、contracts/scripts/deploy/junxiang_op.tolk、verify_deployment | selftest dryrun.80.junxiang_set_root |
| ⑤ 主网 | config/mainnet.params.json（BLOCKED）、worker/scripts/preflight-mainnet.mjs | preflight 拒绝无 tag `v11-audit-fixed` 的主网 |

---

## 4. 运行模式与安全约定

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| DRY-RUN（默认） | 无环境变量 | 只校验并打印计划，不发请求或交易 |
| EXECUTE | OPS_EXECUTE=1 或脚本 --execute | 执行链上部署、注资或 keeper 操作 |
| 写操作二次确认 | 另加 OPS_CONFIRM=YES | 不可逆操作（注资、开轮、提交 K 线、军饷根、重试结算） |
| 只读运营 | 无 | monitor、reconcile、announcement（不带发送）、verify --offline |

**安全红线**：

- 助记词、私钥、API key 只从环境变量或本地 keystore 读取；脚本不打印、不落盘、不写入登记表。
- 不要使用裸私钥（64 位 hex）；优先 Acton 项目钱包。
- 团队、营销、流动性、内盘地址不公开；只在登记表和内部地址簿出现。
- 任何不可逆操作必须双人核对并留痕（见 runbooks/04）。
- keeper 钱包只放 gas，不放 A9；军饷 publisher 同理。

---

## 5. 单位、参数与运营规则

- 代币金额：raw 字符串（1 A9 = 1e9）；脚本用 BigInt，禁止浮点。
- 价格：USD_E8 字符串（$0.00116 = 116000）；P0 = 116000，倍数 2。目标价 = max(P0 × 2^tier, 2 × 24h TWAP)。
- 时间：链上 Unix 秒；运营文档统一 UTC。
- 生产档（testnet.params.json）：PREVIEW 12h，报名 36h，观察 24 根 × 1h（阈值 16：第 24 根提交即判定，≥ 16 成功，≤ 15 失败）；单轮约 72h，10 轮约 30 天。技术终止超时 7 天（观察 / 预告共用）。
- **v11 质押**：最低 1,000 A9；无单地址上限、无本轮总额上限（get_protocol_config 两字段恒为 0）。
- **v11 领取**：全部经攻城令（StakeTicket，每人每城一张）。TicketClaim `0x52540303` 发到 `RC.get_ticket_address(owner, roundId)`，附带 ≥ 0.15 TON；TicketRestake `0x52540304` ≥ 0.25 TON。Claim / ClaimAll 已删除。
- **v11 奖励**：破城时 20% 立即可领，80% 等之后任意一城破城时解锁；第 10 城后 30 天线性兜底。
- **v11 团队额度**：本城破城时不发，下一次破城才转 1.2 亿；最后一笔在第 10 城结束 30 天后由 `ReleaseTeam` 释放（任何人，≥ 0.1 TON）。
- **v11 失败轮**：一笔销毁 = 奖池一半（首轮 3.5 亿）+ 1.2 亿 + 本轮全部本金；另一半滚入下一城。0 人破城全额滚存。
- 初始分配：mint 100 亿到 treasury；RC 82 亿（70 亿奖励 + 12 亿团队，forward 0）；内盘 8 亿、流动性 5 亿、营销 5 亿。
- 流动性：5 亿 A9 额度；冷启动 2 亿 A9 + $232,000 USDT（同价 $0.00116，占 40%，剩余 3 亿后续加池）。
- TON gas：RC ≥ 20 TON；keeper ≥ 2 TON；分发合约部署附 1 TON（不需要运行余额）。
- Jetton：mint-once 0x00000015，金额 1e19，同一笔交易关闭铸造（mintable = false）。
- 配置哈希：scripts/lib/config.mjs 对协议关键参数（含时序档位）做 canonical JSON + sha256；部署前写入登记表。

### 5.1 keeper 运营（每轮）

`80_admin_ops.mjs` 或 `keeper-candles.mjs`：open-round（预告结束后，携带 24h TWAP）→ close-staking（报名到期后，任何人）→ submit-candle × 24（每小时一根，keeper）→ 失败轮若销毁未确认则 retry-settlement（keeper-candles 连续 3 次未确认才重试，避免空调）。

**破城轮的团队额度退回不由 keeper-candles 自动重试**：RoundView 无法区分「未发出」与「被退回」。SettlementBounced 事件 → monitor 告警 → `80_admin_ops.mjs --action retry-settlement --round N`。

### 5.2 技术终止与团队释放

- `abort-technical`（任何人）：观察应结束后超过 abortTimeoutSeconds 仍未判定，或预告结束后仍未开轮。本金经攻城令领取，奖励与团队额度滚入下一城。
- `release-team`（任何人）：第 10 城结束 30 天后，释放最后一笔 1.2 亿。

### 5.3 军饷周根（publisher，junxiang-set-root）

合约：JunxiangDistributor + ClaimRecord（累计默克尔，contracts/README §7.1）。每周：

1. 生成本期累计 Merkle root（链下实现见 worker/src/social/merkle.ts，编码必须一致）与累计总额（raw）。
2. **先**给分发合约的 A9 钱包充值 ≥ 累计总额（fund_jetton，owner = 分发合约地址；不足则领取 jetton 转账 bounce）：
   ~~~bash
   cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<treasury> JETTON_MASTER_ADDRESS=<master> \
     acton script --net testnet scripts/deploy/fund_jetton.tolk <distributor> <cumulativeRaw>
   ~~~
3. 发布（listId 必须严格大于链上当前值，首次为 1）：
   ~~~bash
   OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<publisher> \
     node ops/scripts/80_admin_ops.mjs --action junxiang-set-root --list <listId> --root <0x64hex> --total <cumulativeRaw> --execute
   ~~~
   80 在 EXECUTE 前读取分发合约 A9 余额，低于 `--total` 或无法读取即拒绝发布（dry-run 只提示）。

信任：publisher 单热钱包决定分配；无 admin、无提现、不可升级。

---

## 6. 已知限制与待对接

1. **keeper 不可更换**：keeper 与 publisher 地址在部署时写入合约，没有 setKeeper。泄露只能整套重建（见 runbooks/04）。
2. **结算退回**：破城轮的退回只能靠 SettlementBounced 事件人工触发 RetrySettlement；失败轮由 keeper-candles 去抖后自动重试。UnexpectedBounce 需人工核查。
3. **对账 / 监控口径**：reconcile.mjs 与 monitor_check.mjs 的结算公式已按 v11（奖池一半、破城不销毁、团队额度下一城释放）计算；但 RC 钱包公式中的「已领奖励 / 退款账本」字段仍沿用 v10 命名，v11 没有退款账本（应为 0）。`ops/tests/fixtures/worker-snapshot.json` 已按 v11 改写；`worker-snapshot-bad.json` 仍是 v8.9 字段，见 tests/README。
4. **军饷充值无专用 ops 动作**：分发合约充值目前用 contracts 的 fund_jetton.tolk 手工执行（§5.3）；80 只负责发布根并核对余额。
5. **工具链 pin**：testnet.params.json 的 toolchain.pinned = true（acton 1.1.0）；执行前用 `acton --version` 核对。
6. **Acton 钱包**：部署前需在 contracts/ 下导入项目钱包；00_preflight 会检查，但不会读取私钥。
7. **公告发送**：默认只渲染不发送；发送需 TELEGRAM_* 与 OPS_CONFIRM=YES，且人工审批文案。

---

## 7. 验证命令

~~~bash
# 全部离线自测（每次改动后运行；44 → 49+ 项）
node ops/scripts/selftest.mjs
make -f ops/Makefile selftest

# 参数与工具链检查
node ops/scripts/00_preflight.mjs

# 编排 dry-run（未部署也可跑通；最后的验收步骤会提示预期失败）
node ops/scripts/deploy_all.mjs

# 快测档 dry-run（时序应为 600 / 1800 / 60 / 900）
OPS_PARAMS=ops/config/testnet-fast.params.json node ops/scripts/15_deploy_contracts.mjs

# 对账与监控夹具
node ops/scripts/reconcile.mjs --snapshot ops/tests/fixtures/worker-snapshot.json
node ops/scripts/monitor_check.mjs --snapshot ops/tests/fixtures/worker-snapshot.json
node ops/scripts/monitor_check.mjs --snapshot ops/tests/fixtures/worker-snapshot-bad.json   # 期望 exit 2

# 主网自检（必须拒绝：无 tag v11-audit-fixed）
node worker/scripts/preflight-mainnet.mjs                                                  # 期望 exit 1
~~~

---

## 8. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1.0 | 2026-11-05 | 初版：部署脚本、地址登记、10 轮 SOP、监控告警、密钥与权限手册、公告模板、selftest |
| 0.2.0 | 2026-11-06 | v10（D-42）：三个合约，无 admin，单 keeper；部署改为 15 整体部署（82 亿，forward 0） |
| 0.3.0 | 2026-11-07 | v11（docs/35 D-43~D-50）：攻城令（TicketClaim / TicketRestake）替代 Claim / ClaimAll；最低质押 1,000 A9，无上限；军饷分发合约 + ClaimRecord（junxiang-set-root）；ReleaseTeam；快测档 testnet-fast.params.json 与 A9_TIMING_* 环境变量；selftest 扩展到 49 项 |

---

*维护：testnet-ops。任何参数或合约接口变更，先更新参数与模板，再同步文档与 selftest，最后通知 Lead。*
