/**
 * Case health — "is this matter where it should be by now, and if not, why?"
 *
 * The product principle (docs/caseload-ux.md): a conveyancer with 80 matters should spot
 * the eight that need them without reading the other 72. So health is NOT case age: a
 * 90-day matter waiting on nothing is healthy, and a 9-day matter whose mortgage offer
 * expires on Friday is not.
 *
 * Health is computed from the same facts the machine already enforces:
 *   • waits    — someone owes us something and the SLA clock has passed chase / escalation
 *   • issues   — something is wrong and it holds a gate
 *   • decisions— a person has to decide and hasn't
 *   • deadlines— something WE owe, with a date (offer expiry, SDLT, notice to complete)
 *   • pace     — time in this phase against what this transaction type should take
 *
 * Every reason carries its causal chain (`why`) so the UI can explain the colour rather
 * than just show it, and a suggested next action. Pure: (state, now) → health.
 */
import { DEFAULT_SLA, DEADLINE_LEAD, deadlineActions, dueActions, type SlaConfig } from './sla';
import { ISSUE_KIND_SPEC, type Workstream } from './issues';
import { awayNow, openIssues, openWaits, pendingDecisions, type MatterState, type Stage, type WaitState } from './types';
import { profileOf } from './transactions';
import { dueSteps } from './due';
import { EW_CALENDAR, workingDaysBetween, type WorkingCalendar } from './working-days';

export const HEALTH_BANDS = ['normal', 'attention', 'delayed', 'blocked', 'critical'] as const;

/**
 * Critical means one of two things, and nothing else:
 *   - the transaction is in jeopardy (a party pulling out, the mortgage gone or going, money
 *     missing on the day, a deadline passed or about to pass, a payment stopped on unverified
 *     bank details); or
 *   - we are the delay, badly: a decision or an issue that is ours has sat far past its time.
 * A report that has just come in and needs reading is a job, not a crisis: it "needs attention".
 * A third party that is slow is "delayed", however slow.
 */
const JEOPARDY: ReadonlySet<string> = new Set(['transaction_at_risk', 'mortgage_offer_expired', 'mortgage_at_risk', 'completion_failure', 'completion_funds_shortfall', 'lender_funds_delayed', 'bankruptcy_insolvency', 'aml_kyc_problem']);
/** Working days a decision of ours may wait before it is our delay, then a serious one. */
const OUR_DELAY = { late: 5, severe: 10 };
/** A newly raised issue is read first: it holds a gate, but for its first days it is a job to pick up. */
const FRESH_ISSUE_DAYS = 3;
export type HealthBand = (typeof HEALTH_BANDS)[number];

/**
 * The colour of a case, by whose move it is and whether anyone is late:
 *   normal (green)    nothing waiting on us, nothing late;
 *   attention (blue)  something waiting on us, all on time;
 *   delayed (yellow)  someone else is late;
 *   blocked (red)     we are late;
 *   critical (black)  both, or the transaction is in jeopardy.
 */
function colourOf(s: MatterState, reasons: HealthReason[], now: Date): HealthBand {
  const issueOf = (r: HealthReason) => (r.ref.type === 'issue' ? s.issues[r.ref.id] : undefined);
  const oursIssue = (r: HealthReason) => { const i = issueOf(r); const who = i ? ISSUE_KIND_SPEC[i.kind]?.responsible : undefined; return !who || who === 'conveyancer' || who === 'mlro'; };
  // The deal itself at risk: a jeopardy issue, or the offer or a notice to complete about to run out.
  const jeopardy = reasons.some((r) => (r.code === 'issue_critical' && JEOPARDY.has(issueOf(r)?.kind ?? '')) || ((r.code === 'deadline_near' || r.code === 'deadline_passed') && r.band === 'critical' && /^(Mortgage offer|Notice to complete)/.test(r.headline)));
  const today = now.toISOString().slice(0, 10);
  const due = dueSteps(s, now);
  const oursLate = reasons.some((r) =>
    r.code === 'issue_stale' || r.code === 'deadline_passed' || r.code === 'hard_stop'
    || (r.code === 'decision_pending' && r.band !== 'attention')
    || (r.code === 'deadline_near' && r.band === 'critical')
    || (r.code === 'issue_critical' && !JEOPARDY.has(issueOf(r)?.kind ?? '')))
    || due.some((d) => !!d.dueDate && d.dueDate < today);
  const theirsLate = reasons.some((r) =>
    r.code === 'wait_overdue' || r.code === 'wait_escalated'
    || (r.code === 'chase_due' && !/ is away$/.test(r.headline))
    || (r.code === 'issue_blocking' && r.band === 'blocked' && !oursIssue(r))
    || (r.code === 'stage_overrun' && r.band === 'delayed'));
  const oursPending = due.length > 0 || reasons.some((r) =>
    r.code === 'manual_handling' || r.code === 'decision_pending' || r.code === 'deadline_near'
    || (r.code === 'issue_blocking' && oursIssue(r)));
  if (jeopardy || (oursLate && theirsLate)) return 'critical';
  if (oursLate) return 'blocked';
  if (theirsLate) return 'delayed';
  if (oursPending) return 'attention';
  return 'normal';
}

