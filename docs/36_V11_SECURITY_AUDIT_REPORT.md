# A9 Protocol v11 智能合约主网前安全审计报告

- **审计对象**：A9 Protocol v11 智能合约及链下编码/ABI 一致性
- **代码仓库**：[tii-mom/a9](https://github.com/tii-mom/a9)
- **冻结版本**：tag `v11-audit-freeze`（commit `f150657cb3145b8542b55c810d3469760dcbbcf2`）
- **编译器与工具链**：Acton `1.1.0` / Tolk `1.4.1`
- **审计日期**：2026-11-07
- **权威规格依据**：[docs/21_AUDIT_RFP.md](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/docs/21_AUDIT_RFP.md)、[docs/35_GAMEPLAY_V11.md](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/docs/35_GAMEPLAY_V11.md)、[contracts/README.md](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/README.md)、[ops/config/mainnet.params.json](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/ops/config/mainnet.params.json)

## 1. 执行摘要与代码哈希核对

### 1.1 冻结版本与代码哈希核对

审计启动前，已对 `v11-audit-freeze`（commit `f150657`）下的全部 4 个自研合约与 2 个标准模板合约的编译产物（`contracts/build/*.json`）及源码进行逐一核对，所有代码哈希与任务书（`docs/21_AUDIT_RFP.md` §2）完全一致：

| 合约名称 | 类别 | 源文件 | 编译代码哈希（Code Hash） | 核对结果 |
| --- | --- | --- | --- | --- |
| **RoundController** | 自研核心合约 | `contracts/contracts/RoundController.tolk`（含 `types.tolk`、`constants.tolk`、`jetton.tolk`、`ticket.tolk`） | `0x905F62F5CF3B114E94F195E25319F58A505FBFCD78EA3997AE8E26D285D5C96B` | 一致 |
| **StakeTicket** | 自研子合约 | `contracts/contracts/StakeTicket.tolk`、`contracts/contracts/ticket.tolk` | `0x0F00D2995452947199CE5887B17C3F0BF502ECAE1D9A439A74A8D32E7EBD3DBC` | 一致 |
| **JunxiangDistributor** | 自研分发合约 | `contracts/contracts/JunxiangDistributor.tolk`、`contracts/contracts/junxiang.tolk` | `0x7FD6F461CF14393C3BB0FECB1208EB9B796A974D84B140EE9FCE9B10B14932AF` | 一致 |
| **ClaimRecord** | 自研记录合约 | `contracts/contracts/ClaimRecord.tolk`、`contracts/contracts/junxiang.tolk` | `0xA74D51786D46FE16A749D92D71D5479A6D10689C5542D3A46D6B7E42FD302C43` | 一致 |
| **JettonMaster** | 标准模板 + 一次性铸造 | `contracts/contracts/jetton/JettonMaster.tolk`（及 `jetton/*`） | `0x76B56D9A6301223F1201D719E2F4A3FB84E08D7D701CB93BB43C9D0208E5E241` | 一致 |
| **JettonWallet** | 官方 TEP-74 标准模板 | `contracts/contracts/jetton/JettonWallet.tolk`（及 `jetton/*`） | `0xD06DAA57ED188CE9CB6CA596DD2111347433BF335223AC66C0D713C8E3DB74F4` | 一致 |

> **仓库分支注意**：主仓库根目录默认检出在 `main` 分支（停留在 `d649008` v10 版本），而 `v11-audit-freeze`（`f150657`）位于 `claude/a9-gameplay-design-7b065a` 分支及工作树中。主网发布及打 `v11-audit-fixed` 标签前，务必将修复后的 v11 分支合入主干并确保部署脚本在正确的分支上执行。

### 1.2 审计发现总览

本次审计共识别出 **9 项安全与一致性发现**（其中 **0 项 Critical**、**1 项 High**、**4 项 Medium**、**3 项 Low**、**1 项 Informational**）：

| 编号 | 标题 | 严重度 | 位置 | 核心影响 |
| --- | --- | --- | --- | --- |
| **A9-V11-01** | `JunxiangDistributor.RecordPay` 与 `RoundController.handleDeposit` 未预留合约原有 TON 即混用 `SEND_MODE_REGULAR` 事件与 `MODE_64` 转发，导致合约 TON 耗尽后军饷领取在 `ClaimRecord` 已记账后回滚、用户资金永久锁定 | **High** | `JunxiangDistributor.tolk:60-66`<br>`RoundController.tolk:206-225` | `JunxiangDistributor` 部署仅配 1 TON，外部事件转发费持续消耗合约自有 TON；耗尽后 `ClaimRecord` 已永久推进 `claimedRaw`，而 `RecordPay` 在 Action Phase 报 `exit 37` 失败，用户军饷 A9 永久锁定无法补领 |
| **A9-V11-02** | `RoundController.handleTicketRequest` 等跨合约消息缺少 `SEND_MODE_BOUNCE_ON_ACTION_FAIL`（`+16`），Action Phase 失败时不产生 bounce 导致 `StakeTicket.pending` 永久死锁 | **Medium** | `RoundController.tolk:149-157, 420-479`<br>`StakeTicket.tolk:69-85` | 若链上全局转发费/gas 参数上调或极端条件下 Action Phase 失败，TVM 回滚 `RC` 状态但**不弹回** `TicketRequest`，攻城令 `pending` 永久卡死 |
| **A9-V11-03** | `ClaimRecord` 拒绝重复/旧额度请求（`throw 271`）时，因 `RecordAdvance` 采用 `BounceMode.NoBounce`，用户附带的 `~0.19 TON` 被截留在 `ClaimRecord` 中 | **Medium** | `JunxiangDistributor.tolk:52-58`<br>`ClaimRecord.tolk:20-21` | 与 `ClaimRecord.tolk:20` 注释预期相反；若用户在最后一期军饷重复点击或并发提交，多付的 TON 将永久沉淀在 `ClaimRecord` |
| **A9-V11-04** | 部署目录 ABI 文件 `contracts/deploy/abi/RoundController.json` 过期，缺失 `fallbackUnlockSeconds` 字段 | **Medium** | `contracts/deploy/abi/RoundController.json:210-243, 559-588` | `ProtocolTiming` 与 `ProtocolStateView` 少一个 `uint32` 槽位，依赖该 ABI 构造初始数据或解析状态的外部工具会出现 32-bit 错位 |
| **A9-V11-05** | 链下运维脚本与索引器对账存在 3 处逻辑偏差（`80_admin_ops.mjs` 军饷余额校验未扣已领额、第 10 城 `AbortTechnical` 销毁未入账、`ReleaseTeam` 未纳入对账） | **Medium** | `ops/scripts/80_admin_ops.mjs:257`<br>`worker/src/indexer/sync.ts:473`<br>`worker/src/indexer/ledger.ts:83` | 第 2 期起军饷发根脚本会被误拦截；若第 10 城发生技术终止或 30 天后执行最终团队释放，索引器对账将长期报假阳性错误 |
| **A9-V11-06** | `OpenRound` 与 `SubmitCandle` 未向 `keeper` 退还多余 TON，与 `mainnet.params.json` 的 `keeperMinTon = 2 TON` 假设冲突 | **Low** | `RoundController.tolk:231-272`<br>`ops/config/mainnet.params.json:325` | `admin_op` 每笔附带 0.3 TON，单轮 25 笔共消耗 `keeper` 7.5 TON（全部留在 RC）；仅靠 2 TON 初始余额在第 1 轮第 6 根 K 线即断气 |
| **A9-V11-07** | `junxiang.tolk:merkleRootOf` 未校验每个 proof cell 尾部不足 256 bits 的残留比特与多余 ref | **Low** | `contracts/contracts/junxiang.tolk:48-62`<br>`junxiang_claim.tolk:20-45` | 存在默克尔证明 BOC 编码延展性（malleability）；此外 CLI 脚本 `junxiang_claim.tolk` 仅支持 `≤ 3` 层证明（最多 8 个地址） |
| **A9-V11-08** | `RoundController.handleDeposit` 解析 `beneficiary` 地址时未预检 `anycast == 0`，传入 `anycast = 1` 的 267-bit slice 会触发 `CellUnderflow (exit 9)` 而非走退款分支 | **Low** | `RoundController.tolk:179-182` | 构造含 `anycast=1` 的 267-bit payload 会导致 `loadAddress()` 抛 TVM 异常 9，使该笔充值无法走 `refundDeposit` 原路退回 |
| **A9-V11-09** | 时间参数下界未在合约层断言、魔法数字错误码（`260`/`270`/`271`）与 `handleAbortTechnical` 未限定最小 `valueCoins` | **Informational** | `types.tolk`、`ClaimRecord.tolk`、`RoundController.tolk:359` | 代码可维护性与防御性编程建议 |

## 2. 详细审计发现与修复建议

### [A9-V11-01] `JunxiangDistributor.RecordPay` 与 `RoundController.handleDeposit` 未预留合约原有 TON 即混用 `SEND_MODE_REGULAR` 事件与 `MODE_64` 转发，导致合约 TON 耗尽后用户军饷 A9 永久锁定

- **严重度**：**High**
- **位置**：
  - [contracts/contracts/JunxiangDistributor.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/JunxiangDistributor.tolk) 第 60–66 行（`RecordPay` 分支）
  - [contracts/contracts/ClaimRecord.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/ClaimRecord.tolk) 第 21–31 行（`onInternalMessage`）
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/RoundController.tolk) 第 206–225 行（`handleDeposit` 与 `refundDeposit`）
  - [contracts/contracts/jetton.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/jetton.tolk) 第 53–65 行（`sendWithInboundValue` 与 `emitExternalEvent`）
