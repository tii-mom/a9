# 02 — A9 测试网 10 轮运营手册（Round Operations）

**版本**：V6.2 · 2026-11-05
**Owner**：testnet-ops
**权威口径**：docs/00（V6.2）、docs/02（状态机）、docs/03（K 线/手动模式）、docs/10（上线清单）
**覆盖路径**：成功 / 失败 / 无人质押 / 暂停恢复 / 技术终止（五条）

---

## 1. 单轮时间轴（固定 168 小时）

~~~text
T0          上一轮结算（SUCCEEDED / FAILED_PERMANENT / TECHNICAL_ABORTED）
T0~T0+24h   PREVIEW 预告期（不开放质押；发开轮预告；准备物料）
T0+24h      自动开窗（STAKING_OPEN；开窗交易锁定 target）
T0+24h~+96h 报名 72h（触价可提前关窗）
T0+96h      关窗（STAKING_CLOSED）→ 观察开始
T0+96h~+168h 观察 72h（18 根 × 4h K 线，阈值 12）
T0+168h     观察结束 → 判定 → 结算 → 下一轮 T0
~~~

- 报名时长严格 259,200 秒；观察窗口 259,200 秒 / 18 根；单轮 7 天、10 轮 70 天。
- PREVIEW 与开窗由合约按 prevSettledAt 推导，不人工指定；测试网仅做**确认与监控**，不提前/延后开窗。
- 触价提前关窗只改变关窗时刻，观察仍是完整 72h/18 根。

---

## 2. 角色与权限

| 角色 | 职责 | 可用操作 | 不可做 |
| --- | --- | --- | --- |
| Ops Lead | 轮次总控、决策、对外口径 | 读状态、组织公告、升级事故 | 不得单独执行 owner 写操作 |
| Keeper（测试网白名单） | 每 4h 提交 K 线、跑 tick/监控 | SubmitCandle、只读巡检 | 不得暂停/恢复/结算 |
| On-call | 7×24 告警响应、一线处置 | 读状态、按预案升级、执行经过批准的操作 | 不得改参数/目标价 |
| Comms | 公告与社区沟通 | 按模板发公告（经 Lead 批准） | 不得承诺收益/透露未公开地址 |
| Finance | 对账、销毁/释放核对 | 只读链上 + 对账表 | 不得动用金库 |
| 合约负责人 | 合约问题定位、重建 | 部署/修复（新部署） | 不得热修已部署合约 |
| Owner（单密钥，硬件钱包） | 最小权限写操作 | 开轮确认、关窗、暂停/恢复、必要时结算、技术终止 | 见 04 手册权限边界 |

**双人规则**：任何 owner 写操作（暂停/恢复/结算/技术终止）必须“一人操作 + 一人核对地址与参数”，并在操作日志留痕。测试网同样执行，以演练主网流程。

---

## 3. 每轮 SOP（8 个阶段）

### 3.1 P0 — 结算确认（T0，上一轮结束时）

- [ ] 运行 node ops/scripts/80_admin_ops.mjs --action status --round <N-1>，确认上一轮为终态（SUCCEEDED / FAILED_PERMANENT / TECHNICAL_ABORTED）。
- [ ] 成功轮：确认 TeamVault 释放 1.2 亿（TeamReleased 事件）且本轮只释放一次。
- [ ] 失败轮：确认三笔销毁（reward 7 亿 / team 1.2 亿 / principal 全部）均已 BurnAck；total_supply 实际减少。
- [ ] 运行 node ops/scripts/reconcile.mjs --chain 生成对账 CSV；差异必须为 0（或已解释并记录）。
- [ ] 更新 KPI 看板（templates/kpi-dashboard.md §1）。
- [ ] 发布结算公告（成功/失败模板）；技术终止走 abort 模板。
- [ ] 归档：交易哈希、事件、对账 CSV、公告链接 → ops/records/ 与 ops/drills/。

### 3.2 P1 — PREVIEW 预告（T0 → T0+24h）

- [ ] 计算下一轮：tier = 1 + 已成功轮数（失败同档）；阶梯下限 = P0 × 2^tier；实际 target 在开窗时锁定。
- [ ] 检查 TeamVault 与奖励池余额 ≥ 本轮额度（12 亿池剩余、70 亿池剩余）。
- [ ] 准备并审批开轮公告（open 模板），预告期结束前发布；前端三个倒计时（距开窗 / 距关窗 / 距判定）核对。
- [ ] 确认流动性/做市就绪（不做单边加池）；确认客服 FAQ 已更新。
- [ ] 24h 到点自动开窗；人工只做**确认**：
  - 80_admin_ops --action status --round <N> 看到 STAKING_OPEN；
  - 链上 TargetPriceSet 的 target 与公告一致（任何人可用 P0、tier、TWAP 复算）。
