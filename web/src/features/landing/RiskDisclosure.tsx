import type { ProtocolConfig } from '@shared/types';
import { IcoWarn } from './icons';
import { fill, type LandingCopy } from './landing.i18n';

interface Props {
  cfg: ProtocolConfig | null;
  copy: LandingCopy;
}

export function RiskDisclosure({ cfg, copy }: Props) {
  return (
    <section className="sec" id="risk">
      <div className="wrap">
        <div className="hz" aria-hidden="true" />
        <div className="panel warn">
          <div className="ph" style={{ borderColor: '#3a1f12' }}>
            <span className="lbl" style={{ color: 'var(--fire-2)' }}>
              {copy.risk.lbl}
            </span>
            <span className="lbl">{fill(copy.risk.version, { version: cfg?.riskDisclosureVersion ?? 1 })}</span>
          </div>
          <ul className="warn-list">
            {copy.risk.items.map((item, index) => (
              <li key={index}>
                <IcoWarn />
                <span>
                  <b>{item.title}</b>
                  {item.body ? ' ' + item.body : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
