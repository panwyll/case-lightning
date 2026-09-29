/**
 * Nothing waits for someone to find a button: the engine sends what it can when it falls due, asks
 * the client (and chases them) for what only they can give, and lists what is left for us.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueSteps } from '../../../lib/server/engine/due';
import { harness, TENANT, MATTER, USER } from './helpers';

test('a sale: the property forms and the redemption statement are asked for at instruction; the official copies are a step for us', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: true, requireExchangeAuthority: false });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.propertyForms.status, 'requested');
  assert.equal(s.redemption.status, 'requested');
  assert.ok(s.waits.some((w) => w.key === 'property_forms' && w.closedAt === null), 'the client is chased for the forms');
  assert.ok(dueSteps(s).some((d) => d.key === 'official_copies'), 'the official copies are on our list');
});

test('joint buyers are asked how they will own it at the start, and chased until they answer', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requireProofOfFunds: false, requireExchangeAuthority: false, requiredSearches: [], parties: 2, partyNames: ['Ann Smith', 'Ben Smith'] });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.clientUpdateLastSentAt.ownership_basis_request, 'the question went to the clients');
  assert.ok(s.waits.some((w) => w.key === 'client_decision' && w.subject === 'ownership_basis' && w.closedAt === null));
  h.advanceDays(5);
  await h.svc.tick(TENANT, MATTER);
  assert.ok(h.ports.chaser.chases.some((c) => c.template === 'chase_ownership_basis' && c.recipientRole === 'client'), 'chased with the client');
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'ownership_basis', decision: 'joint_tenants', note: 'Both replied by email' } as never);
  s = await h.svc.getState(TENANT, MATTER);
  assert.ok(!s.waits.some((w) => w.key === 'client_decision' && w.closedAt === null), 'the answer closes the wait');
});

test('a suspended firm is not swept: nothing is chased until they pay, then what fell due goes on the next sweep', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: false, requireExchangeAuthority: false });
  let paid = false;
  (h.ports as { entitled?: (t: string) => Promise<boolean> }).entitled = async () => paid;
  h.advanceDays(9);
  await h.svc.tickAll(TENANT);
  assert.ok(!h.ports.chaser.chases.some((c) => c.template === 'chase_property_forms'), 'no chase while suspended');
  paid = true;
  await h.svc.tickAll(TENANT);
  assert.ok(h.ports.chaser.chases.some((c) => c.template === 'chase_property_forms'), 'chased once they pay');
});
