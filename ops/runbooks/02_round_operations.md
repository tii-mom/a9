# 02 — A9 测试网 10 城运营手册（Round Operations，v11）

**版本**：v11（2026-11-07）
**Owner**：testnet-ops
**权威口径**：docs/35 §1–§4（玩法）、contracts/README §2、§3、§5、§7.1（链上实现与 ABI）
**脚本与命令**：以 `ops/README.md` §4–§5 为准。本文各节列出具体命令。

### 0. 常用命令速查

所有写操作先 dry-run（不设 `OPS_EXECUTE`），核对后再加 `OPS_EXECUTE=1 OPS_CONFIRM=YES` 和 `--execute` 广播。钱包 `<keeper 钱包名>`、`<publisher 钱包名>` 用 `acton wallet import` 导入。`<worker>` 为测试网 Worker 地址（`https://a9-testnet.<subdomain>.workers.dev`）。

~~~bash
# 状态（只读）
node ops/scripts/80_admin_ops.mjs --action status --round N

# keeper：开城（集结结束后，--twap24h 为 24h TWAP，USD_E8）
OPS_CONFIRM=YES A9_SIGNER_WALLET=<keeper 钱包名> node ops/scripts/80_admin_ops.mjs --action open-round --round N --twap24h <USD_E8> --execute

# keeper：攻城到点后关窗（任何人也可）
OPS_CONFIRM=YES A9_SIGNER_WALLET=<keeper 钱包名> node ops/scripts/80_admin_ops.mjs --action close-staking --round N --execute

# keeper：提交单根 K 线（每小时一根；快测每分钟一根）
OPS_CONFIRM=YES A9_SIGNER_WALLET=<keeper 钱包名> node ops/scripts/80_admin_ops.mjs --action submit-candle --round N --candle <0-23> --twap <USD_E8> --digest <64hex> --observation-start <unix秒> --execute

# keeper 循环（测试网演练用，合成 K 线；不用于正式判定）
OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/keeper-candles.mjs --rc <RC 地址> --signer <keeper 钱包名> --rounds N --mode success

# 任何人：结算退回（见 SettlementBounced 后，≥ 0.3 TON）
OPS_CONFIRM=YES A9_SIGNER_WALLET=<wallet> node ops/scripts/80_admin_ops.mjs --action retry-settlement --round N --execute

# 任何人：技术终止（条件满足时）
OPS_CONFIRM=YES A9_SIGNER_WALLET=<wallet> node ops/scripts/80_admin_ops.mjs --action abort-technical --execute

# 任何人：团队最后额度释放（第 10 城结束 30 天后，≥ 0.1 TON）
OPS_CONFIRM=YES A9_SIGNER_WALLET=<wallet> node ops/scripts/80_admin_ops.mjs --action release-team --execute

# 对账（只读）
node ops/scripts/reconcile.mjs --chain --strict --out ops/records/reconciliation-<日期>.csv
~~~

---

## 1. 时间线

### 1.1 正式档（主网参数与正式测试网）

| 阶段 | 时长 | 说明 |
| --- | --- | --- |
| 集结 PREVIEW | 12 h | 不接受上车。预告结束后，keeper 才能发 OpenRound |
| 攻城 STAKING_OPEN | 36 h | 三档时机：前 12 h ×1.5、中 12 h ×1.2、后 12 h ×1.0 |
| 守城 OBSERVING | 24 根 × 1 h K 线 | 从关窗开始计 |
| 判定 | 第 24 根提交时 | ≥ 16 根达标为破城，≤ 15 根为阵亡。没有中间态 |
| 技术终止超时 | 7 天（`abortTimeoutSeconds` = 604800） | 见 §3.7 |

- 单城约 72 小时，10 城约 30 天。
- **没有提前关窗，没有暂停。** 攻城期到点即关，不能提前，也不能延长。
- 0 人攻城也照常守城，不跳过。

### 1.2 快速档（只用于测试网演练）

