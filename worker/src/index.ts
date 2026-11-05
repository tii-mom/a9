/**
 * FUSE 引信协议 Worker 入口：/api/* 走 API，其余交给 ASSETS（web/dist，SPA 回退）。
 */
import type { Env } from './env';
import { markIsolateStarted } from './env';
import { requireAdmin } from './auth';
import {
  ApiError,
  apiErrorResponse,
  badRequest,
  bustCache,
  cacheGet,
  cacheSet,
  cacheTtlMs,
  cachedResponse,
  conflict,
  finalizeResponse,
  logRequest,
  notFound,
  okResponse,
  optionalString,
  parseAddress,
  parseRawAmount,
  parseRoundId,
  preflightResponse,
  readJsonBody,
  requireBool,
  requireInt,
  requireString,
  type ErrorCode,
} from './http';
import * as state from './state';
import * as store from './store';
import * as views from './views';
import { clampInt, mulDivFloor, toBigInt } from './util';
import type { ReconcileResult } from './state';
import type { Env as WorkerEnv } from './env';

export type { Env };

/** 允许 1s 级微缓存的只读端点（admin 响应永不缓存）。 */
const CACHEABLE_GET = new Set(['/api/rounds', '/api/stats', '/api/book']);

function assertMethod(method: string, expected: string): void {
  if (method !== expected) throw notFound('接口不存在');
}

async function handleTrades(env: Env, url: URL): Promise<Response> {
  const raw = Number(url.searchParams.get('limit') ?? '20');
  const limit = clampInt(Number.isFinite(raw) ? raw : 20, 1, 100);
  const rows = await store.listTrades(env, limit);
  return okResponse(views.buildTrades(rows));
}

async function handleMe(env: Env, st: ReconcileResult, url: URL): Promise<Response> {
  const address = parseAddress(url.searchParams.get('address'));
  return okResponse(await views.buildMe(env, st, address));
}

async function handleStake(request: Request, env: Env, st: ReconcileResult): Promise<Response> {
  const body = await readJsonBody(request);
  const address = parseAddress(body.address);
  const roundId = parseRoundId(body.roundId);
  const amount = parseRawAmount(body.amountRaw);
  const riskVersion = requireInt(body, 'riskDisclosureVersion');
  const accept = requireBool(body, 'acceptFullPrincipalBurn');
  const source = optionalString(body, 'nonce');
  const nonce = source ?? 'auto-' + Date.now() + '-' + crypto.randomUUID();

  const { params, now } = st;
  if (riskVersion !== params.riskDisclosureVersion) {
    throw badRequest(`风险披露版本已更新，请刷新页面后重试（当前 v${params.riskDisclosureVersion}）`);
  }
  if (!accept) throw badRequest('必须勾选「本轮失败时 100% 质押本金可能销毁」');

  const round = st.rounds.find((item) => item.round_id === roundId);
  if (!round) throw notFound('轮次不存在');

  // 先做纯入参校验（金额 / 余额），再做窗口与状态判定，便于前端区分「输入错误」与「不可质押」
  const existing = await store.listStakesForRound(env, roundId);
  let alreadyStaked = 0n;
  for (const row of existing) {
    if (row.address === address) alreadyStaked += toBigInt(row.amount_raw);
  }
  if (amount > params.demoWalletBalanceRaw || alreadyStaked + amount > params.demoWalletBalanceRaw) {
    throw badRequest('演示钱包余额不足');
  }

  if (params.paused) throw conflict('预言机暂停期间不接受新质押');
  if (round.state !== 'STAKING_OPEN') {
    throw conflict(`R${roundId} 当前不在质押窗口（${round.state}）`);
  }
  if (
    round.stake_open_at === null ||
    round.stake_close_at === null ||
    now < round.stake_open_at ||
    now >= round.stake_close_at
  ) {
    throw conflict('当前不在质押时间窗口内');
  }

  const inserted = await store.insertStake(env, {
    roundId,
    address,
    amountRaw: amount,
    weightRaw: amount,
    nonce,
    riskDisclosureVersion: riskVersion,
    acceptFullPrincipalBurn: true,
    acceptedAt: now,
  });
  if (!inserted) throw conflict('重复的 deposit nonce，本次质押已忽略');

  await store.refreshRoundStakeTotals(env, roundId, now);
  await store.logEvent(
    env,
    'info',
    `wallet:${address.slice(0, 8)}`,
    'STAKE_ACCEPTED',
    `R${roundId} + ${amount.toString()} raw（nonce ${nonce.slice(0, 18)}）`,
  );
  bustCache();
  return okResponse({
    accepted: true,
    position: { roundId, amountRaw: (alreadyStaked + amount).toString() },
  });
}

