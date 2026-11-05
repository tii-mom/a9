#!/usr/bin/env node
/** 80 — 管理员最小权限操作：开轮/关窗/暂停/恢复/结算/技术终止/提交 K 线。 */

import { requireConfirm, flag, str } from './lib/cli.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress } from './lib/step.mjs';
import { commandTemplate, runCommand, substitute } from './lib/toolchain.mjs';
import { getTonBalance, runGetMethod, stackItemToBigInt } from './lib/ton.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, registry } = bootstrap({
  id: '80',
  title: '管理员/任何人操作（最小权限）',
  dependsOn: ['register'],
});

const controller = resolveContractAddress(registry, 'roundController');
const action = str(args, 'action', str(args, '_', '') ? String(args._[0]) : 'status');
const roundId = Number(str(args, 'round', '0'));
const opcodes = params.permissions.opcodes;

const ACTIONS = {
  status: { op: null, mutating: false, desc: '读取协议/轮次状态（只读）' },
  'open-round': { op: opcodes.OpenRound, mutating: true, desc: '开轮：锁定 target = max(P0×2^tier, 2×开窗 24h TWAP)，仅 owner' },
  'close-staking': { op: opcodes.CloseStaking, mutating: true, desc: '关报名：正常到点或触价提前关窗' },
  'pause-oracle': { op: opcodes.PauseOracle, mutating: true, desc: '暂停预言机（技术故障，不判负、不销毁）' },
  'resume-oracle': { op: opcodes.ResumeOracle, mutating: true, desc: '恢复预言机：重新收满 18 根 K 线' },
  'finalize-round': { op: opcodes.FinalizeRound, mutating: true, desc: '结算：成功/失败/无质押分支' },
  'start-observation': { op: opcodes.StartObservation, mutating: true, desc: '开始观察（测试网手动入口）' },
  'submit-candle': { op: opcodes.SubmitCandle, mutating: true, desc: '提交单根 4h K 线（测试网手动模式）' },
  'abort-technical': { op: opcodes.AbortTechnical, mutating: true, desc: '技术终止：连续暂停 14 天或观察超时 7 天，任何人可触发' },
  'retry-pending': { op: opcodes.RetryPendingActions, mutating: true, desc: '重试 pending 的跨合约动作' },
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
kv('说明', spec.desc);
kv('opcode', spec.op || '（只读）');
if (!controller) {
  fail('RoundController 未登记：先完成部署或 --adopt');
  process.exit(finish());
}

section('只读状态');
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

if (action === 'status') {
  printNextSteps(['写操作示例：node scripts/80_admin_ops.mjs --action pause-oracle（需 OPS_EXECUTE=1 与 OPS_CONFIRM=YES）']);
  process.exit(finish({ 结果: 'READ_ONLY' }));
}

section('执行前检查');
if (spec.mutating && execute) requireConfirm('管理员操作 ' + action);
if (roundId < 1 && !['abort-technical', 'retry-pending', 'pause-oracle', 'resume-oracle'].includes(action)) {
  fail('该动作需要 --round <1..10>');
  process.exit(finish());
}
if (action === 'abort-technical') {
  detail('技术终止的合法条件（V6.1）：连续暂停 >= 14 天，或观察结束超时 >= 7 天。');
  detail('不满足条件时合约会 revert；提前触发失败会被审计日志记录。任何地址均可触发，owner 不独占。');
}
if (action === 'submit-candle') {
  const candleIndex = str(args, 'candle');
  const periodStart = str(args, 'periodStart');
  const periodEnd = str(args, 'periodEnd');
  const twap = str(args, 'twap');
  const digest = str(args, 'digest', '0x' + '00'.repeat(32));
  if (candleIndex === undefined || !periodStart || !periodEnd || !twap) {
    fail('submit-candle 需要 --candle <0..17> --periodStart <unix> --periodEnd <unix> --twap <USD_E8> [--digest <hex32>]');
    process.exit(finish());
  }
  kv('candle', candleIndex + ' / ' + (Number(periodStart) - Number(periodStart)) + '');
}

const extraParts = [];
if (action === 'open-round') {
  const twap = str(args, 'twap24h', '0');
  extraParts.push('--twap24h ' + twap);
  detail('注意：开窗交易中 target 会按 max(P0×2^tier, 2×TWAP24h) 锁定；TWAP24h 由 keeper 提供（测试网手动模式）。');
}
if (action === 'close-staking') extraParts.push('--twap1h ' + str(args, 'twap1h', '0'));
if (action === 'submit-candle') {
  for (const name of ['candle', 'periodStart', 'periodEnd', 'twap', 'digest']) {
    const value = str(args, name);
    if (value !== undefined) extraParts.push('--' + name + ' ' + value);
  }
}
if (action === 'pause-oracle') extraParts.push('--reason ' + str(args, 'reason', '0'));

const rendered = substitute(commandTemplate(params, 'adminOp'), {
  contractsDir: params.toolchain.contractsDir,
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
