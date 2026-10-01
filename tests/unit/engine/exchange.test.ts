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
