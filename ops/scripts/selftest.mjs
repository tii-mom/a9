#!/usr/bin/env node
/** selftest — ops 资产离线自测：参数、地址编解码、公告、对账、监控、登记表、脚本语法。 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asBigInt, expectedLadder, loadAndValidate, paramsDigest, rawAmount } from './lib/config.mjs';
import { emptyRegistry, recordFunding, setContract, setWallet, writeRegistry } from './lib/registry.mjs';
import { crc16, formatAddress, parseAddress } from './lib/ton.mjs';
import { expectedProtocolConfig, verifyAllocationInvariant, verifyLadder, verifyRegistryStructure } from './lib/verify.mjs';
import { section, ok, fail, warn, info, kv, table, summary } from './lib/log.mjs';

const OPS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BAM_ROOT = join(OPS_ROOT, '..');
const SCRIPTS = join(OPS_ROOT, 'scripts');
const FIXTURES = join(OPS_ROOT, 'tests', 'fixtures');
const temp = mkdtempSync(join(tmpdir(), 'a9-ops-selftest-'));
const tempRegistry = join(temp, 'registry.json');
process.env.OPS_REGISTRY = tempRegistry;
const { params, errors, digest } = loadAndValidate();

let failures = 0;
let passes = 0;
function test(name, fn) {
  try {
    const detailText = fn();
    passes++;
    ok(name + (detailText ? ' — ' + detailText : ''));
  } catch (error) {
    failures++;
    fail(name + ' — ' + String(error && error.message ? error.message : error));
  }
}
function run(args, env = {}) {
  const result = spawnSync(process.execPath, args, { cwd: BAM_ROOT, encoding: 'utf8', env: { ...process.env, OPS_RECORDS_DIR: join(temp, 'records'), ...env }, timeout: 120000 });
  return { code: result.status, out: String(result.stdout || '') + String(result.stderr || '') };
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

section('自测：参数不变量');
test('params.validate', () => {
  assert(errors.length === 0, '参数错误：' + errors.join('; '));
  return 'V6.2 参数全部通过';
});
test('params.digest', () => {
  const again = paramsDigest(params);
  assert(again === digest, 'digest 不稳定');
  return digest.slice(0, 23) + '…';
});
test('allocation.sum', () => {
  const result = verifyAllocationInvariant(params);
  assert(result.ok, '分配总和 != 100 亿');
  return result.sumRaw + ' raw';
});
test('price.ladder', () => {
  const ladder = expectedLadder(params);
  assert(ladder[1] === '232000' && ladder[10] === '118784000', '阶梯值不符合 P0=116000 × 2^tier');
  assert(verifyLadder(params).ok, '参数内阶梯参考价不一致');
  return 'R1 $0.00232 → R10 $1.18784';
});
test('timeline.invariants', () => {
  assert(Number(params.timeline.roundSeconds) === 604800, '单轮 != 7 天');
  assert(Number(params.timeline.roundsTotalSeconds) === 6048000, '10 轮 != 70 天');
  assert(Number(params.timeline.candleCount) === 18 && Number(params.timeline.minQualifiedCandles) === 12, '观察窗口参数错误');
  return '7 天/轮 · 70 天/10 轮 · 18 根/阈值 12';
});
test('protocol.config.expected', () => {
  const expected = expectedProtocolConfig(params);
  assert(expected.p0UsdE8 === '116000' && expected.priceMultiplier === 2, 'P0/倍数错误');
  assert(expected.techAbortPauseSeconds === 1209600 && expected.techAbortObservationTimeout === 604800, '技术终止参数错误');
  return '22 个字段与 V6.2 一致';
});
test('raw.amount.helper', () => {
  assert(rawAmount(700000000) === '700000000000000000', 'rawAmount 错误');
  assert(asBigInt('10000000000000000000') === 10000000000000000000n, 'asBigInt 错误');
  return '1 A9 = 1e9 raw';
});

section('自测：TON 地址编解码');
test('address.known.mainnet', () => {
  const samples = ['EQBBJBB3HagsujBqVfqeDUPJ0kXjgTPLWPFFffuNXNiJL0aA', 'EQDmnxDMhId6v1Ofg_h5KR5coWlFG6e86Ro3pc7Tq4CA0-Jn'];
  for (const sample of samples) assert(parseAddress(sample).ok, '已知地址解析失败：' + sample);
  return '2 个已知地址 CRC 通过';
});
test('address.roundtrip.testnet', () => {
  const hash = createHash('sha256').update('a9-selftest').digest('hex');
  const address = formatAddress(0, hash, { bounceable: true, testnet: true });
  const parsed = parseAddress(address);
  assert(parsed.ok && parsed.testnet === true && parsed.hashHex === hash, '测试网地址回环失败');
  return address.slice(0, 12) + '…';
});
test('address.crc.rejects', () => {
  const hash = createHash('sha256').update('a9-selftest').digest('hex');
  const address = formatAddress(0, hash, { bounceable: true, testnet: true });
  const tampered = address.slice(0, 40) + (address[40] === 'A' ? 'B' : 'A') + address.slice(41);
  assert(!parseAddress(tampered).ok, '篡改地址未被拒绝');
  assert(crc16(Buffer.from('123456789')) === 0x31c3, 'CRC16 标准向量失败');
  return 'CRC16/XMODEM 向量 0x31C3 通过';
});

section('自测：登记表与验收（临时目录）');
test('registry.roundtrip', () => {
  const registry = emptyRegistry();
  const addresses = {};
  for (const key of ['jettonMaster', 'teamVault', 'roundController']) {
    addresses[key] = formatAddress(0, createHash('sha256').update('contract-' + key).digest('hex'), { bounceable: true, testnet: true });
    setContract(registry, key, addresses[key], { note: 'selftest' });
  }
  for (const key of ['adminOwner', 'treasury', 'teamWallet', 'marketingWallet', 'liquidityWallet', 'teamInternalWallet']) {
    setWallet(registry, key, formatAddress(0, createHash('sha256').update('wallet-' + key).digest('hex'), { bounceable: true, testnet: true }));
  }
  for (const kind of ['roundRewards', 'team', 'marketing', 'liquidity', 'internalSale']) {
    const plan = { roundRewards: params.rounds.rewardPoolRaw, team: params.rounds.teamPoolRaw, marketing: params.supply.allocations.marketing.raw, liquidity: params.supply.allocations.liquidity.raw, internalSale: params.supply.allocations.internalSale.raw };
    recordFunding(registry, { kind, recipient: formatAddress(0, createHash('sha256').update('fund-' + kind).digest('hex'), { bounceable: true, testnet: true }), amountRaw: plan[kind], confirmed: true });
  }
  registry.paramsDigest = digest;
  writeRegistry(registry);
  const checks = verifyRegistryStructure(registry);
  assert(checks.filter((item) => item.status === 'FAIL').length === 0, '登记表结构检查失败');
  return addresses.roundController.slice(0, 12) + '…';
});
test('verify_deployment.offline', () => {
  const result = run([join(SCRIPTS, 'verify_deployment.mjs'), '--offline'], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 0, 'verify_deployment --offline 失败：' + result.out.slice(-800));
  return '临时登记表通过离线验收';
});
test('admin_ops.policy_reject', () => {
  const result = run([join(SCRIPTS, '80_admin_ops.mjs'), '--action', 'modify-target', '--round', '1'], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 1, '越权动作未被拒绝（exit ' + result.code + '）');
  assert(result.out.includes('禁止'), '缺少拒绝原因');
  return 'modify-target 被权限策略拒绝';
});

section('自测：公告模板（7 类 × 中英）');
const templateFile = join(OPS_ROOT, 'templates', 'announcements.json');
const templates = JSON.parse(readFileSync(templateFile, 'utf8'));
for (const type of Object.keys(templates.templates)) {
  test('announcement.' + type, () => {
    const result = run([join(SCRIPTS, 'announcement.mjs'), '--type', type, '--round', '2', '--lang', 'both']);
    assert(result.code === 0, '渲染失败：' + result.out.slice(-500));
    assert(result.out.includes(templates.templates[type].label), '缺少标题');
    assert(result.out.includes('风险提示') && result.out.includes('Risk notice'), '缺少中英风险提示');
    return 'ZH+EN 渲染 + 风险提示';
  });
}

section('自测：对账与监控（夹具）');
test('reconcile.healthy', () => {
  const out = join(temp, 'reconcile.csv');
  const result = run([join(SCRIPTS, 'reconcile.mjs'), '--snapshot', join(FIXTURES, 'worker-snapshot.json'), '--out', out]);
  assert(result.code === 0, '对账失败：' + result.out.slice(-600));
  assert(result.out.includes('对账通过'), '未通过对账');
  assert(existsSync(out), 'CSV 未生成');
  const csv = readFileSync(out, 'utf8');
  assert(csv.includes('FAILED_PERMANENT') && csv.includes('SUCCEEDED'), 'CSV 内容不完整');
  return 'R1 成功 / R2 失败三笔销毁一致 / 供应量一致';
});
test('monitor.healthy', () => {
  const result = run([join(SCRIPTS, 'monitor_check.mjs'), '--snapshot', join(FIXTURES, 'worker-snapshot.json')]);
  assert(result.code === 0, '健康夹具出现告警：' + result.out.slice(-800));
  assert(result.out.includes('全部指标正常'), '未显示健康结论');
  return 'P0=0/P1=0';
});
test('monitor.faults', () => {
  const result = run([join(SCRIPTS, 'monitor_check.mjs'), '--snapshot', join(FIXTURES, 'worker-snapshot-bad.json')]);
  assert(result.code === 2, '故障夹具未返回 2（实际 ' + result.code + '）');
  for (const expected of ['worker.db', 'supply.drift', 'burn_pending', 'oracle.paused', 'admin.error_events']) {
    assert(result.out.includes(expected), '缺少告警：' + expected);
  }
  return 'P0=3 / P1=4 / P2=1';
});

section('自测：部署脚本 dry-run（临时登记表）');
for (const script of ['00_preflight.mjs', '10_deploy_jetton.mjs', '11_mint_and_lock_jetton.mjs', '20_deploy_teamvault.mjs', '30_deploy_round_controller.mjs', '40_init_params.mjs', '70_bind_roles.mjs', '50_fund_vaults.mjs', '60_verify_and_register.mjs']) {
  test('dryrun.' + script, () => {
    const extra = script === '50_fund_vaults.mjs' ? ['--all'] : [];
    const result = run([join(SCRIPTS, script), ...extra], { OPS_REGISTRY: tempRegistry });
    assert(result.code === 0, '脚本返回非 0：' + result.out.slice(-700));
    assert(result.out.includes('DRY-RUN') || result.out.includes('跳过'), '未以 dry-run 运行');
    return 'dry-run 通过';
  });
}

section('自测：全部脚本语法');
const scriptFiles = ['00_preflight.mjs', '10_deploy_jetton.mjs', '11_mint_and_lock_jetton.mjs', '20_deploy_teamvault.mjs', '30_deploy_round_controller.mjs', '40_init_params.mjs', '50_fund_vaults.mjs', '60_verify_and_register.mjs', '70_bind_roles.mjs', '80_admin_ops.mjs', 'deploy_all.mjs', 'verify_deployment.mjs', 'reconcile.mjs', 'monitor_check.mjs', 'announcement.mjs'];
test('syntax.all', () => {
  const bad = [];
  for (const file of scriptFiles) {
    const result = spawnSync(process.execPath, ['--check', join(SCRIPTS, file)], { encoding: 'utf8' });
    if (result.status !== 0) bad.push(file + ': ' + String(result.stderr || '').split(String.fromCharCode(10))[0]);
  }
  assert(bad.length === 0, bad.join(' | '));
  return scriptFiles.length + ' 个脚本';
});

rmSync(temp, { recursive: true, force: true });
section('自测结果');
kv('通过', passes);
kv('失败', failures);
process.exit(summary({ 通过: passes, 失败: failures }) || (failures > 0 ? 1 : 0));
