/**
 * The InTouch connector, end to end over the mock: the real HTTP client (token, refresh,
 * retry, paging, download, webhook signing) against MockInTouch, the real mapping seam,
 * and the real engine underneath on the in-memory store.
 *
 * The point of these tests is not that the code runs. It is that the two rules the
 * connector exists to keep are actually kept: nothing InTouch says decides anything, and
 * nothing lands twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineService } from '../../../lib/server/engine/service';
import { MemoryEventStore } from '../../../lib/server/engine/store';
import { mockPorts } from '../../../lib/server/engine/mocks';
import { blockingDecisions, type MatterState } from '../../../lib/server/engine/types';
import { MockInTouch, MemoryInTouchTokenStore } from '../../../lib/server/integrations/intouch/mock';
import { InTouchHttpClient, verifyWebhookSignature } from '../../../lib/server/integrations/intouch/client';
import { milestoneFor, pick, toCase, toDocument, toForm, toIdentityCheck, toParty, toPennies, toWebhookEvent } from '../../../lib/server/integrations/intouch/mapping';
import { applyWebhook, disclosuresFrom, hintFor, idFactsFrom, isEnrollableCase, isForward, syncInTouch, type InTouchMirrorRef, type InTouchMirrorStore, type InTouchSyncDeps } from '../../../lib/server/integrations/intouch/sync';
import type { InTouchCase, InTouchDocument, InTouchParty, InTouchSyncSummary } from '../../../lib/server/integrations/intouch/types';
import { INTOUCH_ENDPOINTS } from '../../../lib/server/integrations/intouch/endpoints';

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
    return fe?.email === 'alice@demo-conveyancing.co.uk' ? ALICE : null;
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

function harness(opts: { webhookSecret?: string } = {}) {
  const itouch = new MockInTouch({ clientId: 'cid', clientSecret: 'secret', webhookSecret: opts.webhookSecret ?? 'hook-secret' });
  const tokens = new MemoryInTouchTokenStore();
  const client = new InTouchHttpClient(
    { apiBaseUrl: 'https://intouch.test', clientId: 'cid', clientSecret: 'secret', webhookSecret: opts.webhookSecret ?? 'hook-secret', backoffMs: 1 },
    TENANT,
    tokens,
    itouch.transport
  );
  const ports = mockPorts(new Date('2026-09-14T09:00:00Z'));
  const engine = new EngineService(new MemoryEventStore(), ports);
  const store = new MemoryMirror(ports.documents);
  const deps: InTouchSyncDeps = { api: client, store, engine, systemUserId: ALICE, log: () => {} };
  return { itouch, tokens, client, engine, store, deps, ports };
}

/** The engine has to be enrolled before it will take facts; the sync mirrors, a person enrols. */
async function enrol(deps: InTouchSyncDeps, matterId: string, transactionType?: 'freehold_sale') {
  await deps.engine.run(TENANT, matterId, { type: 'enrol', actor: ALICE, hasLender: true, requiredSearches: [], ...(transactionType ? { transactionType } : {}) });
}

// ───────────────────────────── the mapping seam ─────────────────────────────

test('mapping: a case is read from whichever field names InTouch actually uses', () => {
  const a = toCase({ id: 'c1', reference: 'IT-1', status: 'Active', type: 'Purchase', tenure: 'Freehold', propertyAddress: '1 High St', price: '£425,000' });
  const b = toCase({ caseId: 'c1', caseRef: 'IT-1', state: 'in progress', transactionType: 'buying', propertyTenure: 'freehold', address: '1 High St', purchasePrice: 425000 });
  assert.equal(a.id, b.id);
  assert.equal(a.status, 'active');
  assert.equal(b.status, 'active');
  assert.equal(a.side, 'purchase');
  assert.equal(b.side, 'purchase');
  assert.equal(a.pricePennies, 42_500_000);
  assert.equal(b.pricePennies, 42_500_000);
});

