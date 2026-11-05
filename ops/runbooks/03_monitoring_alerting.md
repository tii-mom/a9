# 03 — A9 测试网监控与告警方案

**版本**：V6.2 · 2026-11-05
**Owner**：testnet-ops
**关联**：ops/scripts/monitor_check.mjs、reconcile.mjs；04_key_custody_admin.md（操作与演练）；02_round_operations.md（轮次 SOP）

---

## 1. 目标与原则

1. **只以链上为最终事实**：API/D1 是展示与索引层，任何差异以链上对账为准。
2. **先止损后定位**：P0 先暂停/隔离、发公告，再排查；不要在告警风暴中继续写操作。
3. **告警必须可执行**：每条告警带级别、指标、当前值、阈值、处置链接；无处置动作的指标不做告警（只做看板）。
4. **不泄露敏感信息**：告警内容不得包含助记词、私钥、API key、未公开钱包地址；地址统一用登记表/链上公开地址。
5. **测试网即主网演练**：值班、双人复核、事故分级在测试网按主网标准执行。

---

## 2. 监控架构

~~~text
TON testnet (链上)                    Worker API + D1 (索引/展示)
Jetton / RC / TeamVault              /api/health /stats /rounds
        │ TON Center v2/v3 (只读)              │ HTTPS
        ▼                                      ▼
   monitor_check.mjs（每 1~5 分钟）
   指标检查 → P0/P1/P2/P3 → Telegram/邮件/值班
        │ 每轮/每日
        ▼
   reconcile.mjs（对账 CSV）→ 财务/Lead 复核
~~~

- **采集**：monitor_check.mjs 直接读取 Worker API；链上指标由登记表地址 + TON Center 查询（切真链后由 chain 适配器/索引器补充事件级指标）。
- **频率**：P0/P1 指标 1~5 分钟一次；对账每轮 1 次 + 每日 1 次；KPI 看板每轮更新。
- **无状态**：脚本不写业务数据，只输出告警与对账文件；告警去重由 cron 间隔与前缀控制。

---

## 3. 指标、阈值与告警

<a id="P0"></a>
### 3.1 P0（资金/终态风险；15 分钟内响应，7×24）

| ID | 指标 | 数据源 | 阈值 | 处置 |
| --- | --- | --- | --- | --- |
| monitor.worker.health | Worker /api/health 是否 ok | API | ok=false | 检查 Worker/DB；降级页；30 分钟未恢复升级 Lead |
| monitor.worker.db | D1 连通性 | API | db=false | 查 D1 配额/迁移；禁止依赖 API 做结算判断 |
| monitor.supply.drift | 账本供应量 vs 初始-累计销毁 | API/reconcile | ≠ 0 | 停止对外披露；全量对账；保留现场；Lead+财务 |
| monitor.supply.chain_drift | 账本 vs 链上 total_supply | TON RPC | ≠ 0 | 同上；以链上为准，检查漏记 burn/claim |
| monitor.roundN.burn_pending | FAILED_PERMANENT 但 burnedRaw=0 | API | 任意 | 检查三笔 burn/BurnAck；确认前不得公告“已销毁” |
| monitor.roundN.burn_mismatch | 销毁金额 ≠ 7 亿+1.2 亿+本金 | API | 任意 | 与财务核对；疑似漏洞升级合约负责人+审计 |
| monitor.roundN.settling_timeout | SETTLING_* 超过 30 分钟 | API | > 30 min | 查 pending 动作；重试；必要时双人升级 |

<a id="P1"></a>
### 3.2 P1（轮次推进受阻；30 分钟内响应）

| ID | 指标 | 数据源 | 阈值 | 处置 |
| --- | --- | --- | --- | --- |
| monitor.cron.heartbeat | Worker 心跳/更新时间 | API | > 5 min | 检查 cron/手动 tick；页面可能停更 |
| monitor.roundN.candle_missing | 应见 K 线 - 已见 K 线 | API/链上 | > 1 根 | keeper 补提交；连续缺 2 根发暂停公告 |
| monitor.roundN.finalize_overdue | 观察结束 1h 后仍 OBSERVING | API | > 1h | 触发/催促结算；检查 18 根是否齐备 |
| monitor.roundN.close_overdue | 报名截止 1h 后仍 STAKING_OPEN | API | > 1h | 检查关窗交易；必要时 owner 手动关窗（双人） |
| monitor.oracle.paused | 预言机暂停/离线 | API/链上 | true | 发 pause 公告；定位数据源；计时 14 天 |
| monitor.admin.error_events | 管理员操作 error 事件 | D1 admin_events | 近 15 min 任意 | 核对签名者与操作；异常升级 P0 |
| monitor.next_round.overdue | 下一轮未按预告开启 | API | > 1h | 检查 PREVIEW/开窗交易；发状态更新 |

