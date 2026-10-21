/**
 * A proposal to send a request the case has already made another way is done, not pending: the system withdraws it,
 * so nobody can approve it later and ask the client a second time (docs/spec/triggers.md: system withdrawals).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineService } from '../../../lib/server/engine/service';
import { MemoryEventStore } from '../../../lib/server/engine/store';
import { mockPorts } from '../../../lib/server/engine/mocks';
import { DEFAULT_LEVELS } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER, idRefer } from './helpers';

function proposing() {
  // The product default: every outward step proposed for a person to approve.
  const ports = mockPorts(new Date('2026-09-14T09:00:00Z'));
  const svc = new EngineService(new MemoryEventStore(DEFAULT_LEVELS), ports);
  return { svc, ports, doc: (facts: unknown) => ports.documents.seed({ tenantId: TENANT, matterId: MATTER, docType: 'ID_CHECK_REPORT', extractedFacts: facts }).id };
}
const pendingKinds = async (svc: EngineService) => Object.values((await svc.getState(TENANT, MATTER)).proposals).filter((p) => p.status === 'pending').map((p) => (p.detail as { kind?: string }).kind ?? p.action);

test('the ID check requested by hand withdraws the proposal to request it; a result needing review never sends a second request', async () => {
  const h = proposing();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_purchase', hasLender: true, requiredSearches: ['LLC1'] } as never);
  assert.ok((await pendingKinds(h.svc)).includes('id_check_request'), 'enrolment proposes the ID check request');
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  assert.ok(!(await pendingKinds(h.svc)).includes('id_check_request'), 'withdrawn once the check is requested');
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idRefer()));
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.idCheck.status, 'flagged');
  assert.ok(!s.waits.some((w) => w.key === 'id_check' && !w.closedAt), 'the result is in: nothing is waited on from the client');
  const withdrawn = Object.values(s.proposals).find((p) => (p.detail as { kind?: string }).kind === 'id_check_request');
  assert.equal(withdrawn?.status, 'rejected');
});

test('the proof-of-funds form sent by hand withdraws the proposal to send it', async () => {
  const h = proposing();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_purchase', hasLender: true, requiredSearches: [], requireProofOfFunds: true } as never);
  const before = await pendingKinds(h.svc);
  await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  assert.ok(!(await pendingKinds(h.svc)).includes('proof_of_funds_request'), `withdrawn once the form is sent (was: ${before.join(', ')})`);
});
