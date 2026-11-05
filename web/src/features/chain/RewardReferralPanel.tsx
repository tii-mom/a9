/**
 * V8 奖励三态 + 权重 + 邀请 UI（挂载在 /me）。
 * - 奖励三态：滚存 / 早领 50% / 不动（互斥、不可回退），R10 后显示解锁进度与领取
 * - 邀请：邀请码 + 带参链接 + 首次质押前绑定邀请人（SetReferrer）+ 连续轮次/权重倍数/邀请加成
 * - 合约未配置或演示钱包：按钮走演示分支（本地模拟，不发链上交易）
 * 字段来自 shared/types.ts（backend-dev 定稿），缺失时由 rewards.ts 兜底。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MeResponse, RoundSummary } from '@shared/types';
import { api, useQuery } from '../../lib/api';
import { useLang } from '../../lib/lang';
import { useWalletStore } from '../wallet/useWallet';
import { formatRawAmount } from './amount';
import type { ChainConfig } from './config';
import { useChainConfig } from './config';
import { CHAIN_I18N } from './i18n';
import type { ChainDict } from './i18n';
import {
  captureInviteFromLocation,
  clearPendingReferrer,
  currentWeightMultiplierBps,
  displayAddress,
  inviteCodeFor,
  inviteLinkFor,
  multiplierText,
  parseInviteCode,
  readPendingReferrer,
  readReferralInfo,
  readRewardRows,
  readStreakInfo,
  readUnlockInfo,
  shortAddress,
  type RewardRowView,
  type RewardStateName,
} from './rewards';
import { TxStatusView } from './TxStatus';
import { useChainTx } from './useChainTx';
import type { WalletContext } from './transactions';
import './chain.css';

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function stateLabel(d: ChainDict, state: RewardStateName): string {
  if (state === 'ROLLED') return d.stateRolled;
  if (state === 'EARLY') return d.stateEarly;
  return d.statePending;
}

function stateHint(d: ChainDict, row: RewardRowView, decimals: number): string {
  if (row.state === 'ROLLED') return fill(d.stateRolledHint, { amount: formatRawAmount(row.rolledRaw, decimals) });
  if (row.state === 'EARLY') {
    return fill(d.stateEarlyHint, {
      paid: formatRawAmount(row.paidRaw, decimals),
      locked: formatRawAmount(row.lockedRaw, decimals),
    });
  }
  return d.statePendingHint;
}

function pickActiveRound(rounds: RoundSummary[]): RoundSummary | null {
  const activeStates = new Set(['STAKING_OPEN', 'STAKING_CLOSED', 'OBSERVING', 'ORACLE_PAUSED', 'SETTLING_SUCCESS', 'SETTLING_FAILURE']);
  return rounds.find((round) => activeStates.has(round.state)) ?? rounds[rounds.length - 1] ?? null;
}

export interface RewardReferralPanelProps {
  address: string;
  demo: boolean;
}

/** /me 页：奖励三态 + 邀请。 */
export function RewardReferralPanel({ address, demo }: RewardReferralPanelProps) {
  const { lang } = useLang();
  const d = CHAIN_I18N[lang];
  const { chain } = useChainConfig();
  const walletStore = useWalletStore();
  const decimals = chain.tokenDecimals;

  const roundsQuery = useQuery(() => api.rounds(), [], { intervalMs: 12000 });
  const meQuery = useQuery(() => api.me(address), [address], { intervalMs: 6000 });
  const me = meQuery.data as MeResponse | null;

  const walletContext: WalletContext = useMemo(
    () => ({ address, demo, tonBalance: walletStore.tonBalance }),
    [address, demo, walletStore.tonBalance],
  );
  const { state: txState, busy, submitRewardAction, submitSetReferrer, submitClaimUnlocked, reset } = useChainTx({
    chain,
    wallet: walletContext,
    onSettled: () => meQuery.refresh(),
  });

  // 演示分支的本地状态（不发链上交易）
  const [demoStates, setDemoStates] = useState<Record<number, RewardStateName>>({});
  const [demoClaimedUnlock, setDemoClaimedUnlock] = useState(false);
  const [demoReferrer, setDemoReferrer] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [refInput, setRefInput] = useState('');
  const [pendingReferrer, setPendingReferrer] = useState<string | null>(() => readPendingReferrer());

  useEffect(() => {
    const captured = captureInviteFromLocation(address);
    if (captured) setPendingReferrer(captured);
  }, [address]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 绑定成功：清掉待绑定邀请码
  useEffect(() => {
    if (txState.phase === 'confirmed' && txState.kind === 'setReferrer') {
      clearPendingReferrer();
      setPendingReferrer(null);
      setRefInput('');
    }
  }, [txState.phase, txState.kind]);

  const rounds = roundsQuery.data ?? [];
  const activeRound = useMemo(() => pickActiveRound(rounds), [rounds]);
  const activeRoundId = activeRound?.roundId ?? null;

  const rows = useMemo(() => {
    const base = readRewardRows(me);
    return base.map((row) => {
      const demoState = demoStates[row.roundId];
      return demoState ? { ...row, state: demoState } : row;
    });
  }, [me, demoStates]);

  const unlockBase = useMemo(() => readUnlockInfo(me), [me]);
  const unlock = useMemo(() => {
    if (!demoClaimedUnlock) return unlockBase;
    const claimed = (BigInt(unlockBase.claimedRaw || '0') + BigInt(unlockBase.claimableRaw || '0')).toString();
    return { ...unlockBase, claimedRaw: claimed, claimableRaw: '0' };
  }, [unlockBase, demoClaimedUnlock]);

  const referral = useMemo(() => readReferralInfo(me, chain.network === 'testnet'), [me, chain.network]);
  const boundReferrer = demoReferrer ?? referral.referrer;
  const streak = useMemo(
    () => readStreakInfo(me, me?.stakes ?? [], chain.streakBonusBps, chain.streakMaxRounds),
    [me, chain.streakBonusBps, chain.streakMaxRounds],
  );
  const currentBps = useMemo(
    () => currentWeightMultiplierBps(me?.stakes ?? [], activeRoundId, streak.weightMultiplierBps),
    [me, activeRoundId, streak.weightMultiplierBps],
  );

  const inviteCode = useMemo(() => inviteCodeFor(address), [address]);
  const inviteLink = useMemo(() => inviteLinkFor(inviteCode), [inviteCode]);
  const testnet = chain.network === 'testnet';
  const selfRaw = useMemo(() => parseInviteCode(address, testnet)?.raw ?? null, [address, testnet]);

  const chained = chain.configured && !demo && walletStore.mode === 'ton';
  const canAct = !busy;
  const unlockActive = unlock.active || demoClaimedUnlock;
  const unlockPct = (unlock.progressBps / 100).toFixed(1);

  const copyText = useCallback(async (text: string, which: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setNotice(text);
    }
  }, []);

  const handleRoll = useCallback(
    (row: RewardRowView) => {
      if (chained) {
        void submitRewardAction({ kind: 'rollReward', roundId: row.roundId });
        return;
      }
      setDemoStates((current) => ({ ...current, [row.roundId]: 'ROLLED' }));
      setNotice(d.rewardDemoNote);
    },
    [chained, d.rewardDemoNote, submitRewardAction],
  );

  const handleEarly = useCallback(
    (row: RewardRowView) => {
      if (chained) {
        void submitRewardAction({ kind: 'claimRewardEarly', roundId: row.roundId });
        return;
      }
      setDemoStates((current) => ({ ...current, [row.roundId]: 'EARLY' }));
      setNotice(d.rewardDemoNote);
    },
    [chained, d.rewardDemoNote, submitRewardAction],
  );

  const handleBind = useCallback(
    (candidate: string) => {
      const parsed = parseInviteCode(candidate, testnet);
      if (!parsed) {
        setNotice(d.bindInvalid);
        return;
      }
      if (selfRaw && parsed.raw === selfRaw) {
        setNotice(d.bindSelf);
        return;
      }
      if (chained) {
        void submitSetReferrer({ referrer: parsed.friendly });
        return;
      }
      setDemoReferrer(parsed.friendly);
      clearPendingReferrer();
      setPendingReferrer(null);
      setRefInput('');
      setNotice(d.rewardDemoBound);
    },
    [chained, d.bindInvalid, d.bindSelf, d.rewardDemoBound, selfRaw, submitSetReferrer, testnet],
  );

  const handleUnlockClaim = useCallback(() => {
    if (chained) {
      void submitClaimUnlocked();
      return;
    }
    setDemoClaimedUnlock(true);
    setNotice(d.claimUnlockedDemo);
  }, [chained, d.claimUnlockedDemo, submitClaimUnlocked]);

  const bindDisabled = busy || (!!boundReferrer && !demoReferrer);

  return (
    <>
      <section className="panel chain-panel reward-panel">
        <div className="ap-panel-h">
          <h3>{d.rewardTitle}</h3>
          <span className="ap-muted mono-sm">{d.rewardDesc}</span>
        </div>
        <div className="ap-pad">
          <div className="reward-warning" role="note">
            {d.rollWarning}
          </div>
          {chained ? null : <p className="note chain-dim">{d.rewardDemoNote}</p>}
          {chain.configured && !chained ? <p className="note chain-dim">{d.rewardWalletNote}</p> : null}

          {rows.length === 0 ? (
            <div className="chain-empty">
              {d.rewardEmpty} — {d.rewardEmptyDesc}
            </div>
          ) : (
            <div className="reward-list">
              {rows.map((row) => {
                const pending = row.state === 'PENDING';
                const rollable = BigInt(row.rollableRaw || '0') > 0n;
                const early = row.earlyAmountRaw;
                const lockedByEarly = (BigInt(row.amountRaw || '0') - BigInt(early || '0')).toString();
                return (
                  <div className={'reward-row' + (pending ? '' : ' settled')} key={row.roundId}>
                    <div className="reward-row-h">
                      <b>R#{row.roundId}</b>
                      <span className={'reward-state ' + row.state.toLowerCase()}>{stateLabel(d, row.state)}</span>
                      <span className="reward-amount">
                        {formatRawAmount(row.amountRaw, decimals)} <small>A9</small>
                      </span>
                    </div>
                    <div className="reward-meta">
                      <span>
                        {d.rollableLabel}: <b>{formatRawAmount(row.rollableRaw, decimals)}</b>
                      </span>
                      <span>
                        {d.earlyAmountLabel}: <b>{formatRawAmount(early, decimals)}</b>
                      </span>
                      <span>
                        {d.lockedLabel}: <b>{formatRawAmount(row.lockedRaw || lockedByEarly, decimals)}</b>
                      </span>
                    </div>
                    <div className="reward-actions">
                      <button
                        className={'reward-btn' + (row.state === 'ROLLED' ? ' active' : '')}
                        type="button"
                        disabled={!pending || !rollable || !canAct}
                        title={d.optRollHint}
                        onClick={() => handleRoll(row)}
                      >
                        <b>{d.optRoll}</b>
                        <small>{d.optRollHint}</small>
                      </button>
                      <button
                        className={'reward-btn' + (row.state === 'EARLY' ? ' active' : '')}
                        type="button"
                        disabled={!pending || !canAct}
                        title={fill(d.optEarlyHint, { amount: formatRawAmount(early, decimals), locked: formatRawAmount(lockedByEarly, decimals) })}
                        onClick={() => handleEarly(row)}
                      >
                        <b>{d.optEarly}</b>
                        <small>{fill(d.optEarlyHint, { amount: formatRawAmount(early, decimals), locked: formatRawAmount(lockedByEarly, decimals) })}</small>
                      </button>
                      <button
                        className={'reward-btn' + (pending ? ' active' : '')}
                        type="button"
                        disabled={!pending || !canAct}
                        title={d.optHoldHint}
                        onClick={() => setNotice(d.optHoldHint)}
                      >
                        <b>{d.optHold}</b>
                        <small>{d.optHoldHint}</small>
                      </button>
                    </div>
                    <p className="reward-hint">{stateHint(d, row, decimals)}</p>
                  </div>
                );
              })}
            </div>
          )}

          <div className={'reward-unlock' + (unlockActive ? ' active' : '')}>
            <div className="reward-unlock-h">
              <b>{d.unlockTitle}</b>
              {unlockActive ? (
                <span className="chain-net small active">{lang === 'zh' ? '进行中' : 'ACTIVE'}</span>
              ) : (
                <span className="lbl">{lang === 'zh' ? 'R10 后开放' : 'AFTER R10'}</span>
              )}
            </div>
            {unlockActive ? (
              <>
                <div className="reward-bar" role="progressbar" aria-valuenow={Number(unlockPct)} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ width: unlockPct + '%' }} />
                </div>
                <div className="reward-unlock-meta">
                  <span>{fill(d.unlockActive, { pct: unlockPct, amount: formatRawAmount(unlock.claimableRaw, decimals) })}</span>
                  <span>{fill(d.unlockMeta, { locked: formatRawAmount(unlock.totalLockedRaw, decimals), claimed: formatRawAmount(unlock.claimedRaw, decimals) })}</span>
                </div>
              </>
            ) : (
              <div className="reward-unlock-meta">
                <span>{fill(d.unlockInactive, { amount: formatRawAmount(unlock.totalLockedRaw, decimals) })}</span>
              </div>
            )}
            <div className="reward-actions">
              <button
                className="btn fire sm"
                type="button"
                disabled={!canAct || !unlockActive || BigInt(unlock.claimableRaw || '0') <= 0n}
                title={!chained ? d.rewardWalletNote : undefined}
                onClick={handleUnlockClaim}
              >
                {d.unlockAction}
              </button>
              {BigInt(unlock.claimableRaw || '0') <= 0n ? <span className="note chain-dim">{d.unlockNothing}</span> : null}
            </div>
          </div>

          <TxStatusView state={txState} lang={lang} onRetry={undefined} onDismiss={reset} />
          {notice ? <p className="note chain-dim">{notice}</p> : null}
        </div>
      </section>

      <section className="panel chain-panel referral-panel">
        <div className="ap-panel-h">
          <h3>{d.inviteTitle}</h3>
          <span className="ap-muted mono-sm">{d.inviteDesc}</span>
        </div>
        <div className="ap-pad">
          <div className="invite-copy-grid">
            <div className="invite-copy-row">
              <span className="lbl">{d.inviteCodeLabel}</span>
              <code title={inviteCode}>{shortAddress(inviteCode, 8, 6)}</code>
              <button className="btn ghost sm" type="button" onClick={() => void copyText(inviteCode, 'code')}>
                {copied === 'code' ? d.inviteCopied : d.inviteCopy}
              </button>
            </div>
            <div className="invite-copy-row">
              <span className="lbl">{d.inviteLinkLabel}</span>
              <code title={inviteLink}>{inviteLink.length > 42 ? inviteLink.slice(0, 40) + '…' : inviteLink}</code>
              <button className="btn ghost sm" type="button" onClick={() => void copyText(inviteLink, 'link')}>
                {copied === 'link' ? d.inviteCopied : d.inviteCopy}
              </button>
            </div>
          </div>

          <div className="invite-bind">
            {boundReferrer ? (
              <div className="invite-bound">
                <span className="lbl">{d.boundLabel}</span>
                <code title={displayAddress(boundReferrer, testnet)}>{shortAddress(boundReferrer, 8, 6)}</code>
                <span className="invite-lock">{d.boundNote}</span>
              </div>
            ) : (
              <>
                {pendingReferrer ? (
                  <div className="invite-pending">
                    <span className="lbl">{d.pendingLabel}</span>
                    <code title={pendingReferrer}>{shortAddress(pendingReferrer, 8, 6)}</code>
                    <span className="note chain-dim">{d.pendingNote}</span>
                    <button className="btn fire sm" type="button" disabled={bindDisabled} onClick={() => handleBind(pendingReferrer)}>
                      {d.bindAction}
                    </button>
                  </div>
                ) : (
                  <div className="invite-manual">
                    <span className="lbl">{d.unboundLabel}</span>
                    <div className="invite-input">
                      <input
                        value={refInput}
                        placeholder={d.bindInputPlaceholder}
                        onChange={(event) => setRefInput(event.target.value)}
                        disabled={busy}
                        aria-label={d.bindInputPlaceholder}
                      />
                      <button className="btn fire sm" type="button" disabled={bindDisabled || refInput.trim().length === 0} onClick={() => handleBind(refInput)}>
                        {d.bindAction}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            <p className="note chain-dim">
              {fill(d.inviteNote, {
                bonusPct: (chain.referralBonusBps / 100).toFixed(0),
                capPct: (chain.referralCapMultiple / 100).toFixed(0),
              })}
            </p>
          </div>

          <div className="invite-stats">
            <div>
              <span className="lbl">{d.streakLabel}</span>
              <b>{fill(d.streakValue, { count: streak.count, multi: multiplierText(currentBps) })}</b>
            </div>
            <div>
              <span className="lbl">{d.weightLabel}</span>
              <b>{multiplierText(currentBps)}</b>
            </div>
            <div>
              <span className="lbl">{d.invitedCountLabel}</span>
              <b>{referral.invitedCount}</b>
            </div>
            <div>
              <span className="lbl">{d.referralStakeLabel}</span>
              <b>{formatRawAmount(referral.invitedStakeRaw, decimals)} A9</b>
            </div>
            <div className="wide">
              <span className="lbl">{d.referralBonusLabel}</span>
              <b>
                {fill(d.referralBonusValue, {
                  amount: formatRawAmount(referral.bonusThisRoundRaw, decimals),
                  count: referral.invitedCount,
                  stake: formatRawAmount(referral.invitedStakeRaw, decimals),
                })}
              </b>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
