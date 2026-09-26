/**
 * EngineService — the orchestration layer around the pure machine.
 *
 *   command ──► lock matter ──► load log ──► project ──► decide ──► append ──► commit
 *                                                                           │
 *                              post-commit EFFECTS (best-effort I/O via ports) ◄┘
 *                              → each effect's outcome comes back as a further command
 *
 * The rule: I/O happens OUTSIDE the machine and BEFORE the event that records it. A
 * search is `search_ordered` only after the provider accepted; a chase is `chase_sent`
 * only after the chaser sent it; a report is `report_on_title_sent` only after the
 * comms port sent it — and never without an approval event (assertCanSendReport).
 * Effect failures are logged, never thrown, and never stall the matter: the next tick
 * or a manual-fallback command picks them up.
 *
 * Addendum 3 §2 — shadow mode. On a shadow-mode matter, or for a sub-flow the tenant
 * still has in `shadow`, every outbound action (search order, ID-check request, client
 * update, chase, report send, linked-enquiry delivery) is NOT performed: the intent is
 * recorded as an `action_suppressed` event instead, so the comparison view can show
 * what the engine would have done. Decisions are still created (they are the engine's
 * conclusions) but the machine refuses to open or resolve them, and the store never
 * lists them to a person. The real `matter.stage` is not touched (store.ts).
 *
 * Addendum 3 §1 — effects and timers run under ports.asAutomation, which in production
 * puts the connection on the conveyi_automation role: the database refuses human-gated
 * events from there whatever this code does.
 */
import { caseBrief } from './brief';
import { decide, assertCanSendReport, type Command } from './machine';
import { project } from './projection';
import { dueActions, deadlineActions, timedIssueActions, type SlaConfig } from './sla';
import { addWorkingDays } from './working-days';
import { EXTERNAL, SYSTEM, DEFAULT_LEVELS, type BankDetails, type DecisionOption, type EngineEvent, type Engagement, type EnquiryReplyFacts, type EventType, type MatterState, type PayeeKind, type SearchFacts, type SearchType, type SourceChannel, type SubFlow, type LevelConfig, type EngineAction, type NoteKind, actsUnasked, levelFor, pendingProposal } from './types';
import type { DocumentRef, EnginePorts } from './ports';

/** A rejected proposal keeps the same action quiet for this long, so the timer does not re-ask daily. */
const REJECTED_QUIET_MS = 5 * 86_400_000;

/** What gets acknowledged, to whom, in their words. Anything not here is not a delivery from a party. */
const ACKNOWLEDGE: Partial<Record<EventType, { recipient: 'seller_solicitor' | 'client'; what: string }>> = {
  enquiry_reply_received: { recipient: 'seller_solicitor', what: 'your replies to our enquiries' },
  buyer_enquiries_received: { recipient: 'seller_solicitor', what: 'your enquiries' },
  survey_received: { recipient: 'client', what: 'the survey report' },
  specialist_report_received: { recipient: 'client', what: 'the specialist report' },
  property_forms_received: { recipient: 'client', what: 'your completed property forms' },
  proof_of_funds_submitted: { recipient: 'client', what: 'your proof of funds form' },
  mortgage_offer_received: { recipient: 'client', what: 'your mortgage offer' },
};
/** One acknowledgement per party per delivery, not one per attachment. */
const ACK_WINDOW_MS = 4 * 60 * 60 * 1000;
import type { EventStore } from './store';
import { evaluateSearch, evaluateEnquiryReply, evaluateMortgageOffer, evaluateTitle, evaluateIdCheck } from './rules';
import { evaluateProofOfFunds, factsFromSubmission, renderDeclaration, reviewTransactions, type EvidenceDocument, type ProofOfFundsSubmission } from './proof-of-funds';
import { openPofQueries } from './types';

export interface RunResult {
  events: EngineEvent[];
  state: MatterState;
  /** The command was recorded, but a side effect (a send, an order) did not happen. Shown to the person; never swallowed. */
  warning?: string;
}

/** Client status updates fired automatically by event (the safe half of #5). Template names only; the port renders. */
const CLIENT_UPDATE_TEMPLATES: Partial<Record<EventType, string>> = {
  search_ordered: 'searches_ordered',
  search_cleared: 'search_back_all_clear',
  search_flagged: 'search_back_under_review',
  enquiry_raised: 'enquiries_raised',
  mortgage_offer_cleared: 'mortgage_offer_checked',
  report_on_title_sent: 'report_on_title_sent',
  contracts_exchanged: 'exchanged',
  completion_confirmed: 'completed',
  ap1_confirmed: 'registration_complete',
};

/** Which sub-flow an automatic client update belongs to (null → only matter-level shadow suppresses it). */
export class EngineService {
  constructor(
    private store: EventStore,
    private ports: EnginePorts
  ) {}

  // ───────────── core ─────────────

  /** Run one command atomically, then its effects. */
  async run(tenantId: string, matterId: string, cmd: Command): Promise<RunResult> {
    const subflows = await this.levels(tenantId);
    const result = await this.store.withMatterLock(tenantId, matterId, async (tx) => {
      const log = await tx.load();
      const state = project(tenantId, matterId, log);
      const now = this.ports.now();
      const { events } = decide(state, cmd, { now, levels: subflows });
      const appended = await tx.append(events, state.lastSeq, now, this.ports.newId);
      const next = project(tenantId, matterId, [...log, ...appended]);
      await tx.afterAppend(next, appended);
      return { events: appended, state: next };
    });
    await this.asAutomation(() => this.effects(tenantId, matterId, result.events, result.state, subflows));
    await this.asAutomation(() => this.acknowledge(tenantId, matterId, result.events, result.state, subflows));
    if (this.ports.onEvents && result.events.length) {
      const latest = await this.getState(tenantId, matterId).catch(() => result.state);
      await this.asAutomation(() => this.ports.onEvents!({ tenantId, matterId, events: result.events, state: latest })).catch((err) => this.ports.log('post-commit observer failed', err));
    }
    return result;
  }

