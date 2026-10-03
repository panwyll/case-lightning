/**
 * Whatever is recorded shows on the Tasks list: an issue that waits on someone else is ours to chase, never hidden;
 * and a case enrolled without its clients' names takes them from the matter record so "our client" is known.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { matterWork } from '../../../lib/server/engine/work';
import { clientNamesOf } from '../../../lib/server/engine/enrol';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-03T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const base = initialState(TENANT, MATTER);

test('a death after exchange holds completion as a task; the lender is written to, not left as a note', () => {
  let s: MatterState = { ...base, enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_completion', hasLender: true, exchange: { ...base.exchange, exchangedAt: '2026-09-25T10:00:00Z', completionDate: '2026-10-16' } };
  s = fold(s, { type: 'record_client_names', names: ['Asha Patel'] });
  s = fold(s, { type: 'record_party_event', event: 'died', party: 'Asha Patel', note: 'Her son rang' });
  const tasks = matterWork(s, NOW).items.filter((i) => i.ref?.type === 'issue').map((i) => `${i.chip}: ${i.what}`);
  assert.deepEqual(tasks, ["Resolve Issue: Waiting for the grant: Asha Patel's personal representatives take over"]);
});

test('client names come from the matter record, once', () => {
  assert.deepEqual(clientNamesOf('SALE', ['Buyer One'], ['Seller One', ' Seller Two ']), ['Seller One', 'Seller Two']);
  assert.deepEqual(clientNamesOf('PURCHASE', ['Buyer One'], ['Seller One']), ['Buyer One']);
  let s: MatterState = { ...base, enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_contract' };
  s = fold(s, { type: 'record_client_names', names: ['Asha Patel', 'Ben Carter'] });
  assert.deepEqual(s.partyNames, ['Asha Patel', 'Ben Carter']);
  assert.ok(Object.values(s.partyChecks).some((p) => p.label === 'Ben Carter'), 'the second client is identified too');
  assert.throws(() => fold(s, { type: 'record_client_names', names: ['Someone Else'] }), /already named/);
});

test('emails repeating one subject are one task: beside the open issue, and settled together', () => {
  const note = (id: string, decisionEventId: string, at: string) => ({ id, decisionEventId, receivedAt: at, status: 'pending', actions: [{ id: 'a1', kind: 'issue', command: { type: 'raise_issue', kind: 'transaction_at_risk', title: 'Seller threatening to withdraw unless completion by Friday' } }, { id: 'a2', kind: 'question', command: null }], messages: [{ id: 'reply', to: 'client', subject: 'Re', body: 'Hello', on: true }] });
  const dec = (eventId: string, subject: string, createdAt: string) => ({ eventId, kind: 'note_actions', subject, status: 'pending', createdAt, summary: '', options: ['approve', 'reject', 'escalate'], openedBy: [USER], sourceDocumentId: null, origin: null, surfacedAt: createdAt });
  let s: MatterState = { ...base, enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_exchange', partyNames: ['Asha Patel'],
    notes: { 'N-1': note('N-1', 'd1', '2026-10-01T09:00:00Z'), 'N-2': note('N-2', 'd2', '2026-10-02T09:00:00Z') } as never,
    decisions: { d1: dec('d1', 'N-1', '2026-10-01T09:00:00Z'), d2: dec('d2', 'N-2', '2026-10-02T09:00:00Z') } as never };
  // No issue yet: only the newest email is a task.
  let emails = matterWork(s, NOW).items.filter((i) => i.ref?.type === 'decision');
  assert.deepEqual(emails.map((i) => i.ref?.id), ['d2']);
  // Once the issue is open, both emails sit on its row.
  s = fold(s, { type: 'raise_issue', kind: 'transaction_at_risk', title: 'Seller threatening to withdraw unless completion by Friday', detail: 'x', gate: 'exchange' });
  const items = matterWork(s, NOW).items;
  assert.equal(items.filter((i) => i.ref?.type === 'decision').length, 0);
  assert.deepEqual(items.find((i) => i.ref?.type === 'issue')?.emails, ['d2', 'd1']);
  // Answering the newest settles the older one too.
  const r = decide(s, { type: 'resolve_decision', userId: USER, decisionEventId: 'd2', option: 'approve', selection: ['reply'] } as unknown as Command, { now: NOW });
  assert.deepEqual(r.events.filter((e) => e.type === 'note_actions_applied').map((e) => (e.payload as { decisionEventId: string }).decisionEventId).sort(), ['d1', 'd2']);
  emails = [];
});

test('a sole client dies before exchange: Close The Case, and the letters drafted for approval, never sent unread', async () => {
  const { harness } = await import('./helpers');
  const { dueSteps } = await import('../../../lib/server/engine/due');
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [], partyNames: ['Asha Patel'] } as never);
  const r = await h.svc.run(TENANT, MATTER, { type: 'record_party_event', actor: USER, event: 'died', party: 'Asha Patel', note: 'Her son rang' } as never);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.ok(dueSteps(s).some((d) => d.key === 'death_close'), 'Close The Case is a step');
  const letters = Object.values(s.proposals).filter((p) => p.status === 'pending' && p.dedupKey?.startsWith('died:'));
  assert.deepEqual(letters.map((p) => p.dedupKey.split(':').pop()).sort(), ['estate_agent', 'family', 'lender', 'seller_solicitor']);
  const items = matterWork(s, new Date()).items.filter((i) => i.ref?.type === 'decision' || i.ref?.type === 'step');
  assert.ok(items.length >= 5, items.map((i) => `${i.chip}: ${i.what}`).join(' | '));
  assert.equal(Object.values(r.state.issues).filter((i) => i.status === 'open').length, 0, 'no prose issue: the step and the letters are the work');
  // Closing sends no generic "not proceeding" notice on top.
  await h.svc.run(TENANT, MATTER, { type: 'abandon_matter', actor: USER, reason: 'client_died', detail: 'Our client has died' } as never);
  const after = await h.svc.getState(TENANT, MATTER);
  assert.ok(!Object.values(after.proposals).some((p) => p.dedupKey?.startsWith('cp:withdrawn')));
});
