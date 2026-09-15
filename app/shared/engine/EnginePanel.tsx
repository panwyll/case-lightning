'use client';
import { useCallback, useEffect, useState } from 'react';
import { DecisionFeed } from './DecisionFeed';
import { STAGES, fmtDay, fmtWhen, pretty, type Api, type EngineEvent, type EngineView } from './types';

/**
 * A matter's engine view for the case handler: where it is, what is blocking the next
 * stage, what it is waiting on (with SLA age), the pending decisions, each sub-flow's
 * status, the human commands that are valid now, and the tail of the immutable log.
 */
const CSS = `
.ep{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;font-size:13px}
.ep-steps{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0 12px}
.ep-step{padding:5px 9px;border-radius:999px;font-size:11.5px;font-weight:700;border:1px solid #e2e8f0;color:#94a3b8;background:#fff}
.ep-step.done{background:#f0fdf4;border-color:#86efac;color:#14532d}
.ep-step.now{background:#0f172a;border-color:#0f172a;color:#fff}
.ep-sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#94a3b8;margin:16px 0 6px}
.ep-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
.ep-tile{border:1px solid #e6e8ee;border-radius:10px;padding:8px 10px;background:#fff}
.ep-tile b{display:block;font-size:12px}
.ep-pill{display:inline-block;font-size:10.5px;font-weight:800;border-radius:99px;padding:1px 7px;margin-top:3px}
.ep-btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:6px 10px;font-size:12.5px;cursor:pointer;margin:4px 6px 0 0;font-family:inherit}
.ep-btn.primary{background:#5A27E0;color:#fff;border-color:#5A27E0}
.ep-btn:disabled{opacity:.45;cursor:not-allowed}
.ep-block{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;font-size:12.5px}
.ep-err{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:8px}
.ep-log{font-size:12px;border-top:1px solid #f1f5f9;padding:6px 0;display:flex;gap:8px}
.ep-log .t{color:#94a3b8;min-width:110px}
.ep-log .a{color:#64748b;min-width:70px}
.ep-input{border:1px solid #cbd5e1;border-radius:8px;padding:6px 8px;font-size:12.5px;font-family:inherit;margin-right:6px}
`;

const PILL: Record<string, { bg: string; fg: string }> = {
  cleared: { bg: '#dcfce7', fg: '#14532d' },
  reviewed: { bg: '#dcfce7', fg: '#14532d' },
  flagged: { bg: '#fee2e2', fg: '#7f1d1d' },
  ordered: { bg: '#fef3c7', fg: '#78350f' },
  raised: { bg: '#fef3c7', fg: '#78350f' },
  requested: { bg: '#fef3c7', fg: '#78350f' },
  awaiting: { bg: '#f1f5f9', fg: '#475569' },
  returned: { bg: '#e0e7ff', fg: '#3730a3' },
  extracted: { bg: '#e0e7ff', fg: '#3730a3' },
  replied: { bg: '#e0e7ff', fg: '#3730a3' },
  received: { bg: '#e0e7ff', fg: '#3730a3' },
  drafted: { bg: '#fef3c7', fg: '#78350f' },
  approved: { bg: '#e0e7ff', fg: '#3730a3' },
  sent: { bg: '#dcfce7', fg: '#14532d' },
  not_required: { bg: '#f1f5f9', fg: '#94a3b8' },
  not_started: { bg: '#f1f5f9', fg: '#94a3b8' },
  rejected: { bg: '#fee2e2', fg: '#7f1d1d' },
};
const Pill = ({ s }: { s: string }) => <span className="ep-pill" style={{ background: PILL[s]?.bg ?? '#f1f5f9', color: PILL[s]?.fg ?? '#475569' }}>{pretty(s)}</span>;

const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

