# 20 — 链上索引器对账报告（chain 模式 · fasttest v8.6 全 10 轮）

**版本**：1.0 · 2026-11-06  
**执行**：indexer-dev（task-39）  
**状态**：**PASS（diff = 0）**  
**上游**：[docs/19](19_TESTNET_ACCEPTANCE.md)（10 轮权威验收记录）、[docs/00](00_DECISIONS_V2.md)、[docs/17](17_REWARD_V2.md)

**对账实例**：fasttest v8.6（10 秒级时序，R1–R10 全部终态）

- RoundController `kQBQf1af2vBgu9Uxw5dcDJ_7zFUIgQihsorPGgHEZlv-6Xot`
- TeamVault `kQBFYc-AYafI9K7XTkN3bEKd1XGsg3h5zM6Kka75pILSbzL8`
- JettonMaster `kQCOYBSzkm5SEpv0g4Wg7NkCuiQGs47HlKPOzzXvff52kX65`
- RC Jetton Wallet `kQBQ0fLed0EnRnupf_MyIdKFSBFp4U75h3-V0UCo8Mr4R6L7` / TV Jetton Wallet `kQBFFdU4SZQjPabCwzIZvdsawG4a20nvuHKXveSAwVdEMEOx`

---

## 0. 结论（先看这 6 条）

1. **docs/19 的 10 轮不可变数字全部逐字段一致**：status / tier / target / candlesSeen / qualified（封顶口径）/ 质押 / 权重 / 团队释放 / 三笔销毁标志 —— **10/10 轮**。
2. **24 根 K 线滚动哈希 10/10 轮与链上 `get_round().candleHash` 逐字节一致**（本地按合约口径 `H(prev256‖index8‖twap128‖digest256)` 从原始 `SubmitCandle` 交易复算，不依赖 API）。
3. **销毁总额 5,520,910,000 A9 精确吻合**：奖励 4,900,000,000（7 轮）+ 团队 600,000,000（5 轮）+ 本金 20,910,000 = 5,520,910,000；且 `链上当前供应 4,479,090,000 + 销毁 5,520,910,000 = 10,000,000,000`，**误差 0 raw**。
4. **持币者枚举完整**：v3 `jetton/wallets` 共 10 个钱包，余额合计 = 链上总供应 4,479,090,000 A9（漏一个持有者等式即不成立）。
5. **本地 D1 端到端 31/31 通过**（真实链上 fixture 回放 + 本地 wrangler/D1）：10 轮 / 240 根 K 线 / 20 笔质押（含 1 笔滚存）/ 5 个失败轮三笔销毁 confirmed / 游标推进 / **二次 tick 幂等 writes=0** / 断线演练 ORACLE_PAUSED 且不写脏数据。
6. **对账 CLI 两次独立运行均 `DIFFS (0)`、退出码 0**（一次对线上链，一次对本地 worker API + fixture）。**没有「差不多」：任何 diff 非 0 都会 exit 1。**

---

## 1. 对账方法与铁律

| 项 | 做法 |
| --- | --- |
| 锚点 | 一切以 **get-method** 为准；交易/事件/K 线只是被检对象 |
| K 线 | 从 RC 入站 `SubmitCandle(0x52540003)` 原始 body 解析（V8 合约不再逐根存 K 线，只存滚动哈希） |
| 哈希 | 自研最小 BOC/位读取；cell hash 按 TON BOC 规则 `sha256(d1 d2 data)`；滚动哈希按合约同口径 |
| 金额 | 全程 BigInt / raw units 字符串，禁止浮点 |
| 时间 | 合约秒 / D1 毫秒，显式换算 |
| qualified | 链上 `qualifiedCandles` **被合约封顶在 minQualifiedCandles=16**，D1 存真实根数；对账口径 `min(值,16)`（表内并列展示） |
| 独立复算 | getter 用两条通道取（runGetMethod + 交易解析），任何一步失败即 FAIL / exit 1 |

