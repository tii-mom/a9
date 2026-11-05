import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApiError } from '../../lib/api';
import { api, useQuery } from '../../lib/api';
import { formatDateTime, formatToken, shortAddress } from '../../lib/format';
import { useDict, useLang } from '../../lib/lang';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteHeader } from '../../components/SiteHeader';
import { connectDemo, disconnect, useWallet } from '../wallet';
import { ChainMePanel } from '../chain';
import type { RoundSummary, StakePosition } from '@shared/types';
import { apiErrorText, COMMON, durationText, formatPrice, pickCurrentRound, resultLabel, sharePct } from './common';
import { Empty, ErrorState, Loading, PageHead, Stat, StatePill, ToastView, useToast } from './ui';
import './pages.css';

interface MeDict extends Record<string, unknown> {
  lbl: string;
  title: string;
  desc: string;
  connect: string;
  demo: string;
  disconnect: string;
  gateTitle: string;
  gateDesc: string;
  gateHint: string;
  demoNotice: string;
  readonlyNotice: string;
  statMyStake: string;
  statClaimPrincipal: string;
  statClaimReward: string;
  statTotalStaked: string;
  statTotalReward: string;
  statTotalClaimed: string;
  currentTitle: string;
  countdown: string;
  progress: string;
  qualifiedTarget: string;
  noStakeThisRound: string;
  goStake: string;
  claimTitle: string;
  claimDesc: string;
  claimEmpty: string;
  claimEmptyDesc: string;
  claimPrincipal: string;
  claimReward: string;
  claimNote: string;
  historyTitle: string;
  historyDesc: string;
  historyEmpty: string;
  historyEmptyDesc: string;
  colRound: string;
  colState: string;
  colStaked: string;
  colResult: string;
  colPrincipal: string;
  colReward: string;
  colAccepted: string;
  totalsTitle: string;
  totalsAddr: string;
  totalsMode: string;
  riskTitle: string;
  risk: string[];
  toastClaimOk: string;
  toastClaimFail: string;
  viewLb: string;
  walletTon: string;
  walletDemo: string;
}

const ZH: MeDict = {
  lbl: '我的战况',
  title: '我的战况',
  desc: '当前轮质押、可领取本金与奖励、历史轮次与累计战绩。钱包为只读连接，不会发起任何交易。',
  connect: '连接钱包',
  demo: '使用演示钱包',
  disconnect: '断开',
  gateTitle: '连接钱包查看你的战况',
  gateDesc: '连接 TON 钱包（只读）或使用演示钱包，即可查看当前轮质押、可领取与历史记录。',
  gateHint: '仅读取地址与余额，不签名、不转账；质押与领取请在首页指挥台完成。',
  demoNotice: '当前为演示钱包：地址由本地生成或取自演示数据，资金与链上数据均为演示用途。',
  readonlyNotice: '只读模式：不会发起任何交易；合约部署后开放真实质押与领取。',
  statMyStake: '当前轮质押',
  statClaimPrincipal: '可领取本金',
  statClaimReward: '可领取奖励',
  statTotalStaked: '累计质押',
  statTotalReward: '累计奖励',
  statTotalClaimed: '累计已领取',
  currentTitle: '当前轮战位',
  countdown: '距下一阶段',
  progress: '观察进度',
  qualifiedTarget: '达标线',
  noStakeThisRound: '本轮你还没有质押。',
  goStake: '前往指挥台质押',
  claimTitle: '可领取',
  claimDesc: '本金与奖励分别领取，操作幂等',
  claimEmpty: '暂无可领取',
  claimEmptyDesc: '成功结算后，本金与奖励会出现在这里；失败轮次会直接销毁，不可领取。',
  claimPrincipal: '领取本金',
  claimReward: '领取奖励',
  claimNote: '领取为主动操作，重复提交不会重复发放（后端幂等）。',
  historyTitle: '历史轮次',
  historyDesc: '你参与过的全部轮次与资金状态',
  historyEmpty: '暂无质押记录',
  historyEmptyDesc: '该地址还没有任何轮次质押。可以回到首页指挥台，在当前轮质押窗口内参与。',
  colRound: '轮次',
  colState: '状态',
  colStaked: '质押量',
  colResult: '结果',
  colPrincipal: '本金',
  colReward: '奖励',
  colAccepted: '质押时间',
  totalsTitle: '累计统计',
  totalsAddr: '地址',
  totalsMode: '连接方式',
  riskTitle: '风险提示（必读）',
  risk: [
    '本轮目标价为 P0 × 2^轮次；第 10 轮目标为初始参考价的 1024 倍。',
    '观察期 48 小时 = 12 根 4 小时 K 线，至少 8 根 TWAP ≥ 目标价才算通过。',
    '本轮价格考核失败时，本轮 7 亿枚奖励额度全部销毁。',
    '本轮价格考核失败时，本轮全部已接受质押本金 100% 销毁。',
    '预言机技术故障不按市场失败处理，不销毁质押本金。',
    '失败轮次永久关闭：不重开、不补发、不回滚。',
    '你的最大本金损失 = 本轮质押数量（可能为 100%）。',
  ],
  toastClaimOk: '领取成功：',
  toastClaimFail: '领取失败：',
  viewLb: '查看排行榜',
  walletTon: 'TON 钱包（只读）',
  walletDemo: '演示钱包',
};