- **漏洞机理与影响分析**：
  1. 在 TON TVM 中，`SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE`（`mode = 64`）会将**入站消息剩余的全部价值**（即 `in.valueCoins - compute_gas_fee`）附带到该条出站内部消息上，**不会**从入站消息价值中扣除同一交易内通过 `SEND_MODE_REGULAR`（`mode = 0`）发出的外部日志事件（`emitExternalEvent`）的 `fwd_fee`（在 TON 主网 Basechain 上每条 external-out 消息固定收取 `lump_price + bit_price` 约 `0.001 ~ 0.0012 TON`）。
  2. 因此，在未调用 `reserveToncoinsOnBalance` + `SEND_MODE_CARRY_ALL_BALANCE`（`mode = 128`）的情况下，同时调用 `emitExternalEvent`（`mode = 0`）和 `sendWithInboundValue`（`mode = 64`），会使每笔交易的外部事件转发费及合约自身的存储费（`storage_fees`）全部从合约原有的 TON 余额中扣除。
  3. 在 `JunxiangDistributor.tolk` 第 60–66 行中：
     ```tolk
     RecordPay => {
         var st = lazy DistributorStorage.load();
         assert (in.senderAddress == calcRecordAddress(contract.getAddress(), msg.owner, st.codes.load().recordCode)) throw Errors.NotTicket;
         st.totalPaidRaw += msg.amountRaw;
         st.save();
         emitExternalEvent(JunxiangClaimed { owner: msg.owner, amountRaw: msg.amountRaw, cumulativeRaw: msg.cumulativeRaw });
         sendWithInboundValue(distributorWallet(st), buildJettonTransferBody(msg.queryId, msg.amountRaw as coins, msg.owner, msg.owner));
     }
     ```
     根据 `ops/config/mainnet.params.json` 第 326 行，`JunxiangDistributor` 部署时仅附带 `1 TON`（并注明“不需要 TON 运行余额，领取由领取人附带 gas”）。然而每笔军饷领取和每次 `SetRoot` 都会净消耗 `JunxiangDistributor` 自身的 TON 余额（约 `0.0012 TON`/次）。
  4. **致命后果（跨合约状态不一致与资金永久锁定）**：当 `JunxiangDistributor` 的自有 TON 余额在约 800 次领取后（或因长期存储费消耗）降至单条 `JunxiangClaimed` 外部事件转发费（约 `0.0011 TON`）以下时：
     - **第 1 跳（`JunxiangDistributor` 收到 `ClaimJunxiang`）**：正常通过并将剩余消息价值通过 `mode = 64` 转发给 `ClaimRecord`。
     - **第 2 跳（`ClaimRecord` 收到 `RecordAdvance`）**：`ClaimRecord` 检查 `msg.cumulativeRaw > st.claimedRaw` 通过，**将 `st.claimedRaw` 更新为 `msg.cumulativeRaw` 并持久化落盘**，随后以 `BounceMode.NoBounce` 发送 `RecordPay` 给 `JunxiangDistributor`。
     - **第 3 跳（`JunxiangDistributor` 收到 `RecordPay`）**：Compute Phase 正常完成；进入 Action Phase 后，第 1 个动作 `emitExternalEvent(JunxiangClaimed)`（`mode = 0`）从合约总余额中划走 `ext_fwd_fee`，导致合约剩余总余额小于 `in.valueCoins - compute_gas_fee`；紧接着第 2 个动作 `sendWithInboundValue`（`mode = 64`）因剩余余额不足以覆盖 `in.valueCoins - compute_gas_fee` 而触发 **TVM Action Phase 错误 `exit_code = 37`（`not enough Toncoin`）**！
     - 整笔 `RecordPay` 交易在 Action Phase 回滚，Jetton 转账消息未发出；而 `RecordPay` 为 `NoBounce`（且 `ClaimRecord` 无 bounce 处理逻辑），导致用户的 `ClaimRecord.claimedRaw` 已永久更新为最新 `cumulativeRaw`，但用户未收到任何 A9 代币，且后续重试会在 `ClaimRecord` 触发 `throw 271`，**该笔军饷 A9 永久锁定在 `JunxiangDistributor` 中无法取出**。
  5. 同样的模式也存在于 `RoundController.handleDeposit`（第 206–215 行）与 `refundDeposit`（第 220–224 行），每次有效上车或即时退款都会从 `RoundController` 自有 TON 储备中消耗一条 `DepositAccepted` / `DepositRefunded` 外部事件转发费。
- **理论触发路径验证说明**：
  - 在测试环境中，当将 `JunxiangDistributor` 的初始部署 TON 设为低余额（或在多次 `RecordPay` / `SetRoot` 消耗掉初始 TON 后），发起合法的 `ClaimJunxiang`：可观察到 `ClaimRecord` 交易成功（`get_record().claimedRaw == cumulativeRaw`），紧随其后的 `RecordPay` 交易在 `JunxiangDistributor` 的 Action Phase 以 `result_code = 37` 失败，用户的 A9 余额为 `0`，再次调用 `ClaimJunxiang` 在 `ClaimRecord` 报 `exit_code = 271`。
- **修复建议**：
  1. 在 `JunxiangDistributor.tolk` 的 `RecordPay` 分支中，改用与 `RoundController.handleTicketRequest` 一致的 `reserveToncoinsOnBalance` + `SEND_MODE_CARRY_ALL_BALANCE`（`mode = 128`）模式，确保外部事件转发费从入站消息价值中扣除，绝不消耗 `JunxiangDistributor` 自有 TON：
     ```tolk
     RecordPay => {
         var st = lazy DistributorStorage.load();
         assert (in.senderAddress == calcRecordAddress(contract.getAddress(), msg.owner, st.codes.load().recordCode)) throw Errors.NotTicket;
         st.totalPaidRaw += msg.amountRaw;
         st.save();
         reserveToncoinsOnBalance(contract.getOriginalBalance() - in.valueCoins, RESERVE_MODE_AT_MOST);
         emitExternalEvent(JunxiangClaimed { owner: msg.owner, amountRaw: msg.amountRaw, cumulativeRaw: msg.cumulativeRaw });
         val out = createMessage({
             bounce: BounceMode.Only256BitsOfBody,
             value: 0,
             dest: distributorWallet(st),
             body: buildJettonTransferBody(msg.queryId, msg.amountRaw as coins, msg.owner, msg.owner),
         });
         out.send(SEND_MODE_CARRY_ALL_BALANCE);
     }
     ```
  2. 在 `RoundController.tolk` 的 `handleDeposit` 和 `refundDeposit` 中同样先调用 `reserveToncoinsOnBalance(contract.getOriginalBalance() - valueCoins, RESERVE_MODE_AT_MOST)`，先 `emitExternalEvent`，再以 `SEND_MODE_CARRY_ALL_BALANCE` 发送 `sendAddStake` 或退款转账。

### [A9-V11-02] `RoundController.handleTicketRequest` 等关键跨合约发送缺少 `SEND_MODE_BOUNCE_ON_ACTION_FAIL`（`+16`），Action Phase 失败时不产生 bounce 导致 `StakeTicket.pending` 永久死锁

- **严重度**：**Medium**
- **位置**：
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/RoundController.tolk) 第 149–157 行（`sendAddStake`）、第 420–479 行（`handleTicketRequest`、`sendTicketUpdate`、`sendClaimTransfer`）
  - [contracts/contracts/StakeTicket.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/StakeTicket.tolk) 第 69–85 行（`sendRequest`）
- **漏洞机理与影响分析**：
  1. 任务书 `docs/21_AUDIT_RFP.md` §4.2 第 5 条假设：“RC 的 `throw` 与 action phase 失败都会让 `TicketRequest` 弹回（`BounceMode.Only256BitsOfBody`）”。
  2. 在 TON TVM 中，Compute Phase 抛错（`throw`）会自动弹回 `bounce: true` 的入站消息；但若 Compute Phase 成功（`exit_code = 0`）而在 **Action Phase** 发生错误（例如 `exit_code = 37` 余额不足或 `exit_code = 40`），TVM 虽然会回滚 `RoundController` 的 `c4` 存储，但**只有当失败的动作带有 `SEND_MODE_BOUNCE_ON_ACTION_FAIL`（`+16`）或 `RESERVE_MODE_BOUNCE_ON_ACTION_FAIL`（`+16`）标志时，才会向发送方生成 bounce 消息**（对比官方模板 `JettonWallet.tolk` 第 72、130、152 行均显式附加了 `| SEND_MODE_BOUNCE_ON_ACTION_FAIL`）。
  3. 当前 `RoundController.handleTicketRequest` 中的 `reserveToncoinsOnBalance`、`sendTicketUpdate`、`sendAddStake`、`sendClaimTransfer` 均未附加 `+16` 标志。一旦因未来链上全局 gas/转发费配置上调等原因导致 `handleTicketRequest` 在 Action Phase 失败，`RoundController` 回滚且不发出 `TicketUpdate`，同时**不会向 `StakeTicket` 发送 bounce 消息**，导致 `StakeTicket.pending` 永久停留在 `true`，该攻城令下的本金与 80% 压城奖励永久锁死。
