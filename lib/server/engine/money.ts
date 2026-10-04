/**
 * The client's money, reconciled (docs/eventualities/money.md §8–10, completion.md §2–5).
 *
 * Recording that money arrived is not enough: what arrived is compared with what was asked for.
 * A buyer's completion money is the client's balance (the figure on the request), any ISA bonus,
 * and the lender's advance (the figure on the request, else the offer). A shortfall from any of
 * them is the client's to make up; an overpayment by the client goes back to them. A sale expects
 * the price less the deposit already held from the buyer's solicitor; a remortgage expects an
 * advance that at least clears the old mortgage. Pure: the machine raises and clears the issues.
 */
import { profileOf } from './transactions';
import { fundsFromFor } from './shapes';
import type { ClientMoney, FundsRole, MatterState } from './types';

export const EMPTY_MONEY: ClientMoney = { requested: {}, received: {}, uncleared: [], statementBalancePennies: null, refunds: [] };
export const moneyOf = (s: MatterState): ClientMoney => ({ ...EMPTY_MONEY, ...(s.money ?? {}) });

export const pounds = (p: number) => `£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** For a task's title: £10,000 for whole pounds, £10,000.50 otherwise. */
export const poundsShort = (p: number) => `£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: Math.abs(p) % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export interface Position {
  /** What should have come in from the payers who have sent something (null: nothing to compare against). */
  expectedPennies: number | null;
  receivedPennies: number;
  /** Short of what was expected: the client makes it up. */
  shortfallPennies: number;
  /** More than expected, and the extra came from the client (or their ISA): it goes back. */
  surplusPennies: number;
  /** Who the surplus goes back to. */
  surplusTo: FundsRole | null;
  /** Each payer's own gap, for the issue's detail. */
  lines: Array<{ role: FundsRole; expectedPennies: number; receivedPennies: number }>;
}

/** What each payer was expected to send. Only payers with a figure to compare against are listed. */
export function expectations(s: MatterState, contract: { pricePennies?: number | null; depositPennies?: number | null } = {}): Partial<Record<FundsRole, number>> {
  const m = moneyOf(s);
  const p = profileOf(s.transactionType ?? 'freehold_purchase');
  const out: Partial<Record<FundsRole, number>> = {};
  for (const role of ['client', 'isa_provider', 'lender', 'incoming_owner'] as FundsRole[]) if (m.requested[role] != null) out[role] = m.requested[role]!;
  const offer = (s.mortgage.facts as { amountPennies?: number | null } | null)?.amountPennies ?? null;
  if (out.lender == null && s.hasLender && offer && (p.side === 'buyer' || p.type === 'remortgage')) out.lender = offer;
  if (p.side === 'seller') {
    const price = contract.pricePennies ?? s.purchasePricePennies ?? null;
    const deposit = contract.depositPennies ?? s.deposit.contractPennies ?? null;
    if (price != null && deposit != null) out.buyer_solicitor = price - deposit;
  }
  return out;
}

