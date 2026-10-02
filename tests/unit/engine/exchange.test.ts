/**
 * Exchange (docs/eventualities/exchange.md): the formula, who we spoke to and where the deposit went are recorded and
 * filed as a memorandum; exchanging and completing the same day needs completion in hand; an amended contract lapses
 * the client's authority; a notice to complete served on our client says what is at stake; rescission follows only an
 * expired notice; the target exchange date is watched; a linked file collapsing tells the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { deadlineActions } from '../../../lib/server/engine/sla';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { harness, TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const i0 = initialState(TENANT, MATTER);
const ready = (over: Partial<MatterState> = {}): MatterState => ({ ...i0, enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_exchange', hasLender: false, requireExchangeAuthority: false, purchasePricePennies: 30_000_000, readiness: { ...i0.readiness, contractApprovedAt: 'x', signedContractHeldAt: 'x' }, exchange: { ...i0.exchange, conditionsMet: true }, ...over });

test('the formula, who we spoke to and the deposit route are recorded; a formula that is not A, B or C is refused', () => {
  assert.throws(() => fold(ready(), { type: 'contracts_exchanged', completionDate: '2026-10-16', formula: 'D' }), /A, B or C/);
  const s = fold(ready(), { type: 'contracts_exchanged', completionDate: '2026-10-16', formula: 'formula b', spokeWith: 'Jane at Smith & Co', depositRoute: 'held_by_us' });
  assert.equal(s.exchange.formula, 'B');
  assert.equal(s.exchange.spokeWith, 'Jane at Smith & Co');
});

test('exchanging and completing the same day needs the money, the priority search and the transfer in hand', () => {
  assert.throws(() => fold(ready(), { type: 'contracts_exchanged', completionDate: '2026-10-01', exchangedAt: '2026-10-01T09:30:00Z' }), /complete today without the client's money in, a priority search \(OS1\), the seller's signed transfer/);
});

test('an amended contract lapses the authority to exchange', () => {
  const authorised = { ...ready({ requireExchangeAuthority: true, readiness: { ...i0.readiness, contractDocumentId: 'c1' } }), clientDecisions: { exchange_authority: { decision: 'authorised', at: 'x', by: USER, note: null } } } as MatterState;
  const s = fold(authorised, { type: 'raise_contract_review', documentId: 'c2', summary: 'amended draft' });
  assert.equal(s.clientDecisions.exchange_authority, undefined);
});

test("a notice to complete served on our buyer says the deposit made up to 10% is at stake; rescission only follows an expired notice", () => {
  const exchanged = ready({ stage: 'pre_completion', exchange: { ...i0.exchange, exchangedAt: '2026-09-01T10:00:00Z', completionDate: '2026-09-20' } });
  const s = fold(exchanged, { type: 'notice_to_complete_served', servedBy: 'seller', expiresAt: '2026-10-05', documentId: 'n1' });
  const i = Object.values(s.issues).find((x) => x.title.startsWith('Notice to complete served on our client'))!;
  assert.equal(i.severity, 'critical');
  assert.match(i.detail ?? '', /made up to 10% of the price \(£30,000\.00\)/);
  assert.throws(() => fold(s, { type: 'abandon_matter', reason: 'rescinded' }), /expired notice/);
});

test('the target exchange date is watched as it approaches', () => {
  const s = ready({ targetExchangeDate: '2026-10-05' });
  assert.ok(deadlineActions(s, NOW).some((d) => d.kind === 'target_exchange'));
});

test('a linked sale abandoned tells the purchase at once, holding its exchange', async () => {
  const h = harness();
  const SALE = '99999999-9999-4999-8999-999999999999';
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requireProofOfFunds: false, requireExchangeAuthority: false, requiredSearches: [] } as never);
  await h.svc.run(TENANT, SALE, { type: 'enrol', actor: USER, transactionType: 'freehold_sale', hasLender: false, requiredSearches: [] } as never);
  await h.svc.linkChain(TENANT, MATTER, SALE, USER);
  await h.svc.run(TENANT, SALE, { type: 'abandon_matter', actor: USER, reason: 'client_withdrew' } as never);
  const purchase = await h.svc.getState(TENANT, MATTER);
  const told = Object.values(purchase.issues).find((x) => x.title === "The client's linked sale has fallen through")!;
  assert.equal(told.gate, 'exchange');
});

test("a survey the client booked holds exchange until the report is back or they decide to go ahead without it", () => {
  const booked = ready({ survey: { ...i0.survey, plan: { plan: 'booked', date: '2026-10-10', at: 'x' } } });
  assert.throws(() => fold(booked, { type: 'contracts_exchanged', completionDate: '2026-10-16', formula: 'B', spokeWith: 'J' }), /survey is booked and the report is not back/);
  const goAhead = { ...booked, clientDecisions: { accept_risk: { decision: 'accepted', at: 'x', by: USER, note: 'Exchange without waiting' } } } as MatterState;
  assert.equal(fold(goAhead, { type: 'contracts_exchanged', completionDate: '2026-10-16', formula: 'B', spokeWith: 'J' }).exchange.exchangedAt !== null, true);
});

test('a mortgage offer withdrawn after exchange is a critical money issue holding completion, not a reset', () => {
  const s = ready({ hasLender: true, stage: 'pre_completion', mortgage: { ...i0.mortgage, status: 'cleared' }, exchange: { ...i0.exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2026-10-16' } });
  const after = fold(s, { type: 'mortgage_offer_withdrawn', reason: 'Valuation revised down' });
  const i = Object.values(after.issues)[0];
  assert.equal(i.kind, 'mortgage_at_risk');
  assert.equal(i.gate, 'completion');
  assert.equal(after.mortgage.status, 'cleared', 'the offer record stands; the issue carries the emergency');
});

test("a completion date in the draft contract after the offer expires is raised before exchange", async () => {
  const { contractFindings } = await import('../../../lib/server/engine/findings');
  const f = contractFindings({ pricePennies: 1, depositPennies: 1, depositHolder: null, noticeToCompleteDays: 10, specialConditions: [], completionDate: '2027-03-01' }, { side: 'buyer', hasLender: true, offerExpiry: '2027-02-01' });
  assert.equal(f[0].code, 'COMPLETION_AFTER_OFFER');
});

test('a Formula C release locks the deal until it lapses or contracts are exchanged', () => {
  const authorised = { ...ready({ requireExchangeAuthority: true }), clientDecisions: { exchange_authority: { decision: 'authorised', at: 'x', by: USER, note: null } } } as MatterState;
  assert.throws(() => fold(authorised, { type: 'formula_c_release_given', until: '2026-10-02T15:00:00Z', givenTo: 'J' }), /same day/);
  const released = fold(authorised, { type: 'formula_c_release_given', until: '2026-10-01T15:00:00Z', givenTo: 'Jane at Smith & Co' });
  assert.throws(() => fold(released, { type: 'record_price_change', toPennies: 29_000_000, reason: 'late cut' }), /release is live/);
  assert.throws(() => fold(released, { type: 'client_decision_recorded', subject: 'exchange_authority', decision: 'withdrawn', note: 'changed mind' }), /release is live/);
  const lapsed = fold(released, { type: 'formula_c_release_lapsed', reason: 'Not called by 3pm' });
  assert.equal(lapsed.exchange.release, null);
});

test('damage between exchange and completion, and vacant possession not given, are critical issues holding completion', () => {
  const exchanged = ready({ stage: 'pre_completion', exchange: { ...i0.exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2026-10-16' } });
  const damaged = fold(exchanged, { type: 'record_property_event', event: 'damaged', detail: 'Burst pipe flooded the kitchen' });
  const d = Object.values(damaged.issues)[0];
  assert.equal(d.gate, 'completion');
  assert.match(d.detail ?? '', /seller keeps the risk until completion/);
  const occupied = fold(exchanged, { type: 'record_property_event', event: 'not_vacant', detail: 'The tenant has not moved out' });
  assert.match(Object.values(occupied.issues)[0].detail ?? '', /Do not complete without the client's instructions/);
});

test("on a sale the buyer's deposit is ours to confirm after exchange; a completion months away is raised at exchange", async () => {
  const { dueSteps } = await import('../../../lib/server/engine/due');
  const sale = ready({ transactionType: 'freehold_sale', stage: 'exchanged', exchange: { ...i0.exchange, exchangedAt: '2026-09-30T10:00:00Z', completionDate: '2026-10-16' } });
  assert.ok(dueSteps(sale, NOW).some((x) => x.key === 'deposit_in'));
  const far = fold(ready(), { type: 'contracts_exchanged', completionDate: '2027-02-01', formula: 'B', spokeWith: 'J' });
  assert.ok(Object.values(far.issues).some((x) => /more than three months after exchange/.test(x.title)));
});

test('a client who withdraws before exchange: the other side and the agent are told, but never on an AML stop', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requireProofOfFunds: false, requireExchangeAuthority: false, requiredSearches: [] } as never);
  await h.svc.run(TENANT, MATTER, { type: 'abandon_matter', actor: USER, reason: 'client_withdrew' } as never);
  const s = await h.svc.getState(TENANT, MATTER);
  const told = Object.values(s.proposals).filter((p) => p.dedupKey.startsWith('cp:withdrawn:')).length + h.ports.chaser.notices.filter((n: { template?: string; context?: { milestone?: string } }) => n.context?.milestone === 'withdrawn').length;
  assert.ok(told >= 1);
  const h2 = harness();
  await h2.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requireProofOfFunds: false, requireExchangeAuthority: false, requiredSearches: [] } as never);
  await h2.svc.run(TENANT, MATTER, { type: 'abandon_matter', actor: USER, reason: 'aml' } as never);
  const s2 = await h2.svc.getState(TENANT, MATTER);
  assert.equal(Object.values(s2.proposals).filter((p) => p.dedupKey.startsWith('cp:withdrawn:')).length, 0);
});
