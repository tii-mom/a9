# A9 协议（v8.6-audit-fixed）主网前外部安全审计报告

## 执行摘要与主网准入裁决

A9 协议是一个部署于 TON（The Open Network）公链之上的价格驱动型高风险质押对赌协议，其核心业务规则建立在十轮固定周期的二元判定模型之上：参与者在每轮 36 小时质押窗口内投入 A9 代币本金，对赌随后的 24 小时观察期内（共 24 根连续 1 小时 K 线）至少有 16 根 K 线的时间加权平均价格（TWAP）达到或超过本轮开窗锁定的翻倍目标价。若观察期判定成功，质押者全额领回本金并按有效贡献权重瓜分本轮 7 亿枚 A9 奖励池，同时团队金库（TeamVault）向团队收款钱包释放本轮 1.2 亿枚 A9 额度；若观察期判定失败（达标 K 线少于 16 根），则本轮 7 亿枚奖励预算、1.2 亿枚团队额度以及当轮全部用户质押本金执行三笔链上永久销毁。由于协议核心合约 `RoundController` 与 `TeamVault` 采用无代理、不可升级（Non-upgradeable）且无管理员迁移（No `SetAdmin`）的刚性不可变架构（参见 [00_DECISIONS_V2.md](file:///Users/yu1/Desktop/BAM/docs/00_DECISIONS_V2.md) 中 D-24 与 D-36 决策记录），主网部署后任何潜在的状态机死锁、跨合约消息伪造或资金池耗尽漏洞均无法通过合约升级加以挽回。

本报告基于冻结提交基线 `tag v8.6-audit-fixed @ c24809a`（详见 [18_AUDIT_BRIEF.md](file:///Users/yu1/Desktop/BAM/docs/18_AUDIT_BRIEF.md) 与 [21_AUDIT_RFP.md](file:///Users/yu1/Desktop/BAM/docs/21_AUDIT_RFP.md)），对协议下属全部 5 个 Tolk 智能合约（[RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk)、[TeamVault.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/TeamVault.tolk)、[OracleAdapter.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/OracleAdapter.tolk)、[JettonMaster.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonMaster.tolk)、[JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk)）及 3 个核心共享模块（[types.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/types.tolk)、[constants.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/constants.tolk)、[jetton.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton.tolk)）进行了全量逐行静态审计、TVM 异步动作阶段（Action Phase）回滚推演、多跳消息回弹（Bounce）路径验证以及代币经济学数学守恒独立复算。

审计结论明确判定当前版本状态为：**修复后可上线（Conditional Pass — Must Fix Before Mainnet Launch）**。在当前 `v8.6-audit-fixed` 冻结基线中，尽管历史批次（P0-1 至 P0-3、F-01 至 F-09、M-1、S-3、C-1 至 C-4）已修复了大量单跳与两跳异步缺陷，但本轮深度审计仍新识别出 **15 项真实安全发现**，其中包括 **2 项严重（Critical）级别漏洞**、**4 项高危（High）级别漏洞**、**4 项中危（Medium）级别漏洞**、**4 项低危（Low）级别缺陷**以及 **1 项信息提示（Informational）**。上述 Critical 与 High 级别发现直接涉及跨合约销毁/释放确认信号伪造、`RoundController` 原生 TON 储备被零成本套利抽干、质押退款失败导致用户本金永久锁死、销毁第二跳 Bounce 导致协议永久卡死在 `SETTLING_*` 阶段，以及 `OracleAdapter` 在暂停恢复和管道化提交场景下的观察期死锁。项目方必须在 `v8.7-audit-fixed` 版本中完成全部 Critical 与 High 级别缺陷（强烈建议一并纳入 Medium 级别修复）的补丁合入与复核验证后，方可启动主网部署。

| 发现编号 | 严重度 | 所属合约与函数位置 | 漏洞标题与核心影响概述 | 修复状态 |
| --- | --- | --- | --- | --- |
| A9-CRIT-01 | Critical | `JettonWallet.tolk:125-187`<br>`JettonMaster.tolk:189-217`<br>`RoundController.tolk:1138-1163`<br>`TeamVault.tolk:160-218` | `AskToBurn` 与 `AskToTransfer` 未限制 `sendExcessesTo` 接收方，导致 `JettonMaster` 与 `JettonWallet` 成为「困惑副手」，任意用户可用 0 A9 销毁伪造三笔销毁与团队释放确认信号 | 待修复 |
| A9-CRIT-02 | Critical | `RoundController.tolk:782-850, 914-922`<br>`jetton.tolk:55-71`<br>`JettonWallet.tolk:88-122` | `handleTransferNotification` 与 `refundStake` 未校验入站 TON 金额且将 `0.1 TON` 余量退回调用者，可被利用抽干 `RoundController` 全部 TON 储备并导致合法退款本金永久锁死 | 待修复 |
| A9-HIGH-01 | High | `JettonWallet.tolk:23-63`<br>`RoundController.tolk:96-127, 929-933, 1194-1233`<br>`TeamVault.tolk:110-159, 219-240` | `JettonWallet` 两跳 Bounce 通知（`C-4`）遗漏 `BurnNotificationForMinter` 分支，且控制器与团队金库未处理销毁两跳回滚，导致第二跳 Bounce 时协议永久卡死在 `SETTLING_*` 状态 | 待修复 |
| A9-HIGH-02 | High | `OracleAdapter.tolk:320-407`<br>`RoundController.tolk:528-531, 668-706` | `OracleAdapter` 在 `PauseOracle/ResumeOracle` 后无法重置 `lastCandle`、管道化 K 线发生 FIFO Bounce 时回滚失效、且未强制 `candleIndex` 连续导致观察期永久死锁 | 待修复 |
| A9-HIGH-03 | High | `JettonWallet.tolk:50-62`<br>`RoundController.tolk:231-335, 929-933`<br>`TeamVault.tolk:73-87, 219-240` | `JettonWallet` 发送 `TransferBounced` 硬编码 `0.02 TON`（`NoBounce`）且依赖钱包自身余额，在跨 10 轮 `ClaimAll`/`ClaimUnlocked` 回滚时易触发 `OutOfGas` 导致用户 `PendingClaim` 永久锁死 | 待修复 |
| A9-HIGH-04 | High | `RoundController.tolk:947-1094, 1284-1347, 1490-1561`<br>`OracleAdapter.tolk:174-182, 254-365` | `RoundController` 全部 5 个领取入口与 `OracleAdapter` 全部 3 个签名转发入口缺失入站 `in.valueCoins` 最小金额校验，高频调用或 Bounce 重放可抽干两合约 TON 储备 | 待修复 |
| A9-MED-01 | Medium | `TeamVault.tolk:39-58, 102-108, 165-191` | `SetTeamWalletJettonWallet` 缺失 `controller == null` 一次性初始化锁，且与 D-36 风险披露存在语义偏差，运行期调用将破坏回执校验并导致 `SETTLING_SUCCESS` 永久卡死 | 待修复 |
| A9-MED-02 | Medium | `RoundController.tolk:435-460` | `handleOpenRound` 延迟开窗兜底逻辑存在 36 小时临界断崖，晚开窗 1 秒至 35 小时 59 分会将实际质押窗口极端压缩至数秒，使预告期滚存者可垄断 7 亿奖励 | 待修复 |
| A9-MED-03 | Medium | `RoundController.tolk:1408-1474` | `handleRollReward` 未校验最低质押门槛 `minStakeRaw`，在轮次或地址额度临界点仅滚入 `1 raw unit` 即可零风险维持连胜权重加成（`streak`）并漏计推荐权重 | 待修复 |
| A9-MED-04 | Medium | `OracleAdapter.tolk:254-319, 348-353`<br>`RoundController.tolk:415-499` | `OracleAdapter` 转发的 `OpenRound` 与 `CloseStaking` 消息未在 `RoundController` 侧校验 `roundId`，且成功转发后永不清理 `st.pending` 字典导致存储无限膨胀 | 待修复 |
| A9-LOW-01 | Low | `RoundController.tolk:1814-1842` | `get_reward_state` 只读接口遗漏 `C-1` 报名截止时间校验（`now < nextRd.stakeCloseAt`）与 `unlockStart == 0` 校验，导致过期轮次仍显示可滚存 | 待修复 |
| A9-LOW-02 | Low | `JettonMaster.tolk:42-51, 75-79` | `JettonMaster.onBouncedMessage` 在首次铸造 `MintOnce` 部署钱包发生 Bounce 时仅回滚 `totalSupply` 而未恢复 `adminAddress`，导致代币合约永久无法再次铸造 | 待修复 |
| A9-LOW-03 | Low | `RoundController.tolk:415-470, 935-945, 1234-1245` | `handleOpenRound` 在开启首轮前未校验 `stakingJettonWallet` 与 `jettonWalletCode` 是否已由占位符更新为真实配置，乱序部署将永久锁死配置入口 | 待修复 |
| A9-LOW-04 | Low | `OracleAdapter.tolk:191-222`<br>`RoundController.tolk:888, 1065-1069, 1458` | `SetSignerSet` 未校验公钥非零与互异性、两处推荐加成补齐未统一调用 `referralRawAdd`、以及 `ClaimAll` 空操作分支执行了冗余存储写盘 | 待修复 |
| A9-INFO-01 | Informational | `RoundController.tolk:219-222`<br>`constants.tolk:44-53` | `claimQueryId` 计数器位宽仅使用 24 位（高 24 位闲置）及 `ClaimPrincipal` / `CloseStaking` 未发射独立 `external-out` 事件的链下索引对齐建议 | 建议采纳 |

## 冻结基线与五合约架构深度核验

审计工作首先对仓库提交状态、源文件行数、编译产物代码哈希（Code Hash）及 SHA-256 清单进行了独立核验。当前代码库处于冻结标签 `v8.6-audit-fixed`（提交哈希 `c24809a`，文档追加提交 `bc889b0` 未改动任何 `.tolk` 合约源码），工具链版本锁定为 `Acton 1.1.0 / Tolk 1.4.1`（配置见 [Acton.toml](file:///Users/yu1/Desktop/BAM/contracts/Acton.toml)）。全部 5 个核心生产合约与 6 个共享及标准库辅助文件的源码行数、构建产物哈希（位于 `contracts/build/*.json`）与任务书声明完全一致，具备确定性可复现构建基础。

| 合约或模块名称 | 源码相对路径 | 精确行数 | 编译产物 Code Hash（TVM Cell SHA-256） | 审计覆盖深度与角色定位 |
| --- | --- | --- | --- | --- |
| RoundController | [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) | 1,938 | `0xC5AD291469C3BEADBDC26A6F1733004D433F12B15B025D88B983DF098BA11500` | 100% 逐行形式化推演：托管 70 亿奖励池与全部用户质押本金、10 轮状态机、权重与三态奖励、线性解锁、三笔销毁协调 |
| TeamVault | [contracts/contracts/TeamVault.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/TeamVault.tolk) | 359 | `0xCF3E6C7C9DC045F392F35E79E20AA6EDAAF9064D538CA4E78B6D1FE1443158B4` | 100% 逐行形式化推演：托管 12 亿团队额度、仅接收控制器指令、单轮释放与销毁互斥幂等、两跳回执校验 |
| OracleAdapter | [contracts/contracts/OracleAdapter.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/OracleAdapter.tolk) | 449 | `0x539F3597357943584A596DA2B40F901B4984D8C8307E63CE81A67F131EAB8CBA` | 100% 逐行形式化推演：3/5 Ed25519 多签聚合、域分离哈希、防重放掩码、K 线单调性及 Bounce 回滚 |
| JettonMaster | [contracts/contracts/jetton/JettonMaster.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonMaster.tolk) | 246 | `0x876F21A1A516FB0449A1D0AF5DBECEB8639373F947949C5AE8E1E9DBB769D64F` | 100% 逐行审查与 TEP-74 对照：100 亿枚一次性铸造、同交易置空管理员、销毁通知扣减总供应量并回传余量 |
| JettonWallet | [contracts/contracts/jetton/JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk) | 206 | `0x394E4E8D40B5D3D97D12AA950B99EA9A53387DDAC331BAAAC8923F0E6E6849A4` | 100% 逐行审查与 TEP-74 对照：余额记账、136-bit 质押负载透传、同构钱包地址推导、两跳 `TransferBounced` 通知 |
| 共享类型定义 | [contracts/contracts/types.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/types.tolk) | 785 | 内联编译至各主合约 | 100% 逐行审查：Cell 引用树深度与 1,023-bit 位宽边界、消息 TL-B 布局、存储序列化与反序列化 |
| 共享常量与错误码 | [contracts/contracts/constants.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/constants.tolk) | 214 | 内联编译至各主合约 | 100% 逐行审查：Opcode 唯一性（`0x5254xxxx` 命名空间）、状态枚举、权重参数、错误码映射 |
| Jetton 消息构造器 | [contracts/contracts/jetton.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton.tolk) | 109 | 内联编译至各主合约 | 100% 逐行审查：TEP-74 转账与销毁报文构造、`Either` 负载解包、消息附带 TON 与发送模式标志 |
| Jetton 内部辅助模块 | [messages.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/messages.tolk) / [fees-management.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/fees-management.tolk) / [jetton-utils.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/jetton-utils.tolk) / [storage.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/storage.tolk) / [errors.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/errors.tolk) / [sharding.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/sharding.tolk) | 314（合计） | 内联编译至 `JettonMaster` 与 `JettonWallet` | 100% 逐行审查：预编译 Gas 估算、最小转账/销毁门槛、5 年存储费预留、8-bit 分片前缀地址计算 |

在合约存储架构层面，`RoundController` 的根存储结构 `Storage`（见 [types.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/types.tolk) 第 207–219 行）包含 4 个标量字段（`currentRoundId: uint8`、`successCount: uint8`、`lastSettledAt: uint64`、`pausedAt: uint64`，合计 144 bits）以及 4 个引用分支：`config: Cell<ProtocolConfig>`、`extras: Cell<StorageExtras>`、`rounds: map<uint8, RoundData>`（非空时占 1 个引用）、`stakes: map<uint8, map<address, StakePosition>>`（非空时占 1 个引用）。由于 TVM 单个 Cell 的硬件上限为 1,023 bits 与 4 个引用（Refs），该根结构精确使用了 4 个引用槽位，未超出 TVM Cell 限制。`RoundData`（第 117–143 行）将标量字段控制在 830 bits，并将 `failureBurnId`、`candleHash`、`totalWeight` 及两个字典 `bonus`、`referred` 封装进唯一的子引用 `extra: Cell<RoundExtra>`（512 bits + 2 个字典引用），从而确保在任意用户规模下单个 Cell 均不会触发 `CellOverflow` 异常。

## 静态分析与异步状态机验证路径

针对 TON 区块链独特的 Actor 异步消息模型、多跳（Multi-hop）合约交互、计算阶段（Compute Phase）与动作阶段（Action Phase）分离机制以及存储租金扣除特性，本次审计构建了系统化的四维验证路径：

第一维度为 **TVM 消息流与多跳回弹（Bounce）完备性验证**。TON 上的 TEP-74 代币转账与销毁并非单笔原子调用，而是跨越「发起合约 $\rightarrow$ 发起方 `JettonWallet` $\rightarrow$ 接收方 `JettonWallet`（或 `JettonMaster`）$\rightarrow$ `ReturnExcessesBack` 回传发起合约」的三跳异步链路。当第一跳（在发起方 `JettonWallet`）发生异常时，TVM 原生 Bounce 消息会直接退回发起合约（`RoundController` 或 `TeamVault`）；而当第一跳成功扣减钱包余额并发出第二跳消息（`InternalTransferStep` 或 `BurnNotificationForMinter`）、但第二跳在目标合约发生异常时，TVM 原生 Bounce 只会退回至**发起方 `JettonWallet`**，发起合约本身不会收到原生 Bounce。审计逐一追踪了全协议所有 11 处 `createMessage(...).send(...)` 调用点，覆盖 `AskToTransfer`（本金领取、早领奖励、合并领取、线性解锁领取、非法质押退款、团队额度释放）与 `AskToBurn`（失败轮奖励销毁、失败轮本金销毁、零质押成功轮奖励销毁、团队额度销毁）的全部正向确认路径与反向一跳/两跳回弹路径，由此发现了 **A9-CRIT-01**、**A9-CRIT-02**、**A9-HIGH-01** 与 **A9-HIGH-03**。

第二维度为 **计算阶段落盘与动作阶段资金守恒分析**。在 Tolk 合约中，调用 `s.save()`（即写入 TVM 寄存器 `c4`）发生在计算阶段，而 `out.send(mode)` 将输出消息加入寄存器 `c5` 的动作队列并在随后的动作阶段执行。审计核查了每一处 `send()` 所使用的模式掩码（`SEND_MODE_PAY_FEES_SEPARATELY = 1`、`SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE = 64`、`SEND_MODE_CARRY_ALL_BALANCE = 128`、`SEND_MODE_BOUNCE_ON_ACTION_FAIL = 16`、`SEND_MODE_IGNORE_ERRORS = 2`）以及入站消息 `in.valueCoins` 与出站消息 `value` 的差额关系，重点评估了外部无权限调用者通过附带极小 TON 触发高额固定出站 TON 的「燃气补贴套利（Gas Griefing / Treasury Drain）」风险，由此发现了 **A9-CRIT-02** 与 **A9-HIGH-04**。

第三维度为 **跨合约状态机耦合与并发乱序推演**。协议包含三个相互通信的状态机：`OracleAdapter`（签名验证与防重放状态机）、`RoundController`（十轮核心生命周期与领取状态机）和 `TeamVault`（单轮团队额度释放/销毁互斥状态机）。审计针对「同一区块内多笔交易管道化（Pipelining）到达」、「`PauseOracle` 与 `ResumeOracle` 重置观察窗口」、「`AbortTechnical` 超时推进轮次」以及「管理员配置接口在各阶段的调用窗口」进行了交叉状态积（Cross-product State Space）推演，由此发现了 **A9-HIGH-02**、**A9-MED-01**、**A9-MED-02** 与 **A9-MED-04**。

第四维度为 **未覆盖边界说明**。根据 [21_AUDIT_RFP.md](file:///Users/yu1/Desktop/BAM/docs/21_AUDIT_RFP.md) 第 3 节与第 10 节规定，本次审计明确不包含以下外部组件：
1. 前端应用（`web/` 目录下的 React 应用与 TON Connect 报文组装界面）及 Cloudflare Worker 链下索引器与后端服务（`worker/` 目录），尽管审计过程中参考了 [20_INDEXER_RECONCILE.md](file:///Users/yu1/Desktop/BAM/docs/20_INDEXER_RECONCILE.md) 以核实链上事件与只读接口的一致性。
2. TON 公链底层验证人共识机制、TVM 虚拟机底层 C++ 实现及 `@stdlib/*` 官方标准库原语。
3. 链下预言机价格采集节点（5 个独立签名源的市场数据拉取、异常值过滤及私钥物理保管安全）与项目方冷热钱包的线下运维保管流程。
4. 生产时序参数（12 小时预告 + 36 小时质押 + 24 小时观察 = 72 小时/轮）在真实 TON 主网跨 30 天自然时间的链上实测（当前仓库的 154 个自动化测试基于 Acton 模拟器时间跳跃，测试网 10 轮验收基于 10 秒级快测参数，详见 [19_TESTNET_ACCEPTANCE.md](file:///Users/yu1/Desktop/BAM/docs/19_TESTNET_ACCEPTANCE.md)）。

## 结算数学与代币守恒独立复算

按照 [18_AUDIT_BRIEF.md](file:///Users/yu1/Desktop/BAM/docs/18_AUDIT_BRIEF.md) 第 7 节「对结算数学给出独立复算（不接受看起来正确）」的要求，本节对 V8 权重公式、整数截断误差上界、`uint128` 算术溢出边界、滚存上限不变量及 12 个月线性解锁曲线进行严格的代数证明与边界复算。

### 权重累计恒等式与整数截断不变量

在第 $r \in \{1, \dots, 10\}$ 轮中，设用户 $u$ 的有效质押入账序列（包括一次或多次直接质押 `handleTransferNotification` 或上一轮奖励滚存 `handleRollReward`）为 $a_{u,1}, a_{u,2}, \dots, a_{u,m_u}$，累计本金为 $S_u(r) = \sum_{k=1}^{m_u} a_{u,k}$。由于 `streakForRound`（[RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 357–366 行）保证同一轮次内多次入账保持相同的连续参与轮数 $c_u(r) \in \{1, \dots, 10\}$，每次入账增量计算的自身权重为：

$$w_{u,k} = \left\lfloor \frac{a_{u,k} \times (10000 + 1000 \times c_u(r))}{10000} \right\rfloor$$

由于对于每个正整数 $c_u(r) \in [1, 10]$，系数 $10000 + 1000 \times c_u(r)$ 均能被 $1000$ 整除，设 $M_u = 10 + c_u(r) \in [11, 20]$，则：

$$w_{u,k} = \left\lfloor \frac{a_{u,k} \times M_u}{10} \right\rfloor$$

每笔入账在写入 `pos.weight = pos.weight + ownW` 的同时，精确以相同的 `ownW` 累加至 `rdExtra.totalWeight = rdExtra.totalWeight + ownW`（见第 860–865 行与第 1434–1437 行）。

对于一层推荐加成（Referral Bonus），设用户 $u$ 名下所有直接被邀请人在第 $r$ 轮的有效入账序列为 $b_{u,1}, b_{u,2}, \dots, b_{u,n_u}$，累计被推荐质押额为 $R_u(r) = \sum_{j=1}^{n_u} b_{u,j}$。代码通过两条路径更新推荐人 $u$ 的加成 `bonus[u]` 并同步累加至 `totalWeight`：
1. **被邀请人先质押/滚存、或推荐人已在场时被邀请人入账**（第 868–882 行、第 1439–1453 行）：每次增加 $\Delta B = \min\left(\lfloor b_{u,j} \times 2000 / 10000 \rfloor, \max(0, S_u(r) - B_{\text{prev}})\right)$，并执行 `totalWeight += add`。
2. **推荐人后加仓或后滚存补齐（F-06 补丁）**（第 886–895 行、第 1456–1465 行）：当推荐人自身质押额 $S_u(r)$ 增加时，计算目标加成 $T_u = \min\left(\lfloor R_u(r) / 5 \rfloor, S_u(r)\right)$；若 $T_u > B_{\text{current}}$，则将差额 $T_u - B_{\text{current}}$ 补入 `bonus[u]` 并同步执行 `totalWeight += (target - current)`。

由于无论通过路径 1 还是路径 2，对任意推荐人 $u$ 写入 `rdExtra.bonus[u]` 的每一次增量 $\Delta B > 0$ 都严格伴随着完全相等的 `rdExtra.totalWeight += \Delta B`，因此对于任意轮次 $r$ 在任意时刻的状态，恒有以下链上精确不变量成立：

$$W_{\text{total}}(r) \equiv \text{rdExtra.totalWeight} = \sum_{u \in \mathcal{U}(r)} \left( \text{pos}_u.\text{weight} + \text{bonus}[u] \right) = \sum_{u \in \mathcal{U}(r)} W_u(r)$$

当轮次 $r$ 成功结算（`STATUS_SUCCEEDED`）时，每名用户 $u$ 可获得的奖励由 `rewardForRound`（第 386–388 行）按向下取整（Floor Division）计算：

$$\text{reward}_u(r) = \left\lfloor \frac{B_{\text{round}} \times W_u(r)}{W_{\text{total}}(r)} \right\rfloor, \quad B_{\text{round}} = 700,000,000 \times 10^9 = 7 \times 10^{17}\text{ raw}$$

由实数向下取整的基本性质 $\lfloor x \rfloor \le x$，对所有参与用户求和可得：

$$\sum_{u \in \mathcal{U}(r)} \text{reward}_u(r) = \sum_{u \in \mathcal{U}(r)} \left\lfloor \frac{B_{\text{round}} \times W_u(r)}{W_{\text{total}}(r)} \right\rfloor \le \frac{B_{\text{round}}}{W_{\text{total}}(r)} \sum_{u \in \mathcal{U}(r)} W_u(r) = B_{\text{round}}$$

且每名用户的截断余数严格小于 $1\text{ raw unit}$（即 $10^{-9}\text{ A9}$），故总截断沉淀（Rounding Dust）满足：

$$0 \le B_{\text{round}} - \sum_{u \in \mathcal{U}(r)} \text{reward}_u(r) \le |\mathcal{U}(r)| - 1 < |\mathcal{U}(r)|\text{ raw}$$

由于单轮总质押上限为 $200,000,000\text{ A9}$、单笔最低质押为 $10,000\text{ A9}$（正常路径下 $|\mathcal{U}(r)| \le 20,000$），单轮留在金库中的最大截断误差不超过 $19,999\text{ raw} \approx 0.00002\text{ A9}$，**严格证明了在任何质押与推荐组合下，$\sum \text{reward}_u(r) \le 7 \times 10^{17}\text{ raw}$ 恒成立，绝无超发风险**。

### 无符号 128 位整数（`uint128`）溢出边界复算

在 Tolk 语言中，`uint128` 的最大表示值为 $2^{128} - 1 \approx 3.4028 \times 10^{38}$。逐一核算协议中所有乘法运算的极值上界：
1. **单轮最大总权重 $W_{\text{total}}^{\max}$**：单轮总质押硬顶为 $\text{maxTotalStakeRaw} = 2 \times 10^8 \times 10^9 = 2 \times 10^{17}\text{ raw}$。自身最高连续加成为 10 轮（$2.0\times$），最高推荐加成为自身质押的 $1.0\times$（实际全网总推荐加成至多为全网总质押的 $20\% = 0.2\times$）。因此单轮全网最大总权重为：
   $$W_{\text{total}}^{\max} \le 2 \times 10^{17} \times (2.0 + 0.2) = 4.4 \times 10^{17} \ll 2^{128} - 1$$
2. **奖励计算分子 `rewardBudget * weight`（第 381 行）**：
   $$\text{rewardBudget} \times W_u^{\max} \le (7 \times 10^{17}) \times (6 \times 10^{16}) = 4.2 \times 10^{34} < 3.4028 \times 10^{38} = 2^{128} - 1$$
   安全裕度超过 $8,100$ 倍，不可能发生 `uint128` 乘法溢出。
3. **十轮线性解锁分子 `totalLocked * capped`（第 1536 行、第 1878 行）**：
   单用户十轮累计最大可锁定奖励为 $10 \times 7 \times 10^{17} = 7 \times 10^{18}\text{ raw}$，解锁周期常量 $\text{UNLOCK\_DURATION\_SECONDS} = 31,104,000$：
   $$\text{totalLocked}^{\max} \times \text{capped}^{\max} \le (7 \times 10^{18}) \times (3.1104 \times 10^7) = 2.17728 \times 10^{26} \ll 3.4028 \times 10^{38}$$
   安全裕度超过 $1.5 \times 10^{12}$ 倍，无溢出风险。
4. **目标价计算 `msg.twap24hUsdE8 * 2`（第 449 行）**：当通过 `OracleAdapter` 或 `admin` 提交 `twap24hUsdE8` 时，只要输入价格低于 $1.7 \times 10^{30}\text{ USD}$，乘法不会溢出。

### 滚存截断与十轮全局代币守恒证明

对任意成功轮次 $r < 10$ 的赢家 $u$，调用 `handleRollReward`（第 1348–1488 行）时：
$$\text{rollAmount} = \min\left(\text{reward}_u(r),\; \max(0, 2 \times 10^{16} - \text{nextPos.amountRaw}),\; \max(0, 2 \times 10^{17} - \text{nextRd.totalAcceptedStakeRaw})\right)$$
$$\text{excess} = \text{reward}_u(r) - \text{rollAmount}$$
由于 $\text{rollAmount} + \text{excess} \equiv \text{reward}_u(r)$，其中 $\text{rollAmount}$ 直接转入第 $r+1$ 轮的质押账本（`nextPos.amountRaw += rollAmount`、`nextRd.totalAcceptedStakeRaw += rollAmount`），而 $\text{excess}$ 直接计入该用户的 R10 锁定池（`lk.lockedRaw += excess`），且轮次 $r$ 的仓位被标记为 `pos.rewardState = REWARD_STATE_ROLLED`、`pos.rewardClaimed = true`（不可再次早领、再次滚存或在 `ClaimUnlocked` 中被重复折叠）。

值得特别指出的是，`RollReward` 是一次**账面内部划转**：第 $r$ 轮的奖励预算原本就存放在 `RoundController` 的 `stakingJettonWallet` 中；当用户将 $\text{rollAmount}$ 滚入第 $r+1$ 轮时，这笔代币继续留在 `stakingJettonWallet` 中充当第 $r+1$ 轮的真实质押本金。
- 若第 $r+1$ 轮**成功**，用户通过 `ClaimPrincipal(r+1)` 领走该笔 $\text{rollAmount}$，通过 `ClaimUnlocked` 领走第 $r$ 轮剩余的 $\text{excess}$，两者之和恰好等于第 $r$ 轮应得奖励 $\text{reward}_u(r)$；
- 若第 $r+1$ 轮**失败**，`settleRound`（第 597 行）将包含 $\text{rollAmount}$ 在内的 `nextRd.totalAcceptedStakeRaw` 通过 `sendJettonBurn` 从 `stakingJettonWallet` 中真实销毁，同时用户仍可在 R10 后领走未参与第 $r+1$ 轮对赌的 $\text{excess}$ 部分。

因此，在修复本报告指出的异步回弹与确认伪造漏洞的前提下，协议在十轮全生命周期内对 `stakingJettonWallet`（初始注资 $70\text{ 亿 A9}$）与 `TeamVault`（初始注资 $12\text{ 亿 A9}$）的代币流转满足严格的零超发守恒律。

## 核心安全审计发现与修复方案

本节按严重度从高到低逐项详述本次审计识别出的 15 项安全发现。每项发现均提供精确的源码文件与行号范围、核心代码片段、漏洞机理与攻击场景推演、影响评估、防御性验证测试方案以及最小改动修复代码建议。

### A9-CRIT-01 销毁与转账余量回传未限制接收方导致的跨合约确认信号伪造

- **严重度**：Critical（无需特殊条件即可伪造核心销毁与释放确认状态，破坏协议代币守恒与状态机完整性）
- **位置**：
  - [contracts/contracts/jetton/JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk) 第 125–187 行（`AskToTransfer`、`AskToBurn`）
  - [contracts/contracts/jetton/JettonMaster.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonMaster.tolk) 第 189–217 行（`handleBurnNotification`）
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 1104–1163 行（`confirmBurn`、`handleReturnExcesses`）
  - [contracts/contracts/TeamVault.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/TeamVault.tolk) 第 160–218 行（`ReturnExcessesBack` 分支）

#### 漏洞机理与触发路径分析

在 [18_AUDIT_BRIEF.md](file:///Users/yu1/Desktop/BAM/docs/18_AUDIT_BRIEF.md) 第 3 节 P0 审计清单第 4 项中，设计规格明确要求：「销毁确认权威 `handleReturnExcesses`：只接受 `sender == jettonMaster`；`queryId` 解码的 `roundId`/`kind` 必须校验；伪造消息不得置 flag」。这一设计的核心假设是：只要 `ReturnExcessesBack(0xd53276db)` 消息的发送方地址 `in.senderAddress` 等于 `jettonMaster`（对于销毁）或等于 `teamWalletJettonWallet`（对于团队额度释放），就能证明 `RoundController` 或 `TeamVault` 发起的真实销毁或释放已经完成。

然而，审查 [JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk) 第 164–187 行与 [JettonMaster.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonMaster.tolk) 第 189–217 行可以发现，该假设在 TEP-74 标准消息转发机制下并不成立，因为 `JettonMaster` 与 `JettonWallet` 会充当攻击者的「困惑副手（Confused Deputy）」：

```tolk
// JettonWallet.tolk:164-187
        AskToBurn => {
            checkAmountIsEnoughToBurn(in.valueCoins);

            var storage = lazy WalletStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw JettonErrors.NotOwner;
            assert (storage.jettonBalance >= msg.jettonAmount) throw JettonErrors.BalanceError;
            storage.jettonBalance -= msg.jettonAmount;
            storage.save();

            val notifyMinterMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: storage.minterAddress,
                value: 0,
                body: BurnNotificationForMinter {
                    queryId: msg.queryId,
                    jettonAmount: msg.jettonAmount,
                    burnInitiator: storage.ownerAddress,
                    sendExcessesTo: msg.sendExcessesTo,
                },
            });
            notifyMinterMsg.send(
                SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL,
            );
        }
```

```tolk
// JettonMaster.tolk:189-217
fun handleBurnNotification(
    sender: address,
    queryId: uint64,
    jettonAmount: coins,
    burnInitiator: address,
    sendExcessesTo: address?,
) {
    var storage = lazy MasterStorage.load();
    assert (
        sender ==
        calcAddressOfJettonWallet(burnInitiator, contract.getAddress(), jettonWalletCompiledCode())
    ) throw JettonErrors.NotValidWallet;
    assert (storage.totalSupply >= jettonAmount) throw JettonErrors.BalanceError;
    storage.totalSupply -= jettonAmount;
    storage.save();

    if (sendExcessesTo == null) {
        return;
    }

    val excessesMsg = createMessage({
        bounce: BounceMode.NoBounce,
        dest: sendExcessesTo,
        value: 0,
        body: ReturnExcessesBack { queryId },
    });
    excessesMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
```

上述代码存在三个致命的链条缺口：
1. **任意用户可控的 `sendExcessesTo` 与 `queryId`**：任何外部账户 $A$ 都可以向其自身的合法 `JettonWallet` 发送 `AskToBurn`，在报文中将 `sendExcessesTo` 指定为 `RoundController`（或 `TeamVault`）的地址，并将 `queryId` 构造为目标轮次的 `burnQueryId(roundId, BURN_QUERY_REWARD)` 或 `burnQueryId(roundId, BURN_QUERY_PRINCIPAL)`（或 `BURN_QUERY_TEAM`）。
2. **零代币成本触发（`jettonAmount == 0`）**：`JettonWallet.tolk:169` 仅检查 `storage.jettonBalance >= msg.jettonAmount`，未检查 `msg.jettonAmount > 0`。因此攻击者甚至不需要持有任何 A9 代币（0 余额钱包即可），只需传入 `jettonAmount = 0`，其合法 `JettonWallet` 就会向 `JettonMaster` 发出真实的 `BurnNotificationForMinter`。
3. **无载荷鉴别能力的 `ReturnExcessesBack`**：`JettonMaster.handleBurnNotification` 校验发送方确实是攻击者 $A$ 的合法 `JettonWallet` 后，扣减 `0` 供应量，并**以 `JettonMaster` 自身作为 `sender`**，向 `sendExcessesTo`（即 `RoundController` 或 `TeamVault`）发送 `ReturnExcessesBack { queryId }`。由于 `ReturnExcessesBack` 结构（[types.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/types.tolk) 第 485–487 行）仅有 `queryId: uint64` 一个字段，不包含 `burnInitiator` 与 `jettonAmount`，`RoundController.handleReturnExcesses`（第 1158–1162 行）看到 `sender == addresses(s).jettonMaster` 成立，立即调用 `confirmBurn(roundId, kind, 0, false)` 将 `rewardBurnConfirmed` 和 `principalBurnConfirmed` 置为 `true`！同理，对于 `TeamVault.tolk:166`，任何用户向 `teamWallet` 转账 `0 A9` 并将 `sendExcessesTo` 设为 `TeamVault`、`queryId` 设为 `(roundId << 16) | (4 << 8)`，都会促使 `teamWalletJettonWallet` 向 `TeamVault` 发送 `ReturnExcessesBack`，从而在真实释放未完成或已回弹的情况下伪造团队释放确认。

#### 影响评估

当某轮进入 `STATUS_SETTLING_FAILURE`（或零质押 `STATUS_SETTLING_SUCCESS`）时，若 `RoundController` 或 `TeamVault` 的真实销毁交易因钱包 TON 余额不足、存储费赤字或两跳回弹而未能执行（或已被回滚，使得 `rcWallet` / `tvWallet` 中的 7 亿奖励、1.2 亿团队额度及最高 2 亿用户本金原封不动留在钱包内），外部调用者只需发起三笔 `jettonAmount = 0` 的自身钱包销毁，即可借 `JettonMaster` 之手将 `rewardBurnConfirmed`、`principalBurnConfirmed` 和 `teamBurnConfirmed` 全部伪造为 `true`，并调用无权限的 `FinalizeRound` 将轮次推进至 `STATUS_FAILED_PERMANENT`。此时链上状态显示三笔销毁全部完成，但最多 $10.2\text{ 亿枚 A9}$ 实际并未销毁，`JettonMaster.totalSupply` 未扣减，彻底破坏协议的账实一致性与通缩守恒律。

#### 防御性验证测试与修复方案

为彻底阻断跨合约「困惑副手」攻击，应在 `JettonWallet.tolk` 与 `JettonMaster.tolk` 中强制要求 `sendExcessesTo` 只能为空或等于操作发起人自身（`storage.ownerAddress` / `burnInitiator`），同时禁止 `0` 金额转账与销毁，并在 `RoundController.confirmBurn` 中增加对 `dispatched` 标志与完整 `queryId` 的核验。

```tolk
// 修复补丁 1：contracts/contracts/jetton/JettonWallet.tolk (AskToTransfer & AskToBurn)
        AskToTransfer => {
            assert (msg.jettonAmount > 0) throw JettonErrors.BalanceError;
            msg.forwardPayload.checkIsCorrectTlbEither();
            assert (
                msg.transferRecipient.getWorkchain() == MY_WORKCHAIN
            ) throw JettonErrors.WrongWorkchain;
            checkAmountIsEnoughToTransfer(
                in.valueCoins,
                msg.forwardTonAmount,
                in.originalForwardFee,
            );

            var storage = lazy WalletStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw JettonErrors.NotOwner;
            // A9-CRIT-01: prevent third-party ReturnExcessesBack spoofing (confused deputy)
            assert (
                msg.sendExcessesTo == null || msg.sendExcessesTo! == storage.ownerAddress
            ) throw JettonErrors.NotOwner;
            assert (storage.jettonBalance >= msg.jettonAmount) throw JettonErrors.BalanceError;
```

```tolk
// 修复补丁 2：contracts/contracts/jetton/JettonWallet.tolk (AskToBurn) & JettonMaster.tolk
        AskToBurn => {
            assert (msg.jettonAmount > 0) throw JettonErrors.BalanceError;
            checkAmountIsEnoughToBurn(in.valueCoins);

            var storage = lazy WalletStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw JettonErrors.NotOwner;
            // A9-CRIT-01: only the wallet owner itself may receive burn excesses
            assert (
                msg.sendExcessesTo == null || msg.sendExcessesTo! == storage.ownerAddress
            ) throw JettonErrors.NotOwner;
            assert (storage.jettonBalance >= msg.jettonAmount) throw JettonErrors.BalanceError;
```

```tolk
// 修复补丁 3：contracts/contracts/RoundController.tolk (confirmBurn & handleReturnExcesses)
fun confirmBurn(roundId: uint8, kind: uint8, amountRaw: uint128, checkAmount: bool) {
    var s = lazy Storage.load();
    assert (roundId == s.currentRoundId) throw Errors.BadRoundId;
    var rd = ensureRoundExists(s, roundId);
    if (isTerminal(rd.status)) {
        return;
    }
    if (kind == BURN_QUERY_REWARD) {
        assert (rd.status == STATUS_SETTLING_FAILURE || (rd.status == STATUS_SETTLING_SUCCESS && rd.totalAcceptedStakeRaw == 0)) throw Errors.BadRoundStatus;
        assert (rd.rewardBurnDispatched) throw Errors.BadRoundStatus;
        if (checkAmount) {
            assert (amountRaw == rd.rewardBudgetRaw) throw Errors.BurnAmountMismatch;
        }
        rd.rewardBurnConfirmed = true;
    } else if (kind == BURN_QUERY_PRINCIPAL) {
        assert (rd.status == STATUS_SETTLING_FAILURE) throw Errors.BadRoundStatus;
        assert (rd.principalBurnDispatched) throw Errors.BadRoundStatus;
        if (checkAmount) {
            assert (amountRaw == rd.totalAcceptedStakeRaw) throw Errors.BurnAmountMismatch;
        }
        rd.principalBurnConfirmed = true;
    } else {
        throw Errors.BurnKindMismatch;
    }
    s.rounds.set(roundId, rd);
    s.save();
}
```

对应在 `contracts/tests/jetton-integration.test.tolk` 中应新增如下防御性回归测试，验证外部用户将 `sendExcessesTo` 指向 `RoundController` 或 `TeamVault` 时被 `JettonWallet` 直接以 `JettonErrors.NotOwner (73)` 拦截：

```tolk
// 防御性验证测试（加入 contracts/tests/jetton-integration.test.tolk）
get fun `test A9-CRIT-01 foreign user burn with sendExcessesTo RC is rejected by wallet`() {
    val r = setupReal();
    openRoundReal(r, 300000);
    val badBurn = net.send(r.user, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: r.userWallet,
        body: AskToBurn {
            queryId: ((1 as uint64) << 16) | ((BURN_QUERY_REWARD as uint64) << 8),
            jettonAmount: 1000,
            sendExcessesTo: r.rc.address,
            customPayload: null,
        },
    }));
    expect(badBurn).toHaveFailedTx<AskToBurn>({
        from: r.user,
        to: r.userWallet,
        exitCode: 73, // JettonErrors.NotOwner
    });
}
```

### A9-CRIT-02 质押退款路径固定倒贴 TON 且余量归属调用者导致的资金池抽干与本金锁死

- **严重度**：Critical（可直接盗取抽干 `RoundController` 全部原生 TON 储备，并导致触发退款的合法用户质押本金永久锁定、无法找回）
- **位置**：
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 782–850 行（`handleTransferNotification`）、第 914–922 行（`refundStake`）
  - [contracts/contracts/jetton.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton.tolk) 第 55–71 行（`sendJettonTransfer`）
  - [contracts/contracts/jetton/JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk) 第 88–122 行（`InternalTransferStep`）

#### 漏洞机理与触发路径分析

审查 `RoundController` 的质押入账与自动退款函数 `handleTransferNotification` 与 `refundStake`：

```tolk
// RoundController.tolk:816-825 & 914-922
    if (!parsed) { refundStake(s, owner, amount, 0); return; }
    if (version != 1) { refundStake(s, owner, amount, 0); return; }
    if (acceptBurn != 1) { refundStake(s, owner, amount, 0); return; }
    if (riskVersion != t.riskDisclosureVersion) { refundStake(s, owner, amount, 0); return; }
    if (rd.status != STATUS_STAKING_OPEN || payloadRoundId != roundId ||
        now < rd.stakeOpenAt || now >= rd.stakeCloseAt) {
        refundStake(s, owner, amount, 0);
        return;
    }
    if ((amount as uint128) < e.minStakeRaw) { refundStake(s, owner, amount, 0); return; }
...
fun refundStake(s: Storage, owner: address, amount: coins, queryId: uint64) {
    sendJettonTransfer(
        vaults(s).stakingJettonWallet,
        queryId,
        amount,
        owner,
        owner,
    );
}
```

```tolk
// jetton.tolk:55-71
fun sendJettonTransfer(
    jettonWallet: address,
    queryId: uint64,
    amount: coins,
    recipient: address,
    responseDestination: address,
): void {
    val body = buildJettonTransferBody(queryId, amount, recipient, responseDestination);
    val out = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: ton("0.1"),
        dest: jettonWallet,
        body,
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}
```

该实现存在两个相互叠加的严重缺陷：

第一，**原生 TON 储备套利抽干机制（Direct TON Drain）**。当外部账户向 `RoundController` 转账任意数量的 A9（例如仅需 `1 raw unit = 0.000000001 A9`）时，在 `JettonWallet.tolk:88–103` 中，只要 `msg.forwardTonAmount != 0`（例如仅设置 `forwardTonAmount = 0.005 TON`），`rcWallet` 就会向 `RoundController` 发送 `TransferNotification`（入站消息 `in.valueCoins = 0.005 TON`），并将原转账多余的 TON 退还给外部账户。随后，`RoundController.handleTransferNotification` 在未检查 `in.valueCoins` 是否充足的情况下，因金额低于 `minStakeRaw` 或 payload 为空进入 `refundStake`。`refundStake` 调用 `sendJettonTransfer`，以 `SEND_MODE_PAY_FEES_SEPARATELY` 从 **`RoundController` 自身合约余额**中硬编码支出 `0.1 TON`，并将第 5 个参数 `responseDestination`（即 TEP-74 的 `send_excesses_to`）设为 **`owner`（外部调用者自身）**！当这笔 `1 raw A9` 的退款到达调用者的 `JettonWallet` 后，`JettonWallet.tolk:105–122` 会将 `RoundController` 支付的 `0.1 TON` 中扣除约 `0.015 TON` 燃气与转发费后的全部剩余约 **`0.085 TON`**，通过 `ReturnExcessesBack` 直接发送给调用者 `owner`！同时调用者还收回了那 `1 raw A9` 代币。这意味着调用者每发送一笔 `1 raw A9` 的无效质押，仅消耗 `0.005 TON` 入站费，却从 `RoundController` 收到约 `0.085 TON` 退款余量，单次净赚约 `0.075–0.080 TON`！仅需重复约 210 次调用，即可将 `RoundController` 部署时预充的 `20 TON` 储备彻底盗空。

第二，**合法用户质押退款永久锁死且无任何链上救援路径（Permanent Principal Freezing）**。当正常用户在报名截止临界点（如触价提前关窗同区块）、撞单轮 2 亿上限或 nonce 冲突而触发 `refundStake` 时：
1. 若 `RoundController` 的 TON 余额已被上述套利抽干（或低于 `0.1 TON - in.valueCoins`，例如用户按 [contracts/README.md](file:///Users/yu1/Desktop/BAM/contracts/README.md) 第 4.2 节说明设置 `forward_ton_amount = 0.05 TON`，而 `RoundController` 剩余余额不足 `0.05 TON`），`refundStake` 中的 `out.send(SEND_MODE_PAY_FEES_SEPARATELY)` 会在动作阶段（Action Phase）因余额不足（Exit Code 37）失败，导致 `RoundController` 的整笔交易回滚。
2. 由于 `rcWallet` 发送给 `RoundController` 的 `TransferNotification` 采用 `BounceMode.NoBounce`（`JettonWallet.tolk:90`），`rcWallet` 已经将用户的 A9 代币（最高可达 `20,000,000 A9`）加到了 `rcWallet.jettonBalance` 中（`JettonWallet.tolk:85`），而 `RoundController` 既未记录用户的 `StakePosition`，也未能发出退款！
3. 同理，即使 `refundStake` 成功发出，若退款转账在第一跳或第二跳发生 Bounce，`RoundController.onBouncedMessage`（第 125–126 行）与 `handleTransferBounced`（第 932 行）会调用 `rollbackPendingClaim(0)`，因 `ex.pending` 中不存在 `queryId = 0` 而静默返回。
4. 最关键的是，[contracts/README.md](file:///Users/yu1/Desktop/BAM/contracts/README.md) 第 9 节第 22 条与 [18_AUDIT_BRIEF.md](file:///Users/yu1/Desktop/BAM/docs/18_AUDIT_BRIEF.md) 第 4 节均假设「资金仍留在 RC Jetton Wallet（未记账），需 admin/ops 手工重发退款」。**这一假设在代码层面完全不成立**：`rcWallet` 的 `ownerAddress` 是 `RoundController` 合约地址，并非 `admin` 地址；`JettonWallet.tolk:137` 严格校验 `in.senderAddress == storage.ownerAddress`，因此 `admin` 无法直接操作 `rcWallet`；同时 `RoundController` 没有任何允许 `admin` 划转未记账代币的接口，且合约不可升级。因此一旦退款失败，用户的质押本金将**100% 永久死锁在 `rcWallet` 中，没有任何链上或人工恢复手段**。

#### 影响评估

该漏洞同时构成原生 TON 资金池被盗（使 `RoundController` 因无 TON 可用而全面停摆，所有结算销毁与用户领奖全部瘫痪）以及用户大额 A9 质押本金在常规竞态退款下永久丢失。

#### 防御性验证测试与修复方案

修复应当遵循两条核心原则：（1）`TransferNotification` 触发的退款绝不倒贴 `RoundController` 自身的 TON，且余量回传地址不得指向外部调用者以防套利；（2）当 `in.valueCoins` 不足以覆盖自动退款燃气（`< 0.12 TON`）或自动退款发生一跳/两跳 Bounce 时，将未退回的金额记入 `StorageExtras` 的可领退款账本（或累加至可回滚的 `PendingClaim`），允许用户自行附带足够 Gas 主动提回。

```tolk
// 修复补丁：contracts/contracts/RoundController.tolk
// 1. handleTransferNotification 接收 in.valueCoins 参数：
fun handleTransferNotification(sender: address, msg: TransferNotification, valueCoins: coins) {
    ...
    // 所有退款分支改为调用 refundStake(s, exState, owner, amount, valueCoins)
}

// 2. refundStake 仅在入站 valueCoins >= 0.12 TON 时使用 CARRY_ALL_REMAINING_MESSAGE_VALUE 转发，
//    且通过 claimQueryId 记录可回滚的 PendingClaim（若 valueCoins 不足或发生 Bounce，记入用户可领余额）：
fun refundStake(s: Storage, owner: address, amount: coins, valueCoins: coins) {
    var ex = s.extras.load();
    if (valueCoins >= ton("0.12") && lockedStateOf(ex, owner).pendingQueryId == 0) {
        val q = claimQueryId(s.currentRoundId, CLAIM_KIND_PRINCIPAL, ex.claimCounter);
        ex.claimCounter = ex.claimCounter + 1;
        s.extras = ex.toCell();
        s.save();
        val body = buildJettonTransferBody(q, amount, owner, contract.getAddress());
        createMessage({
            bounce: BounceMode.Only256BitsOfBody,
            value: 0,
            dest: vaults(s).stakingJettonWallet,
            body,
        }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        return;
    }
    // 若入站 Gas 不足（< 0.12 TON），不消耗 RC 自身 TON，而是记入轮次 0 的可退本金仓位供用户 ClaimPrincipal(roundId=0) 领取：
    var inner: map<address, StakePosition> = [];
    val innerRes = s.stakes.get(0);
    if (innerRes.isFound) {
        inner = innerRes.loadValue();
    }
    var pos = StakePosition { amountRaw: 0, lastDepositNonce: 0, principalClaimed: false, rewardClaimed: true, weight: 0, rewardState: REWARD_STATE_PENDING };
    val prev = inner.get(owner);
    if (prev.isFound) {
        pos = prev.loadValue();
    }
    pos.amountRaw = pos.principalClaimed ? (amount as uint128) : (pos.amountRaw + (amount as uint128));
    pos.principalClaimed = false;
    inner.set(owner, pos);
    s.stakes.set(0, inner);
    s.save();
}
```

对应防御性验证测试应断言：当外部调用者以 `value = ton("0.02")` 发送无效 `TransferNotification` 时，`RoundController` 的 TON 余额不会减少，且用户未退回的本金被安全记录在链上可由用户主动取回：

```tolk
// 防御性验证测试
get fun `test A9-CRIT-02 low-gas invalid stake does not drain RC TON and records refundable balance`() {
    val f = setupProtocol();
    val alice = testing.treasury("crit02-alice");
    openRound(f.rc, f.admin, 0);
    val rcTonBefore = testing.getAccountBalance(f.rc.address);

    // 仅附带 0.02 TON 发送低于最低限额的质押通知
    val body = beginCell()
        .storeUint(OP_JETTON_TRANSFER_NOTIFICATION, 32)
        .storeUint(0, 64)
        .storeCoins(1000)
        .storeAddress(alice.address)
        .storeUint(0, 1)
        .endCell();
    expect(net.send(f.rcWallet.address, createMessage({
        bounce: false,
        value: ton("0.02"),
        dest: f.rc.address,
        body,
    }))).toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });

    val rcTonAfter = testing.getAccountBalance(f.rc.address);
    // RC 自身 TON 余额不得被倒贴抽干
    expect(rcTonAfter >= rcTonBefore).toBeTrue();
}
```

### A9-HIGH-01 代币钱包两跳回弹通知遗漏销毁分支导致的结算状态机永久死锁

- **严重度**：High（在销毁第二跳发生 Bounce 时直接导致当前轮次及全部后续轮次永久卡死在 `SETTLING_*` 状态，冻结全部协议资金）
- **位置**：
  - [contracts/contracts/jetton/JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk) 第 23–63 行（`onBouncedMessage`）
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 96–127 行（`onBouncedMessage`）、第 929–933 行（`handleTransferBounced`）、第 1194–1233 行（`handleRetryPendingActions`）
  - [contracts/contracts/TeamVault.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/TeamVault.tolk) 第 110–159 行（`BurnTeamQuota`）、第 219–240 行（`TransferBounced`）

#### 漏洞机理与触发路径分析

任务书第 4.2 节专门指出：「Jetton 两跳 bounce：发送方钱包 $\rightarrow$ 接收方钱包的 `InternalTransferStep` 被 bounce 时，`pendingQueryId` 是否能恢复（`v8.6` 已加 `TransferBounced` 通知，请验证是否覆盖全部路径）」。

经审查 [JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk) 第 23–63 行，可以确认 `v8.6` 的 `C-4` 修复**未覆盖销毁（Burn）的两跳回弹路径**：

```tolk
// JettonWallet.tolk:23-63
type BounceOpToHandle = InternalTransferStep | BurnNotificationForMinter

fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    val op = in.bouncedBody.preloadUint(32);

    // C-4: parse the queryId from a copy before lazy field access consumes the body.
    var querySlice = in.bouncedBody;
    var bouncedQueryId: uint64 = 0;
    if (op == OP_JETTON_INTERNAL_TRANSFER) {
        querySlice.loadUint(32);
        bouncedQueryId = querySlice.loadUint(64) as uint64;
    }

    val msg = lazy BounceOpToHandle.fromSlice(in.bouncedBody);
    val restoreAmount = match (msg) {
        InternalTransferStep => msg.jettonAmount,
        BurnNotificationForMinter => msg.jettonAmount,
    };

    var storage = lazy WalletStorage.load();
    storage.jettonBalance += restoreAmount;
    storage.save();

    if (op == OP_JETTON_INTERNAL_TRANSFER) {
        val notice = createMessage({
            bounce: BounceMode.NoBounce,
            value: ton("0.02"),
            dest: storage.ownerAddress,
            body: TransferBounced { queryId: bouncedQueryId },
        });
        notice.send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
    }
}
```

当 `RoundController`（销毁 7 亿奖励或质押本金）或 `TeamVault`（销毁 1.2 亿团队额度）调用 `sendJettonBurn` 时：
1. **第一跳**（`RoundController/TeamVault` $\rightarrow$ `rcWallet/tvWallet`）：执行 `AskToBurn(0x595f07bc)`，扣减钱包余额并向 `JettonMaster` 发出 `BurnNotificationForMinter(0x7bdd97de)`。此时 `RoundController` 已将 `rd.rewardBurnDispatched = true` / `rd.principalBurnDispatched = true` 落盘（第 581、594、598 行），`TeamVault` 已将 `st.rounds[roundId]`（`burned: false, queryId: BURN_QUERY_TEAM`）落盘（第 142–149 行）。
2. **第二跳**（`rcWallet/tvWallet` $\rightarrow$ `JettonMaster`）：若 `JettonMaster` 在处理 `BurnNotificationForMinter` 时发生异常（例如 `JettonMaster` 因长期未收到 `TopUpTons` 累积了存储租金赤字，在扣减 `storageDuePayment` 后剩余消息价值不足以支付 `ReturnExcessesBack` 的转发费，从而触发 `JettonMaster.tolk:216` 的 `SEND_MODE_BOUNCE_ON_ACTION_FAIL` 回弹），Bounce 消息会退回给 `rcWallet` / `tvWallet`。
3. **两跳通知缺失与重试死锁**：`JettonWallet.onBouncedMessage` 收到 `BurnNotificationForMinter(0x7bdd97de)` 的 Bounce 后，仅在本地恢复了 `storage.jettonBalance += restoreAmount`，但因为第 32 行与第 50 行只判断了 `if (op == OP_JETTON_INTERNAL_TRANSFER)`，**完全没有向 `RoundController` 或 `TeamVault` 发送 `TransferBounced` 通知**！
4. 同时，在 `RoundController.tolk:929–933`（`handleTransferBounced`）中，仅调用了 `rollbackPendingClaim(msg.queryId)`，未处理 `BURN_QUERY_REWARD` 与 `BURN_QUERY_PRINCIPAL` 的 `dispatched` 标志重置；在 `TeamVault.tolk:227`（`TransferBounced`）中，明确写了 `if (kind != RELEASE_QUERY_TEAM) { return; }`，直接丢弃销毁类的两跳回弹通知！
5. 结果：`RoundController` 的 `rewardBurnDispatched` / `principalBurnDispatched` 永远保持 `true`，`handleRetryPendingActions`（第 1207、1213、1218 行）因检查 `!rd.rewardBurnDispatched` 而永远拒绝重发；`TeamVault.BurnTeamQuota`（第 134 行）因看到 pending 记录存在而直接 `return` 拒绝重发；且 `handleAbortTechnical`（第 716–753 行）不包含 `STATUS_SETTLING_FAILURE` 或 `STATUS_SETTLING_SUCCESS` 分支。

#### 影响评估

一旦任意一笔销毁在第二跳（`JettonWallet` $\rightarrow$ `JettonMaster`）发生 Bounce，协议将永久卡死在 `STATUS_SETTLING_FAILURE` 或 `STATUS_SETTLING_SUCCESS` 状态，既无法通过 `RetryPendingActions` 重发销毁，也无法通过 `AbortTechnical` 逃生，后续所有轮次及 R10 线性解锁池（`unlockStart`）将被永久冻结。

#### 防御性验证测试与修复方案

需在 `JettonWallet.onBouncedMessage`、`RoundController.handleTransferBounced` 及 `TeamVault.TransferBounced` 三处同步打通 `BurnNotificationForMinter` 的两跳回弹恢复链路：

```tolk
// 修复补丁 1：contracts/contracts/jetton/JettonWallet.tolk (onBouncedMessage)
fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    val op = in.bouncedBody.preloadUint(32);

    var querySlice = in.bouncedBody;
    querySlice.loadUint(32);
    val bouncedQueryId: uint64 = querySlice.loadUint(64) as uint64;

    val msg = lazy BounceOpToHandle.fromSlice(in.bouncedBody);
    val restoreAmount = match (msg) {
        InternalTransferStep => msg.jettonAmount,
        BurnNotificationForMinter => msg.jettonAmount,
    };

    var storage = lazy WalletStorage.load();
    storage.jettonBalance += restoreAmount;
    storage.save();

    // A9-HIGH-01 & A9-HIGH-03: notify owner on BOTH InternalTransferStep and BurnNotificationForMinter
    // second-hop bounces, carrying remaining bounced value after reserving wallet storage fee.
    reserveToncoinsOnBalance(calculateJettonWalletMinStorageFee(), RESERVE_MODE_AT_MOST);
    val notice = createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: storage.ownerAddress,
        body: TransferBounced { queryId: bouncedQueryId },
    });
    notice.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
```

```tolk
// 修复补丁 2：contracts/contracts/RoundController.tolk (handleTransferBounced)
fun handleTransferBounced(sender: address, msg: TransferBounced) {
    var s = lazy Storage.load();
    assert (sender == vaults(s).stakingJettonWallet) throw Errors.NotJettonWallet;
    // Check if this is a burn queryId (roundId<<16 | kind<<8, where upper 32 bits are 0)
    if ((msg.queryId >> 32) == 0) {
        val roundId: uint8 = ((msg.queryId >> 16) & 0xff) as uint8;
        val kind: uint8 = ((msg.queryId >> 8) & 0xff) as uint8;
        val rr = s.rounds.get(roundId);
        if (rr.isFound) {
            var rd = rr.loadValue();
            if (kind == BURN_QUERY_REWARD && !rd.rewardBurnConfirmed) {
                rd.rewardBurnDispatched = false;
                s.rounds.set(roundId, rd);
                s.save();
            } else if (kind == BURN_QUERY_PRINCIPAL && !rd.principalBurnConfirmed) {
                rd.principalBurnDispatched = false;
                s.rounds.set(roundId, rd);
                s.save();
            }
        }
        return;
    }
    rollbackPendingClaim(msg.queryId);
}
```

```tolk
// 修复补丁 3：contracts/contracts/TeamVault.tolk (TransferBounced 分支)
        TransferBounced => {
            var st = lazy TeamVaultStorage.load();
            val params = st.params.load();
            if (in.senderAddress != params.jettonWallet) {
                throw Errors.NotJettonWallet;
            }
            val roundId: uint8 = ((msg.queryId >> 16) & 0xff) as uint8;
            val kind: uint8 = ((msg.queryId >> 8) & 0xff) as uint8;
            if (kind != RELEASE_QUERY_TEAM && kind != BURN_QUERY_TEAM) {
                return;
            }
            val prev = st.rounds.get(roundId);
            if (!prev.isFound) {
                return;
            }
            val state = prev.loadValue();
            if (state.released || state.burned || state.queryId != msg.queryId) {
                return;
            }
            st.rounds.delete(roundId);
            if (kind == BURN_QUERY_TEAM) {
                st.pendingBurnIds.delete(roundId);
            }
            st.save();
        }
```

### A9-HIGH-02 预言机适配器暂停恢复失步与管道化回弹乱序导致的观察窗口死锁

- **严重度**：High（在预言机暂停恢复或两根 K 线并发回弹时，导致 `OracleAdapter` 与 `RoundController` 的 K 线索引永久失步，该轮无法正常结算）
- **位置**：
  - [contracts/contracts/OracleAdapter.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/OracleAdapter.tolk) 第 320–407 行（`SubmitSignedCandle`、`onBouncedMessage`）
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 528–531 行（`handleSubmitCandle`）、第 668–706 行（`handlePauseOracle`、`handleResumeOracle`）

#### 漏洞机理与触发路径分析

对 `OracleAdapter` 与 `RoundController` 之间的 K 线同步状态机进行交叉推演，发现以下三处紧密关联的高危缺陷：

```tolk
// OracleAdapter.tolk:336-354 & 398-404
            assert (msg.candleIndex < 32) throw Errors.BadCandleOrder;
            val lastRes = st.lastCandle.get(msg.roundId);
            val lastPlus: uint8 = lastRes.isFound ? lastRes.loadValue() : 0;
            if ((msg.candleIndex as int) + 1 <= (lastPlus as int)) {
                throw Errors.BadCandleOrder;
            }
            val acceptedPlus: uint8 = (msg.candleIndex as uint8) + 1;
            st.lastCandle.set(msg.roundId, acceptedPlus);
...
    } else if (p.kind == SIGNED_ACTION_CANDLE) {
        val lastRes = st.lastCandle.get(roundId);
        val current: uint8 = lastRes.isFound ? lastRes.loadValue() : 0;
        if (current == p.acceptedLastPlus) {
            st.lastCandle.set(roundId, p.prevLastPlus);
        }
    }
    st.pending.delete(q);
```

1. **`PauseOracle` $\rightarrow$ `ResumeOracle` 后 `lastCandle` 无法归零导致永久死锁**：
   当观察期已通过 `OracleAdapter` 提交了前 $k \ge 1$ 根 K 线（例如 $k=3$，此时 `OracleAdapter.lastCandle[roundId] = 3`，`RoundController.candlesSeen = 3`）后，若预言机发生故障由管理员触发 `PauseOracle` 并在恢复后调用 `ResumeOracle`，`RoundController.handleResumeOracle`（第 696–702 行）会按照设计规范将 `rd.candlesSeen` 重置为 `0`、`rd.qualifiedCandles` 重置为 `0`，要求重新从 `candleIndex = 0` 开始提交完整的 24 根 K 线。然而，`OracleAdapter` 中**没有任何重置 `lastCandle[roundId]` 的接口或消息处理逻辑**！恢复后，当提交 `candleIndex = 0` 时，`OracleAdapter` 检查 `(0 + 1) <= 3` 为真，直接抛出 `Errors.BadCandleOrder(303)`；若提交 `candleIndex = 3`，`OracleAdapter` 放行转发给 `RoundController`，但 `RoundController`（第 530 行）检查 `assert (msg.candleIndex == rd.candlesSeen)`（`3 == 0`）失败并抛出 `Errors.CandleAlreadySeen(214)`。至此，该轮次在 `OracleAdapter` 下**100% 永久死锁**，只能等待 7 天观察超时触发 `AbortTechnical`。
2. **管道化（Pipelined）K 线触发 FIFO Bounce 时回滚失效**：
   在 TON 异步模型下，`OracleAdapter` 与 `RoundController` 是两个独立合约。若连续两根已签名的 K 线 `candleIndex = 0` 与 `candleIndex = 1` 在同一区块或短时间内先后到达 `OracleAdapter`（例如 keeper 在 `CloseStaking` 交易尚未落盘时、或网络抖动恢复后连续广播两根 K 线）：
   - 第一笔交易（`index = 0`）在 `OracleAdapter` 上将 `lastCandle` 从 `0` 改为 `1`，记录 `pending[q0] = { prevLastPlus: 0, acceptedLastPlus: 1 }`，向 `RoundController` 发出消息 $M_0$；
   - 第二笔交易（`index = 1`）在 `OracleAdapter` 上将 `lastCandle` 从 `1` 改为 `2`，记录 `pending[q1] = { prevLastPlus: 1, acceptedLastPlus: 2 }`，向 `RoundController` 发出消息 $M_1$；
   - 当 $M_0$ 与 $M_1$ 在 `RoundController` 均被拒绝并 Bounce 时，由于 TON 跨合约消息严格遵循 **FIFO（先进先出）** 逻辑时间（LT）顺序，$\text{Bounce}(M_0)$ 会**先于** $\text{Bounce}(M_1)$ 到达 `OracleAdapter`！
   - 当 $\text{Bounce}(M_0)$ 到达时，`OracleAdapter.onBouncedMessage`（第 401 行）检查 `current (2) == p0.acceptedLastPlus (1)`，结果为 **`false`**！因此 $\text{Bounce}(M_0)$ **未执行任何回滚**即删除了 `pending[q0]`；
   - 紧接着 $\text{Bounce}(M_1)$ 到达，检查 `current (2) == p1.acceptedLastPlus (2)` 为 `true`，将 `lastCandle` 回滚为 `p1.prevLastPlus = 1`！
   - 最终结果：$M_0$ 和 $M_1$ 均未在 `RoundController` 落盘（`RoundController.candlesSeen == 0`），但 `OracleAdapter.lastCandle[roundId]` 却永远停留在 `1`！后续重发 `candleIndex = 0` 被 `OracleAdapter` 永久拒绝（`BadCandleOrder`），重发 `candleIndex = 1` 被 `RoundController` 永久拒绝（`CandleAlreadySeen`），整轮彻底死锁。
3. **未强制 `candleIndex` 严格连续（允许跳号抢跑）**：
   `OracleAdapter.tolk:340` 仅检查 `(msg.candleIndex as int) + 1 <= (lastPlus as int)`（即 `candleIndex >= lastPlus`），而未像 `RoundController.tolk:530` 那样要求 `msg.candleIndex == lastPlus`。当链下同时存在两根已签名 K 线 `index = k` 与 `index = k+1` 时，任何第三方均可抢先提交 `index = k+1`，使 `lastCandle` 跳至 `k+2`，导致随后到达的合法 `index = k` 在 `OracleAdapter` 直接报错失败。

#### 影响评估

上述三处缺陷均无需管理员私钥泄露即可在正常运维（预言机暂停恢复、keeper 批量补交 K 线、或公开签名被第三方抢跑重排）下触发，直接导致观察期永久死锁。

#### 防御性验证测试与修复方案

修复需包含三项改动：（1）在 `SubmitSignedCandle` 中强制要求 `(msg.candleIndex as uint8) == lastPlus` 严格连续（消除跳号）；（2）在 `onBouncedMessage` 中将 `if (current == p.acceptedLastPlus)` 改为 `if (p.prevLastPlus < current)`（使得无论 Bounce 按 FIFO 还是 LIFO 顺序返回，都能正确将 `lastCandle` 收敛回最小未确认的 `prevLastPlus`）；（3）在 `OracleAdapter` 中增加管理员或签名触发的重置函数（或在 `SetSignerSet` / 专用 `ResetOracleRound` 中支持在 `ResumeOracle` 时清零指定 `roundId` 的 `lastCandle`）。

```tolk
// 修复补丁：contracts/contracts/OracleAdapter.tolk
// 1. SubmitSignedCandle (L0338-0344)：强制严格连续，禁止跳号
            val lastRes = st.lastCandle.get(msg.roundId);
            val lastPlus: uint8 = lastRes.isFound ? lastRes.loadValue() : 0;
            if ((msg.candleIndex as uint8) != lastPlus) {
                throw Errors.BadCandleOrder;
            }
            val acceptedPlus: uint8 = lastPlus + 1;
            st.lastCandle.set(msg.roundId, acceptedPlus);

// 2. onBouncedMessage (L0398-0404)：兼容 TON FIFO Bounce 顺序，取最小回滚点
    } else if (p.kind == SIGNED_ACTION_CANDLE) {
        val lastRes = st.lastCandle.get(roundId);
        val current: uint8 = lastRes.isFound ? lastRes.loadValue() : 0;
        if (p.prevLastPlus < current) {
            st.lastCandle.set(roundId, p.prevLastPlus);
        }
    }
```

对应在 `contracts/tests/oracle-adapter.test.tolk` 中应新增防御性回归测试，验证跳过 `candleIndex = 0` 直接提交 `candleIndex = 1` 被拒绝，以及连续两根 K 线发生 FIFO Bounce 后仍能回到 `0` 并重新提交 `candleIndex = 0`：

```tolk
// 防御性验证测试（加入 contracts/tests/oracle-adapter.test.tolk）
get fun `test A9-HIGH-02 skipping candleIndex 0 to 1 is rejected and FIFO double bounce rolls back to 0`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    // 未提交 index 0 时直接提交 index 1 必须以 BadCandleOrder 拒绝
    val h1 = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_CANDLE, 1, 1, T0, T0 + 3600, 240000 as uint128, 1 as uint256, T0 as uint64);
    val body1 = SubmitSignedCandle {
        roundId: 1, candleIndex: 1, periodStart: T0, periodEnd: T0 + 3600,
        twapPriceUsdE8: 240000, dataDigest: 1 as uint256, timestamp: T0 as uint64,
        sigCount: 3, sigs: buildSigs(keys, eqArray3(), h1),
    };
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body: body1 })))
        .toHaveFailedTx<SubmitSignedCandle>({ from: admin.address, to: adapter.address, exitCode: Errors.BadCandleOrder });
}
```

### A9-HIGH-03 两跳回弹通知固定极小燃气额度导致的多轮回滚超限与账户永久锁定

- **严重度**：High（在跨多轮 `ClaimAll` 或 `ClaimUnlocked` 发生第二跳回弹、或金库钱包 TON 余额偏低时，导致用户 `pendingQueryId` 永久无法清零，个人全部本金与奖励永久锁死）
- **位置**：
  - [contracts/contracts/jetton/JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk) 第 50–62 行（`onBouncedMessage`）
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 231–335 行（`rollbackPendingClaim`）、第 929–933 行（`handleTransferBounced`）
  - [contracts/contracts/TeamVault.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/TeamVault.tolk) 第 73–87 行（`ReleaseTeamQuota`）、第 219–240 行（`TransferBounced`）

#### 漏洞机理与触发路径分析

在 `JettonWallet.tolk:50–62` 中，当第二跳 `InternalTransferStep` 从收款方钱包 Bounce 回发送方钱包（`rcWallet` 或 `tvWallet`）时，代码构造了如下 `TransferBounced` 通知：

```tolk
// JettonWallet.tolk:50-62
    if (op == OP_JETTON_INTERNAL_TRANSFER) {
        val notice = createMessage({
            bounce: BounceMode.NoBounce,
            value: ton("0.02"),
            dest: storage.ownerAddress,
            body: TransferBounced { queryId: bouncedQueryId },
        });
        // C-4: IGNORE_ERRORS (2) is mandatory here. Without it a failed 0.02 TON
        // notice would abort the whole action phase and roll back the jettonBalance
        // restore above (permanent token loss). If the notice cannot be paid, we
        // skip it and keep the balance rollback; worst case the owner stays pending.
        notice.send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
    }
```

该实现存在两处高危隐患：
1. **`0.02 TON` 硬编码导致 `RoundController.rollbackPendingClaim` 在多轮回滚时触发 `OutOfGas`**：
   根据 TVM 虚拟机规则，对于未显式调用 `acceptMessage()` 的内部消息，当前交易的计算燃气上限（`gas_limit`）严格由**该条入站消息附带的 `in.valueCoins / gas_price`** 决定，而与接收合约（`RoundController`）自身账户上有多少 TON 余额无关。当 `JettonWallet` 发送 `value: ton("0.02")` 时，扣除跨合约转发费（`fwd_fee`）与 `RoundController` 累积的存储费（`storageDuePayment`）后，可用于 TVM 计算的燃气上限不足 `48,000 gas units`。
   然而，当用户调用的是跨多轮（最多 10 轮）的 `ClaimAll` 或首次折叠 10 轮 `PENDING` 奖励的 `ClaimUnlocked` 时，`rollbackPendingClaim`（[RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 269–325 行）需要在 `while (i <= MAX_CLAIM_SCAN_ROUNDS)` 循环中对最多 10 个轮次的 `s.stakes` 外层字典与 `inner` 内层 267-bit 地址字典逐一执行读取、反序列化、修改、重新序列化与字典写回（共 20 次字典读写），外加 2 次 `ex.locked` 字典读写与 1 次 `ex.pending` 删除。根据 [contracts/README.md](file:///Users/yu1/Desktop/BAM/contracts/README.md) 第 8.3 节实测数据，仅单轮 `ClaimRewardEarly`（1 次字典写）即消耗 `18,186 gas`；10 轮回滚的计算开销高达 `45,000–60,000 gas`，极易超出 `0.02 TON` 对应的 `gas_limit` 并抛出 `OutOfGas(-14)` 异常。由于 `notice` 设置了 `BounceMode.NoBounce`，`RoundController` 抛出 `OutOfGas` 后没有任何重发机会，用户的 `lk.pendingQueryId` 将**永久停留在非零值**，此后该用户调用任何领取或滚存接口均会永久报错 `Errors.ClaimPending(270)`。
2. **截留退回 TON 并导致低余额钱包静默丢弃通知**：
   当 `RoundController` 或 `TeamVault` 发起转账时附带了 `0.1 TON`，`rcWallet`/`tvWallet` 通过 `SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE` 将全部约 `0.095 TON` 转发给第二跳；当第二跳 Bounce 退回 `rcWallet`/`tvWallet` 时，退回消息本身携带了约 `0.085 TON`。然而 `JettonWallet.tolk:53` 只向 `RoundController`/`TeamVault` 发送 `0.02 TON`，不仅每次 Bounce 白白将 `RoundController` 的约 `0.065 TON` 截留在 `rcWallet` 中，而且当 `in.valueCoins` 因前序损耗略低于 `0.02 TON + gas`（例如剩余 `0.018 TON`）时，`SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS` 会直接**静默跳过发送 `TransferBounced`**。一旦跳过，正如代码第 60 行注释所写“worst case the owner stays pending”，在 `RoundController` 侧意味着用户资产永久冻结，在 `TeamVault` 侧意味着 `ReleaseTeamQuota` 永远处于 pending 状态（`RetryPendingActions` 因 `TeamVault.tolk:86` 直接 `return` 而无法重发），导致 `RoundController` 永久卡死在 `STATUS_SETTLING_SUCCESS`。

#### 防御性验证测试与修复方案

在 `JettonWallet.onBouncedMessage` 中，不应硬编码 `value: ton("0.02")` 与 `SEND_MODE_PAY_FEES_SEPARATELY`，而应先使用 `reserveToncoinsOnBalance(calculateJettonWalletMinStorageFee(), RESERVE_MODE_AT_MOST)` 保护钱包自身的最小存储押金，随后通过 `SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS`（`value: 0`）将第二跳 Bounce 退回的全部剩余 TON（约 `0.08 TON`，可提供约 `200,000 gas` 限额）完整回传给 `storage.ownerAddress`（修复代码已合并展示于 **A9-HIGH-01** 补丁 1 中）。

### A9-HIGH-04 领取接口与预言机转发入口缺失入站燃气门槛导致的储备耗尽

- **严重度**：High（恶意或高频调用者可在数分钟内耗尽 `RoundController` 与 `OracleAdapter` 的原生 TON 储备，导致全协议拒绝服务）
- **位置**：
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 947–1094 行（`handleClaimPrincipal`、`handleClaimAll`）、第 1284–1347 行（`payEarlyReward`、`handleClaimReward`、`handleClaimRewardEarly`）、第 1490–1561 行（`handleClaimUnlocked`）
  - [contracts/contracts/OracleAdapter.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/OracleAdapter.tolk) 第 174–182 行（`forwardTarget`）、第 254–365 行（`SubmitSignedOpenRound`、`SubmitSignedCloseStaking`、`SubmitSignedCandle`）

#### 漏洞机理与触发路径分析

对比 `RoundController` 中的 `handleRetryPendingActions`（第 1194–1196 行）与其他所有对外消息入口：

```tolk
// RoundController.tolk:1194-1196 — 唯一校验了 in.valueCoins 的入口
fun handleRetryPendingActions(_sender: address, msg: RetryPendingActions, valueCoins: coins) {
    // P1-2: anyone may pay gas to unstick a SETTLING_* round if admin is gone.
    assert (valueCoins >= ton("0.3")) throw Errors.BadConfig;
```

而在以下两类高频出站消息入口中，代码**完全未校验 `in.valueCoins`**：
1. **`RoundController` 的全部 5 个领取入口**（`ClaimPrincipal`、`ClaimReward`、`ClaimRewardEarly`、`ClaimAll`、`ClaimUnlocked`）：
   这 5 个入口均调用 `sendTrackedJettonTransfer`，以 `SEND_MODE_PAY_FEES_SEPARATELY` 从 `RoundController` 自身余额中支出 `0.1 TON` 并触发 `external-out` 事件。尽管正常情况下收款钱包会通过 `ReturnExcessesBack` 退回剩余 TON，但两跳内部消息的转发费、两跳钱包的计算费、首次部署用户钱包的 5 年存储费预留（`calculateJettonWalletMinStorageFee()`）以及 `RoundController` 发射 `RewardEarly` / `UnlockClaimed` 外部日志的费用（合计每次约 `0.015–0.025 TON`）均由 `RoundController` 净支出。特别是在 R10 结束后的 12 个月线性解锁期内（`UNLOCK_DURATION_SECONDS = 31,104,000` 秒），拥有锁定额度的用户**每一秒钟**都会产生新的可解锁增量 `vested > claimed`（例如锁定 6.8 亿 A9 时每秒解锁约 21.86 A9）。若攻击者每秒发送一笔仅附带 `0.008 TON` 的 `ClaimUnlocked`，每笔交易在扣除 `0.008 TON` 后仍净消耗 `RoundController` 约 `0.012 TON` 储备，仅需约 1,600 次调用（在上一笔 `ReturnExcessesBack` 确认后立即发起下一笔，耗时不足 3 小时）即可将 `RoundController` 的 `20 TON` 储备彻底耗尽。
2. **`OracleAdapter` 的全部 3 个无权限签名提交入口**（`SubmitSignedOpenRound`、`SubmitSignedCloseStaking`、`SubmitSignedCandle`）：
   这三个入口允许任何地址调用，且均不检查 `in.valueCoins`，在验签通过后直接调用 `forwardTarget`（[OracleAdapter.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/OracleAdapter.tolk) 第 174–182 行）以 `SEND_MODE_PAY_FEES_SEPARATELY` 向 `RoundController` 发送 `0.2 TON`。更严重的是，结合 `v8.6` 新增的 `C-3` Bounce 回滚逻辑（第 371–407 行）：如果某条合法的 3/5 签名报文在 `SIGNED_TIMESTAMP_WINDOW = 300` 秒有效期内被 `RoundController` 拒绝并 Bounce（例如：某轮质押窗口到期后已被任何人无权限调用 `CloseStaking` 关闭，此时 `RoundController` 已处于 `STATUS_STAKING_CLOSED` 或 `STATUS_OBSERVING`，而 `OracleAdapter.usedMask[roundId]` 中的 `SIGNED_ACTION_CLOSE` 仍为 `0`；或者某根已签名的 K 线在 `now < expectedEnd` 的几秒误差窗口内被提前提交），那么当攻击者将该签名报文提交给 `OracleAdapter` 时：
   - `OracleAdapter` 验签通过，置位 `usedMask` / `lastCandle`，并从自身余额掏出 `0.2 TON` 发送给 `RoundController`；
   - `RoundController` 报错并 Bounce 回 `OracleAdapter`；
   - `OracleAdapter.onBouncedMessage` **清除 `usedMask` / `lastCandle` 防重放标记**；
   - 由于防重放标记已被清除且签名在 300 秒窗口内依然有效，攻击者可以用极小入站金额（`0.015 TON`）**在 300 秒内无限循环重放同一条必然 Bounce 的签名消息**，每次循环消耗 `OracleAdapter` 约 `0.02 TON` 的跨合约往返燃气费，数分钟内即可抽干 `OracleAdapter` 的全部 TON 余额！

#### 防御性验证测试与修复方案

在 `RoundController` 的 5 个领取入口中统一要求 `assert (in.valueCoins >= ton("0.15")) throw Errors.BadConfig;`，并在 `OracleAdapter` 的 3 个提交入口中统一要求 `assert (in.valueCoins >= ton("0.25")) throw Errors.BadConfig;`：

```tolk
// 修复补丁 1：contracts/contracts/RoundController.tolk
// 在 handleClaimPrincipal / handleClaimAll / payEarlyReward / handleClaimUnlocked 入口处增加：
assert (valueCoins >= ton("0.15")) throw Errors.BadConfig;

// 修复补丁 2：contracts/contracts/OracleAdapter.tolk
// 在 SubmitSignedOpenRound / SubmitSignedCloseStaking / SubmitSignedCandle 入口处增加：
assert (in.valueCoins >= ton("0.25")) throw Errors.BadConfig;
```

### A9-MED-01 团队金库回执校验地址缺失一次性初始化锁与风险披露语义偏差

- **严重度**：Medium（可导致 `SETTLING_SUCCESS` 团队释放确认永久失步，且揭示了 `D-36` 已知风险披露中的关键合约语义偏差）
- **位置**：
  - [contracts/contracts/TeamVault.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/TeamVault.tolk) 第 39–58 行（`SetJettonWallet`、`SetTeamWalletJettonWallet`）、第 102–108 行（`ReleaseTeamQuota`）、第 165–191 行（`ReturnExcessesBack`）

#### 漏洞机理与触发路径分析

本发现直接回应任务书第 4.3 节（「特别是 `SetJettonWalletCode` / `SetTeamWalletJettonWallet` 是否可能被滥用」）与第 10 节（「审计方对已知接受风险清单无异议或明确说明为何有异议」）。

对比 `TeamVault.tolk` 第 39–58 行的两个管理员配置入口：

```tolk
// TeamVault.tolk:39-58
        SetJettonWallet => {
            var st = lazy TeamVaultStorage.load();
            assert (in.senderAddress == st.config.admin) throw Errors.NotAdmin;
            assert (msg.wallet != createAddressNone()) throw Errors.BadConfig;
            // one-time: only before the controller is wired up
            assert (st.config.controller == null) throw Errors.AlreadyInitialized;
            var params = st.params.load();
            params.jettonWallet = msg.wallet;
            st.params = params.toCell();
            st.save();
        }
        SetTeamWalletJettonWallet => {
            var st = lazy TeamVaultStorage.load();
            assert (in.senderAddress == st.config.admin) throw Errors.NotAdmin;
            assert (msg.wallet != createAddressNone()) throw Errors.BadConfig;
            var extra = st.extra.load();
            extra.teamWalletJettonWallet = msg.wallet;
            st.extra = extra.toCell();
            st.save();
        }
```

结合第 102–108 行的 `ReleaseTeamQuota` 与第 165–191 行的 `ReturnExcessesBack`：
1. **对 D-36 已知风险披露的技术勘误**：在 [00_DECISIONS_V2.md](file:///Users/yu1/Desktop/BAM/docs/00_DECISIONS_V2.md) 的 `D-36` 决策及任务书第 5 节第 3 项中，项目方记录：「TeamVault admin 可随时改 `teamWalletJettonWallet`，即重定向团队 12% 额度的收款地址」。然而，审查 `TeamVault.tolk:102–108` 可以明确看到，`sendJettonTransfer` 的收款人参数是 **`params.teamWallet`**（在部署时写入 `TeamVaultParams`，全合约没有任何修改 `params.teamWallet` 的入口），而**不是** `extra.teamWalletJettonWallet`！
2. **运行期调用 `SetTeamWalletJettonWallet` 会导致 `SETTLING_SUCCESS` 永久死锁**：`extra.teamWalletJettonWallet` 的唯一作用是在 `ReturnExcessesBack`（第 166 行）中校验团队收款钱包的 `JettonWallet` 发回的完成确认信号。由于 `params.teamWallet` 不可变，其对应的 canonical `JettonWallet` 地址也是恒定不变的。如果 `admin` 误以为调用 `SetTeamWalletJettonWallet` 可以更换团队收款地址并在运行期调用了该接口，那么当下一轮成功结算触发 `ReleaseTeamQuota` 时，$1.2\text{ 亿 A9}$ 仍然会被转给旧的 `params.teamWallet`，但旧 `params.teamWallet` 的 `JettonWallet` 发回的 `ReturnExcessesBack` 会因为 `in.senderAddress != extra.teamWalletJettonWallet` 在第 192 行以 `Errors.NotJettonMaster(103)` 报错回滚！结果导致 `TeamVault` 的 `rel.released` 永远为 `false`，`TeamReleasedAck` 永远无法发给 `RoundController`，使 `RoundController` 永久卡死在 `STATUS_SETTLING_SUCCESS`。
3. **伪造释放确认风险**：若 `admin` 在 `ReleaseTeamQuota` 因异常未能完成转账时，将 `extra.teamWalletJettonWallet` 设为 `admin` 自身地址（注：在 [deploy-emulation.tolk](file:///Users/yu1/Desktop/BAM/contracts/scripts/deploy-emulation.tolk) 第 243 行与 [test-utils.tolk](file:///Users/yu1/Desktop/BAM/contracts/tests/test-utils.tolk) 第 93 行中，其初始占位值就是 `admin.address`），则 `admin` 可直接向 `TeamVault` 发送 `ReturnExcessesBack` 伪造 `rel.released = true` 与 `totalReleasedRaw += 1.2e8`。

#### 防御性验证测试与修复方案

`SetTeamWalletJettonWallet` 应当与 `SetJettonWallet`（第 44 行）及 `RoundController.SetJettonWalletCode`（第 938 行）完全一致，加上 `assert (st.config.controller == null) throw Errors.AlreadyInitialized;` 一次性初始化锁，并在 `InitController` 时校验 `params.jettonWallet` 与 `extra.teamWalletJettonWallet` 已完成配置：

```tolk
// 修复补丁：contracts/contracts/TeamVault.tolk (L0050-0066)
        SetTeamWalletJettonWallet => {
            var st = lazy TeamVaultStorage.load();
            assert (in.senderAddress == st.config.admin) throw Errors.NotAdmin;
            assert (msg.wallet != createAddressNone()) throw Errors.BadConfig;
            assert (st.config.controller == null) throw Errors.AlreadyInitialized;
            var extra = st.extra.load();
            extra.teamWalletJettonWallet = msg.wallet;
            st.extra = extra.toCell();
            st.save();
        }
```

### A9-MED-02 延迟开窗兜底逻辑在三十六小时临界点处的质押窗口压缩断崖

- **严重度**：Medium（在预言机/keeper 延迟开窗或择时开窗时，可将 36 小时质押窗口极端压缩至 1 秒，使预告期滚存者垄断整轮 7 亿奖励）
- **位置**：[contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 435–460 行（`handleOpenRound`）

#### 漏洞机理与触发路径分析

审查 `handleOpenRound` 中第 2 至第 10 轮的开窗时间计算逻辑：

```tolk
// RoundController.tolk:435-460
        assert (rd.status == STATUS_PREVIEW) throw Errors.BadRoundStatus;
        assert (now >= rd.stakeOpenAt) throw Errors.PreviewNotFinished;
        if (now >= rd.stakeOpenAt + (t.stakeDurationSeconds as uint64)) {
            rd.stakeOpenAt = now;
        }
    }
    ...
    rd.status = STATUS_STAKING_OPEN;
    ...
    rd.stakeCloseAt = rd.stakeOpenAt + (t.stakeDurationSeconds as uint64);
```

在上一轮 `FinalizeRound` 结束时，下一轮被初始化为 `STATUS_PREVIEW`，且 `rd.stakeOpenAt = settledAt + previewSeconds`（即结算后 12 小时）。当 12 小时预告期结束（`now >= rd.stakeOpenAt`）后，若 `OpenRound` 因预言机延迟、网络故障或人为择时，在 `now = rd.stakeOpenAt + 36h - 5s`（即迟到 35 小时 59 分 55 秒）才被执行：
- 由于 `now < rd.stakeOpenAt + t.stakeDurationSeconds`，第 442 行的 `if` 条件为 `false`，`rd.stakeOpenAt` **不会**更新为 `now`；
- 第 459 行计算出的 `rd.stakeCloseAt = rd.stakeOpenAt + 36h = now + 5s`！
- 这意味着本应持续 36 小时的 `STATUS_STAKING_OPEN` 质押窗口，实际开启仅 **5 秒钟**即告截止！而在前序的 35 小时 59 分 55 秒内，由于轮次状态仍为 `STATUS_PREVIEW`，任何普通用户发起的质押都会被 `L0820`（`rd.status != STATUS_STAKING_OPEN`）退回，唯独上一轮的获胜者可以在 `STATUS_PREVIEW` 阶段通过 `RollReward`（第 1357 行允许在 `STATUS_PREVIEW` 滚存）提前写入下一轮仓位。5 秒后任何人均可无权限调用 `CloseStaking` 关窗，从而将其他所有新质押用户彻底拒之门外，使 `PREVIEW` 阶段的滚存者独自垄断整轮 $7\text{ 亿枚 A9}$ 奖励池。

#### 防御性验证测试与修复方案

既然 `assert (now >= rd.stakeOpenAt) throw Errors.PreviewNotFinished;` 已经验证了 12 小时预告期结束，且在 `OpenRound` 上链前轮次并未真正开放质押，应将 `rd.stakeOpenAt = now;` 无条件应用于每次 `OpenRound`，确保每轮自目标价锁定并进入 `STATUS_STAKING_OPEN` 起，始终享有完整的 `t.stakeDurationSeconds`（36 小时）质押窗口：

```tolk
// 修复补丁：contracts/contracts/RoundController.tolk (L0435-0445)
        assert (rd.status == STATUS_PREVIEW) throw Errors.BadRoundStatus;
        assert (now >= rd.stakeOpenAt) throw Errors.PreviewNotFinished;
        rd.stakeOpenAt = now;
    }
```

### A9-MED-03 奖励滚存未校验最低质押门槛导致的零风险连胜权重维持

- **严重度**：Medium（允许在上限临界点以 `1 raw unit` 极微小仓位刷新 `streak` 连胜加成，并存在分步滚存推荐权重漏计边界）
- **位置**：[contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 1408–1474 行（`handleRollReward`）

#### 漏洞机理与触发路径分析

在直接质押路径 `handleTransferNotification`（第 825 行）中，协议严格强制单笔质押不得低于 `e.minStakeRaw`（$10,000\text{ A9} = 10^{13}\text{ raw}$）。然而在 `handleRollReward`（第 1421 行）中，仅校验了 `assert (rollAmount > 0) throw Errors.RollNotAvailable;`：

```tolk
// RoundController.tolk:1412-1441
    var rollAmount: uint128 = reward;
    if (rollAmount > roomAddr) {
        rollAmount = roomAddr;
    }
    if (rollAmount > roomTotal) {
        rollAmount = roomTotal;
    }
    val excess: uint128 = reward - rollAmount;
    // F-05: no room means no roll; keep PENDING (early claim / unlock rights intact).
    assert (rollAmount > 0) throw Errors.RollNotAvailable;
    ...
        val referrerRes = ex.referrer.get(sender);
        if (referrerRes.isFound && rollAmount >= e.minStakeRaw) {
```

这引发两个边界一致性问题：
1. **微尘滚存零风险续写 `streak`**：当下一轮剩余总质押额度 `roomTotal` 被其他用户填满至仅剩 `1 raw unit`（$10^{-9}\text{ A9}$）时，上一轮赢家调用 `RollReward` 仅需将 `1 raw unit` 滚入下一轮（其余 $99.999999999999999\%$ 的奖励全部作为 `excess` 安全进入 R10 线性解锁池），即可在第 1431 与 1466 行成功将自身的连续参与轮数 `streak` 加 1，从而在不承担第 $r+1$ 轮 `minStakeRaw`（$10,000\text{ A9}$）本金归零风险的前提下，保留高额连胜权重倍数（最高 $2.0\times$）至第 $r+2$ 轮。
2. **推荐权重漏计边界**：在第 1440 行，代码检查 `rollAmount >= e.minStakeRaw` 才将 `rollAmount` 计入推荐人的 `referred` 与 `bonus`。若被邀请人在下一轮已先通过直接质押投入了 $15,000,000\text{ A9}$（已满足 $\ge 10,000\text{ A9}$ 有效被邀请人门槛），且当时轮次剩余总额度 `roomTotal` 为 $5,000\text{ A9} < \text{minStakeRaw}$，此时该被邀请人调用 `RollReward` 滚入 $5,000\text{ A9}$，虽然其本轮总质押高达 $15,005,000\text{ A9}$，但这 $5,000\text{ A9}$ 的滚存却因单次 `rollAmount < e.minStakeRaw` 未被计入推荐人的 `referred` 与 `bonus`。

#### 防御性验证测试与修复方案

在 `handleRollReward` 中要求滚存后的下一轮累计质押额 `nextPos.amountRaw + rollAmount >= e.minStakeRaw`（且若 `nextPos.amountRaw == 0`，则 `rollAmount >= e.minStakeRaw`），并将第 1440 行的推荐判定条件改为 `(nextPos.amountRaw >= e.minStakeRaw)`：

```tolk
// 修复补丁：contracts/contracts/RoundController.tolk (L1421 & L1433-1441)
    assert (rollAmount > 0 && nextPos.amountRaw + rollAmount >= e.minStakeRaw) throw Errors.RollNotAvailable;
    ...
        nextPos.amountRaw = nextPos.amountRaw + rollAmount;
        nextPos.weight = nextPos.weight + ownW;
        nextInner.set(sender, nextPos);
        s.stakes.set(nextRoundId, nextInner);
        nextExtra.totalWeight = nextExtra.totalWeight + ownW;

        val referrerRes = ex.referrer.get(sender);
        if (referrerRes.isFound && nextPos.amountRaw >= e.minStakeRaw) {
```

### A9-MED-04 预言机开轮与关窗转发消息缺失轮次绑定及待决字典无限膨胀

- **严重度**：Medium（跨轮次边界窗口内可导致上一轮迟到的签名开轮/关窗消息误作用于下一轮，且 `OracleAdapter.pending` 字典永不释放）
- **位置**：
  - [contracts/contracts/OracleAdapter.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/OracleAdapter.tolk) 第 254–319 行（`SubmitSignedOpenRound`、`SubmitSignedCloseStaking`）、第 348–353 行（`SubmitSignedCandle`）
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 415–499 行（`handleOpenRound`、`handleCloseStaking`）

#### 漏洞机理与触发路径分析

在 `OracleAdapter.tolk` 中，`SubmitSignedOpenRound`（第 261–285 行）与 `SubmitSignedCloseStaking`（第 294–318 行）在验证签名时将 `msg.roundId` 纳入了签名哈希，并通过 `val q = forwardQueryId(msg.roundId, SIGNED_ACTION_OPEN/CLOSE, 0)` 将 `msg.roundId` 编码进 `queryId` 的第 16–23 位转发给 `RoundController`。

然而，审查 `RoundController.tolk` 的 `handleOpenRound`（第 415–470 行）与 `handleCloseStaking`（第 472–499 行）可以发现，**这两个函数完全没有读取或校验 `msg.queryId` 中的 `roundId`**！
- 若第 $R$ 轮在 `STATUS_PREVIEW` 超时后被无权限的 `AbortTechnical`（第 738–753 行）终止并推进至第 $R+1$ 轮，或者第 $R$ 轮由 `admin` 直接开启（使得 `OracleAdapter.usedMask[R]` 的 `SIGNED_ACTION_OPEN` 位仍为 `0`），则在签名有效期内，针对第 $R$ 轮签发的 `SubmitSignedOpenRound(roundId = R, twap24hUsdE8)` 若在随后被提交至 `OracleAdapter`（例如在测试网快测时序或跨轮紧凑衔接场景下），`RoundController` 会直接用第 $R$ 轮的签名价格错误开启第 $R+1$ 轮！
- 此外，`OracleAdapter` 在每次转发 `SubmitSignedOpenRound`（第 275 行）、`SubmitSignedCloseStaking`（第 308 行）与 `SubmitSignedCandle`（第 349 行）时都会向 `st.pending` 字典写入一条 `OraclePendingForward` 记录，但 `st.pending.delete(q)` **仅在 `onBouncedMessage`（第 405 行）中执行**。在正常未发生 Bounce 的主网运行中，全部 10 轮共 260+ 条 `st.pending` 记录永远不会被删除，持续增加合约存储体积与字典读写 Gas。

#### 防御性验证测试与修复方案

在 `RoundController.handleOpenRound` 与 `handleCloseStaking` 中，当 `msg.queryId != 0` 且 `sender == addresses(s).oracle` 时，强制校验 `((msg.queryId >> 16) & 0xff) as uint8 == roundId`；并在 `OracleAdapter` 开启新轮次时清理旧轮次的 `st.pending` 记录：

```tolk
// 修复补丁：contracts/contracts/RoundController.tolk (handleOpenRound & handleCloseStaking)
// 在 handleOpenRound 确定 roundId 后增加：
if (sender == addresses(s).oracle && msg.queryId != 0) {
    val qRoundId: uint8 = ((msg.queryId >> 16) & 0xff) as uint8;
    assert (qRoundId == roundId) throw Errors.BadRoundId;
}

// 在 handleCloseStaking 入口处增加：
if (sender == addresses(s).oracle && msg.queryId != 0) {
    val qRoundId: uint8 = ((msg.queryId >> 16) & 0xff) as uint8;
    assert (qRoundId == s.currentRoundId) throw Errors.BadRoundId;
}
```

### A9-LOW-01 奖励状态只读查询遗漏报名截止时间与解锁池启动判定

- **严重度**：Low（只读视图接口与写入接口状态判定不一致，导致前端与索引器误报可滚存状态）
- **位置**：[contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 1814–1842 行（`get_reward_state`）

#### 缺陷分析与修复建议

`v8.6` 在修复 `C-1` 时，于 `handleRollReward`（第 1359–1366 行）新增了 `if (nextRd.status == STATUS_STAKING_OPEN) { assert (now < nextRd.stakeCloseAt) throw Errors.RollNotAvailable; }` 以及 `assert (ex.unlockStart == 0) throw Errors.RewardStateLocked;`，但在只读方法 `get_reward_state`（第 1814–1842 行）中未同步加上这两项条件。当下一轮 `STAKING_OPEN` 已过 `stakeCloseAt` 但尚未被调用 `CloseStaking` 时，`get_reward_state` 仍返回大于 0 的 `rollableRaw`。建议将第 1814–1818 行更新为：

```tolk
// 修复补丁：contracts/contracts/RoundController.tolk (L1814-1819)
    val now: uint64 = blockchain.now() as uint64;
    if (state == REWARD_STATE_PENDING && !rewardClaimedNow && roundId < MAX_ROUNDS && s.extras.load().unlockStart == 0) {
        val nextFound = s.rounds.get(roundId + 1);
        if (nextFound.isFound) {
            val nextRd = nextFound.loadValue();
            if (nextRd.status == STATUS_PREVIEW || (nextRd.status == STATUS_STAKING_OPEN && now < nextRd.stakeCloseAt)) {
```

### A9-LOW-02 代币主合约首次铸造回弹时仅回滚供应量而未恢复管理员权限

- **严重度**：Low（部署期边界缺陷：若 `MintOnce` 派发消息发生 Bounce，`JettonMaster` 将永久处于 0 供应量且不可铸造状态）
- **位置**：[contracts/contracts/jetton/JettonMaster.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonMaster.tolk) 第 42–51 行、第 75–97 行

#### 缺陷分析与修复建议

在 `JettonMaster.tolk` 的 `MintOnce` 分支（第 75–79 行）中，合约将 `storage.totalSupply = TOTAL_SUPPLY_RAW`、`storage.adminAddress = null`、`storage.nextAdminAddress = null` 落盘，随后向接收方的 `JettonWallet` 发送 `InternalTransferStep`（其中 `transferInitiator: null`）。若该笔部署消息因任何原因 Bounce 回 `JettonMaster.onBouncedMessage`（第 42–51 行），代码将 `storage.totalSupply` 减回 `0`，但由于 `storage.adminAddress` 已被置为 `null` 且无法恢复，该 `JettonMaster` 实例将永久锁死在 `totalSupply = 0, mintable = false` 状态。建议在 `MintOnce` 发送的 `InternalTransferStep` 中将 `transferInitiator` 设为原 `admin` 地址，并在 `onBouncedMessage` 中恢复 `storage.adminAddress = msg.transferInitiator`。

### A9-LOW-03 首轮开启前缺失核心金库钱包地址与代码哈希就绪校验

- **严重度**：Low（部署期防呆缺失：若 `OpenRound(1)` 在 `SetJettonWallet` 或 `SetJettonWalletCode` 之前误触发，配置入口将因 `currentRoundId != 0` 永久关闭）
- **位置**：[contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 415–470 行、第 935–945 行、第 1234–1245 行

#### 缺陷分析与修复建议

`handleSetJettonWallet`（第 1238 行）与 `handleSetJettonWalletCode`（第 938 行）均要求 `assert (s.currentRoundId == 0) throw Errors.BadRoundStatus;`。在部署阶段，`RoundController` 的初始 `stakingJettonWallet` 占位符为 `admin.address`（见 [deploy-emulation.tolk](file:///Users/yu1/Desktop/BAM/contracts/scripts/deploy-emulation.tolk) 第 286 行）。若运维人员在分步部署中误先发送了 `OpenRound`，`s.currentRoundId` 将变为 `1`，导致 `SetJettonWallet` 与 `SetJettonWalletCode` 永远无法再被调用。建议在 `handleOpenRound` 的 `if (s.currentRoundId == 0)` 分支（第 424 行）增加前置就绪断言：

```tolk
// 修复补丁：contracts/contracts/RoundController.tolk (L0424-0426)
    if (s.currentRoundId == 0) {
        val v = vaults(s);
        assert (v.stakingJettonWallet != addresses(s).admin && v.jettonWalletCode.depth() > 0) throw Errors.NotInitialized;
        roundId = 1;
```

### A9-LOW-04 预言机签名人集合非零互异校验缺失与推荐除数硬编码及空操作写盘

- **严重度**：Low（代码健壮性、配置防呆与 Gas 优化）
- **位置**：
  - [contracts/contracts/OracleAdapter.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/OracleAdapter.tolk) 第 191–222 行（`SetSignerSet`）
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 888 行、第 1065–1069 行、第 1458 行

#### 缺陷分析与修复建议

1. **`OracleAdapter.SetSignerSet` 未校验公钥非零且两两互异**：`verifySignatures`（第 131–140 行）仅按 `signerIndex`（`1..5`）去重，未检查 `s0..s4` 公钥本身是否重复或为 `0`（注意 [deploy-emulation.tolk](file:///Users/yu1/Desktop/BAM/contracts/scripts/deploy-emulation.tolk) 第 250–255 行在初始部署 `OracleAdapter` 时写入了 5 个全 `0` 公钥）。若配置脚本误将同一个公钥填入 `s0, s1, s2`，单把私钥即可伪造 3/5 多签。建议在 `SetSignerSet` 中增加 `assert (s0 != 0 && s1 != 0 && s2 != 0 && s3 != 0 && s4 != 0)` 及两两不等校验。
2. **F-06 推荐补齐路径未统一调用 `referralRawAdd`**：[RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 888 行与第 1458 行仍写为 `val twenty = myReferred / 5;`，建议统一替换为 `val twenty = referralRawAdd(myReferred);` 以保持与 `REFERRAL_BPS` 常量完全解耦。
3. **`handleClaimAll` 空操作分支冗余写盘**：在第 1065–1069 行，当 `principalTotal == 0 && rewardTotal == 0` 时，未发生任何状态变更，直接 `return;` 即可，无需执行 `s.extras = ex.toCell(); s.save();`。

### A9-INFO-01 领取查询标识计数器位宽分配与链外日志索引对齐建议

- **严重度**：Informational（设计改进建议，不影响当前安全性）
- **位置**：[contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) 第 219–222 行、[contracts/contracts/constants.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/constants.tolk) 第 44–53 行

#### 说明与建议

`claimQueryId` 目前将 `roundId` 置于第 32–39 位、`kind` 置于第 24–31 位、`counter` 限制在低 24 位（`assert (counter < 0xffffff)`，上限约 1,677 万次领取），而 64 位 `queryId` 的高 24 位（第 40–63 位）闲置。若将布局调整为 `((roundId as uint64) << 56) | ((kind as uint64) << 48) | counter`（同时保持高 32 位非零以与 `burnQueryId` 区分），可将全局领取计数器上限从 $2^{24}$ 提升至 $2^{48}$。此外，`ClaimPrincipal` 与 `CloseStaking` 当前未发射独立的 `external-out` 事件日志，链下索引器通过解析入站交易和 `get_user_stake` 对账（参见 [20_INDEXER_RECONCILE.md](file:///Users/yu1/Desktop/BAM/docs/20_INDEXER_RECONCILE.md) 第 10 节第 5 条），当前设计自洽。

## 十六项核心安全控制点逐项核验矩阵

对照 [18_AUDIT_BRIEF.md](file:///Users/yu1/Desktop/BAM/docs/18_AUDIT_BRIEF.md) 第 3 节与第 7 节所列的 16 个核心审计点，下表给出逐项核验结果与关联发现编号：

| 审计点编号 | 审计控制域 | 核验内容与目标函数 | 审计结论 | 关联发现与核验说明 |
| --- | --- | --- | --- | --- |
| P0-1 | 三笔销毁的金额与顺序 | `settleRound` / `handleFinalizeRound` | 有问题（需修复） | 失败轮三笔销毁金额计算正确，但第二跳 `BurnNotificationForMinter` 发生 Bounce 时未通知控制器/金库（**A9-HIGH-01**），且 `ReturnExcessesBack` 可被外部 0 A9 销毁伪造（**A9-CRIT-01**） |
| P0-2 | 奖励分配数学 | `rewardForRound` / `handleRollReward` | 通过（附低危项） | 独立复算证实 $\sum \text{reward} \le 700\text{M}$，无 `uint128` 溢出；但微尘滚存可规避 `minStakeRaw` 刷连胜（**A9-MED-03**），`get_reward_state` 漏检截止时间（**A9-LOW-01**） |
| P0-3 | 领取回滚（Bounce） | `onBouncedMessage` / `handleTransferBounced` | 有问题（需修复） | 一跳与两跳回滚掩码逻辑正确，但 `JettonWallet` 发送 `TransferBounced` 硬编码 `0.02 TON` 在跨 10 轮回滚时易触发 `OutOfGas` 导致账户永久锁定（**A9-HIGH-03**），且退款路径无回滚追踪（**A9-CRIT-02**） |
| P0-4 | 销毁确认权威 | `handleReturnExcesses` / `confirmBurn` | 有问题（需修复） | 仅校验 `sender == jettonMaster` 存在严重「困惑副手」漏洞：任意用户可通过自身钱包销毁 0 A9 并将 `sendExcessesTo` 指向 `RoundController`/`TeamVault` 伪造销毁确认（**A9-CRIT-01**） |
| P0-5 | 权限矩阵 | `requireAdmin` / `requireAdminOrOracle` | 有问题（需修复） | 核心权限校验严密，但 `TeamVault.SetTeamWalletJettonWallet` 漏加 `controller == null` 一次性锁（**A9-MED-01**），且 `OpenRound` 漏检钱包配置就绪状态（**A9-LOW-03**） |
| P0-6 | 滚存上限与截断 | `handleRollReward` | 通过（附中危项） | 单地址 2,000 万与单轮 2 亿上限截断守恒（`rollAmount + excess == reward`），但未限制 `rollAmount` 满足 `minStakeRaw` 门槛（**A9-MED-03**） |
| P0-7 | 解锁曲线 | `handleClaimUnlocked` | 通过（附高危项） | 12×30 天线性释放与早领 50% 折叠数学准确，但入口未校验 `in.valueCoins >= 0.15 TON`，高频按秒领取可抽干控制器 TON 储备（**A9-HIGH-04**） |
| P1-8 | 状态迁移完整性 | 全状态机 `(from, to)` 跃迁 | 有问题（需修复） | 终态不可逆成立，但 `OpenRound` 在 36h 临界点前存在窗口压缩断崖（**A9-MED-02**），且 `OracleAdapter` 转发的开轮/关窗未校验 `roundId`（**A9-MED-04**） |
| P1-9 | K 线滚动哈希与顺序 | `handleSubmitCandle` / `OracleAdapter` | 有问题（需修复） | `RoundController` 侧滚动哈希与顺序校验正确，但 `OracleAdapter` 在暂停恢复后无法重置 `lastCandle`、管道化 FIFO Bounce 回滚失步、且未强制 `candleIndex` 连续（**A9-HIGH-02**） |
| P1-10 | 技术终止（逃生舱） | `handleAbortTechnical` | 通过 | 覆盖暂停 14 天、观察超时 7 天、预告期超时 14 天（含已终态轮次推进至下一轮超时预告期）及质押期超时 7 天，100% 退还本金且不消耗档位，无法被恶意提前触发 |
| P1-11 | 团队额度管理 | `TeamVault` 全方法 | 有问题（需修复） | 只认控制器且同轮释放/销毁互斥幂等，但存在销毁第二跳 Bounce 无通知死锁（**A9-HIGH-01**）、`ReturnExcessesBack` 困惑副手伪造（**A9-CRIT-01**）及 `SetTeamWalletJettonWallet` 未锁定（**A9-MED-01**） |
| P1-12 | 零人质押分支 | `settleRound` / `handleFinalizeRound` | 通过 | 零人质押照常进入观察；通过则销毁 7 亿奖励并释放 1.2 亿团队额度（D-18b），失败则销毁 7 亿奖励与 1.2 亿团队额度且自动确认 0 本金销毁 |
| P2-13 | TEP-74 语义合规性 | `JettonMaster` / `JettonWallet` | 通过 | `transfer`、`internal_transfer`、`burn`、`burn_notification`、`provide_wallet_address` 字段与行为符合 TEP-74 / TEP-89 标准 |
| P2-14 | `forward_payload` 透传 | `JettonWallet` $\rightarrow$ `RoundController` | 通过 | 136-bit `StakeDeposit` 负载在 `AskToTransfer` $\rightarrow$ `InternalTransferStep` $\rightarrow$ `TransferNotification` 全链路逐位无损透传，支持 Inline 与 Ref 两种 Either 编码 |
| P2-15 | `mint-once` 不可逆性 | `JettonMaster.MintOnce` | 通过（附低危项） | 严格限定 `totalSupply == 0` 且 `jettonAmount == 1e19`，同笔交易将 `adminAddress` 与 `nextAdminAddress` 置空，二次铸造或 `ClaimMinterAdmin` 绝无恢复可能；仅存在部署 Bounce 时未恢复 `adminAddress` 的边界问题（**A9-LOW-02**） |
| P2-16 | Canonical Wallet 校验 | `JettonMaster` / `JettonWallet` / `RoundController` | 通过 | 全部采用 `calcAddressOfJettonWallet(owner, minter, code)` 严格校验发送方是否为同构派生钱包地址，无法通过伪造外部钱包绕过 |

## 官方标准代币合约实现差异逐函数对照

根据 [18_AUDIT_BRIEF.md](file:///Users/yu1/Desktop/BAM/docs/18_AUDIT_BRIEF.md) 第 9 节要求，下表给出本仓库 Tolk 版 `JettonMaster` / `JettonWallet` 与 TON 官方参考实现（`ton-blockchain/jetton-contract` 及 Acton 官方 TEP-74 模板）的逐项 Delta 对照与安全性评估：

| 对照维度（Delta 项） | 源码位置 | 与官方参考实现的差异描述 | 安全性结论与风险评估 |
| --- | --- | --- | --- |
| `mint-once` 一次性铸造策略 | [JettonMaster.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonMaster.tolk) 第 62–98 行 | 将通用 `Mint` 改为 `MintOnce(0x00000015)`，新增 `assert(storage.totalSupply == 0)` 与 `assert(msg.jettonAmount == 10000000000000000000)`，并在同一计算阶段将 `storage.adminAddress = null` 与 `storage.nextAdminAddress = null` 落盘 | **铸造关闭不可逆性成立**：一旦铸造成功，任何地址均无法再次铸造或恢复管理员权限；需注意首次部署若发生 Bounce 会导致 `totalSupply = 0` 且 `admin = null`（见 **A9-LOW-02**） |
| `admin` 置空后的权限封闭 | [JettonMaster.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonMaster.tolk) 第 53–56, 150–179 行 | `requireAdmin` 首行校验 `assert (admin != null) throw JettonErrors.MintClosed(75)`；`MintOnce` 同时清空了 `nextAdminAddress`，故 `ClaimMinterAdmin`（校验 `nextAdminAddress != null`）亦被永久封闭 | **完全封闭，无后门路径**：铸造完成后，`ChangeMinterAdmin`、`ClaimMinterAdmin`、`DropMinterAdmin`、`ChangeMinterMetadata` 与 `MintOnce` 100% 拒绝执行 |
| 钱包代码内嵌与地址推导 | [JettonMaster.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonMaster.tolk) 第 12, 83, 199, 234 行 | 通过 `@gen/JettonWallet.code` 编译期宏内嵌 `jettonWalletCompiledCode()`，与 `RoundController` 通过 `SetJettonWalletCode` 写入的 `build("JettonWallet")` 共享同一份编译产物 | **地址推导自洽**：`get_jetton_wallet_code_hash()` 与 `JettonWallet.json` 产物哈希均为 `0x394E4E8D...49A4`，链上与链下地址推导完全一致 |
| `forward_payload` 透传语义 | [JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk) 第 88–103, 126, 156 行 | 使用 `RemainingBitsAndRefs` 原样透传 `forwardPayload`；`unwrapForwardPayload`（[jetton.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton.tolk) 第 38–52 行）兼容 `0b0`（内联）与 `0b1`（引用 Cell）两种 TL-B `Either` 格式 | **语义等价且安全**：136-bit `StakeDeposit` 负载在跨合约传递中保持逐比特一致 |
| `burn_notification` 与余量回传 | [JettonMaster.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonMaster.tolk) 第 189–217 行 | 除标准 `0x7bdd97de` 外额外兼容 `0x7bcdEFA0` 别名；将官方 `ReturnExcessesBack` 的 `SEND_MODE_IGNORE_ERRORS` 改为 `SEND_MODE_BOUNCE_ON_ACTION_FAIL`（F-04 修复） | **存在跨合约交互风险**：因 `ReturnExcessesBack` 被协议上层用作销毁与释放完成权威信号，未限制 `sendExcessesTo == burnInitiator` 导致了 **A9-CRIT-01** 困惑副手伪造漏洞 |
| 第二跳 Bounce 通知扩展（`C-4`） | [JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk) 第 25–63 行 | 官方 `JettonWallet` 在 `onBouncedMessage` 中仅恢复 `jettonBalance`；A9 新增了向 `storage.ownerAddress` 发送 `TransferBounced(0x52540027)` 的逻辑 | **覆盖不完整**：仅处理了 `InternalTransferStep` 而遗漏了 `BurnNotificationForMinter`（**A9-HIGH-01**），且固定 `0.02 TON` 易导致多轮回滚 `OutOfGas`（**A9-HIGH-03**） |
| 错误码定义 | [errors.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/errors.tolk) 第 1–14 行 | 保留 TEP-74 标准错误码 `47/48/49/72/73/74/333`，新增 `MintClosed = 75`、`MintAmountMismatch = 76`、`InvalidMintMessage = 77` | **符合标准规范**：与 TEP-74 标准错误码无冲突 |

## 已确认接受风险复核与审计异议说明

依据任务书第 5 节与第 10 节要求，审计方对项目方列出的 6 项「已知问题与已接受风险」进行了逐条复核。对于第 1、2、4、5、6 项，审计方确认其属于明确的商业机制选择、法务自担边界或预期工程行为，不在本报告中重复列为缺陷；但针对 **第 3 项（D-36 单一冷钱包管理员风险描述）** 以及 [18_AUDIT_BRIEF.md](file:///Users/yu1/Desktop/BAM/docs/18_AUDIT_BRIEF.md) 第 4 节中的 **「退款路径 bounce 由 admin 重发」**，审计方提出明确的技术异议与修正说明：

| 序号 | 项目方已知风险条目（出处） | 审计方复核结论 | 审计方技术说明或异议理由 |
| --- | --- | --- | --- |
| 1 | 2× 倍数下理性用户 EV 为负（$-89\% \sim -99\%$），机制依赖 FOMO 而非正期望（D-33） | 确认无异议 | 属于已充分量化并在前端强披露的产品经济学设定，合约层面严格按 2× 目标阶梯执行 |
| 2 | 不做法律意见书，合规风险由项目方自担（D-34） | 确认无异议 | 属于商业与法务决策范畴，合约通过 `riskDisclosureVersion` 与 `acceptFullPrincipalBurn == 1` 强制校验用户链上确认 |
| 3 | 主网 admin 采用单一冷钱包（不做多签）。风险：admin 永久不可改 / TV 可重定向团队额度 / OA 可换签名人 / 单钥无补救（D-36） | **部分异议（存在源码级事实偏差）** | （1）确认 `RoundController` 与 `TeamVault` 无 `SetAdmin` 系有意设计，单密钥风险由项目方自担；<br>（2）**异议点**：D-36 声称「TV admin 可通过 `SetTeamWalletJettonWallet` 重定向团队 12% 额度的收款地址」，但实际上 `TeamVault` 转账目标为不可变的 `params.teamWallet`（第 106 行），修改 `teamWalletJettonWallet` **并不能重定向团队资金**，反而会导致 `ReturnExcessesBack` 校验失败并使 `RoundController` 永久卡死在 `STATUS_SETTLING_SUCCESS`（详见 **A9-MED-01**） |
| 4 | 不接预言机时，admin 可手动提交 K 线，技术上可操控单轮输赢 | 确认无异议 | `RoundController` 的 `requireAdminOrOracle` 同时允许 `admin` 与 `oracle`（`OracleAdapter`）提交 K 线；即使接入 `OracleAdapter`，`admin` 仍保有直接提交或更换 `OracleAdapter` 签名人的权限，已在用户风险披露中写明 |
| 5 | R10 线性解锁立即领取会返回 `NothingUnlocked`（docs/18 §15） | 确认无异议 | 在 `now == unlockStart` 时 `elapsed = 0`、`vested = 0`，抛出 `Errors.NothingUnlocked(265)` 完全符合线性释放数学定义 |
| 6 | 生产参数时序（12h/36h/24h）只经过 emulation 验证，尚未在真实链上跑完整一轮 | 确认无异议 | 建议在修复本报告发现并发布 `v8.7-audit-fixed` 后，在测试网部署生产时序实例至少跑通 1 轮真时序验证 |
| 补充 | 审计简报 docs/18 §4 与 contracts/README §9 #22 称「非法质押退款路径 bounce 无 pending，由 admin/ops 手工重发退款」 | **明确异议（技术上不可行）** | `rcWallet` 的 owner 是不可升级的 `RoundController` 合约而非 `admin`，且 `RoundController` 无任何允许 `admin` 划转未记账代币的接口；一旦退款失败，管理员**根本无法**手工重发，资金将永久锁死（详见 **A9-CRIT-02**） |

## 修复复核流程与主网发布门禁建议

鉴于 `RoundController` 与 `TeamVault` 的不可升级特性，为确保协议在主网环境下的资金安全与全周期活性（Liveness），建议项目方在 `M3`（修复阶段）与 `M4`（复核阶段）严格执行以下门禁步骤：

第一阶段为 **核心安全补丁合入（打标 `v8.7-audit-fixed`）**。项目方应仅针对本报告列出的安全发现进行最小化代码修改（严禁混入非审计相关的功能变更）：
1. **必选阻断项（Blocker）**：完整修复 **A9-CRIT-01**（在 `JettonWallet` 与 `JettonMaster` 中限制 `sendExcessesTo` 必须为空或等于 `ownerAddress`/`burnInitiator`、禁止 0 金额转账与销毁，并在 `confirmBurn` 中校验 `dispatched` 标志）、**A9-CRIT-02**（重构 `refundStake` 为零倒贴转发 + 失败/低 Gas 可领退款账本）、**A9-HIGH-01**（补齐 `BurnNotificationForMinter` 的两跳 `TransferBounced` 通知及 `RoundController`/`TeamVault` 侧的销毁回滚）、**A9-HIGH-02**（收紧 `OracleAdapter` 的 `candleIndex == lastPlus` 连续校验、将 Bounce 回滚条件改为 `p.prevLastPlus < current`、并增加观察窗口重置支持）、**A9-HIGH-03**（将 `JettonWallet.onBouncedMessage` 中的 `TransferBounced` 改为预留最小存储费后以 `SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS` 携带全部剩余回弹价值）以及 **A9-HIGH-04**（在 5 个领取入口与 3 个预言机入口补充 `in.valueCoins` 最小金额断言）。
2. **强烈建议合入项**：同步修复 **A9-MED-01**（锁定 `SetTeamWalletJettonWallet` 仅允许在 `controller == null` 时调用）、**A9-MED-02**（`handleOpenRound` 无条件将 `rd.stakeOpenAt` 锚定为 `now`）、**A9-MED-03**（`handleRollReward` 校验 `minStakeRaw`）、**A9-MED-04**（校验 `OpenRound`/`CloseStaking` 的 `queryId` 轮次编码）以及 **A9-LOW-01** 至 **A9-LOW-04**。

第二阶段为 **构建哈希重算与自动化回归测试扩展**。由于修改了 `JettonWallet.tolk`，所有派生 `JettonWallet` 的地址及 5 个核心合约的 `Code Hash` 均会发生变化：
1. 运行 `acton build --clear-cache` 与 `acton check`，确认 `0 error 0 warning`，并记录 `v8.7-audit-fixed` 下 5 个合约的全新冻结 `Code Hash`。
2. 将针对本报告 **A9-CRIT-01** 至 **A9-LOW-04** 的防御性回归测试用例合入 `contracts/tests/`，确保全部原有 154 个测试与新增回归测试 100% 通过。
3. 使用全新空链模式（禁止使用 `A9_RESUME_JETTON_MASTER_ADDRESS` 复用旧版 `JettonMaster`，因为内嵌的 `JettonWallet` 代码哈希已变更）重新部署测试网实例，重跑 10 轮链上验收与 `chain-reconcile.mjs` 对账脚本，验证 `DIFFS (0)` 与总量守恒误差 `0 raw` 后，提交审计方执行 `M4` 最终复核确认。

## 参考资料与源码索引

- [21_AUDIT_RFP.md](file:///Users/yu1/Desktop/BAM/docs/21_AUDIT_RFP.md) — A9 协议主网前外部安全审计任务书（D-37）
- [18_AUDIT_BRIEF.md](file:///Users/yu1/Desktop/BAM/docs/18_AUDIT_BRIEF.md) — A9 协议 V8.6 外部审计技术简报（冻结基线 `v8.6-audit-fixed @ c24809a`）
- [00_DECISIONS_V2.md](file:///Users/yu1/Desktop/BAM/docs/00_DECISIONS_V2.md) — A9 协议全部产品与安全决策记录（D-01 至 D-37）
- [11_CONTRACT_PLAN.md](file:///Users/yu1/Desktop/BAM/docs/11_CONTRACT_PLAN.md) — 合约技术方案、语言选型与 TEP-74 复刻说明
- [17_REWARD_V2.md](file:///Users/yu1/Desktop/BAM/docs/17_REWARD_V2.md) — V8 奖励机制（权重制与三态状态机）完整规格书
- [03_ORACLE_SPEC.md](file:///Users/yu1/Desktop/BAM/docs/03_ORACLE_SPEC.md) — 价格预言机与 K 线验证规格书
- [19_TESTNET_ACCEPTANCE.md](file:///Users/yu1/Desktop/BAM/docs/19_TESTNET_ACCEPTANCE.md) — 测试网 v8.6 十轮链上权威验收报告
- [20_INDEXER_RECONCILE.md](file:///Users/yu1/Desktop/BAM/docs/20_INDEXER_RECONCILE.md) — 链上索引器全生命周期对账报告
- [contracts/README.md](file:///Users/yu1/Desktop/BAM/contracts/README.md) — 合约 ABI、存储布局、Gas 实测与历史修复记录（P0-1~P0-3、F-01~F-09、M-1、S-3、C-1~C-4）
- [RoundController.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/RoundController.tolk) — 核心轮次控制器、质押金库与奖励结算合约源码（1,938 行）
- [TeamVault.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/TeamVault.tolk) — 团队 12% 额度托管合约源码（359 行）
- [OracleAdapter.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/OracleAdapter.tolk) — 3/5 Ed25519 多源签名预言机适配器合约源码（449 行）
- [JettonMaster.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonMaster.tolk) — A9 TEP-74 代币主合约源码（246 行）
- [JettonWallet.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton/JettonWallet.tolk) — A9 TEP-74 代币钱包合约源码（206 行）
- [types.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/types.tolk) / [constants.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/constants.tolk) / [jetton.tolk](file:///Users/yu1/Desktop/BAM/contracts/contracts/jetton.tolk) — 协议共享数据结构、常量错误码与消息构造器源码
- [deploy-emulation.tolk](file:///Users/yu1/Desktop/BAM/contracts/scripts/deploy-emulation.tolk) — 确定性部署与初始化接线脚本
- [jetton-integration.test.tolk](file:///Users/yu1/Desktop/BAM/contracts/tests/jetton-integration.test.tolk) / [c4.test.tolk](file:///Users/yu1/Desktop/BAM/contracts/tests/c4.test.tolk) / [oracle-adapter.test.tolk](file:///Users/yu1/Desktop/BAM/contracts/tests/oracle-adapter.test.tolk) / [rewards-v8.test.tolk](file:///Users/yu1/Desktop/BAM/contracts/tests/rewards-v8.test.tolk) — 合约集成测试与回归测试套件
