'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Api, CaseHealth, WorkItem } from './types';

/**
 * Two read-only projections of the case model (docs/case-model.md §13), drawn from
 * /engine/graph and never edited by hand:
 *   Readiness — where are we, what is complete / blocked / at risk, why can't we exchange,
 *               what needs to happen next and who has the authority to say it has.
 *   Dependencies — gates ← requirements ← workstreams, with issues, decisions, waits and
 *               client decisions attached where they block, and issue chains drawn.
 */
export interface CaseModel {
  profile?: { type: string; label: string; side: string; hasExchange: boolean; stages: string[]; stageLabels: Record<string, string>; lifecycle: string[]; gates: string[]; counterparty: string };
  lifecycle: { id: string; label: string; stage: string };
  workstreams: Array<{ id: string; label: string; status: string; detail: string; openIssues: string[]; pendingDecisions: string[]; waits: Array<{ key: string; subject: string; sinceDays: number; chases: number }> }>;
  requirements: Array<{ id: string; label: string; gate: string; workstream: string | null; authority: string; humanConfirmationRequired: boolean; applies: boolean; advisory?: boolean; satisfied: boolean; satisfiedAt: string | null; blockedBy: Array<{ type: string; id: string; label: string }>; detail: string }>;
  gates: Record<string, { id: string; label: string; ready: boolean; unsatisfied: CaseModel['requirements']; satisfied: CaseModel['requirements']; machineBlockers: string[] }>;
  whyNotExchange: string[];
  nextActions: Array<{ what: string; who: string; unblocks: string; ref: { type: string; id: string }; urgency: string }>;
  /** Case intelligence (docs/caseload-ux.md §3). */
  health?: CaseHealth;
  waits?: Array<{ key: string; subject: string; openedAt: string; closedAt: string | null; chasesSentAt: string[]; escalations: Array<{ eventId: string; raisedAt: string; resolvedAt: string | null }> }>;
  work?: WorkItem[];
  graph: { lifecycle: string; nodes: Array<{ id: string; type: string; label: string; status: string; severity?: string; authority?: string; workstream?: string | null; detail?: string }>; edges: Array<{ from: string; to: string; type: string; label?: string }> };
}

const LIFECYCLE = ['instructed', 'pre_exchange', 'ready_to_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion', 'closed'];
const LC_LABEL: Record<string, string> = { instructed: 'Instructed', pre_exchange: 'Pre-exchange', ready_to_exchange: 'Ready to exchange', exchanged: 'Exchanged', pre_completion: 'Pre-completion', investigating: 'Investigating', ready_to_complete: 'Ready to complete', completed: 'Completed', post_completion: 'Post-completion', closed: 'Closed', aborted: 'Aborted' };
/** The gate the coarse lifecycle is working towards — the first gate of this type that is not yet ready, else the last. */
const currentGate = (m: CaseModel): string => {
  const gates = m.profile?.gates ?? ['exchange', 'completion', 'registration', 'close'];
  return gates.find((g) => m.gates[g] && !m.gates[g].ready) ?? gates[gates.length - 1];
};
const WS_CHIP: Record<string, string> = { complete: 'ok', blocked: 'bad', at_risk: 'hot', under_review: 'pending', awaiting: 'info', in_progress: 'info', not_started: 'muted', not_applicable: 'muted' };
const WS_TEXT: Record<string, string> = { complete: 'COMPLETE', blocked: 'BLOCKED', at_risk: 'AT RISK', under_review: 'UNDER REVIEW', awaiting: 'AWAITING', in_progress: 'IN PROGRESS', not_started: 'NOT STARTED', not_applicable: 'N/A' };
const WHO: Record<string, string> = { system: 'system (objective)', conveyancer: 'conveyancer', client: 'client', third_party: 'third party', seller_side: "seller's side", lender: 'lender', mlro: 'MLRO' };
const CSS = `
.cv .lc{display:flex;gap:4px;flex-wrap:wrap;margin:6px 0 14px}
.cv .lc span{padding:5px 10px;border-radius:999px;font-size:11.5px;font-weight:700;border:1px solid #e2e8f0;color:#94a3b8;background:#fff}
.cv .lc span.done{background:#f0fdf4;border-color:#86efac;color:#14532d}
.cv .lc span.now{background:#0f172a;border-color:#0f172a;color:#fff}
.cv .lc span.abort{background:#fee2e2;border-color:#fecaca;color:#7f1d1d}
.cv table{border-collapse:collapse;width:100%;font-size:12.5px;background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.cv th,.cv td{text-align:left;padding:7px 10px;border-top:1px solid #f1f5f9;vertical-align:top}
.cv th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#94a3b8;border-top:0;background:#fafafa}
.cv h3{font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#64748b;margin:18px 0 8px}
.cv .why{background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:10px 12px;font-size:13px}
.cv .why ol{margin:6px 0 0 18px;padding:0}
.cv .ready{background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:10px 12px;font-size:13px;color:#14532d}
.cv .eg-chip.info{background:#e0e7ff;color:#3730a3}
.cv .eg-chip.hot{background:#f59e0b;color:#fff}
.cv .auth{font-size:11px;color:#64748b}
.cv figure{margin:0;background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:10px;overflow-x:auto}
.cv figure svg{display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-width:900px}
.cv figcaption{font-size:12px;color:#64748b;margin-top:8px}
`;

