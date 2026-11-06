/**
 * v8.7 退款账本领取入口（A9-CRIT-02）。
 *
 * 背景：审计修复后，若质押因附带 TON 不足（<0.12）或退款转账 bounce，A9 不再由合约倒贴退回，
 * 而是记入 round 0 退款账本；用户必须自己发起 Claim{roundId:0}（或 ClaimAll）才能取回。
 *
 * 数据源：直接读链上 RC.get_user_stake(0, owner)（rpc.fetchRefundLedger）——
 * 该账本是 storage map、不产生事件，后端 /api/me 暂时拿不到；若后续 worker 暴露 refund 字段，应迁移。
 * 「读不到」与「真的是 0」严格区分：读取失败显示错误态，不显示 0。
 * 回执复用 FIX-5：matchesUserAction(queryId) + aborted/bounced/exit_code 成功门。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatRawAmount } from './amount';
import { useChainConfig } from './config';
import { CHAIN_I18N } from './i18n';
import { useLang } from '../../lib/lang';
import { useWalletStore } from '../wallet/useWallet';
import { fetchRefundLedger } from './rpc';
import { TxStatusView } from './TxStatus';
import { useChainTx } from './useChainTx';
import type { WalletContext } from './transactions';
import { useQuery } from '../../lib/api';
import './chain.css';

/** 演示模式下的确定性模拟退款金额（1,000–50,000 A9），便于 QA 截图/点击。 */
function demoRefundAmountRaw(address: string, decimals: number): string {
  let hash = 0;
  for (let i = 0; i < address.length; i += 1) hash = (hash * 31 + address.charCodeAt(i)) % 100_000;
  const tokens = 1_000 + (hash % 49_000);
  return (BigInt(tokens) * 10n ** BigInt(decimals)).toString();
}

export interface RefundClaimPanelProps {
  address: string;
  demo: boolean;
}

export function RefundClaimPanel({ address, demo }: RefundClaimPanelProps) {
  const { lang } = useLang();
  const d = CHAIN_I18N[lang];
  const { chain } = useChainConfig();
  const walletStore = useWalletStore();
  const decimals = chain.tokenDecimals;
  const chainMode = chain.configured;

  const [demoClaimed, setDemoClaimed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refundQuery = useQuery(() => fetchRefundLedger({ chain, owner: address }), [address, chain.roundController, chain.network], {
    intervalMs: 30_000,
    enabled: chainMode,
  });

  const walletContext: WalletContext = useMemo(
    () => ({ address, demo, tonBalance: walletStore.tonBalance }),
    [address, demo, walletStore.tonBalance],
  );
  const { state: txState, busy, submitClaimRefund, reset } = useChainTx({
    chain,
    wallet: walletContext,
    onSettled: () => refundQuery.refresh(),
  });

  const demoAmount = useMemo(() => demoRefundAmountRaw(address, decimals), [address, decimals]);
  const ledger = chainMode ? refundQuery.data : null;
  const amountRaw = chainMode ? String(ledger?.amountRaw ?? '0') : demoClaimed ? '0' : demoAmount;
  const principalClaimed = chainMode ? Boolean(ledger?.principalClaimed) : demoClaimed;
  const readError = chainMode ? refundQuery.error : null;
  const loading = chainMode && refundQuery.loading && !refundQuery.data && !refundQuery.error;

  let amount = 0n;
  try {
    amount = BigInt(amountRaw || '0');
  } catch {
    amount = 0n;
  }

  const realWallet = !demo && walletStore.mode === 'ton';
  const txActive = txState.kind === 'claimRefund' && txState.phase !== 'idle';
  const canClaim = !busy && amount > 0n && !principalClaimed && (!chainMode || realWallet);

  useEffect(() => {
    if (txState.phase === 'confirmed' && txState.kind === 'claimRefund') refundQuery.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txState.phase, txState.kind]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const handleClaim = useCallback(() => {
    if (chainMode) {
      if (!realWallet) return;
      void submitClaimRefund();
      return;
    }
    setDemoClaimed(true);
    setNotice(d.refundDemoDone);
  }, [chainMode, d.refundDemoDone, realWallet, submitClaimRefund]);

  // 读取中：不占位（默认隐藏）
  if (loading) return null;

  // 读取失败 ≠ 0：显示错误态 + 重试，绝不显示 0
  if (readError) {
    return (
      <section className="panel chain-panel refund-panel">
        <div className="ap-panel-h">
          <h3>{d.refundTitle}</h3>
        </div>
        <div className="ap-pad">
          <p className="note bad">{d.refundError}</p>
          <button className="btn ghost sm" type="button" onClick={() => refundQuery.refresh()}>
            {d.refundRetry}
          </button>
        </div>
      </section>
    );
  }

  // 金额为 0 且无进行中的退款交易：默认隐藏（演示模式刚模拟取回时保留"已取回"提示）
  const demoRecovered = !chainMode && demoClaimed;
  if (!txActive && !demoRecovered && (principalClaimed || amount === 0n)) return null;

  return (
    <section className="panel chain-panel refund-panel">
      <div className="ap-panel-h">
        <h3>{d.refundTitle}</h3>
        <span className="lbl">{d.refundAmountLabel}</span>
      </div>
      <div className="ap-pad">
        {principalClaimed && !txActive ? (
          <p className="note chain-dim">{d.refundRecovered}</p>
        ) : (
          <>
            <div className="refund-main">
              <div className="refund-amount">
                {formatRawAmount(amountRaw, decimals)} <small>A9</small>
              </div>
              <button className="btn fire" type="button" disabled={!canClaim} onClick={handleClaim}>
                {d.refundAction}
              </button>
            </div>
            <p className="note">{d.refundDesc}</p>
          </>
        )}
        {!chainMode ? <p className="note chain-dim">{d.refundDemoNote}</p> : null}
        {chainMode && !realWallet ? <p className="note chain-dim">{d.refundWalletNote}</p> : null}
        <TxStatusView state={txState} lang={lang} onRetry={canClaim ? handleClaim : undefined} onDismiss={reset} />
        {notice ? <p className="note chain-dim">{notice}</p> : null}
      </div>
    </section>
  );
}
