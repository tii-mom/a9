#!/usr/bin/env node
/**
 * 生成 Cloudflare D1 演示种子数据：worker/seed/seed.sql
 *
 * ⚠️ 本文件输出**不是迁移**，禁止放入 worker/migrations/：`wrangler d1 migrations apply`
 *    会执行该目录下所有 .sql，导致演示假数据被灌进生产库。seed 只能在本地/demo 环境显式执行。
 *
 * 设计目标：
 *  - 可复现：所有地址/数量/成交由固定种子推导，时间以 EPOCH（默认 now）为锚点。
 *  - 幂等：先 DELETE 再 INSERT OR REPLACE，可反复执行（本地/远端都安全）。
 *  - 与 worker/src/demo-cycle.ts（resetDemoData）的演示数据集一致：R1 20/24 成功、R2 12/24 失败（三笔销毁）、
 *    R3 观察中（已收盘 12 根，按 DEMO_CANDLE_SECONDS 继续推进）、R4..R10 UNOPENED。
 *  - 目标价按 D-28 档位（tier = 1 + 已成功轮数；失败不升档）：R1 tier1=232000、R2 tier2=464000、
 *    R3 沿用 tier2=464000（R2 同档重试）、R4（R3 通过后）tier3=928000、…、R10 投影 tier9。
 *  - v10（docs/34）：奖励纯按质押比例 floor(7 亿 × 我的质押 / 本轮总质押)，仅 SUCCEEDED 轮有效；
 *    stakes.weight_raw = amount_raw；A0 已领 R1（本金 + 全额奖励一次领完）；rounds.team_released_raw 记 R1 的 1.2 亿。
 *    不再生成 V8 的权重 / 邀请 / 连续参与 / 滚存 / 早领 / 解锁池数据（不写邀请表与解锁池表）。
 *  - K 线不写进 seed：由 Worker 的 reconcile 依据 observation_start 确定性回填（单一事实来源）。
 *
 * 用法：
 *   node scripts/generate-seed.mjs                  # 生产演示默认（90s/根，EPOCH=now）
 *   DEMO_CANDLE_SECONDS=1 node scripts/generate-seed.mjs   # 冒烟测试用极速模式
 *   EPOCH=1730000000000 node scripts/generate-seed.mjs     # 固定时间锚点（可复现对比）
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, '..');
const OUT_FILE = join(WORKER_ROOT, 'seed', 'seed.sql');

const TOKEN_SCALE = 1_000_000_000n;
const TOKEN_DECIMALS = 9;
const P0_USD_E8 = 116_000n; // $0.00116（1 GRAM = 1000 A9，GRAM = $1.16）
const USD_SCALE = 100_000_000n;
const ROUND_COUNT = 10;
const CANDLE_COUNT = 24;
const MIN_QUALIFIED_CANDLES = 16;
const CANDLE_SECONDS = 3_600;
const OBSERVATION_SECONDS = CANDLE_SECONDS * CANDLE_COUNT;
const ROUND_REWARD_TOKENS = 700_000_000n; // 70% / 10 轮
const TEAM_ROUND_TOKENS = 120_000_000n; // 团队 12% / 10 轮（达标释放、失败销毁）
const TOTAL_SUPPLY_TOKENS = 10_000_000_000n;
const ROUND_REWARD_RAW = ROUND_REWARD_TOKENS * TOKEN_SCALE;
const TOTAL_SUPPLY_RAW = TOTAL_SUPPLY_TOKENS * TOKEN_SCALE;
const RISK_DISCLOSURE_VERSION = 1;
const STAKE_DURATION_SECONDS = 36 * 3600; // 30 天压缩：报名 36h
const STAKE_GAP_SECONDS = 12 * 3600; // 预告期 12h

const EPOCH = Number(process.env.EPOCH || Date.now());
const DEMO_CANDLE_SECONDS = Math.max(1, Number(process.env.DEMO_CANDLE_SECONDS || 90));
const C = DEMO_CANDLE_SECONDS * 1000;
const DAY = 86_400_000;

/* ------------------------------- 工具 ------------------------------- */

const q = (value) => "'" + String(value).replace(/'/g, "''") + "'";
const n = (value) => String(Math.trunc(value));
const raw = (tokens) => (BigInt(tokens) * TOKEN_SCALE).toString();

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x46555345); // "A9"

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 12 个确定性演示地址（UQ + 46 字符 base64url，形状与 TON 用户友好地址一致）。 */
function demoAddress(index) {
  const digest = createHash('sha256').update('fuse-protocol-demo-wallet-' + index).digest();
  let out = 'UQ';
  for (let i = 0; i < 46; i++) out += B64URL[digest[i % digest.length] % 64];
  return out;
}

