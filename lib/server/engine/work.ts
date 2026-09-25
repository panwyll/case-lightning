/**
 * The personal work list: DO · WAITING · CHASE · ESCALATE (docs/caseload-ux.md §4).
 *
 * Four buckets, no new concepts to learn:
 *   DO       — this person has to act now.
 *   WAITING  — someone else has to act, but we still own it. Every item carries who we
 *              are waiting for, when we asked, their normal turnaround, and the countdown
 *              to the next chase, so "in their court" never means "out of sight".
 *   CHASE    — a WAITING item whose timer has expired. Nobody has to remember: the clock
 *              moves it here, and the engine's tick sends the chase (or asks first, in
 *              shadow mode).
 *   ESCALATE — chasing has failed, or a date we owe is close enough to threaten the
 *              transaction. Writing again is no longer the answer: a person picks up the
 *              phone, or takes the client's instructions.
 *
 * The cycle is DO → sent → WAITING → countdown → CHASE → sent → WAITING → … → ESCALATE,
 * which is exactly what sla.ts already computes; this module presents it per person.
 *
 * Two owners, deliberately distinct:
 *   actionOwner         — who is expected to do the thing (may be outside the firm).
 *   responsibilityOwner — the fee-earner accountable for it happening. Never null.
 */
import { DEFAULT_SLA, dueActions, type SlaConfig } from './sla';
import { ISSUE_KIND_SPEC } from './issues';
import { nextActions } from './graph';
import { caseHealth, summariseHealth, type HealthBand, type HealthSummary } from './health';
import { openIssues, openWaits, pendingDecisions, surfacedDecisions, type MatterState, type SubflowConfig } from './types';
import { EW_CALENDAR, addWorkingDays, workingDaysBetween, type WorkingCalendar } from './working-days';

export type Bucket = 'do' | 'waiting' | 'escalate';
export type ActionOwner = 'conveyancer' | 'client' | 'seller_side' | 'lender' | 'third_party' | 'mlro' | 'hmlr' | 'search_provider' | 'id_provider';

export interface WorkItem {
  id: string;
  bucket: Bucket;
  matterId: string;
  matterRef: string | null;
  propertyAddress: string | null;
  /** What has to happen, in a conveyancer's words. */
  what: string;
  /** Why it matters — what it unblocks, or what it holds up. */
  unblocks: string | null;
  actionOwner: ActionOwner;
  /** The fee-earner accountable. Falls back to the matter's handler. */
  responsibilityOwner: string | null;
  urgency: HealthBand;
  workstream: string | null;
  /** WAITING / CHASE: when we asked. */
  since: string | null;
  sinceWorkingDays: number | null;
  /** WAITING: their normal turnaround, in working days. */
  slaWorkingDays: number | null;
  /** WAITING: working days until the next chase goes out. Negative = due now (CHASE). */
  chaseInWorkingDays: number | null;
  /** How many chases have already gone. */
  chasesSent: number;
  /** CHASE: automatic (the tick sends it) or waiting on a person (shadow mode). */
  mode: 'automatic' | 'needs_approval' | null;
  /** CHASE: working days until this escalates to a person. */
  escalatesInWorkingDays: number | null;
  escalated: boolean;
  /** WAITING: the date we expect them by — the SLA from when we asked, or the chase cadence from the last chase. */
  dueBy: string | null;
  /** WAITING: the clock has run out; the next sweep sends the chase. Nobody has to do anything. */
  chaseDue: boolean;
  /** Where to go: the decision, the issue, the wait or just the case. */
  ref: { type: 'decision' | 'issue' | 'wait' | 'requirement' | 'client' | 'case'; id: string };
}

export interface MatterWork {
  matterId: string;
  band: HealthBand;
  /** The health line, so a caller can say WHY a matter is on the list without recomputing. */
  health: HealthSummary;
  items: WorkItem[];
}