const EN: MeDict = {
  lbl: 'My War',
  title: 'My War',
  desc: 'Current-round stake, claimable principal and rewards, round history and cumulative record. The wallet is read-only and never sends a transaction.',
  connect: 'Connect wallet',
  demo: 'Use demo wallet',
  disconnect: 'Disconnect',
  gateTitle: 'Connect a wallet to see your record',
  gateDesc: 'Connect a TON wallet (read-only) or use the demo wallet to see your current stake, claimables and history.',
  gateHint: 'Only address and balance are read. No signature, no transfer. Stake and claim from the home command panel.',
  demoNotice: 'Demo wallet: the address is generated locally or taken from demo data. All funds are simulated.',
  readonlyNotice: 'Read-only mode: no transactions are sent. Real staking and claiming open after contract deployment.',
  statMyStake: 'Current stake',
  statClaimPrincipal: 'Claimable principal',
  statClaimReward: 'Claimable reward',
  statTotalStaked: 'Total staked',
  statTotalReward: 'Total rewards',
  statTotalClaimed: 'Total claimed',
  currentTitle: 'Current round',
  countdown: 'Next phase in',
  progress: 'Observation',
  qualifiedTarget: 'Pass line',
  noStakeThisRound: 'You have no stake in this round yet.',
  goStake: 'Stake from the command panel',
  claimTitle: 'Claimable',
  claimDesc: 'Principal and reward are claimed separately; idempotent',
  claimEmpty: 'Nothing to claim',
  claimEmptyDesc: 'After a successful settlement, principal and reward appear here. A failed round burns them permanently.',
  claimPrincipal: 'Claim principal',
  claimReward: 'Claim reward',
  claimNote: 'Claiming is a pull action; repeated submissions never double-pay (server-side idempotent).',
  historyTitle: 'Round history',
  historyDesc: 'Every round you joined and the status of your funds',
  historyEmpty: 'No stakes yet',
  historyEmptyDesc: 'This address has no stake in any round. Go back to the command panel and join during the staking window.',
  colRound: 'Round',
  colState: 'Status',
  colStaked: 'Staked',
  colResult: 'Result',
  colPrincipal: 'Principal',
  colReward: 'Reward',
  colAccepted: 'Staked at',
  totalsTitle: 'Cumulative',
  totalsAddr: 'Address',
  totalsMode: 'Connection',
  riskTitle: 'Risk disclosure (required reading)',
  risk: [
    'Target price is P0 × 2^round; round 10 targets 1024× the initial reference price.',
    'The observation window is 48 hours = twelve 4-hour candles; at least 8 must have TWAP ≥ target.',
    'If this round fails the price test, its 700M reward budget is fully burned.',
    'If this round fails the price test, 100% of the principal accepted for this round is burned.',
    'Oracle technical failures are not treated as a market failure and never burn principal.',
    'A failed round is permanently closed: no reopen, no reissue, no rollback.',
    'Your maximum principal loss equals the amount you staked in this round (up to 100%).',
  ],
  toastClaimOk: 'Claimed: ',
  toastClaimFail: 'Claim failed: ',
  viewLb: 'View leaderboard',
  walletTon: 'TON wallet (read-only)',
  walletDemo: 'Demo wallet',
};

