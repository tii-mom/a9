# 24 — 测试网交易闭环交接单（v8.7-audit-fixed）

> 出具方：Lead / 合约与运维窗口　接收方：前端窗口（负责接入、钱包交互、页面验收）
> **前端 PR #1（分支 `frontend-ux`，提交 `f208721`）暂不合并、不部署。** 本文档只提供可联调的环境与工具。
> 生成时间：2026-11-06；实例：fasttest v8.7（10 秒级快测时序）

## 0. 分工边界

| 项 | 由谁负责 |
| --- | --- |
| 合约部署、地址与资金、推进轮次/预言机/结算的 CLI | **本窗口（已完成，见下）** |
| 前端接入链上读取、钱包签名交易、页面验收 | **前端窗口** |
| 合并前端 PR、部署前端 | **暂不进行**（等本窗口验收后统一） |

## 1. 网络与端点

| 项 | 值 |
| --- | --- |
| 网络 | **testnet**（`chainId = -3`） |
| TON Connect network | `-3` |
| toncenter v2 / v3 | `https://testnet.toncenter.com/api/v2` / `/api/v3` |
| tonapi | `https://testnet.tonapi.io` |
| 区块浏览器 | `https://testnet.tonscan.org` |
| TON Connect manifest | `https://a9.lat/tonconnect-manifest.json`（本地可用 `http://localhost:5173/tonconnect-manifest.json`） |
| Jetton 元数据 | `https://a9.lat/a9.json`（构建产物里已有；未部署时本地 `web/public/a9.json`） |

## 2. 合约地址（已逐个在链上核对 code hash，与 v8.7 冻结基线一致）

| 合约 | 地址 | Code Hash | 链上状态 |
| --- | --- | --- | --- |
| JettonMaster | `kQBtBPSSDOxXqszF0X5r6sXdbCd5x9EL6qc3deOR7t20XBck` | `0xB8FAF413…E59EE272` | active |
| RoundController | `kQAO8WrgoqI6pqQ3XXy6xpynjtztZpU4AlJ73tnMqaYG5O2K` | `0xF4343A8E…B3DCE15AB` | active |
| TeamVault | `kQDLSySrGBYZyRh9IgfSV5mfpnjcjNrNOydWLAQMEe190q2F` | `0xDE6BE491…6A673FB6` | active |
| OracleAdapter | `kQDpBil4uHmRNvUEqjs030hmyXoxjrQMRWRnIb5-QfGV7p8l` | `0x0C91E533…703676768` | active |
| RC 的 Jetton Wallet | `kQAOx2zmsRcrRDrpcGnC2v2NPTdx89GToXm9hMpJuJTPpdmH` | （由 master 派生） | active |
| TV 的 Jetton Wallet | `kQDLjPTx0R-mv5w3Hb36U1FlIgixI4sPSfw2vfhizRVtgVTS` | （由 master 派生） | active |

**额外验证**：`RC.get_jetton_wallet_code_hash()` 返回 `0xC40F41ED05BEFFB7EF17E25FA0D1BB2AFDA72C567052546A2E310C0275D31D13`，与 v8.7 的 JettonWallet hash 一致 —— 这条最关键，它保证领取时推导的收款钱包地址是对的。

## 3. 时序参数（快测，非生产）

| 参数 | 值 |
| --- | --- |
| preview | 10 秒 |
| 质押窗口 | 120 秒 |
| 单根 K 线 | 10 秒 |
| K 线总数 / 达标阈值 | 24 / 16 |
| 观察期 | 240 秒 |
| 单轮总时长 | 约 6~7 分钟 |

**注意**：生产时序是 12h + 36h + 24h。联调用这个快测实例，**不要在 UI 上写死轮次时长**，一律从 `/api/config` 或合约 getter 读。

## 4. 可用测试账户（acton 钱包名 + 地址）

| 角色 | acton 钱包名 | 地址 | A9 | TON |
| --- | --- | --- | --- | --- |
| 用户 A | `a9-test-a` | `kQB7JWfG8HAfV9ap6fasi6uzylEFcSzTYkFUvgFSlNUFIpnm` | 900,000 | 1.99 |
| 用户 B | `a9-test-b` | `kQBL8tlXBXfvBwN_qobNXdM4tpMBpcomOtHre_JsmeXA7ExM` | 900,000 | 1.71 |
| 用户 C | `a9-test-c` | `kQAhuPFUdpAniiSwgfYalPCi7n6SfL1zcHQMnK5pmpNCXYpH` | 900,000 | 2.34 |
| admin | `a9-fast-admin2` | `kQAEyuL0N7xcmmQ-qSfkOBXOo3CNQUie0EABucdU0mSCF-z_` | — | 见链上 |

A/B/C 各有 90 万 A9（已质押 10 万在 R1），TON 余额够跑数轮。**前端窗口只读这些地址做展示验收即可；需要签名时用 acton 钱包名（私钥在本地 keystore，仅测试网）。**

## 5. 前端接入配置（关键）