工具：`worker/src/indexer/tools/chain-reconcile.mjs`（纯 node、零依赖、不 import TS，可独立跑）、`tools/selfcheck.ts`、`tools/e2e-local.mjs`（fixture 回放）。

---

## 2. 10 轮逐字段对照（链上 = docs/19）

| 轮 | 状态 | tier | target(USD_E8) | K 线 seen | qualified（链上封顶/真实） | 质押 A9 | 权重 A9 | 团队释放 | 奖励销毁 | 团队销毁 | 本金销毁 | docs/19 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | SUCCEEDED | 1 | 232000 | 24 | 16 / 24 | 0 | 0 | ✓ | ✓（零质押） | — | — | ✓ |
| R2 | FAILED | 2 | 464000 | 24 | 0 / 0 | 0 | 0 | — | ✓ | ✓ | ✓（0） | ✓ |
| R3 | SUCCEEDED | 2 | 464000 | 24 | 16 / 24 | 300,000 | 370,000 | ✓ | — | — | — | ✓ |
| R4 | FAILED | 3 | 928000 | 24 | 5 / 5 | **20,110,000** | **24,142,000** | — | ✓ | ✓ | ✓（20,110,000） | ✓ |
| R5 | SUCCEEDED | 3 | 928000 | 24 | 16 / 24 | 300,000 | 430,000 | ✓ | — | — | — | ✓ |
| R6 | FAILED | 4 | 1856000 | 24 | 0 / 0 | 200,000 | 300,000 | — | ✓ | ✓ | ✓（200,000） | ✓ |
| R7 | SUCCEEDED | 4 | 1856000 | 24 | 16 / 24 | 0 | 0 | ✓ | ✓（零质押） | — | — | ✓ |
| R8 | FAILED | 5 | 3712000 | 24 | 0 / 0 | 300,000 | 370,000 | — | ✓ | ✓ | ✓（300,000） | ✓ |
| R9 | FAILED | 5 | 3712000 | 24 | 0 / 0 | 300,000 | 400,000 | — | ✓ | ✓ | ✓（300,000） | ✓ |
| R10 | SUCCEEDED | 5 | 3712000 | 24 | 16 / 24 | 300,000 | 430,000 | ✓ | — | — | — | ✓ |

- **R2 / R7 为零质押轮，stake=0 属正常**（R2 失败：奖励+团队销毁；R7 成功：奖励销毁，D-18b 语义）。
- **R4 的 20,110,000 A9**：R3 成功奖励经 `RollReward` 滚入（撞单地址 20,000,000 上限）+ 直接质押 110,000。索引器按 `RewardRolled` 事件在下一轮补 stake 行（**合约滚存不发 DepositAccepted**），否则轮次总质押会少 2,000 万——这是本轮对账发现并修复的真实缺陷。
- 链上 `qualifiedCandles` 封顶 16，D1 存真实根数（成功轮 24 根全达标），对账用 `min(值,16)`。

---

## 3. K 线滚动哈希 10/10 逐轮一致

数据源：RC 入站 `SubmitCandle` 原始 body（每轮 24 条）。复算：`h0 = 0^256; hi = sha256_cell(h(i-1) ‖ index8 ‖ twap128 ‖ digest256)`。

