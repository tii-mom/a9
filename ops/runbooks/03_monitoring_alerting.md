# 03 — A9 测试网监控与告警方案（v11）

**版本**：v11（2026-11-07）
**Owner**：testnet-ops
**关联**：`ops/scripts/monitor_check.mjs`、`ops/scripts/reconcile.mjs`（见 `ops/README.md` §2、§7）、`04_key_custody_admin.md`、`02_round_operations.md`

---

## 1. 目标与原则

1. **只以链上为最终事实**：Worker API 与数据库是展示和索引层，差异以链上对账为准。
2. **先止损，后定位**：P0 先停前端入口、停 keeper 提交、发公告，再排查。
3. **告警必须可执行**：每条告警带级别、指标、当前值、阈值、处置动作。没有处置动作的指标只放看板，不做告警。
4. **不泄露敏感信息**：告警内容不含助记词、私钥、API key、未公开钱包地址。地址统一用登记表中的公开地址。
5. **测试网即主网演练**：值班、双人复核、事故分级在测试网按主网标准执行。

---

## 2. 监控架构

```text
TON testnet（链上）                         Worker API + D1（索引与展示）
JettonMaster / RC / RC 钱包 / 分发合约        /api/health  /api/rounds  /api/social/*
keeper 余额 / Telegram webhook                  │ HTTPS
        │ Toncenter（只读）                       │
        ▼                                        ▼
   监控脚本（每 1~5 分钟）
   指标检查 → P0 / P1 / P2 / P3 → Telegram / 邮件 / 值班
        │ 每城 / 每日
        ▼
   对账脚本（对账 CSV）→ 财务 / Lead 复核
```

- **采集**：链上指标通过登记表地址 + Toncenter 查询。事件级指标（SettlementBounced、UnexpectedBounce、RoundSettled、TechnicalAborted）以链上事件为准。
- **频率**：P0 / P1 指标 1–5 分钟一次；对账每城一次、每日一次；KPI 看板每城更新。
- **无状态**：脚本只输出告警与对账文件，不写业务数据。去重靠 cron 间隔与人工。

---

## 3. 指标、阈值与告警

<a id="P0"></a>
### 3.1 P0（资金或供应量风险；15 分钟内响应，7×24）

| ID | 指标 | 数据源 | 阈值 | 处置 |
| --- | --- | --- | --- | --- |
| monitor.worker.health | Worker `/api/health` 是否 ok | API | ok = false | 检查 Worker 与数据库；必要时降级页；30 分钟未恢复升级 Lead |
| monitor.supply.drift | 账本供应量 vs 1e19 − 累计销毁（三项合计） | API / 对账 | ≠ 0 | 停止对外披露；全量对账；保留现场；Lead + 财务 |
| monitor.supply.chain_drift | 账本 vs 链上 total_supply | Toncenter | ≠ 0 | 同上；以链上为准，检查漏记的销毁 |
| monitor.rc.balance.drift | RC 余额 vs 期望公式（见 §4.1） | Toncenter / 对账 | ≠ 0 | 停止对外披露；核对 RoundSettled、Claimed、TeamReleased 事件；Lead + 合约负责人 |
| monitor.distributor.underfunded | 分发合约 A9 余额 vs 最新清单总额 − 已支付总额（见 §4.2） | Toncenter / API | 余额 < 应有额 | 立即停止发根；补足注资后回读；若根已发布，统计受影响领取；Lead + 财务 |
| monitor.keeper.abort_window | 已过观察结束或集结结束，且未达到技术终止超时的剩余时间（见 §4.3） | 链上 | 剩余 < 1 小时且 keeper 无心跳 | 查 keeper；由双人决定是否在超时后 AbortTechnical |

<a id="P1"></a>
### 3.2 P1（轮次推进受阻或结算异常；30 分钟内响应）