<a id="P2"></a>
### 3.3 P2（展示/数据延迟；4 小时内响应）

| ID | 指标 | 数据源 | 阈值 | 处置 |
| --- | --- | --- | --- | --- |
| monitor.roundN.stale | 轮次数据 15 分钟未更新 | API | > 15 min | 检查索引/缓存；页面是否正常 |
| monitor.admin.warn_events | 管理员 warn 事件 | D1 | 近 15 min | 确认是否计划内操作 |
| monitor.contract_ton_balance | RC/TeamVault TON 余额 | TON RPC | < 0.5 TON | 补 gas；否则跨合约消息失败 |
| monitor.rpc_latency | TON RPC p95 | 探针 | > 3 s | 切换 RPC/配置 API key |
| monitor.worker.p95 | API p95 | Workers Analytics | > 800 ms | 查缓存/查询 |

### 3.4 P3（一般缺陷；次工作日）

- 前端文案/倒计时偏差、图表缺根 K 线、日志噪音、非关键 UI 错误。
- 只进缺陷池，不打断轮次，但必须记录并排期。

<a id="pause"></a>
### 3.5 暂停与恢复专项

- 触发暂停：数据缺失/来源不足/签名或时间戳异常/合约异常（docs/03 §10）。
- **暂停不判负、不销毁、不计未达标**；暂停期间禁止结算。
- 连续暂停 14 天 → 技术终止条件（见 04 手册 tech-abort），任何人可触发。
- 恢复后重收完整 18 根，不缩短窗口。

<a id="reconcile"></a>
### 3.6 对账专项

- node ops/scripts/reconcile.mjs --chain --strict：每轮结算后 + 每日一次。
- 差异 ≠0：冻结对外数字 → 人工核对三笔销毁/团队释放/claim → Lead 决策 → 记录事故。
- 对账输出 CSV 归档 ops/records/；对外只发布链上可验证数字。

---

## 4. 告警分级与响应时限

| 级别 | 定义 | 响应时限 | 升级 | 通知渠道 |
| --- | --- | --- | --- | --- |
| P0 | 资金/供应量/终态错误、疑似漏洞、密钥异常 | 15 分钟（7×24） | 15 分钟未响应 → Lead；30 分钟 → 项目方 | 电话/PagerDuty（若有）+ Telegram + 邮件 |
| P1 | 轮次推进受阻、预言机暂停、结算延迟 | 30 分钟 | 60 分钟未解决 → Lead + 合约负责人 | Telegram + 邮件 |
| P2 | 展示/数据延迟、gas 偏低 | 4 小时 | 次班交接 | Telegram |
| P3 | 一般缺陷 | 次工作日 | 进缺陷池 | 邮件/看板 |

**升级路径**：On-call → Ops Lead → 合约负责人 → 项目方。任何人不确定级别时按更高一级处理。

---

## 5. 通知渠道

### 5.1 Telegram（首选）

- Bot 与群：TELEGRAM_BOT_TOKEN / TELEGRAM_OPS_CHAT_ID（只从环境变量读取）。
- 测试：node ops/scripts/monitor_check.mjs --snapshot <fixture> --notify（用故障夹具验证发送链路）。
- 内容规范：级别 + 指标 + 当前值 + 阈值 + 处置链接；不包含密钥/未公开地址。
- 群分层：ops-alerts（P0/P1）、ops-daily（P2/P3 与日报）、comms（公告协调，独立群）。

### 5.2 邮件

- 适用 P0/P1 备份通道与每日日报；配置 OPS_SMTP_HOST / OPS_ALERT_EMAIL。
- 邮件主题格式：[A9][P0] 指标 — 当前值（UTC 时间）。

### 5.3 静默与抑制

- 计划内维护：提前公告 + 手动暂停告警（记录开始/结束时间与原因）。
- 同一指标 30 分钟内只发一次（脚本由 cron 间隔+人工去重实现；升级时人工重发）。
- 禁止长期静默 P0；静默必须由 Lead 批准并记录。

---

