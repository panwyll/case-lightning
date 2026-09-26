import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canon, canonsOf, checkDraft, markUnsupported, renderChecked, splitSentences, type RegisterFact } from '../../../lib/server/engine/draft-check';

const fact = (id: string, key: string, value: string, page: number | null = 1, quote: string | null = null): RegisterFact => ({ id, documentId: `doc-${id[0]}`, documentLabel: id[0] === 't' ? 'Official copy' : id[0] === 'o' ? 'Mortgage offer' : 'CON29', key, value, page, quote });
const register = [
  fact('t1', 'title.number', 'ON123456', 1, 'Title number ON123456'),
  fact('t2', 'title.proprietor.0', 'Anna Kowalska', 1, 'ANNA KOWALSKA of 7 Mill Lane'),
  fact('t3', 'title.address', '7 Mill Lane, Henley-on-Thames, RG9 2BH', 1),
  fact('o1', 'offer.price_pennies', '38500000', 2, 'Purchase price £385,000'),
  fact('o2', 'offer.expiry_date', '2026-12-31', 3, 'This offer expires on 31 December 2026'),
  fact('o3', 'offer.rate', '4.25', 2, 'Initial rate 4.25%'),
  fact('o4', 'offer.borrower.0', 'Mr Tomasz Nowak', 1),
];

test('canonical forms agree across the ways a fact is written', () => {
  assert.equal(canon.money('£385,000'), '38500000');
  assert.equal(canon.money('385000.00 pounds'), '38500000');
  assert.equal(canon.date('31st December 2026'), '2026-12-31');
  assert.equal(canon.date('31/12/2026'), '2026-12-31');
  assert.equal(canon.date('December 31, 2026'), '2026-12-31');
  assert.equal(canon.title_number('on 123456'), 'ON123456');
  assert.equal(canon.postcode('rg9 2bh'), 'RG92BH');
  assert.equal(canon.name('Mrs Anna Kowalska'), 'kowalska');
  assert.deepEqual(canonsOf('offer.price_pennies', '38500000'), [{ kind: 'money', canon: '38500000' }]);
  assert.ok(canonsOf('title.address', '7 Mill Lane, RG9 2BH').some((c) => c.kind === 'postcode' && c.canon === 'RG92BH'));
  assert.ok(canonsOf('offer.expiry_date', '2026-12-31').some((c) => c.kind === 'date' && c.canon === '2026-12-31'));
  assert.ok(canonsOf('offer.rate', '4.25').some((c) => c.kind === 'percent' && c.canon === '4.25'));
});

test('sentences split on full stops, headings and list lines', () => {
  const s = splitSentences('THE PROPERTY\nThe title is ON123456. The price is £385,000.\n- Deposit: £38,500\nNext steps follow.');
  assert.deepEqual(s.map((x) => x.text), ['THE PROPERTY', 'The title is ON123456.', 'The price is £385,000.', '- Deposit: £38,500', 'Next steps follow.']);
});

