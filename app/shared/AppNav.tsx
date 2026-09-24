'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { paths } from '@/lib/paths';

/**
 * The one navigation for the CONVEYi app: the admin centre's sidebar, now shared.
 *
 * The admin centre already had the right shell — a sticky brand bar and a grouped left
 * sidebar. The newer screens (caseload, Today, decisions, email) were built beside it
 * with their own ad-hoc buttons, which is how a person could sign in and find no nav at
 * all. Now there is one list of places, defined here, and every page renders it in the
 * same sidebar. The admin centre keeps its own bar (tour, plan badge, onboarding) but
 * draws its sidebar from this list too, so switching pages never changes the shape.
 */
export type AdminTab = 'getstarted' | 'mywork' | 'billing' | 'board' | 'workload' | 'workflow' | 'templates' | 'docpacks' | 'automations' | 'team' | 'policy' | 'actions' | 'audit' | 'help';

export interface NavItem {
  key: string;
  label: string;
  icon: string;
  href: string;
  /** Set when the item is a tab of the admin centre; the admin page switches in place. */
  adminTab?: AdminTab;
  adminOnly?: boolean;
  /** Which pathname(s) count as "here" for a standalone page. */
  match?: (path: string) => boolean;
}

export const NAV_GROUPS: ReadonlyArray<{ label: string; items: NavItem[] }> = [
  {
    label: 'Work',
    items: [
      { key: 'today', label: 'Today', icon: '☀️', href: paths.today, match: (p) => p.startsWith(paths.today) },
      { key: 'engine-work', label: 'My Work', icon: '☑️', href: paths.myWork, match: (p) => p.startsWith(paths.myWork) },
      { key: 'decisions', label: 'Decisions', icon: '⚖️', href: paths.decisions, match: (p) => p.startsWith(paths.decisions) },
      { key: 'email', label: 'Email to File', icon: '✉️', href: paths.email, match: (p) => p.startsWith(paths.email) },
      { key: 'mywork', label: 'Tasks', icon: '📋', href: `${paths.admin}?tab=mywork`, adminTab: 'mywork' },
    ],
  },
  {
    label: 'Cases',
    items: [
      { key: 'cases', label: 'Caseload', icon: '🏘️', href: paths.cases, match: (p) => p.startsWith(paths.cases) || p.startsWith(`${paths.product}/engine/`) },
      { key: 'board', label: 'Matter Board', icon: '🗂️', href: `${paths.admin}?tab=board`, adminTab: 'board', adminOnly: true },
      { key: 'workflow', label: 'Case Flow', icon: '🔀', href: `${paths.admin}?tab=workflow`, adminTab: 'workflow', adminOnly: true },
    ],
  },
  {
    label: 'Content',
    items: [
      { key: 'templates', label: 'Email Templates', icon: '📨', href: `${paths.admin}?tab=templates`, adminTab: 'templates', adminOnly: true },
      { key: 'docpacks', label: 'Doc Packs', icon: '📄', href: `${paths.admin}?tab=docpacks`, adminTab: 'docpacks', adminOnly: true },
    ],
  },
  {
    label: 'Firm',
    items: [
      { key: 'team', label: 'Team', icon: '👥', href: `${paths.admin}?tab=team`, adminTab: 'team', adminOnly: true },
      { key: 'policy', label: 'Policy', icon: '🛡️', href: `${paths.admin}?tab=policy`, adminTab: 'policy', adminOnly: true },
      { key: 'integrations', label: 'Integrations', icon: '🔌', href: paths.leap, adminOnly: true, match: (p) => p.startsWith(`${paths.product}/integrations`) },
    ],
  },
  {
    label: 'Tools',
    items: [
      { key: 'actions', label: 'Tools', icon: '🔧', href: `${paths.admin}?tab=actions`, adminTab: 'actions', adminOnly: true },
      { key: 'audit', label: 'Audit Log', icon: '🕘', href: `${paths.admin}?tab=audit`, adminTab: 'audit', adminOnly: true },
    ],
  },
  {
    label: 'Account',
    items: [
      { key: 'billing', label: 'Billing', icon: '💳', href: `${paths.admin}?tab=billing`, adminTab: 'billing' },
      { key: 'help', label: 'Help & Support', icon: '💬', href: `${paths.admin}?tab=help`, adminTab: 'help' },
    ],
  },
];

/** The admin tabs the sidebar can reach — the admin page validates ?tab against this. */
export const ADMIN_TABS_IN_NAV = NAV_GROUPS.flatMap((g) => g.items).map((i) => i.adminTab).filter((t): t is AdminTab => !!t);

