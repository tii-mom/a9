import type { LandingCopy } from './landing.i18n';

interface Props {
  copy: LandingCopy;
  onTab: (tab: 'buy' | 'stake') => void;
}

export function Hero({ copy, onTab }: Props) {
  return (
    <section className="hero">
      <div className="wrap hero-in">
        <div>
          <div className="eyebrow">
            <span className="lbl">{copy.hero.badge}</span>
            <span className="pill stk">
              <i />
              {copy.hero.pill}
            </span>
          </div>
          <h1>
            {copy.hero.title}
            <em>{copy.hero.titleEm}</em>
          </h1>
          <p className="lede">{copy.hero.lede}</p>
          <div className="cta">
            <a className="btn fire" href="#cmd" onClick={() => onTab('stake')}>
              {copy.hero.ctaStake}
            </a>
            <a className="btn" href="#cmd" onClick={() => onTab('buy')}>
              {copy.hero.ctaBuy}
            </a>
            <a className="btn ghost" href="#rules">
              {copy.hero.ctaRules}
            </a>
          </div>
        </div>
        <div className="facts" aria-label={copy.hero.badge}>
          <div>
            <span className="lbl">{copy.hero.totalSupply}</span>
            <div className="n">
              {copy.hero.totalSupplyValue}
              <small>{copy.hero.totalSupplyUnit}</small>
            </div>
          </div>
          <div>
            <span className="lbl">{copy.hero.unlockRounds}</span>
            <div className="n">
              {copy.hero.unlockRoundsValue}
              <small>{copy.hero.unlockRoundsUnit}</small>
            </div>
          </div>
          <div>
            <span className="lbl">{copy.hero.roundTarget}</span>
            <div className="n">
              {copy.hero.roundTargetValue}
              <sup style={{ fontSize: '.55em' }}>{copy.hero.roundTargetUnit}</sup>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
