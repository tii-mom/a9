/**
 * 「我的质押」页的链上交易面板（自包含，docs/35 v11）：
 *   - 合约/网络信息（来自 /api/config 下发）
 *   - 攻城上车（Jetton transfer + StakePayload v2）
 *   - 攻城令：每城一张（StakeTicket）。逐城展示本金、立即 20%、压城 80% 与解锁进度（RC.get_reward_preview）
 *   - 领取本金 + 奖励（TicketClaim）；一键续战（TicketRestake，仅攻城窗口内且本金未领取）
 *   - 交易状态机、交易哈希浏览器链接、降级提示
 * 未配置合约地址时只展示降级说明，不阻塞原有演示流程。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RoundSummary } from '@shared/types';
import { api, useQuery } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useLang } from '../../lib/lang';
import { connect as connectWallet } from '../wallet';
import { useWalletStore } from '../wallet/useWallet';
import { formatRawAmount, parseAmountToRaw } from './amount';
import { shortenAddress } from './address';
import type { ChainConfig } from './config';
import { explorerAddressUrl, useChainConfig } from './config';
import { CHAIN_I18N } from './i18n';
import { loadLastChainTx } from './storage';
import { TxStatusView } from './TxStatus';
import { useChainTx, type ChainTxKind } from './useChainTx';
import type { WalletContext } from './transactions';
import { DEFAULT_FORWARD_TON_NANO, DEFAULT_STAKE_MESSAGE_TON_NANO, DEFAULT_TICKET_CLAIM_TON_NANO, DEFAULT_TICKET_RESTAKE_TON_NANO } from './protocol';
import { fetchRewardPreview, fetchTicketState, type RewardPreviewView, type TicketStateView } from './rpc';
import { ActionConfirm } from './ActionConfirm';
import { QueryNotice } from './QueryNotice';
import './chain.css';

const QUICK_AMOUNTS = [1_000, 10_000, 100_000, 1_000_000];

function nanoToTon(nano: bigint): string {
  return (Number(nano) / 1e9).toString();
}

function sanitizeAmountInput(value: string): string {
  const cleaned = String(value ?? '').replace(/[^0-9.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot < 0) return cleaned.slice(0, 20);
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '').slice(0, 12);
}

function toBig(value: string | null | undefined): bigint {
  try {
    return BigInt(value ?? '0');
  } catch {
    return 0n;
  }
}

/** 一张攻城令的链上快照（攻城令 + 奖励预览）。 */
export interface TicketRow {
  roundId: number;
  roundState: string;
  ticket: TicketStateView;
  /** 仅成功轮有奖励预览 */
  preview: RewardPreviewView | null;
  /** 本金是否还能取（未领取、且该城破城或技术终止） */
  principalClaimable: boolean;
  /** 现在可领取的本金 + 奖励（raw） */
  claimablePrincipal: bigint;
  claimableReward: bigint;
  /** 压城 80% 中已解锁的部分（用于进度条） */
  unlockedLocked: bigint;
  lockedTotal: bigint;
}

function buildRow(roundId: number, roundState: string, ticket: TicketStateView, preview: RewardPreviewView | null): TicketRow {
  const amount = toBig(ticket.amountRaw);
  const principalClaimable = !ticket.principalDone && (roundState === 'SUCCEEDED' || roundState === 'TECHNICAL_ABORTED');
  const lockedClaimed = toBig(ticket.lockedClaimedRaw);
  const immediate = preview ? toBig(preview.immediateRaw) : 0n;
  const locked = preview ? toBig(preview.lockedRaw) : 0n;
  const unlocked = preview ? toBig(preview.unlockedLockedRaw) : 0n;
  const restUnlocked = unlocked > lockedClaimed ? unlocked - lockedClaimed : 0n;
  const claimablePrincipal = principalClaimable ? amount : 0n;
  const claimableReward = roundState === 'SUCCEEDED' ? (ticket.principalDone ? 0n : immediate) + restUnlocked : 0n;
  return {
    roundId,
    roundState,
    ticket,
    preview,
    principalClaimable,
    claimablePrincipal,
    claimableReward,
    unlockedLocked: unlocked,
    lockedTotal: locked,
  };
}

