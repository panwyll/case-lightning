/**
 * LEAP as the backend — phase 0 (sync) and phase 1 (write-back), end to end over the
 * mock: MockLeap in memory for the orchestration, MockLeapServer over HTTP for the real
 * client (OAuth + PKCE, refresh, retry, paging, download, multipart upload, webhook
 * signing). The engine underneath is the real one on the in-memory store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EngineService } from '../../../lib/server/engine/service';
import { MemoryEventStore } from '../../../lib/server/engine/store';
import { mockPorts } from '../../../lib/server/engine/mocks';
import { pendingDecisions, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { textPdf } from '../../../lib/server/engine/text-pdf';
import { MockLeap, MockLeapServer, parseMultipart } from '../../../lib/server/integrations/leap/mock';
import { LeapHttpClient, type LeapApi, type LeapTokenStore } from '../../../lib/server/integrations/leap/client';
import { contactRoleOf, documentHint, extractExternalRef, isEnrollableMatterType, normaliseRole, pick, tagExternalRef, toCard, toDocument, toMatter, toWebhookEvent, trackOf } from '../../../lib/server/integrations/leap/mapping';
import { handleLeapWebhook, routeByHint, syncMatters, type LeapMirrorStore, type SyncDeps, type SyncSummary } from '../../../lib/server/integrations/leap/sync';
import { writeBack, type LeapWritebackStore, type WritebackKind } from '../../../lib/server/integrations/leap/writeback';
import type { LeapDocument, LeapMatter, LeapMatterParty, LeapTokens } from '../../../lib/server/integrations/leap/types';
import { LEAP_ENDPOINTS, LEAP_WEBHOOK_SIGNATURE_HEADER } from '../../../lib/server/integrations/leap/endpoints';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ALICE = '33333333-3333-4333-8333-333333333333';

// ───────────────────────────── in-memory stores ─────────────────────────────

class MemoryMirror implements LeapMirrorStore {
  matters = new Map<string, { matterId: string; leapMatterId: string; documentsSince: string | null; m: LeapMatter; assignedTo: string | null; status: string }>();
  documents = new Map<string, { documentId: string; d: LeapDocument; matterId: string }>();
  contacts = new Map<string, LeapMatterParty[]>();
  since: string | null = null;
  syncs: SyncSummary[] = [];
  users = new Map<string, string>([['alice@demo-conveyancing.co.uk', ALICE]]);
  constructor(private docs: ReturnType<typeof mockPorts>['documents']) {}
  async upsertMatter(_t: string, m: LeapMatter, extras: { assignedTo: string | null }) {
    const ex = this.matters.get(m.id);
    if (ex) {
      ex.m = m;
      return { matterId: ex.matterId, created: false };
    }
    const matterId = crypto.randomUUID();
    this.matters.set(m.id, { matterId, leapMatterId: m.id, documentsSince: null, m, assignedTo: extras.assignedTo, status: 'OPEN' });
    return { matterId, created: true };
  }
  async matterByLeapId(_t: string, id: string) {
    const r = this.matters.get(id);
    return r ? { matterId: r.matterId, leapMatterId: id, documentsSince: r.documentsSince } : null;
  }
  async closeMatter(_t: string, matterId: string) {
    for (const r of this.matters.values()) if (r.matterId === matterId) r.status = 'CLOSED';
  }
  async upsertContacts(_t: string, matterId: string, parties: LeapMatterParty[]) {
    this.contacts.set(matterId, parties);
  }
  async upsertDocument(_t: string, matterId: string, d: LeapDocument) {
    const ex = this.documents.get(d.id);
    if (ex) return { documentId: ex.documentId, created: false };
    // The engine's document repo needs a row; carry the facts a fixture extractor would find.
    const seeded = this.docs.seed({ tenantId: TENANT, matterId, docType: d.category ?? 'PDF', fileName: d.name, extractedFacts: FACTS.get(d.name) ?? null });
    this.documents.set(d.id, { documentId: seeded.id, d, matterId });
    return { documentId: seeded.id, created: true };
  }
  ingest = new Map<string, { status: string; detail: string | null; attempts: number; hint: ReturnType<typeof documentHint> }>();
  async markIngest(_t: string, documentId: string, status: 'PENDING' | 'DONE' | 'SKIPPED', detail: string | null) {
    const prev = this.ingest.get(documentId);
    const d = [...this.documents.values()].find((x) => x.documentId === documentId)!.d;
    this.ingest.set(documentId, { status, detail, attempts: (prev?.attempts ?? 0) + 1, hint: documentHint(d) });
  }
  async pendingIngests(_t: string, matterId: string) {
    return [...this.ingest.entries()].filter(([id, v]) => v.status === 'PENDING' && [...this.documents.values()].some((x) => x.documentId === id && x.matterId === matterId)).map(([documentId, v]) => ({ documentId, hint: v.hint, attempts: v.attempts }));
  }
  async staffToUser(_t: string, staff: LeapMatter['responsibleStaff']) {
    return (staff?.email && this.users.get(staff.email.toLowerCase())) ?? null;
  }
  async setMattersWatermark(_t: string, iso: string) {
    this.since = iso;
  }
  async setDocumentsWatermark(_t: string, matterId: string, iso: string) {
    for (const r of this.matters.values()) if (r.matterId === matterId) r.documentsSince = iso;
  }
  async mattersWatermark() {
    return this.since;
  }
  enrolledFilter: ((matterId: string) => Promise<boolean>) | null = null;
  async enrolledMirrors() {
    const out: { matterId: string; leapMatterId: string; documentsSince: string | null }[] = [];
    for (const r of this.matters.values()) if (r.status !== 'CLOSED' && (!this.enrolledFilter || (await this.enrolledFilter(r.matterId)))) out.push({ matterId: r.matterId, leapMatterId: r.leapMatterId, documentsSince: r.documentsSince });
    return out;
  }
  async recordSync(_t: string, detail: SyncSummary) {
    this.syncs.push(detail);
  }
}

class MemoryWriteback implements LeapWritebackStore {
  rows = new Map<string, { leapId: string | null; status: string }>();
  constructor(private mirror: MemoryMirror) {}
  async find(eventId: string, kind: WritebackKind) {
    return this.rows.get(`${eventId}:${kind}`) ?? null;
  }
  async record(i: { eventId: string; kind: WritebackKind; leapId: string | null; status: string }) {
    this.rows.set(`${i.eventId}:${i.kind}`, { leapId: i.leapId ?? this.rows.get(`${i.eventId}:${i.kind}`)?.leapId ?? null, status: i.status });
  }
  async leapMatter(_t: string, matterId: string) {
    for (const r of this.mirror.matters.values()) if (r.matterId === matterId) return { leapMatterId: r.leapMatterId, staffId: r.m.responsibleStaff?.id ?? null };
    return null;
  }
  async userName() {
    return 'Alice Okafor';
  }
}

/** A firm in the mock LEAP: two purchases (one freehold, one leasehold), a sale, a will. */
function seedFirm(leap: MockLeap) {
  const alice = { id: 'staff-1', name: 'Alice Okafor', email: 'alice@demo-conveyancing.co.uk' };
  const oak = leap.seedMatter({ number: 'OAK-14', description: 'Purchase of 14 Oak Street', propertyAddress: '14 Oak Street, Reading, RG1 4QT', responsible: alice, completionDate: '2026-12-18', purchasePrice: '£385,000' });
  const client = leap.seedCard({ name: 'Priya Shah', firstName: 'Priya', lastName: 'Shah', email: 'Priya.Shah@example.com', phone: '447700900123' });
  const lender = leap.seedCard({ name: 'Mock Building Society', organisation: 'Mock Building Society', type: 'company' });
  const sellerSol = leap.seedCard({ name: 'Greenfield Law LLP', organisation: 'Greenfield Law LLP', email: 'post@greenfield-law.example', type: 'company' });
  leap.addParty(oak.id, client, 'Client', 'client');
  leap.addParty(oak.id, lender, 'Mortgagee', 'lender');
  leap.addParty(oak.id, sellerSol, "Vendor's Solicitor", 'other_side_solicitor');
  const lease = leap.seedMatter({ number: 'FLAT-2', description: 'Purchase of Flat 2', matterTypeId: 'mt-conv-purchase-lh', propertyAddress: 'Flat 2, 9 Quay House', responsible: alice });
  const sale = leap.seedMatter({ number: 'SALE-7', description: 'Sale of 7 Mill Lane', matterTypeId: 'mt-conv-sale-fh', propertyAddress: '7 Mill Lane', responsible: alice });
  const will = leap.seedMatter({ number: 'WILL-1', description: 'Will for J Smith', matterTypeId: 'mt-wills', responsible: alice });
  return { oak, lease, sale, will, alice };
}

