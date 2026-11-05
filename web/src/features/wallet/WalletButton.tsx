import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatToken, shortAddress } from '../../lib/format';
import { useLang } from '../../lib/lang';
import { connect, connectDemo, disconnect, refreshBalances, resetDemoWallet } from './store';
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
    readOnly: '只读连接：不会发起任何交易，也不会请求签名。',
    tonOption: 'TON 钱包（只读）',
    demoOption: '使用演示钱包',
    demoHint: '演示钱包使用本地生成的 UQ 地址与演示资金，不涉及任何真实资产。',
    address: '地址',
    network: '网络',
    mainnet: '主网',
    testnet: '测试网',
    demoNetwork: '演示',
    walletName: '钱包应用',
    tonBalance: 'TON 余额',
    fuseBalance: 'A9 余额',
    notDeployed: '合约部署后开放',
    refresh: '刷新余额',
    disconnect: '断开连接',
    newDemo: '换一个演示地址',
    copy: '复制地址',
    copied: '已复制',
    demoTag: 'DEMO',
    fallbackCancelled: '未完成 TON 连接，已切换为演示钱包',
    fallbackUnavailable: '当前环境不支持 TON Connect，已切换为演示钱包',
    fallbackFailed: 'TON 连接失败，已切换为演示钱包',
    disconnectHint: '断开后地址与余额将被清空。',
  },
  en: {
    connect: 'Connect',
    connecting: 'Connecting…',
    title: 'Wallet',
    readOnly: 'Read-only connection: no transactions are sent and no signature is requested.',
    tonOption: 'TON Wallet (read-only)',
    demoOption: 'Use demo wallet',
    demoHint: 'The demo wallet uses a locally generated UQ address and simulated funds. No real assets.',
    address: 'Address',
    network: 'Network',
    mainnet: 'Mainnet',
    testnet: 'Testnet',
    demoNetwork: 'Demo',
    walletName: 'Wallet app',
    tonBalance: 'TON balance',
    fuseBalance: 'A9 balance',
    notDeployed: 'Available after contract deployment',
    refresh: 'Refresh balances',
    disconnect: 'Disconnect',
    newDemo: 'New demo address',
    copy: 'Copy address',
    copied: 'Copied',
    demoTag: 'DEMO',
    fallbackCancelled: 'TON connection not completed — switched to demo wallet',
    fallbackUnavailable: 'TON Connect unavailable here — switched to demo wallet',
    fallbackFailed: 'TON connection failed — switched to demo wallet',
    disconnectHint: 'Disconnecting clears the address and balances.',
  },
};

function fallbackText(notice: string | null, d: Dict): string | null {
  if (notice === 'cancelled') return d.fallbackCancelled;
  if (notice === 'unavailable') return d.fallbackUnavailable;
  if (notice === 'failed') return d.fallbackFailed;
  return null;
}

/** 小屏时 SiteHeader 会隐藏 .nav-r .btn，钱包改为挂到 body 的悬浮入口。 */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 640px)');
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

export function WalletButton() {
  const { lang } = useLang();
  const d = DICT[lang];
  const wallet = useWalletStore();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
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
    <div className={`wl${isMobile ? ' wl-floating' : ''}`} ref={rootRef}>
      <button
        className={`btn ${connected ? 'ghost' : 'fire'} sm wl-trigger`}
        type="button"
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
        <div className="wl-pop" role="dialog" aria-label={d.title}>
          <div className="wl-head">
            <span className="lbl">{d.title}</span>
            <button className="wl-x" type="button" aria-label="close" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>

          {!connected ? (
            <>
              <p className="wl-note">{d.readOnly}</p>
              <button className="btn fire full" type="button" disabled={wallet.status === 'connecting'} onClick={onConnect}>
                {d.tonOption}
              </button>
              <button className="btn ghost full" type="button" onClick={onDemo}>
                {d.demoOption}
              </button>
              <p className="wl-note wl-muted">{d.demoHint}</p>
            </>
          ) : (
            <>
              {notice && <div className="wl-notice">{notice}</div>}
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
                <button className="btn ghost sm" type="button" onClick={() => refreshBalances()}>
                  {d.refresh}
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

  if (isMobile && typeof document !== 'undefined') return createPortal(node, document.body);
  return node;
}
