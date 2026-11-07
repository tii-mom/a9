#!/usr/bin/env node
/** 55 — TON gas 充值（v11）：RoundController ≥ roundControllerMinTon、keeper 钱包 ≥ keeperMinTon。 */

import { requireConfirm, str } from './lib/cli.mjs';
import { bootstrap, finish, printNextSteps, resolveAddress, resolveWalletAddress, signerWallet } from './lib/step.mjs';
import { commandTemplate, hasCommand, runCommand, substitute } from './lib/toolchain.mjs';
import { getTonBalance } from './lib/ton.mjs';
import { writeRegistry } from './lib/registry.mjs';
import { asBigInt } from './lib/config.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, registry } = bootstrap({
  id: '55',
  title: 'TON gas 充值（RC / keeper）',
  dependsOn: ['roundController'],
});

const signer = signerWallet(params);
const rcOverride = str(args, 'ton-rc') || process.env.A9_TON_RC;
const keeperOverride = str(args, 'ton-keeper') || process.env.A9_TON_KEEPER;
const rcMinTon = Number(rcOverride !== undefined ? rcOverride : params.tonBalances.roundControllerMinTon);
const keeperMinTon = Number(keeperOverride !== undefined ? keeperOverride : params.tonBalances.keeperMinTon);
if (!Number.isFinite(rcMinTon) || rcMinTon <= 0 || !Number.isFinite(keeperMinTon) || keeperMinTon <= 0) {
  fail('--ton-rc / --ton-keeper 必须为正数 TON');
  process.exit(finish());
}
const targets = [
  { key: 'roundController', file: 'round-controller.addr', label: 'RoundController', minTon: rcMinTon },
  { key: 'keeper', wallet: true, label: 'keeper 钱包', minTon: keeperMinTon },
];
const targetAddress = (target) => (target.wallet ? resolveWalletAddress(registry, target.key) || process.env[params.roles.keeper.env] || null : resolveAddress(registry, params, target.key, target.file));
const rows = [];
for (const target of targets) {
  const address = targetAddress(target);
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
detail('用途：RC 每次结算动作（团队转账 / 一笔销毁）约 0.1 TON；keeper 每轮 OpenRound + 24 根 SubmitCandle（单笔附 0.3 TON，多余退回）。');
detail('签名钱包（A9_SIGNER_WALLET）=' + signer + '；fund_ton 的 amountTon 为整数 TON（含 1 TON 缓冲）。');
if (rcOverride !== undefined || keeperOverride !== undefined) detail('gas 目标覆盖：RC ' + rcMinTon + ' TON / keeper ' + keeperMinTon + ' TON（未修改 params 默认值）');
for (const row of rows) detail('dest=' + row[1] + ' value=' + row[3] + ' TON（target）');

if (!execute) {
  info('dry-run：不发送 TON 转账。真实执行：OPS_EXECUTE=1 + OPS_CONFIRM=YES。');
  printNextSteps(['下一步：node scripts/50_fund_vaults.mjs --all（A9 注资与分配）']);
  process.exit(finish({ 模式: 'DRY-RUN' }));
}

if (!hasCommand(params, 'fundTon')) {
  fail('缺少 fundTon 命令模板（检查 config/testnet.params.json toolchain.commands）');
  process.exit(finish());
}
requireConfirm('TON gas 充值（RC / keeper）');

for (const target of targets) {
  const address = targetAddress(target);
  if (!address) { fail(target.label + ' 未登记地址（登记表' + (target.file ? '或 contracts/deploy/' + target.file : ' wallets.' + target.key) + '）'); process.exit(finish()); }
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
  const amountTon = String(Math.ceil(deficit + 1));
  const rendered = substitute(commandTemplate(params, 'fundTon'), {
    contractsDir: params.toolchain.contractsDir,
    signerWallet: signer,
    recipient: address,
    amountTon,
  });
  detail('dest=' + address + ' value=' + amountTon + ' TON（整数，含 1 TON 缓冲） signer=' + signer);
  detail('命令：' + rendered);
  const result = runCommand(rendered, { execute: true });
  if (result.status !== 0) {
    fail(target.label + ' TON 充值失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 300));
    process.exit(finish());
  }
  ok(target.label + ' 充值 ' + amountTon + ' TON（含 1 TON 缓冲）');
}
const note = new Date().toISOString() + ' TON gas top-up executed';
registry.notes = Array.isArray(registry.notes) ? registry.notes : (registry.notes ? [String(registry.notes)] : []);
registry.notes.push(note);
writeRegistry(registry);
printNextSteps(['下一步：node scripts/50_fund_vaults.mjs --execute --all']);
process.exit(finish({ 模式: 'EXECUTE' }));
