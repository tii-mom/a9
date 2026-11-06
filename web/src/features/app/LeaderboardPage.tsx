import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useQuery } from '../../lib/api';
import { formatDateTime, formatToken, shortAddress } from '../../lib/format';
import { useDict, useLang } from '../../lib/lang';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteHeader } from '../../components/SiteHeader';
import { useWallet } from '../wallet';
import type { RoundSummary } from '@shared/types';
import {
  COMMON,
  formatPrice,
  pickCurrentRound,
  resultLabel,
  rewardMultiple,
  sharePct,
  stateShort,
  stateTone,
  TIMING_FALLBACKS,
} from './common';
import { Empty, Loading, PageHead, StatePill, Stat } from './ui';
import { QueryNotice } from '../chain/QueryNotice';
import './pages.css';

interface LbDict extends Record<string, unknown> {
  lbl: string;
  title: string;
  desc: string;
  selectorHint: string;
  summaryTotalStaked: string;
  summaryStakers: string;
  summaryPool: string;
  summaryMultiple: string;
  multipleHint: string;
  roundMetaTarget: string;
  roundMetaState: string;
  roundMetaCandles: string;
  roundMetaResult: string;
  roundMetaBurned: string;
  tableTitle: string;
  tableDesc: string;
  colRank: string;
  colAddress: string;
  colAmount: string;
  colShare: string;
  colEstReward: string;
  colAccepted: string;
  emptyTitle: string;
  emptyDesc: string;
  myRow: string;
  you: string;
  goMe: string;
  pastHint: string;
  noRound: string;
  partialRows: string;
  roundNotStarted: string;
}

const ZH: LbDict = {
  lbl: '排行榜',
  title: '排行榜',
  desc: '查看每一轮的质押地址、质押量、占比与预计奖励，以及该轮的奖励池与奖励倍数。',
  selectorHint: '选择轮次（1–10）查看往期或当前榜单',
  summaryTotalStaked: '总质押',
  summaryStakers: '地址数',
  summaryPool: '奖励池',
  summaryMultiple: '奖励倍数',
  multipleHint: '奖励池 ÷ 总质押',
  roundMetaTarget: '目标价',
  roundMetaState: '轮次状态',
  roundMetaCandles: '观察 K 线',
  roundMetaResult: '结算结果',
  roundMetaBurned: '已销毁',
  tableTitle: '质押榜单',
  tableDesc: '按质押量排序，奖励按质押比例分配',
  colRank: '排名',
  colAddress: '地址',
  colAmount: '质押量',
  colShare: '占比',
  colEstReward: '预计奖励',
  colAccepted: '质押时间',
  emptyTitle: '该轮暂无质押记录',
  emptyDesc: '还没有地址在轮次参与质押，或该轮尚未开启质押窗口。',
  myRow: '我的排名',
  you: '我',
  goMe: '查看我的质押',
  pastHint: '历史轮次为只读记录',
  noRound: '该轮数据尚未生成',
  partialRows: '榜单展示前 {shown} 名（共 {total} 个地址）',
  roundNotStarted: '该轮尚未产生质押',
};

const EN: LbDict = {
  lbl: 'Leaderboard',
  title: 'Leaderboard',
  desc: 'Stakers, stake size, share and estimated reward for every round, plus that round’s reward pool and reward multiple.',
  selectorHint: 'Pick a round (1–10) to view the current or a past leaderboard',
  summaryTotalStaked: 'Total staked',
  summaryStakers: 'Stakers',
  summaryPool: 'Reward pool',
  summaryMultiple: 'Reward multiple',
  multipleHint: 'Reward pool ÷ total staked',
  roundMetaTarget: 'Target price',
  roundMetaState: 'Round status',
  roundMetaCandles: 'Candles',
  roundMetaResult: 'Result',
  roundMetaBurned: 'Burned',
  tableTitle: 'Stake leaderboard',
  tableDesc: 'Ordered by stake size; rewards are distributed pro rata to stake',
  colRank: 'Rank',
  colAddress: 'Address',
  colAmount: 'Staked',
  colShare: 'Share',
  colEstReward: 'Est. reward',
  colAccepted: 'Staked at',
  emptyTitle: 'No stakes in this round',
  emptyDesc: 'No address has staked in this round yet, or its staking window has not opened.',
  myRow: 'My position',
  you: 'me',
  goMe: 'View my stake',
  pastHint: 'Past rounds are read-only records',
  noRound: 'This round has no data yet',
  partialRows: 'Showing top {shown} of {total} addresses',
  roundNotStarted: 'No stakes in this round yet',
};

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((acc, [key, value]) => acc.replace(`{${key}}`, String(value)), template);
}