- [ ] 若开窗时间已到但状态未变：按事故流程升级（P1），不要手动改时间参数。

### 3.3 P2 — 报名 72h（T0+24h → T0+96h）

每 4 小时巡检（可由 keeper/监控自动化）：

- [ ] monitor_check.mjs：健康、K 线（若已关窗）、预言机、供应量、管理员操作。
- [ ] 质押总额与单地址集中度：单地址 ≤ 本轮总质押 10%，本轮 ≤ 2 亿 A9（合约强制，前端提示）。
- [ ] 是否触发“触价提前关窗”：报名期内 1h TWAP ≥ 目标价 → 合约应立即关窗（确认状态、发截止公告）。
- [ ] 客服/社群问题：为什么不能取消质押、失败怎么销毁、技术暂停怎么办（统一口径）。
- [ ] 每日 10:00 UTC 更新运营日报（质押量、地址数、集中度、异常）。

### 3.4 P3 — 关窗（T0+96h，或触价提前）

- [ ] 确认状态为 STAKING_CLOSED；observationStart = stakeCloseAt（无 4h 取整）。
- [ ] 发布报名截止公告（stake-close 模板；注明关窗原因与观察起止）。
- [ ] 冻结质押快照：totalAcceptedStakeRaw、地址数、最大地址占比，写入对账表。
- [ ] 若无人质押：**照常进入观察**（不跳过、不延期、不判负）；在公告中说明“0 人质押仍观察，通过则 7 亿销毁（D-18b）”。

### 3.5 P4 — 观察 72h（18 根 K 线）

测试网为**手动 K 线模式**（docs/03 §12）：无签名验证，由白名单 keeper 提交，数据必须公开可复核。

每根 4h K 线：

- [ ] 取得该 4h 区间的 TWAP（多源或协议约定的公开数据，保留原始数据与算法说明）。
- [ ] 计算：periodStart = observationStart + i × 14400，periodEnd = periodStart + 14400。
- [ ] 提交（示例，参数以实际为准）：
      node ops/scripts/80_admin_ops.mjs --action submit-candle --round <N> --candle <i> --periodStart <unix> --periodEnd <unix> --twap <USD_E8> --digest <hex32>
- [ ] 提交后确认 candlesSeen 增加、qualified 判定正确（TWAP ≥ target 计达标，含等号）。
- [ ] 每根 K 线数据归档：原始源、计算过程、digest、提交交易哈希（公开可复核）。
- [ ] 监控：K 线缺失（应见 vs 已见 > 1 根）、时间区间错误、重复提交、预言机暂停。

**禁止**：不得在观察窗口内更换价格源/改目标价；不得把缺失数据当未达标；不得提前结算。

### 3.6 P5 — 判定与结算（T0+168h 前后）

- [ ] 18 根齐备后：qualified ≥ 12 → 成功；qualified ≤ 6 → 失败；6~11 根属中间带（按合约：只有 18 根齐备且 ≤6 才失败）。
- [ ] 触发结算（正常由 keeper/任何人触发；owner 仅必要时介入）：80_admin_ops --action finalize-round --round <N>。
- [ ] 成功：确认本金可领取 + 7 亿奖励可 claimAll + TeamVault 释放 1.2 亿（仅一次）。
- [ ] 失败：确认三笔销毁全部确认后状态才进入 FAILED_PERMANENT；未确认前不得公告“已销毁”。
- [ ] 技术故障（数据缺失/合约异常）：不得判负，进入 ORACLE_PAUSED；记录原因与最后有效 K 线。

### 3.7 P6 — 公告与对账

- [ ] 发布成功/失败公告（模板 success / fail）；失败公告必须列三笔销毁金额与合计。
- [ ] 对账：node ops/scripts/reconcile.mjs --chain --strict（差异 ≠0 时停止对外、升级 P0）。
- [ ] 更新 KPI：通过率、销毁量、参与地址、claim 率。
- [ ] 客服 FAQ 更新（本轮结果、领取方式、下一轮预告）。
- [ ] 归档本轮全部证据。

