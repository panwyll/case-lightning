/**
 * Shared bits for the engine's /api/v1 routes: role gating and the zod schemas for
 * the commands a human may issue. Everything the machine treats as automation-only
 * (search_extracted, record_chase, …) is deliberately NOT expressible here.
 */
import { CASE_SHAPES } from './shapes';
import { WAIT_KEYS } from './types';
import { z } from 'zod';
import type { SessionUser } from '../types';
import { ForbiddenError } from '../session';
import { CLIENT_DECISION_SUBJECTS, NOTE_KINDS, TRANSACTION_TYPES, ISSUE_PAID_BY, ABANDON_REASONS, DECISION_OPTIONS, SEARCH_TYPES, PAYEE_KINDS, SOURCE_CHANNELS, SUB_FLOWS, TRUST_LEVELS, VERIFICATION_METHODS, type Engagement } from './types';
import { ISSUE_KINDS, ISSUE_RESOLUTIONS, ISSUE_SEVERITIES } from './issues';
import type { Command } from './machine';

/** Every role may move a matter; decisions are narrower (below). Kept as the one place a write gate would go. */
export function requireWriter(_user: SessionUser): void {}

/** Decisions are a conveyancer's call (spec: "surfaces genuine decision points to a human conveyancer"). */
export function requireDecider(user: SessionUser): void {
  if (user.role !== 'ADMIN' && user.role !== 'CONVEYANCER') throw new ForbiddenError();
}

/**
 * The tasks an assistant may do: sending what the engine drafted to move the file along (a
 * chase, an acknowledgement, a routine update, the signing pack, the proof-of-funds form) and
 * trying a failed send again. Anything that is legal judgement, advice, costs the firm a fee,
 * or moves money stays with a conveyancer. `kind` is the work item's (decisionTask) kind.
 */
export const ASSISTANT_TASK_KINDS = new Set(['proposal:chase', 'proposal:acknowledgement', 'proposal:client_update', 'proposal:signing_pack', 'proposal:proof_of_funds_request', 'issue:send_failed:retry', 'issue:file_locked']);
export const assistantMay = (kind: string | null | undefined): boolean => !!kind && ASSISTANT_TASK_KINDS.has(kind);

/** A decision this person may take: a conveyancer or admin any; an assistant only the kinds above. */
export function requireDeciderFor(user: SessionUser, kind: string | null | undefined): void {
  if (user.role === 'ADMIN' || user.role === 'CONVEYANCER') return;
  if (user.role === 'ASSISTANT' && assistantMay(kind)) return;
  throw Object.assign(new ForbiddenError(), { message: 'This one is for a conveyancer.' });
}