/** 单轮榜单：key=roundId 重挂载，切换轮次不会残留上一轮数据。 */
function BoardSection({
  round,
  stakerCount,
  address,
}: {
  round: RoundSummary;
  stakerCount: number;
  address: string | null;
}) {
  const { lang } = useLang();
  const d = useDict(ZH, EN);
  const c = COMMON[lang];
  const decimals = 9;
  const query = useQuery(() => api.leaderboard(round.roundId), [round.roundId], { intervalMs: 6000 });
  const rows = query.data ?? [];

  const totalStaked = useMemo(() => {
    if (round.totalAcceptedStakeRaw && round.totalAcceptedStakeRaw !== '0') return round.totalAcceptedStakeRaw;
    try {
      return rows.reduce((sum, row) => sum + BigInt(row.amountRaw || '0'), 0n).toString();
    } catch {
      return '0';
    }
  }, [round.totalAcceptedStakeRaw, rows]);

  const myRow = useMemo(() => (address ? rows.find((row) => row.address === address) ?? null : null), [rows, address]);
  const totalAddresses = Math.max(stakerCount, rows.length);

  return (
    <>
      {myRow ? (
        <div className="note-box ap-note">
          <b>{d.myRow}</b>：{c.rank} #{myRow.rank} · {formatToken(myRow.amountRaw, decimals)} A9 ·{' '}
          {sharePct(myRow.amountRaw, totalStaked)} · {formatToken(myRow.rewardEstimateRaw, decimals)} A9
        </div>
      ) : null}

      <section className="panel ap-sec">
        <div className="ap-panel-h">
          <h3>{d.tableTitle}</h3>
          <span className="ap-muted mono-sm">{d.tableDesc}</span>
        </div>
        <div className="ap-pad"><QueryNotice query={query} lang={lang} label={d.tableTitle} /></div>
        {!query.data ? (
          query.loading && !query.error ? <div className="ap-pad"><Loading rows={4} /></div> : null
        ) : rows.length === 0 ? (
          <div className="ap-pad">
            <Empty title={d.emptyTitle} desc={d.emptyDesc} />
          </div>
        ) : (
          <>
            {totalAddresses > rows.length ? (
              <div className="ap-pad" style={{ paddingBottom: 0 }}>
                <p className="ap-muted mono-sm" style={{ margin: 0 }}>
                  {fill(d.partialRows, { shown: rows.length, total: totalAddresses })}
                </p>
              </div>
            ) : null}
            <div className="ap-table-wrap" style={{ marginTop: 10, borderLeft: 0, borderRight: 0 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{d.colRank}</th>
                    <th>{d.colAddress}</th>
                    <th>{d.colAmount}</th>
                    <th>{d.colShare}</th>
                    <th>{d.colEstReward}</th>
                    <th>{d.colAccepted}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const isMe = !!address && row.address === address;
                    return (
                      <tr key={`${row.rank}-${row.address}`} className={isMe ? 'ap-row-me' : undefined}>
                        <td>
                          <span className={`ap-rank${row.rank <= 3 ? ' top' : ''}`}>#{row.rank}</span>
                        </td>
                        <td>
                          <span className={`ap-addr${isMe ? ' me' : ''}`} title={row.address}>
                            {shortAddress(row.address, 8, 6)}
                          </span>
                          {isMe ? <span className="ap-tag">{d.you}</span> : null}
                        </td>
                        <td className="ap-num">{formatToken(row.amountRaw, 9)}</td>
                        <td className="ap-num">{sharePct(row.amountRaw, totalStaked)}</td>
                        <td className="ap-num hot">{formatToken(row.rewardEstimateRaw, 9)}</td>
                        <td className="ap-mono ap-muted">{formatDateTime(row.acceptedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}

export default function LeaderboardPage() {
  const { lang } = useLang();
  const d = useDict(ZH, EN);
  const c = COMMON[lang];
  const wallet = useWallet();

  const configQuery = useQuery(() => api.config(), [], { intervalMs: 0 });
  const roundsQuery = useQuery(() => api.rounds(), [], { intervalMs: 6000 });

  const decimals = configQuery.data?.token.decimals ?? 9;
  const rounds = useMemo(() => [...(roundsQuery.data ?? [])].sort((a, b) => a.roundId - b.roundId), [roundsQuery.data]);

  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (selected !== null || rounds.length === 0) return;
    const current = pickCurrentRound(rounds);
    setSelected(current?.roundId ?? rounds[0].roundId);
  }, [rounds, selected]);

  const round = useMemo(() => rounds.find((item) => item.roundId === selected) ?? null, [rounds, selected]);

  const totalStaked = round?.totalAcceptedStakeRaw ?? '0';
  const stakerCount = round?.stakerCount ?? 0;
  const rewardPool = round?.rewardBudgetRaw ?? configQuery.data?.roundRewardRaw ?? '0';
  const multiple = rewardMultiple(rewardPool, totalStaked, decimals);

  return (
    <>
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="wrap page ap-page">
        <PageHead
          lbl={d.lbl}
          title={d.title}
          desc={d.desc}
          right={
            <div className="ap-toolbar">
              {wallet.connected ? (
                <span className="chip ok">
                  {c.myAddress} · {shortAddress(wallet.address ?? '')}
                </span>
              ) : (
                <button className="btn ghost sm" type="button" onClick={() => wallet.connect()}>
                  {c.connectWallet}
                </button>
              )}
              <Link className="btn ghost sm" to="/me">
                {d.goMe}
              </Link>
            </div>
          }
        />

        <div className="ap-sec">
          <div className="ap-sec-h">
            <h2>{c.round}</h2>
            <p className="ap-sec-desc">{d.selectorHint}</p>
          </div>
          <QueryNotice query={roundsQuery} lang={lang} label={c.round} />
          <QueryNotice query={configQuery} lang={lang} label={lang === 'zh' ? '规则配置' : 'Rules'} />
          {roundsQuery.error && !roundsQuery.data ? null : rounds.length === 0 ? (
            roundsQuery.data ? <Empty title={d.noRound} desc={d.emptyDesc} /> : <Loading rows={2} />
          ) : (
            <div className="ap-rounds" role="group" aria-label={d.selectorHint}>
              {rounds.map((item) => {
                const tone = stateTone(item.state);
                return (
                  <button
                    key={item.roundId}
                    type="button"
                    className={tone}
                    aria-pressed={item.roundId === selected}
                    onClick={() => setSelected(item.roundId)}
                    title={`${c.round} #${item.roundId} · ${item.state}`}
                  >
                    R{item.roundId}
                    <small>{stateShort(item.state, lang)}</small>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {round ? (
          <div className="cards">
            <Stat label={d.summaryTotalStaked} value={`${formatToken(totalStaked, decimals)} A9`} />
            <Stat label={d.summaryStakers} value={stakerCount} />
            <Stat label={d.summaryPool} value={`${formatToken(rewardPool, decimals)} A9`} hint={lang === 'zh' ? '每轮预算' : 'Per round'} />
            <Stat label={d.summaryMultiple} value={multiple} hint={d.multipleHint} tone="fire" />
          </div>
        ) : null}

        {round ? (
          <section className="panel ap-sec">
            <div className="ap-panel-h">
              <h3>
                {c.round} #{round.roundId}
              </h3>
              <div className="row">
                <StatePill state={round.state} />
                <span className="ap-muted mono-sm">{d.pastHint}</span>
              </div>
            </div>
            <div className="ap-round-meta">
              <div>
                <span className="lbl">{d.roundMetaTarget}</span>
                <div className="v hot">{formatPrice(round.targetPriceUsdE8)}</div>
              </div>
              <div>
                <span className="lbl">{d.roundMetaState}</span>
                <div className="v">{stateShort(round.state, lang)}</div>
              </div>
              <div>
                <span className="lbl">{d.roundMetaCandles}</span>
                <div className="v">
                  {round.qualifiedCandles}/{round.candlesSeen} · {lang === 'zh' ? '阈值' : 'min'} {configQuery.data?.minQualifiedCandles ?? TIMING_FALLBACKS.minQualifiedCandles}
                </div>
              </div>
              <div>
                <span className="lbl">{d.roundMetaResult}</span>
                <div className="v">{resultLabel(round.result, lang)}</div>
              </div>
              <div>
                <span className="lbl">{d.roundMetaBurned}</span>
                <div className="v">{round.burnedRaw ? formatToken(round.burnedRaw, decimals) : '—'}</div>
              </div>
            </div>
          </section>
        ) : null}

        {selected === null ? (
          <div className="ap-sec">{!roundsQuery.data && !roundsQuery.error ? <Loading rows={3} /> : null}</div>
        ) : !round ? (
          <Empty title={d.noRound} desc={d.emptyDesc} />
        ) : (
          <BoardSection key={round.roundId} round={round} stakerCount={stakerCount} address={wallet.address} />
        )}
      </main>
      <SiteFooter />
    </>
  );
}
