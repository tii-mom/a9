// 端到端交互验收：落地页 / 我的战况 / 排行榜 / 运维后台
// 用法: node e2e.mjs [baseUrl]
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://fuse-protocol.348421501.workers.dev';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const results = [];
const ok = (name, detail = '') => { results.push(['PASS', name, detail]); console.log('✅', name, detail); };
const bad = (name, detail = '') => { results.push(['FAIL', name, detail]); console.log('❌', name, detail); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

const step = async (name, fn) => {
  try { await fn(); } catch (e) { bad(name, String(e.message || e).slice(0, 240)); }
};

// ---------- 落地页 ----------
await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(3000);

await step('hero 标题', async () => {
  const t = await page.locator('h1').first().innerText();
  if (!/押多少你定/.test(t) || !/至少翻倍/.test(t)) throw new Error('h1 文案不符: ' + t.slice(0, 60));
  ok('hero 标题', t.replace(/\s+/g, ' ').slice(0, 30));
});

await step('行情已接后端', async () => {
  const px = await page.locator('.b-price .px').first().innerText();
  if (!px.includes('$0.0')) throw new Error('现价未渲染: ' + px);
  ok('行情已接后端', px.trim());
});

await step('24 格 K 线', async () => {
  const n = await page.locator('.cells .cell').count();
  if (n !== 24) throw new Error('cell 数量 ' + n);
  ok('24 格 K 线', '24 cells');
});

await step('观察窗口 24 根 / 阈值 16', async () => {
  const body = await page.locator('body').innerText();
  if (!/24\s*根/.test(body)) throw new Error('页面未出现 24 根');
  if (!/16/.test(body)) throw new Error('页面未出现阈值 16');
  ok('观察窗口 24 根 / 阈值 16', 'copy ok');
});

await step('沙盘推演交互', async () => {
  const sn = await page.locator('.sand-cells .sc').count();
  if (sn !== 24) throw new Error('沙盘格数 ' + sn);
  const first = page.locator('.sand-cells .sc').first();
  const before = await first.getAttribute('aria-pressed');
  await first.click();
  await page.waitForTimeout(300);
  const after = await first.getAttribute('aria-pressed');
  if (before === after) throw new Error('点击未切换');
  ok('沙盘推演交互', `${before} -> ${after}`);
});

await step('阶梯 10 轮', async () => {
  const n = await page.locator('.ladder .lrow').count();
  if (n !== 10) throw new Error('lrow 数量 ' + n);
  ok('阶梯 10 轮', '10 rows');
});

await step('成交流有数据', async () => {
  const rows = await page.locator('#ts .ts-row, .panel .ts-row').count();
  if (rows < 5) throw new Error('成交行 ' + rows);
  ok('成交流有数据', rows + ' rows');
});

await step('中英切换', async () => {
  const before = await page.locator('h1').first().innerText();
  await page.getByRole('button', { name: '切换语言' }).click();
  await page.waitForTimeout(600);
  const after = await page.locator('h1').first().innerText();
  if (before === after) throw new Error('语言未切换');
  await page.getByRole('button', { name: 'Switch language' }).click();
  await page.waitForTimeout(500);
  ok('中英切换', 'zh <-> en');
});

// ---------- 钱包（演示） ----------
await step('演示钱包连接', async () => {
  await page.getByRole('button', { name: '连接钱包' }).first().click();
  await page.waitForTimeout(800);
  const demoBtn = page.getByRole('button', { name: /使用演示钱包/ }).first();
  await demoBtn.click({ timeout: 8000 });
  await page.waitForTimeout(2500);
  const trig = await page.locator('.wl-trigger').first().innerText();
  if (!/DEMO/i.test(trig)) throw new Error('钱包未进入演示模式: ' + trig);
  await page.locator('.wl-trigger').first().click();
  await page.waitForTimeout(500);
  const pop = await page.locator('.wl-pop').innerText();
  if (!/UQ/.test(pop)) throw new Error('弹层无地址');
  if (!/余额/.test(pop)) throw new Error('弹层无余额信息');
  await page.keyboard.press('Escape');
  ok('演示钱包连接', trig.replace(/\s+/g, ' ').slice(0, 24));
});

// ---------- 我的战况 ----------
await page.goto(BASE + '/me', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(2500);
await step('/me 展示数据', async () => {
  const body = await page.locator('body').innerText();
  if (/连接钱包查看你的战况/.test(body)) throw new Error('仍显示未连接引导');
  if (!/质押/.test(body)) throw new Error('无质押信息');
  ok('/me 展示数据', body.includes('预计奖励') ? '含预计奖励' : '含质押信息');
});

// ---------- 排行榜 ----------
await page.goto(BASE + '/leaderboard', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(2000);
await step('/leaderboard 榜单', async () => {
  // 选择 R1（已结算、有质押数据）
  const r1 = page.getByRole('button', { name: /R1/ }).first();
  if (await r1.count()) { await r1.click(); await page.waitForTimeout(1200); }
  const rows = await page.locator('table tbody tr').count();
  if (rows < 5) throw new Error('榜单行数 ' + rows);
  ok('/leaderboard 榜单', rows + ' rows');
});

// ---------- 后台 ----------
await page.goto(BASE + '/admin', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(1500);
await step('/admin 未授权态', async () => {
  const body = await page.locator('body').innerText();
  if (!/管理员登录|输入管理员令牌/.test(body)) throw new Error('无登录表单');
  ok('/admin 未授权态', 'login form');
});
if (ADMIN_TOKEN) {
  await step('/admin 登录并加载总览', async () => {
    const input = page.locator('input[type=password], input[name=token], input[placeholder*="令牌"]').first();
    await input.fill(ADMIN_TOKEN);
    await page.getByRole('button', { name: /^登录$/ }).click();
    await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText();
    if (/401|令牌被服务端拒绝/.test(body)) throw new Error('401');
    if (!/R01|R1/.test(body)) throw new Error('未加载轮次表');
    ok('/admin 登录并加载总览', 'overview ok');
  });
}

// ---------- 移动端 ----------
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await step('移动端无横向溢出', async () => {
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  if (o.s > o.c + 1) throw new Error(`${o.s}>${o.c}`);
  ok('移动端无横向溢出', `${o.c}px`);
});

await browser.close();
console.log('\n=== e2e summary ===');
const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`PASS ${results.length - fails.length} / FAIL ${fails.length}`);
if (errors.length) { console.log('console errors:'); errors.slice(0, 8).forEach((e) => console.log(' - ' + e)); }
process.exit(fails.length ? 1 : 0);