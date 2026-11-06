# 开 R1 前置演练计划（测试网，v10）

> 目的：在开放第 1 轮真实质押前，把部署、成功、失败、无人质押、结算重试、技术终止、DEX 与退款路径全部跑通并留证。
> 记录：复制 TEMPLATE_drill.md 到 ops/drills/YYYY-MM_<drill>.md；每条演练必须有操作与复核双人签字。

| # | 演练 | 前置 | 关键验收 | 预计耗时 | 负责人 |
| --- | --- | --- | --- | --- | --- |
| D1 | 部署 dry-run 全流程 | 合约构建完成、参数签字 | deploy_all 无报错；命令、地址、参数逐条核对；登记表未被误写 | 1h | 部署者 |
| D2 | 成功轮全链路 | 测试网质押可用 | 24 根后 ≥ 16 达标；`Claim(roundId)` 一次领取本金 + 全额奖励；RC 向 teamWallet 转 1.2 亿，且只一次 | 2h + 轮次时间 | Ops |
| D3 | 失败轮一笔销毁 | 同上 | RoundSettled 的 7 亿、1.2 亿、本金三项与 total_supply 减少一致；失败后不可领取；FAILED_PERMANENT 不可重开 | 2h + 轮次时间 | Ops + 财务 |
| D4 | 无人质押分支 | 空轮次 | 照常 24 根观察；成功 → 7 亿销毁、团队照常释放；失败 → 销毁 7 亿 + 1.2 亿 | 1h + 轮次时间 | Ops |
| D5 | 结算重试 | 合约负责人确认可复现的方法 | 出现 SettlementBounced → 调用 RetrySettlement（≥ 0.3 TON）→ 对账通过。若无法在测试网复现，记录为“未演练”，不得省略 | 2h | Ops + 合约 |
| D6 | 技术终止 | 7 天条件（观察超时或预告超时）；测试网无法压缩，需短参数部署或真实等待，由合约负责人确认 | 任何人可触发；本金 100% 可领取；7 亿与 1.2 亿留在 RC 未销毁；tier 不变；状态 TECHNICAL_ABORTED | 2h + 等待时间 | Ops + 合约 + 财务 |
| D7 | keeper 失联与 K 线补交 | 测试轮进行中 | 停 keeper 后 monitor.roundN.candle_lag 与 monitor.next_round.overdue 告警触发；按规则补交；超时后可 AbortTechnical | 1h + 等待时间 | Ops |
| D8 | DEX 买卖与退款 | 测试网 DEX（STON.fi / DeDust）建池 | 第三方 response_destination 的转账成功；买入、卖出正常；无效质押退款路径（附带 ≥ 0.1 TON 原路退回）正常 | 2h | 合约 + Ops |

## 演练后必须归档

- 交易哈希、事件日志、对账 CSV、公告链接、时间线截图；
- 发现的问题进入 incident-log.csv 或本轮复盘；
- 更新监控阈值、脚本与预案（如有）；
- Lead 签字确认“可开 R1”。
