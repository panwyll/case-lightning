/** An email a person filed in InTouch is filed here once, and only when it is certainly the same email. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchQueued, pickUpFiledEmails, sameSubject, type QueuedEmail } from '../../../lib/server/integrations/intouch/poll';
import { toFolderEmail } from '../../../lib/server/integrations/intouch/mapping';

const q = (id: string, subject: string, from: string, receivedAt: string): QueuedEmail => ({ id, mailboxUserId: 'u', messageId: `msg-${id}`, conversationId: `c-${id}`, subject, from, receivedAt });

test('the same conversation subject, however many RE:s', () => {
  assert.ok(sameSubject('RE: FW: Searches for 14 Oak St', 'Searches for 14 Oak St'));
  assert.ok(!sameSubject('Searches', 'Search results'));
  assert.ok(!sameSubject('', ''));
});

test('matched by subject, sender and time; never on a guess', () => {
  const queued = [q('1', 'Re: Searches', 'seller@law.test', '2026-10-18T09:00:00Z'), q('2', 'Mortgage offer', 'broker@b.test', '2026-10-18T09:05:00Z')];
  assert.equal(matchQueued({ at: '2026-10-18T09:20:00Z', subject: 'RE: Searches', from: 'seller@law.test' }, queued)?.id, '1');
  assert.equal(matchQueued({ at: '2026-10-18T09:20:00Z', subject: 'Searches', from: 'someone@else.test' }, queued), null, 'a different sender');
  assert.equal(matchQueued({ at: '2026-10-18T08:00:00Z', subject: 'Searches', from: null }, queued), null, 'filed before it arrived');
  const twins = [q('a', 'Update', 'x@y.test', '2026-10-18T09:00:00Z'), q('b', 'Update', 'x@y.test', '2026-10-18T09:01:00Z')];
  assert.equal(matchQueued({ at: '2026-10-18T09:30:00Z', subject: 'Update', from: 'x@y.test' }, twins), null, 'two alike: nothing filed');
});

test("InTouch's email record is read for what identifies it; other folder items are not emails", () => {
  assert.deepEqual(toFolderEmail({ guid: 'e1', type: 'Email', createdOn: '2026-10-18T09:20:00Z', fields: { subject: 'Searches', from: { email: 'Seller@Law.test' } } }), { id: 'e1', at: '2026-10-18T09:20:00.000Z', subject: 'Searches', from: 'seller@law.test' });
  assert.equal(toFolderEmail({ guid: 'd1', type: 'Document', fields: { fileName: 'x.pdf' } }), null);
});

test('no unfiled email, no InTouch call', async () => {
  let calls = 0;
  const r = await pickUpFiledEmails('00000000-0000-4000-8000-000000000000', { folderEmails: async () => { calls++; return []; } }, async () => {});
  assert.deepEqual(r, { checked: 0, filed: 0 });
  assert.equal(calls, 0);
});
