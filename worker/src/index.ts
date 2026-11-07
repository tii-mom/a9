/**
 * A9 Worker 入口：/api/* 走 API，其余交给 ASSETS（web/dist，SPA 回退）。
 */
import type { Env } from './env';
import { chainConfigError, markIsolateStarted } from './env';
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
import { clientIp, createAuthSession, enforceRateLimit, issueAuthChallenge, issueAuthNonce, requireWriteAuth } from './tonproof';
import { notImplemented, oraclePaused } from './http';
import { reconcile as indexerReconcile, tick as indexerTick } from './indexer';
import { parseTonAddress } from './indexer/address';
import { clampInt, mulDivFloor, toBigInt } from './util';
import type { ReconcileResult } from './state';
import type { Env as WorkerEnv } from './env';
import { handleSocialRequest } from './social';
import { handleTelegramWebhook, pushSquadDigest } from './bot';
import { loadGateForBot } from './social-bot-wiring';
import { handleAdminPayoutBuild } from './social/payout';
import { computeRoundJunxiang } from './social/runner';
import { runWeeklyPayoutBuild } from './social/auto';

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
  // chain 模式索引器按 raw 地址（0:hex）落库；用户友好地址先归一成 raw 再查，响应里仍回显调用方传入的地址
  const lookup = st.params.dataSource === 'chain' ? (parseTonAddress(address)?.raw ?? address) : address;
  const me = await views.buildMe(env, st, lookup);
  return okResponse({ ...me, address, stakes: me.stakes.map((stake) => ({ ...stake, address })) });
}

async function handleStake(request: Request, env: Env, st: ReconcileResult): Promise<Response> {
  const body = await readJsonBody(request);
  // P1-D：chain 模式禁止演示写入（请直接与合约交互）
  if (st.params.dataSource === 'chain') {
    throw notImplemented('链上模式请直接与合约交互：/api/stake 仅用于演示数据源');
  }
  const address = parseAddress(body.address);
  const roundId = parseRoundId(body.roundId);
  const amount = parseRawAmount(body.amountRaw);
  const riskVersion = requireInt(body, 'riskDisclosureVersion');
  const accept = requireBool(body, 'acceptFullPrincipalBurn');
  // P1-B：前端发 depositNonce，旧客户端发 nonce；前者优先，避免幂等去重失效
  const source = optionalString(body, 'depositNonce') ?? optionalString(body, 'nonce');
  const nonce = source ?? 'auto-' + Date.now() + '-' + crypto.randomUUID();
  // P1-A：TON Proof 验签 + 一次性 nonce（demo 可用 DEMO_ALLOW_UNSIGNED_WRITES=true 显式放行）
  await requireWriteAuth(env, request, body, address, st.now);

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
  if (amount < params.minStakeRaw) {
    throw badRequest(`低于最低有效质押（${params.minStakeRaw.toString()} raw）`);
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
    `R${roundId} + ${amount.toString()} raw`,
  );
  bustCache();
  return okResponse({
    accepted: true,
    position: { roundId, amountRaw: (alreadyStaked + amount).toString() },
  });
}

/**
 * 演示领取（v11 同口径）：每城一次领取「未领本金 + 20% 立即奖励 + 已解锁的压城部分」；all=true 逐城领取全部。
 * 可领：SUCCEEDED（本金 + 20%，之后压城解锁增量）/ TECHNICAL_ABORTED（只退本金）；FAILED_PERMANENT 无可领。
 * v11 没有退款账本，roundsMask 不会出现 bit 15。kind 字段保留兼容（web 旧调用），不再区分本金与奖励。
 */
