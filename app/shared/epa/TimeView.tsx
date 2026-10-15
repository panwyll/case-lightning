'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { paths } from '@/lib/paths';
import { flushAttention } from '@/app/shared/epa/useAttention';
import type { EpaReport, ParetoBar, RagSplit } from '@/lib/server/epa/report';
import { EPA_SPEC, type EpaKind } from '@/lib/server/epa/taxonomy';

/**
 * Analytics → Time (docs/epa.md §3), for action: this week's red / amber / green, the Pareto of red and amber, and what to
 * automate or delegate. Week By Week sits at the foot of Analytics. The whole firm only, never one person.
 */
const CSS = `
.tv{max-width:1360px}
.tv-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.tv-head h1{font-size:21px;font-weight:800;margin:0}
.tv h2{font-size:15px;font-weight:800;margin:0;color:#0f172a}
.tv-card{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:18px 20px}
.tv-cardhead{display:flex;align-items:baseline;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.tv-cardhead .r{margin-left:auto;font-size:12.5px;color:#64748b;font-weight:700}
.tv-top{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:16px;margin-top:16px}
.tv-green{background:#1E8E4E}.tv-amber{background:#E39A2D}.tv-red{background:#D64A3A}
.tv-week{display:flex;gap:22px;align-items:stretch;height:300px}
.tv-vstack{width:120px;flex:none;display:flex;flex-direction:column;gap:2px}
.tv-vstack > span{display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px;min-height:0;overflow:hidden}
.tv-vstack > span.tv-amber{color:#3b2405}
.tv-vstack > span:first-child{border-radius:8px 8px 0 0}
.tv-vstack > span:last-child{border-radius:0 0 8px 8px}
.tv-vstack > span:only-child{border-radius:8px}
.tv-legend{display:flex;flex-direction:column;justify-content:center;gap:16px;font-size:14px}
.tv-legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:8px;vertical-align:-1px}
.tv-legend b{font-weight:800}
.tv-legend span{color:#475569;margin-left:4px}
.tv-legend .tv-tip{color:#e2e8f0;margin-left:0;font-size:12px}
.tv-legend .tot{font-size:13px;color:#64748b;font-weight:700;border-top:1px solid #eef0f4;padding-top:12px}
.tv-pareto{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:8px}
.tv-pcol{position:relative;display:flex;flex-direction:column;cursor:default}
.tv-pbar{display:flex;flex-direction:column;justify-content:flex-end;height:212px;border-bottom:1px solid #e6e8ee}
.tv-pbar i{display:block;border-radius:4px 4px 0 0;min-height:2px}
.tv-pbar small{display:block;text-align:center;font-size:11.5px;font-weight:800;color:#0f172a;margin-bottom:4px}
.tv-plabel{font-size:11.5px;font-weight:700;color:#475569;text-align:center;line-height:1.25;margin-top:8px;min-height:44px;hyphens:auto;overflow-wrap:break-word}
.tv-pcol:hover i{filter:brightness(.92)}
.tv-pcol:hover .tv-plabel{color:#0f172a}
.tv-tipped{position:relative}
.tv-tip{display:none;position:absolute;z-index:30;width:250px;background:#0f172a;color:#e2e8f0;border-radius:9px;padding:10px 12px;font-size:12px;font-weight:500;line-height:1.45;text-align:left;pointer-events:none;box-shadow:0 8px 24px rgba(15,23,42,.18)}
.tv-tip b{display:block;color:#fff;font-weight:800;font-size:12.5px;margin-bottom:3px}
.tv-tipped:hover .tv-tip,.tv-tipped:focus-within .tv-tip{display:block}
.tv-legend .tv-tip{bottom:calc(100% + 6px);left:0}
.tv-legend .tv-tipped{cursor:default}
.tv-actions{margin-top:16px}
.tv-row{display:grid;grid-template-columns:330px 64px 64px 72px minmax(0,1fr);gap:14px;align-items:center;padding:10px 0;border-bottom:1px solid #f1f3f7;font-size:13.5px}
.tv-row:last-child{border-bottom:0}
.tv-row.th{font-size:12px;font-weight:800;color:#64748b;padding-top:0}
.tv-row .num{text-align:right;font-variant-numeric:tabular-nums}
.tv-row .k{display:flex;align-items:center;gap:9px;font-weight:800}
.tv-row .k i{width:10px;height:10px;border-radius:3px;flex:none}
.tv-do{display:flex;gap:8px;flex-wrap:wrap}
.tv-do a,.tv-do span{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;border-radius:8px;padding:6px 11px;text-decoration:none;white-space:nowrap}
.tv-do a{background:#5A27E0;color:#fff}
.tv-do a:hover{background:#4A1FC0}
.tv-do span{background:#f1f5f9;color:#334155}
.tv-weeks{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:14px;align-items:end;height:260px}
.tv-col{display:flex;flex-direction:column;gap:2px;height:100%}
.tv-col > span{display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:800;min-height:0;overflow:hidden}
.tv-col > span.tv-amber{color:#3b2405}
.tv-col > span:first-child{border-radius:5px 5px 0 0}
.tv-col > span:last-child{border-radius:0 0 5px 5px}
.tv-col.empty{background:#f1f5f9;border-radius:5px}
.tv-wklabels{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:14px;margin-top:8px;font-size:12px;color:#64748b;font-weight:700;text-align:center}
.tv-keys{display:flex;gap:18px;font-size:12.5px;font-weight:700;color:#334155}
.tv-keys i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.tv-none{color:#64748b;font-size:13.5px;padding:8px 0}
.tv-err{color:#b91c1c;font-size:13px;margin-top:12px}
@media (max-width:1100px){.tv-top{grid-template-columns:1fr}.tv-row{grid-template-columns:160px 56px 56px 64px}.tv-row > :last-child{grid-column:1/-1}}
`;

