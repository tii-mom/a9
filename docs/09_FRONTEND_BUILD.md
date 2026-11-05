# 09 — 前端与 Cloudflare 后端实施基线（V5 口径）

> **口径声明（V5.5）**：分配 **70% 奖励 + 8% 内盘销售（8 亿 A9）+ 5% 流动性（5 亿 A9）+ 12% 团队 + 5% 营销**（内盘全售约 $928,000；冷启动池 1 亿 A9 + $116,000 = 流动性 20%）、P0 = **$0.00116**（USD_E8 = "116000"；1 GRAM = 1000 A9，R10 $1.18784、FDV $11.6M）、**目标价每轮结算写入下一轮（前端按 API/事件读取，不假设链上预存 10 轮价格）**、冷启动池 1 亿 A9 + $116,000、每轮奖励 7 亿（700M）、团队 12 亿由 TeamVault 托管、每轮 1.2 亿释放/销毁、失败销毁三笔（奖励 + 团队 + 本金）、**报名 72h（结算后立即开启）**、**观察 12 根 / 48h / 8 根（已确认不变）**、失败 100% 罚没、0 人质押且通过 → 奖励销毁、**不允许取消质押（仅技术终止退本金）**、不设多签、**奖励 pull claim / claimAll**。与 `docs/00_DECISIONS_V2.md` 冲突时以其为准。D-28/29/30（同档重试 / R1 启动 / 时间加权）为待确认建议（docs/12）。
>
> 本文件是本次开发任务的**唯一协作契约**。所有参与者（Lead / frontend-dev / app-dev / backend-dev）以本文件为准。
> 原型：根目录 `FUSE 引信协议.html`（1060 行单文件，含全部视觉与交互）。业务规则：`README.md`、`docs/01~08`。

## 1. 目标

把原型落地为可上线的**项目完整前端**（React 19 + Vite + TS），并配套 **Cloudflare Worker + D1** 后端，前后端一起部署在 Cloudflare（单 Worker + 静态资源 + D1）。

已确认的决策（来自用户）：

| 项 | 决策 |
| --- | --- |
| 前端 | React 19 + Vite + TypeScript，视觉 1:1 还原原型 |
| 后端 | Cloudflare Worker + D1，**演示数据集** + 可替换数据适配层 |
| 部署 | 现在就真实部署，先用 `*.workers.dev` 临时域名，之后再绑自定义域名 |
| 额外范围 | 我的战况、TON Connect（只读）、运维后台、排行榜、中英双语 |

## 2. 仓库结构

```
BAM/
├─ FUSE 引信协议.html        # 设计原型（只读参考）
├─ README.md / docs/01~08     # 业务规格（只读）
├─ docs/09_FRONTEND_BUILD.md  # 本文件
├─ shared/types.ts            # ★ 前后端共享 API 契约（Lead 维护，只读）
├─ web/                       # React 前端（Vite），构建产物 web/dist
│  ├─ index.html
│  ├─ vite.config.ts          # alias @shared / @，/api 代理到 127.0.0.1:8787
│  └─ src/
│     ├─ main.tsx / App.tsx   # 路由：/ /me /leaderboard /admin
│     ├─ styles/fuse.css      # ★ 原型 CSS，已从 HTML 原样抽出，禁止重写为 Tailwind
│     ├─ styles/app.css       # 应用页补充样式
│     ├─ lib/{api,format,lang}.ts(x)  # ★ Lead 维护
│     ├─ components/{SiteHeader,SiteFooter,ScrollToTop}.tsx  # ★ Lead 维护
│     ├─ features/landing/**  # frontend-dev 负责
│     ├─ features/app/**      # app-dev 负责
│     └─ features/wallet/**   # app-dev 负责
└─ worker/                    # Cloudflare Worker（API + 静态资源托管）
   ├─ wrangler.toml           # D1 已创建：fuse-protocol / b5945609-374e-4eaa-add2-80460ebcb680
   ├─ migrations/             # D1 迁移 + seed.sql
   └─ src/**                  # backend-dev 负责
```

## 3. 写作用域（避免互相覆盖）

