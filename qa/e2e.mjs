// 端到端交互验收：落地页 / 我的战况 / 排行榜 / 运维后台
// 用法: node e2e.mjs [baseUrl]
//
// 发布门禁（pre-release acceptance）最小集（全部必须 PASS 才允许部署）：
//   1. 落地页核心内容 + 24 格 K 线 + 沙盘交互 + 阶梯 + 成交流 + 中英切换
//   2. 我的战况：连接钱包后展示数据（不再是未连接引导）
//   3. 排行榜：R1 至少 5 行；运维后台：未授权态 + token 登录总览
//   4. 390px 移动端无横向溢出
//   5. 链源不可用：/api/me、/api/rounds 持续 503 时页面给出明确错误态与重试，不白屏/不崩溃
//   6. 重复提交防护：同一操作按钮在请求未完成前必须禁用（双击只发 1 次请求）
//   7. 签名门禁：链上模式 + 演示钱包时必须提示「无法签名」并禁用签名动作（若目标环境为演示模式则显式 SKIP）
// 真实签名拒绝 / 失败回执（aborted）/ nonce 防重等无法在无钱包浏览器里稳定复现，
// 由 qa/chain-logic.mjs 用纯逻辑回归覆盖（CI 的 qa-logic job，同为 deploy 前置）。
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://fuse-protocol.348421501.workers.dev';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const results = [];
const ok = (name, detail = '') => { results.push(['PASS', name, detail]); console.log('✅', name, detail); };
const bad = (name, detail = '') => { results.push(['FAIL', name, detail]); console.log('❌', name, detail); };
const skip = (name, detail = '') => { results.push(['SKIP', name, detail]); console.log('⏭️', name, detail); };

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
    // 等「已登录」出现（CSP/安全头上线后首屏请求变多，固定 sleep 不够稳；
    // 不能用 /R1/ 判定——页面里其它数字可能提前命中）
    await page
      .waitForFunction(
        () => /已登录/.test(document.body.innerText) || /令牌被服务端拒绝|UNAUTHORIZED/.test(document.body.innerText),
        { timeout: 20000 },
      )
      .catch(() => {});
    const body = await page.locator('body').innerText();
    // 用明确的错误文案判定，避免正文里的数字（如时间戳/金额）误命中 "401"
    if (/令牌被服务端拒绝|管理员令牌无效|UNAUTHORIZED/.test(body)) throw new Error('401');
    // 登录成功的稳定标志：已登录 + 系统健康面板（轮次表是异步加载，不作为硬断言）
    if (!/已登录/.test(body) || !/系统健康/.test(body)) throw new Error('未进入后台总览');
    ok('/admin 登录并加载总览', /R01|R1/.test(body) ? 'overview + rounds' : 'overview ok');
  });
}

// ---------- 链源不可用（API 持续 503：必须给出错误态，不得白屏） ----------
await step('链源不可用 → 明确错误态', async () => {
  const downCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const downPage = await downCtx.newPage();
  const downErrors = [];
  downPage.on('pageerror', (e) => downErrors.push(String(e).slice(0, 200)));
  await downCtx.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (/\/api\/(me|rounds|stats|trades|book|config|health)/.test(url)) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'chain source unavailable (e2e)' } }),
      });
    }
    return route.continue();
  });
  await downPage.addInitScript(() => {
    localStorage.setItem('fuse.wallet.mode', 'demo');
    localStorage.setItem('fuse.wallet.demoAddress', 'UQUTBw3GpXiC0WbJh0B-nYfHzbzDmp9T2mUTBw3GpXiC0WbJ');
  });
  await downPage.goto(BASE + '/me', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await downPage.waitForTimeout(3000);
  const meBody = await downPage.locator('body').innerText();
  if (!/接口不可用|重试|无法连接|API unavailable|Retry/.test(meBody)) throw new Error('/me 未展示错误态：' + meBody.replace(/\s+/g, ' ').slice(0, 120));
  if (downErrors.length) throw new Error('链源不可用时出现未捕获异常：' + downErrors[0]);
  await downPage.goto(BASE + '/leaderboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await downPage.waitForTimeout(2500);
  const lbBody = await downPage.locator('body').innerText();
  if (!/接口不可用|重试|无法连接|API unavailable|Retry/.test(lbBody)) throw new Error('/leaderboard 未展示错误态');
  const h1 = await downPage.locator('h1').first().innerText();
  if (!h1.trim()) throw new Error('错误态页面 h1 为空（白屏）');
  await downCtx.close();
  ok('链源不可用 → 明确错误态', '/me + /leaderboard 均显示错误与重试');
});

