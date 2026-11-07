// node --test ops/tests/price.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFromReserves, twapOf, digestOf } from '../scripts/lib/price.mjs';

test('priceFromReserves: 2亿 A9 + $232,000 USDT = $0.00116 (116000 E8)', () => {
  assert.equal(priceFromReserves(200_000_000n * 10n ** 9n, 232_000n * 10n ** 6n), 116000n);
});
test('priceFromReserves: empty reserve → 0', () => {
  assert.equal(priceFromReserves(0n, 5n), 0n);
});
test('twap: constant price, full coverage', () => {
  const s = Array.from({ length: 60 }, (_, i) => ({ t: 1000 + i * 60, priceE8: 200n }));
  const r = twapOf(s, 1000, 4600);
  assert.equal(r.twapE8, 200n);
  assert.equal(r.coverage, 1);
});
test('twap: time-weighted, anchor before window counts', () => {
  // 100 from t=900 (anchor), 300 from t=1300; window [1000,1600): 300s@100 + 300s@300 = 200
  const r = twapOf([{ t: 900, priceE8: 100n }, { t: 1300, priceE8: 300n }], 1000, 1600, 10_000);
  assert.equal(r.twapE8, 200n);
  assert.equal(r.n, 2);
});
test('twap: gaps longer than maxHold reduce coverage, not price', () => {
  const r = twapOf([{ t: 1000, priceE8: 100n }, { t: 3000, priceE8: 100n }], 1000, 3600, 300);
  assert.equal(r.twapE8, 100n);
  assert.ok(Math.abs(r.coverage - 600 / 2600) < 1e-9);
});
test('twap: single short spike barely moves a 1h TWAP', () => {
  const s = Array.from({ length: 60 }, (_, i) => ({ t: i * 60, priceE8: i === 30 ? 10_000n : 100n }));
  const r = twapOf(s, 0, 3600);
  assert.ok(r.twapE8 < 300n, 'spike diluted: ' + r.twapE8);
});
test('twap: no samples → 0 twap, 0 coverage', () => {
  const r = twapOf([], 0, 3600);
  assert.equal(r.twapE8, 0n);
  assert.equal(r.coverage, 0);
});
test('digest is deterministic over exact samples', () => {
  const a = digestOf([{ t: 1, priceE8: 2n }, { t: 3, priceE8: 4n }]);
  const b = digestOf([{ t: 1, priceE8: 2n }, { t: 3, priceE8: 4n }]);
  const c = digestOf([{ t: 1, priceE8: 2n }, { t: 3, priceE8: 5n }]);
  assert.equal(a.hex, b.hex);
  assert.notEqual(a.hex, c.hex);
  assert.equal(a.value < 2n ** 256n, true);
});
