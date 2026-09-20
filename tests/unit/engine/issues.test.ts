/**
 * Issues (docs/engine-issues.md): the things that go wrong on a real purchase and change
 * what the matter needs before it can move — survey findings, down-valuations, missing
 * building regs, chains, probate, gifted deposits, completion-day failures. Each test is a
 * scenario lifted from what buyers and conveyancers report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageBlockers } from '../../../lib/server/engine/machine';
import { deadlineActions } from '../../../lib/server/engine/sla';
import { ISSUE_KIND_SPECS, ISSUE_KINDS, ISSUE_RESOLUTIONS, ISSUE_KIND_SPEC } from '../../../lib/server/engine/issues';
import { openIssues, pendingDecisions } from '../../../lib/server/engine/types';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, idClear, searchClear, searchFlagged, offerClear, titleClear } from './helpers';

/** Drive a matter to pre_exchange with everything cleared (lender-funded by default). */
async function toPreExchange(h: ReturnType<typeof harness>, opts: { hasLender?: boolean } = {}) {
  const hasLender = opts.hasLender ?? true;
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender, requiredSearches: ['CON29'], targetExchangeDate: '2026-11-20', targetCompletionDate: '2026-12-11' });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  if (hasLender) {
    await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc({ ...offerClear(), expiryDate: '2027-03-01' }));
    const md = pendingDecisions(await h.svc.getState(TENANT, MATTER)).find((d) => d.kind === 'mortgage');
    if (md) await resolve(h, md.eventId, 'approve', USER, 'Offer period comfortably covers the planned exchange');
  }
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  await h.svc.draftReportOnTitle(TENANT, MATTER);
  const rot = firstDecision(await h.svc.getState(TENANT, MATTER), 'report_on_title');
  await resolve(h, rot.eventId, 'approve');
  await h.svc.sendReportOnTitle(TENANT, MATTER, USER);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_exchange');
  return s;
}

test('catalogue: every kind has a spec with realistic resolutions drawn from the shared list; the machine\'s gates are one of the three', () => {
  assert.deepEqual(ISSUE_KIND_SPECS.map((k) => k.kind).sort(), [...ISSUE_KINDS].sort());
  for (const k of ISSUE_KIND_SPECS) {
    assert.ok(k.resolutions.length > 0, `${k.kind} has resolutions`);
    for (const r of k.resolutions) assert.ok(ISSUE_RESOLUTIONS.includes(r), `${k.kind}: ${r} is a known resolution`);
    assert.ok(['exchange', 'completion', 'none'].includes(k.gate));
    assert.ok(k.label && k.arisesFrom, `${k.kind} is documented`);
  }
  assert.ok(ISSUE_KIND_SPEC.survey_defect.resolutions.includes('price_reduced'));
  assert.ok(!ISSUE_KIND_SPEC.chain_dependency.resolutions.includes('price_reduced'), 'a chain is not fixed by a price cut');
});

