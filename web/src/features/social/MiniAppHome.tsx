import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, socialApi, useQuery } from '../../lib/api';
import { formatDuration } from '../../lib/format';
import type { RoundSummary } from '@shared/types';
import { pickCurrentRound } from '../app/common';
import { LiveCountdown } from '../landing/LiveCountdown';
import { useWallet } from '../wallet';
import { usdWhole } from './format';
import { ShareSheet } from './ShareSheet';
import { useGate } from './useGate';
import { useTelegram } from './useTelegram';
import type { GatePhase } from './types';
import './social.css';

const PHASE_LABEL: Record<GatePhase, string> = {
  preview: '集结',
  staking: '攻城',
  observing: '守城',
  settled: '已结算',
};

/** 倒计时目标：攻城期到上车截止，守城期到观察结束；其余阶段没有倒计时。 */
function roundDeadline(round: RoundSummary | null): number | null {
  if (!round) return null;
  if (round.state === 'STAKING_OPEN') return round.stakeCloseAt;
  if (round.state === 'OBSERVING') return round.observationEnd;
  return null;
}

/**
 * Telegram 小程序首页（/app）：只保留奖池、还差多少、倒计时，
 * 一个主按钮「1 GRAM 上车」，以及「喊人」。
 */
export function MiniAppHome() {
  // 仅用于 ready/expand 与把启动码写入待绑定记录；绑定本身由 App 级的 useSocialBind 完成
  useTelegram();
  const wallet = useWallet();

  const gate = useGate();
  const rounds = useQuery(() => api.rounds(), [], { intervalMs: 30_000 });
  const round = rounds.data ? pickCurrentRound(rounds.data) : null;
  const deadline = roundDeadline(round);

  const me = useQuery(() => socialApi.me(wallet.address ?? ''), [wallet.address], {
    intervalMs: 0,
    enabled: !!wallet.address,
  });
  const [shareOpen, setShareOpen] = useState(false);
  const closeShare = useCallback(() => setShareOpen(false), []);

  const g = gate.data ?? null;
  const code = me.data?.inviteCode ?? null;
  const observing = g?.phase === 'observing';

  return (
    <main id="main-content" tabIndex={-1} className="sx-page sx-home">
      <p className="sx-kicker">
        {g ? (g.roundId !== null ? `第 ${g.roundId} 城 · ${PHASE_LABEL[g.phase]}` : PHASE_LABEL[g.phase]) : '加载中'}
      </p>

      <div className="sx-stats">
        <div className="sx-stat">
          <span>奖池（美元）</span>
          <b>{g ? usdWhole(g.poolUsdt) : '—'}</b>
        </div>
        <div className="sx-stat">
          <span>{observing ? '已亮灯' : '还差'}</span>
          <b className="hot">{g ? (observing ? `${g.litCandles}/16` : usdWhole(g.remainingUsd)) : '—'}</b>
        </div>
        <div className="sx-stat">
          <span>倒计时</span>
          <b>{deadline ? <LiveCountdown targetMs={deadline} format={formatDuration} /> : '—'}</b>
        </div>
      </div>

      <Link to="/#cmd" className="btn fire sx-cta">
        1 GRAM 上车
      </Link>

      {code ? (
        <button type="button" className="btn sx-btn" onClick={() => setShareOpen(true)}>
          喊人
        </button>
      ) : (
        <button type="button" className="btn sx-btn" onClick={() => wallet.connect()}>
          连接钱包后喊人
        </button>
      )}

      {code ? (
        <ShareSheet open={shareOpen} onClose={closeShare} code={code} moment="join" gate={g} />
      ) : null}
    </main>
  );
}

export default MiniAppHome;
