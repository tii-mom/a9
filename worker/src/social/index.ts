/**
 * 社交层入口：handleSocialRequest 只认自己的路径，其余返回 null 交给主路由。
 *
 * 路由：
 *   GET  /api/social/me?wallet=
 *   POST /api/social/bind
 *   POST /api/social/squads
 *   POST /api/social/squads/:code/join
 *   GET  /api/social/leaderboard?type=&scope=&round=
 *   GET  /api/social/gate
 *   GET  /s/:code            分享落地页（HTML）
 *   GET  /og/:code.png       分享图（当前仍为 SVG，待接入 PNG 渲染，见 pages.ts 的 TODO(og-png)）
 */
import type { Env } from '../env';
import { apiErrorResponse, finalizeResponse, notFound, preflightResponse } from '../http';
import { landingPage, ogImage } from './pages';
import { handleBind, handleCreateSquad, handleGate, handleJoinSquad, handleLeaderboard, handleMe } from './handlers';
import type { SocialEnv } from './common';

type Route = 'api' | 'landing' | 'og';

function routeOf(path: string): Route | null {
  if (path === '/api/social' || path.startsWith('/api/social/')) return 'api';
  if (/^\/s\/[^/]+$/.test(path)) return 'landing';
  if (/^\/og\/[^/]+\.png$/.test(path)) return 'og';
  return null;
}

async function dispatchApi(request: Request, env: SocialEnv, url: URL, now: number): Promise<Response> {
  const method = request.method;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'social', ...]
  const sub = parts[2];

  if (parts.length === 3 && sub === 'me') {
    if (method !== 'GET') throw notFound('接口不存在');
    return handleMe(env, url, now);
  }
  if (parts.length === 3 && sub === 'bind') {
    if (method !== 'POST') throw notFound('接口不存在');
    return handleBind(request, env, now);
  }
  if (parts.length === 3 && sub === 'squads') {
    if (method !== 'POST') throw notFound('接口不存在');
    return handleCreateSquad(request, env, now);
  }
  if (parts.length === 5 && sub === 'squads' && parts[4] === 'join') {
    if (method !== 'POST') throw notFound('接口不存在');
    return handleJoinSquad(request, env, parts[3].toUpperCase(), now);
  }
  if (parts.length === 3 && sub === 'leaderboard') {
    if (method !== 'GET') throw notFound('接口不存在');
    return handleLeaderboard(env, url, now);
  }
  if (parts.length === 3 && sub === 'gate') {
    if (method !== 'GET') throw notFound('接口不存在');
    return handleGate(env, now);
  }
  throw notFound('接口不存在');
}

/**
 * 返回 null 表示路径不属于社交层。
 * 返回的 Response 已经过 finalizeResponse（安全头 / CORS），主路由可直接返回。
 */
export async function handleSocialRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const route = routeOf(url.pathname);
  if (!route) return null;

  const socialEnv = env as SocialEnv;
  const now = Date.now();
  let response: Response;
  try {
    if (route === 'api') {
      response = request.method === 'OPTIONS' ? preflightResponse() : await dispatchApi(request, socialEnv, url, now);
    } else if (route === 'landing') {
      if (request.method !== 'GET') throw notFound('页面不存在');
      const code = url.pathname.slice('/s/'.length);
      response = await landingPage(request, socialEnv, code, now, ctx);
    } else {
      if (request.method !== 'GET') throw notFound('页面不存在');
      const code = url.pathname.slice('/og/'.length, -'.png'.length);
      response = await ogImage(socialEnv, code, now);
    }
  } catch (err) {
    response = apiErrorResponse(err);
  }
  return finalizeResponse(response, env, request);
}
