'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../shared/engine/api';
import { ENGINE_CSS } from '../shared/engine/ui';
import { House } from '../shared/engine/CaseloadMap';
import { HEALTH_LABEL, pretty, type HealthBand, type WorkItem } from '../shared/engine/types';

/**
 * Today (docs/caseload-ux.md §9) — the screen the day starts and ends on.
 *
 * Morning: the caseload has already been evaluated overnight, so this is three numbers
 * and a list of the things that actually need a person. Evening: what is still open, what
 * the timers will chase tomorrow, and which dates land this week.
 */
const T_CSS = `
.td-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 18px}
.td-stat{border:1px solid #e6e8ee;background:#fff;border-radius:12px;padding:12px 14px}
.td-stat b{display:block;font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.05}
.td-stat span{font-size:12px;color:#64748b}
.td-h{font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;margin:22px 0 8px}
.td-card{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.td-row{display:flex;gap:11px;align-items:flex-start;padding:11px 14px;border-top:1px solid #f1f5f9;text-decoration:none;color:inherit}
.td-row:first-child{border-top:0}
.td-row:hover{background:#fafafa}
.td-what{font-size:13.5px;font-weight:600;line-height:1.35}
.td-meta{font-size:11.5px;color:#94a3b8;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap}
.td-tag{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:2px 8px;align-self:center;white-space:nowrap}
.td-tag.escalate{background:#fee2e2;color:#991b1b}
.td-tag.chase{background:#ffedd5;color:#9a3412}
.td-tag.do{background:#ede9fe;color:#5b21b6}
.td-why{font-size:12.5px;color:#475569;margin-top:2px}
.td-done{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;font-size:14px;color:#14532d}
`;

const TAG: Record<string, string> = { escalate: 'Escalate', chase: 'Chase', do: 'Do', waiting: 'Waiting' };

function Row({ i }: { i: WorkItem }) {
  return (
    <a className="td-row" href={`/engine/${i.matterId}`}>
      <House band={i.urgency as HealthBand} size={24} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <div className="td-what">{i.what}</div>
        <div className="td-meta">
          <span>{i.propertyAddress ?? i.matterRef ?? 'Matter'}</span>
          {i.unblocks && <span>· unblocks {i.unblocks.toLowerCase()}</span>}
          {i.chasesSent > 0 && <span>· {i.chasesSent} chased</span>}
          {i.sinceWorkingDays != null && <span>· {i.sinceWorkingDays} working day{i.sinceWorkingDays === 1 ? '' : 's'}</span>}
        </div>
      </span>
      <span className={`td-tag ${i.bucket}`}>{TAG[i.bucket] ?? i.bucket}</span>
    </a>
  );
}

interface Today {
  counts: { active: number; needsYouToday: number; atRisk: number; progressing: number };
  actions: WorkItem[];
  risks: Array<{ matterId: string; matterRef: string | null; propertyAddress: string | null; band: HealthBand; headline: string | null; why: string[]; suggested: string | null }>;
  endOfDay: { stillOpen: number; chasingTomorrow: WorkItem[]; datesThisWeek: WorkItem[]; overdueWaiting: WorkItem[] };
}

