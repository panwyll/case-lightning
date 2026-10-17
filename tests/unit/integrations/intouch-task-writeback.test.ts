/** Write-back to InTouch: emails CONVEYi sent filed in the case, and steps done here ticking off the firm's tasks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepOf, taskForStep, TASK_STEPS } from '../../../lib/server/integrations/intouch/task-steps';
import { writeBackToInTouch, type InTouchWritebackStore } from '../../../lib/server/integrations/intouch/writeback';

const step = (k: string) => TASK_STEPS.find((s) => s.key === k)!;
const tasks = () => [
  { id: 't1', name: 'Client ID & AML check', completed: false },
  { id: 't2', name: 'Order searches', completed: false },
  { id: 't3', name: 'Review search results', completed: false },
  { id: 't4', name: 'Ready to exchange', completed: false },
  { id: 't5', name: 'Exchange contracts', completed: false },
  { id: 't6', name: 'Send report on title to client', completed: false },
];

test('a step ticks off the task named for it, and never one named for a different step', () => {
  assert.equal(taskForStep(step('id_check'), tasks())?.id, 't1');
  assert.equal(taskForStep(step('searches_ordered'), tasks())?.id, 't2');
  assert.equal(taskForStep(step('searches_back'), tasks())?.id, 't3');
  assert.equal(taskForStep(step('exchanged'), tasks())?.id, 't5', 'not "Ready to exchange"');
  assert.equal(taskForStep(step('report_on_title'), tasks())?.id, 't6');
  assert.equal(taskForStep(step('sdlt'), tasks()), null, 'nothing is ticked off on a guess');
});

test("the firm's mapping wins, 'none' ticks nothing, and a task already done is never ticked again", () => {
  assert.equal(taskForStep(step('exchanged'), tasks(), { exchanged: 'Ready to exchange' })?.id, 't4');
  assert.equal(taskForStep(step('id_check'), tasks(), { id_check: 'none' }), null);
  assert.equal(taskForStep(step('id_check'), tasks().map((t) => ({ ...t, completed: true }))), null);
});

test('an event, or Mark Complete on its step, is that step', () => {
  assert.equal(stepOf('contracts_exchanged')?.key, 'exchanged');
  assert.equal(stepOf('step_completed_manually', { step: 'search:CON29' })?.key, 'searches_back');
  assert.equal(stepOf('step_completed_manually', { step: 'title' })?.key, 'title');
  assert.equal(stepOf('note_recorded'), null);
});

test('write-back files each email once and ticks off each step once', async () => {
  const filed: string[] = []; const completed: string[] = []; const applied = new Set<string>();
  const api = {
    tasks: async () => tasks(),
    completeTask: async (id: string) => { completed.push(id); },
    fileEmail: async (_c: string, e: { subject: string }) => { filed.push(e.subject); return { id: 'x' }; },
  } as never;
  const ev = (id: string, type: string, payload = {}) => ({ id, type, payload, createdAt: '2026-10-17T10:00:00Z' });
  const store: InTouchWritebackStore = {
    writebackOptions: async () => ({ documents: false, notes: false, emails: true, tasks: true, taskMap: {} }),
    outgoingEmails: async () => [{ id: 'm1', at: '2026-10-17T09:00:00Z', subject: 'Your ID check', text: 'Hello', to: 'client@example.test', from: { email: 'pat@firm.test', name: 'Pat' } }].filter((m) => !applied.has(`email_out:${m.id}`)),
    outgoingDocuments: async () => [], documentBytes: async () => null, documentSent: async () => {},
    unnotedEvents: async (_t, _m, _types, kind) => [ev('e1', 'id_check_cleared'), ev('e2', 'contracts_exchanged'), ev('e3', 'sdlt_submitted')].filter((e) => !applied.has(`${kind}:${e.id}`)) as never,
    eventNoted: async (_t, _m, id, kind) => { applied.add(`${kind ?? 'note_out'}:${id}`); },
  };
  const state = { enrolled: true, shadowMode: false } as never;
  const r1 = await writeBackToInTouch(api, store, 'T', { matterId: 'M', intouchCaseId: 'C' }, state, () => {});
  assert.deepEqual({ emails: r1.emails, tasks: r1.tasks }, { emails: 1, tasks: 2 });
  assert.deepEqual(filed, ['Your ID check']);
  assert.deepEqual(completed, ['t1', 't5']);
  const r2 = await writeBackToInTouch(api, store, 'T', { matterId: 'M', intouchCaseId: 'C' }, state, () => {});
  assert.deepEqual({ emails: r2.emails, tasks: r2.tasks }, { emails: 0, tasks: 0 }, 'nothing twice');
});
