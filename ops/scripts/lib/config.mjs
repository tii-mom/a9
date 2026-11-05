/** 参数加载、V7 不变量校验、原始单位换算、配置哈希。 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BAM_ROOT = resolve(OPS_ROOT, '..');
export const DEFAULT_PARAMS = join(OPS_ROOT, 'config', 'testnet.params.json');
export const DEFAULT_REGISTRY = join(OPS_ROOT, 'config', 'testnet.registry.json');
export const TEMPLATE_REGISTRY = join(OPS_ROOT, 'config', 'testnet.registry.template.json');
export const RECORDS_DIR = process.env.OPS_RECORDS_DIR ? resolve(process.env.OPS_RECORDS_DIR) : join(OPS_ROOT, 'records');

export function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function resolvePath(input, base = BAM_ROOT) {
  if (!input) return input;
  return isAbsolute(input) ? input : resolve(base, input);
}

export function loadParams(path = process.env.OPS_PARAMS || DEFAULT_PARAMS) {
  const file = resolvePath(path, BAM_ROOT) || DEFAULT_PARAMS;
  if (!existsSync(file)) throw new Error('参数文件不存在：' + file);
  const params = readJSON(file);
  params.__file = file;
  return params;
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

/** 协议关键参数子集（用于配置哈希/公示；不含工具链与生成时间戳）。 */
export function protocolSubset(params) {
  const keys = ['token', 'supply', 'rounds', 'price', 'timeline', 'stakeLimits', 'techAbort', 'risk', 'permissions'];
  const subset = {};
  for (const key of keys) subset[key] = params[key];
  return subset;
}

export function paramsDigest(params) {
  return 'sha256:' + createHash('sha256').update(stableStringify(protocolSubset(params))).digest('hex');
}

export function rawAmount(tokens, decimals = 9) {
  return (BigInt(String(tokens)) * 10n ** BigInt(decimals)).toString();
}

export function formatTokens(raw, decimals = 9, maxFrac = 4) {
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(String(raw));
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0');
  const trimmed = fraction.slice(0, maxFrac).replace(/0+$/, '');
  return trimmed ? whole + '.' + trimmed : whole.toString();
}

export function isIntString(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  let body = text;
  if (body[0] === '-') body = body.slice(1);
  if (!body) return false;
  for (const char of body) {
    if (char < '0' || char > '9') return false;
  }
  return true;
}

export function asBigInt(value, label = 'value') {
  if (typeof value === 'bigint') return value;
  if (!isIntString(value)) throw new Error(label + ' 不是合法整数原始单位：' + value);
  return BigInt(String(value).trim());
}

/** 阶梯参考价：tier -> USD_E8（P0 × 2^tier）。 */
export function expectedLadder(params) {
  const p0 = asBigInt(params.price.p0UsdE8, 'p0UsdE8');
  const factor = asBigInt(params.price.priceMultiplier, 'priceMultiplier');
  const ladder = {};
  for (let tier = 1; tier <= Number(params.rounds.roundCount); tier++) {
    ladder[tier] = (p0 * factor ** BigInt(tier)).toString();
  }
  return ladder;
}

