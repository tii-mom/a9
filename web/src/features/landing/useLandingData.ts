import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MeResponse, OrderBook, ProtocolConfig, ProtocolStats, RoundDetail, RoundSummary, Trade } from '@shared/types';
import { api, useQuery } from '../../lib/api';
import { deriveBoard, pickFocus } from './derive';
import { useLandingWallet, type LandingWallet } from './wallet';

export interface LandingData {
  wallet: LandingWallet;
  address: string | null;
  cfg: ProtocolConfig | null;
  stats: ProtocolStats | null;
  rounds: RoundSummary[];
  focus: RoundSummary | null;
  detail: RoundDetail | null;
  board: ReturnType<typeof deriveBoard>;
  trades: Trade[];
  book: OrderBook | null;
  me: MeResponse | null;
  /** Absolute deadline (ms) for the current staking or observation phase. Leaves tick it; this hook does not. */
  clockTargetMs: number | null;
  /** Absolute time (ms) when the next staking window opens. */
  nextStakeTargetMs: number | null;
  candleMs: number;
  loading: boolean;
  error: Error | null;
  updatedAt: number | null;
  stale: boolean;
  flowHealth: { trades: string; book: string; stats: string };
  refreshAll: () => void;
}

export function useLandingData(): LandingData {
  const wallet = useLandingWallet();
  const address = wallet.address;

  const configQ = useQuery<ProtocolConfig>(() => api.config(), [], { intervalMs: 60000 });
  const statsQ = useQuery<ProtocolStats>(() => api.stats(), [], { intervalMs: 3000 });
  const roundsQ = useQuery<RoundSummary[]>(() => api.rounds(), [], { intervalMs: 3000 });

  const focus = useMemo(() => pickFocus(roundsQ.data), [roundsQ.data]);
  const roundId = focus?.roundId ?? null;

  const detailQ = useQuery<RoundDetail | null>(
    () => (roundId === null ? Promise.resolve(null) : api.round(roundId)),
    [roundId],
    { intervalMs: 2000, enabled: roundId !== null },
  );
  const tradesQ = useQuery<Trade[]>(() => api.trades(16), [], { intervalMs: 2000 });
  const bookQ = useQuery<OrderBook>(() => api.book(), [], { intervalMs: 3000 });
  const meQ = useQuery<MeResponse | null>(
    () => (address ? api.me(address) : Promise.resolve(null)),
    [address],
    { intervalMs: 5000, enabled: !!address },
  );

  const board = useMemo(
    () => deriveBoard(configQ.data, focus, detailQ.data, roundsQ.data ?? []),
    [configQ.data, focus, detailQ.data, roundsQ.data],
  );

  // Coarse clock for freshness flags only (stale / feed health). The per-second countdown lives in leaf components.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const [detailAt, setDetailAt] = useState(0);
  useEffect(() => {
    if (detailQ.data) setDetailAt(Date.now());
  }, [detailQ.data]);

  /**
   * Convert server-relative remaining time to an absolute deadline once, so the countdown
   * does not need the page to re-render every second.
   */
  const clockTargetMs = useMemo(() => {
    // Staking window → absolute close timestamp.
    if (board.phase === 'stake' && board.stakeCloseAt) return board.stakeCloseAt;
    // Observation window → API observationEnd, fallback to server-relative secondsRemaining.
    if (board.phase === 'observe' && board.observationEnd) return board.observationEnd;
    if (board.secondsRemaining === null) return null;
    return (detailAt > 0 ? detailAt : Date.now()) + board.secondsRemaining * 1000;
  }, [board.phase, board.stakeCloseAt, board.observationEnd, board.secondsRemaining, detailAt]);

  /** Pre-announcement window → absolute opening time (stats.nextStakeOpenAt). */
  const nextStakeTargetMs = statsQ.data?.nextStakeOpenAt ?? null;

  /** Nominal spacing of the 4h candle grid, used for the printed hour labels (not the demo speed). */
  const candleMs = useMemo(() => {
    if (configQ.data?.candleSeconds) return configQ.data.candleSeconds * 1000;
    if (configQ.data?.observationSeconds) {
      return Math.round(configQ.data.observationSeconds / Math.max(1, configQ.data.candleCount)) * 1000;
    }
    return 4 * 3600 * 1000;
  }, [configQ.data]);

  const refreshAll = useCallback(() => {
    configQ.refresh();
    statsQ.refresh();
    roundsQ.refresh();
    detailQ.refresh();
    tradesQ.refresh();
    bookQ.refresh();
    meQ.refresh();
  }, [configQ.refresh, statsQ.refresh, roundsQ.refresh, detailQ.refresh, tradesQ.refresh, bookQ.refresh, meQ.refresh]);

  const error = configQ.error ?? statsQ.error ?? roundsQ.error ?? detailQ.error ?? tradesQ.error ?? bookQ.error ?? meQ.error ?? null;
  const loading = !configQ.data || !statsQ.data || !roundsQ.data;
  const stamps = [configQ.updatedAt, statsQ.updatedAt, roundsQ.updatedAt, detailQ.updatedAt].filter((v): v is number => v !== null);
  const updatedAt = stamps.length ? Math.max(...stamps) : null;
  const stale = [statsQ.updatedAt, roundsQ.updatedAt, ...(roundId === null ? [] : [detailQ.updatedAt])].some((stamp) => stamp === null || now - stamp > 15000);
  const health = (query: { error: unknown; updatedAt: number | null }) => query.error ? 'error' : query.updatedAt === null ? 'loading' : now - query.updatedAt > 15000 ? 'stale' : 'ready';

  return {
    wallet,
    address,
    cfg: configQ.data,
    stats: statsQ.data,
    rounds: roundsQ.data ?? [],
    focus,
    detail: detailQ.data?.roundId === roundId ? detailQ.data : null,
    board,
    trades: tradesQ.data ?? [],
    book: bookQ.data,
    me: address && meQ.data?.address === address ? meQ.data : null,
    clockTargetMs,
    nextStakeTargetMs,
    candleMs,
    loading,
    error: error instanceof Error ? error : null,
    updatedAt,
    stale,
    flowHealth: { trades: health(tradesQ), book: health(bookQ), stats: health(statsQ) },
    refreshAll,
  };
}
