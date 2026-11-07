/**
 * 军饷规则单测：守城补贴 / 新人礼 / 猜灯 / 同资金来源合并 / 预算线与 pro-rata。
 *
 * 运行（worker 目录）：npm run test:social
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeJunxiang, JUNXIANG_A9_BUDGETS, type JunxiangContribution, type JunxiangMember } from './junxiang';
import { guardContributions, guardRateBps, guardWindowOf, netBoughtByWallet, GUARD_WINDOW_MS } from './guard';
import {
  firstRoundAfter,
  isFirstBindViaInvite,
  newcomerContributions,
  newcomerShadowWallets,
  NEWCOMER_FALLBACK_SHADOW_RAW,
  NEWCOMER_META,
  shadowA9Raw,
  type ReferralBind,
} from './newcomer';
import { guessContributions, guessOpen, GUESS_POOL_RAW, parseLitGuess } from './guess';
import { InMemoryPoolTradeSource, parseStonfiSwaps, firstIncomingSenderOf, TonApiFundingClusterSource, type PoolSwap } from './sources';

function eq(actual: unknown, expected: unknown, label = 'value'): void {
  assert.deepEqual(actual, expected, label);
}

function throwsMatching(fn: () => unknown, pattern?: RegExp): void {
  try {
    fn();
  } catch (err) {
    if (pattern) assert.ok(pattern.test(String((err as Error).message ?? err)), String(err));
    return;
  }
  throw new Error('expected to throw');
}

const A9 = 1_000_000_000n;

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

/* ------------------------------ 守城补贴 ------------------------------ */

test('守城补贴：比例 10%，第 1 城 20%；观察窗口 = stakeCloseAt 起 24h', () => {
  eq(guardRateBps(1), 2_000n, 'round 1');
  eq(guardRateBps(2), 1_000n, 'round 2');
  eq(guardRateBps(7), 1_000n, 'round 7');
  eq(guardWindowOf(5_000), { fromMs: 5_000, toMs: 5_000 + GUARD_WINDOW_MS }, 'window');
});

test('守城补贴：净买入 = BUY − SELL，负数与零不保留，键经 keyOf 归一', () => {
  const swaps: PoolSwap[] = [
    { wallet: 'a', side: 'BUY', a9Amount: 700n, ts: 1 },
    { wallet: 'A', side: 'SELL', a9Amount: 200n, ts: 2 },
    { wallet: 'b', side: 'BUY', a9Amount: 100n, ts: 3 },
    { wallet: 'b', side: 'SELL', a9Amount: 500n, ts: 4 },
    { wallet: 'c', side: 'BUY', a9Amount: 0n, ts: 5 },
  ];
  const net = netBoughtByWallet(swaps, (wallet) => wallet.toLowerCase());
  eq([...net.entries()], [['a', 500n]], 'net buys');
});

test('守城补贴：补贴 = 比例 × min(净买入, 次城质押)；只有两边都为正才发', () => {
  const rows = guardContributions({
    roundId: 1,
    netBought: new Map([
      ['W1', 4_000n],
      ['W2', 300n],
      ['W3', 50n],
    ]),
    stakedNext: new Map([
      ['W1', 2_000n],
      ['W2', 100n],
      ['W4', 9_999n],
    ]),
  });
  // W1: min(4000, 2000) = 2000 × 20% = 400；W2: min(300, 100) = 100 × 20% = 20；W3 无次城质押；W4 无净买入
  eq(rows.map((row) => [row.wallet, row.amountRaw, row.kind]), [
    ['W1', 400n, 'guard'],
    ['W2', 20n, 'guard'],
  ], 'guard amounts');
  const later = guardContributions({
    roundId: 2,
    netBought: new Map([['W1', 1_000n]]),
    stakedNext: new Map([['W1', 1_000n]]),
  });
  eq(later[0].amountRaw, 100n, 'round 2 is 10%');
});

test('守城补贴：通过池子成交源取窗口内成交（直接转账不在成交列表里，因此不计入）', async () => {
  const source = new InMemoryPoolTradeSource([
    { wallet: 'W1', side: 'BUY', a9Amount: 1_000n, ts: 2_500 },
    { wallet: 'W1', side: 'BUY', a9Amount: 9_000n, ts: 99_999_999 },
  ]);
  const { fromMs, toMs } = guardWindowOf(2_000);
  const swaps = await source.listSwaps('POOL', fromMs, toMs);
  eq(swaps.length, 1, 'only in-window swaps');
});

