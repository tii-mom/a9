import { memo } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { OrderBook, ProtocolConfig, ProtocolStats, Trade } from '@shared/types';
import { compactUsd, formatToken, formatUsdE8, utcClock } from '../../lib/format';
import type { BoardView } from './derive';
import { useLang } from '../../lib/lang';
import { fill, type LandingCopy } from './landing.i18n';
import { formatCompactToken, intFmt, tokenNum, usdNum } from './utils';

interface Props {
  health: { trades: string; book: string; stats: string };
  cfg: ProtocolConfig | null;
  stats: ProtocolStats | null;
  board: BoardView;
  trades: Trade[];
  book: OrderBook | null;
  copy: LandingCopy;
}

const barStyle = (width: number): CSSProperties => ({ ['--w' as string]: Math.max(0, Math.min(100, width)) + '%' }) as CSSProperties;

function OrderFlowView({ health, cfg, stats, board, trades, book, copy }: Props) {
  const { lang } = useLang();
  const status = (value: string) => value === 'error' ? (lang === 'zh' ? '刷新失败 · 保留上次数据' : 'Refresh failed · last data shown') : value === 'loading' ? copy.common.loading : value === 'stale' ? (lang === 'zh' ? '数据已过期' : 'Stale data') : cfg?.dataSource === 'demo' ? (lang === 'zh' ? '演示数据' : 'Demo data') : (lang === 'zh' ? '轮询更新' : 'Polling');
  const decimals = cfg?.token.decimals ?? 9;
  const [newId, setNewId] = useState<number | null>(null);
  const prevTop = useRef<number | null>(null);
  const topId = trades.length > 0 ? trades[0].id : null;

  useEffect(() => {
    if (topId !== null && prevTop.current !== null && topId !== prevTop.current) setNewId(topId);
    prevTop.current = topId;
  }, [topId]);

  useEffect(() => {
    if (newId === null) return;
    const timer = window.setTimeout(() => setNewId(null), 800);
    return () => window.clearTimeout(timer);
  }, [newId]);

  const price = usdNum(board.priceUsdE8);
  const target = usdNum(board.targetUsdE8);
  const volume = usdNum(stats?.volume24hUsdE8 ?? null);
  const liquidity = usdNum(stats?.liquidityUsdE8 ?? null);
  const supply = tokenNum(stats?.supplyRaw ?? null, decimals);
  const burned = tokenNum(stats?.burnedRaw ?? null, decimals);
  const stakePool = tokenNum(board.totalStakeRaw, decimals);
  const rewardPool = tokenNum(board.rewardBudgetRaw, decimals);
  const ratio = board.roundId !== null && stakePool > 0 ? rewardPool / stakePool : null;

  const statsCells = [
    { label: copy.flow.s24h, value: volume === null ? '—' : compactUsd(volume) },
    { label: copy.flow.liquidity, value: liquidity === null ? '—' : compactUsd(liquidity) },
    { label: copy.flow.supply, value: stats ? formatCompactToken(stats.supplyRaw, decimals, lang) : '—' },
    { label: copy.flow.burned, value: stats ? formatCompactToken(stats.burnedRaw, decimals, lang) : '—' },
    { label: copy.flow.staked, value: board.roundId === null ? '—' : formatCompactToken(board.totalStakeRaw, decimals, lang) },
    { label: copy.flow.stakers, value: board.roundId === null ? '—' : intFmt(board.stakerCount) },
    { label: copy.flow.reward, value: board.roundId === null ? '—' : formatCompactToken(board.rewardBudgetRaw, decimals, lang) },
    { label: copy.flow.ratio, value: ratio === null ? '—' : ratio.toFixed(2) + ' ×' },
  ];

  const asks = book ? book.asks.slice(0, 7).slice().reverse() : [];
  const bids = book ? book.bids.slice(0, 7) : [];

  return (
    <section className="sec" id="floor">
      <div className="wrap">
        <div className="sec-h">
          <span className="lbl">{copy.flow.lbl}</span>
          <h2>{copy.flow.title}</h2>
          <p>{copy.flow.intro}</p>
        </div>
        <div className="floor">
          <div className="panel">
            <div className="ph">
              <span className="lbl">{copy.flow.tradesTitle}</span>
              <span className="lbl">{status(health.trades)}</span>
            </div>
            <div className="ts-h">
              <span>{copy.flow.time}</span>
              <span>{copy.flow.side}</span>
              <span>{copy.flow.amount}</span>
              <span>{copy.flow.price}</span>
              <span>{copy.flow.value}</span>
            </div>
            <div id="ts">
              {trades.length === 0 ? (
                <div className="empty">{health.trades === 'loading' ? copy.common.loading : health.trades === 'error' ? copy.common.apiDown : copy.flow.empty}</div>
              ) : (
                trades.map((trade) => (
                  <div
                    className={
                      'ts-row' +
                      (newId === trade.id ? ' new' : '') +
                      (trade.big ? ' big' : '')
                    }
                    key={trade.id}
                  >
                    <span>{utcClock(trade.ts)}</span>
                    <span className={trade.side === 'BUY' ? 'up' : 'down'}>
                      {trade.side === 'BUY' ? copy.flow.buy : copy.flow.sell}
                    </span>
                    <span>
                      {formatToken(trade.amountRaw, decimals)}
                      {trade.big ? <i className="tag">{copy.flow.tagBig}</i> : null}
                    </span>
                    <span>{formatUsdE8(trade.priceUsdE8)}</span>
                    <span>{formatUsdE8(trade.valueUsdE8)}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel book">
            <div className="ph">
              <span className="lbl">{copy.flow.bookTitle}</span>
              <span className="lbl">{status(health.book)}</span>
            </div>
            {book === null ? (
              <div className="empty">{health.book === 'loading' ? copy.common.loading : health.book === 'error' ? copy.common.apiDown : copy.flow.empty}</div>
            ) : (
              <div id="book">
                {asks.map((level, i) => (
                  <div
                    className="r ask"
                    key={'a' + i}
                    style={barStyle(level.cumulativePct)}
                  >
                    <span>{formatUsdE8(level.priceUsdE8)}</span>
                    <span>{formatToken(level.amountRaw, decimals)}</span>
                  </div>
                ))}
                <div className="mid">
                  <span className={price !== null && target !== null && price >= target ? 'up' : 'down'}>
                    {formatUsdE8(book.midUsdE8)}
                  </span>
                  <span className="sub">
                    {target === null ? '' : fill(copy.flow.bookTarget, { v: formatUsdE8(board.targetUsdE8) })}
                  </span>
                </div>
                {bids.map((level, i) => (
                  <div
                    className="r bid"
                    key={'b' + i}
                    style={barStyle(level.cumulativePct)}
                  >
                    <span>{formatUsdE8(level.priceUsdE8)}</span>
                    <span>{formatToken(level.amountRaw, decimals)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <div className="ph">
              <span className="lbl">{copy.flow.statsTitle}</span>
              <span className="lbl">{status(health.stats)}</span>
            </div>
            <div className="stats" id="stats">
              {statsCells.map((cell) => (
                <div key={cell.label}>
                  <span className="lbl">{cell.label}</span>
                  <div className="v">{cell.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Memoised: re-renders only when its inputs change (docs/31 §5.3). */
export const OrderFlow = memo(OrderFlowView);
