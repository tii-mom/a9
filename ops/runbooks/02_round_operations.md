# 02 — A9 测试网 10 轮运营手册（Round Operations，v10）

**版本**：v10（2026-11-06，D-42）
**Owner**：testnet-ops
**权威口径**：contracts/README.md（§0–§4）、docs/34 §1–§2、docs/00 的 D-42
**覆盖路径**：成功 / 失败 / 无人质押 / 技术终止 / 结算重试（五条）

---

## 1. 单轮时间轴

~~~text
T0              上一轮判定（SUCCEEDED / FAILED_PERMANENT，或 TECHNICAL_ABORTED）
T0 ~ T0+12h     PREVIEW 预告期（不接受质押；发预告、准备物料）
T0+12h          keeper 发 OpenRound：开窗，锁定目标价
T0+12h ~ +48h   报名 36h（到期后任何人可发 CloseStaking）
T0+48h          关窗 → 观察开始
T0+48h ~ +72h   观察 24 根 × 1h K 线（keeper 每小时 SubmitCandle）
第 24 根提交时  直接判定：SUCCEEDED 或 FAILED_PERMANENT → 下一轮 PREVIEW
~~~

- 报名时长 129,600 秒（36h）；观察 24 根 × 3,600 秒；单轮约 72h；10 轮约 30 天。
- **没有提前关窗，没有预言机暂停。** 开窗、关窗、判定都是合约规则；运营不能提前或延后。
- **判定不需要第二笔交易**：第 24 根 K 线提交即判定，没有结算中间态。
- 结算转账或销毁如果在第一跳被退回，会出现 SettlementBounced 事件，需要调用 RetrySettlement（见 §3.6）。这不影响判定结果。
- **R1 无预告期**：部署完成后 keeper 直接 OpenRound（见 01 Step 80）。
- **技术终止**：报名或观察阶段在应结束时间后 7 天仍未判定，或下一轮在预告结束后 7 天仍未开轮，任何人都可以调用 AbortTechnical。

---

## 2. 角色与权限

| 角色 | 职责 | 可用操作 | 不可做 |
| --- | --- | --- | --- |
| Ops Lead | 轮次总控、决策、对外口径 | 读状态、组织公告、升级事故 | 不得单独执行 keeper 写操作（需双人） |
| Keeper 热钱包 | 开轮、每小时提交 K 线 | OpenRound、SubmitCandle；到期后也可 CloseStaking | 不能提现、改参数、暂停；只放 gas |
| On-call | 7×24 告警响应、一线处置 | 读状态；按预案调用 CloseStaking、AbortTechnical、RetrySettlement（任何人可调，需留痕）；升级 | 不得伪造或替换 K 线；不得改参数 |
| Comms | 公告与社区沟通 | 按模板发公告（经 Lead 批准） | 不承诺收益；不透露未公开地址 |
| Finance | 对账、销毁与释放核对 | 只读链上与对账表 | 不得动用金库 |
| 合约负责人 | 故障定位、必要时重建 | 排查、新部署 | 不得热修已部署合约（不可升级） |

**双人规则**：以下操作必须“一人操作 + 一人核对”，并留痕：

- 任何手工 SubmitCandle、补交或改交 K 线；
- R1 开轮（含 twap24h 的输入）；
- 手工触发 AbortTechnical 或 RetrySettlement（即使合约允许任何人调用）。

测试网同样执行，以演练主网流程。

---

## 3. 每轮 SOP（7 个阶段）

### 3.1 P0 — 判定确认（判定当刻）

- [ ] `node ops/scripts/80_admin_ops.mjs --action status --round <N>`：确认状态为 SUCCEEDED（8）或 FAILED_PERMANENT（9）。
- [ ] 读 RoundSettled 事件：`status`、`qualifiedCandles`、`candlesSeen`、`totalAcceptedStakeRaw`、`tierAfter`、`rewardBurnRaw`、`teamBurnRaw`、`principalBurnRaw`、`teamReleasedRaw`。
- [ ] 成功：`teamReleasedRaw` = 1.2 亿 A9，且 RC 向 teamWallet 只转一次。
- [ ] 失败：`rewardBurnRaw` = 7 亿、`teamBurnRaw` = 1.2 亿、`principalBurnRaw` = 本轮总质押；total_supply 减少相同合计。
- [ ] 检查是否出现 SettlementBounced（0x52540110）。有则按 §3.6 处理。
- [ ] `node ops/scripts/reconcile.mjs --chain` 生成对账 CSV；差异必须为 0，或已解释并记录。
- [ ] 更新 KPI 看板（ops/templates/kpi-dashboard.md）。
- [ ] 发布结算公告（success / fail）；技术终止走 abort 模板。
- [ ] 归档：交易哈希、事件、对账 CSV、公告链接 → ops/records/ 与 ops/drills/。

