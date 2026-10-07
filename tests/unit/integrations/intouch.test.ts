/**
 * The InTouch connector, end to end over the mock of InTouch's Public Customer Matter API: the real
 * HTTP client (API key header, envelope, retry, paging, download links, tasks) against MockInTouch,
 * InTouch's documented webhook envelope, the real mapping seam,
 * and the real engine underneath on the in-memory store.
 *
 * The point of these tests is not that the code runs. It is that the two rules the
 * connector exists to keep are actually kept: nothing InTouch says decides anything, and
 * nothing lands twice.
 */
import { test } from 'node:test';
import { FIXTURE_LEVELS } from '../engine/helpers';
import assert from 'node:assert/strict';
import { EngineService } from '../../../lib/server/engine/service';
import { MemoryEventStore } from '../../../lib/server/engine/store';
import { mockPorts } from '../../../lib/server/engine/mocks';
import crypto from 'node:crypto';
import { MockInTouch } from '../../../lib/server/integrations/intouch/mock';
import { InTouchHttpClient } from '../../../lib/server/integrations/intouch/client';
import { caseStatus, milestoneFor, pick, primaryClient, sideFrom, taskForMilestone, toCase, toDocument, toHtml, toPennies, toWebhookEvent, unwrap } from '../../../lib/server/integrations/intouch/mapping';
import { applyWebhook, hintFor, isEnrollableCase, isForward, syncInTouch, type InTouchMirrorRef, type InTouchMirrorStore, type InTouchSyncDeps } from '../../../lib/server/integrations/intouch/sync';
import { InTouchError, type InTouchCase, type InTouchDocument, type InTouchParty, type InTouchSyncSummary } from '../../../lib/server/integrations/intouch/types';
import { INTOUCH_API_TOKEN_HEADER, normaliseInTouchEvent } from '../../../lib/server/integrations/intouch/endpoints';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ALICE = '33333333-3333-4333-8333-333333333333';

// ───────────────────────────── an in-memory mirror ─────────────────────────────

class MemoryMirror implements InTouchMirrorStore {
  matters = new Map<string, { matterId: string; c: InTouchCase; lastMilestone: string | null }>();
  documents = new Map<string, string>();
  contacts = new Map<string, InTouchParty[]>();
  applied = new Set<string>();
  syncs: InTouchSyncSummary[] = [];
  since: string | null = null;
  milestones = true;
  private n = 0;
  constructor(private docs: ReturnType<typeof mockPorts>['documents']) {}
  async upsertMatter(_t: string, c: InTouchCase) {
    const ex = this.matters.get(c.id);
    if (ex) {
      ex.c = c;
      return { matterId: ex.matterId, created: false };
    }
    this.n += 1;
    const matterId = `matter-${this.n}`;
    this.matters.set(c.id, { matterId, c, lastMilestone: null });
    return { matterId, created: true };
  }
  async matterByCaseId(_t: string, id: string): Promise<InTouchMirrorRef | null> {
    const m = this.matters.get(id);
    return m ? { matterId: m.matterId, intouchCaseId: id, lastMilestone: m.lastMilestone } : null;
  }
  async matterByContactEmail(_t: string, email: string): Promise<InTouchMirrorRef | null> {
    const hits = [...this.matters.entries()].filter(([, v]) => (this.contacts.get(v.matterId) ?? []).some((p) => p.email?.toLowerCase() === email.toLowerCase()));
    if (hits.length !== 1) return null;
    const [id, v] = hits[0];
    return { matterId: v.matterId, intouchCaseId: id, lastMilestone: v.lastMilestone };
  }
  async upsertContacts(_t: string, matterId: string, parties: InTouchParty[]) {
    this.contacts.set(matterId, parties);
  }
  async upsertDocument(_t: string, matterId: string, d: InTouchDocument) {
    const hit = this.documents.get(d.id);
    if (hit) return { documentId: hit, created: false };
    const doc = this.docs.seed({ tenantId: TENANT, matterId, docType: d.category ?? 'CLIENT_UPLOAD', extractedFacts: null });
    this.documents.set(d.id, doc.id);
    return { documentId: doc.id, created: true };
  }
  async feeEarnerToUser(_t: string, fe: InTouchCase['feeEarner']) {
    return fe?.name === 'Alice Okafor' ? ALICE : null;
  }
  async seen(_t: string, kind: string, id: string) {
    return this.applied.has(`${kind}:${id}`);
  }
  async markSeen(_t: string, _m: string, kind: string, id: string) {
    this.applied.add(`${kind}:${id}`);
  }
  async setMilestone(_t: string, matterId: string, milestone: string) {
    for (const v of this.matters.values()) if (v.matterId === matterId) v.lastMilestone = milestone;
  }
  async casesWatermark() {
    return this.since;
  }
  async setCasesWatermark(_t: string, iso: string) {
    this.since = iso;
  }
  async mirrors(): Promise<InTouchMirrorRef[]> {
    return [...this.matters.entries()].map(([id, v]) => ({ matterId: v.matterId, intouchCaseId: id, lastMilestone: v.lastMilestone }));
  }
  async recordSync(_t: string, d: InTouchSyncSummary) {
    this.syncs.push(d);
  }
  async milestonesEnabled() {
    return this.milestones;
  }
}

