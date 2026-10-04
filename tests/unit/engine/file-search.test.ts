/**
 * The file index and Ask The File (file-index.ts, file-ask.ts): chunks that keep a clause whole,
 * a context line for each, hybrid search fused by rank, and an answer whose every sentence cites a
 * source that holds its figures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anyOf, chunks, contextLine, documentLabel, fuse, searchTerms } from '../../../lib/server/engine/file-index';
import { checkAnswer, factText, figuresIn, sourcesFor } from '../../../lib/server/engine/file-ask';

test('a long page is cut at natural breaks, every chunk overlaps the last, and nothing is lost', () => {
  const clause = (n: number) => `${n}. The Tenant shall keep the interior of the Flat in good and substantial repair and condition throughout the Term.`;
  const page = Array.from({ length: 60 }, (_, i) => clause(i + 1)).join('\n');
  const cs = chunks(page);
  assert.ok(cs.length > 2);
  assert.ok(cs.every((c) => c.length <= 1800));
  // Cut at a line end, not mid-sentence.
  assert.ok(cs.slice(0, -1).every((c) => /Term\.$/.test(c)), cs.map((c) => c.slice(-30)).join(' | '));
  // Each chunk starts inside the previous one (the overlap), and every clause is in some chunk whole.
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i - 1].includes(cs[i].slice(0, 40)), `chunk ${i} does not overlap`);
  for (let n = 1; n <= 60; n++) assert.ok(cs.some((c) => c.includes(clause(n))), `clause ${n} is never whole`);
  assert.deepEqual(chunks('Short page.'), ['Short page.']);
  assert.deepEqual(chunks('   '), []);
});

test('each chunk is indexed with what the document is and where', () => {
  const lease = { fileName: 'Lease.pdf', docType: 'EMAIL_ATTACHMENT', extractedFacts: { _pipeline: { role: 'lease' } } };
  assert.equal(contextLine(lease, 4, 30), 'Lease.pdf (lease), page 4 of 30.');
  assert.equal(documentLabel({ docType: 'EMAIL_ATTACHMENT', extractedFacts: { _pipeline: { role: 'search:LLC1' } } }), 'search result');
  assert.equal(documentLabel({ docType: 'EMAIL', extractedFacts: null }), 'email');
  assert.equal(documentLabel({ docType: 'EMAIL_ATTACHMENT', extractedFacts: null }), null);
});

test('words match any of them, as prefixes; ranks from words and meaning are fused', () => {
  assert.equal(anyOf(searchTerms('Who repairs the roof under the lease?')), 'who:* | repairs:* | roof:* | under:*');
  assert.equal(anyOf([]), '');
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' }, d = { id: 'd' };
  // b is second by words and first by meaning: it beats a, first by words only.
  assert.deepEqual(fuse([[a, b, c], [b, d]]).map((x) => x.id), ['b', 'a', 'd', 'c']);
  assert.deepEqual(fuse([[], [d]]).map((x) => x.id), ['d']);
});

test('an answer sentence stands only on a cited source that holds its figures', () => {
  const sources = sourcesFor(
    [{ id: 'f1', documentId: 'd1', fileName: 'Lease.pdf', key: 'lease.ground_rent_pennies_pa', value: '25000', page: 3, quote: null, verified: true }],
    [{ documentId: 'd1', fileName: 'Lease.pdf', docType: null, page: 9, text: 'snippet', full: 'The Tenant shall pay a service charge of 1.25% of the Building costs, reviewed every 10 years from 2021.' }],
  );
  assert.equal(sources[0].text, 'ground rent pa: £250');
  assert.equal(factText({ key: 'contract.price_pennies', value: '30000000', quote: null }), 'price: £300,000');
  const checked = checkAnswer([
    { text: 'The ground rent is £250 a year.', sources: ['F1'] },
    { text: 'The service charge is 1.25% of the Building costs, reviewed every 10 years.', sources: ['P1'] },
    { text: 'The ground rent doubles every 25 years.', sources: ['F1'] },
    { text: 'The landlord insures the building.', sources: [] },
    { text: 'The lease started in 1999.', sources: ['X9'] },
  ], sources);
  assert.deepEqual(checked.map((s) => s.supported), [true, true, false, false, false]);
  assert.match(checked[2].why!, /25 is not in what it cites/);
  assert.match(checked[3].why!, /No source/);
  assert.deepEqual(checked[4].sources, [], 'an id that is not a source is dropped');
  assert.deepEqual(figuresIn('£250,000 on 1 March 2026, 12.5% and ref AB12345'), ['250000', '2026', '12.5', '12345']);
});

test('a house number or a postcode names a place: it is not a figure the answer must cite', () => {
  assert.deepEqual(figuresIn('Buildings insurance for 22 Wharf Road is placed with Aviva, renewing on 24 June 2027.'), ['24', '2027']);
  assert.deepEqual(figuresIn('Flat 3, 22 Wharf Road, Leeds LS10 1PS pays £1,840 a year.'), ['1840']);
  assert.deepEqual(figuresIn('The deposit is £42,500.'), ['42500'], 'money is still a claim');
});