| ID | 指标 | 数据源 | 阈值 | 处置 |
| --- | --- | --- | --- | --- |
| monitor.settlement.bounced | SettlementBounced 事件（0x52540110） | 链上事件 | 出现即告警 | 调用 RetrySettlement（≥ 0.3 TON）；记录调用结果；重试后仍有退回则升级 |
| monitor.unexpected.bounce | UnexpectedBounce 事件（0x52540111） | 链上事件 | 出现即告警 | **人工核查**：记录 op 与 queryId；不自动重试；通知合约负责人 |
| monitor.keeper.ton_low | keeper 钱包 TON 余额 | Toncenter | < 2 TON | 补充 gas；keeper 无 gas 时无法开城与提交 K 线 |
| monitor.roundN.candle_lag | 应见 K 线 − 已见 K 线 | API / 链上 | > 1 根 | keeper 补交；连续缺 2 根升级 |
| monitor.roundN.close_overdue | 攻城到点后 1 小时仍未 CloseStaking | API / 链上 | > 1 h | 发送 CloseStaking（双人）；任何人可调用 |
| monitor.next_round.overdue | 集结结束后 1 小时仍未 OpenRound | API / 链上 | > 1 h | 查 keeper 与 gas；发状态更新；abortTimeout 到期后任何人可 AbortTechnical |
| monitor.roundN.abort_eligible | 技术终止条件已满足，但城仍未终止 | 链上 | 满足即告警 | 双人确认后调用 AbortTechnical；发 abort 公告 |
| monitor.tg.webhook | Telegram webhook 健康（见 §4.4） | Telegram `getWebhookInfo` | `last_error_message` 非空，或 `pending_update_count` 持续增长 | 查 Worker 日志与 secret；修复后看 pending 是否回落 |
| monitor.push.failed | 亮灯或战队摘要推送失败数（`bot_pushes`） | D1 | 单城失败 > 0 | 查群权限与 bot 状态；失败项补发 |

<a id="P2"></a>
### 3.3 P2（展示或数据延迟；4 小时内响应）

| ID | 指标 | 数据源 | 阈值 | 处置 |
| --- | --- | --- | --- | --- |
| monitor.roundN.stale | 城数据 15 分钟未更新 | API | > 15 min | 检查索引与缓存；确认页面状态 |
| monitor.rc.ton_low | RC 合约 TON 余额 | Toncenter | < 20 TON | 补充 gas；结算动作依赖 RC 的 TON |
| monitor.rpc_latency | Toncenter p95 | 探针 | > 3 s | 切换 RPC 或配置 API key |
| monitor.worker.p95 | API p95 | Workers 分析 | > 800 ms | 查缓存与查询 |
| monitor.social.bind_rejected | 绑定或写接口的 401 / 403 比例突增 | Worker 日志 | 5 分钟内 > 20% | 查 `SESSION_SECRET`、`TON_PROOF_DOMAINS`、会话过期情况 |

### 3.4 P3（一般缺陷；次工作日）

- 前端文案或倒计时偏差、图表缺根 K 线、日志噪音、非关键 UI 错误。
- 只进缺陷池，不打断轮次，但必须记录并排期。

<a id="bounce"></a>
### 3.5 结算退回与技术终止专项

- **SettlementBounced**：只代表对应的结算转账或销毁被退回，不改变判定结果。调用 RetrySettlement（≥ 0.3 TON）后，核对 teamWallet 收款或 total_supply 变化，并记录。
- **UnexpectedBounce**：不明退回，不自动重试，必须人工核查 op 与 queryId。
- **TechnicalAborted**：任何人可调用，但条件不满足时会 revert。
  - 观察超时（reason 2）：本金可经攻城令领取，奖池全额滚入 carry，档位不变。
  - 集结超时（reason 3）：该城 7 亿滚入 carry，档位不变。
  - 技术终止不销毁任何金额。
- 合约没有暂停功能，因此不存在"暂停计时"告警。

<a id="reconcile"></a>
### 3.6 对账专项

- 每城判定后执行一次对账，每日一次。命令：

  ~~~bash
  node ops/scripts/reconcile.mjs --chain --strict --out ops/records/reconciliation-<日期>.csv
  ~~~

- 第 10 城的 carry 销毁台账未建模，对账会有差异提示。以 RoundSettled 事件为准（见 `02_round_operations.md` §5）。
- 差异 ≠ 0：冻结对外数字 → 人工核对 RoundSettled、Claimed、TeamReleased 事件 → Lead 决策 → 记录事故。
- 对账 CSV 归档到 `ops/records/`。对外只发布链上可验证数字。

