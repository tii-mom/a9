import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';

/** 落地页占位 —— 由 frontend-dev 按原型 1:1 实现。 */
export default function LandingPage() {
  return (
    <>
      <SiteHeader isLanding />
      <main id="top">
        <section className="hero">
          <div className="wrap hero-in">
            <div>
              <div className="eyebrow"><span className="lbl">TON · 价格驱动型代币</span></div>
              <h1>12 根 K 线点亮 8 根，<em>7.5 亿枚才会解锁。</em></h1>
              <p className="lede">落地页实现中（frontend-dev 负责）。</p>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
