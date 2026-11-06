import { useCallback, useEffect, useRef, useState } from 'react';
import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLang } from '../../lib/lang';
import { useCopy } from './landing.i18n';
import './landing.css';
import { useLandingData } from './useLandingData';
import { BUY_ENTRY_OPEN } from './flags';
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

  const [tab, setTab] = useState<'buy' | 'stake'>(BUY_ENTRY_OPEN ? 'buy' : 'stake');
  const navigate = useNavigate();
  const location = useLocation();
  const { lang } = useLang();
  const zh = lang === 'zh';
  useEffect(() => {
    const action = new URLSearchParams(location.search).get('action');
    if (action === 'stake' || (action === 'buy' && BUY_ENTRY_OPEN)) setTab(action);
  }, [location.search, location.key]);
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
    if (el) { el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); el.focus({ preventScroll: true }); }
  };

  const onClaim = () => navigate('/me');

  return (
    <>
      <SiteHeader tape={<Tape cfg={cfg} stats={stats} board={board} trades={trades} copy={copy} />} isLanding />
      <main id="main-content" tabIndex={-1}>
        <span id="top" />
        <Hero copy={copy} cfg={cfg} board={board} onTab={setTab} />
        <div className={"wrap data-health" + (data.error || data.stale ? " degraded" : "")} role="status" aria-live="polite">
          <span>{data.loading && !data.error ? copy.common.loading : data.error ? (zh ? "部分数据刷新失败 · 显示上次可用数据" : "Some feeds failed · showing last available data") : data.stale ? (zh ? "数据已过期 · 等待刷新" : "Data is stale · awaiting refresh") : (zh ? "数据已更新" : "Data updated")}{data.updatedAt ? ` · ${new Date(data.updatedAt).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""} · {cfg?.dataSource === "demo" ? (zh ? "演示环境" : "Demo environment") : cfg?.network ?? "—"}</span>
          {data.error || data.stale ? <button className="btn sm" type="button" onClick={refreshAll}>{copy.common.retry}</button> : null}
        </div>
        <div className="wrap term" id="war" tabIndex={-1}>
          {!cfg || board.roundId === null ? <section className="hud board empty" role="status">{data.error ? copy.common.apiDown : data.loading ? copy.common.loading : copy.board.waitingRound}</section> : <BattleBoard
            cfg={cfg}
            stats={stats}
            board={board}
            secondsRemaining={secondsRemaining}
            nextStakeSeconds={nextStakeSeconds}
            me={me}
            connected={wallet.connected}
            copy={copy}
            candleMs={candleMs}
            claiming={false}
            onClaim={onClaim}
          />}
          <CommandPanel
            cfg={cfg}
            stats={stats}
            board={board}
            dataReady={!data.loading && !data.error && !data.stale}
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
        <OrderFlow health={data.flowHealth} cfg={cfg} stats={stats} board={board} trades={trades} book={book} copy={copy} />
        <RoundLadder cfg={cfg} rounds={rounds} copy={copy} />
        <RulesSandbox cfg={cfg} board={board} copy={copy} />
        <SupplyAllocation cfg={cfg} rounds={rounds} copy={copy} />
        <RiskDisclosure cfg={cfg} copy={copy} />
      </main>
      <SiteFooter />
      <div className="mcta">
        <button className="btn fire" type="button" onClick={() => { if (board.phase === 'done') navigate('/me'); else if (board.state === 'STAKING_OPEN') openCommand('stake'); else { const el = document.getElementById('war'); el?.scrollIntoView({ behavior: 'auto', block: 'start' }); el?.focus({ preventScroll: true }); } }}>
          {board.state === 'STAKING_OPEN' ? copy.hero.ctaStake : board.phase === 'done' ? copy.common.goMe : zh ? '查看本轮' : 'Round status'}
        </button>
      </div>
      <div className={'toast' + (toastVisible ? ' show' : '')} role="status" aria-live="polite">
        {toastMessage}
      </div>
    </>
  );
}
