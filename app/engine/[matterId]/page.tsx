'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { EnginePanel } from '../../shared/engine/EnginePanel';
import { Timeline } from '../../shared/engine/Timeline';
import { api } from '../../shared/engine/api';
import { ENGINE_CSS } from '../../shared/engine/ui';
import { STAGE_LABEL, type EngineEvent, type EngineView } from '../../shared/engine/types';

/**
 * Addendum 3 §3 — the timeline view for one matter. Header: address, reference, the
 * engine's current stage and, on a shadow-mode matter, a banner that cannot be
 * dismissed. Below: the timeline (default) or the controls (the operational panel).
 */
export default function EngineMatterPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = use(params);
  const [view, setView] = useState<EngineView | null>(null);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [tab, setTab] = useState<'timeline' | 'controls'>('timeline');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, ev] = await Promise.all([api<EngineView>(`/matters/${matterId}/engine`), api<{ events: EngineEvent[] }>(`/matters/${matterId}/engine/events?limit=2000`)]);
      setView(v);
      setEvents(ev.events);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the matter.');
    }
  }, [matterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const m = view?.matter ?? null;
  const shadow = !!view?.state.shadowMode;
  const pending = view?.surfacedDecisions?.filter((d) => d.kind !== 'auto_clear').length ?? 0;
  return (
    <div className="eg" style={{ maxWidth: 1040, margin: '0 auto', padding: '16px 16px 40px' }}>
      <style>{ENGINE_CSS}</style>
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
            {view && <span className="eg-chip stage">{STAGE_LABEL[view.state.stage] ?? view.state.stage}</span>}
            {view && !view.state.enrolled && <span className="eg-chip muted">not enrolled</span>}
            {view?.state.manualHandling.required && <span className="eg-chip bad">manual handling</span>}
            {pending > 0 && <span className="eg-chip pending">{pending} pending</span>}
          </div>
          <p className="eg-sub">{m?.matterRef ?? matterId}{m?.handler ? ` · ${m.handler}` : ''}{view?.blockers.length ? ` · next stage blocked by: ${view.blockers.join('; ')}` : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a className="eg-btn" href="/decisions">← Queue</a>
          {shadow && <a className="eg-btn" href={`/engine/${matterId}/shadow`}>Comparison</a>}
        </div>
      </div>
      {err && <div className="eg-err">{err}</div>}
      <div className="eg-tabs">
        <button className={`eg-tab${tab === 'timeline' ? ' on' : ''}`} onClick={() => setTab('timeline')}>Timeline{events.length ? ` (${events.length})` : ''}</button>
        <button className={`eg-tab${tab === 'controls' ? ' on' : ''}`} onClick={() => setTab('controls')}>Controls</button>
      </div>
      {tab === 'timeline' && view && <Timeline events={events} state={view.state} />}
      {tab === 'controls' && <EnginePanel matterId={matterId} api={api} onChanged={() => void load()} />}
    </div>
  );
}
