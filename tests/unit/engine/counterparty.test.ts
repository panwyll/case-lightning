import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoSharedHandler, parseCounterpartyRef, ConflictOfInterestError } from '../../../lib/server/engine/counterparty';
import { buildAuditReport } from '../../../lib/server/engine/audit';
import { harness, TENANT, MATTER, USER, idClear, replyClear } from './helpers';

const OTHER = '55555555-5555-4555-8555-555555555555';

test('requirement 5: the same handler on both sides is a hard error; different handlers are fine', () => {
  assert.throws(() => assertNoSharedHandler({ matterId: 'a', handlerId: USER }, { matterId: 'b', handlerId: USER }), ConflictOfInterestError);
  assert.doesNotThrow(() => assertNoSharedHandler({ matterId: 'a', handlerId: USER }, { matterId: 'b', handlerId: 'someone-else' }));
  assert.doesNotThrow(() => assertNoSharedHandler({ matterId: 'a', handlerId: null }, { matterId: 'b', handlerId: null }));
});

test('requirement 1: one CounterpartyRef shape, two kinds, parsed defensively', () => {
  assert.deepEqual(parseCounterpartyRef({ kind: 'internal', matterId: OTHER }), { kind: 'internal', matterId: OTHER });
  assert.deepEqual(parseCounterpartyRef({ kind: 'external', name: 'Smith & Co', email: 'x@smith.law' }), { kind: 'external', name: 'Smith & Co', email: 'x@smith.law', firm: null });
  assert.equal(parseCounterpartyRef({ kind: 'internal' }), null);
  assert.equal(parseCounterpartyRef('nope'), null);
});

test('requirements 3 + 4: an enquiry to an internal counterparty produces the SAME event pair as an external one, stamped internal, delivered via the port, never by reading the other matter', async () => {
  const h = harness();
  const delivered: Array<{ fromMatterId: string; enquiryId: string }> = [];
  h.ports.linked = { name: 'fake-linked', enquiryRaised: async (i) => { delivered.push({ fromMatterId: i.fromMatterId, enquiryId: i.enquiryId }); } };
  // The "other side" is matter OTHER in the same store; it has its own (empty) log.
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'], counterpartyType: 'internal' });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const before = h.store.dump(TENANT, OTHER);
  const r = await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'Boundary ownership' });
  const raised = r.events.find((e) => e.type === 'enquiry_raised')!;
  assert.equal((raised.payload as { counterpartyType: string }).counterpartyType, 'internal');
  assert.deepEqual(delivered, [{ fromMatterId: MATTER, enquiryId: 'E1' }]);
  assert.deepEqual(h.store.dump(TENANT, OTHER), before, "the other matter's log is untouched — no shortcut");
  // The reply comes back the normal way: as a document filed on the buyer's matter.
  const reply = await h.svc.enquiryReplyReceived(TENANT, MATTER, 'E1', h.doc(replyClear('E1')));
  const received = reply.events.find((e) => e.type === 'enquiry_reply_received')!;
  assert.equal((received.payload as { counterpartyType: string }).counterpartyType, 'internal');
  assert.equal(reply.state.enquiries.E1.status, 'cleared');
  const report = buildAuditReport(TENANT, MATTER, h.store.dump(TENANT, MATTER), null);
  assert.equal(report.summary.internalCounterpartyEvents, 3, 'matter_created + enquiry_raised + enquiry_reply_received');

  // External counterparty: identical event shapes, stamped external, port not called.
  const g = harness();
  g.ports.linked = { name: 'fake-linked', enquiryRaised: async () => { throw new Error('must not be called for external'); } };
  await g.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'], counterpartyType: 'external' });
  await g.svc.requestIdCheck(TENANT, MATTER, USER);
  await g.svc.idCheckResultReceived(TENANT, MATTER, g.doc(idClear()));
  const ext = await g.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'Boundary ownership' });
  assert.equal((ext.events.find((e) => e.type === 'enquiry_raised')!.payload as { counterpartyType: string }).counterpartyType, 'external');
  assert.deepEqual(Object.keys(ext.events.find((e) => e.type === 'enquiry_raised')!.payload).sort(), Object.keys(raised.payload).sort(), 'same payload shape either way');
});

test('chases to the counterparty solicitor carry the counterparty type; other chases do not', async () => {
  const h = harness(new Date('2026-09-14T09:00:00Z'));
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'], counterpartyType: 'internal' });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'x' });
  h.ports.setNow(new Date('2026-09-28T09:00:00Z')); // 10 wd: search chase + enquiry chase both due
  await h.svc.tick(TENANT, MATTER);
  const chases = h.store.dump(TENANT, MATTER).filter((e) => e.type === 'chase_sent').map((e) => e.payload as { recipientRole: string; counterpartyType?: string });
  assert.equal(chases.find((c) => c.recipientRole === 'seller_solicitor')?.counterpartyType, 'internal');
  assert.equal(chases.find((c) => c.recipientRole === 'search_provider')?.counterpartyType, undefined);
});
