/**
 * 分享落地页 /s/:code（HTML + OG 元信息）与动态分享图 /og/:code.png。
 * 落地页只放一个按钮，跳转 Telegram 小程序并带上 startapp=r_<邀请码>。
 */
import { notFound } from '../http';
import { TOKEN_DECIMALS } from '../protocol';
import { insertShareClick } from './db';
import { escapeMarkup, isInviteCode, type SocialEnv } from './common';
import { buildGate, sharerRank } from './handlers';
import type { SocialGateResponse } from '@shared/types';

const CLICK_SOURCES = ['x', 'tg', 'web'] as const;

function formatUsd(value: number | null): string {
  if (value === null) return '—';
  return '$' + Math.round(value).toLocaleString('en-US');
}

function formatA9(raw: string): string {
  let whole: bigint;
  try {
    whole = BigInt(raw) / 10n ** BigInt(TOKEN_DECIMALS);
  } catch {
    return '—';
  }
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function rankText(rank: number | null, found: boolean): string {
  if (rank !== null) return `战力排名 #${rank}`;
  return found ? '尚未上车' : '—';
}

function shareCopy(gate: SocialGateResponse, rank: number | null, found: boolean): { title: string; description: string } {
  const title = 'A9 · 十城攻防：这一次，散户做庄';
  const description = `奖池 ${formatA9(gate.rewardBudgetRaw)} A9 · 还差 ${formatUsd(gate.remainingUsd)} 破城 · ${rankText(rank, found)}`;
  return { title, description };
}

function botUsername(env: SocialEnv): string {
  const name = (env.TG_BOT_USERNAME ?? '').trim();
  return /^[A-Za-z0-9_]{3,64}$/.test(name) ? name : '';
}

export async function landingPage(request: Request, env: SocialEnv, rawCode: string, now: number, ctx: ExecutionContext): Promise<Response> {
  const code = rawCode.toUpperCase();
  if (!isInviteCode(code)) throw notFound('页面不存在');

  const url = new URL(request.url);
  const src = url.searchParams.get('src');
  if (src && (CLICK_SOURCES as readonly string[]).includes(src)) {
    ctx.waitUntil(insertShareClick(env, code, src as 'x' | 'tg' | 'web', now));
  }

  const gate = await buildGate(env, now);
  const sharer = await sharerRank(env, code, now);
  const { title, description } = shareCopy(gate, sharer.rank, sharer.found);
  const origin = url.origin;
  const pageUrl = `${origin}/s/${code}`;
  const imageUrl = `${origin}/og/${code}.png`;
  const tgLink = `https://t.me/${botUsername(env)}/app?startapp=r_${code}`;

  const t = escapeMarkup(title);
  const d = escapeMarkup(description);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="A9">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${escapeMarkup(pageUrl)}">
<meta property="og:image" content="${escapeMarkup(imageUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${escapeMarkup(imageUrl)}">
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#f5f5f5;font-family:system-ui,sans-serif;">
<main style="text-align:center;padding:24px;">
<h1 style="font-size:22px;margin:0 0 12px;">${t}</h1>
<p style="margin:0 0 24px;color:#b8b8c4;">${d}</p>
<a href="${escapeMarkup(tgLink)}" style="display:inline-block;padding:14px 28px;border-radius:12px;background:#ffcc33;color:#111;font-weight:700;text-decoration:none;">进入 A9 小程序</a>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}

/**
 * 动态分享图（SVG 内容）。
 * TODO(og-png)：X 卡片只接受 PNG，本路由仍返回 image/svg+xml，路径名 /og/:code.png 与类型不一致。
 *   未安装渲染依赖（worker/node_modules 中没有 @resvg/resvg-wasm），本次保持 SVG。接入步骤：
 *   1. 在 worker 目录执行 `pnpm add @resvg/resvg-wasm`（新依赖，需要审核后再加）；
 *   2. 以 wasm 模块方式导入并初始化一次（按所装版本文档的 wasm 入口，Workers 支持 .wasm 模块导入）；
 *   3. `new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng()`，返回 Content-Type: image/png；
 *   4. 中文需要 CJK 字体，体积大：未嵌入前 PNG 只放数字与英文（文案改为 "A9" 与英文标签），中文版待字体方案定稿。
 */
export async function ogImage(env: SocialEnv, rawCode: string, now: number): Promise<Response> {
  const code = rawCode.toUpperCase();
  const gate = await buildGate(env, now);
  const sharer = isInviteCode(code) ? await sharerRank(env, code, now) : { found: false, rank: null };
  const pool = gate.poolUsdt === null ? '—' : formatUsd(gate.poolUsdt);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0b0b0f"/>
<rect x="40" y="40" width="1120" height="550" rx="28" fill="none" stroke="#ffcc33" stroke-width="4"/>
<text x="90" y="150" font-size="44" font-weight="700" fill="#ffcc33" font-family="sans-serif">A9 · 十城攻防</text>
<text x="90" y="210" font-size="30" fill="#b8b8c4" font-family="sans-serif">这一次，散户做庄</text>
<text x="90" y="340" font-size="96" font-weight="800" fill="#f5f5f5" font-family="sans-serif">${escapeMarkup(formatA9(gate.rewardBudgetRaw))} A9</text>
<text x="90" y="390" font-size="30" fill="#b8b8c4" font-family="sans-serif">本城奖池</text>
<text x="90" y="480" font-size="44" font-weight="700" fill="#f5f5f5" font-family="sans-serif">还差 ${escapeMarkup(formatUsd(gate.remainingUsd))} 破城 · 当前池 ${escapeMarkup(pool)}</text>
<text x="90" y="550" font-size="36" font-weight="700" fill="#ffcc33" font-family="sans-serif">${escapeMarkup(rankText(sharer.rank, sharer.found))}</text>
</svg>`;
  return new Response(svg, {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}

