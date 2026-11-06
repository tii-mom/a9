/**
 * 军饷卡片（「我的」页与「战队」页共用）：累计军饷 / 已领取 / 可领取 + 领取按钮 + 领取后的分享提示。
 * 分发合约未配置（JUNXIANG_DISTRIBUTOR_ADDRESS 缺失或为占位符）时整体隐藏。
 */

import { useState } from 'react';
import { useLang } from '../../lib/lang';
import { socialApi, useQuery } from '../../lib/api';
import { ShareSheet } from '../social/ShareSheet';
import { useWalletStore } from '../wallet/useWallet';
import { formatRawAmount } from './amount';
import { useChainConfig } from './config';
import { useJunxiangClaim } from './useJunxiangClaim';
import './chain.css';

export interface JunxiangCardProps {
  address: string;
  demo: boolean;
}

export function JunxiangCard({ address, demo }: JunxiangCardProps) {
  const { lang } = useLang();
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  const { chain } = useChainConfig();
  const walletStore = useWalletStore();
  const jx = useJunxiangClaim({ chain, address, demo, tonBalance: walletStore.tonBalance });
  const [shareOpen, setShareOpen] = useState(false);
  const shareEnabled = jx.sentRaw !== null;
  // 分享文案需要邀请码：只在领取成功后再读取
  const me = useQuery(() => socialApi.me(address), [address], { intervalMs: 0, enabled: shareEnabled && !!address });

  if (!chain.junxiangDistributor) return null;

  const decimals = chain.tokenDecimals;
  const fmt = (raw: bigint) => `${formatRawAmount(raw, decimals, 2)} A9`;
  const loaded = jx.phase === 'ready';
  const claimable = jx.claimableRaw;
  const canClaim = loaded && claimable > 0n && !jx.busy && !jx.awaitingChain && !demo;

  let hint: string | null = null;
  if (demo) hint = t('演示钱包不能领取，请连接真实 GRAM 钱包。', 'Demo wallets cannot claim. Connect a real GRAM wallet.');
  else if (jx.phase === 'not-published') hint = t('本周军饷清单尚未上链', "This week's bonus list is not on-chain yet");
  else if (jx.phase === 'not-listed') hint = t('本周暂无军饷。', 'No bonus this week.');
  else if (jx.phase === 'error') hint = t('军饷信息读取失败，请稍后重试。', 'Failed to load bonus data. Please retry later.');
  else if (jx.awaitingChain) hint = t('领取已发送，等待链上确认…', 'Claim sent. Waiting for on-chain confirmation…');
  else if (loaded && claimable === 0n) hint = t('已全部领取。', 'Everything has been claimed.');

  const value = (raw: bigint) => (loaded ? fmt(raw) : '—');

  return (
    <section className="chain-panel chain-junxiang" aria-labelledby="chain-jx-title">
      <div className="chain-sec-h">
        <h4 id="chain-jx-title">{t('军饷', 'Bonus')}</h4>
      </div>
      <div className="chain-meta chain-jx-stats">
        <span>
          {t('累计军饷', 'Cumulative')} <b>{value(jx.cumulativeRaw)}</b>
        </span>
        <span>
          {t('已领取', 'Claimed')} <b>{value(jx.claimedRaw)}</b>
        </span>
        <span>
          {t('可领取', 'Claimable')} <b>{value(claimable)}</b>
        </span>
      </div>
      <p className="runtime-note">{t('每周结算一次，领取的是累计未领部分', 'Settled weekly. You claim the cumulative amount not yet claimed.')}</p>
      {hint ? <p className="runtime-note">{hint}</p> : null}
      <div className="chain-actions">
        <button type="button" className="btn fire" disabled={!canClaim} onClick={() => void jx.claim()}>
          {jx.busy ? t('签名中…', 'Signing…') : t('领取', 'Claim')}
        </button>
        {shareEnabled && me.data ? (
          <button type="button" className="btn" onClick={() => setShareOpen(true)}>
            {t('喊人', 'Share')}
          </button>
        ) : null}
      </div>
      {jx.txError ? (
        <p className="chain-err" role="alert">
          {jx.txError}
        </p>
      ) : null}
      {me.data ? (
        <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} code={me.data.inviteCode} moment="claim" />
      ) : null}
    </section>
  );
}
