'use client';
import { Fragment, use, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { CaseIntelligence } from '@/app/shared/engine/CaseIntelligence';
import type { CaseModel } from '@/app/shared/engine/CaseView';
import { useEngine } from '@/app/shared/engine/useEngine';
import { paths } from '@/lib/paths';
import { Check, CircleDot, Circle, Pause, Minus, AlertTriangle, Ban, ChevronRight } from '@/app/shared/icons';

/**
 * One matter, as a person reads it.
 *
 * Top: the firm's stages as a row of blocks, each saying plainly where it stands — done,
 * in progress, up next. Under the block you pick: its steps, each with a status word.
 * Then the case itself: figures, what is outstanding, the parties, to-dos, emails, files
 * and the activity log. Where the engine is following the matter, what it sees sits
 * between the two, because that is status too.
 *
 * Nothing here needs a technical reader. If a word on this page needs explaining, the
 * word is wrong.
 */
type Api = <T = any>(path: string, options?: RequestInit) => Promise<T>;

interface Template { id: string; stage: string; detail: string; sort_order: number; pos_y: number }
interface FlowTask { id: string; ref: string; detail: string; status: string; assignee: string | null; due: string | null; template_id: string | null }
interface Flow {
  matter: { id: string; matterRef: string; propertyAddress: string | null; stage: string | null };
  stages: Array<{ key: string; name: string; sort_order: number }>;
  stageIndex: number;
  templates: Template[];
  byTemplate: Record<string, FlowTask>;
  offFlow: FlowTask[];
}
interface Row { id: string; matterRef: string | null; propertyAddress: string | null; stage: string; status: string; statusFlag: string; assignee: string | null; assignedTo: string | null }
interface Detail {
  matter: Record<string, any>;
  summary: { facts: Record<string, unknown>; outstanding_items: any[]; risks: any[] };
  timeline: Array<{ id: string; event_at: string | null; created_at: string; event_type: string; title: string; details: string | null }>;
  contacts: Array<{ id: string; email: string; name: string | null; role: string | null }>;
}

type StepState = 'done' | 'doing' | 'todo' | 'blocked' | 'notstarted';
const STEP: Record<StepState, { label: string; mark: React.ReactNode; colour: string }> = {
  done: { label: 'Done', mark: <Check size={14} />, colour: '#16a34a' },
  doing: { label: 'In progress', mark: <CircleDot size={14} />, colour: '#5A27E0' },
  todo: { label: 'To do', mark: <Circle size={14} />, colour: '#b45309' },
  blocked: { label: 'Waiting on something', mark: <Pause size={13} />, colour: '#64748b' },
  notstarted: { label: 'Not started', mark: <Minus size={14} />, colour: '#cbd5e1' },
};
type BlockState = 'done' | 'current' | 'upcoming';
type Rag = 'green' | 'amber' | 'red' | 'grey';
const RAG: Record<Rag, { fg: string; bg: string; border: string; icon: React.ReactNode }> = {
  green: { fg: '#14532d', bg: '#dcfce7', border: '#86efac', icon: <Check size={12} /> },
  amber: { fg: '#78350f', bg: '#fef3c7', border: '#fcd34d', icon: <AlertTriangle size={12} /> },
  red: { fg: '#7f1d1d', bg: '#fee2e2', border: '#fca5a5', icon: <Ban size={12} /> },
  grey: { fg: '#64748b', bg: '#f1f5f9', border: '#e6e8ee', icon: <Circle size={12} /> },
};

const FIGURES: Array<{ label: string; col: string; kind?: 'money' | 'date' }> = [
  { label: 'Price', col: 'purchase_price', kind: 'money' },
  { label: 'Exchange target', col: 'exchange_target_date', kind: 'date' },
  { label: 'Completion target', col: 'completion_target_date', kind: 'date' },
  { label: 'Lender', col: 'lender' },
  { label: 'Chain', col: 'chain_position' },
  { label: 'Other side’s solicitor', col: 'counterparty_solicitor' },
  { label: 'Agent', col: 'counterparty_agent' },
];
const FLAG: Record<string, { label: string; bg: string; fg: string }> = {
  ON_TRACK: { label: 'On track', bg: '#dcfce7', fg: '#14532d' },
  NEEDS_ATTENTION: { label: 'Needs attention', bg: '#fef3c7', fg: '#78350f' },
  BLOCKED: { label: 'Blocked', bg: '#fee2e2', fg: '#7f1d1d' },
};

const CSS = `
.mv-head{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-bottom:16px}
.mv-title{font-size:22px;font-weight:800;margin:0;letter-spacing:-.01em}
.mv-ref{color:#64748b;font-size:13px;margin:3px 0 0}
.mv-ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto}
.mv-sel{padding:7px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;background:#fff;color:#0f172a;font-family:inherit}

.mv-flow{display:flex;align-items:stretch;overflow-x:auto;padding:2px 0 8px;margin-bottom:10px}
.mv-node{flex:1 1 0;min-width:138px;text-align:left;border:1px solid #e6e8ee;background:#fff;border-radius:10px;padding:10px 12px;cursor:pointer;font-family:inherit;position:relative}
.mv-node.current{border-width:2px}
.mv-node.open{box-shadow:0 0 0 3px #ddd6fe}
.mv-node:hover{background:#fafafa}
.mv-nn{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#334155;line-height:1.25}
.mv-rag{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:800;border-radius:999px;padding:2px 8px;margin-top:7px;white-space:nowrap}
.mv-np{font-size:11px;color:#94a3b8;margin-top:5px}
.mv-arrow{flex:0 0 22px;display:flex;align-items:center;justify-content:center;color:#cbd5e1}
.mv-steps{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:6px 14px;margin-bottom:18px}
.mv-step{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid #f1f5f9}
.mv-step:first-child{border-top:0}
.mv-mark{width:24px;height:24px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;flex-shrink:0}
.mv-st{flex:1;font-size:14px;color:#0f172a}
.mv-sw{font-size:12.5px;font-weight:700;white-space:nowrap}
.mv-sm{font-size:12px;color:#94a3b8;white-space:nowrap}
.mv-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:900px){.mv-grid{grid-template-columns:1fr}}
.mv-card{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:14px 16px}
.mv-h{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748b;margin:0 0 10px}
.mv-kv{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.mv-k{font-size:11px;color:#94a3b8}
.mv-v{font-size:14px;color:#0f172a;margin-top:1px}
.mv-v.empty{color:#cbd5e1}
.mv-row{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid #f4f6f9;font-size:13.5px}
.mv-row:first-of-type{border-top:0}
.mv-muted{color:#94a3b8}
.mv-none{font-size:13px;color:#cbd5e1;margin:0}
.mv-sec{margin-top:14px}
.mv-tl{display:flex;gap:10px;padding:7px 0;border-top:1px solid #f4f6f9;font-size:13px}
.mv-tl:first-of-type{border-top:0}
.mv-tl time{color:#94a3b8;white-space:nowrap;width:82px;flex-shrink:0}
`;

const money = (v: unknown) => { const n = Number(String(v ?? '').replace(/[£,\s]/g, '')); return Number.isFinite(n) && n > 0 ? `£${n.toLocaleString('en-GB')}` : String(v ?? ''); };
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const whenShort = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

/**
 * A step's status, read the way a person would. Where there is a task on file it speaks
 * for itself. Where there is none, the stage decides: a stage the matter has moved past
 * is done, the stage it is in is to do, anything later has not started.
 */
function stepState(t: FlowTask | undefined, block: BlockState): StepState {
  if (!t) return block === 'done' ? 'done' : block === 'current' ? 'todo' : 'notstarted';
  if (t.status === 'DONE' || t.status === 'NOTED') return 'done';
  if (t.status === 'BLOCKED') return 'blocked';
  if (t.status === 'IN_PROGRESS') return 'doing';
  return 'todo';
}

export default function MatterPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = use(params);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [row, setRow] = useState<Row | null>(null);
  const [team, setTeam] = useState<Array<{ id: string; email: string; display_name: string | null }>>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [emails, setEmails] = useState<Array<{ id: string; subject: string; lastMessageAt: string | null; participants: string[] }> | null>(null);
  const [files, setFiles] = useState<{ files: Array<{ id: string; name: string; webUrl: string | null }>; folderProvisioned: boolean } | null>(null);
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [f, r, d] = await Promise.all([
      api<Flow>(`/matters/${matterId}/flow`),
      api<{ matter: Row; assignees: Array<{ id: string; email: string; display_name: string | null }> }>(`/matters/${matterId}/row`),
      api<Detail>(`/matters/${matterId}`),
    ]);
    setFlow(f); setRow(r.matter); setTeam(r.assignees); setDetail(d);
    // The slower, secondary reads do not hold the page up.
    api<{ threads: any[] }>(`/matters/${matterId}/emails`).then((x) => setEmails(x.threads ?? [])).catch(() => setEmails([]));
    api<typeof files>(`/matters/${matterId}/files`).then(setFiles).catch(() => setFiles({ files: [], folderProvisioned: false }));
    api<{ state: { enrolled: boolean } }>(`/matters/${matterId}/engine`).then((x) => setEnrolled(!!x.state?.enrolled)).catch(() => setEnrolled(false));
  }, [matterId]);

  useEffect(() => {
    load().catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not open the matter.'));
  }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api(`/matters/${matterId}`, { method: 'PATCH', body: JSON.stringify(body) });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not save that change.');
    }
  };

  // The flow: every stage in order, with a red/amber/green reading of where THIS matter is.
  const blocks = useMemo(() => {
    if (!flow) return [];
    const currentIdx = flow.stages.findIndex((s) => s.key === flow.matter.stage);
    const now = Date.now();
    return flow.stages.map((s, i) => {
      const steps = flow.templates.filter((t) => t.stage === s.key).sort((a, b) => a.pos_y - b.pos_y || a.sort_order - b.sort_order);
      const state: BlockState = currentIdx >= 0 && i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'upcoming';
      const states = steps.map((t) => stepState(flow.byTemplate[t.id], state));
      const done = states.filter((x) => x === 'done').length;
      const overdue = steps.some((t, k) => { const task = flow.byTemplate[t.id]; return states[k] !== 'done' && task?.due && new Date(task.due).getTime() < now; });
      let rag: Rag; let status: string;
      if (state === 'done') { rag = 'green'; status = 'Done'; }
      else if (state === 'upcoming') { rag = 'grey'; status = 'Not started'; }
      else if (row?.statusFlag === 'BLOCKED' || states.some((x) => x === 'blocked')) { rag = 'red'; status = 'Blocked'; }
      else if (row?.statusFlag === 'NEEDS_ATTENTION' || overdue) { rag = 'amber'; status = 'Attention'; }
      else { rag = 'green'; status = 'On track'; }
      return { ...s, steps, states, done, total: steps.length, state, rag, status };
    });
  }, [flow, row]);

  const selectedKey = picked;
  const selected = blocks.find((b) => b.key === selectedKey) ?? null;
  const m = detail?.matter ?? {};
  const outstanding: any[] = detail?.summary?.outstanding_items ?? [];
  const risks: any[] = detail?.summary?.risks ?? [];
  const flag = FLAG[row?.statusFlag ?? 'ON_TRACK'] ?? FLAG.ON_TRACK;

  return (
    <div className="eg" style={{ maxWidth: 1180, margin: '0 auto' }}>
      <style>{ENGINE_CSS + CSS}</style>
      {err && <div className="eg-err">{err}</div>}
      {!flow && !err && <div className="eg-sub">Loading…</div>}
      {flow && row && (
        <>
          <div className="mv-head">
            <div>
              <h1 className="mv-title">{flow.matter.propertyAddress ?? flow.matter.matterRef}</h1>
              <p className="mv-ref">{flow.matter.matterRef}{row.assignee ? ` · ${row.assignee}` : ''}{enrolled ? ' · tracked' : ''}</p>
            </div>
            <div className="mv-ctl">
              <select className="mv-sel" value={row.stage} onChange={(e) => void patch({ stage: e.target.value })} aria-label="Stage">
                {flow.stages.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
              <select className="mv-sel" value={row.statusFlag ?? 'ON_TRACK'} onChange={(e) => void patch({ statusFlag: e.target.value })} aria-label="Status" style={{ background: flag.bg, color: flag.fg, borderColor: 'transparent', fontWeight: 700 }}>
                {Object.entries(FLAG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <select className="mv-sel" value={row.assignedTo ?? ''} onChange={(e) => void patch({ assignedTo: e.target.value || null })} aria-label="Owner">
                <option value="">Unassigned</option>
                {team.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
              </select>
              <a className="eg-btn" href={paths.engineMatter(matterId)}>{enrolled ? 'Details' : 'Track'}</a>
            </div>
          </div>

          <div className="mv-flow" role="tablist" aria-label="Stages">
            {blocks.map((b, i) => {
              const look = RAG[b.rag];
              const open = b.key === selectedKey;
              return (
                <Fragment key={b.key}>
                  <button role="tab" aria-selected={open} aria-expanded={open} className={`mv-node ${b.state}${open ? ' open' : ''}`} style={{ borderColor: look.border }} onClick={() => setPicked(open ? null : b.key)}>
                    <div className="mv-nn">{b.name}</div>
                    <span className="mv-rag" style={{ background: look.bg, color: look.fg }}>{look.icon}{b.status}</span>
                    <div className="mv-np">{b.total ? `${b.done}/${b.total} steps` : 'No steps'}</div>
                  </button>
                  {i < blocks.length - 1 && <span className="mv-arrow" aria-hidden><ChevronRight size={16} /></span>}
                </Fragment>
              );
            })}
          </div>

          {selected && (
            <div className="mv-steps" role="tabpanel">
              {selected.steps.length === 0 && <p className="mv-none" style={{ padding: '10px 0' }}>No steps.</p>}
              {selected.steps.map((t, i) => {
                const task = flow.byTemplate[t.id];
                const st = selected.states[i];
                const look = STEP[st];
                return (
                  <div key={t.id} className="mv-step">
                    <span className="mv-mark" style={{ background: look.colour }} aria-hidden>{look.mark}</span>
                    <span className="mv-st" style={st === 'done' ? { color: '#64748b', textDecoration: 'line-through' } : undefined}>{task?.detail || t.detail}</span>
                    {task?.assignee && <span className="mv-sm">{task.assignee}</span>}
                    {task?.due && st !== 'done' && <span className="mv-sm">due {whenShort(task.due)}</span>}
                    <span className="mv-sw" style={{ color: look.colour }}>{look.label}</span>
                  </div>
                );
              })}
              {selected.state === 'current' && flow.offFlow.filter((t) => t.status !== 'DONE').map((t) => {
                const st = stepState(t, 'current'); const look = STEP[st];
                return (
                  <div key={t.id} className="mv-step">
                    <span className="mv-mark" style={{ background: look.colour }} aria-hidden>{look.mark}</span>
                    <span className="mv-st">{t.detail}</span>
                    {t.assignee && <span className="mv-sm">{t.assignee}</span>}
                    {t.due && <span className="mv-sm">due {whenShort(t.due)}</span>}
                    <span className="mv-sw" style={{ color: look.colour }}>{look.label}</span>
                  </div>
                );
              })}
            </div>
          )}

          {enrolled && <EngineSection matterId={matterId} />}

          <div className="mv-grid">
            <div>
              <div className="mv-card">
                <h2 className="mv-h">Key details</h2>
                <div className="mv-kv">
                  {FIGURES.map((f) => {
                    const v = m[f.col];
                    const text = v == null || v === '' ? '' : f.kind === 'money' ? money(v) : f.kind === 'date' ? day(String(v)) : String(v);
                    return (
                      <div key={f.col}>
                        <div className="mv-k">{f.label}</div>
                        <div className={`mv-v${text ? '' : ' empty'}`}>{text || '—'}</div>
                      </div>
                    );
                  })}
                  <div><div className="mv-k">Type</div><div className="mv-v">{m.track ? (m.track === 'SALE' ? 'Sale' : 'Purchase') : '—'}</div></div>
                </div>
              </div>
              <div className="mv-card mv-sec">
                <h2 className="mv-h">Outstanding</h2>
                {outstanding.length === 0 ? <p className="mv-none">Nothing outstanding.</p> : (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: '#334155' }}>
                    {outstanding.map((o, i) => <li key={i} style={{ marginBottom: 4 }}>{typeof o === 'string' ? o : o.label || o.item || JSON.stringify(o)}</li>)}
                  </ul>
                )}
                {risks.length > 0 && (
                  <>
                    <h2 className="mv-h" style={{ marginTop: 12 }}>Risks</h2>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: '#b45309' }}>
                      {risks.map((r, i) => <li key={i} style={{ marginBottom: 4 }}>{typeof r === 'string' ? r : r.label || JSON.stringify(r)}</li>)}
                    </ul>
                  </>
                )}
              </div>
              <div className="mv-card mv-sec">
                <h2 className="mv-h">Parties</h2>
                {(detail?.contacts ?? []).length === 0 ? <p className="mv-none">None yet.</p> : (detail!.contacts.slice(0, 12).map((c) => (
                  <div key={c.id} className="mv-row"><span>{c.name || c.email}</span><span className="mv-muted">{String(c.role || '').toLowerCase().replace(/_/g, ' ')}</span></div>
                )))}
              </div>
            </div>
            <div>
              <div className="mv-card">
                <h2 className="mv-h">Emails{emails ? ` · ${emails.length}` : ''}</h2>
                {!emails ? <p className="mv-none">Loading…</p> : emails.length === 0 ? <p className="mv-none">None yet.</p> : emails.slice(0, 10).map((t) => (
                  <div key={t.id} className="mv-row"><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.subject || '(no subject)'}</span><span className="mv-muted">{whenShort(t.lastMessageAt)}</span></div>
                ))}
              </div>
              <div className="mv-card mv-sec">
                <h2 className="mv-h">Files{files ? ` · ${files.files.length}` : ''}</h2>
                {!files ? <p className="mv-none">Loading…</p> : files.files.length === 0 ? <p className="mv-none">{files.folderProvisioned ? 'None yet.' : 'No folder yet.'}</p> : files.files.slice(0, 12).map((f) => (
                  <div key={f.id} className="mv-row">{f.webUrl ? <a href={f.webUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#5A27E0', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</a> : <span>{f.name}</span>}</div>
                ))}
              </div>
              <div className="mv-card mv-sec">
                <h2 className="mv-h">Activity</h2>
                {(detail?.timeline ?? []).length === 0 ? <p className="mv-none">None yet.</p> : detail!.timeline.slice(0, 12).map((e) => (
                  <div key={e.id} className="mv-tl"><time>{whenShort(e.event_at ?? e.created_at)}</time><span>{e.title}</span></div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** What CONVEYi sees, for a matter it is following — the same reading the engine page leads with. */
function EngineSection({ matterId }: { matterId: string }) {
  const eng = useEngine(matterId, api as Api);
  const [model, setModel] = useState<CaseModel | null>(null);
  useEffect(() => {
    api<CaseModel>(`/matters/${matterId}/engine/graph`).then(setModel).catch(() => setModel(null));
  }, [matterId, eng.events.length]);
  if (!model) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <CaseIntelligence m={model} events={eng.events} onDiagnostics={() => { window.location.href = paths.engineMatter(matterId); }} />
    </div>
  );
}
