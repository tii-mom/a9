#!/usr/bin/env node
/** monitor_check — 监控检查与告警：worker 健康、K 线缺失、预言机暂停、销毁 pending、供应量漂移、管理员操作。 */

import { readFileSync } from 'node:fs';
import { loadAndValidate } from './lib/config.mjs';
import { loadRegistry } from './lib/registry.mjs';
import { section, kv, ok, fail, warn, info, table, summary, detail } from './lib/log.mjs';

const args = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--' + name) return args[i + 1];
    if (args[i].startsWith('--' + name + '=')) return args[i].slice(name.length + 3);
  }
  return fallback;
};
const snapshotPath = getArg('snapshot');
const apiBase = getArg('api', process.env.OPS_WORKER_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const notify = args.includes('--notify');
const jsonOut = args.includes('--json');

const { params, errors } = loadAndValidate();
if (errors.length) { for (const message of errors) fail(message); process.exit(2); }
const thresholds = params.monitoring;
const registry = loadRegistry();

async function apiGet(path) {
  const response = await fetch(apiBase + path, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status);
  const json = await response.json();
  if (json && json.ok === false) throw new Error(path + ' API 错误：' + JSON.stringify(json.error));
  return json && json.ok === true ? json.data : json;
}

let data;
if (snapshotPath) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  data = {
    health: snapshot.health || {},
    config: snapshot.config || {},
    stats: snapshot.stats || {},
    rounds: snapshot.rounds || [],
    admin: snapshot.admin || null,
    now: snapshot.now || (snapshot.health && snapshot.health.now) || Date.now(),
  };
} else {
  try {
    const [health, config, stats, rounds] = await Promise.all([
      apiGet('/api/health'), apiGet('/api/config'), apiGet('/api/stats'), apiGet('/api/rounds'),
    ]);
    let admin = null;
    const token = process.env.ADMIN_TOKEN;
    if (token) {
      try {
        const response = await fetch(apiBase + '/api/admin/overview', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
        const json = await response.json();
        admin = json && json.ok === true ? json.data : null;
      } catch { admin = null; }
    }
    data = { health, config, stats, rounds, admin, now: health.now || Date.now() };
  } catch (error) {
    section('监控检查');
    fail('worker 不可达：' + String(error.message || error));
    detail('若为本地开发，先启动 npm run dev:worker；或使用 --snapshot 离线检查。');
    process.exit(summary() || 2);
  }
}

const now = Number(data.now);
const health = data.health || {};
const stats = data.stats || {};
const rounds = data.rounds || [];
const config = data.config || {};
const alerts = [];
const add = (id, level, title, detailText, runbookRef) => alerts.push({ id, level, title, detail: detailText, runbook: runbookRef });
const levelRank = { P0: 4, P1: 3, P2: 2, P3: 1 };

section('监控检查');
kv('数据源', snapshotPath ? 'snapshot: ' + snapshotPath : 'API: ' + apiBase);
kv('模拟时间', new Date(now).toISOString());
kv('阈值', 'health stale ' + thresholds.healthStaleMinutes + 'm / candle lag ' + thresholds.candleLagAllowed + ' / burn pending ' + thresholds.burnPendingMinutes + 'm');

const checks = [];
function record(name, healthy, conditional) {
  checks.push({ name, ok: healthy });
  if (!healthy && conditional) conditional();
}

record('worker.health', health.ok !== false, () => add('worker.health', 'P0', 'worker 健康检查失败', 'GET /api/health 返回 ok=false', 'runbooks/03_monitoring_alerting.md#P0'));
record('worker.db', health.db !== false, () => add('worker.db', 'P0', 'D1 数据库不可用', 'health.db=false：API 写入/读取会失败', 'runbooks/03_monitoring_alerting.md#P0'));
const ageMinutes = (Date.now() - Number(health.now || 0)) / 60000;
record('worker.clock', snapshotPath ? true : ageMinutes < thresholds.healthStaleMinutes, () => add('cron.heartbeat', 'P1', 'worker 心跳过期', 'health.now 距今 ' + ageMinutes.toFixed(1) + ' 分钟（> ' + thresholds.healthStaleMinutes + '）', 'runbooks/03_monitoring_alerting.md#P1'));

const oracle = stats.oracle || {};
record('oracle.online', oracle.paused !== true && oracle.online !== false, () => add('oracle.paused', 'P1', '预言机暂停/离线', 'paused=' + oracle.paused + ' online=' + oracle.online + ' validSources=' + oracle.validSources, 'runbooks/03_monitoring_alerting.md#pause'));

const supplyLedger = stats.supplyRaw === undefined ? null : BigInt(String(stats.supplyRaw));
const totalSupply = BigInt(String(config.totalSupplyRaw || params.token.totalSupplyRaw));
const burned = stats.burnedRaw === undefined ? 0n : BigInt(String(stats.burnedRaw));
if (supplyLedger !== null) {
  const expected = totalSupply - burned;
  const drift = supplyLedger - expected;
  record('supply.ledger', drift === 0n, () => add('supply.drift', 'P0', '供应量与销毁账本不一致', 'ledger=' + supplyLedger + ' expected=' + expected + ' drift=' + drift, 'runbooks/03_monitoring_alerting.md#reconcile'));
}
const chainSupply = stats.chainSupplyRaw || stats.totalSupplyRaw || null;
if (chainSupply !== null && supplyLedger !== null) {
  const drift = supplyLedger - BigInt(String(chainSupply));
  record('supply.chain', drift === 0n, () => add('supply.chain_drift', 'P0', '账本供应量 ≠ 链上 total_supply', 'ledger=' + supplyLedger + ' chain=' + chainSupply + ' drift=' + drift, 'runbooks/03_monitoring_alerting.md#reconcile'));
}

const CANDLE_MS = Number(params.timeline.candleSeconds) * 1000;
const GRACE_MS = 60 * 60 * 1000;
for (const round of rounds) {
  const state = String(round.state);
  const roundId = round.roundId;
  if (['STAKING_OPEN', 'STAKING_CLOSED', 'OBSERVING', 'ORACLE_PAUSED', 'SETTLING_SUCCESS', 'SETTLING_FAILURE'].includes(state)) {
    if (state === 'STAKING_OPEN' && round.stakeCloseAt && now > Number(round.stakeCloseAt) + GRACE_MS) {
      add('round.' + roundId + '.close_overdue', 'P1', 'R' + roundId + ' 报名窗口未按时关闭', 'stakeCloseAt=' + new Date(Number(round.stakeCloseAt)).toISOString() + ' 已超过 1h 仍为 STAKING_OPEN', 'runbooks/03_monitoring_alerting.md#P1');
    }
    if (state === 'OBSERVING' && round.observationStart) {
      const expected = Math.min(Number(params.timeline.candleCount), Math.floor((now - Number(round.observationStart)) / CANDLE_MS));
      const lag = expected - Number(round.candlesSeen || 0);
      if (lag > thresholds.candleLagAllowed) {
        add('round.' + roundId + '.candle_missing', 'P1', 'R' + roundId + ' K 线缺失', 'expected=' + expected + ' seen=' + round.candlesSeen + ' lag=' + lag, 'runbooks/03_monitoring_alerting.md#P1');
      }
      if (round.observationEnd && now > Number(round.observationEnd) + GRACE_MS) {
        add('round.' + roundId + '.finalize_overdue', 'P1', 'R' + roundId + ' 观察结束未结算', 'observationEnd 已过 1h 仍为 OBSERVING', 'runbooks/03_monitoring_alerting.md#P1');
      }
    }
    if (state === 'ORACLE_PAUSED') add('round.' + roundId + '.paused', 'P1', 'R' + roundId + ' 预言机暂停', '暂停期间不得判定失败；连续 14 天可技术终止', 'runbooks/04_key_custody_admin.md#tech-abort');
    if (state === 'SETTLING_FAILURE' || state === 'SETTLING_SUCCESS') {
      const updated = Number(round.updatedAt || 0);
      if (updated && now - updated > thresholds.burnPendingMinutes * 60000) {
        add('round.' + roundId + '.settling_timeout', 'P0', 'R' + roundId + ' 结算卡住', '处于 ' + state + ' 超过 ' + thresholds.burnPendingMinutes + ' 分钟', 'runbooks/03_monitoring_alerting.md#P0');
      }
    }
    if ((round.updatedAt || 0) && now - Number(round.updatedAt) > 15 * 60000) {
      add('round.' + roundId + '.stale', 'P2', 'R' + roundId + ' 数据 15 分钟未更新', '前端/索引可能停更', 'runbooks/03_monitoring_alerting.md#P2');
    }
  }
  if (state === 'FAILED_PERMANENT' && (!round.burnedRaw || BigInt(String(round.burnedRaw)) === 0n)) {
    add('round.' + roundId + '.burn_pending', 'P0', 'R' + roundId + ' 失败但销毁未确认', 'FAILED_PERMANENT 且 burnedRaw=0：三笔销毁必须链上确认', 'runbooks/03_monitoring_alerting.md#P0');
  }
  if (state === 'FAILED_PERMANENT' && round.burnedRaw && BigInt(String(round.burnedRaw)) > 0n) {
    const expected = BigInt(String(params.rounds.roundRewardRaw)) + BigInt(String(params.rounds.teamRoundRaw)) + BigInt(String(round.totalAcceptedStakeRaw || 0));
    if (BigInt(String(round.burnedRaw)) !== expected) {
      add('round.' + roundId + '.burn_mismatch', 'P0', 'R' + roundId + ' 销毁金额异常', 'recorded=' + round.burnedRaw + ' expected=' + expected, 'runbooks/03_monitoring_alerting.md#reconcile');
    }
  }
}

if (stats.nextStakeOpenAt && now > Number(stats.nextStakeOpenAt) + GRACE_MS) {
  add('next_round.overdue', 'P1', '下一轮未按预告开启', 'nextStakeOpenAt 已过 1h', 'runbooks/03_monitoring_alerting.md#P1');
}

if (data.admin) {
  const events = data.admin.events || [];
  const quietMs = thresholds.adminQuietWindowMinutes * 60000;
  const recent = events.filter((event) => now - Number(event.ts) <= quietMs);
  const errors = recent.filter((event) => event.level === 'error');
  const warnings = recent.filter((event) => event.level === 'warn');
  if (errors.length) add('admin.error_events', 'P1', '管理员操作报错', errors.length + ' 条 error 事件（近 ' + thresholds.adminQuietWindowMinutes + ' 分钟）', 'runbooks/04_key_custody_admin.md#incident');
  if (warnings.length) add('admin.warn_events', 'P2', '管理员操作告警', warnings.length + ' 条 warn 事件', 'runbooks/04_key_custody_admin.md#incident');
  if (recent.length && !errors.length && !warnings.length) add('admin.activity', 'P3', '管理员操作活动', recent.length + ' 条事件（近 ' + thresholds.adminQuietWindowMinutes + ' 分钟），确认是否为计划内操作', 'runbooks/04_key_custody_admin.md#audit');
  checks.push({ name: 'admin.events', ok: errors.length === 0 });
}

const sorted = alerts.sort((a, b) => (levelRank[b.level] || 0) - (levelRank[a.level] || 0));
const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
for (const alert of sorted) counts[alert.level] = (counts[alert.level] || 0) + 1;

if (jsonOut) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), source: snapshotPath || apiBase, counts, alerts }, null, 2));
} else {
  section('告警');
  if (alerts.length === 0) ok('全部指标正常');
  else table(['级别', '指标', '说明', '处理'], sorted.map((alert) => [alert.level, alert.id, alert.title, alert.runbook]));
  section('汇总');
  kv('P0（15 分钟响应）', counts.P0);
  kv('P1（30 分钟响应）', counts.P1);
  kv('P2（4 小时响应）', counts.P2);
  kv('P3（次工作日）', counts.P3);
}

if (notify && alerts.length) {
  const token = process.env[params.notifications.telegram.botTokenEnv];
  const chatId = process.env[params.notifications.telegram.chatIdEnv];
  if (!token || !chatId) {
    warn('--notify 需要 ' + params.notifications.telegram.botTokenEnv + ' 与 ' + params.notifications.telegram.chatIdEnv + '（未设置，跳过发送）');
  } else {
    const lines = sorted.map((alert) => '[' + alert.level + '] ' + alert.title + ' — ' + alert.detail);
    const text = 'A9 测试网告警\n' + new Date().toISOString() + '\n' + lines.join('\n');
    try {
      const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) ok('Telegram 告警已发送');
      else warn('Telegram 发送失败：HTTP ' + response.status);
    } catch (error) {
      warn('Telegram 发送异常：' + String(error.message || error));
    }
  }
}

const exitCode = counts.P0 > 0 ? 2 : counts.P1 > 0 ? 1 : 0;
process.exit(summary({ P0: counts.P0, P1: counts.P1, P2: counts.P2, P3: counts.P3 }) || exitCode);
