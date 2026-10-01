/**
 * Firm analytics (docs/analytics.md): time is attributed to whoever a case waits on (us first), figures
 * are percentiles with their sample size, the month is paced on what is done and booked, and people are
 * listed by name against their own figures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute, computeAnalytics, percentile, type CaseFacts } from '../../../lib/server/analytics/kpis';
import { demoAnalyticsInput, DEMO_PEOPLE } from '../../../lib/server/analytics/demo';

const NOW = new Date('2026-10-15T12:00:00Z');
const base = (over: Partial<CaseFacts>): CaseFacts => ({ id: 'c', ref: 'R1', handlerId: 'u1', side: 'purchase', leasehold: false, instructedAt: '2026-10-01T00:00:00Z', exchangedAt: null, completedAt: null, abandoned: null, completionDate: null, waits: [], decisions: [], ...over });

test('time is attributed: anything waiting on a person here is ours; otherwise split between whoever we wait on; otherwise nothing outstanding', () => {
  const c = base({
    waits: [{ key: 'search', party: 'searches', openedAt: '2026-10-01T00:00:00Z', closedAt: '2026-10-11T00:00:00Z', chases: [] }, { key: 'enquiry', party: 'other_side', openedAt: '2026-10-06T00:00:00Z', closedAt: '2026-10-11T00:00:00Z', chases: [] }],
    decisions: [{ kind: 'search', createdAt: '2026-10-11T00:00:00Z', resolvedAt: '2026-10-13T00:00:00Z', resolvedBy: 'u1' }],
  });
  const a = attribute(c, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-15T00:00:00Z'));
  assert.equal(Math.round(a.searches * 10) / 10, 7.5, '5 days alone + half of 5 shared');
  assert.equal(Math.round(a.other_side * 10) / 10, 2.5);
  assert.equal(a.us, 2);
  assert.equal(a.none, 2);
});

test('percentiles, not averages', () => {
  assert.equal(percentile([1, 2, 3, 4, 100], 50), 3);
  assert.equal(percentile([], 50), null);
});

test('the month is paced on completions done and those booked by exchange, against the target, last year and the record', () => {
  const cases = [
    base({ id: 'a', completedAt: '2026-10-03T12:00:00Z', exchangedAt: '2026-09-20T12:00:00Z', instructedAt: '2026-06-01T00:00:00Z' }),
    base({ id: 'b', exchangedAt: '2026-10-01T12:00:00Z', completionDate: '2026-10-28' }),
    base({ id: 'c', exchangedAt: '2026-10-01T12:00:00Z', completionDate: '2026-11-04' }),
    base({ id: 'd', completedAt: '2025-10-10T12:00:00Z', instructedAt: '2025-07-01T00:00:00Z' }),
    base({ id: 'e', completedAt: '2025-10-20T12:00:00Z', instructedAt: '2025-07-01T00:00:00Z' }),
  ];
  const r = computeAnalytics({ now: NOW, cases, feedback: [], targets: { monthlyCompletions: 3, perPerson: {} }, people: [] });
  assert.equal(r.pace.completions, 1);
  assert.equal(r.pace.booked, 1, 'only the one completing this month');
  assert.equal(r.pace.forecast, 2);
  assert.equal(r.pace.samePointLastYear, 1);
  assert.equal(r.pace.lastYearMonth, 2);
  assert.deepEqual(r.pace.record, { month: '2025-10', completions: 2 });
  assert.match(r.insights[0], /1 short of this month's target of 3/);
});

test('thin figures are marked, and people are listed by name, each against their own target', () => {
  const r = computeAnalytics(demoAnalyticsInput(NOW));
  assert.deepEqual(r.people.map((p) => p.name), [...DEMO_PEOPLE].map((p) => p.name).sort());
  assert.ok(r.people.every((p) => p.target === 5));
  assert.equal(r.cycle.instructionToCompletion.thin, false);
  const one = computeAnalytics({ now: NOW, cases: [base({ completedAt: '2026-10-10T00:00:00Z', instructedAt: '2026-07-01T00:00:00Z' })], feedback: [], targets: { monthlyCompletions: null, perPerson: {} }, people: [] });
  assert.equal(one.cycle.instructionToCompletion.thin, true);
  assert.equal(one.cycle.sle, null, 'no service level from one case: the industry figure stands in for ageing');
});

test('a person\'s view is their cases only; satisfaction and fall-through come with their counts', () => {
  const input = demoAnalyticsInput(NOW);
  const dan = DEMO_PEOPLE.find((p) => p.name === 'Dan Hughes')!.id;
  const r = computeAnalytics(input, { personId: dan });
  assert.equal(r.people.length, 1);
  assert.equal(r.scope.personName, 'Dan Hughes');
  assert.ok(r.satisfaction.nps.n > 0 && r.fallThrough.n > 0);
  const firm = computeAnalytics(input);
  assert.ok(r.pipeline.open < firm.pipeline.open);
  assert.ok(firm.flow.shares.reduce((a, s) => a + s.share, 0) > 0.999);
});
