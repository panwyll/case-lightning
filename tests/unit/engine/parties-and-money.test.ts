/**
 * Parties and money: a PEP, the firm on both sides, a company paying for an individual, a new price over a relief or
 * scheme ceiling, a seller who bought under six months ago, the overseas-entity and client-abroad shapes, the Stamp
 * Duty in what the client has to find, and the people events beyond death, capacity and bankruptcy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { titleFindings } from '../../../lib/server/engine/findings';
import { evaluateProofOfFunds, factsFromSubmission, type ProofOfFundsSubmission } from '../../../lib/server/engine/proof-of-funds';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { harness, TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const purchase = (over: Partial<MatterState> = {}): MatterState => ({ ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_exchange', hasLender: true, partyNames: ['Asha Patel', 'Ben Carter'], ...over });
const open = (s: MatterState) => Object.values(s.issues).filter((i) => i.status === 'open');

test('a PEP match raises enhanced due diligence and senior approval', () => {
  let s = purchase({ stage: 'instruction', idCheck: { ...initialState(TENANT, MATTER).idCheck, status: 'requested' } });
  s = fold(s, { type: 'id_check_result', documentId: 'd1', facts: { provider: 'x', outcome: 'refer', confidence: 0.99, flags: [{ code: 'PEP_MATCH', severity: 'medium', description: 'Domestic PEP' }] } });
  const pep = open(s).find((i) => i.title.startsWith('Politically exposed'))!;
  assert.ok(pep);
  assert.equal(pep.kind, 'aml_kyc_problem');
  assert.match(pep.detail ?? '', /senior management approval/);
});

test('the firm acting for the other side raises the SRA conflict issue at enrol', async () => {
  const h = harness();
  const r = await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'], counterpartyType: 'internal' });
  const i = Object.values(r.state.issues).find((x) => x.title === 'The firm acts for the other side too')!;
  assert.equal(i.gate, 'exchange');
  assert.equal(i.severity, 'critical');
});

test('overseas entity and client abroad shapes raise their checklist issues', async () => {
  const h = harness();
  const r = await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_purchase', hasLender: false, requiredSearches: [], shapes: ['overseas_entity', 'client_abroad'] });
  const titles = Object.values(r.state.issues).map((i) => i.title).join(' | ');
  assert.match(titles, /Overseas entity: Register of Overseas Entities ID/);
  assert.match(titles, /Client living abroad/);
});

test("a company paying an individual buyer's money is an AML issue holding completion", () => {
  const base = { ...purchase({ stage: 'pre_completion', hasLender: false, partyNames: ['Priya Shah'] }), waits: [{ key: 'funds' as const, subject: 'client', openedAt: '2026-09-20T10:00:00Z', closedAt: null, openedByEventId: 'e3', closedByEventId: null, chases: [], escalatedAt: null } as never] };
  const s = fold(base, { type: 'funds_received', fromRole: 'client', remitter: 'SHAH HOLDINGS LTD' });
  const i = open(s).find((x) => x.title.startsWith('A company paid'))!;
  assert.ok(i);
  assert.equal(i.gate, 'completion');
  const company = fold({ ...base, shapes: ['company_buyer'] }, { type: 'funds_received', fromRole: 'client', remitter: 'SHAH HOLDINGS LTD' });
  assert.ok(!open(company).some((x) => x.title.startsWith('A company paid')), 'a company buyer paying its own money is not a third party');
});

test("a new price over £500,000 loses first-time buyers' relief; over £450,000 the Lifetime ISA cannot be used", () => {
  const ftb = purchase({ purchasePricePennies: 48_000_000, sdltBasis: { firstTimeBuyer: true, additionalProperty: false, nonUkResident: false } as never });
  const s = fold(ftb, { type: 'record_price_change', toPennies: 51_000_000, reason: 'Agreed extras' });
  assert.ok(open(s).some((i) => i.title.startsWith("Over £500,000: first-time buyers' relief is lost")));
  const lisa = fold(purchase({ purchasePricePennies: 44_000_000, shapes: ['lifetime_isa'] }), { type: 'record_price_change', toPennies: 46_000_000, reason: 'Agreed extras' });
  assert.ok(open(lisa).some((i) => i.title.startsWith('Over £450,000: the Lifetime ISA')));
  const under = fold(ftb, { type: 'record_price_change', toPennies: 49_000_000, reason: 'Agreed extras' });
  assert.ok(!open(under).some((i) => i.title.startsWith('Over £500,000')));
});

test('a seller who bought under six months ago is flagged for the lender on a purchase', () => {
  const recent = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const f = titleFindings({ titleNumber: 'AB1', tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.95, proprietorSince: recent, pricePaidPennies: 20_000_000 }, { side: 'buyer', hasLender: true });
  const flag = f.find((x) => x.code === 'OWNED_UNDER_SIX_MONTHS')!;
  assert.equal(flag.kind, 'lender_approval');
  assert.match(flag.detail, /£200,000/);
  const old = titleFindings({ titleNumber: 'AB1', tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.95, proprietorSince: '2015-01-01' }, { side: 'buyer', hasLender: true });
  assert.ok(!old.some((x) => x.code === 'OWNED_UNDER_SIX_MONTHS'));
});

test('proof of funds counts the Stamp Duty in what the client has to find', () => {
  const sub: ProofOfFundsSubmission = { declarant: { fullName: 'Priya Shah' }, purchasePricePennies: 30_000_000, mortgageAdvancePennies: 20_000_000, sources: [{ kind: 'savings', amountPennies: 10_000_000, description: 'Savings', evidenceDocumentIds: ['a'] }], declarations: { accurate: true, noThirdPartyInterest: true, noUndisclosedBorrowing: true }, submittedAt: '2026-09-20T10:00:00Z' };
  assert.equal(factsFromSubmission('r', sub, null).shortfallPennies ?? 0, 0);
  const withSdlt = factsFromSubmission('r', sub, null, 500_000);
  assert.equal(withSdlt.requiredPennies, 10_500_000);
  const short = (evaluateProofOfFunds(withSdlt) as { flags: Array<{ code: string; description: string }> }).flags.find((f) => f.code === 'POF_SHORTFALL')!;
  assert.match(short.description, /Stamp Duty/);
});

test('people events: each raises its issue, and a complaint can still be recorded after completion', () => {
  const s0 = purchase();
  const kinds = (event: string) => open(fold(s0, { type: 'record_party_event', event, party: 'Asha Patel' })).map((i) => `${i.kind}:${i.gate}`);
  assert.deepEqual(kinds('instructing_for_client'), ['aml_kyc_problem:exchange']);
  assert.deepEqual(kinds('confidence'), ['joint_client_conflict:exchange']);
  assert.deepEqual(kinds('refuses_to_sign'), ['joint_client_conflict:exchange']);
  assert.deepEqual(kinds('capacity_doubt'), ['power_of_attorney_issue:exchange']);
  assert.deepEqual(kinds('cdd_refused'), ['aml_kyc_problem:exchange']);
  assert.deepEqual(kinds('withhold_from_lender'), ['lender_approval:exchange']);
  assert.deepEqual(kinds('gift_withdrawn'), ['completion_funds_shortfall:exchange']);
  assert.deepEqual(kinds('uncontactable'), ['transaction_at_risk:exchange']);
  assert.deepEqual(kinds('complaint'), ['complaint:none']);
  assert.deepEqual(kinds('moving_firm'), ['other:none']);
  const done = { ...s0, stage: 'post_completion' as const, completion: { ...s0.completion, confirmedAt: '2026-09-01T10:00:00Z' } };
  assert.deepEqual(open(fold(done, { type: 'record_party_event', event: 'complaint', party: 'Asha Patel' })).map((i) => i.kind), ['complaint']);
  assert.throws(() => fold(done, { type: 'record_party_event', event: 'gift_withdrawn', party: 'Asha Patel' }), /has completed/);
});

test('a shape found mid-case raises its checklist; not twice, not on the wrong side', () => {
  const s = fold(purchase(), { type: 'add_shape', shape: 'vulnerable_client' });
  assert.ok(s.shapes?.includes('vulnerable_client'));
  assert.deepEqual(open(s).map((i) => i.kind), ['vulnerable_client']);
  assert.throws(() => fold(s, { type: 'add_shape', shape: 'vulnerable_client' }), /Already recorded/);
  assert.throws(() => fold(purchase(), { type: 'add_shape', shape: 'separating_owners' }), /does not apply/);
  const exchanged = fold(purchase({ exchange: { ...purchase().exchange, exchangedAt: '2026-09-30T10:00:00Z' } }), { type: 'add_shape', shape: 'related_party' });
  assert.equal(open(exchanged)[0].gate, 'completion', 'after exchange the checklist holds completion');
});

test('a minor on the ID document raises the minor issue', async () => {
  const { reviewIdDocument } = await import('../../../lib/server/engine/id-document');
  const facts = reviewIdDocument({ provider: 'photo', source: 'document', outcome: 'refer', flags: [], confidence: 0.9, identity: { documentType: 'passport', fullName: 'Asha Patel', dateOfBirth: '2010-05-01', expiryDate: '2030-01-01', issuingCountry: 'GB', photoPresent: true, wholeDocumentVisible: true, signsOfAlteration: [] } } as never, ['Asha Patel'], NOW);
  assert.ok(facts.flags.some((f) => f.code === 'MINOR_PARTY'));
  let s = purchase({ stage: 'instruction', idCheck: { ...initialState(TENANT, MATTER).idCheck, status: 'requested' } });
  s = fold(s, { type: 'id_check_result', documentId: 'd1', facts });
  assert.ok(open(s).some((i) => i.kind === 'minor_party'));
});

test('a court order on the register holds exchange', () => {
  const f = titleFindings({ titleNumber: 'AB1', tenure: 'freehold', restrictions: [{ code: 'B3', text: 'Under an order of the High Court (freezing order) no disposition is to be registered without the consent of the claimant' }], charges: [], covenants: [], confidence: 0.95 }, { side: 'buyer', hasLender: true });
  const order = f.find((x) => x.code.startsWith('COURT_ORDER'))!;
  assert.equal(order.severity, 'critical');
  assert.equal(order.gate, 'exchange');
});

test('more people events: a donor of a power dies, a gift donor dies, a company is struck off, a sanctions designation is a hard stop', () => {
  const s0 = purchase();
  const kinds = (event: string, base = s0) => open(fold(base, { type: 'record_party_event', event, party: 'Asha Patel' })).map((i) => i.kind);
  assert.deepEqual(kinds('donor_died'), ['probate_issue']);
  assert.deepEqual(kinds('gift_donor_died'), ['completion_funds_shortfall']);
  assert.deepEqual(kinds('company_insolvent'), ['bankruptcy_insolvency']);
  assert.deepEqual(kinds('contributions_changed'), ['co_ownership_advice']);
  const sanctioned = fold(s0, { type: 'record_party_event', event: 'sanctions_designated', party: 'Asha Patel' });
  assert.throws(() => decide(sanctioned, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: 'b', purpose: 'deposit' } as never, { now: NOW }), /sanctions/);
  // A co-owner selling dies: the survivor sells alone or appoints a second trustee.
  const sale = purchase({ transactionType: 'freehold_sale', hasLender: false });
  const died = open(fold(sale, { type: 'record_party_event', event: 'died', party: 'Ben Carter' }));
  assert.match(died[0].detail ?? '', /survivor sells alone/);
});

test('deal events: a nominee after exchange tells the lender; a buy-out replaces the sale', () => {
  const ex = purchase({ exchange: { ...purchase().exchange, exchangedAt: '2026-09-30T10:00:00Z' } });
  const s = fold(ex, { type: 'record_deal_event', event: 'nominee', detail: 'Add Chris Lee to the transfer' });
  assert.deepEqual(open(s).map((i) => i.kind).sort(), ['client_change', 'lender_approval']);
  const sale = purchase({ transactionType: 'freehold_sale', hasLender: false });
  assert.match(open(fold(sale, { type: 'record_deal_event', event: 'buy_out', detail: 'Ben is buying Asha out' }))[0].detail ?? '', /transfer of equity/);
});

test('chain links: added, updated in place, removed; fixed at exchange', () => {
  let s = fold(purchase(), { type: 'record_chain_link', label: 'Our seller\'s purchase', status: 'unknown' });
  s = fold(s, { type: 'record_chain_link', label: 'Top of chain (vacant)', status: 'ready' });
  s = fold(s, { type: 'record_chain_link', linkId: 'L1', label: 'Our seller\'s purchase', status: 'not_ready' });
  assert.deepEqual(s.chainLinks?.map((l) => `${l.id}:${l.status}`), ['L1:not_ready', 'L2:ready']);
  s = fold(s, { type: 'record_chain_link', linkId: 'L2', label: 'x', status: 'removed' });
  assert.deepEqual(s.chainLinks?.map((l) => l.id), ['L1']);
  assert.throws(() => fold({ ...s, exchange: { ...s.exchange, exchangedAt: NOW.toISOString() } }, { type: 'record_chain_link', label: 'x', status: 'ready' }), /exchanged/);
});
