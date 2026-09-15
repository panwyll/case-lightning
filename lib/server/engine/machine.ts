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
import { buildDecision, evaluateEnquiryReply, evaluateIdCheck, evaluateMortgageOffer, evaluateSearch, evaluateTitle, OPTIONS_FOR, type Verdict } from './rules';
import {
  EngineError,
  isResolved,
  isUserActor,
  stageIndex,
  STAGES,
  SYSTEM,
  AI,
  type Actor,
  type ChaseSpec,
  type Citation,
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
  | { type: 'enrol'; actor: Actor; hasLender: boolean; requiredSearches?: SearchType[]; targetExchangeDate?: string | null; targetCompletionDate?: string | null }
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
  | { type: 'resolve_decision'; userId: string; decisionEventId: string; option: DecisionOption; note?: string | null }
  | { type: 'draft_report_on_title'; draftId: string; draftDocumentId: string; model: string; summary: string; citations: Citation[]; basedOn?: string[] }
  | { type: 'record_report_on_title_sent'; actor: Actor; draftId: string; channel: string; messageId?: string | null }
  | { type: 'deposit_received'; actor: Actor; amountPennies?: number | null }
  | { type: 'contracts_exchanged'; actor: Actor; completionDate: string; exchangedAt?: string | null }
  | { type: 'completion_statement_generated'; actor: Actor; documentId?: string | null }
  | { type: 'funds_requested'; actor: Actor; fromRole: 'lender' | 'client'; amountPennies?: number | null }
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
];