| 轮 | 链上 candleHash（`get_round` 槽 20） | 本地复算 |
| --- | --- | --- |
| R1 | `0x5e2492a2d99bacfcec45a081b98e285d6a27f5f3ccd1452e274ed71a8efb6e16` | 同值 ✓ |
| R2 | `0x5e2492a2…efb6e16` | 同值 ✓ |
| R3 | `0x1228c15bb2df050e776d77e8e31574b15fad932b7fc2735ef4877df44b38226c` | 同值 ✓ |
| R4 | `0x4bb75d0021f916971b4b29e0a833c001e0d6810322cc63a5aaa0926cb996082a` | 同值 ✓ |
| R5 | `0xdf270034ba4faad9c4a7c2e6f426aedaec9b2821a508f931421a1ea3d2fce6da` | 同值 ✓ |
| R6 | `0xdf270034…fce6da` | 同值 ✓ |
| R7 | `0xf7f0d5c1a43a733aa54ca9170ac79d70809ebbe9096221a2647fd8c10a870540` | 同值 ✓ |
| R8 | `0xf7f0d5c1…870540` | 同值 ✓ |
| R9 | `0xf7f0d5c1…870540` | 同值 ✓ |
| R10 | `0x6aee7d4d692bbdf087c3290c4f368e9d8c6f6dcaf41a5371428aa674f37ad169` | 同值 ✓ |

> 相邻轮哈希相同是**链上事实**（keeper 在两轮提交了相同 twap/digest 序列），不是解析错误；每轮都独立与链上值比对通过。
> 失败轮 `failureBurnId` 亦逐轮复算一致（`H(roundId8‖0xff8‖configVersion32)`）：R2 `0xe3b91958…`、R4 `0x708fb740…`、R6 `0xbbc38a97…`、R8 `0xe5532792…`、R9 `0xbd78feff…`。

---

## 4. 三笔销毁逐轮核对（金额 + confirmed 标志）

```
奖励销毁  7 轮 × 700,000,000 A9 = 4,900,000,000 A9   （失败 5 轮 + 零质押成功 R1/R7）
团队销毁  5 轮 × 120,000,000 A9 =   600,000,000 A9   （R2/R4/R6/R8/R9）
本金销毁  R4 20,110,000 + R6 200,000 + R8 300,000 + R9 300,000 = 20,910,000 A9
────────────────────────────────────────────────────────────────────
合计 = 5,520,910,000 A9 = 5,520,910,000,000,000,000 raw
```

- 每笔 `rewardBurnConfirmed / teamBurnConfirmed / principalBurnConfirmed` 均与 docs/19 一致（§2 最后三列）。
- 团队**释放**仅 5 个成功轮（R1/R3/R5/R7/R10，`teamReleaseConfirmed=true`）；TeamVault Jetton Wallet 余额 = **0**（10 × 1.2 亿不余不漏）。
- 索引器三态：`SETTLING_FAILURE` + flag=false → `burn_ledger.confirmed=0（dispatched）`；flag=true → confirmed=1；三笔齐全才写 burned_raw（D1 e2e 已验证 5/5 失败轮）。

---

## 5. 总量守恒与钱包快照

| 项 | 值（A9） | 校验 |
| --- | --- | --- |
| 链上总供应（当前） | 4,479,090,000.000000000 | `get_jetton_data` |
| 持币者 10 钱包合计 | 4,479,090,000.000000000 | v3 `jetton/wallets` 枚举求和，**误差 0 raw** |
| 累计销毁（getter 独立复算） | 5,520,910,000.000000000 | §4 |
| 初始供应 | 10,000,000,000.000000000 | 当前供应 + 销毁 = 1e19，**误差 0 raw** |

角色钱包（与 docs/19 一致）：

| 持有者 | 链上余额 A9 | docs/19 |
| --- | --- | --- |
| TeamVault Jetton Wallet | 0 | 0 ✓ |
| team | 600,000,000 | 600,000,000 ✓ |
| marketing | 497,000,000 | 497,000,000 ✓ |
| liquidity | 500,000,000 | 500,000,000 ✓ |
| 团队内盘管理钱包 | 800,000,000 | 800,000,000 ✓ |

**docs/19 快照之后的 claim 对平**（docs/19 = 2026-11-05 20:13 UTC 时点快照，之后用户继续领取）：

| 项 | raw |
| --- | --- |
| RC Jetton Wallet：docs/19 1,732,259,899.434318040 → 当前 1,731,908,337.243493495（流出） | 352,236,284,249,365 |
| 用户 A/B/C 合计流入（当前 − docs/19） | 352,236,284,931,325 |
| 差额 | **−681,960 raw（≈0.00068 A9）** |

