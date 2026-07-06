'use client';

import { useEffect, useState } from 'react';

/**
 * Slide-over matter detail for the board — click a card to open it. Reuses the existing
 * matter endpoints: GET /matters/[id] (facts, outstanding, risks, timeline, parties),
 * /files (the OneDrive filestore) and /tasks (the to-do list, mirrored to Tracker.xlsx).
 * Stage / status / owner stay editable here via the same onPatch the board uses, so an
 * edit in the drawer updates the card underneath.
 */

type Api = <T = any>(path: string, options?: RequestInit) => Promise<T>;

const FLAG_DOT: Record<string, string> = { ON_TRACK: '#22c55e', NEEDS_ATTENTION: '#f59e0b', BLOCKED: '#ef4444' };
const STAGE_LABEL: Record<string, string> = {
  INSTRUCTION: 'Instruction',
  CONTRACT_PACK: 'Contract pack',
  SEARCHES_ENQUIRIES: 'Searches & enquiries',
  REVIEW_SIGNING: 'Review & signing',
  EXCHANGE: 'Exchange',
  COMPLETION: 'Completion',
  POST_COMPLETION: 'Post-completion',
};
const STAGES = Object.keys(STAGE_LABEL);
const TASK_DONE = new Set(['DONE']);

const fmtDate = (v: any): string =>
  v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

const panel: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 'min(520px, 100vw)',
  background: '#fff',
  boxShadow: '-8px 0 32px rgba(16,24,40,0.16)',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 60,
};
const miniSelect: React.CSSProperties = {
  fontSize: 12,
  padding: '3px 6px',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  background: '#fff',
  color: '#334155',
  cursor: 'pointer',
};
const tabBtn = (on: boolean): React.CSSProperties => ({
  padding: '8px 12px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  borderBottom: on ? '2px solid #5A27E0' : '2px solid transparent',
  color: on ? '#5A27E0' : '#64748b',
});
const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: '#94a3b8',
  margin: '16px 0 8px',
};

