import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useLang } from '../lib/lang';
import { WalletButton } from '../features/wallet/WalletButton';

const NAV = [
  { href: '#war', zh: '战况', en: 'Battle' },
  { href: '#floor', zh: '成交流', en: 'Order Flow' },
  { href: '#ladder', zh: '轮次阶梯', en: 'Ladder' },
  { href: '#rules', zh: '作战规则', en: 'Rules' },
  { href: '#supply', zh: '筹码分配', en: 'Supply' },
  { href: '#risk', zh: '风险', en: 'Risk' },
];

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <path d="M3 24C9 24 9 15 15 15S20 8 24 4" fill="none" stroke="#FF5B1F" strokeWidth="2.6" strokeLinecap="square" />
      <circle cx="24" cy="4" r="3" fill="#FFB63D" />
    </svg>
  );
}

export function SiteHeader({ tape, isLanding = false }: { tape?: ReactNode; isLanding?: boolean }) {
  const { lang, toggle } = useLang();
  const location = useLocation();
  const [chromaCn, setChromaCn] = useState(false);

  const onChroma = () => {
    const root = document.documentElement;
    const next = !chromaCn;
    setChromaCn(next);
    if (next) root.dataset.chroma = 'cn';
    else delete root.dataset.chroma;
  };

  const go = (hash: string) => {
    if (location.pathname !== '/') {
      window.location.href = '/' + hash;
    }
  };

  return (
    <header className="top">
      {tape}
      {!tape && <div className="tape" aria-hidden="true" />}
      <nav className="nav wrap" aria-label={lang === 'zh' ? '主导航' : 'Main navigation'}>
        <Link className="logo" to="/" aria-label="FUSE 引信协议">
          <Logo />
          FUSE <small>{lang === 'zh' ? '引信协议' : 'Ignition Protocol'}</small>
        </Link>
        <div className="links">
          {NAV.map((n) =>
            isLanding ? (
              <a key={n.href} href={n.href}>
                {lang === 'zh' ? n.zh : n.en}
              </a>
            ) : (
              <a key={n.href} href={'/' + n.href} onClick={() => go(n.href)}>
                {lang === 'zh' ? n.zh : n.en}
              </a>
            ),
          )}
          <Link to="/me">{lang === 'zh' ? '我的战况' : 'My War'}</Link>
          <Link to="/leaderboard">{lang === 'zh' ? '排行榜' : 'Leaderboard'}</Link>
        </div>
        <div className="nav-r">
          <span className="badge" title={lang === 'zh' ? '价格、成交、地址为演示数据' : 'Demo data'}>
            {lang === 'zh' ? '原型 · 模拟数据' : 'Prototype · Demo'}
          </span>
          <button className="chroma chroma-color" type="button" onClick={onChroma} aria-label={lang === 'zh' ? '切换涨跌颜色' : 'Toggle up/down colors'}>
            {lang === 'zh'
              ? '涨跌色 ' + (chromaCn ? '红涨绿跌' : '绿涨红跌')
              : 'Colors ' + (chromaCn ? 'CN' : 'US')}
          </button>
          <button
            className="chroma chroma-lang"
            type="button"
            onClick={toggle}
            aria-label={lang === 'zh' ? '切换语言' : 'Switch language'}
          >
            {lang === 'zh' ? 'EN' : '中文'}
          </button>
          <WalletButton />
          <Link className="btn fire sm" to="/#cmd">
            {lang === 'zh' ? '立即参战' : 'Enter Battle'}
          </Link>
        </div>
      </nav>
    </header>
  );
}