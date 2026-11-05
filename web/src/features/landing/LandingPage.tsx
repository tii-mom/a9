import { useCallback, useEffect, useRef, useState } from 'react';
import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';
import { api } from '../../lib/api';
import { formatToken } from '../../lib/format';
import { useCopy, fill } from './landing.i18n';
import './landing.css';
import { useLandingData } from './useLandingData';
import { Tape } from './Tape';
import { Hero } from './Hero';
import { BattleBoard } from './BattleBoard';
import { CommandPanel } from './CommandPanel';
import { OrderFlow } from './OrderFlow';
import { RoundLadder } from './RoundLadder';
import { RulesSandbox } from './RulesSandbox';
import { SupplyAllocation } from './SupplyAllocation';
import { RiskDisclosure } from './RiskDisclosure';

export default function LandingPage() {
  const copy = useCopy();
  const data = useLandingData();
  const { board, cfg, stats, trades, book, me, wallet, rounds, secondsRemaining, nextStakeSeconds, candleMs, refreshAll } = data;

  const [tab, setTab] = useState<'buy' | 'stake'>('buy');
  const [claiming, setClaiming] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    setToastVisible(true);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastVisible(false), 2800);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const openCommand = (next: 'buy' | 'stake') => {
    setTab(next);
    const el = document.getElementById('cmd');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const onClaim = async () => {
    const address = data.address;
    const roundId = board.roundId;
    if (!address || roundId === null) {
      toast(copy.cmd.toastNeedWallet);
      return;
    }
    setClaiming(true);
    let total = BigInt(0);
    let claimed = 0;
    try {
      const principal = await api.claim({ address, roundId, kind: 'principal' });
      if (principal.claimed) {
        total += BigInt(principal.amountRaw);
        claimed += 1;
      }
    } catch {
      /* already claimed or unavailable */
    }
    try {
      const reward = await api.claim({ address, roundId, kind: 'reward' });
      if (reward.claimed) {
        total += BigInt(reward.amountRaw);
        claimed += 1;
      }
    } catch {
      /* already claimed or unavailable */
    }
    setClaiming(false);
    if (claimed === 0) {
      toast(copy.cmd.toastClaimNone);
      return;
    }
    toast(fill(copy.cmd.toastClaimOk, { amount: formatToken(total.toString(), cfg?.token.decimals ?? 9) }));
    refreshAll();
    wallet.refreshBalances();
  };

  return (
    <>
      <SiteHeader tape={<Tape cfg={cfg} stats={stats} board={board} trades={trades} copy={copy} />} isLanding />
      <main id="top">
        <Hero copy={copy} onTab={setTab} />
        <div className="wrap term" id="war">
          <BattleBoard
            cfg={cfg}
            stats={stats}
            board={board}
            secondsRemaining={secondsRemaining}
            nextStakeSeconds={nextStakeSeconds}
            me={me}
            connected={wallet.connected}
            copy={copy}
            candleMs={candleMs}
            claiming={claiming}
            onClaim={onClaim}
          />
          <CommandPanel
            cfg={cfg}
            stats={stats}
            board={board}
            secondsRemaining={secondsRemaining}
            me={me}
            wallet={wallet}
            copy={copy}
            tab={tab}
            setTab={setTab}
            toast={toast}
            onRefresh={refreshAll}
          />
        </div>
        <OrderFlow cfg={cfg} stats={stats} board={board} trades={trades} book={book} copy={copy} />
        <RoundLadder cfg={cfg} rounds={rounds} copy={copy} />
        <RulesSandbox cfg={cfg} board={board} copy={copy} />
        <SupplyAllocation cfg={cfg} rounds={rounds} copy={copy} />
        <RiskDisclosure cfg={cfg} copy={copy} />
      </main>
      <SiteFooter />
      <div className="mcta">
        <button className="btn" type="button" onClick={() => openCommand('buy')}>
          {copy.mcta.buy}
        </button>
        <button className="btn fire" type="button" onClick={() => openCommand('stake')}>
          {copy.mcta.stake}
        </button>
      </div>
      <div className={'toast' + (toastVisible ? ' show' : '')} role="status" aria-live="polite">
        {toastMessage}
      </div>
    </>
  );
}
