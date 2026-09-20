/**
 * CONVEYi conveyancing engine — the vocabulary.
 *
 * This is the domain model for the state machine that RUNS a residential freehold
 * purchase (buyer-side). Everything else in lib/server/engine imports from here, so
 * there is exactly one place that says what an event is, what a stage is, what a
 * decision looks like and what the projected state of a matter contains.
 *
 * Design rules (docs/conveyance-engine.md, §"Design principles"):
 *   - The immutable EVENT LOG is the source of truth. `MatterState` is a projection
 *     of it (see projection.ts) and never holds independent state.
 *   - Every transition is either fully automated (actor 'system'/'ai') or a flagged
 *     DECISION that a human resolves. Nothing in between.
 *   - Every decision event carries the source document it is drawn from — the
 *     dashboard forces the handler to open it before they can resolve.
 *
 * v1 scope: `freehold_purchase` only. Anything else is flagged for manual handling.
 */

import type { IssueGate, IssueKind, IssueResolution, IssueStatus } from './issues';

// ───────────────────────────── Stages (2.3) ─────────────────────────────

export const STAGES = [
  'instruction',
  'pre_contract',
  'contract_review',
  'pre_exchange',
  'exchanged',
  'pre_completion',
  'completed',
  'post_completion',
] as const;
export type Stage = (typeof STAGES)[number];

export const stageIndex = (s: Stage): number => STAGES.indexOf(s);

/** Map onto the legacy board column (`matter.stage`, see process-model.ts) so the
 *  existing Kanban keeps mirroring the engine. Forward-only, best-effort. */
export const LEGACY_STAGE: Record<Stage, string> = {
  instruction: 'INSTRUCTION',
  pre_contract: 'SEARCHES_ENQUIRIES',
  contract_review: 'REVIEW_SIGNING',
  pre_exchange: 'REVIEW_SIGNING',
  exchanged: 'EXCHANGE',
  pre_completion: 'EXCHANGE',
  completed: 'COMPLETION',
  post_completion: 'POST_COMPLETION',
};

/** Addendum: is the other side an external firm or another matter in this firm (walled off)? Stamped on correspondence events. */
export type CounterpartyType = 'internal' | 'external';

