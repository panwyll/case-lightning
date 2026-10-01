/**
 * Dates and clocks (dates.ts): a completion date is a banking day inside the offer; searches are aged at completion
 * from the date they were made; first registration, a LISA's 90 days, an auction's 20 working days and a new build's
 * long-stop are watched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionDateProblem, staleAtCompletion } from '../../../lib/server/engine/dates';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { deadlineActions } from '../../../lib/server/engine/sla';
import { initialState, type MatterState } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
const base = (over: Partial<MatterState> = {}): MatterState => ({ ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_completion', ...over });

test('a completion date on a weekend, a bank holiday, in the past or after the offer expires is refused', () => {
  const s = base({ hasLender: true, mortgage: { ...initialState(TENANT, MATTER).mortgage, facts: { lender: 'X', amountPennies: 1, expiryDate: '2026-11-30' } as never } });
  assert.match(completionDateProblem(s, '2026-10-17', NOW)!, /Saturday/);
  assert.match(completionDateProblem(s, '2026-12-25', NOW)!, /bank holiday/);
  assert.match(completionDateProblem(s, '2026-09-30', NOW)!, /in the past/);
  assert.match(completionDateProblem(s, '2026-12-01', NOW)!, /offer expires on 2026-11-30/);
  assert.equal(completionDateProblem(s, '2026-10-16', NOW), null);
  // Moving the date after exchange is held to the same rules.
  const exchanged = { ...s, exchange: { ...s.exchange, exchangedAt: '2026-09-25T10:00:00Z', completionDate: '2026-10-16' } };
  assert.throws(() => decide(exchanged, { type: 'change_completion_date', actor: USER, completionDate: '2026-10-18' } as unknown as Command, { now: NOW }), /Sunday/);
});

test('searches are aged on the completion day from the date they were made, not when they reached us', () => {
  const s = base({ lenderRequirements: { minUnexpiredYears: null, maxSearchAgeMonths: 6, acceptsNonFamilyGift: null, requiresEws1: null, note: null, recordedAt: NOW.toISOString() }, searches: { LLC1: { searchType: 'LLC1', status: 'reviewed', returnedAt: '2026-09-01T10:00:00Z', facts: { searchType: 'LLC1', flags: [], confidence: 1, searchDate: '2026-04-01' } } as never } });
  assert.deepEqual(staleAtCompletion(s, '2026-10-16'), ['LLC1 (made 2026-04-01)'], 'a seller-supplied search made in April is past six months by mid-October');
  assert.deepEqual(staleAtCompletion(s, '2026-09-25'), []);
});

test('the clocks: first registration two months from completion; the LISA 90 days; auction completion; the new-build long-stop', () => {
  const kinds = (s: MatterState, now: Date) => deadlineActions(s, now).map((d) => `${d.kind}:${d.dueDate}`);
  const fr = base({ stage: 'completed', completion: { ...initialState(TENANT, MATTER).completion, confirmedAt: '2026-09-15T12:00:00Z' }, title: { ...initialState(TENANT, MATTER).title, facts: { titleNumber: '', tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 1, unregistered: true } } });
  assert.ok(kinds(fr, new Date('2026-11-05T09:00:00Z')).includes('first_registration:2026-11-15'));
  const lisa = base({ shapes: ['lifetime_isa'], waits: [{ key: 'funds', subject: 'isa_provider', openedAt: '2026-07-01T10:00:00Z', closedAt: '2026-07-10T10:00:00Z' } as never] });
  assert.ok(kinds(lisa, new Date('2026-09-25T09:00:00Z')).includes('lisa_window:2026-10-08'));
  const auction = base({ shapes: ['auction'], exchange: { ...initialState(TENANT, MATTER).exchange, exchangedAt: '2026-09-21T15:00:00Z', completionDate: '2026-10-19' } });
  assert.ok(kinds(auction, new Date('2026-10-14T09:00:00Z')).includes('auction_completion:2026-10-19'));
  const nb = base({ shapes: ['new_build'], longStopDate: '2026-10-28' });
  assert.ok(kinds(nb, NOW).includes('longstop_date:2026-10-28'));
});
