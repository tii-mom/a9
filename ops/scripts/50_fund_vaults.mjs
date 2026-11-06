#!/usr/bin/env node
/** 50 — 金库注资与初始分配：70 亿奖励 + 12 亿团队（--all 时含内盘 8 亿 / 流动性 5 亿 / 营销 5 亿）。 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { flag, requireConfirm, str } from './lib/cli.mjs';
import { bootstrap, finish, printNextSteps, resolveAddress, resolveWalletAddress, signerWallet } from './lib/step.mjs';
import { commandTemplate, hasCommand, runCommand, substitute } from './lib/toolchain.mjs';
import { recordFunding, setContract, writeRegistry } from './lib/registry.mjs';
import { findJettonWallet, getTonBalance, runGetMethod, stackItemToBigInt } from './lib/ton.mjs';
import { verifyFundingPlan } from './lib/verify.mjs';
import { RECORDS_DIR, asBigInt, formatTokens, readJSON } from './lib/config.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, registry } = bootstrap({
  id: '50',
  title: '金库注资与初始分配',
  dependsOn: ['roles'],
});

const all = flag(args, 'all');
const probe = flag(args, 'probe');
const resume = flag(args, 'resume');
const jettonMaster = resolveAddress(registry, params, 'jettonMaster', 'jetton-master.addr');
const roundController = resolveAddress(registry, params, 'roundController', 'round-controller.addr');
const teamVault = resolveAddress(registry, params, 'teamVault', 'team-vault.addr');
const signer = signerWallet(params);
const treasury = resolveWalletAddress(registry, 'treasury') || process.env[params.network.deployer.treasuryAddressEnv] || '';

function resolveSignerAddress(name) {
  if (/^[A-Za-z0-9_-]{48}$/.test(name) || /^-?[0-9]+:[0-9a-fA-F]{64}$/.test(name)) return name;
  const result = spawnSync('bash', ['-lc', 'export PATH=$HOME/.acton/bin:$PATH; cd ' + params.toolchain.contractsDir + ' && acton wallet list'], { encoding: 'utf8', timeout: 30000 });
  const line = String(result.stdout || '').split(String.fromCharCode(10)).find((item) => item.trim().startsWith(name + ' '));
  const match = line && line.match(/([A-Za-z0-9_-]{48})/);
  return match ? match[1] : name;
}
const signerAddress = resolveSignerAddress(signer);
const plan = verifyFundingPlan(params, { all });
const ORDER = ['roundRewards', 'team', 'internalSale', 'liquidity', 'marketing'];
plan.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
const recipientsPath = RECORDS_DIR + '/funding-recipients.json';
const recipients = existsSync(recipientsPath) ? readJSON(recipientsPath) : null;

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
  detail('执行开关：OPS_EXECUTE=1 + OPS_CONFIRM=YES；真实网络由参数文件 network.net / OPS_NETWORK 决定（testnet 或 mainnet），脚本模板不再硬编码。');
  printNextSteps(['下一步：node scripts/60_verify_and_register.mjs（登记表定稿 + 地址簿）']);
  process.exit(finish({ 模式: 'DRY-RUN', 计划笔数: plan.length, 合计raw: totalRaw.toString() }));
}

section('执行前检查');
if (!jettonMaster) {
  fail('缺少 Jetton Master');
  process.exit(finish());
}
if (recipients) kv('recipients 清单', recipientsPath + '（get_wallet_address 结果）');
if (!hasCommand(params, 'fundVault')) {
  fail('缺少 fundVault 命令模板（检查 config/testnet.params.json toolchain.commands）');
  process.exit(finish());
}
if (!probe) {
  fail('强制防呆流程：真实注资必须加 --probe（先发 1 A9 试探，确认到账后才发大额）');
  process.exit(finish());
}
requireConfirm('注资广播（' + plan.length + ' 笔 fund_jetton，首笔 1 A9 试探，不可撤销）');

let treasuryBalance = null;
try {
  const walletOwner = signerAddress;
  const treasuryWallet = await findJettonWallet(params, jettonMaster, walletOwner);
  treasuryBalance = treasuryWallet && treasuryWallet.balanceRaw ? treasuryWallet.balanceRaw : null;
  if (treasuryBalance === null) warn('无法读取 treasury 的 A9 余额（TON Center v3 不可用），继续执行但每笔转账前需人工核对');
  else kv('treasury A9 余额', formatTokens(treasuryBalance) + ' A9（raw ' + treasuryBalance + '）');
  if (treasuryBalance !== null && asBigInt(treasuryBalance) < totalRaw) {
    if (resume) warn('signer A9 余额 < 全额（resume 模式继续，逐笔仍由合约脚本校验余额）：' + treasuryBalance + ' < ' + totalRaw);
    else {
      fail('signer A9 余额不足本次注资：' + treasuryBalance + ' < ' + totalRaw);
      process.exit(finish());
    }
  }
} catch (error) {
  warn('余额预检失败：' + String(error.message || error));
}

section('逐笔注资');
const PROBE_RAW = 1_000_000_000n; // 1 A9 小额试探（P0 安全流程）
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function jettonBalance(walletAddress) {
  try {
    const data = await runGetMethod(params, walletAddress, 'get_wallet_data');
    return stackItemToBigInt((data.stack || [])[0]);
  } catch (error) {
    return null; // 钱包尚未部署
  }
}

async function waitForBalance(walletAddress, predicate, label) {
  let observed = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    await sleep(2500);
    observed = await jettonBalance(walletAddress);
    if (observed !== null && predicate(observed)) return observed;
  }
  fail(label + '：等待余额核对超时（最后 ' + (observed === null ? '未读到' : observed.toString()) + '）');
  process.exit(finish());
}

async function sendFund(item, mapping, recipientWallet, amountRaw, label) {
  // TEP-74 fund_jetton 的位置参数是「接收 owner」，由发送方钱包内部用
  // calcDeployedJettonWallet(recipient, master, code) 推导目标钱包；传钱包地址会二次推导到错误地址。
  const rendered = substitute(commandTemplate(params, 'fundVault'), {
    contractsDir: params.toolchain.contractsDir,
    signerWallet: signer,
    jettonMaster,
    recipient: mapping.owner,
    amount: amountRaw.toString(),
  });
  info(label + '：' + formatTokens(amountRaw.toString()) + ' A9 → owner ' + mapping.owner + '（期望钱包 ' + recipientWallet + '）');
  const result = runCommand(rendered, { execute });
  if (result.status !== 0) {
    fail(item.kind + ' 注资失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 500));
    process.exit(finish());
  }
  const txHashes = String(result.stdout || '').split(String.fromCharCode(10)).filter((line) => line.includes('hash =')).map((line) => line.trim());
  return txHashes;
}

for (let index = 0; index < plan.length; index++) {
  const item = plan[index];
  const mapping = OWNER_BY_KIND[item.kind];
  const amountRaw = asBigInt(item.amountRaw);
  let recipientWallet = null;
  try {
    recipientWallet = recipients && recipients[item.kind] ? recipients[item.kind] : null;
    if (!recipientWallet) {
      const wallet = await findJettonWallet(params, jettonMaster, mapping.owner);
      recipientWallet = wallet && wallet.address;
    }
  } catch (error) {
    warn(item.kind + '：Jetton Wallet 解析失败：' + String(error.message || error));
  }
  if (!recipientWallet) {
    fail(item.kind + '：无法解析接收 Jetton Wallet，终止（避免转错地址）');
    process.exit(finish());
  }
  kv(item.kind + ' → owner', mapping.owner);
  kv(item.kind + ' → jetton wallet', recipientWallet);

  const walletInfo = await getTonBalance(params, recipientWallet).catch(() => ({ state: 'unknown' }));
  const isActive = walletInfo.state === 'active';
  const currentBalance = isActive ? ((await jettonBalance(recipientWallet)) ?? 0n) : 0n;
  let txHashes = [];
  if (resume && currentBalance >= amountRaw) {
    info(item.kind + '：resume 检测到余额已达标（' + formatTokens(currentBalance.toString()) + ' A9），跳过转账');
    if (!registry.funding.some((entry) => entry.kind === item.kind && entry.confirmed)) {
      recordFunding(registry, { kind: item.kind, recipient: recipientWallet, recipientOwner: mapping.owner, amountRaw: item.amountRaw, confirmed: true, txHash: null, note: '50_fund_vaults resume 识别已到账' });
      writeRegistry(registry);
    }
    if (mapping.walletKey) {
      try { setContract(registry, mapping.walletKey, recipientWallet, { note: '由 50 resume 核对登记' }); } catch (error) { warn(String(error.message || error)); }
    }
    continue;
  }
  const preBalance = currentBalance;
  if (index === 0) {
    if (amountRaw <= PROBE_RAW) {
      fail('第一笔金额必须大于 1 A9 才能做小额试探');
      process.exit(finish());
    }
    section('第一笔 1 A9 小额试探（强制）');
    const probeTxs = await sendFund(item, mapping, recipientWallet, PROBE_RAW, 'probe');
    txHashes = txHashes.concat(probeTxs);
    const probed = await waitForBalance(recipientWallet, (balance) => balance >= PROBE_RAW, '1 A9 试探');
    ok('小额试探到账：' + formatTokens(probed.toString()) + ' A9（raw ' + probed + '）');
    if (probed !== PROBE_RAW) {
      fail('小额试探余额异常：期望 ' + PROBE_RAW + '，实际 ' + probed + '；终止大额转账');
      process.exit(finish());
    }
    const remaining = amountRaw - PROBE_RAW;
    if (remaining > 0n) {
      const restTxs = await sendFund(item, mapping, recipientWallet, remaining, 'remainder');
      txHashes = txHashes.concat(restTxs);
    }
    const finalBalance = await waitForBalance(recipientWallet, (balance) => balance >= amountRaw, item.kind);
    if (finalBalance !== amountRaw) {
      fail(item.kind + '：最终余额 ' + finalBalance + ' != 目标 ' + amountRaw + '；终止');
      process.exit(finish());
    }
    ok(item.kind + ' 最终余额 = ' + formatTokens(finalBalance.toString()) + ' A9（精确匹配）');
  } else {
    txHashes = await sendFund(item, mapping, recipientWallet, amountRaw, item.kind);
    const expected = preBalance + amountRaw;
    const finalBalance = await waitForBalance(recipientWallet, (balance) => balance >= expected, item.kind);
    if (finalBalance !== expected) {
      fail(item.kind + '：余额增量异常，期望 ' + expected + '，实际 ' + finalBalance + '；终止');
      process.exit(finish());
    }
    ok(item.kind + ' 余额增量 = ' + formatTokens(amountRaw.toString()) + ' A9（' + formatTokens(finalBalance.toString()) + '）');
  }
  recordFunding(registry, {
    kind: item.kind,
    recipient: recipientWallet,
    recipientOwner: mapping.owner,
    amountRaw: item.amountRaw,
    confirmed: true,
    txHash: txHashes[txHashes.length - 1] || str(args, 'tx-' + item.kind) || null,
    note: '50_fund_vaults ' + (all ? '--all' : '') + (index === 0 ? '；首笔 1 A9 试探' : ''),
  });
  if (mapping.walletKey) {
    try { setContract(registry, mapping.walletKey, recipientWallet, { note: '由 50 注资步骤解析登记' }); } catch (error) { warn(String(error.message || error)); }
  }
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