export const TRANSACTION_TYPES = ['freehold_purchase'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

// ───────────────────────────── Event types (2.5) ─────────────────────────────

/**
 * The v1 event vocabulary. The spec's minimum set plus the extensions the
 * auto-clear/flag pattern needs to be symmetric for every sub-flow
 * (`*_cleared` / `*_flagged` / `*_reviewed`), `stage_advanced` so stage moves are
 * themselves logged (not inferred), and `decision_source_opened` — the audit record
 * that a handler actually looked at the source before resolving.
 */
export const EVENT_TYPES = [
  // lifecycle
  'matter_created',
  'stage_advanced',
  'manual_handling_required',
  // instruction
  'id_check_requested',
  'id_check_cleared',
  'id_check_flagged',
  'id_check_reviewed',
  // searches
  'search_ordered',
  'search_returned',
  'search_extracted',
  'search_cleared',
  'search_flagged',
  'search_reviewed',
  // enquiries
  'enquiry_raised',
  'enquiry_reply_received',
  'enquiry_reply_cleared',
  'enquiry_reply_flagged',
  'enquiry_reply_reviewed',
  // mortgage
  'mortgage_offer_received',
  'mortgage_offer_extracted',
  'mortgage_offer_cleared',
  'mortgage_condition_flagged',
  'mortgage_condition_reviewed',
  // title
  'title_extracted',
  'title_cleared',
  'title_flagged',
  'title_reviewed',
  // report on title
  'report_on_title_drafted',
  'report_on_title_approved',
  'report_on_title_rejected',
  'report_on_title_sent',
  // exchange
  'deposit_received',
  'exchange_conditions_met',
  'contracts_exchanged',
  // completion
  'completion_statement_generated',
  'funds_requested',
  'funds_received',
  'completion_confirmed',
  // post-completion
  'sdlt_submitted',
  'ap1_submitted',
  'ap1_confirmed',
  // comms / chasing / escalation
  'client_update_sent',
  'chase_sent',
  'escalation_raised',
  'escalation_resolved',
  // decision audit
  'decision_source_opened',
  // payment verification (addendum 2): bank details are versioned; every set/change is a hard-stop
  'bank_details_recorded',
  'bank_details_change_flagged',
  'bank_details_verified',
  'bank_details_verification_failed',
  'payment_authorised',
  // addendum 3: shadow mode + assist-level review of auto-clears
  'action_suppressed',
  'shadow_mode_changed',
  // eventualities (docs/engine-eventualities.md)
  'matter_abandoned',
  'target_dates_changed',
  'completion_date_changed',
  'notice_to_complete_served',
  'mortgage_offer_withdrawn',
  'enquiry_withdrawn',
  'hmlr_requisition_received',
  'hmlr_requisition_responded',
  'correction_recorded',
  'handler_changed',
  'auto_clear_review_raised',
  'auto_clear_confirmed',
  // issues (docs/engine-issues.md): things that go wrong and change what the matter needs
  'issue_raised',
  'issue_updated',
  'issue_resolved',
  'issue_withdrawn',
  'issue_fatal',
  'price_changed',
  'contract_approved',
  'signed_contract_held',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// ───────────────────────────── Actors ─────────────────────────────

/**
 * Who caused an event. Stored as text: the three well-known actors, or a user id.
 *   'system'   — deterministic automation (rules, timers, stage advancement)
 *   'ai'       — an AI-drafted artefact that needs a human (decision summaries, report drafts)
 *   'external' — something arrived from outside (a search provider webhook, a reply)
 *   <uuid>     — a human user of this firm (app_user.id)
 */
export type Actor = 'system' | 'ai' | 'external' | (string & {});
export const SYSTEM: Actor = 'system';
export const AI: Actor = 'ai';
export const EXTERNAL: Actor = 'external';
export const isUserActor = (a: Actor): boolean => a !== 'system' && a !== 'ai' && a !== 'external';

// ───────────────────────────── Sub-flow vocab ─────────────────────────────

export const SEARCH_TYPES = ['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL', 'CHANCEL'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
/** Ordered on entry to pre_contract for every freehold purchase unless the matter says otherwise. */
export const DEFAULT_REQUIRED_SEARCHES: SearchType[] = ['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL'];

export type Severity = 'info' | 'low' | 'medium' | 'high';

/** Where in the source document a fact/flag came from — surfaced verbatim to the handler. */
export interface SourceLocator {
  page?: number;
  section?: string;
  quote?: string;
}

/** A structured issue found by the extraction pipeline (#2). Rules, not the model, decide what it means. */
export interface Flag {
  code: string;
  severity: Severity;
  description: string;
  locator?: SourceLocator;
}

/** Output of the extraction pipeline (#2) for a search result. */
export interface SearchFacts {
  searchType: SearchType;
  flags: Flag[];
  /** 0–1 per-document extraction confidence. Low confidence is routed to a human, never guessed. */
  confidence: number;
  summaryFields?: Record<string, string | number | boolean | null>;
}

export interface MortgageCondition {
  code: string;
  text: string;
  /** Deterministically classified by the rule layer (rules.ts) — standard lender conditions auto-clear. */
  standard: boolean;
  locator?: SourceLocator;
}

export interface MortgageOfferFacts {
  lender: string;
  amountPennies?: number;
  expiryDate?: string; // ISO date
  conditions: MortgageCondition[];
  confidence: number;
}

export interface TitleEntry {
  code: string;
  text: string;
  /** Registers: A = property, B = proprietorship, C = charges. */
  register?: 'A' | 'B' | 'C';
  locator?: SourceLocator;
}

export interface TitleFacts {
  titleNumber: string;
  tenure: 'freehold' | 'leasehold' | 'unknown';
  restrictions: TitleEntry[];
  charges: TitleEntry[];
  covenants: TitleEntry[];
  confidence: number;
}

export interface EnquiryReplyFacts {
  enquiryId: string;
  status: 'answered' | 'partial' | 'refused' | 'unclear';
  issues: Flag[];
  confidence: number;
}

export interface IdCheckFacts {
  provider: string;
  outcome: 'clear' | 'refer' | 'fail';
  flags: Flag[];
  confidence: number;
}

// ───────────────────────────── Decisions (2.2 DecisionEvent) ─────────────────────────────

export const DECISION_KINDS = ['id_check', 'search', 'enquiry', 'mortgage', 'title', 'report_on_title', 'escalation', 'bank_details', 'auto_clear', 'requisition'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_OPTIONS = ['approve', 'refer_to_client', 'request_further', 'escalate', 'reject', 'verify', 'indemnity'] as const;
export type DecisionOption = (typeof DECISION_OPTIONS)[number];

export type DecisionStatus = 'pending' | 'actioned' | 'escalated';

export interface Citation {
  documentId: string;
  locator?: SourceLocator;
  label: string;
}

/**
 * The human-facing part of a flagged event. Lives INSIDE the event payload so the
 * log alone reconstructs every decision ever put to a handler (audit rule).
 */
export interface DecisionSpec {
  kind: DecisionKind;
  /** Plain-English, pre-digested. Always cites the source (see `citations`). */
  summary: string;
  /** Required — a decision without a source document is invalid (machine.ts rejects it). */
  sourceDocumentId: string;
  sourceLocator?: SourceLocator;
  citations: Citation[];
  options: DecisionOption[];
  /** Who produced the summary: the deterministic template or a model id. */
  summarisedBy: string;
}

export interface DecisionState extends DecisionSpec {
  eventId: string;
  seq: number;
  createdAt: string;
  status: DecisionStatus;
  /** Users who have opened the source document for this decision (the rubber-stamp guard). */
  openedBy: string[];
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: DecisionOption | null;
  resolutionEventId: string | null;
  note: string | null;
  /** What the decision is about (search type, enquiry id, draft id…). */
  subject: string | null;
  /** For escalations: the decision that was escalated (resolving the escalation resolves it too). */
  origin: { decisionEventId: string; kind: DecisionKind } | null;
}

/** Addendum 3 §3: how the handler engaged with the source before deciding (recorded on the resolving event). */
export interface Engagement {
  scrolledSource: boolean;
  dwellMs: number;
}

// ───────────────────────────── Waits / SLA (2.6) ─────────────────────────────

export const WAIT_KEYS = ['id_check', 'search', 'enquiry', 'funds', 'registration'] as const;
export type WaitKey = (typeof WAIT_KEYS)[number];

export interface WaitState {
  key: WaitKey;
  /** search type / enquiry id / '' */
  subject: string;
  openedAt: string;
  openedBySeq: number;
  closedAt: string | null;
  chasesSentAt: string[];
  escalations: Array<{ eventId: string; raisedAt: string; resolvedAt: string | null }>;
}

// ───────────────────────────── Payment verification (addendum 2) ─────────────────────────────

/** Who is being paid (or who pays us). The firm's own client account is a payee too: it is what the client is told to pay into. */
export const PAYEE_KINDS = ['seller_solicitor', 'firm_client_account', 'client', 'lender', 'estate_agent', 'other'] as const;
export type PayeeKind = (typeof PAYEE_KINDS)[number];

/** How the details reached us. Deliberately NOT a trust signal — every channel is treated the same. */
export const SOURCE_CHANNELS = ['email', 'portal', 'phone', 'letter', 'in_person', 'manual', 'provider'] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

/**
 * Accepted out-of-band verification methods. Anything else — including any form of
 * "they confirmed by replying" — is rejected by the machine, not merely discouraged.
 */
export const VERIFICATION_METHODS = ['phone_callback_known_number', 'lawyer_checker_match', 'in_person', 'video_call_known_contact'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
/** Named so the error message can say exactly why (these are the fraud pattern). */
export const REJECTED_VERIFICATION_METHODS = ['same_channel_reply', 'email_reply', 'portal_reply', 'caller_stated', 'urgent_instruction', 'none'] as const;

export interface BankDetails {
  sortCode: string; // 6 digits
  accountNumber: string; // 8 digits
  accountName: string;
  firmName: string | null;
}

export interface BankDetailsState {
  id: string;
  payeeKind: PayeeKind;
  /** Free-text who: firm name / contact — never a foreign key, so a spoofed contact cannot inherit trust. */
  payeeRef: string | null;
  details: BankDetails;
  sourceChannel: SourceChannel;
  sourceDocumentId: string;
  supersedesId: string | null;
  /** unverified → verified | failed; superseded when a newer record for the same payee arrives. */
  status: 'unverified' | 'verified' | 'failed' | 'superseded';
  recordedAt: string;
  recordedBy: Actor;
  decisionEventId: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationMethod: VerificationMethod | null;
  verificationRef: string | null;
}

export interface PaymentAuthorisation {
  eventId: string;
  payeeKind: PayeeKind;
  bankDetailsId: string;
  amountPennies: number | null;
  purpose: 'completion_monies' | 'deposit' | 'other';
  authorisedBy: string;
  at: string;
}

export const maskAccount = (d: BankDetails): string => `${d.sortCode.replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3')} ····${d.accountNumber.slice(-4)} (${d.accountName})`;

// ───────────────────────────── Payloads ─────────────────────────────

export interface ChaseSpec {
  waitKey: WaitKey;
  subject: string;
  recipientRole: 'seller_solicitor' | 'search_provider' | 'lender' | 'client' | 'id_provider' | 'hmlr';
  template: string;
  channel: 'email' | 'whatsapp' | 'portal' | 'mock';
  messageId?: string | null;
  /** Stamped by the machine on chases to the counterparty solicitor. */
  counterpartyType?: CounterpartyType | null;
}

export interface ClientUpdateSpec {
  template: string;
  channel: 'email' | 'whatsapp' | 'mock';
  messageId?: string | null;
  triggeredByEventId?: string | null;
}

/** Event-type → payload. Keeping this exhaustive is what makes the projection typed. */
export interface Payloads {
  matter_created: {
    transactionType: TransactionType;
    hasLender: boolean;
    requiredSearches: SearchType[];
    targetExchangeDate?: string | null;
    targetCompletionDate?: string | null;
    /** null = not yet known; the audit index (068) picks up whichever events carry it. */
    counterpartyType?: CounterpartyType | null;
    /** Addendum 3 §2: observe only. */
    shadowMode?: boolean;
  };
  stage_advanced: { from: Stage; to: Stage; reason: string };
  manual_handling_required: { reason: string; detail?: string };

  id_check_requested: { provider: string; reference?: string | null };
  id_check_cleared: { facts: IdCheckFacts; reasons: string[] };
  id_check_flagged: { facts: IdCheckFacts; flags: Flag[]; decision: DecisionSpec };
  id_check_reviewed: { decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null };

  search_ordered: { searchType: SearchType; provider: string; reference?: string | null; reissue?: boolean };
  search_returned: { searchType: SearchType; provider?: string | null };
  search_extracted: { searchType: SearchType; facts: SearchFacts; extractor: string };
  search_cleared: { searchType: SearchType; reasons: string[] };
  search_flagged: { searchType: SearchType; flags: Flag[]; decision: DecisionSpec };
  search_reviewed: { searchType: SearchType; decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null };

  enquiry_raised: { enquiryId: string; subject: string; origin?: { decisionEventId?: string; followUpOf?: string } | null; counterpartyType?: CounterpartyType | null };
  enquiry_reply_received: { enquiryId: string; facts?: EnquiryReplyFacts | null; counterpartyType?: CounterpartyType | null };
  enquiry_reply_cleared: { enquiryId: string; reasons: string[] };
  enquiry_reply_flagged: { enquiryId: string; flags: Flag[]; decision: DecisionSpec };
  enquiry_reply_reviewed: { enquiryId: string; decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null };

  mortgage_offer_received: { lender?: string | null };
  mortgage_offer_extracted: { facts: MortgageOfferFacts; extractor: string };
  mortgage_offer_cleared: { reasons: string[] };
  mortgage_condition_flagged: { flags: Flag[]; decision: DecisionSpec };
  mortgage_condition_reviewed: { decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null };

  title_extracted: { facts: TitleFacts; extractor: string };
  title_cleared: { reasons: string[] };
  title_flagged: { flags: Flag[]; decision: DecisionSpec };
  title_reviewed: { decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null };

  report_on_title_drafted: { draftId: string; draftDocumentId: string; model: string; decision: DecisionSpec; basedOn: string[] };
  report_on_title_approved: { draftId: string; decisionEventId: string; note?: string | null };
  report_on_title_rejected: { draftId: string; decisionEventId: string; note?: string | null };
  /** approvedBy is validated by the database (071): a human of this firm who wrote the cited approval event. */
  report_on_title_sent: { draftId: string; approvedEventId: string; approvedBy: string; channel: string; messageId?: string | null };

  deposit_received: { amountPennies?: number | null };
  exchange_conditions_met: { conditions: string[] };
  contracts_exchanged: { completionDate: string; exchangedAt?: string | null };

  completion_statement_generated: { documentId?: string | null };
  funds_requested: {
    fromRole: 'lender' | 'client';
    amountPennies?: number | null;
    /** The VERIFIED firm client-account record the payer is told to pay into (addendum 2 §5). */
    bankDetailsId: string;
    approvedBy: string;
  };
  funds_received: { fromRole: 'lender' | 'client'; amountPennies?: number | null };
  completion_confirmed: { completedAt?: string | null };

  sdlt_submitted: { reference?: string | null };
  ap1_submitted: { reference?: string | null };
  ap1_confirmed: { titleNumber?: string | null };

  client_update_sent: ClientUpdateSpec;
  chase_sent: ChaseSpec;
  escalation_raised: {
    /** null when a human escalated a decision rather than a timer firing on a wait. */
    waitKey: WaitKey | null;
    subject: string;
    reason: string;
    decision: DecisionSpec;
    /** The decision that was escalated (user escalations). Resolving the escalation resolves it too. */
    origin?: { decisionEventId: string; kind: DecisionKind } | null;
  };
  escalation_resolved: { escalationEventId: string; decisionEventId: string; option: DecisionOption; note?: string | null };

  decision_source_opened: { decisionEventId: string; documentId: string };

  bank_details_recorded: { bankDetailsId: string; payeeKind: PayeeKind; payeeRef: string | null; details: BankDetails; sourceChannel: SourceChannel; supersedesId: string | null; isChange: boolean };
  bank_details_change_flagged: { bankDetailsId: string; payeeKind: PayeeKind; isChange: boolean; previous: string | null; decision: DecisionSpec };
  bank_details_verified: { bankDetailsId: string; decisionEventId: string; verificationMethod: VerificationMethod; verificationRef: string | null; note?: string | null };
  bank_details_verification_failed: { bankDetailsId: string; decisionEventId: string; reason: string | null };
  payment_authorised: { payeeKind: PayeeKind; bankDetailsId: string; amountPennies: number | null; purpose: 'completion_monies' | 'deposit' | 'other'; approvedBy: string };

  /** The intent the engine would have acted on, logged instead of executed (shadow mode / shadowed sub-flow). */
  action_suppressed: { action: SuppressedAction; reason: 'shadow_mode' | 'subflow_shadow'; subFlow: SubFlow | null; detail: Record<string, unknown> };
  /** A person switched shadow mode on or off for this matter (the flag is part of the log, like everything else). */
  shadow_mode_changed: { shadowMode: boolean; reason?: string | null };
  // ── eventualities ──
  /** The transaction is over without completing: the matter is closed to further commands, timers stop. */
  matter_abandoned: { reason: AbandonReason; detail?: string | null; stage: Stage };
  /** Target exchange / completion dates re-planned (offers expire, chains move). */
  target_dates_changed: { targetExchangeDate: string | null; targetCompletionDate: string | null; reason?: string | null; previous: { targetExchangeDate: string | null; targetCompletionDate: string | null } };
  /** After exchange: the contractual completion date moved (by agreement, or a notice to complete). */
  completion_date_changed: { from: string; to: string; reason?: string | null };
  /** A notice to complete was served (by either side): a hard deadline the timers watch. */
  notice_to_complete_served: { servedBy: 'buyer' | 'seller'; servedAt: string; expiresAt: string; decision: DecisionSpec };
  /** The lender withdrew or the offer lapsed before exchange: the mortgage sub-flow reopens and exchange is blocked. */
  mortgage_offer_withdrawn: { reason: string; lender?: string | null };
  /** An enquiry the handler no longer needs answered (superseded, covered by indemnity, out of scope). */
  enquiry_withdrawn: { enquiryId: string; reason: string };
  /** HM Land Registry raised a requisition on the AP1: a decision citing the requisition letter. */
  hmlr_requisition_received: { reference?: string | null; deadline?: string | null; decision: DecisionSpec };
  hmlr_requisition_responded: { decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null };
  /** A person recorded that an earlier event was wrong. The log is never edited; this is the compensating record. */
  correction_recorded: { aboutEventId: string; reason: string };
  /** The responsible handler changed (reassignment, holiday cover, leaver). */
  handler_changed: { fromUserId: string | null; toUserId: string; reason?: string | null };
  /** assist level: an auto-clear put in front of a person for confirmation — never blocks the stage. */
  auto_clear_review_raised: { subFlow: SubFlow; subject: string; clearedEventType: EventType; reasons: string[]; decision: DecisionSpec };
  auto_clear_confirmed: { decisionEventId: string; subFlow: SubFlow; subject: string; option: DecisionOption; note?: string | null };
  // ── issues (docs/engine-issues.md) ──
  /** A person (or, for lender_approval, the machine) recorded that something is wrong and the matter has to wait for it. */
  issue_raised: { issueId: string; kind: IssueKind; title: string; detail: string | null; gate: IssueGate; stage: Stage; sourceDocumentId: string | null; origin?: { issueId: string; resolution: IssueResolution } | null };
  /** Progress on an open issue: negotiating, a note, a gate change (e.g. accepted to carry to completion). */
  issue_updated: { issueId: string; status: 'open' | 'negotiating'; note: string | null; gate?: IssueGate | null };
  /** Resolved with one of the kind's realistic outcomes. Side-effects (price change, lender approval) are separate events that follow it. */
  issue_resolved: { issueId: string; resolution: IssueResolution; note: string | null };
  /** Raised in error / overtaken / the client dropped it. */
  issue_withdrawn: { issueId: string; reason: string };
  /** The issue killed the transaction (the matter is abandoned in the same command). */
  issue_fatal: { issueId: string; reason: string };
  /** The agreed purchase price changed (renegotiation after a survey / down-valuation; recorded before exchange only). */
  price_changed: { fromPennies: number | null; toPennies: number; reason: string; issueId: string | null };
  /** The draft contract is approved as to form (readiness milestone; advisory, not a gate). */
  contract_approved: { note?: string | null };
  /** The client's signed contract is held on file (readiness milestone; advisory, not a gate). */
  signed_contract_held: { note?: string | null };
}

/** Event types whose payload carries a DecisionSpec (i.e. they create a DecisionEvent). */
export const DECISION_EVENT_TYPES: ReadonlyArray<EventType> = [
  'id_check_flagged',
  'search_flagged',
  'enquiry_reply_flagged',
  'mortgage_condition_flagged',
  'title_flagged',
  'report_on_title_drafted',
  'escalation_raised',
  'bank_details_change_flagged',
  'auto_clear_review_raised',
  'notice_to_complete_served',
  'hmlr_requisition_received',
];

// ───────────────────────────── Shadow mode / trust levels (addendum 3 §2) ─────────────────────────────

/** The engine's sub-flows, each promoted out of shadow independently. */
export const SUB_FLOWS = ['id_check', 'search', 'enquiry', 'mortgage', 'title', 'report_on_title', 'chase'] as const;
export type SubFlow = (typeof SUB_FLOWS)[number];

/**
 * shadow      — logged only: nothing surfaces to a person, nothing is sent/ordered.
 * assist      — decisions surface; auto-clears ALSO surface as a non-blocking review so
 *               their accuracy can be measured (the evidence for promotion).
 * autonomous  — the auto-clear branch runs unobserved. Decision events are never
 *               autonomous: anything flagged always goes to a person.
 */
export const SUBFLOW_STATUSES = ['shadow', 'assist', 'autonomous'] as const;
export type SubflowStatus = (typeof SUBFLOW_STATUSES)[number];
export type SubflowConfig = Record<SubFlow, SubflowStatus>;
export const DEFAULT_SUBFLOW_CONFIG: SubflowConfig = { id_check: 'assist', search: 'assist', enquiry: 'assist', mortgage: 'assist', title: 'assist', report_on_title: 'assist', chase: 'assist' };

/** Which sub-flow a decision kind belongs to (for hiding decisions of a shadowed sub-flow). */
export const SUBFLOW_OF_KIND: Record<DecisionKind, SubFlow | null> = { id_check: 'id_check', search: 'search', enquiry: 'enquiry', mortgage: 'mortgage', title: 'title', report_on_title: 'report_on_title', escalation: 'chase', bank_details: null, auto_clear: null, requisition: null };

export type SuppressedAction = 'search_order' | 'id_check_request' | 'client_update' | 'chase' | 'report_send' | 'linked_enquiry_delivery' | 'stage_mirror';

// ───────────────────────────── Events ─────────────────────────────

/** An event as it is proposed by the machine, before the store assigns id/seq/time. */
export type NewEvent<T extends EventType = EventType> = {
  [K in T]: {
    type: K;
    actor: Actor;
    payload: Payloads[K];
    sourceDocumentId?: string | null;
    confidenceScore?: number | null;
    causedByEventId?: string | null;
  };
}[T];

/** A persisted, immutable event (2.2 Event). */
export type EngineEvent<T extends EventType = EventType> = NewEvent<T> & {
  id: string;
  tenantId: string;
  matterId: string;
  /** 1-based, gap-free per matter. Ordering + optimistic concurrency. */
  seq: number;
  createdAt: string;
  /** Hash chain (component #7): sha256(prevHash + canonical(event)). '' prevHash for the first event. */
  prevHash?: string;
  hash?: string;
};

// ───────────────────────────── Projected state ─────────────────────────────

export type ReviewStatus = 'cleared' | 'flagged' | 'reviewed';
/** cleared (auto), reviewed (human) and withdrawn (enquiries) all count as resolved for stage gating. */
export const isResolved = (s: string | undefined): boolean => s === 'cleared' || s === 'reviewed' || s === 'withdrawn';

export const ABANDON_REASONS = ['client_withdrew', 'seller_withdrew', 'chain_collapsed', 'gazumped', 'survey', 'finance_failed', 'conflict', 'other'] as const;
export type AbandonReason = (typeof ABANDON_REASONS)[number];

export interface SearchState {
  searchType: SearchType;
  /** 1 for the first order; a re-issued / re-ordered search (lender freshness rule, provider error) starts a new cycle. */
  cycle: number;
  status: 'ordered' | 'returned' | 'extracted' | ReviewStatus;
  orderedAt: string | null;
  returnedAt: string | null;
  documentId: string | null;
  facts: SearchFacts | null;
  flags: Flag[];
  decisionEventId: string | null;
  resolution: DecisionOption | null;
}

export interface EnquiryState {
  enquiryId: string;
  subject: string;
  status: 'raised' | 'replied' | 'withdrawn' | ReviewStatus;
  raisedAt: string;
  repliedAt: string | null;
  documentId: string | null;
  decisionEventId: string | null;
  resolution: DecisionOption | null;
}

export interface IssueState {
  id: string;
  kind: IssueKind;
  title: string;
  detail: string | null;
  gate: IssueGate;
  status: IssueStatus;
  raisedAt: string;
  raisedBy: Actor;
  raisedAtStage: Stage;
  /** Last time anyone touched it (the stale-issue timer watches this). */
  updatedAt: string;
  sourceDocumentId: string | null;
  resolution: IssueResolution | null;
  resolvedAt: string | null;
  resolvedBy: Actor | null;
  /** The issue this one was raised from (e.g. lender_approval raised off a price_reduced resolution). */
  origin: { issueId: string; resolution: IssueResolution } | null;
  history: Array<{ at: string; by: Actor; what: string }>;
}

export interface MatterState {
  tenantId: string;
  matterId: string;
  enrolled: boolean;
  transactionType: TransactionType | null;
  hasLender: boolean;
  requiredSearches: SearchType[];
  shadowMode: boolean;
  counterpartyType: CounterpartyType | null;
  targetExchangeDate: string | null;
  targetCompletionDate: string | null;
  stage: Stage;
  stageHistory: Array<{ stage: Stage; at: string; seq: number }>;
  lastSeq: number;
  lastEventAt: string | null;
  manualHandling: { required: boolean; reason: string | null };

  idCheck: {
    status: 'not_started' | 'requested' | ReviewStatus;
    requestedAt: string | null;
    documentId: string | null;
    decisionEventId: string | null;
  };
  searches: Record<string, SearchState>;
  enquiries: Record<string, EnquiryState>;
  mortgage: {
    status: 'not_required' | 'awaiting' | 'received' | 'extracted' | ReviewStatus;
    documentId: string | null;
    facts: MortgageOfferFacts | null;
    decisionEventId: string | null;
  };
  title: {
    status: 'awaiting' | 'extracted' | ReviewStatus;
    documentId: string | null;
    facts: TitleFacts | null;
    decisionEventId: string | null;
  };
  reportOnTitle: {
    status: 'not_started' | 'drafted' | 'approved' | 'rejected' | 'sent';
    draftId: string | null;
    draftEventId: string | null;
    draftDocumentId: string | null;
    approvedEventId: string | null;
    approvedBy: string | null;
    sentAt: string | null;
  };
  deposit: { received: boolean; at: string | null };
  exchange: { conditionsMet: boolean; exchangedAt: string | null; completionDate: string | null };
  completion: {
    statementGeneratedAt: string | null;
    fundsRequestedAt: string | null;
    fundsReceivedAt: string | null;
    confirmedAt: string | null;
  };
  postCompletion: { sdltSubmittedAt: string | null; ap1SubmittedAt: string | null; ap1ConfirmedAt: string | null; requisitions: Array<{ eventId: string; receivedAt: string; respondedAt: string | null; deadline: string | null }> };
  /** Set once the transaction is over without completing. Nothing else moves after this. */
  abandoned: { at: string; reason: AbandonReason; detail: string | null; stage: Stage } | null;
  /** A served notice to complete (either side): the deadline the timers watch. */
  noticeToComplete: { servedBy: 'buyer' | 'seller'; servedAt: string; expiresAt: string; eventId: string } | null;
  /** The responsible handler as the log knows it (the matter row / LEAP is the live source; this is the audit trail). */
  handler: string | null;
  corrections: number;
  /** Issues (docs/engine-issues.md): typed things that went wrong, with lifecycle and gate effect. */
  issues: Record<string, IssueState>;
  /** The agreed purchase price as the log knows it (null = never recorded). */
  purchasePricePennies: number | null;
  /** Readiness milestones (advisory; shown as "ready to exchange?" not enforced as gates). */
  readiness: { contractApprovedAt: string | null; signedContractHeldAt: string | null };

  decisions: Record<string, DecisionState>;
  waits: WaitState[];
  clientUpdatesSent: number;
  chasesSent: number;
  /** Addendum 2: every bank-details record ever put on file for this matter (versioned, never overwritten). */
  bankDetails: Record<string, BankDetailsState>;
  payments: PaymentAuthorisation[];
  /** Intents logged instead of executed (shadow). */
  suppressed: number;
}

export function initialState(tenantId: string, matterId: string): MatterState {
  return {
    tenantId,
    matterId,
    enrolled: false,
    transactionType: null,
    hasLender: false,
    requiredSearches: [],
    shadowMode: false,
    counterpartyType: null,
    targetExchangeDate: null,
    targetCompletionDate: null,
    stage: 'instruction',
    stageHistory: [],
    lastSeq: 0,
    lastEventAt: null,
    manualHandling: { required: false, reason: null },
    idCheck: { status: 'not_started', requestedAt: null, documentId: null, decisionEventId: null },
    searches: {},
    enquiries: {},
    mortgage: { status: 'not_required', documentId: null, facts: null, decisionEventId: null },
    title: { status: 'awaiting', documentId: null, facts: null, decisionEventId: null },
    reportOnTitle: {
      status: 'not_started',
      draftId: null,
      draftEventId: null,
      draftDocumentId: null,
      approvedEventId: null,
      approvedBy: null,
      sentAt: null,
    },
    deposit: { received: false, at: null },
    exchange: { conditionsMet: false, exchangedAt: null, completionDate: null },
    completion: { statementGeneratedAt: null, fundsRequestedAt: null, fundsReceivedAt: null, confirmedAt: null },
    postCompletion: { sdltSubmittedAt: null, ap1SubmittedAt: null, ap1ConfirmedAt: null, requisitions: [] },
    abandoned: null,
    noticeToComplete: null,
    handler: null,
    corrections: 0,
    issues: {},
    purchasePricePennies: null,
    readiness: { contractApprovedAt: null, signedContractHeldAt: null },
    decisions: {},
    waits: [],
    clientUpdatesSent: 0,
    chasesSent: 0,
    bankDetails: {},
    payments: [],
    suppressed: 0,
  };
}

/**
 * A persisted read-model snapshot may pre-date a field added to MatterState (it is rebuilt
 * from the log on the next event, not on deploy). Fill the gaps from the initial state so
 * readers never meet an undefined top-level field.
 */
export function withStateDefaults(s: MatterState): MatterState {
  return { ...initialState(s.tenantId, s.matterId), ...s };
}

/** Nothing more will happen on this matter: registered, or abandoned. */
export const isFinished = (s: MatterState): boolean => !!s.postCompletion.ap1ConfirmedAt || !!s.abandoned;

/** The record a payment may use: the newest for the payee, and only if verified. */
export function currentBankDetails(state: MatterState, payeeKind: PayeeKind): BankDetailsState | null {
  const all = Object.values(state.bankDetails).filter((b) => b.payeeKind === payeeKind).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || (b.id > a.id ? 1 : -1));
  return all[0] ?? null;
}

/** A bank-details decision still open for this payee = a hard-stop on any payment to/for them. */
export function pendingBankDetailsDecision(state: MatterState, payeeKind: PayeeKind): DecisionState | null {
  return Object.values(state.decisions).find((d) => d.kind === 'bank_details' && d.status === 'pending' && state.bankDetails[d.subject ?? '']?.payeeKind === payeeKind) ?? null;
}

/** Pending decisions, oldest first — the dashboard feed. */
export function pendingDecisions(state: MatterState): DecisionState[] {
  return Object.values(state.decisions)
    .filter((d) => d.status === 'pending')
    .sort((a, b) => a.seq - b.seq);
}

/**
 * What a person may be shown (addendum 3 §2): nothing from a shadow-mode matter, nothing
 * from a sub-flow still in shadow. Everything is still in the log.
 */
/** Pending decisions that gate progress — assist-level auto-clear reviews are advisory and excluded. */
export function blockingDecisions(state: MatterState): DecisionState[] {
  return pendingDecisions(state).filter((d) => d.kind !== 'auto_clear');
}
export function surfacedDecisions(state: MatterState, cfg: SubflowConfig): DecisionState[] {
  if (state.shadowMode) return [];
  return pendingDecisions(state).filter((d) => {
    const sf = SUBFLOW_OF_KIND[d.kind];
    return !sf || cfg[sf] !== 'shadow';
  });
}

/** Issues still holding the matter (open or negotiating), oldest first. */
export function openIssues(state: MatterState): IssueState[] {
  return Object.values(state.issues)
    .filter((i) => i.status === 'open' || i.status === 'negotiating')
    .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || (a.id > b.id ? 1 : -1));
}
/** Open issues whose gate holds the given stage exit. */
export function issuesGating(state: MatterState, gate: IssueGate): IssueState[] {
  return openIssues(state).filter((i) => i.gate === gate);
}

export function openWaits(state: MatterState): WaitState[] {
  return state.waits.filter((w) => w.closedAt === null);
}

/** Thrown by the machine when a command is not valid in the current state. */
export class EngineError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
  }
}
