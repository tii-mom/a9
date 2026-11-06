import { useCallback, useEffect, useRef, useState } from 'react';
import { formatToken, shortAddress } from '../../lib/format';
import { useLang } from '../../lib/lang';
import { connect, connectDemo, disconnect, refreshBalances, resetDemoWallet } from './store';
import { DEMO_WALLET_ENABLED } from './flags';
import { useWalletStore } from './useWallet';
import './wallet.css';

const TOKEN_DECIMALS = 9;

interface Dict {
  connect: string;
  connecting: string;
  title: string;
  readOnly: string;
  tonOption: string;
  demoOption: string;
  demoHint: string;
  address: string;
  network: string;
  mainnet: string;
  testnet: string;
  demoNetwork: string;
  walletName: string;
  tonBalance: string;
  fuseBalance: string;
  notDeployed: string;
  refresh: string;
  disconnect: string;
  newDemo: string;
  copy: string;
  copied: string;
  demoTag: string;
  fallbackCancelled: string;
  fallbackUnavailable: string;
  fallbackFailed: string;
  disconnectHint: string;
}

const DICT: Record<'zh' | 'en', Dict> = {
  zh: {
    connect: '连接钱包',
    connecting: '连接中…',
    title: '钱包',
    readOnly: '连接仅共享地址；后续每笔链上操作均需单独确认签名。',
    tonOption: '连接 GRAM 钱包',
    demoOption: '使用演示钱包',
    demoHint: '演示账户可能采用公开榜单地址来展示记录；演示余额不是真实资产，无法签名。',
    address: '地址',
    network: '网络',
    mainnet: '主网',
    testnet: '测试网',
    demoNetwork: '演示',
    walletName: '钱包应用',
    tonBalance: 'GRAM 余额',
    fuseBalance: 'A9 余额',
    notDeployed: '余额未知 · 请刷新',
    refresh: '刷新余额',
    disconnect: '断开连接',
    newDemo: '换一个演示地址',
    copy: '复制地址',
    copied: '已复制',
    demoTag: 'DEMO',
    fallbackCancelled: '已取消连接，仍未连接钱包。可重试或主动选择演示。',
    fallbackUnavailable: '当前无法使用 TON Connect。请重试，或主动选择演示。',
    fallbackFailed: '连接失败，仍未连接钱包。请重试。',
    disconnectHint: '断开后地址与余额将被清空。',
  },
  en: {
    connect: 'Connect',
    connecting: 'Connecting…',
    title: 'Wallet',
    readOnly: 'Connecting shares your address. Each later transaction needs your separate approval.',
    tonOption: 'Connect GRAM Wallet',
    demoOption: 'Use demo wallet',
    demoHint: 'A demo account may use a public leaderboard address to show sample history. Simulated funds are not real assets and cannot sign.',
    address: 'Address',
    network: 'Network',
    mainnet: 'Mainnet',
    testnet: 'Testnet',
    demoNetwork: 'Demo',
    walletName: 'Wallet app',
    tonBalance: 'GRAM balance',
    fuseBalance: 'A9 balance',
    notDeployed: 'Unknown · refresh to retry',
    refresh: 'Refresh balances',
    disconnect: 'Disconnect',
    newDemo: 'New demo address',
    copy: 'Copy address',
    copied: 'Copied',
    demoTag: 'DEMO',
    fallbackCancelled: 'Connection cancelled. No wallet connected. Retry or choose demo.',
    fallbackUnavailable: 'TON Connect is unavailable. Retry or choose demo explicitly.',
    fallbackFailed: 'Connection failed. No wallet connected. Please retry.',
    disconnectHint: 'Disconnecting clears the address and balances.',
  },
};

function fallbackText(notice: string | null, d: Dict): string | null {
  if (notice === 'cancelled') return d.fallbackCancelled;
  if (notice === 'unavailable') return d.fallbackUnavailable;
  if (notice === 'failed') return d.fallbackFailed;
  return null;
}