function LastTxNote({ address, kind, lang }: { address: string; kind: ChainTxKind; lang: 'zh' | 'en' }) {
  const d = CHAIN_I18N[lang];
  const stored = useMemo(() => loadLastChainTx(address, kind), [address, kind]);
  if (!stored || !stored.hash) return null;
  const url = stored.explorerUrl;
  return (
    <div className="chain-last">
      <span className="lbl">{d.txLast}</span>
      {url ? (
        <a className="chain-hash" href={url} target="_blank" rel="noreferrer">
          {shortenAddress(stored.hash, 8, 8)}
        </a>
      ) : (
        <span className="mono">{shortenAddress(stored.hash, 8, 8)}</span>
      )}
      <span className="ap-muted">{formatDateTime(stored.at)}</span>
      {stored.network ? <span className="chain-net small">{stored.network}</span> : null}
    </div>
  );
}

export interface ChainMePanelProps {
  address: string;
  demo: boolean;
}

type PendingAction = { kind: 'ticketClaim' | 'ticketRestake'; row: TicketRow; ticketAddress: string };

export function ChainMePanel({ address, demo }: ChainMePanelProps) {
  const { lang } = useLang();
  const d = CHAIN_I18N[lang];
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  const { chain, raw, loading, error, refresh } = useChainConfig();
  const walletStore = useWalletStore();

  const roundsQuery = useQuery(() => api.rounds(), [], { intervalMs: 6000, enabled: chain.configured });

  const walletContext: WalletContext = useMemo(
    () => ({ address, demo, tonBalance: walletStore.tonBalance }),
    [address, demo, walletStore.tonBalance],
  );

  const [refreshTick, setRefreshTick] = useState(0);
  const { state, busy, submitStake, submitTicketClaim, submitTicketRestake, recheck, reset } = useChainTx({
    chain,
    wallet: walletContext,
    onSettled: () => {
      roundsQuery.refresh();
      setRefreshTick((value) => value + 1);
    },
  });

  const [amountText, setAmountText] = useState('');
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);

  const decimals = chain.tokenDecimals;
  const amountRaw = parseAmountToRaw(amountText, decimals);
  const rounds: RoundSummary[] = roundsQuery.data ?? [];
  const openRound = useMemo(() => rounds.find((round) => round.state === 'STAKING_OPEN') ?? null, [rounds]);
  const stateByRound = useMemo(() => new Map(rounds.map((round) => [round.roundId, round.state])), [rounds]);

  // 逐城读取攻城令（链上为准）：未上车的轮次不发请求
  const roundsKey = rounds.map((round) => round.roundId + ':' + round.state).join(',');
  useEffect(() => {
    if (!chain.configured || !chain.roundController || demo || !address || rounds.length === 0) {
      setTickets(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const rows: TicketRow[] = [];
        for (const round of rounds) {
          if (round.state === 'UNOPENED') continue;
          const ticket = await fetchTicketState({ chain, owner: address, roundId: round.roundId });
          if (!ticket || toBig(ticket.amountRaw) <= 0n) continue;
          const preview = round.state === 'SUCCEEDED'
            ? await fetchRewardPreview({ chain, roundId: round.roundId, weightRaw: toBig(ticket.weightRaw) })
            : null;
          rows.push(buildRow(round.roundId, round.state, ticket, preview));
        }
        if (!cancelled) {
          setTickets(rows);
          setTicketError(null);
        }
      } catch (readError) {
        if (!cancelled) setTicketError(readError instanceof Error ? readError.message : String(readError));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // roundsKey 覆盖轮次状态变化；refreshTick 覆盖交易确认
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chain.network, chain.roundController, demo, roundsKey, refreshTick]);

  const demoWallet = demo || walletStore.mode === 'demo';
  const walletNetworkMismatch =
    chain.configured && walletStore.mode === 'ton' && walletStore.network !== null && walletStore.network !== chain.network;

  const amountHint =
    amountText.trim().length > 0 && amountRaw === null
      ? d.errors.AMOUNT_INVALID
      : amountRaw !== null && amountRaw > 0n && amountRaw < chain.minStakeRaw
        ? d.errors.AMOUNT_TOO_SMALL
        : null;

  const dataReady = !!roundsQuery.data && !error && !roundsQuery.error && raw?.dataSource === 'chain';
  const canStake = chain.configured && dataReady && !walletNetworkMismatch && !amountHint && !!openRound && amountRaw !== null && amountRaw > 0n && riskAccepted && !demoWallet && !busy;
  const canAct = chain.configured && dataReady && !walletNetworkMismatch && !demoWallet && !busy;

  const handleStake = useCallback(() => {
    if (!canStake || !openRound || amountRaw === null || amountRaw <= 0n) return;
    void submitStake({ round: openRound, amountRaw });
  }, [canStake, amountRaw, openRound, submitStake]);

  /** 一键续战可用条件（docs/35 D-50）：当前城在攻城窗口内、旧攻城令本金未领取、旧城已破城或技术终止。 */
  const canRestake = (row: TicketRow): boolean =>
    canAct && !!openRound && openRound.roundId !== row.roundId && row.principalClaimable && stateByRound.get(row.roundId) !== 'FAILED_PERMANENT' && !row.ticket.pending;

  const runAction = useCallback(
    (action: PendingAction) => {
      setPending(null);
      if (action.kind === 'ticketClaim') {
        void submitTicketClaim({ roundId: action.row.roundId, ticketAddress: action.ticketAddress });
      } else {
        void submitTicketRestake({ roundId: action.row.roundId, ticketAddress: action.ticketAddress });
      }
    },
    [submitTicketClaim, submitTicketRestake],
  );

  const requestAction = useCallback(
    (kind: PendingAction['kind'], row: TicketRow) => {
      if (kind === 'ticketRestake' ? !canRestake(row) : !canAct) return;
      setPending({ kind, row, ticketAddress: row.ticket.ticketAddress });
    },
    // canRestake / canAct 由上面的状态派生
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canAct, canRestake],
  );

  const handleRetry = useCallback(() => {
    if (state.kind === 'stake' && openRound && amountRaw !== null && amountRaw > 0n) {
      void submitStake({ round: openRound, amountRaw });
      return;
    }
    const row = tickets?.find((item) => item.roundId === state.roundId);
    if (row && (state.kind === 'ticketClaim' || state.kind === 'ticketRestake')) requestAction(state.kind, row);
  }, [amountRaw, openRound, requestAction, state.kind, state.roundId, submitStake, tickets]);

  const controllerUrl = chain.roundController ? explorerAddressUrl(chain, chain.roundController) : null;
  const jettonUrl = chain.jettonMaster ? explorerAddressUrl(chain, chain.jettonMaster) : null;

  if (loading && !raw) {
    return (
      <section className="panel chain-panel">
        <div className="ap-panel-h">
          <h3>{d.title}</h3>
        </div>
        <div className="ap-pad chain-skeleton" aria-busy="true">
          <span />
          <span />
        </div>
      </section>
    );
  }

  if (!chain.configured) {
    const reason =
      error && !raw
        ? d.unconfiguredNoConfig
        : chain.disabledReason === 'demo'
          ? d.unconfiguredDemo
          : d.unconfiguredNoContracts;
    return (
      <section className="panel chain-panel chain-off">
        <div className="ap-panel-h">
          <h3>{d.unconfiguredTitle}</h3>
          <span className="lbl">{demoWallet ? 'DEMO' : (lang === 'zh' ? '未启用' : 'UNAVAILABLE')}</span>
        </div>
        <div className="ap-pad">
          <p className="note">{reason}</p>
          <p className="note chain-dim">{d.unconfiguredHint}</p>
          {error ? (
            <button className="btn ghost sm" type="button" onClick={refresh}>
              {d.retry}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  const totalClaimable = (tickets ?? []).reduce((sum, row) => sum + row.claimablePrincipal + row.claimableReward, 0n);

  return (
    <section className="panel chain-panel">
      <div className="ap-panel-h">
        <h3>{d.title}</h3>
        <div className="chain-head-meta">
          <span className={'chain-net ' + chain.network}>{chain.network === 'testnet' ? d.testnet : d.mainnet}</span>
          {chain.roundController ? (
            <a className="chain-addr" href={controllerUrl ?? undefined} target="_blank" rel="noreferrer" title={chain.roundController}>
              <span className="lbl">{d.roundController}</span> {shortenAddress(chain.roundController)}
            </a>
          ) : null}
          {chain.jettonMaster ? (
            <a className="chain-addr" href={jettonUrl ?? undefined} target="_blank" rel="noreferrer" title={chain.jettonMaster}>
              <span className="lbl">{d.jettonMaster}</span> {shortenAddress(chain.jettonMaster)}
            </a>
          ) : null}
        </div>
      </div>

      <div className="ap-pad">
        <p className="note">{d.desc}</p>
        <p className="note chain-dim">{d.demoClaimWarn}</p>

        {raw && raw.dataSource !== 'chain' ? <div className="chain-warn">{d.dataSourceDemoWarn}</div> : null}
        {walletNetworkMismatch ? <div className="chain-warn">{d.walletNetMismatch}</div> : null}
        <QueryNotice query={roundsQuery} lang={lang} label={lang === 'zh' ? '轮次' : 'Rounds'} />
        {ticketError ? <div className="chain-warn">{t('读取攻城令失败（链上 RPC）：', 'Failed to read stake tickets (on-chain RPC): ')}{ticketError}</div> : null}

        {demoWallet ? (
          <div className="chain-warn chain-wallet-demo">
            <div>
              <b>{d.walletDemoTitle}</b>
              <p>{d.walletDemoDesc}</p>
            </div>
            <button className="btn ghost sm" type="button" onClick={() => connectWallet()}>
              {d.switchWallet}
            </button>
          </div>
        ) : (
          <div className="chain-balances">
            <span>
              <span className="lbl">{d.tonBalance}</span> <b>{walletStore.tonBalance ?? '—'}</b> GRAM
            </span>
            <span>
              <span className="lbl">{d.a9Balance}</span>{' '}
              <b>{walletStore.fuseBalance ? formatRawAmount(walletStore.fuseBalance, decimals) : '—'}</b> A9
            </span>
          </div>
        )}

        <div className="chain-sec">
          <div className="chain-sec-h">
            <h4>{t('攻城上车', 'Join the siege')}</h4>
            {openRound ? (
              <span className="lbl">
                {d.currentRound} #{openRound.roundId} · {t('攻城中', 'Sieging')}
              </span>
            ) : (
              <span className="lbl">{d.roundState}: —</span>
            )}
          </div>
          <p className="runtime-note">{t('每次上车会为你记一张本城的攻城令（每城一张）。本金按攻城期时机计入战力：前 12h ×1.5、中 12h ×1.2、后 12h ×1.0。', 'Each stake adds to your stake ticket for this round (one ticket per round). Weight by timing: first 12h ×1.5, middle 12h ×1.2, last 12h ×1.0.')}</p>

          {!roundsQuery.data ? null : !openRound ? (
            <p className="chain-empty">{d.noOpenRound}</p>
          ) : (
            <>
              <div className="chain-form">
                <label className="chain-field">
                  <span className="lbl">{d.amount}</span>
                  <div className="chain-input">
                    <input
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={d.amountPlaceholder}
                      value={amountText}
                      disabled={busy}
                      onChange={(event) => setAmountText(sanitizeAmountInput(event.target.value))}
                      aria-label={d.amount}
                    />
                    <b>A9</b>
                  </div>
                  {amountHint ? <span className="chain-hint bad">{amountHint}</span> : null}
                </label>
                <div className="chain-chips">
                  {QUICK_AMOUNTS.map((value) => (
                    <button key={value} className="chain-chip" type="button" disabled={busy} onClick={() => setAmountText(String(value))}>
                      {value.toLocaleString('en-US')}
                    </button>
                  ))}
                  <button
                    className="chain-chip"
                    type="button"
                    disabled={busy}
                    onClick={() => setAmountText(formatRawAmount(chain.minStakeRaw, decimals, decimals).replace(/,/g, ''))}
                  >
                    MIN
                  </button>
                </div>
              </div>

              <div className="chain-meta">
                <span>
                  {d.minStake}: <b>{formatRawAmount(chain.minStakeRaw, decimals)} A9</b>
                </span>
                <span className="bad">
                  {d.failLoss}: <b>100%</b>
                </span>
              </div>
              <p className="note chain-dim">{t('无单轮总量或单地址上限；低于最低质押或 TON 不足的无效上车会被退回或留存在协议内（见合约说明）。', 'No per-round or per-address cap. An invalid stake is refunded, or kept by the contract if the attached TON is too low.')}</p>

              <label className="chain-check">
                <input type="checkbox" checked={riskAccepted} disabled={busy} onChange={(event) => setRiskAccepted(event.target.checked)} />
                <span>{d.riskAck}</span>
              </label>

              <div className="chain-actions">
                <button className="btn fire" type="button" disabled={!canStake} onClick={handleStake}>
                  {busy && state.kind === 'stake' ? d.stakeSigning : d.stakeAction}
                </button>
                <span className="chain-gas">
                  {d.previewGas}: {nanoToTon(DEFAULT_STAKE_MESSAGE_TON_NANO)} GRAM · forward {nanoToTon(DEFAULT_FORWARD_TON_NANO)} GRAM
                </span>
              </div>
            </>
          )}
        </div>

        <div className="chain-sec">
          <div className="chain-sec-h">
            <h4>{t('我的攻城令', 'My stake tickets')}</h4>
            <span className="lbl">{t('可领取合计', 'Claimable now')}: {formatRawAmount(totalClaimable, decimals)} A9</span>
          </div>
          <p className="runtime-note">{t('本金 + 20% 立即奖励可在破城后领取；其余 80% 为压城奖励，在之后任一城破城时解锁，或第 10 城结束后 30 天内线性解锁。', 'Principal + 20% of the reward can be claimed once the round succeeds. The remaining 80% is locked until any later round succeeds, or unlocks linearly over 30 days after round 10.')}</p>

          {!tickets ? (
            demo ? null : <p className="chain-empty">{t('正在读取链上攻城令…', 'Reading on-chain tickets…')}</p>
          ) : tickets.length === 0 ? (
            <p className="chain-empty">{t('还没有攻城令。上车后会在这里出现。', 'No tickets yet. They appear here after you join a round.')}</p>
          ) : (
            <div className="chain-claims">
              {tickets.map((row) => {
                const lockedPct = row.lockedTotal > 0n ? Number((row.unlockedLocked * 10000n) / row.lockedTotal) / 100 : 0;
                const claimableNow = row.claimablePrincipal + row.claimableReward;
                return (
                  <div className="chain-claim" key={row.roundId}>
                    <div className="chain-claim-h">
                      <b>
                        {d.claimRound} #{row.roundId}
                      </b>
                      <span className="lbl">{row.roundState}</span>
                    </div>
                    <div className="chain-claim-amts">
                      <span>
                        {t('本金', 'Principal')} <b>{formatRawAmount(toBig(row.ticket.amountRaw), decimals)} A9</b>
                        {row.ticket.principalDone ? <span className="ap-muted"> · {t('已领取 / 已续战', 'claimed / restaked')}</span> : null}
                      </span>
                      {row.preview ? (
                        <>
                          <span>
                            {t('立即 20%', 'Immediate 20%')} <b>{formatRawAmount(toBig(row.preview.immediateRaw), decimals)} A9</b>
                          </span>
                          <span>
                            {t('压城 80%', 'Locked 80%')} <b>{formatRawAmount(toBig(row.preview.lockedRaw), decimals)} A9</b>
                          </span>
                          <span>
                            {t('已解锁', 'Unlocked')} <b>{lockedPct.toFixed(2)}%</b>
                            <span className="ap-muted"> · {t('已领', 'claimed')} {formatRawAmount(toBig(row.ticket.lockedClaimedRaw), decimals)} A9</span>
                          </span>
                        </>
                      ) : null}
                    </div>
                    <div className="chain-actions">
                      <button className="btn ghost sm" type="button" disabled={!canAct || row.ticket.pending || claimableNow <= 0n} onClick={() => requestAction('ticketClaim', row)}>
                        {busy && state.kind === 'ticketClaim' && state.roundId === row.roundId ? d.stakeSigning : t('领取', 'Claim')}
                        {claimableNow > 0n ? ` (${formatRawAmount(claimableNow, decimals)} A9)` : ''}
                      </button>
                      <button className="btn ghost sm" type="button" disabled={!canRestake(row)} onClick={() => requestAction('ticketRestake', row)}>
                        {busy && state.kind === 'ticketRestake' && state.roundId === row.roundId ? d.stakeSigning : t('一键续战', 'One-tap continue')}
                      </button>
                    </div>
                    {!row.principalClaimable && !row.ticket.principalDone && row.roundState !== 'SUCCEEDED' ? (
                      <p className="note chain-dim">{t('本城未破，本金已销毁。', 'Round failed; principal was burned.')}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          <p className="note chain-dim">
            {t('一键续战：仅在当前城攻城期内可用，本金不出合约，直接转入当前城；立即 20% 照常到账（攻城令 TON 附带 0.3 GRAM）。', 'One-tap continue: only while the current round is sieging. Principal stays in the contract and moves into the current round; the immediate 20% is paid as usual (0.3 GRAM attached).')}
            {' '}
            {t('领取附带', 'Claim attaches')} {nanoToTon(DEFAULT_TICKET_CLAIM_TON_NANO)} GRAM · {t('续战附带', 'continue attaches')} {nanoToTon(DEFAULT_TICKET_RESTAKE_TON_NANO)} GRAM
          </p>
        </div>

        <TxStatusView state={state} lang={lang} onRetry={handleRetry} onRecheck={() => void recheck()} onDismiss={reset} />
        {pending ? (
          <ActionConfirm
            title={pending.kind === 'ticketRestake' ? t('一键续战', 'One-tap continue') : t('领取本金 + 奖励', 'Claim principal + reward')}
            lang={lang}
            disabled={pending.kind === 'ticketRestake' ? !canRestake(pending.row) : !canAct}
            onCancel={() => setPending(null)}
            onConfirm={() => runAction(pending)}
          >
            <p>{chain.network} · {t('攻城令', 'ticket')} R#{pending.row.roundId}</p>
            <dl className="chain-confirm-values">
              <div>
                <dt>{t('本金', 'Principal')}</dt>
                <dd>{formatRawAmount(pending.kind === 'ticketRestake' ? toBig(pending.row.ticket.amountRaw) : pending.row.claimablePrincipal, decimals, decimals)} A9</dd>
              </div>
              <div>
                <dt>{pending.kind === 'ticketRestake' ? t('转入当前城', 'Moves into current round') : t('奖励（本次可领）', 'Reward now')}</dt>
                <dd>
                  {pending.kind === 'ticketRestake'
                    ? `R#${openRound?.roundId ?? '—'}`
                    : `${formatRawAmount(pending.row.claimableReward, decimals, decimals)} A9`}
                </dd>
              </div>
            </dl>
            {pending.kind === 'ticketRestake' ? (
              <p>{t('一键续战不会把本金转回你的钱包：本金留在协议内，计入当前城的攻城令；立即 20% 奖励照常到账。', 'One-tap continue does not return your principal to your wallet: it stays in the protocol and joins your ticket for the current round. The immediate 20% reward is still paid out.')}</p>
            ) : (
              <p>{t('金额为链上 get_reward_preview 的读数，以合约结算为准；gas 以钱包确认为准。', 'Amounts come from on-chain get_reward_preview; contract settlement is authoritative. Your wallet shows gas.')}</p>
            )}
          </ActionConfirm>
        ) : null}
        <LastTxNote address={address} kind="stake" lang={lang} />
        <LastTxNote address={address} kind="ticketClaim" lang={lang} />
        <LastTxNote address={address} kind="ticketRestake" lang={lang} />
      </div>
    </section>
  );
}
