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
  /** 限流阈值：每个 IP+路径 每分钟请求数（默认 30；admin/stake/claim） */
  RATE_LIMIT_PER_MINUTE?: string;
  /** /api/auth/nonce 单独更低配额（默认 10/min） */
  RATE_LIMIT_NONCE_PER_MINUTE?: string;
  /** 协议只读 GET 的内存级限流（默认 120/min，不写 D1） */
  RATE_LIMIT_READ_PER_MINUTE?: string;
  /** 静态资源 GET 的内存级限流（默认 600/min） */
  RATE_LIMIT_STATIC_PER_MINUTE?: string;

  // ---- chain 模式（索引器 / 真实链上数据源，task-39）----
  /** toncenter API key（chain 模式必须；缺失则拒绝启动并报 ORACLE_PAUSED） */
  TONCENTER_API_KEY?: string;
  /** 本地调试允许无 key 直连公共端点（仅显式=1 时生效） */
  TONCENTER_ALLOW_PUBLIC?: string;
  TONCENTER_V2_URL?: string;
  TONCENTER_V3_URL?: string;
  /** 'mainnet' | 'testnet' */
  CHAIN_NETWORK?: string;
  ROUND_CONTROLLER_ADDRESS?: string;
  TEAM_VAULT_ADDRESS?: string;
  JETTON_MASTER_ADDRESS?: string;
  ORACLE_CONFIG_VERSION?: string;
  ORACLE_CONFIG_HASH?: string;
  /** 索引器租约 TTL（秒，默认 120） */
  INDEXER_LEASE_SECONDS?: string;
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

/**
 * H-6：chain 模式启动前置校验。缺失 TONCENTER_API_KEY（且未显式 TONCENTER_ALLOW_PUBLIC=1）
 * 时不允许降级运行——调用方应返回 ORACLE_PAUSED / 跳过 indexer tick。
 */
/**
 * chain 模式必须由链上/索引器写入的关键配置键（B6）。
 * 缺失时不允许回退本地常量对外服务，调用方应返回 ORACLE_PAUSED。
 */
export const CHAIN_REQUIRED_CONFIG_KEYS = [
  'p0_usd_e8',
  'round_reward_raw',
  'total_supply_raw',
  'min_stake_raw',
  'max_total_stake_raw',
  'candle_count',
  'candle_seconds',
  'min_qualified_candles',
  'observation_seconds',
  'stake_duration_seconds',
  'risk_disclosure_version',
] as const;

export function missingChainConfigKeys(kv: Map<string, string>): string[] {
  return CHAIN_REQUIRED_CONFIG_KEYS.filter((key) => {
    const value = kv.get(key);
    return value === undefined || value.trim() === '';
  });
}

export function chainConfigError(env: Env, kv?: Map<string, string>): string | null {
  const dataSource = (env.DATA_SOURCE ?? 'demo').trim();
  if (dataSource !== 'chain') return null;
  if (env.TONCENTER_ALLOW_PUBLIC !== '1' && (!env.TONCENTER_API_KEY || !env.TONCENTER_API_KEY.trim())) {
    return 'chain 模式缺少 TONCENTER_API_KEY（本地调试可显式 TONCENTER_ALLOW_PUBLIC=1）';
  }
  if (kv) {
    const missing = missingChainConfigKeys(kv);
    if (missing.length > 0) {
      return 'chain 模式缺少链上配置：' + missing.join(', ') + '（禁止回退本地常量）';
    }
  }
  return null;
}

/** D1 schema 版本，与 migrations 文件名一致，健康检查里暴露用于上线核对。 */
export const SCHEMA_VERSION = 9;

/** Worker 默认语义化版本。 */
export const DEFAULT_VERSION = '1.0.0';