# FUSE 引信协议 · 开发与运维入口

> 产品/经济/合约规格见 [README.md](README.md) 与 [docs/01~08](docs/)。
> 本次前后端实施基线见 [docs/09_FRONTEND_BUILD.md](docs/09_FRONTEND_BUILD.md)。
> 上线与运营剩余工作见 [docs/10_LAUNCH_READINESS.md](docs/10_LAUNCH_READINESS.md)。

## 结构

```
BAM/
├─ web/          React 19 + Vite + TypeScript 前端（视觉 1:1 还原 FUSE 引信协议.html）
├─ worker/       Cloudflare Worker API + D1 迁移/种子（同时托管 web/dist 静态资源）
├─ shared/       前后端共享 API 契约（金额 raw units、价格 USD_E8）
├─ docs/         业务规格（01~08）+ 实施基线（09）+ 上线清单（10）
└─ .github/      CI：typecheck → build → D1 migrate → deploy
```

线上（演示数据模式）：<https://fuse-protocol.348421501.workers.dev>

## 本地开发

```bash
npm install                    # pnpm workspace（本机 npm 为 pnpm 包装器）
npm run db:migrate:local       # 首次：本地 D1 建表
npm run db:seed:local          # 首次：写入演示数据
npm run dev:worker             # 终端 1：http://127.0.0.1:8787
npm run dev                    # 终端 2：http://127.0.0.1:5173（/api 自动代理）
npm run typecheck && npm run build
```

## 部署

```bash
cd worker
./node_modules/.bin/wrangler d1 migrations apply fuse-protocol --remote
./node_modules/.bin/wrangler d1 execute fuse-protocol --remote --file=./migrations/seed.sql
./node_modules/.bin/wrangler secret put ADMIN_TOKEN       # 运维后台 token
cd .. && npm run build && cd worker && ./node_modules/.bin/wrangler deploy
```

自定义域名：

```bash
cd worker && ./node_modules/.bin/wrangler domains add fuse.<your-domain>
```

## 环境变量（worker/wrangler.toml）

| 变量 | 说明 |
| --- | --- |
| `DATA_SOURCE` | `demo`（默认，演示数据）/ `chain`（真实链上，待实现） |
| `DEMO_CANDLE_SECONDS` | 演示加速：一根 4h K 线用多少秒走完 |
| `DEMO_WALLET_BALANCE` | 演示钱包余额（raw units） |
| `ADMIN_TOKEN` | 运维后台 Bearer token（secret，不写进配置文件） |
| `ALLOWED_ORIGINS` | CORS 白名单 |

## 运维

- 健康检查：`GET /api/health`
- 运维后台：`/admin`（Bearer token）
- D1 备份：`./node_modules/.bin/wrangler d1 export fuse-protocol --remote --output=backup.sql`
- 回滚：`./node_modules/.bin/wrangler rollback`
## 线上环境（演示数据模式）

| 项 | 值 |
| --- | --- |
| 站点 | https://fuse-protocol.348421501.workers.dev |
| Worker | fuse-protocol（Cloudflare Workers，含静态资源） |
| D1 | fuse-protocol / b5945609-374e-4eaa-add2-80460ebcb680（APAC） |
| 定时任务 | `* * * * *`（推进演示轮次 / DEMO_AUTOPLAY 自动开轮） |
| 运维后台 | `/admin`（Bearer token，见 worker secret `ADMIN_TOKEN`） |
| 健康检查 | `/api/health`、`/api/version` |

### 重新灌演示数据（部署前必做，让 R3 锚定部署时刻）

```bash
cd worker
node scripts/generate-seed.mjs                                  # 重新生成 migrations/seed.sql
./node_modules/.bin/wrangler d1 execute fuse-protocol --remote --file=./migrations/seed.sql
cd .. && npm run build && cd worker && ./node_modules/.bin/wrangler deploy
```

### 绑定自定义域名

```bash
cd worker && ./node_modules/.bin/wrangler domains add fuse.example.com
```
绑定后把 `web/public/tonconnect-manifest.json` 里的 url / iconUrl 与新域名同步，并同步 `sitemap.xml`。

### 密钥

- `ADMIN_TOKEN`：`wrangler secret put ADMIN_TOKEN`（本地开发放 `worker/.dev.vars`，已 gitignore）。
- 轮换：重新 `secret put` 后旧 token 立即失效；轮换后需在 `/admin` 重新登录。

### 缓存与安全头

- `/assets/*`：`public, max-age=31536000, immutable`（构建产物带 hash）。
- HTML：`public, max-age=0, must-revalidate`。
- `/api/*`：`no-store`（内部 1s 微缓存）。
- 全局：nosniff / X-Frame-Options: DENY / Referrer-Policy / Permissions-Policy / COOP；严格 CSP 待 TON Connect 桥域名冻结后补（见 docs/10 §12）。

### 验收脚本

```bash
cd qa
node shots.mjs https://fuse-protocol.348421501.workers.dev final   # 三端全站截图 + 溢出/console 检查
ADMIN_TOKEN=xxx node e2e.mjs https://fuse-protocol.348421501.workers.dev   # 13 项交互验收
```
