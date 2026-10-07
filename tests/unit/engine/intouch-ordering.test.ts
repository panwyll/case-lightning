/** An InTouch firm orders searches and the ID check on the InTouch matter: we never order or ask a second time, and never chase what InTouch ordered. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, TENANT, MATTER, USER } from './helpers';
import { dueActions } from '../../../lib/server/engine/sla';
import { matterWork } from '../../../lib/server/engine/work';
import { INTOUCH_PROVIDER, openWaits, pendingDecisions } from '../../../lib/server/engine/types';

function inTouchFirm() {
  const h = harness();
  (h.ports as { orderedIn?: unknown; autoStartOnEnrol?: boolean }).orderedIn = async () => ({ searches: true, idChecks: true });
  (h.ports as { autoStartOnEnrol?: boolean }).autoStartOnEnrol = true;
  return h;
}

test('the ID check is recorded as coming from InTouch: no task, no provider request, no email to the client', async () => {
  const h = inTouchFirm();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] } as never);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.idCheck.status, 'requested');
  assert.equal(pendingDecisions(s).filter((d) => d.kind === 'proposal').some((d) => /id_check/.test(d.subject ?? '')), false, 'no "Send the client the ID check" task');
  assert.equal((h.ports.clientComms as unknown as { sent: Array<{ template: string }> }).sent.filter((x) => x.template === 'id_check_request').length, 0, 'the client hears from InTouch, not us');
  const w = openWaits(s).find((x) => x.key === 'id_check')!;
  assert.equal(w.via, 'intouch');
});

test('searches are recorded as ordered in InTouch at pre-contract: no order of our own, no stand-in result, never chased', async () => {
  const h = inTouchFirm();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29', 'LLC1'], requireProofOfFunds: false } as never);
  await h.svc.run(TENANT, MATTER, { type: 'advance_stage', actor: USER, to: 'pre_contract', reason: 'test' } as never).catch(() => null);
  let s = await h.svc.getState(TENANT, MATTER);
  if (s.stage !== 'pre_contract') {
    // Instruction's gates: let the ID result in, then the case moves on by itself.
    const { idClear } = await import('./helpers');
    await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
    s = await h.svc.getState(TENANT, MATTER);
  }
  assert.equal(s.stage, 'pre_contract');
  for (const t of ['CON29', 'LLC1'] as const) {
    assert.equal(s.searches[t]?.status, 'ordered', t);
    assert.equal(s.searches[t]?.documentId, null, `${t}: no stand-in result`);
  }
  const ordered = (await h.store.listEvents(TENANT, MATTER)).filter((e) => e.type === 'search_ordered');
  assert.ok(ordered.every((e) => (e.payload as { provider: string }).provider === INTOUCH_PROVIDER));
  assert.equal(pendingDecisions(s).filter((d) => d.kind === 'proposal').length, 0, 'no "Order the CON29 search" task');
  // Twenty working days on: nothing to chase (nobody for us to chase), but each overdue search is put to a person.
  const later = new Date(Date.parse(s.waits[0].openedAt) + 30 * 86_400_000);
  const due = dueActions(s, later).filter((a) => a.wait.key === 'search');
  assert.equal(due.filter((a) => a.kind === 'chase').length, 0);
  assert.equal(due.filter((a) => a.kind === 'escalate').length, 2);
  assert.equal(matterWork(s, later).items.filter((i) => /Order the|search order/i.test(i.what)).length, 0);
});

test('a firm whose searches and ID are not ordered in InTouch is unchanged', async () => {
  const h = harness();
  (h.ports as { autoStartOnEnrol?: boolean }).autoStartOnEnrol = true;
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] } as never);
  const s = await h.svc.getState(TENANT, MATTER);
  const asked = openWaits(s).find((x) => x.key === 'id_check');
  const proposed = pendingDecisions(s).some((d) => d.kind === 'proposal');
  assert.ok(asked || proposed, 'the ID check is requested or proposed by us, as before');
  assert.equal(asked?.via, undefined);
});
