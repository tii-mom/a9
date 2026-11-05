import type { Candle, ProtocolConfig, RoundDetail, RoundState, RoundSummary } from '@shared/types';
import { pad2 } from '../../lib/format';

/** Round states where the round is live (battle board should focus it). */
const ACTIVE_STATES: RoundState[] = [
  'STAKING_OPEN',
  'STAKING_CLOSED',
  'OBSERVING',
  'ORACLE_PAUSED',
  'SETTLING_SUCCESS',
  'SETTLING_FAILURE',
];

export type Phase = 'stake' | 'observe' | 'done' | 'paused' | 'unopened';

export function pickFocus(rounds: RoundSummary[] | null | undefined): RoundSummary | null {
  if (!rounds || rounds.length === 0) return null;
  const active = rounds.find((r) => ACTIVE_STATES.indexOf(r.state) >= 0);
  if (active) return active;
  const settled = rounds.filter(
    (r) => r.state === 'SUCCEEDED' || r.state === 'FAILED_PERMANENT' || r.state === 'TECHNICAL_ABORTED',
  );
  if (settled.length > 0) return settled[settled.length - 1];
  return rounds[rounds.length - 1] ?? null;
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
    case 'SUCCEEDED':
    case 'FAILED_PERMANENT':
    case 'TECHNICAL_ABORTED':
      return 'done';
    case 'UNOPENED':
    default:
      return 'unopened';
  }
}

export function targetFromConfig(cfg: ProtocolConfig | null, roundId: number | null): string | null {
  if (!cfg || roundId === null) return null;
  const p0 = Number(cfg.p0UsdE8);
  const mult = Number(cfg.priceMultiplier) || 2;
  if (!Number.isFinite(p0)) return null;
  const target = p0 * Math.pow(mult, roundId);
  if (!Number.isFinite(target)) return null;
  return String(Math.round(target));
}

export function priceMultiplierOf(cfg: ProtocolConfig | null, roundId: number | null): number | null {
  if (!cfg || roundId === null) return null;
  const mult = Number(cfg.priceMultiplier) || 2;
  const value = Math.pow(mult, roundId);
  return Number.isFinite(value) ? value : null;
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
  stakerCount: number;
  rewardBudgetRaw: string;
  burnedRaw: string | null;
  updatedAt: number;
}

export function deriveBoard(
  cfg: ProtocolConfig | null,
  focus: RoundSummary | null,
  detail: RoundDetail | null,
): BoardView {
  const state = detail?.state ?? focus?.state ?? null;
  const phase = phaseOf(state);
  const roundId = detail?.roundId ?? focus?.roundId ?? null;
  const candleCount = cfg?.candleCount ?? 18;
  const need = cfg?.minQualifiedCandles ?? 12;
  const missAllowance = Math.max(0, candleCount - need);
  const failAt = missAllowance + 1;
  const candles = detail?.candles ?? [];
  const hits = candles.filter((c) => c.qualified).length;
  const done = candles.length;
  const miss = done - hits;
  const live = phase === 'observe' && !!detail?.live;
  const liveProgress = detail?.live ? Math.min(1, Math.max(0, detail.live.progressBps / 10000)) : 0;
  const tentativeHit = !!detail?.live?.qualifiedTentative;
  const targetUsdE8 = detail?.targetPriceUsdE8 ?? focus?.targetPriceUsdE8 ?? targetFromConfig(cfg, roundId);
  const priceUsdE8 = detail?.priceUsdE8 ?? null;
  const result: BoardView['result'] =
    state === 'SUCCEEDED' || state === 'SETTLING_SUCCESS'
      ? 'win'
      : state === 'FAILED_PERMANENT' || state === 'SETTLING_FAILURE'
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
    stakerCount: detail?.stakerCount ?? focus?.stakerCount ?? 0,
    rewardBudgetRaw: detail?.rewardBudgetRaw ?? focus?.rewardBudgetRaw ?? cfg?.roundRewardRaw ?? '0',
    burnedRaw: detail?.burnedRaw ?? focus?.burnedRaw ?? null,
    updatedAt: detail?.updatedAt ?? focus?.updatedAt ?? 0,
  };
}

export type LadderLetter = 'S' | 'F' | 'O' | 'K' | 'U';

export function ladderLetter(state: RoundState | null | undefined): LadderLetter {
  switch (state) {
    case 'SUCCEEDED':
    case 'SETTLING_SUCCESS':
      return 'S';
    case 'FAILED_PERMANENT':
    case 'SETTLING_FAILURE':
    case 'TECHNICAL_ABORTED':
      return 'F';
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
  if (phase === 'stake' || phase === 'unopened') return pad2((8 + 4 * index) % 24) + ':00';
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
  if (d > 0) return d + '天 ' + pad2(h) + ':' + pad2(m) + ':' + pad2(s);
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
