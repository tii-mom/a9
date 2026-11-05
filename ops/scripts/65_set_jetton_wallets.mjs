#!/usr/bin/env node
/** 65 — 绑定 Jetton Wallet：SetJettonWallet(RC/TV) + SetJettonWalletCode(RC, 0x5254001B) + 解析 teamWallet 的 canonical 钱包（供 TV InitController 使用）。 */

import { existsSync, readFileSync } from 'node:fs';
import { flag, requireConfirm } from './lib/cli.mjs';
import { resolvePath } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveAddress, resolveContractAddress, resolveWalletAddress, signerWallet } from './lib/step.mjs';
import { commandTemplate, hasCommand, runCommand, substitute } from './lib/toolchain.mjs';
import { setContract, writeRegistry } from './lib/registry.mjs';
import { addressEquals, findJettonWallet } from './lib/ton.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, registry } = bootstrap({
  id: '65',
  title: 'Jetton Wallet 绑定（SetJettonWallet + SetJettonWalletCode + teamWallet canonical 钱包）',
  dependsOn: ['roundController'],
});

const jettonMaster = resolveAddress(registry, params, 'jettonMaster', 'jetton-master.addr');
const roundController = resolveAddress(registry, params, 'roundController', 'round-controller.addr');
const teamVault = resolveAddress(registry, params, 'teamVault', 'team-vault.addr');
const teamWallet = resolveWalletAddress(registry, 'teamWallet') || process.env[params.network.deployer.treasuryAddressEnv] || '';
const signer = signerWallet(params);
const existingRc = resolveContractAddress(registry, 'roundControllerJettonWallet');
const existingTv = resolveContractAddress(registry, 'teamVaultJettonWallet');
const existingTeam = resolveContractAddress(registry, 'teamWalletJettonWallet');

section('绑定计划');
kv('Jetton Master', jettonMaster || '（未登记）');
kv('RoundController', roundController || '（未登记）');
kv('TeamVault', teamVault || '（未登记）');
kv('teamWallet', teamWallet || '（未登记）');
kv('签名钱包（A9_SIGNER_WALLET）', signer);
detail('P0 修复（ReturnExcessesBack）：真实 TEP-74 下退款由**接收方钱包**发出，RC/TV 需要 jetton wallet code 推导接收方 canonical 钱包地址。');
detail('顺序：SetJettonWallet(RC) → SetJettonWallet(TV) → 查询三个 canonical 钱包 → SetJettonWalletCode(RC) → 70_bind_roles（InitController 带 teamWalletJettonWallet）。');
detail('ABI_PENDING（task-27）：SetJettonWalletCode 的调用参数（code cell 传递方式）与 TV InitController 的 teamWalletJettonWallet 字段待 contract-dev 最终确认。');

if (!jettonMaster || !roundController || !teamVault) {
  if (execute) {
    fail('缺少 Jetton Master / RC / TeamVault 地址：先完成整体部署或用 --adopt 登记');
    process.exit(finish());
  }
  warn('合约地址未齐：dry-run 仅打印计划');
  process.exit(finish({ 模式: 'DRY-RUN（未部署）' }));
}
if (flag(args, 'skip-when-set') && existingRc && existingTv && existingTeam) {
  info('三个 canonical 钱包均已登记，跳过 SetJettonWallet（SetJettonWalletCode 是否已写入需用 verify_deployment 核对）');
  process.exit(finish({ 结果: 'ALREADY_SET' }));
}

function loadWalletCode() {
  const file = resolvePath(params.toolchain.buildDir + '/JettonWallet.json');
  if (!existsSync(file)) return { ok: false, reason: '构建产物不存在：' + file };
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const boc64 = json.code_boc64 || json.codeBoc64 || json.code_boc;
    if (!boc64 || typeof boc64 !== 'string') return { ok: false, reason: 'JettonWallet.json 缺少 code_boc64' };
    const bytes = Buffer.from(boc64, 'base64');
    if (!bytes.length) return { ok: false, reason: 'code_boc64 解码为空' };
    return { ok: true, boc64, hash: json.hash || null, file, bytes: bytes.length };
  } catch (error) {
    return { ok: false, reason: '读取 JettonWallet.json 失败：' + String(error.message || error) };
  }
}

const walletCode = loadWalletCode();
section('Jetton Wallet code');
if (walletCode.ok) {
  kv('来源', walletCode.file);
  kv('code hash', walletCode.hash || '（未提供）');
  kv('BOC 大小', walletCode.bytes + ' bytes');
} else if (execute) {
  fail(walletCode.reason + '；SetJettonWalletCode 需要 code cell，先构建 contracts/');
  process.exit(finish());
} else {
  warn(walletCode.reason + '（dry-run 继续）');
}

