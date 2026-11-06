# 03 — A9 测试网监控与告警方案（v10）

**版本**：v10（2026-11-06，D-42）
**Owner**：testnet-ops
**关联**：ops/scripts/monitor_check.mjs、reconcile.mjs；04（密钥与操作）；02（轮次 SOP）

---

## 1. 目标与原则

1. **只以链上为最终事实**：Worker API 与数据库是展示和索引层，任何差异以链上对账为准。
2. **先止损后定位**：P0 先停前端入口、停止 keeper 提交、发公告，再排查。
3. **告警必须可执行**：每条告警带级别、指标、当前值、阈值、处置动作。没有处置动作的指标只放看板，不做告警。
4. **不泄露敏感信息**：告警内容不含助记词、私钥、API key、未公开钱包地址。地址统一用登记表中的公开地址。
5. **测试网即主网演练**：值班、双人复核、事故分级在测试网按主网标准执行。

---

## 2. 监控架构

~~~text
TON testnet（链上）                    Worker API + D1（索引与展示）
JettonMaster / RC / RC 钱包 / keeper    /api/health  /api/rounds
        │ TON Center v2/v3（只读）              │ HTTPS
        ▼                                      ▼
   monitor_check.mjs（每 1~5 分钟）
   指标检查 → P0 / P1 / P2 / P3 → Telegram / 邮件 / 值班
        │ 每轮 / 每日
        ▼
   reconcile.mjs（对账 CSV）→ 财务 / Lead 复核
~~~

- **采集**：monitor_check.mjs 读取 Worker API；链上指标通过登记表地址 + TON Center 查询。事件级指标（SettlementBounced、UnexpectedBounce、RoundSettled）以链上事件为准。
- **频率**：P0 / P1 指标 1~5 分钟一次；对账每轮 1 次，每日 1 次；KPI 看板每轮更新。
- **无状态**：脚本不写业务数据，只输出告警与对账文件；去重靠 cron 间隔与人工。

---

## 3. 指标、阈值与告警

<a id="P0"></a>
### 3.1 P0（资金或供应量风险；15 分钟内响应，7×24）

| ID | 指标 | 数据源 | 阈值 | 处置 |
| --- | --- | --- | --- | --- |
| monitor.worker.health | Worker /api/health 是否 ok | API | ok = false | 检查 Worker 与数据库；必要时降级页；30 分钟未恢复升级 Lead |
| monitor.supply.drift | 账本供应量 vs 1e19 − 累计销毁 | API / reconcile | ≠ 0 | 停止对外披露；全量对账；保留现场；Lead + 财务 |
| monitor.supply.chain_drift | 账本 vs 链上 total_supply | TON RPC | ≠ 0 | 同上；以链上为准，检查漏记的销毁 |
| monitor.rc.vault.drift | RC 钱包余额 vs 公式（82 亿 − 已释放团队 − 已销毁 − 已领取奖励 + 未领取本金） | TON RPC / reconcile | ≠ 0 | 停止对外披露；核对 RoundSettled、Claimed 事件；Lead + 合约负责人 |

<a id="P1"></a>
### 3.2 P1（轮次推进受阻或结算异常；30 分钟内响应）

| ID | 指标 | 数据源 | 阈值 | 处置 |
| --- | --- | --- | --- | --- |
| monitor.settlement.bounced | SettlementBounced 事件（0x52540110） | 链上事件 | 出现即告警 | **自动动作：调用 RetrySettlement（roundId）**；记录调用结果；重试后仍有退回则升级 |
| monitor.unexpected.bounce | UnexpectedBounce 事件（0x52540111） | 链上事件 | 出现即告警 | **人工核查**：记录 op 与 queryId；不得自动重试；通知合约负责人 |
| monitor.keeper.ton_low | keeper 钱包 TON 余额 | TON RPC | < 2 TON | 补充 gas；keeper 无 gas 时无法开轮与提交 K 线 |
| monitor.roundN.candle_lag | 应见 K 线 − 已见 K 线 | API / 链上 | > 1 根 | keeper 补交；连续缺 2 根升级 |
| monitor.roundN.close_overdue | 报名到期 1 小时后仍未 CloseStaking | API / 链上 | > 1 h | 发送 CloseStaking（双人）；任何人可调用 |
| monitor.next_round.overdue | 预告结束 1 小时后仍未 OpenRound | API / 链上 | > 1 h | 查 keeper 与 gas；发状态更新；预告结束 7 天后任何人可 AbortTechnical |
| monitor.roundN.abort_eligible | 技术终止条件已满足（观察应结束或预告结束后 7 天）且轮次未终止 | 链上 | 满足即告警 | 双人确认后调用 AbortTechnical；发 abort 公告 |

<a id="P2"></a>
### 3.3 P2（展示或数据延迟；4 小时内响应）

