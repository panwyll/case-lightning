import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncTaskRecords, taskKey } from '../../../lib/server/engine/task-record';
import type { WorkItem } from '../../../lib/server/engine/work';

const item = (id: string, over: Partial<WorkItem> = {}) => ({ ref: { type: 'step', id }, bucket: 'do', what: `Do ${id}`, chip: 'Upload Documents', kind: 'step', ...over }) as unknown as WorkItem;
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';

test('task records: opens what is listed, closes what left, with the actor and how', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  await syncTaskRecords(async (sql, params) => { calls.push({ sql, params }); }, 'T', [
    { matterId: M1, items: [item('upload'), item('sign', { ref: { type: 'decision', id: 'e1' } as WorkItem['ref'] })], ownerOf: (i) => (i.ref.type === 'decision' ? U : 'SENIOR') },
    { matterId: M2, items: [], ownerOf: () => null, finished: true },
  ], { seq: 42, actor: U });
  const [ins, done, closed] = calls;
  assert.match(ins.sql, /insert into task_record/);
  assert.deepEqual(ins.params[2], ['step:upload', 'decision:e1']);
  assert.deepEqual(ins.params[7], [null, U], 'only a real user id is kept as the owner');
  assert.equal(ins.params[8], 42);
  assert.deepEqual(done.params.slice(1, 5), [[M1], 42, U, 'done']);
  assert.deepEqual(done.params[5], [`${M1}|step:upload`, `${M1}|decision:e1`]);
  assert.deepEqual(closed.params.slice(1, 5), [[M2], 42, U, 'case_closed']);
  assert.equal(taskKey(item('x')), 'step:x', 'the same key task_dismissal.ref uses');
});

test('task records: nothing to write for no cases', async () => {
  let n = 0;
  await syncTaskRecords(async () => { n++; }, 'T', []);
  assert.equal(n, 0);
});
