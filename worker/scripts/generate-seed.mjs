#!/usr/bin/env node
/**
 * 生成 Cloudflare D1 演示种子数据：worker/migrations/seed.sql
 *
 * 设计目标：
 *  - 可复现：所有地址/数量/成交由固定种子推导，时间以 EPOCH（默认 now）为锚点。
 *  - 幂等：先 DELETE 再 INSERT OR REPLACE，可反复执行（本地/远端都安全）。
 *  - 与 worker/src/sources/demo.ts 的判定规则一致：R1 10/12 成功、R2 6/12 失败（销毁 991.5M）、
 *    R3 观察中（已收盘 5 根，按 DEMO_CANDLE_SECONDS 继续推进）、R4..R10 UNOPENED。
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
const OUT_FILE = join(WORKER_ROOT, 'migrations', 'seed.sql');

const TOKEN_SCALE = 1_000_000_000n;
const TOKEN_DECIMALS = 9;
const P0_USD_E8 = 400_000n;
const USD_SCALE = 100_000_000n;
const ROUND_COUNT = 10;
const CANDLE_COUNT = 12;
const MIN_QUALIFIED_CANDLES = 8;
const CANDLE_SECONDS = 14_400;
const OBSERVATION_SECONDS = CANDLE_SECONDS * CANDLE_COUNT;
const ROUND_REWARD_TOKENS = 750_000_000n;
const TOTAL_SUPPLY_TOKENS = 10_000_000_000n;
const ROUND_REWARD_RAW = ROUND_REWARD_TOKENS * TOKEN_SCALE;
const TOTAL_SUPPLY_RAW = TOTAL_SUPPLY_TOKENS * TOKEN_SCALE;
const RISK_DISCLOSURE_VERSION = 1;
const STAKE_DURATION_SECONDS = 7 * 24 * 3600;

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

const rand = mulberry32(0x46555345); // "FUSE"

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 12 个确定性演示地址（UQ + 46 字符 base64url，形状与 TON 用户友好地址一致）。 */
function demoAddress(index) {
  const digest = createHash('sha256').update('fuse-protocol-demo-wallet-' + index).digest();
  let out = 'UQ';
  for (let i = 0; i < 46; i++) out += B64URL[digest[i % digest.length] % 64];
  return out;
}

const ADDRESSES = Array.from({ length: 12 }, (_, i) => demoAddress(i));

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

const ROUND_STAKES_TOKENS = {
  1: 214_800_000n,
  2: 241_500_000n,
  3: 386_200_000n,
};

// R3：已收盘 6 根（4 达标 / 2 未达标），第 7 根为 live；之后按 C 继续推进
const R3_SEEDED_CANDLES = 6;
const R3_OBSERVATION_START = EPOCH - R3_SEEDED_CANDLES * C;
const R3_STAKE_CLOSE = R3_OBSERVATION_START - 30 * 60 * 1000;
const R3_STAKE_OPEN = R3_STAKE_CLOSE - 3 * DAY;

const R1_STAKE_CLOSE = EPOCH - 21 * DAY;
const R2_STAKE_CLOSE = EPOCH - 14 * DAY;

const roundRows = [];
for (let roundId = 1; roundId <= ROUND_COUNT; roundId++) {
  const target = (P0_USD_E8 * (1n << BigInt(roundId))).toString();
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
  let updatedAt = EPOCH;

  if (roundId === 1) {
    state = 'SUCCEEDED';
    stakeOpen = n(R1_STAKE_CLOSE - 7 * DAY);
    stakeClose = n(R1_STAKE_CLOSE);
    observationStart = n(R1_STAKE_CLOSE);
    observationEnd = n(R1_STAKE_CLOSE + CANDLE_COUNT * C);
    candlesSeen = CANDLE_COUNT;
    qualified = 10;
    totalStake = ROUND_STAKES_TOKENS[1] * TOKEN_SCALE;
    stakers = ADDRESSES.length;
    result = "'SUCCESS'";
    updatedAt = R1_STAKE_CLOSE + CANDLE_COUNT * C;
  } else if (roundId === 2) {
    state = 'FAILED_PERMANENT';
    stakeOpen = n(R2_STAKE_CLOSE - 7 * DAY);
    stakeClose = n(R2_STAKE_CLOSE);
    observationStart = n(R2_STAKE_CLOSE);
    observationEnd = n(R2_STAKE_CLOSE + CANDLE_COUNT * C);
    candlesSeen = CANDLE_COUNT;
    qualified = 6;
    totalStake = ROUND_STAKES_TOKENS[2] * TOKEN_SCALE;
    stakers = ADDRESSES.length;
    result = "'FAILURE'";
    burned = (ROUND_REWARD_RAW + ROUND_STAKES_TOKENS[2] * TOKEN_SCALE).toString();
    updatedAt = R2_STAKE_CLOSE + CANDLE_COUNT * C;
  } else if (roundId === 3) {
    state = 'OBSERVING';
    stakeOpen = n(R3_STAKE_OPEN);
    stakeClose = n(R3_STAKE_CLOSE);
    observationStart = n(R3_OBSERVATION_START);
    observationEnd = n(R3_OBSERVATION_START + CANDLE_COUNT * C);
    candlesSeen = R3_SEEDED_CANDLES;
    qualified = 4;
    totalStake = ROUND_STAKES_TOKENS[3] * TOKEN_SCALE;
    stakers = ADDRESSES.length;
    updatedAt = EPOCH;
  }

  roundRows.push([
    n(roundId),
    q(state),
    q(target),
    q(ROUND_REWARD_RAW.toString()),
    stakeOpen,
    stakeClose,
    observationStart,
    observationEnd,
    n(candlesSeen),
    n(qualified),
    q(totalStake.toString()),
    n(stakers),
    result,
    burned,
    n(updatedAt),
  ]);
}

