'use client';
import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react';

// ── Self-contained API helper (mirrors the admin page's) ──────────────────────
async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('cl_token') : null;
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // Surface which field a 400 rejected, so "Invalid request." is actually diagnosable.
    const detail = Array.isArray(json.details) ? json.details.map((d: any) => `${(d.path || []).join('.')}: ${d.message}`).join('; ') : '';
    throw new Error([json.error || `HTTP ${res.status}`, detail].filter(Boolean).join(' — '));
  }
  return json as T;
}

const STAGE_COLORS = ['#6366f1', '#8b5cf6', '#0ea5e9', '#14b8a6', '#f59e0b', '#16a34a', '#64748b', '#ec4899', '#0891b2', '#a855f7'];
const ROLES = ['OWNER', 'CONVEYANCER', 'ASSISTANT', 'ADMIN'];
interface Stage { id: string; key: string; name: string; sort_order: number; active: boolean }

interface Template {
  id: string;
  stage: string;
  detail: string;
  type: string;
  node_kind?: 'TASK' | 'EMAIL';
  email_template_id?: string | null;
  send_mode?: 'DRAFT' | 'SEND' | null;
  assignee_kind: 'ROLE' | 'USER';
  assignee_role: string | null;
  assignee_user_id: string | null;
  due_offset_days: number | null;
  pos_x: number;
  pos_y: number;
  sort_order: number;
  active: boolean;
}
interface Edge { from_template_id: string; to_template_id: string; }
interface Member { id: string; name: string; role: string }

// Flow-chart CSS. Connectors are drawn with pseudo-elements, so they live here rather
// than in inline styles. The stage flow runs top→down (the beats); expanding a stage
// reveals its tasks as a sub-flow that forks where a task has several dependents.
const WF_CSS = `
.wf-flow{display:flex;flex-direction:column;align-items:center}
.wf-stage{width:360px;background:#fff;border:1px solid #e6e8ee;border-left-width:4px;border-radius:12px;box-shadow:0 1px 3px rgba(16,24,40,.08);overflow:hidden}
.wf-stage.open{width:660px;max-width:100%}
.wf-hd{display:flex;align-items:center;gap:10px;padding:11px 13px;cursor:pointer}
.wf-dot{width:11px;height:11px;border-radius:3px;flex:none}
.wf-name{font-size:14.5px;font-weight:700;color:#0f172a;flex:1;min-width:0;border:1px solid transparent;border-radius:6px;background:transparent;padding:2px 4px;font-family:inherit}
.wf-name:focus{outline:none;border-color:#d0d5dd;background:#fff}
.wf-count{font-size:12px;color:#94a3b8;white-space:nowrap}
.wf-chev{color:#94a3b8;font-size:12px;flex:none;width:12px;text-align:center}
.wf-chev.open{transform:rotate(90deg)}
.wf-ctrls{display:flex;gap:1px;opacity:0;transition:opacity .1s}
.wf-stage:hover .wf-ctrls{opacity:1}
.wf-ic{border:none;background:none;color:#94a3b8;cursor:pointer;font-size:13px;line-height:1;padding:2px 5px;border-radius:5px}
.wf-ic:disabled{opacity:.3;cursor:default}
.wf-conn{width:2px;height:26px;background:#c3cbd6;position:relative}
.wf-conn::after{content:'';position:absolute;bottom:-1px;left:50%;transform:translateX(-50%);border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid #c3cbd6}
.wf-body{border-top:1px solid #eef2f7;background:#fafbfc;padding:18px 16px;overflow-x:auto}
.wf-subflow{display:flex;flex-direction:column;align-items:center;min-width:min-content}
.wf-level{display:flex;gap:20px;justify-content:center;align-items:stretch;flex-wrap:wrap}
.wf-task{width:250px;background:#fff;border:1px solid #dfe3ea;border-radius:9px;box-shadow:0 1px 2px rgba(16,24,40,.06);padding:8px 11px;cursor:grab;text-align:left}
.wf-task:active{cursor:grabbing}
.wf-task.sel{border-color:#5A27E0;background:#EDE7FB}
.wf-task.dragging{opacity:.4}
.wf-task.drop{border-color:#5A27E0;box-shadow:0 0 0 2px #c4b5fd}
.wf-t{font-size:12.5px;font-weight:600;color:#1e293b;line-height:1.3;word-break:break-word}
.wf-m{font-size:10.5px;color:#94a3b8;margin-top:3px}
.wf-lvlconn{width:2px;height:20px;background:#c3cbd6;position:relative;margin:2px 0}
.wf-lvlconn::after{content:'';position:absolute;bottom:-1px;left:50%;transform:translateX(-50%);border-left:4px solid transparent;border-right:4px solid transparent;border-top:6px solid #c3cbd6}
.wf-addbar{margin-top:16px;display:flex;gap:6px;justify-content:center}
.wf-add{font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:7px;border:1px solid #d0d5dd;background:#fff;color:#475569;cursor:pointer}
`;

