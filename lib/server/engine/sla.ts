/**
 * Timer / SLA system (spec 2.6) — a first-class citizen, not an add-on.
 *
 * Every "waiting on someone else" state is a WaitState in the projection (opened and
 * closed by events). This module answers, purely: "given the waits, the chases and
 * escalations already logged, and the time now — what is due?" The service turns each
 * due action into a chase (template message via the comms port → `chase_sent`) or an
 * escalation (`escalation_raised`, which is a DecisionEvent for a human).
 *
 * All durations are E&W WORKING days. Defaults live here; a tenant can override a
 * wait's numbers via engine_sla_override (store.ts loads them into an SlaConfig).
 */
import type { MatterState, WaitKey, WaitState } from './types';
import { openIssues, openWaits } from './types';
import { ISSUE_KIND_SPEC, MORTGAGE_EXPIRY_CRITICAL_DAYS, MORTGAGE_EXPIRY_WARNING_DAYS, type IssueKind, type IssueSeverity } from './issues';
import { openIssues as openIssuesOf } from './types';
import { workingDaysBetween, type WorkingCalendar, EW_CALENDAR } from './working-days';

export interface SlaRule {
  waitKey: WaitKey;
  /** First chase after this many working days. */
  chaseAfter: number;
  /** Repeat chases every N working days after the first (null = chase once). */
  chaseEvery: number | null;
  /** Raise an escalation decision after this many working days. */
  escalateAfter: number;
  /** After an escalation is resolved, re-escalate if still waiting after this many more working days. */
  reEscalateAfter: number;
  recipientRole: 'seller_solicitor' | 'search_provider' | 'lender' | 'client' | 'id_provider' | 'hmlr';
  template: string;
}

export type SlaConfig = Record<WaitKey, SlaRule>;

export const DEFAULT_SLA: SlaConfig = {
  // spec: 15 working days default → chase at day 10, escalate at day 18
  search: { waitKey: 'search', chaseAfter: 10, chaseEvery: 3, escalateAfter: 18, reEscalateAfter: 5, recipientRole: 'search_provider', template: 'chase_search_provider' },
  // spec: 5 working days → chase at day 5, repeat every 3 days, escalate at day 15
  enquiry: { waitKey: 'enquiry', chaseAfter: 5, chaseEvery: 3, escalateAfter: 15, reEscalateAfter: 5, recipientRole: 'seller_solicitor', template: 'chase_enquiry_reply' },
  id_check: { waitKey: 'id_check', chaseAfter: 3, chaseEvery: 2, escalateAfter: 7, reEscalateAfter: 3, recipientRole: 'client', template: 'chase_id_documents' },
  funds: { waitKey: 'funds', chaseAfter: 2, chaseEvery: 1, escalateAfter: 4, reEscalateAfter: 2, recipientRole: 'lender', template: 'chase_completion_funds' },
  registration: { waitKey: 'registration', chaseAfter: 30, chaseEvery: 10, escalateAfter: 60, reEscalateAfter: 20, recipientRole: 'hmlr', template: 'chase_hmlr_registration' },
  // The client owes us the proof-of-funds form: nudge early and often, escalate to the handler after two weeks.
  proof_of_funds: { waitKey: 'proof_of_funds', chaseAfter: 3, chaseEvery: 3, escalateAfter: 10, reEscalateAfter: 5, recipientRole: 'client', template: 'chase_proof_of_funds' },
  // Management packs take 2–8 weeks and the seller's side owes them: chase from day 10.
  management_pack: { waitKey: 'management_pack', chaseAfter: 10, chaseEvery: 5, escalateAfter: 20, reEscalateAfter: 5, recipientRole: 'seller_solicitor', template: 'chase_management_pack' },
};

export interface DueAction {
  kind: 'chase' | 'escalate';
  wait: WaitState;
  rule: SlaRule;
  ageWorkingDays: number;
}

/**
 * What the timer should do right now for one matter. Deterministic in (state, now).
 * A wait yields at most one chase and at most one escalation per tick; the events
 * those produce change the state so the next tick sees them.
 */
