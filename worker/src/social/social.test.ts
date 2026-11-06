/**
 * 社交层纯函数单测（战力 / 战队等级 / 军饷 / 城门剩余美元 / 池子解析 / 通用小工具）。
 *
 * 运行（仓库根目录）：
 *   node --import ./worker/src/social/test-register.mjs --test worker/src/social/social.test.ts
 *
 * 与 bot 单测一致，使用 node:test（无第三方依赖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTonAddress } from '../indexer/address';
import { escapeMarkup, inviteCodeOf, isInviteCode, isSquadCode, maskWallet, seasonOfRound, USDT_MASTER_ADDRESS } from './common';
import { computeJunxiang, type JunxiangMember } from './junxiang';
import { phaseOf, remainingUsd } from './gate';
import { medalsOf, powerOf, rankOf, streakOf, timingBps } from './power';
import { newSquadCode, squadLevel, squadProgress, squadSwitchVerdict } from './squad';
import { usdtReserveFromPool } from './pool';

function eq(actual: unknown, expected: unknown, label = 'value'): void {
  assert.deepEqual(actual, expected, label);
}

function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
}

function closeTo(actual: number, expected: number, label: string, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, got ${actual}`);
}

const HOUR = 3_600_000;
const BIG = 1_000_000_000_000n;

/* ------------------------------ 战力 ------------------------------ */

test('timingBps 三档边界：0-12h ×1.5，12-24h ×1.2，之后 ×1.0', () => {
  eq(timingBps(0, 0), 15_000n, 'at open');
  eq(timingBps(12 * HOUR - 1, 0), 15_000n, 'just before 12h');
  eq(timingBps(12 * HOUR, 0), 12_000n, 'at 12h');
  eq(timingBps(24 * HOUR - 1, 0), 12_000n, 'just before 24h');
  eq(timingBps(24 * HOUR, 0), 10_000n, 'at 24h');
  eq(timingBps(35 * HOUR, 0), 10_000n, 'late');
});

test('timingBps：stakeOpenAt 为空时统一 ×1.0', () => {
  eq(timingBps(1, null), 10_000n, 'null window');
});

test('powerOf 按笔求和：100@1h + 200@13h + 300@30h = 150 + 240 + 300', () => {
  const deposits = [
    { amountRaw: 100n, acceptedAt: 1 * HOUR },
    { amountRaw: 200n, acceptedAt: 13 * HOUR },
    { amountRaw: 300n, acceptedAt: 30 * HOUR },
  ];
  eq(powerOf(deposits, 0), 690n, 'sum');
});

test('powerOf 忽略非正金额；无开窗时间按 ×1.0 计', () => {
  eq(powerOf([{ amountRaw: 0n, acceptedAt: 0 }, { amountRaw: -5n, acceptedAt: 0 }], 0), 0n, 'non-positive');
  eq(powerOf([{ amountRaw: 1000n, acceptedAt: 0 }], null), 1000n, 'no window');
  eq(powerOf([], 0), 0n, 'empty');
});

test('powerOf 大额不丢精度（bigint）', () => {
  eq(powerOf([{ amountRaw: BIG, acceptedAt: 0 }], 0), (BIG * 15_000n) / 10_000n, 'big');
});

test('rankOf 竞争排名：同分同名次，未上车为 null', () => {
  const powers = new Map<string, bigint>([
    ['a', 10n],
    ['b', 30n],
    ['c', 30n],
    ['d', 5n],
    ['z', 0n],
  ]);
  eq(rankOf(powers, 'b'), 1, 'b');
  eq(rankOf(powers, 'c'), 1, 'c');
  eq(rankOf(powers, 'a'), 3, 'a');
  eq(rankOf(powers, 'd'), 4, 'd');
  eq(rankOf(powers, 'z'), null, 'zero power');
  eq(rankOf(powers, 'nobody'), null, 'missing');
});

test('medalsOf 与 streakOf', () => {
  const staked = new Set([1, 2, 4]);
  eq(medalsOf(staked, new Set([2, 3])), 1, 'medals');
  eq(streakOf(staked, 4), 1, 'streak ends at 4 (3 missing)');
  eq(streakOf(staked, 2), 2, 'streak 1..2');
  eq(streakOf(staked, 0), 0, 'no latest round');
});

/* ------------------------------ 战队 ------------------------------ */

