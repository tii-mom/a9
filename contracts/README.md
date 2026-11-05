# A9 Protocol — 自研合约（RoundController + TeamVault）

**版本**：V6.1 实现基线（2026-11-05）
**范围**：仅 A9 协议的两个自研 TON 合约及其测试/部署模板。官方 Jetton（TEP-74）按 docs/11 复用，不在本目录重写。
**权威口径**：docs/00_DECISIONS_V2.md（V6.1）> docs/04_CONTRACT_ABI.md > 本 README。本 README 记录实现细节、ABI、部署模板与**与文档的差异/工程裁决**。

---

## 0. 一句话结论

- **工具链**：Acton 1.1.0 + Tolk（本机已安装；acton build / acton test / acton script 均可用）。
- **编译**：acton build 通过，0 error；acton check 0 warning。
- **测试**：acton test → **47 passed / 4 files**（链模拟，含时间旅行、跨合约消息、三笔销毁 ack、claimAll、10 轮全流程）。
- **合约代码哈希**（clean rebuild，Tolk code cell）：
    - RoundController：0xCA0FC4D44C78CBFF7FA5913F71A6B3C290BEBF3EF4D3ECA7EBF04388AD82C9B3
    - TeamVault：0xDDFEE8CA14B5104B7C73FBBC075953FDD729286E5CB67F90DB08DB5E502B09DD
- **ABI JSON**：deploy/abi/RoundController.json、deploy/abi/TeamVault.json（acton build 生成后复制；MockJettonWallet.json 仅测试用）。
- **部署参数模板**：deploy/params.testnet.json（含 14 个 V6.1 参数与地址占位符）；主网模板 deploy/params.mainnet.template.json（**当前 BLOCKED**，见 §10）。

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
    acton test               # 47 passed
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
    │   ├── RoundController.tolk       # 状态机 + 质押账本 + 目标价锁定 + 结算 + claimAll
    │   ├── TeamVault.tolk             # 12 亿团队额度；仅 RC 指令；按轮释放/销毁；幂等互斥
    │   └── mocks/MockJettonWallet.tolk# 测试夹具（非生产）
    ├── tests/
    │   ├── test-utils.tolk            # fixture、时间推进、质押/开轮/结算/领取 helper
    │   ├── team-vault.test.tolk       # 13 tests
    │   ├── round-controller.test.tolk # 16 tests（生命周期/限额/退款/晚开窗）
    │   ├── settlement.test.tolk       # 11 tests（成功/失败/0 质押/技术终止/暂停恢复）
    │   └── invariants.test.tolk       # 7 tests（事件/tier/跨轮 claimAll/重试/10 轮上限）
    ├── scripts/
    │   └── deploy-emulation.tolk      # 按顺序部署 TeamVault → RC → InitController，打印地址
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
| 1 | PREVIEW | 结算后 24h 预告期；stakeOpenAt = settledAt + 86,400；不能质押 |
| 2 | STAKING_OPEN | 报名 72h（可触价提前关窗）；接受 stake |
| 3 | STAKING_CLOSED | 关窗，等待 observationStart |
| 4 | OBSERVING | 18 根 × 4h K 线，阈值 12 |
| 5 | ORACLE_PAUSED | 预言机异常暂停；恢复时**重置完整 72h 观察窗口** |
| 6 | SETTLING_SUCCESS | 等待 TeamVault release ack（0 质押成功还需 reward burn ack） |
| 7 | SETTLING_FAILURE | 等待三笔 burn ack（reward / team / principal） |
| 8 | SUCCEEDED | 终态；可 claim；tier+1 |
| 9 | FAILED_PERMANENT | 终态；不可 claim；**tier 不变（同档重试）** |
| 10 | TECHNICAL_ABORTED | 技术终止终态；退 100% 本金；不销毁、不消耗档位 |

### 3.2 时间线（V6）

    T0 结算(SUCCEEDED/FAILED_PERMANENT) → PREVIEW 24h → STAKING_OPEN 72h
      → STAKING_CLOSED（observationStart = stakeCloseAt；提前关窗则 = 关窗时刻）
      → OBSERVING 72h/18 根 → qualified>=12 ? SETTLING_SUCCESS : SETTLING_FAILURE
      → (ack) → SUCCEEDED / FAILED_PERMANENT → 下一轮 PREVIEW

