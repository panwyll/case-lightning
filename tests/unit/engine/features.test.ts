/**
 * How a firm runs CONVEYi (lib/server/features.ts): the whole case system, or alongside LEAP / InTouch.
 * The mode sets each feature's default; the firm can turn any one against it. Ordering in the practice
 * system records the order there, tells the handler, and never stands a placeholder in for the result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFeatures } from '../../../lib/server/features';
import { FirmInfoTrackRouter, MemoryOrderStore } from '../../../lib/server/integrations/infotrack';
import { MockIdCheckProvider, MockSearchProvider } from '../../../lib/server/engine/mocks';
import { clientHelp } from '../../../lib/server/engine/client-faq';
import { clientPortalView } from '../../../lib/server/engine/client-portal';
import { harness, TENANT, MATTER, USER } from './helpers';

test('the mode sets the defaults; a firm\'s own choice overrides one', () => {
  const alone = resolveFeatures('standalone', {});
  assert.ok(alone.flags.clientPortal.on && alone.flags.orderSearches.on);
  const along = resolveFeatures('alongside', { clientPortal: true });
  assert.equal(along.flags.orderSearches.on, false, 'the practice system orders');
  assert.equal(along.flags.clientPortal.on, true);
  assert.equal(along.flags.clientPortal.overridden, true);
  assert.equal(along.flags.satisfactionSurveys.on, true);
});

test('ordered in the practice system: recorded as such, the handler told, no placeholder', async () => {
  const told: string[] = [];
  const router = new FirmInfoTrackRouter(
    { clientFor: async () => null, orderedIn: async () => ({ via: 'practice', system: 'InTouch' }), practiceOrder: async (i) => { told.push(`${i.system}: ${i.what}`); } },
    new MemoryOrderStore(),
    async () => ({ matterRef: 'R', address: 'A', buyerNames: ['B'] }),
    { search: new MockSearchProvider({ placeholders: true }), idCheck: new MockIdCheckProvider() }
  );
  const s = await router.orderSearch({ tenantId: 't', matterId: 'm', searchType: 'CON29' });
  assert.match(s.provider, /InTouch \(ordered by the firm\)/);
  assert.equal(router.placeholderResult({ searchType: 'CON29', reference: s.reference, orderedAt: new Date() }), null);
  const id = await router.requestCheck({ tenantId: 't', matterId: 'm' });
  assert.match(id.provider, /InTouch/);
  assert.deepEqual(router.forFirm('t'), { sendsClientLink: true, label: 'InTouch' });
  assert.deepEqual(told, ['InTouch: the CON29 search', 'InTouch: the ID check']);
});

test('help follows the workflow\'s stages: the current one first (what happens, how long, what to do), the rest in order, then general', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['LLC1'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  const v = clientPortalView(await h.svc.getState(TENANT, MATTER), h.ports.now());
  assert.deepEqual(v.journey.map((s) => s.label), ['Instruction', 'Investigation', 'Enquiries', 'Contract & Exchange', 'Completion', 'Registration']);
  const help = clientHelp(v);
  assert.deepEqual(help.map((x) => x.label), [v.stageLabel, ...v.journey.map((s) => s.label).filter((l) => l !== v.stageLabel).slice(v.journey.findIndex((s) => s.label === v.stageLabel)), ...v.journey.map((s) => s.label).slice(0, v.journey.findIndex((s) => s.label === v.stageLabel)), 'General']);
  const now = help[0];
  assert.equal(now.current, true);
  assert.deepEqual(now.faqs.slice(0, 3).map((f) => f.q), [`What happens at ${now.label}?`, `How long does ${now.label} take?`, 'What do I need to do?']);
  assert.match(now.faqs[2].a, /Identity Check/, 'what they need to do comes from the case');
  assert.ok(help.slice(1, -1).every((x) => !x.current && x.faqs.every((f) => f.q !== 'What do I need to do?')));
  const every = help.flatMap((x) => x.faqs);
  assert.ok(!every.some((f) => /move out/i.test(f.q)), 'seller questions are not shown to a buyer');
  for (const f of every) {
    assert.doesNotMatch(f.q, /haven't|why (is|has)|delay|slow|wrong/i, `a question that invites worry: ${f.q}`);
    assert.doesNotMatch(f.a, /issue|flag|decision/i);
  }
  assert.equal(new Set(every.map((f) => f.id)).size, every.length, 'no question twice');
});

test('a remortgage has its own stages, and a seller at completion is asked about moving out and their money', () => {
  const base = { transaction: 'Remortgage', lifecycle: 'investigating', leasehold: false, hasLender: true, closed: false, journey: [], progress: [], tasks: [], waitingOnOthers: [], dates: { targetExchange: null, exchanged: null, completion: null, targetCompletion: null, completed: null } };
  const owner = clientHelp({ ...base, side: 'owner', stage: 'investigation', stageLabel: 'Investigation' } as never);
  assert.deepEqual(owner.map((x) => x.label), ['Investigation', 'Completion', 'Registration', 'Instruction', 'General']);
  const seller = clientHelp({ ...base, transaction: 'Freehold sale', side: 'seller', stage: 'completion', stageLabel: 'Completion', dates: { ...base.dates, completion: '2026-10-29' } } as never);
  assert.deepEqual(seller[0].faqs.map((f) => f.id), ['completion:what', 'completion:how_long', 'completion:you', 'completion:move_out', 'completion:sale_money']);
  assert.match(seller[0].faqs[1].a, /29 October 2026/);
});