function harness() {
  const itouch = new MockInTouch({ apiToken: 'firm-key' });
  const client = new InTouchHttpClient({ apiBaseUrl: 'https://intouch.test', apiToken: 'firm-key', backoffMs: 1 }, TENANT, itouch.transport);
  const ports = mockPorts(new Date('2026-09-14T09:00:00Z'));
  const engine = new EngineService(new MemoryEventStore(FIXTURE_LEVELS), ports);
  const store = new MemoryMirror(ports.documents);
  const deps: InTouchSyncDeps = { api: client, store, engine, systemUserId: ALICE, log: () => {} };
  return { itouch, client, engine, store, deps, ports };
}

/** A webhook as InTouch delivers it: the raw body, parsed the way the route parses it. */
function hook(event: string, data: Record<string, unknown>, by?: { email?: string }) {
  const raw = MockInTouch.webhookBody(event, data, by);
  return toWebhookEvent(JSON.parse(raw), raw);
}

/** The engine has to be enrolled before it will take facts; the sync mirrors, a person enrols. */
async function enrol(deps: InTouchSyncDeps, matterId: string, transactionType?: 'freehold_sale') {
  await deps.engine.run(TENANT, matterId, { type: 'enrol', actor: ALICE, hasLender: true, requiredSearches: [], ...(transactionType ? { transactionType } : {}) });
}

// ───────────────────────────── the mapping seam ─────────────────────────────

/** A matter exactly as InTouch's reference describes the Matter model. */
const MATTER = {
  guid: '6f1c2a40-0000-4000-8000-000000000001', reference: 'ABC123', itrCode: 'ITR9', state: 'Live', templateGuid: 't', templateName: 'Leasehold Purchase',
  addressLine1: 'Flat 3, 7 Mill Lane', addressLine2: 'Leeds', addressLine3: '', addressLine4: '', postcode: 'LS1 2AB',
  primaryClientForename: 'Priya', primaryClientMiddleName: '', primaryClientSurname: 'Okafor', primaryClientOrganisation: '', primaryClientEmail: 'priya@example.com', primaryClientPhone: '07700 900123',
  feeEarnerFullName: 'Alice Okafor', feeEarnerTeamName: 'Residential', createdOn: '2026-09-01T09:00:00Z', lastUpdated: '2026-09-20T09:00:00Z',
};

test('mapping: a matter is read from the Matter model', () => {
  const c = toCase(MATTER);
  assert.equal(c.id, MATTER.guid);
  assert.equal(c.reference, 'ABC123');
  assert.equal(c.status, 'active');
  assert.equal(c.side, 'purchase');
  assert.equal(c.tenure, 'leasehold');
  assert.equal(c.propertyAddress, 'Flat 3, 7 Mill Lane, Leeds, LS1 2AB');
  assert.equal(c.postcode, 'LS1 2AB');
  assert.deepEqual(c.feeEarner, { id: null, name: 'Alice Okafor', email: null });
  assert.equal(c.updatedAt, '2026-09-20T09:00:00.000Z');
  assert.equal(c.fields.itrCode, 'ITR9', 'what is not modelled is kept, never lost');
  assert.equal(c.fields.guid, undefined, 'a modelled field is not kept twice');
  const p = primaryClient(MATTER, c.id)!;
  assert.equal(p.name, 'Priya Okafor');
  assert.equal(p.email, 'priya@example.com');
  assert.equal(p.role, 'client');
  assert.equal(primaryClient({ guid: 'x' }, 'x'), null, 'no client named: no party');
});

