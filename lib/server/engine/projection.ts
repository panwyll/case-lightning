import { addWorkingDays, subtractWorkingDays } from './working-days';
import { resolveWithinWorkingDays, type IssueGate, type IssueKind } from './issues';
import { moneyOf, payersExpected } from './money';
import { isFinancialCharge } from './charges';
import { profileOf } from './transactions';
/**
 * Projection: fold the immutable event log into the current MatterState.
 *
 * This is a pure reducer. `project(events)` MUST give the same answer every time for
 * the same log — that is the audit guarantee (spec 2.8: "can you regenerate the current
 * state purely by replaying events in order?"). Nothing here reads a clock, a database
 * or a random number; every timestamp comes from the event that carried it.
 *
 * Keep the reducer dumb: it records what happened. Deciding what happens NEXT is the
 * machine's job (machine.ts).
 */
import { deedSigned, isResolved, partyId, type SearchType } from './types';
import {
  DECISION_EVENT_TYPES,
  initialState,
  type DecisionOption,
  type DecisionSpec,
  type DecisionState,
  type EngineEvent,
  type EventType,
  type MatterState,
  type Payloads,
  type WaitKey,
  type WaitState,
} from './types';

/** Fold a whole log (must be ordered by seq). */
export function project(tenantId: string, matterId: string, events: EngineEvent[]): MatterState {
  // One copy of the log, then every event applied in place: copying the whole state per event made a
  // rebuild quadratic in the case's size. The copy keeps the caller's events untouched by the fold.
  const log = clone(events);
  // A completion undone as an error is read as never having happened (the undo stays on the log).
  const undone = new Set(log.filter((e) => e.type === 'manual_step_undone').map((e) => (e.payload as Payloads['manual_step_undone']).completionEventId));
  const state = initialState(tenantId, matterId);
  for (const e of log) if (!undone.has(e.id)) applyInPlace(state, e);
  return state;
}

/** Structural clone that keeps the reducer non-mutating without a dependency. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const resolvedStatus = (option: DecisionOption): DecisionState['status'] => (option === 'escalate' ? 'escalated' : 'actioned');

function openWait(state: MatterState, key: WaitKey, subject: string, e: EngineEvent): void {
  // Re-opening the same wait (e.g. a re-ordered search) closes the stale one first.
  for (const w of state.waits) if (w.key === key && w.subject === subject && w.closedAt === null) w.closedAt = e.createdAt;
  state.waits.push({ key, subject, openedAt: e.createdAt, openedBySeq: e.seq, openedBy: e.actor, closedAt: null, chasesSentAt: [], escalations: [] });
}

function closeWait(state: MatterState, key: WaitKey, subject: string | null, e: EngineEvent): void {
  for (const w of state.waits) {
    if (w.key === key && (subject === null || w.subject === subject) && w.closedAt === null) w.closedAt = e.createdAt;
  }
}

const findOpenWait = (state: MatterState, key: WaitKey, subject: string): WaitState | undefined =>
  state.waits.find((w) => w.key === key && w.subject === subject && w.closedAt === null);

/** A rules' clear recorded before its summary was written in plain words reads as one now. */
const OLD_AUTO_CLEAR = /^(.*) was auto-cleared by the rule layer \((.*)\)\. This sub-flow is at ASSIST level: confirm the engine got it right, or escalate\. The matter is not held up by this review\.$/;
export function plainSummary(spec: Pick<DecisionSpec, 'kind' | 'summary'>): string {
  const m = spec.kind === 'auto_clear' ? OLD_AUTO_CLEAR.exec(spec.summary) : null;
  if (!m) return spec.summary;
  const reasons = m[2].split('; ').filter((r) => !/^confidence [\d.]+$/.test(r)).map((r) => r.replace(/^(.+): clear$/, '$1 passed the check').replace(/^no actionable flags$/, 'nothing in it needs action'));
  const what = m[1].replace(/^([A-Z0-9_]+) search$/, (_x, t: string) => `${t === 'LLC1' || t === 'CON29' ? t : t.replace(/_/g, ' ').toLowerCase()} search`).replace(/^ID\/AML check \((.+)\)$/, 'ID and AML check ($1)');
  return `${what.replace(/^./, (c) => c.toUpperCase())} passed the rules${reasons.length ? `: ${reasons.join('; ')}` : ''}. Confirm it, or send it back. The case carries on meanwhile.`;
}

function addDecision(state: MatterState, e: EngineEvent, spec: DecisionSpec, subject: string | null): void {
  state.decisions[e.id] = {
    ...spec,
    summary: plainSummary(spec),
    eventId: e.id,
    seq: e.seq,
    createdAt: e.createdAt,
    status: 'pending',
    openedBy: [],
    resolvedBy: null,
    resolvedAt: null,
    resolution: null,
    resolutionEventId: null,
    note: null,
    subject,
    origin: e.type === 'escalation_raised' ? ((e.payload as Payloads['escalation_raised']).origin ?? null) : null,
  };
}

function resolveDecision(state: MatterState, decisionEventId: string, option: DecisionOption, note: string | null | undefined, e: EngineEvent): void {
  const d = state.decisions[decisionEventId];
  if (!d) return; // tolerate a dangling reference in a hand-edited log rather than throw mid-replay
  d.status = resolvedStatus(option);
  d.resolvedBy = e.actor;
  d.resolvedAt = e.createdAt;
  d.resolution = option;
  d.resolutionEventId = e.id;
  d.note = note ?? null;
}

const decisionOf = <T extends EventType>(e: EngineEvent<T>): DecisionSpec | null => {
  const p = e.payload as { decision?: DecisionSpec };
  return p.decision ?? null;
};

/** Apply one event. Returns a new state; never mutates the input. */
/** One event onto a state, without touching the state passed in. */
export function applyEvent(prev: MatterState, e: EngineEvent): MatterState {
  return applyInPlace(clone(prev), clone(e));
}