| 角色 | 可写路径 | 只读 |
| --- | --- | --- |
| Lead | `shared/`、`web/src/lib/`、`web/src/components/Site*`、`web/src/styles/`、`docs/`、根配置 | — |
| frontend-dev | `web/src/features/landing/**` | 其余全部 |
| app-dev | `web/src/features/app/**`、`web/src/features/wallet/**` | 其余全部 |
| backend-dev | `worker/**` | `shared/types.ts`、`docs/09` |

需要改共享文件（`shared/types.ts`、`lib/*`、`styles/fuse.css`、`SiteHeader`）时：**不要直接改**，用 `send_message` 通知 Lead，由 Lead 改。

## 4. 数据与单位约定（必须遵守）

- 所有代币金额：`raw units` **字符串**，精度 `TOKEN_DECIMALS = 9`（`1 A9 = 1e9`）。
- 所有 USD 价格：`USD_E8` 字符串（`1e8 = $1.00`），例如 `0.001` → `"100000"`。
- 时间：Unix **毫秒**（`number`）。
- 前端展示一律走 `web/src/lib/format.ts`（`formatToken` / `formatUsdE8` / `formatDuration`）。
- 接口统一返回 `ApiResponse<T>`：`{ ok: true, data, ts }` 或 `{ ok: false, error: { code, message } }`。
  前端一律通过 `web/src/lib/api.ts` 的 `api.*` 调用，用 `useQuery()` 轮询，**不要自己写 fetch**。

## 5. API 契约（`shared/types.ts` 已定义类型）

| Method | Path | 返回 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | `HealthResponse` | 存活 + D1 连通性 |
| GET | `/api/config` | `ProtocolConfig` | P0、精度、参数、合约地址、冻结状态 |
| GET | `/api/stats` | `ProtocolStats` | 供应量、已销毁、质押、24h 成交、预言机状态 |
| GET | `/api/rounds` | `RoundSummary[]` | 10 轮总览 |
| GET | `/api/rounds/:id` | `RoundDetail` | 单轮含 12 根 K 线、live TWAP、倒计时 |
| GET | `/api/rounds/:id/candles` | `Candle[]` | K 线明细 |
| GET | `/api/rounds/:id/leaderboard` | `LeaderboardRow[]` | 该轮质押地址榜（演示数据也要真实聚合） |
| GET | `/api/trades?limit=20` | `Trade[]` | 逐笔成交 |
| GET | `/api/book` | `OrderBook` | 盘口深度 |
| GET | `/api/me?address=` | `MeResponse` | 某地址全部质押、可领取、累计 |
| POST | `/api/stake` | `{accepted, position}` | 演示质押（写 D1）；校验 risk version / 窗口 / 余额 |
| POST | `/api/claim` | `{claimed, amountRaw}` | 演示领取本金/奖励（幂等）；支持多轮合并领取语义（对应链上 `claimAll`） |
| GET | `/api/admin/overview` | `AdminOverview` | 需 `Authorization: Bearer <ADMIN_TOKEN>` |
| POST | `/api/admin/tick` | `AdminOverview` | 手动推进状态机一步 |
| POST | `/api/admin/oracle/pause|resume` | `AdminOverview` | 预言机暂停/恢复 |
| POST | `/api/admin/rounds/advance` | `AdminOverview` | 结算并开启下一轮 |

错误码：`BAD_REQUEST` `NOT_FOUND` `UNAUTHORIZED` `RATE_LIMITED` `CONFLICT` `INTERNAL`。

## 6. 演示数据模型（backend-dev 实现）

启动状态（与原型一致，用户验收时看到的就是这个样子）：

