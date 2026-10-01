'use client';
import { useState } from 'react';
import { BusyButton } from './BusyButton';

/**
 * What each co-owner puts in, and the declaration of trust's model (co-owners.ts): one amount per client, the model,
 * and the agreed shares where the model fixes them. Done in place from the Tasks list.
 */
const MODELS = [
  { id: 'CONTRIBUTION', label: 'In Proportion To What Each Puts In' },
  { id: 'FIXED', label: 'Fixed Shares' },
  { id: 'RING_FENCE', label: 'Deposits Back First, Then Fixed Shares' },
  { id: 'FLOATING', label: 'Floating (Five-Stage Formula)' },
] as const;

export function ContributionsForm({ names, busy, onSubmit }: { names: string[]; busy: boolean; onSubmit: (body: Record<string, unknown>) => Promise<unknown> }) {
  const people = names.length >= 2 ? names : ['', ''];
  const [amounts, setAmounts] = useState<string[]>(people.map(() => ''));
  const [model, setModel] = useState<(typeof MODELS)[number]['id']>('CONTRIBUTION');
  const [ratio, setRatio] = useState<string[]>(people.map(() => String(Math.round(100 / people.length))));
  const pennies = (v: string) => Math.round(Number(v.replace(/[£,\s]/g, '')) * 100);
  const fixed = model === 'FIXED' || model === 'RING_FENCE';
  const ratioSum = ratio.reduce((a, r) => a + (Number(r) || 0), 0);
  const ready = amounts.every((a) => a.trim() && Number.isFinite(pennies(a))) && (!fixed || Math.abs(ratioSum - 100) < 0.01);
  return (
    <div style={{ display: 'grid', gap: 8, maxWidth: 520 }}>
      {people.map((n, i) => (
        <label key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 140px 90px', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{n || `Buyer ${i + 1}`}</span>
          <input className="ep-input" inputMode="decimal" placeholder="£ Puts In" value={amounts[i]} onChange={(e) => setAmounts(amounts.map((a, j) => (j === i ? e.target.value : a)))} aria-label={`What ${n || `buyer ${i + 1}`} puts in`} />
          {fixed ? <input className="ep-input" inputMode="decimal" value={ratio[i]} onChange={(e) => setRatio(ratio.map((r, j) => (j === i ? e.target.value : r)))} aria-label={`${n} share percent`} placeholder="%" /> : <span />}
        </label>
      ))}
      <select className="ep-input" value={model} onChange={(e) => setModel(e.target.value as typeof model)} aria-label="How the declaration shares it">
        {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {fixed && Math.abs(ratioSum - 100) >= 0.01 && <span style={{ fontSize: 12.5, color: '#b91c1c', fontWeight: 600 }}>The shares add up to {ratioSum}%</span>}
      <div><BusyButton className="ep-btn primary" disabled={busy || !ready} busyLabel="Recording…" doneLabel="Recorded" onClick={async () => {
        await onSubmit({ type: 'record_contributions', model, contributions: people.map((n, i) => ({ party: n, pennies: pennies(amounts[i]) })), ratioPercent: fixed ? Object.fromEntries(people.map((n, i) => [n, Number(ratio[i]) || 0])) : null });
        return true;
      }}>Record Contributions</BusyButton></div>
    </div>
  );
}