/* ------------------------------ 质押 / 领取 --------------------------- */

const stakeRows = [];
const claimRows = [];
const claimedAddresses = new Set([ADDRESSES[0], ADDRESSES[1]]);
let r1TotalRaw = 0n;

for (const roundId of [1, 2, 3]) {
  const amounts = splitAmount(ROUND_STAKES_TOKENS[roundId]);
  const totalRaw = amounts.reduce((acc, value) => acc + BigInt(value) * TOKEN_SCALE, 0n);
  if (roundId === 1) r1TotalRaw = totalRaw;
  const openAt =
    roundId === 1 ? R1_STAKE_CLOSE - 7 * DAY : roundId === 2 ? R2_STAKE_CLOSE - 7 * DAY : R3_STAKE_OPEN;

  amounts.forEach((tokens, index) => {
    const address = ADDRESSES[index];
    const amountRaw = (BigInt(tokens) * TOKEN_SCALE).toString();
    const acceptedAt = openAt + index * 3600_000 + Math.floor(rand() * 60 * 60 * 1000);
    const claimed = roundId === 1 && claimedAddresses.has(address) ? 1 : 0;
    stakeRows.push([
      n(roundId),
      q(address),
      q(amountRaw),
      q(amountRaw),
      q('seed-r' + roundId + '-' + index),
      n(RISK_DISCLOSURE_VERSION),
      1,
      n(claimed),
      n(claimed),
      n(acceptedAt),
    ]);
    if (claimed === 1) {
      const rewardRaw = (ROUND_REWARD_RAW * BigInt(amountRaw)) / r1TotalRaw;
      claimRows.push([n(1), q(address), q('principal'), q(amountRaw), n(R1_STAKE_CLOSE + 9 * DAY)]);
      claimRows.push([n(1), q(address), q('reward'), q(rewardRaw.toString()), n(R1_STAKE_CLOSE + 9 * DAY + 60_000)]);
    }
  });
}

/* ------------------------------ K 线（与 worker/src/sources/demo.ts 同算法） ----------------------------- */

const CANDLE_PATTERNS = {
  1: [0, 1, 2, 4, 5, 6, 7, 9, 10, 11],
  2: [0, 1, 3, 5, 8, 10],
};
/** R3+ 默认：前 6 根 4 达标 / 2 未达标，12 根共 9 达标（与 demo.ts DEFAULT_PATTERN 一致） */
const DEFAULT_CANDLE_PATTERN = [0, 1, 2, 4, 6, 7, 8, 10, 11];

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
  ...candleRows(1, P0_USD_E8 * (1n << 1n), R1_STAKE_CLOSE, CANDLE_COUNT, R1_STAKE_CLOSE + CANDLE_COUNT * C),
  ...candleRows(2, P0_USD_E8 * (1n << 2n), R2_STAKE_CLOSE, CANDLE_COUNT, R2_STAKE_CLOSE + CANDLE_COUNT * C),
  ...candleRows(3, P0_USD_E8 * (1n << 3n), R3_OBSERVATION_START, R3_SEEDED_CANDLES, EPOCH),
];

/* ------------------------------ 销毁账本 ----------------------------- */

const burnRows = [
  [2, q('reward'), q(ROUND_REWARD_RAW.toString()), q('R2:reward'), 1, n(R2_STAKE_CLOSE + CANDLE_COUNT * C), n(R2_STAKE_CLOSE + CANDLE_COUNT * C + 60_000)],
  [
    2,
    q('principal'),
    q((ROUND_STAKES_TOKENS[2] * TOKEN_SCALE).toString()),
    q('R2:principal'),
    1,
    n(R2_STAKE_CLOSE + CANDLE_COUNT * C),
    n(R2_STAKE_CLOSE + CANDLE_COUNT * C + 60_000),
  ],
];

