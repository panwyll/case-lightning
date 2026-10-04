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
import { noteDecisionGroups } from './note-topics';
import { isUserActor, SIGNED_DOCUMENT_LABEL } from './types';
import { amlHoldActive } from './people';
import { acknowledgementTitle, emailChip, noteTaskTitle, nothingToActTitle, replyTitle } from './notes';
import { profileOf } from './transactions';
import { DEFAULT_SLA, dueActions, type SlaConfig } from './sla';
import { ISSUE_KIND_SPEC } from './issues';
import { nextActions } from './graph';
import { caseHealth, summariseHealth, type HealthBand, type HealthSummary } from './health';
import { dueSteps } from './due';
import { ENGINE_ACTION_LABEL, ENGINE_ACTION_SUBJECTS, openIssues, openWaits, pendingDecisions, unaskedWaits, waitUnasked, surfacedDecisions, type MatterState, type LevelConfig, type DecisionState } from './types';
import { EW_CALENDAR, addWorkingDays, workingDaysBetween, type WorkingCalendar } from './working-days';

export type Bucket = 'do' | 'waiting' | 'escalate';
export type ActionOwner = 'conveyancer' | 'client' | 'seller_side' | 'lender' | 'third_party' | 'mlro' | 'hmlr' | 'search_provider' | 'id_provider' | 'linked_case';

