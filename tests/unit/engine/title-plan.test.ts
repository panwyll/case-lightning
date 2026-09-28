/** A title plan is read as the map it is: beside the register, never as the register, checked for a second title and for what it marks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, TENANT, MATTER, USER, titleClear } from './helpers';
import { routeClassification } from '../../../lib/server/engine/ingest';

const plan = (titleNumber: string, other: Array<{ marking: string; marks: string }> = []) => ({ titleNumber, edgedRed: 'the house and rear garden', otherMarkings: other, notes: [], reference: 'OS 1:1250', confidence: 0.9 });

async function purchase() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false } as never);
  return h;
}

test('a plan classified as a plan is routed to the plan, not the title sub-flow', async () => {
  const h = await purchase();
  const s = await h.svc.getState(TENANT, MATTER);
  assert.deepEqual(routeClassification(s, { role: 'title_plan' } as never), { kind: 'title_plan' });
});

test('a plan read as the register is re-routed: the title stays awaiting, the plan is kept beside it', async () => {
  const h = await purchase();
  await h.svc.titleReceived(TENANT, MATTER, h.doc({ ...titleClear(), planOnly: true, ...plan('AB123456') } as never));
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.title.status, 'awaiting', 'the register has not been read');
  assert.equal(s.title.plans?.length, 1);
});

test('the title step flags a plan for a different title, and markings beyond the red edging', async () => {
  const h = await purchase();
  const { titleWithCharge } = await import('./helpers');
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleWithCharge()));
  await h.svc.titlePlanReceived(TENANT, MATTER, h.doc(plan('ZZ999', [{ marking: 'tinted brown', marks: 'a right of way over the drive' }])));
  const s = await h.svc.getState(TENANT, MATTER);
  const d = Object.values(s.decisions).find((x) => x.kind === 'title')!;
  assert.ok(d, 'a title with a charge puts the title to a person');
  const { taskContext } = await import('../../../lib/server/engine/context');
  const ctx = taskContext({ state: s, matter: { matterRef: null, propertyAddress: null }, events: [], target: { kind: 'decision', decision: d } });
  const lines = ctx.checklist.map((c) => `${c.status}: ${c.text} | ${c.evidence.map((e) => e.text).join(' / ')}`);
  assert.ok(lines.some((l) => /^flag: Title plan ZZ999: a different title from the register \(AB123456\)/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^flag: Title plan ZZ999: other markings.*tinted brown: a right of way over the drive/.test(l)), lines.join('\n'));
});