test('守城补贴：STON.fi 成交解析严格，无法解析的条目报错而不是跳过', () => {
  const ok = parseStonfiSwaps({ swaps: [{ wallet: 'W1', side: 'buy', a9_amount: '123', ts: 1000 }] });
  eq(ok, [{ wallet: 'W1', side: 'BUY', a9Amount: 123n, ts: 1000 }], 'parsed');
  throwsMatching(() => parseStonfiSwaps({ swaps: [{ wallet: 'W1', side: 'hold', a9_amount: '1', ts: 1 }] }));
  throwsMatching(() => parseStonfiSwaps({ nope: true }));
});

/* ------------------------------ 新人礼 ------------------------------ */

test('新人礼：首次建档即绑定邀请人（绑定与建档间隔 ≤ 60s）才算', () => {
  eq(isFirstBindViaInvite({ wallet: 'N', boundAt: 1_000, createdAt: 1_000 }), true, 'same request');
  eq(isFirstBindViaInvite({ wallet: 'N', boundAt: 61_000, createdAt: 1_000 }), true, 'edge 60s');
  eq(isFirstBindViaInvite({ wallet: 'N', boundAt: 61_001, createdAt: 1_000 }), false, 'later bind');
});

test('新人礼：只在绑定后第一座开城的轮次获得影子仓位，每人一次', () => {
  const rounds = [
    { round_id: 1, stake_open_at: 1_000 },
    { round_id: 2, stake_open_at: 3_000 },
    { round_id: 3, stake_open_at: 5_000 },
    { round_id: 4, stake_open_at: null },
  ];
  eq(firstRoundAfter(500, rounds), 1, 'bound before round 1');
  eq(firstRoundAfter(1_500, rounds), 2, 'bound between 1 and 2');
  eq(firstRoundAfter(9_000, rounds), null, 'bound after all');
  const binds: ReferralBind[] = [
    { wallet: 'N1', boundAt: 500, createdAt: 400 },
    { wallet: 'N2', boundAt: 1_500, createdAt: 1_400 },
    { wallet: 'N3', boundAt: 2_500, createdAt: -100_000 }, // 建档早于绑定 > 60s：非首次建档即绑定，不计
  ];
  eq(newcomerShadowWallets(binds, rounds, 1), ['N1'], 'round 1');
  eq(newcomerShadowWallets(binds, rounds, 2), ['N2'], 'round 2');
  eq(newcomerShadowWallets(binds, rounds, 3), [], 'round 3 (nobody new)');
});

test('新人礼：影子仓位取 1 GRAM 等值，价格未知时 1,000 A9', () => {
  eq(shadowA9Raw(null, null), NEWCOMER_FALLBACK_SHADOW_RAW, 'unknown price');
  eq(NEWCOMER_FALLBACK_SHADOW_RAW, 1_000n * A9, 'fallback is 1000 A9');
  // GRAM = 5 USD（500 USD_E8），A9 = 0.5 USD（50_000_000 USD_E8）→ 1 GRAM = 10 A9
  eq(shadowA9Raw(50_000_000n, 500_000_000n), 10n * A9, 'priced');
});

test('新人礼：payout = 奖励池 × 影子 / (总权重 + 全部影子)，成功城才派发', () => {
  const rows = newcomerContributions({
    roundId: 1,
    success: true,
    rewardBudgetRaw: 1_000_000n,
    totalWeightRaw: 8_000n,
    wallets: ['N1', 'N2'],
    shadowRaw: 1_000n,
  });
  // 分母 = 8000 + 2 × 1000 = 10000；每人 1,000,000 × 1000 / 10000 = 100,000
  eq(rows.map((row) => [row.wallet, row.amountRaw, row.meta]), [
    ['N1', 100_000n, NEWCOMER_META],
    ['N2', 100_000n, NEWCOMER_META],
  ], 'pro-rata share');
  eq(
    newcomerContributions({ roundId: 1, success: false, rewardBudgetRaw: 1_000_000n, totalWeightRaw: 0n, wallets: ['N1'], shadowRaw: 1_000n }),
    [],
    'failed round pays nothing',
  );
});