test('mapping: state and template words, firm-configured, are read by what they say', () => {
  assert.equal(caseStatus('Quote'), 'quote');
  assert.equal(caseStatus('Quote Sent'), 'quote');
  assert.equal(caseStatus('Instructed'), 'instructed');
  assert.equal(caseStatus('In Progress'), 'active');
  assert.equal(caseStatus('Awaiting Exchange'), 'active', 'any other named state is a live instruction');
  assert.equal(caseStatus('Completed'), 'completed');
  assert.equal(caseStatus('Archived'), 'completed');
  assert.equal(caseStatus('Cancelled'), 'cancelled');
  assert.equal(caseStatus(''), 'unknown');
  assert.equal(sideFrom('Freehold Purchase'), 'purchase');
  assert.equal(sideFrom('Leasehold Sale'), 'sale');
  assert.equal(sideFrom('Sale & Purchase'), 'purchase', 'one InTouch matter, mirrored as the purchase; the sale is linked by hand');
  assert.equal(sideFrom('Remortgage'), 'remortgage');
  assert.equal(sideFrom('Transfer of Equity'), 'transfer');
});

test('mapping: InTouch\'s envelope is unwrapped, and success:false is InTouch refusing in its own words', () => {
  assert.deepEqual(unwrap({ success: true, message: '', errors: [], data: { matters: [] } }), { matters: [] });
  assert.equal(unwrap({ success: true, message: 'ok', errors: [] }), null);
  assert.throws(() => unwrap({ success: false, message: 'Invalid field', errors: ['matter.foo is not a data marker'] }), (e: unknown) => e instanceof InTouchError && /Invalid field; matter\.foo is not a data marker/.test(e.message));
  assert.deepEqual(unwrap([1, 2]), [1, 2], 'no envelope: as it came');
});

test('mapping: a folder item is a document; an email, note or call record is not', () => {
  const d = toDocument({ guid: 'f1', type: 'File', description: 'TA6 completed.pdf', fields: { fileName: 'TA6 completed.pdf', label: 'Forms' }, createdOn: '2026-09-20T11:00:00Z' }, 'c1')!;
  assert.equal(d.id, 'f1');
  assert.equal(d.fileName, 'TA6 completed.pdf');
  assert.equal(d.category, 'Forms');
  for (const type of ['Email', 'Note', 'PhoneCall', 'phone call']) assert.equal(toDocument({ guid: 'x', type, description: 'x' }, 'c1'), null, type);
});

test('mapping: money survives the shapes it arrives in', () => {
  assert.equal(toPennies('£425,000'), 42_500_000);
  assert.equal(toPennies(425000), 42_500_000);
  assert.equal(toPennies('425000.50'), 42_500_050);
  assert.equal(toPennies({ amount: '£1,000' }), 100_000);
  assert.equal(toPennies('call us'), null);
  assert.equal(toPennies(null), null);
});

test('mapping: the engine lifecycle becomes a milestone a client understands, and only forwards', () => {
  assert.equal(milestoneFor('instructed'), 'instructed');
  assert.equal(milestoneFor('investigating'), 'searches_ordered');
  assert.equal(milestoneFor('ready_to_exchange'), 'ready_to_exchange');
  assert.equal(milestoneFor('exchanged'), 'exchanged');
  assert.equal(milestoneFor('completed'), 'completed');
  assert.equal(milestoneFor('aborted'), null, 'a portal is not where someone learns their purchase fell through');
  assert.equal(isForward(null, 'instructed'), true);
  assert.equal(isForward('exchanged', 'searches_ordered'), false);
  assert.equal(isForward('exchanged', 'completed'), true);
});

