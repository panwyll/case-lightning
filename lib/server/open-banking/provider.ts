/**
 * Open banking for source of funds (docs/proof-of-funds.md §9). The client (or their donor) connects
 * their bank from the proof-of-funds form and the account's own transactions come back: bank-verified,
 * holder named by the bank, up to 24 months where the bank gives it. Each account becomes a document
 * on the case whose facts are a StatementFacts, so every rule that reads an uploaded statement reads it.
 *
 * The provider is an adapter behind this interface (GoCardless Bank Account Data today; TrueLayer,
 * Yapily or a firm's own contract can be added the same way). The consent screen and the bank login
 * are the provider's and the bank's: we never see the client's credentials.
 */
import type { StatementFacts, StatementTransaction } from '../engine/proof-of-funds';
import { incomeStreams } from '../engine/source-of-funds';

export interface Institution { id: string; name: string; logo: string | null; /** The furthest back this bank gives transactions, in days. */ historyDays: number | null }
export interface ConnectedAccount { providerAccountId: string; bankName: string; holder: string | null; last4: string | null; currency: string; statement: StatementFacts }
export type ConnectionStatus = 'pending' | 'linked' | 'failed' | 'expired';

export interface OpenBankingProvider {
  readonly name: string;
  institutions(country: string): Promise<Institution[]>;
  /** Start a connection: the link the client follows to their bank, and the provider's reference for it. */
  start(input: { reference: string; institutionId: string; redirectUrl: string; historyDays: number; /** Whose account is expected (the demo bank names its holder with it). */ holderHint?: string | null }): Promise<{ providerRef: string; link: string }>;
  /** After the client comes back: the accounts they shared, each with its transactions and balance. */
  collect(providerRef: string, institution: { id: string; name: string }): Promise<{ status: ConnectionStatus; accounts: ConnectedAccount[]; reason?: string }>;
}

/** How far back we ask for: 24 months, or less where the bank gives less. */
export const HISTORY_DAYS = 730;

/**
 * The bank's lines as a statement: oldest first, the running balance worked back from today's balance,
 * the opening balance at the start of the history, and the regular income the lines show.
 */
export function toStatement(input: { bankName: string; holder: string | null; last4: string | null; closingPennies: number | null; transactions: StatementTransaction[]; asOf: string }): StatementFacts {
  const txs = [...input.transactions].sort((a, b) => a.date.localeCompare(b.date) || 0);
  const net = txs.reduce((a, t) => a + t.amountPennies, 0);
  const closing = input.closingPennies;
  const opening = closing != null ? closing - net : null;
  if (opening != null) { let bal = opening; for (const t of txs) { bal += t.amountPennies; if (t.balancePennies == null) t.balancePennies = bal; } }
  const streams = incomeStreams(txs);
  const payers = new Set(streams.map((s) => s.payer));
  const salaryCredits = txs.filter((t) => t.amountPennies > 0 && payers.has((t.counterparty?.trim() || t.description))).map((t) => ({ date: t.date, amountPennies: t.amountPennies, payer: t.counterparty?.trim() || t.description }));
  return {
    accountHolder: input.holder,
    bankName: input.bankName,
    accountLast4: input.last4,
    periodFrom: txs[0]?.date ?? null,
    periodTo: input.asOf.slice(0, 10),
    openingBalancePennies: opening,
    closingBalancePennies: closing,
    transactions: txs,
    salaryCredits,
    confidence: 1,
  };
}

/** "£1,234.56" / "-12.3" as signed pennies. */
export const pennies = (amount: string | number): number => Math.round(Number(amount) * 100);
