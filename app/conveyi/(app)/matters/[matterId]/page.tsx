'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { CaseHud, HUD_LOOK, type CaseHudData, type HudStatus } from '@/app/shared/engine/CaseHud';
import { House } from '@/app/shared/engine/CaseloadMap';
import { HEALTH_LABEL, pretty, type HealthBand, type WorkItem } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';

/**
 * One case. The top of the page is where it is: the stages, what is running inside each
 * and what each is waiting on — with the facts of the case beside it. Below the fold is
 * the detail a conveyancer goes looking for: who has what to do, the emails, the files,
 * the history.
 */
interface Row { id: string; matterRef: string | null; propertyAddress: string | null; stage: string; assignee: string | null; assignedTo: string | null }
interface Person { id: string; email: string; display_name: string | null }
interface Detail {
  matter: Record<string, any>;
  contacts: Array<{ id: string; email: string; name: string | null; role: string | null }>;
  timeline: Array<{ id: string; event_at: string | null; created_at: string; event_type: string; title: string; details: string | null }>;
}
interface Model { profile?: { label: string; side: string }; health?: { band: HealthBand; headline?: string | null }; hud?: CaseHudData; work?: WorkItem[] }

const CSS = `
.mx-head{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px}
.mx-title{font-size:21px;font-weight:800;margin:0;letter-spacing:-.01em;display:flex;align-items:center;gap:10px}
.mx-sub{color:#64748b;font-size:13px;margin:3px 0 0}
.mx-ctl{display:flex;gap:8px;align-items:center;margin-left:auto}
.mx-sel{padding:7px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;background:#fff;color:#0f172a;font-family:inherit}
.mx-health{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;border-radius:999px;padding:4px 11px 4px 6px}
.mx-top{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px;align-items:start}
.mx-card{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:14px 16px}
.mx-kv{display:grid;grid-template-columns:1fr;gap:9px}
.mx-k{font-size:11px;color:#94a3b8;font-weight:600}
.mx-v{font-size:13.5px;color:#0f172a;margin-top:1px}
.mx-pair{display:grid;grid-template-columns:1fr 1fr;gap:9px 14px}
.mx-hr{border:0;border-top:1px solid #eef1f5;margin:12px 0}
.mx-party{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:3px 0}
.mx-party a{color:#5A27E0;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-party span{color:#94a3b8;font-size:12px;white-space:nowrap}
.mx-sec{margin-top:22px}
.mx-h{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin:0 0 8px}
.mx-list{background:#fff;border:1px solid #e6e8ee;border-radius:14px;overflow:hidden}
.mx-li{display:grid;grid-template-columns:22px 1fr 190px 150px;gap:12px;align-items:center;padding:9px 14px;border-top:1px solid #f1f5f9;font-size:13px}
.mx-li:first-child{border-top:0}
a.mx-li{text-decoration:none;color:inherit}
a.mx-li:hover{background:#fafafa}
.mx-li .m{color:#64748b;font-size:12px}
.mx-two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.mx-row{display:flex;justify-content:space-between;gap:10px;padding:8px 14px;border-top:1px solid #f1f5f9;font-size:13px}
.mx-row:first-child{border-top:0}
.mx-row .d{color:#94a3b8;white-space:nowrap;font-size:12px}
.mx-ellip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:1100px){.mx-top{grid-template-columns:1fr}.mx-two{grid-template-columns:1fr}.mx-li{grid-template-columns:22px 1fr}.mx-li .m{display:none}}
`;