test('a milestone is the InTouch task that says it, by its words; "exchange" never matches "ready to exchange"', () => {
  const tasks = ['Client onboarding', 'Order searches', 'Enquiries raised', 'Report on title sent to client', 'Ready to exchange', 'Exchange of contracts', 'Completion information form (TA13)', 'Completion'].map((name, i) => ({ id: `t${i}`, name, completed: false }));
  assert.equal(taskForMilestone('instructed', tasks)?.name, 'Client onboarding');
  assert.equal(taskForMilestone('searches_ordered', tasks)?.name, 'Order searches');
  assert.equal(taskForMilestone('enquiries_raised', tasks)?.name, 'Enquiries raised');
  assert.equal(taskForMilestone('report_sent', tasks)?.name, 'Report on title sent to client');
  assert.equal(taskForMilestone('ready_to_exchange', tasks)?.name, 'Ready to exchange');
  assert.equal(taskForMilestone('exchanged', tasks)?.name, 'Exchange of contracts');
  assert.equal(taskForMilestone('completed', tasks)?.name, 'Completion', 'not the TA13 form');
  assert.equal(taskForMilestone('exchanged', tasks.map((t) => ({ ...t, completed: t.name === 'Exchange of contracts' }))), null, 'already done: nothing to complete');
  assert.equal(taskForMilestone('exchanged', [{ id: 'x', name: 'Ready to exchange', completed: false }]), null);
  assert.equal(toHtml('A & B <1>\nnext'), 'A &amp; B &lt;1&gt;<br>next');
});

test('a document hint is only offered where the name is unambiguous: the ID report and completed forms included', () => {
  const doc = (fileName: string, category: string | null = null): InTouchDocument => ({ id: 'd', caseId: 'c', fileName, mimeType: null, sizeBytes: null, category, uploadedBy: 'client', createdAt: null });
  assert.equal(hintFor(doc('Identity report - Priya Okafor.pdf'))?.role, 'id_check');
  assert.equal(hintFor(doc('Thirdfort report - Priya Okafor.pdf'))?.role, 'id_check');
  assert.equal(hintFor(doc('Thirdfort Source of Funds report.pdf')), null, 'source of funds is not the ID check');
  assert.equal(hintFor(doc('TA6 Property Information Form.pdf'))?.role, 'property_forms');
  assert.equal(hintFor(doc('ta10.pdf', 'Forms'))?.role, 'property_forms');
  assert.equal(hintFor(doc('Mortgage offer.pdf'))?.role, 'mortgage_offer');
  assert.equal(hintFor(doc('CON29.pdf'))?.searchType, 'CON29');
  assert.equal(hintFor(doc('Bank statement March.pdf')), null, 'proof of funds has its own reviewed flow');
  assert.equal(hintFor(doc('scan001.pdf')), null);
});

// ───────────────────────────── the client over HTTP ─────────────────────────────

test('every request carries the firm\'s API key; the list is paged from 1, newest change first', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) h.itouch.seed({ reference: `IT-${i}`, lastUpdated: `2026-09-2${i}T09:00:00Z` });
  assert.equal((await h.client.account()).name, 'InTouch · Residential');
  const first = await h.client.listCases({ limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0].reference, 'IT-4', 'newest change first');
  assert.equal(first.next, '2');
  const second = await h.client.listCases({ limit: 2, cursor: first.next });
  assert.notEqual(first.items[0].id, second.items[0].id);
  const list = h.itouch.calls.filter((c) => c.path === '/api/v2/public/matters/list');
  assert.deepEqual(list[1].query, { page: ['1'], pageSize: ['2'], orderBy: ['lastUpdated'], orderByDirection: ['desc'] });
  for (const c of h.itouch.calls) {
    assert.equal(c.headers[INTOUCH_API_TOKEN_HEADER], 'firm-key');
    assert.equal(c.headers.authorization, undefined, 'no bearer token: InTouch has no OAuth');
  }
});

test('an incremental read stops at the first matter changed before the watermark', async () => {
  const h = harness();
  h.itouch.seed({ reference: 'OLD', lastUpdated: '2026-09-01T09:00:00Z' });
  h.itouch.seed({ reference: 'NEW', lastUpdated: '2026-09-25T09:00:00Z' });
  const page = await h.client.listCases({ updatedSince: '2026-09-10T00:00:00Z', limit: 1 });
  assert.deepEqual(page.items.map((c) => c.reference), ['NEW']);
  const next = await h.client.listCases({ updatedSince: '2026-09-10T00:00:00Z', limit: 1, cursor: page.next });
  assert.deepEqual(next.items, []);
  assert.equal(next.next, null, 'and stops there');
});

test('if InTouch refuses the ordering, the list is read unordered (and filtered) rather than failing', async () => {
  const h = harness();
  h.itouch.rejectOrderBy = true;
  h.itouch.seed({ reference: 'OLD', lastUpdated: '2026-09-01T09:00:00Z' });
  h.itouch.seed({ reference: 'NEW', lastUpdated: '2026-09-25T09:00:00Z' });
  const page = await h.client.listCases({ updatedSince: '2026-09-10T00:00:00Z' });
  assert.deepEqual(page.items.map((c) => c.reference), ['NEW']);
  assert.equal(h.itouch.calls.filter((c) => c.query.orderBy).length, 1, 'asked once, then not again');
});

