#!/usr/bin/env node
/** 55 — TON gas 充值：RC ≥20 TON、TeamVault ≥10 TON（contracts/deploy/params.testnet.json）。 */

import { bootstrap, finish, printNextSteps, resolveContractAddress } from './lib/step.mjs';
import { commandTemplate, runCommand, substitute } from './lib/toolchain.mjs';
import { getTonBalance } from './lib/ton.mjs';
import { writeRegistry } from './lib/registry.mjs';
import { asBigInt } from './lib/config.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { execute, params, registry } = bootstrap({
  id: '55',
  title: 'TON gas 充值（RC / TeamVault）',
  dependsOn: ['roles'],
});

const targets = [
  { key: 'roundController', label: 'RoundController', minTon: Number(params.tonBalances.roundControllerMinTon) },
  { key: 'teamVault', label: 'TeamVault', minTon: Number(params.tonBalances.teamVaultMinTon) },
];
const rows = [];
for (const target of targets) {
  const address = resolveContractAddress(registry, target.key);
  let balanceTon = null;
  if (address && execute) {
    try {
      const balance = await getTonBalance(params, address);
      balanceTon = Number(BigInt(balance.balanceNano)) / 1e9;
    } catch (error) {
      warn(target.label + ' 余额读取失败：' + String(error.message || error));
    }
  }
  const deficit = balanceTon === null ? target.minTon : Math.max(0, target.minTon - balanceTon);
  rows.push([target.label, address || '（未登记）', balanceTon === null ? '?' : balanceTon.toFixed(2), target.minTon, deficit.toFixed(2)]);
}
section('TON 余额计划');
table(['合约', '地址', '当前 TON', '目标 TON', '需补 TON'], rows);
detail('用途：RC 每条跨合约指令约 0.05 TON；TeamVault 需支付 release/burn 与 ack。');

if (!execute) {
  info('dry-run：不发送 TON 转账。真实执行需要 OPS_EXECUTE=1。');
  printNextSteps(['下一步：node scripts/50_fund_vaults.mjs --all（A9 注资与分配）']);
  process.exit(finish({ 模式: 'DRY-RUN' }));
}

for (const target of targets) {
  const address = resolveContractAddress(registry, target.key);
  if (!address) { fail(target.label + ' 未登记地址'); process.exit(finish()); }
  let balanceTon = null;
  try {
    const balance = await getTonBalance(params, address);
    balanceTon = Number(BigInt(balance.balanceNano)) / 1e9;
  } catch (error) {
    fail(target.label + ' 余额读取失败，终止（避免重复充值）：' + String(error.message || error));
    process.exit(finish());
  }
  const deficit = target.minTon - balanceTon;
  if (deficit <= 0) { info(target.label + ' 余额充足（' + balanceTon.toFixed(2) + ' TON），跳过'); continue; }
  const amountTon = (Math.ceil((deficit + 1) * 100) / 100).toFixed(2);
  const rendered = substitute(commandTemplate(params, 'fundTon'), {
    contractsDir: params.toolchain.contractsDir,
    recipient: address,
    amountTon,
  });
  detail('命令：' + rendered);
  const result = runCommand(rendered, { execute: true });
  if (result.status !== 0) {
    fail(target.label + ' TON 充值失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 300));
    process.exit(finish());
  }
  ok(target.label + ' 充值 ' + amountTon + ' TON（含 1 TON 缓冲）');
}
registry.notes = registry.notes || [];
registry.notes.push(new Date().toISOString() + ' TON gas top-up executed');
writeRegistry(registry);
printNextSteps(['下一步：node scripts/50_fund_vaults.mjs --execute --all']);
process.exit(finish({ 模式: 'EXECUTE' }));
