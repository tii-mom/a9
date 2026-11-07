# 测试网 v11 十城演练（快速档）

- 演练名称：v11 测试网十城全流程演练（快速档）
- 演练编号：________
- 关联部署：测试网独立部署（快速档参数），RoundController 地址 ________，JettonMaster 地址 ________，JunxiangDistributor 地址 ________
- 合约版本：v11（contracts/README §0 代码哈希）
- 日期（UTC）：________
- 参与人（操作 / 复核 / 观察）：________ / ________ / ________
- 环境：测试网，独立部署，独立 D1，独立 Worker 名。**不是主网，不是 a9.lat 生产 Worker**
- 计划用时：约 12–14 小时（不含 Phase 0 准备）
- 依据：docs/35 §1–§4、contracts/README §2、§3、§5、§7.1；`ops/runbooks/01_deploy_testnet.md`、`02_round_operations.md`、`03_monitoring_alerting.md`

> **金额约定**：文中 A9 数字保留到两位小数，合约按 raw 向下取整，尾差以链上 raw 为准（尾差留在合约）。1 A9 = 1e9 raw。
> **K 线说明**：测试网上的 K 线由 keeper 提交。本演练的成败是人为设定的测试数据，不代表真实市场结论。K 线的 dataDigest 必须对应公开记录的数据源。

---

## 0. 目标与范围

**目标**：在一次快速档部署上，跑完 10 城，让下面每一种场景至少发生一次，并逐项对照链上预期与 API / UI 表现。

