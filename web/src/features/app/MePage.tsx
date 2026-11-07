import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApiError } from '../../lib/api';
import { api, useQuery } from '../../lib/api';
import { formatDateTime, formatToken, shortAddress } from '../../lib/format';
import { useDict, useLang } from '../../lib/lang';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteHeader } from '../../components/SiteHeader';
import { connectDemo, disconnect, DEMO_WALLET_ENABLED, useWallet } from '../wallet';
import { ChainMePanel, JunxiangCard } from '../chain';
import { DEFAULT_MIN_STAKE_TOKENS } from '../chain/protocol';
import type { ProtocolConfig, RoundPosition, RoundSummary, StakePosition } from '@shared/types';
import {
  apiErrorText,
  COMMON,
  durationText,
  fillTemplate,
  formatPrice,
  hoursOf,
  pickCurrentRound,
  resultLabel,
  sharePct,
  TIMING_FALLBACKS,
} from './common';
import { Empty, ErrorState, Loading, PageHead, Stat, StatePill, ToastView, useToast } from './ui';
import { deriveChainConfig } from '../chain/config';
import { QueryNotice } from '../chain/QueryNotice';
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
  chainNotice: string;
  chainClaimHint: string;
  chainDesc: string;
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
  claimBoth: string;
  claimNote: string;
  claimPrincipal: string;
  claimImmediate: string;
  claimLocked: string;
  claimLockedNote: string;
  claimUnlocked: string;
  claimRewardHint: string;
  toastNothing: string;
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
  lbl: '我的质押',
  title: '我的质押',
  desc: '查看当前轮仓位、待处理权益与历史记录。真实链上操作需单独确认签名。',
  connect: '连接钱包',
  demo: '使用演示钱包',
  disconnect: '断开',
  gateTitle: '连接钱包查看你的质押',
  gateDesc: '连接 GRAM 钱包查看你的记录，或主动选择演示账户体验。',
  gateHint: '连接仅共享地址。真实质押与领取均需逐笔确认签名；演示操作不涉及真实资产。',
  demoNotice: '当前为演示账户：可能采用公开榜单地址展示示例记录，余额为模拟值，不代表你控制该地址。',
  readonlyNotice: '当前仅展示账户记录，真实链上操作尚未启用。',
  chainNotice: '链上模式：在下方交易面板操作，每笔交易均需钱包确认签名。',
  chainClaimHint: '链上领取请使用上方「链上操作」面板（链上交易需钱包签名）；本页不再提供演示领取。',
  chainDesc: '当前轮质押、可领取本金与奖励、历史轮次与累计记录；链上质押与领取请在「链上交易」面板签名完成。',
  statMyStake: '当前轮质押',
  statClaimPrincipal: '可领取本金',
  statClaimReward: '可领取奖励',
  statTotalStaked: '累计质押',
  statTotalReward: '累计奖励',
  statTotalClaimed: '累计已领取',
  currentTitle: '当前轮仓位',
  countdown: '距下一阶段',
  progress: '观察进度',
  qualifiedTarget: '达标线',
  noStakeThisRound: '本轮你还没有质押。',
  goStake: '前往交易台质押',
  claimTitle: '可领取',
  claimDesc: '成功轮：本金 + 20% 立即奖励；80% 压城按解锁领取',
  claimEmpty: '暂无可领取',
  claimEmptyDesc: '成功结算后，本金与奖励会出现在这里；失败轮次会直接销毁，不可领取。',
  claimBoth: '一键领取',
  claimNote: '这些按钮仅更新演示记录，不发送链上交易。',
  claimPrincipal: '本金',
  claimImmediate: '立即 20%',
  claimLocked: '压城 80%',
  claimLockedNote: '后续任一城破城即全部解锁；否则第 10 城结束后线性解锁。',
  claimUnlocked: '已解锁',
  claimRewardHint: '20% 立即 + 已解锁的压城部分',
  toastNothing: '暂无可领取的资产',
  historyTitle: '历史轮次',
  historyDesc: '你参与过的全部轮次与资金状态',
  historyEmpty: '暂无质押记录',
  historyEmptyDesc: '该地址还没有任何轮次质押。可以回到首页交易台，在当前轮质押窗口内参与。',
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
    '目标价按档位 P0 × 2^tier（tier = 1 + 已成功轮数，失败同档重试）；最高档为初始参考价的 1024 倍。',
    '单轮 72 小时：{previewHours} 小时预告 → {stakeHours} 小时报名 → {observationHours} 小时观察（{candleCount} 根 {candleHours} 小时 K 线，至少 {need} 根 TWAP ≥ 目标价才算通过）。',
    '本轮价格考核失败时，本轮 7 亿枚奖励额度全部销毁。',
    '本轮价格考核失败时，本轮全部已接受质押本金 100% 销毁。',
    '价格由单一 keeper 热钱包提交（无多签、无独立预言机）；keeper 密钥被盗可提交伪造价格，导致本轮被判失败并销毁本金。',
    '价格提交出现技术故障（超时 7 天）时本轮技术终止，全额退回本金，不按市场失败处理。',
    '单笔最低 {minStake} A9。直接转账且低于 {minStake} A9、又没有附带足够 GRAM（forward < 0.1）的 A9 不退回。',
    '失败轮次永久关闭：不重开、不补发、不回滚。',
    '你的最大本金损失 = 本轮质押数量（可能为 100%）。',
  ],
  toastClaimOk: '领取成功：',
  toastClaimFail: '领取失败：',
  viewLb: '查看排行榜',
  walletTon: 'GRAM 钱包（只读）',
  walletDemo: '演示钱包',
};

