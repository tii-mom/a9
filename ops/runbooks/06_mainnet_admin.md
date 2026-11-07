> ⚠️ **已作废（v8–v10 口径）**：主网上线请只按 [08_mainnet_v11.md](08_mainnet_v11.md) 执行。本文仅供溯源。

# 06 — 主网 keeper 与资金钱包权限（v10）

> 状态：**待项目方确认**。v10 合约没有 admin，本手册只定义主网的运营写权限（keeper 热钱包）和资金钱包的托管方式。
> 适用基线：contracts/README.md v10（D-42，2026-11-06）。
> 关联：04（测试网密钥与操作）、07（主网部署全流程）。

---

## 0. TL;DR

1. **没有 admin**。JettonMaster 的铸造在部署交易里关闭；RoundController 不可升级、没有提现、没有参数修改入口。
2. **唯一的运营写权限是 keeper 热钱包**：发 OpenRound 与 SubmitCandle。CloseStaking、AbortTechnical、RetrySettlement 任何人都可以调用。
3. **keeper 地址在部署时写入 RC，之后无法更换。** 私钥泄露后攻击者可以伪造 K 线，决定任意一轮成败。这是必须对外披露的信任模型（见 §5）。
4. **keeper 钱包只放 gas，不放 A9。**
5. 资金钱包（treasury、teamWallet、marketingWallet、liquidityWallet、teamInternalWallet）是普通钱包，**没有合约权限**。它们的托管方式不影响协议安全模型，但仍按本手册执行。
6. 可选：treasury 与 teamWallet 使用 Multisig v2（2-of-3）。是否采用由项目方决定（见 §8）。

---

## 1. 权限清单

| 角色 | 地址 | 能做什么 | 不能做什么 | 托管 |
| --- | --- | --- | --- | --- |
| keeper | 部署时写入 RC | OpenRound（0x52540001）、SubmitCandle（0x52540003）；到期后也可 CloseStaking | 不能提现；不能改参数；不能暂停；不能升级；不能更换自身地址 | 服务器受限账户；只放 gas（约 2 TON 起）；见 §3 |
| 任何人 | — | CloseStaking（报名到期后）、AbortTechnical（条件满足后）、RetrySettlement（出现 SettlementBounced 后，≥ 0.3 TON） | 同左，条件不满足时合约 revert | 不适用 |
| treasury | 部署时 mint 的接收地址 | 持有 100 亿，部署时向 RC 转 82 亿，并向内盘、流动性、营销分配 | 分配完成后应归零；无合约权限 | 主网：冷钱包（硬件）；测试网：热钱包 |
| teamWallet | 部署时写入 RC | 接收每个成功轮的 1.2 亿（RC 直接转，最多 10 轮） | 无权限改变团队额度的去向；地址不可在链上更改 | 热钱包，只留小额；大额转冷钱包 |
| marketingWallet | 登记表 | 持有 5 亿，营销支出 | 无合约权限 | 热钱包，小额 |
| liquidityWallet | 登记表 | 持有 5 亿，加池与做市（冷启动池 2 亿 A9 + $232,000 USDT，占 40%；剩余 3 亿后续加池） | 无合约权限 | 热钱包，小额 |
| teamInternalWallet | 登记表 | 持有 8 亿内盘额度，公开可查 | 无合约权限 | 多人共管热钱包 |
| 部署者（deployer） | Acton 项目钱包 | 部署、注资、运维期 gas | 部署完成后不再拥有任何协议权限 | 本地 keystore；部署后降为低频钱包 |

---

## 2. 主网 keeper 钱包的托管要求

由于 keeper 在线、需要定期签名，以下要求**强制**：

1. **主机隔离**：keeper 只运行在专用服务器上，不与公开服务（Worker、前端、公开端点）同机。
2. **访问控制**：SSH 仅允许密钥登录，禁用密码登录；只有运维账号可以登录；最小权限；登录有日志和告警。
3. **出账告警**：keeper 的任何出账都必须告警，并核对是否为 OpenRound 或 SubmitCandle。这是发现密钥被盗的主要手段。无出账时也要有周期性心跳。
4. **定期审计**：每周核对 keeper 钱包的交易历史与预期操作。异常时立即停用，并按事故流程处理。
5. **资产边界**：keeper 只放约 2 TON 的 gas，**不放 A9、USDT 或其他资产**。
6. **不可逆边界**：合约没有 setAdmin，keeper 地址写死在 RC 中。泄露后**没有更换路径**，只能重新部署新协议。
7. **备份**：助记词离线保存至少 2 份，异地存放。恢复演练只在隔离环境进行，禁止录入联网工具或工单。
8. **专用钱包**：keeper 钱包不能与测试网钥匙、部署钱包或任何资金钱包共用。

---

## 3. 资金钱包的托管要求

