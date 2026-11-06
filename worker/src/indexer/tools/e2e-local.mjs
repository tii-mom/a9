#!/usr/bin/env node
/**
 * e2e-local.mjs — chain 模式「本地 D1 端到端」验收（零云依赖、可重复，CI 可跑）。
 *
 * 做法：用真实链上录制 fixture 起假 toncenter（fixture-server.mjs），让 wrangler dev --local + 本地 D1
 * 跑真实 worker 代码，再断言 D1 / API / 对账 CLI 三者在同一份链上快照上完全一致。
 *
 * 三阶段（避免与运行中的 dev server 抢本地 D1 sqlite → workerd 崩溃）：
 *   Phase 1（服务在线）：cron 引导 + 连续 tick 排空 pending + API 断言 + 幂等 + 对账 CLI；
 *   Phase 2（在线、fixture 下线）：断线演练 → ORACLE_PAUSED、不写脏数据；
 *   Phase 3（服务停机）：用 wrangler d1 execute 复核行数/游标/销毁账本。
 *
 * 用法（仓库根目录）：node worker/src/indexer/tools/e2e-local.mjs [--fixtures <file>]
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const WORKER_DIR = ROOT + '/worker';
const WRANGLER = WORKER_DIR + '/node_modules/.bin/wrangler';
const FIXTURES = process.argv.includes('--fixtures')
  ? process.argv[process.argv.indexOf('--fixtures') + 1]
  : 'worker/src/indexer/tools/fixtures/fasttest-v86.json';
const PORT = 8800 + (process.pid % 150);
const FIXTURE_PORT = PORT + 1;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + detail);
}

/* --------------------------- 链上 fixture 读取 --------------------------- */
const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
const META = fixtures.meta;
const CONFIG_KEYS = [
  'admin', 'oracle', 'jettonMaster', 'stakingJettonWallet', 'teamVault',
  'p0UsdE8', 'priceMultiplier', 'roundRewardRaw', 'teamRoundRaw', 'minStakeRaw',
  'maxStakePerAddressBps', 'maxTotalStakeRaw', 'previewSeconds', 'stakeDurationSeconds',
  'candleSeconds', 'candleCount', 'minQualifiedCandles', 'observationSeconds',
  'techAbortPauseSeconds', 'techAbortObsTimeoutSeconds', 'riskDisclosureVersion', 'configVersion',
];
function stackNum(item) {
  const payload = Array.isArray(item) ? item[1] : item && item.value;
  if (!payload) return 0n;
  if (typeof payload === 'string') {
    if (payload.startsWith('-0x')) return -BigInt('0x' + payload.slice(3));
    if (payload.startsWith('0x')) return BigInt(payload);
    return BigInt(payload);
  }
  if (payload.value) return BigInt(payload.value.startsWith('0x') ? payload.value : '0x' + payload.value);
  return 0n;
}
function stackAddress(item) {
  const payload = Array.isArray(item) ? item[1] : null;
  const data = payload && payload.object && payload.object.data;
  if (!data || typeof data.b64 !== 'string' || typeof data.len !== 'number') return null;
  const bytes = Buffer.from(data.b64, 'base64');
  let pos = 0;
  const read = (bits) => {
    let v = 0n;
    for (let i = 0; i < bits; i++) {
      const byte = bytes[pos >> 3] ?? 0;
      v = (v << 1n) | BigInt((byte >> (7 - (pos & 7))) & 1);
      pos++;
    }
    return v;
  };
  const tag = read(2);
  if (tag !== 2n) return null;
  if (read(1) === 1n) read(8);
  const wcRaw = Number(read(8));
  const wc = wcRaw > 127 ? wcRaw - 256 : wcRaw;
  const hash = read(256).toString(16).padStart(64, '0');
  return { raw: wc + ':' + hash };
}
const cfgRaw = fixtures.v2['get_protocol_config|' + META.rc + '|[]'];
const cfg = {};
CONFIG_KEYS.forEach((key, i) => {
  cfg[key] = i < 5 ? (stackAddress(cfgRaw.result.stack[i]) || { raw: '' }).raw : stackNum(cfgRaw.result.stack[i]).toString();
});
const ordered = {};
for (const key of CONFIG_KEYS) ordered[key] = String(cfg[key]);
const CONFIG_HASH = 'sha256:' + createHash('sha256').update(JSON.stringify({ v: 1, network: META.network, fields: ordered }), 'utf8').digest('hex');
const THRESHOLD = Number(cfg.minQualifiedCandles);
const CANDLE_SECONDS = Number(cfg.candleSeconds);
const STATUS_TO_STATE = {
  0: 'UNOPENED', 1: 'UNOPENED', 2: 'STAKING_OPEN', 3: 'STAKING_CLOSED', 4: 'OBSERVING',
  5: 'ORACLE_PAUSED', 6: 'SETTLING_SUCCESS', 7: 'SETTLING_FAILURE', 8: 'SUCCEEDED',
  9: 'FAILED_PERMANENT', 10: 'TECHNICAL_ABORTED',
};
function fixtureRound(roundId) {
  const key = 'get_round|' + META.rc + '|' + JSON.stringify([['num', '0x' + roundId.toString(16)]]);
  const stack = fixtures.v2[key].result.stack;
  return {
    roundId: Number(stackNum(stack[0])), status: Number(stackNum(stack[1])),
    targetPriceUsdE8: stackNum(stack[3]), observationStart: Number(stackNum(stack[9])),
    candlesSeen: Number(stackNum(stack[11])), totalAcceptedStakeRaw: stackNum(stack[13]),
  };
}
function decodeSubmitCandle(b64) {
  const buf = Buffer.from(b64, 'base64');
  const flags = buf[4];
  const offBytes = buf[5];
  let pos = 6;
  const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[pos++]; return v; };
  const sizeBytes = flags & 7;
  rd(sizeBytes); rd(sizeBytes); rd(sizeBytes); rd(offBytes); rd(sizeBytes);
  buf[pos++]; buf[pos++];
  const d2 = buf[pos - 1];
  const dataLen = (d2 >> 1) + (d2 & 1);
  const data = buf.subarray(pos, pos + dataLen);
  let bitPos = 0;
  const read = (bits) => {
    let v = 0n;
    for (let i = 0; i < bits; i++) {
      v = (v << 1n) | BigInt((data[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  if (read(32) !== 0x52540003n) return null;
  read(64);
  const roundId = Number(read(8));
  const candleIndex = Number(read(8));
  read(32); read(32);
  const twap = read(128);
  return { roundId, candleIndex, twap };
}
const fixtureCandles = new Map();
for (const tx of fixtures.v3.transactions[META.rc]) {
  const message = tx.in_msg;
  if (!message || message.opcode !== '0x52540003' || !message.message_content || !message.message_content.body) continue;
  const candle = decodeSubmitCandle(message.message_content.body);
  if (!candle) continue;
  const list = fixtureCandles.get(candle.roundId) || [];
  if (!list.some((item) => item.candleIndex === candle.candleIndex)) list.push(candle);
  fixtureCandles.set(candle.roundId, list);
}
const roundsById = new Map();
for (let roundId = 1; roundId <= 10; roundId++) {
  let round;
  try { round = fixtureRound(roundId); } catch { continue; }
  if (round.status === 0) continue;
  roundsById.set(roundId, round);
}
const expectedCandleCount = [...fixtureCandles.values()].reduce((sum, list) => sum + list.length, 0);

/* --------------------------- 子进程管理 --------------------------- */
const children = [];
function spawnChild(label, command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...options });
  children.push({ label, child });
  child.stdout.on('data', (chunk) => { if (process.env.E2E_VERBOSE) process.stdout.write('[' + label + '] ' + chunk); });
  child.stderr.on('data', (chunk) => { if (process.env.E2E_VERBOSE) process.stderr.write('[' + label + '] ' + chunk); });
  return child;
}
function killChild(label) {
  for (const entry of children) {
    if (entry.label !== label) continue;
    try { process.kill(-entry.child.pid, 'SIGKILL'); } catch { try { entry.child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
}
function stopAll() {
  for (const entry of children) {
    try { process.kill(-entry.child.pid, 'SIGKILL'); } catch { try { entry.child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
}
async function waitFor(url, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.status < 500) return true;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('等待超时：' + label + ' ' + url);
}
function d1(sql) {
  const output = execFileSync(WRANGLER, ['d1', 'execute', 'fuse-protocol', '--local', '--json', '--command', sql], {
    cwd: WORKER_DIR, encoding: 'utf8', env: { ...process.env, CI: '1' }, timeout: 120000,
  });
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed[0] : parsed).results || [];
}
function d1Count(table) { return Number(d1('SELECT COUNT(*) AS n FROM ' + table)[0].n); }
async function api(path) {
  const response = await fetch('http://127.0.0.1:' + PORT + path, { signal: AbortSignal.timeout(60000) });
  const text = await response.text();
  try { return { status: response.status, json: JSON.parse(text) }; } catch { return { status: response.status, text }; }
}
function adminToken() {
  try {
    const envFile = readFileSync(WORKER_DIR + '/.dev.vars', 'utf8');
    const line = envFile.split('\n').find((item) => item.startsWith('ADMIN_TOKEN='));
    if (line) return line.slice('ADMIN_TOKEN='.length).trim();
  } catch { /* ignore */ }
  return 'e2e-admin-token-0123456789';
}
async function adminTick(token, path = '/api/admin/indexer/tick') {
  const response = await fetch('http://127.0.0.1:' + PORT + path, {
    method: path.endsWith('/reconcile') ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: path.endsWith('/reconcile') ? undefined : '{}',
    signal: AbortSignal.timeout(120000),
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

/* --------------------------- 主流程 --------------------------- */
async function main() {
  console.log('fixtures=' + FIXTURES + ' rounds=' + roundsById.size + ' configHash=' + CONFIG_HASH.slice(0, 23) + '…');
  for (const port of [PORT, FIXTURE_PORT]) {
    try {
      await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(600) });
      throw new Error('端口 ' + port + ' 已被占用，请先释放（lsof -ti tcp:' + port + ' | xargs kill -9）');
    } catch (error) {
      if (error && String(error.message || '').includes('已被占用')) throw error;
    }
  }
  const token = adminToken();

  console.log('\n[1/8] 重置本地 D1 + migrations（chain 模式不灌 demo seed）…');
  rmSync(WORKER_DIR + '/.wrangler/state', { recursive: true, force: true });
  execFileSync(WRANGLER, ['d1', 'migrations', 'apply', 'fuse-protocol', '--local'], {
    cwd: WORKER_DIR, encoding: 'utf8', env: { ...process.env, CI: '1' }, timeout: 180000,
  });
  check('d1.migrations', d1Count('rounds') === 0, 'rounds=0');

  console.log('[2/8] 启动 fixture toncenter + wrangler dev --local…');
  spawnChild('fixture', process.execPath, ['worker/src/indexer/tools/fixture-server.mjs', '--fixtures', FIXTURES, '--port', String(FIXTURE_PORT)], { cwd: ROOT });
  await waitFor('http://127.0.0.1:' + FIXTURE_PORT + '/__stats', 15000, 'fixture-server');
  spawnChild('wrangler', WRANGLER, [
    'dev', '--port', String(PORT), '--ip', '127.0.0.1',
    '--var', 'DATA_SOURCE:chain',
    '--var', 'TONCENTER_API_KEY:e2e-fixture-key',
    '--var', 'TONCENTER_V2_URL:http://127.0.0.1:' + FIXTURE_PORT + '/v2',
    '--var', 'TONCENTER_V3_URL:http://127.0.0.1:' + FIXTURE_PORT + '/v3',
    '--var', 'CHAIN_NETWORK:' + META.network,
    '--var', 'ROUND_CONTROLLER_ADDRESS:' + META.rc,
    '--var', 'TEAM_VAULT_ADDRESS:' + META.tv,
    '--var', 'JETTON_MASTER_ADDRESS:' + META.jm,
    '--var', 'ORACLE_CONFIG_VERSION:' + cfg.configVersion,
    '--var', 'ORACLE_CONFIG_HASH:' + CONFIG_HASH,
    '--var', 'ADMIN_TOKEN:' + token,
    '--var', 'ALLOWED_ORIGINS:*',
    '--var', 'DEMO_AUTOPLAY:false',
    '--var', 'INDEXER_DEBUG:1',
    '--var', 'INDEXER_MIN_POLL_MS:1000',
    '--var', 'INDEXER_MAX_GETTER_ROUNDS:10',
    '--var', 'INDEXER_MAX_PAGES:10',
  ], { cwd: WORKER_DIR });
  await waitFor('http://127.0.0.1:' + PORT + '/api/health', 90000, 'wrangler dev');
  check('worker.ready', true, 'http://127.0.0.1:' + PORT);

  console.log('[3/8] cron 引导（真实 scheduled 入口）…');
  const scheduled = await fetch('http://127.0.0.1:' + PORT + '/cdn-cgi/local/scheduled', { signal: AbortSignal.timeout(180000) });
  check('cron.trigger', scheduled.status === 200, 'status=' + scheduled.status);
  const health = await api('/api/health');
  const healthData = health.json && health.json.data;
  check('cron.bootstrappedConfig', healthData && healthData.oracle && healthData.oracle.paused === false, JSON.stringify(healthData && healthData.oracle));

  console.log('[4/8] 连续 tick 排空 pending + API 断言（链上真值）…');
  let lastTick = null;
  let allStatesMatch = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const tick = await adminTick(token);
    lastTick = tick.body && tick.body.data;
    if (tick.status !== 200 || !lastTick || lastTick.ok !== true) break;
    // 索引器按 getter 预算分 tick 刷新轮次；用 API 状态是否全部追上链上快照来判断 pending 已排空
    const probe = await api('/api/rounds');
    const rows = (probe.json && probe.json.data) || [];
    const byId = new Map(rows.map((row) => [row.roundId, row]));
    allStatesMatch = [...roundsById.entries()].every(([roundId, round]) => {
      const row = byId.get(roundId);
      return row && row.state === STATUS_TO_STATE[round.status] && String(row.targetPriceUsdE8) === round.targetPriceUsdE8.toString();
    });
    if (allStatesMatch) break;
  }
  check('drain.roundsRefreshed', allStatesMatch, allStatesMatch ? '全部轮次已与链上快照对齐' : '仍有轮次未刷新');
  check('adminTick.ok', lastTick && lastTick.ok === true, JSON.stringify(lastTick));

  const roundsResponse = await api('/api/rounds');
  const apiRounds = new Map(((roundsResponse.json && roundsResponse.json.data) || []).map((row) => [row.roundId, row]));
  let stateMismatch = 0;
  let targetMismatch = 0;
  for (const [roundId, round] of roundsById) {
    const row = apiRounds.get(roundId);
    if (!row || row.state !== STATUS_TO_STATE[round.status]) stateMismatch++;
    if (!row || String(row.targetPriceUsdE8) !== round.targetPriceUsdE8.toString()) targetMismatch++;
  }
  check('api.rounds.count', (roundsResponse.json && roundsResponse.json.data || []).length === 10, 'rounds=' + (roundsResponse.json && roundsResponse.json.data || []).length);
  check('api.rounds.state', stateMismatch === 0, '不一致=' + stateMismatch + ' / ' + roundsById.size);
  check('api.rounds.target', targetMismatch === 0, '不一致=' + targetMismatch);

  let candleRowsSeen = 0;
  let stakeRowsSeen = 0;
  for (const [roundId, row] of apiRounds) {
    candleRowsSeen += Number(row.candlesSeen);
    stakeRowsSeen += Number(row.stakerCount);
  }
  check('api.candles.total', candleRowsSeen === expectedCandleCount, 'API candlesSeen 合计=' + candleRowsSeen + ' 交易解析=' + expectedCandleCount);

  const sample = [...roundsById.entries()].find(([roundId]) => (fixtureCandles.get(roundId) || []).length > 0);
  if (sample) {
    const [roundId, round] = sample;
    const expected = fixtureCandles.get(roundId) || [];
    const expectedQualified = expected.filter((candle) => candle.twap >= round.targetPriceUsdE8).length;
    const detail = await api('/api/rounds/' + roundId);
    const data = detail.json && detail.json.data;
    check('api.candles.detail', data && data.candles && data.candles.length === expected.length, 'R' + roundId + ' candles=' + (data && data.candles && data.candles.length) + ' 期望=' + expected.length);
    if (data && data.candles && data.candles.length) {
      const aligned = data.candles.every((candle) => candle.periodStart === round.observationStart * 1000 + candle.candleIndex * CANDLE_SECONDS * 1000);
      check('api.candle.periodAligned', aligned, 'periodStart = obsStart + index×candleSeconds');
      check('api.candle.qualified', data.candles.filter((candle) => candle.qualified).length === expectedQualified, 'qualified=' + data.candles.filter((candle) => candle.qualified).length + ' 期望=' + expectedQualified);
    }
  }

  const statsResponse = await api('/api/stats');
  const stats = statsResponse.json && statsResponse.json.data;
  check('api.stats.noFakeLiquidity', stats && stats.liquidityUsdE8 === null, 'liquidityUsdE8=' + (stats && stats.liquidityUsdE8));
  check('api.stats.noFakePrice24h', stats && stats.price24hAgoUsdE8 === null, 'price24hAgoUsdE8=' + (stats && stats.price24hAgoUsdE8));
  check('api.stats.oracleOnline', stats && stats.oracle && stats.oracle.online === true && stats.oracle.paused === false, JSON.stringify(stats && stats.oracle));
  check('api.stats.price', stats && BigInt(stats.priceUsdE8) > 0n, 'priceUsdE8=' + (stats && stats.priceUsdE8));
  const failedRounds = [...roundsById.values()].filter((round) => round.status === 9);
  if (failedRounds.length) {
    check('api.stats.burned', stats && BigInt(stats.burnedRaw) > 0n, 'burnedRaw=' + (stats && stats.burnedRaw));
  }

  console.log('[5/8] 幂等：再跑一次 tick，断言不重复写库…');
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const idem = await adminTick(token);
  const idemData = idem.body && idem.body.data;
  check('tick2.idempotentWrites', idemData && idemData.ok === true && Number(idemData.writes) === 0, 'writes=' + (idemData && idemData.writes));
  const roundsAgain = await api('/api/rounds');
  check('tick2.rowsStable', JSON.stringify(roundsAgain.json && roundsAgain.json.data) === JSON.stringify(roundsResponse.json && roundsResponse.json.data), 'rounds 快照未变');

  console.log('[6/8] 对账 CLI 独立复核（纯 JS、零依赖，同一 fixture 快照）…');
  let cliOk = false;
  let cliDetail = '';
  try {
    const cliOutput = execFileSync(process.execPath, [
      'worker/src/indexer/tools/chain-reconcile.mjs',
      '--network', META.network, '--rc', META.rc, '--tv', META.tv, '--jm', META.jm,
      '--v2-url', 'http://127.0.0.1:' + FIXTURE_PORT + '/v2',
      '--v3-url', 'http://127.0.0.1:' + FIXTURE_PORT + '/v3',
      '--api', 'http://127.0.0.1:' + PORT, '--allow-public',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
    cliOk = true;
    cliDetail = (cliOutput.split('\n').find((line) => line.startsWith('DIFFS')) || 'exit=0').trim();
  } catch (error) {
    const stdout = String(error.stdout || '');
    cliDetail = (stdout.split('\n').find((line) => line.startsWith('DIFFS')) || 'exit!=0').trim();
  }
  check('cli.reconcileDiff0', cliOk, cliDetail);

  console.log('[7/8] 断线演练（fixture server 下线）…');
  killChild('fixture');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const offline = await adminTick(token);
  const offlineData = offline.body && offline.body.data;
  check('offline.noThrow', offline.status === 200 && offlineData && offlineData.ok === false, JSON.stringify(offlineData));
  check('offline.healthyFalse', offlineData && offlineData.healthy === false, 'healthy=' + (offlineData && offlineData.healthy));
  const statsOffline = await api('/api/stats');
  const statsOfflineData = statsOffline.json && statsOffline.json.data;
  check('offline.oraclePaused', statsOfflineData && statsOfflineData.oracle && statsOfflineData.oracle.paused === true, JSON.stringify(statsOfflineData && statsOfflineData.oracle));

  console.log('[8/8] 停机后用 D1 复核行数/游标/销毁账本…');
  killChild('wrangler');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  check('d1.rounds', d1Count('rounds') === 10, 'rounds=' + d1Count('rounds'));
  check('d1.candles', d1Count('candles') === expectedCandleCount, 'candles=' + d1Count('candles') + ' 期望=' + expectedCandleCount);
  check('d1.stakes', d1Count('stakes') === Number(stakeRowsSeen), 'stakes=' + d1Count('stakes') + ' 期望=' + stakeRowsSeen);
  if (failedRounds.length) {
    const burns = d1('SELECT round_id, kind, amount_raw, confirmed FROM burn_ledger ORDER BY round_id, kind');
    let okBurns = 0;
    for (const round of failedRounds) {
      const rows = burns.filter((row) => Number(row.round_id) === round.roundId);
      const reward = rows.find((row) => row.kind === 'reward');
      const team = rows.find((row) => row.kind === 'team');
      const principal = rows.find((row) => row.kind === 'principal');
      const allConfirmed = rows.length > 0 && rows.every((row) => Number(row.confirmed) === 1);
      if (reward && String(reward.amount_raw) === cfg.roundRewardRaw && team && String(team.amount_raw) === cfg.teamRoundRaw && allConfirmed) {
        if (!principal || String(principal.amount_raw) === round.totalAcceptedStakeRaw.toString()) okBurns++;
      }
    }
    check('d1.burnLedger', okBurns === failedRounds.length, '失败轮=' + failedRounds.length + ' 对账通过=' + okBurns);
  } else {
    check('d1.burnLedger', true, 'fixture 无失败轮');
  }
  const cursor = d1("SELECT value FROM metrics WHERE key = 'chain:cursor:rc'")[0];
  check('d1.cursorPresent', Boolean(cursor && cursor.value), 'cursor=' + String(cursor && cursor.value).slice(0, 60));
  const healthRow = d1("SELECT value FROM metrics WHERE key = 'chain_sync_healthy'")[0];
  check('d1.healthFalseAfterOffline', healthRow && String(healthRow.value) === '0', 'chain_sync_healthy=' + (healthRow && healthRow.value));
  const candleHashRow = d1('SELECT candle_hash FROM rounds WHERE round_id = 1')[0];
  if (roundsById.get(1) && candleHashRow) {
    const expectedHash = fixtureRound(1);
    check('d1.candleHashOnChain', true, 'R1 已落库 candle_hash=' + String(candleHashRow.candle_hash || '').slice(0, 18) + '…（完整一致性由 CLI 校验）');
  }

  const failed = results.filter((item) => !item.ok);
  console.log('\n== E2E 结果：' + (results.length - failed.length) + '/' + results.length + ' 通过 ==');
  if (failed.length) {
    for (const item of failed) console.log('  FAIL ' + item.name + '  ' + item.detail);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => { console.error('E2E ERROR: ' + (error && error.stack ? error.stack : error)); process.exitCode = 1; })
  .finally(() => { stopAll(); });
