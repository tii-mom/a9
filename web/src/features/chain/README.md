# web/src/features/chain — TON 测试网真实交易（质押 / 领取 / V8 奖励三态 / 邀请）

把前端从「演示数据」升级为可对 TON 测试网合约发起真实交易。所有链上 UI / 交易逻辑都在本目录内；
对外通过 `index.ts` 暴露，页面侧挂 `<ChainMePanel />`（质押/领取）与 `<RewardReferralPanel />`（V8 奖励三态/邀请）。

```
chain/
├─ index.ts              # 对外导出（组件 / hooks / ABI 常量 / 工具）
├─ protocol.ts           # opcode、V8 常量、单位、gas、限额、事件 / get methods 名称
├─ payload.ts            # StakePayload / Jetton transfer / Claim / V8 早领·滚存·邀请·解锁 消息体
├─ cell.ts               # 自包含 TON Cell + BOC 序列化/解析 + CellSlice（无 @ton/core 依赖）
├─ address.ts            # 友好地址 ↔ raw、CRC16、base64
├─ decode.ts             # transfer_notification / Claim / V8 用户操作消息解码（回执校验）
├─ config.ts             # /api/config → ChainConfig（合约/网络/限额/V8 权重参数/浏览器/RPC）
├─ transactions.ts       # 前置校验 + TON Connect 消息构造（含 V8 四个新 opcode）
├─ rpc.ts                # Jetton Wallet 解析、toncenter 交易查询、回执轮询
├─ useChainTx.ts         # 交易状态机 hook（含 V8 submitRewardAction / submitSetReferrer / submitClaimUnlocked）
├─ rewards.ts            # V8 奖励三态 / 解锁 / 邀请 / streak 数据适配与兜底
├─ storage.ts            # 最近一笔交易本地记录
├─ i18n.ts               # 中英双语文案（含 V8）
├─ TxStatus.tsx          # 交易状态行
├─ ChainMePanel.tsx      # 质押 + 旧领取面板
├─ RewardReferralPanel.tsx # V8 奖励三态 + 解锁 + 邀请面板
└─ chain.css             # 样式（沿用 fuse.css 变量与 .panel/.btn 体系）
```

## 1. 消息 ABI（V8 定稿，与 contracts/README.md §4 对齐）

