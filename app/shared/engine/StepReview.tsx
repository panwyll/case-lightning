'use client';
import { useEffect } from 'react';
import { useEngine } from './useEngine';
import { WorkPanel, WORK_CSS } from './WorkPanel';
import { IssuesPanel } from './IssuesPanel';
import type { Api } from './types';

/**
 * One flowchart step, done from the Tasks list: the same action the case page offers (an upload,
 * a record, an authorisation), in place, so nobody has to open the case to find it. When the step
 * is no longer due, `onDone` fires. An upload is read after it lands, so the step is re-checked for a little while.
 */
export function StepReview({ api, matterId, stepKey, onDone }: { api: Api; matterId: string; stepKey: string; onDone: () => void }) {
  const eng = useEngine(matterId, api);
  const due = eng.view ? (eng.view.due ?? []).some((d) => d.key === stepKey) : true;
  // Done: the confirmation stays on screen a moment, then the task leaves the list.
  useEffect(() => { if (!eng.view || due) return; const t = setTimeout(onDone, 2500); return () => clearTimeout(t); }, [eng.view, due]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!eng.view) return <div style={{ fontSize: 13, color: eng.err ? '#b91c1c' : '#94a3b8', padding: 4 }}>{eng.err ?? 'Loading…'}</div>;
  return (
    <div>
      {eng.err && <div style={{ fontSize: 12.5, color: '#b91c1c', marginBottom: 6 }}>{eng.err}</div>}
      {!due && <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d', marginBottom: 6 }}>Done.</div>}
      <WorkPanel matterId={matterId} api={api} view={eng.view} busy={eng.busy} err={null} cmd={eng.cmd} onChanged={() => void eng.load()} notice={eng.notice} section="step" stepKey={stepKey} />
    </div>
  );
}

/** One issue, dealt with from the Tasks list: its Resolve / Try Again / password / More actions, in place. `onDone` fires once it is closed. */
export function IssueReview({ api, matterId, issueId, onDone, onCancel }: { api: Api; matterId: string; issueId: string; onDone: () => void; onCancel?: () => void }) {
  const eng = useEngine(matterId, api);
  const st = eng.view?.state.issues?.[issueId]?.status;
  const live = st === 'open' || st === 'negotiating';
  // Resolved: the confirmation stays on screen a moment, then the task leaves the list.
  useEffect(() => { if (!eng.view || live) return; const t = setTimeout(onDone, 2500); return () => clearTimeout(t); }, [eng.view, live]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!eng.view) return <div style={{ fontSize: 13, color: eng.err ? '#b91c1c' : '#94a3b8', padding: 4 }}>{eng.err ?? 'Loading…'}</div>;
  return (
    <div>
      {eng.err && <div style={{ fontSize: 12.5, color: '#b91c1c', marginBottom: 6 }}>{eng.err}</div>}
      <style>{WORK_CSS}</style>
      <IssuesPanel api={api} state={eng.view.state} busy={eng.busy} cmd={eng.cmd} onChanged={() => void eng.load()} only={issueId} onCancel={onCancel} err={eng.err} />
    </div>
  );
}

/** A date we owe coming up (or gone): the case's own to-do list in place, since the way through is one of its steps, decisions or issues. */
export function CaseTodoReview({ api, matterId }: { api: Api; matterId: string }) {
  const eng = useEngine(matterId, api);
  if (!eng.view) return <div style={{ fontSize: 13, color: eng.err ? '#b91c1c' : '#94a3b8', padding: 4 }}>{eng.err ?? 'Loading…'}</div>;
  return (
    <div>
      <WorkPanel matterId={matterId} api={api} view={eng.view} busy={eng.busy} err={eng.err} cmd={eng.cmd} onChanged={() => void eng.load()} notice={eng.notice} section="todo" />
    </div>
  );
}

/** Something the case is waiting for, recorded from the Tasks list (its form in place). `onDone` fires once the wait has closed. */
export function WaitReview({ api, matterId, wait, onDone }: { api: Api; matterId: string; wait: string; onDone: () => void }) {
  const eng = useEngine(matterId, api);
  const at = wait.indexOf(':');
  const key = at < 0 ? wait : wait.slice(0, at), subject = at < 0 ? '' : wait.slice(at + 1);
  const open = eng.view ? eng.view.state.waits.some((w) => w.key === key && w.subject === subject && !w.closedAt) : true;
  useEffect(() => { if (!eng.view || open) return; const t = setTimeout(onDone, 2500); return () => clearTimeout(t); }, [eng.view, open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!eng.view) return <div style={{ fontSize: 13, color: eng.err ? '#b91c1c' : '#94a3b8', padding: 4 }}>{eng.err ?? 'Loading…'}</div>;
  return (
    <div>
      {eng.err && <div style={{ fontSize: 12.5, color: '#b91c1c', marginBottom: 6 }}>{eng.err}</div>}
      {!open && <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d', marginBottom: 6 }}>Done.</div>}
      <WorkPanel matterId={matterId} api={api} view={eng.view} busy={eng.busy} err={null} cmd={eng.cmd} onChanged={() => void eng.load()} notice={eng.notice} section="wait" stepKey={wait} />
    </div>
  );
}