export function WalletButton() {
  const { lang } = useLang();
  const d = DICT[lang];
  const wallet = useWalletStore();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
      if (event.key === 'Tab') {
        const controls = popRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { setOpen(false); }
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  useEffect(() => {
    if (wallet.notice) setOpen(true);
  }, [wallet.notice]);

  // 连接成功/地址变化后自动收回弹层
  useEffect(() => {
    if (wallet.status === 'connected') setOpen(false);
  }, [wallet.status, wallet.address]);

  const onConnect = useCallback(() => {
    setOpen(false);
    connect();
  }, []);

  const onDemo = useCallback(() => {
    setOpen(false);
    connectDemo();
  }, []);

  const copyAddress = useCallback(async () => {
    if (!wallet.address) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [wallet.address]);

  const connected = wallet.status === 'connected' && !!wallet.address;
  const label = connected
    ? shortAddress(wallet.address ?? '')
    : wallet.status === 'connecting' || wallet.status === 'restoring'
      ? d.connecting
      : d.connect;

  const networkLabel =
    wallet.network === 'mainnet' ? d.mainnet : wallet.network === 'testnet' ? d.testnet : wallet.network === 'demo' ? d.demoNetwork : '—';

  const fuseBalance = wallet.fuseBalance ? `${formatToken(wallet.fuseBalance, TOKEN_DECIMALS)} A9` : null;
  const notice = fallbackText(wallet.notice, d);

  const node = (
    <div className="wl" ref={rootRef}>
      <button
        className={`btn ${connected ? 'ghost' : 'fire'} sm wl-trigger`}
        type="button"
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${d.title}: ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        {connected && <span className="wl-dot" aria-hidden="true" />}
        <span>{label}</span>
        {connected && wallet.mode === 'demo' && <span className="wl-tag">{d.demoTag}</span>}
      </button>

      {open && (
        <div ref={popRef} className="wl-pop" role="dialog" aria-label={d.title}>
          <div className="wl-head">
            <span className="lbl">{d.title}</span>
            <button className="wl-x" type="button" aria-label={lang === 'zh' ? '关闭钱包面板' : 'Close wallet panel'} onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>
              ×
            </button>
          </div>

          {notice && <div className="wl-notice" role="status">{notice}</div>}
          {!connected ? (
            <>
              <p className="wl-note">{d.readOnly}</p>
              <button className="btn fire full" type="button" disabled={wallet.status === 'connecting'} onClick={onConnect}>
                {d.tonOption}
              </button>
              {DEMO_WALLET_ENABLED ? (
                <>
                  <button className="btn ghost full" type="button" onClick={onDemo}>
                    {d.demoOption}
                  </button>
                  <p className="wl-note wl-muted">{d.demoHint}</p>
                </>
              ) : null}
            </>
          ) : (
            <>
              {wallet.mode === 'demo' ? <div className="wl-notice">{d.demoHint}</div> : null}
              <div className="wl-kv">
                <span>{d.address}</span>
                <code title={wallet.address ?? ''}>{shortAddress(wallet.address ?? '', 8, 6)}</code>
              </div>
              <div className="wl-kv">
                <span>{d.network}</span>
                <b>{networkLabel}</b>
              </div>
              {wallet.walletName && (
                <div className="wl-kv">
                  <span>{d.walletName}</span>
                  <b>{wallet.walletName}</b>
                </div>
              )}
              <div className="wl-kv">
                <span>{d.tonBalance}</span>
                <b>{wallet.tonBalance ?? '—'}</b>
              </div>
              <div className="wl-kv">
                <span>{d.fuseBalance}</span>
                {fuseBalance ? <b>{fuseBalance}</b> : <em>{d.notDeployed}</em>}
              </div>
              <div className="wl-actions">
                <button className="btn ghost sm" type="button" onClick={() => void copyAddress()}>
                  {copied ? d.copied : d.copy}
                </button>
                <button className="btn ghost sm" type="button" disabled={refreshing} onClick={() => { setRefreshing(true); void Promise.resolve(refreshBalances()).finally(() => setRefreshing(false)); }}>
                  {refreshing ? (lang === 'zh' ? '刷新中…' : 'Refreshing…') : d.refresh}
                </button>
              </div>
              {wallet.mode === 'demo' && (
                <button className="btn ghost full" type="button" onClick={() => resetDemoWallet()}>
                  {d.newDemo}
                </button>
              )}
              <button
                className="btn ghost full wl-danger"
                type="button"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                {d.disconnect}
              </button>
              <p className="wl-note wl-muted">{d.disconnectHint}</p>
            </>
          )}
        </div>
      )}
    </div>
  );

  return node;
}
