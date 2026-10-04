import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger, buildReview, coverageLine, flattenFacts, verifyQuote, diffRegister, diffLine } from '../../../lib/server/engine/review';
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
  assert.equal(review.summary.verified, 2, 'the charge by its quote; the title number, stated without one, by its value on page 1; the tenure (a code) is not looked for');
  assert.equal(review.facts.find((f) => f.key === 'title.number')?.note, 'the value is on page 1');
  assert.equal(review.facts.find((f) => f.key === 'title.tenure')?.note, 'stated without a quote');
  assert.equal(coverageLine(review.summary), '3 of 3 pages read · 2 with facts');
});

test('a re-read is diffed against the previous register by key', () => {
  const d = diffRegister(
    [{ key: 'offer.price_pennies', value: '38500000' }, { key: 'offer.lender', value: 'Mock BS' }, { key: 'offer.expiry_date', value: '2026-12-31' }],
    [{ key: 'offer.price_pennies', value: '38000000' }, { key: 'offer.lender', value: 'mock bs' }, { key: 'offer.rate', value: '4.25' }]
  );
  assert.deepEqual(d, { added: [{ key: 'offer.rate', value: '4.25' }], removed: [{ key: 'offer.expiry_date', value: '2026-12-31' }], changed: [{ key: 'offer.price_pennies', from: '38500000', to: '38000000' }] });
  assert.equal(diffLine(d), 'Since the last read: 1 changed, 1 added, 1 gone.');
});

test('a quote that leaves words out, or whose words a table cell has put out of order, is still found; an invented one is not', () => {
  const t = { textLayer: true, pages: ['Contents price (included in the | £2,500\npurchase price)\nBalance | £382,500', '3.9 An enforcement notice was served on 3 February 2025 under section 172. Compliance period: 6 months. The council has no record that the notice has been complied with.'] };
  const cut = verifyQuote('An enforcement notice was served on 3 February 2025 ... the council has no record that the notice has been complied with', 2, t);
  assert.equal(cut.verified, true);
  assert.match(cut.note!, /in parts/);
  const table = verifyQuote('Contents price (included in the purchase price) £2,500', 1, t);
  assert.equal(table.verified, true);
  assert.match(table.note!, /not in that order/);
  assert.equal(verifyQuote('Contents price (excluded from the purchase price) £2,500', 1, t).verified, false, 'a changed word is not found');
  assert.equal(verifyQuote('notice was served on 3 March 2025 ... complied with', 2, t).verified, false, 'a changed date in a cut quote is not found');
});