| ID | 指标 | 数据源 | 阈值 | 处置 |
| --- | --- | --- | --- | --- |
| monitor.roundN.stale | 轮次数据 15 分钟未更新 | API | > 15 min | 检查索引与缓存；确认页面状态 |
| monitor.rc.ton_low | RC 钱包所在合约 TON 余额 | TON RPC | < 20 TON | 补充 gas；结算动作依赖 RC 的 TON |
| monitor.rpc_latency | TON RPC p95 | 探针 | > 3 s | 切换 RPC 或配置 API key |
| monitor.worker.p95 | API p95 | Workers Analytics | > 800 ms | 查缓存与查询 |

### 3.4 P3（一般缺陷；次工作日）

- 前端文案或倒计时偏差、图表缺根 K 线、日志噪音、非关键 UI 错误。
- 只进缺陷池，不打断轮次，但必须记录并排期。

<a id="bounce"></a>
### 3.5 结算重试与技术终止专项

- **SettlementBounced**：只代表对应的结算转账或销毁被退回，不改变判定结果。调用 RetrySettlement（value ≥ 0.3 TON）后，核对 teamWallet 收款或 total_supply 变化，并记录。
- **UnexpectedBounce**：不明退回，不自动重试，必须人工核查 op 与 queryId。
- **AbortTechnical**：任何人可调用，但条件不满足时会 revert。技术终止后本金可领取，7 亿与 1.2 亿留在 RC，不销毁。
- 合约没有暂停功能，因此不存在“暂停计时”告警。

<a id="reconcile"></a>
### 3.6 对账专项

- `node ops/scripts/reconcile.mjs --chain --strict`：每轮判定后执行，每日一次。
- 差异 ≠ 0：冻结对外数字 → 人工核对 RoundSettled、Claimed、RoundSettled 的 teamReleasedRaw → Lead 决策 → 记录事故。
- 对账 CSV 归档到 ops/records/。对外只发布链上可验证数字。

---

## 4. 告警分级与响应时限

| 级别 | 定义 | 响应时限 | 升级 | 通知渠道 |
| --- | --- | --- | --- | --- |
| P0 | 资金、供应量、RC 钱包漂移、疑似漏洞、密钥异常 | 15 分钟（7×24） | 15 分钟未响应 → Lead；30 分钟 → 项目方 | 电话或 PagerDuty（若有）+ Telegram + 邮件 |
| P1 | 轮次推进受阻、结算退回、keeper 资源不足 | 30 分钟 | 60 分钟未解决 → Lead + 合约负责人 | Telegram + 邮件 |
| P2 | 展示延迟、RC gas 偏低、RPC 慢 | 4 小时 | 次班交接 | Telegram |
| P3 | 一般缺陷 | 次工作日 | 进缺陷池 | 邮件 / 看板 |

**升级路径**：On-call → Ops Lead → 合约负责人 → 项目方。不确定级别时按更高一级处理。

---

## 5. 通知渠道

### 5.1 Telegram（首选）

- Bot 与群：TELEGRAM_BOT_TOKEN、TELEGRAM_OPS_CHAT_ID（只从环境变量读取）。
- 测试：`node ops/scripts/monitor_check.mjs --snapshot <fixture> --notify`，用故障夹具验证发送链路。
- 内容规范：级别 + 指标 + 当前值 + 阈值 + 处置动作；不含密钥和未公开地址。
- 群分层：ops-alerts（P0 / P1）、ops-daily（P2 / P3 与日报）、comms（公告协调，独立群）。

### 5.2 邮件

- 适用于 P0 / P1 的备份通道与每日日报；配置 OPS_SMTP_HOST、OPS_ALERT_EMAIL。
- 主题格式：[A9][P0] 指标 — 当前值（UTC 时间）。

### 5.3 静默与抑制

- 计划内维护：提前公告，并手动静默告警，记录开始与结束时间和原因。
- 同一指标 30 分钟内只发一次（cron 间隔与人工去重；升级时人工重发）。
- 禁止长期静默 P0；静默必须由 Lead 批准并记录。

---

## 6. 值班表与轮转

模板：ops/templates/shift-schedule.csv。

- 班次：日班 08:00–20:00 UTC，夜班 20:00–08:00 UTC；每班 1 主 + 1 备。
- 观察期（24h）与结算窗口必须 7×24 覆盖；报名期（36h）可降为 12h 覆盖，但响应时限仍为 30 分钟。
- 每班交接内容：轮次状态、K 线进度、最近告警、未确认的链上动作、公告排期、待办操作。
- 值班人不得单独执行 keeper 写操作（见 04 §5 双人规则）。
- 连续值班不超过 12h；夜班后至少休息 12h。

---

## 7. 事故响应流程

