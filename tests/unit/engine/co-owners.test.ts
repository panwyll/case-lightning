/**
 * Co-owners' money on the case (co-owners.ts): what each buyer puts in gives each owner's share at purchase under the
 * declaration's model; unequal money held as joint tenants is raised for advice; tenants in common unequally need the
 * figures before the declaration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { dueSteps } from '../../../lib/server/engine/due';
import { sharesAtPurchase, sharesText, unequal } from '../../../lib/server/engine/co-owners';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const i0 = initialState(TENANT, MATTER);
const pair = (decision: string): MatterState => ({ ...i0, enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_contract', parties: 2, partyNames: ['Asha Patel', 'Ben Carter'], hasLender: false, purchasePricePennies: 30_000_000, clientDecisions: { ownership_basis: { decision, at: NOW.toISOString() } } as never });

test('shares at purchase follow the money in proportion; a fixed model keeps its agreed shares', () => {
  const cs = [{ party: 'Asha Patel', pennies: 20_000_000 }, { party: 'Ben Carter', pennies: 10_000_000 }];
  const prop = sharesAtPurchase({ purchasePricePennies: 30_000_000, mortgage: i0.mortgage, hasLender: false }, 'CONTRIBUTION', cs, null, '2026-10-01');
  assert.equal(sharesText(prop), 'Asha Patel 66.67%, Ben Carter 33.33%');
  const fixed = sharesAtPurchase({ purchasePricePennies: 30_000_000, mortgage: i0.mortgage, hasLender: false }, 'FIXED', cs, { 'Asha Patel': 50, 'Ben Carter': 50 }, '2026-10-01');
  assert.equal(sharesText(fixed), 'Asha Patel 50%, Ben Carter 50%');
  assert.ok(unequal(cs));
  assert.ok(!unequal([{ party: 'A', pennies: 100 }, { party: 'B', pennies: 105 }]));
});

test('unequal money held as joint tenants is raised for advice before exchange, with the shares a declaration would give', () => {
  const s = fold(pair('joint_tenants'), { type: 'record_contributions', model: 'CONTRIBUTION', contributions: [{ party: 'Asha Patel', pennies: 20_000_000 }, { party: 'Ben Carter', pennies: 10_000_000 }] });
  const advice = Object.values(s.issues).find((i) => i.kind === 'co_ownership_advice')!;
  assert.equal(advice.gate, 'exchange');
  assert.match(advice.detail ?? '', /Asha Patel 66\.67%/);
  assert.equal(s.coOwnership?.shares.length, 2);
});

test('tenants in common in unequal shares: the figures are a task before the declaration, and a stranger\'s name is refused', () => {
  const s = pair('tenants_in_common_unequal');
  assert.ok(dueSteps(s, NOW).some((d) => d.key === 'contributions'));
  assert.throws(() => fold(s, { type: 'record_contributions', model: 'CONTRIBUTION', contributions: [{ party: 'Asha Patel', pennies: 1 }, { party: 'Someone Else', pennies: 1 }] }), /one of the clients/);
  assert.throws(() => fold(s, { type: 'record_contributions', model: 'FIXED', contributions: [{ party: 'Asha Patel', pennies: 1 }, { party: 'Ben Carter', pennies: 1 }], ratioPercent: { 'Asha Patel': 70, 'Ben Carter': 20 } }), /add up to 100/);
  const done = fold(s, { type: 'record_contributions', model: 'FIXED', contributions: [{ party: 'Asha Patel', pennies: 1 }, { party: 'Ben Carter', pennies: 1 }], ratioPercent: { 'Asha Patel': 70, 'Ben Carter': 30 } });
  assert.ok(!dueSteps(done, NOW).some((d) => d.key === 'contributions'));
});
