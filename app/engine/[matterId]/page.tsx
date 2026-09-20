'use client';
import { use, useState } from 'react';
import { WorkPanel, WORK_CSS } from '../../shared/engine/WorkPanel';
import { IssuesPanel } from '../../shared/engine/IssuesPanel';
import { DocumentsPanel } from '../../shared/engine/DocumentsPanel';
import { Timeline } from '../../shared/engine/Timeline';
import { CaseView } from '../../shared/engine/CaseView';
import { useEngine } from '../../shared/engine/useEngine';
import { api } from '../../shared/engine/api';
import { ENGINE_CSS } from '../../shared/engine/ui';
import { TRANSACTION_LABEL, stageLabel } from '../../shared/engine/types';

/**
 * One matter, for the conveyancer. Header: address, reference, transaction type, the
 * phase the engine is in (named for this type), and on a shadow-mode matter a banner
 * that cannot be dismissed. Tabs: Readiness (why not / what next), Work (by workstream,
 * with the commands that apply to this type), Issues, Documents, Dependencies, Timeline.
 */
export default function EngineMatterPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = use(params);
  const eng = useEngine(matterId, api);
  const [tab, setTab] = useState<'readiness' | 'work' | 'issues' | 'documents' | 'dependencies' | 'timeline'>('readiness');
  const view = eng.view;
  const m = view?.matter ?? null;
  const shadow = !!view?.state.shadowMode;
  const pending = view?.surfacedDecisions?.filter((d) => d.kind !== 'auto_clear').length ?? 0;
  const openIssues = Object.values(view?.state.issues ?? {}).filter((i) => i.status === 'open' || i.status === 'negotiating').length;
  const enrolled = !!view?.state.enrolled;
  const refresh = () => void eng.load();
  return (
    <div className="eg" style={{ maxWidth: 1040, margin: '0 auto', padding: '16px 16px 40px' }}>
      <style>{ENGINE_CSS + WORK_CSS}</style>
      {shadow && (
        <div className="eg-shadow-banner" role="status" aria-live="polite">
          <b>Shadow mode</b>
          <span>The engine is observing this matter. Nothing shown here has been sent, ordered or put in front of a handler; decisions are logged for comparison only and cannot be actioned.</span>
          <a href={`/engine/${matterId}/shadow`}>Compare with the human record →</a>
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
            {pending > 0 && <span className="eg-chip pending">{pending} pending</span>}
            {openIssues > 0 && <span className="eg-chip pending">{openIssues} open issue{openIssues === 1 ? '' : 's'}</span>}
          </div>
          <p className="eg-sub">{m?.matterRef ?? matterId}{m?.handler ? ` · ${m.handler}` : ''}{view?.lifecycle ? ` · ${view.lifecycle.label}` : ''}{view?.blockers.length ? ` · next phase blocked by: ${view.blockers.join('; ')}` : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a className="eg-btn" href="/decisions">← Queue</a>
          <a className="eg-btn" href="/engine/map">Map</a>
          {shadow && <a className="eg-btn" href={`/engine/${matterId}/shadow`}>Comparison</a>}
        </div>
      </div>
      {eng.err && !view && <div className="eg-err">{eng.err}</div>}
      {!view && !eng.err && <div className="eg-sub">Loading the matter…</div>}
      {view && !enrolled && <WorkPanel matterId={matterId} api={api} view={view} busy={eng.busy} err={eng.err} cmd={eng.cmd} onChanged={refresh} />}
      {view && enrolled && (
        <>
          <div className="eg-tabs">
            <button className={`eg-tab${tab === 'readiness' ? ' on' : ''}`} onClick={() => setTab('readiness')}>Readiness</button>
            <button className={`eg-tab${tab === 'work' ? ' on' : ''}`} onClick={() => setTab('work')}>Work{pending ? ` (${pending})` : ''}</button>
            <button className={`eg-tab${tab === 'issues' ? ' on' : ''}`} onClick={() => setTab('issues')}>Issues{openIssues ? ` (${openIssues})` : ''}</button>
            <button className={`eg-tab${tab === 'documents' ? ' on' : ''}`} onClick={() => setTab('documents')}>Documents</button>
            <button className={`eg-tab${tab === 'dependencies' ? ' on' : ''}`} onClick={() => setTab('dependencies')}>Dependencies</button>
            <button className={`eg-tab${tab === 'timeline' ? ' on' : ''}`} onClick={() => setTab('timeline')}>Timeline{eng.events.length ? ` (${eng.events.length})` : ''}</button>
          </div>
          {tab === 'readiness' && <CaseView key={`r${eng.events.length}`} matterId={matterId} api={api} view="readiness" />}
          {tab === 'work' && <WorkPanel matterId={matterId} api={api} view={view} busy={eng.busy} err={eng.err} cmd={eng.cmd} onChanged={refresh} />}
          {tab === 'issues' && <div className="ep"><IssuesPanel api={api} state={view.state} busy={eng.busy} cmd={eng.cmd} />{eng.err && <div className="ep-err">{eng.err}</div>}</div>}
          {tab === 'documents' && <DocumentsPanel matterId={matterId} api={api} view={view} events={eng.events} busy={eng.busy} setBusy={eng.setBusy} onChanged={refresh} />}
          {tab === 'dependencies' && <CaseView key={`d${eng.events.length}`} matterId={matterId} api={api} view="dependencies" />}
          {tab === 'timeline' && <Timeline events={eng.events} state={view.state} />}
        </>
      )}
    </div>
  );
}