export function CaseView({ matterId, api, view, model }: { matterId: string; api: Api; view: 'readiness' | 'dependencies'; model?: CaseModel | null }) {
  const [fetched, setFetched] = useState<CaseModel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (model) return; // the page already has it — don't fetch the same projection twice
    api<CaseModel>(`/matters/${matterId}/engine/graph`).then(setFetched).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the case model.'));
  }, [api, matterId, model]);
  const m = model ?? fetched;
  if (err) return <div className="eg-err">{err}</div>;
  if (!m) return <div style={{ color: '#94a3b8', fontSize: 13 }}>Building the case model…</div>;
  const spine = m.profile?.lifecycle ?? LIFECYCLE;
  const idx = spine.indexOf(m.lifecycle.id);
  return (
    <div className="cv">
      <style>{CSS}</style>
      <div className="lc">
        {m.lifecycle.id === 'aborted' && <span className="abort">Aborted</span>}
        {spine.map((l, i) => <span key={l} className={i < idx ? 'done' : i === idx ? 'now' : ''}>{LC_LABEL[l] ?? l}</span>)}
        {m.profile && <span style={{ border: 0, background: 'transparent', color: '#64748b', fontWeight: 500 }}>{m.profile.label}{m.profile.hasExchange ? '' : ' · no exchange'}</span>}
      </div>
      {view === 'readiness' ? <Readiness m={m} /> : <Dependencies m={m} />}
    </div>
  );
}

