/**
 * Worker 运行时环境与全局常量。
 * 变量来源：wrangler.toml [vars]、wrangler secret（ADMIN_TOKEN）、D1 绑定。
 */

export interface Env {
  /** D1 数据库绑定 */
  DB: D1Database;
  /** 静态资源绑定（web/dist） */
  ASSETS: Fetcher;
  /** 'demo' | 'chain' —— 数据适配层选择 */
  DATA_SOURCE?: string;
  /** 演示模式下 1 根 K 线的真实秒数（默认 90，真实模式忽略） */
  DEMO_CANDLE_SECONDS?: string;
  /** 演示钱包初始余额（raw units，仅用于质押校验） */
  DEMO_WALLET_BALANCE?: string;
  /** 演示自维持开关（true/false，默认 true；DATA_SOURCE=chain 时强制关闭） */
  DEMO_AUTOPLAY?: string;
  /** 演示质押窗口时长（秒，默认 900） */
  DEMO_STAKE_SECONDS?: string;
  /** 演示模式「解锁中」展示时长（秒，默认 1800）：R10 终态后先展示 ClaimUnlocked 再重置演示 */
  DEMO_UNLOCK_SECONDS?: string;
  DEMO_PREVIEW_SECONDS?: string;
  /** CORS 允许来源，'*' 或逗号分隔白名单 */
  ALLOWED_ORIGINS?: string;
  /** 管理端 Bearer Token（wrangler secret 注入） */
  ADMIN_TOKEN?: string;
  /** 语义化版本（构建/部署注入） */
  VERSION?: string;
  /** git sha（构建/部署注入，可空） */
  GIT_SHA?: string;
  /** 部署时间 ISO 字符串（可空） */
  DEPLOYED_AT?: string;
  /** GET 微缓存秒数，0 关闭（默认 1） */
  EDGE_CACHE_SECONDS?: string;
  /** TON Connect manifest 地址（默认 /tonconnect-manifest.json） */
  TONCONNECT_MANIFEST_URL?: string;
  /** demo 模式是否允许无签名写接口（必须显式 'true'；默认拒绝） */
  DEMO_ALLOW_UNSIGNED_WRITES?: string;
  /** ton_proof 允许的 domain（逗号分隔，大小写不敏感） */
  TON_PROOF_DOMAINS?: string;
  /** 限流阈值：每个 IP+路径 每分钟请求数（默认 30） */
  RATE_LIMIT_PER_MINUTE?: string;
}

/**
 * 当前 isolate 启动时间（毫秒）。惰性初始化：模块顶层取时间在 workerd 下不可靠，
 * 由 index.ts 在首个 fetch / scheduled 入口调用 markIsolateStarted()。
 */
let startedAtMs = 0;

export function markIsolateStarted(now = Date.now()): void {
  if (startedAtMs === 0) startedAtMs = now;
}

export function uptimeSeconds(now = Date.now()): number {
  if (startedAtMs === 0) return 0;
  return Math.max(0, Math.floor((now - startedAtMs) / 1000));
}

/** D1 schema 版本，与 migrations 文件名一致，健康检查里暴露用于上线核对。 */
export const SCHEMA_VERSION = 7;

/** Worker 默认语义化版本。 */
export const DEFAULT_VERSION = '1.0.0';