- 集结 10 分钟、攻城 30 分钟（三档各 10 分钟）、K 线 24 根 × 1 分钟、阈值 16、技术终止超时为演练专用的短值。
- 参数与部署方式见 `ops/drills/2026-11_testnet_v11_10round_drill.md` §1。
- 快速档的数字只在测试网有效，不得用于主网或对外公告。

---

## 2. 角色与权限

| 角色 | 职责 | 可做 | 不可做 |
| --- | --- | --- | --- |
| Ops Lead | 轮次总控、对外口径、决策 | 读状态；组织公告；升级事故 | 不得单独执行 keeper 写操作 |
| Keeper 热钱包 | 开城、提交 K 线 | OpenRound（集结结束后）；SubmitCandle；攻城结束后也可 CloseStaking | 不能提现、改参数、暂停；只放少量 gas |
| 任何人 | 链上兜底动作 | CloseStaking（攻城到点后）；AbortTechnical（条件满足时）；RetrySettlement（≥ 0.3 TON，见到 SettlementBounced 后）；ReleaseTeam（第 10 城结束 30 天后，≥ 0.1 TON） | 不得伪造条件调用（不满足会 revert） |
| 用户 | 上车、领取、续战 | 质押转账（payload v2）；TicketClaim（≥ 0.15 TON）；TicketRestake（≥ 0.25 TON，建议 0.3） | — |
| On-call | 7×24 告警响应 | 读状态；按预案调用上表中的兜底动作（需留痕） | 不得替换或伪造 K 线；不得改参数 |
| Comms | 公告 | 按模板发布（经 Lead 批准） | 不承诺收益；不公开内部地址 |
| Finance | 对账 | 只读链上与对账表 | 不得动用金库 |
| 合约负责人 | 故障定位 | 排查；必要时重建 | 不得热修（合约不可升级） |

**双人规则**：以下动作必须"一人操作 + 一人核对"，并留痕：

- 手工 SubmitCandle、补交或改交 K 线；
- OpenRound（含 twap24h 输入）；
- 手工调用 AbortTechnical、RetrySettlement、ReleaseTeam；
- 军饷 SetRoot（见 §4）。

测试网同样执行，用来演练主网流程。

---

## 3. 每城 SOP

### 3.1 判定确认（结算后立即）

第 24 根提交后，读取 RoundSettled 事件，逐项核对：

| 字段 | 成功时 | 阵亡时 |
| --- | --- | --- |
| status | SUCCEEDED | FAILED_PERMANENT |
| qualifiedCandles / candlesSeen | ≥ 16 / 24 | ≤ 15 / 24 |
| totalAcceptedStakeRaw | 本城总本金（可为 0） | 本城总本金（可为 0） |
| rewardBudgetRaw | 7 亿 + 开城时的 carry | 同左 |
| teamReleasedRaw | 上一次破城留下的团队额度；第一次破城时为 0 | 0 |
| rewardBurnRaw | 0 | 奖池的一半（rewardBudget / 2） |
| teamBurnRaw | 0 | 1.2 亿（本城团队额度） |
| principalBurnRaw | 0 | 本城全部本金 |
| carryAfterRaw | 0；若 0 人攻城则为整个奖池 | 奖池的另一半（奖池本身已含原有 carry） |
| tierAfter | 1 + 已破城数 | 不变 |

- 团队额度：破城时，上一次破城的 1.2 亿由 RC 转给 teamWallet（只转一次），本城的 1.2 亿挂起，等下一次破城才转出。
- 第 10 城结算（或第 10 城技术终止）时，endAt 写入，剩余 carry 并入销毁并清零。
- 检查是否出现 **SettlementBounced**（0x52540110）或 **UnexpectedBounce**（0x52540111）。见 §3.6。
- 对账：`node ops/scripts/reconcile.mjs --chain --strict --out ops/records/reconciliation-<日期>.csv`，差异必须为 0，或已解释并记录。
- **军饷 compute**：每次结算后（无论破城、阵亡还是技术终止，技术终止见下）执行：

  ~~~bash
  curl -s -X POST -H "Authorization: Bearer ${ADMIN_TOKEN}" "https://<worker>/api/admin/junxiang/compute?round=N"
  ~~~

  N = 刚结算的城，1–10。

  技术终止城是否执行 compute，`ops/README.md` 未作规定，执行前由 Lead 确认，本文不默认执行。
