#!/usr/bin/env node
/** 30 — 部署 RoundController（单密钥 owner、不可升级；参数初始化数据同批生成）。 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { str } from './lib/cli.mjs';
import { RECORDS_DIR, writeJSON } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress, resolveWalletAddress } from './lib/step.mjs';
import { commandTemplate, extractAddress, runCommand, substitute } from './lib/toolchain.mjs';
import { setContract, writeRegistry } from './lib/registry.mjs';
import { validateTestnetAddress } from './lib/ton.mjs';
import { expectedProtocolConfig } from './lib/verify.mjs';
import { section, kv, ok, fail, warn, info, detail } from './lib/log.mjs';

const { args, execute, params, digest, registry } = bootstrap({
  id: '30',
  title: '部署 RoundController（状态机 + 结算 + claimAll）',
  dependsOn: ['teamVault'],
});

const adminOwner = str(args, 'admin') || resolveWalletAddress(registry, 'adminOwner') || process.env.TON_ADMIN_OWNER_ADDRESS || '';
const jettonMaster = resolveContractAddress(registry, 'jettonMaster');
const teamVault = resolveContractAddress(registry, 'teamVault');
const adopt = str(args, 'adopt');
const existing = resolveContractAddress(registry, 'roundController');

const initData = {
  note: '生成时间 ' + new Date().toISOString() + '；由 ops/scripts/30_deploy_round_controller.mjs 生成，签名后作为 RoundController 初始化数据。',
  configVersion: params.meta.configVersion,
  paramsDigest: digest,
  addresses: {
    admin: adminOwner,
    oracle: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // 占位：本期 OracleAdapter 不部署（测试网手动 K 线）
    jettonMaster,
  },
  vaults: {
    // contracts/README §5：Jetton Wallet 地址由 owner=RC 推导，部署时先用占位（admin），
    // RC 部署后由 65_set_jetton_wallets.mjs 调用 SetJettonWallet(0x52540016) 一次性写入。
    stakingJettonWallet: adminOwner || '<ADMIN_PLACEHOLDER>',
    teamVault,
  },
  econ: {
    p0UsdE8: params.price.p0UsdE8,
    priceMultiplier: params.price.priceMultiplier,
    roundRewardRaw: params.rounds.roundRewardRaw,
    teamRoundRaw: params.rounds.teamRoundRaw,
    minStakeRaw: params.stakeLimits.minStakeRaw,
    maxStakePerAddressBps: params.stakeLimits.maxStakePerAddressBps,
    maxTotalStakeRaw: params.stakeLimits.maxTotalStakeRaw,
  },
  timing: {
    previewSeconds: params.timeline.previewSeconds,
    stakeDurationSeconds: params.timeline.stakeDurationSeconds,
    candleSeconds: params.timeline.candleSeconds,
    candleCount: params.timeline.candleCount,
    minQualifiedCandles: params.timeline.minQualifiedCandles,
    observationSeconds: params.timeline.observationSeconds,
    techAbortPauseSeconds: params.techAbort.pauseSeconds,
    techAbortObsTimeoutSeconds: params.techAbort.observationTimeoutSeconds,
    riskDisclosureVersion: params.risk.disclosureVersion,
    configVersion: params.meta.configVersion,
  },
  expectedView: expectedProtocolConfig(params),
};

section('初始化数据');
kv('adminOwner', adminOwner || '（未提供）');
kv('jettonMaster', jettonMaster || '（未登记）');
kv('teamVault', teamVault || '（未登记）');
kv('P0 / 倍数', params.price.p0UsdE8 + ' / ' + params.price.priceMultiplier);
kv('观察窗口', params.timeline.candleCount + ' 根 × ' + params.timeline.candleSeconds + 's，阈值 ' + params.timeline.minQualifiedCandles);
kv('技术终止', params.techAbort.pauseSeconds + 's / ' + params.techAbort.observationTimeoutSeconds + 's');
kv('不可升级', '是（D-24；无代理、无 setCode）');

mkdirSync(RECORDS_DIR, { recursive: true });
const initDataFile = join(RECORDS_DIR, 'round-controller.init.json');
writeJSON(initDataFile, initData);
ok('初始化数据已写入：' + initDataFile);

if (adopt) {
  const validation = validateTestnetAddress(adopt, 'roundController');
  if (!validation.ok) { fail(validation.message); process.exit(finish()); }
  setContract(registry, 'roundController', adopt, { note: 'adopt 手工登记' });
  registry.paramsDigest = digest;
  writeRegistry(registry);
  ok('已登记 RoundController：' + adopt);
  process.exit(finish({ 地址: adopt }));
}
if (existing) {
  info('RoundController 已登记：' + existing);
  process.exit(finish({ 地址: existing }));
}
if (execute) {
  if (!adminOwner || !jettonMaster || !teamVault) {
    fail('EXECUTE 前置缺失：adminOwner / jettonMaster / teamVault 必须已确定');
    process.exit(finish());
  }
  if (initData.vaults.stakingJettonWallet === '<ADMIN_PLACEHOLDER>' || !adminOwner) {
    warn('stakingJettonWallet 为占位地址：部署后必须由 65_set_jetton_wallets.mjs 调 SetJettonWallet 写入真实 RC Jetton Wallet');
  }
}

const rendered = substitute(commandTemplate(params, 'deployRoundController'), {
  contractsDir: params.toolchain.contractsDir,
  initDataFile,
  teamVault: teamVault || '',
});
section('执行计划');
detail('命令：' + rendered);
detail('部署后：owner 为单密钥硬件钱包；RC 不可升级；不得预存 10 轮价格。');

const result = runCommand(rendered, { execute });
if (execute) {
  if (result.status !== 0) {
    fail('部署命令失败（exit ' + result.status + '）：' + (result.stderr || result.stdout).slice(0, 500));
    process.exit(finish());
  }
  const address = str(args, 'address') || extractAddress(result.stdout) || extractAddress(result.stderr);
  if (!address) {
    fail('未能从输出解析 RoundController 地址；请用 --adopt <address> 登记');
    process.exit(finish());
  }
  setContract(registry, 'roundController', address, { note: 'Acton 部署输出解析；不可升级' });
  registry.paramsDigest = digest;
  writeRegistry(registry);
  ok('RoundController 已部署并登记：' + address);
}

printNextSteps([
  '下一步：node scripts/40_init_params.mjs（校验链上配置与参数快照）',
  '然后：node scripts/70_bind_roles.mjs（TeamVault.InitController → RC，一次性）',
  '注意：InitController 只能由 TeamVault.admin 调用一次，地址填错不可恢复；执行前双人核对。',
]);
process.exit(finish({ 模式: execute ? 'EXECUTE' : 'DRY-RUN', 初始化数据: initDataFile }));