function Readiness({ m }: { m: CaseModel }) {
  const gateId = currentGate(m);
  const g = m.gates[gateId];
  return (
    <>
      <h3>Case health</h3>
      <table>
        <thead><tr><th>Workstream</th><th>Status</th><th>Detail</th><th>Waiting on</th></tr></thead>
        <tbody>
          {m.workstreams.filter((w) => w.status !== 'not_applicable').map((w) => (
            <tr key={w.id}>
              <td><b>{w.label}</b></td>
              <td><span className={`eg-chip ${WS_CHIP[w.status] ?? 'muted'}`}>{WS_TEXT[w.status] ?? w.status}</span></td>
              <td>{w.detail}{w.openIssues.length ? <div className="auth">issues: {w.openIssues.join(', ')}</div> : null}</td>
              <td>{w.waits.map((x) => <div key={`${x.key}:${x.subject}`}>{x.key.replace(/_/g, ' ')}{x.subject ? ` ${x.subject}` : ''} · {x.sinceDays}d · chased {x.chases}×</div>)}{w.pendingDecisions.length ? <div>{w.pendingDecisions.length} decision{w.pendingDecisions.length === 1 ? '' : 's'} pending</div> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>{g.label}</h3>
      {g.ready ? (
        <div className="ready"><b>{g.label}.</b> Every requirement is satisfied{g.machineBlockers.length ? ` · the machine still lists: ${g.machineBlockers.join('; ')}` : ''}.</div>
      ) : (
        <div className="why">
          <b>Not {g.label.toLowerCase()} because:</b>
          <ol>
            {g.unsatisfied.map((r) => (
              <li key={r.id}><b>{r.label}</b> <span className="auth">· authority: {WHO[r.authority] ?? r.authority}</span>
                {r.blockedBy.length ? <div style={{ fontSize: 12.5 }}>{r.blockedBy.map((b) => <div key={`${b.type}:${b.id}`}>↳ {b.label}</div>)}</div> : <div style={{ fontSize: 12.5 }}>↳ {r.detail || 'not yet'}</div>}
              </li>
            ))}
          </ol>
        </div>
      )}

      <h3>Requirements ({g.satisfied.length} of {g.satisfied.length + g.unsatisfied.length} satisfied)</h3>
      <table>
        <thead><tr><th>Requirement</th><th>Status</th><th>Who says so</th><th>Detail</th></tr></thead>
        <tbody>
          {m.requirements.filter((r) => r.gate === gateId && r.applies).map((r) => (
            <tr key={r.id}>
              <td><b>{r.label}</b>{r.advisory ? <span className="auth"> · advisory</span> : null}</td>
              <td><span className={`eg-chip ${r.satisfied ? 'ok' : r.advisory ? 'muted' : 'pending'}`}>{r.satisfied ? `satisfied${r.satisfiedAt ? ` ${r.satisfiedAt.slice(0, 10)}` : ''}` : 'open'}</span></td>
              <td>{WHO[r.authority] ?? r.authority}{r.humanConfirmationRequired ? <div className="auth">human confirmation required</div> : null}</td>
              <td>{r.satisfied ? r.detail : r.blockedBy.map((b) => b.label).join('; ') || r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>What needs to happen next</h3>
      {m.nextActions.length === 0 ? <div className="ready">Nothing outstanding for this gate.</div> : (
        <table>
          <thead><tr><th>Action</th><th>Who</th><th>Unblocks</th><th>Urgency</th></tr></thead>
          <tbody>{m.nextActions.map((a, i) => <tr key={i}><td>{a.what}</td><td>{WHO[a.who] ?? a.who}</td><td>{a.unblocks}</td><td><span className={`eg-chip ${a.urgency === 'critical' ? 'bad' : a.urgency === 'warning' ? 'pending' : 'muted'}`}>{a.urgency}</span></td></tr>)}</tbody>
        </table>
      )}
    </>
  );
}

/** Columns: gates · requirements · workstreams · what blocks (issues / decisions / waits / client). Issue chains drawn between issues. */
function Dependencies({ m }: { m: CaseModel }) {
  const layout = useMemo(() => {
    const nodes = m.graph.nodes;
    const gateId = currentGate(m);
    const reqs = nodes.filter((n) => n.type === 'requirement' && m.graph.edges.some((e) => e.type === 'REQUIRES' && e.from === `gate:${gateId}` && e.to === n.id));
    const blockers = nodes.filter((n) => (n.type === 'issue' && (n.status === 'open' || n.status === 'negotiating')) || n.type === 'decision' || n.type === 'wait' || n.type === 'client_decision');
    const wsIds = Array.from(new Set(reqs.map((r) => r.workstream).filter(Boolean))) as string[];
    const ws = nodes.filter((n) => n.type === 'workstream' && wsIds.includes(n.workstream ?? ''));
    const colX = [24, 230, 470, 700];
    const rowH = 34;
    const pos = new Map<string, { x: number; y: number; w: number }>();
    pos.set(`gate:${gateId}`, { x: colX[0], y: 40, w: 186 });
    reqs.forEach((r, i) => pos.set(r.id, { x: colX[1], y: 40 + i * rowH, w: 220 }));
    ws.forEach((w, i) => pos.set(w.id, { x: colX[2], y: 40 + i * rowH, w: 210 }));
    blockers.forEach((b, i) => pos.set(b.id, { x: colX[3], y: 40 + i * rowH, w: 456 }));
    const height = 60 + Math.max(reqs.length, ws.length, blockers.length, 1) * rowH;
    const edges = m.graph.edges.filter((e) => pos.has(e.from) && pos.has(e.to) && e.from !== e.to);
    return { gateId, reqs, ws, blockers, pos, height, edges, colX };
  }, [m]);
  const fill = (n: { type: string; status: string; severity?: string }) => (n.type === 'gate' ? (n.status === 'ready' ? '#dcfce7' : '#fee2e2') : n.type === 'requirement' ? (n.status === 'satisfied' ? '#dcfce7' : '#fef3c7') : n.type === 'workstream' ? (n.status === 'complete' ? '#dcfce7' : n.status === 'blocked' ? '#fee2e2' : '#f1f5f9') : n.type === 'issue' ? (n.severity === 'critical' ? '#fecaca' : '#fee2e2') : n.type === 'client_decision' ? '#ede9fe' : '#e0e7ff');
  const stroke = (t: string) => (t === 'BLOCKS' || t === 'THREATENS' ? '#b91c1c' : t === 'SATISFIES' ? '#15803d' : t === 'DISCOVERED_BY' ? '#7c3aed' : '#94a3b8');
  const short = (s: string, n = 44) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const all = [...layout.reqs, ...layout.ws, ...layout.blockers, ...m.graph.nodes.filter((n) => n.id === `gate:${layout.gateId}`)];
  return (
    <>
      <h3>Flow / dependency view — {m.gates[layout.gateId].label}</h3>
      <figure>
        <svg role="img" aria-label="Gate, its requirements, the workstreams that satisfy them, and what blocks them" viewBox={`0 0 1180 ${layout.height}`} width="100%" style={{ height: "auto" }}>
          <defs><marker id="cv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor" /></marker></defs>
          {['Gate', 'Requirements', 'Workstreams', 'Blocking: issues · decisions · waits · client'].map((t, i) => <text key={t} x={layout.colX[i]} y={22} fontSize="11" fontWeight="700" fill="#94a3b8" letterSpacing=".05em">{t.toUpperCase()}</text>)}
          {layout.edges.map((e, i) => {
            const a = layout.pos.get(e.from)!;
            const b = layout.pos.get(e.to)!;
            const leftToRight = a.x < b.x;
            const x1 = leftToRight ? a.x + a.w : a.x;
            const x2 = leftToRight ? b.x : b.x + b.w;
            const y1 = a.y + 12;
            const y2 = b.y + 12;
            const c = (x1 + x2) / 2;
            return <path key={i} d={`M${x1} ${y1} C ${c} ${y1}, ${c} ${y2}, ${x2} ${y2}`} fill="none" stroke={stroke(e.type)} strokeWidth={e.type === 'BLOCKS' || e.type === 'THREATENS' ? 1.6 : 1} strokeDasharray={e.type === 'RELATES_TO' || e.type === 'REQUIRES' ? '3 3' : undefined} markerEnd="url(#cv-arrow)" color={stroke(e.type)} />;
          })}
          {all.map((n) => {
            const p = layout.pos.get(n.id)!;
            return (
              <g key={n.id}>
                <rect x={p.x} y={p.y} width={p.w} height={24} rx={7} fill={fill(n)} stroke="#cbd5e1" />
                <text x={p.x + 8} y={p.y + 16} fontSize="11.5" fill="#0f172a">{short(n.label.replace(/^ISS-\d+ /, (m0) => m0), Math.floor(p.w / 6.4))}</text>
                {n.authority && <title>{`${n.label} — authority: ${n.authority}`}</title>}
              </g>
            );
          })}
        </svg>
        <figcaption>Red arrows: blocks / threatens. Green: satisfies. Purple: discovered while dealing with (issue chains). Dotted: requires / relates to. Hover a node for its authority. Drawn from the same state the machine enforces; nothing here is edited by hand.</figcaption>
      </figure>
      <h3>Issue chains</h3>
      {m.graph.edges.filter((e) => e.type === 'DISCOVERED_BY').length === 0 ? <div style={{ fontSize: 12.5, color: '#64748b' }}>No issue was discovered while dealing with another.</div> : (
        <ul style={{ fontSize: 12.5, margin: 0, paddingLeft: 18 }}>
          {m.graph.edges.filter((e) => e.type === 'DISCOVERED_BY').map((e, i) => <li key={i}>{m.graph.nodes.find((n) => n.id === e.to)?.label} → {m.graph.nodes.find((n) => n.id === e.from)?.label}{e.label ? ` (${e.label.replace(/_/g, ' ')})` : ''}</li>)}
        </ul>
      )}
    </>
  );
}
