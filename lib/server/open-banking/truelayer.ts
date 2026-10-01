/**
 * TrueLayer Data API (UK open banking, FCA-authorised AISP). The client is sent to TrueLayer's auth
 * link (straight to their bank when they picked one), signs in at the bank, consents, and comes back
 * to our one registered callback with a one-time code. We exchange the code for an access token (no
 * offline access is asked for: the data is read once), then read the accounts, the account holder,
 * each balance and up to HISTORY_DAYS of transactions. Nothing is stored but the statements.
 *
 * Set TRUELAYER_CLIENT_ID, TRUELAYER_CLIENT_SECRET and TRUELAYER_ENV (sandbox | live); register
 * <app>/api/v1/open-banking/callback as a redirect URI in the TrueLayer console.
 */
import { pennies, toStatement, type ConnectedAccount, type Institution, type OpenBankingProvider } from './provider';

/** "Let TrueLayer show its own bank list": the picker's fallback when the provider list cannot be read. */
export const ANY_BANK = 'tl:any';
type Env = 'sandbox' | 'live';
const hosts = (env: Env) => env === 'sandbox' ? { auth: 'https://auth.truelayer-sandbox.com', api: 'https://api.truelayer-sandbox.com' } : { auth: 'https://auth.truelayer.com', api: 'https://api.truelayer.com' };
type TlAccount = { account_id: string; display_name?: string; currency?: string; account_number?: { iban?: string; number?: string; sort_code?: string }; provider?: { display_name?: string; provider_id?: string } };
type TlTx = { timestamp: string; description?: string; amount: number; transaction_type?: string; merchant_name?: string; meta?: { counter_party_preferred_name?: string; provider_reference?: string }; running_balance?: { amount: number } };

export class TrueLayerData implements OpenBankingProvider {
  readonly name: string;
  private readonly h: { auth: string; api: string };
  private list: { at: number; banks: Institution[] } | null = null;
  constructor(private creds: { clientId: string; clientSecret: string; env: Env }, private http: typeof fetch = fetch, private now: () => Date = () => new Date()) {
    this.name = `truelayer-${creds.env}`;
    this.h = hosts(creds.env);
  }

  async institutions(country: string): Promise<Institution[]> {
    if (this.list && Date.now() - this.list.at < 6 * 3_600_000) return this.list.banks;
    let banks: Institution[] = [];
    try {
      const r = await this.http(`${this.h.auth}/api/providers?client_id=${encodeURIComponent(this.creds.clientId)}`, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const rows = (await r.json()) as Array<{ provider_id: string; display_name: string; logo_url?: string; country?: string; scopes?: string[] }>;
        const want = country.toLowerCase() === 'gb' ? ['gb', 'uk'] : [country.toLowerCase()];
        banks = rows.filter((x) => !x.country || want.includes(x.country.toLowerCase())).filter((x) => !x.scopes || x.scopes.includes('transactions')).map((x) => ({ id: x.provider_id, name: x.display_name, logo: x.logo_url ?? null, historyDays: null }));
      }
    } catch { /* fall back to TrueLayer's own picker */ }
    // TrueLayer's own bank list always works, so the client is never stuck.
    banks.push({ id: ANY_BANK, name: banks.length ? 'My Bank Is Not Listed' : 'Choose Your Bank On TrueLayer', logo: null, historyDays: null });
    this.list = { at: Date.now(), banks };
    return banks;
  }

  async start(input: { reference: string; institutionId: string; callbackUrl: string; state: string; historyDays: number }): Promise<{ providerRef: string; link: string }> {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.creds.clientId,
      scope: 'info accounts balance transactions',
      redirect_uri: input.callbackUrl,
      state: input.state,
      providers: this.creds.env === 'sandbox' ? 'uk-cs-mock uk-ob-all uk-oauth-all' : 'uk-ob-all uk-oauth-all',
    });
    if (input.institutionId !== ANY_BANK) q.set('provider_id', input.institutionId);
    return { providerRef: input.reference, link: `${this.h.auth}/?${q.toString()}` };
  }

  private async get<T>(token: string, path: string): Promise<T> {
    const r = await this.http(`${this.h.api}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error(`The bank's data could not be read (${r.status}).`), { status: r.status });
    return (await r.json()) as T;
  }

  async collect(_ref: string, institution: { id: string; name: string }, back: { code?: string | null; callbackUrl: string; historyDays: number }): Promise<{ status: 'linked' | 'failed'; accounts: ConnectedAccount[]; reason?: string }> {
    if (!back.code) return { status: 'failed', accounts: [], reason: 'The bank connection was not completed.' };
    const tr = await this.http(`${this.h.auth}/connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: this.creds.clientId, client_secret: this.creds.clientSecret, redirect_uri: back.callbackUrl, code: back.code }).toString() });
    if (!tr.ok) return { status: 'failed', accounts: [], reason: 'The bank connection could not be completed. Please try again.' };
    const { access_token: token } = (await tr.json()) as { access_token: string };
    const now = this.now();
    const from = new Date(now.getTime() - back.historyDays * 86_400_000).toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    const [accounts, info] = await Promise.all([
      this.get<{ results: TlAccount[] }>(token, '/data/v1/accounts'),
      this.get<{ results: Array<{ full_name?: string }> }>(token, '/data/v1/info').catch(() => ({ results: [] })),
    ]);
    const holder = info.results.map((x) => x.full_name).filter(Boolean).join(' & ') || null;
    const out: ConnectedAccount[] = [];
    for (const a of accounts.results) {
      const [bal, txs] = await Promise.all([
        this.get<{ results: Array<{ current?: number; available?: number }> }>(token, `/data/v1/accounts/${a.account_id}/balance`).catch(() => ({ results: [] })),
        this.get<{ results: TlTx[] }>(token, `/data/v1/accounts/${a.account_id}/transactions?from=${from}&to=${to}`),
      ]);
      const bankName = a.provider?.display_name ?? (institution.id === ANY_BANK ? 'Bank' : institution.name);
      const num = (a.account_number?.number ?? a.account_number?.iban ?? '').replace(/\s/g, '');
      const current = bal.results[0]?.current ?? bal.results[0]?.available;
      const lines = txs.results.map((t) => {
        // TrueLayer gives debits as negative amounts; a DEBIT given as positive is turned round.
        const signed = t.transaction_type === 'DEBIT' && t.amount > 0 ? -t.amount : t.amount;
        return { date: t.timestamp.slice(0, 10), description: (t.description || t.merchant_name || 'Transaction').trim(), amountPennies: pennies(signed), counterparty: t.meta?.counter_party_preferred_name ?? t.merchant_name ?? null, balancePennies: t.running_balance ? pennies(t.running_balance.amount) : null };
      });
      out.push({ providerAccountId: a.account_id, bankName, holder, last4: num ? num.slice(-4) : null, currency: a.currency ?? 'GBP', statement: toStatement({ bankName: a.display_name ? `${bankName} ${a.display_name}` : bankName, holder, last4: num ? num.slice(-4) : null, closingPennies: current != null ? pennies(current) : null, transactions: lines, asOf: now.toISOString() }) });
    }
    return out.length ? { status: 'linked', accounts: out } : { status: 'failed', accounts: [], reason: 'No accounts were shared.' };
  }
}
