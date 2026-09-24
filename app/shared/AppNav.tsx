'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { paths } from '@/lib/paths';

/**
 * The one navigation every CONVEYi app page shares.
 *
 * Before this, the new screens (caseload, Today, decisions, email) each carried two or
 * three ad-hoc buttons and the original dashboard carried its own header, so a
 * conveyancer moving between them lost the nav entirely. There is one list of places
 * now, defined here, and both headers render it.
 */
export const NAV: ReadonlyArray<{ href: string; label: string; match: (path: string, tab: string | null) => boolean }> = [
  { href: paths.cases, label: 'Caseload', match: (p) => p.startsWith(paths.cases) || p.startsWith(`${paths.product}/engine/`) },
  { href: paths.today, label: 'Today', match: (p) => p.startsWith(paths.today) },
  { href: paths.myWork, label: 'My work', match: (p) => p.startsWith(paths.myWork) },
  { href: paths.decisions, label: 'Decisions', match: (p) => p.startsWith(paths.decisions) },
  { href: paths.email, label: 'Email', match: (p) => p.startsWith(paths.email) },
  // The original dashboard — the matters board and everything the firm set up.
  { href: `${paths.admin}?tab=board`, label: 'Matters', match: (p, tab) => p.startsWith(paths.admin) && tab === 'board' },
  { href: `${paths.admin}?tab=mywork`, label: 'Tasks', match: (p, tab) => p.startsWith(paths.admin) && (tab === 'mywork' || tab === null) },
  { href: `${paths.admin}?tab=team`, label: 'Settings', match: (p, tab) => (p.startsWith(paths.admin) && !!tab && !['board', 'mywork'].includes(tab)) || p.startsWith(`${paths.product}/integrations`) || p.startsWith(paths.account) },
];

const CSS = `
.an-links{display:flex;gap:2px;align-items:center;overflow-x:auto;scrollbar-width:none;min-width:0}
.an-links::-webkit-scrollbar{display:none}
.an-link{white-space:nowrap;text-decoration:none;color:#475569;font-size:13.5px;font-weight:600;padding:6px 10px;border-radius:8px}
.an-link:hover{background:#f1f5f9;color:#0f172a}
.an-link.on{background:#ede9fe;color:#4c1d95}
.an-bar{background:#fff;border-bottom:1px solid #e8eaf0;position:sticky;top:0;z-index:20}
.an-in{max-width:1240px;margin:0 auto;display:flex;align-items:center;gap:14px;padding:9px 16px}
.an-brand{display:flex;align-items:center;gap:8px;text-decoration:none;color:#0f172a;flex-shrink:0}
.an-brand b{font-size:16.5px;font-weight:800;letter-spacing:-.01em}
.an-brand b span{color:#5A27E0}
.an-me{margin-left:auto;display:flex;align-items:center;gap:10px;flex-shrink:0;font-size:13px;color:#475569}
.an-out{background:none;border:0;color:#94a3b8;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;padding:4px 6px}
.an-out:hover{color:#0f172a}
@media (max-width:720px){.an-me .an-name{display:none}}
`;

/** The list of places. Used by the shared header and inside the original dashboard's own bar. */
export function AppNavLinks() {
  const path = usePathname() ?? '';
  const [tab, setTab] = useState<string | null>(null);
  // The dashboard switches tabs client-side, so the active item has to follow the URL.
  useEffect(() => {
    const read = () => setTab(new URLSearchParams(window.location.search).get('tab'));
    read();
    window.addEventListener('popstate', read);
    const t = setInterval(read, 400);
    return () => {
      window.removeEventListener('popstate', read);
      clearInterval(t);
    };
  }, [path]);
  return (
    <nav className="an-links" aria-label="Main">
      <style>{CSS}</style>
      {NAV.map((n) => (
        <a key={n.label} className={`an-link${n.match(path, tab) ? ' on' : ''}`} href={n.href} aria-current={n.match(path, tab) ? 'page' : undefined}>
          {n.label}
        </a>
      ))}
    </nav>
  );
}

export function Brand() {
  return (
    <a className="an-brand" href={paths.cases} aria-label="CONVEYi — caseload">
      <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#5A27E0" />
        <path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
      </svg>
      <b>CONVE<span>Yi</span></b>
    </a>
  );
}

/**
 * The shared header for every app page except the original dashboard, which keeps its
 * own bar (it carries the tour, the plan and onboarding) and renders AppNavLinks inside it.
 */
export function AppHeader() {
  const path = usePathname() ?? '';
  const [me, setMe] = useState<{ displayName: string | null; email: string } | null>(null);
  useEffect(() => {
    fetch('/api/v1/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setMe(b ? { displayName: b.displayName ?? null, email: b.email } : null))
      .catch(() => setMe(null));
  }, []);
  if (path.startsWith(paths.admin)) return null;
  return (
    <header className="an-bar">
      <style>{CSS}</style>
      <div className="an-in">
        <Brand />
        <AppNavLinks />
        <div className="an-me">
          {me && <span className="an-name">{me.displayName || me.email}</span>}
          <button className="an-out" onClick={() => { window.location.href = '/api/v1/auth/logout'; }}>Sign out</button>
        </div>
      </div>
    </header>
  );
}
