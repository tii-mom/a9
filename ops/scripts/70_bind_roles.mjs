#!/usr/bin/env node
/** 70 — 角色绑定：TeamVault.InitController(roundController) 一次性调用，并记录绑定关系。 */

import { requireConfirm } from './lib/cli.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress } from './lib/step.mjs';
import { commandTemplate, runCommand, substitute } from './lib/toolchain.mjs';
import { writeRegistry } from './lib/registry.mjs';
import { addressEquals } from './lib/ton.mjs';
import { section, kv, ok, fail, warn, info, detail } from './lib/log.mjs';

const { execute, params, registry } = bootstrap({
  id: '70',
  title: '角色绑定：TeamVault.InitController → RoundController',
  dependsOn: ['params'],
});

const teamVault = resolveContractAddress(registry, 'teamVault');
const controller = resolveContractAddress(registry, 'roundController');
const registeredBinding = registry.bindings.teamVaultAcceptsOnly;

section('绑定检查');
kv('TeamVault', teamVault || '（未登记）');
kv('RoundController', controller || '（未登记）');
kv('当前绑定记录', registeredBinding || '（未绑定）');
kv('调用者', 'TeamVault.admin（部署者/硬件钱包），只能调用一次');

if (!teamVault || !controller) {
  fail('缺少 TeamVault 或 RoundController 地址：先完成 20/30 部署，或用 --adopt 登记');
  process.exit(finish());
}
if (registeredBinding && !addressEquals(registeredBinding, controller)) {
  fail('登记表显示 TeamVault 已绑定到其他地址：' + registeredBinding + '（链上不可逆，立刻停止并核查）');
  process.exit(finish());
}
if (registeredBinding && addressEquals(registeredBinding, controller)) {
  info('登记表显示已完成绑定，跳过（幂等）');
  process.exit(finish({ 绑定: '已完成' }));
}

section('不可逆操作确认');
detail('InitController 只能由 TeamVault.admin 调用一次；controller 一旦写入不可更改。');
detail('执行前必须双人核对：TeamVault 地址、RoundController 地址、admin 钱包来源。');
if (execute) requireConfirm('TeamVault.InitController（不可逆绑定）');

const rendered = substitute(commandTemplate(params, 'bindRoles'), {
  contractsDir: params.toolchain.contractsDir,
  teamVault,
  roundController: controller,
});
section('执行计划');
detail('命令：' + rendered);

const result = runCommand(rendered, { execute });
if (execute && result.status !== 0) {
  fail('InitController 失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 500));
  process.exit(finish());
}
if (execute) {
  registry.bindings.teamVaultAcceptsOnly = controller;
  writeRegistry(registry);
  ok('绑定记录已写入登记表：TeamVault.controller = RoundController');
  detail('建议立即用 acton rpc 读取 TeamVault get_config 复核 controller 地址，并截图归档。');
} else {
  info('dry-run：未发送 InitController。真实执行需要 OPS_EXECUTE=1 且 OPS_CONFIRM=YES。');
}

printNextSteps([
  '下一步：node scripts/50_fund_vaults.mjs --all（注资 70 亿 + 12 亿 + 分配 8/5/5 亿）',
  '注资前确认 TeamVault.controller 已是 RoundController；失败销毁团队额度依赖该绑定。',
]);
process.exit(finish({ 模式: execute ? 'EXECUTE' : 'DRY-RUN', TeamVault: teamVault, RoundController: controller }));
