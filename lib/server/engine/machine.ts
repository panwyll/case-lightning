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
import { buildDecision, evaluateEnquiryReply, evaluateIdCheck, evaluateMortgageOffer, evaluateSearch, evaluateTitle, OPTIONS_FOR, optionLabel, type Verdict } from './rules';
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
  type Engagement,
  DEFAULT_SUBFLOW_CONFIG,
  type Actor,
  type ChaseSpec,
  type Citation,
  type CounterpartyType,
  type ClientUpdateSpec,
  type DecisionKind,
  type DecisionOption,
  type DecisionSpec,
  type DecisionState,
  type EngineEvent,
  type EnquiryReplyFacts,
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
} from './types';

/** An optional AI-produced summary handed in by the service (component #3). The verdict is never AI's. */
export interface SummaryOverride {
  text: string;
  by: string;
}

export type Command =
  | { type: 'enrol'; actor: Actor; hasLender: boolean; requiredSearches?: SearchType[]; targetExchangeDate?: string | null; targetCompletionDate?: string | null; counterpartyType?: CounterpartyType | null; shadowMode?: boolean }
  | { type: 'mark_manual_handling'; actor: Actor; reason: string; detail?: string }
  | { type: 'request_id_check'; actor: Actor; provider: string; reference?: string | null }
  | { type: 'id_check_result'; actor: Actor; documentId: string; facts: IdCheckFacts; summary?: SummaryOverride | null }
  | { type: 'record_search_ordered'; actor: Actor; searchType: SearchType; provider: string; reference?: string | null }
  | { type: 'search_returned'; actor: Actor; searchType: SearchType; documentId: string; provider?: string | null }
  | { type: 'search_extracted'; actor: Actor; searchType: SearchType; facts: SearchFacts; extractor: string; summary?: SummaryOverride | null }
  | { type: 'raise_enquiry'; actor: Actor; enquiryId: string; subject: string; origin?: { decisionEventId?: string; followUpOf?: string } | null }
  | { type: 'enquiry_reply_received'; actor: Actor; enquiryId: string; documentId: string; facts?: EnquiryReplyFacts | null; summary?: SummaryOverride | null }
  | { type: 'mortgage_offer_received'; actor: Actor; documentId: string; lender?: string | null }
  | { type: 'mortgage_offer_extracted'; actor: Actor; facts: MortgageOfferFacts; extractor: string; summary?: SummaryOverride | null }
  | { type: 'title_extracted'; actor: Actor; documentId: string; facts: TitleFacts; extractor: string; summary?: SummaryOverride | null }
  | { type: 'open_decision_source'; userId: string; decisionEventId: string; documentId: string }
  | { type: 'resolve_decision'; userId: string; decisionEventId: string; option: DecisionOption; note?: string | null; verification?: { method: string; reference?: string | null } | null; engagement?: Engagement | null }
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
  // Addendum 2 — payment verification
  | { type: 'record_bank_details'; actor: Actor; bankDetailsId: string; payeeKind: PayeeKind; payeeRef?: string | null; details: BankDetails; sourceChannel: SourceChannel; sourceDocumentId: string }
  | { type: 'payment_authorised'; actor: Actor; payeeKind: PayeeKind; bankDetailsId: string; amountPennies?: number | null; purpose: 'completion_monies' | 'deposit' | 'other' }
  | { type: 'draft_report_on_title'; draftId: string; draftDocumentId: string; model: string; summary: string; citations: Citation[]; basedOn?: string[] }
  | { type: 'record_report_on_title_sent'; actor: Actor; draftId: string; channel: string; messageId?: string | null }
  | { type: 'deposit_received'; actor: Actor; amountPennies?: number | null }
  | { type: 'contracts_exchanged'; actor: Actor; completionDate: string; exchangedAt?: string | null }
  | { type: 'completion_statement_generated'; actor: Actor; documentId?: string | null }
  | { type: 'funds_requested'; actor: Actor; fromRole: 'lender' | 'client'; amountPennies?: number | null; bankDetailsId: string }
  | { type: 'funds_received'; actor: Actor; fromRole: 'lender' | 'client'; amountPennies?: number | null }
  | { type: 'completion_confirmed'; actor: Actor; completedAt?: string | null }
  | { type: 'sdlt_submitted'; actor: Actor; reference?: string | null }
  | { type: 'ap1_submitted'; actor: Actor; reference?: string | null }
  | { type: 'ap1_confirmed'; actor: Actor; titleNumber?: string | null }
  | { type: 'record_chase'; chase: ChaseSpec }
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
};
/** Commands that may still be recorded after abandonment (audit only). */
const requireEnrolledEvenIfAbandoned = (s: MatterState): void => {
  if (!s.enrolled) reject('Matter is not enrolled in the engine. Enrol it first.');
};

