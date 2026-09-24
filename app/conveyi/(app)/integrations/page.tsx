'use client';
import { useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { paths } from '@/lib/paths';

/** The practice systems CONVEYi can sit on or feed: each one, its state, and its page. */
interface Status { configured: boolean; connection: { status: string; statusDetail: string | null; lastSyncAt: string | null } | null }

const CSS = `
.ig-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.ig-card{display:block;background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:16px 18px;text-decoration:none;color:inherit}
.ig-card:hover{border-color:#c4b5fd}
.ig-name{font-size:16px;font-weight:800;margin:0 0 4px}
.ig-what{font-size:13px;color:#64748b;margin:0 0 12px}
.ig-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;border-radius:999px;padding:3px 10px}
.ig-state i{width:8px;height:8px;border-radius:999px;display:inline-block}
`;

function state(s: Status | null | undefined) {
  if (!s) return { label: 'Loading…', bg: '#f1f5f9', fg: '#64748b', dot: '#cbd5e1' };
  if (!s.configured) return { label: 'Not available', bg: '#f1f5f9', fg: '#64748b', dot: '#cbd5e1' };
  const st = s.connection?.status?.toUpperCase();
  if (st === 'CONNECTED' || st === 'ACTIVE') return { label: 'Connected', bg: '#dcfce7', fg: '#14532d', dot: '#16a34a' };
  if (st === 'ERROR' || st === 'FAILED') return { label: 'Needs attention', bg: '#fee2e2', fg: '#7f1d1d', dot: '#dc2626' };
  return { label: 'Not connected', bg: '#fef3c7', fg: '#78350f', dot: '#d97706' };
}

export default function IntegrationsPage() {
  const [leap, setLeap] = useState<Status | null | undefined>(undefined);
  const [intouch, setIntouch] = useState<Status | null | undefined>(undefined);
  useEffect(() => {
    api<Status>('/integrations/leap/status').then(setLeap).catch(() => setLeap(null));
    api<Status>('/integrations/intouch/status').then(setIntouch).catch(() => setIntouch(null));
  }, []);
  const cards = [
    { name: 'LEAP', what: 'Practice management. Matters, documents and contacts come from LEAP.', href: paths.leap, s: leap },
    { name: 'InTouch', what: 'Client onboarding and portal. Cases, ID checks and forms come in; milestones go out.', href: `${paths.integrations}/intouch`, s: intouch },
  ];
  return (
    <div className="eg" style={{ maxWidth: 1000, margin: '0 auto' }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top"><h1 className="eg-h1">Integrations</h1></div>
      <div className="ig-grid">
        {cards.map((c) => {
          const st = state(c.s);
          return (
            <a key={c.name} className="ig-card" href={c.href}>
              <h2 className="ig-name">{c.name}</h2>
              <p className="ig-what">{c.what}</p>
              <span className="ig-state" style={{ background: st.bg, color: st.fg }}><i style={{ background: st.dot }} />{st.label}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
