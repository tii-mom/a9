import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdminOverview,
  ApiResponse,
  Claimable,
  HealthResponse,
  LeaderboardRow,
  MeResponse,
  OrderBook,
  ProtocolConfig,
  ProtocolStats,
  RoundDetail,
  RoundSummary,
  Trade,
} from '@shared/types';
import { ENDPOINTS } from '@shared/types';

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  let body: ApiResponse<T> | null = null;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError('BAD_RESPONSE', `接口返回非 JSON（HTTP ${res.status}）`);
  }
  if (!body || typeof body !== 'object' || !('ok' in body)) {
    throw new ApiError('BAD_RESPONSE', '接口返回格式错误');
  }
  if (!body.ok) throw new ApiError(body.error.code, body.error.message);
  return body.data;
}

function adminHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

export const api = {
  health: () => request<HealthResponse>(ENDPOINTS.health),
  config: () => request<ProtocolConfig>(ENDPOINTS.config),
  stats: () => request<ProtocolStats>(ENDPOINTS.stats),
  rounds: () => request<RoundSummary[]>(ENDPOINTS.rounds),
  round: (id: number) => request<RoundDetail>(ENDPOINTS.round(id)),
  leaderboard: (id: number) => request<LeaderboardRow[]>(ENDPOINTS.leaderboard(id)),
  trades: (limit = 20) => request<Trade[]>(`${ENDPOINTS.trades}?limit=${limit}`),
  book: () => request<OrderBook>(ENDPOINTS.book),
  me: (address: string) => request<MeResponse>(ENDPOINTS.me(address)),
  stake: (payload: { address: string; roundId: number; amountRaw: string; riskDisclosureVersion: number; acceptFullPrincipalBurn: boolean }) =>
    request<{ accepted: boolean; position: { roundId: number; amountRaw: string } }>(ENDPOINTS.stake, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  claim: (payload: { address: string; roundId: number; kind: 'principal' | 'reward' }) =>
    request<{ claimed: boolean; amountRaw: string }>(ENDPOINTS.claim, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  admin: {
    overview: (token: string) => request<AdminOverview>(ENDPOINTS.adminOverview, { headers: adminHeaders(token) }),
    tick: (token: string) => request<AdminOverview>(ENDPOINTS.adminTick, { method: 'POST', headers: adminHeaders(token) }),
    pauseOracle: (token: string, reason: string) =>
      request<AdminOverview>(ENDPOINTS.adminPauseOracle, { method: 'POST', headers: adminHeaders(token), body: JSON.stringify({ reason }) }),
    resumeOracle: (token: string) =>
      request<AdminOverview>(ENDPOINTS.adminResumeOracle, { method: 'POST', headers: adminHeaders(token) }),
    advance: (token: string) => request<AdminOverview>(ENDPOINTS.adminAdvance, { method: 'POST', headers: adminHeaders(token) }),
  },
};

export interface QueryState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  refresh: () => void;
}

/** Poll an endpoint on an interval (default 3s). Pauses when the tab is hidden. */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: { intervalMs?: number; enabled?: boolean } = {}): QueryState<T> {
  const { intervalMs = 3000, enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const next = await fnRef.current();
        if (!alive) return;
        setData(next);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof ApiError ? e : new ApiError('NETWORK', String(e)));
      } finally {
        if (alive) setLoading(false);
      }
      if (alive && intervalMs > 0) timer = setTimeout(run, intervalMs);
    };

    run();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && intervalMs > 0) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(run, 250);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, nonce, ...deps]);

  return { data, error, loading, refresh };
}

export type { Claimable };
