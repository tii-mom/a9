// 全站截图 + 控制台错误采集
// 用法: node shots.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || 'shots';
const pages = ['/', '/me', '/leaderboard', '/admin'];
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const problems = [];

for (const vp of viewports) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  for (const p of pages) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url().slice(0, 200) + ' ' + (r.failure()?.errorText || '')));
    try {
      await page.goto(base + p, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(2500);
      const baseName = `${vp.name}-${p === '/' ? 'home' : p.replace(/\//g, '')}`;
      const pageH = await page.evaluate(() => document.documentElement.scrollHeight);
      if (pageH > 7000) {
        // 超长页面分段截图，避免单图超过 8192px
        const segH = vp.height;
        const segs = Math.min(6, Math.ceil(pageH / segH));
        for (let s = 0; s < segs; s += 1) {
          await page.evaluate((y) => window.scrollTo(0, y), s * segH);
          await page.waitForTimeout(250);
          await page.screenshot({ path: path.join(outDir, `${baseName}-s${s + 1}.png`) });
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        console.log(`[${vp.name}] ${p} -> ${baseName}-s1..${segs}.png (tall page ${pageH}px, segmented)`);
      } else {
        await page.screenshot({ path: path.join(outDir, baseName + '.png'), fullPage: true });
        console.log(`[${vp.name}] ${p} -> ${baseName}.png`);
      }
      // 横向溢出检测
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return { scrollW: doc.scrollWidth, clientW: doc.clientWidth };
      });
      const bad = overflow.scrollW > overflow.clientW + 1;
      if (bad) console.log(`[${vp.name}] ${p} ⚠ 横向溢出 ${overflow.scrollW}>${overflow.clientW}`);
      if (bad) problems.push(`${vp.name}${p} horizontal overflow ${overflow.scrollW}>${overflow.clientW}`);
      if (errors.length) {
        console.log(`  console errors (${errors.length}):`);
        errors.slice(0, 6).forEach((e) => console.log('   - ' + e));
        problems.push(`${vp.name}${p}: ${errors.length} console errors`);
      }
    } catch (e) {
      console.log(`[${vp.name}] ${p} FAILED: ${e.message}`);
      problems.push(`${vp.name}${p} load failed: ${e.message}`);
    }
    await page.close();
  }
  await ctx.close();
}

// 原型对比截图
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('file://' + path.resolve(process.cwd(), '..', 'FUSE 引信协议.html'), { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, 'prototype-desktop-home.png'), fullPage: true });
  console.log('[proto] prototype screenshot written');
  await ctx.close();
} catch (e) {
  console.log('prototype screenshot skipped: ' + e.message);
}

await browser.close();
console.log('\n=== summary ===');
if (problems.length === 0) console.log('PASS: no overflow / console errors detected');
else { console.log(`${problems.length} problem(s):`); problems.forEach((p) => console.log(' - ' + p)); }
process.exit(problems.length ? 1 : 0);