async function handleClaim(request: Request, env: Env, st: ReconcileResult): Promise<Response> {
  const body = await readJsonBody(request);
  if (st.params.dataSource === 'chain') {
    throw notImplemented('链上模式请直接与合约交互：/api/claim 仅用于演示数据源');
  }
  const address = parseAddress(body.address);
  // P1-A：领取同样需要 ton_proof（防替他人领取）
  await requireWriteAuth(env, request, body, address, st.now);
  const all = body.all === true;
  let roundIds: number[];
  if (all) {
    roundIds = st.rounds.map((row) => row.round_id);
  } else {
    const roundId = parseRoundId(body.roundId);
    const round = st.rounds.find((item) => item.round_id === roundId);
    if (!round) throw notFound('轮次不存在');
    if (round.state === 'FAILED_PERMANENT') {
      throw conflict('本轮永久失败，质押本金与奖励额度已销毁，无资产可领取');
    }
    if (round.state !== 'SUCCEEDED' && round.state !== 'TECHNICAL_ABORTED') throw conflict('本轮尚未结算，暂不可领取');
    roundIds = [roundId];
  }

  const myStakes = (await store.listStakesForAddress(env, address)).filter((row) => roundIds.includes(row.round_id));
  if (!all && !myStakes.length) throw notFound('该地址在本轮没有质押记录');

  // v11 demo：每城的「现在可领」与 /api/me 的 rounds[] 同口径（views.buildMe），每次领取写一条 claim_events 流水；
  // 流水键 demo:<now>:<round> 保证同一次请求重放幂等，压城未解锁部分留待后续领取。
  const me = await views.buildMe(env, st, address);
  const positions = me.rounds.filter((item) => roundIds.includes(item.roundId));
  let mask = 0;
  let principalTotal = 0n;
  let rewardTotal = 0n;
  let alreadyClaimed = false;
  for (const position of positions) {
    const round = st.rounds.find((item) => item.round_id === position.roundId);
    if (!round || (round.state !== 'SUCCEEDED' && round.state !== 'TECHNICAL_ABORTED')) continue;
    const principal = toBigInt(position.claimablePrincipalRaw);
    const reward = toBigInt(position.claimableRewardRaw);
    if (principal + reward === 0n) {
      if (position.principalClaimed) alreadyClaimed = true;
      continue;
    }
    const recorded = await store.recordClaimEvent(env, {
      txLt: 'demo:' + st.now + ':' + position.roundId,
      roundId: position.roundId,
      address,
      principalRaw: principal,
      rewardRaw: reward,
      claimedAt: st.now,
    });
    if (!recorded) {
      alreadyClaimed = true;
      continue;
    }
    const fullyUnlocked = toBigInt(position.unlockedRaw) >= toBigInt(position.lockedRaw);
    await store.markStakesClaimed(env, position.roundId, address, { principal: true, reward: fullyUnlocked });
    mask |= 1 << (position.roundId - 1);
    principalTotal += principal;
    rewardTotal += reward;
  }

  if (mask === 0) {
    if (!all && !alreadyClaimed) throw conflict('没有可领取的资产');
    return okResponse({ claimed: false, roundsMask: 0, principalRaw: '0', rewardRaw: '0', amountRaw: '0', alreadyClaimed: true });
  }
  await store.logEvent(
    env,
    'info',
    address.slice(0, 12),
    'CLAIMED',
    `mask=0x${mask.toString(16)} principal=${principalTotal.toString()} reward=${rewardTotal.toString()} raw`,
  );
  bustCache();
  return okResponse({
    claimed: true,
    roundsMask: mask,
    principalRaw: principalTotal.toString(),
    rewardRaw: rewardTotal.toString(),
    amountRaw: (principalTotal + rewardTotal).toString(),
    alreadyClaimed: false,
  });
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
    if (st.params.dataSource === 'chain') {
      throw notImplemented('链上模式无法本地暂停/恢复预言机：暂停由链上 status=5 驱动，请在合约执行');
    }
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
    if (st.params.dataSource === 'chain') {
      throw notImplemented('链上模式无法本地推进轮次：开轮由合约 RoundController 决定，请在链上执行');
    }
    const next = await state.advanceRound(env, actor);
    bustCache();
    return okResponse(await views.buildAdminOverview(env, next));
  }
  if (parts.length === 3 && parts[1] === 'indexer' && (parts[2] === 'tick' || parts[2] === 'reconcile')) {
    assertMethod(method, 'POST');
    try {
      const result =
        parts[2] === 'tick' ? await indexerTick(env, Date.now()) : await indexerReconcile(env, Date.now());
      return okResponse(result);
    } catch (error) {
      // indexer tick/reconcile 约定永不抛出；这里兜底并写审计，不把堆栈返回给客户端
      try {
        await store.logEvent(
          env,
          'error',
          actor,
          'INDEXER_ADMIN_ERROR',
          (error instanceof Error ? error.message : String(error)).slice(0, 240),
        );
      } catch {
        /* ignore */
      }
      throw new ApiError('INTERNAL', '索引器操作失败');
    }
  }
  throw notFound('管理接口不存在');
}

