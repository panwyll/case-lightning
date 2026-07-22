'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  BaseEdge, getBezierPath, EdgeLabelRenderer, MarkerType, useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

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
    const detail = Array.isArray(json.details) ? json.details.map((d: any) => `${(d.path || []).join('.')}: ${d.message}`).join('; ') : '';
    throw new Error([json.error || `HTTP ${res.status}`, detail].filter(Boolean).join(' — '));
  }
  return json as T;
}

const STAGE_COLORS = ['#6366f1', '#8b5cf6', '#0ea5e9', '#14b8a6', '#f59e0b', '#16a34a', '#64748b', '#ec4899', '#0891b2', '#a855f7'];
const ROLES = ['OWNER', 'CONVEYANCER', 'ASSISTANT', 'ADMIN'];
interface Stage { id: string; key: string; name: string; sort_order: number; active: boolean }
interface Template { id: string; stage: string; detail: string; type: string; node_kind?: 'TASK' | 'EMAIL'; email_template_id?: string | null; send_mode?: 'DRAFT' | 'SEND' | null; assignee_kind: 'ROLE' | 'USER'; assignee_role: string | null; assignee_user_id: string | null; due_offset_days: number | null; pos_x: number; pos_y: number; sort_order: number; active: boolean }
interface Edge { from_template_id: string; to_template_id: string }
interface Member { id: string; name: string; role: string }

const NODE_W = 220, NODE_H = 62, GAP_X = 44, GAP_Y = 52, STAGE_HEADER = 42, STAGE_PAD = 22, STAGE_GAP = 46;

// ── Custom nodes / edges ──────────────────────────────────────────────────────
function TaskNode({ data, selected }: any) {
  return (
    <div style={{ width: NODE_W, minHeight: NODE_H, background: '#fff', border: `1.5px solid ${selected ? '#5A27E0' : '#dfe3ea'}`, borderRadius: 10, boxShadow: selected ? '0 2px 12px rgba(90,39,224,0.22)' : '0 1px 3px rgba(16,24,40,0.08)', padding: '9px 12px', opacity: data.active ? 1 : 0.5 }}>
      <Handle type="target" position={Position.Top} style={{ width: 9, height: 9, background: '#cbd5e1', border: '2px solid #fff' }} />
      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1e293b', lineHeight: 1.3 }}>
        {data.email && <span style={{ fontSize: 9, fontWeight: 800, color: '#0ea5e9', marginRight: 5 }}>✉</span>}{data.detail}
      </div>
      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>{data.meta}</div>
      <Handle type="source" position={Position.Bottom} style={{ width: 11, height: 11, background: '#5A27E0', border: '2px solid #fff' }} />
    </div>
  );
}
function StageNode({ data }: any) {
  return (
    <div style={{ width: '100%', height: '100%', background: 'rgba(255,255,255,0.55)', border: `1px solid #e6e8ee`, borderLeft: `4px solid ${data.color}`, borderRadius: 14, boxShadow: '0 1px 3px rgba(16,24,40,0.05)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px' }}>
        <button className="nodrag nopan" onClick={(e) => { e.stopPropagation(); data.onToggle(); }} title={data.collapsed ? 'Expand' : 'Collapse'}
          style={{ width: 22, height: 22, border: 'none', background: 'none', color: '#475569', fontSize: 18, lineHeight: 1, cursor: 'pointer', transform: data.collapsed ? 'none' : 'rotate(90deg)', transition: 'transform .12s' }}>▸</button>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: data.color, flex: 'none' }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{data.name}</span>
        <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{data.count} task{data.count === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}
function DepEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: any) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: '#94a3b8', strokeWidth: 1.75 }} />
      <EdgeLabelRenderer>
        <button
          className="wf-edgebtn"
          style={{ position: 'absolute', transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, pointerEvents: 'all' }}
          onClick={(e) => { e.stopPropagation(); data?.onDelete?.(); }}
          title="Remove this dependency (both run in parallel again)"
        >×</button>
      </EdgeLabelRenderer>
    </>
  );
}
const nodeTypes = { task: TaskNode, stage: StageNode };
const edgeTypes = { dep: DepEdge };