前端**不需要硬编码地址**——`web/src/features/chain/config.ts` 从 `/api/config` 派生：
```
configured = config.network ∈ {testnet, mainnet} && contracts.roundController && contracts.jettonMaster
chainId    = testnet → '-3'
toncenter / tonapi / explorer = 按 network 自动选测试网端点
```

### 5.1 让 worker 返回测试网合约地址

1. Worker 变量：`CHAIN_NETWORK=testnet`
2. D1 `config` 表写入 8 个 key（本地 wrangler dev 用 `--local` + `--persist-to`）：

```sql
INSERT OR REPLACE INTO config (key, value, updated_at) VALUES
  ('contract_jetton_master',      'kQBtBPSSDOxXqszF0X5r6sXdbCd5x9EL6qc3deOR7t20XBck', unixepoch()*1000),
  ('contract_round_controller',   'kQAO8WrgoqI6pqQ3XXy6xpynjtztZpU4AlJ73tnMqaYG5O2K', unixepoch()*1000),
  ('contract_staking_vault',      'kQAOx2zmsRcrRDrpcGnC2v2NPTdx89GToXm9hMpJuJTPpdmH', unixepoch()*1000),
  ('contract_team_vault',         'kQDLSySrGBYZyRh9IgfSV5mfpnjcjNrNOydWLAQMEe190q2F', unixepoch()*1000),
  ('contract_oracle_adapter',     'kQDpBil4uHmRNvUEqjs030hmyXoxjrQMRWRnIb5-QfGV7p8l', unixepoch()*1000),
  ('contract_admin_owner',        'kQDfQ68RY7pJ534OiwEt-dXRUmG1A7AajqJupq4hw35vWRuy', unixepoch()*1000),
  ('contract_code_hash',          '0xF4343A8E20756CBF683DAEBABE68C9737F8CB9FE968DC96A2600402B3DCE15AB', unixepoch()*1000),
  ('contract_audit_report_url',   '', unixepoch()*1000);
```

3. 本地起：
```bash
cd worker
./node_modules/.bin/wrangler dev --port 8901 --persist-to /tmp/a9-dev \
  --var CHAIN_NETWORK:testnet --var DATA_SOURCE:demo --var ADMIN_TOKEN:dev-admin-token
```
→ `curl http://127.0.0.1:8901/api/config | jq '.data.contracts, .data.network'` 应能看到地址与 `"testnet"`。

> **`DATA_SOURCE` 说明**：目前测试网 v8.7 实例的数据还没接索引器，所以 API 侧仍是 `demo`（首页行情/排行榜是演示数据），但**链上读取和交易是真的**——`ChainMePanel` / 退款面板 / TON Connect 都走真实链。这个混合状态适合前端联调，**不适合当验收证据**。

## 6. 推进轮次 / 提交 K 线 / 结算（CLI 工具）

所有命令都在 `contracts/` 目录下执行，前缀 `export PATH=$HOME/.acton/bin:$PATH`。

### 6.1 全自动（推荐，用于造数据）
```bash
cd /Users/yu1/Desktop/BAM
OPS_EXECUTE=1 node ops/scripts/keeper-candles.mjs \
  --rc kQAO8WrgoqI6pqQ3XXy6xpynjtztZpU4AlJ73tnMqaYG5O2K \
  --signer a9-fast-admin2 --rounds 9 --modes S,F,S,F,S,F,S,F,S
```
`--modes` 按 `(roundId-1) % len` 索引决定该轮成功(S, twap=target)还是失败(F, twap=target/2)。

### 6.2 手工逐步（用于控制节奏、验证 UI 状态）
```bash
cd contracts && export PATH=$HOME/.acton/bin:$PATH
export ROUND_CONTROLLER_ADDRESS=kQAO8WrgoqI6pqQ3XXy6xpynjtztZpU4AlJ73tnMqaYG5O2K
export JETTON_MASTER_ADDRESS=kQBtBPSSDOxXqszF0X5r6sXdbCd5x9EL6qc3deOR7t20XBck
export A9_SIGNER_WALLET=a9-fast-admin2 OPS_EXECUTE=1 OPS_CONFIRM=YES

# 开轮（twap24hUsdE8=116000 → target 按 max(2×twap, 阶梯) 锁定）
acton script --manifest-path Acton.toml --net testnet ../ops/scripts/tolk/fast_admin.tolk open-round <roundId> 116000
# 关窗（到期后任何人可关；提前关需 twap1h >= target）
acton script --manifest-path Acton.toml --net testnet ../ops/scripts/tolk/fast_admin.tolk close-staking <roundId> <twap1hUsdE8>
# 提交一根 K 线（合规 3/5 签名是 OracleAdapter 路径；当前用 admin 直提更简单）
A9_PERIOD_START=<obsStart+idx*10> A9_PERIOD_END=<+10> A9_TWAP_E8=<价格> \
  acton script --manifest-path Acton.toml --net testnet ../ops/scripts/tolk/fast_candle.tolk <roundId> <candleIndex>
# 结算（24 根后自动结算；如需手动推进）
acton script --manifest-path Acton.toml --net testnet ../ops/scripts/tolk/fast_admin.tolk finalize-round <roundId>
```

