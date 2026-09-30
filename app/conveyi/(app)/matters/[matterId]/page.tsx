'use client';
import { Spin } from '@/app/shared/engine/BusyButton';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import type { CaseHudData } from '@/app/shared/engine/CaseHud';
import { House } from '@/app/shared/engine/CaseloadMap';
import { HEALTH_LABEL, TRANSACTION_LABEL, pretty, stageLabel, type HealthBand, type WorkItem } from '@/app/shared/engine/types';
import { WorkPanel, WORK_CSS } from '@/app/shared/engine/WorkPanel';
import { DocumentsPanel } from '@/app/shared/engine/DocumentsPanel';
import { Timeline, type CaseLogEntry } from '@/app/shared/engine/Timeline';
import { Grouped, ListToolbar, useListTools } from '@/app/shared/engine/ListTools';

/** Case-log lines the timeline shows: filings, not the engine's own mirror of its events. */
const FILING_LOG = new Set(['EMAIL_FILED', 'DOC_RECEIVED', 'EMAIL_SAVED_TO_MATTER', 'ENGINE_INGEST_SKIPPED']);
import type { CaseModel } from '@/app/shared/engine/CaseView';
import { useEngine, type EngineBundle } from '@/app/shared/engine/useEngine';
import { ContactsCard } from '@/app/shared/engine/ContactsCard';
import { ChainCard } from '@/app/shared/engine/ChainCard';
import { CaseDetailsEdit } from '@/app/shared/engine/CaseDetailsEdit';
import { CaseQuickActions } from '@/app/shared/engine/CaseQuickActions';
import { paths } from '@/lib/paths';
import { ArrowLeft } from '@/app/shared/icons';
import { useRouter } from 'next/navigation';

/**
 * One case, whole. The Overview tab is where it is: the stages, what is running inside
 * each and what each is waiting on, with the facts of the case beside it and the tasks,
 * emails, files and history below. The other tabs are the doing: Work (every action a
 * person records), Issues, Notes, Documents and Timeline. There is no second page for a case.
 */
type Tab = 'overview' | 'tasks' | 'documents' | 'timeline';
const TABS: Tab[] = ['overview', 'tasks', 'documents', 'timeline'];
interface Row { id: string; matterRef: string | null; propertyAddress: string | null; stage: string; assignee: string | null; assignedTo: string | null }
interface Person { id: string; email: string; display_name: string | null }
interface Detail {
  matter: Record<string, any>;
  contacts: Array<{ id: string; email: string; name: string | null; role: string | null }>;
  timeline: Array<{ id: string; event_at: string | null; created_at: string; event_type: string; title: string; details: string | null }>;
}
type Model = CaseModel & { profile?: { label: string; side: string }; health?: { band: HealthBand; headline?: string | null }; hud?: CaseHudData; work?: WorkItem[] };

