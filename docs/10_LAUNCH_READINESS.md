# 10 — 上线与运营剩余工作清单（Launch Readiness）

**版本**：V7.0 · 2026-11-05
**对应代码**：`web/`（React 前端）+ `worker/`（Cloudflare Worker API + D1）+ `shared/`（API 契约）
> **口径声明（V7.0）**：观察 **24h = 24 根 × 1h / 阈值 16（容错 8 根）**；目标价**开窗时锁定 `max(阶梯 P0×2^tier, 2×开窗 24h TWAP)`**；**95% 闸门与 7 天提档已取消**；**12h PREVIEW 预告期已确认**；保留触价提前关窗；单轮 3 天 / 10 轮 30 天；三个前端倒计时；分配 70/8+5/12/5；P0 = $0.00116；冷启动 2 亿 A9 + $232,000；2× 最终确认；不允许取消质押。与 docs/00 冲突以其为准。
>
> **结论先行**：**前端与后端服务层已经具备上线条件（演示数据模式）**；但协议本身的「主网可用」还差三大块硬工作——**智能合约+审计、预言机生产化、合规与经济模型冻结**。没有这三块，不得开放真实质押。

---

## 0. 当前状态盘点

| 层 | 状态 | 说明 |
| --- | --- | --- |
| 前端 UI（落地页 / 战况 / 指挥台 / 成交流 / 阶梯 / 沙盘 / 筹码 / 风险） | ✅ 已实现（V7：24 格 × 1h / 16 阈值） | React 19 + Vite + TS，视觉 1:1 还原原型，中英双语 |
| 应用页（我的战况 / 排行榜 / 运维后台） | ✅ 已实现 | 数据来自后端 API；文案从 `/api/config` 动态取值 |
| 前端接链（TON Connect 质押/领取） | ✅ 已实现（自研 Cell/BOC，与 `@ton/core` 字节一致） | 真实 payload：`StakeDeposit` 136bit / `ClaimAll` 104bit；含演示钱包兜底 |
| 后端 API（Cloudflare Worker + D1） | ✅ 已实现（演示数据源，V7 参数已上线） | 19 个端点，状态机、K 线推进、销毁账本、admin 审计；`/api/config` 下发 24 根/16 阈值/12h+36h+24h |
| 部署 | ✅ Cloudflare 单 Worker + D1 + 自定义域名 `a9.lat` / `www.a9.lat` | 已公网可访问（HTTPS）；cron `* * * * *` 驱动演示状态机 |
| 数据源抽象 | ✅ `sources/demo.ts` 完整 + `sources/chain.ts` 桩（8 条 TODO） | 切真链需实现 chain 适配器并改 `DATA_SOURCE=chain` |
| 智能合约 | ✅ 已实现（**未上链**） | `RoundController` + `TeamVault`（Tolk / Acton 1.1.0），47 个测试全绿，code hash 稳定；官方复用 Jetton（TEP-74） |
| 测试网链上部署 | 🟡 脚本与 runbook 就绪，**未执行** | 合约已齐（含 Tolk 版 TEP-74 Jetton Master/Wallet，65 测试）；缺 2 项：①测试网 TON（RC ≥20 / TV ≥10）②6 个收款地址与参数签字（见 §2.6） |
| 预言机生产服务 | ❌ 未开发 | 测试网用手动 K 线提交模式；文档 03 只给了数据格式与验证流程 |
| BurnAck 主网化（V6.3） | 🟡 测试网以 jettonMaster 为 ack 权威 | 主网前必须换为 burn ack 扩展或「标准 burn + 链下对账 + owner 确认」（docs/04 §7） |
| 审计 / 法务 / 经济模型冻结 | 🟡 审计待做；法务明确不做（D-34）；经济模型已冻结（2× + 100% 罚没 + V7 24h/24/16，通过率 0.01%~0.2%，EV 为负，已接受） | V7 已锁定全部参数；剩余 D-05~D-09、D-19、D-29 待定 |
| 运营体系（监控/值班/客服/透明页） | 🟡 脚本与手册完备，未实跑 | `ops/` 脚本 12 个 + runbook 5 份 + 模板 8 份，selftest 全绿；告警通道、值班、客服未建立 |

---

## 1. 上线阻断项（必须先由项目方书面确认）

来源：`docs/07_OPEN_DECISIONS.md`。下表按「谁决定 / 建议值 / 影响面」重新排过，**每项未确认 = 主网不得开放质押**。