/** What pipeline #2 would extract from each seeded PDF, keyed by file name (the mock LEAP only stores bytes). */
const FACTS = new Map<string, unknown>();
const pdfWithFacts = (name: string, facts: unknown, lines: string[]) => {
  FACTS.set(name, facts);
  return { name, bytes: textPdf(lines) };
};

function harness(leap: LeapApi, opts: { shadow?: boolean } = {}) {
  const ports = mockPorts();
  const store = new MemoryEventStore();
  const svc = new EngineService(store, ports);
  const mirror = new MemoryMirror(ports.documents);
  mirror.enrolledFilter = async (matterId) => (await svc.getState(TENANT, matterId)).enrolled;
  const ingested: string[] = [];
  const deps: SyncDeps = {
    leap,
    store: mirror,
    engine: svc,
    ingest: async (t, m, documentId, hint) => {
      ingested.push(documentId);
      // Route by LEAP's hint (what the production bridge does without a classifier).
      return routeByHint(svc, t, m, documentId, hint);
    },
    policy: { patterns: [/purchase/], shadow: opts.shadow ?? false },
    now: () => ports.now(),
    log: () => {},
  };
  return { ports, store, svc, mirror, deps, ingested };
}

// ───────────────────────────── mapping ─────────────────────────────

test('mapping: LEAP raw JSON in several plausible spellings normalises to one shape', () => {
  const m1 = toMatter({ MatterId: 'm-1', MatterNumber: '2026/0042', Description: 'Purchase 14 Oak St', Status: 'Open', MatterType: { Id: 'mt', Name: 'Purchase — Freehold', AreaOfLaw: 'Conveyancing' }, PersonResponsible: { Id: 's1', Name: 'Alice', Email: 'A@x.com' }, Property: { AddressLine1: '14 Oak St', Town: 'Reading', Postcode: 'RG1 4QT' }, KeyDates: { Completion: '2026-12-18T00:00:00Z' }, DateModified: '2026-09-01T10:00:00Z' });
  assert.equal(m1.id, 'm-1');
  assert.equal(m1.number, '2026/0042');
  assert.equal(m1.status, 'open');
  assert.equal(m1.matterType?.name, 'Purchase — Freehold');
  assert.equal(m1.responsibleStaff?.email, 'A@x.com');
  assert.equal(m1.propertyAddress, '14 Oak St, Reading, RG1 4QT');
  assert.equal(m1.completionDate, '2026-12-18');
  const m2 = toMatter({ id: 'm-2', number: 'X', description: 'y', state: 'Closed', type: 'Sale — Freehold' });
  assert.equal(m2.status, 'closed');
  assert.equal(m2.matterType?.name, 'Sale — Freehold');
  assert.equal(pick({ a: { B: { c: 1 } } }, ['a.b.c']), 1);

  const c = toCard({ CardId: 'c-1', FirstName: 'Priya', Surname: 'Shah', EmailAddress: 'Priya@Example.com', Mobile: '07700 900123' });
  assert.deepEqual([c.type, c.name, c.email], ['person', 'Priya Shah', 'priya@example.com']);
  assert.equal(toCard({ id: 'c-2', companyName: 'Greenfield Law LLP', type: 'Company' }).type, 'company');

  const d = toDocument({ DocumentId: 'd-1', FileName: 'CON29R-14-oak.pdf', Folder: 'Searches', Size: 1234, DateCreated: '2026-09-02' }, 'm-1');
  assert.deepEqual([d.matterId, d.extension, d.mimeType, d.folder], ['m-1', 'pdf', 'application/pdf', 'Searches']);

  assert.deepEqual(['Client', "Vendor's Solicitor", 'Mortgagee', 'Estate Agent', 'Lender Solicitor', 'Vendor', 'Surveyor'].map(normaliseRole), ['client', 'other_side_solicitor', 'lender', 'agent', 'lender_solicitor', 'other_side', 'other']);
  assert.equal(contactRoleOf('other_side_solicitor'), 'OTHER_SIDE');

  assert.equal(isEnrollableMatterType({ id: 'x', name: 'Purchase — Freehold', areaOfLaw: 'Conveyancing' }), true);
  assert.equal(isEnrollableMatterType({ id: 'x', name: 'Purchase — Leasehold', areaOfLaw: 'Conveyancing' }), false, 'leasehold is out of scope for v1');
  assert.equal(isEnrollableMatterType({ id: 'x', name: 'Sale — Freehold', areaOfLaw: 'Conveyancing' }), false);
  assert.equal(isEnrollableMatterType({ id: 'x', name: 'Will', areaOfLaw: 'Wills' }), false);
  assert.equal(trackOf({ id: 'x', name: 'Sale — Freehold', areaOfLaw: 'Conveyancing' }), 'SALE');

  assert.deepEqual(documentHint(toDocument({ id: 'd', name: 'Local search CON29R.pdf', folder: 'Searches' })), { role: 'search', searchType: 'CON29' });
  assert.deepEqual(documentHint(toDocument({ id: 'd', name: 'Drainage and water CON29DW - 14 Oak Street.pdf', folder: 'Searches' })), { role: 'search', searchType: 'DRAINAGE_WATER' });
  assert.deepEqual(documentHint(toDocument({ id: 'd', name: 'Mortgage offer - Mock BS.pdf' })), { role: 'mortgage_offer', searchType: null });
  assert.deepEqual(documentHint(toDocument({ id: 'd', name: 'Client care letter.docx' })), { role: null, searchType: null });

  const ev = toWebhookEvent({ eventType: 'DocumentCreated', data: { matterId: 'm-1', documentId: 'd-9' }, occurredAt: '2026-09-02T10:00:00Z' }, 'fallback');
  assert.deepEqual([ev.type, ev.matterId, ev.documentId, ev.id], ['document.created', 'm-1', 'd-9', 'fallback']);
  assert.equal(toWebhookEvent({ type: 'matter.closed', id: 'ev-1', payload: { id: 'm-3' } }, 'x').matterId, 'm-3');
  assert.equal(toWebhookEvent({ type: 'something.else' }, 'x').type, 'unknown');
  assert.equal(extractExternalRef(tagExternalRef('Open it', 'decision:abc')), 'decision:abc');
});

