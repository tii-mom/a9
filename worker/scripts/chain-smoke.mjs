#!/usr/bin/env node
/**
 * chain 模式专项冒烟（B1/B2/B3/B7；B6 另用无配置库验证）。
 *
 * 用法：
 *   # 准备 chain 夹具库（见 worker/scripts/chain-fixture.sql 或文档），启动：
 *   wrangler dev --port 8904 --persist-to /tmp/a9-chain --var DATA_SOURCE:chain --var TONCENTER_ALLOW_PUBLIC:1
 *   SMOKE_CHAIN_BASE=http://127.0.0.1:8904 node scripts/chain-smoke.mjs
 */
const BASE = (process.env.SMOKE_CHAIN_BASE || 'http://127.0.0.1:8904').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token';
const results = [];

function eq(actual, expected, label) {
  if (String(actual) !== String(expected)) throw new Error(label + '：期望 ' + expected + '，实际 ' + actual);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function api(path, init = {}, token) {
  const headers = new Headers(init.headers || {});
  if (init.body) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', 'Bearer ' + token);
  const res = await fetch(BASE + path, { ...init, headers });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body, text };
}
async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail, ms: Date.now() - started });
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
  }
}

await test('B1：chain 模式 admin 本地写接口 → 501（不写本地状态）', async () => {
  const pause = await api('/api/admin/oracle/pause', { method: 'POST', body: JSON.stringify({ reason: 'chain-smoke' }) }, ADMIN_TOKEN);
  eq(pause.status, 501, 'oracle/pause status');
  eq(pause.body.error.code, 'NOT_IMPLEMENTED', 'oracle/pause code');
  const advance = await api('/api/admin/rounds/advance', { method: 'POST' }, ADMIN_TOKEN);
  eq(advance.status, 501, 'rounds/advance status');
  eq(advance.body.error.code, 'NOT_IMPLEMENTED', 'rounds/advance code');
  return 'pause/advance 均 501 NOT_IMPLEMENTED';
});

await test('B2：chain 模式不本地推进轮次状态', async () => {
  const rounds = await api('/api/rounds');
  eq(rounds.status, 200, 'status');
  const r1 = rounds.body.data.find((row) => row.roundId === 1);
  assert(r1, '缺少 R1');
  eq(r1.state, 'STAKING_OPEN', 'R1 state 不应被本地推进（stakeCloseAt 已过期）');
  return 'R1 保持 STAKING_OPEN（链上状态未变）';
});

await test('B3：chain 模式不覆盖 candle_hash（链上权威值）；v10 不再返回 totalWeightRaw', async () => {
  const rounds = await api('/api/rounds');
  const r1 = rounds.body.data.find((row) => row.roundId === 1);
  assert(r1, '缺少 R1');
  assert(!('totalWeightRaw' in r1), 'v10 /api/rounds 不应再返回 totalWeightRaw');
  eq(r1.candleHash, '0xabababababababababababababababababababababababababababababababab', 'candleHash 应保留链上值');
  return 'candle_hash=0xabab… 未被本地重算；totalWeightRaw 已从 API 移除';
});

await test('B7：chain 未开轮不投影档位（targetLocked=false）', async () => {
  const rounds = await api('/api/rounds');
  const r2 = rounds.body.data.find((row) => row.roundId === 2);
  assert(r2, '缺少 R2');
  eq(r2.state, 'UNOPENED', 'R2 state');
  eq(r2.targetLocked, false, 'targetLocked');
  eq(r2.targetPriceUsdE8, '0', 'targetPriceUsdE8');
  eq(r2.priceMultiplier, 0, 'priceMultiplier');
  return 'R2 UNOPENED → targetLocked=false / price=0 / multiplier=0';
});

const failed = results.filter((row) => row.status === 'FAIL').length;
for (const row of results) {
  console.log((row.status === 'PASS' ? '✅ PASS' : '❌ FAIL') + ' │ ' + row.name + ' │ ' + row.detail);
}
console.log('\nchain-smoke 合计 ' + results.length + '：PASS ' + (results.length - failed) + ' / FAIL ' + failed);
if (failed > 0) process.exit(1);
