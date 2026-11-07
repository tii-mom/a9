# 35 — v11 玩法规格：散户做庄 · 十城攻防

**状态**：项目方已确认（2026-11-06），取代 docs/00 中与本文冲突的口径；**优先级：本文 > contracts/README.md（v11 起）> 其余历史文档**。
**原则**：玩法简单、代码简单、容易上头。合约只管资金硬核；社交、公会、军饷全部链下。

---

## 0. 一句话

> **1 GRAM 上车，大家一起把价格推过城门；城门一开，奖池分给攻城的人。没打下来，奖池一半滚到下一城。**

口号：「这一次，散户做庄。」　首页主标题：「70 亿筹码锁在 10 座城里。城门是价格，钥匙是人。」

## 1. 已确认决策（D-43 ~ D-50）

| 编号 | 决策 |
| --- | --- |
| D-43 | 输了归零：城没破，本金 100% 销毁（无稳健/梭哈模式、无复活筹码、无免死金牌） |
| D-44 | 战力 = 本金 × 时机系数。攻城期 36h 分三档：前 12h ×1.5、中 12h ×1.2、后 12h ×1.0。奖池按战力占比分 |
| D-45 | 破城：本金立即全额可领；奖励 20% 立即可领，80% 压城——此后任意一城破城即解锁；第 10 城结束仍未解锁的，在结束后 30 天内线性解锁 |
| D-46 | 城没破：本城奖池 50% 销毁、50% 滚入下一城；团队本轮 1.2 亿销毁；本金全部销毁。0 人上车但破城、技术终止：奖池 100% 滚入下一城。第 10 城结束后剩余滚存全部销毁 |
| D-47 | 团队 1.2 亿晚一轮：第 r 城破城时不发，下一次破城时才发；最后一笔在第 10 城结束 30 天后可由任何人触发释放 |
| D-48 | 攻城令子合约：每人每城一个 StakeTicket 合约，RoundController 只存每城汇总，取消每轮 2,000 人上限、总额上限与单地址上限；最低上车 1,000 A9 |
| D-49 | 质押 payload 增加受益人字段（一键上车、赠送攻城令）；一键上车先对接 STON.fi |
| D-50 | 一键续战：破城后在后续任一城的攻城期内，用旧攻城令一键把本金直接转入当前城（本金不出合约），战力按当时时机档；奖励不能作为加权本金复利。连战加成只在链下军饷（每城 +2%，封顶 +10%） |

维持不变：10 城；2×；目标价开窗锁定 `max(P0×2^tier, 2×开窗 24h TWAP)`；tier = 1 + 已破城数，失败同档重试；12h 集结 + 36h 攻城 + 24 根 1h K 线 ≥16 根；单 keeper；不可升级；技术终止 7 天。

## 2. 用户语言（前端/机器人统一用词）

| 机制 | 用户用词 |
| --- | --- |
| 目标价 | 城门 |
| PREVIEW / STAKING_OPEN / OBSERVING | 集结 / 攻城 / 守城 |
| K 线达标 | 亮灯（24 盏，亮 16 盏破城） |
| SUCCEEDED / FAILED_PERMANENT | 破城 / 城没破（阵亡） |
| 质押仓位 | 攻城令 |
| 压城 80% | 压城奖励 |
| 链下奖励 | 军饷 |
| 公会 | 战队；队长 = 团长 |

**破城进度条**：`还差(USD) = 池中 USDT × (√(城门价 / 现价) − 1)`，现价 ≥ 城门时显示 0 并切到守城视图（已亮 x/16、现价高于城门 y%）。数据只取官方 STON.fi 池链上储备。

## 3. 合约 v11（RoundController + StakeTicket + 标准 Jetton）

### 3.1 存储
- RC 不再有 `stakes` 映射与退款账本；只存 config、`currentRoundId`、`successCount`、`rounds: map<uint8, RoundData>`、`carryRaw`（待滚入下一城的奖池）、`lastSuccessRound`、`teamPendingRaw`、`endAt`（第 10 城结算时刻，0 = 未结束）、`teamPendingReleased`。
- RoundData 增加：`rewardBudgetRaw`（开城时 = 7 亿 + carryRaw）、`totalWeightRaw`、`burnRaw`、`teamTransferRaw`（为重试保存的确切金额）。
- StakeTicket 初始数据只含 `(rc, owner, roundId)` 与零值字段，地址可由任何人推导：`get_ticket_address(owner, roundId)`。

### 3.2 上车（transfer_notification）
payload v2（右引用 cell）：`op 0x5254000F | version:u8=2 | roundId:u8 | riskVersion:u16 | acceptBurn:u8=1 | beneficiary:address`（addr_none = 记在转账发起人名下）。
有效条件：本城 STAKING_OPEN、在窗口内、`amount ≥ minStake`、附带 TON ≥ 0.1。有效则：`weight = amount × 系数 / 10000`，累加本城 `totalStakeRaw / totalWeightRaw / stakerCount`（stakerCount 按入账笔数计，前端标注为“上车次数”），向 `Ticket(beneficiary, roundId)` 发 `AddStake(amount, weight)`（带 stateInit）。无效：附带 TON ≥ 0.1 原路退回；否则不退（前端保证足额）。