function principalStatus(
  stake: StakePosition,
  round: RoundSummary | undefined,
  c: typeof COMMON.zh,
): { text: string; tone: 'ok' | 'bad' | 'mute' } {
  if (!round) return { text: c.locked, tone: 'mute' };
  if (round.state === 'SUCCEEDED' || round.state === 'SETTLING_SUCCESS') {
    return stake.principalClaimed ? { text: c.claimed, tone: 'ok' } : { text: c.claimable, tone: 'ok' };
  }
  if (round.state === 'FAILED_PERMANENT' || round.state === 'SETTLING_FAILURE') return { text: c.destroyed, tone: 'bad' };
  if (round.state === 'TECHNICAL_ABORTED') {
    return stake.principalClaimed ? { text: c.claimed, tone: 'ok' } : { text: c.refundable, tone: 'ok' };
  }
  return { text: c.locked, tone: 'mute' };
}

function rewardStatus(
  stake: StakePosition,
  round: RoundSummary | undefined,
  c: typeof COMMON.zh,
): { text: string; tone: 'ok' | 'bad' | 'mute' } {
  if (!round) return { text: '—', tone: 'mute' };
  if (round.state === 'SUCCEEDED' || round.state === 'SETTLING_SUCCESS') {
    return stake.rewardClaimed ? { text: c.claimed, tone: 'ok' } : { text: c.claimable, tone: 'ok' };
  }
  if (round.state === 'FAILED_PERMANENT' || round.state === 'SETTLING_FAILURE') return { text: c.destroyed, tone: 'bad' };
  return { text: '—', tone: 'mute' };
}