### 3.8 P7 — 进入下一轮

- [ ] 进入 24h PREVIEW；按 P1 重复。
- [ ] 失败轮：tier 不变（同档重试），公告中明确“下一轮仍是同一档目标”。
- [ ] 技术终止：不消耗档位，退款完成后按原 tier 继续。

---

## 4. 五条路径处理矩阵

| 路径 | 触发条件 | 合约行为 | 运营动作 | 公告模板 |
| --- | --- | --- | --- | --- |
| 成功 | 18 根齐备且 qualified ≥ 12 | 本金可领 + 7 亿奖励可 claimAll + 团队释放 1.2 亿 | 核对领取、对账、KPI，发成功公告 | success |
| 失败 | 18 根齐备且 qualified ≤ 6 | 三笔 burn（7 亿 + 1.2 亿 + 本金），终态永久关闭 | 核对三笔与 supply 减少、对账、发失败公告、准备同档下一轮 | fail |
| 无人质押 | 关窗时 totalStake = 0 | 照常观察；失败销毁奖励+团队；通过且 0 人 → 奖励销毁（D-18b） | 公告说明；对账时本金笔为 0 | stake-close / fail / success |
| 暂停恢复 | 预言机/数据故障 | ORACLE_PAUSED；不判负不销毁；恢复后重收满 18 根 | 发暂停公告、定位数据源、恢复公告；14 天阈值计时 | pause / resume |
| 技术终止 | 连续暂停 ≥14 天 或 观察超时 ≥7 天 | 任何人可 AbortTechnical：退 100% 本金、不销毁奖励/团队、不消耗档位 | 发 abort 公告、核对退款、继续下一轮 | abort |

**注意**：技术终止只能在合约条件满足时触发（提前触发会 revert）；不要用管理员权限绕过。

---

## 5. 10 轮排期与档位语义

- tier = 1 + 已成功轮数：只有成功才升档；失败沿用同档（D-28）。
- 10 轮 ≠ 10 档位：连续失败可能让后续轮次停留在低档。
- 每轮 target 在开窗时锁定：max(P0 × 2^tier, 2 × 开窗 24h TWAP)；公告中的数字以链上 TargetPriceSet 为准。
- 阶梯下限参考（P0 = $0.00116）：tier1 $0.00232、tier2 $0.00464、tier3 $0.00928、tier4 $0.01856、tier5 $0.03712、tier6 $0.07424、tier7 $0.14848、tier8 $0.29696、tier9 $0.59392、tier10 $1.18784。
- 排期表模板：templates/round-schedule.md（含失败调整规则）。

| 轮次 | 计划窗口 | 奖励 | 团队额度 | 关键动作 |
| --- | --- | --- | --- | --- |
| R1 | T0+24h → +96h（报名）/ +168h（观察结束） | 7 亿 | 1.2 亿 | 首轮：确认流动性、公告、客服峰值 |
| R2~R10 | 各自 T0（上一轮结算）+24h 起 | 7 亿 | 1.2 亿 | 按 §3 SOP 滚动；失败轮同档重试 |

---

## 6. 每日/每班检查清单

### 每日 10:00 UTC（值班主责）

- [ ] monitor_check.mjs --notify：P0/P1 为 0，或已升级处置。
- [ ] 轮次状态/倒计时与链上一致；公告已发、渠道已同步。
- [ ] K 线进度（观察期）：应见 vs 已见；缺失即补提交并记录。
- [ ] pending burn/claim/team release：>30 分钟未确认 → P0。
- [ ] 供应量：账本 vs 链上（对账脚本）无漂移。
- [ ] 管理员操作日志：无未授权/异常操作。
- [ ] 值班交接：状态、未结事故、待执行操作、公告排期。

### 每班交接必须包含

- 当前轮次、状态、距下一阶段时间；
- 最近 8h 告警与处置；
- 未确认的链上动作（burn/release/claim）；
- 下一次公告时间与负责人；
- 需要双人复核的操作队列。

---

## 7. 对账表模板

模板：ops/templates/reconciliation.csv；生成：node ops/scripts/reconcile.mjs --chain --out ops/records/reconciliation-<timestamp>.csv。

