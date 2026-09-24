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
import { applyEvent } from './projection';
import type { DeadlineKind } from './sla';
import { validateNoteActions, summariseNoteActions, type NoteActionDraft } from './notes';
import { ISSUE_SEVERITIES, type IssueSeverity, FATAL_ABANDON_REASON_BY_GROUP, ISSUE_KIND_SPEC, LENDER_NOTIFY_RESOLUTIONS, PRICE_RESOLUTIONS, REOPENS_OFFER, RESOLUTION_LABEL, type IssueGate, type IssueKind, type IssueResolution } from './issues';
import { buildDecision, evaluateEnquiryReply, evaluateIdCheck, evaluateMortgageOffer, evaluateSearch, evaluateTitle, OPTIONS_FOR, optionLabel, type Verdict } from './rules';
import { evaluateProofOfFunds, gbp, riskRating, templateBriefing, type PofQuery, type ProofOfFundsFacts, type StatementTransaction, type TransactionReview } from './proof-of-funds';
import { profileOf, type TransactionProfile } from './transactions';
import {
  EngineError,
  isResolved,
  isUserActor,
  stageIndex,
  STAGES,
  SYSTEM,
  AI,
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
  type SubflowConfig,
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
  DEFAULT_SUBFLOW_CONFIG,
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
  type WaitKey,
  NOTE_KINDS,
  type NoteKind,
} from './types';

/** An optional AI-produced summary handed in by the service (component #3). The verdict is never AI's. */
export interface SummaryOverride {
  text: string;
  by: string;
}

export type Command =
  | { type: 'enrol'; actor: Actor; transactionType?: TransactionType | null; requireProofOfFunds?: boolean | null; requireExchangeAuthority?: boolean | null; parties?: number | null; hasExistingMortgage?: boolean | null; considerationPennies?: number | null; hasLender: boolean; requiredSearches?: SearchType[]; targetExchangeDate?: string | null; targetCompletionDate?: string | null; counterpartyType?: CounterpartyType | null; shadowMode?: boolean }
  | { type: 'mark_manual_handling'; actor: Actor; reason: string; detail?: string }
  | { type: 'request_id_check'; actor: Actor; provider: string; reference?: string | null }
  | { type: 'id_check_result'; actor: Actor; documentId: string; facts: IdCheckFacts; summary?: SummaryOverride | null }
  | { type: 'record_search_ordered'; actor: Actor; searchType: SearchType; provider: string; reference?: string | null }
  | { type: 'search_returned'; actor: Actor; searchType: SearchType; documentId: string; provider?: string | null }
  | { type: 'search_extracted'; actor: Actor; searchType: SearchType; facts: SearchFacts; extractor: string; summary?: SummaryOverride | null }
  | { type: 'raise_enquiry'; actor: Actor; enquiryId?: string | null; subject: string; origin?: { decisionEventId?: string; followUpOf?: string; issueId?: string } | null }
  | { type: 'enquiry_reply_received'; actor: Actor; enquiryId: string; documentId: string; facts?: EnquiryReplyFacts | null; summary?: SummaryOverride | null }
  | { type: 'mortgage_offer_received'; actor: Actor; documentId: string; lender?: string | null }
  | { type: 'mortgage_offer_extracted'; actor: Actor; facts: MortgageOfferFacts; extractor: string; summary?: SummaryOverride | null }
  | { type: 'title_extracted'; actor: Actor; documentId: string; facts: TitleFacts; extractor: string; summary?: SummaryOverride | null }
  | { type: 'open_decision_source'; userId: string; decisionEventId: string; documentId: string }
  | { type: 'resolve_decision'; userId: string; decisionEventId: string; option: DecisionOption; note?: string | null; verification?: { method: string; reference?: string | null } | null; engagement?: Engagement | null; selection?: string[] | null }
  | { type: 'record_note'; actor: Actor; kind: NoteKind; text: string; noteId?: string | null; documentId?: string | null; durationSeconds?: number | null }
  | { type: 'note_extracted'; noteId: string; drafts: NoteActionDraft[]; extractor: string }
  | { type: 'note_action_refused'; noteId: string; actionId: string; reason: string }
  | { type: 'record_suppressed'; action: SuppressedAction; reason: 'shadow_mode' | 'subflow_shadow'; subFlow: SubFlow | null; detail: Record<string, unknown> }
  | { type: 'set_shadow_mode'; actor: Actor; shadowMode: boolean; reason?: string | null }
  // ── eventualities (docs/engine-eventualities.md) ──
  | { type: 'abandon_matter'; actor: Actor; reason: AbandonReason; detail?: string | null }
  | { type: 'set_target_dates'; actor: Actor; targetExchangeDate?: string | null; targetCompletionDate?: string | null; reason?: string | null }
  | { type: 'change_completion_date'; actor: Actor; completionDate: string; reason?: string | null }
  | { type: 'notice_to_complete_served'; actor: Actor; servedBy: 'buyer' | 'seller'; servedAt?: string | null; expiresAt: string; documentId: string }
  | { type: 'mortgage_offer_withdrawn'; actor: Actor; reason: string; lender?: string | null }
  | { type: 'withdraw_enquiry'; actor: Actor; enquiryId: string; reason: string }
  | { type: 'hmlr_requisition_received'; actor: Actor; documentId: string; reference?: string | null; deadline?: string | null; summary?: SummaryOverride | null }
  | { type: 'record_correction'; actor: Actor; aboutEventId: string; reason: string }
  | { type: 'record_handler_change'; actor: Actor; fromUserId: string | null; toUserId: string; reason?: string | null }
  | { type: 'raise_deadline_escalation'; kind: DeadlineKind; dueDate: string; subject: string; summary: string; sourceDocumentId: string }
  // ── issues (docs/engine-issues.md) ──
  | { type: 'raise_issue'; actor: Actor; issueId?: string | null; kind: IssueKind; title: string; detail?: string | null; gate?: IssueGate | null; documentId?: string | null; party?: string | null; severity?: IssueSeverity | null; causedBy?: string | null }
  | { type: 'set_issue_severity'; actor: Actor; issueId: string; severity: IssueSeverity; reason: string }
  // ── case model: survey workstream, client decisions, closure ──
  | { type: 'survey_received'; actor: Actor; documentId: string; surveyType: SurveyType; facts: SurveyFacts; extractor: string }
  | { type: 'specialist_report_received'; actor: Actor; documentId: string; facts: SurveyFacts; forIssueId?: string | null; extractor: string }
  | { type: 'client_decision_recorded'; actor: Actor; subject: ClientDecisionSubject; decision: string; note?: string | null; evidenceDocumentId?: string | null }
  | { type: 'close_matter'; actor: Actor; reason?: string | null }
  | { type: 'update_issue'; actor: Actor; issueId: string; status: 'open' | 'negotiating'; note?: string | null; gate?: IssueGate | null; party?: string | null }
  | { type: 'resolve_issue'; actor: Actor; issueId: string; resolution: IssueResolution; note?: string | null; newPricePennies?: number | null; costPennies?: number | null; paidBy?: IssuePaidBy | null }
  // ── proof of funds (docs/proof-of-funds.md) ──
  | { type: 'request_proof_of_funds'; actor: Actor; requestId: string; channel: string; messageId?: string | null; formUrl?: string | null; followUpOf?: string | null; noteToClient?: string | null; queryIds?: string[] }
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
  | { type: 'deposit_received'; actor: Actor; amountPennies?: number | null }
  | { type: 'contracts_exchanged'; actor: Actor; completionDate: string; exchangedAt?: string | null }
  | { type: 'completion_statement_generated'; actor: Actor; documentId?: string | null }
  | { type: 'funds_requested'; actor: Actor; fromRole: 'lender' | 'client'; amountPennies?: number | null; bankDetailsId: string }
  | { type: 'funds_received'; actor: Actor; fromRole: 'lender' | 'client' | 'buyer_solicitor' | 'incoming_owner'; amountPennies?: number | null }
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
  | { type: 'request_lender_consent'; actor: Actor; lender?: string | null }
  | { type: 'lender_consent_received'; actor: Actor; lender?: string | null; conditions?: string | null }
  | { type: 'transfer_deed_executed'; actor: Actor; parties: string[]; witnessed?: boolean }
  | { type: 'deed_of_trust_executed'; actor: Actor; parties: string[]; shares?: string | null; documentId?: string | null }
  | { type: 'sdlt_not_required'; actor: Actor; reason: string }
  | { type: 'completion_confirmed'; actor: Actor; completedAt?: string | null }
  | { type: 'sdlt_submitted'; actor: Actor; reference?: string | null }
  | { type: 'ap1_submitted'; actor: Actor; reference?: string | null }
  | { type: 'ap1_confirmed'; actor: Actor; titleNumber?: string | null }
  | { type: 'record_chase'; chase: ChaseSpec }
  | { type: 'record_acknowledgement'; ack: AcknowledgementSpec }
  | { type: 'raise_escalation'; waitKey: WaitKey; subject: string; reason: string; sourceDocumentId: string; summary?: SummaryOverride | null }
  | { type: 'record_client_update'; update: ClientUpdateSpec };

