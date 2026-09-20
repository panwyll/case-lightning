/**
 * Shared bits for the engine's /api/v1 routes: role gating and the zod schemas for
 * the commands a human may issue. Everything the machine treats as automation-only
 * (search_extracted, record_chase, …) is deliberately NOT expressible here.
 */
import { z } from 'zod';
import type { SessionUser } from '../types';
import { ForbiddenError } from '../session';
import { CLIENT_DECISION_SUBJECTS, ISSUE_PAID_BY, ABANDON_REASONS, DECISION_OPTIONS, SEARCH_TYPES, PAYEE_KINDS, SOURCE_CHANNELS, SUB_FLOWS, SUBFLOW_STATUSES, VERIFICATION_METHODS, type Engagement } from './types';
import { ISSUE_KINDS, ISSUE_RESOLUTIONS, ISSUE_SEVERITIES } from './issues';
import type { Command } from './machine';

/** Read-only users can look but never move a matter. */
export function requireWriter(user: SessionUser): void {
  if (user.role === 'READ_ONLY') throw new ForbiddenError();
}

/** Decisions are a conveyancer's call (spec: "surfaces genuine decision points to a human conveyancer"). */
export function requireDecider(user: SessionUser): void {
  if (user.role !== 'ADMIN' && user.role !== 'CONVEYANCER') throw new ForbiddenError();
}

const searchType = z.enum(SEARCH_TYPES);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** Commands a user may POST to /matters/:id/engine. Mirrors machine.ts USER_COMMANDS. */
export const userCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enrol'), transactionType: z.enum(['freehold_purchase', 'leasehold_purchase']).nullish(), requireProofOfFunds: z.boolean().nullish(), requireExchangeAuthority: z.boolean().nullish(), hasLender: z.boolean(), requiredSearches: z.array(searchType).optional(), targetExchangeDate: isoDate.nullish(), targetCompletionDate: isoDate.nullish(), counterpartyType: z.enum(['internal', 'external']).nullish(), shadowMode: z.boolean().optional() }),
  z.object({ type: z.literal('mark_manual_handling'), reason: z.string().min(1).max(200), detail: z.string().max(2000).optional() }),
  // Addendum 3 §2: shadow mode is switched by an admin, and the switch is itself an event.
  z.object({ type: z.literal('set_shadow_mode'), shadowMode: z.boolean(), reason: z.string().max(500).nullish() }),
  z.object({ type: z.literal('request_id_check') }),
  z.object({ type: z.literal('raise_enquiry'), enquiryId: z.string().min(1).max(60).nullish(), subject: z.string().min(1).max(500), origin: z.object({ issueId: z.string().min(1).max(60).optional() }).nullish() }),
  z.object({ type: z.literal('deposit_received'), amountPennies: z.number().int().nonnegative().nullish() }),
  z.object({ type: z.literal('contracts_exchanged'), completionDate: isoDate, exchangedAt: z.string().datetime().nullish() }),
  z.object({ type: z.literal('completion_statement_generated'), documentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('funds_requested'), fromRole: z.enum(['lender', 'client']), amountPennies: z.number().int().nonnegative().nullish(), bankDetailsId: z.string().min(1).max(60) }),
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
  z.object({ type: z.literal('funds_received'), fromRole: z.enum(['lender', 'client']), amountPennies: z.number().int().nonnegative().nullish() }),
  z.object({ type: z.literal('completion_confirmed'), completedAt: z.string().datetime().nullish() }),
  z.object({ type: z.literal('sdlt_submitted'), reference: z.string().max(100).nullish() }),
  z.object({ type: z.literal('ap1_submitted'), reference: z.string().max(100).nullish() }),
  z.object({ type: z.literal('ap1_confirmed'), titleNumber: z.string().max(40).nullish() }),
  // Manual fallbacks when an integration is down — the log stays truthful either way.
  z.object({ type: z.literal('record_search_ordered'), searchType, provider: z.string().min(1).max(100), reference: z.string().max(100).nullish() }),
  // Report on title lifecycle (the service does the I/O; these are the human-triggered steps).
  z.object({ type: z.literal('draft_report_on_title') }),
  z.object({ type: z.literal('send_report_on_title') }),
  // Eventualities (docs/engine-eventualities.md).
  z.object({ type: z.literal('abandon_matter'), reason: z.enum(ABANDON_REASONS), detail: z.string().max(2000).nullish() }),
  z.object({ type: z.literal('set_target_dates'), targetExchangeDate: isoDate.nullish(), targetCompletionDate: isoDate.nullish(), reason: z.string().max(500).nullish() }),
  z.object({ type: z.literal('change_completion_date'), completionDate: isoDate, reason: z.string().max(500).nullish() }),
  z.object({ type: z.literal('notice_to_complete_served'), servedBy: z.enum(['buyer', 'seller']), servedAt: z.string().datetime().nullish(), expiresAt: isoDate, documentId: z.string().uuid() }),
  z.object({ type: z.literal('mortgage_offer_withdrawn'), reason: z.string().min(1).max(500), lender: z.string().max(200).nullish() }),
  z.object({ type: z.literal('withdraw_enquiry'), enquiryId: z.string().min(1).max(60), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('hmlr_requisition_received'), documentId: z.string().uuid(), reference: z.string().max(100).nullish(), deadline: isoDate.nullish() }),
  z.object({ type: z.literal('record_correction'), aboutEventId: z.string().uuid(), reason: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('record_handler_change'), fromUserId: z.string().uuid().nullish(), toUserId: z.string().uuid(), reason: z.string().max(500).nullish() }),
  // issues
  z.object({ type: z.literal('raise_issue'), issueId: z.string().min(1).max(60).optional(), kind: z.enum(ISSUE_KINDS), title: z.string().min(1).max(200), detail: z.string().max(4000).nullish(), gate: z.enum(['exchange', 'completion', 'none']).nullish(), documentId: z.string().uuid().nullish(), party: z.string().max(120).nullish(), severity: z.enum(ISSUE_SEVERITIES).nullish(), causedBy: z.string().max(60).nullish() }),
  z.object({ type: z.literal('set_issue_severity'), issueId: z.string().min(1).max(60), severity: z.enum(ISSUE_SEVERITIES), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('client_decision_recorded'), subject: z.enum(CLIENT_DECISION_SUBJECTS), decision: z.string().min(1).max(40), note: z.string().max(2000).nullish(), evidenceDocumentId: z.string().uuid().nullish() }),
  z.object({ type: z.literal('close_matter'), reason: z.string().max(500).nullish() }),
  z.object({ type: z.literal('update_issue'), issueId: z.string().min(1).max(60), status: z.enum(['open', 'negotiating']), note: z.string().max(4000).nullish(), gate: z.enum(['exchange', 'completion', 'none']).nullish(), party: z.string().max(120).nullish() }),
  z.object({ type: z.literal('resolve_issue'), issueId: z.string().min(1).max(60), resolution: z.enum(ISSUE_RESOLUTIONS), note: z.string().max(4000).nullish(), newPricePennies: z.number().int().positive().nullish(), costPennies: z.number().int().nonnegative().nullish(), paidBy: z.enum(ISSUE_PAID_BY).nullish() }),
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
  z.object({ type: z.literal('signed_contract_held'), note: z.string().max(500).nullish() }),
]);
export type UserCommandInput = z.infer<typeof userCommandSchema>;