// ───────────────────────────── sync (phase 0) ─────────────────────────────

test('sync: only open freehold purchases are enrolled; parties become contacts; the lender decides hasLender; documents flow into the engine', async () => {
  const leap = new MockLeap();
  const { oak, lease, sale, will } = seedFirm(leap);
  leap.seedDocument(oak.id, { ...pdfWithFacts('id-check-priya.pdf', { provider: 'thirdfort', outcome: 'clear', flags: [], confidence: 0.99 }, ['ID CHECK', 'CLEAR']), folder: 'AML' } as never);
  const h = harness(leap);
  const s1 = await syncMatters(h.deps, TENANT, { full: true });
  assert.deepEqual(s1.matters, { seen: 4, created: 4, enrolled: 1, closed: 0 });
  assert.deepEqual(s1.errors, []);
  const oakRef = (await h.mirror.matterByLeapId(TENANT, oak.id))!;
  const state = await h.svc.getState(TENANT, oakRef.matterId);
  assert.equal(state.enrolled, true);
  assert.equal(state.hasLender, true, 'a Mortgagee card on the matter → lender');
  assert.equal(state.targetCompletionDate, '2026-12-18');
  assert.equal(state.counterpartyType, 'external');
  for (const other of [lease, sale, will]) assert.equal((await h.svc.getState(TENANT, (await h.mirror.matterByLeapId(TENANT, other.id))!.matterId)).enrolled, false, `${other.number} not enrolled`);
  assert.deepEqual(h.mirror.contacts.get(oakRef.matterId)!.map((p) => [p.role, p.card.email]), [['client', 'priya.shah@example.com'], ['lender', null], ['other_side_solicitor', 'post@greenfield-law.example']]);
  // The ID report LEAP already held was mirrored and handed to the engine → id_check cleared → pre_contract.
  assert.equal(s1.documents.created, 1);
  assert.equal(h.ingested.length, 1);
  assert.equal(state.idCheck.status, 'cleared', 'the ID check the firm ordered from LEAP is recorded (actor external) then cleared');
  assert.equal(state.stage, 'pre_contract');
  assert.ok(h.store.dump(TENANT, oakRef.matterId).some((e) => e.type === 'id_check_requested' && e.actor === 'external' && (e.payload as { provider: string }).provider === 'arrived via LEAP'));

  // Second incremental sync: nothing new, nothing re-ingested (watermarks + idempotent upserts).
  const s2 = await syncMatters(h.deps, TENANT);
  assert.equal(s2.matters.created, 0);
  assert.equal(s2.documents.created, 0);
  assert.equal(h.ingested.length, 1);
});