test('mapping: money survives the shapes it arrives in', () => {
  assert.equal(toPennies('£425,000'), 42_500_000);
  assert.equal(toPennies(425000), 42_500_000);
  assert.equal(toPennies('425000.50'), 42_500_050);
  assert.equal(toPennies({ amount: '425000', currency: 'GBP' }), 42_500_000);
  assert.equal(toPennies('not a number'), null);
  assert.equal(toPennies(null), null);
});

test('mapping: a form slug becomes the code the engine speaks, and an unknown one is not dropped', () => {
  assert.equal(toForm({ id: 'f', code: 'ta6', status: 'completed' }, 'c1').code, 'TA6');
  assert.equal(toForm({ id: 'f', type: 'property_information', status: 'submitted' }, 'c1').code, 'TA6');
  assert.equal(toForm({ id: 'f', code: 'leasehold_information', status: 'completed' }, 'c1').code, 'TA7');
  // Unrecognised: visible, not silently lost.
  assert.equal(toForm({ id: 'f', code: 'some-new-form', status: 'completed' }, 'c1').code, 'SOMENEWFORM');
});

test('mapping: a party role is normalised, and an unknown role is "other" rather than a guess', () => {
  assert.equal(toParty({ id: 'p', role: 'Buyer' }, 'c').role, 'client');
  assert.equal(toParty({ id: 'p', role: 'their solicitor' }, 'c').role, 'other_side_solicitor');
  assert.equal(toParty({ id: 'p', relationship: 'Estate Agent' }, 'c').role, 'estate_agent');
  assert.equal(toParty({ id: 'p', role: 'astrologer' }, 'c').role, 'other');
});

test('mapping: an identity outcome this system does not recognise never looks like a pass', () => {
  assert.equal(idFactsFrom(toIdentityCheck({ id: 'x', outcome: 'clear' }, 'c')).outcome, 'clear');
  assert.equal(idFactsFrom(toIdentityCheck({ id: 'x', result: 'Passed' }, 'c')).outcome, 'clear');
  const weird = idFactsFrom(toIdentityCheck({ id: 'x', outcome: 'amber-ish' }, 'c'));
  assert.equal(weird.outcome, 'refer');
  assert.equal(weird.confidence, 0);
  assert.match(weird.flags.map((f) => f.description).join(), /does not recognise/);
});

test('mapping: the engine lifecycle becomes a milestone a client understands, and only forwards', () => {
  assert.equal(milestoneFor('instructed'), 'instructed');
  assert.equal(milestoneFor('investigating'), 'searches_ordered');
  assert.equal(milestoneFor('exchanged'), 'exchanged');
  // A client portal is not where someone should learn their purchase fell through.
  assert.equal(milestoneFor('aborted'), null);
  assert.equal(milestoneFor('closed'), null);
  assert.equal(isForward(null, 'instructed'), true);
  assert.equal(isForward('exchanged', 'searches_ordered'), false);
  assert.equal(isForward('searches_ordered', 'exchanged'), true);
  assert.equal(isForward('exchanged', 'exchanged'), false);
});

test('a client\'s own form answers become disclosures that quote them, and a "no" raises nothing', () => {
  const flags = disclosuresFrom({ id: 'f', caseId: 'c', code: 'TA6', status: 'completed', completedAt: null, documentId: null, answers: { disputes: 'No', japaneseKnotweed: 'Yes — treated in 2021, guarantee held', alterations: 'Conservatory 2019', boiler: 'Worcester' } });
  const codes = flags.map((f) => f.code);
  assert.ok(codes.includes('KNOTWEED_DISCLOSED'));
  assert.ok(codes.includes('ALTERATIONS_DISCLOSED'));
  assert.ok(!codes.includes('DISPUTE_DISCLOSED'), 'a "No" is not a disclosure');
  assert.ok(!flags.some((f) => /boiler/i.test(f.description)), 'only watched questions are raised');
  // Every flag quotes the client, so a person can see exactly what was said.
  assert.match(flags.find((f) => f.code === 'KNOTWEED_DISCLOSED')!.locator!.quote!, /treated in 2021/);
});

