'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
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

const NODE_W = 190;
const NODE_H = 74;

export default function WorkflowCanvas() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [users, setUsers] = useState<Member[]>([]);
  const [statuses, setStatuses] = useState<Array<{ id: string; name: string; kind: string; color: string | null; sort_order: number }>>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Live drag/connect state (kept in a ref so mousemove doesn't thrash React state).
  const drag = useRef<{ kind: 'move' | 'connect'; id: string; dx: number; dy: number } | null>(null);
  const [override, setOverride] = useState<Record<string, { x: number; y: number }>>({});
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ templates: Template[]; edges: Edge[]; users: Member[] }>('/admin/workflow');
      setTemplates(r.templates ?? []);
      setEdges(r.edges ?? []);
      setUsers(r.users ?? []);
      try { setStatuses((await api<{ statuses: any[] }>('/admin/statuses')).statuses ?? []); } catch { /* palette optional */ }
      try { setStages((await api<{ stages: Stage[] }>('/admin/stages')).stages ?? []); } catch { /* stages optional */ }
      setErr(null);
    } catch (e: any) {
      setErr(e?.message || 'Could not load the workflow. Has migration 039 been run?');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const relPos = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const b = c.getBoundingClientRect();
    return { x: e.clientX - b.left + c.scrollLeft, y: e.clientY - b.top + c.scrollTop };
  };
  const posOf = (t: Template) => override[t.id] ?? { x: t.pos_x, y: t.pos_y };

  const onMouseMove = (e: React.MouseEvent) => {
    const p = relPos(e);
    if (drag.current?.kind === 'move') {
      setOverride((o) => ({ ...o, [drag.current!.id]: { x: p.x - drag.current!.dx, y: p.y - drag.current!.dy } }));
    } else if (linking) {
      setLinking((l) => (l ? { ...l, x: p.x, y: p.y } : l));
    }
  };
  const onMouseUp = async () => {
    if (drag.current?.kind === 'move') {
      const id = drag.current.id;
      const pos = override[id];
      drag.current = null;
      if (pos) {
        setTemplates((ts) => ts.map((t) => (t.id === id ? { ...t, pos_x: pos.x, pos_y: pos.y } : t)));
        await api('/admin/workflow/positions', { method: 'POST', body: JSON.stringify({ positions: [{ id, x: Math.round(pos.x), y: Math.round(pos.y) }] }) }).catch(() => {});
      }
    }
    drag.current = null;
    setLinking(null);
  };

  const startMove = (e: React.MouseEvent, t: Template) => {
    e.stopPropagation();
    const p = relPos(e);
    const pos = posOf(t);
    drag.current = { kind: 'move', id: t.id, dx: p.x - pos.x, dy: p.y - pos.y };
  };
  const startLink = (e: React.MouseEvent, t: Template) => {
    e.stopPropagation();
    const p = relPos(e);
    setLinking({ from: t.id, x: p.x, y: p.y });
  };
  const finishLink = async (target: Template) => {
    if (!linking || linking.from === target.id) { setLinking(null); return; }
    try {
      await api('/admin/workflow/edges', { method: 'POST', body: JSON.stringify({ from: linking.from, to: target.id }) });
      await load();
    } catch (e: any) {
      setErr(e?.message || 'Could not add dependency.');
    }
    setLinking(null);
  };

  const addTask = async () => {
    const stage = stages[0]?.key ?? 'INSTRUCTION';
    const y = 40 + templates.filter((t) => t.stage === stage).length * 90;
    try {
      const r = await api<{ template: Template }>('/admin/workflow', {
        method: 'POST',
        body: JSON.stringify({ stage, detail: 'New task', assigneeKind: 'ROLE', assigneeRole: 'OWNER', posX: 40, posY: y }),
      });
      setTemplates((ts) => [...ts, r.template]);
      setSelected(r.template.id);
    } catch (e: any) {
      setErr(e?.message || 'Could not add task.');
    }
  };

  const saveNode = async (t: Template) => {
    try {
      const r = await api<{ template: Template }>('/admin/workflow', {
        method: 'POST',
        body: JSON.stringify({
          id: t.id, stage: t.stage, detail: t.detail, assigneeKind: t.assignee_kind,
          assigneeRole: t.assignee_role, assigneeUserId: t.assignee_user_id, dueOffsetDays: t.due_offset_days,
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
  const deleteEdge = async (from: string, to: string) => {
    setEdges((es) => es.filter((e) => !(e.from_template_id === from && e.to_template_id === to)));
    await api(`/admin/workflow/edges?from=${from}&to=${to}`, { method: 'DELETE' }).catch(() => {});
  };

  const addStatus = async () => {
    try { await api('/admin/statuses', { method: 'POST', body: JSON.stringify({ name: 'New status', kind: 'OPEN', color: '#64748b', sortOrder: statuses.length }) }); await load(); }
    catch (e: any) { setErr(e?.message || 'Could not add status.'); }
  };
  const saveStatus = async (s: { id: string; name: string; kind: string; color: string | null; sort_order: number }) => {
    try { await api('/admin/statuses', { method: 'POST', body: JSON.stringify({ id: s.id, name: s.name, kind: s.kind, color: s.color, sortOrder: s.sort_order }) }); }
    catch (e: any) { setErr(e?.message || 'Could not save status.'); }
  };
  const removeStatus = async (id: string) => {
    if (!window.confirm('Delete this status?')) return;
    setStatuses((ss) => ss.filter((x) => x.id !== id));
    await api(`/admin/statuses?id=${id}`, { method: 'DELETE' }).catch(() => {});
  };

  const stageColor = (key: string) => { const i = stages.findIndex((s) => s.key === key); return STAGE_COLORS[(i < 0 ? 0 : i) % STAGE_COLORS.length]; };
  const stageLabel = (key: string) => stages.find((s) => s.key === key)?.name ?? key;
  const addStage = async () => {
    try { await api('/admin/stages', { method: 'POST', body: JSON.stringify({ name: 'New stage', sortOrder: stages.length }) }); await load(); }
    catch (e: any) { setErr(e?.message || 'Could not add stage.'); }
  };
  const saveStageName = async (s: Stage) => { try { await api('/admin/stages', { method: 'POST', body: JSON.stringify({ id: s.id, name: s.name, sortOrder: s.sort_order, active: s.active }) }); } catch (e: any) { setErr(e?.message || 'Could not save stage.'); } };
  const removeStage = async (id: string) => { if (!window.confirm('Delete this stage? (Kept but hidden if matters are on it.)')) return; await api(`/admin/stages?id=${id}`, { method: 'DELETE' }).catch(() => {}); await load(); };
  const moveStage = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir; if (j < 0 || j >= stages.length) return;
    const reordered = [...stages]; [reordered[idx], reordered[j]] = [reordered[j], reordered[idx]];
    setStages(reordered);
    await api('/admin/stages', { method: 'POST', body: JSON.stringify({ order: reordered.map((s, i) => ({ id: s.id, sortOrder: i })) }) }).catch(() => {});
  };

  const sel = templates.find((t) => t.id === selected) || null;
  // Edges run from the OUT port (right edge of the prerequisite) to the IN port (left edge of
  // the dependent), at a fixed offset from the node top so they line up with the visible dots.
  const PORT_Y = 30;
  const outPt = (t: Template) => { const p = posOf(t); return { x: p.x + NODE_W, y: p.y + PORT_Y }; };
  const inPt = (t: Template) => { const p = posOf(t); return { x: p.x, y: p.y + PORT_Y }; };
  const assigneeText = (t: Template) =>
    t.assignee_kind === 'USER' ? users.find((u) => u.id === t.assignee_user_id)?.name ?? 'a person'
      : t.assignee_role === 'OWNER' ? 'Matter owner' : (t.assignee_role ?? '').charAt(0) + (t.assignee_role ?? '').slice(1).toLowerCase();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15, color: '#0f172a' }}>Workflow</strong>
          <span style={{ fontSize: 12.5, color: '#64748b', flex: 1, minWidth: 200 }}>
            Tasks auto-created &amp; assigned when a matter hits a stage. Drag a node's dot onto another to make it a prerequisite.
          </span>
          <button onClick={addTask} style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>+ Add task</button>
        </div>
        {/* Pipeline stages (checkpoints) — rename, reorder, add your own. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 }}>Pipeline stages</span>
          <button onClick={addStage} style={{ ...btn, padding: '3px 9px', fontSize: 11.5 }}>+ Add stage</button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {stages.map((s, i) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, border: '1px solid #e2e8f0', borderRadius: 8, padding: '3px 5px', background: '#fff' }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: stageColor(s.key), flex: 'none' }} />
              <input value={s.name} onChange={(e) => { const v = e.target.value; setStages((ss) => ss.map((x) => x.id === s.id ? { ...x, name: v } : x)); }} onBlur={() => saveStageName(s)}
                style={{ width: `${Math.max(8, s.name.length + 1)}ch`, minWidth: 60, fontSize: 12, padding: '2px 4px', border: '1px solid transparent', borderRadius: 5, background: 'transparent' }} />
              <button onClick={() => moveStage(i, -1)} disabled={i === 0} title="Move earlier" style={arrowBtn}>‹</button>
              <button onClick={() => moveStage(i, 1)} disabled={i === stages.length - 1} title="Move later" style={arrowBtn}>›</button>
              <button onClick={() => removeStage(s.id)} title="Delete stage" style={{ ...arrowBtn, color: '#94a3b8' }}>×</button>
            </div>
          ))}
        </div>
      </div>

      {/* Task statuses — the firm's own labels. Each maps to a kind that drives the logic. */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13, color: '#0f172a' }}>Task statuses</strong>
          <span style={{ fontSize: 11.5, color: '#94a3b8', flex: 1 }}>Kind drives the logic: <b>Done</b> completes a task (and unblocks dependents); <b>Open</b>/<b>In&nbsp;progress</b> stay actionable.</span>
          <button onClick={addStatus} style={btn}>+ Add status</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {statuses.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #e2e8f0', borderRadius: 8, padding: '5px 7px', background: '#fff' }}>
              <input type="color" value={s.color || '#64748b'} onChange={(e) => { const v = e.target.value; setStatuses((ss) => ss.map((x) => x.id === s.id ? { ...x, color: v } : x)); }} onBlur={() => saveStatus({ ...s, color: s.color })} style={{ width: 22, height: 22, border: 'none', background: 'none', padding: 0, cursor: 'pointer' }} />
              <input value={s.name} onChange={(e) => { const v = e.target.value; setStatuses((ss) => ss.map((x) => x.id === s.id ? { ...x, name: v } : x)); }} onBlur={() => saveStatus(s)} style={{ width: 110, fontSize: 12, padding: '3px 5px', border: '1px solid #d0d5dd', borderRadius: 6 }} />
              <select value={s.kind} onChange={(e) => { const v = e.target.value; const next = { ...s, kind: v }; setStatuses((ss) => ss.map((x) => x.id === s.id ? next : x)); saveStatus(next); }} style={{ fontSize: 11.5, padding: '3px 4px', border: '1px solid #d0d5dd', borderRadius: 6 }}>
                <option value="OPEN">Open</option>
                <option value="IN_PROGRESS">In progress</option>
                <option value="DONE">Done</option>
              </select>
              <button onClick={() => removeStatus(s.id)} title="Delete status" style={{ border: 'none', background: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
            </div>
          ))}
          {statuses.length === 0 && <span style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</span>}
        </div>
      </div>

      {err && <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca' }}>{err}</div>}

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {/* Canvas */}
        <div
          ref={canvasRef}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => { drag.current = null; setLinking(null); }}
          onClick={() => setSelected(null)}
          style={{ position: 'relative', flex: 1, height: '68vh', overflow: 'auto', background: '#F8FAFC', border: '1px solid #e2e8f0', borderRadius: 12 }}
        >
          <div style={{ position: 'relative', width: 2000, height: 1200 }}>
            <svg width={2000} height={1200} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              <defs>
                <marker id="wf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0 0 L8 4 L0 8 z" fill="#94a3b8" />
                </marker>
              </defs>
              {edges.map((e) => {
                const a = templates.find((t) => t.id === e.from_template_id);
                const b = templates.find((t) => t.id === e.to_template_id);
                if (!a || !b) return null;
                const p1 = outPt(a), p2 = inPt(b);
                return (
                  <line key={`${e.from_template_id}-${e.to_template_id}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                    stroke="#94a3b8" strokeWidth={2} markerEnd="url(#wf-arrow)"
                    style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                    onClick={(ev) => { ev.stopPropagation(); void deleteEdge(e.from_template_id, e.to_template_id); }}>
                    <title>Click to remove dependency</title>
                  </line>
                );
              })}
              {linking && (() => {
                const a = templates.find((t) => t.id === linking.from); if (!a) return null; const p1 = outPt(a);
                return <line x1={p1.x} y1={p1.y} x2={linking.x} y2={linking.y} stroke="#5A27E0" strokeWidth={2} strokeDasharray="4 3" markerEnd="url(#wf-arrow)" />;
              })()}
            </svg>

            {templates.map((t) => {
              const p = posOf(t);
              const isSel = t.id === selected;
              return (
                <div key={t.id}
                  onMouseDown={(e) => startMove(e, t)}
                  onMouseUp={() => { if (linking) void finishLink(t); }}
                  onClick={(e) => { e.stopPropagation(); setSelected(t.id); }}
                  style={{
                    position: 'absolute', left: p.x, top: p.y, width: NODE_W, minHeight: NODE_H,
                    background: '#fff', border: `2px solid ${isSel ? '#5A27E0' : stageColor(t.stage)}`,
                    borderRadius: 10, boxShadow: isSel ? '0 2px 10px rgba(90,39,224,0.2)' : '0 1px 3px rgba(16,24,40,0.08)',
                    padding: '7px 9px', cursor: 'grab', opacity: t.active ? 1 : 0.5, userSelect: 'none',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 3, background: stageColor(t.stage), flex: 'none' }} />
                    <span style={{ fontSize: 9.5, fontWeight: 700, color: stageColor(t.stage), textTransform: 'uppercase', letterSpacing: 0.3 }}>{stageLabel(t.stage)}</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#1e293b', lineHeight: 1.3, wordBreak: 'break-word' }}>{t.detail}</div>
                  <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 3 }}>→ {assigneeText(t)}{t.due_offset_days != null ? ` · +${t.due_offset_days}d` : ''}</div>
                  {/* IN port (left) — where incoming dependency arrows land. */}
                  <div title={linking ? 'Drop here to make the dragged task a prerequisite of this one' : 'Dependencies arrive here'}
                    style={{ position: 'absolute', left: -6, top: PORT_Y - 6, width: 12, height: 12, borderRadius: 999, background: linking && linking.from !== t.id ? '#5A27E0' : '#cbd5e1', border: '2px solid #fff' }} />
                  {/* OUT port (right) — drag to another node's left port to make THIS a prerequisite. */}
                  <div title="Drag onto another task to make this its prerequisite"
                    onMouseDown={(e) => startLink(e, t)}
                    style={{ position: 'absolute', right: -7, top: PORT_Y - 7, width: 14, height: 14, borderRadius: 999, background: '#5A27E0', border: '2px solid #fff', cursor: 'crosshair', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
                </div>
              );
            })}
            {!loading && templates.length === 0 && (
              <div style={{ position: 'absolute', left: 40, top: 40, color: '#64748b', fontSize: 13 }}>
                <div style={{ marginBottom: 10 }}>No tasks yet.</div>
                <button onClick={async () => { try { await api('/admin/workflow/seed', { method: 'POST' }); await load(); } catch (e: any) { setErr(e?.message || 'Could not load defaults.'); } }}
                  style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none', marginRight: 8 }}>
                  Load the standard conveyancing flow
                </button>
                <button onClick={addTask} style={btn}>Start from scratch</button>
              </div>
            )}
          </div>
        </div>

        {/* Editor */}
        {sel && (
          <div style={{ ...card, width: 260, flex: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <strong style={{ fontSize: 13, color: '#0f172a' }}>Edit task</strong>
              <button onClick={() => deleteNode(sel.id)} style={{ ...btn, color: '#b91c1c', borderColor: '#fecaca', padding: '3px 8px' }}>Delete</button>
            </div>
            <label style={lbl}>Task</label>
            <textarea value={sel.detail} onChange={(e) => setTemplates((ts) => ts.map((x) => x.id === sel.id ? { ...x, detail: e.target.value } : x))} onBlur={() => saveNode(sel)} rows={3} style={{ ...input, resize: 'vertical' }} />
            <label style={lbl}>Checkpoint (stage)</label>
            <select value={sel.stage} onChange={(e) => { const v = e.target.value; setTemplates((ts) => ts.map((x) => x.id === sel.id ? { ...x, stage: v } : x)); saveNode({ ...sel, stage: v }); }} style={input}>
              {stages.map((s) => <option key={s.id} value={s.key}>{s.name}</option>)}
            </select>
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
            <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={sel.active} onChange={(e) => { const next = { ...sel, active: e.target.checked }; setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x)); saveNode(next); }} />
              Active
            </label>
            <p style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 8 }}>Changes save automatically. Drag the purple dot to another task to add a prerequisite; click a line to remove one.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 12 };
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, margin: '10px 0 3px' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '6px 8px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' };
const arrowBtn: React.CSSProperties = { border: 'none', background: 'none', color: '#64748b', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px' };
