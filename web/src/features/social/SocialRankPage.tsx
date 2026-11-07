import { useState } from 'react';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteHeader } from '../../components/SiteHeader';
import { socialApi, useQuery } from '../../lib/api';
import { Empty, ErrorState, Loading, PageHead } from '../app/ui';
import { a9Compact } from './format';
import { powerTitle } from './rankTitle';
import { useGate } from './useGate';
import type { LeaderboardScope, LeaderboardType } from './types';
import './social.css';

/** 榜单刷新间隔（毫秒）。 */
const BOARD_POLL_MS = 30_000;

const TYPE_TABS: { key: LeaderboardType; label: string }[] = [
  { key: 'squad', label: '战队榜' },
  { key: 'power', label: '战力榜' },
  { key: 'recruit', label: '带兵榜' },
];

const SCOPE_OPTIONS: { key: LeaderboardScope; label: string }[] = [
  { key: 'round', label: '本城' },
  { key: 'season', label: '赛季' },
];

/** 后端 score 的含义随榜单类型变化：战队榜 = 全队战力，战力榜 = 战力，带兵榜 = 拉新积分（X 双倍）。 */
const SCORE_LABEL: Record<LeaderboardType, string> = {
  squad: '全队战力',
  power: '战力',
  recruit: '拉新积分',
};

/** 社交榜单：战队榜 / 战力榜 / 带兵榜，范围本城或赛季；战力榜前 100 授予称号。 */
export default function SocialRankPage() {
  const gate = useGate();
  const [type, setType] = useState<LeaderboardType>('power');
  const [scope, setScope] = useState<LeaderboardScope>('round');

  // 城号未知（null）与「尚未加载」一样视为 undefined：本城榜等待城号再请求
  const roundId = gate.data?.roundId ?? undefined;
  // 本城范围需要当前城号，城号未知时先不请求，避免请求错误的城。
  const ready = scope === 'season' || roundId !== undefined;
  const board = useQuery(
    () => socialApi.leaderboard({ type, scope, round: scope === 'round' ? roundId : undefined }),
    [type, scope, roundId],
    { intervalMs: BOARD_POLL_MS, enabled: ready },
  );
  const rows = board.data?.rows ?? [];

  return (
    <>
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="sx-page">
        <PageHead
          lbl="榜单"
          title="排行榜"
          desc="战队榜看全队战力；战力榜前 100 授予称号；带兵榜按拉新上车人数计，X 来源双倍。"
        />

        <div className="sx-tabs" role="tablist" aria-label="榜单类型">
          {TYPE_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={type === tab.key}
              onClick={() => setType(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="sx-scope" role="group" aria-label="榜单范围">
          {SCOPE_OPTIONS.map((option) => (
            <button key={option.key} type="button" aria-pressed={scope === option.key} onClick={() => setScope(option.key)}>
              {option.label}
            </button>
          ))}
        </div>

        <p className="sx-muted">
          {scope === 'round' ? (roundId !== undefined ? `第 ${roundId} 城` : '本城') : '赛季累计'} · 每 30 秒刷新
        </p>

        {!ready ? (
          <Loading rows={4} />
        ) : board.error && !board.data ? (
          <ErrorState error={board.error} onRetry={board.refetch} title="榜单加载失败" />
        ) : !board.data ? (
          <Loading rows={4} />
        ) : rows.length === 0 ? (
          <Empty title="暂无数据" desc={scope === 'round' ? '本城还没有人上车。' : '本赛季还没有记录。'} />
        ) : (
          <div className="sx-table-wrap">
            <table className="sx-table">
              <thead>
                <tr>
                  <th scope="col">名次</th>
                  <th scope="col">名称</th>
                  <th scope="col" className="num">
                    {SCORE_LABEL[type]}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const title = type === 'power' ? powerTitle(row.rank) : null;
                  // 战队榜 key 为战队码、name 为战队名；其它榜 key 为脱敏钱包、name 为空
                  return (
                    <tr key={`${row.rank}-${row.key}`}>
                      <td>
                        <span className={`sx-rank${row.rank <= 3 ? ' top' : ''}`}>#{row.rank}</span>
                      </td>
                      <td>
                        <span className="sx-name">
                          {row.name ?? row.key}
                          {title ? <span className="sx-title">{title}</span> : null}
                        </span>
                        {type === 'squad' && row.name !== null ? <span className="sx-sub">{row.key}</span> : null}
                      </td>
                      <td className="num">{type === 'recruit' ? Number(row.score).toLocaleString('en-US') : a9Compact(row.score)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
