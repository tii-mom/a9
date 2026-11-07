/** 参数加载、v11 合约（docs/35 / contracts/README §5）不变量校验、原始单位换算、配置哈希。 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BAM_ROOT = resolve(OPS_ROOT, '..');
export const DEFAULT_PARAMS = join(OPS_ROOT, 'config', 'testnet.params.json');
export const FAST_PARAMS = join(OPS_ROOT, 'config', 'testnet-fast.params.json');
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

export function networkName(params) {
  const p = params || loadParams();
  const declared = p.network && typeof p.network === 'object'
    ? (p.network.net || (Number(p.network.chainId) === -239 ? 'mainnet' : 'testnet'))
    : (p.net || 'testnet');
  return process.env.OPS_NETWORK || declared || 'testnet';
}

export function loadParams(path = process.env.OPS_PARAMS || DEFAULT_PARAMS) {
  const file = resolvePath(path, BAM_ROOT) || DEFAULT_PARAMS;
  if (!existsSync(file)) throw new Error('参数文件不存在：' + file);
  const params = readJSON(file);
  params.__file = file;
  const declared = params.network && typeof params.network === 'object'
    ? (params.network.net || (Number(params.network.chainId) === -239 ? 'mainnet' : 'testnet'))
    : (params.net || 'testnet');
  params.__net = networkName(params);
  // Network fuse: an explicit OPS_NETWORK must match the params file declaration.
  const explicit = process.env.OPS_NETWORK;
  if (process.env.OPS_EXECUTE === '1' && explicit && explicit !== declared) {
    throw new Error('网络保险丝：OPS_NETWORK=' + explicit + ' 与参数文件声明 network=' + declared + ' 拒绝执行');
  }
  // Mainnet extra confirmation. Address format alone cannot identify a network
  // (TON friendly address is network-agnostic), so the params declaration is the source of truth.
  if (process.env.OPS_EXECUTE === '1' && params.__net === 'mainnet' && process.env.OPS_CONFIRM_MAINNET !== 'YES') {
    throw new Error('网络保险丝：mainnet 执行需要 OPS_CONFIRM_MAINNET=YES，且必须使用 mainnet.params.json');
  }
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
  const keys = ['token', 'supply', 'rounds', 'price', 'timeline', 'stakeLimits', 'techAbort', 'risk', 'permissions', 'junxiang'];
  const subset = {};
  for (const key of keys) subset[key] = params[key];
  // 时序档位进入哈希：快测档与生产档的配置哈希必须不同
  subset.timingProfile = timingProfileOf(params);
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

/** v11 入站 / 事件 opcode（contracts/README §5）+ 标准 Jetton opcode + 军饷分发。 */
export const V11_OPCODES = {
  OpenRound: '0x52540001',
  CloseStaking: '0x52540002',
  SubmitCandle: '0x52540003',
  StakeDeposit: '0x5254000F',
  AbortTechnical: '0x52540010',
  RetrySettlement: '0x52540015',
  ReleaseTeam: '0x52540016',
  TicketClaim: '0x52540303',
  TicketRestake: '0x52540304',
  JettonTransferNotification: '0x7362D09C',
  TopUpTons: '0xD372158C',
  JunxiangSetRoot: '0x4A580001',
  JunxiangClaim: '0x4A580002',
};

/** v11 事件（contracts/README §5.4）+ 军饷事件。 */
export const V11_EVENTS = {
  TargetPriceSet: '0x52540101',
  RoundSettled: '0x52540102',
  DepositAccepted: '0x52540103',
  TechnicalAborted: '0x52540104',
  StakingClosed: '0x5254010B',
  CandleSubmitted: '0x5254010C',
  Claimed: '0x5254010E',
  DepositRefunded: '0x5254010F',
  SettlementBounced: '0x52540110',
  UnexpectedBounce: '0x52540111',
  Restaked: '0x52540112',
  TeamReleased: '0x52540113',
  JunxiangRootPublished: '0x4A580101',
  JunxiangClaimed: '0x4A580102',
};

/** params.permissions.opcodes 允许出现的键：v11 入站消息 + 标准 TEP-74 Jetton opcode（其余一律视为已删除的旧消息，如 Claim / ClaimAll）。 */
export const ALLOWED_OPCODE_NAMES = [...Object.keys(V11_OPCODES), 'JettonTransfer', 'JettonBurn', 'JettonBurnNotification'];

/**
 * 时序档位。production = 上主网/测试网正式档（V7：12h + 36h + 24×1h，阈值 16）；
 * fast-cycle = 测试网极速档（10 s K 线，10 轮约 47 分钟）；rehearsal = 仪式演练档，只校验内部一致性。
 */