### 3.2 P1 — PREVIEW 预告（T0 → T0+12h）

- [ ] 计算下一轮 tier = 1 + 已成功轮数（失败沿用同档）。
- [ ] 目标价在开窗时锁定：`max(P0 × 2^tier, 2 × 开窗前 24h TWAP)`。P0 = 116000 USD_E8。公告中的数字以链上 TargetPriceSet 为准。
- [ ] 检查 RC 钱包余额足够覆盖本轮 7 亿奖励与 1.2 亿团队额度（reconcile 输出）。
- [ ] TON：RC ≥ 20 TON，keeper ≥ 2 TON（见 01 Step 55）。
- [ ] 准备开轮公告（open 模板），预告期结束前审批发布。
- [ ] 确认流动性与做市物料（不做单边加池）：冷启动池 2 亿 A9 + $232,000 USDT（占流动性额度 40%，剩余 3 亿 A9 后续加池）。更新客服 FAQ。
- [ ] **keeper 在 T0+12h 发 OpenRound**（合约不会自动开窗）。运营只做**确认**：
  - `80_admin_ops --action status --round <N>` 显示开窗状态；
  - 链上 TargetPriceSet 的 target 与公告一致（任何人可用 P0、tier、TWAP 复算）。
- [ ] 若 T0+12h 之后 1 小时仍未开窗：触发 monitor.next_round.overdue（P1），升级 keeper 排查。预告结束 7 天后仍未开轮，任何人可调用 AbortTechnical 跳过本轮（见 §4）。

### 3.3 P2 — 报名 36h（T0+12h → T0+48h）

每 4 小时巡检（可由监控自动化）：

- [ ] `monitor_check.mjs`：健康、供应量、RC 钱包对账、keeper 状态。
- [ ] 质押总额与单地址占比：单笔 ≥ 100,000 A9；单地址每轮 ≤ 2,000 万 A9；本轮总额 ≤ 2 亿 A9（合约强制，前端提示）。
- [ ] 质押不可撤回；唯一退款路径见客服口径（无效质押立即退回；TON 不足时进退款账本，低于 10 万 A9 的零头不退）。
- [ ] 客服与社群统一口径：为什么不能取消质押、失败怎么销毁、技术终止怎么退款。
- [ ] 每日 10:00 UTC 更新运营日报（质押量、地址数、集中度、异常）。

### 3.4 P3 — 关窗（T0+48h）

- [ ] 到期后，keeper（或值班人员）发送 CloseStaking。任何人都可以发送，但正常由 keeper 发。
- [ ] 确认状态为 OBSERVING（4）；StakingClosed 事件已发出。
- [ ] 发布报名截止公告（stake-close 模板）：写明观察起止时间。
- [ ] 冻结质押快照：totalAcceptedStakeRaw、地址数、最大地址占比，写入对账表。
- [ ] 若无人质押：**照常进入观察**（不跳过、不延期、不判负）。公告中说明：0 人质押仍会观察；通过则 7 亿奖励销毁，团队额度照常释放。
- [ ] 报名到期 1 小时后仍未关窗：触发 monitor.roundN.close_overdue（P1）。

### 3.5 P4 — 观察 24h（24 根 1h K 线）

keeper 每小时提交一根 K 线。K 线数据必须公开可复核。

- [ ] 取得该 1h 区间的 TWAP，保留原始数据与计算说明。
- [ ] 计算 `periodStart = observationStart + i × 3600`，`periodEnd = periodStart + 3600`；observationStart 必须与链上一致。
- [ ] digest 为 64 位十六进制（可带 0x）。
- [ ] 单根提交（先 dry-run，再 EXECUTE）：
  ~~~bash
  node ops/scripts/80_admin_ops.mjs --action submit-candle --round <N> --candle <i> --twap <USD_E8> --digest <64hex> --observation-start <unix>
  ~~~
  脚本自动算 periodStart / periodEnd，并校验 observationStart + i × 3600；也支持显式传入 --periodStart / --periodEnd（不一致直接拦截）。
