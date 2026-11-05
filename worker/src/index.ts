import type { ApiResponse } from '@shared/types';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DATA_SOURCE: string;
  DEMO_CANDLE_SECONDS: string;
  DEMO_WALLET_BALANCE: string;
  ALLOWED_ORIGINS: string;
  ADMIN_TOKEN?: string;
}

/**
 * FUSE 引信协议 API Worker。
 * 由 backend-dev 实现：路由、D1 访问、演示状态机、admin 鉴权。
 * 静态资源交给 ASSETS 绑定（web/dist）。
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    const body: ApiResponse<null> = {
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'API 尚未实现' },
    };
    return new Response(JSON.stringify(body), {
      status: 501,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  },
};
