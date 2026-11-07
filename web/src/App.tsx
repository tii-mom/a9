import { Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './features/landing/LandingPage';
import RulesPage from './features/landing/RulesPage';
import MePage from './features/app/MePage';
import LeaderboardPage from './features/app/LeaderboardPage';
import AdminPage from './features/app/AdminPage';
import { MiniAppHome } from './features/social/MiniAppHome';
import SquadPage from './features/social/SquadPage';
import SocialRankPage from './features/social/SocialRankPage';
import { ScrollToTop } from './components/ScrollToTop';
import { useWallet } from './features/wallet';
import { useSocialBind } from './features/social/useSocialBind';

export default function App() {
  // 社交层绑定挂在应用级：任一页面连上钱包，都会提交本地待绑定的邀请码 / 战队码
  useSocialBind(useWallet().address);
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/me" element={<MePage />} />
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/app" element={<MiniAppHome />} />
        <Route path="/squad" element={<SquadPage />} />
        <Route path="/rank" element={<SocialRankPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
