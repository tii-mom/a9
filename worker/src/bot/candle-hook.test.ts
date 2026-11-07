import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushNewCandleLamps, type CandleLampInput } from './candle-hook';
import type { BotEnv, CandleEvent } from './types';

/**
 * 最小 D1 替身：只实现 candle-hook 用到的两条 SQL（bot_pushes 占位、candles 计数）。
 * 与真实 D1 一样，主键冲突时 INSERT OR IGNORE 不改变 changes。
 */
function fakeDb(litFlags: Array<{ roundId: number; candleIndex: number; qualified: number }> = []) {
  const pushes = new Set<string>();
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async run() {
          if (!sql.startsWith('INSERT OR IGNORE INTO bot_pushes')) throw new Error('unexpected run: ' + sql);
          const key = `${args[0]}:${args[1]}`;
          const fresh = !pushes.has(key);
          pushes.add(key);
          return { success: true, meta: { changes: fresh ? 1 : 0 } };
        },
        async first() {
          if (!sql.startsWith('SELECT COUNT(*) AS n FROM candles')) throw new Error('unexpected first: ' + sql);
          const [roundId, upTo] = args as [number, number];
          const n = litFlags.filter((c) => c.roundId === roundId && c.candleIndex <= upTo && c.qualified === 1).length;
          return { n };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, pushes };
}

function env(extra: Partial<BotEnv> = {}, db?: D1Database): BotEnv {
  return { DB: db ?? fakeDb().db, TG_BOT_TOKEN: 'tok', ...extra };
}

const item = (candleIndex: number, twap: number, target = 100_000_000n): CandleLampInput => ({
  roundId: 7,
  candleIndex,
  twapUsdE8: BigInt(twap),
  targetUsdE8: target,
});

test('亮灯推送：没有 TG_BOT_TOKEN 直接跳过，不读写库、不推送', async () => {
  const untouched = new Proxy({}, { get: () => () => { throw new Error('DB must not be used'); } }) as unknown as D1Database;
  const calls: CandleEvent[] = [];
  const sent = await pushNewCandleLamps({ DB: untouched }, [item(1, 120_000_000)], {
    push: async (_e, ev) => (calls.push(ev), 1),
  });
  assert.equal(sent, 0);
  assert.equal(calls.length, 0);
});

test('亮灯推送：同一根 K 线只推一次（重放 / 重复摄入不重推）', async () => {
  const { db, pushes } = fakeDb();
  const calls: CandleEvent[] = [];
  const deps = { push: async (_e: BotEnv, ev: CandleEvent) => (calls.push(ev), 1), now: () => 1_000 };

  assert.equal(await pushNewCandleLamps(env({}, db), [item(3, 120_000_000)], deps), 1);
  // 第二次（reindex / 重放）同一根：不推
  assert.equal(await pushNewCandleLamps(env({}, db), [item(3, 120_000_000)], deps), 0);
  // 同一批里重复出现的同一根：只推一次
  assert.equal(await pushNewCandleLamps(env({}, db), [item(4, 90_000_000), item(4, 90_000_000)], deps), 1);

  assert.equal(calls.length, 2);
  assert.deepEqual([...pushes].sort(), ['7:3', '7:4']);
});

test('亮灯推送：字段换算（USD_E8 → number）、亮灯判定、累计盏数', async () => {
  const { db } = fakeDb([
    { roundId: 7, candleIndex: 1, qualified: 1 },
    { roundId: 7, candleIndex: 2, qualified: 0 },
    { roundId: 7, candleIndex: 3, qualified: 1 },
  ]);
  const calls: CandleEvent[] = [];
  const deps = { push: async (_e: BotEnv, ev: CandleEvent) => (calls.push(ev), 1), now: () => 1 };
  await pushNewCandleLamps(env({}, db), [item(1, 120_000_000), item(2, 99_000_000), item(3, 100_000_000)], deps);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {
    roundId: 7,
    candleIndex: 1,
    lit: true,
    needed: 16,
    total: 24,
    priceUsd: 1.2,
    gatePriceUsd: 1,
    litCount: 1,
  });
  assert.equal(calls[1].lit, false);
  assert.equal(calls[1].litCount, 1);
  // 等于目标价也算亮（twap >= target）
  assert.equal(calls[2].lit, true);
  assert.equal(calls[2].litCount, 2);
  assert.equal('outcome' in calls[2], false);
});

test('亮灯推送：最后一根（第 24 根）按累计亮灯数给出结算结果', async () => {
  const lit16 = Array.from({ length: 16 }, (_, i) => ({ roundId: 7, candleIndex: i + 1, qualified: 1 }));
  const won = fakeDb([...lit16, { roundId: 7, candleIndex: 24, qualified: 0 }]);
  const lost = fakeDb([{ roundId: 7, candleIndex: 24, qualified: 0 }]);
  const calls: CandleEvent[] = [];
  const deps = { push: async (_e: BotEnv, ev: CandleEvent) => (calls.push(ev), 1), now: () => 1 };

  await pushNewCandleLamps(env({}, won.db), [item(24, 80_000_000)], deps);
  await pushNewCandleLamps(env({}, lost.db), [item(24, 80_000_000)], deps);
  assert.equal(calls[0].outcome, 'SUCCEEDED');
  assert.equal(calls[0].litCount, 16);
  assert.equal(calls[1].outcome, 'FAILED_PERMANENT');
  assert.equal(calls[1].litCount, 0);
});

test('亮灯推送：单根推送失败不影响其他根，且整体不抛出', async () => {
  const { db } = fakeDb();
  const seen: number[] = [];
  const deps = {
    push: async (_e: BotEnv, ev: CandleEvent) => {
      seen.push(ev.candleIndex);
      if (ev.candleIndex === 1) throw new Error('telegram down');
      return 1;
    },
    now: () => 1,
  };
  const sent = await pushNewCandleLamps(env({}, db), [item(2, 120_000_000), item(1, 120_000_000)], deps);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(sent, 1);
});

test('亮灯推送：D1 异常返回 0，不抛出', async () => {
  const broken = { prepare: () => { throw new Error('D1 unavailable'); } } as unknown as D1Database;
  const sent = await pushNewCandleLamps(env({}, broken), [item(1, 120_000_000)], { push: async () => 1 });
  assert.equal(sent, 0);
});
