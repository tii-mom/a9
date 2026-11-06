// Local-only frontend acceptance: node qa/frontend-ux.mjs http://127.0.0.1:5175
// Every /api request is intercepted; mutations fail the suite and never reach a backend.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { frontendFixtures } from './frontend-ux-fixtures.mjs';

const base = process.argv[2] || 'http://127.0.0.1:5175';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Local preview required');
const out = new URL('../output/playwright/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const results = [];
const failures = [];
async function test(name, run) {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  try { await run(); results.push({ name, status: 'PASS' }); console.log('PASS', name); }
  catch (error) {
    failures.push(name); results.push({ name, status: 'FAIL', error: error.message }); console.error('FAIL', name, error.message);
    for (const context of browser.contexts()) for (const page of context.pages()) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await page.screenshot({ path: new URL(`failure-${slug}.png`, out).pathname, fullPage: false }).catch(() => {});
      await writeFile(new URL(`failure-${slug}.txt`, out), await page.locator('body').innerText()).catch(() => {});
      await context.close();
    }
  }
}
async function session({ width = 1440, lang = 'zh', state = 'OBSERVING', offline = false, empty = false, config = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript((language) => localStorage.setItem('fuse.lang', language), lang);
  const page = await context.newPage();
  const errors = [];
  const writes = [];
  let unavailable = offline;
  const fixture = frontendFixtures(state);
  Object.assign(fixture.config, config);
  if (empty) fixture.rounds = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      writes.push(url.pathname);
      return route.fulfill({ status: 403, json: { ok: false, error: { code: 'TEST_NO_WRITES', message: 'Mutation blocked by local acceptance suite' } } });
    }
    if (unavailable) return route.fulfill({ status: 503, json: { ok: false, error: { code: 'UNAVAILABLE', message: 'Acceptance test: feed unavailable' } } });
    const path = url.pathname;
    let data;
    if (path === '/api/health') data = { ok: true, now: Date.now(), db: true, dataSource: 'demo', version: 'fixture', uptimeSeconds: 100 };
    else if (path === '/api/config') data = fixture.config;
    else if (path === '/api/stats') data = fixture.stats;
    else if (path === '/api/rounds') data = fixture.rounds;
    else if (/^\/api\/rounds\/\d+$/.test(path)) data = Number(path.split('/').at(-1)) === 1 ? fixture.detail : { ...fixture.rounds[Number(path.split('/').at(-1)) - 1], candles: [], live: null, priceUsdE8: '23500', secondsRemaining: null, nextState: null };
    else if (path.endsWith('/leaderboard')) data = [];
    else if (path === '/api/trades') data = fixture.trades;
    else if (path === '/api/book') data = { asks: [], bids: [], midUsdE8: '23500' };
    else if (path === '/api/me') data = fixture.me(url.searchParams.get('address'));
    else return route.fulfill({ status: 404, json: { ok: false, error: { code: 'NOT_FOUND', message: 'No fixture for ' + path } } });
    return route.fulfill({ json: { ok: true, data, ts: Date.now() } });
  });
  return { context, page, errors, writes, setOffline: (value) => { unavailable = value; } };
}
async function ready(page, path = '/') {
  await page.goto(base + path);
  await expect(page.locator('#main-content')).toBeVisible();
  await expect(page.locator('.environment-desktop')).toContainText(/演示数据|Demo data/);
}
async function noOverflow(page) {
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('body *')].map((node) => ({ tag: node.tagName, cls: node.className?.baseVal ?? node.className, right: Math.round(node.getBoundingClientRect().right), width: Math.round(node.getBoundingClientRect().width) })).filter((node) => node.right > innerWidth + 1 && node.width > 0).slice(0, 15) }));
  if (metrics.scroll > metrics.viewport + 1) await page.screenshot({ path: new URL('overflow-debug.png', out).pathname, fullPage: true });
  assert(metrics.scroll <= metrics.viewport + 1, JSON.stringify(metrics));
}
try {
  await test('Responsive Chinese and English layouts: 1440, 1024, 768, 390, 360', async () => {
    for (const lang of ['zh', 'en']) for (const width of [1440, 1024, 768, 390, 360]) {
      const { context, page, errors, writes } = await session({ width, lang });
      await ready(page);
      await expect(page.locator('.cells .cell')).toHaveCount(24);
      await noOverflow(page);
      if (width <= 760) {
        await expect(page.locator('.wl-trigger')).toBeVisible();
        assert((await page.locator('.wl-trigger').boundingBox()).height >= 44);
        await expect(page.locator('.mcta button')).toHaveCount(1);
      }
      if (width === 1440 || width === 390) {
        await page.screenshot({ path: new URL(`home-${lang}-${width}.png`, out).pathname, fullPage: true });
      }
      assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      await context.close();
    }
  });
  await test('Stake deep link with the buy entry closed, cross-route navigation and fixed-header anchors', async () => {
    const { context, page, errors } = await session({ state: 'STAKING_OPEN' });
    await ready(page, '/?action=stake#cmd');
    await expect(page.locator('#paneStake')).toBeVisible();
    await expect(page.locator('#tab-buy')).toHaveCount(0);
    await page.goto(base + '/me');
    await page.locator('.header-join').click();
    await expect(page.locator('#paneStake')).toBeVisible();
    await page.locator('.links a[href="/rules"]').click();
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.locator('#ladder')).toBeVisible();
    await page.goto(base + '/rules#risk');
    await expect(page.locator('#risk')).toBeFocused();
    const positions = await page.evaluate(() => ({ header: document.querySelector('.top').getBoundingClientRect().bottom, section: document.querySelector('#risk').getBoundingClientRect().top }));
    assert(positions.section >= positions.header - 1, JSON.stringify(positions));
    assert.deepEqual(errors, []); await context.close();
  });
  await test('Mobile menu Escape/focus and account/leaderboard navigation', async () => {
    const { context, page, errors } = await session({ width: 390 });
    await ready(page);
    const menu = page.locator('.menu-toggle');
    await menu.click(); await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape'); await expect(menu).toHaveAttribute('aria-expanded', 'false'); await expect(menu).toBeFocused();
    await menu.click(); await page.locator('.links a[href="/me"]').click();
    await expect(page).toHaveURL(/\/me$/); await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await noOverflow(page); await page.screenshot({ path: new URL('account-mobile.png', out).pathname, fullPage: true });
    await menu.click(); await page.locator('.links a[href="/leaderboard"]').click();
    await expect(page).toHaveURL(/\/leaderboard$/); await noOverflow(page);
    await page.screenshot({ path: new URL('leaderboard-mobile.png', out).pathname, fullPage: true });
    assert.deepEqual(errors, []); await context.close();
  });
  await test('TWAP values come from reported candles; sandbox changes verdict at 16/24', async () => {
    const { context, page } = await session(); await ready(page);
    await page.locator('.twap-data summary').click();
    await expect(page.locator('.twap-data tbody tr')).toHaveCount(9);
    await expect(page.locator('.twap-caption')).toContainText(/实线/);
    await ready(page, '/rules');
    await expect(page.locator('.sand-cells .sc[aria-pressed="true"]')).toHaveCount(16);
    await expect(page.locator('.out')).toHaveClass(/win/);
    await page.locator('.sand-cells .sc').first().click();
    await expect(page.locator('.sand-cells .sc[aria-pressed="true"]')).toHaveCount(15);
    await expect(page.locator('.out')).toHaveClass(/lose/);
    await context.close();
  });
  await test('Configuration changes sandbox threshold; an empty round feed stays explicit', async () => {
    const { context, page } = await session({ empty: true, config: { candleCount: 12, minQualifiedCandles: 8, observationSeconds: 43200 } });
    await ready(page);
    await expect(page.locator('.board.empty')).toBeVisible();
    await ready(page, '/rules');
    await expect(page.locator('.sand-cells .sc')).toHaveCount(12);
    await expect(page.locator('.sand-cells .sc[aria-pressed="true"]')).toHaveCount(8);
    await page.locator('.sand-cells .sc').first().click();
    await expect(page.locator('.out')).toHaveClass(/lose/);
    await context.close();
  });
  await test('Production hides the demo wallet and clears a stale demo session', async () => {
    const { context, page, writes, errors } = await session({ width: 360 });
    await context.addInitScript(() => { try { localStorage.setItem('fuse.wallet.mode', 'demo'); } catch { /* storage blocked */ } });
    await ready(page);
    await expect(page.locator('.wl-trigger')).toContainText('连接钱包');
    await page.locator('.wl-trigger').click();
    await expect(page.locator('.wl-pop')).toBeVisible();
    await expect(page.getByRole('button', { name: /使用演示钱包/ })).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({ path: new URL('wallet-mobile.png', out).pathname, fullPage: false });
    await page.keyboard.press('Escape');
    await page.goto(base + '/me');
    await expect(page.locator('.lock').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /使用演示钱包|Use demo wallet/ })).toHaveCount(0);
    await noOverflow(page);
    assert.deepEqual(writes, []); assert.deepEqual(errors, []); await context.close();
  });
  if (process.env.DEMO_BUILD === '1') {
    await test('Demo build: demo wallet is an explicit choice; stake needs both acknowledgements', async () => {
      const { context, page, writes, errors } = await session({ state: 'STAKING_OPEN', width: 360 });
      await ready(page);
      await page.locator('.wl-trigger').click();
      await page.getByRole('button', { name: /使用演示钱包/ }).click();
      await expect(page.locator('.wl-trigger')).toContainText(/DEMO/i);
      await page.locator('#riskOk').scrollIntoViewIfNeeded();
      const submit = page.locator('#paneStake button.btn.fire.full');
      await expect(submit).toBeDisabled();
      await page.locator('#riskOk').check();
      await expect(submit).toBeDisabled();
      await page.locator('#burnOk').check();
      await expect(submit).toBeEnabled();
      assert.deepEqual(writes, []); assert.deepEqual(errors, []); await context.close();
    });
  }
  await test('Settlement in progress does not offer completed-round claim', async () => {
    const { context, page } = await session({ state: 'SETTLING_SUCCESS' }); await ready(page);
    await expect(page.locator('.board')).toContainText(/结算中/);
    await expect(page.locator('.board')).not.toContainText('本轮已成功');
    await page.screenshot({ path: new URL('settling-desktop.png', out).pathname, fullPage: false });
    await context.close();
  });
  await test('Polling failure preserves displayed data and offers retry without a loading reset', async () => {
    const { context, page, setOffline, writes, errors } = await session(); await ready(page);
    await expect(page.locator('.board .cells .cell')).toHaveCount(24);
    setOffline(true);
    await expect(page.locator('.data-health')).toHaveClass(/degraded/, { timeout: 15000 });
    await expect(page.locator('.board .cells .cell')).toHaveCount(24);
    await expect(page.locator('.board')).toContainText('$0.0002');
    setOffline(false);
    await page.locator('.data-health button').click();
    await expect(page.locator('.data-health')).not.toHaveClass(/degraded/);
    assert.deepEqual(writes, []); assert.deepEqual(errors, []); await context.close();
  });
  await test('First-load API failure remains explicit and retry restores data', async () => {
    const { context, page, setOffline, errors } = await session({ offline: true });
    await page.goto(base + '/');
    await expect(page.locator('.data-health')).toContainText(/失败|不可用/);
    await expect(page.locator('.board')).toContainText(/加载失败|暂不可用|暂时|接口|连接/);
    await page.screenshot({ path: new URL('offline-desktop.png', out).pathname, fullPage: false });
    setOffline(false); await page.locator('.data-health button').click();
    await expect(page.locator('.data-health')).toContainText('数据已更新');
    await expect(page.locator('.cells .cell')).toHaveCount(24);
    assert.deepEqual(errors, []); await context.close();
  });
} finally {
  await browser.close();
  await writeFile(new URL('acceptance.json', out), JSON.stringify(results, null, 2));
}
if (failures.length) throw new Error(`${failures.length} acceptance test(s) failed: ${failures.join(', ')}`);
console.log(`${results.length} acceptance groups passed; screenshots: ${out.pathname}`);