| 编号 | 场景 | 覆盖城 | 覆盖状态 |
| --- | --- | --- | --- |
| (a) | 破城，多人在不同时机段上车；权重 1.5 / 1.2 / 1.0；奖励 = 奖池 × 权重 ÷ 总权重；20% 立即可领 | R1 | 链上演练 |
| (b) | 阵亡：一半奖池、团队额度、全部本金销毁（total_supply 减少）；另一半滚入下一城 | R2、R8、R10 | 链上演练 |
| (c) | 零人破城：整个奖池滚入下一城，档位升一档 | R6 | 链上演练 |
| (d) | 一键续战：在下一城攻城期内用旧攻城令续战 | R2 | 链上演练 |
| (e) | 上一城 80% 压城奖励在下一次破城时解锁；团队额度晚一次破城才发 | R3、R7、R9 | 链上演练 |
| (f) | 观察超时技术终止：keeper 在守城期中途停机，超时后任何人调用 AbortTechnical | R4 | 链上演练（依赖快速档部署的 abortTimeoutSeconds，见 §1） |
| (f') | 集结超时技术终止：keeper 不开下一城 | R5 | 链上演练（同上） |
| (g) | 受益人上车（一人付款，另一人持有攻城令）；STON.fi 一键上车 | R3 | 一键上车链上演练。受益人上车 `user_op` 不支持（beneficiary 固定为付款人），只能通过 STON.fi 界面；界面不支持则记为未演练（见 §1.3 第 3 条、§4 Phase 3） |
| (h) | 第 10 城结束：endAt 写入，剩余 carry 销毁，30 天线性解锁 | R10 | 部分链上演练：立即部分与 t=0 为 0%；30 天全额解锁由本地测试覆盖 |
| (i) | 军饷：compute → payout build → 注资 → SetRoot → 领取 → 重放被拒 | R3（主流程）、R6（旧根失效） | 链上 + API 演练 |
| (j) | 社交：startapp 邀请绑定、群内 /team 建战队、亮灯推送、X 分享卡 PNG | Phase 0、R1、R2 | 演练（6 小时摘要见 §5） |
| (k) | TON Proof 登录，再用 Bearer 会话完成一次战队写入 | Phase 0 | 演练 |

**不在本演练内**：

- 主网参数（7 天技术终止超时、12 h 集结、36 h 攻城）。这些只在主网参数下有效，由本地测试覆盖。
- 第 10 城之后 30 天的完整解锁与团队最终释放（ReleaseTeam 的成功路径）。本演练只验证"未满 30 天时被拒绝"。
- 审计结论。

---

## 1. 快速档参数

参数来源：`ops/config/testnet-fast.params.json`（快速档配置，目前未提交，与本表一致；脚本报告定稿后以脚本报告为准）。

| 参数 | 快速档（本演练） | 正式档（参考） | 备注 |
| --- | --- | --- | --- |
| previewSeconds（集结） | 600 | 43200 | 第 1 城没有集结期 |
| stakeDurationSeconds（攻城） | 1800（三档各 600） | 129600（三档各 43200） | 三档：前 1/3 ×1.5，中 1/3 ×1.2，后 1/3 ×1.0 |
| candleSeconds × candleCount | 60 × 24 | 3600 × 24 | 观察时长 = 24 分钟 |
| minQualifiedCandles | 16 | 16 | ≥ 16 破城，≤ 15 阵亡 |
| minStakeRaw | 1,000 A9 | 1,000 A9 | 低于此值不计入 |
| **abortTimeoutSeconds** | **900**（快测档，由 `OPS_PARAMS=ops/config/testnet-fast.params.json` 写入，对应环境变量 `A9_TIMING_ABORT_TIMEOUT_SECONDS`） | 604800 | 技术终止超时；快速档由部署参数写入，正式档为 7 天 |
| P0 | 116000 USD_E8 | 116000 | 目标价 = max(P0 × 2^tier, 2 × 开窗 24h TWAP) |
| 开城 TWAP（本演练统一） | 100000 USD_E8 | — | 2 × 100000 = 200000 < P0 × 2，所以目标价只由 tier 决定 |

**部署前确认**：

- `get_protocol_config` 回读 `abortTimeoutSeconds` = 900（占位值，以部署参数报告为准），其余字段与上表一致。
- 如果快速档部署后 abortTimeoutSeconds 不是 900，(f) 与 (f') 的等待时间要相应调整，并在报告里记录。

**快速档的时间线（每城名义时长）**：

- 正常城：集结 10 分钟 + 攻城 30 分钟 + 观察 24 分钟 = 约 64 分钟
- R4（观察超时）：10 + 30 + 观察中途停机（约 3 分钟后）+ 等待超时到期（15 分钟） ≈ 79 分钟
- R5（集结超时）：集结 10 分钟 + 超时 15 分钟 = 约 25 分钟

---

### 1.3 命令速查（快测档，依据 ops/README.md）

环境：`export OPS_PARAMS=ops/config/testnet-fast.params.json`；钱包用 `acton wallet import` 导入（部署者 `deployer`、admin `admin`，keeper 与各测试用户的名字自定）。写操作一律 `OPS_EXECUTE=1 OPS_CONFIRM=YES`，并加 `--execute`。`<worker>` 为测试网 Worker（`https://a9-testnet.<subdomain>.workers.dev`）。

| 动作 | 命令（摘要） | 对应演练步骤 |
| --- | --- | --- |
| 部署 + 核对 | `15_deploy_contracts.mjs --execute` → `40_init_params.mjs --execute --online` → `55_fund_ton` → `50_fund_vaults --probe --all` → `60_verify_and_register --execute` → `verify_deployment --online --save`（0 FAIL） | Phase 0.1 |
| 开城 | `80_admin_ops.mjs --action open-round --round N --twap24h 100000 --execute`（签名 keeper） | 每城开头 |
| 关窗 | `80_admin_ops.mjs --action close-staking --round N --execute` | 每城攻城结束后 |
| 提交 K 线 | `80_admin_ops.mjs --action submit-candle --round N --candle i --twap <USD_E8> --digest <64hex> --observation-start <unix> --execute`，每分钟一根 | 每城守城期 |
| 质押 | `acton script --manifest-path contracts/Acton.toml --net testnet ops/scripts/tolk/user_op.tolk stake <amountRaw> <roundId> <…> <dummy>`（参数顺序见文件头） | 各城上车 |
| 领取 | 同上，动作 `claim <roundId> 0 0 <dummy>` | 破城 / 观察超时后领取 |
| 一键续战 | 同上，动作 `restake <roundId> 0 0 <dummy>` | Phase 2.2 |
| 结算退回 | `80_admin_ops.mjs --action retry-settlement --round N --execute` | 仅在 SettlementBounced 出现后 |
| 技术终止 | `80_admin_ops.mjs --action abort-technical --execute`（任何人） | Phase 4.4、5.2 |
| 团队释放（负面用例） | `80_admin_ops.mjs --action release-team --execute` | Phase 10.5 |
| 军饷 compute | `POST <worker>/api/admin/junxiang/compute?round=N`，头 `Authorization: Bearer ${ADMIN_TOKEN}` | 每城结算后 |
| 军饷清单 | `POST <worker>/api/admin/payout/build`，body `{"fromRound":1,"toRound":N}` | Phase 3.8、6.4 |
| 军饷注资 | `contracts/`：`acton script --net testnet scripts/deploy/fund_jetton.tolk <分发合约地址> <累计总额 raw>`（第一个参数是 owner） | Phase 3.8 第 5 步 |
| 军饷发根 | `80_admin_ops.mjs --action junxiang-set-root --list N --root 0x… --total <raw> --execute`（签名 publisher） | Phase 3.8、6.4 |
| 对账 | `reconcile.mjs --chain --strict --out ops/records/reconciliation-<日期>.csv` | 每城结算后 |

**快测用户侧脚本的限制**：`fasttest-runner.mjs` 固定使用钱包 A/B/C、只覆盖基础质押与 TicketClaim，不覆盖续战与军饷。本计划的分段上车、续战、受益人与军饷等场景，按上表的 `user_op` 与 80 手工执行。

**已知限制（必须在演练中体现）**：

1. **结算退回不自动重试**：破城轮的团队额度退回不会被 keeper 自动重试。出现 SettlementBounced 必须人工执行 `retry-settlement`，并在结果表里记录。
2. **R10 台账差异**：运营台账没有建模第 10 城的 carry 销毁，对账在 R10 可能出现差异提示。以 R10 的 RoundSettled 事件（rewardBurnRaw = 7 亿）为准，不以台账为准。
3. **受益人上车（g）**：`user_op` 的质押 beneficiary 固定为 addr_none（即记在付款人名下），无法用它演练受益人。Phase 3.2 的受益人上车只能通过 STON.fi 界面（若界面不支持，记为未演练，不得用其他方式替代）。

## 2. 账户与资金

| 代号 | 角色 | 用途 |
| --- | --- | --- |
| T | treasury / deployer | 注资 RC，分发测试 A9 与 TON |
| KEEPER | keeper 热钱包（只放 gas） | OpenRound、SubmitCandle |
| TM | teamWallet | 收团队额度（只读核对） |
| P | junxiang publisher | SetRoot（只发根） |
| A | 攻城者 | R1 上车；R2 续战；R3 领压城解锁 |
| B | 攻城者 | R1 上车；R3 领压城解锁 |
| C | 攻城者 | R1 上车（第三段）；R3 领压城解锁 |
| D | 攻城者 | R2 上车（第二段）；R2 阵亡 |
| F | 付款人（受益人赠送） | R3 付款，攻城令归 E |
| E | 受益人 | R3 持有攻城令 |
| G | 攻城者 | R3 第二段；R3 领取；R7 领压城解锁 |
| H | STON.fi 一键上车者 | R3 第三段；R3 领取；R7 领压城解锁 |
| I | 攻城者 | R4（观察超时，领回本金） |
| J | 攻城者 | R4（观察超时，领回本金） |
| Q1 | 攻城者 | R7 上车（第一段）；R9 领压城解锁 |
| Q2 | 攻城者 | R7 上车（第二段）；R9 领压城解锁 |
| M | 攻城者 | R8 上车，阵亡 |
| N | 攻城者 | R9 上车（第三段，单人破城）；R10 时领取前 80% 的部分 |
| O | 攻城者 | R10 上车，阵亡 |
| W | 测试用"新人"钱包 | Phase 0（邀请绑定，首次绑定后不可改） |

**资金**：

- T 向各测试钱包分发 A9，总量建议 ≥ 300,000 A9（本演练实际用量约 245,000 A9 加手续费）。分发记录写入登记表。
- 每个测试钱包 ≥ 2 TON（用于 Toncenter 与合约手续费）。
- KEEPER ≥ 2 TON。RC ≥ 20 TON（见 `01_deploy_testnet.md` §4）。

---

## 3. 十城计划（总览）

目标价一律使用 TWAP = 100000 USD_E8 开城。

| 城 | 档位 | 目标价（USD_E8） | 攻城上车 | 观察结果 | 结果 | 主要场景 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | 1 | 232000 | A 10,000 / B 20,000 / C 30,000 | 16 达标 | 破城 | (a)；(j)；(k)；亮灯 |
| R2 | 2 | 464000 | A 10,000（续战）/ D 5,000 | 15 达标 | 阵亡 | (b)；(d) |
| R3 | 2 | 464000 | F→E 30,000 / G 20,000 / H 10,000（STON.fi） | 20 达标 | 破城 | (e)；(g)；(i) 主流程 |
| R4 | 3 | 928000 | I 20,000 / J 10,000 | 3 根后 keeper 停机 | 观察超时终止 | (f) |
| R5 | 3 | 928000 | 无 | 无（集结超时） | 集结超时终止 | (f') |
| R6 | 3 | 928000 | **无人攻城** | 20 达标 | 破城（0 人） | (c) |
| R7 | 4 | 1856000 | Q1 40,000 / Q2 10,000 | 20 达标 | 破城 | 解锁 R3 压城（E、G、H）；(i) 旧根失效 |
| R8 | 5 | 3712000 | M 10,000 | 10 达标 | 阵亡 | (b) 第二次 |
| R9 | 5 | 3712000 | N 20,000（第三段） | 24 达标 | 破城 | 解锁 R7 压城（Q1、Q2）；团队额度 |
| R10 | 6 | 7424000 | O 10,000 | 10 达标 | 阵亡（第 10 城） | (h) |

**档位与奖池（核对用）**：

| 城 | 开城 tier | 本城奖池（rewardBudget） | 来源 |
| --- | --- | --- | --- |
| R1 | 1 | 700,000,000 | 基础 7 亿 |
| R2 | 2 | 700,000,000 | 基础 7 亿（R1 破城，carry = 0） |
| R3 | 2 | 1,050,000,000 | 基础 7 亿 + R2 滚存 3.5 亿 |
| R4 | 3 | 700,000,000 | 基础 7 亿（R3 破城，carry = 0） |
| R5 | 3 | —（未开城） | R5 集结超时，其 7 亿滚入 carry，由 R6 使用 |
| R6 | 3 | 2,100,000,000 | 基础 7 亿 + R4 滚存 7 亿 + R5 滚存 7 亿 |
| R7 | 4 | 2,800,000,000 | 基础 7 亿 + R6 滚存 21 亿（R6 为 0 人破城，全额滚入） |
| R8 | 5 | 700,000,000 | 基础 7 亿（R7 破城，carry = 0） |
| R9 | 5 | 1,050,000,000 | 基础 7 亿 + R8 滚存 3.5 亿 |
| R10 | 6 | 700,000,000 | 基础 7 亿（R9 破城，carry = 0） |

> 注：R4 与 R5 的 7 亿都滚入 carry，所以 R6 的奖池是 7 亿 + 14 亿 = 21 亿。R6 为 0 人破城，整个 21 亿再滚入 R7。

---

## 4. 步骤与预期

每一步都写明：**操作** → **链上预期** → **API / UI 检查**。交易哈希记入 §5 结果表。

### Phase 0 — 准备与社交 / 登录验收（R1 开城之前）

**0.1 部署与参数**

- 操作：按快速档参数部署（`01_deploy_testnet.md` §2–§3），运行部署后检查。
- 链上预期：
  - JettonMaster total_supply = 1e19，mintable = false，admin = null
  - RC 钱包余额 = 8,200,000,000 A9
  - `get_ticket_code_hash` = `0x0F00D299…EBD3DBC`
  - `get_protocol_config`：previewSeconds = 600，stakeDurationSeconds = 1800，candleSeconds = 60，candleCount = 24，minQualifiedCandles = 16，abortTimeoutSeconds = 900（占位）
  - `get_protocol_state`：currentRoundId = 0，successCount = 0，carry = 0，teamPending = 0，endAt = 0
- API：`GET /api/rounds` 返回链上模式数据（dataSource = chain）；`GET /api/health` ok。

**0.2 Worker 与 webhook**

- 操作：部署测试网 Worker，应用 D1 迁移，设置 secrets 与 vars，设置 Telegram webhook（`01_deploy_testnet.md` §5）。
- 预期：`getWebhookInfo.url` 为测试站 `/api/tg/webhook`，`last_error_message` 为空。

**0.3 STON.fi 池**

- 操作：创建测试网池（`01_deploy_testnet.md` §6），设置 `STONFI_POOL_ADDRESS`。
- 预期：Worker 能读到池子储备。

**0.4 TON Proof 登录（k）**

- 操作：用钱包 A 在测试站用 TON Connect 连接测试网钱包，签 ton_proof，拿到会话 token。
- 预期：
  - 登录成功，会话 token 有效期 7 天。
  - `POST /api/social/squads`（带 `Authorization: Bearer <token>`）返回成功，建出战队。
  - 同一请求不带 token（只带过期或伪造的 token）被拒绝（401 或 403）。
- UI：页面显示钱包已登录，显示战队。

**0.5 邀请绑定（j）**

- 操作：
  1. A 从 0.4 得到邀请码（`r_<邀请码>`）与战队码（`s_<战队码>`）。
  2. W 第一次打开 `https://t.me/<bot>/app?startapp=r_<A 的邀请码>_s_<战队码>`。
  3. W 第二次打开另一个邀请码的链接（例如 B 的邀请码）。
- 预期：
  - 第一次打开后，`GET /api/social/me?wallet=<W>` 显示邀请人为 A，战队为 A 的战队。
  - 第二次打开后，邀请人仍为 A（首次绑定后不可改）。
- UI：小程序显示已加入战队。

**0.6 群内建战队（j）**

- 操作：把测试 bot 拉进测试群；群主（用钱包 C 的 TG 账号）发送 `/team`。
- 预期：bot 回复战队已创建（含战队码）；`GET /api/social/squads` 或 `GET /api/social/me` 显示该群战队。
- 发送 `/gate`、`/rank`、`/me`，bot 都有回复。

**0.7 X 分享卡（j）**

- 操作：打开战队的分享落地页 `/s/<code>`，检查 OG 标签；直接打开 `/og/<code>.png`。
- 预期：
  - `/og/<code>.png` 返回图片（Content-Type 为 image/png），图片可以正常打开。
  - 图片中的奖池数字、距离城门的数字与 `GET /api/rounds` 一致（以当前时间为准）。
  - 落地页的 og:image 指向该 PNG。
- UI：X 分享预填文案正确，带邀请链接。

### Phase 1 — R1：(a) 三段上车与破城（阈值边界 16 根）

**1.1 开城**

- 操作：KEEPER 发 OpenRound（twap24h = 100000）。R1 没有集结期，可直接开。
- 链上预期：
  - TargetPriceSet：tier = 1，target = 232000，twap24h = 100000
  - `get_round(1)`：status = 2（STAKING_OPEN），target = 232000，rewardBudget = 700,000,000 A9
- API：`GET /api/rounds` 显示第 1 城攻城中，目标价 232000，三段时间。

**1.2 三段上车**（以攻城开始为 t0，攻城窗口 30 分钟）

| 时间 | 钱包 | 金额 | 时机段 | 系数 | 战力（A9 计） |
| --- | --- | --- | --- | --- | --- |
| t0 + 2 分钟 | A | 10,000 | 前 1/3（0–10 分钟） | ×1.5 | 15,000 |
| t0 + 14 分钟 | B | 20,000 | 中 1/3（10–20 分钟） | ×1.2 | 24,000 |
| t0 + 25 分钟 | C | 30,000 | 后 1/3（20–30 分钟） | ×1.0 | 30,000 |

- 链上预期（每笔 DepositAccepted）：
  - A：amount 10,000 A9，weight 15,000（即 ×1.5）
  - B：amount 20,000 A9，weight 24,000（即 ×1.2）
  - C：amount 30,000 A9，weight 30,000（即 ×1.0）
  - 攻城结束时 totalStake = 60,000 A9，totalWeight = 69,000，上车次数 = 3
- 攻城令：A、B、C 各有一个 StakeTicket，地址与 `get_ticket_address(owner, 1)` 一致。
- 负面用例（同一窗口内）：W 上车 500 A9，附带 0.15 TON。
  - 预期：不计入（低于 1,000 A9），DepositRefunded（instant = true），原路退回 500 A9。
  - 对照：另一笔 500 A9 附带 0.05 TON。预期：不退回（没有退款账本）。这笔是有意的失败演示，记为"按规则不退"，需要在结果中写明。
- API：`/api/social/me?wallet=A` 显示攻城令，显示时机段 ×1.5；UI 显示三段时间与系数标签（1.5 / 1.2 / 1.0）。

**1.3 攻城结束**

- 操作：到点后任何人（或 KEEPER）发 CloseStaking。
- 预期：StakingClosed（early = false，twap1h = 0），观察开始。
- 公告：stake-close 模板，写明观察起止时间。

**1.4 守城（24 根，每根 1 分钟）**

- 操作：KEEPER 每分钟提交一根，candleIndex 0–23；periodStart = observationStart + i × 60，periodEnd = periodStart + 60；dataDigest 为 64 位十六进制。
- 通过的 K 线：TWAP = 239,000（≥ 232000）。未通过：TWAP = 208,000（< 232000）。
- 顺序：candleIndex 0–15 通过（共 16 根），16–23 未通过（共 8 根）。
- 链上预期：每根 CandleSubmitted；第 24 根提交时判定。
- 亮灯：每根提交后，群里收到一条亮灯消息。通过的亮灯，未通过的显示未亮。
- 中间检查：`candlesSeen` 逐根增加；`qualifiedCandles` 在第 16 根时为 16。

**1.5 判定（第 24 根）**

- 链上预期（RoundSettled）：
  - status = SUCCEEDED（8）
  - qualifiedCandles = 16，candlesSeen = 24
  - totalAcceptedStakeRaw = 60,000 A9
  - rewardBudgetRaw = 700,000,000 A9，carryAfterRaw = 0
  - teamReleasedRaw = 0（这是第一次破城，没有上一次留下的额度）
  - rewardBurnRaw = 0，teamBurnRaw = 0，principalBurnRaw = 0
  - tierAfter = 2
  - teamPending = 120,000,000 A9（R1 的额度挂起）
- total_supply 不变（1e10）。
- 公告：success 模板，数字与 RoundSettled 一致。

**1.6 奖励分配（a）**

| 钱包 | 战力 | 应得奖励（reward） | 立即 20% | 压城 80% |
| --- | --- | --- | --- | --- |
| A | 15,000 | 152,173,913.04 A9 | 30,434,782.61 A9 | 121,739,130.43 A9 |
| B | 24,000 | 243,478,260.87 A9 | 48,695,652.17 A9 | 194,782,608.70 A9 |
| C | 30,000 | 304,347,826.09 A9 | 60,869,565.22 A9 | 243,478,260.87 A9 |

- 公式核对：reward = 700,000,000 × weight ÷ 69,000。`get_reward_preview(1, weightRaw)` 返回的 rewardRaw、immediateRaw、lockedRaw 与上表一致（尾差以 raw 为准）。
- 合计 ≈ 700,000,000 A9（尾差留在合约）。

**1.7 领取（B、C）**

- 操作：B、C 各发 TicketClaim（附带 ≥ 0.15 TON，建议 0.2）。
- 链上预期：
  - B 收到 20,000（本金）+ 48,695,652.17 A9（立即）= 48,715,652.17 A9；Claimed 事件（principalRaw = 20,000，rewardRaw = 48,695,652.17）
  - C 收到 30,000 + 60,869,565.22 = 60,899,565.22 A9
  - 两张攻城令的 pending 清除；principalDone = true；lockedClaimed = 0；压城 80% 仍留在攻城令上
- A 暂不领取（A 在 R2 续战，见 Phase 2）。

**1.8 R1 的 APIs 与 UI**

- `GET /api/rounds`：第 1 城 SUCCEEDED；16 盏亮灯，8 盏未亮；目标价 232000。
- `GET /api/social/leaderboard?type=power&scope=round&round=1`：A、B、C 的战力与战力比例与 §1.2 一致（以链上 weightRaw 为准，不以前端的时机表为准）。
- 亮灯：群里收到 24 条亮灯消息（16 亮，8 未亮）。
- 6 小时战队摘要：本演练在 UTC 整点的 6 小时攻城期内（如果有）观察；否则记为未演练（见 §5）。

### Phase 2 — R2：(d) 一键续战与 (b) 阵亡（15 根）

**2.1 集结与开城**

- 链上预期：R2 创建为 PREVIEW，stakeOpenAt = R1 结算时间 + 600 秒。
- KEEPER 在集结结束后发 OpenRound（twap24h = 100000）。
- 链上预期：TargetPriceSet：tier = 2，target = 464000；rewardBudget = 700,000,000 A9。

**2.2 续战（d）**

- 操作：A 对 R1 的攻城令发 TicketRestake（附带 ≥ 0.25 TON，建议 0.3），时间在 R2 攻城前 1/3 内（约 t0 + 2 分钟）。
- 链上预期：
  - Restaked 事件：owner = A，fromRound = 1，toRound = 2，amountRaw = 10,000 A9，weightRaw = 15,000（×1.5）
  - DepositAccepted（R2）：owner = A，amount 10,000，weight 15,000
  - A 立即收到 R1 的 20%：30,434,782.61 A9（照常转出）
  - A 的 R1 攻城令：principalDone = true，lockedClaimed = 0；压城 80%（121,739,130.43 A9）仍留在攻城令上，不转出
  - 本金没有离开合约（RC 的 Jetton 余额没有因本金变化）
- 负面用例：A 在同一城再次 TicketRestake，预期被拒绝（本金已续战），攻城令 pending 清除。

**2.3 另一人上车**

- D 在攻城中段（约 t0 + 14 分钟）上车 5,000 A9，系数 ×1.2，权重 6,000。
- 链上预期：DepositAccepted：owner = D，amount 5,000，weight 6,000。

**2.4 攻城结束与守城**

- 攻城 totalStake = 15,000 A9（A 续战的 10,000 + D 的 5,000），totalWeight = 21,000。
- CloseStaking（到点后）。
- 守城 24 根：candleIndex 0–14 通过（TWAP = 478,000，≥ 464000），15–23 未通过（TWAP = 417,600）。通过 15 根，不足 16 根。

**2.5 判定（阵亡）**

- 链上预期（RoundSettled）：
  - status = FAILED_PERMANENT（9）
  - qualifiedCandles = 15，candlesSeen = 24
  - totalAcceptedStakeRaw = 15,000 A9
  - rewardBudgetRaw = 700,000,000 A9
  - rewardBurnRaw = 350,000,000 A9（奖池一半）
  - teamBurnRaw = 120,000,000 A9
  - principalBurnRaw = 15,000 A9（A 续战的 10,000 + D 的 5,000）
  - carryAfterRaw = 350,000,000 A9
  - teamReleasedRaw = 0（阵亡，不转团队）；R1 挂起的 120,000,000 A9 仍在 teamPending
  - tierAfter = 2（阵亡，档位不变）
- total_supply 减少 470,015,000 A9（350,000,000 + 120,000,000 + 15,000）：从 10,000,000,000 降为 9,529,985,000 A9。
- 公告：fail 模板；列出三项销毁与合计。

**2.6 阵亡后的领取（b）**

- D 发 TicketClaim。预期：被拒绝（阵亡城无可领），攻城令 pending 清除，无转账。
- A 的 R2 攻城令（续战所得）：同样无可领。

**2.7 军饷 compute（R1、R2）**

- 操作：`POST /api/admin/junxiang/compute?round=1`、`?round=2`（R1 结算后也要执行一次，见 Phase 1 之后）。
- 预期：返回成功；记录返回行数。具体金额在 Phase 4 汇总核对。

### Phase 3 — R3：(e) 团队与压城解锁、(g) 受益人与 STON.fi、(i) 军饷主流程

**3.1 集结与开城**

- 链上预期：R3 PREVIEW，stakeOpenAt = R2 结算 + 600 秒。
- KEEPER 发 OpenRound（twap24h = 100000）。
- 链上预期：TargetPriceSet：tier = 2，target = 464000（R2 阵亡，档位不变）；rewardBudget = 1,050,000,000 A9（含 R2 滚存 350,000,000）。

**3.2 受益人上车（g）**

- 操作：F 用自己的钱包上车 30,000 A9，payload 的 beneficiary = E（付款人 ≠ 持有人）。时间：t0 + 2 分钟（前 1/3）。
- 链上预期：
  - DepositAccepted：owner = E，amount 30,000，weight 45,000（×1.5）
  - E 的攻城令存在，`get_ticket_address(E, 3)` 与之一致
  - F 没有 R3 的攻城令（F 的 jetton 余额减少 30,000，攻城令不属于 F）
- API：`/api/social/me?wallet=E` 显示攻城令；`/api/social/me?wallet=F` 不显示 R3 攻城令。

**3.3 中段与后段上车**

- G 上车 20,000 A9，t0 + 14 分钟，×1.2，weight 24,000。
- H 通过 STON.fi 测试网池一键上车，目标是 H 名下的攻城令（beneficiary = H）：约 10,000 A9，t0 + 25 分钟，×1.0，weight 10,000。
  - 若 STON.fi 测试网界面无法设置 beneficiary，记为"未演练"，并在 §7 写明。不要用其他方式替代。
- 攻城结束：totalStake = 60,000 A9，totalWeight = 79,000，上车次数 = 3。

**3.4 守城与判定（破城，20 根通过）**

- 守城 24 根：candleIndex 0–19 通过（TWAP = 478,000），20–23 未通过（TWAP = 417,600）。通过 20 根。
- 链上预期（RoundSettled）：
  - status = SUCCEEDED
  - qualifiedCandles = 20
  - rewardBudgetRaw = 1,050,000,000 A9，carryAfterRaw = 0
  - teamReleasedRaw = 120,000,000 A9（R1 挂起的额度，**在 R3 才发出**，即"下一次破城时才发"）
  - TM 收到 120,000,000 A9（只一次）
  - teamPending = 120,000,000 A9（R3 的额度挂起）
  - tierAfter = 3

**3.5 奖励分配（a 的复核，g）**

| 钱包（持有人） | 战力 | 应得奖励 | 立即 20% | 压城 80% |
| --- | --- | --- | --- | --- |
| E（付款人 F） | 45,000 | 598,101,265.82 A9 | 119,620,253.16 A9 | 478,481,012.66 A9 |
| G | 24,000 | 318,987,341.77 A9 | 63,797,468.35 A9 | 255,189,873.42 A9 |
| H（STON.fi 一键上车） | 10,000 | 132,911,392.41 A9 | 26,582,278.48 A9 | 106,329,113.93 A9 |

- 公式：reward = 1,050,000,000 × weight ÷ 79,000。

**3.6 领取（E、G、H 的立即部分）**

- E 发 TicketClaim：收到 30,000 + 119,620,253.16 = 119,650,253.16 A9（付款人 F 的钱包不变）。
- G 发 TicketClaim：收到 20,000 + 63,797,468.35 = 63,817,468.35 A9。
- H 发 TicketClaim：收到 10,000 + 26,582,278.48 = 26,592,278.48 A9。
- 三张攻城令的压城 80% 保留（R3 的压城要等 R6 破城后才解锁，见 Phase 6）。

**3.7 (e) R1 压城解锁 与 团队额度**

- A 发 TicketClaim（R1 攻城令，不是 R3 的）。预期：只领取解锁的压城部分 152,173,913.04 × 80% = **121,739,130.43 A9**；没有本金、没有立即部分（都在 R1、R2 已经处理）。
- B 发 TicketClaim（R1 攻城令）：领取压城 194,782,608.70 A9。
- C 发 TicketClaim（R1 攻城令）：领取压城 243,478,260.87 A9。
- 检查 `get_reward_preview(1, <A 的 weight>)` 的 unlockedLockedRaw 与上面一致（lastSuccessRound = 3 > 1）。
- 链上 TM 收款：R1 的 120,000,000 A9 只在 R3 结算时转一次，之后不再有 R1 的团队转账。

**3.8 (i) 军饷主流程**

- 操作顺序（不能颠倒）：
  1. `POST /api/admin/junxiang/compute?round=3`（R3 结算后）
  2. `POST /api/admin/payout/build`，body：`{ "fromRound": 1, "toRound": 3 }`（需 ADMIN_TOKEN）
  3. 核对清单：root 与 `GET /api/social/payout/latest` 一致；总额 = 第 1–3 城 compute 行数之和
  4. 计算应注资额 = 新清单总额 − 已支付总额（此时为 0）
  5. 注资：把应注资额的 A9 转入分发合约的 A9 钱包（来源：营销钱包）
  6. 回读分发合约 A9 钱包余额 ≥ 应注资额
  7. **SetRoot**（publisher P 发，listId = 1）
  8. 清单中一个正数金额的钱包（建议 A）调用 ClaimJunxiang（≥ 0.15 TON），带 `/api/social/payout/proof?wallet=<A>` 的证明
  9. 同一笔领取重放一次
- 链上预期：
  - 第 5 步后分发合约余额 = 应注资额（即清单总额）
  - 第 7 步 SetRoot 成功，listId = 1；合约读到的 root 与 API 一致
  - 第 8 步：A 收到的金额 = 清单中 A 的累计额（已领为 0）；ClaimRecord 记录已领 = 累计额
  - 第 9 步重放：被拒绝，无转账，ClaimRecord 不变
- **禁止**：在第 6 步余额不足时发根（SetRoot）。如果在本演练中出现余额不足，立即停止，记为 P0 演练事故，不要"补救后假装通过"。

### Phase 4 — R4：(f) 观察超时技术终止

**4.1 开城**

- 链上预期：R4 PREVIEW 结束后，KEEPER OpenRound（twap24h = 100000）。
- TargetPriceSet：tier = 3，target = 928000；rewardBudget = 700,000,000 A9（carry = 0）。

**4.2 上车**

- I 上车 20,000 A9（t0 + 2 分钟，×1.5，weight 30,000）。
- J 上车 10,000 A9（t0 + 14 分钟，×1.2，weight 12,000）。
- 攻城结束：totalStake = 30,000 A9，totalWeight = 42,000。

**4.3 守城中途停机（f）**

- 操作：CloseStaking 后，KEEPER 提交第 0、1、2 根 K 线（TWAP = 956,000，≥ 928000），然后**停止 KEEPER 进程**。不再提交任何 K 线。
- 链上预期：
  - 保持 status = OBSERVING（4）；candlesSeen = 3；没有 RoundSettled。
  - 监控：`monitor.roundN.candle_lag` 触发（P1）；`monitor.keeper.abort_window` 随时间显示剩余窗口。

**4.4 观察超时后的终止**

- 时间点：观察结束（攻城结束 + 1440 秒）+ abortTimeoutSeconds（900 秒），即攻城结束后约 39 分钟。
- 操作：**不要用 KEEPER**。由 On-call 或其他钱包调用 AbortTechnical。
- 链上预期：
  - TechnicalAborted：roundId = 4，reason = 2（观察超时），at = 调用时间
  - status = TECHNICAL_ABORTED（10）
  - carryRaw += 700,000,000 A9 → carry = 700,000,000 A9
  - 没有任何销毁（burn = 0）；没有团队转账；teamPending 仍为 120,000,000 A9（R3 的额度）
  - 档位不变：下一城 tier 仍为 3（successCount 不变）
  - R5 被创建为 PREVIEW，stakeOpenAt = 调用时间 + 600 秒
- 时间不足的负面用例：在观察结束 + 900 秒之前调用 AbortTechnical，预期 revert（条件未满足），链上无状态变化。

**4.5 领回本金（I、J）**

- I 发 TicketClaim：预期收到 20,000 A9（本金）；reward = 0；Claimed（principalRaw = 20,000，rewardRaw = 0）。
- J 发 TicketClaim：预期收到 10,000 A9。
- 两张攻城令 pending 清除。

**4.6 之后**

- 技术终止城不发军饷（Lead 决定：本金无风险退回，发饷会被刷）。可照常调用 compute，接口会清空该城军饷并返回 0 行；演练中验证这一点。
- 发布 abort 公告，数字与 TechnicalAborted、carry 一致。

### Phase 5 — R5：(f') 集结超时技术终止

**5.1 KEEPER 保持停机**

- R5 的 PREVIEW 由 R4 的终止创建，stakeOpenAt = R4 终止时间 + 600 秒。
- KEEPER 保持停机，不发 OpenRound。

**5.2 集结超时后的终止**

- 时间点：stakeOpenAt + abortTimeoutSeconds（900 秒）。
- 操作：任何人（不要用 KEEPER）调用 AbortTechnical。
- 链上预期：
  - TechnicalAborted：roundId = 5，reason = 3（集结超时）
  - status（R5）= TECHNICAL_ABORTED（10）
  - carryRaw += 700,000,000 A9 → carry = 1,400,000,000 A9
  - 没有任何转账，没有销毁；teamPending 不变（120,000,000 A9）
  - 档位不变：tier = 3
  - R6 被创建为 PREVIEW，stakeOpenAt = 调用时间 + 600 秒
- 负面用例：在 stakeOpenAt + 900 秒之前调用，预期 revert。

**5.3 恢复 KEEPER**

- 操作：在 R6 集结结束之前重新启动 KEEPER。KEEPER 不得补交 R4、R5 的任何 K 线（两城已终止，合约会拒绝）。

### Phase 6 — R6：(c) 零人破城

**6.1 开城**

- 链上预期：R6 的 PREVIEW 结束后，KEEPER OpenRound（twap24h = 100000）。
- TargetPriceSet：tier = 3，target = 928000。
- rewardBudgetRaw = 2,100,000,000 A9（7 亿 + carry 1,400,000,000 A9）。

**6.2 攻城期（0 人）**

- **不让任何钱包上车。** 攻城期 30 分钟照常，然后 CloseStaking。
- 链上预期：StakingClosed；totalStake = 0；上车次数 = 0。
- API：`/api/rounds` 显示攻城期，0 人，0 上车次数；UI 显示"无人上车，照常守城"。

**6.3 守城与判定**

- 守城 24 根：candleIndex 0–19 通过（TWAP = 956,000），20–23 未通过（TWAP = 835,200）。通过 20 根。
- 链上预期（RoundSettled）：
  - status = SUCCEEDED
  - qualifiedCandles = 20
  - totalAcceptedStakeRaw = 0
  - rewardBudgetRaw = 2,100,000,000 A9
  - carryAfterRaw = 2,100,000,000 A9（整个奖池滚入下一城）
  - rewardBurnRaw = 0，teamBurnRaw = 0，principalBurnRaw = 0
  - teamReleasedRaw = 120,000,000 A9（R3 挂起的额度），TM 收到 120,000,000 A9
  - teamPending = 120,000,000 A9（R6 的额度挂起）
  - tierAfter = 4
- total_supply 不变。

**6.4 军饷复核（i，旧根失效）**

- 操作：R6 结算后执行 `POST /api/admin/junxiang/compute?round=6`，再 `POST /api/admin/payout/build`，body：`{ "fromRound": 1, "toRound": 6 }`。
- 应注资额 = 新清单总额 − 已支付总额（已支付 = B 的 Phase 3 领取额）。核对余额后，SetRoot（listId = 2）。
- 链上预期：SetRoot listId = 2 成功。
- 旧证明测试：用 listId = 1 时 A 的证明（或 B 的旧证明）调用 ClaimJunxiang，预期**被拒绝**（只有最新根有效）。
- 新证明：用 listId = 2 的证明领取，预期只领增量（新累计 − 已领）；如果增量为 0，记录为"无增量，领取应拒绝或无转账"。

### Phase 7 — R7：破城（大奖池）与压城解锁

**7.1 开城**

- TargetPriceSet：tier = 4，target = 1,856,000。
- rewardBudgetRaw = 2,800,000,000 A9（7 亿 + carry 2,100,000,000 A9）。

**7.2 上车**

- Q1 上车 40,000 A9（t0 + 2 分钟，×1.5，weight 60,000）。
- Q2 上车 10,000 A9（t0 + 14 分钟，×1.2，weight 12,000）。
- 攻城结束：totalStake = 50,000 A9，totalWeight = 72,000。

**7.3 守城与判定**

- 守城 24 根：candleIndex 0–19 通过（TWAP = 1,912,000），20–23 未通过（TWAP = 1,670,400）。通过 20 根。
- 链上预期（RoundSettled）：
  - status = SUCCEEDED
  - qualifiedCandles = 20
  - rewardBudgetRaw = 2,800,000,000 A9，carryAfterRaw = 0
  - teamReleasedRaw = 120,000,000 A9（R6 挂起的额度），TM 收到 120,000,000 A9
  - teamPending = 120,000,000 A9（R7 的额度）
  - tierAfter = 5

**7.4 奖励**

| 钱包 | 战力 | 应得奖励 | 立即 20% | 压城 80% |
| --- | --- | --- | --- | --- |
| Q1 | 60,000 | 2,333,333,333.33 A9 | 466,666,666.67 A9 | 1,866,666,666.66 A9 |
| Q2 | 12,000 | 466,666,666.67 A9 | 93,333,333.33 A9 | 373,333,333.34 A9 |

**7.5 领取与 (e) 的第二段解锁**

- Q1 与 Q2 各发 TicketClaim，领取本金 + 立即部分。
- **E、G、H 领取 R3 的压城 80%**（R6 破城后解锁）：
  - E：478,481,012.66 A9
  - G：255,189,873.42 A9
  - H：106,329,113.93 A9
- 预期：每笔只领压城部分，没有本金，没有立即部分（已在 Phase 3 领取）。
- 检查 `get_reward_preview(3, <E 的 weight>)` 的 unlockedLockedRaw 与 E 的压城额一致。

### Phase 8 — R8：阵亡（第二次）

- TargetPriceSet：tier = 5，target = 3,712,000。
- rewardBudgetRaw = 700,000,000 A9（R7 破城，carry = 0）。
- M 上车 10,000 A9（t0 + 2 分钟，×1.5，weight 15,000）。
- 守城 24 根：0–9 通过（TWAP = 3,823,000），10–23 未通过（TWAP = 3,340,800）。通过 10 根。
- 链上预期（RoundSettled）：
  - status = FAILED_PERMANENT
  - qualifiedCandles = 10
  - rewardBurnRaw = 350,000,000 A9
  - teamBurnRaw = 120,000,000 A9
  - principalBurnRaw = 10,000 A9
  - carryAfterRaw = 350,000,000 A9
  - teamReleasedRaw = 0；teamPending 仍为 R7 的 120,000,000 A9
  - tierAfter = 5
- total_supply 减少 470,010,000 A9。
- M 发 TicketClaim：被拒绝，无转账。

### Phase 9 — R9：破城（单人）与 (e) 第三段解锁

- TargetPriceSet：tier = 5，target = 3,712,000（R8 阵亡）。
- rewardBudgetRaw = 1,050,000,000 A9（7 亿 + R8 滚存 3.5 亿）。
- N 上车 20,000 A9（t0 + 25 分钟，后 1/3，×1.0，weight 20,000）。
- 守城 24 根：全部通过（TWAP = 3,823,000）。
- 链上预期（RoundSettled）：
  - status = SUCCEEDED
  - qualifiedCandles = 24
  - totalAcceptedStakeRaw = 20,000 A9，totalWeightRaw = 20,000
  - rewardBudgetRaw = 1,050,000,000 A9，carryAfterRaw = 0
  - teamReleasedRaw = 120,000,000 A9（R7 挂起的额度），TM 收到 120,000,000 A9
  - teamPending = 120,000,000 A9（R9 的额度）
  - tierAfter = 6
- N 的奖励 = 1,050,000,000 A9（独占）：立即 210,000,000 A9，压城 840,000,000 A9。
- **解锁 R7 的压城 80%**：Q1 与 Q2 各发 TicketClaim。
  - Q1 领取压城 1,866,666,666.66 A9
  - Q2 领取压城 373,333,333.34 A9
- N 发 TicketClaim：领取本金 20,000 + 立即 210,000,000 A9 = 210,020,000 A9。压城 840,000,000 A9 保留在攻城令上（R9 是最后一次破城，之后只能靠第 10 城结果）。

### Phase 10 — R10：(h) 第 10 城阵亡与 30 天解锁

**10.1 开城**

- TargetPriceSet：tier = 6，target = 7,424,000。
- rewardBudgetRaw = 700,000,000 A9（R9 破城，carry = 0）。

**10.2 上车**

- O 上车 10,000 A9（t0 + 2 分钟，×1.5，weight 15,000）。

**10.3 守城与判定（阵亡，第 10 城）**

- 守城 24 根：0–9 通过（TWAP = 7,647,000），10–23 未通过（TWAP = 6,681,600）。通过 10 根。
- 链上预期（RoundSettled）：
  - status = FAILED_PERMANENT
  - qualifiedCandles = 10
  - rewardBudgetRaw = 700,000,000 A9
  - 阵亡时 carry 一半（350,000,000）滚入 carry，然后因为是第 10 城，carry 全部并入销毁：rewardBurnRaw = 350,000,000 + 350,000,000 = **700,000,000 A9**
  - teamBurnRaw = 120,000,000 A9
  - principalBurnRaw = 10,000 A9
  - carryAfterRaw = 0
  - endAt = 结算时间（非 0）
  - teamReleasedRaw = 0；teamPending 保持 R9 的 120,000,000 A9
- total_supply 减少 820,010,000 A9（700,000,000 + 120,000,000 + 10,000）。
- `get_protocol_state`：endAt ≠ 0，carry = 0，successCount = 5，currentRoundId = 10。

**10.4 第 10 城结束后的检查（h）**

- **立即部分已经发出**：N 的 210,000,000 A9（Phase 9）。
- **t = endAt（刚结束）的压城解锁为 0%**：
  - N 发 TicketClaim（只有压城可领，且为 0）。预期：被拒绝（无可领），攻城令 pending 清除，无转账。
  - `get_reward_preview(9, 20000)` 的 unlockedLockedRaw 预期为 0。
- **t = endAt + 约 1 小时的线性解锁**：
  - 预期 unlockedLockedRaw ≈ 840,000,000 × 1 ÷ 720 ≈ **1,166,666.67 A9**（30 天 = 720 小时）。
  - 只做预览，不发 TicketClaim（避免在演练中把数字用掉）。如果要领取，记录领取额与预期的偏差。
- **30 天全额解锁**：不在本演练内，由本地测试覆盖（见 §7）。

**10.5 团队最终释放的负面用例**

- 任何人调用 ReleaseTeam（≥ 0.1 TON）。预期：被拒绝（endAt + 30 天之前），无转账，teamPending 仍为 120,000,000 A9。
- 30 天后的成功释放：可选的后续检查，记录日期，不在本演练 10 城内。

**10.6 对外状态**

- `GET /api/rounds` 显示第 10 城已结束，不能再开新城；UI 显示"十城已完"。
- 发布最终公告（成功或阵亡，按城的结果）。

---

## 5. 结果表（模板）

每一行都要填写交易哈希。"通过 / 不通过" 只能在链上结果与预期完全一致时写"通过"。偏差写在"备注"里，并进入 §8。

### 5.1 链上结果

| 编号 | 场景 | 城 / 步骤 | 交易哈希 | 预期（链上） | 实际 | 通过 / 不通过 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0-1 | 部署后配置回读 | Phase 0 | | abortTimeoutSeconds = 900（占位），时长与阈值正确 | | | |
| P0-2 | TON Proof 登录 + Bearer 写入（k） | Phase 0 | | Bearer 写入成功；无 token 或伪造 token 被拒 | | | |
| P0-3 | 注资 RC（82 亿，forward 0） | §2 | | RC 余额 8,200,000,000 A9 | | | |
| P1-1 | 开 R1 | R1 | | TargetPriceSet tier 1、target 232000 | | | |
| P1-2 | A 上车（10,000，前 1/3） | R1 | | DepositAccepted weight 15,000 | | | |
| P1-3 | B 上车（20,000，中 1/3） | R1 | | DepositAccepted weight 24,000 | | | |
| P1-4 | C 上车（30,000，后 1/3） | R1 | | DepositAccepted weight 30,000；totalWeight 69,000 | | | |
| P1-5a | 500 A9 上车，附 0.15 TON（低于最低额，负面用例） | R1 | | DepositRefunded（instant），500 A9 原路退回 | | | |
| P1-5b | 500 A9 上车，附 0.05 TON（负面用例，按规则不退） | R1 | | 不退回（没有退款账本）；记录实际余额变化 | | | |
| P1-6 | 16 根破城 | R1 | | RoundSettled：SUCCEEDED，qualified 16，teamReleased 0，pending 120,000,000 | | | |
| P1-7 | B 领取（本金 + 立即） | R1 | | Claimed：principal 20,000，reward 48,695,652.17 A9 | | | |
| P1-8 | C 领取（本金 + 立即） | R1 | | Claimed：principal 30,000，reward 60,869,565.22 A9 | | | |
| P2-1 | 开 R2 | R2 | | TargetPriceSet tier 2、target 464000 | | | |
| P2-2 | A 续战（d） | R2 | | Restaked（10,000，weight 15,000）；A 收到 30,434,782.61 A9 | | | |
| P2-3 | A 二次续战负面用例 | R2 | | 被拒绝，pending 清除 | | | |
| P2-4 | D 上车（5,000，中 1/3） | R2 | | DepositAccepted weight 6,000 | | | |
| P2-5 | 15 根阵亡（b） | R2 | | RoundSettled：FAILED，rewardBurn 350,000,000，teamBurn 120,000,000，principalBurn 15,000，carryAfter 350,000,000 | | | |
| P2-6 | total_supply 下降 | R2 | | 9,529,985,000 A9 | | | |
| P2-7 | D 阵亡后领取 | R2 | | 被拒绝，无转账 | | | |
| P3-1 | 开 R3 | R3 | | TargetPriceSet tier 2、target 464000；rewardBudget 1,050,000,000 | | | |
| P3-2 | F 为 E 上车（g） | R3 | | DepositAccepted owner E，weight 45,000；F 无 R3 攻城令 | | | |
| P3-3 | G 上车（20,000，中 1/3） | R3 | | DepositAccepted weight 24,000 | | | |
| P3-4 | H 通过 STON.fi 一键上车（g） | R3 | | DepositAccepted owner H，weight 10,000（若 STON.fi 不能设受益人，记未演练） | | | |
| P3-5 | 20 根破城 | R3 | | RoundSettled：SUCCEEDED，teamReleased 120,000,000，TM +120,000,000，pending 120,000,000，tier 3 | | | |
| P3-6 | E / G / H 领取立即部分 | R3 | | E 119,620,253.16；G 63,797,468.35；H 26,582,278.48（另加本金） | | | |
| P3-7 | A 领取 R1 压城（e） | R3 | | 121,739,130.43 A9（仅压城） | | | |
| P3-8 | B 领取 R1 压城（e） | R3 | | 194,782,608.70 A9 | | | |
| P3-9 | C 领取 R1 压城（e） | R3 | | 243,478,260.87 A9 | | | |
| P3-10 | 军饷 SetRoot listId 1（i） | R3 | | 合约 root = API root；分发余额 = 清单总额 | | | |
| P3-11 | 军饷领取（A 的一笔） | R3 | | 收到累计额；ClaimRecord 已领 = 累计额 | | | |
| P3-12 | 军饷重放 | R3 | | 被拒绝，无转账 | | | |
| P4-1 | 开 R4 | R4 | | tier 3、target 928000 | | | |
| P4-2 | I、J 上车 | R4 | | DepositAccepted：I weight 30,000，J weight 12,000 | | | |
| P4-3 | 3 根后 keeper 停机 | R4 | | candlesSeen 3；无 RoundSettled；candle_lag 告警 | | | |
| P4-4 | 观察超时前调用 AbortTechnical（负面） | R4 | | revert，无状态变化 | | | |
| P4-5 | 观察超时后 AbortTechnical（f） | R4 | | TechnicalAborted reason 2；carry 700,000,000；burn 0；tier 3 | | | |
| P4-6 | I 领回本金 | R4 | | 收到 20,000；reward 0 | | | |
| P4-7 | J 领回本金 | R4 | | 收到 10,000；reward 0 | | | |
| P5-1 | 集结超时前调用 AbortTechnical（负面） | R5 | | revert | | | |
| P5-2 | 集结超时后 AbortTechnical（f'） | R5 | | TechnicalAborted reason 3；carry 1,400,000,000；tier 3 | | | |
| P6-1 | 开 R6 | R6 | | tier 3、target 928000；rewardBudget 2,100,000,000 | | | |
| P6-2 | 零人攻城并 CloseStaking（c） | R6 | | totalStake 0；上车次数 0 | | | |
| P6-3 | 20 根破城（0 人） | R6 | | RoundSettled：SUCCEEDED，carryAfter 2,100,000,000，teamReleased 120,000,000，tier 4 | | | |
| P6-4 | 军饷旧根失效（i） | R6 | | listId 1 的证明被拒；listId 2 的增量领取 | | | |
| P7-1 | 开 R7 | R7 | | tier 4、target 1,856,000；rewardBudget 2,800,000,000 | | | |
| P7-2 | Q1、Q2 上车 | R7 | | Q1 weight 60,000；Q2 weight 12,000 | | | |
| P7-3 | 20 根破城 | R7 | | RoundSettled：SUCCEEDED，teamReleased 120,000,000，tier 5 | | | |
| P7-4 | Q1、Q2 领取立即部分 | R7 | | Q1 466,666,666.67；Q2 93,333,333.33（另加本金） | | | |
| P7-5 | E、G、H 领取 R3 压城（e） | R7 | | E 478,481,012.66；G 255,189,873.42；H 106,329,113.93 | | | |
| P8-1 | 开 R8；M 上车 | R8 | | tier 5、target 3,712,000；weight 15,000 | | | |
| P8-2 | 10 根阵亡（b 第二次） | R8 | | rewardBurn 350,000,000；teamBurn 120,000,000；principalBurn 10,000；carryAfter 350,000,000 | | | |
| P8-3 | total_supply 下降 | R8 | | 9,059,975,000 A9（9,529,985,000 − 470,010,000） | | | |
| P8-4 | M 领取（阵亡后） | R8 | | 被拒绝，无转账 | | | |
| P9-1 | 开 R9；N 上车（第三段） | R9 | | tier 5、target 3,712,000；rewardBudget 1,050,000,000；weight 20,000 | | | |
| P9-2 | 24 根破城 | R9 | | RoundSettled：SUCCEEDED，teamReleased 120,000,000，tier 6，carry 0 | | | |
| P9-3 | Q1、Q2 领取 R7 压城（e） | R9 | | Q1 1,866,666,666.66；Q2 373,333,333.34 | | | |
| P9-4 | N 领取本金 + 立即 | R9 | | principal 20,000；reward 210,000,000 | | | |
| P10-1 | 开 R10；O 上车 | R10 | | tier 6、target 7,424,000；rewardBudget 700,000,000；weight 15,000 | | | |
| P10-2 | 10 根阵亡，第 10 城（h） | R10 | | rewardBurn 700,000,000；teamBurn 120,000,000；principalBurn 10,000；carry 0；endAt ≠ 0 | | | |
| P10-3 | total_supply 下降 | R10 | | 8,239,965,000 A9 | | | |
| P10-4 | N 在 endAt 时领取压城（h，t = 0） | R10 | | 被拒绝（可领为 0），无转账 | | | |
| P10-5 | get_reward_preview 在 endAt + 1 小时（h） | R10 | | unlockedLockedRaw ≈ 1,166,666.67 A9 | | | |
| P10-6 | ReleaseTeam 在 endAt + 30 天之前（负面） | R10 | | 被拒绝，无转账 | | | |

### 5.2 API / UI 检查

| 编号 | 检查 | 对应城 / 步骤 | 预期 | 实际 | 通过 / 不通过 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| A-1 | `/api/rounds` 与链上 RoundSettled 一致 | 每城 | 状态、档位、目标价、奖池与链上一致 | | | |
| A-2 | 三段时机标签 | R1 | 显示 1.5 / 1.2 / 1.0；与 weightRaw 一致 | | | |
| A-3 | 破城进度条 | R1、R2 | `还差(USD) = 池中 USDT × (√(城门价 / 现价) − 1)`；现价 ≥ 城门时显示 0 并切到守城视图 | | | |
| A-4 | 亮灯（24 盏，16 盏亮） | R1 | 页面与群消息一致 | | | |
| A-5 | 亮灯（阵亡 15 盏） | R2 | 页面与群消息一致 | | | |
| A-6 | 攻城令显示（受益人） | R3 | E 显示攻城令，F 不显示 | | | |
| A-7 | 压城解锁显示 | R3、R7、R9 | 解锁额与 get_reward_preview 一致 | | | |
| A-8 | 技术终止显示 | R4、R5 | 页面显示"技术终止"，本金可领，不显示销毁 | | | |
| A-9 | 零人破城显示 | R6 | 显示"无人上车，照常守城"，结果为破城 | | | |
| A-10 | 军饷清单 | R3、R6 | `GET /api/social/payout/latest` 的 root、总额、listId 与合约一致 | | | |
| A-11 | 军饷证明 | R3 | `GET /api/social/payout/proof?wallet=<A>` 的累计额与证明可用 | | | |
| A-12 | 战队榜 / 个人榜 | R1、R3 | 排名基于链上 weightRaw，不因快速档时间段错位 | | | |
| A-13 | 6 小时战队摘要 | UTC 整点的攻城期（如有） | 摘要发送到战队群；若本演练窗口不含整点攻城期，记为未演练 | | | |
| A-14 | X 分享卡 PNG | Phase 0 | `/og/<code>.png` 可打开，数字与当前 API 一致 | | | |
| A-15 | 邀请绑定 | Phase 0 | 首次绑定后不可改 | | | |
| A-16 | 群内 /team | Phase 0 | 群变为战队，bot 有回复 | | | |
| A-17 | 十城完结显示 | R10 | 显示已结束，不能开新城 | | | |

---

## 6. 最终代币守恒检查

所有检查都用链上数据，不用本地账本。

### 6.1 总供应量

- 期望：`total_supply = 10,000,000,000 A9 − 累计销毁`。
- 累计销毁（三项合计）：
  - R2：350,000,000 + 120,000,000 + 15,000 = 470,015,000
  - R8：350,000,000 + 120,000,000 + 10,000 = 470,010,000
  - R10：700,000,000 + 120,000,000 + 10,000 = 820,010,000
  - 合计：**1,760,035,000 A9**
- 期望 total_supply = **8,239,965,000 A9**。
- 实际：________ ；通过 / 不通过：________

> 前提：本演练使用全新部署的 JettonMaster。如果复用了已有的 Jetton，用"演练开始时的 total_supply − 累计销毁"代替 1e10。

### 6.2 奖池守恒（reward pool）

- 基础奖池：10 城 × 7 亿 = 7,000,000,000 A9。
- 已分配（立即 + 压城，按 RoundSettled 与攻城令领取汇总）：
  - R1：700,000,000
  - R3：1,050,000,000
  - R7：2,800,000,000
  - R9：1,050,000,000
  - 合计：**5,600,000,000 A9**
- 已销毁（rewardBurn）：R2 350,000,000 + R8 350,000,000 + R10 700,000,000 = **1,400,000,000 A9**
- carry 结束余额：0
- 核对：5,600,000,000 + 1,400,000,000 + 0 = **7,000,000,000 A9** = 基础奖池。
- 实际：________ ；通过 / 不通过：________

### 6.3 团队额度守恒

- 每城 1.2 亿，10 城共 1,200,000,000 A9。
- 去向：
  - 已转给 TM：R1、R3、R6、R7 的额度（R3、R6、R7、R9 结算时转出）= 4 × 120,000,000 = **480,000,000 A9**
  - 已销毁：R2、R8、R10 = 3 × 120,000,000 = **360,000,000 A9**
  - 挂起（R9 的额度，等下一次破城）：**120,000,000 A9**
  - 未分配（R4、R5 技术终止，额度留存在 RC）：2 × 120,000,000 = **240,000,000 A9**
- 核对：480 + 360 + 120 + 240 = 1,200（百万 A9）。
- 实际 TM 余额增量（演练期间）：________ ；通过 / 不通过：________

### 6.4 本金守恒

- 新上车本金合计（不含续战转入）：
  - R1：60,000；R2：5,000；R3：60,000；R4：30,000；R7：50,000；R8：10,000；R9：20,000；R10：10,000
  - 合计：**245,000 A9**
- 已返还本金（领取）：B 20,000 + C 30,000 + E 30,000 + G 20,000 + H 10,000 + I 20,000 + J 10,000 + Q1 40,000 + Q2 10,000 + N 20,000 = **210,000 A9**
- 已销毁本金：R2 15,000 + R8 10,000 + R10 10,000 = **35,000 A9**
- 核对：210,000 + 35,000 = **245,000 A9**。A 的 R1 本金经 R2 续战后计入 R2 销毁，不重复计入。
- 未领取本金：**0**（所有攻城令都已领取或被销毁）。
- 实际：________ ；通过 / 不通过：________

### 6.5 RC 余额期望

按 `03_monitoring_alerting.md` §4.1 计算：

```text
RC 余额期望 = 8,200,000,000
            − 已释放团队额度 480,000,000
            − 已销毁的奖励与团队额度（1,400,000,000 + 360,000,000）
            − 已领取的奖励（5,600,000,000 − 840,000,000 未解锁的 N 压城）
            + 未领取本金 0
          = 1,200,000,000 A9
```

- 期望余额 1,200,000,000 A9 的组成：
  - R4、R5 未分配的团队额度：240,000,000
  - R9 挂起的团队额度：120,000,000
  - N 未解锁的压城（R9）：840,000,000
- 实际 RC 余额：________ ；通过 / 不通过：________

### 6.6 其他持有者核对

- `total_supply − RC 余额 − TM 余额增量` = 其他持有者合计（包括 treasury、内盘、流动性、营销、测试钱包、STON.fi 池、分发合约）。
- 期望：`8,239,965,000 − 1,200,000,000 − 480,000,000 = 6,559,965,000 A9`。
- 前提：T 的分配按计划执行（剩余 18 亿，即内盘 8 亿、流动性 5 亿、营销 5 亿）；测试钱包分发与军饷注资都属于"其他持有者"，不改变合计。
- 实际：________ ；通过 / 不通过：________

### 6.7 守恒结论

- 6.1–6.6 全部通过：本演练代币守恒。
- 任一项不通过：停止，不得对外公布数字，按 P0 处理（见 `02_round_operations.md` §11）。

---

## 7. 覆盖说明：未在链上演练的部分

| 场景 | 处理 | 理由 |
| --- | --- | --- |
| 主网参数下的 7 天技术终止超时 | 本地测试覆盖 | 演练只能用快速档的短超时 |
| 第 10 城之后 30 天的全额线性解锁 | 本地测试覆盖 | 测试网不能等 30 天；本演练只验证立即部分、t = 0 为 0%、t = 1 小时的近似值 |
| ReleaseTeam 成功释放（endAt + 30 天后） | 本地测试覆盖；可选的后续检查（30 天后用同一测试网实例补做） | 同上 |
| 6 小时战队摘要 | 条件演练（见 A-13） | 快速档攻城期很短，可能遇不到 UTC 整点 |
| STON.fi 一键上车的受益人字段 | 若测试网界面不支持，记为未演练 | 依赖 STON.fi 测试网的前端能力，不替代 |
| 结算重试（RetrySettlement） | 不在本演练 10 城内；若出现 SettlementBounced，按 `02_round_operations.md` §3.6 处理并补记 | 本演练不人为制造退回 |
| 军饷 6 个月以上的累计增长 | 本地测试覆盖 | 本演练只跑 3 轮清单 |
| 结算退回（SettlementBounced）的自动恢复 | 不自动；出现即人工 retry-settlement | keeper 不自动重试破城轮的团队额度退回（见 §1.3 限制 1） |
| R10 的 carry 销毁在运营台账中的对账 | 台账差异属已知限制 | 以 R10 RoundSettled 事件（rewardBurnRaw = 7 亿）为准（见 §1.3 限制 2） |
| 受益人上车的脚本路径 | 仅 STON.fi 界面；不支持则未演练 | user_op 的 beneficiary 固定为付款人（见 §1.3 限制 3） |

---

## 8. 发现问题

| # | 问题 | 影响 | 根因 | 改进 | 负责人 | 截止 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | |
| 2 | | | | | | |

---

## 9. 结论与签字

- [ ] 通过（可进入下一阶段）
- [ ] 有条件通过（需先完成改进项：________）
- [ ] 不通过（阻塞上线）

签字：操作 ______  复核 ______  Lead ______  日期 ______

---

*本演练记录归档到 `ops/records/`（交易哈希、事件、对账输出）与本文件同目录的结果表。*

---

## 附录 R：第一次测试网实跑记录（2026-11-07，极速档 10/30/10×24/60/60）

部署：JettonMaster `kQDNyvApbpZNibyuLHuoj3XqbNUdu2ldurxO-WsyVIop9Kag` · RoundController `kQBfMft6yykyzkcmpMsRpI3zqQAXEQDGwmbpgABEsQlyZYZf` · JunxiangDistributor `kQCyTbjVfO1kkS0Pzl-iUnejsUgPfivj-ycRhR_Z6KNnFb8k` · Worker `https://a9-testnet.348421501.workers.dev`（D1 `a9-testnet`）。keeper 模式 mixed（S,F,S,S,S,F,S,S,F,S）。

| 城 | 结果 | 上车 | 奖池（亿） | 链上核对 |
| --- | --- | --- | --- | --- |
| R1 | 破城 | 0 | 7 | 奖池全额滚存，R2 开城奖池 14、tier 2 ✅（场景 c） |
| R2 | 失败 | A ×1.2、B ×1.0 | 14 | 销毁 8.202 = 7 + 1.2 + 0.002；R3 奖池 14 ✅（场景 b、a 时机系数） |
| R3 | 破城 | A | 14 | A 领 本金 + 2.8（20%），锁定 11.2；团队钱包收到 R1 的 1.2 ✅（场景 e 前半） |
| R4 | 破城 | 0 | 7 | R3 锁定 11.2 全额解锁；A 领取后余额 14.009 亿 ✅（场景 e） |
| R5 | 破城 | 0 | 14 | 滚存 ✅ |
| R6 | 失败 | 0 | 21 | 销毁 10.5 + 1.2 ✅ |
| R7 | 破城 | 0 | 17.5 | 滚存 ✅ |
| R8 | 破城 | 0 | 24.5 | 滚存 ✅ |
| R9 | 失败 | 0 | 31.5 | 销毁 15.75 + 1.2 ✅ |
| R10 | 破城 | 0 | 22.75 | endAt 写入，剩余滚存 22.75 全部销毁 ✅（场景 h 前半） |

最终守恒（链上读取）：total_supply = **40.398 亿**（销毁合计 59.602 亿）；团队钱包 **8.4 亿**（7 次破城 × 1.2，最后一笔 ReleaseTeam 在 endAt + 60s 前被拒（exit 208）、之后成功）；RC 余额 **0**。与手算完全一致。

发现并修复的问题（均在演练脚本，合约无缺陷）：runner 硬编码旧 Jetton master（RC 正确以 exit 104 拒收）；窗口关闭后仍重试质押（改为提前 6s 截止）；读回失败即退出（改为记录后继续）。

未覆盖（30 秒攻城期只够 1–2 人上车，需 90 秒攻城期重新部署后补跑）：多人按战力分奖、一键续战 (d)、受益人与 STON.fi 一键上车 (g)、技术终止 (f)、第 10 城有人上车时的 60 秒线性解锁 (h 后半)、军饷全流程 (i)、社交 (j，需 BotFather 配置 Mini App)、TON Proof (k，需人工钱包签名)。

## 附录 R2：第二次测试网实跑（2026-11-07，攻城期 90 s，其余同极速档）

部署：JettonMaster `kQActKc_feFVN7n95a_yrCCtd9SACBCN2zBinFq2dXijx374` · RoundController `kQCd9wdjTc9TTcRwNozpfDtzrF_QBtllQX-yO_a1m5-3_5Tt` · JunxiangDistributor `kQBKpzusd8LanpLhoSsYg3U64C1zKgJ0sXVSmipkNWltViNi` · D1 `a9-testnet-run2`。

| 场景 | 链上结果 |
| --- | --- |
| (a) 多人按战力分奖 | R1：A ×1.5、B ×1.5、C ×1.2 → 2.5 / 2.5 / 2.0 亿，合计正好 7 亿，各自 20% 即领 ✅ |
| (d) 一键续战 | 玩家 D：R3 上车 → R4 攻城期续战，R3 攻城令 principalDone=true、R4 攻城令 10 万 A9 ×1.5（续战落在第一档）；D 最终余额 333,172,546.230441 A9 = R3 20% + R3 80%（R4 破城解锁）+ 本金 + R4 20%，逐位吻合 ✅ |
| (f) 技术终止 | R8 开城后不提交 K 线，观察结束 +60 s 由普通玩家钱包调用 AbortTechnical → 状态 10、奖池 7 亿全额滚存、successCount 不变；A/B/C 经攻城令取回本金 ✅ |
| (h) 第 10 城后 60 s 线性解锁 | 结束后约 6 s / 10 s / 15 s 领取分别拿到压城部分的 10% / 17% / 25%；60 s 后 A 再领，lockedClaimed = 2 亿（100%） ✅ |
| (i) 军饷全流程 | compute R1–R7 → 累计清单 listId 1（4 个钱包、合计 130,000 A9）→ 先注资分发合约 → SetRoot → A 凭 2 个兄弟哈希领取 24,000 A9，金额精确；同一证明重放被拒、余额不变 ✅（链下 Merkle 与链上校验逐字节一致） |
| 团队额度 | 7 次破城 × 1.2 = 8.4 亿到团队钱包（R10 的一笔在 endAt + 60 s 后释放） ✅ |

RC 余额 46.66 亿为玩家已解锁但演练脚本未回领的压城奖励及 R8 留存团队额度（D-39），属预期；完整守恒已在第一次实跑中核对到 0。

本轮发现的脚本问题：keeper `--rounds N` 把已结算的当前城计入 N；并发 acton 调用偶发 exit 400（重试即可）；runner 在结算瞬间就领取，续战需用不受 runner 驱动的钱包。合约无缺陷。

仍需人工：BotFather 配置 Mini App（社交 j）、Tonkeeper 测试网钱包签名（TON Proof k）、STON.fi 测试池与一键上车 / 受益人上车（g）。

## 附录 S — 内盘（GRAM 预售）到账与 A9 发放演练（2026-11-07，测试网）

工具：`ops/scripts/internal_sale.mjs`（扫描到账 → 预览 → 确认后发 A9；按付款 tx 去重；8 亿硬上限；账本 `ops/records/internal-sale-<net>-<wallet>.json`）。
内盘收款钱包：a9-internal `kQDCyYrTE6EOr1wMq3VHh9wF7KaTFQCU0oHVy_IbQK1UGwZd`；比例 1 GRAM = 1000 A9（部署前确认）。

| 场景 | 操作 | 结果 |
|---|---|---|
| 无附言付款 | a9-test-b 付 1.2 GRAM | 到账 1.199933333 GRAM（转账手续费由发送额扣除）→ 发 1,199.933 A9 回付款地址；B 余额 +1,199.933069927 ✅ |
| 附言代买 | a9-test-c 付 1.5 GRAM，附言 = a9-test-a 地址 | 到账 1.499898932 GRAM → 发 1,499.898 A9 给 A；C 的 A9 不变 ✅ |
| 内盘钱包扣减 | — | 333,172,546.230 → 333,169,846.398，减少 2,699.832 = 两笔之和 ✅ |
| 防重复 | 发放后重跑（OPS_EXECUTE=1） | 「已发 2 笔、待发 0 笔」，未重复发 ✅ |
| 超卖拒绝 | `--cap 2000` 预览 | 「累计 2,699.832 A9 将超过上限 2,000」，退出码 3，不发币 ✅ |

口径：按**实际到账**金额计算应发 A9（买家钱包若由转账额扣手续费，会比输入额略少）；主网对外说明「以到账为准」。

## 附录 T — 生产价格 keeper 演练（2026-11-07，测试网 run 3）

实例：RC `kQCutdqSZTxcPEky3QdeSdr1dZioI4cohwjD3mA9O4DAWKSw`，master `kQCH62KISQOLAt9W6m4C9P_VLEjnNiuLkKWe_OLNXKzSAHJe`（快测档 10/90/10×24，部署用新的显式角色 + `A9_ALLOW_FAST_TIMING=1`）。
keeper：`--price mock`（测试网无 STON.fi 池），采样 5s；价格 116000 开轮 → 700000（R1）→ 150000（R2）。

| 检查 | 结果 |
|---|---|
| R1 开轮 twap24h | 116000 → 目标 max(P0×2, 2×116000) = 232000 ✅ |
| R1 判定 | 24/24 达标，SUCCEEDED ✅ |
| R2 开轮 twap24h | 683121（样本时间加权）→ 目标 ≥ 1,366,242 ✅ |
| R2 判定 | 0/24 达标，FAILED_PERMANENT ✅ |
| 链上 vs 证据 | R1 24 根 CandleSubmitted 的 twap 与 dataDigest 与 `price-evidence-testnet/r1-c*.json` 全部一致（24/24）；样本复算 TWAP 与摘要一致 ✅ |
| 主网保护 | mainnet 参数下 `--mode`/`--price mock` 被拒，`--price pool` 缺 `--pool` 被拒 ✅ |
| 池读取（主网只读） | STON.fi v2 池 `EQBbsMjy…sNGO`：储备与 STON.fi API 完全一致，价格 $0.4468 ✅ |
| 修复 | 采样定时器导致进程不退出 → 完成后 `process.exit(0)` |

## 附录 U — 审计修复后测试网回归（2026-11-07，run 4）

实例（修复后代码，RC 0x1037BACD…D226 / StakeTicket 0xB04B6A61…4F91 / Distributor 0x9E07E813…42D8 / ClaimRecord 0x8DB60A5B…8D61）：
RC `kQAJkMJk64vy_n1Re2AjvZCIy0ZLuS-GYuCxMbOvZke9Gx-G`，master `kQAJwLiSWw56spCD1-5nTj1E_AM25mcq_bfavVxrev8Mb0ms`，distributor `kQB8aeEwnCU2cz63qtXk0EpKhmJ6l8OjOW30CO5i91wbVifr`（部署只给 1 / 0.2 GRAM，验证不依赖合约自有余额）。

| 检查 | 结果 |
|---|---|
| R1 三人质押 100k（A/B 早段 ×1.5，C ×1.2）→ 破城 24/24 | 读回全部正确；领取 3/3 成功，攻城令 pending=false ✅ |
| R1 奖励 | A/B 各 2.5 亿、C 2.0 亿；20% 立即领取：A/B 5,000 万、C 4,000 万（余额 50.2M / 50.2M / 40.2M，含 R2 已销毁的 100k）✅ |
| R2 三人质押 → 失败 0/24 | 本金 + 奖池一半 + 团队额度销毁；RC A9 余额 = 7,590,000,000（与公式逐位一致）✅ |
| **A9-V11-01 用户承担事件费** | 6 笔质押 + 3 笔领取 + 48 根 K 线后 RC GRAM 0.9999 → 1.4782（未下降）；分发合约 0.2 → 0.2997 ✅ |
| 军饷领取（单叶树，24,000 A9） | A 收到 24,000，totalPaid = 24,000 ✅ |
| **A9-V11-03 重复领取退款** | 重复领取附 0.2 GRAM，净花费 0.0013 GRAM（修复前 0.2 全部滞留）✅ |
