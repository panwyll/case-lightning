'use client';
/** Every firm and where it stands on billing; comp one (free, full service), with or without an end date. For the people who run CONVEYi. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { BackLink } from '@/app/shared/BackLink';

interface Firm { id: string; name: string; created_at: string; users: number; cases: number; comp_plan: string | null; comp_until: string | null; status: string; entitled: boolean; trialEndsAt: string | null; graceEndsAt: string | null }

const CSS = `
.pf-q{border:1px solid #d0d5dd;border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;width:320px;max-width:100%;margin-bottom:12px}
.pf{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden;font-size:13px}
.pf th{text-align:left;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#64748b;padding:9px 12px;border-bottom:1px solid #eef1f5;background:#fafbfc}
.pf td{padding:9px 12px;border-top:1px solid #f1f5f9;vertical-align:middle}
.pf .st{display:inline-block;font-size:11.5px;font-weight:700;border-radius:99px;padding:2px 9px;background:#f1f5f9;color:#334155}
.pf .st.ok{background:#dcfce7;color:#166534}.pf .st.warn{background:#fef3c7;color:#92400e}.pf .st.bad{background:#fee2e2;color:#991b1b}.pf .st.comp{background:#ede9fe;color:#5A27E0}
.pf input[type=date]{border:1px solid #d0d5dd;border-radius:7px;padding:4px 6px;font:inherit;font-size:12.5px}
.pf button{border:1px solid #5A27E0;background:#fff;color:#5A27E0;border-radius:7px;padding:4px 10px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
.pf button.go{background:#5A27E0;color:#fff}
.pf button:disabled{opacity:.5;cursor:default}
`;

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export default function FirmsPage() {
  const [firms, setFirms] = useState<Firm[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [until, setUntil] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api<{ firms: Firm[] }>('/platform/firms').then((r) => setFirms(r.firms)).catch((e: Error) => setErr(e.message)), []);
  useEffect(() => { void load(); }, [load]);
  const comp = async (f: Firm, on: boolean) => {
    setBusy(f.id); setErr(null);
    try { await api('/platform/firms', { method: 'PATCH', body: JSON.stringify({ tenantId: f.id, comp: on, until: on ? until[f.id] || null : null }) }); await load(); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(null); }
  };
  const status = (f: Firm) => {
    const comped = f.comp_plan && (!f.comp_until || new Date(f.comp_until) > new Date());
    if (comped) return <span className="st comp">Comped{f.comp_until ? ` to ${day(f.comp_until)}` : ''}</span>;
    if (f.graceEndsAt) return <span className="st warn">Payment failed · grace to {day(f.graceEndsAt)}</span>;
    if (f.status === 'trialing') return <span className="st">Trial{f.trialEndsAt ? ` to ${day(f.trialEndsAt)}` : ''}</span>;
    if (f.entitled) return <span className="st ok">Paying</span>;
    return <span className="st bad">Suspended</span>;
  };
  const shown = (firms ?? []).filter((f) => !q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="eg">
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top"><h1 className="eg-h1" style={{ display: 'flex', alignItems: 'center' }}><BackLink href="/conveyi/integrations" label="Back to Tools" />Firms</h1></div>
      {err && <div className="eg-err">{err}</div>}
      <input className="pf-q" placeholder="Search firms" value={q} onChange={(e) => setQ(e.target.value)} />
      {firms === null ? <div className="eg-sub">Loading…</div> : (
        <table className="pf">
          <thead><tr><th>Firm</th><th>Since</th><th>Users</th><th>Cases</th><th>Billing</th><th>Comp</th></tr></thead>
          <tbody>
            {shown.map((f) => {
              const comped = !!f.comp_plan && (!f.comp_until || new Date(f.comp_until) > new Date());
              return (
                <tr key={f.id}>
                  <td style={{ fontWeight: 700 }}>{f.name}</td>
                  <td>{day(f.created_at)}</td>
                  <td>{f.users}</td>
                  <td>{f.cases}</td>
                  <td>{status(f)}</td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {comped
                        ? <button type="button" disabled={busy === f.id} onClick={() => void comp(f, false)}>End Comp</button>
                        : <><input type="date" aria-label="Comp until (blank: no end)" value={until[f.id] ?? ''} onChange={(e) => setUntil({ ...until, [f.id]: e.target.value })} /><button type="button" className="go" disabled={busy === f.id} onClick={() => void comp(f, true)}>Comp</button></>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
