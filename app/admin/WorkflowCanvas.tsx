'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';

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

/**
 * The workflow builder, as a stage tree.
 *
 * The conveyancing process is a pipeline of stages; each stage owns a set of tasks
 * with their own internal ordering. So the UI is a vertical accordion of stage blocks
 * (the pipeline, top→bottom), and expanding a block reveals its tasks as an indented
 * tree — a task nested under another "runs after" it (an intra-stage prerequisite).
 * Stage order sequences the stages; the tree sequences the tasks within one. Editing a
 * task (assignee, due, email, prerequisites) happens in the side panel.
 */
export default function WorkflowCanvas() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [users, setUsers] = useState<Member[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<Array<{ id: string; name: string; subject_template: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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

  // ── Tasks + intra-stage hierarchy ───────────────────────────────────────────
  const tasksByStage = useMemo(() => {
    const m: Record<string, Template[]> = {};
    for (const t of templates) (m[t.stage] ??= []).push(t);
    for (const k of Object.keys(m)) m[k].sort((a, b) => (a.pos_y - b.pos_y) || (a.sort_order - b.sort_order));
    return m;
  }, [templates]);

  // For a stage: which tasks are roots (no prerequisite *within this stage*) and the
  // children map (prerequisite → dependents), from edges whose both ends are in-stage.
  const stageTree = (key: string) => {
    const list = tasksByStage[key] ?? [];
    const inStage = new Set(list.map((t) => t.id));
    const childrenOf: Record<string, string[]> = {};
    const hasParent = new Set<string>();
    for (const e of edges) {
      if (inStage.has(e.from_template_id) && inStage.has(e.to_template_id)) {
        (childrenOf[e.from_template_id] ??= []).push(e.to_template_id);
        hasParent.add(e.to_template_id);
      }
    }
    const roots = list.filter((t) => !hasParent.has(t.id));
    return { list, childrenOf, roots };
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
      setCollapsed((c) => ({ ...c, [stageKey]: false }));
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

  // ── Stage CRUD (the pipeline itself) ────────────────────────────────────────
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

  // Render one task and its intra-stage dependents, indented.
  const renderTask = (t: Template, childrenOf: Record<string, string[]>, depth: number, seen: Set<string>): React.ReactNode => {
    if (seen.has(t.id)) return null;
    seen.add(t.id);
    const isSel = t.id === selected;
    const kids = (childrenOf[t.id] ?? []).map((cid) => byId(cid)).filter(Boolean) as Template[];
    return (
      <div key={t.id} style={{ marginLeft: depth ? 18 : 0, borderLeft: depth ? '1.5px solid #e2e8f0' : undefined, paddingLeft: depth ? 10 : 0 }}>
        <div
          onClick={() => setSelected(isSel ? null : t.id)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 9, cursor: 'pointer', marginBottom: 6,
            background: isSel ? '#EDE7FB' : '#fff', border: `1px solid ${isSel ? '#5A27E0' : '#e6e8ee'}`, opacity: t.active ? 1 : 0.5,
          }}>
          <span style={{ width: 8, height: 8, borderRadius: 3, background: stageColor(t.stage), flex: 'none' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
            {t.node_kind === 'EMAIL' && <span style={{ fontSize: 10, fontWeight: 800, color: '#0ea5e9', marginRight: 6 }}>✉ EMAIL</span>}
            {t.detail}
          </span>
          <span style={{ fontSize: 11, color: '#94a3b8', flex: 'none', whiteSpace: 'nowrap' }}>
            {t.node_kind === 'EMAIL'
              ? `${emailTemplates.find((e) => e.id === t.email_template_id)?.name ?? 'no template'} · ${t.send_mode === 'SEND' ? '⚡ auto-send' : '✎ draft'}`
              : `${assigneeText(t)}${t.due_offset_days != null ? ` · +${t.due_offset_days}d` : ''}`}
          </span>
        </div>
        {kids.length > 0 && kids.map((k) => renderTask(k, childrenOf, depth + 1, seen))}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      {/* Left: the stage pipeline */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15, color: '#0f172a' }}>Workflow</strong>
          <span style={{ fontSize: 12.5, color: '#64748b', flex: 1, minWidth: 200 }}>
            The pipeline of stages. Tasks in a stage are created &amp; assigned when a matter reaches it; nest a task under another to make it run after it.
          </span>
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

        {!loading && stages.map((s, i) => {
          const { list, childrenOf, roots } = stageTree(s.key);
          const isOpen = !collapsed[s.key];
          const emailCount = list.filter((t) => t.node_kind === 'EMAIL').length;
          const color = stageColor(s.key);
          return (
            <div key={s.id}>
              <div style={{ ...card, padding: 0, overflow: 'hidden', borderLeft: `4px solid ${color}` }}>
                {/* Stage header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
                  <button onClick={() => setCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))} title={isOpen ? 'Collapse' : 'Expand'} style={{ ...iconBtn, transform: isOpen ? 'rotate(90deg)' : 'none' }}>▸</button>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: color, flex: 'none' }} />
                  <input value={s.name} onChange={(e) => { const v = e.target.value; setStages((ss) => ss.map((x) => x.id === s.id ? { ...x, name: v } : x)); }} onBlur={() => saveStageName(s)} onClick={(e) => e.stopPropagation()}
                    style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', border: '1px solid transparent', borderRadius: 6, background: 'transparent', padding: '2px 4px', width: `${Math.max(10, s.name.length + 1)}ch`, minWidth: 90 }} />
                  <span style={{ fontSize: 11.5, color: '#94a3b8', flex: 1 }}>{list.length} task{list.length === 1 ? '' : 's'}{emailCount ? ` · ${emailCount} email` : ''}</span>
                  <button onClick={() => addTask(s.key, 'TASK')} style={{ ...btn, padding: '4px 9px', fontSize: 11.5 }}>+ Task</button>
                  <button onClick={() => addTask(s.key, 'EMAIL')} style={{ ...btn, padding: '4px 9px', fontSize: 11.5, color: '#0369a1', borderColor: '#bae6fd' }}>+ Email</button>
                  <button onClick={() => moveStage(i, -1)} disabled={i === 0} title="Move up" style={arrowBtn}>↑</button>
                  <button onClick={() => moveStage(i, 1)} disabled={i === stages.length - 1} title="Move down" style={arrowBtn}>↓</button>
                  <button onClick={() => removeStage(s.id)} title="Delete stage" style={{ ...arrowBtn, color: '#cbd5e1' }}>×</button>
                </div>
                {/* Stage body: the task tree */}
                {isOpen && (
                  <div style={{ padding: '2px 12px 12px', background: '#fafbfc', borderTop: '1px solid #eef2f7' }}>
                    {list.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: '#94a3b8', padding: '10px 2px' }}>No tasks in this stage yet — add one above.</div>
                    ) : (
                      (() => { const seen = new Set<string>(); return roots.map((t) => renderTask(t, childrenOf, 0, seen)); })()
                    )}
                  </div>
                )}
              </div>
              {/* Pipeline connector to the next stage */}
              {i < stages.length - 1 && <div style={{ textAlign: 'center', color: '#cbd5e1', fontSize: 14, lineHeight: '10px', height: 12 }}>↓</div>}
            </div>
          );
        })}
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

          {/* Runs after — intra-stage prerequisites */}
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
          <p style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 8 }}>Changes save automatically.</p>
        </div>
      )}
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 12 };
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' };
const iconBtn: React.CSSProperties = { border: 'none', background: 'none', color: '#64748b', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0, width: 16, transition: 'transform .12s' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, margin: '10px 0 3px' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '6px 8px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' };
const arrowBtn: React.CSSProperties = { border: 'none', background: 'none', color: '#64748b', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px' };
