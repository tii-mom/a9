import type { ProtocolConfig } from '@shared/types';
import { Link } from 'react-router-dom';
import { useLang } from '../../lib/lang';
import type { BoardView } from './derive';
import type { LandingCopy } from './landing.i18n';
import { formatCompactToken } from './utils';
import { BUY_ENTRY_OPEN } from './flags';

interface Props {
  copy: LandingCopy;
  cfg: ProtocolConfig | null;
  board: BoardView;
  onTab: (tab: 'buy' | 'stake') => void;
}

export function Hero({ copy, cfg, board, onTab }: Props) {
  const { lang } = useLang();
  const zh = lang === 'zh';
  const hours = (seconds: number | undefined) => seconds === undefined ? '—' : String(Number((seconds / 3600).toFixed(2)));
  const open = board.state === 'STAKING_OPEN';
  const terminal = board.phase === 'done';
  const primary = open ? copy.hero.ctaStake : terminal ? copy.common.goMe : zh ? '查看本轮进度' : 'Follow this round';
  return (
    <section className="hero">
      <div className="wrap hero-in">
        <div>
          <div className="eyebrow">
            <span className="lbl">{copy.hero.badge}</span>
            <span className="pill stk"><i />{copy.hero.pill}</span>
          </div>
          <h1>{copy.hero.title}<em>{copy.hero.titleEm}</em></h1>
          <p className="lede">{copy.hero.lede}</p>
          <div className="cta">
            {terminal ? <Link className="btn fire" to="/me">{primary}</Link> :
              <a className="btn fire" href={open ? '#cmd' : '#war'} onClick={() => { if (open) onTab('stake'); }}>{primary}</a>}
            <a className="btn" href="#rules">{copy.hero.ctaRules}</a>
            {BUY_ENTRY_OPEN ? <a className="btn ghost" href="#cmd" onClick={() => onTab('buy')}>{zh ? '买入参考' : 'Buy estimate'}</a> : null}
          </div>
          <ol className="hero-timeline" aria-label={zh ? '一轮如何进行' : 'How a round works'}>
            <li><span>01</span><b>{zh ? '报名质押' : 'Stake'}</b><small>{hours(cfg?.stakeDurationSeconds)}h</small></li>
            <li><span>02</span><b>{zh ? 'TWAP 观察' : 'TWAP observation'}</b><small>{hours(cfg?.observationSeconds)}h · {cfg ? `${cfg.minQualifiedCandles}/${cfg.candleCount}` : '—'}</small></li>
            <li><span>03</span><b>{zh ? '结算与分配' : 'Settle & allocate'}</b><small>{zh ? '成功返本金 · 失败全损' : 'Pass: principal back · fail: full loss'}</small></li>
          </ol>
        </div>
        <div className="facts" aria-label={copy.hero.badge}>
          <div><span className="lbl">{copy.hero.totalSupply}</span><div className="n">{cfg ? formatCompactToken(cfg.totalSupplyRaw, cfg.token.decimals, lang) : '—'}<small>A9</small></div></div>
          <div><span className="lbl">{zh ? '每轮奖励预算' : 'Round reward budget'}</span><div className="n">{cfg ? formatCompactToken(cfg.roundRewardRaw, cfg.token.decimals, lang) : '—'}<small>A9 · {cfg?.roundCount ?? '—'} {zh ? '轮' : 'rounds'}</small></div></div>
          <div><span className="lbl">{zh ? '目标仅在成功后升档' : 'Tier advances on success'}</span><div className="n hero-formula">P0 × 2<sup>tier</sup></div><small>{zh ? '同时不低于开窗 24h TWAP 的 2 倍' : 'At least 2× the opening 24h TWAP'}</small></div>
        </div>
      </div>
    </section>
  );
}
