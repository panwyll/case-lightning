/**
 * Completion: the pre-completion searches and insurance read against the case, the seller's undertaking against every
 * charge, the statement re-issued, the day's timers, what goes wrong on the day, the remortgage statement and surplus,
 * payments after completion (the agent, HMRC), and what HM Land Registry asks for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, certificateOfTitleUnmet, requisitionTopic, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { deadlineActions } from '../../../lib/server/engine/sla';
import { dueSteps } from '../../../lib/server/engine/due';
import { buildCompletionStatement } from '../../../lib/server/engine/completion-statement';
import { assertCompletion } from '../../../lib/server/engine/completion';
import { routeClassification } from '../../../lib/server/engine/ingest';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>, now = NOW): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: now.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const base = initialState(TENANT, MATTER);
const exchanged = (over: Partial<MatterState> = {}): MatterState => ({ ...base, enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_completion', hasLender: true, partyNames: ['Priya Shah'], purchasePricePennies: 30_000_000, exchange: { ...base.exchange, exchangedAt: '2026-09-25T10:00:00Z', completionDate: '2026-10-16' }, ...over });
const open = (s: MatterState) => Object.values(s.issues).filter((i) => i.status === 'open');

test('the OS1: a moved completion date past its priority, the wrong title or buyer, a new entry', () => {
  const s0 = exchanged({ preCompletion: { ...base.preCompletion, prioritySearchAt: '2026-09-30T10:00:00Z', prioritySearchExpiresAt: '2026-10-20' } });
  assert.ok(open(fold(s0, { type: 'change_completion_date', completionDate: '2026-10-23', reason: 'Chain delay' })).some((i) => i.title.startsWith('Priority search ends 2026-10-20')));
  const withTitle = exchanged({ title: { ...base.title, facts: { titleNumber: 'AB123', tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.9 } as never } });
  assert.match(open(fold(withTitle, { type: 'priority_search_made', expiresAt: '2026-11-10', titleNumber: 'AB999', applicants: ['Priya Shah'] }))[0].title, /title AB999, not AB123/);
  assert.match(open(fold(withTitle, { type: 'priority_search_made', expiresAt: '2026-11-10', newEntries: 'Unilateral notice in favour of Acme Builders Ltd' }))[0].title, /new entry/);
});

test('the K16: an entry holds the certificate; one over 15 working days old or missing a borrower is redone', () => {
  const ready = exchanged({ preCompletion: { ...base.preCompletion, bankruptcySearchAt: '2026-09-30T10:00:00Z', bankruptcySubjects: ['Priya Shah'] } });
  assert.ok(!certificateOfTitleUnmet(ready, NOW).some((x) => /fresh bankruptcy/.test(x)));
  assert.ok(certificateOfTitleUnmet(ready, new Date('2026-10-30T10:00:00Z')).some((x) => /fresh bankruptcy/.test(x)), 'stale');
  assert.ok(certificateOfTitleUnmet({ ...ready, partyNames: ['Priya Shah', 'Tom Lee'] }, NOW).some((x) => /fresh bankruptcy/.test(x)), 'a borrower added');
  const hit = fold(ready, { type: 'bankruptcy_search_entry', subject: 'Priya Shah', entry: 'Bankruptcy petition, Leeds County Court, 2026' });
  assert.equal(open(hit)[0].kind, 'bankruptcy_insolvency');
  assert.ok(certificateOfTitleUnmet(hit, NOW).some((x) => x.startsWith('these settled first')));
});

test('insurance on the wrong terms; the seller\'s undertaking must cover every charge; an unrepresented seller gives none', () => {
  const ins = fold(exchanged(), { type: 'buildings_insurance_confirmed', insurer: 'Aviva', fromDate: '2026-10-20', insuredNames: ['Tom Lee'] });
  assert.match(open(ins)[0].title, /not in the name of Priya Shah; cover starts 2026-10-20, after completion/);
  const charged = exchanged({ title: { ...base.title, facts: { titleNumber: 'AB1', tenure: 'freehold', restrictions: [], covenants: [], confidence: 0.9, charges: [{ code: 'C1', text: 'Registered charge in favour of Big Bank plc' }, { code: 'C2', text: 'Registered charge in favour of Homes England (Help to Buy)' }] } as never } });
  assert.match(open(fold(charged, { type: 'completion_information_received', undertakingToRedeem: true, chargesCovered: ['Big Bank'] }))[0].title, /Not every charge is covered/);
  assert.equal(open(fold(charged, { type: 'completion_information_received', undertakingToRedeem: true, chargesCovered: ['Big Bank', 'Homes England'] })).length, 0);
  assert.ok(open(fold({ ...charged, shapes: ['unrepresented_counterparty'] }, { type: 'completion_information_received', undertakingToRedeem: false })).some((i) => i.title.startsWith('The seller is not represented')));
});

test('a re-issued statement with a bigger balance tells the client; payments never exceed the money held', () => {
  const s = exchanged({ stage: 'exchanged', money: { requested: {}, received: { client: 5_000_000 }, uncleared: [], statementBalancePennies: 5_000_000, refunds: [] } as never });
  assert.match(open(fold(s, { type: 'completion_statement_generated', balancePennies: 5_120_000 }))[0].title, /£1,200\.00 more from the client/);
  const paying = { ...s, stage: 'pre_completion' as const, bankDetails: { b1: { id: 'b1', payeeKind: 'seller_solicitor', status: 'verified', details: { sortCode: '000000', accountNumber: '00000000', accountName: 'X' } } } as never, currentBankDetails: {} as never };
  assert.throws(() => decide(paying, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: 'b1', amountPennies: 9_000_000, purpose: 'other' } as never, { now: NOW }), /more than the money held|Bank details|not/);
});

test('the day\'s timers: the advance the day before, the redemption on the day, SDLT late, a new build\'s inspection, a Friday', () => {
  const kinds = (s: MatterState, now: Date) => deadlineActions(s, now).map((d) => d.kind);
  const cot = exchanged({ deeds: { ...base.deeds, certificateOfTitleAt: '2026-10-08T10:00:00Z' } });
  assert.ok(kinds(cot, new Date('2026-10-15T09:00:00Z')).includes('advance_due'));
  const sold = { ...exchanged(), transactionType: 'freehold_sale' as const, hasExistingMortgage: true, redemption: { ...base.redemption, status: 'received' as const }, completion: { ...base.completion, confirmedAt: '2026-10-16T12:00:00Z' } };
  assert.ok(kinds(sold, new Date('2026-10-16T15:00:00Z')).includes('redemption_payment'));
  const done = exchanged({ completion: { ...base.completion, confirmedAt: '2026-10-01T12:00:00Z' } });
  assert.ok(kinds(done, new Date('2026-10-16T09:00:00Z')).includes('sdlt_overdue'));
  assert.ok(kinds(exchanged({ shapes: ['new_build'] }), new Date('2026-10-02T09:00:00Z')).includes('final_inspection'));
  const friday = deadlineActions(exchanged(), new Date('2026-10-08T09:00:00Z')).find((d) => d.kind === 'certificate_of_title')!;
  assert.match(friday.summary, /a Friday/);
  assert.equal(friday.dueDate, '2026-10-08', 'six working days before Friday 16 October');
});

test('Something Happened on the day: completion missed, money misdirected, keys after completion, a retention', () => {
  assert.ok(open(fold(exchanged({ relatedMatter: { matterId: 'm2', relation: 'sale', linkedAt: '2026-09-01' } }), { type: 'record_completion_event', event: 'completion_missed', detail: 'Lender funds not arrived' })).map((i) => i.kind).includes('chain_dependency'));
  assert.equal(open(fold(exchanged(), { type: 'record_completion_event', event: 'payment_misdirected', detail: 'Bank details were changed by email', amountPennies: 25_000_000 }))[0].severity, 'critical');
  assert.throws(() => fold(exchanged(), { type: 'record_completion_event', event: 'keys_not_released', detail: 'x' }), /after completion/);
  const after = exchanged({ completion: { ...base.completion, confirmedAt: '2026-10-16T12:00:00Z' } });
  assert.equal(open(fold(after, { type: 'record_completion_event', event: 'contract_retention', detail: 'Snagging', amountPennies: 200_000, until: '2027-01-16' }))[0].resolveBy?.slice(0, 10), '2027-01-16');
});

test('a remortgage statement: the advance less what it pays off, the surplus owed to the client on completion', () => {
  const remo = { ...base, enrolled: true, transactionType: 'remortgage' as const, hasLender: true, hasExistingMortgage: true, redemption: { ...base.redemption, status: 'received' as const, redemptionPennies: 15_000_000 } };
  const st = buildCompletionStatement({ state: remo, side: 'owner', register: [{ id: 'f1', key: 'offer.amount_pennies', value: '20000000' } as never], record: { propertyAddress: '1 Road', purchasePricePennies: null, buyerNames: ['Priya Shah'], sellerNames: [] } });
  assert.equal(st.balancePennies, 5_000_000);
  assert.match(st.text, /BALANCE DUE TO YOU/);
});

test('after completion: the agent paid once their details are in; HMRC paid after the return', () => {
  const sold = { ...exchanged(), transactionType: 'freehold_sale' as const, hasLender: false, stage: 'post_completion' as const, completion: { ...base.completion, confirmedAt: '2026-10-16T12:00:00Z' }, bankDetails: { a: { id: 'a', payeeKind: 'estate_agent', status: 'verified' } } as never };
  assert.ok(dueSteps(sold).some((d) => d.key === 'agent_commission'));
  const bought = exchanged({ stage: 'post_completion', completion: { ...base.completion, confirmedAt: '2026-10-16T12:00:00Z' }, postCompletion: { ...base.postCompletion, sdltSubmittedAt: '2026-10-20T10:00:00Z' } });
  assert.ok(dueSteps(bought).some((d) => d.key === 'sdlt_payment'));
});

test('sheets ask only what applies: the second charge on the register, the notice of charge with a lender', () => {
  assert.throws(() => assertCompletion('register_checked', { completion: {} }, ['second_charge']), /both charges registered/);
  assert.doesNotThrow(() => assertCompletion('register_checked', { completion: {} }, []));
  assert.throws(() => assertCompletion('notice_of_assignment_served', { servedOn: 'Landlord', completion: {} }, [], true), /notice of the lender's charge/);
  assert.doesNotThrow(() => assertCompletion('notice_of_assignment_served', { servedOn: 'Landlord', completion: {} }, [], false));
});

test('Land Registry requisitions: routed when an application is pending, and what they ask for named', () => {
  assert.match(requisitionTopic('Please lodge the SDLT5 certificate')!, /SDLT certificate/);
  assert.match(requisitionTopic('Evidence of identity required: form ID1')!, /evidence of identity/);
  assert.equal(requisitionTopic('Nothing in particular'), null);
  const pending = exchanged({ postCompletion: { ...base.postCompletion, ap1SubmittedAt: '2026-10-20T10:00:00Z' } });
  assert.deepEqual(routeClassification(pending, { role: 'hmlr_requisition', confidence: 0.95, reason: 'HMLR letter' } as never), { kind: 'hmlr_requisition' });
  assert.equal(routeClassification(exchanged(), { role: 'hmlr_requisition', confidence: 0.95, reason: 'x' } as never).kind, 'skip');
});