const requireStageAtLeast = (s: MatterState, stage: Stage, what: string): void => {
  if (stageIndex(s.stage) < stageIndex(stage)) reject(`${what} is not valid before stage "${stage}" (matter is at "${s.stage}").`);
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
  if (s.manualHandling.required) return [`manual handling: ${s.manualHandling.reason ?? 'unspecified'}`];
  const b: string[] = [];
  switch (s.stage) {
    case 'instruction':
      if (!isResolved(s.idCheck.status)) b.push(`ID/AML check ${s.idCheck.status.replace('_', ' ')}`);
      break;
    case 'pre_contract':
      b.push(...unresolvedSearches(s, true));
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
      if (!s.exchange.exchangedAt) b.push(s.exchange.conditionsMet ? 'contracts not yet exchanged' : 'exchange conditions not met');
      break;
    case 'exchanged':
      if (!s.completion.statementGeneratedAt) b.push('completion statement not generated');
      break;
    case 'pre_completion':
      if (!s.completion.confirmedAt) {
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

const nextStage = (s: Stage): Stage | null => STAGES[stageIndex(s) + 1] ?? null;

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
    if (s.enrolled && s.stage === 'pre_exchange' && s.deposit.received && !s.exchange.conditionsMet && !s.manualHandling.required && (!s.hasLender || isResolved(s.mortgage.status))) {
      ev = { type: 'exchange_conditions_met', actor: SYSTEM, payload: { conditions: ['report on title sent', 'title resolved', 'searches resolved', 'deposit received', s.hasLender ? 'mortgage offer resolved' : 'cash purchase'] } };
    } else {
      const to = nextStage(s.stage);
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

const SUBFLOW_FOR_KIND: Record<DecisionKind, SubFlow> = { id_check: 'id_check', search: 'search', enquiry: 'enquiry', mortgage: 'mortgage', title: 'title', report_on_title: 'report_on_title', escalation: 'chase', bank_details: 'chase', auto_clear: 'chase', requisition: 'chase' };

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
            transactionType: 'freehold_purchase',
            hasLender: cmd.hasLender,
            requiredSearches: cmd.requiredSearches?.length ? cmd.requiredSearches : ['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL'],
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
      if (s.enquiries[cmd.enquiryId]) reject(`Enquiry ${cmd.enquiryId} already exists.`);
      // Addendum: correspondence with the other side is stamped internal/external so a
      // compliance review can find every crossing of an ethical wall from the log alone.
      return [{ type: 'enquiry_raised', actor: cmd.actor, payload: { enquiryId: cmd.enquiryId, subject: cmd.subject, origin: cmd.origin ?? null, counterpartyType: s.counterpartyType } }];
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
      const verdict = evaluateTitle(cmd.facts);
      const out = [
        extracted,
        ...verdictEvents({ verdict, cleared: 'title_cleared', flagged: 'title_flagged', kind: 'title', subflowStatus: (ctx.subflows ?? DEFAULT_SUBFLOW_CONFIG).title, subjectLabel: `Title ${cmd.facts.titleNumber}`, sourceDocumentId: cmd.documentId, summary: cmd.summary, extra: {}, confidence: cmd.facts.confidence }),
      ];
      // Out-of-scope tenure: flag for the human AND halt automation (spec 2.7).
      if (cmd.facts.tenure !== 'freehold' && !s.manualHandling.required) {
        out.push({ type: 'manual_handling_required', actor: SYSTEM, payload: { reason: cmd.facts.tenure === 'leasehold' ? 'leasehold_unsupported' : 'tenure_unknown', detail: `Title ${cmd.facts.titleNumber} is ${cmd.facts.tenure}.` } });
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
      return resolveEvents(s, d, cmd.option, cmd.note ?? null, cmd.userId, cmd.verification ?? null, cmd.engagement ?? null);
    }

    // ── Report on title ──
    case 'draft_report_on_title': {
      requireEnrolled(s);
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
      return [{ type: 'deposit_received', actor: cmd.actor, payload: { amountPennies: cmd.amountPennies ?? null } }];
    }
    case 'contracts_exchanged': {
      requireEnrolled(s);
      requireStage(s, 'pre_exchange', 'Exchange');
      if (s.hasLender && !isResolved(s.mortgage.status)) reject(`Cannot exchange: the mortgage offer is ${s.mortgage.status} (withdrawn / awaiting re-issue).`);
      const open = unresolvedSearches(s, false);
      if (open.length) reject(`Cannot exchange: ${open.join('; ')}.`);
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
      if (cmd.fromRole === 'lender' && !s.hasLender) reject('Cash purchase — no lender to request funds from.');
      if (s.waits.some((w) => w.key === 'funds' && w.subject === cmd.fromRole && w.closedAt === null)) reject(`Funds already requested from ${cmd.fromRole}.`);
      // Addendum 2 §5: a person, and the account the payer is told to use must be our VERIFIED client account.
      if (!isUserActor(cmd.actor)) reject('A funds request must be made by a person, never by automation.', 403);
      assertPayableDetails(s, 'firm_client_account', cmd.bankDetailsId);
      return [{ type: 'funds_requested', actor: cmd.actor, payload: { fromRole: cmd.fromRole, amountPennies: cmd.amountPennies ?? null, bankDetailsId: cmd.bankDetailsId, approvedBy: cmd.actor } }];
    }
    case 'funds_received': {
      requireEnrolled(s);
      if (!s.waits.some((w) => w.key === 'funds' && w.subject === cmd.fromRole && w.closedAt === null)) reject(`No outstanding funds request to ${cmd.fromRole}.`);
      return [{ type: 'funds_received', actor: cmd.actor, payload: { fromRole: cmd.fromRole, amountPennies: cmd.amountPennies ?? null } }];
    }
    case 'completion_confirmed': {
      requireEnrolled(s);
      requireStage(s, 'pre_completion', 'Confirming completion');
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
      if (s.postCompletion.sdltSubmittedAt) reject('SDLT return already submitted.');
      return [{ type: 'sdlt_submitted', actor: cmd.actor, payload: { reference: cmd.reference ?? null } }];
    }
    case 'ap1_submitted': {
      requireEnrolled(s);
      requireStageAtLeast(s, 'completed', 'AP1 submission');
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
function resolveEvents(s: MatterState, d: DecisionState, option: DecisionOption, note: string | null, userId: string, verification: { method: string; reference?: string | null } | null = null, engagement: Engagement | null = null): NewEvent[] {
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
  // Rejecting an ID check is a hard stop: the matter cannot proceed without a human taking over.
  if (option === 'reject' && d.kind === 'id_check' && !s.manualHandling.required) {
    out.push({ type: 'manual_handling_required', actor: userId, payload: { reason: 'id_check_rejected', detail: note ?? undefined } });
  }
  return out;
}

function reviewedEvent(d: DecisionState, option: DecisionOption, note: string | null, userId: string, subject: string, engagement: Engagement | null = null): NewEvent {
  const base = { decisionEventId: d.eventId, option, note, engagement };
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