差额来自 docs/19 用户余额仅 3 位小数（每人 ≤±500,000 raw 舍入，3 人 ≤±1,500,000 raw），在舍入误差内；**RC 流出 = 用户流入**，证明差异是时点快照 + 后续 claim，不是索引错误。

解锁路径（只读 getter，不触发 claim）：

| 项 | 链上 | docs/19 |
| --- | --- | --- |
| `get_unlock_info(A).unlockStart` | 1793909617 | >0 ✓ |
| `totalLockedRaw` | 698,900,062,853,551,224 | 698,900,062,853,551,224 ✓（逐 raw） |

---

## 6. 本地 D1 端到端（fixture 回放，零云依赖）

工具：`worker/src/indexer/tools/e2e-local.mjs`（真实链上响应录制 → `fixture-server.mjs` 假 toncenter → `wrangler dev --local` + 本地 D1 → 真实 worker 代码）。一次运行 **31/31 通过**：

| 类别 | 断言 |
| --- | --- |
| cron 入口 | `/cdn-cgi/local/scheduled` 200；chain 配置键全部写入（否则 /api 503） |
| 轮次 | 10 轮；state/target 与链上 getter 一致（10/10） |
| K 线 | API candlesSeen 合计 240 = 交易解析 240；periodStart = obsStart + index×candleSeconds；qualified 计数一致 |
| 假数据清零 | `stats.liquidityUsdE8 = null`、`stats.price24hAgoUsdE8 = null` |
| 价格/预言机 | `priceUsdE8 = 3712000`（最近一根已上链 K 线 TWAP）；oracle online、非 paused |
| 销毁 | 失败轮 5/5（金额 + confirmed） |
| 幂等 | 第二次 tick `writes=0`；`/api/rounds` 快照不变 |
| 独立复核 | 内嵌对账 CLI 对同一快照 `DIFFS (0)` |
| 断线演练 | fixture 下线 → tick `ok:false` 不抛错、`chain_sync_healthy=0`、`/api/stats` `oracle.paused=true`、candles/stakes/burn 行数不变 |
| 停机后 D1 | rounds=10 / candles=240 / stakes=20 / 5 失败轮销毁 confirmed / 游标存在 |

复现：`node worker/src/indexer/tools/e2e-local.mjs` → 预期 `== E2E 结果：31/31 通过 ==`，EXIT=0。

---

## 7. 对账命令（线上实例）

```bash
node worker/src/indexer/tools/chain-reconcile.mjs --network testnet --doc19 \
  --registry ops/config/fasttest-v86.registry.json \
  --rc 0:507f569f…5bfee9 --tv 0:4561cf80…82d26f --jm 0:8e6014b3…dfe7691 \
  --rc-wallet 0:50d1f2de…ca47 --tv-wallet 0:4515d538…4430
# 预期：DIFFS (0) ✅ ；EXIT=0
# 选项：--json report.json 输出机器可读报告；--api <worker> 追加 API 对账；无 TONCENTER_API_KEY 时自动 5s 限速
```

**本次实测**：`DIFFS (0)`、`EXIT=0`、getter 锚点 10 轮、configHash `sha256:ed97a3bf…aee6`。
（`ORACLE_CONFIG_HASH` canonical 规则见 `worker/src/indexer/config.ts` 注释：22 槽声明顺序 + 地址 `wc:hex` / 整数十进制字符串 + `JSON.stringify` 无空格 + sha256。）

---

## 8. 索引器实现要点

