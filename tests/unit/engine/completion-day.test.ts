/**
 * Completion day (completion.md §3, 4.3): the money is recorded as sent with its CHAPS reference before a purchase
 * completes; completing after the contract day, or after 2pm on it, raises the compensation (per 1% of the contract
 * rate); a redemption figure follows the completion date at its daily interest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>, now = new Date('2026-10-01T10:00:00Z')): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: now.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const i0 = initialState(TENANT, MATTER);

test('a purchase sends its money with a CHAPS reference, and only after the payment was authorised', () => {
  const s: MatterState = { ...i0, enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_completion', exchange: { ...i0.exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2026-10-01' } };
  assert.throws(() => fold(s, { type: 'completion_payment_sent', reference: 'X' }), /Authorise the completion payment/);
  const authorised = { ...s, payments: [{ payeeKind: 'seller_solicitor', purpose: 'completion_monies', bankDetailsId: 'b', amountPennies: 1, at: 'x', approvedBy: USER } as never] };
  const sent = fold(authorised, { type: 'completion_payment_sent', reference: 'CHAPS 1234' });
  assert.equal(sent.completion.paymentSent?.reference, 'CHAPS 1234');
});

test('completing two working days late, or after 2pm on the day, raises the compensation with the figure per 1%', () => {
  const s: MatterState = { ...i0, enrolled: true, transactionType: 'freehold_sale', stage: 'pre_completion', purchasePricePennies: 30_000_000, deposit: { ...i0.deposit, received: true, amountPennies: 3_000_000 }, exchange: { ...i0.exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2026-10-01' }, deeds: { ...i0.deeds, transferDeedAt: 'x' }, completion: { ...i0.completion, fundsReceivedAt: 'x' } };
  const late = fold(s, { type: 'completion_confirmed', completedAt: '2026-10-05T11:00:00Z' }, new Date('2026-10-05T11:00:00Z'));
  const i = Object.values(late.issues).find((x) => x.kind === 'completion_failure')!;
  assert.match(i.title, /2 working days/);
  assert.match(i.detail ?? '', /£270,000\.00\): £29\.59 for every 1% of the contract rate over 4 days/);
  const afternoon = fold(s, { type: 'completion_confirmed', completedAt: '2026-10-01T14:30:00Z' }, new Date('2026-10-01T14:30:00Z'));
  assert.match(Object.values(afternoon.issues)[0].detail ?? '', /after 2pm/);
  const onTime = fold(s, { type: 'completion_confirmed', completedAt: '2026-10-01T11:00:00Z' }, new Date('2026-10-01T11:00:00Z'));
  assert.equal(Object.values(onTime.issues).length, 0);
});

test('moving completion moves the redemption figure by its daily interest, and an out-of-date statement is raised', () => {
  let s: MatterState = { ...i0, enrolled: true, transactionType: 'freehold_sale', stage: 'pre_completion', hasExistingMortgage: true, exchange: { ...i0.exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2026-10-02' } };
  s = fold(s, { type: 'redemption_statement_received', redemptionPennies: 20_000_000, validUntil: '2026-10-05', dailyInterestPennies: 2_500 });
  s = fold(s, { type: 'change_completion_date', completionDate: '2026-10-09', reason: 'Chain delay' });
  assert.equal(s.redemption.redemptionPennies, 20_017_500);
  assert.ok(Object.values(s.issues).some((i) => i.kind === 'redemption_statement_expired'));
});
