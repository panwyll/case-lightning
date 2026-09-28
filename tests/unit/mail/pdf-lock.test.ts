import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLockedPdf, unlockPdf, protectPdf, passwordCandidates, generatePassword } from '../../../lib/server/pdf-lock';

async function tinyPdf(): Promise<Buffer> {
  const m = await import('mupdf');
  const doc = new m.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, {}, ''));
  return Buffer.from(doc.saveToBuffer('').asUint8Array());
}

test('a protected PDF is detected, refuses the wrong password, and unlocks with the right one', async () => {
  const plain = await tinyPdf();
  assert.equal(await isLockedPdf(plain), false);
  const locked = await protectPdf(plain, 'oak-river-4821');
  assert.equal(await isLockedPdf(locked), true);
  assert.equal(await unlockPdf(locked, 'wrong'), null);
  const open = await unlockPdf(locked, 'oak-river-4821');
  assert.ok(open && (await isLockedPdf(open)) === false);
});

test('password candidates are read from the covering message; generated passwords are readable', () => {
  assert.ok(passwordCandidates('Hi, the password for the statements is Summer2024! and let me know.').includes('Summer2024!'));
  assert.ok(passwordCandidates('Password: AB12cd34\n\nThanks').includes('AB12cd34'));
  assert.ok(passwordCandidates('Please find attached.\n\nXk29pq77\n\nRegards').includes('Xk29pq77'));
  assert.match(generatePassword(), /^[a-z]+-[a-z]+-\d{4}$/);
});

test('a PDF encrypted only to restrict printing or copying opens without a password: it is not locked', async () => {
  const m = await import('mupdf');
  const doc = m.Document.openDocument(await tinyPdf(), 'application/pdf') as import('mupdf').PDFDocument;
  const restricted = Buffer.from(doc.saveToBuffer('encrypt=aes-256,owner-password=owner-only,permissions=0').asUint8Array());
  assert.ok(restricted.includes('/Encrypt'), 'it carries encryption');
  assert.equal(await isLockedPdf(restricted), false, 'but asks for no password');
});
