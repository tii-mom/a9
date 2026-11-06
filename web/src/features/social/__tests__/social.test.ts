/**
 * 社交层纯函数单测。运行方式见 PR 说明（web 包暂无测试运行器，用 esbuild 打包后交给 node:test）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a9Yi, gateGap, usdWhole } from '../format';
import { nextSquadLevel, squadBonusPct } from '../squadLevels';
import { powerTitle } from '../rankTitle';
import {
  PENDING_KEY,
  mergePending,
  parseLaunchCodes,
  parseStartParam,
  persistLaunchCodes,
  readPending,
} from '../startParam';
import {
  buildShareText,
  buildShareUrl,
  buildSquadRecruitText,
  buildTelegramShareUrl,
  buildXIntentUrl,
  SHARE_TAG,
} from '../shareText';

/** 最小 Storage 替身（仅 getItem / setItem / removeItem）。 */
function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage = {
    map,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
  return storage as unknown as Storage & { map: Map<string, string> };
}

test('parseStartParam reads both codes from r_<ref>_s_<squad>', () => {
  assert.deepEqual(parseStartParam('r_ab12_s_xy99'), { ref: 'ab12', squad: 'xy99' });
});

test('parseStartParam accepts a single segment and ignores garbage', () => {
  assert.deepEqual(parseStartParam('r_ab12'), { ref: 'ab12' });
  assert.deepEqual(parseStartParam('s_xy99'), { squad: 'xy99' });
  assert.deepEqual(parseStartParam(''), {});
  assert.deepEqual(parseStartParam(null), {});
  assert.deepEqual(parseStartParam('hello'), {});
});

test('parseStartParam rejects codes that are too short or contain separators', () => {
  assert.deepEqual(parseStartParam('r_a'), {});
  assert.deepEqual(parseStartParam('r_ab-12'), { ref: 'ab' });
});

test('parseLaunchCodes prefers start_param over query and marks Telegram source', () => {
  const codes = parseLaunchCodes({ startParam: 'r_tg01', search: '?ref=web01&squad=sq01', inTelegram: true });
  assert.deepEqual(codes, { ref: 'tg01', squad: 'sq01', source: 'tg' });
});

test('parseLaunchCodes reads plain web query params and src=x', () => {
  const codes = parseLaunchCodes({ search: '?ref=ab12&squad=xy99&src=x', inTelegram: false });
  assert.deepEqual(codes, { ref: 'ab12', squad: 'xy99', source: 'x' });
});

test('parseLaunchCodes defaults to web with no codes', () => {
  assert.deepEqual(parseLaunchCodes({ search: '', inTelegram: false }), { ref: undefined, squad: undefined, source: 'web' });
});

test('mergePending keeps the first code seen and only fills empty fields', () => {
  const first = { ref: 'aaaa', source: 'x' as const };
  const merged = mergePending(first, { ref: 'bbbb', squad: 'cccc', source: 'tg' });
  assert.deepEqual(merged, { ref: 'aaaa', squad: 'cccc', source: 'x' });
  assert.equal(mergePending(null, { source: 'web' }), null);
});

test('persistLaunchCodes writes once and survives a round trip through storage', () => {
  const storage = memoryStorage();
  persistLaunchCodes({ ref: 'ab12', squad: undefined, source: 'tg' }, storage);
  persistLaunchCodes({ ref: 'zz99', squad: 'xy99', source: 'web' }, storage);
  assert.deepEqual(readPending(storage), { ref: 'ab12', squad: 'xy99', source: 'tg' });
});

test('persistLaunchCodes does nothing without codes', () => {
  const storage = memoryStorage();
  assert.equal(persistLaunchCodes({ source: 'web' }, storage), null);
  assert.equal(storage.map.has(PENDING_KEY), false);
});

test('readPending tolerates corrupt JSON and missing storage', () => {
  const storage = memoryStorage();
  storage.setItem(PENDING_KEY, '{not json');
  assert.equal(readPending(storage), null);
  assert.equal(readPending(null), null);
});