const ADDRESSES = Array.from({ length: 12 }, (_, i) => demoAddress(i));

/* ------------------------------ v10 奖励计算 ------------------------------ */

/** 与 worker/src/protocol.ts rewardFor / 合约 rewardOf 同口径：floor(奖励 × 质押 / 总质押)。 */
function rewardFor(rewardBudgetRaw, stakeRaw, totalStakeRaw) {
  if (totalStakeRaw <= 0n || stakeRaw <= 0n) return 0n;
  return (rewardBudgetRaw * stakeRaw) / totalStakeRaw;
}

/** K 线滚动哈希（与 worker/src/rewards.ts computeCandleHash 同公式） */
function rollingCandleHash(rows) {
  let hash = '0x' + '0'.repeat(64);
  const ordered = [...rows].sort((a, b) => Number(a[1]) - Number(b[1]));
  for (const row of ordered) {
    hash = '0x' + createHash('sha256').update(hash + '|' + row[1] + '|' + unquote(row[4]) + '|' + unquote(row[8])).digest('hex');
  }
  return hash;
}

/** multiInsert 里保存的是 q() 之后的字面量；这里还原用于哈希（digest/price 均为 \'包裹） */
function unquote(value) {
  const text = String(value);
  return text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1) : text;
}

/** 按基点权重把轮次总质押拆到 12 个地址（BigInt，余数补给第一名）。 */
const WEIGHT_BPS = [1680, 1420, 1260, 1040, 920, 810, 680, 570, 490, 410, 350, 370];

function splitAmount(totalTokens) {
  const total = BigInt(totalTokens);
  const amounts = WEIGHT_BPS.map((bps) => (total * BigInt(bps)) / 10000n);
  const sum = amounts.reduce((acc, value) => acc + value, 0n);
  amounts[0] += total - sum;
  return amounts.map((value) => value.toString());
}