### 6.3 用户操作（模拟另一侧行为）
```bash
# 质押（金额单位 raw：100,000 A9 = 100000000000000）
A9_SIGNER_WALLET=a9-test-a acton script ... ../ops/scripts/tolk/user_op.tolk stake 100000000000000 <roundId> <nonce> <dummy>
# 领取本金 / 奖励 / 早领 50% / 滚存 / 领取解锁
acton script ... user_op.tolk claim-principal <roundId> <queryId> 0 <addr>
acton script ... user_op.tolk claim-reward       <roundId> <queryId> 0 <addr>
acton script ... user_op.tolk claim-early        <roundId> <queryId> 0 <addr>
acton script ... user_op.tolk claim-all          <roundId> <queryId> 0 <addr>
acton script ... user_op.tolk roll               <roundId> <queryId> 0 <addr>
acton script ... user_op.tolk claim-unlocked     <queryId> 0 0 <addr>
```

### 6.4 查询（与 UI 对账用）
```bash
acton script ... ../ops/scripts/tolk/query_user.tolk stake|weight|reward|claimable|referral|streak|unlock <owner> <roundId>
```

## 7. v8.7 行为变更（前端必须知道，否则会踩）

| # | 变更 | 对前端的影响 |
| --- | --- | --- |
| 1 | **F6：领取类入口要求入站 `valueCoins ≥ 0.15 TON`**（`ClaimPrincipal/ClaimReward/ClaimAll/ClaimUnlocked/SetReferrer`） | 旧前端只附 0.1 TON → 会被 `BadConfig(250)` 拒绝。**前端窗口的改动已把领取消息值提到 0.2 TON**，联调时请确认这条生效 |
| 2 | **F2：退款账本在 `roundId = 0`** | 质押失败（附带 TON 不足）的 A9 不在 1..10 轮里，需要 `ClaimPrincipal{roundId:0}` 领回。UI 需单独展示（已在 PR 的 `RefundClaimPanel` 实现） |
| 3 | **`ResetRoundCandles = 0x52540028`** | 发给 OracleAdapter，**前端不调用**，只需常量登记 |
| 4 | 新事件 `0x52540109`–`0x5254010D` | 前端目前无事件解析，常量登记即可 |
| 5 | **F1：转账/销毁的 `sendExcessesTo` 只能是自己** | 前端构造 jetton transfer 时 `response_destination` **必须是用户自己的地址**（现有实现已是），传第三方地址会被 `NotOwner(73)` 拒绝 |

## 8. 当前链上状态（生成本文档时）

```
currentRound = 2
R1  SUCCEEDED  tier=1  candles=24  qualified=16  stake=300,000  teamReleased ✓
R2  STAKING_OPEN
RC wallet A9 = 7,000,300,000,000,000,000（70 亿 + R1 质押 30 万）
TV wallet A9 = 1,080,000,000,000,000,000（12 亿 − R1 释放 1.2 亿）
team wallet A9 = 120,000,000,000,000,000（R1 团队释放）
```

实时状态请用 `query_user.tolk` 或 toncenter `runGetMethod` 查 `get_current_round` / `get_round`。

## 9. 联调注意事项

1. **toncenter 限流**：无 API key 约 1 req/s，多人并行读会 429。前端建议对 `runGetMethod` 做 10–15s 缓存（PR 已实现退款账本 15s 缓存），轮询间隔别低于 5s。
2. **`DATA_SOURCE=demo` + 真实链地址的混合状态**：首页/排行榜是演示数据，`/me` 的链上部分是真实。**UI 上要让用户能分清**，不要在同一屏混着展示真实余额和演示行情。
3. **PR #1 不合并、不部署**：联调在前端窗口本地跑（`vite dev` + 本地 worker），不要推到共同环境。
4. 测试网实例会被持续推进轮次（keeper 在跑），**你看到的轮次状态会变**，别把某个瞬时状态写死进测试断言。

## 10. 前端窗口验收清单

- [ ] `/api/config` 返回 `network="testnet"` 且 `contracts.roundController` 非空 → 页面进入 chain 模式（不再提示「演示模式」）
- [ ] TON Connect 连接测试网钱包成功，显示的是测试网地址
- [ ] 质押：构造的 jetton transfer `response_destination` = 用户自己地址，`forward_payload` 与 `payload.ts` 一致，附带 0.35 TON
- [ ] 领取：消息值 **0.2 TON**（≥0.15 门槛），回执判定走 FIX-5（aborted/exit_code 不能当成功）
- [ ] 退款面板：`get_user_stake(0, owner)` 读不到时显示「暂时无法查询」而不是 0
- [ ] 早领（50%）：`ClaimRewardEarly` 成功后 `rewardState=2`、`get_claimable_all` 变化符合预期
- [ ] 滚存：`RollReward` 成功后下一轮 `get_user_stake(next).amountRaw` 增加
- [ ] 错误码展示：构造一次必然失败的领取（如重复领取），UI 显示 `CONTRACT_REJECTED · exit_code=...` 而不是「成功」