### 3.3 结算（第 24 根 K 线）
- 破城且有人：`successCount++`；若 `teamPendingRaw>0` 先转给团队钱包；`teamPendingRaw = 1.2 亿`；`lastSuccessRound = r`。
- 破城但 0 人：奖池全额进 `carryRaw`，团队同上。
- 城没破：`burn = budget/2 + 1.2 亿 + totalStake`；`carryRaw += budget − budget/2`。
- r = 10 结算（或技术终止落在第 10 城）：`endAt = now`，剩余 `carryRaw` 并入本次销毁并清零。
- 技术终止：已开城的退本金、`carryRaw += budget`；集结期被跳过的城 `carryRaw += 7 亿`；团队额度留存（D-39）。

### 3.4 领取（用户 → 自己的攻城令 → RC → 用户）
- `ClaimTicket`：攻城令置 pending，携带 `(owner, roundId, amount, weight, principalDone, lockedClaimedRaw)` 发给 RC。RC 校验发送者地址 == 推导地址后计算：
  - 破城：`reward = budget × weight / totalWeight`；`immediate = reward × 20%`；`locked = reward − immediate`。未领过本金 → 付 本金 + immediate。压城部分可领额 = `lastSuccessRound > r` ? locked : (`endAt>0` ? locked × min(1, (now−endAt)/30d) : 0)，付 可领额 − 已领。
  - 技术终止：付本金。
  - 其他/无可领：抛错 → 攻城令收到 bounce 后清除 pending。
  - RC 回 `TicketUpdate(principalDone, lockedClaimedRaw)` 给攻城令，攻城令更新并清 pending。
- `RestakeTicket`（一键续战）：同上流程，但本金不转出，而是作为当前城的新入账（当前城须 STAKING_OPEN，系数按当时），向 `Ticket(owner, current)` 发 `AddStake`；immediate 奖励照常转给用户。
- `ReleaseTeam`（任何人）：`endAt>0 && now ≥ endAt+30d && teamPendingRaw>0` → 转给团队钱包。

### 3.5 TON 附带建议
上车 0.15（forward ≥ 0.1）；领取 0.2；续战 0.3；释放团队 0.2。

### 3.6 事件（新增/变化）
`DepositAccepted(roundId, owner, amountRaw, weightRaw, totalStakeRaw, totalWeightRaw)`、`RoundSettled(...原字段..., rewardBudgetRaw, carryAfterRaw)`、`Claimed(owner, roundId, principalRaw, rewardRaw)`、`Restaked(owner, fromRound, toRound, amountRaw, weightRaw)`、`TeamReleased(amountRaw)`。

## 4. 链下（不改合约，随时迭代）

### 4.1 Telegram（主战场）
- **小程序是唯一操作入口**；链接 `t.me/<bot>/app?startapp=r_<邀请码>_s_<战队码>`，打开即绑定邀请人与战队（首次绑定后不可改）。
- 任何页面「喊人」→ `shareMessage`/`switchInlineQuery` 发带实时数字的卡片；破城/阵亡一键 `shareToStory`。
- **群即战队**：群主把机器人拉进群并 `/team` → 该群成为战队。机器人推送：每根 K 线亮灯、攻城期每 6h 战队排名与“还差几人升级”、`/rank` `/me` `/gate`。

### 4.2 X（拉新）
- 一键发推用 Web Intent（无需 X API）：预填文案 + `#A9破城` + 邀请链接。
- 分享链接 `/s/<code>` 返回带动态 OG 图（实时奖池、还差多少、分享人战力排名）的落地页，单按钮跳 Telegram 小程序。
- 从 X 链接来的新人，邀请人记**双倍拉新分**（带兵榜用）。

### 4.3 战队（公会，一层）
- 一人一个战队，每赛季（10 城）可换一次。等级按本城上车人数：5 / 20 / 100 / 500 → 全队军饷 +3% / +6% / +10% / +15%；团长另得全队本金 1% 军饷。
- 三张榜（每城刷新、赛季累计）：**战队榜**（全队战力）、**个人战力榜**（前 100 称号：先锋/百夫长/将军/城主）、**带兵榜**（拉新上车人数，X 来源 ×2）。
- **阵亡勋章**：每输一城 +1，可叠加；破城时刻全服播报贡献前三战队。

### 4.4 军饷池（营销 5 亿中的 4 亿，每城约 4,000 万 A9）
| 项 | 每城 | 规则 |
| --- | --- | --- |
| 带兵饷 | 1,600 万 | 新人本金 10% 给邀请人、5% 给新人；新人 A9 来自邀请人转账的不算 |
| 战队饷 | 600 万 | 成团加饷 + 战队榜前 10 |
| 守城补贴 | 1,000 万 | 守城期净买入并锁进下一城，补 10%（第 1 城 20%） |
| 新人礼 | 600 万 | 免费攻城令：1 GRAM 影子仓位，破城按同等战力分奖，计入下一城上车 |
| 连战饷 + 猜灯 | 200 万 | 连战每城 +2%（封顶 +10%，输了也算）；猜灯仅限本城已上车者 |

超出预算按比例；单人单城上限为预算 2%；同资金来源/同 TG 账号合并。每周公布默克尔根，用现成空投合约领取；用军饷直接上车再 +20%。营销钱包改为公开地址（军饷公示）。

## 5. 不做（保持简单）
战队对战、战队金库、多级邀请、站内聊天、自动连战、复活/梭哈、keeper 2-of-3（列为后续）。
