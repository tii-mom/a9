# 10 — 上线与运营剩余工作清单（Launch Readiness）

**版本**：V1.0 · 2026-11-05
**对应代码**：`web/`（React 前端）+ `worker/`（Cloudflare Worker API + D1）+ `shared/`（API 契约）
**结论先行**：**前端与后端服务层已经具备上线条件（演示数据模式）**；但协议本身的「主网可用」还差三大块硬工作——**智能合约+审计、预言机生产化、合规与经济模型冻结**。没有这三块，不得开放真实质押。

---

## 0. 当前状态盘点

| 层 | 状态 | 说明 |
| --- | --- | --- |
| 前端 UI（落地页 / 战况 / 指挥台 / 成交流 / 阶梯 / 沙盘 / 筹码 / 风险） | ✅ 已实现 | React 19 + Vite + TS，视觉 1:1 还原原型，中英双语 |
| 应用页（我的战况 / 排行榜 / 运维后台） | ✅ 已实现 | 数据来自后端 API |
| 后端 API（Cloudflare Worker + D1） | ✅ 已实现（演示数据源） | 19 个端点，状态机、K 线推进、销毁账本、admin 审计 |
| 部署 | ✅ Cloudflare 单 Worker + D1（`*.workers.dev`） | 已可公网访问；自定义域名待绑 |
| 数据源抽象 | ✅ `sources/demo.ts` + `sources/chain.ts` 桩 | 切真链只需实现 chain 适配器并改 `DATA_SOURCE=chain` |
| 智能合约 | ❌ 未开发 | 文档 04 只给了架构与消息接口 |
| 预言机生产服务 | ❌ 未开发 | 文档 03 只给了数据格式与验证流程 |
| 审计 / 法务 / 经济模型冻结 | ❌ 未完成 | 文档 07 的 24 项上线阻断项全部「待定」 |
| 运营体系（监控/值班/客服/透明页） | 🟡 部分 | 已有 admin 后台与健康检查；告警、值班、客服未建立 |

---

## 1. 上线阻断项（必须先由项目方书面确认）

来源：`docs/07_OPEN_DECISIONS.md`。下表按「谁决定 / 建议值 / 影响面」重新排过，**每项未确认 = 主网不得开放质押**。

| ID | 决策 | 建议默认值 | 影响 | 决策人 |
| --- | --- | --- | --- | --- |
| D-01 | 代币名称、符号 | FUSE / FUSE | 前端、Jetton metadata、交易所申报 | 项目方 |
| D-02 | Jetton decimals | 9 | 所有 raw 计算、前端换算、账本 | 项目方 |
| D-03 | P0 计算方式 | 多源 7 日 TWAP，冻结上链 | 十轮目标价全部由它推导 | 项目方+经济顾问 |
| D-04 | 预言机方案 | 自建签名聚合器 + 3/5 签名方 | 决定成败判定可信度 | 技术负责人 |
| D-05 | 价格来源数量 | ≥3 个独立市场 | 抗操纵能力 | 技术负责人 |
| D-06 | 最低流动性 | 按池深定，建议 ≥$500k | 防单池拉盘 | 经济顾问 |
| D-07 | 最低 4h 成交量 | 按市场规模定 | 有效性判定 | 经济顾问 |
| D-08 | 来源最大偏差 | 300 bps | 离群源过滤 | 技术负责人 |
| D-09 | TWAP 覆盖率 | ≥9500 bps（95%） | 数据质量 | 技术负责人 |
| D-10 | 质押报名期 | 7 天 | 前端文案、合约参数 | 项目方 |
| D-11 | 单笔最低质押 | 建议 1,000 FUSE | 防粉尘攻击 | 项目方 |
| D-12 | 单地址最大质押 | 建议 ≤ 本轮池 20% | 防单点巨鲸 | 项目方 |
| D-13 | 全轮最大质押 | 按可承受销毁额反推 | 财务风险 | 项目方 |
| D-14 | 奖励分配公式 | MVP：按有效质押比例 | 核心经济规则 | 项目方 |
| D-15 | 社区贡献积分 | 二期 | 是否需要 ContributionRegistry | 项目方 |
| D-16 | 奖励归属/期限 | 12 个月线性 或 立即 | 领取合约逻辑 | 项目方 |
| D-17 | 成功后本金返还时点 | 终态后主动领取 | claim 流程 | 项目方 |
| D-18 | 无人质押处理 | 不启动观察、不算失败、不销毁 | 状态机分支 | 项目方 |
| D-19 | 预言机长期故障 | 暂停；14 天触发技术终止退款 | 极端情况资金安全 | 项目方+技术 |
| D-20 | 团队归属规则 | 12 个月 cliff + 36 个月线性 | 解锁合约 | 项目方 |
| D-21 | 营销金库管理 | 多签 + 公开支出 | 信任 | 项目方 |
| D-22 | 10% 内盘/流动性拆分 | 待定（如 6% 流动性 + 4% 内盘） | 做市计划 | 项目方 |
| D-23 | 多签阈值 | 3/5 独立责任人 | 治理安全 | 项目方 |
| D-24 | 合约升级策略 | 核心经济规则不可升级 | 审计范围 | 项目方+技术 |

