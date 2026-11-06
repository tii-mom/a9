# A9 Protocol — 自研合约（RoundController + TeamVault）

**版本**：V8.9 冻结基线（2026-11-06；M4.2 round-0 退款账本 bounce 回滚修复；tag `v8.9-audit-fixed`；时间线 V7：24h/24 根 1h/16 阈值 + 12h+36h+24h）
**范围**：A9 协议自研 TON 合约（RoundController + TeamVault）+ A9 Jetton Master/Wallet（Tolk 复刻 TEP-74/89，含 mint-once 改造）及其测试/部署模板。
**权威口径**：docs/00_DECISIONS_V2.md（当前版本，时间线 V6.2）> docs/04_CONTRACT_ABI.md > 本 README。本 README 记录实现细节、ABI、部署模板与**与文档的差异/工程裁决**。

---

## 0. 一句话结论

- **工具链**：Acton 1.1.0 + Tolk（本机已安装；acton build / acton test / acton script 均可用）。
- **编译**：acton build 通过，0 error；acton check 0 warning。
- **测试**：acton test → **179 passed / 18 files**（v8.9 M4.2：round-0 退款账本 bounce 回滚 carry；含真 Jetton/真 OA 回归）；acton check 0 error 0 warning。
- **冻结 tag/commit**：`v8.9-audit-fixed`（HEAD；M4.2 定向修复）。
- **合约代码哈希（v8.9 冻结，clean rebuild，Tolk code cell）**——**以此为准**：
    - RoundController：0xFE7088ED1C52949CD1CB0931D95911F757BC402FC37065502002DF15CCDD50AE
    - TeamVault：0xDE6BE49154E3024C9B6945EA81E7181F3E1D04FECC85DBC629C08EDE6A673FB6
    - OracleAdapter：0x0C91E5338E00F18B5FFC7C5C26B510424775D8089588F4147E5B667703676768
    - JettonMaster：0xB8FAF413176C6329A98B2474FEDF765A796A14EDA96C031EE1FE5B27E59EE272
    - JettonWallet：0xC40F41ED05BEFFB7EF17E25FA0D1BB2AFDA72C567052546A2E310C0275D31D13
- **ABI JSON**：deploy/abi/{RoundController,TeamVault,JettonMaster,JettonWallet}.json（acton build 生成后复制；MockJettonWallet.json 仅测试用）。
- **部署参数模板**：deploy/params.testnet.json（含 V6.1 经济参数 + V6.2 时间参数与地址占位符）；主网模板 deploy/params.mainnet.template.json（**当前 BLOCKED**，见 §10）。

---

## 1. 工具链探测与选型

### 1.1 探测结果（本机，2026-11-05）

| 工具 | 状态 | 结论 |
| --- | --- | --- |
| **Acton 1.1.0**（~/.acton/bin/acton，aarch64-apple-darwin） | 已安装可用 | 采用；内置 Tolk 编译器、stdlib、链模拟测试框架、script 部署入口 |
| Tolk 语言 | acton build/test 验证通过 | 采用（docs/11 §1 亦将 Tolk 列为自研合约首选） |
| @ton/blueprint + FunC | 未安装；npm 是 pnpm 包装器、pnpm 不在 PATH，且工程约定“不要跑 npm install” | **fallback**，不作为本次交付构建方式（命令见 §1.4） |
| ft / func / tolk / toncli 独立二进制 | 未安装 | 不依赖 |

**选型理由**：

1. **可立即复现**：Acton 已安装且本机跑通，acton build/test 不依赖仓库 pnpm workspace，不触碰 web/worker 依赖。
2. **符合架构口径**：docs/11 §1 推荐“官方 Jetton 保持 FunC 原样 + 自研 RoundController/TeamVault 用 Tolk”；Acton 是 Tolk 官方工具链。
3. **测试能力匹配**：需要跨合约异步消息、时间推进、三笔 burn ack、重复消息/退款路径，Acton emulation test 原生支持（testing.setNow、net.send、findTransaction、external-out 事件断言）。
4. **blueprint 的代价**：需要 npm/pnpm 安装依赖与下载 FunC wasm 编译器；本机 pnpm 不在 PATH，且任务环境明确要求不跑 npm install，因此仅作为审计机构强制 FunC 时的 fallback（逻辑可一一对应移植，自研面合计约 1,300 行 Tolk（RC 1,121 + TV 211））。

### 1.2 本机验证命令

    # 版本
    acton --version          # acton 1.1.0 (9cf4d1f 2026-05-22)

    # 若 PATH 未包含 ~/.acton/bin：
    export PATH="$HOME/.acton/bin:$PATH"

    # 编译 / 静态检查 / 测试（在 contracts/ 目录内）
    cd contracts
    acton build              # 产出 build/*.json 与 build/abi/*.json
    acton check              # 0 warning
    acton test               # 144 passed
    acton build --info       # 打印 code hash

### 1.3 官方安装方式（新机器）

Acton 官方文档：https://ton-blockchain.github.io/acton/docs/installation （使用官方安装脚本；本机已装 1.1.0，未重复安装）。
安装后确认：acton --version、acton doctor。首次 acton build 会在项目内安装 Tolk 标准库到 .acton/（已在 .gitignore 忽略）。

### 1.4 @ton/blueprint + FunC fallback（未执行，仅记录）

    # 官方模板（需要 Node.js + npm/pnpm，且会安装依赖与 FunC 编译器）
    npm create ton@latest a9-contracts-func
    # 或已有项目：
    cd <project> && npm install --save-dev @ton/blueprint
    npx blueprint build
    npx blueprint test

> 本仓库的 npm 实际是 pnpm 包装器且 pnpm 不在 PATH；若审计要求 FunC，建议在**独立目录/独立 CI job** 中做 Tolk→FunC 移植并用 blueprint 测试，不修改本目录的构建链。

---

