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
import { profileOf } from './transactions';
import { DEFAULT_SLA, dueActions, type SlaConfig } from './sla';
import { ISSUE_KIND_SPEC } from './issues';
import { nextActions } from './graph';
import { caseHealth, summariseHealth, type HealthBand, type HealthSummary } from './health';
import { ENGINE_ACTION_LABEL, ENGINE_ACTION_SUBJECTS, openIssues, openWaits, pendingDecisions, surfacedDecisions, type MatterState, type LevelConfig, type DecisionState } from './types';
import { EW_CALENDAR, addWorkingDays, workingDaysBetween, type WorkingCalendar } from './working-days';

export type Bucket = 'do' | 'waiting' | 'escalate';
export type ActionOwner = 'conveyancer' | 'client' | 'seller_side' | 'lender' | 'third_party' | 'mlro' | 'hmlr' | 'search_provider' | 'id_provider';

export interface WorkItem {
  id: string;
  bucket: Bucket;
  matterId: string;
  matterRef: string | null;
  propertyAddress: string | null;
  /** The firm's clients on the matter. */
  clients: string[];
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
  /** WAITING: who asked — a person's id, or system / ai / external. */
  openedBy?: string | null;
  /** WAITING: the log position of the event that opened it (to look the opener up when the stored state predates `openedBy`). */
  openedBySeq?: number;
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
  /** The kind of thing it is (a decision kind, `proposal:<what it would send>`, or issue / wait). */
  kind?: string;
  /** The chip on the list, in words. */
  chip?: string;
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
const SEARCH_NAME: Record<string, string> = { LLC1: 'LLC1', CON29: 'CON29', DRAINAGE_WATER: 'drainage and water', ENVIRONMENTAL: 'environmental', CHANCEL: 'chancel', MINING: 'coal mining', FLOOD: 'flood risk', HIGHWAYS: 'highways', PLANNING: 'planning history' };
const WAIT_ACTION: Record<string, (subject: string) => string> = {
  search: (sub) => `return the ${sub ? `${SEARCH_NAME[sub] ?? sub.toLowerCase().replace(/_/g, ' ')} ` : ''}search`, enquiry: (sub) => `reply to ${sub ? `enquiry ${sub}` : 'our enquiries'}`, id_check: () => 'return the ID / AML result',
  funds: () => 'release the completion funds', registration: () => 'complete the registration', proof_of_funds: () => 'complete the proof of funds form',
  management_pack: () => 'send the management pack', property_forms: () => 'return the property forms', redemption: () => 'send the redemption statement',
  lender_consent: () => 'confirm consent', discharge: () => 'confirm the discharge', contract_pack: () => 'send the draft contract pack and official copies',
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
  /** The parties as the matter row holds them; the firm's own side is the client. */
  buyers?: string[];
  sellers?: string[];
  /** The fee-earner the matter is assigned to. */
  assignedTo?: string | null;
  /** Kept for callers; every pending decision surfaces now. */
  levels?: LevelConfig | null;
}

const wd = (iso: string, now: Date, cal: WorkingCalendar) => workingDaysBetween(new Date(iso), now, cal);

/**
 * One matter's work, split into the three buckets. Pure in (state, now, ctx).
 * A closed or abandoned matter produces nothing — there is nothing left to do on it.
 */
const subjectLabel = (action: string, subject: string): string => ENGINE_ACTION_SUBJECTS[action as keyof typeof ENGINE_ACTION_SUBJECTS]?.find((s) => s.key === subject)?.label ?? subject.replace(/_/g, ' ');

const PROPOSAL_CHIP: Record<string, string> = { acknowledgement: 'Proposal: acknowledgement', chase: 'Proposal: chase', client_update: 'Proposal: client update', search_order: 'Proposal: search order', enquiry_draft: 'Proposal: enquiry', id_check_request: 'Proposal: ID check', proof_of_funds_request: 'Proposal: form to client' };
/** What a standard client update is about, in the words of its subject line. */
const UPDATE_TITLE: Record<string, string> = { searches_ordered: 'Searches ordered', search_back_all_clear: 'Search back, all clear', search_back_under_review: 'Search back, under review', enquiries_raised: 'Enquiries raised', mortgage_offer_checked: 'Mortgage offer checked', report_on_title_sent: 'Report on title sent', exchanged: 'Contracts exchanged', completed: 'Completed', registration_complete: 'Registration complete', chase_update: 'We chased today' };
const DECISION_CHIP: Record<string, string> = { search: 'Search result', enquiry: 'Enquiry reply', mortgage: 'Mortgage offer', title: 'Official copies', id_check: 'ID / AML result', proof_of_funds: 'Proof of funds', bank_details: 'Bank details', report_on_title: 'Report on title', management_pack: 'Management pack', requisition: 'HMLR requisition', escalation: 'Escalation', auto_clear: 'Auto-cleared', note_actions: 'Note to apply', lease: 'Lease' };

/** What kind of task a decision is, for the chip on a list: a proposal by what it would send or do, anything else by what arrived. */
export function decisionTask(s: MatterState, d: DecisionState): { kind: string; chip: string } {
  if (d.kind === 'proposal') {
    const pr = s.proposals[d.eventId];
    const det = (pr?.detail ?? {}) as Record<string, unknown>;
    const sub = pr?.action === 'client_update' && typeof det.kind === 'string' ? det.kind : pr?.action ?? 'proposal';
    // Who it is for rides in the chip: "Proposal: client acknowledgement", "Proposal: chase seller's solicitor".
    const role = typeof det.recipientRole === 'string' ? det.recipientRole : null;
    const who = role === 'seller_solicitor' ? "seller's solicitor" : role === 'buyer_solicitor' ? "buyer's solicitor" : role === 'search_provider' ? 'search provider' : role === 'lender' ? 'lender' : role === 'hmlr' ? 'HMLR' : role ? role.replace(/_/g, ' ') : null;
    const chip = sub === 'acknowledgement' ? `Proposal: ${who ?? 'client'} acknowledgement` : sub === 'chase' ? `Proposal: chase ${who ?? 'them'}` : PROPOSAL_CHIP[sub] ?? 'Proposal';
    return { kind: `proposal:${sub}`, chip };
  }
  return { kind: d.kind, chip: DECISION_CHIP[d.kind] ?? d.kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) };
}