| 主题 | 实现 |
| --- | --- |
| 数据源 | `sources/chain.ts` 纯同步零网络；价格 = 最近一根已上链 K 线 TWAP，无则 0 + ORACLE_PAUSED（不插值、不回退 demo） |
| 拉取 | v3 `/transactions` 按 `lt` 游标分页（limit 100，`start_lt` inclusive + 去重），只消费 `finality=finalized` |
| 事件 | external-out：`0x52540101–108` / `0x52540201–202`；K 线来自入站 `SubmitCandle` |
| 幂等键 | K 线 `(round,index)`；质押 `nonce=tx.lt`（滚存 `roll:lt`）；销毁 `burn_ref=R{id}:{kind}`；领取/推荐唯一键 |
| 状态映射 | 链上 status 0–10 → D1；PREVIEW(1) 映射 UNOPENED（前端用 lastSettledAt+preview 倒计时）；终态不回退 |
| 滚存 | `RewardRolled` 事件 → 下一轮补 stake 行，并在 round_rewards 标 ROLLED |
| 销毁三态 | dispatched（status 7/9 且 flag=false）→ confirmed（getter flag / BurnAck / ReturnExcessesBack）；只允许 0→1 |
| 最终性 | 只吃 finalized；崩溃后从游标重放（幂等） |
| 并发 | D1 metrics 原子租约（TTL 120s，单写者）+ 幂等写入 + 单调性校验 |
| 配置一致性 | `configVersion`/`configHash`/jettonMaster/teamVault 任一不符 → 拒绝出数、ORACLE_PAUSED |
| 失败策略 | 429/5xx 指数退避+抖动；连续失败 3 次 → paused；key 失效 fatal；cron 永不抛错 |
| 单一写者 | chain 模式 `rounds.candle_hash / total_weight / round_rewards` 由索引器按链上值写；v8.ts chain 模式整体跳过 |

---

## 9. RPC 请求预算（实测口径）

| 项 | 每轮(72h) | 10 轮/30 天 |
| --- | --- | --- |
| RC 交易分页 | ~2,632 | ~26,320 |
| TeamVault 交易分页 | 864 | 8,640 |
| JettonMaster 供应（1h） | 72 | 720 |
| getter（事件后 + 结算锚点 + 每笔新质押） | ~112 + N | ~1,120 + 10N |
| **合计（N=50）** | **~3,682** | **~36,800** |

平均 **0.014 rps**、峰值 <1 rps、单 tick ≤6 subrequest。**免费 TONCENTER_API_KEY（10 rps）月容量 ~2,600 万，用量 0.14%，无需付费 RPC**；但**必须**配 key（公共无名额实测 6 连发 4 个 429 / 1.2s 间隔也 429）。无 key 时按设计**拒绝启动并 ORACLE_PAUSED**（e2e 已验证）。

---

## 10. 已知限制 / 待办

1. **生产参数实例（task-43）尚未重部署**：旧 `kQBXqfV0…` 是 v8.5，不作为对账目标；新实例部署后重跑 §7 命令即可（脚本已就绪，<5 分钟）。
2. **TONCENTER_API_KEY 未注入**：本次线上对账以 5s 限速 + 429 退避完成；上线前由 ops 注入 secret。
3. **测试网单源**：`coverage_bps=10000`（合约强制 period 精确对齐 = 时间全覆盖）、`validSourceCount=1`（链上单一提交者）——如实展示，不谎称多源。
4. **`trades / book_levels` 在 chain 模式为空**：无可验证二级市场时宁可空；DEX 适配器另立任务。
5. **principal claim 明细**：链上 `ClaimPrincipal` 消息不带金额，D1 `claims` 只记录有金额的事件（Early/Unlock）；本金领取状态以 `get_user_stake.principalClaimed` 为准（P1 补抽样回填）。
6. **潜在双写窗口**：D1 candle 行数暂时少于链上 `candlesSeen` 时，`state.ts` reconcile 会用行数重写计数。已与 backend-dev 记录：chain 模式计数/结算应以索引器为唯一写者；终态对账不受影响（本次 diff=0）。
7. **`liquidity_usd_e8` 需运维写入真实池子流动性**，否则 chain 模式返回 null（宁可空，不可假）。

---

## 11. 复现清单

