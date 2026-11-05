/** 所有脚本共用的启动流程：参数校验 → 依赖检查 → 执行开关 → 汇总。 */

import { loadAndValidate } from './config.mjs';
import { isExecute, parseArgs } from './cli.mjs';
import { loadRegistry } from './registry.mjs';
import { toolchainStatus } from './toolchain.mjs';
import { dryRunBanner, detail, err, fail, kv, section, step, summary, warn } from './log.mjs';

const DEP_TO_CONTRACT = {
  preflight: null,
  jettonMaster: 'jettonMaster',
  jettonMint: 'jettonMaster',
  teamVault: 'teamVault',
  roundController: 'roundController',
  params: 'roundController',
  roles: 'roundController',
  funding: 'teamVault',
  register: 'roundController',
};

export function bootstrap({ id, title, dependsOn = [] }) {
  const args = parseArgs();
  const execute = isExecute(args);
  step(id, title);
  dryRunBanner(execute);
  console.log('');

  const { params, errors, warnings, digest } = loadAndValidate();
  if (errors.length) {
    for (const message of errors) fail('参数不变量：' + message);
    err('参数校验失败，终止（先修正 ops/config/testnet.params.json）。');
    process.exit(1);
  }
  for (const message of warnings) warn(message);
  const registry = loadRegistry();
  const toolchain = toolchainStatus(params);

  section('上下文');
  kv('参数文件', params.__file);
  kv('配置哈希', digest);
  kv('登记表', process.env.OPS_REGISTRY || 'ops/config/testnet.registry.json');
  kv('登记状态', registry.status);
  kv('运行模式', execute ? 'EXECUTE（真实链上操作）' : 'DRY-RUN（默认）');
  kv('工具链', toolchain.adapter + (toolchain.binPath ? ' @ ' + toolchain.binPath : '（未安装）'));

  const missing = [];
  for (const dependency of dependsOn) {
    const contractKey = DEP_TO_CONTRACT[dependency];
    if (!contractKey) continue;
    const address = registry.contracts[contractKey] && registry.contracts[contractKey].address;
    if (!address) missing.push(dependency + '（缺少 ' + contractKey + ' 地址）');
  }
  if (missing.length) {
    const message = '前置步骤未完成：' + missing.join('、');
    if (execute) {
      err(message + '。请先按 runbooks/01_deploy_testnet.md 顺序执行，或用 --adopt 登记已知地址。');
      process.exit(1);
    }
    warn(message + '（dry-run 继续，仅打印计划）');
  }

  return { args, execute, params, digest, registry, toolchain };
}

export function printProtocolConfigExpected(params) {
  section('预期链上配置（V6.2）');
  kv('P0', params.price.p0UsdE8 + ' USD_E8（' + params.price.p0Usd + '）');
  kv('倍数', params.price.priceMultiplier + '×（不可变）');
  kv('目标价锁定', params.price.targetFormula);
  kv('PREVIEW', params.timeline.previewSeconds + 's（24h）');
  kv('报名窗口', params.timeline.stakeDurationSeconds + 's（72h）');
  kv('观察窗口', params.timeline.candleCount + ' × ' + params.timeline.candleSeconds + 's = ' + params.timeline.observationSeconds + 's（72h），阈值 ' + params.timeline.minQualifiedCandles);
  kv('单轮 / 10 轮', params.timeline.roundSeconds + 's（7 天）/ ' + params.timeline.roundsTotalSeconds + 's（70 天）');
  kv('每轮奖励', params.rounds.roundRewardRaw + ' raw（7 亿 A9）');
  kv('团队每轮', params.rounds.teamRoundRaw + ' raw（1.2 亿 A9）');
  kv('质押限额', 'min ' + params.stakeLimits.minStakeRaw + ' / 单地址 ≤ ' + params.stakeLimits.maxStakePerAddressBps + ' bps / 本轮 ≤ ' + params.stakeLimits.maxTotalStakeRaw);
  kv('技术终止', '暂停 ' + params.techAbort.pauseDays + ' 天或观察超时 ' + params.techAbort.observationTimeoutDays + ' 天；退本金 100%，不销毁奖励/团队，不消耗档位');
}

export function printNextSteps(lines) {
  section('下一步');
  for (const line of lines) detail(line);
}

export function finish(extra = {}) {
  return summary(extra);
}

export function resolveContractAddress(registry, key) {
  const contract = registry.contracts[key];
  if (!contract || !contract.address) return null;
  return contract.address;
}

export function resolveWalletAddress(registry, key) {
  const wallet = registry.wallets[key];
  if (!wallet || !wallet.address) return null;
  return wallet.address;
}
