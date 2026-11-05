import type { ProtocolConfig, RoundSummary } from '@shared/types';
import { ladderLetter } from './derive';
import type { LandingCopy } from './landing.i18n';

interface Props {
  cfg: ProtocolConfig | null;
  rounds: RoundSummary[];
  copy: LandingCopy;
}

export function SupplyAllocation({ cfg, rounds, copy }: Props) {
  const roundCount = cfg?.roundCount ?? 10;
  const letters = Array.from({ length: roundCount }).map((_, index) => {
    const round = rounds.find((item) => item.roundId === index + 1);
    return ladderLetter(round?.state);
  });

  return (
    <section className="sec" id="supply">
      <div className="wrap">
        <div className="sec-h">
          <span className="lbl">{copy.supply.lbl}</span>
          <h2>{copy.supply.title}</h2>
          <p>{copy.supply.intro}</p>
        </div>
        <div className="alloc" role="img" aria-label={copy.supply.aria}>
          {letters.map((letter, index) => (
            <div className={'r ' + letter} style={{ flex: '7 1 0' }} key={index}>
              <b>{'R' + (index + 1)}</b>
              <span>7%</span>
            </div>
          ))}
          <div className="liq" style={{ flex: '13 1 0' }}>
            <b>{copy.supply.liq}</b>
            <span>13%</span>
          </div>
          <div className="team" style={{ flex: '12 1 0' }}>
            <b>{copy.supply.team}</b>
            <span>12%</span>
          </div>
          <div className="mkt" style={{ flex: '5 1 0' }}>
            <b>{copy.supply.mkt}</b>
            <span>5%</span>
          </div>
        </div>
        <div className="panel scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>{copy.supply.tableHead.name}</th>
                <th>{copy.supply.tableHead.pct}</th>
                <th>{copy.supply.tableHead.amount}</th>
              </tr>
            </thead>
            <tbody>
              {copy.supply.rows.map((row, index) => (
                <tr key={index}>
                  <td>{index === copy.supply.rows.length - 1 ? <b>{row.name}</b> : row.name}</td>
                  <td className="n">{row.pct}</td>
                  <td className="n">{row.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}