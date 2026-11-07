# 37 — v11 外部审计 M3 修复说明（供 M4 复核）

- 审计报告：docs/36_V11_SECURITY_AUDIT_REPORT.md（基于 tag `v11-audit-freeze` / f150657）
- 修复版本：分支 `claude/a9-gameplay-design-7b065a`，复核前打 tag `v11-audit-fixed`
- 设计原则（项目方确认）：**用户触发的所有 gas / 转发费 / 事件费由用户承担**，合约自有 TON 只用于协议动作（结算、团队释放）。

## 新代码哈希

| 合约 | freeze | fixed |
|---|---|---|
| RoundController | 0x905F62F5…5C96B | `0xCAD074BAF5B83C3475BE90049B944F8BE3B2D6048F28C2FB6CC77CCB8470C98B` |
| StakeTicket | 0x0F00D299…3DBC | `0xB04B6A611A93401F40B10274D85E72EAAF9624553F546FAC7C4CDCD7555A4F91` |
| JunxiangDistributor | 0x7FD6F461…32AF | `0x9E07E813F0081B715C084BCF479C35E94BA4A711CAF4844C68112B5565B742D8` |
| ClaimRecord | 0xA74D5178…2C43 | `0x8DB60A5B92079367C80AAA9856B2CDDABAFB0667F0C1CEC0CBF19359D8388D61` |
| JettonMaster / JettonWallet | 未改 | 未改 |

`acton test`：37 passed（原 30 + `tests/audit.test.tolk` 7）。在 freeze 代码上运行同一组回归测试：6 个失败（01×2、03、07、08、09），即修复前可复现、修复后通过；01 的「尘埃充值」测试为防回归守护（模拟器无法体现旧代码的事件费损耗）。

## 逐条处理

| 编号 | 报告级别 | 项目方定级 | 处理 | 位置 / 测试 |
|---|---|---|---|---|
| 01 | High | High（范围更大：RC 充值/退款同样受影响，5–10 万笔质押会耗尽 RC） | 修复：`reserve(original − inbound)` 后先发事件、再以 CARRY_ALL_BALANCE 发出，事件费由用户消息承担；不退款的被留存充值仅在自带 ≥ 0.01 TON 时记事件 | RC `handleDeposit`/`refundDeposit`、Distributor `RecordPay`、`jetton.tolk:sendWithReservedBalance`；测试 audit 01 ×3 |
| 02 | Medium | Medium | 修复：攻城令请求路径的 reserve 与所有发送加 `BOUNCE_ON_ACTION_FAIL`；RC 在计算阶段校验请求最低 TON（0.1 / 续战 0.15），不足即抛错弹回、清 pending；StakeTicket → RC 的请求也加 +16 | RC `handleTicketRequest`/`sendTicketUpdate`/`sendClaimTransfer`/`sendAddStake`；StakeTicket `sendRequest` |
| 03 | Medium | Low | 修复：无新增额度时把 TON 退回 owner（保留 0.01 存储），不再滞留 | ClaimRecord；测试 audit 03 |
| 04 | Medium | Low（无代码读取该文件） | 修复：同步 deploy/abi，selftest 增加 build/deploy ABI 一致性检查 | contracts/deploy/abi、ops/scripts/selftest.mjs |
| 05 | Medium | Medium | 修复：发根余额检查计入 totalPaidRaw；索引器记录第 10 城技术终止销毁与最终团队释放；RC 余额对账允许非负舍入尘埃 | 80_admin_ops.mjs、worker/src/indexer/* |
| 06 | Low | Low | 修复：keeperMinTon 2 → 10，开轮附带 TON 降至 0.05 | mainnet.params.json、fast_admin.tolk |
| 07 | Low | Low | 修复：证明 cell 必须恰好整 256 位哈希、至多 1 个 ref（BadProof=260） | junxiang.tolk；测试 audit 07 |
| 08 | Low | Low | 修复：受益人前 3 位必须为 100（addr_std 无 anycast），否则走退款 | RC `handleDeposit`；测试 audit 08 |
| 09 | Info | Info | 修复：错误码并入 `Errors`（数值不变 260/270/271）；AbortTechnical 需附带 ≥ 0.1 TON | constants.tolk、RC；测试 audit 09 |

## 关于 PoC

RFP 要求 High/Critical 附可运行 PoC，审计方未提供；项目方以 `tests/audit.test.tolk` 作为可运行的回归测试补齐（见上，freeze 上失败、修复后通过）。

## 复核时请重点看

1. 01：`handleDeposit` 中 `s.save()` 之后才 reserve + 发送；被留存充值在 `valueCoins < 0.01 TON` 时不记事件（索引器对账因此允许非负尘埃）。
2. 02：`RESERVE_MODE_BOUNCE_ON_ACTION_FAIL` 与各 `+16` 发送组合的动作阶段语义。
3. 新增最低值：RC 请求 0.1 / 续战 0.15 TON 低于攻城令侧 0.15 / 0.25（攻城令一跳的 gas 后仍满足）。
