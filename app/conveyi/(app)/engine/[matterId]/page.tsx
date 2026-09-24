'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { WorkPanel, WORK_CSS } from '@/app/shared/engine/WorkPanel';
import { CaseIntelligence } from '@/app/shared/engine/CaseIntelligence';
import type { CaseModel } from '@/app/shared/engine/CaseView';
import { IssuesPanel } from '@/app/shared/engine/IssuesPanel';
import { NotesPanel } from '@/app/shared/engine/NotesPanel';
import { DocumentsPanel } from '@/app/shared/engine/DocumentsPanel';
import { Timeline } from '@/app/shared/engine/Timeline';
import { CaseView } from '@/app/shared/engine/CaseView';
import { useEngine } from '@/app/shared/engine/useEngine';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { HEALTH_LABEL, TRANSACTION_LABEL, stageLabel } from '@/app/shared/engine/types';

/**
 * One matter, for the conveyancer (docs/caseload-ux.md §2–3). The first thing on screen
 * answers where we are, what needs attention and why, what we are waiting for and what
 * happens next. Everything structural — the workstream commands, the issues, the
 * evidence, the dependency graph — is progressively further in.
 */
export default function EngineMatterPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = use(params);
  const eng = useEngine(matterId, api);
  const [tab, setTab] = useState<'case' | 'work' | 'issues' | 'notes' | 'documents' | 'timeline' | 'diagnostics'>('case');
  const [model, setModel] = useState<CaseModel | null>(null);
  const view = eng.view;
  const m = view?.matter ?? null;
  const shadow = !!view?.state.shadowMode;
  const pending = view?.surfacedDecisions?.filter((d) => d.kind !== 'auto_clear').length ?? 0;
  const openIssues = Object.values(view?.state.issues ?? {}).filter((i) => i.status === 'open' || i.status === 'negotiating').length;
  const unreadNotes = Object.values(view?.state.notes ?? {}).filter((n) => n.status === 'proposed').length;
  const enrolled = !!view?.state.enrolled;
  // The case model (health, workstreams, requirements, gates, next actions, graph) —
  // one fetch, shared by the case view and the diagnostics view.
  const loadModel = useCallback(async () => {
    if (!enrolled) return;
    try {
      setModel(await api<CaseModel>(`/matters/${matterId}/engine/graph`));
    } catch {
      /* the case view degrades to the work panel; the error is already surfaced by useEngine */
    }
  }, [matterId, enrolled]);
  useEffect(() => {
    void loadModel();
  }, [loadModel, eng.events.length]);
  const refresh = () => { void eng.load(); void loadModel(); };
  return (
    <div className="eg" style={{ maxWidth: 1100 }}>
      <style>{ENGINE_CSS + WORK_CSS}</style>
      {shadow && (
        <div className="eg-shadow-banner" role="status" aria-live="polite">
          <b>Shadow mode</b>
          <span>Observing only. Nothing is sent or actioned.</span>
          <a href={`/conveyi/engine/${matterId}/shadow`}>Compare with the human record →</a>
        </div>
      )}
      <div className="eg-top">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <h1 className="eg-h1">{m?.propertyAddress ?? 'Matter'}</h1>
            {view?.state.transactionType && <span className="eg-chip muted">{TRANSACTION_LABEL[view.state.transactionType] ?? view.state.transactionType}</span>}
            {view && enrolled && <span className="eg-chip stage">{view.state.closedAt ? 'Closed' : view.state.abandoned ? 'Abandoned' : stageLabel(view.state.stage, view.profile)}</span>}
            {view && !enrolled && <span className="eg-chip muted">not enrolled</span>}
            {view?.state.manualHandling.required && <span className="eg-chip bad">manual handling</span>}
            {model?.health && model.health.band !== 'normal' && <span className={`eg-chip ${model.health.band === 'critical' || model.health.band === 'blocked' ? 'bad' : 'pending'}`}>{HEALTH_LABEL[model.health.band]}</span>}
            {pending > 0 && <span className="eg-chip pending">{pending} pending</span>}
            {openIssues > 0 && <span className="eg-chip pending">{openIssues} open issue{openIssues === 1 ? '' : 's'}</span>}
          </div>
          <p className="eg-sub">{m?.matterRef ?? matterId}{m?.handler ? ` · ${m.handler}` : ''}{view?.lifecycle ? ` · ${view.lifecycle.label}` : ''}{model?.health?.pace ? ` · day ${model.health.pace.inStage} of about ${model.health.pace.expected} in this phase` : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a className="eg-btn" href="/conveyi/cases">← Caseload</a>
          <a className="eg-btn" href="/conveyi/engine/map">Map</a>
          {shadow && <a className="eg-btn" href={`/conveyi/engine/${matterId}/shadow`}>Comparison</a>}
        </div>
      </div>
      {eng.err && !view && <div className="eg-err">{eng.err}</div>}
      {!view && !eng.err && <div className="eg-sub">Loading…</div>}
      {view && !enrolled && <WorkPanel matterId={matterId} api={api} view={view} busy={eng.busy} err={eng.err} cmd={eng.cmd} onChanged={refresh} />}
      {view && enrolled && (
        <>
          <div className="eg-tabs">
            <button className={`eg-tab${tab === 'case' ? ' on' : ''}`} onClick={() => setTab('case')}>Case</button>
            <button className={`eg-tab${tab === 'work' ? ' on' : ''}`} onClick={() => setTab('work')}>Work{pending ? ` (${pending})` : ''}</button>
            <button className={`eg-tab${tab === 'issues' ? ' on' : ''}`} onClick={() => setTab('issues')}>Issues{openIssues ? ` (${openIssues})` : ''}</button>
            <button className={`eg-tab${tab === 'notes' ? ' on' : ''}`} onClick={() => setTab('notes')}>Notes{unreadNotes ? ` (${unreadNotes})` : ''}</button>
            <button className={`eg-tab${tab === 'documents' ? ' on' : ''}`} onClick={() => setTab('documents')}>Documents</button>
            <button className={`eg-tab${tab === 'timeline' ? ' on' : ''}`} onClick={() => setTab('timeline')}>Timeline{eng.events.length ? ` (${eng.events.length})` : ''}</button>
            <button className={`eg-tab${tab === 'diagnostics' ? ' on' : ''}`} onClick={() => setTab('diagnostics')}>Diagnostics</button>
          </div>
          {tab === 'case' && (model ? <CaseIntelligence m={model} events={eng.events} onDiagnostics={() => setTab('diagnostics')} /> : <div className="eg-sub">Loading…</div>)}
          {tab === 'work' && <WorkPanel matterId={matterId} api={api} view={view} busy={eng.busy} err={eng.err} cmd={eng.cmd} onChanged={refresh} />}
          {tab === 'issues' && <div className="ep"><IssuesPanel api={api} state={view.state} busy={eng.busy} cmd={eng.cmd} />{eng.err && <div className="ep-err">{eng.err}</div>}</div>}
          {tab === 'notes' && <div className="ep"><NotesPanel api={api} state={view.state} busy={eng.busy} people={m?.assignedTo && m.handler ? { [m.assignedTo]: m.handler } : {}} cmd={async (body) => { await eng.cmd(body); refresh(); }} />{eng.err && <div className="ep-err">{eng.err}</div>}</div>}
          {tab === 'documents' && <DocumentsPanel matterId={matterId} api={api} view={view} events={eng.events} busy={eng.busy} setBusy={eng.setBusy} onChanged={refresh} />}
          {tab === 'diagnostics' && (
            <>
              <CaseView matterId={matterId} api={api} view="readiness" model={model} />
              <CaseView matterId={matterId} api={api} view="dependencies" model={model} />
            </>
          )}
          {tab === 'timeline' && <Timeline events={eng.events} state={view.state} />}
        </>
      )}
    </div>
  );
}
