import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger, buildReview, coverageLine, flattenFacts, verifyQuote } from '../../../lib/server/engine/review';
import type { TitleFacts } from '../../../lib/server/engine/types';

const texts = { textLayer: true, pages: ['Title number ON123456. Freehold.', 'C: Charges register. 1 (12.03.2019) REGISTERED CHARGE dated 1 March 2019 in favour of Mock Building Society.', 'Nothing here.'] };

test('a quote is verified only when its words are on the page; whitespace, case and curly quotes are forgiven', () => {
  assert.equal(verifyQuote('registered charge dated 1 March 2019', 2, texts).verified, true);
  assert.equal(verifyQuote('REGISTERED  CHARGE dated 1 march 2019', 2, texts).verified, true);
  const wrongPage = verifyQuote('Registered charge dated 1 March 2019', 1, texts);
  assert.equal(wrongPage.verified, true);
  assert.match(wrongPage.note ?? '', /found on page 2/);
  const invented = verifyQuote('a restriction against disposition without consent', 2, texts);
  assert.equal(invented.verified, false);
  assert.match(invented.note ?? '', /not found/);
  assert.equal(verifyQuote('anything', 1, { textLayer: false, pages: [] }).verified, false);
  assert.equal(verifyQuote('', 1, texts).note, 'no quote');
});

test('the ledger covers every real page; pages the model did not mention are unattested and coverage is incomplete', () => {
  const rows = buildLedger([{ page: 1, verdict: 'facts' }, { page: 2, verdict: 'facts' }], texts);
  assert.deepEqual(rows.map((r) => r.verdict), ['facts', 'facts', 'unattested']);
  const full = buildLedger([{ page: 1, verdict: 'facts' }, { page: 2, verdict: 'facts' }, { page: 3, verdict: 'nothing' }], texts);
  assert.equal(full.every((r) => r.verdict !== 'unattested'), true);
});

test('title facts flatten to keyed rows and are verified against the page text', () => {
  const facts: TitleFacts = {
    titleNumber: 'ON123456', tenure: 'freehold', restrictions: [], covenants: [],
    charges: [{ code: 'C1', text: 'REGISTERED CHARGE dated 1 March 2019 in favour of Mock Building Society.', register: 'C', locator: { page: 2, quote: 'REGISTERED CHARGE dated 1 March 2019' } }],
    confidence: 0.95,
  };
  const rows = flattenFacts('title', facts);
  assert.deepEqual(rows.map((r) => r.key), ['title.number', 'title.tenure', 'title.charge.C1']);
  const review = buildReview({ role: 'title', facts, ledger: [{ page: 1, verdict: 'facts' }, { page: 2, verdict: 'facts' }, { page: 3, verdict: 'nothing' }], texts });
  assert.equal(review.summary.complete, true);
  assert.equal(review.summary.facts, 3);
  assert.equal(review.summary.verified, 1, 'the charge has a quote on the page; the number and tenure were stated without one');
  assert.equal(review.facts.find((f) => f.key === 'title.number')?.note, 'stated without a quote');
  assert.equal(coverageLine(review.summary), '3 of 3 pages read · 2 with facts');
});
