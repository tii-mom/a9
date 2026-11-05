#!/usr/bin/env node
/** 10 — 部署 Jetton Master（TEP-74，官方复用；部署后 mint 权限最终关闭）。 */

import { existsSync } from 'node:fs';
import { resolvePath } from './lib/config.mjs';
import { str } from './lib/cli.mjs';
import { bootstrap, finish, printNextSteps } from './lib/step.mjs';
import { commandTemplate, extractAddress, runCommand, substitute } from './lib/toolchain.mjs';
import { setContract, writeRegistry } from './lib/registry.mjs';
import { validateTestnetAddress } from './lib/ton.mjs';
import { section, kv, info, ok, fail, warn, detail } from './lib/log.mjs';

const { args, execute, params, digest, registry, toolchain } = bootstrap({
  id: '10',
  title: '部署 Jetton Master（A9 / TEP-74）',
});

const artifact = resolvePath(params.toolchain.buildDir + '/jetton_master.boc');
const treasury =
  str(args, 'treasury') ||
  (registry.wallets.treasury && registry.wallets.treasury.address) ||
  process.env[params.network.deployer.treasuryAddressEnv] ||
  '';
const adopt = str(args, 'adopt');
const existing = registry.contracts.jettonMaster.address;

section('部署参数');
kv('Jetton 名称', params.token.name);
kv('符号', params.token.symbol);
kv('decimals', params.token.decimals);
kv('初始总量', params.token.totalSupplyRaw + ' raw（' + params.token.totalSupplyTokens + ' A9）');
kv('mint 策略', params.token.mintPolicy);
kv('金库/初始铸造接收', treasury || '（未提供）');
kv('构建产物', artifact);
kv('配置哈希', digest);

if (adopt) {
  const validation = validateTestnetAddress(adopt, 'jettonMaster');
  if (!validation.ok) { fail(validation.message); process.exit(finish()); }
  setContract(registry, 'jettonMaster', adopt, { note: 'adopt 手工登记' });
  writeRegistry(registry);
  ok('已登记 Jetton Master：' + adopt);
  process.exit(finish({ 地址: adopt }));
}

if (existing) {
  info('Jetton Master 已登记：' + existing + '（跳过部署；如需替换请先人工确认并清空登记表）');
  process.exit(finish({ 地址: existing }));
}

if (!treasury) {
  if (execute) { fail('缺少初始铸造接收地址（--treasury / TON_TREASURY_ADDRESS / 登记表）'); process.exit(finish()); }
  warn('未提供 treasury 地址（dry-run 继续）');
}
if (execute && !existsSync(artifact)) {
  fail('构建产物不存在：' + artifact + '（先构建 contracts/，或使用 --adopt <address>）');
  process.exit(finish());
}

const command = commandTemplate(params, 'deployJettonMaster');
const rendered = substitute(command, {
  contractsDir: resolvePath(params.toolchain.contractsDir),
  treasury,
  totalSupplyRaw: params.token.totalSupplyRaw,
});
section('执行计划');
detail('命令：' + rendered);
if (!execute) detail('dry-run：不执行命令。真实执行需 OPS_EXECUTE=1 且工具链就绪。');

const result = runCommand(rendered, { execute });
if (execute) {
  if (result.status !== 0) {
    fail('部署命令失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 500));
    process.exit(finish());
  }
  const address = str(args, 'address') || extractAddress(result.stdout) || extractAddress(result.stderr);
  if (!address) {
    fail('命令成功但未能从输出解析地址；请用 --adopt <address> 手工登记');
    detail('stdout: ' + result.stdout.slice(0, 500));
    process.exit(finish());
  }
  setContract(registry, 'jettonMaster', address, { note: 'Acton 部署输出解析' });
  writeRegistry(registry);
  ok('Jetton Master 已部署并登记：' + address);
}

printNextSteps([
  '验证：' + (execute ? 'node scripts/verify_deployment.mjs --offline' : '部署后执行 verify_deployment.mjs'),
  '下一步：node scripts/11_mint_and_lock_jetton.mjs' + (execute ? ' --execute' : ''),
  '铸造完成后必须关闭 mint 权限（admin 置空），否则不满足 TEP-74 “关闭 mint”要求。',
]);
process.exit(finish({ 地址: registry.contracts.jettonMaster.address || '（dry-run 未变更）' }));