/* ------------------------------ 成交 / 盘口 --------------------------- */

const R3_TARGET = P0_USD_E8 * (1n << 3n);
const TRADE_COUNT = 80;
const tradeRows = [];
let tradeVolume = 0n;
let tradeTs = EPOCH - 15_000;
for (let i = 0; i < TRADE_COUNT; i++) {
  const priceBps = Math.round((rand() - 0.5) * 200); // ±1%
  const price = R3_TARGET + (R3_TARGET * BigInt(priceBps)) / 10000n;
  // 主体 2,000 ~ 200,000 FUSE（对齐原型 tape 量级），约 10% 为 30 万+ 大单
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
  // 档位量级对齐原型：40,000 ~ 300,000 FUSE / 档
  const askAmount = BigInt(40_000 + Math.floor(rand() * 260_000)) * TOKEN_SCALE;
  const bidAmount = BigInt(40_000 + Math.floor(rand() * 260_000)) * TOKEN_SCALE;
  bookRows.push([q('ask'), q(askPrice.toString()), q(askAmount.toString()), n(i)]);
  bookRows.push([q('bid'), q(bidPrice.toString()), q(bidAmount.toString()), n(i)]);
}

/* ------------------------------ 审计事件 ----------------------------- */

const eventRows = [
  [n(R1_STAKE_CLOSE - 7 * DAY), q('info'), q('system'), q('ROUND_OPENED'), q('R1 质押窗口开启（演示种子）')],
  [n(R1_STAKE_CLOSE), q('info'), q('system'), q('STAKING_CLOSED'), q('R1 质押窗口关闭：12 个地址，214,800,000 FUSE')],
  [n(R1_STAKE_CLOSE + CANDLE_COUNT * C), q('info'), q('system'), q('ROUND_SUCCEEDED'), q('R1 SUCCEEDED：10/12 根达标，本金不销毁，7.5 亿奖励开放领取')],
  [n(R2_STAKE_CLOSE - 7 * DAY), q('info'), q('system'), q('ROUND_OPENED'), q('R2 质押窗口开启（演示种子）')],
  [n(R2_STAKE_CLOSE), q('info'), q('system'), q('STAKING_CLOSED'), q('R2 质押窗口关闭：12 个地址，241,500,000 FUSE')],
  [
    n(R2_STAKE_CLOSE + CANDLE_COUNT * C),
    q('warn'),
    q('system'),
    q('ROUND_FAILED_PERMANENT'),
    q('R2 FAILED_PERMANENT：6/12 达标，销毁奖励 750,000,000 + 质押本金 241,500,000 = 991,500,000 FUSE'),
  ],
  [
    n(R2_STAKE_CLOSE + CANDLE_COUNT * C + 60_000),
    q('warn'),
    q('system'),
    q('BURN_CONFIRMED'),
    q('R2 burnId R2:reward / R2:principal 已确认，供应量减少 991,500,000 FUSE'),
  ],
  [n(R3_STAKE_OPEN), q('info'), q('system'), q('ROUND_OPENED'), q('R3 质押窗口开启（演示种子）')],
  [n(R3_STAKE_CLOSE), q('info'), q('system'), q('STAKING_CLOSED'), q('R3 质押窗口关闭：12 个地址，386,200,000 FUSE')],
  [n(R3_OBSERVATION_START), q('info'), q('oracle'), q('OBSERVATION_STARTED'), q('R3 观察窗口开始：12 根，已收盘 5 根')],
  [n(EPOCH), q('info'), q('admin'), q('SEED_APPLIED'), q('演示种子数据写入完成（含 10 轮 / 36 笔质押 / 2 笔销毁）')],
];

/* ------------------------------ config / metrics --------------------- */