## 6. 值班表与轮转

模板：ops/templates/shift-schedule.csv。

- 班次：日班 08:00–20:00 UTC，夜班 20:00–08:00 UTC；每班 1 主 + 1 备。
- 观察期（72h）与结算窗口必须 7×24 覆盖；报名期可降为 12h 覆盖但保持 30 分钟响应。
- 每班交接内容：轮次状态、K 线进度、最近告警、未确认动作、公告排期、待办操作。
- 值班人不得单独执行 owner 写操作（见 04 手册双人规则）。
- 连续值班不超过 12h；夜班后至少 12h 休息。

---

## 7. 事故响应流程

1. **发现**：告警/人工/KPI 异常；记录时间（UTC）、指标、初判级别。
2. **分诊（≤5 分钟）**：确认是否资金/终态风险；P0 立即拉群。
3. **止损（P0 ≤15 分钟）**：暂停相关动作、停止对外披露、保留现场（截图/哈希/日志）。
4. **定位**：链上状态、事件、交易哈希、日志、对账差异；双人复核结论。
5. **处置**：按预案操作（重试 pending、补 K 线、暂停/恢复、技术终止）；所有写操作双人 + 留痕。
6. **沟通**：按 05_announcements.md 发状态更新；不猜测原因、不承诺时间点。
7. **复盘（P0/P1 24h 内）**：时间线、根因、影响、修复、预防、责任人、截止日期；写入 incident-log.csv。
8. **改进**：更新监控阈值/预案/脚本；演练验证。

### 事故级别（与告警级别对应）

| 事故 | 判定 | 示例 |
| --- | --- | --- |
| INC-P0 | 资金/供应量/终态/密钥 | 三笔销毁不一致、total_supply 漂移、owner 私钥疑似泄露 |
| INC-P1 | 轮次无法推进 | K 线缺失、结算卡住、预言机暂停 |
| INC-P2 | 展示/性能 | API 5xx、页面停更、RPC 慢 |
| INC-P3 | 一般缺陷 | 文案错误、图表缺根 |

---

## 8. 看板与日志

- **状态看板**：轮次状态、tier、target、报名/观察倒计时、K 线进度、预言机、pending 动作。
- **财务看板**：total_supply、累计销毁（三笔）、奖励池/团队池余额、团队释放、claim 率。
- **技术看板**：cron 心跳、API p95/5xx、RPC 延迟、合约 TON 余额、告警计数。
- **日志保留**：Worker 日志/D1 admin_events ≥ 90 天；对账 CSV 与告警截图 ≥ 主网后 90 天；密钥审计记录单独加密保存。

---

## 9. 部署与调度

### 9.1 本地/服务器 cron（示例）

~~~cron
# 每 2 分钟：监控（P0/P1），失败时 notify
*/2 * * * * cd /Users/yu1/Desktop/BAM && OPS_WORKER_BASE_URL=http://127.0.0.1:8787 node ops/scripts/monitor_check.mjs --notify >> ops/records/monitor.log 2>&1

# 每小时：对账（只读，输出 CSV）
0 * * * * cd /Users/yu1/Desktop/BAM && node ops/scripts/reconcile.mjs --chain >> ops/records/reconcile.log 2>&1

# 每日 10:05 UTC：日报（KPI + 告警摘要）
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

- 每月：用故障夹具（tests/fixtures/worker-snapshot-bad.json）验证告警链路与分级。
- 每季度：模拟 P0（供应量漂移/销毁不一致）全流程：发现→分诊→止损→公告→复盘，计时并记录。
- 每次部署/切真链后：验证 RPC、索引器、对账脚本在真实数据上无漂移。
- 演练记录归档 ops/drills/。

---

## 11. 常见误报与处理

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 心跳告警但页面正常 | 演示/缓存时钟差异 | 核对 /api/health 的 now 与实际时间；容器时区/时钟 |
| K 线缺失告警但链上有数据 | 索引器延迟/缓存 | 等 1 个周期再确认；检查索引器 |
| 供应量漂移告警 | 手工转账/漏记 burn | 以链上为准，补账本/对账 |
| oracle.paused 告警 | 数据源短时抖动 | 确认是否自动恢复；>30 分钟发暂停公告 |
| admin.activity P3 | 计划内操作 | 确认操作日志与值班记录 |

---

*本方案与 monitor_check.mjs 的指标 ID 对齐；新增/修改指标必须同步更新脚本与本节表格。*
