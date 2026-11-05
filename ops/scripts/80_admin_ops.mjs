#!/usr/bin/env node
/** 80 — 管理员/keeper 操作：开轮/关窗/暂停恢复/结算/技术终止/K 线提交（最小权限，默认 dry-run）。 */

import { existsSync, readFileSync } from 'node:fs';
import { requireConfirm, flag, str } from './lib/cli.mjs';
import { resolvePath } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveAddress, signerWallet } from './lib/step.mjs';
import { commandTemplate, hasCommand, runCommand, substitute } from './lib/toolchain.mjs';
import { getTonBalance, runGetMethod, stackItemToBigInt } from './lib/ton.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, registry } = bootstrap({
  id: '80',
  title: '管理员/keeper 操作（最小权限）',
  dependsOn: ['register'],
});

const controller = resolveAddress(registry, params, 'roundController', 'round-controller.addr');
const signer = signerWallet(params);
const action = str(args, 'action', str(args, '_', '') ? String(args._[0]) : 'status');
const roundId = Number(str(args, 'round', '0'));
const opcodes = params.permissions.opcodes;
const CANDLE_SECONDS = Number(params.timeline.candleSeconds);

const ACTIONS = {
  status: { op: null, mutating: false, desc: '读取协议/轮次状态（只读）' },
  'open-round': { op: opcodes.OpenRound, mutating: true, desc: '开轮：锁定 target = max(P0×2^tier, 2×开窗 24h TWAP)，仅 owner' },
  'close-staking': { op: opcodes.CloseStaking, mutating: true, desc: '关报名：正常到点或触价提前关窗' },
  'pause-oracle': { op: opcodes.PauseOracle, mutating: true, desc: '暂停预言机（技术故障，不判负、不销毁）' },
  'resume-oracle': { op: opcodes.ResumeOracle, mutating: true, desc: '恢复预言机：重新收满 24 根 K 线' },
  'finalize-round': { op: opcodes.FinalizeRound, mutating: true, desc: '结算：成功/失败/无质押分支' },
  'start-observation': { op: opcodes.StartObservation, mutating: true, desc: '开始观察（测试网手动入口）' },
  'submit-candle': { op: opcodes.SubmitCandle, mutating: true, desc: '提交单根/多根 1h K 线（测试网手动模式，body 0x52540003）' },
  'oracle-candle': { op: opcodes.OracleCandleVerified, mutating: true, unsupported: true, desc: 'OracleCandleVerified（0x52540004）；当前 RC 无 handler，仅 phase-2；本版本禁止广播' },
  'abort-technical': { op: opcodes.AbortTechnical, mutating: true, desc: '技术终止：连续暂停 14 天或观察超时 7 天，任何人可触发' },
  'retry-pending': { op: opcodes.RetryPendingActions, mutating: true, desc: '重试 pending 的跨合约动作（RetryPendingActions 无权限校验，任何人可触发）' },
};

const FORBIDDEN = {
  'modify-target': '禁止：管理员不得修改已开轮目标价（D-24 / docs/00 §1）',
  'cancel-stake': '禁止：不存在取消质押通道（V5.3）；唯一退款路径是 TECHNICAL_ABORTED',
  'manual-refund': '禁止：管理员不得手工退款/转移用户质押本金（D-24）',
  'set-code': '禁止：RoundController 不可升级（D-24，无代理/setCode）',
  'force-succeed': '禁止：管理员不得把失败轮改为成功，终态不可逆（docs/02 §1）',
  'skip-round': '禁止：不允许跳过未终态轮次（docs/02 §3）',
};

section('操作请求');
kv('动作', action);
kv('RoundController', controller || '（未登记）');
kv('roundId', roundId);
kv('运行模式', execute ? 'EXECUTE' : 'DRY-RUN');
kv('签名钱包（A9_SIGNER_WALLET）', signer);

if (FORBIDDEN[action]) {
  fail(FORBIDDEN[action]);
  info('权限边界见 ops/runbooks/04_key_custody_admin.md；如确需变更规则，只能通过新部署 + 社区公告。');
  finish({ 结果: 'REJECTED_BY_POLICY' });
  process.exit(1);
}
const spec = ACTIONS[action];
if (!spec) {
  fail('未知动作：' + action + '；可用：' + Object.keys(ACTIONS).join(', '));
  process.exit(finish());
}
if (spec.unsupported) {
  fail(spec.desc);
  info('oracle-candle 仅可用于消息体/对账联调，当前 RC 不可升级且无该 handler；禁止广播。');
  process.exit(finish({ 结果: 'UNSUPPORTED' }));
}
kv('说明', spec.desc);
kv('opcode', spec.op || '（只读）');
if (!controller) {
  fail('RoundController 未登记：先完成部署或 --adopt');
  process.exit(finish());
}