/** The task in a conveyancer's sentence: what is in front of them, not the engine's name for it. */
export function decisionSentence(s: MatterState, d: DecisionState): string {
  // An escalation's subject is an internal key ("deadline:mortgage_offer_expiry:…"), so
  // it is described by the first line of what the timer actually said.
  // One sentence, not the whole dossier — the detail is on the case.
  const firstLine = ((d.summary ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '').split(/(?<=\.)\s/)[0].slice(0, 120);
  // The task in a conveyancer's sentence: what is in front of them, not the engine's name for it.
  const cleanSubject = d.subject && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(d.subject) ? d.subject.replace(/^[a-z_]+:/, '') : null;
  const flagsOf = (): number => {
    if (d.kind === 'search' && cleanSubject) return s.searches[cleanSubject]?.facts?.flags?.length ?? 0;
    if (d.kind === 'mortgage') return s.mortgage.facts?.conditions.filter((c) => !c.standard).length ?? 0;
    if (d.kind === 'title') return (s.title.facts?.restrictions.length ?? 0) + (s.title.facts?.charges.length ?? 0) + (s.title.facts?.covenants.length ?? 0);
    return 0;
  };
  const points = (k: number, one: string) => (k ? `: ${k} ${k === 1 ? one : `${one}s`}` : '');
  const pr = s.proposals[d.eventId];
  const proposalLine = (): string => {
    if (!pr) return 'Approve the proposal';
    const det = pr.detail as Record<string, unknown>;
    const to = typeof det.recipientRole === 'string' ? det.recipientRole.replace(/_/g, ' ') : det.kind === 'id_check_request' || det.kind === 'proof_of_funds_request' ? 'the client' : pr.action === 'client_update' ? 'the client' : 'the other side';
    const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    switch (pr.action) {
      case 'acknowledgement': return `Received: ${typeof det.what === 'string' ? det.what : 'what they sent'}`;
      case 'chase': return `${cap(typeof det.waitKey === 'string' ? det.waitKey.replace(/_/g, ' ') : 'a reply')}${typeof det.subject === 'string' && det.subject ? ` ${det.subject}` : ''}`;
      case 'search_order': return `${SEARCH_NAME[cleanSubject ?? String(det.searchType ?? '')] ?? cleanSubject ?? String(det.searchType ?? '')}`;
      case 'enquiry_draft': return typeof det.subject === 'string' ? det.subject.slice(0, 120) : "From the seller's forms";
      case 'client_update': {
        if (det.kind === 'id_check_request') return typeof det.label === 'string' ? det.label : 'The client';
        if (det.kind === 'proof_of_funds_request') return det.followUpOf ? 'Further evidence requested' : 'Proof-of-funds form';
        const tpl = typeof det.template === 'string' ? det.template : '';
        const ctx = (det.context ?? {}) as Record<string, unknown>;
        if (tpl === 'progress_update' && typeof ctx.done === 'string') return cap(ctx.done);
        return UPDATE_TITLE[tpl] ?? cap(tpl.replace(/_/g, ' '));
      }
      default: return `${ENGINE_ACTION_LABEL[pr.action] ?? pr.action}`;
    }
  };
  return (
    d.kind === 'bank_details' ? 'Verify bank details out-of-band (payments are stopped until you do)'
    : d.kind === 'escalation' ? escalationLine(firstLine || 'Deal with an escalation')
    : d.kind === 'auto_clear' ? `Confirm the rules' clear of ${cleanSubject ? cleanSubject.replace(/^ID\/AML check(?: — (.*?))?(?: \([^)]*\))?$/, (_m, who: string | undefined) => `the ID / AML check${who ? ` for ${who}` : ''}`) : 'the document'}`
    : d.kind === 'proposal' ? proposalLine()
    : d.kind === 'id_check' ? `ID / AML result for ${d.subject && s.partyChecks[d.subject] ? s.partyChecks[d.subject].label : 'the client'}`
    : d.kind === 'search' ? `${SEARCH_NAME[cleanSubject ?? ''] ? `${SEARCH_NAME[cleanSubject ?? '']} search result` : 'Search result'}${points(flagsOf(), 'point')}`
    : d.kind === 'enquiry' ? `Reply to enquiry ${cleanSubject ?? ''}`.trim()
    : d.kind === 'mortgage' ? `Mortgage offer${s.mortgage.facts?.lender ? ` from ${s.mortgage.facts.lender}` : ''}${points(flagsOf(), 'special condition')}`
    : d.kind === 'title' ? `Official copies${s.title.facts?.titleNumber ? ` of ${s.title.facts.titleNumber}` : ''}${points(flagsOf(), 'entry')}`
    : d.kind === 'proof_of_funds' ? 'Sign off the source of funds'
    : d.kind === 'report_on_title' ? 'Approve the report on title'
    : d.kind === 'management_pack' ? 'Management pack (LPE1)'
    : d.kind === 'requisition' ? "Answer HM Land Registry's requisition"
    : `${(DECISION_LABEL[d.kind] ?? d.kind.replace(/_/g, ' ')).replace(/^the /, '').replace(/^\w/, (c) => c.toUpperCase())}${cleanSubject ? ` — ${cleanSubject}` : ''}`
  );
}

export function matterWork(s: MatterState, now: Date = new Date(), ctx: WorkContext = {}, sla: SlaConfig = DEFAULT_SLA, cal: WorkingCalendar = EW_CALENDAR): MatterWork {
  const health = caseHealth(s, now, sla, cal);
  const out: WorkItem[] = [];
  if (!s.enrolled || s.abandoned || s.closedAt) return { matterId: s.matterId, band: health.band, health: summariseHealth(health), items: out };
  const owner = ctx.assignedTo ?? null;
  const base = { matterId: s.matterId, matterRef: ctx.matterRef ?? null, propertyAddress: ctx.propertyAddress ?? null, clients: profileOf(s.transactionType).side === 'seller' ? ctx.sellers ?? [] : ctx.buyers ?? [], responsibilityOwner: owner };
  const bandOf = (code: string): HealthBand => health.reasons.find((r) => r.ref.id === code)?.band ?? 'normal';

  // ── DO: decisions a person must resolve ──
  // Only what a person may act on (shadow-mode matters surface nothing).
  const surfaced = surfacedDecisions(s);
  for (const d of surfaced.filter((x) => x.kind !== 'auto_clear' || !!s.pendingAutoClears[x.eventId])) {
    const age = wd(d.createdAt, now, cal);
    const what = decisionSentence(s, d);
    out.push({
      ...base,
      id: `${d.kind === 'escalation' ? 'escalate' : 'do'}:decision:${d.eventId}`,
      // An escalation decision IS the escalation: the timer gave up on writing and asked
      // for a person. It does not belong in the same column as an ordinary decision.
      bucket: d.kind === 'escalation' ? 'escalate' : 'do',
      ...decisionTask(s, d),
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
      kind: 'issue',
      chip: i.kind === 'send_failed' ? 'Send failed' : 'Issue',
      what: spec.actions[0] ? `${spec.actions[0]}: ${i.title.replace(/\s*\[[a-z-]+:[^\]]*\]/g, '').trim()}` : i.title.replace(/\s*\[[a-z-]+:[^\]]*\]/g, '').trim(),
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
      since: w.openedAt, sinceWorkingDays: age, openedBy: w.openedBy ?? null, openedBySeq: w.openedBySeq,
      slaWorkingDays: rule.chaseAfter,
      chaseInWorkingDays: nextChaseIn,
      chasesSent: chases,
      mode: Object.values(s.proposals).some((p) => p.action === 'chase' && p.status === 'pending' && p.dedupKey === `${w.key}:${w.subject}`) ? 'needs_approval' : 'automatic',
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
