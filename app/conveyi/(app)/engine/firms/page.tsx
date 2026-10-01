'use client';
/** Every firm and where it stands on billing; comp one (free, full service), with or without an end date; and how CONVEYi runs for it (system mode and features). For the people who run CONVEYi. */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { BackLink } from '@/app/shared/BackLink';

type Flag = { key: string; label: string; on: boolean; byDefault: boolean; overridden: boolean };
type Setup = { mode: string; features: Flag[] };
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
.pf .pf-sel{border:1px solid #d0d5dd;border-radius:7px;padding:4px 30px 4px 8px;font:inherit;font-size:12.5px}
.pf .pf-on{border:1px solid #cbd5e1;color:#64748b;border-radius:99px;min-width:48px}
.pf .pf-on.yes{background:#dcfce7;border-color:#86efac;color:#166534}
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
  const [setup, setSetup] = useState<Record<string, Setup>>({});
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!firms) return;
    for (const f of firms) if (!setup[f.id]) api<Setup>(`/platform/firms/${f.id}/features`).then((r) => setSetup((s) => ({ ...s, [f.id]: r }))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firms]);
  const change = async (id: string, body: Record<string, unknown>, key: string) => {
    setBusy(`${id}:${key}`); setErr(null);
    try { const r = await api<Setup>(`/platform/firms/${id}/features`, { method: 'PATCH', body: JSON.stringify(body) }); setSetup((s) => ({ ...s, [id]: r })); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(null); }
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
          <thead><tr><th>Firm</th><th>Since</th><th>Users</th><th>Cases</th><th>Billing</th><th>Comp</th><th>Runs As</th></tr></thead>
          <tbody>
            {shown.map((f) => {
              const comped = !!f.comp_plan && (!f.comp_until || new Date(f.comp_until) > new Date());
              return (
                <Fragment key={f.id}>
                <tr>
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
                  <td>
                    {setup[f.id] ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <select className="pf-sel" value={setup[f.id].mode} disabled={busy === `${f.id}:mode`} onChange={(e) => void change(f.id, { mode: e.target.value }, 'mode')}>
                          <option value="standalone">Whole Case System</option>
                          <option value="alongside">Alongside LEAP Or InTouch</option>
                        </select>
                        <button type="button" onClick={() => setOpen(open === f.id ? null : f.id)}>{open === f.id ? 'Close' : 'Features'}</button>
                      </span>
                    ) : <span className="eg-sub">Loading…</span>}
                  </td>
                </tr>
                {open === f.id && setup[f.id] && (
                  <tr>
                    <td colSpan={7} style={{ background: '#fafbfc' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px' }}>
                        {setup[f.id].features.map((x) => (
                          <span key={x.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <button type="button" className={`pf-on${x.on ? ' yes' : ''}`} disabled={busy === `${f.id}:${x.key}`} onClick={() => void change(f.id, { feature: { key: x.key, on: !x.on } }, x.key)}>{x.on ? 'On' : 'Off'}</button>
                            {x.label}{x.overridden && <span className="eg-sub" style={{ fontSize: 11.5 }}>(Default {x.byDefault ? 'On' : 'Off'})</span>}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
