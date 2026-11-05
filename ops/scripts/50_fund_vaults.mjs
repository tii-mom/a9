#!/usr/bin/env node
/** 50 — 金库注资与初始分配：70 亿奖励 + 12 亿团队（--all 时含内盘 8 亿 / 流动性 5 亿 / 营销 5 亿）。 */

import { flag, requireConfirm, str } from './lib/cli.mjs';
import { bootstrap, finish, printNextSteps, resolveAddress, resolveWalletAddress, signerWallet } from './lib/step.mjs';
import { commandTemplate, hasCommand, runCommand, substitute } from './lib/toolchain.mjs';
import { recordFunding, setContract, writeRegistry } from './lib/registry.mjs';
import { findJettonWallet } from './lib/ton.mjs';
import { verifyFundingPlan } from './lib/verify.mjs';
import { asBigInt, formatTokens } from './lib/config.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, registry } = bootstrap({
  id: '50',
  title: '金库注资与初始分配',
  dependsOn: ['roles'],
});

const all = flag(args, 'all');
const jettonMaster = resolveAddress(registry, params, 'jettonMaster', 'jetton-master.addr');
const roundController = resolveAddress(registry, params, 'roundController', 'round-controller.addr');
const teamVault = resolveAddress(registry, params, 'teamVault', 'team-vault.addr');
const signer = signerWallet(params);
const treasury = resolveWalletAddress(registry, 'treasury') || process.env[params.network.deployer.treasuryAddressEnv] || '';
const plan = verifyFundingPlan(params, { all });

const OWNER_BY_KIND = {
  roundRewards: { owner: roundController, ownerLabel: 'RoundController（RC Jetton Wallet owner，托管本金+奖励）', walletKey: 'roundControllerJettonWallet' },
  team: { owner: teamVault, ownerLabel: 'TeamVault（其 Jetton Wallet owner）', walletKey: 'teamVaultJettonWallet' },
  marketing: { owner: resolveWalletAddress(registry, 'marketingWallet'), ownerLabel: '营销热钱包', walletKey: null },
  liquidity: { owner: resolveWalletAddress(registry, 'liquidityWallet'), ownerLabel: '流动性热钱包', walletKey: null },
  internalSale: { owner: resolveWalletAddress(registry, 'teamInternalWallet'), ownerLabel: '团队内盘管理钱包（公开可查）', walletKey: null },
};

section('注资计划' + (all ? '（全部分配）' : '（仅奖励 + 团队；加 --all 做完整分配）'));
kv('签名钱包（A9_SIGNER_WALLET）', signer);
kv('treasury（A9 来源）', treasury || '（未提供，脚本会校验 signer 余额）');
kv('Jetton Master', jettonMaster || '（未登记）');
const rows = [];
for (const item of plan) {
  const mapping = OWNER_BY_KIND[item.kind];
  const destHint = mapping.walletKey ? (resolveAddress(registry, params, mapping.walletKey) || '（运行时解析）') : '（运行时解析）';
  rows.push([
    item.label,
    mapping.ownerLabel,
    mapping.owner || '（未登记）',
    formatTokens(item.amountRaw),
    item.amountRaw,
    destHint,
  ]);
  detail('dest=' + (mapping.owner || '<owner?>') + ' toJettonWallet=' + destHint + ' value=' + formatTokens(item.amountRaw) + ' A9 (raw ' + item.amountRaw + ')');
  if (item.kind === 'liquidity') {
    detail('流动性冷启动池：2 亿 A9 + $232,000 USDT（同价 $0.00116，占 5 亿额度 40%，剩余 3 亿后续加池）；本笔仍全额转 5 亿 A9 到 liquidityWallet。');
  }
}
table(['分配', '接收 owner', 'owner 地址', 'A9', 'raw', '目标 Jetton Wallet'], rows);
const totalRaw = plan.reduce((acc, item) => acc + asBigInt(item.amountRaw), 0n);
kv('本次合计', formatTokens(totalRaw.toString()) + ' A9（raw ' + totalRaw + '）');
if (all) {
  const supply = asBigInt(params.token.totalSupplyRaw);
  if (totalRaw === supply) ok('全部分配合计 = 100 亿 A9');
  else fail('全部分配合计不等于 100 亿：' + totalRaw);
} else {
  info('仅注资奖励+团队 = 82 亿；剩余 18 亿按 8/5/5 分配（--all）。');
}
for (const item of plan) {
  const mapping = OWNER_BY_KIND[item.kind];
  if (!mapping.owner) {
    if (execute) { fail(item.label + '：接收 owner 未登记，无法注资'); process.exit(finish()); }
    warn(item.label + '：接收 owner 未登记（dry-run 继续）');
  }
}

