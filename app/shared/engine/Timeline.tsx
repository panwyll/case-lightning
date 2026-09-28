'use client';
import { useMemo, useState } from 'react';
import { Grouped, ListToolbar, useListTools, whenIn, type Filter } from './ListTools';
import { DECISION_EVENT_TYPES, KIND_LABEL, actorKind, pretty, type EngineEvent, type EngineState } from './types';

/**
 * Addendum 3 §3 — the timeline: every event on the matter, newest first. Plain events
 * are one muted line (time · type · actor) that expands to the raw payload; decision
 * events are cards (kind · first line of the summary · status badge) that open the
 * decision panel — resolved ones too, read-only.
 */
const firstLine = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').trim();

/** One line for an issue-layer event: which issue, and what happened to it. */
function issueLabel(e: EngineEvent, state: EngineState): string | null {
  const p = e.payload as Record<string, unknown>;
  if (e.type === 'price_changed') return `£${(Number(p.toPennies) / 100).toLocaleString('en-GB')}${p.fromPennies != null ? ` (was £${(Number(p.fromPennies) / 100).toLocaleString('en-GB')})` : ''} · ${String(p.reason ?? '')}`;
  if (!e.type.startsWith('issue_')) return null;
  const id = String(p.issueId ?? '');
  const i = state.issues?.[id];
  const head = i ? `${id} ${pretty(i.kind)}: ${i.title}` : id;
  if (e.type === 'issue_raised') return `${head} · holds ${p.gate === 'none' ? 'nothing' : String(p.gate)}`;
  if (e.type === 'issue_updated') return `${head} · ${String(p.status)}${p.gate ? ` · now holds ${p.gate === 'none' ? 'nothing' : String(p.gate)}` : ''}${p.note ? ` · ${String(p.note)}` : ''}`;
  if (e.type === 'issue_resolved') return `${head} · ${pretty(String(p.resolution ?? ''))}${p.note ? ` · ${String(p.note)}` : ''}`;
  if (e.type === 'issue_withdrawn') return `${head} · ${String(p.reason ?? '')}`;
  if (e.type === 'issue_fatal') return `${head} · ${String(p.reason ?? '')}`;
  return head;
}

/** One line for a note event: whose words, and what came of them. */
function noteLabel(e: EngineEvent, state: EngineState): string | null {
  const p = e.payload as Record<string, unknown>;
  const n = state.notes?.[String(p.noteId ?? '')];
  if (e.type === 'note_recorded') { const from = p.from as { name?: string | null; address?: string } | null | undefined; return `${from ? `${from.name || from.address}: ` : ''}${firstLine(String(p.text ?? '')).slice(0, 110)}…`; }
  if (e.type === 'note_extracted') {
    const count = Array.isArray(p.actions) ? p.actions.filter((a) => (a as { command?: unknown }).command).length : 0;
    return count ? `${count} thing${count === 1 ? '' : 's'} to confirm` : 'nothing on the file in it';
  }
  if (e.type === 'note_actions_applied') {
    const applied = Array.isArray(p.applied) ? p.applied.length : 0;
    return applied ? `${applied} line${applied === 1 ? '' : 's'} recorded` : 'nothing recorded';
  }
  if (e.type === 'note_action_refused') return `${String(p.actionId ?? '')} — ${String(p.reason ?? '')}`;
  return n ? n.id : null;
}

/** Does this event belong to the subject a sub-block linked from: its type starts with it, or a payload field names it. */
const touches = (e: EngineEvent, focus: string) => e.type.startsWith(focus) || Object.values(e.payload as Record<string, unknown>).some((v) => v === focus || (typeof v === 'string' && v.split(':').pop() === focus));

/** What a person reads when a note or an issue is opened: the words, not the event. */
function readable(e: EngineEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  if (e.type.startsWith('log:')) return p.details ? String(p.details) : null;
  if (e.type === 'note_recorded') {
    const from = p.from as { name?: string | null; address?: string } | null | undefined;
    return `${from ? `From ${from.name || from.address}\n\n` : ''}${String(p.text ?? '')}`;
  }
  if (e.type === 'issue_raised') return [String(p.title ?? ''), p.detail ? String(p.detail) : null].filter(Boolean).join('\n\n');
  if (e.type === 'issue_resolved') return [pretty(String(p.resolution ?? '')), p.note ? String(p.note) : null].filter(Boolean).join('\n\n');
  if (e.type === 'note_extracted' && Array.isArray(p.actions)) return (p.actions as Array<{ summary: string; quote: string }>).map((a) => `${a.summary}\n“${a.quote}”`).join('\n\n') || null;
  return null;
}

