#!/usr/bin/env node
/** 11 — 初始铸造 100 亿 A9 并永久关闭 mint 权限（TEP-74）。 */

import { str } from './lib/cli.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress, resolveWalletAddress } from './lib/step.mjs';
import { commandTemplate, runCommand, substitute } from './lib/toolchain.mjs';
import { getJettonData } from './lib/ton.mjs';
import { writeRegistry } from './lib/registry.mjs';
import { section, kv, ok, fail, warn, info, detail } from './lib/log.mjs';

const { args, execute, params, registry } = bootstrap({
  id: '11',
  title: '初始铸造 100 亿 A9 并关闭 mint',
  dependsOn: ['jettonMaster'],
});

const master = resolveContractAddress(registry, 'jettonMaster');
const treasury = str(args, 'treasury') || resolveWalletAddress(registry, 'treasury') || process.env[params.network.deployer.treasuryAddressEnv] || '';

section('铸造计划');
kv('Jetton Master', master || '（未登记）');
kv('接收地址', treasury || '（未提供）');
kv('铸造数量', params.token.totalSupplyRaw + ' raw（' + params.token.totalSupplyTokens + ' A9）');
kv('铸造后动作', '关闭 mint：admin 置空，total_supply 冻结为 100 亿');
kv('后续分配', '70 亿 → 奖励金库；12 亿 → TeamVault；8 亿 → 团队内盘钱包；5 亿 → 流动性；5 亿 → 营销（合计 100 亿）');

if (!master) {
  if (execute) {
    fail('Jetton Master 未登记：先执行 10_deploy_jetton.mjs，或用 --adopt 登记');
    process.exit(finish());
  }
  warn('Jetton Master 未登记：dry-run 仅打印计划（部署后重跑本步骤）');
  detail('计划：铸造 ' + params.token.totalSupplyRaw + ' raw 到 treasury=' + (treasury || '<TREASURY>') + '，随后关闭 mint。');
  process.exit(finish({ 模式: 'DRY-RUN（未部署）' }));
}
if (!treasury && execute) {
  fail('缺少 treasury 地址（TON_TREASURY_ADDRESS / 登记表 / 位置参数）');
  process.exit(finish());
}

const rendered = substitute(commandTemplate(params, 'mintAndLockJetton'), {
  contractsDir: params.toolchain.contractsDir,
  master,
  treasury,
  totalSupplyRaw: params.token.totalSupplyRaw,
});
section('执行计划');
detail('命令：' + rendered);
detail('安全要求：mint-once（op 0x00000015，金额 1e19）与 admin 置 null 必须同一笔交易完成；二次 mint 报 MintClosed(75)。');

const result = runCommand(rendered, { execute });
if (execute) {
  if (result.status !== 0) {
    fail('铸造/关闭 mint 命令失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 500));
    process.exit(finish());
  }
  ok('铸造命令执行完成（exit 0）');
  try {
    const data = await getJettonData(params, master);
    section('链上复核');
    kv('total_supply', data.totalSupplyRaw);
    kv('mintable', String(data.mintable));
    if (data.totalSupplyRaw === params.token.totalSupplyRaw) ok('total_supply 等于 100 亿 A9');
    else fail('total_supply 与预期不一致：' + data.totalSupplyRaw);
    if (data.mintable === false) ok('mint 权限已关闭');
    else fail('mintable 仍为 true：mint 未关闭，不得进入后续步骤');
  } catch (error) {
    warn('链上复核失败（RPC 不可用？）：' + String(error.message || error));
    warn('手动复核：get_jetton_data 的 total_supply 必须为 ' + params.token.totalSupplyRaw + ' 且 mintable=false');
  }
  registry.notes = registry.notes || [];
  registry.notes.push(new Date().toISOString() + ' jetton mint+lock executed, master=' + master);
  writeRegistry(registry);
} else {
  info('dry-run：未广播铸造交易。');
}

printNextSteps([
  '分步 Jetton 仅用于组建测试；完整测试网部署走整体脚本：node scripts/15_deploy_contracts.mjs（acton deploy-emulation）。',
  'burn_notification 标准 op 为 0x7bdd97de（旧别名 0x7bcdefa0 也接受）；链上对账按 0x7bdd97de 过滤。',
  '分配转账在 50_fund_vaults.mjs --all 统一执行；在此之前不要手工转出代币，避免账本对不上。',
]);
process.exit(finish({ 模式: execute ? 'EXECUTE' : 'DRY-RUN' }));