test('a key InTouch does not accept is a 401, and it is not retried', async () => {
  const h = harness();
  const wrong = new InTouchHttpClient({ apiBaseUrl: 'https://intouch.test', apiToken: 'not-the-key', backoffMs: 1 }, TENANT, h.itouch.transport);
  const before = h.itouch.calls.length;
  await assert.rejects(() => wrong.account(), (err: unknown) => err instanceof InTouchError && err.status === 401 && err.retryable === false && /did not accept the API key/.test(err.message));
  assert.equal(h.itouch.calls.length - before, 1, 'one request, no retries');
  h.itouch.failNext = 1;
  h.itouch.failStatus = 403;
  await assert.rejects(() => h.client.listCases(), (err: unknown) => err instanceof InTouchError && err.status === 403 && !err.retryable);
});

test('a 500 is retried and then succeeds; a 400 is not retried and says InTouch\'s words', async () => {
  const h = harness();
  h.itouch.seed();
  h.itouch.failNext = 2;
  const page = await h.client.listCases();
  assert.equal(page.items.length, 1, 'recovered after two failures');
  h.itouch.failNext = 1;
  h.itouch.failStatus = 400;
  const fresh = new InTouchHttpClient({ apiBaseUrl: 'https://intouch.test', apiToken: 'firm-key', backoffMs: 1 }, TENANT, h.itouch.transport);
  (fresh as unknown as { ordered: boolean }).ordered = false;
  await assert.rejects(() => fresh.listCases(), /rejected the request \(400\): mock failure/);
});

test('a file is downloaded through InTouch\'s download link, and the firm\'s key is never sent to it', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  const docId = h.itouch.addFile(caseId, { name: 'Proof.pdf', content: 'hello' });
  const got = await h.client.downloadDocument(docId, caseId);
  assert.equal(got.bytes.toString('utf8'), 'hello');
  assert.equal(got.mimeType, 'application/pdf');
  const link = h.itouch.calls.find((c) => c.path === `/${docId}`)!;
  assert.equal(link.headers[INTOUCH_API_TOKEN_HEADER], undefined);
});

test('a note and a filed email go into the matter\'s folder as InTouch takes them', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  await h.client.addNote(caseId, 'CONVEYi · Searches ordered & paid');
  assert.deepEqual(h.itouch.notesFor(caseId), ['CONVEYi · Searches ordered &amp; paid']);
  const r = await h.client.fileEmail(caseId, { at: '2026-09-20T10:00:00.123Z', subject: 'Your purchase', text: 'Hello\nPriya', from: { email: 'alice@firm.example', name: 'Alice' }, to: [{ email: 'priya@example.com' }] });
  assert.ok(r.id);
  const sent = h.itouch.calls.find((c) => c.path.endsWith('/folder/emails'))!.body as Record<string, unknown>;
  assert.equal(sent.emailDateTime, '2026-09-20T10:00:00Z', 'yyyy-mm-ddThh:mm:ssZ, as InTouch asks');
  assert.equal(sent.htmlContent, 'Hello<br>Priya');
});

// ───────────────────────────── the sync ─────────────────────────────

test('a quote is not a case; an instruction is', async () => {
  assert.equal(isEnrollableCase(toCase({ guid: 'c', state: 'Quote' })), false);
  assert.equal(isEnrollableCase(toCase({ guid: 'c', state: 'Instructed' })), true);
  assert.equal(isEnrollableCase(toCase({ guid: 'c', state: 'Cancelled' })), false);
  const h = harness();
  h.itouch.seed({ state: 'Quote' });
  h.itouch.seed({ state: 'Instructed' });
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.cases, 1);
  assert.equal(out.created, 1);
  assert.equal(out.skipped, 1);
});

test('a matter becomes a matter with its primary client, and the fee earner becomes our handler by name', async () => {
  const h = harness();
  h.itouch.seed({ primaryClientForename: 'Priya', primaryClientSurname: 'Okafor', primaryClientEmail: 'priya@example.com' });
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  const parties = h.store.contacts.get(ref.matterId)!;
  assert.deepEqual(parties.map((p) => [p.role, p.name, p.email]), [['client', 'Priya Okafor', 'priya@example.com']]);
});

