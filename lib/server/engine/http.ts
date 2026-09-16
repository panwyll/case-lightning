/**
 * Shared bits for the engine's /api/v1 routes: role gating and the zod schemas for
 * the commands a human may issue. Everything the machine treats as automation-only
 * (search_extracted, record_chase, …) is deliberately NOT expressible here.
 */
import { z } from 'zod';
import type { SessionUser } from '../types';
import { ForbiddenError } from '../session';
import { DECISION_OPTIONS, SEARCH_TYPES, PAYEE_KINDS, SOURCE_CHANNELS, VERIFICATION_METHODS } from './types';
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
  z.object({ type: z.literal('enrol'), hasLender: z.boolean(), requiredSearches: z.array(searchType).optional(), targetExchangeDate: isoDate.nullish(), targetCompletionDate: isoDate.nullish(), counterpartyType: z.enum(['internal', 'external']).nullish() }),
  z.object({ type: z.literal('mark_manual_handling'), reason: z.string().min(1).max(200), detail: z.string().max(2000).optional() }),
  z.object({ type: z.literal('request_id_check') }),
  z.object({ type: z.literal('raise_enquiry'), enquiryId: z.string().min(1).max(60), subject: z.string().min(1).max(500) }),
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
]);
export type UserCommandInput = z.infer<typeof userCommandSchema>;

/** Turn validated input into a machine Command (attaching the acting user). Service-level commands return null. */
export function toCommand(input: UserCommandInput, userId: string): Command | null {
  switch (input.type) {
    case 'request_id_check':
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
]);

export const resolveSchema = z.object({
  option: z.enum(DECISION_OPTIONS),
  note: z.string().max(4000).nullish(),
  /** Addendum 2: required for option 'verify' on a bank-details decision; the machine validates the method. */
  verification: z.object({ method: z.string().max(60), reference: z.string().max(200).nullish() }).nullish(),
});
export { VERIFICATION_METHODS };
