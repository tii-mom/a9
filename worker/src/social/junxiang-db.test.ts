/**
 * 军饷持久化单测：真实 SQLite（node:sqlite）上依次应用 migrations 0001..0015，
 * 通过一个最小 D1 适配器驱动 db.ts / payout.ts / runner.ts 的真实 SQL。
 *
 * 运行（worker 目录）：npm run test:social
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../env';
import { formatTonAddress } from '../indexer/address';
import { handleAdminPayoutBuild, handlePayoutLatest, handlePayoutProof, buildPayoutList, walletKeyOf } from './payout';
import { getGuess, insertGuess, listGuesses } from './db';
import { computeRoundJunxiang } from './runner';
import { NEWCOMER_META } from './newcomer';
import { InMemoryPoolTradeSource, type FundingClusterSource, type PoolSwap } from './sources';
import { fromHex, leafHashOf, verifyMerkleProof } from './merkle';
import { JUNXIANG_A9_BUDGETS } from './junxiang';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

function migrationFiles(upTo?: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => upTo === undefined || Number(name.slice(0, 4)) <= upTo)
    .map((name) => MIGRATIONS_DIR + name);
}

/** 测试内使用的最小数据库接口（node:sqlite 的 DatabaseSync 子集）。 */
interface TestDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

function openDb(upTo?: number): TestDb {
  const db = new DatabaseSync(':memory:') as unknown as TestDb;
  for (const file of migrationFiles(upTo)) db.exec(readFileSync(file, 'utf8'));
  return db;
}

async function rejectsMatching(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(pattern.test(String((err as Error).message ?? err)), String(err));
    return;
  }
  throw new Error('expected to reject');
}

/** 最小 D1 适配器：prepare().bind().run/all/first 与 batch（事务内顺序执行）。 */
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
        const rows = db.prepare(sql).all(...(bound as never[]));
        return { success: true, results: rows.map((row) => ({ ...row })) };
      },
      async first() {
        const row = db.prepare(sql).get(...(bound as never[]));
        return row ? { ...row } : null;
      },
      async _runForBatch() {
        return stmt.run();
      },
    };
    return stmt;
  };
  const d1 = {
    prepare,
    async batch(statements: Array<{ _runForBatch: () => Promise<unknown> }>) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const statement of statements) out.push(await statement._runForBatch());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return d1 as unknown as Env['DB'];
}

function envOf(db: TestDb, extra: Partial<Env> = {}): Env {
  return { DB: fakeD1(db), ...extra } as unknown as Env;
}

async function jsonData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { ok: boolean; data: T };
  assert.equal(body.ok, true);
  return body.data;
}

/* 与 merkle-payout.test.ts 相同的最小断言辅助（避免依赖 node:assert 的完整类型） */
function throwsMatching(fn: () => unknown, pattern?: RegExp): void {
  try {
    fn();
  } catch (err) {
    if (pattern) assert.ok(pattern.test(String((err as Error).message ?? err)), String(err));
    return;
  }
  throw new Error('expected to throw');
}

const A9 = 1_000_000_000n;
const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);
const WALLET_A = formatTonAddress(0, HASH_A);
const WALLET_B = formatTonAddress(0, HASH_B);

/* ------------------------------ 迁移 ------------------------------ */

test('迁移 0015 在已有 0001..0014 数据上可应用，旧明细保留，新 kind 可写', () => {
  const db = openDb(14);
  db.exec(`INSERT INTO junxiang (round_id, wallet, kind, budget, amount_raw, computed_at) VALUES (1, 'W1', 'referrer', 'referral', '42', 1)`);
  db.exec(readFileSync(migrationFiles(15).at(-1) as string, 'utf8'));
  const old = db.prepare('SELECT amount_raw, meta FROM junxiang WHERE wallet = ?').get('W1') as { amount_raw: string; meta: string | null };
  assert.equal(old.amount_raw, '42');
  assert.equal(old.meta, null);
  db.exec(`INSERT INTO junxiang (round_id, wallet, kind, budget, amount_raw, meta, computed_at) VALUES (1, 'G1', 'guard', 'guard', '5', 'm', 1)`);
  db.exec(`INSERT INTO junxiang (round_id, wallet, kind, budget, amount_raw, computed_at) VALUES (1, 'G1', 'guess', 'guess', '5', 1)`);
  throwsMatching(() => db.exec(`INSERT INTO junxiang (round_id, wallet, kind, budget, amount_raw, computed_at) VALUES (1, 'X', 'bogus', 'guard', '5', 1)`));
  throwsMatching(() => db.exec(`INSERT INTO guesses (round_id, wallet, lit_guess, created_at) VALUES (1, 'X', 25, 1)`), /CHECK/);
  throwsMatching(() => db.exec(`INSERT INTO payout_lists (from_round, to_round, root, leaf_count, total_raw, created_at) VALUES (3, 2, 'r', 0, '0', 1)`), /CHECK/);
});

