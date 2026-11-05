# A9 测试网 KPI 看板字段定义

> 用途：每轮结算后更新一次；数据源优先链上事件（TargetPriceSet / RoundSettled / DepositAccepted / TeamReleased / TeamBurned / TechnicalAborted），D1/Worker API 作为展示与对账辅助。
> 口径：金额一律 raw（1 A9 = 1e9）+ 展示单位；时间一律 UTC；每项标注 owner 与采集方式。

## 1. 轮次经营指标

| # | 字段 | 定义 / 公式 | 数据源 | Owner | 目标 / 告警 |
| --- | --- | --- | --- | --- | --- |
| 1 | roundId | 当前轮次 1..10 | 链上 RoundView | Ops | — |
| 2 | tier | 档位 = 1 + successCount（失败同档重试） | 链上 RoundView.targetTier | Ops | 与公告一致 |
| 3 | targetUsdE8 | 开窗锁定 target = max(P0×2^tier, 2×24h TWAP) | 链上 TargetPriceSet | Ops | 任何人可离线复算 |
| 4 | stakeTotalRaw / A9 | 本轮 totalAcceptedStakeRaw | 链上 RoundView / DepositAccepted 汇总 | Ops | ≤ 2 亿 A9 |
| 5 | stakerCount | 本轮唯一质押地址数 | 链上 stakes 字典 / API | Ops | 与排行榜一致 |
| 6 | avgStakeA9 | stakeTotal / stakerCount | 计算 | Ops | — |
| 7 | top1ShareBps | 最大地址质押占比（bps） | 链上 stake + 计算 | Ops | ≤ 1000 bps（单地址上限） |
| 8 | qualifiedCandles | 达标 K 线数（0..24） | 链上 RoundView | Ops | ≥16 成功 / ≤15 失败（24 根齐备，V7） |
| 9 | result | SUCCESS / FAILURE / TECHNICAL_ABORT / 进行中 | 链上 RoundView.status | Ops | 与公告一致 |
| 10 | rewardUnlockedA9 | 成功解锁奖励（7 亿） | 链上结算事件 | Ops/财务 | 成功轮必为 7 亿 |
| 11 | rewardClaimedA9 | 已领取奖励合计 | 链上 ClaimReward/ClaimAll | 财务 | ≤ 7 亿（余数留金库） |
| 12 | principalReturnedA9 | 成功轮已领回本金 | 链上 ClaimPrincipal | 财务 | = 已接受本金 |
| 13 | burnedRewardA9 | 失败轮奖励销毁（7 亿） | 链上 burn / BurnAck | 财务 | 失败轮必须 = 7 亿 |
| 14 | burnedTeamA9 | 失败轮团队销毁（1.2 亿） | TeamVault BurnTeamQuota | 财务 | 失败轮必须 = 1.2 亿 |
| 15 | burnedPrincipalA9 | 失败轮本金销毁 | 链上 burn | 财务 | = 本轮 stakeTotal |
| 16 | burnedTotalA9 | 三笔销毁合计 | 计算 | 财务 | = 8.2 亿 + 本金 |
| 17 | teamReleasedA9 | 成功轮团队释放（1.2 亿） | TeamVault TeamReleased | 财务 | 每轮 ≤ 1.2 亿，最多一次 |
| 18 | supplyAfterRaw | 结算后 total_supply | Jetton Master get_jetton_data | 财务 | = 初始 − 累计销毁 |
| 19 | burnConfirmSec | 从 SETTLING_FAILURE 到 FAILED_PERMANENT 的秒数 | 链上时间戳 | Ops | > 30 分钟告警 |
| 20 | claimPendingA9 | 已结算未领取（本金+奖励） | 链上 get_claimable_all 汇总 | 运营 | 轮次结束后持续跟踪 |

## 2. 参与与增长指标

| # | 字段 | 定义 | 数据源 | 目标 / 备注 |
| --- | --- | --- | --- | --- |
| 21 | uniqueStakersTotal | 历史唯一质押地址数 | 链上 stakes / API | 周环比 |
| 22 | newStakersRound | 本轮首次参与地址数 | 链上 + 历史快照 | 拉新效果 |
| 23 | repeatRate | 连续两轮参与地址占比 | 计算 | 留存核心指标 |
| 24 | stakeConcentrationBps | 前 10 地址质押占比 | 计算 | 集中度风险 |
| 25 | walletConnectCount | 前端钱包连接数（日） | 前端埋点 | 仅趋势，不做承诺 |
| 26 | riskAcceptRate | 勾选风险确认 / 发起质押比 | 前端埋点 + API | 预期 ~100% |
| 27 | claimRate | 已领取金额 / 可领取金额 | 链上 | 观察用户行为 |
| 28 | announcementReach | 公告渠道曝光（X/TG） | 渠道后台 | 不做 KPI 压力 |

## 3. 技术健康指标

| # | 字段 | 定义 | 数据源 | 阈值 / 告警级别 |
| --- | --- | --- | --- | --- |
| 29 | cronHeartbeatAgeSec | 最近一次 cron/tick 成功距今秒数 | Worker API / D1 | > 300s → P1 |
| 30 | candleSeenVsExpected | 观察期已见 K 线 vs 应有 K 线 | API / 链上 | 落后 > 1 根 → P1 |
| 31 | oraclePaused | 预言机暂停标志 | 链上 RoundView / API | true → P1 |
| 32 | oracleValidSources | 有效价格源数量 | OracleAdapter / API | < 阈值 → P1（主网 3/5） |
| 33 | oracleCoverageBps | TWAP 覆盖率 | 数据采集器 | < 9500 bps → P1（主网） |
| 34 | pendingActions | pending 跨合约动作数（burn/claim/release） | 链上状态 | > 0 超过 30 分钟 → P0/P1 |
| 35 | bounceFailedTx24h | 24h bounce/失败交易数 | TON RPC / 索引器 | 突增 → P1 |
| 36 | contractTonBalance | RC / TeamVault / 各 Vault TON 余额 | TON RPC | < 0.5 TON → P2（gas 风险） |
| 37 | rpcLatencyP95 | TON RPC p95 延迟 | 监控探针 | > 3s → P2 |
| 38 | workerP95Ms | API p95 延迟 | Workers Analytics | > 800ms → P3 |
| 39 | api5xxRate | 5xx / 总请求 | Workers Analytics | > 1% → P1 |
| 40 | supplyDriftRaw | 账本供应量 − 链上 total_supply | 对账脚本 | ≠ 0 → P0 |
| 41 | ledgerInternalDriftRaw | 账本供应量 −（初始 − 累计销毁） | 对账脚本 | ≠ 0 → P0 |
| 42 | adminOpsAbnormal | 非白名单/异常管理员操作数 | admin_events 审计日志 | > 0 → P1（含暂停/恢复确认） |
| 43 | keyHealth | 硬件钱包可用性、备份校验状态 | 人工巡检 | 月度复核 |

## 4. 更新节奏与归属

- **每轮结算后 2 小时内**：Ops 更新 §1 全部字段 + §3 中 29–42；财务复核销毁/释放三笔。
- **每日 10:00 UTC**：值班更新 §2 与 §3 摘要；异常进入事故流程（见 03_monitoring_alerting.md）。
- **每周一**：对账全量 + 密钥/备份复核记录归档。
- 所有数字必须可从链上复算；对外材料只发布链上可验证字段。
