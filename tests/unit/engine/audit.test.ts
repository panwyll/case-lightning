import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, eventHash, verifyChain, buildAuditReport, auditCsv } from '../../../lib/server/engine/audit';
import type { EngineEvent } from '../../../lib/server/engine/types';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, idClear, searchFlagged } from './helpers';

test('canonicalJson is key-order independent and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}]},"b":1}');
});

test('hash chain: every append links to the previous hash; verification is deterministic', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const r = await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchFlagged('CON29')));
  await resolve(h, firstDecision(r.state).eventId, 'approve');
  const log = h.store.dump(TENANT, MATTER);
  assert.ok(log.length > 8);
  assert.equal(log[0].prevHash, '');
  for (let i = 1; i < log.length; i++) assert.equal(log[i].prevHash, log[i - 1].hash);
  for (const e of log) assert.equal(e.hash, eventHash(e.prevHash ?? '', e));
  assert.deepEqual(verifyChain(log), { ok: true, events: log.length, brokenAtSeq: null, reason: null });
});

test('tampering is detected: altered content, removed event, reordered events, spliced-in event', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const log = h.store.dump(TENANT, MATTER);
  const clone = (): EngineEvent[] => JSON.parse(JSON.stringify(log));

  const altered = clone();
  (altered[2].payload as { provider: string }).provider = 'someone-else';
  assert.equal(verifyChain(altered).brokenAtSeq, 3);
  assert.match(verifyChain(altered).reason ?? '', /altered/);

  const actorSwap = clone();
  actorSwap[1].actor = 'system'; // "the system did it, not me"
  assert.equal(verifyChain(actorSwap).brokenAtSeq, 2);

  const removed = clone().filter((e) => e.seq !== 3).map((e, i) => ({ ...e, seq: i + 1 }));
  assert.equal(verifyChain(removed).ok, false);

  const reordered = clone();
  [reordered[3], reordered[4]] = [reordered[4], reordered[3]];
  assert.equal(verifyChain(reordered).ok, false);

  const spliced = clone();
  spliced.splice(2, 0, { ...spliced[2], id: 'x', type: 'deposit_received', payload: { amountPennies: 1 } });
  spliced.forEach((e, i) => (e.seq = i + 1));
  assert.equal(verifyChain(spliced).ok, false);

  assert.deepEqual(verifyChain([]), { ok: true, events: 0, brokenAtSeq: null, reason: null });
});

test('audit report: replay vs read model, summary counts, CSV export', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const r = await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchFlagged('CON29')));
  await resolve(h, firstDecision(r.state).eventId, 'approve', USER, 'ok');
  const log = h.store.dump(TENANT, MATTER);
  const cached = await h.store.cachedState(TENANT, MATTER);
  const report = buildAuditReport(TENANT, MATTER, log, cached, new Date('2026-09-15T00:00:00Z'));
  assert.equal(report.chain.ok, true);
  assert.equal(report.replay.ok, true);
  assert.equal(report.summary.decisions, 2, 'the flagged search plus the assist-level review of the clear ID check');
  assert.equal(report.summary.autoClearReviews, 1);
  assert.equal(report.summary.decisionsResolvedWithoutOpeningSource, 0);
  assert.equal(report.summary.aiSentWithoutApproval, 0);
  assert.ok(report.summary.byActorKind.user >= 3);
  assert.ok(report.summary.byActorKind.system >= 3);
  assert.equal(report.summary.byActorKind.ai, 2, 'search_flagged plus the auto_clear_review_raised for the ID check');
  // a drifted read model is caught
  const drifted = JSON.parse(JSON.stringify(cached));
  drifted.stage = 'completed';
  assert.equal(buildAuditReport(TENANT, MATTER, log, drifted).replay.ok, false);
  const csv = auditCsv(report);
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /^# matter .* chain OK · replay OK · head [0-9a-f]{64}$/);
  assert.equal(lines[1], 'seq,created_at,type,actor,actor_kind,source_document_id,confidence,decision_kind,decision_status,prev_hash,hash,payload');
  assert.equal(lines.length, 2 + log.length);
  assert.match(lines[2], /^1,2026-09-14T09:00:00.000Z,matter_created,33333333-3333-4333-8333-333333333333,user,,,,,,[0-9a-f]{64},/);
  assert.ok(lines.some((l) => /search_flagged,ai,ai,doc-2,0\.93,search,actioned/.test(l)));
});