  /**
   * Acknowledgements. Something arrived from the other side or the client; they hear that
   * it did, at once, so they never write to ask. One per item, and never twice to the same
   * party inside a few hours (their five attachments are one delivery, not five). Shadow
   * mode logs the intent instead.
   */
  private async acknowledge(tenantId: string, matterId: string, events: EngineEvent[], state: MatterState, subflows: LevelConfig): Promise<void> {
    for (const e of events) {
      const rule = ACKNOWLEDGE[e.type];
      if (!rule) continue;
      try {
        const current = await this.getState(tenantId, matterId);
        if (current.acknowledgements.some((a) => a.forEventId === e.id)) continue;
        const recent = current.acknowledgements.some((a) => a.recipientRole === rule.recipient && this.ports.now().getTime() - new Date(a.at).getTime() < ACK_WINDOW_MS);
        if (recent) continue;
        const detail = { forEventId: e.id, forEventType: e.type, recipientRole: rule.recipient, what: rule.what };
        if (await this.proposeUnless(tenantId, matterId, subflows, 'acknowledgement', rule.recipient, e.id, detail, `ACKNOWLEDGEMENT\n\nTo: ${rule.recipient.replace(/_/g, ' ')}\nWhat: ${rule.what}\nFor: ${e.type.replace(/_/g, ' ')} received ${e.createdAt}\n\nA short note that it arrived, so they do not write to ask.`)) continue;
        await this.perform(tenantId, matterId, 'acknowledgement', detail);
      } catch (err) {
        this.ports.log(`acknowledgement failed (${e.type})`, err);
      }
    }
  }

  /** The tenant's trust level per engine action (docs/conveyance-engine.md §2). Missing rows are propose. */
  async levels(tenantId: string): Promise<LevelConfig> {
    return this.store.loadLevels ? this.store.loadLevels(tenantId) : { ...DEFAULT_LEVELS };
  }

  private asAutomation<T>(fn: () => Promise<T>): Promise<T> {
    return this.ports.asAutomation ? this.ports.asAutomation(fn) : fn();
  }

  /**
   * The trust gate. Returns false when the action may go ahead now. Otherwise it is put
   * in front of a person as a proposal (a decision in Tasks citing a generated dossier
   * of exactly what would be done) and true is returned: the caller does nothing. One
   * proposal per key at a time; a rejection keeps the same key quiet for a few days so
   * the timer does not nag.
   */
  private async proposeUnless(tenantId: string, matterId: string, levels: LevelConfig, action: EngineAction, subject: string | null, dedupKey: string, detail: Record<string, unknown>, summary: string): Promise<boolean> {
    if (actsUnasked(levelFor(levels, action, subject), action)) return false;
    const state = await this.getState(tenantId, matterId);
    if (pendingProposal(state, action, dedupKey)) return true;
    const quietUntil = this.ports.now().getTime() - REJECTED_QUIET_MS;
    if (Object.values(state.proposals).some((p) => p.action === action && p.dedupKey === dedupKey && p.status === 'rejected' && new Date(p.resolvedAt ?? p.proposedAt).getTime() > quietUntil)) return true;
    const doc = await this.ports.documents.createGenerated({
      tenantId,
      matterId,
      docType: 'PROPOSAL',
      fileName: `proposal-${action}-${dedupKey.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${this.ports.now().toISOString().slice(0, 10)}.txt`,
      content: summary,
    });
    await this.run(tenantId, matterId, { type: 'propose_action', action, subject, detail, dedupKey, summary, sourceDocumentId: doc.id });
    return true;
  }

  /** Do what a person approved. The same code the assist/auto path runs; only the gate differs. */
  private async perform(tenantId: string, matterId: string, action: EngineAction, detail: Record<string, unknown>): Promise<void> {
    if (action === 'acknowledgement') {
      const d = detail as { forEventId: string; forEventType: EventType; recipientRole: string; what: string };
      const sent = await this.ports.chaser.sendAcknowledgement({ tenantId, matterId, recipientRole: d.recipientRole as never, what: d.what, forEventType: d.forEventType });
      if (!sent) return;
      await this.run(tenantId, matterId, { type: 'record_acknowledgement', ack: { forEventId: d.forEventId, forEventType: d.forEventType, recipientRole: d.recipientRole as never, what: d.what, channel: sent.channel, messageId: sent.messageId } });
    } else if (action === 'chase') {
      const d = detail as { waitKey: string; subject: string; recipientRole: string; template: string; context: Record<string, unknown> };
      const sent = await this.ports.chaser.sendChase({ tenantId, matterId, recipientRole: d.recipientRole as never, template: d.template, context: d.context });
      await this.run(tenantId, matterId, { type: 'record_chase', chase: { waitKey: d.waitKey as never, subject: d.subject, recipientRole: d.recipientRole as never, template: d.template, channel: sent.channel, messageId: sent.messageId } });
    } else if (action === 'client_update') {
      const d = detail as { template: string; context: Record<string, unknown>; triggeredByEventId: string; agentTemplate?: string | null };
      const sent = await this.ports.clientComms.sendStatusUpdate({ tenantId, matterId, template: d.template, context: d.context });
      await this.run(tenantId, matterId, { type: 'record_client_update', update: { template: d.template, recipientRole: 'client', channel: sent.channel, messageId: sent.messageId, triggeredByEventId: d.triggeredByEventId } });
      if (d.agentTemplate) {
        const agent = await this.ports.chaser.sendPartyNotice({ tenantId, matterId, recipientRole: 'estate_agent', template: d.agentTemplate, context: d.context }).catch((err) => { this.ports.log('agent notice failed', err); return null; });
        if (agent) await this.run(tenantId, matterId, { type: 'record_client_update', update: { template: d.agentTemplate, recipientRole: 'estate_agent', channel: agent.channel, messageId: agent.messageId, triggeredByEventId: d.triggeredByEventId } });
      }
    } else if (action === 'search_order') {
      const d = detail as { searchType: SearchType };
      const { reference } = await this.ports.searchProvider.orderSearch({ tenantId, matterId, searchType: d.searchType });
      await this.run(tenantId, matterId, { type: 'record_search_ordered', actor: SYSTEM, searchType: d.searchType, provider: this.ports.searchProvider.name, reference });
    }
  }