- [ ] 批量：`--from-json candles.json`（[{candleIndex, twapUsdE8, digest}]），或 `--count N --twaps a,b,c --digests h1,h2,h3`（与 count 等长）。
- [ ] 提交后确认 candlesSeen 增加；达标计数正确（TWAP ≥ target 计达标，含等号）。
- [ ] 每根 K 线归档：原始数据源、计算过程、digest、提交交易哈希。
- [ ] 监控：K 线落后（应见 − 已见 > 1 根，触发 monitor.roundN.candle_lag）、时间区间错误、重复提交。

**禁止**：观察窗口内更换价格源或改目标价；把缺失数据当成未达标；在第 24 根之前人工判定。

### 3.6 P5 — 判定与结算（第 24 根提交时）

- [ ] 第 24 根提交即判定。qualified ≥ 16 → SUCCEEDED；≤ 15 → FAILED_PERMANENT。无中间态。
- [ ] 公告数字必须与 RoundSettled 事件一致。
- [ ] **成功**：
  - 质押人用 `Claim(roundId)` 一次领取本金 + 全额奖励（奖励 = floor(7 亿 × 我的质押 / 本轮总质押)）；
  - 1.2 亿团队额度由 RC 直接转 teamWallet（只一次）。
- [ ] **失败**：一笔销毁（7 亿 + 1.2 亿 + 全部本金），total_supply 真实减少；该轮本金不可领取。未确认 RoundSettled 前不得公告“已销毁”。
- [ ] **0 人质押**：成功 → 7 亿销毁，团队 1.2 亿照常释放；失败 → 销毁 7 亿 + 1.2 亿。
- [ ] **SettlementBounced**（0x52540110，action：1 = 团队转账，2 = 销毁）：出现即调用 RetrySettlement（见 §3.6.1）。
- [ ] **UnexpectedBounce**（0x52540111，字段 op、queryId）：不明退回，**人工核查**，不得自行重试或补转。

#### 3.6.1 结算重试（RetrySettlement）

~~~bash
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<wallet> node ops/scripts/80_admin_ops.mjs --action retry-settlement --round <N>
~~~

- 任何人可调用，消息 value ≥ 0.3 TON。
- 只在看到对应轮次的 SettlementBounced 后调用；调用前先看事件中的 action 类型。
- 调用后核对：RC 钱包余额、teamWallet 收到的金额，或 total_supply 的变化，并写入对账表。

### 3.7 P6 — 公告与对账

- [ ] 发布成功或失败公告（模板 success / fail）。失败公告必须列出 7 亿、1.2 亿、本金三项销毁金额与合计。
- [ ] 对账：`node ops/scripts/reconcile.mjs --chain --strict`。差异 ≠ 0 时停止对外数字，升级 P0。
- [ ] 更新 KPI：通过率、销毁量、参与地址、领取率。
- [ ] 更新客服 FAQ：本轮结果、领取方式、下一轮预告。
- [ ] 归档本轮全部证据。

### 3.8 P7 — 进入下一轮

- [ ] 进入 12h PREVIEW，按 §3.2 重复。
- [ ] 失败轮：tier 不变（同档重试）；公告明确“下一轮仍是同一档目标”。
- [ ] 技术终止：不消耗档位；本金可领取；7 亿与 1.2 亿留在 RC；下一轮按原 tier 继续。

---

## 4. 路径处理矩阵

| 路径 | 触发条件 | 合约行为 | 运营动作 | 公告模板 |
| --- | --- | --- | --- | --- |
| 成功 | 24 根齐备，qualified ≥ 16 | 本金 + 全额奖励由 Claim(roundId) 一次领取；RC 直接转 1.2 亿到 teamWallet | 核对事件与转账、对账、KPI；发成功公告 | success |
| 失败 | 24 根齐备，qualified ≤ 15 | 一笔销毁（7 亿 + 1.2 亿 + 全部本金）；轮次永久关闭；本金不可领取 | 核对销毁金额与 total_supply 减少；对账；发失败公告；准备同档下一轮 | fail |
| 无人质押 | 关窗时总质押 = 0 | 照常观察；成功 → 7 亿销毁，团队照常释放；失败 → 销毁 7 亿 + 1.2 亿 | 公告说明；对账时本金项为 0 | stake-close / success / fail |
| 结算重试 | 出现 SettlementBounced | 对应的结算转账或销毁未完成 | 任何人调用 RetrySettlement（≥ 0.3 TON）；核对事件与余额 | 无需对外公告，记录即可 |
| 技术终止 | 观察应结束后 7 天，或预告结束后 7 天仍未开轮 | 任何人调用 AbortTechnical：本金可领取；7 亿与 1.2 亿留在 RC（不分配、不销毁）；不消耗档位 | 发 abort 公告；核对退款可领；按原 tier 继续下一轮 | abort |