test('迁移 0015：referrer_wallet 首次写入时 trigger 记录毫秒绑定时刻，之后不再改写', () => {
  const db = openDb();
  db.exec(`INSERT INTO users (wallet, invite_code, created_at) VALUES ('UQn', 'AAAAAAAA', 1000)`);
  assert.equal((db.prepare('SELECT referrer_bound_at AS t FROM users WHERE wallet = ?').get('UQn') as { t: number | null }).t, null);
  db.exec(`UPDATE users SET referrer_wallet = 'UQr' WHERE wallet = 'UQn'`);
  const first = (db.prepare('SELECT referrer_bound_at AS t FROM users WHERE wallet = ?').get('UQn') as { t: number }).t;
  assert.ok(first > 1_700_000_000_000 && first < 4_102_444_800_000, `ms epoch ${first}`);
  db.exec(`UPDATE users SET referrer_wallet = 'UQs' WHERE wallet = 'UQn'`);
  assert.equal((db.prepare('SELECT referrer_bound_at AS t FROM users WHERE wallet = ?').get('UQn') as { t: number }).t, first);
});

/* ------------------------------ 猜灯持久化 ------------------------------ */

test('猜灯：同一 (round, wallet) 只能写一次；读回一致', async () => {
  const db = openDb();
  const env = envOf(db);
  assert.equal(await insertGuess(env, { roundId: 1, wallet: 'W1', lit: 4, now: 10 }), true);
  assert.equal(await insertGuess(env, { roundId: 1, wallet: 'W1', lit: 5, now: 11 }), false, 'duplicate rejected');
  assert.deepEqual(await getGuess(env, 1, 'W1'), { lit_guess: 4, created_at: 10 });
  assert.equal(await getGuess(env, 1, 'W2'), null);
  assert.deepEqual(await listGuesses(env, 1), [{ wallet: 'W1', lit: 4 }]);
});

/* ------------------------------ 累计清单 ------------------------------ */

test('累计清单：金额为截至 toRound 的终身累计；证明可对最新 root 校验；清单版本化', async () => {
  const db = openDb();
  const insert = db.prepare('INSERT INTO junxiang (round_id, wallet, kind, budget, amount_raw, computed_at) VALUES (?, ?, ?, ?, ?, 1)');
  insert.run(1, WALLET_A, 'referrer', 'referral', '100');
  insert.run(2, WALLET_A, 'streak', 'streak', '50');
  insert.run(2, WALLET_B, 'squad', 'squad', '7');
  insert.run(3, WALLET_B, 'squad', 'squad', '3');
  insert.run(4, WALLET_A, 'streak', 'streak', '999'); // 超过 toRound=3，不计入
  const env = envOf(db);

  const first = await buildPayoutList(env, 1, 3, 1_000);
  assert.equal(first.listId, 1);
  assert.equal(first.leafCount, 2);
  assert.equal(first.totalRaw, '160', 'A 150 + B 10');

  const latest = await jsonData<{ listId: number; root: string; totalRaw: string }>(await handlePayoutLatest(env));
  assert.equal(latest.listId, 1);
  assert.equal(latest.root, first.root);

  const proof = await jsonData<{ listId: number; root: string; cumulativeRaw: string; proof: string[]; index: number; leafCount: number }>(
    await handlePayoutProof(env, new URL(`https://x.test/api/social/payout/proof?wallet=${encodeURIComponent(WALLET_A)}`)),
  );
  assert.equal(proof.cumulativeRaw, '150');
  const leaf = await leafHashOf({ workchain: 0, hashHex: HASH_A, cumulativeRaw: 150n });
  assert.equal(await verifyMerkleProof(leaf, proof.proof.map(fromHex), proof.index, proof.leafCount, fromHex(proof.root)), true);

  // 新一轮进来：版本 2 覆盖到第 4 城，A 的累计增加，版本 1 仍保留
  const second = await buildPayoutList(env, 1, 4, 2_000);
  assert.equal(second.listId, 2);
  assert.equal(second.totalRaw, (160n + 999n).toString());
  const latest2 = await jsonData<{ listId: number }>(await handlePayoutLatest(env));
  assert.equal(latest2.listId, 2);
  const kept = db.prepare('SELECT COUNT(*) AS n FROM payout_lists').get() as { n: number };
  assert.equal(kept.n, 2);
  const proof2 = await jsonData<{ cumulativeRaw: string }>(
    await handlePayoutProof(env, new URL(`https://x.test/api/social/payout/proof?wallet=${encodeURIComponent(WALLET_A)}`)),
  );
  assert.equal(proof2.cumulativeRaw, (150n + 999n).toString());
});