const searchType = z.enum(SEARCH_TYPES);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** Commands a user may POST to /matters/:id/engine. Mirrors machine.ts USER_COMMANDS. */
export const userCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enrol'), transactionType: z.enum(TRANSACTION_TYPES).nullish(), requireProofOfFunds: z.boolean().nullish(), requireExchangeAuthority: z.boolean().nullish(), parties: z.number().int().min(1).max(4).nullish(), hasExistingMortgage: z.boolean().nullish(), considerationPennies: z.number().int().nonnegative().nullish(), hasLender: z.boolean(), requiredSearches: z.array(searchType).optional(), targetExchangeDate: isoDate.nullish(), targetCompletionDate: isoDate.nullish(), counterpartyType: z.enum(['internal', 'external']).nullish(), shadowMode: z.boolean().optional(), shapes: z.array(z.enum(CASE_SHAPES)).max(8).optional(), partyNames: z.array(z.string().min(1).max(120)).max(4).optional(), attorneys: z.array(z.string().min(1).max(120)).max(4).optional(), officers: z.array(z.string().min(1).max(120)).max(10).optional(), executors: z.array(z.string().min(1).max(120)).max(6).optional(), occupiers: z.array(z.string().min(1).max(120)).max(6).optional(), sdlt: z.object({ firstTimeBuyer: z.boolean(), additionalProperty: z.boolean(), nonUkResident: z.boolean(), mixedUse: z.boolean().optional(), linkedConsiderationPennies: z.number().int().nonnegative().nullish() }).nullish() }),
  z.object({ type: z.literal('add_party'), name: z.string().min(1).max(120), role: z.enum(['buyer', 'seller', 'owner', 'donor', 'attorney', 'director', 'executor']) }),
  z.object({ type: z.literal('set_funding'), hasLender: z.boolean(), reason: z.string().min(3).max(300) }),
  z.object({ type: z.literal('record_survey_plan'), plan: z.enum(['none', 'booked']), date: isoDate.nullish(), note: z.string().max(500).nullish() }),
  z.object({ type: z.literal('link_related_matter'), relatedMatterId: z.string().uuid(), relation: z.enum(['sale', 'purchase']).nullish(), note: z.string().max(500).nullish() }),
  z.object({ type: z.literal('unlink_related_matter'), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('undo_manual_step'), step: z.string().min(1).max(60), reason: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('reopen_step'), step: z.string().min(1).max(60), reason: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('complete_step_manually'), step: z.string().min(1).max(60), note: z.string().min(1).max(2000), documentIds: z.array(z.string().uuid()).max(20).optional(), facts: z.object({ lender: z.string().max(120).nullish(), amountPennies: z.number().int().min(0).nullish(), expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), titleNumber: z.string().max(40).nullish(), minUnexpiredYears: z.number().int().min(0).max(999).nullish(), maxSearchAgeMonths: z.number().int().min(1).max(24).nullish(), acceptsNonFamilyGift: z.boolean().nullish(), requiresEws1: z.boolean().nullish() }).optional(), skipReason: z.string().max(1000).nullish() }),
  z.object({ type: z.literal('record_lender_requirements'), minUnexpiredYears: z.number().int().min(0).max(999).nullish(), maxSearchAgeMonths: z.number().int().min(1).max(24).nullish(), acceptsNonFamilyGift: z.boolean().nullish(), requiresEws1: z.boolean().nullish(), note: z.string().max(1000).nullish() }),
  z.object({ type: z.literal('client_account_receipt'), remitter: z.string().min(1).max(160), amountPennies: z.number().int().nonnegative().nullish(), purpose: z.enum(['fees', 'deposit', 'completion', 'other']), reference: z.string().max(120).nullish() }),
  z.object({ type: z.literal('name_change_evidenced'), party: z.string().max(80).nullish(), from: z.string().min(1).max(120), to: z.string().min(1).max(120), reason: z.string().min(1).max(300), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('buildings_insurance_confirmed'), insurer: z.string().max(120).nullish(), fromDate: isoDate.nullish(), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('priority_search_made'), expiresAt: isoDate, documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('bankruptcy_search_clear'), subjects: z.array(z.string().max(120)).max(6).nullish(), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('resume_automation'), reason: z.string().min(3).max(500) }),
  z.object({ type: z.literal('mark_manual_handling'), reason: z.string().min(1).max(200), detail: z.string().max(2000).optional() }),
  z.object({ type: z.literal('resend_proof_of_funds') }),
  z.object({ type: z.literal('retry_action'), proposalEventId: z.string().uuid() }),
  z.object({ type: z.literal('retry_issue'), issueId: z.string().min(1).max(40) }),
  // Addendum 3 §2: shadow mode is switched by an admin, and the switch is itself an event.
  z.object({ type: z.literal('set_shadow_mode'), shadowMode: z.boolean(), reason: z.string().max(500).nullish() }),
  z.object({ type: z.literal('request_id_check'), party: z.string().max(80).nullish() }),
  z.object({ type: z.literal('raise_enquiry'), enquiryId: z.string().min(1).max(60).nullish(), subject: z.string().min(1).max(500), origin: z.object({ issueId: z.string().min(1).max(60).optional() }).nullish() }),
  z.object({ type: z.literal('deposit_received'), amountPennies: z.number().int().nonnegative().nullish() }),
  z.object({ type: z.literal('contracts_exchanged'), completionDate: isoDate, exchangedAt: z.string().datetime().nullish(), formula: z.string().max(12).nullish(), spokeWith: z.string().max(160).nullish(), depositRoute: z.enum(['held_by_us', 'sent_to_seller_solicitor', 'up_the_chain']).nullish() }),
  z.object({ type: z.literal('completion_statement_generated'), documentId: z.string().uuid().nullish(), balancePennies: z.number().int().nullish() }),
  z.object({ type: z.literal('funds_requested'), fromRole: z.enum(['lender', 'client', 'isa_provider']), amountPennies: z.number().int().nonnegative().nullish(), bankDetailsId: z.string().min(1).max(60) }),
  // Addendum 2 — payment verification
  z.object({
    type: z.literal('record_bank_details'),
    payeeKind: z.enum(PAYEE_KINDS),
    payeeRef: z.string().max(200).nullish(),
    details: z.object({ sortCode: z.string().regex(/^\d{6}$/, '6 digits'), accountNumber: z.string().regex(/^\d{8}$/, '8 digits'), accountName: z.string().min(1).max(140), firmName: z.string().max(200).nullish() }),
    sourceChannel: z.enum(SOURCE_CHANNELS),
    sourceDocumentId: z.string().uuid().nullish(),
    note: z.string().max(1000).nullish(),
  }),
  z.object({ type: z.literal('payment_authorised'), payeeKind: z.enum(PAYEE_KINDS), bankDetailsId: z.string().min(1).max(60), amountPennies: z.number().int().nonnegative().nullish(), purpose: z.enum(['completion_monies', 'deposit', 'other']) }),
  z.object({ type: z.literal('funds_received'), fromRole: z.enum(['lender', 'client', 'buyer_solicitor', 'incoming_owner', 'isa_provider']), remitter: z.string().max(160).nullish(), amountPennies: z.number().int().nonnegative().nullish(), uncleared: z.boolean().nullish() }),
  z.object({ type: z.literal('funds_cleared'), receiptId: z.string().min(1).max(40) }),
  z.object({ type: z.literal('retention_released'), amountPennies: z.number().int().nonnegative().nullish() }),
  z.object({ type: z.literal('formula_c_release_given'), until: z.string().max(40), givenTo: z.string().min(1).max(200) }),
  z.object({ type: z.literal('formula_c_release_lapsed'), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('record_property_event'), event: z.enum(['damaged', 'not_vacant', 'early_access', 'seller_stays']), detail: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('final_bill_delivered'), amountPennies: z.number().int().nonnegative(), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('completion_payment_sent'), reference: z.string().min(1).max(120), sentAt: z.string().max(40).nullish() }),
  z.object({ type: z.literal('record_contributions'), model: z.enum(['FIXED', 'RING_FENCE', 'CONTRIBUTION', 'FLOATING']), contributions: z.array(z.object({ party: z.string().min(1).max(160), pennies: z.number().int().nonnegative() })).min(2).max(8), ratioPercent: z.record(z.string(), z.number().min(0).max(100)).nullish() }),
  z.object({ type: z.literal('ap1_cancelled'), reason: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('requisition_extended'), requisitionEventId: z.string().min(1).max(60), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('register_checked'), wrong: z.boolean().nullish(), note: z.string().max(1000).nullish(), lenderTold: z.boolean().nullish() }),
  z.object({ type: z.literal('seller_discharge_received'), reference: z.string().max(120).nullish(), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('record_party_event'), event: z.enum(['died', 'capacity_lost', 'bankrupt']), party: z.string().min(1).max(160), hasAttorney: z.boolean().nullish(), note: z.string().max(1000).nullish() }),
  z.object({ type: z.literal('sar_made'), note: z.string().max(1000).nullish() }),
  z.object({ type: z.literal('daml_response'), decision: z.enum(['granted', 'refused']), note: z.string().max(1000).nullish() }),
  z.object({ type: z.literal('record_sdlt_facts'), wales: z.boolean().nullish(), mainResidence: z.boolean().nullish(), anyEverOwned: z.boolean().nullish(), anyOwnsOther: z.boolean().nullish(), replacing: z.boolean().nullish(), replacingFirst: z.boolean().nullish(), anyNonResident: z.boolean().nullish(), mixedUse: z.boolean().nullish(), debtAssumedPennies: z.number().int().nonnegative().nullish() }),
  z.object({ type: z.literal('record_cgt_facts'), mainResidenceThroughout: z.boolean().nullish(), ukResident: z.boolean().nullish() }),
  z.object({ type: z.literal('longstop_date_recorded'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ type: z.literal('record_other_charge'), chargee: z.string().min(1).max(160), text: z.string().max(600).nullish() }),
  z.object({ type: z.literal('charge_statement_received'), chargeId: z.string().min(1).max(20), redemptionPennies: z.number().int().nonnegative(), validUntil: z.string().max(10).nullish(), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('charge_redeemed'), chargeId: z.string().min(1).max(20), amountPennies: z.number().int().nonnegative().nullish() }),
  z.object({ type: z.literal('charge_discharged'), chargeId: z.string().min(1).max(20), reference: z.string().max(120).nullish(), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('undertaking_given'), to: z.string().min(1).max(200), terms: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('undertaking_discharged'), note: z.string().max(500).nullish() }),
  z.object({ type: z.literal('completion_information_received'), undertakingToRedeem: z.boolean().nullish(), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('refund_paid'), refundId: z.string().min(1).max(40), reference: z.string().min(1).max(120) }),
  // transaction types (docs/transaction-types.md)
  z.object({ type: z.literal('request_property_forms'), forms: z.array(z.string().max(10)).min(1).max(6).optional() }),
  z.object({ type: z.literal('property_forms_received'), forms: z.array(z.string().max(10)).min(1).max(6), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('contract_pack_sent'), includes: z.array(z.string().max(60)).max(12).optional() }),
  z.object({ type: z.literal('buyer_enquiries_received'), enquiries: z.array(z.object({ id: z.string().min(1).max(20).optional(), question: z.string().min(1).max(2000) })).min(1).max(100), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('enquiry_replies_sent'), enquiryIds: z.array(z.string().min(1).max(20)).min(1).max(100), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('request_redemption_statement'), lender: z.string().max(120).nullish() }),
  z.object({ type: z.literal('redemption_statement_received'), lender: z.string().max(120).nullish(), redemptionPennies: z.number().int().nonnegative().nullish(), validUntil: isoDate.nullish(), dailyInterestPennies: z.number().int().nonnegative().nullish(), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('mortgage_redeemed'), lender: z.string().max(120).nullish(), amountPennies: z.number().int().nonnegative().nullish() }),
  z.object({ type: z.literal('discharge_confirmed'), lender: z.string().max(120).nullish(), reference: z.string().max(100).nullish() }),
  z.object({ type: z.literal('mortgage_deed_executed'), lender: z.string().max(120).nullish(), witnessed: z.boolean().default(true) }),
  z.object({ type: z.literal('certificate_of_title_sent'), lender: z.string().max(120).nullish(), completionDate: isoDate.nullish() }),
  z.object({ type: z.literal('request_lender_consent'), lender: z.string().max(120).nullish() }),
  z.object({ type: z.literal('lender_consent_received'), lender: z.string().max(120).nullish(), conditions: z.string().max(2000).nullish() }),
  z.object({ type: z.literal('transfer_deed_executed'), parties: z.array(z.string().max(120)).min(1).max(6), witnessed: z.boolean().default(true) }),
  z.object({ type: z.literal('deed_of_trust_executed'), parties: z.array(z.string().max(120)).min(2).max(6), shares: z.string().max(200).nullish(), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('sdlt_not_required'), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('completion_confirmed'), completedAt: z.string().datetime().nullish() }),
  z.object({ type: z.literal('sdlt_submitted'), reference: z.string().max(100).nullish() }),
  z.object({ type: z.literal('ap1_submitted'), reference: z.string().max(100).nullish() }),
  z.object({ type: z.literal('ap1_confirmed'), titleNumber: z.string().max(40).nullish() }),
  // Manual fallbacks when an integration is down — the log stays truthful either way.
  z.object({ type: z.literal('record_search_ordered'), searchType, provider: z.string().min(1).max(100), reference: z.string().max(100).nullish() }),
  // Report on title lifecycle (the service does the I/O; these are the human-triggered steps).
  z.object({ type: z.literal('draft_report_on_title') }),
  z.object({ type: z.literal('draft_completion_statement') }),
  z.object({ type: z.literal('draft_notice_to_complete') }),
  z.object({ type: z.literal('chase_now'), waitKey: z.enum(WAIT_KEYS), subject: z.string().max(120).nullish() }),
  z.object({ type: z.literal('send_report_on_title') }),
  // Eventualities (docs/engine-eventualities.md).
  z.object({ type: z.literal('abandon_matter'), reason: z.enum(ABANDON_REASONS), detail: z.string().max(2000).nullish() }),
  z.object({ type: z.literal('set_clients'), names: z.array(z.string().min(1).max(120)).min(1).max(8), reason: z.string().max(500).nullish() }),
  z.object({ type: z.literal('record_chain_consent'), given: z.boolean(), reason: z.string().max(500).nullish() }),
  z.object({ type: z.literal('set_target_dates'), targetExchangeDate: isoDate.nullish(), targetCompletionDate: isoDate.nullish(), reason: z.string().max(500).nullish() }),
  z.object({ type: z.literal('change_completion_date'), completionDate: isoDate, reason: z.string().max(500).nullish() }),
  z.object({ type: z.literal('notice_to_complete_served'), servedBy: z.enum(['buyer', 'seller']), servedAt: z.string().datetime().nullish(), expiresAt: isoDate, documentId: z.string().uuid() }),
  z.object({ type: z.literal('mortgage_offer_withdrawn'), reason: z.string().min(1).max(500), lender: z.string().max(200).nullish() }),
  z.object({ type: z.literal('withdraw_enquiry'), enquiryId: z.string().min(1).max(60), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('hmlr_requisition_received'), documentId: z.string().uuid(), reference: z.string().max(100).nullish(), deadline: isoDate.nullish() }),
  z.object({ type: z.literal('record_correction'), aboutEventId: z.string().uuid(), reason: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('record_handler_change'), fromUserId: z.string().uuid().nullish(), toUserId: z.string().uuid(), reason: z.string().max(500).nullish() }),
  // issues
  z.object({ type: z.literal('raise_issue'), issueId: z.string().min(1).max(60).optional(), kind: z.enum(ISSUE_KINDS), title: z.string().min(1).max(200), detail: z.string().max(4000).nullish(), gate: z.enum(['exchange', 'completion', 'none']).nullish(), documentId: z.string().uuid().nullish(), party: z.string().max(120).nullish(), severity: z.enum(ISSUE_SEVERITIES).nullish(), causedBy: z.string().max(60).nullish(), resolveBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }),
  z.object({ type: z.literal('set_issue_severity'), issueId: z.string().min(1).max(60), severity: z.enum(ISSUE_SEVERITIES), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('client_decision_recorded'), subject: z.enum(CLIENT_DECISION_SUBJECTS), decision: z.string().min(1).max(40), note: z.string().max(2000).nullish(), evidenceDocumentId: z.string().uuid().nullish(), scope: z.array(z.string().max(40)).max(20).nullish(), party: z.string().max(160).nullish() }),
  z.object({ type: z.literal('close_matter'), reason: z.string().max(500).nullish() }),
  z.object({ type: z.literal('update_issue'), issueId: z.string().min(1).max(60), status: z.enum(['open', 'negotiating']), note: z.string().max(4000).nullish(), gate: z.enum(['exchange', 'completion', 'none']).nullish(), party: z.string().max(120).nullish(), resolveBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }),
  z.object({ type: z.literal('resolve_issue'), issueId: z.string().min(1).max(60), resolution: z.enum(ISSUE_RESOLUTIONS), note: z.string().max(4000).nullish(), newPricePennies: z.number().int().positive().nullish(), costPennies: z.number().int().nonnegative().nullish(), paidBy: z.enum(ISSUE_PAID_BY).nullish(), details: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).nullish(), documentId: z.string().uuid().nullish() }),
  // proof of funds (service-level: the route issues the form and sends it) and leasehold
  z.object({ type: z.literal('request_proof_of_funds'), noteToClient: z.string().max(1000).nullish() }),
  z.object({ type: z.literal('raise_proof_of_funds_query'), question: z.string().min(5).max(1000), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('withdraw_proof_of_funds_query'), queryId: z.string().min(1).max(20), reason: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('management_pack_requested'), from: z.string().min(1).max(200), reference: z.string().max(100).nullish() }),
  z.object({ type: z.literal('notice_of_assignment_served'), servedOn: z.string().min(1).max(200), reference: z.string().max(100).nullish() }),
  z.object({ type: z.literal('withdraw_issue'), issueId: z.string().min(1).max(60), reason: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('mark_issue_fatal'), issueId: z.string().min(1).max(60), reason: z.string().min(1).max(2000), abandonReason: z.enum(ABANDON_REASONS).nullish() }),
  z.object({ type: z.literal('record_price_change'), toPennies: z.number().int().positive(), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('contract_approved'), note: z.string().max(500).nullish() }),
  // notes and call transcripts (docs/intake.md) — the service reads the note before it lands
  z.object({ type: z.literal('record_note'), text: z.string().min(1).max(20_000), kind: z.enum(NOTE_KINDS).default('typed'), documentId: z.string().uuid().nullish(), durationSeconds: z.number().int().nonnegative().max(86_400).nullish() }),
  z.object({ type: z.literal('signed_contract_held'), note: z.string().max(500).nullish() }),
]);
export type UserCommandInput = z.infer<typeof userCommandSchema>;

