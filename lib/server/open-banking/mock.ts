/**
 * The demo bank: used in development, in tests and wherever no provider is configured outside
 * production. Three accounts with 24 months of realistic history, so the whole flow (connect, come
 * back, analyse) runs end to end without a bank. Its link goes straight back to the form.
 */
import { toStatement, type ConnectedAccount, type Institution, type OpenBankingProvider } from './provider';
import type { StatementTransaction } from '../engine/proof-of-funds';

export const DEMO_INSTITUTIONS: Institution[] = [
  { id: 'DEMO_SALARY', name: 'Demo Bank · Salaried Saver', logo: null, historyDays: 730 },
  { id: 'DEMO_DONOR', name: 'Demo Bank · Gift Donor', logo: null, historyDays: 730 },
  { id: 'DEMO_MIXED', name: 'Demo Bank · Mixed Activity', logo: null, historyDays: 730 },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const back = (now: Date, days: number) => iso(new Date(now.getTime() - days * 86_400_000));

/** Two years of a scenario's lines, newest first as a bank would give them. */
export function demoTransactions(scenario: string, now: Date, holder: string): { lines: StatementTransaction[]; closing: number } {
  const L: StatementTransaction[] = [];
  const surname = holder.trim().split(/\s+/).slice(-1)[0] || 'Client';
  for (let m = 0; m < 24; m++) {
    const d = (n: number) => back(now, m * 30 + n);
    if (scenario === 'DEMO_SALARY' || scenario === 'DEMO_MIXED') {
      L.push({ date: d(3), description: 'ACME LTD SALARY', amountPennies: 3_200_00, counterparty: 'ACME LTD' });
      L.push({ date: d(5), description: 'RENT', amountPennies: -1_100_00, counterparty: 'HOMELETS' });
      L.push({ date: d(9), description: 'TESCO STORES', amountPennies: -320_00, counterparty: 'TESCO' });
      L.push({ date: d(14), description: 'COUNCIL TAX', amountPennies: -150_00, counterparty: 'KINGSTON COUNCIL' });
    }
    if (scenario === 'DEMO_SALARY') L.push({ date: d(20), description: 'EVERYDAY SPEND', amountPennies: -420_00, counterparty: null });
    if (scenario === 'DEMO_DONOR') {
      L.push({ date: d(2), description: 'STATE PENSION', amountPennies: 900_00, counterparty: 'DWP' });
      L.push({ date: d(4), description: 'OCCUPATIONAL PENSION', amountPennies: 1_400_00, counterparty: 'AVIVA PENSIONS' });
      L.push({ date: d(12), description: 'SPENDING', amountPennies: -1_100_00, counterparty: null });
    }
    if (scenario === 'DEMO_MIXED') {
      L.push({ date: d(16), description: 'BET365', amountPennies: -180_00, counterparty: 'BET365' });
      if (m < 4) L.push({ date: d(22), description: 'NOVUNA PERSONAL LOAN', amountPennies: -260_00, counterparty: 'NOVUNA' });
    }
  }
  if (scenario === 'DEMO_DONOR') L.push({ date: back(now, 40), description: 'COMPLETION MONIES', amountPennies: 85_000_00, counterparty: 'SMITH & CO SOLICITORS LLP' });
  if (scenario === 'DEMO_MIXED') {
    L.push({ date: back(now, 60), description: 'CASH PAID IN', amountPennies: 2_500_00, counterparty: null });
    L.push({ date: back(now, 45), description: 'COINBASE UK', amountPennies: 12_000_00, counterparty: 'COINBASE' });
    L.push({ date: back(now, 30), description: `TRANSFER FROM ${surname.toUpperCase()}`, amountPennies: 8_000_00, counterparty: holder });
  }
  const opening = scenario === 'DEMO_SALARY' ? 22_000_00 : scenario === 'DEMO_DONOR' ? 40_000_00 : 3_000_00;
  const closing = opening + L.reduce((a, t) => a + t.amountPennies, 0);
  return { lines: L, closing };
}

export class DemoBank implements OpenBankingProvider {
  readonly name = 'demo-bank';
  constructor(private now: () => Date = () => new Date()) {}
  async institutions(): Promise<Institution[]> { return DEMO_INSTITUTIONS; }
  async start(input: { reference: string; institutionId: string; callbackUrl: string; state: string; historyDays: number; holderHint?: string | null }): Promise<{ providerRef: string; link: string }> {
    const ref = `demo:${input.institutionId}:${Buffer.from(input.holderHint ?? 'Demo Client').toString('base64url')}`;
    // No bank to visit: straight back, as a bank would send the client.
    return { providerRef: ref, link: `${input.callbackUrl}?state=${encodeURIComponent(input.state)}&code=demo` };
  }
  async collect(providerRef: string, institution: { id: string; name: string }, _back?: { code?: string | null; callbackUrl: string; historyDays: number }): Promise<{ status: 'linked'; accounts: ConnectedAccount[] }> {
    const [, scenario, h] = providerRef.split(':');
    const holder = Buffer.from(h ?? '', 'base64url').toString() || 'Demo Client';
    const { lines, closing } = demoTransactions(scenario, this.now(), holder);
    const statement = toStatement({ bankName: institution.name, holder: holder.toUpperCase(), last4: scenario === 'DEMO_DONOR' ? '7310' : '4821', closingPennies: closing, transactions: lines, asOf: this.now().toISOString() });
    return { status: 'linked', accounts: [{ providerAccountId: `${scenario}-1`, bankName: institution.name, holder: holder.toUpperCase(), last4: statement.accountLast4, currency: 'GBP', statement }] };
  }
}