- **修复建议**：
  - 在 `RoundController.tolk` 的 `sendTicketUpdate`、`sendAddStake`、`sendClaimTransfer` 以及 `StakeTicket.tolk` 的 `sendRequest`、`ClaimRecord.tolk` 的 `out.send` 中统一加上 `| SEND_MODE_BOUNCE_ON_ACTION_FAIL`（`+16`），并在 `handleTicketRequest` 入口增加 `assert (valueCoins >= ton("0.1")) throw Errors.NotEnoughValue;` 前置检查，确保金额不足时在 Compute Phase 直接抛错弹回。

### [A9-V11-03] `ClaimRecord` 拒绝重复或旧额度请求（`throw 271`）时，因 `RecordAdvance` 为 `BounceMode.NoBounce`，用户附带的 TON 被截留在 `ClaimRecord`

- **严重度**：**Medium**
- **位置**：
  - [contracts/contracts/JunxiangDistributor.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/JunxiangDistributor.tolk) 第 52–58 行
  - [contracts/contracts/ClaimRecord.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/ClaimRecord.tolk) 第 20–21 行
- **漏洞机理与影响分析**：
  1. `ClaimRecord.tolk` 第 20 行注释写道：`// nothing new: throw so the distributor-bound value bounces back`，随后执行 `assert (msg.cumulativeRaw > st.claimedRaw) throw 271;`。
  2. 但 `JunxiangDistributor.tolk` 第 53 行发送 `RecordAdvance` 时设置了 `bounce: BounceMode.NoBounce`。因此当 `ClaimRecord` 抛出 `271` 时，附带的 `~0.19 TON` **不会弹回**，而是全部沉淀在 `ClaimRecord` 合约余额中。
  3. 尽管当该用户在未来某期获得更高 `cumulativeRaw` 并再次成功领取时，`ClaimRecord` 会通过 `reserveToncoinsOnBalance(10000000, RESERVE_MODE_AT_MOST)` + `SEND_MODE_CARRY_ALL_BALANCE` 将此前沉淀的 TON 一并带出，但如果用户在**最后一期军饷**（第 10 城结束后）误触重复领取或并发发送两笔领取交易，后续永远不会再有更高的 `cumulativeRaw`，多付的 TON 将永久滞留在 `ClaimRecord` 中无法取回。
- **修复建议**：
  - 在 `ClaimRecord.tolk` 中，当 `msg.cumulativeRaw <= st.claimedRaw` 时，不要直接 `throw 271` 丢弃 `NoBounce` 消息价值，而是保留 `0.01 TON` 存储费后将剩余 TON 通过 `ReturnExcessesBack`（`0xd53276db`）直接退回给 `st.owner`：
    ```tolk
    if (msg.cumulativeRaw <= st.claimedRaw) {
        reserveToncoinsOnBalance(10000000, RESERVE_MODE_AT_MOST);
        createMessage({
            bounce: BounceMode.NoBounce,
            value: 0,
            dest: st.owner,
            body: ReturnExcessesBack { queryId: msg.queryId },
        }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        return;
    }
    ```

### [A9-V11-04] 部署 ABI 文件 `contracts/deploy/abi/RoundController.json` 与编译产物及源码不一致，缺失 `fallbackUnlockSeconds` 字段

- **严重度**：**Medium**
- **位置**：
  - [contracts/deploy/abi/RoundController.json](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/deploy/abi/RoundController.json) 第 210–243 行（`ProtocolTiming`）、第 559–588 行（`ProtocolStateView`）
  - [contracts/build/abi/RoundController.json](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/build/abi/RoundController.json) 第 210–247 行、第 563–596 行
- **漏洞机理与影响分析**：
  1. 在 commit `709ce87` 中，`types.tolk` 的 `ProtocolTiming` 结构体新增了 `fallbackUnlockSeconds: uint32`（第 7 个字段），`ProtocolStateView` 新增了 `fallbackUnlockSeconds: uint32`（第 7 个字段）。
  2. `contracts/build/abi/RoundController.json` 已随编译更新，但 `contracts/deploy/abi/RoundController.json` 未同步更新，仍停留在旧版结构（`ProtocolTiming` 仅 8 个字段、`ProtocolStateView` 仅 6 个字段）。
  3. 任何使用 `contracts/deploy/abi/RoundController.json` 构造 `RoundController` 初始状态 cell 或解析 `get_protocol_state` 返回值的工具都会发生字段错位（`ProtocolTiming` 缺少 32 bits 会导致合约读取 `timing(s)` 时直接抛出 `CellUnderflow`）。
- **修复建议**：
  - 用 `contracts/build/abi/RoundController.json` 覆盖更新 `contracts/deploy/abi/RoundController.json`，并在构建脚本中加入 `contracts/build/abi/*.json` 与 `contracts/deploy/abi/*.json` 的一致性检查。

### [A9-V11-05] 链下运维脚本与索引器对账存在 3 处不一致缺陷（发根余额误拦截、R10 技术终止销毁漏计、`ReleaseTeam` 未纳入对账）

- **严重度**：**Medium**
- **位置**：
  1. [ops/scripts/80_admin_ops.mjs](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/ops/scripts/80_admin_ops.mjs) 第 257–262 行
  2. [worker/src/indexer/sync.ts](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/worker/src/indexer/sync.ts) 第 390–415、473–505 行
  3. [worker/src/indexer/ledger.ts](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/worker/src/indexer/ledger.ts) 第 83–95 行 & [ops/scripts/lib/ledger.mjs](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/ops/scripts/lib/ledger.mjs) 第 23–33 行
- **漏洞机理与影响分析**：
  1. **`80_admin_ops.mjs` 军饷发根余额检查公式错误**：
     第 257 行 `const shortfall = balance !== null && balance < BigInt(totalRaw);` 要求分发合约当前 A9 余额必须大于等于本期清单的**终身累计总额** `totalRaw`，而忽略了此前已被用户领走的 `totalPaidRaw`。按照 `ops/drills/2026-11_testnet_v11_10round_drill.md` §3.8 与 §6.4 的运维规程，每次注资额为 `新清单累计总额 − 已支付总额`，因此只要第 1 期有任意一人领取过军饷，第 2 期注资后分发合约的当前余额必然等于 `totalRaw - totalPaidRaw < totalRaw`，导致 `80_admin_ops.mjs` 在 `EXECUTE` 模式下报错拒绝发布新根。
  2. **第 10 城 `AbortTechnical` 销毁 `carryRaw` 未被索引器与对账台账记录**：
     当第 10 城通过 `handleAbortTechnical` 结束且 `s.carryRaw > 0` 时，`RoundController.tolk:382-391` 会将 `s.carryRaw` 整笔销毁（设置 `ex.burnRaw = s.carryRaw` 并发送 `sendBurn`），但只发出 `TechnicalAborted` 事件（不含销毁金额字段），不发出 `RoundSettled` 事件。`worker/src/indexer/sync.ts` 的 `applyBatch` 未处理 `TechnicalAborted` 的销毁，`refreshRounds` 第 473 行 `if (view.status === 8 || view.status === 9)` 也跳过了 `status === 10`（`TECHNICAL_ABORTED`），导致链上实际销毁的 7 亿～70 亿 A9 未写入 D1 `burn_ledger`，使 `reconcile` 的供应量与 RC 钱包余额核对永久失配。
  3. **`ReleaseTeam`（`roundId = 0`）与舍入尾差（dust）导致 `sync.ts:reconcile` 报错**：
     `worker/src/indexer/ledger.ts:expectedRcWalletBalance` 只扣除了 `round.team_released_raw`（第 1..10 轮结算时的团队释放），未扣除第 10 城结束 30 天后通过 `ReleaseTeam`（`TeamReleased { roundId: 0, amountRaw: 1.2e8 }`）释放的最后一笔 1.2 亿团队额度；且 `sync.ts:696` 使用精确相等 `expected !== balance`，一旦多人分奖产生哪怕 1 raw 的向下取整尾差（dust 留在 RC），`reconcile` 就会报 `rcWalletBalance` 不一致。
- **修复建议**：
  1. 在 `ops/scripts/80_admin_ops.mjs` 中读取 `get_distributor` 的 `totalPaidRaw`，将校验条件修正为 `balance + totalPaidRaw < BigInt(totalRaw)`。
  2. 在 `worker/src/indexer/sync.ts` 的 `refreshRounds` 中，当 `roundId === 10 && view.status === 10` 时记录并确认第 10 城的 `carryRaw` 销毁；在 `applyBatch` 处理 `EVENT_OP.teamReleased`（`roundId === 0`）时写入 metric `chain:team_release:R0` 并在 `expectedRcWalletBalance` 中扣除；将 `sync.ts:696` 的 RC 余额对账放宽为允许非负舍入尾差（`0n <= balance - expected && balance - expected <= BigInt(stakes.length * 2)`）。