const configRows = [
  ['schema_version', '1'],
  ['token_name', 'FUSE'],
  ['token_symbol', 'FUSE'],
  ['token_decimals', String(TOKEN_DECIMALS)],
  ['p0_usd_e8', P0_USD_E8.toString()],
  ['price_multiplier', '2'],
  ['round_count', String(ROUND_COUNT)],
  ['round_reward_raw', ROUND_REWARD_RAW.toString()],
  ['total_supply_raw', TOTAL_SUPPLY_RAW.toString()],
  ['candle_seconds', String(CANDLE_SECONDS)],
  ['candle_count', String(CANDLE_COUNT)],
  ['min_qualified_candles', String(MIN_QUALIFIED_CANDLES)],
  ['risk_disclosure_version', String(RISK_DISCLOSURE_VERSION)],
  ['stake_duration_seconds', String(STAKE_DURATION_SECONDS)],
  ['observation_seconds', String(OBSERVATION_SECONDS)],
  ['network', 'demo'],
  ['data_source', 'demo'],
  ['demo_epoch_ms', String(EPOCH)],
  ['demo_candle_seconds', String(DEMO_CANDLE_SECONDS)],
  ['demo_stake_seconds', '900'],
  ['demo_autoplay', '1'],
  ['ton_usd_e8', '300000000'],
  ['tonconnect_manifest_url', '/tonconnect-manifest.json'],
  ['liquidity_usd_e8', '180000000000000'],
  ['oracle_total_sources', '5'],
  ['oracle_valid_sources', '5'],
  ['oracle_coverage_bps', '9950'],
  ['oracle_config_version', 'v1.0.0-demo'],
  ['oracle_paused', '0'],
  // 合约地址：主网部署前由 Lead 填入（null 表示未部署）
  ['contract_jetton_master', ''],
  ['contract_round_controller', ''],
  ['contract_staking_vault', ''],
  ['contract_reward_vault', ''],
  ['contract_oracle_adapter', ''],
  ['contract_code_hash', ''],
  ['contract_oracle_config_hash', ''],
  ['contract_multisig', ''],
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
  '-- FUSE 引信协议 — 演示种子数据（由 worker/scripts/generate-seed.mjs 生成，请勿手改）\n' +
    '-- EPOCH=' + EPOCH + ' (' + new Date(EPOCH).toISOString() + '), DEMO_CANDLE_SECONDS=' + DEMO_CANDLE_SECONDS + '\n' +
    '-- 状态：R1 SUCCEEDED(10/12)、R2 FAILED_PERMANENT(6/12, 销毁 991.5M)、R3 OBSERVING(5/12 已收盘)、R4..R10 UNOPENED\n' +
    '-- 幂等：先清空业务表再 INSERT OR REPLACE，可安全重复执行。\n',
);
statementChunks.push('DELETE FROM claims;');
statementChunks.push('DELETE FROM stakes;');
statementChunks.push('DELETE FROM burn_ledger;');
statementChunks.push('DELETE FROM candles;');
statementChunks.push('DELETE FROM rounds;');
statementChunks.push('DELETE FROM trades;');
statementChunks.push('DELETE FROM book_levels;');
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
      'target_price_usd_e8',
      'reward_budget_raw',
      'stake_open_at',
      'stake_close_at',
      'observation_start',
      'observation_end',
      'candles_seen',
      'qualified_candles',
      'total_accepted_stake_raw',
      'staker_count',
      'result',
      'burned_raw',
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

const burnedInvariant = ROUND_REWARD_RAW + ROUND_STAKES_TOKENS[2] * TOKEN_SCALE;
const ok =
  burnedInvariant === 750_000_000n * TOKEN_SCALE + 241_500_000n * TOKEN_SCALE &&
  ADDRESSES.length === 12 &&
  new Set(ADDRESSES).size === 12 &&
  ROUND_REWARD_RAW * BigInt(ROUND_COUNT) === 7_500_000_000n * TOKEN_SCALE &&
  TOTAL_SUPPLY_RAW === 10_000_000_000n * TOKEN_SCALE;

console.log('seed.sql 已生成 →', OUT_FILE);
console.log('  EPOCH                :', EPOCH, '(' + new Date(EPOCH).toISOString() + ')');
console.log('  DEMO_CANDLE_SECONDS  :', DEMO_CANDLE_SECONDS);
console.log('  rounds               :', roundRows.length, '(R1 SUCCEEDED / R2 FAILED_PERMANENT / R3 OBSERVING / R4-R10 UNOPENED)');
console.log('  stakes               :', stakeRows.length, '（12 地址 × R1/R2/R3）');
console.log('  claims               :', claimRows.length);
console.log('  burn_ledger          :', burnRows.length, '(R2 reward 750,000,000 + principal 241,500,000 = 991,500,000 FUSE)');
console.log('  candles              :', candleSeedRows.length, '(R1 12 / R2 12 / R3 6)');
console.log('  trades               :', tradeRows.length, '/ book_levels:', bookRows.length, '/ admin_events:', eventRows.length);
console.log('  R3 已收盘 K 线       :', R3_SEEDED_CANDLES, '（4 达标 / 2 未达标，第 7 根为 live）');
console.log('  R3 target            :', R3_TARGET.toString(), 'USD_E8（= 8 × P0）');
console.log('  invariants           :', ok ? 'OK' : 'FAILED');
if (!ok) process.exitCode = 1;