export type CommandType = Command['type'];

/** Commands a human may issue from the dashboard/API. Everything else is automation-only. */
export const USER_COMMANDS: ReadonlyArray<CommandType> = [
  'enrol',
  'mark_manual_handling',
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
  'change_completion_date',
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

export interface DecideContext {
  now: Date;
  /** Addendum 3 §2: trust level per sub-flow (tenant config). Defaults to assist. */
  subflows?: SubflowConfig;
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
  if (!stageAtLeast(s, stage)) reject(`${what} is not valid before stage "${stage}" (matter is at "${s.stage}").`);
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
export function stageBlockers(s: MatterState): string[] {
  if (!s.enrolled) return ['not enrolled'];
  if (s.abandoned) return [`matter abandoned (${s.abandoned.reason.replace(/_/g, ' ')})`];
  if (s.closedAt) return ['matter closed'];
  if (s.manualHandling.required) return [`manual handling: ${s.manualHandling.reason ?? 'unspecified'}`];
  const p = profile(s);
  if (p.side === 'seller') return saleBlockers(s);
  if (p.side === 'owner') return ownerBlockers(s, p);
  const b: string[] = [];
  switch (s.stage) {
    case 'instruction':
      if (!isResolved(s.idCheck.status)) b.push(`ID/AML check ${s.idCheck.status.replace('_', ' ')}`);
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
      if (surveyHolds(s)) b.push(`survey: client not yet ${s.survey.status === 'further_investigation' ? 'able to decide — further investigation outstanding' : s.survey.status === 'client_renegotiating' ? 'satisfied — renegotiating' : 'confirmed satisfied with the physical condition'}`);
      if (exchangeAuthorityHolds(s)) b.push('client has not yet authorised exchange');
      if (!s.exchange.exchangedAt) b.push(s.exchange.conditionsMet ? 'contracts not yet exchanged' : 'exchange conditions not met');
      break;
    case 'exchanged':
      if (!s.completion.statementGeneratedAt) b.push('completion statement not generated');
      break;
    case 'pre_completion':
      if (!s.completion.confirmedAt) {
        b.push(...issueBlockers(s, 'completion'));
        if (!s.completion.fundsReceivedAt) b.push('funds not received');
        if (!s.payments.some((p) => p.payeeKind === 'seller_solicitor' && p.purpose === 'completion_monies')) b.push('completion payment not authorised against verified bank details');
        if (pendingBankDetailsDecision(s, 'seller_solicitor')) b.push('bank-details change awaiting out-of-band verification (hard stop)');
        if (s.completion.fundsReceivedAt && s.payments.length) b.push('completion not confirmed');
      }
      break;
    case 'completed':
      if (!s.postCompletion.sdltSubmittedAt && !s.postCompletion.ap1SubmittedAt) b.push('SDLT / AP1 not submitted');
      break;
    case 'post_completion':
      if (s.postCompletion.requisitions.some((r) => !r.respondedAt)) b.push('HMLR requisition outstanding');
      b.push(s.postCompletion.ap1ConfirmedAt ? 'matter complete' : 'awaiting HMLR registration');
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
      b.push(...issueBlockers(s, 'exchange'));
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
        if (!s.completion.fundsReceivedAt) b.push("completion monies not received from the buyer's solicitor");
        if (s.hasExistingMortgage && !s.payments.some((x) => x.payeeKind === 'lender')) b.push('redemption payment not authorised against verified lender details');
        if (pendingBankDetailsDecision(s, 'lender')) b.push('lender bank-details change awaiting out-of-band verification (hard stop)');
        if (s.completion.fundsReceivedAt) b.push('completion not confirmed');
      }
      break;
    case 'completed':
      if (s.hasExistingMortgage && s.redemption.status !== 'redeemed' && s.redemption.status !== 'discharged') b.push('mortgage not yet recorded as redeemed');
      if (!s.payments.some((x) => x.payeeKind === 'client')) b.push('balance to the client not authorised against verified client details');
      break;
    case 'post_completion':
      if (s.hasExistingMortgage && s.redemption.status !== 'discharged') b.push("awaiting the lender's discharge (DS1 / e-DS1)");
      else b.push('matter complete');
      break;
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
      break;
    case 'pre_contract':
      if (!isResolved(s.title.status)) b.push(`title ${s.title.status}`);
      b.push(...unresolvedSearches(s, true));
      if (remo && !isResolved(s.mortgage.status)) b.push(`mortgage offer ${s.mortgage.status}`);
      if (s.hasExistingMortgage && remo && s.redemption.status !== 'received' && s.redemption.status !== 'redeemed' && s.redemption.status !== 'discharged') b.push(`redemption statement ${s.redemption.status === 'requested' ? 'awaited' : 'not requested'}`);
      if (s.hasExistingMortgage && !remo && s.lenderConsent.status !== 'received') b.push(`lender's consent ${s.lenderConsent.status === 'requested' ? 'awaited' : 'not requested'}`);
      if (!remo && s.parties > 1 && !s.clientDecisions.ownership_basis) b.push('basis of co-ownership not yet decided by the clients');
      b.push(...issueBlockers(s, 'exchange'));
      break;
    case 'pre_completion':
      if (!s.completion.confirmedAt) {
        b.push(...issueBlockers(s, 'completion'));
        if (remo && !s.deeds.mortgageDeedAt) b.push('mortgage deed not executed');
        if (remo && !s.deeds.certificateOfTitleAt) b.push('certificate of title not sent to the lender');
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
      b.push(s.postCompletion.ap1ConfirmedAt ? 'matter complete' : 'awaiting HMLR registration');
      break;
  }
  return b;
}

/** A survey on file means the client must confirm they are satisfied with the physical condition before exchange (their decision, never inferred). */
const surveyHolds = (s: MatterState): boolean => surveyApplies(s) && s.survey.status !== 'client_satisfied';
/** Firm policy: the client's recorded authority to exchange. */
const exchangeAuthorityHolds = (s: MatterState): boolean => s.requireExchangeAuthority && s.clientDecisions.exchange_authority?.decision !== 'authorised';
const proofOfFundsHoldReason = (s: MatterState): string => (s.proofOfFunds.status === 'submitted' ? 'awaiting sign-off' : s.proofOfFunds.status === 'requested' ? 'requested from the client' : s.proofOfFunds.status === 'reviewed' ? `${s.proofOfFunds.resolution === 'reject' ? 'rejected' : 'not signed off'} — a new round is needed` : 'not yet requested (firm policy)');

/** Open issues holding a stage exit, as blocker lines. */
function issueBlockers(s: MatterState, gate: IssueGate): string[] {
  return issuesGating(s, gate).map((i) => `issue: ${ISSUE_KIND_SPEC[i.kind].label} — ${i.title} (${i.status})`);
}

/** Required searches not yet resolved; `includeUnordered` also lists ones never ordered (pre_contract only). */
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
function automatic(state: MatterState, now: Date): NewEvent[] {
  const out: NewEvent[] = [];
  let s = state;
  for (let guard = 0; guard < 16; guard++) {
    let ev: NewEvent | null = null;
    if (s.abandoned) break;
    const side = profile(s).side;
    if (side === 'buyer' && s.enrolled && s.stage === 'pre_exchange' && s.deposit.received && !s.exchange.conditionsMet && !s.manualHandling.required && (!s.hasLender || isResolved(s.mortgage.status)) && issuesGating(s, 'exchange').length === 0 && !proofOfFundsHolds(s) && !surveyHolds(s) && !exchangeAuthorityHolds(s)) {
      ev = { type: 'exchange_conditions_met', actor: SYSTEM, payload: { conditions: ['report on title sent', 'title resolved', 'searches resolved', 'deposit received', s.hasLender ? 'mortgage offer resolved' : 'cash purchase', 'no open issue holding exchange'] } };
    } else if (side === 'seller' && s.enrolled && s.stage === 'pre_exchange' && !s.exchange.conditionsMet && !s.manualHandling.required && (!s.hasExistingMortgage || s.redemption.status === 'received') && Object.values(s.inboundEnquiries).every((q) => q.repliedAt) && issuesGating(s, 'exchange').length === 0 && !exchangeAuthorityHolds(s)) {
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
  /** assist → the auto-clear is put in front of a person too (non-blocking); autonomous/shadow → not. */
  subflowStatus?: 'shadow' | 'assist' | 'autonomous';
}): NewEvent[] {
  if (input.verdict.outcome === 'clear') {
    const cleared = { type: input.cleared, actor: SYSTEM, payload: { ...input.extra, reasons: input.verdict.reasons }, sourceDocumentId: input.sourceDocumentId, confidenceScore: input.confidence } as NewEvent;
    if ((input.subflowStatus ?? 'assist') !== 'assist') return [cleared];
    const subFlow = SUBFLOW_FOR_KIND[input.kind];
    const subject = String(input.extra.searchType ?? input.extra.enquiryId ?? input.subjectLabel);
    const decision: DecisionSpec = {
      kind: 'auto_clear',
      summary: `${input.subjectLabel} was auto-cleared by the rule layer (${input.verdict.reasons.join('; ')}). This sub-flow is at ASSIST level: confirm the engine got it right, or escalate. The matter is not held up by this review.`,
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

const SUBFLOW_FOR_KIND: Record<DecisionKind, SubFlow> = { id_check: 'id_check', search: 'search', enquiry: 'enquiry', mortgage: 'mortgage', title: 'title', report_on_title: 'report_on_title', escalation: 'chase', bank_details: 'chase', auto_clear: 'chase', requisition: 'chase', proof_of_funds: 'proof_of_funds', management_pack: 'management_pack', note_actions: 'chase' };

// ───────────────────────────── decide ─────────────────────────────

export function decide(state: MatterState, cmd: Command, ctx: DecideContext): Decision {
  const events = decideCore(state, cmd, ctx);
  const mid = applyNew(state, events, ctx.now);
  const auto = automatic(mid, ctx.now);
  const all = [...events, ...auto];
  return { events: all, state: applyNew(state, all, ctx.now) };
}

function decideCore(s: MatterState, cmd: Command, ctx: DecideContext): NewEvent[] {
  switch (cmd.type) {
    case 'enrol': {
      if (s.enrolled) reject('Matter is already enrolled.');
      return [
        {
          type: 'matter_created',
          actor: cmd.actor,
          payload: {
            transactionType: cmd.transactionType ?? 'freehold_purchase',
            // Proof of funds and the client's exchange authority are purchase-side policies; a sale, remortgage or transfer has neither.
            requireProofOfFunds: profileOf(cmd.transactionType).side === 'buyer' ? (cmd.requireProofOfFunds ?? true) : false,
            requireExchangeAuthority: profileOf(cmd.transactionType).hasExchange ? (cmd.requireExchangeAuthority ?? true) : false,
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
      ];
    }

    case 'mark_manual_handling': {
      requireEnrolled(s);
      if (s.manualHandling.required) reject('Matter is already marked for manual handling.');
      return [{ type: 'manual_handling_required', actor: cmd.actor, payload: { reason: cmd.reason, detail: cmd.detail } }];
    }

    // ── ID / AML ──
    case 'request_id_check': {
      requireEnrolled(s);
      if (s.idCheck.status === 'requested') reject('An ID check is already in progress.');
      if (isResolved(s.idCheck.status)) reject('The ID check is already resolved.');
      return [{ type: 'id_check_requested', actor: cmd.actor, payload: { provider: cmd.provider, reference: cmd.reference ?? null } }];
    }
    case 'id_check_result': {
      requireEnrolled(s);
      if (s.idCheck.status !== 'requested') reject(`No ID check is awaiting a result (status: ${s.idCheck.status}).`);
      return verdictEvents({
        verdict: evaluateIdCheck(cmd.facts),
        cleared: 'id_check_cleared',
        flagged: 'id_check_flagged',
        kind: 'id_check',
        subflowStatus: (ctx.subflows ?? DEFAULT_SUBFLOW_CONFIG).id_check,
        subjectLabel: `ID/AML check (${cmd.facts.provider})`,
        sourceDocumentId: cmd.documentId,
        summary: cmd.summary,
        extra: { facts: cmd.facts },
        confidence: cmd.facts.confidence,
      });
    }

    // ── Searches ──
    case 'record_search_ordered': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'pre_contract', 'Ordering a search');
      const existing = s.searches[cmd.searchType];
      // A resolved search may be ordered again (re-issued result, lender freshness rule, provider error); an open one may not.
      if (existing && !isResolved(existing.status)) reject(`${cmd.searchType} search already ${existing.status}.`);
      return [{ type: 'search_ordered', actor: cmd.actor, payload: { searchType: cmd.searchType, provider: cmd.provider, reference: cmd.reference ?? null, reissue: !!existing } }];
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
        subflowStatus: (ctx.subflows ?? DEFAULT_SUBFLOW_CONFIG).search,
          subjectLabel: `${cmd.searchType} search`,
          sourceDocumentId: sr.documentId,
          summary: cmd.summary,
          extra: { searchType: cmd.searchType },
          confidence: cmd.facts.confidence,
        }),
      ];
    }

    // ── Enquiries ──
    case 'raise_enquiry': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'pre_contract', 'Raising an enquiry');
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
        subflowStatus: (ctx.subflows ?? DEFAULT_SUBFLOW_CONFIG).enquiry,
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
        subflowStatus: (ctx.subflows ?? DEFAULT_SUBFLOW_CONFIG).mortgage,
          subjectLabel: `Mortgage offer (${cmd.facts.lender})`,
          sourceDocumentId: s.mortgage.documentId,
          summary: cmd.summary,
          extra: {},
          confidence: cmd.facts.confidence,
        }),
      ];
    }

    // ── Title ──
    case 'title_extracted': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'pre_contract', 'Title review');
      if (s.title.status === 'flagged') reject('A title decision is pending; resolve it before re-extracting.');
      if (s.reportOnTitle.status === 'sent') reject('The report on title has already been sent; re-reviewing title now needs manual handling.');
      const extracted: NewEvent = { type: 'title_extracted', actor: SYSTEM, payload: { facts: cmd.facts, extractor: cmd.extractor }, sourceDocumentId: cmd.documentId, confidenceScore: cmd.facts.confidence };
      const txType = s.transactionType ?? 'freehold_purchase';
      const expectedTenure = profile(s).tenure;
      const verdict = evaluateTitle(cmd.facts, expectedTenure);
      const out = [
        extracted,
        ...verdictEvents({ verdict, cleared: 'title_cleared', flagged: 'title_flagged', kind: 'title', subflowStatus: (ctx.subflows ?? DEFAULT_SUBFLOW_CONFIG).title, subjectLabel: `Title ${cmd.facts.titleNumber}`, sourceDocumentId: cmd.documentId, summary: cmd.summary, extra: {}, confidence: cmd.facts.confidence }),
      ];
      // A tenure the matter was not enrolled for: flag for the human AND halt automation until it is re-enrolled correctly.
      if (expectedTenure !== 'any' && cmd.facts.tenure !== expectedTenure && !s.manualHandling.required) {
        out.push({ type: 'manual_handling_required', actor: SYSTEM, payload: { reason: cmd.facts.tenure === 'unknown' ? 'tenure_unknown' : 'tenure_mismatch', detail: `Title ${cmd.facts.titleNumber} is ${cmd.facts.tenure}; the matter is a ${txType.replace('_', ' ')}.` } });
      }
      return out;
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
      if (!d.options.includes(cmd.option)) reject(`"${cmd.option}" is not an option for this decision (${d.options.join(', ')}).`, 400);
      requireSurfaced(s, d, ctx);
      if (!d.openedBy.includes(cmd.userId)) reject('Open the source document before resolving this decision.', 412);
      // Addendum 3 §3: anything other than approving/verifying needs a reason, stored on the resolving event.
      if (cmd.option !== 'approve' && cmd.option !== 'verify' && !(cmd.note ?? '').trim()) reject(`Give a reason for choosing "${optionLabel(cmd.option)}".`, 400);
      return resolveEvents(s, d, cmd.option, cmd.note ?? null, cmd.userId, cmd.verification ?? null, cmd.engagement ?? null, cmd.selection ?? null);
    }

    // ── Report on title ──
    case 'draft_report_on_title': {
      requireEnrolled(s);
      requireSide(s, ['buyer'], 'A report on title');
      requireStage(s, 'contract_review', 'Drafting the report on title');
      if (!isResolved(s.title.status)) reject(`Title is ${s.title.status}; resolve it before drafting the report.`);
      if (s.reportOnTitle.status === 'drafted') reject('A draft is already awaiting approval.');
      if (s.reportOnTitle.status === 'approved') reject('An approved draft is awaiting sending.');
      if (s.reportOnTitle.status === 'sent') reject('The report on title has already been sent.');
      const decision: DecisionSpec = {
        kind: 'report_on_title',
        summary: cmd.summary,
        sourceDocumentId: cmd.draftDocumentId,
        citations: cmd.citations.length ? cmd.citations : [{ documentId: cmd.draftDocumentId, label: 'Draft report on title' }],
        options: OPTIONS_FOR.report_on_title,
        summarisedBy: cmd.model,
      };
      assertDecisionSpec(decision);
      return [{ type: 'report_on_title_drafted', actor: AI, payload: { draftId: cmd.draftId, draftDocumentId: cmd.draftDocumentId, model: cmd.model, decision, basedOn: cmd.basedOn ?? [] }, sourceDocumentId: cmd.draftDocumentId }];
    }
    case 'record_report_on_title_sent': {
      assertCanSendReport(s, cmd.draftId);
      return [{ type: 'report_on_title_sent', actor: cmd.actor, payload: { draftId: cmd.draftId, approvedEventId: s.reportOnTitle.approvedEventId as string, approvedBy: s.reportOnTitle.approvedBy as string, channel: cmd.channel, messageId: cmd.messageId ?? null }, sourceDocumentId: s.reportOnTitle.draftDocumentId }];
    }

    // ── Exchange ──
    case 'deposit_received': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'pre_contract', 'Recording the deposit');
      if (s.deposit.received) reject('Deposit already recorded.');
      const out: NewEvent[] = [{ type: 'deposit_received', actor: cmd.actor, payload: { amountPennies: cmd.amountPennies ?? null } }];
      // Money accepted before source of funds is signed off is the situation the guidance says must not happen silently: it is recorded as an issue holding exchange.
      if (s.requireProofOfFunds && !proofOfFundsApproved(s) && !Object.values(s.issues).some((i) => i.kind === 'aml_kyc_problem' && i.title.startsWith('Deposit received before') && (i.status === 'open' || i.status === 'negotiating'))) {
        out.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: nextIssueId(s), kind: 'aml_kyc_problem', title: `Deposit received before proof of funds was signed off (proof of funds ${proofOfFundsHoldReason(s)})`, detail: 'Client money was accepted before the source-of-funds check was complete. Complete the check now; record the MLRO\'s view on the funds already held.', gate: 'exchange', stage: s.stage, sourceDocumentId: null, origin: null, party: null }, sourceDocumentId: null });
      }
      return out;
    }
    case 'contracts_exchanged': {
      requireEnrolled(s);
      requireStage(s, 'pre_exchange', 'Exchange');
      if (!profile(s).hasExchange) reject(`A ${profile(s).label.toLowerCase()} completes without an exchange of contracts.`);
      if (profile(s).side === 'seller') {
        const unreplied = Object.values(s.inboundEnquiries).filter((q) => !q.repliedAt);
        if (unreplied.length) reject(`Cannot exchange: ${unreplied.length} of the buyer's enquiries await our reply (${unreplied.map((q) => q.id).join(', ')}).`);
        if (s.hasExistingMortgage && s.redemption.status !== 'received') reject('Cannot exchange: the redemption figure is not known.');
      }
      if (profile(s).side === 'buyer' && s.hasLender && !isResolved(s.mortgage.status)) reject(`Cannot exchange: the mortgage offer is ${s.mortgage.status} (withdrawn / awaiting re-issue).`);
      const open = profile(s).side === 'buyer' ? unresolvedSearches(s, false) : [];
      if (open.length) reject(`Cannot exchange: ${open.join('; ')}.`);
      if (proofOfFundsHolds(s)) reject(`Cannot exchange: proof of funds ${s.proofOfFunds.status === 'submitted' ? 'is awaiting the conveyancer\'s sign-off' : s.proofOfFunds.status === 'requested' ? 'is still with the client' : proofOfFundsHoldReason(s)}.`);
      if (surveyHolds(s)) reject(`Cannot exchange: the client has not confirmed they are satisfied with the physical condition (survey ${s.survey.status.replace(/_/g, ' ')}). Record the client's decision.`);
      if (exchangeAuthorityHolds(s)) reject('Cannot exchange: the client has not authorised exchange. Record the client\'s decision (exchange_authority).');
      const holding = issuesGating(s, 'exchange');
      if (holding.length) reject(`Cannot exchange while ${holding.length === 1 ? 'an issue is' : `${holding.length} issues are`} open: ${holding.map((i) => `${ISSUE_KIND_SPEC[i.kind].label} — ${i.title}`).join('; ')}. Resolve, withdraw or re-gate ${holding.length === 1 ? 'it' : 'them'} first.`);
      if (!s.exchange.conditionsMet) reject('Exchange conditions are not met (deposit received?).');
      if (s.exchange.exchangedAt) reject('Contracts already exchanged.');
      if (Number.isNaN(Date.parse(cmd.completionDate))) reject('A valid completion date is required to exchange.', 400);
      return [{ type: 'contracts_exchanged', actor: cmd.actor, payload: { completionDate: cmd.completionDate, exchangedAt: cmd.exchangedAt ?? null } }];
    }

    // ── Completion ──
    case 'completion_statement_generated': {
      requireEnrolled(s);
      requireStage(s, 'exchanged', 'Generating the completion statement');
      return [{ type: 'completion_statement_generated', actor: cmd.actor, payload: { documentId: cmd.documentId ?? null }, sourceDocumentId: cmd.documentId ?? null }];
    }
    case 'funds_requested': {
      requireEnrolled(s);
      requireStage(s, 'pre_completion', 'Requesting funds');
      requireSide(s, ['buyer', 'owner'], 'Requesting completion funds');
      if (cmd.fromRole === 'lender' && !s.hasLender) reject('No lender on this matter to request funds from.');
      if (s.waits.some((w) => w.key === 'funds' && w.subject === cmd.fromRole && w.closedAt === null)) reject(`Funds already requested from ${cmd.fromRole}.`);
      // Addendum 2 §5: a person, and the account the payer is told to use must be our VERIFIED client account.
      if (!isUserActor(cmd.actor)) reject('A funds request must be made by a person, never by automation.', 403);
      assertPayableDetails(s, 'firm_client_account', cmd.bankDetailsId);
      return [{ type: 'funds_requested', actor: cmd.actor, payload: { fromRole: cmd.fromRole, amountPennies: cmd.amountPennies ?? null, bankDetailsId: cmd.bankDetailsId, approvedBy: cmd.actor } }];
    }
    case 'funds_received': {
      requireEnrolled(s);
      const inbound = cmd.fromRole === 'buyer_solicitor' || cmd.fromRole === 'incoming_owner';
      if (inbound) {
        if (!profile(s).fundsFrom.includes(cmd.fromRole)) reject(`Money from the ${cmd.fromRole.replace(/_/g, ' ')} does not arise on a ${profile(s).label.toLowerCase()}.`);
        if (!stageAtLeast(s, 'pre_completion')) reject('Completion monies arrive at pre-completion.');
        if (s.completion.fundsReceivedAt) reject('Completion monies already recorded.');
      } else if (!s.waits.some((w) => w.key === 'funds' && w.subject === cmd.fromRole && w.closedAt === null)) reject(`No outstanding funds request to ${cmd.fromRole}.`);
      return [{ type: 'funds_received', actor: cmd.actor, payload: { fromRole: cmd.fromRole, amountPennies: cmd.amountPennies ?? null } }];
    }
    case 'completion_confirmed': {
      requireEnrolled(s);
      requireStage(s, 'pre_completion', 'Confirming completion');
      const holdingCompletion = issuesGating(s, 'completion');
      if (holdingCompletion.length) reject(`Cannot confirm completion while an issue holds it: ${holdingCompletion.map((i) => `${ISSUE_KIND_SPEC[i.kind].label} — ${i.title}`).join('; ')}.`);
      if (profile(s).side !== 'buyer') {
        const p = profile(s);
        const remo = p.type === 'remortgage';
        if (p.side === 'seller' && !s.completion.fundsReceivedAt) reject("Completion monies have not been received from the buyer's solicitor.");
        if (remo && !s.completion.fundsReceivedAt) reject('The advance has not been received from the lender.');
        if (remo && (!s.deeds.mortgageDeedAt || !s.deeds.certificateOfTitleAt)) reject('The mortgage deed must be executed and the certificate of title sent before completion.');
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
        return [{ type: 'completion_confirmed', actor: cmd.actor, payload: { completedAt: cmd.completedAt ?? null } }];
      }
      if (!s.completion.fundsReceivedAt) reject('Funds have not been received.');
      // Addendum 2: the completion transfer must have been authorised by a person against
      // verified seller's-solicitor details, and no bank-details change may be pending.
      const pend = pendingBankDetailsDecision(s, 'seller_solicitor');
      if (pend) reject('HARD STOP: the seller\'s solicitor\'s bank details changed and have not been verified out-of-band. Completion cannot be confirmed until that decision is resolved — however urgent.', 423);
      const auth = s.payments.find((p) => p.payeeKind === 'seller_solicitor' && p.purpose === 'completion_monies');
      if (!auth) reject('No authorised completion payment: authorise the transfer against verified bank details first.', 412);
      const cur = currentBankDetails(s, 'seller_solicitor');
      if (!cur || cur.id !== auth.bankDetailsId || cur.status !== 'verified') reject('HARD STOP: the bank details the payment was authorised against are no longer the current verified record.', 423);
      return [{ type: 'completion_confirmed', actor: cmd.actor, payload: { completedAt: cmd.completedAt ?? null } }];
    }

    // ── Post-completion ──
    case 'sdlt_submitted': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'completed', 'SDLT submission');
      requireSide(s, ['buyer', 'owner'], 'An SDLT return');
      if (s.postCompletion.sdltSubmittedAt) reject('SDLT return already submitted.');
      if (s.sdltNotRequiredAt) reject('SDLT was recorded as not required; record a correction if that was wrong.');
      return [{ type: 'sdlt_submitted', actor: cmd.actor, payload: { reference: cmd.reference ?? null } }];
    }
    case 'ap1_submitted': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'completed', 'AP1 submission');
      if (profile(s).registration !== 'ap1') reject(`No application to register on a ${profile(s).label.toLowerCase()} — the buyer's solicitor registers; we discharge.`);
      if (s.postCompletion.ap1SubmittedAt) reject('AP1 already submitted.');
      return [{ type: 'ap1_submitted', actor: cmd.actor, payload: { reference: cmd.reference ?? null } }];
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
      requireEnrolled(s);
      requireStageAtLeast(s, 'pre_exchange', 'Authorising a payment');
      if (!isUserActor(cmd.actor)) reject('A payment can only be authorised by a person, never by automation.', 403);
      assertPayableDetails(s, cmd.payeeKind, cmd.bankDetailsId);
      if (cmd.purpose === 'completion_monies' && s.payments.some((p) => p.payeeKind === cmd.payeeKind && p.purpose === 'completion_monies')) reject('Completion monies already authorised for this payee.');
      return [{ type: 'payment_authorised', actor: cmd.actor, payload: { payeeKind: cmd.payeeKind, bankDetailsId: cmd.bankDetailsId, amountPennies: cmd.amountPennies ?? null, purpose: cmd.purpose, approvedBy: cmd.actor } }];
    }

    // ── eventualities ──
    case 'abandon_matter': {
      requireEnrolled(s);
      if (!isUserActor(cmd.actor)) reject('Only a person can abandon a matter.', 403);
      if (!ABANDON_REASONS.includes(cmd.reason)) reject(`Unknown abandonment reason "${cmd.reason}".`, 400);
      if (s.completion.confirmedAt) reject('The purchase has completed; it cannot be abandoned. Record a correction if the completion event was wrong.');
      return [{ type: 'matter_abandoned', actor: cmd.actor, payload: { reason: cmd.reason, detail: cmd.detail ?? null, stage: s.stage } }];
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
    case 'change_completion_date': {
      requireEnrolled(s);
      if (!s.exchange.exchangedAt) reject('Contracts are not exchanged; set target dates instead.');
      if (s.completion.confirmedAt) reject('Completion has already been confirmed.');
      if (Number.isNaN(Date.parse(cmd.completionDate))) reject('A valid completion date is required.', 400);
      if (cmd.completionDate === s.exchange.completionDate) reject('The completion date is unchanged.');
      return [{ type: 'completion_date_changed', actor: cmd.actor, payload: { from: s.exchange.completionDate ?? '', to: cmd.completionDate, reason: cmd.reason ?? null } }];
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
      return [{ type: 'notice_to_complete_served', actor: cmd.actor, payload: { servedBy: cmd.servedBy, servedAt, expiresAt: cmd.expiresAt, decision }, sourceDocumentId: cmd.documentId }];
    }
    case 'mortgage_offer_withdrawn': {
      requireEnrolled(s);
      if (!s.hasLender) reject('Cash purchase — there is no mortgage offer to withdraw.');
      if (s.mortgage.status === 'awaiting' || s.mortgage.status === 'not_required') reject('No mortgage offer is on file.');
      if (s.exchange.exchangedAt) reject('Contracts are exchanged: a withdrawn offer after exchange is a manual-handling emergency, not a sub-flow reset.');
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
      const decision: DecisionSpec = {
        kind: 'requisition',
        summary: cmd.summary?.text ?? `HM Land Registry has raised a requisition on the AP1${cmd.reference ? ` (${cmd.reference})` : ''}${cmd.deadline ? `, to be answered by ${cmd.deadline.slice(0, 10)}` : ''}. Read the requisition and respond; an unanswered requisition cancels the application and loses priority.`,
        sourceDocumentId: cmd.documentId,
        citations: [{ documentId: cmd.documentId, label: 'HMLR requisition' }],
        options: OPTIONS_FOR.requisition,
        summarisedBy: cmd.summary?.by ?? 'template',
      };
      assertDecisionSpec(decision);
      return [{ type: 'hmlr_requisition_received', actor: cmd.actor, payload: { reference: cmd.reference ?? null, deadline: cmd.deadline ?? null, decision }, sourceDocumentId: cmd.documentId }];
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
      if (s.completion.confirmedAt) reject('The purchase has completed: post-completion problems are HMLR requisitions or corrections, not issues.');
      const issueId = cmd.issueId?.trim() || nextIssueId(s);
      if (s.issues[issueId]) reject(`Issue ${issueId} already exists.`);
      const spec = ISSUE_KIND_SPEC[cmd.kind];
      if (!spec) reject(`Unknown issue kind "${cmd.kind}".`, 400);
      if (!cmd.title?.trim()) reject('An issue needs a title: what is wrong, in one line.', 400);
      let gate: IssueGate = cmd.gate ?? spec.gate;
      // After exchange the only thing left to hold is completion.
      if (gate === 'exchange' && s.exchange.exchangedAt) gate = 'completion';
      if (cmd.causedBy && !s.issues[cmd.causedBy]) reject(`Issue ${cmd.causedBy} (causedBy) not found.`, 404);
      if (cmd.severity && !ISSUE_SEVERITIES.includes(cmd.severity)) reject(`Unknown severity "${cmd.severity}".`, 400);
      return [{ type: 'issue_raised', actor: cmd.actor, payload: { issueId, kind: cmd.kind, title: cmd.title.trim(), detail: cmd.detail?.trim() || null, gate, stage: s.stage, sourceDocumentId: cmd.documentId ?? null, origin: null, party: cmd.party?.trim() || null, severity: cmd.severity ?? spec.severity, causedBy: cmd.causedBy ?? null }, sourceDocumentId: cmd.documentId ?? null }];
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
      const out: NewEvent[] = [{ type: 'survey_received', actor: cmd.actor, payload: { surveyType: cmd.surveyType, facts: cmd.facts, extractor: cmd.extractor }, sourceDocumentId: cmd.documentId, confidenceScore: cmd.facts.confidence }];
      // Objective fact: the surveyor recommends further investigation → one issue per recommendation (holds exchange).
      let n = Object.keys(s.issues).length;
      for (const r of cmd.facts.recommendations.filter((x) => x.furtherInvestigation)) {
        n += 1;
        out.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: `ISS-${n}`, kind: 'survey_further_investigation', title: `${r.specialist ? `${r.specialist} report` : 'Further investigation'} recommended: ${r.text.slice(0, 140)}`, detail: r.text, gate: 'exchange', stage: s.stage, sourceDocumentId: cmd.documentId, origin: null, party: null, severity: r.severity === 'high' ? 'critical' : 'warning', causedBy: null }, sourceDocumentId: cmd.documentId });
      }
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
        out.push({ type: 'issue_raised', actor: SYSTEM, payload: { issueId: `ISS-${n}`, kind: 'survey_further_investigation', title: `${r.specialist ? `${r.specialist} report` : 'Further investigation'} recommended: ${r.text.slice(0, 140)}`, detail: r.text, gate: 'exchange', stage: s.stage, sourceDocumentId: cmd.documentId, origin: null, party: null, severity: r.severity === 'high' ? 'critical' : 'warning', causedBy: target?.id ?? null }, sourceDocumentId: cmd.documentId });
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
      if (cmd.subject === 'physical_condition' && cmd.decision === 'satisfied' && s.survey.status === 'further_investigation') reject('Further investigation is still outstanding; the client can confirm satisfaction once the specialist reports are in (or the issues are withdrawn / accepted).');
      if (cmd.subject === 'exchange_authority' && s.exchange.exchangedAt) reject('Contracts are already exchanged.');
      if (cmd.subject === 'exchange_authority' && !profile(s).hasExchange) reject(`A ${profile(s).label.toLowerCase()} has no exchange to authorise.`);
      if (cmd.subject === 'ownership_basis' && s.parties < 2) reject('Only one client on this matter: there is no co-ownership to decide.');
      if (!cmd.note?.trim() && cmd.decision !== 'satisfied' && cmd.decision !== 'authorised' && cmd.decision !== 'accepted' && cmd.decision !== 'agreed') reject('Record what the client said (note).', 400);
      const out: NewEvent[] = [{ type: 'client_decision_recorded', actor: cmd.actor, payload: { subject: cmd.subject, decision: cmd.decision, note: cmd.note?.trim() || null, evidenceDocumentId: cmd.evidenceDocumentId ?? null }, sourceDocumentId: cmd.evidenceDocumentId ?? null }];
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
      if (isLeasehold(s) && profile(s).side === 'buyer' && !s.postCompletion.noticeOfAssignmentAt) reject('Leasehold: serve the notice of assignment before closing the file.');
      if (Object.values(s.issues).some((i) => i.status === 'open' || i.status === 'negotiating')) reject('Open issues remain; resolve or withdraw them before closing.');
      return [{ type: 'matter_closed', actor: cmd.actor, payload: { reason: cmd.reason ?? null } }];
    }
    case 'update_issue': {
      requireEnrolled(s);
      const i = openIssue(s, cmd.issueId);
      if (cmd.gate === 'exchange' && s.exchange.exchangedAt) reject('Contracts are exchanged: an issue can only hold completion (or nothing) now.', 400);
      const gate = cmd.gate && cmd.gate !== i.gate ? cmd.gate : null;
      const party = cmd.party !== undefined && (cmd.party?.trim() || null) !== i.party ? (cmd.party?.trim() || null) : undefined;
      if (cmd.status === i.status && !gate && party === undefined && !cmd.note?.trim()) reject('Nothing to update: give a note, a new status, a new gate or the party.', 400);
      if (gate === 'none' && !cmd.note?.trim()) reject('Releasing an issue\'s hold on the matter needs a note saying why (the client accepts the risk, the lender is content…).', 400);
      return [{ type: 'issue_updated', actor: cmd.actor, payload: { issueId: i.id, status: cmd.status, note: cmd.note?.trim() || null, gate, ...(party !== undefined ? { party } : {}) } }];
    }
    case 'resolve_issue': {
      requireEnrolled(s);
      const i = openIssue(s, cmd.issueId);
      // The timer may close the issues it raised itself (a search that arrived, an offer that was exchanged inside); everything else is a person's act.
      if (!isUserActor(cmd.actor) && !(cmd.actor === SYSTEM && /\[[a-z-]+:[^\]]*\]/.test(i.title) && (cmd.resolution === 'received' || cmd.resolution === 'other'))) reject('Issues are resolved by people.', 403);
      const spec = ISSUE_KIND_SPEC[i.kind];
      if (!spec.resolutions.includes(cmd.resolution)) reject(`"${spec.label}" is not resolved by "${RESOLUTION_LABEL[cmd.resolution] ?? cmd.resolution}". Realistic outcomes: ${spec.resolutions.map((r) => RESOLUTION_LABEL[r]).join('; ')}.`, 400);
      const note = cmd.note?.trim() || null;
      if (cmd.resolution === 'other' && !note) reject('Say how it was resolved.', 400);
      if (cmd.resolution === 'accepted_as_is' && !note) reject('Record the advice given: the client is accepting this as it stands.', 400);
      if (cmd.costPennies != null && (!Number.isInteger(cmd.costPennies) || cmd.costPennies < 0)) reject('The cost must be a whole number of pennies.', 400);
      if (cmd.paidBy && !ISSUE_PAID_BY.includes(cmd.paidBy)) reject(`Unknown payer "${cmd.paidBy}".`, 400);
      if (cmd.costPennies != null && cmd.costPennies > 0 && !cmd.paidBy) reject('Say who paid the cost (buyer, seller, shared, lender, other).', 400);
      const out: NewEvent[] = [{ type: 'issue_resolved', actor: cmd.actor, payload: { issueId: i.id, resolution: cmd.resolution, note, costPennies: cmd.costPennies ?? null, paidBy: cmd.paidBy ?? null }, sourceDocumentId: i.sourceDocumentId }];
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
      requireEnrolled(s);
      if (s.exchange.exchangedAt) reject('Contracts are exchanged: the price is contractual now.');
      if (!Number.isInteger(cmd.toPennies) || cmd.toPennies <= 0) reject('The price must be a positive whole number of pennies.', 400);
      if (cmd.toPennies === s.purchasePricePennies) reject('The price is unchanged.');
      if (!cmd.reason?.trim()) reject('Say why the price changed.', 400);
      const out: NewEvent[] = [{ type: 'price_changed', actor: cmd.actor, payload: { fromPennies: s.purchasePricePennies, toPennies: cmd.toPennies, reason: cmd.reason.trim(), issueId: null } }];
      // The first recorded price is the agreed price, not a change; a change on a lender-funded purchase must be reported to the lender.
      if (s.hasLender && s.purchasePricePennies !== null) out.push(lenderApprovalIssue(s, `price:${s.lastSeq + 1}:lender`, `Tell the lender: price changed to £${(cmd.toPennies / 100).toLocaleString('en-GB')} (${cmd.reason.trim()})`, null, null));
      const short = pofShortfallIssue(s, cmd.toPennies);
      if (short) out.push(short);
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
      return [{ type: 'proof_of_funds_requested', actor: cmd.actor, payload: { requestId: cmd.requestId, channel: cmd.channel, messageId: cmd.messageId ?? null, formUrl: cmd.formUrl ?? null, followUpOf: cmd.followUpOf ?? null, noteToClient: cmd.noteToClient ?? null, queryIds } }];
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
      const verdict = evaluateProofOfFunds(cmd.facts);
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
      // 3. Queries sent and not answered stay open as a flag of their own.
      for (const q of Object.values(queries)) if (q.status === 'sent') flags.push({ code: 'QUERY_UNANSWERED', severity: 'medium', description: `The client did not answer: "${q.question}"`, locator: { section: `Query ${q.id}` } });
      const risk = riskRating(flags);
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
      out.push({ type: 'proof_of_funds_submitted', actor: cmd.actor, payload: { requestId: cmd.requestId, facts: cmd.facts, flags, statements: review?.statements ?? [], risk, decision }, sourceDocumentId: cmd.documentId, confidenceScore: cmd.facts.confidence });
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
      return [{ type: 'management_pack_received', actor: cmd.actor, payload: { facts, decision }, sourceDocumentId: cmd.documentId, confidenceScore: facts?.confidence ?? null }];
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
      return [{ type: 'property_forms_received', actor: cmd.actor, payload: { forms: cmd.forms, facts: cmd.facts ?? null }, sourceDocumentId: cmd.documentId ?? null }];
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
      return [{ type: 'redemption_statement_received', actor: cmd.actor, payload: { lender: cmd.lender ?? s.redemption.lender ?? null, redemptionPennies: cmd.redemptionPennies ?? null, validUntil: cmd.validUntil ?? null, dailyInterestPennies: cmd.dailyInterestPennies ?? null }, sourceDocumentId: cmd.documentId ?? null }];
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
      return [{ type: 'lender_consent_received', actor: cmd.actor, payload: { lender: cmd.lender ?? s.lenderConsent.lender ?? null, conditions: cmd.conditions ?? null } }];
    }
    case 'transfer_deed_executed': {
      requireEnrolled(s);
      requireType(s, ['transfer_of_equity', 'freehold_purchase', 'leasehold_purchase'], 'A transfer deed');
      if (s.deeds.transferDeedAt) reject('The transfer deed is already executed.');
      if (cmd.witnessed === false) reject('A transfer deed must be witnessed.', 400);
      if (!cmd.parties.length) reject('Name the parties who signed.', 400);
      return [{ type: 'transfer_deed_executed', actor: cmd.actor, payload: { parties: cmd.parties, witnessed: true } }];
    }
    case 'deed_of_trust_executed': {
      requireEnrolled(s);
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
        payload: { noteId, kind: cmd.kind, text, durationSeconds: cmd.durationSeconds ?? null, documentId: cmd.documentId ?? null },
        sourceDocumentId: cmd.documentId ?? null,
      }];
    }
    case 'note_extracted': {
      requireEnrolled(s);
      const note = s.notes[cmd.noteId];
      if (!note) reject(`Note ${cmd.noteId} not found.`, 404);
      if (note.status !== 'no_actions' || note.actions.length) reject('That note has already been read.', 409);
      // Only what the note actually says, and only commands the machine would accept.
      const { actions } = validateNoteActions(note.text, cmd.drafts);
      const actionable = actions.filter((a) => a.command);
      const events: NewEvent[] = [];
      // A decision needs a source to cite. A note filed without a document is read and
      // logged, but nothing is proposed for approval — there would be nothing to open.
      if (actionable.length && note.documentId) {
        const decision: DecisionSpec = {
          kind: 'note_actions',
          summary: summariseNoteActions({ kind: note.kind, text: note.text, actions }),
          sourceDocumentId: note.documentId,
          citations: [{ documentId: note.documentId, label: `${note.kind === 'call' ? 'Call note' : 'Note'} ${note.id}` }],
          options: OPTIONS_FOR.note_actions,
          summarisedBy: cmd.extractor,
        };
        assertDecisionSpec(decision);
        events.push({ type: 'note_extracted', actor: AI, payload: { noteId: note.id, actions, extractor: cmd.extractor, decision }, sourceDocumentId: note.documentId });
      } else {
        events.push({ type: 'note_extracted', actor: AI, payload: { noteId: note.id, actions, extractor: cmd.extractor }, sourceDocumentId: note.documentId });
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
      requireEnrolled(s);
      return [{ type: 'client_update_sent', actor: SYSTEM, payload: cmd.update }];
    }
  }
}

