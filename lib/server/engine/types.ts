/**
 * CONVEYi conveyancing engine — the vocabulary.
 *
 * This is the domain model for the state machine that RUNS a residential freehold
 * purchase (buyer-side). Everything else in lib/server/engine
imports from here, so
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

import type { CaseShape } from './shapes';
import type { IssueGate, IssueKind, IssueResolution, IssueSeverity, IssueStatus } from './issues';
import type { PofQuery, PofRiskRating, ProofOfFundsFacts, StatementTransaction, TransactionReview } from './proof-of-funds';

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

export const TRANSACTION_TYPES = ['freehold_purchase', 'leasehold_purchase', 'freehold_sale', 'leasehold_sale', 'remortgage', 'transfer_of_equity'] as const;
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
  'id_party_added',
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
  'lease_extracted',
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
  'acknowledgement_sent',
  // notes and call transcripts (docs/intake.md)
  'note_recorded',
  'note_extracted',
  'note_actions_applied',
  'wait_progress_reported',
  'file_delivery_set',
  'chain_consent_recorded',
  'note_action_refused',
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
  // addendum 3 (historical): shadow mode. Kept so old logs replay; nothing emits them now.
  'action_suppressed',
  'shadow_mode_changed',
  // trust levels: at PROPOSE the engine asks before it acts; the answer is an event too
  'action_proposed',
  'action_approved',
  'action_rejected',
  'action_failed',
  'action_retried',
  'auto_clear_proposed',
  // eventualities (docs/engine-eventualities.md)
  'matter_abandoned',
  'target_dates_changed',
  'clients_updated',
  'contract_filed',
  'contract_review_raised',
  'contract_reviewed',
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
  // proof of funds (docs/proof-of-funds.md): form sent → client submitted → conveyancer signed off
  'proof_of_funds_requested',
  'proof_of_funds_submitted',
  'proof_of_funds_reviewed',
  'proof_of_funds_query_raised',
  'proof_of_funds_query_withdrawn',
  'proof_of_funds_query_answered',
  // leasehold: the management pack (LPE1) sub-flow and the post-completion notice
  'management_pack_requested',
  'management_pack_received',
  'management_pack_reviewed',
  'notice_of_assignment_served',
  // case model (docs/case-model.md): survey workstream, client decisions, closure, issue severity
  'survey_received',
  'specialist_report_received',
  'client_decision_recorded',
  'client_decision_lapsed',
  // money reconciled (docs/eventualities/money.md §8–10): cleared funds and the refunds owed
  'funds_cleared',
  'refund_due',
  'refund_paid',
  // charges and undertakings (docs/eventualities/completion.md §4): every charge on a sale, our undertaking, the seller's TA13
  'charge_found',
  'charge_statement_received',
  'charge_redeemed',
  'charge_discharged',
  'undertaking_given',
  'undertaking_discharged',
  'completion_information_received',
  'longstop_date_recorded',
  'sdlt_facts_recorded',
  'party_event_recorded',
  'contributions_recorded',
  'completion_payment_sent',
  'final_bill_delivered',
  'formula_c_release_given',
  'formula_c_release_lapsed',
  'property_event_recorded',
  'retention_released',
  'redemption_figure_adjusted',
  'ap1_cancelled',
  'requisition_extended',
  'register_checked',
  'seller_discharge_received',
  'sar_made',
  'daml_response_recorded',
  'cgt_facts_recorded',
  'issue_severity_changed',
  'matter_closed',
  // transaction types (docs/transaction-types.md): sale, remortgage, transfer of equity, co-ownership
  'property_forms_requested',
  'property_forms_received',
  'seller_forms_received',
  'related_matter_linked',
  'related_matter_unlinked',
  'step_completed_manually',
  'manual_step_undone',
  'step_reopened',
  'lender_requirements_recorded',
  'name_change_evidenced',
  'client_account_receipt_recorded',
  'contract_pack_sent',
  'contract_pack_requested',
  'signed_transfer_requested',
  'buyer_enquiries_received',
  'enquiry_replies_sent',
  'redemption_statement_requested',
  'redemption_statement_received',
  'mortgage_redeemed',
  'discharge_confirmed',
  'mortgage_deed_executed',
  'certificate_of_title_sent',
  'buildings_insurance_confirmed',
  'priority_search_made',
  'bankruptcy_search_clear',
  'lender_consent_requested',
  'lender_consent_received',
  'transfer_deed_executed',
  'deed_of_trust_executed',
  'sdlt_not_required',
  'availability_recorded',
  'expectation_opened',
  'title_plan_read',
  'supporting_document_read',
  'manual_handling_cleared',
  'funding_changed',
  'survey_plan_recorded',
  'signing_method_set',
  'signing_pack_sent',
  'signing_envelope_sent',
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

export const SEARCH_TYPES = ['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL', 'CHANCEL', 'MINING', 'FLOOD', 'HIGHWAYS', 'PLANNING'] as const;
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
  /** The date the search was made, as printed on the result (its age runs from here, not from when it reached us). */
  searchDate?: string | null;
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

/** Extracted from the lease / register for a leasehold title (component #2). */
export interface LeaseFacts {
  /** Years left on the term at the date of extraction. */
  unexpiredYears?: number | null;
  groundRentPenniesPa?: number | null;
  /** The review clause as written (the rule layer looks for doubling / RPI wording). */
  groundRentReview?: string | null;
  leaseDate?: string | null;
  landlord?: string | null;
  locator?: SourceLocator;
  // ── the lease read in full (Document Review Engine: the lease review table) ──
  termYears?: number | null;
  termStartDate?: string | null;
  /** The demised premises as described, e.g. "Flat 3, second floor, with the balcony and bin store". */
  demise?: string | null;
  managementCompany?: string | null;
  /** Service charge proportion as written, e.g. "12.5%" or "a fair proportion". */
  serviceChargeProportion?: string | null;
  /** Who repairs what: structure, roof, windows, interior; verbatim where possible. */
  repairs?: string | null;
  /** Assignment and subletting: consent needed, absolute or qualified. */
  alienation?: string | null;
  alterations?: string | null;
  permittedUse?: string | null;
  /** Who insures and who pays. */
  insurance?: string | null;
  /** Notice of assignment / charge, deed of covenant and registration fees the lease requires. */
  landlordNotices?: string | null;
  forfeiture?: string | null;
  /** Every clause relied on, verbatim with its page, for the review table. */
  clauses?: LeaseClause[];
  flags?: Flag[];
  confidence?: number;
}
export interface LeaseClause { code: string; topic: 'term' | 'rent' | 'service_charge' | 'repairs' | 'alienation' | 'alterations' | 'use' | 'insurance' | 'notices' | 'forfeiture' | 'other'; text: string; locator?: SourceLocator }

