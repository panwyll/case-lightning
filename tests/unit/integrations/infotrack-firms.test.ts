/**
 * InfoTrack per firm (docs/infotrack-integration.md): each firm orders on its own account; a firm
 * with none gets the stand-in, whose placeholder is never mistaken for a real order; a firm's
 * result URL answers only that firm's orders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirmInfoTrackRouter, InfoTrackClient, MemoryOrderStore, handleInfoTrackResult, type HttpResponse, type HttpTransport } from '../../../lib/server/integrations/infotrack';
import { MockIdCheckProvider, MockSearchProvider } from '../../../lib/server/engine/mocks';
import { sandboxGuard } from '../../../lib/server/engine/sandbox';
import { harness } from '../engine/helpers';

const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, text: async () => JSON.stringify(body), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer });

function account(bodies: unknown[]) {
  const calls: Array<{ url: string; body?: string }> = [];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url.endsWith('/oauth/token')) return json(200, { access_token: 'tok', expires_in: 3600 });
    return json(200, bodies.shift());
  };
  return { client: new InfoTrackClient({ baseUrl: 'https://api.infotrack.test', clientId: 'id', clientSecret: 's', backoffMs: 0 }, t), calls };
}

const lookup = async () => ({ matterRef: 'KT2', address: '1 Test St', buyerNames: ['Priya Shah'], clientEmail: 'priya@example.com', clientPhone: null, titleNumber: null });
const standIn = () => ({ search: new MockSearchProvider({ placeholders: true }), idCheck: new MockIdCheckProvider() });

test('a firm with its own account orders on it; a firm without gets a placeholder that says so', async () => {
  const acme = account([{ orderId: 'IT-1', status: 'ORDERED' }]);
  const orders = new MemoryOrderStore();
  const router = new FirmInfoTrackRouter({ clientFor: async (t) => (t === 'acme' ? acme.client : null) }, orders, lookup, standIn());

  const real = await router.orderSearch({ tenantId: 'acme', matterId: 'm1', searchType: 'CON29' });
  assert.deepEqual(real, { reference: 'IT-1', provider: 'infotrack' });
  assert.equal(router.placeholderResult({ searchType: 'CON29', reference: real.reference, orderedAt: new Date() }), null, 'a real order waits for InfoTrack');
  assert.equal((await orders.find('infotrack', 'IT-1'))?.tenantId, 'acme');

  const none = await router.orderSearch({ tenantId: 'other', matterId: 'm2', searchType: 'CON29' });
  assert.match(none.provider, /mock-search/);
  const stub = router.placeholderResult({ searchType: 'CON29', reference: none.reference, orderedAt: new Date('2026-10-01') });
  assert.ok(stub && /PLACEHOLDER/.test(stub.fileName) && /No search was carried out/.test(stub.content));
  assert.equal(acme.calls.filter((c) => !c.url.endsWith('/oauth/token')).length, 1, 'the other firm never touched acme\'s account');
});

test('an ID check for a named party is ordered in their name, without the client\'s contact details', async () => {
  const acme = account([{ orderId: 'ID-1', status: 'ORDERED' }, { orderId: 'ID-2', status: 'ORDERED' }]);
  const router = new FirmInfoTrackRouter({ clientFor: async () => acme.client }, new MemoryOrderStore(), lookup, standIn());
  await router.requestCheck({ tenantId: 'acme', matterId: 'm1' });
  await router.requestCheck({ tenantId: 'acme', matterId: 'm1', party: 'donor:anita-shah', label: 'Anita Shah (gift donor)' });
  const [first, donor] = acme.calls.filter((c) => !c.url.endsWith('/oauth/token')).map((c) => JSON.parse(c.body ?? '{}').subject);
  assert.deepEqual(first, { name: 'Priya Shah', email: 'priya@example.com', phone: null });
  assert.deepEqual(donor, { name: 'Anita Shah', email: null, phone: null });
  assert.deepEqual(router.forFirm('acme'), { sendsClientLink: true, label: 'InfoTrack' });
});

test('the sandbox guard keeps the placeholder and the firm routing (a dropped placeholder left live searches waiting forever)', async () => {
  const router = new FirmInfoTrackRouter({ clientFor: async () => null }, new MemoryOrderStore(), lookup, standIn());
  const guarded = sandboxGuard({ ...harness().ports, searchProvider: router, idCheckProvider: router });
  assert.equal(typeof guarded.searchProvider.placeholderResult, 'function');
  assert.equal(typeof guarded.idCheckProvider.forFirm, 'function');
  assert.ok(guarded.searchProvider.placeholderResult!({ searchType: 'LLC1', reference: 'STANDIN:MOCK-LLC1-1', orderedAt: new Date() }));
  assert.equal(guarded.searchProvider.placeholderResult!({ searchType: 'LLC1', reference: 'MOCK-LLC1-1', orderedAt: new Date() }), null, 'a sandbox\'s own mock order is not a stand-in');
});

test('a result delivered to one firm\'s URL is not applied to another firm\'s order', async () => {
  const orders = new MemoryOrderStore();
  await orders.record({ tenantId: 'acme', matterId: 'm1', provider: 'infotrack', kind: 'search', subject: 'CON29', providerRef: 'IT-9', status: 'ORDERED' }, {});
  const deps = { client: account([]).client, orders, filer: { file: async () => 'doc' }, router: { alreadyHave: async () => false, searchReturned: async () => null, titleReceived: async () => null, idCheckResultReceived: async () => null } };
  const event = { deliveryId: 'd1', reference: 'IT-9', event: 'order.completed', raw: {} };
  assert.equal((await handleInfoTrackResult({ ...deps, tenantId: 'other' }, event)).status, 'IGNORED');
  assert.equal((await orders.find('infotrack', 'IT-9'))?.status, 'ORDERED');
});