// ───────────────────────────── decision resolution ─────────────────────────────

// ───────────────────────────── issues helpers ─────────────────────────────

/** ISS-1, ISS-2… per matter (deterministic from the state, so a replay agrees). */
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

/**
 * Addendum 3 §2: a decision on a shadow-mode matter, or from a sub-flow still in shadow,
 * is logged but never put in front of a person — so it cannot be opened or resolved either.
 */
function requireSurfaced(s: MatterState, d: DecisionState, ctx: DecideContext): void {
  if (s.shadowMode) reject('This matter is in shadow mode: the engine observes and logs, but its decisions are not actioned.', 409);
  const sf = SUBFLOW_OF_KIND[d.kind];
  if (sf && (ctx.subflows ?? DEFAULT_SUBFLOW_CONFIG)[sf] === 'shadow') reject(`The ${sf.replace(/_/g, ' ')} sub-flow is in shadow mode: its decisions are logged, not actioned.`, 409);
}

function pendingDecision(s: MatterState, id: string): DecisionState {
  const d = s.decisions[id];
  if (!d) reject('Decision not found.', 404);
  if (d.status !== 'pending') reject(`Decision already ${d.status}.`);
  return d;
}

/** Events for a human's resolution of a pending decision. */
function resolveEvents(s: MatterState, d: DecisionState, option: DecisionOption, note: string | null, userId: string, verification: { method: string; reference?: string | null } | null = null, engagement: Engagement | null = null, selection: string[] | null = null): NewEvent[] {
  const out: NewEvent[] = [];
  const subject = d.subject ?? '';

  // assist-level auto-clear review: confirm (no state change) or escalate to a person.
  if (d.kind === 'auto_clear' && option !== 'escalate') {
    const [subFlow, ...rest] = subject.split(':');
    return [{ type: 'auto_clear_confirmed', actor: userId, payload: { decisionEventId: d.eventId, subFlow: subFlow as SubFlow, subject: rest.join(':'), option, note }, sourceDocumentId: d.sourceDocumentId }];
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
      return [{ type: 'bank_details_verified', actor: userId, payload: { bankDetailsId: b.id, decisionEventId: d.eventId, verificationMethod: method as VerificationMethod, verificationRef: verification?.reference?.trim() || null, note }, sourceDocumentId: d.sourceDocumentId }];
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
    const skipped = n.actions.filter((a) => !applied.includes(a.id)).map((a) => a.id);
    if (option === 'approve' && !applied.length) reject('Nothing was selected to apply. Reject the note\'s reading instead, with a reason.', 400);
    return [{ type: 'note_actions_applied', actor: userId, payload: { noteId: n.id, decisionEventId: d.eventId, applied, skipped, option, note }, sourceDocumentId: d.sourceDocumentId }];
  }

  // "Escalate to senior": the original decision is marked escalated and a NEW decision
  // (kind escalation) is queued, carrying the same source so the senior sees what the
  // handler saw. Resolving that later also resolves the original sub-flow.
  if (option === 'escalate' && d.kind !== 'escalation') {
    if (d.kind === 'auto_clear') {
      const [subFlow, ...rest] = subject.split(':');
      out.push({ type: 'auto_clear_confirmed', actor: userId, payload: { decisionEventId: d.eventId, subFlow: subFlow as SubFlow, subject: rest.join(':'), option, note }, sourceDocumentId: d.sourceDocumentId });
    } else if (d.kind === 'bank_details' || d.kind === 'requisition') {
      // handled via the generic escalation (the bank record stays unverified / the requisition stays open)
    } else {
      out.push(reviewedEvent(d, option, note, userId, subject, engagement));
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
    out.push({ type: 'escalation_raised', actor: userId, payload: { waitKey: null, subject, reason: note ?? 'escalated by handler', decision, origin: { decisionEventId: d.eventId, kind: d.kind } }, sourceDocumentId: d.sourceDocumentId });
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
        out.push({ type: 'escalation_raised', actor: userId, payload: { waitKey: null, subject, reason: note ?? 'escalated again', decision, origin: d.origin }, sourceDocumentId: d.sourceDocumentId });
        return out;
      }
      // Resolving the escalation resolves the sub-flow it came from (user escalations).
      const origin = d.origin;
      if (origin) {
        const od = s.decisions[origin.decisionEventId];
        if (od) out.push(reviewedEvent(od, option, note, userId, od.subject ?? ''));
      }
      return out;
    }
    case 'requisition': {
      out.push({ type: 'hmlr_requisition_responded', actor: userId, payload: { decisionEventId: d.eventId, option, note, engagement } });
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
      out.push(reviewedEvent(d, option, note, userId, subject, engagement));
  }

  // "Request further search/enquiry" raises the follow-up enquiry so the wait is tracked.
  if (option === 'request_further' && (d.kind === 'search' || d.kind === 'enquiry' || d.kind === 'title' || d.kind === 'mortgage')) {
    const enquiryId = nextEnquiryId(s, d.kind === 'enquiry' ? subject : d.kind.toUpperCase());
    out.push({ type: 'enquiry_raised', actor: userId, payload: { enquiryId, subject: `Further enquiry following ${d.kind}${subject ? ` ${subject}` : ''} review${note ? `: ${note}` : ''}`, origin: { decisionEventId: d.eventId, followUpOf: d.kind === 'enquiry' ? subject : undefined }, counterpartyType: s.counterpartyType } });
  }
  // An indemnity policy on a lender-funded purchase needs the lender's approval before exchange (docs/engine-issues.md).
  if (option === 'indemnity' && s.hasLender && !s.exchange.exchangedAt && (d.kind === 'search' || d.kind === 'title' || d.kind === 'enquiry')) {
    out.push(lenderApprovalIssue(s, `${d.kind}:${subject || d.eventId}:indemnity:lender`, `Tell the lender: indemnity policy proposed for ${d.kind}${subject ? ` ${subject}` : ''}${note ? ` (${note})` : ''}`, d.sourceDocumentId, null));
  }
  // Rejecting an ID check is a hard stop: the matter cannot proceed without a human taking over.
  if (option === 'reject' && d.kind === 'id_check' && !s.manualHandling.required) {
    out.push({ type: 'manual_handling_required', actor: userId, payload: { reason: 'id_check_rejected', detail: note ?? undefined } });
  }
  // Proof of funds (docs/proof-of-funds.md): sign-off closes the source-of-funds issues it answers; a gift on a
  // lender-funded purchase must be declared to the lender; rejection is a hard stop like a failed ID check.
  if (d.kind === 'proof_of_funds') {
    const facts = s.proofOfFunds.facts;
    const open = openPofQueries(s);
    if (option === 'approve' && open.length) reject(`Sign-off is not available while ${open.length} quer${open.length === 1 ? 'y is' : 'ies are'} open (${open.map((q) => q.id).join(', ')}): send them to the client (query), or withdraw each with a reason.`, 409);
    if (option === 'request_further' && open.length === 0 && !note?.trim()) reject('There is nothing to put to the client: add a query first, or write what you need in the reason.', 400);
    if (option === 'approve') {
      for (const i of Object.values(s.issues)) {
        if (i.kind === 'source_of_funds' && (i.status === 'open' || i.status === 'negotiating')) out.push({ type: 'issue_resolved', actor: userId, payload: { issueId: i.id, resolution: 'evidence_provided', note: `Proof of funds signed off${note ? `: ${note}` : ''}`, costPennies: null, paidBy: null }, sourceDocumentId: d.sourceDocumentId });
      }
      if (facts && facts.giftedPennies > 0 && s.hasLender && !s.exchange.exchangedAt) {
        const donors = facts.sources.filter((x) => x.kind === 'gift' && x.gift).map((x) => x.gift!.donorName).join(', ');
        out.push(lenderApprovalIssue(s, `pof:${facts.requestId}:gift:lender`, `Tell the lender: gifted deposit ${gbp(facts.giftedPennies)}${donors ? ` from ${donors}` : ''}`, d.sourceDocumentId, null));
      }
    }
    if (option === 'reject' && !s.manualHandling.required) {
      out.push({ type: 'manual_handling_required', actor: userId, payload: { reason: 'proof_of_funds_rejected', detail: note ?? undefined } });
    }
  }
  return out;
}

function reviewedEvent(d: DecisionState, option: DecisionOption, note: string | null, userId: string, subject: string, engagement: Engagement | null = null): NewEvent {
  const base = { decisionEventId: d.eventId, option, note, engagement };
  // note_actions never reaches here: it is resolved into note_actions_applied above.
  if (d.kind === 'note_actions') reject('A note\'s proposals are applied, not reviewed.', 500);
  switch (d.kind) {
    case 'id_check':
      return { type: 'id_check_reviewed', actor: userId, payload: base, sourceDocumentId: d.sourceDocumentId };
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
    case 'report_on_title':
    case 'escalation':
    case 'bank_details':
    case 'auto_clear':
    case 'requisition':
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
export function assertCanSendReport(s: MatterState, draftId: string): void {
  requireEnrolled(s);
  const r = s.reportOnTitle;
  if (r.draftId !== draftId) reject('That draft is not the current report on title.');
  if (r.status === 'sent') reject('The report on title has already been sent.');
  if (r.status !== 'approved' || !r.approvedEventId) reject('The report on title has not been approved by a conveyancer.', 412);
  if (!r.approvedBy || !isUserActor(r.approvedBy)) reject('Approval must come from a person, not automation.', 412);
}
