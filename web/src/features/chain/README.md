# web/src/features/chain — TON 测试网真实质押 / 领取（task-7）

把前端从「演示数据」升级为可对 TON 测试网合约发起真实交易。所有 UI / 交易逻辑都在本目录内；
对外仅通过 `index.ts` 暴露，页面侧只挂一个 `<ChainMePanel />`。

`@
chain/
├─ index.ts            # 对外导出（组件 / hooks / ABI 常量 / 工具）
├─ protocol.ts         # opcode、单位、gas、默认限额、uint64 nonce/queryId
├─ payload.ts          # StakePayload / Jetton transfer / Claim 消息体构造
├─ cell.ts             # 自包含 TON Cell + BOC 序列化 + BOC 解析 + CellSlice（无 @ton/core 依赖）
├─ address.ts          # 友好地址 ↔ raw、CRC16、base64（url-safe / 标准）
├─ decode.ts           # transfer_notification / Claim 消息解码（回执校验）
├─ config.ts           # /api/config → ChainConfig（合约地址、网络、限额、浏览器、RPC 端点）
├─ transactions.ts     # 前置校验 + TON Connect 消息构造
├─ rpc.ts              # Jetton Wallet 解析、toncenter 交易查询、回执轮询
├─ useChainTx.ts       # 交易状态机 hook（待签名/已发送/已上链/失败）
├─ storage.ts          # 最近一笔交易本地记录（刷新后仍可见哈希链接）
├─ i18n.ts             # 中英双语文案 + 错误码文案 + 阶段文案
├─ TxStatus.tsx        # 交易状态行（阶段、哈希、错误、重试）
├─ ChainMePanel.tsx    # 「我的战况」链上交易面板（质押 + 领取 + 降级）
└─ chain.css           # 面板样式（沿用 fuse.css 变量与 .panel/.btn 体系）
`@

## 1. 消息 ABI（V6.2，与 contract-dev 定稿 / docs/04 §19 一致）

> 自研合约只有 **RoundController + TeamVault**：没有独立的 StakingVault / RewardVault 地址。
> 质押 Jetton 的 owner、三种领取消息的接收方都是 **RoundController**。

### 1.1 质押：TEP-74 Jetton transfer（`0x0f8a7ea5`）

用户钱包 → **用户自己的 Jetton Wallet**（由 `get_wallet_address` 解析），forward payload 携带：

`@
StakePayload（136 bit）
  op:uint32                      = 0x5254000F  STAKE_DEPOSIT
  version:uint8                  = 1
  roundId:uint8
  depositNonce:uint64            # 同一 (roundId, owner) 单调唯一
  riskDisclosureVersion:uint16   # = /api/config.riskDisclosureVersion（测试网初始 1）
  acceptFullPrincipalBurn:uint8  # 必须为 1（0 会被合约退款）
`@

Jetton transfer 参数：

| 字段 | 值 |
| --- | --- |
| destination（Jetton owner） | RoundController |
| response_destination | 用户钱包地址 |
| custom_payload | 空 |
| forward_ton_amount | 0.05 TON |
| forward_payload | `Either Cell ^Cell` = 引用 StakePayload cell |
| 消息附带 TON | 0.20 TON（gas + forward） |

### 1.2 领取（用户 → RoundController，普通内部消息）

`@
ClaimPayload（104 bit）
  op:uint32        # ClaimPrincipal 0x52540006 / ClaimReward 0x52540007 / ClaimAll 0x5254000E
  queryId:uint64   # 回执关联（合约不做唯一性强制）
  roundId:uint8    # ClaimAll 填 0 = 合约扫描全部已结算轮次（≤10 轮）
`@

消息附带 0.10 TON。三种领取均幂等；ClaimAll 把本金 + 奖励合并为一笔 Jetton 转账。

## 2. 交易构造与发送

- **Jetton Wallet 解析**（`rpc.ts`）：本地缓存 → tonapi `/v2/accounts/{owner}/jettons` → toncenter
  `runGetMethod get_wallet_address`（三种参数编码兜底：raw / friendly / address-cell BOC）。
- **发送**：复用 wallet 模块的 **单实例 TonConnectUI**（`sendTonConnectTransaction`，task-7 新增导出），
  **不新建第二个实例**；消息带 `network`（testnet = `-3` / mainnet = `-239`）与 `from`（raw 地址）。
