/**
 * The state machine proper: `decide(state, command) → events`.
 *
 * Pure and synchronous. It never touches a database, a clock it wasn't given, or a
 * model. Given the projected state and a command it either returns the events that
 * should be appended (in order) or throws an EngineError explaining why the command
 * is not valid right now. The store appends; the projection folds; the service does
 * the I/O around it (ports.ts) and feeds results back in as further commands.
 *
 * Invariants enforced here (the ones the spec calls out):
 *   - a flagged event always carries a DecisionSpec with a source document + citations;
 *   - a decision can only be resolved by a user who has OPENED its source (the
 *     anti-rubber-stamp friction is enforced server-side, not just in the UI);
 *   - nothing AI-drafted is `_sent` without a logged human `_approved` event;
 *   - stages advance only when every gate for the stage is resolved, and never while
 *     the matter is marked for manual handling;
 *   - every command is either automation (system/ai/external) or a human decision.
 */
import { noteTopics } from './note-topics';
import { COMPLETION_EVENTS, completionEventConsequences, completionEventProblem, type CompletionEvent } from './completion-events';
import { addWorkingDays, workingDaysBetween } from './working-days';
import { applyEvent } from './projection';
import { assertCompletion, CompletionError, type Completion } from './completion';
import type { DeadlineKind } from './sla';
import { prettyDate, validateNoteActions, summariseNoteActions, nothingToActSummary, acknowledgementSummary, replyOnlySummary, type NoteActionDraft } from './notes';
import { investigationGroups, investigationTitle } from './survey-review';
import { duplicateIssue, ISSUE_SEVERITIES, type IssueSeverity, FATAL_ABANDON_REASON_BY_GROUP, ISSUE_KIND_SPEC, LENDER_NOTIFY_RESOLUTIONS, PRICE_RESOLUTIONS, REOPENS_OFFER, RESOLUTION_LABEL, RESOLUTION_FIELDS, RESOLUTION_TITLE, FORMLESS_KINDS, type IssueGate, type IssueKind, type IssueResolution, type ReferTo } from './issues';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
import { SHAPE_SPEC, fundsFromFor, type CaseShape } from './shapes';
import { buildDecision, leaseFlags, offeredOptions, evaluateEnquiryReply, evaluateIdCheck, evaluateLease, evaluateMortgageOffer, evaluateSearch, evaluateTitle, OPTIONS_FOR, optionLabel, type Verdict } from './rules';
import { propertyFormsIssues } from './property-forms';
import { contributionsFrom, declarationQueries, evaluateProofOfFunds, FUND_SOURCE_LABEL, gbp, holderNames, riskRating, samePerson, templateBriefing, type PofQuery, type ProofOfFundsFacts, type StatementTransaction, type TransactionReview } from './proof-of-funds';
import { profileOf, type TransactionProfile } from './transactions';
import { accessGap, conditionalLongStop, offerFindings, contractFindings, leaseFindings, searchFindings, titleFindings, type Finding, type FindingContext } from './findings';
import { computeSdlt } from './sdlt';
import { sharesAtPurchase, sharesText, unequal } from './co-owners';
import { amlHoldActive, damlNoticeEnds, damlMoratoriumEnds, partyEventConsequences, sanctionsHold, SANCTIONS_PREFIX, type PartyEvent } from './people';
import { cgtFlags, chargeableConsideration, deriveSdltBasis, type CgtFacts, type SdltFacts } from './sdlt-facts';
import { completionDateProblem, staleAtCompletion } from './dates';
import { allDischarged, anythingCharged, chargesToAdd, isFinancialCharge, negativeEquity, openCharges } from './charges';
import { CLIENT_INTEREST, heldOnAbandon, interestDue, moneyOf, payersExpected, position, pounds, poundsShort, refundsDue, ROLE_LABEL } from './money';
import {
  EngineError,
  isResolved,
  isUserActor,
  stageIndex,
  STAGES,
  SYSTEM,
  AI,
  EXTERNAL,
  currentBankDetails,
  pendingBankDetailsDecision,
  maskAccount,
  VERIFICATION_METHODS,
  REJECTED_VERIFICATION_METHODS,
  type BankDetails,
  type PayeeKind,
  type SourceChannel,
  type VerificationMethod,
  type SubFlow,
  type LevelConfig,
  type SuppressedAction,
  type AbandonReason,
  ABANDON_REASONS,
  SUBFLOW_OF_KIND,
  issuesGating,
  isLeasehold,
  proofOfFundsApproved,
  openPofQueries,
  surveyApplies,
  deedOfTrustApplies,
  TENANTS_IN_COMMON,
  CLIENT_DECISION_OUTCOMES,
  type PropertyFormsFacts,
  type ClientDecisionSubject,
  type SurveyFacts,
  type SurveyType,
  ISSUE_PAID_BY,
  type IssuePaidBy,
  type IssueState,
  type ManagementPackFacts,
  type TransactionType,
  type Engagement,
  DEFAULT_LEVELS,
  levelFor,
  type EngineAction,
  type TrustLevel,
  type Actor,
  type ChaseSpec, type AcknowledgementSpec,
  type Citation,
  type CounterpartyType,
  type ClientUpdateSpec,
  type DecisionKind,
  type DecisionOption,
  type DecisionSpec,
  type DecisionState,
  type EngineEvent,
  type EnquiryReplyFacts,
  type Flag,
  type EventType,
  type IdCheckFacts,
  type MatterState,
  type MortgageOfferFacts,
  type NewEvent,
  type SearchFacts,
  type SearchType,
  type Stage,
  type TitleFacts,
  type LeaseFacts,
  type IdPartyCheck,
  partyId,
  type WaitKey,
  NOTE_KINDS,
  type NoteKind,
  type NoteSender, type NoteReply, type NoteMessage,
  type SignedDocument,
  type SigningMethod,
  SIGNED_DOCUMENTS,
  SIGNED_DOCUMENT_LABEL,
  deedSigned,
  type AvailabilityParty,
  AVAILABILITY_PARTIES,
  type ExpectationKey,
  type TitlePlanFacts,
  type SupportingDocFacts,
  openIssues,
  isManualStep,
  isReopenableStep, type ManualStepFacts, MANUAL_STEP_REQUIRED, deedsToSign, type FundsRole, type ContractFacts } from './types';

/** An optional AI-produced summary handed in by the service (component #3). The verdict is never AI's. */
export interface SummaryOverride {
  text: string;
  by: string;
}

export type Command = CommandBody & { completion?: Completion | null };

type CommandBody =
  | { type: 'enrol'; actor: Actor; transactionType?: TransactionType | null; attorneys?: string[] | null; officers?: string[] | null; executors?: string[] | null; occupiers?: string[] | null; sdlt?: { firstTimeBuyer: boolean; additionalProperty: boolean; nonUkResident: boolean; mixedUse?: boolean; linkedConsiderationPennies?: number | null } | null; requireProofOfFunds?: boolean | null; requireExchangeAuthority?: boolean | null; parties?: number | null; hasExistingMortgage?: boolean | null; considerationPennies?: number | null; hasLender: boolean; requiredSearches?: SearchType[]; targetExchangeDate?: string | null; targetCompletionDate?: string | null; counterpartyType?: CounterpartyType | null; shadowMode?: boolean; shapes?: CaseShape[] | null; partyNames?: string[] | null }
  | { type: 'mark_manual_handling'; actor: Actor; reason: string; detail?: string }
  | { type: 'resume_automation'; actor: Actor; reason: string }
  | { type: 'request_id_check'; actor: Actor; provider: string; reference?: string | null; party?: string | null; link?: string | null }
  | { type: 'id_check_result'; actor: Actor; documentId: string; facts: IdCheckFacts; summary?: SummaryOverride | null; party?: string | null }
  | { type: 'record_search_ordered'; actor: Actor; searchType: SearchType; provider: string; reference?: string | null }
  | { type: 'search_returned'; actor: Actor; searchType: SearchType; documentId: string; provider?: string | null }
  | { type: 'search_extracted'; actor: Actor; searchType: SearchType; facts: SearchFacts; extractor: string; summary?: SummaryOverride | null }
  | { type: 'raise_enquiry'; actor: Actor; enquiryId?: string | null; subject: string; origin?: { decisionEventId?: string; followUpOf?: string; issueId?: string; alsoIssueIds?: string[]; formsQuestion?: string; purpose?: string; about?: string } | null }
  | { type: 'enquiry_reply_received'; actor: Actor; enquiryId: string; documentId: string; facts?: EnquiryReplyFacts | null; summary?: SummaryOverride | null }
  | { type: 'mortgage_offer_received'; actor: Actor; documentId: string; lender?: string | null }
  | { type: 'mortgage_offer_extracted'; actor: Actor; facts: MortgageOfferFacts; extractor: string; summary?: SummaryOverride | null }
  | { type: 'title_extracted'; actor: Actor; documentId: string; facts: TitleFacts; extractor: string; summary?: SummaryOverride | null }
  | { type: 'lease_extracted'; actor: Actor; documentId: string; facts: LeaseFacts; extractor: string; summary?: SummaryOverride | null }
  | { type: 'open_decision_source'; userId: string; decisionEventId: string; documentId: string }
  | { type: 'resolve_decision'; userId: string; decisionEventId: string; option: DecisionOption; note?: string | null; verification?: { method: string; reference?: string | null; cop?: 'match' | 'close_match' | 'no_match' | 'unavailable' | null } | null; engagement?: Engagement | null; selection?: string[] | null; edited?: { subject?: string | null; body?: string | null; /** An email's task: each message as the person edited it. */ messages?: Array<{ id: string; subject?: string | null; body?: string | null }> | null } | null; /** Escalating: the person it goes to (required). */ escalateTo?: string | null }
  | { type: 'record_note'; actor: Actor; kind: NoteKind; text: string; noteId?: string | null; documentId?: string | null; durationSeconds?: number | null; from?: NoteSender | null }
  | { type: 'note_extracted'; noteId: string; drafts: NoteActionDraft[]; extractor: string; /** Filed without anyone looking (a reply on a filed conversation): put before a person even when nothing is proposed. */ surface?: boolean; /** Both checks read it as a pure acknowledgement. */ acknowledgement?: boolean; /** The reply drafted to the writer from the case. */ reply?: NoteReply | null; /** Every message the task carries (recipients.ts). */ messages?: NoteMessage[] }
  | { type: 'note_action_refused'; noteId: string; actionId: string; reason: string }
  | { type: 'record_suppressed'; action: SuppressedAction; reason: 'shadow_mode' | 'subflow_shadow'; subFlow: SubFlow | null; detail: Record<string, unknown> }
  | { type: 'set_shadow_mode'; actor: Actor; shadowMode: boolean; reason?: string | null }
  // ── eventualities (docs/engine-eventualities.md) ──
  | { type: 'abandon_matter'; actor: Actor; reason: AbandonReason; detail?: string | null }
  | { type: 'record_contract_filed'; documentId: string; points: number }
  | { type: 'raise_contract_review'; documentId: string; summary: string; citations?: Citation[]; /** What the contract read says, for the rules (findings.ts). */ terms?: (Pick<ContractFacts, 'pricePennies' | 'depositPennies' | 'depositHolder' | 'noticeToCompleteDays' | 'specialConditions'> & Partial<Omit<ContractFacts, 'pricePennies' | 'depositPennies' | 'depositHolder' | 'noticeToCompleteDays' | 'specialConditions' | 'completionDate' | 'chattelsPricePennies' | 'fixturesListPresent'>> & { completionDate?: string | null; chattelsPricePennies?: number | null; fixturesListPresent?: boolean | null }) | null }
  | { type: 'set_clients'; actor: Actor; names: string[]; reason?: string | null }
  | { type: 'set_target_dates'; actor: Actor; targetExchangeDate?: string | null; targetCompletionDate?: string | null; reason?: string | null }
  | { type: 'change_completion_date'; actor: Actor; completionDate: string; reason?: string | null }
  | { type: 'set_signing_method'; actor: Actor; document: SignedDocument; method: SigningMethod; reason?: string | null }
  | { type: 'record_signing_pack_sent'; documents: SignedDocument[]; methods: Partial<Record<SignedDocument, SigningMethod>>; attached: string[]; channel: string; messageId: string | null }
  | { type: 'record_signing_envelope'; document: SignedDocument; provider: string; envelopeId: string }
  | { type: 'record_availability'; actor: Actor; party: AvailabilityParty; from: string; until: string; note?: string | null }
  | { type: 'record_client_progress'; actor: Actor; waitKey: WaitKey; subject: string; claim: string; expectBy?: string | null; noteId?: string | null }
  | { type: 'set_file_delivery'; actor: Actor; mode: 'attachments' | 'link'; reason?: string | null; noteId?: string | null }
  | { type: 'record_chain_consent'; actor: Actor; given: boolean; reason?: string | null; noteId?: string | null }
  | { type: 'open_expectation'; key: ExpectationKey }
  | { type: 'record_title_plan'; documentId: string; facts: TitlePlanFacts }
  | { type: 'record_supporting_document'; documentId: string; facts: SupportingDocFacts }
  | { type: 'set_funding'; actor: Actor; hasLender: boolean; reason: string }
  | { type: 'record_survey_plan'; actor: Actor; plan: 'none' | 'booked'; date?: string | null; note?: string | null }
  | { type: 'notice_to_complete_served'; actor: Actor; servedBy: 'buyer' | 'seller'; servedAt?: string | null; expiresAt: string; documentId: string }
  | { type: 'mortgage_offer_withdrawn'; actor: Actor; reason: string; lender?: string | null }
  | { type: 'withdraw_enquiry'; actor: Actor; enquiryId: string; reason: string }
  | { type: 'hmlr_requisition_received'; actor: Actor; documentId: string; reference?: string | null; deadline?: string | null; summary?: SummaryOverride | null; text?: string | null }
  | { type: 'record_correction'; actor: Actor; aboutEventId: string; reason: string }
  | { type: 'record_handler_change'; actor: Actor; fromUserId: string | null; toUserId: string; reason?: string | null }
  | { type: 'raise_deadline_escalation'; kind: DeadlineKind; dueDate: string; subject: string; summary: string; sourceDocumentId: string }
  // ── issues (docs/engine-issues.md) ──
  | { type: 'raise_issue'; actor: Actor; issueId?: string | null; kind: IssueKind; title: string; detail?: string | null; gate?: IssueGate | null; documentId?: string | null; party?: string | null; severity?: IssueSeverity | null; causedBy?: string | null; resolveBy?: string | null }
  | { type: 'set_issue_severity'; actor: Actor; issueId: string; severity: IssueSeverity; reason: string }
  // ── case model: survey workstream, client decisions, closure ──
  | { type: 'survey_received'; actor: Actor; documentId: string; surveyType: SurveyType; facts: SurveyFacts; extractor: string }
  | { type: 'specialist_report_received'; actor: Actor; documentId: string; facts: SurveyFacts; forIssueId?: string | null; extractor: string }
  | { type: 'client_decision_recorded'; actor: Actor; subject: ClientDecisionSubject; decision: string; party?: string | null; note?: string | null; evidenceDocumentId?: string | null; approvedEventId?: string | null; scope?: string[] | null }
  | { type: 'close_matter'; actor: Actor; reason?: string | null }
  | { type: 'update_issue'; actor: Actor; issueId: string; status: 'open' | 'negotiating'; note?: string | null; gate?: IssueGate | null; party?: string | null; resolveBy?: string | null; referredTo?: ReferTo | null }
  | { type: 'resolve_issue'; actor: Actor; issueId: string; resolution: IssueResolution; note?: string | null; newPricePennies?: number | null; costPennies?: number | null; paidBy?: IssuePaidBy | null; details?: Record<string, string | number | boolean | null> | null; documentId?: string | null }
  // ── proof of funds (docs/proof-of-funds.md) ──
  | { type: 'request_proof_of_funds'; actor: Actor; requestId: string; channel: string; messageId?: string | null; to?: string | null; formUrl?: string | null; sendError?: string | null; followUpOf?: string | null; noteToClient?: string | null; queryIds?: string[] }
  | { type: 'proof_of_funds_submitted'; actor: Actor; requestId: string; documentId: string; facts: ProofOfFundsFacts; review?: TransactionReview | null; answers?: Array<{ queryId: string; answer: string; evidenceDocumentIds: string[] }> | null; summary?: SummaryOverride | null }
  | { type: 'raise_proof_of_funds_query'; actor: Actor; question: string; documentId?: string | null; transaction?: StatementTransaction | null }
  | { type: 'withdraw_proof_of_funds_query'; actor: Actor; queryId: string; reason: string }
  // ── leasehold ──
  | { type: 'management_pack_requested'; actor: Actor; from: string; reference?: string | null }
  | { type: 'management_pack_received'; actor: Actor; documentId: string; facts?: ManagementPackFacts | null; summary?: SummaryOverride | null }
  | { type: 'notice_of_assignment_served'; actor: Actor; servedOn: string; reference?: string | null }
  | { type: 'withdraw_issue'; actor: Actor; issueId: string; reason: string }
  | { type: 'mark_issue_fatal'; actor: Actor; issueId: string; reason: string; abandonReason?: AbandonReason | null }
  | { type: 'record_price_change'; actor: Actor; toPennies: number; reason: string }
  | { type: 'contract_approved'; actor: Actor; note?: string | null }
  | { type: 'signed_contract_held'; actor: Actor; note?: string | null }
  // Addendum 2 — payment verification
  | { type: 'record_bank_details'; actor: Actor; bankDetailsId: string; payeeKind: PayeeKind; payeeRef?: string | null; details: BankDetails; sourceChannel: SourceChannel; sourceDocumentId: string }
  | { type: 'payment_authorised'; actor: Actor; payeeKind: PayeeKind; bankDetailsId: string; amountPennies?: number | null; purpose: 'completion_monies' | 'deposit' | 'other' }
  | { type: 'draft_report_on_title'; draftId: string; draftDocumentId: string; model: string; summary: string; citations: Citation[]; basedOn?: string[] }
  | { type: 'record_report_on_title_sent'; actor: Actor; draftId: string; channel: string; messageId?: string | null }
  | { type: 'deposit_received'; actor: Actor; amountPennies?: number | null; /** Filled by the service from the contract read. */ contractDepositPennies?: number | null }
  | { type: 'contracts_exchanged'; actor: Actor; completionDate: string; exchangedAt?: string | null; formula?: string | null; spokeWith?: string | null; depositRoute?: 'held_by_us' | 'sent_to_seller_solicitor' | 'up_the_chain' | null }
  | { type: 'completion_statement_generated'; actor: Actor; documentId?: string | null; balancePennies?: number | null }
  | { type: 'funds_requested'; actor: Actor; fromRole: 'lender' | 'client' | 'isa_provider'; amountPennies?: number | null; bankDetailsId: string }
  | { type: 'funds_received'; actor: Actor; fromRole: 'lender' | 'client' | 'buyer_solicitor' | 'incoming_owner' | 'isa_provider'; amountPennies?: number | null; remitter?: string | null; uncleared?: boolean; /** Filled by the service from the contract read (a sale's expected money). */ contractPricePennies?: number | null; contractDepositPennies?: number | null }
  | { type: 'funds_cleared'; actor: Actor; receiptId: string }
  | { type: 'record_other_charge'; actor: Actor; chargee: string; text?: string | null }
  | { type: 'longstop_date_recorded'; actor: Actor; date: string }
  | { type: 'record_party_event'; actor: Actor; event: PartyEvent; party: string; hasAttorney?: boolean | null; note?: string | null }
  | { type: 'sar_made'; actor: Actor; note?: string | null }
  | { type: 'add_shape'; actor: Actor; shape: string }
  | { type: 'record_client_names'; actor: Actor; names: string[] }
  | { type: 'record_completion_event'; actor: Actor; event: CompletionEvent; detail: string; amountPennies?: number | null; until?: string | null }
  | { type: 'record_isa'; actor: Actor; isa: 'lifetime_isa' | 'help_to_buy_isa'; openedOn?: string | null; closedOn?: string | null }
  | { type: 'record_chain_link'; actor: Actor; linkId?: string | null; label: string; status: 'ready' | 'not_ready' | 'unknown' | 'removed'; note?: string | null }
  | { type: 'completion_payment_sent'; actor: Actor; reference: string; sentAt?: string | null }
  | { type: 'final_bill_delivered'; actor: Actor; amountPennies: number; documentId?: string | null; balanceLeftPennies?: number | null }
  | { type: 'formula_c_release_given'; actor: Actor; until: string; givenTo: string }
  | { type: 'formula_c_release_lapsed'; actor: Actor; reason: string }
  | { type: 'record_deal_event'; actor: Actor; event: 'contract_race' | 'lockout' | 'reservation' | 'renegotiated' | 'sitting_tenant' | 'nominee' | 'buy_out' | 'incentive' | 'deposit_direct'; detail: string; until?: string | null; amountPennies?: number | null }
  | { type: 'record_property_event'; actor: Actor; event: 'damaged' | 'not_vacant' | 'early_access' | 'seller_stays' | 'boundary_mismatch' | 'adverse_possession' | 'deeds_lost' | 'land_charge_entry' | 'searches_declined'; detail: string }
  | { type: 'retention_released'; actor: Actor; amountPennies?: number | null }
  | { type: 'record_contributions'; actor: Actor; model: 'FIXED' | 'RING_FENCE' | 'CONTRIBUTION' | 'FLOATING'; contributions: Array<{ party: string; pennies: number }>; ratioPercent?: Record<string, number> | null }
  | { type: 'ap1_cancelled'; actor: Actor; reason: string }
  | { type: 'requisition_extended'; actor: Actor; requisitionEventId: string; deadline: string; note: string }
  | { type: 'register_checked'; actor: Actor; wrong?: boolean | null; note?: string | null; lenderTold?: boolean | null }
  | { type: 'seller_discharge_received'; actor: Actor; reference?: string | null; documentId?: string | null }
  | { type: 'daml_response'; actor: Actor; decision: 'granted' | 'refused'; note?: string | null }
  | ({ type: 'record_sdlt_facts'; actor: Actor } & SdltFacts)
  | ({ type: 'record_cgt_facts'; actor: Actor } & CgtFacts)
  | { type: 'charge_statement_received'; actor: Actor; chargeId: string; redemptionPennies: number; validUntil?: string | null; documentId?: string | null }
  | { type: 'charge_redeemed'; actor: Actor; chargeId: string; amountPennies?: number | null }
  | { type: 'charge_discharged'; actor: Actor; chargeId: string; reference?: string | null; documentId?: string | null }
  | { type: 'undertaking_given'; actor: Actor; to: string; terms: string }
  | { type: 'undertaking_discharged'; actor: Actor; note?: string | null }
  | { type: 'completion_information_received'; actor: Actor; undertakingToRedeem?: boolean | null; documentId?: string | null; chargesCovered?: string[] | null }
  | { type: 'refund_paid'; actor: Actor; refundId: string; reference: string }
  // ── transaction types (docs/transaction-types.md) ──
  | { type: 'request_property_forms'; actor: Actor; forms?: string[] | null }
  | { type: 'property_forms_received'; actor: Actor; forms: string[]; documentId?: string | null; facts?: PropertyFormsFacts | null }
  | { type: 'contract_pack_sent'; actor: Actor; includes?: string[] | null; channel?: string | null; messageId?: string | null }
  | { type: 'buyer_enquiries_received'; actor: Actor; enquiries: Array<{ id?: string | null; question: string }>; documentId?: string | null }
  | { type: 'enquiry_replies_sent'; actor: Actor; enquiryIds: string[]; documentId?: string | null; channel?: string | null; messageId?: string | null }
  | { type: 'request_redemption_statement'; actor: Actor; lender?: string | null }
  | { type: 'redemption_statement_received'; actor: Actor; lender?: string | null; redemptionPennies?: number | null; validUntil?: string | null; dailyInterestPennies?: number | null; documentId?: string | null }
  | { type: 'mortgage_redeemed'; actor: Actor; lender?: string | null; amountPennies?: number | null }
  | { type: 'discharge_confirmed'; actor: Actor; lender?: string | null; reference?: string | null }
  | { type: 'mortgage_deed_executed'; actor: Actor; lender?: string | null; witnessed?: boolean }
  | { type: 'certificate_of_title_sent'; actor: Actor; lender?: string | null; completionDate?: string | null }
  | { type: 'add_party'; actor: Actor; name: string; role: IdPartyCheck['role'] }
  | { type: 'seller_forms_received'; actor: Actor; documentId: string; forms?: string[] | null; facts: PropertyFormsFacts | null }
  | { type: 'link_related_matter'; actor: Actor; relatedMatterId: string; relation: 'sale' | 'purchase'; note?: string | null }
  | { type: 'unlink_related_matter'; actor: Actor; reason: string }
  | { type: 'complete_step_manually'; actor: Actor; step: string; note: string; documentIds?: string[]; facts?: ManualStepFacts | null; skipReason?: string | null }
  | { type: 'undo_manual_step'; actor: Actor; step: string; reason: string }
  | { type: 'reopen_step'; actor: Actor; step: string; reason: string }
  | { type: 'record_lender_requirements'; actor: Actor; minUnexpiredYears?: number | null; maxSearchAgeMonths?: number | null; acceptsNonFamilyGift?: boolean | null; acceptsLoanDeposit?: boolean | null; acceptsDonorAbroad?: boolean | null; requiresEws1?: boolean | null; note?: string | null }
  | { type: 'name_change_evidenced'; actor: Actor; party?: string | null; from: string; to: string; reason: string; documentId?: string | null }
  | { type: 'client_account_receipt'; actor: Actor; remitter: string; amountPennies?: number | null; purpose: 'fees' | 'deposit' | 'completion' | 'other'; reference?: string | null }
  | { type: 'buildings_insurance_confirmed'; actor: Actor; insurer?: string | null; fromDate?: string | null; documentId?: string | null; insuredNames?: string[] | null; lenderNoted?: boolean | null }
  | { type: 'priority_search_made'; actor: Actor; expiresAt: string; documentId?: string | null; titleNumber?: string | null; applicants?: string[] | null; newEntries?: string | null }
  | { type: 'bankruptcy_search_clear'; actor: Actor; subjects?: string[] | null; documentId?: string | null }
  | { type: 'bankruptcy_search_entry'; actor: Actor; subject: string; entry: string; documentId?: string | null }
  | { type: 'request_lender_consent'; actor: Actor; lender?: string | null }
  | { type: 'lender_consent_received'; actor: Actor; lender?: string | null; conditions?: string | null }
  | { type: 'transfer_deed_executed'; actor: Actor; parties: string[]; witnessed?: boolean }
  | { type: 'deed_of_trust_executed'; actor: Actor; parties: string[]; shares?: string | null; documentId?: string | null }
  | { type: 'sdlt_not_required'; actor: Actor; reason: string }
  | { type: 'completion_confirmed'; actor: Actor; completedAt?: string | null }
  | { type: 'sdlt_submitted'; actor: Actor; reference?: string | null; amountPennies?: number | null; paidOn?: string | null }
  | { type: 'sdlt_amended'; actor: Actor; newAmountPennies: number; reason: string }
  | { type: 'ap1_submitted'; actor: Actor; reference?: string | null }
  | { type: 'ap1_confirmed'; actor: Actor; titleNumber?: string | null }
  | { type: 'record_chase'; chase: ChaseSpec }
  | { type: 'record_acknowledgement'; ack: AcknowledgementSpec }
  | { type: 'record_request_sent'; request: { recipientRole: string; template: string; channel: string; messageId?: string | null } }
  | { type: 'raise_escalation'; waitKey: WaitKey; subject: string; reason: string; sourceDocumentId: string; summary?: SummaryOverride | null }
  | { type: 'record_client_update'; update: ClientUpdateSpec }
  /** PROPOSE level: the service asks before acting. `sourceDocumentId` is the generated dossier the person reads. */
  | { type: 'withdraw_proposal'; proposalEventId: string; reason: string }
  | { type: 'propose_action'; action: EngineAction; subject?: string | null; detail: Record<string, unknown>; dedupKey: string; summary: string; sourceDocumentId: string }
  | { type: 'record_action_failed'; proposalEventId: string; action: EngineAction; detail: Record<string, unknown>; reason: string }
  | { type: 'record_action_retried'; actor: Actor; proposalEventId: string; action: EngineAction };

export type CommandType = CommandBody['type'];

/** Commands a human may issue from the dashboard/API. Everything else is automation-only. */
export const USER_COMMANDS: ReadonlyArray<CommandType> = [
  'enrol',
  'mark_manual_handling',
  'resume_automation',
  'request_id_check',
  'raise_enquiry',
  'open_decision_source',
  'resolve_decision',
  'record_note',
  'deposit_received',
  'contracts_exchanged',
  'completion_statement_generated',
  'record_bank_details',
  'payment_authorised',
  'funds_requested',
  'funds_received',
  'funds_cleared',
  'refund_paid',
  'record_other_charge',
  'longstop_date_recorded',
  'record_party_event',
  'sar_made',
  'daml_response',
  'record_contributions',
  'completion_payment_sent',
  'final_bill_delivered',
  'formula_c_release_given',
  'formula_c_release_lapsed',
  'record_property_event',
  'record_deal_event',
  'add_shape',
  'record_isa',
  'record_client_names',
  'sdlt_amended',
  'record_completion_event',
  'bankruptcy_search_entry',
  'record_chain_link',
  'retention_released',
  'ap1_cancelled',
  'requisition_extended',
  'register_checked',
  'seller_discharge_received',
  'record_sdlt_facts',
  'record_cgt_facts',
  'charge_statement_received',
  'charge_redeemed',
  'charge_discharged',
  'undertaking_given',
  'undertaking_discharged',
  'completion_information_received',
  'completion_confirmed',
  'sdlt_submitted',
  'ap1_submitted',
  'ap1_confirmed',
  // Manual fallbacks for when an integration is down (spec #4: never let a stuck API stall a matter).
  'record_search_ordered',
  'search_returned',
  'mortgage_offer_received',
  // Eventualities a conveyancer records as they happen.
  'abandon_matter',
  'set_target_dates',
  'set_clients',
  'change_completion_date',
  'record_availability',
  'record_client_progress',
  'set_file_delivery',
  'record_chain_consent',
  'record_survey_plan',
  'set_funding',
  'set_signing_method',
  'notice_to_complete_served',
  'mortgage_offer_withdrawn',
  'withdraw_enquiry',
  'hmlr_requisition_received',
  'record_correction',
  'record_handler_change',
  // Issues: the things that go wrong, recorded by the person dealing with them.
  'raise_issue',
  'update_issue',
  'resolve_issue',
  'withdraw_issue',
  'mark_issue_fatal',
  'record_price_change',
  'contract_approved',
  'signed_contract_held',
  // Proof of funds (the send itself is a service step, like request_id_check) and leasehold steps.
  'set_issue_severity',
  'client_decision_recorded',
  'close_matter',
  'request_property_forms',
  'property_forms_received',
  'contract_pack_sent',
  'buyer_enquiries_received',
  'enquiry_replies_sent',
  'request_redemption_statement',
  'redemption_statement_received',
  'mortgage_redeemed',
  'discharge_confirmed',
  'mortgage_deed_executed',
  'certificate_of_title_sent',
  'add_party',
  'seller_forms_received',
  'link_related_matter',
  'unlink_related_matter',
  'complete_step_manually',
  'undo_manual_step',
  'reopen_step',
  'record_lender_requirements',
  'name_change_evidenced',
  'client_account_receipt',
  'buildings_insurance_confirmed',
  'priority_search_made',
  'bankruptcy_search_clear',
  'request_lender_consent',
  'lender_consent_received',
  'transfer_deed_executed',
  'deed_of_trust_executed',
  'sdlt_not_required',
  'request_proof_of_funds',
  'raise_proof_of_funds_query',
  'withdraw_proof_of_funds_query',
  'management_pack_requested',
  'management_pack_received',
  'notice_of_assignment_served',
];

const isPurchase = (s: MatterState): boolean => s.transactionType === 'freehold_purchase' || s.transactionType === 'leasehold_purchase';

/**
 * Whether the timer should open this expectation: the mortgage offer on a purchase with a lender
 * (never for a cash buyer) until it arrives; the survey on a purchase until a report arrives or
 * the client says they are not having one. Neither once exchanged, closed or abandoned.
 */
export function expectationDue(s: MatterState, key: ExpectationKey): boolean {
  // The new offer on a remortgage is the client's to chase as much as a buyer's.
  if (!s.enrolled || !(isPurchase(s) || (key === 'mortgage_offer' && s.transactionType === 'remortgage')) || s.exchange.exchangedAt || s.completion.confirmedAt || s.abandoned || s.closedAt) return false;
  if (s.waits.some((w) => w.key === key && w.closedAt === null)) return false;
  if (key === 'mortgage_offer') return !!s.hasLender && s.mortgage.status === 'awaiting' && !s.mortgage.documentId;
  return s.survey.status === 'not_started' && !s.survey.reports.length && s.survey.plan?.plan !== 'none';
}

export interface DecideContext {
  now: Date;
  /** Trust level per engine action (tenant config). Defaults to propose. Only auto_clear matters inside the machine. */
  levels?: LevelConfig;
}

export interface Decision {
  events: NewEvent[];
  /** State after the events (provisionally applied) — handy for callers, not persisted. */
  state: MatterState;
}

// ───────────────────────────── helpers ─────────────────────────────

// A function declaration (not a const arrow) so TypeScript treats calls as assertions and narrows after them.
function reject(msg: string, status = 409): never {
  throw new EngineError(msg, status);
}

const requireEnrolled = (s: MatterState): void => {
  if (!s.enrolled) reject('Matter is not enrolled in the engine. Enrol it first.');
  if (s.abandoned) reject(`Matter was abandoned on ${s.abandoned.at.slice(0, 10)} (${s.abandoned.reason.replace(/_/g, ' ')}); nothing further can be recorded except a correction.`, 409);
  if (s.closedAt) reject(`Matter was closed on ${s.closedAt.slice(0, 10)}; nothing further can be recorded except a correction.`, 409);
};
/** Commands that may still be recorded after abandonment (audit only). */
const requireEnrolledEvenIfAbandoned = (s: MatterState): void => {
  if (!s.enrolled) reject('Matter is not enrolled in the engine. Enrol it first.');
};

const profile = (s: MatterState): TransactionProfile => profileOf(s.transactionType);
const requireSide = (s: MatterState, sides: Array<TransactionProfile['side']>, what: string): void => {
  const p = profile(s);
  if (!sides.includes(p.side)) reject(`${what} does not apply to a ${p.label.toLowerCase()}.`);
};
const requireType = (s: MatterState, types: TransactionType[], what: string): void => {
  if (!types.includes(s.transactionType ?? 'freehold_purchase')) reject(`${what} does not apply to a ${profile(s).label.toLowerCase()}.`);
};
/** A stage this type passes through; "at least" is measured along the profile's own stage list. */
const stageAtLeast = (s: MatterState, stage: Stage): boolean => {
  const list = profile(s).stages;
  const cur = list.indexOf(s.stage);
  const want = list.indexOf(stage);
  return want === -1 ? stageIndex(s.stage) >= stageIndex(stage) : cur >= want;
};

const requireStageAtLeast = (s: MatterState, stage: Stage, what: string): void => {
  if (!stageAtLeast(s, stage)) reject(`${what} comes at the ${stage.replace(/_/g, ' ')} stage in this system's process; this case is at ${s.stage.replace(/_/g, ' ')}.`);
};

const requireStage = (s: MatterState, stage: Stage, what: string): void => {
  if (s.stage !== stage) reject(`${what} is only valid at stage "${stage}" (matter is at "${s.stage}").`);
};

/** Provisionally apply proposed events so follow-on checks (stage gates) see them. */
export function applyNew(state: MatterState, events: NewEvent[], now: Date): MatterState {
  let s = state;
  events.forEach((ev, i) => {
    const seq = state.lastSeq + i + 1;
    const provisional: EngineEvent = { ...ev, id: `pending:${seq}`, tenantId: state.tenantId, matterId: state.matterId, seq, createdAt: now.toISOString() } as EngineEvent;
    s = applyEvent(s, provisional);
  });
  return s;
}

/** Validate a DecisionSpec before it is written — the "every decision points at its source" rule. */
export function assertDecisionSpec(d: DecisionSpec): void {
  if (!d.sourceDocumentId) reject('A decision event must reference a source document.', 500);
  if (!d.summary?.trim()) reject('A decision event must carry a summary.', 500);
  if (!d.citations?.length) reject('A decision summary must cite its source.', 500);
  if (d.citations.some((c) => !c.documentId)) reject('Every citation must name a document.', 500);
  if (!d.options?.length) reject('A decision must offer at least one option.', 500);
}

// ───────────────────────────── stage gates ─────────────────────────────

/** Why the matter cannot leave its current stage yet (empty = it can). Exported for the dashboard. */
/** Nobody exchanges without an approved contract and our own client's signed part on file. */
const contractReady = (s: MatterState): boolean => !!s.readiness.contractApprovedAt && !!s.readiness.signedContractHeldAt;

/** The lender's pre-completion checks (Lenders' Handbook Part 1): a clear bankruptcy search against every borrower, a live priority search, buildings insurance. */
export function lenderChecksUnmet(s: MatterState, now: Date): string[] {
  const out: string[] = [];
  if (!s.preCompletion.bankruptcySearchAt) out.push('The bankruptcy search (K16) against every borrower has not been recorded as clear; the lender requires it before completion.');
  if (!s.preCompletion.prioritySearchAt) out.push('No priority search (OS1) has been made; the lender requires completion inside the priority period.');
  else if (s.preCompletion.prioritySearchExpiresAt && Date.parse(s.preCompletion.prioritySearchExpiresAt) < now.getTime() - 86_400_000) out.push(`The priority period of the OS1 expired on ${s.preCompletion.prioritySearchExpiresAt}; make a fresh priority search.`);
  if (!s.preCompletion.insuranceConfirmedAt) out.push('Buildings insurance has not been confirmed; the lender requires cover on its terms.');
  return out;
}

/** What must be true before a certificate of title can be given unqualified (and the advance requested against it). */
/** The K16 does not cover every borrower, or is too old to rely on (it protects for 15 working days). */
export function k16Stale(s: MatterState, now: Date): boolean {
  const at = s.preCompletion.bankruptcySearchAt;
  if (!at) return false;
  const subjects = s.preCompletion.bankruptcySubjects ?? null;
  if (subjects && (s.partyNames ?? []).some((n) => !samePerson(n, subjects))) return true;
  return workingDaysBetween(new Date(at), now) > 15;
}

export function certificateOfTitleUnmet(s: MatterState, now: Date): string[] {
  const out: string[] = [];
  if (!s.deeds.mortgageDeedAt) out.push('the mortgage deed signed, witnessed and held');
  if (!s.preCompletion.bankruptcySearchAt) out.push('a clear bankruptcy search (K16) against every borrower');
  else if (k16Stale(s, now)) out.push('a fresh bankruptcy search (K16): the last is over 15 working days old or does not name every borrower');
  // Nothing the lender must approve, no offer condition and no entry against a borrower may be open (completion.md 1.8, 1.15).
  const lenderOpen = Object.values(s.issues).filter((i) => (i.kind === 'lender_approval' || i.kind === 'mortgage_condition_outstanding' || i.kind === 'bankruptcy_insolvency') && (i.status === 'open' || i.status === 'negotiating'));
  if (lenderOpen.length) out.push(`these settled first: ${lenderOpen.map((i) => i.title).join('; ')}`);
  if (!s.preCompletion.prioritySearchAt || (s.preCompletion.prioritySearchExpiresAt && Date.parse(s.preCompletion.prioritySearchExpiresAt) < now.getTime() - 86_400_000)) out.push('a live priority search (OS1)');
  if (!s.preCompletion.insuranceConfirmedAt) out.push('buildings insurance confirmed');
  // On a purchase the lender relies on the buyer's own money being with us: the certificate confirms it.
  if (profile(s).side === 'buyer' && !(s.completion.receivedFrom ?? []).some((r) => r === 'client' || r === 'isa_provider')) out.push("the client's balance received");
  return out;
}

export function stageBlockers(s: MatterState): string[] {
  if (!s.enrolled) return ['not enrolled'];
  if (s.abandoned) return [`matter abandoned (${s.abandoned.reason.replace(/_/g, ' ')})`];
  if (s.closedAt) return ['matter closed'];
  // Manual handling pauses the automation, not the case: the person records what is done (marking steps
  // complete by hand) and the stages move on those facts like any other.
  const p = profile(s);
  if (p.side === 'seller') return saleBlockers(s);
  if (p.side === 'owner') return ownerBlockers(s, p);
  const b: string[] = [];
  switch (s.stage) {
    case 'instruction':
      if (!isResolved(s.idCheck.status)) b.push(`ID/AML check ${s.idCheck.status.replace('_', ' ')}`);
      for (const pc of Object.values(s.partyChecks)) if (pc.role !== 'donor' && !isResolved(pc.status)) b.push(`ID/AML check for ${pc.label} ${pc.status.replace(/_/g, ' ')}`);
      break;
    case 'pre_contract':
      b.push(...unresolvedSearches(s, true));
      if (isLeasehold(s) && !isResolved(s.managementPack.status)) b.push(`management pack ${s.managementPack.status === 'not_started' ? 'not requested' : s.managementPack.status === 'requested' ? 'awaiting' : 'under review'}`);
      for (const q of Object.values(s.enquiries)) if (!isResolved(q.status)) b.push(`enquiry ${q.enquiryId} ${q.status}`);
      if (s.hasLender && !isResolved(s.mortgage.status)) b.push(`mortgage offer ${s.mortgage.status}`);
      break;
    case 'contract_review':
      // A search re-ordered after pre_contract (re-issued result, lender freshness rule) gates again.
      b.push(...unresolvedSearches(s, false));
      if (!isResolved(s.title.status)) b.push(`title ${s.title.status}`);
      if (s.reportOnTitle.status !== 'sent') b.push(`report on title ${s.reportOnTitle.status.replace('_', ' ')}`);
      // Anything raised during review (a further enquiry off a title flag) must come back too.
      for (const q of Object.values(s.enquiries)) if (!isResolved(q.status)) b.push(`enquiry ${q.enquiryId} ${q.status}`);
      break;
    case 'pre_exchange':
      b.push(...unresolvedSearches(s, false));
      if (s.hasLender && !isResolved(s.mortgage.status)) b.push(`mortgage offer ${s.mortgage.status} (withdrawn or awaiting re-issue)`);
      b.push(...issueBlockers(s, 'exchange'));
      if (proofOfFundsHolds(s)) b.push(`proof of funds ${proofOfFundsHoldReason(s)}`);
      if (surveyPending(s)) b.push('survey booked by the client, report not back');
      if (surveyHolds(s)) b.push(`survey: client not yet ${s.survey.status === 'further_investigation' ? 'able to decide — further investigation outstanding' : s.survey.status === 'client_renegotiating' ? 'satisfied — renegotiating' : 'confirmed satisfied with the physical condition'}`);
      if (!s.readiness.contractApprovedAt) b.push(s.readiness.contractDocumentId ? 'contract not yet approved' : "draft contract not yet received from the seller's solicitor");
      else if (!s.readiness.signedContractHeldAt) b.push("our client's signed contract not on file");
      if (!s.deposit.received) b.push('deposit not received');
      if (exchangeAuthorityHolds(s)) b.push('client has not yet authorised exchange');
      if (!s.exchange.exchangedAt) b.push(s.exchange.conditionsMet ? 'contracts not yet exchanged' : 'exchange conditions not met');
      break;
    case 'exchanged':
      if (!s.completion.statementGeneratedAt) b.push('completion statement not generated');
      break;
    case 'pre_completion':
      if (!s.completion.confirmedAt) {
        b.push(...issueBlockers(s, 'completion'));
        if (!s.deeds.transferDeedAt) b.push('transfer deed not executed');
        if (s.parties > 1 && !s.clientDecisions.ownership_basis) b.push('basis of co-ownership not yet decided by the clients');
        if (deedOfTrustApplies(s) && !s.deeds.deedOfTrustAt) b.push('declaration of trust not executed (tenants in common)');
        if (s.hasLender && !s.deeds.mortgageDeedAt) b.push('mortgage deed not executed');
        if (s.hasLender && !s.deeds.certificateOfTitleAt) b.push('certificate of title not sent');
        if (s.hasLender && !s.preCompletion.bankruptcySearchAt) b.push('bankruptcy search (K16) not recorded');
        if (!s.preCompletion.prioritySearchAt) b.push('priority search (OS1) not made');
        if (s.hasLender && !s.preCompletion.insuranceConfirmedAt) b.push('buildings insurance not confirmed');
        if (s.hasLender && !(s.completion.receivedFrom ?? []).includes('lender')) b.push('mortgage advance not received');
        if (!(s.completion.receivedFrom ?? []).some((r) => r === 'client' || r === 'isa_provider')) b.push("client's balance not received");
        if (!s.payments.some((p) => p.payeeKind === 'seller_solicitor' && p.purpose === 'completion_monies')) b.push('completion payment not authorised against verified bank details');
        if (pendingBankDetailsDecision(s, 'seller_solicitor')) b.push('bank-details change awaiting out-of-band verification (hard stop)');
        if (s.payments.some((p) => p.payeeKind === 'seller_solicitor' && p.purpose === 'completion_monies') && !s.completion.paymentSent) b.push('completion money not yet recorded as sent (CHAPS reference)');
        if (!s.completionInformation) b.push("seller's completion information (TA13) not received");
        else if (sellerTitleCharged(s) && !s.completionInformation.undertakingToRedeem) b.push("no undertaking from the seller's solicitor to redeem their charges");
        if (s.completion.fundsReceivedAt && s.payments.length) b.push('completion not confirmed');
      }
      break;
    case 'completed':
      if (!s.postCompletion.sdltSubmittedAt && !s.sdltNotRequiredAt) b.push('SDLT return not filed (or recorded as not required)');
      if (!s.postCompletion.ap1SubmittedAt) b.push('AP1 not submitted');
      break;
    case 'post_completion':
      if (s.postCompletion.requisitions.some((r) => !r.respondedAt)) b.push('HMLR requisition outstanding');
      b.push(...afterRegistration(s));
      break;
  }
  return b;
}

/**
 * Proof of funds holds exchange when a round is in flight (sent, or submitted and not signed
 * off) — money cannot move on an unverified source — and, where the firm's policy requires it
 * (requireProofOfFunds), until it has been signed off at all.
 */
const proofOfFundsHolds = (s: MatterState): boolean => s.proofOfFunds.status === 'requested' || s.proofOfFunds.status === 'submitted' || (s.requireProofOfFunds && !proofOfFundsApproved(s));
/** Sale side (docs/transaction-types.md): forms in, pack out, the buyer's enquiries answered, the mortgage redeemed and discharged. */
function saleBlockers(s: MatterState): string[] {
  const b: string[] = [];
  switch (s.stage) {
    case 'instruction':
      if (!isResolved(s.idCheck.status)) b.push(`ID/AML check ${s.idCheck.status.replace('_', ' ')}`);
      for (const pc of Object.values(s.partyChecks)) if (pc.role !== 'donor' && !isResolved(pc.status)) b.push(`ID/AML check for ${pc.label} ${pc.status.replace(/_/g, ' ')}`);
      break;
    case 'pre_contract':
      if (s.propertyForms.status !== 'received') b.push(`property forms ${s.propertyForms.status === 'requested' ? 'awaited from the client' : 'not requested'}`);
      if (!isResolved(s.title.status)) b.push(`title ${s.title.status}`);
      if (isLeasehold(s) && !isResolved(s.managementPack.status)) b.push(`management pack ${s.managementPack.status === 'not_started' ? 'not requested' : s.managementPack.status === 'requested' ? 'awaiting' : 'under review'}`);
      if (!s.contractPack.sentAt) b.push('contract pack not sent');
      break;
    case 'contract_review': {
      const open = Object.values(s.inboundEnquiries).filter((q) => !q.repliedAt);
      if (open.length) b.push(`${open.length} enquir${open.length === 1 ? 'y' : 'ies'} from the buyer awaiting our reply (${open.map((q) => q.id).join(', ')})`);
      break;
    }
    case 'pre_exchange': {
      const open = Object.values(s.inboundEnquiries).filter((q) => !q.repliedAt);
      if (open.length) b.push(`${open.length} enquir${open.length === 1 ? 'y' : 'ies'} from the buyer awaiting our reply (${open.map((q) => q.id).join(', ')})`);
      if (s.hasExistingMortgage && s.redemption.status === 'not_started') b.push('redemption statement not requested');
      if (s.hasExistingMortgage && s.redemption.status === 'requested') b.push('redemption statement awaited');
      for (const c of (s.otherCharges ?? []).filter((x) => x.status === 'to_redeem')) b.push(`redemption figure awaited from ${c.chargee}`);
      b.push(...issueBlockers(s, 'exchange'));
      if (!s.readiness.contractApprovedAt) b.push("contract not yet approved by the buyer's solicitor");
      else if (!s.readiness.signedContractHeldAt) b.push("our client's signed contract not on file");
      if (exchangeAuthorityHolds(s)) b.push('client has not yet authorised exchange');
      if (!s.exchange.exchangedAt) b.push(s.exchange.conditionsMet ? 'contracts not yet exchanged' : 'exchange conditions not met');
      break;
    }
    case 'exchanged':
      if (!s.completion.statementGeneratedAt) b.push('completion statement not generated');
      break;
    case 'pre_completion':
      if (!s.completion.confirmedAt) {
        b.push(...issueBlockers(s, 'completion'));
        if (!s.deeds.transferDeedAt) b.push('transfer deed not executed by the seller');
        if (!s.completion.fundsReceivedAt) b.push("completion monies not received from the buyer's solicitor");
        if (s.hasExistingMortgage && !s.payments.some((x) => x.payeeKind === 'lender')) b.push('redemption payment not authorised against verified lender details');
        if (pendingBankDetailsDecision(s, 'lender')) b.push('lender bank-details change awaiting out-of-band verification (hard stop)');
        if (anythingCharged(s) && !s.undertaking) b.push("our undertaking to redeem not yet given to the buyer's solicitor");
        if (s.completion.fundsReceivedAt) b.push('completion not confirmed');
      }
      break;
    case 'completed':
      if (s.hasExistingMortgage && s.redemption.status !== 'redeemed' && s.redemption.status !== 'discharged') b.push('mortgage not yet recorded as redeemed');
      for (const c of (s.otherCharges ?? []).filter((x) => x.status === 'to_redeem' || x.status === 'received')) b.push(`${c.chargee} not yet recorded as paid off`);
      if (!s.payments.some((x) => x.payeeKind === 'client')) b.push('balance to the client not authorised against verified client details');
      break;
    case 'post_completion': {
      const waiting: string[] = [];
      if (s.hasExistingMortgage && s.redemption.status !== 'discharged') waiting.push("awaiting the lender's discharge (DS1 / e-DS1)");
      for (const c of openCharges(s)) waiting.push(`awaiting ${c.chargee}'s discharge`);
      if (!waiting.length && s.undertaking && !s.undertaking.dischargedAt) waiting.push("discharges not yet sent to the buyer's solicitor (our undertaking)");
      if (!waiting.length && !s.finalBill) waiting.push('final bill not delivered');
      b.push(...(waiting.length ? waiting : ['matter complete']));
      break;
    }
  }
  return b;
}

/** Remortgage and transfer of equity: no exchange — investigation, execution, completion, registration. */
function ownerBlockers(s: MatterState, p: TransactionProfile): string[] {
  const b: string[] = [];
  const remo = p.type === 'remortgage';
  switch (s.stage) {
    case 'instruction':
      if (!isResolved(s.idCheck.status)) b.push(`ID/AML check ${s.idCheck.status.replace('_', ' ')}`);
      for (const pc of Object.values(s.partyChecks)) if (pc.role !== 'donor' && !isResolved(pc.status)) b.push(`ID/AML check for ${pc.label} ${pc.status.replace(/_/g, ' ')}`);
      break;
    case 'pre_contract':
      if (!isResolved(s.title.status)) b.push(`title ${s.title.status}`);
      b.push(...unresolvedSearches(s, true));
      if (remo && !isResolved(s.mortgage.status)) b.push(`mortgage offer ${s.mortgage.status}`);
      if (s.hasExistingMortgage && remo && s.redemption.status !== 'received' && s.redemption.status !== 'redeemed' && s.redemption.status !== 'discharged') b.push(`redemption statement ${s.redemption.status === 'requested' ? 'awaited' : 'not requested'}`);
      if (remo) for (const c of (s.otherCharges ?? []).filter((x) => x.status === 'to_redeem')) b.push(`redemption figure awaited from ${c.chargee}`);
      if (s.hasExistingMortgage && !remo && s.lenderConsent.status !== 'received') b.push(`lender's consent ${s.lenderConsent.status === 'requested' ? 'awaited' : 'not requested'}`);
      if (!remo && s.parties > 1 && !s.clientDecisions.ownership_basis) b.push('basis of co-ownership not yet decided by the clients');
      b.push(...issueBlockers(s, 'exchange'));
      break;
    case 'pre_completion':
      if (!s.completion.confirmedAt) {
        b.push(...issueBlockers(s, 'completion'));
        if (remo && !s.deeds.mortgageDeedAt) b.push('mortgage deed not executed');
        if (remo && !s.deeds.certificateOfTitleAt) b.push('certificate of title not sent to the lender');
        if (remo && !s.preCompletion.bankruptcySearchAt) b.push('bankruptcy search (K16) not recorded');
        if (remo && !s.preCompletion.prioritySearchAt) b.push('priority search (OS1) not made');
        if (remo && !s.preCompletion.insuranceConfirmedAt) b.push('buildings insurance not confirmed');
        if (remo && !s.completion.fundsReceivedAt) b.push('advance not received from the new lender');
        if (remo && s.hasExistingMortgage && !s.payments.some((x) => x.payeeKind === 'lender')) b.push('redemption payment not authorised against verified lender details');
        if (!remo && !s.deeds.transferDeedAt) b.push('transfer deed not executed by every party');
        if (!remo && deedOfTrustApplies(s) && !s.deeds.deedOfTrustAt) b.push('declaration of trust not executed (tenants in common)');
        if (!remo && (s.considerationPennies ?? 0) > 0 && !s.completion.fundsReceivedAt) b.push('consideration not received from the incoming owner');
        if (pendingBankDetailsDecision(s, 'lender')) b.push('lender bank-details change awaiting out-of-band verification (hard stop)');
        if (!b.length) b.push('completion not confirmed');
      }
      break;
    case 'completed':
      if (!remo && (s.considerationPennies ?? 0) > 0 && !s.postCompletion.sdltSubmittedAt && !s.sdltNotRequiredAt) b.push('SDLT return not filed (or recorded as not required)');
      if (!s.postCompletion.ap1SubmittedAt) b.push('AP1 not submitted');
      break;
    case 'post_completion':
      if (s.postCompletion.requisitions.some((r) => !r.respondedAt)) b.push('HMLR requisition outstanding');
      if (remo && s.hasExistingMortgage && s.redemption.status !== 'discharged') b.push("awaiting the old lender's discharge");
      for (const c of openCharges(s)) b.push(c.status === 'received' ? `${c.chargee} not yet recorded as paid off` : `awaiting ${c.chargee}'s discharge`);
      b.push(...afterRegistration(s));
      break;
  }
  return b;
}

/** A survey on file means the client must confirm they are satisfied with the physical condition before exchange (their decision, never inferred). */
const surveyHolds = (s: MatterState): boolean => surveyApplies(s) && s.survey.status !== 'client_satisfied';
/** The client booked a survey and its report is not back: exchange waits for it, or for the client's decision to go ahead without it (exchange.md 4.5). */
const surveyPending = (s: MatterState): boolean => s.survey.plan?.plan === 'booked' && !surveyApplies(s) && s.clientDecisions.accept_risk?.decision !== 'accepted';
/** Firm policy: the client's recorded authority to exchange. */
const exchangeAuthorityHolds = (s: MatterState): boolean => s.requireExchangeAuthority && s.clientDecisions.exchange_authority?.decision !== 'authorised';
const proofOfFundsHoldReason = (s: MatterState): string => (s.proofOfFunds.status === 'submitted' ? 'awaiting sign-off' : s.proofOfFunds.status === 'requested' ? 'requested from the client' : s.proofOfFunds.status === 'reviewed' ? `${s.proofOfFunds.resolution === 'reject' ? 'rejected' : 'not signed off'} — a new round is needed` : 'not yet requested (firm policy)');

/** Open issues holding a stage exit, as blocker lines. */
function issueBlockers(s: MatterState, gate: IssueGate): string[] {
  return issuesGating(s, gate).map((i) => `issue: ${ISSUE_KIND_SPEC[i.kind].label} — ${i.title} (${i.status})`);
}

/** Required searches not yet resolved; `includeUnordered` also lists ones never ordered (pre_contract only). */
/**
 * The report on title can be written: a buyer's case in contract review with the title, every
 * required search and every enquiry resolved, and no draft yet. The engine drafts it then, unasked
 * (a draft only: a conveyancer approves it before anything goes to the client).
 */
export function reportReady(s: MatterState): boolean {
  if (!s.enrolled || s.closedAt || s.abandoned) return false;
  if (profileOf(s.transactionType ?? 'freehold_purchase').side !== 'buyer') return false;
  if (!(s.stage === 'contract_review' || (s.stage === 'pre_exchange' && s.reportOnTitle.interimSentAt)) || s.reportOnTitle.status !== 'not_started') return false;
  return isResolved(s.title.status) && !unresolvedSearches(s, true).length && Object.values(s.enquiries).every((q) => isResolved(q.status));
}

function unresolvedSearches(s: MatterState, includeUnordered: boolean): string[] {
  const out: string[] = [];
  for (const t of s.requiredSearches) {
    const sr = s.searches[t];
    if (!sr) {
      if (includeUnordered) out.push(`${t} search not ordered`);
    } else if (!isResolved(sr.status)) out.push(`${t} search ${sr.status}${sr.cycle > 1 ? ' (re-ordered)' : ''}`);
  }
  return out;
}

const nextStage = (s: MatterState): Stage | null => {
  const list = profile(s).stages;
  const i = list.indexOf(s.stage);
  return i === -1 ? STAGES[stageIndex(s.stage) + 1] ?? null : list[i + 1] ?? null;
};

/**
 * Automatic follow-on events: stage advancement and derived milestones. Loops until
 * the state is quiescent so one command can carry a matter through several gates.
 */
/**
 * What holds exchange, other than the link to the client's other case: that one is settled at exchange
 * itself (each side checks the other can exchange), so counting it here would leave both sides waiting on each other.
 */
const gatingBesidesChain = (s: MatterState) => issuesGating(s, 'exchange').filter((i) => !(i.kind === 'chain_dependency' && i.title.startsWith('Linked ')));

function automatic(state: MatterState, now: Date): NewEvent[] {
  const out: NewEvent[] = [];
  let s = state;
  for (let guard = 0; guard < 16; guard++) {
    let ev: NewEvent | null = null;
    if (s.abandoned) break;
    const side = profile(s).side;
    // A first request (the contract pack, a redemption statement…) or a letter to a party rides the chase level but is not a chase: it is never 'stale'.
    const staleChase = Object.values(s.proposals).find((p) => p.status === 'pending' && p.action === 'chase' && (p.detail as { kind?: string }).kind !== 'request' && (p.detail as { kind?: string }).kind !== 'party_message' && !s.waits.some((w) => w.closedAt === null && `${w.key}:${w.subject}` === p.dedupKey));
    // Two pending proposals that would send the same thing (the same acknowledgement to the same party, the
    // same enquiry): the newer is taken back, so a person never sees, or approves, a duplicate.
    const pending = Object.values(s.proposals).filter((p) => p.status === 'pending').sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
    const sameAs = (p: (typeof pending)[number]) => p.action === 'acknowledgement' ? `ack:${String(p.detail.recipientRole)}:${String(p.detail.what)}` : p.action === 'enquiry_draft' ? `enq:${String(p.detail.subject).slice(0, 400)}` : p.action === 'client_update' ? `cu:${String(p.detail.template)}:${JSON.stringify(p.detail.context ?? {}).slice(0, 400)}` : null;
    const seenKeys = new Set<string>();
    const duplicate = pending.find((p) => { const k = sameAs(p); if (!k) return false; if (seenKeys.has(k)) return true; seenKeys.add(k); return false; });
    if (duplicate && !staleChase) {
      ev = { type: 'action_rejected', actor: SYSTEM, payload: { proposalEventId: duplicate.eventId, action: duplicate.action, detail: duplicate.detail, note: 'Withdrawn by the system: the same thing is already proposed.' } };
    } else if (staleChase) {
      // The thing we were going to chase for has arrived: the proposal is withdrawn, not left for a person to reject.
      ev = { type: 'action_rejected', actor: SYSTEM, payload: { proposalEventId: staleChase.eventId, action: staleChase.action, detail: staleChase.detail, note: 'Withdrawn by the engine: what was being chased has arrived.' } };
    } else if (side === 'buyer' && s.enrolled && !s.contractPack.requestedAt && !s.title.documentId && !s.abandoned) {
      // A purchase asks the seller's solicitor for the draft contract pack at instruction, not after the client's checks: the clock on it starts the day we are instructed.
      ev = { type: 'contract_pack_requested', actor: SYSTEM, payload: { to: 'seller_solicitor' } };
    } else if (side === 'buyer' && s.enrolled && !!s.exchange.exchangedAt && !s.completion.confirmedAt && !s.deeds.transferDeedAt && !s.deeds.transferRequestedAt && !deedsToSign(s).includes('transfer') && !s.abandoned) {
      // The seller signs the TR1; after exchange their solicitor is asked for it, so it is here for completion (and chased).
      ev = { type: 'signed_transfer_requested', actor: SYSTEM, payload: { to: 'seller_solicitor' } };
    } else if (side === 'buyer' && s.enrolled && s.stage === 'pre_exchange' && s.deposit.received && !s.exchange.conditionsMet && contractReady(s) && (!s.hasLender || isResolved(s.mortgage.status)) && gatingBesidesChain(s).length === 0 && !proofOfFundsHolds(s) && !surveyHolds(s) && !exchangeAuthorityHolds(s)) {
      ev = { type: 'exchange_conditions_met', actor: SYSTEM, payload: { conditions: ['report on title sent', 'title resolved', 'searches resolved', 'deposit received', s.hasLender ? 'mortgage offer resolved' : 'cash purchase', 'no open issue holding exchange'] } };
    } else if (side === 'seller' && s.enrolled && s.stage === 'pre_exchange' && !s.exchange.conditionsMet && contractReady(s) && (!s.hasExistingMortgage || s.redemption.status === 'received') && Object.values(s.inboundEnquiries).every((q) => q.repliedAt) && gatingBesidesChain(s).length === 0 && !exchangeAuthorityHolds(s)) {
      ev = { type: 'exchange_conditions_met', actor: SYSTEM, payload: { conditions: ['contract pack sent', "buyer's enquiries answered", s.hasExistingMortgage ? 'redemption figure known' : 'unencumbered', 'no open issue holding exchange', s.requireExchangeAuthority ? 'client authorised exchange' : 'authority not required by policy'] } };
    } else {
      const to = nextStage(s);
      if (to && stageBlockers(s).length === 0) {
        ev = { type: 'stage_advanced', actor: SYSTEM, payload: { from: s.stage, to, reason: `all ${s.stage.replace('_', ' ')} gates resolved` } };
      }
    }
    if (!ev) break;
    out.push(ev);
    s = applyNew(s, [ev], now);
  }
  return out;
}

// ───────────────────────────── verdict → events ─────────────────────────────

function verdictEvents<C extends EventType, F extends EventType>(input: {
  verdict: Verdict;
  cleared: C;
  flagged: F;
  kind: DecisionKind;
  subjectLabel: string;
  sourceDocumentId: string;
  summary?: SummaryOverride | null;
  extra: Record<string, unknown>;
  confidence: number;
  causedBy?: string | null;
  /** Trust level for auto_clear: propose → the clear waits for a person; assist → clears, then asks to confirm; auto → clears. */
  level?: TrustLevel;
}): NewEvent[] {
  if (input.verdict.outcome === 'clear') {
    const cleared = { type: input.cleared, actor: SYSTEM, payload: { ...input.extra, reasons: input.verdict.reasons }, sourceDocumentId: input.sourceDocumentId, confidenceScore: input.confidence } as NewEvent;
    const level = input.level ?? 'propose';
    if (level === 'auto') return [cleared];
    const subFlow = SUBFLOW_FOR_KIND[input.kind];
    const subject = String(input.extra.searchType ?? input.extra.enquiryId ?? input.subjectLabel);
    if (level === 'propose') {
      const decision: DecisionSpec = {
        kind: 'auto_clear',
        summary: `${input.subjectLabel}: the rule layer finds nothing wrong (${input.verdict.reasons.join('; ')}). At PROPOSE level nothing is cleared until you approve it. Approve to clear, or escalate.`,
        sourceDocumentId: input.sourceDocumentId,
        citations: [{ documentId: input.sourceDocumentId, label: `${input.subjectLabel} — full document` }],
        options: OPTIONS_FOR.auto_clear,
        summarisedBy: 'template',
      };
      assertDecisionSpec(decision);
      return [{ type: 'auto_clear_proposed', actor: AI, payload: { subFlow, subject, clearedEvent: cleared, reasons: input.verdict.reasons, decision }, sourceDocumentId: input.sourceDocumentId } as NewEvent];
    }
    const decision: DecisionSpec = {
      kind: 'auto_clear',
      summary: `${input.subjectLabel} passed the rules${input.verdict.reasons.length ? `: ${input.verdict.reasons.join('; ')}` : ''}. Confirm it, or send it back. The case carries on meanwhile.`,
      sourceDocumentId: input.sourceDocumentId,
      citations: [{ documentId: input.sourceDocumentId, label: `${input.subjectLabel} — full document` }],
      options: OPTIONS_FOR.auto_clear,
      summarisedBy: 'template',
    };
    assertDecisionSpec(decision);
    return [cleared, { type: 'auto_clear_review_raised', actor: AI, payload: { subFlow, subject, clearedEventType: input.cleared, reasons: input.verdict.reasons, decision }, sourceDocumentId: input.sourceDocumentId } as NewEvent];
  }
  const decision = buildDecision({ kind: input.kind, subjectLabel: input.subjectLabel, flags: input.verdict.flags, sourceDocumentId: input.sourceDocumentId, summary: input.summary });
  assertDecisionSpec(decision);
  return [{ type: input.flagged, actor: AI, payload: { ...input.extra, flags: input.verdict.flags, decision }, sourceDocumentId: input.sourceDocumentId, confidenceScore: input.confidence } as NewEvent];
}

/** Issues that say something is on its way: its arrival closes them (service reactions). */
export const CLOSED_BY_ARRIVAL: IssueKind[] = ['survey_report_outstanding', 'mortgage_offer_outstanding', 'search_delayed', 'freeholder_info_outstanding'];

const SUBFLOW_FOR_KIND: Record<DecisionKind, SubFlow> = { id_check: 'id_check', search: 'search', enquiry: 'enquiry', mortgage: 'mortgage', title: 'title', report_on_title: 'report_on_title', contract: 'title', escalation: 'chase', bank_details: 'chase', auto_clear: 'chase', requisition: 'chase', proof_of_funds: 'proof_of_funds', management_pack: 'management_pack', note_actions: 'chase', proposal: 'chase' };

// ───────────────────────────── decide ─────────────────────────────

/** Commands a person records from Something Happened or Raise Issue. */
const PERSON_RECORDED = new Set(['record_party_event', 'record_deal_event', 'record_property_event', 'record_completion_event', 'add_shape', 'record_isa', 'sdlt_amended', 'raise_issue']);

export function decide(state: MatterState, cmd: Command, ctx: DecideContext): Decision {
  // A milestone recorded by hand must carry what its contract asks for (completion.ts).
  // `completion` is set (even empty) by the HTTP route — the path a person's click takes —
  // so automation, ingestion and scripts are not asked for a sheet they cannot fill.
  if (cmd.completion !== undefined) {
    try {
      assertCompletion(cmd.type, cmd as unknown as Record<string, unknown>, state.shapes ?? [], state.hasLender);
    } catch (err) {
      if (err instanceof CompletionError) reject(err.message, 400);
      throw err;
    }
  }
  const core = decideCore(state, cmd, ctx);
  // What a person records (Something Happened, Raise Issue) raises issues in their name: theirs to drive on the Tasks list.
  const actor = (cmd as { actor?: Actor }).actor;
  const raw = actor && isUserActor(actor) && PERSON_RECORDED.has(cmd.type) ? core.map((e) => (e.type === 'issue_raised' ? { ...e, actor } : e)) : core;
  // The evidence rides on the event: the document as its source, the rest in the payload.
  const events = cmd.completion && raw.length
    ? [{ ...raw[0], sourceDocumentId: raw[0].sourceDocumentId ?? cmd.completion.documentId ?? null, payload: { ...(raw[0].payload as object), completion: cmd.completion } } as unknown as NewEvent, ...raw.slice(1)]
    : raw;
  const mid = applyNew(state, events, ctx.now);
  const auto = automatic(mid, ctx.now);
  const all = [...events, ...auto];
  return { events: all, state: applyNew(state, all, ctx.now) };
}

/** Names on the printed remitter line that are nobody we know: not the declarant, a party, a client, or a holder of a statement read. Empty when we know nobody yet. */
function strangersAmong(s: MatterState, remitter: string): string[] {
  const known = [...(s.partyNames ?? []), s.proofOfFunds.facts?.declarantName ?? '', ...(s.proofOfFunds.facts?.coDeclarants ?? []), ...Object.values(s.partyChecks).map((pc) => pc.label.replace(/\s*\(.*\)$/, '')), ...(s.proofOfFunds.statements ?? []).flatMap((st) => holderNames(st.holder)), ...(s.nameAliases ?? []).flatMap((a) => [a.from, a.to])].filter(Boolean);
  if (!known.length) return [];
  return holderNames(remitter).filter((h) => !samePerson(h, known));
}

/** The seller's forms read into issues: one per answer that changes what the file needs, cited to the page, never duplicated. */
/** The title of the one issue the seller's forms raise, and how to recognise it (and the per-point issues it replaces). */
export const FORMS_ISSUE_PREFIX = "Seller's forms:";
const isPerPointFormsIssue = (title: string) => /^(TA\d+|Forms|EPC)( |:)/.test(title);

/**
 * What the forms disclose, as ONE issue listing every point (like the survey), not an issue per
 * point. The forms come in several files: each arrival rebuilds the list from the whole set, the
 * previous list and any per-point issues from before are withdrawn into it.
 */
function formsIssueEvents(s: MatterState, facts: PropertyFormsFacts, side: 'buyer' | 'seller', documentId: string | null): NewEvent[] {
  const prev = s.sellerForms?.facts;
  const merged: PropertyFormsFacts = prev && side === 'buyer'
    ? { ...facts, forms: [...new Set([...(prev.forms ?? []), ...(facts.forms ?? [])])], answers: { ...(prev.answers ?? {}), ...Object.fromEntries(Object.entries(facts.answers ?? {}).filter(([, v]) => v !== null && v !== undefined)) }, disclosures: [...(prev.disclosures ?? []), ...(facts.disclosures ?? [])].filter((d, i, a) => a.findIndex((x) => x.code === d.code && x.description === d.description) === i) }
    : facts;
  const points = propertyFormsIssues(merged, side, { buyToLet: s.shapes?.includes('buy_to_let') ?? false });
  const out: NewEvent[] = [];
  const open = openIssues(s);
  // Nothing new in this file: the list stands as it is.
  const whoNow = side === 'buyer' ? "the seller's solicitor" : 'the client';
  const titleNow = `${FORMS_ISSUE_PREFIX} ${points.length} point${points.length === 1 ? '' : 's'} to raise with ${whoNow}`;
  const detailNow = points.map((p, n) => `${n + 1}. ${p.title}${p.page ? ` (p.${p.page})` : ''}\n   ${p.detail}`).join('\n');
  const current = open.find((i) => i.title.startsWith(FORMS_ISSUE_PREFIX));
  if (current && current.title === titleNow && current.detail === detailNow && !open.some((i) => isPerPointFormsIssue(i.title))) return [];
  const superseded = open.filter((i) => i.title.startsWith(FORMS_ISSUE_PREFIX) || isPerPointFormsIssue(i.title));
  for (const i of superseded) out.push({ type: 'issue_withdrawn', actor: SYSTEM, payload: { issueId: i.id, reason: `Merged into one list of the points from the ${side === 'buyer' ? "seller's" : "client's"} forms.` } });
  if (!points.length) return out;
  const rank: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };
  const worst = points.reduce((m, p) => Math.max(m, rank[p.flag.severity] ?? 1), 0);
  const who = side === 'buyer' ? "the seller's solicitor" : 'the client';
  const title = `${FORMS_ISSUE_PREFIX} ${points.length} point${points.length === 1 ? '' : 's'} to raise with ${who}`;
  const detail = points.map((p, n) => `${n + 1}. ${p.title}${p.page ? ` (p.${p.page})` : ''}\n   ${p.detail}`).join('\n');
  const gate: IssueGate = s.exchange.exchangedAt ? 'completion' : 'exchange';
  out.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextIssueId(s), kind: 'disclosure_concern', title, detail, gate, stage: s.stage, sourceDocumentId: documentId, origin: null, party: null, severity: worst >= 3 ? 'warning' : 'info' }, sourceDocumentId: documentId ?? undefined });
  // The register already read: shared access on the forms needs a right on it (property.md 1.12).
  const titleFacts = s.title.facts as TitleFacts | null;
  if (titleFacts && side === 'buyer') { const gap = accessGap(titleFacts, { ...findingContext(s), sharedAccess: !!merged.answers?.sharedAccessOrServices }); if (gap) out.push(...findingEvents(s, [gap], documentId, issueIds(s, out))); }
  return out;
}

function decideCore(s: MatterState, cmd: Command, ctx: DecideContext): NewEvent[] {
  switch (cmd.type) {
    case 'enrol': {
      if (s.enrolled) reject('Matter is already enrolled.');
      const side = profileOf(cmd.transactionType).side;
      const shapes = [...new Set(cmd.shapes ?? [])].filter((sh) => SHAPE_SPEC[sh]);
      for (const sh of shapes) if (!SHAPE_SPEC[sh].sides.includes(side)) reject(`${SHAPE_SPEC[sh].label} does not apply to a ${profileOf(cmd.transactionType).label.toLowerCase()}.`, 400);
      // A shape's checklist is an issue from day one, holding the gate it threatens until a person resolves it.
      const shapeIssues: NewEvent[] = shapes.map((sh, i) => ({ type: 'issue_raised', actor: cmd.actor, payload: { issueId: `I${i + 1}`, kind: SHAPE_SPEC[sh].issue.kind, title: SHAPE_SPEC[sh].issue.title, detail: SHAPE_SPEC[sh].issue.detail, gate: SHAPE_SPEC[sh].issue.gate, stage: 'instruction', sourceDocumentId: null, origin: null, party: null, severity: ISSUE_KIND_SPEC[SHAPE_SPEC[sh].issue.kind].severity, causedBy: null } }));
      // Every client beyond the first, by name, is a person to identify in their own right.
      const roleOf: IdPartyCheck['role'] = side === 'seller' ? 'seller' : side === 'owner' ? 'owner' : 'buyer';
      const names = [...new Set((cmd.partyNames ?? []).map((n) => n.trim()).filter(Boolean))];
      const partyEvents: NewEvent[] = names.slice(1).map((name) => ({ type: 'id_party_added', actor: cmd.actor, payload: { party: partyId(roleOf, name), label: name, role: roleOf } }));
      // People who are not clients but must be identified like one: attorneys (LSAG 6.14.9), a company's directors and PSCs (6.14.11), executors and trustees (6.14.16).
      const clean = (xs?: string[] | null) => [...new Set((xs ?? []).map((n) => n.trim()).filter(Boolean))];
      const attorneys = clean(cmd.attorneys), officers = clean(cmd.officers), executors = clean(cmd.executors), occupiers = clean(cmd.occupiers);
      const extraParties: NewEvent[] = [
        ...attorneys.map((n) => ({ type: 'id_party_added' as const, actor: cmd.actor, payload: { party: partyId('attorney', n), label: `${n} (attorney)`, role: 'attorney' as const } })),
        ...officers.map((n) => ({ type: 'id_party_added' as const, actor: cmd.actor, payload: { party: partyId('director', n), label: `${n} (director / PSC)`, role: 'director' as const } })),
        ...executors.map((n) => ({ type: 'id_party_added' as const, actor: cmd.actor, payload: { party: partyId('executor', n), label: `${n} (executor / trustee)`, role: 'executor' as const } })),
      ];
      // What each of those brings with it is a checklist issue from day one, like a shape's.
      let issueN = shapes.length;
      const issue = (kind: IssueKind, title: string, detail: string): NewEvent => ({ type: 'issue_raised', actor: cmd.actor, payload: { issueId: `I${++issueN}`, kind, title, detail, gate: ISSUE_KIND_SPEC[kind].gate, stage: 'instruction', sourceDocumentId: null, origin: null, party: null, severity: ISSUE_KIND_SPEC[kind].severity, causedBy: null } });
      const conditionIssues: NewEvent[] = [];
      // An attorney who is also a co-owner, or one attorney for both owners, cannot give a valid receipt alone: a second trustee is needed (exchange.md 3.2; TDA 1999 s.7).
      const clientNames = (cmd.partyNames ?? []).map((n) => n.trim().toLowerCase());
      if (attorneys.length && (cmd.partyNames?.length ?? 0) > 1 && (attorneys.some((a) => clientNames.includes(a.toLowerCase())) || attorneys.length === 1)) conditionIssues.push(issue('title_restriction', `Attorney and co-owners: a second trustee may be needed (${attorneys.join(', ')})`, 'Where the attorney is also a co-owner, or one attorney signs for both owners, the purchase money must still be paid to two trustees: appoint a second trustee, or use a power under s.1 TDA 1999 only if its conditions are met. Check before exchange.'));
      if (attorneys.length) conditionIssues.push(issue('power_of_attorney_issue', `Client acts through an attorney: ${attorneys.join(', ')}`, ((cmd.partyNames?.length ?? 0) > 1 && side !== 'buyer' ? 'Co-owners hold as trustees of land: a general power (Powers of Attorney Act 1971 s.10) cannot be used for trust functions. It needs a lasting power (TDA 1999 s.1, the attorney with a beneficial interest), or a Trustee Act 1925 s.25 delegation, and two trustees still receive the money. ' : '') + 'See the power (a registered LPA, or a general power with the deed): who granted it, whether it is in force, and that it covers this transaction. Written confirmation from the client that the attorney acts for them; the attorney identified like the client (LSAG 6.14.9). Tell the lender: most lenders need the power lodged and some will not lend on a power. HM Land Registry needs a certified copy with the AP1 (PG 9).'));
      if (officers.length) conditionIssues.push(issue('company_buyer_checks', `Company client: directors and PSCs identified — ${officers.join(', ')}`, 'Each director and person with significant control named here has an ID / AML check of their own (LSAG 6.14.11, 6.16). Check the PSC register at Companies House against the names given and report any discrepancy (reg. 30A). Board minute or resolution authorising the transaction and naming the signatories.'));
      if (executors.length) conditionIssues.push(issue('probate_issue', `Personal representatives / trustees acting: ${executors.join(', ')}`, 'The grant of probate or letters of administration (or the trust deed) seen and a copy on file; the death certificate. At least two personal representatives verified where there are two or more (LSAG 6.14.16); all of them sign the contract and the transfer. A sale before the grant issues cannot exchange.'));
      if (occupiers.length && side === 'buyer') conditionIssues.push(issue('occupier_consent', `Adult occupiers not buying: ${occupiers.join(', ')}`, 'The lender wants a signed consent / deed of postponement from every occupier aged 17 or over who is not a borrower, with separate advice, in our hands before the certificate of title (Lenders\' Handbook: occupiers). Tell the lender if any occupier claims an interest.'));
      // Only one government bonus can go towards a home (money.md 7.6).
      if (shapes.includes('lifetime_isa') && shapes.includes('help_to_buy_isa')) conditionIssues.push(issue('isa_bonus', 'Both a Lifetime ISA and a Help to Buy ISA: only one bonus can be used', 'A buyer cannot use both bonuses on the same home: the Help to Buy ISA can be transferred into the Lifetime ISA (and its bonus counts towards that ISA), or the client chooses one. Settle it with the client before any withdrawal or claim.'));
      const sdlt = cmd.sdlt ?? null;
      if (sdlt && (sdlt.firstTimeBuyer || sdlt.additionalProperty || sdlt.nonUkResident || sdlt.mixedUse || sdlt.linkedConsiderationPennies) && side === 'buyer') conditionIssues.push(issue('sdlt_basis', `SDLT basis declared: ${[sdlt.firstTimeBuyer && 'first-time buyer relief claimed', sdlt.additionalProperty && 'higher rates (additional property)', sdlt.nonUkResident && 'non-UK resident surcharge', sdlt.mixedUse && 'mixed use (non-residential rates: HMRC challenges these)', sdlt.linkedConsiderationPennies && 'linked transactions'].filter(Boolean).join('; ')}`, 'Check the basis against the facts before the return is filed: every buyer must qualify for first-time buyer relief (never owned anywhere in the world); the higher rates apply if any buyer or their spouse owns another dwelling at completion (a replaced main residence may be excepted); the 2% surcharge applies if any buyer was non-UK resident in the year before completion. A wrong basis is a penalty and, if deliberate, evasion (LSAG 18.5.5).'));
      return [
        {
          type: 'matter_created',
          actor: cmd.actor,
          payload: {
            transactionType: cmd.transactionType ?? 'freehold_purchase',
            shapes,
            partyNames: names,
            attorneys, officers, executors, occupiers,
            sdlt,
            // Proof of funds and the client's exchange authority are purchase-side policies; a sale, remortgage or transfer has neither. At auction the hammer is the exchange.
            requireProofOfFunds: side === 'buyer' ? (cmd.requireProofOfFunds ?? true) : false,
            requireExchangeAuthority: profileOf(cmd.transactionType).hasExchange && !shapes.some((sh) => SHAPE_SPEC[sh].skipExchangeAuthority) ? (cmd.requireExchangeAuthority ?? true) : false,
            parties: Math.max(1, cmd.parties ?? 1),
            hasExistingMortgage: !!cmd.hasExistingMortgage,
            considerationPennies: cmd.considerationPennies ?? null,
            hasLender: profileOf(cmd.transactionType).side === 'seller' ? false : cmd.hasLender,
            requiredSearches: cmd.requiredSearches?.length ? cmd.requiredSearches : profileOf(cmd.transactionType).defaultSearches,
            targetExchangeDate: cmd.targetExchangeDate ?? null,
            targetCompletionDate: cmd.targetCompletionDate ?? null,
            counterpartyType: cmd.counterpartyType ?? null,
            shadowMode: !!cmd.shadowMode,
          },
        },
        ...shapeIssues,
        // The same firm acting for the other side (parties.md 1.19): only within an SRA exception, with both clients' informed consent.
        ...(cmd.counterpartyType === 'internal' ? [{ type: 'issue_raised', actor: cmd.actor, payload: { issueId: `I${shapes.length + 1}C`, kind: 'third_party_consent', title: 'The firm acts for the other side too', detail: 'Buyer and seller have opposing interests: act for both only under an SRA Code 6.2 exception (a substantially common interest, or competing for the same objective), with both clients\' informed written consent, and separate fee earners with an information barrier. Record the decision and the consents before going on.', gate: 'exchange', stage: 'instruction', sourceDocumentId: null, origin: null, party: null, severity: 'critical', causedBy: null } } as NewEvent] : []),
        // A shape that always brings a charge to redeem (a Help to Buy equity loan) puts it on the case's charges.
        ...shapes.filter((sh) => SHAPE_SPEC[sh].charge && side !== 'buyer').map((sh, n): NewEvent => ({ type: 'charge_found', actor: cmd.actor, payload: { chargeId: `CH-${n + 1}`, chargee: SHAPE_SPEC[sh].charge!, text: null } })),
        ...conditionIssues,
        ...partyEvents,
        ...extraParties,
      ];
    }
    case 'add_party': {
      requireEnrolled(s);
      if (s.completion.confirmedAt) reject('The matter has completed; a party cannot be added now.');
      const name = cmd.name.trim();
      if (!name) reject('A party needs a name.', 400);
      const party = partyId(cmd.role, name);
      if (s.partyChecks[party]) reject(`${s.partyChecks[party].label} is already a party on this matter.`);
      const label = cmd.role === 'attorney' ? `${name} (attorney)` : cmd.role === 'director' ? `${name} (director / PSC)` : cmd.role === 'executor' ? `${name} (executor / trustee)` : cmd.role === 'donor' ? `${name} (donor)` : name;
      return [{ type: 'id_party_added', actor: cmd.actor, payload: { party, label, role: cmd.role } }];
    }
    case 'buildings_insurance_confirmed': {
      requireEnrolled(s);
      requireType(s, ['freehold_purchase', 'leasehold_purchase', 'remortgage'], 'Buildings insurance');
      if (s.preCompletion.insuranceConfirmedAt) reject('Buildings insurance is already confirmed.');
      const insOut: NewEvent[] = [{ type: 'buildings_insurance_confirmed', actor: cmd.actor, payload: { insurer: cmd.insurer?.trim() || null, fromDate: cmd.fromDate ?? null, documentId: cmd.documentId ?? null }, sourceDocumentId: cmd.documentId ?? null }];
      // The schedule against the case (completion.md 1.11): the buyers insured, the lender's interest noted, cover by completion (Lenders' Handbook 6.13).
      const insured = (cmd.insuredNames ?? []).map((x) => x.trim()).filter(Boolean);
      const notInsured = insured.length ? (s.partyNames ?? []).filter((n) => !samePerson(n, insured)) : [];
      const completesOn = s.exchange.completionDate ?? s.targetCompletionDate;
      const late = cmd.fromDate && completesOn && cmd.fromDate.slice(0, 10) > completesOn.slice(0, 10) && !isLeasehold(s);
      const wrong = [notInsured.length ? `not in the name of ${notInsured.join(', ')}` : null, s.hasLender && cmd.lenderNoted === false ? "the lender's interest is not noted" : null, late ? `cover starts ${cmd.fromDate}, after completion` : null].filter(Boolean);
      if (wrong.length) insOut.push(issue(s, issueIds(s)(), s.hasLender ? 'lender_approval' : 'other', `Buildings insurance on the wrong terms: ${wrong.join('; ')}`, 'Ask the client (or their broker) for the policy to be corrected: every buyer insured, the lender\'s interest noted, cover from completion at the latest (from exchange is better where the buyer bears the risk). Leasehold: the block policy from the management pack, with the lender\'s interest noted.', 'completion'));
      return insOut;
    }
    case 'priority_search_made': {
      requireEnrolled(s);
      requireType(s, ['freehold_purchase', 'leasehold_purchase', 'remortgage', 'transfer_of_equity'], 'A priority search');
      if (s.completion.confirmedAt) reject('The matter has completed.');
      if (Number.isNaN(Date.parse(cmd.expiresAt))) reject('A valid expiry date is required (the end of the priority period).', 400);
      const out: NewEvent[] = [{ type: 'priority_search_made', actor: cmd.actor, payload: { expiresAt: cmd.expiresAt, documentId: cmd.documentId ?? null }, sourceDocumentId: cmd.documentId ?? null }];
      const next = issueIds(s);
      // The search must be against the right title, for the right people (completion.md 1.5).
      const tn = cmd.titleNumber?.trim().toUpperCase().replace(/\s+/g, '');
      const want = s.title.facts?.titleNumber?.toUpperCase().replace(/\s+/g, '');
      const applicants = (cmd.applicants ?? []).map((a) => a.trim()).filter(Boolean);
      const missing = applicants.length ? (s.partyNames ?? []).filter((n) => !applicants.some((a) => samePerson(a, [n]))) : [];
      if ((tn && want && tn !== want) || missing.length) out.push(issue(s, next(), 'title_defect', `Priority search made wrongly: ${tn && want && tn !== want ? `title ${tn}, not ${want}` : `not in the name of ${missing.join(', ')}`}`, 'A priority search protects only the title and the applicants named on it (and the lender, on a mortgage). Make a fresh OS1 against the right title for every buyer and the lender before completion.', 'completion'));
      // Something registered since the official copies (completion.md 1.6).
      if (cmd.newEntries?.trim()) out.push(issue(s, next(), 'title_defect', `The priority search shows a new entry: ${cmd.newEntries.trim().slice(0, 80)}`, `"${cmd.newEntries.trim().slice(0, 400)}". It was not on the official copies. Raise it with the seller's solicitor as a requisition on title (it must be removed or explained at completion), and report it to the lender and the client.`, 'completion'));
      return out;
    }
    case 'bankruptcy_search_entry': {
      // The K16 shows an entry against a borrower (completion.md 1.8): the certificate cannot be given until it is shown to be a namesake or the lender instructs.
      requireEnrolled(s);
      if (!cmd.subject?.trim() || !cmd.entry?.trim()) reject('Who is it against, and what is the entry?', 400);
      return [{ type: 'bankruptcy_search_entry_found', actor: cmd.actor, payload: { subject: cmd.subject.trim(), entry: cmd.entry.trim() }, sourceDocumentId: cmd.documentId ?? null } as NewEvent,
        issueWith(s, issueIds(s)(), 'bankruptcy_insolvency', `Bankruptcy search entry against ${cmd.subject.trim()}`, `"${cmd.entry.trim().slice(0, 300)}". Check it is the same person (the full entry: date of birth, addresses, occupation). A namesake: clear it with that evidence. The same person: report to the lender and act only on its written instructions; a bankrupt cannot buy free of the trustee. The certificate of title cannot be given while this is open.`, 'completion', 'critical')];
    }
    case 'bankruptcy_search_clear': {
      requireEnrolled(s);
      requireType(s, ['freehold_purchase', 'leasehold_purchase', 'remortgage', 'transfer_of_equity'], 'A bankruptcy search');
      // A fresh search is allowed once the last no longer covers everyone (a borrower added) or is over 15 working days old (completion.md 1.9).
      if (s.preCompletion.bankruptcySearchAt && !k16Stale(s, ctx.now)) reject('The bankruptcy search is already recorded as clear.');
      const subjects = (cmd.subjects ?? []).map((x) => x.trim()).filter(Boolean);
      return [{ type: 'bankruptcy_search_clear', actor: cmd.actor, payload: { subjects: subjects.length ? subjects : [...(s.partyNames ?? [])], documentId: cmd.documentId ?? null }, sourceDocumentId: cmd.documentId ?? null }];
    }

    case 'resume_automation': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person resumes automation.', 403);
      if (!s.manualHandling.required) reject('Automation is not paused on this case.');
      if (!cmd.reason?.trim()) reject('Say why automation can resume.', 400);
      return [{ type: 'manual_handling_cleared', actor: cmd.actor, payload: { reason: cmd.reason.trim(), was: s.manualHandling.reason } }];
    }
    case 'mark_manual_handling': {
      requireEnrolled(s);
      if (s.manualHandling.required) reject('Matter is already marked for manual handling.');
      return [{ type: 'manual_handling_required', actor: cmd.actor, payload: { reason: cmd.reason, detail: cmd.detail } }];
    }

    // ── ID / AML ──
    case 'request_id_check': {
      requireEnrolled(s);
      const pc = cmd.party ? s.partyChecks[cmd.party] : null;
      if (cmd.party && !pc) reject(`No such party on this matter: ${cmd.party}.`, 404);
      const status = pc ? pc.status : s.idCheck.status;
      if (status === 'requested') reject(`An ID check${pc ? ` for ${pc.label}` : ''} is already in progress.`);
      if (isResolved(status)) reject(`The ID check${pc ? ` for ${pc.label}` : ''} is already resolved.`);
      return [{ type: 'id_check_requested', actor: cmd.actor, payload: { provider: cmd.provider, reference: cmd.reference ?? null, party: cmd.party ?? null, ...(cmd.link ? { link: cmd.link } : {}) } }];
    }
    case 'id_check_result': {
      requireEnrolled(s);
      const pc = cmd.party ? s.partyChecks[cmd.party] : null;
      if (cmd.party && !pc) reject(`No such party on this matter: ${cmd.party}.`, 404);
      const status = pc ? pc.status : s.idCheck.status;
      // A result (or the client's own photo of their ID) may arrive before anything was requested.
      if (status !== 'requested' && status !== 'not_started') reject(`No ID check${pc ? ` for ${pc.label}` : ''} is awaiting a result (status: ${status}).`);
      // A sanctions match is a hard stop of its own, not only a flag on the review (SAMLA 2018; OFSI): nothing moves until a person clears it.
      // A politically exposed person: enhanced due diligence and a senior person's approval before going on (MLR 2017 reg 35; parties.md 1.13, 7.5).
      const pep = (cmd.facts.flags ?? []).some((f) => f.code === 'PEP_MATCH') && !openOf(s, 'aml_kyc_problem', 'Politically exposed')
        ? [issue(s, issueIds(s)(), 'aml_kyc_problem', `Politically exposed person: ${pc?.label ?? s.partyNames?.[0] ?? 'the client'}`, 'The ID check matched a PEP (or a family member or close associate). Confirm the match; if it is them: senior management approval to act, establish the source of wealth and of the funds, and monitor the matter more closely. Record the approval.', s.exchange.exchangedAt ? 'completion' : 'exchange')]
        : [];
      const sanctions = (cmd.facts.flags ?? []).some((f) => f.code === 'SANCTIONS_MATCH') && !sanctionsHold(s)
        ? [issue(s, issueIds(s, pep)(), 'aml_kyc_problem', `${SANCTIONS_PREFIX}: ${pc?.label ?? s.partyNames?.[0] ?? 'the client'}`, 'The ID check matched a sanctions list. Until it is shown to be a different person (date of birth, address history) or OFSI grants a licence: no money in or out, no exchange, no completion, and no further work that benefits them. Report a true match to OFSI. Never cleared by automation.', s.exchange.exchangedAt ? 'completion' : 'exchange')]
        : [];
      const minor = (cmd.facts.flags ?? []).some((f) => f.code === 'MINOR_PARTY') && !openOf(s, 'minor_party', '')
        ? [issue(s, issueIds(s, [...sanctions, ...pep])(), 'minor_party', `${pc?.label ?? s.partyNames?.[0] ?? 'A client'} is under 18`, SHAPE_SPEC.minor_party.issue.detail, s.exchange.exchangedAt ? 'completion' : 'exchange')]
        : [];
      return [...sanctions, ...pep, ...minor, ...verdictEvents({
        verdict: evaluateIdCheck(cmd.facts),
        cleared: 'id_check_cleared',
        flagged: 'id_check_flagged',
        kind: 'id_check',
        level: levelFor(ctx.levels, 'auto_clear', 'id_check'),
        subjectLabel: cmd.facts.source === 'document' ? `ID document${pc ? ` — ${pc.label}` : ''}` : pc ? `ID/AML check — ${pc.label} (${cmd.facts.provider})` : `ID/AML check (${cmd.facts.provider})`,
        sourceDocumentId: cmd.documentId,
        summary: cmd.summary,
        extra: { facts: cmd.facts, party: cmd.party ?? null },
        confidence: cmd.facts.confidence,
      })];
    }

    // ── Searches ──
    case 'record_search_ordered': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'pre_contract', 'Ordering a search');
      const existing = s.searches[cmd.searchType];
      // A resolved search may be ordered again (re-issued result, lender freshness rule, provider error); an open one may not.
      if (existing && !isResolved(existing.status)) reject(`${cmd.searchType} search already ${existing.status}.`);
      const ordered: NewEvent[] = [{ type: 'search_ordered', actor: cmd.actor, payload: { searchType: cmd.searchType, provider: cmd.provider, reference: cmd.reference ?? null, reissue: !!existing } }];
      // Searches from the seller's or the auction pack (property.md 4.2): the lender must accept them, and they age from their own date.
      if (/seller|pack|auction|personal search/i.test(cmd.provider) && s.hasLender && profile(s).side === 'buyer' && !openOf(s, 'lender_approval', "Searches from the seller's pack")) ordered.push(issue(s, issueIds(s)(), 'lender_approval', "Searches from the seller's pack: the lender must accept them", 'Searches the buyer did not order: check the lender accepts them (personal or official, its name on them or search insurance in its favour) and their date (most lenders want them under six months old at exchange). Otherwise order fresh ones.', 'exchange'));
      return ordered;
    }
    case 'search_returned': {
      requireEnrolled(s);
      const sr = s.searches[cmd.searchType];
      if (!sr) reject(`${cmd.searchType} search was never ordered. Record the order first (manual fallback) so the log stays truthful.`);
      if (sr.status !== 'ordered') reject(`${cmd.searchType} search is ${sr.status}, not awaiting return.`);
      return [{ type: 'search_returned', actor: cmd.actor, payload: { searchType: cmd.searchType, provider: cmd.provider ?? null }, sourceDocumentId: cmd.documentId }];
    }
    case 'search_extracted': {
      requireEnrolled(s);
      const sr = s.searches[cmd.searchType];
      if (!sr || sr.status !== 'returned') reject(`${cmd.searchType} search is not awaiting extraction (status: ${sr?.status ?? 'not ordered'}).`);
      if (!sr.documentId) reject(`${cmd.searchType} search has no source document.`, 500);
      if (cmd.facts.searchType !== cmd.searchType) reject('Extracted facts are for a different search type.', 400);
      const extracted: NewEvent = { type: 'search_extracted', actor: SYSTEM, payload: { searchType: cmd.searchType, facts: cmd.facts, extractor: cmd.extractor }, sourceDocumentId: sr.documentId, confidenceScore: cmd.facts.confidence };
      return [
        extracted,
        ...verdictEvents({
          verdict: evaluateSearch(cmd.facts),
          cleared: 'search_cleared',
          flagged: 'search_flagged',
          kind: 'search',
        level: levelFor(ctx.levels, 'auto_clear', 'search'),
          subjectLabel: `${cmd.searchType === 'LLC1' || cmd.searchType === 'CON29' ? cmd.searchType : cmd.searchType.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())} search`,
          sourceDocumentId: sr.documentId,
          summary: cmd.summary,
          extra: { searchType: cmd.searchType },
          confidence: cmd.facts.confidence,
        }),
        ...findingEvents(s, searchFindings(cmd.facts, findingContext(s)), sr.documentId),
      ];
    }

    // ── Enquiries ──
    case 'raise_enquiry': {
      requireEnrolled(s);
      // Any time after instruction: most enquiries follow the contract pack, but a survey question or one the client asks for
      // is the conveyancer's call, not a stage rule.
      requireStageAtLeast(s, 'instruction', 'Raising an enquiry');
      if (cmd.origin?.issueId) openIssue(s, cmd.origin.issueId); // an enquiry raised from an issue must be from a live one
      if (!cmd.subject?.trim()) reject('An enquiry needs a subject.', 400);
      const enquiryId = cmd.enquiryId?.trim() || nextPlainEnquiryId(s, cmd.origin?.issueId ?? null);
      if (s.enquiries[enquiryId]) reject(`Enquiry ${enquiryId} already exists.`);
      // Addendum: correspondence with the other side is stamped internal/external so a
      // compliance review can find every crossing of an ethical wall from the log alone.
      return [{ type: 'enquiry_raised', actor: cmd.actor, payload: { enquiryId, subject: cmd.subject.trim(), origin: cmd.origin ?? null, counterpartyType: s.counterpartyType } }];
    }
    case 'enquiry_reply_received': {
      requireEnrolled(s);
      const q = s.enquiries[cmd.enquiryId];
      if (!q) reject(`Enquiry ${cmd.enquiryId} was never raised.`);
      if (q.status !== 'raised') reject(`Enquiry ${cmd.enquiryId} is ${q.status}, not awaiting a reply.`);
      const received: NewEvent = { type: 'enquiry_reply_received', actor: cmd.actor, payload: { enquiryId: cmd.enquiryId, facts: cmd.facts ?? null, counterpartyType: s.counterpartyType }, sourceDocumentId: cmd.documentId, confidenceScore: cmd.facts?.confidence ?? null };
      return [
        received,
        ...verdictEvents({
          verdict: evaluateEnquiryReply(cmd.facts),
          cleared: 'enquiry_reply_cleared',
          flagged: 'enquiry_reply_flagged',
          kind: 'enquiry',
        level: levelFor(ctx.levels, 'auto_clear', 'enquiry'),
          subjectLabel: `Reply to enquiry ${cmd.enquiryId} (${q.subject})`,
          sourceDocumentId: cmd.documentId,
          summary: cmd.summary,
          extra: { enquiryId: cmd.enquiryId },
          confidence: cmd.facts?.confidence ?? 0,
        }),
      ];
    }

    // ── Mortgage ──
    case 'mortgage_offer_received': {
      requireEnrolled(s);
      if (!s.hasLender) reject('This is a cash purchase — no mortgage offer is expected.');
      if (s.mortgage.status === 'flagged') reject('A mortgage decision is pending; resolve it before recording a new offer.');
      return [{ type: 'mortgage_offer_received', actor: cmd.actor, payload: { lender: cmd.lender ?? null }, sourceDocumentId: cmd.documentId }];
    }
    case 'mortgage_offer_extracted': {
      requireEnrolled(s);
      if (s.mortgage.status !== 'received') reject(`No mortgage offer is awaiting extraction (status: ${s.mortgage.status}).`);
      if (!s.mortgage.documentId) reject('Mortgage offer has no source document.', 500);
      const target = s.targetExchangeDate;
      const extracted: NewEvent = { type: 'mortgage_offer_extracted', actor: SYSTEM, payload: { facts: cmd.facts, extractor: cmd.extractor }, sourceDocumentId: s.mortgage.documentId, confidenceScore: cmd.facts.confidence };
      return [
        extracted,
        ...verdictEvents({
          verdict: evaluateMortgageOffer(cmd.facts, target, ctx.now),
          cleared: 'mortgage_offer_cleared',
          flagged: 'mortgage_condition_flagged',
          kind: 'mortgage',
        level: levelFor(ctx.levels, 'auto_clear', 'mortgage'),
          subjectLabel: `Mortgage offer (${cmd.facts.lender})`,
          sourceDocumentId: s.mortgage.documentId,
          summary: cmd.summary,
          extra: {},
          confidence: cmd.facts.confidence,
        }),
        // The offer against the case: borrowers, price, the advance the client declared, a re-issue's new conditions, conditions to satisfy.
        ...findingEvents(s, offerFindings(cmd.facts, { clients: s.partyNames ?? [], pricePennies: s.purchasePricePennies, declaredAdvancePennies: s.proofOfFunds.facts?.mortgageAdvancePennies ?? null, previous: (s.mortgage.facts as MortgageOfferFacts | null) ?? null, exchanged: !!s.exchange.exchangedAt }), s.mortgage.documentId),
      ];
    }

    // ── Title ──
    case 'title_extracted': {
      // The pack is asked for at instruction, so it may arrive while the client's checks are still running: the title is read when it lands, whatever the stage.
      requireEnrolled(s);
      // A second title (a garage, a garden strip, the freehold of a share of freehold: property.md 1.20) sits beside the first: its entries are read, it does not replace it.
      const main = s.title.facts as TitleFacts | null;
      if (main && !main.planOnly && !cmd.facts.planOnly && cmd.facts.titleNumber && main.titleNumber && cmd.facts.titleNumber.replace(/\s+/g, '').toUpperCase() !== main.titleNumber.replace(/\s+/g, '').toUpperCase()) {
        if ((s.additionalTitles ?? []).some((x) => x.titleNumber === cmd.facts.titleNumber)) reject(`Title ${cmd.facts.titleNumber} is already on file.`);
        const fcx = findingContext(s);
        const extra: NewEvent[] = [{ type: 'additional_title_read', actor: SYSTEM, payload: { facts: cmd.facts }, sourceDocumentId: cmd.documentId }];
        extra.push(...findingEvents(s, titleFindings(cmd.facts, fcx).map((f) => ({ ...f, code: `${cmd.facts.titleNumber}:${f.code}`, title: `${cmd.facts.titleNumber}: ${f.title}` })), cmd.documentId, issueIds(s, extra)));
        if (fcx.side === 'seller' || profile(s).type === 'remortgage') chargesToAdd({ ...s, otherCharges: s.otherCharges } as MatterState, cmd.facts).forEach((c, n) => extra.push({ type: 'charge_found', actor: SYSTEM, payload: { chargeId: `CH-${(s.otherCharges ?? []).length + n + 1}`, chargee: c.chargee, text: c.text }, sourceDocumentId: cmd.documentId }));
        if (cmd.facts.tenure !== 'unknown' && main.tenure !== 'unknown' && cmd.facts.tenure !== main.tenure) extra.push(issue(s, issueIds(s, extra)(), 'title_defect', `Title ${cmd.facts.titleNumber} is ${cmd.facts.tenure}, the main title ${main.tenure}`, 'Two tenures on one transaction (a share of freehold, a garage held freehold with a leasehold flat): the contract and the transfer must cover both titles, and the lender lends on both.', 'exchange'));
        return extra;
      }
      if (s.title.status === 'flagged') reject('A title decision is pending; resolve it before re-extracting.');
      // After the report went (property.md 9.3): the title is read again and a supplementary report follows, before exchange.
      if (s.reportOnTitle.status === 'sent' && s.exchange.exchangedAt) reject('Contracts are exchanged: new title information now needs manual handling.');
      const extracted: NewEvent = { type: 'title_extracted', actor: SYSTEM, payload: { facts: cmd.facts, extractor: cmd.extractor }, sourceDocumentId: cmd.documentId, confidenceScore: cmd.facts.confidence };
      const txType = s.transactionType ?? 'freehold_purchase';
      const expectedTenure = profile(s).tenure;
      const verdict = evaluateTitle(cmd.facts, expectedTenure);
      const fc = findingContext(s);
      const out = [
        extracted,
        ...verdictEvents({ verdict, cleared: 'title_cleared', flagged: 'title_flagged', kind: 'title', level: levelFor(ctx.levels, 'auto_clear', 'title'), subjectLabel: `Title ${cmd.facts.titleNumber}`, sourceDocumentId: cmd.documentId, summary: cmd.summary, extra: {}, confidence: cmd.facts.confidence }),
        // What a specific entry needs done is an issue of its own (findings.ts).
        ...findingEvents(s, [...titleFindings(cmd.facts, fc), ...(cmd.facts.lease && fc.side === 'buyer' ? leaseFindings(leaseFlags(cmd.facts.lease, s.lenderRequirements?.minUnexpiredYears ?? null), cmd.facts.lease, fc) : [])], cmd.documentId),
      ];
      // A sale or remortgage redeems every charge on the register, not only the mortgage it was enrolled with.
      if ((fc.side === 'seller' || profile(s).type === 'remortgage') && !cmd.facts.planOnly) chargesToAdd(s, cmd.facts).forEach((c, n) => out.push({ type: 'charge_found', actor: SYSTEM, payload: { chargeId: `CH-${(s.otherCharges ?? []).length + n + 1}`, chargee: c.chargee, text: c.text }, sourceDocumentId: cmd.documentId }));
      // Unregistered land: an epitome of title, not a register; first registration on completion. Outside what the engine reads (PG 1).
      // Its own checklist, not a halt (property.md 2.1); the two-month first-registration clock runs from completion (dates.ts).
      if (cmd.facts.unregistered && !openOf(s, 'title_defect', 'Unregistered title')) {
        out.push(issueWith(s, issueIds(s, out)(), 'title_defect', 'Unregistered title: the epitome to examine', `The title is an epitome / deeds bundle, not official copies. Before exchange: an index map search (SIM) to confirm it is not registered and nothing is pending; a land charges search (K15) against every estate owner since the root (each name, the years they owned it); a good root of title at least 15 years old, every link in the chain dated, stamped and executed; ${profile(s).side === 'buyer' || profile(s).type === 'remortgage' ? 'a K16 against the buyers; ' : ''}any deeds missing explained by statutory declaration. After completion, first registration (FR1) within two months or the transfer is void (LRA 2002 ss.6-7).`, 'exchange', 'warning'));
      }
      // A tenure the matter was not enrolled for (read clearly as the other one): flag it AND halt automation until a person resolves it.
      // A tenure that could not be read is only a flag on the title for a person; it does not stop the case.
      if (expectedTenure !== 'any' && cmd.facts.tenure !== 'unknown' && cmd.facts.tenure !== expectedTenure && !s.manualHandling.required) {
        out.push({ type: 'manual_handling_required', actor: SYSTEM, payload: { reason: 'tenure_mismatch', detail: `Title ${cmd.facts.titleNumber} is ${cmd.facts.tenure}; the matter is a ${txType.replace('_', ' ')}.` } });
      }
      return out;
    }

    case 'lease_extracted': {
      requireEnrolled(s);
      // A document is read when it arrives: the contract pack often comes before the case leaves Instruction.
      if (!isLeasehold(s)) reject('A lease is read on a leasehold matter; this matter is freehold.');
      if (s.title.status === 'flagged') reject('A title decision is pending; resolve it before reading the lease.');
      if (s.reportOnTitle.status === 'sent') reject('The report on title has already been sent; re-reviewing the lease now needs manual handling.');
      const extracted: NewEvent = { type: 'lease_extracted', actor: SYSTEM, payload: { facts: cmd.facts, extractor: cmd.extractor }, sourceDocumentId: cmd.documentId, confidenceScore: cmd.facts.confidence ?? null };
      // The lease's flags are title flags: one decision, one sub-flow, the official copy and the lease side by side.
      const verdict = evaluateLease(cmd.facts, s.lenderRequirements?.minUnexpiredYears ?? null);
      const fc = findingContext(s);
      return [
        extracted,
        ...verdictEvents({ verdict, cleared: 'title_cleared', flagged: 'title_flagged', kind: 'title', level: levelFor(ctx.levels, 'auto_clear', 'title'), subjectLabel: `Lease${cmd.facts.demise ? ` of ${cmd.facts.demise}` : ''}`, sourceDocumentId: cmd.documentId, summary: cmd.summary, extra: {}, confidence: cmd.facts.confidence ?? 0 }),
        ...(fc.side === 'buyer' ? findingEvents(s, leaseFindings(leaseFlags(cmd.facts, s.lenderRequirements?.minUnexpiredYears ?? null), cmd.facts, fc), cmd.documentId) : []),
      ];
    }

    // ── Decisions ──
    case 'open_decision_source': {
      const d = pendingDecision(s, cmd.decisionEventId);
      requireSurfaced(s, d, ctx);
      const allowed = new Set([d.sourceDocumentId, ...d.citations.map((c) => c.documentId)]);
      if (!allowed.has(cmd.documentId)) reject('That document is not the source of this decision.', 400);
      return [{ type: 'decision_source_opened', actor: cmd.userId, payload: { decisionEventId: d.eventId, documentId: cmd.documentId } }];
    }
    case 'resolve_decision': {
      const d = pendingDecision(s, cmd.decisionEventId);
      if (!isUserActor(cmd.userId)) reject('Decisions are resolved by people, not automation.', 403);
      if (!offeredOptions(d.kind, d.options).includes(cmd.option)) reject(`"${cmd.option}" is not an option for this decision (${offeredOptions(d.kind, d.options).join(', ')}).`, 400);
      requireSurfaced(s, d, ctx);
      // A proposal or a held clear is the system's own text: the message shown is the whole of it, there is no document to open first.
      // An acknowledgement's few words are the task's own title: seeing the task is reading it.
      const ackOnly = d.kind === 'note_actions' && Object.values(s.notes).some((n) => n.decisionEventId === d.eventId && n.acknowledgement && !n.actions.some((a) => a.command));
      if (d.kind !== 'proposal' && d.kind !== 'auto_clear' && !ackOnly && !d.openedBy.includes(cmd.userId)) reject('Open the source document before resolving this decision.', 412);
      // Addendum 3 §3: anything other than approving/verifying needs a reason, stored on the resolving event.
      if (cmd.option !== 'approve' && cmd.option !== 'verify' && !(cmd.note ?? '').trim()) reject(`Give a reason for choosing "${optionLabel(cmd.option)}".`, 400);
      // An escalation goes to a named person: it lands on their Tasks list.
      if (cmd.option === 'escalate' && !cmd.escalateTo) reject('Choose who to escalate it to.', 400);
      if (cmd.option === 'escalate' && cmd.escalateTo === cmd.userId) reject('Escalate it to someone else.', 400);
      return resolveEvents(s, d, cmd.option, cmd.note ?? null, cmd.userId, cmd.verification ?? null, cmd.engagement ?? null, cmd.selection ?? null, cmd.edited ?? null, cmd.escalateTo ?? null);
    }

    // ── Report on title ──
    case 'draft_report_on_title': {
      requireEnrolled(s);
      requireSide(s, ['buyer'], 'A report on title');
      { const why = reportDraftProblem(s); if (why) reject(why); }
      const decision: DecisionSpec = {
        kind: 'report_on_title',
        summary: cmd.summary,
        sourceDocumentId: cmd.draftDocumentId,
        citations: cmd.citations.length ? cmd.citations : [{ documentId: cmd.draftDocumentId, label: 'Draft report on title' }],
        options: OPTIONS_FOR.report_on_title,
        summarisedBy: cmd.model,
      };
      assertDecisionSpec(decision);
      return [{ type: 'report_on_title_drafted', actor: AI, payload: { draftId: cmd.draftId, draftDocumentId: cmd.draftDocumentId, model: cmd.model, decision, basedOn: cmd.basedOn ?? [], interim: s.stage === 'pre_contract' }, sourceDocumentId: cmd.draftDocumentId }];
    }
    case 'record_report_on_title_sent': {
      assertCanSendReport(s, cmd.draftId);
      return [{ type: 'report_on_title_sent', actor: cmd.actor, payload: { draftId: cmd.draftId, approvedEventId: s.reportOnTitle.approvedEventId as string, approvedBy: s.reportOnTitle.approvedBy as string, channel: cmd.channel, messageId: cmd.messageId ?? null }, sourceDocumentId: s.reportOnTitle.draftDocumentId }];
    }

    // ── Exchange ──
    case 'deposit_received': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'pre_contract', 'Recording the deposit');
      // The contract's deposit is what is owed: a deposit short of it can be topped up, and the shortfall holds exchange until it is.
      const contractDeposit = cmd.contractDepositPennies ?? s.deposit.contractPennies ?? null;
      const heldSoFar = s.deposit.amountPennies ?? 0;
      const topUp = s.deposit.received && contractDeposit != null && heldSoFar < contractDeposit;
      if (s.deposit.received && !topUp) reject('Deposit already recorded.');
      const out: NewEvent[] = [{ type: 'deposit_received', actor: cmd.actor, payload: { amountPennies: cmd.amountPennies ?? null, contractDepositPennies: contractDeposit } }];
      out.push(...depositConsequences(s, heldSoFar + (cmd.amountPennies ?? 0), cmd.amountPennies != null ? contractDeposit : null));
      if (topUp) return out;
      // Money accepted before source of funds is signed off is the situation the guidance says must not happen silently: it is recorded as an issue holding exchange.
      if (s.requireProofOfFunds && !proofOfFundsApproved(s) && !Object.values(s.issues).some((i) => i.kind === 'aml_kyc_problem' && i.title.startsWith('Deposit received before') && (i.status === 'open' || i.status === 'negotiating'))) {
        out.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextIssueId(s), kind: 'aml_kyc_problem', title: `Deposit received before proof of funds was signed off (proof of funds ${proofOfFundsHoldReason(s)})`, detail: 'Client money was accepted before the source-of-funds check was complete. Complete the check now; record the MLRO\'s view on the funds already held.', gate: 'exchange', stage: s.stage, sourceDocumentId: null, origin: null, party: null }, sourceDocumentId: null });
      }
      return out;
    }
    case 'contracts_exchanged': {
      requireEnrolled(s);
      requireStage(s, 'pre_exchange', 'Exchange');
      moneyMayMove(s, ctx.now, 'No exchange');
      if (!profile(s).hasExchange) reject(`A ${profile(s).label.toLowerCase()} completes without an exchange of contracts.`);
      if (profile(s).side === 'seller') {
        const unreplied = Object.values(s.inboundEnquiries).filter((q) => !q.repliedAt);
        if (unreplied.length) reject(`Cannot exchange: ${unreplied.length} of the buyer's enquiries await our reply (${unreplied.map((q) => q.id).join(', ')}).`);
        if (s.hasExistingMortgage && s.redemption.status !== 'received') reject('Cannot exchange: the redemption figure is not known.');
        const unknown = (s.otherCharges ?? []).filter((c) => c.status === 'to_redeem');
        if (unknown.length) reject(`Cannot exchange: no redemption figure yet for ${unknown.map((c) => c.chargee).join(', ')}.`);
      }
      if (profile(s).side === 'buyer' && s.hasLender && !isResolved(s.mortgage.status)) reject(`Cannot exchange: the mortgage offer is ${s.mortgage.status} (withdrawn / awaiting re-issue).`);
      const open = profile(s).side === 'buyer' ? unresolvedSearches(s, false) : [];
      if (open.length) reject(`Cannot exchange: ${open.join('; ')}.`);
      // Searches are aged on the completion day, from the date each was made (theme E: dates.ts).
      const maxAge = s.lenderRequirements?.maxSearchAgeMonths ?? null;
      if (maxAge != null && profile(s).side === 'buyer' && !Number.isNaN(Date.parse(cmd.completionDate))) {
        const stale = staleAtCompletion(s, cmd.completionDate);
        if (stale.length) reject(`Cannot exchange: the lender requires searches under ${maxAge} months old at completion, and on ${cmd.completionDate} ${stale.join(', ')} will be older; re-order.`);
      }
      if (proofOfFundsHolds(s)) reject(`Cannot exchange: proof of funds ${s.proofOfFunds.status === 'submitted' ? 'is awaiting the conveyancer\'s sign-off' : s.proofOfFunds.status === 'requested' ? 'is still with the client' : proofOfFundsHoldReason(s)}.`);
      if (surveyPending(s)) reject("Cannot exchange: the client's survey is booked and the report is not back. Wait for it, or record the client's decision to exchange without it (accept risk).");
      if (surveyHolds(s)) reject(`Cannot exchange: the client has not confirmed they are satisfied with the physical condition (survey ${s.survey.status.replace(/_/g, ' ')}). Record the client's decision.`);
      if (exchangeAuthorityHolds(s)) reject('Cannot exchange: the client has not authorised exchange. Record the client\'s decision (exchange_authority).');
      const unidentified = Object.values(s.partyChecks).filter((pc) => pc.role !== 'donor' && !isResolved(pc.status));
      if (unidentified.length) reject(`Cannot exchange: ID / AML not resolved for ${unidentified.map((pc) => pc.label).join(', ')}.`);
      const holding = issuesGating(s, 'exchange');
      if (holding.length) reject(`Cannot exchange while ${holding.length === 1 ? 'an issue is' : `${holding.length} issues are`} open: ${holding.map((i) => `${ISSUE_KIND_SPEC[i.kind].label} — ${i.title}`).join('; ')}. Resolve, withdraw or re-gate ${holding.length === 1 ? 'it' : 'them'} first.`);
      if (!s.readiness.contractApprovedAt) reject('Cannot exchange: the contract is not approved.');
      if (!s.readiness.signedContractHeldAt) reject("Cannot exchange: our client's signed contract is not on file.");
      if (!s.exchange.conditionsMet) reject('Exchange conditions are not met (deposit received?).');
      if (s.exchange.exchangedAt) reject('Contracts already exchanged.');
      if (Number.isNaN(Date.parse(cmd.completionDate))) reject('A valid completion date is required to exchange.', 400);
      const exchangeDay = cmd.exchangedAt && !Number.isNaN(Date.parse(cmd.exchangedAt)) ? new Date(cmd.exchangedAt) : ctx.now;
      const dateWrong = completionDateProblem(s, cmd.completionDate, exchangeDay);
      if (dateWrong) reject(`Cannot exchange: ${dateWrong}`, 400);
      const formula = cmd.formula?.trim().toUpperCase().replace(/^FORMULA\s*/, '') || null;
      if (formula && !['A', 'B', 'C'].includes(formula)) reject('The formula is A, B or C.', 400);
      // Exchanging and completing the same day: everything completion needs must already be in hand (exchange.md 5.5).
      if (profile(s).side === 'buyer' && cmd.completionDate.slice(0, 10) === exchangeDay.toISOString().slice(0, 10)) {
        const missing = [
          !(s.completion.receivedFrom ?? []).some((r) => r === 'client' || r === 'isa_provider') && "the client's money in",
          s.hasLender && !s.deeds.certificateOfTitleAt && 'the certificate of title sent to the lender',
          !s.preCompletion.prioritySearchAt && 'a priority search (OS1)',
          !s.deeds.transferDeedAt && "the seller's signed transfer",
        ].filter(Boolean);
        if (missing.length) reject(`Cannot exchange and complete today without ${missing.join(', ')}: once exchanged, the client is bound to complete this afternoon.`);
      }
      // A completion months away: the offer, the insurance and the searches all have to last that long (exchange.md 5.7).
      const far = (Date.parse(cmd.completionDate) - exchangeDay.getTime()) / 86_400_000 > 90;
      const delayed = far ? [issue(s, issueIds(s)(), s.hasLender ? 'lender_approval' : 'chain_dependency', `Completion is more than three months after exchange (${cmd.completionDate})`, `${s.hasLender ? `Check the mortgage offer runs past ${cmd.completionDate} and the searches will not be too old for the lender at completion. ` : ''}Buildings insurance must be in place for the whole period. Consider a larger deposit if the seller asked for the delay.`, 'completion')] : [];
      return [{ type: 'contracts_exchanged', actor: cmd.actor, payload: { completionDate: cmd.completionDate, exchangedAt: cmd.exchangedAt ?? null, formula: formula as 'A' | 'B' | 'C' | null, spokeWith: cmd.spokeWith?.trim() || null, depositRoute: cmd.depositRoute ?? null } }, ...delayed];
    }

    // ── Completion ──
    case 'completion_statement_generated': {
      requireEnrolled(s);
      if (s.stage !== 'exchanged' && !(s.stage === 'pre_completion' && (profile(s).side === 'owner' || s.completion.statementGeneratedAt))) requireStage(s, 'exchanged', 'Generating the completion statement');
      const st: NewEvent[] = [{ type: 'completion_statement_generated', actor: cmd.actor, payload: { documentId: cmd.documentId ?? null, balancePennies: cmd.balancePennies ?? null }, sourceDocumentId: cmd.documentId ?? null }];
      // A statement re-issued with a different balance after the client was asked for money (completion.md 2.3): tell them the new figure.
      const was = moneyOf(s).statementBalancePennies;
      if (was != null && cmd.balancePennies != null && was !== cmd.balancePennies && profile(s).side === 'buyer') {
        const diff = cmd.balancePennies - was;
        st.push(issue(s, issueIds(s)(), diff > 0 ? 'completion_funds_shortfall' : 'other', `Completion statement changed: ${diff > 0 ? `${pounds(diff)} more` : `${pounds(-diff)} less`} from the client`, `The balance was ${pounds(was)}; the new statement says ${pounds(cmd.balancePennies)}. Send the client the new statement and say why it changed${diff > 0 ? ', and ask for the extra money in good time for completion' : ' (any overpayment comes back after completion)'}.`, diff > 0 ? 'completion' : 'none'));
      }
      return st;
    }
    case 'funds_requested': {
      requireEnrolled(s);
      moneyMayMove(s, ctx.now, 'No request for money');
      if (cmd.fromRole === 'isa_provider' && !s.shapes.some((sh) => SHAPE_SPEC[sh]?.fundsFrom === 'isa_provider')) reject('No ISA on this matter: enrol it with a Lifetime ISA or Help to Buy ISA shape.');
      requireStage(s, 'pre_completion', 'Requesting funds');
      requireSide(s, ['buyer', 'owner'], 'Requesting completion funds');
      if (cmd.fromRole === 'lender' && !s.hasLender) reject('No lender on this matter to request funds from.');
      // The advance is requested by the certificate of title: never before it.
      if (cmd.fromRole === 'lender' && !s.deeds.certificateOfTitleAt) reject('Send the certificate of title first: the lender releases the advance against it.');
      if (s.waits.some((w) => w.key === 'funds' && w.subject === cmd.fromRole && w.closedAt === null)) reject(`Funds already requested from ${cmd.fromRole}.`);
      // Addendum 2 §5: a person, and the account the payer is told to use must be our VERIFIED client account.
      if (!isUserActor(cmd.actor)) reject('A funds request must be made by a person, never by automation.', 403);
      assertPayableDetails(s, 'firm_client_account', cmd.bankDetailsId);
      return [{ type: 'funds_requested', actor: cmd.actor, payload: { fromRole: cmd.fromRole, amountPennies: cmd.amountPennies ?? null, bankDetailsId: cmd.bankDetailsId, approvedBy: cmd.actor } }];
    }
    case 'funds_received': {
      requireEnrolled(s);
      const inbound = cmd.fromRole === 'buyer_solicitor' || cmd.fromRole === 'incoming_owner';
      // A payer who sent too little sends the rest against the same request: the shortfall issue is what is open, not the wait.
      const topUp = !!(moneyOf(s).received[cmd.fromRole] && openOf(s, 'completion_funds_shortfall', SHORT_PREFIX));
      if (s.completion.confirmedAt) reject('The matter has completed; record any later money as a receipt on client account.');
      if (inbound) {
        if (!fundsFromFor(profile(s).fundsFrom, s.shapes ?? []).includes(cmd.fromRole)) reject(`Money from the ${cmd.fromRole.replace(/_/g, ' ')} does not arise on a ${profile(s).label.toLowerCase()}.`);
        if (!stageAtLeast(s, 'pre_completion')) reject('Completion monies arrive at pre-completion.');
        if (s.completion.fundsReceivedAt && !topUp) reject('Completion monies already recorded.');
      } else if (!topUp && !s.waits.some((w) => w.key === 'funds' && w.subject === cmd.fromRole && w.closedAt === null)) reject(`No outstanding funds request to ${cmd.fromRole}.`);
      if (cmd.amountPennies != null && (!Number.isInteger(cmd.amountPennies) || cmd.amountPennies <= 0)) reject('The amount received must be a positive sum.', 400);
      const nextId = issueIds(s);
      const out: NewEvent[] = [{ type: 'funds_received', actor: cmd.actor, payload: { fromRole: cmd.fromRole, amountPennies: cmd.amountPennies ?? null, remitter: cmd.remitter?.trim() || null, ...(cmd.uncleared ? { uncleared: true, receiptId: `REC-${s.lastSeq + 1}` } : {}) } }];
      if (cmd.amountPennies != null) {
        const received = { ...moneyOf(s).received, [cmd.fromRole]: (moneyOf(s).received[cmd.fromRole] ?? 0) + cmd.amountPennies };
        out.push(...moneyConsequences(s, received, { pricePennies: cmd.contractPricePennies ?? null, depositPennies: cmd.contractDepositPennies ?? null }, nextId, cmd.remitter?.trim() || null));
      }
      // The Help to Buy ISA bonus is for completion, never the exchange deposit (money.md 7.4).
      if (cmd.fromRole === 'isa_provider' && !s.exchange.exchangedAt && s.shapes?.includes('help_to_buy_isa') && !openOf(s, 'isa_bonus', 'Help to Buy ISA bonus before exchange')) out.push(issue(s, nextId(), 'isa_bonus', 'Help to Buy ISA bonus before exchange: not for the deposit', 'The bonus can only go towards completion. Hold it for completion; the exchange deposit must come from the client\'s own money.', 'exchange'));
      // The client's money must come from where the source-of-funds evidence said it was (LSAG 6.17.2; red flag 18.4 "the source changes at the last minute").
      const remitter = cmd.remitter?.trim();
      // A company paying for an individual buyer (money.md 2.4): a third-party payment, and a loan or a distribution the lender may need to know about.
      if (remitter && cmd.fromRole === 'client' && /\b(ltd|limited|plc|llp|holdings|& co|company)\b/i.test(remitter) && !s.shapes?.includes('company_buyer') && !openOf(s, 'aml_kyc_problem', 'A company paid')) {
        out.push(issue(s, nextId(), 'aml_kyc_problem', `A company paid the client's money: ${remitter}`, `The buyer is an individual but the money came from ${remitter}. Establish what it is (a dividend, a director's loan, a bonus) with the company's evidence (accounts, a board minute, the loan agreement), whether the client controls the company, and whether the lender must be told (a loan behind the deposit). Do not complete until it is understood.`, 'completion'));
      }
      if (remitter && cmd.fromRole === 'client') {
        const strangers = strangersAmong(s, remitter);
        if (strangers.length && !Object.values(s.issues).some((i) => i.kind === 'aml_kyc_problem' && i.title.startsWith('Completion money from'))) {
          out.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextId(), kind: 'aml_kyc_problem', title: `Completion money from an account not seen in the evidence: ${remitter}`, detail: `The client's balance arrived from "${remitter}". ${strangers.join(' and ')} ${strangers.length === 1 ? 'was' : 'were'} not the declarant, a named party, or a holder of any statement read for the proof of funds. Establish whose account it is and why the money came from there before completing; consider whether the change of source is a reporting matter.`, gate: 'completion', stage: s.stage, sourceDocumentId: null, origin: null, party: null, severity: 'critical', causedBy: null } });
        }
      }
      return out;
    }
    case 'funds_cleared': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person confirms money has cleared.', 403);
      if (!moneyOf(s).uncleared.some((u) => u.id === cmd.receiptId)) reject('That receipt is not waiting to clear.', 404);
      return [{ type: 'funds_cleared', actor: cmd.actor, payload: { receiptId: cmd.receiptId } }];
    }
    case 'refund_paid': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person records a refund as paid.', 403);
      const r = moneyOf(s).refunds.find((x) => x.id === cmd.refundId);
      if (!r) reject('No such refund on this file.', 404);
      if (r!.paidAt) reject('That refund is already recorded as paid.');
      if (!cmd.reference?.trim()) reject('Give the payment reference.', 400);
      return [{ type: 'refund_paid', actor: cmd.actor, payload: { refundId: cmd.refundId, reference: cmd.reference.trim() } }];
    }
    case 'completion_confirmed': {
      requireEnrolled(s);
      requireStage(s, 'pre_completion', 'Confirming completion');
      moneyMayMove(s, ctx.now, 'No completion');
      // Paying out money that has not cleared is paying with other clients' money (SRA Accounts Rules 5.3).
      const notCleared = moneyOf(s).uncleared;
      if (notCleared.length) reject(`Money has not cleared: ${notCleared.map((u) => `${u.amountPennies != null ? pounds(u.amountPennies) : 'a payment'} from ${ROLE_LABEL[u.fromRole]}`).join(', ')}. Confirm it has cleared first.`);
      // "The seller's solicitor has not confirmed completion" is settled by their confirming it: this command.
      const unconfirmed = issuesGating(s, 'completion').filter((i) => i.event === 'seller_unconfirmed');
      const settled: NewEvent[] = unconfirmed.map((i) => ({ type: 'issue_resolved', actor: cmd.actor, payload: { issueId: i.id, resolution: 'other', note: "The seller's solicitor confirmed completion.", costPennies: null, paidBy: null } }));
      const holdingCompletion = issuesGating(s, 'completion').filter((i) => i.event !== 'seller_unconfirmed');
      if (holdingCompletion.length) reject(`Cannot confirm completion while an issue holds it: ${holdingCompletion.map((i) => `${ISSUE_KIND_SPEC[i.kind].label} — ${i.title}`).join('; ')}.`);
      if (profile(s).side !== 'buyer') {
        const p = profile(s);
        const remo = p.type === 'remortgage';
        if (p.side === 'seller' && !s.deeds.transferDeedAt) reject('The transfer deed (TR1) has not been executed by the seller.');
        if (p.side === 'seller' && !s.completion.fundsReceivedAt) reject("Completion monies have not been received from the buyer's solicitor.");
        if (remo && !s.completion.fundsReceivedAt) reject('The advance has not been received from the lender.');
        if (remo && (!s.deeds.mortgageDeedAt || !s.deeds.certificateOfTitleAt)) reject('The mortgage deed must be executed and the certificate of title sent before completion.');
        // The new lender's pre-completion checks are the same as on a purchase: bankruptcy search, priority search, insurance.
        if (remo) for (const why of lenderChecksUnmet(s, ctx.now)) reject(why);
        if (p.type === 'transfer_of_equity' && !s.deeds.transferDeedAt) reject('The transfer deed has not been executed by every party.');
        if (p.type === 'transfer_of_equity' && deedOfTrustApplies(s) && !s.deeds.deedOfTrustAt) reject('The clients hold as tenants in common: the declaration of trust must be executed before completion.');
        if (p.type === 'transfer_of_equity' && (s.considerationPennies ?? 0) > 0 && !s.completion.fundsReceivedAt) reject('The consideration has not been received from the incoming owner.');
        if (s.hasExistingMortgage && (p.side === 'seller' || remo)) {
          const pend = pendingBankDetailsDecision(s, 'lender');
          if (pend) reject("HARD STOP: the lender's bank details changed and have not been verified out-of-band. The redemption cannot be paid until that decision is resolved.", 423);
          const auth = s.payments.find((x) => x.payeeKind === 'lender');
          if (!auth) reject('No authorised redemption payment: authorise the payment to the lender against verified details first.', 412);
          const cur = currentBankDetails(s, 'lender');
          if (!cur || cur.id !== auth.bankDetailsId || cur.status !== 'verified') reject("HARD STOP: the lender's bank details the payment was authorised against are no longer the current verified record.", 423);
        }
        if (p.side === 'seller' && anythingCharged(s) && !s.undertaking) reject("Give the buyer's solicitor our undertaking to redeem the charges (the reply to their completion information) before completing.");
        // A remortgage or transfer that releases money: the surplus goes to the client and the file cannot close until it has (completion.md 5.3).
        const surplus = p.side === 'owner' ? moneyOf(s).statementBalancePennies ?? 0 : 0;
        const cgtHold = p.side === 'seller' ? s.cgtFacts?.taxRetentionPennies ?? 0 : 0;
        const forTax: NewEvent[] = cgtHold > 0 ? [{ type: 'refund_due', actor: SYSTEM, payload: { refundId: `RF-${moneyOf(s).refunds.length + 1}`, toRole: 'client', to: null, amountPennies: cgtHold, reason: "Held for the client's CGT: pay it to HMRC on their instruction within 60 days, or back to them" } }] : [];
        const toClient: NewEvent[] = surplus > 0 ? [{ type: 'refund_due', actor: SYSTEM, payload: { refundId: `RF-${moneyOf(s).refunds.length + 1}`, toRole: 'client', to: null, amountPennies: surplus, reason: 'The surplus released by the remortgage, per the statement of account' } }] : [];
        return [...settled, { type: 'completion_confirmed', actor: cmd.actor, payload: { completedAt: cmd.completedAt ?? null } }, ...lateCompletion(s, cmd.completedAt ?? null, ctx.now), ...toClient, ...forTax];
      }
      // A purchase completes on paper first: the transfer deed, and with a lender the mortgage deed and the certificate of title.
      if (!s.deeds.transferDeedAt) reject('The transfer deed (TR1) has not been executed.');
      if (s.hasLender && !s.deeds.mortgageDeedAt) reject('The mortgage deed has not been executed (witnessed).');
      if (s.hasLender && !s.deeds.certificateOfTitleAt) reject('The certificate of title has not been sent to the lender; the advance is released against it.');
      // Co-owners: how they hold is their decision, recorded before completion; tenants in common execute the declaration of trust.
      if (s.parties > 1 && !s.clientDecisions.ownership_basis) reject('The clients have not decided how they hold (joint tenants or tenants in common); record the ownership_basis decision before completion.');
      if (deedOfTrustApplies(s) && !s.deeds.deedOfTrustAt) reject('The clients hold as tenants in common: the declaration of trust must be executed before completion.');
      // The Lenders' Handbook's pre-completion checks on a lender-funded purchase: bankruptcy search against every borrower, the priority search, insurance from exchange.
      // Every purchase completes inside a priority period, so nothing can be registered against the title before our application (cash buyers too).
      if (!s.preCompletion.prioritySearchAt) reject('No priority search (OS1) has been made; completion must fall inside its priority period so the purchase registers first.');
      if (s.preCompletion.prioritySearchExpiresAt && Date.parse(s.preCompletion.prioritySearchExpiresAt) < ctx.now.getTime() - 86_400_000) reject(`The priority period of the OS1 expired on ${s.preCompletion.prioritySearchExpiresAt}; make a fresh priority search before completing.`);
      if (s.hasLender) for (const why of lenderChecksUnmet(s, ctx.now)) reject(why);
      // Then the money: the advance from the lender where there is one, and the client's balance (an ISA bonus counts as the client's).
      const from = s.completion.receivedFrom ?? [];
      if (s.hasLender && !from.includes('lender')) reject('The mortgage advance has not been received from the lender.');
      if (!from.includes('client') && !from.includes('isa_provider')) reject("The client's balance has not been received.");
      if (!s.completion.fundsReceivedAt) reject(`Funds have not been received from ${payersExpected(s).filter((r) => !from.includes(r)).map((r) => ROLE_LABEL[r]).join(' and ') || 'everyone asked'}.`);
      // Addendum 2: the completion transfer must have been authorised by a person against
      // verified seller's-solicitor details, and no bank-details change may be pending.
      const pend = pendingBankDetailsDecision(s, 'seller_solicitor');
      if (pend) reject('HARD STOP: the seller\'s solicitor\'s bank details changed and have not been verified out-of-band. Completion cannot be confirmed until that decision is resolved — however urgent.', 423);
      const auth = s.payments.find((p) => p.payeeKind === 'seller_solicitor' && p.purpose === 'completion_monies');
      if (!auth) reject('No authorised completion payment: authorise the transfer against verified bank details first.', 412);
      if (!s.completion.paymentSent) reject('Record the completion money as sent (with its CHAPS reference) first.');
      const cur = currentBankDetails(s, 'seller_solicitor');
      if (!cur || cur.id !== auth.bankDetailsId || cur.status !== 'verified') reject('HARD STOP: the bank details the payment was authorised against are no longer the current verified record.', 423);
      // The seller's charges come off only on their solicitor's undertaking (TA13): never complete without it.
      if (!s.completionInformation) reject("The seller's solicitor's replies to completion information (TA13) are not on file.");
      if (sellerTitleCharged(s) && !s.completionInformation.undertakingToRedeem) reject("The seller's title is charged and their solicitor has not undertaken to redeem it (TA13).");
      const completed: NewEvent[] = [...settled, { type: 'completion_confirmed', actor: cmd.actor, payload: { completedAt: cmd.completedAt ?? null } }, ...lateCompletion(s, cmd.completedAt ?? null, ctx.now)];
      // Leasehold: what the landlord requires on assignment (deed of covenant, certificate of compliance for a restriction) is owed after completion and before the AP1 can go in clean.
      const consents = s.managementPack.facts?.consentsRequired?.trim();
      // Each thing the landlord or management company requires is its own task (completion.md 6.19).
      const parts = consents ? [
        /deed of covenant/i.test(consents) && ['After completion: deed of covenant', 'Sign the deed of covenant with the landlord or management company (the buyer covenants to observe the lease) and get it back completed; its fee is on the statement.'],
        /share|member|stock transfer/i.test(consents) && ['After completion: management company share', "Get the seller's share certificate and a signed stock transfer form at completion; send them to the company secretary for the buyer to be entered in the register of members and a new certificate issued."],
        /certificate of compliance|restriction|consent/i.test(consents) && ['After completion: certificate of compliance', 'The register carries a restriction: get the certificate of compliance (or the consent) from the landlord or management company and send it with the AP1, or HM Land Registry will requisition it.'],
      ].filter((x): x is [string, string] => !!x) : [];
      if (isLeasehold(s) && parts.length) {
        for (const [title, detail] of parts) if (!openOf(s, 'missing_consent', title)) completed.push(issueWith(s, issueIds(s, completed)(), 'missing_consent', title, `${detail} (The management pack: "${consents!.slice(0, 200)}".)`, 'none', 'warning'));
      } else if (isLeasehold(s) && consents && !Object.values(s.issues).some((i) => i.kind === 'missing_consent' && i.title.startsWith('After completion:'))) {
        completed.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextIssueId(s), kind: 'missing_consent', title: `After completion: ${consents}`, detail: 'The management pack says the landlord or management company requires this on assignment. A deed of covenant or share transfer is signed at or after completion; a certificate of compliance is needed with the AP1 where the register carries a restriction, or HM Land Registry will raise a requisition. Pay the fee quoted in the pack.', gate: 'none', stage: 'completed', sourceDocumentId: s.managementPack.documentId, origin: null, party: null, severity: 'warning', causedBy: null } });
      }
      return completed;
    }

    // ── Post-completion ──
    case 'sdlt_submitted': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'completed', 'SDLT submission');
      requireSide(s, ['buyer', 'owner'], 'An SDLT return');
      if (s.postCompletion.sdltSubmittedAt) reject('SDLT return already submitted.');
      if (s.sdltNotRequiredAt) reject('SDLT was recorded as not required; record a correction if that was wrong.');
      const filed: NewEvent[] = [{ type: 'sdlt_submitted', actor: cmd.actor, payload: { reference: cmd.reference ?? null, amountPennies: cmd.amountPennies ?? null, paidOn: cmd.paidOn ?? null } }];
      // The tax filed against the estimate the client was asked for (tax.md H3): a difference is the client's money.
      const c = chargeableConsideration(s);
      const est = c ? computeSdlt(c, { ...(s.sdltBasis ?? { firstTimeBuyer: false, additionalProperty: false, nonUkResident: false }), company: s.shapes?.includes('company_buyer') ?? false }).totalPennies : null;
      if (cmd.amountPennies != null && est != null && Math.abs(cmd.amountPennies - est) >= 100) {
        const diff = cmd.amountPennies - est;
        filed.push(issue(s, issueIds(s)(), diff > 0 ? 'completion_funds_shortfall' : 'other', `SDLT filed at ${pounds(cmd.amountPennies)}, ${pounds(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the estimate`, diff > 0 ? 'The client was asked for less than the tax: ask them for the difference now (HMRC charges interest from the filing date), and check the return\'s basis.' : 'The client paid more than the tax: the difference goes back to them with the final statement.', 'none'));
      }
      return filed;
    }
    case 'sdlt_amended': {
      // A return amended (tax.md H4, H5): within 12 months of filing by amendment; after that, an overpayment relief claim within four years.
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person records this.', 403);
      const filedAt = s.postCompletion.sdltSubmittedAt;
      if (!filedAt) reject('No return has been filed.');
      if (!cmd.reason?.trim()) reject('Say why it was amended.', 400);
      if (!Number.isInteger(cmd.newAmountPennies) || cmd.newAmountPennies < 0) reject('Give the new figure.', 400);
      const months = (ctx.now.getTime() - Date.parse(filedAt)) / (30.44 * 86_400_000);
      if (months > 48) reject('Over four years since filing: an overpayment relief claim is out of time.');
      const route = months <= 12 ? 'amendment' : 'overpayment relief claim';
      const before = s.sdltFiledPennies ?? null;
      const out: NewEvent[] = [{ type: 'sdlt_amended', actor: cmd.actor, payload: { newAmountPennies: cmd.newAmountPennies, previousPennies: before, reason: cmd.reason.trim(), route } }];
      if (before != null && cmd.newAmountPennies < before) out.push({ type: 'refund_due', actor: SYSTEM, payload: { refundId: `RF-${moneyOf(s).refunds.length + 1}`, toRole: 'client', to: null, amountPennies: before - cmd.newAmountPennies, reason: `SDLT refund from HMRC (${route}): ${cmd.reason.trim().slice(0, 80)}` } });
      if (before != null && cmd.newAmountPennies > before) out.push(issue(s, issueIds(s)(), 'completion_funds_shortfall', `SDLT amended up by ${pounds(cmd.newAmountPennies - before)}`, 'The extra tax and interest are due to HMRC now: ask the client for the money.', 'none'));
      return out;
    }
    case 'ap1_submitted': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'completed', 'AP1 submission');
      if (profile(s).registration !== 'ap1') reject(`No application to register on a ${profile(s).label.toLowerCase()} — the buyer's solicitor registers; we discharge.`);
      if (s.postCompletion.ap1SubmittedAt) reject('AP1 already submitted.');
      // HM Land Registry needs the SDLT5 (or a return that was not required) with an application for a transfer; a remortgage has none.
      if ((profile(s).side === 'buyer' || s.transactionType === 'transfer_of_equity') && !s.postCompletion.sdltSubmittedAt && !s.sdltNotRequiredAt) reject('The SDLT return has not been filed, nor recorded as not required; HM Land Registry needs the SDLT5 with the AP1.');
      const lodged: NewEvent[] = [{ type: 'ap1_submitted', actor: cmd.actor, payload: { reference: cmd.reference ?? null } }];
      // Lodged after the priority period ended: anything registered in between ranks ahead. Not refused (it must still go in), but a person looks now.
      const exp = s.preCompletion.prioritySearchExpiresAt;
      if (exp && Date.parse(exp) < ctx.now.getTime() - 86_400_000) lodged.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextIssueId(s), kind: 'title_defect', title: `AP1 lodged after the priority period ended (${exp})`, detail: 'The OS1 priority period had expired when the application was lodged. Check the register for anything entered since the search and, with a lender, tell them: their charge may not rank first.', gate: 'none', stage: s.stage, sourceDocumentId: null, origin: null, party: null, severity: 'critical', causedBy: null } });
      return lodged;
    }
    case 'ap1_confirmed': {
      requireEnrolled(s);
      if (!s.postCompletion.ap1SubmittedAt) reject('AP1 has not been submitted.');
      if (s.postCompletion.ap1ConfirmedAt) reject('Registration already confirmed.');
      if (s.postCompletion.requisitions.some((r) => !r.respondedAt)) reject('An HMLR requisition is still unanswered; registration cannot complete until it is.');
      return [{ type: 'ap1_confirmed', actor: cmd.actor, payload: { titleNumber: cmd.titleNumber ?? null } }];
    }

    // ── Payment verification (addendum 2) ──
    case 'record_bank_details': {
      requireEnrolled(s);
      if (!/^\d{6}$/.test(cmd.details.sortCode) || !/^\d{8}$/.test(cmd.details.accountNumber)) reject('Sort code must be 6 digits and account number 8 digits.', 400);
      if (!cmd.details.accountName.trim()) reject('Account name is required.', 400);
      if (s.bankDetails[cmd.bankDetailsId]) reject('Duplicate bank-details record id.', 400);
      const previous = currentBankDetails(s, cmd.payeeKind);
      const isChange = !!previous;
      const same = previous && previous.details.sortCode === cmd.details.sortCode && previous.details.accountNumber === cmd.details.accountNumber && previous.status === 'verified';
      if (same) reject('These details are already on file and verified for this payee; nothing to record.', 409);
      const recorded: NewEvent = {
        type: 'bank_details_recorded',
        actor: cmd.actor,
        payload: { bankDetailsId: cmd.bankDetailsId, payeeKind: cmd.payeeKind, payeeRef: cmd.payeeRef ?? null, details: cmd.details, sourceChannel: cmd.sourceChannel, supersedesId: previous?.id ?? null, isChange },
        sourceDocumentId: cmd.sourceDocumentId,
      };
      // Every set or change is a hard-stop decision — first-time details get the same scrutiny (§4).
      const label = cmd.payeeKind.replace(/_/g, ' ');
      const decision: DecisionSpec = {
        kind: 'bank_details',
        summary: [
          `${isChange ? 'CHANGE OF BANK DETAILS' : 'NEW BANK DETAILS'} for ${label}${cmd.payeeRef ? ` (${cmd.payeeRef})` : ''} — received via ${cmd.sourceChannel}.`,
          `New: ${maskAccount(cmd.details)}${cmd.details.firmName ? ` · ${cmd.details.firmName}` : ''}`,
          previous ? `Previously on file: ${maskAccount(previous.details)} (${previous.status})` : 'No details were previously on file for this payee.',
          '',
          ...(/solicitor/.test(cmd.payeeKind) ? ['Check the firm itself first (cloned firms are common): find it on the SRA register or the Law Society\'s Find a Solicitor, and use the number and office shown there, not the letterhead. Record the SRA number or the Lawyer Checker reference.', ''] : []),
          'This is a mandatory hard-stop. No payment to or for this payee can proceed until the details are verified OUT-OF-BAND — a phone call back to a number you already hold, a Lawyer Checker match, or in person. A reply on the channel the details arrived on is not verification. Urgency ("completion is tomorrow") is the fraud pattern, not a reason to skip this.',
          `Options: ${OPTIONS_FOR.bank_details.map(optionLabel).join(' · ')}.`,
        ].join('\n'),
        sourceDocumentId: cmd.sourceDocumentId,
        citations: [{ documentId: cmd.sourceDocumentId, label: `Where the details arrived (${cmd.sourceChannel})` }],
        options: OPTIONS_FOR.bank_details,
        summarisedBy: 'template',
      };
      assertDecisionSpec(decision);
      const flagged: NewEvent = { type: 'bank_details_change_flagged', actor: AI, payload: { bankDetailsId: cmd.bankDetailsId, payeeKind: cmd.payeeKind, isChange, previous: previous ? maskAccount(previous.details) : null, decision }, sourceDocumentId: cmd.sourceDocumentId };
      return [recorded, flagged];
    }
    case 'payment_authorised': {
      moneyMayMove(s, ctx.now, 'No payment');
      if (cmd.purpose === 'completion_monies' && moneyOf(s).uncleared.length) reject("The completion money cannot go out while some of what came in has not cleared: confirm it has cleared first.");
      requireEnrolled(s);
      requireStageAtLeast(s, 'pre_exchange', 'Authorising a payment');
      if (!isUserActor(cmd.actor)) reject('A payment can only be authorised by a person, never by automation.', 403);
      assertPayableDetails(s, cmd.payeeKind, cmd.bankDetailsId);
      if (cmd.purpose === 'completion_monies' && s.payments.some((p) => p.payeeKind === cmd.payeeKind && p.purpose === 'completion_monies')) reject('Completion monies already authorised for this payee.');
      // Never more than the money held for this client (completion.md 3.4): client account money is not pooled.
      if (cmd.amountPennies != null) {
        const inHand = Object.values(moneyOf(s).received).reduce((a, b) => a + (b ?? 0), 0) + (s.deposit.received ? s.deposit.amountPennies ?? 0 : 0);
        const out = s.payments.reduce((a, p) => a + (p.amountPennies ?? 0), 0);
        const held = inHand - out;
        if (Object.keys(moneyOf(s).received).length && cmd.amountPennies > held) reject(`That is more than the money held for this client (${pounds(Math.max(0, held))} after what is already authorised): another client's money cannot be used.`, 412);
      }
      return [{ type: 'payment_authorised', actor: cmd.actor, payload: { payeeKind: cmd.payeeKind, bankDetailsId: cmd.bankDetailsId, amountPennies: cmd.amountPennies ?? null, purpose: cmd.purpose, approvedBy: cmd.actor } }];
    }

    // ── eventualities ──
    case 'abandon_matter': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Only a person can abandon a matter.', 403);
      if (!ABANDON_REASONS.includes(cmd.reason)) reject(`Unknown abandonment reason "${cmd.reason}".`, 400);
      if (s.completion.confirmedAt) reject('The purchase has completed; it cannot be abandoned. Record a correction if the completion event was wrong.');
      // Rescission follows an expired notice to complete (SCS 7.4 / 7.5): nothing else ends an exchanged contract this way.
      if (cmd.reason === 'rescinded' && !(s.noticeToComplete && Date.parse(s.noticeToComplete.expiresAt) < ctx.now.getTime())) reject('Rescission follows an expired notice to complete: serve one (or record the one served) and wait for it to expire.');
      // Whatever we hold goes back where it came from (LSAG: returning money to a different account is a red flag).
      const held = heldOnAbandon(s).map((h, n): NewEvent => ({ type: 'refund_due', actor: SYSTEM, payload: { refundId: `RF-${moneyOf(s).refunds.length + n + 1}`, toRole: h.toRole, to: null, amountPennies: h.amountPennies, reason: h.reason } }));
      return [{ type: 'matter_abandoned', actor: cmd.actor, payload: { reason: cmd.reason, detail: cmd.detail ?? null, stage: s.stage } }, ...held];
    }
    case 'record_contract_filed': {
      requireEnrolled(s);
      return [{ type: 'contract_filed', actor: EXTERNAL, payload: { documentId: cmd.documentId, points: cmd.points }, sourceDocumentId: cmd.documentId }];
    }
    case 'raise_contract_review': {
      requireEnrolled(s);
      if (s.exchange.exchangedAt || s.readiness.contractApprovedAt) reject('The contract is already approved.');
      if (Object.values(s.decisions).some((d) => d.kind === 'contract' && d.status === 'pending' && d.sourceDocumentId === cmd.documentId)) reject('This contract is already waiting for approval.');
      const decision: DecisionSpec = { kind: 'contract', summary: cmd.summary, sourceDocumentId: cmd.documentId, citations: cmd.citations ?? [], options: OPTIONS_FOR.contract, summarisedBy: 'template' };
      return [
        { type: 'contract_review_raised', actor: SYSTEM, payload: { documentId: cmd.documentId, decision, depositPennies: cmd.terms?.depositPennies ?? null, terms: (cmd.terms ?? null) as Partial<ContractFacts> | null }, sourceDocumentId: cmd.documentId },
        ...(cmd.terms ? findingEvents(s, contractFindings(cmd.terms, findingContext(s)), cmd.documentId) : []),
        // An amended contract is not the one the client authorised (exchange.md 4.2).
        ...(s.readiness.contractDocumentId && s.readiness.contractDocumentId !== cmd.documentId ? lapseExchangeAuthority(s, 'the contract was amended') : []),
        // A conditional contract carries its long-stop date: on the case, so the timer watches it.
        ...(() => { const d = cmd.terms ? conditionalLongStop(cmd.terms.specialConditions ?? []) : null; return d && d !== s.longStopDate ? [{ type: 'longstop_date_recorded', actor: SYSTEM, payload: { date: d } } as NewEvent] : []; })(),
      ];
    }
    case 'set_clients': {
      requireEnrolled(s);
      if (s.completion.confirmedAt) reject('The matter has completed; the clients are on the record as they were.');
      const names = [...new Set(cmd.names.map((n) => n.trim()).filter(Boolean))];
      if (!names.length) reject('A case needs at least one client.', 400);
      const was = s.partyNames ?? [];
      if (names.length === was.length && names.every((n, i) => n === was[i])) reject('The clients are unchanged.');
      const side = profileOf(s.transactionType).side;
      const role: IdPartyCheck['role'] = side === 'seller' ? 'seller' : side === 'owner' ? 'owner' : 'buyer';
      const out: NewEvent[] = [{ type: 'clients_updated', actor: cmd.actor, payload: { partyNames: names, previous: was, role, reason: cmd.reason?.trim() || null } }];
      // Every client beyond the first is identified in their own right, as at enrolment.
      for (const name of names.slice(1)) if (!s.partyChecks[partyId(role, name)]) out.push({ type: 'id_party_added', actor: cmd.actor, payload: { party: partyId(role, name), label: name, role } });
      // A name typed differently is not a change of client; adding or removing someone is.
      if (s.enrolled && was.length && (names.some((n) => !was.includes(n)) || was.some((n) => !names.includes(n))) && !(names.length === was.length && cmd.reason && /spell|typo|name change|married|correct/i.test(cmd.reason))) out.push(...consequencesOfClientChange(s, names, was));
      return out;
    }
    case 'set_target_dates': {
      requireEnrolled(s);
      if (s.exchange.exchangedAt) reject('Contracts are exchanged: the completion date is contractual now — use change_completion_date.');
      const targetExchangeDate = cmd.targetExchangeDate === undefined ? s.targetExchangeDate : cmd.targetExchangeDate;
      const targetCompletionDate = cmd.targetCompletionDate === undefined ? s.targetCompletionDate : cmd.targetCompletionDate;
      for (const d of [targetExchangeDate, targetCompletionDate]) if (d && Number.isNaN(Date.parse(d))) reject('Dates must be YYYY-MM-DD.', 400);
      if (targetExchangeDate === s.targetExchangeDate && targetCompletionDate === s.targetCompletionDate) reject('Target dates are unchanged.');
      return [{ type: 'target_dates_changed', actor: cmd.actor, payload: { targetExchangeDate, targetCompletionDate, reason: cmd.reason ?? null, previous: { targetExchangeDate: s.targetExchangeDate, targetCompletionDate: s.targetCompletionDate } } }];
    }
    case 'set_signing_method': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('How a deed is signed is set by a person.', 403);
      if (!(SIGNED_DOCUMENTS as readonly string[]).includes(cmd.document)) reject(`Unknown document "${cmd.document}".`, 400);
      if (cmd.method !== 'wet' && cmd.method !== 'electronic') reject('Wet ink or electronic.', 400);
      if (deedSigned(s, cmd.document)) reject(`The ${SIGNED_DOCUMENT_LABEL[cmd.document].toLowerCase()} is already signed.`);
      if (s.signing.envelopes[cmd.document] && cmd.method === 'wet') reject('It is out for electronic signature already; cancel that with the provider first, then switch.');
      return [{ type: 'signing_method_set', actor: cmd.actor, payload: { document: cmd.document, method: cmd.method, reason: cmd.reason?.trim() || null } }];
    }
    case 'record_signing_pack_sent': {
      requireEnrolled(s);
      if (!cmd.documents.length) reject('Nothing to sign on this case.');
      return [{ type: 'signing_pack_sent', actor: SYSTEM, payload: { documents: cmd.documents, methods: cmd.methods, attached: cmd.attached, channel: cmd.channel, messageId: cmd.messageId } }];
    }
    case 'record_signing_envelope': {
      requireEnrolled(s);
      return [{ type: 'signing_envelope_sent', actor: SYSTEM, payload: { document: cmd.document, provider: cmd.provider, envelopeId: cmd.envelopeId } }];
    }
    case 'record_supporting_document': {
      requireEnrolled(s);
      const out: NewEvent[] = [{ type: 'supporting_document_read', actor: SYSTEM, payload: { facts: cmd.facts }, sourceDocumentId: cmd.documentId }];
      // An open issue it may answer (works without consents, a missing certificate or guarantee) is pointed at it; a person decides.
      const answers: Record<string, string[]> = { planning_permission: ['building_regs_missing', 'planning_permission_missing', 'document_missing', 'disclosure_concern'], building_regs: ['building_regs_missing', 'document_missing', 'disclosure_concern'], certificate: ['document_missing', 'building_regs_missing', 'disclosure_concern'], guarantee: ['document_missing', 'disclosure_concern'], indemnity_policy: ['building_regs_missing', 'planning_breach', 'restrictive_covenant_breach', 'document_missing', 'disclosure_concern'] };
      for (const i of openIssues(s).filter((x) => (answers[cmd.facts.kind] ?? []).includes(x.kind))) {
        out.push({ type: 'issue_updated', actor: SYSTEM, payload: { issueId: i.id, status: i.status as 'open' | 'negotiating', note: `A document on the file may answer this: ${cmd.facts.title || cmd.facts.kind.replace(/_/g, ' ')}${cmd.facts.covers ? ` (${cmd.facts.covers.slice(0, 120)})` : ''}.`, gate: null } });
      }
      return out;
    }
    case 'record_title_plan': {
      requireEnrolled(s);
      return [{ type: 'title_plan_read', actor: SYSTEM, payload: { facts: cmd.facts }, sourceDocumentId: cmd.documentId }];
    }
    case 'open_expectation': {
      requireEnrolled(s);
      if (!expectationDue(s, cmd.key)) reject(`Nothing to expect for ${cmd.key.replace(/_/g, ' ')} on this case.`);
      return [{ type: 'expectation_opened', actor: SYSTEM, payload: { key: cmd.key } }];
    }
    case 'set_funding': {
      if (s.exchange.release && Date.parse(s.exchange.release.until) > ctx.now.getTime()) reject('A Formula C release is live: nothing in the deal may change until it lapses or contracts are exchanged.');
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('How the purchase is funded is set by a person.', 403);
      if (!isPurchase(s)) reject('Only a purchase changes between cash and a mortgage.');
      if (s.exchange.exchangedAt) reject('Contracts are exchanged; the funding is fixed.');
      if (!!s.hasLender === cmd.hasLender) reject(cmd.hasLender ? 'This purchase already has a mortgage.' : 'This is already a cash purchase.');
      if (!cmd.reason?.trim()) reject('Say why the funding changed.', 400);
      const funded: NewEvent[] = [{ type: 'funding_changed', actor: cmd.actor, payload: { hasLender: cmd.hasLender, reason: cmd.reason.trim() } }];
      // The funds were evidenced for the old plan: a mortgage dropped means the whole price from the clients' own money; one added means the lender must know where the deposit comes from.
      if (s.proofOfFunds.status !== 'not_started' && !openOf(s, 'source_of_funds', 'Funds: re-evidence')) funded.push(issue(s, nextIssueId(s), 'source_of_funds', `Funds: re-evidence for ${cmd.hasLender ? 'a mortgage purchase' : 'a cash purchase'}`, cmd.hasLender ? 'The purchase now has a mortgage: the deposit and costs are still the clients\' own money to evidence, and the lender will ask where the deposit comes from.' : 'The purchase is now cash: the whole price, SDLT and costs come from the clients\' own money. Evidence the new total with a further proof-of-funds round.', 'exchange'));
      funded.push(...lapseExchangeAuthority(s, cmd.hasLender ? 'the purchase is now funded by a mortgage' : 'the purchase is now a cash purchase'));
      return funded;
    }
    case 'record_survey_plan': {
      requireEnrolled(s);
      if (!isPurchase(s)) reject('A survey is the buyer\'s.');
      if (s.exchange.exchangedAt) reject('Contracts are exchanged; the survey no longer changes anything.');
      if (cmd.plan === 'booked' && cmd.date && !/^\d{4}-\d{2}-\d{2}$/.test(cmd.date)) reject('The date must be YYYY-MM-DD.', 400);
      const recorded: NewEvent = { type: 'survey_plan_recorded', actor: cmd.actor, payload: { plan: cmd.plan, date: cmd.plan === 'booked' ? cmd.date ?? null : null, note: cmd.note?.trim() || null } };
      // No survey: the client relies on the lender's valuation, which is not a survey; advise in writing and record it (exchange.md 4.4).
      if (cmd.plan === 'none' && !Object.values(s.issues).some((i) => i.title.startsWith('No survey'))) return [recorded, issue(s, issueIds(s)(), 'other', 'No survey: advise the client in writing', `The client has chosen not to have a survey. Tell them in writing that ${s.hasLender ? "the lender's valuation is for the lender and is not a survey: " : ''}defects a survey would have found are theirs after exchange. Resolve as accepted as is once the advice has gone.`, 'none')];
      return [recorded];
    }
    case 'record_client_progress': {
      // "I've posted the signed contract": noted against the wait, which is not chased again until it has had time to arrive. Nothing is cleared.
      requireEnrolled(s);
      const w = s.waits.find((x) => x.key === cmd.waitKey && (x.subject ?? '') === (cmd.subject ?? '') && x.closedAt === null);
      if (!w) reject(`Nothing is being waited for as ${cmd.waitKey.replace(/_/g, ' ')}${cmd.subject ? ` (${cmd.subject})` : ''}: it may already have arrived.`, 409);
      if (!cmd.claim?.trim()) reject('Say what they reported.', 400);
      if (cmd.expectBy && (!/^\d{4}-\d{2}-\d{2}$/.test(cmd.expectBy) || Number.isNaN(Date.parse(cmd.expectBy)))) reject('The expected date must be YYYY-MM-DD.', 400);
      const until = cmd.expectBy ?? addWorkingDays(ctx.now, 3).toISOString().slice(0, 10);
      return [{ type: 'wait_progress_reported', actor: cmd.actor, payload: { waitKey: cmd.waitKey, subject: cmd.subject ?? '', claim: cmd.claim.trim().slice(0, 400), until, noteId: cmd.noteId ?? null } }];
    }
    case 'record_chain_link': {
      // A light record of each link further along the chain (exchange.md 8.6): who, and whether they are ready.
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person records this.', 403);
      if (!cmd.label?.trim()) reject('Who is it (the buyer of our seller, the seller above)?', 400);
      if (s.exchange.exchangedAt) reject('Contracts are exchanged: the chain is fixed.');
      const links = s.chainLinks ?? [];
      const id = cmd.linkId ?? `L${links.length + 1}`;
      if (cmd.linkId && !links.some((l) => l.id === cmd.linkId)) reject('Chain link not found.', 404);
      if (!cmd.linkId && cmd.status === 'removed') reject('Nothing to remove.', 400);
      return [{ type: 'chain_link_recorded', actor: cmd.actor, payload: { linkId: id, label: cmd.label.trim().slice(0, 120), status: cmd.status, note: cmd.note?.trim() || null } }];
    }
    case 'record_chain_consent': {
      // Whether the other side may hear about our client's own sale or purchase: the client's say-so only.
      if (!!s.shareChain === cmd.given) reject(cmd.given ? 'The client has already said we may share their chain position.' : 'The chain position is already not shared.', 409);
      return [{ type: 'chain_consent_recorded', actor: cmd.actor, payload: { given: cmd.given, reason: cmd.reason?.trim() || null, noteId: cmd.noteId ?? null } }];
    }
    case 'set_file_delivery': {
      // How files reach this client: a secure link unless they asked for attachments.
      if (cmd.mode !== 'attachments' && cmd.mode !== 'link') reject('Files go as a secure link or as attachments.', 400);
      if ((s.fileDelivery ?? 'link') === cmd.mode) reject(`Files already go to this client ${cmd.mode === 'link' ? 'as a secure link' : 'as attachments'}.`, 409);
      return [{ type: 'file_delivery_set', actor: cmd.actor, payload: { mode: cmd.mode, reason: cmd.reason?.trim() || null, noteId: cmd.noteId ?? null } }];
    }
    case 'record_availability': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Availability is recorded by a person.', 403);
      if (!AVAILABILITY_PARTIES.includes(cmd.party)) reject(`Unknown party "${cmd.party}".`, 400);
      for (const d of [cmd.from, cmd.until]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) reject('Dates must be YYYY-MM-DD.', 400);
      if (cmd.until < cmd.from) reject('The end of the period is before its start.', 400);
      const id = `AV-${String((s.availability ?? []).length + 1).padStart(3, '0')}`;
      const out: NewEvent[] = [{ type: 'availability_recorded', actor: cmd.actor, payload: { id, party: cmd.party, from: cmd.from, until: cmd.until, note: cmd.note?.trim() || '' } }];
      // The client away when their signature is needed (exchange.md 3.4): sign before they go, sign by power of attorney, or move the date.
      if (cmd.party === 'client') {
        const within = (d: string | null | undefined) => !!d && cmd.from <= d.slice(0, 10) && d.slice(0, 10) <= cmd.until;
        const exchangeDay = s.exchange.exchangedAt ? null : s.targetExchangeDate;
        const needsContract = !s.readiness.signedContractHeldAt && profile(s).hasExchange && within(exchangeDay);
        const needsTransfer = !s.deeds.transferDeedAt && (profile(s).side === 'seller' || s.transactionType === 'transfer_of_equity') && within(s.exchange.completionDate ?? s.targetCompletionDate);
        if (needsContract || needsTransfer) out.push(issue(s, issueIds(s)(), 'document_execution_problem', `The client is away ${cmd.from} to ${cmd.until}, over the ${needsContract ? 'exchange' : 'completion'} date`, `Their ${needsContract ? 'signed contract' : 'signed transfer'} is not in. Have them sign before they go (the document held undated), sign under a power of attorney, or agree a new date with the other side.`, s.exchange.exchangedAt ? 'completion' : 'exchange'));
      }
      return out;
    }
    case 'change_completion_date': {
      requireEnrolled(s);
      if (!s.exchange.exchangedAt) reject('Contracts are not exchanged; set target dates instead.');
      if (s.completion.confirmedAt) reject('Completion has already been confirmed.');
      if (Number.isNaN(Date.parse(cmd.completionDate))) reject('A valid completion date is required.', 400);
      if (cmd.completionDate === s.exchange.completionDate) reject('The completion date is unchanged.');
      { const dateWrong = completionDateProblem(s, cmd.completionDate, ctx.now); if (dateWrong) reject(dateWrong, 400); }
      if (s.lenderRequirements?.maxSearchAgeMonths != null) { const stale = staleAtCompletion(s, cmd.completionDate); if (stale.length) reject(`On ${cmd.completionDate} ${stale.join(', ')} will be older than the lender allows (${s.lenderRequirements.maxSearchAgeMonths} months): re-order before moving the date.`); }
      const moved: NewEvent[] = [{ type: 'completion_date_changed', actor: cmd.actor, payload: { from: s.exchange.completionDate ?? '', to: cmd.completionDate, reason: cmd.reason ?? null } }];
      // Everything dated to the old completion day follows it: the statement's apportionments and daily interest, the lender's certificate, the advance already sent, the linked case.
      const next = issueIds(s);
      // The redemption figure runs to a day: a later completion adds a day's interest for each day (completion.md 4.3).
      const red = s.redemption;
      if (red.status === 'received' && red.redemptionPennies != null && red.dailyInterestPennies && (red.figureDate ?? s.exchange.completionDate)) {
        const days = Math.round((Date.parse(cmd.completionDate) - Date.parse((red.figureDate ?? s.exchange.completionDate)!)) / 86_400_000);
        if (days) moved.push({ type: 'redemption_figure_adjusted', actor: SYSTEM, payload: { redemptionPennies: red.redemptionPennies + days * red.dailyInterestPennies, days, reason: `completion moved to ${prettyDate(cmd.completionDate)}: ${days} day${Math.abs(days) === 1 ? '' : 's'} at ${pounds(red.dailyInterestPennies)} a day` } });
        if (red.validUntil && cmd.completionDate > red.validUntil) moved.push(issue(s, next(), 'redemption_statement_expired', `Redemption statement: valid until ${prettyDate(red.validUntil)}, completion now ${prettyDate(cmd.completionDate)}`, 'Ask the lender for a statement to the new completion date; the payment authorised to the lender must match it.', 'completion'));
      }
      if (s.completion.statementGeneratedAt) moved.push(issue(s, next(), 'completion_funds_shortfall', `Completion statement: re-issue for ${prettyDate(cmd.completionDate)}`, 'Apportionments, the redemption figure\'s daily interest and any interest on the deposit were worked to the old date. Re-issue the statement and tell the client if the balance changed.', 'completion'));
      if (s.deeds.certificateOfTitleAt) moved.push(issue(s, next(), 'lender_funds_delayed', `Tell the lender: completion moved to ${prettyDate(cmd.completionDate)}`, (s.completion.receivedFrom ?? []).includes('lender') ? 'The advance is already with us for the old date. Most lenders want it returned if completion slips beyond their Part 2 period (often one to five working days), or interest is charged: check the lender\'s instructions and return it or get consent to hold it.' : 'The certificate of title named the old date: send the lender the new date so the advance is released for it.', 'completion'));
      // The priority period no longer covers the new date: a fresh OS1 now, not two days before (completion.md 1.4).
      if (s.preCompletion.prioritySearchExpiresAt && cmd.completionDate.slice(0, 10) >= s.preCompletion.prioritySearchExpiresAt.slice(0, 10)) moved.push(issue(s, next(), 'title_defect', `Priority search ends ${s.preCompletion.prioritySearchExpiresAt.slice(0, 10)}, before the new completion date`, `Make a fresh OS1 now, so the priority period runs past ${cmd.completionDate} with time to lodge the AP1.`, 'completion'));
      if (s.relatedMatter) moved.push(issue(s, next(), 'chain_dependency', `Linked case: move its completion date to ${cmd.completionDate} too`, 'The client\'s sale and purchase complete on the same day: the other case\'s date must move with this one, with its other side\'s agreement.', 'completion'));
      return moved;
    }
    case 'notice_to_complete_served': {
      requireEnrolled(s);
      if (!s.exchange.exchangedAt) reject('A notice to complete can only follow exchange.');
      if (s.completion.confirmedAt) reject('Completion has already been confirmed.');
      if (s.noticeToComplete) reject('A notice to complete is already on file.');
      if (Number.isNaN(Date.parse(cmd.expiresAt))) reject('A valid expiry date is required.', 400);
      const servedAt = cmd.servedAt ?? ctx.now.toISOString();
      const decision: DecisionSpec = {
        kind: 'escalation',
        summary: `NOTICE TO COMPLETE served by the ${cmd.servedBy} on ${servedAt.slice(0, 10)}, expiring ${cmd.expiresAt.slice(0, 10)}. Completion must take place by then; the ${cmd.servedBy === 'seller' ? 'seller may then rescind and keep the deposit' : 'buyer may then rescind and recover the deposit'}. Decide today what has to happen (funds, undertakings, the other side) and who needs telling.`,
        sourceDocumentId: cmd.documentId,
        citations: [{ documentId: cmd.documentId, label: 'The notice to complete' }],
        options: OPTIONS_FOR.escalation,
        summarisedBy: 'template',
      };
      assertDecisionSpec(decision);
      const out: NewEvent[] = [{ type: 'notice_to_complete_served', actor: cmd.actor, payload: { servedBy: cmd.servedBy, servedAt, expiresAt: cmd.expiresAt, decision }, sourceDocumentId: cmd.documentId }];
      // Served on our client: what they stand to lose if it expires (exchange.md 7.4).
      const side = profile(s).side;
      if ((side === 'buyer' && cmd.servedBy === 'seller') || (side === 'seller' && cmd.servedBy === 'buyer')) {
        const price = s.purchasePricePennies ?? null;
        const tenth = price ? Math.round(price / 10) : null;
        const detail = side === 'buyer'
          ? `If our client has not completed by ${cmd.expiresAt.slice(0, 10)}, the seller may rescind and keep the deposit${tenth ? `, made up to 10% of the price (${pounds(tenth)})` : ''}, resell, and claim any further loss (SCS 7.4). Find out today what is stopping completion (money, the lender, the chain), tell the client in writing what is at stake, and keep the seller's solicitor informed.`
          : `If our client has not completed by ${cmd.expiresAt.slice(0, 10)}, the buyer may rescind, recover the deposit with interest, and claim their losses (SCS 7.5). Find out today what is stopping completion (vacant possession, the redemption, the chain) and tell the client in writing what is at stake.`;
        const raised = issue(s, issueIds(s)(), 'completion_failure', `Notice to complete served on our client: expires ${cmd.expiresAt.slice(0, 10)}`, detail, 'completion');
        out.push({ ...raised, payload: { ...(raised.payload as object), severity: 'critical' } } as NewEvent);
      }
      return out;
    }
    case 'mortgage_offer_withdrawn': {
      requireEnrolled(s);
      if (!s.hasLender) reject('Cash purchase — there is no mortgage offer to withdraw.');
      if (s.mortgage.status === 'awaiting' || s.mortgage.status === 'not_required') reject('No mortgage offer is on file.');
      // After exchange the client is still bound to complete: the offer going is an emergency on the money, not a reset (exchange.md 6.6).
      if (s.exchange.exchangedAt) {
        const raised = issue(s, issueIds(s)(), 'mortgage_at_risk', `Mortgage offer withdrawn after exchange${cmd.reason ? `: ${cmd.reason}` : ''}`, `The client is bound to complete on ${s.exchange.completionDate ?? 'the contract date'} with or without the advance. Today: find out why the lender withdrew and whether it can be reinstated; look for replacement funding (another lender, bridging, family money, each with its own source-of-funds check); tell the client in writing that if they cannot complete the seller may serve notice and keep the deposit; keep the seller's solicitor informed if the date is at risk.`, 'completion');
        return [{ ...raised, payload: { ...(raised.payload as object), severity: 'critical' } } as NewEvent];
      }
      return [{ type: 'mortgage_offer_withdrawn', actor: cmd.actor, payload: { reason: cmd.reason, lender: cmd.lender ?? s.mortgage.facts?.lender ?? null } }];
    }
    case 'withdraw_enquiry': {
      requireEnrolled(s);
      const q = s.enquiries[cmd.enquiryId];
      if (!q) reject(`Enquiry ${cmd.enquiryId} was never raised.`);
      if (isResolved(q.status)) reject(`Enquiry ${cmd.enquiryId} is already ${q.status}.`);
      if (!cmd.reason.trim()) reject('Give a reason for withdrawing the enquiry.', 400);
      return [{ type: 'enquiry_withdrawn', actor: cmd.actor, payload: { enquiryId: cmd.enquiryId, reason: cmd.reason } }];
    }
    case 'hmlr_requisition_received': {
      requireEnrolled(s);
      if (!s.postCompletion.ap1SubmittedAt) reject('No AP1 has been submitted; a requisition cannot relate to this matter yet.');
      if (s.postCompletion.ap1ConfirmedAt) reject('Registration is already confirmed.');
      // What it is about, so the right thing is done (completion.md 6.20).
      const reqText = `${cmd.text ?? ''} ${cmd.summary?.text ?? ''}`;
      const topic = requisitionTopic(reqText);
      const decision: DecisionSpec = {
        kind: 'requisition',
        summary: (topic ? `${topic}\n\n` : '') + (cmd.summary?.text ?? `HM Land Registry has raised a requisition on the AP1${cmd.reference ? ` (${cmd.reference})` : ''}${cmd.deadline ? `, to be answered by ${cmd.deadline.slice(0, 10)}` : ''}. Read the requisition and respond; an unanswered requisition cancels the application and loses priority.`),
        sourceDocumentId: cmd.documentId,
        citations: [{ documentId: cmd.documentId, label: 'HMLR requisition' }],
        options: OPTIONS_FOR.requisition,
        summarisedBy: cmd.summary?.by ?? 'template',
      };
      assertDecisionSpec(decision);
      // No date on it: HM Land Registry's standard period is 20 working days (PG50), so the timer still runs.
      const deadline = cmd.deadline ?? addWorkingDays(ctx.now, 20).toISOString().slice(0, 10);
      return [{ type: 'hmlr_requisition_received', actor: cmd.actor, payload: { reference: cmd.reference ?? null, deadline, decision }, sourceDocumentId: cmd.documentId }];
    }
    case 'record_correction': {
      requireEnrolledEvenIfAbandoned(s);
      if (!isUserActor(cmd.actor)) reject('Corrections are recorded by people.', 403);
      if (!cmd.reason.trim()) reject('Say what was wrong and what is right.', 400);
      return [{ type: 'correction_recorded', actor: cmd.actor, payload: { aboutEventId: cmd.aboutEventId, reason: cmd.reason }, causedByEventId: cmd.aboutEventId }];
    }
    case 'record_handler_change': {
      requireEnrolledEvenIfAbandoned(s);
      if (cmd.toUserId === s.handler) reject('That person is already the handler.');
      return [{ type: 'handler_changed', actor: cmd.actor, payload: { fromUserId: cmd.fromUserId ?? s.handler, toUserId: cmd.toUserId, reason: cmd.reason ?? null } }];
    }
    case 'raise_deadline_escalation': {
      requireEnrolled(s);
      if (Object.values(s.decisions).some((d) => d.subject === cmd.subject)) reject('This deadline has already been raised.');
      const decision: DecisionSpec = {
        kind: 'escalation',
        summary: cmd.summary,
        sourceDocumentId: cmd.sourceDocumentId,
        citations: [{ documentId: cmd.sourceDocumentId, label: `Deadline dossier: ${cmd.kind.replace(/_/g, ' ')} ${cmd.dueDate}` }],
        options: OPTIONS_FOR.escalation,
        summarisedBy: 'template',
      };
      assertDecisionSpec(decision);
      return [{ type: 'escalation_raised', actor: AI, payload: { waitKey: null, subject: cmd.subject, reason: `${cmd.kind.replace(/_/g, ' ')} due ${cmd.dueDate}`, decision, origin: null }, sourceDocumentId: cmd.sourceDocumentId }];
    }

    // ── issues (docs/engine-issues.md) ──
    case 'raise_issue': {
      requireEnrolled(s);
      if (s.closedAt) reject('The file is closed.');
      const issueId = cmd.issueId?.trim() || nextIssueId(s);
      if (s.issues[issueId]) reject(`Issue ${issueId} already exists.`);
      const spec = ISSUE_KIND_SPEC[cmd.kind];
      if (!spec) reject(`Unknown issue kind "${cmd.kind}".`, 400);
      if (!cmd.title?.trim()) reject('An issue needs a title: what is wrong, in one line.', 400);
      let gate: IssueGate = cmd.gate ?? spec.gate;
      // After exchange the only thing left to hold is completion; after completion nothing is held, but the file does not close while it is open.
      if (gate === 'exchange' && s.exchange.exchangedAt) gate = 'completion';
      if (s.completion.confirmedAt) gate = 'none';
      if (cmd.causedBy && !s.issues[cmd.causedBy]) reject(`Issue ${cmd.causedBy} (causedBy) not found.`, 404);
      if (cmd.severity && !ISSUE_SEVERITIES.includes(cmd.severity)) reject(`Unknown severity "${cmd.severity}".`, 400);
      if (cmd.resolveBy && !ISO_DAY.test(cmd.resolveBy)) reject('The resolve-by date must be a date (YYYY-MM-DD).', 400);
      // The same problem reported again (two emails about the seller pulling out) is the one issue, noted again; it holds the more of the two.
      const dup = cmd.issueId ? null : duplicateIssue(Object.values(s.issues), cmd.kind, cmd.title, cmd.party ?? null);
      if (dup) {
        const rank = { none: 0, completion: 1, exchange: 2 } as const;
        const stronger = rank[gate] > rank[dup.gate] ? gate : null;
        return [{ type: 'issue_updated', actor: cmd.actor, payload: { issueId: dup.id, status: dup.status === 'negotiating' ? 'negotiating' : 'open', note: `Reported again: ${cmd.title.trim()}${cmd.detail?.trim() ? ` (${cmd.detail.trim().slice(0, 200)})` : ''}`, gate: stronger } }];
      }
      return [{ type: 'issue_raised', actor: cmd.actor, payload: { issueId, kind: cmd.kind, title: cmd.title.trim(), detail: cmd.detail?.trim() || null, gate, stage: s.stage, sourceDocumentId: cmd.documentId ?? null, origin: null, party: cmd.party?.trim() || null, severity: cmd.severity ?? spec.severity, causedBy: cmd.causedBy ?? null, ...(cmd.resolveBy ? { resolveBy: cmd.resolveBy } : {}) }, sourceDocumentId: cmd.documentId ?? null }];
    }
    case 'set_issue_severity': {
      requireEnrolled(s);
      const i = openIssue(s, cmd.issueId);
      if (!ISSUE_SEVERITIES.includes(cmd.severity)) reject(`Unknown severity "${cmd.severity}".`, 400);
      if (i.severity === cmd.severity) reject(`Issue ${i.id} is already ${cmd.severity}.`);
      if (!cmd.reason?.trim()) reject('Say why the severity changed.', 400);
      return [{ type: 'issue_severity_changed', actor: cmd.actor, payload: { issueId: i.id, severity: cmd.severity, reason: cmd.reason.trim() } }];
    }

    // ── case model: the survey workstream (facts from reports; the client's satisfaction is theirs) ──
    case 'survey_received': {
      requireEnrolled(s);
      if (s.exchange.exchangedAt) reject('Contracts are exchanged; a survey now is a post-exchange matter for manual handling.');
      // A second reading of the same report is a re-read: it is not a new arrival to acknowledge or advise on afresh.
      const reread = s.survey.reports.some((r) => r.documentId === cmd.documentId && !r.forIssueId);
      const out: NewEvent[] = [{ type: 'survey_received', actor: cmd.actor, payload: { surveyType: cmd.surveyType, facts: cmd.facts, extractor: cmd.extractor, reread }, sourceDocumentId: cmd.documentId, confidenceScore: cmd.facts.confidence }];
      // A good reading clears what a failed one left: the placeholder "could not be read" issue.
      if (cmd.facts.confidence > 0) {
        for (const i of Object.values(s.issues).filter((x) => x.kind === 'survey_further_investigation' && (x.status === 'open' || x.status === 'negotiating') && /could not be read automatically/.test(x.title))) {
          out.push({ type: 'issue_withdrawn', actor: SYSTEM, payload: { issueId: i.id, reason: 'The report has now been read.' } });
        }
      }
      // Objective fact: the surveyor recommends further investigation → one issue per SPECIALIST (holds
      // exchange): ten sentences about damp are one damp specialist, not ten issues.
      const groups = investigationGroups(cmd.facts.recommendations);
      const titles = new Set(groups.map((g) => investigationTitle(g.specialist)));
      const openFi = Object.values(s.issues).filter((i) => i.kind === 'survey_further_investigation' && (i.status === 'open' || i.status === 'negotiating'));
      // Read again: what this report raised before, sentence by sentence, is regrouped.
      // Also replaced: ones raised under the old rule, when each suggestion held exchange by itself.
      const replaced = openFi.filter((x) => x.sourceDocumentId === cmd.documentId && !x.enquiryIds.length && (!titles.has(x.title) || x.gate !== 'none'));
      for (const i of replaced) {
        out.push({ type: 'issue_withdrawn', actor: SYSTEM, payload: { issueId: i.id, reason: 'Regrouped when the report was read again; the survey now waits on the client\'s one decision.' } });
      }
      // A Level 3 survey arriving is the answer to "commission a Level 3".
      if (cmd.surveyType === 'level3') for (const i of openFi.filter((x) => x.title === investigationTitle('Level 3 building survey') && x.sourceDocumentId !== cmd.documentId)) {
        out.push({ type: 'issue_resolved', actor: SYSTEM, payload: { issueId: i.id, resolution: 'specialist_report_clear', note: 'The Level 3 survey has been received and read; its own recommendations follow.', costPennies: null, paidBy: null }, sourceDocumentId: cmd.documentId });
      }
      let n = Object.keys(s.issues).length;
      for (const g of groups) {
        const title = investigationTitle(g.specialist);
        if (openFi.some((i) => i.title === title && !replaced.includes(i))) continue; // this specialist is already being tracked (a re-read, or an earlier report)
        n += 1;
        // Critical only for what the surveyor rates urgent (condition rating 3); otherwise it holds exchange as a warning.
        // A record of what the surveyor suggested, not a gate: the survey holds exchange until the client says how to proceed, once.
        out.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: `ISS-${n}`, kind: 'survey_further_investigation', title, detail: g.items.map((r) => `• ${r.text}`).join('\n'), gate: 'none', stage: s.stage, sourceDocumentId: cmd.documentId, origin: null, party: null, severity: 'info', causedBy: null }, sourceDocumentId: cmd.documentId });
      }
      // Valued below the price (property.md 6.5): renegotiate, top up (a new source of funds), challenge, or another lender.
      const mv = cmd.facts.marketValuePennies;
      if (mv && s.purchasePricePennies && mv < s.purchasePricePennies && profile(s).side === 'buyer' && !openOf(s, 'valuation_issue', 'Valued at')) out.push(issueWith(s, issueIds(s, out)(), 'valuation_issue', `Valued at ${pounds(mv)}, ${pounds(s.purchasePricePennies - mv)} below the price`, `The ${cmd.surveyType === 'valuation' ? 'valuation' : 'surveyor'} puts the value below the agreed price. Options: renegotiate the price, the client makes up the gap (new money: its own proof of funds), challenge it with comparables, or another lender. ${s.hasLender ? 'The lender may reduce the advance: check the offer.' : ''}`, s.exchange.exchangedAt ? 'completion' : 'exchange', 'warning'));
      return out;
    }
    case 'specialist_report_received': {
      requireEnrolled(s);
      if (s.survey.status === 'not_started') reject('No survey is on file for this matter; file the survey first (or file this as the survey).');
      const further = cmd.facts.recommendations.filter((x) => x.furtherInvestigation);
      const out: NewEvent[] = [{ type: 'specialist_report_received', actor: cmd.actor, payload: { facts: cmd.facts, forIssueId: cmd.forIssueId ?? null, extractor: cmd.extractor, furtherInvestigation: further.length > 0 }, sourceDocumentId: cmd.documentId, confidenceScore: cmd.facts.confidence }];
      const target = cmd.forIssueId ? s.issues[cmd.forIssueId] : null;
      if (cmd.forIssueId && !target) reject(`Issue ${cmd.forIssueId} not found.`, 404);
      if (target && (target.status === 'open' || target.status === 'negotiating')) {
        // Fact: the specialist says no further investigation → the issue is resolved by the report. Fact: they recommend more → the chain continues.
        out.push({ type: 'issue_resolved', actor: SYSTEM, payload: { issueId: target.id, resolution: 'specialist_report_clear', note: further.length ? `Specialist report received; recommends further investigation (${further.map((x) => x.text.slice(0, 60)).join('; ')}) — chained as a new issue` : `Specialist report received: no further investigation recommended${cmd.facts.summary ? ` — ${cmd.facts.summary.slice(0, 200)}` : ''}`, costPennies: null, paidBy: null }, sourceDocumentId: cmd.documentId });
      }
      let n = Object.keys(s.issues).length;
      for (const r of further) {
        n += 1;
        out.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: `ISS-${n}`, kind: 'survey_further_investigation', title: `${r.specialist ? `${r.specialist} report` : 'Further investigation'} recommended: ${r.text.slice(0, 140)}`, detail: r.text, gate: 'none', stage: s.stage, sourceDocumentId: cmd.documentId, origin: null, party: null, severity: 'info', causedBy: target?.id ?? null }, sourceDocumentId: cmd.documentId });
      }
      return out;
    }
    case 'client_decision_recorded': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A client decision is recorded by a person who took the client\'s instruction; it is never inferred by automation.', 403);
      const allowed = CLIENT_DECISION_OUTCOMES[cmd.subject];
      if (!allowed) reject(`Unknown client decision subject "${cmd.subject}".`, 400);
      if (!allowed.includes(cmd.decision)) reject(`"${cmd.decision}" is not an outcome for ${cmd.subject.replace(/_/g, ' ')}: ${allowed.join(' / ')}.`, 400);
      if (cmd.subject === 'physical_condition' && !surveyApplies(s)) reject('No survey is on file; the client\'s view of the physical condition is recorded once a survey has been received.');
      if (cmd.subject === 'exchange_authority' && s.exchange.exchangedAt) reject('Contracts are already exchanged.');
      if (cmd.subject === 'exchange_authority' && !profile(s).hasExchange) reject(`A ${profile(s).label.toLowerCase()} has no exchange to authorise.`);
      if (cmd.subject === 'ownership_basis' && s.parties < 2) reject('Only one client on this matter: there is no co-ownership to decide.');
      if (!cmd.note?.trim() && cmd.decision !== 'satisfied' && cmd.decision !== 'authorised' && cmd.decision !== 'accepted' && cmd.decision !== 'agreed' && cmd.decision !== 'evidence') reject('Record what the client said (note).', 400);
      if (cmd.subject === 'exchange_authority' && cmd.decision !== 'authorised' && s.exchange.release && Date.parse(s.exchange.release.until) > ctx.now.getTime()) reject('A Formula C release is live: we are bound to exchange if called before it lapses. The authority cannot be withdrawn until then.');
      // Joint clients each give (or withdraw) their own authority to exchange; one saying yes while another says no is a conflict.
      const party = cmd.party?.trim() || null;
      if (party && !(s.partyNames ?? []).some((n) => n.trim().toLowerCase() === party.toLowerCase())) reject(`${party} is not one of the clients (${(s.partyNames ?? []).join(', ')}).`, 400);
      const conflict: NewEvent[] = [];
      if (party && cmd.subject === 'exchange_authority') {
        const others = Object.entries(s.authorityByParty ?? {}).filter(([p]) => p.toLowerCase() !== party.toLowerCase());
        const clash = others.find(([, d]) => (d === 'authorised' && cmd.decision === 'withdrawn') || (d === 'withdrawn' && cmd.decision === 'authorised'));
        if (clash && !openOf(s, 'joint_client_conflict', 'Joint clients disagree')) conflict.push(issue(s, issueIds(s)(), 'joint_client_conflict', `Joint clients disagree about exchanging: ${cmd.decision === 'authorised' ? party : clash[0]} authorises, ${cmd.decision === 'authorised' ? clash[0] : party} withdraws`, `${cmd.note?.trim() ? `"${cmd.note.trim()}". ` : ''}Nothing exchanges until both instruct the same thing. Joint clients have no confidentiality from each other: tell each what the other has said. If they cannot agree, consider whether we can go on acting for either (SRA Code 6.2).`, s.exchange.exchangedAt ? 'completion' : 'exchange'));
      }
      const out: NewEvent[] = [{ type: 'client_decision_recorded', actor: cmd.actor, payload: { subject: cmd.subject, decision: cmd.decision, ...(party ? { party } : {}), note: cmd.note?.trim() || null, evidenceDocumentId: cmd.evidenceDocumentId ?? null, ...(cmd.approvedEventId ? { approvedEventId: cmd.approvedEventId } : {}), ...(cmd.scope?.length ? { scope: cmd.scope } : {}) }, sourceDocumentId: cmd.evidenceDocumentId ?? null }];
      out.push(...conflict);
      if (cmd.subject === 'further_investigation') {
        // The client's instruction is per investigation: "leave the drains, get the damp guarantee, send a structural engineer in".
        const scope = cmd.scope?.length ? new Set(cmd.scope) : null;
        if (scope) for (const id of scope) if (!s.issues[id] || s.issues[id].kind !== 'survey_further_investigation') reject(`${id} is not a further investigation on this case.`, 400);
        const inScope = (i: { id: string }) => !scope || scope.has(i.id);
        const open = Object.values(s.issues).filter((i) => i.kind === 'survey_further_investigation' && (i.status === 'open' || i.status === 'negotiating') && inScope(i));
        // Changing their mind after waiving: the waived investigations are raised again.
        const waived = cmd.decision !== 'waive' && !open.length ? Object.values(s.issues).filter((i) => i.kind === 'survey_further_investigation' && i.status === 'resolved' && i.resolution === 'accepted_as_is' && inScope(i)) : [];
        if (!open.length && !waived.length) reject('No further investigation is outstanding on this survey.');
        let k = Object.keys(s.issues).length;
        for (const i of waived) { k += 1; out.push({ type: 'issue_raised', actor: cmd.actor, payload: { issueId: `ISS-${k}`, kind: 'survey_further_investigation', title: i.title, detail: i.detail, gate: 'exchange', stage: s.stage, sourceDocumentId: i.sourceDocumentId ?? null, origin: null, party: null, severity: i.severity, causedBy: i.id }, sourceDocumentId: i.sourceDocumentId ?? null }); }
        // Waiving is the client accepting the risk, advised in writing: each recommendation's issue closes as accepted as is.
        if (cmd.decision === 'waive') for (const i of open) out.push({ type: 'issue_resolved', actor: cmd.actor, payload: { issueId: i.id, resolution: 'accepted_as_is', note: `Client waives further investigation (advised in writing)${cmd.note ? `: ${cmd.note.trim()}` : ''}` } });
      }
      if (cmd.subject === 'physical_condition' && cmd.decision === 'renegotiate') {
        out.push({ type: 'issue_raised', actor: cmd.actor, payload: { issueId: nextIssueId(s), kind: 'survey_defect', title: `Client wants to renegotiate after the survey${cmd.note ? `: ${cmd.note.trim().slice(0, 120)}` : ''}`, detail: cmd.note?.trim() || null, gate: 'exchange', stage: s.stage, sourceDocumentId: cmd.evidenceDocumentId ?? null, origin: null, party: null, severity: 'warning', causedBy: null }, sourceDocumentId: cmd.evidenceDocumentId ?? null });
      }
      return out;
    }
    case 'close_matter': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Only a person closes a file.', 403);
      requireStage(s, 'post_completion', 'Closing the file');
      if (profile(s).registration === 'ap1' && !s.postCompletion.ap1ConfirmedAt) reject('Registration is not confirmed; the file cannot be closed yet.');
      if (s.hasExistingMortgage && (profile(s).side === 'seller' || profile(s).type === 'remortgage') && s.redemption.status !== 'discharged') reject("The lender's discharge is not yet confirmed; the file cannot be closed.");
      if (openCharges(s).length) reject(`Not yet discharged: ${openCharges(s).map((c) => c.chargee).join(', ')}.`);
      if (s.undertaking && !s.undertaking.dischargedAt) reject("Our undertaking to the buyer's solicitor is still open: send them the discharges first.");
      if (isLeasehold(s) && profile(s).side === 'buyer' && !s.postCompletion.noticeOfAssignmentAt) reject('Leasehold: serve the notice of assignment before closing the file.');
      if (Object.values(s.issues).some((i) => i.status === 'open' || i.status === 'negotiating')) reject('Open issues remain; resolve or withdraw them before closing.');
      if (refundsDue(s).length) reject(`Money is still owed back: ${refundsDue(s).map((r) => `${r.amountPennies != null ? pounds(r.amountPennies) : 'an amount'} to ${ROLE_LABEL[r.toRole]}`).join(', ')}. Record the refund first.`);
      if (profile(s).registration === 'ap1' && !s.registerCheckedAt) reject('Check the new register first (the proprietors, the charges, any restriction).');
      if (s.waits.some((w) => w.key === 'seller_discharge' && !w.closedAt)) reject("The seller's DS1 has not arrived: their solicitor's undertaking is still open.");
      if (s.waits.some((w) => w.key === 'retention_release' && !w.closedAt)) reject("The lender's retention has not been released: pass it on to the client (or the seller, under the contract) first.");
      if (!s.finalBill) reject('Deliver the final bill first.');
      return [{ type: 'matter_closed', actor: cmd.actor, payload: { reason: cmd.reason ?? null, ...retentionDates(s, ctx.now) } }];
    }
    case 'update_issue': {
      requireEnrolled(s);
      const i = openIssue(s, cmd.issueId);
      if (cmd.gate === 'exchange' && s.exchange.exchangedAt) reject('Contracts are exchanged: an issue can only hold completion (or nothing) now.', 400);
      const gate = cmd.gate && cmd.gate !== i.gate ? cmd.gate : null;
      const party = cmd.party !== undefined && (cmd.party?.trim() || null) !== i.party ? (cmd.party?.trim() || null) : undefined;
      if (cmd.resolveBy && !ISO_DAY.test(cmd.resolveBy)) reject('The resolve-by date must be a date (YYYY-MM-DD).', 400);
      const resolveBy = cmd.resolveBy && cmd.resolveBy !== i.resolveBy ? cmd.resolveBy : null;
      const referredTo = cmd.referredTo && cmd.referredTo !== i.referredTo ? cmd.referredTo : null;
      if (referredTo && !cmd.note?.trim()) reject('Say what they need to decide.', 400);
      if (cmd.status === i.status && !gate && party === undefined && !resolveBy && !referredTo && !cmd.note?.trim()) reject('Nothing to update: give a note, a new status, a new gate, a date or the party.', 400);
      if (gate && i.title.startsWith(SANCTIONS_PREFIX) && i.kind === 'aml_kyc_problem') reject('A sanctions match is a hard stop: it is cleared by resolving it with the evidence, never by changing what it holds.', 400);
      if (gate === 'none' && !cmd.note?.trim()) reject('Releasing an issue\'s hold on the matter needs a note saying why (the client accepts the risk, the lender is content…).', 400);
      return [{ type: 'issue_updated', actor: cmd.actor, payload: { issueId: i.id, status: cmd.status, note: cmd.note?.trim() || null, gate, ...(party !== undefined ? { party } : {}), ...(resolveBy ? { resolveBy } : {}), ...(referredTo ? { referredTo } : {}) } }];
    }
    case 'resolve_issue': {
      requireEnrolled(s);
      const i = openIssue(s, cmd.issueId);
      // The timer may close the issues it raised itself (a search that arrived, an offer that was exchanged inside); everything else is a person's act.
      // The timer may close the issues it raised itself, and the arrival of the thing itself closes an "it is coming" issue whoever raised it.
      const closedByArrival = CLOSED_BY_ARRIVAL.includes(i.kind) && cmd.resolution === 'received';
      // A locked-file task the system raised closes when the file is opened: by its password, or on finding it never needed one.
      const lockedFileOpened = i.kind === 'file_locked' && i.raisedBy === SYSTEM;
      if (!isUserActor(cmd.actor) && !(cmd.actor === SYSTEM && (closedByArrival || lockedFileOpened || (/\[[a-z-]+:[^\]]*\]/.test(i.title) && (cmd.resolution === 'received' || cmd.resolution === 'other'))))) reject('Issues are resolved by people.', 403);
      const spec = ISSUE_KIND_SPEC[i.kind];
      if (!spec.resolutions.includes(cmd.resolution)) reject(`"${spec.label}" is not resolved by "${RESOLUTION_LABEL[cmd.resolution] ?? cmd.resolution}". Realistic outcomes: ${spec.resolutions.map((r) => RESOLUTION_LABEL[r]).join('; ')}.`, 400);
      const note = cmd.note?.trim() || null;
      // A person records the outcome with what it needs (the form differs by outcome).
      const details = cmd.details ?? {};
      if (isUserActor(cmd.actor) && !FORMLESS_KINDS.has(i.kind)) {
        const given = (k: string) => k === 'newPrice' ? cmd.newPricePennies != null : k === 'cost' ? cmd.costPennies != null : k === 'paidBy' ? !!cmd.paidBy : k === 'documentId' ? !!cmd.documentId : details[k] != null && details[k] !== '' && details[k] !== false;
        const missing = RESOLUTION_FIELDS[cmd.resolution].filter((x) => x.required && !given(x.key)).map((x) => x.label);
        if (missing.length) reject(`${RESOLUTION_TITLE[cmd.resolution]} needs: ${missing.join(', ')}.`, 400);
        for (const x of RESOLUTION_FIELDS[cmd.resolution]) if (x.type === 'date' && details[x.key] != null && !ISO_DAY.test(String(details[x.key]))) reject(`${x.label} must be a date (YYYY-MM-DD).`, 400);
        if (cmd.resolution === 'dates_replanned' && !details.targetExchangeDate && !details.targetCompletionDate) reject('Give the new target exchange or completion date.', 400);
      }
      if (cmd.resolution === 'other' && !note) reject('Say how it was resolved.', 400);
      if (cmd.resolution === 'accepted_as_is' && !note) reject('Record the advice given: the client is accepting this as it stands.', 400);
      if (cmd.costPennies != null && (!Number.isInteger(cmd.costPennies) || cmd.costPennies < 0)) reject('The cost must be a whole number of pennies.', 400);
      if (cmd.paidBy && !ISSUE_PAID_BY.includes(cmd.paidBy)) reject(`Unknown payer "${cmd.paidBy}".`, 400);
      if (cmd.costPennies != null && cmd.costPennies > 0 && !cmd.paidBy) reject('Say who paid the cost (buyer, seller, shared, lender, other).', 400);
      const out: NewEvent[] = [{ type: 'issue_resolved', actor: cmd.actor, payload: { issueId: i.id, resolution: cmd.resolution, note, costPennies: cmd.costPennies ?? null, paidBy: cmd.paidBy ?? null, ...(cmd.details && Object.keys(cmd.details).length ? { details: cmd.details } : {}), ...(cmd.documentId ? { documentId: cmd.documentId } : {}) }, sourceDocumentId: i.sourceDocumentId }];
      // New target dates are the case's target dates.
      if (cmd.resolution === 'dates_replanned' && (details.targetExchangeDate || details.targetCompletionDate)) {
        out.push({ type: 'target_dates_changed', actor: cmd.actor, payload: { targetExchangeDate: (details.targetExchangeDate as string) || s.targetExchangeDate, targetCompletionDate: (details.targetCompletionDate as string) || s.targetCompletionDate, reason: `${spec.label}: ${i.title}`, previous: { targetExchangeDate: s.targetExchangeDate, targetCompletionDate: s.targetCompletionDate } } });
      }
      if (PRICE_RESOLUTIONS.has(cmd.resolution)) {
        if (s.exchange.exchangedAt) reject('Contracts are exchanged: the price is contractual now and cannot be reduced by resolving an issue.');
        const to = cmd.newPricePennies;
        if (to == null || !Number.isInteger(to) || to <= 0) reject('A price reduction needs the new agreed price (pennies).', 400);
        if (s.purchasePricePennies !== null && to >= s.purchasePricePennies) reject(`The new price must be below the current price (£${(s.purchasePricePennies / 100).toLocaleString('en-GB')}).`, 400);
        out.push({ type: 'price_changed', actor: cmd.actor, payload: { fromPennies: s.purchasePricePennies, toPennies: to, reason: `${spec.label}: ${i.title}`, issueId: i.id } });
      }
      if (s.hasLender && !s.exchange.exchangedAt && LENDER_NOTIFY_RESOLUTIONS.has(cmd.resolution) && i.kind !== 'lender_approval') {
        out.push(lenderApprovalIssue(s, `${i.id}:lender`, `Tell the lender: ${RESOLUTION_LABEL[cmd.resolution]} on "${i.title}"`, i.sourceDocumentId, { issueId: i.id, resolution: cmd.resolution }));
      }
      // The buyer makes up a gap with new money: it needs its own proof of funds (money.md 5.9).
      if (cmd.resolution === 'buyer_covers_shortfall' && profile(s).side === 'buyer' && s.requireProofOfFunds && !openOf(s, 'source_of_funds', 'Extra money from the client')) {
        out.push(issue(s, issueIds(s, out)(), 'source_of_funds', 'Extra money from the client: where it comes from, with proof', `${i.title}: the client is making up the difference with money of their own. It is new money, so it needs its own proof of funds (where it comes from, the evidence), and the lender is told the deposit changed.`, s.exchange.exchangedAt ? 'completion' : 'exchange'));
      }
      if (REOPENS_OFFER.has(cmd.resolution) && s.hasLender && !s.exchange.exchangedAt && s.mortgage.status !== 'awaiting' && s.mortgage.status !== 'not_required') {
        out.push({ type: 'mortgage_offer_withdrawn', actor: cmd.actor, payload: { reason: `${spec.label} resolved by a new lender / fresh valuation: the current offer no longer applies`, lender: s.mortgage.facts?.lender ?? null } });
      }
      return out;
    }
    case 'withdraw_issue': {
      requireEnrolled(s);
      const i = openIssue(s, cmd.issueId);
      if (!cmd.reason?.trim()) reject('Say why the issue is withdrawn (raised in error, overtaken, no longer relevant).', 400);
      return [{ type: 'issue_withdrawn', actor: cmd.actor, payload: { issueId: i.id, reason: cmd.reason.trim() } }];
    }
    case 'mark_issue_fatal': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Only a person can end a transaction over an issue.', 403);
      const i = openIssue(s, cmd.issueId);
      if (!cmd.reason?.trim()) reject('Say why the transaction cannot continue.', 400);
      if (s.completion.confirmedAt) reject('The purchase has completed; it cannot be abandoned.');
      const abandonReason: AbandonReason = cmd.abandonReason ?? fatalAbandonReason(i.kind);
      return [
        { type: 'issue_fatal', actor: cmd.actor, payload: { issueId: i.id, reason: cmd.reason.trim() } },
        { type: 'matter_abandoned', actor: cmd.actor, payload: { reason: abandonReason, detail: `${ISSUE_KIND_SPEC[i.kind].label}: ${i.title} — ${cmd.reason.trim()}`, stage: s.stage } },
      ];
    }
    case 'record_price_change': {
      if (s.exchange.release && Date.parse(s.exchange.release.until) > ctx.now.getTime()) reject('A Formula C release is live: nothing in the deal may change until it lapses or contracts are exchanged.');
      requireEnrolled(s);
      // Reduced after completion (a retention paid back, a defect settled; money.md 6.4): the SDLT return is amended, the contract stands.
      if (s.completion.confirmedAt && s.purchasePricePennies != null && cmd.toPennies < s.purchasePricePennies && profile(s).side === 'buyer') {
        if (!cmd.reason?.trim()) reject('Say why the price changed.', 400);
        const filed = s.postCompletion.sdltSubmittedAt;
        const by = filed ? new Date(Date.UTC(new Date(filed).getUTCFullYear() + 1, new Date(filed).getUTCMonth(), new Date(filed).getUTCDate())).toISOString().slice(0, 10) : null;
        return [issueWith(s, issueIds(s)(), 'sdlt_basis', `Price reduced after completion to £${(cmd.toPennies / 100).toLocaleString('en-GB')}: amend the SDLT return`, `${cmd.reason.trim()}. The tax was paid on £${(s.purchasePricePennies / 100).toLocaleString('en-GB')}. Amend the return${by ? ` by ${by} (12 months from filing)` : ' within 12 months of filing'} to claim the difference back; after that, an overpayment relief claim within four years.`, 'none', 'warning', by)];
      }
      if (s.exchange.exchangedAt) reject('Contracts are exchanged: the price is contractual now.');
      if (!Number.isInteger(cmd.toPennies) || cmd.toPennies <= 0) reject('The price must be a positive whole number of pennies.', 400);
      if (cmd.toPennies === s.purchasePricePennies) reject('The price is unchanged.');
      if (!cmd.reason?.trim()) reject('Say why the price changed.', 400);
      const out: NewEvent[] = [{ type: 'price_changed', actor: cmd.actor, payload: { fromPennies: s.purchasePricePennies, toPennies: cmd.toPennies, reason: cmd.reason.trim(), issueId: null } }];
      // The first recorded price is the agreed price, not a change; a change on a lender-funded purchase must be reported to the lender.
      if (s.hasLender && s.purchasePricePennies !== null) out.push(lenderApprovalIssue(s, `price:${s.lastSeq + 1}:lender`, `Tell the lender: price changed to £${(cmd.toPennies / 100).toLocaleString('en-GB')} (${cmd.reason.trim()})`, null, null));
      const short = pofShortfallIssue(s, cmd.toPennies);
      if (short) out.push(short);
      out.push(...lapseExchangeAuthority(s, `the price changed to £${(cmd.toPennies / 100).toLocaleString('en-GB')}`));
      // A new price over a ceiling loses a relief or a scheme (money.md 6.3, 7.1).
      for (const c of priceCliffs(s, cmd.toPennies)) out.push(issue(s, issueIds(s, out)(), c.kind, c.title, c.detail, 'exchange'));
      // An approved contract names the old price: it is amended and approved again (exchange.md 1.2).
      if (s.readiness.contractApprovedAt && s.purchasePricePennies !== null) out.push(issue(s, issueIds(s, out)(), 'contract_term', `Contract to be amended to the new price (£${(cmd.toPennies / 100).toLocaleString('en-GB')})`, `The approved contract says £${((s.purchasePricePennies ?? 0) / 100).toLocaleString('en-GB')}. Get the amended contract, approve it again and have it signed again, with the client's written instruction to the new price.`, 'exchange'));
      // The tax moves with the price (tax.md E8): the client hears the new figure.
      if (profile(s).side === 'buyer' && s.purchasePricePennies != null && !s.sdltBasis?.wales) {
        const basis = { ...(s.sdltBasis ?? { firstTimeBuyer: false, additionalProperty: false, nonUkResident: false }), company: s.shapes?.includes('company_buyer') ?? false };
        const before = computeSdlt(chargeableConsideration(s) ?? s.purchasePricePennies, basis).totalPennies;
        const after = computeSdlt(chargeableConsideration({ ...s, purchasePricePennies: cmd.toPennies } as MatterState) ?? cmd.toPennies, basis).totalPennies;
        if (before !== after) out.push(issue(s, issueIds(s, out)(), 'sdlt_basis', `${TAX_CHANGED}: estimate ${pounds(before)} → ${pounds(after)} at the new price`, 'Tell the client the new Stamp Duty figure with the new price, and update the statement.', 'exchange'));
      }
      return out;
    }
    case 'contract_approved': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'contract_review', 'Approving the contract');
      if (s.exchange.exchangedAt) reject('Contracts are already exchanged.');
      if (s.readiness.contractApprovedAt) reject('The contract is already approved.');
      return [{ type: 'contract_approved', actor: cmd.actor, payload: { note: cmd.note ?? null } }];
    }
    case 'signed_contract_held': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'contract_review', 'Holding the signed contract');
      if (s.exchange.exchangedAt) reject('Contracts are already exchanged.');
      if (s.readiness.signedContractHeldAt) reject('The signed contract is already on file.');
      return [{ type: 'signed_contract_held', actor: cmd.actor, payload: { note: cmd.note ?? null } }];
    }

    // ── proof of funds (docs/proof-of-funds.md) ──
    case 'request_proof_of_funds': {
      requireEnrolled(s);
      if (s.exchange.exchangedAt) reject('Contracts are exchanged; proof of funds is a pre-exchange check.');
      if (s.proofOfFunds.status === 'requested') reject('A proof-of-funds form is already with the client. Chase it, or wait for the submission.');
      if (s.proofOfFunds.status === 'submitted') reject('A proof-of-funds submission is awaiting sign-off; resolve that decision (request further re-opens the form).');
      if (s.proofOfFunds.status === 'reviewed' && s.proofOfFunds.resolution === 'approve' && !cmd.followUpOf) reject('Proof of funds is already approved on this matter. Send a follow-up round only from the decision (request further).');
      const queryIds = (cmd.queryIds ?? []).filter((id) => s.proofOfFunds.queries[id]?.status === 'draft');
      return [{ type: 'proof_of_funds_requested', actor: cmd.actor, payload: { requestId: cmd.requestId, channel: cmd.channel, messageId: cmd.messageId ?? null, to: cmd.to ?? null, formUrl: cmd.formUrl ?? null, sendError: cmd.sendError ?? null, followUpOf: cmd.followUpOf ?? null, noteToClient: cmd.noteToClient ?? null, queryIds } }];
    }
    case 'proof_of_funds_submitted': {
      requireEnrolled(s);
      if (s.proofOfFunds.status !== 'requested' || s.proofOfFunds.requestId !== cmd.requestId) reject(`No proof-of-funds request ${cmd.requestId} is awaiting a submission (status: ${s.proofOfFunds.status}).`);
      const out: NewEvent[] = [];
      const now = ctx.now.toISOString();
      // 1. The client's answers to the queries sent with this round.
      const queries: Record<string, PofQuery> = Object.fromEntries(Object.entries(s.proofOfFunds.queries).map(([k, q]) => [k, { ...q }]));
      for (const a of cmd.answers ?? []) {
        const q = queries[a.queryId];
        if (!q || q.status !== 'sent') continue; // answers to queries never sent are ignored, not trusted
        if (!a.answer?.trim() && a.evidenceDocumentIds.length === 0) continue;
        queries[q.id] = { ...q, status: 'answered', answer: a.answer?.trim() || null, answerEvidenceDocumentIds: a.evidenceDocumentIds, answeredAt: now };
        out.push({ type: 'proof_of_funds_query_answered', actor: cmd.actor, payload: { requestId: cmd.requestId, queryId: q.id, answer: a.answer?.trim() || '', evidenceDocumentIds: a.evidenceDocumentIds } });
      }
      // 2. Declaration-level rules, then the transaction-level review (each transaction flag drafts a query, deduplicated by key).
      const verdict = evaluateProofOfFunds(cmd.facts, { coBuyers: s.partyNames.slice(1), hasLinkedSale: s.relatedMatter?.relation === 'sale' ? true : s.relatedMatter ? undefined : false, acceptsNonFamilyGift: s.lenderRequirements?.acceptsNonFamilyGift ?? null, acceptsLoanDeposit: s.lenderRequirements?.acceptsLoanDeposit ?? null, acceptsDonorAbroad: s.lenderRequirements?.acceptsDonorAbroad ?? null });
      const flags: Flag[] = verdict.outcome === 'flag' ? [...verdict.flags] : [];
      const review = cmd.review ?? null;
      if (review) {
        flags.push(...review.flags);
        // A query already drafted, sent, answered — or withdrawn with a reason (considered and discounted) — is not drafted again for the same line.
        const known = new Set(Object.values(queries).map((q) => q.key));
        for (const dq of review.queries) {
          if (known.has(dq.key)) continue;
          known.add(dq.key);
          const id = `Q${Object.keys(queries).length + 1}`;
          const q: PofQuery = { id, key: dq.key, flagCode: dq.flagCode, documentId: dq.documentId || null, transaction: dq.transaction, question: dq.question, raisedAt: now, raisedBy: SYSTEM, status: 'draft', sentAt: null, answer: null, answerEvidenceDocumentIds: [], answeredAt: null };
          queries[id] = q;
          out.push({ type: 'proof_of_funds_query_raised', actor: SYSTEM, payload: { requestId: cmd.requestId, query: { id, key: q.key, flagCode: q.flagCode, documentId: q.documentId, transaction: q.transaction, question: q.question } } });
        }
      }
      // The declaration's own questions (a source the rules cannot classify, a dividend, a "gift" with strings, a gift passed through someone else).
      {
        const known = new Set(Object.values(queries).map((q) => q.key));
        for (const dq of declarationQueries(cmd.facts)) {
          if (known.has(dq.key)) continue;
          known.add(dq.key);
          const id = `Q${Object.keys(queries).length + 1}`;
          queries[id] = { id, key: dq.key, flagCode: dq.flagCode, documentId: null, transaction: null, question: dq.question, raisedAt: now, raisedBy: SYSTEM, status: 'draft', sentAt: null, answer: null, answerEvidenceDocumentIds: [], answeredAt: null };
          out.push({ type: 'proof_of_funds_query_raised', actor: SYSTEM, payload: { requestId: cmd.requestId, query: { id, key: dq.key, flagCode: dq.flagCode, documentId: null, transaction: null, question: dq.question } } });
        }
      }
      // 3. Queries sent and not answered stay open as a flag of their own.
      for (const q of Object.values(queries)) if (q.status === 'sent') flags.push({ code: 'QUERY_UNANSWERED', severity: 'medium', description: `The client did not answer: "${q.question}"`, locator: { section: `Query ${q.id}` } });
      const risk = riskRating(flags);
      // Enhanced due diligence brings source of WEALTH with it (LSAG 6.17.3, 6.18.3): one query, asked once, on how the client came to have what they have.
      if (risk === 'enhanced' && !Object.values(queries).some((q) => q.flagCode === 'SOURCE_OF_WEALTH')) {
        const id = `Q${Object.keys(queries).length + 1}`;
        const q: PofQuery = { id, key: `SOURCE_OF_WEALTH:${cmd.requestId}`, flagCode: 'SOURCE_OF_WEALTH', documentId: null, transaction: null, question: 'Because of the nature of some of the money in this purchase we have to ask about your overall financial position, not just these funds. Please describe how you have built up your savings and assets over time (your work and income, any business, property or investments you have sold, inheritances or large gifts received), with rough figures and dates. Anything you can send that shows it (P60s, accounts, a completion statement from a sale) helps.', raisedAt: now, raisedBy: SYSTEM, status: 'draft', sentAt: null, answer: null, answerEvidenceDocumentIds: [], answeredAt: null };
        queries[id] = q;
        out.push({ type: 'proof_of_funds_query_raised', actor: SYSTEM, payload: { requestId: cmd.requestId, query: { id, key: q.key, flagCode: q.flagCode, documentId: null, transaction: null, question: q.question } } });
      }
      // 4. ALWAYS a decision: AML sign-off is a person's act even when nothing is flagged.
      const decision: DecisionSpec = {
        kind: 'proof_of_funds',
        summary: cmd.summary?.text ?? templateBriefing(cmd.facts, flags, review, Object.values(queries)),
        sourceDocumentId: cmd.documentId,
        citations: [{ documentId: cmd.documentId, label: `Proof of funds declaration (${cmd.facts.declarantName}), round ${cmd.facts.round}` }, ...(review?.statements.filter((x) => x.readable).map((x) => ({ documentId: x.documentId, label: `Statement: ${x.fileName ?? x.documentId}` })) ?? [])],
        options: OPTIONS_FOR.proof_of_funds,
        summarisedBy: cmd.summary?.by ?? 'template',
      };
      assertDecisionSpec(decision);
      // A gift donor is a person whose identity and money we must check like the client's. So is the other holder of a joint
      // account the money sits in — the donor's, or the client's with someone who is not buying: their share is a contribution.
      const contributors: Array<{ name: string; label: string }> = [];
      for (const src of cmd.facts.sources) {
        if (src.kind === 'gift' && src.gift) {
          const donor = src.gift.donorName?.trim();
          if (donor) contributors.push({ name: donor, label: `${donor} (donor)` });
          const joint = src.gift.jointDonorName?.trim();
          if (joint) contributors.push({ name: joint, label: `${joint} (donor, joint account with ${donor || 'the donor'})` });
        } else if (src.jointHolderName?.trim()) {
          const joint = src.jointHolderName.trim();
          contributors.push({ name: joint, label: `${joint} (joint account holder, not buying)` });
        }
      }
      for (const c of contributors) {
        const party = partyId('donor', c.name);
        if (!s.partyChecks[party] && !out.some((ev) => ev.type === 'id_party_added' && (ev.payload as { party: string }).party === party)) out.push({ type: 'id_party_added', actor: SYSTEM, payload: { party, label: c.label, role: 'donor' } });
      }
      out.push({ type: 'proof_of_funds_submitted', actor: cmd.actor, payload: { requestId: cmd.requestId, facts: cmd.facts, flags, statements: review?.statements ?? [], payslips: review?.payslips ?? [], risk, decision }, sourceDocumentId: cmd.documentId, confidenceScore: cmd.facts.confidence });
      return out;
    }
    case 'raise_proof_of_funds_query': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Queries are put by people (the rules draft theirs at submission).', 403);
      if (s.proofOfFunds.status === 'not_started') reject('No proof-of-funds round exists yet; send the form first.');
      if (proofOfFundsApproved(s)) reject('Proof of funds is signed off; a further query needs a new round (request further from a fresh decision, or raise an issue).');
      if (!cmd.question?.trim()) reject('Write the question.', 400);
      const id = `Q${Object.keys(s.proofOfFunds.queries).length + 1}`;
      return [{ type: 'proof_of_funds_query_raised', actor: cmd.actor, payload: { requestId: s.proofOfFunds.requestId ?? '', query: { id, key: `MANUAL:${id}`, flagCode: 'MANUAL', documentId: cmd.documentId ?? null, transaction: cmd.transaction ?? null, question: cmd.question.trim() } } }];
    }
    case 'withdraw_proof_of_funds_query': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Only a person can withdraw a query.', 403);
      const q = s.proofOfFunds.queries[cmd.queryId];
      if (!q) reject(`Query ${cmd.queryId} not found.`, 404);
      if (q.status === 'answered' || q.status === 'withdrawn') reject(`Query ${cmd.queryId} is already ${q.status}.`);
      if (!cmd.reason?.trim()) reject('Say why the query is not needed — the reason is the record that the point was considered.', 400);
      return [{ type: 'proof_of_funds_query_withdrawn', actor: cmd.actor, payload: { queryId: q.id, reason: cmd.reason.trim() } }];
    }

    // ── leasehold ──
    case 'management_pack_requested': {
      requireEnrolled(s);
      if (!isLeasehold(s)) reject('Management packs are a leasehold step; this matter is a freehold purchase.');
      requireStageAtLeast(s, 'pre_contract', 'Requesting the management pack');
      if (s.managementPack.status === 'requested') reject('The management pack has already been requested.');
      if (isResolved(s.managementPack.status)) reject('The management pack has already been reviewed.');
      return [{ type: 'management_pack_requested', actor: cmd.actor, payload: { from: cmd.from, reference: cmd.reference ?? null } }];
    }
    case 'management_pack_received': {
      requireEnrolled(s);
      if (!isLeasehold(s)) reject('Management packs are a leasehold step; this matter is a freehold purchase.');
      if (s.managementPack.status === 'flagged') reject('A management-pack decision is pending; resolve it before filing another pack.');
      const facts = cmd.facts ?? null;
      const flagList = facts?.flags ?? [];
      const lines = [
        `The management pack (LPE1 / leasehold information) has arrived${s.managementPack.requestedAt ? ` (requested ${s.managementPack.requestedAt.slice(0, 10)})` : ' (not requested through the engine)'}. Every figure in it is a client-advice point; check it against the lease and the seller\'s replies.`,
        '',
        facts ? `Service charge: ${facts.serviceChargePenniesPa != null ? `${gbp(facts.serviceChargePenniesPa)} a year` : 'not read'} · Ground rent: ${facts.groundRentPenniesPa != null ? `${gbp(facts.groundRentPenniesPa)} a year` : 'not read'} · Arrears: ${facts.arrearsPennies != null ? gbp(facts.arrearsPennies) : 'not read'} · Major works planned: ${facts.majorWorksPlanned == null ? 'not read' : facts.majorWorksPlanned ? 'YES' : 'no'} · Buildings insurance: ${facts.buildingsInsuranceInPlace == null ? 'not read' : facts.buildingsInsuranceInPlace ? 'in place' : 'NOT confirmed'} · Reserve fund: ${facts.reserveFundPennies != null ? gbp(facts.reserveFundPennies) : 'not read'}` : 'The pack was not extracted: read it in full.',
        ...(facts && (facts.landlord || facts.managingAgent) ? [`Landlord: ${facts.landlord ?? 'not stated'} · Managing agent: ${facts.managingAgent ?? 'not stated'}${facts.serviceChargePeriod ? ` · Service charge year: ${facts.serviceChargePeriod}` : ''}${facts.serviceChargeProportion ? ` · Proportion: ${facts.serviceChargeProportion}` : ''}`] : []),
        ...(facts && facts.buildingsInsuranceInPlace != null ? [`Buildings insurance: ${facts.buildingsInsuranceInPlace ? 'in place' : 'NOT in place'}${facts.insurer ? ` · ${facts.insurer}` : ''}${facts.insuredSumPennies ? ` · sum insured ${gbp(facts.insuredSumPennies)}` : ''}${facts.insuranceExpiryDate ? ` · expires ${facts.insuranceExpiryDate}` : ''}`] : []),
        ...(facts?.fees ? [`Fees on sale: ${[facts.fees.noticeOfAssignmentPennies != null ? `notice of assignment ${gbp(facts.fees.noticeOfAssignmentPennies)}` : null, facts.fees.noticeOfChargePennies != null ? `notice of charge ${gbp(facts.fees.noticeOfChargePennies)}` : null, facts.fees.deedOfCovenantPennies != null ? `deed of covenant ${gbp(facts.fees.deedOfCovenantPennies)}` : null, facts.fees.certificateOfCompliancePennies != null ? `certificate of compliance ${gbp(facts.fees.certificateOfCompliancePennies)}` : null, facts.fees.other].filter(Boolean).join(' · ')}`] : []),
        ...(facts?.majorWorks ? [`Major works: ${facts.majorWorks}${facts.section20Notice ? ' (section 20 consultation under way)' : ''}`] : []),
        ...(facts?.consentsRequired ? [`Consents required on sale: ${facts.consentsRequired}`] : []),
        ...(facts?.disputes ? [`Disputes disclosed: ${facts.disputes}`] : []),
        ...(facts?.accountsProvided ? [`Accounts enclosed: ${facts.accountsProvided}`] : []),
        ...(flagList.length ? ['', 'Points for your attention:', ...flagList.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.description}`)] : []),
        '',
        'Usual checks: arrears cleared before completion; planned major works and who pays (retention?); the insurance schedule names the block; the landlord\'s notice fees and consent requirements; the accounts for the last three years.',
      ];
      const decision: DecisionSpec = {
        kind: 'management_pack',
        summary: cmd.summary?.text ?? lines.join('\n'),
        sourceDocumentId: cmd.documentId,
        citations: [{ documentId: cmd.documentId, label: 'Management pack (LPE1)' }],
        options: OPTIONS_FOR.management_pack,
        summarisedBy: cmd.summary?.by ?? 'template',
      };
      assertDecisionSpec(decision);
      const packEvents: NewEvent[] = [{ type: 'management_pack_received', actor: cmd.actor, payload: { facts, decision }, sourceDocumentId: cmd.documentId, confidenceScore: facts?.confidence ?? null }];
      // Building Safety Act 2022: on a relevant building the lender needs the certificate chain; a missing certificate is an issue holding exchange.
      const bsa = facts?.buildingSafety ?? null;
      if (bsa?.relevantBuilding && (bsa.leaseholderDeedOfCertificate === false || bsa.landlordCertificate === false) && !Object.values(s.issues).some((i) => i.kind === 'building_safety' && (i.status === 'open' || i.status === 'negotiating'))) {
        const missing = [bsa.leaseholderDeedOfCertificate === false && 'leaseholder deed of certificate', bsa.landlordCertificate === false && "landlord's certificate"].filter(Boolean).join(' and ');
        packEvents.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextIssueId(s), kind: 'building_safety', title: `Building Safety Act: no ${missing} for a relevant building`, detail: `The management pack says the building is a relevant building (11 m / 5 storeys or more) and the ${missing} ${missing.includes(' and ') ? 'have' : 'has'} not been given.${bsa.remediation ? ` Remediation position as stated: ${bsa.remediation}.` : ''} The lender will want the certificates (and, depending on its Part 2, an EWS1 or remediation evidence) before it lends, and the buyer's leaseholder protections depend on the certificate chain. Ask the seller's solicitor for them and report to the lender.`, gate: 'exchange', stage: s.stage, sourceDocumentId: cmd.documentId, origin: null, party: null, severity: 'warning', causedBy: null } });
      }
      // What the pack means for a buyer, each its own issue (property.md 7.4, 7.5, 7.9, 7.10).
      if (facts && profile(s).side === 'buyer') {
        const raise = (kind: IssueKind, title: string, detail: string, gate: IssueGate) => { if (!openOf(s, kind, title.split(':')[0])) packEvents.push(issue(s, issueIds(s, packEvents)(), kind, title, detail, gate)); };
        if (facts.arrearsPennies) raise('service_charge_issue', `Arrears on the account: ${gbp(facts.arrearsPennies)}`, "The seller pays them from the sale price on completion (a line on their statement), or a retention is held. Ask the seller's solicitor to confirm, and get the landlord's receipt after completion.", 'completion');
        if (facts.majorWorks || facts.section20Notice) raise('service_charge_issue', `Major works: ${(facts.majorWorks ?? 'a section 20 consultation').slice(0, 70)}`, `${facts.majorWorks ?? 'Section 20 consultation under way.'} Demands served before completion are the seller's, after it the buyer's: agree who pays in a special condition, usually with a retention from the price released when the demand is settled. Advise the client.`, 'exchange');
        if (facts.consentsRequired) raise('missing_consent', `Landlord's requirements on assignment: ${facts.consentsRequired.slice(0, 60)}`, `"${facts.consentsRequired.slice(0, 300)}". A licence to assign, or the deed of covenant, in agreed form before exchange (the landlord's solicitor's draft approved, their fees agreed); the rest at completion.`, 'exchange');
        if (s.lenderRequirements?.requiresEws1 && !/ews1/i.test(facts.buildingSafety?.remediation ?? '')) raise('building_safety', 'EWS1: the lender requires one', `The lender's Part 2 requires an EWS1 for this building and the pack does not show one${facts.buildingSafety?.remediation ? ` (it says: "${facts.buildingSafety.remediation.slice(0, 160)}")` : ''}. Ask the managing agent; without it the lender will not lend. Where cladding is not remediated: the remediation plan, its funding (Building Safety Fund, developer pledge) and the leaseholder cap.`, 'exchange');
      }
      return packEvents;
    }
    case 'notice_of_assignment_served': {
      requireEnrolled(s);
      if (!isLeasehold(s) || profile(s).side !== 'buyer') reject('A notice of assignment is served by the buyer of a leasehold; it does not arise here.');
      if (!s.completion.confirmedAt) reject('Notice of assignment is served after completion.');
      if (s.postCompletion.noticeOfAssignmentAt) reject('Notice of assignment already served.');
      if (!cmd.servedOn?.trim()) reject('Say who the notice was served on (landlord / managing agent).', 400);
      return [{ type: 'notice_of_assignment_served', actor: cmd.actor, payload: { servedOn: cmd.servedOn.trim(), reference: cmd.reference ?? null } }];
    }

    // ── transaction types (docs/transaction-types.md) ──
    case 'request_property_forms': {
      requireEnrolled(s);
      requireSide(s, ['seller'], 'Requesting the property forms');
      if (s.propertyForms.status === 'requested') reject('The property forms have already been requested.');
      if (s.propertyForms.status === 'received') reject('The property forms are already in.');
      const forms = cmd.forms?.length ? cmd.forms : isLeasehold(s) ? ['TA6', 'TA10', 'TA7'] : ['TA6', 'TA10'];
      return [{ type: 'property_forms_requested', actor: cmd.actor, payload: { forms } }];
    }
    case 'property_forms_received': {
      requireEnrolled(s);
      requireSide(s, ['seller'], 'Property forms');
      if (s.propertyForms.status === 'received') reject('The property forms are already in.');
      const formsEvents: NewEvent[] = [{ type: 'property_forms_received', actor: cmd.actor, payload: { forms: cmd.forms, facts: cmd.facts ?? null }, sourceDocumentId: cmd.documentId ?? null }];
      if (cmd.facts) formsEvents.push(...formsIssueEvents(s, cmd.facts, 'seller', cmd.documentId ?? null));
      return formsEvents;
    }
    case 'seller_forms_received': {
      requireEnrolled(s);
      requireSide(s, ['buyer'], "The seller's property forms");
      // A document is read when it arrives: the contract pack often comes before the case leaves Instruction.
      if (s.exchange.exchangedAt) reject('Contracts are exchanged; the forms are filed under Documents.');
      const forms = cmd.forms?.length ? cmd.forms : cmd.facts?.forms?.length ? cmd.facts.forms : ['TA6'];
      const out: NewEvent[] = [{ type: 'seller_forms_received', actor: cmd.actor, payload: { forms, facts: cmd.facts }, sourceDocumentId: cmd.documentId }];
      if (cmd.facts) out.push(...formsIssueEvents(s, cmd.facts, 'buyer', cmd.documentId));
      // The title was read before the forms said what works were done: a covenant against them is only visible now.
      const works = cmd.facts?.answers?.alterations;
      if (works && s.title.facts) out.push(...findingEvents(s, titleFindings(s.title.facts as TitleFacts, { ...findingContext(s), alterations: works }).filter((f) => f.code.startsWith('COVENANT_BREACH:')), s.title.documentId, issueIds(s, out)));
      return out;
    }
    case 'link_related_matter': {
      requireEnrolled(s);
      if (cmd.relatedMatterId === s.matterId) reject('A matter cannot be linked to itself.', 400);
      if (s.relatedMatter?.matterId === cmd.relatedMatterId) reject('That matter is already linked.');
      if (s.exchange.exchangedAt) reject('Contracts are exchanged; a link now changes nothing.');
      const out: NewEvent[] = [{ type: 'related_matter_linked', actor: cmd.actor, payload: { relatedMatterId: cmd.relatedMatterId, relation: cmd.relation, note: cmd.note ?? null } }];
      // The chain is real now: exchange holds until the linked matter can exchange with us (the service checks the other file).
      if (!Object.values(s.issues).some((i) => i.kind === 'chain_dependency' && i.title.startsWith('Linked ') && (i.status === 'open' || i.status === 'negotiating'))) {
        out.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextIssueId(s), kind: 'chain_dependency', title: `Linked ${cmd.relation}: exchange is simultaneous with the related matter`, detail: `Our client's ${cmd.relation} must exchange at the same time: the same completion date in both contracts, the deposit ${cmd.relation === 'sale' ? 'received on the sale used towards this purchase, and the sale proceeds towards completion' : 'from the purchase side'}. The engine refuses exchange here until the linked matter is ready to exchange too, and clears this issue when it is.`, gate: 'exchange', stage: s.stage, sourceDocumentId: null, origin: null, party: null, severity: 'warning', causedBy: null } });
      }
      return out;
    }
    case 'complete_step_manually': {
      requireEnrolled(s);
      if (!s.manualHandling.required) reject('Steps are marked complete by hand only while the case is in manual handling.');
      if (!isUserActor(cmd.actor)) reject('A step is marked complete by a person, not automation.', 403);
      if (!isManualStep(cmd.step)) reject(`"${cmd.step}" is not a step that can be marked complete by hand.`, 400);
      if (!cmd.note?.trim()) reject('Say what was done (how it was checked, where it came from).', 400);
      if (cmd.step.startsWith('enquiry:') && !s.enquiries[cmd.step.slice(8)]) reject(`No enquiry ${cmd.step.slice(8)} on this case.`, 404);
      const f: ManualStepFacts = cmd.facts ?? {};
      const missing = (MANUAL_STEP_REQUIRED[cmd.step] ?? []).filter((r) => f[r.key] == null || f[r.key] === '');
      if (missing.length && !cmd.skipReason?.trim()) reject(`Enter ${missing.map((m) => m.label).join(', ')}, or skip ${missing.length === 1 ? 'it' : 'them'} with a reason.`, 400);
      const out: NewEvent[] = [{ type: 'step_completed_manually', actor: cmd.actor, payload: { step: cmd.step, note: cmd.note.trim(), documentIds: cmd.documentIds ?? [], facts: Object.keys(f).length ? f : null, skipReason: missing.length ? cmd.skipReason!.trim() : null } }];
      // The lender's requirements go where the rules read them, as the directory would have put them.
      if (cmd.step === 'mortgage' && (f.minUnexpiredYears != null || f.maxSearchAgeMonths != null || f.acceptsNonFamilyGift != null || f.acceptsLoanDeposit != null || f.acceptsDonorAbroad != null || f.requiresEws1 != null))
        out.push({ type: 'lender_requirements_recorded', actor: cmd.actor, payload: { minUnexpiredYears: f.minUnexpiredYears ?? null, maxSearchAgeMonths: f.maxSearchAgeMonths ?? null, acceptsNonFamilyGift: f.acceptsNonFamilyGift ?? null, acceptsLoanDeposit: f.acceptsLoanDeposit ?? null, acceptsDonorAbroad: f.acceptsDonorAbroad ?? null, requiresEws1: f.requiresEws1 ?? null, note: f.lender ? `${f.lender} (entered by hand)` : 'entered by hand' } });
      return out;
    }
    case 'undo_manual_step': {
      // A step marked done by hand in error: taken back as if it never happened (the case is rebuilt without it).
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Only a person undoes a step.', 403);
      const done = s.manualSteps?.[cmd.step];
      if (!done?.eventId) reject('That step was not marked complete by hand, so there is nothing to undo. If it no longer holds, mark it incomplete instead.', 400);
      if (!cmd.reason?.trim()) reject('Say why it is undone.', 400);
      if (done.stage && done.stage !== s.stage) reject(`The case has moved on to ${s.stage.replace(/_/g, ' ')} since it was marked done; mark the step incomplete instead.`, 409);
      return [{ type: 'manual_step_undone', actor: cmd.actor, payload: { step: cmd.step, completionEventId: done.eventId, reason: cmd.reason.trim() } }];
    }
    case 'reopen_step': {
      // Done, but no longer holds (an offer expired, a price change voided the papers): outstanding again from now, history kept.
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Only a person marks a step incomplete.', 403);
      if (!isReopenableStep(cmd.step)) reject(`"${cmd.step}" is not a step that can be marked incomplete.`, 400);
      if (!cmd.reason?.trim()) reject('Say why it no longer holds.', 400);
      if (s.completion.confirmedAt) reject('The transaction has completed.');
      if (cmd.step === 'mortgage') {
        // The offer no longer holds: the same as a withdrawn offer (a new one is chased, exchange is held).
        if (!s.hasLender || s.mortgage.status === 'awaiting' || s.mortgage.status === 'not_required') reject('No mortgage offer is on file.');
        if (s.exchange.exchangedAt) reject('Contracts are exchanged: a mortgage offer that fails now is a manual-handling emergency.');
        return [{ type: 'mortgage_offer_withdrawn', actor: cmd.actor, payload: { reason: cmd.reason.trim(), lender: s.mortgage.facts?.lender ?? null } }, { type: 'step_reopened', actor: cmd.actor, payload: { step: cmd.step, reason: cmd.reason.trim() } }];
      }
      if (['contract_approved', 'deposit', 'contract_pack', 'property_forms'].includes(cmd.step) && s.exchange.exchangedAt) reject('Contracts are exchanged: that step cannot be reopened now.');
      return [{ type: 'step_reopened', actor: cmd.actor, payload: { step: cmd.step, reason: cmd.reason.trim() } }];
    }
    case 'unlink_related_matter': {
      requireEnrolled(s);
      if (!s.relatedMatter) reject('This matter is not linked to another.');
      if (s.exchange.exchangedAt) reject('Contracts are exchanged; the link stays on the record.');
      if (!cmd.reason?.trim()) reject('Say why the link is removed (linked in error, the other transaction fell through).', 400);
      const out: NewEvent[] = [{ type: 'related_matter_unlinked', actor: cmd.actor, payload: { relatedMatterId: s.relatedMatter.matterId, reason: cmd.reason.trim() } }];
      for (const i of Object.values(s.issues)) if (i.kind === 'chain_dependency' && i.title.startsWith('Linked ') && (i.status === 'open' || i.status === 'negotiating')) out.push({ type: 'issue_withdrawn', actor: cmd.actor, payload: { issueId: i.id, reason: `Unlinked: ${cmd.reason.trim()}` } });
      return out;
    }
    case 'record_lender_requirements': {
      requireEnrolled(s);
      if (!s.hasLender) reject('No lender on this matter.');
      if (cmd.minUnexpiredYears == null && cmd.maxSearchAgeMonths == null && cmd.acceptsNonFamilyGift == null && cmd.acceptsLoanDeposit == null && cmd.acceptsDonorAbroad == null && cmd.requiresEws1 == null && !cmd.note?.trim()) reject('Nothing to record.', 400);
      return [{ type: 'lender_requirements_recorded', actor: cmd.actor, payload: { minUnexpiredYears: cmd.minUnexpiredYears ?? null, maxSearchAgeMonths: cmd.maxSearchAgeMonths ?? null, acceptsNonFamilyGift: cmd.acceptsNonFamilyGift ?? null, acceptsLoanDeposit: cmd.acceptsLoanDeposit ?? null, acceptsDonorAbroad: cmd.acceptsDonorAbroad ?? null, requiresEws1: cmd.requiresEws1 ?? null, note: cmd.note?.trim() || null } }];
    }
    case 'client_account_receipt': {
      requireEnrolled(s);
      const remitter = cmd.remitter.trim();
      if (!remitter) reject('The name on the sending account is required.', 400);
      const out: NewEvent[] = [{ type: 'client_account_receipt_recorded', actor: cmd.actor, payload: { remitter, amountPennies: cmd.amountPennies ?? null, purpose: cmd.purpose, reference: cmd.reference ?? null } }];
      // Money from someone we do not know, for anything, is a third-party payment (LSAG 5.6.3.2, 6.17.2): the fees as much as the deposit.
      const strangers = strangersAmong(s, remitter);
      const title = `${cmd.purpose === 'fees' ? 'Our fees' : cmd.purpose === 'deposit' ? 'The deposit' : cmd.purpose === 'completion' ? 'Completion money' : 'A payment'} received from a third party: ${remitter}`;
      if (strangers.length && !Object.values(s.issues).some((i) => i.title === title && (i.status === 'open' || i.status === 'negotiating'))) {
        const gate: IssueGate = cmd.purpose === 'completion' ? 'completion' : cmd.purpose === 'deposit' ? 'exchange' : 'none';
        out.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextIssueId(s), kind: 'aml_kyc_problem', title, detail: `${cmd.amountPennies != null ? `${gbp(cmd.amountPennies)} ` : ''}arrived from "${remitter}"${cmd.reference ? ` (ref ${cmd.reference})` : ''}. ${strangers.join(' and ')} ${strangers.length === 1 ? 'is' : 'are'} not the client, a named party, a donor or a holder of any statement read. Anyone paying towards the transaction is a contributor: establish who they are and why they paid${cmd.purpose === 'fees' ? ' (a friend paying the fees is a gift to declare; an employer or a business paying them needs explaining)' : ''}, identify them if the sum warrants it, and consider whether it is a reporting matter. Money that cannot be explained is returned to its source, never onward.`, gate, stage: s.stage, sourceDocumentId: null, origin: null, party: null, severity: cmd.purpose === 'fees' ? 'warning' : 'critical', causedBy: null } });
      }
      return out;
    }
    case 'name_change_evidenced': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A name change is recorded by a person from the evidence.', 403);
      if (!cmd.from.trim() || !cmd.to.trim() || !cmd.reason.trim()) reject('The name before, the name after and the reason (marriage certificate, deed poll, decree) are required.', 400);
      return [{ type: 'name_change_evidenced', actor: cmd.actor, payload: { party: cmd.party ?? null, from: cmd.from.trim(), to: cmd.to.trim(), reason: cmd.reason.trim(), documentId: cmd.documentId ?? null }, sourceDocumentId: cmd.documentId ?? null }];
    }
    case 'contract_pack_sent': {
      requireEnrolled(s);
      requireSide(s, ['seller'], 'The contract pack');
      requireStageAtLeast(s, 'pre_contract', 'Sending the contract pack');
      if (s.propertyForms.status !== 'received') reject('The property forms are not in; the pack goes out with them.');
      if (s.title.status === 'awaiting') reject('Official copies of the title are not yet on file.');
      if (s.contractPack.sentAt) reject('The contract pack has already been sent.');
      return [{ type: 'contract_pack_sent', actor: cmd.actor, payload: { includes: cmd.includes?.length ? cmd.includes : ['draft contract', 'official copies', 'title plan', ...s.propertyForms.forms, ...(isLeasehold(s) ? ['lease', 'management pack'] : [])], channel: cmd.channel ?? null, messageId: cmd.messageId ?? null } }];
    }
    case 'buyer_enquiries_received': {
      requireEnrolled(s);
      requireSide(s, ['seller'], "The buyer's enquiries");
      if (!s.contractPack.sentAt) reject('The contract pack has not gone out; enquiries on it cannot have arrived. Send the pack first (or record it).');
      if (s.exchange.exchangedAt) reject('Contracts are exchanged; further enquiries now are a completion matter.');
      const round = Math.max(0, ...Object.values(s.inboundEnquiries).map((q) => q.round)) + 1;
      let n = Object.keys(s.inboundEnquiries).length;
      const enquiries = cmd.enquiries.map((q) => {
        const id = q.id?.trim() || `BE${++n}`;
        if (s.inboundEnquiries[id]) reject(`Enquiry ${id} already recorded.`);
        return { id, question: q.question.trim() };
      });
      return [{ type: 'buyer_enquiries_received', actor: cmd.actor, payload: { enquiries, round }, sourceDocumentId: cmd.documentId ?? null }];
    }
    case 'enquiry_replies_sent': {
      requireEnrolled(s);
      requireSide(s, ['seller'], 'Replies to enquiries');
      if (!isUserActor(cmd.actor)) reject("Replies go to the buyer's solicitor under a person's name; automation records them only after a person sent them.", 403);
      for (const id of cmd.enquiryIds) {
        const q = s.inboundEnquiries[id];
        if (!q) reject(`Enquiry ${id} not found.`, 404);
        if (q.repliedAt) reject(`Enquiry ${id} was already replied to.`);
      }
      return [{ type: 'enquiry_replies_sent', actor: cmd.actor, payload: { enquiryIds: cmd.enquiryIds, channel: cmd.channel ?? null, messageId: cmd.messageId ?? null }, sourceDocumentId: cmd.documentId ?? null }];
    }
    case 'request_redemption_statement': {
      requireEnrolled(s);
      if (!s.hasExistingMortgage) reject('The property is not charged; there is nothing to redeem.');
      requireType(s, ['freehold_sale', 'leasehold_sale', 'remortgage'], 'A redemption statement');
      if (s.redemption.status === 'requested') reject('A redemption statement has already been requested.');
      if (s.redemption.status === 'redeemed' || s.redemption.status === 'discharged') reject('The mortgage has been redeemed.');
      return [{ type: 'redemption_statement_requested', actor: cmd.actor, payload: { lender: cmd.lender ?? s.redemption.lender ?? null } }];
    }
    case 'redemption_statement_received': {
      requireEnrolled(s);
      if (!s.hasExistingMortgage) reject('The property is not charged; there is nothing to redeem.');
      requireType(s, ['freehold_sale', 'leasehold_sale', 'remortgage'], 'A redemption statement');
      if (s.redemption.status === 'redeemed' || s.redemption.status === 'discharged') reject('The mortgage has been redeemed.');
      if (cmd.validUntil && Number.isNaN(Date.parse(cmd.validUntil))) reject('validUntil must be YYYY-MM-DD.', 400);
      const received: NewEvent = { type: 'redemption_statement_received', actor: cmd.actor, payload: { lender: cmd.lender ?? s.redemption.lender ?? null, redemptionPennies: cmd.redemptionPennies ?? null, validUntil: cmd.validUntil ?? null, dailyInterestPennies: cmd.dailyInterestPennies ?? null }, sourceDocumentId: cmd.documentId ?? null };
      return [received, ...negativeEquityEvents(s, { ...s, redemption: { ...s.redemption, redemptionPennies: cmd.redemptionPennies ?? s.redemption.redemptionPennies } })];
    }
    case 'record_sdlt_facts': {
      requireEnrolled(s);
      requireSide(s, ['buyer', 'owner'], "The buyers' SDLT answers");
      if (s.postCompletion.sdltSubmittedAt) reject('The return has been filed: correct it with HMRC (an amendment within 12 months), then here.');
      const { type: _t, actor: _a, completion: _c, ...facts } = cmd as SdltFacts & { type: string; actor: string; completion?: unknown };
      if (facts.debtAssumedPennies != null && (!Number.isInteger(facts.debtAssumedPennies) || facts.debtAssumedPennies < 0)) reject('The debt taken on must be a sum in pennies.', 400);
      if (facts.soMarketValue && !facts.soMarketValuePennies) reject('The market value election needs the full market value.', 400);
      const d = deriveSdltBasis({ ...facts, effectiveDate: s.exchange.completionDate ?? s.targetCompletionDate ?? null }, s);
      const out: NewEvent[] = [{ type: 'sdlt_facts_recorded', actor: cmd.actor, payload: { facts, basis: d.basis, reasons: d.reasons, refundDiary: d.refundDiary } }];
      const nextId = issueIds(s);
      // The tax moved: say so with both figures, so the client's money and the statement follow.
      const price = chargeableConsideration(s);
      if (s.sdltBasis && price) {
        const before = computeSdlt(price, { ...s.sdltBasis, company: s.shapes?.includes('company_buyer') ?? false });
        const after = computeSdlt(chargeableConsideration({ ...s, sdltFacts: facts } as MatterState) ?? price, d.basis);
        if (before.totalPennies !== after.totalPennies) out.push(issue(s, nextId(), 'sdlt_basis', `${TAX_CHANGED}: estimate ${pounds(before.totalPennies)} → ${pounds(after.totalPennies)}`, `${d.reasons.join(' ')} Update the completion statement and tell the client: the money they need has changed.`, 'none'));
      }
      for (const c of d.contradictions) if (!Object.values(s.issues).some((i) => i.kind === 'sdlt_basis' && i.title === `Tax answers contradict the case: ${c.split(':')[0]}`)) out.push(issue(s, nextId(), 'sdlt_basis', `Tax answers contradict the case: ${c.split(':')[0]}`, c, 'exchange'));
      return out;
    }
    case 'record_cgt_facts': {
      requireEnrolled(s);
      requireSide(s, ['seller'], "The client's CGT answers");
      const out: NewEvent[] = [{ type: 'cgt_facts_recorded', actor: cmd.actor, payload: { mainResidenceThroughout: !!cmd.mainResidenceThroughout, ukResident: !!cmd.ukResident, taxRetentionPennies: cmd.taxRetentionPennies ?? null } }];
      const { type: _ct, actor: _ca, ...cgt } = cmd as CgtFacts & { type: string; actor: string };
      const flags = cgtFlags({ ...cgt, mainResidenceThroughout: !!cmd.mainResidenceThroughout, ukResident: !!cmd.ukResident });
      if (flags.length && !openOf(s, 'cgt_flag', 'Capital Gains Tax')) out.push(issue(s, issueIds(s)(), 'cgt_flag', 'Capital Gains Tax: tell the client a 60-day report may be due', `${flags.join(' ')} Never advise on the tax or give a figure: tell the client in writing and suggest they speak to their accountant before completion.`, 'none'));
      return out;
    }
    // ── Completion day (completion.md §3) ──
    case 'completion_payment_sent': {
      requireEnrolled(s);
      requireSide(s, ['buyer'], 'Sending the completion money');
      requireStage(s, 'pre_completion', 'Sending the completion money');
      moneyMayMove(s, ctx.now, 'No payment');
      if (!isUserActor(cmd.actor)) reject('A person records the money as sent.', 403);
      if (!s.payments.some((p) => p.payeeKind === 'seller_solicitor' && p.purpose === 'completion_monies')) reject('Authorise the completion payment against verified details first.', 412);
      if (s.completion.paymentSent) reject('The completion money is already recorded as sent.');
      if (!cmd.reference?.trim()) reject('Give the CHAPS reference.', 400);
      const sentAt = cmd.sentAt && !Number.isNaN(Date.parse(cmd.sentAt)) ? new Date(cmd.sentAt).toISOString() : ctx.now.toISOString();
      return [{ type: 'completion_payment_sent', actor: cmd.actor, payload: { reference: cmd.reference.trim(), sentAt } }];
    }
    case 'retention_released': {
      requireEnrolled(s);
      if (!s.waits.some((w) => w.key === 'retention_release' && !w.closedAt)) reject('No retention is awaited.');
      return [{ type: 'retention_released', actor: cmd.actor, payload: { amountPennies: cmd.amountPennies ?? null } }];
    }
    // ── Formula C (exchange.md 5.2, 5.3) ──
    case 'formula_c_release_given': {
      requireEnrolled(s);
      requireStage(s, 'pre_exchange', 'A Formula C release');
      if (!isUserActor(cmd.actor)) reject('Only a person gives a release.', 403);
      if (s.exchange.release && Date.parse(s.exchange.release.until) > ctx.now.getTime()) reject('A release is already live.');
      if (Number.isNaN(Date.parse(cmd.until)) || Date.parse(cmd.until) <= ctx.now.getTime()) reject('The release runs until a time later today.', 400);
      if (cmd.until.slice(0, 10) !== ctx.now.toISOString().slice(0, 10)) reject('A Formula C release lasts until a stated time on the same day.', 400);
      if (!cmd.givenTo?.trim()) reject('Who was the release given to?', 400);
      if (exchangeAuthorityHolds(s)) reject("The client has not authorised exchange: a release binds us to exchange if called.");
      return [{ type: 'formula_c_release_given', actor: cmd.actor, payload: { until: new Date(cmd.until).toISOString(), givenTo: cmd.givenTo.trim() } }];
    }
    case 'formula_c_release_lapsed': {
      requireEnrolled(s);
      if (!s.exchange.release) reject('No release was given.');
      if (!cmd.reason?.trim()) reject('Say what happened (not called by the deadline, a link above failed to release).', 400);
      return [{ type: 'formula_c_release_lapsed', actor: cmd.actor, payload: { reason: cmd.reason.trim() } }];
    }
    // ── The deal before exchange (exchange.md 1.3-1.6, 2.7) ──
    case 'record_deal_event': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person records this.', 403);
      if (!cmd.detail?.trim()) reject('Say what happened.', 400);
      if (cmd.until && !ISO_DAY.test(cmd.until)) reject('The date must be a date (YYYY-MM-DD).', 400);
      if (!['sitting_tenant', 'nominee'].includes(cmd.event) && s.exchange.exchangedAt) reject('Contracts are exchanged: the deal is fixed.');
      if (s.completion.confirmedAt) reject('The matter has completed.');
      const side = profile(s).side;
      const d = cmd.detail.trim();
      const out: NewEvent[] = [{ type: 'deal_event_recorded', actor: cmd.actor, payload: { event: cmd.event, detail: d, until: cmd.until ?? null, amountPennies: cmd.amountPennies ?? null } }];
      const nextId = issueIds(s);
      const raise = (kind: IssueKind, title: string, detail: string, gate: IssueGate, severity: IssueSeverity, resolveBy?: string | null) => { const r = issue(s, nextId(), kind, title, detail, gate); out.push({ ...r, payload: { ...(r.payload as object), severity, ...(resolveBy ? { resolveBy } : {}) } } as NewEvent); };
      switch (cmd.event) {
        case 'contract_race':
          if (side === 'seller') raise('transaction_at_risk', 'Contract race: the client wants contracts sent to more than one buyer', `${d}. Only with the client's consent to tell every buyer's solicitor the terms of the race (first to deliver a signed contract and the deposit wins); if they will not consent, we cannot act in the race. Record the consent, then send the same terms to each.`, 'exchange', 'warning');
          else raise('transaction_at_risk', 'Contract race: the seller is dealing with another buyer', `${d}. The first buyer to deliver a signed contract and the deposit wins. Tell the client in writing that their costs may be wasted, and take their instructions to proceed (and how fast).`, 'exchange', 'critical');
          break;
        case 'lockout':
          raise('chain_dependency', `Lock-out agreement${cmd.until ? ` until ${cmd.until}` : ''}`, `${d}. ${cmd.until ? `Exchange must happen by ${cmd.until} or the seller is free to deal with others.` : 'It has no end date, so it is probably unenforceable: get a definite period agreed.'}${cmd.amountPennies ? ` Consideration paid: ${pounds(cmd.amountPennies)}.` : ''}`, 'none', 'warning', cmd.until ?? null);
          break;
        case 'reservation':
          raise('chain_dependency', `New-build reservation${cmd.until ? `: exchange by ${cmd.until}` : ''}`, `${d}. ${cmd.until ? `The developer's deadline to exchange is ${cmd.until}; miss it and the plot can be released and the fee may be lost.` : 'Get the developer\'s exchange deadline.'} Check the refund terms.${cmd.amountPennies ? ` The fee (${pounds(cmd.amountPennies)}) is credited against the deposit on the completion statement.` : ''}`, 'none', 'warning', cmd.until ?? null);
          break;
        case 'renegotiated':
          raise('contract_term', `Renegotiated before exchange: ${d.slice(0, 70)}`, `${d}. Put it in the contract as an amendment, not a side letter; approve the contract again and take the client's authority again.${s.hasLender ? ' Tell the lender of any retention or allowance.' : ''}`, 'exchange', 'warning');
          out.push(...lapseExchangeAuthority(s, `the terms were renegotiated (${d.slice(0, 60)})`));
          if (s.hasLender && side === 'buyer') out.push(lenderApprovalIssue(s, `renegotiated:${s.lastSeq + 1}`, `Tell the lender: terms renegotiated (${d.slice(0, 60)})`, null, null));
          break;
        case 'nominee':
          // A buyer directing the transfer to someone else or adding a person (parties.md 3.2).
          raise('client_change', `Transfer to a different or extra person: ${d.slice(0, 70)}`, `${d}. Only if the contract allows the buyer to direct a transfer (SCS 1.5 forbids sub-sales without consent) or the seller agrees in writing. The new person is identified as a client (ID, source of funds); the lender approves them (a new borrower is a new offer); the transfer is drawn to them; SDLT: the effective date and the buyer's basis may change, and a person added who has owned a home brings the higher rates.`, s.exchange.exchangedAt ? 'completion' : 'exchange', 'critical');
          if (s.hasLender && side === 'buyer') out.push(lenderApprovalIssue(s, `nominee:${s.lastSeq + 1}`, 'Tell the lender: the transfer is to a different or extra person', null, null));
          break;
        case 'buy_out':
          // Separating owners: the sale is replaced by one buying the other out (parties.md 2.11).
          raise('client_change', 'The sale is replaced by a buy-out between the owners', `${d}. Tell the buyer's solicitor and the agent the sale is withdrawn; abandon this case with the reason, and open a transfer of equity for the owner staying (with the court order, if there is one: the Court Order Transfer shape). The money on account and the searches can move across; the staying owner's lender (or a new one) must agree to them taking the mortgage alone.`, 'exchange', 'critical');
          break;
        case 'incentive':
          // Cashback, a deposit contribution, paid fees or extras from the seller or developer (money.md 5.15).
          raise('lender_approval', `Incentive from the seller: ${d.slice(0, 70)}`, `${d}. Tell the lender on the UK Finance disclosure of incentives form (a new build) or in writing: it lends on the price net of incentives, and may reduce the advance. Put it in the contract; show it on the statement. Stamp Duty stays on the full contract price (a cashback paid by the seller may reduce it; an incentive paid to a third party does not).${cmd.amountPennies ? ` Value: £${(cmd.amountPennies / 100).toLocaleString('en-GB')}.` : ''}`, 'exchange', 'warning');
          break;
        case 'deposit_direct':
          // A deposit (or a reservation fee) paid to the seller or the agent, not through us (money.md 8.6).
          raise('deposit_issue', `Deposit paid directly, not through us: ${d.slice(0, 70)}`, `${d}. Get the receipt or the statement showing it, and who holds it (as stakeholder or agent for the seller); the contract must credit it. ${s.hasLender ? 'Tell the lender: a deposit not through our client account is one it may need to approve.' : 'It is money we have not seen: its source still needs evidencing.'}`, 'exchange', 'warning');
          break;
        case 'sitting_tenant':
          raise('third_party_encumbrance', `Tenant in occupation: ${d.slice(0, 70)}`, side === 'buyer'
            ? `${d}. Sold with vacant possession: the tenant's notice, the tenant gone and the property checked on the day (completion is held until then). Sold subject to the tenancy: the tenancy agreement, the rent, the deposit protection certificate and its transfer, the gas, EPC and electrical certificates, and the lender's consent to let; rent and deposit on the completion statement.`
            : `${d}. If the sale is with vacant possession, the tenant must be gone by completion: serve the right notice now. If it is subject to the tenancy, send the tenancy, the deposit protection and the certificates with the pack.`, s.exchange.exchangedAt ? 'completion' : 'exchange', 'warning');
          break;
      }
      return out;
    }
    // ── The property between exchange and completion (exchange.md 6.2, 7.6) ──
    case 'record_property_event': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person records this.', 403);
      if (s.completion.confirmedAt && cmd.event === 'damaged') reject('Completed: damage now is the owner\'s insurance, not the contract.');
      if (!cmd.detail?.trim()) reject('Say what happened.', 400);
      const buyer = profile(s).side === 'buyer';
      const gate: IssueGate = s.completion.confirmedAt ? 'none' : s.exchange.exchangedAt ? 'completion' : 'exchange';
      // The title on the ground (property.md 1.14, 1.15, 2.4, 2.5, 4.3): what the papers do not show.
      const PROP: Record<string, [IssueKind, string, string, IssueSeverity]> = {
        boundary_mismatch: ['boundary_discrepancy', 'The boundary on the ground differs from the plan', 'Registered boundaries are general (LRA 2002 s.60): find out what lies outside the red edging and whether the seller owns it. Options: the seller rectifies or transfers the strip, a statutory declaration of use with a possessory application, or an indemnity policy. Tell the lender if any of the property it lends on is outside the title.', 'warning'],
        adverse_possession: ['title_defect', 'Part of the property is held without title', 'The seller claims a strip (a garden, a parking space) by possession. A statutory declaration of at least 10 years\' (registered) or 12 years\' (unregistered) adverse possession, a possessory application at HM Land Registry, and an indemnity policy; many lenders will not lend on the strip. Advise the client in writing.', 'warning'],
        deeds_lost: ['title_defect', 'The title deeds are lost or incomplete', 'Unregistered land without a full chain of deeds: a statutory declaration of ownership and of the loss, a possessory application (possessory title, upgradable later), and an indemnity policy. Tell the lender before exchange.', 'critical'],
        land_charge_entry: ['third_party_encumbrance', 'The land charges search shows an entry', 'Read the entry by its class: C(iv) an estate contract (an option or pre-emption: release it), D(ii) a restrictive covenant (as on a registered title), F home rights (the spouse releases them before exchange), or a bankruptcy entry (a bankruptcy issue: the same person?). Clear or explain it before exchange.', 'warning'],
        searches_declined: ['search_adverse_entry', 'The client does not want searches', 'Advise the client in writing of the risks (roads, planning, drainage, contamination) and get their written decision. With a lender, its search-indemnity policy is the usual answer (the lender must accept it); put its premium on the statement.', 'warning'],
      };
      if (PROP[cmd.event]) {
        if (s.exchange.exchangedAt && cmd.event !== 'boundary_mismatch') reject('Contracts are exchanged.');
        const [kind, title, detail, severity] = PROP[cmd.event];
        return [{ type: 'property_event_recorded', actor: cmd.actor, payload: { event: cmd.event, detail: cmd.detail.trim() } }, issueWith(s, issueIds(s)(), kind, `${title}: ${cmd.detail.trim().slice(0, 60)}`, `${cmd.detail.trim()}. ${detail}`, gate, severity)];
      }
      // Agreements outside the contract (exchange.md 6.3-6.5): each needs its own terms, the lender and the insurance.
      if (cmd.event === 'early_access' || cmd.event === 'seller_stays') {
        const early = cmd.event === 'early_access';
        const raised = issue(s, issueIds(s)(), 'third_party_consent', early ? `Early access before completion: ${cmd.detail.trim().slice(0, 70)}` : `The seller stays on after completion: ${cmd.detail.trim().slice(0, 70)}`, `${cmd.detail.trim()}. ${early ? "Only by a written licence: access for a stated purpose (measuring, trades) or occupation, no works that change the property without consent, the buyer's insurance, and an end on completion or rescission. The seller's lender and the buyer's lender may need to agree; occupation before completion (or most of the price paid) is substantial performance: the SDLT return and tax are then due within 14 days of it, not of completion, and a second return may be needed at completion." : 'Only by a written licence (never a tenancy): the date they leave, a fee or a retention from the proceeds, who insures and pays the bills. The buyer\'s lender must agree to anyone occupying. Never give vacant possession on paper while they stay.'}`, s.completion.confirmedAt ? 'none' : 'completion');
        return [{ type: 'property_event_recorded', actor: cmd.actor, payload: { event: cmd.event, detail: cmd.detail.trim() } }, raised];
      }
      const [title, detail] = cmd.event === 'damaged'
        ? [`The property was damaged: ${cmd.detail.trim().slice(0, 80)}`, `${cmd.detail.trim()}. ${s.exchange.exchangedAt ? `Under the standard conditions the seller keeps the risk until completion and must hand over the property in the same state (SCS 7.1); a buyer may rescind if it is unusable for its purpose. ${buyer ? "Tell the lender (its security is affected) and the client's insurer, get the seller's proposal for repair or a price reduction, and take the client's instructions before completing." : "Tell the client's insurer at once; the buyer may claim a reduction or rescind. Get the client's instructions."}` : 'Before exchange: re-inspect or re-value, and renegotiate or withdraw on the client\'s instructions; tell the lender.'}`]
        : [`Vacant possession not given: ${cmd.detail.trim().slice(0, 80)}`, `${cmd.detail.trim()}. ${buyer ? "Do not complete without the client's instructions: the seller must give vacant possession (an occupier still there, or goods left). Hold the money; agree a retention or a delayed completion with the seller's solicitor; tell the lender if an occupier stays." : 'Our client must give vacant possession on completion: occupiers out and the property cleared, or the buyer may refuse to complete and claim compensation.'}`];
      const raised = issue(s, issueIds(s)(), cmd.event === 'damaged' ? 'survey_defect' : 'completion_failure', title, detail, gate);
      return [{ type: 'property_event_recorded', actor: cmd.actor, payload: { event: cmd.event, detail: cmd.detail.trim() } }, { ...raised, payload: { ...(raised.payload as object), severity: 'critical' } } as NewEvent];
    }
    case 'final_bill_delivered': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person delivers the bill.', 403);
      if (!Number.isInteger(cmd.amountPennies) || cmd.amountPennies < 0) reject('Give the bill total.', 400);
      if (s.finalBill) reject('The final bill is already delivered.');
      if (cmd.balanceLeftPennies != null && (!Number.isInteger(cmd.balanceLeftPennies) || cmd.balanceLeftPennies < 0)) reject('The balance left must be a sum in pennies.', 400);
      const out: NewEvent[] = [{ type: 'final_bill_delivered', actor: cmd.actor, payload: { amountPennies: cmd.amountPennies, documentId: cmd.documentId ?? null }, sourceDocumentId: cmd.documentId ?? null }];
      // What is left once everything is paid (the SDLT came in under the estimate, a search fee refunded) goes back with the bill (money.md 10.3).
      let n = moneyOf(s).refunds.length;
      if (cmd.balanceLeftPennies) out.push({ type: 'refund_due', actor: SYSTEM, payload: { refundId: `RF-${++n}`, toRole: 'client', to: null, amountPennies: cmd.balanceLeftPennies, reason: 'The balance left on the client account after completion' } });
      // A fair sum of interest on the client's money while we held it (money.md 10.2).
      const interest = interestDue(s, ctx.now);
      if (interest >= CLIENT_INTEREST.minimumPennies) out.push({ type: 'refund_due', actor: SYSTEM, payload: { refundId: `RF-${++n}`, toRole: 'client', to: null, amountPennies: interest, reason: `Interest on the client's money while we held it (${CLIENT_INTEREST.ratePercent}% a year, the firm's policy)` } });
      return out;
    }
    // ── Co-owners' money (co-owners.ts) ──
    case 'record_contributions': {
      requireEnrolled(s);
      requireSide(s, ['buyer', 'owner'], "The co-owners' contributions");
      if (s.completion.confirmedAt) reject('The matter has completed: a later change is a variation of the declaration of trust.');
      const names = (s.partyNames ?? []).map((n) => n.trim().toLowerCase());
      const cs = (cmd.contributions ?? []).map((c) => ({ party: c.party.trim(), pennies: c.pennies }));
      if (cs.length < 2) reject('Give what each co-owner puts in (two or more).', 400);
      if (cs.some((c) => !Number.isInteger(c.pennies) || c.pennies < 0)) reject('Each amount must be a sum in pennies.', 400);
      if (names.length && cs.some((c) => !names.includes(c.party.toLowerCase()))) reject(`Each name must be one of the clients (${s.partyNames.join(', ')}).`, 400);
      const ratio = cmd.ratioPercent ?? null;
      if ((cmd.model === 'FIXED' || cmd.model === 'RING_FENCE') && ratio && Math.abs(Object.values(ratio).reduce((a, b) => a + b, 0) - 100) > 0.01) reject('The shares must add up to 100%.', 400);
      const shares = sharesAtPurchase(s, cmd.model, cs, ratio, ctx.now.toISOString().slice(0, 10));
      const out: NewEvent[] = [{ type: 'contributions_recorded', actor: cmd.actor, payload: { model: cmd.model, contributions: cs, ratioPercent: ratio, shares } }];
      // Unequal money held as joint tenants: the classic trap, raised for advice before exchange.
      if (s.clientDecisions.ownership_basis?.decision === 'joint_tenants' && unequal(cs) && !openOf(s, 'co_ownership_advice', 'Unequal contributions')) out.push(issue(s, issueIds(s)(), 'co_ownership_advice', 'Unequal contributions, but holding as joint tenants', `${cs.map((c) => `${c.party} ${pounds(c.pennies)}`).join(', ')}. As joint tenants the survivor takes everything on a death, and on a split each is presumed to own half whatever they put in. Advise tenants in common with a declaration of trust (${sharesText(shares)} on these figures), or record that they choose joint tenancy knowing this.`, s.exchange.exchangedAt ? 'completion' : 'exchange'));
      return out;
    }
    // ── After completion (theme H) ──
    case 'ap1_cancelled': {
      requireEnrolled(s);
      if (!s.postCompletion.ap1SubmittedAt || s.postCompletion.ap1ConfirmedAt) reject('There is no application waiting at HM Land Registry.');
      if (!cmd.reason?.trim()) reject("Give HM Land Registry's reason.", 400);
      const nextId = issueIds(s);
      const critical = (e: NewEvent): NewEvent => ({ ...e, payload: { ...(e.payload as object), severity: 'critical' } }) as NewEvent;
      const out: NewEvent[] = [{ type: 'ap1_cancelled', actor: cmd.actor, payload: { reason: cmd.reason.trim() } }];
      out.push(critical(issue(s, nextId(), 'title_defect', 'HM Land Registry cancelled the application: priority is lost', `"${cmd.reason.trim()}". Make a fresh priority search (from the date of a new official copy) at once, put right what caused the cancellation, and lodge the application again. Check the register for anything entered since.`, 'none')));
      if (s.hasLender) out.push(critical(issue(s, nextId(), 'lender_approval', 'Tell the lender: the application was cancelled', "Its charge is not registered and may not rank first if anything was lodged in between. Report it, and consider whether the firm's insurer must be told.", 'none')));
      return out;
    }
    case 'requisition_extended': {
      requireEnrolled(s);
      const r = s.postCompletion.requisitions.find((x) => x.eventId === cmd.requisitionEventId);
      if (!r) reject('No such requisition.', 404);
      if (r!.respondedAt) reject('That requisition is answered.');
      if (!ISO_DAY.test(cmd.deadline) || (r!.deadline && cmd.deadline <= r!.deadline.slice(0, 10))) reject('The new date must be later than the current one.', 400);
      if (!cmd.note?.trim()) reject('Say what HM Land Registry agreed and what is awaited.', 400);
      return [{ type: 'requisition_extended', actor: cmd.actor, payload: { requisitionEventId: r!.eventId, deadline: cmd.deadline, note: cmd.note.trim() } }];
    }
    case 'register_checked': {
      requireEnrolled(s);
      if (!s.postCompletion.ap1ConfirmedAt) reject('The AP1 is not registered yet: the register is checked once it is.');
      if (s.registerCheckedAt) reject('The register has been checked.');
      if (!isUserActor(cmd.actor)) reject('A person checks the register.', 403);
      const ok = !cmd.wrong;
      const out: NewEvent[] = [{ type: 'register_checked', actor: cmd.actor, payload: { ok, note: cmd.note?.trim() || null, lenderTold: !!cmd.lenderTold } }];
      if (!ok) out.push(issue(s, issueIds(s)(), 'title_defect', 'The register is wrong after registration', `${cmd.note?.trim() || 'The new register does not say what it should.'} Apply to HM Land Registry to alter it (with the evidence), and tell the lender if its charge is affected.`, 'none'));
      return out;
    }
    case 'seller_discharge_received': {
      requireEnrolled(s);
      if (!s.waits.some((w) => w.key === 'seller_discharge' && !w.closedAt)) reject("The seller's discharge is not awaited.");
      return [{ type: 'seller_discharge_received', actor: cmd.actor, payload: { reference: cmd.reference?.trim() || null }, sourceDocumentId: cmd.documentId ?? null }];
    }
    case 'record_party_event': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person records this.', 403);
      if (!cmd.party?.trim()) reject('Who is it about?', 400);
      const afterwards = ['died', 'complaint', 'ceasing_to_act', 'fee_dispute', 'third_party_payment'].includes(cmd.event);
      if (s.completion.confirmedAt && !afterwards) reject('The matter has completed.');
      if ((s.partyEvents ?? []).some((p) => p.event === cmd.event && p.party.trim().toLowerCase() === cmd.party.trim().toLowerCase())) reject('Already recorded.');
      const ev: NewEvent = { type: 'party_event_recorded', actor: cmd.actor, payload: { event: cmd.event, party: cmd.party.trim(), hasAttorney: cmd.hasAttorney ?? null, note: cmd.note?.trim() || null } };
      if (s.completion.confirmedAt && cmd.event === 'died') return [ev];
      const nextId = issueIds(s);
      const note = cmd.note?.trim();
      const found = partyEventConsequences(s, { event: cmd.event, party: cmd.party.trim(), hasAttorney: cmd.hasAttorney ?? null }, profile(s).side);
      return [ev, ...found.map((c) => { const e = issue(s, nextId(), c.kind, c.title, note ? `${c.detail} (${note})` : c.detail, c.gate); return { ...e, payload: { ...(e.payload as object), severity: c.severity } } as NewEvent; })];
    }
    case 'record_completion_event': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person records this.', 403);
      if (!(COMPLETION_EVENTS as readonly string[]).includes(cmd.event)) reject('Unknown event.', 400);
      if (!cmd.detail?.trim()) reject('Say what happened.', 400);
      if (cmd.until && !ISO_DAY.test(cmd.until)) reject('The date must be a date (YYYY-MM-DD).', 400);
      { const wrong = completionEventProblem(s, cmd.event); if (wrong) reject(wrong); }
      const nextId = issueIds(s);
      return [{ type: 'completion_event_recorded', actor: cmd.actor, payload: { event: cmd.event, detail: cmd.detail.trim(), amountPennies: cmd.amountPennies ?? null, until: cmd.until ?? null } } as NewEvent,
        ...completionEventConsequences(s, { event: cmd.event, detail: cmd.detail, amountPennies: cmd.amountPennies, until: cmd.until }, profile(s).side).map((c) => issueWith(s, nextId(), c.kind, c.title, c.detail, c.gate, c.severity, c.resolveBy, c.kind === 'chain_dependency' ? null : cmd.event))];
    }
    case 'record_isa': {
      // The ISA's own dates (money.md 7.2, 7.5): a Lifetime ISA open under 12 months; a Help to Buy ISA bonus claimed within 12 months of closing.
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person records this.', 403);
      if (!s.shapes?.includes(cmd.isa)) reject(`This case has no ${cmd.isa === 'lifetime_isa' ? 'Lifetime ISA' : 'Help to Buy ISA'}.`);
      for (const d of [cmd.openedOn, cmd.closedOn]) if (d && !ISO_DAY.test(d)) reject('Dates are YYYY-MM-DD.', 400);
      const out: NewEvent[] = [{ type: 'isa_recorded', actor: cmd.actor, payload: { isa: cmd.isa, openedOn: cmd.openedOn ?? null, closedOn: cmd.closedOn ?? null } }];
      const plusYear = (d: string) => { const x = new Date(`${d}T00:00:00Z`); return new Date(Date.UTC(x.getUTCFullYear() + 1, x.getUTCMonth(), x.getUTCDate())).toISOString().slice(0, 10); };
      if (cmd.isa === 'lifetime_isa' && cmd.openedOn) {
        const eligible = plusYear(cmd.openedOn);
        const when = s.exchange.completionDate ?? s.targetCompletionDate ?? ctx.now.toISOString();
        if (eligible > when.slice(0, 10)) out.push(issueWith(s, issueIds(s)(), 'isa_bonus', `Lifetime ISA open only since ${cmd.openedOn}: no penalty-free withdrawal until ${eligible}`, `The account must have been open 12 months before the money can go to a first home without the 25% charge. Complete on or after ${eligible}, or plan the money without the ISA.`, 'completion', 'warning', eligible));
      }
      if (cmd.isa === 'help_to_buy_isa' && cmd.closedOn) {
        const byYear = plusYear(cmd.closedOn);
        const by = byYear < '2030-12-01' ? byYear : '2030-12-01';
        out.push(issueWith(s, issueIds(s)(), 'isa_bonus', `Claim the Help to Buy ISA bonus by ${by}`, `The ISA closed on ${cmd.closedOn}: the bonus claim must be made within 12 months of closing, and by 1 December 2030 at the latest. Claim it in time for completion.`, 'completion', 'warning', by));
      }
      return out;
    }
    case 'record_client_names': {
      // A case enrolled without its clients' names (they are on the matter record): the rules that ask "is this our client?" need them.
      requireEnrolled(s);
      const names = [...new Set((cmd.names ?? []).map((n) => n.trim()).filter(Boolean))];
      if (!names.length) reject('No names given.', 400);
      if ((s.partyNames ?? []).length) reject('The clients are already named: change them with Change Clients.');
      const side = profile(s).side;
      const role: IdPartyCheck['role'] = side === 'seller' ? 'seller' : side === 'owner' ? 'owner' : 'buyer';
      return [{ type: 'client_names_recorded', actor: cmd.actor, payload: { names } } as NewEvent, ...names.slice(1).filter((n) => !s.partyChecks[partyId(role, n)]).map((name): NewEvent => ({ type: 'id_party_added', actor: cmd.actor, payload: { party: partyId(role, name), label: name, role } }))];
    }
    case 'add_shape': {
      // A shape found after enrolment (an attorney who benefits, a vulnerable client, a related-party sale): its checklist is raised as at enrolment.
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A person records this.', 403);
      const sh = cmd.shape as CaseShape;
      const spec = SHAPE_SPEC[sh];
      if (!spec) reject('Unknown case shape.', 400);
      const side = profile(s).side;
      if (!spec.sides.includes(side)) reject(`${spec.label} does not apply to a ${profile(s).label.toLowerCase()}.`, 400);
      if (s.shapes?.includes(sh)) reject('Already recorded.');
      if (s.completion.confirmedAt) reject('The matter has completed.');
      if (spec.skipExchangeAuthority && s.exchange.exchangedAt) reject('Contracts are already exchanged.');
      const gate: IssueGate = spec.issue.gate === 'exchange' && s.exchange.exchangedAt ? 'completion' : spec.issue.gate;
      const out: NewEvent[] = [{ type: 'shape_added', actor: cmd.actor, payload: { shape: sh } }, issue(s, issueIds(s)(), spec.issue.kind, spec.issue.title, spec.issue.detail, gate)];
      if (spec.charge && side !== 'buyer' && !(s.otherCharges ?? []).some((c) => c.chargee === spec.charge)) out.push({ type: 'charge_found', actor: cmd.actor, payload: { chargeId: `CH-${(s.otherCharges ?? []).length + 1}`, chargee: spec.charge, text: null } });
      return out;
    }
    case 'sar_made': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Only a person (the MLRO) records a report.', 403);
      if (amlHoldActive(s, ctx.now)) reject('A consent request is already pending.');
      return [{ type: 'sar_made', actor: cmd.actor, payload: { noticeEnds: damlNoticeEnds(ctx.now) } }];
    }
    case 'daml_response': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Only a person (the MLRO) records the response.', 403);
      if (!s.amlHold || s.amlHold.status !== 'awaiting') reject('No consent request is pending.');
      return [{ type: 'daml_response_recorded', actor: cmd.actor, payload: { decision: cmd.decision, moratoriumEnds: cmd.decision === 'refused' ? damlMoratoriumEnds(ctx.now) : null } }];
    }
    case 'longstop_date_recorded': {
      requireEnrolled(s);
      if (!s.shapes?.includes('new_build')) reject('A long-stop date is recorded on a new-build purchase.');
      if (!ISO_DAY.test(cmd.date)) reject('The long-stop date must be a date (YYYY-MM-DD).', 400);
      if (cmd.date === s.longStopDate) reject('The long-stop date is unchanged.');
      const ls: NewEvent[] = [{ type: 'longstop_date_recorded', actor: cmd.actor, payload: { date: cmd.date } }];
      // The offer must outlast the long-stop, or the build can finish after the money has gone (property.md 8.1).
      const expiry = s.mortgage.facts?.expiryDate;
      if (s.hasLender && expiry && expiry.slice(0, 10) < cmd.date && !openOf(s, 'lender_approval', 'The mortgage offer expires before the long-stop')) ls.push(issue(s, issueIds(s)(), 'lender_approval', `The mortgage offer expires before the long-stop date (offer ends ${prettyDate(expiry.slice(0, 10))}, long-stop ${prettyDate(cmd.date)})`, 'If the developer finishes late the offer will have lapsed and the client is bound to complete without it. Ask the lender for an extension to cover the long-stop (most new-build offers can be extended), and advise the client in writing before exchange.', s.exchange.exchangedAt ? 'completion' : 'exchange'));
      return ls;
    }
    case 'record_other_charge': {
      requireEnrolled(s);
      requireType(s, ['freehold_sale', 'leasehold_sale', 'remortgage'], 'Another charge to redeem');
      if (s.completion.confirmedAt) reject('The matter has completed.');
      if (!cmd.chargee?.trim()) reject('Who is the charge in favour of?', 400);
      return [{ type: 'charge_found', actor: cmd.actor, payload: { chargeId: `CH-${(s.otherCharges ?? []).length + 1}`, chargee: cmd.chargee.trim(), text: cmd.text?.trim() || null } }];
    }
    case 'charge_statement_received': {
      requireEnrolled(s);
      const c = (s.otherCharges ?? []).find((x) => x.id === cmd.chargeId);
      if (!c) reject('No such charge on this case.', 404);
      if (c!.status === 'redeemed' || c!.status === 'discharged') reject(`${c!.chargee} has been paid off.`);
      if (!Number.isInteger(cmd.redemptionPennies) || cmd.redemptionPennies < 0) reject('Give the redemption figure.', 400);
      if (cmd.validUntil && Number.isNaN(Date.parse(cmd.validUntil))) reject('Valid until must be a date.', 400);
      const others = (s.otherCharges ?? []).map((x) => (x.id === c!.id ? { ...x, redemptionPennies: cmd.redemptionPennies } : x));
      return [{ type: 'charge_statement_received', actor: cmd.actor, payload: { chargeId: c!.id, redemptionPennies: cmd.redemptionPennies, validUntil: cmd.validUntil ?? null }, sourceDocumentId: cmd.documentId ?? null }, ...negativeEquityEvents(s, { ...s, otherCharges: others })];
    }
    case 'charge_redeemed': {
      requireEnrolled(s);
      const c = (s.otherCharges ?? []).find((x) => x.id === cmd.chargeId);
      if (!c) reject('No such charge on this case.', 404);
      if (!s.completion.confirmedAt) reject('A charge is paid off on or after completion.');
      if (c!.status !== 'received') reject(c!.status === 'to_redeem' ? `No redemption figure for ${c!.chargee} yet.` : `${c!.chargee} is already paid off.`);
      return [{ type: 'charge_redeemed', actor: cmd.actor, payload: { chargeId: c!.id, amountPennies: cmd.amountPennies ?? c!.redemptionPennies } }];
    }
    case 'charge_discharged': {
      requireEnrolled(s);
      const c = (s.otherCharges ?? []).find((x) => x.id === cmd.chargeId);
      if (!c) reject('No such charge on this case.', 404);
      if (c!.status !== 'redeemed') reject(`${c!.chargee} is ${c!.status.replace(/_/g, ' ')}; a discharge follows payment.`);
      return [{ type: 'charge_discharged', actor: cmd.actor, payload: { chargeId: c!.id, reference: cmd.reference?.trim() || null }, sourceDocumentId: cmd.documentId ?? null }];
    }
    case 'undertaking_given': {
      requireEnrolled(s);
      requireSide(s, ['seller'], "Our undertaking to the buyer's solicitor");
      if (s.undertaking) reject('The undertaking is already given.');
      if (!s.exchange.exchangedAt) reject('The undertaking to redeem is given in reply to the completion information, after exchange.');
      if (!isUserActor(cmd.actor)) reject('Only a person gives an undertaking.', 403);
      if (!cmd.to?.trim() || !cmd.terms?.trim()) reject('Say who it is given to and its terms.', 400);
      return [{ type: 'undertaking_given', actor: cmd.actor, payload: { to: cmd.to.trim(), terms: cmd.terms.trim() } }];
    }
    case 'undertaking_discharged': {
      requireEnrolled(s);
      if (!s.undertaking) reject('No undertaking was given.');
      if (s.undertaking!.dischargedAt) reject('The undertaking is already discharged.');
      if (!allDischarged(s)) reject('Every charge must be discharged before the undertaking is.');
      return [{ type: 'undertaking_discharged', actor: cmd.actor, payload: { note: cmd.note?.trim() || null } }];
    }
    case 'completion_information_received': {
      requireEnrolled(s);
      requireSide(s, ['buyer'], "The seller's completion information");
      const ta13: NewEvent[] = [{ type: 'completion_information_received', actor: cmd.actor, payload: { undertakingToRedeem: !!cmd.undertakingToRedeem, documentId: cmd.documentId ?? null }, sourceDocumentId: cmd.documentId ?? null }];
      const nxt = issueIds(s);
      // Every charge on the seller's title is covered (completion.md 1.17): a second charge, a Help to Buy loan or a charging order needs its own undertaking, DS1 or release.
      const charges = ((s.title.facts as TitleFacts | null)?.charges ?? []).filter((c) => isFinancialCharge(c.text) || NON_LENDER_RE.test(c.text));
      const covered = (cmd.chargesCovered ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);
      const uncovered = covered.length ? charges.filter((c) => !covered.some((w) => c.text.toLowerCase().includes(w))) : charges.length > 1 && cmd.undertakingToRedeem ? charges.slice(1) : [];
      if (uncovered.length) ta13.push(issue(s, nxt(), 'title_defect', `Not every charge is covered by the seller's undertaking (${uncovered.length})`, `${uncovered.map((c) => `${c.code}: ${c.text.slice(0, 120)}`).join(' | ')}. Each charge needs the seller's solicitor's undertaking to redeem it, a DS1 / e-DS1 handed over at completion, or the chargee's own release. Confirm in writing which they cover before completion.`, 'completion'));
      // No undertaking can be relied on from someone who is not a solicitor on the Code (completion.md 1.18).
      if (s.shapes?.includes('unrepresented_counterparty') && charges.length) ta13.push(issue(s, nxt(), 'title_defect', 'The seller is not represented: no undertaking to redeem', 'Nothing can be done on an undertaking. Pay the redemption money direct to the seller\'s lender against its redemption statement, and get the DS1 (or the lender\'s confirmation of the e-DS1) before releasing the balance, or complete in person. Tell our lender how the charges come off.', 'completion'));
      return ta13;
    }
    case 'mortgage_redeemed': {
      requireEnrolled(s);
      if (!s.hasExistingMortgage) reject('The property is not charged; there is nothing to redeem.');
      requireType(s, ['freehold_sale', 'leasehold_sale', 'remortgage'], 'Redemption');
      if (!s.completion.confirmedAt) reject('Redemption is recorded on or after completion.');
      if (s.redemption.status === 'redeemed' || s.redemption.status === 'discharged') reject('Already recorded as redeemed.');
      if (!s.payments.some((x) => x.payeeKind === 'lender')) reject('No authorised payment to the lender on file; authorise the redemption against verified details first.', 412);
      return [{ type: 'mortgage_redeemed', actor: cmd.actor, payload: { lender: cmd.lender ?? s.redemption.lender ?? null, amountPennies: cmd.amountPennies ?? s.redemption.redemptionPennies ?? null } }];
    }
    case 'discharge_confirmed': {
      requireEnrolled(s);
      if (s.redemption.status !== 'redeemed') reject(`The mortgage is ${s.redemption.status.replace(/_/g, ' ')}; a discharge follows redemption.`);
      return [{ type: 'discharge_confirmed', actor: cmd.actor, payload: { lender: cmd.lender ?? s.redemption.lender ?? null, reference: cmd.reference ?? null } }];
    }
    case 'mortgage_deed_executed': {
      requireEnrolled(s);
      if (!s.hasLender) reject('No lender on this matter; there is no mortgage deed.');
      requireType(s, ['freehold_purchase', 'leasehold_purchase', 'remortgage'], 'A mortgage deed');
      if (s.deeds.mortgageDeedAt) reject('The mortgage deed is already executed.');
      {
        const doc = (cmd as { completion?: { documentId?: string | null; checklist?: Record<string, boolean> | null } }).completion;
        if (doc !== undefined || cmd.actor === EXTERNAL) {
          const which: SignedDocument = 'mortgage_deed';
          const method = s.signing.methods[which] ?? 'wet';
          if (!doc?.documentId) reject(`Upload the signed ${SIGNED_DOCUMENT_LABEL[which].toLowerCase()} first: ${method === 'wet' ? 'a scan of the wet-ink original' : 'the signed copy from the signing provider'}.`, 400);
          if (method === 'wet' && cmd.actor !== EXTERNAL && !doc?.checklist?.original_held) reject('Confirm the wet-ink original is with us: the scan is the record, the original goes to the lender or HM Land Registry.', 400);
        }
      }

      if (cmd.witnessed === false) reject('A mortgage deed must be witnessed; an unwitnessed deed is a document-execution issue, not an execution.', 400);
      return [{ type: 'mortgage_deed_executed', actor: cmd.actor, payload: { lender: cmd.lender ?? s.mortgage.facts?.lender ?? null, witnessed: true } }];
    }
    case 'certificate_of_title_sent': {
      requireEnrolled(s);
      if (!s.hasLender) reject('No lender on this matter.');
      requireType(s, ['freehold_purchase', 'leasehold_purchase', 'remortgage'], 'A certificate of title');
      if (!isUserActor(cmd.actor)) reject('The certificate of title is a solicitor\'s certificate; a person sends it.', 403);
      if (!isResolved(s.mortgage.status)) reject(`The mortgage offer is ${s.mortgage.status}; the certificate follows a resolved offer.`);
      if (s.deeds.certificateOfTitleAt) reject('The certificate of title has already been sent.');
      // The certificate is unqualified (Lenders' Handbook Part 1 s.10): everything the lender relies on is in place before it goes, and the advance is released against it.
      const unmet = certificateOfTitleUnmet(s, ctx.now);
      if (unmet.length) reject(`The certificate of title can only be given unqualified: ${unmet.join('; ')}.`);
      return [{ type: 'certificate_of_title_sent', actor: cmd.actor, payload: { lender: cmd.lender ?? s.mortgage.facts?.lender ?? null, completionDate: cmd.completionDate ?? s.exchange.completionDate ?? s.targetCompletionDate ?? null } }];
    }
    case 'request_lender_consent': {
      requireEnrolled(s);
      requireType(s, ['transfer_of_equity'], "The lender's consent to a transfer");
      if (!s.hasExistingMortgage) reject('The property is not charged; no consent is needed.');
      if (s.lenderConsent.status === 'requested') reject('Consent has already been requested.');
      if (s.lenderConsent.status === 'received') reject('Consent is already on file.');
      return [{ type: 'lender_consent_requested', actor: cmd.actor, payload: { lender: cmd.lender ?? null } }];
    }
    case 'lender_consent_received': {
      requireEnrolled(s);
      requireType(s, ['transfer_of_equity'], "The lender's consent to a transfer");
      if (!s.hasExistingMortgage) reject('The property is not charged; no consent is needed.');
      if (s.lenderConsent.status === 'received') reject('Consent is already on file.');
      const consent: NewEvent[] = [{ type: 'lender_consent_received', actor: cmd.actor, payload: { lender: cmd.lender ?? s.lenderConsent.lender ?? null, conditions: cmd.conditions ?? null } }];
      // Each condition of the consent is its own task, holding completion (completion.md 5.6).
      const conds = (cmd.conditions ?? '').split(/\n+|;\s+|(?<=\.)\s+(?=\d+[.)]\s)/).map((c) => c.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim()).filter((c) => c.length > 3);
      const nextId = issueIds(s);
      for (const c of conds.slice(0, 10)) consent.push(issue(s, nextId(), 'third_party_consent', `Lender's condition: ${c.slice(0, 90)}`, `"${c.slice(0, 400)}". Meet it (and keep the evidence) before completion; the lender relies on it.`, 'completion'));
      // Someone leaving the mortgage is released only by the lender (completion.md 5.7).
      if (!conds.some((c) => /releas/i.test(c))) consent.push(issue(s, nextId(), 'third_party_consent', 'Release of the outgoing borrower', "If an owner is leaving, get the lender's deed of release (or its written confirmation that they are released) before completion. If the lender will not release them, tell them in writing that they stay liable for the whole mortgage, and advise them to take their own advice.", 'completion'));
      return consent;
    }
    case 'transfer_deed_executed': {
      requireEnrolled(s);
      requireType(s, ['transfer_of_equity', 'freehold_purchase', 'leasehold_purchase', 'freehold_sale', 'leasehold_sale'], 'A transfer deed');
      if (s.deeds.transferDeedAt) reject('The transfer deed is already executed.');
      {
        const doc = (cmd as { completion?: { documentId?: string | null; checklist?: Record<string, boolean> | null } }).completion;
        if (doc !== undefined || cmd.actor === EXTERNAL) {
          const which: SignedDocument = 'transfer';
          const method = s.signing.methods[which] ?? 'wet';
          if (!doc?.documentId) reject(`Upload the signed ${SIGNED_DOCUMENT_LABEL[which].toLowerCase()} first: ${method === 'wet' ? 'a scan of the wet-ink original' : 'the signed copy from the signing provider'}.`, 400);
          if (method === 'wet' && cmd.actor !== EXTERNAL && !doc?.checklist?.original_held) reject('Confirm the wet-ink original is with us: the scan is the record, the original goes to the lender or HM Land Registry.', 400);
        }
      }

      if (cmd.witnessed === false) reject('A transfer deed must be witnessed.', 400);
      if (!cmd.parties.length) reject('Name the parties who signed.', 400);
      return [{ type: 'transfer_deed_executed', actor: cmd.actor, payload: { parties: cmd.parties, witnessed: true } }];
    }
    case 'deed_of_trust_executed': {
      requireEnrolled(s);
      {
        const doc = (cmd as { completion?: { documentId?: string | null; checklist?: Record<string, boolean> | null } }).completion;
        if (doc !== undefined || cmd.actor === EXTERNAL) {
          const which: SignedDocument = 'deed_of_trust';
          const method = s.signing.methods[which] ?? 'wet';
          if (!doc?.documentId) reject(`Upload the signed ${SIGNED_DOCUMENT_LABEL[which].toLowerCase()} first: ${method === 'wet' ? 'a scan of the wet-ink original' : 'the signed copy from the signing provider'}.`, 400);
          if (method === 'wet' && cmd.actor !== EXTERNAL && !doc?.checklist?.original_held) reject('Confirm the wet-ink original is with us: the scan is the record, the original goes to the lender or HM Land Registry.', 400);
        }
      }
      requireType(s, ['transfer_of_equity', 'freehold_purchase', 'leasehold_purchase'], 'A declaration of trust');
      if (s.parties < 2) reject('Only one client on this matter; a declaration of trust needs co-owners.');
      if (!s.clientDecisions.ownership_basis) reject('The clients have not decided how they hold; record the ownership_basis decision first.');
      if (!TENANTS_IN_COMMON.has(s.clientDecisions.ownership_basis.decision)) reject('The clients hold as joint tenants; a declaration of trust is for tenants in common (record a different decision if that has changed).');
      if (s.deeds.deedOfTrustAt) reject('The declaration of trust is already executed.');
      return [{ type: 'deed_of_trust_executed', actor: cmd.actor, payload: { parties: cmd.parties, shares: cmd.shares ?? null, documentId: cmd.documentId ?? null }, sourceDocumentId: cmd.documentId ?? null }];
    }
    case 'sdlt_not_required': {
      requireEnrolled(s);
      requireSide(s, ['buyer', 'owner'], 'An SDLT determination');
      requireStageAtLeast(s, 'completed', 'The SDLT determination');
      if (!isUserActor(cmd.actor)) reject('Whether SDLT is due is a person\'s determination.', 403);
      if (s.postCompletion.sdltSubmittedAt) reject('An SDLT return has already been filed.');
      if (s.sdltNotRequiredAt) reject('Already recorded.');
      if (!cmd.reason?.trim()) reject('Say why no return is due.', 400);
      // A purchase of £40,000 or more needs a return even when no tax is due (and a relief can only be claimed on one).
      const p = profile(s);
      const consideration = p.side === 'buyer' || s.transactionType === 'transfer_of_equity' ? chargeableConsideration(s) : null;
      if ((p.side === 'buyer' || s.transactionType === 'transfer_of_equity') && consideration != null && consideration >= 4_000_000 && !s.shapes?.includes('court_order_transfer')) reject('A return is required for a purchase of £40,000 or more, even when no tax is due or a relief brings it to nil (the relief is claimed on the return).');
      return [{ type: 'sdlt_not_required', actor: cmd.actor, payload: { reason: cmd.reason.trim() } }];
    }

    // ── Notes and call transcripts (docs/intake.md) ──
    case 'record_note': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('A note is filed under the name of the person who took it.', 403);
      const text = (cmd.text ?? '').trim();
      if (text.length < 10) reject('A note needs something in it.', 400);
      if (text.length > 20_000) reject('That is too long for a single note — file it as a document instead.', 400);
      if (!NOTE_KINDS.includes(cmd.kind)) reject(`Unknown note kind "${cmd.kind}".`, 400);
      const noteId = cmd.noteId?.trim() || `N-${String(Object.keys(s.notes).length + 1).padStart(3, '0')}`;
      if (s.notes[noteId]) reject(`Note ${noteId} is already on the file.`, 409);
      return [{
        type: 'note_recorded',
        actor: cmd.actor,
        payload: { noteId, kind: cmd.kind, text, durationSeconds: cmd.durationSeconds ?? null, documentId: cmd.documentId ?? null, from: cmd.from ?? null },
        sourceDocumentId: cmd.documentId ?? null,
      }];
    }
    case 'note_extracted': {
      requireEnrolled(s);
      const note = s.notes[cmd.noteId];
      if (!note) reject(`Note ${cmd.noteId} not found.`, 404);
      if (note.status !== 'no_actions' || note.actions.length) reject('That note has already been read.', 409);
      // Only what the note actually says, and only commands the machine would accept.
      const { actions } = validateNoteActions(note.text, cmd.drafts, { kind: note.kind, from: note.from });
      // An email from someone the case does not know is never buried, whatever it says: a
      // person is asked who they are before anything from them can count.
      if (note.kind === 'email' && (note.from?.relation ?? 'unknown') === 'unknown') {
        const who = note.from?.name ? `${note.from.name} <${note.from.address}>` : note.from?.address ?? 'an unknown address';
        const firstLine = note.text.split(/\n/).map((l) => l.trim()).find(Boolean) ?? note.text.slice(0, 120);
        actions.unshift({
          id: 'A0',
          kind: 'issue',
          summary: `${who} wrote in and is not on the file`,
          quote: firstLine.slice(0, 200),
          confidence: 1,
          command: { type: 'raise_issue', kind: 'unknown_correspondent', title: `${who} wrote in; not on the file`, detail: firstLine.slice(0, 400), gate: 'none' },
        });
      }
      for (const a of actions) {
        const c = a.command;
        if (c?.type === 'resolve_issue' && !Object.values(s.issues).some((i) => i.kind === c.kind && (i.status === 'open' || i.status === 'negotiating'))) {
          a.summary = `${a.summary} (no open ${ISSUE_KIND_SPEC[c.kind]?.label.toLowerCase() ?? c.kind} issue on the case; noted for information)`;
          a.kind = 'information';
          a.command = null;
        }
      }
      const actionable = actions.filter((a) => a.command);
      const events: NewEvent[] = [];
      // A decision needs a source to cite. A note filed without a document is read and
      // logged, but nothing is proposed for approval — there would be nothing to open.
      // An email nobody has looked at yet is put before a person even when it asks for nothing: a reply is never filed away unseen.
      const writes = !!cmd.reply || !!cmd.messages?.length;
      const surfaceEmpty = !actionable.length && !writes && !!cmd.surface && note.kind === 'email';
      if ((actionable.length || surfaceEmpty || writes) && note.documentId) {
        const decision: DecisionSpec = {
          kind: 'note_actions',
          summary: surfaceEmpty ? (cmd.acknowledgement ? acknowledgementSummary(note.text, note.from) : nothingToActSummary(note.text, note.from)) : !actionable.length && writes ? replyOnlySummary(note.text, note.from) : summariseNoteActions({ kind: note.kind, text: note.text, actions, from: note.from }),
          sourceDocumentId: note.documentId,
          citations: [{ documentId: note.documentId, label: `${note.kind === 'call' ? 'Call note' : note.kind === 'email' ? 'Email' : 'Note'} ${note.id}` }],
          options: OPTIONS_FOR.note_actions,
          summarisedBy: cmd.extractor,
        };
        assertDecisionSpec(decision);
        events.push({ type: 'note_extracted', actor: AI, payload: { noteId: note.id, actions, extractor: cmd.extractor, decision, ...(cmd.acknowledgement ? { acknowledgement: true } : {}), ...(cmd.reply ? { reply: cmd.reply } : {}), ...(cmd.messages?.length ? { messages: cmd.messages } : {}) }, sourceDocumentId: note.documentId });
      } else {
        events.push({ type: 'note_extracted', actor: AI, payload: { noteId: note.id, actions, extractor: cmd.extractor, ...(cmd.acknowledgement ? { acknowledgement: true } : {}) }, sourceDocumentId: note.documentId });
      }
      return events;
    }

    // An approved line the machine then refused (a precondition moved, or was never
    // there). Recorded so the note does not claim something landed that did not.
    case 'note_action_refused': {
      requireEnrolledEvenIfAbandoned(s);
      const n = s.notes[cmd.noteId];
      if (!n) reject(`Note ${cmd.noteId} not found.`, 404);
      return [{ type: 'note_action_refused', actor: SYSTEM, payload: { noteId: n.id, actionId: cmd.actionId, reason: cmd.reason }, sourceDocumentId: n.documentId }];
    }

    case 'record_suppressed': {
      requireEnrolled(s);
      return [{ type: 'action_suppressed', actor: SYSTEM, payload: { action: cmd.action, reason: cmd.reason, subFlow: cmd.subFlow, detail: cmd.detail } }];
    }
    case 'set_shadow_mode': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Shadow mode is switched by a person, never by automation.', 403);
      if (s.shadowMode === cmd.shadowMode) reject(`Shadow mode is already ${cmd.shadowMode ? 'on' : 'off'}.`);
      return [{ type: 'shadow_mode_changed', actor: cmd.actor, payload: { shadowMode: cmd.shadowMode, reason: cmd.reason ?? null } }];
    }

    case 'withdraw_proposal': {
      // The system takes back a proposal that no longer makes sense (superseded by a better one); a person never has to reject it.
      const p = s.proposals[cmd.proposalEventId];
      if (!p) reject('Proposal not found.', 404);
      if (p.status !== 'pending') return [];
      return [{ type: 'action_rejected', actor: SYSTEM, payload: { proposalEventId: p.eventId, action: p.action, detail: p.detail, note: `Withdrawn by the system: ${cmd.reason}` } }];
    }
    case 'propose_action': {
      // A stopped file may still tell the other side it has stopped (exchange.md 1.7); nothing else is proposed on it.
      if (s.abandoned && cmd.action === 'counterparty_update' && cmd.dedupKey.startsWith('cp:withdrawn:')) requireEnrolledEvenIfAbandoned(s);
      else requireEnrolled(s);
      if (Object.values(s.proposals).some((p) => p.action === cmd.action && p.dedupKey === cmd.dedupKey && p.status === 'pending')) reject(`That ${cmd.action.replace(/_/g, ' ')} is already proposed and waiting.`, 409);
      const decision: DecisionSpec = {
        kind: 'proposal',
        summary: cmd.summary,
        sourceDocumentId: cmd.sourceDocumentId,
        citations: [{ documentId: cmd.sourceDocumentId, label: 'What the engine proposes to send or do' }],
        options: OPTIONS_FOR.proposal,
        summarisedBy: 'template',
      };
      assertDecisionSpec(decision);
      return [{ type: 'action_proposed', actor: AI, payload: { action: cmd.action, subject: cmd.subject ?? null, detail: cmd.detail, dedupKey: cmd.dedupKey, decision }, sourceDocumentId: cmd.sourceDocumentId }];
    }

    case 'record_action_failed': {
      requireEnrolled(s);
      if (!s.proposals[cmd.proposalEventId]) reject('Proposal not found.', 404);
      return [{ type: 'action_failed', actor: SYSTEM, payload: { proposalEventId: cmd.proposalEventId, action: cmd.action, detail: cmd.detail, reason: cmd.reason } }];
    }
    case 'record_action_retried': {
      requireEnrolled(s);
      const pr = s.proposals[cmd.proposalEventId];
      if (!pr) reject('Proposal not found.', 404);
      if (pr.status !== 'failed' && pr.status !== 'rejected') reject('Only a failed or held-back action can be sent.');
      return [{ type: 'action_retried', actor: cmd.actor, payload: { proposalEventId: cmd.proposalEventId, action: cmd.action } }];
    }

    // ── Timers / comms ──
    case 'record_chase': {
      requireEnrolled(s);
      const w = s.waits.find((x) => x.key === cmd.chase.waitKey && x.subject === cmd.chase.subject && x.closedAt === null);
      if (!w) reject(`No open wait for ${cmd.chase.waitKey}:${cmd.chase.subject}.`);
      return [{ type: 'chase_sent', actor: SYSTEM, payload: cmd.chase.recipientRole === 'seller_solicitor' ? { ...cmd.chase, counterpartyType: s.counterpartyType } : cmd.chase }];
    }
    case 'record_acknowledgement': {
      requireEnrolled(s);
      if (s.acknowledgements.some((a) => a.forEventId === cmd.ack.forEventId)) reject('That item has already been acknowledged.');
      return [{ type: 'acknowledgement_sent', actor: SYSTEM, payload: cmd.ack }];
    }
    case 'record_request_sent': {
      requireEnrolled(s);
      return [{ type: 'request_sent', actor: SYSTEM, payload: cmd.request }];
    }
    case 'raise_escalation': {
      requireEnrolled(s);
      const w = s.waits.find((x) => x.key === cmd.waitKey && x.subject === cmd.subject && x.closedAt === null);
      if (!w) reject(`No open wait for ${cmd.waitKey}:${cmd.subject}.`);
      if (w.escalations.some((e) => e.resolvedAt === null)) reject('An escalation is already pending for this wait.');
      const label = `${cmd.waitKey.replace('_', ' ')}${cmd.subject ? ` ${cmd.subject}` : ''}`;
      const chased = w.chasesSentAt.length ? `chased ${w.chasesSentAt.length}× (last ${w.chasesSentAt[w.chasesSentAt.length - 1].slice(0, 10)})` : 'not yet chased';
      const decision: DecisionSpec = {
        kind: 'escalation',
        summary: cmd.summary?.text ?? `Still waiting on ${label} since ${w.openedAt.slice(0, 10)} — ${cmd.reason}; ${chased}. Decide whether to push harder, involve the client, or treat this as a chain risk.`,
        sourceDocumentId: cmd.sourceDocumentId,
        citations: [{ documentId: cmd.sourceDocumentId, label: `Chase history for ${label}` }],
        options: OPTIONS_FOR.escalation,
        summarisedBy: cmd.summary?.by ?? 'template',
      };
      assertDecisionSpec(decision);
      return [{ type: 'escalation_raised', actor: AI, payload: { waitKey: cmd.waitKey, subject: cmd.subject, reason: cmd.reason, decision, origin: null }, sourceDocumentId: cmd.sourceDocumentId }];
    }
    case 'record_client_update': {
      if (s.abandoned && cmd.update.template.startsWith('cp_withdrawn:')) requireEnrolledEvenIfAbandoned(s);
      else requireEnrolled(s);
      return [{ type: 'client_update_sent', actor: SYSTEM, payload: cmd.update }];
    }
  }
}

// ───────────────────────────── decision resolution ─────────────────────────────

// ───────────────────────────── issues helpers ─────────────────────────────

/** ISS-1, ISS-2… per matter (deterministic from the state, so a replay agrees). */
// ───────────────────────────── consequences: a fact changed, so what rested on it is done again ─────────────────────────────

/** Issue ids for several issues raised by one command (nextIssueId only sees issues already on the state). */
/** What an HM Land Registry requisition asks for, in one line (completion.md 6.20). */
export function requisitionTopic(text: string): string | null {
  if (/SDLT ?5|land transaction return certificate|stamp duty/i.test(text)) return 'It asks for the SDLT certificate (SDLT5): send the certificate, or the UTRN, with the reply.';
  if (/\bID ?1\b|ID ?2\b|evidence of identity|conveyancer.s certificate|identity/i.test(text)) return "It asks for evidence of identity: an ID1 / ID2 form or the conveyancer's certificate of identity for the party named.";
  if (/DS ?1|discharge|e-DS1|END\b/i.test(text)) return "It asks for the discharge of a charge: the DS1 from the seller's solicitor (their undertaking) or the lender's e-DS1.";
  if (/certificate of compliance|restriction/i.test(text)) return 'It asks for the certificate of compliance with a restriction (or the consent it names).';
  if (/plan|extent|boundar/i.test(text)) return 'It asks about the plan or the extent: check the transfer plan against the title plan.';
  return null;
}

function issueIds(s: MatterState, pending: NewEvent[] = []): () => string {
  // Ids already handed out in this batch (by events not yet folded) are taken too.
  const taken = new Set([...Object.keys(s.issues), ...pending.filter((e) => e.type === 'issue_raised').map((e) => (e.payload as { issueId: string }).issueId)]);
  let n = Object.keys(s.issues).length;
  return () => { do { n += 1; } while (taken.has(`ISS-${n}`)); taken.add(`ISS-${n}`); return `ISS-${n}`; };
}
const issue = (s: MatterState, id: string, kind: IssueKind, title: string, detail: string, gate: IssueGate): NewEvent => ({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: id, kind, title, detail, gate, stage: s.stage, sourceDocumentId: null, origin: null, party: null, severity: ISSUE_KIND_SPEC[kind].severity, causedBy: null } });
const openOf = (s: MatterState, kind: IssueKind, prefix: string) => Object.values(s.issues).some((i) => i.kind === kind && i.title.startsWith(prefix) && (i.status === 'open' || i.status === 'negotiating'));
/** An issue with its own severity and resolve-by date. */
const issueWith = (s: MatterState, id: string, kind: IssueKind, title: string, detail: string, gate: IssueGate, severity: IssueSeverity, resolveBy?: string | null, event?: string | null): NewEvent => { const r = issue(s, id, kind, title, detail, gate); return { ...r, payload: { ...(r.payload as object), severity, ...(resolveBy ? { resolveBy } : {}), ...(event ? { event } : {}) } } as NewEvent; };
const openList = (s: MatterState, kind: IssueKind, prefix: string) => Object.values(s.issues).filter((i) => i.kind === kind && i.title.startsWith(prefix) && (i.status === 'open' || i.status === 'negotiating'));
const resolvedBy = (id: string, note: string): NewEvent => ({ type: 'issue_resolved', actor: SYSTEM, payload: { issueId: id, resolution: 'funds_in_place', note, costPennies: null, paidBy: null } });

// ── Price ceilings (money.md 6.3, 7.1) ──
function priceCliffs(s: MatterState, price: number): Array<{ kind: IssueKind; title: string; detail: string }> {
  const out: Array<{ kind: IssueKind; title: string; detail: string }> = [];
  const was = s.purchasePricePennies ?? 0;
  const crosses = (limit: number) => price > limit && was <= limit;
  if (s.sdltBasis?.firstTimeBuyer && !s.sdltBasis.wales && crosses(50_000_000)) out.push({ kind: 'sdlt_basis', title: "Over £500,000: first-time buyers' relief is lost", detail: 'Above £500,000 there is no relief at all: standard rates on the whole price. Tell the client what the Stamp Duty now is and update the statement.' });
  if (s.shapes?.includes('lifetime_isa') && price > 45_000_000) out.push({ kind: 'isa_bonus' as IssueKind, title: 'Over £450,000: the Lifetime ISA cannot be used', detail: 'A Lifetime ISA can only buy a first home costing £450,000 or less; withdrawing for this purchase would carry the 25% charge. Tell the client before anything is withdrawn, and plan the money without it.' });
  if (s.shapes?.includes('help_to_buy_isa') && crosses(25_000_000)) out.push({ kind: 'isa_bonus' as IssueKind, title: 'Help to Buy ISA: check the price cap', detail: 'The bonus is only for homes up to £250,000 (£450,000 in London). Confirm the property qualifies at the new price.' });
  return out;
}

// ── Late completion (SCS 6.1.2, 7.2) ──
/**
 * Completed after the contract day (or after 2pm on it, which counts as the next working day): the party at fault pays
 * compensation at the contract rate on the price less the deposit paid, for each day late. The rate is the contract's,
 * so the figure is given per 1% of it; who was at fault is for the person to establish.
 */
function lateCompletion(s: MatterState, completedAt: string | null, now: Date): NewEvent[] {
  const due = s.exchange.completionDate;
  if (!due || !s.exchange.exchangedAt) return [];
  const at = completedAt && !Number.isNaN(Date.parse(completedAt)) ? new Date(completedAt) : now;
  const londonHour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/London' }).format(at));
  const day = at.toISOString().slice(0, 10);
  let late = Math.max(0, workingDaysBetween(new Date(`${due.slice(0, 10)}T12:00:00Z`), new Date(`${day}T12:00:00Z`)));
  if (day >= due.slice(0, 10) && londonHour >= 14) late += 1;
  if (late <= 0) return [];
  const balance = Math.max(0, (s.purchasePricePennies ?? 0) - (s.deposit.amountPennies ?? s.deposit.contractPennies ?? 0));
  const days = Math.round((at.getTime() - Date.parse(`${due.slice(0, 10)}T12:00:00Z`)) / 86_400_000) || 1;
  const perPercent = balance ? Math.round((balance * 0.01 * days) / 365) : null;
  return [issue(s, issueIds(s)(), 'completion_failure', `Completed late: ${late} working day${late === 1 ? '' : 's'} after the contract date (${due.slice(0, 10)})`, `${londonHour >= 14 && day === due.slice(0, 10) ? 'The money arrived after 2pm, so completion counts as the next working day (SCS 6.1.2). ' : ''}Whoever caused the delay pays compensation at the contract rate on the price less the deposit${perPercent != null ? ` (${pounds(balance)}): ${pounds(perPercent)} for every 1% of the contract rate over ${days} day${days === 1 ? '' : 's'}` : ''} (SCS 7.2). Establish who was at fault, agree the figure with the other side, and tell the client.`, 'none')];
}

// ── After completion (theme H) ──
/** What is left once the application is in: registration, the register read, the seller's DS1. */
function afterRegistration(s: MatterState): string[] {
  if (!s.postCompletion.ap1ConfirmedAt) return ['awaiting HMLR registration'];
  const left: string[] = [];
  if (!s.registerCheckedAt) left.push('the new register not yet checked');
  if (s.waits.some((w) => w.key === 'seller_discharge' && !w.closedAt)) left.push("awaiting the seller's DS1 (their solicitor's undertaking)");
  if (s.waits.some((w) => w.key === 'retention_release' && !w.closedAt)) left.push("awaiting the lender's release of the retention");
  if (!s.finalBill) left.push('final bill not delivered');
  return left.length ? left : ['matter complete'];
}
/** How long the file is kept (a purchase 15 years, a sale 6), and the CDD records (5 years from completion, MLR reg 40). */
function retentionDates(s: MatterState, now: Date): { destroyAfter: string; cddUntil: string } {
  const years = (from: Date, n: number) => new Date(Date.UTC(from.getUTCFullYear() + n, from.getUTCMonth(), from.getUTCDate())).toISOString().slice(0, 10);
  const completed = s.completion.confirmedAt ? new Date(s.completion.confirmedAt) : now;
  return { destroyAfter: years(now, profile(s).side === 'seller' ? 6 : 15), cddUntil: years(completed, 5) };
}

// ── People events (people.ts) ──
/** Money, exchange and completion wait on an uncleared sanctions match or a pending consent request; the reason given is neutral (no tipping off). */
function moneyMayMove(s: MatterState, now: Date, what: string): void {
  if (sanctionsHold(s)) reject(`${what}: a sanctions match is not cleared.`, 423);
  if (amlHoldActive(s, now)) reject(`${what} for now: the matter is on hold. Speak to the MLRO.`, 423);
}

// ── Charges and undertakings (charges.ts) ──
const NEGATIVE_EQUITY = 'Negative equity';
const TAX_CHANGED = 'SDLT basis changed';
/** The redemptions against the price, after a figure arrives: owing more than the price holds exchange. */
function negativeEquityEvents(s: MatterState, after: MatterState): NewEvent[] {
  if (profile(s).side !== 'seller') return [];
  const ne = negativeEquity(after);
  const open = openList(s, 'completion_funds_shortfall', NEGATIVE_EQUITY);
  if (ne && ne.shortPennies > 0) return open.length ? [] : [issue(s, issueIds(s)(), 'completion_funds_shortfall', `${NEGATIVE_EQUITY}: the charges total ${pounds(ne.owedPennies)} against a price of ${pounds(ne.pricePennies)}`, `The sale does not clear the charges by ${pounds(ne.shortPennies)}, before our fees and the agent's. Do not exchange or give an undertaking to redeem unless the client has the shortfall here in cleared funds, or each lender agrees in writing to a short sale and to release its charge.`, s.exchange.exchangedAt ? 'completion' : 'exchange')];
  return open.map((i) => resolvedBy(i.id, 'The figures now clear the charges.'));
}
/** On a purchase: the seller's title, as read, carries a charge that must come off. */
/** A creditor's charge that is not a mortgage (a charging order, HMRC, a council): still a charge to come off. */
const NON_LENDER_RE = /charging order|hm revenue|hmrc|council|local authority|judgment|homes england|help to buy/i;
const sellerTitleCharged = (s: MatterState): boolean => ((s.title.facts as TitleFacts | null)?.charges ?? []).some((c) => isFinancialCharge(c.text));

// ── Readings become typed issues (findings.ts) ──
function findingContext(s: MatterState): FindingContext {
  return { side: profile(s).side, hasLender: s.hasLender, sharedAccess: !!s.sellerForms?.facts?.answers?.sharedAccessOrServices, alterations: s.sellerForms?.facts?.answers?.alterations ?? null, pricePennies: s.purchasePricePennies ?? null, clients: Math.max(s.parties ?? 1, s.partyNames?.length ?? 0), offerExpiry: s.hasLender ? ((s.mortgage.facts as { expiryDate?: string | null } | null)?.expiryDate ?? null) : null };
}
/** Each finding once per case: a later reading of the same thing (a new edition, the lease after the register) never raises it again. */
function findingEvents(s: MatterState, found: Finding[], documentId: string | null, nextId: () => string = issueIds(s)): NewEvent[] {
  const seen = new Set(Object.values(s.issues).filter((i) => i.status !== 'withdrawn').map((i) => i.finding).filter(Boolean));
  return found.filter((f, n) => !seen.has(f.code) && found.findIndex((x) => x.code === f.code) === n).map((f) => ({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextId(), kind: f.kind, title: f.title, detail: f.page != null ? `${f.detail} (p.${f.page})` : f.detail, gate: s.exchange.exchangedAt && f.gate === 'exchange' ? 'completion' : f.gate, stage: s.stage, sourceDocumentId: documentId, origin: null, party: null, severity: f.severity, causedBy: null, finding: f.code }, sourceDocumentId: documentId ?? undefined }) as NewEvent);
}

// ── Money reconciled (engine/money.ts) ──
const SHORT_PREFIX = 'Completion money short';
const DEPOSIT_SHORT = 'Deposit short';

/** After a receipt: a shortfall against what was asked for holds completion until it is made up; an overpayment by the client is owed back. */
function moneyConsequences(s: MatterState, received: Partial<Record<FundsRole, number>>, contract: { pricePennies: number | null; depositPennies: number | null }, nextId: () => string, remitter: string | null): NewEvent[] {
  const pos = position(s, received, contract);
  const out: NewEvent[] = [];
  const open = openList(s, 'completion_funds_shortfall', SHORT_PREFIX);
  const lines = pos.lines.filter((l) => l.receivedPennies !== l.expectedPennies).map((l, n) => `${n === 0 ? ROLE_LABEL[l.role].replace(/^t/, 'T') : ROLE_LABEL[l.role]} sent ${pounds(l.receivedPennies)} of ${pounds(l.expectedPennies)}${l.role === 'lender' && moneyOf(s).requested.lender == null ? ' (the offer)' : ''}`);
  if (pos.shortfallPennies > 0) {
    if (!open.length) out.push(issue(s, nextId(), 'completion_funds_shortfall', `${SHORT_PREFIX}: ${poundsShort(pos.shortfallPennies)} still to come`, `${lines.join('; ')}. ${profile(s).side === 'seller' ? "Do not release the keys until the buyer's solicitor sends the rest." : 'Ask the client for the difference (a lender that deducted its fees, or a retention, leaves the client to make it up). Completion cannot go ahead short.'}`, 'completion'));
  } else for (const i of open) out.push(resolvedBy(i.id, 'The money in now matches what was asked for.'));
  const owed = moneyOf(s).refunds.filter((r) => r.reason.startsWith('Overpaid')).reduce((a, r) => a + (r.amountPennies ?? 0), 0);
  if (pos.surplusPennies > owed) out.push({ type: 'refund_due', actor: SYSTEM, payload: { refundId: `RF-${moneyOf(s).refunds.length + 1}`, toRole: pos.surplusTo ?? 'client', to: remitter, amountPennies: pos.surplusPennies - owed, reason: `Overpaid: ${lines.join('; ')}. Return the surplus to the account it came from, or hold it against completion with the client's written agreement.` } });
  return out;
}

/** The deposit held against the contract's: short holds exchange until topped up. */
function depositConsequences(s: MatterState, held: number, contractDeposit: number | null): NewEvent[] {
  if (contractDeposit == null) return [];
  const open = openList(s, 'deposit_issue', DEPOSIT_SHORT);
  if (held < contractDeposit) return open.length ? [] : [issue(s, issueIds(s)(), 'deposit_issue', `${DEPOSIT_SHORT}: ${pounds(held)} of the ${pounds(contractDeposit)} the contract says`, `Ask the client for the other ${pounds(contractDeposit - held)} before exchange, or agree a reduced deposit with the seller's solicitor in the contract (SCS 2.2).`, s.exchange.exchangedAt ? 'completion' : 'exchange')];
  return open.map((i) => resolvedBy(i.id, 'The full deposit is held.'));
}

/** The client's authority to exchange was given on the deal as it stood: a change to the price, the date or the parties means asking again. */
function lapseExchangeAuthority(s: MatterState, why: string): NewEvent[] {
  if (s.exchange.exchangedAt || s.clientDecisions.exchange_authority?.decision !== 'authorised') return [];
  return [{ type: 'client_decision_lapsed', actor: SYSTEM, payload: { subject: 'exchange_authority', reason: why } }];
}

/**
 * Who the clients are changed (one pulls out and the other buys alone, a partner joins, a separation): everything that
 * rests on the clients is done again. The lender underwrote the old borrowers; the funds were evidenced for them; the
 * SDLT basis is every buyer's; how they own it was their joint answer; the contract and the transfer name them; their
 * authority to exchange was given together. After exchange the contract binds every original buyer.
 */
function consequencesOfClientChange(s: MatterState, names: string[], previous: string[]): NewEvent[] {
  const next = issueIds(s);
  const out: NewEvent[] = [];
  const added = names.filter((n) => !previous.includes(n));
  const removed = previous.filter((n) => !names.includes(n));
  const what = [added.length && `${added.join(' and ')} added`, removed.length && `${removed.join(' and ')} no longer a party`].filter(Boolean).join('; ') || 'clients changed';
  const buyer = profileOf(s.transactionType).side === 'buyer';
  if (s.exchange.exchangedAt) {
    out.push(issue(s, next(), 'client_change', `After exchange: ${what}`, 'The contract binds every buyer who signed it. A buyer leaving or joining now needs the seller\'s agreement (a deed of variation, or an assignment), the lender\'s consent to the new borrowers, a fresh transfer, and the funds and SDLT worked out again for the new buyers. Until that is agreed in writing, completion is held.', 'completion'));
    return out;
  }
  out.push(issue(s, next(), 'client_change', `Clients changed: ${what}`, 'Amend the draft contract and the transfer (TR1) to name the clients now on the case, and confirm the change with the other side. The report on title and every letter go to the new clients.', 'exchange'));
  if (s.hasLender && s.mortgage.status !== 'not_required') out.push(issue(s, next(), 'lender_approval', `Tell the lender: the borrowers have changed (${what})`, 'The lender underwrote the borrowers on the application. It must re-approve on the new borrowers (affordability, credit, a fresh offer in their names) before exchange.', 'exchange'));
  if (buyer && s.proofOfFunds.status !== 'not_started') out.push(issue(s, next(), 'source_of_funds', `Funds: re-evidence for the clients now buying (${what})`, 'The source of funds was evidenced for the buyers as they were. Ask where the money now comes from (a buyer leaving takes their share with them) and evidence it with a further proof-of-funds round.', 'exchange'));
  if (buyer) out.push(issue(s, next(), 'sdlt_basis', `SDLT: re-confirm the basis for the buyers now on the case (${what})`, 'The basis is every buyer\'s: one buyer who owns another home makes the whole purchase a higher-rates purchase; first-time buyer relief needs every buyer to qualify. Ask each buyer again and recalculate.', 'none'));
  if (s.clientDecisions.ownership_basis && names.length !== previous.length) out.push({ type: 'client_decision_lapsed', actor: SYSTEM, payload: { subject: 'ownership_basis', reason: `the clients changed (${what})` } });
  out.push(...lapseExchangeAuthority(s, `the clients changed (${what})`));
  return out;
}

function nextIssueId(s: MatterState): string {
  let n = Object.keys(s.issues).length + 1;
  while (s.issues[`ISS-${n}`]) n += 1;
  return `ISS-${n}`;
}

function openIssue(s: MatterState, id: string): IssueState {
  const i = s.issues[id];
  if (!i) reject(`Issue ${id} not found.`, 404);
  if (i.status !== 'open' && i.status !== 'negotiating') reject(`Issue ${id} is already ${i.status}.`);
  return i;
}

/** The machine's own issue: the lender has to be told something and confirm the offer stands before exchange. */
function lenderApprovalIssue(s: MatterState, issueId: string, title: string, sourceDocumentId: string | null, origin: { issueId: string; resolution: IssueResolution } | null): NewEvent {
  let id = issueId;
  let n = 2;
  while (s.issues[id]) id = `${issueId}${n++}`;
  return {
    type: 'issue_raised',
    actor: SYSTEM,
    payload: { issueId: id, kind: 'lender_approval', title, detail: 'A price change, an indemnity policy, a retention or a material finding must be reported to the lender, who confirms the offer stands, re-issues it, or withdraws. Exchange is held until the lender has confirmed.', gate: 'exchange', stage: s.stage, sourceDocumentId, origin },
    sourceDocumentId,
  };
}

/**
 * Proof of funds was signed off against a price; if the price rises beyond what was declared,
 * the verified funds no longer cover the purchase and the check has to be revisited.
 */
function pofShortfallIssue(s: MatterState, newPricePennies: number): NewEvent | null {
  const f = s.proofOfFunds.facts;
  if (!proofOfFundsApproved(s) || !f) return null;
  const required = Math.max(0, newPricePennies - (f.mortgageAdvancePennies ?? 0));
  if (f.totalDeclaredPennies >= required) return null;
  if (Object.values(s.issues).some((i) => i.kind === 'source_of_funds' && i.title.startsWith('Price now exceeds') && (i.status === 'open' || i.status === 'negotiating'))) return null;
  return { type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextIssueId(s), kind: 'source_of_funds', title: `Price now exceeds the verified funds by ${gbp(required - f.totalDeclaredPennies)}`, detail: `Proof of funds was signed off on ${gbp(f.totalDeclaredPennies)} declared; the balance to find is now ${gbp(required)}. Ask where the extra is coming from and evidence it (a further proof-of-funds round if needed).`, gate: 'exchange', stage: s.stage, sourceDocumentId: s.proofOfFunds.documentId, origin: null, party: null }, sourceDocumentId: s.proofOfFunds.documentId };
}

/** How the matter is abandoned when an issue proves fatal (a person may override). */
const fatalAbandonReason = (kind: IssueKind): AbandonReason => {
  if (kind === 'chain_dependency') return 'chain_collapsed';
  if (kind === 'probate_issue' || kind === 'seller_delay' || kind === 'bankruptcy_insolvency') return 'seller_withdrew';
  if (kind === 'buyer_delay' || kind === 'disclosure_concern') return 'client_withdrew';
  return FATAL_ABANDON_REASON_BY_GROUP[ISSUE_KIND_SPEC[kind].group];
};

/** Every decision is a person's to act on. (Shadow mode, which hid some, is gone; the hook stays for its callers.) */
function requireSurfaced(_s: MatterState, _d: DecisionState, _ctx: DecideContext): void {}

function pendingDecision(s: MatterState, id: string): DecisionState {
  const d = s.decisions[id];
  if (!d) reject('Decision not found.', 404);
  if (d.status !== 'pending') reject(`Decision already ${d.status}.`);
  return d;
}

/** Events for a human's resolution of a pending decision. */
function resolveEvents(s: MatterState, d: DecisionState, option: DecisionOption, note: string | null, userId: string, verification: { method: string; reference?: string | null; cop?: 'match' | 'close_match' | 'no_match' | 'unavailable' | null } | null = null, engagement: Engagement | null = null, selection: string[] | null = null, editedIn: { subject?: string | null; body?: string | null; messages?: Array<{ id: string; subject?: string | null; body?: string | null; asAttachments?: boolean; alwaysAttach?: boolean }> | null } | null = null, escalateTo: string | null = null): NewEvent[] {
  const out: NewEvent[] = [];
  const subject = d.subject ?? '';

  // PROPOSE level: the engine asked to do something. Yes → the service does it; no → it doesn't, and the reason is on the log.
  if (d.kind === 'proposal') {
    const p = s.proposals[d.eventId];
    if (!p) reject('Proposal not found for this decision.', 500);
    // Approved as worded, or with a person's edits: the edits are what goes, and the log keeps both.
    const edited = editedIn && (editedIn.subject?.trim() || editedIn.body?.trim()) ? { subject: editedIn.subject?.trim() || null, body: editedIn.body?.trim() || null } : null;
    if (option === 'approve') return [{ type: 'action_approved', actor: userId, payload: { proposalEventId: d.eventId, action: p.action, detail: edited ? { ...p.detail, edited } : p.detail, note, ...(edited ? { edited } : {}) }, sourceDocumentId: d.sourceDocumentId }];
    if (option === 'reject') return [{ type: 'action_rejected', actor: userId, payload: { proposalEventId: d.eventId, action: p.action, detail: p.detail, note }, sourceDocumentId: d.sourceDocumentId }];
    reject(`"${option}" is not an option for a proposal (approve or reject).`, 400);
  }

  // Auto-clear: at PROPOSE the clear itself was held back and goes through now; at ASSIST it
  // already happened and this only confirms it. Either way escalation goes to a person.
  if (d.kind === 'auto_clear' && option !== 'escalate') {
    const [subFlow, ...rest] = subject.split(':');
    const held = s.pendingAutoClears[d.eventId];
    const confirmed: NewEvent = { type: 'auto_clear_confirmed', actor: userId, payload: { decisionEventId: d.eventId, subFlow: subFlow as SubFlow, subject: rest.join(':'), option, note }, sourceDocumentId: d.sourceDocumentId };
    return held ? [held, confirmed] : [confirmed];
  }

  // Addendum 2 §3: a bank-details decision is resolved by a VERIFICATION with a named
  // out-of-band method, or a recorded failure — never by "approve", never by a same-channel reply.
  if (d.kind === 'bank_details' && option !== 'escalate') {
    const b = s.bankDetails[subject];
    if (!b) reject('Bank-details record not found for this decision.', 500);
    if (option === 'verify') {
      const method = verification?.method?.trim() ?? '';
      if ((REJECTED_VERIFICATION_METHODS as readonly string[]).includes(method)) reject(`"${method}" is not verification: confirmation on the channel the details arrived on is exactly what a fraudster controls. Use one of: ${VERIFICATION_METHODS.join(', ')}.`, 400);
      if (!(VERIFICATION_METHODS as readonly string[]).includes(method)) reject(`A verification method is required — one of: ${VERIFICATION_METHODS.join(', ')}.`, 400);
      if (method === 'lawyer_checker_match' && !verification?.reference?.trim()) reject('A Lawyer Checker (or equivalent) match needs its check reference.', 400);
      // Another firm's account: the firm itself is checked on the register (a cloned firm answers its own phone; parties.md 9.3).
      // Confirmation of Payee (completion.md 3.2): anything but a match keeps the stop until a person records why it is safe.
      const cop = verification?.cop ?? null;
      if ((cop === 'close_match' || cop === 'no_match' || cop === 'unavailable') && !note?.trim()) reject(`Confirmation of Payee ${cop === 'unavailable' ? 'was not available' : `gave ${cop === 'no_match' ? 'no match' : 'a close match'}`}: record why the account is still right (who you spoke to, on a number you already hold).`, 400);
      if (/solicitor/.test(b.payeeKind) && !verification?.reference?.trim()) reject("Record the firm's SRA number or the Lawyer Checker reference: the firm itself is checked on the register, not only the account.", 400);
      return [{ type: 'bank_details_verified', actor: userId, payload: { bankDetailsId: b.id, decisionEventId: d.eventId, verificationMethod: method as VerificationMethod, verificationRef: verification?.reference?.trim() || null, note, copResult: verification?.cop ?? null }, sourceDocumentId: d.sourceDocumentId }];
    }
    if (option === 'reject') {
      return [{ type: 'bank_details_verification_failed', actor: userId, payload: { bankDetailsId: b.id, decisionEventId: d.eventId, reason: note }, sourceDocumentId: d.sourceDocumentId }];
    }
    reject(`"${option}" is not an option for a bank-details change (verify, reject or escalate).`, 400);
  }

  // A note's proposals. Approving is a person saying "yes, that is what was said" — the
  // service then runs each chosen command through the machine's ordinary front door, so a
  // note can never put something into the case that a person could not have typed.
  if (d.kind === 'note_actions' && option !== 'escalate') {
    const n = s.notes[subject];
    if (!n) reject('Note not found for this decision.', 500);
    const chosen = new Set(selection && selection.length ? selection : n.actions.filter((a) => a.command).map((a) => a.id));
    const applied = option === 'approve' ? n.actions.filter((a) => a.command && chosen.has(a.id)).map((a) => a.id) : [];
    // The messages go with it: those ticked (the selection names them; without one, those ticked when the task opened), each as edited.
    const drafted: NoteMessage[] = n.messages ?? (n.reply ? [{ id: 'reply', to: 'client', purposes: [], subject: n.reply.subject, body: n.reply.body, drafter: n.reply.drafter, on: true }] : []);
    const picked = option === 'approve' ? drafted.filter((m) => (selection && selection.length ? selection.includes(m.id) : m.on)) : [];
    const edits = editedIn?.messages ?? [];
    const messages = picked.map((m) => {
      const e = edits.find((x) => x.id === m.id) ?? (m.id === 'reply' && !edits.length ? editedIn : null);
      // A file goes only if the line asking for it was approved too.
      const attach = (m.attach ?? []).filter((x) => n.actions.some((a) => applied.includes(a.id) && ((a.command?.type === 'send_file_copy' && a.command.what === x.what) || (x.what === '' && a.command?.type === 'set_file_delivery'))));
      const how = e as { asAttachments?: boolean; alwaysAttach?: boolean } | null;
      const asAttachments = attach.length > 0 && (how?.asAttachments ?? m.asAttachments ?? false);
      return { id: m.id, to: m.to, subject: (e?.subject ?? '').trim() || m.subject, body: (e?.body ?? '').trim() || m.body, ...(attach.length ? { attach } : {}), ...(asAttachments ? { asAttachments: true } : {}), ...(asAttachments && (how?.alwaysAttach ?? m.alwaysAttach) ? { alwaysAttach: true } : {}) };
    });
    const skipped = n.actions.filter((a) => !applied.includes(a.id)).map((a) => a.id);
    // An email that proposed nothing (Read And Reply, or an acknowledgement): Approve is "dealt with" and applies nothing.
    if (option === 'approve' && !applied.length && !messages.length && n.actions.some((a) => a.command)) reject('Nothing was selected to apply. Reject the note\'s reading instead, with a reason.', 400);
    // Other emails waiting on the same subject (the same issue proposed) are settled with this one: one subject, one task.
    const topics = new Set(noteTopics(n));
    const same: NewEvent[] = topics.size ? Object.values(s.decisions).filter((x) => x.kind === 'note_actions' && x.status === 'pending' && x.eventId !== d.eventId && noteTopics(s.notes[x.subject ?? '']).some((t) => topics.has(t))).map((x): NewEvent => ({ type: 'note_actions_applied', actor: userId, payload: { noteId: x.subject ?? '', decisionEventId: x.eventId, applied: [], skipped: (s.notes[x.subject ?? '']?.actions ?? []).map((a) => a.id), option: 'reject', note: 'The same point as a later email, dealt with there.' }, sourceDocumentId: x.sourceDocumentId })) : [];
    return [...same, { type: 'note_actions_applied', actor: userId, payload: { noteId: n.id, decisionEventId: d.eventId, applied, skipped, option, note, ...(messages.length ? { messages } : {}) }, sourceDocumentId: d.sourceDocumentId }];
  }

  // "Escalate to senior": the original decision is marked escalated and a NEW decision
  // (kind escalation) is queued, carrying the same source so the senior sees what the
  // handler saw. Resolving that later also resolves the original sub-flow.
  if (option === 'escalate' && d.kind !== 'escalation') {
    if (d.kind === 'auto_clear') {
      // The clear stays held until the senior answers (confirming it now would throw the held clear away).
    } else if (d.kind === 'bank_details' || d.kind === 'requisition' || d.kind === 'report_on_title' || d.kind === 'note_actions') {
      // handled via the generic escalation (the bank record stays unverified, the requisition open, the draft or the proposal waiting): the senior's answer settles it
    } else {
      out.push(reviewedEvent(s, d, option, note, userId, subject, engagement));
    }
    const decision: DecisionSpec = {
      kind: 'escalation',
      summary: `Escalated by handler${note ? `: ${note}` : ''}.\n\nOriginal decision (${d.kind}${subject ? ` ${subject}` : ''}):\n${d.summary}`,
      sourceDocumentId: d.sourceDocumentId,
      sourceLocator: d.sourceLocator,
      citations: d.citations,
      options: OPTIONS_FOR.escalation,
      summarisedBy: d.summarisedBy,
    };
    out.push({ type: 'escalation_raised', actor: userId, payload: { waitKey: null, subject, reason: note ?? 'escalated by handler', decision, origin: { decisionEventId: d.eventId, kind: d.kind }, assignedTo: escalateTo }, sourceDocumentId: d.sourceDocumentId });
    return out;
  }

  switch (d.kind) {
    case 'escalation': {
      out.push({ type: 'escalation_resolved', actor: userId, payload: { escalationEventId: d.eventId, decisionEventId: d.eventId, option, note } });
      if (option === 'escalate') {
        // Escalating an escalation: chain upwards with a fresh decision carrying the same origin.
        const decision: DecisionSpec = {
          kind: 'escalation',
          summary: `Escalated again${note ? `: ${note}` : ''}.\n\n${d.summary}`,
          sourceDocumentId: d.sourceDocumentId,
          sourceLocator: d.sourceLocator,
          citations: d.citations,
          options: OPTIONS_FOR.escalation,
          summarisedBy: d.summarisedBy,
        };
        out.push({ type: 'escalation_raised', actor: userId, payload: { waitKey: null, subject, reason: note ?? 'escalated again', decision, origin: d.origin, assignedTo: escalateTo }, sourceDocumentId: d.sourceDocumentId });
        return out;
      }
      // Resolving the escalation resolves the sub-flow it came from (user escalations).
      const origin = d.origin;
      if (origin) {
        const od = s.decisions[origin.decisionEventId];
        // The senior's answer settles what was escalated, in that decision's own terms.
        if (od && od.status !== 'actioned') {
          const yes = option === 'approve';
          if (od.kind === 'report_on_title') {
            if (s.reportOnTitle.draftId === od.subject && s.reportOnTitle.status === 'drafted') out.push(yes ? { type: 'report_on_title_approved', actor: userId, payload: { draftId: od.subject as string, decisionEventId: od.eventId, note }, sourceDocumentId: od.sourceDocumentId } : { type: 'report_on_title_rejected', actor: userId, payload: { draftId: od.subject as string, decisionEventId: od.eventId, note }, sourceDocumentId: od.sourceDocumentId });
          } else if (od.kind === 'proposal') {
            const p = s.proposals[od.eventId];
            if (p && p.status === 'pending') out.push(yes ? { type: 'action_approved', actor: userId, payload: { proposalEventId: od.eventId, action: p.action, detail: p.detail, note }, sourceDocumentId: od.sourceDocumentId } : { type: 'action_rejected', actor: userId, payload: { proposalEventId: od.eventId, action: p.action, detail: p.detail, note }, sourceDocumentId: od.sourceDocumentId });
          } else if (od.kind === 'auto_clear') {
            // The senior's answer settles the held clear: it is applied, and the auto-clear confirmed with their note.
            const [subFlow, ...rest] = (od.subject ?? '').split(':');
            const held = s.pendingAutoClears[od.eventId];
            if (held) out.push(held);
            out.push({ type: 'auto_clear_confirmed', actor: userId, payload: { decisionEventId: od.eventId, subFlow: subFlow as SubFlow, subject: rest.join(':'), option: 'approve', note: `Escalated and settled: ${note ?? option}` }, sourceDocumentId: od.sourceDocumentId });
          } else if (od.kind === 'bank_details' || od.kind === 'requisition' || od.kind === 'note_actions' || od.kind === 'escalation') {
            // Settled by its own command (a verification, a reply, the note's actions): the escalation only records the senior's view.
          } else if (od.kind === 'contract') {
            if (yes) out.push({ type: 'contract_approved', actor: userId, payload: { note, decisionEventId: od.eventId }, sourceDocumentId: od.sourceDocumentId });
          } else {
            out.push(reviewedEvent(s, od, option, note, userId, od.subject ?? ''));
            if (od.kind === 'proof_of_funds') pofConsequences(s, od, option, note, userId, out, true);
          }
        }
      }
      return out;
    }
    case 'requisition': {
      out.push({ type: 'hmlr_requisition_responded', actor: userId, payload: { decisionEventId: d.eventId, option, note, engagement } });
      return out;
    }
    case 'contract': {
      // Approving the task is approving the contract: the same event as the button, so the deposit request and the signing pack follow.
      if (option === 'approve') {
        requireStageAtLeast(s, 'contract_review', 'Approving the contract');
        out.push({ type: 'contract_approved', actor: userId, payload: { note, decisionEventId: d.eventId }, sourceDocumentId: d.sourceDocumentId });
        return out;
      }
      out.push({ type: 'contract_reviewed', actor: userId, payload: { decisionEventId: d.eventId, option, note }, sourceDocumentId: d.sourceDocumentId });
      // Points on the draft go back to the seller's solicitor as an enquiry; the amended contract comes back as a new task.
      if (option === 'request_further') out.push({ type: 'enquiry_raised', actor: userId, payload: { enquiryId: nextEnquiryId(s, 'CONTRACT'), subject: `Points on the draft contract${note ? `: ${note}` : ''}`, origin: { decisionEventId: d.eventId }, counterpartyType: s.counterpartyType } });
      return out;
    }
    case 'report_on_title': {
      const draftId = subject;
      if (s.reportOnTitle.draftId !== draftId || s.reportOnTitle.status !== 'drafted') reject('This draft is no longer the current draft.');
      if (option === 'approve') out.push({ type: 'report_on_title_approved', actor: userId, payload: { draftId, decisionEventId: d.eventId, note }, sourceDocumentId: d.sourceDocumentId });
      else out.push({ type: 'report_on_title_rejected', actor: userId, payload: { draftId, decisionEventId: d.eventId, note }, sourceDocumentId: d.sourceDocumentId });
      return out;
    }
    default:
      out.push(reviewedEvent(s, d, option, note, userId, subject, engagement));
  }

  // "Request further search/enquiry" raises the follow-up enquiry so the wait is tracked.
  if (option === 'request_further' && (d.kind === 'search' || d.kind === 'enquiry' || d.kind === 'title' || d.kind === 'mortgage')) {
    // A follow-up on a search is keyed by the search (CON29-F1), so it reads as "our enquiry on the CON29 search".
    const enquiryId = nextEnquiryId(s, d.kind === 'enquiry' ? subject : d.kind === 'search' && subject ? subject.toUpperCase() : d.kind.toUpperCase());
    out.push({ type: 'enquiry_raised', actor: userId, payload: { enquiryId, subject: `Further enquiry following ${d.kind}${subject ? ` ${subject}` : ''} review${note ? `: ${note}` : ''}`, origin: { decisionEventId: d.eventId, followUpOf: d.kind === 'enquiry' ? subject : undefined }, counterpartyType: s.counterpartyType } });
  }
  // An indemnity policy on a lender-funded purchase needs the lender's approval before exchange (docs/engine-issues.md).
  if (option === 'indemnity' && s.hasLender && !s.exchange.exchangedAt && (d.kind === 'search' || d.kind === 'title' || d.kind === 'enquiry')) {
    out.push(lenderApprovalIssue(s, `${d.kind}:${subject || d.eventId}:indemnity:lender`, `Tell the lender: indemnity policy proposed for ${d.kind === 'search' ? `the ${subject ? `${subject} ` : ''}search` : d.kind === 'title' ? 'the title' : d.kind === 'enquiry' ? `the reply to enquiry ${subject.replace(/^ISS-\d+-/, '')}` : d.kind}`, d.sourceDocumentId, null));
  }
  // Proof of funds (docs/proof-of-funds.md): sign-off closes the source-of-funds issues it answers; a gift on a
  // lender-funded purchase must be declared to the lender; rejection is a hard stop like a failed ID check.
  if (d.kind === 'proof_of_funds') pofConsequences(s, d, option, note, userId, out);
  return out;
}

/** What a proof-of-funds sign-off does (by the handler, or by the senior it was escalated to). */
function pofConsequences(s: MatterState, d: DecisionState, option: DecisionOption, note: string | null, userId: string, out: NewEvent[], escalated = false): void {
    const facts = s.proofOfFunds.facts;
    const open = openPofQueries(s);
    const donorsPending = Object.values(s.partyChecks).filter((pc) => pc.role === 'donor' && !isResolved(pc.status));
    if (option === 'approve' && donorsPending.length) reject(`Sign-off waits for the donor's ID / AML check: ${donorsPending.map((pc) => `${pc.label} ${pc.status.replace(/_/g, ' ')}`).join('; ')}.`);
    if (option === 'approve' && open.length) {
      // The warning stands, the person decides: a reason signs off regardless and withdraws each open query with that reason on the record.
      if (!note?.trim()) reject(`${open.length} quer${open.length === 1 ? 'y is' : 'ies are'} still open (${open.map((q) => q.id).join(', ')}). Send them to the client (Query the client), withdraw each with a reason, or give a reason here to sign off regardless — it is recorded against each query.`, 409);
      for (const q of open) out.push({ type: 'proof_of_funds_query_withdrawn', actor: userId, payload: { queryId: q.id, reason: `Signed off with this query outstanding: ${note.trim()}` } });
    }
    if (option === 'request_further' && open.length === 0 && !note?.trim()) reject('There is nothing to put to the client: add a query first, or write what you need in the reason.', 400);
    // Money from a high-risk third country: enhanced due diligence is mandatory and the MLRO signs off (money.md 3.1).
    if (option === 'approve' && !escalated && (s.proofOfFunds.flags ?? []).some((f) => f.code === 'POF_HIGH_RISK_COUNTRY')) reject('Money from a high-risk third country: escalate this to the MLRO, who signs it off.', 412);
    if (option === 'approve') {
      for (const i of Object.values(s.issues)) {
        if (i.kind === 'source_of_funds' && (i.status === 'open' || i.status === 'negotiating') && !i.title.startsWith('Money still to arrive')) out.push({ type: 'issue_resolved', actor: userId, payload: { issueId: i.id, resolution: 'evidence_provided', note: `Proof of funds signed off${note ? `: ${note}` : ''}`, costPennies: null, paidBy: null }, sourceDocumentId: d.sourceDocumentId });
      }
      // Money still to arrive holds exchange until it is in client account (money.md 3.3, 3.6, 3.7, 3.9).
      if (facts) {
        const pend = [...out];
        for (const src of facts.sources.filter((x) => x.notYetReceived)) {
          const title = `Money still to arrive: ${FUND_SOURCE_LABEL[src.kind].toLowerCase()} ${gbp(src.amountPennies)}`;
          if (openOf(s, 'source_of_funds', title)) continue;
          const e = issue(s, issueIds(s, pend)(), 'source_of_funds', title, `${src.description}. Not in the client's account at sign-off. Get the letter that says when it comes (the executors' solicitor, the platform, the new lender${src.kind === 'overseas' ? ', the bank sending it: allow for the exchange rate and the receiving bank\'s checks' : ''}); exchange waits until it is in client account or the other solicitor undertakes to send it.`, s.exchange.exchangedAt ? 'completion' : 'exchange');
          pend.push(e); out.push(e);
        }
        // What each buyer puts in, from the sources attributed to them (money.md 1.3, 10.7): unequal money is a declaration-of-trust question.
        const cs = contributionsFrom(facts, s.partyNames ?? []);
        if (cs && unequal(cs) && !s.coOwnership && !openOf(s, 'co_ownership_advice', 'Record what each buyer')) {
          const e = issue(s, issueIds(s, pend)(), 'co_ownership_advice', 'Record what each buyer puts in', `From the proof of funds: ${cs.map((c) => `${c.party} ${gbp(c.pennies)}`).join(', ')}. Unequal money: advise on holding as tenants in common with a declaration of trust, and record the contributions.`, s.exchange.exchangedAt ? 'completion' : 'exchange');
          pend.push(e); out.push(e);
        }
      }
      if (facts && facts.giftedPennies > 0 && s.hasLender && !s.exchange.exchangedAt) {
        const donors = facts.sources.filter((x) => x.kind === 'gift' && x.gift).flatMap((x) => [x.gift!.donorName, ...(x.gift!.jointDonorName?.trim() ? [`${x.gift!.jointDonorName.trim()} (joint account)`] : [])]).join(', ');
        out.push(lenderApprovalIssue(s, `pof:${facts.requestId}:gift:lender`, `Tell the lender: gifted deposit ${gbp(facts.giftedPennies)}${donors ? ` from ${donors}` : ''}`, d.sourceDocumentId, null));
      }
    }
    if (option === 'reject' && !s.manualHandling.required) {
      out.push({ type: 'manual_handling_required', actor: userId, payload: { reason: 'proof_of_funds_rejected', detail: note ?? undefined } });
    }
  }

function reviewedEvent(s: MatterState, d: DecisionState, option: DecisionOption, note: string | null, userId: string, subject: string, engagement: Engagement | null = null): NewEvent {
  const base = { decisionEventId: d.eventId, option, note, engagement };
  // note_actions never reaches here: it is resolved into note_actions_applied above.
  if (d.kind === 'note_actions') reject('A note\'s proposals are applied, not reviewed.', 500);
  switch (d.kind) {
    case 'id_check': {
      const party = Object.values(s.partyChecks).find((pc) => pc.decisionEventId === d.eventId)?.party ?? null;
      return { type: 'id_check_reviewed', actor: userId, payload: { ...base, party }, sourceDocumentId: d.sourceDocumentId };
    }
    case 'search':
      return { type: 'search_reviewed', actor: userId, payload: { ...base, searchType: subject as SearchType }, sourceDocumentId: d.sourceDocumentId };
    case 'enquiry':
      return { type: 'enquiry_reply_reviewed', actor: userId, payload: { ...base, enquiryId: subject }, sourceDocumentId: d.sourceDocumentId };
    case 'mortgage':
      return { type: 'mortgage_condition_reviewed', actor: userId, payload: base, sourceDocumentId: d.sourceDocumentId };
    case 'title':
      return { type: 'title_reviewed', actor: userId, payload: base, sourceDocumentId: d.sourceDocumentId };
    case 'proof_of_funds':
      return { type: 'proof_of_funds_reviewed', actor: userId, payload: { ...base, requestId: subject }, sourceDocumentId: d.sourceDocumentId };
    case 'management_pack':
      return { type: 'management_pack_reviewed', actor: userId, payload: base, sourceDocumentId: d.sourceDocumentId };
    case 'contract':
      return option === 'approve'
        ? { type: 'contract_approved', actor: userId, payload: { note, decisionEventId: d.eventId }, sourceDocumentId: d.sourceDocumentId }
        : { type: 'contract_reviewed', actor: userId, payload: { decisionEventId: d.eventId, option, note }, sourceDocumentId: d.sourceDocumentId };
    case 'report_on_title':
    case 'escalation':
    case 'bank_details':
    case 'auto_clear':
    case 'requisition':
    case 'proposal':
      return reject('Not a reviewable decision kind.', 500);
  }
}

/** Addendum 2: the only bank details a payment may use — the newest for the payee, verified, with no change pending. */
function assertPayableDetails(s: MatterState, payeeKind: PayeeKind, bankDetailsId: string): void {
  const b = s.bankDetails[bankDetailsId];
  if (!b) reject('Bank-details record not found.', 404);
  if (b.payeeKind !== payeeKind) reject(`Those bank details belong to ${b.payeeKind.replace(/_/g, ' ')}, not ${payeeKind.replace(/_/g, ' ')}.`, 400);
  const pend = pendingBankDetailsDecision(s, payeeKind);
  if (pend) reject(`HARD STOP: a bank-details change for ${payeeKind.replace(/_/g, ' ')} is awaiting out-of-band verification. No payment can proceed until it is resolved.`, 423);
  const cur = currentBankDetails(s, payeeKind);
  if (!cur || cur.id !== b.id) reject('Those bank details have been superseded by a newer record; verify the newest record and use that.', 409);
  if (b.status !== 'verified') reject(`Bank details are ${b.status}; only out-of-band verified details can be paid.`, 412);
}

/** E1, E2… (or ISS-3-E1 when raised from an issue) — deterministic from the state. */
function nextPlainEnquiryId(s: MatterState, issueId: string | null): string {
  const stem = issueId ? `${issueId}-E` : 'E';
  let n = 1;
  while (s.enquiries[`${stem}${n}`]) n += 1;
  return `${stem}${n}`;
}

function nextEnquiryId(s: MatterState, base: string): string {
  const stem = base.replace(/-F\d+$/i, '');
  let n = 1;
  while (s.enquiries[`${stem}-F${n}`]) n += 1;
  return `${stem}-F${n}`;
}

/** The "no AI content reaches a client without a logged human approval" invariant. */
/**
 * Why a report on title cannot be drafted now, or null. Once the title is resolved it can be written: in pre-contract
 * it is an interim report (searches, enquiries or the offer still to come) and a supplementary one follows before
 * exchange; in contract review it is the full report. Asked by the drafter before it writes anything.
 */
export function reportDraftProblem(s: MatterState): string | null {
  if (s.stage !== 'pre_contract' && s.stage !== 'contract_review' && !(s.stage === 'pre_exchange' && s.reportOnTitle.interimSentAt)) return `The report on title is written in pre-contract or contract review; this case is at ${s.stage.replace(/_/g, ' ')}.`;
  if (!isResolved(s.title.status)) return `Title is ${s.title.status}; resolve it before drafting the report.`;
  if (s.reportOnTitle.status === 'drafted') return 'A draft is already awaiting approval.';
  if (s.reportOnTitle.status === 'approved') return 'An approved draft is awaiting sending.';
  if (s.reportOnTitle.status === 'sent') return 'The report on title has already been sent.';
  return null;
}

export function assertCanSendReport(s: MatterState, draftId: string): void {
  requireEnrolled(s);
  const r = s.reportOnTitle;
  if (r.draftId !== draftId) reject('That draft is not the current report on title.');
  if (r.status === 'sent') reject('The report on title has already been sent.');
  if (r.status !== 'approved' || !r.approvedEventId) reject('The report on title has not been approved by a conveyancer.', 412);
  if (r.interim && s.stage !== 'pre_contract') reject('This draft was written as an interim report, before searches, enquiries and the offer were all in; they are in now, so draft the report again.');
  if (!r.approvedBy || !isUserActor(r.approvedBy)) reject('Approval must come from a person, not automation.', 412);
}