---

## 4. v11 新增指标的计算方法

### 4.1 RC 余额期望（carry 留在 RC）

```text
RC 余额期望 = 82 亿
            − 已释放团队额度（所有 TeamReleased 之和）
            − 已销毁的奖励与团队额度（所有 RoundSettled / TechnicalAborted 中的 rewardBurn + teamBurn 之和，不含本金）
            − 已领取的奖励（立即部分与已解锁的压城部分之和）
            + 未领取本金（攻城令上尚未领取、也未销毁的本金）
```

要点：

- **"已销毁"不含本金。** 本金销毁已经从"未领取本金"里扣除，再扣一次就会重复。
- **carry 不扣减。** 滚入下一城的奖池、尚未分配的团队额度（技术终止城留存的部分）都仍然在 RC 余额里。
- 期望值与链上 RC 钱包余额比较，漂移 ≠ 0 即 P0。
- 第 10 城结束后，RC 余额应剩余：未释放的团队额度、未解锁的压城奖励、未领取本金（若有）。

### 4.2 分发合约余额

```text
应有余额 = 最新已发布清单总额 − 分发合约已支付总额
```

- "最新已发布清单总额"取最新一次 SetRoot 对应的清单总额（不是累计历史总额）。
- 余额 < 应有余额：P0。原因通常是注资漏做，或先发根后注资。
- 这是运营规则，不是合约检查：合约不会在 SetRoot 时核对余额。发根前由运营人工确认余额 ≥ 新清单总额 − 已支付总额（见 `02_round_operations.md` §4）。监控负责事后发现。

### 4.3 keeper 活性与技术终止窗口

- **keeper 心跳**：最近一次 OpenRound 或 SubmitCandle 的时间。按城的节奏判断：
  - 集结结束后应在 1 小时内见到 OpenRound；
  - 攻城期内每根 K 线应按时出现（正式档 1 小时，快速档 1 分钟）。
- **技术终止窗口**：
  - 观察超时窗口 = 攻城结束 + 观察时长 + abortTimeoutSeconds
  - 集结超时窗口 = 该城预告结束 + abortTimeoutSeconds
  - 正式档 abortTimeoutSeconds = 604800（7 天）；快速档由部署参数决定（见 drill §1）
- 监控显示每个窗口的剩余时间。剩余 < 1 小时且 keeper 无心跳，按 P0 处理。
- 窗口到期后，任何人都可以 AbortTechnical，但必须经双人确认。

### 4.4 Telegram webhook 健康

每 5 分钟检查：

- Telegram `getWebhookInfo`：
  - `url` 必须等于 Worker 的 `/api/tg/webhook`；
  - `last_error_message` 为空；
  - `pending_update_count` 不持续增长。
- Worker 侧：
  - 带错误 secret 的请求应被拒绝（不得处理）；
  - 最近一小时 webhook 请求数 > 0 时，错误率应接近 0。
- 异常：`url` 错误或 secret 不一致，按 P1 处理；webhook 整体不可用超过 30 分钟，升级为 P0（亮灯与战队功能受影响）。

命令：

~~~bash
curl -s "https://api.telegram.org/bot${TG_BOT_TOKEN}/getWebhookInfo"
cd worker && ./node_modules/.bin/wrangler tail a9-testnet --env testnet --format pretty   # 看 webhook 错误日志
~~~

`TG_BOT_TOKEN` 只放在环境变量里，不要粘贴进命令历史或截图。

---

## 5. 告警分级与响应时限

| 级别 | 定义 | 响应时限 | 升级 | 通知渠道 |
| --- | --- | --- | --- | --- |
| P0 | 资金、供应量、RC 余额漂移、分发合约资金不足、疑似漏洞、密钥异常 | 15 分钟（7×24） | 15 分钟未响应 → Lead；30 分钟 → 项目方 | 电话或 PagerDuty（若有）+ Telegram + 邮件 |
| P1 | 轮次推进受阻、结算退回、keeper 资源不足、webhook 异常 | 30 分钟 | 60 分钟未解决 → Lead + 合约负责人 | Telegram + 邮件 |
| P2 | 展示延迟、RC gas 偏低、RPC 慢、绑定失败突增 | 4 小时 | 次班交接 | Telegram |
| P3 | 一般缺陷 | 次工作日 | 进缺陷池 | 邮件 / 看板 |

