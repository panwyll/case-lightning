/**
 * GoCardless Bank Account Data (formerly Nordigen): PSD2 account information across UK and EU banks.
 * Flow: a token from the secret id/key → an end-user agreement asking for up to HISTORY_DAYS of
 * history (capped at the bank's own limit) → a requisition whose link the client follows → on return,
 * the requisition's accounts → each account's details, balances and booked transactions.
 * Set GOCARDLESS_SECRET_ID and GOCARDLESS_SECRET_KEY (from the Bank Account Data portal).
 */
import { pennies, toStatement, type ConnectedAccount, type Institution, type OpenBankingProvider } from './provider';

const BASE = 'https://bankaccountdata.gocardless.com/api/v2';
type Tx = { transactionId?: string; bookingDate?: string; valueDate?: string; transactionAmount: { amount: string; currency: string }; creditorName?: string; debtorName?: string; remittanceInformationUnstructured?: string; remittanceInformationUnstructuredArray?: string[]; additionalInformation?: string; balanceAfterTransaction?: { balanceAmount: { amount: string } } };

export class GoCardlessBankData implements OpenBankingProvider {
  readonly name = 'gocardless-bank-account-data';
  private token: { access: string; until: number } | null = null;
  private institutionCache = new Map<string, { at: number; list: Institution[] }>();
  constructor(private creds: { secretId: string; secretKey: string }, private http: typeof fetch = fetch) {}

  private async auth(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.access;
    const r = await this.http(`${BASE}/token/new/`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ secret_id: this.creds.secretId, secret_key: this.creds.secretKey }) });
    if (!r.ok) throw new Error(`Open banking sign-in failed (${r.status}).`);
    const j = (await r.json()) as { access: string; access_expires: number };
    this.token = { access: j.access, until: Date.now() + j.access_expires * 1000 };
    return j.access;
  }
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await this.http(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${await this.auth()}`, ...(init.headers ?? {}) } });
    if (!r.ok) throw Object.assign(new Error(`Open banking ${path.split('/')[1]} failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`), { status: r.status });
    return (await r.json()) as T;
  }

  async institutions(country: string): Promise<Institution[]> {
    const hit = this.institutionCache.get(country);
    if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.list;
    const rows = await this.call<Array<{ id: string; name: string; logo?: string; transaction_total_days?: string }>>(`/institutions/?country=${encodeURIComponent(country)}`);
    const list = rows.map((x) => ({ id: x.id, name: x.name, logo: x.logo ?? null, historyDays: x.transaction_total_days ? Number(x.transaction_total_days) : null }));
    this.institutionCache.set(country, { at: Date.now(), list });
    return list;
  }

  async start(input: { reference: string; institutionId: string; callbackUrl: string; state: string; historyDays: number }): Promise<{ providerRef: string; link: string }> {
    const inst = (await this.institutions('gb')).find((x) => x.id === input.institutionId);
    const maxDays = Math.min(input.historyDays, inst?.historyDays ?? input.historyDays);
    const agreement = await this.call<{ id: string }>('/agreements/enduser/', { method: 'POST', body: JSON.stringify({ institution_id: input.institutionId, max_historical_days: maxDays, access_valid_for_days: 7, access_scope: ['balances', 'details', 'transactions'] }) });
    const req = await this.call<{ id: string; link: string }>('/requisitions/', { method: 'POST', body: JSON.stringify({ redirect: `${input.callbackUrl}?state=${encodeURIComponent(input.state)}`, institution_id: input.institutionId, reference: input.reference, agreement: agreement.id, user_language: 'EN' }) });
    return { providerRef: req.id, link: req.link };
  }

  async collect(providerRef: string, institution: { id: string; name: string }, _back?: { code?: string | null; callbackUrl: string; historyDays: number }): Promise<{ status: 'pending' | 'linked' | 'failed' | 'expired'; accounts: ConnectedAccount[]; reason?: string }> {
    const req = await this.call<{ status: string; accounts: string[] }>(`/requisitions/${providerRef}/`);
    if (req.status === 'EX') return { status: 'expired', accounts: [], reason: 'The bank connection expired before it was completed.' };
    if (req.status === 'RJ' || (req.status === 'SU' && !req.accounts.length)) return { status: 'failed', accounts: [], reason: 'The bank did not share any accounts.' };
    if (req.status !== 'LN') return { status: 'pending', accounts: [] };
    const asOf = new Date().toISOString();
    const accounts: ConnectedAccount[] = [];
    for (const id of req.accounts) {
      const [details, balances, txs] = await Promise.all([
        this.call<{ account: { iban?: string; bban?: string; currency?: string; ownerName?: string; name?: string } }>(`/accounts/${id}/details/`).catch(() => ({ account: {} as { iban?: string; bban?: string; currency?: string; ownerName?: string; name?: string } })),
        this.call<{ balances: Array<{ balanceAmount: { amount: string }; balanceType: string }> }>(`/accounts/${id}/balances/`).catch(() => ({ balances: [] })),
        this.call<{ transactions: { booked: Tx[] } }>(`/accounts/${id}/transactions/`),
      ]);
      const pick = (t: string) => balances.balances.find((b) => b.balanceType === t)?.balanceAmount.amount;
      const bal = pick('interimBooked') ?? pick('closingBooked') ?? pick('interimAvailable') ?? pick('expected') ?? balances.balances[0]?.balanceAmount.amount;
      const acct = details.account;
      const num = (acct.iban ?? acct.bban ?? '').replace(/\s/g, '');
      const lines = (txs.transactions.booked ?? []).map((t) => {
        const amount = pennies(t.transactionAmount.amount);
        const counterparty = (amount >= 0 ? t.debtorName : t.creditorName) ?? null;
        const description = [t.remittanceInformationUnstructured, ...(t.remittanceInformationUnstructuredArray ?? []), t.additionalInformation].filter(Boolean).join(' ').trim() || counterparty || 'Transaction';
        return { date: (t.bookingDate ?? t.valueDate ?? asOf).slice(0, 10), description, amountPennies: amount, counterparty, balancePennies: t.balanceAfterTransaction ? pennies(t.balanceAfterTransaction.balanceAmount.amount) : null };
      });
      accounts.push({ providerAccountId: id, bankName: institution.name, holder: acct.ownerName ?? null, last4: num ? num.slice(-4) : null, currency: acct.currency ?? 'GBP', statement: toStatement({ bankName: institution.name, holder: acct.ownerName ?? null, last4: num ? num.slice(-4) : null, closingPennies: bal != null ? pennies(bal) : null, transactions: lines, asOf }) });
    }
    return { status: 'linked', accounts };
  }
}
