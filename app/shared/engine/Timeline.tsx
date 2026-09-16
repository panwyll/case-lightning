'use client';
import { useMemo, useState } from 'react';
import { DECISION_EVENT_TYPES, KIND_LABEL, actorKind, pretty, type EngineEvent, type EngineState } from './types';

/**
 * Addendum 3 §3 — the timeline: every event on the matter, newest first. Plain events
 * are one muted line (time · type · actor) that expands to the raw payload; decision
 * events are cards (kind · first line of the summary · status badge) that open the
 * decision panel — resolved ones too, read-only.
 */
const firstLine = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').trim();
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function Timeline({ events, state, people = {} }: { events: EngineEvent[]; state: EngineState; people?: Record<string, string> }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const ordered = useMemo(() => [...events].sort((a, b) => b.seq - a.seq), [events]);
  const days = useMemo(() => {
    const out: Array<[string, EngineEvent[]]> = [];
    for (const e of ordered) {
      const k = dayKey(e.createdAt);
      if (!out.length || out[out.length - 1][0] !== k) out.push([k, []]);
      out[out.length - 1][1].push(e);
    }
    return out;
  }, [ordered]);
  const who = (a: string) => (a === 'system' ? 'engine' : a === 'ai' ? 'AI' : a === 'external' ? 'external' : (people[a] ?? 'handler'));

  if (!events.length) return <div className="eg-empty">No events yet.</div>;
  return (
    <div className="tl">
      {days.map(([day, list]) => (
        <div key={day}>
          <div className="tl-day">{day}</div>
          {list.map((e) => {
            const d = state.decisions[e.id];
            if (DECISION_EVENT_TYPES.has(e.type) && d) {
              const cls = d.kind === 'bank_details' ? ' bank' : d.kind === 'auto_clear' ? ' review' : '';
              const hidden = state.shadowMode;
              return (
                <a key={e.id} className={`eg-card tl-card ${d.status}${cls}${hidden ? ' hidden' : ''}`} href={`/decisions/${e.id}`}>
                  <div className="tl-card-top">
                    <span className="tl-kind">{KIND_LABEL[d.kind] ?? pretty(d.kind)}{d.subject ? ` · ${d.subject.replace(/^[a-z_]+:/, '')}` : ''}</span>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {hidden && <span className="eg-chip shadow">not surfaced</span>}
                      <span className={`eg-chip ${d.status === 'pending' ? 'pending' : d.status === 'actioned' ? 'ok' : 'info'}`}>{d.status}</span>
                    </span>
                  </div>
                  <div className="tl-first">{firstLine(d.summary)}</div>
                  <div className="tl-meta">{hhmm(e.createdAt)} · raised by {who(e.actor)}{d.resolvedBy ? ` · ${d.status} by ${who(d.resolvedBy)}` : ''}{e.confidenceScore != null ? ` · confidence ${Math.round(e.confidenceScore * 100)}%` : ''}</div>
                </a>
              );
            }
            const sup = e.type === 'action_suppressed';
            return (
              <div key={e.id}>
                <div className={`tl-ev${sup ? ' sup' : ''}`} onClick={() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))} title="Show the raw event">
                  <span className="t">{hhmm(e.createdAt)}</span>
                  <span className="ty">{pretty(e.type)}{sup ? ` — ${pretty(String((e.payload as { action?: string }).action ?? ''))} (not performed)` : ''}</span>
                  <span className="ac">{who(e.actor)} · {actorKind(e.actor)}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11 }}>#{e.seq}</span>
                </div>
                {open[e.id] && <pre className="tl-raw">{JSON.stringify({ id: e.id, seq: e.seq, type: e.type, actor: e.actor, createdAt: e.createdAt, sourceDocumentId: e.sourceDocumentId, confidenceScore: e.confidenceScore, payload: e.payload }, null, 2)}</pre>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