  /** Addendum 3 §2: switch shadow mode for one matter (people only; logged). Mirrors to matter.shadow_mode via the store. */
  async setShadowMode(tenantId: string, matterId: string, actor: string, shadowMode: boolean, reason?: string | null): Promise<RunResult> {
    return this.run(tenantId, matterId, { type: 'set_shadow_mode', actor, shadowMode, reason: reason ?? null });
  }

  async getState(tenantId: string, matterId: string): Promise<MatterState> {
    return project(tenantId, matterId, await this.store.listEvents(tenantId, matterId));
  }

  async listEvents(tenantId: string, matterId: string, opts?: { afterSeq?: number; limit?: number }): Promise<EngineEvent[]> {
    return this.store.listEvents(tenantId, matterId, opts);
  }

  get eventStore(): EventStore {
    return this.store;
  }

  /** A document on this matter (null if not found / not on this matter). Read-only; logs nothing. */
  async getDocument(tenantId: string, matterId: string, documentId: string): Promise<DocumentRef | null> {
    const doc = await this.ports.documents.get(tenantId, documentId);
    return doc && doc.matterId === matterId ? doc : null;
  }

  // ───────────── sub-flows (external wait → extraction → rule → clear/flag) ─────────────

  /** ID/AML: ask the provider, then record the request. */
  async requestIdCheck(tenantId: string, matterId: string, actor: string): Promise<RunResult> {
    // A person asked for this: their click is the approval, whatever the trust levels say.
    const { reference } = await this.ports.idCheckProvider.requestCheck({ tenantId, matterId });
    return this.run(tenantId, matterId, { type: 'request_id_check', actor, provider: this.ports.idCheckProvider.name, reference });
  }

  // ───────────── proof of funds (docs/proof-of-funds.md) ─────────────

  /**
   * Issue the form (tokenised link), send it to the client, record the request. In shadow
   * the intent is logged and the wait still opens (so the SLA clock is observable), but no
   * link is issued and nothing is sent.
   */
  async requestProofOfFunds(tenantId: string, matterId: string, actor: string, opts: { noteToClient?: string | null; followUpOf?: string | null } = {}): Promise<RunResult> {
    if (!this.ports.pofForms) throw Object.assign(new Error('Proof-of-funds forms are not configured on this deployment.'), { status: 501 });
    const state = await this.getState(tenantId, matterId);
    const form = await this.ports.pofForms.create({ tenantId, matterId, requestedBy: actor, followUpOf: opts.followUpOf ?? null, noteToClient: opts.noteToClient ?? null });
    // Drafted queries go out with this round; the client answers them in the form.
    const queryIds = openPofQueries(state).filter((q) => q.status === 'draft').map((q) => q.id);
    const template = opts.followUpOf ? 'proof_of_funds_request_again' : 'proof_of_funds_request';
    // The form exists whether or not the message gets out. A send failure (no client email on
    // the case, the mailbox not connected, a provider down) must not lose the request: record
    // it as unsent with the reason and the link, so the conveyancer can send it themselves.
    let sent: { channel: string; messageId: string | null };
    let sendError: string | null = null;
    try {
      sent = await this.ports.clientComms.sendStatusUpdate({ tenantId, matterId, template, context: { formUrl: form.formUrl, noteToClient: opts.noteToClient ?? '', requestId: form.requestId, queryCount: queryIds.length } });
    } catch (err) {
      sendError = (err instanceof Error ? err.message : String(err)).trim().replace(/[.!]*$/, '.');
      this.ports.log('proof-of-funds form could not be sent; recorded as unsent', err);
      sent = { channel: 'unsent', messageId: null };
    }
    const result = await this.run(tenantId, matterId, { type: 'request_proof_of_funds', actor, requestId: form.requestId, channel: sent.channel, messageId: sent.messageId, formUrl: form.formUrl, sendError, followUpOf: opts.followUpOf ?? null, noteToClient: opts.noteToClient ?? null, queryIds });
    return sendError ? { ...result, warning: `Recorded, but the form was not sent: ${sendError}` } : result;
  }