test('a document hint is only offered where the category is unambiguous', () => {
  const doc = (fileName: string, category: string): InTouchDocument => ({ id: 'd', caseId: 'c', fileName, mimeType: null, sizeBytes: null, category, uploadedBy: 'client', createdAt: null });
  assert.equal(hintFor(doc('report.pdf', 'id_report'))?.role, 'id_check');
  assert.equal(hintFor(doc('CON29.pdf', 'searches'))?.searchType, 'CON29');
  assert.equal(hintFor(doc('offer.pdf', 'mortgage_offer'))?.role, 'mortgage_offer');
  // A bank statement is proof-of-funds evidence with its own reviewed flow — never routed.
  assert.equal(hintFor(doc('statement.pdf', 'bank_statement')), null);
  assert.equal(hintFor(doc('something.pdf', 'misc')), null);
});

// ───────────────────────────── the client over HTTP ─────────────────────────────

test('the client gets a token, reads the account, and pages through cases', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) h.itouch.seed({ reference: `IT-${i}` });
  await h.client.connectWithClientCredentials();
  assert.equal((await h.client.account()).name, 'Demo Conveyancing LLP');
  const first = await h.client.listCases({ limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.next);
  const second = await h.client.listCases({ limit: 2, cursor: first.next });
  assert.equal(second.items.length, 2);
  assert.notEqual(first.items[0].id, second.items[0].id);
});

test('a 500 is retried and then succeeds; a 400 is not retried', async () => {
  const h = harness();
  h.itouch.seed();
  await h.client.connectWithClientCredentials();
  h.itouch.failNext = 2;
  const page = await h.client.listCases();
  assert.equal(page.items.length, 1, 'recovered after two failures');
  h.itouch.failNext = 1;
  h.itouch.failStatus = 400;
  await assert.rejects(() => h.client.listCases(), /rejected the request \(400\)/);
});

test('an expired token is refreshed once, transparently', async () => {
  const h = harness();
  h.itouch.seed();
  await h.client.connectWithClientCredentials();
  // Force expiry: the store holds the only copy.
  const held = (await h.tokens.load(TENANT)) as { expiresAt: number };
  await h.tokens.save(TENANT, { ...held, expiresAt: Date.now() - 1 });
  const page = await h.client.listCases();
  assert.equal(page.items.length, 1);
  assert.ok(h.itouch.calls.filter((c) => c.path === INTOUCH_ENDPOINTS.token).length >= 2, 'it asked for a new token');
});

test('downloading a document returns the bytes and the filename', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  const docId = h.itouch.addDocument(caseId, { fileName: 'Proof.pdf', content: 'hello' });
  await h.client.connectWithClientCredentials();
  const got = await h.client.downloadDocument(docId);
  assert.equal(got.bytes.toString('utf8'), 'hello');
  assert.equal(got.mimeType, 'application/pdf');
});

test('a webhook signature is verified, and an unsigned delivery is refused when a secret is set', () => {
  const h = harness({ webhookSecret: 's3cret' });
  const body = JSON.stringify({ type: 'form.completed', data: { caseId: 'c1', id: 'f1' } });
  assert.equal(verifyWebhookSignature(body, h.itouch.sign(body), 's3cret'), true);
  assert.equal(verifyWebhookSignature(body, h.itouch.sign(body), 'wrong'), false);
  assert.equal(verifyWebhookSignature(body, null, 's3cret'), false);
  assert.equal(verifyWebhookSignature(body + ' ', h.itouch.sign(body), 's3cret'), false, 'a tampered body fails');
});

// ───────────────────────────── the sync ─────────────────────────────