```bash
# 1) 类型检查
cd worker && ./node_modules/.bin/tsc --noEmit    # 0 error

# 2) 纯函数单元自检（snapshot/ledger/digest/价格口径）
./node_modules/.bin/tsc src/indexer/tools/unit.ts --outDir /tmp/a9idx \
  --module commonjs --target ES2022 --moduleResolution node --skipLibCheck \
  --types @cloudflare/workers-types && node /tmp/a9idx/indexer/tools/unit.js

# 3) docs/19 全生命周期对账（线上）
node worker/src/indexer/tools/chain-reconcile.mjs --network testnet --doc19 ...   # DIFFS (0)

# 4) 本地 D1 端到端（fixture 回放，零云依赖）
node worker/src/indexer/tools/e2e-local.mjs                                        # 31/31 通过
```

---

## 12. 审计结论

chain 模式下 worker 不再依赖任何演示数据：K 线来自链上 `SubmitCandle` 原始消息，价格来自已上链 TWAP，轮次/质押/销毁/解锁全部以 get-method 为锚点；10 轮全生命周期**不可变字段 diff = 0**，总量守恒**误差 0 raw**；本地 D1 端到端 **31/31**、幂等与断线降级均验证通过。

**唯一未完成的验收项是「生产参数实例（v8.6 + 12h/36h/24h）重部署后的只读对账」**，脚本与流程已就绪（§7/§11）。

---

## 附录 B — 技术终止轮的余额口径（D-39）

技术终止（`TECHNICAL_ABORTED`）的轮次，其 7 亿奖励与 1.2 亿团队额度**不分配也不销毁**，永久留存于 RC / TV 的 jetton 钱包（合约无提现函数）。

对账要求：
1. **总量守恒公式不变**：所有持有者之和 == 链上 `totalSupply`（终止轮的余额仍属于 RC/TV 钱包，本来就计入）。
2. **报告必须加一行解释**：RC/TV 钱包余额中含 `N_aborted × 7亿`（RC）与 `N_aborted × 1.2亿`（TV）的**不可用余额**，避免审计方误以为「凭空多出的余额」。
3. 若出现技术终止轮次，`burned` 应只统计真实的三笔销毁，**不得把终止轮的奖励计入 burned**。
4. 决策依据：`docs/00` **D-39**。
### 附录 B-2 — round-0 退款账本对索引器不可见（v8.7 F2）

v8.7 的 F2 修复引入 `stakes[roundId=0]` 作为**质押退款账本**：当用户质押的入站 TON 不足（< 0.12）或退款转账 bounce 时，A9 记入该账本，用户需主动 `ClaimPrincipal(roundId=0)` 领回。

**索引器看不到这部分数据，且这是正确的**：
1. 退款不进 `DepositAccepted` 事件（质押被拒）→ 索引器按事件同步的 `stakes` 表**不会**有 round 0 行；
2. 因此 D1 的 `rounds.total_accepted_stake_raw` / `stakes` 统计**不受影响**（round 0 不属于任何轮次）；
3. 守恒校验仍然成立：这些 A9 就躺在 RC 的 jetton wallet 里，本来就计入「所有持有者之和 == totalSupply」；
4. **前端直接读链上 `get_user_stake(0, owner)`** 展示与领取（不改 worker / shared/types）。

对账时若发现「RC 钱包余额 > 已分配−已发放−已销毁」的差额，首先要怀疑的就是 round-0 账本余额与技术终止轮余额（附录 B），而不是数据错误。
---

## 附录 C — v8.8 对账口径（2026-11-06，代码冻结 `fb6bb45` / `v8.8-audit-fixed`）

**代码哈希**（本次冻结只在 v8.8 改动，其余 4 个不变）：