if (!execute) {
  section('dry-run 说明');
  detail('将发送 ' + plan.length + ' 笔 fund_jetton（TEP-74 0x0f8a7ea5）：签名钱包=' + signer + '，master=' + (jettonMaster || '<JETTON_MASTER>'));
  detail('真实执行时：先用 TON Center v3 / jetton master get_wallet_address 解析每个 owner 的 Jetton Wallet 地址，');
  detail('再把 signer 钱包中的 A9 按上表逐笔转入对应 Jetton Wallet；每笔记录 funding 并核对余额。');
  detail('注意：TEP-74 转账目标是「接收者的 Jetton Wallet 地址」，不是 owner 合约/钱包地址。');
  detail('执行开关：OPS_EXECUTE=1 + OPS_CONFIRM=YES；真实网络由脚本模板自动带 --net testnet。');
  printNextSteps(['下一步：node scripts/60_verify_and_register.mjs（登记表定稿 + 地址簿）']);
  process.exit(finish({ 模式: 'DRY-RUN', 计划笔数: plan.length, 合计raw: totalRaw.toString() }));
}

section('执行前检查');
if (!jettonMaster || !treasury) {
  fail('缺少 Jetton Master 或 treasury');
  process.exit(finish());
}
if (!hasCommand(params, 'fundVault')) {
  fail('缺少 fundVault 命令模板（检查 config/testnet.params.json toolchain.commands）');
  process.exit(finish());
}
requireConfirm('注资广播（' + plan.length + ' 笔 fund_jetton，不可撤销）');

let treasuryBalance = null;
try {
  const walletOwner = treasury || signer;
  const treasuryWallet = await findJettonWallet(params, jettonMaster, walletOwner);
  treasuryBalance = treasuryWallet && treasuryWallet.balanceRaw ? treasuryWallet.balanceRaw : null;
  if (treasuryBalance === null) warn('无法读取 treasury 的 A9 余额（TON Center v3 不可用），继续执行但每笔转账前需人工核对');
  else kv('treasury A9 余额', formatTokens(treasuryBalance) + ' A9（raw ' + treasuryBalance + '）');
  if (treasuryBalance !== null && asBigInt(treasuryBalance) < totalRaw) {
    fail('treasury A9 余额不足本次注资：' + treasuryBalance + ' < ' + totalRaw);
    process.exit(finish());
  }
} catch (error) {
  warn('余额预检失败：' + String(error.message || error));
}

section('逐笔注资');
for (const item of plan) {
  const mapping = OWNER_BY_KIND[item.kind];
  let recipientWallet = null;
  try {
    const wallet = await findJettonWallet(params, jettonMaster, mapping.owner);
    recipientWallet = wallet && wallet.address;
  } catch (error) {
    warn(item.kind + '：Jetton Wallet 解析失败：' + String(error.message || error));
  }
  if (!recipientWallet) {
    fail(item.kind + '：无法解析接收 Jetton Wallet，终止（避免转错地址）');
    process.exit(finish());
  }
  kv(item.kind + ' →', recipientWallet);
  const rendered = substitute(commandTemplate(params, 'fundVault'), {
    contractsDir: params.toolchain.contractsDir,
    signerWallet: signer,
    jettonMaster,
    recipient: recipientWallet,
    amount: item.amountRaw,
  });
  const result = runCommand(rendered, { execute });
  if (result.status !== 0) {
    fail(item.kind + ' 注资失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 400));
    process.exit(finish());
  }
  recordFunding(registry, {
    kind: item.kind,
    recipient: recipientWallet,
    recipientOwner: mapping.owner,
    amountRaw: item.amountRaw,
    confirmed: true,
    txHash: str(args, 'tx-' + item.kind) || null,
    note: '50_fund_vaults ' + (all ? '--all' : ''),
  });
  if (mapping.walletKey) {
    try { setContract(registry, mapping.walletKey, recipientWallet, { note: '由 50 注资步骤解析登记' }); } catch (error) { warn(String(error.message || error)); }
  }
  ok(item.kind + ' 注资完成：' + formatTokens(item.amountRaw) + ' A9 → ' + recipientWallet);
}
writeRegistry(registry);

section('注资后核对');
for (const item of plan) {
  const mapping = OWNER_BY_KIND[item.kind];
  try {
    const wallet = await findJettonWallet(params, jettonMaster, mapping.owner);
    const balance = wallet && wallet.balanceRaw ? wallet.balanceRaw : null;
    if (balance === null) { warn(item.kind + '：无法读取余额'); continue; }
    if (asBigInt(balance) >= asBigInt(item.amountRaw)) ok(item.kind + ' 余额 >= 注资额（' + formatTokens(balance) + ' A9）');
    else fail(item.kind + ' 余额小于注资额：' + balance + ' < ' + item.amountRaw);
  } catch (error) {
    warn(item.kind + '：余额复核失败：' + String(error.message || error));
  }
}

printNextSteps(['下一步：node scripts/60_verify_and_register.mjs']);
process.exit(finish({ 模式: 'EXECUTE', 笔数: plan.length, 合计raw: totalRaw.toString() }));
