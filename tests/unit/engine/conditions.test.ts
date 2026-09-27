/**
 * The conditions register (docs/conditions-register.md): the gaps the Lenders' Handbook and the
 * LSAG guidance closed on 2026-09-27. Each test is one row of the register moving to "gated" or "flagged".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, stageBlockers } from '../../../lib/server/engine/machine';
import { initialState, openIssues } from '../../../lib/server/engine/types';
import { deadlineActions, timedIssueActions } from '../../../lib/server/engine/sla';
import { evaluateProofOfFunds, factsFromSubmission, type ProofOfFundsSubmission } from '../../../lib/server/engine/proof-of-funds';
import { harness, FIXTURE_LEVELS, TENANT, MATTER, USER, idClear } from './helpers';

const ctx = { now: new Date('2026-09-27T10:00:00Z'), levels: FIXTURE_LEVELS };

test('attorneys, company officers, executors and occupiers named at enrolment: each person is a party to identify, each condition a checklist issue; the SDLT basis is on file from day one', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['CON29'], shapes: ['company_buyer'], partyNames: ['Acme Homes Ltd'], attorneys: ['Jane Attorney'], officers: ['Dev Director', 'Priya PSC'], executors: [], occupiers: ['Sam Lodger'], sdlt: { firstTimeBuyer: false, additionalProperty: true, nonUkResident: false } });
  const s = await h.svc.getState(TENANT, MATTER);
  const labels = Object.values(s.partyChecks).map((pc) => pc.label).sort();
  assert.deepEqual(labels, ['Dev Director (director / PSC)', 'Jane Attorney (attorney)', 'Priya PSC (director / PSC)']);
  for (const pc of Object.values(s.partyChecks)) assert.equal(pc.status, 'requested', `${pc.label} requested on enrolment`);
  const kinds = openIssues(s).map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['company_buyer_checks', 'company_buyer_checks', 'occupier_consent', 'power_of_attorney_issue', 'sdlt_basis']);
  assert.ok(openIssues(s).find((i) => i.kind === 'occupier_consent')!.title.includes('Sam Lodger'));
  assert.deepEqual(s.sdltBasis, { firstTimeBuyer: false, additionalProperty: true, nonUkResident: false });
  assert.ok(stageBlockers(s).some((b) => /ID\/AML check for Jane Attorney \(attorney\) requested/.test(b)), 'the attorney holds Instruction like a co-client');
});

test('add_party after enrolment; an unidentified party holds exchange as well as Instruction', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_contract');
  await h.svc.run(TENANT, MATTER, { type: 'add_party', actor: USER, name: 'Late Executor', role: 'executor' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'add_party', actor: USER, name: 'Late Executor', role: 'executor' }), /already a party/);
  s = await h.svc.getState(TENANT, MATTER);
  const pc = s.partyChecks['executor:late-executor'];
  assert.ok(pc && pc.role === 'executor' && pc.status === 'requested');
  // At the exchange gate the machine names the unresolved person.
  const atExchange = { ...s, stage: 'pre_exchange' as const, requiredSearches: [], searches: {}, requireProofOfFunds: false, requireExchangeAuthority: false, exchange: { ...s.exchange, conditionsMet: true } };
  assert.throws(() => decide(atExchange, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-01' }, ctx), /Cannot exchange: ID \/ AML not resolved for Late Executor \(executor \/ trustee\)/);
});

test("the lender's pre-completion checks gate a lender-funded purchase, not a cash one; an expired priority period is refused; the deadline timer raises the OS1 two working days out", () => {
  const base = { ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase' as const, stage: 'pre_completion' as const, hasLender: true, deeds: { mortgageDeedAt: '2026-09-20T10:00:00Z', certificateOfTitleAt: '2026-09-21T10:00:00Z', transferDeedAt: '2026-09-20T10:00:00Z', deedOfTrustAt: null } };
  const cmd = { type: 'completion_confirmed' as const, actor: USER };
  assert.throws(() => decide(base, cmd, ctx), /bankruptcy search \(K16\)/);
  const k16 = { ...base, preCompletion: { ...base.preCompletion, bankruptcySearchAt: '2026-09-25T10:00:00Z' } };
  assert.throws(() => decide(k16, cmd, ctx), /No priority search \(OS1\)/);
  const os1Expired = { ...k16, preCompletion: { ...k16.preCompletion, prioritySearchAt: '2026-08-01T10:00:00Z', prioritySearchExpiresAt: '2026-09-10' } };
  assert.throws(() => decide(os1Expired, cmd, ctx), /priority period of the OS1 expired on 2026-09-10/);
  const os1 = { ...k16, preCompletion: { ...k16.preCompletion, prioritySearchAt: '2026-09-25T10:00:00Z', prioritySearchExpiresAt: '2026-10-30' } };
  assert.throws(() => decide(os1, cmd, ctx), /Buildings insurance has not been confirmed/);
  const insured = { ...os1, preCompletion: { ...os1.preCompletion, insuranceConfirmedAt: '2026-09-26T10:00:00Z' } };
  assert.throws(() => decide(insured, cmd, ctx), /Funds have not been received/, 'past the Handbook checks, on to the money');
  const cash = { ...base, hasLender: false, deeds: { ...base.deeds, mortgageDeedAt: null, certificateOfTitleAt: null } };
  assert.throws(() => decide(cash, cmd, ctx), /Funds have not been received/, 'no lender: the checks are good practice, not a gate');
  assert.ok(stageBlockers(base).includes('priority search (OS1) not made'));
  // The timer: two working days before the priority period ends.
  const soon = { ...os1, preCompletion: { ...os1.preCompletion, prioritySearchExpiresAt: '2026-09-29' } };
  const d = deadlineActions(soon, new Date('2026-09-25T09:00:00Z'));
  assert.ok(d.some((x) => x.kind === 'priority_period_expiry' && x.dueDate === '2026-09-29'), JSON.stringify(d));
});

test("the client's balance from an account never seen in the evidence raises an AML issue that holds completion; from the declarant it does not", () => {
  const base = { ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase' as const, stage: 'pre_completion' as const, hasLender: false, partyNames: ['Priya Shah'], waits: [{ key: 'id_check' as const, subject: '', openedAt: '2026-09-01T10:00:00Z', closedAt: '2026-09-02T10:00:00Z', openedByEventId: 'e1', closedByEventId: 'e2', chases: [], escalatedAt: null } as never, { key: 'funds' as const, subject: 'client', openedAt: '2026-09-20T10:00:00Z', closedAt: null, openedByEventId: 'e3', closedByEventId: null, chases: [], escalatedAt: null } as never] };
  base.proofOfFunds = { ...base.proofOfFunds, statements: [{ documentId: 'd1', fileName: 'nationwide.pdf', holder: 'MRS P SHAH', bank: 'Nationwide', from: null, to: null, transactions: 12, credits: 3, closingPennies: 4_500_000, readable: true }] };
  const ok = decide(base, { type: 'funds_received', actor: USER, fromRole: 'client', remitter: 'P SHAH' }, ctx);
  assert.ok(!ok.events.some((e) => e.type === 'issue_raised'));
  const stranger = decide(base, { type: 'funds_received', actor: USER, fromRole: 'client', remitter: 'MR K PATEL' }, ctx);
  const issue = stranger.events.find((e) => e.type === 'issue_raised');
  assert.ok(issue, 'an issue is raised');
  const p = issue!.payload as { kind: string; gate: string; title: string; severity: string };
  assert.equal(p.kind, 'aml_kyc_problem');
  assert.equal(p.gate, 'completion');
  assert.match(p.title, /MR K PATEL/);
  assert.equal(p.severity, 'critical');
});

test('proof of funds: a gift from outside the family, a cash purchase, and the source-of-wealth question at enhanced risk', () => {
  const sub = (over: Partial<ProofOfFundsSubmission>): ProofOfFundsSubmission => ({ declarant: { fullName: 'Priya Shah' }, purchasePricePennies: 30_000_000, mortgageAdvancePennies: 20_000_000, sources: [], declarations: { accurate: true, noThirdPartyInterest: true, noUndisclosedBorrowing: true }, submittedAt: '2026-09-20T10:00:00Z', ...over });
  const friend = factsFromSubmission('r1', sub({ sources: [{ kind: 'savings', amountPennies: 6_000_000, description: 'Savings', evidenceDocumentIds: ['a'] }, { kind: 'gift', amountPennies: 4_000_000, description: 'From a friend', evidenceDocumentIds: ['g'], gift: { donorName: 'Ravi Friend', donorRelationship: 'friend', repayable: false, donorAbroad: false, donorEvidenceDocumentIds: ['g'] } }] }), null);
  const v1 = evaluateProofOfFunds(friend);
  assert.ok(v1.outcome === 'flag' && v1.flags.some((f) => f.code === 'POF_GIFT_NON_FAMILY'), 'friend → non-family flag');
  const mother = factsFromSubmission('r2', sub({ sources: [{ kind: 'savings', amountPennies: 6_000_000, description: 'Savings', evidenceDocumentIds: ['a'] }, { kind: 'gift', amountPennies: 4_000_000, description: 'From mum', evidenceDocumentIds: ['g'], gift: { donorName: 'Anita Shah', donorRelationship: 'my mother', repayable: false, donorAbroad: false, donorEvidenceDocumentIds: ['g'] } }] }), null);
  const v2 = evaluateProofOfFunds(mother);
  assert.ok(v2.outcome === 'flag' && !v2.flags.some((f) => f.code === 'POF_GIFT_NON_FAMILY'), 'mother → no non-family flag');
  const cash = factsFromSubmission('r3', sub({ mortgageAdvancePennies: null, sources: [{ kind: 'savings', amountPennies: 30_000_000, description: 'Savings', evidenceDocumentIds: ['a'] }] }), null);
  const v3 = evaluateProofOfFunds(cash);
  assert.ok(v3.outcome === 'flag' && v3.flags.some((f) => f.code === 'POF_CASH_PURCHASE'), 'no advance → cash purchase flag');
});

test('a relevant building without its certificates raises a Building Safety Act issue holding exchange; unregistered land halts automation; CDD over a year old is raised by the timer', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'leasehold_purchase', hasLender: true, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  let s = await h.svc.getState(TENANT, MATTER);
  const pack = decide(s, { type: 'management_pack_received', actor: USER, documentId: h.doc({ kind: 'pack' }, 'MANAGEMENT_PACK'), facts: { flags: [], confidence: 0.9, buildingSafety: { relevantBuilding: true, leaseholderDeedOfCertificate: false, landlordCertificate: null, remediation: 'EWS1 B1 dated 2024' } } }, ctx);
  const bsa = pack.events.find((e) => e.type === 'issue_raised');
  assert.ok(bsa, 'building_safety issue raised');
  assert.match((bsa!.payload as { title: string }).title, /no leaseholder deed of certificate for a relevant building/);
  assert.equal((bsa!.payload as { gate: string }).gate, 'exchange');
  // Unregistered land: the epitome is read, and automation stops.
  const unreg = decide({ ...s, title: { ...s.title, status: 'requested' as never, documentId: 'd-title' } }, { type: 'title_extracted', actor: 'system', documentId: 'd-title', facts: { titleNumber: 'n/a', tenure: 'leasehold', restrictions: [], charges: [], covenants: [], confidence: 0.9, unregistered: true }, extractor: 'fixture' } as never, ctx);
  assert.ok(unreg.events.some((e) => e.type === 'manual_handling_required' && (e.payload as { reason: string }).reason === 'unregistered_land'));
  // Ongoing monitoring: a year and a day after the first client's check cleared, the timer asks for a refresh; holds nothing.
  s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.idCheck.resolvedAt, 'the ID clock is set');
  const later = new Date(Date.parse(s.idCheck.resolvedAt!) + 370 * 86_400_000);
  const actions = timedIssueActions(s, later);
  const refresh = actions.find((a) => a.kind === 'raise' && a.issueKind === 'cdd_refresh');
  assert.ok(refresh, JSON.stringify(actions));
  assert.equal(timedIssueActions(s, new Date(Date.parse(s.idCheck.resolvedAt!) + 100 * 86_400_000)).some((a) => a.kind === 'raise' && a.issueKind === 'cdd_refresh'), false);
});