**建议动作**：把本表复制成一份「参数决议书」，逐项签字，产出 `config/mainnet/params.json` 与其 SHA-256（即文档 07 §4 的「配置哈希」），部署前进 CI 校验、部署后公布。

---

## 2. 技术剩余工作（按依赖顺序）

### 2.1 智能合约（最大工作量，建议 4~6 周）

| 模块 | 工作内容 | 依赖 |
| --- | --- | --- |
| Jetton Master/Wallet | TEP-74 兼容 + 关闭 mint 或受限治理 + **burn acknowledgement 扩展**（用于链上确认销毁） | D-01/02 |
| RoundController | 10 轮状态机、目标价公式、观察窗口边界、12 根 K 线计数、结算触发 | D-03/10 |
| StakingVault | 接收 Jetton 转账 + payload 校验（roundId/nonce/riskVersion）+ 账本 + 成功返还 + 失败销毁 | D-11/12/13 |
| RewardVault | 10 × 7.5 亿独立账本 + 成功领取 + 失败销毁 + 余数留存 | D-14/16 |
| OracleAdapter | 签名校验、feedId/有效期/nonce/configVersion、暂停/恢复 | D-04~09 |
| 幂等与重试 | 每个外部动作唯一 operationId / burnId；bounce 处理；pending 状态机 | — |
| 测试 | 单元 + 集成 + fuzz + 不变量（docs/05 §2 的 18 条不变量全部要有 property test） | — |
| Testnet 演练 | 至少一轮成功 + 一轮失败 + 一次预言机故障暂停恢复 | — |

工具链：Tolk + Acton（官方推荐），锁定编译器/工具链版本，CI 可重复构建；ABI 与前端类型从同一份定义生成。

### 2.2 预言机生产服务（2~3 周）

1. **数据采集器**：从 3+ 个白名单市场拉 4h 数据，计算 TWAP + 成交量 + 流动性 + 覆盖率（docs/03 §4）。
2. **签名服务**：多签方独立部署，对 `OracleCandle` 摘要签名；私钥在 HSM/KMS，不落代码仓库。
3. **提交器（keeper）**：任何人可提交，但需要有人跑；失败重试 + 监控。
4. **pause/resume 守护**：数据缺失/源不足自动 `PauseOracle`，恢复后重新收满 12 根。
5. **可复核数据**：每根 K 线落对象存储（R2），公开 dataDigest，任何人可复算。
6. 选型提醒：文档 08 列的是 TON 官方资料；**RedStone / Pyth 等第三方喂价在 TON 的可用性、签名格式、成本必须在选定前实际验证**，不能用「多源去中心化」话术代替实测。

### 2.3 后端从 demo 切真链（1~2 周）

现成接口已按链上字段设计，切换步骤：

1. 实现 `worker/src/sources/chain.ts`：
   - TON RPC 提供商（toncenter / 自建 liteserver）拉取合约状态与事件；
   - Indexer：解析 `RoundOpened / CandleRecorded / RoundSettled / BurnAcked / Claimed` 事件写 D1；
   - 对账任务：链上 total_supply、各金库余额与本地账本比对，不一致告警。