test('sync: a webhook for a new LEAP document on an enrolled matter lands in the engine as a decision; matter closed → mirror closed', async () => {
  const leap = new MockLeap();
  const { oak } = seedFirm(leap);
  const h = harness(leap);
  await syncMatters(h.deps, TENANT, { full: true });
  const oakRef = (await h.mirror.matterByLeapId(TENANT, oak.id))!;
  await h.svc.requestIdCheck(TENANT, oakRef.matterId, ALICE);
  const idDoc = leap.seedDocument(oak.id, { ...pdfWithFacts('ID report.pdf', { provider: 'mock', outcome: 'clear', flags: [], confidence: 0.99 }, ['clear']), folder: 'AML' } as never);
  let out = await handleLeapWebhook(h.deps, TENANT, { id: 'ev-1', type: 'document.created', firmId: 'firm-demo', matterId: oak.id, documentId: idDoc.id, cardId: null, taskId: null, occurredAt: null, raw: {} });
  assert.equal(out.status, 'PROCESSED');
  assert.equal((await h.svc.getState(TENANT, oakRef.matterId)).stage, 'pre_contract');
  // A flagged CON29 arrives in LEAP's Searches folder.
  const con29 = leap.seedDocument(oak.id, { ...pdfWithFacts('CON29R 14 Oak Street.pdf', { searchType: 'CON29', flags: [{ code: 'PLANNING_ENFORCEMENT', severity: 'high', description: 'Enforcement notice outstanding', locator: { page: 1, section: '3.7' } }], confidence: 0.94 }, ['3.7 ENFORCEMENT NOTICE']), folder: 'Searches' } as never);
  out = await handleLeapWebhook(h.deps, TENANT, { id: 'ev-2', type: 'document.created', firmId: 'firm-demo', matterId: oak.id, documentId: con29.id, cardId: null, taskId: null, occurredAt: null, raw: {} });
  assert.equal(out.status, 'PROCESSED');
  const state = await h.svc.getState(TENANT, oakRef.matterId);
  assert.equal(state.searches.CON29?.status, 'flagged');
  const d = pendingDecisions(state).find((x) => x.kind === 'search')!;
  assert.ok(d, 'a decision citing the LEAP document');
  assert.equal(d.sourceDocumentId, h.mirror.documents.get(con29.id)!.documentId);
  // The same delivery again is a no-op (already mirrored).
  out = await handleLeapWebhook(h.deps, TENANT, { id: 'ev-2b', type: 'document.updated', firmId: 'firm-demo', matterId: oak.id, documentId: con29.id, cardId: null, taskId: null, occurredAt: null, raw: {} });
  assert.equal(out.status, 'IGNORED');
  // Matter closed in LEAP.
  leap.updateMatter(oak.id, { status: 'closed' });
  out = await handleLeapWebhook(h.deps, TENANT, { id: 'ev-3', type: 'matter.closed', firmId: 'firm-demo', matterId: oak.id, documentId: null, cardId: null, taskId: null, occurredAt: null, raw: {} });
  assert.equal(out.status, 'PROCESSED');
  assert.equal(h.mirror.matters.get(oak.id)!.status, 'CLOSED');
  // A document on a matter never seen before: the matter is mirrored (and enrolled) first.
  const fresh = leap.seedMatter({ number: 'NEW-1', description: 'Purchase of 1 New Road', propertyAddress: '1 New Road' });
  const doc = leap.seedDocument(fresh.id, { name: 'Client care.docx', bytes: Buffer.from('x') });
  out = await handleLeapWebhook(h.deps, TENANT, { id: 'ev-4', type: 'document.created', firmId: 'firm-demo', matterId: fresh.id, documentId: doc.id, cardId: null, taskId: null, occurredAt: null, raw: {} });
  assert.match(out.reason, /matter mirrored and enrolled/);
});

