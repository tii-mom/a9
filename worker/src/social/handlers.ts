/**
 * 社交层 JSON 接口实现：/api/social/me、bind、squads、squads/:code/join、leaderboard、gate。
 * 写接口统一走 requireWriteAuth（TON Proof；demo 可用 DEMO_ALLOW_UNSIGNED_WRITES 放行）。
 */
import type {
  SocialBindResponse,
  SocialGateResponse,
  SocialLeaderboardResponse,
  SocialLeaderboardRow,
  SocialLeaderboardScope,
  SocialLeaderboardType,
  SocialMeResponse,
  SocialSquadBrief,
  SocialSquadDetail,
  SocialSquadResponse,
  SocialSource,
} from '@shared/types';
import { ApiError, okResponse, badRequest, conflict, notFound, optionalString, parseAddress, parseRoundId, readJsonBody, requireString, unauthorized } from '../http';
import { enforceRateLimit, requireWriteAuth } from '../tonproof';
import { toBigInt } from '../util';
import { isInviteCode, inviteCodeOf, isSquadCode, maskWallet, seasonOfRound, type SocialEnv } from './common';
import {
  ensureUser,
  getSquad,
  getSquadByTgChat,
  getUser,
  getUserByInvite,
  insertSquad,
  isUniqueViolation,
  setUserReferrer,
  setUserSquad,
  setUserTg,
  type SquadRow,
  type UserRow,
} from './db';
import { phaseOf, remainingUsd } from './gate';
import { medalsOf, rankOf, streakOf } from './power';
import { addressKey, currentSeason, loadSnapshot, powerOverRounds, powerTable, squadStakersIn, type Snapshot } from './snapshot';
import { newSquadCode, squadProgress, squadSwitchVerdict } from './squad';
import { poolUsdt } from './pool';
import { verifyTgInitData } from './initdata';

/* ------------------------------------------------------------------ *
 * 通用
 * ------------------------------------------------------------------ */

function parseSource(value: unknown): SocialSource {
  if (value === 'tg' || value === 'x' || value === 'web') return value;
  throw badRequest('字段 source 必须是 tg | x | web');
}

/** 数字 ID：tgUserId 为正整数；tgChatId 允许负数（群 ID）。 */
function parseDigitsId(value: string | null, key: string, allowNegative = false): string | null {
  if (value === null) return null;
  const pattern = allowNegative ? /^-?\d{1,20}$/ : /^\d{1,20}$/;
  if (!pattern.test(value)) throw badRequest(`字段 ${key} 格式不合法`);
  return value;
}

function squadBriefOf(snap: Snapshot, squad: SquadRow, roundId: number | null): SocialSquadBrief {
  const progress = squadProgress(squadStakersIn(snap, squad.code, roundId));
  return {
    code: squad.code,
    name: squad.name,
    level: progress.level,
    memberCount: snap.memberCount.get(squad.code) ?? 0,
    stakersThisRound: progress.stakersThisRound,
    nextLevel: progress.nextLevel,
    remainingToNext: progress.remainingToNext,
  };
}

function squadDetailOf(snap: Snapshot, squad: SquadRow, roundId: number | null): SocialSquadDetail {
  return {
    ...squadBriefOf(snap, squad, roundId),
    leaderWallet: squad.leader_wallet,
    tgChatId: squad.tg_chat_id,
  };
}

/** 战队码 → 战队；用户所在战队（无则 null）。 */
function userSquad(snap: Snapshot, user: UserRow | undefined): SquadRow | null {
  if (!user?.squad_code) return null;
  return snap.squadsByCode.get(user.squad_code) ?? null;
}

function buildMe(snap: Snapshot, wallet: string, user: UserRow | undefined, inviteCode: string): SocialMeResponse {
  const key = addressKey(snap.chain, wallet);
  const focusId = snap.focus?.round_id ?? null;
  const power = focusId !== null ? (powerTable(snap, focusId).get(key) ?? 0n) : 0n;
  const recruits = snap.recruitsByKey.get(key) ?? [];
  const staked = snap.keyRounds.get(key) ?? new Set<number>();
  const squad = userSquad(snap, user);
  return {
    wallet,
    inviteCode,
    referrer: user?.referrer_wallet ?? null,
    squad: squad ? squadBriefOf(snap, squad, focusId) : null,
    stats: {
      power: power.toString(),
      recruits: recruits.length,
      recruitsFromX: recruits.filter((row) => row.ref_source === 'x').length,
      medals: medalsOf(staked, snap.failedRounds),
      streak: streakOf(staked, snap.latestRoundId),
    },
  };
}

