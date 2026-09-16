/**
 * Addendum 3 §2 — shadow-mode rollout and per-sub-flow trust levels.
 *
 *   - shadow matter: events are logged, nothing surfaces, nothing is sent/ordered,
 *     every intent is an action_suppressed event, the human record is untouched;
 *   - shadow sub-flow: the same, for that sub-flow only;
 *   - assist: auto-clears surface as an advisory review; autonomous: they do not;
 *   - the queue shows one row per matter with the right pending count and sort.
 *
 * Addendum 3 §1 — effects and timers run inside ports.asAutomation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockingDecisions, pendingDecisions } from '../../../lib/server/engine/types';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, SENIOR, idClear, searchClear, searchFlagged } from './helpers';

const OTHER = '55555555-5555-4555-8555-555555555555';

test('shadow matter: engine concludes, nothing surfaces, nothing is sent — every intent is logged as action_suppressed', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29', 'LLC1'], shadowMode: true });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  assert.equal(h.ports.idCheckProvider.requests.length, 0, 'ID check not requested from the provider');
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const s1 = await h.svc.getState(TENANT, MATTER);
  assert.equal(s1.stage, 'pre_contract', 'the engine still moves its OWN stage (its conclusion)');
  assert.equal(h.ports.searchProvider.orders.length, 0, 'no search ordered');
  assert.equal(h.ports.clientComms.sent.length, 0, 'no client update sent');
  const suppressed = h.store.dump(TENANT, MATTER).filter((e) => e.type === 'action_suppressed');
  assert.deepEqual(
    suppressed.map((e) => [(e.payload as { action: string }).action, (e.payload as { reason: string }).reason]),
    [
      ['id_check_request', 'shadow_mode'],
      ['search_order', 'shadow_mode'],
      ['search_order', 'shadow_mode'],
    ]
  );
  assert.ok(suppressed.every((e) => e.actor === 'system'));

  // A flagged search still becomes a decision in the log — but it is never listed and cannot be actioned.
  await h.svc.run(TENANT, MATTER, { type: 'record_search_ordered', actor: USER, searchType: 'CON29', provider: 'manual' });
  const r = await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchFlagged('CON29')));
  assert.equal(r.state.searches.CON29.status, 'flagged');
  assert.equal(pendingDecisions(r.state).length >= 1, true, 'decision exists in the log');
  assert.equal((await h.store.listPendingDecisions(TENANT)).length, 0, 'nothing surfaced to a person');
  assert.equal((await h.store.listPendingDecisions(TENANT, { includeShadow: true })).length >= 1, true, 'the comparison view can still see it');
  const d = firstDecision(r.state);
  await assert.rejects(h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER), /shadow mode/);
  await assert.rejects(h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve'), /shadow mode/);
  assert.equal((await h.store.listQueue(TENANT)).length, 0, 'shadow matters are off the queue');
  assert.equal((await h.store.listQueue(TENANT, { includeShadow: true })).length, 1);
});

test('shadow matter: timer chases are suppressed (intent logged, SLA clock still advances) and escalations stay in the log', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['LLC1'], shadowMode: true });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  // Record the search as ordered by hand (the automatic order was suppressed) so the wait opens.
  await h.svc.run(TENANT, MATTER, { type: 'record_search_ordered', actor: USER, searchType: 'LLC1', provider: 'manual' });
  h.advanceDays(16); // ≥ 10 working days
  const t1 = await h.svc.tick(TENANT, MATTER);
  assert.equal(t1.chases, 1);
  assert.equal(h.ports.chaser.chases.length, 0, 'no chase actually sent');
  const s = await h.svc.getState(TENANT, MATTER);
  const wait = s.waits.find((w) => w.key === 'search' && w.subject === 'LLC1')!;
  assert.equal(wait.chasesSentAt.length, 1, 'the suppressed chase counts as the attempt, so the clock keeps going');
  assert.equal(h.store.dump(TENANT, MATTER).filter((e) => e.type === 'action_suppressed' && (e.payload as { action: string }).action === 'chase').length, 1);
  h.advanceDays(14); // ≥ 18 working days
  const t2 = await h.svc.tick(TENANT, MATTER);
  assert.equal(t2.escalations, 1, 'the escalation decision is created (logged)');
  assert.equal((await h.store.listPendingDecisions(TENANT)).length, 0, 'but not surfaced');
});

test('switching shadow mode off is a logged, people-only event; the matter then behaves normally', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], shadowMode: true });
  await assert.rejects(h.svc.setShadowMode(TENANT, MATTER, 'system', false), /person/);
  await assert.rejects(h.svc.setShadowMode(TENANT, MATTER, USER, true), /already on/);
  const r = await h.svc.setShadowMode(TENANT, MATTER, USER, false, 'Pilot complete for this handler');
  assert.equal(r.events[0].type, 'shadow_mode_changed');
  assert.equal(r.events[0].actor, USER);
  assert.equal(r.state.shadowMode, false);
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  assert.equal(h.ports.idCheckProvider.requests.length, 1, 'now the provider is really asked');
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  assert.equal(h.ports.searchProvider.orders.length, 1, 'and searches are really ordered');
  assert.equal((await h.store.listQueue(TENANT)).length, 1);
});

test('sub-flow shadow: only that sub-flow is suppressed/hidden; assist surfaces auto-clear reviews; autonomous does not', async () => {
  const h = harness();
  await h.store.setSubflowStatus(TENANT, 'search', 'shadow', USER);
  await h.store.setSubflowStatus(TENANT, 'id_check', 'autonomous', USER);
  assert.deepEqual(await h.store.loadSubflows(TENANT), { id_check: 'autonomous', search: 'shadow', enquiry: 'assist', mortgage: 'assist', title: 'assist', report_on_title: 'assist', chase: 'assist' });

  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  assert.equal(h.ports.idCheckProvider.requests.length, 1, 'id_check is autonomous: really requested');
  const r1 = await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  assert.equal(pendingDecisions(r1.state).filter((d) => d.kind === 'auto_clear').length, 0, 'autonomous: the clear ID check raises no review');
  assert.equal(h.ports.searchProvider.orders.length, 0, 'search sub-flow is shadow: order suppressed');
  const sup = h.store.dump(TENANT, MATTER).filter((e) => e.type === 'action_suppressed');
  assert.deepEqual(sup.map((e) => [(e.payload as { action: string }).action, (e.payload as { reason: string }).reason]), [['search_order', 'subflow_shadow']]);
  assert.ok(sup.every((e) => (e.payload as { subFlow: string }).subFlow === 'search'));

  // A flagged search: decision in the log, hidden from people, cannot be actioned.
  await h.svc.run(TENANT, MATTER, { type: 'record_search_ordered', actor: USER, searchType: 'CON29', provider: 'manual' });
  const r2 = await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchFlagged('CON29')));
  const d = firstDecision(r2.state, 'search');
  assert.equal((await h.store.listPendingDecisions(TENANT)).filter((x) => x.kind === 'search').length, 0);
  await assert.rejects(h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER), /search sub-flow is in shadow/);
  const q = await h.store.listQueue(TENANT);
  assert.equal(q.length, 1);
  assert.equal(q[0].pendingCount, 0, 'the hidden search decision does not count');

  // Promote search to assist: the same decision is now surfaced and actionable, and a clear search raises a review.
  await h.store.setSubflowStatus(TENANT, 'search', 'assist', USER);
  assert.equal((await h.store.listPendingDecisions(TENANT)).filter((x) => x.kind === 'search').length, 1);
  assert.equal((await h.store.listQueue(TENANT))[0].pendingCount, 1);
  await resolve(h, d.eventId, 'approve', USER);
  assert.equal((await h.svc.getState(TENANT, MATTER)).searches.CON29.status, 'reviewed');
});

test('assist-level auto-clear review: advisory, non-blocking, confirm or escalate (escalation becomes a real decision)', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const r = await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  assert.equal(r.state.searches.CON29.status, 'cleared');
  assert.equal(r.state.stage, 'contract_review', 'the auto-clear review does not block the stage');
  const reviews = pendingDecisions(r.state).filter((d) => d.kind === 'auto_clear');
  assert.equal(reviews.length, 2, 'ID check + CON29');
  assert.equal(blockingDecisions(r.state).length, 0);
  const rv = reviews.find((d) => d.subject === 'search:CON29')!;
  assert.deepEqual(rv.options, ['approve', 'escalate']);
  assert.ok(rv.sourceDocumentId, 'the review cites the search PDF');
  const ok = await resolve(h, rv.eventId, 'approve', USER);
  assert.equal(ok.events[0].type, 'auto_clear_confirmed');
  assert.equal(ok.state.searches.CON29.status, 'cleared', 'confirming changes nothing');

  const idr = reviews.find((d) => d.subject?.startsWith('id_check:'))!;
  assert.ok(idr, `id check review present (subjects: ${reviews.map((d) => d.subject).join(', ')})`);
  const esc = await resolve(h, idr.eventId, 'escalate', USER, 'Name on passport differs from instruction letter');
  assert.deepEqual(esc.events.map((e) => e.type), ['auto_clear_confirmed', 'escalation_raised'], 'the review closes and a real decision is queued for a senior');
  const senior = firstDecision(esc.state, 'escalation');
  assert.equal(senior.sourceDocumentId, idr.sourceDocumentId, 'the senior sees the same source');
  await assert.rejects(resolve(h, senior.eventId, 'refer_to_client', SENIOR), /Give a reason/, 'a non-approve action without a reason is refused');
});

test('queue: one row per assigned matter, pending badge counts only surfaced blocking decisions, sortable by oldest pending or target completion', async () => {
  const h = harness();
  h.store.matterMeta.set(`${TENANT}:${MATTER}`, { matterRef: 'M-1', propertyAddress: '1 High St', assignedTo: USER });
  h.store.matterMeta.set(`${TENANT}:${OTHER}`, { matterRef: 'M-2', propertyAddress: '2 Low Rd', assignedTo: USER });
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], targetCompletionDate: '2026-12-18' });
  await h.svc.run(TENANT, OTHER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], targetCompletionDate: '2026-11-06' });
  for (const m of [MATTER, OTHER]) {
    await h.svc.requestIdCheck(TENANT, m, USER);
    await h.svc.idCheckResultReceived(TENANT, m, h.ports.documents.seed({ tenantId: TENANT, matterId: m, docType: 'PDF', extractedFacts: idClear() }).id);
  }
  h.advanceDays(1);
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchFlagged('CON29')));
  const q = await h.store.listQueue(TENANT, { assignedTo: USER });
  assert.deepEqual(q.map((r) => [r.matterRef, r.pendingCount, r.reviewCount, r.stage]), [
    ['M-1', 1, 1, 'pre_contract'],
    ['M-2', 0, 1, 'pre_contract'],
  ]);
  assert.ok(q[0].oldestPendingAt);
  const byTarget = await h.store.listQueue(TENANT, { assignedTo: USER, sort: 'target_completion' });
  assert.deepEqual(byTarget.map((r) => r.matterRef), ['M-2', 'M-1']);
  assert.equal((await h.store.listQueue(TENANT, { assignedTo: SENIOR })).length, 0, 'not the senior\'s matters');
  assert.equal((await h.store.listQueue(TENANT)).length, 2, 'no filter → every enrolled matter');
});

test('§1: post-commit effects and the timer sweep run inside ports.asAutomation', async () => {
  const h = harness();
  const calls: string[] = [];
  let depth = 0;
  h.ports.asAutomation = async (fn) => {
    depth += 1;
    calls.push('enter');
    try {
      return await fn();
    } finally {
      depth -= 1;
    }
  };
  const orig = h.ports.searchProvider.orderSearch.bind(h.ports.searchProvider);
  h.ports.searchProvider.orderSearch = async (input) => {
    assert.ok(depth > 0, 'search order placed from inside the automation context');
    return orig(input);
  };
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  assert.equal(h.ports.searchProvider.orders.length, 1);
  assert.ok(calls.length >= 3, 'every command\'s effects were wrapped');
  h.ports.chaser.sendChase = async () => {
    assert.ok(depth > 0, 'chase sent from inside the automation context');
    return { channel: 'mock', messageId: 'x' };
  };
  h.advanceDays(16);
  const t = await h.svc.tick(TENANT, MATTER);
  assert.equal(t.chases, 1);
});