/** Who a failed send was for, as the case's contacts record them (from the task's title). */
function addressFor(title: string): { role: string; who: string } | null {
  const t = title.toLowerCase();
  if (/(seller'?s?|buyer'?s?|other side'?s?) solicitor/.test(t)) return { role: 'OTHER_SIDE', who: /buyer/.test(t) ? "the buyer's solicitor" : "the seller's solicitor" };
  if (/family|personal representative/.test(t)) return { role: 'FAMILY', who: "the client's family" };
  if (/lender/.test(t)) return { role: 'LENDER', who: 'the lender' };
  if (/estate agent|agent/.test(t)) return { role: 'AGENT', who: 'the estate agent' };
  if (/client/.test(t)) return { role: 'CLIENT', who: 'the client' };
  return null;
}

export interface WorkItem {
  /** Emails about this issue still to deal with (newest first): opened from the issue's row, not listed again. */
  emails?: string[];
  /** A send that failed for want of an address: whose, so the task can take it. */
  needsAddress?: { role: string; who: string } | null;
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
  /** The case's own colour (set on the Tasks list). */
  caseBand?: HealthBand;
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
  /** A locked file's task: the document its password opens. */
  documentId?: string | null;
  /** The chip on the list, in words. */
  chip?: string;
  /** An issue's severity: colours its chip red / amber / green and sets its urgency. */
  severity?: 'info' | 'warning' | 'critical';
  /** Where to go: the decision, the issue, the wait or just the case. */
  ref: { type: 'decision' | 'issue' | 'wait' | 'requirement' | 'step' | 'client' | 'case' | 'linked'; id: string };
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
  third_party: 'A third party', mlro: 'The MLRO', hmlr: 'HM Land Registry', search_provider: 'The search provider', id_provider: 'The ID provider', linked_case: 'Our linked case',
};
const DECISION_LABEL: Record<string, string> = {
  id_check: 'the ID / AML result', search: 'the search result', enquiry: 'the reply to our enquiry', mortgage: 'the mortgage offer',
  title: 'the title', report_on_title: 'the report on title', contract: 'the contract', escalation: 'the escalation', requisition: "HM Land Registry's requisition",
  proof_of_funds: 'the source of funds', management_pack: 'the management pack',
};
/** What we are waiting for them to do, as the second half of "waiting on X to …". */
const SEARCH_NAME: Record<string, string> = { LLC1: 'LLC1', CON29: 'CON29', DRAINAGE_WATER: 'drainage and water', ENVIRONMENTAL: 'environmental', CHANCEL: 'chancel', MINING: 'coal mining', FLOOD: 'flood risk', HIGHWAYS: 'highways', PLANNING: 'planning history' };
const WAIT_ACTION: Record<string, (subject: string) => string> = {
  search: (sub) => `return the ${sub ? `${SEARCH_NAME[sub] ?? sub.toLowerCase().replace(/_/g, ' ')} ` : ''}search`, enquiry: (sub) => `reply to ${sub ? `enquiry ${sub.replace(/^ISS-\d+-/, '')}` : 'our enquiries'}`, id_check: () => 'return the ID / AML result',
  funds: (sub) => ({ client: 'send the balance of the completion money', lender: 'release the mortgage advance', isa_provider: 'pay the ISA money', buyer_solicitor: 'send the completion money' } as Record<string, string>)[sub] ?? 'send the completion money', registration: () => 'complete the registration', proof_of_funds: () => 'complete the proof of funds form',
  management_pack: () => 'send the management pack', property_forms: () => 'return the property forms', redemption: () => 'send the redemption statement',
  lender_consent: () => 'confirm consent', discharge: () => 'confirm the discharge', contract_pack: () => 'send the draft contract pack and official copies',
  // What the client owes us, in words (never the wait's own key).
  deposit: () => 'send the deposit', insurance: () => 'send the buildings insurance schedule', signed_documents: () => 'return the signed documents',
  mortgage_offer: () => 'tell us when the mortgage offer is issued', survey: () => 'say whether they are having a survey', balance: () => 'send the balance of the completion money',
  client_decision: (sub) => CLIENT_DECISION_WAIT[sub] ?? `give their instruction${sub ? ` on ${sub.replace(/_/g, ' ')}` : ''}`,
};
const CLIENT_DECISION_WAIT: Record<string, string> = {
  exchange_authority: 'authorise exchange', physical_condition: 'say how they want to go ahead after the survey', further_investigation: 'decide on the further investigation',
  accept_risk: 'say whether they accept the risk', accept_terms: 'accept the terms', completion_date: 'agree the completion date', ownership_basis: 'say how they will own the property',
};
/** "Client to answer query Q4 sent: …" → "answer query Q4"; "Take the client's instruction: X has not been recorded" → "give their instruction on X". */
export function clientAction(what: string): string {
  const q = what.match(/^Client to answer (query \S+)/i);
  if (q) return `answer ${q[1]}`;
  if (/instruction to exchange/i.test(what)) return 'authorise exchange';
  const i = what.match(/^Take the client's instruction:\s*(.+?)(?: has not been recorded)?$/i);
  if (i) {
    const t = i[1].replace(/^the client's instruction to /i, '').trim();
    // "the client has not sent the policy schedule" → "send the policy schedule"
    const owed = t.match(/^the clients? (?:has|have) not (sent|returned|given|signed|paid) (.+)$/i);
    if (owed) return `${({ sent: 'send', returned: 'return', given: 'give', signed: 'sign', paid: 'pay' } as Record<string, string>)[owed[1].toLowerCase()]} ${owed[2]}`;
    return `give their instruction on ${t}`;
  }
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
/** Whose bank details a verification is for, in words. */
const BANK_WHOSE: Record<string, string> = { lender: "the lender's", seller_solicitor: "the seller's solicitor's", buyer_solicitor: "the buyer's solicitor's", firm_client_account: 'our client account', client: "the client's", estate_agent: "the estate agent's", hmrc: "HMRC's" };
const BANK_WHO: Record<string, string> = { lender: 'the lender', seller_solicitor: "the seller's solicitor", buyer_solicitor: "the buyer's solicitor", firm_client_account: 'or from our client account', client: 'the client', estate_agent: 'the estate agent', hmrc: 'HMRC' };
const bankPayee = (s: MatterState, subject: string | null | undefined): string => {
  const rec = subject ? (s.bankDetails as Record<string, { payeeKind: string } | undefined>)[subject] : undefined;
  return rec?.payeeKind ?? Object.values(s.bankDetails as Record<string, { payeeKind: string; status: string }>).find((b) => b.status === 'unverified')?.payeeKind ?? '';
};
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

/** What a first request asks for, as its task says it. */
/** What each wait is for, as a chase's task says it. */
const WAIT_LABEL: Record<string, string> = { mortgage_offer: 'News of the mortgage offer', survey: 'Whether the client is having a survey', contract_pack: "The draft contract pack", id_check: 'ID documents from the client', search: 'The search result', enquiry: 'Replies to our enquiries', funds: 'Completion funds', registration: 'Registration at HM Land Registry', proof_of_funds: 'The proof-of-funds form', management_pack: 'The management pack', property_forms: 'The property forms', redemption: 'The redemption statement', lender_consent: "The lender's consent", discharge: 'Discharge of the old mortgage', signed_documents: 'The signed documents', deposit: 'The deposit', client_decision: "The client's answer", insurance: 'Buildings insurance' };
const REQUEST_TITLE: Record<string, string> = {
  request_contract_pack: 'The draft contract pack', request_management_pack: 'The leasehold management pack', request_redemption_statement: 'A redemption statement',
  request_lender_consent: "The lender's consent", request_discharge: 'Discharge of the old mortgage', exchanged_agent: 'Exchanged: tell the agent', completed_agent: 'Completed: tell the agent',
  enquiries_to_seller_solicitor: 'Our enquiries',
};
/** What a standard client update is about, in the words of its subject line. */
const UPDATE_TITLE: Record<string, string> = { searches_ordered: 'Searches ordered', searches_all_back: 'Searches all back', search_back_all_clear: 'Search back, all clear', search_back_under_review: 'Search back, under review', enquiries_raised: 'Enquiries raised', mortgage_offer_checked: 'Mortgage offer checked', report_on_title_sent: 'Report on title sent', exchanged: 'Contracts exchanged', completed: 'Completed', registration_complete: 'Registration complete', chase_update: 'We chased today', access_conditions: 'Access for the specialist: the seller\'s conditions', file_password: 'Password for a file we sent' };
/** A review's chip is the kind of work it is (the title says which document): signing off a document, verifying details, answering a requisition. */
const DECISION_CHIP: Record<string, string> = { search: 'Document Sign-Off', enquiry: 'Document Sign-Off', mortgage: 'Document Sign-Off', title: 'Document Sign-Off', id_check: 'Document Sign-Off', proof_of_funds: 'Document Sign-Off', report_on_title: 'Document Sign-Off', contract: 'Document Sign-Off', management_pack: 'Document Sign-Off', lease: 'Document Sign-Off', bank_details: 'Verify Details', requisition: 'Answer Requisition', escalation: 'Escalation', auto_clear: 'Confirm Check', note_actions: 'Apply Note' };

/** Who a message is for, as a chip starts ("Client", "Seller's Solicitor") and as a sentence says it ("the client", "the seller's solicitor"). */
const MSG_PARTY: Record<string, { chip: string; the: string }> = {
  family: { chip: 'The Family', the: "the client's family" },
  client: { chip: 'Client', the: 'the client' }, seller_solicitor: { chip: "Seller's Solicitor", the: "the seller's solicitor" }, buyer_solicitor: { chip: "Buyer's Solicitor", the: "the buyer's solicitor" },
  lender: { chip: 'Lender', the: 'the lender' }, estate_agent: { chip: 'Agent', the: 'the estate agent' }, search_provider: { chip: 'Search Provider', the: 'the search provider' }, hmlr: { chip: 'HMLR', the: 'HM Land Registry' },
};
const partyOf = (role: unknown) => MSG_PARTY[String(role ?? 'client')] ?? { chip: 'Other Side', the: 'the other side' };
/** Client messages that ask them to do something (a Client Request); the rest of a client's messages are updates. */
const CLIENT_REQUESTS = new Set(['id_check_request', 'proof_of_funds_request', 'proof_of_funds_followup', 'deposit_request', 'property_forms_request', 'exchange_authority_request', 'balance_request', 'ownership_basis_request', 'buildings_insurance_request', 'request_survey_report', 'mortgage_change_query']);
/** A due step's chip: whose it is, and what kind of thing. */
/** Who sorts an issue out when it is not us: the chip says who we are chasing. */
const WHO_FIXES: Record<string, string> = { seller_side: 'The Seller\'s Side', client: 'The Client', lender: 'The Lender', third_party: 'The Third Party' };

/** A due step's chip is the kind of work (the title says what exactly); files going out are "Send <who> Documents". */
export const DUE_CHIP: Record<string, string> = {
  official_copies: 'Upload Documents', proof_of_funds_request: 'Client Request', proof_of_funds_followup: 'Client Request', report_on_title_redraft: 'Draft Document', report_on_title_send: 'Send Client Documents', contract_pack: "Send Buyer's Solicitor Documents", management_pack_sale: 'Managing Agent Request',
  contract_approved_sale: 'Record Outcome', contract_approve: 'Document Sign-Off', buyer_enquiries: 'Reply To Enquiries', exchange: 'Exchange Contracts', completion_statement: 'Send Client Documents',
  funds_cleared: 'Record Receipt', refund: 'Return Money', shortfall_request: 'Request Funds',
  deposit_in: 'Record Receipt', final_bill: 'Send Client Documents', completion_payment_sent: 'Record Outcome', contributions: 'Record Outcome', register_check: 'Record Outcome', requisition_extend: 'Record Outcome', sdlt_facts: 'Record Outcome', cgt_facts: 'Record Outcome', longstop_date: 'Record Outcome', charge_statement: 'Record Receipt', charge_redeemed: 'Record Outcome', undertaking: "Send Buyer's Solicitor Documents", completion_information: 'Record Receipt', undertaking_discharge: "Send Buyer's Solicitor Documents",
  certificate_of_title: 'Send Lender Documents', bankruptcy_search: 'Run Search', priority_search: 'Run Search', funds_request: 'Request Funds', advance_request: 'Request Funds', completion_monies: 'Record Receipt', consideration: 'Record Receipt',
  completion_payment: 'Authorise Payment', redemption_payment: 'Authorise Payment', completion: 'Confirm Completion', balance_to_client: 'Authorise Payment', death_close: 'Close Case', agent_commission: 'Authorise Payment', sdlt_payment: 'Authorise Payment', mortgage_redeemed: 'Record Outcome',
  sdlt: 'File Return', ap1: 'Submit Application', notice_of_assignment: 'Send Landlord Documents', close_file: 'Close File',
};
/** "your proof of funds form" → "proof-of-funds form": what an acknowledgement is for, without the letter's own pronoun. */
const ackThing = (what: unknown): string => String(what ?? 'what they sent').replace(/^(your|the|their|our)\s+/i, '').replace(/\bproof of funds\b/i, 'proof-of-funds');

/** The chip for a proposal: "<who> <kind>" — Client Acknowledgement, Seller's Solicitor Chaser, Lender Request, Client Update. */
/** The engine names the other side's solicitor 'seller_solicitor' whichever side we act for: acting for the seller, that is the buyer's. */
const roleOnSide = (role: unknown, side: string | null | undefined): unknown => (side === 'seller' && role === 'seller_solicitor' ? 'buyer_solicitor' : role);
export function proposalChip(action: string, det: Record<string, unknown>, side?: string | null): string {
  const who = partyOf(roleOnSide(det.recipientRole ?? (action === 'client_update' ? 'client' : null), side)).chip;
  if (action === 'acknowledgement') return `${who} Acknowledgement`;
  if (action === 'search_order') return 'Search Order';
  if (action === 'enquiry_draft') return 'Other Side Enquiries';
  // A letter written for an event (a death): a letter, not a routine update or a chase.
  if (det.letter) return `Letter To ${action === 'counterparty_update' ? (det.to === 'estate_agent' ? 'The Agent' : 'The Other Side') : action === 'client_update' ? 'The Client' : partyOf(det.recipientRole).the.replace(/\b\w/g, (c) => c.toUpperCase()).replace("'S", "'s")}`;
  if (action === 'counterparty_update') return det.to === 'estate_agent' ? 'Agent Update' : 'Other Side Update';
  if (action === 'chase' && det.kind === 'request') return det.template === 'exchanged_agent' || det.template === 'completed_agent' ? 'Agent Update' : `${who} Request`;
  if (action === 'chase') return `${who} Chaser`;
  if (action === 'client_update') {
    const k = String(det.kind ?? det.template ?? '');
    // Files going to them: the pack to sign, a copy of a document, the completion statement.
    if (k === 'signing_pack' || k === 'file_copy' || k === 'completion_statement') return 'Send Client Documents';
    if (CLIENT_REQUESTS.has(k)) return 'Client Request';
    if (k === 'survey_advice') return 'Client Advice';
    return 'Client Update';
  }
  return who;
}

/** What kind of task a decision is, for the chip on a list: a proposal by what it would send or do, anything else by what arrived. */
export function decisionTask(s: MatterState, d: DecisionState): { kind: string; chip: string } {
  if (d.kind === 'proposal') {
    const pr = s.proposals[d.eventId];
    const det = (pr?.detail ?? {}) as Record<string, unknown>;
    const sub = pr?.action === 'client_update' && typeof det.kind === 'string' ? det.kind : pr?.action ?? 'proposal';
    // The chip is who and what kind ("Client Acknowledgement", "Lender Request"); the title says exactly what.
    const chip = proposalChip(pr?.action ?? 'proposal', det, profileOf(s.transactionType).side);
    // Proposed only because the case is in manual handling (it would otherwise have gone on its own): the chip says so.
    return { kind: `proposal:${sub}`, chip: det.manualMode ? `Manual Mode · ${chip}` : chip };
  }
  if (d.kind === 'note_actions') {
    const note = Object.values(s.notes).find((n) => n.decisionEventId === d.eventId);
    // An acknowledgement both checks agreed on: one click confirms no reply is needed.
    if (note?.kind === 'email' && note.acknowledgement && !note.actions.some((a) => a.command)) return { kind: 'note_actions:ack', chip: emailChip(note.from) };
    if (note?.kind === 'email') return { kind: 'note_actions:email', chip: emailChip(note.from) };
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
    // Every task is the action it approves, in words: "Send the client the ID check", "Ask the lender for a redemption statement".
    // The engine's 'seller_solicitor' is the other side's solicitor: acting for the seller, the buyer's.
    const whom = (raw: unknown) => { const role = roleOnSide(raw, profileOf(s.transactionType).side); return (role === 'seller_solicitor' ? "the seller's solicitor" : role === 'buyer_solicitor' ? "the buyer's solicitor" : role === 'search_provider' ? 'the search provider' : role === 'lender' ? 'the lender' : role === 'estate_agent' ? 'the estate agent' : role === 'hmlr' ? 'HM Land Registry' : role === 'client' ? 'the client' : 'the other side'); };
    const low = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
    switch (pr.action) {
      case 'acknowledgement': { const p = partyOf(roleOnSide(det.recipientRole ?? 'client', profileOf(s.transactionType).side)).the; return `Acknowledge receipt of ${p}'s ${ackThing(det.what)}`.replace("solicitor's's", "solicitor's"); }
      case 'chase': {
        if (det.letter && typeof det.title === 'string') return det.title;
        if (det.kind === 'request') {
          const t = String(det.template ?? '');
          if (t === 'exchanged_agent') return 'Tell the estate agent contracts are exchanged';
          if (t === 'completed_agent') return 'Tell the estate agent completion has happened';
          if (t === 'enquiries_to_seller_solicitor') return `Send our enquiries to ${profileOf(s.transactionType).side === 'seller' ? "the buyer's solicitor" : "the seller's solicitor"}`;
          return `Ask ${whom(det.recipientRole)} for ${low(REQUEST_TITLE[t] ?? t.replace(/^request_/, '').replace(/_/g, ' '))}`;
        }
        const key = typeof det.waitKey === 'string' ? det.waitKey : '';
        const subj = typeof det.subject === 'string' && det.subject && !/^[0-9a-f-]{20,}$/i.test(det.subject) ? ` (${SEARCH_NAME[det.subject] ?? det.subject.replace(/_/g, ' ')})` : '';
        return `Chase ${whom(det.recipientRole)} for ${low(WAIT_LABEL[key] ?? 'what they owe')}${subj}`;
      }
      case 'counterparty_update': if (det.letter && typeof det.title === 'string') return det.title; return `Tell ${whom(det.to)} ${String(det.title ?? 'where our side stands').replace(/^./, (x) => x.toLowerCase())}`;
      case 'search_order': { const n = SEARCH_NAME[cleanSubject ?? String(det.searchType ?? '')] ?? cleanSubject ?? String(det.searchType ?? ''); return `Order the ${n}${/search/i.test(n) ? '' : ' search'}`; }
      case 'enquiry_draft': {
        const k = pr.dedupKey;
        const about = typeof det.title === 'string' ? det.title
          : k.startsWith('enquiry_draft:survey:') ? 'from the survey'
          : /^enquiry_draft:access/.test(k) ? 'access for specialists'
          : k.startsWith('enquiry_draft:evidence') ? 'evidence from the seller'
          : k.startsWith('enquiry_draft:client:') ? "on the client's instruction"
          : typeof det.question === 'string' && det.question ? "from the seller's forms" : '';
        // The other side: the seller's solicitor when we act for the buyer, the buyer's when we act for the seller.
        return `Send enquiries to ${profileOf(s.transactionType).side === 'seller' ? "the buyer's solicitor" : "the seller's solicitor"}${about ? `: ${low(about)}` : ''}`;
      }
      case 'client_update': {
        if (det.kind === 'id_check_request') { const l = typeof det.label === 'string' ? det.label : ''; return `Send ${!l || /^the client$/i.test(l) ? 'the client' : l} the ID check`; }
        if (det.kind === 'proof_of_funds_request') return det.followUpOf ? 'Ask the client for more proof of funds' : 'Send the client the proof-of-funds form';
        if (det.kind === 'signing_pack') { const docs = Array.isArray(det.documents) ? (det.documents as string[]).map((x) => (SIGNED_DOCUMENT_LABEL as Record<string, string>)[x]?.toLowerCase()).filter(Boolean) : []; return `Send the client the signing pack${docs.length ? ` (${docs.join(', ')})` : ''}`; }
        if (det.kind === 'survey_advice') return 'Send the client your advice on the survey';
        const tpl = typeof det.template === 'string' ? det.template : '';
        const ctx = (det.context ?? {}) as Record<string, unknown>;
        if (tpl === 'progress_update' && typeof ctx.done === 'string') return `Update the client: ${low(ctx.done)}`;
        if (tpl === 'file_copy') return `Send the client a copy of ${typeof ctx.what === 'string' ? ctx.what : 'the file'}`;
        const asks: Record<string, string> = { property_forms_request: 'Send the client the property forms', deposit_request: 'Ask the client for the deposit', exchange_authority_request: 'Ask the client for authority to exchange', balance_request: 'Ask the client for the balance of the completion money', ownership_basis_request: 'Ask the clients how they will own the property', buildings_insurance_request: s.transactionType === 'remortgage' ? 'Ask the client for their buildings insurance schedule' : 'Ask the client for buildings insurance from exchange', request_survey_report: 'Ask the client for the survey report', mortgage_change_query: 'Ask the client what changed with the mortgage', completion_statement: 'Send the client the completion statement' };
        if (asks[tpl]) return asks[tpl];
        return `Update the client: ${low(UPDATE_TITLE[tpl] ?? tpl.replace(/_/g, ' '))}`;
      }
      default: return `${ENGINE_ACTION_LABEL[pr.action] ?? pr.action}`;
    }
  };
  // A note's task says what it would put on the case, not "Note actions — N-012".
  if (d.kind === 'note_actions') {
    const note = s.notes[cleanSubject ?? ''] ?? Object.values(s.notes).find((x) => x.decisionEventId === d.eventId);
    // A client's email with a drafted reply is the reply: its lines are inside it.
    const title = note ? (note.kind === 'email' && (note.messages?.length || note.reply) ? replyTitle(note.from, note.actions) : noteTaskTitle(note.actions) ?? (note.kind === 'email' ? (note.acknowledgement ? acknowledgementTitle(note.from, note.text) : nothingToActTitle(note.from)) : null)) : null;
    if (title) return title;
  }
  return (
    d.kind === 'bank_details' ? `Confirm ${BANK_WHOSE[bankPayee(s, d.subject ?? cleanSubject)] ?? 'the new'} bank details by phone, on a number you find yourself (no payment until you do)`
    : d.kind === 'escalation' ? (() => {
      // A person's escalation says what was escalated, not only the note they wrote ("Escalated by handler: …").
      const orig = /Original decision \(([a-z_]+)(?: ([^)]*))?\)/.exec(d.summary ?? '');
      const mine = /^Escalated (by handler|again)(?::\s*(.+?))?\.?$/.exec(firstLine);
      if (orig && mine) {
        const what = orig[1] === 'search' && orig[2] ? `the ${SEARCH_NAME[orig[2]] ?? orig[2].toLowerCase()} search result` : DECISION_LABEL[orig[1]] ?? orig[1].replace(/_/g, ' ');
        return `Decide on ${what} (escalated${mine[1] === 'again' ? ' again' : ''}${mine[2] ? `: ${mine[2].replace(/\.$/, '')}` : ''})`;
      }
      return escalationLine(firstLine || 'Deal with an escalation');
    })()
    : d.kind === 'auto_clear' ? `Confirm the rules' clear of ${!cleanSubject ? 'the document' : /^(?:ISS-\d+-)?E\d+$/.test(cleanSubject) ? `the reply to enquiry ${cleanSubject.replace(/^ISS-\d+-/, '')}` : SEARCH_NAME[cleanSubject] ? `the ${SEARCH_NAME[cleanSubject]} search` : cleanSubject.replace(/^ID\/AML check(?: — (.*?))?(?: \([^)]*\))?$/, (_m, who: string | undefined) => `the ID / AML check${who ? ` for ${who}` : ''}`)}`
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
  if (!s.enrolled || s.closedAt) return { matterId: s.matterId, band: health.band, health: summariseHealth(health), items: out };
  const owner = ctx.assignedTo ?? null;
  const base = { matterId: s.matterId, matterRef: ctx.matterRef ?? null, propertyAddress: ctx.propertyAddress ?? null, clients: profileOf(s.transactionType).side === 'seller' ? ctx.sellers ?? [] : ctx.buyers ?? [], responsibilityOwner: owner };
  const bandOf = (code: string): HealthBand => health.reasons.find((r) => r.ref.id === code)?.band ?? 'normal';

  // ── DO: decisions a person must resolve ──
  // Only what a person may act on (shadow-mode matters surface nothing).
  const surfaced = surfacedDecisions(s);
  // Emails repeating one subject are one task: beside the open issue on it, or the newest email alone.
  const noteGroups = noteDecisionGroups(s);
  for (const d of surfaced.filter((x) => (x.kind !== 'auto_clear' || !!s.pendingAutoClears[x.eventId]) && !noteGroups.covered.has(x.eventId))) {
    const age = wd(d.createdAt, now, cal);
    const what = decisionSentence(s, d);
    // A note proposing issues carries the most severe of them: its chip is coloured like the issue it would raise.
    const note = d.kind === 'note_actions' ? Object.values(s.notes).find((n) => n.decisionEventId === d.eventId) : undefined;
    const proposedSev = (note?.actions ?? []).map((a) => a.command).filter((c): c is Extract<NonNullable<typeof c>, { type: 'raise_issue' }> => c?.type === 'raise_issue').map((c) => c.severity ?? ISSUE_KIND_SPEC[c.kind]?.severity ?? 'warning');
    const severity = proposedSev.includes('critical') ? 'critical' as const : proposedSev.includes('warning') ? 'warning' as const : proposedSev.length ? 'info' as const : undefined;
    out.push({
      ...base,
      id: `${d.kind === 'escalation' ? 'escalate' : 'do'}:decision:${d.eventId}`,
      // An escalation decision IS the escalation: the timer gave up on writing and asked
      // for a person. It does not belong in the same column as an ordinary decision.
      bucket: d.kind === 'escalation' ? 'escalate' : 'do',
      ...decisionTask(s, d),
      what,
      unblocks: d.kind === 'bank_details' ? `Payment to ${BANK_WHO[bankPayee(s, d.subject ?? null)] ?? 'them'}` : null,
      actionOwner: 'conveyancer',
      // An escalation exists because a clock already ran out — it is never "normal".
      urgency: d.kind === 'bank_details' || severity === 'critical' ? 'critical' : severity === 'warning' ? 'delayed' : d.kind === 'escalation' || age >= 2 ? 'attention' : 'normal',
      ...(severity ? { severity } : {}),
      workstream: null,
      since: d.createdAt, sinceWorkingDays: age, slaWorkingDays: null, chaseInWorkingDays: null,
      chasesSent: 0, mode: null, escalatesInWorkingDays: null, escalated: false, dueBy: null, chaseDue: false,
      ref: { type: 'decision', id: d.eventId },
    });
  }

  // ── DO: issues whose next step is ours, and anyone's once it is past its resolve-by date ──
  const acting = profileOf(s.transactionType).side;
  for (const i of openIssues(s)) {
    const spec = ISSUE_KIND_SPEC[i.kind];
    if (spec.context) continue; // context: on the file and in status answers, not a task
    // Our client's own sale and purchase exchange together: nothing to chase, nobody to ask. It waits on our
    // other file, whose own tasks are on the list, and clears itself when that file can exchange.
    if (i.kind === 'chain_dependency' && s.relatedMatter && /^Linked (sale|purchase):/.test(i.title)) {
      const rel = s.relatedMatter.relation;
      out.push({
        ...base,
        id: `waiting:linked:${i.id}`,
        bucket: 'waiting',
        kind: 'linked_case',
        chip: `Linked ${rel === 'sale' ? 'Sale' : 'Purchase'}`,
        what: `Exchanges together with our client's ${rel}`,
        unblocks: 'Exchange',
        actionOwner: 'linked_case',
        urgency: 'normal',
        workstream: null,
        since: i.raisedAt, sinceWorkingDays: null, slaWorkingDays: null, chaseInWorkingDays: null,
        chasesSent: 0, mode: null, escalatesInWorkingDays: null, escalated: false, dueBy: null, chaseDue: false,
        ref: { type: 'linked', id: s.relatedMatter.matterId },
      });
      continue;
    }
    // The catalogue speaks from the buyer's side: on a sale, what the seller's side owes is ours to do.
    // Every open issue is a task: one that waits on someone else is ours to chase, never off the list (a hidden issue holding a gate is a silent stall).
    // What a person recorded (Something Happened, Raise Issue) is theirs to drive, whatever the kind's usual owner.
    const ours = spec.responsible === 'conveyancer' || spec.responsible === 'mlro' || (spec.responsible === 'seller_side' && acting === 'seller') || isUserActor(i.raisedBy);
    if (i.enquiryIds.some((q) => s.enquiries[q] && s.enquiries[q].status !== 'cleared' && s.enquiries[q].status !== 'reviewed')) continue; // tracked by a live enquiry → it is a WAITING, not a DO
    out.push({
      ...base,
      id: `do:issue:${i.id}`,
      bucket: 'do',
      kind: i.kind === 'send_failed' && /\[(proposal|retry):/.test(i.detail ?? '') ? 'issue:send_failed:retry' : i.kind === 'file_locked' && /\[doc:[0-9a-f-]{36}\]/.test(i.detail ?? '') ? 'issue:file_locked' : 'issue',
      // A locked file is opened from the task itself: the password goes against this document.
      documentId: i.kind === 'file_locked' ? (/\[doc:([0-9a-f-]{36})\]/.exec(i.detail ?? '')?.[1] ?? null) : null,
      // The chip says what kind of problem; the line is the problem itself, as it was raised.
      // The kind of work: sort out the problem (the title says which), send it again, unlock the file.
      chip: i.kind === 'send_failed' ? 'Unsuccessful Send' : i.kind === 'file_locked' ? 'Unlock File' : i.referredTo ? `With ${({ mlro: 'The MLRO', partner: 'A Partner', colp: 'The COLP' } as const)[i.referredTo]}` : ours ? 'Resolve Issue' : `Chase ${WHO_FIXES[spec.responsible] ?? 'The Other Side'}`,
      // Older failures were titled "The chase to seller solicitor did not go: <reason>": read as the current wording.
      what: i.title.replace(/\s*\[[a-z-]+:[^\]]*\]/g, '').trim().replace(/^The (.+?) did not go:.*$/, (_m, w: string) => `${w.charAt(0).toUpperCase()}${w.slice(1).replace(/\bseller solicitor\b/, "the seller's solicitor").replace(/\bbuyer solicitor\b/, "the buyer's solicitor")} unsuccessful`),
      // No address for them: the task takes it and sends (not a trip to the case's contacts).
      needsAddress: i.kind === 'send_failed' && /no email address/i.test(i.detail ?? '') ? addressFor(i.title) : null,
      unblocks: i.gate === 'none' ? null : i.gate === 'exchange' ? 'Exchange' : 'Completion',
      actionOwner: spec.responsible === 'mlro' ? 'mlro' : 'conveyancer',
      // Severity sets the urgency (red, amber, green); what it holds breaks the tie within amber.
      severity: i.severity,
      urgency: i.severity === 'critical' ? 'critical' : i.severity === 'warning' ? (i.gate !== 'none' ? 'blocked' : 'delayed') : 'attention',
      workstream: spec.workstreams[0] ?? null,
      since: i.raisedAt, sinceWorkingDays: wd(i.updatedAt, now, cal), slaWorkingDays: spec.escalateAfterWorkingDays ?? null,
      chaseInWorkingDays: null, chasesSent: 0, mode: null, escalatesInWorkingDays: null, escalated: false, dueBy: i.resolveBy ?? null, chaseDue: false,
      ref: { type: 'issue', id: i.id },
      ...(noteGroups.byIssue.get(i.id)?.length ? { emails: noteGroups.byIssue.get(i.id) } : {}),
    });
  }

  // ── DO: every step waiting on us (due.ts), derived from the case so none can drop off the list ──
  for (const d of dueSteps(s, now)) {
    const overdue = d.dueDate ? d.dueDate < now.toISOString().slice(0, 10) : false;
    out.push({
      ...base,
      id: `do:step:${d.key}`,
      bucket: 'do',
      kind: 'step',
      // A step's chip is whose and what kind; a held-back send keeps its own ("Client Request").
      chip: d.key.startsWith('resend:') ? (() => { const pr = s.proposals[d.key.slice('resend:'.length)]; return pr ? proposalChip(pr.action, pr.detail as Record<string, unknown>, profileOf(s.transactionType).side) : 'Held Back'; })() : DUE_CHIP[d.key] ?? DUE_CHIP[d.key.split(':')[0]] ?? undefined,
      what: d.title,
      // A step is its own title; the line under it is only ever something to know before doing it.
      unblocks: null,
      actionOwner: 'conveyancer',
      urgency: overdue ? 'critical' : d.dueDate ? 'attention' : 'normal',
      workstream: d.lane,
      since: null, sinceWorkingDays: null, slaWorkingDays: null, chaseInWorkingDays: null,
      chasesSent: 0, mode: null, escalatesInWorkingDays: null, escalated: false, dueBy: d.dueDate ?? null, chaseDue: false,
      ref: { type: 'step', id: d.key },
    });
  }

  // ── WAITING: every open wait, with its clock. Chasing is the engine's job, not a pile:
  //    when the clock runs out the next sweep sends the chase, and the item stays here
  //    with the count on it and its severity one notch higher. ──
  const chaseDue = new Set(dueActions(s, now, sla, cal).filter((d) => d.kind === 'chase').map((d) => `${d.wait.key}:${d.wait.subject}`));
  // A wait the timer has already escalated is on the list once, as the escalation a person
  // can actually resolve — not twice, as the wait and its escalation.
  const escalatedAsDecision = new Set(surfaced.filter((d) => d.kind === 'escalation' && d.subject).map((d) => d.subject as string));
  const notAsked = unaskedWaits(s);
  for (const w of openWaits(s)) {
    const rule = sla[w.key];
    if (!rule) continue;
    // Its request has not gone (it is a task on the list): not something we are waiting on yet.
    if (waitUnasked(s, w, notAsked)) continue;
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
  // A client wait (the deposit, the insurance, the decision to exchange) is already on the list with its chase: not twice.
  // A request we have not sent yet is our task, not something we wait for: the same holds until it goes.
  const ASKED_BY: Record<string, string> = { buildings_insurance_request: 'insurance', deposit_request: 'deposit', exchange_authority_request: 'exchange_authority' };
  const unsent = Object.values(s.proposals).filter((p) => p.status === 'pending' && p.action === 'client_update').map((p) => ASKED_BY[String((p.detail as { template?: unknown }).template ?? '')]).filter(Boolean);
  const waitedOn = new Set([...openWaits(s).flatMap((w) => [w.key, w.key === 'client_decision' ? w.subject : '']), ...unsent].filter(Boolean));
  const sameAsWait = (id: string, what: string) => waitedOn.has(id) || (waitedOn.has('exchange_authority') && /instruction to exchange|authorise exchange/i.test(what)) || (waitedOn.has('insurance') && /insurance|policy schedule/i.test(what));
  for (const a of nextActions(s, now).filter((x) => x.who === 'client' && x.ref.type === 'client' && askable(x.ref.id) && !sameAsWait(x.ref.id, x.what))) {
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

  // ── DO: a case held for the NCA's answer to a report (people.ts): on the list with its two answers. Never said to the client. ──
  if (amlHoldActive(s, now) && s.amlHold) {
    const until = (s.amlHold.status === 'refused' ? s.amlHold.moratoriumEnds : s.amlHold.noticeEnds)?.slice(0, 10) ?? null;
    const untilText = until ? new Date(`${until}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'the notice period ends';
    out.push({
      ...base,
      id: 'do:aml_hold',
      bucket: 'do',
      kind: s.amlHold.status === 'awaiting' ? 'aml_hold' : 'aml_hold:refused',
      chip: 'On Hold',
      what: s.amlHold.status === 'refused' ? `NCA refused consent: nothing exchanges and no money moves until ${untilText} (say nothing to the client)` : `NCA consent requested: nothing exchanges and no money moves until it answers, or ${untilText} (say nothing to the client)`,
      unblocks: 'Exchange and any payment',
      actionOwner: 'mlro',
      urgency: 'critical',
      workstream: null,
      since: s.amlHold.since, sinceWorkingDays: wd(s.amlHold.since, now, cal), slaWorkingDays: null, chaseInWorkingDays: null,
      chasesSent: 0, mode: null, escalatesInWorkingDays: null, escalated: false, dueBy: until, chaseDue: false,
      ref: { type: 'case', id: 'aml_hold' },
    });
  }

  const rank: Record<HealthBand, number> = { critical: 0, blocked: 1, delayed: 2, attention: 3, normal: 4 };
  out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (b.sinceWorkingDays ?? 0) - (a.sinceWorkingDays ?? 0));
  void bandOf;
  // A file that stopped still owes what it owes: money back, and the message telling the other side. Nothing else.
  if (s.abandoned) return { matterId: s.matterId, band: health.band, health: summariseHealth(health), items: out.filter((x) => x.kind === 'step' || (x.ref.type === 'decision' && s.decisions[x.ref.id]?.kind === 'proposal')) };
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
