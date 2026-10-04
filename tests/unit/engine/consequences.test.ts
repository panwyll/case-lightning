/**
 * Consequences (machine.ts "consequences"): when a fact the case rests on changes, what was built on it is done again.
 * Who the clients are, the price, the funding and the completion date each carry the lender, the funds, the tax, the
 * contract and the client's own answers with them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, TENANT, MATTER, USER } from './helpers';
import { decide } from '../../../lib/server/engine/machine';

async function jointPurchase() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [], requireProofOfFunds: true, requireExchangeAuthority: true, parties: 2, partyNames: ['Asha Patel', 'Ben Carter'] });
  await h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 30_000_000, reason: 'Agreed price' });
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'ownership_basis', decision: 'joint_tenants', note: 'Both confirmed joint tenants by email' });
  if ((await h.svc.getState(TENANT, MATTER)).proofOfFunds.status === 'not_started') await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  return h;
}
const openKinds = (s: { issues: Record<string, { kind: string; status: string; gate: string; title: string }> }) => Object.values(s.issues).filter((i) => i.status === 'open').map((i) => `${i.kind}:${i.gate}`);

test('one buyer pulls out before exchange and the other buys alone: contract parties, the lender, the funds, the SDLT basis and how they own it are all done again', async () => {
  const h = await jointPurchase();
  const r = await h.svc.run(TENANT, MATTER, { type: 'set_clients', actor: USER, names: ['Asha Patel'], reason: 'Ben has withdrawn; Asha buying alone' });
  const kinds = openKinds(r.state);
  for (const k of ['client_change:exchange', 'lender_approval:exchange', 'source_of_funds:exchange', 'sdlt_basis:none']) assert.ok(kinds.includes(k), `${k} in ${kinds.join(', ')}`);
  assert.equal(r.state.clientDecisions.ownership_basis, undefined, 'how they own it was a joint answer: it lapses');
  assert.equal(r.state.parties, 1);
  assert.ok(Object.values(r.state.issues).some((i) => /Ben Carter no longer a party/.test(i.title)));
});

test('a correction to how a name is spelt is not a change of client', async () => {
  const h = await jointPurchase();
  const r = await h.svc.run(TENANT, MATTER, { type: 'set_clients', actor: USER, names: ['Asha Patel', 'Benjamin Carter'], reason: 'Correct spelling of the full name' });
  assert.ok(!Object.values(r.state.issues).some((i) => i.kind === 'client_change'));
});

test('after exchange the contract binds every buyer: a change holds completion until the seller and lender agree', async () => {
  const h = await jointPurchase();
  const s = await h.svc.getState(TENANT, MATTER);
  const exchanged = { ...s, stage: 'pre_completion' as const, exchange: { ...s.exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2026-10-20' } };
  const { events } = decide(exchanged, { type: 'set_clients', actor: USER, names: ['Asha Patel'], reason: 'Separation' }, { now: new Date('2026-10-01T10:00:00Z') });
  const change = events.find((e) => e.type === 'issue_raised' && (e.payload as { kind: string }).kind === 'client_change')!.payload as { gate: string; detail: string };
  assert.equal(change.gate, 'completion');
  assert.match(change.detail, /deed of variation/);
});

test('the client\'s authority to exchange lapses when the price or the funding changes, and they are asked again', async () => {
  const h = await jointPurchase();
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'exchange_authority', decision: 'authorised', note: 'Authority given by email' });
  let r = await h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 29_000_000, reason: 'Renegotiated after the survey' });
  assert.equal(r.state.clientDecisions.exchange_authority, undefined);
  assert.ok(h.ports.clientComms.sent.some((m) => m.template === 'exchange_authority_request' && /price changed to £290,000/.test(String(m.context.noteToClient))));
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'exchange_authority', decision: 'authorised', note: 'Authority given by email' });
  r = await h.svc.run(TENANT, MATTER, { type: 'set_funding', actor: USER, hasLender: false, reason: 'Mortgage declined; parents funding' });
  assert.equal(r.state.clientDecisions.exchange_authority, undefined);
});

test('the completion date moves after exchange: the statement, the lender (with the advance already in) and the linked case follow it', async () => {
  const h = await jointPurchase();
  const s = await h.svc.getState(TENANT, MATTER);
  const moving = { ...s, stage: 'pre_completion' as const, exchange: { ...s.exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2026-10-20' }, completion: { ...s.completion, statementGeneratedAt: '2026-09-21T10:00:00Z', receivedFrom: ['lender' as const] }, deeds: { ...s.deeds, certificateOfTitleAt: '2026-10-13T10:00:00Z' }, relatedMatter: { matterId: 'other', role: 'sale' } as never };
  const { events } = decide(moving, { type: 'change_completion_date', actor: USER, completionDate: '2026-10-27', reason: 'Seller cannot vacate' }, { now: new Date('2026-10-14T10:00:00Z') });
  const titles = events.filter((e) => e.type === 'issue_raised').map((e) => (e.payload as { title: string }).title);
  assert.ok(titles.some((t) => /Completion statement: re-issue for Tuesday, 27 October 2026/.test(t)));
  assert.ok(titles.some((t) => /Tell the lender: completion moved/.test(t)));
  assert.ok(titles.some((t) => /Linked case: move its completion date/.test(t)));
  const lender = events.find((e) => (e.payload as { title?: string }).title?.startsWith('Tell the lender'))!.payload as { detail: string };
  assert.match(lender.detail, /advance is already with us/);
});
