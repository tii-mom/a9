#!/usr/bin/env node
/** 15 — 整体部署（contracts/scripts/deploy-emulation.tolk）：JettonMaster + mint + TeamVault + RoundController + SetJettonWallet + InitController。 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { str } from './lib/cli.mjs';
import { BAM_ROOT, RECORDS_DIR, resolvePath } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress } from './lib/step.mjs';
import { commandTemplate, hasCommand, runCommand, substitute } from './lib/toolchain.mjs';
import { setContract, writeRegistry } from './lib/registry.mjs';
import { getTonBalance, getJettonData, parseAddress } from './lib/ton.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, digest, registry, toolchain } = bootstrap({
  id: '15',
  title: '整体部署（deploy-emulation：Jetton + TeamVault + RoundController + 绑定）',
});

const fromLog = str(args, 'from-log');
const overrides = {
  jettonMaster: str(args, 'jetton-master'),
  teamVault: str(args, 'team-vault'),
  roundController: str(args, 'round-controller'),
  roundControllerJettonWallet: str(args, 'rc-wallet'),
  teamVaultJettonWallet: str(args, 'tv-wallet'),
};

section('部署范围（contracts/scripts/deploy-emulation.tolk）');
detail('顺序：部署 JettonMaster → mint 100 亿（mint-once，admin 同笔置 null）→ 部署 TeamVault → 部署 RoundController → 解析 RC/TV canonical Jetton Wallet → SetJettonWallet → InitController。');
detail('命令使用位置参数/整体模式；该脚本没有分步子命令。分步部署只保留 Jetton 两步（10/11）。');
kv('Acton 版本', toolchain.pinnedVersion || toolchain.version || '（未知）');
kv('命令', hasCommand(params, 'deployAllContracts') ? substitute(commandTemplate(params, 'deployAllContracts'), { contractsDir: params.toolchain.contractsDir }) : '（模板缺失）');
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
  detail('执行后脚本会解析 deploy-emulation 输出中的 JettonMaster / TeamVault / RoundController / RC Wallet / TV Wallet 并登记；');
  detail('解析失败时可用 --from-log <日志> 重试，或分别用 10/20/30 脚本的 adopt 模式登记。');
  printNextSteps([
    '后续：node scripts/40_init_params.mjs --execute --online（链上参数校验）',
    '然后：node scripts/55_fund_ton.mjs --execute → node scripts/50_fund_vaults.mjs --execute --all',
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

const command = substitute(commandTemplate(params, 'deployAllContracts'), {
  contractsDir: params.toolchain.contractsDir,
});
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
  const command = 'export PATH=$HOME/.acton/bin:$PATH; cd ' + params.toolchain.contractsDir + ' && acton rpc info ' + address + ' --net testnet';
  const result = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 60000 });
  const match = String(result.stdout || '').match(/Code Hash:\s+0x([0-9a-fA-F]{64})/);
  return match ? match[1].toLowerCase() : null;
}

function parseAddresses(text) {
  const found = { jettonMaster: null, oracleAdapter: null, teamVault: null, roundController: null, roundControllerJettonWallet: null, teamVaultJettonWallet: null };
  const others = [];
  const lines = String(text).split(String.fromCharCode(10));
  for (const line of lines) {
    const tokens = line.split(' ').map(cleanToken).filter(Boolean);
    const addresses = tokens.filter((token) => parseAddress(token).ok);
    if (!addresses.length) continue;
    const lower = line.toLowerCase();
    const first = addresses[0];
    if (lower.includes('oracleadapter') || lower.includes('oracle adapter')) found.oracleAdapter = found.oracleAdapter || first;
    else if (lower.includes('jettonmaster') || lower.includes('jetton master')) found.jettonMaster = found.jettonMaster || first;
    else if (lower.includes('jetton wallet') && (lower.includes('teamvault') || lower.includes('team vault') || lower.includes('tv jetton'))) found.teamVaultJettonWallet = found.teamVaultJettonWallet || first;
    else if (lower.includes('jetton wallet') && (lower.includes('roundcontroller') || lower.includes('round controller') || lower.includes('rc jetton'))) found.roundControllerJettonWallet = found.roundControllerJettonWallet || first;
    else if (lower.includes('teamvault') || lower.includes('team vault')) found.teamVault = found.teamVault || first;
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
    teamVault: 'TeamVault',
    roundController: 'RoundController',
    roundControllerJettonWallet: 'RC Jetton Wallet',
    teamVaultJettonWallet: 'TV Jetton Wallet',
    oracleAdapter: 'OracleAdapter',
  };
  section('解析部署地址');
  const buildNameByKey = {
    jettonMaster: 'JettonMaster',
    oracleAdapter: 'OracleAdapter',
    teamVault: 'TeamVault',
    roundController: 'RoundController',
  };
  const rows = [];
  const inactive = [];
  const codeHashBad = [];
  for (const [key, label] of Object.entries(labels)) {
      const address = parsed.found[key];
      if (!address) { rows.push([label, '（未解析）', '需 --adopt/覆盖']); continue; }
      if (key.endsWith('JettonWallet')) {
        rows.push([label, address, '待首次转账时部署（Jetton Wallet 无需预先 active）']);
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
    if (parsed.found.roundController) registry.bindings.teamVaultAcceptsOnly = parsed.found.roundController;
    writeRegistry(registry);
    const missing = Object.entries(labels).filter(([key]) => !parsed.found[key]).map(([, label]) => label);
    if (missing.length) {
      warn('以下地址未解析：' + missing.join('、'));
      detail('可用 --from-log ' + logPath + ' 重试；或用 10/20/30 脚本 adopt 模式分别登记，再执行 65/70 的核对模式。');
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
      if (data.totalSupplyRaw === params.token.totalSupplyRaw && data.mintable === false && data.adminNull === true) ok('Jetton mint-once 校验通过（100 亿、mint 关闭、admin=null）');
      else warn('Jetton 校验未完全通过，请执行 verify_deployment.mjs --online 进一步核对');
    } catch (error) {
      warn('Jetton 复核失败：' + String(error.message || error));
    }
  }
  printNextSteps([
    '下一步：node scripts/40_init_params.mjs --execute --online',
    '然后：node scripts/55_fund_ton.mjs --execute → node scripts/50_fund_vaults.mjs --execute --all',
    '最后：node scripts/60_verify_and_register.mjs --execute → verify_deployment.mjs --online → 80_admin_ops open-round R1',
  ]);
}

process.exit(finish({ 模式: 'EXECUTE', 日志: logFile }));