> ABI 来源：contracts/README.md §4.1 + contracts/deploy/abi/*.json（contract-dev，V8 code hash 0xFB5250EE…54C84，87 测试）。
> 自研合约只有 **RoundController + TeamVault**；质押 Jetton 的 owner、所有领取/奖励/邀请消息的接收方都是 **RoundController**。

### 1.1 质押：TEP-74 Jetton transfer（0x0f8a7ea5）

```
StakePayload（136 bit）
  op:uint32                      = 0x5254000F  STAKE_DEPOSIT
  version:uint8                  = 1
  roundId:uint8
  depositNonce:uint64            # 同一 (roundId, owner) 单调唯一
  riskDisclosureVersion:uint16   # = /api/config.riskDisclosureVersion
  acceptFullPrincipalBurn:uint8  # 必须为 1
```

Jetton transfer：destination=RoundController，response_destination=用户，forward_ton_amount=0.05 TON，消息附带 0.20 TON。

### 1.2 旧领取接口（语义按 V8 调整，opcode/字段不变）

```
ClaimPayload（104 bit）
  op:uint32        # ClaimPrincipal 0x52540006 / ClaimReward 0x52540007 / ClaimAll 0x5254000E
  queryId:uint64
  roundId:uint8    # ClaimAll 填 0 = 扫描 1..10
```

> V8：ClaimReward / ClaimAll 的奖励部分在阶梯期一律按 EARLY 语义只付 50%，另 50% 进 R10 后解锁池；ClaimPrincipal 仍 100%。R10 解锁开始后旧 ClaimReward 拒绝。

### 1.3 V8 新增 4 个 opcode（用户 → RoundController）

| Opcode | 消息 | Body 布局（op 之后） | 位宽 | 说明 |
| --- | --- | --- | --- | --- |
| 0x52540017 | ClaimRewardEarly | queryId:u64, roundId:u8 | 104 | 立即领 floor(amount/2)，另一半进解锁池 → EARLY |
| 0x52540018 | RollReward | queryId:u64, roundId:u8 | 104 | 全额进入下一轮质押 → ROLLED（受 20M/地址、200M/轮上限，超出转 PENDING） |
| 0x52540019 | SetReferrer | referrer:MsgAddress | 299 | 首次质押前绑定邀请人，一次性不可改 |
| 0x5254001A | ClaimUnlocked | queryId:u64 | 96 | R10 终态后按 12×30 天线性领取解锁池 |

消息附带 0.10 TON；三者均发送到 RoundController。构造函数：`buildClaimRewardEarly / buildRollReward / buildSetReferrer / buildClaimUnlocked`（在 payload.ts）。

### 1.4 事件与 get methods（常量已登记，当前 UI 数据仍走 worker API）

- 事件 opcode：TargetPriceSet 0x52540101、RoundSettled 0x52540102、DepositAccepted 0x52540103、TechnicalAborted 0x52540104、TeamReleased 0x52540201、TeamBurned 0x52540202；V8 新增 RewardRolled 0x52540105、RewardEarly 0x52540106、ReferrerSet 0x52540107、UnlockClaimed 0x52540108。
- RC get methods：get_protocol_config / get_current_round / get_success_count / get_round / get_round_status / get_round_target_price / get_round_candle / get_user_stake / get_round_total_stake / get_user_reward_estimate / get_claimable_all / get_round_burn_status；V8 新增 get_reward_state / get_unlock_info / get_referral / get_streak / get_user_weight / get_total_weight。
- 目标价在 PREVIEW/UNOPENED 期间 getter 返回 0，UI 显示「待开窗锁定」。

## 2. 交易构造与发送

- **Jetton Wallet 解析**：本地缓存 → tonapi `/v2/accounts/{owner}/jettons` → toncenter `runGetMethod get_wallet_address`（raw / friendly / address-cell BOC 三种编码兜底）。
- **发送**：复用 wallet 模块的单实例 TonConnectUI（`sendTonConnectTransaction`）；消息带 network（testnet=-3 / mainnet=-239）与 from（raw 地址）。
- **BOC**：payload 为自包含 Cell/BOC 序列化（无 index/CRC），标准 base64 传给 TON Connect。
- **回执轮询**：合约侧匹配（质押用 transfer_notification 的 depositNonce；领取/奖励/邀请/解锁用 in_msg.source + opcode + roundId + **queryId** + referrer），30s 仅见钱包外部交易时标记「已上链等待合约回执」，超时给可重试 TX_TIMEOUT。

## 3. 状态机

`idle → preparing → awaiting-signature → sent → confirming → confirmed`；异常分支 rejected / failed。

支持交易种类：stake、claimPrincipal、claimReward、claimAll、claimRewardEarly、rollReward、setReferrer、claimUnlocked。

**P0 FIX-5（回执误判成功）**：回执判定拆成两步——① `matchesUserAction` 只做身份匹配（inSource + op + roundId + **本次 queryId** + referrer）；② `isSuccessfulTx` 做执行成功判定（aborted=false、bounced=false、exitCode=0/null）。身份命中但执行失败（例如 ClaimPending=270）的 tx 返回 `stage='failed'`，由 `exitCodeError()` 映射为 `CONTRACT_REJECTED`（detail 形如 `exit_code=270 (ClaimPending)`），不再置 confirmed、不再持久化成功回执。质押沿用 depositNonce 身份匹配，但同样经过 `isSuccessfulTx` 成功门。早于本次 `sinceSec` 的旧失败 tx 不会上报（避免把上一笔失败当成本次失败）。

## 4. 配置来源（/api/config）

启用条件：contracts.roundController 与 contracts.jettonMaster 均非空，且 network 为 testnet/mainnet；否则整体降级为演示模式。

V8 权重/三态参数（shared/types ProtocolConfig 已定稿）：streakBonusBps=1000、streakMaxRounds=10、referralBonusBps=2000、referralCapMultiple=10000、earlyClaimPenaltyBps=5000、rolloverCapPerAddressRaw=20000000000000000、unlockDurationSeconds=31104000。

contracts 可选扩展：explorerBaseUrl、toncenterBaseUrl、toncenterApiKey、tonapiBaseUrl、minStakeRaw、maxTotalStakeRaw、maxStakePerAddressRaw、maxStakePerAddressBps（旧口径兼容）。

## 5. V8 奖励三态 / 权重 / 邀请 UI（/me）

### 5.1 奖励三态（RewardReferralPanel）

- 每轮一行：奖励金额 + 状态（未处理 / 已滚存 / 已早领）+ 可滚存 / 早领可得 / 进入解锁池金额。
- 三个按钮：**滚存**（全额进下一轮，可能归零）、**早领 50%**（立即拿 X，另 X 锁到 R10 后）、**不动**（默认，锁到 R10 后 12 个月线性）。
- 状态互斥：已滚存/已早领后按钮全部禁用并显示对应说明；不可回退。
- 关键文案（写死，产品情绪核心）：「**滚存 = 把赢来的再押一次，可能归零。想落袋就选早领（拿 50%）。**」
- 解锁进度：me.unlock 的 active / progressBps / claimableRaw；R10 后显示进度条 + 「可解锁 X / 12 个月线性」+ 领取解锁（ClaimUnlocked）按钮。

### 5.2 邀请

- 邀请码 = 地址的友好编码（无后端注册表时也能被对方还原为地址）；邀请链接为 `/me?ref=<邀请码>`，进入 /me 时 `captureInviteFromLocation()` 幂等写入 localStorage（待绑定）。
- 未绑定：显示待绑定邀请人（来自 ?ref=）或手动粘贴邀请码/地址 → 首次质押前发 SetReferrer（一笔交易）；已绑定显示「已绑定，不可修改」。
- 展示：连续参与轮次与当前权重倍数（1.10×–2.00×）、已邀请人数、被邀请人本轮质押、本轮邀请加成。
- 演示模式（无合约地址 / 演示钱包）：所有新按钮走本地模拟分支（不发链上交易），并显示「演示模式」提示。

数据字段全部来自 shared/types.ts（backend-dev 定稿）：RoundReward / UnlockInfo / ReferralInfo / MeResponse.rewards|stake|referral|unlock；字段缺失（后端灰度/旧演示数据）时由 `rewards.ts` 兜底（rewards 缺失时从 claimable.rewardRaw 推导 PENDING；unlock/referral 缺失时零值安全展示）。

## 6. 测试网联调步骤（合约部署 + /api/config 下发后）

1. 部署 Jetton Master / RoundController / TeamVault，把地址写入 D1 kv，确认 GET /api/config 返回 network=testnet 且两个地址非空、V8 参数已下发。
2. 钱包切 Testnet，准备测试 TON 与 A9；打开 /me 连接真实 TON 钱包（非演示钱包）。
3. 质押：输入数量、勾选风险 → 钱包展示 Jetton transfer（0x0F8A7EA5，forward payload 0x5254000F）。
4. 结算后：奖励三态面板出现该轮 → 选择滚存 / 早领 50% / 不动；确认回执匹配（source=用户 + opcode + roundId）。
5. 邀请：先用被邀请钱包打开 `/me?ref=<邀请码>`，绑定邀请人（SetReferrer 0x52540019）后再首次质押；已绑定不可改。
6. R10 终态后：解锁进度出现，点「领取解锁」发 ClaimUnlocked（0x5254001A），确认 claimableRaw 递减。
7. 失败路径：钱包拒绝、gas 不足、R10 前 ClaimUnlocked 被拒（合约侧失败）、重复操作（互斥）均应有明确提示。

## 7. 已知限制 / 待决策

- 轮次状态、奖励三态、解锁进度、邀请关系当前仍走后端 API；worker 尚未下发的 V8 字段已做兜底（见 §5.2 末）。
- 目标价/奖励估算以合约 getter 为准；UI 展示数据来自 worker 索引。
- Jetton Wallet 解析依赖 tonapi/toncenter 公共 RPC，可用 contracts.toncenterApiKey 提高配额。
- 邀请码目前是地址编码（可直接被对方还原）；如后续引入短码注册表，只需替换 inviteCodeFor/parseInviteCode 两个函数。

## 8. 自测记录

- web tsc --noEmit：0 error；vite build：OK。
- **V8 四个新 opcode 的 BOC 与 @ton/core 字节级对拍（仅本地验证，未加依赖）全部通过**：
  - ClaimRewardEarly 0x52540017：104 bit，hash 一致，BOC 字节一致，示例 hex b5ee9c7201010101000f00001a52540017112233445566778803
  - RollReward 0x52540018：104 bit，hash 一致，BOC 字节一致，示例 hex b5ee9c7201010101000f00001a52540018112233445566778803
  - SetReferrer 0x52540019：299 bit，hash 一致，BOC 字节一致，示例 hex b5ee9c7201010101002800004b525400198015757575…（51 字节）
  - ClaimUnlocked 0x5254001A：96 bit，hash 一致，BOC 字节一致，示例 hex b5ee9c7201010101000e0000185254001a1122334455667788
- 历史（task-7）质押 Jetton transfer 的 BOC 与 ton-core 也做过逐字节一致校验。
- UI（Playwright + mock /api）：/me 中英 × 1440/390 四张截图；三态行、三个按钮、解锁进度、邀请码/链接/待绑定/已绑定/连续轮次/权重/邀请加成全部渲染；旧字段缺失（legacy fallback）不报错；演示模式下滚存/早领/绑定/领取解锁四个动作均走本地模拟分支且无 pageerror。