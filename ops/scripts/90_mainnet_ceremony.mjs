#!/usr/bin/env node
/** 90 — 主网部署仪式：分阶段、可断点续跑、失败即停。仅操作用 ops/scripts/ 与 ops/config/。 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadParams, networkName, readJSON, resolvePath, RECORDS_DIR } from './lib/config.mjs';
import { loadRegistry, writeRegistry } from './lib/registry.mjs';
import { parseAddress, runGetMethod, stackItemToBigInt, addressFromStackItem, formatAddress, getAddressInformation } from './lib/ton.mjs';

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const hit = process.argv.slice(2).find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
function has(name) { return process.argv.includes('--' + name) || process.argv.some((x) => x.startsWith('--' + name + '=')); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const paramsPath = arg('params', 'ops/config/mainnet.params.json');
process.env.OPS_PARAMS = paramsPath;
const params = loadParams(paramsPath);
const net = networkName(params);
const dryRun = has('dry-run');
const execute = has('execute') && !dryRun;
const resume = has('resume');
const rehearsal = has('rehearsal');
const requested = (arg('phase', 'P0,P0.5,P1,P2,P3,P4,P5,P6')).split(',').map((x) => x.trim()).filter(Boolean);
const PHASES = ['P0', 'P0.5', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
for (const p of requested) if (!PHASES.includes(p)) { console.error('未知阶段：' + p); process.exit(2); }

const registryPath = process.env.OPS_REGISTRY || arg('registry', 'ops/config/mainnet.registry.json');
process.env.OPS_REGISTRY = registryPath;
let registry = loadRegistry({ create: true });
registry.ceremony = registry.ceremony || { phases: {}, completed: [], startedAt: null, finishedAt: null };
const state = registry.ceremony;

const startedAt = Date.now();
const completed = [];

function save() {
  registry.updatedAt = new Date().toISOString();
  registry.ceremony = state;
  writeRegistry(registry);
}
function newestDeployLog() {
  const dir = resolvePath(RECORDS_DIR);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^deploy-emulation-.*\.log$/.test(f)).sort();
  return files.length ? join(dir, files[files.length - 1]) : null;
}
function run(cmd, args, env = {}, timeout = 600000) {
  const r = spawnSync(cmd, args, { cwd: resolvePath('.'), encoding: 'utf8', timeout, env: { ...process.env, ...env } });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}
function runNode(script, args, env = {}, timeout = 600000) {
  return run(process.execPath, [resolvePath('ops/scripts/' + script), ...args], env, timeout);
}
function acton(args, env = {}, timeout = 120000) {
  const cmd = 'cd ' + resolvePath(params.toolchain.contractsDir) + ' && export PATH=$HOME/.acton/bin:$PATH && acton ' + args;
  return run('bash', ['-lc', cmd], env, timeout);
}
function failPhase(id, error) {
  state.phases[id] = { ...(state.phases[id] || {}), status: 'FAILED', error: String(error && error.message ? error.message : error), finishedAt: new Date().toISOString() };
  save();
  console.error('\n[FAIL] ' + id + '：' + (error && error.message ? error.message : error));
  console.error('已完成阶段：' + (completed.length ? completed.join(', ') : '无'));
  console.error('止血章节：docs/29 §8（回滚与应急） / ops/runbooks/07 §8（回滚与应急）；不可逆项：合约部署、admin 写入、A9 注入。');
  process.exit(1);
}
function expectedHashes() {
  const docs = readFileSync(resolvePath('docs/18_AUDIT_BRIEF.md'), 'utf8');
  const out = {};
  const re = /^\|\s*(RoundController|JettonWallet|JettonMaster|TeamVault|OracleAdapter)\s*\|\s*`?0x([0-9a-fA-F]{64})`?/gm;
  let m;
  while ((m = re.exec(docs))) out[m[1]] = ('0x' + m[2]).toLowerCase();
  for (const name of ['RoundController', 'JettonWallet', 'JettonMaster', 'TeamVault', 'OracleAdapter']) {
    if (!out[name]) {
      const build = readJSON(resolvePath('contracts/build/' + name + '.json'));
      out[name] = String(build.hash).toLowerCase();
    }
  }
  return out;
}
function codeHashOf(address) {
  const r = acton('rpc info ' + address + ' --net ' + net);
  const m = String(r.stdout + r.stderr).match(/Code Hash:\s+0x([0-9a-fA-F]{64})/);
  return m ? ('0x' + m[1]).toLowerCase() : null;
}
function must(cond, message) { if (!cond) throw new Error(message); }

async function P0() {
  if (dryRun) { console.log('[P0] dry-run: node worker/scripts/preflight-mainnet.mjs'); return 'DRY_RUN'; }
  const r = run(process.execPath, [resolvePath('worker/scripts/preflight-mainnet.mjs')], {}, 180000);
  const text = String(r.stdout || '') + String(r.stderr || '');
  const tail = text.trim().split(String.fromCharCode(10)).slice(-6).join(' | ');
  if (r.status === 0) {
    console.log('[P0] PASS');
    return 'PASS';
  }
  // rehearsal: only the two known production-placeholder checks are expected to
  // fail. Everything else must still PASS; no blanket bypass.
  const failNums = [...text.matchAll(/\[(\d+)\/8\] FAIL/g)].map((m) => Number(m[1]));
  const EXPECTED_IN_REHEARSAL = new Set([1, 8]);
  if (rehearsal && failNums.length > 0 && failNums.every((n) => EXPECTED_IN_REHEARSAL.has(n))) {
    const expectedLines = text.split(String.fromCharCode(10)).filter((line) => /^\[(1|8)\/8\] FAIL/.test(line.trim()));
    console.log('[P0] EXPECTED_IN_REHEARSAL：仅生产 env/D1 占位符按演练预期失败（其余必须 PASS）：');
    for (const line of expectedLines) console.log('  ' + line.trim());
    console.log('  （主网正式彩排不得带 --rehearsal；Expect 两项清零）');
    return 'EXPECTED_IN_REHEARSAL';
  }
  throw new Error('preflight-mainnet FAIL（非演练预期项，硬停）：' + tail);
}

async function P05() {
  if (dryRun) { console.log('[P0.5] dry-run: admin active + GRAM>=2 + A9==0'); return 'DRY_RUN'; }
  const adminOwner = registry.wallets.adminOwner && registry.wallets.adminOwner.address;
  must(adminOwner, 'P0.5：registry 缺少 wallets.adminOwner（先写 admin 地址）');
  const info = await getAddressInformation(params, adminOwner);
  must(info.state === 'active', 'P0.5：admin ' + adminOwner + ' 状态=' + info.state + '，不是 active；先 fund admin（部署前必须先激活）');
  const balance = BigInt(info.balance || 0);
  must(balance >= 2000000000n, 'P0.5：admin GRAM=' + (Number(balance) / 1e9).toFixed(3) + ' < 2.0；先 fund admin');
  const master = registry.contracts.jettonMaster && registry.contracts.jettonMaster.address;
  if (master) {
    const w = await walletBalance(adminOwner);
    const a9 = stackItemToBigInt((await runGetMethod(params, w.address, 'get_wallet_data')).stack[0]);
    must(a9 === 0n, 'P0.5：admin A9=' + a9.toString() + ' != 0（不是全新 admin）');
    console.log('[P0.5] PASS：admin active，GRAM=' + (Number(balance) / 1e9).toFixed(3) + '，A9=0');
  } else {
    console.log('[P0.5] PASS：admin active，GRAM=' + (Number(balance) / 1e9).toFixed(3) + '；master 未部署，A9 按全新实例为 0');
  }
  return 'PASS';
}

async function P1() {
  if (has('adopt-existing')) {
    const log = newestDeployLog();
    must(log, 'adopt-existing 需要已有 deploy-emulation 日志');
    const text = readFileSync(log, 'utf8');
    must(/Funded RC Jetton Wallet with \d+ raw A9/.test(text), '已有部署日志缺少 Funded RC Jetton Wallet');
    must(registry.contracts.jettonMaster.address, 'adopt-existing 需要 registry 已登记地址');
    state.addresses = Object.fromEntries(Object.entries(registry.contracts).map(([k, v]) => [k, v.address]));
    console.log('[P1] ADOPTED 已有 v8.9 部署：' + log);
    return 'ADOPTED';
  }
  const env = {
    OPS_REGISTRY: registryPath,
    OPS_PARAMS: paramsPath,
    A9_DEPLOY_TON_JETTON_MASTER: '0.15',
    A9_DEPLOY_TON_ORACLE_ADAPTER: '0.15',
    A9_DEPLOY_TON_TEAM_VAULT: '0.2',
    A9_DEPLOY_TON_ROUND_CONTROLLER: '0.5',
    A9_DEPLOY_MINT_TON: '0.55',
    A9_DEPLOY_MINT_FORWARD_TON: '0.4',
    A9_DEPLOY_WIRING_TON: '0.06',
    A9_DEPLOY_FUND_TON: '0.2',
    A9_TIMING_PREVIEW_SECONDS: String(params.timeline.previewSeconds),
    A9_TIMING_STAKE_SECONDS: String(params.timeline.stakeDurationSeconds),
    A9_TIMING_CANDLE_SECONDS: String(params.timeline.candleSeconds),
    A9_TIMING_CANDLE_COUNT: String(params.timeline.candleCount),
    A9_TIMING_MIN_QUALIFIED: String(params.timeline.minQualifiedCandles),
    A9_TIMING_OBSERVATION_SECONDS: String(params.timeline.observationSeconds),
  };
  if (dryRun) { console.log('[P1] dry-run: 15_deploy_contracts.mjs --execute（env 参数化 v8.9）'); return 'DRY_RUN'; }
  must(execute, 'P1 需要 --execute（或 --dry-run）');
  const r = runNode('15_deploy_contracts.mjs', ['--execute'], env, 900000);
  must(r.status === 0, '15_deploy_contracts 失败（exit ' + r.status + '）：' + String(r.stderr || r.stdout).slice(-600));
  const log = newestDeployLog();
  must(log, '找不到 deploy-emulation 日志');
  const text = readFileSync(log, 'utf8');
  must(/Funded RC Jetton Wallet with \d+ raw A9/.test(text), '部署日志缺少 Funded RC Jetton Wallet（成功判据）');
  must(/Deploy complete/.test(text), '部署日志缺少 Deploy complete');
  registry = loadRegistry({ create: false });
  state.addresses = Object.fromEntries(Object.entries(registry.contracts).map(([k, v]) => [k, v.address]));
  console.log('[P1] PASS，部署日志：' + log);
  return 'PASS';
}

async function P2() {
  const expected = expectedHashes();
  const rows = [
    ['JettonMaster', 'jettonMaster'],
    ['TeamVault', 'teamVault'],
    ['RoundController', 'roundController'],
    ['OracleAdapter', 'oracleAdapter'],
  ];
  const results = [];
  for (const [name, key] of rows) {
    const addr = registry.contracts[key] && registry.contracts[key].address;
    must(addr, 'registry 缺少 ' + key);
    const actual = codeHashOf(addr);
    must(actual, name + ' Code Hash 读取失败');
    must(actual === expected[name], name + ' hash 不匹配：' + actual + ' != ' + expected[name]);
    results.push(name + '=' + actual);
  }
  const rc = registry.contracts.roundController.address;
  const getter = await runGetMethod(params, rc, 'get_jetton_wallet_code_hash');
  const walletHash = ('0x' + stackItemToBigInt(getter.stack[0]).toString(16)).toLowerCase();
  must(walletHash === expected.JettonWallet, 'RC.get_jetton_wallet_code_hash 不匹配：' + walletHash);
  results.push('JettonWallet=' + walletHash);
  console.log('[P2] PASS：' + results.join(' '));
  return 'PASS';
}

async function P3() {
  const rc = registry.contracts.roundController.address;
  const cfg = await runGetMethod(params, rc, 'get_protocol_config');
  const slots = [12, 13, 14, 15, 16, 17];
  const expected = [
    Number(params.timeline.previewSeconds),
    Number(params.timeline.stakeDurationSeconds),
    Number(params.timeline.candleSeconds),
    Number(params.timeline.candleCount),
    Number(params.timeline.minQualifiedCandles),
    Number(params.timeline.observationSeconds),
  ];
  const actual = slots.map((i) => Number(stackItemToBigInt(cfg.stack[i])));
  for (let i = 0; i < 6; i++) must(actual[i] === expected[i], '槽 ' + slots[i] + '=' + actual[i] + ' != ' + expected[i]);
  console.log('[P3] PASS：' + actual.join('/'));
  return 'PASS';
}

async function P4() {
  const tv = registry.contracts.teamVault.address;
  const rc = registry.contracts.roundController.address;
  const r = acton('script --manifest-path Acton.toml --net ' + net + ' ../ops/scripts/tolk/query_tv.tolk', { TEAM_VAULT_ADDRESS: tv });
  const m = String(r.stdout + r.stderr).match(/controller=([A-Za-z0-9_-]{48})/);
  must(m, 'query_tv 未返回 controller');
  const controller = m[1];
  const a = parseAddress(controller);
  const b = parseAddress(rc);
  must(a.ok && b.ok, '地址解析失败');
  must(String(a.raw).toLowerCase() === String(b.raw).toLowerCase(), 'TV.controller 与 RC raw 地址不一致：' + a.raw + ' != ' + b.raw);
  console.log('[P4] PASS：TV.controller=' + controller + ' raw=' + a.raw);
  return 'PASS';
}

async function walletBalance(owner) {
  const master = registry.contracts.jettonMaster.address;
  const r = acton('script --manifest-path Acton.toml --net ' + net + ' ../ops/scripts/tolk/query_one_wallet.tolk ' + master + ' ' + owner);
  const m = String(r.stdout + r.stderr).match(/JETTON_WALLET=(\S+)/);
  must(m, 'query_one_wallet 未返回 JettonWallet：' + String(r.stderr || r.stdout).slice(-300));
  const d = await runGetMethod(params, m[1], 'get_wallet_data');
  return { address: m[1], balance: stackItemToBigInt(d.stack[0]) };
}
async function fundJetton(owner, amountRaw) {
  const master = registry.contracts.jettonMaster.address;
  const signer = process.env.A9_SIGNER_WALLET || arg('signer', params.network.deployer.walletNameDefault);
  const r = acton('script --manifest-path Acton.toml --net ' + net + ' scripts/deploy/fund_jetton.tolk ' + owner + ' ' + amountRaw, {
    JETTON_MASTER_ADDRESS: master,
    A9_SIGNER_WALLET: signer,
    OPS_EXECUTE: '1',
    OPS_CONFIRM: 'YES',
  }, 180000);
  must(r.status === 0, 'fund_jetton 失败（' + owner + ' ' + amountRaw + '）：' + String(r.stderr || r.stdout).slice(-400));
}
async function P5() {
  if (dryRun) { console.log('[P5] dry-run: 验证 RC/TV 82 亿，注入内盘 8 亿 / 流动 5 亿 / 营销 5 亿（每笔先 1 A9 probe）'); return 'DRY_RUN'; }
  must(execute, 'P5 需要 --execute（或 --dry-run）');
  const rcw = registry.contracts.roundControllerJettonWallet.address;
  const tvw = registry.contracts.teamVaultJettonWallet.address;
  const rcBal = stackItemToBigInt((await runGetMethod(params, rcw, 'get_wallet_data')).stack[0]);
  const tvBal = stackItemToBigInt((await runGetMethod(params, tvw, 'get_wallet_data')).stack[0]);
  if (has('relax-balances')) {
    console.log('[P5] WARN：--relax-balances，跳过 RC/TV=70/12 亿精确断言（仅演练用已跑过回归的实例）：RC=' + rcBal.toString() + ' TV=' + tvBal.toString());
  } else {
    must(rcBal === 7000000000000000000n, 'P5 RC A9 不是 70 亿：' + rcBal.toString());
    must(tvBal === 1200000000000000000n, 'P5 TV A9 不是 12 亿：' + tvBal.toString());
  }
  const plan = [
    ['internalSale', 'teamInternalWallet', 800000000000000000n],
    ['liquidity', 'liquidityWallet', 500000000000000000n],
    ['marketing', 'marketingWallet', 500000000000000000n],
  ];
  const adminOwner = registry.wallets.adminOwner && registry.wallets.adminOwner.address;
  must(adminOwner, 'registry 缺少 wallets.adminOwner，无法推导 admin JettonWallet');
  const adminWallet = (await walletBalance(adminOwner)).address;
  const adminBal = stackItemToBigInt((await runGetMethod(params, adminWallet, 'get_wallet_data')).stack[0]);
  const required = plan.reduce((sum, [, , amount]) => sum + amount, 0n);
  must(adminBal >= required, 'P5 前置失败：admin A9=' + adminBal.toString() + ' < 待分配 ' + required.toString() + '；先确认实例未跑过轮次/未部分分发');
  const skipProbes = has('skip-probes');
  for (const [kind, walletKey, target] of plan) {
    const owner = registry.wallets[walletKey] && registry.wallets[walletKey].address;
    must(owner, 'registry 缺少钱包 ' + walletKey);
    if (skipProbes) {
      console.log('[P5] WARN：--skip-probes，' + kind + ' 跳过 1 A9 probe（演练走查用，禁止主网）');
      await fundJetton(owner, target);
      await sleep(2000);
    } else {
      await fundJetton(owner, 1n);
      await sleep(1500);
      let afterProbe = (await walletBalance(owner)).balance;
      must(afterProbe === 1n, kind + ' probe 未到账：' + afterProbe.toString());
      await fundJetton(owner, target - 1n);
      await sleep(2000);
    }
    const final = (await walletBalance(owner)).balance;
    must(final === target, kind + ' 金额不符：' + final.toString() + ' != ' + target.toString());
    console.log('[P5] ' + kind + ' probe=1 → ' + target.toString() + '（probe 回读/Q确认，余量已发）');
  }
  console.log('[P5] PASS：RC/TV 已由部署注资，内部/流动/营销 probe 完成');
  return 'PASS';
}

async function P6() {
  // 仅在「刚部署完、尚未开轮（currentRound=0）」的时点成立。
  // 主网上线开轮后 totalSupply 会因奖励/本金/团队销毁而下降，admin 也会因分发而不再归零；
  // 不得拿本断言去校验运行中的实例。
  const master = registry.contracts.jettonMaster.address;
  must(master, 'registry 缺少 jettonMaster');
  const adminOwner = registry.wallets.adminOwner && registry.wallets.adminOwner.address;
  must(adminOwner, 'registry 缺少 wallets.adminOwner');
  const adminWallet = (await walletBalance(adminOwner)).address;
  const rc = registry.contracts.roundController.address;
  const cur = await runGetMethod(params, rc, 'get_current_round');
  const round = stackItemToBigInt(cur.stack[0]);
  must(round === 0n, 'P6 只允许在未开轮的全新实例上执行（currentRound=' + round.toString() + '）；运行中实例的 totalSupply 已因销毁下降，本断言不适用');
  const admin = await runGetMethod(params, adminWallet, 'get_wallet_data');
  const adminRaw = stackItemToBigInt(admin.stack[0]);
  const jd = await runGetMethod(params, master, 'get_jetton_data');
  const supply = stackItemToBigInt(jd.stack[0]);
  must(adminRaw === 0n, 'P6 守恒失败：admin A9 未归零 = ' + adminRaw.toString());
  must(supply === 10000000000000000000n, 'P6 守恒失败：totalSupply=' + supply.toString());
  console.log('[P6] PASS（全新未开轮时点）：admin=0，totalSupply=100 亿');
  return 'PASS';
}

const fns = { P0, 'P0.5': P05, P1, P2, P3, P4, P5, P6 };

state.startedAt = state.startedAt || new Date().toISOString();
for (const id of requested) {
  const prior = state.phases[id];
  if (resume && prior && prior.status === 'PASS') { console.log('[SKIP] ' + id + ' 已完成'); completed.push(id); continue; }
  const t0 = Date.now();
  console.log('[RUN] ' + id + '（' + net + '，' + (dryRun ? 'dry-run' : 'execute') + '）');
  state.phases[id] = { status: 'RUNNING', startedAt: new Date().toISOString() };
  save();
  try {
    const result = await fns[id]();
    const durationMs = Date.now() - t0;
    state.phases[id] = { status: (result === 'DRY_RUN' || result === 'EXPECTED_IN_REHEARSAL') ? result : 'PASS', result, durationMs, finishedAt: new Date().toISOString() };
    save();
    completed.push(id);
    console.log('[OK] ' + id + ' ' + result + '（' + (durationMs / 1000).toFixed(1) + 's）');
  } catch (e) {
    failPhase(id, e);
  }
}
state.finishedAt = new Date().toISOString();
save();
console.log('\n仪式完成：' + completed.join(', ') + '；耗时 ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
console.log('registry: ' + registryPath);
