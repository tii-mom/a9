#!/usr/bin/env node
/**
 * monitor_check — 监控检查与告警（v11）：worker 健康、K 线缺失、报名/判定超时、结算退回（SettlementBounced →
 * RetrySettlement）、UnexpectedBounce、一笔销毁金额、团队释放、供应量漂移、RC 钱包公式、keeper gas、运维事件。
 *
 * 数据源：--snapshot <json>（离线）或 worker API；--chain 额外读链上（RC 事件、get_round 结算标志、RC 钱包余额、keeper TON）。
 * --auto-retry：对待重试的轮次调用 80_admin_ops.mjs --action retry-settlement（仍需 OPS_EXECUTE=1 OPS_CONFIRM=YES 才广播）。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asBigInt, loadAndValidate } from './lib/config.mjs';
import { loadRegistry } from './lib/registry.mjs';
import { expectedRcVault, expectedSettlementFor, pendingSettlementActions } from './lib/ledger.mjs';
import { fetchRcEvents, getJettonWalletBalance, getRoundView, getTonBalance } from './lib/ton.mjs';
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
const withChain = args.includes('--chain');
const autoRetry = args.includes('--auto-retry');

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
    chain: snapshot.chain || null,
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

// 链上补充数据：RC 事件、每轮结算标志、RC 钱包余额、keeper TON（快照里用 chain 字段模拟）
if (withChain && !snapshotPath) {
  const rc = registry.contracts.roundController && registry.contracts.roundController.address;
  const rcWallet = registry.contracts.roundControllerJettonWallet && registry.contracts.roundControllerJettonWallet.address;
  const keeper = registry.wallets.keeper && registry.wallets.keeper.address;
  const chain = { events: [], pendingSettlement: {} };
  try {
    if (rc) {
      chain.events = await fetchRcEvents(params, rc, { limit: 50 });
      for (const round of data.rounds || []) {
        if (!['SUCCEEDED', 'FAILED_PERMANENT'].includes(String(round.state))) continue;
        const pending = pendingSettlementActions(await getRoundView(params, rc, Number(round.roundId)));
        if (pending && pending.length) chain.pendingSettlement[round.roundId] = pending;
      }
    }
    if (rcWallet) { const balance = await getJettonWalletBalance(params, rcWallet); chain.rcJettonBalanceRaw = balance === null ? null : balance.toString(); }
    if (keeper) chain.keeperTonNano = (await getTonBalance(params, keeper)).balanceNano;
  } catch (error) {
    warn('链上读取失败（继续用 API 数据）：' + String(error.message || error));
  }
  data.chain = chain;
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
kv('阈值', 'health stale ' + thresholds.healthStaleMinutes + 'm / candle lag ' + thresholds.candleLagAllowed + ' / keeper ≥ ' + thresholds.keeperMinTon + ' TON');
kv('链上数据', data.chain ? '已加载' : '未启用（--chain 开启）');

const checks = [];
function record(name, healthy, conditional) {
  checks.push({ name, ok: healthy });
  if (!healthy && conditional) conditional();
}

record('worker.health', health.ok !== false, () => add('worker.health', 'P0', 'worker 健康检查失败', 'GET /api/health 返回 ok=false', 'runbooks/03_monitoring_alerting.md#P0'));
record('worker.db', health.db !== false, () => add('worker.db', 'P0', 'D1 数据库不可用', 'health.db=false：API 写入/读取会失败', 'runbooks/03_monitoring_alerting.md#P0'));
const ageMinutes = (Date.now() - Number(health.now || 0)) / 60000;
record('worker.clock', snapshotPath ? true : ageMinutes < thresholds.healthStaleMinutes, () => add('cron.heartbeat', 'P1', 'worker 心跳过期', 'health.now 距今 ' + ageMinutes.toFixed(1) + ' 分钟（> ' + thresholds.healthStaleMinutes + '）', 'runbooks/03_monitoring_alerting.md#P1'));


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
const ABORT_MS = Number(params.techAbort.abortTimeoutSeconds) * 1000;
const RB = 'runbooks/03_monitoring_alerting.md';
const retryRounds = new Set();
for (const round of rounds) {
  const state = String(round.state);
  const roundId = round.roundId;
  if (state === 'STAKING_OPEN' && round.stakeCloseAt && now > Number(round.stakeCloseAt) + GRACE_MS) {
    add('round.' + roundId + '.close_overdue', 'P2', 'R' + roundId + ' 报名窗口到期未关', 'stakeCloseAt 已过 1h 仍为 STAKING_OPEN：任何人可 CloseStaking（keeper 的第一根 K 线也会隐式关窗）', RB + '#P2');
  }
  if (state === 'OBSERVING' && round.observationStart) {
    const expected = Math.min(Number(params.timeline.candleCount), Math.floor((now - Number(round.observationStart)) / CANDLE_MS));
    const lag = expected - Number(round.candlesSeen || 0);
    if (lag > thresholds.candleLagAllowed) {
      add('round.' + roundId + '.candle_missing', 'P1', 'R' + roundId + ' K 线缺失', 'expected=' + expected + ' seen=' + round.candlesSeen + ' lag=' + lag + '：检查 keeper 进程与 keeper 钱包 gas', RB + '#P1');
    }
    if (round.observationEnd && now > Number(round.observationEnd) + GRACE_MS) {
      const abortable = now > Number(round.observationEnd) + ABORT_MS;
      add('round.' + roundId + '.settle_overdue', abortable ? 'P0' : 'P1', 'R' + roundId + ' 观察结束未判定', abortable ? '已超过技术终止超时：任何人可 AbortTechnical（本金经攻城令领取）' : 'observationEnd 已过 1h 仍为 OBSERVING：keeper 未提交满 24 根 K 线', RB + '#P1');
    }
  }
  if (['STAKING_OPEN', 'OBSERVING'].includes(state) && (round.updatedAt || 0) && now - Number(round.updatedAt) > 15 * 60000) {
    add('round.' + roundId + '.stale', 'P2', 'R' + roundId + ' 数据 15 分钟未更新', '前端/索引可能停更', RB + '#P2');
  }
  const settlement = expectedSettlementFor(params, rounds, round);
  if (settlement) {
    const burned = round.burnedRaw === null || round.burnedRaw === undefined ? null : asBigInt(round.burnedRaw);
    if (burned !== null && burned !== settlement.burnRaw) {
      const level = settlement.burnRaw > 0n && burned === 0n ? 'P1' : 'P0';
      add('round.' + roundId + '.burn_mismatch', level, 'R' + roundId + ' 销毁金额异常', state + ' recorded=' + burned + ' expected=' + settlement.burnRaw + (burned === 0n ? '：销毁可能被退回 → 查 SettlementBounced，RetrySettlement' : ''), RB + '#reconcile');
      if (burned === 0n) retryRounds.add(roundId);
    }
    const released = round.teamReleasedRaw === null || round.teamReleasedRaw === undefined ? null : asBigInt(round.teamReleasedRaw);
    if (released !== null && released !== settlement.teamReleaseRaw) {
      add('round.' + roundId + '.team_release_mismatch', released === 0n ? 'P1' : 'P0', 'R' + roundId + ' 团队释放异常', state + ' recorded=' + released + ' expected=' + settlement.teamReleaseRaw + (released === 0n ? '：团队转账可能被退回 → RetrySettlement' : ''), RB + '#reconcile');
      if (released === 0n) retryRounds.add(roundId);
    }
  }
}

// 链上事件：SettlementBounced → RetrySettlement；UnexpectedBounce → 人工核查
const chain = data.chain || null;
if (chain) {
  const events = chain.events || [];
  const pendingByRound = chain.pendingSettlement || {};
  for (const event of events.filter((item) => item.type === 'SettlementBounced')) {
    const pending = pendingByRound[event.roundId];
    // 链上 *Confirmed 标志已恢复 = 已重试成功；快照可用 resolved: true 表示
    if (event.resolved === true || (chain.pendingSettlement && pending === undefined && !snapshotPath)) continue;
    retryRounds.add(event.roundId);
    add('settlement.bounced.R' + event.roundId, 'P1', 'R' + event.roundId + ' 结算动作被退回（' + (event.action === 1 ? '团队转账' : event.action === 2 ? '销毁' : 'action ' + event.action) + '）', '处理：node ops/scripts/80_admin_ops.mjs --action retry-settlement --round ' + event.roundId + '（任何人可调，≥ 0.3 TON）', RB + '#settlement-bounced');
  }
  for (const [roundId, pending] of Object.entries(pendingByRound)) {
    if (retryRounds.has(Number(roundId))) continue;
    retryRounds.add(Number(roundId));
    add('settlement.pending.R' + roundId, 'P1', 'R' + roundId + ' 结算动作未确认：' + pending.join(','), '处理：80_admin_ops.mjs --action retry-settlement --round ' + roundId, RB + '#settlement-bounced');
  }
  for (const event of events.filter((item) => item.type === 'UnexpectedBounce' && item.resolved !== true)) {
    add('unexpected.bounce.' + (event.queryId || event.txHash || 'x'), 'P1', 'RC 收到意外退回（UnexpectedBounce）', 'op=' + event.op + ' queryId=' + event.queryId + '：领取/退款转账被退回，代币仍在 RC 钱包；人工核查对应用户与交易', RB + '#unexpected-bounce');
  }
  if (chain.keeperTonNano !== undefined && chain.keeperTonNano !== null) {
    const ton = Number(BigInt(String(chain.keeperTonNano))) / 1e9;
    record('keeper.ton', ton >= Number(thresholds.keeperMinTon), () => add('keeper.ton_low', 'P1', 'keeper 钱包 gas 不足', ton.toFixed(3) + ' TON < ' + thresholds.keeperMinTon + '：K 线 / 开轮会失败', RB + '#P1'));
  }
  if (chain.rcJettonBalanceRaw !== undefined && chain.rcJettonBalanceRaw !== null) {
    const vault = expectedRcVault(params, rounds, stats);
    if (vault.expected === null) {
      info('RC 钱包公式跳过：stats 缺少 ' + vault.missing.join(' / '));
    } else {
      const drift = asBigInt(chain.rcJettonBalanceRaw) - vault.expected;
      // 正偏差 = 零头 / 奖励尾差（合约内留存，允许）；负偏差 = 资金缺口
      record('rc.vault', drift >= 0n, () => add('rc.vault.drift', 'P0', 'RC 钱包余额低于公式值', 'actual=' + chain.rcJettonBalanceRaw + ' expected=' + vault.expected + ' drift=' + drift, RB + '#reconcile'));
      if (drift > 0n) info('RC 钱包比公式多 ' + drift + ' raw（奖励按战力分配的向下取整尾差，留在 RC，属预期）');
    }
  }
}

if (stats.nextStakeOpenAt && now > Number(stats.nextStakeOpenAt) + GRACE_MS) {
  const abortable = now > Number(stats.nextStakeOpenAt) + ABORT_MS;
  add('next_round.overdue', abortable ? 'P0' : 'P1', '下一轮未按预告开启', abortable ? '预告结束已超过技术终止超时：任何人可 AbortTechnical（keeper 失联）' : 'nextStakeOpenAt 已过 1h：keeper 未发 OpenRound', 'runbooks/03_monitoring_alerting.md#P1');
}

if (data.admin) {
  const events = data.admin.events || [];
  const windowMinutes = Number(thresholds.opsEventWindowMinutes || 15);
  const quietMs = windowMinutes * 60000;
  const recent = events.filter((event) => now - Number(event.ts) <= quietMs);
  const errors = recent.filter((event) => event.level === 'error');
  const warnings = recent.filter((event) => event.level === 'warn');
  if (errors.length) add('ops.error_events', 'P1', '运维/keeper 操作报错', errors.length + ' 条 error 事件（近 ' + windowMinutes + ' 分钟）', 'runbooks/04_key_custody_admin.md#incident');
  if (warnings.length) add('ops.warn_events', 'P2', '运维/keeper 操作告警', warnings.length + ' 条 warn 事件', 'runbooks/04_key_custody_admin.md#incident');
  if (recent.length && !errors.length && !warnings.length) add('ops.activity', 'P3', '运维/keeper 操作活动', recent.length + ' 条事件（近 ' + windowMinutes + ' 分钟），确认是否为计划内操作', 'runbooks/04_key_custody_admin.md#audit');
  checks.push({ name: 'ops.events', ok: errors.length === 0 });
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
    const text = 'A9 ' + (params.__net || 'testnet') + ' 告警\n' + new Date().toISOString() + '\n' + lines.join('\n');
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

if (retryRounds.size) {
  const list = [...retryRounds].sort((x, y) => x - y);
  section('结算重试');
  for (const roundId of list) detail('R' + roundId + '：node ops/scripts/80_admin_ops.mjs --action retry-settlement --round ' + roundId);
  if (autoRetry) {
    const script = join(dirname(fileURLToPath(import.meta.url)), '80_admin_ops.mjs');
    for (const roundId of list) {
      const extra = process.env.OPS_EXECUTE === '1' ? ['--execute'] : [];
      const result = spawnSync(process.execPath, [script, '--action', 'retry-settlement', '--round', String(roundId), ...extra], { encoding: 'utf8', env: process.env, timeout: 300000 });
      (result.status === 0 ? ok : warn)('auto-retry R' + roundId + '：exit ' + result.status + (extra.length ? '' : '（dry-run；广播需 OPS_EXECUTE=1 OPS_CONFIRM=YES）'));
    }
  }
}

const exitCode = counts.P0 > 0 ? 2 : counts.P1 > 0 ? 1 : 0;
process.exit(summary({ P0: counts.P0, P1: counts.P1, P2: counts.P2, P3: counts.P3 }) || exitCode);
