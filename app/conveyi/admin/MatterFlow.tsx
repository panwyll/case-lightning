'use client';
import { useCallback, useEffect, useMemo, useState, Fragment } from 'react';

/**
 * A matter's live position on the firm's Case Flow — the same stage/task DAG the admin
 * designed, coloured by what has actually happened on THIS matter.
 *
 * Read-only by design: the editable canvas (WorkflowCanvas) is the template; this mirrors
 * status. The arrows are the point — a blocked task shows exactly what it's waiting on.
 */

type Api = <T = any>(path: string, options?: RequestInit) => Promise<T>;

const PILL_W = 230;
const PAD = 12;

interface Template { id: string; stage: string; detail: string; node_kind?: string | null; pos_x: number; pos_y: number; sort_order: number }
interface Edge { from_template_id: string; to_template_id: string }
interface Task { id: string; ref: string; detail: string; status: string; assignee: string | null; due: string | null; template_id: string | null; type: string }
interface FlowData {
  matter: { id: string; matterRef: string; propertyAddress: string | null; stage: string | null };
  stages: Array<{ key: string; name: string; sort_order: number }>;
  stageIndex: number;
  templates: Template[];
  edges: Edge[];
  byTemplate: Record<string, Task>;
  offFlow: Task[];
}

type NodeState = 'done' | 'open' | 'blocked' | 'pending';

const LOOK: Record<NodeState, { border: string; bg: string; text: string; dot: string; label: string }> = {
  done:    { border: '#86efac', bg: '#f0fdf4', text: '#14532d', dot: '#16a34a', label: 'Done' },
  open:    { border: '#fcd34d', bg: '#fffbeb', text: '#78350f', dot: '#f59e0b', label: 'To do' },
  blocked: { border: '#cbd5e1', bg: '#f8fafc', text: '#475569', dot: '#94a3b8', label: 'Blocked' },
  pending: { border: '#e8eaf0', bg: '#fff',    text: '#94a3b8', dot: '#e2e8f0', label: 'Not started' },
};

const CSS = `
.mf-flow{display:flex;flex-direction:column;align-items:center}
.mf-stage{width:100%;max-width:820px;background:#fff;border:1px solid #e6e8ee;border-left-width:4px;border-radius:12px;box-shadow:0 1px 3px rgba(16,24,40,.06)}
.mf-hd{display:flex;align-items:center;gap:10px;padding:10px 13px;cursor:pointer}
.mf-nm{font-size:14px;font-weight:700;color:#0f172a;flex:1}
.mf-meta{font-size:11.5px;color:#94a3b8;white-space:nowrap}
.mf-chev{width:20px;text-align:center;color:#334155;font-size:18px;transition:transform .12s}
.mf-chev.open{transform:rotate(90deg)}
.mf-body{border-top:1px solid #eef2f7;background:#fafbfc;padding:16px;overflow:auto}
.mf-canvas{position:relative}
.mf-arrows{position:absolute;top:0;left:0;pointer-events:none;overflow:visible;z-index:1}
.mf-task{position:absolute;width:230px;box-sizing:border-box;border-radius:9px;padding:8px 10px;z-index:2;border:1px solid}
.mf-t{font-size:12.5px;font-weight:600;line-height:1.3;word-break:break-word}
.mf-m{font-size:10.5px;margin-top:3px;opacity:.85}
.mf-conn{width:2px;height:22px;background:#c3cbd6;position:relative}
.mf-conn::after{content:'';position:absolute;bottom:-1px;left:50%;transform:translateX(-50%);border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid #c3cbd6}
.mf-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:800;border-radius:99px;padding:1px 7px}
`;