const BAND: Record<HealthBand, { fg: string; bg: string }> = {
  normal: { fg: '#166534', bg: '#dcfce7' }, attention: { fg: '#92400e', bg: '#fef3c7' }, delayed: { fg: '#9a3412', bg: '#ffedd5' }, blocked: { fg: '#1e293b', bg: '#e2e8f0' }, critical: { fg: '#991b1b', bg: '#fee2e2' },
};
const OWNER: Record<string, string> = { conveyancer: 'Us', client: 'Client', seller_side: "Other side's solicitor", lender: 'Lender', third_party: 'Third party', mlro: 'MLRO', hmlr: 'HM Land Registry', search_provider: 'Search provider', id_provider: 'ID provider' };
const money = (v: unknown) => { const n = Number(String(v ?? '').replace(/[£,\s]/g, '')); return Number.isFinite(n) && n > 0 ? `£${n.toLocaleString('en-GB')}` : ''; };
const day = (iso: unknown) => (iso ? new Date(String(iso)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const short = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const names = (v: unknown) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : typeof v === 'string' ? v : '');
const workStatus = (w: WorkItem): HudStatus => (w.bucket === 'escalate' ? 'blocked' : w.bucket === 'waiting' ? (w.chasesSent > 0 ? 'at_risk' : 'waiting') : 'todo');

function Field({ k, v }: { k: string; v: string }) {
  if (!v) return null;
  return <div><div className="mx-k">{k}</div><div className="mx-v">{v}</div></div>;
}

export default function MatterPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = use(params);
  const [row, setRow] = useState<Row | null>(null);
  const [team, setTeam] = useState<Person[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [emails, setEmails] = useState<Array<{ id: string; subject: string; lastMessageAt: string | null }> | null>(null);
  const [files, setFiles] = useState<Array<{ id: string; name: string; webUrl: string | null }> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, d, m] = await Promise.all([
      api<{ matter: Row; assignees: Person[] }>(`/matters/${matterId}/row`),
      api<Detail>(`/matters/${matterId}`),
      api<Model>(`/matters/${matterId}/engine/graph`).catch(() => null),
    ]);
    setRow(r.matter); setTeam(r.assignees); setDetail(d); setModel(m);
    api<{ threads: any[] }>(`/matters/${matterId}/emails`).then((x) => setEmails(x.threads ?? [])).catch(() => setEmails([]));
    api<{ files: any[] }>(`/matters/${matterId}/files`).then((x) => setFiles(x.files ?? [])).catch(() => setFiles([]));
  }, [matterId]);
  useEffect(() => { load().catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not open the matter.')); }, [load]);

  const setOwner = async (assignedTo: string | null) => {
    try { await api(`/matters/${matterId}`, { method: 'PATCH', body: JSON.stringify({ assignedTo }) }); await load(); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not change the owner.'); }
  };

  const m = detail?.matter ?? {};
  const nameOf = (id: string | null) => (id ? team.find((u) => u.id === id)?.display_name || team.find((u) => u.id === id)?.email || '' : '');
  const band = model?.health?.band;
  const side = model?.profile?.side ?? (m.track === 'SALE' ? 'seller' : 'buyer');
  const clients = names(side === 'seller' ? m.seller_names : m.buyer_names) || names(m.buyer_names) || names(m.seller_names);
  const work = (model?.work ?? []).slice().sort((a, b) => ({ escalate: 0, do: 1, waiting: 2 }[a.bucket] ?? 3) - ({ escalate: 0, do: 1, waiting: 2 }[b.bucket] ?? 3));

  return (
    <div className="eg">
      <style>{ENGINE_CSS + CSS}</style>
      {err && <div className="eg-err">{err}</div>}
      {row && (
        <>
          <div className="mx-head">
            <div style={{ minWidth: 0 }}>
              <h1 className="mx-title">{band && <House band={band} size={28} />}{row.propertyAddress ?? row.matterRef}</h1>
              <p className="mx-sub">{[row.matterRef, model?.profile?.label, clients].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="mx-ctl">
              {band && <span className="mx-health" style={{ background: BAND[band].bg, color: BAND[band].fg }}><House band={band} size={18} />{HEALTH_LABEL[band]}</span>}
              <select className="mx-sel" value={row.assignedTo ?? ''} onChange={(e) => void setOwner(e.target.value || null)} aria-label="Handler">
                <option value="">Unassigned</option>
                {team.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
              </select>
              <a className="eg-btn" href={paths.engineMatter(matterId)}>Details</a>
            </div>
          </div>

          <div className="mx-top">
            <div>{model?.hud && <CaseHud hud={model.hud} />}</div>
            <div className="mx-card">
              <div className="mx-kv">
                <Field k="Property" v={row.propertyAddress ?? String(m.property_address ?? '')} />
                <Field k={side === 'seller' ? 'Seller' : side === 'buyer' ? 'Buyer' : 'Client'} v={clients} />
              </div>
              <hr className="mx-hr" />
              <div className="mx-pair">
                <Field k="Price" v={money(m.purchase_price)} />
                <Field k="Lender" v={String(m.lender ?? '')} />
                <Field k="Exchange target" v={day(m.exchange_target_date)} />
                <Field k="Completion target" v={day(m.completion_target_date)} />
                <Field k="Other side" v={String(m.counterparty_solicitor ?? '')} />
                <Field k="Agent" v={String(m.counterparty_agent ?? '')} />
                <Field k="Handler" v={nameOf(row.assignedTo)} />
                <Field k="Reference" v={row.matterRef ?? ''} />
              </div>
              {(detail?.contacts ?? []).length > 0 && (
                <>
                  <hr className="mx-hr" />
                  {detail!.contacts.slice(0, 8).map((c) => (
                    <div key={c.id} className="mx-party">
                      <a href={`mailto:${c.email}`} title={c.email}>{c.name || c.email}</a>
                      <span>{pretty(String(c.role || '').toLowerCase())}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {work.length > 0 && (
            <div className="mx-sec">
              <h2 className="mx-h">Tasks</h2>
              <div className="mx-list">
                {work.map((w) => {
                  const st = workStatus(w);
                  const l = HUD_LOOK[st];
                  const due = w.dueBy ? `by ${short(w.dueBy)}` : w.chaseInWorkingDays != null ? (w.chaseInWorkingDays <= 0 ? 'chase due' : `chase in ${w.chaseInWorkingDays}d`) : '';
                  return (
                    <a key={w.id} className="mx-li" href={w.ref?.type === 'decision' ? paths.decision(w.ref.id) : paths.engineMatter(matterId)}>
                      <span style={{ color: l.colour, display: 'flex' }}><l.Icon size={16} /></span>
                      <span>{w.bucket === 'waiting' ? `Waiting on ${(OWNER[w.actionOwner] ?? pretty(w.actionOwner)).toLowerCase()} to ${w.what}` : w.what}</span>
                      <span className="m">{w.bucket === 'waiting' ? OWNER[w.actionOwner] ?? pretty(w.actionOwner) : nameOf(w.responsibilityOwner ?? row.assignedTo) || 'Unassigned'}</span>
                      <span className="m">{[due, w.chasesSent ? `chased ${w.chasesSent}×` : ''].filter(Boolean).join(' · ')}</span>
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          {((emails?.length ?? 0) > 0 || (files?.length ?? 0) > 0) && (
            <div className="mx-sec mx-two">
              {(emails?.length ?? 0) > 0 && (
                <div>
                  <h2 className="mx-h">Emails</h2>
                  <div className="mx-list">{emails!.slice(0, 12).map((t) => <div key={t.id} className="mx-row"><span className="mx-ellip">{t.subject || '(no subject)'}</span><span className="d">{short(t.lastMessageAt)}</span></div>)}</div>
                </div>
              )}
              {(files?.length ?? 0) > 0 && (
                <div>
                  <h2 className="mx-h">Files</h2>
                  <div className="mx-list">{files!.slice(0, 12).map((f) => <div key={f.id} className="mx-row">{f.webUrl ? <a className="mx-ellip" href={f.webUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#5A27E0', textDecoration: 'none' }}>{f.name}</a> : <span className="mx-ellip">{f.name}</span>}</div>)}</div>
                </div>
              )}
            </div>
          )}

          {(detail?.timeline ?? []).length > 0 && (
            <div className="mx-sec">
              <h2 className="mx-h">History</h2>
              <div className="mx-list">
                {detail!.timeline.slice(0, 25).map((e) => (
                  <div key={e.id} className="mx-row" style={{ justifyContent: 'flex-start' }}><span className="d" style={{ width: 70 }}>{short(e.event_at ?? e.created_at)}</span><span>{e.title.replace(/^Engine:\s*/, '').replace(/_/g, ' ')}</span></div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
