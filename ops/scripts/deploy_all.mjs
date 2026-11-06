#!/usr/bin/env node
/** deploy_all — 按 deployPlan 串联执行（默认 dry-run）。模式：whole=整体 deploy-emulation；jetton=Jetton 分步。 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndValidate } from './lib/config.mjs';
import { section, kv, ok, fail, warn, info, detail, table, dryRunBanner, summary } from './lib/log.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const execute = process.env.OPS_EXECUTE === '1';
const args = process.argv.slice(2);
const getArg = (name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--' + name) return args[i + 1];
    if (args[i].startsWith('--' + name + '=')) return args[i].slice(name.length + 3);
  }
  return null;
};

const mode = getArg('mode') || 'whole';
if (!['whole', 'jetton'].includes(mode)) {
  console.error('未知模式：' + mode + '（支持 whole / jetton）');
  process.exit(1);
}
const from = getArg('from');
const to = getArg('to');
const { params, errors, digest } = loadAndValidate();
if (errors.length) {
  for (const message of errors) fail(message);
  process.exit(1);
}

section('deploy_all：部署编排（V7 时间 / v10 合约）');
dryRunBanner(execute);
kv('模式', mode === 'whole' ? 'whole（15 整体部署 deploy-emulation）' : 'jetton（仅 Jetton 分步 10/11）');
kv('配置哈希', digest);
kv('登记表', process.env.OPS_REGISTRY || 'ops/config/testnet.registry.json');

const plan = params.deployPlan.filter((item) => {
  if (item.script === 'deploy_all.mjs') return false;
  const modes = item.modes || ['whole'];
  return modes.includes(mode);
});
let started = !from;
const executed = [];
const failed = [];

section('部署顺序');
table(['step', 'id', 'script', '依赖'], plan.map((item) => [item.step, item.id, item.script, (item.dependsOn || []).join(',')]));
detail(mode === 'whole'
  ? 'whole 模式（v10）：15 整体部署 = JettonMaster → mint 100 亿（mint-once）→ RoundController → 钱包推导核对 → RC 注资 82 亿（forward 0）；随后 40/55/50/60/verify。'
  : 'jetton 模式：只跑 10/11（Jetton 分步部署与 mint-once）；RC 请用 15 整体部署。');

for (const item of plan) {
  if (!started) {
    if (item.id === from || String(item.step) === from) started = true;
    else { info('跳过 ' + item.id + '（--from ' + from + '）'); continue; }
  }
  const childArgs = [join(scriptsDir, item.script)];
  if (execute) childArgs.push('--execute');
  if (!execute && item.id === 'verify') childArgs.push('--offline');
  if (item.id === 'funding') childArgs.push('--all');
  if (item.id === 'funding' && execute) childArgs.push('--probe');
  section('step ' + item.step + ' — ' + item.id);
  detail('node ' + childArgs.join(' '));
  const result = spawnSync(process.execPath, childArgs, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    if (item.id === 'verify' && !execute) {
      warn('dry-run 验收返回非 0（未部署属预期；部署后重跑 verify_deployment.mjs）');
      break;
    }
    if (item.id === 'verify') {
      warn('验收脚本返回非 0（可先完成链上初始化后重跑）');
      failed.push(item.id);
      break;
    }
    fail(item.id + ' 失败（exit ' + result.status + '）；后续步骤已停止。');
    failed.push(item.id);
    break;
  }
  executed.push(item.id);
  if (to && (item.id === to || String(item.step) === to)) { info('已到 --to ' + to + '，停止。'); break; }
}

section('编排结果');
kv('执行步骤', executed.join(', ') || '（无）');
kv('失败步骤', failed.join(', ') || '（无）');
if (failed.length === 0) ok(execute ? '部署编排完成；立即运行 verify_deployment.mjs 与 60 地址簿核对。' : 'dry-run 编排完成；未发任何链上消息、未改写登记表。');
const code = summary({ 模式: execute ? 'EXECUTE' : 'DRY-RUN', 部署模式: mode, 配置哈希: digest });
process.exit(failed.length ? 1 : (code || 0));