const EN: MeDict = {
  lbl: 'My Stake',
  title: 'My Stake',
  desc: 'View current positions, pending rewards and history. Live transactions require a separate wallet signature.',
  connect: 'Connect wallet',
  demo: 'Use demo wallet',
  disconnect: 'Disconnect',
  gateTitle: 'Connect a wallet to see your stake',
  gateDesc: 'Connect a GRAM wallet to see your records, or explicitly select a demo account to explore.',
  gateHint: 'Connecting shares your address. Each live stake or claim needs a separate signature. Demo actions use no real assets.',
  demoNotice: 'Demo account: a public leaderboard address may be used for sample records. Balances are simulated; this does not mean you control the address.',
  readonlyNotice: 'Account records only. Live transactions are not enabled in this environment.',
  chainNotice: 'On-chain mode: use the transaction panels below. Every transaction requires wallet confirmation.',
  chainClaimHint: 'Claim on-chain from the On-chain panel above (a wallet signature is required). Demo claiming is disabled on this page.',
  chainDesc: 'Current-round stake, claimable principal and rewards, round history and cumulative record. On-chain stake and claim are signed from the On-chain panel.',
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
  goStake: 'Stake from the trade desk',
  claimTitle: 'Claimable',
  claimDesc: 'Successful round: principal + 20% reward now; 80% unlocks over time',
  claimEmpty: 'Nothing to claim',
  claimEmptyDesc: 'After a successful settlement, principal and reward appear here. A failed round burns them permanently.',
  claimBoth: 'Claim now',
  claimNote: 'These buttons update demo records only and do not send on-chain transactions.',
  claimPrincipal: 'Principal',
  claimImmediate: 'Immediate 20%',
  claimLocked: 'Locked 80%',
  claimLockedNote: 'Unlocks in full when any later round succeeds; otherwise linearly after round 10.',
  claimUnlocked: 'Unlocked',
  claimRewardHint: '20% now + unlocked part of the locked 80%',
  toastNothing: 'Nothing to claim yet',
  historyTitle: 'Round history',
  historyDesc: 'Every round you joined and the status of your funds',
  historyEmpty: 'No stakes yet',
  historyEmptyDesc: 'This address has no stake in any round. Go back to the trade desk and join during the staking window.',
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
    'Target price follows the tier ladder P0 × 2^tier (tier = 1 + successful rounds; a failed round retries the same tier); the top tier is 1024× the initial reference price.',
    'Each round is 72 hours: {previewHours}h preview → {stakeHours}h staking → {observationHours}h observation ({candleCount} × {candleHours}-hour candles; at least {need} must have TWAP ≥ target to pass).',
    'If this round fails the price test, its 700M reward budget is fully burned.',
    'If this round fails the price test, 100% of the principal accepted for this round is burned.',
    'Prices are submitted by a single keeper hot wallet (no multisig, no independent oracle); a stolen keeper key could submit fake prices, failing the round and burning principal.',
    'If price submission stalls (7-day timeout) the round is technically aborted and principal is returned in full; this is not treated as a market failure.',
    'Minimum stake is {minStake} A9. A direct transfer below {minStake} A9 sent without enough GRAM attached (forward < 0.1) is not refunded.',
    'A failed round is permanently closed: no reopen, no reissue, no rollback.',
    'Your maximum principal loss equals the amount you staked in this round (up to 100%).',
  ],
  toastClaimOk: 'Claimed: ',
  toastClaimFail: 'Claim failed: ',
  viewLb: 'View leaderboard',
  walletTon: 'GRAM wallet (read-only)',
  walletDemo: 'Demo wallet',
};

