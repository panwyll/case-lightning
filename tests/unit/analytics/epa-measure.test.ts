/** The onboarding measurement (docs/epa-categories.md): a typical week from the mailbox scans, worked by hand. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeasurement, type PersonScan } from '../../../lib/server/epa/measure';
import { DEFAULT_LEVELS } from '../../../lib/server/engine/types';

const person = (over: Partial<PersonScan> = {}): PersonScan => ({
  weeks: 2,
  sent: [
    // 60 client status replies in two weeks, Outlook timed 20 of them at 6 minutes: 30 a week × 6 = 3h.
    { category: 'update_reply', roles: ['client'], count: 60, timed: 20, timedMedianMinutes: 6 },
    // 40 lender chasers, too few timed: typical 4 minutes. 20 a week × 4 = 80 min.
    { category: 'chaser', roles: ['lender'], count: 40, timed: 3, timedMedianMinutes: 2 },
    // 20 legal questions: 10 a week × 10 = 100 min, amber.
    { category: 'client_question', roles: ['client'], count: 20, timed: 0, timedMedianMinutes: null },
    // Legal email: green the inbox does show. 10 a week × 10 = 100 min.
    { category: 'legal_work', roles: ['other_solicitor'], count: 20, timed: 0, timedMedianMinutes: null },
    // Colleagues: not counted.
    { category: 'internal', roles: ['colleague'], count: 100, timed: 50, timedMedianMinutes: 3 },
  ],
  received: [
    { category: 'update_request', roles: ['client'], count: 50 },
    { category: 'update_request', roles: ['estate_agent'], count: 10 },
    { category: 'chaser_received', roles: ['other_solicitor'], count: 8 },
  ],
  intouch: { live: 60, openedInWindow: 8, filedByFirm: { email: 400, note: 20, call: 5, document: 60 }, filedByOthers: 30 },
  ...over,
});

test('a typical week: red and amber measured, green the rest of the week, so "at most"', () => {
  const m = buildMeasurement({ people: [person()], contractedHours: 37.5, levels: DEFAULT_LEVELS })!;
  // Red: 180 (status) + 80 (chasers) + filing 30 docs a week × 2 + notes 10 × 4 = 360 min = 6h. Email records are never counted.
  assert.equal(m.hours.red, 6);
  assert.equal(m.hours.amber, 1.7);
  // Green: 37.5 - 6 - 1.67 = 29.83h, which is more than the 1.67h of legal email the inbox shows.
  assert.equal(m.hours.green, 29.8);
  assert.equal(Math.round(m.movesCasesOnAtMost * 1000), 796);
  assert.deepEqual(m.lines.map((l) => [l.kind, l.times, l.avgMinutes, l.minutesBasis]), [
    ['client_any_news', 30, 6, 'timed'],
    ['client_legal_questions', 10, 10, 'typical'],
    ['lender_chasers', 20, 4, 'typical'],
    ['filing', 30, 2, 'intouch'],
    ['notes_and_outcomes', 10, 4, 'intouch'],
  ]);
  assert.deepEqual(m.received, { clientStatusRequests: 25, agentStatusRequests: 5, otherSideStatusRequests: 0, chasersReceived: 4 });
  assert.deepEqual(m.cases, { live: 60, perConveyancer: 60, openedPerWeek: 4 });
});

test('the firm is everyone added up; a busy week can leave green below what the inbox shows, never negative', () => {
  const busy = person({ sent: [{ category: 'chaser', roles: ['client'], count: 2000, timed: 0, timedMedianMinutes: null }, { category: 'legal_work', roles: ['client'], count: 20, timed: 0, timedMedianMinutes: null }], intouch: null });
  const m = buildMeasurement({ people: [busy, person()], contractedHours: 37.5, levels: DEFAULT_LEVELS })!;
  assert.equal(m.people, 2);
  assert.ok(m.hours.green >= 1.6, 'green is never less than the legal email seen');
  assert.equal(m.cases!.perConveyancer, 60, 'only people InTouch was read for');
  assert.equal(buildMeasurement({ people: [], contractedHours: 37.5, levels: DEFAULT_LEVELS }), null);
});
