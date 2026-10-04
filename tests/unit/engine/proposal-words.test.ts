/** Proposals say what they do in words: a chase names what it is for, once, with acronyms intact. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaseTitle, proposalBrief } from '../../../lib/server/engine/proposal-words';
import { harness, TENANT, MATTER, USER } from './helpers';

async function state(tt = 'freehold_purchase') {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: tt, hasLender: false, requiredSearches: ['CON29'] } as never);
  return h.svc.getState(TENANT, MATTER);
}

test('chase titles name the thing once, with acronyms intact', async () => {
  const s = await state();
  assert.equal(chaseTitle('id_check', 'client', null, s), 'Chase the client for their ID');
  assert.equal(chaseTitle('search', 'search_provider', 'CON29', s), 'Chase the search provider for the CON29 search result');
  assert.equal(chaseTitle('enquiry', 'seller_solicitor', 'ISS-10-E1', s), "Chase the seller's solicitor for their reply to enquiry E1");
  assert.equal(chaseTitle('survey', 'client', null, s), 'Ask the client whether they are having a survey');
  assert.equal(chaseTitle('client_decision', 'client', 'exchange_authority', s), 'Chase the client for authority to exchange');
  const sale = await state('freehold_sale');
  assert.equal(chaseTitle('enquiry', 'seller_solicitor', null, sale), "Chase the buyer's solicitor for replies to our enquiries", 'acting for the seller the other side is the buyer\'s solicitor');
});

test('a chase brief says when we asked, how often we have chased, and what this chase does', async () => {
  const s = await state();
  s.waits.push({ key: 'id_check', subject: null, openedAt: '2026-09-01T09:00:00Z', chasesSentAt: ['2026-09-08T09:00:00Z'], closedAt: null } as never);
  const b = proposalBrief({ s, action: 'chase', detail: { waitKey: 'id_check', recipientRole: 'client' }, events: [], summary: '', names: { clients: ['Sam Patel'] } });
  assert.match(b.headline, /^We asked the client \(Sam Patel\) for their ID on 1 Sept 2026 and have had nothing back; chased once already, last on 8 Sept 2026\. This is chase 2: it repeats what we need and re-sends their links and forms\.$/);
  assert.deepEqual(b.rows.find((r) => r[0] === 'Chased')?.slice(0, 2), ['Chased', '1× (last 8 Sept 2026)']);
  assert.equal(chaseTitle('id_check', 'client', null, s), 'Chase the client for their ID (asked 1 Sept, chased once)');
});

test('enquiries go to the other side, never to the client', async () => {
  const s = await state();
  const b = proposalBrief({ s, action: 'enquiry_draft', detail: { about: "the seller's forms", subject: 'Arising from the forms:\n\n1. works without consent — details\n2. knotweed — when treated' }, events: [], summary: '', names: { counterpartySolicitor: 'Smith & Co' } });
  assert.match(b.headline, /^2 enquiries to the seller's solicitor \(Smith & Co\) arising from the seller's forms\./);
});
