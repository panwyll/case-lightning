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
  let state = initialState(tenantId, matterId);
  for (const e of events) state = applyEvent(state, e);
  return state;
}

/** Structural clone that keeps the reducer non-mutating without a dependency. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const resolvedStatus = (option: DecisionOption): DecisionState['status'] => (option === 'escalate' ? 'escalated' : 'actioned');

function openWait(state: MatterState, key: WaitKey, subject: string, e: EngineEvent): void {
  // Re-opening the same wait (e.g. a re-ordered search) closes the stale one first.
  for (const w of state.waits) if (w.key === key && w.subject === subject && w.closedAt === null) w.closedAt = e.createdAt;
  state.waits.push({ key, subject, openedAt: e.createdAt, openedBySeq: e.seq, closedAt: null, chasesSentAt: [], escalations: [] });
}

function closeWait(state: MatterState, key: WaitKey, subject: string | null, e: EngineEvent): void {
  for (const w of state.waits) {
    if (w.key === key && (subject === null || w.subject === subject) && w.closedAt === null) w.closedAt = e.createdAt;
  }
}

const findOpenWait = (state: MatterState, key: WaitKey, subject: string): WaitState | undefined =>
  state.waits.find((w) => w.key === key && w.subject === subject && w.closedAt === null);

function addDecision(state: MatterState, e: EngineEvent, spec: DecisionSpec, subject: string | null): void {
  state.decisions[e.id] = {
    ...spec,
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
export function applyEvent(prev: MatterState, e: EngineEvent): MatterState {
  const s = clone(prev);
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
      s.requiredSearches = [...p.requiredSearches];
      s.shadowMode = !!p.shadowMode;
      s.counterpartyType = p.counterpartyType ?? null;
      s.targetExchangeDate = p.targetExchangeDate ?? null;
      s.targetCompletionDate = p.targetCompletionDate ?? null;
      s.mortgage.status = p.hasLender ? 'awaiting' : 'not_required';
      s.stage = 'instruction';
      s.stageHistory = [{ stage: 'instruction', at: e.createdAt, seq: e.seq }];
      break;
    }
    case 'stage_advanced': {
      const p = e.payload as Payloads['stage_advanced'];
      s.stage = p.to;
      s.stageHistory.push({ stage: p.to, at: e.createdAt, seq: e.seq });
      break;
    }
    case 'manual_handling_required': {
      const p = e.payload as Payloads['manual_handling_required'];
      s.manualHandling = { required: true, reason: p.reason };
      break;
    }

    // ── ID / AML ──
    case 'id_check_requested': {
      s.idCheck.status = 'requested';
      s.idCheck.requestedAt = e.createdAt;
      openWait(s, 'id_check', '', e);
      break;
    }
    case 'id_check_cleared': {
      s.idCheck.status = 'cleared';
      s.idCheck.documentId = e.sourceDocumentId ?? s.idCheck.documentId;
      closeWait(s, 'id_check', null, e);
      break;
    }
    case 'id_check_flagged': {
      s.idCheck.status = 'flagged';
      s.idCheck.documentId = e.sourceDocumentId ?? s.idCheck.documentId;
      s.idCheck.decisionEventId = e.id;
      closeWait(s, 'id_check', null, e);
      break;
    }
    case 'id_check_reviewed': {
      const p = e.payload as Payloads['id_check_reviewed'];
      if (p.option !== 'escalate') s.idCheck.status = 'reviewed';
      resolveDecision(s, p.decisionEventId, p.option, p.note, e);
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
      const fromIssue = p.origin?.issueId ? s.issues[p.origin.issueId] : null;
      if (fromIssue) {
        fromIssue.enquiryIds.push(p.enquiryId);
        fromIssue.updatedAt = e.createdAt;
        fromIssue.history.push({ at: e.createdAt, by: e.actor, what: `enquiry ${p.enquiryId} raised: ${p.subject}` });
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
      s.title.facts = p.facts;
      s.title.documentId = e.sourceDocumentId ?? s.title.documentId;
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
    case 'deposit_received':
      s.deposit = { received: true, at: e.createdAt };
      break;
    case 'exchange_conditions_met':
      s.exchange.conditionsMet = true;
      break;
    case 'contracts_exchanged': {
      const p = e.payload as Payloads['contracts_exchanged'];
      s.exchange.exchangedAt = p.exchangedAt ?? e.createdAt;
      s.exchange.completionDate = p.completionDate;
      break;
    }

    // ── Completion ──
    case 'completion_statement_generated':
      s.completion.statementGeneratedAt = e.createdAt;
      break;
    case 'funds_requested': {
      const p = e.payload as Payloads['funds_requested'];
      s.completion.fundsRequestedAt = e.createdAt;
      openWait(s, 'funds', p.fromRole, e);
      break;
    }
    case 'funds_received': {
      const p = e.payload as Payloads['funds_received'];
      closeWait(s, 'funds', p.fromRole, e);
      if (!s.waits.some((w) => w.key === 'funds' && w.closedAt === null)) s.completion.fundsReceivedAt = e.createdAt;
      break;
    }
    case 'completion_confirmed': {
      const p = e.payload as Payloads['completion_confirmed'];
      s.completion.confirmedAt = p.completedAt ?? e.createdAt;
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
        n.status = p.actions.some((a) => a.command) && p.decision ? 'proposed' : 'no_actions';
        if (p.decision) n.decisionEventId = e.id;
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
      }
      break;
    }
    case 'client_update_sent': {
      s.clientUpdatesSent += 1;
      const p = e.payload as Payloads['client_update_sent'];
      if (p.template) s.clientUpdateLastSentAt[p.template] = e.createdAt;
      break;
    }
    case 'chase_sent': {
      const p = e.payload as Payloads['chase_sent'];
      s.chasesSent += 1;
      const w = findOpenWait(s, p.waitKey, p.subject);
      if (w) w.chasesSentAt.push(e.createdAt);
      break;
    }
    case 'acknowledgement_sent': {
      const p = e.payload as Payloads['acknowledgement_sent'];
      s.acknowledgements.push({ forEventId: p.forEventId, recipientRole: p.recipientRole, at: e.createdAt });
      break;
    }
    case 'escalation_raised': {
      const p = e.payload as Payloads['escalation_raised'];
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
        party: p.party ?? null,
        costPennies: null,
        paidBy: null,
        enquiryIds: [],
        severity: p.severity ?? 'warning',
        causedBy: p.causedBy ?? null,
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
      i.updatedAt = e.createdAt;
      i.history.push({ at: e.createdAt, by: e.actor, what: `${p.status}${p.gate ? ` (now holds ${p.gate === 'none' ? 'nothing' : p.gate})` : ''}${p.note ? `: ${p.note}` : ''}` });
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
      s.proofOfFunds = { ...s.proofOfFunds, status: 'submitted', requestId: p.requestId, submittedAt: e.createdAt, documentId: e.sourceDocumentId ?? null, facts: p.facts, decisionEventId: e.id, resolution: null, flags: p.flags, statements: p.statements ?? [], risk: p.risk ?? null };
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
      i.severity = p.severity;
      // Not "movement": the stale clock measures people's and third parties' activity, not the timer's.
      i.history.push({ at: e.createdAt, by: e.actor, what: `severity → ${p.severity}: ${p.reason}` });
      break;
    }
    // ── case model ──
    case 'survey_received': {
      const p = e.payload as Payloads['survey_received'];
      const further = p.facts.recommendations.some((r) => r.furtherInvestigation);
      s.survey.reports.push({ eventId: e.id, documentId: e.sourceDocumentId ?? null, surveyType: p.surveyType, receivedAt: e.createdAt, recommendations: p.facts.recommendations.length, furtherInvestigation: further, forIssueId: null });
      s.survey.status = further ? 'further_investigation' : 'awaiting_client';
      break;
    }
    case 'specialist_report_received': {
      const p = e.payload as Payloads['specialist_report_received'];
      s.survey.reports.push({ eventId: e.id, documentId: e.sourceDocumentId ?? null, surveyType: p.facts.surveyType, receivedAt: e.createdAt, recommendations: p.facts.recommendations.length, furtherInvestigation: p.furtherInvestigation, forIssueId: p.forIssueId });
      // The status settles once the issues this event resolves / raises are applied (settleSurvey on issue_resolved / withdrawn).
      if (p.furtherInvestigation) s.survey.status = 'further_investigation';
      break;
    }
    case 'client_decision_recorded': {
      const p = e.payload as Payloads['client_decision_recorded'];
      s.clientDecisions[p.subject] = { decision: p.decision, at: e.createdAt, by: e.actor, note: p.note ?? null };
      if (p.subject === 'physical_condition') s.survey.status = p.decision === 'satisfied' ? 'client_satisfied' : p.decision === 'renegotiate' ? 'client_renegotiating' : p.decision === 'withdraw' ? 'client_withdrawing' : 'further_investigation';
      break;
    }
    case 'matter_closed': {
      s.closedAt = e.createdAt;
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
      closeWait(s, 'discharge', null, e);
      break;
    }
    case 'mortgage_deed_executed': {
      s.deeds.mortgageDeedAt = e.createdAt;
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
      s.pendingAutoClears[e.id] = (e.payload as Payloads['auto_clear_proposed']).clearedEvent;
      break;
    }
    case 'action_proposed': {
      const p = e.payload as Payloads['action_proposed'];
      s.proposals[e.id] = { eventId: e.id, action: p.action, detail: p.detail, dedupKey: p.dedupKey, status: 'pending', proposedAt: e.createdAt, resolvedAt: null, resolvedBy: null, failure: null };
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
    return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(q.dedupKey) || /:[0-9a-f]{8}-/i.test(q.dedupKey) ? q.action : `${q.action}:${q.dedupKey}`;
  }
  if (e.type === 'escalation_raised') {
    const q = p as Payloads['escalation_raised'];
    return q.waitKey ? `${q.waitKey}:${q.subject}` : q.subject || null;
  }
  return null;
}