| 钱包 | 要求 |
| --- | --- |
| treasury | 主网使用硬件冷钱包；只在部署和注资时连接；分配完成后余额应为 0（注资核对见 07 §4.6） |
| teamWallet | 只留运营小额；每个成功轮到账后转入冷钱包；地址公开程度按 §4 |
| marketingWallet / liquidityWallet | 热钱包只留当期支出；大额转冷钱包；加池操作双人复核 |
| teamInternalWallet | 公开可查；操作前公告；多人共管，单人不得动用 |

- 所有钱包的助记词或私钥只离线保存，不进入仓库、CI、截图或聊天记录。
- 冷钱包签名时核对链、地址（首尾与中间）、金额与 opcode。
- 团队、营销、流动性地址不对外公开，只写入内部地址簿。

---

## 4. 地址公开程度

- 公开：JettonMaster、RoundController、RC 的 Jetton 钱包、JettonWallet 代码哈希、teamWallet 的链上地址（RC 会向它转账，链上本来就能看到）。
- 不公开：营销、流动性、内盘的热钱包地址；对外只写“项目方热钱包持有”。
- 对外透明页只使用链上可验证的数字。

> teamWallet 是否在 Worker 与公告中展示，需项目方确认（见 07 §10）。

---

## 5. 信任模型（必须对外披露）

- **单 keeper 热钱包**：开轮与提交 K 线都由它完成，链上无法验证价格真实性。
- **私钥泄露后果**：攻击者可以伪造 K 线，决定任意一轮成败，包括让自己的质押轮次成功、拿走该轮奖励池的份额。合约没有任何人能修改规则或提走资金，但无法防止伪造价格。
- **缓解措施**：keeper 只放少量 gas；服务器加固；所有 K 线以事件公开（含 dataDigest 与滚动哈希 candleHash），任何人可以用公开行情复核；报名窗口不能被提前关闭，因此不能用提前关窗挡住其他人。
- **风险披露**必须包含：单 keeper 信任模型、keeper 无法更换、低于 10 万 A9 且 TON 不足的零头不退。

---

## 6. 上主网前的密钥检查

- [ ] keeper 钱包与测试网钥匙完全独立；生成过程离线进行；双人在场。
- [ ] keeper 地址与 teamWallet 地址核对无误（部署后不可改），并写入签字单。
- [ ] keeper 服务器的访问、监控、出账告警已上线。
- [ ] 资金钱包的冷热分离方案已确定，并写入 07 的签字表。
- [ ] 仓库中没有任何助记词或私钥。
- [ ] 历史仓库问题：`contracts/global.wallets.toml` 中含有测试网 `a9-deployer`、`a9-admin` 的明文助记词。**主网严禁复用这两个钱包**；仓库如果将公开，需先清理历史并轮换。由 Lead 单独处置。

---

## 7. 运营写操作（主网）

| 操作 | 发送者 | 条件 | 双人要求 |
| --- | --- | --- | --- |
| OpenRound（R1 与每一轮） | keeper | 预告结束（R1 为部署后）；twap24h 已双人复核 | 双人核对 target 与 twap |
| SubmitCandle | keeper | 观察期，每小时一根 | 手工补交时双人 |
| CloseStaking | 任何人 | 报名到期后 | 值班人员兜底时双人 |
| AbortTechnical | 任何人 | 条件满足（7 天） | 双人确认后执行并留痕 |
| RetrySettlement | 任何人 | SettlementBounced 出现后 | 按事件执行并留痕 |

---

## 8. 可选：资金钱包使用 Multisig v2

- 适用对象：treasury 与 teamWallet（不适用于 keeper，keeper 必须在线签名）。
- 工具：TON 官方 Multisig v2（2-of-3，硬件钱包签名）。合约不可升级；地址由 code hash 与初始数据决定。
- 工具脚本 ops/scripts/91_deploy_multisig.mjs、92_multisig_order.mjs 是否随 v10 保留，待定（见 07 §10）。
- 费用：部署约 0.0021 TON，propose 与 approve 约 0.002 TON；多签需常备 ≥ 1 TON 作为执行与存储 gas（测试网实测）。
- 注意：订单内容不受限，签名人必须完整解析订单 actions 后再签名。
- 使用多签的前提：先在测试网完整演练一次（缺一签不执行、过期订单、更换签名人）。

---

## 9. 待项目方拍板

1. keeper 的服务器与运维人员由谁负责？
2. treasury 与 teamWallet 是否使用 Multisig v2？若使用，签名人是谁？
3. marketing / liquidity / teamInternal 是否维持热钱包方案？
4. teamWallet 地址是否在 Worker 与公告中展示？
5. 风险披露中 keeper 信任模型的文案，由谁审阅？

---

*本手册与合约 v10 口径一致。合约如有新版本，需先更新本手册，再进入主网流程。*
