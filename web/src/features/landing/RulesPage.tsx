import { Link } from 'react-router-dom';
import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';
import { useLang } from '../../lib/lang';
import { useCopy } from './landing.i18n';
import './landing.css';
import { useLandingData } from './useLandingData';
import { Tape } from './Tape';
import { RoundLadder } from './RoundLadder';
import { RulesSandbox } from './RulesSandbox';
import { SupplyAllocation } from './SupplyAllocation';
import { RiskDisclosure } from './RiskDisclosure';

/** Rules, round ladder, supply and risk disclosure. Split out of the battlefield page so the first screen is the live round (docs/31 §4.1). */
export default function RulesPage() {
  const copy = useCopy();
  const { lang } = useLang();
  const zh = lang === 'zh';
  const data = useLandingData();
  const { board, cfg, stats, trades, rounds } = data;
  return (
    <>
      <SiteHeader tape={<Tape cfg={cfg} stats={stats} board={board} trades={trades} copy={copy} />} />
      <main id="main-content" tabIndex={-1}>
        <header className="wrap rules-head">
          <Link className="rules-back" to="/">{zh ? '← 返回战场' : '← Back to the battlefield'}</Link>
          <h1>{zh ? '规则与风险' : 'Rules and risk'}</h1>
          <p>{zh ? '规则写进合约：没有管理员、不可升级。价格由单一 keeper 提交；keeper 不能修改已开始轮次的目标价和 K 线阈值。' : 'Rules are enforced by the contract: no admin, no upgrades. Prices are submitted by a single keeper, which cannot change the target price or candle threshold of a round that has started.'}</p>
        </header>
        <RoundLadder cfg={cfg} rounds={rounds} copy={copy} />
        <RulesSandbox cfg={cfg} board={board} copy={copy} />
        <SupplyAllocation cfg={cfg} rounds={rounds} copy={copy} />
        <RiskDisclosure cfg={cfg} copy={copy} />
      </main>
      <SiteFooter />
    </>
  );
}
