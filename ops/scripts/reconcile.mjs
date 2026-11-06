#!/usr/bin/env node
/**
 * reconcile — 对账（v11 口径需重写，见 ops/tests/README）：每轮一笔销毁 / 团队释放 vs 状态预期；total_supply = 100 亿 − Σ销毁；
 * RC 钱包余额 = 82 亿 + Σ质押 − Σ销毁 − Σ团队释放 − 已领本金 − 已领奖励 + 退款账本未领（只允许正偏差：零头/尾差）。
 * 支持 --snapshot 离线运行；--chain 读链上 total_supply 与 RC 钱包余额。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag, str } from './lib/cli.mjs';
import { RECORDS_DIR, asBigInt, formatTokens, loadAndValidate } from './lib/config.mjs';
import { getJettonData, getJettonWalletBalance } from './lib/ton.mjs';
import { expectedRcVault, expectedSettlementFor } from './lib/ledger.mjs';
import { loadRegistry } from './lib/registry.mjs';
import { section, kv, ok, fail, warn, info, detail, table, summary } from './lib/log.mjs';

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
const outPath = getArg('out');
const strict = args.includes('--strict');
const withChain = args.includes('--chain');

const { params, errors } = loadAndValidate();
if (errors.length) { for (const message of errors) fail(message); process.exit(1); }
const registry = loadRegistry();

secIntro();
function secIntro() {
  section('对账任务（reconcile）');
  kv('数据源', snapshotPath ? 'snapshot: ' + snapshotPath : 'API: ' + apiBase);
  kv('链上供应量', withChain ? '读取 TON Center' : '未启用（--chain 开启）');
  kv('严格模式', strict ? '是（有差异即失败）' : '否（差异仅告警）');
}

async function apiGet(path) {
  const response = await fetch(apiBase + path, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status);
  const json = await response.json();
  if (json && json.ok === false) throw new Error(path + ' API 错误：' + JSON.stringify(json.error));
  return json && json.ok === true ? json.data : json;
}

async function loadData() {
  if (snapshotPath) {
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    return {
      health: snapshot.health || {},
      config: snapshot.config || {},
      stats: snapshot.stats || {},
      rounds: snapshot.rounds || [],
      admin: snapshot.admin || null,
      chain: snapshot.chain || null,
      now: snapshot.now || (snapshot.health && snapshot.health.now) || Date.now(),
    };
  }
  const [health, config, stats, rounds] = await Promise.all([
    apiGet('/api/health'), apiGet('/api/config'), apiGet('/api/stats'), apiGet('/api/rounds'),
  ]);
  return { health, config, stats, rounds, admin: null, now: health.now || Date.now() };
}

let data;
try {
  data = await loadData();
} catch (error) {
  fail('数据源不可用：' + String(error.message || error));
  info('可先用 --snapshot ops/tests/fixtures/worker-snapshot.json 运行离线对账；线上请确认 worker 已启动。');
  process.exit(summary() || 1);
}

const totalSupply = asBigInt(params.token.totalSupplyRaw);

let chainSupply = data.chain && data.chain.totalSupplyRaw ? asBigInt(data.chain.totalSupplyRaw) : null;
let rcVaultChain = data.chain && data.chain.rcJettonBalanceRaw ? asBigInt(data.chain.rcJettonBalanceRaw) : null;
if (withChain) {
  const rcWallet = registry.contracts.roundControllerJettonWallet && registry.contracts.roundControllerJettonWallet.address;
  if (rcWallet) {
    const balance = await getJettonWalletBalance(params, rcWallet);
    if (balance !== null) { rcVaultChain = balance; kv('链上 RC 钱包余额', balance.toString()); }
  } else warn('登记表无 roundControllerJettonWallet：跳过 RC 钱包读取');
  const jettonMaster = registry.contracts.jettonMaster && registry.contracts.jettonMaster.address;
  if (!jettonMaster) warn('登记表无 jettonMaster 地址：跳过链上供应量读取');
  else {
    try {
      const jetton = await getJettonData(params, jettonMaster);
      chainSupply = jetton.totalSupplyRaw === null ? null : asBigInt(jetton.totalSupplyRaw);
      kv('链上 total_supply', formatTokens(chainSupply.toString()) + ' A9（raw ' + chainSupply + '）');
    } catch (error) {
      warn('链上读取失败：' + String(error.message || error));
    }
  }
}

const rows = [];
let sumBurned = 0n;
let burnDeltas = 0;
let teamDeltas = 0;
for (const round of data.rounds) {
  const roundId = Number(round.roundId);
  const state = String(round.state || 'UNKNOWN');
  const stake = asBigInt(round.totalAcceptedStakeRaw || 0);
  const tier = Number.isFinite(Number(round.priceMultiplier)) && Number(round.priceMultiplier) > 0
    ? Math.round(Math.log2(Number(round.priceMultiplier)))
    : roundId;
  const recordedBurn = round.burnedRaw === null || round.burnedRaw === undefined ? null : asBigInt(round.burnedRaw);
  const recordedTeam = round.teamReleasedRaw === null || round.teamReleasedRaw === undefined ? null : asBigInt(round.teamReleasedRaw);
  const settlement = expectedSettlementFor(params, data.rounds, round);
  const expectedBurn = settlement ? settlement.burnRaw : null;
  const teamRelease = settlement ? settlement.teamReleaseRaw : null;
  const burnDelta = expectedBurn !== null && recordedBurn !== null ? recordedBurn - expectedBurn : null;
  if (expectedBurn !== null && burnDelta !== null && burnDelta !== 0n) burnDeltas++;
  if (teamRelease !== null && recordedTeam !== null && recordedTeam !== teamRelease) teamDeltas++;
  if (recordedBurn !== null) sumBurned += recordedBurn;
  rows.push({
    roundId,
    state,
    tier,
    targetUsdE8: round.targetPriceUsdE8 || '',
    stakeRaw: stake,
    stakerCount: round.stakerCount ?? '',
    expectedBurnRaw: expectedBurn === null ? '' : expectedBurn.toString(),
    recordedBurnRaw: recordedBurn === null ? '' : recordedBurn.toString(),
    burnDeltaRaw: burnDelta === null ? '' : burnDelta.toString(),
    teamReleaseExpectedRaw: teamRelease === null ? '' : teamRelease.toString(),
    teamReleaseRecordedRaw: recordedTeam === null ? '' : recordedTeam.toString(),
    supplyLedgerRaw: '',
    supplyChainRaw: '',
    supplyDriftRaw: '',
    updatedAt: round.updatedAt ? new Date(round.updatedAt).toISOString() : '',
    notes: state === 'UNOPENED' ? '未开轮' : '',
  });
}

const ledgerSupply = data.stats && data.stats.supplyRaw ? asBigInt(data.stats.supplyRaw) : totalSupply - sumBurned;
const expectedSupplyFromBurns = totalSupply - sumBurned;
const internalDelta = ledgerSupply - expectedSupplyFromBurns;
for (const row of rows) {
  row.supplyLedgerRaw = ledgerSupply.toString();
  row.supplyChainRaw = chainSupply === null ? '' : chainSupply.toString();
  row.supplyDriftRaw = chainSupply === null ? '' : (ledgerSupply - chainSupply).toString();
}

section('每轮对账');
table(['轮次', '状态', '档位', '质押 raw', '地址数', '预期销毁', '账本销毁', '差异', '团队释放(预期)', '团队释放(账本)'], rows.map((row) => [
  row.roundId, row.state, row.tier, row.stakeRaw, row.stakerCount,
  row.expectedBurnRaw === '' ? '—' : row.expectedBurnRaw,
  row.recordedBurnRaw === '' ? '—' : row.recordedBurnRaw,
  row.burnDeltaRaw === '' ? '—' : row.burnDeltaRaw,
  row.teamReleaseExpectedRaw === '' ? '—' : row.teamReleaseExpectedRaw,
  row.teamReleaseRecordedRaw === '' ? '—' : row.teamReleaseRecordedRaw,
]));

section('供应量核对');
kv('初始 total_supply', totalSupply.toString());
kv('账本累计销毁', sumBurned.toString());
kv('预期供应量（初始-销毁）', expectedSupplyFromBurns.toString());
kv('账本供应量（stats.supplyRaw）', ledgerSupply.toString());
kv('账本内部差异', internalDelta.toString());
if (chainSupply !== null) {
  kv('链上 total_supply', chainSupply.toString());
  kv('账本 vs 链上差异', (ledgerSupply - chainSupply).toString());
}

section('RC 钱包核对（公式沿用 v10，待 v11 改写）');
const vault = expectedRcVault(params, data.rounds, data.stats || {});
kv('82 亿注资', vault.breakdown.fundingRaw.toString());
kv('Σ已接受质押', vault.breakdown.stakeRaw.toString());
kv('Σ销毁', vault.breakdown.burnedRaw.toString());
kv('Σ团队释放', vault.breakdown.teamReleasedRaw.toString());
let vaultDrift = null;
if (vault.expected === null) info('缺少 stats.' + vault.missing.join(' / ') + '：无法计算 RC 钱包公式值（worker /api/stats 需提供）');
else {
  kv('已领本金 / 已领奖励 / 退款账本未领', vault.breakdown.claimedPrincipalRaw + ' / ' + vault.breakdown.claimedRewardRaw + ' / ' + vault.breakdown.refundPendingRaw);
  kv('公式值', vault.expected.toString());
  if (rcVaultChain !== null) {
    vaultDrift = rcVaultChain - vault.expected;
    kv('链上 RC 钱包', rcVaultChain.toString());
    kv('偏差（链上 − 公式）', vaultDrift.toString() + (vaultDrift > 0n ? '（零头 / 奖励尾差留在 RC，允许）' : ''));
  } else info('未读取链上 RC 钱包余额（--chain 或快照 chain.rcJettonBalanceRaw）');
}

const problems = [];
if (internalDelta !== 0n) problems.push('账本供应量与「初始-累计销毁」不一致：' + internalDelta);
if (chainSupply !== null && ledgerSupply - chainSupply !== 0n) problems.push('账本供应量与链上不一致：' + (ledgerSupply - chainSupply));
if (burnDeltas > 0) problems.push(burnDeltas + ' 个轮次的销毁金额与状态预期不一致（为 0 时检查 SettlementBounced → RetrySettlement）');
if (teamDeltas > 0) problems.push(teamDeltas + ' 个轮次的团队释放与状态预期不一致');
if (vaultDrift !== null && vaultDrift < 0n) problems.push('RC 钱包余额低于公式值：' + vaultDrift);

if (problems.length === 0) ok('对账通过：销毁 / 团队释放 / 供应量 / RC 钱包无差异');
else for (const problem of problems) (strict ? fail : warn)(problem);

mkdirSync(RECORDS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = outPath || join(RECORDS_DIR, 'reconciliation-' + stamp + '.csv');
const headers = ['round_id', 'state', 'tier', 'target_usd_e8', 'stake_total_raw', 'staker_count', 'expected_burn_raw', 'recorded_burn_raw', 'burn_delta_raw', 'team_release_expected_raw', 'team_release_recorded_raw', 'supply_ledger_raw', 'supply_chain_raw', 'supply_drift_raw', 'updated_at', 'notes'];
const csv = [headers.join(',')].concat(rows.map((row) => [
  row.roundId, row.state, row.tier, row.targetUsdE8, row.stakeRaw, row.stakerCount, row.expectedBurnRaw,
  row.recordedBurnRaw, row.burnDeltaRaw, row.teamReleaseExpectedRaw, row.teamReleaseRecordedRaw, row.supplyLedgerRaw, row.supplyChainRaw,
  row.supplyDriftRaw, row.updatedAt, JSON.stringify(row.notes),
].join(','))).join(String.fromCharCode(10));
writeFileSync(file, csv + String.fromCharCode(10), 'utf8');
ok('对账表已写入：' + file);
detail('CSV 字段与 ops/templates/reconciliation.csv 一致；每个失败轮只有一笔销毁（v11：budget/2 + 1.2 亿 + 本金）（RoundSettled 事件带 reward/team/principal 拆分）。');

process.exit(summary({ 轮次数: rows.length, 销毁差异轮次: burnDeltas, 团队释放差异轮次: teamDeltas, RC钱包偏差: vaultDrift === null ? '未核对' : vaultDrift.toString(), 账本内部差异: internalDelta.toString(), 输出: file }) || (strict && problems.length ? 1 : 0));
