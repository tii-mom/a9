# web/src/features/chain — TON 真实交易（质押 / 领取 / 退款账本）

v10（docs/00 D-42，ABI 以 [contracts/README.md](../../../../contracts/README.md) §4 为准）：
合约只有标准 JettonMaster + 标准 JettonWallet + 一个 RoundController；单 keeper 提交价格。
邀请、连续参与、滚存、早领 50%、R10 后释放池全部删除；成功轮本金 + 全额奖励一次领取。

对外通过 `index.ts` 暴露，/me 页挂 `<ChainMePanel />`（质押 / 领取）与 `<RefundClaimPanel />`（退款账本）。

```
chain/
├─ index.ts              # 对外导出（组件 / hooks / ABI 常量 / 工具）
├─ protocol.ts           # opcode、单位、gas、限额、事件 / get methods 名称
├─ payload.ts            # StakePayload / Jetton transfer / Claim 消息体
├─ cell.ts               # 自包含 TON Cell + BOC 序列化/解析 + CellSlice（无 @ton/core 依赖）
├─ address.ts            # 友好地址 ↔ raw、CRC16、base64
├─ decode.ts             # transfer_notification / Claim 消息解码（回执校验）
├─ config.ts             # /api/config → ChainConfig（合约/网络/限额/浏览器/RPC）
├─ transactions.ts       # 前置校验 + TON Connect 消息构造
├─ rpc.ts                # Jetton Wallet 解析、toncenter 交易查询、回执轮询、退款账本 getter
├─ useChainTx.ts         # 交易状态机 hook
├─ storage.ts            # 最近一笔交易本地记录
├─ i18n.ts               # 中英双语文案
├─ TxStatus.tsx          # 交易状态行
├─ ChainMePanel.tsx      # 质押 + 领取面板
├─ RefundClaimPanel.tsx  # 退款账本（Claim{roundId:0}）领取入口
└─ chain.css             # 样式（沿用 fuse.css 变量与 .panel/.btn 体系）
```

## 1. 消息 ABI（v10）

### 1.1 质押：TEP-74 Jetton transfer（0x0f8a7ea5），payload 格式与 v8.9 相同

```
StakePayload（136 bit）
  op:uint32                      = 0x5254000F  STAKE_DEPOSIT
  version:uint8                  = 1
  roundId:uint8
  depositNonce:uint64            # 同一 (roundId, owner) 单调唯一
  riskDisclosureVersion:uint16   # = /api/config.riskDisclosureVersion
  acceptFullPrincipalBurn:uint8  # 必须为 1
```

Jetton transfer：destination = RoundController，response_destination = 用户，
**forward_ton_amount = 0.12 TON**（合约要求 ≥ 0.1，用于无效质押的即时退回），消息附带 **0.3 TON**。
forward 不足时无效质押记入退款账本；低于最低质押（100,000 A9）的零头不退。

### 1.2 领取（用户 → RoundController，附带 0.2 TON，合约要求 ≥ 0.1）

```
ClaimPayload（104 bit）
  op:uint32        # Claim 0x52540006 / ClaimAll 0x5254000E
  queryId:uint64
  roundId:uint8    # Claim：1..10 = 该轮本金 + 全额奖励，0 = 退款账本；ClaimAll：忽略（填 0），领取 0..10 全部
```

| 前端种类 | 消息 | 构造函数 |
| --- | --- | --- |
| `claim` | Claim(roundId) | `prepareClaimTransaction({ kind: 'claim', roundId })` |
| `claimAll` | ClaimAll | `prepareClaimTransaction({ kind: 'claimAll' })` |
| `claimRefund` | Claim(0) | `prepareClaimRefundTransaction()`（显式 `REFUND_ROUND_ID = 0`） |

### 1.3 事件 / get methods

- 事件（前端不解析，仅登记）：见 `EVENT_OPCODES`（TargetPriceSet … UnexpectedBounce，contracts/README §4.3）。
- get methods：见 `GET_METHODS`（contracts/README §4.4）。`get_claimable_all.rewardRaw` 为全额奖励；roundsMask bit 15 = 退款账本。
- 退款账本读取：`RC.get_user_stake(0, owner)`（`rpc.fetchRefundLedger`）；读取失败必须抛错，UI 区分「读不到」与「真的是 0」。

## 2. 交易构造与发送

- **Jetton Wallet 解析**：本地缓存 → tonapi `/v2/accounts/{owner}/jettons` → toncenter `runGetMethod get_wallet_address`。
- **发送**：复用 wallet 模块的单实例 TonConnectUI（`sendTonConnectTransaction`）；消息带 network（testnet=-3 / mainnet=-239）与 from（raw 地址）。
- **回执轮询**：质押用 transfer_notification 的 depositNonce；领取用 in_msg.source + opcode + roundId + **本次 queryId**。
  身份命中后再由 `isSuccessfulTx` 判定执行成功（aborted=false、bounced=false、exitCode=0/null）；失败映射为
  `CONTRACT_REJECTED`，detail 带 exit_code 名称（`errors.ts` 与 contracts/contracts/constants.tolk 对齐）。

## 3. 状态机

`idle → preparing → awaiting-signature → sent → confirming → confirmed`；异常分支 rejected / failed / pending。

交易种类：`stake`、`claim`、`claimAll`、`claimRefund`。

## 4. 配置来源（/api/config）

启用条件：contracts.roundController 与 contracts.jettonMaster 均非空，且 network 为 testnet/mainnet；否则整体降级为演示模式。
`teamWallet`、`keeper` 用宽松读取（`contractExtra`），后端新旧两种 contracts 形状都能显示。

## 5. /me 数据口径

- `/api/me` 只用 `stakes[].roundId/amountRaw/principalClaimed/rewardClaimed` 与 `claimable[].roundId/principalRaw/rewardRaw/state`；
  每轮显示本金 + 全额奖励，一个按钮领取。
- 退款账本面板（RefundClaimPanel）：金额 > 0 时才显示；文案「你有一笔质押没有成功，A9 还在协议里。」

## 6. 测试网联调步骤

1. 按 contracts/README §5 部署 JettonMaster / RoundController，确认 GET /api/config 返回 network=testnet 且两个地址非空。
2. 钱包切 Testnet，准备测试 TON 与 A9；打开 /me 连接真实 TON 钱包（非演示钱包）。
3. 质押 ≥ 100,000 A9：钱包展示 Jetton transfer（0x0F8A7EA5，forward 0.12 TON，payload 0x5254000F）。
4. 成功轮结算后：「链上领取」出现该轮本金 + 奖励 → 点「领取本金 + 奖励」发 Claim(roundId)，或「全部领取」发 ClaimAll。
5. 退款账本：用 forward < 0.1 TON 的无效质押制造入账后，/me 出现「质押退款」面板 → 点「取回 A9」发 Claim{roundId:0}。
6. 失败路径：钱包拒绝、gas 不足、无可领（NothingToClaim=230）、附带 TON 不足（NotEnoughValue=234）均应有明确提示。

## 7. 已知限制

- 轮次状态与可领金额走 worker API；目标价/奖励估算以合约 getter 为准。
- Jetton Wallet 解析依赖 tonapi/toncenter 公共 RPC，可用 contracts.toncenterApiKey 提高配额。