const CSS = `
.mx-head{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px}
.mx-title{font-size:21px;font-weight:800;margin:0;letter-spacing:-.01em;display:flex;align-items:center;gap:10px}
.mx-back{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:#334155;cursor:pointer;flex:none}
.mx-back:hover{background:#f1f5f9}
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
.mx-h{font-size:13px;font-weight:800;color:#0f172a;margin:0 0 6px;line-height:1.3}
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
  normal: { fg: '#166534', bg: '#dcfce7' }, attention: { fg: '#1e40af', bg: '#dbeafe' }, delayed: { fg: '#854d0e', bg: '#fef9c3' }, blocked: { fg: '#991b1b', bg: '#fee2e2' }, critical: { fg: '#fff', bg: '#111827' },
};
const money = (v: unknown) => { const n = Number(String(v ?? '').replace(/[£,\s]/g, '')); return Number.isFinite(n) && n > 0 ? `£${n.toLocaleString('en-GB')}` : ''; };
const day = (iso: unknown) => (iso ? new Date(String(iso)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const short = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const names = (v: unknown) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : typeof v === 'string' ? v : '');

function Field({ k, v }: { k: string; v: string }) {
  if (!v) return null;
  return <div><div className="mx-k">{k}</div><div className="mx-v">{v}</div></div>;
}

export default function MatterPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = use(params);
  // The URL's tab / focus / doc are read on the client after mount. Reading them through useSearchParams made the whole page
  // bail out of server rendering behind the segment's loading fallback, and a background tab then never got past it.
  const [q, setQ] = useState<{ tab: Tab | null; focus: string | null; doc: string | null }>({ tab: null, focus: null, doc: null });
  useEffect(() => {
    const s = new URLSearchParams(window.location.search);
    const t = s.get('tab') as Tab | null;
    // ?tab=issues (old links) opens Tasks, where issues now live.
    // Old links: ?tab=issues opens Tasks; ?tab=notes opens the history, where notes now live.
    setQ({ tab: (t as string) === 'issues' ? 'tasks' : (t as string) === 'notes' ? 'timeline' : t && TABS.includes(t) ? t : null, focus: s.get('focus'), doc: s.get('doc') });
  }, []);
  const focus = q.focus;
  const doc = q.doc;
  const [tab, setTabState] = useState<Tab>('overview');
  useEffect(() => { if (q.tab) setTabState(q.tab); }, [q.tab]);
  const setTab = (t: Tab) => {
    setTabState(t);
    const u = new URL(window.location.href);
    if (t === 'overview') u.searchParams.delete('tab'); else u.searchParams.set('tab', t);
    u.searchParams.delete('focus'); u.searchParams.delete('doc');
    window.history.replaceState(null, '', u.toString());
  };
  const bundleRef = useRef<(b: EngineBundle) => void>(() => {});
  const eng = useEngine(matterId, api, undefined, { onBundle: (b) => bundleRef.current(b) });
  const [stepping, setStepping] = useState(false);
  const [stepMsg, setStepMsg] = useState<string | null>(null);
  const nextStep = async () => {
    setStepping(true);
    setStepMsg(null);
    try {
      const r = await api<{ done: boolean; index: number; total: number; ran?: { label: string }; next?: string | null; blocked?: string | null; error?: string | null }>(`/engine/scenarios/${matterId}`, { method: 'POST', body: '{}' });
      setStepMsg(r.blocked ?? r.error ?? (r.ran ? `${r.index} of ${r.total}: ${r.ran.label}${r.next ? ` · next: ${r.next}` : ''}` : r.done ? 'Every step is done.' : null));
      await eng.load();
    } catch (e: unknown) {
      setStepMsg(e instanceof Error ? e.message : 'Could not step.');
    } finally {
      setStepping(false);
    }
  };
  const view = eng.view;
  const enrolled = !!view?.state.enrolled;
  const pending = (view?.surfacedDecisions?.filter((d) => d.kind !== 'auto_clear').length ?? 0) + (view?.due?.length ?? 0);
  // Issues live on Tasks now: its count is the decisions plus the open issues (context is not a task).
  const openIssues = Object.values(view?.state.issues ?? {}).filter((i) => (i.status === 'open' || i.status === 'negotiating') && !['seller_delay', 'buyer_delay'].includes(i.kind)).length;
  const [row, setRow] = useState<Row | null>(null);
  const [detailsVer, setDetailsVer] = useState(0);
  const [team, setTeam] = useState<Person[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [files, setFiles] = useState<Array<{ id: string; name: string; webUrl: string | null; documentId?: string | null; lastModified?: string | null }> | null>(null);
  const [rereadingFile, setRereadingFile] = useState<string | null>(null);
  // The case's files are searched and grouped by when, never cut off at a dozen.
  const fileTools = useListTools(files ?? [], { date: (f) => f.lastModified ?? '1970-01-01', text: (f) => f.name });
  const [fileNote, setFileNote] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  // The row, the summary and the model arrive with the engine view in one request; a command reloads all of them together.
  bundleRef.current = (b) => { const r = b.row as { matter: Row; assignees: Person[] }; setRow(r.matter); setTeam(r.assignees); setDetail(b.detail as Detail); setModel(b.graph as Model); };
  useEffect(() => { if (eng.err) setErr(eng.err); }, [eng.err]);
  // The case log (what happened to each email and file filed on the case) sits on the timeline beside the engine's events.
  const [caseLog, setCaseLog] = useState<CaseLogEntry[]>([]);
  useEffect(() => {
    if (tab !== 'timeline') return;
    api<{ timeline: Array<{ id: string; event_at: string | null; created_at: string; event_type: string; title: string; details: string | null }> }>(`/matters/${matterId}/timeline`)
      .then((r) => setCaseLog(r.timeline.filter((t) => FILING_LOG.has(t.event_type)).map((t) => ({ id: t.id, at: t.event_at ?? t.created_at, type: t.event_type, title: t.title, details: t.details }))))
      .catch(() => setCaseLog([]));
  }, [tab, matterId, eng.events.length]);
  const load = useCallback(async () => {
    api<{ files: any[] }>(`/matters/${matterId}/files`).then((x) => setFiles(x.files ?? [])).catch(() => setFiles([]));
  }, [matterId]);
  useEffect(() => { void load(); }, [load]);
  const refresh = () => { void eng.load(); void load().catch(() => {}); };

  const setOwner = async (assignedTo: string | null) => {
    try { await api(`/matters/${matterId}`, { method: 'PATCH', body: JSON.stringify({ assignedTo }) }); await eng.load(); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not change the owner.'); }
  };

  const router = useRouter();
  // Back to wherever the case was opened from (the board, Tasks, Email); the board when it was opened directly.
  const goBack = () => {
    let to: string | null = null;
    try { to = sessionStorage.getItem('conveyi:back'); } catch { /* the board */ }
    router.push(to || paths.cases);
  };
  const m = detail?.matter ?? {};
  const nameOf = (id: string | null) => (id ? team.find((u) => u.id === id)?.display_name || team.find((u) => u.id === id)?.email || '' : '');
  const band = model?.health?.band;
  const side = model?.profile?.side ?? (m.track === 'SALE' ? 'seller' : 'buyer');
  const clients = names(side === 'seller' ? m.seller_names : m.buyer_names) || names(m.buyer_names) || names(m.seller_names);

  return (
    <div className="eg">
      <style>{ENGINE_CSS + WORK_CSS + CSS}</style>
      {err && <div className="eg-err">{err}</div>}
      {row && (
        <>
          <div className="mx-head">
            <div style={{ minWidth: 0 }}>
              <h1 className="mx-title">
                <button type="button" className="mx-back" aria-label="Back" title="Back" onClick={goBack}><ArrowLeft size={18} /></button>
                {band && <House band={band} size={28} />}{row.propertyAddress ?? row.matterRef}
                {view?.state.transactionType && <span className="eg-chip muted">{TRANSACTION_LABEL[view.state.transactionType] ?? view.state.transactionType}</span>}
                {view?.chain && <a className="eg-chip" href={`/conveyi/matters/${view.chain.matterId}`} style={{ background: '#f3efff', color: '#5A27E0', border: '1px solid #c7b8f5', textDecoration: 'none' }} title={`The client's linked ${view.chain.relation}`}>Linked {view.chain.relation}{view.chain.propertyAddress ? ` · ${view.chain.propertyAddress.split(',')[0]}` : ''}</a>}
                {view && enrolled && <span className="eg-chip stage">{view.state.closedAt ? 'Closed' : view.state.abandoned ? 'Abandoned' : stageLabel(view.state.stage, view.profile)}</span>}
                {view && !enrolled && <span className="eg-chip muted">not enrolled</span>}
                {view?.state.manualHandling.required && <span className="eg-chip bad">manual handling</span>}
                {view?.matter?.sandbox && <span className="eg-chip" style={{ background: '#f3efff', color: '#5A27E0', border: '1px solid #c7b8f5' }} title={view.matter.sandboxStep ? `Scenario ${view.matter.sandboxScenario ?? ''} · ${view.matter.sandboxStep}` : undefined}>Sandbox</span>}
              </h1>
              <p className="mx-sub">{[row.matterRef, model?.profile?.label, clients, view?.lifecycle?.label].filter(Boolean).join(' · ')}</p>
              {stepMsg && <p className="mx-sub" style={{ color: '#5A27E0', fontWeight: 600 }}>{stepMsg}</p>}
            </div>
            <div className="mx-ctl">
              {view?.matter?.sandbox && /^\d+\//.test(view.matter.sandboxStep ?? '') && !view.state.closedAt && (
                <button className="mx-sel" style={{ cursor: 'pointer', background: '#5A27E0', color: '#fff', borderColor: '#5A27E0' }} disabled={stepping} onClick={() => void nextStep()} title={view.matter.sandboxStep ?? undefined}>{stepping ? <Spin>Stepping…</Spin> : 'Next Step'}</button>
              )}
              {view?.matter?.sandbox && <button className="mx-sel" style={{ cursor: 'pointer' }} onClick={() => { if (window.confirm('Retire this sandbox case? It leaves every list; its log stays.')) void api(`/engine/scenarios/${matterId}`, { method: 'DELETE' }).then(() => { window.location.href = '/conveyi/engine/scenarios'; }); }}>Retire Sandbox Case</button>}
              {/* The edge cases: raise an issue on the case, or take it over by hand. */}
              {enrolled && <CaseQuickActions api={api} matterId={matterId} onChanged={() => void eng.load()} />}
              {band && <span className="mx-health" style={{ background: BAND[band].bg, color: BAND[band].fg }}><House band={band} size={18} />{HEALTH_LABEL[band]}</span>}
              <select className="mx-sel" value={row.assignedTo ?? ''} onChange={(e) => void setOwner(e.target.value || null)} aria-label="Handler">
                <option value="">Unassigned</option>
                {team.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
              </select>
            </div>
          </div>

          {eng.notice && tab !== 'overview' && tab !== 'tasks' && (
            <div className={`eg-notice ${eng.notice.kind}`} role={eng.notice.kind === 'err' ? 'alert' : 'status'}>
              <span>{eng.notice.text}</span>
              <button type="button" onClick={eng.clearNotice} aria-label="Dismiss">×</button>
            </div>
          )}

          <div className="eg-tabs">
            <button className={`eg-tab${tab === 'overview' ? ' on' : ''}`} onClick={() => setTab('overview')}>Overview</button>
            <button className={`eg-tab${tab === 'tasks' ? ' on' : ''}`} onClick={() => setTab('tasks')} disabled={!enrolled}>Tasks{pending + openIssues ? ` (${pending + openIssues})` : ''}</button>
            <button className={`eg-tab${tab === 'documents' ? ' on' : ''}`} onClick={() => setTab('documents')} disabled={!enrolled}>Documents{view?.documentCount ? ` (${view.documentCount})` : ''}</button>
            <button className={`eg-tab${tab === 'timeline' ? ' on' : ''}`} onClick={() => setTab('timeline')} disabled={!enrolled}>Timeline{eng.events.length ? ` (${eng.events.length})` : ''}</button>
          </div>

          {tab === 'tasks' && view && enrolled && <WorkPanel matterId={matterId} api={api} view={view} busy={eng.busy} err={eng.err} cmd={eng.cmd} onChanged={refresh} notice={eng.notice} section="tasks" />}
          {tab === 'documents' && view && enrolled && <DocumentsPanel matterId={matterId} api={api} view={view} events={eng.events} busy={eng.busy} setBusy={eng.setBusy} onChanged={refresh} doc={doc} />}
          {tab === 'documents' && (files?.length ?? 0) > 0 && (
              <div className="mx-sec">
                {(files?.length ?? 0) > 0 && (
                  <div>
                    <h2 className="mx-h">Files</h2>
                    <div className="mx-list"><ListToolbar tools={fileTools} placeholder="Search files" /><Grouped tools={fileTools} render={(f) => <div key={f.id} className="mx-row">{f.webUrl ? <a className="mx-ellip" href={f.webUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#5A27E0', textDecoration: 'none' }}>{f.name}</a> : <span className="mx-ellip">{f.name}</span>}{f.documentId && <button className="mx-sel" style={{ cursor: 'pointer', marginLeft: 8, padding: '2px 8px', fontSize: 12 }} disabled={rereadingFile === f.documentId} onClick={() => { const id = f.documentId!; setRereadingFile(id); void api<{ said: string }>(`/documents/${id}/read-again`, { method: 'POST', body: '{}' }).then((r) => setFileNote((m) => ({ ...m, [id]: r.said }))).catch((e: unknown) => setFileNote((m) => ({ ...m, [id]: e instanceof Error ? e.message : 'Could not read it again.' }))).finally(() => { setRereadingFile(null); void eng.load(); }); }}>{rereadingFile === f.documentId ? <Spin>Reading…</Spin> : 'Read Again'}</button>}{f.documentId && fileNote[f.documentId] && <span className="d" style={{ marginLeft: 8 }}>{fileNote[f.documentId]}</span>}</div>} /></div>
                  </div>
                )}
              </div>
          )}
          {tab === 'timeline' && view && enrolled && <Timeline events={eng.events} state={view.state} focus={focus} onClearFocus={() => setTab('timeline')} log={caseLog} />}

          {tab === 'overview' && (<>
          <div className="mx-top">
            <div style={{ minWidth: 0 }}>{view ? <WorkPanel matterId={matterId} api={api} view={view} busy={eng.busy} err={eng.err} cmd={eng.cmd} onChanged={refresh} notice={eng.notice} /> : <div className="eg-sub">{eng.err ?? 'Loading…'}</div>}</div>
            <div className="mx-card">
              <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '-4px 0 4px' }}><CaseDetailsEdit matterId={matterId} api={api} matter={m} side={side} onSaved={() => { setDetailsVer((v) => v + 1); refresh(); }} /></div>
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
              {view && enrolled && <ChainCard matterId={matterId} api={api} view={view} busy={eng.busy} cmd={eng.cmd} />}
              <hr className="mx-hr" />
              <div className="mx-k" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: '#64748b', margin: '0 0 8px' }}>Contacts</div>
              <ContactsCard key={detailsVer} matterId={matterId} api={api} />
            </div>
          </div>
          </>)}
        </>
      )}
    </div>
  );
}
