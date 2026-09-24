'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { paths } from '@/lib/paths';

/**
 * The CONVEYi app shell: a top bar and a full-height sidebar, one piece, on every page.
 *
 * The session comes in as props from the server layout — nothing is fetched to draw the
 * nav, so it is there on the first paint. Every item is a client-side Link, so moving
 * between pages swaps the content and leaves the shell exactly where it was. The admin
 * centre's tabs are ordinary links to ?tab=…; it reads the URL and switches in place.
 */
export type AdminTab = 'getstarted' | 'mywork' | 'billing' | 'board' | 'workload' | 'workflow' | 'templates' | 'docpacks' | 'automations' | 'team' | 'policy' | 'actions' | 'audit' | 'help';

export interface Me { role: string; displayName: string | null; email: string }

interface NavItem {
  key: string;
  label: string;
  icon: string;
  href: string;
  adminTab?: AdminTab;
  adminOnly?: boolean;
  match?: (path: string) => boolean;
}

const GROUPS: ReadonlyArray<{ label: string; items: NavItem[] }> = [
  {
    label: 'Work',
    items: [
      { key: 'today', label: 'Today', icon: '☀️', href: paths.today, match: (p) => p.startsWith(paths.today) },
      { key: 'engine-work', label: 'My work', icon: '☑️', href: paths.myWork, match: (p) => p.startsWith(paths.myWork) },
      { key: 'decisions', label: 'Decisions', icon: '⚖️', href: paths.decisions, match: (p) => p.startsWith(paths.decisions) },
      { key: 'email', label: 'Email to file', icon: '✉️', href: paths.email, match: (p) => p.startsWith(paths.email) },
      { key: 'mywork', label: 'Tasks', icon: '📋', href: `${paths.admin}?tab=mywork`, adminTab: 'mywork' },
    ],
  },
  {
    label: 'Cases',
    items: [
      { key: 'cases', label: 'Caseload', icon: '🏘️', href: paths.cases, match: (p) => p.startsWith(paths.cases) || p.startsWith(`${paths.product}/matters/`) || p.startsWith(`${paths.product}/engine/`) },
      { key: 'workflow', label: 'Case flow', icon: '🔀', href: `${paths.admin}?tab=workflow`, adminTab: 'workflow', adminOnly: true },
    ],
  },
  {
    label: 'Content',
    items: [
      { key: 'templates', label: 'Email templates', icon: '📨', href: `${paths.admin}?tab=templates`, adminTab: 'templates', adminOnly: true },
      { key: 'docpacks', label: 'Doc packs', icon: '📄', href: `${paths.admin}?tab=docpacks`, adminTab: 'docpacks', adminOnly: true },
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
      { key: 'audit', label: 'Audit log', icon: '🕘', href: `${paths.admin}?tab=audit`, adminTab: 'audit', adminOnly: true },
    ],
  },
  {
    label: 'Account',
    items: [
      { key: 'billing', label: 'Billing', icon: '💳', href: `${paths.admin}?tab=billing`, adminTab: 'billing' },
      { key: 'help', label: 'Help & support', icon: '💬', href: `${paths.admin}?tab=help`, adminTab: 'help' },
    ],
  },
];

/** The admin tabs reachable from the nav — the admin page validates ?tab against this (plus its own hidden ones). */
export const ADMIN_TABS_IN_NAV: AdminTab[] = GROUPS.flatMap((g) => g.items).map((i) => i.adminTab).filter((t): t is AdminTab => !!t);

const TOP = 56;
const SIDE = 228;