let rcWallet = existingRc;
let tvWallet = existingTv;
let teamWalletWallet = existingTeam;
if (execute) {
  const resolveCanonical = async (owner, label, existing) => {
    const wallet = await findJettonWallet(params, jettonMaster, owner);
    if (!wallet) throw new Error(label + '：Jetton Master 未返回 canonical Jetton Wallet');
    if (existing && !addressEquals(existing, wallet.address)) {
      throw new Error(label + '：登记表地址 ' + existing + ' 与链上 canonical ' + wallet.address + ' 不一致');
    }
    return wallet.address;
  };
  try {
    rcWallet = await resolveCanonical(roundController, 'RoundController', existingRc);
    tvWallet = await resolveCanonical(teamVault, 'TeamVault', existingTv);
    if (!teamWallet) throw new Error('teamWallet 未登记：部署前必须提供团队收款热钱包地址');
    teamWalletWallet = await resolveCanonical(teamWallet, 'teamWallet', existingTeam);
    kv('RC Jetton Wallet（链上）', rcWallet);
    kv('TV Jetton Wallet（链上）', tvWallet);
    kv('teamWallet Jetton Wallet（链上）', teamWalletWallet);
  } catch (error) {
    fail('无法解析 canonical Jetton Wallet：' + String(error.message || error) + '。禁止盲填，先配置 TONCENTER_API_KEY / 登记 teamWallet');
    process.exit(finish());
  }
} else {
  rcWallet = rcWallet || '<get_wallet_address(RC)>';
  tvWallet = tvWallet || '<get_wallet_address(TV)>';
  teamWalletWallet = teamWalletWallet || '<get_wallet_address(teamWallet)>';
}

const rows = [
  ['RoundController', roundController, rcWallet, 'SetJettonWallet(RC)'],
  ['TeamVault', teamVault, tvWallet, 'SetJettonWallet(TV)'],
  ['teamWallet', teamWallet || '（未登记）', teamWalletWallet, '仅查询（供 InitController 使用）'],
];
table(['owner', '合约/钱包地址', 'canonical Jetton Wallet', '操作'], rows);
detail('SetJettonWalletCode：把 JettonWallet code cell 写入 RC（0x5254001B；仅 currentRoundId==0，admin 一次性）。');

if (!execute) {
  detail('dry-run：不广播 0x52540016 / 0x5254001B。真实执行需要 OPS_EXECUTE=1 且 OPS_CONFIRM=YES。');
  printNextSteps(['下一步：node scripts/70_bind_roles.mjs（InitController 带 teamWalletJettonWallet，不可逆）']);
  process.exit(finish({ 模式: 'DRY-RUN', SetJettonWalletCode: walletCode.ok ? 'ready' : 'missing-code' }));
}

if (!hasCommand(params, 'setJettonWallet') || !hasCommand(params, 'setJettonWalletCode')) {
  fail('缺少 setJettonWallet 或 setJettonWalletCode 命令模板（检查 config/testnet.params.json toolchain.commands）');
  process.exit(finish());
}
requireConfirm('SetJettonWallet(RC/TV) + SetJettonWalletCode（一次性）');

const run = (templateName, vars, label) => {
  const rendered = substitute(commandTemplate(params, templateName), {
    contractsDir: params.toolchain.contractsDir,
    signerWallet: signer,
    ...vars,
  });
  detail('命令：' + rendered);
  const result = runCommand(rendered, { execute: true });
  if (result.status !== 0) {
    fail(label + ' 失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 400));
    process.exit(finish());
  }
};

run('setJettonWallet', { targetContract: roundController, walletAddress: rcWallet }, 'RC.SetJettonWallet');
setContract(registry, 'roundControllerJettonWallet', rcWallet, { note: 'setJettonWallet RC' });
writeRegistry(registry);
ok('RC.SetJettonWallet 已提交：' + rcWallet);

run('setJettonWallet', { targetContract: teamVault, walletAddress: tvWallet }, 'TV.SetJettonWallet');
setContract(registry, 'teamVaultJettonWallet', tvWallet, { note: 'setJettonWallet TV' });
writeRegistry(registry);
ok('TV.SetJettonWallet 已提交：' + tvWallet);

run('setJettonWalletCode', { walletCodeBoc64: walletCode.boc64 }, 'RC.SetJettonWalletCode');
ok('RC.SetJettonWalletCode 已提交（code hash ' + (walletCode.hash || 'unknown') + '）');

setContract(registry, 'teamWalletJettonWallet', teamWalletWallet, { note: 'canonical wallet queried for TV InitController' });
writeRegistry(registry);
ok('已登记 teamWalletJettonWallet：' + teamWalletWallet);

section('复核提示');
detail('用 Acton rpc 核对：RC jettonWalletCode 已设置；TV InitController 参数 teamWalletJettonWallet 等于 ' + teamWalletWallet + '。');
printNextSteps(['下一步：node scripts/70_bind_roles.mjs（InitController 带 teamWalletJettonWallet，不可逆）']);
process.exit(finish({ 模式: 'EXECUTE', RC钱包: rcWallet, TV钱包: tvWallet, teamWallet钱包: teamWalletWallet }));
