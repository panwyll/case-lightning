'use client';
import { useState } from 'react';
import type { CaseModel } from './CaseView';
import { House } from './CaseloadMap';
import { HEALTH_LABEL, fmtDay, pretty, type EngineEvent, type HealthBand, type HealthReason } from './types';

/**
 * Case intelligence (docs/caseload-ux.md §3) — the screen a conveyancer lands on.
 * It answers, in this order and without being asked:
 *   where are we · what is complete · what needs attention (and why) · what are we
 *   waiting for (and when does it get chased) · what happens next · what happened lately.
 *
 * The richer dependency graph still exists, one tab further in, as a diagnostic.
 */
const CI_CSS = `
.ci h3{font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;margin:22px 0 8px}
.ci-marks{display:flex;flex-wrap:wrap;gap:6px}
.ci-mark{display:inline-flex;align-items:center;gap:6px;border:1px solid #e6e8ee;background:#fff;border-radius:999px;padding:5px 11px;font-size:12.5px}
.ci-mark .g{font-size:13px;width:14px;text-align:center}
.ci-mark.done{background:#f0fdf4;border-color:#bbf7d0;color:#14532d}
.ci-mark.risk{background:#fffbeb;border-color:#fde68a;color:#92400e}
.ci-mark.blocked{background:#fef2f2;border-color:#fecaca;color:#991b1b}
.ci-mark.na{color:#cbd5e1}
.ci-card{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.ci-row{width:100%;display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-top:1px solid #f1f5f9;background:none;border-left:0;border-right:0;border-bottom:0;font-family:inherit;text-align:left;cursor:pointer}
.ci-row:first-child{border-top:0}
.ci-row:hover{background:#fafafa}
.ci-row .h{font-size:13px;font-weight:600;line-height:1.35}
.ci-row .m{font-size:11.5px;color:#94a3b8;margin-top:2px}
.ci-why{background:#fafafa;border-top:1px solid #f1f5f9;padding:10px 13px 13px 44px;font-size:12.5px;color:#334155}
.ci-why ol{margin:0;padding-left:18px}
.ci-why li{margin:3px 0}
.ci-why .sug{margin-top:9px;padding:8px 10px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;color:#4c1d95}
.ci-wait{display:flex;gap:12px;align-items:baseline;padding:9px 13px;border-top:1px solid #f1f5f9;font-size:12.5px;flex-wrap:wrap}
.ci-wait:first-child{border-top:0}
.ci-wait .w{font-weight:600;flex:1;min-width:150px}
.ci-wait .c{color:#64748b;font-variant-numeric:tabular-nums;font-size:11.5px}
.ci-wait .due{color:#b45309;font-weight:700}
.ci-act{display:flex;gap:10px;align-items:baseline;padding:9px 13px;border-top:1px solid #f1f5f9;font-size:12.5px}
.ci-act:first-child{border-top:0}
.ci-act .who{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#94a3b8;min-width:88px}
.ci-feed{font-size:12.5px}
.ci-feed div{padding:6px 13px;border-top:1px solid #f1f5f9;display:flex;gap:10px}
.ci-feed div:first-child{border-top:0}
.ci-feed .d{color:#94a3b8;min-width:74px;font-variant-numeric:tabular-nums}
.ci-ok{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:12px 14px;font-size:13px;color:#14532d}
`;

const MARK: Record<string, { g: string; cls: string }> = {
  complete: { g: '✓', cls: 'done' },
  in_progress: { g: '●', cls: '' },
  awaiting: { g: '●', cls: '' },
  not_started: { g: '○', cls: '' },
  under_review: { g: '⚠', cls: 'risk' },
  at_risk: { g: '⚠', cls: 'risk' },
  blocked: { g: '⛔', cls: 'blocked' },
  not_applicable: { g: '—', cls: 'na' },
};

const WHO: Record<string, string> = { system: 'Us', conveyancer: 'Us', client: 'Client', third_party: 'Third party', seller_side: 'Other side', lender: 'Lender', mlro: 'MLRO' };