- 发布结算公告（success / fail / abort 模板，见 `05_announcements.md`）。数字必须与 RoundSettled 一致。
- 归档：交易哈希、事件、对账输出、公告链接 → `ops/records/`。

### 3.2 PREVIEW 集结（上一城结算后 12 h）

- 下一城档位：`tier = 1 + 已破城数`。阵亡只保持档位，不升档。
- 目标价在开城时锁定：`max(P0 × 2^tier, 2 × 开窗前 24h TWAP)`。P0 = 116000 USD_E8（$0.00116）。
- 公告中的目标价以链上 **TargetPriceSet** 事件为准，任何人可以用 P0、tier、TWAP 复算。
- 确认 RC TON ≥ 20，keeper TON ≥ 2（门槛见 `01_deploy_testnet.md` §4）。
- 确认 RC 余额足以覆盖本城 7 亿奖励与 1.2 亿团队额度（对账输出）。
- 准备开城公告（open 模板），集结结束前审批。
- **keeper 在集结结束后发 OpenRound。** 第 2 城起，合约会检查"集结已结束"，提前发送会被拒绝。第 1 城没有集结期，部署后可直接开。OpenRound 不带城号，合约自动开下一城。
- 异常：
  - 集结结束后 1 小时仍未开城：`monitor.next_round.overdue`（P1），升级 keeper 排查。
  - 集结结束后 abortTimeout（正式档 7 天）仍未开城：任何人可调用 AbortTechnical（§3.7）。

### 3.3 攻城 STAKING_OPEN（36 h，快速档 30 分钟）

- 最低上车 **1,000 A9**。v11 没有单地址上限和本城总额上限。
- 上车方式：Jetton 转账到 RC，payload v2（`op 0x5254000F`，`version = 2`，含 `roundId`、`beneficiary`）。
  - 转账附带 TON ≥ 0.1 才有效（建议 forward 0.12，消息总额 0.3）。
  - **无效上车**：附带 TON ≥ 0.1 时原路退回；不足 0.1 时**不退**（没有退款账本）。前端必须足额附带。客服要向用户讲清楚这一点。
- **受益人（beneficiary）**：付款人与攻城令持有人可以不同。攻城令记在受益人名下。一键上车（STON.fi 转入）也走这个字段。
- **一键续战（TicketRestake）**：在当前城攻城期内，用旧攻城令把本金直接转入当前城（本金不出合约）。
  - 本金按当前时机档计入战力。
  - 20% 立即奖励照常转给用户；80% 留在旧攻城令上。
  - 只能在当前城 STAKING_OPEN 时发起。
- 每 4 小时巡检（监控自动化）：
  - 本城总本金、战力、上车次数
  - 上车次数 ≠ 人数。stakerCount 按入账笔数计，前端标注为"上车次数"
- 战队摘要：攻城期每 6 小时发一次（见 §7）。

### 3.4 CloseStaking（攻城到点）

- 攻城到点后，**任何人**都可以发 CloseStaking。正常由 keeper 发。
- 确认 StakingClosed 事件已发出。观察期从这一刻开始计。
- 发布关窗公告（stake-close 模板），写明观察起止时间。
- 冻结质押快照：totalAcceptedStakeRaw、上车次数、最大单笔占比，写入对账表。
- **0 人攻城也照常观察**。公告要说明：通过则奖池滚入下一城（不是销毁）；阵亡则奖池一半销毁、一半滚存。
- 攻城到点 1 小时后仍未关窗：`monitor.roundN.close_overdue`（P1）。

### 3.5 OBSERVING 守城（24 根 K 线）

