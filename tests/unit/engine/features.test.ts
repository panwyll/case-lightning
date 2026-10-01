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
import { clientFaqs } from '../../../lib/server/engine/client-faq';
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

test('help answers are for the client\'s side, the case answers "why haven\'t I heard", and the stage\'s questions come first', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['LLC1'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  const v = clientPortalView(await h.svc.getState(TENANT, MATTER), h.ports.now());
  const faqs = clientFaqs(v);
  const ids = faqs.map((f) => f.id);
  assert.ok(ids.includes('searches') && ids.includes('id_pof') && !ids.includes('move_out') && !ids.includes('id'), ids.join(', '));
  assert.ok(ids.indexOf('quiet') < ids.indexOf('keys'), 'what is asked at the start comes before completion-day questions');
  assert.match(faqs.find((f) => f.id === 'quiet')!.a, /We also need your identity check/i);
  for (const f of faqs) assert.doesNotMatch(f.a, /issue|flag|decision/i);
});