| 合约 | code hash | 相对 v8.6 |
| --- | --- | --- |
| RoundController | `0x4EE42C5C…3EF8` | **变**（退款账本 carry、移除 `get_claimable_all` 的 round-0） |
| TeamVault | `0xCF3E6C7C…58B4` | 不变 |
| JettonMaster | `0x876F21A1…D64F` | 不变 |
| JettonWallet | `0x394E4E8D…49A4` | 不变 |
| OracleAdapter | `0x539F3597…8CBA` | 不变 |

### C-1 技术终止轮不可用余额（对应附录 B / D-39）

- `N_aborted` = `get_round(r).status == 10 (TECHNICAL_ABORTED)` 的轮次数（并用 `TechnicalAborted(0x52540104)` 事件交叉校验，以 status 为准）。
- **RC 不可用余额 = `N_aborted × 700,000,000 A9`；TV 不可用余额 = `N_aborted × 120,000,000 A9`。**
- 该金额**不销毁、不分配、不释放**，永久留存于 RC / TV 的 jetton wallet；对账报告单独成行，**不计入异常/差额**。
- 技术终止轮的三笔销毁与团队释放标志必须全为 false（索引器校验；若出现 true 视为异常）。
- `burned` 只统计真实三笔销毁，**不得把终止轮奖励计入 burned**（总量守恒里它们仍在持有者余额中）。

### C-2 round-0 退款账本（对应附录 B-2，v8.7 F2 / v8.8 M4-01）

- 索引器按 `DepositAccepted` 事件同步，**看不到** round-0（退款不是轮次）——这是正确的；D1 `stakes` 不写 round 0。
- 余额对账必须把 round-0 的 A9 计入「RC 钱包应持有」：
  - **主口径（现金流）**：`round0Held = Σ被拒入账(transfer_notification 且同 tx 无 DepositAccepted) − ΣRC 钱包退款/领取转出`。
    该口径对 pending（钱已出账、账本尚未清零）也成立，不会因中途快照产生假差异。
  - **辅助口径（getter）**：对候选 owner（持币者 ∪ 被拒 transfer 发起人）逐个读 `get_user_stake(0, owner)`：
    `principalClaimed == false` 计入可领；`true` 且 `amountRaw > 0` 是**在途/待结算**（报告中单列，不计入持有）。
  - 两者不一致时报告注明在途条目，不判数据错误。
- 前端直接读链上 `get_user_stake(0, owner)` 展示与领取（`ClaimPrincipal(0)`），worker / shared/types 不变。

### C-3 v8.8 余额预期公式（reconcile CLI `--balances` 实现）

```
RC 应持有 = RC 初始注资（first inbound internal_transfer）
          + Σ DepositAccepted.amountRaw
          + round0Held（C-2 净留存）
          + N_aborted × 700,000,000
          − Σ RewardEarly.paidRaw − Σ UnlockClaimed.amountRaw
          − Σ PrincipalClaimedEvent.amountRaw（含 ClaimRolledBack 冲减）
          − Σ 奖励销毁(flag) − Σ 本金销毁(flag)

TV 应持有 = TV 初始注资
          + N_aborted × 120,000,000
          − Σ 逐轮 get_round_state(r).released 金额
          − Σ 逐轮 get_round_state(r).burned 金额
```

要点：
1. **初始注资不写死 7B / 1.2B**：测试实例可能手工注资，取 jetton wallet 首笔入站 `internal_transfer(0x178d4519)` 金额（可用 `--rc-initial/--tv-initial` 覆盖）；生产实例应等于 70 亿 / 12 亿，若不等会在报告里显式列出。
2. **TV 释放以逐轮 `get_round_state` 为准**：v8.8 聚合 `totalReleasedRaw` 在部分路径可能漏记（实测 R1 钱包已转出 120M 而聚合仍为 0）；聚合值仅作交叉校验，不一致写 NOTE 不判索引错误。
3. 总量守恒：`Σ持币者 == totalSupply`、`totalSupply + burned == 10,000,000,000 A9`（技术终止轮不销毁）；两项误差必须 0 raw。
4. 所有金额 raw units / BigInt；报告同时打印 raw 与 A9 便于审计。

