import { useCallback, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import Login from './pages/Login.jsx';
import Servers from './pages/Servers.jsx';
import Chat from './pages/Chat.jsx';
import Keys from './pages/Keys.jsx';
import Team from './pages/Team.jsx';
import Audit from './pages/Audit.jsx';

const ROUTES = (admin) => [
  { id: 'servers', label: admin ? 'Servers' : 'Tools', el: Servers },
  { id: 'chat', label: 'Chat', el: Chat },
  { id: 'keys', label: 'API keys', el: Keys },
  ...(admin ? [{ id: 'team', label: 'Team', el: Team }] : []),
  { id: 'audit', label: 'Audit log', el: Audit },
];
const hashRoute = () => (window.location.hash.replace(/^#\/?/, '') || 'servers');

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking session, null = signed out
  const [notice, setNotice] = useState('');
  const [route, setRoute] = useState(hashRoute());

  useEffect(() => { setUnauthorizedHandler(() => { setUser(null); setNotice('Your session has ended. Sign in again.'); }); }, []);
  useEffect(() => { api.me().then(setUser).catch(() => setUser(null)); }, []);
  useEffect(() => { const f = () => setRoute(hashRoute()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const signOut = useCallback(async () => { try { await api.logout(); } catch { /* already gone */ } setUser(null); setNotice(''); window.location.hash = '#/servers'; }, []);

  if (user === undefined) return <p className="empty" style={{ padding: '2rem' }}>Checking your session…</p>;
  if (!user) return <Login notice={notice} onSignedIn={(u) => { setNotice(''); setUser(u); }} />;

  const admin = user.role === 'admin';
  const routes = ROUTES(admin);
  const current = routes.find((r) => r.id === route) ?? routes[0];
  const Page = current.el;
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--signal)" /><path d="M8 21V11l8 6 8-6v10" fill="none" stroke="var(--on-signal)" strokeWidth="2.4" strokeLinejoin="round" /></svg>
          MCP gateway
        </div>
        <nav className="nav" aria-label="Main">
          {routes.map((r) => <a key={r.id} href={`#/${r.id}`} aria-current={r.id === current.id ? 'page' : undefined}>{r.label}</a>)}
        </nav>
        <div className="who">
          <strong>{user.name}</strong>
          <span>{user.email} ({user.role})</span>
          <div><button type="button" className="btn btn-quiet" style={{ paddingLeft: 0 }} onClick={signOut}>Sign out</button></div>
        </div>
      </aside>
      <main className="main"><Page user={user} /></main>
    </div>
  );
}
