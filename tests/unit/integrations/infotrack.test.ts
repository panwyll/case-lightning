import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { InfoTrackClient, InfoTrackError, InfoTrackSearchProvider, MemoryOrderStore, handleInfoTrackResult, type HttpResponse, type HttpTransport } from '../../../lib/server/integrations/infotrack';

const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, text: async () => JSON.stringify(body), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer });
const bytes = (status: number, b: Buffer): HttpResponse => ({ status, headers: {}, text: async () => b.toString(), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer });

function fakeTransport(script: Array<(url: string, init: { method: string; headers: Record<string, string>; body?: string }) => HttpResponse | Promise<HttpResponse>>) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }> = [];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    const step = script.shift();
    if (!step) throw new Error(`unexpected call ${init.method} ${url}`);
    return step(url, init);
  };
  return { t, calls };
}

const cfg = { baseUrl: 'https://api.infotrack.test', clientId: 'id', clientSecret: 'secret', backoffMs: 0, maxRetries: 2 };

test('token is fetched once and cached; a 401 forces one refresh', async () => {
  const { t, calls } = fakeTransport([
    () => json(200, { access_token: 'tok1', expires_in: 3600 }),
    () => json(200, { orderId: 'O1', status: 'ORDERED' }),
    () => json(200, { orderId: 'O2', status: 'ORDERED' }),
    () => json(401, {}),
    () => json(200, { access_token: 'tok2', expires_in: 3600 }),
    () => json(200, { orderId: 'O3', status: 'ORDERED' }),
  ]);
  const c = new InfoTrackClient(cfg, t);
  await c.orderSearch({ matterRef: 'M1', searchType: 'CON29', address: '1 Test St' });
  await c.orderSearch({ matterRef: 'M1', searchType: 'LLC1', address: '1 Test St' });
  assert.equal(calls.filter((x) => x.url.endsWith('/oauth/token')).length, 1);
  assert.equal(calls[1].init.headers.authorization, 'Bearer tok1');
  const r = await c.orderSearch({ matterRef: 'M1', searchType: 'ENVIRONMENTAL', address: '1 Test St' });
  assert.equal(r.reference, 'O3');
  assert.equal(calls[calls.length - 1].init.headers.authorization, 'Bearer tok2');
  assert.match(calls[1].init.body ?? '', /"product":"CON29R"/);
});

test('retries 503/429 with backoff then succeeds; gives up after maxRetries; never retries a 400', async () => {
  const { t, calls } = fakeTransport([
    () => json(200, { access_token: 'tok', expires_in: 3600 }),
    () => json(503, {}),
    () => json(429, {}, { 'retry-after': '0' }),
    () => json(200, { orderId: 'O1', status: 'ORDERED' }),
  ]);
  const c = new InfoTrackClient(cfg, t);
  const r = await c.orderIdCheck({ matterRef: 'M1', party: { name: 'A Buyer' } });
  assert.equal(r.reference, 'O1');
  assert.equal(calls.length, 4);

  const bad = fakeTransport([() => json(200, { access_token: 'tok', expires_in: 3600 }), () => json(400, { error: 'missing address' })]);
  await assert.rejects(new InfoTrackClient(cfg, bad.t).orderSearch({ matterRef: 'M1', searchType: 'CON29', address: '' }), (e: InfoTrackError) => e.status === 400 && e.retryable === false);
  assert.equal(bad.calls.length, 2);

  const down = fakeTransport([() => json(200, { access_token: 'tok', expires_in: 3600 }), () => json(500, {}), () => json(500, {}), () => json(500, {})]);
  await assert.rejects(new InfoTrackClient(cfg, down.t).getOrder('O1'), (e: InfoTrackError) => e.status === 500 && e.retryable === true);
});