const PARTY: Record<string, ActionOwner> = {
  seller_solicitor: 'seller_side', search_provider: 'search_provider', lender: 'lender',
  client: 'client', id_provider: 'id_provider', hmlr: 'hmlr',
};
export const OWNER_LABEL: Record<ActionOwner, string> = {
  conveyancer: 'Us', client: 'The client', seller_side: "The other side's solicitor", lender: 'The lender',
  third_party: 'A third party', mlro: 'The MLRO', hmlr: 'HM Land Registry', search_provider: 'The search provider', id_provider: 'The ID provider',
};
const DECISION_LABEL: Record<string, string> = {
  id_check: 'the ID / AML result', search: 'the search result', enquiry: 'the reply to our enquiry', mortgage: 'the mortgage offer',
  title: 'the title', report_on_title: 'the report on title', escalation: 'the escalation', requisition: "HM Land Registry's requisition",
  proof_of_funds: 'the source of funds', management_pack: 'the management pack',
};
/** What we are waiting for them to do, as the second half of "waiting on X to …". */
const SEARCH_NAME: Record<string, string> = { LLC1: 'LLC1', CON29: 'CON29', DRAINAGE_WATER: 'drainage and water', ENVIRONMENTAL: 'environmental', CHANCEL: 'chancel' };
const WAIT_ACTION: Record<string, (subject: string) => string> = {
  search: (sub) => `return the ${sub ? `${SEARCH_NAME[sub] ?? sub.toLowerCase().replace(/_/g, ' ')} ` : ''}search`, enquiry: (sub) => `reply to ${sub ? `enquiry ${sub}` : 'our enquiries'}`, id_check: () => 'return the ID / AML result',
  funds: () => 'release the completion funds', registration: () => 'complete the registration', proof_of_funds: () => 'complete the proof of funds form',
  management_pack: () => 'send the management pack', property_forms: () => 'return the property forms', redemption: () => 'send the redemption statement',
  lender_consent: () => 'confirm consent', discharge: () => 'confirm the discharge',
};
/** "Client to answer query Q4 sent: …" → "answer query Q4"; "Take the client's instruction: X has not been recorded" → "give their instruction on X". */
export function clientAction(what: string): string {
  const q = what.match(/^Client to answer (query \S+)/i);
  if (q) return `answer ${q[1]}`;
  if (/instruction to exchange/i.test(what)) return 'authorise exchange';
  const i = what.match(/^Take the client's instruction:\s*(.+?)(?: has not been recorded)?$/i);
  if (i) return `give their instruction — ${i[1].replace(/^the client's instruction to /i, '').trim()}`;
  return what.charAt(0).toLowerCase() + what.slice(1);
}
/** "Still waiting on enquiry E2 since 2026-08-24 — no response after 16 working days; chased 1× (last …)." → "Enquiry E2: no reply in 16 working days, chased once". */
export function escalationLine(text: string): string {
  const m = text.match(/^Still waiting on (.+?) since \S+ — no response after (\d+) working days(?:; chased (\d+)×)?/i);
  if (!m) return text;
  const what = m[1].replace(/_/g, ' ').replace(/\bid check\b/i, 'ID check');
  const chased = m[3] ? (m[3] === '1' ? ', chased once' : `, chased ${m[3]} times`) : '';
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}: no reply in ${m[2]} working days${chased}`;
}
export const waitAction = (key: string, subject: string): string => (WAIT_ACTION[key] ? WAIT_ACTION[key](subject) : `${key.replace(/_/g, ' ')}${subject ? ` — ${subject}` : ''}`);
const WAIT_WHAT: Record<string, string> = {
  search: 'Search result', enquiry: 'Reply to enquiry', id_check: 'ID / AML result', funds: 'Completion funds',
  registration: 'HMLR registration', proof_of_funds: 'Proof of funds from the client', management_pack: 'Management pack',
  property_forms: 'Property forms from the client', redemption: 'Redemption statement', lender_consent: "Lender's consent", discharge: 'Discharge (DS1 / e-DS1)',
};

export interface WorkContext {
  matterRef?: string | null;
  propertyAddress?: string | null;
  /** The fee-earner the matter is assigned to. */
  assignedTo?: string | null;
  subflows?: SubflowConfig | null;
}

const wd = (iso: string, now: Date, cal: WorkingCalendar) => workingDaysBetween(new Date(iso), now, cal);

/**
 * One matter's work, split into the three buckets. Pure in (state, now, ctx).
 * A closed or abandoned matter produces nothing — there is nothing left to do on it.
 */
export function matterWork(s: MatterState, now: Date = new Date(), ctx: WorkContext = {}, sla: SlaConfig = DEFAULT_SLA, cal: WorkingCalendar = EW_CALENDAR): MatterWork {
  const health = caseHealth(s, now, sla, cal);
  const out: WorkItem[] = [];
  if (!s.enrolled || s.abandoned || s.closedAt) return { matterId: s.matterId, band: health.band, health: summariseHealth(health), items: out };
  const owner = ctx.assignedTo ?? null;
  const base = { matterId: s.matterId, matterRef: ctx.matterRef ?? null, propertyAddress: ctx.propertyAddress ?? null, responsibilityOwner: owner };
  const bandOf = (code: string): HealthBand => health.reasons.find((r) => r.ref.id === code)?.band ?? 'normal';

  // ── DO: decisions a person must resolve ──
  // Only what a person may act on (shadow-mode matters surface nothing).
  const surfaced = ctx.subflows ? surfacedDecisions(s, ctx.subflows) : pendingDecisions(s);
  for (const d of surfaced.filter((x) => x.kind !== 'auto_clear')) {
    const age = wd(d.createdAt, now, cal);
    // An escalation's subject is an internal key ("deadline:mortgage_offer_expiry:…"), so
    // it is described by the first line of what the timer actually said.
    // One sentence, not the whole dossier — the detail is on the case.
    const firstLine = ((d.summary ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '').split(/(?<=\.)\s/)[0].slice(0, 120);
    const what =
      d.kind === 'bank_details' ? 'Verify bank details out-of-band (payments are stopped until you do)'
      : d.kind === 'escalation' ? escalationLine(firstLine || 'Deal with an escalation')
      : `Decide: ${DECISION_LABEL[d.kind] ?? d.kind.replace(/_/g, ' ')}${d.subject && !d.subject.includes(':') && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(d.subject) ? ` — ${d.subject}` : ''}`;
    out.push({
      ...base,
      id: `${d.kind === 'escalation' ? 'escalate' : 'do'}:decision:${d.eventId}`,
      // An escalation decision IS the escalation: the timer gave up on writing and asked
      // for a person. It does not belong in the same column as an ordinary decision.
      bucket: d.kind === 'escalation' ? 'escalate' : 'do',
      what,
      unblocks: d.kind === 'bank_details' ? 'Any payment to this payee' : null,
      actionOwner: 'conveyancer',
      // An escalation exists because a clock already ran out — it is never "normal".
      urgency: d.kind === 'bank_details' ? 'critical' : d.kind === 'escalation' || age >= 2 ? 'attention' : 'normal',
      workstream: null,
      since: d.createdAt, sinceWorkingDays: age, slaWorkingDays: null, chaseInWorkingDays: null,
      chasesSent: 0, mode: null, escalatesInWorkingDays: null, escalated: false, dueBy: null, chaseDue: false,
      ref: { type: 'decision', id: d.eventId },
    });
  }

  // ── DO: issues whose next step is ours ──
  for (const i of openIssues(s)) {
    const spec = ISSUE_KIND_SPEC[i.kind];
    if (spec.responsible !== 'conveyancer' && spec.responsible !== 'mlro') continue;
    if (i.enquiryIds.some((q) => s.enquiries[q] && s.enquiries[q].status !== 'cleared' && s.enquiries[q].status !== 'reviewed')) continue; // tracked by a live enquiry → it is a WAITING, not a DO
    out.push({
      ...base,
      id: `do:issue:${i.id}`,
      bucket: 'do',
      what: `${spec.actions[0] ?? 'Deal with'}: ${i.title.replace(/\s*\[[a-z-]+:[^\]]*\]/g, '').trim()}`,
      unblocks: i.gate === 'none' ? null : i.gate === 'exchange' ? 'Exchange' : 'Completion',
      actionOwner: spec.responsible === 'mlro' ? 'mlro' : 'conveyancer',
      urgency: i.severity === 'critical' ? 'critical' : i.gate !== 'none' ? 'blocked' : 'attention',
      workstream: spec.workstreams[0] ?? null,
      since: i.raisedAt, sinceWorkingDays: wd(i.updatedAt, now, cal), slaWorkingDays: spec.escalateAfterWorkingDays ?? null,
      chaseInWorkingDays: null, chasesSent: 0, mode: null, escalatesInWorkingDays: null, escalated: false, dueBy: null, chaseDue: false,
      ref: { type: 'issue', id: i.id },
    });
  }

  // ── DO: the next step on the gate when it is ours and nothing is outstanding ──
  for (const a of nextActions(s, now).filter((x) => x.who === 'conveyancer' && x.ref.type === 'requirement')) {
    out.push({
      ...base,
      id: `do:req:${a.ref.id}`,
      bucket: 'do',
      what: a.what,
      unblocks: a.unblocks,
      actionOwner: 'conveyancer',
      urgency: a.urgency === 'critical' ? 'critical' : a.urgency === 'warning' ? 'attention' : 'normal',
      workstream: null,
      since: null, sinceWorkingDays: null, slaWorkingDays: null, chaseInWorkingDays: null,
      chasesSent: 0, mode: null, escalatesInWorkingDays: null, escalated: false, dueBy: null, chaseDue: false,
      ref: { type: 'requirement', id: a.ref.id },
    });
  }

  // ── WAITING: every open wait, with its clock. Chasing is the engine's job, not a pile:
  //    when the clock runs out the next sweep sends the chase, and the item stays here
  //    with the count on it and its severity one notch higher. ──
  const chaseDue = new Set(dueActions(s, now, sla, cal).filter((d) => d.kind === 'chase').map((d) => `${d.wait.key}:${d.wait.subject}`));
  // A wait the timer has already escalated is on the list once, as the escalation a person
  // can actually resolve — not twice, as the wait and its escalation.
  const escalatedAsDecision = new Set(surfaced.filter((d) => d.kind === 'escalation' && d.subject).map((d) => d.subject as string));
  for (const w of openWaits(s)) {
    const rule = sla[w.key];
    if (!rule) continue;
    const key = `${w.key}:${w.subject}`;
    const age = wd(w.openedAt, now, cal);
    const chases = w.chasesSentAt.length;
    const last = chases ? w.chasesSentAt[chases - 1] : null;
    // Next chase: the first at chaseAfter, then every chaseEvery working days after the last one.
    const nextChaseIn = !last ? rule.chaseAfter - age : rule.chaseEvery === null ? null : rule.chaseEvery - wd(last, now, cal);
    const dueBy = (last && rule.chaseEvery !== null ? addWorkingDays(new Date(last), rule.chaseEvery, cal) : addWorkingDays(new Date(w.openedAt), rule.chaseAfter, cal)).toISOString().slice(0, 10);
    const escalated = w.escalations.some((e) => !e.resolvedAt);
    const isChase = chaseDue.has(key);
    const bucket: Bucket = escalated ? 'escalate' : 'waiting';
    if (escalated && escalatedAsDecision.has(key)) continue;
    out.push({
      ...base,
      id: `${bucket}:${key}`,
      bucket,
      what: waitAction(w.key, w.subject),
      unblocks: null,
      actionOwner: PARTY[rule.recipientRole] ?? 'third_party',
      // Each chase that goes unanswered is a notch worse: one → attention, two → delayed, escalated → critical.
      urgency: escalated ? 'critical' : age >= rule.escalateAfter || chases >= 2 ? 'delayed' : isChase || chases >= 1 ? 'attention' : 'normal',
      workstream: null,
      since: w.openedAt, sinceWorkingDays: age,
      slaWorkingDays: rule.chaseAfter,
      chaseInWorkingDays: nextChaseIn,
      chasesSent: chases,
      mode: s.shadowMode ? 'needs_approval' : 'automatic',
      escalatesInWorkingDays: escalated ? 0 : rule.escalateAfter - age,
      escalated,
      dueBy,
      chaseDue: isChase,
      ref: { type: 'wait', id: key },
    });
  }

  // ── ESCALATE: a date WE owe is close (or passed). Nothing to chase — it is on us. ──
  for (const r of health.reasons.filter((x) => x.code === 'deadline_near' || x.code === 'deadline_passed')) {
    out.push({
      ...base,
      id: `escalate:${r.ref.id}`,
      bucket: 'escalate',
      what: r.headline,
      unblocks: null,
      actionOwner: 'conveyancer',
      urgency: r.band,
      workstream: r.workstream,
      since: null,
      sinceWorkingDays: null,
      slaWorkingDays: null,
      chaseInWorkingDays: null,
      chasesSent: 0,
      mode: null,
      escalatesInWorkingDays: r.dueInWorkingDays ?? null,
      escalated: true,
      dueBy: null,
      chaseDue: false,
      ref: { type: 'case', id: r.ref.id },
    });
  }

  // ── WAITING: the client owes us a decision only they can make ──
  // Only once it is theirs to give: nobody asks a client to authorise exchange while the
  // searches are still out, so until pre-exchange that is not something we are waiting on.
  const askable = (id: string) => id !== 'exchange_authority' || s.stage === 'pre_exchange';
  for (const a of nextActions(s, now).filter((x) => x.who === 'client' && x.ref.type === 'client' && askable(x.ref.id))) {
    out.push({
      ...base,
      id: `waiting:client:${a.ref.id}`,
      bucket: 'waiting',
      what: clientAction(a.what),
      unblocks: a.unblocks,
      actionOwner: 'client',
      urgency: a.urgency === 'critical' ? 'critical' : 'normal',
      workstream: null,
      since: null, sinceWorkingDays: null, slaWorkingDays: null, chaseInWorkingDays: null,
      chasesSent: 0, mode: null, escalatesInWorkingDays: null, escalated: false, dueBy: null, chaseDue: false,
      ref: { type: 'client', id: a.ref.id },
    });
  }

  const rank: Record<HealthBand, number> = { critical: 0, blocked: 1, delayed: 2, attention: 3, normal: 4 };
  out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (b.sinceWorkingDays ?? 0) - (a.sinceWorkingDays ?? 0));
  void bandOf;
  return { matterId: s.matterId, band: health.band, health: summariseHealth(health), items: out };
}

/** Group a person's items across their whole caseload into the four buckets, worst first. */
export function buckets(items: WorkItem[]): { do: WorkItem[]; waiting: WorkItem[]; escalate: WorkItem[] } {
  return {
    do: items.filter((i) => i.bucket === 'do'),
    waiting: items.filter((i) => i.bucket === 'waiting'),
    escalate: items.filter((i) => i.bucket === 'escalate'),
  };
}

/** Everything a person has to pick up: the three buckets that are not "someone else's move". */
export const actionable = (items: WorkItem[]): WorkItem[] => items.filter((i) => i.bucket !== 'waiting');