/** 地址变化时整体重挂载（key=address），避免上一地址的数据短暂残留。 */
function MeDashboard({ address, demo }: { address: string; demo: boolean }) {
  const { lang } = useLang();
  const d = useDict(ZH, EN);
  const c = COMMON[lang];
  const { toast, show } = useToast();

  const configQuery = useQuery(() => api.config(), [], { intervalMs: 0 });
  const roundsQuery = useQuery(() => api.rounds(), [], { intervalMs: 5000 });
  const decimals = configQuery.data?.token.decimals ?? 9;
  const rounds = roundsQuery.data ?? [];
  const currentRound = useMemo(() => pickCurrentRound(rounds), [rounds]);
  const currentRoundId = currentRound?.roundId ?? null;

  const roundDetailQuery = useQuery(() => api.round(currentRoundId as number), [currentRoundId], {
    enabled: currentRoundId !== null,
    intervalMs: 3000,
  });
  const leaderboardQuery = useQuery(() => api.leaderboard(currentRoundId as number), [currentRoundId], {
    enabled: currentRoundId !== null,
    intervalMs: 8000,
  });
  const meQuery = useQuery(() => api.me(address), [address], { intervalMs: 4000 });

  const [claiming, setClaiming] = useState<string | null>(null);
  const roundById = useMemo(() => {
    const map = new Map<number, RoundSummary>();
    rounds.forEach((round) => map.set(round.roundId, round));
    return map;
  }, [rounds]);

  const myStake = useMemo(
    () => (meQuery.data?.stakes ?? []).find((stake) => stake.roundId === currentRoundId) ?? null,
    [meQuery.data, currentRoundId],
  );
  const myRow = useMemo(
    () => (leaderboardQuery.data ?? []).find((row) => row.address === address) ?? null,
    [leaderboardQuery.data, address],
  );

  // 只展示仍有余额可领的项（本金/奖励都领完后不再占位，直接回到空态）
  const claimable = (meQuery.data?.claimable ?? []).filter((item) => item.principalRaw !== '0' || item.rewardRaw !== '0');
  const totals = meQuery.data?.totals ?? { stakedRaw: '0', rewardRaw: '0', claimedRaw: '0' };
  const claimablePrincipal = claimable.reduce((sum, item) => sum + BigInt(item.principalRaw || '0'), 0n).toString();
  const claimableReward = claimable.reduce((sum, item) => sum + BigInt(item.rewardRaw || '0'), 0n).toString();
  const pendingCount = claimable.length;
  const history = useMemo(
    () => [...(meQuery.data?.stakes ?? [])].sort((a, b) => b.roundId - a.roundId),
    [meQuery.data],
  );

  const claim = useCallback(
    async (roundId: number, kind: 'principal' | 'reward') => {
      const key = `${roundId}:${kind}`;
      setClaiming(key);
      try {
        const result = await api.claim({ address, roundId, kind });
        meQuery.refresh();
        roundsQuery.refresh();
        show(`${d.toastClaimOk}${formatToken(result.amountRaw, decimals)} A9`, 'ok');
      } catch (error) {
        show(`${d.toastClaimFail}${apiErrorText(error as ApiError, lang)}`, 'bad');
      } finally {
        setClaiming(null);
      }
    },
    [address, meQuery.refresh, roundsQuery.refresh, show, d.toastClaimOk, d.toastClaimFail, decimals, lang],
  );

  const roundProgress = roundDetailQuery.data;
  const candlesSeen = roundProgress?.candlesSeen ?? currentRound?.candlesSeen ?? 0;
  const qualified = roundProgress?.qualifiedCandles ?? currentRound?.qualifiedCandles ?? 0;
  const candleCount = configQuery.data?.candleCount ?? 12;
  const minQualified = configQuery.data?.minQualifiedCandles ?? 8;
  const observedPct = Math.min(100, (candlesSeen / Math.max(1, candleCount)) * 100);

  return (
    <>
      {demo ? <div className="note-box ap-note">{d.demoNotice}</div> : null}
      <div className="note-box ap-note">{d.readonlyNotice}</div>
      <ChainMePanel address={address} demo={demo} />

      {meQuery.error && !meQuery.data ? <ErrorState error={meQuery.error} onRetry={meQuery.refresh} /> : null}

      <div className="cards ap-sec">
        <Stat
          label={d.statMyStake}
          value={`${myStake ? formatToken(myStake.amountRaw, decimals) : '0'} A9`}
          hint={currentRound ? `${c.round} #${currentRound.roundId}` : undefined}
        />
        <Stat
          label={d.statClaimPrincipal}
          value={`${formatToken(claimablePrincipal, decimals)} A9`}
          hint={`${pendingCount} ${lang === 'zh' ? '项' : 'items'}`}
        />
        <Stat
          label={d.statClaimReward}
          value={`${formatToken(claimableReward, decimals)} A9`}
          hint={lang === 'zh' ? '主动领取 · 幂等' : 'Pull claim · idempotent'}
        />
        <Stat label={d.statTotalStaked} value={`${formatToken(totals.stakedRaw, decimals)} A9`} />
        <Stat label={d.statTotalReward} value={`${formatToken(totals.rewardRaw, decimals)} A9`} />
        <Stat label={d.statTotalClaimed} value={`${formatToken(totals.claimedRaw, decimals)} A9`} />
      </div>

      <div className="ap-split ap-sec">
        <div className="ap-col">
          <section className="panel">
            <div className="ap-panel-h">
              <h3>{d.currentTitle}</h3>
              <div className="row">
                {currentRound ? <StatePill state={currentRound.state} /> : null}
                <Link className="btn ghost sm" to="/leaderboard">
                  {d.viewLb}
                </Link>
              </div>
            </div>
            <div className="ap-pad">
              {roundsQuery.error ? (
                <ErrorState error={roundsQuery.error} onRetry={roundsQuery.refresh} />
              ) : !currentRound ? (
                <Loading rows={3} />
              ) : (
                <>
                  <div className="ap-round-meta">
                    <div>
                      <span className="lbl">{c.round}</span>
                      <div className="v">#{currentRound.roundId}</div>
                    </div>
                    <div>
                      <span className="lbl">{c.targetPrice}</span>
                      <div className="v hot">{formatPrice(currentRound.targetPriceUsdE8)}</div>
                    </div>
                    <div>
                      <span className="lbl">{c.currentPrice}</span>
                      <div className="v">{roundProgress ? formatPrice(roundProgress.priceUsdE8) : '—'}</div>
                    </div>
                    <div>
                      <span className="lbl">{d.countdown}</span>
                      <div className="v">{roundProgress ? durationText(roundProgress.secondsRemaining, lang) : '—'}</div>
                    </div>
                    <div>
                      <span className="lbl">{d.statMyStake}</span>
                      <div className="v">{myStake ? `${formatToken(myStake.amountRaw, decimals)} A9` : '—'}</div>
                    </div>
                    <div>
                      <span className="lbl">{c.share}</span>
                      <div className="v">
                        {myStake && currentRound.totalAcceptedStakeRaw !== '0'
                          ? sharePct(myStake.amountRaw, currentRound.totalAcceptedStakeRaw)
                          : '—'}
                      </div>
                    </div>
                    <div>
                      <span className="lbl">{c.estReward}</span>
                      <div className="v">{myRow ? `${formatToken(myRow.rewardEstimateRaw, decimals)} A9` : '—'}</div>
                    </div>
                    <div>
                      <span className="lbl">{c.qualified}</span>
                      <div className="v">
                        {qualified}/{candleCount} <small className="ap-muted">/ {d.qualifiedTarget} {minQualified}</small>
                      </div>
                      <div className="ap-bar" role="progressbar" aria-valuenow={qualified} aria-valuemin={0} aria-valuemax={candleCount}>
                        <i
                          className={qualified >= minQualified ? 'pass' : ''}
                          style={{ width: `${Math.min(100, (qualified / Math.max(1, candleCount)) * 100)}%` }}
                        />
                        <u style={{ left: `${(minQualified / Math.max(1, candleCount)) * 100}%` }} />
                      </div>
                      <div className="ap-bar-lab">
                        <span>
                          {d.progress} {candlesSeen}/{candleCount}
                        </span>
                        <span>{Math.round(observedPct)}%</span>
                      </div>
                    </div>
                  </div>
                  {!myStake ? (
                    <p className="note">
                      {d.noStakeThisRound} <Link to="/#cmd">{d.goStake}</Link>
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="ap-panel-h">
              <h3>{d.historyTitle}</h3>
              <span className="ap-muted mono-sm">{d.historyDesc}</span>
            </div>
            {meQuery.loading && !meQuery.data ? (
              <div className="ap-pad">
                <Loading rows={3} />
              </div>
            ) : history.length === 0 ? (
              <div className="ap-pad">
                <Empty title={d.historyEmpty} desc={d.historyEmptyDesc}>
                  <Link className="btn fire sm" to="/#cmd">
                    {d.goStake}
                  </Link>
                </Empty>
              </div>
            ) : (
              <div className="ap-table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{d.colRound}</th>
                      <th>{d.colState}</th>
                      <th>{d.colStaked}</th>
                      <th>{d.colResult}</th>
                      <th>{d.colPrincipal}</th>
                      <th>{d.colReward}</th>
                      <th>{d.colAccepted}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((stake) => {
                      const round = roundById.get(stake.roundId);
                      const principal = principalStatus(stake, round, c);
                      const reward = rewardStatus(stake, round, c);
                      return (
                        <tr key={`${stake.roundId}-${stake.acceptedAt}`}>
                          <td className="ap-mono">#{stake.roundId}</td>
                          <td>{round ? <StatePill state={round.state} /> : <span className="ap-muted">—</span>}</td>
                          <td className="ap-num">{formatToken(stake.amountRaw, decimals)}</td>
                          <td>{resultLabel(round?.result ?? null, lang)}</td>
                          <td className={principal.tone === 'bad' ? 'bad' : principal.tone === 'ok' ? 'ok' : 'ap-muted'}>{principal.text}</td>
                          <td className={reward.tone === 'bad' ? 'bad' : reward.tone === 'ok' ? 'ok' : 'ap-muted'}>{reward.text}</td>
                          <td className="ap-mono ap-muted">{formatDateTime(stake.acceptedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="ap-col">
          <section className="panel">
            <div className="ap-panel-h">
              <h3>{d.claimTitle}</h3>
              <span className="ap-muted mono-sm">{d.claimDesc}</span>
            </div>
            <div className="ap-pad">
              {meQuery.error ? (
                <ErrorState error={meQuery.error} onRetry={meQuery.refresh} />
              ) : meQuery.loading && !meQuery.data ? (
                <Loading rows={2} />
              ) : claimable.length === 0 ? (
                <Empty title={d.claimEmpty} desc={d.claimEmptyDesc} />
              ) : (
                <div className="ap-claim">
                  {claimable.map((item) => {
                    const principalKey = `${item.roundId}:principal`;
                    const rewardKey = `${item.roundId}:reward`;
                    const hasPrincipal = item.principalRaw !== '0';
                    const hasReward = item.rewardRaw !== '0';
                    return (
                      <div className="ap-claim-item" key={item.roundId}>
                        <div className="ap-claim-main">
                          <b>
                            {c.round} #{item.roundId}
                          </b>
                          <StatePill state={item.state} />
                        </div>
                        <div>
                          <div className="lbl">{c.principal}</div>
                          <div className="ap-claim-amt">
                            {formatToken(item.principalRaw, decimals)} <small>A9</small>
                          </div>
                        </div>
                        <div>
                          <div className="lbl">{c.reward}</div>
                          <div className="ap-claim-amt">
                            {formatToken(item.rewardRaw, decimals)} <small>A9</small>
                          </div>
                        </div>
                        <div className="spacer" />
                        <div className="ap-claim-actions">
                          {hasPrincipal ? (
                            <button
                              className="btn fire sm"
                              type="button"
                              disabled={claiming !== null}
                              onClick={() => void claim(item.roundId, 'principal')}
                            >
                              {claiming === principalKey ? c.loading : d.claimPrincipal}
                            </button>
                          ) : (
                            <span className="ap-claim-done">{c.claimed}</span>
                          )}
                          {hasReward ? (
                            <button
                              className="btn ghost sm"
                              type="button"
                              disabled={claiming !== null}
                              onClick={() => void claim(item.roundId, 'reward')}
                            >
                              {claiming === rewardKey ? c.loading : d.claimReward}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  <p className="note">{d.claimNote}</p>
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="ap-panel-h">
              <h3>{d.totalsTitle}</h3>
            </div>
            <div className="ap-pad">
              <dl className="ap-kv">
                <div>
                  <dt>{d.totalsAddr}</dt>
                  <dd>{address}</dd>
                </div>
                <div>
                  <dt>{d.totalsMode}</dt>
                  <dd className="em">{demo ? d.walletDemo : d.walletTon}</dd>
                </div>
                <div>
                  <dt>{d.statTotalStaked}</dt>
                  <dd>{formatToken(totals.stakedRaw, decimals)} A9</dd>
                </div>
                <div>
                  <dt>{d.statTotalReward}</dt>
                  <dd>{formatToken(totals.rewardRaw, decimals)} A9</dd>
                </div>
                <div>
                  <dt>{d.statTotalClaimed}</dt>
                  <dd>{formatToken(totals.claimedRaw, decimals)} A9</dd>
                </div>
              </dl>
            </div>
          </section>
        </div>
      </div>

      <section className="warn ap-risk ap-sec">
        <div className="ap-risk-title">{d.riskTitle}</div>
        <ul className="warn-list">
          {d.risk.map((item) => (
            <li key={item}>
              <span aria-hidden="true">▲</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>
      <ToastView toast={toast} />
    </>
  );
}

export default function MePage() {
  const { lang } = useLang();
  const d = useDict(ZH, EN);
  const c = COMMON[lang];
  const wallet = useWallet();
  // 未连接钱包时也探测后端，保证「无后端」有明确错误态而不是空白引导
  const healthQuery = useQuery(() => api.health(), [], { enabled: !wallet.connected, intervalMs: 8000 });

  return (
    <>
      <SiteHeader />
      <main className="wrap page ap-page">
        <PageHead
          lbl={d.lbl}
          title={d.title}
          desc={d.desc}
          right={
            <div className="ap-toolbar">
              {wallet.connected ? (
                <>
                  <span className="chip ok">
                    {wallet.demo ? d.walletDemo : d.walletTon} · {shortAddress(wallet.address ?? '')}
                  </span>
                  <button className="btn ghost sm" type="button" onClick={() => disconnect()}>
                    {d.disconnect}
                  </button>
                </>
              ) : (
                <>
                  <button className="btn fire sm" type="button" disabled={wallet.connecting} onClick={() => wallet.connect()}>
                    {wallet.connecting ? c.connecting : d.connect}
                  </button>
                  <button className="btn ghost sm" type="button" onClick={() => connectDemo()}>
                    {d.demo}
                  </button>
                </>
              )}
            </div>
          }
        />

        {!wallet.connected ? (
          <div className="lock">
            <h3>{d.gateTitle}</h3>
            <p>{d.gateDesc}</p>
            <div className="row">
              <button className="btn fire" type="button" disabled={wallet.connecting} onClick={() => wallet.connect()}>
                {wallet.connecting ? c.connecting : d.connect}
              </button>
              <button className="btn ghost" type="button" onClick={() => connectDemo()}>
                {d.demo}
              </button>
            </div>
            <p className="note">{d.gateHint}</p>
            {healthQuery.error ? <ErrorState error={healthQuery.error} onRetry={healthQuery.refresh} /> : null}
          </div>
        ) : (
          <MeDashboard key={wallet.address ?? 'none'} address={wallet.address ?? ''} demo={wallet.demo} />
        )}
      </main>
      <SiteFooter />
    </>
  );
}