/** The evidence a completion sheet gathers (engine/completion.ts). Accepted on any command; required by contract. */
export const completionSchema = z.object({
  documentId: z.string().uuid().nullish(),
  checklist: z.record(z.string().max(60), z.boolean()).nullish(),
  party: z.object({ who: z.string().max(200), channel: z.string().max(60), at: z.string().max(40) }).nullish(),
  note: z.string().max(2000).nullish(),
  readDocument: z.boolean().nullish(),
});

/** Turn validated input into a machine Command (attaching the acting user). Service-level commands return null. */
export function toCommand(input: UserCommandInput, userId: string): Command | null {
  switch (input.type) {
    case 'request_id_check':
    case 'request_proof_of_funds':
    case 'draft_report_on_title':
    case 'draft_completion_statement':
    case 'draft_notice_to_complete':
    case 'chase_now':
    case 'send_report_on_title':
    case 'record_bank_details':
    case 'record_note':
    case 'link_related_matter':
    case 'unlink_related_matter':
      return null; // handled by EngineService methods (they talk to a port first, or write two matters)
    default:
      return { ...input, actor: userId } as Command;
  }
}

/** Documents arriving for a sub-flow (until webhooks / the pipeline drive this automatically). */
export const ingestSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('search'), documentId: z.string().uuid(), searchType, provider: z.string().max(100).nullish() }),
  z.object({ role: z.literal('enquiry_reply'), documentId: z.string().uuid(), enquiryId: z.string().min(1).max(60) }),
  z.object({ role: z.literal('mortgage_offer'), documentId: z.string().uuid() }),
  z.object({ role: z.literal('title'), documentId: z.string().uuid() }),
  z.object({ role: z.literal('id_check'), documentId: z.string().uuid(), party: z.string().max(80).nullish() }),
  z.object({ role: z.literal('management_pack'), documentId: z.string().uuid() }),
  z.object({ role: z.literal('property_forms'), documentId: z.string().uuid() }),
  z.object({ role: z.literal('lease'), documentId: z.string().uuid() }),
  z.object({ role: z.literal('survey'), documentId: z.string().uuid(), surveyType: z.enum(['level1', 'level2', 'level3', 'valuation']).nullish() }),
  z.object({ role: z.literal('specialist_report'), documentId: z.string().uuid(), forIssueId: z.string().max(60).nullish() }),
]);

