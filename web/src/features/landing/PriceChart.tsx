import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ProtocolConfig } from '@shared/types';
import { formatPct, formatUsdE8, pad2 } from '../../lib/format';
import type { BoardView } from './derive';
import { fill, type LandingCopy } from './landing.i18n';
import { usdNum } from './utils';

interface Props {
  cfg: ProtocolConfig | null;
  board: BoardView;
  copy: LandingCopy;
}

interface ChartPoint {
  t: number;
  x: number;
  y: number;
  price: number;
  candle: number;
}

interface HoverState {
  index: number;
  x: number;
  y: number;
  left: number;
  top: number;
  price: number;
  above: boolean;
  candle: number;
}

interface PathSample {
  price: number;
}

/** Deterministic PRNG (mulberry32) so the intra-candle path never flickers between renders. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a smooth, deterministic tick path from a start price toward a candle TWAP anchor. */
function buildCandlePath(seed: number, start: number, anchor: number, count: number): PathSample[] {
  const rand = seededRandom(seed);
  const phase = rand() * Math.PI * 2;
  const amp = 0.0035 + rand() * 0.0045;
  const waves: number[] = [];
  for (let k = 0; k < count; k++) {
    waves.push(Math.sin(k * 0.7 + phase) * 0.55 + (rand() - 0.5) * 1.4);
  }
  const mean = waves.reduce((sum, value) => sum + value, 0) / count;
  const out: PathSample[] = [];
  for (let k = 0; k < count; k++) {
    const frac = (k + 1) / count;
    const price = start + (anchor - start) * frac + anchor * (waves[k] - mean) * amp;
    out.push({ price });
  }
  return out;
}

interface Palette {
  fire: string;
  ember: string;
  pass: string;
  fail: string;
  text: string;
  muted: string;
  mono: string;
}

function readPalette(): Palette {
  let cs: CSSStyleDeclaration | null = null;
  try {
    cs = getComputedStyle(document.documentElement);
  } catch {
    cs = null;
  }
  const get = (name: string, fallback: string) => {
    const v = cs ? cs.getPropertyValue(name).trim() : '';
    return v || fallback;
  };
  return {
    fire: get('--fire', '#FF5B1F'),
    ember: get('--ember', '#FFB63D'),
    pass: get('--pass', '#3DDC97'),
    fail: get('--fail', '#FF4D4D'),
    text: get('--text', '#F0E8D9'),
    muted: get('--muted', '#9A8F7D'),
    mono: '11px "IBM Plex Mono", monospace',
  };
}

