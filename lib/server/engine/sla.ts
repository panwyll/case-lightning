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
import { openWaits } from './types';
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

export type DeadlineKind = 'mortgage_offer_expiry' | 'sdlt_filing' | 'notice_to_complete' | 'requisition_reply';

export interface DeadlineAction {
  kind: DeadlineKind;
  /** ISO date the deadline falls on. */
  dueDate: string;
  /** Working days until the deadline (negative = passed). */
  workingDaysLeft: number;
  summary: string;
  subject: string;
}

/** How many working days before a deadline the engine raises it (one escalation per deadline, by subject). */
export const DEADLINE_LEAD: Record<DeadlineKind, number> = { mortgage_offer_expiry: 15, sdlt_filing: 5, notice_to_complete: 2, requisition_reply: 5 };

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
  return out;
}