**注意**：AbortTechnical 只能在合约条件满足时成功调用（否则 revert）。不要用任何权限绕过，也不要伪造条件。

---

## 5. 档位与排期

- tier = 1 + 已成功轮数。只有成功才升档；失败沿用同档。
- 10 轮不等于 10 个档位：连续失败会让后续轮次停留在低档。
- 每轮 target 在开窗时锁定：`max(P0 × 2^tier, 2 × 开窗前 24h TWAP)`。
- 阶梯下限参考（P0 = $0.00116）：tier1 $0.00232、tier2 $0.00464、tier3 $0.00928、tier4 $0.01856、tier5 $0.03712、tier6 $0.07424、tier7 $0.14848、tier8 $0.29696、tier9 $0.59392、tier10 $1.18784。
- 单笔最低 100,000 A9；单地址每轮固定上限 2,000 万 A9；本轮总上限 2 亿 A9。
- 排期表：ops/templates/round-schedule.md。

| 轮次 | 计划开窗（相对 T0） | 奖励 | 团队额度 | 关键动作 |
| --- | --- | --- | --- | --- |
| R1 | T0（keeper 直接 OpenRound，无预告期） | 7 亿 | 1.2 亿 | 部署后 TON、注资登记、twap 双人复核、公告、客服峰值 |
| R2~R10 | 上一轮判定 + 12h（约 T0 + 72h × (n − 1)） | 7 亿 | 1.2 亿 | 按 §3 滚动；失败轮同档重试 |

---

## 6. 每日与每班检查清单

### 每日 10:00 UTC（值班主责）

- [ ] `monitor_check.mjs --notify`：P0/P1 为 0，或已升级处置。
- [ ] 轮次状态与倒计时和链上一致；公告已发，渠道已同步。
- [ ] K 线进度（观察期）：应见 vs 已见；缺失即补交并记录。
- [ ] keeper 心跳正常；keeper 与 RC 的 TON 余额在阈值以上。
- [ ] SettlementBounced 与 UnexpectedBounce 事件：有则按 §3.6 处理，无遗留。
- [ ] 供应量与 RC 钱包：对账脚本无漂移。
- [ ] keeper 出账记录：只有预期的 OpenRound 与 SubmitCandle。
- [ ] 值班交接：状态、未结事故、待执行操作、公告排期。

### 每班交接必须包含

- 当前轮次、状态、距下一阶段时间；
- 最近 8h 告警与处置；
- 未确认的链上动作（结算重试、待确认的 CloseStaking / AbortTechnical）；
- 下一次公告时间与负责人；
- 需要双人复核的操作队列。

---

## 7. 对账表

模板：ops/templates/reconciliation.csv；生成：`node ops/scripts/reconcile.mjs --chain --out ops/records/reconciliation-<timestamp>.csv`。字段以 reconcile.mjs 的输出为准。

| 字段 | 说明 | 核对规则 |
| --- | --- | --- |
| round_id / state / tier | 轮次、状态、档位 | 与链上 RoundView 一致 |
| target_usd_e8 | 锁定目标价 | = max(P0 × 2^tier, 2 × TWAP)，任何人可复算 |
| stake_total_raw / staker_count | 本轮质押与地址数 | 与链上 DepositAccepted 汇总一致 |
| expected_burn_raw | 失败轮应销毁额：7 亿 + 1.2 亿 + 本金 | 与 RoundSettled 的三项销毁合计一致 |
| recorded_burn_raw / burn_delta_raw | RoundSettled 记录的销毁与差异 | 差异 ≠ 0 → P0 |
| team_release_expected_raw | 成功轮应为 1.2 亿 | 实际释放 ≤ 1.2 亿且只一次 |
| rc_wallet_expected_raw / rc_wallet_chain_raw / rc_wallet_drift_raw | RC 钱包余额按公式的期望值与链上值 | 期望 = 82 亿 − 已释放团队 − 已销毁 − 已领取奖励 + 未领取本金；漂移 ≠ 0 → P0 |
| supply_chain_raw / supply_drift_raw | 链上 total_supply 与 账本 | 账本 = 1e19 − 累计销毁；漂移 ≠ 0 → P0，暂停对外披露 |
| updated_at / notes | 更新时间与备注 | 记录异常与解释 |

> 终止轮的 8.2 亿（7 亿 + 1.2 亿）留在 RC，公式中不扣减。

---

## 8. KPI 看板

完整字段见 ops/templates/kpi-dashboard.md。每轮必须更新：

