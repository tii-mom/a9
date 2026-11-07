# web/src/features/chain — TON 真实交易（上车 / 攻城令领取 / 续战）

v11（docs/35 玩法规格，ABI 以 [contracts/README.md](../../../../contracts/README.md) 为准）：
合约是标准 JettonMaster + 标准 JettonWallet + RoundController（RC）+ 每人每城一个 StakeTicket（攻城令）+ 军饷分发（JunxiangDistributor / ClaimRecord）。
单 keeper 提交价格；没有 admin、没有提现入口。

- 上车：TEP-74 transfer 到 RC，payload v2（可选受益人）。
- 领取 / 续战：发给**自己的攻城令**，攻城令再向 RC 发请求；RC 校验请求来自推导出的攻城令地址后计算并转账。
- 已删除（v10 遗留，不得再接入）：ClaimAll、退款账本（Claim(0)）、一键早领 50%、邀请与连续参与、单地址 / 本城总额上限。

对外通过 `index.ts` 暴露；/me 页挂 `<ChainMePanel />`（上车 / 领取 / 续战）与 `<JunxiangCard />`（军饷领取）。

```
chain/
├─ index.ts              # 对外导出（组件 / hooks / ABI 常量 / 工具）
├─ protocol.ts           # opcode、单位、TON 附带建议、事件 / get methods 名称（v11）
├─ payload.ts            # StakePayload v2 / Jetton transfer / 攻城令消息体
├─ cell.ts               # 自包含 TON Cell + BOC 序列化/解析（无 @ton/core 依赖）
├─ address.ts            # 友好地址 ↔ raw、CRC16、base64
├─ decode.ts             # transfer_notification / 攻城令用户消息解码（回执校验）
├─ config.ts             # /api/config → ChainConfig（合约/网络/限额/浏览器/RPC）
├─ transactions.ts       # 前置校验 + TON Connect 消息构造（stake / ticketClaim / ticketRestake）
├─ rpc.ts                # Jetton Wallet 解析、攻城令地址与状态 getter、奖励预览、回执轮询
├─ useChainTx.ts         # 交易状态机 hook
├─ storage.ts            # 最近一笔交易本地记录
├─ errors.ts             # 合约 exit code → 文案
├─ junxiang.ts           # 军饷领取消息体（ClaimJunxiang）与默克尔证明编码
├─ junxiangClaim.ts      # 军饷根与已领额读取
├─ useJunxiangClaim.ts   # 军饷领取 hook
├─ i18n.ts               # 中英双语文案
├─ TxStatus.tsx          # 交易状态行
├─ ActionConfirm.tsx     # 交易确认面板
├─ QueryNotice.tsx       # 数据源提示
├─ ChainMePanel.tsx      # 上车 + 攻城令领取 / 续战面板
├─ JunxiangCard.tsx      # 军饷领取卡片
└─ chain.css             # 样式（沿用 fuse.css 变量与 .panel/.btn 体系）
```

## 1. 消息 ABI（v11）

### 1.1 上车：TEP-74 Jetton transfer（0x0f8a7ea5），forward payload 为右引用 cell

```
StakePayload v2（右引用 cell）
  op:uint32                      = 0x5254000F  STAKE_DEPOSIT
  version:uint8                  = 2
  roundId:uint8                  # 城号 1..10
  riskDisclosureVersion:uint16   # = /api/config.riskDisclosureVersion（当前为 1，见 §4）
  acceptFullPrincipalBurn:uint8  # 必须为 1
  beneficiary:MsgAddress         # addr_none（2 个 0 bit）= 记在付款人名下；否则为受益人（basechain）
```

Jetton transfer：destination = RC，response_destination = 用户，
**forward_ton_amount = 0.12 TON**（合约要求 ≥ 0.1，用于无效上车的即时退回），消息总额附带 **0.3 TON**。
最低上车 **1,000 A9**。无效上车：附带 TON ≥ 0.1 时原路退回；不足时**不退**（v11 无退款账本）。

一键上车（经 STON.fi 等 DEX 转入）同样带受益人字段，由 DEX 界面构造，本模块不构造该路径。

### 1.2 领取 / 续战：发给自己的攻城令

| 前端 kind | 消息（发给攻城令） | 附带 TON | 构造函数 |
| --- | --- | --- | --- |
| `ticketClaim` | TicketClaim `0x52540303` | 0.2 TON（合约要求 ≥ 0.15） | `prepareTicketClaimTransaction` |
| `ticketRestake` | TicketRestake `0x52540304` | 0.3 TON（合约要求 ≥ 0.25） | `prepareTicketRestakeTransaction` |