/* ------------------------------------------------------------------ *
 * GET /api/social/me?wallet=
 * ------------------------------------------------------------------ */

export async function handleMe(env: SocialEnv, url: URL, now: number): Promise<Response> {
  const wallet = parseAddress(url.searchParams.get('wallet'), 'wallet');
  const snap = await loadSnapshot(env, now);
  const user = snap.usersByKey.get(addressKey(snap.chain, wallet));
  // 未建档用户：邀请码按同一算法现算（只读，不写库）；建档时会沿用同一码
  const inviteCode = user?.invite_code ?? (await inviteCodeOf(wallet));
  const body: SocialMeResponse = buildMe(snap, wallet, user, inviteCode);
  return okResponse(body);
}

/* ------------------------------------------------------------------ *
 * POST /api/social/bind {wallet, referralCode?, squadCode?, source, tgInitData?}
 * 邀请人 / 战队均为「首次绑定生效」；业务规则拒绝不返回错误，写入 rejected 字段。
 * Telegram 身份只来自服务端校验过的 tgInitData；请求体里的 tgUserId 已废弃，直接忽略。
 * ------------------------------------------------------------------ */

/** 校验 Telegram initData 并返回 user.id；校验失败 401，未配置 bot token 500。 */
async function tgUserIdFromInitData(env: SocialEnv, initData: string, now: number): Promise<string> {
  if (!env.TG_BOT_TOKEN) throw new ApiError('INTERNAL', 'Telegram 校验未配置');
  const check = await verifyTgInitData(initData, env.TG_BOT_TOKEN, Math.floor(now / 1000));
  if (!check.ok) {
    console.warn('[social] initData rejected', check.reason);
    throw unauthorized('Telegram 身份校验失败');
  }
  return check.tgUserId;
}

type ReferralCheck = { ok: true; referrer: UserRow } | { ok: false; reason: string };

async function checkReferral(env: SocialEnv, wallet: string, code: string): Promise<ReferralCheck> {
  const referrer = await getUserByInvite(env, code);
  if (!referrer) return { ok: false, reason: 'unknown' };
  if (referrer.wallet === wallet) return { ok: false, reason: 'self' };
  // 不允许成环（含 A↔B 互相邀请）：沿邀请人链向上走，遇到自己即拒绝
  let cursor: UserRow | null = referrer;
  for (let depth = 0; cursor && cursor.referrer_wallet && depth < 32; depth++) {
    if (cursor.referrer_wallet === wallet) return { ok: false, reason: 'cycle' };
    cursor = await getUser(env, cursor.referrer_wallet);
  }
  return { ok: true, referrer };
}

type SquadJoin = { ok: true; changed: boolean; squad: SquadRow } | { ok: false; reason: string; missing: boolean };

