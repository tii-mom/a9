# A9 测试网 KPI 看板字段定义（v10）

> 用途：每轮判定后更新一次。数据源优先链上事件（TargetPriceSet、DepositAccepted、RoundSettled、Claimed、StakingClosed、CandleSubmitted、SettlementBounced、UnexpectedBounce、TechnicalAborted），Worker API 只作展示与对账辅助。
> 口径：金额一律 raw（1 A9 = 1e9）加展示单位；时间一律 UTC；每项标注 owner 与采集方式。

## 1. 轮次经营指标

| # | 字段 | 定义 / 公式 | 数据源 | Owner | 目标 / 告警 |
| --- | --- | --- | --- | --- | --- |
| 1 | roundId | 当前轮次 1..10 | 链上 RoundView | Ops | — |
| 2 | tier | 档位 = 1 + successCount（失败同档重试） | 链上 RoundView.targetTier | Ops | 与公告一致 |
| 3 | targetUsdE8 | 开窗锁定：max(P0 × 2^tier, 2 × 24h TWAP) | 链上 TargetPriceSet | Ops | 任何人可离线复算 |
| 4 | stakeTotalRaw / A9 | 本轮 totalAcceptedStakeRaw | 链上 RoundView / DepositAccepted 汇总 | Ops | ≤ 2 亿 A9 |
| 5 | stakerCount | 本轮唯一质押地址数 | 链上 DepositAccepted 汇总 / API | Ops | 与排行榜一致 |
| 6 | avgStakeA9 | stakeTotal / stakerCount | 计算 | Ops | — |
| 7 | maxAddressStakeA9 | 本轮单地址最大质押额 | 链上 DepositAccepted 汇总 | Ops | ≤ 2,000 万 A9（固定上限） |
| 8 | qualifiedCandles | 达标 K 线数（0..24） | 链上 RoundView / CandleSubmitted | Ops | ≥ 16 成功，≤ 15 失败 |
| 9 | result | SUCCEEDED / FAILED_PERMANENT / TECHNICAL_ABORTED / 进行中 | 链上 RoundView.status | Ops | 与公告一致 |
| 10 | rewardPoolAllocatedA9 | 成功轮按质押占比分配的奖励总额（7 亿以内，尾差留在 RC） | 链上 RoundSettled 与 Claimed 汇总 | 财务 | ≤ 7 亿 |
| 11 | rewardClaimedA9 | 已领取奖励合计 | 链上 Claimed 汇总 | 财务 | ≤ 已分配奖励 |
| 12 | principalClaimedA9 | 已领取本金合计 | 链上 Claimed 汇总 | 财务 | ≤ 已接受本金 |
| 13 | burnedRewardA9 | 失败轮奖励销毁（RoundSettled.rewardBurnRaw） | 链上 RoundSettled | 财务 | 失败轮必为 7 亿 |
| 14 | burnedTeamA9 | 失败轮团队额度销毁（RoundSettled.teamBurnRaw） | 链上 RoundSettled | 财务 | 失败轮必为 1.2 亿 |
| 15 | burnedPrincipalA9 | 失败轮本金销毁（RoundSettled.principalBurnRaw） | 链上 RoundSettled | 财务 | = 本轮 stakeTotal |
| 16 | burnedTotalA9 | 一笔销毁合计（13 + 14 + 15） | 计算 | 财务 | 与链上 total_supply 变化一致 |
| 17 | teamReleasedA9 | 成功轮 RC 转给 teamWallet 的金额（RoundSettled.teamReleasedRaw） | 链上 RoundSettled | 财务 | 每轮 ≤ 1.2 亿，且只一次 |
| 18 | rcWalletBalanceA9 | RC 的 Jetton 钱包余额 | TON RPC | 财务 | = 公式期望值（见 19） |
| 19 | rcWalletDriftRaw | 实际余额 − 期望（82 亿 − 已释放团队 − 已销毁 − 已领取奖励 + 未领取本金） | 对账脚本 | 财务 | ≠ 0 → P0 |
| 20 | supplyAfterRaw | 判定后 total_supply | JettonMaster get_jetton_data | 财务 | = 1e19 − 累计销毁 |
| 21 | claimPendingA9 | 已判定未领取（本金 + 奖励） | 链上 get_claimable_all 汇总 | 运营 | 持续跟踪 |
| 22 | settlementBouncedCount | 本轮 SettlementBounced 次数 | 链上事件 | Ops | > 0 → 必须调用 RetrySettlement 并记录 |