```
TicketClaim / TicketRestake
  op:uint32
  queryId:uint64
```

攻城令收到后置 `pending`，向 RC 发 `TicketRequest`；RC 拒绝时请求 bounce，攻城令清除 `pending`。
同一时间只允许一个请求在途。

### 1.3 事件 / get methods

- 事件（前端只登记，不逐条解析）：见 `EVENT_OPCODES`（TargetPriceSet … TeamReleased，contracts/README §5.4）。
- get methods：见 `GET_METHODS`。攻城令地址：`RC.get_ticket_address(owner, roundId)`；攻城令状态：`get_ticket_data`；奖励预览：`get_reward_preview(roundId, weightRaw)`（rewardRaw / immediateRaw / lockedRaw / unlockedLockedRaw）。
- 读取失败必须抛错，UI 区分「读不到」与「真的是 0」。

## 2. 交易构造与发送

- **Jetton Wallet 解析**：本地缓存 → tonapi `/v2/accounts/{owner}/jettons` → toncenter `runGetMethod get_wallet_address`。
- **发送**：复用 wallet 模块的单实例 TonConnectUI（`sendTonConnectTransaction`）；消息带 network（testnet=-3 / mainnet=-239）与 from（raw 地址）。
- **回执轮询**：上车用 transfer_notification 的 owner + roundId + 金额匹配；领取 / 续战用攻城令地址 + opcode + roundId + **本次 queryId**。
  身份命中后再由 `isSuccessfulTx` 判定执行成功（aborted=false、bounced=false、exitCode=0/null）；失败映射为
  `CONTRACT_REJECTED`，detail 带 exit_code 名称（`errors.ts` 与 `contracts/contracts/constants.tolk` 对齐）。

## 3. 状态机

`idle → preparing → awaiting-signature → sent → confirming → confirmed`；异常分支 rejected / failed / pending。

交易种类（`ChainTxKind`）：`stake`、`ticketClaim`、`ticketRestake`。军饷领取走 `junxiangClaim` 独立流程。

## 4. 配置来源（/api/config）

启用条件：contracts.roundController 与 contracts.jettonMaster 均非空，且 network 为 testnet/mainnet；否则整体降级为演示模式。
`riskDisclosureVersion` 由后端部署配置下发；**链上 payload 校验的是部署配置的值（v11 为 1）**，前端只回填，不自行改写。
`teamWallet`、`keeper` 用宽松读取（`contractExtra`）。

## 5. /me 数据口径

- 每城一张攻城令：本金、20% 即时奖励、80% 压城（已锁定 / 已解锁 / 可领）由 `/api/me` 与 RC getter 共同给出；以合约为准。
- 「可领」金额 = 未领本金 + 未领即时奖励 + 已解锁压城部分；压城未解锁时只显示锁定额。
- 领取按钮按攻城令发送 TicketClaim；续战按钮发送 TicketRestake（仅攻城期内可用，本金计入当前城，奖励不复利）。

## 6. 测试网联调步骤

1. 按 contracts/README §6 部署 JettonMaster / RoundController，确认 GET /api/config 返回 network=testnet 且两个地址非空。
2. 钱包切 Testnet，准备测试 TON 与 A9；打开 /me 连接真实 TON 钱包（非演示钱包）。
3. 上车 ≥ 1,000 A9：钱包展示 Jetton transfer（0x0F8A7EA5，forward 0.12 TON，payload 0x5254000F version 2）。
4. 破城结算后：「链上领取」出现该城本金 + 即时奖励 → 点「领取」发 TicketClaim；续战按钮在攻城期内发 TicketRestake。
5. 受益人上车：仅 STON.fi 界面可演练（`user_op` 脚本的受益人固定为付款人），见 `ops/drills/2026-11_testnet_v11_10round_drill.md`。
6. 失败路径：钱包拒绝、gas 不足、无可领（NothingToClaim=230）、附带 TON 不足（NotEnoughValue=234）、请求在途（TicketPending=238）均应有明确提示。

## 7. 已知限制

- 轮次状态与可领金额走 worker API；目标价 / 奖励估算以合约 getter 为准。
- Jetton Wallet 解析依赖 tonapi/toncenter 公共 RPC，可用 contracts.toncenterApiKey 提高配额。
- 本模块的 i18n 中部分 key 名沿用 v10（如 `maxStake`、`refund*`），文案已是 v11 口径；键名清理留待下一轮。
