/**
 * 链上索引器编排层（cron 单写者）。
 *
 * 约定（与 backend-dev 的 index.ts 接线一致）：
 *  - tick / reconcile **永不抛出**；失败通过返回值表达，cron 不能用异常打断。
 *  - 所有网络请求只发生在这里；sources/chain.ts 保持纯同步、零网络。
 */
import type { Env } from '../env';

/** 单次 tick 的结果。必填字段是 backend-dev 接线依赖的最小集合，其余为诊断扩展（可选）。 */
export interface IndexerTickResult {
  ok: boolean;
  /** 未真正同步的原因：租约被占 / 未到轮询时间 / 配置不一致；正常跑完不带该字段 */
  skipped?: 'lease' | 'not_due' | 'config_mismatch' | 'not_chain' | 'no_api_key';
  pages: number;
  writes: number;
  error?: string;
  // ---- 诊断扩展（可选，前端/日志可用，接线上不依赖）----
  /** 本次消费的事件数 */
  events?: number;
  /** 本次落库的 K 线数 */
  candles?: number;
  /** 本次落库的质押数 */
  stakes?: number;
  /** 本次落库的领取数 */
  claims?: number;
  /** 健康判定（false = 已进入 ORACLE_PAUSED 降级） */
  healthy?: boolean;
}

/**
 * 单次 cron tick：租约 → 引导 → 分页拉取 → 解码 → 写库 → getter 锚定 → 健康判定。
 * TODO(indexer-dev)：实现见 worker/src/indexer/{chain-client,boc,getters,sync}.ts
 */
export async function tick(_env: Env, _now: number): Promise<IndexerTickResult> {
  return { ok: false, pages: 0, writes: 0, error: 'indexer not implemented' };
}

/** 全量对账（仅 admin/CLI 触发）：返回 diff 字符串列表，空数组 = 一致。 */
export async function reconcile(_env: Env, _now: number): Promise<{ ok: boolean; diffs: string[] }> {
  return { ok: false, diffs: ['indexer not implemented'] };
}
