#!/usr/bin/env node
/**
 * 30 — RoundController（v11）：生成初始数据快照 + --adopt 登记。
 *
 * v11 的 RC 由 15_deploy_contracts.mjs（deploy-emulation.tolk）整体部署：keeper、jettonMaster、
 * teamWallet、经济/时间参数与 JettonWallet 代码全部写进初始数据；无 admin、不可升级、无 wiring。
 * 本脚本只保留：初始数据快照（供双人核对 / 公示）与 --adopt 手工登记。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { str } from './lib/cli.mjs';
import { RECORDS_DIR, writeJSON } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress, resolveWalletAddress } from './lib/step.mjs';
import { setContract, writeRegistry } from './lib/registry.mjs';
import { validateTestnetAddress } from './lib/ton.mjs';
import { expectedProtocolConfig } from './lib/verify.mjs';
import { section, kv, ok, fail, info } from './lib/log.mjs';

const { args, params, digest, registry } = bootstrap({
  id: '30',
  title: 'RoundController 初始数据快照 / 登记（v11）',
  dependsOn: ['jettonMaster'],
});

const keeper = str(args, 'keeper') || resolveWalletAddress(registry, 'keeper') || process.env[params.roles.keeper.env] || '';
const teamWallet = str(args, 'team-wallet') || resolveWalletAddress(registry, 'teamWallet') || process.env[params.roles.teamWallet.env] || '';
const jettonMaster = resolveContractAddress(registry, 'jettonMaster');
const adopt = str(args, 'adopt');
const existing = resolveContractAddress(registry, 'roundController');

const initData = {
  note: '生成时间 ' + new Date().toISOString() + '；由 ops/scripts/30_deploy_round_controller.mjs 生成，作为 RC 初始数据的人工核对清单（实际写入由 deploy-emulation.tolk 完成）。',
  contractsVersion: 'v11',
  configVersion: params.meta.configVersion,
  paramsDigest: digest,
  addresses: { keeper, jettonMaster, teamWallet },
  econ: {
    p0UsdE8: params.price.p0UsdE8,
    priceMultiplier: params.price.priceMultiplier,
    roundRewardRaw: params.rounds.roundRewardRaw,
    teamRoundRaw: params.rounds.teamRoundRaw,
    minStakeRaw: params.stakeLimits.minStakeRaw,
    maxStakePerAddressRaw: params.stakeLimits.maxStakePerAddressRaw,
    maxTotalStakeRaw: params.stakeLimits.maxTotalStakeRaw,
  },
  timing: {
    previewSeconds: params.timeline.previewSeconds,
    stakeDurationSeconds: params.timeline.stakeDurationSeconds,
    candleSeconds: params.timeline.candleSeconds,
    candleCount: params.timeline.candleCount,
    minQualifiedCandles: params.timeline.minQualifiedCandles,
    abortTimeoutSeconds: params.techAbort.abortTimeoutSeconds,
    riskDisclosureVersion: params.risk.disclosureVersion,
    configVersion: params.meta.configVersion,
  },
  funding: { rcFundingRaw: params.rounds.rcFundingRaw, forwardTonAmount: 0 },
  expectedView: expectedProtocolConfig(params),
};

section('初始数据');
kv('keeper', keeper || '（未提供）');
kv('teamWallet', teamWallet || '（未提供）');
kv('jettonMaster', jettonMaster || '（未登记）');
kv('P0 / 倍数', params.price.p0UsdE8 + ' / ' + params.price.priceMultiplier);
kv('最低质押 raw', params.stakeLimits.minStakeRaw);
kv('观察窗口', params.timeline.candleCount + ' 根 × ' + params.timeline.candleSeconds + 's，阈值 ' + params.timeline.minQualifiedCandles);
kv('技术终止', params.techAbort.abortTimeoutSeconds + 's（观察 / 预告超时统一）');
kv('admin', '无（D-42）；RC 不可升级、无提现');

mkdirSync(RECORDS_DIR, { recursive: true });
const initDataFile = join(RECORDS_DIR, 'round-controller.init.json');
writeJSON(initDataFile, initData);
ok('初始数据快照已写入：' + initDataFile);

if (adopt) {
  const validation = validateTestnetAddress(adopt, 'roundController');
  if (!validation.ok) { fail(validation.message); process.exit(finish()); }
  setContract(registry, 'roundController', adopt, { note: 'adopt 手工登记（v11）' });
  registry.paramsDigest = digest;
  writeRegistry(registry);
  ok('已登记 RoundController：' + adopt);
  process.exit(finish({ 地址: adopt }));
}
if (existing) info('RoundController 已登记：' + existing);
else info('v11 RC 由 15_deploy_contracts.mjs 整体部署；本脚本不单独部署。');

printNextSteps([
  '整体部署：node scripts/15_deploy_contracts.mjs --execute（keeper / teamWallet 必须先登记）',
  '已部署后登记：node scripts/30_deploy_round_controller.mjs --adopt <roundController>',
  '随后：node scripts/40_init_params.mjs --online（get_protocol_config 逐项比对）',
]);
process.exit(finish({ 模式: 'DRY-RUN（整体部署路径）', 初始数据: initDataFile }));
