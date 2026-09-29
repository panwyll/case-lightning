'use client';
import { useEffect, useRef, useState } from 'react';
import { useEngine } from './useEngine';
import { WorkPanel } from './WorkPanel';
import type { Api } from './types';

/**
 * One flowchart step, done from the Tasks list: the same action the case page offers (an upload,
 * a record, an authorisation), in place, so nobody has to open the case to find it. When the step
 * is no longer due, `onDone` fires. An upload is read after it lands, so the step is re-checked for a little while.
 */
export function StepReview({ api, matterId, stepKey, onDone }: { api: Api; matterId: string; stepKey: string; onDone: () => void }) {
  const eng = useEngine(matterId, api);
  const [checking, setChecking] = useState(false);
  const polls = useRef<ReturnType<typeof setTimeout> | null>(null);
  const due = eng.view ? (eng.view.due ?? []).some((d) => d.key === stepKey) : true;
  useEffect(() => { if (eng.view && !due) onDone(); }, [eng.view, due]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (polls.current) clearTimeout(polls.current); }, []);
  const changed = () => {
    setChecking(true);
    let n = 0;
    const tick = () => { void eng.load(); if (++n < 8) polls.current = setTimeout(tick, 4000); else setChecking(false); };
    tick();
  };
  if (!eng.view) return <div style={{ fontSize: 13, color: eng.err ? '#b91c1c' : '#94a3b8', padding: 4 }}>{eng.err ?? 'Loading…'}</div>;
  return (
    <div>
      <WorkPanel matterId={matterId} api={api} view={eng.view} busy={eng.busy} err={eng.err} cmd={eng.cmd} onChanged={changed} notice={eng.notice} section="step" stepKey={stepKey} />
      {checking && due && <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 8 }}>Uploaded. Reading it now…</div>}
    </div>
  );
}
