import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCandleMessage,
  formatCountdown,
  formatDigest,
  formatGateLine,
  formatGateStatus,
  formatMe,
  formatPct,
  formatRank,
  formatSquadLevel,
  formatUsd,
} from './format';
import type { CandleEvent, GateStatus } from './types';

const base: CandleEvent = {
  roundId: 3,
  candleIndex: 14,
  lit: true,
  needed: 16,
  priceUsd: 1.06,
  gatePriceUsd: 1,
  litCount: 11,
};

const gate: GateStatus = {
  roundId: 3,
  phase: 'STAKING_OPEN',
  gatePriceUsd: 1.5,
  priceUsd: 1.2,
  remainingUsd: 300,
  litCandles: 4,
  candlesSeen: 9,
  rewardBudgetRaw: '700000000000000000',
  stakeCount: 128,
};

test('K 线亮灯文案：与任务单示例一致', () => {
  assert.equal(formatCandleMessage(base), '第 14 盏亮了！已亮 11/16，现价高于城门 6%');
});

test('K 线未亮文案：现价低于城门，保留一位小数', () => {
  const ev: CandleEvent = { ...base, lit: false, priceUsd: 0.968, gatePriceUsd: 1, litCount: 10 };
  assert.equal(formatCandleMessage(ev), '第 14 盏未亮，已亮 10/16，现价低于城门 3.2%');
});

test('K 线文案：没给 litCount 时不显示已亮数', () => {
  const ev: CandleEvent = { ...base, litCount: undefined };
  assert.equal(formatCandleMessage(ev), '第 14 盏亮了！现价高于城门 6%');
});

test('K 线文案：持平与城门未知', () => {
  assert.equal(formatCandleMessage({ ...base, priceUsd: 1, gatePriceUsd: 1, lit: false }), '第 14 盏未亮，已亮 11/16，现价与城门持平');
  assert.equal(formatCandleMessage({ ...base, gatePriceUsd: 0 }), '第 14 盏亮了！已亮 11/16，城门未知');
});

test('最后一根：亮够 16 盏为破城，否则城没破', () => {
  const win = formatCandleMessage({ ...base, candleIndex: 24, litCount: 16, lit: true });
  assert.match(win, /^第 3 城破城！已亮 16\/16 盏/);
  const lose = formatCandleMessage({ ...base, candleIndex: 24, litCount: 15, lit: false });
  assert.match(lose, /^第 3 城没破，阵亡。已亮 15\/16 盏，未达 16 盏/);
});

test('最后一根：显式 outcome 优先于 litCount 推断', () => {
  const ev: CandleEvent = { ...base, candleIndex: 24, litCount: 3, outcome: 'SUCCEEDED' };
  assert.match(formatCandleMessage(ev), /^第 3 城破城！/);
});

test('最后一根：没有结果也没有 litCount 时给中性文案', () => {
  const ev: CandleEvent = { ...base, candleIndex: 24, litCount: undefined };
  assert.equal(formatCandleMessage(ev), '第 3 城 24 盏已全部亮完，结算结果以链上为准。');
});

test('金额与百分比格式', () => {
  assert.equal(formatUsd(1234.5), '$1,234.50');
  assert.equal(formatUsd(0.5), '$0.50');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.00001234), '$0.000012');
  assert.equal(formatPct(6), '6%');
  assert.equal(formatPct(-3.25), '3.3%');
  assert.equal(formatPct(9.96), '10%');
});

test('倒计时格式', () => {
  assert.equal(formatCountdown(3725), '1小时2分');
  assert.equal(formatCountdown(125), '2分5秒');
  assert.equal(formatCountdown(-10), '0分0秒');
});

test('/gate 状态：还差金额、已亮、倒计时', () => {
  const text = formatGateStatus({ ...gate, phaseEndsAt: 1000 + 3600 * 2 + 60 * 5 }, 1000);
  assert.equal(
    text,
    [
      '第 3 城 · 攻城',
      '城门 $1.50 ｜ 现价 $1.20',
      '还差 $300.00 破城',
      '已亮 4/16 盏 · 已看 9/24 盏',
      '攻城令 128 张',
      '倒计时 2小时5分',
    ].join('\n'),
  );
});

test('/gate 状态：现价过城门切到守城视图，无倒计时时不显示', () => {
  const text = formatGateStatus({ ...gate, phase: 'OBSERVING', remainingUsd: 0, priceUsd: 1.6 }, 0);
  assert.match(text, /第 3 城 · 守城/);
  assert.match(text, /现价已过城门，守城中/);
  assert.doesNotMatch(text, /倒计时/);
});

test('状态一行摘要与未知阶段原样显示', () => {
  assert.equal(formatGateLine(gate), '第 3 城 · 攻城 ｜ 城门 $1.50 ｜ 现价 $1.20');
  assert.equal(formatGateLine({ ...gate, phase: 'WEIRD' }), '第 3 城 · WEIRD ｜ 城门 $1.50 ｜ 现价 $1.20');
});

test('战队等级文案：还差 N 人升级', () => {
  assert.equal(formatSquadLevel(3), '未成团 · 还差 2 人升级（Lv1：5 人）');
  assert.equal(formatSquadLevel(12), 'Lv1 · 还差 8 人升级（Lv2：20 人）');
  assert.equal(formatSquadLevel(500), 'Lv4（已满级）');
});

test('/rank 与 /me 与摘要文案', () => {
  assert.equal(
    formatRank('风暴队', 2, 5, 12, 12),
    '战队「风暴队」 · 第 2 名 / 共 5 支\n成员 12 人 · 本城上车 12 人\nLv1 · 还差 8 人升级（Lv2：20 人）',
  );
  assert.equal(
    formatMe('风暴队', 1, 1, 20, 20, 'https://t.me/A9Bot/app?startapp=s_K7P2QX'),
    '你的战队：「风暴队」 · 第 1 名 / 共 1 支\n成员 20 人 · 本城上车 20 人 · Lv2 · 还差 80 人升级（Lv3：100 人）\n邀请链接：https://t.me/A9Bot/app?startapp=s_K7P2QX',
  );
  assert.equal(
    formatDigest(gate, '风暴队', 1, 2, 5, 5),
    [
      '【攻城战报】第 3 城 · 攻城中',
      '战队「风暴队」第 1 名 / 共 2 支 · 成员 5 人 · 本城上车 5 人',
      'Lv1 · 还差 15 人升级（Lv2：20 人）',
      '城门 $1.50 ｜ 现价 $1.20 ｜ 已亮 4/16 盏',
    ].join('\n'),
  );
});

test('等级与「还差」只按本城上车人数，不按成员总数', () => {
  // 成员 30 人但本城只有 3 人上车：仍是未成团，还差 2 人
  assert.equal(
    formatRank('风暴队', 1, 2, 30, 3),
    '战队「风暴队」 · 第 1 名 / 共 2 支\n成员 30 人 · 本城上车 3 人\n未成团 · 还差 2 人升级（Lv1：5 人）',
  );
});