// ---------- 重复提交防护（单飞：请求未完成前动作按钮必须禁用，且只发 1 次） ----------
if (ADMIN_TOKEN) {
  await step('重复提交防护（单飞锁）', async () => {
    const dupCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const dupPage = await dupCtx.newPage();
    let tickRequests = 0;
    await dupPage.route('**/api/admin/tick', async (route) => {
      tickRequests += 1;
      // 人为放慢，制造「请求未完成」窗口
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.continue();
    });
    await dupPage.goto(BASE + '/admin', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dupPage.waitForTimeout(1500);
    const input = dupPage.locator('input[type=password], input[name=token], input[placeholder*="令牌"]').first();
    await input.fill(ADMIN_TOKEN);
    await dupPage.getByRole('button', { name: /^登录$/ }).click();
    await dupPage.waitForFunction(() => /已登录/.test(document.body.innerText), { timeout: 25000 }).catch(() => {});
    // 第一行动作（手动 Tick）的按钮：加载中会变成「…」且 disabled
    const tickBtn = dupPage.locator('.ap-admin-actions .ap-action').first().locator('button').first();
    if (!(await tickBtn.count())) throw new Error('未找到「手动 Tick」按钮（登录失败？）');
    await tickBtn.click();
    await dupPage.waitForTimeout(120);
    const lockState = await dupPage.evaluate(() => {
      const row = document.querySelector('.ap-admin-actions .ap-action');
      const btn = row ? row.querySelector('button') : null;
      return btn ? { disabled: btn.disabled, text: (btn.textContent || '').trim() } : null;
    });
    if (!lockState || !lockState.disabled) throw new Error('请求进行中动作按钮未禁用（单飞锁缺失）：' + JSON.stringify(lockState));
    await dupPage.waitForTimeout(2400);
    if (tickRequests !== 1) throw new Error('单次点击触发了 ' + tickRequests + ' 次请求（应为 1）');
    await dupCtx.close();
    ok('重复提交防护（单飞锁）', '请求期间按钮禁用（' + lockState.text + '），请求数 = 1');
  });
} else {
  skip('重复提交防护（单飞锁）', '未提供 ADMIN_TOKEN，无法登录后台；显式跳过（非静默）');
}

// ---------- 签名门禁（链上模式 + 演示钱包：必须提示无法签名并禁止签名动作） ----------
await step('签名门禁（链上模式 + 演示钱包）', async () => {
  // 先看目标环境是否真的接了链：/api/config 下发 roundController 才算链上模式
  let chainConfigured = false;
  try {
    const response = await fetch(BASE + '/api/config', { headers: { accept: 'application/json' } });
    const json = await response.json();
    chainConfigured = Boolean(json && json.ok && json.data && json.data.contracts && json.data.contracts.roundController);
  } catch (error) {
    throw new Error('无法读取 /api/config：' + String(error && error.message ? error.message : error));
  }
  if (!chainConfigured) {
    skip('签名门禁（链上模式 + 演示钱包）', '目标环境为演示模式（/api/config 无 roundController）；真实签名拒绝/失败回执由 qa/chain-logic.mjs 覆盖');
    return;
  }
  const chainPage = await ctx.newPage();
  await chainPage.goto(BASE + '/me', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await chainPage.waitForTimeout(2800);
  const body = await chainPage.locator('body').innerText();
  if (!/演示钱包无法签名|Demo wallet cannot sign|无法签名/i.test(body)) {
    throw new Error('链上模式 + 演示钱包未提示无法签名');
  }
  const switchBtn = chainPage.getByRole('button', { name: /连接真实钱包|Switch wallet|Switch to a real wallet/i }).first();
  if (!(await switchBtn.count())) throw new Error('缺少「连接真实钱包」切换入口');
  // 链上交易面板（排除奖励/邀请面板）里的签名动作在演示钱包下必须全部禁用
  const onchainPanel = chainPage.locator('.chain-panel:not(.reward-panel):not(.referral-panel)');
  const actionButtons = onchainPanel.locator('.chain-actions button');
  const actionCount = await actionButtons.count();
  let enabledActions = 0;
  for (let i = 0; i < actionCount; i += 1) {
    if (await actionButtons.nth(i).isEnabled()) enabledActions += 1;
  }
  if (actionCount === 0) throw new Error('链上模式下未找到链上交易面板动作按钮');
  if (enabledActions > 0) throw new Error('演示钱包下仍有 ' + enabledActions + '/' + actionCount + ' 个签名按钮可点击');
  await chainPage.close();
  ok('签名门禁（链上模式 + 演示钱包）', '提示无法签名 + 切换入口 + ' + actionCount + ' 个签名按钮全禁用');
});

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
const skips = results.filter((r) => r[0] === 'SKIP');
console.log(`PASS ${results.length - fails.length - skips.length} / FAIL ${fails.length} / SKIP ${skips.length}`);
if (skips.length) skips.forEach((s) => console.log('  skip: ' + s[1] + ' — ' + s[2]));
if (errors.length) { console.log('console errors:'); errors.slice(0, 8).forEach((e) => console.log(' - ' + e)); }
process.exit(fails.length ? 1 : 0);