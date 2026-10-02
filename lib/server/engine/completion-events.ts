/**
 * Completion events (docs/eventualities/completion.md §3, §4, §7): what goes wrong on and around the day, recorded by a
 * person from Something Happened. Pure: each event's consequence as an issue; the machine raises it.
 */
import type { IssueGate, IssueKind, IssueSeverity } from './issues';
import type { MatterState } from './types';

export const COMPLETION_EVENTS = ['payment_misdirected', 'completion_missed', 'keys_not_released', 'seller_unconfirmed', 'redemption_returned', 'undertaking_chased', 'contract_retention'] as const;
export type CompletionEvent = (typeof COMPLETION_EVENTS)[number];
export interface CompletionConsequence { kind: IssueKind; title: string; detail: string; gate: IssueGate; severity: IssueSeverity; resolveBy?: string | null }

/** Whether the event can be recorded at this point of the case. */
export function completionEventProblem(s: MatterState, e: CompletionEvent): string | null {
  const done = !!s.completion.confirmedAt;
  if (!s.exchange.exchangedAt && e !== 'payment_misdirected') return 'Contracts are not exchanged.';
  if (!done && (e === 'keys_not_released' || e === 'redemption_returned' || e === 'undertaking_chased')) return 'This is recorded after completion.';
  if (done && (e === 'completion_missed' || e === 'seller_unconfirmed')) return 'Completion is already confirmed.';
  return null;
}

export function completionEventConsequences(s: MatterState, e: { event: CompletionEvent; detail: string; amountPennies?: number | null; until?: string | null }, side: 'buyer' | 'seller' | 'owner'): CompletionConsequence[] {
  const d = e.detail.trim();
  const money = e.amountPennies ? ` (£${(e.amountPennies / 100).toLocaleString('en-GB')})` : '';
  switch (e.event) {
    case 'payment_misdirected':
      return [{ kind: 'completion_failure', title: `Money sent to the wrong account${money}`, detail: `${d}. Now: call our bank to recall the payment and ask the receiving bank to freeze it; report to Action Fraud and the police; tell the firm's insurer, the COLP and the SRA; tell the client. Do not confirm completion. If the money cannot be recovered the firm replaces it from its own funds at once (SRA Accounts Rules 6.1).`, gate: 'completion', severity: 'critical' }];
    case 'completion_missed':
      return [
        { kind: 'completion_failure', title: `Completion did not happen today: ${d.slice(0, 70)}`, detail: `${d}. Tell the client, the other side, the agents and the chain now, not tomorrow. Agree a new date; the late-completion compensation runs from today (SCS 7.2), and either side can serve a notice to complete from tomorrow (SCS 6.8). Return the advance if the lender's rules say so.`, gate: 'completion', severity: 'critical' },
        ...(s.relatedMatter ? [{ kind: 'chain_dependency' as IssueKind, title: 'The linked case cannot complete today either', detail: 'Sale and purchase complete on the same day: move the linked file\'s date with this one.', gate: 'completion' as IssueGate, severity: 'critical' as IssueSeverity }] : []),
      ];
    case 'keys_not_released':
      return [{ kind: 'completion_failure', title: 'Keys not released after completion', detail: `${d}. Completion stands. Ring the seller's solicitor and the agent: the keys are released on completion under the contract. If the seller will not leave, it is a breach of the contract (vacant possession): advise the client on a claim, and tell the lender if someone is in occupation.`, gate: 'none', severity: 'critical' }];
    case 'seller_unconfirmed':
      return [{ kind: 'completion_failure', title: "The seller's solicitor has not confirmed completion", detail: `${d}. Ring them now and keep ringing; confirm the money arrived (the CHAPS reference). The keys stay with the agent until they confirm. Escalate to a partner today if they cannot be reached.`, gate: 'completion', severity: 'critical' }];
    case 'redemption_returned':
      return [{ kind: 'title_defect', title: `The lender returned the redemption money${money}`, detail: `${d}. Our undertaking to redeem is still live and daily interest is running. Check the lender's account details and reference again with the lender directly (the bank details hard stop applies again), and send it again today.`, gate: 'none', severity: 'critical' }];
    case 'undertaking_chased':
      return [{ kind: 'title_defect', title: "The buyer's solicitor is chasing our undertaking", detail: `${d}. We undertook to redeem and to send the discharge. Chase the lender for the DS1 / e-DS1 today and tell the buyer's solicitor when it will come. If HM Land Registry completed their registration leaving the charge on, send the discharge for them to lodge.`, gate: 'none', severity: 'warning' }];
    case 'contract_retention':
      return [{ kind: 'completion_funds_shortfall', title: `Retention held${side === 'seller' ? ' from our client' : ' from the seller'}${money}${e.until ? ` until ${e.until}` : ''}`, detail: `${d}. Held under the contract (snagging on a new build, a pending indemnity, an apportionment to settle, a service charge year-end). Keep it on the ledger; release it when the condition is met${e.until ? ` or by ${e.until}` : ''}, with the other side's written agreement.`, gate: 'none', severity: 'warning', resolveBy: e.until ?? null }];
  }
}
