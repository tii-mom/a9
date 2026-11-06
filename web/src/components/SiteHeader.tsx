import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useLang } from '../lib/lang';
import { WalletButton } from '../features/wallet/WalletButton';
import { useChainConfig } from '../features/chain/config';

const NAV = [
  { to: '/#war', zh: '本轮', en: 'Round' },
  { to: '/#floor', zh: '成交流', en: 'Order flow' },
  { to: '/rules', zh: '规则与风险', en: 'Rules & risk' },
];

/** Official A9 mark (source: brand kit 01_square/logo_square.svg). Brand colors are fixed, not theme tokens. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1254 1254" aria-hidden="true" focusable="false">
      <rect width="1254" height="1254" fill="#FF4D00" />
      <path fill="#FFFFFF" fillRule="evenodd" d="M 627 0 L -84 1254 L 1338 1254 Z M 627 212 L 1155 1254 L 99 1254 Z" />
    </svg>
  );
}

export function SiteHeader({ tape }: { tape?: ReactNode; isLanding?: boolean }) {
  const { lang, toggle } = useLang();
  const zh = lang === 'zh';
  const location = useLocation();
  const { raw, loading, error } = useChainConfig();
  const [chromaCn, setChromaCn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const environment = !raw
    ? loading ? (zh ? '正在确认数据环境' : 'Checking data source') : (zh ? '数据环境未确认' : 'Data source unavailable')
    : raw.dataSource === 'demo'
      ? (zh ? '演示数据' : 'Demo data')
      : raw.network === 'mainnet' ? (zh ? '主网数据' : 'Mainnet data') : (zh ? '测试网数据' : 'Testnet data');
  const sourceLabel = environment + (raw && error ? (zh ? ' · 更新失败' : ' · Update failed') : '');

  useEffect(() => { setMenuOpen(false); }, [location.key]);
  useEffect(() => {
    const node = header.current;
    if (!node) return;
    const resize = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--header-height', `${node.offsetHeight}px`);
    });
    resize.observe(node);
    return () => resize.disconnect();
  }, []);

  const onChroma = () => {
    const next = !chromaCn;
    setChromaCn(next);
    if (next) document.documentElement.dataset.chroma = 'cn';
    else delete document.documentElement.dataset.chroma;
  };

  return (
    <header className="top" ref={header} onKeyDown={(event) => {
      if (event.key === 'Escape' && menuOpen) {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    }}>
      <a className="skip-link" href="#main-content">{zh ? '跳到主要内容' : 'Skip to content'}</a>
      {tape && <div className="header-tape">{tape}</div>}
      <nav className="nav wrap" aria-label={zh ? '主导航' : 'Main navigation'}>
        <Link className="logo" to="/" aria-label={zh ? 'A9 首页' : 'A9 home'}>
          <Logo />A9
        </Link>
        <div className="links" id="site-navigation" data-open={menuOpen} onClick={() => setMenuOpen(false)}>
          {NAV.map((n) => <Link key={n.to} to={n.to}>{zh ? n.zh : n.en}</Link>)}
          <Link to="/me" aria-current={location.pathname === '/me' ? 'page' : undefined}>{zh ? '我的质押' : 'My stake'}</Link>
          <Link to="/leaderboard" aria-current={location.pathname === '/leaderboard' ? 'page' : undefined}>{zh ? '排行榜' : 'Leaderboard'}</Link>
        </div>
        <div className="nav-r">
          <span className="badge environment-desktop">{sourceLabel}</span>
          <button className="chroma chroma-color" type="button" onClick={onChroma} aria-label={zh ? '切换涨跌颜色' : 'Toggle up/down colors'}>
            {zh ? (chromaCn ? '红涨绿跌' : '绿涨红跌') : (chromaCn ? 'CN colors' : 'US colors')}
          </button>
          <button className="chroma chroma-lang" type="button" onClick={toggle} aria-label={zh ? 'Switch to English' : '切换到中文'}>{zh ? 'EN' : '中文'}</button>
          <WalletButton />
          <Link className="btn fire sm header-join" to="/?action=stake#cmd">{zh ? '参与本轮' : 'Join round'}</Link>
          <button ref={menuButton} className="menu-toggle" type="button" aria-label={zh ? (menuOpen ? '关闭导航' : '打开导航') : (menuOpen ? 'Close navigation' : 'Open navigation')} aria-expanded={menuOpen} aria-controls="site-navigation" onClick={() => setMenuOpen(!menuOpen)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              {menuOpen ? <path d="m6 6 12 12M6 18 18 6" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
            </svg>
          </button>
        </div>
      </nav>
      <div className="environment-mobile wrap"><span className="status-dot" />{sourceLabel}<span>{zh ? '钱包连接与数据来源独立' : 'Wallet connection is separate'}</span></div>
    </header>
  );
}
