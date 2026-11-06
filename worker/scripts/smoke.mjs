#!/usr/bin/env node
/**
 * A9 引信协议 API 冒烟测试（自测凭证，v10 口径：奖励纯按质押比例，无邀请 / 连续参与 / 滚存 / 早领 / 解锁池）
 *
 * 用法：
 *   # 终端 1（推荐：极速演示种子做全链路覆盖）
 *   DEMO_CANDLE_SECONDS=2 node scripts/generate-seed.mjs        # 输出 worker/seed/seed.sql（不是迁移！）
 *   ./node_modules/.bin/wrangler d1 migrations apply fuse-protocol --local --persist-to /tmp/a9-smoke
 *   ./node_modules/.bin/wrangler d1 execute fuse-protocol --local --persist-to /tmp/a9-smoke --file=./seed/seed.sql
 *   ./node_modules/.bin/wrangler dev --port 8901 --persist-to /tmp/a9-smoke \
 *       --var ADMIN_TOKEN:dev-admin-token --var DEMO_CANDLE_SECONDS:2 --var DEMO_PREVIEW_SECONDS:2
 *
 * ⚠️ 环境对齐：seed 与 wrangler dev 必须使用**同一个 DEMO_CANDLE_SECONDS**（seed 会写 K 线时间网格，
 *    server 用 env 覆盖 seed 的 demo_candle_seconds）。不要在 worker/.dev.vars 里写死
 *    DEMO_CANDLE_SECONDS，否则换 seed 后会报「K 线周期不一致」。
 *
 *   # 终端 2
 *   node scripts/smoke.mjs            # 默认 http://127.0.0.1:8787
 *   SMOKE_BASE=http://127.0.0.1:8901 node scripts/smoke.mjs
 *
 * 环境变量：SMOKE_BASE / ADMIN_TOKEN（默认读 worker/.dev.vars）/ SMOKE_TIMEOUT（默认 180s）
 * 输出 PASS/FAIL/SKIP 表；存在 FAIL 时退出码 1。
 *
 * 重点回归（task-17 / D-28）：目标价档位 tier = 1 + 已成功轮数，失败轮不升档——
 *   R1=2×P0、R2 失败 → R3 仍 4×P0（同档重试）、R3 通过后 R4=8×P0。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.SMOKE_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');

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
const SETTLE_TIMEOUT_SEC = Number(process.env.SMOKE_TIMEOUT || 180);
const UNKNOWN_ADDRESS = 'UQ' + 'A'.repeat(46);

/* 冻结经济参数（v10，断言用，禁止改动） */
const P0_USD_E8 = 116_000n;
const ROUND_REWARD_RAW = 700_000_000n * 1_000_000_000n;
const TEAM_ROUND_RAW = 120_000_000n * 1_000_000_000n;
const TOTAL_SUPPLY_RAW = 10_000_000_000n * 1_000_000_000n;
const MIN_STAKE_RAW = 100_000n * 1_000_000_000n; // v10：最低有效质押 100,000 A9
const R1_STAKE_RAW = 214_800_000n * 1_000_000_000n;
const R2_STAKE_RAW = 241_500_000n * 1_000_000_000n;
const R3_STAKE_RAW = 386_200_000n * 1_000_000_000n;
const R2_BURNED_RAW = ROUND_REWARD_RAW + TEAM_ROUND_RAW + R2_STAKE_RAW; // 1,061.5M（奖励 + 团队 + 本金）

/** v10 纯质押比例：floor(本轮奖励 × 我的质押 / 本轮总质押)（与合约 rewardOf 同口径） */
function proRataReward(stakeRaw, totalRaw) {
  return (ROUND_REWARD_RAW * BigInt(stakeRaw)) / BigInt(totalRaw);
}

const results = [];
const ctx = { fast: false };

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

class SkipTest extends Error {}

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
  if (skipped) console.log('SKIP 原因：标准演示（90s/根）K 线在测试期内不会走完；用 DEMO_CANDLE_SECONDS=2 重新 seed 可全量覆盖。');
  return failed;
}