export const TIMING_PROFILES = {
  production: { previewSeconds: 43200, stakeDurationSeconds: 129600, candleSeconds: 3600, candleCount: 24, minQualifiedCandles: 16, abortTimeoutSeconds: 604800, fallbackUnlockSeconds: 2592000 },
  // extreme-fast testnet drill (10 s candles, ~47 min for 10 rounds); restore production values before mainnet
  'fast-cycle': { previewSeconds: 10, stakeDurationSeconds: 30, candleSeconds: 10, candleCount: 24, minQualifiedCandles: 16, abortTimeoutSeconds: 60, fallbackUnlockSeconds: 60 },
  rehearsal: null,
};

export function timingProfileOf(params) {
  return (params && params.meta && params.meta.timingProfile) || 'production';
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

  // ---- 时序：档位约束 + 内部一致性 ----
  const profile = timingProfileOf(p);
  const timeline = p.timeline;
  const abort = p.techAbort;
  if (!(profile in TIMING_PROFILES)) {
    errors.push('meta.timingProfile 必须为 ' + Object.keys(TIMING_PROFILES).join(' / ') + '（当前 ' + profile + '）');
  } else if (TIMING_PROFILES[profile]) {
    const expected = TIMING_PROFILES[profile];
    check(Number(timeline.previewSeconds) === expected.previewSeconds, profile + '：PREVIEW 必须为 ' + expected.previewSeconds + 's');
    check(Number(timeline.stakeDurationSeconds) === expected.stakeDurationSeconds, profile + '：报名窗口必须为 ' + expected.stakeDurationSeconds + 's');
    check(Number(timeline.candleSeconds) === expected.candleSeconds, profile + '：K 线周期必须为 ' + expected.candleSeconds + 's');
    check(Number(timeline.candleCount) === expected.candleCount, profile + '：观察 K 线数量必须为 ' + expected.candleCount);
    check(Number(timeline.minQualifiedCandles) === expected.minQualifiedCandles, profile + '：达标阈值必须为 ' + expected.minQualifiedCandles);
    check(Number(abort.abortTimeoutSeconds) === expected.abortTimeoutSeconds, profile + '：技术终止超时必须为 ' + expected.abortTimeoutSeconds + 's');
    if (expected.fallbackUnlockSeconds !== undefined && abort.fallbackUnlockSeconds !== undefined) {
      check(Number(abort.fallbackUnlockSeconds) === expected.fallbackUnlockSeconds, profile + '：压城兜底解锁窗口必须为 ' + expected.fallbackUnlockSeconds + 's');
    }
  }
  if (profile === 'fast-cycle') {
    check(p.network && p.network.net === 'testnet' && Number(p.network.chainId) === -3, 'fast-cycle 档只允许测试网（network.net=testnet, chainId=-3）');
    check(Number(timeline.roundsTotalSeconds) <= 12 * 3600, 'fast-cycle 10 轮应在 12 小时内跑完（roundsTotalSeconds ≤ 43200）');
  }
  check(
    Number(timeline.observationSeconds) === Number(timeline.candleCount) * Number(timeline.candleSeconds),
    'observationSeconds 必须等于 candleCount × candleSeconds'
  );
  check(
    Number(timeline.roundSeconds) === Number(timeline.previewSeconds) + Number(timeline.stakeDurationSeconds) + Number(timeline.observationSeconds),
    '单轮时长必须为 预告 + 报名 + 观察'
  );
  check(Number(timeline.roundsTotalSeconds) === Number(timeline.roundSeconds) * 10, '10 轮总时长必须为单轮 × 10');
  check(Number(timeline.minQualifiedCandles) <= Number(timeline.candleCount) && Number(timeline.minQualifiedCandles) * 2 > Number(timeline.candleCount), '达标阈值必须 ≤ 观察根数且 > 根数的一半');
  check(Number(abort.abortTimeoutSeconds) > 0, 'techAbort.abortTimeoutSeconds 必须 > 0');

  // ---- 质押：v11 无上限，最低 1,000 A9 ----
  const limits = p.stakeLimits;
  check(asBigInt(limits.minStakeTokens) === 1000n, '单笔最低质押必须为 1,000 A9（v11）');
  check(asBigInt(limits.minStakeRaw) === asBigInt(limits.minStakeTokens) * 10n ** 9n, 'minStakeRaw 不一致');
  check(Number(limits.maxStakePerAddressBps) === 0, 'v11 无单地址上限：maxStakePerAddressBps 必须为 0');
  check(asBigInt(limits.maxStakePerAddressRaw) === 0n, 'v11 无单地址上限：maxStakePerAddressRaw 必须为 0');
  check(asBigInt(limits.maxTotalStakeRaw) === 0n, 'v11 无本轮总额上限：maxTotalStakeRaw 必须为 0');
  check(limits.cancelStakeAllowed === false, '不允许取消质押');
  check(asBigInt(limits.stakeForwardTonMinNano ?? '0') >= 100000000n, '质押 forward_ton_amount 下限必须 ≥ 0.1 TON');
  check(asBigInt(limits.ticketClaimTonMinNano ?? '0') >= 150000000n, 'TicketClaim 最低附带 TON 必须 ≥ 0.15');
  check(asBigInt(limits.ticketRestakeTonMinNano ?? '0') >= 250000000n, 'TicketRestake 最低附带 TON 必须 ≥ 0.25');

  check(
    asBigInt(p.rounds.rcFundingRaw ?? '0') === asBigInt(p.rounds.rewardPoolRaw) + asBigInt(p.rounds.teamPoolRaw),
    'rcFundingRaw 必须等于 70 亿奖励 + 12 亿团队 = 82 亿（团队额度在 RC 钱包）'
  );
  check(String(p.rounds.rcFundingForwardTonNano) === '0', 'RC 注资 forward_ton_amount 必须为 0（否则被当作质押退回）');

  check(abort.anyoneCanTrigger === true, '技术终止必须任何人可触发');
  check(Number(abort.refundPrincipalBps) === 10000, '技术终止必须退 100% 本金');
  check(abort.burnsRewardOnAbort === false && abort.burnsTeamOnAbort === false, '技术终止不得销毁奖励/团队额度');
  check(abort.tierConsumed === false, '技术终止不得消耗档位');

  const opcodes = p.permissions.opcodes;
  for (const [name, code] of Object.entries(V11_OPCODES)) {
    check(String(opcodes[name] || '').toUpperCase() === code.toUpperCase(), 'opcode ' + name + ' 必须为 ' + code);
  }
  for (const name of Object.keys(opcodes)) {
    check(ALLOWED_OPCODE_NAMES.includes(name), 'opcode ' + name + ' 不在 v11 ABI 中（contracts/README §5），应删除');
  }
  const events = p.permissions.events || {};
  for (const [name, code] of Object.entries(V11_EVENTS)) {
    check(String(events[name] || '').toUpperCase() === code.toUpperCase(), 'event ' + name + ' 必须为 ' + code);
  }
  check(p.roles && p.roles.keeper && p.roles.teamWallet && p.roles.junxiangPublisher, 'roles 必须包含 keeper / teamWallet / junxiangPublisher（v11 无 admin）');
  const ROLE_KEYS = ['keeper', 'treasury', 'teamWallet', 'junxiangPublisher', 'marketingWallet', 'liquidityWallet', 'teamInternalWallet'];
  check(Object.keys(p.roles || {}).every((key) => ROLE_KEYS.includes(key)), 'roles 只允许 ' + ROLE_KEYS.join(' / ') + '（v11 无 admin）');

  const ids = p.deployPlan.map((item) => item.id);
  check(new Set(ids).size === ids.length, 'deployPlan 存在重复 step id');
  for (const item of p.deployPlan) {
    for (const dependency of item.dependsOn || []) {
      check(ids.includes(dependency), 'deployPlan ' + item.id + ' 依赖不存在的 ' + dependency);
    }
  }

  if (p.toolchain.pinned === false) warnings.push('工具链未 pin 版本：执行真实部署前必须锁定 Acton/Tolk 版本并回填 toolchain.pinned=true');
  if (p.toolchain.pinned === true && !p.toolchain.pinnedVersion) warnings.push('toolchain.pinnedVersion 为空：请记录实际 Acton/Tolk 版本');
  if (Number(p.tonBalances.roundControllerMinTon) < 5) warnings.push('RC TON 余额目标低于 contracts/README §6 建议的 5 TON');
  if (!(Number(p.tonBalances.keeperMinTon) > 0)) warnings.push('tonBalances.keeperMinTon 未设置：keeper 钱包 gas 无下限告警');
  if (Number(p.price.priceMultiplier) === 2) warnings.push('2× 已定档（D-33）：docs/13 的 EV 负值数据保留作为风险披露');
  if (profile === 'fast-cycle') warnings.push('fast-cycle 快测档：仅用于测试网演练（10 轮约 ' + (Number(timeline.roundsTotalSeconds) / 3600).toFixed(1) + ' 小时），不得用于主网');

  return { errors, warnings };
}

export function loadAndValidate() {
  const params = loadParams();
  const result = validateParams(params);
  return { params, ...result, digest: paramsDigest(params) };
}
