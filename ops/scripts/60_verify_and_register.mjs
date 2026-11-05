#!/usr/bin/env node
/** 60 — 登记表定稿：写入配置哈希、验证地址/资金、生成地址簿（对外/对内两版说明）。 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RECORDS_DIR, formatTokens, writeJSON } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress } from './lib/step.mjs';
import { registryDigest, writeRegistry } from './lib/registry.mjs';
import { explorerUrl } from './lib/ton.mjs';
import { CHECK_STATUS, verifyAllocationInvariant, verifyFundingPlan, verifyLadder, verifyRegistryStructure } from './lib/verify.mjs';
import { section, kv, ok, fail, warn, info, table } from './lib/log.mjs';

const { execute, params, digest, registry } = bootstrap({
  id: '60',
  title: '登记表定稿与地址簿生成',
  dependsOn: ['funding'],
});

registry.paramsDigest = digest;
registry.configVersion = Number(params.meta.configVersion);
const persist = execute;

section('不变量复核');
const allocation = verifyAllocationInvariant(params);
if (allocation.ok) ok('分配总和 = 100 亿 A9（raw ' + allocation.sumRaw + '）');
else fail('分配总和不等于 100 亿');
const ladder = verifyLadder(params);
if (ladder.ok) ok('阶梯参考价 1..10 与 P0 × 2^tier 一致');
else fail('阶梯参考价存在不一致');

section('地址完整性');
const checks = verifyRegistryStructure(registry);
table(['检查项', '状态', '详情'], checks.map((item) => [item.name, item.status, item.detail]));
let failures = 0;
for (const item of checks) {
  if (item.status === CHECK_STATUS.FAIL) {
    if (execute) { failures++; fail(item.name + '：' + item.detail); }
    else warn(item.name + '：' + item.detail + '（dry-run 允许，EXECUTE 前必须完成）');
  }
  if (item.status === CHECK_STATUS.WARN) warn(item.name + '：' + item.detail);
}

section('资金确认');
const fundingPlan = verifyFundingPlan(params, { all: true });
const fundingRows = [];
for (const item of fundingPlan) {
  const record = (registry.funding || []).find((entry) => entry.kind === item.kind && entry.amountRaw === item.amountRaw && entry.confirmed === true);
  fundingRows.push([item.label, formatTokens(item.amountRaw) + ' A9', record ? 'CONFIRMED' : 'MISSING', record ? record.recipient : '—']);
}
table(['分配', '金额', '状态', '接收 Jetton Wallet'], fundingRows);
const missingFunding = fundingRows.filter((row) => row[2] === 'MISSING').length;
if (missingFunding === 0) ok('全部 5 项分配均已确认');
else if (execute) { failures++; fail('仍有 ' + missingFunding + ' 项分配未确认（执行 50_fund_vaults.mjs --all）'); }
else warn('dry-run：' + missingFunding + ' 项分配未记录（EXECUTE 前必须完成）');

section('登记表定稿');
registry.verification = {
  lastRunAt: new Date().toISOString(),
  healthy: failures === 0,
  checks: checks.map((item) => ({ name: item.name, status: item.status, detail: item.detail })),
  digest: registryDigest(registry),
};
if (persist) writeRegistry(registry);
else warn('dry-run：登记表未写入（EXECUTE 时才落盘 paramsDigest/verification）');
kv('paramsDigest', digest);
kv('registryDigest', registry.verification.digest);
kv('登记状态', registry.status);
kv('登记文件', process.env.OPS_REGISTRY || 'ops/config/testnet.registry.json');

section('地址簿');
const rows = [];
for (const [key, value] of Object.entries(registry.contracts)) {
  if (!value.address) continue;
  rows.push([key, value.address, value.codeHash || '—', explorerUrl(params, value.address)]);
}
for (const [key, value] of Object.entries(registry.wallets)) {
  if (!value.address) continue;
  const visibility = value.public ? '公开' : '不公开（仅审计/交易所披露）';
  rows.push(['wallet.' + key, value.address, visibility, explorerUrl(params, value.address)]);
}
table(['名称', '地址', '说明', '浏览器'], rows);

mkdirSync(RECORDS_DIR, { recursive: true });
const addressBookFile = join(RECORDS_DIR, 'address-book.testnet.md');
const lines = [];
lines.push('# A9 测试网地址登记表（部署产物）');
lines.push('');
lines.push('- 网络：TON testnet（chainId -3）');
lines.push('- 生成时间：' + new Date().toISOString());
lines.push('- 配置哈希：' + digest);
lines.push('- 登记表摘要：' + registry.verification.digest);
lines.push('- 参数版本：' + params.meta.version + ' / configVersion ' + params.meta.configVersion);
lines.push('');
lines.push('## 合约');
lines.push('');
lines.push('| 名称 | 地址 | code hash | 浏览器 |');
lines.push('| --- | --- | --- | --- |');
for (const [key, value] of Object.entries(registry.contracts)) {
  if (!value.address) continue;
  lines.push('| ' + key + ' | ' + value.address + ' | ' + (value.codeHash || '—') + ' | ' + explorerUrl(params, value.address) + ' |');
}
lines.push('');
lines.push('## 钱包（团队/营销/流动性收款地址不公开，仅向审计方/交易所披露）');
lines.push('');
lines.push('| 名称 | 地址 | 公开性 |');
lines.push('| --- | --- | --- |');
for (const [key, value] of Object.entries(registry.wallets)) {
  if (!value.address) continue;
  lines.push('| ' + key + ' | ' + value.address + ' | ' + (value.public ? '公开' : '不公开') + ' |');
}
lines.push('');
lines.push('## 注资记录');
lines.push('');
lines.push('| 分配 | 金额 raw | 接收 Jetton Wallet | 状态 |');
lines.push('| --- | --- | --- | --- |');
for (const record of registry.funding || []) {
  lines.push('| ' + record.kind + ' | ' + record.amountRaw + ' | ' + (record.recipient || '—') + ' | ' + (record.confirmed ? 'CONFIRMED' : 'PENDING') + ' |');
}
lines.push('');
lines.push('> 说明：团队/营销/流动性为个人热钱包、地址不对外披露（V5 决策，风险已接受）；至少向审计方/交易所披露。');
lines.push('');
writeJSON(addressBookFile.replace('.md', '.json'), {
  generatedAt: new Date().toISOString(),
  network: 'testnet',
  chainId: -3,
  paramsDigest: digest,
  registryDigest: registry.verification.digest,
  contracts: registry.contracts,
  wallets: registry.wallets,
  funding: registry.funding,
});
const { writeFileSync } = await import('node:fs');
writeFileSync(addressBookFile, lines.join(String.fromCharCode(10)), 'utf8');
ok('地址簿已生成：' + addressBookFile);

if (failures > 0) {
  fail('登记表存在 ' + failures + ' 个阻断项，不计为完成');
  process.exit(finish({ 模式: execute ? 'EXECUTE' : 'DRY-RUN' }));
}
info(execute ? '登记完成：可进入 Round 1 开轮演练（80_admin_ops.mjs open-round）。' : 'dry-run 完成：登记表未变更（除 paramsDigest 校验路径外）。');
printNextSteps(['下一步：verify_deployment.mjs 全量验收；然后按 runbooks/02_round_operations.md 开 R1。']);
process.exit(finish({ 模式: execute ? 'EXECUTE' : 'DRY-RUN', 地址簿: addressBookFile }));