test('the ID report and a completed form in the folder are mirrored and read like any document, once', async () => {
  const h = harness();
  const caseId = h.itouch.seed({ templateName: 'Freehold Sale' });
  h.itouch.addFile(caseId, { name: 'Identity report.pdf' });
  h.itouch.addFile(caseId, { name: 'TA6 completed.pdf', label: 'Forms' });
  h.itouch.addFile(caseId, { name: 'Call with client', type: 'PhoneCall' });
  const first = await syncInTouch(h.deps, TENANT);
  assert.equal(first.documents, 2, 'two files; the call record is InTouch\'s history, not a document');
  assert.equal(h.store.documents.size, 2);
  const again = await syncInTouch(h.deps, TENANT);
  assert.equal(again.documents, 0, 'nothing lands twice');
});

test('what we filed in InTouch ourselves (labelled CONVEYi) is never mirrored back', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  h.itouch.addFile(caseId, { name: 'Report on title.docx', label: 'CONVEYi' });
  await syncInTouch(h.deps, TENANT);
  await syncInTouch(h.deps, TENANT);
  assert.equal(h.store.documents.size, 0);
});

test('one broken case does not stop the rest of the firm syncing', async () => {
  const h = harness();
  const bad = h.itouch.seed({ reference: 'BAD' });
  h.itouch.seed({ reference: 'GOOD' });
  const realParties = h.client.caseParties.bind(h.client);
  h.deps.api = new Proxy(h.client, {
    get: (t, k) => (k === 'caseParties' ? (id: string) => (id === bad ? Promise.reject(new Error('boom')) : realParties(id)) : Reflect.get(t, k, t)),
  }) as never;
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.cases, 2);
  assert.equal(out.errors.length, 1);
  assert.ok(out.errors[0].includes(bad));
});

// ───────────────────────────── milestones back out ─────────────────────────────

test('the engine\'s state completes the matching InTouch task, once, and never backwards', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId);
  const first = await syncInTouch(h.deps, TENANT);
  assert.equal(first.milestones, 1);
  assert.deepEqual(h.itouch.completedTasks(caseId), ['Client onboarding']);
  const second = await syncInTouch(h.deps, TENANT);
  assert.equal(second.milestones, 0, 'nothing changed: nothing pushed');
  assert.deepEqual(h.itouch.completedTasks(caseId), ['Client onboarding']);
});

test('where the firm\'s InTouch workflow has no task for the milestone, it goes on the case as a note', async () => {
  const h = harness();
  const caseId = h.itouch.seed({ tasks: ['Collect fees'] });
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId);
  await syncInTouch(h.deps, TENANT);
  assert.deepEqual(h.itouch.completedTasks(caseId), []);
  assert.deepEqual(h.itouch.notesFor(caseId), ['CONVEYi · Instructed']);
});

test('a matter in shadow mode says nothing to the client', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await h.engine.run(TENANT, ref.matterId, { type: 'enrol', actor: ALICE, hasLender: true, requiredSearches: [], shadowMode: true });
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.milestones, 0);
  assert.deepEqual(h.itouch.completedTasks(caseId), []);
});

test('milestones stay off entirely until the firm turns them on', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  h.store.milestones = false;
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId);
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.milestones, 0);
  assert.deepEqual(h.itouch.completedTasks(caseId), []);
});

// ───────────────────────────── webhooks ─────────────────────────────

test('webhook: InTouch\'s documented Form_Completion envelope is read, flat dotted keys and all', () => {
  const raw = '{"event":"Form_Completion","triggered.by.name":"Priya Okafor","triggered.by.email":"Priya@Example.com","timestamp":"2020-01-03T17:01:23Z","data":{"Full name":"Priya Okafor","Any disputes?":"No"}}';
  const e = toWebhookEvent(JSON.parse(raw), raw);
  assert.equal(e.type, 'form_completion');
  assert.equal(e.triggeredByEmail, 'priya@example.com');
  assert.equal(e.occurredAt, '2020-01-03T17:01:23.000Z');
  assert.equal(e.caseId, null, 'Form Completion carries no case id');
  assert.equal(e.id, crypto.createHash('sha256').update(raw, 'utf8').digest('hex'));
  assert.equal(toWebhookEvent(JSON.parse(raw), raw).id, e.id);
  assert.equal(pick({ 'a.b': 1, a: { b: 2 } }, ['a.b']), 1);
  assert.equal(pick({ a: { b: 2 } }, ['a.b']), 2);
});

