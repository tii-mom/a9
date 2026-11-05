# 18 — 外部审计包（Audit Brief）

**版本**：V8.1 · 2026-11-05（代码已冻结）
**状态**：代码冻结后提交审计
**适用对象**：第三方安全审计机构 / 外部审计模型
**仓库**：BAM（A9 Protocol）

---

## 0. 一句话背景

A9 是一个 TON 链上的价格对赌协议：**用户押本金，赌 72 小时内价格至少翻倍；赢了拿本轮 7 亿 A9 奖励，输了本金 100% 销毁。** 共 10 轮。

本次审计对象是**自研的 4 个 Tolk 合约**（Jetton 也是我们复刻，非官方复用）。

---

## 1. 审计范围

| 合约 | 源码 | 行数 | 职责 | 部署实例 |
| --- | --- | --- | --- | --- |
| **RoundController** | `contracts/contracts/RoundController.tolk` | 1,744 | 轮次状态机、质押托管、K 线计数、结算（三笔销毁）、奖励三态、邀请权重、线性解锁、技术终止 | 1 |
| **TeamVault** | `contracts/contracts/TeamVault.tolk` | 211 | 团队 12 亿托管，只接受 RC 指令，按轮释放/销毁，幂等互斥 | 1 |
| **JettonMaster** | `contracts/contracts/jetton/JettonMaster.tolk` | 245 | TEP-74 主合约，mint-once 后 admin 置空 | 1 |
| **JettonWallet** | `contracts/contracts/jetton/JettonWallet.tolk` | 179 | TEP-74 钱包，transfer/burn/internal_transfer | ~13 + 每用户 1 |

**共享代码**：`contracts/contracts/types.tolk`（数据结构）、`constants.tolk`（opcode/错误码）、`jetton.tolk`（TEP-74 报文构造）。

**不在范围**：worker（Cloudflare Worker）、web（React 前端）、ops（运维脚本）——另行审计。

---

## 2. 交付物清单

| 文件 | 用途 |
| --- | --- |
| `docs/17_REWARD_V2.md` | V8 奖励机制完整规格（权重公式、三态状态机、storage、opcode、测试清单） |
| `docs/00_DECISIONS_V2.md` | 全部已确认决策（D-01~D-34），判断「是不是 bug」的基准 |
| `docs/16_REWARD_EXAMPLES.md` | 奖励分配与收益示例 |
| `contracts/README.md` | ABI 表、storage 布局、错误码、gas 实测、**§9 已知问题与修复记录** |
| `contracts/deploy/abi/*.json` | 机器可读 ABI |
| `contracts/deploy/params.testnet.json` | 部署参数（P0、2×、24/16、12h+36h+24h、限额、技术终止） |
| `contracts/tests/*.test.tolk` | 114 个测试（9 个文件） |

---

## 3. 重点审计清单（按优先级）

### P0 — 资金安全（必须逐行）

| # | 审计点 | 位置 | 关注什么 |
| --- | --- | --- | --- |
| 1 | **三笔销毁的金额与顺序** | `handleFinalizeRound / settleRound` | 失败轮必须销毁 reward + team + 全部本金；不得重复或遗漏；确认路径幂等 |
| 2 | **奖励分配数学** | `rewardForRound / handleRollReward` | `reward = floor(700M × (ownWeight+bonus) / totalWeight)`；**Σreward ≤ 700M**（floor 余数留金库）；权重不得溢出 uint128 |
| 3 | **领取回滚（bounce）** | `onBouncedMessage` / pending claim | bounce 后必须完整回滚 principalClaimed / rewardClaimed / rewardState / lockedBonus / unlockClaimed / ClaimAll 双 mask；queryId 全局唯一可反查 |
| 4 | **销毁确认权威** | `handleReturnExcesses` | 只接受 sender == jettonMaster；queryId 解码的 roundId/kind 必须校验；伪造消息不得置 flag |
| 5 | **权限矩阵** | 全部 requireAdmin / requireAdminOrOracle | SubmitCandle / CloseStaking 必须 admin/oracle；StartObservation / AbortTechnical 任何人可调（设计意图）；SetJettonWallet 只能在 currentRoundId == 0 时调用 |
| 6 | **滚存上限与截断** | `handleRollReward` | 单地址 2000 万 / 单轮总 2 亿；超出部分转 PENDING 不丢失；滚存后下一轮失败 → 随本金 100% 销毁 |
| 7 | **解锁曲线** | `handleClaimUnlocked` / unlock pool | 12×30 天线性；R10 前拒绝；早领罚没的 50% 进池；不得重复发放 |

### P1 — 状态机正确性