export interface DecideContext {
  now: Date;
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
  if (s.manualHandling.required) return [`manual handling: ${s.manualHandling.reason ?? 'unspecified'}`];
  const b: string[] = [];
  switch (s.stage) {
    case 'instruction':
      if (!isResolved(s.idCheck.status)) b.push(`ID/AML check ${s.idCheck.status.replace('_', ' ')}`);
      break;
    case 'pre_contract':
      for (const t of s.requiredSearches) {
        const sr = s.searches[t];
        if (!sr) b.push(`${t} search not ordered`);
        else if (!isResolved(sr.status)) b.push(`${t} search ${sr.status}`);
      }
      for (const q of Object.values(s.enquiries)) if (!isResolved(q.status)) b.push(`enquiry ${q.enquiryId} ${q.status}`);
      if (s.hasLender && !isResolved(s.mortgage.status)) b.push(`mortgage offer ${s.mortgage.status}`);
      break;
    case 'contract_review':
      if (!isResolved(s.title.status)) b.push(`title ${s.title.status}`);
      if (s.reportOnTitle.status !== 'sent') b.push(`report on title ${s.reportOnTitle.status.replace('_', ' ')}`);
      // Anything raised during review (a further enquiry off a title flag) must come back too.
      for (const q of Object.values(s.enquiries)) if (!isResolved(q.status)) b.push(`enquiry ${q.enquiryId} ${q.status}`);
      break;
    case 'pre_exchange':
      if (!s.exchange.exchangedAt) b.push(s.exchange.conditionsMet ? 'contracts not yet exchanged' : 'exchange conditions not met');
      break;
    case 'exchanged':
      if (!s.completion.statementGeneratedAt) b.push('completion statement not generated');
      break;
    case 'pre_completion':
      if (!s.completion.confirmedAt) b.push(s.completion.fundsReceivedAt ? 'completion not confirmed' : 'funds not received');
      break;
    case 'completed':
      if (!s.postCompletion.sdltSubmittedAt && !s.postCompletion.ap1SubmittedAt) b.push('SDLT / AP1 not submitted');
      break;
    case 'post_completion':
      b.push(s.postCompletion.ap1ConfirmedAt ? 'matter complete' : 'awaiting HMLR registration');
      break;
  }
  return b;
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
    if (s.enrolled && s.stage === 'pre_exchange' && s.deposit.received && !s.exchange.conditionsMet && !s.manualHandling.required) {
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
}): NewEvent[] {
  if (input.verdict.outcome === 'clear') {
    return [{ type: input.cleared, actor: SYSTEM, payload: { ...input.extra, reasons: input.verdict.reasons }, sourceDocumentId: input.sourceDocumentId, confidenceScore: input.confidence } as NewEvent];
  }
  const decision = buildDecision({ kind: input.kind, subjectLabel: input.subjectLabel, flags: input.verdict.flags, sourceDocumentId: input.sourceDocumentId, summary: input.summary });
  assertDecisionSpec(decision);
  return [{ type: input.flagged, actor: AI, payload: { ...input.extra, flags: input.verdict.flags, decision }, sourceDocumentId: input.sourceDocumentId, confidenceScore: input.confidence } as NewEvent];
}

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
      if (existing && existing.status !== 'reviewed') reject(`${cmd.searchType} search already ${existing.status}.`);
      return [{ type: 'search_ordered', actor: cmd.actor, payload: { searchType: cmd.searchType, provider: cmd.provider, reference: cmd.reference ?? null } }];
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
      return [{ type: 'enquiry_raised', actor: cmd.actor, payload: { enquiryId: cmd.enquiryId, subject: cmd.subject, origin: cmd.origin ?? null } }];
    }
    case 'enquiry_reply_received': {
      requireEnrolled(s);
      const q = s.enquiries[cmd.enquiryId];
      if (!q) reject(`Enquiry ${cmd.enquiryId} was never raised.`);
      if (q.status !== 'raised') reject(`Enquiry ${cmd.enquiryId} is ${q.status}, not awaiting a reply.`);
      const received: NewEvent = { type: 'enquiry_reply_received', actor: cmd.actor, payload: { enquiryId: cmd.enquiryId, facts: cmd.facts ?? null }, sourceDocumentId: cmd.documentId, confidenceScore: cmd.facts?.confidence ?? null };
      return [
        received,
        ...verdictEvents({
          verdict: evaluateEnquiryReply(cmd.facts),
          cleared: 'enquiry_reply_cleared',
          flagged: 'enquiry_reply_flagged',
          kind: 'enquiry',
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
        ...verdictEvents({ verdict, cleared: 'title_cleared', flagged: 'title_flagged', kind: 'title', subjectLabel: `Title ${cmd.facts.titleNumber}`, sourceDocumentId: cmd.documentId, summary: cmd.summary, extra: {}, confidence: cmd.facts.confidence }),
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
      const allowed = new Set([d.sourceDocumentId, ...d.citations.map((c) => c.documentId)]);
      if (!allowed.has(cmd.documentId)) reject('That document is not the source of this decision.', 400);
      return [{ type: 'decision_source_opened', actor: cmd.userId, payload: { decisionEventId: d.eventId, documentId: cmd.documentId } }];
    }
    case 'resolve_decision': {
      const d = pendingDecision(s, cmd.decisionEventId);
      if (!isUserActor(cmd.userId)) reject('Decisions are resolved by people, not automation.', 403);
      if (!d.options.includes(cmd.option)) reject(`"${cmd.option}" is not an option for this decision (${d.options.join(', ')}).`, 400);
      if (!d.openedBy.includes(cmd.userId)) reject('Open the source document before resolving this decision.', 412);
      return resolveEvents(s, d, cmd.option, cmd.note ?? null, cmd.userId);
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
      return [{ type: 'report_on_title_sent', actor: cmd.actor, payload: { draftId: cmd.draftId, approvedEventId: s.reportOnTitle.approvedEventId as string, channel: cmd.channel, messageId: cmd.messageId ?? null }, sourceDocumentId: s.reportOnTitle.draftDocumentId }];
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
      return [{ type: 'funds_requested', actor: cmd.actor, payload: { fromRole: cmd.fromRole, amountPennies: cmd.amountPennies ?? null } }];
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
      return [{ type: 'ap1_confirmed', actor: cmd.actor, payload: { titleNumber: cmd.titleNumber ?? null } }];
    }

    // ── Timers / comms ──
    case 'record_chase': {
      requireEnrolled(s);
      const w = s.waits.find((x) => x.key === cmd.chase.waitKey && x.subject === cmd.chase.subject && x.closedAt === null);
      if (!w) reject(`No open wait for ${cmd.chase.waitKey}:${cmd.chase.subject}.`);
      return [{ type: 'chase_sent', actor: SYSTEM, payload: cmd.chase }];
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

function pendingDecision(s: MatterState, id: string): DecisionState {
  const d = s.decisions[id];
  if (!d) reject('Decision not found.', 404);
  if (d.status !== 'pending') reject(`Decision already ${d.status}.`);
  return d;
}

/** Events for a human's resolution of a pending decision. */
function resolveEvents(s: MatterState, d: DecisionState, option: DecisionOption, note: string | null, userId: string): NewEvent[] {
  const out: NewEvent[] = [];
  const subject = d.subject ?? '';

  // "Escalate to senior": the original decision is marked escalated and a NEW decision
  // (kind escalation) is queued, carrying the same source so the senior sees what the
  // handler saw. Resolving that later also resolves the original sub-flow.
  if (option === 'escalate' && d.kind !== 'escalation') {
    out.push(reviewedEvent(d, option, note, userId, subject));
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
    case 'report_on_title': {
      const draftId = subject;
      if (s.reportOnTitle.draftId !== draftId || s.reportOnTitle.status !== 'drafted') reject('This draft is no longer the current draft.');
      if (option === 'approve') out.push({ type: 'report_on_title_approved', actor: userId, payload: { draftId, decisionEventId: d.eventId, note }, sourceDocumentId: d.sourceDocumentId });
      else out.push({ type: 'report_on_title_rejected', actor: userId, payload: { draftId, decisionEventId: d.eventId, note }, sourceDocumentId: d.sourceDocumentId });
      return out;
    }
    default:
      out.push(reviewedEvent(d, option, note, userId, subject));
  }

  // "Request further search/enquiry" raises the follow-up enquiry so the wait is tracked.
  if (option === 'request_further' && (d.kind === 'search' || d.kind === 'enquiry' || d.kind === 'title' || d.kind === 'mortgage')) {
    const enquiryId = nextEnquiryId(s, d.kind === 'enquiry' ? subject : d.kind.toUpperCase());
    out.push({ type: 'enquiry_raised', actor: userId, payload: { enquiryId, subject: `Further enquiry following ${d.kind}${subject ? ` ${subject}` : ''} review${note ? `: ${note}` : ''}`, origin: { decisionEventId: d.eventId, followUpOf: d.kind === 'enquiry' ? subject : undefined } } });
  }
  // Rejecting an ID check is a hard stop: the matter cannot proceed without a human taking over.
  if (option === 'reject' && d.kind === 'id_check' && !s.manualHandling.required) {
    out.push({ type: 'manual_handling_required', actor: userId, payload: { reason: 'id_check_rejected', detail: note ?? undefined } });
  }
  return out;
}

function reviewedEvent(d: DecisionState, option: DecisionOption, note: string | null, userId: string, subject: string): NewEvent {
  const base = { decisionEventId: d.eventId, option, note };
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
      return reject('Not a reviewable decision kind.', 500);
  }
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