test('squadProgress：还差人数 = 下一档门槛 − 本城上车人数，满级为 null', () => {
  eq(squadProgress(0), { stakersThisRound: 0, level: 0, nextLevel: 1, remainingToNext: 5 }, '0');
  eq(squadProgress(4), { stakersThisRound: 4, level: 0, nextLevel: 1, remainingToNext: 1 }, '4');
  eq(squadProgress(5), { stakersThisRound: 5, level: 1, nextLevel: 2, remainingToNext: 15 }, '5');
  eq(squadProgress(19), { stakersThisRound: 19, level: 1, nextLevel: 2, remainingToNext: 1 }, '19');
  eq(squadProgress(20), { stakersThisRound: 20, level: 2, nextLevel: 3, remainingToNext: 80 }, '20');
  eq(squadProgress(499), { stakersThisRound: 499, level: 3, nextLevel: 4, remainingToNext: 1 }, '499');
  eq(squadProgress(500), { stakersThisRound: 500, level: 4, nextLevel: null, remainingToNext: null }, '500');
  eq(squadProgress(10_000), { stakersThisRound: 10_000, level: 4, nextLevel: null, remainingToNext: null }, 'huge');
  eq(squadProgress(-3), { stakersThisRound: 0, level: 0, nextLevel: 1, remainingToNext: 5 }, 'negative');
  eq(squadProgress(7.9), { stakersThisRound: 7, level: 1, nextLevel: 2, remainingToNext: 13 }, 'fraction');
});

test('squadLevel 边界：4 人未成团；5 / 20 / 100 / 500 分别 Lv1..Lv4', () => {
  eq(squadLevel(0), { level: 0, bonusBps: 0 }, '0');
  eq(squadLevel(4), { level: 0, bonusBps: 0 }, '4');
  eq(squadLevel(5), { level: 1, bonusBps: 300 }, '5');
  eq(squadLevel(19), { level: 1, bonusBps: 300 }, '19');
  eq(squadLevel(20), { level: 2, bonusBps: 600 }, '20');
  eq(squadLevel(99), { level: 2, bonusBps: 600 }, '99');
  eq(squadLevel(100), { level: 3, bonusBps: 1_000 }, '100');
  eq(squadLevel(499), { level: 3, bonusBps: 1_000 }, '499');
  eq(squadLevel(500), { level: 4, bonusBps: 1_500 }, '500');
  eq(squadLevel(10_000), { level: 4, bonusBps: 1_500 }, 'huge');
});

test('squadSwitchVerdict：首次入队、同队 noop、团长不可离队、每赛季一次换队', () => {
  eq(
    squadSwitchVerdict({ currentSquadCode: null, isLeaderOfCurrent: false, squadChangedSeason: null, season: 1, targetCode: 'AAAAAA' }),
    { ok: true, noop: false, markSeason: false },
    'first join',
  );
  eq(
    squadSwitchVerdict({ currentSquadCode: 'AAAAAA', isLeaderOfCurrent: true, squadChangedSeason: null, season: 1, targetCode: 'AAAAAA' }),
    { ok: true, noop: true, markSeason: false },
    'same squad',
  );
  eq(
    squadSwitchVerdict({ currentSquadCode: 'AAAAAA', isLeaderOfCurrent: true, squadChangedSeason: null, season: 1, targetCode: 'BBBBBB' }),
    { ok: false, reason: '团长不能离开自己的战队' },
    'leader cannot leave',
  );
  eq(
    squadSwitchVerdict({ currentSquadCode: 'AAAAAA', isLeaderOfCurrent: false, squadChangedSeason: 1, season: 1, targetCode: 'BBBBBB' }),
    { ok: false, reason: '本赛季已换过战队' },
    'second switch same season',
  );
  eq(
    squadSwitchVerdict({ currentSquadCode: 'AAAAAA', isLeaderOfCurrent: false, squadChangedSeason: 1, season: 2, targetCode: 'BBBBBB' }),
    { ok: true, noop: false, markSeason: true },
    'switch next season',
  );
});

test('新战队码符合字母表与长度', () => {
  for (let i = 0; i < 50; i++) ok(isSquadCode(newSquadCode()), 'generated code valid');
  ok(!isSquadCode('abcdef'), 'lowercase rejected');
  ok(!isSquadCode('AAAAA0'), 'zero rejected');
});

/* ------------------------------ 军饷 ------------------------------ */

function member(overrides: Partial<JunxiangMember> & { wallet: string }): JunxiangMember {
  return {
    principalRaw: 0n,
    isNewcomer: false,
    referrer: null,
    referralEligible: true,
    squadCode: null,
    squadLeader: false,
    squadBonusBps: 0,
    streakRounds: 0,
    ...overrides,
  };
}

const LARGE = { referral: 1_000_000_000n, squad: 1_000_000_000n, streak: 1_000_000_000n };