function multiInsert(table, columns, rows, chunkSize = 30) {
  if (!rows.length) return '';
  const lines = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    lines.push(
      'INSERT OR REPLACE INTO ' + table + ' (' + columns.join(', ') + ') VALUES\n' +
        slice.map((row) => '  (' + row.join(', ') + ')').join(',\n') + ';',
    );
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------ 轮次数据 ----------------------------- */

/**
 * 目标价档位（D-28 / V6.1，禁止用轮次号代替档位）：
 *   tier = 1 + 已成功轮数；失败轮不升档（下一轮同档重试），成功轮才 tier+1。
 * seed 的历史事实：R1 成功 → successCount=1；R2 失败 → 仍为 1；R3 观察中。
 * R4..R10 为「后续轮次都成功」的乐观投影（实际开轮时由 Worker 按真实 successCount 覆盖）。
 */
function tierForRound(roundId) {
  if (roundId <= 1) return 1;
  if (roundId === 2) return 2; // R1 成功后：tier 2
  if (roundId === 3) return 2; // R2 失败 → 同档重试：仍是 tier 2
  return 2 + (roundId - 3); // R4=3（R3 通过后）… R10=9（R2 占掉一轮，10 轮 ≠ 10 档位）
}

function targetForRound(roundId) {
  return P0_USD_E8 * (1n << BigInt(tierForRound(roundId)));
}

const ROUND_STAKES_TOKENS = {
  1: 214_800_000n,
  2: 241_500_000n,
  3: 386_200_000n,
};

// R3：已收盘 12 根（24 根过半，其中 8 根达标），第 13 根为 live；之后按 C 继续推进
const R3_SEEDED_CANDLES = 12;
const R3_OBSERVATION_START = EPOCH - R3_SEEDED_CANDLES * C;
const R3_STAKE_CLOSE = R3_OBSERVATION_START;
const R3_STAKE_OPEN = R3_STAKE_CLOSE - 3 * DAY;

const R1_STAKE_CLOSE = EPOCH - 21 * DAY;
const R2_STAKE_CLOSE = EPOCH - 14 * DAY;

/* ------------------------------ 质押 / 领取（v10） --------------------------- */
const stakeRecords = [];
for (const roundId of [1, 2, 3]) {
  const amounts = splitAmount(ROUND_STAKES_TOKENS[roundId]);
  const openAt =
    roundId === 1 ? R1_STAKE_CLOSE - 3 * DAY : roundId === 2 ? R2_STAKE_CLOSE - 3 * DAY : R3_STAKE_OPEN;
  amounts.forEach((tokens, index) => {
    stakeRecords.push({
      roundId,
      index,
      address: ADDRESSES[index],
      amountRaw: BigInt(tokens) * TOKEN_SCALE,
      acceptedAt: openAt + index * 3600_000 + ((index * 7919) % 3_600_000),
      // 夹具：A0 已领 R1（本金 + 全额奖励一次领完）
      claimed: roundId === 1 && index === 0 ? 1 : 0,
    });
  });
}

// 每轮总质押（v10：总权重 = 总质押）
const roundStakeTotals = new Map();
for (const roundId of [1, 2, 3]) {
  const total = stakeRecords
    .filter((record) => record.roundId === roundId)
    .reduce((acc, record) => acc + record.amountRaw, 0n);
  roundStakeTotals.set(roundId, total);
}

// R1 奖励（仅 SUCCEEDED 轮；纯按质押比例）
const r1Records = stakeRecords.filter((record) => record.roundId === 1);
const r1TotalStake = roundStakeTotals.get(1);
const rewardOf = (stakeRaw) => rewardFor(ROUND_REWARD_RAW, stakeRaw, r1TotalStake);

const roundRows = [];
for (let roundId = 1; roundId <= ROUND_COUNT; roundId++) {
  const target = targetForRound(roundId).toString();
  const tier = tierForRound(roundId);
  let state = 'UNOPENED';
  let stakeOpen = 'NULL';
  let stakeClose = 'NULL';
  let observationStart = 'NULL';
  let observationEnd = 'NULL';
  let candlesSeen = 0;
  let qualified = 0;
  let totalStake = 0n;
  let stakers = 0;
  let result = 'NULL';
  let burned = 'NULL';
  let teamReleased = 'NULL';
  let updatedAt = EPOCH;

  if (roundId === 1) {
    state = 'SUCCEEDED';
    stakeOpen = n(R1_STAKE_CLOSE - 3 * DAY);
    stakeClose = n(R1_STAKE_CLOSE);
    observationStart = n(R1_STAKE_CLOSE);
    observationEnd = n(R1_STAKE_CLOSE + CANDLE_COUNT * C);
    candlesSeen = CANDLE_COUNT;
    qualified = 20;
    totalStake = ROUND_STAKES_TOKENS[1] * TOKEN_SCALE;
    stakers = ADDRESSES.length;
    result = "'SUCCESS'";
    teamReleased = q(raw(TEAM_ROUND_TOKENS));
    updatedAt = R1_STAKE_CLOSE + CANDLE_COUNT * C;
  } else if (roundId === 2) {
    state = 'FAILED_PERMANENT';
    stakeOpen = n(R2_STAKE_CLOSE - 3 * DAY);
    stakeClose = n(R2_STAKE_CLOSE);
    observationStart = n(R2_STAKE_CLOSE);
    observationEnd = n(R2_STAKE_CLOSE + CANDLE_COUNT * C);
    candlesSeen = CANDLE_COUNT;
    qualified = 12;
    totalStake = ROUND_STAKES_TOKENS[2] * TOKEN_SCALE;
    stakers = ADDRESSES.length;
    result = "'FAILURE'";
    burned = (ROUND_REWARD_RAW + TEAM_ROUND_TOKENS * TOKEN_SCALE + ROUND_STAKES_TOKENS[2] * TOKEN_SCALE).toString();
    updatedAt = R2_STAKE_CLOSE + CANDLE_COUNT * C;
  } else if (roundId === 3) {
    state = 'OBSERVING';
    stakeOpen = n(R3_STAKE_OPEN);
    stakeClose = n(R3_STAKE_CLOSE);
    observationStart = n(R3_OBSERVATION_START);
    observationEnd = n(R3_OBSERVATION_START + CANDLE_COUNT * C);
    candlesSeen = R3_SEEDED_CANDLES;
    qualified = 8;
    totalStake = ROUND_STAKES_TOKENS[3] * TOKEN_SCALE;
    stakers = ADDRESSES.length;
    updatedAt = EPOCH;
  }

  roundRows.push([
    n(roundId),
    q(state),
    n(tier),
    q(target),
    q(ROUND_REWARD_RAW.toString()),
    stakeOpen,
    stakeClose,
    observationStart,
    observationEnd,
    n(candlesSeen),
    n(qualified),
    q(totalStake.toString()),
    q('0'), // total_weight_raw（v10 = 总质押，下方回填）
    'NULL', // candle_hash（下方按滚动哈希回填）
    n(stakers),
    result,
    burned,
    teamReleased,
    n(updatedAt),
  ]);
}

const roundRowById = new Map(roundRows.map((row) => [Number(row[0]), row]));
for (const roundId of [1, 2, 3]) {
  const row = roundRowById.get(roundId);
  row[11] = q(roundStakeTotals.get(roundId).toString());
  row[12] = q(roundStakeTotals.get(roundId).toString());
  row[14] = n(12);
}
// R2 三笔销毁：奖励 7 亿 + 团队 1.2 亿 + 本轮全部本金（241.5M）
const r2TotalRaw = roundStakeTotals.get(2);
const r2BurnedRaw = ROUND_REWARD_RAW + TEAM_ROUND_TOKENS * TOKEN_SCALE + r2TotalRaw;
roundRowById.get(2)[16] = q(r2BurnedRaw.toString());

// v10 奖励账本（演示只对已成功的 R1 生成，按质押比例全额）
const roundRewardRows = r1Records.map((record) => [
  n(1),
  q(record.address),
  q(record.amountRaw.toString()),
  q(rewardOf(record.amountRaw).toString()),
  n(R1_STAKE_CLOSE + CANDLE_COUNT * C),
  n(EPOCH),
]);

// 领取记录：A0 已领 R1 本金 + 全额奖励（一次 Claim）
const claimRows = [];
const a0Record = r1Records.find((record) => record.index === 0);
const a0ClaimedAt = R1_STAKE_CLOSE + 9 * DAY;
claimRows.push([n(1), q(ADDRESSES[0]), q('principal'), q(a0Record.amountRaw.toString()), n(a0ClaimedAt)]);
claimRows.push([n(1), q(ADDRESSES[0]), q('reward'), q(rewardOf(a0Record.amountRaw).toString()), n(a0ClaimedAt)]);

// stakes 行（v10：weight_raw = amount_raw；V8 的连续参与 / 奖励态 / 邀请人列不再写入）
const stakeRows = stakeRecords.map((record) => [
  n(record.roundId),
  q(record.address),
  q(record.amountRaw.toString()),
  q(record.amountRaw.toString()),
  q('seed-r' + record.roundId + '-' + record.index),
  n(RISK_DISCLOSURE_VERSION),
  1,
  n(record.claimed),
  n(record.claimed),
  n(record.acceptedAt),
]);

/* ------------------------------ K 线（与 worker/src/sources/demo.ts 同算法） ----------------------------- */

const CANDLE_PATTERNS = {
  // 24 根中 20 根达标（R1 成功）
  1: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  // 24 根中 12 根达标（R2 失败）
  2: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22],
};
/** R3+ 默认：前 12 根中 8 根达标（与 demo.ts 的模式一致） */
const DEFAULT_CANDLE_PATTERN = [0, 1, 2, 4, 6, 7, 8, 10];

