/**
 * 猜灯（docs/35 §4.4，任务单 3）。
 *
 * 规则：本城有已接受质押的钱包，可在观察窗口开始前猜一次（0..24 的亮灯数）。
 * 本城结算后，亮灯数 = 轮次的 qualified_candles；猜中者平分 50 万 A9（猜灯线；连战饷取其余部分，见 junxiang.ts）。
 * 无人猜中则本线不发放（余额不结转）。
 *
 * HTTP：
 *   POST /api/social/guess {wallet, roundId, lit}   requireWriteAuth；一城一次，重复返回 409
 *   GET  /api/social/guess?wallet=&roundId=         返回 {roundId, wallet, lit, createdAt}，未猜为 lit=null
 */
import { badRequest, conflict, notFound, okResponse, parseAddress, parseRoundId, readJsonBody } from '../http';
import { enforceRateLimit, requireWriteAuth } from '../tonproof';
import { insertGuess, getGuess } from './db';
import type { JunxiangContribution } from './junxiang';
import { addressKey, loadSnapshot } from './snapshot';
import type { SocialEnv } from './common';

export const GUESS_LIT_MIN = 0;
export const GUESS_LIT_MAX = 24;
/** 猜灯线：50 万 A9（9 位小数）。 */
export const GUESS_POOL_RAW = 500_000n * 1_000_000_000n;

/** 校验亮灯数：整数 0..24（字符串数字也接受）。 */
export function parseLitGuess(value: unknown): number {
  const num = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isInteger(num) || num < GUESS_LIT_MIN || num > GUESS_LIT_MAX) {
    throw badRequest(`字段 lit 必须是 ${GUESS_LIT_MIN}..${GUESS_LIT_MAX} 的整数`);
  }
  return num;
}

/** 观察窗口开始前可猜；observationStartMs 为空（窗口未定）时不可猜。 */
export function guessOpen(nowMs: number, observationStartMs: number | null): boolean {
  return observationStartMs !== null && nowMs < observationStartMs;
}

/**
 * 猜灯行：亮灯数恰好等于 litActual 的钱包平分 poolRaw（向下取整，余数不发）。
 * 只有在本城已结算（litActual 有效）时才调用；guesses 的键与 junxiang 同口径。
 */
export function guessContributions(input: {
  roundId: number;
  litActual: number;
  guesses: ReadonlyArray<{ wallet: string; lit: number }>;
  poolRaw: bigint;
}): JunxiangContribution[] {
  const exact = input.guesses.filter((guess) => guess.lit === input.litActual).map((guess) => guess.wallet).sort();
  if (exact.length === 0 || input.poolRaw <= 0n) return [];
  const share = input.poolRaw / BigInt(exact.length);
  if (share <= 0n) return [];
  return exact.map((wallet) => ({ wallet, kind: 'guess', amountRaw: share, meta: `猜灯猜中 ${input.litActual} 盏` }));
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

export async function handlePostGuess(request: Request, env: SocialEnv, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  const wallet = parseAddress(body.wallet, 'wallet');
  await requireWriteAuth(env, request, body, wallet, now);
  await enforceRateLimit(env, request, 'social-guess', now);

  const roundId = parseRoundId(body.roundId);
  const lit = parseLitGuess(body.lit);
  const snap = await loadSnapshot(env, now);
  const round = snap.rounds.find((row) => row.round_id === roundId);
  if (!round) throw notFound('轮次不存在');

  const key = addressKey(snap.chain, wallet);
  if (!snap.byRound.get(roundId)?.has(key)) throw conflict('本城未报名，不能猜灯');
  const observationStart = round.observation_start ?? round.stake_close_at;
  if (!guessOpen(now, observationStart)) throw conflict('猜灯已关闭（观察窗口已开始）');

  const inserted = await insertGuess(env, { roundId, wallet: key, lit, now });
  if (!inserted) throw conflict('本城已猜过');
  return okResponse({ roundId, wallet, lit, createdAt: now });
}

export async function handleGetGuess(env: SocialEnv, url: URL): Promise<Response> {
  const wallet = parseAddress(url.searchParams.get('wallet'), 'wallet');
  const roundId = parseRoundId(url.searchParams.get('roundId'));
  const chain = (env.DATA_SOURCE ?? 'demo').trim() === 'chain';
  const row = await getGuess(env, roundId, addressKey(chain, wallet));
  return okResponse({ roundId, wallet, lit: row?.lit_guess ?? null, createdAt: row?.created_at ?? null });
}
