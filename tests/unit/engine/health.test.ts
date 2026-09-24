/**
 * Case health and the personal work list (docs/caseload-ux.md). The point of both is that
 * a conveyancer never grooms them: they are derived from the same state the machine
 * enforces. These tests pin the two claims the UI makes — health is about expected
 * progress, not age; and a waiting item chases itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, idClear, searchClear, offerClear, titleWithCharge } from './helpers';
import { caseHealth, rollup, summariseHealth, HEALTH_RANK } from '../../../lib/server/engine/health';
import { matterWork, buckets } from '../../../lib/server/engine/work';
import { DEFAULT_SLA } from '../../../lib/server/engine/sla';
import { TRANSACTION_PROFILES } from '../../../lib/server/engine/transactions';
import { TRANSACTION_TYPES } from '../../../lib/server/engine/types';

test('health: every transaction type says what each of its phases should take', () => {
  for (const t of TRANSACTION_TYPES) {
    const p = TRANSACTION_PROFILES[t];
    for (const stage of p.stages) {
      const n = p.expectedWorkingDays[stage];
      assert.ok(n && n > 0, `${t}: expected working days for ${stage}`);
    }
    for (const stage of Object.keys(p.expectedWorkingDays)) assert.ok(p.stages.includes(stage as never), `${t}: ${stage} is a phase it passes through`);
  }
});

test('health is expected progress, not age: a 100-day-old case whose outstanding items are all inside their SLA is normal', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  // A long instruction phase — the ID check came back on day 100.
  h.advanceDays(100);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_contract');
  const now = h.advanceDays(1);
  const health = caseHealth(s, now);
  assert.equal(health.band, 'normal', `expected normal, got ${health.band}: ${health.reasons.map((r) => r.headline).join(' | ')}`);
  assert.equal(health.reasons.length, 0);
  assert.ok(health.pace.inStage <= 2, 'the phase is what is measured, not the case');
  assert.equal(health.counts.waiting, 4, 'four searches are outstanding — and that is fine, they were ordered yesterday');
});

test('health: a case sitting in one phase with nothing outstanding becomes delayed, and says what the phase should take', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  // Nothing is owed by anyone else — so the only thing wrong is that we have not moved.
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.waits.filter((w) => !w.closedAt).length, 0);
  const now = h.advanceDays(70); // ~50 working days in pre-contract; 20 is typical
  const health = caseHealth(s, now);
  assert.equal(health.band, 'delayed');
  const r = health.reasons.find((x) => x.code === 'stage_overrun')!;
  assert.ok(r, 'the overrun is named');
  // The clean search carried it into contract review, so that is the phase being judged —
  // each phase has its own expectation (10 working days here, 20 in pre-contract).
  assert.match(r.headline, /contract review/);
  assert.match(r.why.join(' '), /10 working days/);
  assert.ok(r.suggested, 'it suggests something');
});

test('health: a wait walks attention → delayed → critical as its SLA passes, and always explains itself', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const rule = DEFAULT_SLA.search;

  // Inside the SLA: the search is simply outstanding.
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(caseHealth(s, h.ports.now()).band, 'normal');

  // Past the chase point.
  let now = h.advanceDays(Math.ceil(rule.chaseAfter * 1.4) + 1);
  s = await h.svc.getState(TENANT, MATTER);
  let health = caseHealth(s, now);
  assert.equal(health.band, 'attention');
  const chase = health.reasons.find((r) => r.code === 'chase_due')!;
  assert.match(chase.headline, /search provider is \d+ working day/);
  assert.match(chase.why.join(' '), /No chase has gone out yet/);
  assert.equal(chase.suggested, 'Chase the search provider');

  // Past the escalation point: delayed, and the timer's own chase is now on the record.
  now = h.advanceDays(14);
  await h.svc.tick(TENANT, MATTER);
  s = await h.svc.getState(TENANT, MATTER);
  health = caseHealth(s, now);
  assert.ok(['delayed', 'critical'].includes(health.band), `escalated or overdue, got ${health.band}`);
  const overdue = health.reasons.find((r) => r.code === 'wait_overdue' || r.code === 'wait_escalated')!;
  assert.match(overdue.why.join(' '), /chase(s)? sent|No chase/);

  // An unresolved escalation is critical — a person has been told and it is still open.
  s = await h.svc.getState(TENANT, MATTER);
  if (s.waits.some((w) => w.escalations.some((e) => !e.resolvedAt))) {
    assert.equal(caseHealth(s, now).band, 'critical');
  }
});

test('health: an issue holding exchange reads as blocked; a critical issue outranks it; the map line names the case, not the code', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'title_defect', title: 'Restriction in the register requires a certificate on transfer', gate: 'exchange' });
  const s = await h.svc.getState(TENANT, MATTER);
  const health = caseHealth(s, h.ports.now());
  assert.equal(health.band, 'blocked');
  const r = health.reasons[0];
  assert.match(r.headline, /^Exchange blocked — Restriction in the register/);
  assert.ok(r.why.length >= 2 && r.suggested, 'the chain and the action are there');
  assert.equal(health.counts.blockingIssues, 1);

  const summary = summariseHealth(health);
  assert.equal(summary.band, 'blocked');
  assert.equal(summary.headline, r.headline);
  assert.deepEqual(summary.why, r.why);
});

test('health: a mortgage offer about to expire is critical and outranks everything else on the case', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const expiry = new Date(h.ports.now().getTime() + 4 * 86_400_000).toISOString().slice(0, 10);
  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc({ ...offerClear(), expiryDate: expiry }));
  // An offer this close to expiry is flagged by the rules; a person looks at it and accepts it.
  let s = await h.svc.getState(TENANT, MATTER);
  await resolve(h, firstDecision(s, 'mortgage').eventId, 'approve', USER, 'expiry noted — pushing for exchange');
  s = await h.svc.getState(TENANT, MATTER);
  const health = caseHealth(s, h.ports.now());
  assert.equal(health.band, 'critical');
  assert.equal(health.reasons[0].code, 'deadline_near');
  assert.match(health.reasons[0].headline, /Mortgage offer expires in/);
  assert.match(health.reasons[0].suggested ?? '', /extend|re-issue|Exchange/i);
  assert.ok(HEALTH_RANK.critical > HEALTH_RANK.blocked, 'critical is the top of the pile');
});

test('health: a matter that is abandoned or closed says so instead of showing red for the rest of time', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'chain_dependency', title: 'Chain collapsed above us', gate: 'exchange' });
  await h.svc.run(TENANT, MATTER, { type: 'abandon_matter', actor: USER, reason: 'chain_collapsed', detail: 'Buyer above pulled out' });
  const s = await h.svc.getState(TENANT, MATTER);
  const health = caseHealth(s, h.advanceDays(60));
  assert.equal(health.band, 'blocked');
  assert.equal(health.reasons.length, 1);
  assert.match(health.reasons[0].headline, /Abortive — chain collapsed/);
});

test('rollup: the oversight strip counts what a team lead actually asks for', () => {
  const r = rollup(['normal', 'normal', 'attention', 'delayed', 'blocked', 'critical', 'normal']);
  assert.equal(r.total, 7);
  assert.equal(r.normal, 3);
  assert.equal(r.attention, 1);
  assert.equal(r.stuck, 2, 'delayed + blocked');
  assert.equal(r.critical, 1);
  assert.equal(r.needsSomeone, 4);
});

test('work: a wait is WAITING with a countdown, becomes CHASE when the clock runs out, and never loses its owner', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const ctx = { matterRef: 'OAK-14', propertyAddress: '14 Oak Street', assignedTo: USER };

  let s = await h.svc.getState(TENANT, MATTER);
  let w = buckets(matterWork(s, h.ports.now(), ctx).items);
  const search = w.waiting.find((i) => i.ref.id === 'search:CON29')!;
  assert.ok(search, 'the outstanding search is a WAITING item');
  assert.equal(search.actionOwner, 'search_provider', 'who has to act');
  assert.equal(search.responsibilityOwner, USER, 'who is accountable for it happening');
  assert.equal(search.slaWorkingDays, DEFAULT_SLA.search.chaseAfter);
  assert.ok((search.chaseInWorkingDays ?? 0) > 0, 'a countdown, not a reminder someone has to set');
  assert.equal(search.chasesSent, 0);
  assert.equal(search.chaseDue, false);
  assert.ok(search.dueBy, 'it says by when we expect them');
  assert.equal(search.urgency, 'normal');

  // The clock expires: nobody moved it — it moved itself. Still WAITING, flagged for the sweep.
  const now = h.advanceDays(Math.ceil(DEFAULT_SLA.search.chaseAfter * 1.4) + 1);
  s = await h.svc.getState(TENANT, MATTER);
  w = buckets(matterWork(s, now, ctx).items);
  const due = w.waiting.find((i) => i.ref.id === 'search:CON29')!;
  assert.ok(due, 'it stays a WAITING item');
  assert.equal(due.chaseDue, true, 'the next sweep sends the chase');
  assert.ok((due.chaseInWorkingDays ?? 1) <= 0);
  assert.equal(due.mode, 'automatic', 'the engine sends it; a person does not have to remember');
  assert.equal(due.urgency, 'attention');
  assert.equal(due.responsibilityOwner, USER);

  // After the chase goes out it is WAITING again, with the count on it and a notch more serious.
  await h.svc.tick(TENANT, MATTER);
  s = await h.svc.getState(TENANT, MATTER);
  w = buckets(matterWork(s, now, ctx).items);
  const again = w.waiting.find((i) => i.ref.id === 'search:CON29')!;
  assert.equal(again.chasesSent, 1);
  assert.equal(again.chaseDue, false);
  assert.equal(again.urgency, 'attention');
  assert.ok(again.dueBy && again.dueBy > (search.dueBy ?? ''), 'the date moves on to the chase cadence');
  assert.ok(again.escalatesInWorkingDays != null);
});

test('work: a decision is a DO for a person, a hard stop is critical, and a shadow matter asks before chasing', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleWithCharge()));
  let s = await h.svc.getState(TENANT, MATTER);
  const cfg = await h.store.loadSubflows(TENANT);
  let items = matterWork(s, h.ports.now(), { assignedTo: USER, subflows: cfg }).items;
  const decide = items.find((i) => i.bucket === 'do' && i.ref.type === 'decision')!;
  assert.ok(decide, 'the flagged title is something a person must do');
  assert.equal(decide.actionOwner, 'conveyancer');
  assert.match(decide.what, /^Decide: the title/);

  // A bank-details change is the hard stop: top of the DO list, and it says why.
  const rec = await h.svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind: 'seller_solicitor', payeeRef: 'Smith & Co', details: { sortCode: '401234', accountNumber: '11112222', accountName: 'Smith & Co Client Account', firmName: 'Smith & Co' }, sourceChannel: 'email', sourceDocumentId: h.doc({ content: 'email' }) });
  assert.ok(rec.events.length);
  s = await h.svc.getState(TENANT, MATTER);
  items = matterWork(s, h.ports.now(), { assignedTo: USER, subflows: cfg }).items;
  const stop = items.find((i) => i.what.startsWith('Verify bank details'))!;
  assert.ok(stop, 'the hard stop is on the list');
  assert.equal(stop.urgency, 'critical');
  assert.match(stop.unblocks ?? '', /payment/i);

  // Resolving it takes it off the list — nothing to tidy up by hand.
  const d = firstDecision(s, 'bank_details');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'verify', 'called back', { method: 'phone_callback_known_number' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(matterWork(s, h.ports.now(), { assignedTo: USER, subflows: cfg }).items.some((i) => i.what.startsWith('Verify bank details')), false);

  // Shadow mode: the chase is listed but needs a person, because nothing is sent.
  await h.svc.setShadowMode(TENANT, MATTER, USER, true, 'observing');
  const now = h.advanceDays(Math.ceil(DEFAULT_SLA.search.chaseAfter * 1.4) + 1);
  s = await h.svc.getState(TENANT, MATTER);
  const shadow = matterWork(s, now, { assignedTo: USER, subflows: cfg }).items.find((i) => i.ref.id === 'search:CON29')!;
  assert.equal(shadow.mode, 'needs_approval');
});

test('work: a closed or abandoned matter produces no work at all', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.run(TENANT, MATTER, { type: 'abandon_matter', actor: USER, reason: 'client_withdrew' });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.deepEqual(matterWork(s, h.ports.now(), { assignedTo: USER }).items, []);
});

test('caseload: the queue row carries the health band, the coarse lifecycle and the day of the case', async () => {
  const h = harness();
  h.store.matterMeta.set(`${TENANT}:${MATTER}`, { matterRef: 'OAK-14', propertyAddress: '14 Oak Street', assignedTo: USER });
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'title_defect', title: 'Restriction on the title', gate: 'exchange' });
  const rows = await h.store.listQueue(TENANT, {});
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.health.band, 'blocked');
  assert.match(row.health.headline ?? '', /Exchange blocked/);
  assert.equal(row.lifecycle, 'pre_exchange');
  assert.ok(row.dayOfCase >= 0);
  assert.equal(row.transactionType, 'freehold_purchase');
  // …and a matter that has finished drops off the caseload unless asked for.
  await h.svc.run(TENANT, MATTER, { type: 'abandon_matter', actor: USER, reason: 'client_withdrew' });
  assert.equal((await h.store.listQueue(TENANT, {})).length, 0);
  assert.equal((await h.store.listQueue(TENANT, { includeFinished: true })).length, 1);
  assert.equal((await h.store.listStates(TENANT, { includeFinished: true })).length, 1);
});
