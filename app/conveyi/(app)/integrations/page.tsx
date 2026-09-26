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
.ig-find{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.ig-search{flex:1;min-width:220px;max-width:420px;border:1px solid #d0d5dd;border-radius:8px;padding:7px 10px;font:inherit;font-size:13px}
.ig-sel{border:1px solid #d0d5dd;border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;background:#fff}
.ig-count{font-size:12px;color:#94a3b8;font-variant-numeric:tabular-nums}
.ig-scroll{max-height:420px;overflow-y:auto;border:1px solid #e6e8ee;border-radius:10px;background:#fff}
.ig-scroll .ig-row{border:0;border-bottom:1px solid #f1f5f9;border-radius:0;margin:0}
.ig-scroll .ig-row:last-child{border-bottom:0}
.ig-pager{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-top:8px;font-size:12px;color:#64748b;font-variant-numeric:tabular-nums}
.ig-pager button{border:1px solid #d0d5dd;background:#fff;border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;font-weight:700;color:#334155;cursor:pointer}
.ig-pager button:disabled{color:#cbd5e1;cursor:default}
.ig-row .st{margin-left:auto;font-size:11px;font-weight:700;color:#64748b;background:#f1f5f9;border-radius:99px;padding:1px 8px;flex:0 0 auto}
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

interface MatterRow { id: string; matter_ref: string; property_address: string; status: string }

export default function ToolsPage() {
  const [leap, setLeap] = useState<Status | null | undefined>(undefined);
  const [intouch, setIntouch] = useState<Status | null | undefined>(undefined);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'open' | 'closed' | 'all'>('open');
  const [matters, setMatters] = useState<MatterRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const PAGE = 25;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  useEffect(() => {
    api<Status>('/integrations/leap/status').then(setLeap).catch(() => setLeap(null));
    api<Status>('/integrations/intouch/status').then(setIntouch).catch(() => setIntouch(null));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ matters?: Array<{ id: string; matterRef: string; propertyAddress: string; status: string }>; total?: number }>(
        `/matters?q=${encodeURIComponent(q)}&status=${status}&limit=${PAGE}&offset=${page * PAGE}`
      )
        .then((r) => {
          setMatters((r.matters ?? []).map((m) => ({ id: m.id, matter_ref: m.matterRef, property_address: m.propertyAddress, status: m.status })));
          setTotal(r.total ?? 0);
        })
        .catch(() => { setMatters([]); setTotal(0); });
    }, 200);
    return () => clearTimeout(t);
  }, [q, status, page]);
  useEffect(() => { setPage(0); }, [q, status]);
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
      <h2 className="ig-h2">Engine case pages</h2>
      <div className="ig-find">
        <input className="ig-search" placeholder="Find a case by reference, address or client" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="ig-sel" value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'closed' | 'all')}>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        <span className="ig-count">{total}</span>
      </div>
      <div className="ig-scroll">
        {matters.map((m) => (
          <a key={m.id} className="ig-row" href={paths.engineMatter(m.id)}>
            <b>{m.matter_ref}</b>
            <span>{m.property_address}</span>
            {status === 'all' && <span className="st">{m.status === 'CLOSED' ? 'Closed' : 'Open'}</span>}
          </a>
        ))}
      </div>
      {pages > 1 && (
        <div className="ig-pager">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span>{page + 1} / {pages}</span>
          <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