### [A9-V11-06] `OpenRound` 与 `SubmitCandle` 未向 `keeper` 退还多余 TON，与 `mainnet.params.json` 的 `keeperMinTon = 2 TON` 配置假设冲突

- **严重度**：**Low**
- **位置**：
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/RoundController.tolk) 第 231–321 行（`handleOpenRound`、`handleSubmitCandle`）
  - [contracts/scripts/deploy/actions.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/scripts/deploy/actions.tolk) 第 169–176、214–236 行
  - [ops/config/mainnet.params.json](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/ops/config/mainnet.params.json) 第 325–327 行
- **漏洞机理与影响分析**：
  - `ops/config/mainnet.params.json` 第 325–327 行配置 `"keeperMinTon": 2`，并注释 `"keeper：每轮 OpenRound + 24 根 SubmitCandle，单笔 0.3 TON 上限（多余退回）"`。
  - 实际上 `RoundController.tolk` 的 `handleOpenRound` 和 `handleSubmitCandle` **没有任何退回多余 TON 的逻辑**，附带的 `0.3 TON` 全部留在 `RoundController` 中。每轮 1 次 `OpenRound` + 24 次 `SubmitCandle` 将消耗 `keeper` 钱包 `25 × 0.3 = 7.5 TON`（10 轮共 `75 TON`）。若运维按 `keeperMinTon = 2 TON` 为 `keeper` 充值，第 1 轮提交到第 6 根 K 线时 `keeper` 就会因 TON 耗尽而停摆。
- **修复建议**：
  - 在 `mainnet.params.json` 中将 `keeperMinTon` 提高至 `>= 10 TON`（10 轮全量预算建议 `80 TON`，或将 `actions.tolk` 中 `buildOpenRound` 和非第 24 根 `buildSubmitCandle` 的附带 TON 从 `0.3 TON` 降至 `0.05 TON`），或在合约中通过 `reserveToncoinsOnBalance` + `ReturnExcessesBack` 退还 `keeper` 多余 gas。

### [A9-V11-07] `junxiang.tolk:merkleRootOf` 证明编码延展性及 `junxiang_claim.tolk` 深度限制

- **严重度**：**Low**
- **位置**：
  - [contracts/contracts/junxiang.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/junxiang.tolk) 第 48–62 行
  - [contracts/scripts/deploy/junxiang_claim.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/scripts/deploy/junxiang_claim.tolk) 第 20–45 行
- **漏洞机理与影响分析**：
  1. `merkleRootOf` 使用 `while (cs.remainingBitsCount() >= 256)` 读取每个 cell 中的 256-bit 兄弟哈希，若 cell 末尾附带 `1..255` 个额外比特，或挂载了 `ref 1..3`，合约会静默忽略。虽然由于 SHA-256 抗原像性，这不会改变有效路径哈希或伪造根，但存在交易载荷延展性（malleability）。
  2. 此外，`contracts/scripts/deploy/junxiang_claim.tolk` 脚本仅接受 3 个位置参数 `h1, h2, h3` 并写入单个 cell，只能支持证明长度 `≤ 3`（即总人数 `≤ 8`）的默克尔树；而前端 `web/src/features/chain/junxiang.ts` 的 `buildProofCell` 正确实现了每 cell 3 个哈希、通过 `ref 0` 链式挂载的多层编码。
- **修复建议**：
  - 在 `merkleRootOf` 内层循环结束后增加 `assert (cs.remainingBitsCount() == 0 && cs.remainingRefsCount() <= 1) throw 260;`；更新 `junxiang_claim.tolk` 以支持逗号分隔的任意长度证明哈希数组并按 3 个一组构造链式 cell。

### [A9-V11-08] `RoundController.handleDeposit` 对 `beneficiary` 地址未预检 `anycast == 0`

- **严重度**：**Low**
- **位置**：[contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/RoundController.tolk) 第 179–182 行
- **漏洞机理与影响分析**：
  - `else if (head == 2 && payload.remainingBitsCount() == 267) { owner = payload.loadAddress(); ok = true; }` 仅检查了 `addr_std` 的 2-bit 前缀 `10` 和剩余总长度 `267` bits，未检查第 3 个 bit（`anycast` 标志位）是否为 `0`。
  - 若入站 payload 的前 3 bits 为 `101`（即 `addr_std` 且 `anycast = Just`）且总剩余长度为 267 bits，TVM 的 `LDMSGADDR` 指令会尝试额外读取 `anycast` 的 `depth` 与 `rewrite_pfx`，从而直接抛出 TVM `CellUnderflow`（`exit_code = 9`），导致 `handleDeposit` 异常终止而无法进入 `refundDeposit` 退款分支（由于 `TransferNotification` 为 `NoBounce`，该笔 Jetton 会直接留在 RC 钱包中）。
- **修复建议**：
  - 将条件改为检查前 3 bits：`else if (payload.preloadUint(3) == 4 && payload.remainingBitsCount() == 267)`（即二进制 `100`，确保 `addr_std` 且 `anycast == 0`）。

### [A9-V11-09] 时间参数下界校验、错误码枚举统一与 `handleAbortTechnical` 最小 gas 检查

