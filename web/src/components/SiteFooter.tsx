import { Link } from 'react-router-dom';
import { useLang } from '../lib/lang';
import { Logo } from './SiteHeader';

export function SiteFooter() {
  const { lang } = useLang();
  const zh = lang === 'zh';
  return (
    <footer>
      <div className="wrap foot">
        <div>
          <div className="logo" style={{ marginBottom: 10 }}>
            <Logo size={22} />A9
          </div>
          <p>{zh ? '本页为官网演示环境。价格、成交、地址、钱包余额均为演示数据，不代表任何真实市场。' : 'Demo environment. Prices, trades, addresses and balances are simulated and do not represent any real market.'}</p>
          <p>{zh ? '协议具有极高风险，不构成投资建议，也不保证价格上涨或奖励实现。' : 'Extremely high risk. Not investment advice. No guarantee of price appreciation or rewards.'}</p>
          <div className="foot-links" style={{ marginTop: 12 }}>
            <Link to="/me">{zh ? '我的质押' : 'My Stake'}</Link>
            <Link to="/leaderboard">{zh ? '排行榜' : 'Leaderboard'}</Link>
            <Link to="/admin">{zh ? '运维后台' : 'Admin'}</Link>
          </div>
        </div>
        <div>
          <h5>{zh ? '链上信息' : 'On-chain'}</h5>
          <p><span className="pending">{zh ? 'Jetton Master · 主网部署后公布' : 'Jetton Master · TBA'}</span></p>
          <p><span className="pending">{zh ? 'RoundController · 主网部署后公布' : 'RoundController · TBA'}</span></p>
          <p><span className="pending">{zh ? '代码哈希 · 部署后公布' : 'Code hash · TBA'}</span></p>
        </div>
        <div>
          <h5>{zh ? '透明度' : 'Transparency'}</h5>
          <p><span className="pending">{zh ? '第三方审计报告 · 待发布' : 'Audit report · pending'}</span></p>
          <p><span className="pending">{zh ? '预言机配置哈希 · 冻结后公布' : 'Oracle config hash · pending'}</span></p>
          <p><span className="pending">{zh ? '管理员地址 · 部署后公布' : 'Admin address · TBA'}</span></p>
        </div>
      </div>
    </footer>
  );
}
