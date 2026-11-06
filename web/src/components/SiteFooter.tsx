import { Link } from 'react-router-dom';
import { useLang } from '../lib/lang';
import { useChainConfig, explorerAddressUrl } from '../features/chain/config';
import { Logo } from './SiteHeader';

export function SiteFooter() {
  const { lang } = useLang();
  const zh = lang === 'zh';
  const { raw, chain, loading, error } = useChainConfig();
  const pending = loading ? (zh ? '读取中' : 'Loading') : (zh ? '未公布' : 'Not published');
  const address = (label: string, value: string | null | undefined) => (
    <p>{label} · {value
      ? <a className="contract-link mono" href={explorerAddressUrl(chain, value) ?? undefined} target="_blank" rel="noopener noreferrer" title={value}>{value.slice(0, 8)}…{value.slice(-6)} ↗</a>
      : <span className="pending">{pending}</span>}
    </p>
  );
  const auditUrl = raw?.contracts.auditReportUrl;
  const safeAuditUrl = auditUrl && /^https:\/\//i.test(auditUrl) ? auditUrl : null;
  return (
    <footer>
      <div className="wrap foot">
        <div>
          <Link to="/" className="logo" style={{ marginBottom: 14 }} aria-label={zh ? 'A9 首页' : 'A9 home'}><Logo size={22} />A9</Link>
          <p>{!raw
            ? (zh ? '数据环境尚未确认，请在信息加载完成后再进行操作。' : 'Data source is not confirmed. Wait for configuration before taking action.')
            : raw.dataSource === 'demo'
              ? (zh ? '当前市场与账户展示为演示数据，不代表真实行情或链上资产。连接真实钱包不会改变数据来源。' : 'Market and account displays use simulated data, not live prices or on-chain assets. Connecting a real wallet does not change this data source.')
              : (zh ? `当前展示${raw.network === 'mainnet' ? '主网' : '测试网'}索引数据。链上交易可能延迟，请以区块浏览器确认结果。` : `${raw.network === 'mainnet' ? 'Mainnet' : 'Testnet'} indexed data. Transactions may take time to appear; verify results in the explorer.`)}
          </p>
          {error && <p className="bad">{zh ? '配置更新失败，请刷新后核实环境。' : 'Configuration update failed. Refresh to verify the environment.'}</p>}
          <p>{zh ? '失败轮可销毁全部质押本金。协议不保证价格上涨或奖励收益。' : 'A failed round can burn all staked principal. Price appreciation and rewards are not guaranteed.'}</p>
          <div className="foot-links" style={{ marginTop: 16 }}>
            <Link to="/me">{zh ? '我的质押' : 'My stake'}</Link>
            <Link to="/leaderboard">{zh ? '排行榜' : 'Leaderboard'}</Link>
            <Link to="/rules#risk">{zh ? '完整风险说明' : 'Risk disclosure'}</Link>
          </div>
        </div>
        <div>
          <h5>{zh ? '合约与网络' : 'Contracts & network'}</h5>
          {address('Jetton Master', raw?.contracts.jettonMaster)}
          {address('RoundController', raw?.contracts.roundController)}
          {address('OracleAdapter', raw?.contracts.oracleAdapter)}
          <p>{zh ? '代码哈希' : 'Code hash'} · <span className="footer-hash mono" title={raw?.contracts.codeHash ?? ''}>{raw?.contracts.codeHash ?? pending}</span></p>
        </div>
        <div>
          <h5>{zh ? '透明度' : 'Transparency'}</h5>
          <p>{safeAuditUrl ? <a href={safeAuditUrl} target="_blank" rel="noopener noreferrer">{zh ? '第三方审计报告 ↗' : 'Audit report ↗'}</a> : <span className="pending">{zh ? '第三方审计报告 · 待发布' : 'Audit report · pending'}</span>}</p>
          <p>{zh ? '预言机配置哈希' : 'Oracle config hash'} · <span className="footer-hash mono" title={raw?.contracts.oracleConfigHash ?? ''}>{raw?.contracts.oracleConfigHash ?? pending}</span></p>
          {address(zh ? '管理员' : 'Admin', raw?.contracts.adminOwner)}
        </div>
      </div>
    </footer>
  );
}
