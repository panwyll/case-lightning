/**
 * The TrueLayer adapter against a scripted TrueLayer (no network): the auth link, the code exchange,
 * accounts, holder, balance and two years of transactions turned into a statement the rules read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANY_BANK, TrueLayerData } from '../../../lib/server/open-banking/truelayer';
import { connectionState, readState } from '../../../lib/server/open-banking/state';

const NOW = new Date('2026-09-20T10:00:00Z');
function fakeTrueLayer() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/api/providers')) return json([{ provider_id: 'ob-monzo', display_name: 'Monzo', logo_url: 'https://x/monzo.svg', country: 'uk', scopes: ['info', 'accounts', 'balance', 'transactions'] }, { provider_id: 'ob-cards-only', display_name: 'Cards Only', country: 'uk', scopes: ['cards'] }]);
    if (url.endsWith('/connect/token')) return String(init?.body).includes('code=good') ? json({ access_token: 'at-1', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
    if (url.endsWith('/data/v1/accounts')) return json({ results: [{ account_id: 'acc-1', display_name: 'Current Account', currency: 'GBP', account_number: { number: '12345678', sort_code: '04-00-04' }, provider: { display_name: 'Monzo', provider_id: 'ob-monzo' } }] });
    if (url.endsWith('/data/v1/info')) return json({ results: [{ full_name: 'Priya Shah' }] });
    if (url.includes('/balance')) return json({ results: [{ current: 15234.5, available: 15000 }] });
    if (url.includes('/transactions')) return json({ results: [
      { timestamp: '2026-08-28T00:00:00Z', description: 'ACME LTD SALARY', amount: 3200, transaction_type: 'CREDIT', meta: { counter_party_preferred_name: 'ACME LTD' } },
      { timestamp: '2026-08-30T00:00:00Z', description: 'TESCO', amount: -54.2, transaction_type: 'DEBIT', merchant_name: 'Tesco' },
      { timestamp: '2026-09-01T00:00:00Z', description: 'RENT', amount: 1100, transaction_type: 'DEBIT' },
    ] });
    return json({}, 404);
  }) as typeof fetch;
  return { http, calls };
}

test('TrueLayer: the bank list (transactions-capable banks, plus TrueLayer\'s own picker) and the auth link straight to the chosen bank', async () => {
  const { http } = fakeTrueLayer();
  const tl = new TrueLayerData({ clientId: 'cid', clientSecret: 'sec', env: 'sandbox' }, http, () => NOW);
  const banks = await tl.institutions('gb');
  assert.deepEqual(banks.map((b) => b.id), ['ob-monzo', ANY_BANK], 'a bank that cannot give transactions is not offered');
  const { link, providerRef } = await tl.start({ reference: 'conn-1', institutionId: 'ob-monzo', callbackUrl: 'https://app.test/api/v1/open-banking/callback', state: 'st', historyDays: 730 });
  const u = new URL(link);
  assert.equal(u.origin, 'https://auth.truelayer-sandbox.com');
  assert.equal(u.searchParams.get('scope'), 'info accounts balance transactions', 'read once: no offline access asked for');
  assert.equal(u.searchParams.get('provider_id'), 'ob-monzo');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.test/api/v1/open-banking/callback');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(providerRef, 'conn-1');
  const any = new URL((await tl.start({ reference: 'c', institutionId: ANY_BANK, callbackUrl: 'https://app.test/cb', state: 's', historyDays: 730 })).link);
  assert.equal(any.searchParams.get('provider_id'), null, 'TrueLayer shows its own list');
});

test('TrueLayer: the code is exchanged once, and the account comes back as a statement in the holder\'s name with two years asked for', async () => {
  const { http, calls } = fakeTrueLayer();
  const tl = new TrueLayerData({ clientId: 'cid', clientSecret: 'sec', env: 'live' }, http, () => NOW);
  const bad = await tl.collect('c', { id: 'ob-monzo', name: 'Monzo' }, { code: 'expired', callbackUrl: 'https://app.test/cb', historyDays: 730 });
  assert.equal(bad.status, 'failed');
  const got = await tl.collect('c', { id: 'ob-monzo', name: 'Monzo' }, { code: 'good', callbackUrl: 'https://app.test/cb', historyDays: 730 });
  assert.equal(got.status, 'linked');
  const a = got.accounts[0];
  assert.equal(a.holder, 'Priya Shah');
  assert.equal(a.last4, '5678');
  const st = a.statement;
  assert.equal(st.closingBalancePennies, 1_523_450);
  assert.deepEqual(st.transactions.map((t) => t.amountPennies), [320_000, -5_420, -110_000], 'a DEBIT given as a positive amount is turned round');
  assert.equal(st.openingBalancePennies, 1_523_450 - (320_000 - 5_420 - 110_000), 'the opening balance worked back from today');
  const txCall = calls.find((c) => c.url.includes('/transactions'))!;
  assert.match(txCall.url, /^https:\/\/api\.truelayer\.com\/data\/v1\/accounts\/acc-1\/transactions\?from=2024-09-20&to=2026-09-20$/);
  assert.match(String(calls.find((c) => c.url.endsWith('/connect/token'))!.init?.body), /client_secret=sec/);
});

test('the state that goes to the bank is signed: only a connection we started can be finished', () => {
  const id = '3f2b8c1e-1d2a-4b3c-9d8e-7f6a5b4c3d2e';
  assert.equal(readState(connectionState(id)), id);
  assert.equal(readState(`${id}.forged`), null);
  assert.equal(readState('not-a-state'), null);
  assert.equal(readState(connectionState(id).replace(id, '00000000-0000-4000-8000-000000000000')), null);
});
