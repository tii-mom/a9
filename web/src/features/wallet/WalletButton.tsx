import { useLang } from '../../lib/lang';

/**
 * 钱包按钮占位实现 —— 由 app-dev 替换为真实实现：
 * - TON Connect（只读连接，展示地址与余额，禁用交易）
 * - 降级：演示钱包（本地生成地址，写入 localStorage）
 * 必须保持导出名 WalletButton 与 SiteHeader 的用法不变。
 */
export function WalletButton() {
  const { lang } = useLang();
  return (
    <button className="btn ghost sm" type="button" title={lang === 'zh' ? '钱包模块由 app-dev 实现' : 'wallet module placeholder'}>
      {lang === 'zh' ? '连接钱包' : 'Connect'}
    </button>
  );
}
