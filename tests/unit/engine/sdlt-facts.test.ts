/**
 * The SDLT basis worked out from the buyers' facts (sdlt-facts.ts), Wales (LTT), the replacement exception and its
 * refund diary, contradictions with the case's shape, the debt on a transfer of equity, and the seller's CGT flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cgtFlags, chargeableConsideration, deriveSdltBasis } from '../../../lib/server/engine/sdlt-facts';
import { computeSdlt } from '../../../lib/server/engine/sdlt';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const none = { shapes: [], relatedMatter: null } as Pick<MatterState, 'shapes' | 'relatedMatter'>;

test("first-time buyers' relief needs every buyer never to have owned and a main residence; a second home means the higher rates", () => {
  assert.equal(deriveSdltBasis({ mainResidence: true, anyEverOwned: false }, none).basis.firstTimeBuyer, true);
  assert.equal(deriveSdltBasis({ mainResidence: false, anyEverOwned: false }, none).basis.firstTimeBuyer, false);
  const second = deriveSdltBasis({ mainResidence: false, anyEverOwned: true, anyOwnsOther: true }, none);
  assert.equal(second.basis.additionalProperty, true);
  assert.match(second.reasons[0], /higher rates apply/);
});

test('replacing the main residence: no higher rates when the old home sells first (or on the linked sale); otherwise higher rates and a refund diary', () => {
  const first = deriveSdltBasis({ mainResidence: true, anyEverOwned: true, anyOwnsOther: true, replacing: true, replacingFirst: true }, none);
  assert.equal(first.basis.additionalProperty, false);
  assert.equal(first.refundDiary, false);
  const chain = deriveSdltBasis({ mainResidence: true, anyEverOwned: true, anyOwnsOther: true, replacing: true }, { shapes: [], relatedMatter: { matterId: 'x', relation: 'sale' } } as never);
  assert.equal(chain.basis.additionalProperty, false, 'a linked sale of their own home completes no later than the purchase');
  const later = deriveSdltBasis({ mainResidence: true, anyEverOwned: true, anyOwnsOther: true, replacing: true }, none);
  assert.equal(later.basis.additionalProperty, true);
  assert.equal(later.refundDiary, true);
});

test('Wales: Land Transaction Tax, no first-time buyer relief, no non-resident surcharge, its own higher rates', () => {
  // £300,000 main rates: 6% of £75,000 = £4,500.
  assert.equal(computeSdlt(30_000_000, { firstTimeBuyer: true, additionalProperty: false, nonUkResident: true, wales: true }).totalPennies, 450_000);
  // Higher rates on £300,000: 5% of 180k + 8.5% of 70k + 10% of 50k = 9,000 + 5,950 + 5,000 = £19,950.
  assert.equal(computeSdlt(30_000_000, { firstTimeBuyer: false, additionalProperty: true, nonUkResident: false, wales: true }).totalPennies, 1_995_000);
});

test('a shape the answers contradict is said out loud; the debt on a transfer of equity is chargeable', () => {
  const lisa = deriveSdltBasis({ mainResidence: true, anyEverOwned: true }, { shapes: ['lifetime_isa'], relatedMatter: null } as never);
  assert.match(lisa.contradictions[0], /Lifetime ISA/);
  const toe = { ...initialState(TENANT, MATTER), transactionType: 'transfer_of_equity' as const, considerationPennies: 5_000_000, sdltFacts: { debtAssumedPennies: 10_000_000 } };
  assert.equal(chargeableConsideration(toe), 15_000_000);
});

test('in the machine: recorded answers set the basis with reasons; a changed answer raises the change with both figures', () => {
  let s: MatterState = { ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_contract', purchasePricePennies: 40_000_000 };
  let seq = 0;
  const run = (cmd: Record<string, unknown>) => { const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: new Date('2026-10-01T10:00:00Z') }); s = events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: '2026-10-01T10:00:00Z', sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s); };
  run({ type: 'record_sdlt_facts', mainResidence: true, anyEverOwned: false });
  assert.equal(s.sdltBasis?.firstTimeBuyer, true);
  assert.ok(s.sdltFacts?.reasons?.length);
  run({ type: 'record_sdlt_facts', mainResidence: true, anyEverOwned: true });
  const changed = Object.values(s.issues).find((i) => i.title.startsWith('SDLT basis changed'))!;
  assert.match(changed.title, /£5,000\.00 → £10,000\.00/);
});

test("the seller's CGT answers: a flag, never advice", () => {
  assert.equal(cgtFlags({ mainResidenceThroughout: true, ukResident: true }).length, 0);
  assert.match(cgtFlags({ mainResidenceThroughout: false, ukResident: true })[0], /60 days/);
  assert.match(cgtFlags({ mainResidenceThroughout: true, ukResident: false })[0], /non-resident/);
});
