/** What a conveyancer's time is worth (lib/value.ts): the landing page's £1,314 and the Measurement page's values. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOUBLING_VALUE, MINUTE_PER_CASE_VALUE, minutesPerCase, pounds, yearValueOfMinutesSaved, yearValueOfWeeklyHours } from '../../../lib/value';

test('the first minute saved on every case is worth £1,314 a year', () => {
  assert.equal(MINUTE_PER_CASE_VALUE, 1314);
});

test('each minute after is worth more than the one before', () => {
  const second = yearValueOfMinutesSaved(2) - yearValueOfMinutesSaved(1);
  assert.ok(second > MINUTE_PER_CASE_VALUE);
});

test('saving half of every case doubles the cases: £360k', () => {
  assert.equal(Math.round(DOUBLING_VALUE), 360_000);
});

test('an hour a week is 7⅓ minutes on each of 360 cases', () => {
  assert.equal(Math.round(minutesPerCase(1) * 300), 2200);
  assert.equal(Math.round(yearValueOfWeeklyHours(1)), Math.round(yearValueOfMinutesSaved(22 / 3)));
  assert.equal(yearValueOfWeeklyHours(0), 0);
});

test('pounds: thousands from £10k, whole pounds below', () => {
  assert.equal(pounds(57_633), '£58k');
  assert.equal(pounds(9_636.4), '£9,636');
});