test('sync: LEAP matters can be enrolled in SHADOW mode — the engine observes, nothing surfaces, nothing is ordered', async () => {
  const leap = new MockLeap();
  const { oak } = seedFirm(leap);
  const h = harness(leap, { shadow: true });
  await syncMatters(h.deps, TENANT, { full: true });
  const ref = (await h.mirror.matterByLeapId(TENANT, oak.id))!;
  const state = await h.svc.getState(TENANT, ref.matterId);
  assert.equal(state.shadowMode, true);
  assert.equal((await h.store.listQueue(TENANT)).length, 0);
});

test('sync: documents arrive in LEAP in any order — a search result filed before the ID check clears waits (PENDING) and is taken on the next sync', async () => {
  const leap = new MockLeap();
  const { oak } = seedFirm(leap);
  // The firm filed the CON29 before the ID report.
  leap.seedDocument(oak.id, { ...pdfWithFacts('CON29R 14 Oak Street.pdf', { searchType: 'CON29', flags: [{ code: 'PLANNING_ENFORCEMENT', severity: 'high', description: 'Enforcement notice', locator: { page: 1 } }], confidence: 0.94 }, ['3.7 ENFORCEMENT NOTICE']), folder: 'Searches' } as never);
  leap.seedDocument(oak.id, { ...pdfWithFacts('Client care letter.pdf', null, ['Dear Priya']), folder: 'Correspondence' } as never);
  const h = harness(leap);
  const s1 = await syncMatters(h.deps, TENANT, { full: true });
  assert.deepEqual([s1.documents.created, s1.documents.ingested, s1.documents.pending], [2, 0, 1], 'CON29 pending, letter skipped');
  assert.deepEqual(s1.errors, []);
  const ref = (await h.mirror.matterByLeapId(TENANT, oak.id))!;
  assert.equal((await h.svc.getState(TENANT, ref.matterId)).stage, 'instruction');
  // Now the ID report lands.
  leap.seedDocument(oak.id, { ...pdfWithFacts('ID report - Priya Shah.pdf', { provider: 'mock', outcome: 'clear', flags: [], confidence: 0.99 }, ['CLEAR']), folder: 'AML' } as never);
  const s2 = await syncMatters(h.deps, TENANT);
  const state = await h.svc.getState(TENANT, ref.matterId);
  assert.equal(state.stage, 'pre_contract', 'the ID report was found by the per-matter document poll (the matter itself did not change in LEAP)');
  assert.equal(s2.documents.retried, 1, 'the pending CON29 was retried first (still at instruction then)');
  // Next sync: the retry lands now that the stage is pre_contract.
  const s3 = await syncMatters(h.deps, TENANT);
  assert.equal(s3.documents.retried, 1);
  const after = await h.svc.getState(TENANT, ref.matterId);
  assert.equal(after.searches.CON29?.status, 'flagged', 'the earlier-filed search result is now in the engine');
  assert.ok(h.store.dump(TENANT, ref.matterId).some((e) => e.type === 'search_ordered' && (e.payload as { searchType: string }).searchType === 'CON29'), 'the CON29 order exists (auto-ordered on pre_contract entry, so the result needed no manual order record)');
  assert.equal((await h.mirror.pendingIngests(TENANT, ref.matterId)).length, 0);
  void s2;
});

