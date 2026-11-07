import { memo } from 'react';
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

/** Default demo verdict: exactly "need" of "candleCount" candles qualified. */
function defaultPattern(candleCount: number, need: number): boolean[] {
  return Array.from({ length: candleCount }, (_, index) => index < need);
}
/** One candle short of the pass line. */
function shortPattern(candleCount: number, need: number): boolean[] {
  const base = defaultPattern(candleCount, need);
  return base.map((value, index) => (index === Math.max(0, need - 1) ? false : value));
}

type Preset = 'all' | 'need' | 'short' | 'none';

function RulesSandboxView({ cfg, board, copy }: Props) {
  const { lang } = useLang();
  const candleCount = cfg?.candleCount ?? 24;
  const need = cfg?.minQualifiedCandles ?? 16;
  const basePattern = defaultPattern(candleCount, need);
  const [sim, setSim] = useState<boolean[] | null>(null);
  const [stakeText, setStakeText] = useState('1000');
  const decimals = cfg?.token.decimals ?? 9;

  const cells = sim !== null && sim.length === candleCount ? sim : basePattern;
  const count = cells.filter(Boolean).length;
  const win = count >= need;
  const stake = Math.max(0, Number(stakeText) || 0);
  const totalStake = tokenNum(board.totalStakeRaw, decimals);
  const rewardBudget = tokenNum(board.rewardBudgetRaw, decimals);
  const rewardText = formatCompactNumber(rewardBudget, lang);

  const applyPreset = (preset: Preset) => {
    if (preset === 'all') setSim(Array.from({ length: candleCount }, () => true));
    else if (preset === 'need') setSim(defaultPattern(candleCount, need));
    else if (preset === 'short') setSim(shortPattern(candleCount, need));
    else setSim(Array.from({ length: candleCount }, () => false));
  };

  const toggle = (index: number) => {
    setSim((prev) => {
      const current = prev !== null && prev.length === candleCount ? prev : basePattern;
      const next = current.slice();
      next[index] = !next[index];
      return next;
    });
  };

  if (!cfg) return <section className="sec" id="rules"><div className="wrap"><h2>{copy.rules.title}</h2><p>{copy.common.loading}</p></div></section>;

  return (
    <section className="sec" id="rules">
      <div className="wrap">
        <div className="sec-h">
          <span className="lbl">{copy.rules.lbl}</span>
          <h2>{copy.rules.title}</h2>
          <p>{copy.rules.intro}</p>
        </div>
        <div className="steps">
          {copy.rules.steps.map((step, index) => (
            <div className="step" key={step.n}>
              <div className="n">{step.n}</div>
              <h3>{step.title}</h3>
              <p>{lang === 'zh' ? [
                  `攻城期 ${cfg ? cfg.stakeDurationSeconds / 3600 : '—'} 小时。上车前确认最大损失；结束后不可追加或提前退出。`,
                  `观察期 ${cfg ? cfg.observationSeconds / 3600 : '—'} 小时，${candleCount} 根 × ${cfg ? cfg.candleSeconds / 3600 : '—'} 小时 K 线。每根按多源 TWAP 考核。`,
                  `至少 ${need}/${candleCount} 根 TWAP 达到锁定目标价即通过，无需连续，恰好等于目标也达标。`,
                  '破城：本金立即可领，奖励 20% 立即可领、80% 压城；城没破：本金 100% 销毁（输了归零），奖池一半销毁、一半滚入下一城。'
                ][index] : [
                  `Stake during the ${cfg ? cfg.stakeDurationSeconds / 3600 : '—'}h window. Confirm the full loss risk. No additions or early exits after closing.`,
                  `Observe ${candleCount} × ${cfg ? cfg.candleSeconds / 3600 : '—'}h candles over ${cfg ? cfg.observationSeconds / 3600 : '—'}h, scored by multi-source TWAP.`,
                  `At least ${need}/${candleCount} TWAP candles must reach the locked target. They need not be consecutive. Equality qualifies.`,
                  'On success, principal is claimable at once and the reward is split by weight: 20% at once, 80% locked. On failure, all principal is burned (losing means zero) and half the pool burns while half rolls over.'
                ][index]}</p>
              <span className="k">{lang === 'zh' ? ['本金 100% 风险', '每根独立考核', `≥ ${need} 根通过`, '领取额度见账户页'][index] : ['100% principal at risk', 'Each candle scored independently', `≥ ${need} passes`, 'Review claims in your account'][index]}</span>
            </div>
          ))}
        </div>
        <p className="note">{lang === 'zh' ? '目标 = max(P0 × 2^tier, 2 × 开窗 24h TWAP)；tier = 1 + 已破城数。奖励 = 本城奖池 × 我的战力 / 本城总战力，战力 = 本金 × 时机系数（攻城期前 12h ×1.5、中 12h ×1.2、后 12h ×1.0）。' : 'Target = max(P0 × 2^tier, 2 × opening 24h TWAP); tier = 1 + gates broken. Reward = gate pool × my weight / total weight, weight = principal × timing factor (first 12h ×1.5, middle 12h ×1.2, last 12h ×1.0).'}</p>

        <div className="sec-h" style={{ marginTop: 44 }}>
          <span className="lbl">{copy.rules.sandLbl}</span>
          <h3 style={{ margin: 0, font: '900 26px/1.2 var(--f-body)' }}>{copy.rules.sandTitle}</h3>
          <p>{fill(copy.rules.sandIntro, { need })}</p>
        </div>
        <div className="sand">
          <div className="panel">
            <div className="ph">
              <span className="lbl">{fill(copy.rules.sandCellsTitle, { total: candleCount, hours: (cfg?.candleSeconds ?? 3600) / 3600 })}</span>
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
                >
                  <b>{String(index + 1).padStart(2, '0')}</b>
                  {on ? <IcoOk /> : <IcoNo />}
                  <span>{on ? copy.board.cellHit : copy.board.cellMiss}</span>
                </button>
              ))}
            </div>
            <div className="presets">
              <button className="btn sm" type="button" onClick={() => applyPreset('all')}>
                {fill(copy.rules.presets.all, { total: candleCount })}
              </button>
              <button className="btn sm" type="button" onClick={() => applyPreset('need')}>
                {fill(copy.rules.presets.eight, { need })}
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
                <span>{fill(copy.rules.gaugePass, { need })}</span>
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
                  <dd className="ok">{lang === 'zh' ? '按战力比例' : 'Pro rata to weight'}</dd>
                </div>
                <div>
                  <dt>{copy.rules.outWinTotal}</dt>
                  <dd>{intFmt(stake) + ' A9'}</dd>
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
                  <dd>{board.roundId === null ? '—' : formatCompactNumber(totalStake + stake, lang) + ' A9'}</dd>
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
              <p>{fill(item.body, { count: candleCount })}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Memoised: re-renders only when its inputs change (docs/31 §5.3). */
export const RulesSandbox = memo(RulesSandboxView);
