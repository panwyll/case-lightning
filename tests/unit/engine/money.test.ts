/**
 * Money reconciled (engine/money.ts, machine.ts "Money reconciled"): every receipt is compared with what was asked for.
 * Short holds completion until it is made up; over is owed back; uncleared money cannot be paid out; a file that stops
 * gives back what it holds, to where it came from; a deposit short of the contract's holds exchange.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { dueSteps } from '../../../lib/server/engine/due';
import { heldOnAbandon, position } from '../../../lib/server/engine/money';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;

function purchase(over: Partial<MatterState> = {}): MatterState {
  const s = initialState(TENANT, MATTER);
  return {
    ...s,
    enrolled: true,
    transactionType: 'freehold_purchase',
    stage: 'pre_completion',
    hasLender: true,
    purchasePricePennies: 30_000_000,
    exchange: { ...s.exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2026-10-20' },
    deeds: { ...s.deeds, certificateOfTitleAt: '2026-09-25T10:00:00Z' },
    mortgage: { ...s.mortgage, facts: { lender: 'Nationwide', amountPennies: 22_500_000 } as never },
    waits: [
      { key: 'funds', subject: 'client', openedAt: '2026-09-25T10:00:00Z', closedAt: null } as never,
      { key: 'funds', subject: 'lender', openedAt: '2026-09-25T10:00:00Z', closedAt: null } as never,
    ],
    money: { requested: { client: 7_000_000 }, received: {}, uncleared: [], statementBalancePennies: 7_000_000, refunds: [] },
    ...over,
  };
}

/** Decide and fold, as the service does. */
function run(s: MatterState, cmd: Record<string, unknown>): { state: MatterState; events: EngineEvent[] } {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  const stamped = events.map((e) => ({ ...e, id: `e${++seq}`, seq: ++seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent));
  return { state: stamped.reduce(applyEvent, s), events: stamped };
}
const open = (s: MatterState, kind: string) => Object.values(s.issues).filter((i) => i.kind === kind && (i.status === 'open' || i.status === 'negotiating'));

test("the client's balance short of what was asked for holds completion, and the rest arriving clears it", () => {
  let { state } = run(purchase(), { type: 'funds_received', fromRole: 'client', amountPennies: 6_500_000, remitter: null });
  const [short] = open(state, 'completion_funds_shortfall');
  assert.ok(short, 'a shortfall issue');
  assert.equal(short.gate, 'completion');
  assert.match(short.title, /£5,000 still to come/);
  // The wait closed with the first receipt; the rest is sent against the same request.
  ({ state } = run(state, { type: 'funds_received', fromRole: 'client', amountPennies: 500_000, remitter: null }));
  assert.equal(open(state, 'completion_funds_shortfall').length, 0, 'made up: resolved');
  assert.equal(state.money.received.client, 7_000_000);
});

test("a lender that deducts its fee from the advance leaves the client to make up the difference", () => {
  let { state } = run(purchase(), { type: 'funds_received', fromRole: 'client', amountPennies: 7_000_000, remitter: null });
  assert.equal(open(state, 'completion_funds_shortfall').length, 0);
  ({ state } = run(state, { type: 'funds_received', fromRole: 'lender', amountPennies: 22_500_000 - 99_900, remitter: null }));
  const [short] = open(state, 'completion_funds_shortfall');
  assert.match(short.title, /£999 /);
  assert.match(short.detail ?? "", /The lender sent £224,001\.00 of £225,000\.00 \(the offer\)/);
});

test('a client who overpays is owed the surplus back, to the account it came from, and the file cannot close until it is returned', () => {
  const { state } = run(purchase(), { type: 'funds_received', fromRole: 'client', amountPennies: 7_100_000, remitter: 'A PATEL' });
  assert.equal(open(state, 'completion_funds_shortfall').length, 0);
  const [refund] = state.money.refunds;
  assert.equal(refund.amountPennies, 100_000);
  assert.equal(refund.to, 'A PATEL');
  assert.ok(dueSteps(state, NOW).some((d) => d.key === `refund:${refund.id}`), 'a task to return it');
  const closing = { ...state, stage: 'post_completion' as const, completion: { ...state.completion, confirmedAt: NOW.toISOString() }, hasLender: false, postCompletion: { ...state.postCompletion, ap1ConfirmedAt: NOW.toISOString() } };
  assert.throws(() => run(closing, { type: 'close_matter' }), /owed back/);
  const paid = run(state, { type: 'refund_paid', refundId: refund.id, reference: 'FPS 12345' }).state;
  assert.equal(paid.money.refunds[0].paidAt, NOW.toISOString());
  assert.ok(!dueSteps(paid, NOW).some((d) => d.key.startsWith('refund:')));
});

test('money not yet cleared cannot be paid out: completion and the completion payment wait for it', () => {
  const { state } = run(purchase(), { type: 'funds_received', fromRole: 'client', amountPennies: 7_000_000, remitter: null, uncleared: true });
  const [u] = state.money.uncleared;
  assert.ok(u);
  assert.ok(dueSteps(state, NOW).some((d) => d.key === `funds_cleared:${u.id}`));
  assert.throws(() => run(state, { type: 'completion_confirmed' }), /not cleared/);
  assert.throws(() => run(state, { type: 'payment_authorised', payeeKind: 'seller_solicitor', bankDetailsId: 'x', purpose: 'completion_monies' }), /cleared/);
  const cleared = run(state, { type: 'funds_cleared', receiptId: u.id }).state;
  assert.equal(cleared.money.uncleared.length, 0);
});

test('a file that stops gives back what it holds: the deposit and the balance to the client, the ISA bonus to the ISA manager', () => {
  const s = purchase({ stage: 'pre_exchange', exchange: { ...initialState(TENANT, MATTER).exchange }, deposit: { received: true, at: NOW.toISOString(), amountPennies: 3_000_000, contractPennies: 3_000_000 }, money: { requested: {}, received: { isa_provider: 100_000 }, uncleared: [], statementBalancePennies: null, refunds: [] } });
  const held = heldOnAbandon(s);
  assert.deepEqual(held.map((h) => [h.toRole, h.amountPennies]), [['client', 3_000_000], ['isa_provider', 100_000]]);
  const { state } = run(s, { type: 'abandon_matter', reason: 'client_withdrew', detail: null });
  assert.equal(state.money.refunds.length, 2);
  assert.equal(dueSteps(state, NOW).filter((d) => d.key.startsWith('refund:')).length, 2, 'refunds stay on the list after the file stops');
});

test("a deposit short of the contract's holds exchange until it is topped up", () => {
  const s = purchase({ stage: 'pre_exchange', exchange: { ...initialState(TENANT, MATTER).exchange } });
  let { state } = run(s, { type: 'deposit_received', amountPennies: 1_500_000, contractDepositPennies: 3_000_000 });
  const [d] = open(state, 'deposit_issue');
  assert.equal(d.gate, 'exchange');
  assert.match(d.title, /£15,000\.00 of the £30,000\.00/);
  ({ state } = run(state, { type: 'deposit_received', amountPennies: 1_500_000 }));
  assert.equal(open(state, 'deposit_issue').length, 0);
  assert.equal(state.deposit.amountPennies, 3_000_000);
  assert.throws(() => run(state, { type: 'deposit_received', amountPennies: 1 }), /already recorded/);
});

test("a sale expects the price less the deposit from the buyer's solicitor; short holds completion (no keys)", () => {
  const s = purchase({ transactionType: 'freehold_sale' as never, hasLender: false, waits: [], money: { requested: {}, received: {}, uncleared: [], statementBalancePennies: null, refunds: [] } });
  const { state } = run(s, { type: 'funds_received', fromRole: 'buyer_solicitor', amountPennies: 26_000_000, remitter: null, contractPricePennies: 30_000_000, contractDepositPennies: 3_000_000 });
  const [short] = open(state, 'completion_funds_shortfall');
  assert.match(short.title, /£10,000 /);
  assert.match(short.detail ?? "", /keys/);
});

test('a remortgage advance that does not clear the old mortgage is a shortfall', () => {
  const s = purchase({ transactionType: 'remortgage' as never, redemption: { ...initialState(TENANT, MATTER).redemption, status: 'received', redemptionPennies: 23_000_000 }, money: { requested: {}, received: {}, uncleared: [], statementBalancePennies: null, refunds: [] } });
  const p = position(s, { lender: 22_500_000 });
  assert.equal(p.shortfallPennies, 500_000);
});