/** Worst wins. Critical outranks blocked: a blocked case with a deadline on Friday is the one to ring today. */
export const HEALTH_RANK: Record<HealthBand, number> = { normal: 0, attention: 1, delayed: 2, blocked: 3, critical: 4 };
export const HEALTH_LABEL: Record<HealthBand, string> = {
  normal: 'On Track',
  attention: 'With Us',
  delayed: 'Delayed - Others',
  blocked: 'Delayed - Us',
  critical: 'Critical',
};

export type ReasonCode =
  | 'wait_overdue' | 'wait_escalated' | 'chase_due'
  | 'issue_blocking' | 'issue_critical' | 'issue_stale'
  | 'decision_pending' | 'hard_stop'
  | 'deadline_near' | 'deadline_passed'
  | 'stage_overrun' | 'manual_handling' | 'abandoned' | 'step_due';

export interface HealthReason {
  code: ReasonCode;
  band: HealthBand;
  /** One line, the way a conveyancer would say it: "Seller's solicitor overdue — 3 days". */
  headline: string;
  /** The causal chain, most immediate first. This is what "why is this red?" prints. */
  why: string[];
  /** What the system thinks should happen next. */
  suggested: string | null;
  workstream: Workstream | null;
  ref: { type: 'wait' | 'issue' | 'decision' | 'deadline' | 'stage' | 'matter' | 'step'; id: string };
  /** Working days it has been like this (waits, issues), where that reads naturally. */
  ageWorkingDays?: number;
  /** Working days until the date we owe (deadlines). Negative = passed. */
  dueInWorkingDays?: number;
}

export interface CasePace {
  stage: Stage;
  /** Working days in the CURRENT phase. */
  inStage: number;
  /** What this transaction type should take in this phase. */
  expected: number;
  /** Working days over (0 when inside the expectation). */
  overrun: number;
}

export interface CaseHealth {
  band: HealthBand;
  /** Worst first. The map shows the first; the case view shows them all. */
  reasons: HealthReason[];
  pace: CasePace;
  counts: { waiting: number; chasesDue: number; blockingIssues: number; openIssues: number; decisions: number; deadlines: number };
}

const WAIT_LABEL: Record<string, string> = {
  search: 'Search result',
  enquiry: 'Reply to enquiry',
  id_check: 'ID / AML result',
  funds: 'Completion funds',
  registration: 'HMLR registration',
  proof_of_funds: 'Proof of funds form',
  management_pack: 'Management pack',
  property_forms: 'Property forms',
  redemption: 'Redemption statement',
  lender_consent: "Lender's consent",
  discharge: 'Discharge (DS1)',
};
const PARTY_LABEL: Record<string, string> = {
  seller_solicitor: "the seller's solicitor",
  search_provider: 'the search provider',
  lender: 'the lender',
  client: 'the client',
  id_provider: 'the ID provider',
  hmlr: 'HM Land Registry',
};
const WAIT_WORKSTREAM: Record<string, Workstream> = {
  id_check: 'id_aml', search: 'searches', enquiry: 'enquiries', funds: 'completion', registration: 'registration',
  proof_of_funds: 'source_of_funds', management_pack: 'leasehold', property_forms: 'property_forms',
  redemption: 'redemption', lender_consent: 'lender_consent', discharge: 'discharge',
};
/** How a party is chased when the timer fires — the suggested action escalates with the chase count. */
const chaseAdvice = (party: string, chases: number): string =>
  chases === 0 ? `Chase ${party}` : chases < 3 ? `Chase ${party} again (${chases} sent)` : `Call ${party} — ${chases} written chases have gone unanswered`;