export function EnginePanel({ matterId, api, onChanged }: { matterId: string; api: Api; onChanged?: () => void }) {
  const [view, setView] = useState<EngineView | null>(null);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [hasLender, setHasLender] = useState(true);
  const [enquiry, setEnquiry] = useState({ id: '', subject: '' });
  const [completionDate, setCompletionDate] = useState('');

  const load = useCallback(async () => {
    try {
      const v = await api<EngineView>(`/matters/${matterId}/engine`);
      setView(v);
      setErr(null);
      const ev = await api<{ events: EngineEvent[] }>(`/matters/${matterId}/engine/events?limit=2000`);
      setEvents(ev.events.slice(-60).reverse());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the engine view.');
    }
  }, [api, matterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const cmd = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify(body) });
      await load();
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Command failed.');
    } finally {
      setBusy(false);
    }
  };

  if (err && !view) return <div className="ep"><style>{CSS}</style><div className="ep-err">{err}</div></div>;
  if (!view) return <div className="ep"><style>{CSS}</style><div style={{ color: '#94a3b8' }}>Loading the engine…</div></div>;
  const s = view.state;

  if (!s.enrolled) {
    return (
      <div className="ep">
        <style>{CSS}</style>
        <div className="ep-block">
          This matter is not yet run by the conveyancing engine. Enrolling it starts the freehold-purchase state machine: ID/AML, searches (auto-ordered), enquiries, mortgage offer, title, report on title, exchange, completion and registration — with every step logged and only genuine decisions surfaced to you.
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={{ fontSize: 12.5, marginRight: 12 }}><input type="checkbox" checked={hasLender} onChange={(e) => setHasLender(e.target.checked)} /> Buyer has a mortgage lender</label>
          <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'enrol', hasLender })}>Enrol matter (freehold purchase)</button>
        </div>
        {err && <div className="ep-err">{err}</div>}
      </div>
    );
  }

  const stageIdx = STAGES.indexOf(s.stage);
  const openWaits = view.waits;
  return (
    <div className="ep">
      <style>{CSS}</style>
      <div className="ep-steps">
        {STAGES.map((st, i) => (
          <span key={st} className={`ep-step${i < stageIdx ? ' done' : i === stageIdx ? ' now' : ''}`} title={s.stageHistory.find((h) => h.stage === st) ? `entered ${fmtWhen(s.stageHistory.find((h) => h.stage === st)!.at)}` : ''}>{pretty(st)}</span>
        ))}
      </div>
      {s.manualHandling.required && <div className="ep-err">Manual handling required: {pretty(s.manualHandling.reason ?? '')}. Automation is paused on this matter.</div>}
      {view.blockers.length > 0 && (
        <div className="ep-block"><b>Before the next stage:</b> {view.blockers.join(' · ')}</div>
      )}

      {openWaits.length > 0 && (
        <>
          <div className="ep-sec">Waiting on others</div>
          <div className="ep-grid">
            {openWaits.map((w) => (
              <div key={`${w.key}:${w.subject}`} className="ep-tile">
                <b>{pretty(w.key)}{w.subject ? ` · ${w.subject}` : ''}</b>
                <span style={{ color: '#64748b' }}>since {fmtDay(w.openedAt)} ({daysAgo(w.openedAt)}d) · chased {w.chasesSentAt.length}× {w.escalations.some((e) => !e.resolvedAt) ? '· escalated' : ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="ep-sec">Decisions waiting on you ({view.pendingDecisions.length})</div>
      <DecisionFeed api={api} matterId={matterId} compact />

      <div className="ep-sec">Sub-flows</div>
      <div className="ep-grid">
        <div className="ep-tile"><b>ID / AML</b><Pill s={s.idCheck.status} /></div>
        {s.requiredSearches.map((t) => {
          const sr = s.searches[t];
          return <div key={t} className="ep-tile"><b>{t} search</b>{sr ? <Pill s={sr.status} /> : <Pill s="not_started" />}{sr?.flags.length ? <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 3 }}>{sr.flags.map((f) => f.code).join(', ')}</div> : null}</div>;
        })}
        {Object.values(s.enquiries).map((q) => (
          <div key={q.enquiryId} className="ep-tile"><b>Enquiry {q.enquiryId}</b><Pill s={q.status} /><div style={{ fontSize: 11.5, color: '#64748b', marginTop: 3 }}>{q.subject}</div></div>
        ))}
        <div className="ep-tile"><b>Mortgage offer{s.mortgage.facts?.lender ? ` · ${s.mortgage.facts.lender}` : ''}</b><Pill s={s.mortgage.status} /></div>
        <div className="ep-tile"><b>Title{s.title.facts?.titleNumber ? ` · ${s.title.facts.titleNumber}` : ''}</b><Pill s={s.title.status} /></div>
        <div className="ep-tile"><b>Report on title</b><Pill s={s.reportOnTitle.status} />{s.reportOnTitle.sentAt ? <div style={{ fontSize: 11.5, color: '#64748b' }}>sent {fmtDay(s.reportOnTitle.sentAt)}</div> : null}</div>
        <div className="ep-tile"><b>Exchange</b><Pill s={s.exchange.exchangedAt ? 'sent' : s.deposit.received ? 'approved' : 'awaiting'} />{s.exchange.completionDate ? <div style={{ fontSize: 11.5, color: '#64748b' }}>completion {s.exchange.completionDate}</div> : null}</div>
        <div className="ep-tile"><b>Completion</b><Pill s={s.completion.confirmedAt ? 'sent' : s.completion.fundsReceivedAt ? 'approved' : s.completion.fundsRequestedAt ? 'requested' : 'awaiting'} /></div>
        <div className="ep-tile"><b>Post-completion</b><Pill s={s.postCompletion.ap1ConfirmedAt ? 'sent' : s.postCompletion.ap1SubmittedAt ? 'requested' : s.postCompletion.sdltSubmittedAt ? 'approved' : 'awaiting'} /></div>
      </div>

      <div className="ep-sec">Actions</div>
      <div>
        {s.stage === 'instruction' && s.idCheck.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'request_id_check' })}>Request ID / AML check</button>}
        {(s.stage === 'pre_contract' || s.stage === 'contract_review') && (
          <span>
            <input className="ep-input" placeholder="Enquiry id (E3)" value={enquiry.id} onChange={(e) => setEnquiry({ ...enquiry, id: e.target.value })} style={{ width: 110 }} />
            <input className="ep-input" placeholder="Subject" value={enquiry.subject} onChange={(e) => setEnquiry({ ...enquiry, subject: e.target.value })} style={{ width: 220 }} />
            <button className="ep-btn" disabled={busy || !enquiry.id || !enquiry.subject} onClick={() => { void cmd({ type: 'raise_enquiry', enquiryId: enquiry.id.trim(), subject: enquiry.subject.trim() }); setEnquiry({ id: '', subject: '' }); }}>Raise enquiry</button>
          </span>
        )}
        {s.stage === 'contract_review' && ['not_started', 'rejected'].includes(s.reportOnTitle.status) && (s.title.status === 'cleared' || s.title.status === 'reviewed') && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'draft_report_on_title' })}>Draft report on title (AI, needs your approval)</button>}
        {s.reportOnTitle.status === 'approved' && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'send_report_on_title' })}>Send approved report to client</button>}
        {['contract_review', 'pre_exchange'].includes(s.stage) && !s.deposit.received && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'deposit_received' })}>Deposit received</button>}
        {s.stage === 'pre_exchange' && s.exchange.conditionsMet && !s.exchange.exchangedAt && (
          <span>
            <input className="ep-input" type="date" value={completionDate} onChange={(e) => setCompletionDate(e.target.value)} />
            <button className="ep-btn primary" disabled={busy || !completionDate} onClick={() => cmd({ type: 'contracts_exchanged', completionDate })}>Contracts exchanged</button>
          </span>
        )}
        {s.stage === 'exchanged' && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'completion_statement_generated' })}>Completion statement generated</button>}
        {s.stage === 'pre_completion' && (
          <span>
            {s.hasLender && !openWaits.some((w) => w.key === 'funds' && w.subject === 'lender') && !s.completion.fundsReceivedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_requested', fromRole: 'lender' })}>Request lender funds</button>}
            {!openWaits.some((w) => w.key === 'funds' && w.subject === 'client') && !s.completion.fundsReceivedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_requested', fromRole: 'client' })}>Request client funds</button>}
            {openWaits.filter((w) => w.key === 'funds').map((w) => <button key={w.subject} className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_received', fromRole: w.subject })}>{pretty(w.subject)} funds received</button>)}
            {s.completion.fundsReceivedAt && !s.completion.confirmedAt && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'completion_confirmed' })}>Completion confirmed</button>}
          </span>
        )}
        {['completed', 'post_completion'].includes(s.stage) && (
          <span>
            {!s.postCompletion.sdltSubmittedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'sdlt_submitted' })}>SDLT submitted</button>}
            {!s.postCompletion.ap1SubmittedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'ap1_submitted' })}>AP1 submitted</button>}
            {s.postCompletion.ap1SubmittedAt && !s.postCompletion.ap1ConfirmedAt && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'ap1_confirmed' })}>Registration confirmed</button>}
          </span>
        )}
        {!s.manualHandling.required && <button className="ep-btn" disabled={busy} onClick={() => { const reason = window.prompt('Why does this matter need manual handling?'); if (reason) void cmd({ type: 'mark_manual_handling', reason }); }}>Take over manually</button>}
      </div>
      {err && <div className="ep-err">{err}</div>}

      <div className="ep-sec" style={{ cursor: 'pointer' }} onClick={() => setShowLog((x) => !x)}>{showLog ? '▾' : '▸'} Event log ({s.lastSeq} events · {s.clientUpdatesSent} client updates · {s.chasesSent} chases)</div>
      {showLog && events.map((e) => (
        <div key={e.id} className="ep-log">
          <span className="t">#{e.seq} {fmtWhen(e.createdAt)}</span>
          <span className="a">{e.actor === 'system' || e.actor === 'ai' || e.actor === 'external' ? e.actor : 'user'}</span>
          <span>{pretty(e.type)}{typeof e.payload.searchType === 'string' ? ` · ${e.payload.searchType}` : ''}{typeof e.payload.enquiryId === 'string' ? ` · ${e.payload.enquiryId}` : ''}{typeof e.payload.to === 'string' ? ` → ${pretty(e.payload.to)}` : ''}{typeof e.payload.option === 'string' ? ` · ${pretty(e.payload.option)}` : ''}</span>
        </div>
      ))}
    </div>
  );
}