| ID | 决策 | 建议默认值 | 影响 | 决策人 |
| --- | --- | --- | --- | --- |
| D-01 | 代币名称、符号 | ✅ A9 / A9（V3 已确认） | 前端、Jetton metadata、交易所申报 | 项目方 |
| D-02 | Jetton decimals | ✅ 9（V3 已确认） | 所有 raw 计算、前端换算、账本 | 项目方 |
| D-03 | P0 初始参考价 | ✅ $0.00116（USD_E8 = 116,000，1 GRAM=1000 A9，FDV $11.6M） | 十轮目标价全部由它推导 | 项目方+经济顾问 |
| D-04 | 预言机方案 | 🟡 测试网手动模式；主网前恢复 3/5 签名 | 决定成败判定可信度 | 技术负责人 |
| D-05 | 价格来源数量 | ⚠️ ≥3 个独立市场（主网） | 抗操纵能力 | 技术负责人 |
| D-06 | 最低流动性 | 按池深定，建议 ≥$500k | 防单池拉盘 | 经济顾问 |
| D-07 | 最低 4h 成交量 | 按市场规模定 | 有效性判定 | 经济顾问 |
| D-08 | 来源最大偏差 | 300 bps | 离群源过滤 | 技术负责人 |
| D-09 | TWAP 覆盖率 | ≥9500 bps（95%） | 数据质量 | 技术负责人 |
| D-10 | 质押报名期 | ✅ 72 小时（259,200 秒，V5 已确认；结算后立即开启） | 前端文案、合约参数 | 项目方 |
| D-11 | 单笔最低质押 | ✅ 10,000 A9（V6.1 已确认） | 防粉尘攻击 | 项目方 |
| D-12 | 单地址最大质押 | ✅ ≤ 本轮总质押 10%（V6.1） | 防单点巨鲸 | 项目方 |
| D-13 | 全轮最大质押 | ✅ 本轮总质押上限 200,000,000 A9（V6.1） | 财务风险 | 项目方 |
| D-14 | 奖励分配公式 | ✅ 纯质押比例（V3 已确认） | 核心经济规则 | 项目方 |
| D-15 | 社区贡献积分 | ✅ 已删除（V3） | 不再需要 ContributionRegistry | 项目方 |
| D-16 | 奖励归属/期限 | ✅ 一次性发放、无归属期（V3） | 领取合约逻辑 | 项目方 |
| D-17 | 成功后本金返还时点 | ✅ 终态后主动领取（V3） | claim 流程 | 项目方 |
| D-18 | 无人质押处理 | ✅ 照常启动观察（V3/V4）；0 人通过 → 7 亿奖励销毁（D-18b 已定） | 状态机分支 | 项目方 |
| D-19 | 预言机长期故障 | 暂停；14 天触发技术终止退款 | 极端情况资金安全 | 项目方+技术 |
| D-20 | 团队归属规则 | ✅ TeamVault 托管 12 亿；每轮 1.2 亿，成功释放 / 失败销毁（V5） | 团队额度释放/销毁 | 项目方 |
| D-21 | 营销金库管理 | ✅ 个人热钱包持有，无多签，地址不公开（V4/V5，风险接受） | 信任/托管 | 项目方 |
| D-22 | 内盘/流动性拆分 | ✅ 13% = 内盘销售 8%（8 亿）+ 流动性 5%（5 亿）（V5.5 定案） | 做市计划 | 项目方 |
| D-23 | 多签阈值 | ✅ 不设多签；单密钥 owner 权限最小化（V4，风险接受） | 治理/权限安全 | 项目方 |
| D-24 | 合约升级策略 | ✅ RoundController 不可升级；管理员仅最小权限（V5） | 审计范围 | 项目方+技术 |
| D-25 | 奖励领取方式 | ✅ pull claim：用户付 gas、跨轮累积、≤10 轮、合并一笔（V5） | 领取逻辑/是否自研 | 项目方+技术 |
| D-26 | 解锁窗口与目标价冲突 | ✅ **V6 已定案**：目标价开窗锁定 `max(阶梯, 2×24h TWAP)`；**取消 95% 闸门与 7 天提档**；保留触价提前关窗 | 目标价语义、状态机、合约参数 | 项目方+经济顾问 |
| D-27 | 开轮节奏/手动开轮/倒计时传播 | ✅ **V6 已定案**：结算→12h PREVIEW→自动开窗；不设常规手动开轮；三个前端倒计时；单轮 3 天/10 轮 30 天 | 开轮流程、状态机、前端倒计时 | 项目方+技术 |
| D-28 | 失败后目标价语义 | ✅ **V6.1 已确认**：失败同档重试、成功升档；tier = 1 + 已成功轮数；10 轮 ≠ 10 档位 | 合约 targetPrice、状态机、前端阶梯 | 项目方+经济顾问 |
| D-29 | 首轮（R1）启动规则 | ⚠️ **V5 待确认**：**Lead 推荐 A**（R1 目标 = 1.3~1.5×上市基准 TWAP）；B 7天报名+预热；C 空跑 | 首轮目标、上线运营、合约参数 | 项目方+经济顾问 |
| D-30 | 搭便车/时间加权 | ✅ **V6.1 已确认**：第一版不做时间加权；保留后续可加 | 奖励权重、合约参数 | 项目方 |
| D-31 | 每轮倍数 | ✅ **2× 最终确认（V5.4）**，不再改动；docs/13 模拟风险记录保留 | 目标价阶梯、经济模型 | 项目方 |
| D-32 | 内盘/流动性比例 | ✅ **V5.5 定案**：内盘 8%（8 亿 A9）+ 流动性 5%（5 亿 A9）；8%+5%=13% 不变，奖励/团队/营销不变 | 分配表、奖励预算、销毁口径 | 项目方+经济顾问 |

