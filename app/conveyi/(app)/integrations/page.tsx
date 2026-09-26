'use client';
import { useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { paths } from '@/lib/paths';

/** Developer surface: the practice systems CONVEYi can sit on or feed, and the engine pages that are not in the sidebar yet. */
interface Status { configured: boolean; connection: { status: string; statusDetail: string | null; lastSyncAt: string | null } | null }

const CSS = `
.ig-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.ig-card{display:block;background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:16px 18px;text-decoration:none;color:inherit}
.ig-card:hover{border-color:#c4b5fd}
.ig-name{font-size:16px;font-weight:800;margin:0 0 4px}
.ig-what{font-size:13px;color:#64748b;margin:0 0 12px}
.ig-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;border-radius:999px;padding:3px 10px}
.ig-state i{width:8px;height:8px;border-radius:999px;display:inline-block}
.ig-h2{font-size:13px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin:26px 0 10px}
`;

/** `firmOwned`: the firm enters its own credentials, so unconfigured just means not connected yet. */
function state(s: Status | null | undefined, firmOwned = false) {
  if (!s) return { label: 'Loading…', bg: '#f1f5f9', fg: '#64748b', dot: '#cbd5e1' };
  if (!s.configured && !firmOwned) return { label: 'Not available', bg: '#f1f5f9', fg: '#64748b', dot: '#cbd5e1' };
  const st = s.connection?.status?.toUpperCase();
  if (st === 'CONNECTED' || st === 'ACTIVE') return { label: 'Connected', bg: '#dcfce7', fg: '#14532d', dot: '#16a34a' };
  if (st === 'ERROR' || st === 'FAILED') return { label: 'Needs attention', bg: '#fee2e2', fg: '#7f1d1d', dot: '#dc2626' };
  return { label: 'Not connected', bg: '#fef3c7', fg: '#78350f', dot: '#d97706' };
}

export default function ToolsPage() {
  const [leap, setLeap] = useState<Status | null | undefined>(undefined);
  const [intouch, setIntouch] = useState<Status | null | undefined>(undefined);
  useEffect(() => {
    api<Status>('/integrations/leap/status').then(setLeap).catch(() => setLeap(null));
    api<Status>('/integrations/intouch/status').then(setIntouch).catch(() => setIntouch(null));
  }, []);
  const cards = [
    { name: 'LEAP', href: paths.leap, s: leap, firmOwned: false },
    { name: 'InTouch', href: `${paths.integrations}/intouch`, s: intouch, firmOwned: true },
  ];
  return (
    <div className="eg" style={{ maxWidth: 1100 }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top"><h1 className="eg-h1">Tools</h1></div>
      <div className="ig-grid" style={{ marginBottom: 4 }}>
        <a className="ig-card" href={`${paths.admin}?tab=audit`}><h2 className="ig-name">Audit log</h2><p className="ig-what">Every action the app took or a person took in it.</p></a>
        <a className="ig-card" href={`${paths.admin}?tab=actions`}><h2 className="ig-name">Actions</h2><p className="ig-what">One-off maintenance a firm admin can run.</p></a>
      </div>
      <h2 className="ig-h2">Integrations</h2>
      <div className="ig-grid">
        {cards.map((c) => {
          const st = state(c.s, c.firmOwned);
          return (
            <a key={c.name} className="ig-card" href={c.href}>
              <h2 className="ig-name">{c.name}</h2>
              <span className="ig-state" style={{ background: st.bg, color: st.fg }}><i style={{ background: st.dot }} />{st.label}</span>
            </a>
          );
        })}
      </div>

      <h2 className="ig-h2">Engine</h2>
      <div className="ig-grid" style={{ marginBottom: 18 }}>
        <a className="ig-card" href={paths.machineMap}><h2 className="ig-name">Machine map</h2><p className="ig-what">Every stage, command and gate the engine knows.</p></a>
        <a className="ig-card" href={paths.shadowQueue}><h2 className="ig-name">Shadow review</h2><p className="ig-what">What the engine would have done, for checking before it is trusted.</p></a>
      </div>
    </div>
  );
}