export default function MatterDrawer({
  matter,
  api,
  users,
  onPatch,
  onClose,
}: {
  matter: any;
  api: Api;
  users: any[];
  onPatch: (id: string, patch: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const id = matter.id as string;
  const [tab, setTab] = useState<'overview' | 'files' | 'todo' | 'activity'>('overview');
  const [detail, setDetail] = useState<any>(null);
  const [files, setFiles] = useState<{ files: any[]; folderProvisioned: boolean } | null>(null);
  const [todo, setTodo] = useState<{ tasks: any[]; assignees: any[] } | null>(null);
  const [newTask, setNewTask] = useState('');
  const [adding, setAdding] = useState(false);

  // Local copy of the editable fields so drawer edits show instantly (and propagate up).
  const [stage, setStage] = useState<string>(matter.stage || 'INSTRUCTION');
  const [statusFlag, setStatusFlag] = useState<string>(matter.statusFlag || 'ON_TRACK');
  const [assignedTo, setAssignedTo] = useState<string>(matter.assignedTo || '');

  useEffect(() => {
    let live = true;
    api(`/matters/${id}`).then((r) => live && setDetail(r)).catch(() => live && setDetail({ error: true }));
    return () => {
      live = false;
    };
  }, [id, api]);

  // Lazy-load the heavier tabs only when first opened.
  useEffect(() => {
    if (tab === 'files' && !files) api(`/matters/${id}/files`).then(setFiles).catch(() => setFiles({ files: [], folderProvisioned: false }));
    if (tab === 'todo' && !todo) api(`/matters/${id}/tasks`).then(setTodo).catch(() => setTodo({ tasks: [], assignees: [] }));
  }, [tab, id, api, files, todo]);

  const edit = (patch: Record<string, unknown>) => {
    if ('stage' in patch) setStage(patch.stage as string);
    if ('statusFlag' in patch) setStatusFlag(patch.statusFlag as string);
    if ('assignedTo' in patch) setAssignedTo((patch.assignedTo as string) || '');
    onPatch(id, patch);
  };

  async function toggleTask(t: any) {
    const status = TASK_DONE.has(t.status) ? 'OPEN' : 'DONE';
    setTodo((s) => (s ? { ...s, tasks: s.tasks.map((x) => (x.id === t.id ? { ...x, status } : x)) } : s));
    try {
      await api(`/matters/${id}/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    } catch {
      api(`/matters/${id}/tasks`).then(setTodo).catch(() => {});
    }
  }

  async function addTask() {
    const detailText = newTask.trim();
    if (!detailText) return;
    setAdding(true);
    try {
      const { task } = await api<{ task: any }>(`/matters/${id}/tasks`, { method: 'POST', body: JSON.stringify({ detail: detailText }) });
      setTodo((s) => (s ? { ...s, tasks: [task, ...s.tasks] } : { tasks: [task], assignees: [] }));
      setNewTask('');
    } catch {
      /* leave the text so they can retry */
    } finally {
      setAdding(false);
    }
  }

  const m = detail?.matter ?? {};
  const summary = detail?.summary ?? {};
  const outstanding: any[] = Array.isArray(summary.outstanding_items) ? summary.outstanding_items : [];
  const risks: any[] = Array.isArray(summary.risks) ? summary.risks : [];
  const contacts: any[] = detail?.contacts ?? [];
  const timeline: any[] = detail?.timeline ?? [];

  const facts: Array<[string, any]> = [
    ['Purchase price', m.purchase_price],
    ['Exchange target', m.exchange_target_date ? fmtDate(m.exchange_target_date) : null],
    ['Completion target', m.completion_target_date ? fmtDate(m.completion_target_date) : null],
    ['Lender', m.lender],
    ['Chain position', m.chain_position],
    ['Counterparty solicitor', m.counterparty_solicitor],
    ['Counterparty agent', m.counterparty_agent],
    ['Track', m.track],
  ];

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', zIndex: 59 }} />
      <aside style={panel}>
        {/* Header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #eef1f5' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: 999, background: FLAG_DOT[statusFlag] ?? '#cbd5e1', flexShrink: 0 }} />
                <strong style={{ fontSize: 17, color: '#0f172a' }}>{matter.matterRef || 'Matter'}</strong>
              </div>
              {matter.propertyAddress && <div style={{ fontSize: 13, color: '#475569', marginTop: 3 }}>{matter.propertyAddress}</div>}
            </div>
            <button onClick={onClose} title="Close" style={{ ...miniSelect, border: '1px solid #e2e8f0', fontSize: 15, lineHeight: 1, padding: '3px 8px' }}>✕</button>
          </div>
          {/* Editable stage / status / owner — same writes as the board */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
            <select value={stage} onChange={(e) => edit({ stage: e.target.value })} style={miniSelect} title="Stage">
              {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
            </select>
            <select value={statusFlag} onChange={(e) => edit({ statusFlag: e.target.value })} style={miniSelect} title="Status">
              <option value="ON_TRACK">On track</option>
              <option value="NEEDS_ATTENTION">Attention</option>
              <option value="BLOCKED">Blocked</option>
            </select>
            <select value={assignedTo} onChange={(e) => edit({ assignedTo: e.target.value || null })} style={miniSelect} title="Owner">
              <option value="">Unassigned</option>
              {users.map((u: any) => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
            </select>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 2, padding: '0 12px', borderBottom: '1px solid #eef1f5' }}>
          <button style={tabBtn(tab === 'overview')} onClick={() => setTab('overview')}>Overview</button>
          <button style={tabBtn(tab === 'files')} onClick={() => setTab('files')}>Files</button>
          <button style={tabBtn(tab === 'todo')} onClick={() => setTab('todo')}>To-do{todo ? ` (${todo.tasks.filter((t) => !TASK_DONE.has(t.status)).length})` : ''}</button>
          <button style={tabBtn(tab === 'activity')} onClick={() => setTab('activity')}>Activity</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 24px' }}>
          {!detail && <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 20 }}>Loading…</p>}
          {detail?.error && <p style={{ color: '#ef4444', fontSize: 13, marginTop: 20 }}>Couldn’t load this matter.</p>}

          {detail && !detail.error && tab === 'overview' && (
            <>
              <div style={sectionLabel}>Key details</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
                {facts.map(([label, val]) => (
                  <div key={label}>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>{label}</div>
                    <div style={{ fontSize: 13, color: val ? '#0f172a' : '#cbd5e1', fontWeight: val ? 600 : 400 }}>{val || '—'}</div>
                  </div>
                ))}
              </div>

              <div style={sectionLabel}>Outstanding</div>
              {outstanding.length === 0 ? (
                <p style={{ fontSize: 13, color: '#cbd5e1', margin: 0 }}>Nothing outstanding recorded.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {outstanding.map((o, i) => (
                    <li key={i} style={{ fontSize: 13, color: '#334155', marginBottom: 4 }}>{typeof o === 'string' ? o : o.label || o.item || JSON.stringify(o)}</li>
                  ))}
                </ul>
              )}

              {risks.length > 0 && (
                <>
                  <div style={sectionLabel}>Risks</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {risks.map((r, i) => (
                      <li key={i} style={{ fontSize: 13, color: '#b45309', marginBottom: 4 }}>{typeof r === 'string' ? r : r.label || JSON.stringify(r)}</li>
                    ))}
                  </ul>
                </>
              )}

              <div style={sectionLabel}>Parties</div>
              {contacts.length === 0 ? (
                <p style={{ fontSize: 13, color: '#cbd5e1', margin: 0 }}>No contacts harvested yet.</p>
              ) : (
                contacts.slice(0, 12).map((c) => (
                  <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderTop: '1px solid #f4f6f9', fontSize: 13 }}>
                    <span style={{ color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || c.email}</span>
                    <span style={{ color: '#94a3b8', flexShrink: 0 }}>{String(c.role || '').toLowerCase().replace(/_/g, ' ')}</span>
                  </div>
                ))
              )}
            </>
          )}

          {tab === 'files' && (
            <>
              <div style={sectionLabel}>OneDrive filestore</div>
              {!files && <p style={{ color: '#94a3b8', fontSize: 13 }}>Loading files…</p>}
              {files && !files.folderProvisioned && <p style={{ fontSize: 13, color: '#94a3b8' }}>No OneDrive folder provisioned for this matter yet.</p>}
              {files && files.folderProvisioned && files.files.length === 0 && <p style={{ fontSize: 13, color: '#cbd5e1' }}>Folder is empty.</p>}
              {files?.files.map((f) => (
                <a
                  key={f.id}
                  href={f.webUrl || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '1px solid #f4f6f9', textDecoration: 'none' }}
                >
                  <span style={{ fontSize: 15 }}>📄</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#1d4ed8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  {f.processed && <span style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', background: '#dcfce7', borderRadius: 999, padding: '1px 7px' }}>read</span>}
                </a>
              ))}
            </>
          )}

          {tab === 'todo' && (
            <>
              <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
                <input
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTask()}
                  placeholder="Add an action…"
                  style={{ flex: 1, fontSize: 13, padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: 8 }}
                />
                <button onClick={addTask} disabled={adding || !newTask.trim()} style={{ ...miniSelect, background: '#5A27E0', color: '#fff', border: 'none', fontWeight: 700, padding: '0 14px', opacity: adding || !newTask.trim() ? 0.5 : 1 }}>Add</button>
              </div>
              {!todo && <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 14 }}>Loading…</p>}
              {todo && todo.tasks.length === 0 && <p style={{ fontSize: 13, color: '#cbd5e1', marginTop: 14 }}>No tasks yet. Add the first action above.</p>}
              <div style={{ marginTop: 10 }}>
                {todo?.tasks.map((t) => {
                  const done = TASK_DONE.has(t.status);
                  return (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '8px 0', borderTop: '1px solid #f4f6f9' }}>
                      <input type="checkbox" checked={done} onChange={() => toggleTask(t)} style={{ marginTop: 2, cursor: 'pointer', accentColor: '#5A27E0' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: done ? '#94a3b8' : '#0f172a', textDecoration: done ? 'line-through' : 'none' }}>{t.detail}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                          {t.assignee ? `${t.assignee}` : 'Unassigned'}{t.due ? ` · due ${fmtDate(t.due)}` : ''}{t.status === 'IN_PROGRESS' ? ' · in progress' : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {tab === 'activity' && (
            <>
              <div style={sectionLabel}>Timeline</div>
              {timeline.length === 0 ? (
                <p style={{ fontSize: 13, color: '#cbd5e1' }}>No activity recorded.</p>
              ) : (
                timeline.map((e) => (
                  <div key={e.id} style={{ display: 'flex', gap: 10, padding: '9px 0', borderTop: '1px solid #f4f6f9' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: '#c4b5fd', marginTop: 5, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: '#0f172a' }}>{e.title || String(e.event_type || '').toLowerCase().replace(/_/g, ' ')}</div>
                      {e.details && <div style={{ fontSize: 12, color: '#64748b', marginTop: 1 }}>{e.details}</div>}
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{fmtDate(e.event_at || e.created_at)}</div>
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
