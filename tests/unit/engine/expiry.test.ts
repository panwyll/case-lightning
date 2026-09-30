/**
 * Dates that run out: the mortgage offer (before exchange, before the target, after exchange, unknown),
 * the redemption statement, search age, and a missed completion day. Each raises an issue once, with
 * the day it must be dealt with, and closes itself when the thing it was about changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timedIssueActions } from '../../../lib/server/engine/sla';
import type { MatterState } from '../../../lib/server/engine/types';
import { harness, TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T09:00:00Z');
async function base(): Promise<MatterState> {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [] });
  const s = structuredClone(await h.svc.getState(TENANT, MATTER));
  s.mortgage = { status: 'cleared', documentId: 'doc-offer', facts: { lender: 'Santander', amountPennies: 20_000_000, expiryDate: '2027-02-01' } as never, decisionEventId: null };
  return s;
}
const raised = (s: MatterState, now = NOW) => timedIssueActions(s, now).filter((a): a is Extract<ReturnType<typeof timedIssueActions>[number], { kind: 'raise' }> => a.kind === 'raise');
/** The state after the timer's raises, as if the tick had applied them. */
const withIssues = (s: MatterState, now = NOW): MatterState => {
  const t = structuredClone(s);
  for (const r of raised(s, now)) t.issues[r.key] = { id: r.key, kind: r.issueKind, title: r.title, detail: r.detail, status: 'open', severity: r.severity, gate: r.gate ?? 'none', raisedBy: 'system', raisedAt: now.toISOString(), updatedAt: now.toISOString(), enquiryIds: [], history: [], resolveBy: r.resolveBy ?? null } as never;
  return t;
};

test('an offer read without an expiry date asks for it, and closes once it is known', async () => {
  const s = await base();
  (s.mortgage.facts as { expiryDate?: string | null }).expiryDate = null;
  const r = raised(s);
  assert.equal(r.length, 1);
  assert.equal(r[0].issueKind, 'mortgage_offer_expiry_unknown');
  const later = withIssues(s);
  (later.mortgage.facts as { expiryDate?: string | null }).expiryDate = '2027-02-01';
  assert.ok(timedIssueActions(later, NOW).some((a) => a.kind === 'resolve'), 'closes when the date is known');
});

test('a target completion after the offer runs out is raised early, with the expiry as its due date', async () => {
  const s = await base();
  s.targetCompletionDate = '2027-03-01';
  const r = raised(s).find((x) => x.issueKind === 'mortgage_offer_expiring')!;
  assert.match(r.title, /expires on 2027-02-01, before the target completion on 2027-03-01/);
  assert.equal(r.resolveBy, '2027-02-01');
  const moved = withIssues(s);
  moved.targetCompletionDate = '2027-01-15';
  assert.ok(timedIssueActions(moved, NOW).some((a) => a.kind === 'resolve'), 'closes when the target moves inside the offer');
});

test('after exchange: completion after the expiry is critical; a lapsed offer holds completion', async () => {
  const s = await base();
  s.exchange = { ...s.exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2027-02-10' };
  const before = raised(s).find((x) => x.issueKind === 'mortgage_offer_expiring')!;
  assert.equal(before.severity, 'critical');
  assert.match(before.title, /before completion on 2027-02-10/);
  const after = raised(s, new Date('2027-02-03T09:00:00Z'));
  const lapsed = after.find((x) => x.issueKind === 'mortgage_offer_expired')!;
  assert.match(lapsed.title, /after exchange/);
  assert.ok(!timedIssueActions(s, new Date('2027-02-03T09:00:00Z')).some((a) => a.kind === 'offer_expired'), 'no attempt to withdraw the offer after exchange');
});

test('a redemption statement that runs out before completion asks for a fresh one', async () => {
  const s = await base();
  s.redemption = { ...s.redemption, status: 'received', lender: 'Halifax', validUntil: '2026-10-20' };
  s.targetCompletionDate = '2026-11-05';
  const r = raised(s).find((x) => x.issueKind === 'redemption_statement_expired')!;
  assert.match(r.title, /valid only until 2026-10-20, before completion on 2026-11-05/);
  assert.equal(r.severity, 'warning');
  const fresh = withIssues(s);
  fresh.redemption.validUntil = '2026-11-30';
  assert.ok(timedIssueActions(fresh, NOW).some((a) => a.kind === 'resolve'));
});

test('a search a month from going out of date warns; once out of date it is critical on a lender case', async () => {
  const s = await base();
  s.searches = { LLC1: { searchType: 'LLC1', cycle: 1, status: 'cleared', orderedAt: '2026-04-01T00:00:00Z', returnedAt: '2026-04-20T00:00:00Z', documentId: 'd', facts: null } as never };
  const r = raised(s).find((x) => x.issueKind === 'search_out_of_date')!;
  assert.match(r.title, /LLC1 search goes out of date on 2026-10-/);
  assert.equal(r.severity, 'warning');
  assert.equal(r.gate, 'none', 'a warning holds nothing');
  const stale = raised(s, new Date('2026-11-01T09:00:00Z')).find((x) => x.issueKind === 'search_out_of_date')!;
  assert.equal(stale.severity, 'critical');
  assert.equal(stale.gate, 'exchange', 'out of date, it holds exchange');
  const exchanged = withIssues(s);
  exchanged.exchange = { ...exchanged.exchange, exchangedAt: '2026-10-05T10:00:00Z' };
  assert.ok(timedIssueActions(exchanged, NOW).some((a) => a.kind === 'resolve'), 'closes on exchange');
});

test('a completion day that passes without completion is a completion failure, closed when completion is recorded', async () => {
  const s = await base();
  (s.mortgage.facts as { expiryDate?: string | null }).expiryDate = '2027-06-01';
  s.exchange = { ...s.exchange, exchangedAt: '2026-09-10T10:00:00Z', completionDate: '2026-09-30' };
  const r = raised(s).find((x) => x.issueKind === 'completion_failure')!;
  assert.match(r.title, /Completion was due on 2026-09-30/);
  const done = withIssues(s);
  done.completion = { ...done.completion, confirmedAt: '2026-10-01T12:00:00Z' };
  assert.ok(timedIssueActions(done, NOW).some((a) => a.kind === 'resolve'));
});

test('case status: an expiry warning is With Us; a critical one (offer running out after exchange) is Critical', async () => {
  const { caseHealth } = await import('../../../lib/server/engine/health');
  const s = await base();
  s.targetCompletionDate = '2027-03-01';
  const warned = caseHealth(withIssues(s), NOW);
  const r = warned.reasons.find((x) => x.code === 'expiry_warning');
  assert.equal(r?.band, 'attention', 'the warning is ours to act on, not a delay');
  assert.equal(warned.band, caseHealth(s, NOW).band, 'a warning never makes the case worse than With Us');
  const x = await base();
  x.exchange = { ...x.exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2027-02-10' };
  const crit = withIssues(x);
  assert.equal(caseHealth(crit, NOW).band, 'critical');
});
