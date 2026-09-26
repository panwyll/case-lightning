import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, TENANT, MATTER, USER } from './helpers';

/**
 * Every instruction starts the same way without a button: the ID / AML check goes to the
 * provider and, on a purchase that needs one, the proof-of-funds form goes to the client.
 * The trust level decides whether a person is asked first.
 */
test('enrolment fires the ID check and the proof-of-funds form at AUTO', async () => {
  const h = harness();
  h.ports.autoStartOnEnrol = true;
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['LLC1'] });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.idCheck.status, 'requested');
  assert.equal(s.proofOfFunds.status, 'requested');
  // A person pressing the button afterwards changes nothing and raises no error.
  const again = await h.svc.requestIdCheck(TENANT, MATTER, USER);
  assert.equal(again.events.length, 0);
});

test('a sale does not send a proof-of-funds form; the ID check still goes', async () => {
  const h = harness();
  h.ports.autoStartOnEnrol = true;
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: false });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.idCheck.status, 'requested');
  assert.equal(s.proofOfFunds.status, 'not_started');
});

test('at PROPOSE both are proposals, not sends', async () => {
  const h = harness();
  h.ports.autoStartOnEnrol = true;
  await h.store.setLevel(TENANT, 'client_update:id_check_request', 'propose', USER);
  await h.store.setLevel(TENANT, 'client_update:proof_of_funds_request', 'propose', USER);
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['LLC1'] });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.idCheck.status, 'not_started');
  assert.equal(s.proofOfFunds.status, 'not_started');
  const kinds = Object.values(s.proposals).map((p) => p.subject).sort();
  assert.deepEqual(kinds, ['id_check_request', 'proof_of_funds_request']);
});