2. 改 `DATA_SOURCE=chain`，保留 demo 作为 staging 演示环境。
3. 加缓存层（KV / Cache API）：链上读取按 5~15s 缓存，避免打爆 RPC。
4. 前端无需改动（契约不变）；仅把「演示数据」徽标改为真实网络标识。

### 2.4 前端收尾

- TON Connect 从「只读」升级为「可发交易」：质押 payload 构造（`roundId / depositNonce / riskDisclosureVersion / acceptFullPrincipalBurn`）、boc 打包、钱包回执与状态刷新、失败重试。
- 用户风险确认与链上 payload 的版本号必须一致（`riskDisclosureVersion`）。
- 领取流程：`claimPrincipal` / `claimReward` 两笔独立交易 + 幂等状态。
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

---

## 3. 安全与审计

1. 第三方审计（合约 + 自定义 burn ack + OracleAdapter），预算参考 **$15k~60k**、周期 3~6 周；预留 2 轮复审。
2. 经济攻击模拟：低流动性拉盘、闪电贷、预言机延迟、单源操纵、多钱包拆分（Sybil）。
3. 渗透测试：API 越权、admin token 暴破、D1 注入、XSS（前端已避免 `dangerouslySetInnerHTML`）、CSP 绕过。
4. 密钥管理：多签私钥分人保管；预言机签名密钥与提交 keeper **分离**。
5. 应急演练：`PauseOracle`、停止质押、紧急公告、技术终止退款全流程演练一遍并计时。
6. 漏洞赏金（可选）：Immunefi / 自建，聚焦本金销毁路径。

---

## 4. 合规与法律（不可跳过）

1. 机制可能触及不同司法辖区的**金融产品、博彩、促销、消费者保护**规则（docs/07 §2.2 已提示）。
2. 需要：法律意见书（发行/质押/销毁/奖励）、用户协议、风险披露（版本号与前端 payload 一致）、隐私政策（Cloudflare 日志、钱包地址属个人数据）。
3. 地区限制：对受限辖区做前端地理封禁（Cloudflare 国家规则）+ 条款说明。
4. 营销口径：不得承诺收益；「销毁本金」必须显著披露；KOL 话术需过合规审。
5. 税务：奖励发放的税务处理需会计确认。

---

## 5. 经济模型与做市

1. **P0 冻结流程**：先上流动性 → 公开基准期（建议 7×24h）→ 多源 TWAP → 写链 + 公布数据与哈希（docs/01 §4）。
2. **流动性**：10%（10 亿枚）中拆分流动性/内盘（D-22 待定）；建议初始池深 ≥ $500k，避免第 1 轮目标价被几笔交易打穿。
3. **做市/防砸盘**：失败销毁机制本身会制造抛压预期，必须提前设计做市与回购规则（并公开）。
4. **压力测算**：假设第 1 轮质押池 3000 万~1 亿枚，失败时销毁规模、对流通盘与价格的影响。
5. **激励一致性**：奖励按质押比例分配会诱导「越早质押越好」，需评估稀释与最后时刻狙击（可考虑快照/加权，但 D-14 未定）。
6. **模拟盘**：主网上线前用 Testnet 跑完整 10 轮（可加速），公开结果。

---

## 6. 运营准备

**上线前必须建立**：

- 透明页（前端已有 footer 占位，需填真实数据）：Jetton Master、RoundController、代码哈希、审计报告、预言机配置哈希、多签地址与阈值。
- 状态页：轮次状态、K 线进度、预言机健康、历史结算（可由 `/api/*` + 公开看板承担）。
- 值班：主网观察期 7×24 值守；告警接 PagerDuty/Telegram；事故等级与响应时限（P0 15 分钟响应）。
- 客服：FAQ（如何质押/为什么失败/如何领取/预言机故障怎么办）、工单渠道、社区公告模板（成功/失败/暂停/恢复四套）。
- 内容：上线公告、规则长图、风险提示视频/图文、每轮开轮与结算公告。
- 数据看板：DAU、质押地址数、TVL、轮次通过率、销毁量、预言机延迟。

**运营节奏**：每轮 = 报名 7 天 + 观察 48h + 结算/领取 3~5 天 ≈ 10~12 天，10 轮约 4 个月。需提前排期公告。

---

## 7. 上线时间表（建议 10~12 周）