section('只读状态');
if (execute || flag(args, 'online')) {
  try {
    const balance = await getTonBalance(params, controller);
    kv('RC TON 余额', balance.balanceNano + ' nanoTON（state ' + balance.state + '）');
    if (Number(balance.balanceNano) < 0.5e9) warn('RC TON 余额低于 0.5 TON：可能无法支付跨合约消息 gas');
    if (roundId >= 1) {
      const response = await runGetMethod(params, controller, 'get_round', [roundId]);
      const stack = (response.stack || []).map((item) => (item && item.type === 'num' ? item.value : item && item.type));
      kv('get_round(' + roundId + ') stack', JSON.stringify(stack).slice(0, 600));
      if (stack.length > 0) {
        const statuses = ['UNOPENED', 'PREVIEW', 'STAKING_OPEN', 'STAKING_CLOSED', 'OBSERVING', 'ORACLE_PAUSED', 'SETTLING_SUCCESS', 'SETTLING_FAILURE', 'SUCCEEDED', 'FAILED_PERMANENT', 'TECHNICAL_ABORTED'];
        const statusIndex = Number(stackItemToBigInt({ value: stack[1] }));
        if (!Number.isNaN(statusIndex) && statuses[statusIndex]) kv('轮次状态', statuses[statusIndex]);
      }
    }
  } catch (error) {
    warn('只读状态读取失败（RPC 不可用？）：' + String(error.message || error));
  }
} else {
  info('dry-run：跳过链上只读读取（加 --online 可读；EXECUTE 时自动读取）');
}

if (action === 'status') {
  printNextSteps(['写操作示例：node scripts/80_admin_ops.mjs --action pause-oracle --round 3（需 OPS_EXECUTE=1 与 OPS_CONFIRM=YES）']);
  process.exit(finish({ 结果: 'READ_ONLY' }));
}

section('执行前检查');
if (spec.mutating && execute) requireConfirm('管理员操作 ' + action);
if (roundId < 1 && !['abort-technical', 'retry-pending', 'pause-oracle', 'resume-oracle'].includes(action)) {
  fail('该动作需要 --round <1..10>');
  process.exit(finish());
}
if (action === 'retry-pending') {
  detail('RetryPendingActions 无权限校验，任何人可触发；入口要求消息 value ≥ 0.3 TON（admin_op 统一按 0.3 TON 发送）。');
}
if (action === 'abort-technical') {
  detail('技术终止的合法条件：连续暂停 >= 14 天，或观察结束超时 >= 7 天。');
  detail('不满足条件时合约会 revert；提前触发失败会被审计日志记录。任何地址均可触发，owner 不独占。');
}

function toInt(value, label) {
  const text = String(value ?? '').trim();
  if (!/^-?[0-9]+$/.test(text)) throw new Error(label + ' 必须为整数：' + value);
  return BigInt(text);
}

function normalizeDigest(value) {
  let text = String(value ?? '').trim();
  if (text.startsWith('0x') || text.startsWith('0X')) text = text.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new Error('digest 必须为 64 位 hex（可带 0x 前缀）：' + value);
  return '0x' + text.toLowerCase();
}

