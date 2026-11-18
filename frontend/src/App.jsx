import { useEffect, useState } from "react";
import { Routes, Route, Navigate, NavLink, Outlet, Link, useLocation } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./auth";
import Login from "./pages/Login";
import Overview from "./pages/Overview";
import Cases from "./pages/Cases";
import NewCase from "./pages/NewCase";
import CaseDetail from "./pages/CaseDetail";
import Closure from "./pages/Closure";
import Referrals from "./pages/Referrals";
import Escalations from "./pages/Escalations";
import StaffRoles from "./pages/StaffRoles";
import Settings from "./pages/Settings";
import ComingSoon from "./pages/ComingSoon";
import FollowUps from "./pages/FollowUps";
import Analytics from "./pages/Analytics";
import Communications from "./pages/Communications";

const NAV = [
  ["/", "Overview"], ["/cases", "Screening Cases"], ["/communication", "Patient Communication"],
  ["/referrals", "Referrals"], ["/follow-ups", "Follow-Ups"], ["/escalations", "Escalations"],
  ["/closure", "Case Closure"], ["/analytics", "Analytics and Reports"], ["/staff", "Staff and Roles"],
  ["/settings", "Settings and Integrations"],
];

function Shell() {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const load = () => api("/followups/notifications").then((r) => setUnread(r.unread)).catch(() => {});
    load(); const t = setInterval(load, 60000);
    window.addEventListener("careloop:notifications", load);
    return () => { clearInterval(t); window.removeEventListener("careloop:notifications", load); };
  }, [loc.pathname]);
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="side">
        <div className="brand"><b>Sakha AI CareLoop</b><span>Screening to care coordination</span></div>
        <nav className="nav" aria-label="Main">
          {NAV.map(([to, label, soon]) => (
            <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
              <span>{label}</span>{soon && <span className="soon">{soon}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        {user.business.is_demo && <div className="banner" role="note">Simulated demonstration. Every patient, result and AI call in this workspace is synthetic.</div>}
        <header className="top">
          <strong>{user.business.name}</strong>
          <div className="who"><Link to="/follow-ups" aria-label={`${unread} unread notifications`}>Notifications{unread > 0 && <span className="badge">{unread}</span>}</Link> {user.name}, {user.role_label} <button onClick={logout} style={{ marginLeft: ".75rem" }}>Sign out</button></div>
        </header>
        <main id="main" className="page"><Outlet /></main>
      </div>
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <p className="muted" style={{ padding: "2rem" }} role="status">Loading...</p>;
  if (!user) return <Routes><Route path="*" element={<Login />} /></Routes>;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="cases" element={<Cases />} />
        <Route path="cases/new" element={<NewCase />} />
        <Route path="cases/:id" element={<CaseDetail />} />
        <Route path="escalations" element={<Escalations />} />
        <Route path="closure" element={<Closure />} />
        <Route path="staff" element={<StaffRoles />} />
        <Route path="settings" element={<Settings />} />
        <Route path="communication" element={<Communications />} />
        <Route path="referrals" element={<Referrals />} />
        <Route path="follow-ups" element={<FollowUps />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
