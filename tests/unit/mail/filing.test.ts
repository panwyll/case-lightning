/**
 * Filing email to cases: recognising the property as people write it, and not letting a
 * forged or look-alike sender count as evidence of which case an email belongs to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsStreet, streetKeyOf, streetLeads } from '../../../lib/server/mail/address-match';
import { authVerdict, checkSender, lookalikeOf, orgDomain } from '../../../lib/server/mail/sender-check';
import { bulkReason, readablePreview } from '../../../lib/server/mail/bulk';
import { explainMatch } from '../../../lib/server/mail/case-cards';

test('street: "9 Arthur Road contract pack" is 9 Arthur Road, however the address is written', () => {
  const key = streetKeyOf('Flat 2, 9 Arthur Rd, Leeds LS6 1AB');
  assert.equal(key?.key, '9 arthur road');
  assert.ok(mentionsStreet('9 Arthur Road contract pack', key!.key));
  assert.ok(mentionsStreet('RE: 9, arthur road – searches', key!.key));
  assert.ok(!mentionsStreet('19 Arthur Road contract pack', key!.key), '19 is not 9');
  assert.ok(!mentionsStreet('9 Arthur Street', key!.key), 'a different street');
  assert.deepEqual(streetLeads('9 Arthur Road contract pack'), ['9 arthur']);
  assert.equal(streetKeyOf('Rose Cottage, Mill Lane, Henley'), null, 'a named house has no numbered street');
});

test('sender: the receiving server\'s verdict is read from Authentication-Results', () => {
  assert.equal(authVerdict([{ name: 'Authentication-Results', value: 'spf=pass smtp.mailfrom=a.co.uk; dkim=pass; dmarc=pass action=none header.from=a.co.uk;compauth=pass reason=100' }]), 'pass');
  assert.equal(authVerdict([{ name: 'Authentication-Results', value: 'spf=fail smtp.mailfrom=a.co.uk; dkim=none; dmarc=fail action=quarantine header.from=a.co.uk;compauth=fail reason=000' }]), 'fail');
  assert.equal(authVerdict([{ name: 'Authentication-Results', value: 'spf=softfail; dkim=none' }]), 'fail');
  assert.equal(authVerdict(null), 'none');
});

test('sender: look-alike domains are caught, the real one is not', () => {
  const known = ['bartlett-law.co.uk', 'mockbs.co.uk'];
  assert.equal(lookalikeOf('bart1ett-law.co.uk', known), 'bartlett-law.co.uk');
  assert.equal(lookalikeOf('bartlett-law.co', known), 'bartlett-law.co.uk');
  assert.equal(lookalikeOf('bartlettlaw.co.uk', known), 'bartlett-law.co.uk');
  assert.equal(lookalikeOf('bartlett-lavv.co.uk', known), 'bartlett-law.co.uk');
  assert.equal(lookalikeOf('bartlett-law.co.uk', known), null);
  assert.equal(lookalikeOf('hartleys.co.uk', known), null);
});

test('sender: forged, look-alike, borrowed name and diverted replies each make it suspicious, with a reason', () => {
  const known = { contacts: [{ email: 'sarah@bartlett-law.co.uk', name: 'Sarah Bartlett' }], domains: ['bartlett-law.co.uk'] };
  const pass = [{ name: 'Authentication-Results', value: 'dmarc=pass' }];
  assert.equal(checkSender({ fromName: 'Sarah Bartlett', fromAddress: 'sarah@bartlett-law.co.uk', replyTo: [], headers: pass }, known).verdict, 'ok');
  assert.equal(checkSender({ fromName: 'Sarah Bartlett', fromAddress: 'sarah@bartlett-law.co.uk', replyTo: [], headers: null }, known).verdict, 'unverified');

  const forged = checkSender({ fromName: 'Sarah Bartlett', fromAddress: 'sarah@bartlett-law.co.uk', replyTo: [], headers: [{ name: 'Authentication-Results', value: 'dmarc=fail' }] }, known);
  assert.equal(forged.verdict, 'suspicious');
  assert.match(forged.warnings[0], /failed the checks/);

  const lookalike = checkSender({ fromName: 'Sarah Bartlett', fromAddress: 'sarah@bart1ett-law.co.uk', replyTo: [], headers: pass }, known);
  assert.equal(lookalike.verdict, 'suspicious');
  assert.ok(lookalike.warnings.some((w) => /looks like bartlett-law\.co\.uk/.test(w)));
  assert.ok(lookalike.warnings.some((w) => /on file as sarah@bartlett-law\.co\.uk/.test(w)), 'the borrowed name is called out too');

  const diverted = checkSender({ fromName: 'Sarah Bartlett', fromAddress: 'sarah@bartlett-law.co.uk', replyTo: ['accounts@gmail.com'], headers: pass }, known);
  assert.equal(diverted.verdict, 'suspicious');
  assert.match(diverted.warnings[0], /Replies would go to accounts@gmail\.com/);
});

test('sender: Reply-To is not over-read — same organisation, or a sender we never dealt with, is fine', () => {
  const known = { contacts: [{ email: 'sarah@bartlett-law.co.uk', name: 'Sarah Bartlett' }], domains: ['bartlett-law.co.uk'] };
  const pass = [{ name: 'Authentication-Results', value: 'dmarc=pass' }];
  // Microsoft's newsletter: sent from mails.microsoft.com, replies to microsoft.com.
  const ms = checkSender({ fromName: 'Microsoft Learn', fromAddress: 'Learn@mails.microsoft.com', replyTo: ['replies@microsoft.com'], headers: pass }, known);
  assert.equal(ms.verdict, 'ok');
  assert.deepEqual(ms.warnings, []);
  // A stranger's Reply-To elsewhere impersonates nobody we know.
  const stranger = checkSender({ fromName: 'Some Portal', fromAddress: 'noreply@portal.example', replyTo: ['help@support.example'], headers: null }, known);
  assert.equal(stranger.verdict, 'unverified');
  // Our own contact's other office on the same organisation is fine.
  const office = checkSender({ fromName: 'Sarah Bartlett', fromAddress: 'sarah@bartlett-law.co.uk', replyTo: ['conveyancing@leeds.bartlett-law.co.uk'], headers: pass }, known);
  assert.equal(office.verdict, 'ok');
  assert.equal(orgDomain('mails.microsoft.com'), 'microsoft.com');
  assert.equal(orgDomain('leeds.bartlett-law.co.uk'), 'bartlett-law.co.uk');
});

test('not case mail: mailing lists and automatic senders are set apart; a forwarded email previews what it says', () => {
  assert.equal(bulkReason({ headers: [{ name: 'List-Unsubscribe', value: '<mailto:x>' }], fromAddress: 'Learn@mails.microsoft.com' }), 'mailing list');
  assert.equal(bulkReason({ headers: [{ name: 'Precedence', value: 'bulk' }], fromAddress: 'a@b.co.uk' }), 'bulk mail');
  assert.equal(bulkReason({ headers: null, fromAddress: 'no-reply@portal.example' }), 'automatic sender');
  assert.equal(bulkReason({ headers: [{ name: 'Authentication-Results', value: 'dmarc=pass' }], fromAddress: 'sarah@bartlett-law.co.uk' }), null);

  const fw = readablePreview('________________________________\nFrom: Osiris Law <onboarding@resend.dev>\nSent: Tuesday, 25 August 2026 14:47\nTo: pete@example.com\nSubject: New enquiry\n\nMargaret Hale called about selling 4 Elm Close. Please call her back on 020 7946 0321.', 'fallback');
  assert.equal(fw.forwardedFrom, 'Osiris Law');
  assert.match(fw.preview, /^Margaret Hale called about selling 4 Elm Close/);
});

test('match reasons read as sentences about the case, not codes', () => {
  const lines = explainMatch(
    [
      { kind: 'STREET', detail: '', weight: 0.45, value: '9 Arthur Road' },
      { kind: 'PARTICIPANT_EMAIL', detail: '', weight: 0.35, value: 'sarah@bartlett-law.co.uk' },
      { kind: 'NAME', detail: '', weight: 0.2, value: 'Priya Shah' },
    ],
    { fromName: 'Sarah Bartlett', fromAddress: 'sarah@bartlett-law.co.uk', senderRole: 'OTHER_SIDE' }
  );
  assert.deepEqual(lines, ['Mentions 9 Arthur Road', "From Sarah Bartlett, the other side's solicitor on this case", 'Mentions Priya Shah']);
});