function candleHash32(...parts) {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    let x = part >>> 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
      x >>>= 8;
    }
  }
  return h >>> 0;
}

function rand01(seed) {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hex32(value) {
  return (value >>> 0).toString(16).padStart(8, '0');
}

function candleQualified(roundId, candleIndex) {
  const pattern = CANDLE_PATTERNS[roundId] || DEFAULT_CANDLE_PATTERN;
  return pattern.includes(candleIndex);
}

function candleTwap(roundId, target, candleIndex) {
  const qualified = candleQualified(roundId, candleIndex);
  const r = rand01(candleHash32(roundId, candleIndex, 11));
  const deltaBps = qualified ? 20 + Math.floor(r * 380) : -(60 + Math.floor(r * 640));
  return target + (target * BigInt(deltaBps)) / 10000n;
}

function candleRows(roundId, target, observationStart, limit, recordedAt) {
  const rows = [];
  for (let candleIndex = 0; candleIndex < limit; candleIndex++) {
    const periodStart = observationStart + candleIndex * C;
    const periodEnd = periodStart + C;
    const r = rand01(candleHash32(roundId, candleIndex, 23));
    const digest =
      '0x' +
      ['a', 'b']
        .map((salt, i) => {
          const code = salt.charCodeAt(0);
          return hex32(candleHash32(roundId, candleIndex, code, i)) + hex32(candleHash32(roundId, candleIndex, code + 7, i));
        })
        .join('');
    rows.push([
      n(roundId),
      n(candleIndex),
      n(periodStart),
      n(periodEnd),
      q(candleTwap(roundId, target, candleIndex).toString()),
      candleQualified(roundId, candleIndex) ? 1 : 0,
      n(9700 + Math.floor(r * 290)),
      n(4 + (r > 0.5 ? 1 : 0)),
      q(digest),
      n(recordedAt),
    ]);
  }
  return rows;
}

const candleSeedRows = [
  ...candleRows(1, targetForRound(1), R1_STAKE_CLOSE, CANDLE_COUNT, R1_STAKE_CLOSE + CANDLE_COUNT * C),
  ...candleRows(2, targetForRound(2), R2_STAKE_CLOSE, CANDLE_COUNT, R2_STAKE_CLOSE + CANDLE_COUNT * C),
  ...candleRows(3, targetForRound(3), R3_OBSERVATION_START, R3_SEEDED_CANDLES, EPOCH),
];

// v10：按轮计算 K 线滚动哈希并回填 rounds.candle_hash（链上只存这一个值）
const candlesByRound = new Map();
for (const row of candleSeedRows) {
  const roundId = Number(row[0]);
  const list = candlesByRound.get(roundId) ?? [];
  list.push(row);
  candlesByRound.set(roundId, list);
}
for (const [roundId, rows] of candlesByRound) {
  const roundRow = roundRowById.get(roundId);
  if (roundRow) roundRow[13] = q(rollingCandleHash(rows));
}

/* ------------------------------ 销毁账本 ----------------------------- */

const burnRows = [
  [2, q('reward'), q(ROUND_REWARD_RAW.toString()), q('R2:reward'), 1, n(R2_STAKE_CLOSE + CANDLE_COUNT * C), n(R2_STAKE_CLOSE + CANDLE_COUNT * C + 60_000)],
  [2, q('team'), q((TEAM_ROUND_TOKENS * TOKEN_SCALE).toString()), q('R2:team'), 1, n(R2_STAKE_CLOSE + CANDLE_COUNT * C), n(R2_STAKE_CLOSE + CANDLE_COUNT * C + 60_000)],
  [
    2,
    q('principal'),
    q(r2TotalRaw.toString()),
    q('R2:principal'),
    1,
    n(R2_STAKE_CLOSE + CANDLE_COUNT * C),
    n(R2_STAKE_CLOSE + CANDLE_COUNT * C + 60_000),
  ],
];

/* ------------------------------ 成交 / 盘口 --------------------------- */

const R3_TARGET = targetForRound(3); // tier 2 = 4 × P0（R2 失败同档重试）
const TRADE_COUNT = 80;
const tradeRows = [];
let tradeVolume = 0n;
let tradeTs = EPOCH - 15_000;
for (let i = 0; i < TRADE_COUNT; i++) {
  const priceBps = Math.round((rand() - 0.5) * 200); // ±1%
  const price = R3_TARGET + (R3_TARGET * BigInt(priceBps)) / 10000n;
  // 主体 2,000 ~ 200,000 A9（对齐原型 tape 量级），约 10% 为 30 万+ 大单
  const whale = rand() > 0.9;
  const tokens = whale ? 300_000 + Math.floor(rand() * 150_000) : 2_000 + Math.floor(rand() * 198_000);
  const amountRaw = BigInt(tokens) * TOKEN_SCALE;
  const valueUsdE8 = (amountRaw * price) / TOKEN_SCALE;
  tradeVolume += valueUsdE8;
  tradeRows.push([
    n(i + 1),
    n(tradeTs),
    q(rand() > 0.45 ? 'BUY' : 'SELL'),
    q(amountRaw.toString()),
    q(price.toString()),
    q(valueUsdE8.toString()),
    tokens >= 300_000 ? 1 : 0,
  ]);
  tradeTs -= 600_000 + Math.floor(rand() * 900_000);
}
tradeRows.reverse(); // 时间从早到晚，便于阅读；id 与时间顺序一致

const bookRows = [];
for (let i = 0; i < 10; i++) {
  const askPrice = R3_TARGET + (R3_TARGET * BigInt(6 * (i + 1))) / 10000n;
  const bidPrice = R3_TARGET - (R3_TARGET * BigInt(6 * (i + 1))) / 10000n;
  // 档位量级对齐原型：40,000 ~ 300,000 A9 / 档
  const askAmount = BigInt(40_000 + Math.floor(rand() * 260_000)) * TOKEN_SCALE;
  const bidAmount = BigInt(40_000 + Math.floor(rand() * 260_000)) * TOKEN_SCALE;
  bookRows.push([q('ask'), q(askPrice.toString()), q(askAmount.toString()), n(i)]);
  bookRows.push([q('bid'), q(bidPrice.toString()), q(bidAmount.toString()), n(i)]);
}

/* ------------------------------ 审计事件 ----------------------------- */

const eventRows = [
  [n(R1_STAKE_CLOSE - 7 * DAY), q('info'), q('system'), q('ROUND_OPENED'), q('R1 质押窗口开启（演示种子）')],
  [n(R1_STAKE_CLOSE), q('info'), q('system'), q('STAKING_CLOSED'), q('R1 质押窗口关闭：12 个地址，214,800,000 A9')],
  [n(R1_STAKE_CLOSE + CANDLE_COUNT * C), q('info'), q('system'), q('ROUND_SUCCEEDED'), q('R1 SUCCEEDED：20/24 根达标，本金不销毁，7 亿奖励按质押比例开放领取，团队 1.2 亿已释放')],
  [n(R2_STAKE_CLOSE - 7 * DAY), q('info'), q('system'), q('ROUND_OPENED'), q('R2 质押窗口开启（演示种子）')],
  [n(R2_STAKE_CLOSE), q('info'), q('system'), q('STAKING_CLOSED'), q('R2 质押窗口关闭：12 个地址，241,500,000 A9')],
  [
    n(R2_STAKE_CLOSE + CANDLE_COUNT * C),
    q('warn'),
    q('system'),
    q('ROUND_FAILED_PERMANENT'),
    q('R2 FAILED_PERMANENT：12/24 达标，销毁奖励 700,000,000 + 团队 120,000,000 + 质押本金 241,500,000 = 1,061,500,000 A9'),
  ],
  [
    n(R2_STAKE_CLOSE + CANDLE_COUNT * C + 60_000),
    q('warn'),
    q('system'),
    q('BURN_CONFIRMED'),
    q('R2 burnId R2:reward / R2:team / R2:principal 已确认，供应量减少 1,061,500,000 A9'),
  ],
  [n(R3_STAKE_OPEN), q('info'), q('system'), q('ROUND_OPENED'), q('R3 质押窗口开启（演示种子）')],
  [n(R3_STAKE_CLOSE), q('info'), q('system'), q('STAKING_CLOSED'), q('R3 质押窗口关闭：12 个地址，386,200,000 A9')],
  [n(R3_OBSERVATION_START), q('info'), q('oracle'), q('OBSERVATION_STARTED'), q('R3 观察窗口开始：12 根，已收盘 12 根')],
  [n(EPOCH), q('info'), q('admin'), q('SEED_APPLIED'), q('演示种子数据写入完成（含 10 轮 / 36 笔质押 / 3 笔销毁）')],
];

/* ------------------------------ config / metrics --------------------- */

const configRows = [
  ['schema_version', '1'],
  ['token_name', 'A9'],
  ['token_symbol', 'A9'],
  ['token_decimals', String(TOKEN_DECIMALS)],
  ['p0_usd_e8', P0_USD_E8.toString()],
  ['price_multiplier', '2'],
  ['round_count', String(ROUND_COUNT)],
  ['round_reward_raw', ROUND_REWARD_RAW.toString()],
  ['team_round_raw', (TEAM_ROUND_TOKENS * TOKEN_SCALE).toString()],
  ['total_supply_raw', TOTAL_SUPPLY_RAW.toString()],
  ['candle_seconds', String(CANDLE_SECONDS)],
  ['candle_count', String(CANDLE_COUNT)],
  ['min_qualified_candles', String(MIN_QUALIFIED_CANDLES)],
  ['risk_disclosure_version', String(RISK_DISCLOSURE_VERSION)],
  ['stake_duration_seconds', String(STAKE_DURATION_SECONDS)],
  ['stake_gap_seconds', String(STAKE_GAP_SECONDS)],
  ['target_mode', 'FIXED_LADDER'],
  ['observation_seconds', String(OBSERVATION_SECONDS)],
  ['network', 'demo'],
  ['data_source', 'demo'],
  ['demo_epoch_ms', String(EPOCH)],
  ['demo_candle_seconds', String(DEMO_CANDLE_SECONDS)],
  ['demo_stake_seconds', '900'],
  ['demo_preview_seconds', '90'],
  ['demo_autoplay', '1'],
  // ---- v10（docs/34）：奖励纯按质押比例 ----
  ['min_stake_raw', (1_000n * TOKEN_SCALE).toString()],
  ['max_total_stake_raw', (200_000_000n * TOKEN_SCALE).toString()],
  ['ton_usd_e8', '300000000'],
  ['tonconnect_manifest_url', '/tonconnect-manifest.json'],
  ['liquidity_usd_e8', '180000000000000'],
  ['oracle_total_sources', '5'],
  ['oracle_valid_sources', '5'],
  ['oracle_coverage_bps', '9950'],
  ['oracle_config_version', 'v1.0.0-demo'],
  ['oracle_paused', '0'],
  // 合约地址：主网部署前由 Lead 填入（空串表示未部署）
  ['contract_jetton_master', ''],
  ['contract_round_controller', ''],
  ['contract_staking_vault', ''],
  ['contract_reward_vault', ''],
  ['contract_code_hash', ''],
  ['contract_oracle_config_hash', ''],
  ['contract_keeper', ''],
  ['contract_team_wallet', ''],
  ['contract_audit_report_url', ''],
];

const metricsRows = [
  ['demo_epoch_ms', String(EPOCH)],
  ['demo_candle_seconds', String(DEMO_CANDLE_SECONDS)],
  ['demo_stake_seconds', '900'],
  ['oracle_paused', '0'],
  ['oracle_last_update', String(EPOCH - 2500)],
  ['oracle_valid_sources', '5'],
  ['oracle_coverage_bps', '9950'],
  ['liquidity_usd_e8', '180000000000000'],
  ['seed_trade_volume_24h_usd_e8', tradeVolume.toString()],
  ['seed_applied_at', String(EPOCH)],
];

/* ------------------------------- 输出 SQL --------------------------- */

const statementChunks = [];
statementChunks.push(
  '-- A9 引信协议 — 演示种子数据（由 worker/scripts/generate-seed.mjs 生成，请勿手改）\n' +
    '-- ⚠️ 仅用于本地 / demo 环境；禁止在生产 chain 库执行。\n' +
    '-- ⚠️ 禁止移动到 worker/migrations/：D1 migrations 会执行该目录所有 .sql，会把演示假数据灌进生产。\n' +
    '-- 用法：wrangler d1 execute fuse-protocol --local --file=./seed/seed.sql（远端仅在 demo 环境显式执行）\n' +
    '-- EPOCH=' + EPOCH + ' (' + new Date(EPOCH).toISOString() + '), DEMO_CANDLE_SECONDS=' + DEMO_CANDLE_SECONDS + '\n' +
    '-- 状态：R1 SUCCEEDED(20/24)、R2 FAILED_PERMANENT(12/24，三笔销毁 1,061.5M)、R3 OBSERVING(12/24 已收盘)、R4..R10 UNOPENED\n' +
    '-- 档位（D-28 tier = 1 + 已成功轮数，失败不升档）：R1 tier1=232000 / R2 tier2=464000 / R3 tier2=464000 / R4 tier3=928000 …\n' +
    '-- v10：奖励 = floor(7 亿 × 质押 / 总质押)，仅 R1 有账；A0 已领 R1（本金 + 奖励）；weight_raw = amount_raw。\n' +
    '-- 幂等：先清空业务表再 INSERT OR REPLACE，可安全重复执行。\n',
);
statementChunks.push('DELETE FROM claims;');
statementChunks.push('DELETE FROM round_rewards;');
statementChunks.push('DELETE FROM stakes;');
statementChunks.push('DELETE FROM burn_ledger;');
statementChunks.push('DELETE FROM candles;');
statementChunks.push('DELETE FROM rounds;');
statementChunks.push('DELETE FROM trades;');
statementChunks.push('DELETE FROM book_levels;');
statementChunks.push('DELETE FROM refund_ledger;');
statementChunks.push('DELETE FROM admin_events;');
statementChunks.push('DELETE FROM config;');
statementChunks.push('DELETE FROM metrics;');
statementChunks.push("DELETE FROM sqlite_sequence WHERE name IN ('stakes','claims','burn_ledger','book_levels','admin_events');\n");

statementChunks.push(
  multiInsert(
    'config',
    ['key', 'value', 'updated_at'],
    configRows.map(([key, value]) => [q(key), q(value), n(EPOCH)]),
  ),
);
statementChunks.push(
  multiInsert(
    'metrics',
    ['key', 'value', 'updated_at'],
    metricsRows.map(([key, value]) => [q(key), q(value), n(EPOCH)]),
  ),
);
statementChunks.push(
  multiInsert(
    'rounds',
    [
      'round_id',
      'state',
      'target_tier',
      'target_price_usd_e8',
      'reward_budget_raw',
      'stake_open_at',
      'stake_close_at',
      'observation_start',
      'observation_end',
      'candles_seen',
      'qualified_candles',
      'total_accepted_stake_raw',
      'total_weight_raw',
      'candle_hash',
      'staker_count',
      'result',
      'burned_raw',
      'team_released_raw',
      'updated_at',
    ],
    roundRows,
  ),
);
statementChunks.push(
  multiInsert(
    'stakes',
    [
      'round_id',
      'address',
      'amount_raw',
      'weight_raw',
      'nonce',
      'risk_disclosure_version',
      'accept_full_principal_burn',
      'principal_claimed',
      'reward_claimed',
      'accepted_at',
    ],
    stakeRows,
  ),
);
statementChunks.push(
  multiInsert('claims', ['round_id', 'address', 'kind', 'amount_raw', 'claimed_at'], claimRows),
);
statementChunks.push(
  multiInsert(
    'round_rewards',
    ['round_id', 'address', 'weight_raw', 'reward_raw', 'created_at', 'updated_at'],
    roundRewardRows,
  ),
);
statementChunks.push(
  multiInsert(
    'candles',
    [
      'round_id',
      'candle_index',
      'period_start',
      'period_end',
      'twap_price_usd_e8',
      'qualified',
      'coverage_bps',
      'valid_source_count',
      'data_digest',
      'recorded_at',
    ],
    candleSeedRows,
  ),
);
statementChunks.push(
  multiInsert(
    'burn_ledger',
    ['round_id', 'kind', 'amount_raw', 'burn_ref', 'confirmed', 'created_at', 'confirmed_at'],
    burnRows,
  ),
);
statementChunks.push(
  multiInsert(
    'trades',
    ['id', 'ts', 'side', 'amount_raw', 'price_usd_e8', 'value_usd_e8', 'big'],
    tradeRows,
  ),
);
statementChunks.push(
  multiInsert('book_levels', ['side', 'price_usd_e8', 'amount_raw', 'seq'], bookRows),
);
statementChunks.push(
  multiInsert('admin_events', ['ts', 'level', 'actor', 'action', 'detail'], eventRows),
);

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, statementChunks.join('\n'), 'utf8');