| # | 审计点 | 关注什么 |
| --- | --- | --- |
| 8 | 状态迁移完整性 | 每对 (from, to) 是否合法；终态不可逆；并发消息下 CAS 是否成立 |
| 9 | K 线滚动哈希 | 顺序提交（index == candlesSeen）、periodStart 严格匹配、重复提交被拒、qualified 边界（16/24） |
| 10 | 技术终止 | 暂停 14 天 / 观察超时 7 天；退 100% 本金；不销毁奖励/团队；不消耗档位；任何人可触发 |
| 11 | 团队额度 | TeamVault 只认 RC；同轮释放/销毁互斥且幂等；burn bounce 不回 ack |
| 12 | 0 人质押分支 | 照常进观察；通过则奖励销毁（D-18b）；失败无本金可销毁 |

### P2 — Jetton 合规性

| # | 审计点 | 关注什么 |
| --- | --- | --- |
| 13 | TEP-74 语义 | transfer / internal_transfer / burn / burn_notification 字段与错误码是否与标准一致 |
| 14 | forward_payload 透传 | 136-bit StakePayload 在 transfer → internal_transfer → transfer_notification 全程不被改写 |
| 15 | mint-once | 只能铸 1e19；同一笔交易 admin 置空；二次 mint 报 MintClosed |
| 16 | canonical wallet 校验 | burn_notification 的 sender 必须是 get_wallet_address(burnInitiator) |

---

## 4. 已知问题与已修复记录（**请勿重复报告**）

> 完整列表见 `contracts/README.md §9`。以下是 2026-11-05 外部初审后已修复的三条 P0：

| 编号 | 问题 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| P0-1 | CloseStaking / SubmitCandle 缺权限 | 任何人可伪造 TWAP 决定本轮成败 | 两者 requireAdminOrOracle；非授权抛 NotOracle 且不写状态 |
| P0-2 | BurnAck 权威不存在 | RC 等 jettonMaster 发 BurnAck，实际只发 ReturnExcessesBack → 失败轮永久卡 SETTLING_FAILURE | burn 的 response_destination = RC；新增 0xd53276db handler 复用确认逻辑 |
| P0-3 | 领取先落盘 + NoBounce | 转账失败不 bounce、无回滚 → 资产永久丢失 | 转账 bounceable + pending claim + bounce 完整回滚 |

### 已知且**已接受**的风险（不属于「发现」，但仍可报告）

| 风险 | 决策 | 说明 |
| --- | --- | --- |
| 单密钥 admin、无多签 | D-23 / D-21 已接受 | 管理员为 RC 单密钥 owner；营销/流动性/团队为个人热钱包，地址不公开 |
| RC 不可升级 | D-24 | 部署后无法修改逻辑；发现 bug 只能重新部署 |
| 主网无预言机 | D-04 | 测试网用手动 K 线提交（admin/oracle 权限）；主网前需接 OracleAdapter |
| 2× 目标通过率极低 | D-31 | 已知经济风险，项目方接受；数据见 docs/13 |
| 团队 burn 的 TV 侧信任边界 | 已知 | TV 在 jettonMaster 确认后才 ack；退款路径 bounce 无 pending（异常路径，admin 重发） |

---

## 5. 基线验证方式

审计开始前请先跑通基线：

```bash
cd contracts
acton build --clear-cache    # 期望 0 error
acton check                  # 期望 0 warning
acton test                   # 期望 114 passed
acton script scripts/deploy-emulation.tolk   # 期望 OK
```

工具链：**Acton 1.1.0 / Tolk 1.4.1**（`contracts/Acton.toml` 已锁定）。Code hash 以 `contracts/README.md` 顶部记录为准。

---

## 6. 报告格式要求

每条发现请包含：

1. **编号 + 严重程度**（P0 资金损失 / P1 服务中断或状态错误 / P2 代码质量 / P3 建议）
2. **位置**：文件 + 函数名 + 行号
3. **问题描述**：具体到「哪个输入会触发什么错误状态」
4. **影响**：资金 / 状态 / 可用性
5. **复现路径**：最好能给一条可直接写进 *.test.tolk 的测试思路
6. **修复建议**：最小改动优先

**不接受**：没有具体位置的泛泛而谈（「建议加更多测试」）、与本协议形态无关的通用清单项（登录/MFA/多租户/SaaS 计费等本产品不存在的东西）。

---

## 7. 审计验收标准

- 覆盖 §3 的 16 个审计点，逐点给出「通过 / 有问题 / 不适用」的明确结论
- 所有 P0/P1 发现必须能对应到具体代码行
- 对「结算数学」给出独立复算（不接受「看起来正确」）
- 最终给出：**可上线 / 修复后可上线 / 不可上线** 的明确判断

---

## 8. 冻结版本基线（审计必须基于此）

| 合约 | 行数 | Code hash |
| --- | --- | --- |
| RoundController | 1,853 | 0x38DFE37D3F2A33D74141FA1D5267274BEDB402209D7A79B41EA76A8AF44CD127 |
| TeamVault | 271 | 0x41AD560CF1B6F61935B492727B6354CE409291340CB7E7962D09BAA519E90212 |
| JettonMaster | 245 | 0x657C029A1BAB71815BC0AB3CF0E1958BFEFCFFAF644B307394E7A696550886E2 |
| JettonWallet | 179 | 0x3E3D595A8BB95AB108340B7CB50E99135D5FBA9E1118F7B0F1B4CF0EB5066A96 |