| 字段 | 说明 | 核对规则 |
| --- | --- | --- |
| round_id / state / tier | 轮次、状态、档位 | 与链上 RoundView 一致 |
| target_usd_e8 | 锁定目标价 | ≥ P0×2^tier 且 = max(阶梯, 2×TWAP)，任何人可复算 |
| stake_total_raw / staker_count | 本轮质押与地址数 | 与链上 stakes 汇总一致 |
| expected_burn_raw | 失败轮 7 亿 + 1.2 亿 + 本金 | 与 recorded_burn_raw 差异必须为 0 |
| recorded_burn_raw / burn_delta_raw | 链上实际销毁/差异 | 差异 ≠0 → P0 |
| team_release_expected_raw | 成功轮应为 1.2 亿 | 实际释放 ≤1.2 亿且仅一次 |
| supply_ledger_raw / supply_chain_raw / supply_drift_raw | 账本/链上供应量与漂移 | 漂移 ≠0 → P0，暂停对外 |
| updated_at / notes | 数据更新时间与备注 | 记录异常与解释 |

**三笔销毁明细**（reward / team / principal + txHash + 确认状态）在切真链后由事件索引补齐；过渡期用 expected_burn_raw 与总销毁核对。

---

## 8. KPI 看板字段

完整字段见 ops/templates/kpi-dashboard.md。每轮必须更新：

- 经营：roundId、tier、target、stakeTotal、stakerCount、top1ShareBps、qualifiedCandles、result、rewardUnlocked/Claimed、principalReturned、burnedReward/Team/Principal/Total、teamReleased、supplyAfter、burnConfirmSec、claimPending。
- 增长：uniqueStakersTotal、newStakersRound、repeatRate、stakeConcentrationBps、walletConnectCount、claimRate。
- 技术：cronHeartbeatAgeSec、candleSeenVsExpected、oraclePaused、pendingActions、bounceFailedTx24h、contractTonBalance、supplyDriftRaw、adminOpsAbnormal。

---

## 9. 公告矩阵

| 时点 | 模板 | 渠道 | 审批 |
| --- | --- | --- | --- |
| 预告期（开窗前） | open | 官网/X/TG 中英 | Lead 批准 |
| 关窗（正常/触价） | stake-close | 官网/X/TG | Ops Lead |
| 观察暂停/恢复 | pause / resume | 官网/X/TG + 状态页 | Lead + 合约负责人 |
| 判定成功/失败 | success / fail | 官网/X/TG | Lead 批准（失败需财务核对三笔后） |
| 技术终止 | abort | 官网/X/TG + 客服话术 | Lead + 项目方 |

模板库：ops/templates/announcements.json；渲染：node ops/scripts/announcement.mjs --type <type> --round <N> --lang both --out ops/records/ann-u.md；发送需 --post-telegram 且 OPS_CONFIRM=YES。详见 05_announcements.md。

---

## 10. 异常决策矩阵

| 场景 | 立即动作 | 禁止 | 升级 |
| --- | --- | --- | --- |
| K 线缺失/延迟 | 补提交、记录；连续缺 2 根以上发暂停公告并排查 | 把缺失当未达标 | P1，合约负责人 |
| 预言机/数据源异常 | PauseOracle（双人）；发 pause 公告；记录最后有效 K 线 | 暂停期间结算/销毁 | P1 |
| K 线被伪造/来源冲突（测试网） | 停止提交、公开数据复核、必要时暂停 | 继续用可疑数据判定 | P0，Lead |
| 结算卡住 >30 分钟 | 查 burn ack/pending；重试 pending 动作；发状态更新 | 手工改状态/跳过确认 | P0 |
| supply 漂移 | 停止对外披露；全量对账；保留现场 | 继续结算/领取 | P0，Lead+财务 |
| 管理员异常操作 | 立即暂停相关动作、核对日志与签名者、公告 | 隐瞒/继续 | P0，项目方 |
| 合约疑似漏洞 | 暂停（若可）、停止质押、技术评估、公告 | 自行打补丁 | P0，合约负责人+审计 |
| 技术终止条件满足 | 任何人可触发 AbortTechnical；发 abort 公告；核对退款 | 提前触发/伪造条件 | P1 |

---

## 11. 交接与归档

- 每轮结束后 24h 内完成：公告、对账、KPI、事故记录、证据归档。
- 事故记录模板：ops/templates/incident-log.csv；P0/P1 必须 24h 内出复盘。
- 值班表模板：ops/templates/shift-schedule.csv。
- 所有对外数字必须链上可验证；不发布未确认的销毁/释放数字。

---

*本手册覆盖 10 轮全部运营动作；任何与链上合约冲突处，以经审计合约与签署参数为准。*
