/** 可复用的验收检查（离线预期值 + 登记表一致性）。 */

import { asBigInt, expectedLadder } from './config.mjs';
import { parseAddress } from './ton.mjs';

export const CHECK_STATUS = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', WARN: 'WARN' };

export function check(name, status, detailText) {
  return { name, status, detail: detailText || '' };
}

export function expectedProtocolConfig(params) {
  return {
    tokenName: params.token.name,
    tokenSymbol: params.token.symbol,
    tokenDecimals: Number(params.token.decimals),
    p0UsdE8: params.price.p0UsdE8,
    priceMultiplier: Number(params.price.priceMultiplier),
    targetMode: params.price.targetMode,
    previewSeconds: Number(params.timeline.previewSeconds),
    stakeDurationSeconds: Number(params.timeline.stakeDurationSeconds),
    candleSeconds: Number(params.timeline.candleSeconds),
    candleCount: Number(params.timeline.candleCount),
    minQualifiedCandles: Number(params.timeline.minQualifiedCandles),
    observationSeconds: Number(params.timeline.observationSeconds),
    minStakeRaw: params.stakeLimits.minStakeRaw,
    maxStakePerAddressBps: Number(params.stakeLimits.maxStakePerAddressBps),
    maxTotalStakeRaw: params.stakeLimits.maxTotalStakeRaw,
    // v10 get_protocol_config 两个超时槽位都返回同一个 abortTimeoutSeconds（7 天）
    techAbortPauseSeconds: Number(params.techAbort.abortTimeoutSeconds),
    techAbortObservationTimeout: Number(params.techAbort.abortTimeoutSeconds),
    roundRewardRaw: params.rounds.roundRewardRaw,
    teamRoundRaw: params.rounds.teamRoundRaw,
    totalSupplyRaw: params.token.totalSupplyRaw,
    riskDisclosureVersion: Number(params.risk.disclosureVersion),
    configVersion: Number(params.meta.configVersion),
    initialTier: 1,
    cancelStakeSupported: false,
  };
}

export function verifyRegistryStructure(registry) {
  const checks = [];
  const contractKeys = ['jettonMaster', 'roundController'];
  for (const key of contractKeys) {
    const value = registry.contracts[key] && registry.contracts[key].address;
    if (!value) {
      checks.push(check('contract.' + key, CHECK_STATUS.FAIL, '未登记地址'));
      continue;
    }
    const parsed = parseAddress(value);
    if (!parsed.ok) checks.push(check('contract.' + key, CHECK_STATUS.FAIL, '地址非法：' + parsed.reason));
    else if (parsed.testnet === false) checks.push(check('contract.' + key, CHECK_STATUS.FAIL, '不是测试网地址'));
    else checks.push(check('contract.' + key, CHECK_STATUS.PASS, value));
  }
  const walletKeys = ['keeper', 'treasury', 'teamWallet', 'marketingWallet', 'liquidityWallet', 'teamInternalWallet'];
  for (const key of walletKeys) {
    const value = registry.wallets[key] && registry.wallets[key].address;
    checks.push(value ? check('wallet.' + key, CHECK_STATUS.PASS, value) : check('wallet.' + key, CHECK_STATUS.WARN, '未登记（部署前必须提供）'));
  }
  checks.push(
    registry.bindings.roundControllerUpgradeable === false
      ? check('bindings.roundControllerUpgradeable', CHECK_STATUS.PASS, '不可升级（D-24）')
      : check('bindings.roundControllerUpgradeable', CHECK_STATUS.FAIL, '登记表应为不可升级')
  );
  checks.push(
    registry.bindings.hasAdmin === false
      ? check('bindings.hasAdmin', CHECK_STATUS.PASS, '无 admin（D-42）')
      : check('bindings.hasAdmin', CHECK_STATUS.FAIL, '登记表应为 hasAdmin=false（v10 无 admin）')
  );
  return checks;
}

export function verifyFundingPlan(params, options = {}) {
  const all = Boolean(options.all);
  const plan = [
    // v10：70 亿奖励 + 12 亿团队一次性转入 RC，forward_ton_amount 必须为 0
    { kind: 'roundController', label: 'RoundController（70 亿奖励 + 12 亿团队 = 82 亿，forward 0）', recipientKey: 'roundControllerJettonWallet', amountRaw: params.rounds.rcFundingRaw, forwardTonNano: '0', always: true },
    { kind: 'marketing', label: '营销钱包（5 亿）', recipientKey: 'marketingWallet', amountRaw: params.supply.allocations.marketing.raw, always: false },
    { kind: 'liquidity', label: '流动性钱包（5 亿）', recipientKey: 'liquidityWallet', amountRaw: params.supply.allocations.liquidity.raw, always: false },
    { kind: 'internalSale', label: '团队内盘管理钱包（8 亿）', recipientKey: 'teamInternalWallet', amountRaw: params.supply.allocations.internalSale.raw, always: false },
  ];
  return plan.filter((item) => item.always || all);
}

export function verifyAllocationInvariant(params) {
  const entries = Object.entries(params.supply.allocations);
  const sumTokens = entries.reduce((acc, [, item]) => acc + asBigInt(item.tokens), 0n);
  const sumRaw = entries.reduce((acc, [, item]) => acc + asBigInt(item.raw), 0n);
  return {
    sumTokens: sumTokens.toString(),
    sumRaw: sumRaw.toString(),
    expectedTokens: params.token.totalSupplyTokens,
    expectedRaw: params.token.totalSupplyRaw,
    ok: sumTokens === asBigInt(params.token.totalSupplyTokens) && sumRaw === asBigInt(params.token.totalSupplyRaw),
  };
}

export function verifyLadder(params) {
  const ladder = expectedLadder(params);
  const rows = Object.entries(ladder).map(([tier, priceUsdE8]) => {
    const ref = params.price.ladderRefUsdE8[tier];
    return { tier: Number(tier), priceUsdE8, ref, ok: priceUsdE8 === ref };
  });
  return { ladder, rows, ok: rows.every((row) => row.ok) };
}

/** 比较链上读取的协议配置与期望配置；values 为 {key: bigint|string}。 */
export function compareOnchainConfig(expected, onchain) {
  const checks = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = onchain[key];
    if (actualValue === undefined || actualValue === null) {
      checks.push(check('config.' + key, CHECK_STATUS.SKIP, '链上未返回该字段'));
      continue;
    }
    const same = String(expectedValue) === String(actualValue);
    checks.push(check('config.' + key, same ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, '期望 ' + expectedValue + '，链上 ' + actualValue));
  }
  return checks;
}
