# 29 — 主网切换包（MAINNET CUTOVER）

**版本**：V1.0 · 2026-11-06
**代码基线**：tag `v8.8-audit-fixed` @ `fb6bb45`（`git rev-parse v8.8-audit-fixed^{}` = `fb6bb45`）；`acton check` 0 error 0 warning；`acton test` **177 passed / 18 files**。
**定位**：本文件不是概念说明，而是**主网切换的可执行清单**。每一步都写清「命令 / 期望输出 / 失败怎么办 / 是否可逆」。

> **当前状态：不是上线许可。** §1 的门禁尚未全部满足（特别是 G0 主网 ops 适配、G0b 生产 D1 隔离、G2 生产时序（待 11/9 03:37 三项断言落地）、G5 admin 冷钱包、G6 GRAM 到账、G7 TON 预算）。未满足项**禁止开始**；不要在聊天里用“已确认/没问题”替代链上证据。

**三件不可逆的事（先记住）**：
1. **合约部署**（地址与 code hash 永久固定，RC 不可升级）；
2. **admin / wiring 写入**（`InitController`、`SetJettonWallet*`、`SetTeamWalletJettonWallet` 均只能执行一次，写错无补救）；
3. **A9 注资/分配**（5 笔转账与销毁不可撤销）。

---

## 0. 铁律、两节课与口径

### 0.1 两节 v8.8 部署课（必须写进值班表）

**课 1：dry-run 的成功判据是日志出现 `Funded RC Jetton Wallet`，不是 exit 0。**
- 我们踩过：`mint forward < 0.35 TON` 时，admin 的 Jetton Wallet 部署会失败，但部署脚本仍可能继续跑/返回 0；后续注资全部打到不存在的钱包。
- 因此：**任何 dry-run 与真实部署，都必须 `grep -F "Funded RC Jetton Wallet"` 命中**，并回读 RC/TV 钱包 `get_wallet_data` 余额；两条都满足才算成功。

**课 2：注资步骤可能因钱包 seqno 冲突抛 `exit code 33`。**
- 形态：同一签名钱包连续 external 消息，链上 seqno 竞争 → VM 退出码 33；**这不代表资金没动**，部分转账可能已上链。
- 处置：**先回读余额，再决定重试/补差额**（§5.4）；绝不“整笔再发一次”。

### 0.2 口径：TON / GRAM / A9 各管什么

| 对象 | 用途 | 禁止 / 注意 |
| --- | --- | --- |
| **TON** | 只用于 **gas / 部署费 / 存储费**（部署、wiring、注资、用户 stake/claim 的链上手续费） | **不得**用作计价、募资、奖励单位；产品页不得写“用 TON 参与” |
| **GRAM** | **价格锚**：`1 GRAM = 1000 A9`；内盘**只收 GRAM**；R1 的 `twap24hUsdE8` 由 GRAM 实时价换算成 USD_E8 | P0 是**部署参数**，由项目方在内盘结束后按 GRAM 实时价确定（当前占位 `$0.00116` / `USD_E8=116000`） |
| **A9** | 协议唯一业务单位：质押、奖励、团队额度、内盘额度、流动性额度 | 所有文档/后台金额单位用 A9；raw 为 9 位精度 |

**R1 目标价示例**：`target = max(2 × twap24hUsdE8, 232000)`（tier=1 阶梯下限 `$0.00232`）；若 `twap=150000`，target=`300000`，不是固定 `232000`。

### 0.3 通用准备（每个终端先执行）

~~~bash
cd /Users/yu1/Desktop/BAM
export OPS_PARAMS="$PWD/ops/config/mainnet.params.json"
export OPS_REGISTRY="$PWD/ops/config/mainnet.registry.json"
export OPS_RECORDS_DIR="$PWD/ops/records/mainnet-cutover-$(date +%Y%m%d-%H%M)"
mkdir -p "$OPS_RECORDS_DIR"
export A9_MAINNET_RPC="https://toncenter.com/api/v2"
export A9_MAINNET_API="https://toncenter.com/api/v3"
~~~

期望：目录创建成功。
失败：目录不可写 → 停止，检查仓库权限/磁盘。**可逆**：是（删空目录即可，不影响链上）。

> ⚠️ **ops 脚本不读 `OPS_NETWORK`**（runbook 07 §4.3 的 `export OPS_NETWORK=mainnet` 是无效的）。真正生效的是 `OPS_PARAMS` / `OPS_REGISTRY`；网络由参数文件里的 `--net` 决定（见 G0）。

### 0.4 证据归档（全程留痕）

所有命令输出、tx hash、`acton rpc info`、toncenter 回执、截图都放进 `$OPS_RECORDS_DIR`，文件名固定：`NN_step_name.{log,txt,json,png}`。部署结束打包 `ops/records/mainnet-cutover-*.tar.gz` 交审计/客服各一份。

---

## 1. 前置门禁（全部满足才允许开始）

**状态列由部署负责人逐项签字；任何一项 `FAIL` → 停止，不允许用“先部署再补”绕过。**

