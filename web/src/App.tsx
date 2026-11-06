import { Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './features/landing/LandingPage';
import RulesPage from './features/landing/RulesPage';
import MePage from './features/app/MePage';
import LeaderboardPage from './features/app/LeaderboardPage';
import AdminPage from './features/app/AdminPage';
import { ScrollToTop } from './components/ScrollToTop';

export default function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/me" element={<MePage />} />
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
