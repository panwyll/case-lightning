/**
 * Updates to the other side (docs/spec/triggers.md): what their solicitor and the agent may be told
 * is decided in one place, replies to them are written only from it, and milestones go without them
 * having to ask. The client's finances, checks and problems never go; their own chain only on their say-so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterpartyStatus, renderCounterpartyFacts, dueCounterpartyNotices } from '../../../lib/server/engine/counterparty-status';
import { pendingDecisions, type NoteSender } from '../../../lib/server/engine/types';
import { harness, resolve, TENANT, MATTER, USER, idClear, offerClear } from './helpers';

const OTHER_SIDE: NoteSender = { address: 'conv@sellers-law.example', name: 'Sam Seller-Solicitor', relation: 'other_side' };

async function purchaseWithOffer() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false, targetExchangeDate: '2026-11-20' });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  return h;
}

test('what the other side may hear: progress and the mortgage offer status, never the client\'s own affairs; the chain only with consent', async () => {
  const h = await purchaseWithOffer();
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'source_of_funds', title: 'Gift from parents not yet evidenced' });
  let s = await h.svc.getState(TENANT, MATTER);
  const facts = renderCounterpartyFacts(s, new Date(), 'seller_solicitor');
  assert.match(facts, /mortgage offer is not yet in/);
  assert.match(facts, /exchange by 20 November/);
  assert.doesNotMatch(facts, /Gift from parents|evidenced/i, 'a problem on our side is never shared');
  assert.match(facts, /NEVER SAY/);
  assert.match(facts, /nothing about our client's own sale or purchase/);

  s = { ...s, relatedMatter: { matterId: 'm2', relation: 'sale', linkedAt: '2026-09-01' } };
  assert.ok(!counterpartyStatus(s, new Date()).lines.some((l) => /linked sale/.test(l)), 'no chain without the client\'s say-so');
  await h.svc.run(TENANT, MATTER, { type: 'record_chain_consent', actor: USER, given: true, reason: 'Client said fine' });
  const withConsent = { ...(await h.svc.getState(TENANT, MATTER)), relatedMatter: s.relatedMatter };
  assert.ok(counterpartyStatus(withConsent, new Date()).lines.some((l) => /linked sale/.test(l)), 'with it, where their sale stands');
});

test('"any update?" from the other side is answered from what may be shared, not the client\'s brief', async () => {
  const h = await purchaseWithOffer();
  let seen = '';
  h.ports.replyDrafter = { name: 'spy', draft: async (input) => { if (input.to === 'seller_solicitor') seen = input.facts; return { body: 'Dear Colleagues,\n\nWhere things stand.' }; } };
  const res = await h.svc.recordNote(TENANT, MATTER, { text: 'Hi, any update on your side? When can we expect to exchange?', kind: 'email', actor: USER, documentId: h.doc(null, 'EMAIL'), from: OTHER_SIDE, surface: true, subject: 'Update' });
  const note = Object.values(res.state.notes).at(-1)!;
  assert.ok(note.messages?.some((m) => m.to === 'seller_solicitor'), 'a reply to them is drafted');
  assert.match(seen, /^WHAT WE MAY TELL THEM/);
  assert.doesNotMatch(seen, /CASE STATE|Workstreams|ID \/ AML/, 'never the client brief');
});

test('the mortgage offer being in and being ready to exchange go to the other side and the agent, once each, for approval', async () => {
  const h = await purchaseWithOffer();
  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc({ ...offerClear(), expiryDate: '2027-03-01' }));
  const md = pendingDecisions(await h.svc.getState(TENANT, MATTER)).find((d) => d.kind === 'mortgage');
  if (md) await resolve(h, md.eventId, 'approve', USER, 'Fine');
  let s = await h.svc.getState(TENANT, MATTER);
  const proposals = Object.values(s.proposals).filter((p) => p.action === 'counterparty_update' && p.status === 'pending');
  assert.deepEqual(proposals.map((p) => `${(p.detail as { milestone: string }).milestone}:${(p.detail as { to: string }).to}`).sort(), ['mortgage_offer:estate_agent', 'mortgage_offer:seller_solicitor']);
  const body = (proposals[0].detail as { body: string }).body;
  assert.match(body, /mortgage offer is in/);
  assert.doesNotMatch(body, /£|interest|rate|term/i, 'status only, never the terms');

  for (const p of proposals) await resolve(h, p.eventId, 'approve', USER);
  const chaser = h.ports.chaser as unknown as { messages: Array<{ recipientRole: string; subject: string }> };
  assert.equal(chaser.messages.filter((m) => /mortgage offer is in/i.test(m.subject)).length, 2);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(dueCounterpartyNotices(s, new Date()).filter((n) => n.key === 'mortgage_offer').length, 0, 'once each');
});