- keeper 每小时提交一根 K 线（快速档每分钟一根）。
- 单根提交字段：`roundId`、`candleIndex`（0–23）、`periodStart`、`periodEnd`、`twapPriceUsdE8`、`dataDigest`。
  - `periodStart = observationStart + i × candleSeconds`，`periodEnd = periodStart + candleSeconds`。
  - `observationStart` 必须与链上 StakingClosed 的时间一致。
  - `dataDigest` 为 64 位十六进制（可带 0x）。
- 达标规则：TWAP ≥ 目标价，**含等号**。
- 每根 K 线归档：原始数据源、计算过程、digest、提交交易哈希。K 线事件公开，任何人都可以复核。
- 每根亮灯后，群里会收到亮灯消息（见 §7）。
- 监控：
  - K 线落后（应见 − 已见 > 1 根）：`monitor.roundN.candle_lag`（P1）
  - 时间区间错误、重复提交：立即停止并排查
- 观察超时：如果 keeper 停了，观察不会自动结束。超过 abortTimeout 后任何人可以 AbortTechnical（§3.7）。

**禁止**：

- 观察窗口内更换价格源或修改目标价；
- 把缺失数据当成未达标；
- 在第 24 根之前人工判定；
- 在 K 线之外手工调整判定结果。

### 3.6 判定与结算（第 24 根提交时）

判定即结算，没有第二笔交易。

**破城（≥ 16 根）**：

- 奖励按 `reward = rewardBudget × weight ÷ totalWeight` 向下取整，尾差留在合约。
- 每个攻城令：
  - 本金 + 20% 立即奖励：用户自己发 TicketClaim 领取。
  - 80% 压城奖励：锁定。**此后任意一城破城，即解锁**（用户再次 TicketClaim 时领取可领部分）。
- 上一次破城的团队额度此时转给 teamWallet；本城的 1.2 亿挂起。
- 0 人破城：整个奖池滚入下一城，团队额度同上，tier 照常升。

**阵亡（≤ 15 根）**：

- 一笔销毁：奖池一半 + 1.2 亿团队额度 + 全部本金。
- 奖池另一半滚入下一城。
- 本城攻城令无可领；TicketClaim 会被拒绝（bounce 后清除 pending，不转账）。
- 同档重试：tier 不变。

**SettlementBounced**（0x52540110，字段 `roundId`、`action`，以事件字段为准）：

- 只代表结算转账或销毁被退回，不改变判定结果。
- 出现即调用 **RetrySettlement**（≥ 0.3 TON）。调用前先看事件中的 action 类型。
- 调用后核对：RC 钱包余额、teamWallet 收款或 total_supply 变化，并写入对账表。
- 不得手工转账补救。

**UnexpectedBounce**（0x52540111，字段 `op`、`queryId`）：

- 不明退回。**不自动重试，不补转**。
- 核查 op 与 queryId，冻结对外数字，通知合约负责人，按 P0 处理。

### 3.7 技术终止（AbortTechnical，任何人可调用）

两种情况，条件不满足时调用会 revert。

| 情况 | 触发条件 | 合约行为 | 运营动作 |
| --- | --- | --- | --- |
| 观察超时（reason 2） | 当前城处于 STAKING_OPEN 或 OBSERVING，且 `now ≥ 攻城结束 + 观察时长 + abortTimeout` | 本金可领（经攻城令，不含奖励）；本城奖池全额滚入 carry；档位不变；团队额度留存；下一城进入 PREVIEW | 双人确认后调用；发 abort 公告；核对攻城令可领本金 |
| 集结超时（reason 3） | 下一城仍为 PREVIEW，且 `now ≥ 该城预告结束 + abortTimeout` | 该城不开，其 7 亿 carry 滚入；档位不变；再开一个 PREVIEW | 双人确认后调用；发 abort 公告 |

- 正式档 abortTimeout = 7 天。快速档由部署参数决定（见 drill §1）。
- 技术终止会消耗一个城号。第 10 城也可能被技术终止（见 §3.8）。
- **不要用任何权限绕过，也不要伪造条件。**

