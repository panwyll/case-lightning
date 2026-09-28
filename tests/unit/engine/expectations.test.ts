/**
 * The client's own arrangements (the mortgage offer, the survey) happen in their time, so they
 * are expected from the start and checked on, never left to drift. A cash buyer has no mortgage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, TENANT, MATTER, USER, offerClear } from './helpers';

async function buyer(hasLender: boolean) {
  const h = harness(new Date('2026-09-14T09:00:00Z'));
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false } as never);
  await h.svc.tick(TENANT, MATTER);
  return h;
}
const openKeys = async (h: Awaited<ReturnType<typeof buyer>>) => (await h.svc.getState(TENANT, MATTER)).waits.filter((w) => w.closedAt === null).map((w) => w.key);

test('a cash buyer is never asked about a mortgage; the survey is still checked on', async () => {
  const h = await buyer(false);
  const keys = await openKeys(h);
  assert.ok(!keys.includes('mortgage_offer'));
  assert.ok(keys.includes('survey'));
});

test('a buyer with a lender is checked on for the offer a fortnight in, and it stops when the offer arrives', async () => {
  const h = await buyer(true);
  assert.ok((await openKeys(h)).includes('mortgage_offer'));
  h.ports.setNow(new Date('2026-09-28T09:00:00Z')); // 10 working days
  await h.svc.tick(TENANT, MATTER);
  assert.ok(h.ports.chaser.chases.some((c) => c.template === 'chase_mortgage_offer'));
  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc({ ...offerClear(), expiryDate: '2027-03-01' }));
  assert.ok(!(await openKeys(h)).includes('mortgage_offer'), 'closed when the offer lands');
});

test('a booked survey is not asked about before its date; "no survey" closes it for good', async () => {
  const h = await buyer(false);
  await h.svc.run(TENANT, MATTER, { type: 'record_survey_plan', actor: USER, plan: 'booked', date: '2026-10-05' });
  h.ports.setNow(new Date('2026-09-28T09:00:00Z'));
  await h.svc.tick(TENANT, MATTER);
  assert.ok(!h.ports.chaser.chases.some((c) => c.template === 'chase_survey'), 'booked: not chased before the date');
  await h.svc.run(TENANT, MATTER, { type: 'record_survey_plan', actor: USER, plan: 'none' });
  assert.ok(!(await openKeys(h)).includes('survey'));
  h.ports.setNow(new Date('2026-11-02T09:00:00Z'));
  await h.svc.tick(TENANT, MATTER);
  assert.ok(!(await openKeys(h)).includes('survey'), 'not reopened');
});

test('the mortgage is its own step: a buyer going cash drops it and anything waiting on it; taking one on adds it', async () => {
  const h = await buyer(true);
  await h.svc.run(TENANT, MATTER, { type: 'set_funding', actor: USER, hasLender: false, reason: 'Sold shares, buying outright' });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.hasLender, false);
  assert.equal(s.mortgage.status, 'not_required');
  assert.ok(!(await openKeys(h)).includes('mortgage_offer'));
  const { deedsToSign } = await import('../../../lib/server/engine/types');
  assert.deepEqual(deedsToSign(s), [], 'no mortgage deed for a cash buyer');
  await h.svc.run(TENANT, MATTER, { type: 'set_funding', actor: USER, hasLender: true, reason: 'Taking a mortgage after all' });
  await h.svc.tick(TENANT, MATTER);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.mortgage.status, 'awaiting');
  assert.ok((await openKeys(h)).includes('mortgage_offer'));
});

test('a cash buyer\'s survey check-in and signing chase never mention a lender', async () => {
  const { chaseContent } = await import('../../../lib/server/engine/chase-content');
  const h = await buyer(false);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(chaseContent(s, 'survey', '').valuationLine, '');
  assert.equal(chaseContent(s, 'signed_documents', '').lenderLine ?? '', '');
});
