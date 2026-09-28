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

test('nextChase: the first chase falls chaseAfter working days after the wait opened, later ones chaseEvery after the last, none when chaseEvery is null', async () => {
  const { nextChase, DEFAULT_SLA } = await import('../../../lib/server/engine/sla');
  const wait = { key: 'enquiry' as const, subject: 'E1', openedAt: '2026-09-14T09:00:00Z', openedBySeq: 1, closedAt: null, chasesSentAt: [] as string[], escalations: [] };
  const first = nextChase(wait, DEFAULT_SLA.enquiry, new Date('2026-09-15T09:00:00Z'))!;
  assert.equal(first.dueDate, '2026-09-21');
  assert.equal(first.dueInWorkingDays, 4);
  assert.equal(first.recipientRole, 'seller_solicitor');
  const chased = { ...wait, chasesSentAt: ['2026-09-21T09:00:00Z'] };
  const again = nextChase(chased, DEFAULT_SLA.enquiry, new Date('2026-09-28T09:00:00Z'))!;
  assert.equal(again.dueDate, '2026-09-24');
  assert.ok(again.dueInWorkingDays < 0, 'overdue reads as due now');
  assert.equal(nextChase(chased, { ...DEFAULT_SLA.enquiry, chaseEvery: null }, new Date('2026-09-28T09:00:00Z')), null);
});

test('a chase proposed at Propose is withdrawn by the engine when the thing being chased arrives', async () => {
  const { harness, TENANT, MATTER, USER, idRefer } = await import('./helpers');
  const { pendingDecisions } = await import('../../../lib/server/engine/types');
  const h = harness();
  await h.store.setLevel(TENANT, 'chase', 'propose', null);
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  h.advanceDays(6);
  await h.svc.tick(TENANT, MATTER);
  let s = await h.svc.getState(TENANT, MATTER);
  const proposal = Object.values(s.proposals).find((p) => p.action === 'chase' && p.status === 'pending' && (p.detail as { kind?: string }).kind !== 'request');
  assert.ok(proposal, 'the chase is proposed, not sent');
  assert.ok(pendingDecisions(s).some((d) => d.kind === 'proposal'));
  // The result comes back (flagged, so a person still has to look at it) — the chase is off the table either way.
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idRefer()));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.proposals[proposal!.eventId].status, 'rejected');
  assert.equal(s.proposals[proposal!.eventId].resolvedBy, 'system');
  assert.ok(!Object.values(s.proposals).some((p) => p.status === 'pending' && p.action === 'chase' && (p.detail as { kind?: string }).kind !== 'request'), 'no stale chase left in Tasks');
  assert.ok(s.waits.every((w) => w.key !== 'id_check' || w.closedAt), 'the wait closed on arrival');
});

test('at Propose a clean result still closes its wait on arrival, and the held clear is a task a person sees', async () => {
  const { harness, TENANT, MATTER, USER, idClear } = await import('./helpers');
  const { blockingDecisions, pendingDecisions } = await import('../../../lib/server/engine/types');
  const { matterWork } = await import('../../../lib/server/engine/work');
  const h = harness();
  await h.store.setLevel(TENANT, 'auto_clear', 'propose', null);
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.idCheck.status, 'requested', 'the clear itself is held for approval');
  assert.ok(s.waits.every((w) => w.key !== 'id_check' || w.closedAt), 'the wait closed: the result is in, nobody should be chased for it');
  const held = pendingDecisions(s).find((d) => d.kind === 'auto_clear');
  assert.ok(held && s.pendingAutoClears[held.eventId]);
  assert.ok(blockingDecisions(s).some((d) => d.eventId === held!.eventId), 'a held clear blocks');
  const work = matterWork(s, h.ports.now());
  assert.ok(work.items.some((i) => i.bucket === 'do' && /Confirm the rules' clear/.test(i.what)), 'the tray shows it');
  assert.ok(!work.items.some((i) => i.bucket === 'waiting' && /ID \/ AML/.test(i.what)), 'nothing left in Waiting for it');
});
