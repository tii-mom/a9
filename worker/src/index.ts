/**
 * A9 Worker 入口：/api/* 走 API，其余交给 ASSETS（web/dist，SPA 回退）。
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
import * as v8 from './v8';
import { clientIp, enforceRateLimit, issueAuthNonce, requireWriteAuth } from './tonproof';
import { notImplemented } from './http';
import { ownWeightFor, streakForRound } from './protocol';
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

/** P1-C：按 V8 权重（own weight + 邀请加成）/ 总权重 估算单地址奖励（旧数据兜底）。 */
function v8WeightReward(st: ReconcileResult, roundId: number, address: string): bigint {
  const round = st.rounds.find((row) => row.round_id === roundId);
  if (!round) return 0n;
  const stakes = st.stakeRows.filter((row) => row.round_id === roundId);
  if (!stakes.length) return 0n;
  const weights = v8.computeRoundWeights(st.params, stakes);
  const weight = weights.byAddress.get(address)?.weight ?? 0n;
  if (weights.totalWeight === 0n || weight === 0n) return 0n;
  return (toBigInt(round.reward_budget_raw) * weight) / weights.totalWeight;
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

  // V8：连续轮次与权重（streak = 上轮+1 / 同轮保持 / 否则重置 1）
  const myStakes = st.stakeRows.filter((row) => row.address === address);
  const lastRound = myStakes.reduce((max, row) => Math.max(max, row.round_id), 0);
  const lastStreak = myStakes
    .filter((row) => row.round_id === lastRound)
    .reduce((max, row) => Math.max(max, row.streak ?? 1), 0);
  const streak = streakForRound(lastRound, lastStreak, roundId);
  const weightRaw = ownWeightFor(amount, streak);

  // V8：邀请人绑定（一次性、不可改；demo 允许首次质押时通过 body.referrer 绑定）
  let referredBy: string | null = null;
  const bound = await store.getReferralOf(env, address);
  if (bound) {
    referredBy = bound.referrer;
  } else {
    const rawReferrer = optionalString(body, 'referrer');
    if (rawReferrer && rawReferrer !== address) {
      const referrer = parseAddress(rawReferrer, 'referrer');
      const back = await store.getReferralOf(env, referrer);
      if (back && back.referrer === address) throw conflict('禁止互相绑定邀请');
      const boundReferrer = await store.insertReferral(env, address, referrer, now);
      if (boundReferrer) {
        referredBy = referrer;
        await store.logEvent(env, 'info', address.slice(0, 12), 'REFERRER_SET', 'referrer=' + referrer);
      }
    }
  }

  const inserted = await store.insertStake(env, {
    roundId,
    address,
    amountRaw: amount,
    weightRaw,
    nonce,
    riskDisclosureVersion: riskVersion,
    acceptFullPrincipalBurn: true,
    acceptedAt: now,
    streak,
    referredBy,
  });
  if (!inserted) throw conflict('重复的 deposit nonce，本次质押已忽略');

  await store.refreshRoundStakeTotals(env, roundId, now);
  await store.logEvent(
    env,
    'info',
    `wallet:${address.slice(0, 8)}`,
    'STAKE_ACCEPTED',
    `R${roundId} + ${amount.toString()} raw（streak=${streak} weight=${weightRaw.toString()} referral=${referredBy ?? '-'}）`,
  );
  bustCache();
  return okResponse({
    accepted: true,
    position: { roundId, amountRaw: (alreadyStaked + amount).toString() },
  });
}

