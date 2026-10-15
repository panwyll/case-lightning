/**
 * A case taken on part-way through (docs/spec/triggers.md, "Missed moments"): placed from its history with nothing sent,
 * one task to confirm where it is, then the engine takes over. And the other side's "we have exchanged" read as a line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, TENANT, MATTER, USER, searchClear } from './helpers';
import { dueSteps } from '../../../lib/server/engine/due';
import { matterWork } from '../../../lib/server/engine/work';
import { placementChecklist } from '../../../lib/server/engine/placement';
import { DeterministicNoteReader, senderPolicy } from '../../../lib/server/engine/notes';

test('a case enrolled while placing sends nothing, reads what arrives, and asks only to be confirmed', async () => {
  const h = harness();
  h.ports.autoStartOnEnrol = true;
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['CON29'], placing: 'Taken on from InTouch part-way through' });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.placement?.status, 'placing');
  // Enrolment would have sent the ID check and the proof-of-funds form: held.
  assert.equal(s.idCheck.status, 'not_started');
  assert.equal(Object.keys(s.proposals).length, 0);
  assert.deepEqual(h.ports.idCheckProvider.requests ?? [], []);
  // A search on file is read and moves the case on.
  // As ingest does for a result with no recorded order.
  await h.svc.run(TENANT, MATTER, { type: 'record_search_ordered', actor: 'external', searchType: 'CON29', provider: 'unknown' });
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.searches.CON29);
  assert.equal(Object.keys(s.proposals).length, 0, 'nothing proposed while placing');
  // The clock chases nothing.
  h.advanceDays(10);
  assert.deepEqual(await h.svc.tick(TENANT, MATTER), { chases: 0, escalations: 0 });
  assert.equal(h.ports.chaser.chases.length, 0);
  // One task: confirm where it is.
  assert.deepEqual(dueSteps(s).map((d) => d.key), ['confirm_placement']);
  assert.deepEqual(matterWork(s).items.map((i) => i.id), ['do:step:confirm_placement']);
  const list = placementChecklist(s);
  assert.ok(list.some((x) => x.step === 'search:CON29'));
  assert.ok(list.some((x) => x.step === 'mortgage'), 'a purchase with a lender is asked about the offer');
});

test('confirming marks what was done outside CONVEYi, and the engine takes over', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], placing: 'Found under way' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'confirm_placement', actor: 'system', steps: [] }), /person/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'confirm_placement', actor: USER, steps: ['exchange'] }), /not a step/);
  await h.svc.run(TENANT, MATTER, { type: 'confirm_placement', actor: USER, steps: ['id_check', 'title'] });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.placement?.status, 'confirmed');
  assert.equal(s.idCheck.status, 'reviewed');
  assert.equal(s.title.status, 'reviewed');
  assert.ok(!dueSteps(s).some((d) => d.key === 'confirm_placement'));
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'confirm_placement', actor: USER, steps: [] }), /not waiting/);
});

test('a case already on the engine can be placed once; a new case is never placed', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false });
  assert.equal((await h.svc.getState(TENANT, MATTER)).placement, undefined);
  await h.svc.run(TENANT, MATTER, { type: 'start_placement', actor: 'system', reason: 'Enrolled with documents already on file' });
  assert.equal((await h.svc.getState(TENANT, MATTER)).placement?.status, 'placing');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'start_placement', actor: 'system', reason: 'again' }), /already been placed/);
});

test("the other side's \"we have exchanged\" is a line to record exchange, with the date they give; anyone else's is information", async () => {
  const reader = new DeterministicNoteReader();
  const text = 'We have exchanged contracts this morning with completion set for 30th October. Completion has taken place on the related sale.';
  const drafts = await reader.extract({ tenantId: TENANT, matterId: MATTER, kind: 'email', text });
  const ex = drafts.find((d) => d.command?.type === 'record_exchange');
  assert.ok(ex);
  assert.match((ex!.command as { completionDate: string }).completionDate, /^\d{4}-10-30$/);
  assert.ok(drafts.some((d) => d.command?.type === 'record_completion'));
  const plan = (await reader.extract({ tenantId: TENANT, matterId: MATTER, kind: 'email', text: 'Once we have exchanged we will send the TR1.' })).filter((d) => d.command?.type === 'record_exchange');
  assert.equal(plan.length, 0, 'not done yet is not an exchange');
  const asAction = { ...ex!, id: 'a1' } as never;
  const fromAgent = senderPolicy({ kind: 'email', from: { relation: 'agent', address: 'a@agents.test', name: 'Agent' } as never }, asAction);
  assert.equal(fromAgent[0].command, null);
  const fromSolicitor = senderPolicy({ kind: 'email', from: { relation: 'other_side', address: 's@law.test', name: 'Other Side' } as never }, asAction);
  assert.equal((fromSolicitor[0].command as { type: string }).type, 'record_exchange');
});