/** FIX-7：廉价路由分类（不触碰 DB）。null = 404（未知路径/方法）。 */
type D1Scope = 'admin' | 'stake' | 'claim' | 'nonce' | 'session';

interface RoutePlan {
  requiresState: boolean;
  requiresAdmin: boolean;
  d1Scope: D1Scope | null;
  cacheable: boolean;
  cheap: 'none' | 'nonce' | 'challenge' | 'session' | 'health' | 'version';
  badRequestMessage?: string;
  /** B1：chain 模式必须返回 501 的本地写接口（链上状态只能由合约/索引器决定） */
  chainForbiddenMessage?: string;
}

function routePlan(partial: Partial<RoutePlan>): RoutePlan {
  return {
    requiresState: true,
    requiresAdmin: false,
    d1Scope: null,
    cacheable: false,
    cheap: 'none',
    ...partial,
  };
}

/** 路由白名单：只有命中已知路径才可能进入 reconcile。 */
function classifyRoute(method: string, url: URL): RoutePlan | null {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api') return null;
  const parts = segments.slice(1);
  const isGet = method === 'GET';
  const isPost = method === 'POST';

  if (parts.length === 1) {
    switch (parts[0]) {
      case 'health':
        return isGet ? routePlan({ requiresState: false, cheap: 'health' }) : null;
      case 'version':
        return isGet ? routePlan({ requiresState: false, cheap: 'version' }) : null;
      case 'config':
        return isGet ? routePlan({}) : null;
      case 'stats':
        return isGet ? routePlan({ cacheable: true }) : null;
      case 'rounds':
        return isGet ? routePlan({}) : null;
      case 'trades':
        return isGet ? routePlan({}) : null;
      case 'book':
        return isGet ? routePlan({ cacheable: true }) : null;
      case 'me':
        return isGet
          ? routePlan(
              url.searchParams.get('address') ? {} : { badRequestMessage: '缺少字段 address' },
            )
          : null;
      case 'stake':
        return isPost ? routePlan({ d1Scope: 'stake' }) : null;
      case 'claim':
        return isPost ? routePlan({ d1Scope: 'claim' }) : null;
      default:
        return null;
    }
  }

  if (parts[0] === 'auth' && parts.length === 2 && parts[1] === 'nonce') {
    return isGet ? routePlan({ requiresState: false, cheap: 'nonce', d1Scope: 'nonce' }) : null;
  }
  if (parts[0] === 'auth' && parts.length === 2 && parts[1] === 'challenge') {
    return isGet ? routePlan({ requiresState: false, cheap: 'challenge', d1Scope: 'nonce' }) : null;
  }
  if (parts[0] === 'auth' && parts.length === 2 && parts[1] === 'session') {
    return isPost ? routePlan({ requiresState: false, cheap: 'session', d1Scope: 'session' }) : null;
  }

  if (parts[0] === 'rounds' && parts.length >= 2 && parts.length <= 3) {
    if (!isGet) return null;
    const roundId = Number(parts[1]);
    if (!Number.isInteger(roundId) || roundId < 1 || roundId > 10) {
      return routePlan({ badRequestMessage: '轮次必须是 1..10 的整数' });
    }
    if (parts.length === 2) return routePlan({});
    if (parts[2] === 'candles' || parts[2] === 'leaderboard') return routePlan({});
    return null;
  }

  if (parts[0] === 'admin') {
    if (parts.length === 2 && parts[1] === 'overview') {
      return isGet ? routePlan({ requiresAdmin: true, d1Scope: 'admin' }) : null;
    }
    if (parts.length === 2 && parts[1] === 'tick') {
      return isPost ? routePlan({ requiresAdmin: true, d1Scope: 'admin' }) : null;
    }
    if (parts.length === 3 && parts[1] === 'oracle' && (parts[2] === 'pause' || parts[2] === 'resume')) {
      return isPost
        ? routePlan({
            requiresAdmin: true,
            d1Scope: 'admin',
            chainForbiddenMessage: '链上模式无法本地暂停/恢复预言机：暂停由链上 status=5 驱动，请在合约执行',
          })
        : null;
    }
    if (parts.length === 3 && parts[1] === 'rounds' && parts[2] === 'advance') {
      return isPost
        ? routePlan({
            requiresAdmin: true,
            d1Scope: 'admin',
            chainForbiddenMessage: '链上模式无法本地推进轮次：开轮由合约 RoundController 决定，请在链上执行',
          })
        : null;
    }
    if (parts.length === 3 && parts[1] === 'indexer' && (parts[2] === 'tick' || parts[2] === 'reconcile')) {
      // H-4 补充：运维手动触发索引器（tick）/ 全量对账（reconcile）
      return isPost ? routePlan({ requiresAdmin: true, d1Scope: 'admin' }) : null;
    }
    return null;
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * FIX-7：内存级限流（所有 /api 请求 + 静态 GET，不写 D1）
 * ------------------------------------------------------------------ */

const memoryWindows = new Map<string, { bucket: number; count: number }>();

function memoryLimitExceeded(env: Env, request: Request, scope: string, now: number): boolean {
  const limit =
    scope === 'static'
      ? Number(env.RATE_LIMIT_STATIC_PER_MINUTE ?? '600')
      : Number(env.RATE_LIMIT_READ_PER_MINUTE ?? '120');
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const key = clientIp(request) + '|' + scope;
  const bucket = Math.floor(now / 60_000);
  const entry = memoryWindows.get(key);
  if (!entry || entry.bucket !== bucket) {
    if (memoryWindows.size > 5_000) memoryWindows.clear();
    memoryWindows.set(key, { bucket, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

/** 标记本次请求是否执行了 reconcile（供 smoke/运维断言「未知路径不触发 reconcile」）。 */
function withReconciled(response: Response, reconciled: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set('X-A9-Reconciled', reconciled ? '1' : '0');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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

  if (parts[0] === 'auth' && parts.length === 2 && parts[1] === 'nonce') {
    assertMethod(method, 'GET');
    const address = parseAddress(url.searchParams.get('address'));
    return okResponse(await issueAuthNonce(env, address, st.now));
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
  const now = Date.now();

  // ① 廉价路由判定（无 DB）+ 内存级 IP 限流（覆盖未知路径与所有 /api 请求）
  const plan = classifyRoute(method, url);
  const memScope = plan ? (plan.requiresState ? 'api-read' : 'api-cheap') : 'api-unknown';
  if (memoryLimitExceeded(env, request, memScope, now)) {
    return withReconciled(apiErrorResponse(new ApiError('RATE_LIMITED', '请求过于频繁，请稍后重试')), false);
  }
  if (!plan) {
    return withReconciled(apiErrorResponse(notFound('接口不存在')), false);
  }

  // H-6：chain 模式缺少 TONCENTER_API_KEY（且未显式放行公共端点）→ 除 health 外拒绝服务，不降级抖动。
  // health 必须保持 200（外部监控能区分「服务挂了」与「配置缺失」），原因写在 body.oracle 里。
  const chainError = chainConfigError(env);
  if (chainError && plan.cheap !== 'health') {
    return withReconciled(apiErrorResponse(oraclePaused(chainError)), false);
  }
  if (plan.badRequestMessage) {
    return withReconciled(apiErrorResponse(badRequest(plan.badRequestMessage)), false);
  }

  // B1：chain 模式禁止本地写 admin 状态（暂停/推进），必须在链上执行；overview 与 indexer/* 保留
  if (plan.chainForbiddenMessage && (env.DATA_SOURCE ?? 'demo') === 'chain') {
    return withReconciled(apiErrorResponse(notImplemented(plan.chainForbiddenMessage)), false);
  }

  // ② 敏感路径 D1 限流（admin/stake/claim/nonce；nonce 单独更低配额）
  if (plan.d1Scope) {
    const limitOverride =
      plan.d1Scope === 'nonce' ? Number(env.RATE_LIMIT_NONCE_PER_MINUTE ?? '10') : undefined;
    await enforceRateLimit(env, request, plan.d1Scope, now, limitOverride);
  }

  // ③ admin 先做 Bearer 鉴权（常量时间比较，无 DB），再决定是否 reconcile
  if (plan.requiresAdmin) requireAdmin(request, env);

  // ④ 廉价端点直接返回，不 reconcile
  if (plan.cheap === 'nonce') {
    const address = parseAddress(url.searchParams.get('address'));
    return withReconciled(okResponse(await issueAuthNonce(env, address, now)), false);
  }
  if (plan.cheap === 'challenge') {
    return withReconciled(okResponse(await issueAuthChallenge(env, now)), false);
  }
  if (plan.cheap === 'session') {
    return withReconciled(okResponse(await createAuthSession(request, env, now)), false);
  }
  if (plan.cheap === 'health') {
    const db = await store.dbPing(env);
    const dataSource = (env.DATA_SOURCE ?? 'demo') === 'chain' ? 'chain' : 'demo';
    // B6：health 额外读一次 kv，把「缺少链上配置键」也作为 oracle.paused 原因暴露（仍 200）
    const healthError = dataSource === 'chain' ? chainConfigError(env, await store.getKeyValues(env)) : chainError;
    return withReconciled(okResponse(views.buildHealth(env, db, dataSource, healthError)), false);
  }
  if (plan.cheap === 'version') {
    const dataSource = (env.DATA_SOURCE ?? 'demo') === 'chain' ? 'chain' : 'demo';
    return withReconciled(okResponse(views.buildVersionInfo(env, dataSource)), false);
  }

  // ⑤ 只有确实要返回协议数据的路径才 reconcile
  const ttl = cacheTtlMs(env);
  const cacheKey = url.pathname + url.search;
  if (plan.cacheable) {
    const hit = cacheGet(cacheKey, now, ttl);
    if (hit) return withReconciled(cachedResponse(hit), false);
  }

  const st = await state.reconcile(env);
  if (st.changed) bustCache();

  // B6：chain 模式关键链上配置缺失 → 禁止回退本地常量对外服务（cron 仍会跑索引器把配置写入 kv）。
  // H-8：/api/admin/indexer/tick|reconcile 是「运维救援入口」，必须豁免——干净库首启时这些配置键
  // 只有索引器自己会写，否则会死锁（admin 手动 tick 永远被 503 挡住）。鉴权/限流已在前面完成。
  if (st.params.dataSource === 'chain') {
    const isIndexerOps = url.pathname.startsWith('/api/admin/indexer/');
    const configError = chainConfigError(env, st.kv);
    if (configError && !isIndexerOps) {
      return withReconciled(apiErrorResponse(oraclePaused(configError)), false);
    }
  }

  const response = await route(request, env, url, method, st);

  if (plan.cacheable && ttl > 0) {
    const body = await response.clone().text();
    cacheSet(cacheKey, response.status, body, Date.now());
  }
  if (method !== 'GET' && method !== 'OPTIONS') bustCache();
  return withReconciled(response, true);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    markIsolateStarted();
    const started = Date.now();
    let response: Response;
    try {
      const url = new URL(request.url);
      const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
      // v11 social layer (docs/35 §4): /api/social/*, /s/:code, /og/:code.png — already finalized.
      const social = await handleSocialRequest(request, env, ctx);
      if (social) {
        logRequest(request, social.status, started);
        return social;
      }
      // v11 军饷 admin: build the cumulative payout list / (re)compute one round's rows
      if (request.method.toUpperCase() === 'POST' && url.pathname === '/api/admin/payout/build') {
        const r = finalizeResponse(await handleAdminPayoutBuild(request, env, Date.now()), env, request);
        logRequest(request, r.status, started);
        return r;
      }
      if (request.method.toUpperCase() === 'POST' && url.pathname === '/api/admin/junxiang/compute') {
        requireAdmin(request, env);
        const roundId = Number(url.searchParams.get('round'));
        if (!Number.isInteger(roundId) || roundId < 1 || roundId > 10) throw new ApiError('BAD_REQUEST', 'round 必须是 1..10');
        const rows = await computeRoundJunxiang(env as never, roundId, Date.now());
        const r = finalizeResponse(okResponse({ roundId, rows: rows.length }), env, request);
        logRequest(request, r.status, started);
        return r;
      }
      if (url.pathname === '/api/tg/webhook' && request.method.toUpperCase() === 'POST') {
        const tg = await handleTelegramWebhook(request, env, { gateSource: () => loadGateForBot(env) });
        logRequest(request, tg.status, started);
        return tg;
      }
      if (!isApi) {
        // FIX-7：静态 GET 也有内存级 IP 限流（不写 D1）
        if (memoryLimitExceeded(env, request, 'static', Date.now())) {
          response = apiErrorResponse(new ApiError('RATE_LIMITED', '请求过于频繁，请稍后重试'));
        } else {
          // 非 /api：交给 ASSETS（not_found_handling=single-page-application 负责 SPA 回退）。
          response = await env.ASSETS.fetch(request);
        }
      } else if (request.method.toUpperCase() === 'OPTIONS') {
        response = withReconciled(preflightResponse(), false);
      } else {
        response = await handleApi(request, env, url);
      }
    } catch (error) {
      if (!(error instanceof ApiError)) {
        console.error('[fetch] unhandled', error instanceof Error ? (error.stack ?? error.message) : String(error));
      }
      response = apiErrorResponse(error);
      try {
        const path = new URL(request.url).pathname;
        if (path === '/api' || path.startsWith('/api/')) response = withReconciled(response, false);
      } catch {
        /* ignore */
      }
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
          // v11: every 6h during 攻城, each squad group gets a ranking digest (bot no-ops otherwise)
          try {
            const d = new Date();
            if (d.getUTCMinutes() === 0 && d.getUTCHours() % 6 === 0) {
              const gate = await loadGateForBot(env);
              if (gate) await pushSquadDigest(env, gate);
            }
          } catch (e) {
            console.error('[bot] digest failed', e instanceof Error ? e.message : String(e));
          }
          // v11 军饷：周一 00:00 UTC 构建一次累计清单（D1 去重；只记账不上链，见 social/auto.ts）。永不抛出。
          await runWeeklyPayoutBuild(env as never, Date.now());
          const auto = await state.autoplay(env);
          const st = await state.reconcile(env);
          await state.refreshDemoMarket(env, st);

          // H-4：chain 模式 cron 驱动索引器（tick 永不抛出；cron 任何异常都必须被吞掉并记审计）
          if (st.params.dataSource === 'chain') {
            const cfgError = chainConfigError(env);
            if (cfgError) {
              try {
                await store.logEvent(env, 'warn', 'indexer', 'INDEXER_SKIPPED', cfgError);
              } catch {
                /* 审计写失败也不能让 cron 抛错 */
              }
            } else {
              try {
                const result = await indexerTick(env, st.now, { waitUntil: ctx.waitUntil.bind(ctx) });
                if (!result.ok) {
                  try {
                    await store.logEvent(
                      env,
                      'warn',
                      'indexer',
                      'INDEXER_TICK_WARN',
                      JSON.stringify({
                        skipped: result.skipped ?? null,
                        error: result.error ?? null,
                        pages: result.pages,
                        writes: result.writes,
                      }).slice(0, 240),
                    );
                  } catch {
                    /* ignore */
                  }
                }
              } catch (error) {
                try {
                  await store.logEvent(
                    env,
                    'error',
                    'indexer',
                    'INDEXER_CRON_ERROR',
                    (error instanceof Error ? error.message : String(error)).slice(0, 240),
                  );
                } catch {
                  /* ignore */
                }
              }
            }
          }

          const now = Date.now();
          await Promise.all([
            store.pruneRateLimit(env, now - 10 * 60 * 1000),
            store.pruneAuthNonces(env, now - 60 * 60 * 1000),
          ]);
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
