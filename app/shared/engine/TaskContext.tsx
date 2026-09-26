'use client';
import { useState } from 'react';
import { fmtWhen } from './types';
import type { TaskContextView } from './types';

/**
 * The minimum a conveyancer needs on screen to do one task from cold: the case in a
 * strip of facts, the headline of the task, the questions to ask of the source, what
 * has already happened on this subject, what else on the case bears on it, and what
 * doing it unblocks. Checks tick locally so the eye can keep its place; nothing is saved.
 */
export const TASK_CONTEXT_CSS = `
.tc-facts{display:flex;flex-wrap:wrap;gap:6px 8px;margin:0 0 10px}
.tc-fact{display:inline-flex;align-items:baseline;gap:5px;border:1px solid #e6e8ee;background:#f8fafc;border-radius:8px;padding:3px 8px;font-size:12.5px;line-height:1.35;max-width:100%}
.tc-fact b{font-weight:700;color:#64748b;font-size:11px;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap}
.tc-fact span{color:#0f172a;font-weight:600;overflow-wrap:anywhere}
.tc-fact.hot{border-color:#fde68a;background:#fffbeb}
.tc-fact.hot span{color:#92400e}
.tc-head{font-size:14px;font-weight:800;margin:0 0 8px;line-height:1.4}
.tc-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:10px 18px;margin-top:10px}
@media (max-width:760px){.tc-grid{grid-template-columns:1fr}}
.tc-h{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#64748b;margin:0 0 5px}
.tc-checks{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.tc-checks label{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.4;cursor:pointer;color:#0f172a}
.tc-checks label.done{color:#94a3b8;text-decoration:line-through}
.tc-checks input{margin:3px 0 0;accent-color:#5A27E0;flex-shrink:0}
.tc-list{list-style:none;margin:0;padding:0;display:grid;gap:3px;font-size:12.5px;line-height:1.4}
.tc-list li{display:flex;gap:8px;align-items:baseline}
.tc-list time{color:#94a3b8;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:11.5px}
.tc-list li.warn{color:#92400e}
.tc-unblocks{margin-top:10px;font-size:12.5px;border-left:3px solid #5A27E0;padding:4px 10px;background:#faf8ff;color:#312e81;border-radius:0 8px 8px 0}
`;

const HOT = /^(Offer expires|Target exchange|Completion|Open issues|Arrears)$/;

export function TaskContextFacts({ ctx }: { ctx: TaskContextView }) {
  if (!ctx.facts.length) return null;
  return (
    <div className="tc-facts" aria-label="Case facts">
      {ctx.facts.map((f) => (
        <span key={f.k} className={`tc-fact${HOT.test(f.k) && /\(|issue|has passed|expired/.test(f.v) ? ' hot' : ''}`}><b>{f.k}</b><span>{f.v}</span></span>
      ))}
    </div>
  );
}

export function TaskContextBody({ ctx, headline = true }: { ctx: TaskContextView; headline?: boolean }) {
  const [done, setDone] = useState<Set<number>>(new Set());
  const toggle = (i: number) => setDone((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const hasSide = ctx.history.length > 0 || ctx.related.length > 0;
  return (
    <div className="tc">
      {headline && ctx.headline && <p className="tc-head">{ctx.headline}</p>}
      <div className="tc-grid" style={hasSide ? undefined : { gridTemplateColumns: '1fr' }}>
        {ctx.checks.length > 0 && (
          <div>
            <div className="tc-h">Check</div>
            <ul className="tc-checks">
              {ctx.checks.map((c, i) => (
                <li key={i}><label className={done.has(i) ? 'done' : ''}><input type="checkbox" checked={done.has(i)} onChange={() => toggle(i)} />{c}</label></li>
              ))}
            </ul>
          </div>
        )}
        {hasSide && (
          <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
            {ctx.related.length > 0 && (
              <div>
                <div className="tc-h">On This Case</div>
                <ul className="tc-list">{ctx.related.map((r, i) => <li key={i} className={/expire|passed|Also waiting/.test(r) ? 'warn' : ''}>{r}</li>)}</ul>
              </div>
            )}
            {ctx.history.length > 0 && (
              <div>
                <div className="tc-h">So Far</div>
                <ul className="tc-list">{ctx.history.map((h, i) => <li key={i}><time dateTime={h.at}>{fmtWhen(h.at)}</time><span>{h.what}</span></li>)}</ul>
              </div>
            )}
          </div>
        )}
      </div>
      {ctx.unblocks && <div className="tc-unblocks">{ctx.unblocks}</div>}
    </div>
  );
}
