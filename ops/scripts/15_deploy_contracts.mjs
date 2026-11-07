#!/usr/bin/env node
/**
 * 15 — 整体部署（contracts/scripts/deploy-emulation.tolk，v11）：
 * JettonMaster + mint-once → RoundController（keeper / teamWallet / 参数写入初始数据，无 admin、无 wiring）
 * → 核对 RC 钱包推导 → treasury 向 RC 注资 82 亿（forward_ton_amount = 0）
 * → JunxiangDistributor 部署（publisher = junxiangPublisher，缺省 keeper；不注资）→ 读回 ticket code hash / get_distributor。
 * 快测档：OPS_PARAMS=ops/config/testnet-fast.params.json 时，时序自动取快测参数（见 testnet-fast.params.json 的 fastCycle）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { str } from './lib/cli.mjs';
import { BAM_ROOT, RECORDS_DIR, networkName, resolvePath } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress } from './lib/step.mjs';
import { commandTemplate, hasCommand, runCommand, substitute } from './lib/toolchain.mjs';
import { recordFunding, setContract, writeRegistry } from './lib/registry.mjs';
import { getJettonData, getJettonWalletBalance, getTonBalance, parseAddress } from './lib/ton.mjs';
import { resolveWalletAddress } from './lib/step.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, digest, registry, toolchain } = bootstrap({
  id: '15',
  title: '整体部署（deploy-emulation v11：Jetton + RoundController + 82 亿注资 + JunxiangDistributor）',
});

// keeper / teamWallet 写入 RC 初始数据，部署后永久不可改：优先登记表，其次环境变量。
const keeper = str(args, 'keeper') || resolveWalletAddress(registry, 'keeper') || process.env[params.roles.keeper.env] || '';
const teamWallet = str(args, 'team-wallet') || resolveWalletAddress(registry, 'teamWallet') || process.env[params.roles.teamWallet.env] || '';
// junxiangPublisher 写入军饷分发合约，部署后不可改；缺省 = keeper（与 deploy-emulation 的默认一致）。
const junxiangPublisher = str(args, 'junxiang-publisher') || resolveWalletAddress(registry, 'junxiangPublisher') || process.env[params.roles.junxiangPublisher.env] || keeper;

// 时间与限额参数默认取 params（显式环境变量优先），保证链上初始数据与参数文件一致。
const deployEnvDefaults = {
  A9_TIMING_PREVIEW_SECONDS: params.timeline.previewSeconds,
  A9_TIMING_STAKE_SECONDS: params.timeline.stakeDurationSeconds,
  A9_TIMING_CANDLE_SECONDS: params.timeline.candleSeconds,
  A9_TIMING_CANDLE_COUNT: params.timeline.candleCount,
  A9_TIMING_MIN_QUALIFIED: params.timeline.minQualifiedCandles,
  A9_TIMING_ABORT_TIMEOUT_SECONDS: params.techAbort.abortTimeoutSeconds,
  A9_TIMING_FALLBACK_UNLOCK_SECONDS: params.techAbort.fallbackUnlockSeconds ?? 2592000,
  A9_DEPLOY_ROUND_REWARD_RAW: params.rounds.roundRewardRaw,
  A9_DEPLOY_TEAM_ROUND_RAW: params.rounds.teamRoundRaw,
  A9_DEPLOY_MIN_STAKE_RAW: params.stakeLimits.minStakeRaw,
};
for (const [key, value] of Object.entries(deployEnvDefaults)) {
  if (process.env[key] === undefined) process.env[key] = String(value);
}
const TIMING_ENV_KEYS = ['A9_TIMING_PREVIEW_SECONDS', 'A9_TIMING_STAKE_SECONDS', 'A9_TIMING_CANDLE_SECONDS', 'A9_TIMING_CANDLE_COUNT', 'A9_TIMING_MIN_QUALIFIED', 'A9_TIMING_ABORT_TIMEOUT_SECONDS', 'A9_TIMING_FALLBACK_UNLOCK_SECONDS'];

const fromLog = str(args, 'from-log');
const overrides = {
  jettonMaster: str(args, 'jetton-master'),
  roundController: str(args, 'round-controller'),
  roundControllerJettonWallet: str(args, 'rc-wallet'),
};

function renderDeployCommand() {
  return substitute(commandTemplate(params, 'deployAllContracts'), {
    contractsDir: params.toolchain.contractsDir,
    keeper: keeper || '<KEEPER>',
    teamWallet: teamWallet || '<TEAM_WALLET>',
    junxiangPublisher: junxiangPublisher || '<JUNXIANG_PUBLISHER>',
  });
}

section('部署范围（contracts/scripts/deploy-emulation.tolk，v11）');
detail('顺序：部署 JettonMaster → mint 100 亿到 treasury（mint-once）→ 部署 RoundController（keeper/teamWallet/参数/JettonWallet+StakeTicket 代码写入初始数据）→ 核对 RC 钱包推导与 ticket code hash → 注资 82 亿（forward_ton_amount = 0）→ 部署 JunxiangDistributor（不注资）→ 读回 get_distributor。');
detail('v11 没有 admin，也没有任何钱包绑定 / 角色绑定步骤（RC 在链上自行推导 Jetton Wallet）；分步部署只保留 Jetton 两步（10/11）。');
kv('keeper', keeper || '（未提供：登记表 wallets.keeper 或 ' + params.roles.keeper.env + '）');
kv('teamWallet', teamWallet || '（未提供：登记表 wallets.teamWallet 或 ' + params.roles.teamWallet.env + '）');
kv('junxiangPublisher', junxiangPublisher || '（未提供：默认 keeper，但 keeper 也未确定）');
kv('时间参数', TIMING_ENV_KEYS.map((key) => key + '=' + process.env[key]).join(' '));
kv('最低质押 raw', process.env.A9_DEPLOY_MIN_STAKE_RAW);
kv('Acton 版本', toolchain.pinnedVersion || toolchain.version || '（未知）');
kv('命令', hasCommand(params, 'deployAllContracts') ? renderDeployCommand() : '（模板缺失）');
kv('现有登记', resolveContractAddress(registry, 'jettonMaster') ? 'JettonMaster=' + resolveContractAddress(registry, 'jettonMaster') : '（未部署）');
kv('配置哈希', digest);

if (fromLog) {
  const logFile = resolvePath(fromLog, BAM_ROOT);
  if (!existsSync(logFile)) { fail('日志文件不存在：' + logFile); process.exit(finish()); }
  const text = readFileSync(logFile, 'utf8');
  await registerFromText(text, logFile);
  process.exit(finish({ 来源: logFile }));
}

if (!execute) {
  detail('dry-run：不执行部署。真实执行：OPS_EXECUTE=1 node scripts/15_deploy_contracts.mjs --execute');
  detail('执行后脚本会解析 deploy-emulation 输出中的 JettonMaster / RoundController / RC Jetton Wallet 并登记，');
  detail('并根据「Funded RC Jetton Wallet」行与链上余额登记 RC 82 亿注资；解析失败时可用 --from-log <日志> 重试，或用 10/30 的 --adopt 登记。');
  if (!keeper || !teamWallet) warn('keeper / teamWallet 未确定：EXECUTE 会被拒绝（两者写入 RC 初始数据，部署后不可改）');
  printNextSteps([
    '后续：node scripts/40_init_params.mjs --execute --online（链上参数校验）',
    '然后：node scripts/55_fund_ton.mjs --execute → node scripts/50_fund_vaults.mjs --execute --probe --all',
    '最后：node scripts/60_verify_and_register.mjs --execute → verify_deployment.mjs --online → 开 R1',
  ]);
  process.exit(finish({ 模式: 'DRY-RUN' }));
}

if (!hasCommand(params, 'deployAllContracts')) {
  fail('缺少 deployAllContracts 命令模板：检查 config/testnet.params.json toolchain.adapters.acton.commands');
  process.exit(finish());
}
if (!toolchain.available) {
  fail('Acton 不可用：' + (toolchain.note || '安装 Acton 后重试'));
  process.exit(finish());
}

if (!keeper || !teamWallet) {
  fail('keeper / teamWallet 必须在部署前确定（写入 RC 初始数据，永久不可改）：先登记 wallets.keeper / wallets.teamWallet，或设置 ' + params.roles.keeper.env + ' / ' + params.roles.teamWallet.env);
  process.exit(finish());
}
for (const [label, address] of [['keeper', keeper], ['teamWallet', teamWallet], ['junxiangPublisher', junxiangPublisher]]) {
  if (!parseAddress(address).ok) { fail(label + ' 地址非法：' + address); process.exit(finish()); }
}
const command = renderDeployCommand();
section('执行整体部署');
detail('命令：' + command);
const result = runCommand(command, { execute: true, timeoutMs: 600000 });
mkdirSync(RECORDS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logFile = join(RECORDS_DIR, 'deploy-emulation-' + stamp + '.log');
writeFileSync(logFile, 'COMMAND: ' + command + String.fromCharCode(10, 10) + 'STDOUT:' + String.fromCharCode(10) + result.stdout + String.fromCharCode(10) + 'STDERR:' + String.fromCharCode(10) + result.stderr, 'utf8');
if (result.status !== 0) {
  fail('整体部署失败（exit ' + result.status + '）；日志：' + logFile);
  detail((result.stderr || result.stdout).slice(-800));
  process.exit(finish({ 日志: logFile }));
}
ok('整体部署命令执行完成；日志：' + logFile);
await registerFromText(result.stdout + String.fromCharCode(10) + result.stderr, logFile);

function cleanToken(token) {
  let out = '';
  for (const char of token) {
    if (',;()[]{}'.includes(char)) continue;
    if (char === '.' || char === ':' && out.includes(':')) continue;
    out += char;
  }
  return out;
}

function loadBuildHash(contractName) {
  const file = resolvePath(params.toolchain.buildDir + '/' + contractName + '.json');
  if (!existsSync(file)) return null;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    return json.hash && /^[0-9a-fA-F]{64}$/.test(json.hash) ? json.hash.toLowerCase() : null;
  } catch { return null; }
}

function codeHashViaActon(address) {
  const command = 'export PATH=$HOME/.acton/bin:$PATH; cd ' + params.toolchain.contractsDir + ' && acton rpc info ' + address + ' --net ' + networkName();
  const result = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 60000 });
  const match = String(result.stdout || '').match(/Code Hash:\s+0x([0-9a-fA-F]{64})/);
  return match ? match[1].toLowerCase() : null;
}

function parseAddresses(text) {
  const found = { jettonMaster: null, roundController: null, roundControllerJettonWallet: null, junxiangDistributor: null, junxiangDistributorJettonWallet: null };
  const others = [];
  const lines = String(text).split(String.fromCharCode(10));
  for (const line of lines) {
    const tokens = line.split(' ').map(cleanToken).filter(Boolean);
    const addresses = tokens.filter((token) => parseAddress(token).ok);
    if (!addresses.length) continue;
    const lower = line.toLowerCase();
    const first = addresses[0];
    if (lower.includes('funded rc jetton wallet')) continue; // 注资行不含地址
    if (lower.includes('distributor jetton wallet')) found.junxiangDistributorJettonWallet = found.junxiangDistributorJettonWallet || first;
    else if (lower.includes('junxiangdistributor') || lower.includes('junxiang distributor')) found.junxiangDistributor = found.junxiangDistributor || first;
    else if (lower.includes('rc jetton wallet') || (lower.includes('jetton wallet') && (lower.includes('roundcontroller') || lower.includes('round controller')))) found.roundControllerJettonWallet = found.roundControllerJettonWallet || first;
    else if (lower.includes('jettonmaster') || lower.includes('jetton master')) found.jettonMaster = found.jettonMaster || first;
    else if (lower.includes('roundcontroller') || lower.includes('round controller')) found.roundController = found.roundController || first;
    else others.push(first);
  }
  const remaining = others.filter((address) => Object.values(found).includes(address) === false);
  for (const key of Object.keys(found)) {
    if (!found[key]) found[key] = overrides[key] || null;
  }
  return { found, others: remaining };
}

async function registerFromText(text, logPath) {
  const parsed = parseAddresses(text);
  const labels = {
    jettonMaster: 'JettonMaster',
    roundController: 'RoundController',
    roundControllerJettonWallet: 'RC Jetton Wallet',
    junxiangDistributor: 'JunxiangDistributor',
    junxiangDistributorJettonWallet: 'Distributor Jetton Wallet',
  };
  section('解析部署地址');
  const buildNameByKey = {
    jettonMaster: 'JettonMaster',
    roundController: 'RoundController',
    junxiangDistributor: 'JunxiangDistributor',
  };
  const rows = [];
  const inactive = [];
  const codeHashBad = [];
  for (const [key, label] of Object.entries(labels)) {
      const address = parsed.found[key];
      if (!address) { rows.push([label, '（未解析）', '需 --adopt/覆盖']); continue; }
      if (key.endsWith('JettonWallet')) {
        rows.push([label, address, 'deploy-emulation 已核对 RC.get_jetton_wallet_address == master.get_wallet_address(RC)']);
        continue;
      }
      let status = '未检查';
      try {
        const info = await getTonBalance(params, address);
        const balanceTon = (Number(BigInt(info.balanceNano)) / 1e9).toFixed(3);
        const active = info.state === 'active';
        const expected = buildNameByKey[key] ? loadBuildHash(buildNameByKey[key]) : null;
        const actual = active ? codeHashViaActon(address) : null;
        const codeOk = !expected || (actual !== null && actual === expected);
        if (!active) inactive.push(label);
        if (active && !codeOk) codeHashBad.push(label + '（链上 ' + (actual || '未读取') + ' vs build ' + (expected || '无') + '）');
        status = (active ? 'active' : '未激活') + ' / ' + balanceTon + ' TON' + (active ? (codeOk ? ' / code hash OK' : ' / CODE HASH MISMATCH') : '');
      } catch (error) {
        status = '检查失败：' + String(error.message || error).slice(0, 80);
        inactive.push(label);
      }
      rows.push([label, address, status]);
    }
    table(['对象', '地址', '状态'], rows);
    if (inactive.length) {
      fail('以下部署地址链上未激活：' + inactive.join('、') + '；不登记（Acton waitForTrace 成功不等于账户已部署）');
      detail('原因通常是部署发送钱包 TON 不足或部署消息被 bounce；先修复 TON/参数再重跑。');
      process.exit(finish({ 结果: 'INACTIVE_CONTRACTS', 未激活: inactive.join(',') }));
    }
    if (codeHashBad.length) {
      fail('合约 code hash 与 build 不一致：' + codeHashBad.join('；'));
      process.exit(finish({ 结果: 'CODE_HASH_MISMATCH' }));
    }
    for (const key of Object.keys(labels)) {
      const address = parsed.found[key];
      if (address) {
        try { setContract(registry, key, address, { note: 'deploy-emulation 输出解析 + 链上 active/code hash 校验' }); }
        catch (error) { warn(labels[key] + ' 登记失败：' + String(error.message || error)); }
      }
    }
    if (parsed.found.roundController) {
      registry.bindings.roundControllerKeeper = keeper || null;
      registry.bindings.roundControllerTeamWallet = teamWallet || null;
      registry.bindings.roundControllerJettonWalletOwner = parsed.found.roundController;
      registry.bindings.hasAdmin = false;
    }
    await registerRcFunding(text, parsed.found);
    writeRegistry(registry);
    const missing = Object.entries(labels).filter(([key]) => !parsed.found[key]).map(([, label]) => label);
    if (missing.length) {
      warn('以下地址未解析：' + missing.join('、'));
      detail('可用 --from-log ' + logPath + ' 重试；或用 10/30 脚本 --adopt 分别登记。');
      info('其余地址已登记；请先补齐后再执行 40/55/50/60。');
    } else {
      ok('整体部署地址已全部登记（链上 active + code hash 校验通过）');
  }
  if (parsed.others.length) detail('日志中其他地址（可能包含 admin/treasury/用户钱包）：' + parsed.others.join(', '));
  if (parsed.found.jettonMaster) {
    try {
      const data = await getJettonData(params, parsed.found.jettonMaster);
      section('Jetton 复核');
      kv('total_supply', data.totalSupplyRaw || '（未读取）');
      kv('mintable', String(data.mintable));
      kv('admin = null', String(data.adminNull));
      if (data.totalSupplyRaw === params.token.totalSupplyRaw && data.mintable === false) ok('Jetton mint-once 校验通过（100 亿、mint 关闭）');
      else warn('Jetton 校验未完全通过，请执行 verify_deployment.mjs --online 进一步核对');
    } catch (error) {
      warn('Jetton 复核失败：' + String(error.message || error));
    }
  }
  printNextSteps([
    '下一步：node scripts/40_init_params.mjs --execute --online',
    '然后：node scripts/55_fund_ton.mjs --execute → node scripts/50_fund_vaults.mjs --execute --probe --all（RC 82 亿已由部署注资时自动识别）',
    '最后：node scripts/60_verify_and_register.mjs --execute → verify_deployment.mjs --online → 80_admin_ops --action open-round --round 1',
  ]);
}

/** deploy-emulation 已向 RC 注资 82 亿（forward 0）：以链上余额为准登记 funding。 */
async function registerRcFunding(text, found) {
  const match = String(text).match(/Funded RC Jetton Wallet with (\d+) raw A9/);
  const expected = params.rounds.rcFundingRaw;
  if (!match) { warn('日志中没有「Funded RC Jetton Wallet」：RC 尚未注资，请执行 50_fund_vaults.mjs'); return; }
  if (match[1] !== expected) { fail('部署日志注资额 ' + match[1] + ' != 期望 82 亿 ' + expected); return; }
  if (!found.roundControllerJettonWallet) return;
  const balance = await getJettonWalletBalance(params, found.roundControllerJettonWallet);
  if (balance === null || balance.toString() !== expected) {
    warn('RC Jetton Wallet 链上余额 ' + (balance === null ? '未读取' : balance.toString()) + ' != ' + expected + '：不登记注资，稍后用 50_fund_vaults.mjs --resume 核对');
    return;
  }
  recordFunding(registry, { kind: 'roundController', recipient: found.roundControllerJettonWallet, recipientOwner: found.roundController, amountRaw: expected, forwardTonNano: '0', confirmed: true, txHash: null, note: 'deploy-emulation 注资（forward_ton_amount = 0），链上余额核对一致' });
  ok('RC 82 亿注资已登记（链上余额 = ' + expected + '）');
}

process.exit(finish({ 模式: 'EXECUTE', 日志: logFile }));