const RAG = [['green', 'Green'], ['amber', 'Amber'], ['red', 'Red']] as const;
/** How a piece of work gets its colour (docs/epa-categories.md). */
const RULE: Record<'green' | 'amber' | 'red', string> = {
  green: 'Moves the case on, and only a conveyancer can do it.',
  amber: 'Moves the case on but someone other than a conveyancer could do it, or needs a conveyancer but does not move the case on.',
  red: 'Does not need a lawyer, and does not move the case on.',
};
const pct = (x: number) => `${Math.round(x * 100)}%`;
const hrs = (x: number) => (x > 0 && x < 0.05 ? '<0.1h' : `${x.toFixed(1)}h`);
const mins = (x: number | null) => (x == null ? '—' : x < 1 ? '<1 min' : `${Math.round(x)} min`);
const day = (iso: string, plus = 0) => new Date(Date.parse(iso) + plus * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const title = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const split = (s: RagSplit) => RAG.map(([k, l]) => `${l} ${pct(s[k])}`).join(' · ');
/** Under a Pareto bar: the work written out, where the full label would not fit; the hover card has the rest. */
const SHORT: Partial<Record<EpaKind, string>> = {
  client_chasers: 'Chasing Clients', other_side_chasers: 'Chasing The Other Side', lender_chasers: 'Chasing Lenders', agent_chasers: 'Chasing Agents',
  third_party_chasers: 'Chasing Third Parties', client_any_news: 'Answering Client Status Requests', agent_status_requests: 'Answering Agent Status Requests',
  other_side_status_requests: 'Answering Other Side Status Requests', lender_broker_status_requests: 'Answering Lender Status Requests',
  client_updates: 'Proactive Client Updates', agent_updates: 'Proactive Agent Updates', other_side_updates: 'Proactive Other Side Updates',
  lender_broker_updates: 'Proactive Lender Updates', resending_to_client: 'Resending Documents To Clients', resending_to_others: 'Resending Documents To Others',
  first_requests_client: 'Asking Clients For Documents', first_requests_others: 'Asking Others For Documents', sending_documents_client: 'Sending New Documents To Clients',
  sending_documents_others: 'Sending New Documents To Others', acknowledging: 'Sending Acknowledge­ments', filing: 'Filing Emails And Documents',
  recording_receipts: 'Recording Receipts', notes_and_outcomes: 'Writing File Notes', opening_the_case: 'Opening Cases', ordering_searches: 'Ordering Searches',
  land_registry_applications: 'Land Registry Applications', sdlt_return: 'SDLT Returns', closing_the_file: 'Closing Files', failed_sends: 'Resending Failed Emails',
  unlocking_files: 'Unlocking Protected Files', client_process_questions: 'Client Process Questions', arranging_dates: 'Completion Dates And Calls',
  bank_details: 'Verifying Bank Details', requesting_funds: 'Requesting Completion Funds', checking_drafts: 'Checking CONVEYi Drafts',
  client_legal_questions: 'Client Legal Questions', payments: 'Authorising Payments', difficult_emails: 'Complaints And Difficult Emails',
};
/** The biggest this many; the rest are in the Actions table. A lumped "Other" bar would tower over the categories it hides. */
const PARETO_BARS = 8;
/** The CONVEYi actions, as the Actions column names them. */
const ACTION_NAME: Record<string, string> = { chase: 'Chases', client_update: 'Client Updates', counterparty_update: 'Updates To Others', acknowledgement: 'Acknowledgements', search_order: 'Search Orders' };
/** Where the fix is to stop it happening, what that is. */
const PREVENT: Partial<Record<EpaKind, string>> = { client_any_news: 'Give Clients The Portal', resending_to_client: 'Send Documents As Secure Links', client_process_questions: 'Give Clients The Portal' };

/** What to do about a bar: switch the CONVEYi action that takes it to Send, stop it happening, or hand it to an assistant. */
function actionsFor(b: ParetoBar): Array<{ text: string; href?: string }> {
  if (b.kind === 'checking_drafts') {
    const open = [...new Set((b.parts ?? []).filter((p) => p.action && p.level !== 'auto').map((p) => p.action!))];
    return open.length ? open.map((a) => ({ text: `Set ${ACTION_NAME[a] ?? title(a.replace(/_/g, ' '))} To Send`, href: paths.rules })) : [{ text: 'Delegate To An Assistant' }];
  }
  if (b.action && !b.action.sendsUnasked) return [{ text: `Set ${ACTION_NAME[b.action.key] ?? title(b.action.label)} To Send`, href: paths.rules }];
  const remedy = EPA_SPEC[b.kind].remedy;
  if (remedy === 'prevent' && PREVENT[b.kind]) return [{ text: PREVENT[b.kind]! }];
  if (remedy === 'keep') return [{ text: b.kind === 'payments' ? 'Delegate The Preparation' : 'Keep: Make It Faster' }];
  return [{ text: 'Delegate To An Assistant' }];
}

function useReport() {
  const [r, setR] = useState<EpaReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void flushAttention().then(() => api<{ report: EpaReport }>('/epa').then((x) => setR(x.report)).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the figures.')));
  }, []);
  return { r, err };
}