/** @returns {{errors: string[], warnings: string[]}} */
export function validateParams(params) {
  const errors = [];
  const warnings = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  const p = params;

  check(Number(p.token.decimals) === 9, 'token.decimals 必须为 9');
  check(Number(p.token.totalSupplyTokens) === 10000000000, '总量必须为 10,000,000,000');

  const allocations = p.supply.allocations;
  const allocationSum = Object.values(allocations).reduce((acc, item) => acc + asBigInt(item.tokens, item.percent + '% allocation'), 0n);
  check(allocationSum === asBigInt(p.token.totalSupplyTokens), '分配总和 ' + allocationSum + ' 不等于总量 ' + p.token.totalSupplyTokens);
  check(asBigInt(allocations.roundRewards.tokens) === asBigInt(p.rounds.roundRewardTokens) * 10n, '奖励池必须等于 10 × 每轮奖励（70 亿）');
  check(asBigInt(allocations.team.tokens) === asBigInt(p.rounds.teamRoundTokens) * 10n, '团队额度必须等于 10 × 1.2 亿（12 亿）');
  check(asBigInt(p.rounds.roundRewardRaw) === asBigInt(p.rounds.roundRewardTokens) * 10n ** 9n, 'roundRewardRaw 与 roundRewardTokens 不一致');
  check(asBigInt(p.rounds.rewardPoolRaw) === asBigInt(p.rounds.roundRewardRaw) * 10n, 'rewardPoolRaw 必须为 10 × roundRewardRaw');
  check(asBigInt(p.rounds.teamRoundRaw) === asBigInt(p.rounds.teamRoundTokens) * 10n ** 9n, 'teamRoundRaw 与 teamRoundTokens 不一致');
  check(asBigInt(p.rounds.teamPoolRaw) === asBigInt(p.rounds.teamRoundRaw) * 10n, 'teamPoolRaw 必须为 10 × teamRoundRaw');
  check(asBigInt(p.token.totalSupplyRaw) === asBigInt(p.token.totalSupplyTokens) * 10n ** 9n, 'totalSupplyRaw 与 totalSupplyTokens 不一致');
  for (const [name, item] of Object.entries(allocations)) {
    check(asBigInt(item.raw) === asBigInt(item.tokens) * 10n ** 9n, name + '.raw 与 tokens 不一致');
    check(Number(item.percent) === Math.round((Number(item.tokens) / 1e10) * 100), name + '.percent 与 tokens 不一致');
  }
  check(
    ['roundRewards', 'internalSale', 'liquidity', 'team', 'marketing'].every((key) => allocations[key] && allocations[key].percent != null),
    '分配必须包含 roundRewards/internalSale/liquidity/team/marketing'
  );
  const liquidityAlloc = allocations.liquidity;
  check(Number(liquidityAlloc.coldStartTokens) === 200000000, '流动性冷启动必须为 2 亿 A9');
  check(asBigInt(liquidityAlloc.coldStartRaw) === asBigInt(liquidityAlloc.coldStartTokens) * 10n ** 9n, '冷启动 coldStartRaw 与 tokens 不一致');
  check(
    asBigInt(liquidityAlloc.coldStartTokens) * 100n === asBigInt(liquidityAlloc.tokens) * BigInt(liquidityAlloc.coldStartPercentOfLiquidity),
    '冷启动池必须恰好占流动性额度 40%'
  );
  check(asBigInt(liquidityAlloc.coldStartTokens) <= asBigInt(liquidityAlloc.tokens), '冷启动池不得超过流动性额度');
  check(String(liquidityAlloc.coldStartUsdtUsdE8) === '23200000000000', '冷启动 USDT 必须为 $232,000（USD_E8=23200000000000）');
  check(Number(p.supply.roundCount) === 10 && Number(p.rounds.roundCount) === 10, '轮次数量必须为 10');

  check(asBigInt(p.price.p0UsdE8) === 116000n, 'P0 必须为 116000 USD_E8（$0.00116）');
  check(Number(p.price.priceMultiplier) === 2, '每轮倍数必须为 2（不可变）');
  const ladder = expectedLadder(p);
  for (const [tier, expected] of Object.entries(ladder)) {
    check(asBigInt(p.price.ladderRefUsdE8[tier]) === asBigInt(expected), 'tier ' + tier + ' 阶梯参考价不一致（应为 ' + expected + '）');
  }
  check(p.price.targetMode === 'LOCK_AT_OPEN', 'targetMode 必须为 LOCK_AT_OPEN（V6）');
  check(String(p.price.tierRule).includes('tier = 1 + successfulRounds'), 'tier 规则必须为 1 + 已成功轮数');

  const timeline = p.timeline;
  check(Number(timeline.previewSeconds) === 43200, 'PREVIEW 必须为 12h（43200）');
  check(Number(timeline.stakeDurationSeconds) === 129600, '报名窗口必须为 36h（129600）');
  check(Number(timeline.candleSeconds) === 3600, 'K 线周期必须为 1h（3600）');
  check(Number(timeline.candleCount) === 24, '观察 K 线数量必须为 24');
  check(Number(timeline.minQualifiedCandles) === 16, '达标阈值必须为 16');
  check(
    Number(timeline.observationSeconds) === Number(timeline.candleCount) * Number(timeline.candleSeconds),
    'observationSeconds 必须等于 candleCount × candleSeconds'
  );
  check(
    Number(timeline.roundSeconds) === Number(timeline.previewSeconds) + Number(timeline.stakeDurationSeconds) + Number(timeline.observationSeconds),
    '单轮时长必须为 12h + 36h + 24h = 72h'
  );
  check(Number(timeline.roundsTotalSeconds) === Number(timeline.roundSeconds) * 10, '10 轮总时长必须为 30 天');

  const limits = p.stakeLimits;
  check(asBigInt(limits.minStakeTokens) === 10000n, '单笔最低质押必须为 10,000 A9');
  check(asBigInt(limits.minStakeRaw) === asBigInt(limits.minStakeTokens) * 10n ** 9n, 'minStakeRaw 不一致');
  check(Number(limits.maxStakePerAddressBps) === 1000, '单地址上限 bps 必须为 1000');
  check(
    asBigInt(limits.maxStakePerAddressRaw) === 20000000000000000n,
    '单地址固定硬顶必须为 20,000,000 A9（contracts/README §9.1 裁决）'
  );
  check(Number(limits.maxStakePerAddressTokens) === 20000000, 'maxStakePerAddressTokens 必须为 20,000,000');
  check(asBigInt(limits.maxTotalStakeTokens) === 200000000n, '本轮总质押上限必须为 2 亿 A9');
  check(asBigInt(limits.maxTotalStakeRaw) === asBigInt(limits.maxTotalStakeTokens) * 10n ** 9n, 'maxTotalStakeRaw 不一致');
  check(limits.cancelStakeAllowed === false, '不允许取消质押');

  const abort = p.techAbort;
  check(Number(abort.pauseSeconds) === 14 * 86400, '连续暂停技术终止阈值必须为 14 天');
  check(Number(abort.observationTimeoutSeconds) === 7 * 86400, '观察超时必须为 7 天');
  check(abort.anyoneCanTrigger === true, '技术终止必须任何人可触发');
  check(Number(abort.refundPrincipalBps) === 10000, '技术终止必须退 100% 本金');
  check(abort.burnsRewardOnAbort === false && abort.burnsTeamOnAbort === false, '技术终止不得销毁奖励/团队额度');
  check(abort.tierConsumed === false, '技术终止不得消耗档位');

  const expectedOps = {
    OpenRound: '0x52540001',
    CloseStaking: '0x52540002',
    SubmitCandle: '0x52540003',
    OracleCandleVerified: '0x52540004',
    FinalizeRound: '0x52540005',
    ClaimPrincipal: '0x52540006',
    ClaimReward: '0x52540007',
    StartFailureBurn: '0x52540008',
    BurnAck: '0x52540009',
    PauseOracle: '0x5254000A',
    ResumeOracle: '0x5254000B',
    ReleaseTeamQuota: '0x5254000C',
    BurnTeamQuota: '0x5254000D',
    ClaimAll: '0x5254000E',
  };
  const opcodes = p.permissions.opcodes;
  for (const [name, code] of Object.entries(expectedOps)) {
    check(String(opcodes[name]).toUpperCase() === code.toUpperCase(), 'opcode ' + name + ' 必须为 ' + code);
  }
  check(!('CancelStake' in opcodes), '不得存在 CancelStake opcode（质押不可取消）');

  const ids = p.deployPlan.map((item) => item.id);
  check(new Set(ids).size === ids.length, 'deployPlan 存在重复 step id');
  for (const item of p.deployPlan) {
    for (const dependency of item.dependsOn || []) {
      check(ids.includes(dependency), 'deployPlan ' + item.id + ' 依赖不存在的 ' + dependency);
    }
  }

  if (p.toolchain.pinned === false) warnings.push('工具链未 pin 版本：执行真实部署前必须锁定 Acton/Tolk 版本并回填 toolchain.pinned=true');
  if (p.toolchain.pinned === true && !p.toolchain.pinnedVersion) warnings.push('toolchain.pinnedVersion 为空：请记录实际 Acton/Tolk 版本');
  if (Number(p.tonBalances.roundControllerMinTon) < 20) warnings.push('RC TON 余额目标低于 contracts/README 建议的 20 TON');
  if (Number(p.tonBalances.teamVaultMinTon) < 10) warnings.push('TeamVault TON 余额目标低于 contracts/README 建议的 10 TON');
  if (Number(p.price.priceMultiplier) === 2) warnings.push('2× 已定档（D-33）：docs/13 的 EV 负值数据保留作为风险披露');

  return { errors, warnings };
}

export function loadAndValidate() {
  const params = loadParams();
  const result = validateParams(params);
  return { params, ...result, digest: paramsDigest(params) };
}