- **R1**：无 PREVIEW；OpenRound 交易中 stakeOpenAt = now。
- **目标价**：开窗时锁定 target = max(P0 × 2^tier, 2 × 开窗 24h TWAP)；tier = successCount + 1；成功才升档，失败同档重试（D-28）。
- **触价提前关窗**：报名期内 twap1h >= target 时 CloseStaking 立即关窗。
- **晚开窗兜底**：若 keeper 错过整个 72h 窗口（now >= previewEnd + 72h），OpenRound 会把 stakeOpenAt 重锚为 now，避免轮次永久卡死（工程兜底，见 §9）。
- **观察期判定**：18 根齐备后 qualified >= 12 成功，否则 SETTLING_FAILURE（**无 7~11 中间态**；docs/02 已同步修正）。
- **技术终止**（任何人可触发）：连续 ORACLE_PAUSED ≥ 14 天；或 STAKING_CLOSED/OBSERVING 且 now >= observationEnd + 7 天。

### 3.3 目标价公式与校验

    floor  = P0(116000 USD_E8) × 2^tier
    target = max(floor, 2 × twap24hUsdE8)        // twap 由 OpenRound 参数提供（测试网手动模式）

- 合约**不预存** 10 个价格；只存 p0UsdE8、priceMultiplier（不可变）、successCount（推导 tier）、每轮 targetPriceUsdE8/targetTwap24hUsdE8/targetWrittenAt。
- 任何人可离线用 P0 × 2^tier 校验链上锁定值；TargetPriceSet 事件携带 (roundId, tier, targetPriceUsdE8, twap24hUsdE8)。
- 阶梯参考（tier）：t1 232000 … t10 118,784,000 USD_E8（= $1.18784，与 docs/01 R10 一致）。

---

## 4. ABI（opcode / payload / get methods）

> 自定义 opcode 统一占用项目保留段 0x5254xxxx。下列为**实现定稿**；与 docs/04 §5/§19 对齐，新增项在 §4.4 标注。

### 4.1 自定义内部消息（用户/keeper/RC → 合约）

| Opcode | 消息 | 发送者 | 接收者 | Body 布局（op 之后） |
| --- | --- | --- | --- | --- |
| 0x52540001 | OpenRound | admin 或 oracle | RC | queryId:u64, twap24hUsdE8:u128 |
| 0x52540002 | CloseStaking | 任何人 | RC | queryId:u64, twap1hUsdE8:u128 |
| 0x52540003 | SubmitCandle | 任何人（测试网手动模式） | RC | queryId:u64, roundId:u8, candleIndex:u8, periodStart:u32, periodEnd:u32, twapPriceUsdE8:u128, dataDigest:u256 |
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

- ClaimPrincipal：SUCCEEDED 或 TECHNICAL_ABORTED 可领；每 (round, owner) 一次。
- ClaimReward：仅 SUCCEEDED；reward = floor(roundReward × myStake / totalStake)；每 (round, owner) 一次。
- ClaimAll：roundId=0 扫描 1..10（固定上界），一次同时领本金+奖励，**合并为一笔 Jetton 转账**；重复调用不重复派发；无可领金额时也成功返回（不发转账）。
- 本金与奖励都采用 pull claim，用户自付 gas（消息 value 建议 0.1 TON）。

### 4.4 RC → TeamVault / ack（内部，前端不要发）

| Opcode | 消息 | 发送者 | 接收者 | Body |
| --- | --- | --- | --- | --- |
| 0x5254000C | ReleaseTeamQuota | RC | TV | queryId:u64, roundId:u8 |
| 0x5254000D | BurnTeamQuota | RC | TV | queryId:u64, roundId:u8, burnId:u256 |
| 0x52540009 | BurnAck | jettonMaster（测试网 ack 地址） | RC | roundId:u8, kind:u8(1 reward/2 team/3 principal), amountRaw:u128, burnId:u256 |
| 0x52540013 | TeamReleasedAck | TV | RC | queryId:u64, roundId:u8, amountRaw:u128 |
| 0x52540014 | TeamBurnedAck | TV | RC | queryId:u64, roundId:u8, amountRaw:u128, burnId:u256 |

### 4.5 事件（external-out logs，TEP 风格）

