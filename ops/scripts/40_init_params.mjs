#!/usr/bin/env node
/** 40 — 参数初始化校验：生成参数快照、比对链上 get_protocol_config（可选在线）。 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { flag, str } from './lib/cli.mjs';
import { RECORDS_DIR, writeJSON } from './lib/config.mjs';
import { bootstrap, finish, printProtocolConfigExpected, printNextSteps, resolveContractAddress } from './lib/step.mjs';
import { commandTemplate, hasCommand, runCommand, substitute } from './lib/toolchain.mjs';
import { runGetMethod, stackItemToBigInt } from './lib/ton.mjs';
import { expectedProtocolConfig } from './lib/verify.mjs';
import { section, kv, ok, fail, warn, info, detail, table } from './lib/log.mjs';

const { args, execute, params, digest, registry } = bootstrap({
  id: '40',
  title: '参数初始化与链上配置校验',
  dependsOn: ['roundController'],
});

const controller = resolveContractAddress(registry, 'roundController');
const expected = expectedProtocolConfig(params);
const online = flag(args, 'online') || execute;

section('参数快照');
kv('RoundController', controller || '（未登记）');
kv('paramsDigest', digest);
kv('configVersion', params.meta.configVersion);
kv('riskDisclosureVersion', params.risk.disclosureVersion);
printProtocolConfigExpected(params);

mkdirSync(RECORDS_DIR, { recursive: true });
const snapshotFile = join(RECORDS_DIR, 'params-snapshot.json');
writeJSON(snapshotFile, {
  generatedAt: new Date().toISOString(),
  source: params.__file,
  paramsDigest: digest,
  expectedProtocolConfig: expected,
  opcodes: params.permissions.opcodes,
  tiers: params.price.ladderRefUsdE8,
});
ok('参数快照已写入：' + snapshotFile);

if (!controller) {
  if (execute) {
    fail('RoundController 未登记：先执行 30_deploy_round_controller.mjs');
    process.exit(finish());
  }
  warn('RoundController 未登记：dry-run 仅生成参数快照，跳过链上比对');
  printNextSteps(['部署后重跑：node scripts/40_init_params.mjs --execute --online']);
  process.exit(finish({ 模式: 'DRY-RUN（未部署）', 快照: snapshotFile }));
}

if (execute && hasCommand(params, 'initParams')) {
  const rendered = substitute(commandTemplate(params, 'initParams'), {
    contractsDir: params.toolchain.contractsDir,
    initDataFile: join(RECORDS_DIR, 'round-controller.init.json'),
  });
  detail('初始化命令：' + rendered);
  const result = runCommand(rendered, { execute });
  if (result.status !== 0) {
    fail('参数初始化命令失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 500));
    process.exit(finish());
  }
  ok('参数初始化命令执行完成');
} else if (execute) {
  warn('整体部署已完成 RC 初始化；本步骤只做链上参数校验，不发送初始化交易');
}

if (!online) {
  info('dry-run：跳过链上 get_protocol_config 比对；加 --online 可只读比对。');
  printNextSteps(['下一步：node scripts/70_bind_roles.mjs（一次性 InitController）']);
  process.exit(finish({ 模式: 'DRY-RUN', 快照: snapshotFile }));
}

section('链上配置比对（get_protocol_config）');
try {
  const response = await runGetMethod(params, controller, 'get_protocol_config');
  const stack = response.stack || [];
  if (stack.length < 22) {
    warn('返回栈长度 ' + stack.length + '（预期 >= 22），跳过逐字段比对；请用 Acton rpc 人工核对');
  } else {
    const numericIndexes = [
      [5, 'p0UsdE8'], [6, 'priceMultiplier'], [7, 'roundRewardRaw'], [8, 'teamRoundRaw'],
      [9, 'minStakeRaw'], [10, 'maxStakePerAddressBps'], [11, 'maxTotalStakeRaw'],
      [12, 'previewSeconds'], [13, 'stakeDurationSeconds'], [14, 'candleSeconds'],
      [15, 'candleCount'], [16, 'minQualifiedCandles'], [17, 'observationSeconds'],
      [18, 'techAbortPauseSeconds'], [19, 'techAbortObservationTimeout'], [20, 'riskDisclosureVersion'],
      [21, 'configVersion'],
    ];
    const rows = [];
    let failures = 0;
    for (const [index, key] of numericIndexes) {
      const actual = stackItemToBigInt(stack[index]);
      const expectedValue = String(expected[key]);
      const same = actual !== null && actual.toString() === expectedValue;
      if (!same) failures++;
      rows.push([key, expectedValue, actual === null ? '（无法解析）' : actual.toString(), same ? 'PASS' : 'FAIL']);
    }
    table(['字段', '期望', '链上', '结果'], rows);
    if (failures === 0) ok('链上数值配置全部匹配');
    else fail(failures + ' 个字段不匹配：不得开轮，先修正参数/重部署');
    if (failures > 0) process.exit(finish({ 模式: 'EXECUTE' }));
  }
} catch (error) {
  warn('链上配置读取失败：' + String(error.message || error));
  warn('请用 acton rpc 人工核对 get_protocol_config；未核对前不得 OpenRound。');
}

printNextSteps(['下一步：node scripts/70_bind_roles.mjs（一次性 InitController，需双人核对）']);
process.exit(finish({ 模式: execute ? 'EXECUTE' : 'DRY-RUN（online）', 快照: snapshotFile }));