### 3.8 第 10 城结束

- 第 10 城结算（或第 10 城技术终止）后，RC 写入 endAt。
- 剩余 carry 并入销毁，清零。
- 之后：
  - **第 10 城破城**：此前所有未解锁的 80% 压城奖励立即解锁，攻城令持有人照常领取。
  - **第 10 城阵亡或技术终止**：未解锁的压城奖励从 endAt 起按 30 天线性解锁。这一规则在 endAt 之后才生效，endAt 当刻可领为 0%。
  - 团队最后一笔额度：endAt + 30 天后，**任何人**可调用 ReleaseTeam（≥ 0.1 TON）。
- 第 10 城结束后，不会再开新城，也不再接受上车。

### 3.9 P7 — 进入下一城

- 失败城：tier 不变，公告写明"下一城仍是同一档目标"。
- 技术终止：不消耗档位，本金可领，7 亿与 1.2 亿留在 RC（不分配、不销毁）。
- 成功城：tier 升一档（successCount + 1）。
- 进入下一城的 PREVIEW，回到 §3.2。

---

## 4. 军饷（JunxiangDistributor）每周流程

军饷是链下计算、链上领取的一笔。每周一次，或按运营排期。

**硬规则：先注资，后发根（SetRoot）。顺序不能反。**

原因：领取合约的 A9 余额不足时，转账会被退回（bounce），而该笔领取额度会被记为"已领"。如果先发根再补钱，已经 bounce 的用户拿不回这部分额度，只能靠人工补偿。

流程：

1. **生成清单**：

   ~~~bash
   curl -s -X POST -H "Authorization: Bearer ${ADMIN_TOKEN}" -H "Content-Type: application/json" \
     -d '{"fromRound": <起城>, "toRound": <止城>}' "https://<worker>/api/admin/payout/build"
   ~~~

   返回 summary（listId、root、总额、行数）。鉴权头 `Authorization: Bearer <ADMIN_TOKEN>`。
2. **核对清单**：核对 root 与 `GET /api/social/payout/latest` 返回一致；核对总额与各城 compute 行数之和一致。
3. **算应注资额**：

   ```text
   应注资额 = 新清单总额 − 已支付总额（分发合约记录）
   ```

4. **注资**：把应注资额的 A9 转入分发合约的 A9 钱包。资金来源是营销钱包（公开地址，公示）。ops 没有专用充值动作，用 contracts 的 `fund_jetton.tolk`。**第二个位置参数必须是分发合约地址（owner），不是它的 Jetton 钱包地址**（见 `01_deploy_testnet.md` §2.4 事故）：

   ~~~bash
   cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<treasury 钱包名> JETTON_MASTER_ADDRESS=<JettonMaster 地址> \
     acton script --net testnet scripts/deploy/fund_jetton.tolk <分发合约地址> <应注资额 raw>
   ~~~
5. **回读余额**：分发合约 A9 钱包余额 ≥ 应注资额。不足则停止，不得发根。
6. **SetRoot**（publisher 发，listId 必须严格递增）：只有第 5 步通过后才执行。

   ~~~bash
   OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<publisher 钱包名> \
     node ops/scripts/80_admin_ops.mjs --action junxiang-set-root --list <listId> --root <0x64hex> --total <累计总额 raw> --execute
   ~~~

   80 在广播前读取分发合约 A9 余额，低于 `--total` 或读取失败即拒绝（dry-run 只提示）。这是脚本的第二道保险，不替代第 5 步的人工核对。
7. **验收**：合约读到的 root 与 API 返回一致；抽一个钱包领取一次，重放同一笔应被拒绝。

**领取**：用户带自己的证明（`GET /api/social/payout/proof?wallet=`）调用 ClaimJunxiang（≥ 0.15 TON）。

- 可领额 = 累计额 − 已领额。
- 只有最新根有效。旧根的证明一律失效（旧证明会被拒绝）。
- 同一证明重放应被拒绝。

