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
import { workingDaysBetween } from './working-days';
import { checkDraft, draftCheckLine, renderChecked, type DraftCheck } from './draft-check';
import { buildCompletionStatement } from './completion-statement';
import { caseBrief } from './brief';
import { decide, assertCanSendReport, type Command } from './machine';
import { profileOf } from './transactions';
import { project } from './projection';
import { dueActions, deadlineActions, timedIssueActions, type SlaConfig } from './sla';
import { addWorkingDays } from './working-days';
import { EXTERNAL, SYSTEM, DEFAULT_LEVELS, type Actor, type WaitKey, type LeaseFacts, type TitleFacts, type BankDetails, type DecisionOption, type EngineEvent, type Engagement, type EnquiryReplyFacts, type EventType, type MatterState, type PayeeKind, type SearchFacts, type SearchType, type SourceChannel, type SubFlow, type LevelConfig, type EngineAction, type NoteKind, type NoteSender, actsUnasked, levelFor, pendingProposal } from './types';
import type { DocumentRef, EnginePorts } from './ports';

/** A rejected proposal keeps the same action quiet for this long, so the timer does not re-ask daily. */
const REJECTED_QUIET_MS = 5 * 86_400_000;

/** What gets acknowledged, to whom, in their words. Anything not here is not a delivery from a party. */
export const ACKNOWLEDGE: Partial<Record<EventType, { recipient: 'seller_solicitor' | 'client'; what: string }>> = {
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
import { evaluateSearch, evaluateEnquiryReply, evaluateMortgageOffer, evaluateLease, evaluateTitle, evaluateIdCheck } from './rules';
import { evaluateProofOfFunds, factsFromSubmission, renderDeclaration, reviewTransactions, type EvidenceDocument, type ProofOfFundsSubmission } from './proof-of-funds';
import { openPofQueries, openWaits, awayOn, awayNow, deedsToSign, deedSigned, SIGNED_DOCUMENT_LABEL, type SignedDocument, type SigningMethod } from './types';
import { explainSendError } from '../comms/errors';
import { clientOverview } from './client-overview';
import { claimText, prettyDate, AVAILABILITY_PARTY_LABEL } from './notes';
import { accessEnquiry, sortLegalPoints, surveyAdvice, surveyEnquiries, surveyNeedsAdvice } from './survey-review';
import type { SurveyFacts } from './types';
const ARRIVAL_ISSUES = new Set<string>(['survey_report_outstanding', 'mortgage_offer_outstanding', 'search_delayed', 'freeholder_info_outstanding']);
import type { IssueKind } from './issues';

export interface RunResult {
  events: EngineEvent[];
  state: MatterState;
  /** The command was recorded, but a side effect (a send, an order) did not happen. Shown to the person; never swallowed. */
  warning?: string;
}

/** Client status updates fired automatically by event (the safe half of #5). Template names only; the port renders. */
export const CLIENT_UPDATE_TEMPLATES: Partial<Record<EventType, string>> = {
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
    // A linked sale or purchase exchanges with us: the other file must be able to exchange too, and its chain issue here clears when it can.
    if (cmd.type === 'contracts_exchanged') await this.assertLinkedMatterReady(tenantId, matterId, cmd.actor as Actor);
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
      if ((e.payload as { reread?: boolean }).reread) continue; // the same report read again is not a new arrival
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
        await this.recordSendFailure(tenantId, matterId, 'acknowledgement', { forEventId: e.id, forEventType: e.type, recipientRole: rule.recipient, what: rule.what }, err);
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
    } else if (action === 'client_update' && (detail as { kind?: string }).kind === 'id_check_request') {
      await this.requestIdCheck(tenantId, matterId, SYSTEM, (detail as { party?: string | null }).party ?? null);
    } else if (action === 'client_update' && (detail as { kind?: string }).kind === 'signing_pack') {
      await this.sendSigningPack(tenantId, matterId);
    } else if (action === 'client_update' && (detail as { kind?: string }).kind === 'proof_of_funds_request') {
      const d = detail as { followUpOf?: string | null; noteToClient?: string | null; requestedBy?: string | null };
      await this.requestProofOfFunds(tenantId, matterId, d.requestedBy ?? SYSTEM, { followUpOf: d.followUpOf ?? null, noteToClient: d.noteToClient ?? null });
    } else if (action === 'client_update') {
      const d = detail as { template: string; context: Record<string, unknown>; triggeredByEventId: string; agentTemplate?: string | null };
      // Where things stand, as of now (not as of when the update was proposed), and a note of what it told the client about.
      const ov = clientOverview(await this.getState(tenantId, matterId), this.ports.now());
      const sent = await this.ports.clientComms.sendStatusUpdate({ tenantId, matterId, template: d.template, context: { ...d.context, overview: ov.text } });
      // A letter about one thing (this survey) remembers it was sent, so a re-read does not send it again.
      const aboutKey = (d as { about?: unknown }).about;
      const about = typeof aboutKey === 'string' ? [aboutKey] : [];
      await this.run(tenantId, matterId, { type: 'record_client_update', update: { template: d.template, recipientRole: 'client', channel: sent.channel, messageId: sent.messageId, to: sent.address ?? null, triggeredByEventId: d.triggeredByEventId, mentioned: [...ov.mentioned, ...about] } });
      const partyTemplate = d.agentTemplate ?? (d as { partyTemplate?: string | null }).partyTemplate ?? null;
      const partyRole = ((d as { partyRole?: string | null }).partyRole ?? 'estate_agent') as 'estate_agent' | 'lender';
      if (partyTemplate) {
        const party = await this.ports.chaser.sendPartyNotice({ tenantId, matterId, recipientRole: partyRole, template: partyTemplate, context: d.context }).catch((err) => { this.ports.log('party notice failed', err); return null; });
        if (party) await this.run(tenantId, matterId, { type: 'record_client_update', update: { template: partyTemplate, recipientRole: partyRole, channel: party.channel, messageId: party.messageId, triggeredByEventId: d.triggeredByEventId } });
      }
    } else if (action === 'enquiry_draft') {
      const d = detail as { subject: string; question?: string | null; issueId?: string | null; alsoIssueIds?: string[] };
      await this.run(tenantId, matterId, { type: 'raise_enquiry', actor: SYSTEM, subject: d.subject, origin: d.issueId ? { issueId: d.issueId, alsoIssueIds: d.alsoIssueIds ?? [] } : { formsQuestion: d.question ?? undefined } });
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
  async requestIdCheck(tenantId: string, matterId: string, actor: string, party: string | null = null): Promise<RunResult> {
    // Enrolment already asks the provider; a second request while that one is in flight is a no-op, not an error.
    const before = await this.getState(tenantId, matterId);
    const pc = party ? before.partyChecks[party] : null;
    if ((pc ? pc.status : before.idCheck.status) === 'requested') return { state: before, events: [] };
    // A person asked for this: their click is the approval, whatever the trust levels say.
    const { reference } = await this.ports.idCheckProvider.requestCheck({ tenantId, matterId, party, label: pc?.label ?? null });
    return this.run(tenantId, matterId, { type: 'request_id_check', actor, provider: this.ports.idCheckProvider.name, reference, party });
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
    let sent: { channel: string; messageId: string | null; address?: string | null };
    let sendError: string | null = null;
    let pofSendErr: unknown = null;
    try {
      sent = await this.ports.clientComms.sendStatusUpdate({ tenantId, matterId, template, context: { formUrl: form.formUrl, noteToClient: opts.noteToClient ?? '', requestId: form.requestId, queryCount: queryIds.length } });
    } catch (err) {
      sendError = (err instanceof Error ? err.message : String(err)).trim().replace(/[.!]*$/, '.');
      this.ports.log('proof-of-funds form could not be sent; recorded as unsent', err);
      sent = { channel: 'unsent', messageId: null };
      pofSendErr = err;
    }
    const result = await this.run(tenantId, matterId, { type: 'request_proof_of_funds', actor, requestId: form.requestId, channel: sent.channel, messageId: sent.messageId, to: sent.address ?? null, formUrl: form.formUrl, sendError, followUpOf: opts.followUpOf ?? null, noteToClient: opts.noteToClient ?? null, queryIds });
    if (pofSendErr !== null) await this.recordSendFailure(tenantId, matterId, 'client_update', { kind: 'proof_of_funds_request', followUpOf: opts.followUpOf ?? null, noteToClient: opts.noteToClient ?? null, formUrl: form.formUrl }, pofSendErr);
    return sendError ? { ...result, warning: `Recorded, but the form was not sent: ${explainSendError(pofSendErr).reason} The form link is on the case; the fix and the message are in the issue raised.` } : result;
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
        const read = this.ports.extractor.extractEvidence ? await this.ports.extractor.extractEvidence(ref) : await this.ports.extractor.extractStatement(ref).then((st) => ({ kind: st ? ('bank_statement' as const) : ('other' as const), statement: st, payslip: null }));
        evidence.push({ id, fileName, sourceIndex, donorFor, kind: read.kind, payslip: read.payslip, statement: read.statement, unreadable: null });
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
    const verdict = evaluateProofOfFunds(facts, { coBuyers: state.partyNames.slice(1), hasLinkedSale: state.relatedMatter?.relation === 'sale' ? true : state.relatedMatter ? undefined : false, acceptsNonFamilyGift: state.lenderRequirements?.acceptsNonFamilyGift ?? null });
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
      return { surveyType: surveyType ?? 'level2', recommendations: [{ code: 'UNREAD', text: 'The report could not be read automatically; a person must read it and record the recommendations.', furtherInvestigation: false, severity: 'medium' as const }], confidence: 0 } satisfies import('./types').SurveyFacts;
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

  /** The management pack (LPE1) arrived: read into the review table, then always a decision citing it (a failed read still raises the decision, with nothing filled in). */
  async managementPackReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts = await this.ports.extractor.extractManagementPack(doc).catch((err) => { this.ports.log('management pack extraction failed — the decision goes up unread', err); return null; });
    return this.run(tenantId, matterId, { type: 'management_pack_received', actor: EXTERNAL, documentId, facts });
  }

  /** The lease arrived: read into the review table; its flags go through the title decision (leasehold only). */
  async leaseReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts = await this.ports.extractor.extractLease(doc).catch((err) => {
      this.ports.log('lease extraction failed — routing to human', err);
      return { confidence: 0, flags: [], clauses: [] } as LeaseFacts;
    });
    const summary = await this.summarise('title', `Lease${facts.demise ? ` of ${facts.demise}` : ''}`, evaluateLease(facts), doc, tenantId, matterId);
    return this.run(tenantId, matterId, { type: 'lease_extracted', actor: SYSTEM, documentId, facts, extractor: this.ports.extractor.name, summary });
  }

  /** ID/AML result landed (webhook / upload): extract → rule → cleared or flagged. */
  async idCheckResultReceived(tenantId: string, matterId: string, documentId: string, party: string | null = null): Promise<RunResult> {
    if (await this.alreadyHave(tenantId, matterId, 'id_check', party)) {
      this.ports.log('ID check result already on the case; duplicate ignored', { matterId, documentId });
      return { state: await this.getState(tenantId, matterId), events: [], warning: 'The ID check result is already on the case; this copy was filed but not read again.' };
    }
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts = await this.ports.extractor.extractIdCheck(doc).catch((err) => {
      this.ports.log('id check extraction failed — routing to human', err);
      return { provider: 'unknown', outcome: 'refer' as const, flags: [], confidence: 0 };
    });
    const label = party ? (await this.getState(tenantId, matterId)).partyChecks[party]?.label : null;
    const summary = await this.summarise('id_check', label ? `ID/AML check — ${label} (${facts.provider})` : `ID/AML check (${facts.provider})`, evaluateIdCheck(facts), doc, tenantId, matterId);
    return this.run(tenantId, matterId, { type: 'id_check_result', actor: EXTERNAL, documentId, facts, summary, party });
  }

  /** Spec 2.4 steps 3–5: a search PDF is back. Record it, extract, rule-check, clear or flag. */
  /**
   * Does the case already hold this provider result? Used by the InfoTrack webhook and the
   * CRM mirror so a result that arrives twice (InfoTrack files into the CRM as well as
   * calling us) is ingested once. A search is "held" once it is past ordered in its
   * current cycle; a title once anything is extracted; an ID check once a result is in.
   */
  async alreadyHave(tenantId: string, matterId: string, kind: 'search' | 'official_copies' | 'id_check', subject: string | null): Promise<boolean> {
    const s = await this.getState(tenantId, matterId);
    if (kind === 'search') { const sr = subject ? s.searches[subject] : null; return !!sr && sr.status !== 'ordered'; }
    if (kind === 'official_copies') return !!s.title.documentId; // the lease may have been read first; only the official copy itself counts
    if (subject) { const pc = s.partyChecks[subject]; return !!pc && pc.status !== 'not_started' && pc.status !== 'requested'; }
    return s.idCheck.status !== 'not_started' && s.idCheck.status !== 'requested';
  }

  async searchReturned(tenantId: string, matterId: string, searchType: SearchType, documentId: string, provider?: string | null): Promise<RunResult> {
    if (await this.alreadyHave(tenantId, matterId, 'search', searchType)) {
      this.ports.log(`${searchType} search result already on the case; duplicate ignored`, { matterId, documentId });
      return { state: await this.getState(tenantId, matterId), events: [], warning: `The ${searchType} result is already on the case; this copy was filed but not read again.` };
    }
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
    // The firm's lender directory: this lender's Part 2 answers go on the matter before the offer is judged, so the rules read them.
    if (this.ports.lenderDirectory && facts.lender && facts.lender !== 'unknown') {
      const profile = await this.ports.lenderDirectory.find(tenantId, facts.lender).catch((err) => { this.ports.log('lender directory lookup failed', err); return null; });
      if (profile && (profile.minUnexpiredYears != null || profile.maxSearchAgeMonths != null || profile.acceptsNonFamilyGift != null || profile.requiresEws1 != null || profile.note)) {
        await this.run(tenantId, matterId, { type: 'record_lender_requirements', actor: SYSTEM, minUnexpiredYears: profile.minUnexpiredYears, maxSearchAgeMonths: profile.maxSearchAgeMonths, acceptsNonFamilyGift: profile.acceptsNonFamilyGift, requiresEws1: profile.requiresEws1, note: profile.note ? `${facts.lender} (directory): ${profile.note}` : `${facts.lender} (directory)` }).catch((err) => this.ports.log('lender requirements from the directory not recorded', err));
      }
    }
    const state = await this.getState(tenantId, matterId);
    const summary = await this.summarise('mortgage', `Mortgage offer (${facts.lender})`, evaluateMortgageOffer(facts, state.targetExchangeDate, this.ports.now()), doc, tenantId, matterId);
    return this.run(tenantId, matterId, { type: 'mortgage_offer_extracted', actor: SYSTEM, facts, extractor: this.ports.extractor.name, summary });
  }

  /**
   * A contract is read for its terms and goes into the register with a page ledger; the
   * cross-checks then compare its price, parties, address, title number and completion date
   * with the case record and every other document. No engine event: approval is a person's
   * command (contract_approved), and a disagreement surfaces as a document_mismatch issue.
   */
  /** The seller's property forms: read answer by answer, then the side's own command (the purchase reads the seller's; the sale files our client's). */
  async propertyFormsReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts = await this.ports.extractor.extractPropertyForms(doc).catch((err) => { this.ports.log('property forms extraction failed — filed without a read', err); return null; });
    const state = await this.getState(tenantId, matterId);
    const side = profileOf(state.transactionType ?? 'freehold_purchase').side;
    if (side === 'seller') return this.run(tenantId, matterId, { type: 'property_forms_received', actor: EXTERNAL, forms: facts?.forms?.length ? facts.forms : ['TA6'], facts, documentId });
    return this.run(tenantId, matterId, { type: 'seller_forms_received', actor: EXTERNAL, documentId, forms: facts?.forms ?? null, facts });
  }

  async contractReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts = await this.ports.extractor.extractContract(doc).catch((err) => { this.ports.log('contract extraction failed — the review table will be empty', err); return null; });
    const state = await this.getState(tenantId, matterId);
    return { state, events: [], warning: facts ? (facts.flags.length ? `Contract read: ${facts.flags.length} point${facts.flags.length === 1 ? '' : 's'} for you under Documents.` : undefined) : 'The contract could not be read; review it by hand under Documents.' };
  }

  async titleReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    if (await this.alreadyHave(tenantId, matterId, 'official_copies', null)) {
      this.ports.log('official copies already on the case; duplicate ignored', { matterId, documentId });
      return { state: await this.getState(tenantId, matterId), events: [], warning: 'Official copies are already on the case; this copy was filed but not read again.' };
    }
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts: TitleFacts = await this.ports.extractor.extractTitle(doc).catch((err) => {
      this.ports.log('title extraction failed — routing to human', err);
      return { titleNumber: 'unknown', tenure: 'unknown' as const, restrictions: [], charges: [], covenants: [], confidence: 0 };
    });
    // A lease already read stays with the title: the rules see both.
    const before = await this.getState(tenantId, matterId);
    if (before.title.lease && !facts.lease) facts.lease = before.title.lease;
    const summary = await this.summarise('title', `Title ${facts.titleNumber}`, evaluateTitle(facts, profileOf(before.transactionType).tenure), doc, tenantId, matterId);
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
    input: { text: string; kind: NoteKind; actor: string; documentId?: string | null; durationSeconds?: number | null; noteId?: string | null; from?: NoteSender | null; attachments?: string[] }
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
      from: input.from ?? null,
    });
    const noteId = (recorded.events[0]?.payload as { noteId?: string } | undefined)?.noteId;
    const reader = this.ports.noteExtractor;
    if (!noteId || !reader) return recorded;
    const brief = caseBrief(recorded.state, this.ports.now());
    const drafts = await reader
      .extract({ tenantId, matterId, text: input.text, kind: input.kind, from: input.from ?? null, attachments: input.attachments ?? [], now: this.ports.now().toISOString(), caseLine: `${brief.transactionLabel}, ${brief.lifecycleLabel.toLowerCase()}` })
      .catch((err) => {
        this.ports.log('note extraction failed — the note is still on the file', err);
        return [];
      });
    const stranger = input.kind === 'email' && (input.from?.relation ?? 'unknown') === 'unknown';
    // An email that brings files is not evidence that those files are missing: whatever the reader
    // made of "attached", an "it has not arrived" issue is not proposed from it.
    const kept = input.attachments?.length ? drafts.filter((d) => !(d.command?.type === 'raise_issue' && ARRIVAL_ISSUES.has(d.command.kind))) : drafts;
    if (!kept.length && !stranger) return recorded;
    return this.run(tenantId, matterId, { type: 'note_extracted', noteId, drafts: kept, extractor: reader.name });
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
    // The drafter sees the fact register (what the file says, with page and quote) and nothing it writes escapes the check against it.
    const register = this.ports.documents.loadRegister ? await this.ports.documents.loadRegister(tenantId, matterId).catch(() => null) : null;
    const draft = await this.ports.reportDrafter.draft({ state, documents, register: register?.facts });
    const draftId = `rot-${this.ports.newId()}`;
    let content = draft.content;
    let summary = draft.summary;
    let check: DraftCheck | null = null;
    if (register) {
      check = checkDraft(draft.content, register.facts, { allowed: [...register.allowed, state.targetExchangeDate ?? '', state.targetCompletionDate ?? '', state.exchange.completionDate ?? ''] });
      content = renderChecked(draft.content, check);
      summary = `${draft.summary}\n${draftCheckLine(check)}${check.notFromFile.length ? `\nNot from the file: ${check.notFromFile.map((n) => n.text).join('; ')}.` : ''}`;
    }
    const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'REPORT_ON_TITLE_DRAFT', fileName: `${draftId}.txt`, content });
    if (check && this.ports.documents.writeDraftCheck) await this.ports.documents.writeDraftCheck(tenantId, doc.id, check).catch(() => {});
    const citations = [...draft.citations];
    for (const f of check?.cited ?? []) if (!citations.some((c) => c.documentId === f.documentId && c.locator?.quote === (f.quote ?? undefined))) citations.push({ documentId: f.documentId, label: `${f.documentLabel}${f.page ? ` p.${f.page}` : ''} — ${f.key.replace(/^[a-z_]+\./, '').replace(/[._]/g, ' ')}: ${f.value}`, locator: { page: f.page ?? undefined, quote: f.quote ?? undefined } });
    return this.run(tenantId, matterId, { type: 'draft_report_on_title', draftId, draftDocumentId: doc.id, model: draft.model, summary, citations, basedOn: draft.basedOn });
  }

  /** The completion statement drafted from the register: every figure cited or marked to confirm; filed as a document for the Completion Statement Produced milestone. */
  async draftCompletionStatement(tenantId: string, matterId: string): Promise<RunResult & { documentId: string }> {
    const state = await this.getState(tenantId, matterId);
    if (!state.enrolled) throw Object.assign(new Error('Enrol the case first.'), { status: 409 });
    const register = this.ports.documents.loadRegister ? await this.ports.documents.loadRegister(tenantId, matterId).catch(() => null) : null;
    const record = register ? await this.caseRecord(tenantId, matterId) : null;
    const side = profileOf(state.transactionType).side;
    const built = buildCompletionStatement({ state, side, register: register?.facts ?? [], record: record ?? { propertyAddress: null, purchasePricePennies: state.purchasePricePennies, buyerNames: [], sellerNames: [] } });
    const check = checkDraft(built.text, register?.facts ?? [], { allowed: [...(register?.allowed ?? []), ...built.allowed, state.exchange.completionDate ?? '', ...(record?.buyerNames ?? []), ...(record?.sellerNames ?? [])] });
    const content = renderChecked(built.text, check);
    const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'COMPLETION_STATEMENT', fileName: `completion-statement-${this.ports.now().toISOString().slice(0, 10)}.txt`, content });
    if (this.ports.documents.writeDraftCheck) await this.ports.documents.writeDraftCheck(tenantId, doc.id, check).catch(() => {});
    const warning = `Completion statement drafted under Documents: ${draftCheckLine(check)}${built.toConfirm.length ? ` ${built.toConfirm.length} line${built.toConfirm.length === 1 ? '' : 's'} for you to fill in.` : ''}`;
    return { state, events: [], warning, documentId: doc.id };
  }

  /** The case record as the drafters see it: what the matter row says about the parties, the property and the price. */
  private async assertLinkedMatterReady(tenantId: string, matterId: string, actor: Actor): Promise<void> {
    const state = await this.getState(tenantId, matterId);
    const link = state.relatedMatter;
    if (!link) return;
    const other = await this.getState(tenantId, link.matterId).catch(() => null);
    if (!other) throw Object.assign(new Error(`The linked ${link.relation} (${link.matterId}) cannot be read; unlink it or check the matter.`), { status: 409 });
    const ready = !!other.exchange.exchangedAt || (other.stage === 'pre_exchange' && other.exchange.conditionsMet && !other.abandoned);
    if (!ready) throw Object.assign(new Error(`Cannot exchange: the linked ${link.relation} is at "${other.stage}"${other.exchange.conditionsMet ? '' : ' and its exchange conditions are not met'}; exchange is simultaneous.`), { status: 409 });
    for (const i of Object.values(state.issues)) {
      if (i.kind === 'chain_dependency' && i.title.startsWith('Linked ') && (i.status === 'open' || i.status === 'negotiating')) await this.run(tenantId, matterId, { type: 'resolve_issue', actor, issueId: i.id, resolution: 'other', note: `The linked ${link.relation} is ready to exchange (${other.exchange.exchangedAt ? 'exchanged' : 'conditions met'}); exchanging together.` });
    }
  }

  private async caseRecord(tenantId: string, matterId: string): Promise<{ propertyAddress: string | null; purchasePricePennies: number | null; buyerNames: string[]; sellerNames: string[] } | null> {
    try {
      const { loadCaseRecord } = await import('./crosscheck-run');
      const r = await loadCaseRecord(tenantId, matterId);
      return r ? { propertyAddress: r.propertyAddress, purchasePricePennies: r.purchasePricePennies, buyerNames: r.buyerNames, sellerNames: r.sellerNames } : null;
    } catch { return null; }
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
          // Nobody is chased while they are away: the reminder waits for them to be back.
          const awayParty = a.rule.recipientRole === 'client' ? 'client' : a.rule.recipientRole === 'seller_solicitor' ? 'seller_side' : a.rule.recipientRole === 'lender' ? 'lender' : null;
          if (awayParty && awayNow(state, awayParty, now)) continue;
          const context = { waitKey: a.wait.key, subject: a.wait.subject, openedAt: a.wait.openedAt, ageWorkingDays: a.ageWorkingDays, priorChases: a.wait.chasesSentAt.length };
          const detail = { waitKey: a.wait.key, subject: a.wait.subject, recipientRole: a.rule.recipientRole, template: a.rule.template, context };
          const summary = `CHASE\n\nTo: ${a.rule.recipientRole.replace(/_/g, ' ')}\nAbout: ${a.wait.key.replace(/_/g, ' ')}${a.wait.subject ? ` ${a.wait.subject}` : ''}\nWaiting since: ${a.wait.openedAt.slice(0, 10)} (${a.ageWorkingDays} working days)\nPrevious chases: ${a.wait.chasesSentAt.length}\nTemplate: ${a.rule.template}\n\nA polite reminder asking for what is outstanding, in the firm's standard wording.`;
          if (await this.proposeUnless(tenantId, matterId, subflows, 'chase', a.wait.key, `${a.wait.key}:${a.wait.subject}`, detail, summary)) continue;
          try { await this.perform(tenantId, matterId, 'chase', detail); } catch (err) { this.ports.log(`chase could not be sent (${a.wait.key})`, err); await this.recordSendFailure(tenantId, matterId, 'chase', detail, err); continue; }
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

  /** A person sends the chase for a wait now rather than when the timer would; the same template and record as the timer's. */
  async chaseNow(tenantId: string, matterId: string, waitKey: WaitKey, subject: string | null, actor: string): Promise<RunResult> {
    const state = await this.getState(tenantId, matterId);
    const wait = openWaits(state).find((w) => w.key === waitKey && (w.subject || null) === (subject || null));
    if (!wait) throw Object.assign(new Error(`No open ${waitKey.replace(/_/g, ' ')} wait${subject ? ` for ${subject}` : ''} on this case.`), { status: 409 });
    const sla = await this.store.loadSla(tenantId);
    const rule = sla[waitKey];
    if (!rule) throw Object.assign(new Error(`No chase rule for ${waitKey}.`), { status: 400 });
    const ageWorkingDays = workingDaysBetween(new Date(wait.openedAt), this.ports.now());
    const context = { waitKey: wait.key, subject: wait.subject, openedAt: wait.openedAt, ageWorkingDays, priorChases: wait.chasesSentAt.length, sentBy: actor };
    await this.perform(tenantId, matterId, 'chase', { waitKey: wait.key, subject: wait.subject, recipientRole: rule.recipientRole, template: rule.template, context });
    const after = await this.getState(tenantId, matterId);
    return { state: after, events: [], warning: `Chase sent to the ${rule.recipientRole.replace(/_/g, ' ')} (${rule.template.replace(/_/g, ' ')}).` };
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

  /**
   * Send the client what they must sign. Each deed is wet ink or electronic: what a person set on
   * the case, else electronic when the firm has a signing provider and (for the mortgage deed) the
   * lender takes an e-signed deed, else wet ink. A lender not known to accept one is wet ink.
   */
  async sendSigningPack(tenantId: string, matterId: string): Promise<RunResult> {
    const s = await this.getState(tenantId, matterId);
    const docs = deedsToSign(s).filter((d) => !deedSigned(s, d));
    if (!docs.length) throw Object.assign(new Error('Nothing on this case is waiting for the client to sign.'), { status: 409 });
    if (!this.ports.signing) throw Object.assign(new Error('Sending the signing pack is not available here; send it by hand and record the signed copies.'), { status: 503 });
    const def = await this.ports.signing.defaults(tenantId, s.mortgage?.facts?.lender ?? null);
    const method = (d: SignedDocument): SigningMethod => s.signing.methods[d] ?? (def.provider !== 'none' && (d !== 'mortgage_deed' || def.lenderAcceptsDigital === true) ? 'electronic' : 'wet');
    const wet = docs.filter((d) => method(d) === 'wet');
    const electronic = docs.filter((d) => method(d) === 'electronic');
    const sent = await this.ports.signing.sendPack({ tenantId, matterId, wet, electronic, signers: s.partyNames ?? [] });
    for (const env of sent.envelopes) await this.run(tenantId, matterId, { type: 'record_signing_envelope', document: env.document, provider: env.provider, envelopeId: env.envelopeId });
    const methods: Partial<Record<SignedDocument, SigningMethod>> = Object.fromEntries(docs.map((d) => [d, sent.fellBackToWet.includes(d) ? 'wet' : method(d)]));
    return this.run(tenantId, matterId, { type: 'record_signing_pack_sent', documents: docs, methods, attached: sent.attached, channel: sent.channel, messageId: sent.messageId });
  }

  /** One request to the seller's solicitor for access, naming every specialist the client wants in. */
  private async proposeAccess(tenantId: string, matterId: string, subflows: LevelConfig, note: string | null): Promise<void> {
    const fresh = await this.getState(tenantId, matterId);
    const open = Object.values(fresh.issues).filter((x) => x.kind === 'survey_further_investigation' && (x.status === 'open' || x.status === 'negotiating') && !x.enquiryIds.length);
    // Older per-issue requests (and an earlier batch that no longer covers every open investigation) are taken back.
    for (const x of Object.values(fresh.proposals).filter((x) => x.status === 'pending' && x.action === 'enquiry_draft' && (x.dedupKey.startsWith('enquiry_draft:access:ISS-') || x.dedupKey.startsWith('enquiry_draft:access-batch:')))) {
      await this.run(tenantId, matterId, { type: 'withdraw_proposal', proposalEventId: x.eventId, reason: 'replaced by one access request' }).catch(() => {});
    }
    if (!open.length) return;
    const groups = open.map((i) => ({ specialist: i.title.replace(/^Further investigation:\s*/, '').replace(/ report recommended:.*$/, ''), items: (i.detail ?? i.title).split('\n').map((t) => ({ text: t.replace(/^•\s*/, '') })).filter((t) => t.text.trim()) }));
    const subject = accessEnquiry(groups, note);
    const ids = open.map((i) => i.id).sort();
    const key = `enquiry_draft:access-batch:${ids.join(',')}`;
    if (Object.values(fresh.proposals).some((x) => x.dedupKey === key && x.status === 'pending')) return;
    const detail = { subject, issueId: ids[0], alsoIssueIds: ids.slice(1) };
    if (await this.proposeUnless(tenantId, matterId, subflows, 'enquiry_draft', 'survey', key, detail, `ACCESS FOR SPECIALISTS\n\nTo: the seller's solicitor\n${groups.length} inspection${groups.length === 1 ? '' : 's'}: ${groups.map((g) => g.specialist).join(', ')}\n\n${subject}`)) return;
    try { await this.perform(tenantId, matterId, 'enquiry_draft', detail); } catch (err) { this.ports.log('access request could not be raised', err); await this.recordSendFailure(tenantId, matterId, 'enquiry_draft', detail, err); }
  }

  // ───────────── effects ─────────────

  /** Post-commit reactions. Best-effort; each becomes its own command so the log records only what really happened. */
  private async effects(tenantId: string, matterId: string, events: EngineEvent[], state: MatterState, subflows: LevelConfig): Promise<void> {
    for (const e of events) {
      try {
        // The seller answered "not known": each such question is an enquiry to the seller's solicitor, proposed (never sent unasked below auto).
        if (e.type === 'seller_forms_received') {
          const facts = (e.payload as { facts: { notKnown?: Array<{ question: string; section: string | null; page: number | null }> | null } | null }).facts;
          for (const q of facts?.notKnown ?? []) {
            const subject = `TA6 ${q.question.replace(/\s+/g, ' ').trim()}: the seller answered "not known". Please make enquiries of your client and confirm the position, with any documents held.`;
            if (Object.values(state.enquiries).some((x) => x.origin?.formsQuestion === q.question)) continue;
            const detail = { subject, question: q.question, section: q.section, page: q.page };
            if (await this.proposeUnless(tenantId, matterId, subflows, 'enquiry_draft', 'ta6', `enquiry_draft:${q.question}`, detail, `ENQUIRY FROM THE SELLER'S FORMS\n\nQuestion: ${q.question}${q.section ? `\nSection: ${q.section}` : ''}${q.page ? `\nPage: ${q.page}` : ''}\nAnswer given: not known\n\nProposed enquiry to the seller's solicitor:\n${subject}`)) continue;
            await this.run(tenantId, matterId, { type: 'raise_enquiry', actor: SYSTEM, subject, origin: { formsQuestion: q.question } });
          }
        }
        // The thing itself arrived: whatever said it was coming is closed.
        const arrivalCloses: Partial<Record<string, IssueKind>> = { survey_received: 'survey_report_outstanding', mortgage_offer_received: 'mortgage_offer_outstanding', search_returned: 'search_delayed', management_pack_received: 'freeholder_info_outstanding' };
        const closes = arrivalCloses[e.type];
        if (closes) {
          const fresh = await this.getState(tenantId, matterId);
          for (const i of Object.values(fresh.issues).filter((x) => x.kind === closes && (x.status === 'open' || x.status === 'negotiating'))) {
            await this.run(tenantId, matterId, { type: 'resolve_issue', actor: SYSTEM, issueId: i.id, resolution: 'received', note: `${e.type.replace(/_/g, ' ')}: it arrived.` }).catch((err) => this.ports.log(`arrival could not close ${i.id}`, err));
          }
        }
        // The deeds are ready to sign once the contract is approved (or, on a remortgage, the offer is cleared): the pack is proposed.
        if (e.type === 'contract_approved' || ((e.type === 'mortgage_offer_cleared' || e.type === 'mortgage_condition_reviewed') && (await this.getState(tenantId, matterId)).transactionType === 'remortgage')) {
          const fresh = await this.getState(tenantId, matterId);
          const docs = deedsToSign(fresh).filter((d) => !deedSigned(fresh, d));
          if (docs.length && !fresh.signing.packSentAt) {
            const detail = { kind: 'signing_pack', documents: docs };
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'signing_pack', 'signing_pack', detail, `SIGNING PACK\n\nTo: the client\nTo sign: ${docs.map((d) => SIGNED_DOCUMENT_LABEL[d]).join(', ')}\nWet ink or electronic per deed as set on the case (a lender not known to take e-signed deeds is wet ink).`))) {
              try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('signing pack could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
            }
          }
        }
        // The survey was read: the surveyor's points for the legal adviser become enquiries to the seller's
        // solicitor, and the client is written to about what the report means for exchange. Proposed or
        // performed as the trust levels say; a person sees each as a task at Propose.
        if (e.type === 'survey_received') {
          const p = e.payload as { facts: SurveyFacts };
          const fresh = await this.getState(tenantId, matterId);
          const docKey = e.sourceDocumentId ?? e.id;
          // What an earlier reading proposed one sentence at a time is taken back: one numbered set replaces it.
          for (const x of Object.values(fresh.proposals).filter((x) => x.status === 'pending' && x.action === 'enquiry_draft' && (x.dedupKey.startsWith(`enquiry_draft:survey:${docKey}:`) || x.dedupKey.startsWith('enquiry_draft:access:ISS-')))) {
            await this.run(tenantId, matterId, { type: 'withdraw_proposal', proposalEventId: x.eventId, reason: 'replaced by one set of enquiries from the survey' }).catch((err) => this.ports.log('could not withdraw a superseded enquiry', err));
          }
          const { seller, ours } = sortLegalPoints(p.facts.legalIssues ?? []);
          const batch = surveyEnquiries(seller);
          const key = `enquiry_draft:survey:${docKey}`;
          if (batch && !Object.values(fresh.enquiries).some((q) => q.subject === batch) && !Object.values(fresh.proposals).some((x) => x.dedupKey === key && x.status !== 'rejected')) {
            const detail = { subject: batch, question: null, origin: 'survey' };
            const check = ours.length ? `\n\nNot for the seller; check these ourselves:\n${ours.map((o) => `• ${o}`).join('\n')}` : '';
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'enquiry_draft', 'survey', key, detail, `ENQUIRIES FROM THE SURVEY\n\nTo: the seller's solicitor\n${seller.length} point${seller.length === 1 ? '' : 's'} the surveyor raised for the legal adviser, as one set.\n\n${batch}${check}`))) {
              try { await this.perform(tenantId, matterId, 'enquiry_draft', detail); } catch (err) { this.ports.log('survey enquiries could not be raised', err); await this.recordSendFailure(tenantId, matterId, 'enquiry_draft', detail, err); }
            }
          }
          if (fresh.clientDecisions?.further_investigation?.decision === 'pursue') await this.proposeAccess(tenantId, matterId, subflows, null);
          if (surveyNeedsAdvice(p.facts)) {
            const blocks = surveyAdvice(p.facts, { purchasePricePennies: fresh.purchasePricePennies, freehold: fresh.transactionType !== 'leasehold_purchase', hasLender: fresh.hasLender });
            const key = `survey_advice:${docKey}`;
            if (!fresh.clientToldAt?.[key] && !Object.values(fresh.proposals).some((x) => x.dedupKey === key && x.status !== 'rejected')) {
              const detail = { template: 'survey_advice', context: { eventType: e.type, ...blocks }, triggeredByEventId: e.id, about: key };
              if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'survey_advice', key, detail, 'CLIENT UPDATE\n\nTo: the client\nWhat: what the survey means for exchange, and a request for their decision\nTemplate: survey_advice'))) {
                try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('survey advice could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
              }
            }
          }
        }
        // Something said in an email or a note was confirmed by a person: the system now does what the issue's label promised.
        if (e.type === 'issue_raised') {
          const p = e.payload as { issueId: string; kind: string; detail: string | null; title: string };
          if (p.kind === 'survey_report_outstanding') {
            const detail = { template: 'request_survey_report', context: { eventType: e.type }, triggeredByEventId: e.id };
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'request_survey_report', `request_survey_report:${p.issueId}`, detail, 'CLIENT UPDATE\n\nTo: the client\nWhat: the survey has been done; ask for the report\nTemplate: request_survey_report'))) {
              try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('survey report request could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
            }
          }
          if (p.kind === 'mortgage_at_risk') {
            const fromLender = /^Reported by the lender or broker/.test(p.detail ?? '');
            // Reported by the broker or lender: they are asked to confirm where the offer stands, and the client is told. Otherwise the client is asked what changed.
            const detail = fromLender
              ? { template: 'mortgage_status_client', partyTemplate: 'confirm_offer_status', partyRole: 'lender', context: { eventType: e.type, quote: p.title.slice(0, 200) }, triggeredByEventId: e.id }
              : { template: 'mortgage_change_query', context: { eventType: e.type, quote: p.title.slice(0, 200) }, triggeredByEventId: e.id };
            const summary = fromLender ? 'CLIENT UPDATE + LENDER\n\nTo: the lender or broker (confirm whether the offer stands) and the client (told what was said)\nTemplate: confirm_offer_status / mortgage_status_client' : 'CLIENT UPDATE\n\nTo: the client\nWhat: a change may affect the mortgage; ask what changed and say the lender must be told\nTemplate: mortgage_change_query';
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', detail.template, `${detail.template}:${p.issueId}`, detail, summary))) {
              try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('mortgage query could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
            }
          }
          if (p.kind === 'transaction_at_risk') {
            const subject = `We have been told that your client may not be proceeding with the sale (${p.title.slice(0, 160)}). Please confirm by return whether your client intends to proceed and, if so, on what timetable; our client is incurring costs in reliance on the transaction.`;
            const detail = { subject, issueId: p.issueId };
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'enquiry_draft', 'chain', `enquiry_draft:at_risk:${p.issueId}`, detail, `ENQUIRY — IS THE SALE PROCEEDING?\n\nTo: the seller's solicitor\nFor: ${p.title}\n\n${subject}`))) {
              try { await this.perform(tenantId, matterId, 'enquiry_draft', detail); } catch (err) { this.ports.log('proceeding enquiry could not be raised', err); await this.recordSendFailure(tenantId, matterId, 'enquiry_draft', detail, err); }
            }
          }
        }
        // A target date that falls while someone is away, or a new absence over a target date: a delay issue names it before anyone books removals.
        if (e.type === 'target_dates_changed' || e.type === 'availability_recorded') {
          const fresh = await this.getState(tenantId, matterId);
          for (const [label, iso] of [['exchange', fresh.targetExchangeDate], ['completion', fresh.targetCompletionDate]] as Array<[string, string | null]>) {
            if (!iso) continue;
            for (const party of ['client', 'seller_side'] as const) {
              const w = awayOn(fresh, party, iso);
              if (!w) continue;
              const kind = party === 'client' ? 'buyer_delay' : 'seller_delay';
              const title = `Target ${label} ${prettyDate(iso)} falls while ${AVAILABILITY_PARTY_LABEL[party]} is away (${prettyDate(w.from)} to ${prettyDate(w.until)})`;
              if (Object.values(fresh.issues).some((i) => i.kind === kind && i.title === title && (i.status === 'open' || i.status === 'negotiating'))) continue;
              await this.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind, title, detail: 'Move the target date or plan signing before they go.', gate: 'none' }).catch((err) => this.ports.log('availability clash could not be raised', err));
            }
          }
        }
        // The client wants the specialist in: ask the seller's solicitor for access, one enquiry per recommendation, proposed or raised as the trust level says.
        if (e.type === 'client_decision_recorded' && (e.payload as { subject: string; decision: string }).subject === 'further_investigation' && (e.payload as { decision: string }).decision === 'pursue') {
          await this.proposeAccess(tenantId, matterId, subflows, (e.payload as { note?: string | null }).note ?? null);
        }
        // The seller's solicitor has answered an access enquiry: the client hears the conditions and can book the specialist.
        if (e.type === 'enquiry_reply_received') {
          const fresh = await this.getState(tenantId, matterId);
          const q = fresh.enquiries[(e.payload as { enquiryId: string }).enquiryId];
          const issue = q?.origin?.issueId ? fresh.issues[q.origin.issueId] : null;
          if (q && issue?.kind === 'survey_further_investigation') {
            const dec = q.decisionEventId ? fresh.decisions[q.decisionEventId] : null;
            const conditions = (dec?.summary ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).join(' ');
            const names = [q.origin?.issueId, ...(q.origin?.alsoIssueIds ?? [])].map((id) => (id ? fresh.issues[id]?.title : null)).filter(Boolean).map((t) => String(t).replace(/^Further investigation:\s*/, '').replace(/ report recommended:.*$/i, '').replace(/ recommended:.*$/i, ''));
            const specialist = names.length <= 1 ? (names[0] ?? 'specialist') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
            const context = { eventType: e.type, payload: e.payload, specialist, conditions: conditions || "see their reply, which we will forward" };
            const detail = { template: 'access_conditions', context, triggeredByEventId: e.id };
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'access_conditions', `access_conditions:${e.id}`, detail, `CLIENT UPDATE\n\nTo: the client\nWhat: the seller's reply on access for the ${issue.title}\nTemplate: access_conditions`))) {
              try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('access conditions could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
            }
          }
        }
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
            await this.recordSendFailure(tenantId, matterId, p.action, { ...p.detail, __proposalEventId: p.proposalEventId }, err);
          }
        }
        // Enrolment → the two things every instruction starts with: the ID / AML check with
        // the provider and, on a purchase that needs one, the proof-of-funds form to the client.
        // Nobody should have to press a button for either; the trust level decides whether a
        // person is asked first.
        if (e.type === 'matter_created' && this.ports.autoStartOnEnrol !== false) {
          const state = await this.getState(tenantId, matterId);
          if (state.idCheck.status === 'not_started') {
            const detail = { kind: 'id_check_request', provider: this.ports.idCheckProvider.name };
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'id_check_request', `id_check_request:${e.id}`, detail, `ID / AML CHECK\n\nTo: the client, via ${this.ports.idCheckProvider.name}\nWhy: every instruction starts with identity and AML.\n\nThe check costs the firm a fee.`))) {
              try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('ID check could not be requested on enrolment', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
            }
          }
          if (state.requireProofOfFunds && state.proofOfFunds.status === 'not_started' && this.ports.pofForms) {
            const detail = { kind: 'proof_of_funds_request' };
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'proof_of_funds_request', `proof_of_funds_request:${e.id}`, detail, 'PROOF OF FUNDS\n\nTo: the client\nWhy: the firm requires source of funds signed off before exchange; the form goes out at instruction so the statements arrive in time.'))) {
              try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('proof-of-funds form could not be sent on enrolment', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
            }
          }
        }
        // Another person to identify (a co-client named at enrolment, a gift donor declared on the form): their own check, proposed or sent as the trust level says.
        if (e.type === 'id_party_added') {
          const p = e.payload as { party: string; label: string; role: string };
          const detail = { kind: 'id_check_request', provider: this.ports.idCheckProvider.name, party: p.party, label: p.label };
          const why = p.role === 'donor' ? 'a gift donor is a source of funds: identity and AML are checked as for the client' : 'every client on the matter is identified in their own right';
          if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'id_check_request', `id_check_request:${p.party}`, detail, `ID / AML CHECK — ${p.label}\n\nTo: ${p.label}, via ${this.ports.idCheckProvider.name}\nWhy: ${why}.`))) {
            try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log(`ID check could not be requested for ${p.label}`, err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
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
        // A stage the client was waiting on has been signed off: tell them, say where everything else stands and what comes next.
        if ((e.type === 'proof_of_funds_reviewed' && (e.payload as { option: string }).option === 'approve') || e.type === 'title_reviewed' && (e.payload as { option: string }).option === 'approve') {
          const fresh = await this.getState(tenantId, matterId);
          const brief = caseBrief(fresh, this.ports.now());
          const done = e.type === 'proof_of_funds_reviewed' ? 'source of funds approved' : 'title approved';
          const doneLine = e.type === 'proof_of_funds_reviewed' ? 'We have signed off your proof of funds: that part of the file is complete.' : 'We have reviewed the title to the property and approved it.';
          // What comes next, once: one sentence for the stage, the target date if there is one. Outstanding items are the "where things stand" tail every client update carries.
          const target = brief.milestones.targetExchangeDate;
          const targetNote = target ? ` We are working towards exchange around ${new Date(target).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.` : '';
          const stageNext: Record<string, string> = {
            instruction: 'Once your checks are through we get the contract papers and the searches under way.',
            pre_contract: 'Once the contract papers and the search results are in, we raise our enquiries with the seller\'s solicitor and report to you before exchange.',
            contract_review: 'Once the replies to our enquiries are in and the report on title is with you, we can look at exchanging.',
            pre_exchange: 'When you have read the report and are ready, and the deposit is with us, we can exchange.',
          };
          const nextStep = `${stageNext[fresh.stage] ?? 'We will be in touch as the next piece comes in.'}${targetNote}`;
          const context = { eventType: e.type, payload: e.payload, done, doneLine, nextStep, transaction: brief.side === 'seller' ? 'sale' : 'purchase' };
          const detail = { template: 'progress_update', context, triggeredByEventId: e.id };
          if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'progress_update', `progress_update:${e.id}`, detail, `CLIENT UPDATE\n\nTo: the client\nWhat: ${done}; where everything else stands; what happens next\nTemplate: progress_update`))) {
            try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('progress update could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
          }
        }
        // "Request further": the form goes back to the client with the conveyancer's note. It is a message to the client, so the trust level decides whether a person sees it first.
        if (e.type === 'proof_of_funds_reviewed' && (e.payload as { option: string }).option === 'request_further') {
          const p = e.payload as { requestId: string; note?: string | null };
          const detail = { kind: 'proof_of_funds_request', followUpOf: p.requestId, noteToClient: p.note ?? null, requestedBy: e.actor };
          if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'proof_of_funds_request', `proof_of_funds_request:${e.id}`, detail, `PROOF OF FUNDS — FURTHER EVIDENCE\n\nTo: the client\nWhy: the conveyancer asked for more on the source of funds.${p.note ? `\nNote to the client: ${p.note}` : ''}\n\nThe form goes back to the client with that note; they answer in it.`))) {
            try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('proof-of-funds form could not be sent again', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
          }
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
              } else if (c.type === 'set_target_dates') {
                await this.run(tenantId, matterId, { type: 'set_target_dates', actor: e.actor, targetExchangeDate: c.targetExchangeDate ?? undefined, targetCompletionDate: c.targetCompletionDate ?? undefined, reason: c.reason });
              } else if (c.type === 'confirm_with_client') {
                // Hearsay: ask the client. Their reply comes back through the same reader as their
                // own words, and only then is the decision proposed for the record.
                const claim = claimText(c.subject, c.decision, c.detail);
                const detail = { kind: 'confirm_with_client', template: 'confirm_with_client', context: { saidBy: c.saidBy, claim, quote: c.quote, subject: c.subject, decision: c.decision }, triggeredByEventId: e.id };
                if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'confirm_with_client', `confirm_with_client:${p.noteId}:${id}`, detail, `CLIENT UPDATE\n\nTo: the client\nWhat: ${c.saidBy} says ${claim}; ask the client to confirm it before it is recorded\nTemplate: confirm_with_client`))) {
                  try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('confirmation request could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
                }
              } else if (c.type === 'record_price_change') {
                const to = c.toPennies ?? (fresh.purchasePricePennies != null && c.reductionPennies ? fresh.purchasePricePennies - c.reductionPennies : null);
                if (!to || to <= 0) throw new Error('The price on file is not known, so a reduction cannot be applied. Record the new price in full.');
                await this.run(tenantId, matterId, { type: 'record_price_change', actor: e.actor, toPennies: to, reason: c.reason });
              } else if (c.type === 'resolve_issue') {
                const open = Object.values(fresh.issues).find((i) => i.kind === c.kind && (i.status === 'open' || i.status === 'negotiating'));
                if (!open) throw new Error(`No open ${c.kind.replace(/_/g, ' ')} issue on the case.`);
                await this.run(tenantId, matterId, { type: 'resolve_issue', actor: e.actor, issueId: open.id, resolution: c.resolution, note: c.note });
              } else if (c.type === 'record_availability') {
                await this.run(tenantId, matterId, { type: 'record_availability', actor: e.actor, party: c.party, from: c.from, until: c.until, note: c.note });
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
          let context: Record<string, unknown> = { eventType: e.type, payload: e.payload };
          let dedupKey = `${template}:${e.id}`;
          let because = e.type.replace(/_/g, ' ');
          // Searches are ordered as a set: the client hears once, when the last one has gone, not once per search.
          if (e.type === 'search_ordered') {
            const fresh = await this.getState(tenantId, matterId);
            const ordered = fresh.requiredSearches.filter((t) => fresh.searches[t]);
            if (ordered.length < fresh.requiredSearches.length) continue;
            context = { ...context, searches: ordered };
            dedupKey = `${template}:${ordered.join('+')}`;
            because = `all ${ordered.length} searches ordered (${ordered.join(', ')})`;
          }
          const detail = { template, context, triggeredByEventId: e.id };
          if (await this.proposeUnless(tenantId, matterId, subflows, 'client_update', template, dedupKey, detail, `CLIENT UPDATE\n\nTo: the client\nBecause: ${because}\nTemplate: ${template}\n\nThe firm's standard status message for this milestone.`)) continue;
          try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log(`client update could not be sent (${template})`, err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
        }
      } catch (err) {
        this.ports.log(`effect failed for ${e.type}`, err);
        await this.recordEffectFailure(tenantId, matterId, e, err);
      }
    }
  }

  /**
   * A send that failed (a person's approved message, an automatic chase, the proof-of-funds form) becomes a task on the case:
   * what went wrong in plain words, the steps that fix it, and the message itself so it can be sent by hand meanwhile.
   */
  private async recordSendFailure(tenantId: string, matterId: string, action: string, detail: Record<string, unknown>, err: unknown): Promise<void> {
    const ex = explainSendError(err);
    const kind = typeof detail.kind === 'string' ? detail.kind : null;
    const role = typeof detail.recipientRole === 'string' ? detail.recipientRole.replace(/_/g, ' ') : 'the client';
    const what = kind === 'proof_of_funds_request' ? 'The proof-of-funds form to the client' : kind === 'id_check_request' ? 'The ID / AML check request' : action === 'chase' ? `The chase to ${role}` : action === 'acknowledgement' ? `The acknowledgement to ${role}` : action === 'search_order' ? 'The search order' : action === 'client_update' ? 'The update to the client' : `The ${action.replace(/_/g, ' ')}`;
    const title = `${what} did not go: ${ex.reason.replace(/[.!]*$/, '')}`;
    const proposalId = typeof detail.__proposalEventId === 'string' ? detail.__proposalEventId : null;
    const outside = this.ports.outsideAutomation ?? (<T,>(fn: () => Promise<T>) => fn());
    try {
      await outside(async () => {
        const state = await this.getState(tenantId, matterId);
        if (!state.enrolled || state.completion.confirmedAt || Object.values(state.issues).some((i) => i.status === 'open' && i.title === title)) return;
        const msg = await this.ports.messagePreview?.(tenantId, matterId, action, detail).catch(() => null);
        const steps = [...ex.steps, 'If it still will not go, send it yourself from your own mailbox using the message below, then resolve this issue'];
        const lines = [ex.reason, '', 'What to do:', ...steps.map((s, i) => `${i + 1}. ${s}`)];
        if (msg && msg.kind !== 'action' && (msg.subject || msg.body)) lines.push('', `To: ${msg.to ?? role}`, `Subject: ${msg.subject ?? ''}`, '', msg.body ?? '');
        else if (msg?.title) lines.push('', msg.title);
        lines.push('', `Error text for support: ${ex.raw}`);
        if (proposalId) lines.push(`[proposal:${proposalId}]`);
        await this.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: 'send_failed', title, detail: lines.join('\n'), gate: 'none', severity: 'warning' });
      });
    } catch (inner) {
      this.ports.log('could not record the failed send on the case', inner);
    }
  }

  /** The provider reported, after accepting a message, that it did not arrive (a bounce, a complaint): the same task as a failed send, with the reason it gave. */
  async recordDeliveryFailure(tenantId: string, matterId: string, input: { template: string | null; address: string | null; reason: string; providerRef: string | null }): Promise<void> {
    const detail: Record<string, unknown> = input.template === 'proof_of_funds_request' || input.template === 'proof_of_funds_request_again' ? { kind: 'proof_of_funds_request', template: input.template, __providerRef: input.providerRef } : { template: input.template ?? 'client_update', __providerRef: input.providerRef };
    await this.recordSendFailure(tenantId, matterId, 'client_update', detail, new Error(`${input.reason}${input.address ? ` (to ${input.address})` : ''}`));
  }

  /** A person tries a failed action again (the mailbox is back, the address was added). The same message, the same way; on success the proposal stands as done and the failure task closes. */
  async retryFailedAction(tenantId: string, matterId: string, proposalEventId: string, userId: string): Promise<RunResult> {
    const s = await this.getState(tenantId, matterId);
    const pr = s.proposals[proposalEventId];
    if (!pr) throw Object.assign(new Error('Proposal not found.'), { status: 404 });
    if (pr.status !== 'failed') throw Object.assign(new Error('Only a failed action can be tried again.'), { status: 409 });
    try {
      await this.perform(tenantId, matterId, pr.action, pr.detail as Record<string, unknown>);
    } catch (err) {
      await this.recordSendFailure(tenantId, matterId, pr.action, { ...(pr.detail as Record<string, unknown>), __proposalEventId: proposalEventId }, err);
      throw Object.assign(new Error(explainSendError(err).reason), { status: 502 });
    }
    const result = await this.run(tenantId, matterId, { type: 'record_action_retried', actor: userId, proposalEventId, action: pr.action });
    const fresh = await this.getState(tenantId, matterId);
    for (const i of Object.values(fresh.issues).filter((x) => x.kind === 'send_failed' && x.status === 'open' && (x.detail ?? '').includes(`[proposal:${proposalEventId}]`))) {
      await this.run(tenantId, matterId, { type: 'resolve_issue', actor: userId, issueId: i.id, resolution: 'evidence_provided', note: 'Sent on retry.' }).catch(() => {});
    }
    return result;
  }

  /** Send the client the proof-of-funds form again: the same link, the same round. For "they never got it". */
  async resendProofOfFunds(tenantId: string, matterId: string, userId: string): Promise<RunResult> {
    const s = await this.getState(tenantId, matterId);
    const pof = s.proofOfFunds;
    if (!pof.requestId || !pof.formUrl) throw Object.assign(new Error('No proof-of-funds form has been requested on this case.'), { status: 409 });
    if (pof.status !== 'requested') throw Object.assign(new Error('The form has already come back; there is nothing to resend.'), { status: 409 });
    const template = (pof.rounds ?? 1) > 1 ? 'proof_of_funds_request_again' : 'proof_of_funds_request';
    let sent: { channel: string; messageId: string | null; address?: string | null };
    try {
      sent = await this.ports.clientComms.sendStatusUpdate({ tenantId, matterId, template, context: { formUrl: pof.formUrl, noteToClient: '', requestId: pof.requestId, queryCount: 0, resend: 'yes' } });
    } catch (err) {
      await this.recordSendFailure(tenantId, matterId, 'client_update', { kind: 'proof_of_funds_request', formUrl: pof.formUrl }, err);
      throw Object.assign(new Error(explainSendError(err).reason), { status: 502 });
    }
    return this.run(tenantId, matterId, { type: 'record_client_update', update: { template, recipientRole: 'client', channel: sent.channel as 'email' | 'whatsapp' | 'mock', messageId: sent.messageId, to: sent.address ?? null } });
  }

  /** An effect that failed is written on the case as an issue, not only to the server log: a person sees that the engine did not do what it should have, and why. */
  private async recordEffectFailure(tenantId: string, matterId: string, e: EngineEvent, err: unknown): Promise<void> {
    const reason = (err instanceof Error ? err.message : String(err)).trim() || 'unknown error';
    const title = `The system could not act on ${e.type.replace(/_/g, ' ')}`;
    const outside = this.ports.outsideAutomation ?? (<T,>(fn: () => Promise<T>) => fn());
    try {
      await outside(async () => {
        const state = await this.getState(tenantId, matterId);
        if (!state.enrolled || state.completion.confirmedAt || Object.values(state.issues).some((i) => i.status === 'open' && i.title === title)) return;
        await this.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: 'other', title, detail: `${reason.replace(/[.!]*$/, '.')} What it would have done (a proposal, an update, an order) has not happened: do it by hand, and report this.`, gate: 'none', severity: 'warning' });
      });
    } catch (inner) {
      this.ports.log('could not record the effect failure on the case', inner);
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
