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

const STAGES: Array<[string, string, string]> = [
  ['INSTRUCTION', 'Instruction', '#6366f1'],
  ['CONTRACT_PACK', 'Contract pack', '#8b5cf6'],
  ['SEARCHES_ENQUIRIES', 'Searches & enquiries', '#0ea5e9'],
  ['REVIEW_SIGNING', 'Review & signing', '#14b8a6'],
  ['EXCHANGE', 'Exchange', '#f59e0b'],
  ['COMPLETION', 'Completion', '#16a34a'],
  ['POST_COMPLETION', 'Post-completion', '#64748b'],
];
const stageColor = (s: string) => STAGES.find(([v]) => v === s)?.[2] ?? '#64748b';
const stageLabel = (s: string) => STAGES.find(([v]) => v === s)?.[1] ?? s;
const ROLES = ['OWNER', 'CONVEYANCER', 'ASSISTANT', 'ADMIN'];

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
    const stage = STAGES[0][0];
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

  const sel = templates.find((t) => t.id === selected) || null;
  const center = (t: Template) => { const p = posOf(t); return { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 }; };
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
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          {STAGES.map(([v, l, c]) => (
            <span key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#475569' }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: c }} /> {l}
            </span>
          ))}
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
                const p1 = center(a), p2 = center(b);
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
                const a = templates.find((t) => t.id === linking.from); if (!a) return null; const p1 = center(a);
                return <line x1={p1.x} y1={p1.y} x2={linking.x} y2={linking.y} stroke="#5A27E0" strokeWidth={2} strokeDasharray="4 3" />;
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
                  {/* Connect handle — drag to another node to make this a prerequisite. */}
                  <div title="Drag onto another task to make this its prerequisite"
                    onMouseDown={(e) => startLink(e, t)}
                    style={{ position: 'absolute', right: -7, top: '50%', marginTop: -7, width: 14, height: 14, borderRadius: 999, background: '#5A27E0', border: '2px solid #fff', cursor: 'crosshair' }} />
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
              {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
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