- **boc**：payload 为自包含 Cell/BOC 序列化（无 index/CRC，TON 节点与钱包均可解析），标准 base64 传给 TON Connect。
- **回执轮询**（`rpc.ts waitForTransaction`）：
  1. 合约地址（RoundController）出现匹配交易 → 已上链（合约侧确认）：
     - 质押匹配：解析 `transfer_notification` 的 forward payload，比对 `depositNonce`；
     - 领取匹配：`in_msg.source` = 用户地址 + opcode + roundId；
  2. 30s 内只观察到钱包外部交易 → 标记「已上链（等待合约回执）」并给出钱包交易哈希；
  3. 超时 → 可重试的 `TX_TIMEOUT`，已发送状态不丢失（哈希仍展示）。

## 3. 状态机

`idle → preparing → awaiting-signature → sent → confirming → confirmed`
异常分支：`rejected`（钱包拒绝）/ `failed`（余额、网络、超时、配置等）。

错误码（UI 中英双语）：`CHAIN_NOT_CONFIGURED`、`WALLET_NOT_CONNECTED`、`DEMO_WALLET`、`TONCONNECT_UNAVAILABLE`、`WALLET_REJECTED`、`INSUFFICIENT_BALANCE`、`ROUND_NOT_OPEN`、`AMOUNT_INVALID/TOO_SMALL/TOO_LARGE`、`JETTON_WALLET_UNRESOLVED`、`NETWORK_ERROR`、`TX_TIMEOUT`、`BAD_CONFIG`。

## 4. 配置来源（/api/config）

启用条件：`config.contracts.roundController` 与 `config.contracts.jettonMaster` 均非空，且 `config.network` 为 `testnet`/`mainnet`。否则整体降级：只显示「链上交易未启用」说明，页面原有演示流程（`/api/stake`、`/api/claim` 演示领取）完全不受影响。

后端可通过 `contracts` 的可选扩展字段覆盖（缺省用内置默认值，向后兼容）：

| 字段 | 说明 | 缺省 |
| --- | --- | --- |
| `explorerBaseUrl` | 浏览器根地址（交易/地址链接） | testnet `https://testnet.tonscan.org` / mainnet `https://tonscan.org` |
| `toncenterBaseUrl` | toncenter 根地址 | `https://testnet.toncenter.com` / `https://toncenter.com` |
| `toncenterApiKey` | 可选 API key（公共限流时提高配额） | 无 |
| `tonapiBaseUrl` | tonapi 根地址 | `https://testnet.tonapi.io` / `https://tonapi.io` |
| `minStakeRaw` | 单笔最低质押（raw） | `10,000 × 10^decimals` |
| `maxTotalStakeRaw` | 本轮总质押上限（raw） | `200,000,000 × 10^decimals` |
| `maxStakePerAddressRaw` | 单地址固定硬顶（raw） | `20,000,000 × 10^decimals`（V6.1 = 本轮总上限的 10%） |
| `maxStakePerAddressBps` | 旧口径占比（bps，仅兼容保留） | `1000` |

> `shared/types.ts` 的 `contracts` 已包含主要地址字段；扩展字段由 Lead 决定是否正式纳入。前端读取时全部做了「存在即用、缺失即回退」处理，因此后端可以逐步补充。

## 5. 测试网联调步骤（合约部署 + /api/config 下发后）

