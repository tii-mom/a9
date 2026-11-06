#!/usr/bin/env node
/**
 * 90 — 主网部署仪式（v11）：分阶段、可断点续跑、失败即停。
 *
 *   P0    worker/scripts/preflight-mainnet.mjs
 *   P0.5  treasury（mint 接收钱包）与 keeper 钱包：active、≥ 2 TON、A9 = 0（全新钱包）
 *   P1    15_deploy_contracts.mjs（deploy-emulation：Jetton + mint-once + RC + 82 亿注资，forward 0）
 *   P2    code hash：JettonMaster / RoundController / JettonWallet
 *   P3    get_protocol_config：时间参数 + keeper / jettonMaster / teamWallet 地址槽
 *   P4    RC 钱包推导一致 + RC 钱包余额 = 82 亿
 *   P5    treasury 分配内盘 8 亿 / 流动性 5 亿 / 营销 5 亿（每笔先 1 A9 probe）
 *   P6    守恒（未开轮时点）：treasury A9 = 0、total_supply = 100 亿、currentRound = 0
 *
 * --dry-run：每个阶段只打印计划，不访问网络、不改写登记表。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadParams, networkName, readJSON, resolvePath, RECORDS_DIR } from './lib/config.mjs';
import { emptyRegistry, loadRegistry, writeRegistry } from './lib/registry.mjs';
import { parseAddress, runGetMethod, stackItemToBigInt, addressFromStackItem, getAddressInformation } from './lib/ton.mjs';

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
// dry-run 不创建 / 不改写登记表
let registry = dryRun ? (loadRegistry({ create: false }) || emptyRegistry()) : loadRegistry({ create: true });
registry.ceremony = registry.ceremony || { phases: {}, completed: [], startedAt: null, finishedAt: null };
const state = registry.ceremony;

const RC_FUNDING_RAW = BigInt(params.rounds.rcFundingRaw);
const TOTAL_SUPPLY_RAW = BigInt(params.token.totalSupplyRaw);

const startedAt = Date.now();
const completed = [];

function save() {
  if (dryRun) return;
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
  console.error('止血章节：docs/29 §8（回滚与应急） / ops/runbooks/07 §8（回滚与应急）；不可逆项：合约部署（keeper/teamWallet 写死）、A9 注入。');
  process.exit(1);
}
/** 期望 code hash：--hashes=<json 文件>（审计冻结值，{ "RoundController": "0x…", … }）优先，否则取 contracts/build。 */
function expectedHashes() {
  const out = {};
  const file = arg('hashes');
  if (file) {
    const json = readJSON(resolvePath(file));
    for (const [name, hash] of Object.entries(json)) out[name] = String(hash).toLowerCase().replace(/^(0x)?/, '0x');
  }
  for (const name of ['RoundController', 'JettonWallet', 'JettonMaster']) {
    if (!out[name]) {
      const build = readJSON(resolvePath('contracts/build/' + name + '.json'));
      out[name] = ('0x' + String(build.hash).toLowerCase()).replace(/^0x0x/, '0x');
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
function contractAddress(key) { return registry.contracts[key] && registry.contracts[key].address; }
function walletAddress(key) { return registry.wallets[key] && registry.wallets[key].address; }
function sameAddress(stackItem, expected) {
  const onchain = addressFromStackItem(stackItem);
  const parsed = parseAddress(expected);
  return Boolean(onchain && parsed.ok && onchain.wc === parsed.workchain && onchain.hashHex.toLowerCase() === parsed.hashHex.toLowerCase());
}

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
  if (dryRun) {
    console.log('[P0.5] dry-run: treasury / keeper 钱包 active、GRAM ≥ 2、A9 = 0；teamWallet 已登记（写入 RC 初始数据，部署后不可改）');
    return 'DRY_RUN';
  }
  must(walletAddress('teamWallet'), 'P0.5：registry 缺少 wallets.teamWallet（写入 RC 初始数据，部署后不可改）');
  const master = contractAddress('jettonMaster');
  const results = [];
  for (const key of ['treasury', 'keeper']) {
    const address = walletAddress(key);
    must(address, 'P0.5：registry 缺少 wallets.' + key);
    const info = await getAddressInformation(params, address);
    must(info.state === 'active', 'P0.5：' + key + ' ' + address + ' 状态=' + info.state + '，不是 active；先转入 GRAM 激活');
    const balance = BigInt(info.balance || 0);
    must(balance >= 2000000000n, 'P0.5：' + key + ' GRAM=' + (Number(balance) / 1e9).toFixed(3) + ' < 2.0');
    if (master) {
      const a9 = (await walletBalance(address)).balance;
      must(a9 === 0n || a9 === null, 'P0.5：' + key + ' A9=' + String(a9) + ' != 0（不是全新钱包）');
    }
    results.push(key + ' GRAM=' + (Number(balance) / 1e9).toFixed(3));
  }
  console.log('[P0.5] PASS：' + results.join('，') + (master ? '，A9=0' : '；master 未部署，A9 按全新实例为 0'));
  return 'PASS';
}

async function P1() {
  if (has('adopt-existing')) {
    const log = newestDeployLog();
    must(log, 'adopt-existing 需要已有 deploy-emulation 日志');
    const text = readFileSync(log, 'utf8');
    must(/Funded RC Jetton Wallet with \d+ raw A9/.test(text), '已有部署日志缺少 Funded RC Jetton Wallet');
    must(contractAddress('jettonMaster') && contractAddress('roundController'), 'adopt-existing 需要 registry 已登记 jettonMaster / roundController');
    state.addresses = Object.fromEntries(Object.entries(registry.contracts).map(([k, v]) => [k, v.address]));
    console.log('[P1] ADOPTED 已有 v11 部署：' + log);
    return 'ADOPTED';
  }
  const env = {
    OPS_REGISTRY: registryPath,
    OPS_PARAMS: paramsPath,
    A9_DEPLOY_TON_JETTON_MASTER: '0.15',
    A9_DEPLOY_TON_ROUND_CONTROLLER: '0.5',
    A9_DEPLOY_MINT_TON: '0.55',
    A9_DEPLOY_MINT_FORWARD_TON: '0.4',
    A9_DEPLOY_FUND_TON: '0.2',
    A9_TIMING_PREVIEW_SECONDS: String(params.timeline.previewSeconds),
    A9_TIMING_STAKE_SECONDS: String(params.timeline.stakeDurationSeconds),
    A9_TIMING_CANDLE_SECONDS: String(params.timeline.candleSeconds),
    A9_TIMING_CANDLE_COUNT: String(params.timeline.candleCount),
    A9_TIMING_MIN_QUALIFIED: String(params.timeline.minQualifiedCandles),
    A9_DEPLOY_MIN_STAKE_RAW: String(params.stakeLimits.minStakeRaw),
  };
  if (dryRun) {
    console.log('[P1] dry-run: 15_deploy_contracts.mjs --execute（keeper=' + (walletAddress('keeper') || '<wallets.keeper>') + ' teamWallet=' + (walletAddress('teamWallet') || '<wallets.teamWallet>') + '；timing ' + [env.A9_TIMING_PREVIEW_SECONDS, env.A9_TIMING_STAKE_SECONDS, env.A9_TIMING_CANDLE_SECONDS, env.A9_TIMING_CANDLE_COUNT, env.A9_TIMING_MIN_QUALIFIED].join('/') + '；minStake ' + env.A9_DEPLOY_MIN_STAKE_RAW + '；RC 注资 ' + params.rounds.rcFundingRaw + ' forward 0）');
    return 'DRY_RUN';
  }
  must(execute, 'P1 需要 --execute（或 --dry-run）');
  const r = runNode('15_deploy_contracts.mjs', ['--execute'], env, 900000);
  must(r.status === 0, '15_deploy_contracts 失败（exit ' + r.status + '）：' + String(r.stderr || r.stdout).slice(-600));
  const log = newestDeployLog();
  must(log, '找不到 deploy-emulation 日志');
  const text = readFileSync(log, 'utf8');
  must(/Funded RC Jetton Wallet with \d+ raw A9/.test(text), '部署日志缺少 Funded RC Jetton Wallet（成功判据）');
  must(/=== A9 v11 deploy summary ===/.test(text), '部署日志缺少 v11 deploy summary');
  registry = loadRegistry({ create: false });
  state.addresses = Object.fromEntries(Object.entries(registry.contracts).map(([k, v]) => [k, v.address]));
  console.log('[P1] PASS，部署日志：' + log);
  return 'PASS';
}

async function P2() {
  if (dryRun) { console.log('[P2] dry-run: acton rpc info → JettonMaster / RoundController code hash，RC.get_jetton_wallet_code_hash → JettonWallet；期望值来自 --hashes=<审计冻结 json> 或 contracts/build'); return 'DRY_RUN'; }
  const expected = expectedHashes();
  const results = [];
  for (const [name, key] of [['JettonMaster', 'jettonMaster'], ['RoundController', 'roundController']]) {
    const addr = contractAddress(key);
    must(addr, 'registry 缺少 ' + key);
    const actual = codeHashOf(addr);
    must(actual, name + ' Code Hash 读取失败');
    must(actual === expected[name], name + ' hash 不匹配：' + actual + ' != ' + expected[name]);
    results.push(name + '=' + actual);
  }
  const getter = await runGetMethod(params, contractAddress('roundController'), 'get_jetton_wallet_code_hash');
  const walletHash = ('0x' + stackItemToBigInt(getter.stack[0]).toString(16).padStart(64, '0')).toLowerCase();
  must(walletHash === expected.JettonWallet, 'RC.get_jetton_wallet_code_hash 不匹配：' + walletHash);
  results.push('JettonWallet=' + walletHash);
  console.log('[P2] PASS：' + results.join(' '));
  return 'PASS';
}

async function P3() {
  if (dryRun) { console.log('[P3] dry-run: get_protocol_config 槽 0/1=keeper、2=jettonMaster、4=teamWallet、9=minStake ' + params.stakeLimits.minStakeRaw + '、12..17 时间参数'); return 'DRY_RUN'; }
  const rc = contractAddress('roundController');
  const cfg = await runGetMethod(params, rc, 'get_protocol_config');
  for (const [slot, key, address] of [[0, 'keeper', walletAddress('keeper')], [1, 'keeper', walletAddress('keeper')], [2, 'jettonMaster', contractAddress('jettonMaster')], [4, 'teamWallet', walletAddress('teamWallet')]]) {
    must(address, 'registry 缺少 ' + key);
    must(sameAddress(cfg.stack[slot], address), '槽 ' + slot + '（' + key + '）与 registry 不一致');
  }
  const slots = [9, 12, 13, 14, 15, 16, 17];
  const expected = [
    BigInt(params.stakeLimits.minStakeRaw),
    BigInt(params.timeline.previewSeconds),
    BigInt(params.timeline.stakeDurationSeconds),
    BigInt(params.timeline.candleSeconds),
    BigInt(params.timeline.candleCount),
    BigInt(params.timeline.minQualifiedCandles),
    BigInt(params.timeline.observationSeconds),
  ];
  const actual = slots.map((i) => stackItemToBigInt(cfg.stack[i]));
  for (let i = 0; i < slots.length; i++) must(actual[i] === expected[i], '槽 ' + slots[i] + '=' + actual[i] + ' != ' + expected[i]);
  console.log('[P3] PASS：keeper/jettonMaster/teamWallet 一致；' + actual.join('/'));
  return 'PASS';
}

async function P4() {
  if (dryRun) { console.log('[P4] dry-run: RC.get_jetton_wallet_address == master.get_wallet_address(RC) == registry；RC 钱包余额 == ' + RC_FUNDING_RAW + '（70 亿奖励 + 12 亿团队）'); return 'DRY_RUN'; }
  const rc = contractAddress('roundController');
  const viaMaster = (await walletBalance(rc)).address;
  const self = await runGetMethod(params, rc, 'get_jetton_wallet_address');
  must(sameAddress(self.stack[0], viaMaster), 'RC.get_jetton_wallet_address 与 master.get_wallet_address(RC)=' + viaMaster + ' 不一致');
  const recorded = contractAddress('roundControllerJettonWallet');
  must(recorded && parseAddress(recorded).raw === parseAddress(viaMaster).raw, 'registry.roundControllerJettonWallet=' + recorded + ' 与链上推导 ' + viaMaster + ' 不一致');
  const balance = stackItemToBigInt((await runGetMethod(params, viaMaster, 'get_wallet_data')).stack[0]);
  if (has('relax-balances')) console.log('[P4] WARN：--relax-balances，跳过 RC = 82 亿精确断言（仅演练用已跑过轮次的实例）：RC=' + String(balance));
  else must(balance === RC_FUNDING_RAW, 'P4 RC A9 不是 82 亿：' + String(balance));
  console.log('[P4] PASS：RC 钱包 ' + viaMaster + '，余额 ' + String(balance));
  return 'PASS';
}

async function walletBalance(owner) {
  const master = contractAddress('jettonMaster');
  const r = acton('script --manifest-path Acton.toml --net ' + net + ' ../ops/scripts/tolk/query_one_wallet.tolk ' + master + ' ' + owner);
  const m = String(r.stdout + r.stderr).match(/JETTON_WALLET=(\S+)/);
  must(m, 'query_one_wallet 未返回 JettonWallet：' + String(r.stderr || r.stdout).slice(-300));
  let balance = null;
  try {
    const d = await runGetMethod(params, m[1], 'get_wallet_data');
    balance = d.exit_code ? 0n : stackItemToBigInt(d.stack[0]);
  } catch { balance = 0n; } // 钱包未部署 = 0
  return { address: m[1], balance };
}
async function fundJetton(owner, amountRaw) {
  const master = contractAddress('jettonMaster');
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
  const plan = [
    ['internalSale', 'teamInternalWallet', BigInt(params.supply.allocations.internalSale.raw)],
    ['liquidity', 'liquidityWallet', BigInt(params.supply.allocations.liquidity.raw)],
    ['marketing', 'marketingWallet', BigInt(params.supply.allocations.marketing.raw)],
  ];
  if (dryRun) { console.log('[P5] dry-run: treasury → ' + plan.map(([kind, , amount]) => kind + ' ' + amount).join(' / ') + '（每笔先 1 A9 probe，回读确认后发余量）'); return 'DRY_RUN'; }
  must(execute, 'P5 需要 --execute（或 --dry-run）');
  const treasury = walletAddress('treasury');
  must(treasury, 'registry 缺少 wallets.treasury，无法推导 treasury JettonWallet');
  const treasuryBal = (await walletBalance(treasury)).balance;
  const required = plan.reduce((sum, [, , amount]) => sum + amount, 0n);
  must(treasuryBal >= required, 'P5 前置失败：treasury A9=' + String(treasuryBal) + ' < 待分配 ' + required.toString() + '；先确认实例未部分分发');
  const skipProbes = has('skip-probes');
  for (const [kind, walletKey, target] of plan) {
    const owner = walletAddress(walletKey);
    must(owner, 'registry 缺少钱包 ' + walletKey);
    if (skipProbes) {
      console.log('[P5] WARN：--skip-probes，' + kind + ' 跳过 1 A9 probe（演练走查用，禁止主网）');
      await fundJetton(owner, target);
      await sleep(2000);
    } else {
      await fundJetton(owner, 1n);
      await sleep(1500);
      const afterProbe = (await walletBalance(owner)).balance;
      must(afterProbe === 1n, kind + ' probe 未到账：' + String(afterProbe));
      await fundJetton(owner, target - 1n);
      await sleep(2000);
    }
    const final = (await walletBalance(owner)).balance;
    must(final === target, kind + ' 金额不符：' + String(final) + ' != ' + target.toString());
    console.log('[P5] ' + kind + ' probe=1 → ' + target.toString() + '（probe 回读确认，余量已发）');
  }
  console.log('[P5] PASS：RC 82 亿已由部署注资，内盘/流动性/营销 probe 完成');
  return 'PASS';
}

async function P6() {
  // 仅在「刚部署完、尚未开轮（currentRound=0）」的时点成立：开轮后失败轮会一笔销毁，total_supply 下降。
  if (dryRun) { console.log('[P6] dry-run: currentRound == 0；treasury A9 == 0；total_supply == ' + TOTAL_SUPPLY_RAW + '；RC 82 亿 + 内盘/流动性/营销 18 亿 = 100 亿'); return 'DRY_RUN'; }
  const master = contractAddress('jettonMaster');
  must(master, 'registry 缺少 jettonMaster');
  const treasury = walletAddress('treasury');
  must(treasury, 'registry 缺少 wallets.treasury');
  const rc = contractAddress('roundController');
  const cur = await runGetMethod(params, rc, 'get_current_round');
  const round = stackItemToBigInt(cur.stack[0]);
  must(round === 0n, 'P6 只允许在未开轮的全新实例上执行（currentRound=' + String(round) + '）');
  const treasuryRaw = (await walletBalance(treasury)).balance;
  const jd = await runGetMethod(params, master, 'get_jetton_data');
  const supply = stackItemToBigInt(jd.stack[0]);
  must(treasuryRaw === 0n, 'P6 守恒失败：treasury A9 未归零 = ' + String(treasuryRaw));
  must(supply === TOTAL_SUPPLY_RAW, 'P6 守恒失败：totalSupply=' + String(supply));
  console.log('[P6] PASS（全新未开轮时点）：treasury=0，totalSupply=100 亿');
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