async function handleClaim(request: Request, env: Env, st: ReconcileResult): Promise<Response> {
  const body = await readJsonBody(request);
  const address = parseAddress(body.address);
  const roundId = parseRoundId(body.roundId);
  const kind = requireString(body, 'kind');
  if (kind !== 'principal' && kind !== 'reward') throw badRequest('kind 必须是 principal 或 reward');

  const round = st.rounds.find((item) => item.round_id === roundId);
  if (!round) throw notFound('轮次不存在');
  if (round.state === 'FAILED_PERMANENT') {
    throw conflict('本轮永久失败，质押本金与奖励额度已销毁，无资产可领取');
  }
  if (round.state !== 'SUCCEEDED') throw conflict('本轮尚未成功结算，暂不可领取');

  const stakeRows = (await store.listStakesForAddress(env, address)).filter((row) => row.round_id === roundId);
  if (!stakeRows.length) throw notFound('该地址在本轮没有质押记录');

  const already = await store.getClaim(env, roundId, address, kind);
  if (already) {
    return okResponse({ claimed: false, amountRaw: already.amount_raw, alreadyClaimed: true });
  }

  const roundTotal = toBigInt(round.total_accepted_stake_raw);
  const amount = stakeRows.reduce((sum, row) => sum + toBigInt(row.amount_raw), 0n);
  let claimAmount = 0n;
  if (kind === 'principal') {
    claimAmount = stakeRows.reduce(
      (sum, row) => sum + (row.principal_claimed === 1 ? 0n : toBigInt(row.amount_raw)),
      0n,
    );
  } else {
    const reward = mulDivFloor(toBigInt(round.reward_budget_raw), amount, roundTotal);
    claimAmount = stakeRows.some((row) => row.reward_claimed === 1) ? 0n : reward;
  }

  if (claimAmount === 0n) {
    return okResponse({ claimed: false, amountRaw: '0', alreadyClaimed: true });
  }

  const recorded = await store.recordClaim(env, {
    roundId,
    address,
    kind,
    amountRaw: claimAmount,
    claimedAt: st.now,
  });
  if (!recorded) {
    const raced = await store.getClaim(env, roundId, address, kind);
    return okResponse({ claimed: false, amountRaw: raced?.amount_raw ?? '0', alreadyClaimed: true });
  }
  await store.logEvent(
    env,
    'info',
    `wallet:${address.slice(0, 8)}`,
    kind === 'principal' ? 'PRINCIPAL_CLAIMED' : 'REWARD_CLAIMED',
    `R${roundId} ${claimAmount.toString()} raw`,
  );
  bustCache();
  return okResponse({ claimed: true, amountRaw: claimAmount.toString(), alreadyClaimed: false });
}

async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  method: string,
  st: ReconcileResult,
  parts: string[],
): Promise<Response> {
  const { actor } = requireAdmin(request, env);

  if (parts.length === 2 && parts[1] === 'overview') {
    assertMethod(method, 'GET');
    return okResponse(await views.buildAdminOverview(env, st));
  }
  if (parts.length === 2 && parts[1] === 'tick') {
    assertMethod(method, 'POST');
    const auto = await state.autoplay(env);
    const next = await state.reconcile(env);
    if (next.params.dataSource === 'demo') await state.refreshDemoMarket(env, next);
    bustCache();
    return okResponse(await views.buildAdminOverview(env, next));
  }
  if (parts.length === 3 && parts[1] === 'oracle' && (parts[2] === 'pause' || parts[2] === 'resume')) {
    assertMethod(method, 'POST');
    if (parts[2] === 'pause') {
      const body = await readJsonBody(request);
      const reason = optionalString(body, 'reason') ?? '管理员手动暂停';
      const next = await state.pauseOracle(env, actor, reason);
      bustCache();
      return okResponse(await views.buildAdminOverview(env, next));
    }
    const next = await state.resumeOracle(env, actor);
    bustCache();
    return okResponse(await views.buildAdminOverview(env, next));
  }
  if (parts.length === 3 && parts[1] === 'rounds' && parts[2] === 'advance') {
    assertMethod(method, 'POST');
    const next = await state.advanceRound(env, actor);
    bustCache();
    return okResponse(await views.buildAdminOverview(env, next));
  }
  throw notFound('管理接口不存在');
}

