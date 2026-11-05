import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { formatUsdE8 } from '../../lib/format';
import { candleHour, fallbackCandleHour, type BoardView } from './derive';
import { IcoDot, IcoNo, IcoOk } from './icons';
import type { LandingCopy } from './landing.i18n';

interface Props {
  board: BoardView;
  copy: LandingCopy;
  candleMs: number;
}

export function FuseCells({ board, copy, candleMs }: Props) {
  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const prevDone = useRef(board.done);

  useEffect(() => {
    if (board.done > prevDone.current) setFlashIndex(board.done - 1);
    prevDone.current = board.done;
  }, [board.done]);

  useEffect(() => {
    if (flashIndex === null) return;
    const timer = window.setTimeout(() => setFlashIndex(null), 900);
    return () => window.clearTimeout(timer);
  }, [flashIndex]);

  const observing = board.phase !== 'stake' && board.phase !== 'unopened';
  const progress = observing ? Math.min(12, board.done + (board.live ? Math.min(1, board.liveProgress) : 0)) / 12 * 100 : 0;

  return (
    <div className="cells" aria-label={copy.board.chartAria}>
      <div className={'fuse' + (observing ? '' : ' off')} style={{ width: progress + '%' }} />
      {Array.from({ length: 12 }).map((_, i) => {
        const candle = board.candles[i];
        const isLive = board.phase === 'observe' && i === board.done;
        let cls = 'cell ';
        let icon: ReactNode = null;
        let label = copy.board.cellPending;
        let value = '';
        let time = '';
        if (candle) {
          cls += candle.qualified ? 'hit' : 'miss';
          icon = candle.qualified ? <IcoOk /> : <IcoNo />;
          label = candle.qualified ? copy.board.cellHit : copy.board.cellMiss;
          value = formatUsdE8(candle.twapPriceUsdE8);
        } else if (isLive) {
          cls += 'live' + (board.tentativeHit ? ' tentative-hit' : '');
          icon = <IcoDot />;
          label = copy.board.cellLive;
          value = board.liveTwapUsdE8 ? formatUsdE8(board.liveTwapUsdE8) : '';
        } else {
          cls += 'pend';
          icon = <span style={{ opacity: 0.5 }}>—</span>;
        }
        if (flashIndex === i) cls += ' flash';

        if (board.observationStart) time = candleHour(board.observationStart + i * candleMs);
        else if (candle?.periodStart) time = candleHour(candle.periodStart);
        else time = fallbackCandleHour(i, board.phase);

        return (
          <div className={cls} key={i} data-i={i}>
            <span className="ci">{String(i + 1).padStart(2, '0')}</span>
            <span className="ct">{time}</span>
            <span className="cs">{icon}</span>
            <span className="cl">{label}</span>
            <span className="cv">{value}</span>
          </div>
        );
      })}
    </div>
  );
}