1. 部署 Jetton Master / RoundController / TeamVault，把地址写入 D1 的 `kv`（`contract_jetton_master`、`contract_round_controller`...），确认 `GET /api/config` 返回 `network: \"testnet\"` 且两个地址非空。
2. 确认 `config.riskDisclosureVersion` 与合约 config 一致（测试网初始 1；不一致会被退款）。
3. 在钱包 App 中切到 **Testnet**（Tonkeeper → Settings → Network → Testnet），准备测试 TON 与测试 A9。
4. 打开 `/me` → 连接真实 TON 钱包（非演示钱包）→「链上交易」面板出现测试网徽标与合约地址链接。
5. 报名窗口内输入数量（≥ 最低限额）、勾选风险确认 → 签名：钱包应展示一条 Jetton transfer（接收方为**你的** Jetton Wallet，附带 0.2 TON，payload 以 `0x5254000F` 开头）。
6. 状态机：待签名 → 已发送 → 已上链 → 已确认；面板给出交易哈希链接，合约侧匹配依据是 `transfer_notification` 中的 `depositNonce`。
7. 结算后点「一键领取全部（ClaimAll）」→ 钱包展示一条消息到 RoundController（payload 以 `0x5254000E` 开头）；回执匹配 `in_msg.source = 用户地址 + opcode + roundId`。
8. 验证幂等：重复点击 ClaimAll 不重复派发；重复质押 nonce 会被合约退款（交易仍可能成功上链）。
9. 失败路径：钱包拒绝（rejected）、TON 余额不足（INSUFFICIENT_BALANCE）、非报名窗口（ROUND_NOT_OPEN）、Jetton Wallet 解析失败（JETTON_WALLET_UNRESOLVED）。

## 6. 已知限制 / 待决策

- **轮次元数据仍来自后端**：当前 `/api/rounds` 可能仍是演示数据源（`dataSource: demo`）。面板会显式提示「以后端/合约为准」，质押前置校验依赖该接口的 `state` 与窗口时间。正式联调需要 worker 的 chain 数据源（task-1 的 `worker/src/sources/chain.ts`）或索引器。
- **可领取金额**：来自 `/api/me`（演示数据源时是演示金额）。合约侧 `get_claimable_all` 的读取需要索引器/worker 提供；当前 ClaimAll 不依赖金额即可安全调用（合约自行扫描）。
- **Jetton Wallet 解析依赖公共 RPC**（tonapi / toncenter）。若被限流，UI 会提示重试；可在 `/api/config contracts` 中配置 `toncenterApiKey`。
- **TON Connect 拒绝识别**：依据错误码 `300` 与文案匹配，不同钱包文案可能不同；未识别时归为 `UNKNOWN`，仍显示原始 detail。
- **MePage 的只读提示与演示领取按钮**：`features/app/MePage.tsx` 原有「只读模式」文案、以及依赖 `/api/claim` 的演示领取按钮在链上模式启用后仍会显示（task-7 只允许在 MePage 加 import + 挂组件）。链上面板已加显式提示「本面板交易会真实上链，演示领取不上链」；建议后续由 app-dev/Lead 在 `config.contracts.roundController` 非空时隐藏演示领取按钮并更新只读文案。

## 7. 自测记录（2026-11-05）

- `tsc --noEmit`（web）：0 error；`vite build`：成功。
- **离线 BOC / payload 校验**（用同机 `ton-core@0.63.1` 作对照实现，仅测试用，未加依赖）：
  - StakePayload = 136 bit，cell hash 与 ton-core 一致；
  - Jetton transfer：BOC 字节与 ton-core 序列化**完全一致**（`Cell.fromBase64` 可解析、hash 相同）；
  - ClaimPayload = 104 bit，BOC 与 ton-core 一致；
  - BOC 解析 → 反序列化字节级 round-trip 一致；
  - `decodeJettonNotification` 能从 ton-core 构造的 `transfer_notification` 中还原 `depositNonce/roundId/sender`；
  - 金额 `parse/format` 边界（逗号、精度溢出）通过。
- **前置校验 / 交易构造**（Node 直跑纯 TS 模块）：demo 钱包、非报名窗口、低于最低额、超总上限、单地址超过 20,000,000 A9 硬顶、gas 不足均抛出对应错误码；
  质押消息实测：op=`0x0F8A7EA5`、金额 coins 正确、destination=RoundController、response=用户、custom_payload 为空、
  forward=0.05 TON、forward payload 为引用且解码回 `roundId/depositNonce/riskVersion/accept=1`；ClaimAll = `0x5254000E` + roundId 0；
  地址非法时归为 `BAD_CONFIG`（不会把 CRC 原始异常抛给 UI）。
- UI 冒烟（Playwright + mock `/api`）：`/me` 分别测「已配置测试网（1440 / 390）」与「未配置合约（1280）」，
  校验面板文案、按钮禁用态（演示钱包）、dataSource=demo 提示、无横向溢出、无未捕获异常；
  英文界面 1440 / 390 亦通过（1280 英文下的横向溢出由既有 SiteHeader 导航产生，与链上面板无关）。