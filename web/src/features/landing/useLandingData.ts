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
  secondsRemaining: number | null;
  candleMs: number;
  loading: boolean;
  error: Error | null;
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
    () => deriveBoard(configQ.data, focus, detailQ.data),
    [configQ.data, focus, detailQ.data],
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const [detailAt, setDetailAt] = useState(0);
  useEffect(() => {
    if (detailQ.data) setDetailAt(Date.now());
  }, [detailQ.data]);

  const secondsRemaining = useMemo(() => {
    if (board.phase === 'stake' && board.stakeCloseAt) {
      return Math.max(0, (board.stakeCloseAt - now) / 1000);
    }
    // Observation countdown follows the nominal 4h × 12 schedule (as in the prototype),
    // so the accelerated demo still reads against the 48:00 window.
    if (board.phase === 'observe') {
      const nominal = configQ.data?.candleSeconds ?? 14400;
      const count = configQ.data?.candleCount ?? 12;
      const left = Math.max(0, count - board.done - (board.live ? board.liveProgress : 0));
      return left * nominal;
    }
    if (board.secondsRemaining === null) return null;
    const elapsed = detailAt > 0 ? (now - detailAt) / 1000 : 0;
    return Math.max(0, board.secondsRemaining - elapsed);
  }, [board.phase, board.stakeCloseAt, board.secondsRemaining, board.done, board.live, board.liveProgress, configQ.data, now, detailAt]);

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

  const error = configQ.error ?? statsQ.error ?? roundsQ.error ?? detailQ.error ?? null;
  const loading = configQ.loading || statsQ.loading || roundsQ.loading;

  return {
    wallet,
    address,
    cfg: configQ.data,
    stats: statsQ.data,
    rounds: roundsQ.data ?? [],
    focus,
    detail: detailQ.data,
    board,
    trades: tradesQ.data ?? [],
    book: bookQ.data,
    me: meQ.data,
    secondsRemaining,
    candleMs,
    loading,
    error: error instanceof Error ? error : null,
    refreshAll,
  };
}
