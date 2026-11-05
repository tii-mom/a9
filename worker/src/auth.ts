/**
 * 管理端鉴权：Authorization: Bearer <ADMIN_TOKEN>，constant-time 比较。
 * ADMIN_TOKEN 未配置时一律 401，不暴露「是否配置」等实现细节。
 */
import type { Env } from './env';
import { unauthorized } from './http';

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

/**
 * 校验管理员身份并返回审计 actor。
 * 失败一律抛 UNAUTHORIZED（401），消息保持通用，不区分「未配置 / 格式错误 / token 错误」。
 */
export function requireAdmin(request: Request, env: Env): AdminActor {
  const expected = env.ADMIN_TOKEN;
  if (!expected || expected.length < 8) {
    console.warn('[auth] ADMIN_TOKEN 未配置或过短，管理接口拒绝访问');
    throw unauthorized();
  }
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !timingSafeEqual(match[1].trim(), expected)) {
    throw unauthorized();
  }
  return { actor: 'admin' };
}