export const SHELL_CSS = `
@keyframes adm-spin{to{transform:rotate(360deg)}}
.adm-nav{transition:background .12s ease,color .12s ease}
.adm-nav:hover{background:#eef1f6}
.sh-top{height:${TOP}px;background:#fff;border-bottom:1px solid #e8eaf0;position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:12px;padding:0 18px;box-sizing:border-box}
.sh-body{display:flex;align-items:stretch;min-height:calc(100vh - ${TOP}px)}
.sh-side{width:${SIDE}px;flex:0 0 ${SIDE}px;background:#fff;border-right:1px solid #e8eaf0;position:sticky;top:${TOP}px;height:calc(100vh - ${TOP}px);overflow-y:auto;padding:14px 12px 24px;box-sizing:border-box}
.sh-main{flex:1;min-width:0;padding:22px 24px 56px;box-sizing:border-box}
.sh-grp{font-size:10.5px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#9aa6b8;padding:0 8px 5px;margin:10px 0 4px;border-bottom:1px solid #eef1f5}
.sh-grp:first-child{margin-top:0}
.sh-item{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border-radius:8px;color:#334155;font-weight:500;font-size:13.5px;text-decoration:none;margin-bottom:2px;box-sizing:border-box;line-height:1.25}
.sh-item.on{background:#ede9fe;box-shadow:inset 3px 0 0 #5A27E0;color:#5A27E0;font-weight:700}
.sh-ico{font-size:14px;width:20px;text-align:center;filter:grayscale(.4);opacity:.75;flex-shrink:0}
.sh-item.on .sh-ico{filter:none;opacity:1}
.sh-me{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:13px;color:#475569}
.sh-av{width:30px;height:30px;border-radius:999px;background:#ede9fe;color:#5A27E0;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center}
.sh-out{background:none;border:none;color:#94a3b8;font-size:12.5px;font-weight:600;cursor:pointer;padding:4px 6px;font-family:inherit}
.sh-out:hover{color:#0f172a}
@media (max-width:820px){.sh-side{display:none}.sh-main{padding:16px}}
`;

function Items({ isAdmin }: { isAdmin: boolean }) {
  const path = usePathname() ?? '';
  const tab = useSearchParams()?.get('tab') ?? null;
  const onAdmin = path.startsWith(paths.admin);
  const active = (i: NavItem) => (onAdmin ? !!i.adminTab && i.adminTab === (tab ?? 'mywork') : !!i.match && i.match(path));
  return (
    <>
      {GROUPS.map((g) => {
        const items = g.items.filter((i) => isAdmin || !i.adminOnly);
        if (!items.length) return null;
        return (
          <div key={g.label}>
            <div className="sh-grp">{g.label}</div>
            {items.map((i) => (
              <Link key={i.key} href={i.href} className={`sh-item adm-nav${active(i) ? ' on' : ''}`} aria-current={active(i) ? 'page' : undefined} data-tour={i.adminTab ? `nav-${i.adminTab}` : undefined}>
                <span className="sh-ico" aria-hidden>{i.icon}</span>
                <span>{i.label}</span>
              </Link>
            ))}
          </div>
        );
      })}
    </>
  );
}

export function Brand() {
  return (
    <Link href={paths.cases} style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: '#0f172a' }} aria-label="CONVEYi — caseload">
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#5A27E0" />
        <path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
      </svg>
      <strong style={{ fontSize: 17 }}>CONVE<span style={{ color: '#5A27E0' }}>Yi</span></strong>
    </Link>
  );
}

export function AppShell({ me, children }: { me: Me | null; children: React.ReactNode }) {
  const isAdmin = me?.role === 'ADMIN';
  return (
    <div style={{ background: '#f6f7fb', minHeight: '100vh', fontFamily: 'var(--font-manrope), ui-sans-serif, system-ui, sans-serif', color: '#0f172a' }}>
      <style>{SHELL_CSS}</style>
      <header className="sh-top">
        <Brand />
        {me && (
          <div className="sh-me">
            <span>{me.displayName || me.email}</span>
            <span className="sh-av" title={me.email}>{(me.displayName || me.email).slice(0, 2).toUpperCase()}</span>
            <button className="sh-out" onClick={() => { window.location.href = '/api/v1/auth/logout'; }}>Sign out</button>
          </div>
        )}
      </header>
      <div className="sh-body">
        <nav className="sh-side" aria-label="Main">
          <Suspense fallback={null}>
            <Items isAdmin={isAdmin} />
          </Suspense>
        </nav>
        <main className="sh-main">{children}</main>
      </div>
    </div>
  );
}
