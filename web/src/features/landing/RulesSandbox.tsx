import { useState } from 'react';
import type { ProtocolConfig } from '@shared/types';
import type { BoardView } from './derive';
import { IcoNo, IcoOk } from './icons';
import { useLang } from '../../lib/lang';
import { fill, type LandingCopy } from './landing.i18n';
import { formatCompactNumber, intFmt, tokenNum } from './utils';

interface Props {
  cfg: ProtocolConfig | null;
  board: BoardView;
  copy: LandingCopy;
}

/** 18 candles with exactly 12 qualified (the default demo verdict). */
const SIM_DEFAULT = [1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1].map(Boolean);
/** One candle short of the pass line. */
const SIM_SHORT = SIM_DEFAULT.map((value, index) => (index === 4 ? false : value));

type Preset = 'all' | 'need' | 'short' | 'none';

export function RulesSandbox({ cfg, board, copy }: Props) {
  const { lang } = useLang();
  const candleCount = cfg?.candleCount ?? 18;
  const need = cfg?.minQualifiedCandles ?? 12;
  const [sim, setSim] = useState<boolean[]>(SIM_DEFAULT);
  const [stakeText, setStakeText] = useState('100000');
  const decimals = cfg?.token.decimals ?? 9;

  const cells = Array.from({ length: candleCount }, (_, index) => sim[index] ?? false);
  const count = cells.filter(Boolean).length;
  const win = count >= need;
  const stake = Math.max(0, Number(stakeText) || 0);
  const totalStake = tokenNum(board.totalStakeRaw, decimals);
  const rewardBudget = tokenNum(board.rewardBudgetRaw, decimals);
  const reward = (rewardBudget * stake) / (totalStake + stake || 1);
  const rewardText = formatCompactNumber(rewardBudget, lang);

  const applyPreset = (preset: Preset) => {
    if (preset === 'all') setSim(Array.from({ length: candleCount }, () => true));
    else if (preset === 'need') setSim(SIM_DEFAULT.slice(0, candleCount));
    else if (preset === 'short') setSim(SIM_SHORT.slice(0, candleCount));
    else setSim(Array.from({ length: candleCount }, () => false));
  };

  const toggle = (index: number) => {
    setSim((prev) => {
      const next = Array.from({ length: candleCount }, (_, i) => prev[i] ?? false);
      next[index] = !next[index];
      return next;
    });
  };

  return (
    <section className="sec" id="rules">
      <div className="wrap">
        <div className="sec-h">
          <span className="lbl">{copy.rules.lbl}</span>
          <h2>{copy.rules.title}</h2>
          <p>{copy.rules.intro}</p>
        </div>
        <div className="steps">
          {copy.rules.steps.map((step) => (
            <div className="step" key={step.n}>
              <div className="n">{step.n}</div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <span className="k">{step.key}</span>
            </div>
          ))}
        </div>
        <p className="note">{copy.rules.formulaNote}</p>

        <div className="sec-h" style={{ marginTop: 44 }}>
          <span className="lbl">{copy.rules.sandLbl}</span>
          <h3 style={{ margin: 0, font: '900 26px/1.2 var(--f-body)' }}>{copy.rules.sandTitle}</h3>
          <p>{copy.rules.sandIntro}</p>
        </div>
        <div className="sand">
          <div className="panel">
            <div className="ph">
              <span className="lbl">{copy.rules.sandCellsTitle}</span>
              <span className="lbl">{fill(copy.rules.sandCount, { n: count, total: candleCount })}</span>
            </div>
            <div className="sand-cells">
              {cells.map((on, index) => (
                <button
                  type="button"
                  className={'sc' + (on ? ' on' : '')}
                  key={index}
                  onClick={() => toggle(index)}
                  aria-pressed={on}
                  aria-label={fill(on ? copy.rules.cellAriaOn : copy.rules.cellAriaOff, { i: index + 1 })}
                >
                  <b>{String(index + 1).padStart(2, '0')}</b>
                  {on ? <IcoOk /> : <IcoNo />}
                  <span>{on ? copy.board.cellHit : copy.board.cellMiss}</span>
                </button>
              ))}
            </div>
            <div className="presets">
              <button className="btn sm" type="button" onClick={() => applyPreset('all')}>
                {copy.rules.presets.all}
              </button>
              <button className="btn sm" type="button" onClick={() => applyPreset('need')}>
                {copy.rules.presets.eight}
              </button>
              <button className="btn sm" type="button" onClick={() => applyPreset('short')}>
                {copy.rules.presets.seven}
              </button>
              <button className="btn sm" type="button" onClick={() => applyPreset('none')}>
                {copy.rules.presets.none}
              </button>
            </div>
            <div className="gauge">
              <div className="bar">
                <i className={win ? '' : 'lo'} style={{ width: (count / candleCount) * 100 + '%' }} />
                <u style={{ left: (need / candleCount) * 100 + '%' }} />
              </div>
              <div className="lab">
                <span>{copy.rules.gaugeZero}</span>
                <span>{copy.rules.gaugePass}</span>
                <span>{candleCount}</span>
              </div>
            </div>
          </div>
          <div className={'panel out ' + (win ? 'win' : 'lose')}>
            <span className="lbl">{copy.rules.outLbl}</span>
            <h3>{win ? copy.rules.outWinTitle : copy.rules.outLoseTitle}</h3>
            <p>
              {win
                ? fill(copy.rules.outWinBody, { n: count, need, reward: rewardText })
                : fill(copy.rules.outLoseBody, {
                    n: count,
                    extra: count === need - 1 ? copy.rules.outLoseExtra : '',
                    reward: rewardText,
                  })}
            </p>
            {win ? (
              <dl className="kv">
                <div>
                  <dt>{copy.rules.outWinPrincipal}</dt>
                  <dd>{intFmt(stake) + ' A9'}</dd>
                </div>
                <div>
                  <dt>{copy.rules.outWinReward}</dt>
                  <dd className="ok">{intFmt(reward) + ' A9'}</dd>
                </div>
                <div>
                  <dt>{copy.rules.outWinTotal}</dt>
                  <dd>{intFmt(stake + reward) + ' A9'}</dd>
                </div>
              </dl>
            ) : (
              <dl className="kv danger">
                <div>
                  <dt>{copy.rules.outLoseYourLoss}</dt>
                  <dd className="bad">{intFmt(stake) + ' ' + copy.common.lossFull}</dd>
                </div>
                <div>
                  <dt>{copy.rules.outLoseRewardBurn}</dt>
                  <dd>{rewardText + ' A9'}</dd>
                </div>
                <div>
                  <dt>{copy.rules.outLosePoolBurn}</dt>
                  <dd>{formatCompactNumber(totalStake + stake, lang) + ' A9'}</dd>
                </div>
              </dl>
            )}
          </div>
        </div>
        <label className="f" htmlFor="simStake" style={{ maxWidth: 360, marginTop: 14 }}>
          <span className="lbl">{copy.rules.sandStake}</span>
          <div className="inp">
            <input
              id="simStake"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={stakeText}
              onChange={(event) => setStakeText(event.target.value)}
            />
            <span>A9</span>
          </div>
        </label>

        <div className="diff">
          {copy.rules.diff.map((item) => (
            <div key={item.title}>
              <h4>{item.title}</h4>
              <p>{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
