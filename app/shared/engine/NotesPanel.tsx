'use client';
import { useState } from 'react';
import { fmtWhen, pretty, type Api, type EngineState, type NoteRow } from './types';

/**
 * Notes and call transcripts on a matter (docs/intake.md).
 *
 * Typing into this box is the whole interface: file what was said, and the engine reads
 * it back as a list of proposals for the conveyancer to tick. Nothing here changes the
 * case on its own — the decision does, and only when a person approves it.
 */
const STATUS: Record<string, { bg: string; fg: string; label: string }> = {
  proposed: { bg: '#fef3c7', fg: '#78350f', label: 'waiting on you' },
  applied: { bg: '#dcfce7', fg: '#14532d', label: 'recorded' },
  discarded: { bg: '#f1f5f9', fg: '#475569', label: 'nothing recorded' },
  no_actions: { bg: '#f1f5f9', fg: '#94a3b8', label: 'nothing to record' },
};
const KIND: Record<string, string> = { typed: 'Note', dictated: 'Dictated note', call: 'Call', meeting: 'Meeting' };

export function NotesPanel({
  state,
  busy,
  cmd,
  people,
}: {
  api: Api;
  state: EngineState;
  busy: boolean;
  cmd: (body: Record<string, unknown>) => Promise<void>;
  people?: Record<string, string>;
}) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState('typed');
  const [open, setOpen] = useState<string | null>(null);
  const notes = Object.values(state.notes ?? {}).sort((a, b) => b.at.localeCompare(a.at));
  const who = (id: string) => people?.[id] ?? (id === 'ai' ? 'the reader' : id === 'system' ? 'the engine' : id.slice(0, 8));

  const file = async () => {
    const body = text.trim();
    if (body.length < 10) return;
    await cmd({ type: 'record_note', text: body, kind });
    setText('');
  };

  return (
    <div className="ep">
      <h3 style={{ margin: '4px 0 8px', fontSize: 14 }}>Notes and calls</h3>
      <textarea
        className="ep-input"
        rows={4}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }}
        placeholder="Spoke to the client. She is happy with the damp report and wants to press on. Her broker expects the revised offer on Friday…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="ep-input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="ep-btn primary" disabled={busy || text.trim().length < 10} onClick={file}>
          {busy ? 'Filing…' : 'File it'}
        </button>
        {text.trim().length > 0 && text.trim().length < 10 && <span style={{ color: '#94a3b8', fontSize: 12 }}>A little more than that.</span>}
      </div>

      {notes.length === 0 && <div style={{ color: '#94a3b8', marginTop: 12, fontSize: 12.5 }}>No notes on this matter yet.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {notes.map((n) => <Note key={n.id} n={n} open={open === n.id} onToggle={() => setOpen(open === n.id ? null : n.id)} who={who} />)}
      </div>
    </div>
  );
}

function Note({ n, open, onToggle, who }: { n: NoteRow; open: boolean; onToggle: () => void; who: (id: string) => string }) {
  const s = STATUS[n.status] ?? STATUS.no_actions;
  const proposals = n.actions.filter((a) => a.command);
  const refused = new Map(n.refusedActions.map((r) => [r.id, r.reason]));
  return (
    <div style={{ border: '1px solid #e6e8ee', borderRadius: 10, padding: '8px 10px', background: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 12.5 }}>{KIND[n.kind] ?? pretty(n.kind)}</b>
        <span style={{ color: '#64748b', fontSize: 12 }}>{fmtWhen(n.at)} · {who(n.author)}</span>
        <span className="ep-pill" style={{ background: s.bg, color: s.fg }}>{s.label}</span>
        {n.status === 'proposed' && n.decisionEventId && (
          <a className="ep-btn" style={{ margin: 0, padding: '3px 8px' }} href={`/conveyi/decisions/${n.decisionEventId}`}>Read it back →</a>
        )}
        <button className="ep-btn" style={{ margin: 0, marginLeft: 'auto', padding: '3px 8px' }} onClick={onToggle}>{open ? 'Hide' : 'Show'} the note</button>
      </div>
      {open && <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, color: '#334155', margin: '8px 0 0', maxWidth: '80ch' }}>{n.text}</pre>}
      {proposals.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, color: '#334155' }}>
          {proposals.map((a) => {
            const why = refused.get(a.id);
            const landed = !why && n.appliedActionIds.includes(a.id);
            return (
              <li key={a.id} style={{ color: why ? '#7f1d1d' : landed ? '#14532d' : '#64748b' }}>
                {a.summary}
                {why ? ` — refused: ${why}` : landed ? ' — recorded' : n.status === 'proposed' ? '' : ' — not recorded'}
              </li>
            );
          })}
        </ul>
      )}
      {n.extractor && proposals.length === 0 && n.status !== 'proposed' && (
        <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 6 }}>Read, with nothing in it for the case.</div>
      )}
    </div>
  );
}