**建议动作**：把本表复制成一份「参数决议书」，逐项签字，产出 `config/mainnet/params.json` 与其 SHA-256（即文档 07 §4 的「配置哈希」），部署前进 CI 校验、部署后公布。

---

## 2. 技术剩余工作（按依赖顺序）

### 2.1 智能合约（最大工作量，建议 4~6 周）

| 模块 | 工作内容 | 依赖 |
| --- | --- | --- |
| Jetton Master/Wallet | TEP-74 兼容 + 关闭 mint 或受限治理 + **burn acknowledgement 扩展**（用于链上确认销毁） | D-01/02 |
| RoundController | 10 轮状态机、目标价开窗锁定公式（V6）、12h PREVIEW、观察边界、24 根 K 线计数、结算触发、claimAll（≤10 轮有界） | D-03/10/26 |
| TeamVault | 托管 12 亿 Jetton Wallet（owner=TeamVault）；只接受 RC 指令；按轮 `ReleaseTeamQuota` / `BurnTeamQuota`，幂等互斥 | D-20 |
| StakingVault | 接收 Jetton 转账 + payload 校验（roundId/nonce/riskVersion）+ 账本 + 成功返还 + 失败销毁 | D-11/12/13 |
| RewardVault | 10 × 7 亿独立账本（合计 70 亿）+ claimAll 领取 + 失败销毁 + 余数留存 | D-14/16/25 |
| OracleAdapter | 签名校验、feedId/有效期/nonce/configVersion、暂停/恢复 | D-04~09 |
| 幂等与重试 | 每个外部动作唯一 operationId / burnId / claimId；bounce 处理；pending 状态机 | — |
| 测试 | 单元 + 集成 + fuzz + 不变量（docs/05 §2 的 28 条不变量全部要有 property test） | — |
| Testnet 演练 | 成功轮 + 失败轮 + 三笔销毁 + TeamVault 指令 + claimAll + 无人质押 + 预言机故障暂停恢复 | — |

工具链：Tolk + Acton（官方推荐），锁定编译器/工具链版本，CI 可重复构建；ABI 与前端类型从同一份定义生成。

### 2.2 预言机生产服务（2~3 周）

1. **数据采集器**：从 3+ 个白名单市场拉 4h 数据，计算 TWAP + 成交量 + 流动性 + 覆盖率（docs/03 §4）。
2. **签名服务**：多个独立签名方（非项目多签合约，建议 3/5 阈值）各自部署，对 `OracleCandle` 摘要签名；私钥在 HSM/KMS，不落代码仓库。
3. **提交器（keeper）**：任何人可提交，但需要有人跑；失败重试 + 监控。
4. **pause/resume 守护**：数据缺失/源不足自动 `PauseOracle`，恢复后重新收满 24 根。
5. **可复核数据**：每根 K 线落对象存储（R2），公开 dataDigest，任何人可复算。
6. 选型提醒：文档 08 列的是 TON 官方资料；**RedStone / Pyth 等第三方喂价在 TON 的可用性、签名格式、成本必须在选定前实际验证**，不能用「多源去中心化」话术代替实测。

### 2.3 后端从 demo 切真链（1~2 周）

现成接口已按链上字段设计，切换步骤：

1. 实现 `worker/src/sources/chain.ts`：
   - TON RPC 提供商（toncenter / 自建 liteserver）拉取合约状态与事件；
   - Indexer：解析 `RoundOpened / CandleRecorded / RoundSettled / BurnAcked / Claimed / TeamReleased / TeamBurned` 事件写 D1；
   - 对账任务：链上 total_supply、各金库余额与本地账本比对，不一致告警。
2. 改 `DATA_SOURCE=chain`，保留 demo 作为 staging 演示环境。
3. 加缓存层（KV / Cache API）：链上读取按 5~15s 缓存，避免打爆 RPC。
4. 前端无需改动（契约不变）；仅把「演示数据」徽标改为真实网络标识。

### 2.4 前端收尾

- TON Connect 从「只读」升级为「可发交易」：质押 payload 构造（`roundId / depositNonce / riskDisclosureVersion / acceptFullPrincipalBurn`）、boc 打包、钱包回执与状态刷新、失败重试。
- 用户风险确认与链上 payload 的版本号必须一致（`riskDisclosureVersion`）。
- 领取流程（V5 已定）：pull claim / `claimAll` —— MyPage 展示所有已结算轮次（含历史未领）可领金额，支持一次领取多轮（≤10 轮、合并一笔交易、用户付 gas）。
- SEO/i18n 细节：hreflang、structured data（可选）、OG 图随轮次更新。
- 可访问性：键盘操作、`prefers-reduced-motion`（原型 CSS 已有）、对比度复核。