test('survey defect → renegotiation: the issue holds exchange, a price reduction records price_changed and tells the lender; lender confirmation releases exchange', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: true, requiredSearches: ['CON29'] });
  await h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 32_500_000, reason: 'Agreed price per memorandum of sale' });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.purchasePricePennies, 32_500_000);
  assert.equal(openIssues(s).length, 0, 'the first recorded price is the agreed price, not a change the lender needs telling about');
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  // The survey lands in pre_contract: damp and a roof that needs work.
  const raised = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'survey_defect', title: 'Level 2 survey: rising damp to rear addition, roof covering at end of life', detail: 'Surveyor estimates £8–12k', documentId: h.doc(idClear()) });
  assert.equal(raised.events[0].type, 'issue_raised');
  const issueId = (raised.events[0].payload as { issueId: string }).issueId;
  assert.equal(issueId, 'ISS-1');
  s = raised.state;
  assert.equal(s.issues[issueId].gate, 'exchange');
  assert.equal(s.issues[issueId].status, 'open');
  // Everything but exchange proceeds: searches, offer, title, report all go through.
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc({ ...offerClear(), expiryDate: '2027-03-01' }));
  const md = pendingDecisions(await h.svc.getState(TENANT, MATTER)).find((d) => d.kind === 'mortgage');
  if (md) await resolve(h, md.eventId, 'approve', USER, 'ok');
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'contract_review', 'an open survey issue does not hold pre_contract');
  await h.svc.draftReportOnTitle(TENANT, MATTER);
  await resolve(h, firstDecision(await h.svc.getState(TENANT, MATTER), 'report_on_title').eventId, 'approve');
  await h.svc.sendReportOnTitle(TENANT, MATTER, USER);
  await h.svc.run(TENANT, MATTER, { type: 'update_issue', actor: USER, issueId, status: 'negotiating', note: 'Client asked for £10k off; agent relaying to the seller' });
  const dep = await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  s = dep.state;
  assert.equal(s.stage, 'pre_exchange');
  assert.equal(s.exchange.conditionsMet, false, 'exchange conditions are not derived while an issue holds exchange');
  assert.ok(stageBlockers(s).some((b) => b.startsWith('issue: Survey defect')), stageBlockers(s).join(' | '));
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' }), /Cannot exchange while an issue is open: Survey defect/);
  // Wrong resolution for the kind, and a reduction without the new price, are refused.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId, resolution: 'grant_obtained' }), /not resolved by/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId, resolution: 'price_reduced' }), /new agreed price/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId, resolution: 'price_reduced', newPricePennies: 33_000_000 }), /below the current price/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: 'system', issueId, resolution: 'price_reduced', newPricePennies: 31_500_000 }), /people/);
  const res = await h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId, resolution: 'price_reduced', newPricePennies: 31_500_000, note: 'Seller agreed £10k off' });
  assert.deepEqual(res.events.map((e) => e.type).slice(0, 3), ['issue_resolved', 'price_changed', 'issue_raised']);
  s = res.state;
  assert.equal(s.issues[issueId].status, 'resolved');
  assert.equal(s.issues[issueId].resolution, 'price_reduced');
  assert.equal(s.purchasePricePennies, 31_500_000);
  const lender = openIssues(s)[0];
  assert.equal(lender.kind, 'lender_approval');
  assert.equal(lender.raisedBy, 'system');
  assert.deepEqual(lender.origin, { issueId, resolution: 'price_reduced' });
  assert.equal(s.exchange.conditionsMet, false, 'the lender has to confirm the offer stands before exchange');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' }), /Lender approval needed/);
  const ok = await h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: lender.id, resolution: 'lender_confirmed', note: 'Revised offer at the lower price received' });
  assert.ok(ok.events.some((e) => e.type === 'exchange_conditions_met'), 'exchange conditions derive as soon as the last hold is released');
  assert.ok(ok.events.find((e) => e.type === 'exchange_conditions_met' && (e.payload as { conditions: string[] }).conditions.includes('no open issue holding exchange')));
  const ex = await h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' });
  assert.equal(ex.state.stage, 'exchanged');
});

test('down-valuation → new lender: resolving with new_lender reopens the mortgage sub-flow; buyer covering the shortfall does not', async () => {
  const h = harness();
  await toPreExchange(h);
  const r = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'valuation_issue', title: 'Lender valued at £300k against £325k agreed' });
  const id = (r.events[0].payload as { issueId: string }).issueId;
  const res = await h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: id, resolution: 'new_lender', note: 'Broker moving the application to a lender whose panel valuer will revisit' });
  assert.deepEqual(res.events.map((e) => e.type), ['issue_resolved', 'mortgage_offer_withdrawn']);
  assert.equal(res.state.mortgage.status, 'awaiting');
  assert.ok(stageBlockers(res.state).some((b) => b.startsWith('mortgage offer awaiting')));
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' }), /mortgage offer is awaiting/);
  // The new lender's offer is judged afresh, and exchange is open again.
  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc({ ...offerClear(), lender: 'Other Building Society', expiryDate: '2027-04-01' }));
  const s = await h.svc.getState(TENANT, MATTER);
  assert.ok(['cleared', 'reviewed', 'flagged'].includes(s.mortgage.status));

  // Alternative path on a fresh matter: the buyer makes up the shortfall — no lender effect, no price change.
  const h2 = harness();
  await toPreExchange(h2);
  const r2 = await h2.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'valuation_issue', title: 'Down-valued by £15k' });
  const res2 = await h2.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: (r2.events[0].payload as { issueId: string }).issueId, resolution: 'buyer_covers_shortfall', note: 'Client topping up the deposit from savings' });
  assert.deepEqual(res2.events.map((e) => e.type), ['issue_resolved']);
  assert.equal(openIssues(res2.state).length, 0);
});

