/**
 * 军饷自动化（任务单 D）。两件事，都只在 D1 去重后执行一次，且永不抛出（失败只写审计日志）：
 *
 *  1. 单城重算：索引器摄入 RoundSettled 后，对该城运行一次 computeRoundJunxiang（去重键 junxiang:R<n>）。
 *     注意：守城补贴依赖次城报名数据，结算时次城尚未报名，因此这一次的守城补贴可能偏少；
 *     次城进入 OBSERVING（报名已截止）时由 runGuardPassAfterObserving 再重算一次上一城（去重键 junxiang:R<n>:guard-pass）。
 *     仍需要时运维用 POST /api/admin/junxiang/compute 重算（覆盖写入，幂等）。
 *
 *  2. 每周累计清单：每周一 00:00 UTC（去重键 payout-week:<ISO 周>）调用与管理端相同的 buildPayoutList，
 *     构建并落库，记录一条审计事件告诉运维「新根已就绪、需充值的总额」。**不上链**：根由运维先给
 *     分发合约充值，再手动 SetRoot（ops/README §5.3）。
 *
 * 去重口径同 bot/candle-hook.ts：INSERT OR IGNORE 占位成功才执行。
 */
import type { Env } from '../env';
import * as store from '../store';
import { computeRoundJunxiang } from './runner';
import { buildPayoutList, type PayoutListSummary } from './payout';

/** 自动化任务去重：占位成功（首次）返回 true；已占位返回 false。 */
export async function claimAutoJob(env: Env, key: string, kind: string, now: number): Promise<boolean> {
  const res = await env.DB.prepare('INSERT OR IGNORE INTO auto_jobs (job_key, kind, created_at) VALUES (?, ?, ?)')
    .bind(key, kind, now)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export interface JunxiangAutoDeps {
  /** 单城重算（测试注入用，默认 computeRoundJunxiang） */
  compute?: (roundId: number, now: number) => Promise<unknown[]>;
}

/**
 * 守城补贴第二次触发：索引器 tick 中某城首次进入 OBSERVING（次城报名已截止）时，对上一城再运行一次
 * computeRoundJunxiang（覆盖写入该城军饷行）。每个上一城只跑一次（去重键 junxiang:R<上一城>:guard-pass）。
 * 第 1 城没有上一城，跳过。返回本次真正执行成功的城数。永不抛出。
 */
export async function runGuardPassAfterObserving(
  env: Env,
  observedRoundIds: readonly number[],
  now: number,
  deps: JunxiangAutoDeps = {},
): Promise<number> {
  let done = 0;
  try {
    const compute = deps.compute ?? ((roundId: number, at: number) => computeRoundJunxiang(env as never, roundId, at));
    const previousRounds = [...new Set(observedRoundIds)]
      .filter((roundId) => roundId > 1)
      .map((roundId) => roundId - 1)
      .sort((a, b) => a - b);
    for (const roundId of previousRounds) {
      try {
        const fresh = await claimAutoJob(env, 'junxiang:R' + roundId + ':guard-pass', 'junxiang-guard', now);
        if (!fresh) continue;
        const rows = await compute(roundId, now);
        done++;
        await store.logEvent(env, 'info', 'payout', 'JUNXIANG_GUARD_PASS_DONE', 'R' + roundId + ' rows=' + rows.length, now);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await store
          .logEvent(env, 'warn', 'payout', 'JUNXIANG_GUARD_PASS_FAILED', 'R' + roundId + ' ' + message.slice(0, 200), now)
          .catch(() => undefined);
      }
    }
  } catch (err) {
    console.warn('[payout] 守城补贴二次重算整体失败', err);
  }
  return done;
}

/**
 * 索引器 tick 结束后调用：对本批新结算的城各运行一次军饷重算。返回本次真正执行成功的城数。永不抛出。
 */
export async function runJunxiangAfterSettlement(
  env: Env,
  roundIds: readonly number[],
  now: number,
  deps: JunxiangAutoDeps = {},
): Promise<number> {
  let done = 0;
  try {
    const compute = deps.compute ?? ((roundId: number, at: number) => computeRoundJunxiang(env as never, roundId, at));
    for (const roundId of [...new Set(roundIds)].sort((a, b) => a - b)) {
      try {
        const fresh = await claimAutoJob(env, 'junxiang:R' + roundId, 'junxiang', now);
        if (!fresh) continue;
        const rows = await compute(roundId, now);
        done++;
        await store.logEvent(env, 'info', 'payout', 'JUNXIANG_AUTO_DONE', 'R' + roundId + ' rows=' + rows.length, now);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await store
          .logEvent(env, 'warn', 'payout', 'JUNXIANG_AUTO_FAILED', 'R' + roundId + ' ' + message.slice(0, 200), now)
          .catch(() => undefined);
      }
    }
  } catch (err) {
    console.warn('[payout] 单城军饷自动重算整体失败', err);
  }
  return done;
}

/** ISO 周键（UTC），如 2026-W01。2025-12-29（周一）属于 2026-W01。 */
export function isoWeekKey(now: number): string {
  const date = new Date(now);
  const day = date.getUTCDay() || 7; // 周一 = 1 … 周日 = 7
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return thursday.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

/** 每周构建时刻：周一 00:xx UTC（cron 每分钟触发，由去重保证每周只构建一次）。 */
export function isWeeklyPayoutSlot(now: number): boolean {
  const date = new Date(now);
  return date.getUTCDay() === 1 && date.getUTCHours() === 0;
}

export interface WeeklyPayoutDeps {
  /** 已结算的城号（测试注入用，默认读 rounds.result 非空的城） */
  settledRoundIds?: () => Promise<number[]>;
  /** 构建清单（测试注入用，默认 buildPayoutList(env, 1, 最大已结算城, now)，与管理端同函数） */
  build?: (fromRound: number, toRound: number, now: number) => Promise<PayoutListSummary>;
}

/**
 * scheduled() 每分钟调用：周一 00:xx UTC 且本周未构建过时，构建一次累计清单并记审计。
 * 返回构建结果；非构建时刻 / 已构建 / 尚无已结算城 返回 null。永不抛出。
 */
export async function runWeeklyPayoutBuild(env: Env, now: number, deps: WeeklyPayoutDeps = {}): Promise<PayoutListSummary | null> {
  try {
    if (!isWeeklyPayoutSlot(now)) return null;
    const week = isoWeekKey(now);
    // 尚无已结算城时不占位：同一小时内后续的分钟 tick 还能补做
    const settled = deps.settledRoundIds
      ? await deps.settledRoundIds()
      : (await store.listRounds(env)).filter((row) => row.result !== null).map((row) => row.round_id);
    if (settled.length === 0) return null;
    const fresh = await claimAutoJob(env, 'payout-week:' + week, 'payout-week', now);
    if (!fresh) return null;

    const toRound = Math.max(...settled);
    const build = deps.build ?? ((from: number, to: number, at: number) => buildPayoutList(env, from, to, at));
    const summary = await build(1, toRound, now);
    await store.logEvent(
      env,
      'info',
      'payout',
      'PAYOUT_ROOT_READY',
      'week=' + week +
        ' listId=' + summary.listId +
        ' root=' + summary.root +
        ' wallets=' + summary.leafCount +
        ' fundTotalRaw=' + summary.totalRaw +
        ' 请先给分发合约充值（累计总额，已领部分以链上 totalPaidRaw 为准），再发布该根（ops/README §5.3）',
      now,
    );
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store
      .logEvent(env, 'error', 'payout', 'PAYOUT_WEEKLY_FAILED', message.slice(0, 240), now)
      .catch(() => undefined);
    return null;
  }
}