test('usdWhole and a9Yi format live numbers', () => {
  assert.equal(usdWhole(37420.4), '$37,420');
  assert.equal(usdWhole(Number.NaN), '—');
  assert.equal(a9Yi('700000000000000000'), '7.00');
  assert.equal(a9Yi('not-a-number'), '—');
});

test('gateGap reports direction and percentage', () => {
  assert.deepEqual(gateGap(1.1, 1), { above: true, pct: '10.0' });
  assert.deepEqual(gateGap(0.9, 1), { above: false, pct: '10.0' });
  assert.equal(gateGap(1, 0), null);
});

test('buildShareText join uses live numbers and the hashtag', () => {
  const text = buildShareText('join', { remainingUsd: 37420, stakeCount: 12, roundId: 3 });
  assert.match(text, /还差 \$37,420 破城/);
  assert.match(text, /已有 12 次上车/);
  assert.ok(text.includes(SHARE_TAG));
});

test('buildShareText covers squad, breach and fallen moments', () => {
  assert.match(buildShareText('squad', { squadName: '火种队' }), /「火种队」成团了/);
  assert.match(buildShareText('breach', { roundId: 4, poolYi: '7.00' }), /第 4 城破城了！奖池 7.00 亿 A9/);
  assert.match(buildShareText('fallen', { roundId: 4, medals: 2 }), /阵亡勋章 ×2/);
  assert.match(buildShareText('fallen', {}), /本城没破/);
  for (const moment of ['join', 'squad', 'breach', 'fallen'] as const) {
    assert.ok(buildShareText(moment).includes(SHARE_TAG), moment);
  }
});

test('buildShareUrl and the X intent carry the src=x landing link', () => {
  assert.equal(buildShareUrl('https://a9.example', 'ab12'), 'https://a9.example/s/ab12');
  const url = buildShareUrl('https://a9.example', 'ab12', 'x');
  assert.equal(url, 'https://a9.example/s/ab12?src=x');
  const intent = new URL(buildXIntentUrl('hi #A9破城', url));
  assert.equal(intent.origin + intent.pathname, 'https://x.com/intent/post');
  assert.equal(intent.searchParams.get('text'), 'hi #A9破城');
  assert.equal(intent.searchParams.get('url'), url);
});

test('buildTelegramShareUrl encodes url and text', () => {
  const link = new URL(buildTelegramShareUrl('https://a9.example/s/ab12', '来一起干'));
  assert.equal(link.origin + link.pathname, 'https://t.me/share/url');
  assert.equal(link.searchParams.get('url'), 'https://a9.example/s/ab12');
  assert.equal(link.searchParams.get('text'), '来一起干');
});

test('buildSquadRecruitText matches the recruitment template and the maxed variant', () => {
  assert.equal(
    buildSquadRecruitText({ squadName: 'XX', roundId: 5, remaining: 3 }),
    `XX 战队第 5 城招募，差 3 人升级。${SHARE_TAG}`,
  );
  assert.match(buildSquadRecruitText({ squadName: 'XX', roundId: null, remaining: null }), /本城招募，已满级/);
});

test('nextSquadLevel walks the 5 / 20 / 100 / 500 ladder', () => {
  assert.deepEqual(nextSquadLevel(0, 3), { level: 1, members: 5, bonusPct: 3, remaining: 2 });
  assert.deepEqual(nextSquadLevel(1, 20), { level: 2, members: 20, bonusPct: 6, remaining: 0 });
  assert.equal(nextSquadLevel(4, 600), null);
  assert.equal(squadBonusPct(3), 10);
  assert.equal(squadBonusPct(0), 0);
});

test('powerTitle uses the 1-10 / 11-30 / 31-60 / 61-100 bands', () => {
  assert.equal(powerTitle(1), '城主');
  assert.equal(powerTitle(10), '城主');
  assert.equal(powerTitle(11), '将军');
  assert.equal(powerTitle(30), '将军');
  assert.equal(powerTitle(31), '百夫长');
  assert.equal(powerTitle(60), '百夫长');
  assert.equal(powerTitle(61), '先锋');
  assert.equal(powerTitle(100), '先锋');
  assert.equal(powerTitle(101), null);
  assert.equal(powerTitle(0), null);
});