// ───────────────────────────── write-back (phase 1) ─────────────────────────────

test('write-back: a surfaced decision becomes a LEAP task; its resolution completes the task and leaves a file note; stage moves are notes; shadow matters write nothing', async () => {
  const leap = new MockLeap();
  const { oak } = seedFirm(leap);
  const h = harness(leap);
  await syncMatters(h.deps, TENANT, { full: true });
  const ref = (await h.mirror.matterByLeapId(TENANT, oak.id))!;
  const wb = new MemoryWriteback(h.mirror);
  const applied: EngineEvent[] = [];
  h.ports.onEvents = async (input: { tenantId: string; matterId: string; events: EngineEvent[]; state: MatterState }) => {
    applied.push(...input.events);
    await writeBack({ leap, store: wb, appUrl: 'https://conveyi.test', subflows: async () => h.store.loadSubflows(TENANT), log: () => {} }, input.tenantId, input.matterId, input.events, input.state);
  };
  await h.svc.requestIdCheck(TENANT, ref.matterId, ALICE);
  await h.svc.idCheckResultReceived(TENANT, ref.matterId, h.ports.documents.seed({ tenantId: TENANT, matterId: ref.matterId, docType: 'PDF', extractedFacts: { provider: 'mock', outcome: 'clear', flags: [], confidence: 0.99 } }).id);
  const r = await h.svc.searchReturned(TENANT, ref.matterId, 'CON29', h.ports.documents.seed({ tenantId: TENANT, matterId: ref.matterId, docType: 'PDF', extractedFacts: { searchType: 'CON29', flags: [{ code: 'PLANNING_ENFORCEMENT', severity: 'high', description: 'Enforcement notice', locator: { page: 1 } }], confidence: 0.94 } }).id);
  const d = pendingDecisions(r.state).find((x) => x.kind === 'search')!;
  let dump = leap.dump(oak.id);
  const task = dump.tasks.find((t) => t.externalRef === `decision:${d.eventId}`)!;
  assert.ok(task, 'a LEAP task for the flagged search');
  assert.match(task.title, /decision needed — search · CON29/);
  assert.match(task.description!, /https:\/\/conveyi\.test\/decisions\//);
  assert.equal(task.assigneeStaffId, 'staff-1', 'assigned to LEAP\'s responsible staff');
  assert.equal(task.completed, false);
  assert.ok(!dump.tasks.some((t) => /auto-clear/i.test(t.title)), 'advisory auto-clear reviews are not tasks');
  assert.ok(dump.notes.some((n) => /Stage → pre contract/.test(n.body)), 'stage move → file note');
  assert.ok(dump.notes.some((n) => /search ordered via mock-search-provider/.test(n.body)));
  assert.ok(dump.notes.some((n) => /ID\/AML check requested/.test(n.body)));

  await h.svc.openDecisionSource(TENANT, ref.matterId, d.eventId, ALICE);
  await h.svc.resolveDecision(TENANT, ref.matterId, d.eventId, ALICE, 'refer_to_client', 'Client to decide on the outbuilding');
  dump = leap.dump(oak.id);
  assert.equal(dump.tasks.find((t) => t.id === task.id)!.completed, true, 'task completed on resolution');
  const note = dump.notes.find((n) => /refer to client/i.test(n.body))!;
  assert.ok(note, 'resolution → file note');
  assert.match(note.body, /by Alice Okafor/);
  assert.match(note.body, /Reason: Client to decide/);
  assert.match(note.body, /Sources: /);

  // Idempotent: re-applying the same events writes nothing new.
  const before = dump.notes.length + dump.tasks.length;
  await writeBack({ leap, store: wb, appUrl: 'https://conveyi.test', subflows: async () => h.store.loadSubflows(TENANT), log: () => {} }, TENANT, ref.matterId, applied, await h.svc.getState(TENANT, ref.matterId));
  dump = leap.dump(oak.id);
  assert.equal(dump.notes.length + dump.tasks.length, before);

  // Shadow matter: nothing written.
  const sh = harness(leap, { shadow: true });
  const leap2 = new MockLeap();
  const { oak: oak2 } = seedFirm(leap2);
  sh.deps.leap = leap2;
  await syncMatters(sh.deps, TENANT, { full: true });
  const ref2 = (await sh.mirror.matterByLeapId(TENANT, oak2.id))!;
  const wb2 = new MemoryWriteback(sh.mirror);
  const r2 = await sh.svc.requestIdCheck(TENANT, ref2.matterId, ALICE);
  const res = await writeBack({ leap: leap2, store: wb2, appUrl: 'x', subflows: async () => sh.store.loadSubflows(TENANT), log: () => {} }, TENANT, ref2.matterId, r2.events, r2.state);
  assert.deepEqual(res, { tasks: 0, notes: 0, completed: 0, skipped: r2.events.length });
  assert.equal(leap2.dump(oak2.id).notes.length, 0);
});

// ───────────────────────────── HTTP client vs the mock server ─────────────────────────────

class MemoryTokens implements LeapTokenStore {
  tokens: LeapTokens | null = null;
  disconnected: string | null = null;
  async load() {
    return this.tokens;
  }
  async save(_t: string, tokens: LeapTokens) {
    this.tokens = tokens;
  }
  async markDisconnected(_t: string, reason: string) {
    this.disconnected = reason;
  }
}

test('HTTP client: OAuth code + PKCE, refresh on expiry and on 401, retry on 503, paging, download, multipart upload, webhook signature', async () => {
  const server = new MockLeapServer({ clientId: 'cid', clientSecret: 'sec', apiKey: 'key-1', webhookSecret: 'whsec', failFirst: 2 });
  const base = await server.start();
  try {
    const { alice } = seedFirm(server.leap);
    for (let i = 0; i < 3; i++) server.leap.seedMatter({ number: `EXTRA-${i}`, description: `Purchase ${i}`, responsible: alice });
    const tokens = new MemoryTokens();
    let clock = Date.now();
    const cfg = { authBaseUrl: base, apiBaseUrl: base, clientId: 'cid', clientSecret: 'sec', apiKey: 'key-1', redirectUri: 'http://localhost:1/cb', backoffMs: 5, pageSize: 3 };
    const client = new LeapHttpClient(cfg, TENANT, tokens, undefined, () => clock);

    // Authorization code flow: the mock's /oauth/authorize redirects straight back with a code.
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const url = LeapHttpClient.authorizeUrl(cfg, 'st-1', challenge);
    assert.ok(url.startsWith(`${base}${LEAP_ENDPOINTS.authorize}?`));
    const redirect = await fetch(url, { redirect: 'manual' });
    const back = new URL(redirect.headers.get('location')!);
    assert.equal(back.searchParams.get('state'), 'st-1');
    await assert.rejects(client.connectWithCode(back.searchParams.get('code')!, 'wrong-verifier'), /PKCE|400/);
    const r2 = await fetch(url, { redirect: 'manual' });
    await client.connectWithCode(new URL(r2.headers.get('location')!).searchParams.get('code')!, verifier);
    assert.ok(tokens.tokens?.accessToken && tokens.tokens.refreshToken);

    // The first two API calls fail with 503 → retried transparently.
    const firm = await client.firm();
    assert.equal(firm.name, 'Demo Conveyancing LLP');

    // Paging: 7 matters, page size 3.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await client.listMatters({ cursor });
      seen.push(...page.items.map((m) => m.number));
      cursor = page.next;
      pages += 1;
    } while (cursor);
    assert.equal(seen.length, 7);
    assert.equal(pages, 3);
    assert.ok(seen.includes('OAK-14'));

    const oak = (await client.listMatters({ limit: 100 })).items.find((m) => m.number === 'OAK-14')!;
    const parties = await client.matterParties(oak.id);
    assert.deepEqual(parties.map((p) => p.role), ['client', 'lender', 'other_side_solicitor']);

    // Upload (multipart) then download; then the document is listed.
    const up = await client.uploadDocument(oak.id, { fileName: 'DRAFT - report (CONVEYi).txt', mimeType: 'text/plain', bytes: Buffer.from('hello LEAP'), folder: 'CONVEYi' });
    assert.equal(up.name, 'DRAFT - report (CONVEYi).txt');
    const dl = await client.downloadDocument(up.id);
    assert.equal(dl.bytes.toString(), 'hello LEAP');
    assert.equal(dl.fileName, 'DRAFT - report (CONVEYi).txt');
    assert.equal((await client.listDocuments(oak.id)).items.length, 1);
    assert.equal(await client.getDocument('nope'), null, '404 → null');

    // Tasks + notes.
    const t = await client.createTask(oak.id, { title: 'Decide', description: tagExternalRef('x', 'decision:1'), externalRef: 'decision:1' });
    assert.equal((await client.listTasks(oak.id))[0].externalRef, 'decision:1');
    assert.equal((await client.completeTask(t.id)).completed, true);
    await client.addNote(oak.id, 'CONVEYi: hello');
    assert.equal((await client.listNotes(oak.id))[0].body, 'CONVEYi: hello');

    // Token refresh when expired (clock jumps past expiry).
    const before = tokens.tokens!.accessToken;
    clock += 2 * 3600_000;
    await client.firm();
    assert.notEqual(tokens.tokens!.accessToken, before, 'refreshed');
    assert.equal(tokens.disconnected, null);

    // Webhook subscription + signed delivery, verified with the client's helper.
    const sub = await client.subscribeWebhook('http://127.0.0.1:1/never', ['document.created']);
    assert.ok(sub.id);
    const body = JSON.stringify({ eventType: 'DocumentCreated', data: { matterId: oak.id, documentId: up.id } });
    const sig = crypto.createHmac('sha256', 'whsec').update(body).digest('hex');
    assert.equal(LeapHttpClient.verifySignature('whsec', body, sig), true);
    assert.equal(LeapHttpClient.verifySignature('whsec', body, `sha256=${sig}`), true);
    assert.equal(LeapHttpClient.verifySignature('whsec', body, 'nope'), false);
    assert.equal(LeapHttpClient.verifySignature('whsec', body, null), false);
    const ev = LeapHttpClient.parseWebhook(body, 'delivery-9');
    assert.deepEqual([ev.type, ev.id, ev.documentId], ['document.created', 'delivery-9', up.id]);
    void LEAP_WEBHOOK_SIGNATURE_HEADER;

    // A refresh token LEAP no longer honours → the connection is marked as needing reconnection, not hammered.
    tokens.tokens = { ...tokens.tokens!, refreshToken: 'stale', expiresAt: 0 };
    await assert.rejects(client.firm(), /token request failed \(400\)/);
    assert.match(tokens.disconnected!, /400/);
  } finally {
    await server.stop();
  }
});

test('multipart parser handles one file plus fields', () => {
  const boundary = 'XYZ';
  const raw = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nfile.txt\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from('bytes here'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const { fields, file } = parseMultipart(raw, `multipart/form-data; boundary=${boundary}`);
  assert.equal(fields.name, 'file.txt');
  assert.equal(file?.bytes.toString(), 'bytes here');
});