/** D-28：tier = 1 + 更早轮次中 SUCCEEDED 的数量（已开启轮次精确值） */
function exactTier(roundId, rounds) {
  let successes = 0;
  for (const round of rounds) if (round.roundId < roundId && round.state === 'SUCCEEDED') successes++;
  return successes + 1;
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
    assert(typeof data.schemaVersion === 'number' && data.schemaVersion >= 7, 'schemaVersion 应为 >=7，实际 ' + data.schemaVersion);
    eq(data.dataSource, 'demo', 'dataSource');
    assert(typeof data.now === 'number', 'now 缺失');
    return 'version=' + data.version + ' sha=' + (data.gitSha || '-');
  });

  await test('GET /api/config（V7 冻结参数）', async () => {
    const data = await apiOk('/api/config');
    eq(data.p0UsdE8, '116000', 'p0UsdE8');
    eq(data.usdPriceScale, 100000000, 'usdPriceScale');
    eq(data.priceMultiplier, 2, 'priceMultiplier');
    eq(data.roundCount, 10, 'roundCount');
    eq(data.roundRewardRaw, ROUND_REWARD_RAW.toString(), 'roundRewardRaw');
    eq(data.totalSupplyRaw, TOTAL_SUPPLY_RAW.toString(), 'totalSupplyRaw');
    eq(data.candleCount, 24, 'candleCount');
    eq(data.minQualifiedCandles, 16, 'minQualifiedCandles');
    eq(data.riskDisclosureVersion, 1, 'riskDisclosureVersion');
    eq(data.tonUsdE8, '300000000', 'tonUsdE8');
    eq(data.dataSource, 'demo', 'dataSource');
    eq(data.token.decimals, 9, 'token.decimals');
    assert(data.demo && data.demo.candleSeconds >= 1, 'demo 配置缺失');
    assert(Array.isArray(data.frozenParams) && data.frozenParams.length >= 8, 'frozenParams 过少');
    assert(data.contracts && 'jettonMaster' in data.contracts && 'keeper' in data.contracts && 'teamWallet' in data.contracts, 'contracts 缺失 keeper / teamWallet');
    assert(
      !('teamVault' in data.contracts) && !('oracleAdapter' in data.contracts) && !('adminOwner' in data.contracts),
      'contracts 不应再含 teamVault / oracleAdapter / adminOwner',
    );
    eq(data.minStakeRaw, MIN_STAKE_RAW.toString(), 'minStakeRaw（100,000 A9）');
    eq(data.teamRoundRaw, TEAM_ROUND_RAW.toString(), 'teamRoundRaw（1.2 亿）');
    for (const key of [
      'streakBonusBps',
      'streakMaxRounds',
      'referralBonusBps',
      'referralCapMultiple',
      'earlyClaimPenaltyBps',
      'rolloverCapPerAddressRaw',
      'unlockDurationSeconds',
    ]) {
      assert(!(key in data), 'v8 字段不应再返回：' + key);
    }
    ctx.demoCandleSeconds = data.demo.candleSeconds;
    ctx.fast = data.demo.candleSeconds <= 5;
    return 'P0=$0.00116 reward=7e8 candle=24/16 demoCandle=' + data.demo.candleSeconds + 's';
  });

  await test('GET /api/rounds（10 轮演示状态机）', async () => {
    const data = await apiOk('/api/rounds');
    eq(data.length, 10, '轮次数');
    const byId = new Map(data.map((row) => [row.roundId, row]));
    ctx.rounds = byId;
    eq(byId.get(1).state, 'SUCCEEDED', 'R1 state');
    eq(byId.get(1).result, 'SUCCESS', 'R1 result');
    eq(byId.get(1).qualifiedCandles, 20, 'R1 达标数');
    eq(byId.get(1).candlesSeen, 24, 'R1 K 线数');
    eq(byId.get(2).state, 'FAILED_PERMANENT', 'R2 state');
    eq(byId.get(2).qualifiedCandles, 12, 'R2 达标数');
    eq(byId.get(2).burnedRaw, R2_BURNED_RAW.toString(), 'R2 burned（三笔销毁）');
    assert(['OBSERVING', 'ORACLE_PAUSED', 'SUCCEEDED', 'FAILED_PERMANENT'].includes(byId.get(3).state), 'R3 state 非法：' + byId.get(3).state);
    assert(byId.get(3).candlesSeen >= 12, 'R3 初始应有 ≥12 根已收盘 K 线，实际 ' + byId.get(3).candlesSeen);
    assert(byId.get(3).qualifiedCandles >= 8, 'R3 初始达标应 ≥8，实际 ' + byId.get(3).qualifiedCandles);
    for (const id of [1, 2, 3]) {
      assert(BigInt(byId.get(id).totalAcceptedStakeRaw) > 0n, 'R' + id + ' totalAcceptedStakeRaw 应 > 0');
      assert(/^0x[0-9a-f]{64}$/.test(byId.get(id).candleHash ?? ''), 'R' + id + ' candleHash 格式');
      assert(!('totalWeightRaw' in byId.get(id)), 'v10 /api/rounds 不再返回 totalWeightRaw');
    }
    eq(byId.get(1).totalAcceptedStakeRaw, R1_STAKE_RAW.toString(), 'R1 总质押');
    eq(byId.get(1).teamReleasedRaw, TEAM_ROUND_RAW.toString(), 'R1 teamReleasedRaw（成功轮已释放 1.2 亿）');
    eq(byId.get(2).teamReleasedRaw, null, 'R2 teamReleasedRaw（失败轮不释放）');
    eq(byId.get(4).candleHash, null, 'R4 candleHash');
    // autoplay 可能在测试启动前已把 R4 打开（尤其 10s/2s 快照），两种状态都合法；
    // 真正「不得提前开轮」由 test 26 的 autoplay 断言负责。
    assert(
      byId.get(4).state === 'UNOPENED' || byId.get(4).state === 'STAKING_OPEN',
      'R4 state 非法：' + byId.get(4).state,
    );
    for (let id = 5; id <= 10; id++) eq(byId.get(id).state, 'UNOPENED', 'R' + id + ' state');
    return 'R1 S(20/24) / R2 F(12/24) / R3 ' + byId.get(3).state + ' / R4-R10 U';
  });

  await test('D-28 档位：失败不升档（R3 与 R2 同档）', async () => {
    const data = await apiOk('/api/rounds');
    const byId = new Map(data.map((row) => [row.roundId, row]));
    // 目标价 = P0 × 2^tier，tier = 1 + 已成功轮数
    eq(byId.get(1).targetPriceUsdE8, '232000', 'R1 target（tier1=2×P0）');
    eq(byId.get(1).priceMultiplier, 2, 'R1 mult');
    eq(byId.get(2).targetPriceUsdE8, '464000', 'R2 target（tier2=4×P0）');
    eq(byId.get(2).priceMultiplier, 4, 'R2 mult');
    // R2 失败 → R3 同档重试，仍为 4×P0（不是 8×P0）
    eq(byId.get(3).targetPriceUsdE8, '464000', 'R3 target（R2 失败，同档 tier2）');
    eq(byId.get(3).priceMultiplier, 4, 'R3 mult（应为 4×，不是 8×）');
    // R4 投影：R3 若通过 → tier3 = 8×P0
    eq(byId.get(4).targetPriceUsdE8, '928000', 'R4 target（投影 tier3=8×P0）');
    eq(byId.get(4).priceMultiplier, 8, 'R4 mult');
    // 所有已开启轮次：mult 必须等于 2^(1+已成功轮数)
    for (const row of data) {
      if (row.state === 'UNOPENED') continue;
      const tier = exactTier(row.roundId, data);
      eq(row.priceMultiplier, Math.pow(2, tier), 'R' + row.roundId + ' mult vs tier');
      eq(row.targetPriceUsdE8, (P0_USD_E8 * (1n << BigInt(tier))).toString(), 'R' + row.roundId + ' target vs tier');
    }
    const ladder = data.map((row) => 'R' + row.roundId + ':' + row.priceMultiplier + '×/' + row.targetPriceUsdE8).join(' ');
    return ladder;
  });

  await test('GET /api/rounds/1（终态详情）', async () => {
    const data = await apiOk('/api/rounds/1');
    eq(data.candles.length, 24, 'K 线数');
    eq(data.candles.filter((c) => c.qualified).length, 20, '达标 K 线数');
    eq(data.live, null, 'live');
    eq(data.secondsRemaining, null, 'secondsRemaining');
    eq(data.nextState, null, 'nextState');
    assert(BigInt(data.priceUsdE8) > 0n, 'priceUsdE8 非法');
    return '24 根 / 20 达标 / price=' + data.priceUsdE8;
  });

  await test('GET /api/rounds/1/candles', async () => {
    const data = await apiOk('/api/rounds/1/candles');
    eq(data.length, 24, '长度');
    data.forEach((candle, index) => {
      eq(candle.candleIndex, index, 'candleIndex');
      assert(isDigits(candle.twapPriceUsdE8), 'twap 非 raw 字符串');
      assert(candle.periodEnd > candle.periodStart, '时间区间非法');
      assert(candle.coverageBps >= 0 && candle.coverageBps <= 10000, 'coverageBps');
      assert(candle.validSourceCount > 0, 'validSourceCount');
      assert(/^0x[0-9a-f]+$/.test(candle.dataDigest), 'dataDigest');
    });
    return '24 根，字段/时间区间/摘要齐全';
  });

  await test('GET /api/rounds/3（观察中 live 状态）', async () => {
    const data = await apiOk('/api/rounds/3');
    ctx.round3 = data;
    eq(data.candles.length, data.candlesSeen, 'candles.length 与 candlesSeen 不一致');
    eq(data.candles.filter((candle) => candle.qualified).length, data.qualifiedCandles, 'qualified 计数与 K 线不一致');
    const grid = ctx.demoCandleSeconds * 1000;
    data.candles.forEach((candle, index) => {
      eq(candle.candleIndex, index, 'R3 candleIndex 连续');
      const actual = candle.periodEnd - candle.periodStart;
      if (actual !== grid) {
        throw new Error(
          'K 线周期不一致：/api/config demo.candleSeconds=' + ctx.demoCandleSeconds + 's（期望 ' + grid + 'ms），' +
          '但 DB 中 seed 的 K 线网格=' + actual + 'ms（candle#' + index + '）。\n' +
          '原因：seed 与 wrangler dev 的 DEMO_CANDLE_SECONDS 不一致（常见于 worker/.dev.vars 覆盖，或 --var 与生成 seed 时不同）。\n' +
          '修复：两者用同一个值，例如：\n' +
          '  DEMO_CANDLE_SECONDS=2 EPOCH=... node scripts/generate-seed.mjs\n' +
          '  wrangler dev --var DEMO_CANDLE_SECONDS:2 --var DEMO_PREVIEW_SECONDS:2\n' +
          '或删除 worker/.dev.vars 中的 DEMO_CANDLE_SECONDS（让 server 跟随 seed 的 demo_candle_seconds）。',
        );
      }
      if (index > 0) eq(candle.periodStart, data.candles[index - 1].periodEnd, 'K 线首尾相接');
    });
    assert(BigInt(data.priceUsdE8) > 0n, 'priceUsdE8');
    if (data.state === 'OBSERVING') {
      assert(data.live !== null, 'OBSERVING 必须返回 live');
      eq(data.live.candleIndex, data.candlesSeen, 'live.candleIndex');
      assert(data.live.progressBps >= 0 && data.live.progressBps <= 10000, 'progressBps');
      assert(data.secondsRemaining !== null && data.secondsRemaining >= 0, 'secondsRemaining');
      assert(data.nextState === null || data.nextState === 'SETTLING_SUCCESS' || data.nextState === 'SETTLING_FAILURE', 'nextState');
      return data.candlesSeen + '/24 根，live#' + data.live.candleIndex + ' 剩余 ' + data.secondsRemaining + 's';
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
    eq(data.burnedRaw, R2_BURNED_RAW.toString(), 'burnedRaw');
    eq(data.supplyRaw, (TOTAL_SUPPLY_RAW - R2_BURNED_RAW).toString(), 'supplyRaw');
    eq(data.lockedStakeRaw, R3_STAKE_RAW.toString(), 'lockedStakeRaw');
    assert(!('lockedRewardRaw' in data) && !('unlock' in data), 'v10 /api/stats 不再返回 lockedRewardRaw / unlock');
    eq(data.stakerCount, 12, 'stakerCount');
    assert(isDigits(data.volume24hUsdE8) && BigInt(data.volume24hUsdE8) > 0n, 'volume24hUsdE8');
    assert(BigInt(data.priceUsdE8) > 0n, 'priceUsdE8');
    assert(BigInt(data.price24hAgoUsdE8) > 0n, 'price24hAgoUsdE8');
    eq(data.oracle.online, true, 'oracle.online');
    eq(data.oracle.paused, false, 'oracle.paused');
    return 'burned=1,061.5M supply=8.9385e18 locked=386.2M';
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
      assert(tokens >= 2_000 && tokens <= 500_000, '成交金额超出演示量级：' + tokens + ' A9');
    });
    return '20 条，2k~450k A9 量级 / 倒序 / 字段合法';
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

  await test('GET /api/me（未领取地址：R1 可领，纯质押比例）', async () => {
    const board = await apiOk('/api/rounds/1/leaderboard');
    const target = board[board.length - 1];
    ctx.claimAddress = target.address;
    const data = await apiOk('/api/me?address=' + encodeURIComponent(target.address));
    ctx.meBefore = data;
    eq(data.address, target.address, 'address');
    // v10 形状：不再返回 rewards / stake / referral / unlock
    for (const key of ['rewards', 'stake', 'referral', 'unlock']) {
      assert(!(key in data), '/api/me 不应再返回 ' + key);
    }
    data.stakes.forEach((row) => {
      eq(row.address, target.address, '/api/me stake.address 未原样返回');
      assert(isDigits(row.rewardRaw), 'stake.rewardRaw 应为 raw 字符串');
      assert(typeof row.claimable === 'boolean' && typeof row.claimed === 'boolean', 'stake.claimable/claimed 缺失');
    });
    const rounds = new Set(data.stakes.map((row) => row.roundId));
    assert(rounds.has(1) && rounds.has(2) && rounds.has(3), 'stakes 未覆盖 R1/R2/R3');
    const claimableR1 = data.claimable.find((row) => row.roundId === 1);
    assert(claimableR1, 'R1 应有可领取');
    eq(claimableR1.principalRaw, target.amountRaw, 'R1 principalRaw = 质押额');
    const expectedReward = proRataReward(target.amountRaw, R1_STAKE_RAW);
    eq(claimableR1.rewardRaw, expectedReward.toString(), 'R1 rewardRaw = floor(7 亿 × 质押 / 总质押)');
    eq(target.rewardEstimateRaw, expectedReward.toString(), '排行榜 rewardEstimateRaw 与 /api/me 同口径');
    eq(claimableR1.state, 'SUCCEEDED', 'claimable state');
    assert((data.claimableAll.roundsMask & 1) === 1, 'claimableAll.roundsMask 应含 R1 位');
    eq(data.claimableAll.principalRaw, claimableR1.principalRaw, 'claimableAll.principalRaw');
    eq(data.claimableAll.rewardRaw, claimableR1.rewardRaw, 'claimableAll.rewardRaw');
    eq(data.refund.pendingRaw, '0', 'refund.pendingRaw');
    assert(isDigits(data.totals.stakedRaw) && BigInt(data.totals.stakedRaw) > 0n, 'totals.stakedRaw');

    // A0 夹具：R1 已领（本金 + 全额奖励一次领完）
    const top = board[0];
    const topMe = await apiOk('/api/me?address=' + encodeURIComponent(top.address));
    ctx.meTop = topMe;
    ctx.topAddress = top.address;
    const topR1 = topMe.stakes.find((row) => row.roundId === 1);
    assert(topR1 && topR1.claimed === true && topR1.claimable === false, 'A0 R1 应已领取');
    eq(topR1.rewardRaw, proRataReward(top.amountRaw, R1_STAKE_RAW).toString(), 'A0 R1 rewardRaw');
    assert(!topMe.claimable.some((row) => row.roundId === 1), 'A0 R1 不应再出现在 claimable');
    eq(
      topMe.totals.claimedRaw,
      (BigInt(top.amountRaw) + BigInt(topR1.rewardRaw)).toString(),
      'A0 totals.claimedRaw = 本金 + 奖励',
    );
    return top.address.slice(0, 6) + '… R1 已领 claimedRaw=' + topMe.totals.claimedRaw;
  });

  await test('GET /api/referral/:address 已删除 → 404（v10 无邀请）', async () => {
    const res = await api('/api/referral/' + encodeURIComponent(UNKNOWN_ADDRESS));
    eq(res.status, 404, 'status');
    eq(res.body.error.code, 'NOT_FOUND', 'code');
    return '404 NOT_FOUND';
  });

  await test('GET /api/me（陌生地址返回空数组）', async () => {
    const data = await apiOk('/api/me?address=' + encodeURIComponent(UNKNOWN_ADDRESS));
    eq(data.stakes.length, 0, 'stakes');
    eq(data.claimable.length, 0, 'claimable');
    eq(data.totals.stakedRaw, '0', 'totals.stakedRaw');
    eq(data.totals.rewardRaw, '0', 'totals.rewardRaw');
    eq(data.totals.claimedRaw, '0', 'totals.claimedRaw');
    eq(data.claimableAll.principalRaw, '0', 'claimableAll.principalRaw');
    eq(data.claimableAll.rewardRaw, '0', 'claimableAll.rewardRaw');
    eq(data.claimableAll.roundsMask, 0, 'claimableAll.roundsMask');
    eq(data.refund.pendingRaw, '0', 'refund.pendingRaw');
    return '未质押地址 → 200 + 空数组（v10 字段齐全）';
  });

  await test('GET /api/me 缺少 address → 400', async () => {
    const res = await api('/api/me');
    eq(res.status, 400, 'status');
    eq(res.body.error.code, 'BAD_REQUEST', 'code');
    return 'BAD_REQUEST';
  });

  await test('未知 /api 路径 → 404（且不触发 reconcile）', async () => {
    const res = await api('/api/nope');
    eq(res.status, 404, 'status');
    eq(res.body.error.code, 'NOT_FOUND', 'code');
    eq(res.headers.get('x-a9-reconciled'), '0', '未知路径不应 reconcile');
    const res2 = await api('/api/rounds/99');
    eq(res2.status, 400, '非法轮次 status');
    eq(res2.headers.get('x-a9-reconciled'), '0', '非法轮次不应 reconcile');
    const res3 = await api('/api/rounds/1/nope');
    eq(res3.status, 404, '无效子路径 status');
    eq(res3.headers.get('x-a9-reconciled'), '0', '无效子路径不应 reconcile');
    return '404/400 均 X-A9-Reconciled: 0';
  });
}

