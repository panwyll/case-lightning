'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { api } from '../../../shared/engine/api';
import { ENGINE_CSS } from '../../../shared/engine/ui';
import { KIND_LABEL, STAGE_LABEL, SUBFLOW_LABEL, fmtWhen, pretty, type DecisionRow } from '../../../shared/engine/types';

/**
 * Addendum 3 §2 — the comparison view (internal). Left: what the engine concluded on
 * this shadow-mode matter — its stage, every decision it would have raised (and the
 * ones a shadowed sub-flow keeps hidden), every auto-clear, every action it would have
 * taken. Right: what the human actually recorded. Each engine conclusion takes a
 * one-click verdict — agrees / disagrees with how the handler really handled it — and
 * those verdicts, per sub-flow, are the evidence for promoting it out of shadow.
 */
interface Review { id: string; eventId: string; subFlow: string; agrees: boolean; humanOutcome: string | null; note: string | null; reviewer: string; createdAt: string }
interface Comparison {
  matter: { matterRef: string; propertyAddress: string; handler: string | null; shadowMode: boolean } | null;
  engine: { stage: string; stageHistory: Array<{ stage: string; at: string }>; shadowMode: boolean; decisions: Array<DecisionRow & { subFlow: string | null; hiddenBy: 'matter' | 'subflow' | null; reviews: Review[] }>; suppressed: Array<{ eventId: string; seq: number; at: string; action: string; reason: string; subFlow: string | null; detail: Record<string, unknown> }>; autoClears: Array<{ eventId: string; at: string; type: string; subject: string | null; reviews: Review[] }> };
  human: { stage: string | null; stageEnteredAt: string | null; timeline: Array<{ at: string; type: string; title: string; details: string | null }>; tasks: Array<{ ref: string; detail: string | null; status: string | null; at: string }> };
  subflows: Record<string, string>;
  shadowModeChanges: Array<{ at: string; by: string; shadowMode: boolean; reason: string | null }>;
  summary: { conclusions: number; reviewed: number; agreed: number; disagreed: number; suppressed: number };
}

const CSS = `
.cmp{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px}
@media (max-width:800px){.cmp{grid-template-columns:1fr}}
.cmp h2{font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748b;margin:0 0 8px}
.cmp-item{padding:10px 12px;border-bottom:1px solid #f1f5f9}
.cmp-item:last-child{border-bottom:0}
.cmp-item .k{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#b45309}
.cmp-item .s{font-size:13px;margin-top:4px;white-space:pre-wrap;max-height:120px;overflow:auto}
.cmp-item .m{font-size:11.5px;color:#94a3b8;margin-top:4px}
.cmp-verdict{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px}
.cmp-row{font-size:12.5px;padding:6px 0;border-bottom:1px solid #f1f5f9;display:flex;gap:10px}
.cmp-row .t{color:#94a3b8;min-width:96px;font-variant-numeric:tabular-nums}
`;