export default function MatterFlow({ matterId, api }: { matterId: string; api: Api }) {
  const [data, setData] = useState<FlowData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [touched, setTouched] = useState(false); // has the user overridden the auto-expand?

  useEffect(() => {
    let dead = false;
    api<FlowData>(`/matters/${matterId}/flow`)
      .then((d) => { if (!dead) { setData(d); setErr(null); } })
      .catch((e: any) => { if (!dead) setErr(e?.message || 'Could not load the flow.'); });
    return () => { dead = true; };
  }, [api, matterId]);

  const stateOf = useCallback((t: Template, byTemplate: Record<string, Task>): NodeState => {
    const task = byTemplate[t.id];
    if (!task) return 'pending';
    if (task.status === 'DONE') return 'done';
    if (task.status === 'BLOCKED') return 'blocked';
    return 'open';
  }, []);

  // Group templates by stage, and work out each stage's progress.
  const stages = useMemo(() => {
    if (!data) return [];
    return data.stages.map((s) => {
      const list = data.templates.filter((t) => t.stage === s.key);
      const states = list.map((t) => stateOf(t, data.byTemplate));
      const done = states.filter((x) => x === 'done').length;
      const live = states.some((x) => x === 'open' || x === 'blocked');
      return { ...s, list, states, done, total: list.length, live };
    });
  }, [data, stateOf]);

  // Expand the stage the matter is actually on (and any stage with live work);
  // completed and not-yet-reached stages stay folded so a late matter isn't a wall of green.
  useEffect(() => {
    if (!data || touched || !stages.length) return;
    const next: Record<string, boolean> = {};
    for (const s of stages) if (s.live || s.key === data.matter.stage) next[s.key] = true;
    if (!Object.keys(next).length) { const first = stages.find((s) => s.total > 0); if (first) next[first.key] = true; }
    setOpen(next);
  }, [data, stages, touched]);

  // Measure pill heights so arrows meet the boxes even when a title wraps.
  useEffect(() => {
    const next: Record<string, number> = {};
    document.querySelectorAll<HTMLElement>('.mf-task[data-tid]').forEach((el) => { next[el.getAttribute('data-tid')!] = el.offsetHeight; });
    setHeights((prev) => {
      const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
      for (const k of keys) if (prev[k] !== next[k]) return next;
      return prev;
    });
  }, [data, open, stages]);

  if (err) return <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', fontSize: 13 }}>{err}</div>;
  if (!data) return <div style={{ ...card, color: '#94a3b8', fontSize: 13 }}>Loading the flow…</div>;
  if (!data.templates.length) {
    return <div style={{ ...card, color: '#64748b', fontSize: 13 }}>No Case Flow configured yet — an admin can set one up in Case Flow.</div>;
  }

  const heightOf = (id: string) => heights[id] ?? 58;
  const prereqsOf = (id: string) => data.edges.filter((e) => e.to_template_id === id).map((e) => e.from_template_id);
  const detailOf = (t: Template) => data.byTemplate[t.id]?.detail || t.detail;

  return (
    <div>
      <style>{CSS}</style>
      <div className="mf-flow">
        {stages.map((s, i) => {
          const isOpen = !!open[s.key];
          const isCurrent = data.matter.stage === s.key;
          const colour = s.total === 0 ? '#e2e8f0' : s.done === s.total ? '#16a34a' : s.live ? '#f59e0b' : '#cbd5e1';
          let w = 460, h = 120;
          for (const t of s.list) { w = Math.max(w, t.pos_x + PILL_W + PAD); h = Math.max(h, t.pos_y + heightOf(t.id) + PAD); }
          return (
            <Fragment key={s.key}>
              <div className="mf-stage" style={{ borderLeftColor: colour, ...(isCurrent ? { boxShadow: '0 0 0 2px #ddd6fe' } : {}) }}>
                <div className="mf-hd" onClick={() => { setTouched(true); setOpen((o) => ({ ...o, [s.key]: !o[s.key] })); }}>
                  <span className={`mf-chev${isOpen ? ' open' : ''}`}>▸</span>
                  <span className="mf-nm">{s.name}</span>
                  {isCurrent && <span className="mf-badge" style={{ background: '#EDE7FB', color: '#5A27E0' }}>Current</span>}
                  <span className="mf-meta">{s.total ? `${s.done}/${s.total} done` : 'no tasks'}</span>
                </div>
                {isOpen && s.total > 0 && (
                  <div className="mf-body">
                    <div className="mf-canvas" style={{ width: w, height: h }}>
                      {s.list.map((t) => {
                        const st = stateOf(t, data.byTemplate);
                        const look = LOOK[st];
                        const task = data.byTemplate[t.id];
                        const waiting = st === 'blocked'
                          ? prereqsOf(t.id)
                              .filter((p) => data.byTemplate[p]?.status !== 'DONE')
                              .map((p) => data.templates.find((x) => x.id === p)?.detail)
                              .filter(Boolean)
                          : [];
                        return (
                          <div
                            key={t.id}
                            data-tid={t.id}
                            className="mf-task"
                            style={{ left: t.pos_x, top: t.pos_y, borderColor: look.border, background: look.bg, color: look.text, ...(st === 'blocked' ? { borderStyle: 'dashed' } : {}) }}
                            title={waiting.length ? `Waiting on: ${waiting.join(', ')}` : look.label}
                          >
                            <div className="mf-t">
                              <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 99, background: look.dot, marginRight: 6, verticalAlign: 'middle' }} />
                              {t.node_kind === 'EMAIL' ? '✉ ' : t.node_kind === 'DOC' ? '📄 ' : ''}{detailOf(t)}
                            </div>
                            <div className="mf-m">
                              {st === 'blocked' && waiting.length
                                ? `Waiting on ${waiting.length === 1 ? waiting[0] : `${waiting.length} tasks`}`
                                : st === 'pending'
                                  ? 'Not started'
                                  : `${look.label}${task?.assignee ? ` · ${task.assignee}` : ''}${task?.due ? ` · due ${String(task.due).slice(0, 10)}` : ''}`}
                            </div>
                          </div>
                        );
                      })}
                      <svg className="mf-arrows" width={w} height={h}>
                        <defs>
                          <marker id={`mfa-${s.key}`} markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#94a3b8" /></marker>
                          <marker id={`mfa-done-${s.key}`} markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#86efac" /></marker>
                        </defs>
                        {data.edges
                          .filter((e) => s.list.some((t) => t.id === e.from_template_id) && s.list.some((t) => t.id === e.to_template_id))
                          .map((e) => {
                            const a = s.list.find((t) => t.id === e.from_template_id)!;
                            const b = s.list.find((t) => t.id === e.to_template_id)!;
                            const x1 = a.pos_x + PILL_W / 2, y1 = a.pos_y + heightOf(a.id), x2 = b.pos_x + PILL_W / 2, y2 = b.pos_y;
                            const dy = Math.max(18, Math.abs(y2 - y1) * 0.4);
                            // A satisfied prerequisite is drawn green, so the completed
                            // path through the matter reads at a glance.
                            const satisfied = data.byTemplate[a.id]?.status === 'DONE';
                            return (
                              <path
                                key={`${e.from_template_id}-${e.to_template_id}`}
                                d={`M ${x1} ${y1} C ${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`}
                                fill="none"
                                stroke={satisfied ? '#86efac' : '#cbd5e1'}
                                strokeWidth={1.75}
                                strokeDasharray={satisfied ? undefined : '5 4'}
                                markerEnd={`url(#mfa-${satisfied ? 'done-' : ''}${s.key})`}
                              />
                            );
                          })}
                      </svg>
                    </div>
                  </div>
                )}
              </div>
              {i < stages.length - 1 && <div className="mf-conn" />}
            </Fragment>
          );
        })}
      </div>

      {data.offFlow.length > 0 && (
        <div style={{ ...card, marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6 }}>
            Not on the flow · {data.offFlow.length}
          </div>
          {data.offFlow.map((t) => (
            <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: '#334155', padding: '3px 0' }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: t.status === 'DONE' ? '#16a34a' : '#f59e0b', flex: 'none' }} />
              <span style={{ flex: 1, textDecoration: t.status === 'DONE' ? 'line-through' : 'none', opacity: t.status === 'DONE' ? 0.6 : 1 }}>{t.detail}</span>
              <span style={{ fontSize: 10.5, color: '#94a3b8' }}>{t.assignee || ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 12 };