- **严重度**：**Informational**
- **位置**：
  - [contracts/contracts/ClaimRecord.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/ClaimRecord.tolk) 第 19、21 行 & [contracts/contracts/junxiang.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/junxiang.tolk) 第 59 行
  - [contracts/contracts/RoundController.tolk](file:///Users/yu1/Desktop/BAM/.claude/worktrees/a9-gameplay-design-7b065a/contracts/contracts/RoundController.tolk) 第 111–118、359 行
- **分析与建议**：
  1. `junxiang.tolk`（`throw 260`）与 `ClaimRecord.tolk`（`throw 270`、`throw 271`）使用了硬编码魔法数字，建议并入 `constants.tolk` 的 `Errors` 枚举以便前端和索引器统一解码。
  2. `handleAbortTechnical` 未检查 `in.valueCoins`，在第 10 城触发 `sendBurn` 时消耗 RC 自有余额 `0.1 TON`；建议增加 `assert (in.valueCoins >= MIN_CLAIM_VALUE) throw Errors.NotEnoughValue;`。
  3. `constants.tolk` 已清理干净，无残留 v10 `OP_CLAIM` / `OP_CLAIM_ALL` 死代码（RFP §4.10 第 33 条所提旧常量在 `v11-audit-freeze` 中已移除）。

## 3. 标准模板逐字 Diff 与鏈下一致性核对

### 3.1 标准模板核对（B 项）

1. **JettonWallet (`0xD06DAA57ED188CE9CB6CA596DD2111347433BF335223AC66C0D713C8E3DB74F4`)**：
   - 与 Acton 1.1.0 官方 TEP-74 / TEP-89 模板逐行比对完全一致，无任何自定义后门或非标修改。
   - `InternalTransferStep` 严格校验 `in.senderAddress == storage.minterAddress` 或 `in.senderAddress == calcAddressOfJettonWallet(initiator!, storage.minterAddress, contract.getCode())`（第 42–55 行），不可伪造入账。
   - `onBouncedMessage` 在 `InternalTransferStep` 或 `BurnNotificationForMinter` 弹回时准确恢复 `storage.jettonBalance += restoreAmount`（第 24–36 行）。
2. **JettonMaster (`0x76B56D9A6301223F1201D719E2F4A3FB84E08D7D701CB93BB43C9D0208E5E241`)**：
   - 基于 Acton 官方模板定制 `MintOnce`（`op = 0x00000015`）。
   - 在 `MintOnce`（第 61–96 行）中，严格校验 `storage.adminAddress != null`、`in.senderAddress == storage.adminAddress!`、`storage.totalSupply == 0`、`msg.jettonAmount == TOTAL_SUPPLY_RAW`（`10,000,000,000 * 10^9 = 10^19`）、`msg.tonAmount >= ton("0.1")` 及 `in.valueCoins >= msg.tonAmount + ton("0.05")`，并在**同一笔交易内**将 `storage.adminAddress = null` 与 `storage.nextAdminAddress = null` 落盘，同时附加 `SEND_MODE_BOUNCE_ON_ACTION_FAIL`。
   - 铸造完成后，`adminAddress` 与 `nextAdminAddress` 均为 `null`，`MintOnce`、`ChangeMinterAdmin`、`ClaimMinterAdmin`、`DropMinterAdmin`、`ChangeMinterMetadata` 全部永久不可再调用，总量 `100 亿 A9` 只减不增（仅通过验证了发送方钱包地址的 `BurnNotificationForMinter` 扣减）。

### 3.2 链下一致性核对（C 项）

1. **军饷默克尔树编码一致性（`worker/src/social/merkle.ts`、`payout.ts`、`web/src/features/chain/junxiang.ts` vs `contracts/contracts/junxiang.tolk`）**：
   - **叶子原像（49 字节）**：`merkle.ts:leafPreimage` 构造 `1 字节 int8 workchain（二进制补码） + 32 字节大端 wallet_hash + 16 字节大端 uint128 cumulative_amount` 并做 SHA-256；合约 `junxiang.tolk:junxiangLeaf` 使用 `beginCell().storeInt(wc, 8).storeUint(hash, 256).storeUint(cumulative, 128).toSlice().bitsHash()`（TVM `HASHSU` 对齐字节流 SHA-256），**逐字节完全一致**。
   - **父节点排序哈希（64 字节）**：`merkle.ts:pairHash` 按无符号字节序（等价于 256-bit 大端无符号整数比较）取 `min(a, b) ‖ max(a, b)` 做 SHA-256；合约 `junxiang.tolk:hashPair` 按 `uint256` 比较 `a < b` 后 `storeUint(lo, 256).storeUint(hi, 256).toSlice().bitsHash()`，**完全一致**。
   - **奇数节点直接上提与证明打包**：`merkle.ts:buildMerkleTree` 与 `merkleProof` 在某层节点数为奇数且当前位置为末尾节点时不生成兄弟哈希，直接原样晋级到上一层；前端 `web/src/features/chain/junxiang.ts:buildProofCell` 将兄弟哈希数组按自底向上顺序每 3 个 `uint256`（768 bits）打包进一个 cell，后续组通过 `ref 0` 链式挂载，与 `junxiang.tolk:merkleRootOf` 解析逻辑**完全一致**（注：CLI 脚本 `junxiang_claim.tolk` 仅支持单 cell 3 个哈希，见 **A9-V11-07**）。
2. **链下事件与 ABI 解析一致性**：
   - `worker/src/indexer/events.ts`、`messages.ts`、`getters.ts` 及 `web/src/features/chain/payload.ts`、`decode.ts` 的操作码、事件位布局与 getter 栈槽位顺序与 `RoundController.tolk`、`StakeTicket.tolk` 一致。
   - 发现 `contracts/deploy/abi/RoundController.json` 落后于 `contracts/build/abi/RoundController.json`（见 **A9-V11-04**），以及索引器对第 10 城 `AbortTechnical` 销毁和 `ReleaseTeam` 的对账漏项（见 **A9-V11-05**）。

## 4. RFP §4 重点攻击面逐条结论表（共 34 条 + 4 项附加验证）

| 条目 | 攻击面与验证点 | 审计结论 | 详细依据（文件:行号与分析） |
| --- | --- | --- | --- |
| **1** | 攻城令地址推导（`calcTicketAddress`） | **无问题** | `ticket.tolk:27-43`、`RoundController.tolk:525-528`。`stateInit` 固定由 `(ticketCode, rc, owner, roundId, 0, 0, false, 0, false)` 构成，TON 账户地址等于 `sha256(stateInit)`，在抗碰撞假设下不存在不同 code 或不同初始 data 映射到同一地址的可能；`roundId` 为 `uint8`，在 `1..10` 范围内 `get_ticket_address` 与链上实际部署地址完全一致。 |
| **2** | `TicketRequest` 伪造与攻城令权限校验 | **无问题** | `RoundController.tolk:389` 强制校验 `sender == calcTicketAddress(contract.getAddress(), msg.owner, msg.roundId, ticketCode)`；`StakeTicket.tolk:38, 46` 在 `TicketAddStake` 与 `TicketUpdate` 中强制校验 `in.senderAddress == st.rc`；`StakeTicket.tolk:65` 在 `sendRequest` 中强制校验 `sender == st.owner`。外部攻击者既无法直接向 RC 伪造 `TicketRequest`，也无法篡改真实攻城令的存储。 |
| **3** | 受益人入账（`beneficiary`）校验 | **发现低危问题（见 A9-V11-08）** | `RoundController.tolk:169-197`。`head == 0`（`addr_none`）正确回落至 `initiator`；`owner.getWorkchain() == BASECHAIN` 阻止了 masterchain 受益人；若受益人为无法发 `TicketClaim` 的合约则仅锁定该受益人自身仓位（设计预期）。但第 179 行 `head == 2 && payload.remainingBitsCount() == 267` 未检查第 3 bit `anycast == 0`，若构造 `anycast = 1` 的 267-bit 载荷会触发 `CellUnderflow (exit 9)` 而无法走退款分支（见 **A9-V11-08**）。 |
| **4** | `pending` 卡死风险与 `TicketUpdate` 存储保留 | **无问题（在正常动作下）** | `StakeTicket.tolk:21-31, 44-52, 88-99`、`constants.tolk:71, 73`。`VALUE_TICKET_MSG = 0.02 TON`，`TicketUpdate` 计算消耗约 `0.002 TON`；`returnExcess` 通过 `reserveToncoinsOnBalance(TICKET_MIN_BALANCE = 0.02 TON, RESERVE_MODE_AT_MOST)` 保留存储费，并将超出部分以 `SEND_MODE_CARRY_ALL_BALANCE \| SEND_MODE_IGNORE_ERRORS` 退回 `owner`，不会因余量不足导致 `TicketUpdate` 失败。 |
| **5** | bounce 与 Action Phase 失败的一致性 | **确认有问题（见 A9-V11-02）** | `RoundController.tolk:420-479`。TVM 中 Compute Phase `throw` 会自动弹回 `TicketRequest`，但若 Action Phase 失败（如 `exit 37`），因 `sendTicketUpdate` / `sendAddStake` / `sendClaimTransfer` 未设置 `SEND_MODE_BOUNCE_ON_ACTION_FAIL`（`+16`），TVM 回滚 `RC` 状态但**不会**向 `StakeTicket` 发送 bounce，导致 `StakeTicket.pending` 永久卡死（见 **A9-V11-02**）。 |
| **6** | Claim 转账的 bounce 未处理与 RC 余额不变量 | **无问题** | `RoundController.tolk:60-90, 472-479`、`jetton.tolk:5-22`。`buildJettonTransferBody` 设置 `forward_ton_amount = 0`，因此接收方 `JettonWallet` 不会再发下一跳通知（第 2 跳不可能因 TON 不足失败）；第 1 跳 `RC -> RC JettonWallet` 只要 `RC JettonWallet` 余额充足且附带 TON `>= ~0.04 TON`（实际附带 `~0.115 TON`）即不会 bounce。经数学归纳验证（见第 12 条），RC 钱包余额在所有路径下均 `>=` 所有应付未付本金、奖励、销毁与团队额度之和。 |
| **7** | bounce 体 256-bit 截断解析 | **无问题** | `RoundController.tolk:60-90`、`StakeTicket.tolk:21-31`。`Only256BitsOfBody` 在跳过 32-bit `0xffffffff` 前缀后保留原消息体前 256 bits：`StakeTicket` 仅需前 32 bits（`op`）；`RoundController` 的结算转账/销毁需 `op(32) + queryId(64) = 96 bits`，最终团队释放分支额外读取 `amount: coins`（`4 + 128 = 132 bits`，共 `96 + 132 <= 228 bits <= 256 bits`），均在 256 bits 截断范围内，不会被截断。 |
| **8** | `reserveToncoinsOnBalance(getOriginalBalance() - valueCoins, AT_MOST)` | **无问题** | `RoundController.tolk:420`。TVM 的 `BALANCE`（`getOriginalBalance()`）已包含本笔入站消息的 `valueCoins`（且已扣除 Storage Phase 的存储费）。在 Action Phase 执行该预留后，可用未预留余额严格等于 `valueCoins - compute_gas_fee`，因此 `handleTicketRequest` 中的所有后续动作和 `CARRY_ALL_BALANCE` 均只消耗本次请求附带的 TON，绝不会抽干 `RC` 原有的 TON 储备（含 `TopUpTons` 或未退回的 TON）。 |
| **9** | 续战（restake）发送模式组合与事件顺序 | **无问题（建议加 +16，见 A9-V11-02）** | `RoundController.tolk:423-454`。`TicketRestake` 要求 `>= 0.25 TON`；在 `reward > 0` 分支中，依次发出 3 个事件、`sendTicketUpdate`（`0.02 TON` + 转发费）、`sendAddStake`（`0.05 TON` + 转发费），最后 `sendClaimTransfer` 以 `CARRY_ALL_BALANCE` 携带剩余约 `0.16 TON` 去执行 Jetton 转账；在 `reward == 0` 分支中，`sendTicketUpdate`（`0.02 TON`）后由 `sendAddStake` 以 `CARRY_ALL_BALANCE` 携带剩余约 `0.21 TON`。两个分支的 TON 均充裕；同交易内先发 `Restaked` 后发 `DepositAccepted`，索引器 `sync.ts:363` 通过 `txEvents.some(e => e.opcode === EVENT_OP.restaked)` 按整笔交易识别 `source = 'restake'`，不受两事件先后顺序影响。 |
| **10** | 奖励舍入（向下取整）与尾差（dust） | **无问题** | `RoundController.tolk:117-123`。`reward = rd.rewardBudgetRaw * weight / rd.totalWeightRaw` 向下取整，由于 $\sum \lfloor B \cdot w_i / W \rfloor \le B \cdot (\sum w_i) / W = B$，所有攻城令可领奖励之和恒 $\le$ `rewardBudgetRaw`。`immediate = floor(reward * 2000 / 10000)`，`locked = reward - immediate`，故 `immediate + locked == reward` 恒成立。舍入尾差留在 RC 钱包中，不进入 `carryRaw` 或任何轮次预算，不会破坏守恒或被重复计入。 |
| **11** | 权重与时机系数三等分边界 | **无问题** | `RoundController.tolk:108-115, 201, 428`。`third = stakeDurationSeconds / 3`（生产档 `129600 / 3 = 43200s = 12h` 整除；若配置值不能被 3 整除，第 3 段比前两段长 1~2 秒）。`elapsed < third` 取 `15000`（1.5x），`elapsed < third * 2` 取 `12000`（1.2x），其余取 `10000`（1.0x）。直接上车与一键续战均使用当前区块时间 `now64()` 与目标轮的 ` timingBps` 计算，口径完全一致。 |
| **12** | 10 轮全路径代币守恒不变量 | **无问题** | `RoundController.tolk:231-342, 359-401`。初始注资 $82\text{e}8 = 10 \times 7\text{e}8 + 10 \times 1.2\text{e}8$。每城 `OpenRound` 时 `rewardBudgetRaw = 7e8 + carryRaw` 并将 `carryRaw` 置 0；结算或终止时，该 `rewardBudgetRaw` 互斥地进入：① 有人破城玩家奖励池、② 0 人破城或观察超时全额回流 `carryRaw`、③ 失败轮半额销毁 + 半额回流 `carryRaw`；未开城集结超时则直接将当轮未动用的 `7e8` 并入 `carryRaw`。第 10 城结束（无论破城、失败或两种技术终止）均将剩余 `carryRaw` 全额销毁并清零，不存在任何重复计入或透支路径。 |
| **13** | 失败轮本金销毁一次性与续战隔离 | **无问题** | `RoundController.tolk:296, 397-431`。失败轮 `principalBurn = rd.totalStakeRaw` 在第 24 根 K 线提交判定失败时一次性计算并销毁；失败轮状态为 `STATUS_FAILED_PERMANENT`，在 `handleTicketRequest` 中 `principal` 为 0，无法从中续战或领取。只有 `SUCCEEDED` 或 `TECHNICAL_ABORTED` 轮次的未领本金才能通过 `Restake` 转入当前开放轮 `cur` 的 `cr.totalStakeRaw`，且原轮攻城令的 `principalDone` 置为 `true`，若 `cur` 随后失败，该本金仅在 `cur` 销毁一次。 |
| **14** | 80% 压城解锁链与第 10 城 30 天线性回退 | **无问题** | `RoundController.tolk:125-138, 285, 298`。任何后续轮次 `r' > r` 破城（含 0 人破城）均更新 `s.lastSuccessRound = r'`，使 `s.lastSuccessRound > r` 成立并 100% 解锁第 `r` 城的 `locked`；第 10 城自身破城时 `lastSuccessRound = 10` 不满足 `> 10`，故第 10 城自身的 80% 压城奖励（以及最后一次破城之后再无破城的轮次）统一在 `s.endAt` 设置后按 `locked * elapsed / window` 在 30 天内单调线性解锁，`elapsed >= window` 时封顶返回 `locked`。 |
| **15** | 线性解锁多次领取的单调性与防重放 | **无问题** | `RoundController.tolk:404-408`、`StakeTicket.tolk:44-52, 66`。每次领取仅支付 `unlocked - lockedClaimed`（当 `unlocked > lockedClaimed` 时），并通过 `TicketUpdate` 将 `lockedClaimed = unlocked` 写回攻城令；在途请求受 `st.pending` 互斥锁保护，且 `sendClaimTransfer` 不会发生第 2 跳 bounce，不存在重复领取。 |
| **16** | 0 人破城的副作用与可利用性 | **无问题（符合 D-46）** | `RoundController.tolk:282-290`。`totalStakeRaw == 0` 破城时：`successCount++`、`lastSuccessRound = roundId`、释放上一次破城的 `teamPendingRaw`、挂起本轮 `1.2e8` 团队额度、并将 `budget` 全额滚入 `carryRaw`。由于 K 线仅能由 `keeper` 提交，外部用户无法在 0 人城伪造破城；且任何人随时可在攻城期上车 `>= 1,000 A9` 分走奖池，故该机制与 `docs/35` D-46 完全一致。 |
| **17** | `teamPendingRaw` 覆盖写与 bounce 重试 | **无问题** | `RoundController.tolk:71-85, 286-287, 304-308, 325-342`。破城结算时先读取 `teamReleased = s.teamPendingRaw` 写入 `ex.teamTransferRaw` 并发送 `sendTeamTransfer(wallet, roundId, teamReleased, ...)`，再将 `s.teamPendingRaw = e.teamRoundRaw` 设为本城新挂起额度。若第 `roundId` 轮的团队转账 bounce，`onBouncedMessage` 将 `rd.retryMask \|= ACTION_TEAM_TRANSFER` 置位，`RetrySettlement(roundId)` 从 `ex.teamTransferRaw` 读取确切金额重发，不会与新的 `s.teamPendingRaw` 混淆或覆盖丢失。 |
| **18** | 第 10 城结束 30 天后的 `ReleaseTeam` 最终释放 | **无问题** | `RoundController.tolk:72-76, 345-354`。`handleReleaseTeam` 校验 `s.endAt != 0 && now64() >= s.endAt + fallbackUnlockSeconds` 且 `s.teamPendingRaw > 0`，先将 `s.teamPendingRaw = 0` 清零落盘再发送 `sendTeamTransfer(..., roundId = 0, amount, ...)`；若该转账 bounce，`onBouncedMessage` 在 `roundId == 0 && action == ACTION_TEAM_TRANSFER` 分支从 bounce 体读回 `amount` 恢复 `s.teamPendingRaw += amount`，既防双花又支持 bounce 恢复。 |
| **19** | 技术终止（`AbortTechnical`）对 `teamPendingRaw` 的保护 | **无问题** | `RoundController.tolk:359-401`。`handleAbortTechnical` 完全不修改 `s.teamPendingRaw`；即使第 10 城通过技术终止结束，也只销毁 `s.carryRaw` 并设置 `s.endAt = now`，此前破城轮挂起的 `s.teamPendingRaw` 仍保留并在 `endAt + 30d` 后由 `ReleaseTeam` 正常释放。 |
| **20** | 续战（restake）本金不出合约与账本一致性 | **无问题** | `RoundController.tolk:399-433`。续战时 `principal = msg.amountRaw` 直接加到当前轮 `cr.totalStakeRaw += principal`，不触发本金的 Jetton 转出；原轮攻城令通过 `sendTicketUpdate` 将 `principalDone = true` 落盘，阻止原轮再次提取或续战本金；原轮奖励只由原轮 `rd.rewardBudgetRaw * msg.weightRaw / rd.totalWeightRaw` 决定，账实完全一致。 |
| **21** | 续战奖励不复利与时机系数重算 | **无问题** | `RoundController.tolk:428-451`。续战仅将 `principal`（`msg.amountRaw`）转入当前城，并按当前城此刻的 `timingBps(cr, timing(s), now)` 重新计算战力 `weight`；原轮已解锁的 `reward`（含 20% 立即部分）通过 `sendClaimTransfer` 直接付给用户钱包，不会混入新城的质押本金。 |
| **22** | 续战前置条件与 `currentRoundId == 0` 边界 | **无问题** | `RoundController.tolk:423-427`。当 `currentRoundId == 0` 时，没有任何轮次处于 `SUCCEEDED` 或 `TECHNICAL_ABORTED`，故 `principal == 0`，在第 424 行 `assert (principal > 0) throw Errors.NothingToClaim` 即提前抛错，不会执行到 `s.rounds.get(0).loadValue()`；在 `PREVIEW` 或 `OBSERVING` 期发起续战会因 `!inStakingWindow(cr, now)` 抛 `Errors.RestakeNotOpen` 并弹回攻城令清除 `pending`。 |
| **23** | 充值 `payload v2` 解析与 `riskDisclosureVersion` | **发现低危问题（见 A9-V11-08）** | `RoundController.tolk:169-186`、`jetton.tolk:25-39`。`unwrapForwardPayload` 正确解析 `Either Cell ^Cell`；`payload.remainingRefsCount() == 0` 与末尾 `payload.remainingBitsCount() == 0` 严格拦截了携带额外 bit 或额外 ref 的载荷；`riskVersion == timing(s).riskDisclosureVersion` 与配置一致（均为 1）。唯独 `head == 2` 分支未预检 `anycast == 0`（见 **A9-V11-08**）。 |
| **24** | 无效充值保留（TON < 0.1）与守恒关系 | **无问题（属 §5 已接受风险 #4）** | `RoundController.tolk:200-203, 219-225`。无效充值且 `valueCoins < 0.1 TON` 时不退款，代币留在 RC 的 Jetton 钱包中，不计入 `totalStakeRaw` 或 `carryRaw`，因此只会导致 RC 实际余额严格大于应付款项（正偏差），不会破坏任何轮次的预算或导致其他用户受损。 |
| **25** | `amount == 0` 与非 RC 钱包通知校验 | **无问题** | `RoundController.tolk:164-170`。入口第 1 行即校验 `assert (sender == wallet) throw Errors.NotJettonWallet;`，其中 `wallet = ownWallet(s)` 由链上 `calcAddressOfJettonWallet` 推导，任何外部伪造的 `transfer_notification` 均被拒绝；`amount == 0` 直接 `return` 不发任何事件也不改状态。 |
| **26** | 军饷默克尔叶子、父节点、域分离与证明编码 | **发现低危问题（见 A9-V11-07）** | `junxiang.tolk:38-62`、`worker/src/social/merkle.ts`。叶子原像为 49 字节（`int8 wc ‖ uint256 hash ‖ uint128 cumulative`），内部节点原像为 64 字节（`uint256 lo ‖ uint256 hi`），因 SHA-256 填充含原像位长，49 字节与 64 字节严格域分离，不存在第二原像攻击；单叶树（`proof == null`）直接返回 `leaf == st.root`；`levels <= 32` 在每次外层循环末尾均执行检查（每 cell 最多 3 层，无法绕过）。建议补充 cell 尾部剩余 `0 bit` 与 `<= 1 ref` 断言（见 **A9-V11-07**）。 |
| **27** | `ClaimRecord` 单调性与 `NoBounce` 滞留 TON | **确认有问题（见 A9-V11-01、A9-V11-03）** | `ClaimRecord.tolk:16-32`、`JunxiangDistributor.tolk:52-66`。（1）`ClaimRecord` 按每个钱包独立合约串行处理 `RecordAdvance`，严格保证 `claimedRaw` 单调递增，重放或乱序证明均不会重复付款；（2）但 `throw 271` 时因 `RecordAdvance` 为 `NoBounce`，用户附带的 `~0.19 TON` 会滞留在 `ClaimRecord` 中（见 **A9-V11-03**）；（3）更严重的是 `JunxiangDistributor.RecordPay` 混用 `emitExternalEvent`（`mode 0`）与 `sendWithInboundValue`（`mode 64`），当分发合约自有 1 TON 耗尽后会导致 `ClaimRecord` 已推进 `claimedRaw` 而 `RecordPay` 报 `exit 37` 失败，永久锁定用户军饷（见 **A9-V11-01**）。 |
| **28** | 分发合约充值不足时的 bounce 行为与隔离性 | **无问题（属 §5 已接受风险 #5）** | `JunxiangDistributor.tolk:60-66`。当分发合约 A9 余额不足时，某用户触发的 `RecordPay` 向 `distributorWallet` 发送的 `AskToTransfer` 会因 `BalanceError (47)` 弹回，仅影响该笔不足额的领取本身，不会阻塞其他小额可足额支付的钱包，也不会回滚或污染其他用户的 `ClaimRecord`（但需修复 `80_admin_ops.mjs` 的余额检查公式，见 **A9-V11-05**）。 |
| **29** | 军饷根发布（`SetRoot`）竞态与累计额下调行为 | **无问题** | `JunxiangDistributor.tolk:38-44, 45-59`。`SetRoot` 要求 `msg.listId > st.listId`；`ClaimJunxiang` 在入口处即校验 `merkleRootOf(leaf, msg.proof) == st.root`，一旦进入 `RecordAdvance` 则只携带 `cumulativeRaw`；若 publisher 在新根中将某钱包的 `cumulativeRaw` 设为低于其已领额 `claimedRaw`，`ClaimRecord` 触发 `cumulativeRaw > st.claimedRaw` 失败，不付款且不回退已领额。 |
| **30** | 单 `keeper` 权限边界与 K 线顺序/时间绑定 | **无问题** | `RoundController.tolk:99-101, 232, 275`。`handleOpenRound` 与 `handleSubmitCandle` 入口均调用 `requireKeeper(s, sender)`；`SubmitCandle` 严格校验 `msg.candleIndex == rd.candlesSeen`、`expectedStart = rd.stakeCloseAt + candleIndex * candleSeconds`、`expectedEnd = expectedStart + candleSeconds`、`now >= expectedEnd` 以及 `msg.twapPriceUsdE8 > 0`。`CloseStaking` 与第 0 根 `SubmitCandle` 的隐式关窗均要求 `now >= rd.stakeCloseAt`，且 K 线起止时间锚定在固定的 `rd.stakeCloseAt` 上，不受 `CloseStaking` 实际调用时间早晚影响，无时序攻击窗口。 |
| **31** | 单 `publisher` 权限边界与不可变性 | **无问题** | `JunxiangDistributor.tolk:38-44`。`publisher` 仅能调用 `SetRoot`（且 `listId` 严格递增），无任何修改 `publisher`、`jettonMaster`、`codes` 或提走资金的入口。 |
| **32** | 无 admin、无升级、无提现全面核查 | **无问题** | 核查 `RoundController`、`StakeTicket`、`JunxiangDistributor`、`ClaimRecord` 四个合约的全部 `onInternalMessage` 分派：不存在任何 `setCode`、`setData`（外部覆盖）、修改配置或任意提取合约 Jetton/TON 的后门分支；`TopUpTons` 与 `ReturnExcessesBack` 均为空操作；`StakeTicket.returnExcess` 严格预留 `TICKET_MIN_BALANCE` 后仅将多余 TON 发给 `st.owner`。 |
| **33** | 死代码核查（旧 `OP_CLAIM` / `OP_CLAIM_ALL`） | **无问题** | `constants.tolk`、`RoundController.tolk`、`StakeTicket.tolk`。在 `v11-audit-freeze` 中，`OP_CLAIM`（`0x52540006`）与 `OP_CLAIM_ALL`（`0x5254000E`）已从 `constants.tolk` 及消息分派中彻底移除，发送这两个操作码会直接落入 `else => throw Errors.UnknownMessage (106)`。 |
| **34** | 部署时时间参数（`ProtocolTiming`）与主网配置隔离 | **无问题（附配置审计结论）** | 见下表 §4.1 主网参数最终核对与错误配置后果分析。`ops/scripts/lib/config.mjs` 与 `deploy-emulation.tolk:211-214` 均已实现网络保险丝（`fastTiming` 在非 `A9_ALLOW_FAST_TIMING=1` 时拒绝广播，且 `15_deploy_contracts.mjs:46` 在 `mainnet` 下强制 `delete process.env.A9_ALLOW_FAST_TIMING`）。 |

### 4.1 附加必验场景与主网时间参数边界核对

1. **四项附加必验场景核对**：
   - **失败轮**：`RoundController.tolk:291-297, 309-313` 中，`half = budget / 2`，`rewardBurn = half`，`s.carryRaw += budget - half`，`teamBurn = e.teamRoundRaw (1.2e8)`，`principalBurn = rd.totalStakeRaw`，三项合并为一笔 `burnTotal = rewardBurn + teamBurn + principalBurn` 发送给 `RC` 的 `JettonWallet` 执行真实销毁（`total_supply` 减少），且 `round.test.tolk:195-213` 已实测通过。
   - **0 人上车但破城**：`RoundController.tolk:282-290` 中，`s.carryRaw += budget`（100% 奖池滚存）、`s.successCount += 1`（升档）、`s.lastSuccessRound = roundId`（解锁前序轮次 80% 压城奖励）、释放上一次破城挂起的团队额度并挂起本轮 `1.2e8` 团队额度，`round.test.tolk:215-227` 已实测通过。
   - **技术终止**：`RoundController.tolk:359-401, 409-414` 中，观察超时将 `rd.rewardBudgetRaw` 全额滚入 `s.carryRaw` 且玩家可经攻城令 100% 领回本金；集结超时跳过未开轮并将该轮 `7e8` 滚入 `s.carryRaw`；两者均不增加 `successCount`（档位不变），`round.test.tolk:237-273` 已实测通过。
   - **10 轮全流程代币守恒**：`round.test.tolk:359-390` 及两轮测试网 10 城演练（`ops/drills/2026-11_testnet_v11_10round_drill.md` 附录 R、R2）均验证 10 轮后奖励、滚存、销毁、团队额度与本金完全守恒，全部领完并释放团队额度后 RC 余额精确归零。
2. **主网参数文件（`ops/config/mainnet.params.json`）最终值与边界错误后果表（RFP §4.11 第 34 条）**：

| 参数字段 | 主网最终配置值 | 合约类型 | 若配置错误（如 0 或越界）在链上的后果 |
| --- | --- | --- | --- |
| `previewSeconds` | `43200`（12 小时） | `uint32` | 若为 `0`：结算后立即满足 `now >= stakeOpenAt`，失去 12h 集结期（`deploy-emulation.tolk:179` 已拦截 `<= 0`） |
| `stakeDurationSeconds` | `129600`（36 小时） | `uint32` | 若 `< 3`：`timingBps` 中 `third = stakeDurationSeconds / 3 == 0`，导致前两档条件 `elapsed < 0` 永假，所有人系数固定为 `1.0x`；若为 `0` 则开城即关窗 |
| `candleSeconds` | `3600`（1 小时） | `uint32` | 若为 `0`：24 根 K 线周期长度全为 0，开窗结束瞬间即可一次性提交全部 24 根 K 线（`deploy-emulation.tolk:179` 已拦截 `<= 0`） |
| `candleCount` | `24`（24 根） | `uint8` | 若为 `0`：`SubmitCandle` 的 `assert (msg.candleIndex < t.candleCount)` 恒失败（`CandleIndexOutOfRange`），所有轮次永久无法判定，只能等 `AbortTechnical` |
| `minQualifiedCandles` | `16`（16 根） | `uint8` | 若 `> candleCount`：`rd.qualifiedCandles >= t.minQualifiedCandles` 永假，所有轮次 100% 判定失败销毁本金（`deploy-emulation.tolk:195` 已拦截） |
| `abortTimeoutSeconds` | `604800`（7 天） | `uint32` | 若为 `0`：守城期刚满 24h 的同一秒任何人即可抢先调用 `AbortTechnical` 将本轮强制技术终止，与 keeper 的第 24 根 K 线产生恶意竞态 |
| `fallbackUnlockSeconds` | `2592000`（30 天） | `uint32` | 在 `mainnet.params.json` 中由 `15_deploy_contracts.mjs:36` 取默认值 `2592000`（建议在 `mainnet.params.json` 的 `techAbort` 块中显式补齐 `"fallbackUnlockSeconds": 2592000` 字段）；若为 `0`，`unlockedLocked` 因 `elapsed >= 0` 在第 10 城结束次秒即 100% 解锁，不会发生除零异常 |
| `riskDisclosureVersion` | `1` | `uint16` | 若与前端 `StakePayload` 发送的版本号不一致，所有用户充值均被判定为无效充值并退回（或 TON 不足时被截留） |

## 5. 审计方法论与覆盖范围说明

### 5.1 审计方法论

1. **编译产物与字节码哈希一致性验证**：核对 `contracts/build/*.json` 中的编译后 BOC 与 SHA-256 代码哈希，确保被审计源码与链上部署字节码一一对应。
2. **手工逐行静态审计与状态机形式化推演**：对 `RoundController.tolk`、`StakeTicket.tolk`、`JunxiangDistributor.tolk`、`ClaimRecord.tolk` 及其共享模块（`types.tolk`、`constants.tolk`、`jetton.tolk`、`ticket.tolk`、`junxiang.tolk`）进行 100% 逐行覆盖，重点推导 TON TVM 特有的异步消息两跳/三跳时序、Compute Phase 与 Action Phase 资金预留（`RAWRESERVE`）与发送模式（Mode 0 / 1 / 2 / 16 / 64 / 128）交互、bounce 256-bit 截断恢复以及跨 10 轮的代币守恒不变量。
3. **标准模板逐字比对（Diff Audit）**：将 `JettonMaster.tolk`、`JettonWallet.tolk` 及 `jetton/*` 辅助文件与 Acton 1.1.0 官方 TEP-74 模板逐行比对，验证 `MintOnce` 一次性铸造及权限永久销毁逻辑。
4. **链下编码与跨层接口一致性核查**：交叉比对 `worker/src/social/merkle.ts`、`payout.ts`、`web/src/features/chain/junxiang.ts`、`payload.ts`、`worker/src/indexer/*`、`ops/scripts/*` 与 `contracts/deploy/abi/*.json`。

### 5.2 审计覆盖范围与未覆盖范围

- **已覆盖范围（100% 覆盖）**：
  - 自研合约（逐行深度审计）：`RoundController.tolk`、`StakeTicket.tolk`、`JunxiangDistributor.tolk`、`ClaimRecord.tolk`、`types.tolk`、`constants.tolk`、`jetton.tolk`、`ticket.tolk`、`junxiang.tolk`
  - 标准模板（逐字 diff 与铸造关闭核对）：`JettonMaster.tolk`、`JettonWallet.tolk`、`errors.tolk`、`fees-management.tolk`、`jetton-utils.tolk`、`messages.tolk`、`sharding.tolk`、`storage.tolk`
  - 链下一致性核对：`worker/src/social/merkle.ts`、`worker/src/social/payout.ts`、`web/src/features/chain/junxiang.ts`、`contracts/deploy/abi/*.json`、`worker/src/indexer/{events,messages,getters,ledger,sync}.ts`、`ops/scripts/{15_deploy_contracts,80_admin_ops,reconcile}.mjs`
- **明确未覆盖范围（Out of Scope）**：
  - 前端 UI 业务逻辑与组件实现（`web/`，除链上消息构造 `junxiang.ts`/`payload.ts` 外）
  - Cloudflare Worker 后端社交积分、战队、猜灯、连战饷与军饷分配计算规则（`worker/src/social/` 中除 `merkle.ts`、`payout.ts` 编码一致性外的业务逻辑）
  - 运维与预售脚本全量逻辑（`ops/`，除部署参数注入与对账一致性核对外）
  - 第三方依赖：TON 公链底层验证器与官方标准库、Acton 编译器自身、STON.fi DEX 路由与池合约
  - 经济博弈模型可持续性与司法管辖区法律合规性

## 6. 对 RFP §5「已接受风险」清单的评估意见

经逐条审阅 `docs/21_AUDIT_RFP.md` §5 所列的 15 条已接受风险，审计方对项目方已书面确认的业务与信任模型选择（单 `keeper` 喂价、单 `publisher` 发布军饷根、无效充值且附带 TON `< 0.1` 不退、输了归零、失败轮 50% 奖池销毁、团队额度晚一轮、续战只续本金、受益人任意基础链地址、80% 压城奖励 30 天线性回退等）**无异议**，但针对其中 **第 3 条、第 5 条、第 15 条** 提出以下 **2 点技术补充说明（必须在主网前通过修复 A9-V11-01 与 A9-V11-05 闭环）**：

1. **关于 §5 第 5 条（“分发合约余额不足时，领取记为已领……运维先充值、再发根以避免”）**：
   - 项目方接受的是“A9 代币余额不足导致 Jetton 转账 bounce 时记为已领”，但当前代码由于 **A9-V11-01**（`RecordPay` 未预留 TON 即混用 `emitExternalEvent` 与 `mode 64`），即使运维严格遵守“先充足额 A9 再发根”，当 `JunxiangDistributor` 的 **1 TON 原生代币（gas）** 被百余次领取事件的 `ext_fwd_fee` 耗尽后，同样会导致 `ClaimRecord` 已记为已领而 `RecordPay` 在 Action Phase 报 `exit 37` 失败。该问题不属于可靠“先充 A9 再发根”规避的运维风险，**必须在合约层按 A9-V11-01 修复**。
   - 同时，运维发根脚本 `80_admin_ops.mjs` 的余额检查公式存在 **A9-V11-05(1)** 缺陷（未扣除 `totalPaidRaw`），必须一并修复才能正常执行“先充值差额、再发根”的运维规程。
2. **关于 §5 第 15 条（生产时序参数与 `mainnet.params.json`）**：
   - 建议在 `ops/config/mainnet.params.json` 的 `techAbort` 对象中显式写入 `"fallbackUnlockSeconds": 2592000`（当前仅靠 `15_deploy_contracts.mjs` 的 `?? 2592000` 兜底），并将 `keeperMinTon` 调高或修复 **A9-V11-06**。

## 7. M4 复核清单（待项目方 M3 修复后逐条核销）

在项目方完成 M3 修复并打 `v11-audit-fixed` 标签后，复核阶段将按以下清单逐项验证：

| 发现编号 | 严重度 | 预期修复动作 | 当前状态 |
| --- | --- | --- | --- |
| **A9-V11-01** | **High** | `JunxiangDistributor.RecordPay` 与 `RoundController.handleDeposit`/`refundDeposit` 增加 `reserveToncoinsOnBalance` 并改用 `SEND_MODE_CARRY_ALL_BALANCE` | 待修复（Open） |
| **A9-V11-02** | **Medium** | `RoundController`、`StakeTicket`、`ClaimRecord` 跨合约消息附加 `SEND_MODE_BOUNCE_ON_ACTION_FAIL`，`handleTicketRequest` 增加 `valueCoins` 下限断言 | 待修复（Open） |
| **A9-V11-03** | **Medium** | `ClaimRecord` 在 `cumulativeRaw <= claimedRaw` 时保留 `0.01 TON` 后将余量通过 `ReturnExcessesBack` 退回 `owner` | 待修复（Open） |
| **A9-V11-04** | **Medium** | 同步更新 `contracts/deploy/abi/RoundController.json`，补齐 `fallbackUnlockSeconds` | 待修复（Open） |
| **A9-V11-05** | **Medium** | 修复 `80_admin_ops.mjs` 军饷余额校验公式、索引器第 10 城 `AbortTechnical` 销毁入账及 `ReleaseTeam` 对账 | 待修复（Open） |
| **A9-V11-06** | **Low** | 退还 `keeper` 多余 TON 或调整 `actions.tolk` 附带 TON 与 `mainnet.params.json` 的 `keeperMinTon` | 待修复（Open） |
| **A9-V11-07** | **Low** | `merkleRootOf` 增加剩余 bit/ref 校验；`junxiang_claim.tolk` 支持多层链式证明 cell | 待修复（Open） |
| **A9-V11-08** | **Low** | `RoundController.handleDeposit` 将 `head == 2` 改为 `payload.preloadUint(3) == 4` 以预检 `anycast == 0` | 待修复（Open） |
| **A9-V11-09** | **Informational** | 统一 `260`/`270`/`271` 错误码枚举、`handleAbortTechnical` 检查最小 `valueCoins`、`mainnet.params.json` 显式写入 `fallbackUnlockSeconds` | 待修复（Open） |