/** What actually happened, in a sentence a person would say. Noise (projections, suppressions) is left out. */
function activityLine(e: EngineEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  switch (e.type) {
    case 'enquiry_reply_received': return `Reply received to enquiry ${s('enquiryId')}`;
    case 'enquiry_raised': return `Enquiry ${s('enquiryId')} raised — ${s('subject')}`;
    case 'search_returned': return `${s('searchType')} search returned`;
    case 'search_ordered': return `${s('searchType')} search ordered`;
    case 'search_cleared': return `${s('searchType')} search reviewed and cleared`;
    case 'search_flagged': return `${s('searchType')} search flagged for review`;
    case 'title_extracted': return 'Official copies read';
    case 'title_cleared': return 'Title cleared';
    case 'title_flagged': return 'Title flagged for review';
    case 'mortgage_offer_received': return 'Mortgage offer received';
    case 'mortgage_offer_cleared': return 'Mortgage offer checked and clear';
    case 'mortgage_condition_flagged': return 'Mortgage condition flagged';
    case 'mortgage_offer_withdrawn': return 'Mortgage offer withdrawn';
    case 'id_check_cleared': return 'ID / AML cleared';
    case 'id_check_flagged': return 'ID / AML flagged';
    case 'proof_of_funds_submitted': return 'Client submitted the proof-of-funds form';
    case 'proof_of_funds_reviewed': return `Source of funds ${pretty(s('resolution') || 'reviewed')}`;
    case 'management_pack_received': return 'Management pack received';
    case 'property_forms_received': return 'Property forms received from the client';
    case 'contract_pack_sent': return 'Contract pack sent';
    case 'buyer_enquiries_received': return "Buyer's enquiries received";
    case 'enquiry_replies_sent': return 'Replies to enquiries sent';
    case 'redemption_statement_received': return 'Redemption statement received';
    case 'lender_consent_received': return "Lender's consent received";
    case 'chase_sent': return `Chased ${pretty(s('recipientRole') || 'the other side')}`;
    case 'escalation_raised': return `Escalated: ${s('reason') || pretty(s('waitKey'))}`;
    case 'issue_raised': return `Issue raised — ${s('title')}`;
    case 'issue_resolved': return `Issue resolved — ${pretty(s('resolution'))}`;
    case 'report_on_title_sent': return 'Report on title sent to the client';
    case 'contracts_exchanged': return `Contracts exchanged — completion ${s('completionDate')}`;
    case 'completion_confirmed': return 'Completion confirmed';
    case 'funds_received': return `Funds received from ${pretty(s('fromRole'))}`;
    case 'stage_advanced': return `Moved to ${pretty(s('to'))}`;
    case 'client_decision_recorded': return `Client decided: ${pretty(s('subject'))} — ${pretty(s('decision'))}`;
    default: return null;
  }
}

function Reason({ r }: { r: HealthReason }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="ci-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <House band={r.band as HealthBand} size={24} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <div className="h">{r.headline}</div>
          <div className="m">{HEALTH_LABEL[r.band as HealthBand]}{r.workstream ? ` · ${pretty(r.workstream)}` : ''}{r.ageWorkingDays != null ? ` · ${r.ageWorkingDays} working days` : ''}{r.dueInWorkingDays != null ? ` · ${r.dueInWorkingDays} working days left` : ''}</div>
        </span>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{open ? 'Hide' : 'Why?'}</span>
      </button>
      {open && (
        <div className="ci-why">
          <ol>{r.why.map((w, i) => <li key={i}>{w}</li>)}</ol>
          {r.suggested && <div className="sug"><b>Suggested next action:</b> {r.suggested}</div>}
        </div>
      )}
    </div>
  );
}