| Opcode | 事件 | 发送者 | 字段 |
| --- | --- | --- | --- |
| 0x52540101 | TargetPriceSet | RC | roundId, tier, targetPriceUsdE8, twap24hUsdE8 |
| 0x52540102 | RoundSettled | RC | roundId, status, qualifiedCandles, candlesSeen, totalAcceptedStakeRaw, tierAfter |
| 0x52540103 | DepositAccepted | RC | roundId, owner, amountRaw, totalAcceptedStakeRaw |
| 0x52540104 | TechnicalAborted | RC | roundId, reason, at |
| 0x52540201 | TeamReleased | TV | roundId, amountRaw, to |
| 0x52540202 | TeamBurned | TV | roundId, amountRaw, burnId |

### 4.6 Get methods（只读）

| 方法 | 返回 |
| --- | --- |
| get_protocol_config() | 扁平 ProtocolConfigView（admin/oracle/jettonMaster/stakingJettonWallet/teamVault + 全部 14 个 V6.1 参数） |
| get_current_round() / get_success_count() | uint8 |
| get_round(round_id) | RoundView（状态、tier、目标价、TWAP、时间、K 线计数、总质押、flags、burnId） |
| get_round_status(round_id) | uint8 |
| get_round_target_price(round_id) | uint128（未开窗为 0） |
| get_round_candle(round_id, index) | CandleRecord（不存在返回全 0） |
| get_user_stake(round_id, owner) | StakePosition（amountRaw, lastDepositNonce, claimed flags） |
| get_round_total_stake(round_id) | uint128 |
| get_user_reward_estimate(round_id, owner) | uint128（仅 SUCCEEDED 有值） |
| get_claimable_all(owner) | Claimable{principalRaw, rewardRaw, roundsMask} |
| get_round_burn_status(round_id) | RoundBurnStatus{3 flags, failureBurnId} |
| TV get_team_vault_state() | controller/jettonWallet/teamWallet/teamRoundRaw/totalReleasedRaw/totalBurnedRaw/counts |
| TV get_round_state(round_id) | TeamRoundState{released, burned, amountRaw, queryId} |

> 前端读取注意：目标价在 PREVIEW/UNOPENED 期间为 0，显示“待开窗锁定”；roundsMask 的 bit i 对应 round i+1。

---

## 5. 存储布局（Tolk cell）

    RoundController.Storage {
      config: Cell<ProtocolConfig>          // 4 个 ref 分组，避免 1023-bit / 4-ref 上限
        addresses: admin, oracle, jettonMaster
        vaults: stakingJettonWallet, teamVault
        econ: p0UsdE8, priceMultiplier, roundRewardRaw, teamRoundRaw,
              minStakeRaw, maxStakePerAddressBps, maxTotalStakeRaw
        timing: preview/stake/candle/candleCount/minQualified/observation/
                techAbortPause/techAbortObsTimeout/riskDisclosureVersion/configVersion
      currentRoundId: u8, successCount: u8, lastSettledAt: u64, pausedAt: u64
      rounds: map<u8, RoundData>
      stakes: map<u8, map<address, StakePosition>>
    }

    RoundData {
      status:u8, targetTier:u8, targetPriceUsdE8:u128, targetTwap24hUsdE8:u128,
      targetWrittenAt:u64, rewardBudgetRaw:u128,
      stakeOpenAt/stakeCloseAt/observationStart/observationEnd/settledAt:u64,
      candlesSeen:u8, qualifiedCandles:u8, totalAcceptedStakeRaw:u128,
      teamReleaseConfirmed/teamBurnConfirmed/rewardBurnConfirmed/principalBurnConfirmed:bool,
      failureBurnId: Cell<u256>, candles: map<u8, CandleRecord>
    }

    TeamVault.Storage {
      config: admin, controller: address?, configVersion
      params: Cell<{jettonWallet, teamWallet, teamRoundRaw}>   // ref：地址环依赖 + 体积
      rounds: map<u8, TeamRoundState{released, burned, amountRaw, queryId}>
      totalReleasedRaw/totalBurnedRaw: u128, releasedCount/burnedCount: u8
    }

> 说明：stakingJettonWallet 因“Jetton Wallet 地址由 owner=RC 推导”存在地址环依赖，部署时先用占位地址，RC 部署后由 admin 调用一次 SetJettonWallet（0x52540016）；TeamVault 同理。两个 setter 都只能 admin 调用，且必须早于第一轮/Controller 初始化。

---

## 6. 结算流程

### 6.1 成功（含 team 释放）