- `p0UsdE8 = "116000"`（P0 = $0.00116），目标价 `P0 × 2^roundId`（R1 $0.00232 → R10 $1.18784）；**每轮 target 由结算交易写入并配事件**，前端读 `/api/rounds/:id` 的 targetPrice，未写入时显示「待结算写入」。
- `roundRewardRaw = 700000000e9`，`totalSupplyRaw = 1e10 * 1e9`。
- Round 1：`SUCCEEDED`（10/12 达标，7 亿已解锁 + 团队 1.2 亿已释放）；Round 2：`FAILED_PERMANENT`（6/12，已销毁 7 亿奖励 + 1.2 亿团队额度 + 241,500,000 质押本金 = **1,061,500,000 A9**）。
- Round 3：`OBSERVING`，观察中，K 线随时间推进（演示加速 `DEMO_CANDLE_SECONDS`，默认 90s/根），达标判定用 `twap >= target`。
- Round 4：`UNOPENED`（上一轮结算后可开启）。
- 演示加速只影响 K 线进度条与报名窗口（`DEMO_STAKE_SECONDS`，默认 900s/轮），**判定规则、8/12 阈值、销毁语义必须与规格一致**；真实参数为报名 **72h**（`STAKE_DURATION_SECONDS = 259200`）、轮次间隔 **0**（`STAKE_GAP_SECONDS = 0`，结算后立即开启）。
- 分配口径（V5.5）：十轮奖励 70%（每轮 7 亿）、内盘销售 8%（8 亿 A9）、流动性 5%（5 亿 A9）、团队 12%（每轮 1.2 亿，成功释放/失败销毁）、营销 5%（个人钱包持有，不设多签）；冷启动池 1 亿 A9 + $116,000（占流动性 20%），初始流通 8%（8 亿 A9）≈ $928,000。
- 演示地址：8~12 个 `UQ...` 假地址 + 随机质押，聚合出排行榜；`/api/me` 对未质押地址返回空对象。
- 销毁账本：`burn_ledger` 记录每次销毁（轮次、类型 `reward` / `team` / `principal`、数量、确认状态），供应量 = 初始 - 已确认销毁；R2 三笔合计 1,061,500,000 A9。
- 团队释放（成功轮）：TeamVault 将 `teamRoundRaw = 120000000e9` 转出到团队收款钱包；失败轮 TeamVault 销毁 1.2 亿。前端展示团队额度已释放/已销毁状态（若面板涉及团队分配）。
- 领取（V5）：MyPage 必须展示**所有已结算轮次（含历史未领）**的可领本金/奖励，支持一次 `claimAll` 领取多轮（合并一笔交易）；演示环境走 `/api/claim`，真实链上由用户自付 gas。

不改动不可变语义：失败轮次不得反向恢复；预言机暂停不销毁本金；K 线未满 12 根不得判失败。

## 7. 视觉还原要求（frontend-dev）

1. `web/src/styles/fuse.css` 已从原型抽出（364 行），**直接使用这些 class**：`.hero .hud .board .cmd .cells .cell .score .verdict .result .floor .panel .ladder .lrow .steps .sand .diff .alloc .tbl .warn .demo .toast` 等。
2. 字体、颜色、间距、动效（tape 循环、K 线 flash、canvas 图表、悬停 tooltip）都必须还原。
3. canvas 图表（价格线 + 目标线 + 12 列 K 线 + 上下填充 + 标签）按原型 `drawChart()` 逻辑移植到 React，保留降级行为（宽度为 0 时不报错）。
   - **目标价来源（V5.4）**：以 API 返回的该轮 `targetPriceUsdE8` 为准（来自链上结算写入 + 事件）；10 轮阶梯仅用于展示时按 `P0 × 2^n` 离线计算，**不要假设链上预存 10 个价格**。
4. 所有文案走中英双语（`useDict(ZH, EN)` / `useLang()`），默认中文，右上角可切换，选择持久化。
5. 数据来自 API（`useQuery`），**不要保留本地模拟数据**。API 失败时展示骨架/错误态，不要白屏。
6. 响应式：≥960px 双栏（board + command），<960px 单列，移动端保留底部 `.mcta` 操作条。
7. **阶梯展示（D-28 待确认）**：当前按「轮次」展示；若采纳 D-28「失败同档重试」，必须改为「**档位（tier）**」视图——`tier = 1 + 已成功轮数`，同一档位可能对应多轮（失败占用轮次），10 轮不再等于 10 个档位。未定案前保持轮次视图。
8. **质押不可取消（已确认）**：UI 不提供取消/提前退出按钮；质押后锁定至成功领取或失败销毁，唯一退款路径是技术性终止；风险确认文案需说明「不可取消」。

## 8. 本地开发

