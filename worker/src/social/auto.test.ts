/**
 * 军饷自动化单测（任务单 D）：真实 SQLite（node:sqlite）上应用 migrations 0001..0016，
 * 通过最小 D1 适配器驱动 auto.ts 的真实 SQL（auto_jobs 去重、admin_events 审计）。
 *
 * 运行（worker 目录）：npm run test:social
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../env';
import {
  claimAutoJob,
  isWeeklyPayoutSlot,
  isoWeekKey,
  runGuardPassAfterObserving,
  runJunxiangAfterSettlement,
  runWeeklyPayoutBuild,
} from './auto';
import type { PayoutListSummary } from './payout';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

interface TestDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

function openDb(): TestDb {
  const db = new DatabaseSync(':memory:') as unknown as TestDb;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(files.includes('0016_auto_jobs.sql'), '迁移 0016 必须存在');
  for (const name of files) db.exec(readFileSync(MIGRATIONS_DIR + name, 'utf8'));
  return db;
}

/** 最小 D1 适配器：prepare().bind().run/all/first 与 batch。 */
function fakeD1(db: TestDb): Env['DB'] {
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...values: unknown[]) {
        bound = values;
        return stmt;
      },
      async run() {
        const res = db.prepare(sql).run(...(bound as never[]));
        return { success: true, meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) } };
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...(bound as never[])) };
      },
      async first() {
        const row = db.prepare(sql).get(...(bound as never[]));
        return row ? { ...row } : null;
      },
    };
    return stmt;
  };
  return { prepare } as unknown as Env['DB'];
}

function envOf(db: TestDb): Env {
  return { DB: fakeD1(db) } as unknown as Env;
}

function auditActions(db: TestDb): string[] {
  return (db.prepare('SELECT action FROM admin_events ORDER BY id').all() as Array<{ action: string }>).map((row) => row.action);
}

// 2026-11-02 是周一（UTC）。下面的断言在运行时自检，避免日期推算写错。
const MON_0005 = Date.UTC(2026, 10, 2, 0, 5);
const MON_0030 = Date.UTC(2026, 10, 2, 0, 30);
const TUE_0005 = Date.UTC(2026, 10, 3, 0, 5);
const NEXT_MON_0005 = Date.UTC(2026, 10, 9, 0, 5);

test('自检：测试用的日期落在预期的星期几', () => {
  assert.equal(new Date(MON_0005).getUTCDay(), 1);
  assert.equal(new Date(TUE_0005).getUTCDay(), 2);
  assert.equal(new Date(NEXT_MON_0005).getUTCDay(), 1);
});

test('去重：同一键只占位一次；不同键互不影响', async () => {
  const db = openDb();
  const env = envOf(db);
  assert.equal(await claimAutoJob(env, 'junxiang:R1', 'junxiang', 1), true);
  assert.equal(await claimAutoJob(env, 'junxiang:R1', 'junxiang', 2), false);
  assert.equal(await claimAutoJob(env, 'junxiang:R2', 'junxiang', 3), true);
  const row = db.prepare("SELECT created_at FROM auto_jobs WHERE job_key = 'junxiang:R1'").get() as { created_at: number };
  assert.equal(row.created_at, 1, '重复占位不覆盖首次时间');
});

test('ISO 周键：跨年周按 ISO 归属', () => {
  assert.equal(isoWeekKey(Date.UTC(2024, 11, 30)), '2025-W01'); // 周一，属于 2025 年第 1 周
  assert.equal(isoWeekKey(Date.UTC(2025, 11, 29)), '2026-W01'); // 周一，属于 2026 年第 1 周
  assert.equal(isoWeekKey(Date.UTC(2026, 0, 5)), '2026-W02');
  assert.equal(isoWeekKey(Date.UTC(2026, 10, 8, 23, 59)), '2026-W45'); // 周日仍属于本周
});

test('每周构建时刻：只有周一 00:xx UTC 为真', () => {
  assert.equal(isWeeklyPayoutSlot(MON_0005), true);
  assert.equal(isWeeklyPayoutSlot(MON_0030), true);
  assert.equal(isWeeklyPayoutSlot(Date.UTC(2026, 10, 2, 1, 0)), false);
  assert.equal(isWeeklyPayoutSlot(TUE_0005), false);
});

test('单城重算去重：每个结算城只跑一次；重放与同批重复都不再算；失败不抛出且不重试', async () => {
  const db = openDb();
  const env = envOf(db);
  const computed: number[] = [];
  let failRound3 = true;
  const compute = async (roundId: number) => {
    if (roundId === 3 && failRound3) throw new Error('boom');
    computed.push(roundId);
    return [{ roundId }];
  };

  // 同一批里重复的 2 只算一次；3 失败但不抛出
  const first = await runJunxiangAfterSettlement(env, [2, 1, 2, 3], 10, { compute });
  assert.equal(first, 2, '成功的城数');
  assert.deepEqual(computed, [1, 2]);
  assert.ok(auditActions(db).includes('JUNXIANG_AUTO_FAILED'), '失败写审计');
  assert.ok(auditActions(db).includes('JUNXIANG_AUTO_DONE'));

  // 索引器重放：同样的城号再次到来，不再计算（包括已失败的 3：占位已存在，不自动重试）
  failRound3 = false;
  const replay = await runJunxiangAfterSettlement(env, [1, 2, 3], 20, { compute });
  assert.equal(replay, 0);
  assert.deepEqual(computed, [1, 2]);

  // 新结算的城 4 才会被计算一次
  assert.equal(await runJunxiangAfterSettlement(env, [4], 30, { compute }), 1);
  assert.deepEqual(computed, [1, 2, 4]);
});