export default function ShadowComparisonPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = use(params);
  const [c, setC] = useState<Comparison | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { agrees: boolean | null; humanOutcome: string; note: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setC(await api<Comparison>(`/matters/${matterId}/engine/shadow`));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the comparison.');
    }
  }, [matterId]);
  useEffect(() => {
    void load();
  }, [load]);

  const review = async (eventId: string, agrees: boolean) => {
    const d = draft[eventId] ?? { agrees: null, humanOutcome: '', note: '' };
    setBusy(eventId);
    try {
      await api(`/matters/${matterId}/engine/shadow`, { method: 'POST', body: JSON.stringify({ eventId, agrees, humanOutcome: d.humanOutcome || null, note: d.note || null }) });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not record the review.');
    } finally {
      setBusy(null);
    }
  };
  const toggleShadow = async (on: boolean) => {
    const reason = window.prompt(on ? 'Why put this matter back into shadow mode?' : 'Why take this matter out of shadow mode? (recorded on the log)') ?? '';
    if (!on && !reason.trim()) return;
    setBusy('shadow');
    try {
      await api(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify({ type: 'set_shadow_mode', shadowMode: on, reason: reason || null }) });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not switch shadow mode.');
    } finally {
      setBusy(null);
    }
  };

  const Verdict = ({ eventId, reviews }: { eventId: string; reviews: Review[] }) => {
    const d = draft[eventId] ?? { agrees: null, humanOutcome: '', note: '' };
    const mine = reviews[0];
    return (
      <div className="cmp-verdict">
        {mine && <span className={`eg-chip ${mine.agrees ? 'ok' : 'bad'}`}>{mine.agrees ? 'agrees' : 'disagrees'}{mine.humanOutcome ? ` · ${mine.humanOutcome}` : ''}</span>}
        <input className="eg-in" style={{ width: 200, padding: '4px 8px', fontSize: 12 }} placeholder="What the handler actually did…" value={d.humanOutcome} onChange={(e) => setDraft((x) => ({ ...x, [eventId]: { ...d, humanOutcome: e.target.value } }))} />
        <button className="eg-btn" style={{ padding: '4px 9px', fontSize: 12 }} disabled={busy === eventId} onClick={() => review(eventId, true)}>Agrees</button>
        <button className="eg-btn danger" style={{ padding: '4px 9px', fontSize: 12 }} disabled={busy === eventId} onClick={() => review(eventId, false)}>Disagrees</button>
      </div>
    );
  };

  const rate = c && c.summary.reviewed ? Math.round((c.summary.agreed / c.summary.reviewed) * 100) : null;
  return (
    <div className="eg" style={{ maxWidth: 1180, margin: '0 auto', padding: '16px 16px 40px' }}>
      <style>{ENGINE_CSS + CSS}</style>
      {c?.engine.shadowMode && (
        <div className="eg-shadow-banner"><b>Shadow mode</b><span>Internal comparison: the engine's conclusions against the human record. Nothing here reached the client or the other side.</span></div>
      )}
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">{c?.matter?.propertyAddress ?? 'Comparison'}</h1>
          <p className="eg-sub">{c?.matter?.matterRef}{c?.matter?.handler ? ` · ${c.matter.handler}` : ''} · <a href={`/engine/${matterId}`}>timeline</a> · <a href="/engine/shadow">rollout board</a></p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {c && (c.engine.shadowMode ? <button className="eg-btn accent" disabled={busy === 'shadow'} onClick={() => toggleShadow(false)}>Take out of shadow mode</button> : <button className="eg-btn" disabled={busy === 'shadow'} onClick={() => toggleShadow(true)}>Put into shadow mode</button>)}
        </div>
      </div>
      {err && <div className="eg-err">{err}</div>}
      {c && (
        <>
          <div className="eg-tiles">
            <div className="eg-tile"><b>{c.summary.conclusions}</b><span>engine conclusions</span></div>
            <div className="eg-tile"><b>{c.summary.reviewed}</b><span>reviewed by a person</span></div>
            <div className="eg-tile"><b>{rate === null ? '—' : `${rate}%`}</b><span>agreement</span></div>
            <div className="eg-tile"><b>{c.summary.disagreed}</b><span>disagreements</span></div>
            <div className="eg-tile"><b>{c.summary.suppressed}</b><span>actions not performed</span></div>
          </div>
          <div className="cmp">
            <div>
              <h2>Engine's conclusions</h2>
              <div className="eg-card" style={{ marginBottom: 12 }}>
                <div className="cmp-item">
                  <div className="k">Stage</div>
                  <div className="s"><span className="eg-chip stage">{STAGE_LABEL[c.engine.stage] ?? c.engine.stage}</span> <span className="m" style={{ display: 'inline' }}>{c.engine.stageHistory.map((h) => `${STAGE_LABEL[h.stage] ?? h.stage} ${fmtWhen(h.at)}`).join(' → ')}</span></div>
                </div>
                {c.engine.decisions.map((d) => (
                  <div className="cmp-item" key={d.eventId}>
                    <div className="k">{KIND_LABEL[d.kind] ?? pretty(d.kind)}{d.subject ? ` · ${d.subject.replace(/^[a-z_]+:/, '')}` : ''} {d.hiddenBy && <span className="eg-chip shadow" style={{ marginLeft: 6 }}>hidden ({d.hiddenBy})</span>}</div>
                    <div className="s">{d.summary}</div>
                    <div className="m">{fmtWhen(d.createdAt)} · {d.status} · <a href={`/decisions/${d.eventId}`}>open</a></div>
                    <Verdict eventId={d.eventId} reviews={d.reviews} />
                  </div>
                ))}
                {c.engine.autoClears.map((a) => (
                  <div className="cmp-item" key={a.eventId}>
                    <div className="k" style={{ color: '#15803d' }}>Auto-clear · {pretty(a.type.replace(/_cleared$/, ''))}{a.subject ? ` · ${a.subject}` : ''}</div>
                    <div className="m">{fmtWhen(a.at)} · the engine found nothing needing a person</div>
                    <Verdict eventId={a.eventId} reviews={a.reviews} />
                  </div>
                ))}
                {c.engine.decisions.length + c.engine.autoClears.length === 0 && <div className="cmp-item eg-sub">No conclusions yet.</div>}
              </div>
              <h2>Actions the engine would have taken</h2>
              <div className="eg-card">
                {c.engine.suppressed.length === 0 && <div className="cmp-item eg-sub">None suppressed yet.</div>}
                {c.engine.suppressed.map((s) => (
                  <div className="cmp-row" key={s.eventId} style={{ padding: '8px 12px' }}>
                    <span className="t">{fmtWhen(s.at)}</span>
                    <span><b>{pretty(s.action)}</b>{s.subFlow ? ` · ${SUBFLOW_LABEL[s.subFlow] ?? s.subFlow}` : ''} · {pretty(s.reason)} <span style={{ color: '#94a3b8' }}>{Object.entries(s.detail).map(([k, v]) => `${k}=${String(v)}`).join(' ')}</span></span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h2>Human record</h2>
              <div className="eg-card" style={{ marginBottom: 12 }}>
                <div className="cmp-item">
                  <div className="k">Stage on the board</div>
                  <div className="s">{c.human.stage ? <span className="eg-chip stage">{pretty(c.human.stage.toLowerCase())}</span> : <span className="eg-sub">not set</span>} {c.human.stageEnteredAt && <span className="m" style={{ display: 'inline' }}>since {fmtWhen(c.human.stageEnteredAt)}</span>}</div>
                </div>
                <div className="cmp-item">
                  <div className="k">Tasks</div>
                  {c.human.tasks.length === 0 && <div className="eg-sub">No tasks recorded.</div>}
                  {c.human.tasks.map((t) => (
                    <div className="cmp-row" key={t.ref}><span className="t">{fmtWhen(t.at)}</span><span><b>{t.ref}</b> {t.detail} <span className="eg-chip muted">{t.status ?? ''}</span></span></div>
                  ))}
                </div>
                <div className="cmp-item">
                  <div className="k">Activity</div>
                  {c.human.timeline.length === 0 && <div className="eg-sub">No activity recorded.</div>}
                  {c.human.timeline.map((t, i) => (
                    <div className="cmp-row" key={i}><span className="t">{fmtWhen(t.at)}</span><span><b>{t.title}</b> {t.details ? <span style={{ color: '#64748b' }}>— {t.details}</span> : null}</span></div>
                  ))}
                </div>
              </div>
              <h2>Shadow-mode history</h2>
              <div className="eg-card">
                {c.shadowModeChanges.map((s, i) => (
                  <div className="cmp-row" key={i} style={{ padding: '8px 12px' }}><span className="t">{fmtWhen(s.at)}</span><span>{s.shadowMode ? 'shadow on' : 'shadow off'}{s.reason ? ` — ${s.reason}` : ''}</span></div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