export function PriceChart({ cfg, board, copy }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geoRef = useRef<{ points: ChartPoint[]; width: number }>({ points: [], width: 0 });
  const [hover, setHover] = useState<HoverState | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pxW = Math.round(W * dpr);
    const pxH = Math.round(H * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const col = readPalette();
    const obs = board.phase === 'observe' || board.phase === 'paused' || board.phase === 'done';
    const target = usdNum(board.targetUsdE8);
    const price = usdNum(board.priceUsdE8);
    const candlePrices = board.candles.map((c) => usdNum(c.twapPriceUsdE8));
    const liveTwap = usdNum(board.liveTwapUsdE8);
    const count = board.candleCount;
    const cw = W / count;

    const SAMPLES = 24;
    const roundSeed = (board.roundId ?? 1) * 10007;

    const points: ChartPoint[] = [];
    if (obs) {
      let prev: number | null = null;
      candlePrices.forEach((value, i) => {
        if (value === null) return;
        const start = prev === null ? value : prev;
        const path = buildCandlePath(roundSeed + i * 131 + 17, start, value, SAMPLES);
        path.forEach((sample, k) => {
          points.push({ t: i + (k + 0.5) / SAMPLES, x: 0, y: 0, price: sample.price, candle: i + 1 });
        });
        prev = path[path.length - 1].price;
      });
      if (board.live && liveTwap !== null) {
        const start = prev === null ? liveTwap : prev;
        const path = buildCandlePath(roundSeed + board.done * 131 + 17, start, liveTwap, SAMPLES);
        const liveCount = Math.max(2, Math.round(board.liveProgress * SAMPLES));
        for (let k = 0; k < liveCount; k++) {
          const t = board.done + ((k + 1) / liveCount) * board.liveProgress;
          points.push({ t, x: 0, y: 0, price: path[k].price, candle: Math.min(count, board.done + 1) });
        }
        if (price !== null) {
          points.push({ t: board.done + board.liveProgress, x: 0, y: 0, price, candle: Math.min(count, board.done + 1) });
        }
      } else if (price !== null) {
        points.push({ t: count, x: 0, y: 0, price, candle: points.length > 0 ? points[points.length - 1].candle : 0 });
      }
    } else if (price !== null) {
      points.push({ t: count, x: 0, y: 0, price, candle: 0 });
    }

    const values: number[] = [];
    if (target !== null) values.push(target);
    points.forEach((p) => values.push(p.price));
    candlePrices.forEach((v) => {
      if (v !== null) values.push(v);
    });
    if (liveTwap !== null) values.push(liveTwap);
    if (values.length === 0) {
      geoRef.current = { points: [], width: W };
      return;
    }
    const minValue = Math.min.apply(null, values);
    const maxValue = Math.max.apply(null, values);
    let lo: number;
    let hi: number;
    if (obs && target !== null) {
      lo = Math.min(target * 0.9, minValue);
      hi = Math.max(target * 1.12, maxValue);
    } else if (target !== null) {
      lo = Math.min(minValue, target * 0.6) * 0.95;
      hi = Math.max(target * 1.08, maxValue * 1.02);
    } else {
      lo = minValue * 0.95;
      hi = maxValue * 1.05;
    }
    if (obs) {
      lo *= 0.994;
      hi *= 1.006;
    }
    if (!(hi > lo)) {
      const mid = (hi + lo) / 2;
      lo = mid * 0.98;
      hi = mid * 1.02;
    }

    const padT = 16;
    const padB = 16;
    const toY = (value: number) => padT + (1 - (value - lo) / (hi - lo)) * (H - padT - padB);
    const toX = (t: number) => (t / count) * W;

    points.forEach((p) => {
      p.x = toX(p.t);
      p.y = toY(p.price);
    });
    geoRef.current = { points, width: W };

    // candle columns
    for (let i = 0; i < count; i++) {
      const x = i * cw;
      const candle = board.candles[i];
      let fillColor: string | null = null;
      let alpha = 0;
      if (obs && candle) {
        fillColor = candle.qualified ? col.pass : col.fail;
        alpha = 0.11;
      } else if (board.phase === 'observe' && i === board.done) {
        fillColor = col.ember;
        alpha = 0.07;
      } else if (i % 2 === 0) {
        fillColor = '#ffffff';
        alpha = 0.016;
      }
      if (fillColor) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = fillColor;
        ctx.fillRect(x, 0, cw, H);
        ctx.globalAlpha = 1;
      }
      if (i > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,.055)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, H);
        ctx.stroke();
      }
    }

    // horizontal grid + labels
    ctx.font = col.mono;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    for (let i = 0; i <= 4; i++) {
      const value = lo + ((hi - lo) * i) / 4;
      const yy = Math.round(toY(value)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,.05)';
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(W, yy);
      ctx.stroke();
      ctx.fillStyle = col.muted;
      ctx.fillText(value.toFixed(5), 6, yy - 3);
    }

    const yT = target === null ? null : toY(target);

    // above / below target fills
    if (yT !== null && points.length > 1) {
      const first = points[0];
      const last = points[points.length - 1];
      ctx.beginPath();
      ctx.moveTo(first.x, yT);
      points.forEach((p) => ctx.lineTo(p.x, Math.min(p.y, yT)));
      ctx.lineTo(last.x, yT);
      ctx.closePath();
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = col.pass;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(first.x, yT);
      points.forEach((p) => ctx.lineTo(p.x, Math.max(p.y, yT)));
      ctx.lineTo(last.x, yT);
      ctx.closePath();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = col.fail;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // target dashed line
    if (yT !== null) {
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = col.fire;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, yT);
      ctx.lineTo(W, yT);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // candle TWAP step lines
    if (obs) {
      board.candles.forEach((candle, i) => {
        const value = usdNum(candle.twapPriceUsdE8);
        if (value === null) return;
        const x0 = i * cw + 5;
        const x1 = (i + 1) * cw - 5;
        const yy = toY(value);
        ctx.strokeStyle = candle.qualified ? col.pass : col.fail;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x0, yy);
        ctx.lineTo(x1, yy);
        ctx.stroke();
      });
      if (board.phase === 'observe' && liveTwap !== null) {
        const x0 = board.done * cw + 5;
        const x1 = Math.max(x0 + 2, (board.done + Math.min(1, board.liveProgress)) * cw);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = col.ember;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0, toY(liveTwap));
        ctx.lineTo(x1, toY(liveTwap));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // price line
    if (points.length > 1) {
      ctx.strokeStyle = col.text;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }

    // live column frame
    if (board.phase === 'observe') {
      ctx.strokeStyle = col.ember;
      ctx.lineWidth = 1;
      ctx.strokeRect(board.done * cw + 0.5, 0.5, cw - 1, H - 1);
    }

    // target tag
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    let targetTagWidth = 0;
    if (yT !== null && target !== null) {
      const label = fill(copy.board.targetTag, { v: formatUsdE8(board.targetUsdE8) });
      targetTagWidth = ctx.measureText(label).width + 12;
      ctx.fillStyle = col.fire;
      ctx.fillRect(W - targetTagWidth, yT - 9, targetTagWidth, 18);
      ctx.fillStyle = '#0A0807';
      ctx.font = '600 11px "IBM Plex Mono", monospace';
      ctx.fillText(label, W - 6, yT + 1);
      ctx.font = col.mono;
    }

    // last price marker + label
    if (points.length > 0 && price !== null) {
      const lastPoint = points[points.length - 1];
      const up = target === null ? true : price >= target;
      const label = formatUsdE8(board.priceUsdE8);
      const pw = ctx.measureText(label).width + 12;
      const px = Math.min(lastPoint.x + 10, W - pw - 6);
      let py = lastPoint.y;
      if (yT !== null && Math.abs(py - yT) < 20 && px + pw > W - targetTagWidth - 4) {
        py = yT + (py >= yT ? 24 : -24);
      }
      ctx.fillStyle = up ? col.pass : col.fail;
      ctx.beginPath();
      ctx.arc(lastPoint.x, lastPoint.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0A0807';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = up ? col.pass : col.fail;
      ctx.fillRect(px, py - 9, pw, 18);
      ctx.fillStyle = '#0A0807';
      ctx.textAlign = 'left';
      ctx.fillText(label, px + 6, py + 1);
    }

    // hover crosshair
    if (hover && points[hover.index]) {
      const p = points[hover.index];
      const y = toY(p.price);
      ctx.strokeStyle = 'rgba(240,232,217,.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(p.x) + 0.5, 0);
      ctx.lineTo(Math.round(p.x) + 0.5, H);
      ctx.stroke();
      ctx.fillStyle = col.text;
      ctx.beginPath();
      ctx.arc(p.x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [board, copy, hover]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(wrap);
    window.addEventListener('resize', draw);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', draw);
    };
  }, [draw]);

  const onMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const geo = geoRef.current;
    if (geo.points.length === 0) {
      setHover(null);
      return;
    }
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    geo.points.forEach((p, i) => {
      const distance = Math.abs(p.x - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    const p = geo.points[best];
    const target = usdNum(board.targetUsdE8);
    setHover({
      index: best,
      x: p.x,
      y: p.y,
      left: Math.max(4, Math.min(p.x + 12, rect.width - 150)),
      top: Math.max(4, p.y - 62),
      price: p.price,
      above: target === null ? true : p.price >= target,
      candle: p.candle,
    });
  };

  const onLeave = () => setHover(null);

  const target = usdNum(board.targetUsdE8);
  const candleCount = board.candles.length;
  const note = board.phase === 'stake' || board.phase === 'unopened'
    ? copy.board.chartStakeNote
    : candleCount === 0 && !board.live
      ? copy.board.chartEmpty
      : '';

  return (
    <div
      className={
        'chart-wrap' +
        (board.result === 'lose' ? ' burning' : '') +
        (board.result === 'win' ? ' won' : '')
      }
      ref={wrapRef}
    >
      <canvas
        id="cv"
        ref={canvasRef}
        role="img"
        aria-label={copy.board.chartAria}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
      />
      <div className="tip" hidden={!hover} style={hover ? { left: hover.left, top: hover.top } : undefined}>
        {hover ? (
          <>
            <b>{formatUsdE8(String(Math.round(hover.price * 1e8)))}</b>
            <span className={hover.above ? 'ok' : 'bad'}>
              {fill(hover.above ? copy.board.tipAbove : copy.board.tipBelow, {
                pct: formatPct(target === null || target === 0 ? 0 : hover.price / target - 1, 2),
              })}
            </span>
            {hover.candle > 0 ? <span className="lbl">{fill(copy.board.tipCandle, { n: pad2(hover.candle) })}</span> : null}
          </>
        ) : null}
      </div>
      {note ? <div className="chart-note">{note}</div> : null}
    </div>
  );
}