### 2.5 Cloudflare 生产配置（半天，本次已起步）

| 项 | 建议 |
| --- | --- |
| 计划 | Workers Paid（$5/月起），D1 / Cron / 日志配额充足 |
| 自定义域名 | 绑定如 `fuse.example.com`；Cloudflare 代理开启（橙云） |
| 缓存 | 静态资源 `immutable` 强缓存；`/api/*` 不缓存或短缓存 |
| 限流 | WAF Rate Limiting 规则（`/api/stake`、`/api/claim` 10 req/min/IP）；机器人防护 |
| 管理后台 | 用 Cloudflare Access（Zero Trust）保护 `/admin`，叠加 token 双保险 |
| 安全头 | HSTS、CSP（注意 Google Fonts、TON Connect CDN 白名单）、X-Frame-Options |
| 可观测性 | Workers Logs + Analytics Engine；错误上报 Sentry（前端）；Uptime 探针 1min |
| 告警 | 5xx 率、API p95 延迟、cron 未执行、D1 写入失败、admin 登录异常 |
| 备份 | D1 每日导出到 R2（`wrangler d1 export`），保留 30 天 |
| 密钥 | `ADMIN_TOKEN`、TON RPC key、预言机签名密钥全部走 `wrangler secret`；轮换流程文档化 |
| CI/CD | GitHub Actions：typecheck → build → d1 migrate → deploy；生产部署需人工审批 |
| 回滚 | Worker 版本回滚（`wrangler rollback`）+ D1 迁移前向兼容（只加列不删列） |

### 2.6 测试网链上部署（V7：脚本就绪，未执行）

**已完成**
- 合约：`RoundController` + `TeamVault`，Tolk/Acton 1.1.0，47 个测试全绿，`acton check` 0 warning；code hash `RoundController 0xCA0FC4D4…C9B3` / `TeamVault 0xDDFEE8CA…09DD`（时间参数全部来自 storage config，改参数不改 hash）。
- 参数：`contracts/deploy/params.testnet.json` 与 `ops/config/testnet.params.json` 已切 V7（12h + 36h + 24h、24 根 × 1h、16 阈值、单轮 72h、10 轮 30 天）。
- 运维：`ops/scripts/` 12 步部署流水线（默认 dry-run，`OPS_EXECUTE=1` 才广播）、5 份 runbook、8 份模板、`verify_deployment.mjs` 对账。
- 前端：TON Connect 真实质押/领取已实现并自测（BOC 与 `@ton/core` 字节一致），合约地址就位即可切真实网络。

**已完成（原第 1 项硬缺口已补齐，V7 交付）**
- **Jetton Master / Wallet 已用 Tolk 实现**：`contracts/contracts/jetton/`（JettonMaster / JettonWallet + messages/storage/errors/utils/fees/sharding），Acton 官方 jetton 模板骨架 + A9 mint-once 改造；`contracts/tests/jetton.test.tolk` 18 个用例（mint-once、权限、transfer、forward_payload 透传、burn+supply、伪造 internal_transfer、provide_wallet_address、get 方法、change_admin/content），全量 **65 测试通过**；code hash `JettonMaster 0xAA7BC0B3…740C` / `JettonWallet 0x068E64CF…7D53`。
- mint：op `0x15`，仅 admin、金额必须 1e19（100 亿 × 1e9）、只允许一次，同一笔交易 `admin=null`（mintable=false），二次 mint 报 `MintClosed(75)`。
- burn：wallet 发标准 `burn_notification 0x7bdd97de` → master 校验 canonical wallet 后扣 `total_supply`（测试网 BurnAck 权威即 jettonMaster）。
- 部署脚本：`scripts/deploy-emulation.tolk` 已串起 JettonMaster → mint → TeamVault → RoundController → `get_wallet_address` 解析 → `SetJettonWallet` → `InitController`，无占位地址；分步脚本 `scripts/deploy/deploy_jetton_master.tolk` / `mint_and_lock_jetton.tolk`（位置参数）。

**未完成（2 项硬缺口）**
1. **测试网 TON 未充值**：`RoundController` 需 ≥20 TON、`TeamVault` 需 ≥10 TON（每条跨合约指令约 0.05 TON）。`acton wallet airdrop` 可从测试网 faucet 领（本机 acton 已装、faucet 通道可用），但需要先确定部署钱包。
2. **6 个地址 + 参数签字**：`adminOwner / treasury / teamWallet / marketingWallet / liquidityWallet / teamInternalWallet`。测试网可全部用新生成的测试网钱包（私钥留本地 keystore），主网 admin 必须用项目方**服务器专用热钱包（D-41）**；其余收款角色可用硬件钱包。

