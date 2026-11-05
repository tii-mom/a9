#!/usr/bin/env node
/** 65 — SetJettonWallet：给 RC / TeamVault 写入各自的 canonical Jetton Wallet（admin 一次性，opcode 0x52540016）。 */

import { flag } from './lib/cli.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress } from './lib/step.mjs';
import { commandTemplate, runCommand, substitute } from './lib/toolchain.mjs';
import { setContract, writeRegistry } from './lib/registry.mjs';
import { findJettonWallet } from './lib/ton.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, registry } = bootstrap({
  id: '65',
  title: 'SetJettonWallet（RC / TeamVault 绑定 canonical Jetton Wallet）',
  dependsOn: ['roundController'],
});

const jettonMaster = resolveContractAddress(registry, 'jettonMaster');
const roundController = resolveContractAddress(registry, 'roundController');
const teamVault = resolveContractAddress(registry, 'teamVault');
const existingRc = resolveContractAddress(registry, 'roundControllerJettonWallet');
const existingTv = resolveContractAddress(registry, 'teamVaultJettonWallet');

section('绑定计划');
kv('Jetton Master', jettonMaster || '（未登记）');
kv('RoundController', roundController || '（未登记）');
kv('TeamVault', teamVault || '（未登记）');
kv('RC Jetton Wallet（已登记）', existingRc || '（未登记）');
kv('TV Jetton Wallet（已登记）', existingTv || '（未登记）');
detail('规则（contracts/README §5）：两个 setter 都只能 admin 调用、一次性，且必须早于 InitController / 第一轮。');
detail('顺序：先 SetJettonWallet(RC)，再 SetJettonWallet(TV)，最后 70_bind_roles 的 InitController。');

if (!jettonMaster || !roundController || !teamVault) {
  if (execute) {
    fail('缺少 Jetton Master / RC / TeamVault 地址：先完成 10/20/30 部署');
    process.exit(finish());
  }
  warn('合约地址未齐：dry-run 仅打印绑定计划');
  process.exit(finish({ 模式: 'DRY-RUN（未部署）' }));
}
if (flag(args, 'skip-when-set') && existingRc && existingTv) {
  info('两个钱包均已登记，跳过（幂等）');
  process.exit(finish({ 结果: 'ALREADY_SET' }));
}

let rcWallet = existingRc;
let tvWallet = existingTv;
if (execute && (!rcWallet || !tvWallet)) {
  try {
    if (!rcWallet) {
      const wallet = await findJettonWallet(params, jettonMaster, roundController);
      if (!wallet) throw new Error('Jetton Master 未返回 RC 的 Jetton Wallet');
      rcWallet = wallet.address;
    }
    if (!tvWallet) {
      const wallet = await findJettonWallet(params, jettonMaster, teamVault);
      if (!wallet) throw new Error('Jetton Master 未返回 TV 的 Jetton Wallet');
      tvWallet = wallet.address;
    }
    kv('RC Jetton Wallet（解析）', rcWallet);
    kv('TV Jetton Wallet（解析）', tvWallet);
  } catch (error) {
    fail('无法解析 Jetton Wallet 地址：' + String(error.message || error) + '。禁止盲填，先配置 TONCENTER_API_KEY 或手工 --rc-wallet/--tv-wallet');
    process.exit(finish());
  }
}
if (!execute) {
  rcWallet = rcWallet || '<derive from get_wallet_address(RC)>';
  tvWallet = tvWallet || '<derive from get_wallet_address(TV)>';
}

const rows = [
  ['RoundController', roundController, rcWallet, 'SetJettonWallet(RC → RC Jetton Wallet)'],
  ['TeamVault', teamVault, tvWallet, 'SetJettonWallet(TV → TV Jetton Wallet)'],
];
table(['合约', '合约地址', 'Jetton Wallet', '操作'], rows);

if (!execute) {
  detail('dry-run：不发送 0x52540016。真实执行需要 OPS_EXECUTE=1 且 OPS_CONFIRM=YES。');
  printNextSteps(['下一步：node scripts/70_bind_roles.mjs（InitController，不可逆）']);
  process.exit(finish({ 模式: 'DRY-RUN' }));
}

const run = (targetContract, walletAddress) => {
  const rendered = substitute(commandTemplate(params, 'setJettonWallet'), {
    contractsDir: params.toolchain.contractsDir,
    targetContract,
    walletAddress,
  });
  detail('命令：' + rendered);
  const result = runCommand(rendered, { execute: true });
  if (result.status !== 0) {
    fail(targetContract + ' SetJettonWallet 失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 400));
    process.exit(finish());
  }
};

run(roundController, rcWallet);
setContract(registry, 'roundControllerJettonWallet', rcWallet, { note: 'setJettonWallet RC' });
writeRegistry(registry);
ok('RC.SetJettonWallet 已提交：' + rcWallet);

run(teamVault, tvWallet);
setContract(registry, 'teamVaultJettonWallet', tvWallet, { note: 'setJettonWallet TV' });
writeRegistry(registry);
ok('TV.SetJettonWallet 已提交：' + tvWallet);

section('复核提示');
detail('用 Acton rpc 读取 get_protocol_config().stakingJettonWallet 与 get_team_vault_state().jettonWallet，确认等于上表地址。');
printNextSteps(['下一步：node scripts/70_bind_roles.mjs（InitController，不可逆）']);
process.exit(finish({ 模式: 'EXECUTE', RC钱包: rcWallet, TV钱包: tvWallet }));