async function joinSquadFor(
  env: SocialEnv,
  wallet: string,
  code: string,
  season: number,
  now: number,
): Promise<SquadJoin> {
  const squad = await getSquad(env, code);
  if (!squad) return { ok: false, reason: '战队不存在', missing: true };
  const user = await ensureUser(env, wallet, now);
  const current = user.squad_code ? await getSquad(env, user.squad_code) : null;
  const verdict = squadSwitchVerdict({
    currentSquadCode: user.squad_code,
    isLeaderOfCurrent: !!current && current.leader_wallet === wallet,
    squadChangedSeason: user.squad_changed_season,
    season,
    targetCode: code,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason, missing: false };
  if (verdict.noop) return { ok: true, changed: false, squad };
  await setUserSquad(env, wallet, code, verdict.markSeason ? season : null);
  return { ok: true, changed: true, squad };
}

export async function handleBind(request: Request, env: SocialEnv, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  const wallet = parseAddress(body.wallet, 'wallet');
  await requireWriteAuth(env, request, body, wallet, now);
  await enforceRateLimit(env, request, 'social-bind', now);

  const source = parseSource(body.source);
  // 注意：不读取 body.tgUserId（客户端不可信）
  const tgInitData = optionalString(body, 'tgInitData', 8192);
  const tgUserId = tgInitData === null ? null : await tgUserIdFromInitData(env, tgInitData, now);
  const referralCode = optionalString(body, 'referralCode', 16)?.toUpperCase() ?? null;
  const squadCode = optionalString(body, 'squadCode', 16)?.toUpperCase() ?? null;
  if (squadCode !== null && !isSquadCode(squadCode)) throw badRequest('战队码格式不合法');

  const user = await ensureUser(env, wallet, now);

  if (tgUserId !== null && user.tg_user_id !== tgUserId) {
    if (user.tg_user_id) throw conflict('该钱包已绑定其它 Telegram 账号');
    if (!(await setUserTg(env, wallet, tgUserId))) throw conflict('该 Telegram 账号已绑定其它钱包');
  }

  let referrerBound = false;
  let referralRejected: string | null = null;
  if (referralCode !== null && !user.referrer_wallet) {
    if (!isInviteCode(referralCode)) {
      referralRejected = 'unknown';
    } else {
      const check = await checkReferral(env, wallet, referralCode);
      if (check.ok) referrerBound = await setUserReferrer(env, wallet, check.referrer.wallet, source);
      else referralRejected = check.reason;
    }
  }

  let squadBound = false;
  let squadRejected: string | null = null;
  if (squadCode !== null) {
    const season = seasonOfRound(Math.max(1, await currentSeason(env)));
    const joined = await joinSquadFor(env, wallet, squadCode, season, now);
    if (joined.ok) squadBound = joined.changed;
    else squadRejected = joined.reason;
  }

  const snap = await loadSnapshot(env, now);
  const fresh = snap.usersByKey.get(addressKey(snap.chain, wallet));
  const inviteCode = fresh?.invite_code ?? user.invite_code;
  const me = buildMe(snap, wallet, fresh, inviteCode);
  const response: SocialBindResponse = {
    wallet,
    inviteCode,
    referrer: me.referrer,
    refSource: fresh?.ref_source ?? null,
    squad: me.squad,
    bound: { referrer: referrerBound, squad: squadBound },
    rejected: { referral: referralRejected, squad: squadRejected },
  };
  return okResponse(response);
}

/* ------------------------------------------------------------------ *
 * POST /api/social/squads {wallet, name, tgChatId?}
 * POST /api/social/squads/:code/join {wallet}
 * ------------------------------------------------------------------ */

export async function handleCreateSquad(request: Request, env: SocialEnv, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  const wallet = parseAddress(body.wallet, 'wallet');
  await requireWriteAuth(env, request, body, wallet, now);
  await enforceRateLimit(env, request, 'social-squad', now);

  const name = requireString(body, 'name', 24);
  const tgChatId = parseDigitsId(optionalString(body, 'tgChatId', 24), 'tgChatId', true);
  const season = seasonOfRound(Math.max(1, await currentSeason(env)));

  const user = await ensureUser(env, wallet, now);
  const current = user.squad_code ? await getSquad(env, user.squad_code) : null;
  // 目标战队尚不存在：用占位码走同一套换队规则（只看「能否离开当前战队」）
  const verdict = squadSwitchVerdict({
    currentSquadCode: user.squad_code,
    isLeaderOfCurrent: !!current && current.leader_wallet === wallet,
    squadChangedSeason: user.squad_changed_season,
    season,
    targetCode: '',
  });
  if (!verdict.ok) throw conflict(verdict.reason);

  if (tgChatId !== null && (await getSquadByTgChat(env, tgChatId))) throw conflict('该群已登记战队');

  let code = newSquadCode();
  for (let attempt = 0; attempt < 5 && (await getSquad(env, code)); attempt++) code = newSquadCode();
  if (await getSquad(env, code)) throw new Error('social: 战队码生成失败');

  try {
    await insertSquad(env, { code, name, leader_wallet: wallet, tg_chat_id: tgChatId, season, created_at: now });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('该群已登记战队');
    throw err;
  }
  await setUserSquad(env, wallet, code, verdict.markSeason ? season : null);

  const snap = await loadSnapshot(env, now);
  const squad = snap.squadsByCode.get(code);
  if (!squad) throw new Error('social: 战队写入后读取失败');
  const response: SocialSquadResponse = { squad: squadDetailOf(snap, squad, snap.focus?.round_id ?? null), changed: true };
  return okResponse(response);
}

export async function handleJoinSquad(request: Request, env: SocialEnv, code: string, now: number): Promise<Response> {
  if (!isSquadCode(code)) throw notFound('战队不存在');
  const body = await readJsonBody(request);
  const wallet = parseAddress(body.wallet, 'wallet');
  await requireWriteAuth(env, request, body, wallet, now);
  await enforceRateLimit(env, request, 'social-squad', now);

  const season = seasonOfRound(Math.max(1, await currentSeason(env)));
  const joined = await joinSquadFor(env, wallet, code, season, now);
  if (!joined.ok) {
    if (joined.missing) throw notFound(joined.reason);
    throw conflict(joined.reason);
  }
  const snap = await loadSnapshot(env, now);
  const squad = snap.squadsByCode.get(code);
  if (!squad) throw notFound('战队不存在');
  const response: SocialSquadResponse = { squad: squadDetailOf(snap, squad, snap.focus?.round_id ?? null), changed: joined.changed };
  return okResponse(response);
}

/* ------------------------------------------------------------------ *
 * GET /api/social/leaderboard?type=squad|power|recruit&scope=round|season&round=N
 * ------------------------------------------------------------------ */

const LEADERBOARD_LIMIT = 100;

function parseLeaderboardType(value: string | null): SocialLeaderboardType {
  if (value === 'squad' || value === 'power' || value === 'recruit') return value;
  throw badRequest('type 必须是 squad | power | recruit');
}

function parseLeaderboardScope(value: string | null): SocialLeaderboardScope {
  if (value === null || value === '' || value === 'round') return 'round';
  if (value === 'season') return 'season';
  throw badRequest('scope 必须是 round | season');
}

function rankRows(entries: Array<{ key: string; name: string | null; score: bigint }>): SocialLeaderboardRow[] {
  return entries
    .filter((entry) => entry.score > 0n)
    .sort((a, b) => (a.score === b.score ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.score > b.score ? -1 : 1))
    .slice(0, LEADERBOARD_LIMIT)
    .map((entry, index) => ({ rank: index + 1, key: entry.key, name: entry.name, score: entry.score.toString() }));
}

export async function handleLeaderboard(env: SocialEnv, url: URL, now: number): Promise<Response> {
  const type = parseLeaderboardType(url.searchParams.get('type'));
  const scope = parseLeaderboardScope(url.searchParams.get('scope'));
  const snap = await loadSnapshot(env, now);

  const roundParam = url.searchParams.get('round');
  let roundId: number | null = snap.focus?.round_id ?? null;
  if (roundParam !== null && roundParam !== '') {
    roundId = parseRoundId(roundParam);
    if (!snap.rounds.some((row) => row.round_id === roundId)) throw notFound('轮次不存在');
  }

  const season = seasonOfRound(roundId ?? 1);
  const scopeRounds: number[] =
    scope === 'round'
      ? roundId !== null
        ? [roundId]
        : []
      : snap.rounds
          .filter((row) => row.state !== 'UNOPENED' && seasonOfRound(row.round_id) === season)
          .map((row) => row.round_id);

  let rows: SocialLeaderboardRow[];
  if (type === 'power') {
    const totals = powerOverRounds(snap, scopeRounds);
    rows = rankRows(
      [...totals].map(([key, score]) => ({
        key: maskWallet(snap.usersByKey.get(key)?.wallet ?? key),
        name: null,
        score,
      })),
    );
  } else if (type === 'recruit') {
    const scopeSet = new Set(scopeRounds);
    const entries: Array<{ key: string; name: string | null; score: bigint }> = [];
    for (const [referrerKey, referees] of snap.recruitsByKey) {
      let score = 0n;
      for (const referee of referees) {
        const staked = snap.keyRounds.get(addressKey(snap.chain, referee.wallet)) ?? new Set<number>();
        if (![...staked].some((roundNo) => scopeSet.has(roundNo))) continue;
        score += referee.ref_source === 'x' ? 2n : 1n;
      }
      entries.push({ key: maskWallet(snap.usersByKey.get(referrerKey)?.wallet ?? referrerKey), name: null, score });
    }
    rows = rankRows(entries);
  } else {
    const totals = powerOverRounds(snap, scopeRounds);
    const entries: Array<{ key: string; name: string | null; score: bigint }> = [];
    for (const squad of snap.squads) {
      let score = 0n;
      for (const user of snap.users) {
        if (user.squad_code !== squad.code) continue;
        score += totals.get(addressKey(snap.chain, user.wallet)) ?? 0n;
      }
      entries.push({ key: squad.code, name: squad.name, score });
    }
    rows = rankRows(entries);
  }

  const body: SocialLeaderboardResponse = { type, scope, roundId, season, rows };
  return okResponse(body);
}

/* ------------------------------------------------------------------ *
 * GET /api/social/gate
 * ------------------------------------------------------------------ */

/** 链上 USD_E8 → USD；0 / 缺失 → null。 */
function usdFromE8(value: string | null | undefined): number | null {
  const raw = toBigInt(value ?? null);
  if (raw <= 0n) return null;
  return Number(raw) / 1e8;
}

function toUnixSeconds(ms: number | null | undefined): number | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export async function buildGate(env: SocialEnv, now: number): Promise<SocialGateResponse> {
  const snap = await loadSnapshot(env, now);
  const pool = env.STONFI_POOL_ADDRESS ? await poolUsdt(env.STONFI_POOL_ADDRESS, now) : null;
  const focus = snap.focus;
  if (!focus) {
    return {
      roundId: null,
      phase: 'preview',
      gatePriceUsd: null,
      priceUsd: null,
      poolUsdt: pool,
      remainingUsd: null,
      litCandles: 0,
      candlesSeen: 0,
      rewardBudgetRaw: '0',
      stakeCount: 0,
      phaseEndsAt: null,
    };
  }
  const gatePriceUsd = usdFromE8(focus.target_price_usd_e8);
  const priceUsd = usdFromE8(focus.last_candle_twap_usd_e8);
  const remaining =
    pool !== null && gatePriceUsd !== null && priceUsd !== null ? remainingUsd(pool, gatePriceUsd, priceUsd) : null;
  const phase = phaseOf(focus.state);
  const phaseEndsAt =
    phase === 'preview'
      ? toUnixSeconds(focus.stake_open_at)
      : phase === 'staking'
        ? toUnixSeconds(focus.stake_close_at)
        : phase === 'observing'
          ? toUnixSeconds(focus.observation_end)
          : null;
  return {
    roundId: focus.round_id,
    phase,
    gatePriceUsd,
    priceUsd,
    poolUsdt: pool,
    remainingUsd: remaining,
    litCandles: focus.qualified_candles,
    candlesSeen: focus.candles_seen,
    rewardBudgetRaw: focus.reward_budget_raw,
    stakeCount: snap.byRound.get(focus.round_id)?.size ?? 0,
    phaseEndsAt,
  };
}

export async function handleGate(env: SocialEnv, now: number): Promise<Response> {
  return okResponse(await buildGate(env, now));
}

/* ------------------------------------------------------------------ *
 * 分享页用：某邀请码的分享人信息（战力排名，未上车为 null）
 * ------------------------------------------------------------------ */

export async function sharerRank(env: SocialEnv, code: string, now: number): Promise<{ found: boolean; rank: number | null }> {
  const snap = await loadSnapshot(env, now);
  const owner = snap.users.find((row) => row.invite_code === code);
  if (!owner || snap.focus === null) return { found: !!owner, rank: null };
  const powers = powerTable(snap, snap.focus.round_id);
  return { found: true, rank: rankOf(powers, addressKey(snap.chain, owner.wallet)) };
}