验证基线：`acton build --clear-cache` 0 error / `acton check` 0 error 0 warning / `acton test` **114 passed** / `acton script scripts/deploy-emulation.tolk` OK。

若审计方的 hash 与上表不一致，说明代码已被改动，请先与项目方确认版本。

---

## 9. Jetton 的来源与审计方法（重要）

JettonMaster / JettonWallet **不是从零自研**，而是 **Acton 官方 jetton 模板的 Tolk 移植**：

- `contracts/contracts/jetton/` 下的 `messages / storage / errors / jetton-utils / fees-management / sharding` 六个文件是 Acton 官方 jetton 模板的原样文件；
- `JettonMaster.tolk` 顶部即注明：`Reuses the audited-shape TEP-74 reference logic shipped with Acton's official "jetton" template`；
- 我们只加了两处 A9 特有逻辑：**mint-once**（只能铸 1e19，同一笔交易把 admin 置空）、**钱包 code 内嵌**（`@gen/JettonWallet.code`）。

### 审计要求：审 delta，不重审 TEP-74 主体

请做一份 **与官方 FunC 参考实现（ton-blockchain/jetton-contract）的逐函数对照表**，只对以下 delta 逐行审查：

| Delta | 位置 | 必须回答的问题 |
| --- | --- | --- |
| mint-once 策略 | `JettonMaster.handleMint` | 是否只能铸一次？金额是否严格 1e19？admin 是否在同一笔交易内置空？二次 mint 是否必然失败？ |
| admin 置空后的权限 | `JettonMaster` 全部 admin 分支 | admin=null 后，change_admin / change_content / mint 是否全部被拒？ |
| 钱包 code 内嵌 | `@gen/JettonWallet.code` | 内嵌的 wallet code 与实际部署的 wallet code 是否一致（地址推导是否自洽）？ |
| forward_payload 透传 | `JettonWallet` transfer → internal_transfer → transfer_notification | 136-bit StakePayload 是否全程逐位不变？forward_ton_amount 是否正确透传？ |
| burn_notification | `JettonWallet` → `JettonMaster` | op 是否标准 `0x7bdd97de`？sender 是否校验为 canonical wallet？`send_excesses_to` 是否透传（P0-2 的确认信号依赖它）？ |
| 错误码 | `jetton/errors.tolk` | 是否与 TEP-74 标准一致（47/48/49/72/73/74/333）+ A9 补充（75/76/77）？ |

**如果某一处与官方参考实现存在非预期差异，请明确指出差异点与风险**；如果只是命名/格式化差异，请说明「语义等价」。

TEP-74 的主体逻辑（transfer 的 gas 计算、sharding 前缀、fee 管理）**不需要逐行重审**，只需确认「与官方实现一致」。

---

## 10. 审计修复记录（v8.2，首轮审计后）

首轮外部审计（v8.1）共 9 条发现：1×P0 + 5×P1 + 3×P2，**已全部修复**，修复后 114 个测试全绿。

| 编号 | 严重度 | 问题 | 修复 |
| --- | --- | --- | --- |
| F-01 | P0 | ClaimUnlocked 回滚用绝对快照 → 解锁池可翻倍双花 | 改相对扣减 + per-owner pending 互斥（ClaimPending） |
| F-02 | P1 | RetryPendingActions 的 reward burn 用 msg.queryId + admin | 改 burnQueryId(roundId, REWARD) + RC 自身 |
| F-03 | P1 | RC burn 无 dispatched 标记 → retry 双倍销毁 | 加 rewardBurnDispatched/principalBurnDispatched + onBouncedMessage 处理 OP_JETTON_BURN |
| F-04 | P1 | sendJettonBurn 0.05 TON + IGNORE_ERRORS → 确认被静默丢弃 | value 0.1 TON；excesses 改 BOUNCE_ON_ACTION_FAIL；calcMinimalBurnAmount 计入回传费 |
| F-05 | P1 | RollReward 在 rollAmount==0 时仍置 ROLLED | assert rollAmount > 0 throw RollNotAvailable |
| F-06 | P1 | 邀请人后加仓/滚存不补 bonus | deposit/roll 两条路径 O(1) 差额补齐 |
| F-07 | P2 | get_reward_state 领取后返回 0；除法写法不一致 | SUCCEEDED 即返回全额；统一为 amount × BPS / 10000 |
| F-08 | P2 | ClaimAll 早领不发 RewardEarly 事件 | 补发事件 |
| F-09 | P2 | SetReferrer / SetJettonWallet 未校验空地址 | 三处加 createAddressNone() 校验 |

新增测试文件 `contracts/tests/audit-fixes.test.tolk`（17 条），覆盖上述全部修复点与复现路径。
