'use client';
import { useState } from 'react';
import { BusyButton } from './BusyButton';

/**
 * A done step, taken back. Undo: it was marked done by hand in error, and is read as never having
 * happened. Mark Incomplete: it was done and no longer holds (an offer expired, a price change voided
 * the papers): outstanding again from now, with the reason, history kept. Each asks why.
 */
export function ReopenStep({ step, label, canUndo, canReopen, effect, busy, cmd }: {
  step: string; label: string; canUndo: boolean; canReopen: boolean; effect?: string | null; busy: boolean;
  cmd: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<'undo' | 'reopen' | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!canUndo && !canReopen) return null;
  if (!mode) return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      {canUndo && <button type="button" className="ep-btn" disabled={busy} title={`Marked done by hand in error: take it back as if it never happened`} onClick={() => { setMode('undo'); setReason(''); setErr(null); }}>Undo</button>}
      {canReopen && <button type="button" className="ep-btn" disabled={busy} title={effect ?? `${label} no longer holds`} onClick={() => { setMode('reopen'); setReason(''); setErr(null); }}>Mark Incomplete</button>}
    </span>
  );
  return (
    <span style={{ display: 'grid', gap: 6, marginTop: 6, width: '100%', minWidth: 240, maxWidth: 420, boxSizing: 'border-box' }}>
      {mode === 'reopen' && effect && <span style={{ fontSize: 12, color: '#475569' }}>{effect}.</span>}
      <input className="ep-input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mode === 'undo' ? 'Why it was marked in error' : 'Why it no longer holds (the offer expired, the price changed…)'} aria-label="Reason" style={{ margin: 0, width: '100%', boxSizing: 'border-box' }} />
      {err && <span style={{ fontSize: 12.5, color: '#b91c1c', fontWeight: 600 }}>{err}</span>}
      <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={() => setMode(null)}>Cancel</button>
        <BusyButton disabled={busy || reason.trim().length < 3} busyLabel={mode === 'undo' ? 'Undoing…' : 'Reopening…'} doneLabel={mode === 'undo' ? 'Undone' : 'Reopened'} onClick={async () => {
          setErr(null);
          try { const r = await cmd({ type: mode === 'undo' ? 'undo_manual_step' : 'reopen_step', step, reason: reason.trim() }); if (r === false) { setErr('It did not save.'); return false; } return true; }
          catch (e: unknown) { setErr(e instanceof Error ? e.message : 'It did not save.'); return false; }
        }}>{mode === 'undo' ? 'Undo' : 'Mark Incomplete'}</BusyButton>
      </span>
    </span>
  );
}
