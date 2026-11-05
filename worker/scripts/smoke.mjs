#!/usr/bin/env node
/**
 * FUSE 引信协议 API 冒烟测试（自测凭证）
 *
 * 用法：
 *   # 终端 1（推荐用极速演示种子做全量覆盖）
 *   DEMO_CANDLE_SECONDS=1 node scripts/generate-seed.mjs
 *   ./node_modules/.bin/wrangler d1 execute fuse-protocol --local --file=./migrations/seed.sql
 *   ./node_modules/.bin/wrangler dev --port 8787 --var ADMIN_TOKEN:dev-admin-token --var DEMO_CANDLE_SECONDS:1
 *
 *   # 终端 2
 *   node scripts/smoke.mjs
 *
 * 环境变量：
 *   SMOKE_BASE    默认 http://127.0.0.1:8787
 *   ADMIN_TOKEN   默认 dev-admin-token（与 wrangler dev --var 保持一致）
 *   SMOKE_TIMEOUT 等待观察窗口结算的最长秒数（默认 75）
 *
 * 输出 PASS/FAIL/SKIP 表；存在 FAIL 时退出码 1。
 * 说明：标准演示（90s/根）下，观察窗口在测试期间不会走完，依赖结算的用例标记 SKIP；
 *       极速演示（DEMO_CANDLE_SECONDS=1）可全量覆盖。所有写操作只针对本地 D1。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.SMOKE_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');

/** 默认从 worker/.dev.vars 读取 ADMIN_TOKEN（与 wrangler dev 本地环境一致）。 */
function resolveAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
    if (existsSync(path)) {
      const line = readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .find((item) => item.trim().startsWith('ADMIN_TOKEN='));
      if (line) return line.slice(line.indexOf('=') + 1).trim();
    }
  } catch {
    /* 忽略 */
  }
  return 'dev-admin-token';
}

const ADMIN_TOKEN = resolveAdminToken();
const SETTLE_TIMEOUT_SEC = Number(process.env.SMOKE_TIMEOUT || 75);
const UNKNOWN_ADDRESS = 'UQ' + 'A'.repeat(46);

const results = [];
const ctx = { fast: false, admin: ADMIN_TOKEN };

function fmt(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function eq(actual, expected, label) {
  if (String(actual) !== String(expected)) throw new Error(label + '：期望 ' + expected + '，实际 ' + actual);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isDigits(value) {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

async function api(path, init = {}, token) {
  const headers = new Headers(init.headers || {});
  if (init.body) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', 'Bearer ' + token);
  const res = await fetch(BASE + path, { ...init, headers });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON（静态资源） */
  }
  return { status: res.status, body, text, headers: res.headers };
}

async function apiOk(path, init) {
  const res = await api(path, init);
  if (res.status !== 200 || !res.body || res.body.ok !== true) {
    throw new Error(path + ' 期望 200/ok:true，实际 ' + res.status + ' ' + res.text.slice(0, 200));
  }
  return res.body.data;
}

async function apiPost(path, payload, token = ADMIN_TOKEN) {
  return api(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) }, token);
}

class SkipTest extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipTest';
  }
}