async function fetchObservationStart() {
  const explicit = str(args, 'observation-start') || str(args, 'observationStart');
  if (explicit) {
    const value = Number(explicit);
    if (!Number.isFinite(value) || value <= 0) throw new Error('--observationStart 非法：' + explicit);
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const base = (process.env.OPS_WORKER_BASE_URL || params.monitoring.workerBaseUrlDefault).replace(/\/$/, '');
  try {
    const response = await fetch(base + '/api/rounds/' + roundId, { signal: AbortSignal.timeout(10000) });
    const json = await response.json();
    if (!json || json.ok !== true || !json.data) throw new Error('API 返回错误');
    const value = Number(json.data.observationStart);
    if (!Number.isFinite(value) || value <= 0) throw new Error('API observationStart 为空');
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  } catch (error) {
    throw new Error('无法从 API 读取 observationStart：' + String(error.message || error) + '；请提供 --observation-start <unix秒>');
  }
}

function loadCandles() {
  const fromJson = str(args, 'from-json');
  if (fromJson) {
    const path = resolvePath(fromJson);
    if (!existsSync(path)) throw new Error('--from-json 文件不存在：' + fromJson);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.candles;
    if (!Array.isArray(list) || !list.length) throw new Error('--from-json 需要 candles 数组');
    return list.map((item, index) => ({
      candleIndex: Number(item.candleIndex !== undefined ? item.candleIndex : item.index !== undefined ? item.index : index),
      twapUsdE8: item.twapUsdE8 !== undefined ? item.twapUsdE8 : item.twap,
      digest: item.digest,
    }));
  }
  const start = Number(str(args, 'candle', '0'));
  const count = Number(str(args, 'count', '1'));
  if (!Number.isFinite(count) || count < 1) throw new Error('--count 必须 >= 1');
  const twaps = str(args, 'twaps');
  const digests = str(args, 'digests');
  const list = [];
  for (let offset = 0; offset < count; offset++) {
    let twap;
    let digest;
    if (count === 1) {
      twap = str(args, 'twap');
      digest = str(args, 'digest');
    } else {
      if (!twaps || !digests) throw new Error('--count > 1 时需要 --twaps a,b,c 与 --digests h1,h2,h3（与 count 等长）');
      const twapList = twaps.split(',').map((item) => item.trim());
      const digestList = digests.split(',').map((item) => item.trim());
      if (twapList.length !== count || digestList.length !== count) throw new Error('twaps/digests 数量必须等于 count');
      twap = twapList[offset];
      digest = digestList[offset];
    }
    list.push({ candleIndex: start + offset, twapUsdE8: twap, digest });
  }
  return list;
}

async function handleSubmitCandles() {
  if (roundId < 1 || roundId > 10) {
    fail('roundId must be 1..10（当前 ' + roundId + '）');
    process.exit(finish());
  }
  if (!hasCommand(params, 'submitCandle')) {
    fail('缺少 submitCandle 命令模板（检查 config/testnet.params.json toolchain.commands）');
    process.exit(finish());
  }
  let observationStart;
  try {
    observationStart = await fetchObservationStart();
  } catch (error) {
    fail(String(error.message || error));
    process.exit(finish());
  }
  kv('observationStart', observationStart + '（' + new Date(observationStart * 1000).toISOString() + '）');
  let entries;
  try {
    entries = loadCandles();
  } catch (error) {
    fail(String(error.message || error));
    process.exit(finish());
  }
  if (execute) requireConfirm('K 线提交（' + entries.length + ' 根，不可撤销）');

  const explicitStart = str(args, 'periodStart');
  const explicitEnd = str(args, 'periodEnd');
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (const entry of entries) {
    const candleIndex = Number(entry.candleIndex);
    if (!Number.isInteger(candleIndex) || candleIndex < 0 || candleIndex > Number(params.timeline.candleCount) - 1) {
      fail('candleIndex 必须为 0..' + (Number(params.timeline.candleCount) - 1) + '：' + entry.candleIndex);
      process.exit(finish());
    }
    const periodStart = observationStart + candleIndex * CANDLE_SECONDS;
    const periodEnd = periodStart + CANDLE_SECONDS;
    if (explicitStart !== undefined && Number(explicitStart) !== periodStart) {
      fail('periodStart 与 observationStart + candleIndex × ' + CANDLE_SECONDS + ' 不一致：期望 ' + periodStart + '，收到 ' + explicitStart);
      process.exit(finish());
    }
    if (explicitEnd !== undefined && Number(explicitEnd) !== periodEnd) {
      fail('periodEnd 必须等于 periodStart + ' + CANDLE_SECONDS + '：期望 ' + periodEnd + '，收到 ' + explicitEnd);
      process.exit(finish());
    }
    let twap;
    let digest;
    try {
      twap = toInt(entry.twapUsdE8, 'twapUsdE8');
      digest = normalizeDigest(entry.digest);
    } catch (error) {
      fail(String(error.message || error));
      process.exit(finish());
    }
    if (twap <= 0n) {
      fail('twapUsdE8 必须 > 0：' + twap);
      process.exit(finish());
    }
    if (now < periodEnd) {
      if (execute) {
        fail('K 线未收盘（now=' + now + ' < periodEnd=' + periodEnd + '），合约会拒绝；请等 periodEnd 后再提交');
        process.exit(finish());
      }
      warn('K 线尚未收盘（now=' + now + ' < periodEnd=' + periodEnd + '）；dry-run 继续，EXECUTE 会被拦');
    }
    const rendered = substitute(commandTemplate(params, 'submitCandle'), {
      contractsDir: params.toolchain.contractsDir,
      signerWallet: signer,
      roundController: controller,
      roundId: String(roundId),
      candleIndex: String(candleIndex),
      periodStart: String(periodStart),
      periodEnd: String(periodEnd),
      twapUsdE8: twap.toString(),
      digest,
    });
    rows.push({ candleIndex, periodStart, periodEnd, twap, digest, rendered });
    detail('dest=' + controller + ' roundId=' + roundId + ' candleIndex=' + candleIndex + ' periodStart=' + periodStart + ' periodEnd=' + periodEnd + ' twapUsdE8=' + twap + ' digest=' + digest);
  }

  table(['candle', 'periodStart', 'periodEnd', 'twapUsdE8', 'digest'], rows.map((row) => [row.candleIndex, row.periodStart, row.periodEnd, row.twap.toString(), row.digest]));

  if (!execute) {
    section('消息摘要');
    detail('op=submit-candle body opcode=0x52540003 extra=0 roundId=' + roundId + ' count=' + rows.length);
    detail('signer=' + signer + ' dest=' + controller);
    detail('示例命令：' + rows[0].rendered);
    printNextSteps(['真实广播：OPS_EXECUTE=1 OPS_CONFIRM=YES + 上述 A9_* env（脚本模板已带上）', '每小时提交一根；24 根齐备后 ≥16 达标为成功、≤15 失败。']);
    process.exit(finish({ 结果: 'DRY_RUN', 动作: 'submit-candle', 根数: rows.length }));
  }

  let submitted = 0;
  for (const row of rows) {
    const result = runCommand(row.rendered, { execute: true });
    if (result.status !== 0) {
      fail('第 ' + row.candleIndex + ' 根提交失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 400));
      process.exit(finish({ 提交成功: submitted, 失败candle: row.candleIndex }));
    }
    submitted++;
    ok('candle ' + row.candleIndex + ' 已提交（等待链上确认）');
  }
  registry.notes = registry.notes || [];
  registry.notes.push(new Date().toISOString() + ' submit-candle round=' + roundId + ' count=' + submitted);
  printNextSteps(['用 /api/rounds/' + roundId + ' 或 get_round 核对 candlesSeen/qualifiedCandles。']);
  process.exit(finish({ 结果: 'SUBMITTED', 动作: 'submit-candle', 成功: submitted }));
}

if (action === 'submit-candle') {
  await handleSubmitCandles();
}

const extraParts = [];
if (action === 'open-round') {
  const twap = str(args, 'twap24h', '0');
  extraParts.push(twap);
  detail('admin_op 位置参数：open-round <roundId> <twap24h>；target = max(P0×2^tier, 2×TWAP24h)，TWAP24h 由 keeper 提供。');
}
if (action === 'close-staking') extraParts.push(str(args, 'twap1h', '0'));
if (action === 'pause-oracle') extraParts.push(str(args, 'reason', '0'));
detail('dest=' + controller + ' op=' + action + ' round=' + (roundId || 0) + ' value/extra=' + (extraParts.join(' ') || '（无）') + ' signer=' + signer);

if (!hasCommand(params, 'adminOp')) {
  fail('缺少 adminOp 命令模板（检查 config/testnet.params.json toolchain.commands）');
  process.exit(finish());
}

const rendered = substitute(commandTemplate(params, 'adminOp'), {
  contractsDir: params.toolchain.contractsDir,
  signerWallet: signer,
  roundController: controller,
  op: action,
  roundId: String(roundId || 0),
  extra: extraParts.join(' '),
});
section('执行计划');
detail('命令：' + rendered);
if (!execute) {
  detail('dry-run：不广播。真实执行：OPS_EXECUTE=1 OPS_CONFIRM=YES node scripts/80_admin_ops.mjs --action ' + action + ' --round ' + (roundId || 0));
  printNextSteps(['执行后核对链上事件与轮次状态；任何异常按 runbooks/03_monitoring_alerting.md 升级。']);
  process.exit(finish({ 结果: 'DRY_RUN', 动作: action }));
}

const result = runCommand(rendered, { execute: true });
if (result.status !== 0) {
  fail('操作失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 500));
  process.exit(finish({ 结果: 'FAILED', 动作: action }));
}
ok('操作已提交：' + action + '（等待链上确认后核对事件/状态）');
registry.notes = registry.notes || [];
registry.notes.push(new Date().toISOString() + ' admin op ' + action + ' round=' + roundId + ' tx=' + (str(args, 'tx') || 'unknown'));
process.exit(finish({ 结果: 'SUBMITTED', 动作: action }));