function amountOf(rows: ReturnType<typeof computeJunxiang>, wallet: string, kind: string): bigint {
  return rows.find((row) => row.wallet === wallet && row.kind === kind)?.amountRaw ?? 0n;
}

test('军饷：带兵饷 新人本金 10% 给邀请人、5% 给新人（预算充足不缩放）', () => {
  const rows = computeJunxiang({
    roundId: 1,
    budgets: LARGE,
    members: [
      member({ wallet: 'E', principalRaw: 1_000n, isNewcomer: true, referrer: 'I' }),
      member({ wallet: 'I' }),
    ],
  });
  eq(amountOf(rows, 'E', 'referee'), 50n, 'referee 5%');
  eq(amountOf(rows, 'I', 'referrer'), 100n, 'inviter 10%');
  eq(rows.every((row) => row.roundId === 1), true, 'roundId');
});

test('军饷：非新人或资金来自邀请人（不计入）时不发带兵饷', () => {
  const notNew = computeJunxiang({
    roundId: 1,
    budgets: LARGE,
    members: [member({ wallet: 'E', principalRaw: 1_000n, isNewcomer: false, referrer: 'I' }), member({ wallet: 'I' })],
  });
  eq(notNew.filter((row) => row.budget === 'referral').length, 0, 'not newcomer');
  const ineligible = computeJunxiang({
    roundId: 1,
    budgets: LARGE,
    members: [
      member({ wallet: 'E', principalRaw: 1_000n, isNewcomer: true, referrer: 'I', referralEligible: false }),
      member({ wallet: 'I' }),
    ],
  });
  eq(ineligible.filter((row) => row.budget === 'referral').length, 0, 'ineligible funds');
});

test('军饷：战队加成 + 团长 1%（团长即使本人未报名也领全队本金的 1%）', () => {
  const rows = computeJunxiang({
    roundId: 2,
    budgets: LARGE,
    members: [
      member({ wallet: 'L', squadCode: 'SQUAD1', squadLeader: true, squadBonusBps: 600 }),
      member({ wallet: 'M', principalRaw: 10_000n, squadCode: 'SQUAD1', squadBonusBps: 600 }),
    ],
  });
  eq(amountOf(rows, 'M', 'squad'), 600n, 'member +6%');
  eq(amountOf(rows, 'L', 'leader'), 100n, 'leader 1% of squad principal');
  eq(amountOf(rows, 'L', 'squad'), 0n, 'leader without stake gets no member bonus');
});

test('军饷：连战每城 +2%，封顶 +10%', () => {
  const rows = computeJunxiang({
    roundId: 3,
    budgets: LARGE,
    members: [
      member({ wallet: 'A', principalRaw: 10_000n, streakRounds: 2 }),
      member({ wallet: 'B', principalRaw: 10_000n, streakRounds: 7 }),
    ],
  });
  eq(amountOf(rows, 'A', 'streak'), 400n, '2 rounds = 4%');
  eq(amountOf(rows, 'B', 'streak'), 1_000n, '7 rounds capped at 10%');
});

test('军饷：单人单城上限为对应预算的 2%', () => {
  // 预算 10,000 → 单人上限 200；邀请人 B 有 5 个新人，合计 1,000 应被压到 200
  const members: JunxiangMember[] = [member({ wallet: 'B' })];
  for (let i = 0; i < 5; i++) {
    members.push(member({ wallet: `E${i}`, principalRaw: 10_000n, isNewcomer: true, referrer: 'B' }));
  }
  const rows = computeJunxiang({ roundId: 1, members, budgets: { referral: 10_000n, squad: 0n, streak: 0n } });
  eq(amountOf(rows, 'B', 'referrer'), 200n, 'inviter capped at 2% of budget');
  eq(rows.filter((row) => row.budget === 'referral').reduce((s, r) => s + r.amountRaw, 0n) <= 10_000n, true, 'within budget');
});

test('军饷：超预算按比例缩放，合计不超过预算', () => {
  // 60 对 (邀请人 R_i, 新人 E_i)；新人 10,000 → 5,000；邀请人 20,000（= 预算 2% 上限）
  // 合计 60 × 30,000 = 1,800,000，预算 1,000,000 → 缩放 1,000,000 / 1,800,000
  const members: JunxiangMember[] = [];
  for (let i = 0; i < 60; i++) {
    members.push(member({ wallet: `E${i}`, principalRaw: 200_000n, isNewcomer: true, referrer: `R${i}` }));
    members.push(member({ wallet: `R${i}` }));
  }
  const rows = computeJunxiang({ roundId: 1, members, budgets: { referral: 1_000_000n, squad: 0n, streak: 0n } });
  eq(amountOf(rows, 'E0', 'referee'), 5_555n, 'referee scaled');
  eq(amountOf(rows, 'R0', 'referrer'), 11_111n, 'referrer scaled');
  const total = rows.filter((row) => row.budget === 'referral').reduce((s, r) => s + r.amountRaw, 0n);
  ok(total <= 1_000_000n, 'total within budget');
});

