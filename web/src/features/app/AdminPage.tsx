import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';

/** 运维后台占位 —— 由 app-dev 实现。 */
export default function AdminPage() {
  return (
    <>
      <SiteHeader />
      <main className="wrap page">
        <div className="page-h">
          <div>
            <span className="lbl">运维后台</span>
            <h1>运维后台</h1>
            <p>页面实现中。</p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
