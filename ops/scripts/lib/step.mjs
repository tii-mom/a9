/** 所有脚本共用的启动流程：参数校验 → 依赖检查 → 执行开关 → 汇总。 */

import { existsSync, readFileSync } from 'node:fs';
import { loadAndValidate, resolvePath } from './config.mjs';
import { isExecute, parseArgs } from './cli.mjs';
import { loadRegistry } from './registry.mjs';
import { toolchainStatus } from './toolchain.mjs';
import { dryRunBanner, detail, err, fail, kv, section, step, summary, warn } from './log.mjs';

const DEP_TO_CONTRACT = {
  preflight: null,
  jettonMaster: 'jettonMaster',
  jettonMint: 'jettonMaster',
  contracts: 'roundController',
  roundController: 'roundController',
  params: 'roundController',
  tonGas: 'roundController',
  funding: 'roundController',
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
  section('预期链上配置（时序档 ' + (params.meta.timingProfile || 'production') + ' / v11 合约）');
  const t = params.timeline;
  kv('P0', params.price.p0UsdE8 + ' USD_E8（' + params.price.p0Usd + '）');
  kv('倍数', params.price.priceMultiplier + '×（不可变）');
  kv('目标价锁定', params.price.targetFormula);
  kv('PREVIEW', t.previewSeconds + 's');
  kv('报名窗口', t.stakeDurationSeconds + 's');
  kv('观察窗口', t.candleCount + ' × ' + t.candleSeconds + 's = ' + t.observationSeconds + 's，阈值 ' + t.minQualifiedCandles);
  kv('单轮 / 10 轮', t.roundSeconds + 's / ' + t.roundsTotalSeconds + 's');
  kv('每轮奖励', params.rounds.roundRewardRaw + ' raw（7 亿 A9）');
  kv('团队每轮', params.rounds.teamRoundRaw + ' raw（1.2 亿 A9，下一次破城才转出）');
  kv('最低质押', params.stakeLimits.minStakeRaw + ' raw（1,000 A9）；无单地址上限 / 无本轮总额上限');
  kv('RC 注资', params.rounds.rcFundingRaw + ' raw（70 亿奖励 + 12 亿团队），forward_ton_amount = 0');
  kv('技术终止', params.techAbort.abortTimeoutSeconds + 's 后任何人可触发（观察 / 预告共用）；本金经攻城令领取，奖励/团队额度滚入下一城');
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

/** 广播签名钱包名：A9_SIGNER_WALLET > TON_DEPLOYER_WALLET > params 默认。 */
export function signerWallet(params) {
  return (
    process.env.A9_SIGNER_WALLET ||
    (params.network.deployer.walletNameEnv ? process.env[params.network.deployer.walletNameEnv] : null) ||
    params.network.deployer.walletNameDefault ||
    'deployer' // matches the Acton wallet name used by deploy-emulation.tolk
  );
}

/** 读取 contracts/deploy/*.addr（部署脚本自动生成，纯地址 + 换行）。 */
export function addressFromFile(params, fileName) {
  const path = resolvePath(params.toolchain.contractsDir + '/deploy/' + fileName);
  if (!existsSync(path)) return null;
  // deploy-emulation 写入 "<address> (<ContractName>)"：只取第一个 token，避免把标签拼进 shell 命令
  const first = readFileSync(path, 'utf8').trim().split(String.fromCharCode(10))[0].trim().split(/\s+/)[0];
  return first || null;
}

/** 优先登记表地址；缺失时回退到 contracts/deploy/ 地址文件。 */
export function resolveAddress(registry, params, key, fileName) {
  return resolveContractAddress(registry, key) || (fileName ? addressFromFile(params, fileName) : null);
}
