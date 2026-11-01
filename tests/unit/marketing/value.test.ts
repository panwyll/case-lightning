/** What a conveyancer's time is worth (lib/value.ts): the landing page's £1,314 and the Measurement page's values. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE_PER_CASE_VALUE, pounds, yearValueOfWeeklyHours } from '../../../lib/value';

test('a minute saved on every case is worth £1,314 a year', () => {
  assert.equal(MINUTE_PER_CASE_VALUE, 1314);
});

test('an hour a week is the 7⅓ minutes it frees on each of 360 cases', () => {
  assert.equal(Math.round(yearValueOfWeeklyHours(1)), Math.round((44 * 60 / 360) * 1314));
  assert.equal(yearValueOfWeeklyHours(0), 0);
});

test('pounds: thousands from £10k, whole pounds below', () => {
  assert.equal(pounds(50_110), '£50k');
  assert.equal(pounds(9_636.4), '£9,636');
});
