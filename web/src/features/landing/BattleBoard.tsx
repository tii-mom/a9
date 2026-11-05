import { Link } from 'react-router-dom';
import type { MeResponse, ProtocolConfig, ProtocolStats } from '@shared/types';
import { formatPct, formatUsdE8, pad2 } from '../../lib/format';
import { useLang } from '../../lib/lang';
import { priceMultiplierOf, targetFromConfig, type BoardView, type Phase } from './derive';
import { FuseCells } from './FuseCells';
import { IcoNo, IcoOk } from './icons';
import { fill, type LandingCopy } from './landing.i18n';
import { PriceChart } from './PriceChart';
import { formatCompactToken, formatCountdown, intFmt, tokenNum, usdNum } from './utils';

interface Props {
  cfg: ProtocolConfig | null;
  stats: ProtocolStats | null;
  board: BoardView;
  secondsRemaining: number | null;
  nextStakeSeconds: number | null;
  me: MeResponse | null;
  connected: boolean;
  copy: LandingCopy;
  candleMs: number;
  claiming: boolean;
  onClaim: () => void;
}

const PHASE_CLASS: Record<Phase, string> = {
  stake: 'stk',
  observe: 'obs',
  done: 'obs',
  paused: 'obs',
  unopened: 'obs',
};

function phaseClass(board: BoardView): string {
  if (board.result === 'win') return 'win';
  if (board.result === 'lose') return 'lose';
  if (board.phase === 'done') return 'obs';
  return PHASE_CLASS[board.phase] ?? 'obs';
}

function phaseText(board: BoardView, copy: LandingCopy): string {
  if (board.result === 'win') return copy.board.phaseWin;
  if (board.result === 'lose') return copy.board.phaseLose;
  if (board.phase === 'paused') return copy.board.phasePaused;
  if (board.phase === 'unopened') return copy.board.phaseUnopened;
  if (board.phase === 'stake') return copy.board.phaseStake;
  return copy.board.phaseObserve;
}

