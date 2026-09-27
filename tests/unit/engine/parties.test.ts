import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageBlockers } from '../../../lib/server/engine/machine';
import { pendingDecisions } from '../../../lib/server/engine/types';
import { harness, firstDecision, resolve, TENANT, MATTER, USER, idClear, idRefer } from './helpers';

test('two buyers named at enrolment: each has an ID / AML check of their own and Instruction holds until both are resolved', async () => {
  const h = harness();
  const r = await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], parties: 2, partyNames: ['Tomasz Nowak', 'Ewa Nowak'] });
  assert.ok(r.events.some((e) => e.type === 'id_party_added'));
  let s = await h.svc.getState(TENANT, MATTER);
  const ewa = s.partyChecks['buyer:ewa-nowak'];
  assert.ok(ewa && ewa.label === 'Ewa Nowak' && ewa.role === 'buyer');
  assert.equal(ewa.status, 'requested', 'requested on enrolment like the first client\'s');
  assert.ok(s.waits.some((w) => w.key === 'id_check' && w.subject === ewa.party && !w.closedAt), 'her own wait');
  // The first client clears; the stage still holds for Ewa.
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'instruction');
  assert.ok(stageBlockers(s).some((b) => /ID\/AML check for Ewa Nowak requested/.test(b)));
  // Ewa's result refers: a decision of its own, naming her.
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idRefer()), ewa.party);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.partyChecks[ewa.party].status, 'flagged');
  const d = firstDecision(s, 'id_check');
  assert.equal(d.subject, ewa.party);
  assert.match(d.summary, /Ewa Nowak/);
  await resolve(h, d.eventId, 'approve', USER, 'PEP match reviewed');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.partyChecks[ewa.party].status, 'reviewed');
  assert.equal(s.idCheck.status, 'cleared');
  assert.equal(s.stage, 'pre_contract');
  assert.equal(pendingDecisions(s).filter((x) => x.kind === 'id_check').length, 0);
});

test('a result with no name goes to the one check waiting; with two waiting it is not guessed', async () => {
  const { routeClassification } = await import('../../../lib/server/engine/ingest');
  const { initialState } = await import('../../../lib/server/engine/types');
  const base = { ...initialState(TENANT, MATTER), enrolled: true };
  const c = { role: 'id_check' as const, searchType: null, enquiryReferences: [], titleNumber: null, lender: null, confidence: 0.9, reason: 'an ID report' };
  const one = { ...base, idCheck: { ...base.idCheck, status: 'cleared' as const }, partyChecks: { 'donor:a': { party: 'donor:a', label: 'A (donor)', role: 'donor' as const, status: 'requested' as const, requestedAt: null, documentId: null, decisionEventId: null } } };
  assert.deepEqual(routeClassification(one, c), { kind: 'id_check', party: 'donor:a' });
  const two = { ...one, idCheck: { ...base.idCheck, status: 'requested' as const } };
  assert.equal(routeClassification(two, c).kind, 'skip');
});
