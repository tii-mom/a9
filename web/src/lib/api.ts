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

function newNonce(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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
  /**
   * 演示质押。depositNonce 为幂等键：不传则自动生成（crypto.randomUUID），
   * 后端以 (roundId, address, nonce) 唯一去重，重复提交返回 409。
   */
  stake: (payload: {
    address: string;
    roundId: number;
    amountRaw: string;
    riskDisclosureVersion: number;
    acceptFullPrincipalBurn: boolean;
    depositNonce?: string;
  }) =>
    request<{ accepted: boolean; position: { roundId: number; amountRaw: string } }>(ENDPOINTS.stake, {
      method: 'POST',
      body: JSON.stringify({ ...payload, depositNonce: payload.depositNonce ?? newNonce() }),
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
  /** Time of the most recent successful response for these dependencies. */
  updatedAt: number | null;
  refresh: () => void;
  refetch: () => void;
}

/** Poll an endpoint on an interval (default 3s). Pauses when the tab is hidden. */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: { intervalMs?: number; enabled?: boolean } = {}): QueryState<T> {
  const { intervalMs = 3000, enabled = true } = opts;
  const [snapshot, setSnapshot] = useState<{
    deps: unknown[]; data: T | null; error: ApiError | null; loading: boolean; updatedAt: number | null;
  }>({ deps: [...deps], data: null, error: null, loading: enabled, updatedAt: null });
  const sameDeps = (previous: unknown[]) => previous.length === deps.length && previous.every((value, index) => Object.is(value, deps[index]));
  const current = enabled && sameDeps(snapshot.deps);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const requestDeps = [...deps];
    const matches = (previous: unknown[]) => previous.length === requestDeps.length && previous.every((value, index) => Object.is(value, requestDeps[index]));
    setSnapshot((previous) => enabled && matches(previous.deps)
      ? { ...previous, loading: true }
      : { deps: requestDeps, data: null, error: null, loading: enabled, updatedAt: null });
    if (!enabled) return;
    let alive = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      setSnapshot((previous) => ({ ...previous, loading: true }));
      try {
        const next = await fnRef.current();
        if (!alive) return;
        setSnapshot({ deps: requestDeps, data: next, error: null, loading: false, updatedAt: Date.now() });
      } catch (e) {
        if (!alive) return;
        const error = e instanceof ApiError ? e : new ApiError('NETWORK', String(e));
        setSnapshot((previous) => ({ ...previous, error, loading: false }));
      } finally {
        inFlight = false;
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

  return {
    data: current ? snapshot.data : null,
    error: current ? snapshot.error : null,
    loading: enabled && (!current || snapshot.loading),
    updatedAt: current ? snapshot.updatedAt : null,
    refresh,
    refetch: refresh,
  };
}

export type { Claimable };