**执行顺序（≈ 半天，Jetton Master 补齐后）**
```
acton wallet new --name a9-deployer --version v4r2 --airdrop   # 或 import 已有助记词
node ops/scripts/00_preflight.mjs                              # dry-run 体检
node ops/scripts/10_deploy_jetton.mjs                          # Jetton Master
node ops/scripts/11_mint_and_lock_jetton.mjs                   # 铸 100 亿 + 关 mint
node ops/scripts/20_deploy_teamvault.mjs
node ops/scripts/30_deploy_round_controller.mjs
node ops/scripts/40_init_params.mjs
node ops/scripts/65_set_jetton_wallets.mjs
node ops/scripts/70_bind_roles.mjs
node ops/scripts/55_fund_ton.mjs && node ops/scripts/50_fund_vaults.mjs
node ops/scripts/60_verify_and_register.mjs
node ops/scripts/verify_deployment.mjs                         # 验收（默认 STRICT）
```
> **验收门禁（V8 / STRICT）**：`verify_deployment.mjs` **默认 STRICT**，开轮前必检项（协议配置 17 项、
> Jetton Wallet code hash、TeamVault pending 清零、TeamVault.controller 地址比对、注资登记等）必须全部 PASS；
> getter 缺失 / 返回栈异常 / 必检分支未执行一律 FAIL（结尾有 `gate.missing.*` 覆盖审计）。
> `--lenient` 仅用于排查，**输出不得作为开轮或上线依据**。
> STRICT 下 code hash 不一致 = 线上实例与 `contracts/build` 不一致（通常为未重部署），**必须重部署后再开轮**。

每步先 dry-run 看输出，确认后加 `OPS_EXECUTE=1` 重跑。部署完成后把地址写入 `ops/config/testnet.params.json` 的 `contracts` 段与 D1 `contracts` 表，前端与 `/api/config` 即可切真实网络。

**注意**：已部署实例的 config 不可变（RC 不可升级），参数一旦写进 storage 只能重新部署。因此 **Jetton Master 补齐 + 参数签字完成后再执行第一次真实部署**，避免浪费测试网地址与 TON。

---

## 3. 安全与审计

1. 第三方审计（自研面 **RoundController + TeamVault** + 自定义 burn ack + 可选 OracleAdapter），预算参考 **$12k~35k**、周期 3~5 周（对齐 docs/11 §5）；预留 2 轮复审。
2. 经济攻击模拟：低流动性拉盘、闪电贷、预言机延迟、单源操纵、多钱包拆分（Sybil）。
3. 渗透测试：API 越权、admin token 暴破、D1 注入、XSS（前端已避免 `dangerouslySetInnerHTML`）、CSP 绕过。
4. 密钥管理（D-41：admin 服务器热钱包 + 地址不公开，风险接受）：**admin 私钥（控制 TeamVault 指令权）在运维跳板机 acton keystore，只放 ~2 GRAM gas、不放资产；SSH key-only、出账告警、每周 nonce 审计**；团队收款/营销/流动性个人热钱包私钥用硬件钱包冷存储备份、离线多份，只留运营小额；地址**不对外披露**但至少向审计/交易所披露；预言机签名密钥与提交 keeper **分离**；定期权限复核与轮换演练。
5. 应急演练：`PauseOracle`、停止质押、紧急公告、技术终止退款全流程演练一遍并计时。
6. 漏洞赏金（可选）：Immunefi / 自建，聚焦本金销毁路径。
7. **BurnAck 主网化（V6.3 阻塞项）**：测试网**由 jettonMaster 地址充当 BurnAck 权威**；主网前必须改为 **(a) Jetton Master burn ack 扩展** 或 **(b) 标准 burn + 链下对账 + owner 确认**，否则销毁不可信。
8. **法律意见（D-34，V6.2 已确认）**：**项目方决定不聘请外部法律顾问、不做正式法律意见书**，合规风险由项目方自行承担；仍保留用户协议、风险披露、地区限制等内部措施（见 §4）。

---

## 4. 合规与法律（**V6.2：已确认不做外部法律意见，风险自担**）

> **D-34（V6.2 已确认）**：项目方决定**不聘请外部法律顾问、不出具正式法律意见书**，由此产生的合规风险由**项目方自行承担**。本节保留内部措施清单，但不得再描述为「待法律意见」或「上线前必须取得意见书」。

1. 机制可能触及不同司法辖区的**金融产品、博彩、促销、消费者保护**规则（docs/07 §2.2 已提示）；该风险由项目方承担。
2. **仍建议（非阻断）**：用户协议、风险披露（版本号与前端 payload 一致）、隐私政策（Cloudflare 日志、钱包地址属个人数据）由项目方自行准备。
3. 地区限制：如项目方选择，可对受限辖区做前端地理封禁（Cloudflare 国家规则）+ 条款说明（非强制）。
4. **风险披露必须强化**：前端与公告须明确「**高风险、可能损失全部本金**」、奖励不保证、机制可能多数轮次销毁、项目方不提供外部法律意见；不得承诺收益。
5. 税务：奖励发放的税务处理由项目方自行确认。

---

## 5. 经济模型与做市