test('webhook: event names normalise, and a matter guid is read from data where InTouch includes one', () => {
  assert.equal(normaliseInTouchEvent('Matter_State_Change'), 'matter_state_change');
  assert.equal(normaliseInTouchEvent('Task State Change'), 'task_state_change');
  assert.equal(hook('Task_State_Change', { matterGuid: 'c9', matterTaskGuid: 't1' }).caseId, 'c9');
  assert.equal(hook('Task_State_Change', { 'matter.guid': 'c8' }).caseId, 'c8');
  assert.equal(hook('Matter_State_Change', { guid: 'c7', state: 'Instructed' }).caseId, 'c7', "a matter event's own guid is the matter");
  assert.equal(hook('Task_State_Change', { guid: 't1' }).caseId, null, "a task's own guid is not a matter");
});

test('a webhook is a pointer: the matter\'s folder is re-read, never taken from the body', async () => {
  const h = harness();
  const caseId = h.itouch.seed({ templateName: 'Freehold Sale' });
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId, 'freehold_sale');
  h.itouch.addFile(caseId, { name: 'TA10 completed.pdf' });
  const out = await applyWebhook(h.deps, TENANT, hook('Form_Completion', { matterGuid: caseId, form: 'TA6', fileName: 'invented.pdf' }));
  assert.equal(out.documents, 1);
  assert.equal(h.store.documents.size, 1, 'the real file, not anything the body claimed');
});

test('no matter guid: the person who triggered it finds the matter when they are on exactly one', async () => {
  const h = harness();
  const caseId = h.itouch.seed({ templateName: 'Freehold Sale', primaryClientEmail: 'sam@example.com' });
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId, 'freehold_sale');
  h.itouch.addFile(caseId, { name: 'TA6 completed.pdf' });
  const out = await applyWebhook(h.deps, TENANT, hook('Form_Completion', { 'Any disputes?': 'No' }, { email: 'SAM@example.com' }));
  assert.equal(out.skipped, 0);
  assert.equal(out.documents, 1);
});

test('no matter guid and the person is on two matters: skipped, never guessed', async () => {
  const h = harness();
  const a = h.itouch.seed({ primaryClientEmail: 'sam@example.com' });
  const b = h.itouch.seed({ primaryClientEmail: 'sam@example.com' });
  await syncInTouch(h.deps, TENANT);
  h.itouch.addFile(a, { name: 'x.pdf' });
  h.itouch.addFile(b, { name: 'y.pdf' });
  const out = await applyWebhook(h.deps, TENANT, hook('Form_Completion', {}, { email: 'sam@example.com' }));
  assert.equal(out.skipped, 1);
  assert.equal(out.documents, 0);
  assert.equal((await applyWebhook(h.deps, TENANT, hook('Form_Completion', {}, { email: 'nobody@example.com' }))).skipped, 1);
});

test('a webhook for a matter we do not mirror is ignored, not guessed at', async () => {
  const h = harness();
  const out = await applyWebhook(h.deps, TENANT, hook('Task_State_Change', { matterGuid: 'never-seen', matterTaskGuid: 't' }));
  assert.equal(out.skipped, 1);
});

test('Matter_State_Change mirrors the matter and its client the same way a sync would', async () => {
  const h = harness();
  const caseId = h.itouch.seed({ state: 'Instructed' });
  const out = await applyWebhook(h.deps, TENANT, hook('Matter_State_Change', { matterGuid: caseId, state: 'Instructed' }));
  assert.equal(out.created, 1);
  assert.equal(out.parties, 1);
  const mirrors = await h.store.mirrors();
  assert.equal(mirrors.length, 1);
  assert.equal(h.store.contacts.get(mirrors[0].matterId)?.[0].email, 'priya@example.com');
  const again = await applyWebhook(h.deps, TENANT, hook('Matter_State_Change', { matterGuid: caseId, state: 'Live' }));
  assert.equal(again.created, 0);
  assert.equal((await h.store.mirrors()).length, 1);
});

test('an event InTouch has not documented is skipped', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  const out = await applyWebhook(h.deps, TENANT, hook('Invoice_Paid', { matterGuid: caseId }));
  assert.equal(out.skipped, 1);
  assert.equal(out.cases, 0);
});
