import type { Candle, ProtocolConfig, RoundDetail, RoundState, RoundSummary } from '@shared/types';
import { pad2 } from '../../lib/format';

/** Round states where the round is live (the round board should focus it). */
const ACTIVE_STATES: RoundState[] = [
  'STAKING_OPEN',
  'STAKING_CLOSED',
  'OBSERVING',
  'ORACLE_PAUSED',
  'SETTLING_SUCCESS',
  'SETTLING_FAILURE',
];

export type Phase = 'stake' | 'observe' | 'settling' | 'done' | 'paused' | 'unopened';

export function pickFocus(rounds: RoundSummary[] | null | undefined): RoundSummary | null {
  if (!rounds || rounds.length === 0) return null;
  const ordered = [...rounds].sort((a, b) => b.roundId - a.roundId);
  const active = ordered.find((r) => ACTIVE_STATES.includes(r.state));
  if (active) return active;
  return ordered.find((r) => r.state !== 'UNOPENED') ?? ordered[ordered.length - 1] ?? null;
}

export function phaseOf(state: RoundState | null | undefined): Phase {
  switch (state) {
    case 'STAKING_OPEN':
    case 'STAKING_CLOSED':
      return 'stake';
    case 'OBSERVING':
      return 'observe';
    case 'ORACLE_PAUSED':
      return 'paused';
    case 'SETTLING_SUCCESS':
    case 'SETTLING_FAILURE':
      return 'settling';
    case 'SUCCEEDED':
    case 'FAILED_PERMANENT':
    case 'TECHNICAL_ABORTED':
      return 'done';
    case 'UNOPENED':
    default:
      return 'unopened';
  }
}

/**
 * 目标价档位由 API 提供（D-28：tier = 1 + 已成功轮数，失败不升档）。
 * 前端禁止用 roundId 推导 2^n：R2 失败后 R3 仍是 4×P0，只有成功才升档。
 */
export function roundById(rounds: RoundSummary[] | null | undefined, roundId: number | null): RoundSummary | null {
  if (!rounds || roundId === null) return null;
  return rounds.find((round) => round.roundId === roundId) ?? null;
}

export interface BoardView {
  phase: Phase;
  state: RoundState | null;
  roundId: number | null;
  cfgRoundCount: number;
  candleCount: number;
  need: number;
  missAllowance: number;
  failAt: number;
  targetUsdE8: string | null;
  /** 本轮档位倍数（API 的 priceMultiplier = 2^tier，禁止前端自行推导） */
  priceMultiplier: number | null;
  /** 下一轮（用于结算卡片的「下一轮目标」展示） */
  nextRoundId: number | null;
  nextTargetUsdE8: string | null;
  nextPriceMultiplier: number | null;
  priceUsdE8: string | null;
  candles: Candle[];
  hits: number;
  miss: number;
  done: number;
  remain: number;
  live: boolean;
  liveTwapUsdE8: string | null;
  liveProgress: number;
  tentativeHit: boolean;
  result: 'win' | 'lose' | 'abort' | null;
  secondsRemaining: number | null;
  stakeCloseAt: number | null;
  observationStart: number | null;
  observationEnd: number | null;
  totalStakeRaw: string;
  totalWeightRaw: string;
  stakerCount: number;
  rewardBudgetRaw: string;
  burnedRaw: string | null;
  updatedAt: number;
}

