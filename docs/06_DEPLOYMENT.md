# 06 --- 开发、测试与部署 Runbook

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
      round_controller.tolk
      staking_vault.tolk
      reward_vault.tolk
      oracle_adapter.tolk
      contribution_registry.tolk   # optional
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
质押窗口、最低/最高质押量和单地址限制。 6. 奖励分配算法。 7.
奖励领取/归属规则。 8. 技术性预言机终止流程。 9. 团队归属规则。 10.
营销及内盘/流动性资金管理规则。 11. 多签角色和紧急暂停权限。 12.
用户风险披露文本及版本号。

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

部署顺序建议： 1. Jetton Master/Wallet。 2. RewardVault。 3.
StakingVault。 4. OracleAdapter。 5. RoundController。 6.
配置各合约地址与权限。 7. 向 RewardVault 注入75亿奖励池。 8.
验证10个轮次各有7.5亿独立预算。 9. 验证初始分配总和为100亿。 10.
执行完整模拟轮次。

至少演练： - 一轮成功：8/12或以上。 - 一轮失败：7/12或以下。 -
预言机故障暂停和恢复。 - 失败销毁两笔 burn 和 supply 变化。 -
成功本金返还和奖励领取。 - 重复消息和 bounce 重试。

## 6. 阶段四：主网部署

部署前检查： - 所有参数已签署并冻结。 - 审计报告无未解决的 Critical/High
问题。 - 代码哈希与审计版本一致。 - 多签地址和阈值已公开。 - Jetton
Master mint 权限策略已确认。 - 预言机签名验证已在主网可用。 -
资金金库地址已验证。 - 所有交易均有足够 TON 支付 gas。 -
用户风险披露已在前端显示。 - 应急联系人和监控系统已就绪。

部署后： 1. 公布所有合约地址。 2. 公布源代码和代码哈希。 3.
公布初始供应量和分配交易。 4. 冻结 P0 及 oracle config hash。 5. 开启
Round 1。 6. 开放链上状态查询和事件索引。

## 7. 运维与监控

监控指标： - Jetton Master total_supply。 - 每个金库 Jetton 余额。 -
每轮状态。 - 每轮 stake 总额和参与地址数。 - 12根K线提交情况。 -
预言机数据延迟、有效来源数和偏差。 - pending burn 数量和确认状态。 -
pending refund/claim 数量。 - 合约 TON 余额和 gas 余量。 -
bounce、异常消息和失败交易。

告警： - oracle stale； - candle 缺失； - 质押窗口结束但仍收到入账； -
burn pending 超时； - total_supply 与账本不一致； - 非预期管理员操作； -
金库余额不足； - 合约暂停。

## 8. 密钥与权限

-   生产密钥不得存放在代码仓库。
-   多签私钥由不同责任人独立保管。
-   管理员不得拥有任意转移用户质押本金的权限。
-   紧急暂停不得直接改变价格判定结果。
-   任何配置变更必须经过时间锁和公开公告；核心规则最好在部署时固定不可升级。
-   若选择可升级架构，必须明确升级权限、延迟、治理流程和用户退出安排。

## 9. 发布验收标准

只有同时满足以下条件，才能宣布主网可用： - 编译可重复； -
全部测试通过； - 不变量测试通过； - 安全审计完成； -
预言机数据验证可用； - Testnet 成功和失败两种路径均完成； -
失败销毁实际减少 total_supply； - 质押本金返还与销毁互斥； -
用户风险披露和交易 payload 一致； - 所有待确认参数已冻结。
