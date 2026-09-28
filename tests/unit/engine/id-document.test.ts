import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameMatches, reviewIdDocument, splitClientNames } from '../../../lib/server/engine/id-document';
import { evaluateIdCheck } from '../../../lib/server/engine/rules';
import type { IdCheckFacts } from '../../../lib/server/engine/types';

const photo = (over: Partial<NonNullable<IdCheckFacts['identity']>> = {}): IdCheckFacts => ({
  provider: 'Document photo', outcome: 'refer', flags: [], confidence: 0.9, source: 'document',
  identity: { documentType: 'passport', fullName: 'PRIYA ANJALI SHAH', dateOfBirth: '1990-01-01', expiryDate: '2031-03-03', issuingCountry: 'United Kingdom', photoPresent: true, wholeDocumentVisible: true, signsOfAlteration: [], legibility: 'good', ...over },
});
const NOW = new Date('2026-09-28T12:00:00Z');

test('joint client names split per person, sharing the surname', () => {
  assert.deepEqual(splitClientNames(['Tomasz & Ewa Nowak']), ['Tomasz Nowak', 'Ewa Nowak']);
  assert.deepEqual(splitClientNames(['Mr John Smith', 'Jane Doe']), ['Mr John Smith', 'Jane Doe']);
});

test('a name matches on first name and surname, whatever the case, titles and middle names', () => {
  assert.ok(nameMatches('PRIYA ANJALI SHAH', 'Priya Shah'));
  assert.ok(nameMatches('Shah, Priya', 'Mrs Priya Shah'));
  assert.ok(!nameMatches('PRIYA PATEL', 'Priya Shah'));
});

test("a passport in the client's name, in date: goes to a person with nothing wrong, never cleared on its own", () => {
  const f = reviewIdDocument(photo(), ['Priya Shah'], NOW);
  assert.equal(f.nameCheck?.matches, true);
  assert.equal(f.flags.length, 0);
  const v = evaluateIdCheck(f);
  assert.equal(v.outcome, 'flag');
  assert.deepEqual(v.outcome === 'flag' && v.flags.map((x) => x.code), ['ID_DOCUMENT_ONLY']);
});

test('the wrong name, an expired document and a poor photo are each said plainly', () => {
  const f = reviewIdDocument(photo({ fullName: 'JOHN DOE', expiryDate: '2020-01-01', photoPresent: false }), ['Priya Shah'], NOW);
  const codes = f.flags.map((x) => x.code);
  assert.ok(codes.includes('ID_NAME_MISMATCH') && codes.includes('ID_DOCUMENT_EXPIRED') && codes.includes('ID_DOCUMENT_UNCLEAR'));
  assert.match(f.flags.find((x) => x.code === 'ID_NAME_MISMATCH')!.description, /JOHN DOE; the client is Priya Shah/);
});

test('a file that is not an ID says so', () => {
  const f = reviewIdDocument({ ...photo(), identity: null, notIdentity: true }, ['Priya Shah'], NOW);
  assert.deepEqual(f.flags.map((x) => x.code), ['ID_NOT_IDENTITY_DOCUMENT']);
});