async function route(
  request: Request,
  env: Env,
  url: URL,
  method: string,
  st: ReconcileResult,
): Promise<Response> {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api') throw notFound();
  const parts = segments.slice(1);
  const { params } = st;

  if (parts.length === 1) {
    switch (parts[0]) {
      case 'health': {
        assertMethod(method, 'GET');
        const db = await store.dbPing(env);
        return okResponse(views.buildHealth(env, db, params.dataSource));
      }
      case 'version':
        assertMethod(method, 'GET');
        return okResponse(views.buildVersionInfo(env, params.dataSource));
      case 'config':
        assertMethod(method, 'GET');
        return okResponse(views.buildProtocolConfig(st));
      case 'stats':
        assertMethod(method, 'GET');
        return okResponse(await views.buildStats(env, st));
      case 'rounds':
        assertMethod(method, 'GET');
        return okResponse(st.rounds.map((row) => views.buildRoundSummary(row, st)));
      case 'trades':
        assertMethod(method, 'GET');
        return handleTrades(env, url);
      case 'book': {
        assertMethod(method, 'GET');
        const rows = await store.listBook(env);
        return okResponse(views.buildOrderBook(st, rows));
      }
      case 'me':
        assertMethod(method, 'GET');
        return handleMe(env, st, url);
      case 'stake':
        assertMethod(method, 'POST');
        return handleStake(request, env, st);
      case 'claim':
        assertMethod(method, 'POST');
        return handleClaim(request, env, st);
      default:
        throw notFound('接口不存在');
    }
  }

  if (parts[0] === 'rounds' && parts.length >= 2) {
    assertMethod(method, 'GET');
    const roundId = parseRoundId(parts[1]);
    const round = st.rounds.find((item) => item.round_id === roundId);
    if (!round) throw notFound('轮次不存在');
    if (parts.length === 2) return okResponse(views.buildRoundDetail(st, round));
    if (parts.length === 3) {
      if (parts[2] === 'candles') {
        return okResponse(views.buildCandles(st.candlesByRound.get(roundId) ?? []));
      }
      if (parts[2] === 'leaderboard') {
        return okResponse(views.buildLeaderboard(st, roundId));
      }
    }
    throw notFound('接口不存在');
  }

  if (parts[0] === 'admin') return handleAdmin(request, env, url, method, st, parts);

  throw notFound('接口不存在');
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const ttl = cacheTtlMs(env);
  const cacheKey = url.pathname + url.search;
  const cacheable = method === 'GET' && CACHEABLE_GET.has(url.pathname);

  if (cacheable) {
    const hit = cacheGet(cacheKey, Date.now(), ttl);
    if (hit) return cachedResponse(hit);
  }

  const st = await state.reconcile(env);
  if (st.changed) bustCache();

  const response = await route(request, env, url, method, st);

  if (cacheable && ttl > 0) {
    const body = await response.clone().text();
    cacheSet(cacheKey, response.status, body, Date.now());
  }
  if (method !== 'GET' && method !== 'OPTIONS') bustCache();
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    markIsolateStarted();
    const started = Date.now();
    let response: Response;
    try {
      const url = new URL(request.url);
      const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
      if (!isApi) {
        // 非 /api：交给 ASSETS（not_found_handling=single-page-application 负责 SPA 回退）。
        response = await env.ASSETS.fetch(request);
      } else if (request.method.toUpperCase() === 'OPTIONS') {
        response = preflightResponse();
      } else {
        response = await handleApi(request, env, url);
      }
    } catch (error) {
      if (!(error instanceof ApiError)) {
        console.error('[fetch] unhandled', error instanceof Error ? (error.stack ?? error.message) : String(error));
      }
      response = apiErrorResponse(error);
    }
    const final = finalizeResponse(response, env, request);
    logRequest(request, final.status, started);
    void ctx;
    return final;
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    markIsolateStarted();
    ctx.waitUntil(
      (async () => {
        try {
          const auto = await state.autoplay(env);
          const st = await state.reconcile(env);
          await state.refreshDemoMarket(env, st);
          bustCache();
          console.log(JSON.stringify({ lvl: 'info', job: 'cron', changed: st.changed, autoplay: auto, now: st.now }));
        } catch (error) {
          console.error('[cron] failed', error instanceof Error ? (error.stack ?? error.message) : String(error));
        }
      })(),
    );
  },
};

export type { ErrorCode };