1. 第 18 根 K 线提交后：qualified >= 12 → SETTLING_SUCCESS；发出 ReleaseTeamQuota(roundId)。
2. TeamVault 转 1.2 亿到 teamWallet，回 TeamReleasedAck → RC 置 teamReleaseConfirmed。
3. 任何人 FinalizeRound → SUCCEEDED；successCount += 1；创建下一轮 PREVIEW（stakeOpenAt = now + 24h）。
4. 用户按需 ClaimPrincipal/ClaimReward/ClaimAll；本金与奖励均留在 RC 的 Jetton Wallet，未领可跨轮累积。

### 6.2 0 人质押且通过（D-18b）

- SETTLING_SUCCESS + 发出 reward burn（7 亿）+ team release（1.2 亿）。
- 需 rewardBurnConfirmed && teamReleaseConfirmed 才能 FinalizeRound → SUCCEEDED；无任何领取记录。

### 6.3 失败（三笔销毁）

SETTLING_FAILURE 时 RC 发出：

1. AskToBurn（RC Jetton Wallet）→ reward 700,000,000 A9
2. AskToBurn（RC Jetton Wallet）→ principal totalAcceptedStakeRaw（0 人质押时直接标记 confirmed）
3. BurnTeamQuota → TeamVault 销毁 120,000,000 A9，回 TeamBurnedAck

三笔确认后 FinalizeRound → FAILED_PERMANENT；tier 不变，下一轮同档重试。重复 ack 幂等（终态后直接忽略）；缺 ack 时 admin 可 RetryPendingActions 重发未确认的 burn 指令。

### 6.4 技术终止

- 触发：ORACLE_PAUSED 连续 14 天，或观察结束超时 7 天；**任何人**可调用 AbortTechnical。
- 效果：TECHNICAL_ABORTED；本金 100% 可领；**不销毁** reward/team；**tier 不变**；创建下一轮 PREVIEW。

---

## 7. 部署

### 7.1 V6.1 参数（与 deploy/params.testnet.json 一致）

| 参数 | 值 | raw（decimals=9） |
| --- | --- | --- |
| p0UsdE8 | 116000（$0.00116） | — |
| priceMultiplier | 2×（不可变） | — |
| roundRewardRaw | 700,000,000 A9 | 700000000000000000 |
| teamRoundRaw | 120,000,000 A9 | 120000000000000000 |
| previewSeconds | 86,400（24h） | — |
| stakeDurationSeconds | 259,200（72h） | — |
| candleSeconds / candleCount | 14,400 / 18 | — |
| minQualifiedCandles | 12 | — |
| observationSeconds | 259,200（72h） | — |
| minStakeRaw | 10,000 A9 | 10000000000000 |
| maxStakePerAddressBps | 1000（10%，**解释为固定硬顶**，见 §9） | — |
| maxStakePerAddressRaw | 20,000,000 A9 | 20000000000000000 |
| maxTotalStakeRaw | 200,000,000 A9 | 200000000000000000 |
| techAbortPauseSeconds | 1,209,600（14 天） | — |
| techAbortObsTimeoutSeconds | 604,800（7 天） | — |
| riskDisclosureVersion / configVersion | 1 / 1 | — |

代币侧（Jetton，官方复用）：总量 100 亿；奖励池 70 亿（RC Jetton Wallet）、团队 12 亿（TeamVault Jetton Wallet）、内盘 8 亿、流动性 5 亿、营销 5 亿。

### 7.2 部署顺序（重要）

1. 部署 Jetton Master，铸造 100 亿，**关闭 mint 权限**。
2. 部署 **TeamVault**：jettonWallet 用占位地址（建议 admin），controller = null。
3. 部署 **RoundController**：teamVault = TV 地址，stakingJettonWallet 用占位地址。
4. 用 Jetton Master get_wallet_address(roundController) 得到 RC 的 canonical Jetton Wallet → admin 调 RC.SetJettonWallet(wallet)。
5. 同法得到 TV 的 Jetton Wallet → admin 调 TV.SetJettonWallet(wallet)。
6. admin 调 TV.InitController(roundController)（**一次性，之后不可改**）。
7. 给 RC Jetton Wallet 打 70 亿 A9；给 TV Jetton Wallet 打 12 亿 A9。
8. 给 RC ≥ 20 TON、TV ≥ 10 TON 作为 gas/存储；admin 调 OpenRound(round=1, twap24h) 开首轮。

