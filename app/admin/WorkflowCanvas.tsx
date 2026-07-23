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

// Canvas geometry. Tasks are absolutely positioned; these drive the auto-layout and
// the arrow endpoints.
const PILL_W = 230;
const PILL_H = 58;
const GAP_X = 40;
const GAP_Y = 62;
const PAD = 12;

interface Stage { id: string; key: string; name: string; sort_order: number; active: boolean }
interface Template {
  id: string;
  stage: string;
  detail: string;
  type: string;
  node_kind?: 'TASK' | 'EMAIL' | 'DOC';
  email_template_id?: string | null;
  send_mode?: 'DRAFT' | 'SEND' | null;
  doc_template_id?: string | null;
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

// Longest-path rank per task (a task's level = 1 + the deepest of its prerequisites).
// Used only to seed a tidy default layout for tasks that have never been placed.
function levelsOf(list: Template[], edges: Edge[]): Record<string, number> {
  const ids = new Set(list.map((t) => t.id));
  const prereqs: Record<string, string[]> = {};
  for (const e of edges) if (ids.has(e.from_template_id) && ids.has(e.to_template_id)) (prereqs[e.to_template_id] ??= []).push(e.from_template_id);
  const memo: Record<string, number> = {};
  const calc = (id: string, stack: Set<string>): number => {
    if (memo[id] != null) return memo[id];
    let lv = 0;
    for (const p of prereqs[id] ?? []) if (!stack.has(p)) lv = Math.max(lv, calc(p, new Set([...stack, id])) + 1);
    return (memo[id] = lv);
  };
  for (const t of list) calc(t.id, new Set());
  return memo;
}
// A clean grid for a stage: level = row, order within a level = column.
function computeLayout(list: Template[], edges: Edge[]): Record<string, { x: number; y: number }> {
  const lv = levelsOf(list, edges);
  const byLevel: Record<number, Template[]> = {};
  [...list].sort((a, b) => a.sort_order - b.sort_order).forEach((t) => (byLevel[lv[t.id]] ??= []).push(t));
  const out: Record<string, { x: number; y: number }> = {};
  for (const [L, arr] of Object.entries(byLevel)) arr.forEach((t, i) => (out[t.id] = { x: PAD + i * (PILL_W + GAP_X), y: PAD + Number(L) * (PILL_H + GAP_Y) }));
  return out;
}

// Free-form canvas CSS. Tasks are absolutely placed; arrows overlay them on top, so the
// dependency lines are always readable and stay clickable-to-delete.
const WF_CSS = `
.wf-flow{display:flex;flex-direction:column;align-items:center}
.wf-stage{width:360px;background:#fff;border:1px solid #e6e8ee;border-left-width:4px;border-radius:12px;box-shadow:0 1px 3px rgba(16,24,40,.08)}
.wf-stage.open{width:auto;min-width:660px;max-width:100%}
.wf-hd{display:flex;align-items:center;gap:10px;padding:11px 13px;cursor:pointer}
.wf-dot{width:11px;height:11px;border-radius:3px;flex:none}
.wf-name{font-size:14.5px;font-weight:700;color:#0f172a;flex:1;min-width:0;border:1px solid transparent;border-radius:6px;background:transparent;padding:2px 4px;font-family:inherit}
.wf-name:focus{outline:none;border-color:#d0d5dd;background:#fff}
.wf-count{font-size:12px;color:#94a3b8;white-space:nowrap}
.wf-chev{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;border:none;background:none;color:#334155;font-size:20px;line-height:1;cursor:pointer;transition:transform .12s}
.wf-chev:hover{color:#5A27E0}
.wf-chev.open{transform:rotate(90deg)}
.wf-ctrls{display:flex;gap:1px;opacity:0;transition:opacity .1s}
.wf-stage:hover .wf-ctrls{opacity:1}
.wf-ic{display:inline-flex;align-items:center;justify-content:center;border:none;background:none;color:#94a3b8;cursor:pointer;font-size:13px;line-height:1;padding:2px 5px;border-radius:5px}
.wf-ic:disabled{opacity:.3;cursor:default}
.wf-ic.wf-del:hover{color:#b91c1c}
.wf-conn{width:2px;height:26px;background:#c3cbd6;position:relative}
.wf-conn::after{content:'';position:absolute;bottom:-1px;left:50%;transform:translateX(-50%);border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid #c3cbd6}
.wf-body{border-top:1px solid #eef2f7;background:#fafbfc;padding:16px;overflow:auto}
.wf-canvas{position:relative}
.wf-arrows{position:absolute;top:0;left:0;pointer-events:none;overflow:visible;z-index:5}
.wf-hit{stroke:transparent;stroke-width:14;fill:none;pointer-events:stroke;cursor:pointer}
.wf-task{position:absolute;width:230px;box-sizing:border-box;background:#fff;border:1px solid #dfe3ea;border-radius:9px;box-shadow:0 1px 2px rgba(16,24,40,.06);padding:8px 11px;cursor:grab;text-align:left;user-select:none;z-index:2}
.wf-task:active{cursor:grabbing}
.wf-task.sel{border-color:#5A27E0;background:#EDE7FB}
.wf-task.tgt{border-color:#16a34a;box-shadow:0 0 0 3px #bbf7d0}
.wf-t{font-size:12.5px;font-weight:600;color:#1e293b;line-height:1.3;word-break:break-word}
.wf-m{font-size:10.5px;color:#94a3b8;margin-top:3px}
.wf-handle{position:absolute;left:50%;bottom:-8px;transform:translateX(-50%);width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #b0b8c4;cursor:crosshair;z-index:6}
.wf-task:hover .wf-handle,.wf-handle:hover{border-color:#5A27E0;background:#EDE7FB}
.wf-addbar{margin-top:14px;display:flex;gap:6px;justify-content:center}
.wf-add{font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:7px;border:1px solid #d0d5dd;background:#fff;color:#475569;cursor:pointer}
`;

export default function WorkflowCanvas() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [users, setUsers] = useState<Member[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<Array<{ id: string; name: string; subject_template: string | null }>>([]);
  const [docTemplates, setDocTemplates] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null); // moving a pill (cosmetic)
  const [wire, setWire] = useState<{ from: string; stageKey: string; sx: number; sy: number; cx: number; cy: number } | null>(null); // drawing a dependency
  const [hoverPill, setHoverPill] = useState<string | null>(null);   // wire drop target
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);   // arrow under cursor (delete affordance)
  const gesture = useRef<{ kind: 'drag' | 'wire'; id: string; stageKey: string; startX: number; startY: number; rectLeft: number; rectTop: number; dx: number; dy: number; moved: boolean } | null>(null);

  const [note, setNoteRaw] = useState<string | null>(null); // gentle, auto-clearing hint
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setNote = (m: string) => { setNoteRaw(m); if (noteTimer.current) clearTimeout(noteTimer.current); noteTimer.current = setTimeout(() => setNoteRaw(null), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let stageList: Stage[] = [];
      try { stageList = (await api<{ stages: Stage[] }>('/admin/stages')).stages ?? []; } catch { /* stages optional */ }
      const r = await api<{ templates: Template[]; edges: Edge[]; users: Member[]; emailTemplates: any[]; docTemplates: any[] }>('/admin/workflow');
      let tmpl = r.templates ?? [];
      const eds = r.edges ?? [];

      // One-time normalisation: legacy tasks were all stored at x=0 (stacked). Give each
      // stage a tidy default grid so the free-form canvas doesn't open as a pile, and
      // persist it so positions become real coordinates from here on.
      const patches: Template[] = [];
      for (const s of stageList) {
        const list = tmpl.filter((t) => t.stage === s.key);
        if (list.length > 1 && new Set(list.map((t) => t.pos_x)).size <= 1) {
          const lay = computeLayout(list, eds);
          for (const t of list) { const p = lay[t.id]; if (p) patches.push({ ...t, pos_x: p.x, pos_y: p.y }); }
        }
      }
      if (patches.length) {
        tmpl = tmpl.map((t) => patches.find((p) => p.id === t.id) ?? t);
        void Promise.all(patches.map((p) => api('/admin/workflow', { method: 'POST', body: JSON.stringify(templateBody(p)) }))).catch(() => {});
      }

      setStages(stageList);
      setTemplates(tmpl);
      setEdges(eds);
      setUsers(r.users ?? []);
      setEmailTemplates(r.emailTemplates ?? []);
      setDocTemplates(r.docTemplates ?? []);
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
    return m;
  }, [templates]);

  const byId = useCallback((id: string) => templates.find((t) => t.id === id) || null, [templates]);
  const sel = selected ? byId(selected) : null;

  // Effective position of a pill, including the live drag offset so both the pill and
  // its arrows follow the cursor while dragging.
  const posOf = useCallback((t: Template) => {
    let x = t.pos_x, y = t.pos_y;
    if (drag && drag.id === t.id) { x += drag.dx; y += drag.dy; }
    return { x, y };
  }, [drag]);

  // Pills grow with their (wrapping) text, so arrow starts and the connection handle
  // must anchor to each pill's REAL height — a constant would leave the arrow floating
  // above the circle on a two-line task. Measured after layout; converges (only sets
  // state when a height actually changed).
  const [heights, setHeights] = useState<Record<string, number>>({});
  useEffect(() => {
    const next: Record<string, number> = {};
    document.querySelectorAll<HTMLElement>('.wf-task[data-taskid]').forEach((el) => { next[el.getAttribute('data-taskid')!] = el.offsetHeight; });
    setHeights((prev) => {
      const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
      for (const k of keys) if (prev[k] !== next[k]) return next;
      return prev;
    });
  }, [templates, open, stages, edges]);
  const heightOf = (id: string) => heights[id] ?? PILL_H;

  // ── Mutations ───────────────────────────────────────────────────────────────
  const addTask = async (stageKey: string, nodeKind: 'TASK' | 'EMAIL' | 'DOC' = 'TASK') => {
    const list = tasksByStage[stageKey] ?? [];
    const posY = list.length ? Math.max(...list.map((t) => t.pos_y)) + PILL_H + GAP_Y : PAD;
    try {
      const body: any = { stage: stageKey, assigneeKind: 'ROLE', assigneeRole: 'OWNER', posX: PAD, posY };
      if (nodeKind === 'EMAIL') { body.detail = 'Send email'; body.nodeKind = 'EMAIL'; body.sendMode = 'DRAFT'; body.emailTemplateId = emailTemplates[0]?.id ?? null; }
      else if (nodeKind === 'DOC') { body.detail = 'Generate document'; body.nodeKind = 'DOC'; body.docTemplateId = docTemplates[0]?.id ?? null; }
      else body.detail = 'New task';
      const r = await api<{ template: Template }>('/admin/workflow', { method: 'POST', body: JSON.stringify(body) });
      setTemplates((ts) => [...ts, r.template]);
      setOpen((o) => ({ ...o, [stageKey]: true }));
      setSelected(r.template.id);
    } catch (e: any) { setErr(e?.message || 'Could not add.'); }
  };
  const saveNode = useCallback(async (t: Template) => {
    try {
      const r = await api<{ template: Template }>('/admin/workflow', { method: 'POST', body: JSON.stringify(templateBody(t)) });
      setTemplates((ts) => ts.map((x) => (x.id === t.id ? r.template : x)));
    } catch (e: any) { setErr(e?.message || 'Could not save.'); }
  }, []);
  const deleteNode = async (id: string) => {
    if (!window.confirm('Delete this task and its dependencies?')) return;
    try {
      await api(`/admin/workflow?id=${id}`, { method: 'DELETE' });
      setTemplates((ts) => ts.filter((t) => t.id !== id));
      setEdges((es) => es.filter((e) => e.from_template_id !== id && e.to_template_id !== id));
      setSelected(null);
    } catch (e: any) { setErr(e?.message || 'Could not delete.'); }
  };
  // Is there already a path a → … → b along the edges? Catches a cycle client-side.
  const reaches = (a: string, b: string, es: Edge[]) => {
    const seen = new Set<string>(); const stack = [a];
    while (stack.length) { const n = stack.pop()!; if (n === b) return true; if (seen.has(n)) continue; seen.add(n); for (const e of es) if (e.from_template_id === n) stack.push(e.to_template_id); }
    return false;
  };
  // Draw a dependency: `to` runs after `from`. Reads the freshest edges via the updater
  // so it never acts on a stale snapshot from a drag gesture's closure.
  const addPrereq = useCallback((from: string, to: string) => {
    if (from === to) return;
    setEdges((prev) => {
      if (prev.some((e) => e.from_template_id === from && e.to_template_id === to)) return prev; // already linked
      if (reaches(to, from, prev)) { setNote('Those two already run in that order — they can’t depend on each other both ways.'); return prev; }
      void api('/admin/workflow/edges', { method: 'POST', body: JSON.stringify({ from, to }) })
        .catch((e: any) => { setEdges((es) => es.filter((x) => !(x.from_template_id === from && x.to_template_id === to))); setNote(e?.message || 'Couldn’t link those.'); });
      return [...prev, { from_template_id: from, to_template_id: to }];
    });
  }, []);
  const deleteEdge = useCallback((from: string, to: string) => {
    setEdges((es) => es.filter((e) => !(e.from_template_id === from && e.to_template_id === to)));
    void api(`/admin/workflow/edges?from=${from}&to=${to}`, { method: 'DELETE' }).catch(() => {});
  }, []);

  // ── Global drag/wire handlers (attached once; act via refs + functional updaters,
  //    so they never read stale state) ─────────────────────────────────────────
  const addPrereqRef = useRef(addPrereq); addPrereqRef.current = addPrereq;
  const saveNodeRef = useRef(saveNode); saveNodeRef.current = saveNode;
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const g = gesture.current; if (!g) return;
      if (g.kind === 'drag') {
        g.dx = e.clientX - g.startX; g.dy = e.clientY - g.startY;
        if (Math.hypot(g.dx, g.dy) > 3) g.moved = true;
        setDrag({ id: g.id, dx: g.dx, dy: g.dy });
      } else {
        const cx = e.clientX - g.rectLeft, cy = e.clientY - g.rectTop;
        setWire((w) => (w ? { ...w, cx, cy } : w));
        const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-taskid]');
        const tid = el?.getAttribute('data-taskid') ?? null;
        setHoverPill(tid && tid !== g.id && el?.getAttribute('data-stage') === g.stageKey ? tid : null);
      }
    };
    const onUp = (e: MouseEvent) => {
      const g = gesture.current; gesture.current = null;
      if (!g) return;
      if (g.kind === 'drag') {
        if (g.moved) {
          setTemplates((ts) => {
            const next = ts.map((x) => (x.id === g.id ? { ...x, pos_x: Math.round(x.pos_x + g.dx), pos_y: Math.round(Math.max(0, x.pos_y + g.dy)) } : x));
            const nt = next.find((x) => x.id === g.id); if (nt) void saveNodeRef.current(nt);
            return next;
          });
        } else {
          setSelected((s) => (s === g.id ? null : g.id)); // a click, not a drag → select
        }
        setDrag(null);
      } else {
        setWire(null); setHoverPill(null);
        const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-taskid]');
        const target = el?.getAttribute('data-taskid');
        if (target && target !== g.id && el?.getAttribute('data-stage') === g.stageKey) addPrereqRef.current(g.id, target);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

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

  // Begin moving a pill (cosmetic reposition). Records where the canvas is so the wire
  // maths (for the handle) has a stable origin.
  const startGesture = (kind: 'drag' | 'wire', t: Template, e: React.MouseEvent) => {
    const canvas = (e.currentTarget as HTMLElement).closest('.wf-canvas') as HTMLElement | null;
    const rect = canvas?.getBoundingClientRect();
    gesture.current = { kind, id: t.id, stageKey: t.stage, startX: e.clientX, startY: e.clientY, rectLeft: rect?.left ?? 0, rectTop: rect?.top ?? 0, dx: 0, dy: 0, moved: false };
    if (kind === 'drag') setDrag({ id: t.id, dx: 0, dy: 0 });
    else { const p = posOf(t); const sy = p.y + heightOf(t.id); setWire({ from: t.id, stageKey: t.stage, sx: p.x + PILL_W / 2, sy, cx: p.x + PILL_W / 2, cy: sy }); }
  };

  const taskBox = (t: Template) => {
    const p = posOf(t);
    return (
      <div
        data-taskid={t.id}
        data-stage={t.stage}
        className={`wf-task${t.id === selected ? ' sel' : ''}${hoverPill === t.id ? ' tgt' : ''}`}
        style={{
          left: p.x, top: p.y,
          ...(t.id === drag?.id ? { zIndex: 20, borderColor: '#5A27E0', boxShadow: '0 12px 28px rgba(90,39,224,0.3)', cursor: 'grabbing' } : {}),
          opacity: t.active ? 1 : 0.5,
        }}
        onMouseDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); startGesture('drag', t, e); }}
        title="Drag to move · drag the dot below to link to another task"
      >
        <div className="wf-t">
          {t.node_kind === 'EMAIL' && <span style={{ fontSize: 9, fontWeight: 800, color: '#0ea5e9', marginRight: 5 }}>✉</span>}
          {t.node_kind === 'DOC' && <span style={{ fontSize: 9, fontWeight: 800, color: '#d97706', marginRight: 5 }}>📄</span>}
          {t.detail}
        </div>
        <div className="wf-m">
          {t.node_kind === 'EMAIL'
            ? `${emailTemplates.find((e) => e.id === t.email_template_id)?.name ?? 'no template'} · ${t.send_mode === 'SEND' ? '⚡ auto-send' : '✎ draft'}${t.doc_template_id ? ' · 📎 doc' : ''}`
            : t.node_kind === 'DOC'
              ? `${docTemplates.find((d) => d.id === t.doc_template_id)?.name ?? 'no template'} · → Case files`
              : `→ ${assigneeText(t)}${t.due_offset_days != null ? ` · +${t.due_offset_days}d` : ''}`}
        </div>
        <div className="wf-handle" title="Drag to the next task to link them" onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); startGesture('wire', t, e); }} />
      </div>
    );
  };

  // The arrow layer for one stage: a curve per dependency, on top of the pills, each
  // clickable to remove. Endpoints track the pills' live positions.
  const arrows = (s: Stage, list: Template[], w: number, h: number) => {
    const se = edges.filter((e) => byId(e.from_template_id)?.stage === s.key && byId(e.to_template_id)?.stage === s.key);
    return (
      <svg className="wf-arrows" width={w} height={h}>
        <defs>
          <marker id={`wa-${s.key}`} markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#94a3b8" /></marker>
          <marker id={`wa-h-${s.key}`} markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#5A27E0" /></marker>
        </defs>
        {se.map((e) => {
          const a = byId(e.from_template_id), b = byId(e.to_template_id); if (!a || !b) return null;
          const pa = posOf(a), pb = posOf(b);
          const x1 = pa.x + PILL_W / 2, y1 = pa.y + heightOf(a.id), x2 = pb.x + PILL_W / 2, y2 = pb.y;
          const dy = Math.max(18, Math.abs(y2 - y1) * 0.4);
          const d = `M ${x1} ${y1} C ${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`;
          // The click-to-delete region starts BELOW the source handle, so the handle stays
          // grabbable — you can pull a second (branching) arrow out of the same task.
          const gap = Math.min(22, dy);
          const dHit = `M ${x1} ${y1 + gap} C ${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`;
          const key = `${e.from_template_id}-${e.to_template_id}`;
          const hot = hoverEdge === key;
          return (
            <g key={key} onMouseEnter={() => setHoverEdge(key)} onMouseLeave={() => setHoverEdge((k) => (k === key ? null : k))}>
              <path className="wf-hit" d={dHit} onClick={() => { deleteEdge(e.from_template_id, e.to_template_id); setNote('Removed — those now run in parallel.'); }}>
                <title>Click to remove this dependency</title>
              </path>
              <path d={d} fill="none" stroke={hot ? '#5A27E0' : '#94a3b8'} strokeWidth={hot ? 2.5 : 1.75} markerEnd={`url(#wa-${hot ? 'h-' : ''}${s.key})`} style={{ pointerEvents: 'none' }} />
            </g>
          );
        })}
        {wire && wire.stageKey === s.key && (
          <path d={`M ${wire.sx} ${wire.sy} C ${wire.sx} ${wire.sy + 30} ${wire.cx} ${wire.cy - 30} ${wire.cx} ${wire.cy}`} fill="none" stroke="#5A27E0" strokeWidth={2} strokeDasharray="5 4" markerEnd={`url(#wa-h-${s.key})`} />
        )}
      </svg>
    );
  };

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <style>{WF_CSS}</style>
      {note && (
        <div style={{ position: 'fixed', top: 74, left: '50%', transform: 'translateX(-50%)', zIndex: 60, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: 10, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, boxShadow: '0 8px 24px rgba(16,24,40,0.14)' }}>{note}</div>
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15, color: '#0f172a', flex: 1 }}>Case Flow</strong>
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
            <div className="wf-flow">
              {stages.map((s, i) => {
                const list = tasksByStage[s.key] ?? [];
                const isOpen = !!open[s.key];
                const color = stageColor(s.key);
                let w = 480, h = 130;
                for (const t of list) { const p = posOf(t); w = Math.max(w, p.x + PILL_W + PAD); h = Math.max(h, p.y + heightOf(t.id) + PAD + 14); }
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
                          <button className="wf-ic wf-del" onClick={() => removeStage(s.id)} title="Delete stage" aria-label="Delete stage">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                          </button>
                        </span>
                      </div>
                      {isOpen && (
                        <div className="wf-body">
                          {list.length === 0
                            ? <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', padding: '4px 0' }}>No tasks yet.</div>
                            : <div className="wf-canvas" style={{ width: w, height: h }}>
                                {list.map((t) => <Fragment key={t.id}>{taskBox(t)}</Fragment>)}
                                {arrows(s, list, w, h)}
                              </div>}
                          <div className="wf-addbar">
                            <button className="wf-add" onClick={() => addTask(s.key, 'TASK')}>+ task</button>
                            <button className="wf-add" style={{ color: '#0369a1', borderColor: '#bae6fd' }} onClick={() => addTask(s.key, 'EMAIL')}>+ ✉ email</button>
                            <button className="wf-add" style={{ color: '#b45309', borderColor: '#fde68a' }} onClick={() => addTask(s.key, 'DOC')}>+ 📄 document</button>
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

      {/* Selected-task editor — a floating panel so opening/closing it never reflows the flow. */}
      {sel && (
        <div style={{ ...card, position: 'fixed', right: 18, top: 92, width: 300, flex: 'none', maxHeight: '82vh', overflowY: 'auto', zIndex: 20, boxShadow: '0 12px 40px rgba(16,24,40,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 13, color: '#0f172a', flex: 1 }}>{sel.node_kind === 'EMAIL' ? '✉ Edit email' : sel.node_kind === 'DOC' ? '📄 Edit document' : 'Edit task'}</strong>
            <button onClick={() => deleteNode(sel.id)} style={{ ...btn, color: '#b91c1c', borderColor: '#fecaca', padding: '3px 8px' }}>Delete</button>
            <button onClick={() => setSelected(null)} title="Close" aria-label="Close" style={{ width: 26, height: 26, border: '1px solid #e2e8f0', background: '#fff', borderRadius: 7, cursor: 'pointer', color: '#64748b', fontSize: 13, lineHeight: 1 }}>✕</button>
          </div>
          <label style={lbl}>{sel.node_kind === 'EMAIL' ? 'Label' : sel.node_kind === 'DOC' ? 'Label' : 'Task'}</label>
          <textarea value={sel.detail} onChange={(e) => setTemplates((ts) => ts.map((x) => x.id === sel.id ? { ...x, detail: e.target.value } : x))} onBlur={() => saveNode(sel)} rows={2} style={{ ...input, resize: 'vertical' }} />
          <label style={lbl}>Stage</label>
          <select value={sel.stage} onChange={(e) => {
            const v = e.target.value; if (v === sel.stage) return;
            // Land it in a free slot in the destination and reveal that stage, so moving a
            // task never makes it vanish (into a collapsed stage or on top of another pill).
            const dest = tasksByStage[v] ?? [];
            const posY = dest.length ? Math.max(...dest.map((t) => t.pos_y)) + PILL_H + GAP_Y : PAD;
            const next = { ...sel, stage: v, pos_x: PAD, pos_y: posY };
            // Its arrows belonged to the old stage's flow — clear them so the UI matches the backend.
            const touching = edges.filter((e2) => e2.from_template_id === sel.id || e2.to_template_id === sel.id);
            touching.forEach((e2) => deleteEdge(e2.from_template_id, e2.to_template_id));
            setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x));
            setOpen((o) => ({ ...o, [v]: true }));
            saveNode(next);
            if (touching.length) setNote('Moved to a new stage — its previous dependencies were cleared.');
          }} style={input}>
            {stages.map((s) => <option key={s.id} value={s.key}>{s.name}</option>)}
          </select>

          <label style={lbl}>Runs after</label>
          {(() => {
            const prereqs = edges.filter((e) => e.to_template_id === sel.id).map((e) => byId(e.from_template_id)).filter((t): t is Template => !!t && t.stage === sel.stage);
            return prereqs.length ? (
              <>
                {prereqs.map((p) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155', background: '#f1f5f9', borderRadius: 7, padding: '4px 8px', marginBottom: 4 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.detail}</span>
                    <button onClick={() => deleteEdge(p.id, sel.id)} title="Remove — runs in parallel again" style={{ border: 'none', background: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </>
            ) : (
              <div style={{ fontSize: 11.5, color: '#94a3b8' }}>Runs in parallel. Drag from the dot under a task to this one to make it run after.</div>
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
              <label style={lbl}>Attach document (optional)</label>
              <select value={sel.doc_template_id ?? ''} onChange={(e) => { const v = e.target.value || null; const next = { ...sel, doc_template_id: v }; setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x)); saveNode(next); }} style={input}>
                <option value="">— none —</option>
                {docTemplates.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              {sel.doc_template_id && <p style={{ fontSize: 10.5, color: '#b45309', marginTop: 6 }}>The document is generated from the matter and attached to this email.</p>}
            </>
          )}
          {sel.node_kind === 'DOC' && (
            <>
              <label style={lbl}>Document template</label>
              <select value={sel.doc_template_id ?? ''} onChange={(e) => { const v = e.target.value || null; const next = { ...sel, doc_template_id: v }; setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x)); saveNode(next); }} style={input}>
                <option value="">— pick a template —</option>
                {docTemplates.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <p style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 6 }}>When this stage is reached (and any prerequisites are done), the template is filled from the matter and filed in its Case files.</p>
              {docTemplates.length === 0 && <p style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 6 }}>No document templates yet — add one in the Document templates area.</p>}
            </>
          )}
          {sel.node_kind !== 'EMAIL' && sel.node_kind !== 'DOC' && <>
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

// Shared POST body for a task template (create/update/reposition).
function templateBody(t: Template) {
  return {
    id: t.id, stage: t.stage, detail: t.detail, assigneeKind: t.assignee_kind,
    assigneeRole: t.assignee_role, assigneeUserId: t.assignee_user_id, dueOffsetDays: t.due_offset_days,
    nodeKind: t.node_kind ?? 'TASK', emailTemplateId: t.email_template_id ?? null, sendMode: t.send_mode ?? null,
    docTemplateId: t.doc_template_id ?? null,
    posX: Math.round(t.pos_x), posY: Math.round(t.pos_y), active: t.active,
  };
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 12 };
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, margin: '10px 0 3px' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '6px 8px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' };
