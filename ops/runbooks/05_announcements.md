# 05 — A9 公告与沟通手册（v10）

**版本**：v10（2026-11-06，D-42）
**Owner**：testnet-ops（Comms 执行）
**模板库**：ops/templates/announcements.json
**渲染脚本**：ops/scripts/announcement.mjs
**权威口径**：docs/00 的 D-42、02_round_operations.md、03_monitoring_alerting.md

---

## 1. 原则

1. **不承诺收益**：不得出现“稳赚、保本、必过、无风险、固定回报、回本、翻倍”等表述。通过率与奖励都不保证。
2. **风险提示必须出现**：每份公告自动附加中英风险提示（高风险实验、可能损失全部本金、不构成投资建议、只信官方渠道）。
3. **数字必须链上可验证**：目标价、质押量、销毁量、团队释放必须来自链上事件或对账，不发布未确认的数字。
4. **失败不粉饰**：失败公告必须明确：本轮 7 亿奖励、1.2 亿团队额度与全部本金一次销毁，轮次永久关闭，本金不可领取。不得写“有机会退还”。
5. **不猜测、不承诺时间**：事故公告只写已发生的事实、已采取的措施、下一次更新时间；原因确认后再补充。
6. **地址纪律**：团队、营销、流动性、内盘地址不公开。只发布 JettonMaster、RoundController、JettonWallet 等公开地址，地址来自登记表。
7. **一致性**：中英两版信息一致；以中文为准，英文同步翻译。
8. **单一事实来源**：所有公告存档到 ops/records/，并在官网公告页留档。

---

## 2. 模板与审批

| # | 类别 | 模板 type | 触发时点 | 核心数字 | 审批 |
| --- | --- | --- | --- | --- | --- |
| 1 | 开轮 | open | 预告期内，开窗前 | roundId、tier、target、报名起止、规则 | Lead |
| 2 | 报名截止 | stake-close | 关窗（CloseStaking 之后） | 质押总额、地址数、观察起止时间 | Ops Lead |
| 3 | 成功 | success | 判定成功，且对账通过后 | 达标根数、目标价、奖励、团队 1.2 亿释放、领取方式 | Lead |
| 4 | 失败 | fail | 判定失败，且财务核对销毁金额后 | 达标根数、一笔销毁的三项金额与合计、永久关闭、同档重试 | Lead + 财务 |
| 5 | 技术终止 | abort | 条件满足且 AbortTechnical 执行后 | 原因、本金可领取、7 亿与 1.2 亿留在 RC 未销毁、档位不变 | Lead + 项目方 |

> 事故沟通另用“临时声明”（见 §6），不走模板库。

---

## 3. 渠道与节奏

| 渠道 | 用途 | 时点 | 负责人 |
| --- | --- | --- | --- |
| 官网公告页 | 永久存档，唯一权威 | 每次公告 | Comms |
| X（Twitter） | 传播，开轮与结果 | 同公告 + 置顶 | Comms |
| Telegram 中文群 | 社区同步，客服 | 同公告，5 分钟内 | Comms |
| Telegram 英文群 | 英文社区 | 同公告 | Comms |
| 状态页 | 实时状态与倒计时 | 持续 | Ops |
| 客服工单与 FAQ | 问题答复 | 持续 | 客服 |

**节奏**：每轮至少 3 条（开轮、报名截止、判定结果）；异常时按 §6 节奏执行。公告之间保持时间线一致；链上确认前不发布结果。

---

## 4. 模板变量与渲染

模板文件：ops/templates/announcements.json（中英双语，含 mandatoryDisclaimers）。

### 4.1 渲染命令

~~~bash
# 开轮公告（中英）
node ops/scripts/announcement.mjs --type open --round 1 --lang both

# 报名截止（带实际数据）
node ops/scripts/announcement.mjs --type stake-close --round 1 --lang both --data ops/records/ann-1-data.json --out ops/records/ann-1-close.md

# 成功（可从 Worker API 读取轮次数据）
node ops/scripts/announcement.mjs --type success --round 1 --api http://127.0.0.1:8787 --lang both

# 失败（金额由财务核对后手工提供）
node ops/scripts/announcement.mjs --type fail --round 2 --lang both --data ops/records/ann-2-fail.json

# 技术终止
node ops/scripts/announcement.mjs --type abort --round 2 --lang both --data abort.json
~~~