1. **P0 确认**：V5.4 已定 **P0 = $0.00116**（USD_E8 = 116,000；1 GRAM = 1000 A9 × GRAM $1.16，FDV $11.6M）；主网前如按市场校准，按「先上流动性 → 公开基准期 → 多源 TWAP → 写链 + 公布数据与哈希」执行（docs/01 §4）。
2. **冷启动池（V5.4 已确认）**：2 亿 A9 + $232,000 USDT @ $0.00116（与内盘价一致）；后续按 docs/01 §10 分阶段双边加池。
2. **内盘与流动性（V5.5 定案 / V5.6 销售规则已确认）**：内盘销售 **8%（8 亿 A9，全售可募 $928,000 / 800,000 GRAM）**——可售 **硬上限 8 亿、不可超卖**，实际销量由项目方按市场决定、可分批，未售/撤回全部转**公开可查的团队内盘管理钱包**（仅加池/OTC/后续轮次公告后使用，不得二级直砸；合约不承担销售逻辑）；流动性 **5%（5 亿 A9，全额进池需 $580,000 USDT）**；冷启动池 2 亿 A9 + $232,000（占流动性 40%），初始流通 8% ≈ $928,000；建议按「分阶段双边加池」推进，避免深度不足又被砸盘或目标不可达。
3. **做市/防砸盘**：失败销毁机制本身会制造抛压预期，必须提前设计做市与回购规则（并公开）。
4. **压力测算**：假设第 1 轮质押池 3000 万~1 亿枚，失败时销毁规模、对流通盘与价格的影响。
5. **激励一致性**：奖励按质押比例分配会诱导「越早质押越好」，需评估稀释与最后时刻狙击（D-14 已确认纯质押比例；快照/加权属后续优化）。
6. **V5 待决策（D-26，最高优先级）**：报名窗口 36h 下，若现价已 ≥ 目标价则观察期几乎确定通过、无风险白拿 7 亿；**方案 B+（Lead 推荐：固定阶梯 + 1h TWAP 闸门 + 触价提前关窗 + 12h 缓冲）** / A 相对翻倍 / C 短窗+随机截止，见 docs/00 §7，定案前不得进入合约参数设计（保持 `FIXED_LADDER`）。
6. **模拟盘**：主网上线前用 Testnet 跑完整 10 轮（可加速），公开结果。

---

## 6. 运营准备

**上线前必须建立**：

- 透明页（前端已有 footer 占位，需填真实数据）：Jetton Master、**RoundController、TeamVault**、代码哈希、审计报告、预言机配置哈希、单密钥 owner 地址；**团队/营销/流动性收款地址不对外披露**（仅向审计/交易所披露），透明页需说明该托管方式与风险（无多签、无时间锁、RC 不可升级）。
- 状态页：轮次状态、K 线进度、预言机健康、历史结算（可由 `/api/*` + 公开看板承担）。
- 值班：主网观察期 7×24 值守；告警接 PagerDuty/Telegram；事故等级与响应时限（P0 15 分钟响应）。
- 客服：FAQ（如何质押/为什么失败/如何领取/预言机故障怎么办）、工单渠道、社区公告模板（成功/失败/暂停/恢复四套）。
- 内容：上线公告、规则长图、风险提示视频/图文、每轮开轮与结算公告。
- 数据看板：DAU、质押地址数、TVL、轮次通过率、销毁量、预言机延迟。

**运营节奏（V6）**：每轮 = **12h 预告期 + 72h 报名 + 24h 观察 = 7 天**（结算/领取在轮内推进）；**10 轮 = 70 天**。需提前排期公告。

---

## 7. 上线时间表（建议 10~12 周）

| 周 | 里程碑 |
| --- | --- |
| W0（本周） | ✅ 前端+后端部署到 Cloudflare（演示模式）；本清单评审；参数决议书下发 |
| W1~W2 | 参数冻结（D-01~D-32，含 D-25 领取方式、D-26/D-27 已定案（V6）、D-28 同档重试、D-29 R1 启动、D-30 时间加权、D-31 2×、D-32 分配）；合约脚手架 + Jetton 实现；预言机采集器原型；**按 docs/12 优先解决 P0-1/P0-2/P0-5** |
| W3~W4 | **文档全部定稿 + 参数签字**（用户明确：文档与细节敲定后才启动测试网）；**D-26 必须先决策** |
| W5 | RoundController / TeamVault / OracleAdapter 完成；单元+集成测试 |
| W6 | **Testnet 启动（前置：文档定稿 + 参数签字 + D-26 已定）**；完整演练（成功轮 + 失败轮 + 三笔销毁核对 supply + TeamVault 指令 + claimAll + 无人质押分支） |
| W7~W8 | 第三方审计（第一轮）→ 修复 → 复审 |
| W9 | 法律意见书定稿；风险披露 v1 定稿并与前端 payload 对齐；地区限制配置 |
| W10 | 主网参数冻结、部署合约、注入 70 亿奖励池 + 12 亿 TeamVault 团队额度、建立冷启动池（2 亿 A9 + $232,000）、验证 10×7 亿 + 10×1.2 亿分账；P0 = $0.00116 公布；验证目标价逐轮写入事件 |
| W11 | 主网预演（小额质押、K 线提交、结算、销毁全链路）；监控/告警/值班就绪 |
| W12 | Round 1 开放报名；上线公告；7×24 值守开始 |