/** What an entry is, at a glance: the chip at the head of each line. */
const CHIP_STYLE: Record<string, { bg: string; fg: string }> = {
  Email: { bg: '#e0f2fe', fg: '#075985' }, Call: { bg: '#fae8ff', fg: '#86198f' }, Note: { bg: '#f1f5f9', fg: '#334155' }, Document: { bg: '#ede9fe', fg: '#5b21b6' },
  Sent: { bg: '#dcfce7', fg: '#166534' }, Chase: { bg: '#fef3c7', fg: '#92400e' }, Issue: { bg: '#fee2e2', fg: '#991b1b' }, Task: { bg: '#f5f3ff', fg: '#5A27E0' }, Stage: { bg: '#e0e7ff', fg: '#3730a3' },
};
function chipOf(e: EngineEvent, state: EngineState): string | null {
  const t = e.type;
  const p = e.payload as Record<string, unknown>;
  if (t === 'log:EMAIL_FILED') return 'Email';
  if (t === 'log:DOC_RECEIVED') return 'Document';
  if (t.startsWith('note_')) {
    const n = state.notes?.[String(p.noteId ?? '')];
    return n?.kind === 'email' ? 'Email' : n?.kind === 'call' ? 'Call' : 'Note';
  }
  if (t === 'chase_sent') return 'Chase';
  if (/^(client_update_sent|acknowledgement_sent|signing_pack_sent|party_notice_sent)$/.test(t)) return 'Sent';
  if (t.startsWith('issue_')) return 'Issue';
  if (t === 'stage_advanced' || t === 'stage_changed') return 'Stage';
  if (/^action_|^decision_|_reviewed$|^proposal/.test(t)) return 'Task';
  if (e.sourceDocumentId && /_(received|returned|extracted|submitted|read)$/.test(t)) return 'Document';
  return null;
}
const Chip = ({ label }: { label: string }) => <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', borderRadius: 999, padding: '1px 7px', marginRight: 8, background: CHIP_STYLE[label]?.bg ?? '#f1f5f9', color: CHIP_STYLE[label]?.fg ?? '#334155', verticalAlign: 1 }}>{label}</span>;

/** A line from the case log (email filed, document received): shown in time order among the engine's events. */
export interface CaseLogEntry { id: string; at: string; type: string; title: string; details: string | null }

