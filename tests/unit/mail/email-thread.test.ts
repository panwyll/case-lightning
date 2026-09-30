/**
 * The email conversation view (lib/server/email-thread.ts): filed emails on a case plus the older
 * messages recovered from their quoted history, oldest first, ours marked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThread, normaliseSubject, parseAddress, parseAddressList, parseLegacyEmail, parseLooseDate, sameMessage, splitQuotedHistory, type FiledEmailRow } from '../../../lib/server/email-thread';

const self = { emails: new Set(['alex@ourfirm.co.uk']), domains: new Set(['ourfirm.co.uk']) };
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();

test('subject: Re:/Fw: prefixes, spacing and case are not part of the thread key', () => {
  assert.equal(normaliseSubject('RE: Fw: re:  14 Oak Street  purchase'), '14 oak street purchase');
  assert.equal(normaliseSubject('FWD: 14 Oak Street purchase'), '14 oak street purchase');
  assert.equal(normaliseSubject(null), '');
});

test('addresses: names, quoted names with commas, bare and mailto forms', () => {
  assert.deepEqual(parseAddress('Jane Smith <Jane@Example.com>'), { name: 'Jane Smith', address: 'jane@example.com' });
  assert.deepEqual(parseAddress('jane@example.com'), { name: null, address: 'jane@example.com' });
  assert.deepEqual(parseAddress('Jane Smith [mailto:jane@example.com]'), { name: 'Jane Smith', address: 'jane@example.com' });
  assert.deepEqual(parseAddressList('"Smith, Jane" <jane@example.com>, bob@example.com; Carl <carl@x.co>').map((a) => a.address), ['jane@example.com', 'bob@example.com', 'carl@x.co']);
  assert.equal(parseAddressList('"Smith, Jane" <jane@example.com>')[0].name, 'Smith, Jane');
  assert.deepEqual(parseAddressList(''), []);
});

test('dates: Outlook, Gmail and UK numeric forms', () => {
  assert.equal(parseLooseDate('Monday, 28 September 2026 10:02'), local(2026, 9, 28, 10, 2));
  assert.equal(parseLooseDate('Mon, 28 Sep 2026 at 10:02'), local(2026, 9, 28, 10, 2));
  assert.equal(parseLooseDate('28/09/2026 14:30'), local(2026, 9, 28, 14, 30));
  assert.equal(parseLooseDate('2026-09-28T09:02:00Z'), '2026-09-28T09:02:00.000Z');
  assert.equal(parseLooseDate('not a date'), null);
});

test('legacy: header lines are read from the filed text', () => {
  const e = parseLegacyEmail('From: Jane Smith <jane@example.com>\nTo: alex@ourfirm.co.uk, bob@example.com\nDate: 2026-09-28T09:02:00Z\nSubject: Re: 14 Oak Street\n\nHello Alex,\nAll signed.');
  assert.deepEqual(e.from, { name: 'Jane Smith', address: 'jane@example.com' });
  assert.equal(e.to.length, 2);
  assert.deepEqual(e.cc, []);
  assert.equal(e.date, '2026-09-28T09:02:00.000Z');
  assert.equal(e.subject, 'Re: 14 Oak Street');
  assert.equal(e.body, 'Hello Alex,\nAll signed.');
});

test('quoting: Outlook "From / Sent / To / Subject" blocks, nested', () => {
  const body = [
    'Thanks Alex, that is fine.',
    '',
    '________________________________',
    'From: Alex Carter <alex@ourfirm.co.uk>',
    'Sent: Monday, 28 September 2026 10:02',
    'To: Jane Smith <jane@example.com>',
    'Cc: Bob Smith <bob@example.com>',
    'Subject: RE: 14 Oak Street',
    '',
    'Hi Jane, please sign the contract.',
    '',
    '-----Original Message-----',
    'From: Jane Smith <jane@example.com>',
    'Sent: 27/09/2026 16:40',
    'To: alex@ourfirm.co.uk',
    'Subject: 14 Oak Street',
    '',
    'When do I sign?',
  ].join('\n');
  const r = splitQuotedHistory(body);
  assert.equal(r.fresh, 'Thanks Alex, that is fine.');
  assert.equal(r.history.length, 2);
  assert.equal(r.history[0].from.address, 'alex@ourfirm.co.uk');
  assert.equal(r.history[0].date, local(2026, 9, 28, 10, 2));
  assert.equal(r.history[0].cc[0].address, 'bob@example.com');
  assert.equal(r.history[0].subject, 'RE: 14 Oak Street');
  assert.equal(r.history[0].body, 'Hi Jane, please sign the contract.');
  assert.equal(r.history[1].from.address, 'jane@example.com');
  assert.equal(r.history[1].date, local(2026, 9, 27, 16, 40));
  assert.equal(r.history[1].body, 'When do I sign?');
});

test('quoting: Gmail "On … wrote:" blocks with "> " lines, nested and wrapped', () => {
  const body = [
    'Great, see you then.',
    '',
    'On Mon, 28 Sep 2026 at 10:02, Alex Carter <alex@ourfirm.co.uk> wrote:',
    '> Hi Jane, can you come in on Thursday?',
    '>',
    '> On Sun, 27 Sep 2026 at 16:40, Jane Smith <',
    '> jane@example.com> wrote:',
    '>> When do I sign?',
    '',
    'Sent from my phone',
  ].join('\n');
  const r = splitQuotedHistory(body);
  assert.equal(r.fresh, 'Great, see you then.');
  assert.equal(r.history.length, 2);
  assert.deepEqual(r.history[0].from, { name: 'Alex Carter', address: 'alex@ourfirm.co.uk' });
  assert.equal(r.history[0].date, local(2026, 9, 28, 10, 2));
  assert.equal(r.history[0].body, 'Hi Jane, can you come in on Thursday?');
  assert.deepEqual(r.history[1].from, { name: 'Jane Smith', address: 'jane@example.com' });
  assert.equal(r.history[1].body, 'When do I sign?');
});

test('quoting: a body with no history is all fresh', () => {
  assert.deepEqual(splitQuotedHistory('Just this.\nThanks'), { fresh: 'Just this.\nThanks', history: [] });
});

test('dedupe: same sender and near-identical opening words', () => {
  const a = { from: { name: 'Jane', address: 'jane@example.com' }, body: 'When do I sign?  The contract, I mean.' };
  assert.ok(sameMessage(a, { from: { name: null, address: 'JANE@example.com' }, body: 'When do I sign? The contract, I mean.\n\nJane' }));
  assert.ok(!sameMessage(a, { from: { name: null, address: 'bob@example.com' }, body: a.body }), 'another sender');
  assert.ok(!sameMessage(a, { from: a.from, body: 'Something else entirely, about the survey.' }));
  assert.ok(sameMessage({ from: { name: 'Jane Smith', address: null }, body: 'When do I sign? The contract, I mean.' }, { from: { name: 'jane smith', address: null }, body: 'When do I sign? The contract, I mean.' }), 'by name when no address');
});

const row = (id: string, content: string, email: Record<string, unknown> | null, at = '2026-09-29T09:00:00Z'): FiledEmailRow => ({ id, created_at: at, content, email });

test('thread: filed emails + recovered history, oldest first, deduped, ours marked', () => {
  const rows: FiledEmailRow[] = [
    // A legacy row: no email meta, grouped by subject; its body quotes our reply and the client's first email.
    row('d1', [
      'From: Jane Smith <jane@example.com>', 'To: alex@ourfirm.co.uk', 'Date: 2026-09-28T12:00:00Z', 'Subject: Re: 14 Oak Street', '',
      'Thursday works.', '',
      'On Mon, 28 Sep 2026 at 10:02, Alex Carter <alex@ourfirm.co.uk> wrote:',
      '> Can you come in on Thursday?',
      '>',
      '> On Sun, 27 Sep 2026 at 16:40, Jane Smith <jane@example.com> wrote:',
      '>> When do I sign the contract?',
    ].join('\n'), null),
    // The first email, also filed: the quoted copy of it must not appear twice.
    row('d0', 'From: Jane Smith <jane@example.com>\nTo: alex@ourfirm.co.uk\nDate: 2026-09-27T15:40:00Z\nSubject: 14 Oak Street\n\nWhen do I sign the contract?', null),
    // The newest, with meta: fresh words, cc, attachments.
    row('d2', 'From: Jane Smith <jane@example.com>\n...', { from: { name: 'Jane Smith', address: 'jane@example.com' }, to: [{ name: 'Alex Carter', address: 'alex@ourfirm.co.uk' }], cc: [{ name: 'Bob', address: 'bob@example.com' }], date: '2026-09-29T08:30:00Z', subject: 'RE: 14 Oak Street', conversationId: null, direction: 'in', fresh: 'Signed copy attached.', attachments: [{ name: 'contract.pdf', documentId: 'd9' }] }),
    // Another conversation on the same case.
    row('dx', 'From: Agent <a@agents.co.uk>\nTo: alex@ourfirm.co.uk\nDate: 2026-09-28T11:00:00Z\nSubject: Viewing feedback\n\nThey loved it.', null),
  ];
  const t = buildThread(rows, 'd2', self)!;
  assert.equal(t.subject, '14 Oak Street');
  assert.deepEqual(t.messages.map((m) => m.body), ['When do I sign the contract?', 'Can you come in on Thursday?', 'Thursday works.', 'Signed copy attached.']);
  assert.deepEqual(t.messages.map((m) => m.quoted), [false, true, false, false]);
  assert.deepEqual(t.messages.map((m) => m.mine), [false, true, false, false]);
  assert.equal(t.messages[0].documentId, 'd0');
  assert.equal(t.messages[1].documentId, null);
  assert.deepEqual(t.messages[3].attachments, [{ name: 'contract.pdf', documentId: 'd9' }]);
  assert.equal(t.messages[3].cc[0].address, 'bob@example.com');
  assert.equal(buildThread(rows, 'nope', self), null);
});

test('thread: conversation ids group ahead of subjects', () => {
  const meta = (conversationId: string, date: string, fresh: string, from = 'jane@example.com') => ({ from: { name: null, address: from }, to: [], cc: [], date, subject: 'Re: Oak', conversationId, direction: from.endsWith('ourfirm.co.uk') ? 'out' : 'in', fresh, attachments: [] });
  const rows = [
    row('a', '', meta('C1', '2026-09-28T10:00:00Z', 'First')),
    row('b', '', meta('C2', '2026-09-28T11:00:00Z', 'Other conversation, same subject')),
    row('c', '', meta('C1', '2026-09-28T12:00:00Z', 'Reply from us', 'alex@ourfirm.co.uk')),
  ];
  const t = buildThread(rows, 'a', self)!;
  assert.deepEqual(t.messages.map((m) => m.id), ['a', 'c']);
  assert.deepEqual(t.messages.map((m) => m.mine), [false, true]);
});