## 2. 目录结构

    contracts/
    ├── Acton.toml                     # Acton 工程配置（合约清单、脚本、import mappings）
    ├── README.md                      # 本文件
    ├── contracts/
    │   ├── constants.tolk             # opcode / 状态常量 / 错误码 / burn kind
    │   ├── types.tolk                 # 存储、消息、事件、get-method 返回结构
    │   ├── jetton.tolk                # TEP-74 转账/销毁 body 构造、forward_payload 解包、事件日志
    │   ├── jetton/                    # TEP-74 Jetton 实现（A9 Jetton Master/Wallet）
    │   │   ├── JettonMaster.tolk      # mint-once 100 亿、burn_notification 扣 supply、TEP-89 查询
    │   │   ├── JettonWallet.tolk      # transfer/internal_transfer/burn，forward_payload 原样透传
    │   │   └── messages.tolk/storage.tolk/errors.tolk/jetton-utils.tolk/fees-management.tolk/sharding.tolk
    │   ├── RoundController.tolk       # 状态机 + 质押账本 + 目标价锁定 + 结算 + claimAll
    │   ├── TeamVault.tolk             # 12 亿团队额度；仅 RC 指令；按轮释放/销毁；幂等互斥
    │   └── mocks/MockJettonWallet.tolk# 测试夹具（非生产）
    ├── tests/
    │   ├── test-utils.tolk            # fixture、时间推进、质押/开轮/结算/领取 helper
    │   ├── team-vault.test.tolk       # 13 tests
    │   ├── round-controller.test.tolk # 16 tests（生命周期/限额/退款/晚开窗）
    │   ├── settlement.test.tolk       # 11 tests（成功/失败/0 质押/技术终止/暂停恢复）
    │   ├── invariants.test.tolk       # 7 tests（事件/tier/跨轮 claimAll/重试/10 轮上限）
    │   ├── jetton.test.tolk           # 18 tests（TEP-74 Master/Wallet、mint-once、forward payload 透传、burn/supply）
    │   ├── rewards-v8.test.tolk        # 22 tests（权重档位/streak/邀请/滚存/早领/解锁/不变量/旧接口 50%/gas）
    │   └── p0-fixes.test.tolk           # 9 tests（P0 权限/BurnAck→ReturnExcesses/领取 bounce 回滚）
    ├── scripts/
    │   ├── deploy-emulation.tolk      # 整体部署：JettonMaster → mint → TeamVault → RC → 真实钱包绑定 → InitController
    │   └── deploy/                    # 部署 + 运维脚本（JettonMaster/mint、fund_jetton/fund_ton/admin_op，位置参数）
    └── deploy/
        ├── params.testnet.json        # V6.1 部署参数模板（raw units + human 值）
        ├── params.mainnet.template.json
        └── abi/*.json                 # 编译产物 ABI

---

## 3. 架构与状态机

V6.1 自研面 **只有 2 个合约**（docs/11 §4）：

- **RoundController（RC）**：同时承担 docs/04 中 StakingVault / RewardVault 的**逻辑职责**（质押账本、本金/奖励领取、目标价、K 线计数、结算指令）。它拥有 1 个 Jetton Wallet：同时托管“质押本金 + 每轮 7 亿奖励”。**不存在独立的 StakingVault / RewardVault 地址**，前端/脚本不要假设存在。
- **TeamVault（TV）**：持有 12 亿团队额度对应的 Jetton Wallet；只接受 RC 指令，按轮 ReleaseTeamQuota / BurnTeamQuota 1.2 亿，同轮互斥且幂等。

### 3.1 轮次状态（uint8）

| 值 | 状态 | 说明 |
| --- | --- | --- |
| 0 | UNOPENED | 未开轮（getter 对不存在轮次返回此值） |
| 1 | PREVIEW | 结算后 12h 预告期；stakeOpenAt = settledAt + 43,200；不能质押 |
| 2 | STAKING_OPEN | 报名 36h（可触价提前关窗）；接受 stake |
| 3 | STAKING_CLOSED | 关窗，等待 observationStart |
| 4 | OBSERVING | 24 根 × 1h K 线，阈值 16 |
| 5 | ORACLE_PAUSED | 预言机异常暂停；恢复时**重置完整 24h 观察窗口** |
| 6 | SETTLING_SUCCESS | 等待 TeamVault release ack（0 质押成功还需 reward burn ack） |
| 7 | SETTLING_FAILURE | 等待三笔 burn ack（reward / team / principal） |
| 8 | SUCCEEDED | 终态；可 claim；tier+1 |
| 9 | FAILED_PERMANENT | 终态；不可 claim；**tier 不变（同档重试）** |
| 10 | TECHNICAL_ABORTED | 技术终止终态；退 100% 本金；不销毁、不消耗档位 |

### 3.2 时间线（V6）

    T0 结算(SUCCEEDED/FAILED_PERMANENT) → PREVIEW 12h → STAKING_OPEN 36h
      → STAKING_CLOSED（observationStart = stakeCloseAt；提前关窗则 = 关窗时刻）
      → OBSERVING 24h/24 根 → qualified>=16 ? SETTLING_SUCCESS : SETTLING_FAILURE
      → (ack) → SUCCEEDED / FAILED_PERMANENT → 下一轮 PREVIEW

- **R1**：无 PREVIEW；OpenRound 交易中 stakeOpenAt = now。
- **目标价**：开窗时锁定 target = max(P0 × 2^tier, 2 × 开窗 24h TWAP)；tier = successCount + 1；成功才升档，失败同档重试（D-28）。
- **触价提前关窗**：报名期内 twap1h >= target 时 CloseStaking 立即关窗。
- **晚开窗兜底**：若 keeper 错过整个 36h 窗口（now >= previewEnd + 36h），OpenRound 会把 stakeOpenAt 重锚为 now，避免轮次永久卡死（工程兜底，见 §9）。
- **观察期判定**：24 根齐备后 qualified >= 16 成功，否则 SETTLING_FAILURE（**无中间态**；docs/02 已同步修正）。
- **单轮 = 12h 预告 + 36h 报名 + 24h 观察 = 72h；10 轮 = 30 天。**
- **技术终止**（任何人可触发）：连续 ORACLE_PAUSED ≥ 14 天；或 STAKING_CLOSED/OBSERVING 且 now >= observationEnd + 7 天。

### 3.3 目标价公式与校验

    floor  = P0(116000 USD_E8) × 2^tier
    target = max(floor, 2 × twap24hUsdE8)        // twap 由 OpenRound 参数提供（测试网手动模式）

- 合约**不预存** 10 个价格；只存 p0UsdE8、priceMultiplier（不可变）、successCount（推导 tier）、每轮 targetPriceUsdE8/targetTwap24hUsdE8/targetWrittenAt。
- 任何人可离线用 P0 × 2^tier 校验链上锁定值；TargetPriceSet 事件携带 (roundId, tier, targetPriceUsdE8, twap24hUsdE8)。
- 阶梯参考（tier）：t1 232000 … t10 118,784,000 USD_E8（= $1.18784，与 docs/01 R10 一致）。

### 3.4 V8 权重与奖励三态（docs/17_REWARD_V2.md）

**权重（入账时增量累计，O(1)，无用户遍历）**

    base   = stake × (1 + 10% × min(streak,10))
    bonus  = min(20% × referredStake, ownStake)
    weight = base + bonus
    reward = floor(700M × (ownWeight + referralBonus) / totalWeight)

- streak：入账时若 lastStakeRound == r-1 则 +1，否则 1；同一轮多次入账保持当前 streak；滚存算参与；封顶 10（最高 2.0×）。
- 邀请：SetReferrer 一次性、不可改；禁止自邀/互相绑定；只认一层；被邀请人 ≥ 10,000 A9 才有效；加成封顶 = 邀请人本轮自己质押额；按入账增量累计（room = ownStake - bonus，add = min(20%×amount, room)）。
- **舍入**：reward 使用 floor；余数留在金库（不增发）。因此 Σ(user reward) ≤ 700M；等权重时精确等于 700M（测试覆盖两种情形）。
- **K 线**：不再逐条存 map；SubmitCandle 必须顺序提交（candleIndex == candlesSeen）且 periodStart == observationStart + index×3600；candleHash = sha256(prevHash ‖ index ‖ twap ‖ digest)，链下 24 条公开数据可重算对账。

**奖励三态（每个 (user, round) 单值、互斥、不可回退）**

| 状态 | 值 | 触发 | 结果 |
| --- | --- | --- | --- |
| PENDING | 0 | 结算默认 | 不动作；R10 终态后进入 12 个月线性解锁池 |
| ROLLED | 1 | RollReward(roundId) | 奖励计入下一轮质押（≤20M/地址、≤200M/轮），超出部分转锁定池；下一轮失败则随本金 100% 销毁 |
| EARLY | 2 | ClaimRewardEarly(roundId) | 立即领 50%，另 50% 进入 R10 后解锁池（不销毁） |

- 解锁窗口：R10 终态时写 unlockStart；之后 12 × 30 天线性（每月 1/12）。
- ClaimUnlocked 首次调用把该用户所有 PENDING 奖励折叠进锁定池（标记 rewardClaimed 防重复），之后按线性领取。
- **旧 ABI 保留且不再有后门**：ClaimPrincipal / ClaimReward / ClaimAll 的 opcode 与字段不变；其中 **ClaimReward/ClaimAll 的奖励部分在阶梯期一律按 EARLY 语义只付 50%**，另 50% 进锁定池；ClaimPrincipal 仍 100% 全额。R10 解锁开始后旧 ClaimReward 拒绝（RewardStateLocked），请用 ClaimUnlocked。

---

## 4. ABI（opcode / payload / get methods）

> 自定义 opcode 统一占用项目保留段 0x5254xxxx。下列为**实现定稿**；与 docs/04 §5/§19 对齐，新增项在 §4.4 标注。

### 4.1 自定义内部消息（用户/keeper/RC → 合约）

| Opcode | 消息 | 发送者 | 接收者 | Body 布局（op 之后） |
| --- | --- | --- | --- | --- |
| 0x52540001 | OpenRound | admin 或 oracle | RC | queryId:u64, twap24hUsdE8:u128 |
| 0x52540002 | CloseStaking | **admin 或 oracle（P0-1 收紧）** | RC | queryId:u64, twap1hUsdE8:u128 |
| 0x52540003 | SubmitCandle | **admin 或 oracle（P0-1 收紧）** | RC | queryId:u64, roundId:u8, candleIndex:u8, periodStart:u32, periodEnd:u32, twapPriceUsdE8:u128, dataDigest:u256 |
| 0x52540005 | FinalizeRound | 任何人 | RC | queryId:u64, roundId:u8 |
| 0x52540006 | ClaimPrincipal | 用户 | RC | queryId:u64, roundId:u8 |
| 0x52540007 | ClaimReward | 用户 | RC | queryId:u64, roundId:u8 |
| 0x5254000A | PauseOracle | admin 或 oracle | RC | queryId:u64, reason:u32 |
| 0x5254000B | ResumeOracle | admin 或 oracle | RC | queryId:u64 |
| 0x5254000E | ClaimAll | 用户 | RC | queryId:u64, roundId:u8（0 = 扫描 1..10 全部已结算轮） |
| 0x5254000F | StakeDeposit（forward payload） | 用户 Jetton Wallet | RC | 见 §4.2 |
| 0x52540010 | AbortTechnical | 任何人 | RC | queryId:u64 |
| 0x52540011 | StartObservation | 任何人 | RC | queryId:u64, roundId:u8 |
| 0x52540015 | RetryPendingActions | admin | RC | queryId:u64, roundId:u8 |
| 0x52540016 | SetJettonWallet | admin（一次性） | RC / TV | wallet:address |
| 0x5254001B | SetJettonWalletCode | admin（一次性，R1 前） | RC | code:cell |
| 0x5254001C | SetTeamWalletJettonWallet | admin | TV | wallet:address |
| 0x52540017 | ClaimRewardEarly | 用户 | RC | queryId:u64, roundId:u8（PENDING → EARLY，付 50%） |
| 0x52540018 | RollReward | 用户 | RC | queryId:u64, roundId:u8（PENDING → ROLLED，全额进下一轮） |
| 0x52540019 | SetReferrer | 用户 | RC | referrer:address（一次性、不可改） |
| 0x5254001A | ClaimUnlocked | 用户 | RC | queryId:u64（R10 终态后按 12 个月线性领取） |

### 4.2 质押 StakeDeposit（TEP-74 transfer 的 forward_payload）

用户 → **自己的 Jetton Wallet** 发送标准 TEP-74 transfer（0x0f8a7ea5）：

- transferRecipient = **RoundController 地址**（RC 的 Jetton Wallet owner）
- response_destination = 用户地址
- forward_ton_amount = 0.05 TON（≥0.03 即可）
- forward_payload = Either right（1 bit + ref cell），cell 内容 136 bit：

    op                     : uint32 = 0x5254000F
    version                : uint8  = 1
    roundId                : uint8
    depositNonce           : uint64      // 同轮同地址单调递增；重复/回退 -> 退款
    riskDisclosureVersion  : uint16      // 必须 == config.riskDisclosureVersion（测试网 1）
    acceptFullPrincipalBurn: uint8 (0/1) // 必须 = 1，否则退款

RC 收到 transfer_notification#7362d09c（sender:MsgAddressInt，官方 TEP-74 格式）后校验来源 = 自己的 canonical Jetton Wallet、金额、窗口、nonce、限额；任一失败 → **从 RC 的 Jetton Wallet 原路退回**（用户无需操作）。

### 4.3 领取语义

- ClaimPrincipal：SUCCEEDED 或 TECHNICAL_ABORTED 可领；每 (round, owner) 一次（不变）。
- ClaimReward / ClaimAll：opcode 与字段不变；奖励部分按权重公式计算后，**阶梯期只付 floor(reward/2)，另一半进锁定池（EARLY 语义）**；本金部分仍 100%。解锁开始后旧 ClaimReward 拒绝。
- 旧 ClaimAll 的合并转账 = 本金(100%) + 奖励的 50%；另一半在 get_unlock_info 中可见。
- ClaimRewardEarly：仅 PENDING 且未领；立即付 floor(reward/2)，另一半进入锁定池（EARLY）。
- ClaimPrincipal(0)：A9-CRIT-02 退款账本（round 0 不是轮次），用于领取低 gas/退款 bounce 后记入的 A9；claim kind 新增 REFUND=5，走独立 pending 回滚。
- RollReward：仅 PENDING 且未领；奖励转入下一轮质押（受 20M/地址、200M/轮上限），超出部分进锁定池（ROLLED）。
- ClaimUnlocked：R10 终态前拒绝；之后按 12×30 天线性领取锁定池（含 PENDING 与早领罚没部分）。
- ClaimAll 仍 roundId=0 扫描 1..10，合并一笔 Jetton 转账；本金与奖励 pull claim，用户自付 gas。
- **P0-3 领取安全**：所有领取转账为 bounceable + send_excesses 回 RC；RC 以 queryId 记录 pending claim，成功（ReturnExcessesBack 0xd53276db）删除、bounce 回滚领取标记与锁定金额；queryId = roundId<<32 | kind<<24 | counter24（counter 存 storage，全局唯一）。
- **P0-2 销毁确认**：burn 的 response_destination = RC，queryId = roundId<<16 | kind<<8；真实 Jetton Master 的 ReturnExcessesBack(0xd53276db) 即销毁确认（BurnAck 保留为兼容路径）。

### 4.4 RC → TeamVault / ack（内部，前端不要发）

| Opcode | 消息 | 发送者 | 接收者 | Body |
| --- | --- | --- | --- | --- |
| 0x5254000C | ReleaseTeamQuota | RC | TV | queryId:u64, roundId:u8 |
| 0x5254000D | BurnTeamQuota | RC | TV | queryId:u64, roundId:u8, burnId:u256 |
| 0x52540009 | BurnAck | jettonMaster（测试网 ack 地址） | RC | roundId:u8, kind:u8(1 reward/2 team/3 principal), amountRaw:u128, burnId:u256 |
| 0x52540013 | TeamReleasedAck | TV | RC | queryId:u64, roundId:u8, amountRaw:u128 |
| 0x52540014 | TeamBurnedAck | TV | RC | queryId:u64, roundId:u8, amountRaw:u128, burnId:u256 |
| 0xd53276db | ReturnExcessesBack | RC Jetton Wallet / Jetton Master / TV Jetton Wallet | RC / TV（TEP-74 完成确认；P0-2/P0-3） | queryId:u64 |

### 4.5 事件（external-out logs，TEP 风格）

| Opcode | 事件 | 发送者 | 字段 |
| --- | --- | --- | --- |
| 0x52540101 | TargetPriceSet | RC | roundId, tier, targetPriceUsdE8, twap24hUsdE8 |
| 0x52540102 | RoundSettled | RC | roundId, status, qualifiedCandles, candlesSeen, totalAcceptedStakeRaw, tierAfter |
| 0x52540103 | DepositAccepted | RC | roundId, owner, amountRaw, totalAcceptedStakeRaw |
| 0x52540104 | TechnicalAborted | RC | roundId, reason, at |
| 0x52540201 | TeamReleased | TV | roundId, amountRaw, to |
| 0x52540202 | TeamBurned | TV | roundId, amountRaw, burnId |
| 0x52540105 | RewardRolled | RC | roundId, owner, amountRaw, nextRoundId |
| 0x52540106 | RewardEarly | RC | roundId, owner, paidRaw, lockedRaw |
| 0x52540107 | ReferrerSet | RC | owner, referrer |
| 0x52540108 | UnlockClaimed | RC | owner, amountRaw |
| 0x52540109 | ClaimRolledBack | RC | queryId, roundId, kind, owner, amountRaw（回滚事件，索引器据此作废前序事件） |
| 0x5254010A | PrincipalClaimedEvent | RC | roundId, owner, amountRaw, queryId |
| 0x5254010B | StakingClosed | RC | roundId, closeAt, early, twap1hUsdE8 |
| 0x5254010C | CandleSubmitted | RC | roundId, candleIndex, periodStart, periodEnd, twapPriceUsdE8, dataDigest, candleHash |
| 0x5254010D | OraclePauseChanged | RC | roundId, paused, at |

### 4.6 Get methods（只读）

| 方法 | 返回 |
| --- | --- |
| get_protocol_config() | 扁平 ProtocolConfigView（admin/oracle/jettonMaster/stakingJettonWallet/teamVault + 全部 14 个 V6.1 参数） |
| get_current_round() / get_success_count() | uint8 |
| get_round(round_id) | RoundView（状态、tier、目标价、TWAP、时间、K 线计数、总质押、flags、burnId） |
| get_round_status(round_id) | uint8 |
| get_round_target_price(round_id) | uint128（未开窗为 0） |
| get_user_stake(round_id, owner) | StakePosition（amountRaw, lastDepositNonce, claimed flags） |
| get_round_total_stake(round_id) | uint128 |
| get_user_reward_estimate(round_id, owner) | uint128（仅 SUCCEEDED 有值） |
| get_claimable_all(owner) | Claimable{principalRaw, rewardRaw, roundsMask} |
| get_round_burn_status(round_id) | RoundBurnStatus{3 flags, failureBurnId} |
| get_reward_state(owner, round_id) | RewardStateInfo{amountRaw, state, rollableRaw, earlyAmountRaw} |
| get_unlock_info(owner) | UnlockInfo{unlockStart, totalLockedRaw, claimedRaw, claimableRaw}（owner 参数为必要偏离，见 §9） |
| get_referral(owner) | ReferralInfo{referrer, referredStakeThisRound, bonusThisRound} |
| get_streak(owner) | StreakInfo{lastRound, count} |
| get_user_weight(round_id, owner) / get_total_weight(round_id) | uint128（own weight + bonus / Σ weight） |
| get_jetton_wallet_code_hash() | uint256（RC 未配置前返回 0；配置后返回 JettonWallet code cell hash，ops verify 用） |
| TV get_team_wallet_jetton_wallet() | address（teamWallet 的 canonical Jetton Wallet；ops verify 用） |
| TV get_team_vault_state() | controller/jettonWallet/teamWallet/teamRoundRaw/totalReleasedRaw/totalBurnedRaw/counts |
| TV get_round_state(round_id) | TeamRoundState{released, burned, amountRaw, queryId} |

> 前端读取注意：目标价在 PREVIEW/UNOPENED 期间为 0，显示“待开窗锁定”；roundsMask 的 bit i 对应 round i+1。

---

## 5. 存储布局（Tolk cell）

    RoundController.Storage {                 // root cell: 4 refs (config / extras / rounds / stakes)
      config: Cell<ProtocolConfig>
      extras: Cell<StorageExtras>             // V8：referrer / streaks / unlockStart / lockedBonus / unlockClaimed
      currentRoundId:u8, successCount:u8, lastSettledAt:u64, pausedAt:u64
      rounds: map<u8, RoundData>
      stakes: map<u8, map<address, StakePosition>>
    }

    RoundData {
      status:u8, targetTier:u8, targetPriceUsdE8:u128, targetTwap24hUsdE8:u128,
      targetWrittenAt:u64, rewardBudgetRaw:u128,
      stakeOpenAt/stakeCloseAt/observationStart/observationEnd/settledAt:u64,
      candlesSeen:u8, qualifiedCandles:u8, totalAcceptedStakeRaw:u128,
      teamReleaseConfirmed/teamBurnConfirmed/rewardBurnConfirmed/principalBurnConfirmed:bool,
      extra: Cell<RoundExtra>
    }

    RoundExtra {                              // V8：每轮 1 个 ref
      failureBurnId:u256, candleHash:u256,
      totalWeight:u128,
      bonus: map<address, u128>,              // 邀请加成（已封顶）
      referred: map<address, u128>            // 被邀请人本轮质押（getter 用）
    }

    StakePosition {
      amountRaw:u128, lastDepositNonce:u64,
      principalClaimed:bool, rewardClaimed:bool,
      weight:u128,                            // V8：own weight（含 streak 加成）
      rewardState:u8                          // V8：0 PENDING / 1 ROLLED / 2 EARLY
    }

    StorageExtras {
      referrer: map<address,address>, streaks: map<address, StreakInfo{lastRound:u8,count:u8}>,
      locked: map<address, LockedState{lockedRaw:u128, claimedRaw:u128}>,
      pending: map<u64, PendingClaim{owner, kind, roundId, principalMask, rewardMask,
                                     amountRaw, lockedDeltaRaw, lockedBeforeRaw}>,  // P0-3
      claimCounter:u64, unlockStart:u64
    }

    TeamVault.Storage {
      config: admin, controller: address?, configVersion
      params: Cell<{jettonWallet, teamWallet, jettonMaster, teamRoundRaw}>  // ref：地址环依赖 + 体积
      extra: Cell<{teamWalletJettonWallet}>                   // P0 v2：teamWallet 钱包地址（release 确认）
      pendingBurnIds: map<u8,u256>                            // P0-2 closure：待 master 确认的 burnId
      rounds: map<u8, TeamRoundState{released, burned, amountRaw, queryId}>
      totalReleasedRaw/totalBurnedRaw: u128, releasedCount/burnedCount: u8
    }

> 说明：stakingJettonWallet 因“Jetton Wallet 地址由 owner=RC 推导”存在地址环依赖，部署时先用占位地址，RC 部署后由 admin 调用一次 SetJettonWallet（0x52540016）；TeamVault 同理。两个 setter 都只能 admin 调用，且必须早于第一轮/Controller 初始化。

---

## 6. 结算流程

### 6.1 成功（含 team 释放）

1. 第 24 根 K 线提交后：qualified >= 16 → SETTLING_SUCCESS；发出 ReleaseTeamQuota(roundId)。
2. TeamVault 以 pending 状态转 1.2 亿到 teamWallet（response_destination = TV 自身）；等 TV Jetton Wallet 的 ReturnExcessesBack 确认后才置 released、累计并回 TeamReleasedAck → RC 置 teamReleaseConfirmed；bounce 时清 pending、不 ack、可重试。
3. 任何人 FinalizeRound → SUCCEEDED；successCount += 1；创建下一轮 PREVIEW（stakeOpenAt = now + 12h）。
4. 用户按需 ClaimPrincipal/ClaimReward/ClaimAll；本金与奖励均留在 RC 的 Jetton Wallet，未领可跨轮累积。

### 6.2 0 人质押且通过（D-18b）

- SETTLING_SUCCESS + 发出 reward burn（7 亿）+ team release（1.2 亿）。
- 需 rewardBurnConfirmed && teamReleaseConfirmed 才能 FinalizeRound → SUCCEEDED；无任何领取记录。

### 6.3 失败（三笔销毁）

SETTLING_FAILURE 时 RC 发出：

1. AskToBurn（RC Jetton Wallet）→ reward 700,000,000 A9
2. AskToBurn（RC Jetton Wallet）→ principal totalAcceptedStakeRaw（0 人质押时直接标记 confirmed）
3. BurnTeamQuota → TeamVault 发起销毁 120,000,000 A9（response_destination = TV 自身）；等 Jetton Master 的 ReturnExcessesBack 到达后才回 TeamBurnedAck 并累计 burned；bounce 时清 pending、不 ack、可重试

三笔确认后 FinalizeRound → FAILED_PERMANENT；tier 不变，下一轮同档重试。重复 ack 幂等（终态后直接忽略）；缺 ack 时 admin 可 RetryPendingActions 重发未确认的 burn 指令。

### 6.4 技术终止

- 触发：ORACLE_PAUSED 连续 14 天，或观察结束超时 7 天；**任何人**可调用 AbortTechnical。
- 效果：TECHNICAL_ABORTED；本金 100% 可领；**不销毁** reward/team；**tier 不变**；创建下一轮 PREVIEW。

---

## 7. 部署

### 7.1 V6.2 参数（与 deploy/params.testnet.json 一致；单轮 72h / 10 轮 30 天）

| 参数 | 值 | raw（decimals=9） |
| --- | --- | --- |
| p0UsdE8 | 116000（$0.00116） | — |
| priceMultiplier | 2×（不可变） | — |
| roundRewardRaw | 700,000,000 A9 | 700000000000000000 |
| teamRoundRaw | 120,000,000 A9 | 120000000000000000 |
| previewSeconds | 43,200（12h） | — |
| stakeDurationSeconds | 129,600（36h） | — |
| candleSeconds / candleCount | 3,600 / 24 | — |
| minQualifiedCandles | 16 | — |
| observationSeconds | 86,400（24h） | — |
| minStakeRaw | 10,000 A9 | 10000000000000 |
| maxStakePerAddressBps | 1000（10%，**解释为固定硬顶**，见 §9） | — |
| maxStakePerAddressRaw | 20,000,000 A9 | 20000000000000000 |
| maxTotalStakeRaw | 200,000,000 A9 | 200000000000000000 |
| techAbortPauseSeconds | 1,209,600（14 天） | — |
| techAbortObsTimeoutSeconds | 604,800（7 天） | — |
| riskDisclosureVersion / configVersion | 1 / 1 | — |

代币侧（Jetton，官方复用）：总量 100 亿；奖励池 70 亿（RC Jetton Wallet）、团队 12 亿（TeamVault Jetton Wallet）、内盘 8 亿、流动性 5 亿、营销 5 亿。

### 7.2 部署顺序（重要）

0. 部署 **A9 JettonMaster**（Tolk 复刻 TEP-74）：admin=treasury、total_supply=0、wallet code 内嵌。
1. 用 mint-once（op 0x15）铸造 **100 亿 A9** 到 treasury；同一笔交易把 admin 置空，**mint 永久关闭**。
2. 部署 **TeamVault**：jettonWallet 用占位地址（建议 admin），controller = null。
3. 部署 **OracleAdapter**（主网；测试网可选）→ 部署 **RoundController** 时把 oracle 填为 OracleAdapter 地址 → 调 OracleAdapter.SetOracleController(rc)。
4. 用 Jetton Master get_wallet_address(roundController) 得到 RC 的 canonical Jetton Wallet → admin 调 RC.SetJettonWallet(wallet)。
5. 同法得到 TV 的 Jetton Wallet → admin 调 TV.SetJettonWallet(wallet)。
6. admin 调 TV.InitController(roundController)（**一次性，之后不可改**）。
7. 给 RC Jetton Wallet 打 70 亿 A9；给 TV Jetton Wallet 打 12 亿 A9。
8. 给 RC ≥ 20 TON、TV ≥ 10 TON 作为 gas/存储；admin 调 OpenRound(round=1, twap24h) 开首轮。

> 3~6 步的 JettonMaster 地址与两个 Jetton Wallet 地址现在由脚本自动解析（get_wallet_address）并写入，不再使用人工占位。

> **测试网最小足迹部署**：deploy-emulation 的 4 笔部署 TON 可用环境变量下调（默认值即主网/常规值，保持不变）：
> A9_DEPLOY_TON_JETTON_MASTER（默认 5）、A9_DEPLOY_TON_ORACLE_ADAPTER（默认 5）、
> A9_DEPLOY_TON_TEAM_VAULT（默认 1）、A9_DEPLOY_TON_ROUND_CONTROLLER（默认 5）。
> 例如 TON 不足时：A9_DEPLOY_TON_JETTON_MASTER=1 A9_DEPLOY_TON_ORACLE_ADAPTER=1
> A9_DEPLOY_TON_TEAM_VAULT=1 A9_DEPLOY_TON_ROUND_CONTROLLER=1 acton script scripts/deploy-emulation.tolk。
> 脚本启动时会打印 Deploy TON: ... 便于核对；**主网请使用默认值**，不要为省 TON 降低部署余额。

> **TON 覆盖值解析**：4 个环境变量接受十进制字符串（如 5、0.6、1.25，单位 TON），脚本内部转成 nano；
> 解析失败/非正数会立即 fail，不会静默回退默认值。启动打印会标注 [env] 或 [default]。
>
> **部署失败即停**：每笔部署（JettonMaster / OracleAdapter / TeamVault / RoundController）后都会校验
> 账户 state == active 且 code hash == build 产物；不满足立即 fail，并打印合约名、地址、deployer 余额、
> 本笔所需 nano。wiring 完成后还会用 getter 校验 SetJettonWallet / SetJettonWalletCode /
> SetTeamWalletJettonWallet / SetOracleController / InitController 是否真的写入。
>
> **Resume 模式（方案 A）**：A9_RESUME_JETTON_MASTER_ADDRESS=<已存在的 master 地址> 时跳过
> JettonMaster 部署与 mint，只部署 OracleAdapter → TeamVault → RoundController 并完成全部 wiring；
> resume master 必须已 mint 100 亿（脚本用 get_jetton_data 校验）。本地验证可对测试网状态 fork：
>
>     A9_RESUME_JETTON_MASTER_ADDRESS=<master> acton script scripts/deploy-emulation.tolk --fork-net testnet
>
> 真实测试网广播时同样传该 env 并加 --net testnet；全量模式不设该 env 即保持原行为。

> **测试网 10 秒级快测（task-33）**：deploy-emulation 的 ProtocolTiming 与奖励池支持 env 覆盖，默认值 = 生产值（主网必须用默认）：
>
> | 环境变量 | 默认（生产） | 快测建议 |
> | --- | --- | --- |
> | A9_TIMING_PREVIEW_SECONDS | 43200 | 10 |
> | A9_TIMING_STAKE_SECONDS | 129600 | 120 |
> | A9_TIMING_CANDLE_SECONDS | 3600 | 10 |
> | A9_TIMING_CANDLE_COUNT | 24 | 24 |
> | A9_TIMING_MIN_QUALIFIED | 16 | 16 |
> | A9_TIMING_OBSERVATION_SECONDS | 86400 | 240 |
> | A9_DEPLOY_ROUND_REWARD_RAW | 700000000000000000 | 快测用小额 |
> | A9_DEPLOY_TEAM_ROUND_RAW | 120000000000000000 | 快测用小额 |
>
> - 全部按十进制整数严格解析，非法值立即 fail（不会静默回退）；启动打印 Timing: ... [env]/[default]。
> - 一致性校验：observationSeconds == candleSeconds * candleCount、minQualified <= candleCount、minQualified > candleCount/2。
> - 快测示例：
>
>       A9_TIMING_PREVIEW_SECONDS=10 A9_TIMING_STAKE_SECONDS=120 A9_TIMING_CANDLE_SECONDS=10 A9_TIMING_CANDLE_COUNT=24 A9_TIMING_MIN_QUALIFIED=16 A9_TIMING_OBSERVATION_SECONDS=240 A9_DEPLOY_ROUND_REWARD_RAW=1000000000000000 A9_DEPLOY_TEAM_ROUND_RAW=200000000000000 acton script scripts/deploy-emulation.tolk
>
> - 快测会改变 RC 的 code/data（timing 写入 storage），RC 地址会与生产默认值不同；主网/正式测试网请清空这些 env 使用默认值。

### 7.3 脚本

    cd contracts
    # 本地模拟：按顺序部署 TeamVault → RC → InitController，并打印地址/参数
    acton script scripts/deploy-emulation.tolk
    # 等价：acton run deploy-emulation

    # 真实测试网（需 wallets.toml / 全局钱包已配置，且 Jetton Master 已就绪）
    acton script scripts/deploy-emulation.tolk --net testnet

输出示例（emulation）：

    A9 deploy params: ...
    JettonMaster deployed at kQBSgpGVYdxkqdeNqfER_KA1lz_45TCwtTi689Q924f83bjN (JettonMaster)
    JettonMaster minted 100e9 A9 to admin; mint is now permanently closed
    TeamVault deployed at kQBGi6_w-5ecUCut2RvI3vjLd5HcfK5gGpEL6R8kGKP2xmut (TeamVault)
    RoundController deployed at kQCxFSg2DYDKTGOG0NJCfO0hXDPyyoHV9GwrpqBxWjzvIjIW (RoundController)
    RC Jetton Wallet     = kQCxE-xHBrh9EwnXcxbtMKzlRxQm-dJqkj8eSDIFewCrOJUP
    TeamVault Jetton Wallet = kQBG6q-8WwikdS1t0uufY5-bFCyywENljW3k_-N0El88hPWa

分步脚本（位置参数，Acton 不支持 --flag 形式）：

    # 1) 只部署 JettonMaster（地址会写入 deploy/jetton-master.addr）
    acton script scripts/deploy/deploy_jetton_master.tolk <treasury_owner_address> 10000000000000000000
    # 2) 铸造 100 亿并关闭 mint（需 master 地址与 treasury=当前 admin）
    acton script scripts/deploy/mint_and_lock_jetton.tolk <master_address> <treasury_address> 10000000000000000000

> 真正的链上部署/注资/轮次运营 SOP 由 **ops/**（task-6）承接；本脚本负责“合约部署顺序 + 地址计算 + 初始化校验”。
> **ops 集成注意**：ops/config/testnet.params.json 的命令模板当前使用 --treasury/--amount/--only 形式，与 Acton 位置参数不兼容；需改为位置参数（或使用整体 deploy-emulation）。

### 7.4 Jetton 交互（生产）

- RC/TV 发出的都是标准 TEP-74 transfer (0x0f8a7ea5) / burn (0x595f07bc)；金额为 raw（9 decimals）。
- 退款/领取均从合约自己的 Jetton Wallet 发出，response_destination = 收款用户；合约需保留 TON 余额支付转发费（每条指令约 0.05 TON）。
- 收到的 transfer_notification 采用官方格式 sender:MsgAddressInt（非 Maybe）。

### 7.5 Jetton Master / Wallet（TEP-74，Tolk 实现）

**位置**：contracts/jetton/（Master、Wallet、messages/storage/errors/jetton-utils/fees-management/sharding）。
**来源**：Acton 官方 jetton 模板（TEP-74/89 兼容骨架）+ A9 mint-once 改造；本机无 FunC 工具链，故以 Tolk 复刻而非直接复用 FunC 源码。
**代码哈希**：JettonMaster 0xAA7BC0B3429880FCE965C6FF5FC8E7A0A4F63445F1BA2602EBF37A079DBE740C；JettonWallet 0x068E64CF94ABC5B514A65CC32A6B8415E8E963FAD9C016E0BC815AB68C447D53。
**ABI**：deploy/abi/JettonMaster.json、deploy/abi/JettonWallet.json。

#### 7.5.1 Master ABI（op 均为 32-bit）

| Opcode | 消息 | 发送者 | Body（op 之后） | 说明 |
| --- | --- | --- | --- | --- |
| 0x00000015 | MintOnce | admin | queryId:u64, recipient:address, tonAmount:coins, jettonAmount:coins, totalTonAmount:coins, forward_payload:(Either) | 仅一次，jettonAmount 必须 = 100,000,000,000 × 10^9；成功后 admin=null（mint 永久关闭） |
| 0x7bdd97de | burn_notification（标准） | Jetton Wallet（canonical） | queryId:u64, jettonAmount:coins, burnInitiator:address, sendExcessesTo:address? | 校验 sender == get_wallet_address(burnInitiator)，扣 total_supply |
| 0x7bcdEFA0 | burn_notification（别名） | Jetton Wallet（canonical） | 同上 | 兼容 task 文本写法；Wallet 实际发送标准 0x7bdd97de |
| 0x2c76b973 | provide_wallet_address | 任何人 | queryId:u64, ownerAddress:address, includeOwnerAddress:bool | 回 ResponseWalletAddress 0xd1735400（walletAddress:address?, ownerAddress:^address?） |
| 0x6501f354 | change_admin | admin | queryId:u64, newAdminAddress:address | 两步交接：先设 next admin |
| 0xfb88e119 | claim_admin | next admin | queryId:u64 | 接受 admin |
| 0x7431f221 | drop_admin | admin | queryId:u64 | admin 置空（等同关 mint） |
| 0xcb862902 | change_content | admin | queryId:u64, newMetadata:cell | 更新 metadata（mint 后 admin 为空，不可再改） |
| 0xd372158c | TopUpTons | 任何人 | — | 接受 TON 充值 |

Get methods：get_jetton_data() → { totalSupply, mintable, adminAddress, jettonContent, jettonWalletCode }；get_wallet_address(owner:address) → address；get_next_admin_address()；get_total_supply()。

Storage（MasterStorage）：totalSupply:coins、adminAddress:address?、nextAdminAddress:address?、metadata:cell。**Jetton Wallet code 内嵌在 Master code 中**（@gen/JettonWallet.code），不重复存 data。

#### 7.5.2 Wallet ABI

| Opcode | 消息 | 发送者 | 说明 |
| --- | --- | --- | --- |
| 0x0f8a7ea5 | AskToTransfer | owner | queryId:u64, jettonAmount:coins, transferRecipient:address, sendExcessesTo:address?, customPayload:^cell?, forwardTonAmount:coins, forward_payload:(Either) |
| 0x178d4519 | InternalTransferStep | Master 或 sender 自己的 Wallet | 仅两条合法来源；否则 NotValidWallet(74)。forward_payload/forward_ton_amount 原样透传给收款方 Wallet |
| 0x595f07bc | AskToBurn | owner | queryId:u64, jettonAmount:coins, sendExcessesTo:address?, customPayload:^cell? |
| 0x7bdd97de | burn_notification（Wallet → Master） | Wallet 自己 | queryId:u64, jettonAmount:coins, burnInitiator:address, sendExcessesTo:address? |
| 0x7362d09c | transfer_notification（Wallet → owner） | Wallet 自己 | 仅在 forward_ton_amount > 0 时发送；A9 RC 按此解析 StakePayload |
| 0xd372158c | TopUpTons | 任何人 | 接受 TON |

Get methods：get_wallet_data() → { jettonBalance, ownerAddress, minterAddress, jettonWalletCode }。

Storage（WalletStorage）：jettonBalance:coins、ownerAddress:address、minterAddress:address；Jetton Wallet address = f(Master, owner, wallet code)，部署时由 Master 的 internal_transfer 自动创建。

#### 7.5.3 错误码

TEP-74 对齐：BalanceError=47、NotEnoughGas=48、InvalidMessage=49、InvalidOp=72、NotOwner=73、NotValidWallet=74、WrongWorkchain=333；A9 mint 补充：MintClosed=75、MintAmountMismatch=76、InvalidMintMessage=77。未知消息：Master 抛 49，Wallet 抛 0xFFFF。

#### 7.5.4 与 RC / TeamVault 的接线

1. 部署 Master（admin=treasury）→ MintOnce 100 亿到 treasury（同一交易关 mint）。
2. 部署 TeamVault / RoundController 时写入**真实 Master 地址**（不再是占位 treasury）。
3. 用 Master.get_wallet_address(RC/TV) 得到 canonical Jetton Wallet，分别调用一次性 SetJettonWallet。
4. 从 treasury 向两个 Wallet 转账 70 亿 / 12 亿（TEP-74 transfer），完成注资。
5. 之后 RC/TV 的 transfer/burn 报文不变：Wallet 对 forward_payload 原样透传（测试用 136-bit StakePayload 形状做 hash 断言），burn 会回 Master 扣 total_supply（满足失败轮三笔销毁的 supply 减少要求）。
6. BurnAck 仍由 RC 在测试网以 jettonMaster 地址为权威接收；Jetton 合约本身不实现 RC 的 ack（保持标准 TEP-74 面）。

### 7.6 运维脚本（注资 / TON 充值 / admin 操作）

位置：scripts/deploy/{fund_jetton.tolk, fund_ton.tolk, admin_op.tolk}（共享消息构造在 actions.tolk）。
**全部位置参数**（Acton script 不支持 --flag）；执行/广播由环境变量控制，默认 dry-run：

| 环境变量 | 作用 |
| --- | --- |
| OPS_EXECUTE=1 | 广播（默认不设置 = dry-run，只打印消息摘要） |
| OPS_CONFIRM=YES | OPS_EXECUTE=1 时必须为 YES（双重确认） |
| OPS_ALLOW_EMULATION=true | 仅本地开发：允许在无 --net 时执行（用于验证 trace/hash） |
| A9_SIGNER_WALLET | Acton 钱包名（默认 TON_DEPLOYER_WALLET，再默认 treasury） |
| JETTON_MASTER_ADDRESS | Jetton Master；缺省读 deploy/jetton-master.addr |
| ROUND_CONTROLLER_ADDRESS | RoundController；缺省读 deploy/round-controller.addr |
| TEAM_VAULT_ADDRESS | TeamVault；缺省读 deploy/team-vault.addr |
| A9_TARGET_ADDRESS / A9_JETTON_WALLET_ADDRESS | set-jetton-wallet 的目标合约 / 钱包地址 |
| A9_CONTROLLER_ADDRESS | init-controller 的 RC 地址（默认 ROUND_CONTROLLER_ADDRESS） |
| A9_CANDLE_INDEX / A9_PERIOD_START / A9_PERIOD_END / A9_TWAP_E8 | submit-candle 的 K 线字段（index / 起止 unix 秒 / TWAP USD_E8） |
| A9_DIGEST | submit-candle 的 digest：64 hex 或 0x + 64 hex（256-bit） |

地址文件由 deploy-emulation / deploy_jetton_master 自动写入，均为 user-friendly 地址（无名字后缀）。
dry-run 输出 dest / value / body opcode / message BOC hash；广播时输出实际 trace 的 tx hash。
submit-candle 额外打印全部 K 线字段（roundId/candleIndex/periodStart/periodEnd/twapUsdE8/digest）。

#### 7.6.1 fund_jetton — A9 注资（标准 TEP-74 transfer）

    acton script scripts/deploy/fund_jetton.tolk <to_owner> <amount_raw>

| 参数 | 说明 |
| --- | --- |
| to_owner | 目标 Jetton 的 owner 地址（如 RoundController / TeamVault 合约地址、或普通钱包 owner 地址），不是该 owner 的 Jetton Wallet 地址 |
| amount_raw | raw 单位（9 decimals）；必须是正整数，广播前校验 signer 的 A9 余额 |

**TEP-74 语义（重要）**：AskToTransfer.transferRecipient 必须是 owner；发送方钱包会用
calcDeployedJettonWallet(owner) 自行推导目标钱包。若把 Jetton Wallet 地址当参数传，
会生成一个 owner=该钱包合约 的新钱包（无密钥、不可转出）→ 资金永久锁死。
脚本会在广播/dry-run 前打印 owner -> expected wallet，并（广播时）用
master.get_wallet_address(owner) 与本地 build("JettonWallet") 推导值做硬校验（不一致直接 fail）。

示例（数字按 tokenomics）：

    # 70 亿 → RoundController（owner = RC 合约地址；脚本自己推导 RC 的 Jetton Wallet）
    acton script scripts/deploy/fund_jetton.tolk <ROUND_CONTROLLER_ADDRESS> 700000000000000000
    # 12 亿 → TeamVault（owner = TV 合约地址）
    acton script scripts/deploy/fund_jetton.tolk <TEAM_VAULT_ADDRESS> 120000000000000000
    # 8 亿 / 5 亿 / 5 亿 → 内盘/流动性/营销（owner = 对应钱包 owner 地址）
    acton script scripts/deploy/fund_jetton.tolk <internalOwner> 800000000000000000
    acton script scripts/deploy/fund_jetton.tolk <liquidityOwner> 500000000000000000
    acton script scripts/deploy/fund_jetton.tolk <marketingOwner> 500000000000000000

广播：OPS_EXECUTE=1 OPS_CONFIRM=YES acton script ... --net testnet。

#### 7.6.2 fund_ton — TON gas 充值

    acton script scripts/deploy/fund_ton.tolk <to_address> <amount_ton_integer>

| 参数 | 说明 |
| --- | --- |
| to_address | RC / TeamVault / 任意钱包地址 |
| amount_ton_integer | 整数 TON（20、10 等）；内部换算为 nanotons |

    acton script scripts/deploy/fund_ton.tolk kQCxFSg2DYDKTGOG0NJCfO0hXDPyyoHV9GwrpqBxWjzvIjIW 20   # RC ≥ 20 TON
    acton script scripts/deploy/fund_ton.tolk kQBGi6_w-5ecUCut2RvI3vjLd5HcfK5gGpEL6R8kGKP2xmut 10   # TV ≥ 10 TON

body 为 TopUpTons (0xd372158c)，RC/TV 可直接接收。

#### 7.6.3 admin_op — 轮次与一次性初始化操作

    acton script scripts/deploy/admin_op.tolk <op> <roundId> <extra>

| op | roundId | extra | 消息 / 目标 |
| --- | --- | --- | --- |
| open-round | 0 | 开窗 24h TWAP（USD_E8） | OpenRound(0x52540001) → RC；R1 无 PREVIEW |
| close-staking | 0 | 当前 1h TWAP（USD_E8） | CloseStaking(0x52540002) → RC（触价提前关窗） |
| start-observation | roundId | 0 | StartObservation(0x52540011) → RC |
| finalize-round | roundId | 0 | FinalizeRound(0x52540005) → RC |
| pause-oracle | 0 | reason（0→1） | PauseOracle(0x5254000A) → RC |
| resume-oracle | 0 | 0 | ResumeOracle(0x5254000B) → RC |
| abort-technical | 0 | 0 | AbortTechnical(0x52540010) → RC |
| retry-pending | roundId | 0 | RetryPendingActions(0x52540015) → RC |
| submit-candle | roundId | 0 | SubmitCandle(0x52540003) → RC；candleIndex/periodStart/periodEnd/twapUsdE8/digest 由 env 提供 |
| oracle-candle | roundId | 0 | OracleCandleVerified(0x52540004) → RC；字段同 submit-candle；**当前 RC 无 handler，仅 dry-run**（phase-2 OracleAdapter 需重新部署 RC） |
| set-jetton-wallet | 0 | 0 | SetJettonWallet(0x52540016) → A9_TARGET_ADDRESS，wallet=A9_JETTON_WALLET_ADDRESS |
| init-controller | 0 | 0 | InitController(0x52540012) → TEAM_VAULT，controller=A9_CONTROLLER_ADDRESS（默认 RC） |

    # 示例：开 R1（目标价由 24h TWAP 与阶梯取 max）
    acton script scripts/deploy/admin_op.tolk open-round 0 232000
    # 关报名（正常到点，twap1h 传 0）
    acton script scripts/deploy/admin_op.tolk close-staking 0 0
    # 开观察 / 结算
    acton script scripts/deploy/admin_op.tolk start-observation 1 0
    acton script scripts/deploy/admin_op.tolk finalize-round 1 0
    # 手动 K 线（测试网手动模式）：提交第 1 轮第 0 根 4h→1h K 线
    A9_CANDLE_INDEX=0 A9_PERIOD_START=1259200 A9_PERIOD_END=1262800 \
      A9_TWAP_E8=232000 A9_DIGEST=<64 hex> \
      acton script scripts/deploy/admin_op.tolk submit-candle 1 0
    # 暂停/恢复/技术终止
    acton script scripts/deploy/admin_op.tolk pause-oracle 0 1
    acton script scripts/deploy/admin_op.tolk resume-oracle 0 0
    # 一次性接线（部署后、开轮前）
    A9_TARGET_ADDRESS=<RC or TV> A9_JETTON_WALLET_ADDRESS=<wallet> acton script scripts/deploy/admin_op.tolk set-jetton-wallet 0 0
    acton script scripts/deploy/admin_op.tolk init-controller 0 0

#### 7.6.4 输出样例

dry-run（fund_ton <to> 20）：

    fund_ton:
      signer      = kQAAtEv...tBV_
      wallet name = treasury
      message:
      dest        = kQARERER...V2Z
      value       = 20000000000 nano
      body opcode = 0xd372158c
      message boc = 0xb79585b1...adee
      mode        = DRY-RUN (nothing broadcast)
      to execute  : re-run with --net testnet and OPS_EXECUTE=1 OPS_CONFIRM=YES

广播（本地 emulation 验证 trace）：

      mode        = EXECUTE
      broadcast accepted; waiting for trace...
      tx[0] hash = 0x6ac72749...0072
      tx[1] hash = 0x4b076c87...6d57

#### 7.6.5 错误与退出码

- 参数错误 / 未知 op / 缺地址 / 余额不足：打印可读错误，exit code = 1（不会静默广播）。
- OPS_EXECUTE=1 但未加 --net：报错 exit 1，提示本地开发可设 OPS_ALLOW_EMULATION=true。
- OPS_CONFIRM 不是 YES：拒绝广播。
- fund_jetton 广播前用 get_wallet_data 校验源钱包 A9 余额，并打印 owner -> expected wallet（get_wallet_address 与本地推导双校验）；fund_ton 校验 signer TON 余额（含 0.05 TON 余量）。

#### 7.6.6 ops 调用形式（供 testnet-ops 接线）

| ops 脚本 | 调用 |
| --- | --- |
| 50_fund_vaults.mjs | cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<name> JETTON_MASTER_ADDRESS=<master> acton script scripts/deploy/fund_jetton.tolk <toOwner> <amountRaw> --net testnet |
| 55_fund_ton.mjs | cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<name> acton script scripts/deploy/fund_ton.tolk <to> <amountTon> --net testnet |
| 80_admin_ops.mjs | cd contracts && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<name> ROUND_CONTROLLER_ADDRESS=<rc> acton script scripts/deploy/admin_op.tolk <op> <roundId> <extra> --net testnet |
| 80_admin_ops.mjs（K 线） | 在上一行基础上追加 A9_CANDLE_INDEX=<i> A9_PERIOD_START=<unix> A9_PERIOD_END=<unix> A9_TWAP_E8=<usd_e8> A9_DIGEST=<64hex>，op=submit-candle，extra=0 |

> Acton CLI flag（--execute/--from）不可用：--execute 用 OPS_EXECUTE=1 等价替代；--from 用 A9_SIGNER_WALLET 指定。与 ops 现有 OPS_EXECUTE/OPS_CONFIRM 习惯一致。

---

## 8. 测试

    cd contracts
    acton test                    # 144 passed in 14 files
    acton test tests/jetton.test.tolk
    acton test tests/settlement.test.tolk
    acton test -f 'technical abort'   # 按名字过滤
    acton check                   # lint：0 warning

### 8.1 覆盖矩阵（144 个用例）

| 需求 | 用例（文件） |
| --- | --- |
| V6.1 参数/零状态 | deploys with V6.1 params（round-controller） |
| 目标价锁定 | R1 2×P0；TWAP 高于阶梯；tier 1→2→3（invariants）；R10 = 1024×P0（10 轮） |
| 权限最小化 | OpenRound admin/oracle；SetJettonWallet 一次性；Retry admin-only；non-controller 拒绝 |
| 质押限额 | 首个存款人；20M 单地址边界；20M+1 拒绝；200M 总上限第 11 人拒绝；min stake/风险版本/acceptBurn/错轮退款；重复 nonce；窗口关闭退款；非 canonical wallet 拒绝 |
| 退款路径（原路退回） | 上述每类失败均断言 mock Jetton Wallet 的 transfer 次数/收款人 |
| K 线 | index 越界、period 不匹配、未收盘、重复、23 根不结算、24 根判定 |
| 成功结算 | 16/24 → SETTLING_SUCCESS → team release ack → Finalize → SUCCEEDED → PREVIEW 时间 |
| 奖励/领取 | reward 估算；claimAll 合并本金+奖励；重复 claimAll 幂等；ClaimPrincipal/ClaimReward 独立幂等 |
| 失败结算 | 15/24 → 3 笔 burn；缺 ack 不能 finalize；错误金额/非 master ack 拒绝；终态后重复 ack 幂等；失败轮不可领；同档重试 |
| 0 人质押 | 通过 → 奖励销毁 + team 释放；失败 → 仅 2 笔 burn，principal 自动确认 |
| 技术终止 | 暂停 14 天 → 任何人可触发、退本金、不销毁、不消耗档位；观察超时 7 天 |
| 暂停/恢复 | 恢复后重置 24 根完整窗口并可成功结算 |
| 触价提前关窗 | 低于目标拒绝；达标提前关窗；关窗后质押退款 |
| Jetton Master | 部署零供应/管理员；get_wallet_address 确定性；provide_wallet_address；mint 仅 admin、金额必须 100 亿、成功一次后 mintable=false/admin=null、二次 mint 拒绝；change_content/change_admin/claim_admin 权限 |
| Jetton Wallet | owner transfer 余额迁移与收款钱包部署；forward_payload/forward_ton_amount 原样透传（StakePayload 形状字节级一致）；非 owner/超额 transfer 拒绝；burn 扣余额并回 master 扣 total_supply；非 owner/超额 burn 拒绝；伪造 internal_transfer 拒绝；未知消息 0xFFFF |
| TeamVault | 部署/初始化权限；只认 RC；释放/销毁精确 1.2 亿；重复指令幂等；同轮互斥；1..10 边界；10 轮累计 12 亿 |
| 事件 | TargetPriceSet / DepositAccepted / RoundSettled / TeamReleased / TeamBurned 参数断言 |
| 跨轮 claimAll | 2 轮合并一笔；指定 roundId 只领该轮；10 轮全流程 + 第 11 轮拒绝 |
| V8 权重 | 连续 1/2/3/5/10 轮 = 1.10/1.20/1.30/1.50/2.00×；断轮清零；滚存不断 streak；邀请 20% 与封顶；自邀/互绑/二次绑定拒绝；低于 1 万不计 |
| V8 三态 | PENDING→ROLLED（含 20M/200M 截断）；PENDING→EARLY（50%）；互斥幂等；滚存后下一轮失败随本金销毁；R10 前 ClaimUnlocked 拒绝；R10 后 1/12 每月线性；早领罚没计入解锁池；**旧 ClaimReward 只付 50%、旧 ClaimAll 本金 100% + 奖励 50%** |
| V8 不变量 | 等权重 Σ reward == 700M；3 组权重 Σ ≤700M 且余数<3；roll+locked == 全额奖励；滚存 ≤200M |
| P0-1 权限 | 非 admin/oracle 的 SubmitCandle / CloseStaking 均 NotOracle，且不写入状态；admin 正常 |
| P0-2 销毁确认 | 失败轮通过 Jetton Master 的 ReturnExcessesBack（编码 round/kind）完成 reward+principal 确认并 finalize；错误发送者/错误 round 不确认 |
| P0-3 领取回滚 | principal / reward(50%) / claimAll / unlock 的 bounce 均完整回滚（标记、locked、folded rewards），可重试；ReturnExcesses 清除 pending |
| TeamVault burn 闭环 | TV burn 先 pending、不发 ack；jettonMaster 的 ReturnExcessesBack 到达后才 ack/累计；bounce 清 pending 不 ack、可重试 |
| 审计 F-01~F-06 | unlock 双 bounce 不膨胀 locked（相对扣减 + per-owner pending 互斥）；retry 用规范 burn queryId 且不重发在途 burn；bounce 清 dispatched；0.1 TON burn 回传；零额度 roll 保持 PENDING；邀请人后加仓/后滚存 O(1) 补 bonus |
| 审计 F-07~F-09 | Roll/早领后 get_reward_state 仍返回全额 amountRaw 且 rollable 仅 PENDING；ClaimAll 早领补 RewardEarly 事件；空地址 SetReferrer/SetJettonWallet（RC/TV）被拒且不写状态 |
| 架构 M-1/S-3 | 自然到期关窗无权限、提前关窗仍需权限；PREVIEW/STAKING_OPEN 超时可由任何人 abort 并领回本金；TV release pending→ReturnExcesses 确认/ack，bounce 清 pending 可重试、成功后重复调用幂等 |
| P0 v2 真合约集成 | 真 JettonMaster/JettonWallet：成功轮 release ack→SUCCEEDED、ClaimPrincipal/ClaimRewardEarly pending 清零；失败轮三笔销毁确认→FAILED_PERMANENT；10 轮后 ClaimUnlocked 真 ReturnExcesses 结算 |
| P0 v2 / P1 / P2 单测 | 非 owner 钱包的 ReturnExcesses 不能清 pending；retry 无权限且 <0.3 TON 拒绝；每轮仅 1 次 pause；pending release 与 burn 冲突；transfer value 0.1 TON |
| ops getters | RC get_jetton_wallet_code_hash 写入前返回 0、写入后等于 code hash；TV get_team_wallet_jetton_wallet 写入前后值正确 |
| OracleAdapter | 3/5 验签 Open/Close/Candle 转发字段逐字段一致；2/5、重复 signer、错链 chainId、过期 timestamp、重放、candleIndex 非单调均拒绝；SetSignerSet 权限/版本、SetController 一次性、SetAdmin、getter |

### 8.3 V8 gas 实测（Acton emulation，gas units；按主网 gas price 400 nanotons/unit 估算）

| 操作 | gas units | 约 TON（仅 compute） |
| --- | --- | --- |
| 质押入账（含 streak/weight/referral） | 22,822 | ~0.0091 |
| RollReward | 27,763 | ~0.0111 |
| ClaimRewardEarly（含 pending 记录） | 18,186 | ~0.0073 |
| ClaimReward（legacy，50% + pending） | 16,623 | ~0.0066 |

> 均为 O(1) 路径（无用户遍历），与用户数无关；消息额外附带 0.2~0.3 TON 用于转发与金库操作。

### 8.2 测试基础设施

- tests/test-utils.tolk：setupProtocol() 一次性部署 TeamVault + RC + 两个 Mock Jetton Wallet + 依赖注入（SetJettonWallet/InitController）；advance(seconds) 时间旅行；submitAllCandles 造 24 根 K 线；runSuccessRound 跑完整成功轮。
- MockJettonWallet **仅测试夹具**：记录最近一次 transfer/burn 的收款人/金额并扣减余额，用于断言退款、领取、销毁；不参与生产部署。
- 注意：emulation 的初始时间为 0；testing.setNow 必须**在部署前**设为基准时间（如 1,000,000），否则第一笔交易会为“0 → 当前时间”的存储租金失败（-669）。setupProtocol() 已处理。

---

## 9. 与文档的差异 / 工程裁决（需 reviewer 知悉）

1. **单地址限额**：docs/00 V6.1 原文“单地址 ≤ 本轮总质押 10%”对**首个存款人不可实现**（他必然 100%）。经 lead 裁决，实现为**固定硬顶 20,000,000 A9**（= maxTotalStakeRaw × maxStakePerAddressBps / 10000），同时保留本轮总上限 200,000,000 A9；docs 已同步为固定硬顶口径。ABI 中的 maxStakePerAddressBps=1000 仅作为该硬顶的推导参数保留；合约**不做** min(20,000,000, 本轮当前总质押×10%) 的动态校验（首个存款人可为 100%，已有测试覆盖）。
2. **低于 16 根达标**：旧口径（V6.2 前）只写 >=12 成功 / <=6 失败，中间态会永久卡住。经 lead 裁决 **24 根齐备后 <16 即失败（无中间态）**，docs 已修正；实现与测试按此。
2b. **Jetton 实现来源**：Acton 官方 jetton 模板（TEP-74/89）为骨架，A9 侧改造为 mint-once（op 0x15，32-bit 0x00000015）+ admin 置空；wallet 保留官方安全校验（canonical wallet / bounce / gas）。standard burn_notification 为 0x7bdd97de，对 task 文本中的 0x7bcdEFA0 额外接受为别名，但 wallet 实际发送标准 0x7bdd97de。
2c. **Acton CLI 位置参数**：acton script 只按 main() 类型位置传参，不支持 --flag；ops 模板需相应调整（见 §7.3）。
3. **StakeDeposit 位宽**：最终采用 lead 定稿 acceptFullPrincipalBurn: uint8（136 bit），不是早期讨论的 1 bit；docs/04 §19 已同步。
4. **Vault 合并**：docs/04 的 StakingVault / RewardVault 是**逻辑模块**，不是独立部署地址；V6.1 自研面只有 RC + TV。ClaimPrincipal/ClaimReward/ClaimAll 均发给 RC，质押 transfer 的 owner/recipient 也是 RC。
5. **Burn ack 信任模型（主网阻塞项）**：标准 TEP-74 无 burn ack。当前实现要求 BurnAck 来自 config 的 jettonMaster 地址（测试网由部署方充当 ack 权威）；TeamVault 的 team burn 由其自身 ack。**主网前**必须二选一：① 在自有/受审计 Jetton Master 中加最小 burn ack 扩展；② 采用 docs/00 #13 的“标准 burn + 链下对账 + 单密钥 owner 确认”。不能把普通 keeper 消息当销毁证明。
6. **开窗 TWAP 来源（主网阻塞项）**：OpenRound.twap24hUsdE8 目前由 admin/oracle 交易传入（测试网手动模式，docs/03/04 允许）；价格可被操作。主网前必须接入 OracleAdapter 签名验证，或把 TWAP 写入改为受签名保护的独立消息。
7. **晚开窗兜底**：若 keeper 错过整个 36h 窗口，OpenRound 会把 stakeOpenAt 重锚为 now（避免轮次死锁）。这与“stakeOpenAt 严格由结算时间推导”有偏差，属于 liveness 兜底；ops 必须监控三个倒计时（task-6），正常路径不会触发。
8. **技术终止后创建下一轮**：终止后创建下一轮 PREVIEW（tier 不变），保持 10 轮节奏；docs 未明确，按“不消耗档位 + 可继续”实现。
9. **事件**：采用 external-out log（TEP 风格），不是内部消息；索引器/前端按 opcode + 发送者过滤。
10. **不做**：OracleAdapter（二期）、多签、Lockup/Vesting、治理/回购、取消质押（按 V5.3）。

V8（docs/17）实现中必须自行拍板/说明的点：

11. **Σ reward 精确 700M 与 O(1) 惰性派发的矛盾**：docs/17 §5.18 要求 Σ reward 精确 700M，但「结算/领取不遍历用户」+「按 weight 惰性计算」在数学上无法把 floor 余数分给某个用户（不知道全局和）。实现选择：**floor + 余数留金库**；等权重时精确 700M，一般情形 Σ ≤700M（余数 < 用户数），不超发。若必须链上精确 700M，需要改回结算时遍历或引入可证明的余数分配机制（会增加 gas/复杂度）。
12. **旧 ClaimReward/ClaimAll 已按 V8 收紧（lead 拍板）**：奖励部分在阶梯期一律按 EARLY 语义只付 50%，另一半进入锁定池；**ClaimPrincipal 仍 100% 全额**（赢后退本金是承诺）。R10 解锁开始后旧 ClaimReward 拒绝（RewardStateLocked），必须用 ClaimUnlocked。旧 ClaimAll 会把本金 100% + 奖励 50% 合并成一笔转账。ABI/字段未变。
13. **解锁时长**：采用 12 × 30 天 = 31,104,000 秒（正好每月 1/12）；若要求自然年 365 天，改一个常量即可。
14. **get_unlock_info(owner)**：get 方法无法知道调用者，docs/17 §4.3 的无参签名不可实现，改为显式 owner 参数（新增 ABI，旧接口未变）。
15. **Roll 截断的剩余部分**：同一 (user,round) 只有一个 rewardState，无法同时表示「部分 ROLLED + 部分 PENDING」；实现为 state=ROLLED，超出上限部分进入锁定池（效果等同 PENDING，R10 后线性解锁）。
16. **邀请加成时点**：严格按 docs/17 §4.7 增量公式，用「入账当时邀请人本轮质押额」计算 room；若邀请人之后才加仓，不追溯补 bonus。
17. **同轮多次质押的 streak**：严格按「lastRound==r-1 ? +1 : 1」会把同轮第二笔重置为 1，实现改为同轮保持当前 streak（否则多笔入账会自损权重）。
18. **第 10 轮失败/技术终止**：unlockStart 在 R10 任一终态写入（含 FAILED_PERMANENT / TECHNICAL_ABORTED），避免锁定池永远无法解锁。

P0 安全修复（task-22，外部审查）——修复前后行为差异：

19. **P0-1 权限缺失**：修复前 CloseStaking / SubmitCandle 无任何 sender 校验，任何地址可伪造 K 线 TWAP 决定 7 亿瓜分或全员本金销毁、也可伪造触价提前关窗；修复后两者均 requireAdminOrOracle，非授权直接抛 NotOracle 且不改状态。StartObservation / AbortTechnical 仍保持任何人可调用（设计意图）。**影响：测试网手动 K 线必须由 admin/oracle 钱包提交，ops 脚本已使用 admin 签名。**
20. **P0-2 BurnAck 权威不存在**：修复前 RC 等一个 Jetton Master 永远不会发的 BurnAck，真实失败轮永久卡在 SETTLING_FAILURE；修复后 burn 的 response_destination 改为 RC 自身、queryId 编码 (roundId<<16 | kind<<8)，真实 Master 的 ReturnExcessesBack(0xd53276db) 即视为销毁确认（BurnAck 保留兼容现有测试/未来扩展）。**team 闭环（task-23）**：TV burn 改为 response_destination = TV 自身、pendingBurnIds 记录 burnId，只有 jettonMaster 的 ReturnExcessesBack 到达后才置 burned/累计并回 TeamBurnedAck；bounce 清 pending 不 ack、可重试。

22. **已知异常路径（残留 #2，本次不改）**：非法质押的退款转账失败若 bounce，没有 pending 记录可回滚；资金仍留在 RC Jetton Wallet（未记账），需 admin/ops 手工重发退款。

23. **瘦身（task-23）**：删除废弃 get_round_candle（ABI 经 lead 明确允许）、未引用常量、CandleRecord 类型；合并 ClaimReward/ClaimRewardEarly 为 payEarlyReward（ClaimAll 复用 applyEarlyReward）、BurnAck/ReturnExcesses 为 confirmBurn；格式化压缩。RoundController 1973 → 1,744 行；opcode/body/get 签名未变（仅删除 get_round_candle）。审计修复后为 1,834 行。

外部审计批次 1+2（task-24）——六条已修复，逐条记录修复前后行为：

24. **F-01（P0）ClaimUnlocked 回滚绝对快照导致 locked 双花**：修复前 UNLOCK 回滚把 lockedRaw 直接置为 lockedBefore，q1/q2 双 bounce 可把 locked 从 0 置回 F，配合仍为 PENDING 的 stakes 再折叠出 2F，循环抽干共享钱包。修复后：① UNLOCK 回滚改为相对扣减 lockedRaw -= lockedDeltaRaw；② LockedState 增加 pendingQueryId，同一 owner 有未确认 claim 时新的 Claim/ClaimUnlocked/RollReward 一律抛 ClaimPending（settle/bounce 清零）。测试：F-01 unlock double-bounce cannot inflate locked pool、F-01 pending claim blocks a second claim and roll。
25. **F-02（P1）RetryPendingActions reward burn 残留旧代码**：修复前 reward burn 用 msg.queryId + admin 作为 response destination，RC 永远收不到 ReturnExcessesBack。修复后统一为 burnQueryId(round, BURN_QUERY_REWARD) + contract.getAddress()。测试：F-02 retried reward burn uses canonical queryId and confirms、F-02 retried principal burn uses canonical queryId and confirms。
26. **F-03（P1）burn 无 dispatched 标记导致 retry 双倍销毁**：修复前 settle 后确认前 retry 会再发一次 burn，旧测试甚至断言 burnCount==4。修复后 RoundData 增加 rewardBurnDispatched/principalBurnDispatched，settle 发送时置 true，retry 仅在 !confirmed && !dispatched 时重发；onBouncedMessage 处理 OP_JETTON_BURN，按 queryId 清对应 dispatched。测试：F-03 retry does not resend in-flight burns、F-03 burn bounce clears dispatched and allows exactly one resend；原 invariants 用例的 burnCount 从 4 改回 2。
27. **F-04（P1）burn 确认可能被静默丢弃**：修复前 sendJettonBurn 仅 0.05 TON，JettonMaster 用 SEND_MODE_IGNORE_ERRORS 发 ReturnExcessesBack，余额不足时静默丢消息 → 永久死锁。修复后 burn value 提到 0.1 TON、excesses 改为 CARRY_ALL_REMAINING_MESSAGE_VALUE | BOUNCE_ON_ACTION_FAIL、calcMinimalBurnAmount 计入回传那一跳的转发费。测试：F-04 burn carries 0.1 TON for the confirmation hop。
28. **F-05（P1）零额度 RollReward 仍置 ROLLED**：修复前 rollAmount==0 时仍把奖励标 ROLLED、断 streak、锁死奖励并丧失早领权。修复后计算完 rollAmount 即 assert rollAmount > 0 throw RollNotAvailable，状态保持 PENDING。测试：F-05 zero-room roll keeps PENDING and early-claim right；原有两条 20M/200M 截断用例改为断言失败且 PENDING。
29. **F-06（P1）邀请人后加仓/后滚存不补 bonus**：修复前 bonus 只在被邀请人入账时按当时 ownStake 计算。修复后在 deposit 与 roll 两条路径对「本人作为邀请人」做 O(1) 差额补齐：target = min(20% * referred, ownStakeAfter)，target > current 时补差额并同步 totalWeight。测试：F-06 referrer later stake tops up own bonus、F-06 referrer roll tops up next-round bonus。

外部审计批次 3（task-25）——最后三条已修复：

30. **F-07 get_reward_state 语义 + 除法写法**：修复前用户 Roll/早领后 rewardClaimed=true，get_reward_state 的 amountRaw/earlyAmountRaw 全变 0，前端/索引器无法展示已赢金额。修复后只要 round SUCCEEDED 就返回全额 amountRaw；rollableRaw 仍仅在 state==PENDING 且未领取时非零；earlyAmountRaw = amount/2。另将 roll 路径的 rawAdd 从 rollAmount / (10000/REFERRAL_BPS) 统一为 referralRawAdd(amount) = amount * REFERRAL_BPS / 10000，与 deposit 路径一致（bps 非 2000 时不再有整数截断偏差）。测试：F-07 reward state keeps full amount after roll / after early claim、F-07 roll referral uses unified multiplication formula。
31. **F-08 ClaimAll 早领不发 RewardEarly**：修复前 ClaimAll 走 applyEarlyReward 但不发事件，索引器漏记 50% 进解锁池。修复后每个发生早领的轮次补 emit RewardEarly{roundId, owner, paidRaw, lockedRaw}，与 ClaimRewardEarly 完全一致。测试：F-08 ClaimAll emits RewardEarly for the early-claimed round。
32. **F-09 空地址校验缺失**：修复前 SetReferrer 未校验 referrer 为空、SetJettonWallet（RC/TV）未校验 wallet 为空。修复后三处均 assert(addr != createAddressNone()) throw BadConfig，避免一次性邀请关系/钱包地址被写成空值。说明：消息结构字段为内部 address，空地址在解码阶段就会被拒绝（测试用原始 addr_none body 验证 exit 9 且状态不变）；新增 assert 是对未来/非标准编码的纵深防御。测试：F-09 empty SetReferrer is rejected and leaves no binding、F-09 empty RC SetJettonWallet is rejected、F-09 empty TeamVault SetJettonWallet is rejected。

外部架构评审（task-26）——两条主网阻断项已修复：

33. **M-1（主网阻断）PREVIEW / STAKING_OPEN 无逃生舱**：修复前 CloseStaking 必须 admin/oracle，PREVIEW 只能靠 OpenRound 推进，AbortTechnical 又不覆盖 PREVIEW/STAKING_OPEN → 管理员失联即永久锁死本金，且到不了 R10、unlockStart 永远为 0。修复后：① CloseStaking 在 now >= stakeCloseAt（36h 自然到期）时**任何人可调**，提前触价关窗仍 requireAdminOrOracle 且校验 twap；② AbortTechnical 增加 PREVIEW 超时（stakeOpenAt + techAbortPauseSeconds，reason 新增 ABORT_REASON_PREVIEW_TIMEOUT=3）与 STAKING_OPEN 兜底（stakeCloseAt + techAbortObsTimeoutSeconds）。**实现说明**：本设计中 currentRoundId 只会在 OpenRound 后指向 STAKING_OPEN，PREVIEW 永远是「下一轮」；因此除规范分支外，当当前轮已 terminal 时，AbortTechnical 还会在下一轮 PREVIEW 超时后把 currentRoundId 推进到该轮并置 TECHNICAL_ABORTED，使滚入本金可 ClaimPrincipal、并最终到达 R10 写 unlockStart（否则规范分支不可达、M-1 仍无法闭环）。测试：M-1 natural staking close is permissionless、M-1 early close still requires admin/oracle + twap、M-1 PREVIEW timeout escape releases rolled principal、M-1 STAKING_OPEN fallback can be aborted after timeout。
34. **S-3（P1）TeamVault ReleaseTeamQuota 无 bounce 回滚**：修复前 TV 在发出 transfer 的同一笔交易里置 released=true 并发 ack，转账 bounce 后 1.2 亿永久锁死。修复后 ReleaseTeamQuota 改为 pending 语义（rounds 记录 queryId/amount，先不 ack/不累计），等待 TV Jetton Wallet 的 ReturnExcessesBack 再置 released、累计并发 TeamReleasedAck；onBouncedMessage 增加 OP_JETTON_TRANSFER 分支，bounce 时清 pending、不 ack、可重试；成功后重复 ReleaseTeamQuota 仍幂等只重发 ack。测试：S-3 release confirms through ReturnExcesses and acks、S-3 release bounce clears pending and can be retried、S-3 release duplicate after success is idempotent。

> ABI 未变：opcode/body/get 签名均不变；AbortTechnical 的 reason 是既有 uint8 字段，新增枚举值 3；S-3 仅内部状态机。合约自此冻结，交 delta 复审后上测试网。

P0 v2 / P1 / P2（task-27，delta 复审）——用真 Jetton 合约补集成测试后修复：

35. **P0（必现）ReturnExcessesBack 发送方校验错误**：真实 TEP-74 的 excess return 由**接收方的 Jetton Wallet** 发出（两跳），旧代码却校验 RC/TV 自己的钱包 → 用户首次领取后 pendingQueryId 永不清零、TV release 永远收不到确认（RC 卡 SETTLING_SUCCESS）。修复：RC 新增一次性 admin SetJettonWalletCode(0x5254001B) 存 JettonWallet code；handleReturnExcesses 按 queryId 取出 pending.owner，用 calcAddressOfJettonWallet(owner, jettonMaster, code) 推导期望 sender 并 settle；保留原钱包兼容分支。TV 新增 SetTeamWalletJettonWallet(0x5254001C) 存 teamWallet 钱包地址，release 确认校验该地址（兼容旧钱包分支）。deploy-emulation 已加入两笔一次性配置。**新增 3 个真 Jetton 合约集成测试**（成功轮 release ack + principal/early 领取、失败轮三笔销毁、10 轮 ClaimUnlocked），全部通过，证明真实两跳 ReturnExcessesBack 被正确接受。
36. **P1-1 转账 value/确认丢失**：sendJettonTransfer/sendTrackedJettonTransfer value 0.05→0.1；JettonWallet 的 ReturnExcessesBack 去掉 SEND_MODE_IGNORE_ERRORS，改 BOUNCE_ON_ACTION_FAIL；calcMinimalTransferAmount 计入回传转发费。测试：P1-1 release transfer carries 0.1 TON。
37. **P1-2 RetryPendingActions 管理员单点**：放开为无权限（任何人可付 gas 推进 SETTLING_*），入口要求 in.valueCoins >= 0.3 TON。测试：P1-2 retry is permissionless with enough value / retry below 0.3 TON is rejected。
38. **P2-1 PauseOracle 无限重置超时**：RoundData 增加 pauseCount，每轮最多 pause 1 次。测试：P2-1 second pause in the same round is rejected。
39. **P2-2 TV pending release 与 burn 竞态**：BurnTeamQuota 遇到 pending release（kind=RELEASE_QUERY_TEAM）抛 TeamRoundConflict。测试：P2-2 burn during pending release conflicts。

> ABI 新增：RC 0x5254001B SetJettonWalletCode、TV 0x5254001C SetTeamWalletJettonWallet；存储新增 ProtocolVaults.jettonWalletCode、TeamVault.extra、RoundData.pauseCount。合约冻结，交 delta 复审后上测试网。

40. **ops 部署可验证性（task-30，只读）**：补 RC get_jetton_wallet_code_hash(): uint256（未写入前返回 0，写入后返回 code cell hash）与 TV get_team_wallet_jetton_wallet(): address。未在 admin_op.tolk 增加 set-jetton-wallet-code / set-team-wallet-jetton-wallet：测试网统一走「整体 deploy-emulation（已内置两笔 wiring）→ 65 --query-only 登记 → 70 InitController」；stepwise 65 路径不再用于这两笔 wiring。无任何业务逻辑改动。
21. **P0-3 领取无回滚**：修复前先置 claimed+save 再 NoBounce 转账，失败即永久丢失；修复后领取转账 bounceable、send_excesses 回 RC，pending claim 以全局唯一 queryId 记录；bounce 时回滚 principal/reward/claimAll/unlock 的标记与 locked 金额，成功时由 ReturnExcessesBack 清除 pending。**影响：领取失败可安全重试；每条领取多一次 pending map 读写（gas 见 §8.3）。refund 转账仍为非托管路径（失败时金额仍在 RC 钱包，不涉及已置位领取标记），本轮未改。**

---


### 9.1 v8.6 审计修复批（C-1~C-4，合约冻结）

> 完整描述与测试清单见 **docs/18 §14**；本节只记录实现口径。

- **C-1 滚存截止时间**：`RollReward` 进入 `STAKING_OPEN` 分支时新增 `assert(now < nextRd.stakeCloseAt) throw RollNotAvailable`，不依赖 keeper 及时关窗。测试：`C-1 roll into an expired open round is rejected`。**链上实测**：旧 v8.5 在 testnet-ops 关窗后 RollReward 返回 `accepted:true⟧B⟧（`ops/records/fasttest-runner-2026-11-05T16-17-19-990Z.jsonl` 的 `defect-roll-after-close`）；新实例必须 `accepted:false`。
- **C-2 OracleAdapter 首根 K 线**：索引以 `index+1` 存储（0 = 无记录），index 0 合法；转发前拒绝 `index >= 32`（uint8 自增前），错误码用 Adapter 自己的 `BadCandleOrder`（`c38b05a`）。测试 3 条（index 0 / 真 RC 序列 / index 255）。
- **C-3 转发失败回滚**：向 RC 转发前写 replay 标记；转发动作 bounce 时按 `forwardedQueryId` 精确回滚，允许重试。测试 2 条。
- **C-4 两跳 bounce 通知**：JettonWallet 第二跳 bounce 后向 owner 发 `TransferBounced`（新增 opcode），RC/TV 回滚 pending；owner 通知因 TON 不足发不出时，钱包侧仍完成 Jetton 余额回滚（`d90c57f`）。测试 4 条。

> **部署/运维**：`deploy-emulation.tolk` 支持**全新空链一条命令完整部署**（JettonMaster → mint 100 亿并永久关闭 → OracleAdapter/TeamVault/RoundController → 全套 wiring → RC 7e18 / TV 1.2e18 raw A9 注入 + 回读校验）。
> **JettonWallet 代码变更会导致所有 jetton wallet 地址变化，必须干净重部署，不能 resume。**

### 9.5 可信 burn ack（实现与链上实证）

**实际机制不是依赖外部 ack 合约，而是复用 TEP-74 的 `ReturnExcessesBack`：**
1. RC 发起 burn；
2. JettonMaster 处理后在 `ReturnExcessesBack`（`0xd53276db`）里回传该 queryId；
3. RC 校验 `sender == jettonMaster` 后置 `rewardBurnConfirmed / teamBurnConfirmed / principalBurnConfirmed`。

**加固链：**
- **v8.6**：`confirmBurn` 断言 `*BurnDispatched` —— 未派发则拒绝确认，防「先确认后派发」伪造；
- **v8.7 F1**：JettonWallet 限制 `sendExcessesTo == null || == owner`、JettonMaster 限制 `== burnInitiator`，封死伪造 `ReturnExcessesBack` 路径；同时禁止 0 金额 burn/transfer；
- TeamVault 的 team burn 由其自身 ack（同源校验），bounce 不回 ack、可重试。

**链上实证（v8.7 测试网）**：R2 / R5 / R8 三个失败轮的三笔销毁（reward / team / principal）全部 `confirmed=true`，且 `total_supply` 对应减少。

因此 §10 的「可信 burn ack」项**当前已闭环**；主网仍需按 `docs/29_MAINNET_CUTOVER.md` 做全新部署，并用 `verify_deployment` 回读确认标志。

## 10. 主网前阻塞项（从测试网升级必须处理）

- [ ] **OracleAdapter 签名验证**：替换 admin 传入的 twap24hUsdE8 / twap1hUsdE8 / 每根 K 线，防止价格操纵（docs/00 §3 #3、docs/03、docs/11 §7）。
- [x] **可信 burn ack（v8.7 已闭环，见 §9.5）**：RC 校验 jettonMaster 回传 queryId 后置确认；v8.6 未派发拒绝、v8.7 F1 封死伪造路径；R2/R5/R8 三笔销毁已联调确认。
- [ ] **第三方审计**：RoundController + TeamVault（资金安全核心：三笔销毁、claimAll、0 质押分支、权限边界、不可升级）。
- [ ] **Jetton 版本锁定**：官方 Jetton commit + 审计报告覆盖范围 + burn 行为核对（docs/11 §3）。
- [ ] **运营监控**：三倒计时、K 线缺失、burn pending、total_supply 对账（ops/ task-6）。
- [ ] **参数签字**：P0、限额、技术终止阈值由项目方书面确认后写入部署配置。

---

## 11. 复现清单（给验收方）

    cd contracts
    acton --version                  # 1.1.0
    acton build                      # 0 error
    acton check                      # 0 warning
    acton test                       # 144 passed in 14 files
    acton build --info               # 对照 §0 的 code hash
    acton script scripts/deploy-emulation.tolk   # 打印部署顺序与地址
    cat deploy/params.testnet.json   # V6.1 参数模板
    jq '.abi[] | select(.name|test("get_")) | .name' deploy/abi/RoundController.json
    jq '.abi[] | select(.name|test("get_")) | .name' deploy/abi/JettonMaster.json

> 本目录不修改 web/、worker/、shared/、docs/；ABI 变更以本 README + deploy/abi/*.json 为准，前端以 docs/04 §19 与本 README 对齐。


---

## 12. OracleAdapter（主网 M-2，独立新合约）

用途：把 **3/5 ed25519 多源签名**验证通过的 OpenRound / CloseStaking / SubmitCandle 原样转发给 RoundController。**RC 不改一行**：部署 RC 时把 config.addresses.oracle 指向 OracleAdapter 即可（RC 的 requireAdminOrOracle 认该地址）。

### 12.1 ABI

| Opcode | 消息 | 发送者 | 接收者 | Body |
| --- | --- | --- | --- | --- |
| 0x52540021 | SetSignerSet | admin | OracleAdapter | signers:cell, threshold:u8, chainId:u32, configVersion:u32 |
| 0x52540022 | SetOracleController | admin | OracleAdapter | controller:address（一次性） |
| 0x52540023 | SetOracleAdmin | admin | OracleAdapter | admin:address |
| 0x52540024 | SubmitSignedOpenRound | 任意提交者 | OracleAdapter | roundId:u8, twap24hUsdE8:u128, timestamp:u64, sigCount:u8, sigs:cell |
| 0x52540025 | SubmitSignedCloseStaking | 任意提交者 | OracleAdapter | roundId:u8, twap1hUsdE8:u128, timestamp:u64, sigCount:u8, sigs:cell |
| 0x52540026 | SubmitSignedCandle | 任意提交者 | OracleAdapter | roundId:u8, candleIndex:u8, periodStart:u32, periodEnd:u32, twapPriceUsdE8:u128, dataDigest:u256, timestamp:u64, sigCount:u8, sigs:cell |
| 0x52540028 | ResetRoundCandles | OA admin 或 RC | OracleAdapter | roundId:u8（恢复观察时清 OA candle 游标；RC 自动发 + admin 手动兜底） |

- signers:cell：inline s0,s1,s2:u256 + threshold:u8，并 ref 一个 cell(s3:u256, s4:u256)。
- sigs:cell：链式 node，每个 node = signerIndex:u8 + signatureHi:u256 + signatureLo:u256（+ ref 下一个 node）；最多 5 个，sigCount 指定实际数量（需 >= threshold）。Ed25519 signature 512 bits 由 hi/lo 还原。
- 转发消息与 ABI 表完全一致：OpenRound(0x52540001)、CloseStaking(0x52540002)、SubmitCandle(0x52540003)。

### 12.2 验签消息格式

hash = sha256( cell(
    domain = sha256("A9_ORACLE_ADAPTER_V1") : u256,
    chainId : u32,
    controller : address,
    action : u8,            // 1=OPEN, 2=CLOSE, 3=CANDLE
    roundId : u8,
    candleIndex : u8,       // Open/Close 为 0
    periodStart : u32,      // Open/Close 为 0
    periodEnd : u32,        // Open/Close 为 0
    twapUsdE8 : u128,
    ref cell(dataDigest : u256, timestamp : u64)
).hash() )

- 签名用 TVM isSignatureValid(hash, signature, publicKey)（CHKSIGNU），不自行实现 Ed25519。
- timestamp 必须落在 now +/- 300s。
- 防重放：每个 (roundId, OPEN/CLOSE) 只能成功一次；candleIndex 按 roundId 严格单调递增。

### 12.3 Storage

OracleAdapterStorage {
  config: Cell<OracleAdapterConfig { admin, controller: address?, chainId:u32,
                                     configVersion:u32, signers: Cell<OracleSignersPacked> }>
  usedMask: map<u8, u8>      // bit1=OPEN, bit2=CLOSE, bit3=CANDLE
  lastCandle: map<u8, u8>    // roundId -> last accepted candleIndex
}

### 12.4 Get methods

| 方法 | 返回 |
| --- | --- |
| get_config() | OracleConfigView{admin, controller, chainId, configVersion, threshold} |
| get_signer_set() | OracleSignerSetView{s0..s4, threshold} |
| get_used_actions(round_id) | OracleUsedActions{openUsed, closeUsed, lastCandleIndex} |

### 12.5 部署顺序

1. 部署 JettonMaster + TeamVault（不变）。
2. **先部署 OracleAdapter**（admin、chainId、初始 5 个 signer 公钥 + threshold；生产用 SetSignerSet 轮换）。
3. 部署 RoundController 时 oracle = OracleAdapter 地址（RC 代码不变）。
4. OracleAdapter.SetOracleController(rc)（一次性）。
5. 其余 wiring 不变（SetJettonWallet/SetJettonWalletCode/SetTeamWalletJettonWallet/InitController）。

> 测试网可用 admin/oracle 手动模式继续；主网必须走 OracleAdapter。deploy-emulation 已按上述顺序部署（RC oracle 指向 adapter），并写入 deploy/oracle-adapter.addr。