### 4.2 data JSON 示例（失败公告）

~~~json
{
  "roundId": 2,
  "qualified": 6,
  "stakeTotalRaw": "241500000000000000",
  "stakerCount": 9,
  "burnedRewardRaw": "700000000000000000",
  "burnedTeamRaw": "120000000000000000",
  "burnedPrincipalRaw": "241500000000000000",
  "burnedTotalRaw": "1061500000000000000",
  "nextRoundId": 3,
  "closeReason": "36 小时报名窗口到期，正常关闭"
}
~~~

> 数字为示例。实际发布时，三项销毁金额必须与该轮 RoundSettled 事件一致。

### 4.3 发送

- 默认只渲染，不发送。
- 真实发送：加 `--post-telegram`，并设置 OPS_CONFIRM=YES 与 TELEGRAM_BOT_TOKEN、TELEGRAM_OPS_CHAT_ID。
- 发送前完成 §5 的审批清单；发送后核对各渠道展示（链接、数字、风险提示）。

---

## 5. 发布前检查清单

- [ ] 模板类型与轮次正确（open / stake-close / success / fail / abort）。
- [ ] 所有数字与链上事件或对账一致（目标价、质押、销毁、团队释放）。
- [ ] 失败公告的三项销毁金额已由财务核对，且与 RoundSettled 一致。
- [ ] 中英两版信息一致；风险提示存在。
- [ ] 没有收益承诺、保本或必过等违规表述（见 §7）。
- [ ] 没有出现未公开的钱包地址或内部链接。
- [ ] 公告包含官网链接与“只信官方渠道”的防钓鱼提示。
- [ ] 审批人已确认（Lead、财务、合约负责人，按 §2 表格）。
- [ ] 存档路径已确定（ops/records/ann-<round>-<type>.md）。

---

## 6. 事故沟通节奏

| 阶段 | 时间 | 内容 | 形式 |
| --- | --- | --- | --- |
| 首次响应 | 发现后 30 分钟内 | 已发现、已止损；影响范围；下一次更新时间 | 临时声明 |
| 进展更新 | 每 60 分钟（P0） | 已确认事实、已采取措施、待确认事项 | 临时声明 |
| 恢复 | 恢复后 30 分钟内 | 恢复时间、影响范围、目标价不变 | 临时声明 |
| 技术终止 | 条件满足并执行后 30 分钟内 | 原因、本金可领取、不销毁、档位不变 | abort 模板 |
| 复盘 | P0 / P1 在 24h 内 | 时间线、根因、影响、改进 | 官网长文或线程 |

**临时声明结构**：

1. 事实：发生了什么（链上状态与时间）。
2. 影响：资金是否受影响；哪些轮次与用户受影响。
3. 已采取措施：停止入口、停止提交、对账等。
4. 用户需做什么：暂停质押、等待官方更新、不要点击非官方链接。
5. 下一次更新时间。

---

## 7. 禁用表述

- “稳赚 / 保本 / 无风险 / 一定通过 / 固定收益 / 回本 / 双倍返还 / 翻倍”
- “销毁后会拉盘 / 销毁越多涨越多 / 最后一轮必过”
- “内部消息 / 保证额度 / 优先通道”
- “项目已获法律意见 / 合规无风险”（D-34 已确认不做外部法律意见）
- 任何未上链或未确认的金额、时间、合作方。
- 任何“赌博式”的收益描述，例如“押多少、赚多少”。

---

## 8. 双语与本地化

- 默认中文；英文同步发布，数字与时间统一 UTC。
- 金额用 A9 与 raw 对照（必要时）；价格用 USD，并说明 P0 与 target 的档位关系。
- 时间写法：YYYY-MM-DD HH:mm UTC；避免本地时区歧义。
- 英文避免机翻痕迹；关键术语统一：staking window、observation window、qualified candles、tier、claim、technical abort。

---

## 9. 存档与复盘

- 每条公告存档：ops/records/ann-<round>-<type>.md（含渲染时间、审批人、渠道链接）。
- 公告与链上事件的交易哈希、轮次 ID 关联。
- 每轮结束后复盘沟通效果：触达、误解点、客服问题；更新 FAQ 与模板。
- 事故公告纳入 incident-log.csv 与复盘。

---

*本手册与 templates/announcements.json、announcement.mjs 同步；修改模板时同步更新本文档与 selftest。*