export function BattleBoard({
  cfg,
  stats,
  board,
  secondsRemaining,
  nextStakeSeconds,
  me,
  connected,
  copy,
  candleMs,
  claiming,
  onClaim,
}: Props) {
  const { lang } = useLang();
  const decimals = cfg?.token.decimals ?? 9;
  const price = usdNum(board.priceUsdE8);
  const target = usdNum(board.targetUsdE8);
  const prev = usdNum(stats?.price24hAgoUsdE8 ?? null);
  const dirClass = price !== null && prev !== null ? (price >= prev ? 'up' : 'down') : '';
  const above = price !== null && target !== null ? price >= target : false;
  const gap = price !== null && target !== null && target > 0 ? price / target - 1 : null;
  const mult = priceMultiplierOf(cfg, board.roundId);
  const hits = board.hits;
  const miss = board.miss;
  const phase = board.phase;
  const need = board.need;
  const failAt = board.failAt;
  const missAllowance = board.missAllowance;
  const candleCount = board.candleCount;
  const rewardHuman = tokenNum(board.rewardBudgetRaw, decimals);
  const stakeHuman = tokenNum(board.totalStakeRaw, decimals);
  const myPosition = me && board.roundId !== null ? me.stakes.find((s) => s.roundId === board.roundId) ?? null : null;
  const myStakeRaw = myPosition?.amountRaw ?? null;
  const myStakeHuman = myStakeRaw ? tokenNum(myStakeRaw, decimals) : 0;
  const myRewardHuman = myStakeHuman > 0 && stakeHuman > 0 ? (rewardHuman * myStakeHuman) / stakeHuman : 0;
  const twapRaw = board.live ? board.liveTwapUsdE8 : board.candles.length > 0 ? board.candles[board.candles.length - 1].twapPriceUsdE8 : null;
  const twap = usdNum(twapRaw);
  const twapAbove = twap !== null && target !== null ? twap >= target : false;
  const oracle = stats?.oracle ?? null;
  const frozenParams = cfg?.frozenParams ?? [];
  const frozenState =
    frozenParams.length === 0
      ? null
      : frozenParams.every((item) => item.status === 'frozen')
        ? 'frozen'
        : 'pending';

  // Three countdowns: pre-announcement → staking → observation.
  const showNextStake = (phase === 'done' || phase === 'unopened') && nextStakeSeconds !== null;
  const clockLabel = showNextStake
    ? copy.board.nextStakeStarts
    : phase === 'stake'
      ? copy.board.stakeEnds
      : phase === 'observe' || phase === 'paused'
        ? copy.board.verdictIn + (cfg?.dataSource === 'demo' ? copy.board.demoAccel : '')
        : copy.board.roundLabel;
  const clockValue = showNextStake
    ? formatCountdown(nextStakeSeconds, lang)
    : phase === 'stake' || phase === 'observe' || phase === 'paused'
      ? formatCountdown(secondsRemaining, lang)
      : board.result === 'win'
        ? copy.board.settled
        : board.result === 'lose'
          ? copy.board.closed
          : '—';

  // verdict
  let verdictKey = 'open';
  let verdictTitle = copy.board.verdictOpen;
  let verdictSub = fill(copy.board.verdictOpenSub, {
    remain: board.remain,
    need: Math.max(0, need - hits),
    margin: Math.max(0, failAt - miss),
  });
  const hitsLeft = Math.max(0, need - hits);
  if (phase === 'stake') {
    verdictKey = 'stake';
    verdictTitle = fill(copy.board.verdictStake, { target: target === null ? '—' : formatUsdE8(board.targetUsdE8) });
    verdictSub = fill(copy.board.verdictStakeSub, {
      pct: gap === null ? '—' : ((target !== null && price !== null ? Math.abs(target / price - 1) : 0) * 100).toFixed(1) + '%',
    });
  } else if (board.result === 'win') {
    verdictKey = 'win';
    verdictTitle = fill(copy.board.verdictWin, { hits, total: candleCount });
    verdictSub = fill(copy.board.verdictDoneSub, { total: candleCount });
  } else if (board.result === 'lose') {
    verdictKey = 'lose';
    verdictTitle = fill(copy.board.verdictLose, { hits, total: candleCount });
    verdictSub = fill(copy.board.verdictDoneSub, { total: candleCount });
  } else if (hits >= need) {
    verdictKey = 'win';
    verdictTitle = copy.board.verdictLocked;
    verdictSub = fill(copy.board.verdictLockedSub, { hits });
  } else if (miss >= failAt) {
    verdictKey = 'lose';
    verdictTitle = copy.board.verdictLost;
    verdictSub = fill(copy.board.verdictLostSub, { miss, need });
  }

  // result numbers
  const burnedTotalRaw = board.burnedRaw ?? String(BigInt(board.rewardBudgetRaw) + BigInt(board.totalStakeRaw));
  const nextRoundId = board.roundId !== null && cfg && board.roundId < cfg.roundCount ? board.roundId + 1 : null;
  const nextTarget = targetFromConfig(cfg, nextRoundId);
  const nextMult = priceMultiplierOf(cfg, nextRoundId);

  const showMine = connected && myStakeHuman > 0 && phase !== 'stake';

  return (
    <section className="hud board" id="board" aria-label={copy.board.currentBattle} data-res={board.result ?? undefined}>
      <div className="b-head">
        <div className="b-round">
          <span className="lbl">{copy.board.currentBattle}</span>
          <h2>
            {board.roundId === null ? '--' : pad2(board.roundId)}
            <small>{fill(copy.board.ofRounds, { total: board.cfgRoundCount })}</small>
          </h2>
        </div>
        <span className={'pill ' + phaseClass(board)}>
          <i />
          {phaseText(board, copy)}
        </span>
        <div className="b-clock">
          <span className="lbl">{clockLabel}</span>
          <div className="t">{clockValue}</div>
        </div>
        <div className="oracle">
          <span>
            <i
              className="d"
              style={oracle && (oracle.paused || !oracle.online) ? { background: 'var(--fail)', boxShadow: '0 0 8px var(--fail)' } : undefined}
            />
            {oracle === null ? '—' : oracle.paused ? copy.board.oraclePaused : copy.board.oracleOnline}
          </span>
          <span>
            {oracle === null
              ? '—'
              : fill(copy.board.validSources, { valid: oracle.validSources, total: oracle.totalSources })}
          </span>
          <span>{oracle === null ? '—' : fill(copy.board.coverage, { pct: (oracle.coverageBps / 100).toFixed(1) })}</span>
          <span>
            {oracle === null || !oracle.configVersion
              ? '—'
              : fill(copy.board.configVersion, { v: oracle.configVersion }) +
                (frozenState === 'frozen'
                  ? ' · ' + copy.board.frozen
                  : frozenState === 'pending'
                    ? ' · ' + copy.board.pending
                    : '')}
          </span>
        </div>
      </div>

      <div className="b-price">
        <div>
          <span className="lbl">{copy.board.price}</span>
          <div className={'px ' + dirClass}>{price === null ? '—' : formatUsdE8(board.priceUsdE8)}</div>
          {phase === 'stake' ? (
            <span className="touch off">
              <IcoNo />
              {fill(copy.board.needRise, {
                pct: target !== null && price !== null && price > 0 ? ((target / price - 1) * 100).toFixed(1) + '%' : '—',
              })}
            </span>
          ) : (
            <span className={'touch ' + (above ? 'on' : 'off')}>
              {above ? <IcoOk /> : <IcoNo />}
              {above ? copy.board.touchedTarget : copy.board.untouchedTarget}
            </span>
          )}
        </div>
        <div>
          <span className="lbl">{fill(copy.board.targetOf, { mult: mult === null ? '2^n' : String(mult) })}</span>
          <div className="px s2 tgt">{target === null ? '—' : formatUsdE8(board.targetUsdE8)}</div>
          <div className="sub">
            {phase === 'stake'
              ? copy.board.beforeObserve
              : gap === null
                ? '—'
                : fill(gap >= 0 ? copy.board.aboveTarget : copy.board.belowTarget, { pct: formatPct(gap, 2) })}
          </div>
        </div>
        <div>
          <span className="lbl">{copy.board.twap}</span>
          <div className="px s2">{twap === null ? '—' : formatUsdE8(twapRaw)}</div>
          <div className="sub">
            {phase === 'stake' || phase === 'unopened'
              ? copy.board.twapAfterStart
              : board.live
                ? (twapAbove ? copy.board.twapTentativeHit : copy.board.twapTentativeMiss) +
                  ' · ' +
                  fill(copy.board.twapProgress, { pct: Math.round(board.liveProgress * 100) })
                : copy.board.twapLastClosed}
          </div>
        </div>
      </div>

      <PriceChart cfg={cfg} board={board} copy={copy} />
      <FuseCells board={board} copy={copy} candleMs={candleMs} />

      <div className="score">
        <div>
          <span className="lbl">{copy.board.litNeed}</span>
          <div className="big">
            {hits}
            <small>/ {need}</small>
          </div>
          <div className="segs">
            {Array.from({ length: need }).map((_, i) => (
              <i key={i} className={i < Math.min(need, hits) ? 'on' : ''} />
            ))}
          </div>
          <div className="sub">
            {phase === 'stake'
              ? copy.board.hitSubWaiting
              : hits >= need
                ? <span className="ok">{copy.board.hitSubLocked}</span>
                : fill(copy.board.hitSubNeed, { n: hitsLeft })}
          </div>
        </div>
        <div>
          <span className="lbl">{copy.board.missLine}</span>
          <div className="big">
            {miss}
            <small>/ {failAt}</small>
          </div>
          <div className="segs miss">
            {Array.from({ length: failAt }).map((_, i) => (
              <i key={i} className={i < Math.min(failAt, miss) ? 'on' : ''} />
            ))}
          </div>
          <div className="sub">
            {phase === 'stake'
              ? fill(copy.board.missSubHint, { n: missAllowance })
              : miss >= failAt
                ? <span className="bad">{copy.board.missSubTriggered}</span>
                : miss === failAt - 1
                  ? <span className="bad">{copy.board.missSubOneMore}</span>
                  : fill(copy.board.missSubLeft, { n: failAt - 1 - miss })}
          </div>
        </div>
        <div>
          <span className="lbl">{copy.board.remainCandles}</span>
          <div className="big">
            {phase === 'stake' ? candleCount : board.remain}
            <small>{copy.board.unitCandle}</small>
          </div>
          <div className="sub">
            {phase === 'stake'
              ? fill(copy.board.remSubStake, { n: candleCount })
              : (board.live ? copy.board.remSubLive : '') +
                (hits >= need ? copy.board.remSubNoNeed : fill(copy.board.remSubNeed, { n: hitsLeft }))}
          </div>
        </div>
      </div>

      <div className="verdict" data-k={verdictKey}>
        <div>
          {verdictTitle}
          <small>{verdictSub}</small>
        </div>
      </div>

      {showMine ? (
        <div className="mine">
          <span>{copy.board.mine}</span>
          <span>{fill(copy.board.myStake, { v: intFmt(myStakeHuman) })}</span>
          <span>{fill(copy.board.myReward, { v: intFmt(myRewardHuman) })}</span>
          <span className="bad">{fill(copy.board.myLoss, { v: intFmt(myStakeHuman) })}</span>
        </div>
      ) : null}

      {board.result !== null && phase === 'done' ? (
        <div className={'result ' + board.result}>
          {board.result === 'win' ? (
            <>
              <h3>{fill(copy.board.resultWinTitle, { round: pad2(board.roundId ?? 0) })}</h3>
              <p>
                {fill(copy.board.resultWinBody, {
                  hits,
                  total: candleCount,
                  reward: formatCompactToken(board.rewardBudgetRaw, decimals, lang),
                })}
                {myStakeHuman > 0
                  ? ' ' +
                    fill(copy.board.resultWinMine, {
                      stake: intFmt(myStakeHuman),
                      reward: intFmt(myRewardHuman),
                    })
                  : ''}
              </p>
              <div className="row">
                {connected && myStakeHuman > 0 ? (
                  <button className="btn fire" type="button" onClick={onClaim} disabled={claiming}>
                    {copy.board.claim}
                  </button>
                ) : null}
                <Link className="btn" to="/me">
                  {copy.common.goMe}
                </Link>
                <Link className="btn ghost" to="/leaderboard">
                  {copy.common.goLeaderboard}
                </Link>
              </div>
            </>
          ) : board.result === 'lose' ? (
            <>
              <h3>{fill(copy.board.resultLoseTitle, { round: pad2(board.roundId ?? 0) })}</h3>
              <p>
                {fill(copy.board.resultLoseBody, {
                  hits,
                  reward: formatCompactToken(board.rewardBudgetRaw, decimals, lang),
                  stake: formatCompactToken(board.totalStakeRaw, decimals, lang),
                  total: formatCompactToken(burnedTotalRaw, decimals, lang),
                })}
                {myStakeHuman > 0 ? ' ' + fill(copy.board.resultLoseMine, { stake: intFmt(myStakeHuman) }) : ''}
                {nextRoundId !== null && nextTarget !== null
                  ? ' ' +
                    fill(copy.board.resultLoseNext, {
                      next: pad2(nextRoundId),
                      mult: nextMult === null ? '2^n' : String(nextMult),
                      target: formatUsdE8(nextTarget),
                    })
                  : ''}
              </p>
              <div className="row">
                <Link className="btn" to="/me">
                  {copy.common.goMe}
                </Link>
                <Link className="btn ghost" to="/leaderboard">
                  {copy.common.goLeaderboard}
                </Link>
              </div>
            </>
          ) : (
            <>
              <h3>{fill(copy.board.resultAbortTitle, { round: pad2(board.roundId ?? 0) })}</h3>
              <p>{fill(copy.board.resultAbortBody, { count: candleCount })}</p>
              <div className="row">
                <Link className="btn" to="/me">
                  {copy.common.goMe}
                </Link>
              </div>
            </>
          )}
        </div>
      ) : null}

      {board.roundId === null ? <div className="chart-note">{copy.board.waitingRound}</div> : null}
    </section>
  );
}