/* ------------------------------ 猜灯 ------------------------------ */

test('猜灯：亮灯数必须是 0..24 的整数', () => {
  eq(parseLitGuess(0), 0, 'min');
  eq(parseLitGuess(24), 24, 'max');
  eq(parseLitGuess('7'), 7, 'string digits');
  for (const bad of [25, -1, 1.5, 'x', null, '']) {
    throwsMatching(() => parseLitGuess(bad));
  }
});

test('猜灯：观察窗口开始前可猜，之后关闭；窗口未定时不可猜', () => {
  eq(guessOpen(999, 1_000), true, 'before');
  eq(guessOpen(1_000, 1_000), false, 'at start');
  eq(guessOpen(0, null), false, 'unknown window');
});

test('猜灯：猜中者平分 50 万 A9（向下取整），无人猜中则不发', () => {
  eq(GUESS_POOL_RAW, 500_000n * A9, 'pool is 500k A9');
  const rows = guessContributions({
    roundId: 1,
    litActual: 3,
    guesses: [
      { wallet: 'G1', lit: 3 },
      { wallet: 'G2', lit: 2 },
      { wallet: 'G3', lit: 3 },
      { wallet: 'G4', lit: 3 },
    ],
    poolRaw: 100n,
  });
  eq(rows.map((row) => [row.wallet, row.amountRaw]), [
    ['G1', 33n],
    ['G3', 33n],
    ['G4', 33n],
  ], 'three exact, floor');
  eq(guessContributions({ roundId: 1, litActual: 5, guesses: [{ wallet: 'G1', lit: 3 }], poolRaw: 100n }), [], 'nobody exact');
});

/* ------------------------------ 合并与预算 ------------------------------ */

test('合并：同一资金来源簇共享一个单人上限（2% 预算线）', () => {
  // 预算 referral 10,000 → 单人 / 单簇上限 200
  const members: JunxiangMember[] = [
    member({ wallet: 'B1' }),
    member({ wallet: 'B2' }),
    member({ wallet: 'E1', principalRaw: 10_000n, isNewcomer: true, referrer: 'B1' }),
    member({ wallet: 'E2', principalRaw: 10_000n, isNewcomer: true, referrer: 'B2' }),
  ];
  const budgets = { referral: 10_000n, squad: 0n, streak: 0n };
  // 不合并：B1、B2 各自封顶 200
  const separate = computeJunxiang({ roundId: 1, members, budgets });
  eq(amountOf(separate, 'B1', 'referrer'), 200n, 'B1 capped alone');
  eq(amountOf(separate, 'B2', 'referrer'), 200n, 'B2 capped alone');
  // 同簇：四个钱包合计压到 200 以内
  const clusterOf = new Map([
    ['B1', 'C'],
    ['B2', 'C'],
    ['E1', 'C'],
    ['E2', 'C'],
  ]);
  const merged = computeJunxiang({ roundId: 1, members, budgets, clusterOf });
  const total = merged.filter((row) => row.budget === 'referral').reduce((sum, row) => sum + row.amountRaw, 0n);
  assert.ok(total > 0n && total <= 200n, `cluster total ${total} within 200`);
});

test('合并：连战饷与猜灯共用 200 万线，单人上限按线额（streak + guess）计', () => {
  const members: JunxiangMember[] = [member({ wallet: 'W', principalRaw: 10_000n, streakRounds: 5 })];
  const contributions: JunxiangContribution[] = [{ wallet: 'W', kind: 'guess', amountRaw: 500n }];
  const rows = computeJunxiang({
    roundId: 1,
    members,
    budgets: { referral: 0n, squad: 0n, streak: 1_000n, guess: 1_000n },
    contributions,
  });
  // 连战 10% × 10000 = 1000；猜灯 500；线额 2000 → 上限 40；合计按 1000:500 缩放
  const streak = amountOf(rows, 'W', 'streak');
  const guess = amountOf(rows, 'W', 'guess');
  eq(streak, 26n, 'streak scaled');
  eq(guess, 13n, 'guess scaled');
  assert.ok(streak + guess <= 40n, 'line cap');
});