/* ------------------------------- 自检 ------------------------------- */

const expectedTiers = Array.from({ length: ROUND_COUNT }, (_, i) => tierForRound(i + 1));
const expectedTargets = expectedTiers.map((tier) => (P0_USD_E8 * (1n << BigInt(tier))).toString());
const tierInvariant =
  expectedTiers.join(',') === '1,2,2,3,4,5,6,7,8,9' &&
  expectedTargets[0] === '232000' &&
  expectedTargets[1] === '464000' &&
  expectedTargets[2] === '464000' &&
  expectedTargets[3] === '928000' &&
  expectedTargets[9] === (P0_USD_E8 * 512n).toString();

// v10 自检：奖励不超发 / 权重 = 质押 / 最低质押 / A0 已领 R1 / R1 团队额度已释放 / 无 V8 账本
let rewardSum = 0n;
for (const record of r1Records) rewardSum += rewardOf(record.amountRaw);
const v10Invariant =
  rewardSum <= ROUND_REWARD_RAW &&
  stakeRecords.every((record) => record.amountRaw >= 1_000n * TOKEN_SCALE) &&
  stakeRows.every((row) => row[2] === row[3]) &&
  roundRowById.get(1)[17] === q(raw(TEAM_ROUND_TOKENS)) &&
  a0Record.claimed === 1 &&
  claimRows.length === 2;

