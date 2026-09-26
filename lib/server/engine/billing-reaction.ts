/**
 * When a case is counted (docs: "£100 per case"): the moment its ID / AML check comes back
 * resolved — cleared by the rules or reviewed by a person — the matter is opened for billing.
 * That is the first point at which the engine has done the work a firm pays for on a case;
 * enrolment alone, and background triage, never count. The charge is once-only and best
 * effort (case-billing.ts); a trial or comped firm gets the count, not the bill.
 */
import type { EngineEvent } from './types';

export const CASE_OPENING_EVENTS = new Set(['id_check_cleared', 'id_check_reviewed']);

/** True when this batch of events resolves the ID / AML check. */
export const opensCase = (events: ReadonlyArray<Pick<EngineEvent, 'type'>>): boolean => events.some((e) => CASE_OPENING_EVENTS.has(e.type));

export async function billOnIdResolved(input: { tenantId: string; matterId: string; events: EngineEvent[] }): Promise<void> {
  if (!opensCase(input.events)) return;
  const { chargeCase } = await import('../case-billing');
  await chargeCase(input.tenantId, input.matterId, 'ID_AML_RESOLVED');
}
