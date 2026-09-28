import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAttachedEmail, isAttachedEmail } from '../../../lib/server/mail-expand';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const inner = [
  'From: Lender <offers@nationwide.example>',
  'Subject: Your mortgage offer',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="IN"',
  '',
  '--IN',
  'Content-Type: text/plain',
  '',
  'Please find your offer attached.',
  '--IN',
  'Content-Type: application/pdf; name="Mortgage Offer.pdf"',
  'Content-Disposition: attachment; filename="Mortgage Offer.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('%PDF-1.4 offer'),
  '--IN--',
  '',
].join('\r\n');
const outer = [
  'From: Broker <broker@example.com>',
  'Subject: FW: offer and statements',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="OUT"',
  '',
  '--OUT',
  'Content-Type: text/plain',
  '',
  'See below.',
  '--OUT',
  'Content-Type: application/pdf; name="Bank statement.pdf"',
  'Content-Disposition: attachment; filename="Bank statement.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('%PDF-1.4 statement'),
  '--OUT',
  'Content-Type: message/rfc822',
  'Content-Disposition: attachment',
  '',
  inner,
  '--OUT--',
  '',
].join('\r\n');

test('an attached email is opened: its files come out, and an email inside it comes out to be opened in turn', async () => {
  assert.ok(isAttachedEmail('chain.eml', ''));
  assert.ok(isAttachedEmail('Re offer', 'message/rfc822'));
  assert.ok(isAttachedEmail('x.msg', ''));
  assert.ok(!isAttachedEmail('offer.pdf', 'application/pdf'));
  const x = await expandAttachedEmail(Buffer.from(outer), 'chain.eml', 'message/rfc822');
  assert.equal(x.error, undefined);
  assert.equal(x.subject, 'FW: offer and statements');
  const names = x.entries.map((e) => e.name);
  assert.ok(names.includes('Bank statement.pdf'), names.join(', '));
  const nested = x.entries.find((e) => /\.eml$/.test(e.name))!;
  assert.ok(nested, `the inner email comes out: ${names.join(', ')}`);
  const y = await expandAttachedEmail(nested.bytes, nested.name, nested.contentType);
  const offer = y.entries.find((e) => e.name === 'Mortgage Offer.pdf')!;
  assert.ok(offer);
  assert.equal(offer.bytes.toString(), '%PDF-1.4 offer');
});

test('something that is not an email says so instead of throwing', async () => {
  const x = await expandAttachedEmail(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]), 'broken.msg');
  assert.match(x.error ?? '', /could not be opened/);
});

test('a forwarded chain that talks about files it does not carry says so; one that carries them says nothing', async () => {
  const { attachmentsNotOnEmail } = await import('../../../lib/server/files');
  assert.match(attachmentsNotOnEmail('From: Nationwide\nPlease see "Mortgage Offer ANWYLL.pdf" and payslips.docx.', []) ?? '', /Mortgage Offer ANWYLL\.pdf, payslips\.docx, which are not attached/);
  assert.match(attachmentsNotOnEmail('Offer_Nationwide.pdf attached', []) ?? '', /^It mentions Offer_Nationwide\.pdf, which is not/);
  assert.match(attachmentsNotOnEmail('Hi, please find attached the offer.', []) ?? '', /refers to attachments, but none are on it/);
  assert.equal(attachmentsNotOnEmail('Please find attached the offer.', [{ name: 'offer.pdf', outcome: 'read' }]), null);
  assert.equal(attachmentsNotOnEmail('Thanks, speak soon.', []), null);
});

test('an email on a conversation filed to one case that names a different case is left for a person; one that names its own case (or both) is filed', async () => {
  const { namesAnotherCase } = await import('../../../lib/server/matching');
  const linked = { matterId: 'A', matterRef: 'A-1', propertyAddress: '9 Arthur Road', score: 1, band: 'AUTO' as const, signals: [{ kind: 'LINKED_THREAD' as const, detail: '', weight: 1 }] };
  const other = { matterId: 'B', matterRef: 'B-1', propertyAddress: '4 Elm Close', score: 0.6, band: 'STRONG' as const, signals: [{ kind: 'STREET' as const, detail: '', weight: 0.4, value: 'Elm Close' }] };
  assert.equal(namesAnotherCase(linked, [linked, other])?.matterId, 'B');
  assert.equal(namesAnotherCase({ ...linked, signals: [...linked.signals, { kind: 'STREET' as const, detail: '', weight: 0.4, value: 'Arthur Road' }] }, [linked, other]), null);
  assert.equal(namesAnotherCase(linked, [linked]), null);
});