export function deriveBoard(
  cfg: ProtocolConfig | null,
  focus: RoundSummary | null,
  detail: RoundDetail | null,
  rounds: RoundSummary[] | null | undefined = null,
): BoardView {
  // A previous round's response must never override the newly selected round.
  detail = detail?.roundId === focus?.roundId ? detail : null;
  const state = detail?.state ?? focus?.state ?? null;
  const phase = phaseOf(state);
  const roundId = detail?.roundId ?? focus?.roundId ?? null;
  const candleCount = cfg?.candleCount ?? 24;
  const need = cfg?.minQualifiedCandles ?? 16;
  const missAllowance = Math.max(0, candleCount - need);
  const failAt = missAllowance + 1;
  const candles = detail?.candles ?? [];
  const hits = candles.filter((c) => c.qualified).length;
  const done = candles.length;
  const miss = done - hits;
  const live = phase === 'observe' && !!detail?.live;
  const liveProgress = detail?.live ? Math.min(1, Math.max(0, detail.live.progressBps / 10000)) : 0;
  const tentativeHit = !!detail?.live?.qualifiedTentative;
  const targetUsdE8 = detail?.targetPriceUsdE8 ?? focus?.targetPriceUsdE8 ?? null;
  const priceMultiplier = detail?.priceMultiplier ?? focus?.priceMultiplier ?? null;
  const nextRoundId = roundId !== null && (!cfg || roundId < cfg.roundCount) ? roundId + 1 : null;
  const nextRound = roundById(rounds, nextRoundId);
  const priceUsdE8 = detail?.priceUsdE8 ?? null;
  const result: BoardView['result'] =
    state === 'SUCCEEDED'
      ? 'win'
      : state === 'FAILED_PERMANENT'
        ? 'lose'
        : state === 'TECHNICAL_ABORTED'
          ? 'abort'
          : null;
  const totalStakeRaw = detail?.totalAcceptedStakeRaw ?? focus?.totalAcceptedStakeRaw ?? '0';
  return {
    phase,
    state,
    roundId,
    cfgRoundCount: cfg?.roundCount ?? 10,
    candleCount,
    need,
    missAllowance,
    failAt,
    targetUsdE8,
    priceMultiplier,
    nextRoundId,
    nextTargetUsdE8: nextRound?.targetPriceUsdE8 ?? null,
    nextPriceMultiplier: nextRound?.priceMultiplier ?? null,
    priceUsdE8,
    candles,
    hits,
    miss,
    done,
    remain: Math.max(0, candleCount - done),
    live,
    liveTwapUsdE8: detail?.live?.twapPriceUsdE8 ?? null,
    liveProgress,
    tentativeHit,
    result,
    secondsRemaining: detail?.secondsRemaining ?? null,
    stakeCloseAt: detail?.stakeCloseAt ?? focus?.stakeCloseAt ?? null,
    observationStart: detail?.observationStart ?? focus?.observationStart ?? null,
    observationEnd: detail?.observationEnd ?? focus?.observationEnd ?? null,
    totalStakeRaw,
    totalWeightRaw: detail?.totalWeightRaw ?? focus?.totalWeightRaw ?? '0',
    stakerCount: detail?.stakerCount ?? focus?.stakerCount ?? 0,
    rewardBudgetRaw: detail?.rewardBudgetRaw ?? focus?.rewardBudgetRaw ?? cfg?.roundRewardRaw ?? '0',
    burnedRaw: detail?.burnedRaw ?? focus?.burnedRaw ?? null,
    updatedAt: detail?.updatedAt ?? focus?.updatedAt ?? 0,
  };
}

export type LadderLetter = 'S' | 'F' | 'O' | 'K' | 'U' | 'P' | 'A';

export function ladderLetter(state: RoundState | null | undefined): LadderLetter {
  switch (state) {
    case 'SUCCEEDED':
      return 'S';
    case 'SETTLING_SUCCESS':
    case 'SETTLING_FAILURE':
      return 'P';
    case 'FAILED_PERMANENT':
      return 'F';
    case 'TECHNICAL_ABORTED':
      return 'A';
    case 'OBSERVING':
    case 'ORACLE_PAUSED':
      return 'O';
    case 'STAKING_OPEN':
    case 'STAKING_CLOSED':
      return 'K';
    case 'UNOPENED':
    default:
      return 'U';
  }
}

/** UTC hour label for a candle column (e.g. "08:00"). */
export function candleHour(periodStart: number | null | undefined): string {
  if (!periodStart) return '';
  const d = new Date(periodStart);
  return pad2(d.getUTCHours()) + ':00';
}

export function fallbackCandleHour(index: number, phase: Phase): string {
  void index;
  void phase;
  return '';
}

/** mm:ss / hh:mm:ss countdown from a seconds value. */
export function clockText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return d + 'd ' + pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
}

/** Observation window remaining, as "hh:mm" plus fixed "/ 48:00" suffix handled by caller. */
export function observeClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return pad2(h) + ':' + pad2(m);
}
