import { memo } from 'react';
import { useId } from 'react';
import type { ProtocolConfig } from '@shared/types';
import { formatUsdE8, pad2 } from '../../lib/format';
import { useLang } from '../../lib/lang';
import type { BoardView } from './derive';
import { fill, type LandingCopy } from './landing.i18n';
import { usdNum } from './utils';

interface Props { cfg: ProtocolConfig | null; board: BoardView; copy: LandingCopy }

/** Only reported TWAP values are plotted. A segment represents one candle, never a tick path. */
function PriceChartView({ cfg, board, copy }: Props) {
  const { lang } = useLang();
  const zh = lang === 'zh';
  const titleId = useId();
  const descId = useId();
  const target = usdNum(board.targetUsdE8);
  const candles = board.candles.map((candle) => ({
    index: candle.candleIndex,
    raw: candle.twapPriceUsdE8,
    value: usdNum(candle.twapPriceUsdE8),
    qualified: candle.qualified,
    end: candle.periodEnd,
  }));
  const live = board.live ? usdNum(board.liveTwapUsdE8) : null;
  const values = candles.flatMap((c) => c.value === null ? [] : [c.value]);
  if (target !== null) values.push(target);
  if (live !== null) values.push(live);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const pad = Math.max((max - min) * 0.16, max * 0.03, 0.00000001);
  const lo = Math.max(0, min - pad);
  const hi = max + pad;
  const y = (v: number) => 200 - (v - lo) / (hi - lo) * 170;
  const x = (index: number) => 64 + index / Math.max(1, board.candleCount) * 700;
  const note = zh
    ? '实线：已收盘 TWAP · 虚线：本根暂定 TWAP。图中没有逐笔价格或插值行情。'
    : 'Solid: closed TWAP · dashed: provisional TWAP. No tick prices or interpolated history.';
  return (
    <div className="twap-chart">
      <div className="chart-wrap">
        <svg className="twap-svg" viewBox="0 0 800 230" role="img" aria-labelledby={`${titleId} ${descId}`}>
          <title id={titleId}>{copy.board.chartAria}</title>
          <desc id={descId}>{note} {zh ? '完整数据见下方表格。' : 'Full values are available in the table below.'}</desc>
          {[0, 1, 2, 3].map((i) => {
            const v = lo + (hi - lo) * i / 3;
            return <g key={i}><line x1="64" x2="764" y1={y(v)} y2={y(v)} className="twap-grid" /><text x="58" y={y(v) + 4} textAnchor="end">{v.toFixed(5)}</text></g>;
          })}
          {target !== null ? <g><line x1="64" x2="764" y1={y(target)} y2={y(target)} className="twap-target" /><text x="764" y={Math.max(15, y(target) - 8)} textAnchor="end" className="twap-target-text">{fill(copy.board.targetTag, { v: formatUsdE8(board.targetUsdE8) })}</text></g> : null}
          {candles.map((c) => c.value === null ? null : <g key={c.index}>
            <title>{fill(copy.board.tipCandle, { n: c.index + 1 })}: {formatUsdE8(c.raw)} · {c.qualified ? copy.board.cellHit : copy.board.cellMiss}</title>
            <rect x={x(c.index)} y="25" width={700 / board.candleCount} height="175" fill={c.qualified ? 'var(--pass)' : 'var(--fail)'} opacity=".06" />
            <line x1={x(c.index) + 2} x2={x(c.index + 1) - 2} y1={y(c.value)} y2={y(c.value)} stroke={c.qualified ? 'var(--pass)' : 'var(--fail)'} strokeWidth="3" />
          </g>)}
          {live !== null ? <line x1={x(board.done) + 2} x2={x(board.done + Math.max(.08, board.liveProgress)) - 2} y1={y(live)} y2={y(live)} stroke="var(--ember)" strokeWidth="3" strokeDasharray="5 3" /> : null}
          {[0, Math.floor(board.candleCount / 2), board.candleCount].map((i) => <text key={i} x={x(i)} y="223" textAnchor={i === 0 ? 'start' : i === board.candleCount ? 'end' : 'middle'}>{i} / {board.candleCount}</text>)}
          {candles.length === 0 && live === null ? <text x="410" y="120" textAnchor="middle">{copy.board.chartWaiting}</text> : null}
        </svg>
      </div>
      <p className="twap-caption">{cfg?.dataSource === 'demo' ? (zh ? '演示数据 · ' : 'Demo data · ') : ''}{note}</p>
      <details className="twap-data">
        <summary>{zh ? '查看 TWAP 数据表' : 'View TWAP data table'} ({candles.length}{live !== null ? '+1' : ''})</summary>
        <div className="twap-table-scroll"><table>
          <caption>{zh ? '服务端报告的 K 线数据，时间为 UTC' : 'Server-reported candles, times in UTC'}</caption>
          <thead><tr><th scope="col">{zh ? 'K 线' : 'Candle'}</th><th scope="col">UTC</th><th scope="col">TWAP</th><th scope="col">{zh ? '状态' : 'Status'}</th></tr></thead>
          <tbody>{candles.map((c) => <tr key={c.index}><th scope="row">{pad2(c.index + 1)}</th><td>{new Date(c.end).toISOString().slice(11, 16)}</td><td>{formatUsdE8(c.raw)}</td><td>{c.qualified ? copy.board.cellHit : copy.board.cellMiss}</td></tr>)}
            {live !== null ? <tr><th scope="row">{pad2(board.done + 1)}</th><td>—</td><td>{formatUsdE8(board.liveTwapUsdE8)}</td><td>{zh ? '暂定 · 不计入已收盘' : 'Provisional · not closed'}</td></tr> : null}
            {candles.length === 0 && live === null ? <tr><td colSpan={4}>{copy.board.chartWaiting}</td></tr> : null}
          </tbody>
        </table></div>
      </details>
    </div>
  );
}

/** Memoised: re-renders only when its inputs change (docs/31 §5.3). */
export const PriceChart = memo(PriceChartView);
