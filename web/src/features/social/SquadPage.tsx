import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteHeader } from '../../components/SiteHeader';
import { ApiError, socialApi, useQuery } from '../../lib/api';
import { JunxiangCard } from '../chain';
import { useWallet } from '../wallet';
import { ErrorState, Loading, PageHead } from '../app/ui';
import { a9Compact } from './format';
import { ShareSheet } from './ShareSheet';
import { buildShareUrl, buildSquadRecruitText, buildXIntentUrl } from './shareText';
import { readPending } from './startParam';
import { SQUAD_MAX_LEVEL, nextSquadLevel, squadBonusPct } from './squadLevels';
import { openExternal } from './telegram';
import { useGate } from './useGate';
import './social.css';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return '网络错误，请稍后重试';
}

/** 我的战队：查看 / 创建 / 加入，等级进度，X 招募文案。 */
export default function SquadPage() {
  const wallet = useWallet();
  const address = wallet.address;
  const gate = useGate();
  const me = useQuery(() => socialApi.me(address ?? ''), [address], { intervalMs: 0, enabled: !!address });

  const [name, setName] = useState('');
  // 从小程序链接带来的战队码预填到「加入」输入框
  const [joinCode, setJoinCode] = useState(() => readPending()?.squad ?? '');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const squad = me.data?.squad ?? null;
  // 等级门槛与军饷加成取自本地等级表；「还差几人」只用后端 remainingToNext（按本城上车人数算）
  const next = squad ? nextSquadLevel(squad.level, squad.stakersThisRound) : null;
  const remainingToNext = squad ? squad.remainingToNext : null;
  const roundId = gate.data?.roundId ?? null;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const recruitText = squad
    ? buildSquadRecruitText({ squadName: squad.name, roundId, remaining: remainingToNext })
    : '';
  const recruitUrl = squad ? buildShareUrl(origin, squad.code, 'x') : '';

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !address) return;
    setBusy('create');
    setFormError(null);
    try {
      await socialApi.createSquad({ wallet: address, name: trimmed });
      setName('');
      me.refetch();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const onJoin = async (event: FormEvent) => {
    event.preventDefault();
    const code = joinCode.trim();
    if (!code || !address) return;
    setBusy('join');
    setFormError(null);
    try {
      await socialApi.joinSquad(code, { wallet: address });
      setJoinCode('');
      me.refetch();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(`${recruitText} ${recruitUrl}`);
      setCopied(true);
    } catch {
      setFormError('复制失败，请手动选择文案');
    }
  };

  let body: ReactNode;
  if (!address) {
    body = (
      <section className="sx-card">
        <p className="sx-hint">连接钱包后查看你的战队。</p>
        <button type="button" className="btn fire sx-btn" onClick={() => wallet.connect()}>
          连接钱包
        </button>
      </section>
    );
  } else if (me.error && !me.data) {
    body = <ErrorState error={me.error} onRetry={me.refetch} title="战队信息加载失败" />;
  } else if (!me.data) {
    body = <Loading rows={3} />;
  } else {
    body = (
      <>
        {squad ? (
          <>
            <section className="sx-card" aria-labelledby="sx-squad-title">
              <div className="sx-squad-head">
                <h2 id="sx-squad-title">
                  <b>{squad.name}</b>
                </h2>
                <span className="chip">{squad.code}</span>
                <span className="sx-lv">Lv{squad.level}</span>
              </div>
              <p className="sx-hint">
                成员 <b>{squad.memberCount}</b> 人 · 本城上车 <b>{squad.stakersThisRound}</b> 人 · 当前全队军饷 +
                {squadBonusPct(squad.level)}%
              </p>
              {next && remainingToNext !== null ? (
                <>
                  <p className="sx-hint">
                    还差 <b>{remainingToNext}</b> 人升到 L{next.level}（全队军饷 +{next.bonusPct}%）
                  </p>
                  <div
                    className="sx-bar"
                    role="progressbar"
                    aria-label="战队升级进度"
                    aria-valuemin={0}
                    aria-valuemax={next.members}
                    aria-valuenow={Math.min(squad.stakersThisRound, next.members)}
                  >
                    <i style={{ width: `${Math.min(100, (squad.stakersThisRound / next.members) * 100)}%` }} />
                  </div>
                </>
              ) : (
                <p className="sx-hint">已满级 · 全队军饷 +{squadBonusPct(SQUAD_MAX_LEVEL)}%</p>
              )}
              <div className="sx-stat-row">
                <div>
                  <span>战力</span>
                  <b>{a9Compact(me.data.stats.power)}</b>
                </div>
                <div>
                  <span>带兵</span>
                  <b>{me.data.stats.recruits}</b>
                </div>
                <div>
                  <span>阵亡勋章</span>
                  <b>{me.data.stats.medals}</b>
                </div>
              </div>
              <button type="button" className="btn fire sx-btn" onClick={() => setShareOpen(true)}>
                喊人
              </button>
            </section>

            <section className="sx-card" aria-labelledby="sx-recruit-title">
              <h2 id="sx-recruit-title">招募文案</h2>
              <p className="sx-template">
                {recruitText} <span className="sx-muted">{recruitUrl}</span>
              </p>
              <div className="sx-row">
                <button type="button" className="btn sx-btn" onClick={copyTemplate}>
                  {copied ? '已复制' : '复制文案'}
                </button>
                <button type="button" className="btn sx-btn" onClick={() => openExternal(buildXIntentUrl(recruitText, recruitUrl))}>
                  发到 X
                </button>
              </div>
            </section>
          </>
        ) : (
          <>
            <section className="sx-card" aria-labelledby="sx-create-title">
              <h2 id="sx-create-title">创建战队</h2>
              <p className="sx-hint">你将成为团长。一人一个战队，每赛季可换一次。</p>
              <form className="sx-form" onSubmit={onCreate}>
                <label htmlFor="sx-squad-name">战队名</label>
                <input
                  id="sx-squad-name"
                  value={name}
                  maxLength={12}
                  autoComplete="off"
                  placeholder="如：火种队"
                  onChange={(event) => setName(event.target.value)}
                />
                <button type="submit" className="btn fire sx-btn" disabled={busy !== null || !name.trim()}>
                  {busy === 'create' ? '创建中…' : '创建战队'}
                </button>
              </form>
            </section>

            <section className="sx-card" aria-labelledby="sx-join-title">
              <h2 id="sx-join-title">加入战队</h2>
              <form className="sx-form" onSubmit={onJoin}>
                <label htmlFor="sx-squad-code">战队码</label>
                <input
                  id="sx-squad-code"
                  value={joinCode}
                  maxLength={32}
                  autoComplete="off"
                  autoCapitalize="characters"
                  placeholder="向团长索取战队码"
                  onChange={(event) => setJoinCode(event.target.value)}
                />
                <button type="submit" className="btn sx-btn" disabled={busy !== null || !joinCode.trim()}>
                  {busy === 'join' ? '加入中…' : '加入战队'}
                </button>
              </form>
            </section>
          </>
        )}
        {formError ? (
          <p className="sx-err" role="alert">
            {formError}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="sx-page">
        <PageHead lbl="战队" title="我的战队" desc="全队人数越多，全队军饷加成越高。团长另得全队本金 1% 军饷。" />
        {body}
        {address ? <JunxiangCard address={address} demo={wallet.demo} /> : null}
        {me.data ? (
          <ShareSheet
            open={shareOpen}
            onClose={() => setShareOpen(false)}
            code={me.data.inviteCode}
            moment="squad"
            gate={gate.data}
            squadName={squad?.name ?? null}
          />
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}