export default function TodayPage() {
  const [d, setD] = useState<Today | null>(null);
  const [all, setAll] = useState(false);
  const [evening, setEvening] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await api<Today>(`/engine/today?all=${all ? 1 : 0}`));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not build your day.');
    }
  }, [all]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="eg" style={{ maxWidth: 940, margin: '0 auto', padding: '16px 16px 60px' }}>
      <style>{ENGINE_CSS + T_CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">{evening ? 'End of day' : 'Today'}</h1>
          <p className="eg-sub">
            {d ? `${d.counts.active} active matters, already evaluated — you work the ${d.counts.needsYouToday}, not the ${d.counts.active}.` : 'Working through the caseload…'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={`eg-btn${evening ? ' on' : ''}`} onClick={() => setEvening(!evening)}>{evening ? 'Morning' : 'End of day'}</button>
          <button className={`eg-btn${all ? ' on' : ''}`} onClick={() => setAll(!all)}>{all ? 'Whole team' : 'Mine only'}</button>
          <a className="eg-btn" href="/cases">Caseload</a>
          <a className="eg-btn" href="/my-work">My work</a>
        </div>
      </div>
      {err && <div className="eg-err">{err}</div>}
      {d && (
        <>
          <div className="td-stats">
            <div className="td-stat"><b>{d.counts.active}</b><span>active matters</span></div>
            <div className="td-stat"><b style={{ color: d.counts.needsYouToday ? '#5A27E0' : '#16a34a' }}>{d.counts.needsYouToday}</b><span>need you today</span></div>
            <div className="td-stat"><b style={{ color: d.counts.atRisk ? '#b45309' : '#cbd5e1' }}>{d.counts.atRisk}</b><span>at risk, nothing to do yet</span></div>
            <div className="td-stat"><b style={{ color: '#16a34a' }}>{d.counts.progressing}</b><span>progressing or waiting properly</span></div>
          </div>

          {!evening && (
            <>
              <div className="td-h">{d.actions.length ? `Your list (${d.actions.length})` : 'Your list'}</div>
              {d.actions.length === 0 ? (
                <div className="td-done">Nothing needs you right now. Every case is either moving or waiting on someone else with the clock running.</div>
              ) : (
                <div className="td-card">{d.actions.map((i) => <Row key={i.id} i={i} />)}</div>
              )}

              <div className="td-h">At risk, nothing to do yet ({d.risks.length})</div>
              {d.risks.length === 0 ? (
                <div className="eg-empty" style={{ padding: 16 }}>Nothing is drifting.</div>
              ) : (
                <div className="td-card">
                  {d.risks.map((r) => (
                    <a key={r.matterId} className="td-row" href={`/engine/${r.matterId}`}>
                      <House band={r.band} size={24} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div className="td-what">{r.propertyAddress ?? r.matterRef ?? 'Matter'}</div>
                        <div className="td-why">{r.headline}</div>
                        {r.suggested && <div className="td-meta">· {r.suggested}</div>}
                      </span>
                      <span className="td-tag" style={{ background: '#f1f5f9', color: '#475569' }}>{HEALTH_LABEL[r.band]}</span>
                    </a>
                  ))}
                </div>
              )}
            </>
          )}

          {evening && (
            <>
              <div className="td-h">Still open ({d.endOfDay.stillOpen})</div>
              {d.endOfDay.stillOpen === 0 ? (
                <div className="td-done">Everything that needed a person today has been dealt with.</div>
              ) : (
                <div className="td-card">{d.actions.slice(0, 12).map((i) => <Row key={i.id} i={i} />)}</div>
              )}

              <div className="td-h">The timers will chase these tomorrow ({d.endOfDay.chasingTomorrow.length})</div>
              {d.endOfDay.chasingTomorrow.length === 0 ? (
                <div className="eg-empty" style={{ padding: 16 }}>No chase falls due tomorrow.</div>
              ) : (
                <div className="td-card">
                  {d.endOfDay.chasingTomorrow.map((i) => (
                    <a key={i.id} className="td-row" href={`/engine/${i.matterId}`}>
                      <House band={i.urgency as HealthBand} size={22} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div className="td-what">{i.what}</div>
                        <div className="td-meta"><span>{i.propertyAddress ?? i.matterRef}</span><span>· {pretty(i.actionOwner)}</span><span>· {i.chasesSent} chased so far</span></div>
                      </span>
                      <span className="td-tag chase">Auto</span>
                    </a>
                  ))}
                </div>
              )}

              <div className="td-h">Dates landing this week ({d.endOfDay.datesThisWeek.length})</div>
              {d.endOfDay.datesThisWeek.length === 0 ? (
                <div className="eg-empty" style={{ padding: 16 }}>Nothing we owe falls due this week.</div>
              ) : (
                <div className="td-card">{d.endOfDay.datesThisWeek.map((i) => <Row key={i.id} i={i} />)}</div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