export function dueActions(state: MatterState, now: Date, sla: SlaConfig = DEFAULT_SLA, cal: WorkingCalendar = EW_CALENDAR): DueAction[] {
  const out: DueAction[] = [];
  for (const wait of openWaits(state)) {
    const rule = sla[wait.key];
    if (!rule) continue;
    const age = workingDaysBetween(new Date(wait.openedAt), now, cal);

    // Chase: first at chaseAfter, then every chaseEvery working days since the last chase.
    if (age >= rule.chaseAfter) {
      const last = wait.chasesSentAt[wait.chasesSentAt.length - 1];
      if (!last) out.push({ kind: 'chase', wait, rule, ageWorkingDays: age });
      else if (rule.chaseEvery !== null && workingDaysBetween(new Date(last), now, cal) >= rule.chaseEvery) out.push({ kind: 'chase', wait, rule, ageWorkingDays: age });
    }

    // Escalate: once at escalateAfter; again only after a resolved escalation has aged reEscalateAfter.
    if (age >= rule.escalateAfter) {
      const open = wait.escalations.find((e) => e.resolvedAt === null);
      if (!open) {
        const lastResolved = wait.escalations.filter((e) => e.resolvedAt).map((e) => e.resolvedAt as string).sort().pop();
        if (!lastResolved || workingDaysBetween(new Date(lastResolved), now, cal) >= rule.reEscalateAfter) {
          out.push({ kind: 'escalate', wait, rule, ageWorkingDays: age });
        }
      }
    }
  }
  return out;
}

