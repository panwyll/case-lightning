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
.ig-row{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #e6e8ee;border-radius:10px;padding:10px 14px;margin-bottom:8px;text-decoration:none;color:inherit}
.ig-row:hover{border-color:#c4b5fd}
.ig-row b{font-size:13px}
.ig-row span{font-size:12px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ig-search{width:100%;max-width:420px;border:1px solid #d0d5dd;border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;margin-bottom:10px}
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

interface MatterRow { id: string; matter_ref: string; property_address: string }

export default function DeveloperPage() {
  const [leap, setLeap] = useState<Status | null | undefined>(undefined);
  const [intouch, setIntouch] = useState<Status | null | undefined>(undefined);
  const [q, setQ] = useState('');
  const [matters, setMatters] = useState<MatterRow[]>([]);
  useEffect(() => {
    api<Status>('/integrations/leap/status').then(setLeap).catch(() => setLeap(null));
    api<Status>('/integrations/intouch/status').then(setIntouch).catch(() => setIntouch(null));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ matters?: Array<{ id: string; matterRef: string; propertyAddress: string }> }>(`/matters?q=${encodeURIComponent(q)}`)
        .then((r) => setMatters((r.matters ?? []).map((m) => ({ id: m.id, matter_ref: m.matterRef, property_address: m.propertyAddress }))))
        .catch(() => setMatters([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const cards = [
    { name: 'LEAP', href: paths.leap, s: leap, firmOwned: false },
    { name: 'InTouch', href: `${paths.integrations}/intouch`, s: intouch, firmOwned: true },
  ];
  return (
    <div className="eg" style={{ maxWidth: 1100 }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top"><h1 className="eg-h1">Developer</h1></div>
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
      <h2 className="ig-h2">Engine matter pages</h2>
      <input className="ig-search" placeholder="Find a matter by reference or address" value={q} onChange={(e) => setQ(e.target.value)} />
      {matters.map((m) => (
        <a key={m.id} className="ig-row" href={paths.engineMatter(m.id)}>
          <b>{m.matter_ref}</b>
          <span>{m.property_address}</span>
        </a>
      ))}
      {matters.length === 0 && <p className="ig-what">No matters match.</p>}
    </div>
  );
}
