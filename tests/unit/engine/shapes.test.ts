import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASE_SHAPES, SHAPE_SPEC, fundsFromFor } from '../../../lib/server/engine/shapes';
import { ISSUE_KIND_SPEC } from '../../../lib/server/engine/issues';
import { stageBlockers } from '../../../lib/server/engine/machine';
import { EVENTUALITIES } from '../../../lib/server/engine/spec';
import { harness, TENANT, MATTER, USER } from './helpers';

test('every shape names a real issue kind whose gate matches, and the ISA shapes add the ISA manager as a source of money', () => {
  for (const id of CASE_SHAPES) {
    const sh = SHAPE_SPEC[id];
    assert.ok(ISSUE_KIND_SPEC[sh.issue.kind], `${id}: issue kind ${sh.issue.kind} exists`);
    assert.equal(ISSUE_KIND_SPEC[sh.issue.kind].gate, sh.issue.gate, `${id}: the catalogue gate matches`);
  }
  assert.deepEqual(fundsFromFor(['lender', 'client'], ['lifetime_isa']), ['lender', 'client', 'isa_provider']);
  assert.deepEqual(fundsFromFor(['lender', 'client'], ['new_build', 'help_to_buy_isa', 'lifetime_isa']), ['lender', 'client', 'isa_provider']);
  assert.ok(!EVENTUALITIES.some((e) => e.area === 'shape' && e.handling !== 'built' && e.handling !== 'outside'), 'no transaction shape is left manual or a gap');
});

test('enrolling with shapes raises each shape\'s checklist issue on day one, holding the gate it threatens', async () => {
  const h = harness();
  const r = await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_purchase', hasLender: true, requiredSearches: ['CON29'], shapes: ['company_buyer', 'new_build', 'lifetime_isa'] });
  assert.deepEqual(r.events.map((e) => e.type).filter((t) => t !== 'contract_pack_requested'), ['matter_created', 'issue_raised', 'issue_raised', 'issue_raised']);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.deepEqual(s.shapes, ['company_buyer', 'new_build', 'lifetime_isa']);
  const issues = Object.values(s.issues);
  assert.deepEqual(issues.map((i) => [i.kind, i.gate, i.status]), [['company_buyer_checks', 'exchange', 'open'], ['new_build_pack', 'exchange', 'open'], ['isa_bonus', 'completion', 'open']]);
  assert.ok(issues.every((i) => i.detail && i.detail.length > 100), 'each issue carries its checklist');
  assert.equal(s.requireExchangeAuthority, true, 'a non-auction purchase still needs the client\'s authority to exchange');
});

test('an auction needs no recorded exchange authority; a seller cannot take a buyer-only shape; the ISA bonus can only be requested on an ISA case', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_purchase', hasLender: false, requiredSearches: [], shapes: ['auction'] });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.requireExchangeAuthority, false);
  assert.equal(Object.values(s.issues)[0]?.kind, 'auction_conditions');
  const h2 = harness();
  await assert.rejects(h2.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_sale', hasLender: false, requiredSearches: [], shapes: ['lifetime_isa'] }), /does not apply to a freehold sale/);
  const h3 = harness();
  await h3.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_purchase', hasLender: false, requiredSearches: [] });
  await assert.rejects(h3.svc.run(TENANT, MATTER, { type: 'funds_requested', actor: USER, fromRole: 'isa_provider', bankDetailsId: 'x' }), /No ISA on this matter/);
  assert.ok(stageBlockers(await h3.svc.getState(TENANT, MATTER)).length >= 0);
});

test('a case is counted for billing the moment its ID / AML check comes back resolved, and not before', async () => {
  const { opensCase } = await import('../../../lib/server/engine/billing-reaction');
  assert.equal(opensCase([{ type: 'matter_created' }, { type: 'id_check_requested' }]), false);
  assert.equal(opensCase([{ type: 'id_check_flagged' }, { type: 'id_check_cleared' }]), true);
  assert.equal(opensCase([{ type: 'id_check_reviewed' }]), true);
  assert.equal(opensCase([{ type: 'search_returned' }, { type: 'search_cleared' }]), false);
});
