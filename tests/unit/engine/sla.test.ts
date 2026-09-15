import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workingDaysBetween, addWorkingDays, isWorkingDay } from '../../../lib/server/engine/working-days';
import { dueActions, DEFAULT_SLA, withOverrides } from '../../../lib/server/engine/sla';
import { initialState, type MatterState } from '../../../lib/server/engine/types';

test('working days skip weekends and E&W bank holidays', () => {
  // Fri 2026-04-03 is Good Friday, Mon 2026-04-06 Easter Monday.
  assert.equal(isWorkingDay(new Date('2026-04-03T10:00:00Z')), false);
  assert.equal(isWorkingDay(new Date('2026-04-06T10:00:00Z')), false);
  assert.equal(isWorkingDay(new Date('2026-04-07T10:00:00Z')), true);
  // Thu 2 Apr → Wed 8 Apr: Tue 7, Wed 8 count (Fri/Sat/Sun/Mon do not) = 2
  assert.equal(workingDaysBetween(new Date('2026-04-02T09:00:00Z'), new Date('2026-04-08T09:00:00Z')), 2);
  // Mon 14 Sep 2026 → Wed 16 Sep = 2
  assert.equal(workingDaysBetween(new Date('2026-09-14T09:00:00Z'), new Date('2026-09-16T17:00:00Z')), 2);
  assert.equal(workingDaysBetween(new Date('2026-09-16'), new Date('2026-09-14')), 0);
  assert.equal(addWorkingDays(new Date('2026-09-14T00:00:00Z'), 5).toISOString().slice(0, 10), '2026-09-21');
});

function waiting(key: 'search' | 'enquiry', subject: string, openedAt: string): MatterState {
  const s = initialState('t', 'm');
  s.enrolled = true;
  s.waits.push({ key, subject, openedAt, openedBySeq: 1, closedAt: null, chasesSentAt: [], escalations: [] });
  return s;
}

test('search wait: nothing before day 10, chase at 10, escalate at 18', () => {
  const s = waiting('search', 'LLC1', '2026-09-14T09:00:00Z'); // Monday
  assert.deepEqual(dueActions(s, new Date('2026-09-25T09:00:00Z')), []); // 9 working days
  const d10 = dueActions(s, new Date('2026-09-28T09:00:00Z')); // 10 working days
  assert.equal(d10.length, 1);
  assert.equal(d10[0].kind, 'chase');
  // 18 working days later = 2026-10-08
  const d18 = dueActions(s, new Date('2026-10-08T09:00:00Z'));
  assert.deepEqual(d18.map((a) => a.kind).sort(), ['chase', 'escalate']);
});

test('enquiry wait: chase at 5 then every 3; one escalation until resolved', () => {
  const s = waiting('enquiry', 'E1', '2026-09-14T09:00:00Z');
  const first = dueActions(s, new Date('2026-09-21T09:00:00Z')); // 5 wd
  assert.equal(first.length, 1);
  s.waits[0].chasesSentAt.push('2026-09-21T09:00:00Z');
  assert.deepEqual(dueActions(s, new Date('2026-09-23T09:00:00Z')), []); // 2 wd since chase
  assert.equal(dueActions(s, new Date('2026-09-24T09:00:00Z')).length, 1); // 3 wd since chase
  s.waits[0].chasesSentAt.push('2026-09-24T09:00:00Z');
  // 15 wd = 2026-10-05
  const esc = dueActions(s, new Date('2026-10-05T09:00:00Z')).filter((a) => a.kind === 'escalate');
  assert.equal(esc.length, 1);
  s.waits[0].escalations.push({ eventId: 'x', raisedAt: '2026-10-05T09:00:00Z', resolvedAt: null });
  assert.equal(dueActions(s, new Date('2026-10-12T09:00:00Z')).filter((a) => a.kind === 'escalate').length, 0);
  s.waits[0].escalations[0].resolvedAt = '2026-10-06T09:00:00Z';
  // re-escalate only after reEscalateAfter (5 wd) since resolution → 2026-10-13
  assert.equal(dueActions(s, new Date('2026-10-12T09:00:00Z')).filter((a) => a.kind === 'escalate').length, 0);
  assert.equal(dueActions(s, new Date('2026-10-13T09:00:00Z')).filter((a) => a.kind === 'escalate').length, 1);
});

test('closed waits never fire; overrides change the numbers', () => {
  const s = waiting('search', 'LLC1', '2026-09-14T09:00:00Z');
  s.waits[0].closedAt = '2026-09-15T09:00:00Z';
  assert.deepEqual(dueActions(s, new Date('2026-12-01')), []);
  const cfg = withOverrides([{ waitKey: 'search', chaseAfter: 2 }]);
  assert.equal(cfg.search.chaseAfter, 2);
  assert.equal(cfg.search.escalateAfter, DEFAULT_SLA.search.escalateAfter);
});
