/**
 * HTTP 基础设施：统一 ApiResponse 包装、CORS、安全响应头、错误映射、微缓存、入参校验。
 * 契约见 docs/09 §4/§5 与 shared/types.ts。
 */
import type { ApiResponse } from '@shared/types';
import type { Env } from './env';

export type ErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'CONFLICT' | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError('BAD_REQUEST', message);
}

export function notFound(message = '资源不存在'): ApiError {
  return new ApiError('NOT_FOUND', message);
}

export function conflict(message: string): ApiError {
  return new ApiError('CONFLICT', message);
}

export function unauthorized(message = '未授权'): ApiError {
  return new ApiError('UNAUTHORIZED', message);
}

/* ------------------------------------------------------------------ *
 * CORS / 安全响应头
 * ------------------------------------------------------------------ */

function allowedOrigin(env: Env, request: Request): string | null {
  const cfg = (env.ALLOWED_ORIGINS ?? '*').trim();
  if (cfg === '*' || cfg === '') return '*';
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const list = cfg.split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function isApiPath(request: Request): boolean {
  try {
    const path = new URL(request.url).pathname;
    return path === '/api' || path.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * 所有响应（含 ASSETS 静态资源）统一追加安全头 + CORS。
 * TODO(deploy): TON Connect 桥接域名（bridge.ton.org / 各钱包自定义桥）未最终确定，
 * 暂不下发严格 CSP，待前端 manifest 与桥域名冻结后再加 Content-Security-Policy。
 */
export function finalizeResponse(res: Response, env: Env, request: Request): Response {
  const headers = new Headers(res.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');

  const origin = allowedOrigin(env, request);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    if (origin !== '*') headers.append('Vary', 'Origin');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Access-Control-Max-Age', '86400');
  }

  if (isApiPath(request)) {
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  } else {
    // 静态资源：带 hash 的构建产物长缓存；_headers 规则与运行时默认值会重复，这里统一覆盖为单值。
    const path = new URL(request.url).pathname;
    if (path.startsWith('/assets/')) headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    else if (path === '/' || path.endsWith('.html')) headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  }
  // body 未改动，但长度/编码交给运行时重算，避免透传不一致。
  headers.delete('Content-Length');
  const body = res.status === 204 || res.status === 304 ? null : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/* ------------------------------------------------------------------ *
 * JSON 响应
 * ------------------------------------------------------------------ */

export function jsonResponse(payload: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Api-Ts': String(Date.now()),
    },
  });
}

export function okResponse<T>(data: T): Response {
  const body: ApiResponse<T> = { ok: true, data, ts: Date.now() };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function apiErrorResponse(error: unknown): Response {
  let body: ApiResponse<never>;
  let status: number;
  if (error instanceof ApiError) {
    body = { ok: false, error: { code: error.code, message: error.message } };
    status = error.status;
  } else {
    // 不把堆栈 / 表名 / SQL 泄露给客户端，完整信息只进 wrangler tail。
    console.error('[unhandled]', error instanceof Error ? error.stack ?? error.message : String(error));
    body = { ok: false, error: { code: 'INTERNAL', message: '服务暂时不可用' } };
    status = 500;
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

export function logRequest(request: Request, status: number, startedAt: number): void {
  let path = request.url;
  try {
    path = new URL(request.url).pathname;
  } catch {
    /* ignore */
  }
  console.log(
    JSON.stringify({
      lvl: 'info',
      m: request.method,
      p: path,
      s: status,
      ms: Date.now() - startedAt,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * 请求体 / 入参校验
 * ------------------------------------------------------------------ */

const MAX_BODY_BYTES = 8 * 1024;

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const len = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) throw badRequest('请求体过大');
  const text = await request.text();
  if (!text.trim()) return {};
  if (text.length > MAX_BODY_BYTES) throw badRequest('请求体过大');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest('请求体必须是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest('请求体必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, key: string, maxLen = 256): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`缺少字段 ${key}`);
  const trimmed = value.trim();
  if (trimmed.length > maxLen) throw badRequest(`字段 ${key} 过长`);
  return trimmed;
}

export function optionalString(body: Record<string, unknown>, key: string, maxLen = 256): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest(`字段 ${key} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > maxLen) throw badRequest(`字段 ${key} 过长`);
  return trimmed || null;
}

export function requireInt(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw badRequest(`字段 ${key} 必须是整数`);
  return value;
}

export function requireBool(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw badRequest(`字段 ${key} 必须是布尔值`);
  return value;
}

/** raw units：纯数字字符串，> 0。 */
export function parseRawAmount(value: unknown, key = 'amountRaw'): bigint {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`字段 ${key} 必须是 raw units 字符串`);
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw badRequest(`字段 ${key} 只能包含数字`);
  if (trimmed.length > 40) throw badRequest(`字段 ${key} 超出范围`);
  const amount = BigInt(trimmed);
  if (amount <= 0n) throw badRequest(`字段 ${key} 必须大于 0`);
  return amount;
}

/** TON 用户友好地址（UQ/EQ… 48 字符 base64url）。demo 假地址同样符合该形状。 */
const ADDRESS_RE = /^[EUk0][Qq][A-Za-z0-9_-]{46}$/;

export function parseAddress(value: unknown, key = 'address'): string {
  if (typeof value !== 'string') throw badRequest(`缺少字段 ${key}`);
  const address = value.trim();
  if (!address) throw badRequest(`缺少字段 ${key}`);
  if (address.length > 128) throw badRequest('地址过长');
  if (!ADDRESS_RE.test(address)) throw badRequest('地址格式不合法（需要 TON 用户友好地址）');
  return address;
}

export function parseRoundId(value: unknown): number {
  const raw = typeof value === 'string' ? Number(value) : value;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 10) {
    throw badRequest('轮次必须是 1..10 的整数');
  }
  return raw;
}

/* ------------------------------------------------------------------ *
 * 单 isolate 微缓存（1~2s）：降低页面轮询对 D1 的读取压力。
 * 只用于白名单 GET；任何写操作调用 bustCache()。admin 响应永不缓存。
 * ------------------------------------------------------------------ */

interface CacheEntry {
  at: number;
  status: number;
  body: string;
}

const microCache = new Map<string, CacheEntry>();

export function cacheTtlMs(env: Env): number {
  const seconds = Number(env.EDGE_CACHE_SECONDS ?? '1');
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, 5) * 1000;
}

export function cacheGet(key: string, now: number, ttlMs: number): CacheEntry | null {
  if (ttlMs <= 0) return null;
  const hit = microCache.get(key);
  if (!hit) return null;
  if (now - hit.at > ttlMs) {
    microCache.delete(key);
    return null;
  }
  return hit;
}

export function cacheSet(key: string, status: number, body: string, now: number): void {
  if (microCache.size > 64) microCache.clear();
  microCache.set(key, { at: now, status, body });
}

export function bustCache(): void {
  microCache.clear();
}

export function cachedResponse(entry: CacheEntry): Response {
  return new Response(entry.body, {
    status: entry.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}