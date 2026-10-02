/**
 * Money: the source-of-funds form read more closely (a dividend, a director's loan, cash, a source the rules cannot
 * classify, money still to arrive, a high-risk country, the lender's deposit rules, gifts with strings), the mortgage
 * offer against the case, new money after a down-valuation, deals and events about money, ISA dates, the shared
 * ownership election, and what goes back to the client at the end (the balance left, interest).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { offerFindings } from '../../../lib/server/engine/findings';
import { contributionsFrom, declarationQueries, evaluateProofOfFunds, factsFromSubmission, highRiskCountry, type ProofOfFundsSubmission } from '../../../lib/server/engine/proof-of-funds';
import { chargeableConsideration } from '../../../lib/server/engine/sdlt-facts';
import { interestDue } from '../../../lib/server/engine/money';
import { dueSteps } from '../../../lib/server/engine/due';
import { initialState, openPofQueries, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, SENIOR } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>, now = NOW): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: now.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const purchase = (over: Partial<MatterState> = {}): MatterState => ({ ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_exchange', hasLender: true, partyNames: ['Priya Shah'], purchasePricePennies: 30_000_000, ...over });
const open = (s: MatterState) => Object.values(s.issues).filter((i) => i.status === 'open');
const sub = (sources: ProofOfFundsSubmission['sources'], over: Partial<ProofOfFundsSubmission> = {}): ProofOfFundsSubmission => ({ declarant: { fullName: 'Priya Shah' }, purchasePricePennies: 30_000_000, mortgageAdvancePennies: 20_000_000, sources, declarations: { accurate: true, noThirdPartyInterest: true, noUndisclosedBorrowing: true }, submittedAt: '2026-09-20T10:00:00Z', ...over });
const codes = (s: ProofOfFundsSubmission, m = {}) => { const v = evaluateProofOfFunds(factsFromSubmission('r', s, null), m); return v.outcome === 'flag' ? v.flags.map((f) => f.code) : []; };

test('source types: a dividend, a director\'s loan, a bridging loan, cash and an unclassifiable source each get their own flag', () => {
  const ev = ['e'];
  assert.ok(codes(sub([{ kind: 'dividend', amountPennies: 10_000_000, description: 'Dividend from Shah Ltd', evidenceDocumentIds: ev }])).includes('POF_DIVIDEND'));
  assert.ok(codes(sub([{ kind: 'directors_loan', amountPennies: 10_000_000, description: 'DLA', evidenceDocumentIds: ev }])).includes('POF_LOAN'));
  assert.ok(codes(sub([{ kind: 'bridging_loan', amountPennies: 10_000_000, description: 'Bridge', evidenceDocumentIds: ev }])).includes('POF_BRIDGING'));
  assert.ok(codes(sub([{ kind: 'cash', amountPennies: 10_000_000, description: 'Cash at home', evidenceDocumentIds: ev }])).includes('POF_CASH'));
  const other = sub([{ kind: 'other', amountPennies: 10_000_000, description: 'Money from a friend\'s business', evidenceDocumentIds: ev }]);
  assert.ok(codes(other).includes('POF_SOURCE_UNCLEAR'));
  assert.equal(declarationQueries(factsFromSubmission('r', other, null))[0].flagCode, 'POF_SOURCE_UNCLEAR', 'a query is drafted');
  assert.ok(codes(sub([{ kind: 'pension', amountPennies: 10_000_000, description: 'Lump sum', evidenceDocumentIds: ev }])).includes('POF_PENSION'));
});

test('gifts with strings, through someone else, from a high-risk country; lender rules; money not yet received', () => {
  const gift = (g: Record<string, unknown>) => sub([{ kind: 'gift', amountPennies: 10_000_000, description: 'From mum', evidenceDocumentIds: [], gift: { donorName: 'Anita Shah', donorRelationship: 'mother', repayable: false, donorAbroad: false, donorEvidenceDocumentIds: ['g'], ...g } as never }]);
  assert.ok(codes(gift({ expectsShare: true })).includes('POF_GIFT_NOT_A_GIFT'));
  assert.ok(codes(gift({ via: 'Raj Shah' })).includes('POF_GIFT_VIA'));
  assert.ok(codes(gift({ donorAbroad: true, donorCountry: 'Iran' })).includes('POF_HIGH_RISK_COUNTRY'));
  assert.ok(codes(gift({ donorAbroad: true }), { acceptsDonorAbroad: false }).includes('POF_LENDER_RULE'));
  assert.ok(codes(sub([{ kind: 'loan', amountPennies: 10_000_000, description: 'Loan', evidenceDocumentIds: ['e'] }]), { acceptsLoanDeposit: false }).includes('POF_LENDER_RULE'));
  assert.ok(highRiskCountry('the Democratic Republic of the Congo') && !highRiskCountry('France'));
  assert.ok(codes(sub([{ kind: 'inheritance', amountPennies: 10_000_000, description: 'Estate of my aunt', evidenceDocumentIds: ['e'], notYetReceived: true }])).includes('POF_NOT_YET_RECEIVED'));
  assert.ok(codes(sub([{ kind: 'overseas', amountPennies: 10_000_000, description: 'Savings in Spain', evidenceDocumentIds: ['e'], overseas: { country: 'Spain', alreadyInUk: false } }])).includes('POF_NOT_YET_RECEIVED'), 'money still abroad');
});

test("each buyer's money from the sources attributed to them", () => {
  const f = factsFromSubmission('r', sub([
    { kind: 'savings', amountPennies: 8_000_000, description: 'Mine', evidenceDocumentIds: ['e'], owner: 'Priya Shah' },
    { kind: 'gift', amountPennies: 2_000_000, description: 'For Tom', evidenceDocumentIds: [], gift: { donorName: 'Ann Lee', donorRelationship: 'mother', repayable: false, donorAbroad: false, donorEvidenceDocumentIds: ['g'], forBuyer: 'Tom Lee' } },
  ]), null);
  assert.deepEqual(contributionsFrom(f, ['Priya Shah', 'Tom Lee']), [{ party: 'Priya Shah', pennies: 8_000_000 }, { party: 'Tom Lee', pennies: 2_000_000 }]);
  assert.equal(contributionsFrom(f, ['Priya Shah']), null, 'one buyer: nothing to attribute');
});

test('a high-risk country cannot be signed off by the handler; money still to arrive holds exchange after sign-off', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [], partyNames: ['Priya Shah'] });
  const r = await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  const requestId = r.state.proofOfFunds.requestId!;
  await h.svc.proofOfFundsSubmitted(TENANT, MATTER, requestId, sub([
    { kind: 'savings', amountPennies: 6_000_000, description: 'Savings', evidenceDocumentIds: ['e1'] },
    { kind: 'overseas', amountPennies: 4_000_000, description: 'Sale of a flat in Lagos', evidenceDocumentIds: ['e2'], overseas: { country: 'Nigeria', alreadyInUk: false } },
  ]), { e1: 'savings.pdf', e2: 'lagos.pdf' });
  let s = await h.svc.getState(TENANT, MATTER);
  const d = firstDecision(s, 'proof_of_funds');
  await assert.rejects(resolve(h, d.eventId, 'approve', USER, 'Queries covered at the meeting'), /escalate this to the MLRO/);
  // Escalated, the MLRO signs off; the money still abroad then holds exchange until it arrives.
  await resolve(h, d.eventId, 'escalate', USER, 'High-risk country: MLRO to sign off');
  s = await h.svc.getState(TENANT, MATTER);
  const esc = Object.values(s.decisions).find((x) => x.status === 'pending' && x.origin?.decisionEventId === d.eventId)!;
  assert.ok(esc, 'the escalation is with the MLRO');
  await resolve(h, esc.eventId, 'approve', SENIOR, 'EDD done: source of wealth evidenced');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.proofOfFunds.resolution, 'approve');
  assert.ok(Object.values(s.issues).some((i) => i.status === 'open' && i.title.startsWith('Money still to arrive') && i.gate === 'exchange'));
  assert.equal(openPofQueries(s).length, 0);
});

test('the offer against the case: borrowers, price, a smaller advance, a re-issue, conditions to satisfy (not a retention)', () => {
  const base = { lender: 'Big Bank', conditions: [], confidence: 0.9 };
  const ctx = { clients: ['Priya Shah', 'Tom Lee'], pricePennies: 30_000_000, declaredAdvancePennies: 20_000_000, previous: null, exchanged: false };
  const codesOf = (o: object, c = ctx) => offerFindings({ ...base, ...o } as never, c).map((f) => f.code.split(':')[0]);
  assert.deepEqual(codesOf({ borrowerNames: ['Mrs P Shah'] }), ['OFFER_BORROWERS']);
  assert.deepEqual(codesOf({ borrowerNames: ['Priya Shah', 'Tom Lee'], purchasePricePennies: 31_000_000 }), ['OFFER_PRICE']);
  assert.deepEqual(codesOf({ amountPennies: 19_000_000 }), ['OFFER_ADVANCE_SHORT']);
  const prev = { ...base, conditions: [{ code: 'SC1', text: 'Valuation subject to roof report', standard: false }] };
  assert.deepEqual(codesOf({ conditions: [...prev.conditions, { code: 'SC2', text: 'Evidence of the deposit must be provided prior to completion', standard: false }] }, { ...ctx, previous: prev as never }), ['OFFER_REISSUED', 'OFFER_CONDITION']);
  assert.deepEqual(codesOf({ conditions: [{ code: 'SC4', text: 'Retention of £5,000 pending roof repairs, released on confirmation', standard: false }] }), []);
});

test('new money after a down-valuation reopens proof of funds; a signed-off PoF with a new money question asks again', () => {
  const pof = { ...initialState(TENANT, MATTER).proofOfFunds, status: 'reviewed' as const, resolution: 'approve' as const, requestId: 'r1' };
  let s = purchase({ requireProofOfFunds: true, proofOfFunds: pof });
  s = fold(s, { type: 'raise_issue', kind: 'valuation_issue', title: 'Down-valuation £10,000', detail: 'Valued at £290,000', gate: 'exchange' });
  const v = open(s).find((i) => i.kind === 'valuation_issue')!;
  s = fold(s, { type: 'resolve_issue', issueId: v.id, resolution: 'buyer_covers_shortfall', note: 'Client pays the £10,000', costPennies: 1_000_000, paidBy: 'buyer', details: { advised: true } });
  assert.ok(open(s).some((i) => i.kind === 'source_of_funds' && i.title.startsWith('Extra money from the client')));
  assert.ok(dueSteps(s).some((d) => d.key === 'proof_of_funds_followup'), 'a further round is due');
});

test('money events: an incentive and a deposit paid direct; a fee dispute and a request to pay someone else after completion; cash', () => {
  assert.equal(open(fold(purchase(), { type: 'record_deal_event', event: 'incentive', detail: 'Developer pays £5,000 towards the deposit', amountPennies: 500_000 }))[0].kind, 'lender_approval');
  assert.equal(open(fold(purchase(), { type: 'record_deal_event', event: 'deposit_direct', detail: 'Reservation fee £2,000 paid to the agent' }))[0].kind, 'deposit_issue');
  const done = purchase({ stage: 'post_completion', completion: { ...initialState(TENANT, MATTER).completion, confirmedAt: '2026-09-01T10:00:00Z' } });
  assert.equal(open(fold(done, { type: 'record_party_event', event: 'fee_dispute', party: 'Priya Shah' }))[0].kind, 'complaint');
  assert.equal(open(fold(done, { type: 'record_party_event', event: 'third_party_payment', party: 'Priya Shah' }))[0].kind, 'aml_kyc_problem');
  assert.equal(open(fold(purchase(), { type: 'record_party_event', event: 'cash_paid_in', party: 'Priya Shah' }))[0].severity, 'critical');
});

test('ISAs: both bonuses at enrol, a Lifetime ISA too new, the Help to Buy claim deadline, the bonus before exchange', async () => {
  const h = harness();
  const r = await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_purchase', hasLender: true, requiredSearches: [], shapes: ['lifetime_isa', 'help_to_buy_isa'] });
  assert.ok(Object.values(r.state.issues).some((i) => i.title.startsWith('Both a Lifetime ISA and a Help to Buy ISA')));
  let s = purchase({ shapes: ['lifetime_isa', 'help_to_buy_isa'], targetCompletionDate: '2026-12-01' });
  s = fold(s, { type: 'record_isa', isa: 'lifetime_isa', openedOn: '2026-03-01' });
  const lisa = open(s).find((i) => i.title.startsWith('Lifetime ISA open only since'))!;
  assert.equal(lisa.resolveBy?.slice(0, 10), '2027-03-01');
  s = fold(s, { type: 'record_isa', isa: 'help_to_buy_isa', closedOn: '2030-06-01' });
  assert.ok(open(s).some((i) => i.title === 'Claim the Help to Buy ISA bonus by 2030-12-01'), 'capped at 1 December 2030');
  const isaMoney = fold({ ...s, waits: [{ key: 'funds', subject: 'isa_provider', openedAt: '2026-09-20T10:00:00Z', closedAt: null, openedByEventId: 'e', closedByEventId: null, chases: [], escalatedAt: null } as never] }, { type: 'funds_received', fromRole: 'isa_provider' });
  assert.ok(open(isaMoney).some((i) => i.title.startsWith('Help to Buy ISA bonus before exchange')));
});

test('price cut after completion: amend the SDLT return within 12 months of filing', () => {
  const done = purchase({ stage: 'post_completion', completion: { ...initialState(TENANT, MATTER).completion, confirmedAt: '2026-09-01T10:00:00Z' }, postCompletion: { ...initialState(TENANT, MATTER).postCompletion, sdltSubmittedAt: '2026-09-05T10:00:00Z' } });
  const s = fold(done, { type: 'record_price_change', toPennies: 29_000_000, reason: 'Retention paid back for the roof' });
  const i = open(s)[0];
  assert.equal(i.kind, 'sdlt_basis');
  assert.equal(i.resolveBy?.slice(0, 10), '2027-09-05');
});

test('shared ownership: the market value election puts the tax on the full value', () => {
  const s = purchase({ shapes: ['shared_ownership'], purchasePricePennies: 10_000_000, sdltFacts: { soMarketValue: true, soMarketValuePennies: 40_000_000 } as never });
  assert.equal(chargeableConsideration(s), 40_000_000);
  assert.equal(chargeableConsideration({ ...s, sdltFacts: {} as never }), 10_000_000);
});

test('the end: the balance left and interest on the client\'s money go back with the final bill', () => {
  const s = purchase({ stage: 'post_completion', completion: { ...initialState(TENANT, MATTER).completion, confirmedAt: '2026-09-01T10:00:00Z' }, receipts: [{ remitter: 'P SHAH', amountPennies: 10_000_000, purpose: 'deposit', at: '2026-03-01T10:00:00Z' }] });
  const interest = interestDue(s, NOW);
  assert.ok(interest > 50_000 && interest < 51_000, String(interest)); // £100,000 at 1% for 184 days
  const after = fold(s, { type: 'final_bill_delivered', amountPennies: 150_000, balanceLeftPennies: 12_300 });
  const refunds = after.money?.refunds ?? [];
  assert.deepEqual(refunds.map((r) => r.amountPennies), [12_300, interest]);
});
