'use client';
import { useState } from 'react';
import { IssuesPanel } from './IssuesPanel';
import { NotesPanel } from './NotesPanel';
import { WorkPanel, WORK_CSS } from './WorkPanel';
import { DocumentsPanel } from './DocumentsPanel';
import { useEngine } from './useEngine';
import type { Api } from './types';

/**
 * The engine inside the CaseLightning matter drawer: the same work / issues / documents
 * panels as the standalone matter page, in a compact tab strip.
 */
export function EnginePanel({ matterId, api, onChanged }: { matterId: string; api: Api; onChanged?: () => void }) {
  const eng = useEngine(matterId, api, onChanged);
  const [tab, setTab] = useState<'work' | 'issues' | 'notes' | 'documents'>('work');
  if (eng.err && !eng.view) return <div className="ep"><style>{WORK_CSS}</style><div className="ep-err">{eng.err}</div></div>;
  if (!eng.view) return <div className="ep"><style>{WORK_CSS}</style><div style={{ color: '#94a3b8' }}>Loading the engine…</div></div>;
  const openIssues = Object.values(eng.view.state.issues ?? {}).filter((i) => i.status === 'open' || i.status === 'negotiating').length;
  const unreadNotes = Object.values(eng.view.state.notes ?? {}).filter((n) => n.status === 'proposed').length;
  return (
    <div className="ep">
      <style>{WORK_CSS}</style>
      {eng.notice && <div className={eng.notice.kind === 'ok' ? 'ep-ok' : eng.notice.kind === 'warn' ? 'ep-warn' : 'ep-err'} style={{ marginTop: 0, marginBottom: 8 }}>{eng.notice.text}</div>}
      {eng.view.state.enrolled && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          {(['work', 'issues', 'notes', 'documents'] as const).map((t) => (
            <button key={t} className={`ep-btn${tab === t ? ' primary' : ''}`} style={{ margin: 0 }} onClick={() => setTab(t)}>{t === 'work' ? 'Work' : t === 'issues' ? `Issues${openIssues ? ` (${openIssues})` : ''}` : t === 'notes' ? `Notes${unreadNotes ? ` (${unreadNotes})` : ''}` : 'Documents'}</button>
          ))}
        </div>
      )}
      {(tab === 'work' || !eng.view.state.enrolled) && <WorkPanel matterId={matterId} api={api} view={eng.view} busy={eng.busy} err={eng.err} cmd={eng.cmd} onChanged={() => { void eng.load(); onChanged?.(); }} notice={eng.notice} />}
      {tab === 'issues' && eng.view.state.enrolled && <IssuesPanel api={api} state={eng.view.state} busy={eng.busy} cmd={eng.cmd} />}
      {tab === 'notes' && eng.view.state.enrolled && <NotesPanel api={api} state={eng.view.state} busy={eng.busy} people={eng.view.matter?.assignedTo && eng.view.matter.handler ? { [eng.view.matter.assignedTo]: eng.view.matter.handler } : {}} cmd={async (body) => { await eng.cmd(body); void eng.load(); onChanged?.(); }} />}
      {tab === 'documents' && eng.view.state.enrolled && <DocumentsPanel matterId={matterId} api={api} view={eng.view} events={eng.events} busy={eng.busy} setBusy={eng.setBusy} onChanged={() => { void eng.load(); onChanged?.(); }} />}
    </div>
  );
}
