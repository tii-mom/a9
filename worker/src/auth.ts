/**
 * 管理端鉴权：Authorization: Bearer <ADMIN_TOKEN>，constant-time 比较。
 * ADMIN_TOKEN 未配置时一律 401，不暴露「是否配置」等实现细节。
 *
 * 安全策略：
 *  - 生产（DATA_SOURCE=chain）要求 ADMIN_TOKEN 长度 >= 32；demo 允许 >= 8，但首次使用会打 warning。
 *  - 审计 actor 可由已鉴权请求的 X-A9-Actor 头提供（缺省 'admin'），仅接受安全字符集，写入 admin_events。
 */
import type { Env } from './env';
import { unauthorized } from './http';

export const MIN_ADMIN_TOKEN_LENGTH_PROD = 32;
export const MIN_ADMIN_TOKEN_LENGTH_DEMO = 8;
const MAX_ACTOR_LENGTH = 64;
const ACTOR_PATTERN = /^[A-Za-z0-9._:@-]{1,64}$/;

let warnedDemoToken = false;

/** 长度无关的常量时间字节比较（避免按字符短路造成时序侧信道）。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const len = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < len; i++) {
    const l = i < left.length ? left[i] : 0;
    const r = i < right.length ? right[i] : 0;
    diff |= l ^ r;
  }
  return diff === 0;
}

export interface AdminActor {
  actor: string;
}

/** 从可选 X-A9-Actor 头取审计 actor；非法/缺省 → 'admin'（不信任任意字符）。 */
export function resolveAdminActor(request: Request): string {
  const raw = (request.headers.get('x-a9-actor') ?? '').trim();
  if (!raw) return 'admin';
  if (!ACTOR_PATTERN.test(raw)) return 'admin';
  return raw.slice(0, MAX_ACTOR_LENGTH);
}

/**
 * 校验管理员身份并返回审计 actor。
 * 失败一律抛 UNAUTHORIZED（401），消息保持通用，不区分「未配置 / 格式错误 / token 错误」。
 */
export function requireAdmin(request: Request, env: Env): AdminActor {
  const expected = env.ADMIN_TOKEN;
  const production = env.DATA_SOURCE === 'chain';
  const minLength = production ? MIN_ADMIN_TOKEN_LENGTH_PROD : MIN_ADMIN_TOKEN_LENGTH_DEMO;

  if (!expected || expected.length < minLength) {
    console.warn(
      JSON.stringify({
        lvl: 'warn',
        msg: 'ADMIN_TOKEN 未配置或长度不足，管理接口拒绝访问',
        minLength: minLength,
        dataSource: env.DATA_SOURCE ?? 'demo',
        now: Date.now(),
      }),
    );
    throw unauthorized();
  }

  // demo 允许 8~31 位短 token（仅本地/演示），但打一次 warning，避免生产误用
  if (!production && expected.length < MIN_ADMIN_TOKEN_LENGTH_PROD && !warnedDemoToken) {
    warnedDemoToken = true;
    console.warn(
      JSON.stringify({
        lvl: 'warn',
        msg: 'ADMIN_TOKEN 长度 <32，仅 demo 允许；生产必须 >=32',
        length: expected.length,
        now: Date.now(),
      }),
    );
  }

  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !timingSafeEqual(match[1].trim(), expected)) {
    throw unauthorized();
  }
  return { actor: resolveAdminActor(request) };
}