function Shell({ tabs, err, loading, children }: { tabs: ReactNode; err: string | null; loading: boolean; children: ReactNode }) {
  return (
    <div className="tv">
      <style>{ENGINE_CSS + CSS}</style>
      <div className="tv-head"><h1>Analytics</h1>{tabs}</div>
      {err && <p className="tv-err">{err}</p>}
      {loading && !err && <p className="tv-none">Loading…</p>}
      {children}
    </div>
  );
}

export function TimeView({ tabs }: { tabs: ReactNode }) {
  const { r, err } = useReport();
  const w = r?.week ?? null;
  const total = w ? w.hours.green + w.hours.amber + w.hours.red : 0;
  const pareto = r?.pareto ?? [];
  const bars = pareto.slice(0, PARETO_BARS);
  const top = Math.max(0.0001, ...bars.map((b) => b.hours));
  return (
    <Shell tabs={tabs} err={err} loading={!r}>
      {r && (
        <>
          <div className="tv-top">
            <section className="tv-card">
              <div className="tv-cardhead"><h2>This Week</h2>{w && <span className="r">{day(w.start)} – {day(w.start, 6)}</span>}</div>
              {w?.share ? (
                <div className="tv-week">
                  <div className="tv-vstack" role="img" aria-label={split(w.share)}>
                    {[...RAG].reverse().filter(([k]) => w.share![k] > 0).map(([k, l]) => (
                      <span key={k} className={`tv-${k}`} style={{ flex: `${w.share![k]} 1 0` }} title={`${l}: ${pct(w.share![k])} · ${hrs(w.hours[k])}`}>{w.share![k] >= 0.07 ? pct(w.share![k]) : ''}</span>
                    ))}
                  </div>
                  <div className="tv-legend">
                    {[...RAG].reverse().map(([k, l]) => (
                      <div key={k} className="tv-tipped" tabIndex={0}>
                        <span className="tv-tip" role="tooltip"><b>{l}</b>{RULE[k]}</span>
                        <i className={`tv-${k}`} /><b>{l}</b><span>{pct(w.share![k])} · {hrs(w.hours[k])}</span>
                      </div>
                    ))}
                    <div className="tot">{hrs(total)} Across The Firm</div>
                  </div>
                </div>
              ) : <p className="tv-none">No time recorded yet.</p>}
            </section>

            <section className="tv-card">
              <div className="tv-cardhead"><h2>Pareto</h2></div>
              {!bars.length ? <p className="tv-none">No red or amber time recorded yet.</p> : (
                <>
                  <div className="tv-pareto">
                    {bars.map((b) => (
                      <div key={b.kind} className="tv-pcol">
                        <div className="tv-pbar">
                          <small>{hrs(b.hours)}</small>
                          <i className={`tv-${b.rag}`} style={{ height: `${(b.hours / top) * 180}px` }} />
                        </div>
                        <div className="tv-plabel">{SHORT[b.kind] ?? b.label}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>

          {!!pareto.length && (
            <section className="tv-card tv-actions">
              <div className="tv-cardhead"><h2>Actions</h2></div>
              <div className="tv-row th"><span>Kind</span><span className="num">Hours</span><span className="num">Times</span><span className="num">Each</span><span>Action</span></div>
              {pareto.map((b) => (
                <div key={b.kind} className="tv-row">
                  <span className="k"><i className={`tv-${b.rag}`} />{b.label}</span>
                  <span className="num">{hrs(b.hours)}</span>
                  <span className="num">{b.times}</span>
                  <span className="num">{mins(b.avgMinutes)}</span>
                  <span className="tv-do">{actionsFor(b).map((a) => (a.href ? <a key={a.text} href={a.href}>{a.text}</a> : <span key={a.text}>{a.text}</span>))}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </Shell>
  );
}

/** Week by week, red / amber / green: a card at the foot of Analytics. Comparing weeks is not the action page's job. */
export function WeekByWeek() {
  const { r } = useReport();
  if (!r || !r.weeks.some((w) => w.share)) return null;
  return (
    <section className="tv-card" style={{ marginTop: 14 }}>
      <style>{CSS}</style>
      <div className="tv-cardhead">
        <h2>Week By Week</h2>
        <span className="r tv-keys">{RAG.map(([k, l]) => <span key={k}><i className={`tv-${k}`} />{l}</span>)}</span>
      </div>
      <div className="tv-weeks">
        {r.weeks.map((w) => (w.share
          ? <div key={w.start} className="tv-col" title={`${day(w.start)}: ${split(w.share)}`}>
              {[...RAG].reverse().filter(([k]) => w.share![k] > 0).map(([k]) => <span key={k} className={`tv-${k}`} style={{ flex: `${w.share![k]} 1 0` }}>{w.share![k] >= 0.08 ? pct(w.share![k]) : ''}</span>)}
            </div>
          : <div key={w.start} className="tv-col empty" title={`${day(w.start)}: no time recorded`} />))}
      </div>
      <div className="tv-wklabels">{r.weeks.map((w) => <span key={w.start}>{day(w.start)}</span>)}</div>
    </section>
  );
}