async function handleClaim(request: Request, env: Env, st: ReconcileResult): Promise<Response> {
  const body = await readJsonBody(request);
  if (st.params.dataSource === 'chain') {
    throw notImplemented('链上模式请直接与合约交互：/api/claim 仅用于演示数据源');
  }
  const address = parseAddress(body.address);
  // P1-A：领取同样需要 ton_proof（防替他人领取）
  await requireWriteAuth(env, request, body, address, st.now);
  const kind = requireString(body, 'kind');
  if (kind !== 'principal' && kind !== 'reward' && kind !== 'unlock') {
    throw badRequest('kind 必须是 principal / reward / unlock');
  }
  const roundsById = new Map(st.rounds.map((row) => [row.round_id, row]));

  // V8 ClaimUnlocked：R10 任一终态后按 12×30 天线性领取
  if (kind === 'unlock') {
    const unlock = await v8.buildUnlockInfo(env, st.params, st.rewardRows, roundsById, address, st.now);
    if (!unlock.active) throw conflict('解锁尚未开始：R10 终态后 12 个月线性解锁');
    const claimAmount = toBigInt(unlock.claimableRaw);
    if (claimAmount <= 0n) {
      return okResponse({ claimed: false, amountRaw: '0', alreadyClaimed: true });
    }
    const recordedUnlock = await store.recordClaim(env, {
      roundId: st.params.roundCount,
      address,
      kind: 'unlock',
      amountRaw: claimAmount,
      claimedAt: st.now,
    });
    if (!recordedUnlock) {
      const raced = await store.getClaim(env, st.params.roundCount, address, 'unlock');
      return okResponse({ claimed: false, amountRaw: raced?.amount_raw ?? '0', alreadyClaimed: true });
    }
    await store.updateUnlockPool(
      env,
      { claimedRaw: (toBigInt(st.unlockPool.claimed_raw) + claimAmount).toString() },
      st.now,
    );
    await store.logEvent(env, 'info', address.slice(0, 12), 'UNLOCK_CLAIMED', `${claimAmount.toString()} raw`);
    bustCache();
    return okResponse({ claimed: true, amountRaw: claimAmount.toString(), alreadyClaimed: false });
  }

  const roundId = parseRoundId(body.roundId);
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

  const amount = stakeRows.reduce((sum, row) => sum + toBigInt(row.amount_raw), 0n);
  let claimAmount = 0n;

  if (kind === 'principal') {
    claimAmount = stakeRows.reduce(
      (sum, row) => sum + (row.principal_claimed === 1 ? 0n : toBigInt(row.amount_raw)),
      0n,
    );
  } else {
    // V8：阶梯期奖励三态；旧 ClaimReward 按 EARLY 语义只付 50%，另一半进解锁池（无后门）
    const lastRound = st.rounds.find((row) => row.round_id === st.params.roundCount);
    const unlockStarted =
      !!lastRound &&
      (lastRound.state === 'SUCCEEDED' || lastRound.state === 'FAILED_PERMANENT' || lastRound.state === 'TECHNICAL_ABORTED') &&
      st.unlockPool.start_at > 0;
    if (unlockStarted) {
      throw conflict('R10 已终态、解锁已开始：请改用 ClaimUnlocked 线性领取（旧 ClaimReward 已关闭）');
    }
    const rewardRow = st.rewardRows.find((row) => row.round_id === roundId && row.address === address);
    if (rewardRow && rewardRow.state !== 0) {
      return okResponse({
        claimed: false,
        amountRaw: rewardRow.state === 2 ? rewardRow.paid_raw : '0',
        alreadyClaimed: true,
        state: rewardRow.state,
      });
    }
    // P1-C：无 rewardRow 的旧数据也按 V8 权重公式兜底（不再用本金比例）
    const reward = rewardRow
      ? toBigInt(rewardRow.reward_raw)
      : v8WeightReward(st, round.round_id, address);
    const paidBps = BigInt(10_000 - st.params.earlyClaimPenaltyBps);
    claimAmount = (reward * paidBps) / 10_000n;
    const lockedAmount = reward - claimAmount;
    if (claimAmount <= 0n) {
      return okResponse({ claimed: false, amountRaw: '0', alreadyClaimed: true });
    }
    if (rewardRow) {
      await store.updateRoundReward(env, {
        roundId,
        address,
        state: 2,
        paidRaw: claimAmount.toString(),
        lockedRaw: lockedAmount.toString(),
        now: st.now,
      });
    }
    await store.updateUnlockPool(
      env,
      { totalLockedRaw: (toBigInt(st.unlockPool.total_locked_raw) + lockedAmount).toString() },
      st.now,
    );
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
    address.slice(0, 12),
    kind === 'principal' ? 'PRINCIPAL_CLAIMED' : 'REWARD_EARLY_CLAIMED',
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

/** FIX-7：廉价路由分类（不触碰 DB）。null = 404（未知路径/方法）。 */
type D1Scope = 'admin' | 'stake' | 'claim' | 'nonce';

interface RoutePlan {
  requiresState: boolean;
  requiresAdmin: boolean;
  d1Scope: D1Scope | null;
  cacheable: boolean;
  cheap: 'none' | 'nonce' | 'health' | 'version';
  badRequestMessage?: string;
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

  if (parts[0] === 'referral' && parts.length === 2) {
    return isGet ? routePlan({}) : null;
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
      return isPost ? routePlan({ requiresAdmin: true, d1Scope: 'admin' }) : null;
    }
    if (parts.length === 3 && parts[1] === 'rounds' && parts[2] === 'advance') {
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

  if (parts[0] === 'referral' && parts.length === 2) {
    assertMethod(method, 'GET');
    const address = parseAddress(decodeURIComponent(parts[1]));
    return okResponse(await views.buildReferralResponse(env, st, address));
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
  if (plan.badRequestMessage) {
    return withReconciled(apiErrorResponse(badRequest(plan.badRequestMessage)), false);
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
  if (plan.cheap === 'health') {
    const db = await store.dbPing(env);
    const dataSource = (env.DATA_SOURCE ?? 'demo') === 'chain' ? 'chain' : 'demo';
    return withReconciled(okResponse(views.buildHealth(env, db, dataSource)), false);
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
          const auto = await state.autoplay(env);
          const st = await state.reconcile(env);
          await state.refreshDemoMarket(env, st);
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
