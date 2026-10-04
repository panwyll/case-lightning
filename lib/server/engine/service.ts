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
import { deathPlaybook } from './people';
import { pounds } from './money';
import { chargeableConsideration } from './sdlt-facts';
import { clientMessagesStopped } from './people';
import { computeSdlt } from './sdlt';
import { workingDaysBetween } from './working-days';
import { checkDraft, draftCheckLine, pointsNotInReport, renderChecked, type DraftCheck } from './draft-check';
import { buildCompletionStatement } from './completion-statement';
import { caseBrief } from './brief';
import { decide, assertCanSendReport, reportReady, reportDraftProblem, type Command } from './machine';
import { profileOf } from './transactions';
import { SHAPE_SPEC } from './shapes';
import { applyEvent, project } from './projection';
import { deferral, outsideDeferral } from './defer';

/** A known state with later events applied (a copy; the known state is untouched). */
const foldOnto = (state: MatterState, events: EngineEvent[]): MatterState => events.reduce((s, e) => applyEvent(s, e), state);
import { dueActions, deadlineActions, timedIssueActions, type SlaConfig } from './sla';
import { addWorkingDays } from './working-days';
import { EXTERNAL, SYSTEM, DEFAULT_LEVELS, type Actor, type WaitKey, type LeaseFacts, type TitleFacts, type BankDetails, type DecisionOption, type EngineEvent, type Engagement, type EnquiryReplyFacts, type EventType, type MatterState, type PayeeKind, type SearchFacts, type SearchType, type SourceChannel, type SubFlow, type LevelConfig, type EngineAction, type ContractFacts, ENGINE_ACTION_LABEL, type NoteKind, type NoteSender, type NoteReply, type NoteMessage, type MessageParty, type MessageAttachment, type ManualChannel, MANUAL_CHANNELS, type IdCheckFacts, actsUnasked, levelFor, pendingProposal , isLeasehold } from './types';
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
import { describeIdDocument, reviewIdDocument } from './id-document';
import { evaluateProofOfFunds, factsFromSubmission, renderDeclaration, reviewTransactions, type EvidenceDocument, type ProofOfFundsSubmission, type StatementFacts } from './proof-of-funds';
import type { Flag as PofFlag } from './types';
import { isUserActor, isResolved, openIssues, openPofQueries, openWaits, awayOn, awayNow, deedsToSign, deedsReadyToSign, deedSigned, SIGNED_DOCUMENT_LABEL, type SignedDocument, type SigningMethod } from './types';
import { explainSendError } from '../comms/errors';
import { clientOverview } from './client-overview';
import { claimText, prettyDate, AVAILABILITY_PARTY_LABEL, isAcknowledgement, documentRequests, attachmentPreference, WAIT_LABEL, type NoteActionDraft } from './notes';
import { replyFacts, templateIssueMessage, templateMessage, templateReply } from './reply';
import { analyseSourceOfFunds } from './source-of-funds';
import { counterpartyNotice, dueCounterpartyNotices, renderCounterpartyFacts, templateCounterpartyUpdate } from './counterparty-status';
import { FOLLOW_UP_PARTY, PARTY_LABEL, whoNeedsToHear } from './recipients';

/** Who the firm acts for on this case, as the drafter is told. */
/** A file's name as the client sees it: the report on title by what it is, anything else by its name. */
const fileNameForClient = (doc: DocumentRef | null, id: string): string => (doc?.docType === 'REPORT_ON_TITLE_DRAFT' ? 'Report on title.docx' : (doc?.fileName ?? `Document ${id.slice(0, 8)}`).replace(/\.txt$/i, '.docx'));
const weActFor = (s: MatterState): string => { const side = profileOf(s.transactionType).side; return side === 'seller' ? 'the seller' : side === 'owner' ? 'the owner (a remortgage or transfer)' : 'the buyer'; };
/** A party, as the client would read it in a reply. */
const PARTY_WORDS: Record<MessageParty, string> = { client: 'you', seller_solicitor: "the other side's solicitor", estate_agent: 'the estate agent', lender: 'the lender' };
import type { MessageOverride } from './ports';
import { accessEnquiry, evidenceEnquiry, sortLegalPoints, surveyAdvice, surveyContext, surveyEnquiries, surveyNeedsAdvice, templateAdvice } from './survey-review';
import type { SurveyFacts } from './types';
import { chaseContent, unsignedDeeds } from './chase-content';
import { EXPECTATION_KEYS } from './types';
import { expectationDue, FORMS_ISSUE_PREFIX } from './machine';
const ARRIVAL_ISSUES = new Set<string>(['survey_report_outstanding', 'mortgage_offer_outstanding', 'search_delayed', 'freeholder_info_outstanding']);
import type { IssueKind } from './issues';
import { issueSteps, ISSUE_KIND_SPEC } from './issues';

export interface RunResult {
  events: EngineEvent[];
  state: MatterState;
  /** The command was recorded, but a side effect (a send, an order) did not happen. Shown to the person; never swallowed. */
  warning?: string;
}

/** Client status updates fired automatically by event (the safe half of #5). Template names only; the port renders. */
/**
 * The first request a step sends (the chase only follows it): who it goes to and from which template.
 * Third parties go at the chase trust level, the client at the client-update level. `optional`: no
 * address for them on the case is not a failure (an agent is not always involved).
 */
/** Source-of-funds issues still open (what a further proof-of-funds round must answer). */
const openFundsIssues = (s: MatterState) => Object.values(s.issues).filter((i) => i.kind === 'source_of_funds' && (i.status === 'open' || i.status === 'negotiating') && !i.title.startsWith('Money still to arrive'));

export interface FirstRequest { to: 'seller_solicitor' | 'lender' | 'estate_agent' | 'client'; template: string; buyerOnly?: boolean; optional?: boolean }
export const FIRST_REQUESTS: Partial<Record<EventType, FirstRequest>> = {
  contract_pack_requested: { to: 'seller_solicitor', template: 'request_contract_pack' },
  signed_transfer_requested: { to: 'seller_solicitor', template: 'request_signed_transfer', buyerOnly: true },
  management_pack_requested: { to: 'seller_solicitor', template: 'request_management_pack', buyerOnly: true },
  redemption_statement_requested: { to: 'lender', template: 'request_redemption_statement' },
  lender_consent_requested: { to: 'lender', template: 'request_lender_consent' },
  property_forms_requested: { to: 'client', template: 'property_forms_request' },
  contract_approved: { to: 'client', template: 'deposit_request', buyerOnly: true },
  completion_statement_generated: { to: 'client', template: 'completion_statement' },
  contracts_exchanged: { to: 'estate_agent', template: 'exchanged_agent', optional: true },
  completion_confirmed: { to: 'estate_agent', template: 'completed_agent', optional: true },
};

/** Phase junctions the client hears about (a progress update), by the stage the case moves into. The flowchart shows the same. */
export const PHASE_DONE: Record<string, Partial<Record<'buyer' | 'seller' | 'owner', { done: string; line: string }>>> = {
  // Entering pre-contract already tells them (searches ordered), as does the report going out: only this junction is news on its own.
  contract_review: {
    buyer: { done: 'investigations complete', line: 'The searches are back and our enquiries of the seller\'s solicitor are answered: the investigation of the property is complete.' },
    seller: { done: "the buyer's enquiries answered", line: "The buyer's solicitor's enquiries on the property are answered: their side of the paperwork is settled." },
    owner: { done: 'checks on the property complete', line: 'The title and the searches are back and checked: the investigation of the property is complete.' },
  },
};
/** What happens next, by the stage the case is in and whose side we act for: one sentence in the client's update. */
const STAGE_NEXT: Record<'buyer' | 'seller' | 'owner', Record<string, string>> = {
  buyer: {
    instruction: 'Once your checks are through we get the contract papers and the searches under way.',
    pre_contract: 'Once the contract papers and the search results are in, we raise our enquiries with the seller\'s solicitor and report to you before exchange.',
    contract_review: 'Once the replies to our enquiries are in and the report on title is with you, we can look at exchanging.',
    pre_exchange: 'When you have read the report and are ready, and the deposit is with us, we can exchange.',
  },
  seller: {
    instruction: "Once your checks are through and your property forms are back, we send the contract papers to the buyer's solicitor.",
    pre_contract: "The buyer's solicitor now does their searches and sends us their enquiries; we answer them, with your help where we need it.",
    contract_review: "Once the buyer's solicitor is happy with the replies and you have signed the contract, we can look at exchanging.",
    pre_exchange: 'When you have signed the contract and the buyer is ready, we can exchange.',
  },
  owner: {
    instruction: 'Once your checks are through we get the title and the searches the lender needs.',
    pre_contract: 'Once the title and the searches are in and checked, we report to the lender and send you the mortgage deed to sign.',
    contract_review: 'Next we report to the lender and send you the mortgage deed to sign.',
  },
};

export const CLIENT_UPDATE_TEMPLATES: Partial<Record<EventType, string>> = {
  search_ordered: 'searches_ordered',
  enquiry_raised: 'enquiries_raised',
  mortgage_offer_cleared: 'mortgage_offer_checked',
  report_on_title_sent: 'report_on_title_sent',
  contracts_exchanged: 'exchanged',
  completion_confirmed: 'completed',
  // Once the new register is read (not when the Land Registry says done): the client gets it with the news (theme H).
  register_checked: 'registration_complete',
};

/** What the client hears when we ask the seller's side something: what it was for, plainly, and what happens next. */
function enquiryLine(purpose: string, about: string | null): string {
  switch (purpose) {
    case 'client_instruction': return `We've asked the seller's solicitor ${about ? `about ${about.replace(/^[A-Z]/, (c) => c.toLowerCase())}` : 'for what you wanted'}, as you asked. We'll let you know what they say.`;
    case 'evidence': return "We've asked the seller's solicitor for any reports, certificates or guarantees that answer the points in your survey. We'll send on whatever they have.";
    case 'access': return "We've asked the seller's solicitor whether your specialists can get in, and when. We'll pass on their answer as soon as we have it.";
    case 'survey': return "We've put the points your surveyor raised for us (planning, building regulations, guarantees and the like) to the seller's solicitor. We'll let you know what comes back.";
    case 'forms': return "We've sent the seller's solicitor our questions on the contract papers. Replies usually take a week or two; we'll chase if they're slow and tell you if anything needs you.";
    default: return "We've sent the seller's solicitor a question on your purchase. We'll let you know what they say.";
  }
}

/** Marks the client-comms port once it stops messages to a client who has died. */
const STOP_WRAPPED = Symbol('client-messages-stop');

/** Which sub-flow an automatic client update belongs to (null → only matter-level shadow suppresses it). */
export class EngineService {
  constructor(
    private store: EventStore,
    private ports: EnginePorts
  ) {
    // Nothing goes to a client who has died (people.ts): every message to the client passes here, whoever sends it.
    // Wrapped in place (not a copy of the ports), so a port swapped in later is still the one used.
    const raw = ports.clientComms as EnginePorts['clientComms'] & { [STOP_WRAPPED]?: true };
    if (raw && !raw[STOP_WRAPPED]) {
      const stopped = async (tenantId: string, matterId: string) => clientMessagesStopped(await this.getState(tenantId, matterId));
      ports.clientComms = new Proxy(raw, { get: (target, key, receiver) => {
        if (key === STOP_WRAPPED) return true;
        const v = Reflect.get(target, key, receiver);
        if ((key !== 'sendStatusUpdate' && key !== 'sendReportOnTitle') || typeof v !== 'function') return typeof v === 'function' ? v.bind(target) : v;
        return async (input: { tenantId: string; matterId: string }) => {
          const why = await stopped(input.tenantId, input.matterId);
          if (why) throw Object.assign(new Error(why), { status: 409 });
          return v.call(target, input);
        };
      } });
    }
  }

  // ───────────── core ─────────────

  /** Run one command atomically, then its effects. */
  /** A case enrolled without its clients' names takes them from the matter record, once (the rules need to know who our client is). */
  async ensureClientNames(tenantId: string, matterId: string): Promise<void> {
    const state = await this.getState(tenantId, matterId).catch(() => null);
    if (!state?.enrolled || (state.partyNames ?? []).length || state.closedAt || state.abandoned) return;
    const rec = await this.caseRecord(tenantId, matterId).catch(() => null);
    const names = (profileOf(state.transactionType).side === 'seller' ? rec?.sellerNames : rec?.buyerNames) ?? [];
    if (!names.filter((n) => n.trim()).length) return;
    await this.run(tenantId, matterId, { type: 'record_client_names', actor: SYSTEM, names }).catch((err) => this.ports.log('client names could not be recorded', err));
  }