/** Merge tenant overrides (partial numbers) onto the defaults. */
export function withOverrides(overrides: Array<Partial<SlaRule> & { waitKey: WaitKey }>, base: SlaConfig = DEFAULT_SLA): SlaConfig {
  const cfg: SlaConfig = { ...base };
  for (const o of overrides) {
    if (!cfg[o.waitKey]) continue;
    cfg[o.waitKey] = { ...cfg[o.waitKey], ...stripUndefined(o) };
  }
  return cfg;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

// ───────────────────────────── deadlines (eventualities) ─────────────────────────────

export type DeadlineKind = 'mortgage_offer_expiry' | 'sdlt_filing' | 'notice_to_complete' | 'requisition_reply' | 'stale_issue';

export interface DeadlineAction {
  kind: DeadlineKind;
  /** ISO date the deadline falls on. */
  dueDate: string;
  /** Working days until the deadline (negative = passed). */
  workingDaysLeft: number;
  summary: string;
  subject: string;
}

/**
 * How many working days before a deadline the engine raises it (one escalation per deadline, by subject).
 * `stale_issue` is the other way round: an open issue nobody has touched for this many working days is raised.
 */
export const DEADLINE_LEAD: Record<DeadlineKind, number> = { mortgage_offer_expiry: 15, sdlt_filing: 5, notice_to_complete: 2, requisition_reply: 5, stale_issue: 10 };

/**
 * Hard dates a conveyancer must not sail past. Unlike waits (something is owed to us),
 * a deadline is something we owe: nothing is chased, a person is told in time. Each is
 * raised once — the escalation's subject is `deadline:<kind>:<date>`, and an existing
 * decision with that subject (pending or resolved) means it has been raised.
 */
export function deadlineActions(state: MatterState, now: Date, cal: WorkingCalendar = EW_CALENDAR): DeadlineAction[] {
  if (!state.enrolled || state.abandoned || state.manualHandling.required) return [];
  const out: DeadlineAction[] = [];
  const raised = new Set(Object.values(state.decisions).map((d) => d.subject ?? ''));
  const push = (kind: DeadlineKind, dueDate: string, summary: string) => {
    const subject = `deadline:${kind}:${dueDate}`;
    if (raised.has(subject)) return;
    const left = workingDaysBetween(now, new Date(dueDate), cal) * (new Date(dueDate) < now ? -1 : 1);
    if (left <= DEADLINE_LEAD[kind]) out.push({ kind, dueDate, workingDaysLeft: left, summary, subject });
  };
  const expiry = state.mortgage.facts?.expiryDate;
  if (state.hasLender && expiry && !state.exchange.exchangedAt && (state.mortgage.status === 'cleared' || state.mortgage.status === 'reviewed')) {
    push('mortgage_offer_expiry', expiry, `The mortgage offer expires on ${expiry} and contracts are not exchanged. Exchange before then, or ask the lender for an extension / re-issue now — a lapsed offer reopens the mortgage sub-flow and blocks exchange.`);
  }
  if (state.completion.confirmedAt && !state.postCompletion.sdltSubmittedAt) {
    const due = new Date(new Date(state.completion.confirmedAt).getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    push('sdlt_filing', due, `The SDLT return and payment are due within 14 days of completion (${state.completion.confirmedAt.slice(0, 10)}) — by ${due}. Late filing carries an automatic penalty and interest.`);
  }
  if (state.noticeToComplete && !state.completion.confirmedAt) {
    const n = state.noticeToComplete;
    push('notice_to_complete', n.expiresAt.slice(0, 10), `A notice to complete served by the ${n.servedBy} on ${n.servedAt.slice(0, 10)} expires on ${n.expiresAt.slice(0, 10)}. Completion must happen by then or the ${n.servedBy === 'seller' ? 'seller may rescind and forfeit the deposit' : 'buyer may rescind and recover the deposit'}.`);
  }
  for (const r of state.postCompletion.requisitions) {
    if (r.respondedAt || !r.deadline) continue;
    push('requisition_reply', r.deadline.slice(0, 10), `HM Land Registry's requisition of ${r.receivedAt.slice(0, 10)} must be answered by ${r.deadline.slice(0, 10)} or the application is cancelled and priority is lost.`);
  }
  // Stale issues: the forum pattern is an issue that sits for weeks because both sides are waiting
  // for the other. Raised once per period of silence (subject carries the last-touched date).
  for (const i of openIssues(state)) {
    // The timer's own informational issues (holding nothing) escalate through timedIssueActions, not here.
    if (i.gate === 'none' && i.raisedBy === 'system') continue;
    const age = workingDaysBetween(new Date(i.updatedAt), now, cal);
    if (age < DEADLINE_LEAD.stale_issue) continue;
    const subject = `issue:${i.id}:stale:${i.updatedAt.slice(0, 10)}`;
    if (raised.has(subject)) continue;
    const label = ISSUE_KIND_SPEC[i.kind]?.label ?? i.kind;
    out.push({ kind: 'stale_issue', dueDate: i.updatedAt.slice(0, 10), workingDaysLeft: -age, summary: `Issue "${i.title}" (${label}, holds ${i.gate === 'none' ? 'nothing' : i.gate}) has had no movement for ${age} working days since ${i.updatedAt.slice(0, 10)}. Chase whoever owes the next step, record progress on the issue, or decide whether it is fatal.`, subject });
  }
  return out;
}

// ───────────────────────────── time as a source of events (docs/case-model.md §6) ─────────────────────────────

export type TimedIssueAction =
  | { kind: 'raise'; issueKind: IssueKind; key: string; title: string; detail: string; severity: IssueSeverity }
  | { kind: 'escalate'; issueId: string; severity: IssueSeverity; reason: string }
  | { kind: 'offer_expired'; expiryDate: string }
  | { kind: 'resolve'; issueId: string; resolution: 'received' | 'other'; note: string };

/**
 * State changes that happen because time passed, not because something arrived: the
 * mortgage offer moves VALID → EXPIRING (30 days) → CRITICAL (14 days) → EXPIRED; a search or
 * an enquiry that has aged past its escalation point becomes an issue in its own right; an
 * issue nobody touches for its kind's escalation period goes up a severity. Deterministic in
 * (state, now); the service turns each into a command. Idempotent: a `key` in the title marks
 * an issue the timer raised, and an existing one (any status) means it was raised.
 */
export function timedIssueActions(state: MatterState, now: Date, cal: WorkingCalendar = EW_CALENDAR): TimedIssueAction[] {
  if (!state.enrolled || state.abandoned || state.closedAt || state.manualHandling.required) return [];
  const out: TimedIssueAction[] = [];
  const issues = Object.values(state.issues);
  const has = (key: string) => issues.some((i) => i.title.includes(`[${key}]`));
  const open = openIssuesOf(state);
  const today = now.toISOString().slice(0, 10);

  // Mortgage offer expiry: warning → critical → expired.
  const expiry = state.mortgage.facts?.expiryDate;
  if (state.hasLender && expiry && !state.exchange.exchangedAt && (state.mortgage.status === 'cleared' || state.mortgage.status === 'reviewed')) {
    const daysLeft = Math.round((Date.parse(expiry) - Date.parse(today)) / 86_400_000);
    const key = `offer-expiry:${expiry}`;
    if (daysLeft < 0) {
      out.push({ kind: 'offer_expired', expiryDate: expiry });
      const expiring = open.find((i) => i.title.includes(`[${key}]`));
      if (expiring) out.push({ kind: 'resolve', issueId: expiring.id, resolution: 'other', note: `The offer expired on ${expiry} (timer); superseded by the expired-offer issue` });
      if (!has(`offer-expired:${expiry}`)) out.push({ kind: 'raise', issueKind: 'mortgage_offer_expired', key: `offer-expired:${expiry}`, title: `Mortgage offer expired on ${expiry} [offer-expired:${expiry}]`, detail: 'The offer lapsed before exchange. A fresh application, valuation and offer are needed; the chain must be told the timetable has moved.', severity: 'critical' });
    } else if (daysLeft <= MORTGAGE_EXPIRY_WARNING_DAYS) {
      const existing = open.find((i) => i.title.includes(`[${key}]`));
      if (!existing && !has(key)) out.push({ kind: 'raise', issueKind: 'mortgage_offer_expiring', key, title: `Mortgage offer expires in ${daysLeft} days (${expiry}) [${key}]`, detail: 'Contact the broker / lender: what does an extension need and how long does it take? Plan exchange and completion inside the offer, or start a re-issue now.', severity: daysLeft <= MORTGAGE_EXPIRY_CRITICAL_DAYS ? 'critical' : 'warning' });
      else if (existing && daysLeft <= MORTGAGE_EXPIRY_CRITICAL_DAYS && existing.severity !== 'critical') out.push({ kind: 'escalate', issueId: existing.id, severity: 'critical', reason: `${daysLeft} days to the offer expiry on ${expiry}` });
    }
  }
  // Issues the timer raised close themselves when the thing they were about happened.
  for (const i of open) {
    const key = i.title.match(/\[([a-z-]+):([^\]]*)\]/);
    if (!key) continue;
    if (key[1] === 'search-delayed' || key[1] === 'enquiry-unanswered') {
      const [subject, openedDay] = key[2].split(':');
      const stillOpen = openWaits(state).some((w) => (w.key === (key[1] === 'search-delayed' ? 'search' : 'enquiry')) && w.subject === subject && w.openedAt.slice(0, 10) === openedDay);
      if (!stillOpen) out.push({ kind: 'resolve', issueId: i.id, resolution: 'received', note: `${key[1] === 'search-delayed' ? 'Search' : 'Reply'} received (timer)` });
    }
    if (key[1] === 'offer-expiry' && (state.exchange.exchangedAt || !expiry || expiry !== key[2] || !(state.mortgage.status === 'cleared' || state.mortgage.status === 'reviewed'))) {
      out.push({ kind: 'resolve', issueId: i.id, resolution: 'other', note: state.exchange.exchangedAt ? 'Contracts exchanged inside the offer (timer)' : 'A different offer is now on file (timer)' });
    }
  }
  // Waits that have aged past their escalation point become issues (the chase / escalation already happened; the issue is the plan's record).
  for (const w of openWaits(state)) {
    const rule = DEFAULT_SLA[w.key];
    if (!rule) continue;
    const age = workingDaysBetween(new Date(w.openedAt), now, cal);
    if (age < rule.escalateAfter) continue;
    if (w.key === 'search') {
      const key = `search-delayed:${w.subject}:${w.openedAt.slice(0, 10)}`;
      if (!has(key)) out.push({ kind: 'raise', issueKind: 'search_delayed', key, title: `${w.subject} search outstanding for ${age} working days [${key}]`, detail: `Ordered ${w.openedAt.slice(0, 10)}; chased ${w.chasesSentAt.length}×. Consider search indemnity if the lender allows, and re-plan the target dates.`, severity: 'info' });
    } else if (w.key === 'enquiry') {
      const key = `enquiry-unanswered:${w.subject}:${w.openedAt.slice(0, 10)}`;
      if (!has(key)) out.push({ kind: 'raise', issueKind: 'enquiry_unanswered', key, title: `Enquiry ${w.subject} unanswered for ${age} working days [${key}]`, detail: `Raised ${w.openedAt.slice(0, 10)}; chased ${w.chasesSentAt.length}×. Escalate via the agent; re-plan the target dates.`, severity: 'info' });
    }
  }
  // Issues that sit: severity goes up one step after the kind's escalation period without movement (once per step).
  for (const i of open) {
    const after = ISSUE_KIND_SPEC[i.kind]?.escalateAfterWorkingDays;
    if (!after || i.severity === 'critical') continue;
    const age = workingDaysBetween(new Date(i.updatedAt), now, cal);
    if (age >= after) out.push({ kind: 'escalate', issueId: i.id, severity: i.severity === 'info' ? 'warning' : 'critical', reason: `no movement for ${age} working days (escalates after ${after})` });
  }
  return out;
}