// The admin centre's exact styles, lifted verbatim so the two shells are indistinguishable.
const navGroupLabel: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: '#9aa6b8', padding: '0 4px 3px', marginBottom: 3, borderBottom: '1px solid #eef1f5' };
const navItem = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  width: '100%',
  textAlign: 'left',
  padding: '4px 9px',
  borderRadius: 8,
  border: 'none',
  ...(active ? { background: '#ede9fe', boxShadow: 'inset 3px 0 0 #5A27E0' } : {}),
  color: active ? '#5A27E0' : '#334155',
  fontWeight: active ? 700 : 500,
  fontSize: 13,
  cursor: 'pointer',
  marginBottom: 2,
  fontFamily: 'inherit',
  textDecoration: 'none',
  boxSizing: 'border-box',
});
export const SIDEBAR_STYLE: React.CSSProperties = { width: 162, flexShrink: 0, position: 'sticky', top: 70, alignSelf: 'flex-start', background: '#fff', border: '1px solid #e8eaf0', borderRadius: 14, padding: '11px 9px', maxHeight: 'calc(100vh - 96px)', overflowY: 'auto', boxShadow: '0 1px 2px rgba(16,24,40,0.04)' };

export const SHELL_CSS = `
@keyframes adm-spin{to{transform:rotate(360deg)}}
.adm-nav{transition:background .12s ease,color .12s ease}
.adm-nav:hover{background:#eef1f6}
`;

/**
 * The sidebar. On the admin page, an item that is one of its tabs switches in place
 * (onTab); everywhere else every item is a link.
 */
export function SidebarNav({ isAdmin, activeTab, onTab, extra }: { isAdmin: boolean; activeTab?: AdminTab | null; onTab?: (t: AdminTab) => void; extra?: React.ReactNode }) {
  const path = usePathname() ?? '';
  const onAdminPage = path.startsWith(paths.admin);
  const isActive = (i: NavItem) => (onAdminPage ? !!i.adminTab && i.adminTab === activeTab : !!i.match && i.match(path));
  return (
    <nav style={SIDEBAR_STYLE} aria-label="Main">
      {extra}
      {NAV_GROUPS.map((grp) => {
        const items = grp.items.filter((i) => isAdmin || !i.adminOnly);
        if (!items.length) return null;
        return (
          <div key={grp.label} style={{ marginBottom: 8 }}>
            <div style={navGroupLabel}>{grp.label}</div>
            {items.map((i) => {
              const active = isActive(i);
              const inner = (
                <>
                  <span aria-hidden style={{ fontSize: 13, width: 18, textAlign: 'center', filter: active ? 'none' : 'grayscale(0.4)', opacity: active ? 1 : 0.75 }}>{i.icon}</span>
                  <span style={{ flex: 1 }}>{i.label}</span>
                </>
              );
              if (i.adminTab && onTab && onAdminPage) {
                return (
                  <button key={i.key} data-tour={`nav-${i.adminTab}`} className="adm-nav" style={navItem(active)} onClick={() => onTab(i.adminTab!)}>
                    {inner}
                  </button>
                );
              }
              return (
                <a key={i.key} data-tour={i.adminTab ? `nav-${i.adminTab}` : undefined} className="adm-nav" style={navItem(active)} href={i.href} aria-current={active ? 'page' : undefined}>
                  {inner}
                </a>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

export function Brand() {
  return (
    <a href={paths.cases} style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: '#0f172a' }} aria-label="CONVEYi — caseload">
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#5A27E0" />
        <path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
      </svg>
      <strong style={{ fontSize: 17 }}>CONVE<span style={{ color: '#5A27E0' }}>Yi</span></strong>
    </a>
  );
}

/**
 * The shell for every app page other than the admin centre (which keeps its own bar for
 * the tour, the plan and onboarding, and renders SidebarNav itself).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? '';
  const [me, setMe] = useState<{ role: string; displayName: string | null; email: string } | null>(null);
  useEffect(() => {
    fetch('/api/v1/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setMe(b ? { role: b.role, displayName: b.displayName ?? null, email: b.email } : null))
      .catch(() => setMe(null));
  }, []);
  if (path.startsWith(paths.admin)) return <>{children}</>;
  return (
    <div style={{ background: '#f6f7fb', minHeight: '100vh', fontFamily: 'var(--font-manrope), ui-sans-serif, system-ui, sans-serif', color: '#0f172a' }}>
      <style>{SHELL_CSS}</style>
      <div style={{ background: '#fff', borderBottom: '1px solid #e8eaf0', position: 'sticky', top: 0, zIndex: 5 }}>
        <div style={{ width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 20px' }}>
          <Brand />
          {me && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, color: '#475569' }}>{me.displayName || me.email}</span>
              <span title={me.email} style={{ width: 30, height: 30, borderRadius: 999, background: '#ede9fe', color: '#5A27E0', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {(me.displayName || me.email).slice(0, 2).toUpperCase()}
              </span>
              <button
                onClick={() => { window.location.href = '/api/v1/auth/logout'; }}
                title="Sign out"
                style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '4px 6px', fontFamily: 'inherit' }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
      <div style={{ width: '100%', boxSizing: 'border-box', display: 'flex', gap: 16, alignItems: 'flex-start', padding: '22px 14px 56px' }}>
        {me ? <SidebarNav isAdmin={me.role === 'ADMIN'} /> : <nav style={SIDEBAR_STYLE} aria-label="Main" aria-busy="true" />}
        <div style={{ flex: 1, minWidth: 300 }}>{children}</div>
      </div>
    </div>
  );
}