function principalStatus(
  stake: StakePosition,
  round: RoundSummary | undefined,
  c: typeof COMMON.zh,
): { text: string; tone: 'ok' | 'bad' | 'mute' } {
  if (!round) return { text: c.locked, tone: 'mute' };
  if (round.state === 'SUCCEEDED' || round.state === 'SETTLING_SUCCESS') {
    return stake.claimed ? { text: c.claimed, tone: 'ok' } : { text: c.claimable, tone: 'ok' };
  }
  if (round.state === 'FAILED_PERMANENT' || round.state === 'SETTLING_FAILURE') return { text: c.destroyed, tone: 'bad' };
  if (round.state === 'TECHNICAL_ABORTED') {
    return stake.claimed ? { text: c.claimed, tone: 'ok' } : { text: c.refundable, tone: 'ok' };
  }
  return { text: c.locked, tone: 'mute' };
}

function rewardStatus(
  stake: StakePosition,
  round: RoundSummary | undefined,
  c: typeof COMMON.zh,
  position: RoundPosition | undefined,
): { text: string; tone: 'ok' | 'bad' | 'mute' } {
  if (!round) return { text: '—', tone: 'mute' };
  if (round.state === 'SUCCEEDED' || round.state === 'SETTLING_SUCCESS') {
    // v11：按 rounds[] 的 20% / 80% 压城口径展示；无拆分数据时退回整体状态
    if (position) {
      if (BigInt(position.claimableRewardRaw) > 0n) return { text: c.claimable, tone: 'ok' };
      const locked = BigInt(position.lockedRaw);
      if (locked > 0n && BigInt(position.lockedClaimedRaw) < locked) {
        return { text: `${c.locked} ${Math.round((Number(position.unlockedRaw) / Number(locked)) * 100)}%`, tone: 'mute' };
      }
      return { text: c.claimed, tone: 'ok' };
    }
    return stake.claimed ? { text: c.claimed, tone: 'ok' } : { text: c.claimable, tone: 'ok' };
  }
  if (round.state === 'FAILED_PERMANENT' || round.state === 'SETTLING_FAILURE') return { text: c.destroyed, tone: 'bad' };
  return { text: '—', tone: 'mute' };
}