| # | 门禁 | 命令 / 证据 | 期望 | 失败怎么办 | 可逆？ |
| --- | --- | --- | --- | --- | --- |
| **G0** | **主网 ops 适配通过**（task-54 / 前置自检脚本） | ①`grep -n -- "--net testnet" ops/config/mainnet.params.json`；②修完后 `grep -rn -- "--net testnet" ops/scripts/ \| wc -l` | ①**0 命中**；②**必须为 0**（当前已确认 **17 处**硬编码 + `OPS_NETWORK` 无人读取，已派 testnet-ops 修复）；preflight 对 mainnet 地址不再要求 `testnet` 标记；`OPS_PARAMS` 指向 mainnet 后所有 getter 走主网 RPC | 停止；把命中项交 ops 修复（改 `--net mainnet` 或参数化），修复后重跑 G0；**不要手工 sed 脚本后硬跑** | 文件可改回（代码侧），链上未动 |
| **G0b** | **生产 D1 与 demo D1 隔离** | `grep -n "database_id" worker/wrangler.toml` 并对比 `[env.production]` 与顶层 demo 的 `[[d1_databases]]` | **[env.production] 的 database_id 必须 ≠ 顶层 demo 的 database_id**；生产绑定 `a9-mainnet`；CI/preflight 有校验 | 相同或仍指向 demo → 停止，等 backend-dev 修复后再部署；**不得用 demo 库接生产** | 是（配置） |
| **G1** | **M4.1 复核通过** | `docs/28_M4_1_DELTA_REVIEW.md` 全文 + 复核方书面结论（姓名/日期/结论） | 复核结论明确“可进入主网”；M4-01/M4-02 回归证据齐全（177 tests / v8.8 链上回归） | 未签字 → 停止；不得用“自己看过”替代 | 是（流程） |
| **G2** | **生产时序验证（prodtest v8.7 实例）** | v8.7 prodtest **RC `kQDmIKscJAg29SKiBo23j6nR6whklaoMBM7wQ3jVQGGS9gxY`**；证据 `$OPS_RECORDS_DIR/timing-evidence.json` + 下表时间点断言 | **待 11/9 03:37 三项全部落地后转 PASS**：①`stakeCloseAt−stakeOpenAt==129600`（已验）；②**11/8 03:35 关窗**后 `observationEnd−observationStart==86400`；③**11/9 03:37 结算后、R2 被 OpenRound 之前**读 `R2.stakeOpenAt−R1.settledAt` **必须精确 ==43200**（12h 预告期）；若已 OpenRound 则只能断言 `>=43200`（A9-F9 会把 stakeOpenAt 重锚为实际开轮时间，实测偏差=keeper 的 settle-wait） | 任一不等 → 停止；**不得改参数迁就**；11/9 03:37 后仍缺证据 → G2=FAIL | 是（未上主网） |
| **G3** | **CI 生产门禁生效** | `.github/workflows/ci.yml` 中 production guard 代码 + 最近一次 CI run URL | `DATA_SOURCE=chain`、`CHAIN_NETWORK=mainnet`、`DEMO_ALLOW_UNSIGNED_WRITES=false`、地址非占位符，否则 fail | 门禁缺失 → 停止；先修 CI 并跑一次 dry-run | 是 |
| **G4** | **toncenter 主网 key 可用** | `curl -s -H "X-API-Key: $TONCENTER_API_KEY" "$A9_MAINNET_RPC/getAddressInformation?address=$ADMIN_ADDRESS"` | HTTP 200，`ok:true`，无限流 | 401/429 → 换 key/加配额；**不得不带 key 硬跑** | 是 |
| **G5** | **admin 冷钱包地址已定**（D-36） | 硬件钱包地址 + 双人核对记录（首尾 6 字符 + CRC，§3.3） | 地址固定；钱包 `seqno=0`（从未发交易）；私钥离线 ≥2 份 | 不符 → 停止；**部署后 admin 永久不可改** | **否（部署后）** |
| **G6** | **主网 GRAM ≥5 已到 deployer** | toncenter v3：`GET /jetton/wallets?jetton_address=<GRAM_MASTER>&owner_address=<DEPLOYER>` | `balance` ≥ 5 GRAM（按项目方确认的 decimals 换算 raw） | 未到账 → 停止，先转够；**不要用测试网 GRAM** | 是（转账可再操作） |
| **G7** | **TON 预算已批准** | 部署记录中的 TON 预算表（部署 4 笔 + wiring + 注资 5 笔 + RC/TV gas + 用户提示） | deployer ≥30 TON；RC 部署后 ≥20 TON、TV ≥10 TON；用户 UI 明确“至少 0.5 TON gas” | 不足 → 停止补足；**不要压低合约 value 到 0.05 级** | 是（充值） |
| **G8** | **主网 D1 方案就绪** | Cloudflare 账号权限、`wrangler whoami`、计划库名 `a9-mainnet`；**且 `[env.production]` database_id 与顶层 demo 不同（见 G0b）** | 有权限创建/迁移；无同名冲突；生产/演示库 id 不同 | 无权限 → 换账号/授权；**不得复用测试库** | 是 |
| **G9** | **tag 与 5 个 code hash 一致** | `git rev-parse v8.8-audit-fixed^{}`；`node -e` 读 `contracts/build/*.json` 的 hash | commit=`fb6bb45`；5 个 hash 与 §4.2 表逐字一致 | 不一致 → 停止；重新 clean build；**不要用旧 build 产物** | 是（未上链） |
| **G10** | **主网参数双人复核 + 哈希存档** | `mainnet.params.json` 逐项过表；`sha256sum` 存档 | P0/时间参数/限额/分配/opcode 全对；SHA-256 写入证据文件 | 任一项错 → 停止改文件后重算哈希；**部署后参数不可改** | 是（部署前） |
| **G11** | **域名/公告就绪** | `dig a9.lat`、Cloudflare 证书 Active、公告审批记录 | 解析正确、证书有效、公告含 H1「押多少你定，赌 72 小时内至少翻倍。」 | 未就绪 → 停止；**不要先部署后补公告** | 是 |

