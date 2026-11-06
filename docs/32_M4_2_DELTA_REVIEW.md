# 32 — M4.2 定向复核包（v8.9 delta）

> 输入：M4.1 定向复核发现 1 处边缘资金丢失路径（复核项 2 FAIL）。
> 输出：**v8.9** 修复（7 行），tag `v8.9-audit-fixed` @ `58d0be8`。
> 请做 M4.2 定向复核（只看 1 个 commit 的 7 行 diff + 2 条测试）。

## 1. M4.1 复核结论的采纳情况

| 复核项 | 审计结论 | 我方核实 | 处置 |
| --- | --- | --- | --- |
| 1. carry 循环与借贷交错 | 无超额提币（但与项 2 交错会丢账） | 同意 | — |
| 2. 在途 ClaimPrincipal(0) + 新退款 + bounce | **FAIL（Medium）** | **确认成立** | ✅ v8.9 修复 |
| 3. `get_claimable_all` 不含 round-0 | PASS | 同意（读写口径一致） | 不改 |
| 4. 仅做定向复核 | PASS | 同意 | — |

### 1.1 我方对缺陷的独立复核（含一处对严重度的修正意见）

时序成立：
```
账本 { amountRaw: X, principalClaimed: false }
→ ClaimPrincipal(0) 在途：claimed=true，amountRaw 仍 = X，pending q1(amount=X)
→ 在途期间新无效质押 Y：refundStake 先 creditRefundLedger（在 hasPending 检查之前）
   carry = claimed ? 0 : amountRaw = 0  →  amountRaw = Y，claimed = false
→ q1 bounce：rollbackPendingClaim 只置 claimed = false
→ 终态 amountRaw = Y，应为 X + Y  →  X 永久滞留 RC
```

**对严重度的修正意见**：只有 **bounce 路径**丢账，**成功路径是正确的**。原因：
- `settlePendingClaim` 中只有 `CLAIM_KIND_REFUND` 会触发 `debitRefundLedger`（`RoundController.tolk:370-372`）；
- 手工领取创建的是 `CLAIM_KIND_PRINCIPAL`（`:1113`），成功结算时**不扣减**账本；
- 因此交错成功时账本停在 Y，用户已收到 X、仍欠 Y，**正好正确**。

触发需四条件同时成立：有未领退款 + 发起手工领取 + 在途期间又发无效质押 + 该领取 bounce。损失为**用户自己的未领退款**（滞留合约，非第三方盗取）。我方评估更接近 **Low**，但因合约不可升级，仍按修复处理。

## 2. 修复（commit `58d0be8`，`A9-M4-02b`）

`RoundController.tolk` `rollbackPendingClaim` 的 `CLAIM_KIND_PRINCIPAL` 分支，**严格限定 `p.roundId == 0`**：

```tolk
if (p.roundId == 0) {
    // A9-M4-02b: a round-0 refund claim may be in flight while new
    // refunds land. creditRefundLedger zeroed the pre-claim carry, so
    // restore it on bounce: new balance = unclaimed carry + in-flight X.
    val carry: uint128 = pos.principalClaimed ? 0 as uint128 : pos.amountRaw;
    pos.amountRaw = carry + p.amountRaw;
}
pos.principalClaimed = false;
```

**三种状态验证**：

| 场景 | claimed | amountRaw | carry | 结果 |
| --- | --- | --- | --- | --- |
| 无交错 bounce | true | X | 0 | X ✓（与现行行为一致） |
| 交错 1 笔 bounce | false（被 credit 重置） | Y | Y | Y + X ✓ |
| 交错多笔 bounce | false | Y1+Y2 | Y1+Y2 | ΣY + X ✓ |

**影响面**：仅 round-0 退款账本；1..10 轮的领取回滚逻辑**一行未动**。

## 3. 回归测试（新增 2 条，真 JettonWallet）

| 测试 | 断言 |
| --- | --- |
| `M4-02b interleaved refund keeps X+Y on bounce` | X=1000 退款 → ClaimPrincipal(0) 在途 → 新退款 Y=2000 → bounce → `amountRaw == 3000`、`claimed == false` |
| `M4-02b non-interleaved refund bounce keeps X` | X=1000 → 在途领取 → 直接 bounce → `amountRaw == 1000`、`claimed == false`（证明未改坏原有行为） |

**修复前失败证据**（临时移除 `roundId == 0` 块后跑第 1 条）：
```
✗ M4-02b interleaved refund keeps X+Y on bounce
  (2000, 3000)   # actual vs expected
```
恢复后通过。**测试确实能捕获该缺陷**，不是「写完就绿」。

## 4. v8.9 冻结基线

| 合约 | Code Hash | 与 v8.8 |
| --- | --- | --- |
| RoundController | `0xFE7088ED1C52949CD1CB0931D95911F757BC402FC37065502002DF15CCDD50AE` | **变更** |
| JettonWallet | `0xC40F41ED05BEFFB7EF17E25FA0D1BB2AFDA72C567052546A2E310C0275D31D13` | 不变 |
| JettonMaster | `0xB8FAF413176C6329A98B2474FEDF765A796A14EDA96C031EE1FE5B27E59EE272` | 不变 |
| TeamVault | `0xDE6BE49154E3024C9B6945EA81E7181F3E1D04FECC85DBC629C08EDE6A673FB6` | 不变 |
| OracleAdapter | `0x0C91E5338E00F18B5FFC7C5C26B510424775D8089588F4147E5B667703676768` | 不变 |

验证：`acton check` 0 error 0 warning；`acton test` **179 passed / 18 files**。

diff 范围：3 个文件，+87/−6（RC +7 行、测试 +58、README +28/−6）。

## 5. 验证层次的如实声明（请复核方知悉）

| 验证方式 | 覆盖内容 | 局限 |
| --- | --- | --- |
| 单元测试（真 JettonWallet） | 交错 bounce / 无交错 bounce / 账本金额 | 依赖测试夹具正确模拟 bounce |
| 代码审查 | carry 语义、`p.roundId == 0` 隔离性 | — |
| **链上实例（v8.9 测试网）** | 部署哈希、TV controller、A9 注入、**M4-01 退款回归**、R1 成功轮、R2 失败轮、普通领取 | **无法在链上强制 bounce**（需让收款钱包失败），交错 bounce 场景只能靠单元测试 → 链上只能证明「正常路径未被改坏」 |

**这一点我们主动声明**：交错 bounce 没有链上证据。如果复核方认为必须有，请说明可构造的方法（例如部署一个会失败的收款钱包），我们配合补测。

## 6. 请复核方确认

1. `carry + p.roundId == 0` 的隔离是否真的不影响 1..10 轮领取回滚。
2. 交错多笔（≥2 笔在途新退款）的累加是否正确。
3. 成功路径确实不需要改（`settlePendingClaim` 仅 REFUND kind 扣减）这一判断是否同意。
4. 是否同意 M4.2 只需定向复核（diff 7 行 + 2 条测试），无需重跑完整 M4。

## 7. 复现

```bash
git checkout v8.9-audit-fixed
cd contracts && acton build --clear-cache && acton check && acton test   # 期望 179 passed / 18 files
git diff v8.8-audit-fixed v8.9-audit-fixed -- contracts/contracts/RoundController.tolk
```