test('累计清单：未上榜的钱包返回 404；无清单时 latest 返回 404', async () => {
  const db = openDb();
  const env = envOf(db);
  await rejectsMatching(() => handlePayoutLatest(env), /尚未生成/);
  await buildPayoutList(env, 1, 1, 1);
  await rejectsMatching(
    () => handlePayoutProof(env, new URL(`https://x.test/api/social/payout/proof?wallet=${encodeURIComponent(WALLET_B)}`)),
    /不在最新清单/,
  );
  assert.equal(walletKeyOf(WALLET_B).key, `0:${HASH_B}`);
});

test('管理端：无 Bearer 拒绝；带 ADMIN_TOKEN 可构建清单', async () => {
  const db = openDb();
  db.exec(`INSERT INTO junxiang (round_id, wallet, kind, budget, amount_raw, computed_at) VALUES (1, '${WALLET_A}', 'referrer', 'referral', '9', 1)`);
  const env = envOf(db, { ADMIN_TOKEN: 'admin-token-123456' });
  const body = JSON.stringify({ fromRound: 1, toRound: 1 });
  await assert.rejects(() => handleAdminPayoutBuild(new Request('https://x.test/api/admin/payout/build', { method: 'POST', body }), env, 1));
  const res = await handleAdminPayoutBuild(
    new Request('https://x.test/api/admin/payout/build', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-token-123456' },
      body,
    }),
    env,
    5,
  );
  const data = await jsonData<{ listId: number; totalRaw: string }>(res);
  assert.equal(data.listId, 1);
  assert.equal(data.totalRaw, '9');
});

/* ------------------------------ 单城编排 ------------------------------ */