---

## 8. 成本估算（首年，参考区间）

| 项 | 估算 |
| --- | --- |
| Cloudflare Workers Paid + D1 + R2 | $60~300 / 年（流量小时）/ 月（流量大时） |
| 域名 | $10~50 / 年 |
| TON 合约部署 + gas（10 轮） | 约 4~15 TON（Jetton + RoundController + TeamVault，无多签/锁仓；含金库注入与多次结算） |
| 第三方审计（RoundController + TeamVault 自研面） | $12k~35k（一次性） |
| 法务意见书 + 文书 | $5k~30k（一次性） |
| 预言机/价格数据（如需商业源） | $200~2,000 / 月 |
| 做市资金 | 由流动性 5%（5 亿 A9）+ 内盘募资（$928,000）中的一部分承担；冷启动先投 2 亿 A9 + $232,000 |
| 监控/Sentry/告警 | $0~100 / 月 |
| 人力（合约 2 人 × 3 月 + 前端运维 0.5 人） | 按团队自估 |

---

## 9. 风险登记册（Top 12）

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | 预言机被操纵导致错误判定 | 本金被销毁，信任崩塌 | 多源+TWAP+流动性阈值+暂停机制+公开可复算 |
| 2 | 合约漏洞（burn / claim 重复） | 资金损失 | 审计 + 不变量测试 + 幂等状态机 + 限额 |
| 3 | 第 1 轮就打不穿目标价 | 首轮销毁，社区恐慌 | P0 审慎定值 + 做市 + 充分披露 |
| 4 | 监管认定博彩/证券 | 下架、处罚 | 法律意见 + 地区限制 + 话术合规 |
| 5 | 后端/RPC 故障 | 页面不可用、数据错乱 | 缓存 + 对账 + 降级页 + 多 RPC |
| 6 | 管理员密钥泄露 | 配置被改、资金被动；**且可强制任意轮判负销毁本金** | 权限最小化 + 控制器不可升级 + Access + 审计日志 + **服务器专用热钱包（D-41；跳板机隔离/SSH key-only/出账告警/周审计）**；无多签、泄露无补救（风险已接受） |
| 7 | Sybil 拆分质押 | 奖励集中 | 单地址上限（缓解，不根治）+ 反女巫（可选） |
| 8 | 失败销毁引发抛售螺旋 | 价格崩盘 | 做市预案 + 冷却期 + 分批开放 |
| 9 | 前端钓鱼/仿冒站 | 用户资产损失 | 官方域名公告 + 合约地址校验 + DM 防护 |
| 10 | 数据不一致（本地账本 ≠ 链上） | 结算错误 | 定时对账 + 告警 + 只以链上为最终源 |
| 11 | **单私钥管理员（无多签，D-41 起为服务器热钱包）+ TeamVault 指令权集中** | 私钥泄露/丢失将失去管理员能力或被伪造团队指令；**且 admin 可用 SubmitCandle 提交低价 K 线强制任意轮判负，销毁该轮 100% 用户本金与奖励**（不可直接转走资金）；**合约不可升级、无 SetAdmin，泄露后无法更换 admin，可永久强制判负**；无链上治理兜底 | **高风险（已接受）**：**服务器专用热钱包（D-41）** + 跳板机隔离 + SSH key-only/无密码 + 最小权限 + **任何出账告警** + 每周 nonce 审计 + 只放 ~2 GRAM；owner 权限最小化 + TeamVault 只认 RC + RC 不可升级；**泄露无补救路径** |
| 12 | **营销/流动性/团队收款使用个人热钱包 + 地址不公开** | 热钱包私钥泄露即直接损失；地址不公开降低外部监督与对账能力 | **高风险（已接受）**：热钱包只放运营小额、大额转冷钱包；私钥硬件钱包备份 + 离线多份；至少向审计方/交易所披露地址；异常转账监控与告警；公开材料说明托管方式与风险 |
| 13 | **不做外部法律意见 / 合规风险自担（D-34）** | 可能被认定为博彩/证券/金融产品；下架、处罚、用户诉讼 | **已确认风险自担**：前端/公告强化「高风险、可能损失全部本金」；用户协议/风险披露自行准备；地区限制自选；不对外声称已获法律意见 |

---

## 10. 上线验收清单（全部 ✅ 才能开真实质押）