**阻塞条件**：分发合约余额 < 应注资额，或根与 API 不一致 → 停止，不发根，按 P0 处理。

---

## 5. 结算与退回监控

| 事件 | 含义 | 动作 |
| --- | --- | --- |
| SettlementBounced（0x52540110） | 结算转账或销毁被退回 | RetrySettlement（≥ 0.3 TON）；核对余额与 teamWallet；记录 |
| UnexpectedBounce（0x52540111） | 不明退回 | 不自动重试；核查 op 与 queryId；P0；通知合约负责人 |

- 这两个事件必须订阅，并在每班巡检中确认。
- **已知限制**：破城轮的团队额度退回不会被 keeper-candles 自动重试（它无法区分「未发出」和「被退回」）。必须看到 SettlementBounced 后人工执行 retry-settlement。
- **已知限制（R10 对账）**：运营台账没有建模第 10 城的 carry 销毁。第 10 城结算时，对账可能出现差异提示。以该城 RoundSettled 事件的 rewardBurnRaw 为准核对，不以台账为准。
- 监控规则见 `03_monitoring_alerting.md`。

---

## 6. 亮灯与战队摘要

### 6.1 亮灯（每根 K 线）

- 每根 K 线结算后，bot 向所有战队群发一条亮灯消息（`pushCandleUpdate`）。
- 24 盏灯，亮 16 盏破城。
- 推送记录写入 `bot_pushes` 表（主键 round_id + candle_index，只加不删）。查某城已推送根数：

  ~~~bash
  cd worker && ./node_modules/.bin/wrangler d1 execute a9-testnet --env testnet --remote \
    --command "SELECT COUNT(*) AS pushed FROM bot_pushes WHERE round_id = N"
  ~~~

  没有单独的失败记录表。推送缺失时，对照 candles 表补发。
- 快速档每分钟一盏灯，测试群会很吵，这是正常的。

### 6.2 战队摘要（每 6 小时）

- 只在攻城期（STAKING_OPEN）发送，发送时刻为 UTC 00 / 06 / 12 / 18 整点。
- 内容：战队排名、"还差几人升级"。
- 非攻城期或非整点，不会发送。快速档的 30 分钟攻城期很可能遇不到整点，这种情况在 drill 里记为"未演练，本地测试覆盖"。

### 6.3 bot 命令

- `/team`：群主把 bot 拉进群后发送，把该群创建为战队。
- `/gate`、`/rank`、`/me`：查询当前城状态、排名、个人状态。

---

## 7. 每日与每班检查清单

### 每日 10:00 UTC（值班主责）

- [ ] 监控：P0 / P1 为 0，或已升级处置
- [ ] 轮次状态与倒计时和链上一致；公告已发，渠道已同步
- [ ] 观察期 K 线进度：应见 vs 已见；缺失即补交并记录
- [ ] keeper 心跳正常；keeper 与 RC 的 TON 在阈值以上
- [ ] SettlementBounced 与 UnexpectedBounce：有则按 §3.6 处理，无遗留
- [ ] 供应量与 RC 余额对账无漂移（§8）
- [ ] keeper 出账记录只有预期的 OpenRound 与 SubmitCandle
- [ ] Telegram webhook 健康（`03_monitoring_alerting.md`）
- [ ] 亮灯消息送达（抽查最近一根 K 线的群消息）
- [ ] 值班交接

### 每班交接必须包含

- 当前城、状态、距下一阶段的时间
- 最近 8 小时告警与处置
- 未确认的链上动作（RetrySettlement、待确认的 CloseStaking 或 AbortTechnical）
- 军饷流程进度（compute / build / 注资 / SetRoot）
- 下一次公告时间与负责人
- 需要双人复核的操作队列

---

## 8. 对账表

生成：`node ops/scripts/reconcile.mjs --chain --out ops/records/reconciliation-<日期>.csv`，输出到 `ops/records/`（git 忽略）。