/** One event onto this state, in place (the fold's own copy; see project). */
function applyInPlace(s: MatterState, e: EngineEvent): MatterState {
  s.lastSeq = e.seq;
  s.lastEventAt = e.createdAt;

  // Every decision-bearing event registers its decision in one place.
  if (DECISION_EVENT_TYPES.includes(e.type)) {
    const spec = decisionOf(e);
    if (spec) addDecision(s, e, spec, subjectOf(e));
  }

  switch (e.type) {
    case 'matter_created': {
      if ((e.payload as Payloads['matter_created']).transactionType === 'leasehold_purchase') s.managementPack.status = 'not_started';
      const p = e.payload as Payloads['matter_created'];
      s.enrolled = true;
      s.transactionType = p.transactionType;
      s.requireProofOfFunds = !!p.requireProofOfFunds;
      s.requireExchangeAuthority = !!p.requireExchangeAuthority;
      s.parties = p.parties ?? 1;
      s.hasExistingMortgage = !!p.hasExistingMortgage;
      s.considerationPennies = p.considerationPennies ?? null;
      const side = p.transactionType === 'freehold_sale' || p.transactionType === 'leasehold_sale' ? 'seller' : p.transactionType === 'remortgage' || p.transactionType === 'transfer_of_equity' ? 'owner' : 'buyer';
      if (side === 'seller') s.propertyForms.status = 'not_started';
      if (p.hasExistingMortgage && (side === 'seller' || p.transactionType === 'remortgage')) s.redemption.status = 'not_started';
      if (p.hasExistingMortgage && p.transactionType === 'transfer_of_equity') s.lenderConsent.status = 'not_started';
      if (p.transactionType === 'leasehold_sale') s.managementPack.status = 'not_started';
      s.hasLender = p.hasLender;
      s.shapes = [...(p.shapes ?? [])];
      s.requiredSearches = [...p.requiredSearches];
      s.shadowMode = !!p.shadowMode;
      s.counterpartyType = p.counterpartyType ?? null;
      s.targetExchangeDate = p.targetExchangeDate ?? null;
      s.targetCompletionDate = p.targetCompletionDate ?? null;
      s.partyNames = [...(p.partyNames ?? [])];
      s.occupiers = [...(p.occupiers ?? [])];
      s.sdltBasis = p.sdlt ?? null;
      s.mortgage.status = p.hasLender ? 'awaiting' : 'not_required';
      s.stage = 'instruction';
      s.stageHistory = [{ stage: 'instruction', at: e.createdAt, seq: e.seq }];
      break;
    }
    case 'stage_advanced': {
      const p = e.payload as Payloads['stage_advanced'];
      s.stage = p.to;
      s.stageHistory.push({ stage: p.to, at: e.createdAt, seq: e.seq });
      // Everything is in: an interim report already sent leaves a supplementary one due before exchange.
      if (p.to === 'contract_review' && s.reportOnTitle.interim && s.reportOnTitle.status === 'sent') {
        s.reportOnTitle = { ...s.reportOnTitle, status: 'not_started', interim: false, interimSentAt: s.reportOnTitle.sentAt, sentAt: null };
      }
      break;
    }
    case 'manual_handling_cleared':
      s.manualHandling = { required: false, reason: null };
      break;
    case 'manual_handling_required': {
      const p = e.payload as Payloads['manual_handling_required'];
      s.manualHandling = { required: true, reason: p.reason };
      break;
    }

    // ── ID / AML ──
    case 'id_party_added': {
      const p = e.payload as Payloads['id_party_added'];
      if (!s.partyChecks[p.party]) s.partyChecks[p.party] = { party: p.party, label: p.label, role: p.role, status: 'not_started', requestedAt: null, documentId: null, decisionEventId: null };
      break;
    }
    case 'id_check_requested': {
      const p = e.payload as Payloads['id_check_requested'];
      const target = p.party ? s.partyChecks[p.party] : s.idCheck;
      if (target) { target.status = 'requested'; target.requestedAt = e.createdAt; if (p.link) target.link = p.link; }
      openWait(s, 'id_check', p.party ?? '', e);
      break;
    }
    case 'id_check_cleared': {
      const p = e.payload as Payloads['id_check_cleared'];
      const target = p.party ? s.partyChecks[p.party] : s.idCheck;
      if (target) { target.status = 'cleared'; target.documentId = e.sourceDocumentId ?? target.documentId; }
      if (!p.party) s.idCheck.resolvedAt = e.createdAt;
      closeWait(s, 'id_check', p.party ?? '', e);
      break;
    }
    case 'id_check_flagged': {
      const p = e.payload as Payloads['id_check_flagged'];
      const target = p.party ? s.partyChecks[p.party] : s.idCheck;
      if (target) { target.status = 'flagged'; target.documentId = e.sourceDocumentId ?? target.documentId; target.decisionEventId = e.id; }
      closeWait(s, 'id_check', p.party ?? '', e);
      break;
    }
    case 'id_check_reviewed': {
      const p = e.payload as Payloads['id_check_reviewed'];
      const target = p.party ? s.partyChecks[p.party] : s.idCheck;
      if (target && p.option !== 'escalate') target.status = 'reviewed';
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      if (!(e.payload as Payloads['id_check_reviewed']).party) s.idCheck.resolvedAt = e.createdAt;
      break;
    }

    // ── Searches ──
    case 'search_ordered': {
      const p = e.payload as Payloads['search_ordered'];
      s.searches[p.searchType] = {
        searchType: p.searchType,
        cycle: (s.searches[p.searchType]?.cycle ?? 0) + 1,
        status: 'ordered',
        orderedAt: e.createdAt,
        returnedAt: null,
        documentId: null,
        facts: null,
        flags: [],
        decisionEventId: null,
        resolution: null,
      };
      openWait(s, 'search', p.searchType, e);
      break;
    }
    case 'search_returned': {
      const p = e.payload as Payloads['search_returned'];
      const sr = s.searches[p.searchType];
      if (sr) {
        sr.status = 'returned';
        sr.returnedAt = e.createdAt;
        sr.documentId = e.sourceDocumentId ?? sr.documentId;
      }
      closeWait(s, 'search', p.searchType, e);
      break;
    }
    case 'search_extracted': {
      const p = e.payload as Payloads['search_extracted'];
      const sr = s.searches[p.searchType];
      if (sr) {
        sr.status = 'extracted';
        sr.facts = p.facts;
      }
      break;
    }
    case 'search_cleared': {
      const p = e.payload as Payloads['search_cleared'];
      const sr = s.searches[p.searchType];
      if (sr) sr.status = 'cleared';
      break;
    }
    case 'search_flagged': {
      const p = e.payload as Payloads['search_flagged'];
      const sr = s.searches[p.searchType];
      if (sr) {
        sr.status = 'flagged';
        sr.flags = p.flags;
        sr.decisionEventId = e.id;
      }
      break;
    }
    case 'search_reviewed': {
      const p = e.payload as Payloads['search_reviewed'];
      const sr = s.searches[p.searchType];
      if (sr && p.option !== 'escalate') {
        sr.status = 'reviewed';
        sr.resolution = p.option;
      }
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }

    // ── Enquiries ──
    case 'enquiry_raised': {
      const p = e.payload as Payloads['enquiry_raised'];
      for (const id of [p.origin?.issueId, ...(p.origin?.alsoIssueIds ?? [])].filter(Boolean) as string[]) {
        const fromIssue = s.issues[id];
        if (!fromIssue) continue;
        fromIssue.enquiryIds.push(p.enquiryId);
        fromIssue.updatedAt = e.createdAt;
        fromIssue.history.push({ at: e.createdAt, by: e.actor, what: `enquiry ${p.enquiryId} raised: ${p.subject.split('\n')[0]}` });
      }
      s.enquiries[p.enquiryId] = {
        enquiryId: p.enquiryId,
        subject: p.subject,
        status: 'raised',
        raisedAt: e.createdAt,
        repliedAt: null,
        documentId: null,
        decisionEventId: null,
        resolution: null,
        origin: p.origin ?? null,
      };
      openWait(s, 'enquiry', p.enquiryId, e);
      break;
    }
    case 'enquiry_reply_received': {
      const p = e.payload as Payloads['enquiry_reply_received'];
      const q = s.enquiries[p.enquiryId];
      if (q) {
        q.status = 'replied';
        q.repliedAt = e.createdAt;
        q.documentId = e.sourceDocumentId ?? q.documentId;
      }
      closeWait(s, 'enquiry', p.enquiryId, e);
      break;
    }
    case 'enquiry_reply_cleared': {
      const p = e.payload as Payloads['enquiry_reply_cleared'];
      const q = s.enquiries[p.enquiryId];
      if (q) q.status = 'cleared';
      break;
    }
    case 'enquiry_reply_flagged': {
      const p = e.payload as Payloads['enquiry_reply_flagged'];
      const q = s.enquiries[p.enquiryId];
      if (q) {
        q.status = 'flagged';
        q.decisionEventId = e.id;
      }
      break;
    }
    case 'enquiry_reply_reviewed': {
      const p = e.payload as Payloads['enquiry_reply_reviewed'];
      const q = s.enquiries[p.enquiryId];
      if (q && p.option !== 'escalate') {
        q.status = 'reviewed';
        q.resolution = p.option;
      }
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }

    // ── Mortgage ──
    case 'mortgage_offer_received': {
      closeWait(s, 'mortgage_offer', null, e);
      s.mortgage.status = 'received';
      s.mortgage.documentId = e.sourceDocumentId ?? s.mortgage.documentId;
      s.mortgage.decisionEventId = null;
      break;
    }
    case 'mortgage_offer_extracted': {
      const p = e.payload as Payloads['mortgage_offer_extracted'];
      s.mortgage.status = 'extracted';
      s.mortgage.facts = p.facts;
      break;
    }
    case 'mortgage_offer_cleared':
      s.mortgage.status = 'cleared';
      break;
    case 'mortgage_condition_flagged':
      s.mortgage.status = 'flagged';
      s.mortgage.decisionEventId = e.id;
      break;
    case 'mortgage_condition_reviewed': {
      const p = e.payload as Payloads['mortgage_condition_reviewed'];
      if (p.option !== 'escalate') s.mortgage.status = 'reviewed';
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }

    // ── Title ──
    case 'title_extracted': {
      const p = e.payload as Payloads['title_extracted'];
      s.title.status = 'extracted';
      s.title.facts = s.title.lease && !p.facts.lease ? { ...p.facts, lease: s.title.lease } : p.facts;
      if (p.facts.lease) s.title.lease = p.facts.lease;
      s.title.documentId = e.sourceDocumentId ?? s.title.documentId;
      closePackIfIn(s, e);
      s.title.decisionEventId = null;
      break;
    }
    case 'lease_extracted': {
      const p = e.payload as Payloads['lease_extracted'];
      s.title.lease = p.facts;
      s.title.leaseDocumentId = e.sourceDocumentId ?? s.title.leaseDocumentId;
      if (s.title.facts) s.title.facts = { ...s.title.facts, lease: p.facts };
      if (s.title.status === 'awaiting') s.title.status = 'extracted';
      s.title.decisionEventId = null;
      break;
    }
    case 'title_cleared':
      s.title.status = 'cleared';
      break;
    case 'title_flagged':
      s.title.status = 'flagged';
      s.title.decisionEventId = e.id;
      break;
    case 'title_reviewed': {
      const p = e.payload as Payloads['title_reviewed'];
      if (p.option !== 'escalate') s.title.status = 'reviewed';
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }

    // ── Report on title ──
    case 'report_on_title_drafted': {
      const p = e.payload as Payloads['report_on_title_drafted'];
      s.reportOnTitle = {
        status: 'drafted',
        draftId: p.draftId,
        draftEventId: e.id,
        draftDocumentId: p.draftDocumentId,
        approvedEventId: null,
        approvedBy: null,
        sentAt: null,
        interim: !!p.interim,
        interimSentAt: s.reportOnTitle.interimSentAt ?? null,
      };
      break;
    }
    case 'report_on_title_approved': {
      const p = e.payload as Payloads['report_on_title_approved'];
      if (s.reportOnTitle.draftId === p.draftId) {
        s.reportOnTitle.status = 'approved';
        s.reportOnTitle.approvedEventId = e.id;
        s.reportOnTitle.approvedBy = e.actor;
      }
      resolveDecision(s, p.decisionEventId, 'approve', p.note, e);
      break;
    }
    case 'report_on_title_rejected': {
      const p = e.payload as Payloads['report_on_title_rejected'];
      if (s.reportOnTitle.draftId === p.draftId) s.reportOnTitle.status = 'rejected';
      resolveDecision(s, p.decisionEventId, 'reject', p.note, e);
      break;
    }
    case 'report_on_title_sent': {
      const p = e.payload as Payloads['report_on_title_sent'];
      if (s.reportOnTitle.draftId === p.draftId) {
        s.reportOnTitle.status = 'sent';
        s.reportOnTitle.sentAt = e.createdAt;
      }
      break;
    }

    // ── Exchange ──
    case 'deposit_received': {
      const p = e.payload as Payloads['deposit_received'];
      const before = s.deposit.received ? s.deposit.amountPennies ?? null : null;
      s.deposit = { received: true, at: s.deposit.at ?? e.createdAt, amountPennies: p.amountPennies != null ? (before ?? 0) + p.amountPennies : before, contractPennies: p.contractDepositPennies ?? s.deposit.contractPennies ?? null };
      closeWait(s, 'deposit', null, e);
      break;
    }
    case 'exchange_conditions_met':
      s.exchange.conditionsMet = true;
      break;
    case 'contracts_exchanged': {
      const p = e.payload as Payloads['contracts_exchanged'];
      s.exchange.exchangedAt = p.exchangedAt ?? e.createdAt;
      s.exchange.completionDate = p.completionDate;
      // Exchanged: the offer and the survey are behind us.
      closeWait(s, 'mortgage_offer', null, e);
      closeWait(s, 'survey', null, e);
      break;
    }

    // ── Completion ──
    case 'completion_statement_generated': {
      s.completion.statementGeneratedAt = e.createdAt;
      const bal = (e.payload as Payloads['completion_statement_generated']).balancePennies;
      if (bal != null) s.money = { ...moneyOf(s), statementBalancePennies: bal };
      break;
    }
    case 'funds_requested': {
      const p = e.payload as Payloads['funds_requested'];
      s.completion.fundsRequestedAt = e.createdAt;
      // The figure asked for sets what is needed; once money has come in, a further request is for the rest of it (a short payment, or a lender's deduction passed to the client) and does not raise the need.
      if (p.amountPennies != null && !moneyOf(s).received[p.fromRole]) s.money = { ...moneyOf(s), requested: { ...moneyOf(s).requested, [p.fromRole]: p.amountPennies } };
      openWait(s, 'funds', p.fromRole, e);
      break;
    }
    case 'funds_received': {
      const p = e.payload as Payloads['funds_received'];
      closeWait(s, 'funds', p.fromRole, e);
      if (!s.completion.receivedFrom) s.completion.receivedFrom = [];
      if (!s.completion.receivedFrom.includes(p.fromRole)) s.completion.receivedFrom.push(p.fromRole);
      const m = moneyOf(s);
      s.money = {
        ...m,
        received: p.amountPennies != null ? { ...m.received, [p.fromRole]: (m.received[p.fromRole] ?? 0) + p.amountPennies } : m.received,
        uncleared: p.uncleared ? [...m.uncleared, { id: p.receiptId ?? `REC-${e.seq}`, fromRole: p.fromRole, amountPennies: p.amountPennies ?? null, at: e.createdAt }] : m.uncleared,
      };
      // All in only when every payer the case expects has paid (the client's money in is not the lender's advance).
      if (!s.waits.some((w) => w.key === 'funds' && w.closedAt === null) && payersExpected(s).every((r) => s.completion.receivedFrom.includes(r))) s.completion.fundsReceivedAt = s.completion.fundsReceivedAt ?? e.createdAt;
      break;
    }
    case 'ap1_cancelled':
      s.postCompletion = { ...s.postCompletion, ap1SubmittedAt: null };
      closeWait(s, 'registration', null, e);
      break;
    case 'requisition_extended': {
      const p = e.payload as Payloads['requisition_extended'];
      const r = s.postCompletion.requisitions.find((x) => x.eventId === p.requisitionEventId);
      if (r) r.deadline = p.deadline;
      break;
    }
    case 'register_checked':
      s.registerCheckedAt = e.createdAt;
      break;
    case 'seller_discharge_received':
      closeWait(s, 'seller_discharge', null, e);
      break;
    case 'party_event_recorded': {
      const p = e.payload as Payloads['party_event_recorded'];
      s.partyEvents = [...(s.partyEvents ?? []), { event: p.event, party: p.party, at: e.createdAt, hasAttorney: p.hasAttorney }];
      break;
    }
    case 'sar_made':
      s.amlHold = { since: e.createdAt, noticeEnds: (e.payload as Payloads['sar_made']).noticeEnds, status: 'awaiting', moratoriumEnds: null };
      break;
    case 'daml_response_recorded': {
      const p = e.payload as Payloads['daml_response_recorded'];
      if (s.amlHold) s.amlHold = { ...s.amlHold, status: p.decision, moratoriumEnds: p.moratoriumEnds };
      break;
    }
    case 'sdlt_facts_recorded': {
      const p = e.payload as Payloads['sdlt_facts_recorded'];
      s.sdltFacts = { ...p.facts, recordedAt: e.createdAt, reasons: p.reasons, refundDiary: p.refundDiary };
      s.sdltBasis = { firstTimeBuyer: p.basis.firstTimeBuyer, additionalProperty: p.basis.additionalProperty, nonUkResident: p.basis.nonUkResident, mixedUse: p.basis.mixedUse, wales: p.basis.wales };
      break;
    }
    case 'cgt_facts_recorded': {
      const p = e.payload as Payloads['cgt_facts_recorded'];
      s.cgtFacts = { mainResidenceThroughout: p.mainResidenceThroughout, ukResident: p.ukResident, recordedAt: e.createdAt };
      break;
    }
    case 'longstop_date_recorded':
      s.longStopDate = (e.payload as Payloads['longstop_date_recorded']).date;
      break;
    case 'charge_found': {
      const p = e.payload as Payloads['charge_found'];
      s.otherCharges = [...(s.otherCharges ?? []), { id: p.chargeId, chargee: p.chargee, text: p.text, status: 'to_redeem', redemptionPennies: null, validUntil: null, redeemedAt: null, dischargedAt: null }];
      break;
    }
    case 'charge_statement_received': {
      const p = e.payload as Payloads['charge_statement_received'];
      s.otherCharges = (s.otherCharges ?? []).map((c) => (c.id === p.chargeId ? { ...c, status: 'received', redemptionPennies: p.redemptionPennies, validUntil: p.validUntil } : c));
      break;
    }
    case 'charge_redeemed': {
      const p = e.payload as Payloads['charge_redeemed'];
      s.otherCharges = (s.otherCharges ?? []).map((c) => (c.id === p.chargeId ? { ...c, status: 'redeemed', redeemedAt: e.createdAt } : c));
      openWait(s, 'discharge', p.chargeId, e);
      break;
    }
    case 'charge_discharged': {
      const p = e.payload as Payloads['charge_discharged'];
      s.otherCharges = (s.otherCharges ?? []).map((c) => (c.id === p.chargeId ? { ...c, status: 'discharged', dischargedAt: e.createdAt } : c));
      closeWait(s, 'discharge', p.chargeId, e);
      break;
    }
    case 'undertaking_given': {
      const p = e.payload as Payloads['undertaking_given'];
      s.undertaking = { givenAt: e.createdAt, to: p.to, terms: p.terms, dischargedAt: null };
      break;
    }
    case 'undertaking_discharged':
      if (s.undertaking) s.undertaking = { ...s.undertaking, dischargedAt: e.createdAt };
      break;
    case 'completion_information_received': {
      const p = e.payload as Payloads['completion_information_received'];
      s.completionInformation = { receivedAt: e.createdAt, undertakingToRedeem: p.undertakingToRedeem, documentId: p.documentId ?? e.sourceDocumentId ?? null };
      break;
    }
    case 'funds_cleared': {
      const p = e.payload as Payloads['funds_cleared'];
      s.money = { ...moneyOf(s), uncleared: moneyOf(s).uncleared.filter((u) => u.id !== p.receiptId) };
      break;
    }
    case 'refund_due': {
      const p = e.payload as Payloads['refund_due'];
      s.money = { ...moneyOf(s), refunds: [...moneyOf(s).refunds, { id: p.refundId, toRole: p.toRole, to: p.to, amountPennies: p.amountPennies, reason: p.reason, dueAt: e.createdAt, paidAt: null, reference: null }] };
      break;
    }
    case 'refund_paid': {
      const p = e.payload as Payloads['refund_paid'];
      s.money = { ...moneyOf(s), refunds: moneyOf(s).refunds.map((r) => (r.id === p.refundId ? { ...r, paidAt: e.createdAt, reference: p.reference } : r)) };
      break;
    }
    case 'completion_confirmed': {
      const p = e.payload as Payloads['completion_confirmed'];
      s.completion.confirmedAt = p.completedAt ?? e.createdAt;
      // A purchase from a charged seller: their solicitor's undertaking to send the DS1 is now owed, and chased (theme H).
      if (profileOf(s.transactionType ?? 'freehold_purchase').side === 'buyer' && ((s.title.facts as { charges?: Array<{ text: string }> } | null)?.charges ?? []).some((c) => isFinancialCharge(c.text))) openWait(s, 'seller_discharge', '', e);
      break;
    }

    // ── Post-completion ──
    case 'sdlt_submitted':
      s.postCompletion.sdltSubmittedAt = e.createdAt;
      break;
    case 'ap1_submitted':
      s.postCompletion.ap1SubmittedAt = e.createdAt;
      openWait(s, 'registration', '', e);
      break;
    case 'ap1_confirmed':
      s.postCompletion.ap1ConfirmedAt = e.createdAt;
      closeWait(s, 'registration', null, e);
      break;

    // ── Comms / chasing / escalation ──
    // ── notes and call transcripts ──
    case 'note_recorded': {
      const p = e.payload as Payloads['note_recorded'];
      s.notes[p.noteId] = {
        id: p.noteId,
        kind: p.kind,
        text: p.text,
        author: e.actor,
        at: e.createdAt,
        documentId: p.documentId,
        durationSeconds: p.durationSeconds,
        from: p.from ?? null,
        actions: [],
        extractor: null,
        decisionEventId: null,
        status: 'no_actions',
        appliedActionIds: [],
        refusedActions: [],
      };
      break;
    }
    case 'note_extracted': {
      const p = e.payload as Payloads['note_extracted'];
      const n = s.notes[p.noteId];
      if (n) {
        n.actions = p.actions;
        n.extractor = p.extractor;
        n.status = (p.actions.some((a) => a.command) || !!p.reply || !!p.messages?.length) && p.decision ? 'proposed' : 'no_actions';
        if (p.decision) n.decisionEventId = e.id;
        if (p.reply) n.reply = p.reply;
        if (p.messages?.length) n.messages = p.messages;
        else if (p.reply) n.messages = [{ id: 'reply', to: 'client', purposes: [], subject: p.reply.subject, body: p.reply.body, drafter: p.reply.drafter, on: true }];
        if (p.acknowledgement) n.acknowledgement = true;
      }
      break;
    }
    case 'note_action_refused': {
      const p = e.payload as Payloads['note_action_refused'];
      const n = s.notes[p.noteId];
      if (n) {
        n.refusedActions.push({ id: p.actionId, reason: p.reason });
        n.appliedActionIds = n.appliedActionIds.filter((id) => id !== p.actionId);
        if (!n.appliedActionIds.length) n.status = 'discarded';
      }
      break;
    }
    case 'note_actions_applied': {
      const p = e.payload as Payloads['note_actions_applied'];
      const n = s.notes[p.noteId];
      if (n) {
        n.appliedActionIds = p.applied;
        n.status = p.applied.length ? 'applied' : 'discarded';
        if (p.messages?.length) n.messagesSentTo = p.messages.map((m) => m.to);
      }
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }
    case 'client_update_sent': {
      s.clientUpdatesSent += 1;
      const p = e.payload as Payloads['client_update_sent'];
      if (p.template) s.clientUpdateLastSentAt[p.template] = e.createdAt;
      for (const k of p.mentioned ?? []) s.clientToldAt[k] = e.createdAt;
      // Asking the client for something opens a wait for it, chased until it is recorded.
      if (p.template === 'deposit_request' && !s.deposit.received) openWait(s, 'deposit', '', e);
      if (p.template === 'ownership_basis_request' && !s.clientDecisions.ownership_basis) openWait(s, 'client_decision', 'ownership_basis', e);
      if (p.template === 'exchange_authority_request' && s.clientDecisions.exchange_authority?.decision !== 'authorised') openWait(s, 'client_decision', 'exchange_authority', e);
      if (p.template === 'buildings_insurance_request' && !s.preCompletion.insuranceConfirmedAt) openWait(s, 'insurance', '', e);
      break;
    }
    case 'chase_sent': {
      const p = e.payload as Payloads['chase_sent'];
      s.chasesSent += 1;
      const w = findOpenWait(s, p.waitKey, p.subject);
      if (w) { w.chasesSentAt.push(e.createdAt); w.lastChasedBy = p.sentByName ?? null; }
      break;
    }
    case 'acknowledgement_sent': {
      const p = e.payload as Payloads['acknowledgement_sent'];
      s.acknowledgements.push({ forEventId: p.forEventId, recipientRole: p.recipientRole, at: e.createdAt });
      break;
    }
    case 'escalation_raised': {
      const p = e.payload as Payloads['escalation_raised'];
      if (p.assignedTo && s.decisions[e.id]) s.decisions[e.id].assignedTo = p.assignedTo;
      // What was escalated is with the senior now: off the handler's list until the escalation settles it.
      const origin = p.origin ? s.decisions[p.origin.decisionEventId] : null;
      if (origin && origin.status === 'pending') origin.status = 'escalated';
      if (p.waitKey) {
        const w = findOpenWait(s, p.waitKey, p.subject);
        if (w) w.escalations.push({ eventId: e.id, raisedAt: e.createdAt, resolvedAt: null });
      }
      break;
    }
    case 'escalation_resolved': {
      const p = e.payload as Payloads['escalation_resolved'];
      for (const w of s.waits) {
        const esc = w.escalations.find((x) => x.eventId === p.escalationEventId);
        if (esc) esc.resolvedAt = e.createdAt;
      }
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }

    // ── Payment verification (addendum 2) ──
    case 'bank_details_recorded': {
      const p = e.payload as Payloads['bank_details_recorded'];
      for (const b of Object.values(s.bankDetails)) if (b.payeeKind === p.payeeKind && b.status !== 'failed') b.status = 'superseded';
      s.bankDetails[p.bankDetailsId] = {
        id: p.bankDetailsId,
        payeeKind: p.payeeKind,
        payeeRef: p.payeeRef,
        details: p.details,
        sourceChannel: p.sourceChannel,
        sourceDocumentId: e.sourceDocumentId ?? '',
        supersedesId: p.supersedesId,
        status: 'unverified',
        recordedAt: e.createdAt,
        recordedBy: e.actor,
        decisionEventId: null,
        verifiedAt: null,
        verifiedBy: null,
        verificationMethod: null,
        verificationRef: null,
      };
      break;
    }
    case 'bank_details_change_flagged': {
      const p = e.payload as Payloads['bank_details_change_flagged'];
      const b = s.bankDetails[p.bankDetailsId];
      if (b) b.decisionEventId = e.id;
      break;
    }
    case 'bank_details_verified': {
      const p = e.payload as Payloads['bank_details_verified'];
      const b = s.bankDetails[p.bankDetailsId];
      if (b && b.status === 'unverified') {
        b.status = 'verified';
        b.verifiedAt = e.createdAt;
        b.verifiedBy = e.actor;
        b.verificationMethod = p.verificationMethod;
        b.verificationRef = p.verificationRef;
      }
      resolveDecision(s, p.decisionEventId, 'verify', p.note, e);
      break;
    }
    case 'bank_details_verification_failed': {
      const p = e.payload as Payloads['bank_details_verification_failed'];
      const b = s.bankDetails[p.bankDetailsId];
      if (b) b.status = 'failed';
      resolveDecision(s, p.decisionEventId, 'reject', p.reason, e);
      break;
    }
    case 'payment_authorised': {
      const p = e.payload as Payloads['payment_authorised'];
      s.payments.push({ eventId: e.id, payeeKind: p.payeeKind, bankDetailsId: p.bankDetailsId, amountPennies: p.amountPennies, purpose: p.purpose, authorisedBy: e.actor, at: e.createdAt });
      break;
    }

    // ── Shadow mode / assist (addendum 3) ──
    // ── eventualities ──
    case 'matter_abandoned': {
      const p = e.payload as Payloads['matter_abandoned'];
      s.abandoned = { at: e.createdAt, reason: p.reason, detail: p.detail ?? null, stage: p.stage };
      for (const w of s.waits) if (w.closedAt === null) w.closedAt = e.createdAt;
      break;
    }
    case 'signing_method_set': {
      const p = e.payload as Payloads['signing_method_set'];
      s.signing = { ...s.signing, methods: { ...s.signing.methods, [p.document]: p.method } };
      break;
    }
    case 'signing_pack_sent': {
      const p = e.payload as Payloads['signing_pack_sent'];
      // A pack adds its deeds to what the client has been sent (the mortgage deed can go before the contract).
      s.signing = { ...s.signing, packSentAt: e.createdAt, documents: [...new Set([...s.signing.documents, ...p.documents])], methods: { ...s.signing.methods, ...p.methods } };
      openWait(s, 'signed_documents', '', e);
      break;
    }
    case 'signing_envelope_sent': {
      const p = e.payload as Payloads['signing_envelope_sent'];
      s.signing = { ...s.signing, envelopes: { ...s.signing.envelopes, [p.document]: { provider: p.provider, envelopeId: p.envelopeId, sentAt: e.createdAt } } };
      break;
    }
    case 'funding_changed': {
      const p = e.payload as Payloads['funding_changed'];
      s.hasLender = p.hasLender;
      // A mortgage is its own step: there when there is a lender, gone (with anything waiting on it) when there is not.
      if (p.hasLender) { if (s.mortgage.status === 'not_required') s.mortgage = { status: 'awaiting', documentId: null, facts: null, decisionEventId: null }; }
      else { s.mortgage = { status: 'not_required', documentId: null, facts: null, decisionEventId: null }; closeWait(s, 'mortgage_offer', null, e); }
      break;
    }
    case 'supporting_document_read': {
      const p = e.payload as Payloads['supporting_document_read'];
      const docId = e.sourceDocumentId ?? e.id;
      s.title = { ...s.title, supporting: [...(s.title.supporting ?? []).filter((x) => x.documentId !== docId), { documentId: docId, facts: p.facts, at: e.createdAt }] };
      break;
    }
    case 'title_plan_read': {
      const p = e.payload as Payloads['title_plan_read'];
      const docId = e.sourceDocumentId ?? e.id;
      s.title = { ...s.title, plans: [...(s.title.plans ?? []).filter((x) => x.documentId !== docId), { documentId: docId, facts: p.facts, at: e.createdAt }] };
      // The title was read from this plan (before plans were told apart): it was never the register, so the title waits for the register again.
      if (s.title.documentId === docId) s.title = { ...s.title, status: 'awaiting', documentId: null, facts: null, decisionEventId: null };
      break;
    }
    case 'expectation_opened': {
      const p = e.payload as Payloads['expectation_opened'];
      openWait(s, p.key, '', e);
      break;
    }
    case 'survey_plan_recorded': {
      const p = e.payload as Payloads['survey_plan_recorded'];
      s.survey = { ...s.survey, plan: { plan: p.plan, date: p.date, at: e.createdAt } };
      // Not having one is the client's choice, recorded: nothing more to check on.
      if (p.plan === 'none') closeWait(s, 'survey', null, e);
      break;
    }
    case 'chain_consent_recorded': {
      s.shareChain = (e.payload as Payloads['chain_consent_recorded']).given;
      break;
    }
    case 'file_delivery_set': {
      s.fileDelivery = (e.payload as Payloads['file_delivery_set']).mode;
      break;
    }
    case 'wait_progress_reported': {
      const p = e.payload as Payloads['wait_progress_reported'];
      const w = findOpenWait(s, p.waitKey, p.subject);
      if (w) w.reported = { claim: p.claim, at: e.createdAt, until: p.until };
      break;
    }
    case 'availability_recorded': {
      const p = e.payload as Payloads['availability_recorded'];
      s.availability = [...(s.availability ?? []).filter((w) => w.id !== p.id), { id: p.id, party: p.party, from: p.from, until: p.until, note: p.note, recordedAt: e.createdAt }];
      break;
    }
    case 'clients_updated': {
      const p = e.payload as Payloads['clients_updated'];
      s.partyNames = [...p.partyNames];
      s.parties = Math.max(1, p.partyNames.length);
      // A client taken off the case takes their unfinished check with them; a finished one stays on the record.
      const keep = new Set(p.partyNames.slice(1).map((n) => partyId(p.role, n)));
      for (const [id, pc] of Object.entries(s.partyChecks)) {
        if (pc.role !== p.role || keep.has(id) || isResolved(pc.status) || pc.status === 'flagged') continue;
        delete s.partyChecks[id];
        for (const w of s.waits) if (w.key === 'id_check' && w.subject === id && w.closedAt === null) w.closedAt = e.createdAt;
      }
      break;
    }
    case 'target_dates_changed': {
      const p = e.payload as Payloads['target_dates_changed'];
      s.targetExchangeDate = p.targetExchangeDate;
      s.targetCompletionDate = p.targetCompletionDate;
      break;
    }
    case 'completion_date_changed': {
      s.exchange.completionDate = (e.payload as Payloads['completion_date_changed']).to;
      break;
    }
    case 'notice_to_complete_served': {
      const p = e.payload as Payloads['notice_to_complete_served'];
      s.noticeToComplete = { servedBy: p.servedBy, servedAt: p.servedAt, expiresAt: p.expiresAt, eventId: e.id };
      break;
    }
    case 'mortgage_offer_withdrawn': {
      s.mortgage = { status: 'awaiting', documentId: null, facts: null, decisionEventId: null };
      break;
    }
    case 'enquiry_withdrawn': {
      const p = e.payload as Payloads['enquiry_withdrawn'];
      const q = s.enquiries[p.enquiryId];
      if (q) q.status = 'withdrawn';
      const w = findOpenWait(s, 'enquiry', p.enquiryId);
      if (w) w.closedAt = e.createdAt;
      break;
    }
    case 'hmlr_requisition_received': {
      const p = e.payload as Payloads['hmlr_requisition_received'];
      s.postCompletion.requisitions.push({ eventId: e.id, receivedAt: e.createdAt, respondedAt: null, deadline: p.deadline ?? null });
      break;
    }
    case 'hmlr_requisition_responded': {
      const p = e.payload as Payloads['hmlr_requisition_responded'];
      const r = s.postCompletion.requisitions.find((x) => x.eventId === p.decisionEventId);
      if (r) r.respondedAt = e.createdAt;
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }
    case 'correction_recorded': {
      s.corrections += 1;
      break;
    }
    case 'handler_changed': {
      s.handler = (e.payload as Payloads['handler_changed']).toUserId;
      break;
    }

    // ── issues (docs/engine-issues.md) ──
    case 'issue_raised': {
      const p = e.payload as Payloads['issue_raised'];
      // An investigation (re)opened on the survey puts the survey back to waiting on it.
      s.issues[p.issueId] = {
        id: p.issueId,
        kind: p.kind,
        title: p.title,
        detail: p.detail,
        gate: p.gate,
        status: 'open',
        raisedAt: e.createdAt,
        raisedBy: e.actor,
        raisedAtStage: p.stage,
        updatedAt: e.createdAt,
        sourceDocumentId: p.sourceDocumentId,
        resolution: null,
        resolvedAt: null,
        resolvedBy: null,
        origin: p.origin ?? null,
        finding: p.finding ?? null,
        party: p.party ?? null,
        costPennies: null,
        paidBy: null,
        enquiryIds: [],
        severity: p.severity ?? 'warning',
        causedBy: p.causedBy ?? null,
        resolveBy: p.resolveBy ?? defaultResolveBy(s, p.kind, p.gate, e.createdAt),
        // Raised from an email whose approved reply went to the client: they were told in that reply.
        clientToldAt: p.sourceDocumentId && Object.values(s.notes).some((n) => n.documentId === p.sourceDocumentId && (n.messagesSentTo ?? []).includes('client')) ? e.createdAt : null,
        history: [{ at: e.createdAt, by: e.actor, what: `raised (${p.kind.replace(/_/g, ' ')}, ${p.severity ?? 'warning'}, holds ${p.gate === 'none' ? 'nothing' : p.gate}${p.party ? `, re ${p.party}` : ''}${p.causedBy ? `, discovered while dealing with ${p.causedBy}` : ''})` }],
      };
      break;
    }
    case 'issue_updated': {
      const p = e.payload as Payloads['issue_updated'];
      const i = s.issues[p.issueId];
      if (!i) break;
      i.status = p.status;
      if (p.gate) i.gate = p.gate;
      if (p.party !== undefined) i.party = p.party;
      if (p.resolveBy) i.resolveBy = p.resolveBy;
      if (p.note && /^Emailed the client\b/.test(p.note)) i.clientToldAt = e.createdAt;
      i.updatedAt = e.createdAt;
      i.history.push({ at: e.createdAt, by: e.actor, what: `${p.status}${p.gate ? ` (now holds ${p.gate === 'none' ? 'nothing' : p.gate})` : ''}${p.resolveBy ? ` (resolve by ${p.resolveBy})` : ''}${p.note ? `: ${p.note}` : ''}` });
      break;
    }
    case 'issue_resolved': {
      const p = e.payload as Payloads['issue_resolved'];
      const i = s.issues[p.issueId];
      if (!i) break;
      i.status = 'resolved';
      i.resolution = p.resolution;
      i.resolvedAt = e.createdAt;
      i.resolvedBy = e.actor;
      i.costPennies = p.costPennies ?? null;
      i.paidBy = p.paidBy ?? null;
      i.details = p.details ?? null;
      i.evidenceDocumentId = p.documentId ?? null;
      // An extension moves the offer's expiry (the deadline timer reads it).
      if ((p.resolution === 'offer_extended' || p.resolution === 'expiry_recorded') && typeof p.details?.newExpiry === 'string' && s.mortgage.facts) s.mortgage.facts.expiryDate = p.details.newExpiry;
      i.updatedAt = e.createdAt;
      i.history.push({ at: e.createdAt, by: e.actor, what: `resolved: ${p.resolution.replace(/_/g, ' ')}${p.costPennies != null ? ` (£${(p.costPennies / 100).toLocaleString('en-GB')}${p.paidBy ? `, paid by ${p.paidBy}` : ''})` : ''}${p.note ? ` — ${p.note}` : ''}` });
      settleSurvey(s);
      break;
    }
    case 'issue_withdrawn': {
      const p = e.payload as Payloads['issue_withdrawn'];
      const i = s.issues[p.issueId];
      if (!i) break;
      i.status = 'withdrawn';
      i.resolvedAt = e.createdAt;
      i.resolvedBy = e.actor;
      i.updatedAt = e.createdAt;
      i.history.push({ at: e.createdAt, by: e.actor, what: `withdrawn: ${p.reason}` });
      settleSurvey(s);
      break;
    }
    case 'issue_fatal': {
      const p = e.payload as Payloads['issue_fatal'];
      const i = s.issues[p.issueId];
      if (!i) break;
      i.status = 'fatal';
      i.resolvedAt = e.createdAt;
      i.resolvedBy = e.actor;
      i.updatedAt = e.createdAt;
      i.history.push({ at: e.createdAt, by: e.actor, what: `fatal: ${p.reason}` });
      break;
    }
    case 'price_changed': {
      s.purchasePricePennies = (e.payload as Payloads['price_changed']).toPennies;
      break;
    }
    case 'contract_approved': {
      s.readiness.contractApprovedAt = e.createdAt;
      // Approved by the task or by hand: the task is done either way.
      for (const d of Object.values(s.decisions)) if (d.kind === 'contract' && d.status === 'pending') resolveDecision(s, d.eventId, 'approve', (e.payload as { note?: string | null }).note ?? null, e);
      break;
    }
    case 'contract_filed': {
      s.readiness.contractDocumentId = (e.payload as Payloads['contract_filed']).documentId;
      closePackIfIn(s, e);
      break;
    }
    case 'contract_review_raised': {
      const dep = (e.payload as Payloads['contract_review_raised']).depositPennies;
      if (dep != null) s.deposit = { ...s.deposit, contractPennies: dep };
      break;
    }
    case 'contract_reviewed': {
      const p = e.payload as Payloads['contract_reviewed'];
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }
    case 'signed_contract_held': {
      s.readiness.signedContractHeldAt = e.createdAt;
      break;
    }

    // ── proof of funds ──
    case 'proof_of_funds_requested': {
      const p = e.payload as Payloads['proof_of_funds_requested'];
      s.proofOfFunds = { ...s.proofOfFunds, status: 'requested', requestId: p.requestId, requestedAt: e.createdAt, formUrl: p.formUrl ?? null, channel: p.channel ?? null, sendError: p.sendError ?? null, rounds: s.proofOfFunds.rounds + 1 };
      for (const id of p.queryIds ?? []) {
        const q = s.proofOfFunds.queries[id];
        if (q && q.status === 'draft') s.proofOfFunds.queries[id] = { ...q, status: 'sent', sentAt: e.createdAt };
      }
      openWait(s, 'proof_of_funds', p.requestId, e);
      break;
    }
    case 'proof_of_funds_submitted': {
      const p = e.payload as Payloads['proof_of_funds_submitted'];
      s.proofOfFunds = { ...s.proofOfFunds, status: 'submitted', requestId: p.requestId, submittedAt: e.createdAt, documentId: e.sourceDocumentId ?? null, facts: p.facts, decisionEventId: e.id, resolution: null, flags: p.flags, statements: p.statements ?? [], payslips: p.payslips ?? [], risk: p.risk ?? null };
      closeWait(s, 'proof_of_funds', p.requestId, e);
      break;
    }
    case 'proof_of_funds_reviewed': {
      const p = e.payload as Payloads['proof_of_funds_reviewed'];
      s.proofOfFunds = { ...s.proofOfFunds, status: 'reviewed', resolution: p.option, approvedAt: p.option === 'approve' ? e.createdAt : s.proofOfFunds.approvedAt, approvedBy: p.option === 'approve' ? e.actor : s.proofOfFunds.approvedBy };
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }
    case 'proof_of_funds_query_raised': {
      const p = e.payload as Payloads['proof_of_funds_query_raised'];
      s.proofOfFunds.queries[p.query.id] = { ...p.query, raisedAt: e.createdAt, raisedBy: e.actor, status: 'draft', sentAt: null, answer: null, answerEvidenceDocumentIds: [], answeredAt: null };
      break;
    }
    case 'proof_of_funds_query_withdrawn': {
      const p = e.payload as Payloads['proof_of_funds_query_withdrawn'];
      const q = s.proofOfFunds.queries[p.queryId];
      if (q) s.proofOfFunds.queries[p.queryId] = { ...q, status: 'withdrawn' };
      break;
    }
    case 'proof_of_funds_query_answered': {
      const p = e.payload as Payloads['proof_of_funds_query_answered'];
      const q = s.proofOfFunds.queries[p.queryId];
      if (q) s.proofOfFunds.queries[p.queryId] = { ...q, status: 'answered', answer: p.answer || null, answerEvidenceDocumentIds: p.evidenceDocumentIds, answeredAt: e.createdAt };
      break;
    }
    // ── leasehold ──
    case 'signed_transfer_requested': {
      s.deeds = { ...s.deeds, transferRequestedAt: e.createdAt };
      openWait(s, 'transfer_deed', '', e);
      break;
    }
    case 'contract_pack_requested': {
      s.contractPack = { ...s.contractPack, requestedAt: e.createdAt };
      openWait(s, 'contract_pack', '', e);
      break;
    }
    case 'management_pack_requested': {
      s.managementPack = { ...s.managementPack, status: 'requested', requestedAt: e.createdAt };
      openWait(s, 'management_pack', '', e);
      break;
    }
    case 'management_pack_received': {
      const p = e.payload as Payloads['management_pack_received'];
      s.managementPack = { ...s.managementPack, status: 'flagged', documentId: e.sourceDocumentId ?? null, facts: p.facts, decisionEventId: e.id };
      closeWait(s, 'management_pack', null, e);
      break;
    }
    case 'management_pack_reviewed': {
      const p = e.payload as Payloads['management_pack_reviewed'];
      s.managementPack.status = 'reviewed';
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }
    case 'notice_of_assignment_served': {
      s.postCompletion.noticeOfAssignmentAt = e.createdAt;
      break;
    }
    case 'issue_severity_changed': {
      const p = e.payload as Payloads['issue_severity_changed'];
      const i = s.issues[p.issueId];
      if (!i) break;
      // Worse than when the client was told: it is news again.
      const rank = { info: 0, warning: 1, critical: 2 } as const;
      if (rank[p.severity] > rank[i.severity]) i.clientToldAt = null;
      i.severity = p.severity;
      // Not "movement": the stale clock measures people's and third parties' activity, not the timer's.
      i.history.push({ at: e.createdAt, by: e.actor, what: `severity → ${p.severity}: ${p.reason}` });
      break;
    }
    // ── case model ──
    case 'survey_received': {
      const p = e.payload as Payloads['survey_received'];
      const further = p.facts.recommendations.some((r) => r.furtherInvestigation);
      // Read again (the same document): the new reading replaces the old one.
      s.survey.reports = s.survey.reports.filter((r) => !(e.sourceDocumentId && r.documentId === e.sourceDocumentId && r.forIssueId === null));
      closeWait(s, 'survey', null, e);
      const unread = p.facts.confidence === 0 || p.facts.recommendations.some((r) => r.code === 'UNREAD');
      s.survey.reports.push({ eventId: e.id, documentId: e.sourceDocumentId ?? null, surveyType: p.surveyType, receivedAt: e.createdAt, recommendations: unread ? 0 : p.facts.recommendations.length, furtherInvestigation: further, forIssueId: null, urgent: p.facts.recommendations.filter((r) => r.rating === 3 || (r.rating == null && r.severity === 'high')).length, toInvestigate: p.facts.recommendations.filter((r) => r.furtherInvestigation).length, legalPoints: p.facts.legalIssues?.length ?? 0, unread });
      // The client decides, once, how to proceed: the surveyor's suggestions inform that, they do not each hold exchange.
      s.survey.status = s.clientDecisions.physical_condition?.decision === 'satisfied' ? 'client_satisfied' : 'awaiting_client';
      void further;
      break;
    }
    case 'specialist_report_received': {
      const p = e.payload as Payloads['specialist_report_received'];
      s.survey.reports.push({ eventId: e.id, documentId: e.sourceDocumentId ?? null, surveyType: p.facts.surveyType, receivedAt: e.createdAt, recommendations: p.facts.recommendations.length, furtherInvestigation: p.furtherInvestigation, forIssueId: p.forIssueId });
      // The status settles once the issues this event resolves / raises are applied (settleSurvey on issue_resolved / withdrawn).
      // A further check the specialist suggests is for the client to weigh, like the survey's own: it does not reopen a gate.
      void p.furtherInvestigation;
      break;
    }
    case 'client_decision_lapsed': {
      delete s.clientDecisions[(e.payload as Payloads['client_decision_lapsed']).subject];
      break;
    }
    case 'client_decision_recorded': {
      const p = e.payload as Payloads['client_decision_recorded'];
      s.clientDecisions[p.subject] = { decision: p.decision, at: e.createdAt, by: e.actor, note: p.note ?? null };
      closeWait(s, 'client_decision', p.subject, e);
      // Which investigations the instruction covers: those named, or every open one.
      if (p.subject === 'further_investigation') {
        for (const i of Object.values(s.issues)) if (i.kind === 'survey_further_investigation' && (i.status === 'open' || i.status === 'negotiating') && (!p.scope?.length || p.scope.includes(i.id))) i.route = p.decision as 'evidence' | 'pursue' | 'waive';
      }
      if (p.subject === 'physical_condition') s.survey.status = p.decision === 'satisfied' ? 'client_satisfied' : p.decision === 'renegotiate' ? 'client_renegotiating' : p.decision === 'withdraw' ? 'client_withdrawing' : 'further_investigation';
      break;
    }
    case 'matter_closed': {
      s.closedAt = e.createdAt;
      { const p = e.payload as Payloads['matter_closed']; if (p.destroyAfter && p.cddUntil) s.retention = { destroyAfter: p.destroyAfter, cddUntil: p.cddUntil }; }
      for (const w of s.waits) if (w.closedAt === null) w.closedAt = e.createdAt;
      break;
    }
    // ── transaction types ──
    case 'property_forms_requested': {
      s.propertyForms = { ...s.propertyForms, status: 'requested', forms: (e.payload as Payloads['property_forms_requested']).forms };
      openWait(s, 'property_forms', '', e);
      break;
    }
    case 'property_forms_received': {
      const p = e.payload as Payloads['property_forms_received'];
      s.propertyForms = { status: 'received', forms: p.forms, documentId: e.sourceDocumentId ?? null, facts: p.facts ?? null };
      closeWait(s, 'property_forms', null, e);
      break;
    }
    case 'contract_pack_sent': {
      s.contractPack.sentAt = e.createdAt;
      break;
    }
    case 'buyer_enquiries_received': {
      const p = e.payload as Payloads['buyer_enquiries_received'];
      for (const q of p.enquiries) s.inboundEnquiries[q.id] = { id: q.id, question: q.question, round: p.round, receivedAt: e.createdAt, repliedAt: null };
      // A reply is owed again: the derived exchange conditions no longer hold until it is sent.
      if (!s.exchange.exchangedAt) s.exchange.conditionsMet = false;
      break;
    }
    case 'enquiry_replies_sent': {
      const p = e.payload as Payloads['enquiry_replies_sent'];
      for (const id of p.enquiryIds) if (s.inboundEnquiries[id]) s.inboundEnquiries[id].repliedAt = e.createdAt;
      break;
    }
    case 'redemption_statement_requested': {
      s.redemption = { ...s.redemption, status: 'requested', lender: (e.payload as Payloads['redemption_statement_requested']).lender ?? s.redemption.lender };
      openWait(s, 'redemption', '', e);
      break;
    }
    case 'redemption_statement_received': {
      const p = e.payload as Payloads['redemption_statement_received'];
      s.redemption = { ...s.redemption, status: 'received', lender: p.lender ?? s.redemption.lender, redemptionPennies: p.redemptionPennies, validUntil: p.validUntil, documentId: e.sourceDocumentId ?? null };
      closeWait(s, 'redemption', null, e);
      break;
    }
    case 'mortgage_redeemed': {
      s.redemption = { ...s.redemption, status: 'redeemed', redeemedAt: e.createdAt };
      openWait(s, 'discharge', '', e);
      break;
    }
    case 'discharge_confirmed': {
      s.redemption = { ...s.redemption, status: 'discharged', dischargedAt: e.createdAt };
      // The existing mortgage's own wait: any other charge's discharge is waited for under its id.
      closeWait(s, 'discharge', '', e);
      break;
    }
    case 'mortgage_deed_executed': {
      s.deeds.mortgageDeedAt = e.createdAt;
      break;
    }
    case 'seller_forms_received': {
      const p = e.payload as Payloads['seller_forms_received'];
      // The forms come as separate files: each adds its forms and its answers to the set (a later answer to the same question wins).
      const prev = s.sellerForms;
      const docs = [...(prev.documents ?? (prev.documentId ? [{ documentId: prev.documentId, forms: prev.forms }] : [])).filter((d) => d.documentId !== e.sourceDocumentId), ...(e.sourceDocumentId ? [{ documentId: e.sourceDocumentId, forms: p.forms }] : [])];
      const answers = { ...(prev.facts?.answers ?? {}), ...Object.fromEntries(Object.entries(p.facts?.answers ?? {}).filter(([, v]) => v !== null && v !== undefined)) };
      const merged = p.facts ? { ...p.facts, forms: [...new Set([...(prev.facts?.forms ?? []), ...(p.facts.forms ?? [])])], answers, disclosures: [...(prev.facts?.disclosures ?? []), ...(p.facts.disclosures ?? [])] } : prev.facts;
      s.sellerForms = { receivedAt: e.createdAt, forms: [...new Set(docs.flatMap((d) => d.forms))], documentId: e.sourceDocumentId ?? prev.documentId, facts: merged as typeof prev.facts, documents: docs };
      // Read before as a supporting document: it is the forms, and only the forms.
      if (e.sourceDocumentId && s.title.supporting?.some((x) => x.documentId === e.sourceDocumentId)) s.title = { ...s.title, supporting: s.title.supporting.filter((x) => x.documentId !== e.sourceDocumentId) };
      break;
    }
    case 'related_matter_linked': {
      const p = e.payload as Payloads['related_matter_linked'];
      s.relatedMatter = { matterId: p.relatedMatterId, relation: p.relation, linkedAt: e.createdAt };
      break;
    }
    case 'related_matter_unlinked': {
      s.relatedMatter = null;
      break;
    }
    // A person marked a step complete by hand (manual handling): it reads as reviewed, and anything waited on for it stops.
    case 'step_completed_manually': {
      const p = e.payload as Payloads['step_completed_manually'];
      s.manualSteps = { ...(s.manualSteps ?? {}), [p.step]: { at: e.createdAt, by: e.actor, note: p.note, documentIds: p.documentIds, skipReason: p.skipReason ?? null, eventId: e.id, stage: s.stage } };
      const close = (key: string, subject: string | null = null) => {
        for (const w of s.waits) if (w.key === key && w.closedAt === null && (subject === null || w.subject === subject)) w.closedAt = e.createdAt;
      };
      const [kind, sub] = p.step.includes(':') ? [p.step.split(':')[0], p.step.split(':').slice(1).join(':')] : [p.step, null];
      // A step done by hand settles whatever was waiting for a person's sign-off on it (a report draft, a flagged search):
      // otherwise it stays on the Tasks tab with nothing that can clear it.
      const decisionKind = ({ id_check: 'id_check', proof_of_funds: 'proof_of_funds', title: 'title', mortgage: 'mortgage', report_on_title: 'report_on_title', management_pack: 'management_pack', search: 'search', enquiry: 'enquiry', enquiries: 'enquiry' } as Record<string, string>)[kind];
      if (decisionKind) for (const d of Object.values(s.decisions)) {
        if (d.status !== 'pending' || d.kind !== decisionKind) continue;
        if (sub && d.subject && d.subject !== sub) continue;
        if (kind === 'id_check' && d.subject && d.subject.includes(':')) continue; // a co-client's own check is theirs
        resolveDecision(s, d.eventId, 'approve', `Completed by hand: ${p.note}`, e);
      }
      switch (kind) {
        case 'id_check': s.idCheck.status = 'reviewed'; close('id_check'); break;
        case 'proof_of_funds': s.proofOfFunds.status = 'reviewed'; close('proof_of_funds'); break;
        case 'title': s.title.status = 'reviewed'; closePackIfIn(s, e);
          if (p.facts?.titleNumber) s.title.facts = s.title.facts ? { ...s.title.facts, titleNumber: p.facts.titleNumber } : { titleNumber: p.facts.titleNumber, tenure: s.transactionType?.startsWith('leasehold') ? 'leasehold' : 'freehold', restrictions: [], charges: [], covenants: [], confidence: 1 };
          break;
        case 'report_on_title': s.reportOnTitle = { ...s.reportOnTitle, status: 'sent', sentAt: e.createdAt, interim: false }; break;
        case 'mortgage': s.mortgage.status = 'reviewed'; close('mortgage_offer');
          if (p.facts && (p.facts.lender || p.facts.amountPennies != null || p.facts.expiryDate)) {
            const was = s.mortgage.facts;
            s.mortgage.facts = { lender: p.facts.lender || was?.lender || 'unknown', amountPennies: p.facts.amountPennies ?? was?.amountPennies, expiryDate: p.facts.expiryDate ?? was?.expiryDate, conditions: was?.conditions ?? [], confidence: was?.confidence ?? 1 };
          }
          break;
        case 'management_pack': s.managementPack.status = 'reviewed'; close('management_pack'); break;
        case 'property_forms': s.propertyForms.status = 'received'; close('property_forms'); break;
        case 'contract_pack': s.contractPack.sentAt = s.contractPack.sentAt ?? e.createdAt; break;
        case 'contract_approved': s.readiness.contractApprovedAt = s.readiness.contractApprovedAt ?? e.createdAt;
          for (const d of Object.values(s.decisions)) if (d.kind === 'contract' && d.status === 'pending') resolveDecision(s, d.eventId, 'approve', `Completed by hand: ${p.note}`, e);
          break;
        case 'deposit': s.deposit = { received: true, at: e.createdAt }; break;
        case 'redemption': if (s.redemption.status === 'not_started' || s.redemption.status === 'requested') s.redemption.status = 'received'; close('redemption');
          if (p.facts) s.redemption = { ...s.redemption, redemptionPennies: p.facts.amountPennies ?? s.redemption.redemptionPennies, validUntil: p.facts.validUntil ?? s.redemption.validUntil, lender: p.facts.lender || s.redemption.lender };
          break;
        case 'enquiries': for (const q of Object.values(s.enquiries)) if (!isResolved(q.status)) q.status = 'reviewed' as never; close('enquiry'); break;
        case 'enquiry': if (sub && s.enquiries[sub]) { s.enquiries[sub].status = 'reviewed' as never; close('enquiry', sub); } break;
        case 'search': if (sub) {
          const t = sub as SearchType;
          const was = s.searches[t];
          s.searches[t] = was ? { ...was, status: 'reviewed', resolution: 'approve' } : { searchType: t, cycle: 1, status: 'reviewed', orderedAt: null, returnedAt: e.createdAt, documentId: p.documentIds[0] ?? null, facts: null, flags: [], decisionEventId: null, resolution: 'approve' };
          close('search', sub);
        } break;
      }
      break;
    }
    case 'manual_step_undone': {
      // The full rebuild skips the completion (project() above); a fold onto a cached state is replaced by one (service.run).
      const p = e.payload as Payloads['manual_step_undone'];
      if (s.manualSteps) delete s.manualSteps[p.step];
      break;
    }
    case 'step_reopened': {
      // Done once, no longer holds: outstanding again from now; what it unlocked is locked again.
      const p = e.payload as Payloads['step_reopened'];
      if (s.manualSteps) delete s.manualSteps[p.step];
      const [kind, sub] = p.step.includes(':') ? [p.step.split(':')[0], p.step.split(':').slice(1).join(':')] : [p.step, null];
      switch (kind) {
        case 'id_check': s.idCheck = { ...s.idCheck, status: 'not_started', decisionEventId: null, resolvedAt: null }; break;
        case 'proof_of_funds': s.proofOfFunds.status = 'not_started'; break;
        case 'title': s.title.status = 'awaiting'; s.title.decisionEventId = null; break;
        case 'report_on_title': s.reportOnTitle = { ...s.reportOnTitle, status: 'not_started', draftId: null, draftEventId: null, draftDocumentId: null, approvedEventId: null, approvedBy: null, sentAt: null }; break;
        case 'management_pack': s.managementPack.status = 'not_started'; break;
        case 'property_forms': s.propertyForms.status = 'not_started'; break;
        case 'contract_pack': s.contractPack.sentAt = null; break;
        case 'contract_approved': s.readiness.contractApprovedAt = null; s.readiness.signedContractHeldAt = null; break;
        case 'deposit': s.deposit = { received: false, at: null }; break;
        case 'redemption': s.redemption = { ...s.redemption, status: 'not_started', redemptionPennies: null, validUntil: null }; break;
        case 'search': if (sub) delete s.searches[sub]; break;
      }
      break;
    }
    case 'lender_requirements_recorded': {
      const p = e.payload as Payloads['lender_requirements_recorded'];
      const prev = s.lenderRequirements;
      s.lenderRequirements = { minUnexpiredYears: p.minUnexpiredYears ?? prev?.minUnexpiredYears ?? null, maxSearchAgeMonths: p.maxSearchAgeMonths ?? prev?.maxSearchAgeMonths ?? null, acceptsNonFamilyGift: p.acceptsNonFamilyGift ?? prev?.acceptsNonFamilyGift ?? null, requiresEws1: p.requiresEws1 ?? prev?.requiresEws1 ?? null, note: p.note ?? prev?.note ?? null, recordedAt: e.createdAt };
      break;
    }
    case 'client_account_receipt_recorded': {
      const p = e.payload as Payloads['client_account_receipt_recorded'];
      if (!s.receipts) s.receipts = [];
      s.receipts.push({ remitter: p.remitter, amountPennies: p.amountPennies ?? null, purpose: p.purpose, at: e.createdAt });
      break;
    }
    case 'name_change_evidenced': {
      const p = e.payload as Payloads['name_change_evidenced'];
      if (!s.nameAliases) s.nameAliases = [];
      s.nameAliases.push({ from: p.from, to: p.to, party: p.party ?? null });
      break;
    }
    case 'buildings_insurance_confirmed': {
      const p = e.payload as Payloads['buildings_insurance_confirmed'];
      s.preCompletion.insuranceConfirmedAt = e.createdAt;
      s.preCompletion.insurer = p.insurer ?? null;
      closeWait(s, 'insurance', null, e);
      break;
    }
    case 'priority_search_made': {
      const p = e.payload as Payloads['priority_search_made'];
      s.preCompletion.prioritySearchAt = e.createdAt;
      s.preCompletion.prioritySearchExpiresAt = p.expiresAt;
      break;
    }
    case 'bankruptcy_search_clear': {
      s.preCompletion.bankruptcySearchAt = e.createdAt;
      break;
    }
    case 'certificate_of_title_sent': {
      s.deeds.certificateOfTitleAt = e.createdAt;
      break;
    }
    case 'lender_consent_requested': {
      s.lenderConsent = { ...s.lenderConsent, status: 'requested', lender: (e.payload as Payloads['lender_consent_requested']).lender };
      openWait(s, 'lender_consent', '', e);
      break;
    }
    case 'lender_consent_received': {
      const p = e.payload as Payloads['lender_consent_received'];
      s.lenderConsent = { status: 'received', lender: p.lender, receivedAt: e.createdAt, conditions: p.conditions ?? null };
      closeWait(s, 'lender_consent', null, e);
      break;
    }
    case 'transfer_deed_executed': {
      s.deeds.transferDeedAt = e.createdAt;
      closeWait(s, 'transfer_deed', '', e);
      break;
    }
    case 'deed_of_trust_executed': {
      s.deeds.deedOfTrustAt = e.createdAt;
      break;
    }
    case 'sdlt_not_required': {
      s.sdltNotRequiredAt = e.createdAt;
      break;
    }
    case 'shadow_mode_changed': {
      s.shadowMode = (e.payload as Payloads['shadow_mode_changed']).shadowMode;
      break;
    }
    case 'action_suppressed': {
      const p = e.payload as Payloads['action_suppressed'];
      s.suppressed += 1;
      // A suppressed chase still counts as the chase attempt for the SLA clock, so shadow
      // matters produce the same chase cadence the live ones would (and don't re-fire every tick).
      if (p.action === 'chase') {
        const w = findOpenWait(s, p.detail.waitKey as WaitKey, String(p.detail.subject ?? ''));
        if (w) w.chasesSentAt.push(e.createdAt);
      }
      break;
    }
    case 'auto_clear_review_raised':
      break; // the decision itself is registered generically above; non-blocking by design
    case 'auto_clear_proposed': {
      // The decision is registered generically; the clear it holds back waits here for approval.
      const held = (e.payload as Payloads['auto_clear_proposed']).clearedEvent;
      s.pendingAutoClears[e.id] = held;
      // The thing being waited for has arrived; only the clear is held. The wait closes now so no chase goes out for it.
      const hp = (held.payload ?? {}) as { searchType?: string; enquiryId?: string };
      if (held.type === 'id_check_cleared') closeWait(s, 'id_check', (held.payload as { party?: string | null } | undefined)?.party ?? '', e);
      else if (held.type === 'search_cleared' && hp.searchType) closeWait(s, 'search', hp.searchType, e);
      else if (held.type === 'enquiry_reply_cleared' && hp.enquiryId) closeWait(s, 'enquiry', hp.enquiryId, e);
      break;
    }
    case 'action_proposed': {
      const p = e.payload as Payloads['action_proposed'];
      s.proposals[e.id] = { eventId: e.id, action: p.action, subject: p.subject ?? null, detail: p.detail, dedupKey: p.dedupKey, status: 'pending', proposedAt: e.createdAt, resolvedAt: null, resolvedBy: null, failure: null };
      break;
    }
    case 'action_approved':
    case 'action_rejected': {
      const p = e.payload as Payloads['action_approved'];
      const pr = s.proposals[p.proposalEventId];
      if (pr) { pr.status = e.type === 'action_approved' ? 'approved' : 'rejected'; pr.resolvedAt = e.createdAt; pr.resolvedBy = e.actor; }
      resolveDecision(s, p.proposalEventId, e.type === 'action_approved' ? 'approve' : 'reject', p.note, e);
      break;
    }
    case 'action_failed': {
      const p = e.payload as Payloads['action_failed'];
      const pr = s.proposals[p.proposalEventId];
      if (pr) { pr.status = 'failed'; pr.failure = p.reason; }
      break;
    }
    case 'action_retried': {
      const p = e.payload as Payloads['action_retried'];
      const pr = s.proposals[p.proposalEventId];
      if (pr) { pr.status = 'approved'; pr.failure = null; }
      break;
    }
    case 'auto_clear_confirmed': {
      const p = e.payload as Payloads['auto_clear_confirmed'];
      delete s.pendingAutoClears[p.decisionEventId];
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
      break;
    }

    // ── Decision audit ──
    case 'decision_source_opened': {
      const p = e.payload as Payloads['decision_source_opened'];
      const d = s.decisions[p.decisionEventId];
      if (d && !d.openedBy.includes(e.actor)) d.openedBy.push(e.actor);
      break;
    }
  }
  // The client's signed documents are all back: the wait on them closes.
  if ((e.type === 'signed_contract_held' || e.type === 'mortgage_deed_executed' || e.type === 'transfer_deed_executed' || e.type === 'deed_of_trust_executed') && s.signing?.packSentAt && s.signing.documents.every((d) => deedSigned(s, d))) {
    closeWait(s, 'signed_documents', '', e);
  }
  return s;
}

