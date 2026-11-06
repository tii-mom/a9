#!/usr/bin/env node
/** 00 — 部署前置检查：环境、参数、密钥来源（只检查存在性）、工具链、地址登记。 */

import { spawnSync } from 'node:child_process';
import { resolvePath } from './lib/config.mjs';
import { bootstrap, finish, printProtocolConfigExpected } from './lib/step.mjs';
import { parseAddress } from './lib/ton.mjs';
import { verifyAllocationInvariant, verifyLadder, verifyRegistryStructure, check, CHECK_STATUS } from './lib/verify.mjs';
import { section, kv, ok, fail, warn, info, table } from './lib/log.mjs';

const { args, execute, params, digest, registry, toolchain } = bootstrap({
  id: '00',
  title: '测试网部署前置检查（preflight）',
});

const blocking = [];
const warnings = [];

section('运行环境');
kv('Node', process.version);
if (Number(process.versions.node.split('.')[0]) >= 20) ok('Node 版本 >= 20（支持 fetch / AbortSignal.timeout）');
else { fail('Node 版本过低，需要 >= 20'); blocking.push('node-version'); }
if (typeof fetch === 'function') ok('global fetch 可用');
else { fail('缺少 global fetch（需要 Node 18+）'); blocking.push('fetch'); }

section('参数不变量');
const allocation = verifyAllocationInvariant(params);
if (allocation.ok) ok('分配总和 = 总量 = ' + allocation.sumTokens + '（raw ' + allocation.sumRaw + '）');
else { fail('分配总和不等于总量：' + allocation.sumTokens + ' vs ' + allocation.expectedTokens); blocking.push('allocation'); }
const ladder = verifyLadder(params);
if (ladder.ok) ok('阶梯参考价与 P0 × 2^tier 一致（tier 1..10）');
else { for (const row of ladder.rows.filter((item) => !item.ok)) fail('tier ' + row.tier + ' 阶梯不一致：' + row.priceUsdE8 + ' vs ' + row.ref); blocking.push('ladder'); }
const expected = params.rounds.rewardPoolRaw;
if (expected === '7000000000000000000') ok('奖励池 = 70 亿 A9（10 × 7 亿）');
else { fail('奖励池 raw 不等于 70 亿：' + expected); blocking.push('reward-pool'); }
printProtocolConfigExpected(params);

section('地址登记表');
const registryChecks = verifyRegistryStructure(registry);
table(['检查项', '状态', '详情'], registryChecks.map((item) => [item.name, item.status, item.detail]));
for (const item of registryChecks) {
  if (item.status === CHECK_STATUS.FAIL) {
    if (execute) { fail(item.name + '：' + item.detail); blocking.push(item.name); }
    else warn(item.name + '：' + item.detail + '（dry-run 允许，EXECUTE 前必须登记）');
  }
  if (item.status === CHECK_STATUS.WARN) warn(item.name + '：' + item.detail);
}

section('密钥与收款地址（只检查存在性，绝不读取/打印内容）');
const mnemonic = process.env[params.network.deployer.mnemonicEnv] || '';
if (!mnemonic) {
  if (execute) { fail('缺少 ' + params.network.deployer.mnemonicEnv + '（24 词助记词，来自硬件钱包/离线环境）'); blocking.push('mnemonic'); }
  else info('未设置 ' + params.network.deployer.mnemonicEnv + '（dry-run 允许；EXECUTE 必须提供）');
} else {
  const words = mnemonic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 24) ok('助记词已提供（24 词，内容不打印）');
  else warn('助记词词数为 ' + words.length + '（TON v4r2 通常为 24 词，请核对）');
  if (mnemonic.trim().length === 64 && /^[0-9a-fA-F]{64}$/.test(mnemonic.trim())) {
    fail('检测到疑似裸私钥：禁止使用裸私钥，请改用助记词或硬件钱包签名');
    blocking.push('raw-private-key');
  }
}
// v10：没有 admin；keeper 与 teamWallet 写入 RC 初始数据（部署后永久不可改），部署前必须确定。
for (const [key, envName] of [['keeper', params.roles.keeper.env], ['teamWallet', params.roles.teamWallet.env], ['treasury', params.network.deployer.treasuryAddressEnv]]) {
  const fromEnv = process.env[envName] || '';
  const fromRegistry = registry.wallets[key] && registry.wallets[key].address;
  if (fromEnv) {
    const parsed = parseAddress(fromEnv);
    if (parsed.ok && parsed.testnet) ok(key + ' 地址来自 ' + envName + '（测试网）');
    else { fail(key + ' 地址非法或非测试网：' + fromEnv); blocking.push(key); }
  } else if (fromRegistry) {
    ok(key + ' 地址已登记：' + fromRegistry);
  } else {
    if (execute) { fail('缺少 ' + key + '（' + envName + ' 或登记表）'); blocking.push(key); }
    else warn('缺少 ' + key + '（' + envName + '），EXECUTE 前必须提供');
  }
}

