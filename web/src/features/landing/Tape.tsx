import type { ReactNode } from 'react';
import type { ProtocolConfig, ProtocolStats, Trade } from '@shared/types';
import { compactUsd, formatUsdE8 } from '../../lib/format';
import type { BoardView } from './derive';
import { useLang } from '../../lib/lang';
import { fill, type LandingCopy } from './landing.i18n';
import { formatCompactToken, tokenNum, usdNum } from './utils';

interface Props {
  cfg: ProtocolConfig | null;
  stats: ProtocolStats | null;
  board: BoardView;
  trades: Trade[];
  copy: LandingCopy;
}

function Item(props: { label: string; children: ReactNode }) {
  return (
    <span className="ti">
      <b>{props.label}</b>
      {props.children}
    </span>
  );
}

export function Tape({ cfg, stats, board, trades, copy }: Props) {
  const { lang } = useLang();
  const decimals = cfg?.token.decimals ?? 9;
  const price = usdNum(board.priceUsdE8);
  const prev = usdNum(stats?.price24hAgoUsdE8 ?? null);
  const chg = price !== null && prev !== null && prev > 0 ? price / prev - 1 : null;
  const cls = chg === null ? '' : chg >= 0 ? 'up' : 'down';
  const target = usdNum(board.targetUsdE8);
  const touched = price !== null && target !== null ? price >= target : null;
  const totalStake = tokenNum(board.totalStakeRaw, decimals);
  const burned = tokenNum(stats?.burnedRaw ?? null, decimals);
  const vol = usdNum(stats?.volume24hUsdE8 ?? null);

  const primary = (
    <>
      <Item label={copy.tape.price}>
        <span className={cls}>{price === null ? '—' : formatUsdE8(board.priceUsdE8)}</span>{' '}
        {chg === null ? (
          <span className="mono">—</span>
        ) : (
          <span className={cls}>
            {(chg >= 0 ? '▲' : '▼') + ' ' + (chg * 100).toFixed(2) + '%'}
          </span>
        )}
      </Item>
      <Item label={fill(copy.tape.target, { round: String(board.roundId ?? '--').padStart(2, '0') })}>
        <span className="hot">{target === null ? '—' : formatUsdE8(board.targetUsdE8)}</span>{' '}
        {touched === null ? null : (
          <span className={touched ? 'ok' : 'bad'}>{touched ? copy.tape.touched : copy.tape.untouched}</span>
        )}
      </Item>
      <Item label={copy.tape.lit}>
        <span className={board.hits >= 8 ? 'ok' : ''}>
          {board.hits} / 8
        </span>
      </Item>
      <Item label={copy.tape.miss}>
        <span className={board.miss >= 4 ? 'bad' : ''}>{board.miss} / 5</span>
      </Item>
      <Item label={copy.tape.stake}>{formatCompactToken(board.totalStakeRaw, decimals, lang) + ' A9'}</Item>
      <Item label={copy.tape.burned}>{formatCompactToken(stats?.burnedRaw ?? '0', decimals, lang) + ' A9'}</Item>
      <Item label={copy.tape.volume}>{vol === null ? '—' : compactUsd(vol)}</Item>
      {[0, 1, 2, 3].map((i) => {
        const tr = trades[i];
        return (
          <span className="ti" key={'tr' + i}>
            {tr ? (
              <>
                <span className={tr.side === 'BUY' ? 'up' : 'down'}>
                  {tr.side === 'BUY' ? copy.tape.buy : copy.tape.sell}
                </span>{' '}
                {formatCompactToken(tr.amountRaw, decimals, lang)} @ {formatUsdE8(tr.priceUsdE8)}
              </>
            ) : (
              <span className="mono">—</span>
            )}
          </span>
        );
      })}
    </>
  );

  return (
    <div className="tape" aria-hidden="true">
      <div className="tape-track">
        <div className="tape-set">{primary}</div>
        <div className="tape-set">{primary}</div>
      </div>
    </div>
  );
}
