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
import { ActionConfirm } from './ActionConfirm';
import { QueryNotice } from './QueryNotice';
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
  const { chain, raw, error: configError } = useChainConfig();
  const walletStore = useWalletStore();
  const decimals = chain.tokenDecimals;

  const roundsQuery = useQuery(() => api.rounds(), [], { intervalMs: 12000 });
  const meQuery = useQuery(() => api.me(address), [address], { intervalMs: 6000 });
  const me = meQuery.data as MeResponse | null;

  const walletContext: WalletContext = useMemo(
    () => ({ address, demo, tonBalance: walletStore.tonBalance }),
    [address, demo, walletStore.tonBalance],
  );
  const { state: txState, busy, submitRewardAction, submitSetReferrer, submitClaimUnlocked, recheck, reset } = useChainTx({
    chain,
    wallet: walletContext,
    onSettled: () => meQuery.refresh(),
  });

  // 演示分支的本地状态（不发链上交易）
  const [demoStates, setDemoStates] = useState<Record<number, RewardStateName>>({});
  const [demoClaimedUnlock, setDemoClaimedUnlock] = useState(false);
  const [demoReferrer, setDemoReferrer] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: 'roll'; row: RewardRowView } | { kind: 'early'; row: RewardRowView } | { kind: 'bind'; referrer: string } | { kind: 'unlock'; amountRaw: string } | null>(null);
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

  const chained = chain.configured && raw?.dataSource === 'chain' && !configError && !demo && walletStore.mode === 'ton';
  const networkMismatch = chained && walletStore.network !== chain.network;
  const canAct = !busy && !networkMismatch && !!me && !!roundsQuery.data && !meQuery.error && !roundsQuery.error && (demo || chained);
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

  const executeRoll = useCallback(
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

  const executeEarly = useCallback(
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

  const executeBind = useCallback(
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

  const executeUnlockClaim = useCallback(() => {
    if (chained) {
      void submitClaimUnlocked();
      return;
    }
    setDemoClaimedUnlock(true);
    setNotice(d.claimUnlockedDemo);
  }, [chained, d.claimUnlockedDemo, submitClaimUnlocked]);

  const bindDisabled = !canAct || !!boundReferrer || (me?.stakes.length ?? 0) > 0;
  const handleRoll = (row: RewardRowView) => { if (canAct) setConfirmation({ kind: 'roll', row }); };
  const handleEarly = (row: RewardRowView) => { if (canAct) setConfirmation({ kind: 'early', row }); };
  const handleBind = (candidate: string) => {
    if (bindDisabled) return;
    const parsed = parseInviteCode(candidate, testnet);
    if (!parsed) { setNotice(d.bindInvalid); return; }
    if (selfRaw && parsed.raw === selfRaw) { setNotice(d.bindSelf); return; }
    setConfirmation({ kind: 'bind', referrer: parsed.friendly });
  };
  const handleUnlockClaim = () => { if (canAct) setConfirmation({ kind: 'unlock', amountRaw: unlock.claimableRaw }); };
  const confirmAction = () => {
    if (!confirmation || !canAct) return;
    const action = confirmation;
    setConfirmation(null);
    if (action.kind === 'roll' || action.kind === 'early') {
      const current = rows.find((row) => row.roundId === action.row.roundId);
      if (!current || current.state !== 'PENDING' || current.amountRaw !== action.row.amountRaw || current.rollableRaw !== action.row.rollableRaw || current.earlyAmountRaw !== action.row.earlyAmountRaw) { setNotice(lang === 'zh' ? '权益已更新，请重新检查后选择。' : 'Rewards changed. Review the updated amounts.'); return; }
      if (action.kind === 'roll') executeRoll(current); else executeEarly(current);
    } else if (action.kind === 'bind') {
      if (!bindDisabled) executeBind(action.referrer);
    } else if (action.amountRaw === unlock.claimableRaw) executeUnlockClaim();
    else setNotice(lang === 'zh' ? '金额已更新，请重新检查。' : 'Amount changed. Please review again.');
  };

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
          {demo ? <p className="note chain-dim">{d.rewardDemoNote}</p> : !chained ? <p className="chain-warn">{lang === 'zh' ? '当前仅展示数据；真实链上操作暂未启用。不会模拟执行。' : 'Data display only. Live transactions are unavailable; actions are not simulated.'}</p> : null}
          {networkMismatch ? <div className="chain-warn">{d.walletNetMismatch}</div> : null}
          <QueryNotice query={meQuery} lang={lang} label={lang === 'zh' ? '奖励与邀请' : 'Rewards & referrals'} />
          <QueryNotice query={roundsQuery} lang={lang} label={lang === 'zh' ? '轮次' : 'Rounds'} />
          {chain.configured && !chained ? <p className="note chain-dim">{d.rewardWalletNote}</p> : null}

          {!me ? null : rows.length === 0 ? (
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
                <div className="reward-bar" role="progressbar" aria-label={d.unlockTitle} aria-valuenow={Number(unlockPct)} aria-valuemin={0} aria-valuemax={100}>
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

          <TxStatusView state={txState} lang={lang} onRetry={undefined} onRecheck={() => void recheck()} onDismiss={reset} />
          {notice ? <p className="note chain-dim" role="status">{notice}</p> : null}
        </div>
      </section>

      {confirmation ? <ActionConfirm confirmLabel={demo ? (lang === 'zh' ? '确认演示' : 'Confirm simulation') : undefined} title={confirmation.kind === 'roll' ? d.optRoll : confirmation.kind === 'early' ? d.optEarly : confirmation.kind === 'bind' ? d.bindAction : d.unlockAction} lang={lang} disabled={!canAct || (confirmation.kind === 'bind' && bindDisabled)} onCancel={() => setConfirmation(null)} onConfirm={confirmAction}>
        <p>{demo ? (lang === 'zh' ? '演示操作 · 不签名、不涉及真实资产' : 'Demo simulation · no signature or real assets') : chain.network}</p>
        {confirmation.kind === 'roll' || confirmation.kind === 'early' ? <>
          <p>R#{confirmation.row.roundId} · {lang === 'zh' ? '奖励总额' : 'Total reward'} {formatRawAmount(confirmation.row.amountRaw, decimals, decimals)} A9</p>
          <dl className="chain-confirm-values">
            <div><dt>{lang === 'zh' ? '立即到账' : 'Paid now'}</dt><dd>{confirmation.kind === 'early' ? formatRawAmount(confirmation.row.earlyAmountRaw, decimals, decimals) : '0'} A9</dd></div>
            <div><dt>{lang === 'zh' ? '继续锁定' : 'Remains locked'}</dt><dd>{formatRawAmount(BigInt(confirmation.row.amountRaw) - (confirmation.kind === 'early' ? BigInt(confirmation.row.earlyAmountRaw) : BigInt(confirmation.row.rollableRaw)), decimals, decimals)} A9</dd></div>
            {confirmation.kind === 'roll' ? <div><dt>{lang === 'zh' ? '投入下一轮（有亏损风险）' : 'Rolled into next round (at risk)'}</dt><dd>{formatRawAmount(confirmation.row.rollableRaw, decimals, decimals)} A9</dd></div> : null}
          </dl>
          <p>{confirmation.kind === 'early' ? (lang === 'zh' ? '确认后不可改选滚存。50%奖励立即领取，剩余50%进入R10结束后12期解锁池，每期30天。' : 'This choice cannot be reversed or changed to roll. Receive 50% now; the other 50% unlocks in 12 periods of 30 days after R10.') : d.rollWarning}</p>
        </> : confirmation.kind === 'bind' ? <>
          <p>{lang === 'zh' ? '将永久绑定以下邀请人；绑定后不可更改。只能在首次质押前绑定。' : 'Permanently bind the referrer below. This cannot be changed and must happen before your first stake.'}</p>
          <code>{confirmation.referrer}</code>
        </> : <p>{lang === 'zh' ? '本次领取已解锁金额' : 'Unlocked amount to claim'}: {formatRawAmount(confirmation.amountRaw, decimals, decimals)} A9</p>}
        {!demo ? <p>{lang === 'zh' ? '金额为接口估算，以合约执行为准；gas以钱包确认为准。' : 'Amounts are API estimates; contract execution is authoritative. Your wallet shows gas.'}</p> : null}
      </ActionConfirm> : null}

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