### 7.3 脚本

    cd contracts
    # 本地模拟：按顺序部署 TeamVault → RC → InitController，并打印地址/参数
    acton script scripts/deploy-emulation.tolk
    # 等价：acton run deploy-emulation

    # 真实测试网（需 wallets.toml / 全局钱包已配置，且 Jetton Master 已就绪）
    acton script scripts/deploy-emulation.tolk --net testnet

输出示例（emulation）：

    A9 deploy params: ...
    TeamVault deployed at kQBGi6_w-5ecUCut2RvI3vjLd5HcfK5gGpEL6R8kGKP2xmut (TeamVault)
    RoundController deployed at kQA9Vk69WyYo9cwzypPoXJ4uNrkppjIRvrX-ySGzlGctjgxk (RoundController)

> 真正的链上部署/注资/轮次运营 SOP 由 **ops/**（task-6）承接；本脚本负责“合约部署顺序 + 地址计算 + 初始化校验”。

### 7.4 Jetton 交互（生产）

- RC/TV 发出的都是标准 TEP-74 transfer (0x0f8a7ea5) / burn (0x595f07bc)；金额为 raw（9 decimals）。
- 退款/领取均从合约自己的 Jetton Wallet 发出，response_destination = 收款用户；合约需保留 TON 余额支付转发费（每条指令约 0.05 TON）。
- 收到的 transfer_notification 采用官方格式 sender:MsgAddressInt（非 Maybe）。

---

## 8. 测试

    cd contracts
    acton test                    # 47 passed in 4 files
    acton test tests/settlement.test.tolk
    acton test -f 'technical abort'   # 按名字过滤
    acton check                   # lint：0 warning

### 8.1 覆盖矩阵（47 个用例）

| 需求 | 用例（文件） |
| --- | --- |
| V6.1 参数/零状态 | deploys with V6.1 params（round-controller） |
| 目标价锁定 | R1 2×P0；TWAP 高于阶梯；tier 1→2→3（invariants）；R10 = 1024×P0（10 轮） |
| 权限最小化 | OpenRound admin/oracle；SetJettonWallet 一次性；Retry admin-only；non-controller 拒绝 |
| 质押限额 | 首个存款人；20M 单地址边界；20M+1 拒绝；200M 总上限第 11 人拒绝；min stake/风险版本/acceptBurn/错轮退款；重复 nonce；窗口关闭退款；非 canonical wallet 拒绝 |
| 退款路径（原路退回） | 上述每类失败均断言 mock Jetton Wallet 的 transfer 次数/收款人 |
| K 线 | index 越界、period 不匹配、未收盘、重复、17 根不结算、18 根判定 |
| 成功结算 | 12/18 → SETTLING_SUCCESS → team release ack → Finalize → SUCCEEDED → PREVIEW 时间 |
| 奖励/领取 | reward 估算；claimAll 合并本金+奖励；重复 claimAll 幂等；ClaimPrincipal/ClaimReward 独立幂等 |
| 失败结算 | 11/18 → 3 笔 burn；缺 ack 不能 finalize；错误金额/非 master ack 拒绝；终态后重复 ack 幂等；失败轮不可领；同档重试 |
| 0 人质押 | 通过 → 奖励销毁 + team 释放；失败 → 仅 2 笔 burn，principal 自动确认 |
| 技术终止 | 暂停 14 天 → 任何人可触发、退本金、不销毁、不消耗档位；观察超时 7 天 |
| 暂停/恢复 | 恢复后重置 18 根完整窗口并可成功结算 |
| 触价提前关窗 | 低于目标拒绝；达标提前关窗；关窗后质押退款 |
| TeamVault | 部署/初始化权限；只认 RC；释放/销毁精确 1.2 亿；重复指令幂等；同轮互斥；1..10 边界；10 轮累计 12 亿 |
| 事件 | TargetPriceSet / DepositAccepted / RoundSettled / TeamReleased / TeamBurned 参数断言 |
| 跨轮 claimAll | 2 轮合并一笔；指定 roundId 只领该轮；10 轮全流程 + 第 11 轮拒绝 |

### 8.2 测试基础设施

- tests/test-utils.tolk：setupProtocol() 一次性部署 TeamVault + RC + 两个 Mock Jetton Wallet + 依赖注入（SetJettonWallet/InitController）；advance(seconds) 时间旅行；submitAllCandles 造 18 根 K 线；runSuccessRound 跑完整成功轮。
- MockJettonWallet **仅测试夹具**：记录最近一次 transfer/burn 的收款人/金额并扣减余额，用于断言退款、领取、销毁；不参与生产部署。
- 注意：emulation 的初始时间为 0；testing.setNow 必须**在部署前**设为基准时间（如 1,000,000），否则第一笔交易会为“0 → 当前时间”的存储租金失败（-669）。setupProtocol() 已处理。

---

## 9. 与文档的差异 / 工程裁决（需 reviewer 知悉）

1. **单地址限额**：docs/00 V6.1 原文“单地址 ≤ 本轮总质押 10%”对**首个存款人不可实现**（他必然 100%）。经 lead 裁决，实现为**固定硬顶 20,000,000 A9**（= maxTotalStakeRaw × maxStakePerAddressBps / 10000），同时保留本轮总上限 200,000,000 A9；docs 已同步为固定硬顶口径。ABI 中的 maxStakePerAddressBps=1000 仅作为该硬顶的推导参数保留；合约**不做** min(20,000,000, 本轮当前总质押×10%) 的动态校验（首个存款人可为 100%，已有测试覆盖）。
2. **7~11 根达标**：旧口径只写 >=12 成功 / <=6 失败，中间态会永久卡住。经 lead 裁决 **18 根齐备后 <12 即失败（无中间态）**，docs 已修正；实现与测试按此。
3. **StakeDeposit 位宽**：最终采用 lead 定稿 acceptFullPrincipalBurn: uint8（136 bit），不是早期讨论的 1 bit；docs/04 §19 已同步。
4. **Vault 合并**：docs/04 的 StakingVault / RewardVault 是**逻辑模块**，不是独立部署地址；V6.1 自研面只有 RC + TV。ClaimPrincipal/ClaimReward/ClaimAll 均发给 RC，质押 transfer 的 owner/recipient 也是 RC。
5. **Burn ack 信任模型（主网阻塞项）**：标准 TEP-74 无 burn ack。当前实现要求 BurnAck 来自 config 的 jettonMaster 地址（测试网由部署方充当 ack 权威）；TeamVault 的 team burn 由其自身 ack。**主网前**必须二选一：① 在自有/受审计 Jetton Master 中加最小 burn ack 扩展；② 采用 docs/00 #13 的“标准 burn + 链下对账 + 单密钥 owner 确认”。不能把普通 keeper 消息当销毁证明。
6. **开窗 TWAP 来源（主网阻塞项）**：OpenRound.twap24hUsdE8 目前由 admin/oracle 交易传入（测试网手动模式，docs/03/04 允许）；价格可被操作。主网前必须接入 OracleAdapter 签名验证，或把 TWAP 写入改为受签名保护的独立消息。
7. **晚开窗兜底**：若 keeper 错过整个 72h 窗口，OpenRound 会把 stakeOpenAt 重锚为 now（避免轮次死锁）。这与“stakeOpenAt 严格由结算时间推导”有偏差，属于 liveness 兜底；ops 必须监控三个倒计时（task-6），正常路径不会触发。
8. **技术终止后创建下一轮**：终止后创建下一轮 PREVIEW（tier 不变），保持 10 轮节奏；docs 未明确，按“不消耗档位 + 可继续”实现。
9. **事件**：采用 external-out log（TEP 风格），不是内部消息；索引器/前端按 opcode + 发送者过滤。
10. **不做**：OracleAdapter（二期）、多签、Lockup/Vesting、治理/回购、取消质押（按 V5.3）。

---

## 10. 主网前阻塞项（从测试网升级必须处理）

- [ ] **OracleAdapter 签名验证**：替换 admin 传入的 twap24hUsdE8 / twap1hUsdE8 / 每根 K 线，防止价格操纵（docs/00 §3 #3、docs/03、docs/11 §7）。
- [ ] **可信 burn ack**：见 §9.5；否则失败轮的“三笔销毁”无法链上自证。
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
    acton test                       # 47 passed in 4 files
    acton build --info               # 对照 §0 的 code hash
    acton script scripts/deploy-emulation.tolk   # 打印部署顺序与地址
    cat deploy/params.testnet.json   # V6.1 参数模板
    jq '.abi[] | select(.name|test("get_")) | .name' deploy/abi/RoundController.json

> 本目录不修改 web/、worker/、shared/、docs/；ABI 变更以本 README + deploy/abi/*.json 为准，前端以 docs/04 §19 与本 README 对齐。