function CaseFlowInner() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [users, setUsers] = useState<Member[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<Array<{ id: string; name: string; subject_template: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapse = useCallback((key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] })), []);
  const [note, setNoteRaw] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setNote = (m: string) => { setNoteRaw(m); if (noteTimer.current) clearTimeout(noteTimer.current); noteTimer.current = setTimeout(() => setNoteRaw(null), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ templates: Template[]; edges: Edge[]; users: Member[]; emailTemplates: any[] }>('/admin/workflow');
      setTemplates(r.templates ?? []); setEdges(r.edges ?? []); setUsers(r.users ?? []); setEmailTemplates(r.emailTemplates ?? []);
      try { setStages((await api<{ stages: Stage[] }>('/admin/stages')).stages ?? []); } catch { /* optional */ }
      setErr(null);
    } catch (e: any) { setErr(e?.message || 'Could not load the workflow. Has migration 039 been run?'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const byId = (id: string) => templates.find((t) => t.id === id) || null;
  const sel = selected ? byId(selected) : null;
  const stageColor = useCallback((key: string) => { const i = stages.findIndex((s) => s.key === key); return STAGE_COLORS[(i < 0 ? 0 : i) % STAGE_COLORS.length]; }, [stages]);
  const assigneeText = useCallback((t: Template) => t.assignee_kind === 'USER' ? users.find((u) => u.id === t.assignee_user_id)?.name ?? 'a person' : t.assignee_role === 'OWNER' ? 'Matter owner' : (t.assignee_role ?? '').charAt(0) + (t.assignee_role ?? '').slice(1).toLowerCase(), [users]);

  const tasksByStage = useMemo(() => {
    const m: Record<string, Template[]> = {};
    for (const t of templates) (m[t.stage] ??= []).push(t);
    for (const k of Object.keys(m)) m[k].sort((a, b) => (a.pos_y - b.pos_y) || (a.sort_order - b.sort_order));
    return m;
  }, [templates]);
  const stageLevels = useCallback((key: string): Template[][] => {
    const list = tasksByStage[key] ?? [];
    const inStage = new Set(list.map((t) => t.id));
    const prereqs: Record<string, string[]> = {};
    for (const e of edges) if (inStage.has(e.from_template_id) && inStage.has(e.to_template_id)) (prereqs[e.to_template_id] ??= []).push(e.from_template_id);
    const memo: Record<string, number> = {};
    const calc = (id: string, stack: Set<string>): number => { if (memo[id] != null) return memo[id]; let lv = 0; for (const p of prereqs[id] ?? []) if (!stack.has(p)) lv = Math.max(lv, calc(p, new Set([...stack, id])) + 1); return (memo[id] = lv); };
    const maxLv = list.reduce((mx, t) => Math.max(mx, calc(t.id, new Set())), 0);
    const levels: Template[][] = Array.from({ length: maxLv + 1 }, () => []);
    for (const t of list) levels[memo[t.id]].push(t);
    return levels;
  }, [tasksByStage, edges]);

  // ── Mutations ───────────────────────────────────────────────────────────────
  const reaches = (a: string, b: string, es: Edge[]) => { const seen = new Set<string>(); const st = [a]; while (st.length) { const n = st.pop()!; if (n === b) return true; if (seen.has(n)) continue; seen.add(n); for (const e of es) if (e.from_template_id === n) st.push(e.to_template_id); } return false; };
  const addPrereq = async (from: string, to: string) => {
    if (from === to) return;
    if (byId(from)?.stage !== byId(to)?.stage) { setNote('Tasks can only depend on others in the same stage.'); return; }
    if (edges.some((e) => e.from_template_id === from && e.to_template_id === to)) return;
    if (reaches(to, from, edges)) { setNote('Those two already run in that order — they can’t depend on each other both ways.'); return; }
    setEdges((es) => [...es, { from_template_id: from, to_template_id: to }]);
    try { await api('/admin/workflow/edges', { method: 'POST', body: JSON.stringify({ from, to }) }); }
    catch (e: any) { setEdges((es) => es.filter((x) => !(x.from_template_id === from && x.to_template_id === to))); setNote(e?.message || 'Couldn’t link those.'); }
  };
  const deleteEdge = async (from: string, to: string) => { setEdges((es) => es.filter((e) => !(e.from_template_id === from && e.to_template_id === to))); await api(`/admin/workflow/edges?from=${from}&to=${to}`, { method: 'DELETE' }).catch(() => {}); };
  const addTask = async (stageKey: string, nodeKind: 'TASK' | 'EMAIL' = 'TASK') => {
    try {
      const body: any = { stage: stageKey, assigneeKind: 'ROLE', assigneeRole: 'OWNER', posX: 0, posY: (tasksByStage[stageKey]?.length ?? 0) * 10 };
      if (nodeKind === 'EMAIL') { body.detail = 'Send email'; body.nodeKind = 'EMAIL'; body.sendMode = 'DRAFT'; body.emailTemplateId = emailTemplates[0]?.id ?? null; } else body.detail = 'New task';
      const r = await api<{ template: Template }>('/admin/workflow', { method: 'POST', body: JSON.stringify(body) });
      setTemplates((ts) => [...ts, r.template]); setSelected(r.template.id);
    } catch (e: any) { setNote(e?.message || 'Could not add.'); }
  };
  const saveNode = async (t: Template) => {
    try {
      const r = await api<{ template: Template }>('/admin/workflow', { method: 'POST', body: JSON.stringify({ id: t.id, stage: t.stage, detail: t.detail, assigneeKind: t.assignee_kind, assigneeRole: t.assignee_role, assigneeUserId: t.assignee_user_id, dueOffsetDays: t.due_offset_days, nodeKind: t.node_kind ?? 'TASK', emailTemplateId: t.email_template_id ?? null, sendMode: t.send_mode ?? null, posX: Math.round(t.pos_x), posY: Math.round(t.pos_y), active: t.active }) });
      setTemplates((ts) => ts.map((x) => (x.id === t.id ? r.template : x)));
    } catch (e: any) { setNote(e?.message || 'Could not save.'); }
  };
  const deleteNode = async (id: string) => { if (!window.confirm('Delete this task and its dependencies?')) return; try { await api(`/admin/workflow?id=${id}`, { method: 'DELETE' }); setTemplates((ts) => ts.filter((t) => t.id !== id)); setEdges((es) => es.filter((e) => e.from_template_id !== id && e.to_template_id !== id)); setSelected(null); } catch (e: any) { setNote(e?.message || 'Could not delete.'); } };
  const addStage = async () => { try { await api('/admin/stages', { method: 'POST', body: JSON.stringify({ name: 'New stage', sortOrder: stages.length }) }); await load(); } catch (e: any) { setNote(e?.message || 'Could not add stage.'); } };
  const saveStageName = async (s: Stage) => { try { await api('/admin/stages', { method: 'POST', body: JSON.stringify({ id: s.id, name: s.name, sortOrder: s.sort_order, active: s.active }) }); } catch (e: any) { setNote(e?.message || 'Could not save stage.'); } };

  // ── Layout → React Flow nodes ────────────────────────────────────────────────
  // Positions come from the task's stored pos_x/pos_y (persisted on drag) when set,
  // otherwise a tidy dependency-level default. Groups auto-size to fit; collapsed
  // stages shrink to just their header.
  const computeNodes = useCallback(() => {
    const nodes: any[] = [];
    let y = 0;
    for (const s of stages) {
      const isCol = !!collapsed[s.key];
      const list = tasksByStage[s.key] ?? [];
      const levels = stageLevels(s.key);
      const levelPos: Record<string, { x: number; y: number }> = {};
      levels.forEach((lvl, li) => lvl.forEach((t, ti) => { levelPos[t.id] = { x: ti * (NODE_W + GAP_X), y: li * (NODE_H + GAP_Y) }; }));
      const taskPos = (t: Template) => (t.pos_x || t.pos_y) ? { x: t.pos_x, y: t.pos_y } : (levelPos[t.id] || { x: 0, y: 0 });
      let contentW = NODE_W, contentH = NODE_H;
      if (!isCol) for (const t of list) { const p = taskPos(t); contentW = Math.max(contentW, p.x + NODE_W); contentH = Math.max(contentH, p.y + NODE_H); }
      const groupW = STAGE_PAD * 2 + contentW;
      const groupH = isCol ? STAGE_HEADER + 6 : STAGE_HEADER + STAGE_PAD * 2 + contentH;
      const gid = `stage-${s.key}`;
      nodes.push({ id: gid, type: 'stage', position: { x: 0, y }, data: { name: s.name, color: stageColor(s.key), count: list.length, collapsed: isCol, onToggle: () => toggleCollapse(s.key) }, draggable: false, selectable: false, style: { width: groupW, height: groupH, zIndex: 0 } });
      if (!isCol) for (const t of list) {
        const p = taskPos(t);
        nodes.push({
          id: t.id, type: 'task', parentId: gid, extent: 'parent', draggable: true,
          position: { x: STAGE_PAD + p.x, y: STAGE_HEADER + STAGE_PAD + p.y },
          data: { detail: t.detail, email: t.node_kind === 'EMAIL', active: t.active, meta: t.node_kind === 'EMAIL' ? `${emailTemplates.find((e) => e.id === t.email_template_id)?.name ?? 'no template'} · ${t.send_mode === 'SEND' ? '⚡ auto-send' : '✎ draft'}` : `→ ${assigneeText(t)}${t.due_offset_days != null ? ` · +${t.due_offset_days}d` : ''}` },
          selected: t.id === selected,
        });
      }
      y += groupH + STAGE_GAP;
    }
    return nodes;
  }, [stages, tasksByStage, stageLevels, emailTemplates, assigneeText, stageColor, selected, collapsed, toggleCollapse]);

  const [nodes, setNodes, onNodesChange] = useNodesState<any>([]);
  useEffect(() => { setNodes(computeNodes()); }, [computeNodes, setNodes]);

  const onNodeDragStop = useCallback((_e: any, node: any) => {
    if (node.type !== 'task') return;
    const px = Math.max(0, Math.round(node.position.x - STAGE_PAD));
    const py = Math.max(0, Math.round(node.position.y - STAGE_HEADER - STAGE_PAD));
    setTemplates((ts) => ts.map((t) => (t.id === node.id ? { ...t, pos_x: px, pos_y: py } : t)));
    api('/admin/workflow/positions', { method: 'POST', body: JSON.stringify({ positions: [{ id: node.id, x: px, y: py }] }) }).catch(() => {});
  }, []);

  const autoArrange = useCallback(() => {
    const updates: Array<{ id: string; x: number; y: number }> = [];
    for (const s of stages) {
      const levels = stageLevels(s.key);
      levels.forEach((lvl, li) => lvl.forEach((t, ti) => updates.push({ id: t.id, x: ti * (NODE_W + GAP_X), y: li * (NODE_H + GAP_Y) })));
    }
    setTemplates((ts) => ts.map((t) => { const u = updates.find((x) => x.id === t.id); return u ? { ...t, pos_x: u.x, pos_y: u.y } : t; }));
    api('/admin/workflow/positions', { method: 'POST', body: JSON.stringify({ positions: updates }) }).catch(() => {});
  }, [stages, stageLevels]);

  const rfEdges = useMemo(() => {
    const inSameStage = (a: string, b: string) => byId(a)?.stage && byId(a)?.stage === byId(b)?.stage;
    return edges.filter((e) => inSameStage(e.from_template_id, e.to_template_id)).map((e) => ({
      id: `${e.from_template_id}->${e.to_template_id}`, source: e.from_template_id, target: e.to_template_id, type: 'dep',
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8', width: 18, height: 18 },
      data: { onDelete: () => deleteEdge(e.from_template_id, e.to_template_id) },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, templates]);

  const onConnect = useCallback((c: any) => { if (c.source && c.target) void addPrereq(c.source, c.target); }, [edges, templates]); // eslint-disable-line react-hooks/exhaustive-deps
  const onNodeClick = useCallback((_e: any, node: any) => { if (node.type === 'task') setSelected(node.id); }, []);

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', position: 'relative' }}>
      <style>{`.wf-edgebtn{width:20px;height:20px;border-radius:50%;border:1px solid #e2e8f0;background:#fff;color:#94a3b8;font-size:13px;line-height:1;cursor:pointer;box-shadow:0 1px 3px rgba(16,24,40,.12);opacity:0;transition:opacity .1s}.react-flow__edge:hover .wf-edgebtn{opacity:1}.wf-edgebtn:hover{color:#b91c1c;border-color:#fecaca}`}</style>
      {note && <div style={{ position: 'fixed', top: 74, left: '50%', transform: 'translateX(-50%)', zIndex: 60, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: 10, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, boxShadow: '0 8px 24px rgba(16,24,40,0.14)' }}>{note}</div>}

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15, color: '#0f172a', flex: 1 }}>Case Flow</strong>
          <span style={{ fontSize: 11.5, color: '#94a3b8' }}>Drag tasks to arrange · drag a dot to link · click an arrow’s × to unlink</span>
          {stages.length > 0 && <button onClick={autoArrange} style={btn} title="Reset the layout to a tidy order">Auto-arrange</button>}
          {stages[0] && <button onClick={() => addTask(stages[0].key, 'TASK')} style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>+ Task</button>}
          <button onClick={addStage} style={btn}>+ Add stage</button>
        </div>
        {err && <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca' }}>{err}</div>}
        {loading && <div style={{ ...card, color: '#94a3b8', fontSize: 13 }}>Loading…</div>}
        {!loading && stages.length === 0 && templates.length === 0 && (
          <div style={{ ...card }}>
            <div style={{ marginBottom: 10, color: '#64748b', fontSize: 13 }}>No workflow yet.</div>
            <button onClick={async () => { try { await api('/admin/workflow/seed', { method: 'POST' }); await load(); } catch (e: any) { setErr(e?.message || 'Could not load defaults.'); } }} style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>Load the standard conveyancing flow</button>
          </div>
        )}
        {!loading && stages.length > 0 && (
          <div style={{ height: '74vh', border: '1px solid #e2e8f0', borderRadius: 12, background: '#F8FAFC', overflow: 'hidden' }}>
            <ReactFlow
              nodes={nodes} edges={rfEdges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
              onConnect={onConnect} onNodeClick={onNodeClick} onNodeDragStop={onNodeDragStop} onPaneClick={() => setSelected(null)}
              nodesConnectable elementsSelectable
              defaultViewport={{ x: 60, y: 28, zoom: 0.9 }} minZoom={0.3} maxZoom={1.6} proOptions={{ hideAttribution: true }}
            >
              <Background gap={22} color="#e6e9f0" />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeStrokeWidth={3} nodeColor={(n: any) => (n.type === 'stage' ? '#eef0f5' : '#a78bfa')} nodeBorderRadius={4} maskColor="rgba(90,39,224,0.08)" style={{ background: '#fff', border: '1px solid #e2e8f0' }} />
            </ReactFlow>
          </div>
        )}
      </div>

      {sel && (
        <div style={{ ...card, position: 'fixed', right: 18, top: 92, width: 300, flex: 'none', maxHeight: '82vh', overflowY: 'auto', zIndex: 20, boxShadow: '0 12px 40px rgba(16,24,40,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 13, color: '#0f172a', flex: 1 }}>{sel.node_kind === 'EMAIL' ? '✉ Edit email' : 'Edit task'}</strong>
            <button onClick={() => deleteNode(sel.id)} style={{ ...btn, color: '#b91c1c', borderColor: '#fecaca', padding: '3px 8px' }}>Delete</button>
            <button onClick={() => setSelected(null)} title="Close" aria-label="Close" style={{ width: 26, height: 26, border: '1px solid #e2e8f0', background: '#fff', borderRadius: 7, cursor: 'pointer', color: '#64748b', fontSize: 13, lineHeight: 1 }}>✕</button>
          </div>
          <label style={lbl}>{sel.node_kind === 'EMAIL' ? 'Label' : 'Task'}</label>
          <textarea value={sel.detail} onChange={(e) => setTemplates((ts) => ts.map((x) => x.id === sel.id ? { ...x, detail: e.target.value } : x))} onBlur={() => saveNode(sel)} rows={2} style={{ ...input, resize: 'vertical' }} />
          <label style={lbl}>Stage</label>
          <select value={sel.stage} onChange={(e) => { const v = e.target.value; setTemplates((ts) => ts.map((x) => x.id === sel.id ? { ...x, stage: v } : x)); saveNode({ ...sel, stage: v }); }} style={input}>
            {stages.map((s) => <option key={s.id} value={s.key}>{s.name}</option>)}
          </select>
          <label style={lbl}>Runs after</label>
          {(() => {
            const prereqs = edges.filter((e) => e.to_template_id === sel.id).map((e) => byId(e.from_template_id)).filter((t): t is Template => !!t && t.stage === sel.stage);
            return prereqs.length ? prereqs.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155', background: '#f1f5f9', borderRadius: 7, padding: '4px 8px', marginBottom: 4 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.detail}</span>
                <button onClick={() => deleteEdge(p.id, sel.id)} title="Remove — runs in parallel again" style={{ border: 'none', background: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
              </div>
            )) : <div style={{ fontSize: 11.5, color: '#94a3b8' }}>Runs in parallel. Drag from a task’s bottom dot to another to make it run after.</div>;
          })()}
          {sel.node_kind === 'EMAIL' && (<>
            <label style={lbl}>Email template</label>
            <select value={sel.email_template_id ?? ''} onChange={(e) => { const v = e.target.value || null; const next = { ...sel, email_template_id: v }; setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x)); saveNode(next); }} style={input}>
              <option value="">— pick a template —</option>{emailTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <label style={lbl}>When it fires</label>
            <select value={sel.send_mode ?? 'DRAFT'} onChange={(e) => { const v = e.target.value as 'DRAFT' | 'SEND'; const next = { ...sel, send_mode: v }; setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x)); saveNode(next); }} style={input}>
              <option value="DRAFT">Draft into the send queue (human sends)</option><option value="SEND">Auto-send (only if a client email is on file)</option>
            </select>
            {sel.send_mode === 'SEND' && <p style={{ fontSize: 10.5, color: '#b45309', marginTop: 6 }}>⚠ Auto-send fires a real client email with no review. Use only for safe boilerplate.</p>}
          </>)}
          {sel.node_kind !== 'EMAIL' && (<>
            <label style={lbl}>Assign to</label>
            <select value={sel.assignee_kind === 'USER' ? `u:${sel.assignee_user_id}` : `r:${sel.assignee_role}`} onChange={(e) => { const v = e.target.value; const next: Template = v.startsWith('u:') ? { ...sel, assignee_kind: 'USER', assignee_user_id: v.slice(2), assignee_role: null } : { ...sel, assignee_kind: 'ROLE', assignee_role: v.slice(2), assignee_user_id: null }; setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x)); saveNode(next); }} style={input}>
              <optgroup label="Role (auto-resolved)"><option value="r:OWNER">Matter owner</option>{ROLES.filter((r) => r !== 'OWNER').map((r) => <option key={r} value={`r:${r}`}>{r.charAt(0) + r.slice(1).toLowerCase()}</option>)}</optgroup>
              <optgroup label="Specific person">{users.map((u) => <option key={u.id} value={`u:${u.id}`}>{u.name}</option>)}</optgroup>
            </select>
            <label style={lbl}>Due (days after created, optional)</label>
            <input type="number" min={0} value={sel.due_offset_days ?? ''} placeholder="—" onChange={(e) => { const v = e.target.value === '' ? null : Math.max(0, parseInt(e.target.value, 10) || 0); setTemplates((ts) => ts.map((x) => x.id === sel.id ? { ...x, due_offset_days: v } : x)); }} onBlur={() => saveNode(sel)} style={input} />
          </>)}
          <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={sel.active} onChange={(e) => { const next = { ...sel, active: e.target.checked }; setTemplates((ts) => ts.map((x) => x.id === sel.id ? next : x)); saveNode(next); }} /> Active
          </label>
        </div>
      )}
    </div>
  );
}

export default function WorkflowCanvas() {
  return <ReactFlowProvider><CaseFlowInner /></ReactFlowProvider>;
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 12 };
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, margin: '10px 0 3px' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '6px 8px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' };