test('预算缩放：超预算按比例缩放（守城补贴线），合计不超过预算', () => {
  const contributions: JunxiangContribution[] = [];
  for (let i = 0; i < 60; i++) contributions.push({ wallet: `G${i}`, kind: 'guard', amountRaw: 30_000n });
  const rows = computeJunxiang({
    roundId: 1,
    members: [],
    budgets: { referral: 0n, squad: 0n, streak: 0n, guard: 1_000_000n },
    contributions,
  });
  // 单人上限 2% × 1,000,000 = 20,000 → 每人先封顶 20,000；合计 1,200,000 → 缩放到 1,000,000
  eq(amountOf(rows, 'G0', 'guard'), 16_666n, 'pro-rata share');
  const total = rows.reduce((sum, row) => sum + row.amountRaw, 0n);
  assert.ok(total <= 1_000_000n, 'within budget');
});

test('预算：A9 默认预算线额与任务单一致（守城 1000 万、新人 600 万、连战 150 万、猜灯 50 万）', () => {
  eq(JUNXIANG_A9_BUDGETS.referral, 16_000_000n * A9, 'referral 1600万');
  eq(JUNXIANG_A9_BUDGETS.squad, 6_000_000n * A9, 'squad 600万');
  eq(JUNXIANG_A9_BUDGETS.guard, 10_000_000n * A9, 'guard 1000万');
  eq(JUNXIANG_A9_BUDGETS.newcomer, 6_000_000n * A9, 'newcomer 600万');
  eq((JUNXIANG_A9_BUDGETS.streak ?? 0n) + (JUNXIANG_A9_BUDGETS.guess ?? 0n), 2_000_000n * A9, 'streak + guess 200万');
});

test('输出：kind / budget / meta 随行返回，按预算顺序排列', () => {
  const rows = computeJunxiang({
    roundId: 4,
    members: [member({ wallet: 'W', principalRaw: 10_000n, streakRounds: 1 })],
    budgets: { ...LARGE, guard: LARGE.referral, newcomer: LARGE.referral, guess: 0n },
    contributions: [
      { wallet: 'N', kind: 'newcomer', amountRaw: 5n, meta: NEWCOMER_META },
      { wallet: 'G', kind: 'guard', amountRaw: 5n },
    ],
  });
  eq(rows.map((row) => [row.budget, row.kind]), [
    ['streak', 'streak'],
    ['guard', 'guard'],
    ['newcomer', 'newcomer'],
  ], 'order');
  eq(rows[2].meta, NEWCOMER_META, 'newcomer meta');
  eq(rows[1].meta, null, 'guard meta default');
});

/* ------------------------------ 资金来源 ------------------------------ */

test('资金来源：第一笔入账的发送方即为簇；无入账则返回 null', () => {
  eq(
    firstIncomingSenderOf({
      transactions: [
        { in_msg: null },
        { in_msg: { source: null, value: 5 } },
        { in_msg: { source: { address: '0:' + 'ab'.repeat(32) }, value: '1000' } },
      ],
    }),
    '0:' + 'ab'.repeat(32),
    'first incoming sender',
  );
  eq(firstIncomingSenderOf({ transactions: [{ in_msg: { source: null, value: 0 } }] }), null, 'none');
  eq(firstIncomingSenderOf({}), null, 'bad shape');
});

test('资金来源：TON API 失败时回退为钱包自身（identity）', async () => {
  const failing = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const source = new TonApiFundingClusterSource('https://tonapi.example', failing);
  const map = await source.clusterOf(['W1', 'W2']);
  eq([...map.entries()], [
    ['W1', 'W1'],
    ['W2', 'W2'],
  ], 'identity fallback');
});

test('资金来源：同一发送方的两个钱包归为同一簇', async () => {
  const sender = '0:' + 'cd'.repeat(32);
  const fake = (async (url: string) => {
    const wallet = decodeURIComponent(String(url).split('/accounts/')[1].split('/')[0]);
    const from = wallet === 'W3' ? '0:' + '11'.repeat(32) : sender;
    return new Response(JSON.stringify({ transactions: [{ in_msg: { source: { address: from }, value: 10 } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const source = new TonApiFundingClusterSource('https://tonapi.example', fake);
  const map = await source.clusterOf(['W1', 'W2', 'W3']);
  assert.equal(map.get('W1'), map.get('W2'), 'same funder');
  assert.notEqual(map.get('W1'), map.get('W3'), 'different funder');
});