test('单城编排：守城补贴 + 新人礼 + 猜灯 + 合并上限，写入 junxiang 并带 meta', async () => {
  const db = openDb();
  // 第 1 城：开城 1000，报名截止 2000，观察窗口 [2000, 2000+24h]，成功，亮灯 3
  db.exec(`INSERT INTO rounds (round_id, state, target_tier, target_price_usd_e8, reward_budget_raw, stake_open_at, stake_close_at, observation_start, observation_end, qualified_candles, candles_seen, total_accepted_stake_raw, total_weight_raw, staker_count, result, updated_at)
           VALUES (1, 'SUCCEEDED', 1, '100000000', '1000000', 1000, 2000, 2000, 3000, 3, 12, '5000', '5000', 0, 'SUCCESS', 1)`);
  // 第 2 城：报名 3000..4000
  db.exec(`INSERT INTO rounds (round_id, state, target_tier, target_price_usd_e8, reward_budget_raw, stake_open_at, stake_close_at, observation_start, observation_end, updated_at)
           VALUES (2, 'STAKING_CLOSED', 2, '100000000', '1000000', 3000, 4000, NULL, NULL, 1)`);
  // 第 2 城的报名：W1 2000、W2 100（窗口内），W3 9999 在窗口外
  db.exec(`INSERT INTO stakes (round_id, address, amount_raw, weight_raw, nonce, risk_disclosure_version, accepted_at) VALUES
           (2, 'W1', '2000', '2000', 'n1', 1, 3500),
           (2, 'W2', '100', '100', 'n2', 1, 3500),
           (2, 'W3', '9999', '9999', 'n3', 1, 5000)`);
  // 新人 N1：建档 500，绑定 600（首次建档即绑定），在第 1 城开城前
  db.exec(`INSERT INTO users (wallet, invite_code, created_at, referrer_wallet, referrer_bound_at) VALUES ('N1', 'NNNNNNNN', 500, 'W2', 600)`);

  const swaps: PoolSwap[] = [
    { wallet: 'W1', side: 'BUY', a9Amount: 5_000n, ts: 2_500 },
    { wallet: 'W1', side: 'SELL', a9Amount: 1_000n, ts: 3_000 },
    { wallet: 'W2', side: 'BUY', a9Amount: 300n, ts: 2_500 },
    { wallet: 'W3', side: 'BUY', a9Amount: 9_999n, ts: 1 }, // 窗口外
  ];
  const funding: FundingClusterSource = {
    async clusterOf(wallets) {
      // W1 与 W2 同一资金来源；其它各自成簇
      return new Map(wallets.map((wallet) => [wallet, wallet === 'W1' || wallet === 'W2' ? 'C1' : wallet]));
    },
  };
  const env = envOf(db);
  await insertGuess(env, { roundId: 1, wallet: 'W1', lit: 3, now: 1 }); // 第 1 城亮 3 盏，W1 猜中（猜灯只看结算后的亮灯数）
  const rows = await computeRoundJunxiang(env, 1, 9_000, { pool: { poolAddress: 'POOL', source: new InMemoryPoolTradeSource(swaps) }, funding });

  // 猜灯：W1 独得 50 万，但单人（同簇）上限 = 线额 200 万的 2% = 4 万
  const expectedGuess = (JUNXIANG_A9_BUDGETS.streak! + JUNXIANG_A9_BUDGETS.guess!) * 200n / 10_000n; // 线额 200 万的 2%
  const expectedNewcomer = (1_000_000n * (1_000n * A9)) / (5_000n + 1_000n * A9);
  assert.deepEqual(
    rows.map((row) => [row.budget, row.kind, row.wallet, row.amountRaw.toString()]),
    [
      ['guess', 'guess', 'W1', expectedGuess.toString()],
      ['guard', 'guard', 'W1', '400'], // min(净买入 4000, 次城质押 2000) × 20%
      ['guard', 'guard', 'W2', '20'], // min(300, 100) × 20%
      ['newcomer', 'newcomer', 'N1', expectedNewcomer.toString()],
    ],
    'rows for round 1',
  );
  assert.equal(rows.find((row) => row.kind === 'newcomer')?.meta, NEWCOMER_META);

  const stored = db
    .prepare('SELECT kind, wallet, amount_raw, meta FROM junxiang WHERE round_id = 1 ORDER BY budget, wallet, kind')
    .all() as Array<{ kind: string; wallet: string; amount_raw: string; meta: string | null }>;
  assert.equal(stored.length, 4);
  assert.equal(stored.find((row) => row.kind === 'newcomer')?.meta, NEWCOMER_META);

  // 第 2 城：没有下一城、不是第一座开城的轮次，所以没有守城补贴与新人礼；猜灯未结算
  const round2 = await computeRoundJunxiang(env, 2, 9_000, { pool: null, funding });
  assert.equal(round2.filter((row) => row.kind === 'guard' || row.kind === 'newcomer' || row.kind === 'guess').length, 0);
  assert.ok(round2.some((row) => row.kind === 'streak' && row.wallet === 'W1'), 'streak for W1 in round 2');
});

test('单城编排：猜中者获得猜灯（同簇共享 200 万线的 2% 上限）', async () => {
  const db = openDb();
  db.exec(`INSERT INTO rounds (round_id, state, target_tier, target_price_usd_e8, reward_budget_raw, stake_open_at, stake_close_at, qualified_candles, candles_seen, total_accepted_stake_raw, total_weight_raw, staker_count, result, updated_at)
           VALUES (1, 'SUCCEEDED', 1, '100000000', '0', 1000, 2000, 4, 12, '0', '0', 0, 'FAILURE', 1)`);
  const env = envOf(db);
  await insertGuess(env, { roundId: 1, wallet: 'G1', lit: 4, now: 1 });
  await insertGuess(env, { roundId: 1, wallet: 'G2', lit: 4, now: 1 });
  await insertGuess(env, { roundId: 1, wallet: 'G3', lit: 0, now: 1 });
  const rows = await computeRoundJunxiang(env, 1, 9_000, {
    pool: null,
    funding: { async clusterOf(wallets) { return new Map(wallets.map((w) => [w, w])); } },
  });
  const guessRows = rows.filter((row) => row.kind === 'guess');
  // 两人猜中，各得 50 万的一半 = 25 万，但单人上限 = 线额 200 万的 2% = 4 万
  assert.deepEqual(guessRows.map((row) => [row.wallet, row.amountRaw]), [
    ['G1', 40_000n * A9],
    ['G2', 40_000n * A9],
  ]);
});