## 2. 参与与增长指标

| # | 字段 | 定义 | 数据源 | 目标 / 备注 |
| --- | --- | --- | --- | --- |
| 23 | uniqueStakersTotal | 历史唯一质押地址数 | 链上 DepositAccepted / API | 周环比 |
| 24 | newStakersRound | 本轮首次参与地址数 | 链上 + 历史快照 | 拉新效果 |
| 25 | repeatRate | 连续两轮参与的地址占比 | 计算 | 仅作分析，不作承诺 |
| 26 | stakeConcentrationBps | 前 10 地址质押占比 | 计算 | 集中度风险 |
| 27 | walletConnectCount | 前端钱包连接数（日） | 前端埋点 | 仅趋势 |
| 28 | riskAcceptRate | 勾选风险确认 / 发起质押 | 前端埋点 + API | 预期接近 100% |
| 29 | claimRate | 已领取金额 / 可领取金额 | 链上 | 观察用户行为 |
| 30 | announcementReach | 公告渠道曝光（X / TG） | 渠道后台 | 不做 KPI 压力 |

## 3. 技术健康指标

| # | 字段 | 定义 | 数据源 | 阈值 / 告警级别 |
| --- | --- | --- | --- | --- |
| 31 | cronHeartbeatAgeSec | 最近一次 cron 或 tick 成功距今秒数 | Worker API / D1 | > 300s → P1 |
| 32 | candleSeenVsExpected | 观察期已见 K 线 vs 应有 K 线 | API / 链上 | 落后 > 1 根 → P1 |
| 33 | keeperTonBalance | keeper 钱包 TON 余额 | TON RPC | < 2 TON → P1 |
| 34 | keeperOutboundAbnormal | keeper 出账中非 OpenRound / SubmitCandle 的次数 | TON RPC | > 0 → P0 |
| 35 | rcTonBalance | RC 合约 TON 余额 | TON RPC | < 20 TON → P2 |
| 36 | unexpectedBounceCount | UnexpectedBounce 事件次数（24h） | 链上事件 | > 0 → P1，人工核查 |
| 37 | bounceFailedTx24h | 24h bounce 或失败交易数 | TON RPC / 索引器 | 突增 → P1 |
| 38 | rpcLatencyP95 | TON RPC p95 延迟 | 监控探针 | > 3s → P2 |
| 39 | workerP95Ms | API p95 延迟 | Workers Analytics | > 800ms → P3 |
| 40 | api5xxRate | 5xx / 总请求 | Workers Analytics | > 1% → P1 |
| 41 | supplyDriftRaw | 账本供应量 − 链上 total_supply | 对账脚本 | ≠ 0 → P0 |
| 42 | rcWalletDriftAlert | 与 19 相同，告警口径 | 对账脚本 | ≠ 0 → P0 |
| 43 | keyHealth | keeper 与资金钱包的备份校验状态 | 人工巡检 | 月度复核 |

## 4. 更新节奏与归属

- **每轮判定后 2 小时内**：Ops 更新 §1 全部字段与 §3 中 31–43；财务复核销毁、释放与 RC 钱包余额。
- **每日 10:00 UTC**：值班更新 §2 与 §3 摘要；异常进入事故流程（见 03_monitoring_alerting.md）。
- **每周一**：全量对账，密钥与备份复核记录归档。
- 所有数字必须可从链上复算；对外材料只发布链上可验证字段。
