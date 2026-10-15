'use client';
/**
 * Confirming where a case taken on part-way through is (lib/server/engine/placement.ts): what its history showed done
 * is ticked and fixed; the person ticks what else was done before CONVEYi took it on. Nothing is preselected for them.
 */
import { useState } from 'react';
import { BusyButton } from './BusyButton';
import { Check } from '@/app/shared/icons';
import { placementChecklist, type PlacementInput } from '@/lib/server/engine/placement';

export function PlacementForm({ s, busy, onSubmit }: { s: PlacementInput; busy: boolean; onSubmit: (body: Record<string, unknown>) => Promise<unknown> }) {
  const steps = placementChecklist(s);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const flip = (step: string) => setTicked((t) => { const n = new Set(t); if (n.has(step)) n.delete(step); else n.add(step); return n; });
  return (
    <div style={{ display: 'grid', gap: 6, maxWidth: 520 }}>
      {steps.map((x) => (
        <label key={x.step} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, color: x.read ? '#166534' : '#0f172a', cursor: x.read ? 'default' : 'pointer' }}>
          {x.read
            ? <Check size={16} aria-hidden />
            : <input type="checkbox" checked={ticked.has(x.step)} onChange={() => flip(x.step)} />}
          <span>{x.label}</span>
          {x.read && <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>{x.byHand ? 'Marked Done' : 'Read From The File'}</span>}
        </label>
      ))}
      <div style={{ marginTop: 6 }}>
        <BusyButton className="ep-btn primary" disabled={busy} busyLabel="Confirming…" doneLabel="Confirmed" onClick={async () => {
          await onSubmit({ type: 'confirm_placement', steps: [...ticked] });
          return true;
        }}>Confirm Where It Is</BusyButton>
      </div>
    </div>
  );
}