async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    if (detail && typeof detail === 'object' && detail.skip) {
      results.push({ name, status: 'SKIP', detail: detail.skip, ms: Date.now() - started });
      return;
    }
    results.push({ name, status: 'PASS', detail: typeof detail === 'string' ? detail : '', ms: Date.now() - started });
  } catch (error) {
    const status = error instanceof SkipTest ? 'SKIP' : 'FAIL';
    results.push({ name, status, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
  }
}

function skip(reason) {
  throw new SkipTest(reason);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printTable() {
  const width = Math.max(...results.map((row) => row.name.length), 4);
  console.log('');
  console.log('┌────┬────────┬' + '─'.repeat(width + 2) + '┬────────────────────────────────────────────────────────────┐');
  console.log('│ #  │ 结果   │ ' + '用例'.padEnd(width) + ' │ 详情                                                       │');
  console.log('├────┼────────┼' + '─'.repeat(width + 2) + '┼────────────────────────────────────────────────────────────┤');
  results.forEach((row, index) => {
    const icon = row.status === 'PASS' ? '✅ PASS' : row.status === 'SKIP' ? '⏭️ SKIP' : '❌ FAIL';
    const detail = row.detail.length > 58 ? row.detail.slice(0, 57) + '…' : row.detail;
    console.log(
      '│ ' + String(index + 1).padStart(2) + ' │ ' + icon.padEnd(6) + ' │ ' + row.name.padEnd(width) + ' │ ' + detail.padEnd(58) + ' │',
    );
  });
  console.log('└────┴────────┴' + '─'.repeat(width + 2) + '┴────────────────────────────────────────────────────────────┘');
  const passed = results.filter((row) => row.status === 'PASS').length;
  const skipped = results.filter((row) => row.status === 'SKIP').length;
  const failed = results.filter((row) => row.status === 'FAIL').length;
  console.log(`合计 ${results.length}：PASS ${passed} / SKIP ${skipped} / FAIL ${failed}`);
  if (skipped) console.log('SKIP 原因：标准演示（90s/根）K 线在测试期内不会走完；用 DEMO_CANDLE_SECONDS=1 重新 seed 可全量覆盖。');
  return failed;
}

/* ================================ 用例 ================================ */

async function baseline() {
  await test('GET /api/health', async () => {
    const res = await api('/api/health');
    eq(res.status, 200, 'status');
    assert(res.body.ok === true, 'ok 必须为 true');
    const data = res.body.data;
    assert(data.db === true, 'D1 未连通');
    eq(data.dataSource, 'demo', 'dataSource');
    assert(typeof data.version === 'string' && data.version.length > 0, 'version 缺失');
    assert(data.version !== 'mock', '当前端口被 mock 服务占用，请指向真实 wrangler dev');
    assert(typeof data.uptimeSeconds === 'number', 'uptimeSeconds 缺失');
    assert(data.uptimeSeconds >= 0 && data.uptimeSeconds < 86_400, 'uptimeSeconds 应为秒级时长，实际 ' + data.uptimeSeconds);
    return 'db=ok version=' + data.version + ' uptime=' + data.uptimeSeconds + 's';
  });

  await test('安全响应头（/api）', async () => {
    const res = await api('/api/health');
    const h = res.headers;
    eq(h.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options');
    eq(h.get('x-frame-options'), 'DENY', 'X-Frame-Options');
    eq(h.get('referrer-policy'), 'strict-origin-when-cross-origin', 'Referrer-Policy');
    assert((h.get('permissions-policy') || '').includes('geolocation=()'), 'Permissions-Policy');
    eq(h.get('cross-origin-opener-policy'), 'same-origin', 'COOP');
    eq(h.get('cache-control'), 'no-store', 'Cache-Control');
    return '5 项安全头 + no-store';
  });

  await test('GET /api/version', async () => {
    const data = await apiOk('/api/version');
    eq(data.schemaVersion, 1, 'schemaVersion');
    eq(data.dataSource, 'demo', 'dataSource');
    assert(typeof data.now === 'number', 'now 缺失');
    return 'version=' + data.version + ' sha=' + (data.gitSha || '-');
  });

  await test('GET /api/config', async () => {
    const data = await apiOk('/api/config');
    eq(data.p0UsdE8, '400000', 'p0UsdE8');
    eq(data.usdPriceScale, 100000000, 'usdPriceScale');
    eq(data.priceMultiplier, 2, 'priceMultiplier');
    eq(data.roundCount, 10, 'roundCount');
    eq(data.roundRewardRaw, '750000000000000000', 'roundRewardRaw');
    eq(data.totalSupplyRaw, '10000000000000000000', 'totalSupplyRaw');
    eq(data.candleCount, 12, 'candleCount');
    eq(data.minQualifiedCandles, 8, 'minQualifiedCandles');
    eq(data.riskDisclosureVersion, 1, 'riskDisclosureVersion');
    eq(data.tonUsdE8, '300000000', 'tonUsdE8');
    eq(data.dataSource, 'demo', 'dataSource');
    eq(data.token.decimals, 9, 'token.decimals');
    assert(data.demo && data.demo.candleSeconds >= 1, 'demo 配置缺失');
    assert(Array.isArray(data.frozenParams) && data.frozenParams.length >= 8, 'frozenParams 过少');
    assert(data.contracts && 'jettonMaster' in data.contracts, 'contracts 缺失');
    ctx.demoCandleSeconds = data.demo.candleSeconds;
    ctx.fast = data.demo.candleSeconds <= 5;
    return 'P0=$0.004 demoCandle=' + data.demo.candleSeconds + 's 冻结项=' + data.frozenParams.length;
  });

  await test('GET /api/rounds（10 轮演示状态机）', async () => {
    const data = await apiOk('/api/rounds');
    eq(data.length, 10, '轮次数');
    const byId = new Map(data.map((row) => [row.roundId, row]));
    ctx.rounds = byId;
    eq(byId.get(1).state, 'SUCCEEDED', 'R1 state');
    eq(byId.get(1).result, 'SUCCESS', 'R1 result');
    eq(byId.get(1).qualifiedCandles, 10, 'R1 达标数');
    eq(byId.get(1).candlesSeen, 12, 'R1 K 线数');
    eq(byId.get(1).targetPriceUsdE8, '800000', 'R1 target');
    eq(byId.get(2).state, 'FAILED_PERMANENT', 'R2 state');
    eq(byId.get(2).qualifiedCandles, 6, 'R2 达标数');
    eq(byId.get(2).burnedRaw, '991500000000000000', 'R2 burned');
    eq(byId.get(3).targetPriceUsdE8, '3200000', 'R3 target');
    assert(['OBSERVING', 'ORACLE_PAUSED', 'SUCCEEDED', 'FAILED_PERMANENT'].includes(byId.get(3).state), 'R3 state 非法：' + byId.get(3).state);
    assert(byId.get(3).candlesSeen >= 6, 'R3 初始应有 ≥6 根已收盘 K 线，实际 ' + byId.get(3).candlesSeen);
    assert(byId.get(3).qualifiedCandles >= 4, 'R3 初始达标应 ≥4，实际 ' + byId.get(3).qualifiedCandles);
    eq(byId.get(4).state, 'UNOPENED', 'R4 state');
    for (let id = 5; id <= 10; id++) eq(byId.get(id).state, 'UNOPENED', 'R' + id + ' state');
    eq(byId.get(3).priceMultiplier, 8, 'R3 倍数');
    return 'R1 S / R2 F(991.5M) / R3 ' + byId.get(3).state + ' / R4-R10 U';
  });

  await test('GET /api/rounds/1（终态详情）', async () => {
    const data = await apiOk('/api/rounds/1');
    eq(data.candles.length, 12, 'K 线数');
    eq(data.candles.filter((c) => c.qualified).length, 10, '达标 K 线数');
    eq(data.live, null, 'live');
    eq(data.secondsRemaining, null, 'secondsRemaining');
    eq(data.nextState, null, 'nextState');
    assert(BigInt(data.priceUsdE8) > 0n, 'priceUsdE8 非法');
    return '12 根 / 10 达标 / price=' + data.priceUsdE8;
  });

  await test('GET /api/rounds/1/candles', async () => {
    const data = await apiOk('/api/rounds/1/candles');
    eq(data.length, 12, '长度');
    data.forEach((candle, index) => {
      eq(candle.candleIndex, index, 'candleIndex');
      assert(isDigits(candle.twapPriceUsdE8), 'twap 非 raw 字符串');
      assert(candle.periodEnd > candle.periodStart, '时间区间非法');
      assert(candle.coverageBps >= 0 && candle.coverageBps <= 10000, 'coverageBps');
      assert(candle.validSourceCount > 0, 'validSourceCount');
      assert(/^0x[0-9a-f]+$/.test(candle.dataDigest), 'dataDigest');
    });
    return '12 根，字段/时间区间/摘要齐全';
  });

  await test('GET /api/rounds/3（观察中 live 状态）', async () => {
    const data = await apiOk('/api/rounds/3');
    ctx.round3 = data;
    eq(data.candles.length, data.candlesSeen, 'candles.length 与 candlesSeen 不一致');
    eq(data.candles.filter((candle) => candle.qualified).length, data.qualifiedCandles, 'qualifed 计数与 K 线不一致');
    const grid = ctx.demoCandleSeconds * 1000;
    data.candles.forEach((candle, index) => {
      eq(candle.candleIndex, index, 'R3 candleIndex 连续');
      eq(candle.periodEnd - candle.periodStart, grid, 'K 线周期网格');
      if (index > 0) eq(candle.periodStart, data.candles[index - 1].periodEnd, 'K 线首尾相接');
    });
    assert(BigInt(data.priceUsdE8) > 0n, 'priceUsdE8');
    if (data.state === 'OBSERVING') {
      assert(data.live !== null, 'OBSERVING 必须返回 live');
      eq(data.live.candleIndex, data.candlesSeen, 'live.candleIndex');
      assert(data.live.progressBps >= 0 && data.live.progressBps <= 10000, 'progressBps');
      assert(data.secondsRemaining !== null && data.secondsRemaining >= 0, 'secondsRemaining');
      assert(data.nextState === null || data.nextState === 'SETTLING_SUCCESS' || data.nextState === 'SETTLING_FAILURE', 'nextState');
      return data.candlesSeen + '/12 根，live#' + data.live.candleIndex + ' 剩余 ' + data.secondsRemaining + 's';
    }
    return 'state=' + data.state + '（观察窗口已结束）';
  });

  await test('GET /api/rounds/3/leaderboard（真实聚合）', async () => {
    const data = await apiOk('/api/rounds/3/leaderboard');
    eq(data.length, 12, '行数');
    let shareSum = 0;
    data.forEach((row, index) => {
      eq(row.rank, index + 1, 'rank');
      assert(/^[EUk0][Qq][A-Za-z0-9_-]{46}$/.test(row.address), '地址格式');
      assert(isDigits(row.amountRaw) && BigInt(row.amountRaw) > 0n, 'amountRaw');
      assert(isDigits(row.rewardEstimateRaw), 'rewardEstimateRaw');
      shareSum += row.shareBps;
    });
    assert(shareSum <= 10000 && shareSum >= 9900, 'shareBps 合计异常：' + shareSum);
    for (let i = 1; i < data.length; i++) {
      assert(BigInt(data[i - 1].amountRaw) >= BigInt(data[i].amountRaw), '未按质押量降序');
    }
    ctx.r3Leaderboard = data;
    return '12 行 shareBps 合计 ' + shareSum;
  });

  await test('GET /api/stats', async () => {
    const data = await apiOk('/api/stats');
    ctx.stats = data;
    eq(data.burnedRaw, '991500000000000000', 'burnedRaw');
    eq(data.supplyRaw, '9008500000000000000', 'supplyRaw');
    eq(data.lockedStakeRaw, '386200000000000000', 'lockedStakeRaw');
    eq(data.stakerCount, 12, 'stakerCount');
    assert(isDigits(data.volume24hUsdE8) && BigInt(data.volume24hUsdE8) > 0n, 'volume24hUsdE8');
    assert(BigInt(data.priceUsdE8) > 0n, 'priceUsdE8');
    assert(BigInt(data.price24hAgoUsdE8) > 0n, 'price24hAgoUsdE8');
    eq(data.oracle.online, true, 'oracle.online');
    eq(data.oracle.paused, false, 'oracle.paused');
    return 'burned=991.5M supply=9.0085e18 locked=386.2M';
  });

  await test('GET /api/trades?limit=20', async () => {
    const data = await apiOk('/api/trades?limit=20');
    eq(data.length, 20, '行数');
    for (let i = 1; i < data.length; i++) assert(data[i - 1].ts >= data[i].ts, '未按时间倒序');
    data.forEach((row) => {
      assert(row.side === 'BUY' || row.side === 'SELL', 'side');
      assert(isDigits(row.amountRaw) && BigInt(row.amountRaw) > 0n, 'amountRaw');
      assert(isDigits(row.valueUsdE8), 'valueUsdE8');
      assert(typeof row.big === 'boolean', 'big');
      const tokens = Number(BigInt(row.amountRaw) / 1_000_000_000n);
      assert(tokens >= 2_000 && tokens <= 500_000, '成交金额超出演示量级：' + tokens + ' FUSE');
    });
    return '20 条，2k~450k FUSE 量级 / 倒序 / 字段合法';
  });

  await test('GET /api/book', async () => {
    const data = await apiOk('/api/book');
    eq(data.asks.length, 10, 'asks');
    eq(data.bids.length, 10, 'bids');
    assert(BigInt(data.midUsdE8) > 0n, 'midUsdE8');
    for (let i = 1; i < data.asks.length; i++) assert(BigInt(data.asks[i].priceUsdE8) > BigInt(data.asks[i - 1].priceUsdE8), 'asks 价格未升序');
    for (let i = 1; i < data.bids.length; i++) assert(BigInt(data.bids[i].priceUsdE8) < BigInt(data.bids[i - 1].priceUsdE8), 'bids 价格未降序');
    data.asks.concat(data.bids).forEach((level) => {
      assert(level.cumulativePct >= 0 && level.cumulativePct <= 100, 'cumulativePct');
    });
    return '买卖各 10 档，累计百分比 0~100';
  });

  await test('GET /api/me（未领取地址聚合）', async () => {
    const board = await apiOk('/api/rounds/1/leaderboard');
    const target = board[board.length - 1];
    ctx.claimAddress = target.address;
    const data = await apiOk('/api/me?address=' + encodeURIComponent(target.address));
    ctx.meBefore = data;
    eq(data.address, target.address, 'address');
    data.stakes.forEach((row) => eq(row.address, target.address, '/api/me stake.address 未原样返回'));
    const rounds = new Set(data.stakes.map((row) => row.roundId));
    assert(rounds.has(1) && rounds.has(2) && rounds.has(3), 'stakes 未覆盖 R1/R2/R3');
    const claimableR1 = data.claimable.find((row) => row.roundId === 1);
    assert(claimableR1, 'R1 应有可领取');
    assert(BigInt(claimableR1.principalRaw) > 0n, 'principalRaw');
    assert(BigInt(claimableR1.rewardRaw) > 0n, 'rewardRaw');
    eq(claimableR1.state, 'SUCCEEDED', 'claimable state');
    assert(isDigits(data.totals.stakedRaw) && BigInt(data.totals.stakedRaw) > 0n, 'totals.stakedRaw');
    return target.address.slice(0, 6) + '… 3 轮质押 / R1 可领取';
  });

  await test('GET /api/me（陌生地址返回空数组）', async () => {
    const data = await apiOk('/api/me?address=' + encodeURIComponent(UNKNOWN_ADDRESS));
    eq(data.stakes.length, 0, 'stakes');
    eq(data.claimable.length, 0, 'claimable');
    eq(data.totals.stakedRaw, '0', 'totals.stakedRaw');
    eq(data.totals.rewardRaw, '0', 'totals.rewardRaw');
    eq(data.totals.claimedRaw, '0', 'totals.claimedRaw');
    return '未质押地址 → 200 + 空数组';
  });

  await test('GET /api/me 缺少 address → 400', async () => {
    const res = await api('/api/me');
    eq(res.status, 400, 'status');
    eq(res.body.error.code, 'BAD_REQUEST', 'code');
    return 'BAD_REQUEST';
  });

  await test('未知 /api 路径 → 404', async () => {
    const res = await api('/api/nope');
    eq(res.status, 404, 'status');
    eq(res.body.error.code, 'NOT_FOUND', 'code');
    const res2 = await api('/api/rounds/99');
    eq(res2.status, 400, '非法轮次 status');
    return '包装为 ApiResponse.error';
  });
}

async function adminTests() {
  await test('admin 鉴权：无 token / 错 token → 401', async () => {
    const none = await api('/api/admin/overview');
    eq(none.status, 401, '无 token status');
    eq(none.body.error.code, 'UNAUTHORIZED', '无 token code');
    const wrong = await api('/api/admin/overview', {}, 'wrong-token-123456');
    eq(wrong.status, 401, '错 token status');
    assert(!JSON.stringify(wrong.body).includes('ADMIN'), '错误信息不应泄露配置细节');
    return '401 UNAUTHORIZED（不泄露 token 配置）';
  });

  await test('GET /api/admin/overview', async () => {
    const res = await api('/api/admin/overview', {}, ADMIN_TOKEN);
    eq(res.status, 200, 'status');
    assert(res.body.ok === true, 'ok');
    const data = res.body.data;
    ctx.overview = data;
    eq(data.rounds.length, 10, 'rounds');
    assert(Array.isArray(data.events) && data.events.length > 0, 'events');
    assert(isDigits(data.stats.supplyRaw), 'stats');
    eq(typeof data.worker.demoCandleSeconds, 'number', 'worker.demoCandleSeconds');
    eq(data.worker.dataSource, 'demo', 'worker.dataSource');
    return '10 轮 / ' + data.events.length + ' 条审计事件';
  });

  await test('POST /api/admin/tick 幂等（连续两次状态一致）', async () => {
    const first = await apiPost('/api/admin/tick');
    eq(first.status, 200, 'status');
    const stateA = first.body.data.rounds.map((row) => row.roundId + ':' + row.state + ':' + row.candlesSeen);
    const second = await apiPost('/api/admin/tick');
    eq(second.status, 200, 'status');
    const stateB = second.body.data.rounds.map((row) => row.roundId + ':' + row.state + ':' + row.candlesSeen);
    eq(stateB.join(','), stateA.join(','), '两次 tick 后状态');
    return 'CAS + INSERT OR IGNORE，无重复计数';
  });

  await test('预言机暂停/恢复（不销毁本金）', async () => {
    const before = await apiOk('/api/stats');
    const pause = await apiPost('/api/admin/oracle/pause', { reason: 'smoke 测试：模拟数据源异常' });
    eq(pause.status, 200, 'pause status');
    eq(pause.body.data.oracle.paused, true, 'paused');
    ctx.pausedRound = pause.body.data.rounds.find((row) => row.state === 'ORACLE_PAUSED') || null;
    const pausedStats = await apiOk('/api/stats');
    eq(pausedStats.burnedRaw, before.burnedRaw, '暂停后销毁量变化');
    await apiPost('/api/admin/tick');
    const during = await apiOk('/api/rounds');
    if (ctx.pausedRound) {
      const row = during.find((item) => item.roundId === ctx.pausedRound.roundId);
      eq(row.state, 'ORACLE_PAUSED', '暂停期间状态');
      eq(row.candlesSeen, ctx.pausedRound.candlesSeen, '暂停期间 K 线计数被推进');
      ctx.pausedCandlesSeen = row.candlesSeen;
    }
    const resume = await apiPost('/api/admin/oracle/resume');
    eq(resume.status, 200, 'resume status');
    eq(resume.body.data.oracle.paused, false, 'resumed');
    const after = await apiOk('/api/stats');
    eq(after.burnedRaw, before.burnedRaw, '恢复后销毁量变化');
    if (ctx.pausedRound) {
      const restarted = resume.body.data.rounds.find((row) => row.roundId === ctx.pausedRound.roundId);
      eq(restarted.state, 'OBSERVING', '恢复后状态');
      eq(restarted.candlesSeen, 0, '恢复后应重启完整 12 根窗口');
    }
    return ctx.pausedRound ? 'R' + ctx.pausedRound.roundId + ' 暂停冻结计数 → 恢复重启 12 根，未销毁本金' : '仅暂停标志（无观察中轮次）';
  });
}

async function settlementTests() {
  await test('观察窗口推进 → 12 根后结算', async () => {
    if (!ctx.fast) {
      skip('标准演示 90s/根，测试期内观察窗口不会走完（可用 DEMO_CANDLE_SECONDS=1~2 全量覆盖）');
    }
    const deadline = Date.now() + SETTLE_TIMEOUT_SEC * 1000;
    let round = null;
    while (Date.now() < deadline) {
      const rounds = await apiOk('/api/rounds');
      round = rounds.find((row) => row.roundId === 3);
      if (round.state === 'SUCCEEDED' || round.state === 'FAILED_PERMANENT') break;
      await sleep(1500);
    }
    assert(round, 'R3 缺失');
    assert(round.state === 'SUCCEEDED' || round.state === 'FAILED_PERMANENT', '等待 ' + SETTLE_TIMEOUT_SEC + 's 仍未结算：' + round.state);
    eq(round.candlesSeen, 12, 'K 线数');
    eq(round.qualifiedCandles, 9, '达标数');
    eq(round.state, 'SUCCEEDED', 'R3 应成功');
    eq(round.result, 'SUCCESS', 'result');
    const detail = await apiOk('/api/rounds/3');
    eq(detail.candles.length, 12, 'candles');
    eq(detail.live, null, 'live');
    ctx.r3Settled = true;
    return 'R3 SUCCEEDED（9/12），不可逆消费 K 线';
  });

  await test('DEMO_AUTOPLAY：终态后自动开启 R4', async () => {
    if (!ctx.fast) {
      skip('标准演示下 R3 仍在观察期，自动开轮不会触发');
    }
    const tick = await apiPost('/api/admin/tick');
    eq(tick.status, 200, 'tick status');
    let r4 = tick.body.data.rounds.find((row) => row.roundId === 4);
    const deadline = Date.now() + 15_000;
    while (r4.state !== 'STAKING_OPEN' && Date.now() < deadline) {
      await sleep(1000);
      const res = await apiPost('/api/admin/tick');
      r4 = res.body.data.rounds.find((row) => row.roundId === 4);
    }
    eq(r4.state, 'STAKING_OPEN', 'R4 state（DEMO_AUTOPLAY 未生效）');
    eq(r4.targetPriceUsdE8, '6400000', 'R4 target = 16×P0');
    assert(r4.stakeCloseAt > Date.now(), 'R4 质押窗口未开启');
    const overview = await api('/api/admin/overview', {}, ADMIN_TOKEN);
    assert(overview.body.data.events.some((event) => event.action === 'ROUND_OPENED' && event.detail.includes('R4')), '缺少 R4 审计事件');
    ctx.r4Open = true;
    return 'admin tick 触发自动开轮：R4 STAKING_OPEN target=6400000';
  });

  await test('POST /api/admin/rounds/advance（存在活动轮次 → 409）', async () => {
    const res = await apiPost('/api/admin/rounds/advance');
    eq(res.status, 409, 'status');
    eq(res.body.error.code, 'CONFLICT', 'code');
    return '活动轮次未终态时 advance 返回 409 CONFLICT（符合状态机约束）';
  });
}

async function writeTests() {
  await test('POST /api/stake 校验：非窗口 / 风险版本 / 金额 / 地址', async () => {
    const calls = [
      {
        name: '非质押窗口(R1)',
        body: { address: UNKNOWN_ADDRESS, roundId: 1, amountRaw: '1000000000', riskDisclosureVersion: 1, acceptFullPrincipalBurn: true },
        status: 409,
      },
      {
        name: '风险版本不匹配',
        body: { address: UNKNOWN_ADDRESS, roundId: 4, amountRaw: '1000000000', riskDisclosureVersion: 99, acceptFullPrincipalBurn: true },
        status: 400,
      },
      {
        name: '未勾选本金销毁确认',
        body: { address: UNKNOWN_ADDRESS, roundId: 4, amountRaw: '1000000000', riskDisclosureVersion: 1, acceptFullPrincipalBurn: false },
        status: 400,
      },
      {
        name: '金额为 0',
        body: { address: UNKNOWN_ADDRESS, roundId: 4, amountRaw: '0', riskDisclosureVersion: 1, acceptFullPrincipalBurn: true },
        status: 400,
      },
      {
        name: '金额超余额',
        body: { address: UNKNOWN_ADDRESS, roundId: 4, amountRaw: '999999999999999999', riskDisclosureVersion: 1, acceptFullPrincipalBurn: true },
        status: 400,
      },
      {
        name: '非法地址',
        body: { address: 'not-an-address', roundId: 4, amountRaw: '1000000000', riskDisclosureVersion: 1, acceptFullPrincipalBurn: true },
        status: 400,
      },
    ];
    const failed = [];
    for (const item of calls) {
      const res = await apiPost('/api/stake', item.body);
      if (res.status !== item.status) failed.push(item.name + ' 期望 ' + item.status + ' 实际 ' + res.status);
    }
    assert(failed.length === 0, failed.join('；'));
    return '6 项非法入参全部按预期拒绝';
  });

  await test('POST /api/stake 成功 + nonce 去重', async () => {
    if (!ctx.r4Open) {
      skip('当前无开放质押窗口（标准演示下 R4 未开启）');
    }
    const payload = {
      address: UNKNOWN_ADDRESS,
      roundId: 4,
      amountRaw: '1200000000000',
      riskDisclosureVersion: 1,
      acceptFullPrincipalBurn: true,
      nonce: 'smoke-nonce-1',
    };
    const first = await apiPost('/api/stake', payload);
    eq(first.status, 200, 'status');
    eq(first.body.data.accepted, true, 'accepted');
    eq(first.body.data.position.roundId, 4, 'position.roundId');
    eq(first.body.data.position.amountRaw, '1200000000000', 'position.amountRaw');
    const duplicate = await apiPost('/api/stake', payload);
    eq(duplicate.status, 409, '重复 nonce status');
    eq(duplicate.body.error.code, 'CONFLICT', '重复 nonce code');
    const me = await apiOk('/api/me?address=' + encodeURIComponent(UNKNOWN_ADDRESS));
    const row = me.stakes.find((item) => item.roundId === 4);
    assert(row && BigInt(row.amountRaw) === 1200000000000n, '质押未写入 /api/me');
    return 'accepted + 重复 nonce → 409 + /api/me 可见';
  });

  await test('POST /api/claim 幂等（R1 本金/奖励）', async () => {
    const address = ctx.claimAddress;
    const principal = await apiPost('/api/claim', { address, roundId: 1, kind: 'principal' });
    eq(principal.status, 200, 'principal status');
    eq(principal.body.data.claimed, true, 'principal claimed');
    assert(BigInt(principal.body.data.amountRaw) > 0n, 'principal amount');
    const principalAgain = await apiPost('/api/claim', { address, roundId: 1, kind: 'principal' });
    eq(principalAgain.body.data.claimed, false, '重复领取应为 claimed:false');
    eq(principalAgain.body.data.alreadyClaimed, true, 'alreadyClaimed');
    eq(principalAgain.body.data.amountRaw, principal.body.data.amountRaw, '幂等返回同一金额');

    const reward = await apiPost('/api/claim', { address, roundId: 1, kind: 'reward' });
    eq(reward.status, 200, 'reward status');
    eq(reward.body.data.claimed, true, 'reward claimed');
    assert(BigInt(reward.body.data.amountRaw) > 0n, 'reward amount');

    const me = await apiOk('/api/me?address=' + encodeURIComponent(address));
    assert(!me.claimable.some((row) => row.roundId === 1), '领取后仍显示 R1 可领取');
    assert(BigInt(me.totals.claimedRaw) >= BigInt(principal.body.data.amountRaw) + BigInt(reward.body.data.amountRaw), 'totals.claimedRaw 未累计');
    return '本金+奖励各领一次，二次调用幂等，totals 累加';
  });

  await test('POST /api/claim 非法轮次状态', async () => {
    const failedRound = await apiPost('/api/claim', { address: ctx.claimAddress, roundId: 2, kind: 'principal' });
    eq(failedRound.status, 409, '失败轮次 status');
    assert(failedRound.body.error.message.includes('销毁'), '失败轮次提示应说明已销毁');
    const notSettled = await apiPost('/api/claim', { address: ctx.claimAddress, roundId: 3, kind: 'reward' });
    assert([409, 200].includes(notSettled.status), '未结算轮次状态异常：' + notSettled.status);
    const noStake = await apiPost('/api/claim', { address: UNKNOWN_ADDRESS, roundId: 1, kind: 'principal' });
    eq(noStake.status, 404, '无质押记录 status');
    return '失败轮次 409 / 未结算 409 / 无记录 404';
  });
}

async function assetTests() {
  await test('静态资源 + SPA 回退（安全头同样生效）', async () => {
    const res = await fetch(BASE + '/');
    eq(res.status, 200, '首页 status');
    const type = res.headers.get('content-type') || '';
    assert(type.includes('text/html'), '首页 content-type 应为 html：' + type);
    eq(res.headers.get('x-frame-options'), 'DENY', '静态资源安全头');
    const spa = await fetch(BASE + '/leaderboard');
    eq(spa.status, 200, 'SPA 回退 status');
    assert((spa.headers.get('content-type') || '').includes('text/html'), 'SPA 回退 content-type');
    return 'index + /leaderboard 均 200 html';
  });
}

/* ================================ 主流程 ================================ */

async function main() {
  console.log('FUSE smoke → ' + BASE + '（ADMIN_TOKEN ' + (ADMIN_TOKEN ? '已设置' : '缺失') + '）');
  try {
    const health = await api('/api/health');
    if (health.status !== 200) throw new Error('服务未就绪：HTTP ' + health.status + ' ' + health.text.slice(0, 160));
  } catch (error) {
    console.error('无法连接 ' + BASE + '：' + (error instanceof Error ? error.message : String(error)));
    console.error('请先启动：cd worker && ./node_modules/.bin/wrangler dev --port 8787 --var ADMIN_TOKEN:' + ADMIN_TOKEN);
    process.exit(2);
  }

  await baseline();
  await adminTests();
  await settlementTests();
  await writeTests();
  await assetTests();

  const failed = printTable();
  const summary = ctx.r3Settled ? '（极速模式：已完成观察窗口结算 + 开轮 + 质押/领取闭环）' : '（标准模式：时间相关用例 SKIP）';
  console.log('运行模式：' + (ctx.fast ? 'fast' : 'standard') + ' demoCandleSeconds=' + ctx.demoCandleSeconds + ' ' + summary);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('smoke 脚本异常：', error);
  process.exit(2);
});