```bash
npm install                 # 根目录，安装 web + worker
npm run dev:worker          # 终端 1：wrangler dev（127.0.0.1:8787，本地 D1）
npm run dev                 # 终端 2：vite（127.0.0.1:5173，/api 代理到 8787）
npm run typecheck           # 前后端 TS 检查
npm run build               # 构建 web/dist
```

本地 D1 首次需要：`cd worker && npx wrangler d1 migrations apply fuse-protocol --local`（含 seed）。

## 9. 部署（Lead 执行，最终验收）

```bash
cd worker
npx wrangler d1 migrations apply fuse-protocol --remote
npx wrangler d1 execute fuse-protocol --remote --file=./migrations/seed.sql
npx wrangler secret put ADMIN_TOKEN
cd .. && npm run build && cd worker && npx wrangler deploy
```

临时域名：`https://fuse-protocol.348421501.workers.dev`（account subdomain：348421501）。
> 注：仓库内资源名（D1 `fuse-protocol`、`fuse.css`、原型文件名、函数 `fuseBalance`）沿用历史命名，**对外品牌与代币统一为 A9**，不改资源名（避免破坏已绑定部署）。
生效后必须验证：首页 200、`/api/health` ok、`/api/rounds` 返回 10 轮、`/me`、`/leaderboard`、`/admin` 可打开、移动端布局正常。

## 10. 完成标准（Definition of Done）

- `npm run typecheck` 0 error；`npm run build` 成功。
- 所有页面在 1440 / 768 / 390 宽度下无横向溢出、无重叠。
- 落地页与原型对比：版块齐全、配色/字体一致、图表与 12 格 K 线可交互、沙盘推演可点击。
- API 全部实现且被前端真实调用（Network 里能看到轮询）。
- 中英切换覆盖全站可见文案；刷新后语言保持。
- 管理员后台能登录（token）、暂停/恢复预言机、推进轮次；后台只暴露最小权限操作（不可改已开轮参数、不可转移质押本金、无升级入口）。
- README/运维文档更新，部署命令可复现。


## 12. 钱包模块契约（强制）

`web/src/features/wallet/index.ts` 必须导出以下 API，landing 与 app 页面都只依赖这份契约：

```ts
export interface WalletState {
  address: string | null;      // TON 地址（UQ...）；未连接为 null
  connected: boolean;
  connecting: boolean;
  demo: boolean;               // true = 降级演示钱包（非真实 TON Connect）
  tonBalance: string | null;   // TON 余额，人类可读字符串（"1250.42"）
  fuseBalance: string | null;  // A9 余额，raw units 字符串（9 位精度）；字段名沿用历史命名
  error: string | null;
  connect: () => void;
  disconnect: () => void;
  refreshBalances: () => void;
}
export function useWallet(): WalletState;
export function WalletProvider(props: { children: React.ReactNode }): JSX.Element;
export function WalletButton(): JSX.Element;
```

规则：
- 地址变化 → `refreshBalances()` 自动触发，并让 `useQuery` 依赖 address 的页面自动刷新。
- TON Connect 只读：真实钱包可连接/断开、展示地址与余额；**任何交易按钮禁用**并提示「合约部署后开放」。
- 合约部署后（后续阶段）：质押走 Jetton transfer + payload；领取走 `claim`/`claimAll`（可带 roundId 列表，最多 10 轮，合并一笔交易，gas 由用户承担）；每笔操作需回执与幂等刷新。
- 连接失败/用户拒绝/环境不支持 → 自动降级 `demo: true`：本地生成 `UQ...` 地址存 localStorage，余额来自 `/api/me`（无则显示 0）。
- `WalletProvider` 由 Lead 在 `App.tsx` 统一挂载（已挂载则勿重复）。若需要修改 `App.tsx`，消息 Lead。

## 13. 演示模式下的买入行为

`/api/*` **没有 swap/buy 端点**（避免伪造真实成交）。CommandPanel 的买入：
- 报价按 `config.tonUsdE8`（演示 $3.00）+ 0.3% 手续费 + 加深池价格影响实时计算；
- 点击买入：演示钱包内本地扣减 TON、增加 A9，并明确 toast「演示环境不产生真实交易」；
- 真实钱包（demon:false）点击买入 → 提示「合约部署后开放」，不做任何状态变更。

