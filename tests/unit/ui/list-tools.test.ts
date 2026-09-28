import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf } from '../../../app/shared/engine/ListTools';

test('lists group like Outlook: today, yesterday and this week open; older folded and by month', () => {
  const now = new Date(2026, 8, 30, 15, 0); // Wednesday 30 September 2026
  const at = (y: number, m: number, d: number, h = 10) => new Date(y, m, d, h).toISOString();
  assert.deepEqual(bucketOf(at(2026, 8, 30), now), { key: '0', label: 'Today', open: true });
  assert.equal(bucketOf(at(2026, 8, 29), now).label, 'Yesterday');
  assert.equal(bucketOf(at(2026, 8, 28), now).label, 'This Week', 'Monday of this week');
  assert.equal(bucketOf(at(2026, 8, 24), now).label, 'Last Week');
  assert.equal(bucketOf(at(2026, 8, 24), now).open, false);
  assert.equal(bucketOf(at(2026, 8, 3), now).label, 'Earlier This Month');
  assert.equal(bucketOf(at(2026, 7, 14), now).label, 'August 2026');
  assert.equal(bucketOf(at(2025, 11, 1), now).label, 'December 2025');
});