  /**
   * The client submitted the form: facts → rules → the declaration document (what the
   * decision cites) → the briefing (AI if configured and valid, else the template) → the
   * decision for the conveyancer. `evidenceNames` labels the attached documents in the
   * declaration so the reader sees file names, not ids.
   */
  async proofOfFundsSubmitted(tenantId: string, matterId: string, requestId: string, submission: ProofOfFundsSubmission, evidenceNames: Record<string, string> = {}): Promise<RunResult> {
    const state = await this.getState(tenantId, matterId);
    const sub: ProofOfFundsSubmission = { ...submission, round: submission.round ?? state.proofOfFunds.rounds ?? 1 };
    const facts = factsFromSubmission(requestId, sub, state.purchasePricePennies);
    // Read every attached document: statements transaction by transaction (the regulations want the
    // statements scrutinised, not filed). Answers' evidence counts too. Unreadable ones become a flag.
    const evidence: EvidenceDocument[] = [];
    const seen = new Set<string>();
    const attach = async (id: string, sourceIndex: number | null, donorFor: number | null) => {
      if (seen.has(id)) return;
      seen.add(id);
      const ref = await this.ports.documents.get(tenantId, id).catch(() => null);
      if (!ref || ref.matterId !== matterId) return;
      const fileName = evidenceNames[id] ?? ref.fileName ?? null;
      try {
        const statement = await this.ports.extractor.extractStatement(ref);
        evidence.push({ id, fileName, sourceIndex, donorFor, statement, unreadable: null });
      } catch (err) {
        this.ports.log(`statement extraction failed for ${id} — flagged for a person`, err);
        evidence.push({ id, fileName, sourceIndex, donorFor, statement: null, unreadable: err instanceof Error ? err.message : 'unreadable' });
      }
    };
    for (const [i, src] of sub.sources.entries()) {
      for (const id of src.evidenceDocumentIds) await attach(id, i + 1, null);
      for (const id of src.gift?.donorEvidenceDocumentIds ?? []) await attach(id, null, i + 1);
    }
    for (const a of sub.answers ?? []) for (const id of a.evidenceDocumentIds) await attach(id, null, null);
    const review = reviewTransactions(facts, evidence, sub.submittedAt);
    const declaration = renderDeclaration(facts, sub, evidenceNames);
    const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'PROOF_OF_FUNDS_DECLARATION', fileName: `proof-of-funds-${requestId}-round-${facts.round}.txt`, content: declaration });
    const verdict = evaluateProofOfFunds(facts);
    const flags = [...(verdict.outcome === 'flag' ? verdict.flags : []), ...review.flags];
    let summary = null;
    if (this.ports.pofSummariser) {
      try {
        summary = await this.ports.pofSummariser.summarise({ facts, flags, source: doc, state, review, answers: sub.answers ?? [] });
      } catch (err) {
        this.ports.log('proof-of-funds summariser failed — using the template briefing', err);
      }
    }
    return this.run(tenantId, matterId, { type: 'proof_of_funds_submitted', actor: EXTERNAL, requestId, documentId: doc.id, facts, review, answers: sub.answers ?? null, summary });
  }

  // ───────────── the survey workstream (docs/case-model.md §7) ─────────────

  /** The client's survey / valuation arrived: read for its recommendations; each "further investigation" becomes an issue. */
  async surveyReceived(tenantId: string, matterId: string, documentId: string, surveyType: import('./types').SurveyType | null = null): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts = await this.ports.extractor.extractSurvey(doc).catch((err) => {
      this.ports.log('survey extraction failed — recorded with no recommendations read; a person must read it', err);
      return { surveyType: surveyType ?? 'level2', recommendations: [{ code: 'UNREAD', text: 'The report could not be read automatically; a person must read it and record the recommendations.', furtherInvestigation: true, severity: 'medium' as const }], confidence: 0 } satisfies import('./types').SurveyFacts;
    });
    return this.run(tenantId, matterId, { type: 'survey_received', actor: EXTERNAL, documentId, surveyType: surveyType ?? facts.surveyType, facts, extractor: this.ports.extractor.name });
  }

  /** A specialist's report arrived (for a further-investigation issue when it can be linked): read; the machine records the facts. */
  async specialistReportReceived(tenantId: string, matterId: string, documentId: string, forIssueId: string | null = null): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts = await this.ports.extractor.extractSurvey(doc).catch((err) => {
      this.ports.log('specialist report extraction failed — recorded as recommending further investigation until a person reads it', err);
      return { surveyType: 'specialist' as const, recommendations: [{ code: 'UNREAD', text: 'The report could not be read automatically; a person must read it.', furtherInvestigation: true, severity: 'medium' as const }], confidence: 0 } satisfies import('./types').SurveyFacts;
    });
    return this.run(tenantId, matterId, { type: 'specialist_report_received', actor: EXTERNAL, documentId, facts: { ...facts, surveyType: 'specialist' }, forIssueId, extractor: this.ports.extractor.name });
  }

  // ───────────── leasehold ─────────────

  /** The management pack (LPE1) arrived: always a decision citing it (extraction is optional and best-effort). */
  async managementPackReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts = (doc.extractedFacts && typeof doc.extractedFacts === 'object' && 'flags' in (doc.extractedFacts as object) ? (doc.extractedFacts as import('./types').ManagementPackFacts) : null);
    return this.run(tenantId, matterId, { type: 'management_pack_received', actor: EXTERNAL, documentId, facts });
  }

  /** ID/AML result landed (webhook / upload): extract → rule → cleared or flagged. */
  async idCheckResultReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts = await this.ports.extractor.extractIdCheck(doc).catch((err) => {
      this.ports.log('id check extraction failed — routing to human', err);
      return { provider: 'unknown', outcome: 'refer' as const, flags: [], confidence: 0 };
    });
    const summary = await this.summarise('id_check', `ID/AML check (${facts.provider})`, evaluateIdCheck(facts), doc, tenantId, matterId);
    return this.run(tenantId, matterId, { type: 'id_check_result', actor: EXTERNAL, documentId, facts, summary });
  }

  /** Spec 2.4 steps 3–5: a search PDF is back. Record it, extract, rule-check, clear or flag. */
  async searchReturned(tenantId: string, matterId: string, searchType: SearchType, documentId: string, provider?: string | null): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    await this.run(tenantId, matterId, { type: 'search_returned', actor: EXTERNAL, searchType, documentId, provider: provider ?? null });
    const facts: SearchFacts = await this.ports.extractor.extractSearch(doc, searchType).catch((err) => {
      // Extraction failed → confidence 0 → the rule layer flags it. Never guess, never stall.
      this.ports.log(`search extraction failed for ${searchType} — routing to human`, err);
      return { searchType, flags: [], confidence: 0 };
    });
    const summary = await this.summarise('search', `${searchType} search`, evaluateSearch(facts), doc, tenantId, matterId);
    return this.run(tenantId, matterId, { type: 'search_extracted', actor: SYSTEM, searchType, facts, extractor: this.ports.extractor.name, summary });
  }

  async enquiryReplyReceived(tenantId: string, matterId: string, enquiryId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts: EnquiryReplyFacts | null = await this.ports.extractor.extractEnquiryReply(doc, enquiryId).catch((err) => {
      this.ports.log(`enquiry reply extraction failed for ${enquiryId} — routing to human`, err);
      return null;
    });
    const state = await this.getState(tenantId, matterId);
    const subject = state.enquiries[enquiryId]?.subject ?? enquiryId;
    const summary = await this.summarise('enquiry', `Reply to enquiry ${enquiryId} (${subject})`, evaluateEnquiryReply(facts), doc, tenantId, matterId);
    return this.run(tenantId, matterId, { type: 'enquiry_reply_received', actor: EXTERNAL, enquiryId, documentId, facts, summary });
  }

  async mortgageOfferReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    await this.run(tenantId, matterId, { type: 'mortgage_offer_received', actor: EXTERNAL, documentId });
    const facts = await this.ports.extractor.extractMortgageOffer(doc).catch((err) => {
      this.ports.log('mortgage offer extraction failed — routing to human', err);
      return { lender: 'unknown', conditions: [], confidence: 0 };
    });
    const state = await this.getState(tenantId, matterId);
    const summary = await this.summarise('mortgage', `Mortgage offer (${facts.lender})`, evaluateMortgageOffer(facts, state.targetExchangeDate, this.ports.now()), doc, tenantId, matterId);
    return this.run(tenantId, matterId, { type: 'mortgage_offer_extracted', actor: SYSTEM, facts, extractor: this.ports.extractor.name, summary });
  }

  async titleReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts = await this.ports.extractor.extractTitle(doc).catch((err) => {
      this.ports.log('title extraction failed — routing to human', err);
      return { titleNumber: 'unknown', tenure: 'unknown' as const, restrictions: [], charges: [], covenants: [], confidence: 0 };
    });
    const summary = await this.summarise('title', `Title ${facts.titleNumber}`, evaluateTitle(facts), doc, tenantId, matterId);
    return this.run(tenantId, matterId, { type: 'title_extracted', actor: SYSTEM, documentId, facts, extractor: this.ports.extractor.name, summary });
  }

  /**
   * File a note or a call transcript on the matter, then read it (docs/intake.md).
   *
   * Two steps on purpose: the note is on the log as evidence the moment it is filed, even
   * if the reading fails or there is no extractor configured. Nothing it proposes touches
   * the case until a person approves the decision this raises.
   */
  async recordNote(
    tenantId: string,
    matterId: string,
    input: { text: string; kind: NoteKind; actor: string; documentId?: string | null; durationSeconds?: number | null; noteId?: string | null }
  ): Promise<RunResult> {
    // A decision has to cite something a person can open. A note filed without a document
    // behind it (typed straight into the matter) becomes one — the note IS the evidence.
    let documentId = input.documentId ?? null;
    if (!documentId) {
      const stamp = this.ports.now().toISOString().slice(0, 16).replace('T', ' ');
      documentId = await this.ports.documents
        .createGenerated({ tenantId, matterId, docType: 'FILE_NOTE', fileName: `${input.kind === 'call' ? 'Call note' : 'File note'} — ${stamp}.txt`, content: input.text, createdBy: input.actor })
        .then((d) => d.id)
        .catch((err) => {
          this.ports.log('the note could not be filed as a document — it is still on the log', err);
          return null;
        });
    }
    const recorded = await this.run(tenantId, matterId, {
      type: 'record_note',
      actor: input.actor,
      kind: input.kind,
      text: input.text,
      noteId: input.noteId ?? null,
      documentId,
      durationSeconds: input.durationSeconds ?? null,
    });
    const noteId = (recorded.events[0]?.payload as { noteId?: string } | undefined)?.noteId;
    const reader = this.ports.noteExtractor;
    if (!noteId || !reader) return recorded;
    const brief = caseBrief(recorded.state, this.ports.now());
    const drafts = await reader
      .extract({ tenantId, matterId, text: input.text, kind: input.kind, caseLine: `${brief.transactionLabel}, ${brief.lifecycleLabel.toLowerCase()}` })
      .catch((err) => {
        this.ports.log('note extraction failed — the note is still on the file', err);
        return [];
      });
    if (!drafts.length) return recorded;
    return this.run(tenantId, matterId, { type: 'note_extracted', noteId, drafts, extractor: reader.name });
  }

  // ───────────── decisions (dashboard #6) ─────────────

  /** The handler opened the source. Logged, and a precondition of resolving. Returns the document so the UI can show it. */
  async openDecisionSource(tenantId: string, matterId: string, decisionEventId: string, userId: string, documentId?: string | null): Promise<{ document: DocumentRef; result: RunResult }> {
    const state = await this.getState(tenantId, matterId);
    const d = state.decisions[decisionEventId];
    const docId = documentId ?? d?.sourceDocumentId;
    if (!docId) throw Object.assign(new Error('Decision not found.'), { status: 404 });
    const document = await this.requireDoc(tenantId, matterId, docId);
    const result = await this.run(tenantId, matterId, { type: 'open_decision_source', userId, decisionEventId, documentId: docId });
    return { document, result };
  }

  async resolveDecision(tenantId: string, matterId: string, decisionEventId: string, userId: string, option: DecisionOption, note?: string | null, verification?: { method: string; reference?: string | null } | null, engagement?: Engagement | null, selection?: string[] | null): Promise<RunResult> {
    return this.run(tenantId, matterId, { type: 'resolve_decision', userId, decisionEventId, option, note: note ?? null, verification: verification ?? null, engagement: engagement ?? null, selection: selection ?? null });
  }

  /**
   * Addendum 2: bank details arrive (email, portal, phone note, letter…). The source is the
   * document they arrived on; a manually keyed set gets a generated note as its source so
   * the decision still cites something. Always a hard-stop decision, first time included.
   */
  async recordBankDetails(tenantId: string, matterId: string, input: { actor: string; payeeKind: PayeeKind; payeeRef?: string | null; details: BankDetails; sourceChannel: SourceChannel; sourceDocumentId?: string | null; note?: string | null }): Promise<RunResult> {
    let sourceDocumentId = input.sourceDocumentId ?? null;
    if (!sourceDocumentId) {
      const doc = await this.ports.documents.createGenerated({
        tenantId,
        matterId,
        docType: 'BANK_DETAILS_NOTE',
        fileName: `bank-details-${input.payeeKind}-${this.ports.now().toISOString().slice(0, 10)}.txt`,
        content: [`Bank details recorded manually (${input.sourceChannel}) by ${input.actor} on ${this.ports.now().toISOString()}`, `Payee: ${input.payeeKind}${input.payeeRef ? ` — ${input.payeeRef}` : ''}`, `Account name: ${input.details.accountName}`, `Sort code: ${input.details.sortCode}  Account: ${input.details.accountNumber}`, input.details.firmName ? `Firm: ${input.details.firmName}` : '', input.note ? `Note: ${input.note}` : ''].filter(Boolean).join('\n'),
      });
      sourceDocumentId = doc.id;
    }
    return this.run(tenantId, matterId, { type: 'record_bank_details', actor: input.actor, bankDetailsId: `bd-${this.ports.newId()}`, payeeKind: input.payeeKind, payeeRef: input.payeeRef ?? null, details: input.details, sourceChannel: input.sourceChannel, sourceDocumentId });
  }

  // ───────────── report on title (AI-drafting-heavy; never auto-sent) ─────────────

  async draftReportOnTitle(tenantId: string, matterId: string): Promise<RunResult> {
    const state = await this.getState(tenantId, matterId);
    const docIds = new Set<string>();
    for (const sr of Object.values(state.searches)) if (sr.documentId) docIds.add(sr.documentId);
    for (const q of Object.values(state.enquiries)) if (q.documentId) docIds.add(q.documentId);
    if (state.title.documentId) docIds.add(state.title.documentId);
    if (state.mortgage.documentId) docIds.add(state.mortgage.documentId);
    const documents = (await Promise.all([...docIds].map((id) => this.ports.documents.get(tenantId, id)))).filter((d): d is DocumentRef => !!d);
    const draft = await this.ports.reportDrafter.draft({ state, documents });
    const draftId = `rot-${this.ports.newId()}`;
    const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'REPORT_ON_TITLE_DRAFT', fileName: `${draftId}.txt`, content: draft.content });
    return this.run(tenantId, matterId, { type: 'draft_report_on_title', draftId, draftDocumentId: doc.id, model: draft.model, summary: draft.summary, citations: draft.citations, basedOn: draft.basedOn });
  }

  /** Send the APPROVED report. The machine's invariant is checked before any I/O and again when recording. */
  async sendReportOnTitle(tenantId: string, matterId: string, actor: string): Promise<RunResult> {
    const state = await this.getState(tenantId, matterId);
    const draftId = state.reportOnTitle.draftId ?? '';
    assertCanSendReport(state, draftId);
    const doc = await this.requireDoc(tenantId, matterId, state.reportOnTitle.draftDocumentId as string);
    const sent = await this.ports.clientComms.sendReportOnTitle({ tenantId, matterId, draftDocument: doc });
    return this.run(tenantId, matterId, { type: 'record_report_on_title_sent', actor, draftId, channel: sent.channel, messageId: sent.messageId });
  }

  // ───────────── timers (2.6) ─────────────

  /** One matter's timer sweep: send due chases, raise due escalations. */
  async tick(tenantId: string, matterId: string, now = this.ports.now()): Promise<{ chases: number; escalations: number }> {
    return this.asAutomation(() => this.tickInner(tenantId, matterId, now));
  }

  private async tickInner(tenantId: string, matterId: string, now: Date): Promise<{ chases: number; escalations: number }> {
    let state = await this.getState(tenantId, matterId);
    if (!state.enrolled || state.manualHandling.required || state.abandoned || state.closedAt) return { chases: 0, escalations: 0 };
    const sla = await this.store.loadSla(tenantId);
    const subflows = await this.levels(tenantId);
    let chases = 0;
    let escalations = 0;
    // Time as a source of events (docs/case-model.md §6): offer expiry, aged waits, sitting issues — first, so the deadlines below see the result.
    let timed = 0;
    for (const t of timedIssueActions(state, now)) {
      try {
        if (t.kind === 'raise') await this.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: t.issueKind, title: t.title, detail: t.detail, severity: t.severity });
        else if (t.kind === 'escalate') await this.run(tenantId, matterId, { type: 'set_issue_severity', actor: SYSTEM, issueId: t.issueId, severity: t.severity, reason: t.reason });
        else if (t.kind === 'resolve') await this.run(tenantId, matterId, { type: 'resolve_issue', actor: SYSTEM, issueId: t.issueId, resolution: t.resolution, note: t.note });
        else if (t.kind === 'offer_expired' && (state.mortgage.status === 'cleared' || state.mortgage.status === 'reviewed')) await this.run(tenantId, matterId, { type: 'mortgage_offer_withdrawn', actor: SYSTEM, reason: `Offer expired on ${t.expiryDate} (timer)` });
        timed += 1;
      } catch (err) {
        this.ports.log(`timed issue failed (${t.kind})`, err);
      }
    }
    if (timed) state = await this.getState(tenantId, matterId);
    // Deadlines we owe (offer expiry, SDLT, notice to complete, requisitions): raised once, in time, with a dossier.
    for (const d of deadlineActions(state, now)) {
      try {
        const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'DEADLINE_DOSSIER', fileName: `deadline-${d.kind}-${d.dueDate}.txt`, content: [`DEADLINE — ${d.kind.replace(/_/g, ' ').toUpperCase()}`, `Due: ${d.dueDate}`, `Working days left: ${d.workingDaysLeft}`, `Stage: ${state.stage}`, '', d.summary].join('\n') });
        await this.run(tenantId, matterId, { type: 'raise_deadline_escalation', kind: d.kind, dueDate: d.dueDate, subject: d.subject, summary: d.summary, sourceDocumentId: doc.id });
        escalations += 1;
      } catch (err) {
        this.ports.log(`deadline escalation failed (${d.kind} ${d.dueDate})`, err);
      }
    }
    for (const a of dueActions(state, now, sla)) {
      try {
        if (a.kind === 'chase') {
          const context = { waitKey: a.wait.key, subject: a.wait.subject, openedAt: a.wait.openedAt, ageWorkingDays: a.ageWorkingDays, priorChases: a.wait.chasesSentAt.length };
          const detail = { waitKey: a.wait.key, subject: a.wait.subject, recipientRole: a.rule.recipientRole, template: a.rule.template, context };
          const summary = `CHASE\n\nTo: ${a.rule.recipientRole.replace(/_/g, ' ')}\nAbout: ${a.wait.key.replace(/_/g, ' ')}${a.wait.subject ? ` ${a.wait.subject}` : ''}\nWaiting since: ${a.wait.openedAt.slice(0, 10)} (${a.ageWorkingDays} working days)\nPrevious chases: ${a.wait.chasesSentAt.length}\nTemplate: ${a.rule.template}\n\nA polite reminder asking for what is outstanding, in the firm's standard wording.`;
          if (await this.proposeUnless(tenantId, matterId, subflows, 'chase', a.rule.recipientRole, `${a.wait.key}:${a.wait.subject}`, detail, summary)) continue;
          await this.perform(tenantId, matterId, 'chase', detail);
          chases += 1;
        } else {
          // The escalation's SOURCE is the chase dossier — every decision points at a document.
          const dossier = [
            `ESCALATION DOSSIER — ${a.wait.key}${a.wait.subject ? ` ${a.wait.subject}` : ''}`,
            `Waiting since: ${a.wait.openedAt}`,
            `Working days elapsed: ${a.ageWorkingDays} (SLA: chase at ${a.rule.chaseAfter}, escalate at ${a.rule.escalateAfter})`,
            `Chases sent: ${a.wait.chasesSentAt.length ? a.wait.chasesSentAt.join(', ') : 'none'}`,
            `Previous escalations: ${a.wait.escalations.length}`,
          ].join('\n');
          const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'ESCALATION_DOSSIER', fileName: `escalation-${a.wait.key}-${a.wait.subject || 'wait'}-${now.toISOString().slice(0, 10)}.txt`, content: dossier });
          await this.run(tenantId, matterId, { type: 'raise_escalation', waitKey: a.wait.key, subject: a.wait.subject, reason: `no response after ${a.ageWorkingDays} working days`, sourceDocumentId: doc.id });
          escalations += 1;
        }
      } catch (err) {
        this.ports.log(`timer action failed (${a.kind} ${a.wait.key}:${a.wait.subject})`, err);
      }
    }
    return { chases, escalations };
  }

  /** Sweep every active matter (cron). */
  async tickAll(tenantId?: string | null, now = this.ports.now()): Promise<{ matters: number; chases: number; escalations: number }> {
    const totals = { matters: 0, chases: 0, escalations: 0 };
    for (const m of await this.store.listActiveMatters(tenantId)) {
      totals.matters += 1;
      try {
        const r = await this.tick(m.tenantId, m.matterId, now);
        totals.chases += r.chases;
        totals.escalations += r.escalations;
      } catch (err) {
        this.ports.log(`tick failed for matter ${m.matterId}`, err);
      }
    }
    return totals;
  }

  // ───────────── effects ─────────────

  /** Post-commit reactions. Best-effort; each becomes its own command so the log records only what really happened. */
  private async effects(tenantId: string, matterId: string, events: EngineEvent[], state: MatterState, subflows: LevelConfig): Promise<void> {
    for (const e of events) {
      try {
        // PROPOSE level: a person said yes — do it now, the same way the unasked path would.
        if (e.type === 'action_approved') {
          const p = e.payload as { proposalEventId: string; action: EngineAction; detail: Record<string, unknown> };
          try {
            await this.perform(tenantId, matterId, p.action, p.detail);
          } catch (err) {
            // The person said yes and it still did not happen: that goes on the case, in words.
            const reason = (err instanceof Error ? err.message : String(err)).trim().replace(/[.!]*$/, '.');
            this.ports.log(`approved ${p.action} could not be done`, err);
            await this.run(tenantId, matterId, { type: 'record_action_failed', proposalEventId: p.proposalEventId, action: p.action, detail: p.detail, reason }).catch(() => {});
          }
        }
        // Stage entry into pre_contract → order every required search (spec 2.4 step 1).
        if (e.type === 'stage_advanced' && (e.payload as { to: string }).to === 'pre_contract') {
          const state = await this.getState(tenantId, matterId);
          for (const searchType of state.requiredSearches) {
            if (state.searches[searchType]) continue;
            const detail = { searchType, provider: this.ports.searchProvider.name };
            if (await this.proposeUnless(tenantId, matterId, subflows, 'search_order', searchType, searchType, detail, `SEARCH ORDER\n\nSearch: ${searchType}\nProvider: ${this.ports.searchProvider.name}\nWhy: the case has entered pre-contract and this search is on its list.\n\nOrdering costs the firm a fee.`)) continue;
            try {
              await this.perform(tenantId, matterId, 'search_order', detail);
            } catch (err) {
              // Provider down: the search stays un-ordered and shows as a stage blocker; a human can record it manually.
              this.ports.log(`could not order ${searchType} search — manual fallback needed`, err);
            }
          }
        }
        // Addendum: an enquiry to an INTERNAL counterparty is delivered to the other
        // side's handler as inbound correspondence — the same event pair as an external
        // exchange, with no read of the other matter's state (the wall is in the DB too).
        if (e.type === 'enquiry_raised' && (e.payload as { counterpartyType?: string }).counterpartyType === 'internal' && this.ports.linked) {
          const p = e.payload as { enquiryId: string; subject: string };
          // A person raised the enquiry; delivering it is their act, not a trust-level question.
          await this.ports.linked.enquiryRaised({ tenantId, fromMatterId: matterId, enquiryId: p.enquiryId, subject: p.subject });
        }
        // Proof of funds: "request further" re-opens the form with the conveyancer's note to the client.
        if (e.type === 'proof_of_funds_reviewed' && (e.payload as { option: string }).option === 'request_further') {
          const p = e.payload as { requestId: string; note?: string | null };
          await this.requestProofOfFunds(tenantId, matterId, e.actor, { followUpOf: p.requestId, noteToClient: p.note ?? null });
        }
        // An approved note: run each chosen proposal through the machine's ordinary front
        // door, under the name of the person who approved it. Nothing bypasses validation —
        // a client decision the machine would refuse by hand is refused here too, and is
        // logged rather than silently dropped.
        if (e.type === 'note_actions_applied') {
          const p = e.payload as { noteId: string; applied: string[] };
          const fresh = await this.getState(tenantId, matterId);
          const note = fresh.notes[p.noteId];
          for (const id of p.applied) {
            const action = note?.actions.find((a) => a.id === id);
            if (!action?.command) continue;
            try {
              const c = action.command;
              if (c.type === 'client_decision_recorded') {
                // Cites the approval it came from: the database refuses a client decision written
                // from an automation context without one (migration 079).
                await this.run(tenantId, matterId, { type: 'client_decision_recorded', actor: e.actor, subject: c.subject, decision: c.decision, note: c.note, evidenceDocumentId: note.documentId, approvedEventId: e.id });
              } else {
                await this.run(tenantId, matterId, { type: 'raise_issue', actor: e.actor, kind: c.kind, title: c.title, detail: c.detail, gate: c.gate, documentId: note.documentId });
              }
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              this.ports.log(`note ${p.noteId} action ${id} could not be applied`, err);
              await this.run(tenantId, matterId, { type: 'note_action_refused', noteId: p.noteId, actionId: id, reason }).catch(() => {});
            }
          }
        }
        // A chase to a third party is also news for the client (docs/architecture-review.md
        // §9): they hear that we are on it without having to ask. Once per day per matter,
        // never when the person being chased IS the client, and never while an issue is
        // holding the matter — that is a conversation, not a status line.
        if (e.type === 'chase_sent') {
          const chase = e.payload as { recipientRole: string; waitKey: string; subject?: string };
          const fresh = await this.getState(tenantId, matterId);
          const brief = caseBrief(fresh, this.ports.now());
          const already = fresh.clientUpdateLastSentAt['chase_update'];
          const sameDay = already ? already.slice(0, 10) === this.ports.now().toISOString().slice(0, 10) : false;
          const holding = brief.issues.some((i) => i.gate !== 'none') || brief.health.band === 'critical' || brief.health.band === 'blocked';
          const w = brief.waiting.find((x) => x.key === chase.waitKey && x.subject === (chase.subject ?? ''));
          if (chase.recipientRole !== 'client' && !sameDay && !holding && w) {
            // When we will chase again, so the update says so and nobody asks.
            const rule = (await this.store.loadSla(tenantId))[chase.waitKey as keyof SlaConfig];
            const nextChase = rule?.chaseEvery ? addWorkingDays(this.ports.now(), rule.chaseEvery).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
            const context = { eventType: e.type, payload: e.payload, waitingOn: w.who, waitingFor: w.what, nextChase, transaction: brief.side === 'seller' ? 'sale' : 'purchase' };
            const detail = { template: 'chase_update', context, triggeredByEventId: e.id, agentTemplate: 'chase_update_agent' };
            const summary = `CLIENT UPDATE\n\nTo: the client (and the estate agent)\nWhat: we have chased ${w.who} for ${w.what}${nextChase ? `; we will chase again on ${nextChase}` : ''}\nTemplate: chase_update\n\nA short status line so they know it is in hand and nobody has to ask.`;
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'chase_update', `chase_update:${e.id}`, detail, summary))) {
              await this.perform(tenantId, matterId, 'client_update', detail);
            }
          }
        }
        // Automated client status updates (zero legal risk, pure admin).
        const template = CLIENT_UPDATE_TEMPLATES[e.type];
        if (template) {
          const detail = { template, context: { eventType: e.type, payload: e.payload }, triggeredByEventId: e.id };
          if (await this.proposeUnless(tenantId, matterId, subflows, 'client_update', template, `${template}:${e.id}`, detail, `CLIENT UPDATE\n\nTo: the client\nBecause: ${e.type.replace(/_/g, ' ')}\nTemplate: ${template}\n\nThe firm's standard status message for this milestone.`)) continue;
          await this.perform(tenantId, matterId, 'client_update', detail);
        }
      } catch (err) {
        this.ports.log(`effect failed for ${e.type}`, err);
      }
    }
  }

  // ───────────── helpers ─────────────

  private async requireDoc(tenantId: string, matterId: string, documentId: string): Promise<DocumentRef> {
    const doc = await this.ports.documents.get(tenantId, documentId);
    if (!doc || doc.matterId !== matterId) throw Object.assign(new Error('Document not found on this matter.'), { status: 404 });
    return doc;
  }

  /** Ask the AI summariser (#3) for better prose when the deterministic verdict is a flag. Prose only; the verdict stands. */
  private async summarise(kind: Parameters<EnginePorts['summariser']['summarise']>[0]['kind'], subjectLabel: string, verdict: ReturnType<typeof evaluateSearch>, source: DocumentRef, tenantId: string, matterId: string) {
    if (verdict.outcome !== 'flag') return null;
    try {
      const state = await this.getState(tenantId, matterId);
      return await this.ports.summariser.summarise({ kind, subjectLabel, flags: verdict.flags, source, state });
    } catch (err) {
      this.ports.log('summariser failed — using template prose', err);
      return null;
    }
  }
}
