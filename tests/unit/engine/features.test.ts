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

test('help: the questions asked at the client\'s stage come first, for their side, answered from the case; never a negative question', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['LLC1'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  const v = clientPortalView(await h.svc.getState(TENANT, MATTER), h.ports.now());
  const help = clientHelp(v);
  const first = help.now.map((f) => f.id);
  assert.ok(first.length >= 3 && first.length <= 5, first.join(', '));
  assert.equal(first[0], 'now');
  assert.match(help.now[0].q, /What's happening on my purchase now\?/);
  assert.match(help.now.find((f) => f.id === 'todo')!.a, /identity check/i, 'what they need to do comes from the case');
  const every = [...help.now, ...help.all];
  const ids = every.map((f) => f.id);
  assert.ok(!ids.includes('move_out') && !ids.includes('first_sale'), 'seller questions are not shown to a buyer');
  assert.ok(!first.includes('keys'), 'completion-day questions are not first at the start');
  for (const f of every) {
    assert.doesNotMatch(f.q, /haven't|why (is|has)|delay|slow|wrong/i, `a question that invites worry: ${f.q}`);
    assert.doesNotMatch(f.a, /issue|flag|decision/i);
  }
  assert.equal(new Set(ids).size, ids.length, 'no question twice');
});

test('help follows the stage: after exchange a buyer is first asked about completion day and the keys; a seller about moving out', () => {
  const base = { transaction: 'Freehold purchase', lifecycle: 'exchanged', leasehold: false, hasLender: true, closed: false, journey: [], stageLabel: 'Exchanged', progress: [], tasks: [], waitingOnOthers: [], dates: { targetExchange: null, exchanged: '2026-10-01', completion: '2026-10-29', targetCompletion: null, completed: null } };
  const buyer = clientHelp({ ...base, side: 'buyer' } as never).now.map((f) => f.id);
  assert.deepEqual(buyer.slice(0, 3), ['completion_day', 'keys', 'balance']);
  const seller = clientHelp({ ...base, side: 'seller' } as never).now.map((f) => f.id);
  assert.deepEqual(seller.slice(0, 3), ['completion_day', 'move_out', 'sale_money']);
  const done = clientHelp({ ...base, side: 'buyer', lifecycle: 'completed' } as never).now.map((f) => f.id);
  assert.equal(done[0], 'after');
});