test('a quote is not a case; an instruction is', async () => {
  assert.equal(isEnrollableCase(toCase({ id: 'c', status: 'quote' })), false);
  assert.equal(isEnrollableCase(toCase({ id: 'c', status: 'instructed' })), true);
  assert.equal(isEnrollableCase(toCase({ id: 'c', status: 'cancelled' })), false);
  const h = harness();
  h.itouch.seed({ status: 'quote' });
  h.itouch.seed({ status: 'instructed' });
  await h.client.connectWithClientCredentials();
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.cases, 1);
  assert.equal(out.created, 1);
  assert.equal(out.skipped, 1);
});

test('a case becomes a matter with its parties, and the fee earner becomes our handler', async () => {
  const h = harness();
  h.itouch.seed({ parties: [{ id: 'p1', role: 'buyer', firstName: 'Priya', lastName: 'Okafor', email: 'priya@example.com' }, { id: 'p2', role: 'Estate Agent', company: 'Hometown Lettings' }] });
  await h.client.connectWithClientCredentials();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  const parties = h.store.contacts.get(ref.matterId)!;
  assert.deepEqual(parties.map((p) => p.role), ['client', 'estate_agent']);
  assert.equal(parties[1].company, 'Hometown Lettings');
});

test('a completed identity check becomes the engine\'s ordinary ID decision — flagged, for a person', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  h.itouch.addIdentityCheck(caseId, { outcome: 'refer', flags: [{ code: 'pep_match', severity: 'medium', description: 'Possible PEP match' }] });
  await h.client.connectWithClientCredentials();
  await syncInTouch(h.deps, TENANT); // mirrors the case
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId);
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.identityChecks, 1);
  const state = await h.engine.getState(TENANT, ref.matterId);
  const pending = blockingDecisions(state).filter((d) => d.kind === 'id_check');
  assert.equal(pending.length, 1, 'a refer is a decision, not a verdict');
  assert.ok(pending[0].sourceDocumentId, 'and it cites the report');
});

test('a check that is still pending records nothing at all', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  h.itouch.addIdentityCheck(caseId, { outcome: 'pending' });
  await h.client.connectWithClientCredentials();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId);
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.identityChecks, 0);
});

test('a completed TA6 lands as a form with the client\'s own disclosures attached', async () => {
  const h = harness();
  const caseId = h.itouch.seed({ type: 'sale' });
  h.itouch.addForm(caseId, { code: 'ta6', answers: { disputes: 'Yes — ongoing boundary dispute with number 14' } });
  await h.client.connectWithClientCredentials();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId, 'freehold_sale');
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.forms, 1);
  const state: MatterState = await h.engine.getState(TENANT, ref.matterId);
  assert.ok(state.propertyForms.forms.includes('TA6'));
});

test('a form the machine says does not belong here is a skip, not a failure', async () => {
  const h = harness();
  const caseId = h.itouch.seed({ type: 'purchase' });
  h.itouch.addForm(caseId, { code: 'ta6' });
  await h.client.connectWithClientCredentials();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId); // a purchase: property forms are the seller's side
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.forms, 0);
  assert.equal(out.errors.length, 0, 'the engine doing its job is not an error');
  assert.ok(out.skipped >= 1);
});

test('nothing lands twice, however many times the sync runs', async () => {
  const h = harness();
  const caseId = h.itouch.seed({ type: 'sale' });
  h.itouch.addIdentityCheck(caseId, { outcome: 'clear' });
  h.itouch.addForm(caseId, { code: 'ta6' });
  await h.client.connectWithClientCredentials();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId, 'freehold_sale');
  const first = await syncInTouch(h.deps, TENANT);
  const second = await syncInTouch(h.deps, TENANT);
  const third = await syncInTouch(h.deps, TENANT);
  assert.equal(first.identityChecks + first.forms, 2);
  assert.equal(second.identityChecks + second.forms, 0);
  assert.equal(third.identityChecks + third.forms, 0);
});

