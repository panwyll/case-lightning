'use client';

import { useEffect, useRef, useState } from 'react';

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
const dstr = (v: any): string => (v ? String(v).slice(0, 10) : '');

/** The matter figures editable straight from the Overview tab. Key = PATCH body field. */
const FIGURE_FIELDS: Array<{ key: string; label: string; type: 'text' | 'date'; col: string }> = [
  { key: 'purchasePrice', label: 'Purchase price', type: 'text', col: 'purchase_price' },
  { key: 'exchangeTargetDate', label: 'Exchange target', type: 'date', col: 'exchange_target_date' },
  { key: 'completionTargetDate', label: 'Completion target', type: 'date', col: 'completion_target_date' },
  { key: 'lender', label: 'Lender', type: 'text', col: 'lender' },
  { key: 'chainPosition', label: 'Chain position', type: 'text', col: 'chain_position' },
  { key: 'counterpartySolicitor', label: 'Counterparty solicitor', type: 'text', col: 'counterparty_solicitor' },
  { key: 'counterpartyAgent', label: 'Counterparty agent', type: 'text', col: 'counterparty_agent' },
];

const panel: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 'min(600px, 100vw)',
  background: '#fff',
  boxShadow: '-12px 0 40px rgba(16,24,40,0.18)',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 60,
  fontFamily: 'var(--font-manrope), ui-sans-serif, system-ui, sans-serif',
  animation: 'cl-drawer-in .18s ease-out',
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
  const [tab, setTab] = useState<'overview' | 'emails' | 'files' | 'todo' | 'activity'>('overview');
  const [detail, setDetail] = useState<any>(null);
  const [files, setFiles] = useState<{ files: any[]; folderProvisioned: boolean } | null>(null);
  const [threads, setThreads] = useState<any[] | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [threadMsgs, setThreadMsgs] = useState<Record<string, any[] | 'loading' | 'error'>>({});
  const [todo, setTodo] = useState<{ tasks: any[]; assignees: any[] } | null>(null);
  const [newTask, setNewTask] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newDue, setNewDue] = useState('');
  const [adding, setAdding] = useState(false);
  // Editable matter figures — baseline in a ref so we only PATCH real changes on blur.
  const [figures, setFigures] = useState<Record<string, string> | null>(null);
  const figBaseline = useRef<Record<string, string>>({});

  // Local copy of the editable fields so drawer edits show instantly (and propagate up).
  const [stage, setStage] = useState<string>(matter.stage || 'INSTRUCTION');
  const [statusFlag, setStatusFlag] = useState<string>(matter.statusFlag || 'ON_TRACK');
  const [assignedTo, setAssignedTo] = useState<string>(matter.assignedTo || '');
  // Whether the matter is on the board (OPEN) or in the Completed pile (CLOSED).
  const [pile, setPile] = useState<string>(matter.status === 'CLOSED' ? 'CLOSED' : 'OPEN');

  useEffect(() => {
    let live = true;
    api(`/matters/${id}`)
      .then((r) => {
        if (!live) return;
        setDetail(r);
        const mm = r?.matter ?? {};
        const init: Record<string, string> = {};
        for (const f of FIGURE_FIELDS) init[f.key] = f.type === 'date' ? dstr(mm[f.col]) : String(mm[f.col] ?? '');
        figBaseline.current = { ...init };
        setFigures(init);
      })
      .catch(() => live && setDetail({ error: true }));
    return () => {
      live = false;
    };
  }, [id, api]);

  // PATCH a figure only when it actually changed (blur/Enter). Goes through the board's
  // patchMatter so the card's date chip stays in step; audit trail is written server-side.
  const saveFigure = (key: string) => {
    if (!figures) return;
    const val = (figures[key] ?? '').trim();
    if (val === figBaseline.current[key]) return;
    figBaseline.current[key] = val;
    onPatch(id, { [key]: val || null });
  };

  // Lazy-load the heavier tabs only when first opened.
  useEffect(() => {
    if (tab === 'files' && !files) api(`/matters/${id}/files`).then(setFiles).catch(() => setFiles({ files: [], folderProvisioned: false }));
    if (tab === 'todo' && !todo) api(`/matters/${id}/tasks`).then(setTodo).catch(() => setTodo({ tasks: [], assignees: [] }));
    if (tab === 'emails' && !threads) api(`/matters/${id}/emails`).then((r) => setThreads(r.threads ?? [])).catch(() => setThreads([]));
  }, [tab, id, api, files, todo, threads]);

  // Expand a thread — messages are read live from Graph (never stored), cached per open.
  function toggleThread(tid: string) {
    if (openThread === tid) {
      setOpenThread(null);
      return;
    }
    setOpenThread(tid);
    if (!threadMsgs[tid]) {
      setThreadMsgs((s) => ({ ...s, [tid]: 'loading' }));
      api(`/matters/${id}/emails/${tid}`)
        .then((r) => setThreadMsgs((s) => ({ ...s, [tid]: r.messages ?? [] })))
        .catch(() => setThreadMsgs((s) => ({ ...s, [tid]: 'error' })));
    }
  }

  const edit = (patch: Record<string, unknown>) => {
    if ('stage' in patch) setStage(patch.stage as string);
    if ('statusFlag' in patch) setStatusFlag(patch.statusFlag as string);
    if ('assignedTo' in patch) setAssignedTo((patch.assignedTo as string) || '');
    if ('status' in patch) setPile(patch.status as string);
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

  const assigneeName = (userId: string): string | null => {
    const a = (todo?.assignees ?? []).find((x: any) => x.id === userId);
    return a ? a.display_name || a.email : null;
  };

  async function addTask() {
    const detailText = newTask.trim();
    if (!detailText) return;
    setAdding(true);
    try {
      const { task } = await api<{ task: any }>(`/matters/${id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          detail: detailText,
          assigneeUserId: newAssignee || null,
          assignee: newAssignee ? assigneeName(newAssignee) : null,
          due: newDue || null,
        }),
      });
      setTodo((s) => (s ? { ...s, tasks: [task, ...s.tasks] } : { tasks: [task], assignees: [] }));
      setNewTask('');
      setNewAssignee('');
      setNewDue('');
    } catch {
      /* leave the text so they can retry */
    } finally {
      setAdding(false);
    }
  }

  // Inline task edit (assignee / due) — optimistic, refetch on failure. The API body is
  // camelCase but rows are snake_case, so mirror assigneeUserId onto assignee_user_id.
  async function patchTask(t: any, patch: Record<string, unknown>) {
    const local: Record<string, unknown> = { ...patch };
    if ('assigneeUserId' in patch) local.assignee_user_id = patch.assigneeUserId;
    setTodo((s) => (s ? { ...s, tasks: s.tasks.map((x) => (x.id === t.id ? { ...x, ...local } : x)) } : s));
    try {
      await api(`/matters/${id}/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    } catch {
      api(`/matters/${id}/tasks`).then(setTodo).catch(() => {});
    }
  }

  const m = detail?.matter ?? {};
  const summary = detail?.summary ?? {};
  const outstanding: any[] = Array.isArray(summary.outstanding_items) ? summary.outstanding_items : [];
  const risks: any[] = Array.isArray(summary.risks) ? summary.risks : [];
  const contacts: any[] = detail?.contacts ?? [];
  const timeline: any[] = detail?.timeline ?? [];

  const factInput: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    fontSize: 13,
    fontWeight: 600,
    color: '#0f172a',
    padding: '4px 6px',
    border: '1px solid transparent',
    borderRadius: 6,
    background: 'transparent',
  };

  return (
    <>
      <style>{`@keyframes cl-drawer-in{from{transform:translateX(28px);opacity:.5}to{transform:none;opacity:1}}`}</style>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.32)', backdropFilter: 'blur(2px)', zIndex: 59 }} />
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
            <button
              onClick={() => edit({ status: pile === 'CLOSED' ? 'OPEN' : 'CLOSED' })}
              style={{
                ...miniSelect,
                fontWeight: 700,
                color: pile === 'CLOSED' ? '#334155' : '#16a34a',
                borderColor: pile === 'CLOSED' ? '#e2e8f0' : '#bbf7d0',
                background: pile === 'CLOSED' ? '#fff' : '#f0fdf4',
              }}
              title={pile === 'CLOSED' ? 'Put this matter back on the board' : 'Move this matter to the Completed pile'}
            >
              {pile === 'CLOSED' ? 'Reopen' : '✓ Mark completed'}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 2, padding: '0 12px', borderBottom: '1px solid #eef1f5' }}>
          <button style={tabBtn(tab === 'overview')} onClick={() => setTab('overview')}>Overview</button>
          <button style={tabBtn(tab === 'emails')} onClick={() => setTab('emails')}>Emails{threads ? ` (${threads.length})` : ''}</button>
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
              <div style={sectionLabel}>Key details <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— click a value to edit</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                {FIGURE_FIELDS.map((f) => (
                  <div key={f.key}>
                    <div style={{ fontSize: 11, color: '#94a3b8', padding: '0 6px' }}>{f.label}</div>
                    <input
                      type={f.type}
                      value={figures?.[f.key] ?? ''}
                      placeholder="—"
                      onChange={(e) => setFigures((s) => (s ? { ...s, [f.key]: e.target.value } : s))}
                      onBlur={() => saveFigure(f.key)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      style={factInput}
                      onFocus={(e) => (e.target.style.border = '1px solid #c4b5fd')}
                      onBlurCapture={(e) => (e.target.style.border = '1px solid transparent')}
                    />
                  </div>
                ))}
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', padding: '0 6px' }}>Track</div>
                  <div style={{ ...factInput, color: m.track ? '#0f172a' : '#cbd5e1' }}>{m.track || '—'}</div>
                </div>
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

          {tab === 'emails' && (
            <>
              <div style={sectionLabel}>Correspondence — read live from the mailbox, never copied out</div>
              {!threads && <p style={{ color: '#94a3b8', fontSize: 13 }}>Loading threads…</p>}
              {threads && threads.length === 0 && <p style={{ fontSize: 13, color: '#cbd5e1' }}>No email threads linked to this matter yet.</p>}
              {threads?.map((t) => {
                const parts = Array.isArray(t.participants) ? t.participants : [];
                const open = openThread === t.id;
                const msgs = threadMsgs[t.id];
                return (
                  <div key={t.id} style={{ borderTop: '1px solid #f4f6f9' }}>
                    <div onClick={() => toggleThread(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', cursor: 'pointer' }}>
                      <span style={{ fontSize: 11, color: '#94a3b8', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s', flexShrink: 0 }}>▶</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.subject || '(no subject)'}</div>
                        {parts.length > 0 && (
                          <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {parts.slice(0, 3).map((p: any) => p?.name || p?.address || p).filter(Boolean).join(', ')}{parts.length > 3 ? ` +${parts.length - 3}` : ''}
                          </div>
                        )}
                      </div>
                      {t.chaseAwaitingSince && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#b45309', background: '#fef3c7', borderRadius: 999, padding: '1px 7px', flexShrink: 0 }}>awaiting reply</span>}
                      {t.lastMessageAt && <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtDate(t.lastMessageAt)}</span>}
                    </div>
                    {open && (
                      <div style={{ padding: '0 0 10px 19px' }}>
                        {msgs === 'loading' && <p style={{ color: '#94a3b8', fontSize: 13, margin: '4px 0' }}>Fetching from the mailbox…</p>}
                        {msgs === 'error' && <p style={{ color: '#b45309', fontSize: 12.5, margin: '4px 0' }}>Couldn’t read this thread — it may live in a colleague’s mailbox.</p>}
                        {Array.isArray(msgs) && msgs.length === 0 && <p style={{ color: '#94a3b8', fontSize: 12.5, margin: '4px 0' }}>No messages found in the connected mailbox for this thread.</p>}
                        {Array.isArray(msgs) &&
                          msgs.map((m: any) => (
                            <div key={m.id} style={{ border: '1px solid #eef1f5', borderRadius: 8, padding: '8px 10px', marginBottom: 6, background: '#fafbfc' }}>
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                <strong style={{ fontSize: 12.5, color: '#0f172a', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.fromAddress || undefined}>{m.from}</strong>
                                {m.hasAttachments && <span title="Has attachments" style={{ fontSize: 11 }}>📎</span>}
                                <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>{m.sentAt ? new Date(m.sentAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span>
                              </div>
                              {m.to?.length > 0 && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>to {m.to.slice(0, 3).join(', ')}{m.to.length > 3 ? ` +${m.to.length - 3}` : ''}</div>}
                              <div style={{ fontSize: 12.5, color: '#334155', marginTop: 6, whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto', lineHeight: 1.5 }}>{m.bodyText || '(empty)'}</div>
                              {m.webLink && (
                                <a href={m.webLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: '#1d4ed8', textDecoration: 'none', display: 'inline-block', marginTop: 6 }}>Open in Outlook ↗</a>
                              )}
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                );
              })}
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
              {/* Add an action — with owner + due date, Jira-style. */}
              <div style={{ marginTop: 14, padding: 10, background: '#f8fafc', border: '1px solid #eef1f5', borderRadius: 10 }}>
                <input
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTask()}
                  placeholder="Add an action…"
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: 8 }}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <select value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)} style={{ ...miniSelect, flex: 1, minWidth: 0 }} title="Assign to">
                    <option value="">Unassigned</option>
                    {(todo?.assignees ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.display_name || a.email}</option>)}
                  </select>
                  <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} style={{ ...miniSelect, flex: 1, minWidth: 0 }} title="Due date" />
                  <button onClick={addTask} disabled={adding || !newTask.trim()} style={{ ...miniSelect, background: '#5A27E0', color: '#fff', border: 'none', fontWeight: 700, padding: '4px 16px', opacity: adding || !newTask.trim() ? 0.5 : 1 }}>Add</button>
                </div>
              </div>
              {!todo && <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 14 }}>Loading…</p>}
              {todo && todo.tasks.length === 0 && <p style={{ fontSize: 13, color: '#cbd5e1', marginTop: 14 }}>No tasks yet. Add the first action above.</p>}
              <div style={{ marginTop: 10 }}>
                {todo?.tasks.map((t) => {
                  const done = TASK_DONE.has(t.status);
                  const dueVal = dstr(t.due);
                  const overdue = !done && dueVal && new Date(dueVal).getTime() < Date.now() - 86_400_000;
                  return (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 0', borderTop: '1px solid #f4f6f9' }}>
                      <input type="checkbox" checked={done} onChange={() => toggleTask(t)} style={{ marginTop: 3, cursor: 'pointer', accentColor: '#5A27E0' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: done ? '#94a3b8' : '#0f172a', textDecoration: done ? 'line-through' : 'none' }}>{t.detail}</div>
                        <div style={{ display: 'flex', gap: 5, marginTop: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select
                            value={t.assignee_user_id || ''}
                            onChange={(e) => patchTask(t, { assigneeUserId: e.target.value || null, assignee: e.target.value ? assigneeName(e.target.value) : null })}
                            style={{ ...miniSelect, fontSize: 11, padding: '2px 4px', color: t.assignee_user_id || t.assignee ? '#334155' : '#94a3b8' }}
                            title="Assign to"
                          >
                            <option value="">{!t.assignee_user_id && t.assignee ? t.assignee : 'Unassigned'}</option>
                            {(todo?.assignees ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.display_name || a.email}</option>)}
                          </select>
                          <input
                            type="date"
                            value={dueVal}
                            onChange={(e) => patchTask(t, { due: e.target.value || null })}
                            style={{ ...miniSelect, fontSize: 11, padding: '2px 4px', color: overdue ? '#b91c1c' : '#334155', borderColor: overdue ? '#fecaca' : '#e2e8f0' }}
                            title="Due date"
                          />
                          {t.status === 'IN_PROGRESS' && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#5A27E0', background: '#f3efff', borderRadius: 999, padding: '1px 7px' }}>in progress</span>}
                          {overdue && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#b91c1c' }}>overdue</span>}
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