test('每周累计清单：周一 00:xx 构建一次（同周重放不再构建），周二与下一周规则正确，并记不上链的就绪审计', async () => {
  const db = openDb();
  const env = envOf(db);
  const calls: Array<[number, number, number]> = [];
  const build = async (from: number, to: number, at: number): Promise<PayoutListSummary> => {
    calls.push([from, to, at]);
    return {
      listId: calls.length,
      root: 'ab'.repeat(32),
      fromRound: from,
      toRound: to,
      leafCount: 7,
      totalRaw: '123456789',
      createdAt: at,
    };
  };
  const deps = { settledRoundIds: async () => [1, 2], build };

  const summary = await runWeeklyPayoutBuild(env, MON_0005, deps);
  assert.ok(summary);
  assert.deepEqual(calls, [[1, 2, MON_0005]], '与管理端相同：fromRound = 1，toRound = 最大已结算城');
  const ready = db.prepare("SELECT detail FROM admin_events WHERE action = 'PAYOUT_ROOT_READY'").all() as Array<{ detail: string }>;
  assert.equal(ready.length, 1);
  assert.ok(ready[0].detail.includes('fundTotalRaw=123456789'), ready[0].detail);
  assert.ok(ready[0].detail.includes('2026-W45'));

  assert.equal(await runWeeklyPayoutBuild(env, MON_0030, deps), null, '同一周第二次不构建');
  assert.equal(await runWeeklyPayoutBuild(env, TUE_0005, deps), null, '周二不构建');
  assert.equal(calls.length, 1);

  assert.ok(await runWeeklyPayoutBuild(env, NEXT_MON_0005, deps), '下一周再构建一次');
  assert.equal(calls.length, 2);
});

test('每周累计清单：尚无已结算城时不占位，同一小时内后续 tick 可补做', async () => {
  const db = openDb();
  const env = envOf(db);
  let settled: number[] = [];
  let builds = 0;
  const deps = {
    settledRoundIds: async () => settled,
    build: async (_f: number, to: number, at: number): Promise<PayoutListSummary> => {
      builds++;
      return { listId: 1, root: '00'.repeat(32), fromRound: 1, toRound: to, leafCount: 0, totalRaw: '0', createdAt: at };
    },
  };
  assert.equal(await runWeeklyPayoutBuild(env, MON_0005, deps), null);
  assert.equal(builds, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM auto_jobs WHERE kind = 'payout-week'").get() as { n: number }).n, 0);

  settled = [1];
  assert.ok(await runWeeklyPayoutBuild(env, MON_0030, deps));
  assert.equal(builds, 1);
});

test('每周累计清单：构建失败写审计并返回 null，本周不再重试（不抛出）', async () => {
  const db = openDb();
  const env = envOf(db);
  const deps = {
    settledRoundIds: async () => [1],
    build: async (): Promise<PayoutListSummary> => {
      throw new Error('payout: 累计金额超出 uint128');
    },
  };
  assert.equal(await runWeeklyPayoutBuild(env, MON_0005, deps), null);
  assert.ok(auditActions(db).includes('PAYOUT_WEEKLY_FAILED'));
  assert.equal(await runWeeklyPayoutBuild(env, MON_0030, deps), null);
});

test('守城补贴二次重算：次城进入 OBSERVING 时重算上一城一次（去重键 junxiang:R<n>:guard-pass），与结算时的首算互不占位', async () => {
  const db = openDb();
  const env = envOf(db);
  const computed: number[] = [];
  const compute = async (roundId: number) => {
    computed.push(roundId);
    return [{ roundId }];
  };

  // R1 结算：首算 junxiang:R1
  assert.equal(await runJunxiangAfterSettlement(env, [1], 10, { compute }), 1);
  assert.deepEqual(computed, [1]);

  // R2 进入 OBSERVING：R1 再算一次（守城补贴）；同批重复的 2 只触发一次；第 1 城没有上一城不算
  assert.equal(await runGuardPassAfterObserving(env, [2, 2, 1], 20, { compute }), 1);
  assert.deepEqual(computed, [1, 1]);
  const keys = (db.prepare("SELECT job_key FROM auto_jobs WHERE kind = 'junxiang-guard'").all() as Array<{ job_key: string }>).map((row) => row.job_key);
  assert.deepEqual(keys, ['junxiang:R1:guard-pass'], '守城补贴占位键');
  assert.ok(auditActions(db).includes('JUNXIANG_GUARD_PASS_DONE'));

  // 索引器重放 / 状态反复观察：不再重算
  assert.equal(await runGuardPassAfterObserving(env, [2], 30, { compute }), 0);
  assert.deepEqual(computed, [1, 1]);

  // R3 进入 OBSERVING：R2 的首算与守城二次都只在各自触发时跑一次
  assert.equal(await runJunxiangAfterSettlement(env, [2], 40, { compute }), 1);
  assert.equal(await runGuardPassAfterObserving(env, [3], 41, { compute }), 1);
  assert.equal(await runGuardPassAfterObserving(env, [3], 42, { compute }), 0);
  assert.deepEqual(computed, [1, 1, 2, 2]);
});

test('守城补贴二次重算：失败不抛出、写审计，且不因失败重试', async () => {
  const db = openDb();
  const env = envOf(db);
  let fail = true;
  let calls = 0;
  const compute = async (roundId: number) => {
    calls++;
    if (fail) throw new Error('getter 超时');
    return [{ roundId }];
  };

  assert.equal(await runGuardPassAfterObserving(env, [5], 10, { compute }), 0);
  assert.ok(auditActions(db).includes('JUNXIANG_GUARD_PASS_FAILED'), '失败写审计');
  assert.equal(calls, 1);

  fail = false;
  assert.equal(await runGuardPassAfterObserving(env, [5], 20, { compute }), 0, '占位已存在，不自动重试');
  assert.equal(calls, 1);
});