test('军饷：空输入与零预算不产生行', () => {
  eq(computeJunxiang({ roundId: 1, members: [], budgets: LARGE }), [], 'empty');
  const rows = computeJunxiang({
    roundId: 1,
    budgets: { referral: 0n, squad: 0n, streak: 0n },
    members: [member({ wallet: 'E', principalRaw: 1_000n, isNewcomer: true, referrer: 'I' }), member({ wallet: 'I' })],
  });
  eq(rows, [], 'zero budgets');
});

/* ------------------------------ 城门 ------------------------------ */

test('remainingUsd = pool × (sqrt(gate / price) − 1)，价格高于城门时为 0', () => {
  closeTo(remainingUsd(1_000, 0.02, 0.01) ?? NaN, 1_000 * (Math.sqrt(2) - 1), 'formula');
  eq(remainingUsd(1_000, 0.01, 0.02), 0, 'price above gate clamps to 0');
  eq(remainingUsd(1_000, 0.01, 0.01), 0, 'equal clamps to 0');
  eq(remainingUsd(0, 0.02, 0.01), 0, 'empty pool');
});

test('remainingUsd：无效输入返回 null', () => {
  eq(remainingUsd(1_000, 0.02, 0), null, 'zero price');
  eq(remainingUsd(1_000, 0, 0.01), null, 'zero gate');
  eq(remainingUsd(Number.NaN, 0.02, 0.01), null, 'nan pool');
});

test('phaseOf 状态映射', () => {
  eq(phaseOf('UNOPENED'), 'preview', 'unopened');
  eq(phaseOf('STAKING_OPEN'), 'staking', 'staking');
  eq(phaseOf('OBSERVING'), 'observing', 'observing');
  eq(phaseOf('SUCCEEDED'), 'settled', 'succeeded');
  eq(phaseOf('FAILED_PERMANENT'), 'settled', 'failed');
  eq(phaseOf(null), 'preview', 'null');
});

/* ------------------------------ 池子 / 通用 ------------------------------ */

test('USDT 主合约地址可被解析（校验常量的 CRC）', () => {
  ok(parseTonAddress(USDT_MASTER_ADDRESS) !== null, 'USDT master parses');
});

test('usdtReserveFromPool：按 6 位小数换算，兼容两侧位置', () => {
  const pool = {
    token0_address: 'EQ_OTHER',
    reserve0: '5000000000',
    token1_address: USDT_MASTER_ADDRESS,
    reserve1: '1500000000',
  };
  closeTo(usdtReserveFromPool({ pool }) ?? NaN, 1_500, 'usdt on side 1');
  closeTo(usdtReserveFromPool({ ...pool, token0_address: USDT_MASTER_ADDRESS, token1_address: 'EQ_OTHER' }) ?? NaN, 5_000, 'usdt on side 0');
  eq(usdtReserveFromPool({ pool: { token0_address: 'X', token1_address: 'Y', reserve0: '1', reserve1: '1' } }), null, 'no usdt side');
  eq(usdtReserveFromPool(null), null, 'null json');
});

test('seasonOfRound：每 10 城一个赛季', () => {
  eq(seasonOfRound(1), 1, 'r1');
  eq(seasonOfRound(10), 1, 'r10');
  eq(seasonOfRound(11), 2, 'r11');
});

test('inviteCodeOf 确定性、长度 8、盐值改变结果', async () => {
  const a = await inviteCodeOf('UQ-test-wallet');
  const b = await inviteCodeOf('UQ-test-wallet');
  eq(a, b, 'deterministic');
  eq(a.length, 8, 'length');
  ok(isInviteCode(a), 'valid invite code');
  ok((await inviteCodeOf('UQ-test-wallet', '1')) !== a, 'salt changes code');
});

test('maskWallet 与 escapeMarkup', () => {
  eq(maskWallet('EQABCDEFGHIJKLMNOPQRSTUV1234'), 'EQABCD...1234', 'mask');
  eq(maskWallet('short'), 'short', 'short kept');
  eq(escapeMarkup('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;', 'escape');
});
