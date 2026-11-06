import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQUAD_CODE_ALPHABET, competitionRank, levelInfo, newSquadCode, squadCodeFromBytes } from './squad';

test('还差 N 人升级：各档边界', () => {
  assert.deepEqual(levelInfo(0), { level: 0, nextAt: 5, remaining: 5 });
  assert.deepEqual(levelInfo(4), { level: 0, nextAt: 5, remaining: 1 });
  assert.deepEqual(levelInfo(5), { level: 1, nextAt: 20, remaining: 15 });
  assert.deepEqual(levelInfo(19), { level: 1, nextAt: 20, remaining: 1 });
  assert.deepEqual(levelInfo(20), { level: 2, nextAt: 100, remaining: 80 });
  assert.deepEqual(levelInfo(99), { level: 2, nextAt: 100, remaining: 1 });
  assert.deepEqual(levelInfo(100), { level: 3, nextAt: 500, remaining: 400 });
  assert.deepEqual(levelInfo(499), { level: 3, nextAt: 500, remaining: 1 });
  assert.deepEqual(levelInfo(500), { level: 4, nextAt: null, remaining: 0 });
  assert.deepEqual(levelInfo(9999), { level: 4, nextAt: null, remaining: 0 });
});

test('还差 N 人升级：非法输入按 0 处理', () => {
  assert.deepEqual(levelInfo(-3), { level: 0, nextAt: 5, remaining: 5 });
  assert.deepEqual(levelInfo(7.9), { level: 1, nextAt: 20, remaining: 13 });
});

test('竞争排名：同分同名次，跳过名次', () => {
  const all = [10, 7, 7, 3];
  assert.equal(competitionRank(10, all), 1);
  assert.equal(competitionRank(7, all), 2);
  assert.equal(competitionRank(3, all), 4);
  assert.equal(competitionRank(0, []), 1);
});

test('战队码：6 位、只用安全字母表，超出无偏区间的字节跳过', () => {
  assert.equal(SQUAD_CODE_ALPHABET.length, 31);
  assert.equal(/[01IOL]/.test(SQUAD_CODE_ALPHABET), false);
  const A = SQUAD_CODE_ALPHABET;
  // 248 与 255 超出 31 的整数倍上限，被跳过
  const code = squadCodeFromBytes(new Uint8Array([0, 1, 2, 30, 248, 255, 128, 7]));
  assert.equal(code, A[0] + A[1] + A[2] + A[30] + A[128 % 31] + A[7]);
});

test('战队码：字节不够时返回 null', () => {
  assert.equal(squadCodeFromBytes(new Uint8Array([248, 255, 1, 2])), null);
});

test('战队码：随机生成满足格式', () => {
  for (let i = 0; i < 20; i++) {
    assert.match(newSquadCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  }
});