const dayAge = (iso: string, now: Date, cal: WorkingCalendar) => workingDaysBetween(new Date(iso), now, cal);
/** Timer-raised issues carry a "[key:value]" marker so the timer can find them again. Never show it. */
const clean = (title: string) => title.replace(/\s*\[[a-z-]+:[^\]]*\]/g, '').trim();
/** Decision kinds, as a person would say them. */
const DECISION_LABEL: Record<string, string> = {
  id_check: 'ID / AML', search: 'Search result', enquiry: 'Enquiry reply', mortgage: 'Mortgage offer', title: 'Title',
  report_on_title: 'Report on title', escalation: 'Escalation', bank_details: 'Bank details', requisition: 'HMLR requisition',
  proof_of_funds: 'Source of funds', management_pack: 'Management pack', auto_clear: 'Auto-clear review',
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Health of one matter. Deterministic in (state, now). */
export function caseHealth(s: MatterState, now: Date = new Date(), sla: SlaConfig = DEFAULT_SLA, cal: WorkingCalendar = EW_CALENDAR): CaseHealth {
  const reasons: HealthReason[] = [];
  const profile = profileOf(s.transactionType);
  const stage = s.stage;
  const enteredStage = [...s.stageHistory].reverse().find((h) => h.stage === stage)?.at ?? null;
  const inStage = enteredStage ? dayAge(enteredStage, now, cal) : 0;
  const expected = profile.expectedWorkingDays[stage] ?? 10;
  const pace: CasePace = { stage, inStage, expected, overrun: Math.max(0, inStage - expected) };

  const issues = openIssues(s).filter((i) => !ISSUE_KIND_SPEC[i.kind]?.context);
  const waits = openWaits(s);
  const decisions = pendingDecisions(s).filter((d) => d.kind !== 'auto_clear');
  const deadlines = deadlineActions(s, now, cal);
  const due = dueActions(s, now, sla, cal);
  const counts = {
    waiting: waits.length,
    chasesDue: due.filter((d) => d.kind === 'chase').length,
    blockingIssues: issues.filter((i) => i.gate !== 'none').length,
    openIssues: issues.length,
    decisions: decisions.length,
    deadlines: deadlines.length,
  };

  // ── terminal / paused states: say so plainly and stop ──
  if (s.abandoned) {
    return { band: 'blocked', pace, counts, reasons: [{ code: 'abandoned', band: 'blocked', headline: `Abortive — ${s.abandoned.reason.replace(/_/g, ' ')}`, why: [s.abandoned.detail ?? 'The matter was abandoned; only corrections may follow.'], suggested: 'Close the file off and account to the client', workstream: null, ref: { type: 'matter', id: 'abandoned' } }] };
  }
  if (s.closedAt) return { band: 'normal', pace, counts, reasons: [] };
  if (s.manualHandling.required) {
    reasons.push({ code: 'manual_handling', band: 'attention', headline: 'Running manually — automation is paused', why: [s.manualHandling.reason ?? 'A person took the matter over.'], suggested: 'Work the file by hand, or clear the reason to hand it back to the engine', workstream: null, ref: { type: 'matter', id: 'manual' } });
  }

  // ── waits: someone owes us something ──
  for (const w of waits) {
    const rule = sla[w.key];
    if (!rule) continue;
    const age = dayAge(w.openedAt, now, cal);
    const party = PARTY_LABEL[rule.recipientRole] ?? rule.recipientRole.replace(/_/g, ' ');
    const what = `${WAIT_LABEL[w.key] ?? w.key.replace(/_/g, ' ')}${w.subject ? ` (${w.subject})` : ''}`;
    const escalated = w.escalations.some((e) => !e.resolvedAt);
    const chases = w.chasesSentAt.length;
    const why = [
      `Requested ${w.openedAt.slice(0, 10)} — ${plural(age, 'working day')} ago.`,
      `Their normal turnaround is ${plural(rule.chaseAfter, 'working day')}; we escalate at ${rule.escalateAfter}.`,
      chases ? `${plural(chases, 'chase')} sent, most recently ${w.chasesSentAt[chases - 1].slice(0, 10)}.` : 'No chase has gone out yet.',
    ];
    // Time decides the band, not how often we pressed Chase. Someone recorded as away is not late while away: a nudge at most.
    const away = rule.recipientRole === 'client' && !!awayNow(s, 'client', now);
    if (away) {
      if (age >= rule.chaseAfter) reasons.push({ code: 'chase_due', band: 'attention', headline: `${what} — ${party} is away`, why, suggested: 'Pick it up when they are back', workstream: WAIT_WORKSTREAM[w.key] ?? null, ref: { type: 'wait', id: `${w.key}:${w.subject}` }, ageWorkingDays: age });
    } else if (escalated) {
      reasons.push({ code: 'wait_escalated', band: 'delayed', headline: `${what} — ${party} is ${plural(age - rule.escalateAfter, 'working day')} past escalation`, why, suggested: chaseAdvice(party, chases), workstream: WAIT_WORKSTREAM[w.key] ?? null, ref: { type: 'wait', id: `${w.key}:${w.subject}` }, ageWorkingDays: age });
    } else if (age >= rule.escalateAfter) {
      reasons.push({ code: 'wait_overdue', band: 'delayed', headline: `${what} — ${party} is ${plural(age - rule.chaseAfter, 'working day')} overdue`, why, suggested: chaseAdvice(party, chases), workstream: WAIT_WORKSTREAM[w.key] ?? null, ref: { type: 'wait', id: `${w.key}:${w.subject}` }, ageWorkingDays: age });
    } else if (age >= rule.chaseAfter) {
      reasons.push({ code: 'chase_due', band: 'attention', headline: `${what} — ${party} is ${plural(Math.max(1, age - rule.chaseAfter + 1), 'working day')} overdue`, why, suggested: chaseAdvice(party, chases), workstream: WAIT_WORKSTREAM[w.key] ?? null, ref: { type: 'wait', id: `${w.key}:${w.subject}` }, ageWorkingDays: age });
    }
  }

  // ── issues: something is wrong ──
  for (const i of issues) {
    const spec = ISSUE_KIND_SPEC[i.kind];
    const age = dayAge(i.updatedAt, now, cal);
    const holds = i.gate === 'none' ? null : i.gate;
    const why = [
      `${spec.label}: ${clean(i.title)}`,
      holds ? `It holds ${holds === 'exchange' ? 'exchange' : holds === 'completion' ? 'completion' : holds}.` : 'It holds nothing, but it is open.',
      i.enquiryIds.length ? `Tracked by ${i.enquiryIds.length === 1 ? 'enquiry' : 'enquiries'} ${i.enquiryIds.join(', ')}.` : `Raised ${i.raisedAt.slice(0, 10)}; last touched ${i.updatedAt.slice(0, 10)} (${plural(age, 'working day')} ago).`,
    ];
    const suggested = spec.actions[0] ?? null;
    // "Mortgage offer expiring — Mortgage offer expires in 4 days" says it twice; when the
    // title already opens with the kind, the title alone is the better headline.
    const title = clean(i.title);
    const named = title.toLowerCase().startsWith(spec.label.split(' ')[0].toLowerCase()) ? title : `${spec.label} — ${title}`;
    const ours = spec.responsible === 'conveyancer' || spec.responsible === 'mlro';
    const oursTooLong = ours && spec.escalateAfterWorkingDays != null && age >= spec.escalateAfterWorkingDays * 2;
    const raisedAge = dayAge(i.raisedAt, now, cal);
    if (JEOPARDY.has(i.kind) || oursTooLong) {
      reasons.push({ code: 'issue_critical', band: 'critical', headline: oursTooLong && !JEOPARDY.has(i.kind) ? `${named} — ours, untouched for ${plural(age, 'working day')}` : named, why, suggested, workstream: spec.workstreams[0] ?? null, ref: { type: 'issue', id: i.id }, ageWorkingDays: age });
    } else if (holds && raisedAge < FRESH_ISSUE_DAYS) {
      // Just in (a survey read, a search back): the job is to read it and act, not an alarm.
      reasons.push({ code: 'issue_blocking', band: 'attention', headline: `${spec.label} to review — ${clean(i.title)}`, why, suggested, workstream: spec.workstreams[0] ?? null, ref: { type: 'issue', id: i.id }, ageWorkingDays: age });
    } else if (holds) {
      reasons.push({ code: 'issue_blocking', band: 'blocked', headline: `${holds === 'exchange' ? 'Exchange' : 'Completion'} blocked — ${clean(i.title)}`, why, suggested, workstream: spec.workstreams[0] ?? null, ref: { type: 'issue', id: i.id }, ageWorkingDays: age });
    } else if (age >= DEADLINE_LEAD.stale_issue) {
      reasons.push({ code: 'issue_stale', band: 'attention', headline: `${spec.label} untouched for ${plural(age, 'working day')}`, why, suggested, workstream: spec.workstreams[0] ?? null, ref: { type: 'issue', id: i.id }, ageWorkingDays: age });
    }
  }

  // ── decisions a person owes ──
  for (const d of decisions) {
    const age = dayAge(d.createdAt, now, cal);
    const hardStop = d.kind === 'bank_details';
    const headline = hardStop ? 'Bank details unverified — payments are stopped' : `${DECISION_LABEL[d.kind] ?? d.kind.replace(/_/g, ' ')} — waiting on your decision${d.subject ? ` (${d.subject})` : ''}`;
    const why = [
      hardStop
        ? 'Bank details were recorded or changed and have not been verified out-of-band. No payment to this payee can be authorised until they are.'
        : `The engine flagged it ${d.createdAt.slice(0, 10)}; it needs a person.`,
      `${plural(age, 'working day')} with no answer.`,
    ];
    if (hardStop) {
      reasons.push({ code: 'hard_stop', band: 'critical', headline, why, suggested: 'Verify the details by a call back to a number you already hold, then resolve the decision', workstream: 'completion', ref: { type: 'decision', id: d.eventId }, ageWorkingDays: age });
    } else if (age >= 2) {
      const band: HealthBand = age >= OUR_DELAY.severe ? 'critical' : age >= OUR_DELAY.late ? 'delayed' : 'attention';
      reasons.push({ code: 'decision_pending', band, headline: band === 'attention' ? headline : `${headline} — ours, ${plural(age, 'working day')}`, why, suggested: 'Open the source and decide', workstream: null, ref: { type: 'decision', id: d.eventId }, ageWorkingDays: age });
    }
  }

  // ── deadlines we owe ──
  for (const d of deadlines) {
    const passed = d.workingDaysLeft < 0;
    const near = d.workingDaysLeft <= Math.ceil(DEADLINE_LEAD[d.kind] / 3);
    if (d.kind === 'stale_issue') continue; // already covered as an issue reason
    const headline =
      d.kind === 'mortgage_offer_expiry' ? (passed ? 'Mortgage offer has expired' : `Mortgage offer expires in ${plural(d.workingDaysLeft, 'working day')}`)
      : d.kind === 'sdlt_filing' ? (passed ? 'SDLT return is late' : `SDLT return due in ${plural(d.workingDaysLeft, 'working day')}`)
      : d.kind === 'notice_to_complete' ? (passed ? 'Notice to complete has expired' : `Notice to complete expires in ${plural(d.workingDaysLeft, 'working day')}`)
      : passed ? 'HMLR requisition is overdue' : `HMLR requisition due in ${plural(d.workingDaysLeft, 'working day')}`;
    reasons.push({
      code: passed ? 'deadline_passed' : 'deadline_near',
      band: passed || near ? 'critical' : 'attention',
      headline,
      why: [d.summary, `Due ${d.dueDate}.`],
      suggested: d.kind === 'mortgage_offer_expiry' ? 'Exchange before the expiry, or ask the lender to extend / re-issue now' : d.kind === 'sdlt_filing' ? 'File the SDLT return' : d.kind === 'notice_to_complete' ? 'Complete, or take instructions on the consequences' : 'Answer the requisition',
      workstream: d.kind === 'mortgage_offer_expiry' ? 'mortgage' : d.kind === 'sdlt_filing' ? 'registration' : d.kind === 'notice_to_complete' ? 'completion' : 'registration',
      ref: { type: 'deadline', id: d.subject },
      dueInWorkingDays: d.workingDaysLeft,
    });
  }

  // ── pace: this phase has overrun what this transaction type should take ──
  // Only says something when nothing above already explains the delay: an overdue wait is
  // the reason, and "slow phase" underneath it is noise.
  if (pace.overrun > 0 && !reasons.some((r) => r.band === 'delayed' || r.band === 'critical')) {
    const half = expected * 0.5;
    reasons.push({
      code: 'stage_overrun',
      band: pace.overrun >= half ? 'delayed' : 'attention',
      headline: `${plural(inStage, 'working day')} in ${stage.replace(/_/g, ' ')} — ${plural(expected, 'working day')} is typical`,
      why: [
        `A ${profile.label.toLowerCase()} usually clears this phase in about ${plural(expected, 'working day')}.`,
        waits.length ? `Waiting on ${waits.length}: ${waits.map((w) => WAIT_LABEL[w.key] ?? w.key).join(', ')}.` : 'Nothing is outstanding with a third party, so the next step is ours.',
      ],
      suggested: waits.length ? 'Chase what is outstanding' : 'Take the next step on the case',
      workstream: null,
      ref: { type: 'stage', id: stage },
    });
  }

  // The flowchart's steps due now are ours to do: they colour the case, so they are its reasons too.
  const today = now.toISOString().slice(0, 10);
  for (const d of dueSteps(s, now)) {
    const late = !!d.dueDate && d.dueDate < today;
    reasons.push({ code: 'step_due', band: late ? 'blocked' : 'attention', headline: late ? `${d.title} — overdue since ${d.dueDate}` : d.title, why: [d.detail ?? 'The next step on the case is ours.'], suggested: d.title, workstream: null, ref: { type: 'step', id: d.key } });
  }

  reasons.sort((a, b) => HEALTH_RANK[b.band] - HEALTH_RANK[a.band] || (b.ageWorkingDays ?? 0) - (a.ageWorkingDays ?? 0));
  return { band: colourOf(s, reasons, now), reasons, pace, counts };
}

/** The compact form the caseload map carries for every matter (one row, no drill-down). */
export interface HealthSummary {
  band: HealthBand;
  /** The single line the map shows on hover / in the exception list. */
  headline: string | null;
  why: string[];
  suggested: string | null;
  reasonCount: number;
  counts: CaseHealth['counts'];
  pace: CasePace;
}

export const summariseHealth = (h: CaseHealth): HealthSummary => ({
  band: h.band,
  headline: h.reasons[0]?.headline ?? null,
  why: h.reasons[0]?.why ?? [],
  suggested: h.reasons[0]?.suggested ?? null,
  reasonCount: h.reasons.length,
  counts: h.counts,
  pace: h.pace,
});

/** Firm-level rollup for the oversight strip: "74 active · 51 moving normally · 15 need attention · 6 stuck · 2 critical". */
export interface CaseloadRollup { total: number; normal: number; attention: number; delayed: number; blocked: number; critical: number; stuck: number; needsSomeone: number }

export function rollup(bands: HealthBand[]): CaseloadRollup {
  const c = { normal: 0, attention: 0, delayed: 0, blocked: 0, critical: 0 };
  for (const b of bands) c[b] += 1;
  return { total: bands.length, ...c, stuck: c.delayed + c.blocked, needsSomeone: c.attention + c.delayed + c.blocked + c.critical };
}
