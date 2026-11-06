# 29 — 主网切换包（MAINNET CUTOVER）

**版本**：V1.0 · 2026-11-06
**代码基线**：tag `v8.8-audit-fixed` @ `fb6bb45`（`git rev-parse v8.8-audit-fixed^{}` = `fb6bb45`）；`acton check` 0 error 0 warning；`acton test` **177 passed / 18 files**。
**定位**：本文件不是概念说明，而是**主网切换的可执行清单**。每一步都写清「命令 / 期望输出 / 失败怎么办 / 是否可逆」。

> **当前状态：不是上线许可。** §1 的门禁尚未全部满足（特别是 G0 主网 ops 适配、G0b 生产 D1 隔离、G2 生产时序（待 11/9 03:37 三项断言落地）、G5 admin 热钱包、G6 GRAM 到账、G7 TON 预算）。未满足项**禁止开始**；不要在聊天里用“已确认/没问题”替代链上证据。

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
| **G1** | **审计复核通过（M4.1 + M4.2）** ✅ **已完成** | `docs/28`（M4.1，v8.8）+ `docs/32`（M4.2，v8.9） | **M4.1：PASS（附 1 项 Medium，已修）**；**M4.2：PASS（无条件通过）**，复核方同意以 **`v8.9-audit-fixed`** 为主网冻结基线，并同意缺陷定级为 Low | 已完成，无需操作 | 是（已通过） |
| **G2** | **生产时序验证（prodtest v8.7 实例）** | v8.7 prodtest **RC `kQDmIKscJAg29SKiBo23j6nR6whklaoMBM7wQ3jVQGGS9gxY`**；证据 `$OPS_RECORDS_DIR/timing-evidence.json` + 下表时间点断言 | **待 11/9 03:37 三项全部落地后转 PASS**：①`stakeCloseAt−stakeOpenAt==129600`（已验）；②**11/8 03:35 关窗**后 `observationEnd−observationStart==86400`；③**11/9 03:37 结算后、R2 被 OpenRound 之前**读 `R2.stakeOpenAt−R1.settledAt` **必须精确 ==43200**（12h 预告期）；若已 OpenRound 则只能断言 `>=43200`（A9-F9 会把 stakeOpenAt 重锚为实际开轮时间，实测偏差=keeper 的 settle-wait） | 任一不等 → 停止；**不得改参数迁就**；11/9 03:37 后仍缺证据 → G2=FAIL | 是（未上主网） |
| **G3** | **CI 生产门禁生效** | `.github/workflows/ci.yml` 中 production guard 代码 + 最近一次 CI run URL | `DATA_SOURCE=chain`、`CHAIN_NETWORK=mainnet`、`DEMO_ALLOW_UNSIGNED_WRITES=false`、地址非占位符，否则 fail | 门禁缺失 → 停止；先修 CI 并跑一次 dry-run | 是 |
| **G4** | **toncenter 主网 key 可用** | `curl -s -H "X-API-Key: $TONCENTER_API_KEY" "$A9_MAINNET_RPC/getAddressInformation?address=$ADMIN_ADDRESS"` | HTTP 200，`ok:true`，无限流 | 401/429 → 换 key/加配额；**不得不带 key 硬跑** | 是 |
| **G5** | **admin 热钱包地址已定**（D-41） | acton keystore 地址 + 双人核对记录（首尾 6 字符 + CRC，§3.3） | 地址固定；钱包 `seqno=0`（新钱包）；私钥在跳板机、助记词离线 ≥2 份；**只放 ~2 GRAM gas** | 不符 → 停止；**部署后 admin 永久不可改** | **否（部署后）** |
| **G6** | **主网 GRAM 已到 deployer（≥9 GRAM）** | 查 deployer 的 GRAM 余额 | **≥9 GRAM**（预算 8.20，见下表）；< 8.2 → 停止 | 未到账 → 停止，先转够；**不要用测试网 GRAM** | 是（转账可再操作） |
> **主网 GRAM 预算表（v8.8 实测推导）**
>
> | 项 | GRAM | 说明 |
> | --- | --- | --- |
> | 合约部署初始余额 | **2.30** | JM 0.15 / OA 0.15 / TV **1.0** / RC **1.0**（TV 需覆盖 10 轮 jetton 转账；RC 会从 keeper 与 claim 的回流中增长，TV 不会） |
> | 铸造 tonAmount | 0.55 | forward 低于 0.35 会导致 admin jetton wallet 未部署（已实测 exit 678） |
> | wiring 6 条 | 0.36 | 每条 0.06 |
> | A9 分配 3 笔 | 0.60 | 每笔 0.2（内盘 8亿 / 流动 5亿 / 营销 5亿）；**RC/TV 由部署脚本自动注资，另 2 笔已含在合约部署费用里，勿重复** |
> | deployer 作业余量 | 1.00 | 开轮 / 关窗 / 结算 / 重试 |
> | 缓冲 | 1.00 | 429 重试、失败重放 |
> | admin 钱包 gas（**D-41 新增**） | 2.00 | mint + 3 笔分发 + 后续开轮/喂价；只放 ~2 GRAM，不放资产 |
> | **合计** | **8.20** | 建议备 **9 GRAM**（deployer 部分按 6.20 预算，各项明细合计 5.81，余量作缓冲；+admin 2.00 = 8.20） |
>
> **不要照抄早期估计的 30 GRAM**：那是按「RC 20 / TV 10」的极端保守值算的，与 v8.8 实测不符，会无谓推迟上线。
| **G7** | **GRAM 预算已批准（8.20 GRAM）** | 上表逐项签字 | 合计 8.20，建议备 **9** | 不足 → 停止补足；**不要把 mint 的 tonAmount 压到 0.55 以下** | 是（充值） |
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
wrangler whoami
~~~