**升级路径**：On-call → Ops Lead → 合约负责人 → 项目方。不确定级别时按更高一级处理。

---

## 6. 通知渠道

### 6.1 Telegram（首选）

- Bot 与群：通过环境变量读取（不写入仓库）。
- 测试：用故障夹具验证判定（期望 exit 2），再决定是否发送：

  ~~~bash
  node ops/scripts/monitor_check.mjs --snapshot ops/tests/fixtures/worker-snapshot-bad.json   # 期望 exit 2
  node ops/scripts/monitor_check.mjs --snapshot ops/tests/fixtures/worker-snapshot-bad.json --notify   # 需 Telegram 环境变量，发送前经 Lead 确认
  ~~~
- 内容规范：级别 + 指标 + 当前值 + 阈值 + 处置动作；不含密钥和未公开地址。
- 群分层：ops-alerts（P0 / P1）、ops-daily（P2 / P3 与日报）、comms（公告协调，独立群）。
- 测试网的战队群与运维群分开，告警不发进战队群。

### 6.2 邮件

- 作为 P0 / P1 的备份通道，以及每日日报。
- 主题格式：`[A9][P0] 指标 — 当前值（UTC 时间）`。

### 6.3 静默与抑制

- 计划内维护：提前公告，并手动静默告警，记录开始与结束时间和原因。
- 同一指标 30 分钟内只发一次（靠 cron 间隔与人工去重；升级时人工重发）。
- 禁止长期静默 P0；静默必须由 Lead 批准并记录。

---

## 7. 值班表与轮转

- 班次：日班 08:00–20:00 UTC，夜班 20:00–08:00 UTC；每班 1 主 1 备。
- 攻城期（36 h）与守城期（24 h）必须 7×24 覆盖。集结期可降为 12 h 覆盖，但响应时限仍为 30 分钟。
- 每班交接内容：城状态、K 线进度、最近告警、未确认的链上动作、公告排期、军饷流程进度、待办操作。
- 值班人不得单独执行 keeper 写操作（见 `02_round_operations.md` §2 双人规则）。
- 连续值班不超过 12 小时；夜班后至少休息 12 小时。

---

## 8. 事故响应流程

1. **发现**：告警、人工或 KPI 异常；记录时间（UTC）、指标、初判级别。
2. **分诊（≤ 5 分钟）**：是否资金或供应量风险；P0 立即拉群。
3. **止损（P0 ≤ 15 分钟）**：停止前端质押入口、停止 keeper 提交、停止对外披露；保留现场（截图、哈希、日志）。
4. **定位**：链上状态、事件、交易哈希、日志、对账差异；双人复核结论。
5. **处置**：按预案操作（RetrySettlement、补交 K 线、AbortTechnical、补足分发合约余额等）；写操作双人并留痕。
6. **沟通**：按 `05_announcements.md` 发状态更新；不猜测原因，不承诺时间点。
7. **复盘（P0 / P1 在 24 小时内）**：时间线、根因、影响、修复、预防、责任人、截止日期；写入 incident-log。
8. **改进**：更新监控阈值、预案与脚本；演练验证。

| 事故 | 判定 | 示例 |
| --- | --- | --- |
| INC-P0 | 资金、供应量、RC 余额、分发资金、密钥 | 销毁金额与公式不一致；total_supply 漂移；分发合约余额不足；keeper 私钥疑似泄露；UnexpectedBounce |
| INC-P1 | 轮次无法推进 | K 线缺失、keeper 未开城或未关窗、结算退回、webhook 故障 |
| INC-P2 | 展示或性能 | API 5xx、页面停更、RPC 慢、绑定失败突增 |
| INC-P3 | 一般缺陷 | 文案错误、图表缺根 |

---

## 9. 看板与日志

