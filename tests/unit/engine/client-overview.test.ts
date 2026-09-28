/**
 * The "where things stand" tail of a client update: what is still outstanding, in the client's
 * words, leaving out what they were told about in the last few days and what was raised in the
 * last hour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientOverview } from '../../../lib/server/engine/client-overview';
import { harness, TENANT, MATTER, USER } from './helpers';

test("what the client owes is not repeated inside the firm's reminder window (the request, an update or a chase all count as asking); after it, it rides along with the next update", async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(clientOverview(s, h.ports.now()).text, '', 'the ID check was asked for minutes ago: nothing to repeat');

  let now = h.advanceDays(2);
  s = await h.svc.getState(TENANT, MATTER);
  const two = clientOverview(s, now);
  assert.match(two.text, /^Where things stand: Still waiting on you: .*\(asked 2 days ago\)\./);
  assert.match(two.text, /this usually takes a week or two|contract pack/i, 'and the pack owed by the other side');
  assert.ok(two.mentioned.some((k) => k.startsWith('id_check:')), 'it records what it mentioned');
  assert.doesNotMatch(two.text, /CON29|LLC1|_/, 'no internal codes');

  // The update goes out and says so; the next one, a day later, does not nag about the same thing.
  await h.svc.run(TENANT, MATTER, { type: 'record_client_update', update: { template: 'searches_ordered', recipientRole: 'client', channel: 'email', messageId: 'm1', mentioned: two.mentioned } });
  now = h.advanceDays(1);
  s = await h.svc.getState(TENANT, MATTER);
  assert.doesNotMatch(clientOverview(s, now, { reminderHours: 48 }).text, /Still waiting on you/, 'told a day ago, inside a 48-hour window: quiet');
  assert.match(clientOverview(s, now).text, /Still waiting on you/, 'a day on, past the default 24 hours: said again');

  // A chase is asking too: the next update does not repeat it inside the window.
  const idWait = s.waits.find((w) => w.key === 'id_check' && !w.closedAt)!;
  await h.svc.run(TENANT, MATTER, { type: 'record_chase', chase: { waitKey: 'id_check', subject: idWait.subject, recipientRole: 'client', template: 'chase_id_documents', channel: 'email' } });
  s = await h.svc.getState(TENANT, MATTER);
  assert.doesNotMatch(clientOverview(s, h.ports.now()).text, /Still waiting on you/, 'chased just now: quiet');

  now = h.advanceDays(4);
  s = await h.svc.getState(TENANT, MATTER);
  assert.match(clientOverview(s, now).text, /Still waiting on you/, 'days on, it is worth saying again');
});