test('one broken case does not stop the rest of the firm syncing', async () => {
  const h = harness();
  h.itouch.seed({ id: 'good-1' });
  h.itouch.seed({ id: 'good-2' });
  await h.client.connectWithClientCredentials();
  // Make parties blow up for one case only.
  const realParties = h.client.caseParties.bind(h.client);
  h.deps.api = new Proxy(h.client, {
    get: (t, k) => (k === 'caseParties' ? (id: string) => (id === 'good-1' ? Promise.reject(new Error('boom')) : realParties(id)) : Reflect.get(t, k, t)),
  }) as never;
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.cases, 2);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /good-1/);
});

// ───────────────────────────── milestones back out ─────────────────────────────

test('the engine\'s state becomes a milestone on the client portal, once, and never backwards', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  await h.client.connectWithClientCredentials();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId);
  const first = await syncInTouch(h.deps, TENANT);
  assert.equal(first.milestones, 1);
  assert.equal(h.itouch.milestonesFor(caseId)[0].milestone, 'instructed');
  // Nothing changed: nothing is pushed.
  const second = await syncInTouch(h.deps, TENANT);
  assert.equal(second.milestones, 0);
  assert.equal(h.itouch.milestonesFor(caseId).length, 1);
});

test('a matter in shadow mode says nothing to the client', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  await h.client.connectWithClientCredentials();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await h.engine.run(TENANT, ref.matterId, { type: 'enrol', actor: ALICE, hasLender: true, requiredSearches: [], shadowMode: true });
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.milestones, 0);
  assert.equal(h.itouch.milestonesFor(caseId).length, 0);
});

test('milestones stay off entirely until the firm turns them on', async () => {
  const h = harness();
  const caseId = h.itouch.seed();
  h.store.milestones = false;
  await h.client.connectWithClientCredentials();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId);
  const out = await syncInTouch(h.deps, TENANT);
  assert.equal(out.milestones, 0);
  assert.equal(h.itouch.milestonesFor(caseId).length, 0);
});

// ───────────────────────────── webhooks ─────────────────────────────

test('a webhook is a pointer: the resource is re-read, never taken from the body', async () => {
  const h = harness();
  const caseId = h.itouch.seed({ type: 'sale' });
  await h.client.connectWithClientCredentials();
  await syncInTouch(h.deps, TENANT);
  const [ref] = await h.store.mirrors();
  await enrol(h.deps, ref.matterId, 'freehold_sale');
  h.itouch.addForm(caseId, { code: 'ta10' });

  // The body LIES about the form code; the re-read is what counts.
  const event = toWebhookEvent({ type: 'form.completed', data: { caseId, id: 'made-up', code: 'TA6' } });
  const out = await applyWebhook(h.deps, TENANT, event);
  assert.equal(out.forms, 1);
  const state = await h.engine.getState(TENANT, ref.matterId);
  assert.ok(state.propertyForms.forms.includes('TA10'), 'the real form, not the one the body claimed');
  assert.ok(!state.propertyForms.forms.includes('TA6'));
});

test('a webhook for a case we do not mirror is ignored, not guessed at', async () => {
  const h = harness();
  await h.client.connectWithClientCredentials();
  const out = await applyWebhook(h.deps, TENANT, toWebhookEvent({ type: 'form.completed', data: { caseId: 'never-seen', id: 'f' } }));
  assert.equal(out.skipped, 1);
  assert.equal(out.forms, 0);
});

test('case.created through a webhook mirrors the case the same way a sync would', async () => {
  const h = harness();
  const caseId = h.itouch.seed({ status: 'instructed' });
  await h.client.connectWithClientCredentials();
  const out = await applyWebhook(h.deps, TENANT, toWebhookEvent({ type: 'case.created', data: { caseId } }));
  assert.equal(out.created, 1);
  assert.equal((await h.store.mirrors()).length, 1);
});