| 字段 | 说明 | 核对规则 |
| --- | --- | --- |
| round_id / state / tier | 城号、状态、档位 | 与链上一致 |
| target_usd_e8 | 锁定目标价 | = max(P0 × 2^tier, 2 × TWAP)，任何人可复算 |
| stake_total_raw / deposit_count | 本城总本金、上车次数 | 与 DepositAccepted 汇总一致 |
| reward_budget_raw | 本城奖池（7 亿 + carry） | 与 RoundSettled 一致 |
| reward_burn / team_burn / principal_burn | 三项销毁 | 与 RoundSettled 一致 |
| team_released_raw | 本城转给 teamWallet 的额度 | 每次破城只转一次；金额 = 上一次破城留下的 1.2 亿 |
| rc_wallet_expected_raw / rc_wallet_chain_raw / rc_wallet_drift_raw | RC 余额期望与链上值 | 期望公式见下；漂移 ≠ 0 → P0 |
| supply_chain_raw / supply_drift_raw | 链上 total_supply 与账本 | 账本 = 1e19 − 累计销毁（三项合计）；漂移 ≠ 0 → P0 |
| distributor_expected_raw / distributor_chain_raw | 分发合约 A9 余额期望与链上值 | 期望 ≥ 最新清单总额 − 已支付；不足 → P0 |
| updated_at / notes | 更新时间与备注 | 记录异常与解释 |

**RC 余额期望公式**（carry 留在 RC 里）：

```text
RC 余额期望 = 82 亿
            − 已释放团队额度（teamReleased 之和）
            − 已销毁的奖励与团队额度（rewardBurn + teamBurn 之和，不含本金）
            − 已领取的奖励（immediate 与已解锁的 locked 之和）
            + 未领取本金
```

- "已销毁"不含本金：本金销毁已经从"未领取本金"中扣除，不能重复扣。
- carry 与尚未分配的团队额度（如技术终止城留存的额度）都仍在 RC 里，不扣减。
- 第 10 城结束后，RC 里剩下的应是：未分配的团队额度、尚未释放的团队额度、未解锁的压城奖励、未领取本金。

**总供应量期望**：

```text
total_supply = 1e19 − （rewardBurn + teamBurn + principalBurn 的全部累计）
```

---

## 9. KPI 看板

每城必须更新：

- 经营：roundId、tier、targetUsdE8、stakeTotal、depositCount、qualifiedCandles、result、成功与阵亡金额、teamReleased、supplyAfter、claimPending
- 增长：uniqueStakersTotal、newStakersRound、repeatRate、stakeConcentrationBps、claimRate
- 技术：cronHeartbeatAgeSec、candleSeenVsExpected、keeperTonBalance、settlementBounced、unexpectedBounce、rcVaultDriftRaw、supplyDriftRaw、distributorDriftRaw

完整字段见 `ops/templates/kpi-dashboard.md`。

---

## 10. 公告矩阵

| 时点 | 模板 | 渠道 | 审批 |
| --- | --- | --- | --- |
| 集结开始 | open | 官网 / X / TG（中英） | Lead 批准 |
| 攻城结束（关窗） | stake-close | 官网 / X / TG | Ops Lead |
| 判定成功 | success | 官网 / X / TG | Lead 批准 |
| 判定阵亡 | fail | 官网 / X / TG | Lead 批准（财务核对销毁金额后） |
| 技术终止 | abort | 官网 / X / TG + 客服话术 | Lead + 项目方 |

- 模板库：`ops/templates/announcements.json`；渲染与发送方式见 `05_announcements.md`。
- 公告里的数字必须以链上事件为准。
- 对外不承诺收益，不承诺时间点。

---

## 11. 异常决策矩阵

