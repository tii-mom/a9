# 06 --- 开发、测试与部署 Runbook

> **口径声明（V6）**：观察 **72h / 18 根 / 12 阈值（容错 6 根）**；目标价**开窗时锁定 `max(阶梯 P0×2^tier, 2×开窗 24h TWAP)`**、锁定后不可改；**95% 闸门与 7 天提档已取消**；**24h PREVIEW 预告期已确认**（结算→预告→自动开窗）；保留触价提前关窗；单轮 7 天 / 10 轮 70 天；分配 70/8+5/12/5；P0 = $0.00116；内盘 8 亿 A9、流动性 5 亿 A9（冷启动 1 亿 + $116k）；TeamVault 团队 12 亿；不允许取消质押；奖励 pull claim。与 docs/00 冲突以其为准。

## 1. 推荐工具链

根据 TON 官方智能合约文档： - Tolk 是官方推荐的智能合约语言。 - Acton
是推荐的合约全生命周期工具链，可用于项目初始化、构建、测试、脚本、调试和部署。

团队也可选择其他成熟 TON 工具链，但必须锁定： - Tolk/编译器版本； -
Acton/构建工具版本； - SDK 版本； - Node.js 版本； - 所有依赖锁文件； -
构建环境和 CI 镜像。

## 2. 建议代码仓库结构

``` text
project/
  contracts/
    jetton/
      jetton_master.tolk
      jetton_wallet.tolk
    protocol/
      round_controller.tolk        # 自研 1/2：状态机、判定、结算、claimAll
      team_vault.tolk              # 自研 2/2：12 亿托管、按轮释放/销毁（只接受 RC 指令）
      oracle_adapter.tolk          # optional（二期）
      # 说明（V5）：质押金库 / 奖励金库 = 标准 Jetton Wallet（owner = RoundController）；
      # TeamVault = 自研合约，持有 12 亿的 Jetton Wallet（owner = TeamVault）；
      # 团队/营销/流动性收款 = 个人热钱包（地址不公开），不部署 vesting/lockup/multisig 合约
    shared/
      messages.tolk
      storage.tolk
      errors.tolk
      math.tolk
  tests/
    unit/
    integration/
    fuzz/
    invariants/
  scripts/
    deploy_testnet/
    deploy_mainnet/
    verify/
    seed_vaults/
  frontend/
  oracle-service/
  docs/
  config/
    testnet/
    mainnet/
```

## 3. 阶段一：规格冻结

主网部署前必须完成： 1. 代币名称、符号、decimals。 2. P0
算法和初始基准期。 3. 价格来源和预言机供应商/验证模式。 4.
最低来源数、流动性、成交量、偏差和覆盖率。 5.
报名窗口（**72h**）与轮次间隔（**0，结算后立即开启**）、最低/最高质押量和单地址限制。 6. 奖励分配算法（纯质押比例）。 7.
奖励领取方式（**V5 已定：pull claim / claimAll，用户付 gas**）。 8. 技术性预言机终止流程。 9. 团队额度（**V5：TeamVault 托管，每轮 1.2 亿释放/销毁**）。 10.
营销及内盘/流动性资金管理规则（**V5：个人热钱包，无多签，地址不公开**）。 11. 单密钥 owner 的权限边界（**不设多签，RC 不可升级**）。 12.
用户风险披露文本及版本号。 13. **V5 待决策：解锁窗口与目标价冲突（方案 A / B+（Lead 推荐）/ C，见 docs/00 §7）**。
14. **已确认（V5.3）**：观察窗口 18 根 / 72h / 12 根不变；不允许取消质押、仅技术终止退本金。
15. **已确认（V5.4）**：比价 1 GRAM = 1000 A9（P0 $0.00116）、冷启动池 A（1 亿 A9 + $116,000）、目标价每轮结算写入且不预存 10 轮价格、2× 最终确认。
16. **待确认（docs/12）**：D-28 失败同档重试、D-29 R1 启动规则、D-30 搭便车时间加权；定案前按当前基线部署。
17. **D-32 已确认（V5.5）**：内盘销售 8%（8 亿 A9）+ 流动性 5%（5 亿 A9），8%+5%=13% 不变，其他比例不变。

任何一项未确定，不得开放主网质押。

## 4. 阶段二：本地开发

-   建立 Tolk/Acton 工程。
-   编写 Jetton Master/Wallet。
-   编写 RoundController。
-   编写 StakingVault 和 RewardVault。
-   编写 OracleAdapter。
-   编写单元测试、集成测试和不变量测试。
-   生成 ABI、部署脚本和前端类型。
-   CI 中强制格式化、静态分析、构建和测试。

## 5. 阶段三：Testnet

> **启动前置（V4/V5，用户明确）**：等所有文档与细节敲定、参数签字后再启动测试网，不要提前开始。测试网方案见 docs/11 §2.2（按最终架构，自研 **RoundController + TeamVault 共 2 个**；不再使用多签 MVP）。

部署顺序（**V6.3：与 ops/ 脚本 00→10→11→20→30→40→65→70→55→50→60 对齐**）：

1. **00 preflight**：参数/地址/密钥/工具链/钱包预检查（离线 dry-run 先跑）。
2. **10 deploy Jetton Master**（TEP-74）。
3. **11 mint & lock**：铸造 100 亿 + 关闭 mint。
4. **20 deploy TeamVault**（controller=null 部署）。
5. **30 deploy RoundController** + 初始化数据。
6. **40 init params**：参数快照 + 链上 `get_protocol_config` 比对。
7. **65 SetJettonWallet（0x52540016）**：一次性调用，RC/TV 绑定 canonical Jetton Wallet；**必须早于 70 InitController**。
8. **70 InitController**：TeamVault 绑定 RC（**不可逆，双人核对**）。
9. **55 fund TON**：RC ≥20 TON / TV ≥10 TON gas。
10. **50 fund vaults**：注资 70 亿奖励 + 12 亿团队（`--all` 含 8/5/5 亿分配）。
11. **60 verify & register**：登记表定稿 + 地址簿生成 + 链上核对。