- 经营：roundId、tier、targetUsdE8、stakeTotal、stakerCount、qualifiedCandles、result、成功与失败金额、teamReleased、supplyAfter、claimPending。
- 增长：uniqueStakersTotal、newStakersRound、repeatRate、stakeConcentrationBps、claimRate。
- 技术：cronHeartbeatAgeSec、candleSeenVsExpected、keeperTonBalance、settlementBounced、unexpectedBounce、rcVaultDriftRaw、supplyDriftRaw。

---

## 9. 公告矩阵

| 时点 | 模板 | 渠道 | 审批 |
| --- | --- | --- | --- |
| 预告期（开窗前） | open | 官网 / X / TG（中英） | Lead 批准 |
| 关窗 | stake-close | 官网 / X / TG | Ops Lead |
| 判定成功 | success | 官网 / X / TG | Lead 批准 |
| 判定失败 | fail | 官网 / X / TG | Lead 批准（须财务核对销毁金额后） |
| 技术终止 | abort | 官网 / X / TG + 客服话术 | Lead + 项目方 |

模板库：ops/templates/announcements.json；渲染：`node ops/scripts/announcement.mjs --type <type> --round <N> --lang both`。发送需 `--post-telegram` 且 OPS_CONFIRM=YES。详见 05_announcements.md。

---

## 10. 异常决策矩阵

| 场景 | 立即动作 | 禁止 | 升级 |
| --- | --- | --- | --- |
| K 线缺失或延迟 | keeper 补交；落后 > 1 根时触发 candle_lag 告警并排查 | 把缺失当成未达标 | P1，合约负责人 |
| keeper 失联（未开轮或未交 K 线） | 查 keeper 服务与 TON gas；预告结束 7 天后任何人可 AbortTechnical | 手工替换结果；尝试更换 keeper（合约内无此入口） | P1 |
| K 线可疑（来源冲突、疑似伪造） | 停止对外宣称该轮结果；用公开数据复核；评估 keeper 是否泄露（见 04 §9） | 继续以可疑数据对外判定 | P0，Lead |
| 结算重试（SettlementBounced） | 调用 RetrySettlement；记录 | 手工转账补救 | P1 |
| 不明退回（UnexpectedBounce） | 核查 op 与 queryId；冻结对外数字；通知合约负责人 | 自行二次转账或重试 | P0 |
| 供应量或 RC 钱包漂移 | 停止对外披露；全量对账；保留现场 | 继续公告结算数字 | P0，Lead + 财务 |
| 合约疑似漏洞 | 停止前端质押入口（运维开关）；停止 keeper 提交；保留现场 | 自行打补丁 | P0，合约负责人 + 审计 |
| keeper 密钥疑似泄露 | 见 04 §9；公告；评估重部署 | 等待（keeper 无法更换） | P0，项目方 |
| 技术终止条件满足 | 任何人可调用 AbortTechnical；发 abort 公告；核对退款 | 提前或伪造条件调用 | P1 |

---

## 11. 交接与归档

- 每轮结束后 24h 内完成：公告、对账、KPI、事故记录、证据归档。
- 事故记录：ops/templates/incident-log.csv；P0 / P1 必须 24h 内出复盘。
- 值班表：ops/templates/shift-schedule.csv。
- 所有对外数字必须链上可验证；不发布未确认的销毁或释放数字。

---

## 12. v10 口径速查

| 项 | 规则 |
| --- | --- |
| 合约 | JettonMaster、标准 JettonWallet、RoundController 三个 |
| 运营角色 | 只有 keeper（热钱包，只放 gas）；没有 admin |
| 判定点 | 第 24 根 K 线提交时；无结算中间态 |
| 成功分配 | 奖励按质押占比分 7 亿；本金 + 奖励由 Claim(roundId) 一次全额领取；1.2 亿由 RC 直接转 teamWallet |
| 失败销毁 | 一笔：7 亿 + 1.2 亿 + 全部本金 |
| 领取 | Claim(roundId)（0x52540006）；ClaimAll（0x5254000E）；Claim(0) 领取退款账本 |
| 最低质押 | 100,000 A9 |
| 退款 | 无效质押立即退回（附带 ≥ 0.1 TON）；TON 不足时进退款账本，低于 10 万 A9 的零头不退 |
| 不可用功能 | 提前关窗、暂停或恢复、早领、推荐、连续参与、滚存、解锁、撤回质押 |

---

*本手册覆盖 10 轮全部运营动作；任何与链上合约冲突之处，以经审计合约与签署参数为准。*