| 场景 | 立即动作 | 禁止 | 升级 |
| --- | --- | --- | --- |
| K 线缺失或延迟 | keeper 补交；落后 > 1 根触发告警 | 把缺失当成未达标 | P1，合约负责人 |
| keeper 失联（未开城或未交 K 线） | 查 keeper 服务与 TON；abortTimeout 到期后任何人可 AbortTechnical | 手工替换结果；更换 keeper（合约里没有入口） | P1 |
| K 线可疑（来源冲突、疑似伪造） | 停止对外宣称该城结果；用公开数据复核；评估 keeper 是否泄露 | 继续以可疑数据对外判定 | P0，Lead |
| SettlementBounced | RetrySettlement；记录 | 手工转账补救 | P1 |
| UnexpectedBounce | 核查 op 与 queryId；冻结对外数字；通知合约负责人 | 自行二次转账或重试 | P0 |
| 供应量或 RC 余额漂移 | 停止对外披露；全量对账；保留现场 | 继续公告结算数字 | P0，Lead + 财务 |
| 军饷分发合约余额不足 | 停止发根；补足应注资额；回读余额 | 先发根再补钱 | P0，Lead + 财务 |
| 误先发根后注资（或根已发而余额不足） | 停止；统计受影响领取；通知合约负责人与 Lead | 人工直接改记录 | P0，项目方 |
| 合约疑似漏洞 | 停止前端入口（运维开关）；停止 keeper 提交；保留现场 | 自行打补丁 | P0，合约负责人 + 审计 |
| keeper 密钥疑似泄露 | 公告；评估重部署（keeper 无法更换） | 等待 | P0，项目方 |
| 技术终止条件满足 | 任何人可调用 AbortTechnical；发 abort 公告；核对攻城令可领本金 | 提前或伪造条件调用 | P1 |

---

## 12. 交接与归档

- 每城结束后 24 小时内完成：公告、对账、KPI、事故记录、证据归档。
- 事故记录：`ops/templates/incident-log.csv`；P0 与 P1 必须在 24 小时内出复盘。
- 所有对外数字必须链上可验证；不公布未确认的销毁或释放数字。

---

## 13. v11 速查

### 13.1 RoundController 入站

| Opcode | 消息 | 谁可以发 | 备注 |
| --- | --- | --- | --- |
| 0x52540001 | OpenRound | keeper | 集结结束后；带 twap24h，不带城号 |
| 0x52540002 | CloseStaking | 任何人 | 攻城到点后 |
| 0x52540003 | SubmitCandle | keeper | 第 24 根即判定 |
| 0x52540010 | AbortTechnical | 任何人 | 条件满足时 |
| 0x52540015 | RetrySettlement | 任何人 | ≥ 0.3 TON |
| 0x52540016 | ReleaseTeam | 任何人 | 第 10 城结束 30 天后；≥ 0.1 TON |
| 0x5254000F | 质押 payload v2 | 用户（Jetton 转账 forward payload） | 无效上车：TON ≥ 0.1 才退回 |

### 13.2 攻城令（StakeTicket）

| Opcode | 消息 | 谁可以发 | 附带 TON |
| --- | --- | --- | --- |
| 0x52540303 | TicketClaim | 攻城令主人 | ≥ 0.15（建议 0.2） |
| 0x52540304 | TicketRestake | 攻城令主人 | ≥ 0.25（建议 0.3） |

### 13.3 事件

| Opcode | 事件 |
| --- | --- |
| 0x52540101 | TargetPriceSet |
| 0x52540102 | RoundSettled |
| 0x52540103 | DepositAccepted |
| 0x52540104 | TechnicalAborted |
| 0x5254010B | StakingClosed |
| 0x5254010C | CandleSubmitted |
| 0x5254010E | Claimed |
| 0x52540110 | SettlementBounced |
| 0x52540111 | UnexpectedBounce |
| 0x52540112 | Restaked |
| 0x52540113 | TeamReleased |

### 13.4 军饷

| Opcode | 消息 |
| --- | --- |
| 0x4a580001 | SetRoot（publisher，listId 严格递增） |
| 0x4a580002 | ClaimJunxiang（领取人，≥ 0.15 TON） |

---

*本手册与 contracts/README 和 docs/35 一一对应。任何与链上合约冲突之处，以经审计的合约与签署参数为准。*