1. **发现**：告警、人工或 KPI 异常；记录时间（UTC）、指标、初判级别。
2. **分诊（≤ 5 分钟）**：是否资金或供应量风险；P0 立即拉群。
3. **止损（P0 ≤ 15 分钟）**：停止前端质押入口、停止 keeper 提交、停止对外披露；保留现场（截图、哈希、日志）。
4. **定位**：链上状态、事件、交易哈希、日志、对账差异；双人复核结论。
5. **处置**：按预案操作（RetrySettlement、补交 K 线、AbortTechnical 等）；写操作双人并留痕。
6. **沟通**：按 05 手册发状态更新；不猜测原因，不承诺时间点。
7. **复盘（P0 / P1 在 24h 内）**：时间线、根因、影响、修复、预防、责任人、截止日期；写入 incident-log.csv。
8. **改进**：更新监控阈值、预案与脚本；演练验证。

### 事故级别

| 事故 | 判定 | 示例 |
| --- | --- | --- |
| INC-P0 | 资金、供应量、RC 钱包、密钥 | 销毁金额与公式不一致、total_supply 漂移、keeper 私钥疑似泄露、UnexpectedBounce |
| INC-P1 | 轮次无法推进 | K 线缺失、keeper 未开轮或未关窗、结算退回 |
| INC-P2 | 展示或性能 | API 5xx、页面停更、RPC 慢 |
| INC-P3 | 一般缺陷 | 文案错误、图表缺根 |

---

## 8. 看板与日志

- **状态看板**：轮次状态、tier、target、报名与观察倒计时、K 线进度、keeper 状态、结算退回计数。
- **财务看板**：total_supply、累计销毁、RC 钱包余额、团队释放、领取率。
- **技术看板**：cron 心跳、API p95 与 5xx、RPC 延迟、RC 与 keeper 的 TON 余额、告警计数。
- **日志保留**：Worker 日志与 D1 管理事件 ≥ 90 天；对账 CSV 与告警截图保留至主网后 90 天；keeper 出账记录单独保存。

---

## 9. 部署与调度

### 9.1 本地或服务器 cron（示例）

~~~cron
# 每 2 分钟：监控（P0 / P1），失败时 notify
*/2 * * * * cd /Users/yu1/Desktop/BAM && OPS_WORKER_BASE_URL=http://127.0.0.1:8787 node ops/scripts/monitor_check.mjs --notify >> ops/records/monitor.log 2>&1

# 每小时：对账（只读，输出 CSV）
0 * * * * cd /Users/yu1/Desktop/BAM && node ops/scripts/reconcile.mjs --chain >> ops/records/reconcile.log 2>&1

# 每日 10:05 UTC：日报（KPI 与告警摘要）
5 10 * * * cd /Users/yu1/Desktop/BAM && node ops/scripts/monitor_check.mjs --json > ops/records/daily-$(date +%F).json
~~~

### 9.2 systemd timer（推荐生产）

~~~ini
# /etc/systemd/system/a9-monitor.service
[Unit]
Description=A9 testnet monitor check
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/Users/yu1/Desktop/BAM
Environment=OPS_WORKER_BASE_URL=https://<worker-domain>
ExecStart=/usr/bin/env node ops/scripts/monitor_check.mjs --notify

# /etc/systemd/system/a9-monitor.timer
[Unit]
Description=Run A9 monitor every 2 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
~~~

> 环境变量放入 systemd EnvironmentFile（权限 600），不要写入仓库。

---

## 10. 演练与验证

- 每月：用故障夹具（ops/tests/fixtures/worker-snapshot-bad.json）验证告警链路与分级。
- 每季度：模拟 P0（供应量漂移或 RC 钱包漂移）全流程：发现 → 分诊 → 止损 → 公告 → 复盘，计时并记录。
- 每次部署后：验证 RPC、索引器、对账脚本在真实数据上无漂移。
- 演练记录归档到 ops/drills/。

---

## 11. 常见误报与处理

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 心跳告警但页面正常 | 缓存或时钟差异 | 核对 /api/health 的时间与实际时间；检查服务器时区 |
| K 线缺失告警但链上有数据 | 索引器延迟或缓存 | 等一个周期再确认；检查索引器 |
| 供应量或 RC 钱包漂移告警 | 手工转账，或漏记事件 | 以链上为准，补账本与对账 |
| settlement.bounced 告警已自动重试成功 | 第一次重试生效 | 确认 teamWallet 收款或 total_supply 变化后关闭告警 |
| keeper.ton_low 告警 | keeper 的 gas 按设计只放少量 | 补充 gas，并确认 keeper 出账仅为预期操作 |

---

## 12. 与合约实现的对应口径

- 判定点是第 24 根 K 线提交，监控以 RoundSettled 事件与链上状态为准。
- 没有提前关窗，没有暂停，也没有单独的结算调用；相关告警已删除。
- RC 只有一个 Jetton 钱包，托管质押本金与每轮 7 亿奖励，同时托管 1.2 亿团队额度；没有其他金库地址。
- SettlementBounced 与 UnexpectedBounce 是唯一的结算退回信号，监控必须订阅。
- 失败轮只有一笔合并销毁；监控按 RoundSettled 的三项销毁合计核对。

---

*本方案的指标 ID 与 monitor_check.mjs 对齐；新增或修改指标时同步更新脚本和本表。*