期望：输出 `database_id`；`wrangler whoami` 显示正确账号。

> ⚠️ **不要手写顶层 `[[d1_databases]]`（那是 demo 库）。** 生产绑定在 `worker/wrangler.toml` 的 **`[[env.production.d1_databases]]`**，仓库里是**全 0 占位符**；部署前由 CI 从 GitHub Variable **`PROD_D1_DATABASE_ID`** 注入（`.github/workflows/ci.yml` 的 “Inject production D1 database id” 步骤）。把新库 ID 填进 **`PROD_D1_DATABASE_ID`**，不要改顶层。

失败：名称冲突/权限不足 → 换名或检查账号；**不得复用测试库**。
**可逆**：是（库可删，尚未接入生产 Worker）。

### 2.2 migrations 守卫 + apply（**绝不执行 seed.sql**）

~~~bash
cd worker
ls migrations | sort
for f in migrations/*.sql; do case "$(basename "$f")" in [0-9][0-9][0-9][0-9]_*.sql) ;; *) echo "BAD: $f"; exit 1;; esac; done
# 主网：必须显式 --env production，否则会按顶层 demo 绑定解析
wrangler d1 migrations apply DB --remote --env production
# 彩排（drill）：用 drill 配置
# wrangler d1 migrations apply DB --remote --config wrangler.drill.toml
~~~

期望：`ls` 恰好 `0001_init.sql` … `0009_chain_indexer.sql`；apply 只列这 9 个，0 报错；命令里必须出现 **`--env production`**（彩排为 `--config wrangler.drill.toml`）。
失败：出现非编号文件 → **立即停止**，移出 migrations 后重跑；**绝不执行 seed.sql**。
**可逆**：是（删库重建；尚未有业务数据）。

### 2.3 验证空库

~~~bash
wrangler d1 execute DB --remote --env production --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
wrangler d1 execute DB --remote --env production --command "SELECT COUNT(*) AS rounds FROM rounds;"
wrangler d1 execute DB --remote --env production --command "SELECT COUNT(*) AS trades FROM trades;"
wrangler d1 execute DB --remote --env production --command "SELECT COUNT(*) AS claims FROM claims;"
wrangler d1 execute DB --remote --env production --command "SELECT COUNT(*) AS stakes FROM stakes;"
~~~

期望：表存在；`rounds=0`、`trades=0`、`claims=0`、`stakes=0`、`burn_ledger=0`。
失败：任何业务表非空 → **停止**（可能灌入了 seed/demo 数据）；记录表名与行数，不得“先上线再清”。
**可逆**：是（清库/重建）；但若已有数据，**先导出备份**。

### 2.4 备份 + 恢复（**两阶段**；上线前一次 + 首次开轮前一次）

> **默认单文件 `wrangler d1 export` 不能直接恢复**：它按字母序输出，INSERT 会先于 CREATE TABLE 执行，FK 报 **`no such table: main.rounds`**。必须**结构（schema）+ 数据（data）分开导出**，恢复时分两阶段、且数据阶段关 FK。
>
> **恢复目标必须是新建库（`a9-mainnet-restore`）；绝不在生产库上直接灌。**
>
> 彩排实测（49KB 库）：export **7s** / schema 恢复 **5s** / data 恢复 **5s**。主网开轮后库会长大，按实际体积估算耗时与磁盘。

**备份时机（两次，必须都做）**：① 上线前；② **首次开轮前**（最容易忘——那时大家都在盯接口）。

~~~bash
# === 备份（结构 + 数据分开） ===
wrangler d1 export a9-mainnet --remote --env production \
  --output=backup-$(date +%Y%m%d-%H%M)-schema.sql --no-data --skip-confirmation
wrangler d1 export a9-mainnet --remote --env production \
  --output=backup-$(date +%Y%m%d-%H%M)-data.sql --no-schema --skip-confirmation
ls -lh backup-*.sql && wc -l backup-*.sql
shasum -a 256 backup-*.sql >> "$OPS_RECORDS_DIR/backup.sha256"

# === 恢复演练（必须两阶段；数据阶段关 FK；目标=新建库） ===
{ echo 'PRAGMA foreign_keys=OFF;'; cat backup-*-data.sql; } > backup-data-fkoff.sql
wrangler d1 create a9-mainnet-restore
wrangler d1 execute a9-mainnet-restore --remote --env production --file=backup-*-schema.sql
wrangler d1 execute a9-mainnet-restore --remote --env production --file=backup-data-fkoff.sql
# 验证：关键表行数 / total_supply / 最新 round；确认 restore 库数据完整后再删除
wrangler d1 execute a9-mainnet-restore --remote --env production --command "SELECT COUNT(*) AS rounds FROM rounds;"
~~~

期望：两个备份文件都非空（行数 >0）；schema 含 `CREATE TABLE`、data 含 `INSERT`；恢复库表结构与关键行数一致。
失败：默认单文件 export 直接恢复报 FK 错 → 改用上面的两阶段；data 阶段未关 FK → 先 `PRAGMA foreign_keys=OFF;`；恢复库行数不符 → 停止，不得切生产。
**可逆**：备份/恢复库本身可删；**生产数据删除不可逆**。

> 命令里的 `a9-mainnet` 是 Cloudflare 数据库名；若 `wrangler.toml` 的 `database_name` 不同，换成配置里的名字（或统一用 `DB --env production` 绑定）。

---

## 3. 密钥仪式（主网全新，严禁复用测试网）

> **D-41（2026-11-06 变更）**：**主网 admin 改为「服务器专用热钱包」**（D-36 的冷钱包部分**推迟到 OA 迁移**）。
> **原因**：keeper 每小时经 `fast_candle.tolk` 用 `A9_SIGNER_WALLET` 直接签 `SubmitCandle`；**acton 不支持硬件钱包签名**，仓库里也没有 OA 的签名提交工具。**admin 若是硬件冷钱包，keeper 一根 K 线都发不出去。** 这是已接受的取舍。

### 3.1 角色与用途

| 角色 | 用途 | 是否上链 | 地址是否公开 |
| --- | --- | --- | --- |
| deployer | 部署/注资签名（acton 钱包） | 是（发交易） | 不公开 |
| **admin** | RC / TV / OA 的唯一 owner（**D-41：服务器专用热钱包，acton keystore**） | 是（写 admin） | 不公开 |
| treasury | 接收 100 亿 mint，A9 分发来源 | 是 | 不公开 |
| team / marketing / liquidity | 收款热钱包 | 是（收款） | 不公开（团队内盘钱包除外） |
| internal | 团队内盘管理钱包（未售/撤回内盘） | 是 | **公开可查** |

### 3.2 生成与备份

- deployer / treasury / team / marketing / liquidity / internal：**离线机器 + 硬件钱包/冷钱包**生成，全新助记词，**禁止复用测试网任何 mnemonic/私钥**；
- **admin（D-41）**：部署时在**运维跳板机**上新建 **acton keystore 钱包**：

~~~bash
acton wallet new --name a9-admin        # 生成后记下地址；助记词离线备份 ≥2 份
acton wallet list                       # 确认地址（部署后才能用 A9_SIGNER_WALLET 指定）
~~~

- admin 钱包**只放 ~2 GRAM 做 gas**（mint + 3 笔分发 + 后续开轮/喂价），**不放任何资产**；
- 助记词离线备份 ≥2 份、异地存放；但**私钥在服务器上**——这是 D-41 已接受的取舍；
- 其余角色助记词离线抄写 ≥2 份；密码管理器只存**地址与标签**，不存助记词；
- 环境变量（不落盘、不进命令历史）：`TON_DEPLOYER_WALLET`、`TON_DEPLOYER_MNEMONIC`、`TON_ADMIN_OWNER_ADDRESS`、`TON_TREASURY_ADDRESS`；收款地址由 registry 登记。

**期望**：7 个地址（deployer / admin / treasury / team / marketing / liquidity / internal）全部生成并记录。
**失败**：复用/混用 → 停止，重新生成；admin 用硬件钱包 → 停止（keeper 发不出 K 线）。**可逆**：是（尚未上链）；一旦部署后 admin 永久不可改。

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

### 3.4 admin 服务器热钱包硬性要求（D-41：D-36 冷钱包推迟到 OA 迁移）

- admin 私钥在**运维跳板机**上（acton keystore），**不与公开服务/worker 同机**；
- 跳板机：**SSH key-only、禁用密码登录、最小权限**；仅部署/运维账号可登；
- **监控 admin 地址的任何出账（发消息）并告警**——这是唯一能发现密钥被盗的方式；
- **每周**核对 admin 钱包 nonce 历史与链上 admin 配置未变；
- **部署后 admin 永久不可改（无 SetAdmin）；密钥泄露即永久失控，无补救路径**；
- 部署前检查该地址 `seqno=0`（新钱包天然为 0）：

~~~bash
curl -s -H "X-API-Key: $TONCENTER_API_KEY" "$A9_MAINNET_RPC/getWalletInformation?address=$ADMIN_ADDRESS" | jq
~~~

期望：`seqno` 为 0（或钱包未初始化、无历史交易）。失败：有历史交易 → 不是新钱包 → 停止更换。**可逆**：部署前是。

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

> **当前主网冻结基线：`v8.9-audit-fixed`**（RC `0xFE7088ED1C52949CD1CB0931D95911F757BC402FC37065502002DF15CCDD50AE`，179 tests）。v8.8 见 `docs/28 §5`、v8.9 见 `docs/32 §4` 与 `docs/18 §18`。仅 RoundController 逐版变化，其余 4 个合约哈希自 v8.6 起未变。

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
4. admin 服务器热钱包（acton keystore）地址已双人核对；
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

**第一步：主网 toncenter 独立确认合约 active（防止 --net 选错发到测试网）**

~~~bash
# 取第一个已部署合约（JettonMaster）；--net 错误时主网不会存在该地址
JM=$(jq -r '.contracts.jettonMaster.address' "$OPS_REGISTRY")
curl -sS -H "X-API-Key: $TONCENTER_API_KEY" "https://toncenter.com/api/v2/getAddressInformation?address=$JM" | jq -e '.ok == true and .result.state == "active"'
~~~

期望：返回 true（主网链上 active）。失败：**立即停止**——这通常意味着部署被发到了测试网或合约未生效；记录后按 §4.4 重部署，绝不继续开轮。

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

## 5. A9 分配（部署脚本已注资 RC/TV；本节只做剩余 3 笔）

### 5.1 铸造去向

- mint-once 把 100 亿铸给 **treasury**（`TON_TREASURY_ADDRESS`，部署者冷钱包）；
- 若项目方决定先铸给 **admin 服务器热钱包（D-41）** 再分发：把 treasury 换成 admin 地址，**必须双人签字**；两种方式都只能选一种，不能重复 mint；
- 铸造后 `total_supply == 1e19` 且 `mintable == false`。

### 5.2 三笔分配（**RC/TV 由部署脚本自动注资，勿重复**）

> ⚠️ **先看这条**：`deploy-emulation.tolk` **无条件**把 **RC 注资 70 亿、TV 注资 12 亿**（脚本内 `PARAM_ROUND_REWARD * 10` / `PARAM_TEAM_ROUND * 10`，并在注资后用 `get_wallet_data` 做精确余额断言——就是 dry-run 里 `Funded RC Jetton Wallet` 那行）。
> 因此 **§5.2 只处理剩余 3 笔**；若再给 RC/TV 发一遍，admin 只剩 18 亿，签名交易会直接失败（即使不失败也会重复注资，不可回滚）。
>
> | 接收方 | owner | 金额（A9） | raw |
> | --- | --- | --- | --- |
> | 团队内盘管理钱包 | internal（公开可查） | 8 亿 | `800000000000000000` |
> | 流动性钱包 | liquidity | 5 亿 | `500000000000000000` |
> | 营销钱包 | marketing | 5 亿 | `500000000000000000` |
>
> ```bash
> cd /Users/yu1/Desktop/BAM
> # --resume：按链上余额跳过已注资的 RC/TV，只发剩余 3 笔；不要去掉 --resume
> OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<admin/deployer> \
>   node ops/scripts/50_fund_vaults.mjs --execute --all --probe --resume 2>&1 | tee "$OPS_RECORDS_DIR/50_fund.log"
> ```
>
> 期望：日志显示 RC/TV 因余额已达标被 **skip**；只发 3 笔（内盘 8 亿 / 流动 5 亿 / 营销 5 亿），每笔 `get_wallet_data` 增量精确匹配；admin A9 归零。
> 失败：若日志显示要给 RC/TV 转账或报余额不足 → **立即停止**，说明 deploy 脚本没注资或参数错，回 §4 检查；**不要手工补 RC/TV**。
> **可逆**：**否**。

### 5.3 逐笔回读（必须做）

~~~bash
# 对 3 个目标钱包逐个执行；期望余额等于上表 raw
acton rpc info <JETTON_WALLET_ADDRESS> --net mainnet   # 先确认 active
# 或用 toncenter v3 读 get_wallet_data 第 0 槽
curl -s -H "X-API-Key: $TONCENTER_API_KEY" \
  "$A9_MAINNET_RPC/runGetMethod" -H "Content-Type: application/json" \
  -d "{\"address\":\"<wallet>\",\"method\":\"get_wallet_data\",\"stack\":[]}" | jq
~~~

期望：3 个钱包余额 = 上表 raw；**另回读 RC=7e18、TV=1.2e18 作为部署脚本断言复核**；`total_supply` 仍为 1e19；admin 钱包 A9 余额 = 0（或项目方书面保留的 gas 额度）。
失败：差额 → 停止，按 §5.4 处理；**不要重复整笔转账**。**可逆**：否。

### 5.4 `exit code 33` / seqno 冲突处置（写在值班卡上）

1. **先判“钱有没有动”**：读取 **3 个待发钱包** + **RC/TV 余额**（应为 7e18 / 1.2e18）+ admin A9 + deployer TON 余额；
2. **全 0 / 完全没动** → 可重试同一命令**一次**（先确认 seqno 已更新/节点回读一致）；
3. **部分到账** → 计算差额，用单笔模板手工补：

~~~bash
cd contracts
OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=<signer> JETTON_MASTER_ADDRESS=<jm> \
  acton script --net mainnet scripts/deploy/fund_jetton.tolk <recipientOwner> <remainingRaw>
~~~

4. **补完必须回读**：`get_wallet_data` 余额精确等于目标；
5. **绝不允许**“整笔重发”或“用 50 脚本再跑一遍全额”；`50 --resume` 只在确认余额后使用（它会按余额跳过已达标项）。

> 期望：最终 3 个钱包余额精确匹配，RC/TV 仍为 7e18 / 1.2e18；失败：仍不匹配 → 停止所有签名，按 runbooks/03 升级。**可逆**：否。

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

在 GitHub → Settings → Variables 设置 **5 个**：

| Variable | 值 | 时点 |
| --- | --- | --- |
| `PROD_ROUND_CONTROLLER_ADDRESS` | RC 地址 | 合约部署后 |
| `PROD_TEAM_VAULT_ADDRESS` | TV 地址 | 合约部署后 |
| `PROD_JETTON_MASTER_ADDRESS` | JettonMaster 地址 | 合约部署后 |
| `PROD_ORACLE_CONFIG_HASH` | oracle config hash | 参数初始化后 |
| **`PROD_D1_DATABASE_ID`** | **建库后得到的 a9-mainnet database_id** | **§2.1 建库后立即填** |

期望：5 个变量存在且非占位符。失败：缺 `PROD_D1_DATABASE_ID` 或任一地址 → CI 门禁**直接 fail**；**不要 `allow_demo_deploy=true`**。**可逆**：是。

### 6.3 部署（**推荐走 CI**；必须 `--env production`）

> 手工 `wrangler deploy` 不会执行 CI 的 “Inject production D1 database id”，会把**全 0 占位符**当生产 D1 部署。因此**主网推荐用 CI workflow_dispatch**：
>
> ```bash
> gh workflow run ci.yml --ref main -f allow_demo_deploy=false
> gh run watch
> ```
>
> CI 顺序：Inject production D1 database id（`PROD_D1_DATABASE_ID`）→ production gate → migrations → deploy `--env production`（地址由 4 个 Variables 经 `--var` 注入）。
>
> **仅当 CI 不可用时才手工**，且必须先复用 CI 的注入步骤（`.github/workflows/ci.yml:236-259`）把 `[[env.production.d1_databases]]` 的占位符替换为真实 ID；否则禁止部署。

~~~bash
# 手工等价（仅兜底；先完成 D1 注入！）
pnpm -C web build
cd worker
wrangler deploy --env production \
  --var ROUND_CONTROLLER_ADDRESS:"$PROD_ROUND_CONTROLLER_ADDRESS" \
  --var TEAM_VAULT_ADDRESS:"$PROD_TEAM_VAULT_ADDRESS" \
  --var JETTON_MASTER_ADDRESS:"$PROD_JETTON_MASTER_ADDRESS" \
  --var ORACLE_CONFIG_HASH:"$PROD_ORACLE_CONFIG_HASH" \
  2>&1 | tee "$OPS_RECORDS_DIR/worker-deploy.log"
~~~

期望：CI 生产门禁通过（`DATA_SOURCE=chain` / `CHAIN_NETWORK=mainnet` / `DEMO_ALLOW_UNSIGNED_WRITES=false` / 地址与 D1 已注入），输出新版本号。
失败：门禁 fail → 按日志修配置，**不要回滚到 demo**；D1 绑定错 → 检查 `PROD_D1_DATABASE_ID` 与 `[env.production.d1_databases]`。**可逆**：是（Worker 可 rollback）。

### 6.4 验证（只验 health / version；config 与 rounds 在 §7.3）

~~~bash
curl -s https://a9.lat/api/health | jq
curl -s https://a9.lat/api/version | jq '.data.schemaVersion // .schemaVersion'
~~~

期望：`health ok`；`schemaVersion=9`；`version` 与部署 sha 一致。

> **引导前 `/api/config` 与 `/api/rounds` 返回 503 `ORACLE_PAUSED` 是正确的保护语义**（11 个 chain config key 还没落库）；不要把它当故障，**不要**在 §6.4 用它们判失败。二者统一在 **§7.3**（索引器引导之后）验证。

失败：health 非 200 / schemaVersion≠9 → **立即停止**，查 `DATA_SOURCE`、D1 注入与地址；**禁止公告**。**可逆**：是。

---

## 7. 索引器引导（不做 = 全站 503）

### 7.1 触发首次索引（**预留 ≥180s**）

~~~bash
# 必须带 key；公共 toncenter 无 key 本次实测 76.7s，主网要预留 ≥180s
time curl -sS --max-time 180 -X POST https://a9.lat/api/admin/indexer/tick \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | {ok,pages,writes,events,candles,stakes,healthy,nextPollMs}'
~~~

期望：HTTP 200；`data.ok=true`、`healthy=true`；`pages/writes/events/candles/stakes` 有数值；`nextPollMs` 正常。

> 返回是**嵌套结构**：`data.{ok,pages,writes,events,candles,stakes,healthy,nextPollMs}`（不是顶层字段）。
> 本次彩排（公共 toncenter、无 key）耗时 **76.7s**；主网**必须配 `TONCENTER_API_KEY`**，并预留 **≥180s**，否则会超时被误判失败。
> **`/api/admin/indexer/health` 不存在（实测 404）**；不要引用该路由。缺键只看 `/api/health.data.oracle.reason` + D1 `config` 表。
> **`SubmitCandle` 不依赖发送方**：索引器按 `account=RC` 拉交易、只按 opcode 解码，**没有 sender 判断**；主网接入 OracleAdapter 后不会漏 K 线（backend-dev 已确认）。

失败：401 → `ADMIN_TOKEN` 错；超时 → 配 key 后**重试一次**并加大 `--max-time`；`healthy=false` → 看 `admin_events` 的 `INDEXER_TICK_WARN/ERROR`。**可逆**：是（只读链上）。

### 7.2 确认 11 个 chain config key 落库（表名是 **`config`**，不是 `metrics`）

缺任一键，Worker 返回 `ORACLE_PAUSED`（health 200，但业务 API 503）——**这是保护，不是故障**。

~~~bash
cd worker
wrangler d1 execute DB --remote --env production --command \
  "SELECT key FROM config WHERE key IN ('p0_usd_e8','round_reward_raw','total_supply_raw','min_stake_raw','max_total_stake_raw','candle_count','candle_seconds','min_qualified_candles','observation_seconds','stake_duration_seconds','risk_disclosure_version');"
curl -s https://a9.lat/api/health | jq '.data.oracle'
~~~

期望：`config` 表返回 **11 行**；health `paused=false`、`reason` 为空。

> ⚠️ **别查 `metrics` 表**：11 个 chain config key 在 **`config`** 表；按 `metrics` 查会误判“缺键”。

失败：缺行 → 看 `admin_events` 的 `INDEXER_TICK_WARN/ERROR`；确认 `ROUND_CONTROLLER_ADDRESS` 正确、toncenter key 有效。**可逆**：是。

### 7.3 数据一致性（索引器成功后**才**验 `/api/config` 与 `/api/rounds`）

~~~bash
curl -s https://a9.lat/api/config | jq '.data | keys | length'
curl -s https://a9.lat/api/config | jq '.data.contracts'
curl -s https://a9.lat/api/rounds | jq '.[0] // .data[0]'
~~~

期望：`/api/config` 返回 **28 个顶层字段**；`/api/rounds` 与 `get_round` 逐字段一致（roundId/status/target/stakeOpenAt/stakeCloseAt）。

> **历史遗留键（不阻塞上线）**：`contracts` 里只有 `jettonMaster` / `roundController` / `teamVault` / `oracleConfigHash` 有值；`stakingVault`、`rewardVault`、`oracleAdapter`、`codeHash`、`adminOwner`、`teamWallet`、`auditReportUrl` 为 **null**（旧架构字段，当前架构不使用；`oracleAdapter` 目前无配置键写入，恒为 null，前端已按可选字段处理）。

失败：缺字段/503 → 回 §7.1/7.2；**不要对外公告**。**可逆**：是。

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
| D1 | `wrangler d1 export DB --remote --env production --output backup.sql`（事前）；恢复用 `wrangler d1 execute --file` | 只回数据；若链上已产生新轮次，恢复会不一致，需人工对账 |
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

## 11. 彩排发现的差异（2026-11-06）

> 来源：`ops/records/mainnet-rehearsal-diffs.md`（testnet-ops 彩排）+ 备份恢复演练。共 **12 条**（10 条文档不一致 + 1 条合约分配修正 + 1 条备份恢复缺陷），其中 **4 条会让主网当天直接失败**（①~④）。本节是主网前的审计痕迹，**不得删除**。

| # | 彩排发现（实际 vs 文档） | 处理 | 状态 |
| --- | --- | --- | --- |
| ① | D1 写法错误：文档让改顶层 `[[d1_databases]]`（demo 库）；实际生产在 **`[[env.production.d1_databases]]`**，仓库为全 0 占位符，CI 从 `PROD_D1_DATABASE_ID` 注入 | 改写 §2.1：只建库 + 填 GitHub Variable，**禁止改顶层** | 已修正到文档 |
| ② | 迁移命令缺 `--env production`（彩排 `--config wrangler.drill.toml`） | §2.2 改为 `wrangler d1 migrations apply DB --remote --env production`（彩排用 drill 配置） | 已修正到文档；**附：CI 的 migration 步骤仍写 `apply fuse-protocol --remote` 未带 `--env production`，需 CI 同步修**（流程调整） |
| ③ | GitHub Variables 少第 5 个：**`PROD_D1_DATABASE_ID`**（CI 门禁强制） | §6.2 补 5 个变量表，注明建库后立即填 | 已修正到文档 |
| ④ | 手工 `wrangler deploy` 不走 CI 的 “Inject production D1 database id”，会用占位符 D1 | §6.3 改为**推荐 CI workflow_dispatch**；手工仅兜底且必须先复用注入步骤 | 已修正到文档 |
| ⑤ | 验证顺序矛盾：引导前 `/api/config`、`/api/rounds` 是 503 ORACLE_PAUSED（正确保护） | §6.4 只验 `/api/health` + `/api/version`；config/rounds 移到 §7.3 | 已修正到文档 |
| ⑥ | `indexer/tick` 实际返回嵌套 `data.{ok,pages,writes,events,candles,stakes,healthy,nextPollMs}`；公共 toncenter 无 key 耗时 **76.7s** | §7.1 写嵌套结构；主网预留 **≥180s** 且必须配 key | 已修正到文档 + **流程调整（值班预留 180s/key）** |
| ⑦ | `/api/admin/indexer/health` **不存在（404）** | 删除引用；缺键只查 `/api/health.data.oracle.reason` + D1 `config` 表 | 已修正到文档 |
| ⑧ | 11 个 chain config key 在 **`config`** 表，不是 `metrics` | §7.2 改为查 `config` 表（11 行） | 已修正到文档 |
| ⑨ | `/api/config` 实际 **28 个顶层字段**；`contracts` 多个旧键为 null | §7.3 写明 28 字段 + 历史遗留键（stakingVault/rewardVault/oracleAdapter/codeHash/adminOwner/teamWallet/auditReportUrl 为 null，不阻塞；前端已可选处理） | 已修正到文档 |
| ⑩ | `d1 export` 未演练 | §2.4 标注“主网前必须单独验证 export 权限与产物大小” | **流程调整（主网前单独演练）** |
| ⑪ | §5.2 五笔分配错误：部署脚本已无条件注资 RC 70 亿 + TV 12 亿并精确断言 | §5.2 改为**三笔**（内盘 8 亿/流动 5 亿/营销 5 亿）+ 提示“重复注资必失败”；docs/33 step8 同步 | 已修正到文档 |
| ⑫ | **D1 备份未演练**：默认单文件 export 按字母序输出，恢复时 INSERT 先于 CREATE TABLE → FK 报 `no such table: main.rounds`，**有备份但恢复不了** | §2.4 改为**schema/data 分开导出 + 两阶段恢复（新建库、data 关 FK）**；docs/33 加 step 12.5「首次开轮前备份」；实测 export 7s / schema 5s / data 5s | **已修正到文档 + 流程调整（上线前+开轮前各备份一次）** |

> **签字**：以上 12 条已逐条处理；①~④ 为主网阻断项，必须在主网前一天复查。

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
admin 热钱包（keystore）：____________（首尾6 + CRC：____ / ____）
treasury：____________　内盘：____________（公开）
注资 tx：RC=____ TV=____ 内盘=____ 流动=____ 营销=____
Worker 版本：____　CI run：____
R1 twap：____（USD_E8）　target：____　计算人/复核人：____ / ____
~~~

签字：部署负责人 ____　复核人（双人）____ / ____　日期 ____

> 本文件写完不等于可上线：§1 全绿 + 本页签字 + `verify_deployment --online` STRICT 全 PASS，才允许开 R1。
