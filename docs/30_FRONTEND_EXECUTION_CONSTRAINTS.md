# 30 — 前端改造执行约束（给前端窗口）

> 出具方：Lead　适用范围：`docs/29_FRONTEND_BATTLEFIELD_PLAN.md`（下称「战场化方案」）的执行
> **文档编号**：仓库已有 `docs/29_MAINNET_CUTOVER.md`，本方案请改用 **`docs/30_FRONTEND_BATTLEFIELD_PLAN.md`**，避免两个 29。
> 基线：合约 `v8.8-audit-fixed`，前端当前 `main`（含 v8.7/v8.8 ABI 同步、退款面板、TON→GRAM 文案）

## 1. 分阶段：什么现在做，什么必须等

### ✅ 现在可做（不碰链上交互逻辑）

| 阶段 | 内容 | 风险 |
| --- | --- | --- |
| P1-a 品牌统一 | `SiteHeader.tsx:19-20` 的旧折线图标（`#FF5B1F` / `#FFB63D`）换成 A9 三角；`fuse.css:8` 令牌加入品牌橙 `#FF4D00`；`--fire` 对齐 | 纯 CSS/SVG |
| P1-b 信任修复 | 生产禁用演示钱包（`DEMO_A9_BALANCE_RAW = 250000000000000`，假余额 250,000 A9）；连接失败不得降级为假钱包；生产移除「原型 · 模拟数据」徽标 | 配置/分支判断 |
| P2 首屏 | 桌面「舞台 + 操作坞」；移动端单操作条；规则/风险披露拆到 `/rules` | 布局 |
| 实时 A 步 | 时钟下沉（去掉整页每秒重渲染）、统一数据层、**隐藏标签页停止轮询**（注释声称已实现，实际没有） | 前端 |
| 文案修正 | 见 §3 第 6 条 | — |

### ⛔ 必须等主网部署之后

| 项 | 原因 |
| --- | --- |
| `BattleService` 抽象 + demo/chain 双实现 | 会对 `web/src/features/chain/` 做重构，而那 5 个文件刚与 v8.8 合约逐字节对拍验证过，重构会作废验证 |
| SSE / WebSocket（B 步） | 需后端配合 |
| 任何 claim / stake / refund 流程改造 | 同上 |

## 2. 硬约束（可直接 grep 验证）

```bash
# ① 领取消息值必须是 0.2 TON —— v8.8 合约要求 valueCoins >= 0.15
grep -n 'DEFAULT_CLAIM_MESSAGE_TON_NANO' web/src/features/chain/protocol.ts
# 期望：export const DEFAULT_CLAIM_MESSAGE_TON_NANO = 200_000_000n;

# ② FIX-5 回执加固三件套必须还在
grep -c 'matchesUserAction\|exitCodeError\|aborted' web/src/features/chain/useChainTx.ts
# 期望：>= 3

# ③ 退款领取必须还在
grep -n 'submitClaimRefund\|REFUND_ROUND_ID' web/src/features/chain/useChainTx.ts web/src/features/chain/protocol.ts

# ④ 退款账本「读不到」不得显示为 0
grep -n 'fetchRefundLedger\|parseRefundLedgerStack' web/src/features/chain/rpc.ts

# ⑤ 新 ABI 常量必须还在
grep -n 'RESET_ROUND_CANDLES' web/src/features/chain/protocol.ts
grep -n '0x52540109\|0x5254010D' web/src/features/chain/protocol.ts
```

**⑤ 之后全部必须为真；任何一条不成立 → 不要提交。**

### 禁止修改的文件（只允许改字符串，不允许改逻辑）

```
web/src/features/chain/protocol.ts      （opcode / 消息值常量）
web/src/features/chain/transactions.ts  （交易构造）
web/src/features/chain/rpc.ts           （链上读取）
web/src/features/chain/useChainTx.ts    （回执判定）
web/src/features/chain/payload.ts       （cell 构造）
```

## 3. 七个决策问题的答复（项目口径）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 暖黑 vs 中性黑 | **暖黑**。品牌橙 `#FF4D00` 配中性黑会显脏 |
| 2 | 涨跌色 | **绿涨红跌**（加密惯例）。跌色 `#E5484D` 可用，但**必须做色盲模拟验证**（deuteranopia 下与品牌橙易混） |
| 3 | 首屏 | **战场优先**，Hero 叙事宜**下移而非删除**（新用户需要知道这是什么） |
| 4 | 生产演示钱包 / 买入入口 | **必须关闭**。demo 只在 dev 出现，不接受妥协 |
| 5 | 实时 A/B 步 | **A 步现在做，B 步排主网后** |
| 6 | 「逐轮翻倍」与时间口径 | **以 `docs/00` V7 为准**：`target = max(P0×2^tier, 2×开窗24h TWAP)`；**tier = 1 + 已成功轮数，失败同档重试不升档**；12h 预告 / 36h 报名 / 24h 观察（24 根 ×1h，阈值 16）。**「逐轮翻倍」是错误文案，必须改**——它暗示 10 轮必然升到 1024×，实际失败不升档 |
| 7 | 合规复核时点 | D-34 已决定不做法律意见；但**文案红线**（不承诺收益、不诱导、风险披露可见）须在文案定稿前过一遍 |

## 4. 合并顺序（重要）

当前有两个前端分支在飞：
```
frontend-ux（PR #1，f208721）        ← 另一个窗口的 UX 优化
战场化改造（本方案）                  ← 新工作
```
两者都会改 `web/src/features/chain/i18n.ts`、`chain.css`、`MePage.tsx`。

**规定顺序**：
1. 先合 PR #1（已 review，改动收敛）
2. 战场化改造 rebase 到合并后的 main
3. 冲突原则：`features/chain/` 的**合约交互逻辑以 main 为准**；页面结构/视觉/文案以改造分支为准

## 5. 交付前必跑

```bash
cd web && ./node_modules/.bin/tsc --noEmit     # 0 error
cd /Users/yu1/Desktop/BAM && npm run build      # 成功
# 领取回执单测（queryId 不匹配不得当本次；aborted → failed 带 exit_code）
```

## 6. 发布节奏

**前端部署与合约部署解耦**：合约上主网不要求前端同步上线（前端可先用当前版本指向新地址）。**不要为了赶合约部署把前端改造压在一起。**