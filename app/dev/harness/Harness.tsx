'use client';
import { useEffect, useState } from 'react';
import DocPacks from '@/app/conveyi/(app)/admin/DocPacks';
import TaskList, { TaskTools, type TaskSort } from '@/app/conveyi/(app)/admin/TaskList';
import { useEngine } from '@/app/shared/engine/useEngine';
import { WorkPanel } from '@/app/shared/engine/WorkPanel';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { StepReview } from '@/app/shared/engine/StepReview';
import EmailTemplates from '@/app/conveyi/(app)/admin/EmailTemplates';

const MATTER = '22222222-2222-4222-8222-222222222222';

/** Sends the app's /api/v1 calls to the in-memory case. */
function patchFetch() {
  const w = window as unknown as { __devPatched?: boolean };
  if (w.__devPatched) return;
  w.__devPatched = true;
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return real(url.replace(/^(https?:\/\/[^/]+)?\/api\/v1\//, '/api/dev/harness/'), init);
  };
}

function CasePanel({ section }: { section: 'tasks' | 'flow' }) {
  const eng = useEngine(MATTER, api);
  if (!eng.view) return <div>{eng.err ?? 'Loading…'}</div>;
  return <WorkPanel matterId={MATTER} api={api} view={eng.view} busy={eng.busy} err={eng.err} cmd={eng.cmd} onChanged={() => void eng.load()} notice={eng.notice} section={section} />;
}

export function Harness() {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<'tasks' | 'case' | 'flow'>(() => (typeof window !== 'undefined' ? (window.location.hash.slice(1) as 'tasks' | 'case' | 'flow') || 'tasks' : 'tasks'));
  useEffect(() => { patchFetch(); setReady(true); }, []);
  if (!ready) return null;
  return (
    <div className="eg" style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <style>{ENGINE_CSS}</style>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className="ep-btn" onClick={() => { window.location.hash = 'tasks'; setView('tasks'); }}>Tasks</button>
        <button className="ep-btn" onClick={() => { window.location.hash = 'case'; setView('case'); }}>Case Tasks Tab</button>
        <button className="ep-btn" onClick={() => { window.location.hash = 'flow'; setView('flow'); }}>Flowchart</button>
        <button className="ep-btn" onClick={() => void fetch('/api/dev/harness/reset', { method: 'POST' }).then(() => window.location.reload())}>Reset</button>
      </div>
      {typeof window !== 'undefined' && window.location.hash.startsWith('#step:')
        ? <StepReview api={api} matterId={MATTER} stepKey={window.location.hash.slice('#step:'.length)} onDone={() => {}} />
        : typeof window !== 'undefined' && window.location.hash === '#templates' ? <EmailTemplates />
        : typeof window !== 'undefined' && window.location.hash.startsWith('#docpacks') ? <DocPacks />
        : view === 'tasks' ? <HarnessTasks /> : <CasePanel section={view === 'flow' ? 'flow' : 'tasks'} />}
    </div>
  );
}

/** The Tasks tab as the app shows it: title, Sort and Search on the header line, then the list. */
function HarnessTasks() {
  const [sort, setSort] = useState<TaskSort>('urgency');
  const [q, setQ] = useState('');
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12, minHeight: 36 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: '#0f172a' }}>Tasks</h1>
        <TaskTools sort={sort} setSort={setSort} q={q} setQ={setQ} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', fontSize: 12.5, fontWeight: 700, color: '#64748b' }}>Assigned To<select style={{ border: '1px solid #d0d5dd', borderRadius: 8, padding: '5px 10px', fontSize: 12.5, fontWeight: 700 }}><option>Anyone</option></select></label>
      </div>
      <TaskList who="" sort={sort} q={q} />
    </>
  );
}