section('Acton 项目钱包');
const walletName = process.env[params.network.deployer.walletNameEnv] || params.network.deployer.walletNameDefault;
if (toolchain.adapter === 'acton') {
  const listResult = spawnSync('bash', ['-lc', 'cd ' + toolchain.contractsDir + ' && acton wallet list'], { encoding: 'utf8' });
  const walletList = String(listResult.stdout || '') + String(listResult.stderr || '');
  if (walletList.includes(walletName)) ok('Acton 项目钱包存在：' + walletName + '（私钥存本地 keystore，不打印）');
  else {
    const message = '未发现 Acton 钱包「' + walletName + '」：先 cd contracts && acton wallet import（交互输入助记词），或用 acton wallet new 创建测试钱包';
    if (execute) { fail(message); blocking.push('acton-wallet'); }
    else warn(message);
  }
} else {
  info('非 Acton 适配器：跳过项目钱包检查');
}

section('工具链');
kv('适配器', toolchain.adapter);
kv('二进制', toolchain.binPath || '（未安装）');
kv('版本', toolchain.version || '（未知）');
kv('版本已 pin', toolchain.pinned ? '是' : '否');
kv('合约目录', toolchain.contractsDir + (toolchain.contractsDirExists ? '（存在）' : '（不存在）'));
kv('构建产物目录', toolchain.buildDir + (toolchain.buildDirExists ? '（存在）' : '（不存在）'));
if (toolchain.pinned) ok('工具链版本已锁定');
else warn('工具链未 pin 版本：EXECUTE 需要 OPS_ALLOW_UNPINNED_TOOLCHAIN=1，并在部署报告中登记实际版本');
if (execute) {
  if (!toolchain.available) { fail('工具链不可用：请先安装 ' + (toolchain.bin || 'acton') + '，或用 --adopt 手工登记地址'); blocking.push('toolchain'); }
  if (!toolchain.contractsDirExists) { fail('contracts/ 目录不存在（等待 task-5 合约交付）'); blocking.push('contracts-dir'); }
  if (!toolchain.buildDirExists) { fail('构建产物目录不存在：先执行 ' + (toolchain.bin || 'acton') + ' build'); blocking.push('build-dir'); }
  if (!toolchain.pinned && process.env.OPS_ALLOW_UNPINNED_TOOLCHAIN !== '1') {
    fail('工具链未 pin 且未设置 OPS_ALLOW_UNPINNED_TOOLCHAIN=1；拒绝真实部署');
    blocking.push('unpinned-toolchain');
  }
} else {
  info('dry-run 不要求工具链已安装；真实执行前需完成 contracts/ 构建。');
}

section('配置哈希');
kv('paramsDigest', digest);
kv('登记表 paramsDigest', registry.paramsDigest || '（未写入）');
if (registry.paramsDigest && registry.paramsDigest !== digest) {
  warn('登记表记录的配置哈希与当前参数不一致：参数已变更，需重新生成部署输入');
}

section('结论');
if (blocking.length === 0) {
  ok(execute ? '所有门禁通过，可以进入部署（按 15 → 40 → 55 → 50 → 60 → verify_deployment 顺序）。' : 'dry-run 前置检查通过；未执行任何链上操作。');
} else {
  fail('存在 ' + blocking.length + ' 个阻断项：' + [...new Set(blocking)].join(', '));
}
const code = finish({ 阻断项: blocking.length, 配置哈希: digest, 模式: execute ? 'EXECUTE' : 'DRY-RUN' });
process.exit(code || (execute && blocking.length ? 1 : 0));
