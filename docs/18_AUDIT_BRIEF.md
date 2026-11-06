# 18 — 外部审计包（Audit Brief）

**版本**：V8.6 · 2026-11-06（合约冻结；tag `v8.6-audit-fixed` @ `c24809a`）
**状态**：代码冻结后提交审计
**适用对象**：第三方安全审计机构 / 外部审计模型
**仓库**：BAM（A9 Protocol）

---

## 0. 一句话背景

A9 是一个 TON 链上的价格对赌协议：**用户押本金，赌 72 小时内价格至少翻倍；赢了拿本轮 7 亿 A9 奖励，输了本金 100% 销毁。** 共 10 轮。

本次审计对象是**自研的 5 个 Tolk 合约**：RoundController、TeamVault、OracleAdapter、JettonMaster、JettonWallet（Jetton 为 Tolk 复刻，非官方原样复用）。

---

## 1. 审计范围

| 合约 | 源码 | 行数（v8.1 记录） | 职责 | 部署实例 |
| --- | --- | --- | --- | --- |
| **RoundController** | `contracts/contracts/RoundController.tolk` | 1,744 | 轮次状态机、质押托管、K 线计数、结算（三笔销毁）、奖励三态、邀请权重、线性解锁、技术终止 | 1 |
| **TeamVault** | `contracts/contracts/TeamVault.tolk` | 211 | 团队 12 亿托管，只接受 RC 指令，按轮释放/销毁，幂等互斥 | 1 |
| **OracleAdapter** | `contracts/contracts/OracleAdapter.tolk` | — | 3/5 多源验签；向 RC 转发 OpenRound/CloseStaking/SubmitCandle；防重放 | 1 |
| **JettonMaster** | `contracts/contracts/jetton/JettonMaster.tolk` | 245 | TEP-74 主合约，mint-once 后 admin 置空 | 1 |
| **JettonWallet** | `contracts/contracts/jetton/JettonWallet.tolk` | 179 | TEP-74 钱包，transfer/burn/internal_transfer | ~13 + 每用户 1 |

**共享代码**：`contracts/contracts/types.tolk`（数据结构）、`constants.tolk`（opcode/错误码）、`jetton.tolk`（TEP-74 报文构造）。

> 行数为 v8.1 记录；v8.2~v8.6 修复后行数以源码为准（C-1~C-4 与 OracleAdapter 修复）。

**不在范围**：worker（Cloudflare Worker）、web（React 前端）、ops（运维脚本）——另行审计。

---

## 2. 交付物清单

| 文件 | 用途 |
| --- | --- |
| `docs/17_REWARD_V2.md` | V8 奖励机制完整规格（权重公式、三态状态机、storage、opcode、测试清单） |
| `docs/00_DECISIONS_V2.md` | 全部已确认决策（D-01~D-35），判断「是不是 bug」的基准 |
| `docs/16_REWARD_EXAMPLES.md` | 奖励分配与收益示例 |
| `contracts/README.md` | ABI 表、storage 布局、错误码、gas 实测、**§9 已知问题与修复记录** |
| `contracts/deploy/abi/*.json` | 机器可读 ABI |
| `contracts/deploy/params.testnet.json` | 部署参数（P0、2×、24/16、12h+36h+24h、限额、技术终止） |
| `contracts/tests/*.test.tolk` | **154 个测试（15 个文件）**（v8.6 冻结基线） |

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

> v8.6 新修复的 C-1~C-4 见 **§14**；§4 表格中的 P0-1~P0-3 为 v8.1 首轮修复，勿重复报告。

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
acton test                   # 期望 154 passed / 15 files
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

**tag**：`v8.6-audit-fixed`　**commit**：`c24809a`（HEAD）\
**验证基线**：`acton build --clear-cache` OK / `acton check` **0 error 0 warning** / `acton test` **154 passed / 15 files** / `acton script scripts/deploy-emulation.tolk` OK（全新空链一键完整部署）。

| 合约 | Code hash（v8.6 冻结） |
| --- | --- |
| RoundController | 0xC5AD291469C3BEADBDC26A6F1733004D433F12B15B025D88B983DF098BA11500 |
| TeamVault | 0xCF3E6C7C9DC045F392F35E79E20AA6EDAAF9064D538CA4E78B6D1FE1443158B4 |
| OracleAdapter | 0x539F3597357943584A596DA2B40F901B4984D8C8307E63CE81A67F131EAB8CBA |
| JettonMaster | 0x876F21A1A516FB0449A1D0AF5DBECEB8639373F947949C5AE8E1E9DBB769D64F |
| JettonWallet | 0x394E4E8D40B5D3D97D12AA950B99EA9A53387DDAC331BAAAC8923F0E6E6849A4 |

