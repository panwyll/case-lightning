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

export const DECISION_KINDS = ['id_check', 'search', 'enquiry', 'mortgage', 'title', 'report_on_title', 'escalation'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_OPTIONS = ['approve', 'refer_to_client', 'request_further', 'escalate', 'reject'] as const;
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
  };
  stage_advanced: { from: Stage; to: Stage; reason: string };
  manual_handling_required: { reason: string; detail?: string };

  id_check_requested: { provider: string; reference?: string | null };
  id_check_cleared: { facts: IdCheckFacts; reasons: string[] };
  id_check_flagged: { facts: IdCheckFacts; flags: Flag[]; decision: DecisionSpec };
  id_check_reviewed: { decisionEventId: string; option: DecisionOption; note?: string | null };

  search_ordered: { searchType: SearchType; provider: string; reference?: string | null };
  search_returned: { searchType: SearchType; provider?: string | null };
  search_extracted: { searchType: SearchType; facts: SearchFacts; extractor: string };
  search_cleared: { searchType: SearchType; reasons: string[] };
  search_flagged: { searchType: SearchType; flags: Flag[]; decision: DecisionSpec };
  search_reviewed: { searchType: SearchType; decisionEventId: string; option: DecisionOption; note?: string | null };

  enquiry_raised: { enquiryId: string; subject: string; origin?: { decisionEventId?: string; followUpOf?: string } | null; counterpartyType?: CounterpartyType | null };
  enquiry_reply_received: { enquiryId: string; facts?: EnquiryReplyFacts | null; counterpartyType?: CounterpartyType | null };
  enquiry_reply_cleared: { enquiryId: string; reasons: string[] };
  enquiry_reply_flagged: { enquiryId: string; flags: Flag[]; decision: DecisionSpec };
  enquiry_reply_reviewed: { enquiryId: string; decisionEventId: string; option: DecisionOption; note?: string | null };

  mortgage_offer_received: { lender?: string | null };
  mortgage_offer_extracted: { facts: MortgageOfferFacts; extractor: string };
  mortgage_offer_cleared: { reasons: string[] };
  mortgage_condition_flagged: { flags: Flag[]; decision: DecisionSpec };
  mortgage_condition_reviewed: { decisionEventId: string; option: DecisionOption; note?: string | null };

  title_extracted: { facts: TitleFacts; extractor: string };
  title_cleared: { reasons: string[] };
  title_flagged: { flags: Flag[]; decision: DecisionSpec };
  title_reviewed: { decisionEventId: string; option: DecisionOption; note?: string | null };

  report_on_title_drafted: { draftId: string; draftDocumentId: string; model: string; decision: DecisionSpec; basedOn: string[] };
  report_on_title_approved: { draftId: string; decisionEventId: string; note?: string | null };
  report_on_title_rejected: { draftId: string; decisionEventId: string; note?: string | null };
  report_on_title_sent: { draftId: string; approvedEventId: string; channel: string; messageId?: string | null };

  deposit_received: { amountPennies?: number | null };
  exchange_conditions_met: { conditions: string[] };
  contracts_exchanged: { completionDate: string; exchangedAt?: string | null };

  completion_statement_generated: { documentId?: string | null };
  funds_requested: { fromRole: 'lender' | 'client'; amountPennies?: number | null };
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
];

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
/** cleared (auto) and reviewed (human) both count as resolved for stage gating. */
export const isResolved = (s: string | undefined): boolean => s === 'cleared' || s === 'reviewed';

export interface SearchState {
  searchType: SearchType;
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
  status: 'raised' | 'replied' | ReviewStatus;
  raisedAt: string;
  repliedAt: string | null;
  documentId: string | null;
  decisionEventId: string | null;
  resolution: DecisionOption | null;
}

export interface MatterState {
  tenantId: string;
  matterId: string;
  enrolled: boolean;
  transactionType: TransactionType | null;
  hasLender: boolean;
  requiredSearches: SearchType[];
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
  postCompletion: { sdltSubmittedAt: string | null; ap1SubmittedAt: string | null; ap1ConfirmedAt: string | null };

  decisions: Record<string, DecisionState>;
  waits: WaitState[];
  clientUpdatesSent: number;
  chasesSent: number;
}

export function initialState(tenantId: string, matterId: string): MatterState {
  return {
    tenantId,
    matterId,
    enrolled: false,
    transactionType: null,
    hasLender: false,
    requiredSearches: [],
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
    postCompletion: { sdltSubmittedAt: null, ap1SubmittedAt: null, ap1ConfirmedAt: null },
    decisions: {},
    waits: [],
    clientUpdatesSent: 0,
    chasesSent: 0,
  };
}

/** Pending decisions, oldest first — the dashboard feed. */
export function pendingDecisions(state: MatterState): DecisionState[] {
  return Object.values(state.decisions)
    .filter((d) => d.status === 'pending')
    .sort((a, b) => a.seq - b.seq);
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
