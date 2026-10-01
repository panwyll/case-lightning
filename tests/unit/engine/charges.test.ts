/**
 * Every charge on a sale (charges.ts): the title read adds each charge beyond the mortgage; each needs its figure
 * before exchange, is paid off and discharged; owing more than the price is negative equity; our undertaking covers
 * them all and is discharged once they are off. On a purchase the seller's TA13 undertaking is required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, stageBlockers, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { initialState, type EngineEvent, type MatterState, type TitleFacts } from '../../../lib/server/engine/types';
import { chargeeOf, isFinancialCharge } from '../../../lib/server/engine/charges';
import { dueSteps } from '../../../lib/server/engine/due';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;
function fold(s: MatterState, cmd: Record<string, unknown>): MatterState {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
}
const sale = (over: Partial<MatterState> = {}): MatterState => ({ ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_sale', stage: 'pre_contract', hasExistingMortgage: true, purchasePricePennies: 30_000_000, redemption: { ...initialState(TENANT, MATTER).redemption, status: 'requested' }, ...over });
const register = (charges: string[]): TitleFacts => ({ titleNumber: 'AB1', tenure: 'freehold', restrictions: [], covenants: [], confidence: 0.95, charges: charges.map((text, i) => ({ code: `C${i + 1}`, register: 'C' as const, text })) });

test('the charges register read: what is a charge and who it is in favour of', () => {
  assert.ok(isFinancialCharge('Registered charge dated 3 March 2020 in favour of Together Commercial Finance Limited.'));
  assert.ok(!isFinancialCharge('Notice of home rights registered by Jane Smith.'));
  assert.equal(chargeeOf('Registered charge dated 3 March 2020 in favour of Together Commercial Finance Limited.'), 'Together Commercial Finance Limited');
});

test('a second charge on a sale is added from the title, holds exchange until its figure is in, and is checked with the mortgage against the price', () => {
  let s = fold(sale(), { type: 'title_extracted', documentId: 'doc-title', extractor: 'test', facts: register(['Registered charge dated 1 May 2019 in favour of Nationwide Building Society.', 'Registered charge dated 3 March 2020 in favour of Together Commercial Finance Limited.']) });
  assert.deepEqual(s.otherCharges.map((c) => c.chargee), ['Together Commercial Finance Limited'], 'the first charge is the mortgage already on the case');
  const [ch] = s.otherCharges;
  assert.ok(dueSteps(s, NOW).some((d) => d.key === `charge_statement:${ch.id}`));
  s = { ...s, stage: 'pre_exchange' };
  assert.match(stageBlockers(s).join(' | '), /redemption figure awaited from Together/);
  s = fold(s, { type: 'redemption_statement_received', redemptionPennies: 25_000_000 });
  s = fold(s, { type: 'charge_statement_received', chargeId: ch.id, redemptionPennies: 6_000_000 });
  const ne = Object.values(s.issues).find((i) => i.title.startsWith('Negative equity'))!;
  assert.equal(ne.gate, 'exchange');
  assert.match(ne.detail ?? '', /£10,000\.00/);
  // A better figure clears it.
  s = fold(s, { type: 'charge_statement_received', chargeId: ch.id, redemptionPennies: 4_000_000 });
  assert.equal(Object.values(s.issues).find((i) => i.id === ne.id)!.status, 'resolved');
});

test('after completion each charge is paid off and its discharge waited for; the undertaking is discharged once every charge is off; then the file closes', () => {
  const base = sale({ stage: 'post_completion', exchange: { ...initialState(TENANT, MATTER).exchange, exchangedAt: '2026-09-01T10:00:00Z', completionDate: '2026-09-20' }, completion: { ...initialState(TENANT, MATTER).completion, confirmedAt: '2026-09-20T12:00:00Z' }, redemption: { ...initialState(TENANT, MATTER).redemption, status: 'discharged', redemptionPennies: 25_000_000 }, undertaking: { givenAt: '2026-09-10T10:00:00Z', to: "The buyer's solicitor", terms: 'redeem', dischargedAt: null }, otherCharges: [{ id: 'CH-1', chargee: 'Together', text: null, status: 'received', redemptionPennies: 4_000_000, validUntil: null, redeemedAt: null, dischargedAt: null }] });
  assert.ok(dueSteps(base, NOW).some((d) => d.key === 'charge_redeemed:CH-1'));
  assert.throws(() => fold(base, { type: 'close_matter' }), /Not yet discharged: Together/);
  let s = fold(base, { type: 'charge_redeemed', chargeId: 'CH-1' });
  assert.ok(s.waits.some((w) => w.key === 'discharge' && w.subject === 'CH-1' && !w.closedAt), 'its own discharge, chased');
  assert.throws(() => fold(s, { type: 'undertaking_discharged' }), /Every charge must be discharged/);
  s = fold(s, { type: 'charge_discharged', chargeId: 'CH-1', reference: 'DS1' });
  assert.ok(dueSteps(s, NOW).some((d) => d.key === 'undertaking_discharge'));
  assert.match(stageBlockers(s).join(' | '), /discharges not yet sent to the buyer's solicitor/);
  s = fold(s, { type: 'undertaking_discharged' });
  assert.deepEqual(stageBlockers(s), ['final bill not delivered']);
  s = fold(s, { type: 'final_bill_delivered', amountPennies: 150_000 });
  assert.deepEqual(stageBlockers(s), ['matter complete']);
});

test("a purchase completes only with the seller's TA13, and with their undertaking where the seller's title is charged", () => {
  const s = { ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase' as const, stage: 'pre_completion' as const, title: { ...initialState(TENANT, MATTER).title, facts: register(['Registered charge in favour of Barclays Bank UK PLC.']) } };
  assert.match(stageBlockers(s).join(' | '), /completion information \(TA13\) not received/);
  const withTa13 = fold({ ...s, stage: 'exchanged' as const, exchange: { ...s.exchange, exchangedAt: '2026-09-01T10:00:00Z' } }, { type: 'completion_information_received', undertakingToRedeem: false });
  assert.match(stageBlockers({ ...withTa13, stage: 'pre_completion' }).join(' | '), /no undertaking from the seller's solicitor/);
});