- [ ] D-01~D-32 全部书面确认（V3~V5 已确认项见 docs/07 §1；**D-28 同档重试、D-29 R1 启动必须先定**；D-26/D-27/D-31/D-32 已定案），配置哈希生成并公布
- [ ] 已确认项落实：观察窗口 24 根/24h/16 阈值；质押限额（10,000 A9 / 单地址≤10% / 本轮≤2亿）；技术终止（14天/7天、任何人可触发）；D-28 同档重试；D-30 无时间加权；目标价开窗锁定公式与 12h PREVIEW 已实现；**不允许取消质押**（仅技术终止退本金）且前端风险披露已写明
- [ ] P0 = $0.00116 / 2× / 冷启动池（2 亿 A9 + $232,000）落实；目标价逐轮写入 + `TargetPriceSet` 事件可校验（不预存 10 轮价格）
- [ ] 合约审计完成，无未解决 Critical/High
- [ ] 代码哈希 = 审计版本；源码与 ABI 公开
- [ ] Testnet 成功轮 / 失败轮 / 故障暂停恢复全部演练通过
- [ ] 失败销毁**三笔**（奖励 7 亿 + 团队 1.2 亿 + 本金）后 Jetton Master `total_supply` 实际减少（链上核对）
- [ ] 成功轮 TeamVault 释放 1.2 亿到账且每轮只释放一次；TeamVault 非 RC 指令被拒
- [ ] claimAll 跨轮领取金额正确、幂等、合并一笔转账（≤10 轮）
- [ ] 报名 36h / 间隔 0 与观察 24h 边界在链上核对精确
- [ ] 0 人质押且通过轮次：7 亿奖励实际销毁
- [ ] 质押本金「返还」与「销毁」互斥，重复调用幂等
- [ ] 预言机：多源、签名验证、覆盖率、暂停/恢复、数据公开可复核
- [ ] 前端风险披露版本 = 链上 `riskDisclosureVersion`
- [ ] （D-34 已确认不做外部法律意见）用户协议/风险披露/隐私政策等内部措施就绪；风险披露含「高风险、可能全部损失」
- [ ] 单密钥 owner 权限清单与个人热钱包托管说明就绪；**地址至少向审计/交易所披露**；**admin 服务器热钱包跳板机隔离/SSH key-only/出账告警/周审计已配置（D-41）**；其余密钥硬件钱包与备份/轮换演练完成
- [ ] 监控/告警/值班/客服/状态页/透明页就绪
- [ ] Cloudflare：自定义域名、WAF 限流、Access 保护 `/admin`、备份、CI/CD 回滚演练
- [ ] 应急预案演练（暂停、公告、技术终止退款）计时完成
- [ ] 做市与流动性就位，池深达标
- [ ] 社区与公告物料齐备，风险提示触达

---

## 11. 本次交付的运维速查

```bash
# 本地
npm run dev:worker          # API + 本地 D1 (127.0.0.1:8787)
npm run dev                 # 前端 (127.0.0.1:5173)
npm run typecheck && npm run build

# 部署（Lead/运维执行）
cd worker
./node_modules/.bin/wrangler d1 migrations apply fuse-protocol --remote
./node_modules/.bin/wrangler d1 execute fuse-protocol --remote --file=./seed/seed.sql
./node_modules/.bin/wrangler secret put ADMIN_TOKEN
cd .. && npm run build && cd worker && ./node_modules/.bin/wrangler deploy

# 回滚
./node_modules/.bin/wrangler rollback
```

**线上地址**：`https://fuse-protocol.348421501.workers.dev`
**API 健康检查**：`/api/health`（含 D1 连通性）
**运维后台**：`/admin`（Bearer `ADMIN_TOKEN`）

---

*本清单与 docs/07 的上线阻断项一一对应。凡与合约实际实现冲突处，以经审计的合约与签署参数为准。*

---

## 12. 已知技术 TODO（本次交付遗留，按优先级）

1. **CSP 未启用**：TON Connect 桥接域名（bridge.tonapi.io、各钱包 UI 域）尚未最终确定，Worker 暂只返回基础安全头（nosniff / X-Frame-Options / Referrer-Policy / Permissions-Policy / COOP）。上线前需补充严格 CSP（connect-src / frame-src / font-src 白名单）并做一次回归。
2. **真实链适配器**：worker/src/sources/chain.ts 为带 8 条 TODO 的桩（RPC / Get methods / OracleAdapter / BurnAck / 事件索引 / 对账 / 缓存 / 降级）。切真链时实现它并把 DATA_SOURCE 改为 chain，同时关闭 stake/claim 的演示写入。
3. **质押幂等键**：前端已为每笔演示质押生成 depositNonce（crypto.randomUUID）；真链上需写入 Jetton transfer 的 forward payload，并在合约侧按 (roundId, owner, nonce) 去重。
4. **钱包交易**：当前 TON Connect 只读；合约部署后需补 payload 构造（roundId / depositNonce / riskDisclosureVersion / acceptFullPrincipalBurn）、boc 打包、回执轮询。
5. **D1 备份与密钥轮换**：wrangler d1 export 到 R2 的每日定时任务、ADMIN_TOKEN 轮换流程尚未自动化。
6. **V5 新增（真链阶段）**：TeamVault 部署与 RC 指令（TeamReleased / TeamBurned 事件索引）；claimAll 的前端多轮聚合与链上回执轮询；D-26 决策后目标价语义的合约/前端/API 同步改造。
