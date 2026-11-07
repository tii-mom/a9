#!/usr/bin/env node
/** selftest — ops 资产离线自测：参数、地址编解码、公告、对账、监控、登记表、脚本语法。 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_OPCODE_NAMES, TIMING_PROFILES, V11_EVENTS, V11_OPCODES, asBigInt, expectedLadder, loadAndValidate, loadParams, paramsDigest, rawAmount, validateParams } from './lib/config.mjs';
import { FUNDING_KINDS, emptyRegistry, recordFunding, setContract, setWallet, writeRegistry } from './lib/registry.mjs';
import { crc16, decodeRcEvent, formatAddress, parseAddress } from './lib/ton.mjs';
import { expectedSettlement, pendingSettlementActions } from './lib/ledger.mjs';
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
  return 'V7 参数全部通过';
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
test('params.v11_contracts', () => {
  const opcodes = params.permissions.opcodes;
  for (const [name, code] of Object.entries(V11_OPCODES)) assert(String(opcodes[name] || '').toUpperCase() === code.toUpperCase(), 'opcode ' + name + ' 必须为 ' + code);
  assert(Object.keys(opcodes).every((name) => ALLOWED_OPCODE_NAMES.includes(name)), '存在 v11 ABI 以外的 opcode');
  assert(opcodes.Claim === undefined && opcodes.ClaimAll === undefined, 'v11 已删除 Claim / ClaimAll，不得再出现在参数文件');
  for (const [name, code] of Object.entries(V11_EVENTS)) assert(String(params.permissions.events[name] || '').toUpperCase() === code.toUpperCase(), 'event ' + name + ' 必须为 ' + code);
  assert(params.permissions.events.SettlementBounced === '0x52540110' && params.permissions.events.UnexpectedBounce === '0x52540111', '缺少 SettlementBounced / UnexpectedBounce 事件');
  assert(params.stakeLimits.minStakeRaw === '1000000000000', '最低质押必须为 1,000 A9');
  assert(params.rounds.rcFundingRaw === '8200000000000000000' && params.rounds.rcFundingForwardTonNano === '0', 'RC 注资必须为 82 亿且 forward 0');
  assert(params.roles.keeper && params.roles.teamWallet && params.roles.junxiangPublisher && Object.keys(params.roles).length === 7, 'roles 必须是 keeper/treasury/teamWallet/junxiangPublisher/营销/流动性/内盘');
  const commands = params.toolchain.adapters.acton.commands;
  assert(commands.deployAllContracts.includes('A9_KEEPER_ADDRESS={keeper}') && commands.deployAllContracts.includes('A9_TEAM_WALLET_ADDRESS={teamWallet}') && commands.deployAllContracts.includes('A9_JUNXIANG_PUBLISHER_ADDRESS={junxiangPublisher}'), 'deployAllContracts 必须传 keeper / teamWallet / junxiangPublisher');
  assert(commands.junxiangSetRoot && commands.junxiangSetRoot.includes('junxiang_op.tolk junxiang-set-root {listId} {rootHex}'), 'junxiangSetRoot 命令模板缺失或错误');
  const ids = params.deployPlan.map((item) => item.id);
  assert(JSON.stringify(ids) === JSON.stringify(['preflight', 'jettonMaster', 'jettonMint', 'contracts', 'params', 'tonGas', 'funding', 'register', 'verify']), 'deployPlan 不是 v10 顺序：' + ids.join(','));
  for (const file of ['testnet', 'mainnet', 'ceremony', 'prodtest', 'testnet-fast', 'ceremony-rehearsal']) {
    const other = loadParams(join(OPS_ROOT, 'config', file + '.params.json'));
    const result = validateParams(other);
    assert(result.errors.length === 0, file + '.params.json：' + result.errors.join('; '));
  }
  return 'opcode/事件/最低质押 1,000 A9/RC 82 亿 forward 0/keeper + teamWallet + publisher；6 个参数文件通过';
});
test('ledger.formulas', () => {
  const failed = expectedSettlement(params, 'FAILED_PERMANENT', '241500000000000000');
  assert(failed.burnRaw === 711500000000000000n && failed.teamReleaseRaw === 0n, '失败轮一笔销毁 = 奖池一半 3.5 亿 + 1.2 亿 + 本金');
  assert(failed.carryRaw === 350000000000000000n, '失败轮另一半奖池滚入下一城');
  const success = expectedSettlement(params, 'SUCCEEDED', '1', null, '120000000000000000');
  assert(success.burnRaw === 0n && success.teamReleaseRaw === 120000000000000000n && success.carryRaw === 0n, '破城轮不销毁；上一次破城的团队额度 1.2 亿此时转出');
  assert(expectedSettlement(params, 'SUCCEEDED', '0').carryRaw === 700000000000000000n, '0 人质押破城：整笔奖池滚存');
  assert(expectedSettlement(params, 'TECHNICAL_ABORTED', '5').burnRaw === 0n && expectedSettlement(params, 'TECHNICAL_ABORTED', '5').carryRaw === 700000000000000000n, '技术终止不销毁，整笔滚存');
  assert(pendingSettlementActions({ state: 'FAILED_PERMANENT', totalAcceptedStakeRaw: 1n, rewardBurnConfirmed: false, teamBurnConfirmed: false, principalBurnConfirmed: false }).length === 1, '销毁被退回应待重试');
  assert(pendingSettlementActions({ state: 'SUCCEEDED', totalAcceptedStakeRaw: 1n, teamReleaseConfirmed: true }).length === 0, '团队转账已确认');
  return 'v11：失败一笔销毁（奖池一半）/ 破城不销毁 / 0 人滚存 / 失败 *Confirmed → RetrySettlement';
});
test('ton.decode_rc_event', () => {
  const data = Buffer.from([0x52, 0x54, 0x01, 0x10, 3, 2]);
  const boc = Buffer.concat([Buffer.from([0xb5, 0xee, 0x9c, 0x72, 0x01, 0x01, 1, 1, 0, 2 + data.length, 0]), Buffer.from([0, data.length * 2]), data]);
  const event = decodeRcEvent(boc.toString('base64'));
  assert(event && event.type === 'SettlementBounced' && event.roundId === 3 && event.action === 2, '事件解码失败：' + JSON.stringify(event));
  return 'SettlementBounced(roundId=3, action=2)';
});
test('liquidity.cold_start', () => {
  const liquidity = params.supply.allocations.liquidity;
  const tokens = asBigInt(liquidity.tokens);
  const cold = asBigInt(liquidity.coldStartTokens);
  assert(cold <= tokens, '冷启动 A9 不得超过流动性额度');
  assert(cold * 100n === tokens * BigInt(liquidity.coldStartPercentOfLiquidity), '冷启动占比与 coldStartPercentOfLiquidity 不一致');
  assert(cold * 100n === tokens * 40n, '冷启动必须占流动性 40%');
  assert(asBigInt(liquidity.coldStartRaw) === cold * 10n ** 9n, ' coldStartRaw 与 coldStartTokens 不一致');
  assert(String(liquidity.coldStartUsdtUsdE8) === '23200000000000', '冷启动 USDT 必须为 $232,000');
  return '2 亿 A9 + $232,000 USDT（占流动性 40%，剩余 3 亿）';
});
test('price.ladder', () => {
  const ladder = expectedLadder(params);
  assert(ladder[1] === '232000' && ladder[10] === '118784000', '阶梯值不符合 P0=116000 × 2^tier');
  assert(verifyLadder(params).ok, '参数内阶梯参考价不一致');
  return 'R1 $0.00232 → R10 $1.18784';
});
test('timeline.invariants', () => {
  assert(Number(params.timeline.roundSeconds) === 259200, '单轮 != 72h');
  assert(Number(params.timeline.roundsTotalSeconds) === 2592000, '10 轮 != 30 天');
  assert(Number(params.timeline.candleCount) === 24 && Number(params.timeline.minQualifiedCandles) === 16, '观察窗口参数错误');
  assert(Number(params.timeline.candleSeconds) === 3600 && Number(params.timeline.observationSeconds) === 86400, 'K 线周期/观察窗口错误');
  assert(Number(params.timeline.previewSeconds) === 43200 && Number(params.timeline.stakeDurationSeconds) === 129600, 'PREVIEW/报名窗口错误');
  return '72h/轮 · 30 天/10 轮 · 24 根 × 1h / 阈值 16';
});
test('protocol.config.expected', () => {
  const expected = expectedProtocolConfig(params);
  assert(expected.p0UsdE8 === '116000' && expected.priceMultiplier === 2, 'P0/倍数错误');
  assert(expected.techAbortPauseSeconds === 604800 && expected.techAbortObservationTimeout === 604800, '技术终止超时必须统一为 abortTimeoutSeconds（生产 7 天）');
  assert(expected.minStakeRaw === '1000000000000', '最低质押必须为 1,000 A9');
  assert(expected.maxStakePerAddressBps === 0 && expected.maxTotalStakeRaw === '0', 'v11 无上限：maxStakePerAddressBps / maxTotalStakeRaw 必须为 0');
  return 'v11 字段与生产时序一致（无上限）';
});
test('timing.profiles', () => {
  const fast = loadParams(join(OPS_ROOT, 'config', 'testnet-fast.params.json'));
  const fastResult = validateParams(fast);
  assert(fastResult.errors.length === 0, 'testnet-fast：' + fastResult.errors.join('; '));
  assert(fast.meta.timingProfile === 'fast-cycle' && fast.techAbort.abortTimeoutSeconds === 60 && fast.techAbort.fallbackUnlockSeconds === 60, 'fast-cycle 必须 abortTimeout=60s 且 fallbackUnlock=60s');
  assert(Number(fast.timeline.previewSeconds) === 10 && Number(fast.timeline.stakeDurationSeconds) === 90 && Number(fast.timeline.candleSeconds) === 10 && Number(fast.timeline.candleCount) === 24 && Number(fast.timeline.minQualifiedCandles) === 16, 'fast-cycle 时序应为 10/90/10×24/16');
  assert(Number(fast.timeline.roundsTotalSeconds) === 3400, 'fast-cycle 10 轮应为 3400s');
  const mislabeled = JSON.parse(JSON.stringify(fast));
  mislabeled.network = { ...mislabeled.network, net: 'mainnet', chainId: -239 };
  assert(validateParams(mislabeled).errors.some((message) => message.includes('fast-cycle')), 'fast-cycle 档不得用于主网');
  const wrongTimer = JSON.parse(JSON.stringify(params));
  wrongTimer.techAbort.abortTimeoutSeconds = 900;
  assert(validateParams(wrongTimer).errors.some((message) => message.includes('技术终止超时')), 'production 档不得静默改成快测超时');
  assert(Object.keys(TIMING_PROFILES).join(',') === 'production,fast-cycle,rehearsal', '时序档位集合应为 production / fast-cycle / rehearsal');
  return 'production（12h/36h/24×1h，超时 7 天，兜底 30 天）· fast-cycle（10/90/10×24，超时 60s，兜底 60s，仅测试网）';
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
  for (const key of ['jettonMaster', 'roundController', 'junxiangDistributor']) {
    addresses[key] = formatAddress(0, createHash('sha256').update('contract-' + key).digest('hex'), { bounceable: true, testnet: true });
    setContract(registry, key, addresses[key], { note: 'selftest' });
  }
  for (const key of ['keeper', 'treasury', 'teamWallet', 'junxiangPublisher', 'marketingWallet', 'liquidityWallet', 'teamInternalWallet']) {
    setWallet(registry, key, formatAddress(0, createHash('sha256').update('wallet-' + key).digest('hex'), { bounceable: true, testnet: true }));
  }
  for (const kind of FUNDING_KINDS) {
    const plan = { roundController: params.rounds.rcFundingRaw, marketing: params.supply.allocations.marketing.raw, liquidity: params.supply.allocations.liquidity.raw, internalSale: params.supply.allocations.internalSale.raw };
    recordFunding(registry, { kind, recipient: formatAddress(0, createHash('sha256').update('fund-' + kind).digest('hex'), { bounceable: true, testnet: true }), amountRaw: plan[kind], confirmed: true });
  }
  registry.paramsDigest = digest;
  writeRegistry(registry);
  const checks = verifyRegistryStructure(registry);
  assert(checks.filter((item) => item.status === 'FAIL').length === 0, '登记表结构检查失败');
  assert(registry.status === 'funded', '登记表状态应为 funded（RC 82 亿 + 8/5/5），实际 ' + registry.status);
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
test('admin_ops.removed_actions', () => {
  for (const action of ['pause-oracle', 'finalize-round', 'start-observation', 'retry-pending']) {
    const result = run([join(SCRIPTS, '80_admin_ops.mjs'), '--action', action, '--round', '1'], { OPS_REGISTRY: tempRegistry });
    assert(result.code === 1 && result.out.includes('v11 只保留'), action + ' 未被拒绝（exit ' + result.code + '）');
  }
  return 'v10 时代动作（pause/finalize/start-observation/retry-pending）全部拒绝';
});

section('自测：公告模板（5 类 × 中英）');
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
  assert(result.out.includes('RC 钱包') && result.out.includes('偏差'), '缺少 RC 钱包公式核对');
  return 'R1 成功团队释放 / R2 一笔销毁 / 供应量 / RC 钱包公式（+123 零头）一致';
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
  for (const expected of ['worker.db', 'supply.drift', 'rc.vault.drift', 'settlement.bounced.R1', 'unexpected.bounce', 'keeper.ton_low', 'round.2.candle_missing', 'ops.error_events', 'retry-settlement --round 1']) {
    assert(result.out.includes(expected), '缺少告警：' + expected);
  }
  return 'P0=3 / P1=7 / P2=1；SettlementBounced → retry-settlement';
});

section('自测：部署脚本 dry-run（临时登记表）');
for (const script of ['00_preflight.mjs', '10_deploy_jetton.mjs', '11_mint_and_lock_jetton.mjs', '15_deploy_contracts.mjs', '30_deploy_round_controller.mjs', '40_init_params.mjs', '55_fund_ton.mjs', '50_fund_vaults.mjs', '60_verify_and_register.mjs']) {
  test('dryrun.' + script, () => {
    const extra = script === '50_fund_vaults.mjs' ? ['--all'] : [];
    const result = run([join(SCRIPTS, script), ...extra], { OPS_REGISTRY: tempRegistry });
    assert(result.code === 0, '脚本返回非 0：' + result.out.slice(-700));
    assert(result.out.includes('DRY-RUN') || result.out.includes('跳过'), '未以 dry-run 运行');
    return 'dry-run 通过';
  });
}

section('自测：deploy_all 编排（whole / jetton）');
test('deploy_all.whole', () => {
  const result = run([join(SCRIPTS, 'deploy_all.mjs')], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 0, 'whole 模式失败：' + result.out.slice(-800));
  assert(result.out.includes('部署模式') && result.out.includes('whole'), '未以 whole 模式运行');
  assert(result.out.includes('contracts') && result.out.includes('verify'), 'whole 模式缺少步骤');
  assert(!result.out.includes('jettonWallets') && !result.out.includes('roles'), 'whole 模式不应再有钱包/角色绑定步骤');
  return '整体路径 15→40→55→50→60→verify dry-run PASS';
});
test('deploy_all.jetton', () => {
  const result = run([join(SCRIPTS, 'deploy_all.mjs'), '--mode', 'jetton'], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 0, 'jetton 模式失败：' + result.out.slice(-800));
  assert(result.out.includes('jettonMaster') && result.out.includes('jettonMint'), 'jetton 模式缺少 10/11 步骤');
  return 'Jetton 分步 10→11 dry-run PASS';
});

test('dryrun.80.release_team', () => {
  const result = run([join(SCRIPTS, '80_admin_ops.mjs'), '--action', 'release-team'], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 0, 'release-team dry-run 失败：' + result.out.slice(-700));
  for (const expected of ['op=release-team', 'dest=', 'admin_op.tolk']) assert(result.out.includes(expected), '缺少字段：' + expected);
  return 'release-team 摘要（dest/op，无需 round）';
});
test('dryrun.80.junxiang_set_root', () => {
  const root = '0x' + 'ef'.repeat(32);
  const result = run([join(SCRIPTS, '80_admin_ops.mjs'), '--action', 'junxiang-set-root', '--list', '3', '--root', root, '--total', '1000000000000'], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 0, 'junxiang-set-root dry-run 失败：' + result.out.slice(-900));
  for (const expected of ['listId=3', 'junxiang_op.tolk', 'junxiang-set-root', 'opcode=0x4a580001']) assert(result.out.includes(expected), '缺少字段：' + expected);
  return 'SetRoot 摘要（listId / root / 0x4a580001 / junxiang_op.tolk）';
});
test('dryrun.80.junxiang_set_root.requires_total', () => {
  const root = '0x' + 'ef'.repeat(32);
  const result = run([join(SCRIPTS, '80_admin_ops.mjs'), '--action', 'junxiang-set-root', '--list', '3', '--root', root], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 1 && result.out.includes('--total'), '缺少 --total 未被拒绝（exit ' + result.code + '）');
  return '缺 --total 拒绝（发布前余额核对必填）';
});
test('dryrun.15.fast_profile_env', () => {
  const result = run([join(SCRIPTS, '15_deploy_contracts.mjs')], { OPS_REGISTRY: tempRegistry, OPS_PARAMS: join(OPS_ROOT, 'config', 'testnet-fast.params.json') });
  assert(result.code === 0, '15 快测档 dry-run 失败：' + result.out.slice(-700));
  for (const expected of ['A9_TIMING_PREVIEW_SECONDS=10', 'A9_TIMING_STAKE_SECONDS=90', 'A9_TIMING_CANDLE_SECONDS=10', 'A9_TIMING_ABORT_TIMEOUT_SECONDS=60', 'A9_TIMING_FALLBACK_UNLOCK_SECONDS=60']) assert(result.out.includes(expected), '快测 env 缺失：' + expected);
  return '15 读取 testnet-fast.params.json → deploy-emulation 的 A9_TIMING_* 环境变量';
});
section('自测：广播脚本 dry-run 摘要（50/55/80）');
test('dryrun.50.summary', () => {
  const result = run([join(SCRIPTS, '50_fund_vaults.mjs'), '--all'], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 0, '50 dry-run 失败：' + result.out.slice(-700));
  for (const expected of ['dest=', 'value=', 'fund_jetton', 'A9']) assert(result.out.includes(expected), '缺少摘要字段：' + expected);
  assert(result.out.includes('forward_ton_amount 必须为 0'), '缺少 RC 注资 forward 0 提示');
  return '4 笔 fund_jetton 摘要（RC 82 亿 forward 0 + 8/5/5）';
});
test('dryrun.55.summary', () => {
  const result = run([join(SCRIPTS, '55_fund_ton.mjs')], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 0, '55 dry-run 失败：' + result.out.slice(-700));
  for (const expected of ['dest=', 'value=', 'fund_ton', 'TON']) assert(result.out.includes(expected), '缺少摘要字段：' + expected);
  return 'fund_ton 摘要（dest/value=整数 TON）';
});
test('dryrun.80.summary', () => {
  const result = run([join(SCRIPTS, '80_admin_ops.mjs'), '--action', 'retry-settlement', '--round', '1'], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 0, '80 dry-run 失败：' + result.out.slice(-700));
  for (const expected of ['dest=', 'op=', 'value/extra=', 'admin_op.tolk']) assert(result.out.includes(expected), '缺少摘要字段：' + expected);
  return 'retry-settlement 摘要（dest/op/value/round）';
});

section('自测：submit-candle（正例 + 窗口不一致负例）');
test('dryrun.80.submit_candle', () => {
  const obs = Math.floor(Date.now() / 1000) - 5 * 3600;
  const digest = '0x' + 'ab'.repeat(32);
  const result = run([join(SCRIPTS, '80_admin_ops.mjs'), '--action', 'submit-candle', '--round', '1', '--candle', '2', '--twap', '232000', '--digest', digest, '--observation-start', String(obs)], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 0, 'submit-candle dry-run 失败：' + result.out.slice(-900));
  for (const expected of ['candleIndex=2', 'periodStart=', 'opcode=0x52540003', 'dest=', 'twapUsdE8=232000']) {
    assert(result.out.includes(expected), '缺少字段：' + expected);
  }
  return '单根 K 线 dry-run 摘要 + 窗口自动推导';
});
test('dryrun.80.submit_candle_window_mismatch', () => {
  const obs = Math.floor(Date.now() / 1000) - 5 * 3600;
  const digest = '0x' + 'cd'.repeat(32);
  const result = run([join(SCRIPTS, '80_admin_ops.mjs'), '--action', 'submit-candle', '--round', '1', '--candle', '2', '--twap', '232000', '--digest', digest, '--observation-start', String(obs), '--periodStart', String(obs + 9999)], { OPS_REGISTRY: tempRegistry });
  assert(result.code === 1, '窗口不一致未被拦截（exit ' + result.code + '）');
  assert(result.out.includes('不一致') || result.out.includes('observationStart'), '缺少窗口校验错误信息');
  return 'periodStart 不匹配 → ops 层拦截，未进入 acton';
});

section('自测：主网仪式 dry-run（v11 阶段）');
test('ceremony.dry_run', () => {
  const result = run([join(SCRIPTS, '90_mainnet_ceremony.mjs'), '--dry-run'], { OPS_REGISTRY: join(temp, 'ceremony.registry.json') });
  assert(result.code === 0, '仪式 dry-run 失败：' + result.out.slice(-800));
  for (const phase of ['P0', 'P0.5', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']) assert(result.out.includes('[OK] ' + phase + ' DRY_RUN'), '阶段未 dry-run：' + phase);
  assert(result.out.includes('8200000000000000000'), 'P4 缺少 82 亿断言');
  assert(!existsSync(join(temp, 'ceremony.registry.json')), 'dry-run 不应写登记表');
  return 'P0..P6 DRY_RUN，未写登记表';
});

section('自测：全部脚本语法');
const scriptFiles = ['00_preflight.mjs', '10_deploy_jetton.mjs', '11_mint_and_lock_jetton.mjs', '15_deploy_contracts.mjs', '30_deploy_round_controller.mjs', '40_init_params.mjs', '50_fund_vaults.mjs', '55_fund_ton.mjs', '60_verify_and_register.mjs', '80_admin_ops.mjs', '90_mainnet_ceremony.mjs', '91_deploy_multisig.mjs', '92_multisig_order.mjs', 'deploy_all.mjs', 'verify_deployment.mjs', 'reconcile.mjs', 'monitor_check.mjs', 'announcement.mjs', 'keeper-candles.mjs', 'fasttest-runner.mjs', 'lib/ledger.mjs'];
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