/** Turn validated input into a machine Command (attaching the acting user). Service-level commands return null. */
export function toCommand(input: UserCommandInput, userId: string): Command | null {
  switch (input.type) {
    case 'request_id_check':
    case 'request_proof_of_funds':
    case 'draft_report_on_title':
    case 'send_report_on_title':
    case 'record_bank_details':
      return null; // handled by EngineService methods (they talk to a port first)
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
  z.object({ role: z.literal('id_check'), documentId: z.string().uuid() }),
  z.object({ role: z.literal('management_pack'), documentId: z.string().uuid() }),
  z.object({ role: z.literal('survey'), documentId: z.string().uuid(), surveyType: z.enum(['level1', 'level2', 'level3', 'valuation']).nullish() }),
  z.object({ role: z.literal('specialist_report'), documentId: z.string().uuid(), forIssueId: z.string().max(60).nullish() }),
]);

/** Addendum 3 §3: how the handler engaged with the source section before acting — stored on the resolving event. */
export const engagementSchema = z.object({ scrolledSource: z.boolean(), dwellMs: z.number().int().nonnegative().max(86_400_000) });

/** The dwell the server accepts as engagement when the source was not scrolled (short enough to fit on one screen). */
export const MIN_SOURCE_DWELL_MS = 5000;

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
  note: z.string().max(4000).nullish(),
  /** Addendum 2: required for option 'verify' on a bank-details decision; the machine validates the method. */
  verification: z.object({ method: z.string().max(60), reference: z.string().max(200).nullish() }).nullish(),
  /** Addendum 3 §3: required — see assertEngaged. */
  engagement: engagementSchema.nullish(),
});

export const subflowStatusSchema = z.object({ subFlow: z.enum(SUB_FLOWS), status: z.enum(SUBFLOW_STATUSES) });
export const shadowReviewSchema = z.object({ eventId: z.string().uuid(), agrees: z.boolean(), humanOutcome: z.string().max(2000).nullish(), note: z.string().max(4000).nullish() });
export const queueQuerySchema = z.object({ sort: z.enum(['oldest_pending', 'target_completion']).default('oldest_pending'), all: z.enum(['0', '1']).default('0'), includeShadow: z.enum(['0', '1']).default('0'), limit: z.coerce.number().int().positive().max(1000).default(300) });
export { VERIFICATION_METHODS };
