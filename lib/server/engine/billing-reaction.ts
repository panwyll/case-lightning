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

/**
 * The backstop: a case reaching completion that was never counted (its ID check resolved some
 * way that did not fire the charge, or the charge failed) is counted now. chargeCase is
 * once-only, so a case already counted is untouched.
 */
export const COMPLETION_EVENTS = new Set(['completion_confirmed']);
export const reachesCompletion = (events: ReadonlyArray<Pick<EngineEvent, 'type'>>): boolean => events.some((e) => COMPLETION_EVENTS.has(e.type));

export async function billOnIdResolved(input: { tenantId: string; matterId: string; events: EngineEvent[] }): Promise<void> {
  const opening = opensCase(input.events);
  const completing = reachesCompletion(input.events);
  if (!opening && !completing) return;
  const { chargeCase } = await import('../case-billing');
  const r = await chargeCase(input.tenantId, input.matterId, opening ? 'ID_AML_RESOLVED' : 'COMPLETION_BACKSTOP');
  if (completing && !opening && r.opened) console.warn(`[case-billing] matter ${input.matterId} reached completion uncounted; counted now`);
}