/** Where the money stands: compared only across payers who have sent something, so a lender still to pay is not a shortfall. */
export function position(s: MatterState, received: Partial<Record<FundsRole, number>> = moneyOf(s).received, contract: { pricePennies?: number | null; depositPennies?: number | null } = {}): Position {
  const expected = expectations(s, contract);
  const lines = (Object.keys(received) as FundsRole[]).filter((r) => expected[r] != null).map((role) => ({ role, expectedPennies: expected[role]!, receivedPennies: received[role] ?? 0 }));
  const receivedPennies = Object.values(received).reduce((a, b) => a + (b ?? 0), 0);
  // A remortgage must at least clear the old mortgage: the advance short of the redemption figure is the client's to top up.
  const p = profileOf(s.transactionType ?? 'freehold_purchase');
  const redemption = p.type === 'remortgage' && s.redemption.status !== 'not_required' ? s.redemption.redemptionPennies ?? null : null;
  if (!lines.length && redemption == null) return { expectedPennies: null, receivedPennies, shortfallPennies: 0, surplusPennies: 0, surplusTo: null, lines };
  // What is needed is the sum of the figures asked for; every receipt counts towards it (the client covering a lender's deduction pays more than their own figure).
  const exp = lines.reduce((a, l) => a + l.expectedPennies, 0);
  const got = (Object.keys(received) as FundsRole[]).filter((r) => expected[r] != null || r === 'client' || r === 'isa_provider').reduce((a, r) => a + (received[r] ?? 0), 0);
  let net = got - exp;
  if (redemption != null && received.lender != null) net = Math.min(net, receivedPennies - redemption);
  const clientOver = lines.filter((l) => l.role === 'client' || l.role === 'isa_provider').reduce((a, l) => a + Math.max(0, l.receivedPennies - l.expectedPennies), 0);
  const surplusPennies = net > 0 ? Math.min(net, clientOver) : 0;
  const over = lines.find((l) => (l.role === 'client' || l.role === 'isa_provider') && l.receivedPennies > l.expectedPennies);
  return { expectedPennies: exp, receivedPennies, shortfallPennies: net < 0 ? -net : 0, surplusPennies, surplusTo: surplusPennies > 0 ? over?.role ?? 'client' : null, lines };
}

/** Who must have paid before the completion money is all in: the lender only when there is one, the incoming owner only when there is consideration. */
export function payersExpected(s: MatterState): FundsRole[] {
  return fundsFromFor(profileOf(s.transactionType ?? 'freehold_purchase').fundsFrom, s.shapes ?? []).filter((r) => (r === 'lender' ? s.hasLender : r === 'incoming_owner' ? (s.considerationPennies ?? 0) > 0 : true));
}

/** The refunds still to make. */
export const refundsDue = (s: MatterState) => moneyOf(s).refunds.filter((r) => !r.paidAt);

/**
 * What is held when a file stops: every receipt goes back where it came from. An ISA bonus goes
 * back to the ISA manager, never the client; an advance goes back to the lender. A deposit already
 * released to the seller at exchange is not ours to return.
 */
export function heldOnAbandon(s: MatterState): Array<{ toRole: FundsRole; amountPennies: number | null; reason: string }> {
  const m = moneyOf(s);
  const out: Array<{ toRole: FundsRole; amountPennies: number | null; reason: string }> = [];
  if (s.deposit.received && !s.exchange.exchangedAt) out.push({ toRole: 'client', amountPennies: s.deposit.amountPennies ?? null, reason: 'The deposit, held for an exchange that will not happen' });
  for (const role of Object.keys(m.received) as FundsRole[]) {
    const amount = m.received[role] ?? 0;
    if (!amount || role === 'buyer_solicitor' || role === 'incoming_owner') continue;
    out.push({ toRole: role, amountPennies: amount, reason: role === 'isa_provider' ? 'The ISA bonus: it goes back to the ISA manager, not the client' : role === 'lender' ? 'The advance: it goes back to the lender' : "The client's completion money" });
  }
  return out;
}

export const ROLE_LABEL: Record<FundsRole, string> = { client: 'the client', isa_provider: 'the ISA manager', lender: 'the lender', buyer_solicitor: "the buyer's solicitor", incoming_owner: 'the incoming owner' };

/**
 * Interest on client money (SRA Accounts Rules 7.1; money.md 10.2): a fair sum on what the client's money earned while we held
 * it, worked out from the receipts to completion. The rate and the floor below which nothing is paid are the firm's policy.
 */
export const CLIENT_INTEREST = { ratePercent: 1, minimumPennies: 2000 };
export function interestDue(s: MatterState, until: Date, policy = CLIENT_INTEREST): number {
  const end = s.completion.confirmedAt ? new Date(s.completion.confirmedAt) : until;
  let total = 0;
  for (const r of s.receipts ?? []) {
    if (!r.amountPennies || r.purpose === 'fees') continue;
    const days = Math.max(0, (end.getTime() - Date.parse(r.at)) / 86_400_000);
    total += (r.amountPennies * policy.ratePercent * days) / (100 * 365);
  }
  return Math.round(total);
}
