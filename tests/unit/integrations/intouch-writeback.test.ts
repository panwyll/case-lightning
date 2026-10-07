/**
 * CONVEYi → InTouch write-back (docs/intouch-integration.md "Writing back"): documents filed here and
 * a note per significant event go into the InTouch case, each only when the firm has it on, once each,
 * never for a matter in shadow mode or not run by the engine, and never drafts or raw bank data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockInTouch } from '../../../lib/server/integrations/intouch/mock';
import { InTouchHttpClient } from '../../../lib/server/integrations/intouch/client';
import { writeBackToInTouch, type InTouchWritebackStore } from '../../../lib/server/integrations/intouch/writeback';
import type { EngineEvent, MatterState } from '../../../lib/server/engine/types';

const TENANT = '11111111-1111-4111-8111-111111111111';
const MATTER = '22222222-2222-4222-8222-222222222222';

class MemoryWriteback implements InTouchWritebackStore {
  opts = { documents: true, notes: true };
  docs = [
    { id: 'd1', fileName: 'Report on title.docx', docType: 'REPORT_ON_TITLE', sentAs: null as string | null },
    { id: 'd2', fileName: 'Draft report', docType: 'REPORT_ON_TITLE_DRAFT', sentAs: null as string | null },
    { id: 'd3', fileName: 'Barclays ····4821 (connected)', docType: 'OPEN_BANKING_ACCOUNT', sentAs: null as string | null },
  ];
  noted = new Set<string>();
  events: EngineEvent[] = [
    { id: 'e1', seq: 1, type: 'search_ordered', actor: 'system', payload: { searchType: 'CON29', provider: 'InfoTrack', reference: 'IT-9' }, createdAt: '2026-09-20T10:00:00Z' } as unknown as EngineEvent,
    { id: 'e2', seq: 2, type: 'issue_raised', actor: 'u', payload: { title: 'No building regs for the loft [crosscheck:x]', gate: 'exchange' }, createdAt: '2026-09-21T11:00:00Z' } as unknown as EngineEvent,
  ];
  async writebackOptions() { return this.opts; }
  async outgoingDocuments() { return this.docs.filter((d) => !d.sentAs); }
  async documentBytes(_t: string, id: string) { return { name: this.docs.find((d) => d.id === id)!.fileName, bytes: Buffer.from(`bytes of ${id}`), contentType: 'application/pdf' }; }
  async documentSent(_t: string, _m: string, id: string, intouchId: string) { this.docs.find((d) => d.id === id)!.sentAs = intouchId; }
  async unnotedEvents(_t: string, _m: string, types: string[]) { return this.events.filter((e) => types.includes(e.type) && !this.noted.has(e.id)); }
  async eventNoted(_t: string, _m: string, id: string) { this.noted.add(id); }
}

function setup() {
  const itouch = new MockInTouch({ apiToken: 'firm-key' });
  const caseId = itouch.seed({});
  const api = new InTouchHttpClient({ apiBaseUrl: 'https://intouch.test', apiToken: 'firm-key', backoffMs: 1 }, TENANT, itouch.transport);
  return { itouch, caseId, api, store: new MemoryWriteback() };
}
const live = { enrolled: true, shadowMode: false } as unknown as MatterState;

test('documents go into the InTouch case, never drafts or raw bank data, and are stamped so they are not mirrored back', async () => {
  const { itouch, caseId, api, store } = setup();
  store.opts.notes = false;
  const r = await writeBackToInTouch(api, store, TENANT, { matterId: MATTER, intouchCaseId: caseId }, live, () => {});
  assert.equal(r.documents, 1);
  const sent = itouch.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/files'));
  assert.equal(sent.length, 1);
  const multipart = (sent[0].body as Buffer).toString('latin1');
  assert.match(multipart, /name="file"; filename="Report on title\.docx"/);
  assert.match(multipart, /bytes of d1/);
  assert.deepEqual(sent[0].query.label, ['conveyi']);
  assert.ok(store.docs[0].sentAs && !store.docs[0].sentAs.startsWith('name:'), 'stamped with InTouch\'s own id, read back from the folder');
  assert.equal(store.docs[1].sentAs, null, 'a draft stays here');
  assert.equal(store.docs[2].sentAs, null, 'raw bank data stays here');
  const again = await writeBackToInTouch(api, store, TENANT, { matterId: MATTER, intouchCaseId: caseId }, live, () => {});
  assert.equal(again.documents, 0, 'once');
});

test('a case note per significant event, in plain words, once each', async () => {
  const { itouch, caseId, api, store } = setup();
  store.opts.documents = false;
  await writeBackToInTouch(api, store, TENANT, { matterId: MATTER, intouchCaseId: caseId }, live, () => {});
  const notes = itouch.notesFor(caseId);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /^CONVEYi · 2026-09-20 10:00 · CON29 search ordered via InfoTrack \(ref IT-9\)$/);
  assert.match(notes[1], /Issue raised: No building regs for the loft \(holds exchange\)$/, 'internal markers are taken out');
  await writeBackToInTouch(api, store, TENANT, { matterId: MATTER, intouchCaseId: caseId }, live, () => {});
  assert.equal(itouch.notesFor(caseId).length, 2, 'once each');
});

test('nothing is written when the firm has it off, the matter is in shadow mode, or the engine is not running it', async () => {
  for (const [state, opts] of [[live, { documents: false, notes: false }], [{ enrolled: true, shadowMode: true }, { documents: true, notes: true }], [{ enrolled: false, shadowMode: false }, { documents: true, notes: true }]] as const) {
    const { itouch, caseId, api, store } = setup();
    store.opts = { ...opts };
    await writeBackToInTouch(api, store, TENANT, { matterId: MATTER, intouchCaseId: caseId }, state as unknown as MatterState, () => {});
    assert.equal(itouch.calls.filter((c) => c.method === 'POST').length, 0);
  }
});

test('a failed upload is left for the next sync, not lost', async () => {
  const { itouch, caseId, api, store } = setup();
  itouch.failNext = 5;
  const r = await writeBackToInTouch(api, store, TENANT, { matterId: MATTER, intouchCaseId: caseId }, live, () => {});
  assert.equal(r.documents, 0);
  assert.equal(store.docs[0].sentAs, null, 'still to send');
});
