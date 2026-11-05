# 08 --- 技术参考资料

以下资料用于 TON
标准与工具链实现参考。开发时应以官方文档和对应标准的最新版本为准。

1.  TON Smart Contracts Overview\
    https://docs.ton.org/contracts/overview\
    智能合约开发、工具链和标准合约概览。

2.  TON Tolk Overview\
    https://docs.ton.org/tolk/overview\
    Tolk 语言说明。

3.  TON Jetton Standard Overview\
    https://docs.ton.org/contracts/standard/tokens/jettons/overview\
    Jetton（TEP-74）架构概览。

4.  How Jetton Works\
    https://docs.ton.org/contracts/standard/tokens/jettons/how-it-works\
    Jetton Master、Jetton Wallet、转账通知和 burn 消息流程。

5.  How to Burn Jettons\
    https://docs.ton.org/contracts/standard/tokens/jettons/burn\
    Jetton 销毁流程及工具参考。

6.  TON Oracles\
    https://docs.ton.org/onboarding/oracles\
    预言机基础、push/pull 模式以及 TON 的请求-响应交互建议。

7.  TON Internal Messages\
    https://docs.ton.org/foundations/messages/internal\
    内部消息和 bounce 行为。

8.  TON Smart Contract Security\
    https://docs.ton.org/v3/guidelines/smart-contracts/security/common-vulnerabilities/\
    智能合约安全风险参考；若路径调整，请从 TON
    官方文档导航查找当前安全章节。

9.  TEP-74 Jetton Standard\
    https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md\
    Jetton 标准原文。

## 重要说明

-   TEP-74 定义通用交互标准，但具体 Jetton Master/Wallet
    实现仍需检查代码。
-   项目自定义 burn acknowledgement 扩展必须经过独立审计。
-   预言机服务商、价格源、签名格式和链上适配器必须在部署时明确。
-   本文未将任何第三方价格服务标记为已选定或已集成。
