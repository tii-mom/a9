#!/usr/bin/env node
/** deploy_all — 按 deployPlan 顺序串联执行部署脚本（默认 dry-run；EXECUTE 需显式确认）。 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { str } from './lib/cli.mjs';
import { loadAndValidate } from './lib/config.mjs';
import { section, kv, ok, fail, warn, info, detail, table, dryRunBanner, summary } from './lib/log.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const execute = process.env.OPS_EXECUTE === '1';
const only = str(process.argv.slice(2).reduce((acc, token, index, all) => {
  if (token === '--from') acc.from = all[index + 1];
  if (token.startsWith('--from=')) acc.from = token.slice('--from='.length);
  if (token === '--to') acc.to = all[index + 1];
  if (token.startsWith('--to=')) acc.to = token.slice('--to='.length);
  return acc;
}, {}), 'from');

const { params, errors, digest } = loadAndValidate();
if (errors.length) {
  for (const message of errors) fail(message);
  process.exit(1);
}

section('deploy_all：测试网部署编排');
dryRunBanner(execute);
kv('配置哈希', digest);
kv('登记表', process.env.OPS_REGISTRY || 'ops/config/testnet.registry.json');

const args = process.argv.slice(2);
const getArg = (name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--' + name) return args[i + 1];
    if (args[i].startsWith('--' + name + '=')) return args[i].slice(name.length + 3);
  }
  return null;
};
const from = getArg('from');
const to = getArg('to');
const plan = params.deployPlan.filter((item) => item.script !== 'deploy_all.mjs');
let started = !from;
const executed = [];
const failed = [];

section('部署顺序');
table(['step', 'id', 'script', '依赖'], plan.map((item) => [item.step, item.id, item.script, (item.dependsOn || []).join(',')]));

for (const item of plan) {
  if (!started) {
    if (item.id === from || String(item.step) === from) started = true;
    else { info('跳过 ' + item.id + '（--from ' + from + '）'); continue; }
  }
  const childArgs = [join(scriptsDir, item.script)];
  if (execute) childArgs.push('--execute');
  if (getArg('all') && item.id === 'funding') childArgs.push('--all');
  section('step ' + item.step + ' — ' + item.id);
  detail('node ' + childArgs.join(' '));
  const result = spawnSync(process.execPath, childArgs, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
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
if (failed.length === 0) ok(execute ? '部署编排完成；立即运行 verify_deployment.mjs 与 60 地址簿核对。' : 'dry-run 编排完成；未发任何链上消息。');
const code = summary({ 模式: execute ? 'EXECUTE' : 'DRY-RUN', 配置哈希: digest });
process.exit(code || failed.length ? (failed.length ? 1 : 0) : 0);
