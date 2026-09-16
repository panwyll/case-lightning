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
 */
import { decide, assertCanSendReport, type Command } from './machine';
import { project } from './projection';
import { dueActions } from './sla';
import { EXTERNAL, SYSTEM, type BankDetails, type DecisionOption, type EngineEvent, type EnquiryReplyFacts, type EventType, type MatterState, type PayeeKind, type SearchFacts, type SearchType, type SourceChannel } from './types';
import type { DocumentRef, EnginePorts } from './ports';
import type { EventStore } from './store';
import { evaluateSearch, evaluateEnquiryReply, evaluateMortgageOffer, evaluateTitle, evaluateIdCheck } from './rules';

export interface RunResult {
  events: EngineEvent[];
  state: MatterState;
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

export class EngineService {
  constructor(
    private store: EventStore,
    private ports: EnginePorts
  ) {}

  // ───────────── core ─────────────

  /** Run one command atomically, then its effects. */
  async run(tenantId: string, matterId: string, cmd: Command): Promise<RunResult> {
    const result = await this.store.withMatterLock(tenantId, matterId, async (tx) => {
      const log = await tx.load();
      const state = project(tenantId, matterId, log);
      const now = this.ports.now();
      const { events } = decide(state, cmd, { now });
      const appended = await tx.append(events, state.lastSeq, now, this.ports.newId);
      const next = project(tenantId, matterId, [...log, ...appended]);
      await tx.afterAppend(next, appended);
      return { events: appended, state: next };
    });
    await this.effects(tenantId, matterId, result.events);
    return result;
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

  // ───────────── sub-flows (external wait → extraction → rule → clear/flag) ─────────────

  /** ID/AML: ask the provider, then record the request. */
  async requestIdCheck(tenantId: string, matterId: string, actor: string): Promise<RunResult> {
    const { reference } = await this.ports.idCheckProvider.requestCheck({ tenantId, matterId });
    return this.run(tenantId, matterId, { type: 'request_id_check', actor, provider: this.ports.idCheckProvider.name, reference });
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

  async resolveDecision(tenantId: string, matterId: string, decisionEventId: string, userId: string, option: DecisionOption, note?: string | null, verification?: { method: string; reference?: string | null } | null): Promise<RunResult> {
    return this.run(tenantId, matterId, { type: 'resolve_decision', userId, decisionEventId, option, note: note ?? null, verification: verification ?? null });
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
    const state = await this.getState(tenantId, matterId);
    if (!state.enrolled || state.manualHandling.required) return { chases: 0, escalations: 0 };
    const sla = await this.store.loadSla(tenantId);
    let chases = 0;
    let escalations = 0;
    for (const a of dueActions(state, now, sla)) {
      try {
        if (a.kind === 'chase') {
          const sent = await this.ports.chaser.sendChase({
            tenantId,
            matterId,
            recipientRole: a.rule.recipientRole,
            template: a.rule.template,
            context: { waitKey: a.wait.key, subject: a.wait.subject, openedAt: a.wait.openedAt, ageWorkingDays: a.ageWorkingDays, priorChases: a.wait.chasesSentAt.length },
          });
          await this.run(tenantId, matterId, { type: 'record_chase', chase: { waitKey: a.wait.key, subject: a.wait.subject, recipientRole: a.rule.recipientRole, template: a.rule.template, channel: sent.channel, messageId: sent.messageId } });
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
  private async effects(tenantId: string, matterId: string, events: EngineEvent[]): Promise<void> {
    for (const e of events) {
      try {
        // Stage entry into pre_contract → order every required search (spec 2.4 step 1).
        if (e.type === 'stage_advanced' && (e.payload as { to: string }).to === 'pre_contract') {
          const state = await this.getState(tenantId, matterId);
          for (const searchType of state.requiredSearches) {
            if (state.searches[searchType]) continue;
            try {
              const { reference } = await this.ports.searchProvider.orderSearch({ tenantId, matterId, searchType });
              await this.run(tenantId, matterId, { type: 'record_search_ordered', actor: SYSTEM, searchType, provider: this.ports.searchProvider.name, reference });
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
          await this.ports.linked.enquiryRaised({ tenantId, fromMatterId: matterId, enquiryId: p.enquiryId, subject: p.subject });
        }
        // Automated client status updates (zero legal risk, pure admin).
        const template = CLIENT_UPDATE_TEMPLATES[e.type];
        if (template) {
          const sent = await this.ports.clientComms.sendStatusUpdate({ tenantId, matterId, template, context: { eventType: e.type, payload: e.payload } });
          await this.run(tenantId, matterId, { type: 'record_client_update', update: { template, channel: sent.channel, messageId: sent.messageId, triggeredByEventId: e.id } });
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