export function CaseIntelligence({ m, events, onDiagnostics }: { m: CaseModel; events: EngineEvent[]; onDiagnostics?: () => void }) {
  const health = m.health;
  const gateId = (m.profile?.gates ?? ['exchange']).find((g) => m.gates[g] && !m.gates[g].ready) ?? (m.profile?.gates ?? ['close']).slice(-1)[0];
  const g = m.gates[gateId];
  const waiting = (m.work ?? []).filter((w) => w.bucket === 'waiting' || w.bucket === 'chase');
  // Newest first, with runs of the same thing collapsed — four searches chased in one
  // sweep is one line that says so, not four lines that bury the rest.
  const activity: Array<{ e: EngineEvent; line: string; times: number }> = [];
  for (const e of events.slice().sort((a, b) => b.seq - a.seq)) {
    const line = activityLine(e);
    if (!line) continue;
    const last = activity[activity.length - 1];
    if (last && last.line === line && last.e.createdAt.slice(0, 10) === e.createdAt.slice(0, 10)) last.times += 1;
    else if (activity.length < 8) activity.push({ e, line, times: 1 });
    else break;
  }

  return (
    <div className="ci">
      <style>{CI_CSS}</style>

      {/* Where are we — every workstream, one glyph each. */}
      <h3>Where we are</h3>
      <div className="ci-marks">
        {m.workstreams.filter((w) => w.status !== 'not_applicable').map((w) => {
          const mk = MARK[w.status] ?? { g: '●', cls: '' };
          return (
            <span key={w.id} className={`ci-mark ${mk.cls}`} title={w.detail}>
              <span className="g">{mk.g}</span>{w.label}
            </span>
          );
        })}
      </div>

      {/* What needs attention, and why. */}
      <h3>{health && health.reasons.length ? `Needs attention (${health.reasons.length})` : 'Needs attention'}</h3>
      {!health || health.reasons.length === 0 ? (
        <div className="ci-ok">Nothing is overdue, blocked or near a deadline. This case is moving normally{health ? ` — ${health.pace.inStage} working days in this phase, ${health.pace.expected} is typical.` : '.'}</div>
      ) : (
        <div className="ci-card">{health.reasons.map((r, i) => <Reason key={`${r.code}:${r.ref.id}:${i}`} r={r} />)}</div>
      )}

      {/* What are we waiting for. */}
      <h3>Waiting for ({waiting.length})</h3>
      {waiting.length === 0 ? (
        <div className="eg-empty" style={{ padding: 16 }}>Nothing is outstanding with anyone else — the next move is ours.</div>
      ) : (
        <div className="ci-card">
          {waiting.map((w) => (
            <div key={w.id} className="ci-wait">
              <span className="w">{w.what}</span>
              <span className="c">{w.sinceWorkingDays != null ? `${w.sinceWorkingDays}d elapsed` : ''}{w.slaWorkingDays != null ? ` · SLA ${w.slaWorkingDays}d` : ''}{w.chasesSent ? ` · ${w.chasesSent} chased` : ''}</span>
              <span className={w.chaseInWorkingDays != null && w.chaseInWorkingDays <= 0 ? 'due' : 'c'}>
                {w.escalated ? 'escalated' : w.chaseInWorkingDays == null ? '' : w.chaseInWorkingDays <= 0 ? 'chase due now' : `chase in ${w.chaseInWorkingDays}d`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* What happens next. */}
      <h3>What happens next</h3>
      {g?.ready ? (
        <div className="ci-ok"><b>{g.label}.</b> Every requirement for this milestone is satisfied.</div>
      ) : m.nextActions.length === 0 ? (
        <div className="eg-empty" style={{ padding: 16 }}>Nothing outstanding for this milestone.</div>
      ) : (
        <div className="ci-card">
          {m.nextActions.slice(0, 8).map((a, i) => (
            <div key={i} className="ci-act">
              <span className="who">{WHO[a.who] ?? pretty(a.who)}</span>
              <span style={{ flex: 1 }}>{a.what}<div className="m" style={{ color: '#94a3b8', fontSize: 11.5 }}>unblocks {a.unblocks.toLowerCase()}</div></span>
            </div>
          ))}
        </div>
      )}

      {/* What happened lately. */}
      <h3>Recent activity</h3>
      {activity.length === 0 ? (
        <div className="eg-empty" style={{ padding: 16 }}>Nothing has happened on this matter yet.</div>
      ) : (
        <div className="ci-card ci-feed">
          {activity.map(({ e, line, times }) => (
            <div key={e.id}><span className="d">{fmtDay(e.createdAt)}</span><span>{line}{times > 1 ? ` ×${times}` : ''}</span></div>
          ))}
        </div>
      )}

      {onDiagnostics && (
        <p className="eg-sub" style={{ marginTop: 18 }}>
          Need the full picture? <button className="eg-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onDiagnostics}>Open diagnostics</button> — every requirement, dependency and issue chain behind this case.
        </p>
      )}
    </div>
  );
}
