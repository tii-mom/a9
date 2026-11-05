/**
 * 「我的质押」页的链上交易面板（自包含）：
 *   - 合约/网络信息（来自 /api/config 下发）
 *   - 链上质押（Jetton transfer + StakePayload）
 *   - 链上领取（ClaimAll / ClaimPrincipal / ClaimReward）
 *   - 交易状态机、交易哈希浏览器链接、降级提示
 * 未配置合约地址时只展示降级说明，不阻塞原有演示流程。
 */

import { useCallback, useMemo, useState } from 'react';
import type { Claimable } from '@shared/types';
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
import { ActionConfirm } from './ActionConfirm';
import { QueryNotice } from './QueryNotice';
import './chain.css';

const QUICK_AMOUNTS = [10_000, 50_000, 100_000, 500_000];

function sanitizeAmountInput(value: string): string {
  const cleaned = String(value ?? '').replace(/[^0-9.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot < 0) return cleaned.slice(0, 20);
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '').slice(0, 12);
}

function roundHasStake(stakes: { roundId: number; amountRaw: string }[] | undefined, roundId: number | null): bigint {
  if (!stakes || roundId === null) return 0n;
  const found = stakes.find((stake) => stake.roundId === roundId);
  if (!found) return 0n;
  try {
    return BigInt(found.amountRaw);
  } catch {
    return 0n;
  }
}

function sharePercent(mine: bigint, total: bigint, decimals: number): string {
  if (total <= 0n) return '—';
  const bps = Number((mine * 10000n) / total);
  return (bps / 100).toFixed(2) + '%';
}