test('missing building regs → indemnity: on a lender-funded purchase the lender must approve the policy (an issue is raised); on a cash purchase nothing else is needed', async () => {
  const h = harness();
  await toPreExchange(h);
  const r = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'building_regs_missing', title: 'Loft conversion 2016, no completion certificate' });
  const id = (r.events[0].payload as { issueId: string }).issueId;
  const res = await h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: id, resolution: 'indemnity_policy', note: 'Seller paying for a £180 policy' });
  assert.deepEqual(res.events.map((e) => e.type), ['issue_resolved', 'issue_raised']);
  assert.equal(openIssues(res.state)[0].kind, 'lender_approval');
  assert.match(openIssues(res.state)[0].title, /indemnity policy obtained/);

  const cash = harness();
  await toPreExchange(cash, { hasLender: false });
  const r2 = await cash.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'building_regs_missing', title: 'Rear extension, no sign-off' });
  const res2 = await cash.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: (r2.events[0].payload as { issueId: string }).issueId, resolution: 'indemnity_policy' });
  assert.deepEqual(res2.events.map((e) => e.type), ['issue_resolved'], 'no lender to tell');
});

test('indemnity as a decision option: choosing it on a flagged search on a lender-funded purchase raises the lender-approval issue automatically', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: true, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchFlagged('CON29')));
  const d = firstDecision(await h.svc.getState(TENANT, MATTER), 'search');
  await resolve(h, d.eventId, 'indemnity', USER, 'Cheaper than chasing the council for a 20-year-old notice');
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.searches.CON29.status, 'reviewed');
  const li = openIssues(s);
  assert.equal(li.length, 1);
  assert.equal(li[0].kind, 'lender_approval');
  assert.match(li[0].title, /indemnity policy proposed for search CON29/);
  assert.equal(li[0].sourceDocumentId, d.sourceDocumentId, 'the lender issue cites the search the policy covers');
});

test('chain not ready: holds exchange while the deposit is in; a person may release the hold with a note; withdrawn issues stop holding', async () => {
  const h = harness();
  await toPreExchange(h);
  await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.exchange.conditionsMet, true);
  const r = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'chain_dependency', title: 'Seller\'s onward purchase: management pack still outstanding' });
  const id = (r.events[0].payload as { issueId: string }).issueId;
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' }), /Chain dependency/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'update_issue', actor: USER, issueId: id, status: 'open', gate: 'none' }), /needs a note/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'update_issue', actor: USER, issueId: id, status: 'open' }), /Nothing to update/);
  const rel = await h.svc.run(TENANT, MATTER, { type: 'update_issue', actor: USER, issueId: id, status: 'open', gate: 'none', note: 'Client instructs us to exchange regardless; advised in writing of the risk of a broken chain on completion' });
  s = rel.state;
  assert.equal(s.issues[id].gate, 'none');
  assert.equal(s.issues[id].status, 'open', 'still open, just not holding anything');
  assert.ok(!stageBlockers(s).some((b) => b.startsWith('issue:')));
  await h.svc.run(TENANT, MATTER, { type: 'withdraw_issue', actor: USER, issueId: id, reason: 'Pack arrived; chain confirmed ready by both agents' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.issues[id].status, 'withdrawn');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: id, resolution: 'chain_ready' }), /already withdrawn/);
  const ex = await h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' });
  assert.equal(ex.state.stage, 'exchanged');
});

test('fatal issue: the chain collapses on exchange day — one command ends the issue and abandons the matter with the reason derived from the kind', async () => {
  const h = harness();
  await toPreExchange(h);
  const r = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'chain_dependency', title: 'Bottom of the chain: their buyer pulled out' });
  const id = (r.events[0].payload as { issueId: string }).issueId;
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'mark_issue_fatal', actor: 'system', issueId: id, reason: 'x' }), /person/);
  const f = await h.svc.run(TENANT, MATTER, { type: 'mark_issue_fatal', actor: USER, issueId: id, reason: 'Seller cannot proceed without their onward purchase; client will not wait' });
  assert.deepEqual(f.events.map((e) => e.type), ['issue_fatal', 'matter_abandoned']);
  assert.equal(f.state.issues[id].status, 'fatal');
  assert.equal(f.state.abandoned?.reason, 'chain_collapsed');
  assert.match(f.state.abandoned?.detail ?? '', /Chain dependency: Bottom of the chain/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'other', title: 'x' }), /abandoned/);
});