- **状态看板**：城状态、tier、target、集结与攻城倒计时、K 线进度、keeper 状态、结算退回计数、技术终止窗口剩余时间。
- **财务看板**：total_supply、累计销毁（分项）、RC 余额与期望值、团队释放、压城解锁与领取、分发合约余额与应有额。
- **技术看板**：cron 心跳、API p95 与 5xx、RPC 延迟、RC 与 keeper 的 TON 余额、webhook 状态、亮灯推送失败数、告警计数。
- **日志保留**：Worker 日志与 D1 管理事件 ≥ 90 天；对账 CSV 与告警截图保留至主网后 90 天；keeper 出账记录单独保存。

---

## 10. 部署与调度

- 监控脚本以 cron 或 systemd timer 方式运行。cron 示例（路径与域名替换为实际值）：

  ~~~cron
  */2 * * * *  cd <repo root> && OPS_WORKER_BASE_URL=https://a9-testnet.<subdomain>.workers.dev node ops/scripts/monitor_check.mjs --chain --notify >> ops/records/monitor.log 2>&1
  0 * * * *    cd <repo root> && node ops/scripts/reconcile.mjs --chain --out ops/records/reconciliation-hourly.csv >> ops/records/reconcile.log 2>&1
  ~~~
- 环境变量放入服务器的环境文件（权限 600），不写进仓库。
- 建议的频率：
  - P0 / P1 检查：每 2 分钟
  - 对账：每小时只读，每城判定后一次
  - 日报：每日 10:05 UTC

---

## 11. 演练与验证

- 每月：用故障夹具验证告警链路与分级。夹具：`ops/tests/fixtures/worker-snapshot.json`（正常，期望 exit 0）与 `ops/tests/fixtures/worker-snapshot-bad.json`（故障，期望 exit 2）。
- 每季度：模拟 P0（RC 余额漂移，或分发合约资金不足）全流程：发现 → 分诊 → 止损 → 公告 → 复盘，计时并记录。
- 每次部署后：验证 Toncenter、索引器、对账脚本在真实数据上无漂移。
- 测试网演练按 `ops/drills/2026-11_testnet_v11_10round_drill.md` 执行，演练记录归档到 `ops/drills/`。

---

## 12. 常见误报与处理

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 心跳告警但页面正常 | 缓存或时钟差异 | 核对 `/api/health` 的时间与实际时间；检查服务器时区 |
| K 线缺失告警但链上有数据 | 索引器延迟或缓存 | 等一个周期再确认；检查索引器 |
| RC 余额或 total_supply 漂移告警 | 手工转账，或漏记事件 | 以链上为准，补账本与对账 |
| 分发余额告警但根尚未发布 | 应有额计算用了未发布的清单 | 应有额只看最新已发布清单 |
| SettlementBounced 告警已自动重试成功 | 第一次重试生效 | 确认 teamWallet 收款或 total_supply 变化后关闭告警 |
| keeper.ton_low 告警 | keeper 的 gas 按设计只放少量 | 补充 gas，并确认 keeper 出账仅为预期操作 |
| 快速档下战队摘要没有出现 | 摘要只在 UTC 整点 6 小时的攻城期发送，快速档攻城期很短 | 不是故障；在 drill 中记为未演练 |
| 绑定失败突增 | 会话过期或域名变量错误 | 核对 `SESSION_SECRET` 与 `TON_PROOF_DOMAINS` |

---

## 13. 与合约实现的对应口径

- 判定点是第 24 根 K 线提交，监控以 RoundSettled 事件与链上状态为准。
- 没有提前关窗，没有暂停，也没有单独的结算调用。
- RC 只有一个 Jetton 钱包，托管攻城本金、每城 7 亿奖励，以及 12 亿团队额度（每城 1.2 亿）。没有其他金库地址。
- 攻城令（StakeTicket）不持有 Jetton，只是 RC 验证过的收据。监控不监控攻城令余额。
- SettlementBounced 与 UnexpectedBounce 是唯一的结算退回信号，监控必须订阅。
- 失败城有一笔合并销毁；监控按 RoundSettled 的三项销毁合计核对。
- 技术终止两种 reason（2 观察超时、3 集结超时）都要在 TechnicalAborted 事件里核对。

---

*本方案的指标 ID 与监控脚本对齐；新增或修改指标时同步更新脚本与本表。*
