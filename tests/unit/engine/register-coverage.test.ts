/**
 * Every kind of document the engine reads puts its facts on the register (document_fact), so Ask The
 * File, the draft check and the cross-checks see the whole file: the TA6 / TA7 answers, supporting
 * documents, title plans, surveys and bank statements, not only titles, contracts and leases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReview, flattenFacts } from '../../../lib/server/engine/review';

const keys = (role: string, facts: unknown) => flattenFacts(role, facts).map((f) => f.key);

test('the property forms answers are on the register, each on the page of its section', () => {
  const rows = flattenFacts('property_forms', {
    forms: ['TA6', 'TA10'], disclosures: [{ code: 'TA6_DISPUTE', severity: 'high', description: 'A boundary dispute with number 12', locator: { page: 3, quote: 'dispute with number 12' } }], confidence: 0.9,
    answers: { disputes: 'Boundary dispute with number 12 in 2021', flooded: false, japaneseKnotweed: true, epcRating: 'C', occupiers: null },
    notKnown: [{ question: 'Is there a guarantee for the roof?', section: 'guarantees', page: 5 }],
    pages: { disputes: 3, environment: 7 },
  });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by['forms.disputes'].value, 'Boundary dispute with number 12 in 2021');
  assert.equal(by['forms.disputes'].page, 3);
  assert.equal(by['forms.flooded'].value, 'no');
  assert.equal(by['forms.japanese_knotweed'].value, 'yes');
  assert.equal(by['forms.japanese_knotweed'].page, 7);
  assert.equal(by['forms.epc_rating'].value, 'C');
  assert.ok(!('forms.occupiers' in by), 'an unanswered question is not a fact');
  assert.equal(by['forms.not_known.1'].page, 5);
  assert.equal(by['forms.disclosure:TA6_DISPUTE'].quote, 'dispute with number 12');
  assert.deepEqual(rows.filter((r) => r.key.startsWith('forms.form.')).map((r) => r.value), ['TA6', 'TA10']);
});

test('supporting documents, title plans, surveys and statements are on the register', () => {
  assert.deepEqual(keys('supporting_document', { kind: 'indemnity_policy', title: 'Lack of building regulations indemnity', covers: 'Rear extension 2009', issuedBy: 'Stewart Title', reference: 'P123', date: '2026-09-01', expires: '', limitPennies: 30_000_000, benefitPasses: true, property: '12 Example Street', notes: ['Do not contact the council'], confidence: 0.9 }),
    ['support.kind', 'support.title', 'support.covers', 'support.issued_by', 'support.reference', 'support.date', 'support.limit_pennies', 'support.benefit_passes', 'support.property', 'support.note.0']);
  assert.deepEqual(keys('title_plan', { titleNumber: 'AB12345', edgedRed: 'The house and garden', otherMarkings: [{ marking: 'Blue hatching', marks: 'A right of way' }], notes: [], reference: '1:1250', confidence: 0.9 }),
    ['plan.title_number', 'plan.edged_red', 'plan.marking.1', 'plan.reference']);
  assert.ok(!keys('title_plan', { titleNumber: 'UNKNOWN', edgedRed: '', otherMarkings: [], notes: [], reference: '', confidence: 0.4 }).includes('plan.title_number'));
  const survey = flattenFacts('survey', { surveyType: 'level3', surveyor: 'A Surveyor MRICS', recommendations: [{ code: 'damp_rear', text: 'Rising damp to the rear wall', furtherInvestigation: true, specialist: 'damp', severity: 'high', rating: 3, locator: { page: 14 } }], legalIssues: [{ category: 'regulation', text: 'Building regulations for the loft', locator: { page: 30 } }], risks: ['Trees near the house'], marketValuePennies: 35_000_000, reinstatementCostPennies: 0, confidence: 0.8 });
  assert.deepEqual(survey.map((f) => f.key), ['survey.type', 'survey.surveyor', 'survey.market_value_pennies', 'survey.recommendation.damp_rear', 'survey.legal.regulation.1', 'survey.risk.0']);
  assert.equal(survey.find((f) => f.key === 'survey.recommendation.damp_rear')!.page, 14);
  assert.deepEqual(keys('statement', { accountHolder: 'Asha Patel', bankName: 'Barclays', accountLast4: '1234', periodFrom: '2026-06-01', periodTo: '2026-08-31', openingBalancePennies: 100, closingBalancePennies: 5_000_000, transactions: [{ date: '2026-07-01', description: 'Salary', amountPennies: 300_000 }], salaryCredits: [], confidence: 0.9 }),
    ['statement.account_holder', 'statement.bank', 'statement.account_last4', 'statement.period_from', 'statement.period_to', 'statement.opening_balance_pennies', 'statement.closing_balance_pennies']);
  assert.deepEqual(keys('statement', { notStatement: true, kind: 'payslip' }), ['statement.document_kind']);
});

test('every fact carries the reading confidence, and a fact read without a page ledger still registers', () => {
  const r = buildReview({ role: 'survey', facts: { surveyType: 'level2', recommendations: [], confidence: 0.72 }, ledger: null, texts: { pages: ['Level 2 survey', 'Page two'], textLayer: true } });
  assert.equal(r.facts[0].confidence, 0.72);
  assert.equal(r.pages.length, 2);
  assert.ok(r.pages.every((p) => p.verdict === 'unattested'), 'no ledger asked of a survey: its pages are recorded, unattested');
});