test('after exchange: an issue defaults to holding completion (exchange is history); completion cannot be confirmed while it holds; completed_late resolves it', async () => {
  const h = harness();
  await toPreExchange(h);
  await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' });
  await h.svc.run(TENANT, MATTER, { type: 'completion_statement_generated', actor: USER });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_completion');
  const r = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'completion_failure', title: 'Lender funds not released by 3pm; CHAPS cut-off missed' });
  const id = (r.events[0].payload as { issueId: string }).issueId;
  assert.equal(r.state.issues[id].gate, 'completion');
  const r2 = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'completion_funds_shortfall', title: 'Client balance £2,400 short' });
  assert.equal(r2.state.issues[(r2.events[0].payload as { issueId: string }).issueId].gate, 'completion', 'an exchange-gated kind raised after exchange holds completion instead');
  s = r2.state;
  assert.equal(stageBlockers(s).filter((b) => b.startsWith('issue:')).length, 2);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /Cannot confirm completion while an issue holds it: Completion failure/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: id, resolution: 'price_reduced', newPricePennies: 1 }), /not resolved by/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 1, reason: 'x' }), /contractual/);
  const res = await h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: id, resolution: 'completed_late', note: 'Completed the next working day; late-completion interest claimed by the seller' });
  assert.equal(res.state.issues[id].status, 'resolved');
});

test('stale issue timer: an issue nobody touches for 10 working days is raised once as an escalation; touching it restarts the clock', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: true, requiredSearches: ['CON29'] });
  const r = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'source_of_funds', title: 'Gifted deposit from parents abroad: donor ID and statements outstanding' });
  const id = (r.events[0].payload as { issueId: string }).issueId;
  h.advanceDays(9);
  assert.equal(deadlineActions(await h.svc.getState(TENANT, MATTER), h.ports.now()).filter((d) => d.kind === 'stale_issue').length, 0);
  h.advanceDays(6); // 15 calendar days ≈ 11 working days
  const due = deadlineActions(await h.svc.getState(TENANT, MATTER), h.ports.now()).filter((d) => d.kind === 'stale_issue');
  assert.equal(due.length, 1);
  assert.equal(due[0].subject, `issue:${id}:stale:2026-09-14`);
  const t1 = await h.svc.tick(TENANT, MATTER);
  assert.equal(t1.escalations, 1);
  let s = await h.svc.getState(TENANT, MATTER);
  const esc = pendingDecisions(s).find((d) => d.kind === 'escalation' && d.subject === due[0].subject);
  assert.ok(esc, 'the stale issue is a decision for a person, with a dossier');
  assert.match(esc.summary, /no movement for \d+ working days/);
  const t2 = await h.svc.tick(TENANT, MATTER);
  assert.equal(t2.escalations, 0, 'raised once per period of silence');
  await h.svc.run(TENANT, MATTER, { type: 'update_issue', actor: USER, issueId: id, status: 'negotiating', note: 'Donor letter received; bank statements promised by Friday' });
  h.advanceDays(3);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(deadlineActions(s, h.ports.now()).filter((d) => d.kind === 'stale_issue').length, 0, 'the clock restarted at the update');
  await h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: id, resolution: 'evidence_provided', note: 'Donor ID, gift letter and 3 months\' statements on file' });
  h.advanceDays(30);
  assert.equal(deadlineActions(await h.svc.getState(TENANT, MATTER), h.ports.now()).filter((d) => d.kind === 'stale_issue').length, 0, 'resolved issues are not stale');
});

test('readiness milestones and a price change on a lender-funded purchase: advisory milestones never gate; a renegotiated price tells the lender', async () => {
  const h = harness();
  await toPreExchange(h);
  await h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 30_000_000, reason: 'Agreed price' });
  const pc = await h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 29_500_000, reason: 'Seller agreed £5k off for the boiler' });
  assert.deepEqual(pc.events.map((e) => e.type), ['price_changed', 'issue_raised']);
  const li = openIssues(pc.state)[0];
  assert.equal(li.kind, 'lender_approval');
  assert.match(li.title, /£295,000/);
  await h.svc.run(TENANT, MATTER, { type: 'contract_approved', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'signed_contract_held', actor: USER, note: 'Signed by both clients at the office' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contract_approved', actor: USER }), /already approved/);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.readiness.contractApprovedAt && s.readiness.signedContractHeldAt);
  assert.ok(!stageBlockers(s).some((b) => /contract approved|signed contract/.test(b)), 'milestones are advisory');
  assert.ok(stageBlockers(s).some((b) => b.startsWith('issue: Lender approval needed')));
});