> **hash 变更说明**：`c38b05a` 将 C-2 断言的错误码从共享的 `CandleIndexOutOfRange` 改为 Adapter 自己的 `BadCandleOrder`，**OracleAdapter 的 code hash 因此变化**；上一版发给审计方的 OracleAdapter hash 作废，以本表为准。

**历史基线（v8.1，superseded，仅作对照）**：

| 合约 | Code hash |
| --- | --- |
| RoundController | 0x7120E5FE1966B9C8B3DFF092D45441B6F896EF5041D36416BC5CD5B4C6893ED1 |
| TeamVault | 0x14BA576796DF2489A17E00F5CC4FDFE1FD9DB11A3F692DB0F4A0CB5FA8F4EA41 |
| JettonMaster | 0xDB3C43B4F1AF474416C2A27502479230B8A316A7A57F7D018452B12B25EB778B |
| JettonWallet | 0x5840B389222182AA1D2C0C1CB2A275DB03C90D4197D5F15540EB128E615DA4CF |

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

---

## 11. 架构评审修复记录（v8.3，架构评审后）

架构评审（业务完整性 + 架构合理性）提出 2 项主网阻断 + 3 项建议 + 5 项不建议改。已修：

| 编号 | 严重度 | 问题 | 修复 |
| --- | --- | --- | --- |
| M-1 | 主网阻断 | PREVIEW / STAKING_OPEN 无超时逃生舱 → 管理员失联即永久死锁，且永远到不了 R10 写 unlockStart | CloseStaking 自然到期放开为无权限；AbortTechnical 增加 PREVIEW/STAKING_OPEN 超时分支；current 已终态时可推进到超时的下一轮 PREVIEW 并终止 |
| S-3 | P1 | TeamVault ReleaseTeamQuota 发 transfer 即置 released + ack，bounce 无回滚 → 团队额度永久滞留 | 改 pending 语义：等 ReturnExcessesBack（kind=RELEASE）确认后再 ack；bounce 清 pending 可重试 |

未修（按评审建议）：S-1 补 5 个 external-out 事件（索引器改用解析入站交易）、S-2 多签地址（部署配置层面）、N-1~N-5 全部不动。

主网前仍待补：**M-2 OracleAdapter**（3/5 多源验签，向 RC 转发 OpenRound/CloseStaking/SubmitCandle，RC 零修改）。

---

## 12. 第四轮修复记录（v8.4，P0 真实链路缺陷）

第三轮 delta 复审发现一个 100% 必现的 P0：真实 TEP-74 下 `ReturnExcessesBack` 由**接收方钱包**发出，而 RC/TV 校验的是自己的钱包地址，导致所有领取与团队释放确认必然失败。根因是测试用 MockJettonWallet（单跳）掩盖了真实两跳行为。

| 编号 | 严重度 | 问题 | 修复 |
| --- | --- | --- | --- |
| P0-1 | 主网阻断 | ReturnExcessesBack 发送方校验错误 → 用户 pendingQueryId 永不清零、首轮成功即卡 SETTLING_SUCCESS | RC 新增 `SetJettonWalletCode(0x5254001B)` 存钱包 code，按 pending.owner 推导接收方钱包校验；TV 新增 `SetTeamWalletJettonWallet(0x5254001C)` |
| P1-1 | 高 | transfer 只带 0.05 TON + JettonWallet excesses 用 IGNORE_ERRORS | 0.05→0.1；改 BOUNCE_ON_ACTION_FAIL；calcMinimalTransferAmount 计入回传费 |
| P1-2 | 高 | RetryPendingActions 仅 admin → M-1 在 SETTLING_* 阶段闭不了环 | 放开为无权限 + valueCoins ≥ 0.3 |
| P2-1 | 中 | Pause/Resume 无次数上限，可无限重置超时 | RoundData.pauseCount，每轮最多 1 次 |
| P2-2 | 中 | TV BurnTeamQuota 未检查 pending release | 抛 TeamRoundConflict |

**关键交付：真实 JettonMaster + JettonWallet 集成测试（3 条）已建立**，覆盖成功轮释放确认、失败轮三笔销毁确认、R10 后 ClaimUnlocked 真实返回。测试总数 130。

---

## 13. v8.5：部署可验证性补强

第四轮修复后，ops 在对接时发现两个缺口（均已补）：

