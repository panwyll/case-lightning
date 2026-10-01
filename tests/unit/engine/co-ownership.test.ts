/**
 * Co-owners' money (lib/server/engine/co-ownership.ts): the research's worked example, in whole pennies. Purchase
 * £300,000 + £10,000 costs; A puts in £60,000, B nothing; joint mortgage £250,000 paid 50/50. Sale at £360,000,
 * costs £6,000, redemption £220,000: net £134,000.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apportion, buyOut, entitlements, type Contribution, type Owner } from '../../../lib/server/engine/co-ownership';

const owners: Owner[] = [{ id: 'a', name: 'Asha' }, { id: 'b', name: 'Ben' }];
const gbp = (n: number) => Math.round(n * 100);
const contributions: Contribution[] = [{ ownerId: 'a', type: 'DEPOSIT', pennies: gbp(50_000), date: '2024-01-01' }, { ownerId: 'a', type: 'SDLT', pennies: gbp(5_000), date: '2024-01-01' }, { ownerId: 'a', type: 'LEGAL_FEES', pennies: gbp(5_000), date: '2024-01-01' }];
const purchase = { pricePennies: gbp(300_000), mortgagePennies: gbp(250_000) };
const sale = { valuePennies: gbp(360_000), costsPennies: gbp(6_000), redemptionPennies: gbp(220_000) };
const pay = (r: ReturnType<typeof entitlements>) => Object.fromEntries(r.result.map((x) => [x.ownerId, x.pennies]));

test('every model adds up to the net proceeds exactly, to the penny', () => {
  for (const model of ['FIXED', 'RING_FENCE', 'CONTRIBUTION', 'FLOATING'] as const) {
    const r = entitlements(owners, contributions, { model }, purchase, sale);
    assert.equal(r.result.reduce((a, x) => a + x.pennies, 0), gbp(134_000), model);
    assert.equal(r.result.reduce((a, x) => a + x.shareBp, 0), 10_000, model);
  }
});

test('fixed, ring-fenced and contribution models give the worked figures', () => {
  assert.deepEqual(pay(entitlements(owners, contributions, { model: 'FIXED' }, purchase, sale)), { a: gbp(67_000), b: gbp(67_000) });
  assert.deepEqual(pay(entitlements(owners, contributions, { model: 'RING_FENCE' }, purchase, sale)), { a: gbp(50_000) + gbp(42_000), b: gbp(42_000) }, 'the deposit back first, the rest 50/50');
  const c = pay(entitlements(owners, contributions, { model: 'CONTRIBUTION' }, purchase, sale));
  assert.equal(Math.round(c.a / 100), 79_968);
  assert.equal(Math.round(c.b / 100), 54_032);
});

test('floating, five stages: A £100,346, B £33,654, with every stage kept', () => {
  const r = entitlements(owners, contributions, { model: 'FLOATING' }, purchase, sale);
  const p = pay(r);
  assert.equal(Math.round(p.a / 100), 100_346);
  assert.equal(Math.round(p.b / 100), 33_654);
  assert.equal(r.stages.length, 6);
});

test('negative equity is never capped at zero', () => {
  const r = entitlements(owners, contributions, { model: 'FLOATING' }, purchase, { valuePennies: gbp(240_000), costsPennies: gbp(4_000), redemptionPennies: gbp(245_000) });
  assert.equal(r.result.reduce((a, x) => a + x.pennies, 0), -gbp(9_000));
  assert.ok(r.result.some((x) => x.pennies < 0));
  assert.ok(r.warnings.some((w) => /Negative equity/.test(w)));
});

test('a buy-out: 50/50, value £360,000, mortgage £220,000: B is paid £70,000; SDLT consideration £180,000', () => {
  const r = buyOut(owners, ['b'], [], { model: 'FIXED' }, purchase, gbp(360_000), gbp(220_000));
  assert.equal(r.cashPennies, gbp(70_000));
  assert.equal(r.debtAssumedPennies, gbp(110_000));
  assert.equal(r.sdltConsiderationPennies, gbp(180_000));
  assert.ok(r.flags[0].includes('SDLT return'));
});

test('apportioning never loses or invents a penny', () => {
  const three = [...owners, { id: 'c', name: 'Cal' }];
  const out = apportion(100, three, { a: 1, b: 1, c: 1 });
  assert.equal(out.a + out.b + out.c, 100);
});