| 周 | 里程碑 |
| --- | --- |
| W0（本周） | ✅ 前端+后端部署到 Cloudflare（演示模式）；本清单评审；参数决议书下发 |
| W1~W2 | 参数冻结（D-01~D-24）；合约脚手架 + Jetton 实现；预言机采集器原型 |
| W3~W5 | RoundController / Vault / OracleAdapter 完成；单元+集成测试；前端接 Testnet |
| W6 | Testnet 完整演练（成功轮 + 失败轮 + 故障暂停恢复 + 销毁核对 supply） |
| W7~W8 | 第三方审计（第一轮）→ 修复 → 复审 |
| W9 | 法律意见书定稿；风险披露 v1 定稿并与前端 payload 对齐；地区限制配置 |
| W10 | 主网参数冻结、部署合约、注入 75 亿奖励池、验证 10×7.5 亿分账；P0 冻结并公布 |
| W11 | 主网预演（小额质押、K 线提交、结算、销毁全链路）；监控/告警/值班就绪 |
| W12 | Round 1 开放报名；上线公告；7×24 值守开始 |

---

## 8. 成本估算（首年，参考区间）

| 项 | 估算 |
| --- | --- |
| Cloudflare Workers Paid + D1 + R2 | $60~300 / 年（流量小时）/ 月（流量大时） |
| 域名 | $10~50 / 年 |
| TON 合约部署 + gas（10 轮） | 约 5~20 TON（含金库注入与多次结算） |
| 第三方审计 | $15k~60k（一次性） |
| 法务意见书 + 文书 | $5k~30k（一次性） |
| 预言机/价格数据（如需商业源） | $200~2,000 / 月 |
| 做市资金 | 由 10% 分配中的流动性部分承担 |
| 监控/Sentry/告警 | $0~100 / 月 |
| 人力（合约 2 人 × 3 月 + 前端运维 0.5 人） | 按团队自估 |

---

## 9. 风险登记册（Top 10）

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | 预言机被操纵导致错误判定 | 本金被销毁，信任崩塌 | 多源+TWAP+流动性阈值+暂停机制+公开可复算 |
| 2 | 合约漏洞（burn / claim 重复） | 资金损失 | 审计 + 不变量测试 + 幂等状态机 + 限额 |
| 3 | 第 1 轮就打不穿目标价 | 首轮销毁，社区恐慌 | P0 审慎定值 + 做市 + 充分披露 |
| 4 | 监管认定博彩/证券 | 下架、处罚 | 法律意见 + 地区限制 + 话术合规 |
| 5 | 后端/RPC 故障 | 页面不可用、数据错乱 | 缓存 + 对账 + 降级页 + 多 RPC |
| 6 | 管理员密钥泄露 | 配置被改 | 多签 + 时间锁 + Access + 审计日志 |
| 7 | Sybil 拆分质押 | 奖励集中 | 单地址上限（缓解，不根治）+ 反女巫（可选） |
| 8 | 失败销毁引发抛售螺旋 | 价格崩盘 | 做市预案 + 冷却期 + 分批开放 |
| 9 | 前端钓鱼/仿冒站 | 用户资产损失 | 官方域名公告 + 合约地址校验 + DM 防护 |
| 10 | 数据不一致（本地账本 ≠ 链上） | 结算错误 | 定时对账 + 告警 + 只以链上为最终源 |

---

## 10. 上线验收清单（全部 ✅ 才能开真实质押）

- [ ] D-01~D-24 全部书面确认，配置哈希生成并公布
- [ ] 合约审计完成，无未解决 Critical/High
- [ ] 代码哈希 = 审计版本；源码与 ABI 公开
- [ ] Testnet 成功轮 / 失败轮 / 故障暂停恢复全部演练通过
- [ ] 失败销毁后 Jetton Master `total_supply` 实际减少（链上核对）
- [ ] 质押本金「返还」与「销毁」互斥，重复调用幂等
- [ ] 预言机：多源、签名验证、覆盖率、暂停/恢复、数据公开可复核
- [ ] 前端风险披露版本 = 链上 `riskDisclosureVersion`
- [ ] 法律意见书 + 用户协议 + 隐私政策 + 地区限制
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
./node_modules/.bin/wrangler d1 execute fuse-protocol --remote --file=./migrations/seed.sql
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