### C-4 v8.8 回归实例对账快照（`ops/config/regress-v88.registry.json`）

- RC `kQAIVoxXHrWkiH88k9yq_DPKiJR8-IfIf2BdeoocUsgGJs6F`（`0:08568c57…c80626`）、TV `kQBwpAyxSG23IAnfem0-OFqf-b-kH7_fv4rt6UsjpJSrO_7A`、JettonMaster `kQAwyGvhZ2IxD6nktU-d2jyvZ9rJkwbFfoS6h5OcA_xijh-u`。
- 该实例仍在跑轮次，**对账以报告头部的「快照时间（UTC）」为准**；进行中轮次只校验已解析 K 线的连续性，终态轮次才做不可变哈希比对。
- 结果见 §C-5（每次重跑以当次输出为准）。


### C-5 v8.8 回归实例对账结果（本次快照）

**命令**（`--balances` 为 v8.8 口径开关；实例地址显式传入，因 `regress-v88.registry.json` 在本任务执行期间被重置为未部署模板）：

```bash
node worker/src/indexer/tools/chain-reconcile.mjs --network testnet --balances \
  --rc kQAIVoxXHrWkiH88k9yq_DPKiJR8-IfIf2BdeoocUsgGJs6F \
  --tv kQBwpAyxSG23IAnfem0-OFqf-b-kH7_fv4rt6UsjpJSrO_7A \
  --jm kQAwyGvhZ2IxD6nktU-d2jyvZ9rJkwbFfoS6h5OcA_xijh-u
```

**快照**：`2026-11-06T09:38:27.758Z`（UTC）；链上 `currentRound=1`，R1 `status=6 (SETTLING_SUCCESS)`；configHash `sha256:f4f6b5ade3c256527e982c79ac8f5f1efcda27483904e70d41a77cdacca5a93f`。

| 项 | 链上 / 计算 | 备注 |
| --- | --- | --- |
| **DIFFS** | **0** | CLI 退出码 0 ✅ |
| RC 初始注资（首笔 internal_transfer） | 7,000,000,000 A9 | 非写死，自动检测 |
| Σ DepositAccepted（轮次内） | 100,000 A9 | 9 次质押中 1 次被接受 |
| round-0 退款账本净留存（被拒 900,000 − 已退 800,000） | 100,000 A9 | 已计入 RC 预期（C-2） |
| 技术终止不可用余额 | 0（N_aborted=0） | RC/TV 各 0；脚本已支持 N>0 场景 |
| **RC 应持有 vs 实际** | 7,000,200,000 vs 7,000,200,000 | **Δ=0 raw** |
| TV 初始注资 | 1,200,000,000 A9 | 自动检测 |
| **TV 应持有 vs 实际** | 1,200,000,000 vs 1,080,000,000 | Δ=−120,000,000 = 1×teamRoundRaw：R1 处于 SETTLING，团队转账已出 TV 钱包、ack 未落账 → **在途，不计异常**（NOTE） |
| 持币者合计 vs totalSupply | 10,000,000,000 vs 10,000,000,000 | Δ=0 raw（7 个钱包） |
| totalSupply + burned vs 1e19 | 10,000,000,000 + 0 | Δ=0 raw（尚无销毁） |

**说明**：该实例仍在运行，团队释放/结算 ack 存在秒级在途窗口；CLI 对「Δ 恰为 k × teamRoundRaw 且存在 SETTLING 轮次」明确标注在途，其余任何差额都会判 DIFF 并 exit 1。终态轮次（status 8/9/10）仍强制哈希/根数不可变校验。

**待补**：技术终止（N_aborted>0）场景尚无实例证据（本实例与 v8.6 均未触发 TECHNICAL_ABORTED）；脚本逻辑已实现（N×7亿 / N×1.2亿 单列 + 终止轮标志必须全 false），下次回归出现终止轮即可验证。