/** One person's ID / AML check beyond the first client's: who they are to the matter and where the check stands. */
export interface IdPartyCheck {
  party: string;
  label: string;
  /** buyer / seller / owner = a co-client; donor = a contributor of funds; attorney = a person acting for a client (LSAG 6.14.9); director = a director or PSC of a company client (LSAG 6.14.11); executor = a personal representative or trustee (LSAG 6.14.16). */
  role: 'buyer' | 'seller' | 'owner' | 'donor' | 'attorney' | 'director' | 'executor';
  status: 'not_started' | 'requested' | ReviewStatus;
  requestedAt: string | null;
  documentId: string | null;
  decisionEventId: string | null;
  /** Their own link to the check, when the provider gave one. */
  link?: string | null;
}
/** The party id for a named person: stable, readable, safe as a wait subject. */
export const partyId = (role: IdPartyCheck['role'], name: string): string => `${role}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

export interface TitleFacts {
  titleNumber: string;
  tenure: 'freehold' | 'leasehold' | 'unknown';
  restrictions: TitleEntry[];
  charges: TitleEntry[];
  covenants: TitleEntry[];
  /** Present on leasehold titles once extracted. */
  lease?: LeaseFacts | null;
  /** The document is an epitome / deeds bundle, not an official copy: unregistered land, first registration on completion. */
  unregistered?: boolean | null;
  /** The document was a title plan (a map), not the register: nothing here is a reading of the register. */
  planOnly?: boolean | null;
  /** Notices in the charges register: agreed or unilateral notices, home rights, leases noted. */
  notices?: TitleEntry[];
  /** The registered proprietors as named, their addresses for service, and when they were registered. */
  proprietors?: string[];
  proprietorAddresses?: string[];
  proprietorSince?: string | null;
  pricePaidPennies?: number | null;
  /** Absolute, possessory, qualified or good leasehold. */
  titleClass?: 'absolute' | 'possessory' | 'qualified' | 'good_leasehold' | 'unknown';
  propertyDescription?: string | null;
  editionDate?: string | null;
  confidence: number;
}

/** A title plan: the map, not the register. What it shows a buyer's conveyancer needs to check against the register and the property. */
export interface TitlePlanFacts {
  titleNumber: string;
  /** What the red edging encloses, as drawn. */
  edgedRed: string;
  /** Every other colour, hatching or numbered marking, and what the plan or the register says it marks. */
  otherMarkings: Array<{ marking: string; marks: string }>;
  notes: string[];
  /** The plan's date, scale or OS reference, as printed. */
  reference: string;
  confidence: number;
}

/** A document the seller supplies to back up the forms: an indemnity policy, a planning permission, a certificate, a guarantee. */
export const SUPPORTING_KINDS = ['indemnity_policy', 'planning_permission', 'building_regs', 'guarantee', 'certificate', 'other'] as const;
export type SupportingKind = (typeof SUPPORTING_KINDS)[number];
export interface SupportingDocFacts {
  kind: SupportingKind;
  /** What it is, as titled ("Lack of building regulations indemnity", "Decision notice 19/01234/HH"). */
  title: string;
  /** What it covers or approves: the risk insured, the works permitted or certified. */
  covers: string;
  /** Insurer, council, installer or guarantor. */
  issuedBy: string;
  reference: string;
  /** ISO dates, or empty. */
  date: string;
  expires: string;
  /** Indemnity policies: the limit, in pennies (null when not stated). */
  limitPennies: number | null;
  /** Indemnity policies: does the cover pass to the buyer, their successors and their lender? null when not stated. */
  benefitPasses: boolean | null;
  /** The property it names, as printed. */
  property: string;
  notes: string[];
  confidence: number;
}

/** The LPE1 / management pack, as far as the pipeline reads it. Everything is checked by a person. */
export interface ManagementPackFacts {
  serviceChargePenniesPa?: number | null;
  groundRentPenniesPa?: number | null;
  arrearsPennies?: number | null;
  majorWorksPlanned?: boolean | null;
  buildingsInsuranceInPlace?: boolean | null;
  reserveFundPennies?: number | null;
  flags: Flag[];
  confidence: number;
  // ── the LPE1 read in full (Document Review Engine: the management pack review table) ──
  landlord?: string | null;
  managingAgent?: string | null;
  /** The service charge year the figure is for, e.g. "1 April 2026 to 31 March 2027". */
  serviceChargePeriod?: string | null;
  /** The buyer's proportion as the pack states it. */
  serviceChargeProportion?: string | null;
  /** Planned or consulted-on major works: what, when, the cost and who pays. */
  majorWorks?: string | null;
  /** Section 20 consultation started or in progress. */
  section20Notice?: boolean | null;
  insurer?: string | null;
  insuredSumPennies?: number | null;
  insuranceExpiryDate?: string | null;
  /** Fees the landlord or agent charges the buyer, in pennies; null when the pack does not state them. */
  fees?: { noticeOfAssignmentPennies?: number | null; noticeOfChargePennies?: number | null; deedOfCovenantPennies?: number | null; certificateOfCompliancePennies?: number | null; other?: string | null } | null;
  /** Consents the landlord requires on sale (licence to assign, deed of covenant, share transfer). */
  consentsRequired?: string | null;
  /** Disputes, litigation, breaches or forfeiture the pack discloses. */
  disputes?: string | null;
  /** Building Safety Act 2022 (LPE1 5th edition): a relevant building (over 11 m / 5 storeys), the leaseholder deed of certificate, the landlord's certificate, any EWS1 / remediation position. */
  buildingSafety?: { relevantBuilding?: boolean | null; leaseholderDeedOfCertificate?: boolean | null; landlordCertificate?: boolean | null; remediation?: string | null } | null;
  /** Which years' accounts and budget the pack includes. */
  accountsProvided?: string | null;
  /** Every answer relied on, verbatim with its page, for the review table. */
  entries?: Array<{ code: string; text: string; locator?: SourceLocator }>;
}

export interface EnquiryReplyFacts {
  enquiryId: string;
  status: 'answered' | 'partial' | 'refused' | 'unclear';
  issues: Flag[];
  confidence: number;
}

/** A survey or specialist report as the pipeline reads it (component #2): facts, never the client's view. */
export interface SurveyRecommendation {
  code: string;
  text: string;
  /** The surveyor / specialist recommends a further specialist investigation before exchange. */
  furtherInvestigation: boolean;
  specialist?: string | null;
  severity: Severity;
  /** RICS condition rating of the element: 3 serious/urgent (quotes before commitment), 2 repair not urgent, 1 fine. */
  rating?: 1 | 2 | 3 | null;
  locator?: SourceLocator;
}
/** One point from the report's "Issues for your legal advisers": the part of a survey that is the conveyancer's. */
export interface SurveyLegalIssue { category: 'regulation' | 'guarantee' | 'other'; text: string; locator?: SourceLocator }
export const SURVEY_TYPES = ['level1', 'level2', 'level3', 'valuation', 'specialist'] as const;
export type SurveyType = (typeof SURVEY_TYPES)[number];
export interface SurveyFacts {
  surveyType: SurveyType;
  surveyor?: string | null;
  summary?: string | null;
  recommendations: SurveyRecommendation[];
  /** "Issues for your legal advisers": planning / building regulations, guarantees, rights, boundaries. Absent on a report read before this was asked. */
  legalIssues?: SurveyLegalIssue[];
  /** "Risks" (to the building, the grounds, people). */
  risks?: string[];
  marketValuePennies?: number | null;
  /** Reinstatement cost: the figure for buildings insurance. */
  reinstatementCostPennies?: number | null;
  confidence: number;
}

/** What a client, and only a client, decides (docs/case-model.md §7–§8). */
export const CLIENT_DECISION_SUBJECTS = ['physical_condition', 'further_investigation', 'exchange_authority', 'accept_risk', 'accept_terms', 'completion_date', 'ownership_basis'] as const;
export type ClientDecisionSubject = (typeof CLIENT_DECISION_SUBJECTS)[number];
export const CLIENT_DECISION_OUTCOMES: Record<ClientDecisionSubject, string[]> = {
  physical_condition: ['satisfied', 'renegotiate', 'further_investigation', 'withdraw'],
  /** The surveyor recommended a specialist: the client pursues it (we seek access from the seller), asks first for the seller's evidence (reports, certificates, guarantees that may answer it), or waives it (accepts the risk, advised in writing). */
  further_investigation: ['pursue', 'evidence', 'waive'],
  exchange_authority: ['authorised', 'not_yet', 'withdrawn'],
  accept_risk: ['accepted', 'declined'],
  accept_terms: ['accepted', 'declined'],
  completion_date: ['agreed', 'declined'],
  /** Joint owners decide how they hold: joint tenants, or tenants in common (equal / unequal shares → a declaration of trust). */
  ownership_basis: ['joint_tenants', 'tenants_in_common_equal', 'tenants_in_common_unequal'],
};
export const TENANTS_IN_COMMON = new Set(['tenants_in_common_equal', 'tenants_in_common_unequal']);

// ───────────────────────────── Notes and transcripts (docs/intake.md) ──────────────────

/** Where the words came from. A call transcript and a typed note run the same pipeline. */
export const NOTE_KINDS = ['typed', 'dictated', 'call', 'meeting', 'email'] as const;

/**
 * Who an email came from, as far as the case knows (its contacts). It decides what the
 * words may propose: only the client can make a client decision; anyone may report a
 * problem; nobody's say-so can clear ID, AML, source of funds or a search (notes.ts).
 */
export const SENDER_RELATIONS = ['client', 'agent', 'other_side', 'lender', 'colleague', 'unknown'] as const;
export type SenderRelation = (typeof SENDER_RELATIONS)[number];
export interface NoteSender { address: string; name: string | null; relation: SenderRelation }
export type NoteKind = (typeof NOTE_KINDS)[number];

/** What an extractor may propose from a note. Anything else is information only. */
/** question: answered in the reply; progress: something the writer says is done or on its way; resend: they need a form or link again. */
export const NOTE_ACTION_KINDS = ['client_decision', 'confirm_with_client', 'issue', 'expectation', 'question', 'progress', 'resend', 'information'] as const;
export type NoteActionKind = (typeof NOTE_ACTION_KINDS)[number];

/** The command a proposal would run. Deliberately a small, safe set — see notes.ts. */
export type NoteCommand =
  /** The client asks for a copy of a document ("I can't find my TA10"): found on the case and sent back to them. */
  | { type: 'send_file_copy'; what: string }
  | { type: 'set_file_delivery'; mode: 'attachments' | 'link' }
  | { type: 'record_chain_consent'; given: boolean }
  | { type: 'client_decision_recorded'; subject: ClientDecisionSubject; decision: string; note: string; /** further_investigation: which specialists, by name ("damp", "structural engineer"); absent = all. */ scope?: string[] | null }
  /** Someone other than the client reported a client decision: ask the client; it is recorded only when they say so themselves. */
  | { type: 'confirm_with_client'; subject: ClientDecisionSubject; decision: string; saidBy: string; quote: string; detail?: string | null }
  /** Dates mentioned for exchange or completion: the case's targets, which a person sets (contractual dates after exchange are not touched by a note). */
  | { type: 'set_target_dates'; targetExchangeDate: string | null; targetCompletionDate: string | null; reason: string }
  /** The price was renegotiated: to a figure, or by a reduction from the price on file. */
  | { type: 'record_price_change'; toPennies: number | null; reductionPennies: number | null; reason: string }
  /** An open issue of a kind a person may close on someone's word (the chain is ready, the delay is over). */
  | { type: 'resolve_issue'; kind: IssueKind; resolution: IssueResolution; note: string }
  /** The client asked us to get something from the seller's side (evidence, access, a document): the enquiry, drafted. */
  | { type: 'request_from_seller'; text: string; about: string }
  /** The client's survey plan: not having one (their choice), or booked for a date. */
  | { type: 'record_survey_plan'; plan: 'none' | 'booked'; date: string | null; note: string }
  /** Someone is away between two dates. */
  | { type: 'record_availability'; party: AvailabilityParty; from: string; until: string; note: string }
  /** The writer says something we are waiting on them for is done or on its way ("I've posted the signed contract"): noted on that wait, which pauses its chase until `expectBy`. Never clears anything: the thing itself still has to arrive. */
  | { type: 'record_client_progress'; waitKey: WaitKey; subject: string; claim: string; expectBy: string | null }
  /** They need a form or a link again ("can you resend the ID link"): the request for that wait goes again, with its links. */
  | { type: 'resend_to_client'; waitKey: WaitKey; subject: string }
  /** The offer is gone (the client or lender says so): the mortgage step reopens and holds exchange until a new offer is in. */
  | { type: 'record_mortgage_withdrawn'; reason: string }
  | { type: 'raise_issue'; kind: IssueKind; title: string; detail: string | null; gate: IssueGate; /** Overrides the kind's usual severity (a withdrawn offer is High, not the usual Medium). */ severity?: 'info' | 'warning' | 'critical' };

export const SIGNED_DOCUMENTS = ['contract', 'transfer', 'mortgage_deed', 'deed_of_trust'] as const;
export type SignedDocument = (typeof SIGNED_DOCUMENTS)[number];
export type SigningMethod = 'wet' | 'electronic';
export const SIGNED_DOCUMENT_LABEL: Record<SignedDocument, string> = { contract: 'Contract', transfer: 'Transfer (TR1)', mortgage_deed: 'Mortgage deed', deed_of_trust: 'Declaration of trust' };
export const AVAILABILITY_PARTIES = ['client', 'seller_side', 'agent', 'lender'] as const;
export type AvailabilityParty = (typeof AVAILABILITY_PARTIES)[number];
export interface AvailabilityWindow { id: string; party: AvailabilityParty; from: string; until: string; note: string; recordedAt: string }
/** Windows still to come or in progress, as of now. */
export const activeAvailability = (s: MatterState, now: Date): AvailabilityWindow[] => (s.availability ?? []).filter((w) => new Date(`${w.until}T23:59:59Z`).getTime() >= now.getTime());
export const awayNow = (s: MatterState, party: AvailabilityParty, now: Date): AvailabilityWindow | null => activeAvailability(s, now).find((w) => w.party === party && new Date(`${w.from}T00:00:00Z`).getTime() <= now.getTime()) ?? null;
/** The window a date falls in, if any. */
export const awayOn = (s: MatterState, party: AvailabilityParty, iso: string): AvailabilityWindow | null => (s.availability ?? []).find((w) => w.party === party && w.from <= iso && iso <= w.until) ?? null;

/**
 * One thing a note appears to say. `quote` must be a verbatim span of the note — the
 * machine refuses a proposal that cannot point at the words it came from, which is what
 * stops a model from inventing an instruction nobody gave.
 */
export interface NoteAction {
  id: string;
  kind: NoteActionKind;
  summary: string;
  quote: string;
  confidence: number;
  command: NoteCommand | null;
}

export type NoteStatus = 'proposed' | 'applied' | 'discarded' | 'no_actions';
/** A reply drafted to an email: every point in it answered from the case (the facts it was built from are kept with it). */
export interface NoteReply { subject: string; body: string; drafter: string }
/** Who an email's task can write to. `seller_solicitor` is the other side's solicitor, whichever side we act for. */
export const MESSAGE_PARTIES = ['client', 'seller_solicitor', 'estate_agent', 'lender'] as const;
export type MessageParty = (typeof MESSAGE_PARTIES)[number];
/** One message an email's task would send: to whom, why, and the draft (built from the case). `reply` answers the sender. */
export interface NoteMessage { id: string; to: MessageParty; purposes: string[]; subject: string; body: string; drafter: string; /** Ticked when the task opens (the reply and anything the rules say must go); others are offered unticked. */ on: boolean; /** Files on the case that go with it: a document the client asked for is attached to the reply, not sent separately. `what` is the request in their words. */ attach?: MessageAttachment[]; /** The files go as attachments on this email rather than a secure link. */ asAttachments?: boolean; /** …and for this client from now on. */ alwaysAttach?: boolean }
export interface MessageAttachment { id: string; fileName: string; what: string }

export interface NoteState {
  id: string;
  kind: NoteKind;
  text: string;
  author: Actor;
  at: string;
  documentId: string | null;
  /** Minutes of a call, where it was one. */
  durationSeconds: number | null;
  /** An email's sender, where the note is one. */
  from: NoteSender | null;
  actions: NoteAction[];
  extractor: string | null;
  decisionEventId: string | null;
  status: NoteStatus;
  /** An email read as a pure acknowledgement: nobody needs to reply. */
  acknowledgement?: boolean;
  /** The drafted reply to the writer, built from the case, sent only when a person approves it. */
  reply?: NoteReply | null;
  /** Every message the task would send: the reply to the writer, and anyone else who needs to hear (recipients.ts). */
  messages?: NoteMessage[];
  /** Who the approved task wrote to. */
  messagesSentTo?: MessageParty[];
  appliedActionIds: string[];
  /** Approved, then refused by the machine when it ran — the note's record stays honest. */
  refusedActions: Array<{ id: string; reason: string }>;
}

export interface OtherCharge { id: string; chargee: string; text: string | null; status: 'to_redeem' | 'received' | 'redeemed' | 'discharged'; redemptionPennies: number | null; validUntil: string | null; redeemedAt: string | null; dischargedAt: string | null }
export type FundsRole = 'lender' | 'client' | 'buyer_solicitor' | 'incoming_owner' | 'isa_provider';
export interface ClientMoney {
  /** What each payer was asked for (the figure on the request). */
  requested: Partial<Record<FundsRole, number>>;
  /** What each payer has sent, summed over receipts that carried an amount. */
  received: Partial<Record<FundsRole, number>>;
  /** Money credited but not cleared: it cannot be paid out until it has. */
  uncleared: Array<{ id: string; fromRole: FundsRole; amountPennies: number | null; at: string }>;
  /** The balance on the approved completion statement. */
  statementBalancePennies: number | null;
  /** Money we hold that has to go back: a surplus, or everything on a file that did not proceed. */
  refunds: Array<{ id: string; toRole: FundsRole; to: string | null; amountPennies: number | null; reason: string; dueAt: string; paidAt: string | null; reference: string | null }>;
}

/** A contract (draft or engrossed) as the pipeline reads it: the terms a conveyancer checks before approval and exchange. */
export interface ContractFacts {
  sellers: string[];
  buyers: string[];
  propertyAddress: string;
  titleNumber: string | null;
  pricePennies: number | null;
  depositPennies: number | null;
  depositHolder: string | null;
  completionDate: string | null;
  chattelsPricePennies: number | null;
  vat: string | null;
  incorporatedConditions: string | null;
  noticeToCompleteDays: number | null;
  fixturesListPresent: boolean;
  specialConditions: Array<{ code: string; text: string; locator?: SourceLocator }>;
  indemnities: Array<{ text: string; locator?: SourceLocator }>;
  flags: Flag[];
  /** Whose signatures are on it (empty: unsigned). Missing on readings from before this was asked. */
  signedBy?: string[];
  dated?: boolean;
  confidence: number;
}

export interface IdentityDocumentFacts {
  documentType: 'passport' | 'driving_licence' | 'national_identity_card' | 'residence_permit' | 'other';
  fullName: string;
  dateOfBirth: string | null;
  expiryDate: string | null;
  issuingCountry: string | null;
  photoPresent: boolean;
  wholeDocumentVisible: boolean;
  signsOfAlteration: string[];
  legibility?: 'good' | 'fair' | 'poor' | 'unreadable';
}

export interface IdCheckFacts {
  provider: string;
  outcome: 'clear' | 'refer' | 'fail';
  flags: Flag[];
  confidence: number;
  /** 'document': a photo or scan of the ID itself, read by us; never a completed check (a person confirms it). Absent: a provider's report. */
  source?: 'document';
  identity?: IdentityDocumentFacts | null;
  /** The file sent as ID is not an identity document at all. */
  notIdentity?: boolean;
  /** Who the document names, against the clients on the case (set by the service). */
  nameCheck?: { client: string | null; matches: boolean } | null;
}

// ───────────────────────────── Decisions (2.2 DecisionEvent) ─────────────────────────────

export const DECISION_KINDS = ['id_check', 'search', 'enquiry', 'mortgage', 'title', 'report_on_title', 'contract', 'escalation', 'bank_details', 'auto_clear', 'requisition', 'proof_of_funds', 'management_pack', 'note_actions', 'proposal'] as const;
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
  /** For a person's escalation: who it was escalated to (it is on their Tasks list, not the handler's). */
  assignedTo?: string | null;
}

/** Addendum 3 §3: how the handler engaged with the source before deciding (recorded on the resolving event). */
export interface Engagement {
  scrolledSource: boolean;
  dwellMs: number;
}

// ───────────────────────────── Waits / SLA (2.6) ─────────────────────────────

export const WAIT_KEYS = ['id_check', 'search', 'enquiry', 'funds', 'registration', 'proof_of_funds', 'management_pack', 'property_forms', 'redemption', 'lender_consent', 'discharge', 'contract_pack', 'transfer_deed', 'signed_documents', 'mortgage_offer', 'survey', 'deposit', 'client_decision', 'insurance', 'seller_discharge', 'retention_release'] as const;
/** Things the client arranges in their own time (their mortgage, their survey): opened by the timer, not by a request of ours, so they are checked on rather than left to drift. */
export const EXPECTATION_KEYS = ['mortgage_offer', 'survey'] as const;
export type ExpectationKey = (typeof EXPECTATION_KEYS)[number];
export type WaitKey = (typeof WAIT_KEYS)[number];

export interface WaitState {
  key: WaitKey;
  /** search type / enquiry id / '' */
  subject: string;
  openedAt: string;
  openedBySeq: number;
  /** The actor of the event that opened it: a person's id, or system / ai / external. Absent on states stored before this field. */
  openedBy?: string;
  closedAt: string | null;
  chasesSentAt: string[];
  /** Who sent the last chase by hand (a name); null when the timer sent it. */
  lastChasedBy?: string | null;
  escalations: Array<{ eventId: string; raisedAt: string; resolvedAt: string | null }>;
  /** The owing party says it is done or on its way: no chase before `until`. */
  reported?: { claim: string; at: string; until: string } | null;
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

/** A send a person made themselves when ours failed (Sent Another Way). */
export const MANUAL_CHANNELS = ['post', 'by_hand', 'own_email', 'other'] as const;
export type ManualChannel = (typeof MANUAL_CHANNELS)[number];

export interface ChaseSpec {
  waitKey: WaitKey;
  subject: string;
  recipientRole: 'seller_solicitor' | 'search_provider' | 'lender' | 'client' | 'id_provider' | 'hmlr';
  template: string;
  channel: 'email' | 'whatsapp' | 'portal' | 'mock' | ManualChannel;
  messageId?: string | null;
  /** Stamped by the machine on chases to the counterparty solicitor. */
  counterpartyType?: CounterpartyType | null;
  /** The person who sent it by hand (Chase Now); absent on a timer chase. */
  sentBy?: string | null;
  sentByName?: string | null;
}

/**
 * An acknowledgement: the ping that tells whoever sent us something that it arrived, so
 * they do not write again to ask. Sent by the system the moment the thing is recorded;
 * never a review, never a decision, one per item.
 */
export interface AcknowledgementSpec {
  forEventId: string;
  forEventType: EventType;
  recipientRole: 'seller_solicitor' | 'client';
  /** What we received, in the recipient's words: "your replies to enquiries". */
  what: string;
  channel: 'email' | 'whatsapp' | 'portal' | 'mock' | ManualChannel;
  messageId?: string | null;
}

export interface ClientUpdateSpec {
  template: string;
  /** Who heard: the client unless said otherwise (the agent hears that we chased, too). */
  recipientRole?: 'client' | 'estate_agent' | 'lender' | 'seller_solicitor';
  channel: 'email' | 'whatsapp' | 'mock' | ManualChannel;
  messageId?: string | null;
  triggeredByEventId?: string | null;
  /** The waits this update told the client about (`key:subject`), so the next update does not repeat them for a few days. */
  mentioned?: string[];
  /** The address it went to. */
  to?: string | null;
}

/** Event-type → payload. Keeping this exhaustive is what makes the projection typed. */
export interface Payloads {
  matter_created: {
    transactionType: TransactionType;
    /** Case shapes chosen at enrolment (shapes.ts). Undefined on old logs = none. */
    shapes?: CaseShape[];
    hasLender: boolean;
    requiredSearches: SearchType[];
    targetExchangeDate?: string | null;
    targetCompletionDate?: string | null;
    /** null = not yet known; the audit index (068) picks up whichever events carry it. */
    counterpartyType?: CounterpartyType | null;
    /** Addendum 3 §2: observe only. */
    shadowMode?: boolean;
    /** Firm policy (docs/proof-of-funds.md): exchange is held until proof of funds is signed off. Undefined on old logs = false. */
    requireProofOfFunds?: boolean;
    /** Firm policy (docs/case-model.md §8): exchange needs the client's recorded authority. Undefined on old logs = false. */
    requireExchangeAuthority?: boolean;
    /** Number of clients on our side (buyers / sellers / owners). More than one → co-ownership decisions apply on a purchase or a transfer. */
    parties?: number;
    /** The clients by name, when known; every one beyond the first gets an ID / AML check of their own. */
    partyNames?: string[];
    /** People acting for a client under a power of attorney: identified in their own right, the power seen (LSAG 6.14.9; Lenders' Handbook: powers of attorney). */
    attorneys?: string[];
    /** Company client: directors and persons with significant control, each identified (LSAG 6.14.11 / 6.16). */
    officers?: string[];
    /** Personal representatives or trustees acting: at least two verified, the grant or trust deed seen (LSAG 6.14.16). */
    executors?: string[];
    /** Adult occupiers who are not buying: the lender wants their consent / deed of postponement before completion. */
    occupiers?: string[];
    /** The SDLT basis as the client states it; the return is a person's, the basis is on the file from day one. */
    sdlt?: { firstTimeBuyer: boolean; additionalProperty: boolean; nonUkResident: boolean; mixedUse?: boolean; linkedConsiderationPennies?: number | null } | null;
    /** Sale / remortgage / transfer: the property is charged today (redemption and discharge apply). */
    hasExistingMortgage?: boolean;
    /** Transfer of equity: money changing hands (SDLT may apply; funds come from the incoming owner). */
    considerationPennies?: number | null;
  };
  stage_advanced: { from: Stage; to: Stage; reason: string };
  manual_handling_required: { reason: string; detail?: string };

  /** Another person to identify: a co-buyer / co-owner named at enrolment, or a gift donor declared on the proof-of-funds form. */
  id_party_added: { party: string; label: string; role: IdPartyCheck['role'] };
  id_check_requested: { provider: string; reference?: string | null; /** the person's own link to the check, when the provider gave one */ link?: string | null; /** null / absent = the first client */ party?: string | null };
  id_check_cleared: { facts: IdCheckFacts; reasons: string[]; party?: string | null };
  id_check_flagged: { facts: IdCheckFacts; flags: Flag[]; decision: DecisionSpec; party?: string | null };
  id_check_reviewed: { decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null; party?: string | null };

  search_ordered: { searchType: SearchType; provider: string; reference?: string | null; reissue?: boolean };
  search_returned: { searchType: SearchType; provider?: string | null };
  search_extracted: { searchType: SearchType; facts: SearchFacts; extractor: string };
  search_cleared: { searchType: SearchType; reasons: string[] };
  search_flagged: { searchType: SearchType; flags: Flag[]; decision: DecisionSpec };
  search_reviewed: { searchType: SearchType; decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null };

  enquiry_raised: { enquiryId: string; subject: string; origin?: { decisionEventId?: string; followUpOf?: string; issueId?: string; alsoIssueIds?: string[]; formsQuestion?: string; purpose?: string; about?: string } | null; counterpartyType?: CounterpartyType | null };
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
  /** The lease itself read (leasehold): merged into the title facts; flags go through the title decision. */
  lease_extracted: { facts: LeaseFacts; extractor: string };
  title_cleared: { reasons: string[] };
  title_flagged: { flags: Flag[]; decision: DecisionSpec };
  title_reviewed: { decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null };

  report_on_title_drafted: { draftId: string; draftDocumentId: string; model: string; decision: DecisionSpec; basedOn: string[]; interim?: boolean };
  report_on_title_approved: { draftId: string; decisionEventId: string; note?: string | null };
  report_on_title_rejected: { draftId: string; decisionEventId: string; note?: string | null };
  /** approvedBy is validated by the database (071): a human of this firm who wrote the cited approval event. */
  report_on_title_sent: { draftId: string; approvedEventId: string; approvedBy: string; channel: string; messageId?: string | null };

  deposit_received: { amountPennies?: number | null; /** The deposit the contract states, when it has been read. */ contractDepositPennies?: number | null };
  exchange_conditions_met: { conditions: string[] };
  contracts_exchanged: { completionDate: string; exchangedAt?: string | null; /** Law Society formula, who we spoke to, and where the deposit went (exchange.md 5.1). */ formula?: 'A' | 'B' | 'C' | null; spokeWith?: string | null; depositRoute?: 'held_by_us' | 'sent_to_seller_solicitor' | 'up_the_chain' | null };

  completion_statement_generated: { documentId?: string | null; /** The balance on the approved statement: due from the client on a purchase, to them on a sale. */ balancePennies?: number | null };
  funds_requested: {
    fromRole: 'lender' | 'client' | 'isa_provider';
    amountPennies?: number | null;
    /** The VERIFIED firm client-account record the payer is told to pay into (addendum 2 §5). */
    bankDetailsId: string;
    approvedBy: string;
  };
  funds_received: { fromRole: FundsRole; amountPennies?: number | null; /** Credited but not yet cleared (a cheque, a payment held by the bank): it cannot be paid out. */ uncleared?: boolean; receiptId?: string; /** The name on the sending account, as the bank shows it (LSAG 6.17: money must come from where the evidence said). */ remitter?: string | null };
  completion_confirmed: { completedAt?: string | null };

  sdlt_submitted: { reference?: string | null };
  ap1_submitted: { reference?: string | null };
  ap1_confirmed: { titleNumber?: string | null };

  client_update_sent: ClientUpdateSpec;
  chase_sent: ChaseSpec;
  acknowledgement_sent: AcknowledgementSpec;
  note_recorded: { noteId: string; kind: NoteKind; text: string; durationSeconds: number | null; documentId: string | null; from?: NoteSender | null };
  note_extracted: { noteId: string; actions: NoteAction[]; extractor: string; decision?: DecisionSpec; /** Read as a pure acknowledgement (both checks): no reply needed. */ acknowledgement?: boolean; reply?: NoteReply | null; messages?: NoteMessage[] };
  wait_progress_reported: { waitKey: WaitKey; subject: string; claim: string; until: string; noteId: string | null };
  file_delivery_set: { mode: 'attachments' | 'link'; reason: string | null; noteId: string | null };
  chain_consent_recorded: { given: boolean; reason: string | null; noteId: string | null };
  note_actions_applied: { noteId: string; decisionEventId: string; applied: string[]; skipped: string[]; option: DecisionOption; note: string | null; /** The reply to send with it, as approved (and edited). */ reply?: { subject: string; body: string } | null; /** Every message to send with it, as approved (and edited). */ messages?: Array<{ id: string; to: MessageParty; subject: string; body: string; attach?: MessageAttachment[]; asAttachments?: boolean; alwaysAttach?: boolean }> };
  note_action_refused: { noteId: string; actionId: string; reason: string };
  escalation_raised: {
    /** null when a human escalated a decision rather than a timer firing on a wait. */
    waitKey: WaitKey | null;
    subject: string;
    reason: string;
    decision: DecisionSpec;
    /** The decision that was escalated (user escalations). Resolving the escalation resolves it too. */
    origin?: { decisionEventId: string; kind: DecisionKind } | null;
    /** Who a person escalated it to; a timer's escalation goes to the case's handler. */
    assignedTo?: string | null;
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
  /** PROPOSE level: what the engine wants to do, put in front of a person as a decision. `detail` is everything needed to do it on approval. */
  action_proposed: { action: EngineAction; subject?: string | null; detail: Record<string, unknown>; dedupKey: string; decision: DecisionSpec };
  action_approved: { proposalEventId: string; action: EngineAction; detail: Record<string, unknown>; note?: string | null; edited?: { subject: string | null; body: string | null } };
  action_rejected: { proposalEventId: string; action: EngineAction; detail: Record<string, unknown>; note?: string | null };
  /** A person approved it and the doing failed (a send bounced, a provider was down). Visible on the case, never swallowed. */
  action_failed: { proposalEventId: string; action: EngineAction; detail: Record<string, unknown>; reason: string };
  /** A person tried a failed action again and it went. */
  action_retried: { proposalEventId: string; action: EngineAction };
  /** PROPOSE level: the rule layer would clear this; the clear waits for a person. `clearedEvent` is emitted verbatim on approval. */
  auto_clear_proposed: { subFlow: SubFlow; subject: string; clearedEvent: NewEvent; reasons: string[]; decision: DecisionSpec };
  // ── eventualities ──
  /** The transaction is over without completing: the matter is closed to further commands, timers stop. */
  matter_abandoned: { reason: AbandonReason; detail?: string | null; stage: Stage };
  /** Target exchange / completion dates re-planned (offers expire, chains move). */
  contract_filed: { documentId: string; points: number };
  contract_review_raised: { documentId: string; decision: DecisionSpec; /** The deposit the contract states, when read. */ depositPennies?: number | null };
  contract_reviewed: { decisionEventId: string; option: DecisionOption; note: string | null };
  clients_updated: { partyNames: string[]; previous: string[]; role: IdPartyCheck['role']; reason?: string | null };
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
  issue_raised: { issueId: string; kind: IssueKind; title: string; detail: string | null; gate: IssueGate; stage: Stage; sourceDocumentId: string | null; origin?: { issueId: string; resolution: IssueResolution } | null; party?: string | null; /** Severity at raise (defaults to the kind's). */ severity?: IssueSeverity | null; /** The issue whose investigation discovered this one (DISCOVERED_BY / chains of ordinary issues). */ causedBy?: string | null; resolveBy?: string | null; /** findings.ts code */ finding?: string | null };
  /** Progress on an open issue: negotiating, a note, a gate change (e.g. accepted to carry to completion), the party it concerns. */
  issue_updated: { issueId: string; status: 'open' | 'negotiating'; note: string | null; gate?: IssueGate | null; party?: string | null; resolveBy?: string | null };
  /** Resolved with one of the kind's realistic outcomes and, where money changed hands, what it cost and who paid. Side-effects (price change, lender approval) are separate events that follow it. */
  issue_resolved: { issueId: string; resolution: IssueResolution; note: string | null; costPennies?: number | null; paidBy?: IssuePaidBy | null; details?: Record<string, string | number | boolean | null> | null; documentId?: string | null };
  /** Raised in error / overtaken / the client dropped it. */
  issue_withdrawn: { issueId: string; reason: string };
  /** The issue killed the transaction (the matter is abandoned in the same command). */
  issue_fatal: { issueId: string; reason: string };
  /** The agreed purchase price changed (renegotiation after a survey / down-valuation; recorded before exchange only). */
  price_changed: { fromPennies: number | null; toPennies: number; reason: string; issueId: string | null };
  /** The draft contract is approved as to form (readiness milestone; advisory, not a gate). */
  contract_approved: { note?: string | null; decisionEventId?: string | null };
  /** The client's signed contract is held on file (readiness milestone; advisory, not a gate). */
  signed_contract_held: { note?: string | null };
  // ── proof of funds (docs/proof-of-funds.md) ──
  /** The form link went to the client (recorded after the send). A follow-up carries the request it re-opens. */
  proof_of_funds_requested: { requestId: string; channel: string; messageId?: string | null; /** the address it went to */ to?: string | null; formUrl?: string | null; sendError?: string | null; followUpOf?: string | null; noteToClient?: string | null; /** Queries sent to the client with this round (they move draft → sent). */ queryIds?: string[] };
  /** The client submitted the form: typed facts, the rule flags (declaration AND transaction level), the statements read, the risk rating, and ALWAYS a decision for the conveyancer citing the declaration document. */
  proof_of_funds_submitted: { requestId: string; facts: ProofOfFundsFacts; flags: Flag[]; statements: TransactionReview['statements']; payslips?: TransactionReview['payslips']; risk: PofRiskRating; decision: DecisionSpec };
  proof_of_funds_reviewed: { requestId: string; decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null };
  /** A query to the client about a transaction or a gap — drafted by the rules (actor system) or added by a person. */
  proof_of_funds_query_raised: { requestId: string; query: { id: string; key: string; flagCode: string; documentId: string | null; transaction: StatementTransaction | null; question: string } };
  /** A person decided the query need not be put (with the reason on the log — "considered and discounted"). */
  proof_of_funds_query_withdrawn: { queryId: string; reason: string };
  /** The client answered through the form (with any evidence attached). */
  proof_of_funds_query_answered: { requestId: string; queryId: string; answer: string; evidenceDocumentIds: string[] };
  // ── leasehold ──
  management_pack_requested: { from: string; reference?: string | null };
  /** The LPE1 / pack arrived: always a decision (every figure in it is a client-advice point). */
  management_pack_received: { facts: ManagementPackFacts | null; decision: DecisionSpec };
  management_pack_reviewed: { decisionEventId: string; option: DecisionOption; note?: string | null; engagement?: Engagement | null };
  /** Notice of assignment (and of charge) served on the landlord / managing agent after completion. */
  notice_of_assignment_served: { servedOn: string; reference?: string | null };
  // ── case model ──
  /** The client's survey (or valuation) arrived and was read: recommendations are facts; each "further investigation" one raises an issue. */
  survey_received: { surveyType: SurveyType; facts: SurveyFacts; extractor: string; reread?: boolean };
  /** A specialist's report arrived for a further-investigation issue: read; "no further investigation" resolves that issue (a fact), a new recommendation chains a new one. */
  specialist_report_received: { facts: SurveyFacts; forIssueId: string | null; extractor: string; furtherInvestigation: boolean };
  /** The client's decision on something only the client decides — recorded by a person, never inferred. */
  /** approvedEventId: the note_actions_applied event a person approved it in, when it came from a note (the database checks it). */
  /** An answer the client gave no longer holds: what it rested on changed (the price, the date, who the clients are). They are asked again. */
  client_decision_lapsed: { subject: ClientDecisionSubject; reason: string };
  funds_cleared: { receiptId: string };
  refund_due: { refundId: string; toRole: FundsRole; to: string | null; amountPennies: number | null; reason: string };
  refund_paid: { refundId: string; reference: string };
  charge_found: { chargeId: string; chargee: string; text: string | null };
  charge_statement_received: { chargeId: string; redemptionPennies: number; validUntil: string | null };
  charge_redeemed: { chargeId: string; amountPennies: number | null };
  charge_discharged: { chargeId: string; reference: string | null };
  /** Our undertaking to the buyer's solicitor to redeem every charge and send the discharges. */
  undertaking_given: { to: string; terms: string };
  /** The discharges sent to the buyer's solicitor: our undertaking is fulfilled. */
  undertaking_discharged: { note: string | null };
  /** The seller's solicitor's replies to completion information (TA13): the undertaking to redeem the seller's charges. */
  completion_information_received: { undertakingToRedeem: boolean; documentId: string | null };
  longstop_date_recorded: { date: string };
  completion_payment_sent: { reference: string; sentAt: string };
  final_bill_delivered: { amountPennies: number; documentId: string | null };
  formula_c_release_given: { until: string; givenTo: string };
  formula_c_release_lapsed: { reason: string };
  property_event_recorded: { event: 'damaged' | 'not_vacant'; detail: string };
  retention_released: { amountPennies: number | null };
  redemption_figure_adjusted: { redemptionPennies: number; days: number; reason: string };
  contributions_recorded: { model: 'FIXED' | 'RING_FENCE' | 'CONTRIBUTION' | 'FLOATING'; contributions: Array<{ party: string; pennies: number }>; ratioPercent: Record<string, number> | null; shares: Array<{ party: string; shareBp: number }> };
  ap1_cancelled: { reason: string };
  requisition_extended: { requisitionEventId: string; deadline: string; note: string };
  register_checked: { ok: boolean; note: string | null; lenderTold: boolean };
  seller_discharge_received: { reference: string | null };
  party_event_recorded: { event: 'died' | 'capacity_lost' | 'bankrupt'; party: string; hasAttorney: boolean | null; note: string | null };
  sar_made: { noticeEnds: string };
  daml_response_recorded: { decision: 'granted' | 'refused'; moratoriumEnds: string | null };
  sdlt_facts_recorded: { facts: { wales?: boolean; mainResidence?: boolean; anyEverOwned?: boolean; anyOwnsOther?: boolean; replacing?: boolean; replacingFirst?: boolean; anyNonResident?: boolean; mixedUse?: boolean; debtAssumedPennies?: number | null }; basis: { firstTimeBuyer: boolean; additionalProperty: boolean; nonUkResident: boolean; mixedUse?: boolean; wales?: boolean }; reasons: string[]; refundDiary: boolean };
  cgt_facts_recorded: { mainResidenceThroughout: boolean; ukResident: boolean };
  client_decision_recorded: { subject: ClientDecisionSubject; decision: string; /** Joint clients: whose decision this is (each must authorise exchange). */ party?: string | null; note?: string | null; evidenceDocumentId?: string | null; approvedEventId?: string | null; /** further_investigation: the investigations this applies to (issue ids); absent = all open ones. */ scope?: string[] | null };
  /** Severity moved (by a person, or by the timer as a deadline nears). */
  issue_severity_changed: { issueId: string; severity: IssueSeverity; reason: string };
  /** The file is closed: registered, everything served, nothing further. */
  matter_closed: { reason?: string | null; /** When the file may be destroyed, and the CDD records (theme H). */ destroyAfter?: string | null; cddUntil?: string | null };
  // ── transaction types (docs/transaction-types.md) ──
  /** Sale: the protocol forms (TA6 / TA10 / TA7) asked of the client; the wait opens. */
  property_forms_requested: { forms: string[] };
  property_forms_received: { forms: string[]; facts?: PropertyFormsFacts | null };
  /** Purchase side: the seller's TA6 / TA7 / TA10 arrived with the contract pack and were read. */
  seller_forms_received: { forms: string[]; facts: PropertyFormsFacts | null };
  /** Our client is also selling (or buying): the other matter, so exchange can be made simultaneous and sale proceeds traced. */
  related_matter_linked: { relatedMatterId: string; relation: 'sale' | 'purchase'; note?: string | null };
  related_matter_unlinked: { relatedMatterId: string; reason: string };
  step_completed_manually: { step: string; note: string; documentIds: string[]; facts?: ManualStepFacts | null; skipReason?: string | null };
  manual_step_undone: { step: string; completionEventId: string; reason: string };
  step_reopened: { step: string; reason: string };
  /** The lender's Part 2 answers that change a rule on this matter. */
  lender_requirements_recorded: { minUnexpiredYears?: number | null; maxSearchAgeMonths?: number | null; acceptsNonFamilyGift?: boolean | null; requiresEws1?: boolean | null; note?: string | null };
  /** A credit on client account that is not the completion money: recorded so the sender is checked (LSAG 5.6.3.2, 6.17.2). */
  client_account_receipt_recorded: { remitter: string; amountPennies: number | null; purpose: 'fees' | 'deposit' | 'completion' | 'other'; reference?: string | null };
  /** A person's name differs across documents for a documented reason (marriage, deed poll): the two names are the same person from here on. */
  name_change_evidenced: { party: string | null; from: string; to: string; reason: string; documentId?: string | null };
  /** Sale: draft contract, title and forms sent to the buyer's solicitor. */
  contract_pack_sent: { includes: string[]; channel?: string | null; messageId?: string | null };
  /** Purchase: the buyer's solicitor has asked the seller's solicitor for the draft contract, official copies, plan and forms; the wait opens here. */
  contract_pack_requested: { to: string };
  /** A purchase, after exchange: the seller's solicitor is asked for the TR1 their client has signed, for completion. */
  signed_transfer_requested: { to: string };
  /** Sale: the buyer's solicitor's enquiries arrived (each becomes an inbound enquiry awaiting our reply). */
  buyer_enquiries_received: { enquiries: Array<{ id: string; question: string }>; round: number };
  /** Sale: replies sent (a person sends; the client's answers are theirs). */
  enquiry_replies_sent: { enquiryIds: string[]; channel?: string | null; messageId?: string | null };
  /** Sale / remortgage / transfer: the redemption statement asked of the existing lender; the wait opens. */
  redemption_statement_requested: { lender: string | null };
  redemption_statement_received: { lender: string | null; redemptionPennies: number | null; validUntil: string | null; dailyInterestPennies?: number | null };
  /** The existing charge was paid off (after payment_authorised to the lender against verified details). */
  mortgage_redeemed: { lender: string | null; amountPennies: number | null };
  /** The lender confirmed the discharge (DS1 / e-DS1 / ED). */
  discharge_confirmed: { lender: string | null; reference?: string | null };
  /** The client signed the mortgage deed (witnessed). */
  mortgage_deed_executed: { lender: string | null; witnessed: boolean };
  /** Certificate of title / report on title to the lender sent; the advance is requested against it. */
  certificate_of_title_sent: { lender: string | null; completionDate: string | null };
  /** Lenders' Handbook: buildings insurance in place from exchange, on the lender's terms; confirmed before completion. */
  buildings_insurance_confirmed: { insurer: string | null; fromDate: string | null; documentId?: string | null };
  /** The OS1 (or OS2) priority search: registration protected until `expiresAt` (30 working days); completion inside the window. */
  priority_search_made: { expiresAt: string; documentId?: string | null };
  /** The K16 bankruptcy search against every borrower (Lenders' Handbook: insolvency): clear, or the hit explained. */
  bankruptcy_search_clear: { subjects: string[]; documentId?: string | null };
  /** Transfer of equity: the existing lender's consent to the transfer asked; the wait opens. */
  lender_consent_requested: { lender: string | null };
  lender_consent_received: { lender: string | null; conditions?: string | null };
  /** TR1 / transfer deed signed by every party (witnessed). */
  transfer_deed_executed: { parties: string[]; witnessed: boolean };
  /** Declaration / deed of trust executed (tenants in common; unequal contributions). */
  deed_of_trust_executed: { parties: string[]; shares?: string | null; documentId?: string | null };
  /** No SDLT return is due (below the threshold / no chargeable consideration) — a person's determination, recorded. */
  sdlt_not_required: { reason: string };
  /** Someone on the case is away for a period: chases to them wait, updates say so, target dates are checked against it. */
  availability_recorded: { id: string; party: AvailabilityParty; from: string; until: string; note: string };
  expectation_opened: { key: ExpectationKey };
  title_plan_read: { facts: TitlePlanFacts };
  supporting_document_read: { facts: SupportingDocFacts };
  /** A person resumed automation after a pause, with why. */
  manual_handling_cleared: { reason: string; was: string | null };
  /** The buyer now has a mortgage, or is now buying without one. */
  funding_changed: { hasLender: boolean; reason: string };
  /** The client's plan for a survey: none (their choice, recorded) or booked for a date. */
  survey_plan_recorded: { plan: 'none' | 'booked'; date: string | null; note: string | null };
  /** Wet ink or electronic, for one deed on this case (the lender's rules, or the client's circumstances). */
  signing_method_set: { document: SignedDocument; method: SigningMethod; reason: string | null };
  /** The client was sent what they must sign, and how. */
  signing_pack_sent: { documents: SignedDocument[]; methods: Partial<Record<SignedDocument, SigningMethod>>; attached: string[]; channel: string; messageId: string | null };
  /** A deed went out for electronic signature. */
  signing_envelope_sent: { document: SignedDocument; provider: string; envelopeId: string };
}

/** The seller's protocol forms as the pipeline reads them (facts for disclosure; every "yes" is a client-advice point). */
export interface PropertyFormsFacts {
  forms: string[];
  disclosures: Flag[];
  confidence: number;
  /** The TA6 / TA7 answers that change what the file needs (property-forms.ts turns each into an issue). Null / empty = "no" or not answered. */
  answers?: {
    disputes?: string | null;
    notices?: string | null;
    alterations?: string | null;
    alterationsConsented?: boolean | null;
    alterationsDocumentsEnclosed?: boolean | null;
    listedOrConservation?: boolean | null;
    guaranteesOutstandingClaims?: string | null;
    insuranceClaims?: string | null;
    insuranceRefused?: boolean | null;
    flooded?: boolean | null;
    floodDetail?: string | null;
    japaneseKnotweed?: boolean | null;
    knotweedDetail?: string | null;
    radonTestAboveAction?: boolean | null;
    occupiers?: string | null;
    sharedAccessOrServices?: boolean | null;
    rightsOfWayOverProperty?: string | null;
    septicTank?: boolean | null;
    solarPanelsLeased?: boolean | null;
    boundariesUnclear?: string | null;
    leaseholdArrearsOrDispute?: boolean | null;
    epcRating?: string | null;
    councilTaxBand?: string | null;
  } | null;
  /** Questions the seller answered "not known" or left blank: each is an enquiry to draft (the engine proposes them; a person sends). */
  notKnown?: Array<{ question: string; section: string | null; page: number | null }> | null;
  /** Page of the form each section was read from. */
  pages?: Partial<Record<'boundaries' | 'disputes' | 'notices' | 'alterations' | 'guarantees' | 'insurance' | 'environment' | 'rights' | 'occupiers' | 'services' | 'leasehold', number>> | null;
}

export const ISSUE_PAID_BY = ['buyer', 'seller', 'shared', 'lender', 'other'] as const;
export type IssuePaidBy = (typeof ISSUE_PAID_BY)[number];

/** Event types whose payload carries a DecisionSpec (i.e. they create a DecisionEvent). */
export const DECISION_EVENT_TYPES: ReadonlyArray<EventType> = [
  'id_check_flagged',
  'search_flagged',
  'enquiry_reply_flagged',
  'mortgage_condition_flagged',
  'title_flagged',
  'report_on_title_drafted',
  'contract_review_raised',
  'escalation_raised',
  'bank_details_change_flagged',
  'auto_clear_review_raised',
  'auto_clear_proposed',
  'action_proposed',
  'notice_to_complete_served',
  'hmlr_requisition_received',
  'proof_of_funds_submitted',
  'management_pack_received',
  'note_extracted',
];

export type { PofQuery };

// ───────────────────────────── Shadow mode / trust levels (addendum 3 §2) ─────────────────────────────

/** The engine's sub-flows, each promoted out of shadow independently. */
export const SUB_FLOWS = ['id_check', 'search', 'enquiry', 'mortgage', 'title', 'report_on_title', 'chase', 'proof_of_funds', 'management_pack'] as const;
export type SubFlow = (typeof SUB_FLOWS)[number];

/**
 * Trust levels, per action the engine takes on its own (docs/conveyance-engine.md §2).
 *
 *   propose — the engine asks first: the intended action is a decision in Tasks and
 *             nothing happens until a person approves it. The outset for every firm.
 *   assist  — the mechanical goes out unasked (acks, chases, search orders); anything
 *             with judgement or the client's ear is still proposed; auto-clears happen
 *             and are put in front of a person afterwards to confirm.
 *   auto    — everything proceeds. Flagged decisions and human-gated events are a
 *             person's regardless of level.
 *
 * Promotion is earned per action, from the proposals a firm has approved unchanged.
 */
export const ENGINE_ACTIONS = ['acknowledgement', 'chase', 'client_update', 'search_order', 'auto_clear', 'enquiry_draft', 'email_no_reply', 'counterparty_update'] as const;
export type EngineAction = (typeof ENGINE_ACTIONS)[number];
export const ENGINE_ACTION_LABEL: Record<EngineAction, string> = {
  acknowledgement: 'Acknowledgements',
  chase: 'Chases',
  client_update: 'Client updates',
  search_order: 'Search orders',
  auto_clear: 'Auto-clears',
  enquiry_draft: 'Enquiries drafted from the forms',
  email_no_reply: 'Acknowledgements needing no reply',
  counterparty_update: 'Updates to the other side',
};
/**
 * The subjects a level can be set on within each action: who is written to, which search,
 * which template, which sub-flow. A level set on `action:subject` overrides the action's.
 */
export const ENGINE_ACTION_SUBJECTS: Record<EngineAction, ReadonlyArray<{ key: string; label: string }>> = {
  counterparty_update: [
    { key: 'searches_back', label: 'Our searches are back' },
    { key: 'mortgage_offer', label: "Our client's mortgage offer is in" },
    { key: 'ready_to_exchange', label: 'We are ready to exchange' },
  ],
  acknowledgement: [
    { key: 'seller_solicitor', label: "Other side's solicitor" },
    { key: 'client', label: 'Client' },
  ],
  chase: [
    { key: 'id_check', label: 'ID documents from the client' },
    { key: 'proof_of_funds', label: 'Proof-of-funds form from the client' },
    { key: 'property_forms', label: 'Property forms from the client' },
    { key: 'search', label: 'Search result from the provider' },
    { key: 'enquiry', label: "Replies from the other side's solicitor" },
    { key: 'management_pack', label: 'Management pack' },
    { key: 'redemption', label: 'Redemption statement from the lender' },
    { key: 'lender_consent', label: "Lender's consent" },
    { key: 'funds', label: 'Completion funds' },
    { key: 'registration', label: 'Registration at HM Land Registry' },
    { key: 'discharge', label: 'Discharge from the lender' },
    { key: 'contract_pack', label: "Draft contract pack from the seller's solicitor" },
    { key: 'signed_documents', label: 'Signed documents from the client' },
    { key: 'deposit', label: 'The deposit from the client' },
    { key: 'client_decision', label: "The client's decisions" },
    { key: 'insurance', label: 'Buildings insurance from the client' },
  ],
  client_update: [
    { key: 'id_check_request', label: 'ID / AML check request' },
    { key: 'proof_of_funds_request', label: 'Proof-of-funds form' },
    { key: 'searches_ordered', label: 'Searches ordered' },
    { key: 'searches_all_back', label: 'Searches all back' },
    { key: 'enquiries_raised', label: 'Enquiries raised' },
    { key: 'mortgage_offer_checked', label: 'Mortgage offer checked' },
    { key: 'report_on_title_sent', label: 'Report on title sent' },
    { key: 'chase_update', label: 'Chased on their behalf' },
    { key: 'progress_update', label: 'A stage signed off: where everything stands' },
    { key: 'exchanged', label: 'Exchanged' },
    { key: 'completed', label: 'Completed' },
    { key: 'registration_complete', label: 'Registration complete' },
    { key: 'ownership_basis_request', label: 'How they will own it (joint buyers)' },
    { key: 'exchange_authority_request', label: 'Authority to exchange' },
    { key: 'buildings_insurance_request', label: 'Buildings insurance from exchange' },
    { key: 'balance_request', label: 'The balance for completion' },
  ],
  search_order: [
    { key: 'LLC1', label: 'LLC1' },
    { key: 'CON29', label: 'CON29' },
    { key: 'DRAINAGE_WATER', label: 'Drainage and water' },
    { key: 'ENVIRONMENTAL', label: 'Environmental' },
    { key: 'CHANCEL', label: 'Chancel' },
  ],
  auto_clear: [
    { key: 'id_check', label: 'ID / AML result' },
    { key: 'search', label: 'Search result' },
    { key: 'enquiry', label: 'Enquiry reply' },
    { key: 'mortgage', label: 'Mortgage offer' },
    { key: 'title', label: 'Title' },
  ],
  enquiry_draft: [
    { key: 'ta6', label: 'From the seller\'s TA6 / TA7 answers' },
  ],
  email_no_reply: [
    { key: 'client', label: 'From the client' },
    { key: 'other_side', label: "From the other side" },
    { key: 'agent', label: 'From the estate agent' },
    { key: 'lender', label: 'From the lender or broker' },
  ],
};
export const TRUST_LEVELS = ['propose', 'assist', 'auto'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
/** Keys are an action (`chase`) or an action and subject (`chase:lender`). */
export type LevelConfig = Record<string, TrustLevel>;
export const DEFAULT_LEVELS: LevelConfig = { acknowledgement: 'propose', chase: 'propose', client_update: 'propose', search_order: 'propose', auto_clear: 'propose', enquiry_draft: 'propose', email_no_reply: 'propose', counterparty_update: 'propose' };
export const levelKey = (action: EngineAction, subject?: string | null): string => (subject ? `${action}:${subject}` : action);
/** The level in force for an action on a subject: the subject's own, else the action's, else propose. */
export function levelFor(cfg: LevelConfig | null | undefined, action: EngineAction, subject?: string | null): TrustLevel {
  const c = cfg ?? DEFAULT_LEVELS;
  return (subject ? c[levelKey(action, subject)] : undefined) ?? c[action] ?? 'propose';
}
/** What ASSIST does unasked. Everything else at assist is proposed. */
export const ASSIST_ACTS: Record<EngineAction, boolean> = { acknowledgement: true, chase: true, search_order: true, client_update: false, auto_clear: true, enquiry_draft: false, email_no_reply: false, counterparty_update: false };
/** Whether an action at a level goes ahead without a person. */
export const actsUnasked = (level: TrustLevel, action: EngineAction): boolean => level === 'auto' || (level === 'assist' && ASSIST_ACTS[action]);


/** Which sub-flow a decision kind belongs to (for hiding decisions of a shadowed sub-flow). */
export const SUBFLOW_OF_KIND: Record<DecisionKind, SubFlow | null> = { id_check: 'id_check', search: 'search', enquiry: 'enquiry', mortgage: 'mortgage', title: 'title', report_on_title: 'report_on_title', contract: null, escalation: 'chase', bank_details: null, auto_clear: null, requisition: null, proof_of_funds: 'proof_of_funds', management_pack: 'management_pack', note_actions: null, proposal: null };

export type SuppressedAction = 'search_order' | 'id_check_request' | 'client_update' | 'chase' | 'acknowledgement' | 'report_send' | 'linked_enquiry_delivery' | 'stage_mirror' | 'proof_of_funds_request';

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

/**
 * Steps a person may mark complete by hand while the case is in manual handling: each becomes
 * "reviewed by a person", which every gate accepts as resolved. Exchange and completion keep their
 * own forms (dates, money); searches and enquiries are named per item (search:CON29, enquiry:E2).
 */
/** What a step completed by hand records in place of the reading it skipped: the facts later rules and deadlines run on. */
export interface ManualStepFacts {
  lender?: string | null;
  amountPennies?: number | null;
  expiryDate?: string | null;
  validUntil?: string | null;
  titleNumber?: string | null;
  minUnexpiredYears?: number | null;
  maxSearchAgeMonths?: number | null;
  acceptsNonFamilyGift?: boolean | null;
  requiresEws1?: boolean | null;
}
/** The facts a step cannot sensibly be completed without (a person may still skip them, with a reason). */
export const MANUAL_STEP_REQUIRED: Record<string, Array<{ key: keyof ManualStepFacts; label: string }>> = {
  mortgage: [{ key: 'lender', label: 'the lender' }, { key: 'amountPennies', label: 'the amount of the advance' }, { key: 'expiryDate', label: 'the offer expiry date' }],
  redemption: [{ key: 'amountPennies', label: 'the redemption figure' }, { key: 'validUntil', label: 'the date the figure is good to' }],
  title: [{ key: 'titleNumber', label: 'the title number' }],
};
export const MANUAL_STEPS = ['id_check', 'proof_of_funds', 'title', 'report_on_title', 'enquiries', 'mortgage', 'management_pack', 'property_forms', 'contract_pack', 'contract_approved', 'deposit', 'redemption'] as const;
/**
 * Steps a person can mark incomplete when what was done no longer holds (an offer expired, a price
 * change voided the signed papers, a search went stale): the history stays, the step is outstanding
 * again from now, and what it unlocked is locked again. Not the same as undoing a completion made in error.
 */
export const REOPENABLE_STEPS: Record<string, string> = {
  id_check: 'The ID check has to be done again',
  proof_of_funds: 'Proof of funds has to be given and signed off again',
  title: 'The title has to be checked again',
  report_on_title: 'The report on title has to be redrafted and sent again',
  mortgage: 'The mortgage offer is treated as withdrawn: a new offer is needed and exchange is held until it is checked',
  management_pack: 'The management pack has to be obtained and reviewed again',
  property_forms: 'The property forms have to be completed again',
  contract_pack: 'The contract pack has to be sent again',
  contract_approved: 'The contract has to be approved again, and signed again by the client',
  deposit: 'The deposit is no longer treated as held',
  redemption: 'A fresh redemption statement is needed',
};
export const isReopenableStep = (step: string): boolean => step in REOPENABLE_STEPS || /^search:[A-Z0-9_]+$/.test(step);
export const isManualStep = (step: string): boolean => (MANUAL_STEPS as readonly string[]).includes(step) || /^search:[A-Z0-9_]+$/.test(step) || /^enquiry:[\w-]{1,40}$/.test(step);
/** cleared (auto), reviewed (human) and withdrawn (enquiries) all count as resolved for stage gating. */
export const isResolved = (s: string | undefined): boolean => s === 'cleared' || s === 'reviewed' || s === 'withdrawn';

export const ABANDON_REASONS = ['client_withdrew', 'seller_withdrew', 'chain_collapsed', 'gazumped', 'survey', 'finance_failed', 'conflict', 'client_died', 'capacity', 'aml', 'fraud_suspected', 'rescinded', 'other'] as const;
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

/** Sale: an enquiry the buyer's solicitor raised on us; replied when our reply went. */
export interface InboundEnquiryState {
  id: string;
  question: string;
  round: number;
  receivedAt: string;
  repliedAt: string | null;
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
  /** Where it came from: a decision, a follow-up, an issue, or a "not known" answer on the seller's forms. */
  origin?: { decisionEventId?: string; followUpOf?: string; issueId?: string; alsoIssueIds?: string[]; formsQuestion?: string; purpose?: string; about?: string } | null;
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
  /** The reading's finding that raised it (findings.ts code): a finding is raised once per case. */
  finding?: string | null;
  /** Who it concerns when a matter has more than one buyer / party (free text; null = the matter as a whole). */
  party: string | null;
  /** What the fix cost and who paid, once resolved (an indemnity premium, a retention, a reduction). */
  costPennies: number | null;
  paidBy: IssuePaidBy | null;
  /** Enquiries raised from this issue. */
  enquiryIds: string[];
  severity: IssueSeverity;
  /** The issue whose investigation discovered this one. */
  causedBy: string | null;
  history: Array<{ at: string; by: Actor; what: string }>;
  /** When the client was last told about it (an email about it, or the reply that raised it); cleared when it gets worse. A reply does not raise it again unless they ask. */
  clientToldAt?: string | null;
  /** The date it should be sorted by (YYYY-MM-DD): set at raise from the kind's window (before the gate's target date), and movable. Past it, the issue is late. */
  resolveBy?: string | null;
  /** What the outcome recorded (the resolve form's fields), and the file that evidences it. */
  details?: Record<string, string | number | boolean | null> | null;
  evidenceDocumentId?: string | null;
  /** For a surveyor's further investigation: what the client said to do about it (ask the seller for evidence, get access, or leave it). */
  route?: 'evidence' | 'pursue' | 'waive' | null;
}

export interface MatterState {
  tenantId: string;
  matterId: string;
  enrolled: boolean;
  transactionType: TransactionType | null;
  hasLender: boolean;
  /** Case shapes (shapes.ts): what this case is beyond its type; each raised its checklist issue at enrolment. */
  shapes: CaseShape[];
  requiredSearches: SearchType[];
  shadowMode: boolean;
  /** Firm policy: exchange needs a signed-off proof of funds (docs/proof-of-funds.md). */
  requireProofOfFunds: boolean;
  /** Firm policy: exchange needs the client's recorded authority (docs/case-model.md §8). */
  requireExchangeAuthority: boolean;
  /** Clients on our side; > 1 → co-ownership applies on a purchase / transfer. */
  parties: number;
  /** Sale / remortgage / transfer: a charge to redeem and discharge. */
  hasExistingMortgage: boolean;
  /** Transfer of equity: chargeable consideration, if any. */
  considerationPennies: number | null;
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
    /** The client's own link to the check, when the provider gave one: a chase sends it again. */
    link?: string | null;
    /** When the first client's check last cleared or was reviewed: the clock for ongoing monitoring (LSAG 6.21). */
    resolvedAt?: string | null;
  };
  /** Every other person who must be identified: a second buyer, seller or owner (holds Instruction) and a gift donor (holds proof-of-funds sign-off). Keyed by party id. */
  partyChecks: Record<string, IdPartyCheck>;
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
    /** The lease as read from the lease itself (leasehold); also mirrored onto facts.lease once the title is read. */
    lease: LeaseFacts | null;
    leaseDocumentId: string | null;
    /** Title plans read on the case, each against its own title number. */
    plans?: Array<{ documentId: string; facts: TitlePlanFacts; at: string }>;
    /** The documents behind the seller's forms: indemnity policies, permissions, certificates, guarantees. */
    supporting?: Array<{ documentId: string; facts: SupportingDocFacts; at: string }>;
  };
  reportOnTitle: {
    status: 'not_started' | 'drafted' | 'approved' | 'rejected' | 'sent';
    draftId: string | null;
    draftEventId: string | null;
    draftDocumentId: string | null;
    approvedEventId: string | null;
    approvedBy: string | null;
    sentAt: string | null;
    /** Drafted before searches, enquiries and the offer were all in: an interim report; a supplementary one is due once they are. */
    interim?: boolean;
    /** When an interim report went to the client (the supplementary is what is due now). */
    interimSentAt?: string | null;
  };
  deposit: { received: boolean; at: string | null; /** What has come in towards it, and what the contract says it is. */ amountPennies?: number | null; contractPennies?: number | null };
  /** The final bill delivered to the client: fees are taken from client money only after it (SRA Accounts Rules 4.3). */
  finalBill?: { amountPennies: number; deliveredAt: string; documentId: string | null } | null;
  /** Joint clients' authority to exchange, each their own (parties.md 2.7). */
  authorityByParty?: Record<string, string>;
  /** What each buyer puts in and the declaration of trust's model, with each owner's share at purchase (co-owners.ts). */
  coOwnership?: { model: 'FIXED' | 'RING_FENCE' | 'CONTRIBUTION' | 'FLOATING'; contributions: Array<{ party: string; pennies: number }>; ratioPercent: Record<string, number> | null; shares: Array<{ party: string; shareBp: number }>; recordedAt: string } | null;
  /** After registration: the new register read against what it should say, and when (theme H). */
  registerCheckedAt?: string | null;
  /** When the file may be destroyed, and the CDD records, stamped on closing. */
  retention?: { destroyAfter: string; cddUntil: string } | null;
  /** People events (theme G): who has died, lost capacity or become bankrupt, and when. */
  partyEvents?: Array<{ event: 'died' | 'capacity_lost' | 'bankrupt'; party: string; at: string; hasAttorney: boolean | null }>;
  /** A suspicious activity report made with a request for consent (DAML): money and exchange wait; nothing is said to the client about it. */
  amlHold?: { since: string; noticeEnds: string; status: 'awaiting' | 'granted' | 'refused'; moratoriumEnds: string | null } | null;
  /** A new build's long-stop date from the contract: past it either side may rescind. */
  longStopDate?: string | null;
  /** Charges beyond the existing mortgage (a second charge, a secured loan, a charging order): each redeemed and discharged (engine/charges.ts). */
  otherCharges: OtherCharge[];
  /** Our undertaking on a sale to redeem every charge, and when the discharges went to the buyer's solicitor. */
  undertaking: { givenAt: string; to: string; terms: string; dischargedAt: string | null } | null;
  /** On a purchase: the seller's solicitor's completion information (TA13), with their undertaking to redeem. */
  completionInformation: { receivedAt: string; undertakingToRedeem: boolean; documentId: string | null } | null;
  /** The client's money on this file, reconciled (engine/money.ts): asked for, received and cleared by payer; what is owed back. */
  money: ClientMoney;
  exchange: { conditionsMet: boolean; exchangedAt: string | null; completionDate: string | null; /** Formula C: our release given until a time today; while it is live we are bound to exchange if called (exchange.md 5.2). */ release?: { until: string; givenTo: string; at: string } | null; formula?: 'A' | 'B' | 'C' | null; spokeWith?: string | null; depositRoute?: 'held_by_us' | 'sent_to_seller_solicitor' | 'up_the_chain' | null };
  /** Purchase side: the seller's forms as read. */
  /** The seller's forms as a set: they come as separate files (TA6, TA10, TA7), each adding forms and answers. */
  sellerForms: { receivedAt: string | null; forms: string[]; documentId: string | null; facts: PropertyFormsFacts | null; documents?: Array<{ documentId: string; forms: string[] }> };
  /** Our client's linked sale or purchase (one client, one chain). */
  relatedMatter: { matterId: string; relation: 'sale' | 'purchase'; linkedAt: string } | null;
  /** How files reach the client: a secure link (the default), or attachments when they asked for that. */
  fileDelivery?: 'link' | 'attachments';
  /** The client has said we may tell the other side about their own sale or purchase (their chain). */
  shareChain?: boolean;
  /** The lender's own (Part 2) requirements recorded on this matter; null = the defaults. */
  lenderRequirements: { minUnexpiredYears: number | null; maxSearchAgeMonths: number | null; acceptsNonFamilyGift: boolean | null; requiresEws1: boolean | null; note: string | null; recordedAt: string } | null;
  /** Documented name changes: [from, to] pairs the cross-checks treat as one person. */
  nameAliases: Array<{ from: string; to: string; party: string | null }>;
  /** Pre-completion checks the Lenders' Handbook requires on a lender-funded purchase (and good practice on a cash one). */
  preCompletion: { insuranceConfirmedAt: string | null; insurer: string | null; prioritySearchAt: string | null; prioritySearchExpiresAt: string | null; bankruptcySearchAt: string | null };
  /** The clients by name as enrolled (first = the client on `idCheck`). */
  partyNames: string[];
  /** Adult occupiers named at enrolment who are not buying. */
  occupiers: string[];
  /** The SDLT basis the client declared at enrolment (null = nothing declared). */
  sdltBasis: { firstTimeBuyer: boolean; additionalProperty: boolean; nonUkResident: boolean; mixedUse?: boolean; linkedConsiderationPennies?: number | null; wales?: boolean } | null;
  /** The buyers' answers the basis is worked out from (sdlt-facts.ts), and the reasons it gives. */
  sdltFacts?: { wales?: boolean; mainResidence?: boolean; anyEverOwned?: boolean; anyOwnsOther?: boolean; replacing?: boolean; replacingFirst?: boolean; anyNonResident?: boolean; mixedUse?: boolean; debtAssumedPennies?: number | null; recordedAt?: string; reasons?: string[]; refundDiary?: boolean } | null;
  /** On a sale: the client's two CGT answers (a flag, never advice). */
  cgtFacts?: { mainResidenceThroughout?: boolean; ukResident?: boolean; recordedAt: string } | null;
  /** Money that landed on client account outside the completion flow (fees, the deposit, an unexpected credit): who sent it and what for. */
  receipts: Array<{ remitter: string; amountPennies: number | null; purpose: 'fees' | 'deposit' | 'completion' | 'other'; at: string }>;
  completion: {
    statementGeneratedAt: string | null;
    fundsRequestedAt: string | null;
    fundsReceivedAt: string | null;
    /** Who the money came from (lender, client, buyer_solicitor, incoming_owner, isa_provider): a purchase completes only with the advance and the client's balance in. */
    receivedFrom: string[];
    confirmedAt: string | null;
    /** The completion money sent to the seller's solicitor: the CHAPS reference and when. */
    paymentSent?: { reference: string; at: string } | null;
  };
  postCompletion: { sdltSubmittedAt: string | null; ap1SubmittedAt: string | null; ap1ConfirmedAt: string | null; requisitions: Array<{ eventId: string; receivedAt: string; respondedAt: string | null; deadline: string | null }>; noticeOfAssignmentAt: string | null };
  /** Proof of funds (docs/proof-of-funds.md). */
  proofOfFunds: {
    status: 'not_started' | 'requested' | 'submitted' | 'reviewed';
    requestId: string | null;
    requestedAt: string | null;
    submittedAt: string | null;
    documentId: string | null;
    facts: ProofOfFundsFacts | null;
    decisionEventId: string | null;
    resolution: DecisionOption | null;
    formUrl: string | null;
    /** How the latest request reached the client — or 'unsent' when it could not, with the reason in sendError. */
    channel: string | null;
    sendError: string | null;
    /** How many times the form has gone out (1 = first request; more = "request further"). */
    rounds: number;
    /** The latest submission's flags (declaration + transactions), statements read, and risk rating. */
    flags: Flag[];
    statements: TransactionReview['statements'];
    payslips?: TransactionReview['payslips'];
    risk: PofRiskRating | null;
    /** Queries to the client: drafted by the rules or a person, sent with a round, answered through the form, or withdrawn with a reason. */
    queries: Record<string, PofQuery>;
    approvedAt: string | null;
    approvedBy: string | null;
  };
  /** The survey workstream (docs/case-model.md §7): facts from the reports; the client's satisfaction is a client decision. */
  survey: {
    status: 'not_started' | 'received' | 'further_investigation' | 'awaiting_client' | 'client_satisfied' | 'client_renegotiating' | 'client_withdrawing';
    /** What the client told us before any report: no survey (their choice), or booked for a date. */
    plan?: { plan: 'none' | 'booked'; date: string | null; at: string } | null;
    reports: Array<{ eventId: string; documentId: string | null; surveyType: SurveyType; receivedAt: string; recommendations: number; furtherInvestigation: boolean; forIssueId: string | null; urgent?: number; legalPoints?: number; toInvestigate?: number; unread?: boolean }>;
  };
  /** Client decisions on record, by subject (the latest wins; the log has them all). */
  clientDecisions: Partial<Record<ClientDecisionSubject, { decision: string; at: string; by: Actor; note: string | null }>>;
  /** Set when the file is closed. */
  closedAt: string | null;
  // ── transaction-type workstreams (docs/transaction-types.md) ──
  propertyForms: { status: 'not_required' | 'not_started' | 'requested' | 'received'; forms: string[]; documentId: string | null; facts: PropertyFormsFacts | null };
  /** Sale: when our pack went out. Purchase: when we asked the seller's solicitor for theirs (a wait, chased on the SLA, closed by the official copies or the contract arriving). */
  contractPack: { sentAt: string | null; requestedAt?: string | null };
  /** Sale: the buyer's solicitor's enquiries on us. */
  inboundEnquiries: Record<string, InboundEnquiryState>;
  redemption: { status: 'not_required' | 'not_started' | 'requested' | 'received' | 'redeemed' | 'discharged'; lender: string | null; redemptionPennies: number | null; validUntil: string | null; documentId: string | null; redeemedAt: string | null; dischargedAt: string | null; /** Interest a day on the figure, and the day the figure is to: moving completion moves the figure. */ dailyInterestPennies?: number | null; figureDate?: string | null };
  lenderConsent: { status: 'not_required' | 'not_started' | 'requested' | 'received'; lender: string | null; receivedAt: string | null; conditions: string | null };
  deeds: { mortgageDeedAt: string | null; certificateOfTitleAt: string | null; transferDeedAt: string | null; deedOfTrustAt: string | null; /** A purchase: when the seller's signed TR1 was asked for. */ transferRequestedAt?: string | null };
  sdltNotRequiredAt: string | null;
  /** Leasehold: the LPE1 / management pack. */
  managementPack: {
    status: 'not_required' | 'not_started' | 'requested' | ReviewStatus;
    requestedAt: string | null;
    documentId: string | null;
    facts: ManagementPackFacts | null;
    decisionEventId: string | null;
  };
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
  readiness: { contractApprovedAt: string | null; signedContractHeldAt: string | null; contractDocumentId?: string | null };
  /** Steps a person marked complete by hand (manual handling), with what they said and what they filed. */
  manualSteps?: Record<string, { at: string; by: string; note: string; documentIds: string[]; skipReason?: string | null; /** The completion's event, so it can be undone; and the stage it was done in. */ eventId?: string; stage?: string }>;

  decisions: Record<string, DecisionState>;
  waits: WaitState[];
  /** Notes and call transcripts on this matter, with what the engine read in them. */
  notes: Record<string, NoteState>;
  clientUpdatesSent: number;
  /** When each client-update template last went out — so the same news is not sent twice in a day. */
  clientUpdateLastSentAt: Record<string, string>;
  /** When the client was last told about each open wait (`key:subject`). */
  clientToldAt: Record<string, string>;
  /** Who is away when (docs: context awareness). */
  availability: AvailabilityWindow[];
  /** What the client signs and how: the pack sent, wet ink or electronic per deed, envelopes out. */
  signing: { packSentAt: string | null; documents: SignedDocument[]; methods: Partial<Record<SignedDocument, SigningMethod>>; envelopes: Partial<Record<SignedDocument, { provider: string; envelopeId: string; sentAt: string }>> };
  chasesSent: number;
  /** What we have told the sender we received, so nothing is acknowledged twice. */
  acknowledgements: Array<{ forEventId: string; recipientRole: string; at: string }>;
  /** Addendum 2: every bank-details record ever put on file for this matter (versioned, never overwritten). */
  bankDetails: Record<string, BankDetailsState>;
  payments: PaymentAuthorisation[];
  /** Intents logged instead of executed (historical shadow mode). */
  suppressed: number;
  /** PROPOSE level: what the engine has asked to do, by the proposing event's id. */
  proposals: Record<string, ProposalState>;
  /** PROPOSE level: auto-clears waiting for a person, by decision event id — the clear itself, held back. */
  pendingAutoClears: Record<string, NewEvent>;
}

export interface ProposalState {
  eventId: string;
  action: EngineAction;
  /** Who, which search, which template, which sub-flow — the granular level key. */
  subject: string | null;
  detail: Record<string, unknown>;
  dedupKey: string;
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  proposedAt: string;
  /** Why an approved action could not be done. */
  failure: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
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
    requireProofOfFunds: false,
    requireExchangeAuthority: false,
    parties: 1,
    hasExistingMortgage: false,
    considerationPennies: null,
    counterpartyType: null,
    shapes: [],
    targetExchangeDate: null,
    targetCompletionDate: null,
    stage: 'instruction',
    stageHistory: [],
    lastSeq: 0,
    lastEventAt: null,
    manualHandling: { required: false, reason: null },
    idCheck: { status: 'not_started', requestedAt: null, documentId: null, decisionEventId: null },
    partyChecks: {},
    searches: {},
    enquiries: {},
    mortgage: { status: 'not_required', documentId: null, facts: null, decisionEventId: null },
    title: { status: 'awaiting', documentId: null, facts: null, decisionEventId: null, lease: null, leaseDocumentId: null },
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
    sellerForms: { receivedAt: null, forms: [], documentId: null, facts: null },
    relatedMatter: null,
    fileDelivery: 'link',
    lenderRequirements: null,
    nameAliases: [],
    preCompletion: { insuranceConfirmedAt: null, insurer: null, prioritySearchAt: null, prioritySearchExpiresAt: null, bankruptcySearchAt: null },
    partyNames: [],
    receipts: [],
    money: { requested: {}, received: {}, uncleared: [], statementBalancePennies: null, refunds: [] },
    otherCharges: [],
    undertaking: null,
    completionInformation: null,
    occupiers: [],
    sdltBasis: null,
    completion: { statementGeneratedAt: null, fundsRequestedAt: null, fundsReceivedAt: null, receivedFrom: [], confirmedAt: null },
    postCompletion: { sdltSubmittedAt: null, ap1SubmittedAt: null, ap1ConfirmedAt: null, requisitions: [], noticeOfAssignmentAt: null },
    proofOfFunds: { status: 'not_started', requestId: null, requestedAt: null, submittedAt: null, documentId: null, facts: null, decisionEventId: null, resolution: null, formUrl: null, channel: null, sendError: null, rounds: 0, flags: [], statements: [], risk: null, queries: {}, approvedAt: null, approvedBy: null },
    managementPack: { status: 'not_required', requestedAt: null, documentId: null, facts: null, decisionEventId: null },
    survey: { status: 'not_started', reports: [] },
    clientDecisions: {},
    closedAt: null,
    propertyForms: { status: 'not_required', forms: [], documentId: null, facts: null },
    contractPack: { sentAt: null },
    inboundEnquiries: {},
    redemption: { status: 'not_required', lender: null, redemptionPennies: null, validUntil: null, documentId: null, redeemedAt: null, dischargedAt: null },
    lenderConsent: { status: 'not_required', lender: null, receivedAt: null, conditions: null },
    deeds: { mortgageDeedAt: null, certificateOfTitleAt: null, transferDeedAt: null, deedOfTrustAt: null },
    sdltNotRequiredAt: null,
    abandoned: null,
    noticeToComplete: null,
    handler: null,
    corrections: 0,
    issues: {},
    purchasePricePennies: null,
    readiness: { contractApprovedAt: null, signedContractHeldAt: null },
    decisions: {},
    waits: [],
    notes: {},
    clientUpdatesSent: 0,
    clientUpdateLastSentAt: {},
    clientToldAt: {},
    availability: [],
    signing: { packSentAt: null, documents: [], methods: {}, envelopes: {} },
    chasesSent: 0,
    acknowledgements: [],
    bankDetails: {},
    payments: [],
    suppressed: 0,
    proposals: {},
    pendingAutoClears: {},
  };
}

/**
 * A persisted read-model snapshot may pre-date a field added to MatterState (it is rebuilt
 * from the log on the next event, not on deploy). Fill the gaps from the initial state so
 * readers never meet an undefined top-level field.
 */
/**
 * A snapshot written by an older build is missing whatever the machine has grown since.
 * Fill it from a fresh initial state — including the nested records, because a projection
 * that reads `state.proofOfFunds.queries` on a pre-proof-of-funds snapshot would throw.
 * A replay would produce the same thing; this just keeps cached reads honest.
 */
export function withStateDefaults(s: MatterState): MatterState {
  const init = initialState(s.tenantId, s.matterId);
  const merge = <K extends keyof MatterState>(k: K): MatterState[K] =>
    (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) ? { ...(init[k] as object), ...(s[k] as object) } : s[k] ?? init[k]) as MatterState[K];
  return {
    ...init,
    ...s,
    clientUpdateLastSentAt: { ...(s.clientUpdateLastSentAt ?? {}) },
    clientToldAt: { ...(s.clientToldAt ?? {}) },
    signing: { ...init.signing, ...(s.signing ?? {}) },
    notes: { ...(s.notes ?? {}) },
    postCompletion: merge('postCompletion'),
    proofOfFunds: merge('proofOfFunds'),
    survey: merge('survey'),
    manualHandling: merge('manualHandling'),
    idCheck: merge('idCheck'),
    mortgage: merge('mortgage'),
    title: merge('title'),
    reportOnTitle: merge('reportOnTitle'),
    deposit: merge('deposit'),
    money: merge('money'),
    exchange: merge('exchange'),
    completion: merge('completion'),
    preCompletion: merge('preCompletion'),
    sellerForms: merge('sellerForms'),
    readiness: merge('readiness'),
    managementPack: merge('managementPack'),
    propertyForms: merge('propertyForms'),
    contractPack: merge('contractPack'),
    redemption: merge('redemption'),
    lenderConsent: merge('lenderConsent'),
    deeds: merge('deeds'),
  };
}

export const isLeasehold = (s: MatterState): boolean => s.transactionType === 'leasehold_purchase' || s.transactionType === 'leasehold_sale';
/** Joint clients holding as tenants in common need a declaration of trust before completion (purchase / transfer). */
export const deedOfTrustApplies = (s: MatterState): boolean => s.parties > 1 && TENANTS_IN_COMMON.has(s.clientDecisions.ownership_basis?.decision ?? '');
export const proofOfFundsApproved = (s: MatterState): boolean => s.proofOfFunds.status === 'reviewed' && s.proofOfFunds.resolution === 'approve';
/** Queries not yet answered or withdrawn (drafted, or sent and waiting). */
export const openPofQueries = (s: MatterState): PofQuery[] => Object.values(s.proofOfFunds.queries).filter((q) => q.status === 'draft' || q.status === 'sent').sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || (a.id > b.id ? 1 : -1));

/** Nothing more will happen on this matter: registered (or closed), or abandoned. */
export const isFinished = (s: MatterState): boolean => !!s.postCompletion.ap1ConfirmedAt || !!s.abandoned || !!s.closedAt;
/** A survey has been received, so the client's satisfaction with the physical condition is a live requirement. */
export const surveyApplies = (s: MatterState): boolean => s.survey.status !== 'not_started';

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
  // At Propose the clear itself is held until a person approves it, so that review blocks; at Assist it is advisory.
  return pendingDecisions(state).filter((d) => d.kind !== 'auto_clear' || !!state.pendingAutoClears[d.eventId]);
}
/** Every pending decision is a person's to see. (Shadow mode, which hid some, is gone.) */
export function surfacedDecisions(state: MatterState): DecisionState[] {
  return pendingDecisions(state);
}

/** A pending proposal for this action and key, if any. */
export function pendingProposal(state: MatterState, action: EngineAction, dedupKey: string): ProposalState | null {
  return Object.values(state.proposals).find((p) => p.action === action && p.dedupKey === dedupKey && p.status === 'pending') ?? null;
}

/** Issues still holding the matter (open or negotiating), oldest first. */
export function openIssues(state: MatterState): IssueState[] {
  return Object.values(state.issues)
    .filter((i) => i.status === 'open' || i.status === 'negotiating')
    .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || (a.id > b.id ? 1 : -1));
}
/** Issue kinds that are context (who is running late), mirrored from issues.ts `context`: they never hold a gate. */
export const CONTEXT_ISSUE_KINDS: ReadonlySet<string> = new Set(['seller_delay', 'buyer_delay']);
/** Open issues whose gate holds the given stage exit (context never does, whatever it was raised with). */
export function issuesGating(state: MatterState, gate: IssueGate): IssueState[] {
  return openIssues(state).filter((i) => i.gate === gate && !CONTEXT_ISSUE_KINDS.has(i.kind));
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


/** The deeds our client signs on this case: the transfer when they are a party to it, the mortgage deed with a lender, the declaration when they hold as tenants in common. */
export function deedsToSign(s: MatterState): SignedDocument[] {
  const tt = s.transactionType ?? 'freehold_purchase';
  const sale = tt === 'freehold_sale' || tt === 'leasehold_sale';
  const purchase = tt === 'freehold_purchase' || tt === 'leasehold_purchase';
  const out: SignedDocument[] = [];
  // Each side signs its own part of the contract, once it is approved; it is held undated until exchange.
  if ((sale || purchase) && (s.readiness.contractApprovedAt || s.readiness.signedContractHeldAt)) out.push('contract');
  // A buyer signs the TR1 when it holds something of theirs: joint buyers declaring how they hold (panel 10). A seller always signs.
  if (sale || tt === 'transfer_of_equity' || (purchase && (s.parties ?? 1) >= 2)) out.push('transfer');
  if (s.hasLender && (purchase || tt === 'remortgage')) out.push('mortgage_deed');
  if (TENANTS_IN_COMMON.has(String(s.clientDecisions?.ownership_basis?.decision ?? ''))) out.push('deed_of_trust');
  return out;
}
/**
 * The deeds ready to go to the client now: the mortgage deed once the offer is cleared (it does not wait for the contract),
 * the contract and a purchase's TR1 once the contract is approved, a sale's TR1 once the buyer's side has approved the
 * contract, a transfer of equity's TR1 once the lender consents, the declaration of trust once the clients chose to hold
 * as tenants in common.
 */
export function deedsReadyToSign(s: MatterState): SignedDocument[] {
  const tt = s.transactionType ?? 'freehold_purchase';
  const approved = !!(s.readiness.contractApprovedAt || s.readiness.signedContractHeldAt);
  return deedsToSign(s).filter((d) =>
    d === 'mortgage_deed' ? s.mortgage.status === 'cleared' || s.mortgage.status === 'reviewed'
    : d === 'transfer' ? (tt === 'transfer_of_equity' ? s.lenderConsent.status === 'received' || s.lenderConsent.status === 'not_required' : approved)
    : d === 'deed_of_trust' ? true
    : approved);
}
/** Whether a deed on the list has been signed and recorded. */
export const deedSigned = (s: MatterState, d: SignedDocument): boolean => (d === 'contract' ? !!s.readiness.signedContractHeldAt : d === 'transfer' ? !!s.deeds.transferDeedAt : d === 'mortgage_deed' ? !!s.deeds.mortgageDeedAt : !!s.deeds.deedOfTrustAt);
