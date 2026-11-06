/**
 * 索引器健康状态（写 D1 metrics；sources/chain.ts 的 oracleStatus 只读这里，保持纯同步、零网络）。
 *
 * 判定口径：
 *  - healthy=1 且 lastOkAt 在 3 个轮询周期内、无 config mismatch → online；
 *  - 缺 API key / 连续失败 / 配置不一致 → paused（前端 ORACLE_PAUSED），价格返回 0；
 *  - 任何情况下都不回退 demo 数据。
 */
import type { Env } from '../env';
import * as store from '../store';

export const HEALTH_KEY = {
  healthy: 'chain_sync_healthy',
  error: 'chain_sync_error',
  okAt: 'chain_sync_ok_at',
  failStreak: 'chain_sync_fail_streak',
  unknownOps: 'chain_unknown_ops',
  configVersion: 'chain_config_version',
  configHash: 'chain_config_hash',
  configMismatch: 'chain_config_mismatch',
  lastPages: 'chain_last_pages',
  lastEvents: 'chain_last_events',
  nextPollAt: 'chain_next_poll_at',
  bootstrapped: 'chain_bootstrapped',
  price24hAgo: 'price_24h_ago_usd_e8',
  liquidity: 'chain_liquidity_usd_e8',
} as const;

export interface ChainHealth {
  /** 最近一次同步成功且有配置锚定 */
  healthy: boolean;
  paused: boolean;
  error: string | null;
  lastOkAt: number;
  failStreak: number;
  unknownOps: number;
  configVersion: string;
  configHash: string | null;
  /** 配置版本/hash 与期望不一致（拒绝出数） */
  configMismatch: boolean;
}

/** 从 D1 key-value 快照推导健康状态（纯函数，chain.ts 直接调用）。 */
export function readChainHealth(kv: Map<string, string>): ChainHealth {
  const healthy = kv.get(HEALTH_KEY.healthy) === '1';
  const error = kv.get(HEALTH_KEY.error) ?? null;
  const lastOkAt = Number(kv.get(HEALTH_KEY.okAt) ?? '0') || 0;
  const failStreak = Number(kv.get(HEALTH_KEY.failStreak) ?? '0') || 0;
  const unknownOps = Number(kv.get(HEALTH_KEY.unknownOps) ?? '0') || 0;
  const configMismatch = kv.get(HEALTH_KEY.configMismatch) === '1';
  return {
    healthy: healthy && !configMismatch,
    paused: !healthy || configMismatch || error !== null,
    error,
    lastOkAt,
    failStreak,
    unknownOps,
    configVersion: kv.get(HEALTH_KEY.configVersion) ?? 'unconfigured',
    configHash: kv.get(HEALTH_KEY.configHash) ?? null,
    configMismatch,
  };
}

/** 标记一次成功同步（同时写轮询间隔/统计与价格缓存）。 */
export async function markHealthy(
  env: Env,
  input: { now: number; nextPollAt: number; pages: number; events: number; configVersion?: string; configHash?: string },
): Promise<void> {
  await store.setMetrics(
    env,
    {
      [HEALTH_KEY.healthy]: '1',
      [HEALTH_KEY.error]: '',
      [HEALTH_KEY.okAt]: String(input.now),
      [HEALTH_KEY.failStreak]: '0',
      [HEALTH_KEY.lastPages]: String(input.pages),
      [HEALTH_KEY.lastEvents]: String(input.events),
      [HEALTH_KEY.nextPollAt]: String(input.nextPollAt),
      ...(input.configVersion ? { [HEALTH_KEY.configVersion]: input.configVersion } : {}),
      ...(input.configHash ? { [HEALTH_KEY.configHash]: input.configHash } : {}),
    },
    input.now,
  );
}

/** 标记一次失败/降级；fatal（key 失效等）会拉长重试间隔，但仍不跑 demo 兜底。 */
export async function markFailure(
  env: Env,
  input: { now: number; error: string; retryAfterMs: number; configMismatch?: boolean; unknownOps?: number },
): Promise<void> {
  const kv = await store.getKeyValues(env);
  const streak = (Number(kv.get(HEALTH_KEY.failStreak) ?? '0') || 0) + 1;
  await store.setMetrics(
    env,
    {
      [HEALTH_KEY.healthy]: '0',
      [HEALTH_KEY.error]: input.error.slice(0, 400),
      [HEALTH_KEY.failStreak]: String(streak),
      [HEALTH_KEY.nextPollAt]: String(input.now + Math.max(5_000, input.retryAfterMs)),
      ...(input.configMismatch ? { [HEALTH_KEY.configMismatch]: '1' } : {}),
      ...(input.unknownOps !== undefined ? { [HEALTH_KEY.unknownOps]: String(input.unknownOps) } : {}),
    },
    input.now,
  );
}

/** 清掉配置不一致标记（配置重新对齐时调用）。 */
export async function clearMismatch(env: Env, now: number): Promise<void> {
  await store.setMetrics(env, { [HEALTH_KEY.configMismatch]: '0' }, now);
}