/** 地址变化时整体重挂载（key=address），避免上一地址的数据短暂残留。 */
function MeDashboard({
  address,
  demo,
  config,
  chainMode,
}: {
  address: string;
  demo: boolean;
  config: ProtocolConfig | null;
  chainMode: boolean;
}) {
  const { lang } = useLang();
  const d = useDict(ZH, EN);
  const c = COMMON[lang];
  const { toast, show } = useToast();

  const roundsQuery = useQuery(() => api.rounds(), [], { intervalMs: 5000 });
  const decimals = config?.token.decimals ?? 9;
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

  // v11 每城拆分（/api/me rounds[]）：本金 + 20% 立即 + 80% 压城（随解锁可领）
  const positions = useMemo(() => meQuery.data?.rounds ?? [], [meQuery.data]);
  const positionById = useMemo(() => new Map(positions.map((item) => [item.roundId, item])), [positions]);
  // 只展示仍可领或仍有压城未解锁余额的城（全部领完且压城已付清后回到空态）
  const claimRows = positions.filter(
    (item) => BigInt(item.claimableRaw || '0') > 0n || (BigInt(item.lockedRaw || '0') > 0n && BigInt(item.lockedClaimedRaw || '0') < BigInt(item.lockedRaw)),
  );
  const totals = meQuery.data?.totals ?? { stakedRaw: '0', rewardRaw: '0', claimedRaw: '0' };
  const claimablePrincipal = positions.reduce((sum, item) => sum + BigInt(item.claimablePrincipalRaw || '0'), 0n).toString();
  const claimableReward = positions.reduce((sum, item) => sum + BigInt(item.claimableRewardRaw || '0'), 0n).toString();
  const pendingCount = claimRows.length;
  const history = useMemo(
    () => [...(meQuery.data?.stakes ?? [])].sort((a, b) => b.roundId - a.roundId),
    [meQuery.data],
  );

  // v11：一次领取 = 本金 + 20% 立即 + 已解锁压城（与 worker handleClaim 一致，单次请求）
  const claim = useCallback(
    async (roundId: number) => {
      if (!demo || chainMode || claiming !== null || !meQuery.data || meQuery.error) return;
      const position = positionById.get(roundId);
      if (!position || BigInt(position.claimableRaw || '0') === 0n) return;
      setClaiming(String(roundId));
      try {
        // kind 为旧接口的必填字段，服务端不据此分账（金额由 rounds[] 口径决定）
        const result = await api.claim({ address, roundId, kind: 'principal' });
        meQuery.refresh();
        roundsQuery.refresh();
        if (result.claimed) show(`${d.toastClaimOk}${formatToken(result.amountRaw || '0', decimals)} A9`, 'ok');
        else show(`${d.toastClaimFail}${d.toastNothing}`, 'bad');
      } catch (error) {
        show(`${d.toastClaimFail}${apiErrorText(error as ApiError, lang)}`, 'bad');
      } finally {
        setClaiming(null);
      }
    },
    [demo, chainMode, claiming, meQuery.data, meQuery.error, positionById, address, meQuery.refresh, roundsQuery.refresh, show, d.toastClaimOk, d.toastClaimFail, d.toastNothing, decimals, lang],
  );

  const roundProgress = roundDetailQuery.data;
  const candlesSeen = roundProgress?.candlesSeen ?? currentRound?.candlesSeen ?? 0;
  const qualified = roundProgress?.qualifiedCandles ?? currentRound?.qualifiedCandles ?? 0;
  const candleCount = config?.candleCount ?? TIMING_FALLBACKS.candleCount;
  const minQualified = config?.minQualifiedCandles ?? TIMING_FALLBACKS.minQualifiedCandles;
  const observedPct = Math.min(100, (candlesSeen / Math.max(1, candleCount)) * 100);
  // 风险文案中的时间/根数一律来自 /api/config（V7：12h 预告 / 36h 报名 / 24h 观察 / 24 根 × 1h / 阈值 16）
  const riskVars = useMemo(
    () => ({
      previewHours: hoursOf(config?.previewSeconds, TIMING_FALLBACKS.previewSeconds),
      stakeHours: hoursOf(config?.stakeDurationSeconds, TIMING_FALLBACKS.stakeDurationSeconds),
      observationHours: hoursOf(config?.observationSeconds, TIMING_FALLBACKS.observationSeconds),
      candleHours: hoursOf(config?.candleSeconds, TIMING_FALLBACKS.candleSeconds),
      candleCount: config?.candleCount ?? TIMING_FALLBACKS.candleCount,
      need: config?.minQualifiedCandles ?? TIMING_FALLBACKS.minQualifiedCandles,
      minStake: formatToken(config?.minStakeRaw ?? (DEFAULT_MIN_STAKE_TOKENS * 1_000_000_000n).toString(), decimals),
    }),
    [config, decimals],
  );
  const riskItems = useMemo(() => d.risk.map((item) => fillTemplate(item, riskVars)), [d.risk, riskVars]);

  return (
    <>
      {demo ? <div className="note-box ap-note">{d.demoNotice}</div> : null}
      {chainMode ? (
        <div className="note-box ap-note">{d.chainNotice}</div>
      ) : (
        <div className="note-box ap-note">{d.readonlyNotice}</div>
      )}
      {chainMode ? <ChainMePanel address={address} demo={demo} /> : null}
      {chainMode && address ? <JunxiangCard address={address} demo={demo} /> : null}

      <QueryNotice query={meQuery} lang={lang} label={lang === 'zh' ? '账户' : 'Account'} />
      <QueryNotice query={roundsQuery} lang={lang} label={lang === 'zh' ? '轮次' : 'Rounds'} />
      <QueryNotice query={roundDetailQuery} lang={lang} label={lang === 'zh' ? '轮次进度' : 'Round progress'} />
      <QueryNotice query={leaderboardQuery} lang={lang} label={lang === 'zh' ? '排名' : 'Rank'} />

      <div className="cards ap-sec">
        <Stat
          label={d.statMyStake}
          value={meQuery.data && roundsQuery.data ? `${myStake ? formatToken(myStake.amountRaw, decimals) : '0'} A9` : '—'}
          hint={currentRound ? `${c.round} #${currentRound.roundId}` : undefined}
        />
        <Stat
          label={d.statClaimPrincipal}
          value={meQuery.data ? `${formatToken(claimablePrincipal, decimals)} A9` : '—'}
          hint={meQuery.data ? `${pendingCount} ${lang === 'zh' ? '项' : 'items'}` : undefined}
        />
        <Stat
          label={d.statClaimReward}
          value={meQuery.data ? `${formatToken(claimableReward, decimals)} A9` : '—'}
          hint={d.claimRewardHint}
        />
        <Stat label={d.statTotalStaked} value={meQuery.data ? `${formatToken(totals.stakedRaw, decimals)} A9` : '—'} />
        <Stat label={d.statTotalReward} value={meQuery.data ? `${formatToken(totals.rewardRaw, decimals)} A9` : '—'} />
        <Stat label={d.statTotalClaimed} value={meQuery.data ? `${formatToken(totals.claimedRaw, decimals)} A9` : '—'} />
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
                roundsQuery.data ? <Empty title={lang === 'zh' ? '暂无轮次' : 'No rounds yet'} desc={lang === 'zh' ? '轮次发布后将在这里显示。' : 'Published rounds will appear here.'} /> : <Loading rows={3} />
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
                      <div className="ap-bar" role="progressbar" aria-label={d.qualifiedTarget} aria-valuenow={qualified} aria-valuemin={0} aria-valuemax={candleCount}>
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
                      const reward = rewardStatus(stake, round, c, positionById.get(stake.roundId));
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
              {chainMode ? (
                <div className="note-box">{d.chainClaimHint}</div>
              ) : meQuery.error ? (
                <ErrorState error={meQuery.error} onRetry={meQuery.refresh} />
              ) : meQuery.loading && !meQuery.data ? (
                <Loading rows={2} />
              ) : claimRows.length === 0 ? (
                <Empty title={d.claimEmpty} desc={d.claimEmptyDesc} />
              ) : (
                <div className="ap-claim">
                  {claimRows.map((item) => {
                    const locked = BigInt(item.lockedRaw || '0');
                    const unlocked = BigInt(item.unlockedRaw || '0');
                    const pct = locked > 0n ? Math.min(100, Math.round((Number(unlocked) / Number(locked)) * 100)) : 0;
                    return (
                      <div className="ap-claim-item" key={item.roundId}>
                        <div className="ap-claim-main">
                          <b>
                            {c.round} #{item.roundId}
                          </b>
                          <StatePill state={item.state} />
                        </div>
                        <div>
                          <div className="lbl">{d.claimPrincipal}</div>
                          <div className="ap-claim-amt">
                            {formatToken(item.claimablePrincipalRaw, decimals)} <small>A9</small>
                          </div>
                          <div className="ap-muted mono-sm">{item.principalClaimed ? c.claimed : c.claimable}</div>
                        </div>
                        <div>
                          <div className="lbl">{d.claimImmediate}</div>
                          <div className="ap-claim-amt">
                            {formatToken(item.immediateRaw, decimals)} <small>A9</small>
                          </div>
                          <div className="ap-muted mono-sm">{item.principalClaimed ? c.claimed : c.claimable}</div>
                        </div>
                        <div>
                          <div className="lbl">
                            {d.claimLocked} · {d.claimUnlocked} {pct}%
                          </div>
                          <div className="ap-claim-amt">
                            {formatToken(item.unlockedRaw, decimals)} / {formatToken(item.lockedRaw, decimals)} <small>A9</small>
                          </div>
                          <div className="ap-bar" role="progressbar" aria-label={d.claimLocked} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                            <i style={{ width: `${pct}%` }} />
                          </div>
                          <div className="ap-muted mono-sm">
                            {c.claimed}: {formatToken(item.lockedClaimedRaw, decimals)} A9
                          </div>
                        </div>
                        <div>
                          <div className="lbl">{c.claimable}</div>
                          <div className="ap-claim-amt">
                            {formatToken(item.claimableRaw, decimals)} <small>A9</small>
                          </div>
                        </div>
                        <div className="spacer" />
                        <div className="ap-claim-actions">
                          <button
                            className="btn fire sm"
                            type="button"
                            disabled={claiming !== null || !demo || !!meQuery.error || BigInt(item.claimableRaw || '0') === 0n}
                            onClick={() => void claim(item.roundId)}
                          >
                            {claiming === String(item.roundId) ? c.loading : d.claimBoth}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  <p className="note">{d.claimLockedNote}</p>
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
                  <dd className="em">{demo ? d.walletDemo : chainMode ? (lang === 'zh' ? 'TON钱包 · 链上' : 'TON wallet · on-chain') : d.walletTon}</dd>
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
          {riskItems.map((item) => (
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
  // 链上模式：/api/config 下发了 roundController 合约地址（为空则保持演示模式）
  const configQuery = useQuery(() => api.config(), [], { intervalMs: 0 });
  const chainMode = deriveChainConfig(configQuery.data).configured;

  return (
    <>
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="wrap page ap-page ap-account">
        <PageHead
          lbl={d.lbl}
          title={d.title}
          desc={chainMode ? d.chainDesc : d.desc}
          right={
            <div className="ap-toolbar">
              {wallet.connected ? (
                <>
                  <span className="chip ok">
                    {wallet.demo ? d.walletDemo : chainMode ? (lang === 'zh' ? 'TON钱包 · 链上' : 'TON wallet · on-chain') : d.walletTon} · {shortAddress(wallet.address ?? '')}
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
                  {DEMO_WALLET_ENABLED ? (
                    <button className="btn ghost sm" type="button" onClick={() => connectDemo()}>
                      {d.demo}
                    </button>
                  ) : null}
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
              {DEMO_WALLET_ENABLED ? (
                <button className="btn ghost" type="button" onClick={() => connectDemo()}>
                  {d.demo}
                </button>
              ) : null}
            </div>
            <p className="note">{d.gateHint}</p>
            {healthQuery.error ? <ErrorState error={healthQuery.error} onRetry={healthQuery.refresh} /> : null}
          </div>
        ) : (
          <MeDashboard
            key={wallet.address ?? 'none'}
            address={wallet.address ?? ''}
            demo={wallet.demo}
            config={configQuery.data}
            chainMode={chainMode}
          />
        )}
      </main>
      <SiteFooter />
    </>
  );
}