async function adminTests() {
  await test('admin 鉴权：无 token / 错 token → 401（先鉴权后 reconcile）', async () => {
    const none = await api('/api/admin/overview');
    eq(none.status, 401, '无 token status');
    eq(none.body.error.code, 'UNAUTHORIZED', '无 token code');
    eq(none.headers.get('x-a9-reconciled'), '0', '未授权 admin 不应 reconcile');
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

  await test('POST /api/admin/indexer/tick + reconcile（运维手动触发）', async () => {
    const tick = await apiPost('/api/admin/indexer/tick');
    eq(tick.status, 200, 'indexer tick status');
    eq(tick.body.ok, true, 'indexer tick ok');
    assert(typeof tick.body.data.pages === 'number', 'tick.pages');
    assert(typeof tick.body.data.writes === 'number', 'tick.writes');
    const rec = await apiPost('/api/admin/indexer/reconcile');
    eq(rec.status, 200, 'indexer reconcile status');
    eq(rec.body.ok, true, 'indexer reconcile ok');
    assert(Array.isArray(rec.body.data.diffs), 'reconcile.diffs');
    const unauth = await api('/api/admin/indexer/tick', { method: 'POST' });
    eq(unauth.status, 401, '无 token indexer tick 应 401');
    return 'tick 200 / reconcile 200 / 无 token 401（demo stub 返回未实现但不抛错）';
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

  await test('GET /api/auth/nonce 独立限流（默认 10/min）→ 429', async () => {
    const address = ctx.claimAddress ?? UNKNOWN_ADDRESS;
    let last = null;
    for (let i = 0; i < 12; i++) {
      last = await api('/api/auth/nonce?address=' + encodeURIComponent(address));
      if (last.status === 429) break;
    }
    assert(last, 'nonce 请求失败');
    eq(last.status, 429, 'nonce 超过配额应 429');
    eq(last.body.error.code, 'RATE_LIMITED', 'code');
    eq(last.headers.get('x-a9-reconciled'), '0', 'nonce 不应 reconcile');
    return '第 ' + (last ? 12 : 0) + ' 次请求 429 RATE_LIMITED';
  });

  await test('预言机暂停/恢复（不销毁本金、不消耗档位）', async () => {
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
    }
    const resume = await apiPost('/api/admin/oracle/resume');
    eq(resume.status, 200, 'resume status');
    eq(resume.body.data.oracle.paused, false, 'resumed');
    const after = await apiOk('/api/stats');
    eq(after.burnedRaw, before.burnedRaw, '恢复后销毁量变化');
    if (ctx.pausedRound) {
      const restarted = resume.body.data.rounds.find((row) => row.roundId === ctx.pausedRound.roundId);
      eq(restarted.state, 'OBSERVING', '恢复后状态');
      eq(restarted.candlesSeen, 0, '恢复后应重启完整 24 根观察窗口');
    }
    return ctx.pausedRound ? 'R' + ctx.pausedRound.roundId + ' 暂停冻结计数 → 恢复重启 24 根，未销毁本金' : '仅暂停标志（无观察中轮次）';
  });
}

async function settlementTests() {
  await test('观察窗口推进 → 24 根后结算（16 阈值）', async () => {
    if (!ctx.fast) {
      skip('标准演示 90s/根，测试期内观察窗口不会走完（可用 DEMO_CANDLE_SECONDS=2 全量覆盖）');
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
    eq(round.candlesSeen, 24, 'K 线数');
    eq(round.qualifiedCandles, 17, '达标数');
    eq(round.state, 'SUCCEEDED', 'R3 应成功');
    eq(round.result, 'SUCCESS', 'result');
    const detail = await apiOk('/api/rounds/3');
    eq(detail.candles.length, 24, 'candles');
    eq(detail.live, null, 'live');
    ctx.r3Settled = true;
    return 'R3 SUCCEEDED（17/24 >= 16）';
  });

  await test('DEMO_AUTOPLAY：终态后自动开启 R4（tier3 = 8×P0）', async () => {
    if (!ctx.fast) skip('标准演示下 R3 仍在观察期，自动开轮不会触发');
    const deadline = Date.now() + Math.max(20_000, SETTLE_TIMEOUT_SEC * 1000);
    let r4 = null;
    while (Date.now() < deadline) {
      const tick = await apiPost('/api/admin/tick');
      eq(tick.status, 200, 'tick status');
      r4 = tick.body.data.rounds.find((row) => row.roundId === 4);
      if (r4.state === 'STAKING_OPEN') break;
      await sleep(1000);
    }
    assert(r4, 'R4 缺失');
    eq(r4.state, 'STAKING_OPEN', 'R4 state（DEMO_AUTOPLAY 未生效）');
    // R1 成功 + R3 成功 → successCount=2 → tier3 = 8×P0 = 928000
    eq(r4.targetPriceUsdE8, '928000', 'R4 target = 8×P0（tier3）');
    eq(r4.priceMultiplier, 8, 'R4 mult');
    assert(r4.stakeCloseAt > Date.now(), 'R4 质押窗口未开启');
    const overview = await api('/api/admin/overview', {}, ADMIN_TOKEN);
    const opened = overview.body.data.events.find((event) => event.action === 'ROUND_OPENED' && event.detail.includes('R4'));
    assert(opened, '缺少 R4 ROUND_OPENED 审计事件');
    assert(opened.detail.includes('tier=3'), '审计事件未记录 tier=3：' + opened.detail);
    ctx.r4Open = true;
    // v10：R3 结算成功后，奖励按质押比例一次可领（无滚存 / 早领）
    const r3Board = await apiOk('/api/rounds/3/leaderboard');
    const meR3 = await apiOk('/api/me?address=' + encodeURIComponent(r3Board[0].address));
    const r3Stake = meR3.stakes.find((row) => row.roundId === 3);
    assert(r3Stake && r3Stake.state === 'SUCCEEDED', 'R3 结算后 stake.state 应为 SUCCEEDED');
    assert(r3Stake.claimable === true, 'R3 结算成功后应可领取');
    eq(r3Stake.rewardRaw, proRataReward(r3Board[0].amountRaw, R3_STAKE_RAW).toString(), 'R3 奖励 = 7 亿 × 质押 / 总质押');
    return 'R4 STAKING_OPEN tier3 target=928000；R3 奖励可领 ' + r3Stake.rewardRaw + ' raw';
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
        body: { address: UNKNOWN_ADDRESS, roundId: 1, amountRaw: MIN_STAKE_RAW.toString(), riskDisclosureVersion: 1, acceptFullPrincipalBurn: true },
        status: 409,
      },
      {
        name: '风险版本不匹配',
        body: { address: UNKNOWN_ADDRESS, roundId: 4, amountRaw: MIN_STAKE_RAW.toString(), riskDisclosureVersion: 99, acceptFullPrincipalBurn: true },
        status: 400,
      },
      {
        name: '未勾选本金销毁确认',
        body: { address: UNKNOWN_ADDRESS, roundId: 4, amountRaw: MIN_STAKE_RAW.toString(), riskDisclosureVersion: 1, acceptFullPrincipalBurn: false },
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
    if (!ctx.r4Open) skip('当前无开放质押窗口（标准演示下 R4 未开启）');
    const payload = {
      address: UNKNOWN_ADDRESS,
      roundId: 4,
      amountRaw: MIN_STAKE_RAW.toString(),
      riskDisclosureVersion: 1,
      acceptFullPrincipalBurn: true,
      nonce: 'smoke-nonce-1',
    };
    const first = await apiPost('/api/stake', payload);
    eq(first.status, 200, 'status');
    eq(first.body.data.accepted, true, 'accepted');
    eq(first.body.data.position.roundId, 4, 'position.roundId');
    eq(first.body.data.position.amountRaw, MIN_STAKE_RAW.toString(), 'position.amountRaw');
    const duplicate = await apiPost('/api/stake', payload);
    eq(duplicate.status, 409, '重复 nonce status');
    eq(duplicate.body.error.code, 'CONFLICT', '重复 nonce code');
    const me = await apiOk('/api/me?address=' + encodeURIComponent(UNKNOWN_ADDRESS));
    const row = me.stakes.find((item) => item.roundId === 4);
    assert(row && BigInt(row.amountRaw) === MIN_STAKE_RAW, '质押未写入 /api/me');
    return 'accepted（恰好 minStakeRaw）+ 重复 nonce → 409 + /api/me 可见';
  });

  await test('POST /api/stake 低于 minStakeRaw → 400（v10 最低 100,000 A9）', async () => {
    const res = await apiPost('/api/stake', {
      address: UNKNOWN_ADDRESS,
      roundId: 4,
      amountRaw: (MIN_STAKE_RAW - 1n).toString(),
      riskDisclosureVersion: 1,
      acceptFullPrincipalBurn: true,
    });
    eq(res.status, 400, 'status');
    assert(String(res.body?.error?.message ?? '').includes('最低'), '错误信息应说明最低质押：' + res.body?.error?.message);
    return 'minStakeRaw - 1 raw → 400';
  });

  await test('POST /api/claim R1：本金 + 全额奖励一次领完，二次幂等', async () => {
    const address = ctx.claimAddress;
    const r1Before = ctx.meBefore.claimable.find((row) => row.roundId === 1);
    assert(r1Before, '领取前 R1 应可领');
    const first = await apiPost('/api/claim', { address, roundId: 1 });
    eq(first.status, 200, 'status');
    eq(first.body.data.claimed, true, 'claimed');
    eq(first.body.data.roundsMask, 1, 'roundsMask（bit0 = R1）');
    eq(first.body.data.principalRaw, r1Before.principalRaw, 'principalRaw');
    eq(first.body.data.rewardRaw, r1Before.rewardRaw, 'rewardRaw（全额，无早领折扣）');
    eq(
      first.body.data.amountRaw,
      (BigInt(r1Before.principalRaw) + BigInt(r1Before.rewardRaw)).toString(),
      'amountRaw = 本金 + 奖励',
    );
    const second = await apiPost('/api/claim', { address, roundId: 1 });
    eq(second.status, 200, '重复领取 status');
    eq(second.body.data.claimed, false, '重复领取应为 claimed:false');
    eq(second.body.data.alreadyClaimed, true, 'alreadyClaimed');

    const me = await apiOk('/api/me?address=' + encodeURIComponent(address));
    assert(!me.claimable.some((row) => row.roundId === 1), '领取后仍显示 R1 可领取');
    const r1After = me.stakes.find((row) => row.roundId === 1);
    assert(r1After.claimed === true && r1After.claimable === false, 'R1 stake 应已领取');
    eq(r1After.rewardRaw, r1Before.rewardRaw, '领取后 rewardRaw 不变');
    eq(me.totals.claimedRaw, first.body.data.amountRaw, 'totals.claimedRaw');
    return 'R1 本金 + 奖励 ' + first.body.data.amountRaw + ' raw 一次领完，二次 alreadyClaimed';
  });

  await test('POST /api/claim A0（seed 夹具已领 R1）→ alreadyClaimed', async () => {
    const res = await apiPost('/api/claim', { address: ctx.topAddress, roundId: 1 });
    eq(res.status, 200, 'status');
    eq(res.body.data.claimed, false, 'claimed');
    eq(res.body.data.alreadyClaimed, true, 'alreadyClaimed');
    return 'claimed:false alreadyClaimed:true';
  });

  await test('POST /api/claim 不可领：R2 失败 → 409；R3 未结算 → 409', async () => {
    const failedRound = await apiPost('/api/claim', { address: ctx.claimAddress, roundId: 2 });
    eq(failedRound.status, 409, 'R2 status');
    assert(failedRound.body.error.message.includes('销毁'), 'R2 提示应说明已销毁');
    const rounds = await apiOk('/api/rounds');
    const r3 = rounds.find((row) => row.roundId === 3);
    const r3Claim = await apiPost('/api/claim', { address: ctx.claimAddress, roundId: 3 });
    if (r3.state === 'SUCCEEDED') {
      // 快速模式下 R3 已结算成功：此时 R3 可领，应 200 且 roundsMask 为 bit2
      eq(r3Claim.status, 200, 'R3 已成功结算 → 可领');
      eq(r3Claim.body.data.roundsMask, 4, 'R3 roundsMask（bit2）');
      return 'R2 409（已销毁）/ R3 SUCCEEDED → 200 可领';
    }
    eq(r3Claim.status, 409, 'R3 未成功结算 → 409');
    return 'R2 409（已销毁）/ R3 ' + r3.state + ' → 409';
  });

  await test('POST /api/claim 无质押记录 → 404', async () => {
    const noStake = await apiPost('/api/claim', { address: UNKNOWN_ADDRESS, roundId: 1 });
    eq(noStake.status, 404, '无质押记录 status');
    return '404';
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
  console.log('A9 smoke → ' + BASE + '（ADMIN_TOKEN ' + (ADMIN_TOKEN ? '已设置' : '缺失') + '）');
  try {
    const health = await api('/api/health');
    if (health.status !== 200) throw new Error('服务未就绪：HTTP ' + health.status + ' ' + health.text.slice(0, 160));
  } catch (error) {
    console.error('无法连接 ' + BASE + '：' + (error instanceof Error ? error.message : String(error)));
    console.error('请先启动：cd worker && ./node_modules/.bin/wrangler dev --port 8901 --persist-to /tmp/a9-smoke');
    process.exit(2);
  }

  await baseline();
  await adminTests();
  await settlementTests();
  await writeTests();
  await assetTests();

  const failed = printTable();
  console.log('运行模式：' + (ctx.fast ? 'fast' : 'standard') + ' demoCandleSeconds=' + ctx.demoCandleSeconds);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('smoke 脚本异常：', error);
  process.exit(2);
});