test('webhook signature verification and parsing', () => {
  const body = JSON.stringify({ eventId: 'evt-1', event: 'order.completed', order: { orderId: 'O1', status: 'COMPLETED', document: { url: 'https://cdn.infotrack.test/x.pdf', fileName: 'con29.pdf' } } });
  const sig = crypto.createHmac('sha256', 'whsec').update(body).digest('hex');
  assert.ok(InfoTrackClient.verifySignature('whsec', body, sig));
  assert.ok(InfoTrackClient.verifySignature('whsec', body, `sha256=${sig}`));
  assert.ok(!InfoTrackClient.verifySignature('whsec', body, sig.replace(/^./, 'f').replace(/^f/, sig[0] === 'f' ? '0' : 'f')));
  assert.ok(!InfoTrackClient.verifySignature('whsec', body, null));
  assert.ok(!InfoTrackClient.verifySignature('other', body, sig));
  const ev = InfoTrackClient.parseWebhook(body);
  assert.deepEqual({ ...ev, raw: undefined }, { deliveryId: 'evt-1', reference: 'O1', event: 'order.completed', documentUrl: 'https://cdn.infotrack.test/x.pdf', documentName: 'con29.pdf', status: 'COMPLETED', raw: undefined });
  assert.throws(() => InfoTrackClient.parseWebhook('{}'), /no order reference/);
});

test('handleInfoTrackResult: unknown refs ignored; completed orders are downloaded, filed and routed by OUR order record', async () => {
  const orders = new MemoryOrderStore();
  const { t } = fakeTransport([() => bytes(200, Buffer.from('%PDF-1.4 fake'))]);
  const client = new InfoTrackClient(cfg, t);
  const filed: unknown[] = [];
  const routed: string[] = [];
  const deps = {
    client,
    orders,
    filer: { file: async (i: { fileName: string; docType: string }) => { filed.push(i); return 'doc-1'; } },
    router: {
      searchReturned: async (_t: string, _m: string, st: string, d: string) => routed.push(`search:${st}:${d}`),
      titleReceived: async (_t: string, _m: string, d: string) => routed.push(`title:${d}`),
      idCheckResultReceived: async (_t: string, _m: string, d: string) => routed.push(`id:${d}`),
    },
  };
  const ev = { deliveryId: 'e1', reference: 'O9', event: 'order.completed', documentUrl: 'https://cdn.infotrack.test/x.pdf', documentName: 'con29.pdf', status: 'COMPLETED', raw: {} };
  assert.deepEqual(await handleInfoTrackResult(deps, ev), { status: 'IGNORED', reason: 'unknown order reference O9' });

  // Place the order through the provider port so the mapping is recorded the real way.
  const provider = new InfoTrackSearchProvider(new InfoTrackClient(cfg, fakeTransport([() => json(200, { access_token: 'tok', expires_in: 3600 }), () => json(200, { orderId: 'O9', status: 'ORDERED' })]).t), orders, async () => ({ matterRef: 'M1', address: '1 Test St', buyerNames: ['A'] }));
  await provider.orderSearch({ tenantId: 't', matterId: 'm', searchType: 'CON29' });

  const out = await handleInfoTrackResult(deps, ev);
  assert.deepEqual(out, { status: 'PROCESSED', kind: 'search', documentId: 'doc-1' });
  assert.equal((filed[0] as { docType: string }).docType, 'SEARCH_CON29');
  assert.deepEqual(routed, ['search:CON29:doc-1']);
  assert.equal((await orders.find('infotrack', 'O9'))?.status, 'RETURNED');
  // a retry of the same event is ignored (already RETURNED)
  assert.equal((await handleInfoTrackResult(deps, ev)).status, 'IGNORED');
});

test('handleInfoTrackResult: a failed order is recorded, not routed', async () => {
  const orders = new MemoryOrderStore();
  await orders.record({ tenantId: 't', matterId: 'm', provider: 'infotrack', kind: 'id_check', subject: 'A', providerRef: 'O2', status: 'ORDERED' }, {});
  const out = await handleInfoTrackResult({ client: new InfoTrackClient(cfg, fakeTransport([]).t), orders, filer: { file: async () => 'x' }, router: { searchReturned: async () => {}, titleReceived: async () => {}, idCheckResultReceived: async () => {} } }, { deliveryId: 'e', reference: 'O2', event: 'order.failed', raw: {} });
  assert.equal(out.status, 'FAILED');
  assert.equal((await orders.find('infotrack', 'O2'))?.status, 'FAILED');
});