function LastTxNote({ address, kind, chain, lang }: { address: string; kind: ChainTxKind; chain: ChainConfig; lang: 'zh' | 'en' }) {
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

export function ChainMePanel({ address, demo }: ChainMePanelProps) {
  const { lang } = useLang();
  const d = CHAIN_I18N[lang];
  const { chain, raw, loading, error, refresh } = useChainConfig();
  const walletStore = useWalletStore();

  const roundsQuery = useQuery(() => api.rounds(), [], { intervalMs: 6000, enabled: chain.configured });
  const meQuery = useQuery(() => api.me(address), [address], { intervalMs: 8000, enabled: chain.configured });

  const walletContext: WalletContext = useMemo(
    () => ({ address, demo, tonBalance: walletStore.tonBalance }),
    [address, demo, walletStore.tonBalance],
  );

  const { state, busy, submitStake, submitClaim, recheck, reset } = useChainTx({
    chain,
    wallet: walletContext,
    onSettled: () => {
      roundsQuery.refresh();
      meQuery.refresh();
    },
  });

  const [amountText, setAmountText] = useState('');
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [pendingClaim, setPendingClaim] = useState<{ kind: 'claimAll' | 'claimPrincipal' | 'claimReward'; roundId?: number; principal: bigint; reward: bigint; paid: bigint; items: Claimable[] } | null>(null);

  const decimals = chain.tokenDecimals;
  const amountRaw = parseAmountToRaw(amountText, decimals);
  const rounds = roundsQuery.data ?? [];
  const openRound = useMemo(() => rounds.find((round) => round.state === 'STAKING_OPEN') ?? null, [rounds]);
  const claimable: Claimable[] = useMemo(
    () => (meQuery.data?.claimable ?? []).filter((item) => item.principalRaw !== '0' || item.rewardRaw !== '0'),
    [meQuery.data],
  );
  const myStakeRaw = useMemo(
    () => roundHasStake(meQuery.data?.stakes, openRound?.roundId ?? null),
    [meQuery.data, openRound],
  );

  const demoWallet = demo || walletStore.mode === 'demo';
  const walletNetworkMismatch =
    chain.configured && walletStore.mode === 'ton' && walletStore.network !== null && walletStore.network !== chain.network;

  const amountHint =
    amountText.trim().length > 0 && amountRaw === null
      ? d.errors.AMOUNT_INVALID
      : amountRaw !== null && amountRaw > 0n && amountRaw < chain.minStakeRaw
        ? d.errors.AMOUNT_TOO_SMALL
        : amountRaw !== null && amountRaw > chain.maxTotalStakeRaw
          ? d.errors.AMOUNT_TOO_LARGE
          : null;

  const dataReady = !!roundsQuery.data && !!meQuery.data && !error && !roundsQuery.error && !meQuery.error && raw?.dataSource === 'chain';
  const canStake =
    chain.configured && dataReady && !walletNetworkMismatch && !amountHint && !!openRound && amountRaw !== null && amountRaw > 0n && riskAccepted && !demoWallet && !busy;
  const canClaim = chain.configured && dataReady && !walletNetworkMismatch && !demoWallet && !busy;

  const handleStake = useCallback(() => {
    if (!canStake || !openRound || amountRaw === null || amountRaw <= 0n) return;
    void submitStake({ round: openRound, amountRaw, myStakeRaw });
  }, [canStake, amountRaw, myStakeRaw, openRound, submitStake]);

  const handleClaim = useCallback(
    (kind: 'claimAll' | 'claimPrincipal' | 'claimReward', roundId?: number) => {
      if (!canClaim) return;
      const selected = claimable.filter((item) => roundId === undefined || item.roundId === roundId);
      const principal = kind === 'claimReward' ? 0n : selected.reduce((sum, item) => sum + BigInt(item.principalRaw), 0n);
      const reward = kind === 'claimPrincipal' ? 0n : selected.reduce((sum, item) => sum + BigInt(item.rewardRaw), 0n);
      const paid = kind === 'claimPrincipal' ? 0n : selected.reduce((sum, item) => sum + BigInt(item.rewardRaw) / 2n, 0n);
      setPendingClaim({ kind, roundId, principal, reward, paid, items: selected });
    },
    [canClaim, claimable],
  );

  const handleRetry = useCallback(() => {
    if (state.kind === 'stake' && openRound && amountRaw !== null && amountRaw > 0n) {
      void submitStake({ round: openRound, amountRaw, myStakeRaw });
      return;
    }
    const roundId = state.roundId ?? undefined;
    if (state.kind === 'claimAll' || state.kind === 'claimPrincipal' || state.kind === 'claimReward') {
      handleClaim(state.kind, state.kind === 'claimAll' ? undefined : roundId);
    }
  }, [amountRaw, handleClaim, myStakeRaw, openRound, state.kind, state.roundId, submitStake]);

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
        <QueryNotice query={meQuery} lang={lang} label={lang === 'zh' ? '账户权益' : 'Account'} />

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
              <span className="lbl">{d.tonBalance}</span> <b>{walletStore.tonBalance ?? '—'}</b> TON
            </span>
            <span>
              <span className="lbl">{d.a9Balance}</span>{' '}
              <b>{walletStore.fuseBalance ? formatRawAmount(walletStore.fuseBalance, decimals) : '—'}</b> A9
            </span>
          </div>
        )}

        <div className="chain-sec">
          <div className="chain-sec-h">
            <h4>{d.stakeTitle}</h4>
            {openRound ? (
              <span className="lbl">
                {d.currentRound} #{openRound.roundId}
              </span>
            ) : (
              <span className="lbl">{d.roundState}: —</span>
            )}
          </div>
          <p className="runtime-note">{d.stakeDesc}</p>

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
                    <button
                      key={value}
                      className="chain-chip"
                      type="button"
                      disabled={busy}
                      onClick={() => setAmountText(String(value))}
                    >
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
                <span>
                  {d.maxStake}: <b>{formatRawAmount(chain.maxTotalStakeRaw, decimals)} A9</b>
                </span>
                <span>
                  {d.maxPerAddress}: <b>{formatRawAmount(chain.maxStakePerAddressRaw, decimals)} A9</b>
                </span>
                <span>
                  {d.myStake}: <b>{formatRawAmount(myStakeRaw, decimals)} A9</b>
                </span>
                <span>
                  {d.shareEst}:{' '}
                  <b>
                    {amountRaw !== null && openRound
                      ? sharePercent(myStakeRaw + amountRaw, BigInt(openRound.totalAcceptedStakeRaw || '0') + amountRaw, decimals)
                      : '—'}
                  </b>
                </span>
                <span className="bad">
                  {d.failLoss}: <b>100%</b>
                </span>
              </div>
              <p className="note chain-dim">{d.capRefundNote}</p>

              <label className="chain-check">
                <input
                  type="checkbox"
                  checked={riskAccepted}
                  disabled={busy}
                  onChange={(event) => setRiskAccepted(event.target.checked)}
                />
                <span>{d.riskAck}</span>
              </label>

              <div className="chain-actions">
                <button className="btn fire" type="button" disabled={!canStake} onClick={handleStake}>
                  {busy && state.kind === 'stake' ? d.stakeSigning : d.stakeAction}
                </button>
                <span className="chain-gas">
                  {d.previewGas}: 0.2 TON · forward 0.05 TON
                </span>
              </div>

              <details className="chain-details">
                <summary>{d.previewTitle}</summary>
                <dl className="chain-dl">
                  <div>
                    <dt>{d.previewOp}</dt>
                    <dd className="mono">0x5254000F</dd>
                  </div>
                  <div>
                    <dt>{d.previewRound}</dt>
                    <dd className="mono">#{openRound.roundId}</dd>
                  </div>
                  <div>
                    <dt>{d.previewNonce}</dt>
                    <dd className="mono">{d.previewNoncePending}</dd>
                  </div>
                  <div>
                    <dt>{d.previewContract}</dt>
                    <dd className="mono">{shortenAddress(chain.roundController ?? '', 8, 8)}</dd>
                  </div>
                  <div>
                    <dt>{d.previewJettonWallet}</dt>
                    <dd className="mono">get_wallet_address(owner)</dd>
                  </div>
                </dl>
                <p className="note chain-dim">{d.previewNote}</p>
              </details>
            </>
          )}
        </div>

        <div className="chain-sec">
          <div className="chain-sec-h">
            <h4>{d.claimTitle}</h4>
            <span className="lbl">{d.claimDesc}</span>
          </div>
          <div className="chain-actions">
            <button className="btn ghost" type="button" disabled={!canClaim || claimable.length === 0} onClick={() => handleClaim('claimAll')}>
              {busy && state.kind === 'claimAll' ? d.stakeSigning : d.claimAll}
            </button>
          </div>
          <p className="runtime-note">{d.claimAllNote}</p>

          {!meQuery.data ? null : claimable.length === 0 ? (
            <p className="chain-empty">
              {d.claimEmpty} — {d.claimEmptyDesc}
            </p>
          ) : (
            <div className="chain-claims">
              {claimable.map((item) => (
                <div className="chain-claim" key={item.roundId}>
                  <div className="chain-claim-h">
                    <b>
                      {d.claimRound} #{item.roundId}
                    </b>
                    <span className="lbl">{item.state}</span>
                  </div>
                  <div className="chain-claim-amts">
                    <span>
                      {d.claimPrincipal} <b>{formatRawAmount(item.principalRaw, decimals)} A9</b>
                    </span>
                    <span>
                      {d.claimReward} <b>{formatRawAmount(item.rewardRaw, decimals)} A9</b>
                    </span>
                  </div>
                  <div className="chain-actions">
                    <button
                      className="btn ghost sm"
                      type="button"
                      disabled={!canClaim || item.principalRaw === '0'}
                      onClick={() => handleClaim('claimPrincipal', item.roundId)}
                    >
                      {d.claimPrincipal}
                    </button>
                    <button
                      className="btn ghost sm"
                      type="button"
                      disabled={!canClaim || item.rewardRaw === '0'}
                      onClick={() => handleClaim('claimReward', item.roundId)}
                    >
                      {d.claimReward}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <TxStatusView state={state} lang={lang} onRetry={handleRetry} onRecheck={() => void recheck()} onDismiss={reset} />
        {pendingClaim ? <ActionConfirm title={pendingClaim.kind === 'claimAll' ? d.claimAll : pendingClaim.kind === 'claimReward' ? d.claimReward : d.claimPrincipal} lang={lang} disabled={!canClaim} onCancel={() => setPendingClaim(null)} onConfirm={() => { if (!canClaim) return; const claim = pendingClaim; const latest = claimable.filter((item) => claim.roundId === undefined || item.roundId === claim.roundId); setPendingClaim(null); if (JSON.stringify(latest) !== JSON.stringify(claim.items)) return; void submitClaim({ kind: claim.kind, roundId: claim.roundId ?? null }); }}>
          <p>{chain.network} · {pendingClaim.roundId === undefined ? (lang === 'zh' ? '全部已结算轮次' : 'All settled rounds') : `R#${pendingClaim.roundId}`}</p>
          <dl className="chain-confirm-values">
            <div><dt>{lang === 'zh' ? '本金领取' : 'Principal'}</dt><dd>{formatRawAmount(pendingClaim.principal, decimals, decimals)} A9</dd></div>
            <div><dt>{lang === 'zh' ? '奖励立即到账（50%）' : 'Reward paid now (50%)'}</dt><dd>{formatRawAmount(pendingClaim.paid, decimals, decimals)} A9</dd></div>
            <div><dt>{lang === 'zh' ? '奖励继续锁定' : 'Reward remains locked'}</dt><dd>{formatRawAmount(pendingClaim.reward - pendingClaim.paid, decimals, decimals)} A9</dd></div>
          </dl>
          {pendingClaim.kind === 'claimAll' ? <ul>{pendingClaim.items.map((item) => <li key={item.roundId}>R#{item.roundId} · {lang === 'zh' ? '本金' : 'Principal'} {formatRawAmount(item.principalRaw, decimals, decimals)} A9 · {lang === 'zh' ? '奖励总额' : 'Total reward'} {formatRawAmount(item.rewardRaw, decimals, decimals)} A9 · {lang === 'zh' ? '立即领取奖励' : 'Reward paid now'} {formatRawAmount(BigInt(item.rewardRaw) / 2n, decimals, decimals)} A9</li>)}</ul> : null}
          <p>{lang === 'zh' ? '金额为接口估算，以合约结算为准；gas以钱包确认为准。' : 'Amounts are API estimates; contract settlement is authoritative. Your wallet shows gas.'}</p>
          {pendingClaim.reward > 0n ? <p>{lang === 'zh' ? '涉及奖励即选择 EARLY：不可改为滚存；其余50%进入R10结束后的12期解锁池，每期30天。R10结束后请使用解锁池领取入口。' : 'Claiming rewards chooses EARLY irreversibly: the remainder enters 12 unlock periods of 30 days after R10. Use the unlock-pool action after R10.'}</p> : null}
        </ActionConfirm> : null}
        <LastTxNote address={address} kind="stake" chain={chain} lang={lang} />
        <LastTxNote address={address} kind="claimAll" chain={chain} lang={lang} />
      </div>
    </section>
  );
}
