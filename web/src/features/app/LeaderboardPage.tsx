import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';

/** 排行榜占位 —— 由 app-dev 实现。 */
export default function LeaderboardPage() {
  return (
    <>
      <SiteHeader />
      <main className="wrap page">
        <div className="page-h">
          <div>
            <span className="lbl">排行榜</span>
            <h1>排行榜</h1>
            <p>页面实现中。</p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
