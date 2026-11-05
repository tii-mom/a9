import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';

/** 我的战况占位 —— 由 app-dev 实现。 */
export default function MePage() {
  return (
    <>
      <SiteHeader />
      <main className="wrap page">
        <div className="page-h">
          <div>
            <span className="lbl">我的战况</span>
            <h1>我的战况</h1>
            <p>页面实现中。</p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