const ok =
  tierInvariant &&
  v10Invariant &&
  r2BurnedRaw === 700_000_000n * TOKEN_SCALE + 120_000_000n * TOKEN_SCALE + r2TotalRaw &&
  ADDRESSES.length === 12 &&
  new Set(ADDRESSES).size === 12 &&
  ROUND_REWARD_RAW * BigInt(ROUND_COUNT) === 7_000_000_000n * TOKEN_SCALE &&
  TOTAL_SUPPLY_RAW === 10_000_000_000n * TOKEN_SCALE;

console.log('seed.sql 已生成 →', OUT_FILE);
console.log('  EPOCH                :', EPOCH, '(' + new Date(EPOCH).toISOString() + ')');
console.log('  DEMO_CANDLE_SECONDS  :', DEMO_CANDLE_SECONDS);
console.log('  rounds               :', roundRows.length, '(R1 SUCCEEDED / R2 FAILED_PERMANENT / R3 OBSERVING / R4-R10 UNOPENED)');
console.log('  stakes               :', stakeRows.length, '（12 地址 × R1/R2/R3，weight_raw = amount_raw）');
console.log('  claims               :', claimRows.length, '（A0 R1 本金 + 奖励）');
const toM = (raw) => (Number(raw / TOKEN_SCALE) / 1e6).toFixed(2) + 'M';
console.log('  burn_ledger          :', burnRows.length, '(R2 reward 700M + team 120M + principal', toM(r2TotalRaw) + ' =', toM(r2BurnedRaw) + ' A9)');
console.log('  v10 reward (R1)      : 按质押比例 floor(700M × stake / 总质押)，已派发合计', toM(rewardSum), '；round_rewards', roundRewardRows.length, '行');
console.log('  team_released (R1)   :', raw(TEAM_ROUND_TOKENS), 'raw（1.2 亿）');
console.log('  candles              :', candleSeedRows.length, '(R1 24 / R2 24 / R3 12)');
console.log('  trades               :', tradeRows.length, '/ book_levels:', bookRows.length, '/ admin_events:', eventRows.length);
console.log('  R3 已收盘 K 线       :', R3_SEEDED_CANDLES, '（8 达标 / 4 未达标，第 13 根为 live）');
console.log('  R3 target            :', R3_TARGET.toString(), 'USD_E8（tier', tierForRound(3), '=', Math.pow(2, tierForRound(3)), '× P0）');
console.log('  tier / target 序列   :', expectedTiers.map((tier, index) => 'R' + (index + 1) + ':tier' + tier + '=' + expectedTargets[index]).join(' '));
console.log('  invariants           :', ok ? 'OK' : 'FAILED');
if (!ok) process.exitCode = 1;