export function Timeline({ events, state, people = {}, focus = null, onClearFocus, log = [] }: { events: EngineEvent[]; state: EngineState; people?: Record<string, string>; focus?: string | null; onClearFocus?: () => void; log?: CaseLogEntry[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const ordered = useMemo(() => {
    const logged: EngineEvent[] = focus ? [] : log.map((l) => ({ id: `log:${l.id}`, seq: 0, type: `log:${l.type}`, actor: 'system', createdAt: l.at, sourceDocumentId: null, confidenceScore: null, payload: { title: l.title, details: l.details } }) as unknown as EngineEvent);
    return [...events.filter((e) => !focus || touches(e, focus)), ...logged].sort((a, b) => (a.createdAt === b.createdAt ? b.seq - a.seq : a.createdAt < b.createdAt ? 1 : -1));
  }, [events, focus, log]);
  // Searchable, filterable, grouped by when: Today, Yesterday, This Week open; older folded.
  const filters = useMemo(() => TIMELINE_FILTERS(state), [state]);
  const tools = useListTools(ordered, { date: (e) => e.createdAt, text: (e) => searchText(e, state), filters });
  const who = (a: string) => (a === 'system' ? 'engine' : a === 'ai' ? 'AI' : a === 'external' ? 'external' : (people[a] ?? 'handler'));

  if (!events.length) return <div className="eg-empty">No events yet.</div>;
  return (
    <div className="tl">
      {focus && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span className="eg-chip info">{pretty(focus)}</span>
          <span className="eg-sub">{ordered.length} of {events.length} events</span>
          {onClearFocus && <button className="eg-btn" style={{ marginLeft: 'auto' }} onClick={onClearFocus}>Show All</button>}
        </div>
      )}
      <ListToolbar tools={tools} filters={filters} placeholder="Search the timeline" />
      <Grouped tools={tools} render={(e, g) => {
            const d = state.decisions[e.id];
            if (DECISION_EVENT_TYPES.has(e.type) && d) {
              const cls = d.kind === 'bank_details' ? ' bank' : d.kind === 'auto_clear' ? ' review' : '';
              const hidden = false;
              return (
                <a key={e.id} className={`eg-card tl-card ${d.status}${cls}${hidden ? ' hidden' : ''}`} href={`/conveyi/decisions/${e.id}`}>
                  <div className="tl-card-top">
                    <span className="tl-kind">{KIND_LABEL[d.kind] ?? pretty(d.kind)}{d.subject ? ` · ${d.subject.replace(/^[a-z_]+:/, '')}` : ''}</span>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {hidden && <span className="eg-chip shadow">not surfaced</span>}
                      <span className={`eg-chip ${d.status === 'pending' ? 'pending' : d.status === 'actioned' ? 'ok' : 'info'}`}>{d.status}</span>
                    </span>
                  </div>
                  <div className="tl-first">{firstLine(d.summary)}</div>
                  <div className="tl-meta">{whenIn(e.createdAt, g)} · raised by {who(e.actor)}{d.resolvedBy ? ` · ${d.status} by ${who(d.resolvedBy)}` : ''}{e.confidenceScore != null ? ` · confidence ${Math.round(e.confidenceScore * 100)}%` : ''}</div>
                </a>
              );
            }
            const sup = e.type === 'action_suppressed';
            const issueLine = issueLabel(e, state) ?? (e.type.startsWith('note_') ? noteLabel(e, state) : null);
            return (
              <div key={e.id}>
                <div className={`tl-ev${sup ? ' sup' : ''}`} onClick={() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))} >
                  <span className="t">{whenIn(e.createdAt, g)}</span>
                  <span className="ty">{chipOf(e, state) && <Chip label={chipOf(e, state)!} />}{e.type.startsWith('log:') ? String((e.payload as { title?: string }).title ?? '') : pretty(e.type)}{sup ? ` — ${pretty(String((e.payload as { action?: string }).action ?? ''))} (not performed)` : ''}{issueLine ? ` — ${issueLine}` : ''}</span>
                  <span className="ac">{who(e.actor)} · {actorKind(e.actor)}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11 }}>{e.type.startsWith('log:') ? '' : `#${e.seq}`}</span>
                </div>
                {open[e.id] && (readable(e)
                  ? <div className="tl-read">{readable(e)}{e.sourceDocumentId && <a href={`/api/v1/documents/${e.sourceDocumentId}/raw`} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginTop: 6 }}>Open The Source</a>}</div>
                  : <pre className="tl-raw">{JSON.stringify({ id: e.id, seq: e.seq, type: e.type, actor: e.actor, createdAt: e.createdAt, sourceDocumentId: e.sourceDocumentId, confidenceScore: e.confidenceScore, payload: e.payload }, null, 2)}</pre>)}
              </div>
            );
      }} />
    </div>
  );
}

/** What a search on the timeline looks through: the type, the words of the event, and the decision or issue it is about. */
function searchText(e: EngineEvent, state: EngineState): string {
  const p = e.payload as Record<string, unknown>;
  const d = state.decisions[e.id];
  return [pretty(e.type), typeof p.title === 'string' ? p.title : '', typeof p.details === 'string' ? p.details : '', typeof p.text === 'string' ? p.text : '', d ? `${d.kind} ${d.summary}` : '', issueLabel(e, state) ?? '', JSON.stringify(p).slice(0, 2000)].join(' ');
}

const TIMELINE_FILTERS = (state: EngineState): Filter<EngineEvent>[] => [
  { key: 'mail', label: 'Emails & Notes', match: (e) => e.type === 'log:EMAIL_FILED' || e.type.startsWith('note_') },
  { key: 'docs', label: 'Documents', match: (e) => !!e.sourceDocumentId && /_(received|returned|extracted|submitted)$|^survey|^title|^search|^mortgage_offer|^lease|^management_pack/.test(e.type) || e.type === 'log:DOC_RECEIVED' },
  { key: 'decisions', label: 'Decisions & Tasks', match: (e) => !!state.decisions[e.id] || /^action_|^decision_|_reviewed$|resolved_decision/.test(e.type) },
  { key: 'issues', label: 'Issues', match: (e) => e.type.startsWith('issue_') },
  { key: 'sent', label: 'Messages Sent', match: (e) => /^(client_update_sent|chase_sent|acknowledgement_sent|signing_pack_sent)$/.test(e.type) },
];