### 1.1 G2 的执行命令（可直接贴）

**A. 参数静态断言（部署前必跑）**：

~~~bash
node - <<'EOF'
const p = require(process.env.OPS_PARAMS);
const t = p.timeline;
const eq = (name, got, want) => { if (got !== want) { console.error(`FAIL ${name}: ${got} != ${want}`); process.exitCode = 1; } else console.log(`OK ${name}=${got}`); };
eq("stakeCloseAt-stakeOpenAt", t.stakeDurationSeconds, 129600);
eq("observationEnd-observationStart", t.observationSeconds, 86400);
eq("observation-start==stakeClose", t.formula.includes("observationStart = stakeCloseAt"), true);
eq("preview", t.previewSeconds, 43200);
eq("candles", t.candleCount, 24); eq("threshold", t.minQualifiedCandles, 16);
EOF
~~~

期望：全部 `OK`，exit 0。失败：参数文件错 → 停止重审。**可逆**：是。

**B. 链上实例断言（prodtest / 测试网 v8.7+ 实例；R1、R2 都至少跑过一次）**：

~~~bash
# 前提：$PRODTEST_API 指向已部署实例的 worker API（chain 模式）
curl -s "$PRODTEST_API/api/rounds" > "$OPS_RECORDS_DIR/rounds.json"
jq -e '
  (.data // .) as $r |
  ($r[] | select(.roundId==1)) as $r1 |
  ($r[] | select(.roundId==2)) as $r2 |
  (($r1.stakeCloseAt - $r1.stakeOpenAt) == 129600000) and
  (($r1.observationEnd - $r1.observationStart) == 86400000) and
  (($r2.stakeOpenAt - $r1.settledAt) == 43200000)
' "$OPS_RECORDS_DIR/rounds.json"
~~~

期望：`true`，exit 0（字段单位是毫秒，所以 72h=259200000 等按 1000 换算）。

> 若 worker API 不可用：直接对 prodtest RC `kQDmIKscJAg29SKiBo23j6nR6whklaoMBM7wQ3jVQGGS9gxY` 调 toncenter `runGetMethod("get_round", [roundId])`；槽位映射见 `worker/src/indexer/getters.ts:193-212`（`stakeOpenAt=stack[7]` … `settledAt=stack[14]`，单位秒），换算成秒后做同样三项断言。
失败：字段缺失/不相等 → 把 `rounds.json` 与 `acton rpc info` 回执一起交回，**停止主网**。**可逆**：是（未上主网）。

> **G2 当前状态（2026-11-06）**：**不是 FAIL，是「进行中、等待时间点落地」**。
>
> | 时间点 | 验证项 | 期望 | 状态 |
> | --- | --- | --- | --- |
> | 已验 | `stakeCloseAt − stakeOpenAt` | `129600`（36h） | ✅ 已通过 |
> | **11/8 03:35**（关窗后） | `observationEnd − observationStart` | `86400`（24h） | ⏳ 待验 |
> | **11/9 03:37**（结算后**立即**，R2 尚未 OpenRound） | `R2.stakeOpenAt − R1.settledAt` | **精确 `43200`**（12h PREVIEW）；若已 OpenRound 则只保证 `>=43200` | ⏳ 待验 |
>
> **为什么用 v8.7 实例验证**：v8.8 只改了 RoundController 的退款账本逻辑（M4-01/02），**不改变任何时序常量/状态机路径**（见 docs/18 §17.4）；因此 11/8、11/9 两项在 v8.7 prodtest 实例上验证即有效，无需等 v8.8 新实例。三项全部 PASS 后，G2 转 PASS，方可进入 §4。

---

## 2. 主网 D1 新库（不碰测试库）

### 2.1 创建

~~~bash
cd worker
wrangler d1 create a9-mainnet
# 把返回的 database_id 写入 wrangler.toml 的 [[d1_databases]]，binding 保持 DB
wrangler whoami
~~~

期望：输出 `database_id`；`wrangler whoami` 显示正确账号。
失败：名称冲突/权限不足 → 换名或检查账号；**不得复用测试库**。
**可逆**：是（库可删，尚未接入生产 Worker）。

### 2.2 migrations 守卫 + apply（**绝不执行 seed.sql**）

~~~bash
cd worker
ls migrations | sort
for f in migrations/*.sql; do case "$(basename "$f")" in [0-9][0-9][0-9][0-9]_*.sql) ;; *) echo "BAD: $f"; exit 1;; esac; done
wrangler d1 migrations apply a9-mainnet --remote
~~~

期望：`ls` 恰好 `0001_init.sql` … `0009_chain_indexer.sql`；apply 只列这 9 个，0 报错。
失败：出现非编号文件 → **立即停止**，移出 migrations 后重跑；**绝不执行 seed.sql**。
**可逆**：是（删库重建；尚未有业务数据）。

### 2.3 验证空库

~~~bash
wrangler d1 execute a9-mainnet --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
wrangler d1 execute a9-mainnet --remote --command "SELECT COUNT(*) AS rounds FROM rounds;"
wrangler d1 execute a9-mainnet --remote --command "SELECT COUNT(*) AS trades FROM trades;"
wrangler d1 execute a9-mainnet --remote --command "SELECT COUNT(*) AS claims FROM claims;"
wrangler d1 execute a9-mainnet --remote --command "SELECT COUNT(*) AS stakes FROM stakes;"
~~~

期望：表存在；`rounds=0`、`trades=0`、`claims=0`、`stakes=0`、`burn_ledger=0`。
失败：任何业务表非空 → **停止**（可能灌入了 seed/demo 数据）；记录表名与行数，不得“先上线再清”。
**可逆**：是（清库/重建）；但若已有数据，**先导出备份**。

### 2.4 上线前备份

~~~bash
wrangler d1 export a9-mainnet --remote --output "$OPS_RECORDS_DIR/d1-mainnet-preload.sql"
shasum -a 256 "$OPS_RECORDS_DIR/d1-mainnet-preload.sql"
~~~

期望：导出成功 + 记录 sha256。失败：导出失败 → 停止，先解决权限/配额。**可逆**：备份本身可删。

---

## 3. 密钥仪式（主网全新，严禁复用测试网）

### 3.1 角色与用途

| 角色 | 用途 | 是否上链 | 地址是否公开 |
| --- | --- | --- | --- |
| deployer | 部署/注资签名（acton 钱包） | 是（发交易） | 不公开 |
| admin | RC / TV / OA 的唯一 owner（D-36 冷钱包） | 是（写 admin） | 不公开 |
| treasury | 接收 100 亿 mint，A9 分发来源 | 是 | 不公开 |
| team / marketing / liquidity | 收款热钱包 | 是（收款） | 不公开（团队内盘钱包除外） |
| internal | 团队内盘管理钱包（未售/撤回内盘） | 是 | **公开可查** |

### 3.2 生成与备份

- 在**离线机器/硬件钱包**生成，使用全新助记词；**禁止复用测试网任何 mnemonic/私钥**；
- 每个角色独立助记词（至少 deployer / admin / treasury 三者分离）；
- 助记词离线抄写 ≥2 份、异地存放；密码管理器只存**地址与标签**，不存助记词；
- 环境变量（不落盘、不进命令历史）：`TON_DEPLOYER_WALLET`、`TON_DEPLOYER_MNEMONIC`、`TON_ADMIN_OWNER_ADDRESS`、`TON_TREASURY_ADDRESS`；收款地址由 registry 登记。

**期望**：7 个地址（deployer / admin / treasury / team / marketing / liquidity / internal）全部生成并记录。
**失败**：复用/混用 → 停止，重新生成。**可逆**：是（尚未上链）；一旦部署后 admin 不可改。

### 3.3 双人核对（首尾 6 字符 + CRC）

~~~bash
ADDR="$1"   # 待核对地址
python3 - "$ADDR" <<'EOF'
import sys, zlib
a = sys.argv[1].strip()
print("len", len(a), "head", a[:6], "tail", a[-6:], "crc32", format(zlib.crc32(a.encode()) & 0xffffffff, "08x"))
EOF
~~~

两人各自在离线环境执行并口头/纸质比对；**首尾 6 字符、长度、CRC32 全部一致**才算通过。
失败：任一不一致 → 停止，重新导出地址核对。**可逆**：是。

### 3.4 admin 冷钱包硬性要求（D-36 风险已接受）

- 硬件钱包生成，助记词离线 ≥2 份；**部署后 admin 永久不可改**；
- 部署前检查该地址 `seqno=0`（从未发出交易）：

~~~bash
curl -s -H "X-API-Key: $TONCENTER_API_KEY" "$A9_MAINNET_RPC/getWalletInformation?address=$ADMIN_ADDRESS" | jq
~~~

期望：`seqno` 为 0（或钱包未初始化、无历史交易）。失败：有历史交易 → 不是干净冷钱包 → 停止更换。**可逆**：部署前是。

### 3.5 登记

把地址写入 `$OPS_RECORDS_DIR/addresses.md`（角色、地址、生成日期、备份位置编号），**不写私钥/助记词**；同时准备写入 `mainnet.registry.json`（由 60 脚本生成）。

---

## 4. 合约部署（全新，禁止 resume）

### 4.1 参数与网络（先解决 G0）

~~~bash
cd /Users/yu1/Desktop/BAM
export OPS_PARAMS="$PWD/ops/config/mainnet.params.json"
export OPS_REGISTRY="$PWD/ops/config/mainnet.registry.json"
node ops/scripts/00_preflight.mjs
~~~

期望：0 blocking；分配总和 100 亿；阶梯一致；参数哈希生成。
失败：任何 blocking → 停止修参数/地址。**可逆**：是。

> **已知工具缺口（必须由 task-54 修复/覆盖，否则 G0 不过）**：`mainnet.params.json` 的 `toolchain.commands` 目前全部写死 `--net testnet`；`15/65/90` 脚本中的 `acton rpc info` 也写死 `--net testnet`。这会把主网部署发到测试网、并用测试网 RPC 校验主网 hash。**在 G0 修复前禁止执行 §4.3。**

### 4.2 v8.8 冻结基线（写入部署记录，逐字核对）

~~~text
JettonMaster    0x876F21A1A516FB0449A1D0AF5DBECEB8639373F947949C5AE8E1E9DBB769D64F
JettonWallet    0x394E4E8D40B5D3D97D12AA950B99EA9A53387DDAC331BAAAC8923F0E6E6849A4
TeamVault       0xCF3E6C7C9DC045F392F35E79E20AA6EDAAF9064D538CA4E78B6D1FE1443158B4
RoundController 0x4EE42C5C0EB13CDB6689823BEA883D30E852EEA066D3C108A6531A69D4093EF8
OracleAdapter   0x539F3597357943584A596DA2B40F901B4984D8C8307E63CE81A67F131EAB8CBA
~~~

> 说明：v8.8 只改 **RoundController**（M4-01/M4-02 退款账本修复），其余 4 个 hash 与 v8.7 相同；v8.8 基线见 `docs/28_M4_1_DELTA_REVIEW.md §5`（docs/18 §16 为 v8.7，§17 尚未生成）。

核对命令（必须在 **mainnet** 上）：

~~~bash
cd contracts
for n in JettonMaster JettonWallet TeamVault RoundController OracleAdapter; do
  node -e "const j=require('./build/'+process.argv[1]+'.json'); console.log(process.argv[1], j.hash)" "$n"
done
~~~

期望：5 个 hash 与上表逐字一致。
失败：不一致 → 停止；`acton build --clear-cache` 后重取；**不要用旧 build**。**可逆**：是。

### 4.3 部署 dry-run（**成功判据 = 出现 `Funded RC Jetton Wallet`**）

~~~bash
cd contracts
acton build --clear-cache
acton script scripts/deploy-emulation.tolk 2>&1 | tee "$OPS_RECORDS_DIR/dryrun-deploy-emulation.log"
grep -F "Funded RC Jetton Wallet" "$OPS_RECORDS_DIR/dryrun-deploy-emulation.log"
~~~

期望输出（两行核心）：

~~~text
Funded RC Jetton Wallet with 7000000000000000000 raw A9, TV Jetton Wallet with 1200000000000000000 raw A9
Deploy complete: contracts + wiring + A9 funding are on-chain.
~~~

**判据：`grep` 必须命中；只看 exit 0 = 无效。**
失败：
- 没有该行 → 视为**部署失败**（即便 exit 0）。检查：`A9_DEPLOY_MINT_TON=0.55`、`A9_DEPLOY_MINT_FORWARD_TON≥0.35`（**<0.35 会导致钱包部署失败**）、admin 钱包 TON 余额；清空 emulator 后重跑；**不要上链**。
- `get_wallet_data` RC/TV 余额不为 `7e18 / 1.2e18` → 同上处理。

**可逆**：是（本地 emulator，无链上副作用）。

### 4.4 正式部署（OPS_EXECUTE=1，不可逆）

**前置检查（逐条打印后签字）**：
1. G0~G11 全绿；
2. `$OPS_PARAMS` 指向 mainnet，且 `grep -- "--net testnet"` 为 0；
3. dry-run 已命中 `Funded RC Jetton Wallet`；
4. admin 冷钱包地址已双人核对；
5. deployer TON ≥30。

~~~bash
cd /Users/yu1/Desktop/BAM
export OPS_PARAMS="$PWD/ops/config/mainnet.params.json"
export OPS_REGISTRY="$PWD/ops/config/mainnet.registry.json"
export A9_DEPLOY_TON_JETTON_MASTER=<审批值>
export A9_DEPLOY_TON_ORACLE_ADAPTER=<审批值>
export A9_DEPLOY_TON_TEAM_VAULT=<审批值>
export A9_DEPLOY_TON_ROUND_CONTROLLER=<审批值>
export A9_DEPLOY_MINT_TON=0.55 A9_DEPLOY_MINT_FORWARD_TON=0.4
OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/15_deploy_contracts.mjs --execute 2>&1 | tee "$OPS_RECORDS_DIR/15_deploy.log"
grep -F "Funded RC Jetton Wallet" "$OPS_RECORDS_DIR/15_deploy.log"
~~~

期望：脚本解析出 6 个地址（JM / OA / TV / RC / RC wallet / TV wallet）；`15` 的 active + code hash 门禁 PASS；`Funded RC...` 命中。
失败：
- 任一地址未 active / hash mismatch → 脚本 FAIL 不登记；**停止**，不要手工填地址；日志在 `ops/records/deploy-emulation-*.log`。
- **exit code 33**：钱包 seqno 竞争，**不等于没上链** → 按 §5.4 先回读余额，再决定重试/补差额。
- `mint` 失败/钱包未部署 → 检查 mint forward ≥0.35，重新干净部署（**禁止 resume**）。

**可逆**：**否**（合约地址与代码永久固定）。

### 4.5 部署后手工核对（不只看脚本 PASS）

~~~bash
cd contracts
for a in $(jq -r '.contracts | to_entries[] | select(.value.address != null) | .value.address' "$OPS_REGISTRY"); do
  acton rpc info "$a" --net mainnet | grep -E "Status|Code Hash"
done
~~~

期望：5 个合约 `Status: active`，`Code Hash` 与 §4.2 逐字一致。
失败：**停止**，不得开轮；记录差异并重部署（新实例，不是 patch 旧实例）。**可逆**：否。

### 4.6 wiring 与一次性写入（已内置在 15，二次确认）

- `SetJettonWallet`（RC/TV）、`SetJettonWalletCode`（RC）、`SetTeamWalletJettonWallet`（TV）、`InitController`（TV）均由 `deploy-emulation` 顺序执行；
- 核对：`RC.oracle=OA`、`RC.stakingJettonWallet=RC wallet`、`RC.teamVault=TV`、`TV.controller=RC`、`TV.jettonWallet=TV wallet`、`TV.teamWalletJettonWallet=team canonical wallet`；
- `65 --query-only` 只做登记；`70 --mark-bound-only` 只登记绑定，**不要重复发 InitController**。

失败：任一 wiring 未完成 → 停止；`InitController` 不可逆，**绝不重复发**。**可逆**：否。

---

## 5. A9 分配（100 亿，5 笔；每笔 probe + 回读）

### 5.1 铸造去向

- mint-once 把 100 亿铸给 **treasury**（`TON_TREASURY_ADDRESS`，部署者冷钱包）；
- 若项目方按 D-36 决定先铸给 admin 冷钱包再分发：把 treasury 换成 admin 地址，**必须双人签字**；两种方式都只能选一种，不能重复 mint；
- 铸造后 `total_supply == 1e19` 且 `mintable == false`。

### 5.2 五笔分配（不可逆）

| 接收方 | owner | 金额（A9） | raw |
| --- | --- | --- | --- |
| RC Jetton Wallet（本金+奖励） | RoundController | 70 亿 | `7000000000000000000` |
| TV Jetton Wallet | TeamVault | 12 亿 | `1200000000000000000` |
| 团队内盘管理钱包 | internal（公开可查） | 8 亿 | `800000000000000000` |
| 流动性钱包 | liquidity | 5 亿 | `500000000000000000` |
| 营销钱包 | marketing | 5 亿 | `500000000000000000` |

~~~bash
cd /Users/yu1/Desktop/BAM
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<admin/deployer> \
  node ops/scripts/50_fund_vaults.mjs --execute --all --probe 2>&1 | tee "$OPS_RECORDS_DIR/50_fund.log"
~~~

期望：第一笔先 1 A9 probe，确认到账后发余量；每笔 `get_wallet_data` 增量精确匹配；末尾 5 项全部 `>= 注资额`；admin A9 归零。
失败：任何金额/地址不符 → **立即停止**；已错投不可逆（§10）。
**可逆**：**否**。

### 5.3 逐笔回读（必须做）

~~~bash
# 对 5 个目标钱包逐个执行；期望余额等于上表 raw
acton rpc info <JETTON_WALLET_ADDRESS> --net mainnet   # 先确认 active
# 或用 toncenter v3 读 get_wallet_data 第 0 槽
curl -s -H "X-API-Key: $TONCENTER_API_KEY" \
  "$A9_MAINNET_RPC/runGetMethod" -H "Content-Type: application/json" \
  -d "{\"address\":\"<wallet>\",\"method\":\"get_wallet_data\",\"stack\":[]}" | jq
~~~

期望：5 个钱包余额 = 上表 raw；`total_supply` 仍为 1e19；admin 钱包 A9 余额 = 0（或项目方书面保留的 gas 额度）。
失败：差额 → 停止，按 §5.4 处理；**不要重复整笔转账**。**可逆**：否。

### 5.4 `exit code 33` / seqno 冲突处置（写在值班卡上）

1. **先判“钱有没有动”**：读取 5 个收款钱包 + admin A9 + deployer TON 余额；
2. **全 0 / 完全没动** → 可重试同一命令**一次**（先确认 seqno 已更新/节点回读一致）；
3. **部分到账** → 计算差额，用单笔模板手工补：

~~~bash
cd contracts
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<signer> JETTON_MASTER_ADDRESS=<jm> \
  acton script --net mainnet scripts/deploy/fund_jetton.tolk <recipientOwner> <remainingRaw>
~~~

4. **补完必须回读**：`get_wallet_data` 余额精确等于目标；
5. **绝不允许**“整笔重发”或“用 50 脚本再跑一遍全额”；`50 --resume` 只在确认余额后使用（它会按余额跳过已达标项）。

> 期望：最终 5 个钱包余额精确匹配；失败：仍不匹配 → 停止所有签名，按 runbooks/03 升级。**可逆**：否。

---

## 6. Worker 部署（production 环境）

### 6.1 secrets（只走 `wrangler secret`，不进仓库）

~~~bash
cd worker
wrangler secret put ADMIN_TOKEN --env production        # 强随机 ≥32 bytes
wrangler secret put TONCENTER_API_KEY --env production  # 主网 key
~~~

期望：两条成功。失败：权限/账号错 → 停止。**可逆**：是（secret 可覆盖）。

### 6.2 GitHub Variables（地址不提交进仓库，D-38）

在 GitHub → Settings → Variables 设置：`PROD_ROUND_CONTROLLER_ADDRESS`、`PROD_TEAM_VAULT_ADDRESS`、`PROD_JETTON_MASTER_ADDRESS`、`PROD_ORACLE_CONFIG_HASH`（4 个，均来自 §4/§5 的链上真实值）。
期望：4 个变量存在且非占位符。失败：缺一个 → CI 会 fail 并打印原因；**不要 `allow_demo_deploy=true`**。**可逆**：是。

### 6.3 部署（必须 `--env production`）

~~~bash
pnpm -C web build
cd worker
wrangler deploy --env production \
  --var ROUND_CONTROLLER_ADDRESS:"$PROD_ROUND_CONTROLLER_ADDRESS" \
  --var TEAM_VAULT_ADDRESS:"$PROD_TEAM_VAULT_ADDRESS" \
  --var JETTON_MASTER_ADDRESS:"$PROD_JETTON_MASTER_ADDRESS" \
  --var ORACLE_CONFIG_HASH:"$PROD_ORACLE_CONFIG_HASH" \
  2>&1 | tee "$OPS_RECORDS_DIR/worker-deploy.log"
~~~

期望：CI 生产门禁通过（`DATA_SOURCE=chain` / `CHAIN_NETWORK=mainnet` / `DEMO_ALLOW_UNSIGNED_WRITES=false` / 地址已注入），输出新版本号。
失败：门禁 fail → 按日志修配置，**不要回滚到 demo**；D1 绑定错 → 检查 `database_id`。**可逆**：是（Worker 可 rollback）。

### 6.4 验证（必须看到链上真值）

~~~bash
curl -s https://a9.lat/api/health | jq
curl -s https://a9.lat/api/version | jq
curl -s https://a9.lat/api/rounds | jq '.[0] // .data[0]'
~~~

期望：`health ok`；`version` 与部署 sha 一致；`rounds` 的 `roundId/status/target` 与 `get_round` 一致（不是 demo 数据）。
失败：看到 demo/假余额 → **立即停止**，检查 `DATA_SOURCE` 与地址；**禁止公告**。**可逆**：是。

---

## 7. 索引器引导（不做 = 全站 503）

### 7.1 触发首次索引

~~~bash
curl -s -X POST https://a9.lat/api/admin/indexer/tick \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
~~~

期望：返回 ok / 索引条数；`admin_events` 无 `INDEXER_TICK_ERROR`。失败：401 → `ADMIN_TOKEN` 错；RPC 错 → 查 `TONCENTER_API_KEY`。**可逆**：是（只读链上）。

### 7.2 确认 11 个 chain config key 落库

缺任一键，Worker 返回 `ORACLE_PAUSED`（health 200，但业务 API 503）——**这是保护，不是故障**。

~~~bash
curl -s https://a9.lat/api/health | jq '.data.oracle'
# 期望：paused=false，reason 为空/缺键列表为空
~~~

必须存在的 11 键：`p0_usd_e8`、`round_reward_raw`、`total_supply_raw`、`min_stake_raw`、`max_total_stake_raw`、`candle_count`、`candle_seconds`、`min_qualified_candles`、`observation_seconds`、`stake_duration_seconds`、`risk_disclosure_version`。

失败：仍报缺键 → 看 `admin_events` 的 `INDEXER_TICK_WARN/ERROR`；确认 `ROUND_CONTROLLER_ADDRESS` 正确、toncenter key 有效。**可逆**：是。

### 7.3 数据一致性

~~~bash
curl -s https://a9.lat/api/config | jq
curl -s https://a9.lat/api/rounds | jq '.[0] // .data[0]'
~~~

期望：`/api/config` 的 14 个参数与 `get_protocol_config` 一致；`/api/rounds` 与 `get_round` 逐字段一致。失败：先修索引器，**不要对外公告**。**可逆**：是。

---

## 8. 开 R1（R1 无 PREVIEW，管理员手动开轮）

### 8.1 `twap24hUsdE8` 来源（必须事先定死，不能临时拍）

按 docs/07 §9.1 / runbook 07 §9.1：
1. 取主网流动性池开盘后**连续 24 个整点的 TWAP 中位数**；不足 24 小时用开盘以来全部整点；
2. 开盘不足 1 小时/样本不足 → **不允许开轮**，等够数据；
3. **双人独立计算**，结果一致才可用；不一致 → 停止排查；
4. 把 twap 值、采样区间、数据来源、计算人、复核人写入 `$OPS_RECORDS_DIR/r1-twap-approval.md`；
5. 开轮后回读 `get_round(1).targetPriceUsdE8`。

### 8.2 开轮命令

~~~bash
cd /Users/yu1/Desktop/BAM
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<admin> \
  node ops/scripts/80_admin_ops.mjs --action open-round --round 1 --twap24h <USD_E8> \
  2>&1 | tee "$OPS_RECORDS_DIR/open-r1.log"
~~~

期望：tx 成功；事件 `TargetPriceSet`；`get_round(1)` 的 `targetPriceUsdE8 == max(2*twap, 232000)`，`stakeOpenAt == now`（R1 无 PREVIEW），`stakeCloseAt == stakeOpenAt + 129600`。
失败：target 不符 → 见 docs/02 开窗语义/立即停止并公告；**R1 失败不可重开**（终态不可逆）。**可逆**：否。

### 8.3 开轮后 30 分钟检查

~~~bash
curl -s https://a9.lat/api/rounds | jq '.[0] // .data[0]'
curl -s https://a9.lat/api/health | jq '.data.oracle'
~~~

期望：round1 `STAKING_OPEN`；target 与链上一致；health `paused=false`。失败：立即停止报名宣传，排查后再公告。**可逆**：部分（可 Pause）。

---

## 9. 上线后 24h 检查清单（R1 开轮起）

| 时间 | 检查 | 命令 | 通过标准 | 失败动作 |
| --- | --- | --- | --- | --- |
| 每小时 | K 线推进 | `curl -s https://a9.lat/api/rounds \| jq '.[0].candlesSeen'` | 每小时 +1，24 根齐备 | 停止宣传；查 keeper/RPC；P1 |
| 每小时 | 观察状态 | 同上 `observationStart/observationEnd` | 与链上一致；结束时间 = 开始 + 86400s | 立即 Pause + 排查 |
| 每小时 | 索引器 | `curl -s https://a9.lat/api/health \| jq '.data.oracle'` | `paused=false` | 触发 tick；仍失败 → P0 |
| 每 10 分钟 | monitor | `node ops/scripts/monitor_check.mjs`（指向生产） | 无 P0/P1 | P0 立即停轮 |
| 每 10 分钟 | 对账 | `node worker/src/indexer/tools/chain-reconcile.mjs --network mainnet ...` | DIFFS=0 | 非 0 → 停止写操作 |
| 每笔结算 | 三笔销毁/释放 | 事件 + `get_round` | reward/team/principal 标志与金额正确 | 立即 P0 |
| 每天 | 告警通道 | Telegram/邮件测试 | 5 分钟内收到 | 修复通道 |
| 24h 末 | 复盘 | 汇总 §0.4 证据 | 无未解释异常 | 出复盘报告 |

---

## 10. 回滚与止血

### 10.1 可回滚

| 对象 | 命令 | 注意 |
| --- | --- | --- |
| Worker | `wrangler rollback --env production`（或 `wrangler deployments list` 选上一版） | 只能回代码，**不能回链上状态** |
| D1 | `wrangler d1 export a9-mainnet --remote --output backup.sql`（事前）；恢复用 `wrangler d1 execute --file` | 只回数据；若链上已产生新轮次，恢复会不一致，需人工对账 |
| 域名/DNS/证书 | Cloudflare 面板 | 不影响合约 |

### 10.2 不可逆（写进事故模板）

- 合约部署地址 / code hash / 5 个 hash；
- admin 写入（`InitController`、`SetJettonWallet*`、`SetTeamWalletJettonWallet`）；
- A9 注资/分配、销毁、奖励释放；
- 已开轮的目标价与轮次状态（终态不可逆）。

### 10.3 止血手册

| 事件 | 立即动作 | 后续 |
| --- | --- | --- |
| 预言机/价格异常 | `80 --action pause-oracle` → 公告 | 排查 → `resume-oracle`；必要时 `abort-technical` |
| Worker 被攻击/异常 | `wrangler rollback` + 关闭写接口（维护页/401） | 保留日志、重置 `ADMIN_TOKEN` |
| 资金错投/多余转账 | **立即停止所有签名** | 按 runbooks/03 升级；**不要二次转账“补救”** |
| 索引器数据错 | 停写、重跑 reconcile/tick | 以链上为唯一真源修数据 |
| 轮次卡死 | 用合约内逃生舱（到期任何人关窗、SETTLING_* 任何人推、观察超时 Abort） | 公告 + 复盘 |

### 10.4 事后

保存 `$OPS_RECORDS_DIR` 全量证据；24h 内出事故复盘；若涉及合约，只能**重新部署新实例**（RC 不可升级），并重新走本文件。

---

## 附录 A：TON → GRAM 口径（给运营/前端/客服）

- **TON**：链上 gas 与部署费；不参与任何价格/分配计算；用户质押/领取需自备 TON（建议 ≥0.5 TON，UI 提示）。
- **GRAM**：价格锚；`1 GRAM = 1000 A9`；内盘只收 GRAM；P0 = `GRAM 实时价 / 1000`（USD_E8，部署时确定；当前占位 116000）。GRAM 是 TON 链上 Jetton，master 地址以项目方提供的为准；deployer 需 ≥5 GRAM（G6）。
- **A9**：唯一业务单位；所有奖励/额度以此计。
- 公告/客服话术：只写 A9 数量与“gas 用 TON”；**不得**把 TON 写成参与货币，也不得承诺 GRAM/A9 价格。
- R1 目标：`max(2 × twap24hUsdE8, 232000)`；twap 由 GRAM 价换算，双人复核留档。

## 附录 B：部署证据与签字

~~~text
代码：v8.8-audit-fixed @ fb6bb45（177 tests / 18 files，acton check 0/0）
5 个 hash：见 §4.2（与 docs/28 §5 一致）
D1：a9-mainnet / database_id=____________
合约地址：JM=____ OA=____ TV=____ RC=____ RCwallet=____ TVwallet=____
admin 冷钱包：____________（首尾6 + CRC：____ / ____）
treasury：____________　内盘：____________（公开）
注资 tx：RC=____ TV=____ 内盘=____ 流动=____ 营销=____
Worker 版本：____　CI run：____
R1 twap：____（USD_E8）　target：____　计算人/复核人：____ / ____
~~~

签字：部署负责人 ____　复核人（双人）____ / ____　日期 ____

> 本文件写完不等于可上线：§1 全绿 + 本页签字 + `verify_deployment --online` STRICT 全 PASS，才允许开 R1。