  async run(tenantId: string, matterId: string, cmd: Command): Promise<RunResult> {
    if (cmd.type !== 'enrol' && cmd.type !== 'record_client_names') await this.ensureClientNames(tenantId, matterId);
    const subflows = await this.levels(tenantId);
    // A linked sale or purchase exchanges with us: the other file must be able to exchange too, and its chain issue here clears when it can.
    if (cmd.type === 'contracts_exchanged') await this.assertLinkedMatterReady(tenantId, matterId, cmd.actor as Actor, cmd.completionDate);
    if (cmd.type === 'completion_confirmed') await this.assertLinkedSaleCompleted(tenantId, matterId);
    if (cmd.type === 'completion_confirmed') await this.assertLinkedPurchaseReady(tenantId, matterId);
    // Money is checked against the contract: the deposit it states, and on a sale the price less that deposit from the buyer's solicitor.
    if ((cmd.type === 'deposit_received' && cmd.contractDepositPennies === undefined) || (cmd.type === 'funds_received' && cmd.fromRole === 'buyer_solicitor' && cmd.contractPricePennies === undefined)) {
      const terms = await this.contractTerms(tenantId, matterId);
      if (cmd.type === 'deposit_received') cmd = { ...cmd, contractDepositPennies: terms.depositPennies };
      else if (cmd.type === 'funds_received') cmd = { ...cmd, contractPricePennies: terms.pricePennies, contractDepositPennies: terms.depositPennies };
    }
    const result = await this.store.withMatterLock(tenantId, matterId, async (tx) => {
      // The state as last known plus whatever was appended since, under the lock; the whole log only the first time.
      const known = this.stateCache.get(`${tenantId}:${matterId}`);
      const state = known && tx.loadAfter ? foldOnto(known, await tx.loadAfter(known.lastSeq)) : project(tenantId, matterId, await tx.load());
      const now = this.ports.now();
      const { events } = decide(state, cmd, { now, levels: subflows });
      const appended = await tx.append(events, state.lastSeq, now, this.ports.newId);
      // Undoing a completion rewrites what it did: the case is rebuilt from the whole log, not folded forward.
      const next = appended.some((e) => e.type === 'manual_step_undone') ? project(tenantId, matterId, [...(await tx.load()).filter((x) => x.seq <= state.lastSeq), ...appended]) : foldOnto(state, appended);
      await tx.afterAppend(next, appended);
      return { events: appended, state: next };
    });
    this.remember(tenantId, matterId, result.state);
    const followOn = async () => {
      await this.asAutomation(() => this.effects(tenantId, matterId, result.events, result.state, subflows));
      await this.asAutomation(() => this.acknowledge(tenantId, matterId, result.events, result.state, subflows));
      if (result.events.length && reportReady(result.state)) await this.draftReportWhenReady(tenantId, matterId);
      if (this.ports.onEvents && result.events.length) {
        const latest = await this.getState(tenantId, matterId).catch(() => result.state);
        await this.asAutomation(() => this.ports.onEvents!({ tenantId, matterId, events: result.events, state: latest })).catch((err) => this.ports.log('post-commit observer failed', err));
      }
    };
    // A person's click is answered once the command is recorded; what it sets off runs after the response.
    const later = deferral();
    if (later && result.events.length) later(() => outsideDeferral(() => followOn().catch((err) => this.ports.log('follow-on work failed', err))));
    else await followOn();
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
      // No other side on a remortgage or a transfer of equity: nobody to thank for replies to enquiries.
      if (rule.recipient === 'seller_solicitor' && profileOf(state.transactionType).side === 'owner') continue;
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
  private async proposeUnless(tenantId: string, matterId: string, levels: LevelConfig, action: EngineAction, subject: string | null, dedupKey: string, detail: Record<string, unknown>, summary: string, always = false): Promise<boolean> {
    const state = await this.getState(tenantId, matterId);
    // Manual handling: whatever would have gone out on its own is proposed instead, for the person who has the case.
    const manual = state.manualHandling.required;
    // `always`: a person approves it whatever the trust level (a death notice is never sent unread).
    if (!manual && !always && actsUnasked(levelFor(levels, action, subject), action)) return false;
    if (manual) detail = { ...detail, manualMode: true };
    if (pendingProposal(state, action, dedupKey)) return true;
    const quietUntil = this.ports.now().getTime() - REJECTED_QUIET_MS;
    if (Object.values(state.proposals).some((p) => p.action === action && p.dedupKey === dedupKey && p.status === 'rejected' && new Date(p.resolvedAt ?? p.proposedAt).getTime() > quietUntil)) return true;
    const doc = await this.ports.documents.createGenerated({
      tenantId,
      matterId,
      docType: 'PROPOSAL',
      fileName: readableName(proposalTitle(action, subject, detail, summary), this.ports.now()),
      content: summary,
    });
    try {
      await this.run(tenantId, matterId, { type: 'propose_action', action, subject, detail, dedupKey, summary, sourceDocumentId: doc.id });
    } catch (err) {
      // Two effects proposing the same thing at once: the other got there first, and it is proposed. Not a failed send.
      if ((err as { status?: number }).status === 409 && /already proposed/i.test((err as Error).message)) return true;
      throw err;
    }
    return true;
  }

  /** Do what a person approved. The same code the assist/auto path runs; only the gate differs. */
  private async perform(tenantId: string, matterId: string, action: EngineAction, detail: Record<string, unknown>): Promise<void> {
    if (action === 'acknowledgement') {
      const d = detail as { forEventId: string; forEventType: EventType; recipientRole: string; what: string };
      const sent = await this.ports.chaser.sendAcknowledgement({ tenantId, matterId, recipientRole: d.recipientRole as never, what: d.what, forEventType: d.forEventType, override: (detail as { edited?: MessageOverride }).edited ?? null });
      if (!sent) return;
      await this.run(tenantId, matterId, { type: 'record_acknowledgement', ack: { forEventId: d.forEventId, forEventType: d.forEventType, recipientRole: d.recipientRole as never, what: d.what, channel: sent.channel, messageId: sent.messageId } });
    } else if (action === 'counterparty_update') {
      // A milestone to the other side or the agent, as approved (and edited); remembered so it goes once.
      const d = detail as { to: 'seller_solicitor' | 'estate_agent'; milestone: string; subject: string; body: string; triggeredByEventId: string };
      const ed = (detail as { edited?: MessageOverride }).edited ?? null;
      if (!this.ports.chaser.sendMessage) throw new Error('Messages to other parties are not configured on this deployment.');
      const sent = await this.ports.chaser.sendMessage({ tenantId, matterId, recipientRole: d.to, subject: ed?.subject?.trim() || d.subject, body: ed?.body?.trim() || d.body });
      await this.run(tenantId, matterId, { type: 'record_client_update', update: { template: `cp_${d.milestone}:${d.to}`, recipientRole: d.to, channel: sent.channel, messageId: sent.messageId, triggeredByEventId: d.triggeredByEventId } });
    } else if (action === 'chase' && (detail as { kind?: string }).kind === 'party_message') {
      // A message a person approved on an email's task, to a party on the case, as they wrote it.
      const d = detail as { recipientRole: 'seller_solicitor' | 'lender' | 'estate_agent' | 'family'; subject: string; body: string };
      // As the person approved it: their edits, not the draft.
      const ed = (detail as { edited?: MessageOverride }).edited ?? null;
      if (!this.ports.chaser.sendMessage) throw new Error('Messages to other parties are not configured on this deployment.');
      await this.ports.chaser.sendMessage({ tenantId, matterId, recipientRole: d.recipientRole, subject: ed?.subject?.trim() || d.subject, body: ed?.body?.trim() || d.body });
    } else if (action === 'chase' && (detail as { kind?: string }).kind === 'request') {
      // A first request to another party (not a chase): the template, to the role, once.
      const d = detail as { recipientRole: 'seller_solicitor' | 'lender' | 'estate_agent'; template: string; context: Record<string, unknown> };
      if (!this.ports.chaser.sendRequest) throw new Error('Requests to other parties are not configured on this deployment.');
      await this.ports.chaser.sendRequest({ tenantId, matterId, recipientRole: d.recipientRole, template: d.template, context: d.context });
    } else if (action === 'chase') {
      const d = detail as { waitKey: string; subject: string; recipientRole: string; template: string; context: Record<string, unknown>; alsoSubjects?: string[] };
      const edited = (detail as { edited?: MessageOverride }).edited ?? null;
      // What the chase puts back in front of them is read from the case now, not from when it was proposed.
      const state = await this.getState(tenantId, matterId);
      const context = { ...d.context, ...this.chaseExtras(tenantId, state, d.waitKey, d.subject) };
      let sent: { channel: string; messageId: string | null };
      if (d.waitKey === 'signed_documents' && this.ports.signing && unsignedDeeds(state).length) {
        // The deeds themselves, again: the same letter with the unsigned ones re-attached.
        const deeds = unsignedDeeds(state);
        sent = await this.ports.signing.sendPack({ tenantId, matterId, wet: deeds.filter((x) => x.method === 'wet').map((x) => x.document), electronic: deeds.filter((x) => x.method === 'electronic').map((x) => x.document), signers: state.partyNames ?? [], reminder: { alreadyWithProvider: deeds.filter((x) => state.signing.envelopes[x.document]).map((x) => x.document) }, override: edited });
      } else {
        sent = await this.ports.chaser.sendChase({ tenantId, matterId, recipientRole: d.recipientRole as never, template: d.template, context, override: edited });
      }
      // One chase can cover several waits (every unanswered enquiry to the same solicitor): each is recorded as chased.
      const subjects = [d.subject, ...(d.alsoSubjects ?? [])];
      const open = new Set(openWaits(state).filter((w) => w.key === d.waitKey).map((w) => w.subject));
      for (const subj of subjects) {
        if (subj !== d.subject && !open.has(subj)) continue;
        await this.run(tenantId, matterId, { type: 'record_chase', chase: { waitKey: d.waitKey as never, subject: subj, recipientRole: d.recipientRole as never, template: d.template, channel: sent.channel as never, messageId: sent.messageId, ...(typeof d.context?.sentBy === 'string' ? { sentBy: d.context.sentBy, sentByName: typeof d.context.sentByName === 'string' ? d.context.sentByName : null } : {}) } });
      }
    } else if (action === 'client_update' && (detail as { kind?: string }).kind === 'id_check_request') {
      await this.requestIdCheck(tenantId, matterId, SYSTEM, (detail as { party?: string | null }).party ?? null);
    } else if (action === 'client_update' && (detail as { kind?: string }).kind === 'signing_pack') {
      await this.sendSigningPack(tenantId, matterId, (detail as { documents?: SignedDocument[] }).documents ?? null);
    } else if (action === 'client_update' && (detail as { kind?: string }).kind === 'proof_of_funds_request') {
      const d = detail as { followUpOf?: string | null; noteToClient?: string | null; requestedBy?: string | null };
      // Overtaken: the form is already with the client, or back for sign-off. Approving the old request is not a failed send.
      const pof = (await this.getState(tenantId, matterId)).proofOfFunds;
      if (!d.followUpOf && (pof.status === 'requested' || pof.status === 'submitted')) return;
      await this.requestProofOfFunds(tenantId, matterId, d.requestedBy ?? SYSTEM, { followUpOf: d.followUpOf ?? null, noteToClient: d.noteToClient ?? null });
    } else if (action === 'client_update') {
      const d = detail as { template: string; context: Record<string, unknown>; triggeredByEventId: string; agentTemplate?: string | null };
      // Where things stand, as of now (not as of when the update was proposed), and a note of what it told the client about.
      const reminderHours = this.ports.clientReminderHours ? await this.ports.clientReminderHours(tenantId).catch(() => undefined) : undefined;
      const ov = clientOverview(await this.getState(tenantId, matterId), this.ports.now(), { ...this.idProviderOpts(tenantId), reminderHours });
      // Files that go with it: a copy the client asked for, or a document (the completion statement).
      // As a secure link (the default), or attached for a client who asked for attachments (or on this one email).
      const attachId = (detail as { attachDocumentId?: string }).attachDocumentId;
      const fileIds = [...((detail as { attachFileIds?: string[] }).attachFileIds ?? []), ...(attachId ? [attachId] : [])];
      const attached = (detail as { asAttachments?: boolean }).asAttachments === true || (await this.getState(tenantId, matterId)).fileDelivery === 'attachments' || !this.ports.fileShares;
      let attachments: Array<{ name: string; bytes: Buffer; contentType: string }> = [];
      let link: { url: string; files: string[] } | null = null;
      if (fileIds.length && !attached) {
        const named = (detail as { attachFileNames?: string[] }).attachFileNames ?? [];
        const files = await Promise.all(fileIds.map(async (id, i) => ({ id, fileName: named[i] ?? fileNameForClient(await this.ports.documents.get(tenantId, id).catch(() => null), id) })));
        // A link that cannot be made (the store is down) is no reason not to send: the files go attached.
        const made = await this.ports.fileShares!.create({ tenantId, matterId, files }).catch((err) => { this.ports.log('secure link could not be made; attaching instead', err); return null; });
        if (made) link = { url: made.url, files: files.map((f) => f.fileName) };
      }
      if (fileIds.length && !link && this.ports.files) {
        for (const id of fileIds) { const f = await this.ports.files.bytes(tenantId, id).catch(() => null); if (f) attachments.push(f); }
      }
      const sent = await this.ports.clientComms.sendStatusUpdate({ tenantId, matterId, template: d.template, context: { ...d.context, overview: ov.text }, override: (detail as { edited?: MessageOverride }).edited ?? null, attachments, ...(link ? { link } : {}) });
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
      const d = detail as { subject: string; question?: string | null; issueId?: string | null; alsoIssueIds?: string[]; edited?: MessageOverride; origin?: string; title?: string; about?: string };
      // The issue it was drafted for may have been withdrawn since (the forms list rebuilt): tie it to the list as it is now, or to nothing.
      if (d.issueId) {
        const now = await this.getState(tenantId, matterId);
        const live = (id: string) => now.issues[id] && (now.issues[id].status === 'open' || now.issues[id].status === 'negotiating');
        if (!live(d.issueId)) d.issueId = d.title === "From the seller's forms" ? openIssues(now).find((i) => i.title.startsWith(FORMS_ISSUE_PREFIX))?.id ?? null : null;
        d.alsoIssueIds = (d.alsoIssueIds ?? []).filter(live);
      }
      // What it was for travels with it, so the client hears it in those terms.
      const purpose = d.origin === 'client_instruction' ? 'client_instruction' : d.origin === 'survey' ? 'survey' : d.title === 'Access for specialists' ? 'access' : d.title === 'Evidence from the seller' ? 'evidence' : d.question ? 'forms' : 'general';
      const about = d.about ?? (typeof d.title === 'string' && d.title.startsWith("On the client's instruction: ") ? d.title.slice("On the client's instruction: ".length) : undefined);
      await this.run(tenantId, matterId, { type: 'raise_enquiry', actor: SYSTEM, subject: d.edited?.body?.trim() || d.subject, origin: d.issueId ? { issueId: d.issueId, alsoIssueIds: d.alsoIssueIds ?? [], purpose, about, ...(d.question && d.question !== 'forms' ? { formsQuestion: d.question } : {}) } : { formsQuestion: d.question ?? undefined, purpose, about } });
    } else if (action === 'search_order') {
      const d = detail as { searchType: SearchType };
      const { reference, provider } = await this.ports.searchProvider.orderSearch({ tenantId, matterId, searchType: d.searchType });
      await this.run(tenantId, matterId, { type: 'record_search_ordered', actor: SYSTEM, searchType: d.searchType, provider: provider ?? this.ports.searchProvider.name, reference });
      // No provider connected: the stand-in comes straight back with a placeholder that says so.
      const stub = this.ports.searchProvider.placeholderResult?.({ searchType: d.searchType, reference, orderedAt: this.ports.now() });
      if (stub) {
        const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'SEARCH_RESULT', fileName: stub.fileName, content: stub.content });
        await this.searchReturned(tenantId, matterId, d.searchType, doc.id, this.ports.searchProvider.name, stub.facts);
      }
    }
  }

  /** Addendum 3 §2: switch shadow mode for one matter (people only; logged). Mirrors to matter.shadow_mode via the store. */
  async setShadowMode(tenantId: string, matterId: string, actor: string, shadowMode: boolean, reason?: string | null): Promise<RunResult> {
    return this.run(tenantId, matterId, { type: 'set_shadow_mode', actor, shadowMode, reason: reason ?? null });
  }

  async getState(tenantId: string, matterId: string): Promise<MatterState> {
    const known = this.stateCache.get(`${tenantId}:${matterId}`);
    const state = known ? foldOnto(known, await this.store.listEvents(tenantId, matterId, { afterSeq: known.lastSeq })) : project(tenantId, matterId, await this.store.listEvents(tenantId, matterId));
    this.remember(tenantId, matterId, state);
    // A copy: callers never share (or change) the remembered state.
    return JSON.parse(JSON.stringify(state)) as MatterState;
  }

  /**
   * The last state seen per case. The log only ever grows, so a remembered state plus the events
   * after it is the current state; this saves reading and replaying the whole log on every read
   * and every command (which made each action slower the longer the case ran). Bounded.
   */
  private stateCache = new Map<string, MatterState>();
  private remember(tenantId: string, matterId: string, state: MatterState): void {
    const k = `${tenantId}:${matterId}`;
    const cur = this.stateCache.get(k);
    if (cur && cur.lastSeq > state.lastSeq) return;
    this.stateCache.delete(k);
    // Its own copy: nothing handed to a caller can change what is remembered.
    this.stateCache.set(k, JSON.parse(JSON.stringify(state)) as MatterState);
    if (this.stateCache.size > 500) this.stateCache.delete(this.stateCache.keys().next().value as string);
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
    const { reference, link, provider } = await this.ports.idCheckProvider.requestCheck({ tenantId, matterId, party, label: pc?.label ?? null });
    const result = await this.run(tenantId, matterId, { type: 'request_id_check', actor, provider: provider ?? this.ports.idCheckProvider.name, reference, party, link: link ?? null });
    // The client hears it from us, not only from the provider: why, and the link (or who it comes from). Other people named on the case get the provider's own link.
    // A co-client (a joint buyer or seller) is a client too: their own link, named, to the clients' addresses.
    const coClient = !!pc && ['buyer', 'seller', 'owner'].includes(pc.role);
    if (!party || coClient) {
      const { idProviderSendsLink, idProviderLabel } = this.idProviderOpts(tenantId);
      const who = coClient ? `${pc!.label}: ` : '';
      const idLinkLine = link ? `${who}Please start your check here: ${link}` : idProviderSendsLink ? `${who}You will receive an email from ${idProviderLabel} with a secure link to start it.` : `${who}We will send you a secure link to start it shortly.`;
      const context = { idLinkLine, transaction: profileOf(before.transactionType ?? 'freehold_purchase').side === 'seller' ? 'sale' : 'purchase' };
      try {
        const sent = await this.ports.clientComms.sendStatusUpdate({ tenantId, matterId, template: 'id_check_request', context });
        const ev = result.events.find((e) => e.type === 'id_check_requested') ?? result.events[0];
        await this.run(tenantId, matterId, { type: 'record_client_update', update: { template: 'id_check_request', recipientRole: 'client', channel: sent.channel, messageId: sent.messageId, to: sent.address ?? null, triggeredByEventId: ev?.id ?? '' } } as never);
      } catch (err) {
        this.ports.log('ID check email could not be sent', err);
        await this.recordSendFailure(tenantId, matterId, 'client_update', { template: 'id_check_request', context }, err);
      }
    }
    return result;
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
    // Already signed off: this is a further round (money.md 1.1, a gift or loan mentioned later).
    if (!opts.followUpOf && state.proofOfFunds.status === 'reviewed' && state.proofOfFunds.resolution === 'approve' && state.proofOfFunds.requestId && openFundsIssues(state).length) opts = { ...opts, followUpOf: state.proofOfFunds.requestId, noteToClient: opts.noteToClient ?? openFundsIssues(state).map((i) => i.title).join('; ') };
    const form = await this.ports.pofForms.create({ tenantId, matterId, requestedBy: actor, followUpOf: opts.followUpOf ?? null, noteToClient: opts.noteToClient ?? null });
    // Drafted queries go out with this round; the client answers them in the form.
    const queryIds = openPofQueries(state).filter((q) => q.status === 'draft').map((q) => q.id);
    const template = opts.followUpOf ? 'proof_of_funds_request_again' : 'proof_of_funds_request';
    // A further round always says what more is needed: the person's note, else the questions going with it.
    const asked = openPofQueries(state).filter((q) => q.status === 'draft');
    const note = opts.noteToClient?.trim() || (opts.followUpOf ? (asked.length ? asked.map((q) => `• ${q.question}`).join('\n') : 'A few of your answers need a little more detail; you will see what when you open the form.') : '');
    // The form exists whether or not the message gets out. A send failure (no client email on
    // the case, the mailbox not connected, a provider down) must not lose the request: record
    // it as unsent with the reason and the link, so the conveyancer can send it themselves.
    let sent: { channel: string; messageId: string | null; address?: string | null };
    let sendError: string | null = null;
    let pofSendErr: unknown = null;
    try {
      sent = await this.ports.clientComms.sendStatusUpdate({ tenantId, matterId, template, context: { formUrl: form.formUrl, noteToClient: note, requestId: form.requestId, queryCount: queryIds.length } });
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
    // What the client must find includes the Stamp Duty, worked out on the case's basis (money.md 1.2).
    const sdltEstimate = state.purchasePricePennies && profileOf(state.transactionType).side === 'buyer' ? computeSdlt(chargeableConsideration(state) ?? state.purchasePricePennies, { ...(state.sdltBasis ?? { firstTimeBuyer: false, additionalProperty: false, nonUkResident: false }), company: state.shapes?.includes('company_buyer') ?? false }).totalPennies : null;
    const facts = factsFromSubmission(requestId, sub, state.purchasePricePennies, sdltEstimate);
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
      // An account connected by open banking is already the bank's own lines: nothing to extract.
      const ob = ref.docType === 'OPEN_BANKING_ACCOUNT' ? (ref.extractedFacts as { statement?: StatementFacts } | null)?.statement ?? null : null;
      if (ob) { evidence.push({ id, fileName, sourceIndex, donorFor, kind: 'bank_statement', payslip: null, statement: ob, unreadable: null, provenance: 'open_banking' }); return; }
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
    const lineReview = reviewTransactions(facts, evidence, sub.submittedAt);
    // The source-of-funds analysis on the same evidence (source-of-funds.ts): categories, income, own-account tracing,
    // each declared source against what the accounts show. A credit it explains is not asked about.
    // One question per point: the growth check stands down where the line review already asked about the balance.
    const balanceAskedOn = new Set(lineReview.queries.filter((q) => q.flagCode === 'BALANCE_JUMP').map((q) => q.documentId));
    const analysis = analyseSourceOfFunds(facts, evidence, sub.submittedAt, undefined, { balanceAskedOn });
    const explained = lineReview.queries.filter((q) => analysis.explainedKeys.includes(q.key));
    const isExplained = (f: PofFlag) => explained.some((q) => q.flagCode === f.code && q.transaction && f.locator?.quote?.startsWith(`${q.transaction.date} ${q.transaction.description}`));
    const review = { ...lineReview, flags: [...lineReview.flags.filter((f) => !isExplained(f)), ...analysis.flags], queries: [...lineReview.queries.filter((q) => !analysis.explainedKeys.includes(q.key)), ...analysis.queries] };
    const declaration = renderDeclaration(facts, sub, evidenceNames) + (analysis.report ? `\n${analysis.report}` : '');
    const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'PROOF_OF_FUNDS_DECLARATION', fileName: readableName(`Proof of funds declaration${facts.round > 1 ? ` (round ${facts.round})` : ''}`, this.ports.now()), content: declaration });
    const verdict = evaluateProofOfFunds(facts, { coBuyers: state.partyNames.slice(1), hasLinkedSale: state.relatedMatter?.relation === 'sale' ? true : state.relatedMatter ? undefined : false, acceptsNonFamilyGift: state.lenderRequirements?.acceptsNonFamilyGift ?? null, acceptsLoanDeposit: state.lenderRequirements?.acceptsLoanDeposit ?? null, acceptsDonorAbroad: state.lenderRequirements?.acceptsDonorAbroad ?? null });
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

  /** HM Land Registry's requisition arrived: the decision, with what it asks for named from its text (completion.md 6.20). */
  async hmlrRequisitionReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const f = doc.extractedFacts as { content?: string; text?: string } | null;
    const text = `${doc.fileName ?? ''} ${f?.content ?? f?.text ?? ''}`.slice(0, 2000);
    return this.run(tenantId, matterId, { type: 'hmlr_requisition_received', actor: EXTERNAL, documentId, text });
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
    const read = await this.ports.extractor.extractIdCheck(doc).catch((err) => {
      this.ports.log('id check extraction failed — routing to human', err);
      return { provider: 'unknown', outcome: 'refer' as const, flags: [], confidence: 0 } as IdCheckFacts;
    });
    const state = await this.getState(tenantId, matterId);
    const label = party ? state.partyChecks[party]?.label ?? null : null;
    // A photo of the ID is checked against whoever it should belong to: the named party, or the clients.
    let facts = read;
    if (read.source === 'document') {
      const record = label ? null : await this.caseRecord(tenantId, matterId);
      const clients = label ? [label] : profileOf(state.transactionType ?? 'freehold_purchase').side === 'seller' ? record?.sellerNames ?? [] : record?.buyerNames ?? [];
      facts = reviewIdDocument(read, clients, this.ports.now());
    }
    const what = facts.source === 'document' ? `ID document${label ? ` — ${label}` : ''}: ${describeIdDocument(facts)}` : label ? `ID/AML check — ${label} (${facts.provider})` : `ID/AML check (${facts.provider})`;
    const summary = await this.summarise('id_check', what, evaluateIdCheck(facts), doc, tenantId, matterId);
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

  async searchReturned(tenantId: string, matterId: string, searchType: SearchType, documentId: string, provider?: string | null, known?: SearchFacts): Promise<RunResult> {
    if (await this.alreadyHave(tenantId, matterId, 'search', searchType)) {
      this.ports.log(`${searchType} search result already on the case; duplicate ignored`, { matterId, documentId });
      return { state: await this.getState(tenantId, matterId), events: [], warning: `The ${searchType} result is already on the case; this copy was filed but not read again.` };
    }
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    await this.run(tenantId, matterId, { type: 'search_returned', actor: EXTERNAL, searchType, documentId, provider: provider ?? null });
    // A placeholder from the stand-in provider carries its own (empty) facts: there is nothing to read.
    const facts: SearchFacts = known ?? await this.ports.extractor.extractSearch(doc, searchType).catch((err) => {
      // Extraction failed → confidence 0 → the rule layer flags it. Never guess, never stall.
      this.ports.log(`search extraction failed for ${searchType} — routing to human`, err);
      return { searchType, flags: [], confidence: 0 };
    });
    const summary = known ? { text: `Placeholder ${searchType} search: no search was carried out (no provider connected). Order the real search before exchange.`, by: 'template' } : await this.summarise('search', `${searchType} search`, evaluateSearch(facts), doc, tenantId, matterId);
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
      if (profile && (profile.minUnexpiredYears != null || profile.maxSearchAgeMonths != null || profile.acceptsNonFamilyGift != null || profile.acceptsLoanDeposit != null || profile.acceptsDonorAbroad != null || profile.requiresEws1 != null || profile.note)) {
        await this.run(tenantId, matterId, { type: 'record_lender_requirements', actor: SYSTEM, minUnexpiredYears: profile.minUnexpiredYears, maxSearchAgeMonths: profile.maxSearchAgeMonths, acceptsNonFamilyGift: profile.acceptsNonFamilyGift, acceptsLoanDeposit: profile.acceptsLoanDeposit ?? null, acceptsDonorAbroad: profile.acceptsDonorAbroad ?? null, requiresEws1: profile.requiresEws1, note: profile.note ? `${facts.lender} (directory): ${profile.note}` : `${facts.lender} (directory)` }).catch((err) => this.ports.log('lender requirements from the directory not recorded', err));
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
    // Our clients' signed part coming back is the signed contract, not a new draft to approve.
    if (facts?.signedBy?.length && (await this.signedContractReturned(tenantId, matterId, documentId, facts))) {
      const st = await this.getState(tenantId, matterId);
      return { state: st, events: [], warning: st.readiness.signedContractHeldAt ? 'Signed contract on file.' : 'A signed contract arrived; see the task.' };
    }
    await this.run(tenantId, matterId, { type: 'record_contract_filed', documentId, points: facts?.flags.length ?? 0 });
    await this.raiseContractReview(tenantId, matterId, documentId, facts).catch((err) => this.ports.log('contract approval task not raised', err));
    const state = await this.getState(tenantId, matterId);
    return { state, events: [], warning: facts ? (facts.flags.length ? `Contract read: ${facts.flags.length} point${facts.flags.length === 1 ? '' : 's'} for you under Documents.` : undefined) : 'The contract could not be read; review it by hand under Documents.' };
  }


  /** The signing pack, proposed (or sent) for whatever is still to sign; again when something new joins it (the contract once approved). */
  private async proposeSigningPack(tenantId: string, matterId: string, subflows: LevelConfig): Promise<void> {
    const fresh = await this.getState(tenantId, matterId);
    // Each deed goes when it is ready, once: the mortgage deed does not wait for the contract.
    const docs = deedsReadyToSign(fresh).filter((d) => !deedSigned(fresh, d) && !fresh.signing.documents.includes(d));
    if (!docs.length) return;
    const detail = { kind: 'signing_pack', documents: docs };
    if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'signing_pack', `signing_pack:${docs.join(',')}`, detail, `SIGNING PACK\n\nTo: the client\nTo sign: ${docs.map((d) => SIGNED_DOCUMENT_LABEL[d]).join(', ')}\nWet ink or electronic per deed as set on the case (a lender not known to take e-signed deeds is wet ink).`))) {
      try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('signing pack could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
    }
  }

  /**
   * The steps the engine takes itself the moment they fall due, so a case never waits on someone finding a
   * button: requests go out, the client is asked (and chased) for what only they can give, the report goes
   * once approved, the completion statement is drafted on exchange and the funds are called for. What only a
   * person can do is on the Tasks tab (dueSteps).
   */
  private async automaticSteps(tenantId: string, matterId: string, subflows: LevelConfig, e: EngineEvent): Promise<void> {
    const s = await this.getState(tenantId, matterId);
    if (!s.enrolled || s.abandoned || s.closedAt) return;
    const tt = s.transactionType ?? 'freehold_purchase';
    const side = profileOf(tt).side;
    const to = e.type === 'stage_advanced' ? (e.payload as { to: string }).to : null;
    const safe = async (what: string, f: () => Promise<unknown>) => { try { await f(); } catch (err) { this.ports.log(`${what}: not done automatically`, err); } };
    const askClient = (template: string, extra: Record<string, unknown> = {}) => this.sendFirstRequest(tenantId, matterId, subflows, { to: 'client', template }, e, extra);
    const asked = (template: string) => !!s.clientUpdateLastSentAt[template];

    if (e.type === 'matter_created') {
      if (side === 'seller' && s.propertyForms.status === 'not_started') await safe('property forms request', () => this.run(tenantId, matterId, { type: 'request_property_forms', actor: SYSTEM }));
      if (s.redemption.status === 'not_started') await safe('redemption statement request', () => this.run(tenantId, matterId, { type: 'request_redemption_statement', actor: SYSTEM }));
      if (s.lenderConsent.status === 'not_started') await safe("lender's consent request", () => this.run(tenantId, matterId, { type: 'request_lender_consent', actor: SYSTEM }));
    }
    // Joint buyers: how they will own it, asked at the start (or when a second buyer joins).
    if ((e.type === 'matter_created' || e.type === 'clients_updated') && (side === 'buyer' || tt === 'transfer_of_equity') && s.parties > 1 && !s.clientDecisions.ownership_basis && !asked('ownership_basis_request')) await askClient('ownership_basis_request');
    if (to === 'pre_contract' && tt === 'leasehold_purchase' && s.managementPack.status === 'not_started') await safe('management pack request', () => this.run(tenantId, matterId, { type: 'management_pack_requested', actor: SYSTEM, from: "the seller's solicitor" }));
    if (to === 'pre_exchange' && s.requireExchangeAuthority && s.clientDecisions.exchange_authority?.decision !== 'authorised' && !asked('exchange_authority_request')) {
      await askClient('exchange_authority_request', { completionLine: s.targetCompletionDate ? `, with completion on ${prettyDate(s.targetCompletionDate)} or the date we agree with you` : '' });
    }
    // An answer that lapsed (the price, the date or the clients changed) is asked for again, with what changed.
    if (e.type === 'client_decision_lapsed') {
      const p = e.payload as { subject: string; reason: string };
      if (p.subject === 'exchange_authority' && s.requireExchangeAuthority && !s.exchange.exchangedAt) await askClient('exchange_authority_request', { completionLine: s.targetCompletionDate ? `, with completion on ${prettyDate(s.targetCompletionDate)} or the date we agree with you` : '', noteToClient: `We are asking again because ${p.reason}.` });
      if (p.subject === 'ownership_basis' && s.parties > 1) await askClient('ownership_basis_request', { noteToClient: `We are asking again because ${p.reason}.` });
    }
    // Approved is the check: the report goes to the client as soon as it is signed off.
    // The report goes because a person approved it: sent and recorded as them. Effects run on the automation role,
    // which the database will not let write a report_on_title_sent (migration 071), so the approver's send leaves it.
    if (e.type === 'report_on_title_approved' && s.reportOnTitle.status === 'approved' && isUserActor(e.actor)) await safe('report on title send', () => (this.ports.asApprover ?? ((f) => f()))(() => this.sendReportOnTitle(tenantId, matterId, e.actor)));
    if (e.type === 'contracts_exchanged') {
      // Every buyer of a freehold is asked to insure from exchange; with a lender it is also a completion gate (exchange.md 4.9).
      if (side === 'buyer' && (s.hasLender || !isLeasehold(s)) && !s.preCompletion.insuranceConfirmedAt && !asked('buildings_insurance_request')) await askClient('buildings_insurance_request');
      if (!s.completion.statementGeneratedAt) await safe('completion statement draft', () => this.draftCompletionStatement(tenantId, matterId));
    }
    // Completion money is requested by a person (it names our verified client account: never automation); the Tasks list asks for it.
    // A remortgage's new lender needs buildings insurance confirmed: the client is asked once the case reaches pre-completion.
    if (to === 'pre_completion' && tt === 'remortgage' && s.hasLender && !s.preCompletion.insuranceConfirmedAt && !asked('buildings_insurance_request')) await askClient('buildings_insurance_request');
    if (e.type === 'funds_requested' && (e.payload as { fromRole?: string }).fromRole === 'client') await askClient('balance_request');
    if (e.type === 'mortgage_redeemed') await this.sendFirstRequest(tenantId, matterId, subflows, { to: 'lender', template: 'request_discharge' }, e);
  }

  /** A first request (or a request to the client) a step sends when it becomes due: proposed or sent per the trust level; a failure becomes a task. */
  private async sendFirstRequest(tenantId: string, matterId: string, subflows: LevelConfig, first: FirstRequest, e: EngineEvent, extra: Record<string, unknown> = {}): Promise<void> {
    const fresh = await this.getState(tenantId, matterId);
    const side = profileOf(fresh.transactionType ?? 'freehold_purchase').side;
    if (!first.buyerOnly || side === 'buyer') {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const leasehold = /leasehold/.test(fresh.transactionType ?? '');
      const price = fresh.purchasePricePennies;
      const context: Record<string, unknown> = {
        ...extra,
        eventType: e.type, payload: e.payload,
        leaseholdForms: leasehold ? ' and the Leasehold Information Form (TA7)' : '',
        completionDate: typeof p.completionDate === 'string' ? p.completionDate : fresh.exchange.completionDate ?? '',
        depositAmount: price ? ` (normally 10% of the price: £${Math.round(price / 1000).toLocaleString('en-GB')})` : '',
        transaction: side === 'seller' ? 'sale' : 'purchase',
      };
      const toClient = first.to === 'client';
      const detail = toClient
        ? { template: first.template, context, triggeredByEventId: e.id, ...(e.type === 'completion_statement_generated' && typeof p.documentId === 'string' ? { attachDocumentId: p.documentId } : {}) }
        : { kind: 'request', recipientRole: first.to, template: first.template, context, triggeredByEventId: e.id, optional: !!first.optional };
      const action: EngineAction = toClient ? 'client_update' : 'chase';
      const who = first.to === 'seller_solicitor' ? "the seller's solicitor" : first.to === 'estate_agent' ? 'the estate agent' : `the ${first.to}`;
      if (!(await this.proposeUnless(tenantId, matterId, subflows, action, first.template, `first:${first.template}:${e.id}`, detail, `${toClient ? 'CLIENT UPDATE' : 'REQUEST'}\n\nTo: ${who}\nTemplate: ${first.template}`))) {
        try { await this.perform(tenantId, matterId, action, detail); } catch (err) {
          if (first.optional && /no email address/i.test((err as Error).message)) this.ports.log(`${first.template}: nobody to tell`, err);
          else { this.ports.log(`${first.template} could not be sent`, err); await this.recordSendFailure(tenantId, matterId, action, detail, err); }
        }
      }
    }
  }

  /**
   * A contract with signatures on it. When every one of our clients has signed and it is undated, it is the
   * signed contract held for exchange; a part signed by only some of them, or dated, is a task to put right.
   * Signatures that are all the other side's are theirs (their signed part), and it is read as a contract.
   */
  private async signedContractReturned(tenantId: string, matterId: string, documentId: string, facts: ContractFacts): Promise<boolean> {
    const s = await this.getState(tenantId, matterId);
    if (s.exchange.exchangedAt || s.readiness.signedContractHeldAt) return false;
    const key = (n: string) => n.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
    const signedBy = facts.signedBy ?? [];
    // A client has signed when a signature carries their surname and their first name (or its initial).
    const signedByClient = (name: string) => { const want = key(name); if (!want.length) return false; const first = want[0], last = want[want.length - 1]; return signedBy.some((x) => { const have = key(x); return have.includes(last) && (want.length === 1 || have.some((w) => w === first || w === first[0])); }); };
    const clients = s.partyNames?.length ? s.partyNames : [];
    const ours = clients.filter(signedByClient);
    if (clients.length && !ours.length) return false; // the other side's signed part
    const missing = clients.filter((n) => !signedByClient(n));
    if (!missing.length && !facts.dated) {
      await this.run(tenantId, matterId, { type: 'signed_contract_held', actor: EXTERNAL, note: `Signed by ${signedBy.join(', ')}; undated`, completion: { documentId, checklist: { every_signatory: true, dated: true }, party: null, note: null, readDocument: null } } as never);
      return true;
    }
    const title = missing.length ? `Contract signed by ${ours.join(', ') || signedBy.join(', ')} only` : 'Signed contract came back dated';
    if (!Object.values(s.issues).some((i) => i.title === title && (i.status === 'open' || i.status === 'negotiating'))) {
      await this.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: 'document_execution_problem', title, detail: missing.length ? `Still to sign: ${missing.join(', ')}. Every client signs their part before we can exchange. [doc:${documentId}]` : `The contract is dated; it should be left undated until exchange. Ask for a fresh signed, undated part (or confirm the date is struck through). [doc:${documentId}]`, gate: 'exchange', severity: 'warning', documentId } as never);
    }
    return true;
  }

  /**
   * The contract as a task: on a purchase, once the case is at contract review (the searches, enquiries and
   * report are done), the latest contract on file goes on the Tasks tab to approve for signature, with what
   * the read found. Approving it is contract_approved: the deposit request and the signing pack follow.
   */
  private async raiseContractReview(tenantId: string, matterId: string, documentId?: string | null, facts?: ContractFacts | null): Promise<void> {
    const s = await this.getState(tenantId, matterId);
    const docId = documentId ?? s.readiness.contractDocumentId ?? null;
    if (!docId || profileOf(s.transactionType).side !== 'buyer') return;
    if (s.readiness.contractApprovedAt || s.exchange.exchangedAt || !['contract_review', 'pre_exchange'].includes(s.stage)) return;
    if (Object.values(s.decisions).some((d) => d.kind === 'contract' && d.status === 'pending' && d.sourceDocumentId === docId)) return;
    const f = facts ?? (this.ports.extractor.extractContract ? await this.ports.extractor.extractContract(await this.requireDoc(tenantId, matterId, docId)).catch(() => null) : null);
    const gbpOf = (p: number | null | undefined) => (p == null ? null : `£${(p / 100).toLocaleString('en-GB')}`);
    const terms = f ? [
      f.pricePennies != null ? `Price: ${gbpOf(f.pricePennies)}` : null,
      f.depositPennies != null ? `Deposit: ${gbpOf(f.depositPennies)}${f.depositHolder ? ` (held as ${f.depositHolder})` : ''}` : null,
      f.completionDate ? `Completion date: ${prettyDate(f.completionDate)}` : null,
      f.titleNumber ? `Title: ${f.titleNumber}` : null,
      f.sellers.length ? `Sellers: ${f.sellers.join(', ')}` : null,
      f.buyers.length ? `Buyers: ${f.buyers.join(', ')}` : null,
      f.incorporatedConditions ? `Conditions: ${f.incorporatedConditions}` : null,
    ].filter(Boolean) : [];
    const points = f?.flags ?? [];
    const mismatches = Object.values(s.issues).filter((i) => i.kind === 'document_mismatch' && (i.status === 'open' || i.status === 'negotiating'));
    const summary = [
      'CONTRACT FOR APPROVAL',
      '',
      ...(f ? [] : ['The contract could not be read: check it by hand before approving.', '']),
      ...terms,
      ...(points.length ? ['', `Points (${points.length}):`, ...points.map((p) => `• ${p.description}`)] : f ? ['', 'Nothing in the contract flagged.'] : []),
      ...(mismatches.length ? ['', 'Not matching the case:', ...mismatches.map((i) => `• ${i.title}`)] : []),
    ].join('\n');
    // The decision cites the contract itself, and each flagged point where the read found it.
    const citations = [{ documentId: docId, label: 'The contract' }, ...points.filter((p) => p.locator).map((p) => ({ documentId: docId, locator: p.locator, label: p.description }))];
    // The client's own sale funds this deposit (SCS 2.2.5): the gap between the two deposits is theirs to find before exchange (exchange.md 2.5, 8.7).
    if (s.relatedMatter?.relation === 'sale' && f?.depositPennies != null) {
      const sale = await this.getState(tenantId, s.relatedMatter.matterId).catch(() => null);
      const saleDeposit = sale?.deposit.contractPennies ?? null;
      if (saleDeposit != null && f.depositPennies > saleDeposit && !Object.values(s.issues).some((i) => i.title.startsWith('Deposit up the chain'))) {
        await this.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: 'deposit_issue', title: `Deposit up the chain: £${((f.depositPennies - saleDeposit) / 100).toLocaleString('en-GB')} more needed`, detail: `The sale's deposit (£${(saleDeposit / 100).toLocaleString('en-GB')}) can go towards this purchase's (£${(f.depositPennies / 100).toLocaleString('en-GB')}) under standard condition 2.2.5, if neither contract excludes it. The client tops up the difference before exchange; ask them for it now.`, gate: 'exchange', severity: 'warning' } as never).catch((err) => this.ports.log('deposit gap not raised', err));
      }
    }
    await this.run(tenantId, matterId, { type: 'raise_contract_review', documentId: docId, summary, citations, terms: f ? { ...f } : null });
  }

  /** A document behind the seller's forms (a policy, a permission, a certificate, a guarantee): read, and shown with the title. */
  async supportingDocumentReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    if (!this.ports.extractor.extractSupportingDocument) return { state: await this.getState(tenantId, matterId), events: [], warning: 'A supporting document: filed.' };
    const facts = await this.ports.extractor.extractSupportingDocument(doc);
    // The seller's own forms (TA6, TA7, TA10, TA13) are read as the forms, whatever they were filed as.
    if (/\bTA ?(6|7|10|13)\b|property information form|fittings and contents|leasehold information form|completion information form/i.test(`${facts.title} ${doc.fileName ?? ''}`)) return this.propertyFormsReceived(tenantId, matterId, documentId);
    return this.run(tenantId, matterId, { type: 'record_supporting_document', documentId, facts });
  }

  /** A title plan: read as the map it is, beside the register (never as the register), checked against it on the title step. */
  async titlePlanReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    if (!this.ports.extractor.extractTitlePlan) return { state: await this.getState(tenantId, matterId), events: [], warning: 'A title plan: filed with the title.' };
    const facts = await this.ports.extractor.extractTitlePlan(doc);
    return this.run(tenantId, matterId, { type: 'record_title_plan', documentId, facts });
  }

  async titleReceived(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    // Another copy of the official copies is filed, not read; reading the same document again (Read Again) goes through.
    if ((await this.getState(tenantId, matterId)).title.documentId !== documentId && (await this.alreadyHave(tenantId, matterId, 'official_copies', null))) {
      this.ports.log('official copies already on the case; duplicate ignored', { matterId, documentId });
      return { state: await this.getState(tenantId, matterId), events: [], warning: 'Official copies are already on the case; this copy was filed but not read again.' };
    }
    const doc = await this.requireDoc(tenantId, matterId, documentId);
    const facts: TitleFacts = await this.ports.extractor.extractTitle(doc).catch((err) => {
      this.ports.log('title extraction failed — routing to human', err);
      return { titleNumber: 'unknown', tenure: 'unknown' as const, restrictions: [], charges: [], covenants: [], confidence: 0 };
    });
    // A title plan filed as the title: it is read as a plan, and never stands in for the register.
    if (facts.planOnly) return this.titlePlanReceived(tenantId, matterId, documentId);
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
    input: { text: string; kind: NoteKind; actor: string; documentId?: string | null; durationSeconds?: number | null; noteId?: string | null; from?: NoteSender | null; attachments?: string[]; /** Filed without anyone looking: it always comes to a person. */ surface?: boolean; /** Both checks read it as a pure acknowledgement. */ acknowledgement?: boolean; /** The email's subject, for the reply. */ subject?: string | null }
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
      .extract({ tenantId, matterId, text: input.text, kind: input.kind, from: input.from ?? null, attachments: input.attachments ?? [], waits: input.from?.relation === 'client' ? openWaits(recorded.state).filter((w) => this.owedByClient(w.key, w.subject)).map((w) => ({ waitKey: w.key, subject: w.subject ?? '', label: WAIT_LABEL[w.key] })) : [], context: await this.replyContext(tenantId, matterId, recorded.state, input.from ?? null).catch(() => undefined), now: this.ports.now().toISOString(), caseLine: `${brief.transactionLabel}, ${brief.lifecycleLabel.toLowerCase()}` })
      .catch((err) => {
        this.ports.log('note extraction failed — the note is still on the file', err);
        return [];
      });
    const stranger = input.kind === 'email' && (input.from?.relation ?? 'unknown') === 'unknown';
    // An email that brings files is not evidence that those files are missing: whatever the reader
    // made of "attached", an "it has not arrived" issue is not proposed from it.
    const read = input.attachments?.length ? drafts.filter((d) => !(d.command?.type === 'raise_issue' && ARRIVAL_ISSUES.has(d.command.kind))) : drafts;
    // A document the client (or a colleague) asks for is read by rule too: the file is attached to the reply even when the AI missed the request.
    const asked = input.kind === 'email' && (input.from?.relation === 'client' || input.from?.relation === 'colleague') && !read.some((d) => d.command?.type === 'send_file_copy') ? documentRequests(input.text) : [];
    // So is a client asking for attachments instead of a secure link.
    const pref = input.kind === 'email' && (input.from?.relation === 'client' || input.from?.relation === 'colleague') && !read.some((d) => d.command?.type === 'set_file_delivery') && (recorded.state.fileDelivery ?? 'link') === 'link' ? attachmentPreference(input.text) : null;
    const kept = [...read.filter((d) => !asked.some((a) => a.quote === d.quote && !d.command)), ...asked, ...(pref ? [pref] : [])];
    if (!kept.length && !stranger && !input.surface) return recorded;
    // Whoever wrote gets a reply answering every point, and anyone else who needs to hear gets a message (recipients.ts), all on this one task.
    const messages = input.kind === 'email' && input.from && !input.acknowledgement ? await this.draftMessages(tenantId, matterId, recorded.state, input.text, input.subject ?? null, input.from, kept).catch((err) => { this.ports.log('the messages could not be drafted', err); return []; }) : [];
    return this.run(tenantId, matterId, { type: 'note_extracted', noteId, drafts: kept, extractor: reader.name, surface: !!input.surface || messages.length > 0, ...(input.acknowledgement ? { acknowledgement: true } : {}), ...(messages.length ? { messages } : {}) });
  }

  /** Whether a wait is the client's to meet (their forms, money, signatures), not a third party's. */
  private owedByClient(key: WaitKey, subject: string | null): boolean {
    if (key === 'funds') return subject !== 'lender';
    return ['id_check', 'proof_of_funds', 'property_forms', 'signed_documents', 'deposit', 'client_decision', 'insurance', 'mortgage_offer', 'survey'].includes(key);
  }

  /** Every message an email's task carries: the reply to the writer and a message to each party the rules say must hear (recipients.ts), each drafted from the case. */
  private async draftMessages(tenantId: string, matterId: string, state: MatterState, text: string, subject: string | null, from: NoteSender, lines: NoteActionDraft[]): Promise<NoteMessage[]> {
    const out: NoteMessage[] = [];
    const now = this.ports.now();
    const facts = replyFacts(state, now);
    const property = (await this.caseRecord(tenantId, matterId).catch(() => null))?.propertyAddress ?? null;
    const recipients = whoNeedsToHear(from, lines);
    // A document the client asked for goes back attached to the reply, when it is on the file.
    const attach: MessageAttachment[] = [];
    if (this.ports.files && (from.relation === 'client' || from.relation === 'colleague')) {
      for (const l of lines) {
        if (l.command?.type !== 'send_file_copy') continue;
        const what = l.command.what;
        const found = await this.requestedFiles(tenantId, matterId, state, what);
        for (const f of found) if (!attach.some((a) => a.id === f.id)) attach.push({ id: f.id, fileName: f.fileName, what });
      }
    }
    // "The link won't open": the files of the last link go again, attached.
    if (!attach.length && this.ports.fileShares && lines.some((l) => l.command?.type === 'set_file_delivery' && l.command.mode === 'attachments')) {
      for (const f of await this.ports.fileShares.latest(tenantId, matterId).catch(() => [])) attach.push({ id: f.id, fileName: f.fileName, what: '' });
    }
    // The reply says who else we are writing to (those ticked when the task opens).
    const others = recipients.filter((x) => x.on && !x.purposes.some((p) => /^Reply to their email/.test(p))).map((x) => PARTY_WORDS[x.to]);
    for (const r of recipients) {
      const replying = r.purposes.some((p) => /^Reply to their email/.test(p));
      if (replying && r.to === 'client') {
        const reply = await this.draftReply(tenantId, matterId, state, text, subject, from, lines, others, { purposes: r.purposes, sentences: r.sentences }, attach);
        const attachedNow = lines.some((l) => l.command?.type === 'set_file_delivery' && l.command.mode === 'attachments') || state.fileDelivery === 'attachments';
        out.push({ id: 'reply', to: r.to, purposes: r.purposes, subject: reply.subject, body: reply.body, drafter: reply.drafter, on: true, ...(attach.length ? { attach, ...(attachedNow ? { asAttachments: true } : {}) } : {}) });
        continue;
      }
      const re = subject ? (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`) : 'Re: your email';
      const title = replying ? re : property ?? "Our client's transaction";
      // The other side and the agent are written to from what may be shared with them, never from the client's brief.
      const toThem = r.to === 'seller_solicitor' || r.to === 'estate_agent';
      const partyFacts = toThem ? renderCounterpartyFacts(state, now, r.to as 'seller_solicitor' | 'estate_agent') : facts;
      const drafted = this.ports.replyDrafter ? await this.ports.replyDrafter.draft({ tenantId, matterId, email: text, subject: subject ?? '', from, firstName: (from.name ?? '').trim().split(/\s+/)[0] || null, lines: lines.map((l) => ({ kind: l.kind, summary: l.summary, quote: l.quote })), facts: partyFacts, now: now.toISOString(), to: r.to, purposes: r.purposes, weActFor: weActFor(state) }).catch(() => null) : null;
      const body = drafted?.body || (r.to === 'client' ? templateReply(state, now, { firstName: null, lines: [] }) : replying && toThem ? templateCounterpartyUpdate(state, now, r.to as 'seller_solicitor' | 'estate_agent', property) : templateMessage(state, r.to, r.sentences, property));
      out.push({ id: replying ? 'reply' : `msg:${r.to}`, to: r.to, purposes: r.purposes, subject: title, body, drafter: drafted?.body ? this.ports.replyDrafter!.name : 'case-facts', on: r.on });
    }
    return out;
  }

  /**
   * The files a client means when they ask for a document. The report on title is the one they were
   * sent (the approved draft, which goes again as the Word document); nothing if it has not gone yet.
   * Anything else is found on the file by what they call it (file-finder.ts).
   */
  private async requestedFiles(tenantId: string, matterId: string, state: MatterState, what: string): Promise<Array<{ id: string; fileName: string }>> {
    if (/report on (the )?title|\brot\b/i.test(what)) {
      const r = state.reportOnTitle;
      return r.draftDocumentId && (r.sentAt || r.interimSentAt) ? [{ id: r.draftDocumentId, fileName: 'Report on title.docx' }] : [];
    }
    return this.ports.files ? this.ports.files.find(tenantId, matterId, what).catch(() => []) : [];
  }

  /** The reply to a client's email, from the case facts (reply.ts); worded by the drafter when there is one. */
  private async draftReply(tenantId: string, matterId: string, state: MatterState, text: string, subject: string | null, from: NoteSender, lines: NoteActionDraft[], others: string[] = [], also: { purposes: string[]; sentences: string[] } = { purposes: [], sentences: [] }, attach: MessageAttachment[] = []): Promise<NoteReply> {
    const now = this.ports.now();
    const asked = lines.filter((l) => l.command?.type === 'send_file_copy').map((l) => (l.command as { what: string }).what);
    const missing = asked.filter((w) => !attach.some((a) => a.what === w));
    const attached = [
      ...(attach.length ? [`Say that ${attach.map((a) => a.fileName).join(', ')} ${attach.length > 1 ? 'are' : 'is'} with this email (it is: a secure link or an attachment is added below the message; do not say which, and never say we will send it separately, later or by another email). Mention no other document`] : []),
      ...missing.map((w) => `They asked for ${w}: it is NOT attached. Do not say it is attached, resent or on its way; say we will send it to them as soon as we can`),
    ];
    const firstName = (from.name ?? '').trim().split(/\s+/)[0] || null;
    const re = subject ? (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`) : 'Re: your email';
    const drafted = this.ports.replyDrafter ? await this.ports.replyDrafter.draft({ tenantId, matterId, email: text, subject: subject ?? '', from, firstName, lines: lines.map((l) => ({ kind: l.kind, summary: l.summary, quote: l.quote })), facts: replyFacts(state, now), now: now.toISOString(), weActFor: weActFor(state), purposes: [...new Set(['Reply to their email, answering every point they made', ...attached, ...also.purposes, ...others.map((o) => `Tell them we are writing to ${o} today`)])] }) : null;
    // A reply may not say a document is attached or being resent unless it is attached: then it is the reply from the facts.
    const falseClaim = !!drafted?.body && missing.length > 0 && !attach.length && /\b(attach(ed|ing)?|re-?send(ing)?|resent|send (it|this|them) (again|to you|through|over))\b/i.test(drafted.body);
    if (drafted?.body && !falseClaim) return { subject: re, body: drafted.body, drafter: this.ports.replyDrafter!.name };
    return { subject: re, body: templateReply(state, now, { firstName, others, also: also.sentences, attached: attach, lines: lines.map((l, i) => ({ id: `A${i + 1}`, kind: l.kind, summary: l.summary, quote: l.quote, confidence: l.confidence ?? 0.6, command: l.command ?? null })) }), drafter: 'case-facts' };
  }

  /** The draft for one of an issue's message steps (issues.ts `issueSteps`), from the case; worded by the drafter when there is one. Nothing is sent. */
  async draftIssueMessage(tenantId: string, matterId: string, issueId: string, stepId: string): Promise<{ to: MessageParty; subject: string; body: string; drafter: string }> {
    const state = await this.getState(tenantId, matterId);
    const issue = state.issues[issueId];
    if (!issue) throw Object.assign(new Error('Issue not found.'), { status: 404 });
    const side = profileOf(state.transactionType).side;
    const step = issueSteps(issue.kind, side === 'seller' ? 'seller' : 'buyer', issue.event).find((x) => x.id === stepId);
    if (!step || step.kind !== 'message') throw Object.assign(new Error('That step does not write to anyone.'), { status: 400 });
    const now = this.ports.now();
    const rec = await this.caseRecord(tenantId, matterId).catch(() => null);
    const property = rec?.propertyAddress ?? null;
    const clientName = (side === 'seller' ? rec?.sellerNames : rec?.buyerNames)?.[0] ?? state.partyNames?.[0] ?? null;
    const firstName = clientName?.trim().split(/\s+/)[0] || null;
    // As every letter we send is headed: the property, what it is about, our reference (the other side files by it).
    const ref = rec?.matterRef ? ` (our ref ${rec.matterRef})` : '';
    const topic = ISSUE_KIND_SPEC[issue.kind]?.label ?? 'a point on the transaction';
    const subject = step.to === 'client'
      ? `${property ? `Your ${side === 'seller' ? 'sale' : side === 'buyer' ? 'purchase' : 'property'}: ${property}` : 'Your transaction'} — an update${ref}`
      : `${property ?? 'Our client\'s transaction'} — ${topic.charAt(0).toUpperCase()}${topic.slice(1)}${ref}`;
    const about = `THE ISSUE ON THE CASE (DATA): ${issue.title}${issue.detail ? `\n${issue.detail}` : ''}`;
    const drafted = this.ports.replyDrafter ? await this.ports.replyDrafter.draft({ tenantId, matterId, email: about, subject, from: null, firstName, lines: [], facts: step.to === 'seller_solicitor' || step.to === 'estate_agent' ? renderCounterpartyFacts(state, now, step.to) : replyFacts(state, now), now: now.toISOString(), to: step.to, purposes: [step.purpose], weActFor: weActFor(state) }).catch(() => null) : null;
    if (drafted?.body) return { to: step.to, subject, body: drafted.body, drafter: this.ports.replyDrafter!.name };
    return { to: step.to, subject, body: templateIssueMessage(state, step.to, { sentence: step.sentence, issueTitle: issue.title.replace(/\s*\[[a-z-]+:[^\]]*\]/g, ''), firstName, property }), drafter: 'case-facts' };
  }

  /** Send a message about an issue, as the person wrote it, and log it on the issue. A failed send is said to the person there and then (nothing is logged). */
  async sendIssueMessage(tenantId: string, matterId: string, issueId: string, input: { actor: string; to: MessageParty; subject: string; body: string }): Promise<RunResult> {
    const state = await this.getState(tenantId, matterId);
    const issue = state.issues[issueId];
    if (!issue || (issue.status !== 'open' && issue.status !== 'negotiating')) throw Object.assign(new Error('That issue is not open.'), { status: 400 });
    if (!input.body.trim()) throw Object.assign(new Error('The message is empty.'), { status: 400 });
    const trigger = `issue_message:${issueId}:${this.ports.now().toISOString()}`;
    const [action, detail] = input.to === 'client'
      ? ['client_update' as const, { template: 'email_reply', context: { subject: input.subject }, triggeredByEventId: trigger, edited: { subject: input.subject, body: input.body } }]
      : ['chase' as const, { kind: 'party_message', recipientRole: input.to, subject: input.subject, body: input.body, triggeredByEventId: trigger }];
    await this.perform(tenantId, matterId, action, detail);
    return this.run(tenantId, matterId, { type: 'update_issue', actor: input.actor, issueId, status: issue.status === 'negotiating' ? 'negotiating' : 'open', note: `Emailed ${PARTY_LABEL[input.to].toLowerCase()}: ${input.subject}` });
  }

  // ───────────── decisions (dashboard #6) ─────────────

  /** The handler opened the source. Logged, and a precondition of resolving. Returns the document so the UI can show it. */
  async openDecisionSource(tenantId: string, matterId: string, decisionEventId: string, userId: string, documentId?: string | null): Promise<{ document: DocumentRef; result: RunResult }> {
    const state = await this.getState(tenantId, matterId);
    const d = state.decisions[decisionEventId];
    const docId = documentId ?? d?.sourceDocumentId;
    if (!docId) throw Object.assign(new Error('Decision not found.'), { status: 404 });
    const document = await this.requireDoc(tenantId, matterId, docId);
    // Opening the source again changes nothing on the case (the audit log still records each open): no write, no lock.
    if (d && d.status === 'pending' && d.openedBy.includes(userId) && docId === d.sourceDocumentId) return { document, result: { events: [], state } };
    const result = await this.run(tenantId, matterId, { type: 'open_decision_source', userId, decisionEventId, documentId: docId });
    return { document, result };
  }

  async resolveDecision(tenantId: string, matterId: string, decisionEventId: string, userId: string, option: DecisionOption, note?: string | null, verification?: { method: string; reference?: string | null } | null, engagement?: Engagement | null, selection?: string[] | null, edited?: { subject?: string | null; body?: string | null; /** An email's task: each message as the person edited it. */ messages?: Array<{ id: string; subject?: string | null; body?: string | null }> | null } | null, escalateTo?: string | null): Promise<RunResult> {
    return this.run(tenantId, matterId, { type: 'resolve_decision', userId, decisionEventId, option, note: note ?? null, verification: verification ?? null, engagement: engagement ?? null, selection: selection ?? null, edited: edited ?? null, escalateTo: escalateTo ?? null });
  }

  /**
   * Addendum 2: bank details arrive (email, portal, phone note, letter…). The source is the
   * document they arrived on; a manually keyed set gets a generated note as its source so
   * the decision still cites something. Always a hard-stop decision, first time included.
   */
  async recordBankDetails(tenantId: string, matterId: string, input: { actor: string; /** Who keyed them in, as the note names them. */ actorName?: string | null; payeeKind: PayeeKind; payeeRef?: string | null; details: BankDetails; sourceChannel: SourceChannel; sourceDocumentId?: string | null; note?: string | null }): Promise<RunResult> {
    let sourceDocumentId = input.sourceDocumentId ?? null;
    if (!sourceDocumentId) {
      const doc = await this.ports.documents.createGenerated({
        tenantId,
        matterId,
        docType: 'BANK_DETAILS_NOTE',
        fileName: readableName(`Bank details for the ${input.payeeKind.replace(/_/g, ' ')}`, this.ports.now()),
        content: [`Bank details keyed in by ${input.actorName || 'a member of the firm'} (received by ${input.sourceChannel.replace(/_/g, ' ')}) on ${this.ports.now().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' })}`, `Payee: ${input.payeeKind.replace(/_/g, ' ')}${input.payeeRef ? ` — ${input.payeeRef}` : ''}`, `Account name: ${input.details.accountName}`, `Sort code: ${input.details.sortCode}  Account: ${input.details.accountNumber}`, input.details.firmName ? `Firm: ${input.details.firmName}` : '', input.note ? `Note: ${input.note}` : ''].filter(Boolean).join('\n'),
      });
      sourceDocumentId = doc.id;
    }
    return this.run(tenantId, matterId, { type: 'record_bank_details', actor: input.actor, bankDetailsId: `bd-${this.ports.newId()}`, payeeKind: input.payeeKind, payeeRef: input.payeeRef ?? null, details: input.details, sourceChannel: input.sourceChannel, sourceDocumentId });
  }

  // ───────────── report on title (AI-drafting-heavy; never auto-sent) ─────────────

  /** Title, searches and enquiries are all resolved: the report on title is drafted for approval, once. */
  private draftingReport = new Set<string>();
  private async draftReportWhenReady(tenantId: string, matterId: string): Promise<void> {
    const key = `${tenantId}:${matterId}`;
    if (this.draftingReport.has(key)) return;
    this.draftingReport.add(key);
    try {
      if (!reportReady(await this.getState(tenantId, matterId))) return;
      await this.draftReportOnTitle(tenantId, matterId);
    } catch (err) {
      this.ports.log('report on title could not be drafted automatically', err);
    } finally {
      this.draftingReport.delete(key);
    }
  }

  async draftReportOnTitle(tenantId: string, matterId: string): Promise<RunResult> {
    const state = await this.getState(tenantId, matterId);
    // Already drafted (the engine drafts it once title, searches and enquiries are resolved): nothing more to do.
    if (state.reportOnTitle.status === 'drafted') return { state, events: [] };
    // Would the engine take a draft now? Asked before anything is written (and before the drafter is paid for):
    // a refused draft used to leave its document behind, one per try.
    { const why = reportDraftProblem(state); if (why) throw Object.assign(new Error(why), { status: 409 }); }
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
    // Every point found on the title, the searches and the lease reaches the client (property.md 9.4).
    const points = Object.values(state.issues).filter((i) => i.status !== 'withdrawn' && i.finding).map((i) => i.title);
    const missing = pointsNotInReport(draft.content, points);
    if (missing.length) summary = `${summary}\nNot yet in the report (add or say why not): ${missing.join('; ')}.`;
    const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'REPORT_ON_TITLE_DRAFT', fileName: readableName(state.reportOnTitle.interim || state.stage === 'pre_contract' ? 'Report on title (interim draft)' : 'Report on title (draft)', this.ports.now()), content });
    if (check && this.ports.documents.writeDraftCheck) await this.ports.documents.writeDraftCheck(tenantId, doc.id, check).catch(() => {});
    const citations = [...draft.citations];
    for (const f of check?.cited ?? []) if (!citations.some((c) => c.documentId === f.documentId && c.locator?.quote === (f.quote ?? undefined))) citations.push({ documentId: f.documentId, label: `${f.documentLabel}${f.page ? ` p.${f.page}` : ''} — ${f.key.replace(/^[a-z_]+\./, '').replace(/[._]/g, ' ')}: ${f.value}`, locator: { page: f.page ?? undefined, quote: f.quote ?? undefined } });
    return this.run(tenantId, matterId, { type: 'draft_report_on_title', draftId, draftDocumentId: doc.id, model: draft.model, summary, citations, basedOn: draft.basedOn });
  }

  /**
   * Our notice to complete (SCS 6.8; exchange.md 7.3): drafted under Documents for the person to check, sign and serve.
   * Ten working days after the day it is served, our client being ready, able and willing to complete.
   */
  async draftNoticeToComplete(tenantId: string, matterId: string): Promise<{ documentId: string }> {
    const s = await this.getState(tenantId, matterId);
    if (!s.exchange.exchangedAt || s.completion.confirmedAt) throw Object.assign(new Error('A notice to complete follows exchange and a missed completion.'), { status: 409 });
    if (!s.exchange.completionDate || Date.parse(s.exchange.completionDate) > this.ports.now().getTime()) throw Object.assign(new Error('The completion date has not passed yet.'), { status: 409 });
    const record = await this.caseRecord(tenantId, matterId).catch(() => null);
    const side = profileOf(s.transactionType).side === 'seller' ? 'seller' : 'buyer';
    const other = side === 'seller' ? 'buyer' : 'seller';
    const content = [
      'NOTICE TO COMPLETE (DRAFT — check, sign and serve)',
      '',
      `Property: ${record?.propertyAddress ?? '[PROPERTY]'}`,
      `Contract dated: ${prettyDate(s.exchange.exchangedAt.slice(0, 10))}`,
      `Contractual completion date: ${s.exchange.completionDate ? prettyDate(s.exchange.completionDate) : 'not set'}`,
      '',
      `To the ${other} and their solicitors.`,
      '',
      `We act for the ${side}. Completion did not take place on the contractual completion date. Our client is ready, able and willing to complete. We give you notice under standard condition 6.8 of the Standard Conditions of Sale (as incorporated in the contract) to complete the contract in accordance with that condition.`,
      '',
      `Completion must take place within ten working days, excluding the day of service. Time is of the essence of this notice.`,
      '',
      'Dated: [DATE OF SERVICE]',
      'Signed: [SOLICITOR], for the ' + side,
      '',
      'Check before serving: the contract incorporates the standard conditions and has not changed the notice period; our client can complete on the day (money, deeds, vacant possession); serve as the contract allows and record the time of service.',
    ].join('\n');
    const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'NOTICE_TO_COMPLETE', fileName: readableName('Notice to complete', this.ports.now()), content });
    return { documentId: doc.id };
  }

  /** The price and deposit the contract states, from the register (null when it has not been read). */
  async contractTerms(tenantId: string, matterId: string): Promise<{ pricePennies: number | null; depositPennies: number | null }> {
    const register = this.ports.documents.loadRegister ? await this.ports.documents.loadRegister(tenantId, matterId).catch(() => null) : null;
    const num = (key: string) => { const f = register?.facts.find((x) => x.key === key && /^\d+$/.test(x.value.trim())); return f ? Number(f.value) : null; };
    return { pricePennies: num('contract.price_pennies'), depositPennies: num('contract.deposit_pennies') };
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
    const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'COMPLETION_STATEMENT', fileName: readableName('Completion statement', this.ports.now()), content });
    if (this.ports.documents.writeDraftCheck) await this.ports.documents.writeDraftCheck(tenantId, doc.id, check).catch(() => {});
    const warning = `Completion statement drafted under Documents: ${draftCheckLine(check)}${built.toConfirm.length ? ` ${built.toConfirm.length} line${built.toConfirm.length === 1 ? '' : 's'} for you to fill in.` : ''}`;
    return { state, events: [], warning, documentId: doc.id };
  }

  /** The case record as the drafters see it: what the matter row says about the parties, the property and the price. */
  /**
   * One client's sale and purchase, linked both ways at once: each holds exchange until the
   * other can exchange too, the completion dates must agree, and the purchase does not complete
   * before the sale whose money funds it. Refused when the other file is not this firm's, is on
   * the same side, is already linked elsewhere, or has exchanged.
   */
  async linkChain(tenantId: string, matterId: string, otherId: string, actor: string, note: string | null = null): Promise<RunResult> {
    if (otherId === matterId) throw Object.assign(new Error('A case cannot be linked to itself.'), { status: 400 });
    const [here, there] = await Promise.all([this.getState(tenantId, matterId), this.getState(tenantId, otherId)]);
    if (!there.enrolled) throw Object.assign(new Error('That case is not on the system yet (not enrolled).'), { status: 409 });
    const sideHere = profileOf(here.transactionType ?? 'freehold_purchase').side;
    const sideThere = profileOf(there.transactionType ?? 'freehold_purchase').side;
    if (!((sideHere === 'buyer' && sideThere === 'seller') || (sideHere === 'seller' && sideThere === 'buyer'))) throw Object.assign(new Error('A chain links a sale to a purchase; these two are on the same side.'), { status: 409 });
    if (here.relatedMatter && here.relatedMatter.matterId !== otherId) throw Object.assign(new Error('This case is already linked to another; unlink it first.'), { status: 409 });
    if (there.relatedMatter && there.relatedMatter.matterId !== matterId) throw Object.assign(new Error('That case is already linked to another; unlink it first.'), { status: 409 });
    if (here.exchange.exchangedAt || there.exchange.exchangedAt) throw Object.assign(new Error('One of the two has exchanged; linking now changes nothing.'), { status: 409 });
    const kind = (side: string) => (side === 'seller' ? 'sale' : 'purchase') as 'sale' | 'purchase';
    let result: RunResult = { state: here, events: [] };
    if (!here.relatedMatter) result = await this.run(tenantId, matterId, { type: 'link_related_matter', actor: actor as Actor, relatedMatterId: otherId, relation: kind(sideThere), note });
    if (!there.relatedMatter) await this.run(tenantId, otherId, { type: 'link_related_matter', actor: actor as Actor, relatedMatterId: matterId, relation: kind(sideHere), note });
    return result;
  }

  /** Both sides unlinked together; their chain holds are withdrawn. */
  async unlinkChain(tenantId: string, matterId: string, actor: string, reason: string): Promise<RunResult> {
    const here = await this.getState(tenantId, matterId);
    const otherId = here.relatedMatter?.matterId ?? null;
    const result = await this.run(tenantId, matterId, { type: 'unlink_related_matter', actor: actor as Actor, reason });
    if (otherId) {
      const there = await this.getState(tenantId, otherId).catch(() => null);
      if (there?.relatedMatter?.matterId === matterId && !there.exchange.exchangedAt) await this.run(tenantId, otherId, { type: 'unlink_related_matter', actor: actor as Actor, reason }).catch((err) => this.ports.log('the other side of the chain could not be unlinked', err));
    }
    return result;
  }

  /** The purchase waits for the sale that funds it: the sale completes first, the same day. */
  /** A client's sale completes only when their purchase can complete the same day: otherwise they are left with nowhere to live (exchange.md 8.4). */
  private async assertLinkedPurchaseReady(tenantId: string, matterId: string): Promise<void> {
    const state = await this.getState(tenantId, matterId);
    if (state.relatedMatter?.relation !== 'purchase') return;
    const purchase = await this.getState(tenantId, state.relatedMatter.matterId).catch(() => null);
    if (!purchase || purchase.completion.confirmedAt || purchase.abandoned) return;
    // The sale's proceeds pay for the purchase, so its payment follows the sale; what must already be in is the advance, and the purchase on its last stage.
    const missing = [
      purchase.stage !== 'pre_completion' && 'the purchase at its completion stage',
      purchase.hasLender && !(purchase.completion.receivedFrom ?? []).includes('lender') && "the purchase's mortgage advance",
    ].filter(Boolean);
    if (missing.length) throw Object.assign(new Error(`Cannot confirm the sale yet: the client's linked purchase is not ready to complete today (${missing.join(', ')}). Completing the sale alone leaves them without a home.`), { status: 409 });
  }

  private async assertLinkedSaleCompleted(tenantId: string, matterId: string): Promise<void> {
    const state = await this.getState(tenantId, matterId);
    if (state.relatedMatter?.relation !== 'sale') return;
    const sale = await this.getState(tenantId, state.relatedMatter.matterId).catch(() => null);
    if (sale && !sale.completion.confirmedAt) throw Object.assign(new Error("Cannot confirm completion: the client's linked sale has not completed, and its proceeds fund this purchase. Confirm the sale's completion first."), { status: 409 });
  }

  private async assertLinkedMatterReady(tenantId: string, matterId: string, actor: Actor, completionDate?: string): Promise<void> {
    const state = await this.getState(tenantId, matterId);
    const link = state.relatedMatter;
    if (!link) return;
    const other = await this.getState(tenantId, link.matterId).catch(() => null);
    if (!other) throw Object.assign(new Error(`The linked ${link.relation} (${link.matterId}) cannot be read; unlink it or check the matter.`), { status: 409 });
    const ready = !!other.exchange.exchangedAt || (other.stage === 'pre_exchange' && other.exchange.conditionsMet && !other.abandoned);
    // Exchanged on the other side already: this side must complete the same day.
    if (other.exchange.exchangedAt && completionDate && other.exchange.completionDate && other.exchange.completionDate !== completionDate) throw Object.assign(new Error(`Cannot exchange: the linked ${link.relation} completes on ${other.exchange.completionDate}; the two must complete the same day.`), { status: 409 });
    if (!ready) throw Object.assign(new Error(`Cannot exchange: the linked ${link.relation} is at "${other.stage}"${other.exchange.conditionsMet ? '' : ' and its exchange conditions are not met'}; exchange is simultaneous.`), { status: 409 });
    for (const i of Object.values(state.issues)) {
      if (i.kind === 'chain_dependency' && i.title.startsWith('Linked ') && (i.status === 'open' || i.status === 'negotiating')) await this.run(tenantId, matterId, { type: 'resolve_issue', actor, issueId: i.id, resolution: 'other', note: `The linked ${link.relation} is ready to exchange (${other.exchange.exchangedAt ? 'exchanged' : 'conditions met'}); exchanging together.` });
    }
  }

  private async caseRecord(tenantId: string, matterId: string): Promise<{ matterRef: string | null; propertyAddress: string | null; purchasePricePennies: number | null; buyerNames: string[]; sellerNames: string[] } | null> {
    try {
      const { loadCaseRecord } = await import('./crosscheck-run');
      const r = await loadCaseRecord(tenantId, matterId);
      return r ? { matterRef: r.matterRef ?? null, propertyAddress: r.propertyAddress, purchasePricePennies: r.purchasePricePennies, buyerNames: r.buyerNames, sellerNames: r.sellerNames } : null;
    } catch { return null; }
  }

  /** Send the APPROVED report. The machine's invariant is checked before any I/O and again when recording. */
  async sendReportOnTitle(tenantId: string, matterId: string, actor: string): Promise<RunResult> {
    const state = await this.getState(tenantId, matterId);
    const draftId = state.reportOnTitle.draftId ?? '';
    // It goes by itself once approved: a later Send finds it gone and does nothing.
    if (state.reportOnTitle.status === 'sent' && state.reportOnTitle.draftId === draftId && state.reportOnTitle.sentAt) return { state, events: [] };
    assertCanSendReport(state, draftId);
    const doc = await this.requireDoc(tenantId, matterId, state.reportOnTitle.draftDocumentId as string);
    // As a secure link, unless this client asked for attachments.
    const made = state.fileDelivery !== 'attachments' && this.ports.fileShares ? await this.ports.fileShares.create({ tenantId, matterId, files: [{ id: doc.id, fileName: 'Report on title.docx' }] }).catch((err) => { this.ports.log('secure link could not be made; attaching instead', err); return null; }) : null;
    const link = made ? { url: made.url, files: ['Report on title.docx'] } : null;
    const sent = await this.ports.clientComms.sendReportOnTitle({ tenantId, matterId, draftDocument: doc, ...(link ? { link } : {}) });
    return this.run(tenantId, matterId, { type: 'record_report_on_title_sent', actor, draftId, channel: sent.channel, messageId: sent.messageId });
  }

  // ───────────── timers (2.6) ─────────────

  /** One matter's timer sweep: send due chases, raise due escalations. */
  async tick(tenantId: string, matterId: string, now = this.ports.now()): Promise<{ chases: number; escalations: number }> {
    return this.asAutomation(() => this.tickInner(tenantId, matterId, now));
  }

  private async tickInner(tenantId: string, matterId: string, now: Date): Promise<{ chases: number; escalations: number }> {
    let state = await this.getState(tenantId, matterId);
    // Manual handling does not stop the clock: chases due are proposed to the person who has the case.
    if (!state.enrolled || state.abandoned || state.closedAt) return { chases: 0, escalations: 0 };
    const sla = await this.store.loadSla(tenantId);
    const subflows = await this.levels(tenantId);
    let chases = 0;
    let escalations = 0;
    // Time as a source of events (docs/case-model.md §6): offer expiry, aged waits, sitting issues — first, so the deadlines below see the result.
    let timed = 0;
    for (const t of timedIssueActions(state, now)) {
      try {
        if (t.kind === 'raise') await this.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: t.issueKind, title: t.title, detail: t.detail, severity: t.severity, ...(t.gate ? { gate: t.gate } : {}), ...(t.resolveBy ? { resolveBy: t.resolveBy } : {}) });
        else if (t.kind === 'escalate') await this.run(tenantId, matterId, { type: 'set_issue_severity', actor: SYSTEM, issueId: t.issueId, severity: t.severity, reason: t.reason });
        else if (t.kind === 'resolve') await this.run(tenantId, matterId, { type: 'resolve_issue', actor: SYSTEM, issueId: t.issueId, resolution: t.resolution, note: t.note });
        else if (t.kind === 'merge') {
          // The earlier issue keeps the stronger hold and a note of the report; the later one is withdrawn as its duplicate.
          const later = state.issues[t.issueId], earlier = state.issues[t.into];
          const rank = { none: 0, completion: 1, exchange: 2 } as const;
          await this.run(tenantId, matterId, { type: 'update_issue', actor: SYSTEM, issueId: t.into, status: earlier.status === 'negotiating' ? 'negotiating' : 'open', note: `Reported again: ${later.title}`, ...(rank[later.gate] > rank[earlier.gate] ? { gate: later.gate } : {}) });
          await this.run(tenantId, matterId, { type: 'withdraw_issue', actor: SYSTEM, issueId: t.issueId, reason: `Duplicate of ${t.into}: merged into it.` });
        }
        else if (t.kind === 'offer_expired' && (state.mortgage.status === 'cleared' || state.mortgage.status === 'reviewed')) await this.run(tenantId, matterId, { type: 'mortgage_offer_withdrawn', actor: SYSTEM, reason: `Offer expired on ${t.expiryDate} (timer)` });
        timed += 1;
      } catch (err) {
        this.ports.log(`timed issue failed (${t.kind})`, err);
      }
    }
    if (timed) state = await this.getState(tenantId, matterId);
    // A deed ready to sign that has not gone (the case was already past the moment that sends it): it goes now.
    if (deedsReadyToSign(state).some((d) => !deedSigned(state, d) && !state.signing.documents.includes(d))) {
      await this.proposeSigningPack(tenantId, matterId, subflows).catch((err) => this.ports.log('signing pack catch-up failed', err));
      state = await this.getState(tenantId, matterId);
    }
    // Deadlines we owe (offer expiry, SDLT, notice to complete, requisitions): raised once, in time, with a dossier.
    for (const d of deadlineActions(state, now)) {
      try {
        const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'DEADLINE_DOSSIER', fileName: readableName(`Deadline - ${d.kind.replace(/_/g, ' ')} due ${d.dueDate}`, this.ports.now()), content: [`DEADLINE — ${d.kind.replace(/_/g, ' ').toUpperCase()}`, `Due: ${d.dueDate}`, `Working days left: ${d.workingDaysLeft}`, `Stage: ${state.stage}`, '', d.summary].join('\n') });
        await this.run(tenantId, matterId, { type: 'raise_deadline_escalation', kind: d.kind, dueDate: d.dueDate, subject: d.subject, summary: d.summary, sourceDocumentId: doc.id });
        escalations += 1;
      } catch (err) {
        this.ports.log(`deadline escalation failed (${d.kind} ${d.dueDate})`, err);
      }
    }
    // The client's own arrangements (the mortgage offer, the survey) are expected from the start, so they are checked on, not forgotten.
    for (const key of EXPECTATION_KEYS) {
      if (!expectationDue(state, key)) continue;
      try { await this.run(tenantId, matterId, { type: 'open_expectation', key }); state = await this.getState(tenantId, matterId); } catch (err) { this.ports.log(`could not open the ${key} expectation`, err); }
    }
    const due = dueActions(state, now, sla);
    // Every enquiry due a chase goes in one letter to the seller's solicitor, not one letter each.
    const enquiryChases = due.filter((a) => a.kind === 'chase' && a.wait.key === 'enquiry');
    const actions = enquiryChases.length > 1 ? due.filter((a) => !(a.kind === 'chase' && a.wait.key === 'enquiry') || a === enquiryChases[0]) : due;
    for (const a of actions) {
      try {
        if (a.kind === 'chase') {
          // Nobody is chased while they are away: the reminder waits for them to be back.
          const awayParty = a.rule.recipientRole === 'client' ? 'client' : a.rule.recipientRole === 'seller_solicitor' ? 'seller_side' : a.rule.recipientRole === 'lender' ? 'lender' : null;
          if (awayParty && awayNow(state, awayParty, now)) continue;
          const grouped = a.wait.key === 'enquiry';
          const also = grouped ? openWaits(state).filter((w) => w.key === 'enquiry' && w.subject !== a.wait.subject).map((w) => w.subject) : [];
          const context: Record<string, unknown> = { waitKey: a.wait.key, subject: a.wait.subject, openedAt: a.wait.openedAt, ageWorkingDays: a.ageWorkingDays, priorChases: a.wait.chasesSentAt.length, ...this.chaseExtras(tenantId, state, a.wait.key, a.wait.subject) };
          const detail = { waitKey: a.wait.key, subject: a.wait.subject, recipientRole: a.rule.recipientRole, template: a.rule.template, context, ...(also.length ? { alsoSubjects: also } : {}) };
          const summary = `CHASE\n\nTo: ${a.rule.recipientRole.replace(/_/g, ' ')}\nAbout: ${grouped ? `${1 + also.length} unanswered ${also.length ? 'enquiries' : 'enquiry'}` : `${a.wait.key.replace(/_/g, ' ')}${a.wait.subject ? ` ${a.wait.subject}` : ''}`}\nWaiting since: ${a.wait.openedAt.slice(0, 10)} (${a.ageWorkingDays} working days)\nPrevious chases: ${a.wait.chasesSentAt.length}\n\nA reminder that puts what we asked for back in front of them: ${String(context.resend ?? '').split('\n')[0] || 'what is outstanding'}.`;
          if (await this.proposeUnless(tenantId, matterId, subflows, 'chase', a.wait.key, grouped ? 'enquiry:replies' : `${a.wait.key}:${a.wait.subject}`, detail, summary)) continue;
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
          const doc = await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'ESCALATION_DOSSIER', fileName: readableName(`Escalation - ${a.wait.key.replace(/_/g, ' ')}${a.wait.subject ? ` (${a.wait.subject.replace(/_/g, ' ')})` : ''}`, now), content: dossier });
          await this.run(tenantId, matterId, { type: 'raise_escalation', waitKey: a.wait.key, subject: a.wait.subject, reason: `no response after ${a.ageWorkingDays} working days`, sourceDocumentId: doc.id });
          escalations += 1;
        }
      } catch (err) {
        this.ports.log(`timer action failed (${a.kind} ${a.wait.key}:${a.wait.subject})`, err);
      }
    }
    return { chases, escalations };
  }

  /** What a chase carries beyond the reminder: the link, the form, or the list of what is still outstanding (chase-content.ts). */
  private chaseExtras(tenantId: string, state: MatterState, waitKey: string, subject: string | null): Record<string, string> {
    const sale = state.transactionType === 'freehold_sale' || state.transactionType === 'leasehold_sale';
    return { transaction: sale ? 'sale' : 'purchase', ...chaseContent(state, waitKey, subject, this.idProviderOpts(tenantId)) };
  }

  /** How the ID provider reaches the client, for the words a chase or an update uses. */
  private idProviderOpts(tenantId: string): { idProviderSendsLink: boolean; idProviderLabel: string } {
    const idp = this.ports.idCheckProvider;
    // A provider routed per firm (InfoTrack on the firm's own account) answers for that firm.
    const firm = idp.forFirm?.(tenantId);
    if (firm) return { idProviderSendsLink: firm.sendsClientLink, idProviderLabel: firm.label };
    return { idProviderSendsLink: !!idp.sendsClientLink, idProviderLabel: idp.name === 'infotrack' ? 'InfoTrack' : idp.name };
  }

  /** A person sends the chase for a wait now rather than when the timer would; the same template and record as the timer's. */
  async chaseNow(tenantId: string, matterId: string, waitKey: WaitKey, subject: string | null, actor: string, actorName: string | null = null): Promise<RunResult> {
    const state = await this.getState(tenantId, matterId);
    const wait = openWaits(state).find((w) => w.key === waitKey && (w.subject || null) === (subject || null));
    if (!wait) throw Object.assign(new Error(`No open ${waitKey.replace(/_/g, ' ')} wait${subject ? ` for ${subject}` : ''} on this case.`), { status: 409 });
    const sla = await this.store.loadSla(tenantId);
    const rule = sla[waitKey];
    if (!rule) throw Object.assign(new Error(`No chase rule for ${waitKey}.`), { status: 400 });
    const ageWorkingDays = workingDaysBetween(new Date(wait.openedAt), this.ports.now());
    const context = { waitKey: wait.key, subject: wait.subject, openedAt: wait.openedAt, ageWorkingDays, priorChases: wait.chasesSentAt.length, sentBy: actor, sentByName: actorName };
    // An enquiry chase lists every unanswered enquiry, and records each as chased.
    const also = wait.key === 'enquiry' ? openWaits(state).filter((w) => w.key === 'enquiry' && w.subject !== wait.subject).map((w) => w.subject) : [];
    await this.perform(tenantId, matterId, 'chase', { waitKey: wait.key, subject: wait.subject, recipientRole: rule.recipientRole, template: rule.template, context, ...(also.length ? { alsoSubjects: also } : {}) });
    const after = await this.getState(tenantId, matterId);
    const now = after.waits.find((w) => w.key === wait.key && w.subject === wait.subject && w.closedAt === null);
    if ((now?.chasesSentAt.length ?? 0) <= wait.chasesSentAt.length) throw Object.assign(new Error('The chase was unsuccessful. The reason is on the Tasks list.'), { status: 502 });
    return { state: after, events: [] };
  }

  /** Sweep every active matter (cron). */
  async tickAll(tenantId?: string | null, now = this.ports.now()): Promise<{ matters: number; chases: number; escalations: number }> {
    const totals = { matters: 0, chases: 0, escalations: 0 };
    const paid = new Map<string, boolean>();
    for (const m of await this.store.listActiveMatters(tenantId)) {
      // A suspended firm (unpaid past its grace) is not swept; what fell due goes on the first sweep after they pay.
      if (this.ports.entitled) {
        if (!paid.has(m.tenantId)) paid.set(m.tenantId, await this.ports.entitled(m.tenantId).catch(() => true));
        if (!paid.get(m.tenantId)) continue;
      }
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
  async sendSigningPack(tenantId: string, matterId: string, only: SignedDocument[] | null = null): Promise<RunResult> {
    const s = await this.getState(tenantId, matterId);
    // The deeds this pack is for (a proposal names them); by hand, everything still unsigned goes again.
    const docs = (only ?? deedsToSign(s)).filter((d) => !deedSigned(s, d));
    if (!docs.length) throw Object.assign(new Error('Nothing on this case is waiting for the client to sign.'), { status: 409 });
    if (!this.ports.signing) throw Object.assign(new Error('The signing service is not set up on this deployment, so the signing pack could not be sent.'), { status: 503 });
    const def = await this.ports.signing.defaults(tenantId, s.mortgage?.facts?.lender ?? null);
    const method = (d: SignedDocument): SigningMethod => s.signing.methods[d] ?? (def.provider !== 'none' && (d !== 'mortgage_deed' || def.lenderAcceptsDigital === true) ? 'electronic' : 'wet');
    const wet = docs.filter((d) => method(d) === 'wet');
    const electronic = docs.filter((d) => method(d) === 'electronic');
    const sent = await this.ports.signing.sendPack({ tenantId, matterId, wet, electronic, signers: s.partyNames ?? [] });
    for (const env of sent.envelopes) await this.run(tenantId, matterId, { type: 'record_signing_envelope', document: env.document, provider: env.provider, envelopeId: env.envelopeId });
    const methods: Partial<Record<SignedDocument, SigningMethod>> = Object.fromEntries(docs.map((d) => [d, sent.fellBackToWet.includes(d) ? 'wet' : method(d)]));
    return this.run(tenantId, matterId, { type: 'record_signing_pack_sent', documents: docs, methods, attached: sent.attached, channel: sent.channel, messageId: sent.messageId });
  }

  /**
   * The survey's recommendations: the letter to the client and the surveyor's legal points as one set of
   * enquiries. With `replace`, whatever is pending from this report is withdrawn and new ones proposed,
   * even if a letter already went (a person asked for it). Without, nothing is proposed twice.
   */
  private async surveyRecommendations(tenantId: string, matterId: string, docKey: string, facts: SurveyFacts, subflows: LevelConfig, opts: { replace: boolean; triggeredByEventId: string }): Promise<void> {
    const fresh = await this.getState(tenantId, matterId);
    const mine = (k: string) => k.startsWith(`survey_advice:${docKey}`) || k.startsWith(`enquiry_draft:survey:${docKey}`);
    for (const x of Object.values(fresh.proposals).filter((x) => x.status === 'pending' && (mine(x.dedupKey) || (opts.replace && /^enquiry_draft:(access|evidence)/.test(x.dedupKey))))) {
      if (!opts.replace && !x.dedupKey.startsWith(`enquiry_draft:survey:${docKey}:`)) continue; // first read: only the old one-per-point enquiries are replaced
      await this.run(tenantId, matterId, { type: 'withdraw_proposal', proposalEventId: x.eventId, reason: opts.replace ? 'replaced when the survey was read again' : 'replaced by one set of enquiries from the survey' }).catch((err) => this.ports.log('could not withdraw a superseded survey task', err));
    }
    const stamp = opts.replace ? `:${this.ports.now().getTime()}` : '';
    const after = await this.getState(tenantId, matterId);
    const already = (key: string) => Object.values(after.proposals).some((x) => x.dedupKey === key && x.status !== 'rejected');
    const { seller, ours: oursRaw } = sortLegalPoints(facts.legalIssues ?? []);
    // Written up as a conveyancer sends them (merged, trimmed, the buyer's own points set aside); the raw list when that is not available.
    const written = seller.length && this.ports.enquiryWriter ? await this.ports.enquiryWriter.write({ tenantId, matterId, points: seller.map((p) => p.text), source: 'survey' }).catch(() => null) : null;
    const ours = [...oursRaw, ...(written?.notForTheSeller ?? []).map((x) => `Client: ${x}`)];
    const batch = written ? [`Additional enquiries arising from our client's survey:`, '', ...written.enquiries.map((q, i) => `${i + 1}. ${q}`)].join('\n') : surveyEnquiries(seller);
    const enqKey = `enquiry_draft:survey:${docKey}${stamp}`;
    if (batch && (opts.replace || (!Object.values(after.enquiries).some((q) => q.subject === batch) && !already(enqKey)))) {
      const detail = { subject: batch, question: null, origin: 'survey', title: 'Enquiries from the survey' };
      const check = ours.length ? `\n\nNot for the seller; check these ourselves:\n${ours.map((o) => `• ${o}`).join('\n')}` : '';
      if (!(await this.proposeUnless(tenantId, matterId, subflows, 'enquiry_draft', 'survey', enqKey, detail, `ENQUIRIES FROM THE SURVEY\n\nTo: the seller's solicitor\n${seller.length} point${seller.length === 1 ? '' : 's'} the surveyor raised for the legal adviser, as one set.\n\n${batch}${check}`))) {
        try { await this.perform(tenantId, matterId, 'enquiry_draft', detail); } catch (err) { this.ports.log('survey enquiries could not be raised', err); await this.recordSendFailure(tenantId, matterId, 'enquiry_draft', detail, err); }
      }
    }
    if (!surveyNeedsAdvice(facts)) return;
    const key = `survey_advice:${docKey}${stamp}`;
    if (!opts.replace && (after.clientToldAt?.[key] || already(key))) return;
    const o = { purchasePricePennies: after.purchasePricePennies, freehold: after.transactionType !== 'leasehold_purchase', hasLender: after.hasLender };
    const drafted = this.ports.surveyAdviser ? await this.ports.surveyAdviser.draft({ tenantId, matterId, facts, ...o, transactionLabel: caseBrief(after, this.ports.now()).transactionLabel }).catch(() => null) : null;
    const adviceBody = drafted ?? templateAdvice(surveyAdvice(facts, o));
    const detail = { template: 'survey_advice', context: { eventType: 'survey_received', adviceBody }, triggeredByEventId: opts.triggeredByEventId, about: key };
    if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'survey_advice', key, detail, 'CLIENT UPDATE\n\nTo: the client\nWhat: what the survey means for exchange, and a request for their decision\nTemplate: survey_advice'))) {
      try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('survey advice could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
    }
  }

  /** A person asks for the survey's recommendations again (after Read Again, or whenever): pending ones are replaced. */
  async sendSurveyRecommendations(tenantId: string, matterId: string, documentId: string): Promise<RunResult> {
    const events = await this.store.listEvents(tenantId, matterId);
    const last = [...events].reverse().find((x) => x.type === 'survey_received' && x.sourceDocumentId === documentId);
    if (!last) throw Object.assign(new Error('That document has not been read as a survey.'), { status: 409 });
    const facts = (last.payload as { facts: SurveyFacts }).facts;
    if (facts.confidence === 0 || facts.recommendations.some((r) => r.code === 'UNREAD')) throw Object.assign(new Error('The survey could not be read; read it again first.'), { status: 409 });
    const subflows = await this.levels(tenantId);
    await this.asAutomation(() => this.surveyRecommendations(tenantId, matterId, documentId, facts, subflows, { replace: true, triggeredByEventId: last.id }));
    return { state: await this.getState(tenantId, matterId), events: [] };
  }

  /** What a client's email may be answering: the survey letter, while they have not said how to proceed. */
  /**
   * Whether an email needs no reply: the codified rule (notes.ts isAcknowledgement) first, then the AI
   * reads it against the conversation and what the case is waiting for. Both must agree; no checker, or a
   * failed one, means it is not an acknowledgement. `quiet` is whether the firm lets it go without a
   * person (the email_no_reply trust level, per sender); at Propose it still reaches someone, as one click.
   */
  async acknowledgementCheck(tenantId: string, matterId: string, input: { text: string; thread?: string; from: NoteSender | null; attachments?: number }): Promise<{ acknowledgement: boolean; quiet: boolean; reason: string | null }> {
    if (!isAcknowledgement(input.text, input.from?.name ?? null, input.attachments ?? 0)) return { acknowledgement: false, quiet: false, reason: null };
    const checker = this.ports.ackChecker;
    if (!checker) return { acknowledgement: false, quiet: false, reason: 'No second check is available.' };
    const state = await this.getState(tenantId, matterId);
    const brief = caseBrief(state, this.ports.now());
    const open = [...openWaits(state).map((w) => `${w.key.replace(/_/g, ' ')}${w.subject ? ` (${w.subject})` : ''}, asked ${w.openedAt.slice(0, 10)}`), ...openIssues(state).map((i) => `issue: ${i.title.replace(/\s*\[[a-z-]+:[^\]]*\]/g, '')}`)];
    const r = await checker.confirm({ tenantId, matterId, text: input.text, thread: input.thread, from: input.from, caseLine: `${brief.transactionLabel}, ${brief.lifecycleLabel.toLowerCase()}`, open }).catch(() => ({ acknowledgement: false, reason: 'The check could not run.' }));
    if (!r.acknowledgement) return { acknowledgement: false, quiet: false, reason: r.reason };
    const level = levelFor(await this.levels(tenantId), 'email_no_reply', input.from?.relation ?? null);
    return { acknowledgement: true, quiet: actsUnasked(level, 'email_no_reply'), reason: r.reason };
  }

  private async replyContext(tenantId: string, matterId: string, state: MatterState, from: NoteSender | null): Promise<string | undefined> {
    if (!from || from.relation !== 'client' || !state.survey.reports.length) return undefined;
    if (state.survey.status === 'client_satisfied' || state.survey.status === 'client_withdrawing') return undefined;
    const events = await this.store.listEvents(tenantId, matterId);
    const last = [...events].reverse().find((e) => e.type === 'survey_received');
    if (!last) return undefined;
    const sentAt = state.clientUpdateLastSentAt?.survey_advice ?? null;
    return surveyContext((last.payload as { facts: SurveyFacts }).facts, sentAt);
  }

  /**
   * What goes to the seller about the surveyor's investigations, rebuilt from the client's instruction on
   * each one: those marked "evidence" in one request for what the seller already holds, those marked
   * "pursue" in one request for access, the rest nothing. A pending request that no longer matches (the
   * client changed their mind, waived it, or is now satisfied with the property) is taken back first.
   */
  private async routeInvestigations(tenantId: string, matterId: string, subflows: LevelConfig, note: string | null): Promise<void> {
    const fresh = await this.getState(tenantId, matterId);
    const open = Object.values(fresh.issues).filter((x) => x.kind === 'survey_further_investigation' && (x.status === 'open' || x.status === 'negotiating'));
    const asked = (i: (typeof open)[number], kind: 'access' | 'evidence') => i.enquiryIds.some((q) => (kind === 'access' ? /inspections carried out before exchange|Access for a specialist/ : /Before our client instructs specialists/).test(fresh.enquiries[q]?.subject ?? ''));
    const settled = fresh.clientDecisions?.physical_condition?.decision === 'satisfied' || fresh.clientDecisions?.physical_condition?.decision === 'withdraw';
    const wantEvidence = settled ? [] : open.filter((i) => i.route === 'evidence' && !asked(i, 'evidence'));
    const wantAccess = settled ? [] : open.filter((i) => i.route === 'pursue' && !asked(i, 'access'));
    const groupOf = (i: (typeof open)[number]) => ({ specialist: i.title.replace(/^Further investigation:\s*/, '').replace(/ report recommended:.*$/, ''), items: (i.detail ?? i.title).split('\n').map((t) => ({ text: t.replace(/^•\s*/, '') })).filter((t) => t.text.trim()) });
    const keyOf = (kind: 'evidence' | 'access', xs: typeof open) => `enquiry_draft:${kind}-batch:${xs.map((i) => i.id).sort().join(',')}`;
    const wanted = new Set([wantEvidence.length ? keyOf('evidence', wantEvidence) : '', wantAccess.length ? keyOf('access', wantAccess) : ''].filter(Boolean));
    for (const x of Object.values(fresh.proposals).filter((p) => p.status === 'pending' && p.action === 'enquiry_draft' && /^enquiry_draft:(access|evidence)(-batch)?:/.test(p.dedupKey) && !wanted.has(p.dedupKey))) {
      await this.run(tenantId, matterId, { type: 'withdraw_proposal', proposalEventId: x.eventId, reason: "the client's instruction on the investigations changed" }).catch(() => {});
    }
    const propose = async (kind: 'evidence' | 'access', xs: typeof open) => {
      if (!xs.length) return;
      const key = keyOf(kind, xs);
      if (Object.values(fresh.proposals).some((p) => p.dedupKey === key && p.status === 'pending')) return;
      const groups = xs.map(groupOf);
      const subject = kind === 'evidence' ? evidenceEnquiry(groups, note) : accessEnquiry(groups, note);
      const ids = xs.map((i) => i.id).sort();
      const detail = { subject, issueId: ids[0], alsoIssueIds: ids.slice(1), title: kind === 'evidence' ? 'Evidence from the seller' : 'Access for specialists' };
      const summary = `${kind === 'evidence' ? 'EVIDENCE FROM THE SELLER' : 'ACCESS FOR SPECIALISTS'}\n\nTo: the seller's solicitor\nOn the client's instruction, for: ${groups.map((g) => g.specialist).join(', ')}\n\n${subject}`;
      if (await this.proposeUnless(tenantId, matterId, subflows, 'enquiry_draft', 'survey', key, detail, summary)) return;
      try { await this.perform(tenantId, matterId, 'enquiry_draft', detail); } catch (err) { this.ports.log(`${kind} request could not be raised`, err); await this.recordSendFailure(tenantId, matterId, 'enquiry_draft', detail, err); }
    };
    await propose('evidence', wantEvidence);
    await propose('access', wantAccess);
  }

  // ───────────── effects ─────────────

  /** Post-commit reactions. Best-effort; each becomes its own command so the log records only what really happened. */
  /** At the start of a case: the client's ID / AML check and (firm policy) proof of funds, proposed or sent as the trust level says. */
  private async startClientChecks(tenantId: string, matterId: string, subflows: LevelConfig, key: string): Promise<void> {
    const state = await this.getState(tenantId, matterId);
    if (state.idCheck.status === 'not_started') {
      const detail = { kind: 'id_check_request', provider: this.ports.idCheckProvider.name };
      if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'id_check_request', `id_check_request:${key}`, detail, `ID / AML CHECK\n\nTo: the client, via ${this.ports.idCheckProvider.name}\nWhy: every instruction starts with identity and AML.\n\nThe check costs the firm a fee.`))) {
        try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('ID check could not be requested on enrolment', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
      }
    }
    if (state.requireProofOfFunds && state.proofOfFunds.status === 'not_started' && this.ports.pofForms) {
      const detail = { kind: 'proof_of_funds_request' };
      if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'proof_of_funds_request', `proof_of_funds_request:${key}`, detail, 'PROOF OF FUNDS\n\nTo: the client\nWhy: the firm requires source of funds signed off before exchange; the form goes out at instruction so the statements arrive in time.'))) {
        try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('proof-of-funds form could not be sent on enrolment', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
      }
    }
  }

  /** The case has reached pre-contract: every required search not yet ordered is ordered (or proposed). */
  private async orderMissingSearches(tenantId: string, matterId: string, subflows: LevelConfig): Promise<void> {
    const state = await this.getState(tenantId, matterId);
    for (const searchType of state.requiredSearches) {
      if (state.searches[searchType]) continue;
      const detail = { searchType, provider: this.ports.searchProvider.name };
      if (await this.proposeUnless(tenantId, matterId, subflows, 'search_order', searchType, searchType, detail, `SEARCH ORDER\n\nSearch: ${searchType}\nProvider: ${this.ports.searchProvider.name}\nWhy: the case has entered pre-contract and this search is on its list.\n\nOrdering costs the firm a fee.`)) continue;
      try {
        await this.perform(tenantId, matterId, 'search_order', detail);
      } catch (err) {
        // Provider down: the search stays un-ordered, and it is a task (not a log line nobody reads).
        this.ports.log(`could not order ${searchType} search — manual fallback needed`, err);
        await this.recordSendFailure(tenantId, matterId, 'search_order', detail, err);
      }
    }
  }


  private async effects(tenantId: string, matterId: string, events: EngineEvent[], state: MatterState, subflows: LevelConfig): Promise<void> {
    for (const e of events) {
      try {
        // Exchange: the memorandum on file, as the formula requires (exchange.md 5.1).
        if (e.type === 'contracts_exchanged') {
          const p = e.payload as { completionDate: string; exchangedAt?: string | null; formula?: string | null; spokeWith?: string | null; depositRoute?: string | null };
          const deposit = state.deposit.amountPennies ?? state.deposit.contractPennies ?? null;
          const ROUTE: Record<string, string> = { held_by_us: 'held by us as stakeholder', sent_to_seller_solicitor: "sent to the seller's solicitor", up_the_chain: 'passed up the chain (SCS 2.2.5)' };
          const content = ['MEMORANDUM OF EXCHANGE', '', `Exchanged: ${(p.exchangedAt ?? e.createdAt).replace('T', ' ').slice(0, 16)}`, `Formula: ${p.formula ? `Law Society Formula ${p.formula}` : 'not recorded'}`, `With: ${p.spokeWith ?? 'not recorded'}`, `Recorded by: ${e.actor}`, `Completion date: ${p.completionDate}`, `Deposit: ${deposit != null ? `£${(deposit / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}` : 'not recorded'}${p.depositRoute ? `, ${ROUTE[p.depositRoute] ?? p.depositRoute}` : ''}`].join('\n');
          await this.ports.documents.createGenerated({ tenantId, matterId, docType: 'EXCHANGE_MEMORANDUM', fileName: readableName('Exchange memorandum', this.ports.now()), content }).catch((err) => this.ports.log('exchange memorandum could not be filed', err));
        }
        // A death (people.ts deathPlaybook): each person who must be told gets a tactful letter, drafted for a person to approve.
        if (e.type === 'party_event_recorded' && (e.payload as { event?: string }).event === 'died') {
          const party = (e.payload as { party: string }).party;
          const property = (await this.caseRecord(tenantId, matterId).catch(() => null))?.propertyAddress ?? 'the property';
          for (const m of deathPlaybook(state, party, profileOf(state.transactionType).side, property)) {
            const label = { seller_solicitor: "THE OTHER SIDE'S SOLICITOR", estate_agent: 'THE ESTATE AGENT', lender: 'THE LENDER', client: 'THE CLIENT', family: 'THE FAMILY' }[m.to];
            const title = m.to === 'family' ? `Send condolences to ${party}'s family` : m.to === 'client' ? `Tell the client that ${party} has died` : `Tell ${m.to === 'seller_solicitor' ? "the other side's solicitor" : m.to === 'estate_agent' ? 'the estate agent' : 'the lender'} that ${party} has died`;
            const [action, detail] = m.to === 'seller_solicitor' || m.to === 'estate_agent'
              ? ['counterparty_update' as const, { to: m.to, milestone: 'client_died', letter: true, title, subject: m.subject, body: m.body, triggeredByEventId: e.id }]
              : m.to === 'client'
                ? ['client_update' as const, { template: 'email_reply', context: { subject: m.subject }, letter: true, title, triggeredByEventId: e.id, edited: { subject: m.subject, body: m.body } }]
                : ['chase' as const, { kind: 'party_message', recipientRole: m.to, letter: true, title, subject: m.subject, body: m.body, triggeredByEventId: e.id }];
            try { await this.proposeUnless(tenantId, matterId, subflows, action, m.to === 'client' ? 'email_reply' : 'died', `died:${party}:${m.key}`, detail, `LETTER TO ${label}\n\n${m.body}`, true); }
            catch (err) { this.ports.log('a death notice could not be drafted', err); }
          }
        }
        // A client who withdraws before exchange: the other side and the agent are told (never on an AML or fraud stop: no tipping off) (exchange.md 1.7).
        if (e.type === 'matter_abandoned' && !state.exchange.exchangedAt && !['aml', 'fraud_suspected', 'client_died'].includes(String((e.payload as { reason?: string }).reason))) {
          const property = (await this.caseRecord(tenantId, matterId).catch(() => null))?.propertyAddress ?? 'the property';
          const ours = profileOf(state.transactionType).side === 'seller' ? 'seller' : 'buyer';
          for (const to of ['seller_solicitor', 'estate_agent'] as const) {
            const detail = { to, milestone: 'withdrawn', title: 'Our client is not proceeding', subject: `${property}: our client is not proceeding`, body: `We write to let you know that our ${ours} client has instructed us that they are not proceeding with the ${ours === 'seller' ? 'sale' : 'purchase'} of ${property}. Please treat the transaction as withdrawn${ours === 'buyer' ? ' and return any documents we sent on your side' : ''}.`, triggeredByEventId: e.id };
            try {
              if (!(await this.proposeUnless(tenantId, matterId, subflows, 'counterparty_update', 'withdrawn', `cp:withdrawn:${to}`, detail, `UPDATE TO ${to === 'seller_solicitor' ? "THE OTHER SIDE'S SOLICITOR" : 'THE ESTATE AGENT'}\n\nWhat: our client is not proceeding\n\n${detail.body}`))) await this.perform(tenantId, matterId, 'counterparty_update', detail);
            } catch (err) { this.ports.log('withdrawal notice could not be sent', err); }
          }
        }
        // A linked sale or purchase falling through: the other file is told at once (exchange.md 8.3).
        if (e.type === 'matter_abandoned' && state.relatedMatter) {
          const other = state.relatedMatter.matterId;
          const was = state.relatedMatter.relation === 'sale' ? 'purchase' : 'sale';
          await this.run(tenantId, other, { type: 'raise_issue', actor: SYSTEM, issueId: `CHAIN-FELL-${matterId.slice(0, 8)}`, kind: 'chain_dependency', title: `The client's linked ${was} has fallen through`, detail: `The ${was} on the linked file was abandoned (${String((e.payload as { reason?: string }).reason ?? '').replace(/_/g, ' ')}). Take the client's instructions: ${was === 'sale' ? 'can they still buy (bridging, other funds), or does this purchase stop too?' : 'do they still want to sell, and when?'} Tell the other side and the lender.`, gate: 'exchange', severity: 'critical' } as never).catch((err) => this.ports.log('linked file could not be told', err));
          // The purchase relied on the sale for the replacement exception (tax.md A17): without it the higher rates apply.
          if (was === 'sale') {
            const purchase = await this.getState(tenantId, other).catch(() => null);
            const f = purchase?.sdltFacts as { replacing?: boolean; anyOwnsOther?: boolean } | null | undefined;
            const basis = purchase?.sdltBasis;
            const price = purchase ? chargeableConsideration(purchase) : null;
            if (purchase && f?.replacing && f.anyOwnsOther && basis && !basis.additionalProperty && price && !purchase.completion.confirmedAt) {
              const now = computeSdlt(price, { ...basis, company: false });
              const higher = computeSdlt(price, { ...basis, additionalProperty: true, firstTimeBuyer: false, company: false });
              const extra = higher.totalPennies - now.totalPennies;
              if (extra > 0) await this.run(tenantId, other, { type: 'raise_issue', actor: SYSTEM, issueId: `SDLT-HR-${matterId.slice(0, 8)}`, kind: 'completion_funds_shortfall', title: `The higher rates now apply: ${pounds(extra)} more Stamp Duty`, detail: `The client's sale fell through, so at completion they will still own their old home: the higher rates apply (${pounds(higher.totalPennies)} instead of ${pounds(now.totalPennies)}). Ask the client for the extra before completion, and tell them it is refundable if the old home is sold within three years (amend the return within 12 months of that sale).`, gate: 'completion' } as never).catch((err) => this.ports.log('higher-rates shortfall could not be raised', err));
            }
          }
        }
        // The client's sale nets less than their purchase counts on (money.md 9.10): the purchase file is told.
        if (e.type === 'completion_statement_generated' && state.relatedMatter?.relation === 'purchase' && profileOf(state.transactionType).side === 'seller') {
          const net = (e.payload as { balancePennies?: number | null }).balancePennies ?? null;
          const other = state.relatedMatter.matterId;
          const purchase = await this.getState(tenantId, other).catch(() => null);
          const planned = purchase?.proofOfFunds.facts?.sources.filter((x) => x.kind === 'sale_proceeds').reduce((a, x) => a + x.amountPennies, 0) ?? 0;
          if (net != null && planned > 0 && net < planned - 100) {
            const short = planned - net;
            await this.run(tenantId, other, { type: 'raise_issue', actor: SYSTEM, issueId: `CHAIN-SHORT-${matterId.slice(0, 8)}`, kind: 'completion_funds_shortfall', title: `The client's sale nets ${pounds(short)} less than planned`, detail: `The proof of funds counted on ${pounds(planned)} from the sale; its completion statement leaves ${pounds(net)} after the mortgage, fees and costs. The client must find ${pounds(short)} before completion of the purchase (with its own proof of funds).`, gate: 'completion' } as never).catch((err) => this.ports.log('chain shortfall could not be raised on the purchase', err));
          }
        }
        // The seller's forms: ONE enquiry to the seller's solicitor covering every point they raise and every "not known"
        // answer, numbered, proposed (never sent unasked below auto) and tied to the one issue that lists them.
        if (e.type === 'seller_forms_received') {
          const fresh = await this.getState(tenantId, matterId);
          const listIssue = openIssues(fresh).find((i) => i.title.startsWith(FORMS_ISSUE_PREFIX));
          const facts = fresh.sellerForms?.facts as { notKnown?: Array<{ question: string; section: string | null; page: number | null }> | null } | null;
          const asked = new Set(Object.values(fresh.enquiries).map((x) => x.origin?.formsQuestion).filter(Boolean));
          const notKnown = (facts?.notKnown ?? []).filter((q) => !asked.has(q.question));
          const points = listIssue ? (listIssue.detail ?? '').split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, '').replace(/ \(p\.\d+\)$/, '')) : [];
          const rawLines = [
            ...points.map((p) => `${p.replace(/^(TA\d+|Forms|EPC): /, '')}: please provide full details, with copies of any documents.`),
            ...notKnown.map((q) => `${q.question.replace(/\s+/g, ' ').trim()}: your client answered "not known". Please make enquiries of your client and confirm the position.`),
          ];
          // Written up as a conveyancer sends them (duplicates merged, points the answers rule out dropped); the raw list when that is not available.
          const writerPoints = [...points.map((p) => p.replace(/^(TA\d+|Forms|EPC): /, '')), ...notKnown.map((q) => `The seller answered "not known" to: ${q.question.replace(/\s+/g, ' ').trim()}`)];
          const written = writerPoints.length && this.ports.enquiryWriter ? await this.ports.enquiryWriter.write({ tenantId, matterId, points: writerPoints, source: 'forms' }).catch(() => null) : null;
          const lines = written ? written.enquiries : rawLines;
          // A draft from an earlier forms file covers less than the set now does: it is withdrawn for the one below.
          for (const old of Object.values(fresh.proposals).filter((x) => x.action === 'enquiry_draft' && x.status === 'pending' && x.dedupKey.startsWith('enquiry_draft:forms'))) {
            await this.run(tenantId, matterId, { type: 'withdraw_proposal', proposalEventId: old.eventId, reason: 'Replaced by one enquiry covering the whole set of the seller\'s forms.' }).catch((err) => this.ports.log('stale forms enquiry could not be withdrawn', err));
          }
          if (lines.length) {
            const subject = `Arising from your client's property information forms:\n\n${lines.map((l, n) => `${n + 1}. ${l}`).join('\n')}`;
            const detail = { subject, question: notKnown[0]?.question ?? 'forms', issueId: listIssue?.id ?? null, alsoIssueIds: [], title: "From the seller's forms", about: 'the seller\'s forms' };
            const key = `enquiry_draft:forms:${e.sourceDocumentId ?? e.id}`;
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'enquiry_draft', 'ta6', key, detail, `ENQUIRIES FROM THE SELLER'S FORMS\n\nTo: the seller's solicitor\n\n${subject}`))) {
              await this.perform(tenantId, matterId, 'enquiry_draft', detail);
            }
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
        // Completed: the case's mail folders leave the inbox for Archive.
        if (e.type === 'completion_confirmed' && this.ports.mailFolders) {
          await this.ports.mailFolders.archiveCase(tenantId, matterId).catch((err) => this.ports.log('case mail folders could not be archived', err));
        }
        // The deeds are ready to sign once the contract is approved (on a remortgage, the offer is cleared; on a transfer of equity, the lender consents): the pack is proposed.
        if (e.type === 'contract_approved' || e.type === 'mortgage_offer_cleared' || e.type === 'mortgage_condition_reviewed' || e.type === 'lender_consent_received' || (e.type === 'client_decision_recorded' && (e.payload as { subject?: string }).subject === 'ownership_basis' && (await this.getState(tenantId, matterId)).signing.packSentAt)) {
          // (A tenants-in-common decision after the pack went adds the declaration of trust: it goes on its own.)
          await this.proposeSigningPack(tenantId, matterId, subflows);
        }
        // A survey read for the first time: its letter and enquiries are proposed. A re-read only refreshes the reading;
        // new recommendations are a person's choice (Read Again and Replace Tasks, or Send Recommendations).
        if (e.type === 'survey_received' && !(e.payload as { reread?: boolean }).reread) {
          await this.surveyRecommendations(tenantId, matterId, e.sourceDocumentId ?? e.id, (e.payload as { facts: SurveyFacts }).facts, subflows, { replace: false, triggeredByEventId: e.id });
        }
        // Something said in an email or a note was confirmed by a person: the system now does what the issue's label promised.
        // An unsuccessful send finished by hand (posted, handed over, sent from their own mailbox): recorded as sent, so the case moves on.
        if (e.type === 'issue_resolved' && (e.payload as { resolution?: string }).resolution === 'sent_another_way') {
          const p = e.payload as { issueId: string; details?: Record<string, unknown> | null };
          const i = (await this.getState(tenantId, matterId)).issues[p.issueId];
          if (i?.kind === 'send_failed') await this.recordSentAnotherWay(tenantId, matterId, i.detail ?? '', String(p.details?.how ?? 'other'), e.actor).catch((err) => this.ports.log('the send done by hand could not be recorded', err));
        }
        // Raised from an email task that wrote to the same party: that message carried the follow-up (recipients.ts), so the automatic one does not also go.
        const covered = e.type === 'issue_raised' && !!e.sourceDocumentId && Object.values((await this.getState(tenantId, matterId)).notes).some((n) => n.documentId === e.sourceDocumentId && (n.messagesSentTo ?? []).includes(FOLLOW_UP_PARTY[(e.payload as { kind: string }).kind] as MessageParty));
        if (e.type === 'issue_raised' && !covered) {
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
            // Their client's side of the deal: they buy what we sell, and sell what we buy. Our own note of what we were told stays ours.
            const theirs = profileOf(state.transactionType).side === 'seller' ? 'purchase' : 'sale';
            const subject = `We have been told that your client may not be proceeding with the ${theirs}. Please confirm by return whether your client intends to proceed and, if so, on what timetable; our client is incurring costs in reliance on the transaction.`;
            const detail = { subject, issueId: p.issueId };
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'enquiry_draft', 'chain', `enquiry_draft:at_risk:${p.issueId}`, detail, `ENQUIRY — IS THE ${profileOf(state.transactionType).side === 'seller' ? 'PURCHASE' : 'SALE'} PROCEEDING?\n\nTo: the other side's solicitor\nFor: ${p.title}\n\n${subject}`))) {
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
        // The client said what to do about the surveyor's investigations (all, or some by name): what goes to the
        // seller is rebuilt from each investigation's own instruction, and nothing else goes.
        if (e.type === 'client_decision_recorded' && ['further_investigation', 'physical_condition'].includes((e.payload as { subject: string }).subject)) {
          await this.routeInvestigations(tenantId, matterId, subflows, (e.payload as { note?: string | null }).note ?? null);
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
        if (e.type === 'matter_created' && this.ports.autoStartOnEnrol !== false) await this.startClientChecks(tenantId, matterId, subflows, e.id);
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
        if (e.type === 'stage_advanced' && (e.payload as { to: string }).to === 'pre_contract') await this.orderMissingSearches(tenantId, matterId, subflows);
        // At contract review the contract on file becomes a task to approve.
        if (e.type === 'stage_advanced' && (e.payload as { to: string }).to === 'contract_review') await this.raiseContractReview(tenantId, matterId).catch((err) => this.ports.log('contract approval task not raised', err));
        // Addendum: an enquiry to an INTERNAL counterparty is delivered to the other
        // side's handler as inbound correspondence — the same event pair as an external
        // exchange, with no read of the other matter's state (the wall is in the DB too).
        // Our enquiries go to the seller's solicitor as they are raised (approved, or raised by a person). Internal counterparties are delivered below.
        if (e.type === 'enquiry_raised' && (e.payload as { counterpartyType?: string }).counterpartyType !== 'internal' && this.ports.chaser.sendEnquiries) {
          const p = e.payload as { enquiryId: string; subject: string };
          try {
            await this.ports.chaser.sendEnquiries({ tenantId, matterId, enquiryId: p.enquiryId, text: p.subject });
          } catch (err) {
            this.ports.log(`enquiry ${p.enquiryId} could not be sent`, err);
            await this.recordSendFailure(tenantId, matterId, 'enquiry_draft', { enquiryId: p.enquiryId, subject: p.subject }, err);
          }
        }
        if (e.type === 'enquiry_raised' && (e.payload as { counterpartyType?: string }).counterpartyType === 'internal' && this.ports.linked) {
          const p = e.payload as { enquiryId: string; subject: string };
          // A person raised the enquiry; delivering it is their act, not a trust-level question.
          await this.ports.linked.enquiryRaised({ tenantId, fromMatterId: matterId, enquiryId: p.enquiryId, subject: p.subject });
        }
        // Proof of funds: "request further" re-opens the form with the conveyancer's note to the client.
        // A stage the client was waiting on has been signed off: tell them, say where everything else stands and what comes next.
        // The first request a step sends (the contract pack, the redemption statement, the deposit…): the chase only ever follows it.
        const first = FIRST_REQUESTS[e.type];
        if (first) await this.sendFirstRequest(tenantId, matterId, subflows, first, e);
        await this.automaticSteps(tenantId, matterId, subflows, e);
        // The searches: one email when they have all come back and been through (not one per search).
        if (e.type === 'search_cleared' || e.type === 'search_reviewed' || (e.type === 'step_completed_manually' && String((e.payload as { step?: string }).step).startsWith('search:'))) {
          const fresh = await this.getState(tenantId, matterId);
          const all = fresh.requiredSearches.length > 0 && fresh.requiredSearches.every((t) => isResolved(fresh.searches[t]?.status));
          if (all && !fresh.clientUpdateLastSentAt?.searches_all_back) {
            const detail = { template: 'searches_all_back', context: { eventType: e.type, payload: e.payload, searches: fresh.requiredSearches }, triggeredByEventId: e.id };
            if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'searches_all_back', 'searches_all_back', detail, `CLIENT UPDATE\n\nTo: the client\nBecause: every search is back and reviewed (${fresh.requiredSearches.join(', ')})\nTemplate: searches_all_back`))) {
              try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('searches-all-back update could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
            }
          }
        }
        // A phase of the case is complete (the junctions on the flowchart): the client hears where it stands too.
        const phaseSide = profileOf(state.transactionType).side;
        const phaseDone = e.type === 'stage_advanced' ? PHASE_DONE[(e.payload as { to: string }).to]?.[phaseSide] : undefined;
        if (phaseDone || (e.type === 'proof_of_funds_reviewed' && (e.payload as { option: string }).option === 'approve') || e.type === 'title_reviewed' && (e.payload as { option: string }).option === 'approve') {
          const fresh = await this.getState(tenantId, matterId);
          const brief = caseBrief(fresh, this.ports.now());
          const done = phaseDone ? phaseDone.done : e.type === 'proof_of_funds_reviewed' ? 'source of funds approved' : 'title approved';
          const doneLine = phaseDone ? phaseDone.line : e.type === 'proof_of_funds_reviewed' ? 'We have signed off your proof of funds: that part of the file is complete.' : 'We have reviewed the title to the property and approved it.';
          // What comes next, once: one sentence for the stage, the target date if there is one. Outstanding items are the "where things stand" tail every client update carries.
          const target = brief.milestones.targetExchangeDate;
          const targetNote = target ? ` We are working towards exchange around ${new Date(target).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.` : '';
          const stageNext = STAGE_NEXT[phaseSide];
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
          const p = e.payload as { noteId: string; applied: string[]; reply?: { subject: string; body: string } | null; messages?: Array<{ id: string; to: MessageParty; subject: string; body: string; attach?: MessageAttachment[]; asAttachments?: boolean; alwaysAttach?: boolean }> };
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
                // "Leave the drains, get a structural engineer in": the specialists named become the investigations it covers.
                let scope: string[] | null = null;
                if (c.subject === 'further_investigation' && c.scope?.length) {
                  const fi = Object.values(fresh.issues).filter((i) => i.kind === 'survey_further_investigation');
                  scope = fi.filter((i) => c.scope!.some((n) => i.title.toLowerCase().includes(n.toLowerCase().replace(/\s*(specialist|engineer|survey(or)?|report)s?$/, '').trim()))).map((i) => i.id);
                  if (!scope.length) throw new Error(`None of the investigations on the case match "${c.scope.join(', ')}".`);
                }
                await this.run(tenantId, matterId, { type: 'client_decision_recorded', actor: e.actor, subject: c.subject, decision: c.decision, note: c.note, evidenceDocumentId: note.documentId, approvedEventId: e.id, scope });
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
              } else if (c.type === 'record_survey_plan') {
                await this.run(tenantId, matterId, { type: 'record_survey_plan', actor: e.actor, plan: c.plan, date: c.date, note: c.note });
              } else if (c.type === 'record_availability') {
                await this.run(tenantId, matterId, { type: 'record_availability', actor: e.actor, party: c.party, from: c.from, until: c.until, note: c.note });
              } else if (c.type === 'request_from_seller') {
                // The client told us what to get from the other side: the enquiry, drafted from their words, as a proposal a person can edit.
                const detail = { subject: c.text.trim(), question: null, origin: 'client_instruction', title: `On the client's instruction: ${c.about.trim().slice(0, 60)}`, about: c.about.trim() };
                const key = `enquiry_draft:client:${p.noteId}:${id}`;
                if (!(await this.proposeUnless(tenantId, matterId, subflows, 'enquiry_draft', 'client_instruction', key, detail, `ENQUIRY ON THE CLIENT'S INSTRUCTION\n\nTo: the seller's solicitor\nAbout: ${c.about}\n\n${c.text.trim()}`))) {
                  await this.perform(tenantId, matterId, 'enquiry_draft', detail);
                }
              } else if (c.type === 'record_client_progress') {
                await this.run(tenantId, matterId, { type: 'record_client_progress', actor: e.actor, waitKey: c.waitKey, subject: c.subject ?? '', claim: c.claim, expectBy: c.expectBy, noteId: p.noteId });
              } else if (c.type === 'record_mortgage_withdrawn') {
                await this.run(tenantId, matterId, { type: 'mortgage_offer_withdrawn', actor: e.actor, reason: c.reason });
              } else if (c.type === 'resend_to_client') {
                // The same request again, with its links and forms: what Chase Now sends.
                await this.chaseNow(tenantId, matterId, c.waitKey, c.subject || null, e.actor);
              } else if (c.type === 'record_chain_consent') {
                await this.run(tenantId, matterId, { type: 'record_chain_consent', actor: e.actor, given: c.given, reason: action.quote ?? null, noteId: p.noteId });
              } else if (c.type === 'set_file_delivery') {
                await this.run(tenantId, matterId, { type: 'set_file_delivery', actor: e.actor, mode: c.mode, reason: action.quote ?? null, noteId: p.noteId });
              } else if (c.type === 'send_file_copy' && (p.messages ?? []).some((m) => m.to === 'client' && (m.attach ?? []).some((x) => x.what === c.what))) {
                // Attached to the reply that goes below: nothing to send separately.
              } else if (c.type === 'send_file_copy') {
                // The client cannot find a document: it goes back to them, attached, if it is on the file.
                const found = await this.requestedFiles(tenantId, matterId, await this.getState(tenantId, matterId), c.what);
                if (!found.length) {
                  await this.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: 'other', title: `The client asked for a copy of ${c.what.trim().slice(0, 60)}: not found on the file`, detail: `Find it and send it to them, or tell them when it will be available. They wrote: "${action.quote ?? c.what}"`, gate: 'none', severity: 'warning' } as never);
                } else {
                  const detail = { template: 'file_copy', context: { fileList: found.map((f) => f.fileName).join(', '), what: c.what.trim() }, triggeredByEventId: e.id, attachFileIds: found.map((f) => f.id) };
                  if (!(await this.proposeUnless(tenantId, matterId, subflows, 'client_update', 'file_copy', `file_copy:${p.noteId}:${id}`, detail, `CLIENT UPDATE\n\nTo: the client\nWhat: a copy of ${c.what.trim()}\nAttached: ${found.map((f) => f.fileName).join(', ')}`))) {
                    try { await this.perform(tenantId, matterId, 'client_update', detail); } catch (err) { this.ports.log('file copy could not be sent', err); await this.recordSendFailure(tenantId, matterId, 'client_update', detail, err); }
                  }
                }
              } else {
                // A note's reading may not make a problem hold less than its kind does ("the seller is pulling out" holds exchange, whatever the reader said).
                await this.run(tenantId, matterId, { type: 'raise_issue', actor: e.actor, kind: c.kind, title: c.title, detail: c.detail, gate: c.gate === 'none' && ISSUE_KIND_SPEC[c.kind]?.gate !== 'none' ? null : c.gate, documentId: note.documentId, ...(c.severity ? { severity: c.severity } : {}) });
              }
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              this.ports.log(`note ${p.noteId} action ${id} could not be applied`, err);
              await this.run(tenantId, matterId, { type: 'note_action_refused', noteId: p.noteId, actionId: id, reason }).catch(() => {});
            }
          }
          // Every message, as approved (and edited): the client's through their channel, anyone else's by email from the fee earner.
          // A legacy task approved before messages existed carries `reply` instead.
          const outgoing = p.messages ?? (p.reply?.body?.trim() ? [{ id: 'reply', to: 'client' as const, subject: p.reply.subject, body: p.reply.body }] : []);
          // "Always send this client attachments", ticked on the reply: set before the files go.
          if (outgoing.some((m) => 'alwaysAttach' in m && m.alwaysAttach) && (await this.getState(tenantId, matterId)).fileDelivery !== 'attachments') {
            await this.run(tenantId, matterId, { type: 'set_file_delivery', actor: e.actor, mode: 'attachments', reason: 'Ticked on a reply: send this client attachments', noteId: p.noteId }).catch(() => {});
          }
          for (const m of outgoing) {
            if (!m.body?.trim()) continue;
            const [action, detail] = m.to === 'client'
              ? ['client_update' as const, { template: 'email_reply', context: { subject: m.subject }, triggeredByEventId: e.id, edited: { subject: m.subject, body: m.body }, ...('attach' in m && m.attach?.length ? { attachFileIds: m.attach.map((x) => x.id), attachFileNames: m.attach.map((x) => x.fileName), ...(m.asAttachments ? { asAttachments: true } : {}) } : {}) }]
              : ['chase' as const, { kind: 'party_message', recipientRole: m.to, subject: m.subject, body: m.body, triggeredByEventId: e.id }];
            try { await this.perform(tenantId, matterId, action, detail); } catch (err) { this.ports.log(`the message to ${m.to} could not be sent`, err); await this.recordSendFailure(tenantId, matterId, action, detail, err); }
          }
        }
        // Milestones the other side hears without asking (counterparty-status.ts): each once, proposed by default.
        if (e.type !== 'client_update_sent' && e.type !== 'action_proposed') {
          const fresh = await this.getState(tenantId, matterId);
          const due = dueCounterpartyNotices(fresh, this.ports.now());
          if (due.length) {
            const property = (await this.caseRecord(tenantId, matterId).catch(() => null))?.propertyAddress ?? null;
            for (const n of due) {
              const msg = counterpartyNotice(fresh, this.ports.now(), n, property);
              const detail = { to: n.to, milestone: n.key, title: n.title, subject: msg.subject, body: msg.body, triggeredByEventId: e.id };
              const summary = `UPDATE TO ${n.to === 'seller_solicitor' ? "THE OTHER SIDE'S SOLICITOR" : 'THE ESTATE AGENT'}\n\nWhat: ${n.title}\n\n${msg.body}`;
              try {
                if (!(await this.proposeUnless(tenantId, matterId, subflows, 'counterparty_update', n.key, `cp:${n.key}:${n.to}`, detail, summary))) await this.perform(tenantId, matterId, 'counterparty_update', detail);
              } catch (err) { this.ports.log(`update to ${n.to} could not be sent`, err); await this.recordSendFailure(tenantId, matterId, 'counterparty_update', detail, err); }
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
          if (e.type === 'enquiry_raised') {
            const o = ((e.payload as { origin?: { purpose?: string; about?: string } | null }).origin ?? {}) as { purpose?: string; about?: string };
            const purpose = o.purpose ?? 'forms';
            context = { ...context, enquiryLine: enquiryLine(purpose, o.about ?? null) };
            dedupKey = `${template}:${purpose}:${this.ports.now().toISOString().slice(0, 10)}`;
            because = `${purpose.replace(/_/g, ' ')} enquiry raised`;
          }
          if (e.type === 'search_ordered') {
            const fresh = await this.getState(tenantId, matterId);
            const ordered = fresh.requiredSearches.filter((t) => fresh.searches[t]);
            if (ordered.length < fresh.requiredSearches.length) continue;
            context = { ...context, searches: ordered };
            dedupKey = `${template}:${ordered.join('+')}`;
            because = `all ${ordered.length} searches ordered (${ordered.join(', ')})`;
          }
          // Registration: the new register goes with the news, as the client's title information document.
          if (e.type === 'register_checked' && !(e.payload as { ok?: boolean }).ok) continue;
          const detail = { template, context, triggeredByEventId: e.id, ...(e.type === 'register_checked' && e.sourceDocumentId ? { attachDocumentId: e.sourceDocumentId, attachFileNames: ['Your title register.pdf'] } : {}) };
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
    const ROLE: Record<string, string> = { seller_solicitor: "the seller's solicitor", buyer_solicitor: "the buyer's solicitor", lender: 'the lender', estate_agent: 'the estate agent', client: 'the client', search_provider: 'the search provider' };
    const role = typeof detail.recipientRole === 'string' ? ROLE[detail.recipientRole] ?? `the ${detail.recipientRole.replace(/_/g, ' ')}` : 'the client';
    // The title says what did not go; why, and what to do, are the issue's detail.
    const what = action === 'counterparty_update' ? `Update to ${String(detail.to) === 'estate_agent' ? 'the estate agent' : "the other side's solicitor"}` : kind === 'party_message' ? `Message to ${role}` : kind === 'signing_pack' ? 'Signing pack to the client' : kind === 'proof_of_funds_request' ? 'Proof-of-funds form to the client' : kind === 'id_check_request' ? 'ID check request to the client' : kind === 'request' ? `Request to ${role}` : action === 'chase' ? `Chase to ${role}` : action === 'acknowledgement' ? `Acknowledgement to ${role}` : action === 'search_order' ? 'Search order' : action === 'client_update' ? 'Update to the client' : action.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const title = `${what} unsuccessful`;
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
        else {
          // Sent by the system itself (no proposal): the task keeps what was being sent, so Try Again can send it.
          const clean = Object.fromEntries(Object.entries(detail).filter(([k]) => !k.startsWith('__')));
          const packed = Buffer.from(JSON.stringify({ action, detail: clean }), 'utf8').toString('base64url');
          if (packed.length < 30_000) lines.push(`[retry:${packed}]`);
        }
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
    // A failed send is tried again; one a person held back is sent after all (its step is still needed).
    if (pr.status !== 'failed' && pr.status !== 'rejected') throw Object.assign(new Error('Only a failed or held-back action can be sent.'), { status: 409 });
    try {
      await this.perform(tenantId, matterId, pr.action, pr.detail as Record<string, unknown>);
    } catch (err) {
      await this.recordSendFailure(tenantId, matterId, pr.action, { ...(pr.detail as Record<string, unknown>), __proposalEventId: proposalEventId }, err);
      throw Object.assign(new Error(explainSendError(err).reason), { status: 502 });
    }
    const result = await this.run(tenantId, matterId, { type: 'record_action_retried', actor: userId, proposalEventId, action: pr.action });
    const fresh = await this.getState(tenantId, matterId);
    for (const i of Object.values(fresh.issues).filter((x) => x.kind === 'send_failed' && x.status === 'open' && (x.detail ?? '').includes(`[proposal:${proposalEventId}]`))) {
      await this.run(tenantId, matterId, { type: 'resolve_issue', actor: userId, issueId: i.id, resolution: 'other', note: 'Sent on retry.' }).catch(() => {});
    }
    return result;
  }

  /**
   * A send that failed, done another way by a person (Sent Another Way on its task): the same record the
   * send would have made, with how it went, so everything that hangs off it happens (the signing wait opens,
   * the chase counts, the request is on file). What was being sent is read from the task (a proposal, or the
   * packed send). Anything with no record of its own (a message to a party) needs nothing more.
   */
  private async recordSentAnotherWay(tenantId: string, matterId: string, issueDetail: string, how: string, actor: string): Promise<void> {
    const s = await this.getState(tenantId, matterId);
    const channel = (MANUAL_CHANNELS as readonly string[]).includes(how) ? (how as ManualChannel) : 'other';
    let action: string | null = null;
    let detail: Record<string, unknown> = {};
    const proposalId = issueDetail.match(/\[proposal:([0-9a-f-]{36})\]/)?.[1];
    const packed = issueDetail.match(/\[retry:([A-Za-z0-9_-]+)\]/)?.[1];
    if (proposalId && s.proposals[proposalId]) { action = s.proposals[proposalId].action; detail = (s.proposals[proposalId].detail ?? {}) as Record<string, unknown>; }
    else if (packed) { const x = JSON.parse(Buffer.from(packed, 'base64url').toString('utf8')) as { action: string; detail: Record<string, unknown> }; action = x.action; detail = x.detail; }
    if (!action) return;
    const kind = typeof detail.kind === 'string' ? detail.kind : null;
    if (action === 'client_update' && kind === 'signing_pack') {
      const docs = ((detail.documents as SignedDocument[] | undefined) ?? deedsToSign(s)).filter((d) => !deedSigned(s, d));
      if (docs.length) await this.run(tenantId, matterId, { type: 'record_signing_pack_sent', documents: docs, methods: Object.fromEntries(docs.map((d) => [d, 'wet'])), attached: [], channel, messageId: null });
    } else if (action === 'client_update' && kind === 'id_check_request') {
      await this.run(tenantId, matterId, { type: 'request_id_check', actor, provider: `manual (${channel.replace(/_/g, ' ')})` });
    } else if (action === 'client_update') {
      const template = typeof detail.template === 'string' ? detail.template : kind ?? 'client_update';
      await this.run(tenantId, matterId, { type: 'record_client_update', update: { template, recipientRole: 'client', channel, messageId: null, triggeredByEventId: typeof detail.triggeredByEventId === 'string' ? detail.triggeredByEventId : null } });
    } else if (action === 'counterparty_update' && typeof detail.milestone === 'string') {
      await this.run(tenantId, matterId, { type: 'record_client_update', update: { template: `cp_${detail.milestone}:${String(detail.to)}`, recipientRole: detail.to as 'seller_solicitor' | 'estate_agent', channel, messageId: null, triggeredByEventId: typeof detail.triggeredByEventId === 'string' ? detail.triggeredByEventId : null } });
    } else if (action === 'chase' && typeof detail.waitKey === 'string') {
      await this.run(tenantId, matterId, { type: 'record_chase', chase: { waitKey: detail.waitKey as WaitKey, subject: String(detail.subject ?? ''), recipientRole: detail.recipientRole as never, template: String(detail.template ?? 'chase'), channel, messageId: null } });
    } else if (action === 'acknowledgement' && typeof detail.forEventId === 'string') {
      await this.run(tenantId, matterId, { type: 'record_acknowledgement', ack: { forEventId: detail.forEventId, forEventType: detail.forEventType as never, recipientRole: detail.recipientRole as never, what: String(detail.what ?? ''), channel, messageId: null } });
    }
    if (proposalId && s.proposals[proposalId]?.status === 'failed') await this.run(tenantId, matterId, { type: 'record_action_retried', actor, proposalEventId: proposalId, action: s.proposals[proposalId].action }).catch(() => {});
  }

  /** Try a failed send again from its task, whether it came from an approved proposal or from the system acting itself. */
  async retryIssue(tenantId: string, matterId: string, issueId: string, userId: string): Promise<RunResult> {
    const s = await this.getState(tenantId, matterId);
    const i = s.issues[issueId];
    if (!i || i.kind !== 'send_failed' || (i.status !== 'open' && i.status !== 'negotiating')) throw Object.assign(new Error('There is no failed send to try again here.'), { status: 409 });
    const proposal = (i.detail ?? '').match(/\[proposal:([0-9a-f-]{36})\]/)?.[1];
    if (proposal && s.proposals[proposal]?.status === 'failed') return this.retryFailedAction(tenantId, matterId, proposal, userId);
    const packed = (i.detail ?? '').match(/\[retry:([A-Za-z0-9_-]+)\]/)?.[1];
    if (!packed) throw Object.assign(new Error('This one cannot be sent again automatically; send it by hand using the message in the task, then resolve it.'), { status: 409 });
    const { action, detail } = JSON.parse(Buffer.from(packed, 'base64url').toString('utf8')) as { action: EngineAction; detail: Record<string, unknown> };
    try {
      await this.perform(tenantId, matterId, action, detail);
    } catch (err) {
      throw Object.assign(new Error(explainSendError(err).reason), { status: 502 });
    }
    return this.run(tenantId, matterId, { type: 'resolve_issue', actor: userId, issueId, resolution: 'other', note: 'Sent on retry.' });
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
      // The same round, the same words: a further round's note again (it is required), else its open questions.
      const again = template === 'proof_of_funds_request_again' ? (openPofQueries(s).filter((q) => q.status === 'sent').map((q) => `• ${q.question}`).join('\n') || 'A few of your answers need a little more detail; you will see what when you open the form.') : '';
      sent = await this.ports.clientComms.sendStatusUpdate({ tenantId, matterId, template, context: { formUrl: pof.formUrl, noteToClient: again, requestId: pof.requestId, queryCount: 0, resend: 'yes' } });
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

/** A file name a person reads: "Completion statement - 28 Sep 2026.txt", never a slug. */
export function readableName(title: string, at: Date, ext = 'txt'): string {
  const day = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
  const clean = title.replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  return `${clean.charAt(0).toUpperCase()}${clean.slice(1)} - ${day}.${ext}`;
}

/** What a proposal is, in words: its own title, else the heading of its summary, else the action. */
function proposalTitle(action: EngineAction, subject: string | null | undefined, detail: Record<string, unknown>, summary: string): string {
  const own = typeof detail.title === 'string' ? detail.title : null;
  const head = summary.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const fromHead = head && head.length <= 80 ? (head === head.toUpperCase() ? head.charAt(0) + head.slice(1).toLowerCase() : head) : null;
  const label = ENGINE_ACTION_LABEL[action] ?? action.replace(/_/g, ' ');
  return own ?? fromHead ?? `${label}${subject ? ` (${subject.replace(/_/g, ' ')})` : ''}`;
}
