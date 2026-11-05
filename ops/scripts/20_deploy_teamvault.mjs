#!/usr/bin/env node
/** 20 — 部署 TeamVault（持有 12 亿；controller 部署时为 null，由 70 步骤一次性 InitController）。 */

import { str } from './lib/cli.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress, resolveWalletAddress } from './lib/step.mjs';
import { commandTemplate, extractAddress, runCommand, substitute } from './lib/toolchain.mjs';
import { setContract, writeRegistry } from './lib/registry.mjs';
import { validateTestnetAddress } from './lib/ton.mjs';
import { section, kv, ok, fail, warn, info, detail } from './lib/log.mjs';

const { args, execute, params, registry } = bootstrap({
  id: '20',
  title: '部署 TeamVault（团队 12 亿托管）',
  dependsOn: ['jettonMint'],
});

const adminOwner = str(args, 'admin') || resolveWalletAddress(registry, 'adminOwner') || process.env.TON_ADMIN_OWNER_ADDRESS || '';
const teamWallet = str(args, 'team-wallet') || resolveWalletAddress(registry, 'teamWallet') || '';
const adopt = str(args, 'adopt');
const existing = resolveContractAddress(registry, 'teamVault');

section('部署参数');
kv('admin', adminOwner || '（未提供）');
kv('controller', 'null（部署后再 InitController，防止部署期被伪造指令）');
kv('teamWallet', teamWallet || '（未提供）');
kv('teamRoundRaw', params.rounds.teamRoundRaw + ' raw（1.2 亿 A9）');
kv('托管总量', params.rounds.teamPoolRaw + ' raw（12 亿 A9）');
kv('指令白名单', 'ReleaseTeamQuota(0x5254000C) / BurnTeamQuota(0x5254000D)，仅 RoundController');

if (adopt) {
  const validation = validateTestnetAddress(adopt, 'teamVault');
  if (!validation.ok) { fail(validation.message); process.exit(finish()); }
  setContract(registry, 'teamVault', adopt, { note: 'adopt 手工登记' });
  writeRegistry(registry);
  ok('已登记 TeamVault：' + adopt);
  process.exit(finish({ 地址: adopt }));
}
if (existing) {
  info('TeamVault 已登记：' + existing);
  process.exit(finish({ 地址: existing }));
}
if (!adminOwner || !teamWallet) {
  const message = '缺少 admin 或 teamWallet：admin 来自 TON_ADMIN_OWNER_ADDRESS/登记表，teamWallet 由项目方部署前提供并登记';
  if (execute) { fail(message); process.exit(finish()); }
  warn(message + '（dry-run 继续）');
}

const rendered = substitute(commandTemplate(params, 'deployTeamVault'), {
  contractsDir: params.toolchain.contractsDir,
  adminOwner,
  teamWallet,
  teamRoundRaw: params.rounds.teamRoundRaw,
});
section('执行计划');
detail('命令：' + rendered);
detail('部署后注释：contracts/contracts/TeamVault.tolk 要求 controller 为 null 部署，再由 admin 调 InitController 一次。');

const result = runCommand(rendered, { execute });
if (execute) {
  if (result.status !== 0) {
    fail('部署命令失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 500));
    process.exit(finish());
  }
  const address = str(args, 'address') || extractAddress(result.stdout) || extractAddress(result.stderr);
  if (!address) {
    fail('未能从输出解析 TeamVault 地址；请用 --adopt <address> 登记');
    process.exit(finish());
  }
  setContract(registry, 'teamVault', address, { note: 'Acton 部署输出解析，controller=null' });
  writeRegistry(registry);
  ok('TeamVault 已部署并登记：' + address);
}

printNextSteps([
  '下一步：node scripts/30_deploy_round_controller.mjs',
  'TeamVault 的 Jetton Wallet 在注资时由 50_fund_vaults.mjs 解析/登记（owner = TeamVault）。',
]);
process.exit(finish({ 模式: execute ? 'EXECUTE' : 'DRY-RUN' }));