随后验证（V6.3）：

- 验证参数：`stakeDuration=259200`、`previewSeconds=86400`、观察 `candleCount=18 / minQualified=12 / observationSeconds=259200`、P0=116,000、倍数=2。
- 验证质押限额：单笔 10,000 A9 / 单地址 **20,000,000 A9（固定硬顶）** / 本轮 200,000,000 A9；技术终止（暂停 14 天 / 观察超时 7 天）。
- **R1 由管理员手动 `OpenRound`（无 PREVIEW）**；R2~R10 走「结算 → 24h PREVIEW → 自动开窗」。
- 验证目标价：开窗锁定 `max(阶梯 P0×2^tier, 2×开窗 24h TWAP)` + `TargetPriceSet` 事件；不预存 10 轮价格。
- **测试网 BurnAck 由 jettonMaster 地址充当权威**；主网前必须改为 Jetton Master burn ack 扩展或「标准 burn + 链下对账 + owner 确认」（见 docs/10 阻塞项）。
- 执行完整模拟轮次。

至少演练： - 一轮成功：12/18或以上（含 TeamVault 释放 1.2 亿到团队收款钱包）。 - 一轮失败：7/12或以下（**三笔** burn：奖励 7 亿 + TeamVault 团队额度 1.2 亿 + 全部本金，核对 supply 变化）。 -
预言机故障暂停和恢复。 - 无人质押轮次：照常观察；通过时 7 亿奖励销毁，失败时奖励 + 团队额度销毁。 -
成功本金返还和奖励领取（**claimAll 跨 2~10 轮一次领取、合并一笔转账**）。 - TeamVault 非 RC 指令被拒、重复指令幂等。 - 重复消息和 bounce 重试。

## 6. 阶段四：主网部署

部署前检查： - 所有参数已签署并冻结。 - 审计报告无未解决的 Critical/High
问题。 - 代码哈希与审计版本一致。 - **收款钱包地址已登记（不对外披露，至少向审计/交易所披露）；单密钥 owner 权限最小化，无多签/无时间锁/RC 不可升级（已风险接受）**。 - Jetton
Master mint 权限策略已确认。 - 预言机签名验证已在主网可用。 -
资金金库地址已验证。 - 所有交易均有足够 TON 支付 gas。 -
用户风险披露已在前端显示。 - 应急联系人和监控系统已就绪。

部署后： 1. 公布所有合约地址（Jetton Master、RoundController、TeamVault）与 owner 地址；**团队/营销/流动性收款地址不公布**，仅向审计/交易所披露。 2. 公布源代码和代码哈希。 3.
公布初始供应量和分配交易。 4. 冻结 P0 及 oracle config hash。 5. 开启
Round 1。 6. 开放链上状态查询和事件索引。

## 7. 运维与监控

监控指标： - Jetton Master total_supply。 - 每个金库 Jetton 余额（含 TeamVault）。 -
每轮状态。 - 每轮 stake 总额和参与地址数。 - TeamVault 释放/销毁金额、到账与幂等状态。 - claimAll 领取笔数与 gas。 - 18根K线提交情况。 -
预言机数据延迟、有效来源数和偏差。 - pending burn 数量和确认状态。 -
pending refund/claim 数量。 - 合约 TON 余额和 gas 余量。 -
bounce、异常消息和失败交易。

告警： - oracle stale； - candle 缺失； - 质押窗口结束但仍收到入账； -
burn pending 超时； - 团队额度释放/销毁失败或重复； - total_supply 与账本不一致； - 非预期管理员操作； -
金库余额不足； - 合约暂停。

## 8. 密钥与权限（V5：不设多签、单密钥最小权限、RC 不可升级）

-   生产密钥不得存放在代码仓库。
-   **项目不设置多签**；营销 5%、流动性 5%（5 亿）与团队收款钱包均为**个人热钱包**；管理员为 RoundController 单密钥 owner。
-   **收款地址不对外披露**：由项目方部署前提供并填入 config；至少向审计方/交易所披露，公开材料只说明"项目方热钱包持有"。
-   单密钥 owner 权限最小化：仅能开轮、关报名、暂停/恢复预言机、必要时触发结算；不得转移用户质押本金、不得修改已开轮参数。
-   紧急暂停不得直接改变价格判定结果。
-   **私钥保管规范**：硬件钱包冷存储备份；热钱包只放运营所需小额；密钥离线多份分离保管；定期轮换演练与权限复核；异常 admin 操作告警。
-   **RoundController 不可升级**（D-24，无升级代理）；TeamVault 仅接受 RC 指令，同样无升级代理。
-   明确接受的风险：单私钥丢失 / 泄露将导致对应资金损失或管理员能力被夺；缓解措施见 docs/10 §9 风险登记册。

## 9. 发布验收标准

只有同时满足以下条件，才能宣布主网可用： - 编译可重复； -
全部测试通过； - 不变量测试通过； - 安全审计完成； -
预言机数据验证可用； - Testnet 成功和失败两种路径均完成； -
失败销毁**三笔**均实际减少 total_supply（奖励 + 团队 + 本金，团队笔由 TeamVault 执行）； - 成功轮 TeamVault 释放 1.2 亿到账且只释放一次； - claimAll 跨轮领取金额正确、幂等、合并一笔转账； - 报名窗口 72h / 间隔 0 与观察 72h 边界精确； - 质押本金返还与销毁互斥； -
用户风险披露和交易 payload 一致； - 所有待确认参数已冻结。
