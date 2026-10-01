/**
 * After completion (theme H): problems found later are issues that hold the file open; a requisition always has a
 * reply date and can be extended; a cancelled application loses priority and goes in again; the new register is read
 * before the file closes; a charged seller's DS1 is waited for under their undertaking; closing stamps the retention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, stageBlockers, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { dueSteps } from '../../../lib/server/engine/due';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const i0 = initialState(TENANT, MATTER);
const lodged = (over: Partial<MatterState> = {}): MatterState => ({ ...i0, enrolled: true, transactionType: 'freehold_purchase', stage: 'post_completion', hasLender: true, completion: { ...i0.completion, confirmedAt: '2026-09-01T12:00:00Z' }, postCompletion: { ...i0.postCompletion, sdltSubmittedAt: '2026-09-05T10:00:00Z', ap1SubmittedAt: '2026-09-06T10:00:00Z' }, ...over });

test('a problem found after completion is an issue: it holds nothing, but the file does not close while it is open', () => {
  const s = fold(lodged(), { type: 'raise_issue', kind: 'disclosure_concern', title: 'The boiler the seller said was serviced is condemned', gate: 'exchange' });
  const i = Object.values(s.issues)[0];
  assert.equal(i.gate, 'none');
  const registered = { ...s, postCompletion: { ...s.postCompletion, ap1ConfirmedAt: NOW.toISOString() }, registerCheckedAt: NOW.toISOString() };
  assert.throws(() => fold(registered, { type: 'close_matter' }), /Open issues remain/);
});

test('a requisition with no date gets 20 working days; more time can be agreed; near the date it is a task', () => {
  let s = fold(lodged(), { type: 'hmlr_requisition_received', documentId: 'r1', reference: 'R1' });
  const r = s.postCompletion.requisitions[0];
  assert.equal(r.deadline, '2026-10-29');
  const near = { ...s, postCompletion: { ...s.postCompletion, requisitions: [{ ...r, deadline: '2026-10-05' }] } };
  assert.ok(dueSteps(near, NOW).some((d) => d.key === `requisition_extend:${r.eventId}`));
  s = fold(near, { type: 'requisition_extended', requisitionEventId: r.eventId, deadline: '2026-10-30', note: "Awaiting the seller's DS1; HMLR agreed 30 October by phone" });
  assert.equal(s.postCompletion.requisitions[0].deadline, '2026-10-30');
});

test('a cancelled application: priority lost, the lender told, and the AP1 is lodged again', () => {
  const s = fold(lodged(), { type: 'ap1_cancelled', reason: 'Requisition not answered in time' });
  assert.equal(s.postCompletion.ap1SubmittedAt, null);
  assert.deepEqual(Object.values(s.issues).map((i) => `${i.kind}:${i.severity}`), ['title_defect:critical', 'lender_approval:critical']);
});

test('the new register is read before closing; a mistake on it is an issue; closing stamps when the file may be destroyed', () => {
  const registered = lodged({ postCompletion: { ...lodged().postCompletion, ap1ConfirmedAt: NOW.toISOString() } });
  assert.match(stageBlockers(registered).join(' | '), /new register not yet checked/);
  assert.throws(() => fold(registered, { type: 'close_matter' }), /Check the new register/);
  const wrong = fold(registered, { type: 'register_checked', wrong: true, note: "The lender's charge is not shown" });
  assert.equal(Object.values(wrong.issues)[0].kind, 'title_defect');
  const right = fold(registered, { type: 'register_checked', lenderTold: true });
  const closed = fold(right, { type: 'close_matter' });
  assert.equal(closed.retention?.destroyAfter, '2041-10-01');
  assert.equal(closed.retention?.cddUntil, '2031-09-01');
});

test("a purchase from a charged seller waits for their DS1 under the undertaking, and the file does not close without it", () => {
  const charged = { ...i0, enrolled: true, transactionType: 'freehold_purchase' as const, stage: 'pre_completion' as const, title: { ...i0.title, facts: { titleNumber: 'X', tenure: 'freehold' as const, restrictions: [], covenants: [], confidence: 1, charges: [{ code: 'C1', text: 'Registered charge in favour of Barclays Bank UK PLC' }] } } };
  const done = [{ id: 'e', seq: 1, type: 'completion_confirmed', actor: USER, payload: { completedAt: null }, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: null } as unknown as EngineEvent].reduce(applyEvent, charged as MatterState);
  assert.ok(done.waits.some((w) => w.key === 'seller_discharge' && !w.closedAt));
  const after = { ...done, stage: 'post_completion' as const, postCompletion: { ...done.postCompletion, sdltSubmittedAt: 'x', ap1SubmittedAt: 'x', ap1ConfirmedAt: 'x' }, registerCheckedAt: 'x' };
  assert.throws(() => fold(after, { type: 'close_matter' }), /seller's DS1/);
  assert.equal(fold(after, { type: 'seller_discharge_received', reference: 'DS1' }).waits.find((w) => w.key === 'seller_discharge')!.closedAt !== null, true);
});
