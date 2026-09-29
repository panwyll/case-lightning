'use client';
import { useEffect, useState } from 'react';
import TaskList from '@/app/conveyi/(app)/admin/TaskList';
import { useEngine } from '@/app/shared/engine/useEngine';
import { WorkPanel } from '@/app/shared/engine/WorkPanel';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';

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
      {view === 'tasks' ? <TaskList who="" /> : <CasePanel section={view === 'flow' ? 'flow' : 'tasks'} />}
    </div>
  );
}