export default function WorkflowCanvas() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [users, setUsers] = useState<Member[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<Array<{ id: string; name: string; subject_template: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [dragId, setDragId] = useState<string | null>(null);   // task being dragged (visual)
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragFrom = useRef<{ id: string; x: number; y: number } | null>(null); // mousedown origin
  const didDrag = useRef(false); // set on a real drag, so the trailing click doesn't also select

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ templates: Template[]; edges: Edge[]; users: Member[]; emailTemplates: any[] }>('/admin/workflow');
      setTemplates(r.templates ?? []);
      setEdges(r.edges ?? []);
      setUsers(r.users ?? []);
      setEmailTemplates(r.emailTemplates ?? []);
      try { setStages((await api<{ stages: Stage[] }>('/admin/stages')).stages ?? []); } catch { /* stages optional */ }
      setErr(null);
    } catch (e: any) {
      setErr(e?.message || 'Could not load the workflow. Has migration 039 been run?');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const tasksByStage = useMemo(() => {
    const m: Record<string, Template[]> = {};
    for (const t of templates) (m[t.stage] ??= []).push(t);
    for (const k of Object.keys(m)) m[k].sort((a, b) => (a.pos_y - b.pos_y) || (a.sort_order - b.sort_order));
    return m;
  }, [templates]);

  // Group a stage's tasks into dependency levels (longest-path rank). Tasks at the same
  // level have no ordering between them → they run IN PARALLEL (one row); each level runs
  // after the one above. This renders forks and merges correctly (a task that runs after
  // two parallel tasks just lands on the next level below both).
  const stageLevels = (key: string): Template[][] => {
    const list = tasksByStage[key] ?? [];
    const inStage = new Set(list.map((t) => t.id));
    const prereqs: Record<string, string[]> = {};
    for (const e of edges) if (inStage.has(e.from_template_id) && inStage.has(e.to_template_id)) (prereqs[e.to_template_id] ??= []).push(e.from_template_id);
    const memo: Record<string, number> = {};
    const calc = (id: string, stack: Set<string>): number => {
      if (memo[id] != null) return memo[id];
      let lv = 0;
      for (const p of prereqs[id] ?? []) if (!stack.has(p)) lv = Math.max(lv, calc(p, new Set([...stack, id])) + 1);
      return (memo[id] = lv);
    };
    const maxLv = list.reduce((m, t) => Math.max(m, calc(t.id, new Set())), 0);
    const levels: Template[][] = Array.from({ length: maxLv + 1 }, () => []);
    for (const t of list) levels[memo[t.id]].push(t);
    return levels;
  };

  const byId = (id: string) => templates.find((t) => t.id === id) || null;
  const sel = selected ? byId(selected) : null;

  // ── Mutations ───────────────────────────────────────────────────────────────
  const addTask = async (stageKey: string, nodeKind: 'TASK' | 'EMAIL' = 'TASK') => {
    const posY = (tasksByStage[stageKey]?.length ?? 0) * 10;
    try {
      const body: any = { stage: stageKey, assigneeKind: 'ROLE', assigneeRole: 'OWNER', posX: 0, posY };
      if (nodeKind === 'EMAIL') { body.detail = 'Send email'; body.nodeKind = 'EMAIL'; body.sendMode = 'DRAFT'; body.emailTemplateId = emailTemplates[0]?.id ?? null; }
      else body.detail = 'New task';
      const r = await api<{ template: Template }>('/admin/workflow', { method: 'POST', body: JSON.stringify(body) });
      setTemplates((ts) => [...ts, r.template]);
      setOpen((o) => ({ ...o, [stageKey]: true }));
      setSelected(r.template.id);
    } catch (e: any) { setErr(e?.message || 'Could not add.'); }
  };
  const saveNode = async (t: Template) => {
    try {
      const r = await api<{ template: Template }>('/admin/workflow', {
        method: 'POST',
        body: JSON.stringify({
          id: t.id, stage: t.stage, detail: t.detail, assigneeKind: t.assignee_kind,
          assigneeRole: t.assignee_role, assigneeUserId: t.assignee_user_id, dueOffsetDays: t.due_offset_days,
          nodeKind: t.node_kind ?? 'TASK', emailTemplateId: t.email_template_id ?? null, sendMode: t.send_mode ?? null,
          posX: Math.round(t.pos_x), posY: Math.round(t.pos_y), active: t.active,
        }),
      });
      setTemplates((ts) => ts.map((x) => (x.id === t.id ? r.template : x)));
    } catch (e: any) { setErr(e?.message || 'Could not save.'); }
  };
  const deleteNode = async (id: string) => {
    if (!window.confirm('Delete this task and its dependencies?')) return;
    try {
      await api(`/admin/workflow?id=${id}`, { method: 'DELETE' });
      setTemplates((ts) => ts.filter((t) => t.id !== id));
      setEdges((es) => es.filter((e) => e.from_template_id !== id && e.to_template_id !== id));
      setSelected(null);
    } catch (e: any) { setErr(e?.message || 'Could not delete.'); }
  };
  const addPrereq = async (from: string, to: string) => {
    try { await api('/admin/workflow/edges', { method: 'POST', body: JSON.stringify({ from, to }) }); await load(); }
    catch (e: any) { setErr(e?.message || 'Could not add prerequisite (would it create a loop?).'); }
  };
  const deleteEdge = async (from: string, to: string) => {
    setEdges((es) => es.filter((e) => !(e.from_template_id === from && e.to_template_id === to)));
    await api(`/admin/workflow/edges?from=${from}&to=${to}`, { method: 'DELETE' }).catch(() => {});
  };

  // ── Stage CRUD (the beats) ──────────────────────────────────────────────────
  const stageColor = (key: string) => { const i = stages.findIndex((s) => s.key === key); return STAGE_COLORS[(i < 0 ? 0 : i) % STAGE_COLORS.length]; };
  const addStage = async () => { try { await api('/admin/stages', { method: 'POST', body: JSON.stringify({ name: 'New stage', sortOrder: stages.length }) }); await load(); } catch (e: any) { setErr(e?.message || 'Could not add stage.'); } };
  const saveStageName = async (s: Stage) => { try { await api('/admin/stages', { method: 'POST', body: JSON.stringify({ id: s.id, name: s.name, sortOrder: s.sort_order, active: s.active }) }); } catch (e: any) { setErr(e?.message || 'Could not save stage.'); } };
  const removeStage = async (id: string) => { if (!window.confirm('Delete this stage? (Kept but hidden if matters are on it.)')) return; await api(`/admin/stages?id=${id}`, { method: 'DELETE' }).catch(() => {}); await load(); };
  const moveStage = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir; if (j < 0 || j >= stages.length) return;
    const reordered = [...stages]; [reordered[idx], reordered[j]] = [reordered[j], reordered[idx]];
    setStages(reordered);
    await api('/admin/stages', { method: 'POST', body: JSON.stringify({ order: reordered.map((s, i) => ({ id: s.id, sortOrder: i })) }) }).catch(() => {});
  };

  const assigneeText = (t: Template) =>
    t.assignee_kind === 'USER' ? users.find((u) => u.id === t.assignee_user_id)?.name ?? 'a person'
      : t.assignee_role === 'OWNER' ? 'Matter owner' : (t.assignee_role ?? '').charAt(0) + (t.assignee_role ?? '').slice(1).toLowerCase();

  const allOpen = stages.length > 0 && stages.every((s) => open[s.key]);
  const toggleAll = () => setOpen(allOpen ? {} : Object.fromEntries(stages.map((s) => [s.key, true])));

  // ── Sub-flow render (a task box, then a fork/chain to its dependents) ─────────
  // Drag one task onto another (same stage) to make the dragged task run AFTER the
  // one it's dropped on. Leaving tasks unconnected = they run in parallel. Mouse-based
  // (not HTML5 DnD) so it's reliable and the drop target is tracked by hover.
  const taskBox = (t: Template) => (
    <div
      data-taskid={t.id}
      className={`wf-task${t.id === selected ? ' sel' : ''}${dropTarget === t.id ? ' drop' : ''}${dragId === t.id ? ' dragging' : ''}`}
      onMouseDown={(e) => { e.stopPropagation(); dragFrom.current = { id: t.id, x: e.clientX, y: e.clientY }; didDrag.current = false; }}
      onMouseEnter={() => { if (dragId && dragId !== t.id && byId(dragId)?.stage === t.stage) setDropTarget(t.id); }}
      onMouseLeave={() => setDropTarget((d) => (d === t.id ? null : d))}
      onClick={(e) => { e.stopPropagation(); if (didDrag.current) { didDrag.current = false; return; } setSelected(t.id === selected ? null : t.id); }}
      style={{ opacity: t.active ? 1 : 0.5 }}
      title="Drag onto another task to make this run after it"
    >
      <div className="wf-t">{t.node_kind === 'EMAIL' && <span style={{ fontSize: 9, fontWeight: 800, color: '#0ea5e9', marginRight: 5 }}>✉</span>}{t.detail}</div>
      <div className="wf-m">
        {t.node_kind === 'EMAIL'
          ? `${emailTemplates.find((e) => e.id === t.email_template_id)?.name ?? 'no template'} · ${t.send_mode === 'SEND' ? '⚡ auto-send' : '✎ draft'}`
          : `→ ${assigneeText(t)}${t.due_offset_days != null ? ` · +${t.due_offset_days}d` : ''}`}
      </div>
    </div>
  );
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <style>{WF_CSS}</style>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15, color: '#0f172a', flex: 1 }}>Workflow</strong>
          {stages.length > 0 && <button onClick={toggleAll} style={btn}>{allOpen ? 'Collapse all' : 'Expand all'}</button>}
          <button onClick={addStage} style={btn}>+ Add stage</button>
        </div>

        {err && <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca' }}>{err}</div>}
        {loading && <div style={{ ...card, color: '#94a3b8', fontSize: 13 }}>Loading…</div>}

        {!loading && stages.length === 0 && templates.length === 0 && (
          <div style={{ ...card }}>
            <div style={{ marginBottom: 10, color: '#64748b', fontSize: 13 }}>No workflow yet.</div>
            <button onClick={async () => { try { await api('/admin/workflow/seed', { method: 'POST' }); await load(); } catch (e: any) { setErr(e?.message || 'Could not load defaults.'); } }}
              style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>
              Load the standard conveyancing flow
            </button>
          </div>
        )}

        {!loading && stages.length > 0 && (
          <div style={{ ...card, padding: '28px 12px' }}>
            <div
              className="wf-flow"
              onMouseMove={(e) => { const f = dragFrom.current; if (f && !dragId && Math.hypot(e.clientX - f.x, e.clientY - f.y) > 5) setDragId(f.id); }}
              onMouseUp={(e) => {
                const from = dragFrom.current?.id;
                dragFrom.current = null; setDragId(null); setDropTarget(null);
                if (!from) return;
                // Read the drop target synchronously from the DOM (state updates land too late for a fast drag).
                const box = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-taskid]');
                const to = box?.getAttribute('data-taskid');
                if (to && to !== from && byId(from)?.stage === byId(to)?.stage) { didDrag.current = true; void addPrereq(to, from); }
              }}
              onMouseLeave={() => { dragFrom.current = null; setDragId(null); setDropTarget(null); }}
            >
              {stages.map((s, i) => {
                const list = tasksByStage[s.key] ?? [];
                const levels = stageLevels(s.key);
                const isOpen = !!open[s.key];
                const color = stageColor(s.key);
                return (
                  <Fragment key={s.id}>
                    <div className={`wf-stage${isOpen ? ' open' : ''}`} style={{ borderLeftColor: color }}>
                      <div className="wf-hd" onClick={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))}>
                        <span className={`wf-chev${isOpen ? ' open' : ''}`}>▸</span>
                        <span className="wf-dot" style={{ background: color }} />
                        <input className="wf-name" value={s.name} onClick={(e) => e.stopPropagation()}
                          onChange={(e) => { const v = e.target.value; setStages((ss) => ss.map((x) => x.id === s.id ? { ...x, name: v } : x)); }} onBlur={() => saveStageName(s)} />
                        <span className="wf-count">{list.length} task{list.length === 1 ? '' : 's'}</span>
                        <span className="wf-ctrls" onClick={(e) => e.stopPropagation()}>
                          <button className="wf-ic" onClick={() => moveStage(i, -1)} disabled={i === 0} title="Move earlier">↑</button>
                          <button className="wf-ic" onClick={() => moveStage(i, 1)} disabled={i === stages.length - 1} title="Move later">↓</button>
                          <button className="wf-ic" onClick={() => removeStage(s.id)} title="Delete stage">×</button>
                        </span>
                      </div>
                      {isOpen && (
                        <div className="wf-body">
                          {list.length === 0
                            ? <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', padding: '4px 0' }}>No tasks yet.</div>
                            : <div className="wf-subflow">
                                {levels.map((lvl, li) => (
                                  <Fragment key={li}>
                                    {li > 0 && <div className="wf-lvlconn" />}
                                    <div className="wf-level">{lvl.map((t) => <div key={t.id}>{taskBox(t)}</div>)}</div>
                                  </Fragment>
                                ))}
                              </div>}
                          <div className="wf-addbar">
                            <button className="wf-add" onClick={() => addTask(s.key, 'TASK')}>+ task</button>
                            <button className="wf-add" style={{ color: '#0369a1', borderColor: '#bae6fd' }} onClick={() => addTask(s.key, 'EMAIL')}>+ ✉ email</button>
                          </div>
                        </div>
                      )}
                    </div>
                    {i < stages.length - 1 && <div className="wf-conn" />}
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Right: the selected-task editor */}
      {sel && (
        <div style={{ ...card, width: 280, flex: 'none', position: 'sticky', top: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong style={{ fontSize: 13, color: '#0f172a' }}>{sel.node_kind === 'EMAIL' ? '✉ Edit email' : 'Edit task'}</strong>
            <button onClick={() => deleteNode(sel.id)} style={{ ...btn, color: '#b91c1c', borderColor: '#fecaca', padding: '3px 8px' }}>Delete</button>
          </div>
          <label style={lbl}>{sel.node_kind === 'EMAIL' ? 'Label' : 'Task'}</label>
          <textarea value={sel.detail} onChange={(e) => setTemplates((ts) => ts.map((x) => x.id === sel.id ? { ...x, detail: e.target.value } : x))} onBlur={() => saveNode(sel)} rows={2} style={{ ...input, resize: 'vertical' }} />
          <label style={lbl}>Stage</label>
          <select value={sel.stage} onChange={(e) => { const v = e.target.value; setTemplates((ts) => ts.map((x) => x.id === sel.id ? { ...x, stage: v } : x)); saveNode({ ...sel, stage: v }); }} style={input}>
            {stages.map((s) => <option key={s.id} value={s.key}>{s.name}</option>)}
          </select>

          <label style={lbl}>Runs after (in this stage)</label>
          {(() => {
            const prereqs = edges.filter((e) => e.to_template_id === sel.id).map((e) => byId(e.from_template_id)).filter((t): t is Template => !!t && t.stage === sel.stage);
            const candidates = (tasksByStage[sel.stage] ?? []).filter((t) => t.id !== sel.id && !prereqs.some((p) => p.id === t.id) && !edges.some((e) => e.from_template_id === sel.id && e.to_template_id === t.id));
            return (
              <>
                {prereqs.map((p) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155', background: '#f1f5f9', borderRadius: 7, padding: '4px 8px', marginBottom: 4 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.detail}</span>
                    <button onClick={() => deleteEdge(p.id, sel.id)} title="Remove prerequisite" style={{ border: 'none', background: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
                  </div>
                ))}
                {candidates.length > 0 ? (
                  <select value="" onChange={(e) => { if (e.target.value) void addPrereq(e.target.value, sel.id); }} style={input}>
                    <option value="">+ Add a prerequisite…</option>
                    {candidates.map((t) => <option key={t.id} value={t.id}>{t.detail.slice(0, 60)}</option>)}
                  </select>
                ) : prereqs.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: '#94a3b8' }}>Runs as soon as the stage is reached.</div>
                ) : null}
              </>
            );
          })()}

          {sel.node_kind === 'EMAIL' && (
            <>
              <label style={lbl}>Email template</label>
              <select value={sel.email_template_id ?? ''} onChange={(e) => { const v = e.target.value || null; const next = { ...sel, email_template_id: v }; setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x)); saveNode(next); }} style={input}>
                <option value="">— pick a template —</option>
                {emailTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <label style={lbl}>When it fires</label>
              <select value={sel.send_mode ?? 'DRAFT'} onChange={(e) => { const v = e.target.value as 'DRAFT' | 'SEND'; const next = { ...sel, send_mode: v }; setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x)); saveNode(next); }} style={input}>
                <option value="DRAFT">Draft into the send queue (human sends)</option>
                <option value="SEND">Auto-send (only if a client email is on file)</option>
              </select>
              {sel.send_mode === 'SEND' && <p style={{ fontSize: 10.5, color: '#b45309', marginTop: 6 }}>⚠ Auto-send fires a real client email with no review. Use only for safe boilerplate. Falls back to a draft if no recipient is known.</p>}
              {emailTemplates.length === 0 && <p style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 6 }}>No email templates yet — add one in the Email templates tab.</p>}
            </>
          )}
          {sel.node_kind !== 'EMAIL' && <>
            <label style={lbl}>Assign to</label>
            <select value={sel.assignee_kind === 'USER' ? `u:${sel.assignee_user_id}` : `r:${sel.assignee_role}`}
              onChange={(e) => {
                const v = e.target.value;
                const next: Template = v.startsWith('u:')
                  ? { ...sel, assignee_kind: 'USER', assignee_user_id: v.slice(2), assignee_role: null }
                  : { ...sel, assignee_kind: 'ROLE', assignee_role: v.slice(2), assignee_user_id: null };
                setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x));
                saveNode(next);
              }} style={input}>
              <optgroup label="Role (auto-resolved)">
                <option value="r:OWNER">Matter owner</option>
                {ROLES.filter((r) => r !== 'OWNER').map((r) => <option key={r} value={`r:${r}`}>{r.charAt(0) + r.slice(1).toLowerCase()}</option>)}
              </optgroup>
              <optgroup label="Specific person">
                {users.map((u) => <option key={u.id} value={`u:${u.id}`}>{u.name}</option>)}
              </optgroup>
            </select>
            <label style={lbl}>Due (days after created, optional)</label>
            <input type="number" min={0} value={sel.due_offset_days ?? ''} placeholder="—"
              onChange={(e) => { const v = e.target.value === '' ? null : Math.max(0, parseInt(e.target.value, 10) || 0); setTemplates((ts) => ts.map((x) => x.id === sel.id ? { ...x, due_offset_days: v } : x)); }}
              onBlur={() => saveNode(sel)} style={input} />
          </>}
          <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={sel.active} onChange={(e) => { const next = { ...sel, active: e.target.checked }; setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x)); saveNode(next); }} />
            Active
          </label>
        </div>
      )}
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 12 };
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, margin: '10px 0 3px' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '6px 8px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' };