| 项 | 问题 | 修复 |
| --- | --- | --- |
| getter 缺失 | `SetJettonWalletCode` / `SetTeamWalletJettonWallet` 只写了 storage，没有只读接口 → verify_deployment 无法确认链上配置 | 新增 `get_jetton_wallet_code_hash(): uint256`（RC）与 `get_team_wallet_jetton_wallet(): address`（TV），**纯只读、零业务逻辑改动** |
| stepwise 部署 | `admin_op.tolk` 没有两个 wiring op → 65 stepwise 广播会 unknown op | 不补 admin_op；测试网固定走「整体 deploy-emulation（内置 wiring）→ 65 --query-only → 70 --mark-bound-only」，stepwise 在 ops 层 BLOCKED |

测试：132 passed / 13 文件（含 3 条真 Jetton 合约集成测试）。**注**：v8.6 后为 154 passed / 15 文件，见 §14。


---

## 14. v8.6：审计修复批（C-1~C-4，合约冻结）

**背景**：v8.5 外部 delta 复审 + Lead 独立复核提出 4 个缺陷（C-1~C-4），全部修复后打 tag `v8.6-audit-fixed`（commit `c24809a`）。验证：`acton check` 0 error 0 warning，`acton test` **154 passed / 15 files**。

### C-1 滚存必须在合约内校验报名截止时间（原审查：同事审查报告第 1 项）

- **缺陷**：`RollReward` 只校验下一轮状态为 PREVIEW / STAKING_OPEN，**未校验 STAKING_OPEN 轮的 `stakeCloseAt`**。若 keeper 未及时 `CloseStaking`，过期轮仍会接受奖励滚存。
- **影响**：奖励被滚进一个已过期、不再接受质押的轮次，状态与资金归属错误；仅靠 keeper 及时关窗不可靠。
- **修复**：进入 `STAKING_OPEN` 分支时增加合约内断言 `now < nextRd.stakeCloseAt`，否则抛 `RollNotAvailable`。
- **测试**：`C-1 roll into an expired open round is rejected`（`contracts/tests/rewards-v8.test.tolk`）。
- **链上实测证据**：旧合约 **v8.5** 在 testnet-ops 实测「关窗后发 RollReward」返回 `accepted:true`，记录于 `ops/records/fasttest-runner-2026-11-05T16-17-19-990Z.jsonl` 的 `defect-roll-after-close` 事件（roundId=2）；**新实例上同一测试必须 `accepted:false`**。C-1 不是代码推断，**已在链上复现**。

### C-2 OracleAdapter 首根 K 线（index 0）与 index 越界（原审查：同事审查报告第 2 项）

- **缺陷**：Adapter 用「上一根 index + 1」做单调校验、以 0 表示未记录 → **index 0 被误判为重复/未开始**，首根 K 线无法转发；同时 `candleIndex+1` 在 uint8 上对 255 回绕为 0。
- **影响**：轮次永远无法记录第一根 K 线 → 观察期卡死；越界 index 可绕过去重。
- **修复**：改为存 `index+1`（0 = 无记录），index 0 合法；转发前拒绝 `index >= 32`（在 uint8 自增前），错误码使用 Adapter 自己的 `BadCandleOrder`（`c38b05a`）。
- **测试**：`C-2 candle index 0 is accepted then monotonic`、`C-2 real RC accepts adapter candle sequence from index 0`、`C-2 candle index 255 is rejected before uint8 wrap`（`contracts/tests/oracle-adapter.test.tolk`）。

### C-3 转发失败时的重放标记回滚（原审查：同事审查报告第 3 项）

- **缺陷**：Adapter 在向 RC 转发动作**之前**写入 replay 标记；若 RC 拒绝（bounce/错误），标记未回滚 → 合法重试被当成重放拒绝，动作永久卡住。
- **影响**：OpenRound / CloseStaking / SubmitCandle 一旦被 RC 拒绝一次，就再也无法重试（可用性/轮次推进受阻）。
- **修复**：按 `forwardedQueryId = roundId<<16 | action<<8 | candleIndex` 记录；收到转发动作的 bounce 时**精确回滚对应标记**，允许重试。
- **测试**：`C-3 rejected CloseStaking rolls back and resubmits successfully`、`C-3 rejected candle rolls back lastCandle and resubmits`（`contracts/tests/oracle-adapter.test.tolk`）。

### C-4 两跳 bounce 通知 + IGNORE_ERRORS 兜底（原审查：Lead 独立确认第 11 项）

