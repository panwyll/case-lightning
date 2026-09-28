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

test('a tenure that cannot be read flags the title but does not pause the case; a pause can be resumed by a person with a reason', async () => {
  const h = await purchase();
  await h.svc.titleReceived(TENANT, MATTER, h.doc({ ...titleClear(), tenure: 'unknown' }));
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.manualHandling.required, false);
  await h.svc.run(TENANT, MATTER, { type: 'mark_manual_handling', actor: USER, reason: 'tenure_mismatch' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'resume_automation', actor: USER, reason: '' }), /Say why/);
  await h.svc.run(TENANT, MATTER, { type: 'resume_automation', actor: USER, reason: 'Tenure confirmed freehold from the register' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.manualHandling.required, false);
});

test('a supporting document is read and shown with the title; a policy that does not pass to the buyer is flagged, and an issue it may answer is pointed at it', async () => {
  const h = await purchase();
  const { titleWithCharge } = await import('./helpers');
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleWithCharge()));
  const r = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'building_regs_missing', title: 'Loft conversion without building regs sign-off' });
  const issueId = (r.events[0].payload as { issueId: string }).issueId;
  const policy = { kind: 'indemnity_policy', title: 'Lack of building regulations indemnity', covers: 'Loft conversion 2019', issuedBy: 'Stewart Title', reference: 'P-1', date: '2024-01-01', expires: '', limitPennies: 25_000_000, benefitPasses: null, property: '', notes: [], confidence: 0.9 };
  await h.svc.supportingDocumentReceived(TENANT, MATTER, h.doc(policy as never));
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.title.supporting?.length, 1);
  assert.match(s.issues[issueId].history.map((x) => x.what).join(' '), /may answer this: Lack of building regulations indemnity/);
  const d = Object.values(s.decisions).find((x) => x.kind === 'title')!;
  const { taskContext } = await import('../../../lib/server/engine/context');
  const lines = taskContext({ state: s, matter: { matterRef: null, propertyAddress: null }, events: [], target: { kind: 'decision', decision: d } }).checklist.map((c) => `${c.status}: ${c.text} | ${c.evidence.map((e) => e.text).join(' / ')}`);
  assert.ok(lines.some((l) => /^flag: Indemnity policy: Lack of building regulations indemnity.*cover passes to the buyer and lender: not stated/.test(l)), lines.join('\n'));
});

test('a TA6 read as a supporting document is read as the forms instead; a title read from a plan resets when the plan is re-read, so the register can be read', async () => {
  const h = await purchase();
  const ta6 = { kind: 'other', title: 'TA6 Law Society Property Information Form (6th edition)', covers: '', issuedBy: '', reference: '', date: '', expires: '', limitPennies: null, benefitPasses: null, property: '', notes: [], confidence: 0.9, forms: ['TA6'], disclosures: [], answers: { japaneseKnotweed: true } };
  const r = await h.svc.supportingDocumentReceived(TENANT, MATTER, h.doc(ta6 as never, 'EMAIL_ATTACHMENT'));
  assert.ok(r.events.some((e) => e.type === 'seller_forms_received'));
  assert.equal((await h.svc.getState(TENANT, MATTER)).title.supporting?.length ?? 0, 0);
  // Before plans were told apart, a plan was read as the register.
  const planDoc = h.doc({ ...titleClear(), titleNumber: 'TGL120253', tenure: 'unknown' } as never);
  await h.svc.titleReceived(TENANT, MATTER, planDoc);
  assert.equal((await h.svc.getState(TENANT, MATTER)).title.documentId, planDoc);
  await h.svc.run(TENANT, MATTER, { type: 'record_title_plan', documentId: planDoc, facts: { titleNumber: 'TGL120253', edgedRed: 'a garage', otherMarkings: [], notes: [], reference: '', confidence: 0.9 } });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.title.status, 'awaiting');
  assert.equal(s.title.documentId, null);
  // The register itself is now read, not refused as a duplicate.
  await h.svc.titleReceived(TENANT, MATTER, h.doc({ ...titleClear(), titleNumber: 'TGL129195' }));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.title.facts?.titleNumber, 'TGL129195');
});
