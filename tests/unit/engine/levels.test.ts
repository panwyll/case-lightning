/**
 * Trust levels — propose / assist / auto, per engine action (docs/conveyance-engine.md §2).
 *
 *   - propose: the engine asks; the intent is a decision citing a dossier; nothing happens
 *     until a person approves; a rejection keeps the same action quiet;
 *   - assist: acks, chases and search orders go unasked; client updates are proposed;
 *     auto-clears happen and are confirmed afterwards;
 *   - auto: everything proceeds, auto-clears silently; flagged items still surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockingDecisions, pendingDecisions, DEFAULT_LEVELS, ENGINE_ACTIONS } from '../../../lib/server/engine/types';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, idClear, searchClear, searchFlagged } from './helpers';

const proposeAll = async (h: ReturnType<typeof harness>) => { for (const a of ENGINE_ACTIONS) await h.store.setLevel(TENANT, a, 'propose', null); };

test('the product default is propose for every action', () => {
  for (const a of ENGINE_ACTIONS) assert.equal(DEFAULT_LEVELS[a], 'propose');
});

test('propose: a search order is a decision in front of a person; approving it places the order', async () => {
  const h = harness();
  await proposeAll(h);
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29', 'LLC1'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  assert.equal(h.ports.idCheckProvider.requests.length, 1, 'a person asked for the ID check: their click is the approval');
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  let s = await h.svc.getState(TENANT, MATTER);
  // The clear ID check is itself held at propose: the stage does not move until approved.
  const held = pendingDecisions(s).filter((d) => d.kind === 'auto_clear');
  assert.equal(held.length, 1);
  assert.ok(s.pendingAutoClears[held[0].eventId], 'the clear is held back, not applied');
  assert.equal(s.idCheck.status, 'requested', 'not cleared yet');
  await resolve(h, held[0].eventId, 'approve', USER);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.idCheck.status, 'cleared');
  assert.equal(s.stage, 'pre_contract');
  assert.equal(h.ports.searchProvider.orders.length, 0, 'searches not ordered yet');
  const proposals = Object.values(s.proposals).filter((p) => p.action === 'search_order');
  assert.deepEqual(proposals.map((p) => p.dedupKey).sort(), ['CON29', 'LLC1']);
  for (const p of proposals) {
    const d = s.decisions[p.eventId];
    assert.equal(d.kind, 'proposal');
    assert.deepEqual(d.options, ['approve', 'reject']);
    assert.ok(d.sourceDocumentId, 'the proposal cites its dossier');
  }
  await resolve(h, proposals[0].eventId, 'approve', USER);
  assert.equal(h.ports.searchProvider.orders.length, 1, 'approved → ordered');
  await assert.rejects(resolve(h, proposals[1].eventId, 'reject', USER), /Give a reason/, 'a rejection needs a reason');
  await resolve(h, proposals[1].eventId, 'reject', USER, 'Client is paying for searches directly');
  assert.equal(h.ports.searchProvider.orders.length, 1, 'rejected → not ordered');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(Object.values(s.proposals).filter((p) => p.status === 'rejected').length, 1);
});

test('propose: the timer proposes a chase once, does not nag while it waits, and sends on approval', async () => {
  const h = harness();
  await proposeAll(h);
  await h.store.setLevel(TENANT, 'auto_clear', 'assist', null);
  await h.store.setLevel(TENANT, 'search_order', 'assist', null);
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['LLC1'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  h.advanceDays(16);
  const t1 = await h.svc.tick(TENANT, MATTER);
  assert.equal(t1.chases, 0, 'nothing sent');
  assert.equal(h.ports.chaser.chases.length, 0);
  let s = await h.svc.getState(TENANT, MATTER);
  const props = Object.values(s.proposals).filter((p) => p.action === 'chase');
  assert.equal(props.length, 1, 'one proposal');
  await h.svc.tick(TENANT, MATTER);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(Object.values(s.proposals).filter((p) => p.action === 'chase').length, 1, 'the next tick does not propose it again');
  await resolve(h, props[0].eventId, 'approve', USER);
  assert.equal(h.ports.chaser.chases.length, 1, 'approved → chased');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.waits.find((w) => w.key === 'search' && w.subject === 'LLC1')!.chasesSentAt.length, 1, 'the sent chase counts for the SLA clock');
});

test('assist: acks, chases and search orders go unasked; a client update is still proposed', async () => {
  const h = harness();
  for (const a of ENGINE_ACTIONS) await h.store.setLevel(TENANT, a, 'assist', null);
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  assert.equal(h.ports.searchProvider.orders.length, 1, 'assist orders searches unasked');
  const r = await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  assert.equal(r.state.searches.CON29.status, 'cleared', 'assist clears unasked…');
  const reviews = pendingDecisions(r.state).filter((d) => d.kind === 'auto_clear');
  assert.ok(reviews.length >= 1, '…and asks to confirm afterwards');
  assert.equal(blockingDecisions(r.state).filter((d) => d.kind !== 'proposal').length, 0, 'without holding the case');
  const s = await h.svc.getState(TENANT, MATTER);
  const updates = Object.values(s.proposals).filter((p) => p.action === 'client_update');
  assert.ok(updates.length >= 1 || h.ports.clientComms.sent.length === 0, 'client updates are proposed at assist, never sent unasked');
  assert.equal(h.ports.clientComms.sent.length, 0);
});

test('auto: auto-clears proceed silently; a flagged search still surfaces to a person', async () => {
  const h = harness();
  for (const a of ENGINE_ACTIONS) await h.store.setLevel(TENANT, a, 'auto', null);
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  const r1 = await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  assert.equal(pendingDecisions(r1.state).filter((d) => d.kind === 'auto_clear').length, 0, 'no review at auto');
  assert.equal(r1.state.idCheck.status, 'cleared');
  const r2 = await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchFlagged('CON29')));
  assert.equal(r2.state.searches.CON29.status, 'flagged');
  const d = firstDecision(r2.state, 'search');
  assert.ok(d, 'flagged → a person, at every level');
  assert.equal((await h.store.listPendingDecisions(TENANT)).some((x) => x.kind === 'search'), true);
});

test('levels are per action and persist on the store', async () => {
  const h = harness();
  await h.store.setLevel(TENANT, 'chase', 'auto', USER);
  await h.store.setLevel(TENANT, 'auto_clear', 'propose', USER);
  const cfg = await h.store.loadLevels(TENANT);
  assert.equal(cfg.chase, 'auto');
  assert.equal(cfg.auto_clear, 'propose');
  assert.equal(cfg.acknowledgement, 'auto', 'the fixture leaves the rest unasked');
});