/** Once every further-investigation issue is closed, the survey waits on the client (unless they have already decided). */
function settleSurvey(s: MatterState): void {
  if (s.survey.status !== 'further_investigation') return;
  const open = Object.values(s.issues).some((i) => i.kind === 'survey_further_investigation' && (i.status === 'open' || i.status === 'negotiating'));
  if (!open) s.survey.status = 'awaiting_client';
}

/** Human-readable subject for a decision-bearing event (what it is about). */
function subjectOf(e: EngineEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  if (typeof p.searchType === 'string') return p.searchType;
  if (typeof p.enquiryId === 'string') return p.enquiryId;
  // A named party's ID check: the party id, so the tray and the panel say whose.
  if (e.type === 'id_check_flagged' && typeof p.party === 'string' && p.party) return p.party;
  if (typeof p.draftId === 'string') return p.draftId;
  if (e.type === 'note_extracted') return (p as Payloads['note_extracted']).noteId;
  if (e.type === 'proof_of_funds_submitted') return (p as Payloads['proof_of_funds_submitted']).requestId;
  if (typeof p.bankDetailsId === 'string') return p.bankDetailsId;
  if (e.type === 'hmlr_requisition_received') return (p as Payloads['hmlr_requisition_received']).reference ?? 'requisition';
  if (e.type === 'notice_to_complete_served') return `notice:${(p as Payloads['notice_to_complete_served']).servedBy}`;
  if (e.type === 'auto_clear_review_raised') return `${(p as Payloads['auto_clear_review_raised']).subFlow}:${(p as Payloads['auto_clear_review_raised']).subject}`;
  if (e.type === 'auto_clear_proposed') return `${(p as Payloads['auto_clear_proposed']).subFlow}:${(p as Payloads['auto_clear_proposed']).subject}`;
  if (e.type === 'action_proposed') {
    // A readable key (a wait, a search type) is worth showing; an event id is not.
    const q = p as Payloads['action_proposed'];
    return q.subject ? `${q.action}:${q.subject}` : q.action;
  }
  if (e.type === 'escalation_raised') {
    const q = p as Payloads['escalation_raised'];
    return q.waitKey ? `${q.waitKey}:${q.subject}` : q.subject || null;
  }
  return null;
}


/**
 * When an issue should be sorted by, if nobody said: the kind's window in working days from
 * the raise, but no later than the working day before the target date of what it holds.
 */
function defaultResolveBy(s: MatterState, kind: IssueKind, gate: IssueGate, raisedAt: string): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const raised = new Date(raisedAt);
  let by = day(addWorkingDays(raised, resolveWithinWorkingDays(kind)));
  const target = gate === 'exchange' ? s.targetExchangeDate : gate === 'completion' ? s.targetCompletionDate : null;
  if (target) {
    const before = day(subtractWorkingDays(new Date(`${target}T12:00:00Z`), 1));
    if (before < by && before > day(raised)) by = before;
  }
  return by;
}

/**
 * The contract pack is in when the draft contract and the title are both on file: the title alone
 * (official copies often come first) leaves the contract still to chase, and a contract that never
 * arrives can never be approved.
 */
function closePackIfIn(s: MatterState, e: EngineEvent): void {
  if (s.readiness.contractDocumentId && s.title.status !== 'awaiting') closeWait(s, 'contract_pack', '', e);
}
