/**
 * The conditions register (docs/conditions-register.md): the gaps the Lenders' Handbook and the
 * LSAG guidance closed on 2026-09-27. Each test is one row of the register moving to "gated" or "flagged".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, stageBlockers } from '../../../lib/server/engine/machine';
import { initialState, openIssues, pendingDecisions } from '../../../lib/server/engine/types';
import { deadlineActions, timedIssueActions } from '../../../lib/server/engine/sla';
import { evaluateProofOfFunds, factsFromSubmission, type ProofOfFundsSubmission } from '../../../lib/server/engine/proof-of-funds';
import { harness, FIXTURE_LEVELS, TENANT, MATTER, USER, idClear, readyContract } from './helpers';

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
  await readyContract(h);
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

test('SDLT on the declared basis: standard, first-time buyer, additional property, non-resident, company flat rate', async () => {
  const { computeSdlt } = await import('../../../lib/server/engine/sdlt');
  const none = { firstTimeBuyer: false, additionalProperty: false, nonUkResident: false };
  assert.equal(computeSdlt(30_000_000, none).totalPennies, 500_000, '£300k standard: 2% of £125k + 5% of £50k = £5,000');
  assert.equal(computeSdlt(30_000_000, { ...none, firstTimeBuyer: true }).totalPennies, 0, 'first-time buyer at £300k pays nothing');
  assert.equal(computeSdlt(45_000_000, { ...none, firstTimeBuyer: true }).totalPennies, 750_000, 'first-time buyer at £450k: 5% of £150k');
  const over = computeSdlt(55_000_000, { ...none, firstTimeBuyer: true });
  assert.equal(over.scheme, 'standard residential rates');
  assert.ok(over.notes.some((n) => /not available above £500,000/.test(n)));
  assert.equal(computeSdlt(30_000_000, { ...none, additionalProperty: true }).totalPennies, 2_000_000, 'additional property at £300k: £5,000 + 5% of £300k');
  assert.equal(computeSdlt(30_000_000, { ...none, nonUkResident: true }).totalPennies, 1_100_000, 'non-resident at £300k: £5,000 + 2% of £300k');
  assert.equal(computeSdlt(60_000_000, { ...none, company: true }).totalPennies, 10_200_000, 'company over £500k: 17% flat');
});

test("the seller's TA6 read into issues on a purchase; our client's on a sale; nothing from clean answers", async () => {
  const { propertyFormsIssues } = await import('../../../lib/server/engine/property-forms');
  const clean = propertyFormsIssues({ forms: ['TA6'], disclosures: [], confidence: 0.9, answers: { flooded: false, japaneseKnotweed: false, alterations: null } }, 'buyer');
  assert.equal(clean.length, 0);
  const dirty = propertyFormsIssues({ forms: ['TA6'], disclosures: [], confidence: 0.9, answers: { disputes: 'Ongoing complaint to the council about the neighbour\'s extension', alterations: 'Loft conversion 2020', alterationsConsented: false, japaneseKnotweed: true, occupiers: 'Mrs J Smith (mother)', septicTank: true, solarPanelsLeased: true }, pages: { disputes: 2, alterations: 3, environment: 5 } }, 'buyer');
  assert.deepEqual(dirty.map((i) => i.kind).sort(), ['building_regs_missing', 'disclosure_concern', 'environmental_risk', 'occupier_consent', 'third_party_encumbrance', 'third_party_encumbrance']);
  assert.equal(dirty.find((i) => i.kind === 'building_regs_missing')!.page, 3);
  // Through the machine on a purchase: each becomes an issue cited to the document, once.
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const doc = h.doc({ forms: ['TA6'], disclosures: [], confidence: 0.9, answers: { japaneseKnotweed: true, flooded: true, floodDetail: 'Garden flooded in 2021' } }, 'PROPERTY_FORMS');
  const r = await h.svc.propertyFormsReceived(TENANT, MATTER, doc);
  assert.ok(r.events.some((e) => e.type === 'seller_forms_received'));
  // One issue listing every point (not an issue per point), cited to the document.
  const raised = r.events.filter((e) => e.type === 'issue_raised');
  assert.equal(raised.length, 1);
  assert.match((raised[0].payload as { title: string }).title, /^Seller's forms: 2 points to raise/);
  assert.ok(raised.every((e) => e.sourceDocumentId === doc || (e.payload as { sourceDocumentId: string }).sourceDocumentId === doc));
  const again = await h.svc.propertyFormsReceived(TENANT, MATTER, doc).catch((e: Error) => e);
  assert.ok(again instanceof Error ? true : again.events.filter((e) => e.type === 'issue_raised').length === 0, 'the same answers do not raise the same issues twice');
  const s = await h.svc.getState(TENANT, MATTER);
  assert.ok(openIssues(s).every((i) => i.gate === 'exchange'));
  assert.ok(s.sellerForms.receivedAt);
});

test("the lender's Part 2 on the matter: the lease review compares the minimum term; exchange refuses searches older than the limit; a non-family gift is accepted when the lender says so", async () => {
  const { evaluateLease } = await import('../../../lib/server/engine/rules');
  const lease = { unexpiredYears: 88, groundRentPenniesPa: 25_000, confidence: 0.9 };
  assert.equal(evaluateLease(lease).outcome, 'clear');
  const v = evaluateLease(lease, 95);
  assert.ok(v.outcome === 'flag' && v.flags.some((f) => f.code === 'LEASE_BELOW_LENDER_MINIMUM'));
  const { evaluateProofOfFunds: evalPof, factsFromSubmission: facts } = await import('../../../lib/server/engine/proof-of-funds');
  const f = facts('r', { declarant: { fullName: 'P Shah' }, purchasePricePennies: 30_000_000, mortgageAdvancePennies: 20_000_000, sources: [{ kind: 'gift', amountPennies: 10_000_000, description: 'From a friend', evidenceDocumentIds: ['g'], gift: { donorName: 'R Friend', donorRelationship: 'friend', repayable: false, donorAbroad: false, donorEvidenceDocumentIds: ['g'] } }], declarations: { accurate: true, noThirdPartyInterest: true, noUndisclosedBorrowing: true }, submittedAt: '2026-09-20T10:00:00Z' }, null);
  const flagged = evalPof(f); const accepted = evalPof(f, { acceptsNonFamilyGift: true });
  assert.ok(flagged.outcome === 'flag' && flagged.flags.some((x) => x.code === 'POF_GIFT_NON_FAMILY'));
  assert.ok(!(accepted.outcome === 'flag' && accepted.flags.some((x) => x.code === 'POF_GIFT_NON_FAMILY')));
  // Search age at exchange.
  const base = { ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase' as const, stage: 'pre_exchange' as const, hasLender: false, requireProofOfFunds: false, requireExchangeAuthority: false, requiredSearches: ['CON29' as const], exchange: { ...initialState(TENANT, MATTER).exchange, conditionsMet: true }, readiness: { ...initialState(TENANT, MATTER).readiness, contractApprovedAt: '2026-08-01T00:00:00Z', signedContractHeldAt: '2026-08-02T00:00:00Z' }, lenderRequirements: { minUnexpiredYears: null, maxSearchAgeMonths: 6, acceptsNonFamilyGift: null, requiresEws1: null, note: null, recordedAt: '2026-01-01T00:00:00Z' } };
  base.searches = { CON29: { searchType: 'CON29', status: 'cleared', cycle: 1, orderedAt: '2026-01-05T00:00:00Z', returnedAt: '2026-01-20T00:00:00Z', provider: null, documentId: 'd', decisionEventId: null, facts: null } as never };
  assert.throws(() => decide(base, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-01' }, ctx), /searches under 6 months old and CON29 \(2026-01-20\) is older/);
  const fresh = { ...base, searches: { CON29: { ...base.searches.CON29, returnedAt: '2026-08-01T00:00:00Z' } } };
  assert.ok(decide(fresh, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-01' }, ctx).events.some((e) => e.type === 'contracts_exchanged'), 'a search inside the limit does not hold exchange');
});

test('co-declarants: a co-buyer who neither confirms nor declares is flagged; linked sale: proceeds without a link are flagged, and exchange waits for the linked matter', async () => {
  const { evaluateProofOfFunds: evalPof, factsFromSubmission: facts } = await import('../../../lib/server/engine/proof-of-funds');
  const sub = (co: string[]) => facts('r', { declarant: { fullName: 'Tomasz Nowak' }, coDeclarants: co, purchasePricePennies: 30_000_000, mortgageAdvancePennies: 20_000_000, sources: [{ kind: 'sale_proceeds', amountPennies: 10_000_000, description: 'Sale of 12 Elm Road', evidenceDocumentIds: ['m'] }], declarations: { accurate: true, noThirdPartyInterest: true, noUndisclosedBorrowing: true }, submittedAt: '2026-09-20T10:00:00Z' }, null);
  const v1 = evalPof(sub([]), { coBuyers: ['Ewa Nowak'], hasLinkedSale: false });
  assert.ok(v1.outcome === 'flag' && v1.flags.some((f) => f.code === 'POF_MISSING_DECLARANT') && v1.flags.some((f) => f.code === 'POF_SALE_PROCEEDS_UNLINKED'));
  const v2 = evalPof(sub(['Ewa Nowak']), { coBuyers: ['Ewa Nowak'], hasLinkedSale: true });
  assert.ok(!(v2.outcome === 'flag' && v2.flags.some((f) => f.code === 'POF_MISSING_DECLARANT' || f.code === 'POF_SALE_PROCEEDS_UNLINKED')));
  // The link: an issue holds exchange; the service refuses exchange until the linked file can exchange, and clears the issue when it can.
  const h = harness();
  const SALE = '55555555-5555-4555-8555-555555555555';
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.run(TENANT, SALE, { type: 'enrol', actor: USER, transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: false, requiredSearches: [] });
  const linked = await h.svc.run(TENANT, MATTER, { type: 'link_related_matter', actor: USER, relatedMatterId: SALE, relation: 'sale' });
  assert.ok(linked.events.some((e) => e.type === 'issue_raised' && (e.payload as { kind: string }).kind === 'chain_dependency'));
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.relatedMatter?.matterId, SALE);
  await readyContract(h);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-01' }), /Cannot exchange: the linked sale is at "instruction"/);
  s = await h.svc.getState(TENANT, MATTER);
  assert.ok(openIssues(s).some((i) => i.kind === 'chain_dependency'), 'the chain issue still holds');
});

test("one client's sale and purchase link both ways at once; the same side, a second link or a self-link is refused; unlinking clears both", async () => {
  const h = harness();
  const SALE = '55555555-5555-4555-8555-555555555555';
  const OTHER = '66666666-6666-4666-8666-666666666666';
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.run(TENANT, SALE, { type: 'enrol', actor: USER, transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: false, requiredSearches: [] });
  await h.svc.run(TENANT, OTHER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await assert.rejects(h.svc.linkChain(TENANT, MATTER, MATTER, USER), /cannot be linked to itself/);
  await assert.rejects(h.svc.linkChain(TENANT, MATTER, OTHER, USER), /same side/);
  await h.svc.linkChain(TENANT, MATTER, SALE, USER);
  const [p, sl] = await Promise.all([h.svc.getState(TENANT, MATTER), h.svc.getState(TENANT, SALE)]);
  assert.deepEqual([p.relatedMatter?.matterId, p.relatedMatter?.relation], [SALE, 'sale']);
  assert.deepEqual([sl.relatedMatter?.matterId, sl.relatedMatter?.relation], [MATTER, 'purchase']);
  assert.ok(openIssues(sl).some((i) => i.kind === 'chain_dependency'), 'the sale is held too');
  await readyContract(h, SALE);
  await assert.rejects(h.svc.run(TENANT, SALE, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-01' }), /Cannot exchange/);
  await h.svc.unlinkChain(TENANT, SALE, USER, 'Linked in error');
  const [p2, s2] = await Promise.all([h.svc.getState(TENANT, MATTER), h.svc.getState(TENANT, SALE)]);
  assert.equal(p2.relatedMatter, null);
  assert.equal(s2.relatedMatter, null);
  assert.ok(!openIssues(p2).some((i) => i.kind === 'chain_dependency') && !openIssues(s2).some((i) => i.kind === 'chain_dependency'), 'both holds withdrawn');
});

test('a documented name change is one person to the cross-checks; the Right to Buy, flying freehold and commonhold shapes raise their checklists', async () => {
  const { crossCheck } = await import('../../../lib/server/engine/crosscheck');
  const record = { propertyAddress: null, purchasePricePennies: null, buyerNames: ['Priya Patel'], sellerNames: [], lender: null, completionDate: null };
  const rows = [{ documentId: 'd1', documentLabel: 'ID check', key: 'id.subject.1', value: 'Priya Shah', page: 1 }];
  assert.equal(crossCheck(record, rows).find((r) => r.check === 'buyer_names')!.status, 'mismatch');
  assert.equal(crossCheck({ ...record, nameAliases: [{ from: 'Priya Shah', to: 'Priya Patel' }] }, rows).find((r) => r.check === 'buyer_names')!.status, 'match');
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['CON29'], shapes: ['right_to_buy', 'flying_freehold', 'commonhold'] });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.deepEqual(openIssues(s).map((i) => i.kind).sort(), ['commonhold_terms', 'flying_freehold', 'right_to_buy_terms']);
  await h.svc.run(TENANT, MATTER, { type: 'name_change_evidenced', actor: USER, from: 'Priya Shah', to: 'Priya Patel', reason: 'Marriage certificate on file' });
  assert.deepEqual((await h.svc.getState(TENANT, MATTER)).nameAliases, [{ from: 'Priya Shah', to: 'Priya Patel', party: null }]);
});

test('the last open rows: a third party paying our fees; mixed-use and linked SDLT; "not known" answers become proposed enquiries; the EPC rules', async () => {
  const { computeSdlt } = await import('../../../lib/server/engine/sdlt');
  const none = { firstTimeBuyer: false, additionalProperty: false, nonUkResident: false };
  assert.equal(computeSdlt(30_000_000, { ...none, mixedUse: true }).totalPennies, 450_000, 'mixed use £300k: 2% of £100k + 5% of £50k');
  const linked = computeSdlt(30_000_000, { ...none, linkedConsiderationPennies: 30_000_000 });
  assert.equal(linked.totalPennies, Math.round(computeSdlt(60_000_000, none).totalPennies / 2), 'linked: the rate on £600k, half borne here');
  assert.match(linked.scheme, /linked transactions/);
  // Fees from a stranger.
  const base = { ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase' as const, stage: 'pre_contract' as const, partyNames: ['Priya Shah'] };
  const own = decide(base, { type: 'client_account_receipt', actor: USER, remitter: 'MRS P SHAH', amountPennies: 150_000, purpose: 'fees' }, ctx);
  assert.ok(!own.events.some((e) => e.type === 'issue_raised'));
  const stranger = decide(base, { type: 'client_account_receipt', actor: USER, remitter: 'ACME TRADING LTD', amountPennies: 150_000, purpose: 'fees' }, ctx);
  const issue = stranger.events.find((e) => e.type === 'issue_raised')!;
  assert.ok(issue);
  assert.equal((issue.payload as { gate: string }).gate, 'none', 'fees hold nothing');
  const dep = decide(base, { type: 'client_account_receipt', actor: USER, remitter: 'ACME TRADING LTD', purpose: 'deposit' }, ctx).events.find((e) => e.type === 'issue_raised')!;
  assert.equal((dep.payload as { gate: string }).gate, 'exchange', 'the deposit holds exchange');
  assert.equal(decide(base, { type: 'client_account_receipt', actor: USER, remitter: 'ACME TRADING LTD', purpose: 'fees' }, ctx).state.receipts.length, 1);
  // "Not known" on the TA6 → an enquiry proposed at propose level, raised when approved; at auto, raised at once.
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const doc = h.doc({ forms: ['TA6'], disclosures: [], confidence: 0.9, answers: {}, notKnown: [{ question: '8.1 Does the property have a right of way over a neighbour\'s land?', section: 'Rights and informal arrangements', page: 6 }] }, 'PROPERTY_FORMS');
  await h.svc.propertyFormsReceived(TENANT, MATTER, doc);
  let s = await h.svc.getState(TENANT, MATTER);
  const proposal = Object.values(s.proposals).find((p) => p.action === 'enquiry_draft');
  assert.ok(proposal && proposal.status === 'pending', 'proposed, not sent');
  assert.equal(Object.values(s.enquiries).length, 0);
  const d = pendingDecisions(s).find((x) => x.kind === 'proposal')!;
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve', null, null, { scrolledSource: false, dwellMs: 0 }, null);
  s = await h.svc.getState(TENANT, MATTER);
  const q = Object.values(s.enquiries)[0];
  assert.ok(q && /8\.1 Does the property have a right of way/.test(q.subject) && q.origin?.formsQuestion, 'raised on approval, with its origin');
  // EPC.
  const { propertyFormsIssues } = await import('../../../lib/server/engine/property-forms');
  assert.ok(propertyFormsIssues({ forms: ['TA6'], disclosures: [], confidence: 0.9, answers: {} }, 'seller').some((i) => i.flag.code === 'TA6_EPC_MISSING'));
  assert.ok(propertyFormsIssues({ forms: ['TA6'], disclosures: [], confidence: 0.9, answers: { epcRating: 'F' } }, 'buyer', { buyToLet: true }).some((i) => i.flag.code === 'TA6_EPC_MEES'));
  assert.ok(!propertyFormsIssues({ forms: ['TA6'], disclosures: [], confidence: 0.9, answers: { epcRating: 'F' } }, 'buyer').some((i) => i.flag.code === 'TA6_EPC_MEES'));
});

test("the seller's forms arriving with the contract pack are read even while the case is still at Instruction", async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['CON29'] });
  assert.equal((await h.svc.getState(TENANT, MATTER)).stage, 'instruction');
  const doc = h.doc({ forms: ['TA6', 'TA10'], disclosures: [], confidence: 0.9, answers: { japaneseKnotweed: true } }, 'PROPERTY_FORMS');
  const r = await h.svc.propertyFormsReceived(TENANT, MATTER, doc);
  assert.ok(r.events.some((e) => e.type === 'seller_forms_received'));
  assert.ok(r.events.some((e) => e.type === 'issue_raised'), 'what the forms disclose becomes issues at once');
});

test('an enquiry drafted against an issue that has since been withdrawn is still raised (not refused as "already withdrawn")', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [] } as never);
  const r = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'disclosure_concern', title: "Seller's forms: 1 point to raise with the seller's solicitor" });
  const id = (r.events[0].payload as { issueId: string }).issueId;
  await h.svc.run(TENANT, MATTER, { type: 'withdraw_issue', actor: USER, issueId: id, reason: 'rebuilt' });
  await (h.svc as unknown as { perform: (t: string, m: string, a: string, d: Record<string, unknown>) => Promise<void> }).perform(TENANT, MATTER, 'enquiry_draft', { subject: 'Please confirm the drainage arrangements.', issueId: id, title: "From the seller's forms" });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.ok(Object.values(s.enquiries).some((q) => /drainage/.test(q.subject)));
});
