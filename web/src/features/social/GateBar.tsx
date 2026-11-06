import { a9Yi, gateGap, usdPrice, usdWhole } from './format';
import type { GateState } from './types';
import './social.css';

/** 本城 K 线总根数与破城所需亮灯数。 */
export const LAMP_COUNT = 24;
export const BREACH_LAMPS = 16;

/**
 * 破城进度条。攻城期显示「还差 $X 破城」，守城期显示亮灯与现价偏离。
 * 数据由调用方通过 useGate() 提供（本组件不自行轮询，避免重复请求）。
 */
export function GateBar({ gate }: { gate: GateState | null }) {
  if (!gate) {
    return (
      <section className="sx-gate" aria-busy="true" aria-label="破城进度">
        <span className="sx-skel" />
      </section>
    );
  }

  // 城门价 / 现价可能为 null（池子或 K 线缺失）：缺失时进度为 0，不做除法
  const gatePrice = gate.gatePriceUsd ?? 0;
  const price = gate.priceUsd ?? 0;
  const progress = gatePrice > 0 ? Math.min(1, Math.max(0, price / gatePrice)) : 0;
  const percent = Math.round(progress * 100);

  if (gate.phase === 'staking') {
    return (
      <section className="sx-gate" aria-label="破城进度" data-phase="staking">
        <p className="sx-gate-line">
          还差 <b className="hot">{usdWhole(gate.remainingUsd)}</b> 破城 · {gate.stakeCount} 次上车 · 奖池{' '}
          <b>{a9Yi(gate.rewardBudgetRaw)}</b> 亿 A9
        </p>
        <div className="sx-bar" role="progressbar" aria-label="现价相对城门" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <i style={{ width: `${percent}%` }} />
        </div>
      </section>
    );
  }

  if (gate.phase === 'observing') {
    const gap = gate.priceUsd !== null && gate.gatePriceUsd !== null ? gateGap(gate.priceUsd, gate.gatePriceUsd) : null;
    const lit = Math.min(LAMP_COUNT, Math.max(0, gate.litCandles));
    const seen = Math.min(LAMP_COUNT, Math.max(0, gate.candlesSeen));
    return (
      <section className="sx-gate" aria-label="守城进度" data-phase="observing">
        <p className="sx-gate-line">
          已亮 <b className={lit >= BREACH_LAMPS ? 'hot' : undefined}>{lit}/{BREACH_LAMPS}</b>
          {gap ? (
            <>
              {' '}· 现价{gap.above ? '高于' : '低于'}城门 <b>{gap.pct}%</b>
            </>
          ) : null}
        </p>
        <div className="sx-lamps" role="img" aria-label={`已亮 ${lit} 盏，共 ${LAMP_COUNT} 盏，破城需 ${BREACH_LAMPS} 盏`}>
          {Array.from({ length: LAMP_COUNT }, (_, index) => {
            const state = index < lit ? 'on' : index < seen ? 'off' : '';
            const cls = [state, index === BREACH_LAMPS - 1 ? 'breach' : ''].filter(Boolean).join(' ');
            return <i key={index} className={cls || undefined} />;
          })}
        </div>
      </section>
    );
  }

  if (gate.phase === 'preview') {
    return (
      <section className="sx-gate" aria-label="破城进度" data-phase="preview">
        <p className="sx-gate-line">
          集结中 · 城门 <b>{usdPrice(gate.gatePriceUsd)}</b>
        </p>
      </section>
    );
  }

  return (
    <section className="sx-gate" aria-label="破城进度" data-phase="settled">
      <p className="sx-gate-line">本城已结算</p>
    </section>
  );
}