- **缺陷**：真实 TEP-74 下，转账第二跳（收款方钱包）bounce 只回到**发起方钱包**，不会通知原始 owner；RC/TV 的 pending 领取/释放确认因此永不回滚，资金状态悬挂。
- **影响**：领取/团队释放失败后 pending 不清，用户资产与服务状态卡死（与 P0-3 同类的真实两跳缺口）。
- **修复**：JettonWallet 检测到第二跳 bounce 后，向 owner 发送 `TransferBounced` 通知（新增 opcode）；RC/TV 收到后回滚 pending 状态（claim/release）；若 owner 通知本身因 TON 不足发不出，**钱包侧仍必须完成 Jetton 余额回滚**（`d90c57f` 的兜底），不能因通知失败丢钱。
- **测试**：`C-4 RC accepts wallet TransferBounced and rolls back the pending claim`、`C-4 TV accepts wallet TransferBounced and clears the pending release`、`C-4 real JettonWallet notifies owner after a second-hop bounce`、`C-4 low-TON wallet keeps jetton rollback when owner notice fails`（`contracts/tests/c4.test.tolk`）。

### 修复批结论

| 编号 | 严重度 | 修复 | 测试 | 原审查出处 |
| --- | --- | --- | --- | --- |
| C-1 | P1（链上已复现） | 滚存校验 `now < stakeCloseAt` | 1 条 | 同事审查报告第 1 项 |
| C-2 | P1 | index 0 合法 + `index>=32` 拒绝 + `BadCandleOrder` | 3 条 | 同事审查报告第 2 项 |
| C-3 | P1 | 转发 bounce 回滚 replay 标记 | 2 条 | 同事审查报告第 3 项 |
| C-4 | P1 | 两跳 bounce 通知 owner + 余额回滚兜底 | 4 条 | Lead 独立确认第 11 项 |

> **运维要点（部署）**：`deploy-emulation.tolk` 现支持**全新空链一条命令完整部署**（JettonMaster → mint 100 亿并永久关闭 → OracleAdapter / TeamVault / RoundController → 全套 wiring → RC 7e18 / TV 1.2e18 raw A9 注入 + 回读校验）。
> **JettonWallet 代码变更会导致所有 jetton wallet 地址变化，必须干净重部署，不能 resume。**


---

## 15. R10 线性解锁的链上验收（ClaimUnlocked）

> 面向审计方与验收方。本节不是缺陷记录。

### 15.1 机制

`UNLOCK_DURATION_SECONDS = 31,104,000`（12 × 30 天）为**编译期常量**，按 `elapsed / UNLOCK_DURATION_SECONDS` 线性释放。

因此 R10 终态后**立即**调用 `ClaimUnlocked` 会返回 `NothingUnlocked`（t≈0 时 `vested = totalLocked × 0 / 31104000 = 0`）——**这是预期行为，不是缺陷**。

### 15.2 链上已验证（比预期更完整）

测试网 v8.6 实例在 R10 结算后约数小时做了**两次** `ClaimUnlocked`：

| 次数 | 用户 A 钱包余额变化 | 增量 |
| --- | --- | --- |
| 第一次 | `139,062,093,023,255,813` → `139,413,655,214,080,358` | **+351,562 A9** |
| 第二次（15s 后） | → `139,414,329,307,505,178` | **+674 A9** |

→ **多次部分领取成立、每次金额为增量、`claimedRaw` 累加**。这条同时作为审查报告第 10 项（演示账本解锁只能领一次）的链上对照。

### 15.3 验收口径（给审计方）

- ✅ 可链上验收：`get_unlock_info(owner).unlockStart > 0`；`totalLockedRaw` 与未领奖励一致；**未 vest 时立即领取被正确拒绝**；**过一段时间后可领取、且支持多次部分领取、金额递增**。
- ⚠️ 无法在快测压缩的只是「完整 12 个月曲线」的形状，由时间跳跃单测覆盖：`contracts/tests/rewards-v8.test.tolk:405-431`。
- ❌ **不要**把「R10 后立即 `ClaimUnlocked` 返回 `NothingUnlocked`」判为缺陷。

### 15.4 worker 配套（demo 模式）

`claims(kind='unlock')` 为**累加式 UPSERT**（先 SELECT 旧值 → BigInt 相加 → 写回；**不用 SQL 加法**，因为 A9 总供应 1e19 超过 SQLite INTEGER 的 2^63）。支持多次部分领取，每次返回增量 `amountRaw`，`claimed_raw` 累加。worker 侧实证：t1/t2 两次部分领取都成功，各 `87,280,222,426,001,063`，DB 累计 `174,560,444,852,002,126` 与 `/api/stats.unlock.claimedRaw` 一致。
