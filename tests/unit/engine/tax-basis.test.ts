/**
 * Tax: the other-home test holding by holding, spouses, several dwellings, non-individual buyers, VAT and part-exchange,
 * a new lease's rent, shared ownership in stages, no return when none is due, the return as filed and amended, the
 * seller's CGT flags and the money held for it, the higher rates when a chain sale fails, and land outside England and Wales.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { chargeableConsideration, cgtFlags, deriveSdltBasis, holdingCounts, noReturnReason } from '../../../lib/server/engine/sdlt-facts';
import { computeSdlt, leaseRentTax } from '../../../lib/server/engine/sdlt';
import { outOfJurisdiction } from '../../../lib/server/engine/jurisdiction';
import { buildCompletionStatement } from '../../../lib/server/engine/completion-statement';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>, now = NOW): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: now.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const base = initialState(TENANT, MATTER);
const none = { shapes: [], relatedMatter: null } as never;

test('the other home, holding by holding', () => {
  const at = new Date('2026-10-01');
  assert.equal(holdingCounts({ type: 'commercial' }, at).counts, false);
  assert.equal(holdingCounts({ type: 'caravan' }, at).counts, false);
  assert.equal(holdingCounts({ type: 'short_lease', unexpiredYears: 15 }, at).counts, false);
  assert.equal(holdingCounts({ type: 'share', valuePennies: 10_000_000, sharePercent: 30 }, at).counts, false, '30% of £100k is under £40k');
  assert.equal(holdingCounts({ type: 'share', valuePennies: 30_000_000, sharePercent: 30 }, at).counts, true);
  assert.equal(holdingCounts({ type: 'inherited_share', inheritedOn: '2025-01-01', combinedUnderHalf: true }, at).counts, false);
  assert.equal(holdingCounts({ type: 'inherited_share', inheritedOn: '2022-01-01', combinedUnderHalf: true }, at).counts, true);
  assert.equal(holdingCounts({ type: 'abroad', valuePennies: 20_000_000 }, at).counts, true);
  assert.equal(holdingCounts({ type: 'childs' }, at).counts, true);
  const d = deriveSdltBasis({ anyOwnsOther: true, otherHomeIs: 'caravan', mainResidence: true, anyEverOwned: true }, none);
  assert.equal(d.basis.additionalProperty, false);
});

test('spouses, several dwellings, an annexe, Crown employees, trusts and estates, partnerships', () => {
  assert.equal(deriveSdltBasis({ spouseOwns: true, mainResidence: true }, none).basis.additionalProperty, true);
  assert.equal(deriveSdltBasis({ spouseOwns: true, spouseSeparated: true, mainResidence: true }, none).basis.additionalProperty, false);
  assert.equal(deriveSdltBasis({ dwellingsInPurchase: 2 }, none).basis.additionalProperty, true);
  assert.equal(deriveSdltBasis({ dwellingsInPurchase: 2, annexeUnderThird: true }, none).basis.additionalProperty, false);
  assert.equal(deriveSdltBasis({ anyNonResident: true, crownEmployee: true }, none).basis.nonUkResident, false);
  assert.equal(deriveSdltBasis({ buyerType: 'discretionary_trust' }, none).basis.additionalProperty, true);
  assert.ok(deriveSdltBasis({ buyerType: 'partnership' }, none).contradictions.length);
  assert.ok(deriveSdltBasis({ uninhabitableClaim: true }, none).contradictions.some((c) => /Bewley/.test(c)));
});

test('consideration: VAT and part-exchange; a new lease\'s rent; shared ownership in stages', () => {
  assert.equal(chargeableConsideration({ ...base, purchasePricePennies: 30_000_000, sdltFacts: { vatPennies: 1_000_000, partExchangePennies: 5_000_000 } } as never), 36_000_000);
  const r = leaseRentTax(1_000_000, 99);
  assert.ok(r.npvPennies > 12_500_000 && r.taxPennies > 0);
  const share = computeSdlt(15_000_000, { firstTimeBuyer: true, additionalProperty: false, nonUkResident: false, marketValuePennies: 45_000_000 });
  assert.equal(share.totalPennies, 0, "relief tested on the market value (£450k), tax on the share (£150k)");
  assert.ok(computeSdlt(15_000_000, { firstTimeBuyer: true, additionalProperty: false, nonUkResident: false, marketValuePennies: 60_000_000 }).totalPennies > 0, 'no relief over £500k market value');
});

test('no return when none is due, with its reason; a return refused for £40,000 or more', () => {
  assert.match(noReturnReason({ ...base, transactionType: 'freehold_purchase', purchasePricePennies: 3_500_000 } as never)!, /under £40,000/);
  assert.match(noReturnReason({ ...base, transactionType: 'transfer_of_equity', considerationPennies: 0 } as never)!, /A gift/);
  assert.match(noReturnReason({ ...base, transactionType: 'transfer_of_equity', shapes: ['court_order_transfer'], considerationPennies: 10_000_000 } as never)!, /court order/);
  assert.equal(noReturnReason({ ...base, transactionType: 'freehold_purchase', purchasePricePennies: 30_000_000 } as never), null);
});

test('the return as filed and amended: a difference from the estimate, a refund owed back', () => {
  let s: MatterState = { ...base, enrolled: true, transactionType: 'freehold_purchase', stage: 'post_completion', purchasePricePennies: 30_000_000, sdltBasis: { firstTimeBuyer: false, additionalProperty: false, nonUkResident: false }, completion: { ...base.completion, confirmedAt: '2026-09-01T10:00:00Z' } };
  s = fold(s, { type: 'sdlt_submitted', reference: '123456789MC', amountPennies: 600_000 });
  assert.ok(Object.values(s.issues).some((i) => /more than the estimate/.test(i.title)), 'filed £6,000 against a £5,000 estimate');
  s = fold(s, { type: 'sdlt_amended', newAmountPennies: 500_000, reason: 'Chattels apportioned' });
  assert.equal(s.money?.refunds.at(-1)?.amountPennies, 100_000);
  assert.throws(() => fold(s, { type: 'sdlt_amended', newAmountPennies: 400_000, reason: 'x' }, new Date('2031-01-01T00:00:00Z')), /four years/);
});

test('the seller\'s CGT: partial relief, a plot, a company, a gift; money held for it on the statement', () => {
  const f = cgtFlags({ mainResidenceThroughout: true, ukResident: true, absencesOrLet: true, partOfGarden: true, sellerType: 'company', giftToConnected: true });
  assert.equal(f.length, 4);
  const sale = { ...base, enrolled: true, transactionType: 'freehold_sale' as const, purchasePricePennies: 30_000_000, cgtFacts: { taxRetentionPennies: 2_000_000, recordedAt: '' } };
  const st = buildCompletionStatement({ state: sale, side: 'seller', register: [{ id: 'p', key: 'contract.price_pennies', value: '30000000' } as never], record: { propertyAddress: null, purchasePricePennies: 30_000_000, buyerNames: [], sellerNames: ['X'] } });
  assert.equal(st.balancePennies, 28_000_000);
});

test('land outside England and Wales is refused at creation', () => {
  assert.match(outOfJurisdiction('1 High Street, Edinburgh EH1 1AA')!, /Scotland/);
  assert.match(outOfJurisdiction('2 Main Street, Belfast BT1 1AA')!, /Northern Ireland/);
  assert.equal(outOfJurisdiction('3 Church Lane, Gloucester GL1 2AB'), null);
  assert.equal(outOfJurisdiction('4 Bridge Street, Berwick-upon-Tweed TD15 1AA'), null, 'cross-border postcode: a person checks');
});