/** Addendum 3 §3: how the handler engaged with the source section before acting — stored on the resolving event. */
export const engagementSchema = z.object({ scrolledSource: z.boolean(), dwellMs: z.number().int().nonnegative().max(86_400_000) });

/** The dwell the server accepts as engagement when the source was not scrolled (short enough to fit on one screen). */
export const MIN_SOURCE_DWELL_MS = 3300;

/**
 * The UI does not enable any action until the handler has scrolled the source or dwelt
 * on it; the server refuses (412) without the same evidence, so the gate is not a UI nicety.
 */
export function assertEngaged(engagement: Engagement | null | undefined): Engagement {
  if (!engagement || !(engagement.scrolledSource || engagement.dwellMs >= MIN_SOURCE_DWELL_MS)) {
    throw Object.assign(new Error('Read the source section before acting: scroll it, or spend a few seconds on it.'), { status: 412 });
  }
  return engagement;
}

export const resolveSchema = z.object({
  option: z.enum(DECISION_OPTIONS),
  /** Escalating: the colleague it goes to (someone who can open the case). */
  escalateTo: z.string().uuid().nullish(),
  /** A proposal approved with its words changed: what actually goes. */
  edited: z.object({ subject: z.string().max(300).nullish(), body: z.string().max(20000).nullish(), messages: z.array(z.object({ id: z.string().max(60), subject: z.string().max(300).nullish(), body: z.string().max(20000).nullish(), asAttachments: z.boolean().optional(), alwaysAttach: z.boolean().optional() })).max(10).nullish() }).nullish(),
  note: z.string().max(4000).nullish(),
  /** Addendum 2: required for option 'verify' on a bank-details decision; the machine validates the method. */
  verification: z.object({ method: z.string().max(60), reference: z.string().max(200).nullish() }).nullish(),
  /** Addendum 3 §3: required — see assertEngaged. */
  engagement: engagementSchema.nullish(),
  /** note_actions: which of the note's proposals the conveyancer is applying. Omitted means all of them. */
  selection: z.array(z.string().min(1).max(60)).max(40).nullish(),
});

export const levelSchema = z.object({ action: z.string().regex(/^(acknowledgement|chase|client_update|search_order|auto_clear)(:[A-Za-z0-9_]{1,40})?$/), level: z.enum(TRUST_LEVELS) });
export const shadowReviewSchema = z.object({ eventId: z.string().uuid(), agrees: z.boolean(), humanOutcome: z.string().max(2000).nullish(), note: z.string().max(4000).nullish() });
export const queueQuerySchema = z.object({ sort: z.enum(['oldest_pending', 'target_completion']).default('oldest_pending'), all: z.enum(['0', '1']).default('0'), includeShadow: z.enum(['0', '1']).default('0'), limit: z.coerce.number().int().positive().max(1000).default(300) });
export { VERIFICATION_METHODS };
