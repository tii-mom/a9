#!/usr/bin/env node
/** 65 — Jetton Wallet 地址登记（整体部署路径专用）：查询 RC/TV/teamWallet 的 canonical 钱包并登记。
 *
 * P0 修复（ReturnExcessesBack / teamWallet release ack）的两笔一次性配置
 * SetJettonWalletCode(RC,0x5254001B) 与 SetTeamWalletJettonWallet(TV,0x5254001C)
 * 已由 deploy-emulation 内置完成；admin_op 不提供这两个 op，因此 stepwise 广播 BLOCKED。
 * 测试网唯一推荐路径：15 整体部署 → 65 --query-only（本脚本）→ 70 InitController → 55/50 → 60 → 90。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { flag } from './lib/cli.mjs';
import { networkName, resolvePath } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveAddress, resolveContractAddress, resolveWalletAddress, signerWallet } from './lib/step.mjs';
import { setContract, writeRegistry } from './lib/registry.mjs';
import { addressEquals, findJettonWallet } from './lib/ton.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, registry } = bootstrap({
  id: '65',
  title: 'Jetton Wallet 地址登记（整体部署路径；stepwise 广播 BLOCKED）',
  dependsOn: [],
});

const queryOnly = flag(args, 'query-only');
const jettonMaster = resolveAddress(registry, params, 'jettonMaster', 'jetton-master.addr');
const roundController = resolveAddress(registry, params, 'roundController', 'round-controller.addr');
const teamVault = resolveAddress(registry, params, 'teamVault', 'team-vault.addr');
const teamWallet = resolveWalletAddress(registry, 'teamWallet') || process.env[params.network.deployer.treasuryAddressEnv] || '';
const signer = signerWallet(params);
const existingRc = resolveContractAddress(registry, 'roundControllerJettonWallet');
const existingTv = resolveContractAddress(registry, 'teamVaultJettonWallet');
const existingTeam = resolveContractAddress(registry, 'teamWalletJettonWallet');

section('Jetton Wallet 地址登记');
kv('Jetton Master', jettonMaster || '（未登记）');
kv('RoundController', roundController || '（未登记）');
kv('TeamVault', teamVault || '（未登记）');
kv('teamWallet', teamWallet || '（未登记）');
kv('运行模式', execute ? (queryOnly ? 'EXECUTE（--query-only）' : 'EXECUTE（stepwise，BLOCKED）') : 'DRY-RUN');
kv('签名钱包', signer);
detail('P0 修复：SetJettonWalletCode(RC,0x5254001B) 与 SetTeamWalletJettonWallet(TV,0x5254001C) 由 15 整体 deploy-emulation 内置写入；本脚本只查询并登记三个 canonical 地址。');
detail('stepwise 65 广播 BLOCKED：admin_op 未实现 set-jetton-wallet-code / set-team-wallet-jetton-wallet（contract-dev 确认不补）。');

if (!jettonMaster || !roundController || !teamVault) {
  if (execute) { fail('缺少 Jetton Master / RC / TV 地址：先完成 15 整体部署或用 --adopt 登记'); process.exit(finish()); }
  warn('合约地址未齐：dry-run 仅打印计划');
  process.exit(finish({ 模式: 'DRY-RUN（未部署）' }));
}

function loadWalletCode() {
  const file = resolvePath(params.toolchain.buildDir + '/JettonWallet.json');
  if (!existsSync(file)) return { ok: false, reason: '构建产物不存在：' + file };
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const boc64 = json.code_boc64 || json.codeBoc64;
    const hash = json.hash || null;
    if (!boc64) return { ok: false, reason: 'JettonWallet.json 缺少 code_boc64' };
    const bytes = Buffer.from(boc64, 'base64');
    return { ok: bytes.length > 0, boc64, hash, file, bytes: bytes.length };
  } catch (error) {
    return { ok: false, reason: '读取 JettonWallet.json 失败：' + String(error.message || error) };
  }
}

const walletCode = loadWalletCode();
section('Jetton Wallet code（供 RC.SetJettonWalletCode / get_jetton_wallet_code_hash 校验）');
if (walletCode.ok) {
  kv('来源', walletCode.file);
  kv('code hash', walletCode.hash || '（未提供）');
  kv('BOC 大小', walletCode.bytes + ' bytes');
} else {
  warn(walletCode.reason + '（verify_deployment 的 code hash 校验会 FAIL）');
}

// stepwise 广播在查询前就拦截，避免无谓网络请求。
if (execute && !queryOnly) {
  fail('stepwise 65 广播 BLOCKED：admin_op 未提供 set-jetton-wallet-code / set-team-wallet-jetton-wallet。');
  info('测试网唯一推荐路径：15 deploy-emulation（已内置两笔 wiring）→ 65 --query-only → 70 → 55 → 50 → 60 → 90。');
  process.exit(finish({ 结果: 'BLOCKED_STEPWISE', queryOnly: false }));
}

let rcWallet = existingRc;
let tvWallet = existingTv;
let teamWalletWallet = existingTeam;
if (execute) {
  const resolveViaActon = (owner) => {
    const scriptPath = resolvePath('ops/scripts/tolk/query_one_wallet.tolk');
    const command = 'export PATH=$HOME/.acton/bin:$PATH; cd ' + params.toolchain.contractsDir + ' && acton script --manifest-path Acton.toml --net ' + networkName() + ' ' + scriptPath + ' ' + jettonMaster + ' ' + owner;
    const result = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 60000 });
    const match = String(result.stdout || '').match(/JETTON_WALLET=(\S+)/);
    return match ? match[1] : null;
  };
  const resolveCanonical = async (owner, label, existing) => {
    const wallet = await findJettonWallet(params, jettonMaster, owner);
    let resolved = wallet && wallet.address;
    if (!resolved) {
      warn(label + '：TON Center v3 未索引，改用 JettonMaster.get_wallet_address 直接查询');
      resolved = resolveViaActon(owner);
    }
    if (!resolved) throw new Error(label + '：Jetton Master 未返回 canonical Jetton Wallet');
    if (existing && !addressEquals(existing, resolved)) {
      throw new Error(label + '：登记表地址 ' + existing + ' 与链上 canonical ' + resolved + ' 不一致');
    }
    return resolved;
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
    fail('无法解析 canonical Jetton Wallet：' + String(error.message || error) + '。先配置 TONCENTER_API_KEY / 登记 teamWallet');
    process.exit(finish());
  }
} else {
  rcWallet = rcWallet || '<get_wallet_address(RC)>';
  tvWallet = tvWallet || '<get_wallet_address(TV)>';
  teamWalletWallet = teamWalletWallet || '<get_wallet_address(teamWallet)>';
}

const rows = [
  ['RoundController', roundController, rcWallet, '登记 roundControllerJettonWallet'],
  ['TeamVault', teamVault, tvWallet, '登记 teamVaultJettonWallet'],
  ['teamWallet', teamWallet || '（未登记）', teamWalletWallet, '登记 teamWalletJettonWallet（TV 已由整体部署 wiring 写入）'],
];
table(['owner', '合约/钱包地址', 'canonical Jetton Wallet', '操作'], rows);
detail('顺序（整体部署已内置）：SetJettonWallet(RC/TV) → SetJettonWalletCode(RC,0x5254001B) → SetTeamWalletJettonWallet(TV,0x5254001C) → 70 InitController（不带 teamWallet 参数）。');

if (!execute) {
  detail('dry-run：不发交易；真实执行只支持 --query-only（OPS_EXECUTE=1）。');
  detail('stepwise 65 广播 BLOCKED：admin_op 未实现 set-jetton-wallet-code / set-team-wallet-jetton-wallet。');
  printNextSteps(['整体路径：node scripts/15_deploy_contracts.mjs --execute → node scripts/65_set_jetton_wallets.mjs --execute --query-only → node scripts/70_bind_roles.mjs --execute']);
  process.exit(finish({ 模式: 'DRY-RUN', 结果: 'QUERY_ONLY_RECOMMENDED', SetJettonWalletCode: walletCode.ok ? 'wired-by-15' : 'missing-code' }));
}

setContract(registry, 'roundControllerJettonWallet', rcWallet, { note: 'query-only 登记' });
setContract(registry, 'teamVaultJettonWallet', tvWallet, { note: 'query-only 登记' });
setContract(registry, 'teamWalletJettonWallet', teamWalletWallet, { note: 'query-only 登记（TV wiring 由整体部署完成）' });
writeRegistry(registry);
ok('三个 canonical Jetton Wallet 已登记：' + rcWallet + ' / ' + tvWallet + ' / ' + teamWalletWallet);
printNextSteps(['下一步：node scripts/70_bind_roles.mjs --execute（InitController，不带 teamWallet 参数）']);
process.exit(finish({ 模式: 'EXECUTE（query-only）', RC钱包: rcWallet, TV钱包: tvWallet, teamWallet钱包: teamWalletWallet }));
