/**
 * Source of funds analysis and open banking (docs/proof-of-funds.md §9): accounts connected by open
 * banking read like statements; each declared source is matched against what the money shows; the
 * source-of-wealth rules ask the questions a Thirdfort-style report would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSourceOfFunds, categorise, incomeStreams } from '../../../lib/server/engine/source-of-funds';
import { factsFromSubmission, type EvidenceDocument, type ProofOfFundsSubmission, type StatementFacts } from '../../../lib/server/engine/proof-of-funds';
import { DemoBank, DEMO_INSTITUTIONS } from '../../../lib/server/open-banking/mock';
import { firstDecision, harness, TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-09-20T10:00:00Z');
const bank = new DemoBank(() => NOW);
async function account(scenario: string, holder: string): Promise<StatementFacts> {
  const inst = DEMO_INSTITUTIONS.find((i) => i.id === scenario)!;
  const { providerRef } = await bank.start({ reference: 'r', institutionId: scenario, redirectUrl: 'https://x.test/back?c=1', historyDays: 730, holderHint: holder });
  return (await bank.collect(providerRef, inst)).accounts[0].statement;
}
const doc = (id: string, statement: StatementFacts, sourceIndex: number | null, donorFor: number | null = null): EvidenceDocument => ({ id, fileName: `${statement.bankName} (connected)`, sourceIndex, donorFor, kind: 'bank_statement', payslip: null, statement, unreadable: null, provenance: 'open_banking' });
const sub = (sources: ProofOfFundsSubmission['sources']): ProofOfFundsSubmission => ({ declarant: { fullName: 'Priya Shah' }, purchasePricePennies: 40_000_000, mortgageAdvancePennies: 30_000_000, sources, declarations: { accurate: true, noThirdPartyInterest: true, noUndisclosedBorrowing: true }, submittedAt: NOW.toISOString() });

test('open banking: 24 months of the bank\'s own lines become a statement, with the running balance and the salary found', async () => {
  const st = await account('DEMO_SALARY', 'Priya Shah');
  assert.equal(st.accountHolder, 'PRIYA SHAH');
  assert.ok(st.periodFrom! < '2024-10-15', `two years back: ${st.periodFrom}`);
  assert.equal(st.periodTo, '2026-09-20');
  assert.equal(st.openingBalancePennies! + st.transactions.reduce((a, t) => a + t.amountPennies, 0), st.closingBalancePennies);
  assert.equal(st.transactions.at(-1)!.balancePennies, st.closingBalancePennies, 'the running balance ends at today\'s balance');
  const streams = incomeStreams(st.transactions);
  assert.equal(streams[0].payer, 'ACME LTD');
  assert.ok(streams[0].months >= 23);
  assert.ok(st.salaryCredits.length >= 23, 'salary recognised for the line review too');
});

test('categories: income, own transfers, the donor, solicitors, gambling and loans are told apart', () => {
  const people = { client: ['Priya Shah'], donors: ['Anita Shah'] };
  const c = (description: string, amountPennies: number, counterparty: string | null = null) => categorise({ date: '2026-01-01', description, amountPennies, counterparty }, people, new Set(['acme ltd salary']));
  assert.equal(c('ACME LTD SALARY', 3_000_00), 'income');
  assert.equal(c('TRANSFER', 5_000_00, 'P SHAH'), 'own_transfer');
  assert.equal(c('GIFT', 20_000_00, 'MRS A SHAH'), 'from_donor');
  assert.equal(c('COMPLETION MONIES', 80_000_00, 'SMITH & CO SOLICITORS LLP'), 'solicitor');
  assert.equal(c('BET365', -50_00), 'gambling_spend');
  assert.equal(c('KLARNA', -40_00), 'loan_repayment');
  assert.equal(c('CASH PAID IN', 900_00), 'cash');
});

test('a salaried saver: the savings are evidenced, explained by the income, and nothing is asked', async () => {
  const st = await account('DEMO_SALARY', 'Priya Shah');
  const f = factsFromSubmission('r', sub([{ kind: 'savings', amountPennies: 5_000_000, description: 'Saved from salary', evidenceDocumentIds: ['a'] }]), 40_000_000);
  const a = analyseSourceOfFunds(f, [doc('a', st, 1)], NOW.toISOString());
  assert.equal(a.sources[0].match, 'evidenced');
  assert.deepEqual(a.flags.map((x) => x.code), []);
  assert.equal(a.accounts[0].provenance, 'open_banking');
  assert.match(a.report, /connected by open banking \(bank-verified\)/);
  assert.match(a.report, /Income: ACME LTD, about £3,200/);
  assert.match(a.report, /Savings £50,000: Evidenced/);
});

test('a gift: the donor\'s own recent windfall is asked about; a gift nobody has seen is asked for', async () => {
  const donor = await account('DEMO_DONOR', 'Anita Shah');
  const gift = { kind: 'gift' as const, amountPennies: 5_000_000, description: 'From my mother', evidenceDocumentIds: [], gift: { donorName: 'Anita Shah', donorRelationship: 'mother', repayable: false, donorAbroad: false, donorEvidenceDocumentIds: ['d'] } };
  const f = factsFromSubmission('r', sub([gift]), 40_000_000);
  const a = analyseSourceOfFunds(f, [doc('d', donor, null, 1)], NOW.toISOString());
  assert.equal(a.sources[0].match, 'held', 'not yet transferred, but the donor holds it');
  const recent = a.flags.find((x) => x.code === 'GIFT_DONOR_FUNDS_RECENT');
  assert.ok(recent, 'the donor\'s £85,000 arrived 40 days ago');
  assert.match(recent!.description, /COMPLETION MONIES/);
  assert.match(a.queries.find((q) => q.flagCode === 'GIFT_DONOR_FUNDS_RECENT')!.question, /where that money came from/);

  const none = analyseSourceOfFunds(factsFromSubmission('r', sub([{ ...gift, gift: { ...gift.gift, donorEvidenceDocumentIds: [] } }]), 40_000_000), [], NOW.toISOString());
  assert.ok(none.flags.some((x) => x.code === 'GIFT_NOT_EVIDENCED'));
});

test('mixed activity: gambling spend, a new loan and money from an account not provided are asked about', async () => {
  const st = await account('DEMO_MIXED', 'Priya Shah');
  const f = factsFromSubmission('r', sub([{ kind: 'savings', amountPennies: 2_000_000, description: 'Savings', evidenceDocumentIds: ['m'] }]), 40_000_000);
  const a = analyseSourceOfFunds(f, [doc('m', st, 1)], NOW.toISOString());
  const codes = a.flags.map((x) => x.code);
  for (const c of ['GAMBLING_SPEND', 'LOAN_RECENT', 'OWN_ACCOUNT_NOT_PROVIDED']) assert.ok(codes.includes(c), `${c} in ${codes.join(', ')}`);
  for (const q of a.queries) assert.doesNotMatch(q.question, /suspic|launder|fraud|report/i, 'routine wording, no tipping off');
});

test('money moved between the client\'s own accounts is traced, and not asked about', async () => {
  const savings: StatementFacts = { accountHolder: 'PRIYA SHAH', bankName: 'Nationwide', accountLast4: '1111', periodFrom: '2026-06-01', periodTo: '2026-09-20', openingBalancePennies: 40_000_00, closingBalancePennies: 30_000_00, transactions: [{ date: '2026-08-10', description: 'TO CURRENT A/C', amountPennies: -10_000_00, counterparty: 'P SHAH' }], salaryCredits: [], confidence: 1 };
  const current: StatementFacts = { accountHolder: 'PRIYA SHAH', bankName: 'Monzo', accountLast4: '2222', periodFrom: '2026-06-01', periodTo: '2026-09-20', openingBalancePennies: 1_000_00, closingBalancePennies: 11_000_00, transactions: [{ date: '2026-08-10', description: 'FROM SAVINGS', amountPennies: 10_000_00, counterparty: 'PRIYA SHAH' }], salaryCredits: [], confidence: 1 };
  const f = factsFromSubmission('r', sub([{ kind: 'savings', amountPennies: 4_000_000, description: 'Savings', evidenceDocumentIds: ['s', 'c'] }]), 40_000_000);
  const a = analyseSourceOfFunds(f, [doc('s', savings, 1), doc('c', current, 1)], NOW.toISOString());
  assert.ok(a.explainedKeys.includes('LARGE_CREDIT:c:0'), 'the credit is matched to the debit on the savings account');
  assert.ok(!a.flags.some((x) => x.code === 'OWN_ACCOUNT_NOT_PROVIDED'));
});

test('flow: connected accounts go through the submission like statements, marked bank-verified, with the analysis in the declaration', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [] });
  const r = await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  const requestId = (r.events[0].payload as { requestId: string }).requestId;
  const mine = h.ports.documents.seed({ tenantId: TENANT, matterId: MATTER, docType: 'OPEN_BANKING_ACCOUNT', fileName: 'Demo Bank ····4821 (connected, 24 months)', extractedFacts: { statement: await account('DEMO_SALARY', 'Priya Shah') } });
  const theirs = h.ports.documents.seed({ tenantId: TENANT, matterId: MATTER, docType: 'OPEN_BANKING_ACCOUNT', fileName: 'Demo Bank ····7310 (connected, 24 months)', extractedFacts: { statement: await account('DEMO_DONOR', 'Anita Shah') } });
  const res = await h.svc.proofOfFundsSubmitted(TENANT, MATTER, requestId, sub([
    { kind: 'mortgage', amountPennies: 30_000_000, description: 'Mortgage', evidenceDocumentIds: [] },
    { kind: 'savings', amountPennies: 5_000_000, description: 'Saved from salary', evidenceDocumentIds: [mine.id] },
    { kind: 'gift', amountPennies: 5_000_000, description: 'From my mother', evidenceDocumentIds: [], gift: { donorName: 'Anita Shah', donorRelationship: 'mother', repayable: false, donorAbroad: false, donorEvidenceDocumentIds: [theirs.id] } },
  ]));
  const ev = res.events.find((e) => e.type === 'proof_of_funds_submitted')!;
  const p = ev.payload as unknown as { statements: Array<{ provenance?: string }>; flags: Array<{ code: string }> };
  assert.ok(p.statements.length === 2 && p.statements.every((s) => s.provenance === 'open_banking'), 'read without extraction, marked bank-verified');
  assert.ok(p.flags.some((f) => f.code === 'GIFT_DONOR_FUNDS_RECENT'));
  assert.ok(Object.values(res.state.proofOfFunds.queries ?? {}).some((q) => (q as { flagCode: string }).flagCode === 'GIFT_DONOR_FUNDS_RECENT'), 'its question is drafted for the conveyancer');
  const d = firstDecision(res.state, 'proof_of_funds');
  const declaration = await h.ports.documents.get(TENANT, d.sourceDocumentId);
  assert.match(String((declaration?.extractedFacts as { content?: string })?.content ?? ''), /SOURCE OF FUNDS ANALYSIS[\s\S]*Gift £50,000: Held, not yet moved/);
  assert.equal(res.state.proofOfFunds.risk, 'enhanced', 'the donor\'s recent windfall makes it enhanced due diligence');
});