test('every figure, date and name in a draft is matched to the register; the rest is struck and listed', () => {
  const draft = [
    'THE PROPERTY',
    'The property is registered under title number ON123456 and the registered proprietor is Mrs Anna Kowalska.',
    'The purchase price is £385,000 and your mortgage offer expires on 31 December 2026 at an initial rate of 4.25%.',
    'The ground rent is £250 a year and the lease was granted on 1 April 1999 to Mr John Smith.',
    'Completion is expected on 14 November 2026.',
  ].join('\n');
  const c = checkDraft(draft, register, { allowed: ['2026-11-14'] });
  assert.equal(c.sentences.length, 5);
  assert.deepEqual(c.sentences[1].factIds, ['t1', 't2']);
  assert.deepEqual(c.sentences[2].factIds, ['o1', 'o2', 'o3']);
  assert.deepEqual(c.sentences[3].struck.map((s) => `${s.kind}:${s.text}`), ['money:£250', 'date:1 April 1999', 'name:John Smith']);
  assert.deepEqual(c.sentences[4].struck, []); // the completion date is on the case record, so not struck, but nothing to cite
  assert.deepEqual(c.sentences[4].factIds, []);
  assert.equal(c.notFromFile.length, 3);
  assert.deepEqual(c.cited.map((f) => f.id), ['t1', 't2', 'o1', 'o2', 'o3']);
  assert.deepEqual(c.summary, { sentences: 5, claims: 9, matched: 6, struck: 3, cited: 5 });
  assert.deepEqual(c.sentences.map((s) => s.para), [0, 1, 2, 3, 4]);
  assert.deepEqual(checkDraft('One. Two.\nThree.', []).sentences.map((s) => s.para), [0, 0, 1]);
  const text = renderChecked(draft, c);
  assert.match(text, /registered proprietor is Mrs Anna Kowalska\. \[1, 2\]/);
  assert.match(text, /rate of 4\.25%\. \[3, 4, 5\]/);
  assert.match(text, /\[NOT ON FILE: £250\] a year/);
  assert.match(text, /NOT FROM THE FILE\n- £250 \(amount\)/);
  assert.match(text, /SOURCES\n1\. Official copy p\.1 — title\.number: ON123456 — “Title number ON123456”/);
  const t = 'Rent £250 due 1 April 1999.';
  assert.equal(markUnsupported(t, checkDraft(t, register)), 'Rent [NOT ON FILE: £250] due [NOT ON FILE: 1 April 1999].');
});

test('an empty register strikes every figure but leaves the case record values alone', () => {
  const c = checkDraft('The price is £385,000 for 7 Mill Lane, RG9 2BH and the buyer is Mr Tomasz Nowak.', [], { allowed: ['385000', '7 Mill Lane, Henley-on-Thames, RG9 2BH', 'Tomasz Nowak'] });
  assert.equal(c.summary.struck, 0);
  const d = checkDraft('The price is £385,000.', []);
  assert.equal(d.summary.struck, 1);
  assert.equal(d.notFromFile[0].text, '£385,000');
});

// ── the service path: the filed draft is the checked draft ──────────────────────────────
import { harness, TENANT, MATTER, USER, idClear, searchClear, titleClear } from './helpers';
import { firstDecision } from './helpers';

test('a report on title is filed as checked against the register: sentences cite facts, the rest is struck and listed, and the decision cites the facts', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'], targetExchangeDate: '2026-11-20', targetCompletionDate: '2026-12-04' });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  const titleDoc = h.doc(titleClear());
  await h.svc.titleReceived(TENANT, MATTER, titleDoc);
  const title = titleClear();
  h.ports.documents.register = {
    facts: [{ id: 'f-title', documentId: titleDoc, documentLabel: 'Official copy', key: 'title.number', value: title.titleNumber, page: 1, quote: `Title number ${title.titleNumber}` }],
    allowed: ['7 Mill Lane, RG9 2BH'],
  };
  await h.svc.draftReportOnTitle(TENANT, MATTER);
  const state = await h.svc.getState(TENANT, MATTER);
  const rot = firstDecision(state, 'report_on_title');
  const draftDoc = h.ports.documents.all().find((d) => d.docType === 'REPORT_ON_TITLE_DRAFT')!;
  const content = (draftDoc.extractedFacts as { content: string }).content;
  const check = h.ports.documents.draftChecks.get(draftDoc.id)!;
  assert.ok(check, 'the check is kept with the draft');
  assert.ok(check.cited.some((f) => f.id === 'f-title'), 'the title number sentence cites the register fact');
  assert.match(content, /SOURCES\n1\. Official copy p\.1 — title\.number/);
  assert.match(rot.summary, /figures, dates and names match the file/);
  assert.ok(rot.citations.some((c) => c.locator?.quote === `Title number ${title.titleNumber}`), 'the decision carries a citation to the fact quote');
  assert.equal(check.summary.struck, check.notFromFile.length);
});
