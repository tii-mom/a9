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
import type {
  SocialBindRequest,
  SocialBindResponse,
  SocialLeaderboardResponse,
  SocialMeResponse,
  SocialSquadCreateRequest,
  SocialSquadJoinRequest,
  SocialSquadResponse,
} from '@shared/types';
import type { GateState, LeaderboardScope, LeaderboardType } from '../features/social/types';

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
  // `key` is the serialized data. An unchanged response keeps the same snapshot object, so React bails out.
  const [snapshot, setSnapshot] = useState<{
    deps: unknown[]; data: T | null; key: string | null; error: ApiError | null; loading: boolean;
  }>({ deps: [...deps], data: null, key: null, error: null, loading: enabled });
  // Freshness lives in a ref: a successful poll with unchanged data must not re-render the caller.
  const freshRef = useRef<{ deps: unknown[]; at: number } | null>(null);
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
      ? (previous.loading || previous.data !== null ? previous : { ...previous, loading: true })
      : { deps: requestDeps, data: null, key: null, error: null, loading: enabled });
    if (!enabled) return;
    let alive = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Arm the next poll only while the tab is visible. A hidden tab stops polling and resumes on return.
    const schedule = (delay: number) => {
      if (!alive || intervalMs <= 0 || document.visibilityState !== 'visible') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delay);
    };

    const run = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      // Background polls of loaded data do not flip loading, so they cause no re-render by themselves.
      setSnapshot((previous) => (previous.data === null && !previous.loading ? { ...previous, loading: true } : previous));
      try {
        const next = await fnRef.current();
        if (!alive) return;
        const key = JSON.stringify(next);
        freshRef.current = { deps: requestDeps, at: Date.now() };
        setSnapshot((previous) => (
          previous.key === key && previous.error === null && !previous.loading && matches(previous.deps)
            ? previous // unchanged: same object, no re-render; the old data reference is kept
            : { deps: requestDeps, data: next, key, error: null, loading: false }
        ));
      } catch (e) {
        if (!alive) return;
        const error = e instanceof ApiError ? e : new ApiError('NETWORK', String(e));
        setSnapshot((previous) => (
          previous.error?.code === error.code && previous.error?.message === error.message && !previous.loading
            ? previous
            : { ...previous, error, loading: false }
        ));
      } finally {
        inFlight = false;
      }
      schedule(intervalMs);
    };

    run();
    const onVisible = () => schedule(250);
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
    updatedAt: current && freshRef.current && sameDeps(freshRef.current.deps) ? freshRef.current.at : null,
    refresh,
    refetch: refresh,
  };
}

export type { Claimable };

/* ------------------------------------------------------------------ */
/* 社交层（Telegram 小程序 / X 拉新）：/api/social/*                     */
/* 写接口（bind / squads / join）请求体必须带 wallet；鉴权为 TON Proof：   */
/* body.proof 或 X-Ton-Proof 头，二选一。目前 web 尚未获取 proof（见报告），  */
/* 未带 proof 时后端仅在 demo 且 DEMO_ALLOW_UNSIGNED_WRITES=true 下放行。    */
/* ------------------------------------------------------------------ */

export const socialApi = {
  me: (wallet: string) => request<SocialMeResponse>(`/api/social/me?wallet=${encodeURIComponent(wallet)}`),
  /** Telegram 身份只通过 body.tgInitData 传递（服务端校验），不再发送 tgUserId。 */
  bind: (body: SocialBindRequest) =>
    request<SocialBindResponse>('/api/social/bind', { method: 'POST', body: JSON.stringify(body) }),
  createSquad: (body: SocialSquadCreateRequest) =>
    request<SocialSquadResponse>('/api/social/squads', { method: 'POST', body: JSON.stringify(body) }),
  joinSquad: (code: string, body: SocialSquadJoinRequest) =>
    request<SocialSquadResponse>(`/api/social/squads/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  leaderboard: (query: { type: LeaderboardType; scope: LeaderboardScope; round?: number }) => {
    const params = new URLSearchParams({ type: query.type, scope: query.scope });
    if (query.round !== undefined) params.set('round', String(query.round));
    return request<SocialLeaderboardResponse>(`/api/social/leaderboard?${params.toString()}`);
  },
  gate: () => request<GateState>('/api/social/gate'),
};
