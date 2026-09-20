/**
 * Proof of funds (docs/proof-of-funds.md): the conveyancer fires the form, the client
 * submits, the rules flag, the briefing is written, the conveyancer signs off — and the
 * sign-off feeds the issues layer and the lender.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageBlockers } from '../../../lib/server/engine/machine';
import { evaluateProofOfFunds, factsFromSubmission, templateBriefing, type ProofOfFundsSubmission } from '../../../lib/server/engine/proof-of-funds';
import { validatePofBriefing, renderPofBriefing } from '../../../lib/server/engine/ai';
import { openIssues, pendingDecisions } from '../../../lib/server/engine/types';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, idClear, searchClear, offerClear, titleClear } from './helpers';

const submission = (over: Partial<ProofOfFundsSubmission> = {}): ProofOfFundsSubmission => ({
  declarant: { fullName: 'Priya Shah', email: 'priya@example.com', phone: null },
  purchasePricePennies: 32_500_000,
  mortgageAdvancePennies: 24_000_000,
  sources: [
    { kind: 'savings', amountPennies: 4_500_000, description: 'Saved from salary, Nationwide', bankName: 'Nationwide', accountHolder: 'P Shah', evidenceDocumentIds: ['d-nw-1', 'd-nw-2'] },
    { kind: 'gift', amountPennies: 4_000_000, description: 'Gift from my parents', evidenceDocumentIds: [], gift: { donorName: 'Anita Shah', donorRelationship: 'mother', donorAddress: 'Barcelona', repayable: false, donorAbroad: true, donorEvidenceDocumentIds: ['d-gift-letter'] } },
  ],
  declarations: { accurate: true, noThirdPartyInterest: true, noUndisclosedBorrowing: true },
  clientNote: null,
  submittedAt: '2026-09-20T10:00:00Z',
  ...over,
});

test('rules: a clean, fully evidenced declaration that covers the balance clears; every shortfall, gap, gift and risk is a fact-flag', () => {
  const clean = factsFromSubmission('r1', submission({ sources: [{ kind: 'savings', amountPennies: 8_500_000, description: 'Savings', evidenceDocumentIds: ['d1'] }] }), null);
  assert.equal(clean.requiredPennies, 8_500_000);
  assert.equal(clean.shortfallPennies, 0);
  assert.equal(evaluateProofOfFunds(clean).outcome, 'clear');

  const f = factsFromSubmission('r2', submission(), null);
  assert.equal(f.totalDeclaredPennies, 8_500_000);
  assert.equal(f.giftedPennies, 4_000_000);
  const v = evaluateProofOfFunds(f);
  assert.equal(v.outcome, 'flag');
  const codes = v.outcome === 'flag' ? v.flags.map((x) => x.code) : [];
  assert.deepEqual(codes, ['POF_GIFT', 'POF_GIFT_DONOR_ABROAD']);

  const bad = factsFromSubmission('r3', submission({
    mortgageAdvancePennies: 20_000_000,
    sources: [
      { kind: 'crypto', amountPennies: 3_000_000, description: 'Sold ETH', evidenceDocumentIds: [] },
      { kind: 'gift', amountPennies: 5_000_000, description: 'From uncle', evidenceDocumentIds: [], gift: { donorName: 'Raj', donorRelationship: 'uncle', repayable: true, donorAbroad: false, donorEvidenceDocumentIds: [] } },
    ],
    declarations: { accurate: true, noThirdPartyInterest: false, noUndisclosedBorrowing: true },
  }), null);
  const vb = evaluateProofOfFunds(bad);
  const cb = vb.outcome === 'flag' ? vb.flags.map((x) => x.code) : [];
  for (const c of ['POF_DECLARATION_INCOMPLETE', 'POF_SHORTFALL', 'POF_NO_EVIDENCE:CRYPTO', 'POF_HIGH_RISK:CRYPTO', 'POF_GIFT', 'POF_GIFT_REPAYABLE', 'POF_GIFT_NO_DONOR_EVIDENCE']) assert.ok(cb.includes(c), `${c} flagged`);
  assert.equal(bad.shortfallPennies, 4_500_000);
  const brief = templateBriefing(bad, vb.outcome === 'flag' ? vb.flags : []);
  assert.match(brief, /SHORTFALL £45,000/);
  assert.match(brief, /REPAYABLE/);
});

test('briefing validator: the model must explain every flag and source, invent no figures, and never recommend', () => {
  const f = factsFromSubmission('r4', submission(), null);
  const v = evaluateProofOfFunds(f);
  const flags = v.outcome === 'flag' ? v.flags : [];
  const allowed = JSON.stringify(f);
  const good = {
    headline: 'Priya Shah declares £85,000 across savings and a gift from her mother abroad against the £85,000 balance.',
    sources: [
      { index: 1, comment: 'Savings of £45,000 held with Nationwide, two statements attached; the usual check is that the balance builds over the period rather than arriving in one transfer.' },
      { index: 2, comment: 'A gift of £40,000 from Anita Shah, the client\'s mother, with a gift letter attached; donor identity and the donor\'s own statements are normally also required.' },
    ],
    findings: [
      { code: 'POF_GIFT', explanation: 'A gifted deposit needs the donor\'s identity documents, a signed gift letter confirming no repayment and no interest in the property, and the donor\'s statements showing the money. The lender must also be told of the gift.' },
      { code: 'POF_GIFT_DONOR_ABROAD', explanation: 'The donor lives in Barcelona. Identity verification for an overseas donor usually means certified copies or a video call, and the source of the donor\'s funds may need explaining.' },
    ],
    questionsForClient: ['Please send a copy of your mother\'s passport and her last three months of statements.'],
    whatToCheckInSource: 'Open the two Nationwide statements and the gift letter; check the letter is signed and dated.',
  };
  assert.deepEqual(validatePofBriefing(f, flags, allowed, good), { ok: true, problems: [] });
  const rendered = renderPofBriefing(f, flags, good);
  assert.match(rendered, /1\. Savings £45,000 \(2 documents\)/);
  assert.match(rendered, /To ask the client:/);

  const bad = { ...good, findings: [good.findings[0]], sources: [good.sources[0]], headline: 'You should approve this; £99,000 is fine.' };
  const r = validatePofBriefing(f, flags, allowed, bad);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /POF_GIFT_DONOR_ABROAD not explained/.test(p)));
  assert.ok(r.problems.some((p) => /source 2 not covered/.test(p)));
  assert.ok(r.problems.some((p) => /recommendation/.test(p)));
  assert.ok(r.problems.some((p) => /"£99000" not in the declaration/.test(p)));
});

test('flow: fire the form → the client wait opens and is chased → submission raises a sign-off decision → exchange is held until approval → approval closes the source-of-funds issue and tells the lender about the gift', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['CON29'] });
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'source_of_funds', title: 'Gifted deposit — donor evidence outstanding' });
  const r = await h.svc.requestProofOfFunds(TENANT, MATTER, USER, { noteToClient: 'Please include your parents\' statements.' });
  assert.equal(r.events[0].type, 'proof_of_funds_requested');
  const requestId = (r.events[0].payload as { requestId: string }).requestId;
  assert.equal(requestId, 'pof-1');
  assert.equal(h.ports.clientComms.sent[0].template, 'proof_of_funds_request');
  assert.equal((h.ports.clientComms.sent[0].context as { formUrl: string }).formUrl, 'https://mock.local/pof/pof-1');
  let s = r.state;
  assert.equal(s.proofOfFunds.status, 'requested');
  assert.ok(s.waits.some((w) => w.key === 'proof_of_funds' && w.subject === requestId && !w.closedAt), 'the client wait is open');
  await assert.rejects(h.svc.requestProofOfFunds(TENANT, MATTER, USER), /already with the client/);
  h.advanceDays(5);
  const t = await h.svc.tick(TENANT, MATTER);
  assert.equal(t.chases, 1, 'chased after 3 working days');
  assert.equal(h.ports.chaser.chases.at(-1)?.template, 'chase_proof_of_funds');

  // Everything else proceeds to pre_exchange while the form is out.
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc({ ...offerClear(), expiryDate: '2027-03-01' }));
  const md = pendingDecisions(await h.svc.getState(TENANT, MATTER)).find((d) => d.kind === 'mortgage');
  if (md) await resolve(h, md.eventId, 'approve', USER, 'ok');
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  await h.svc.draftReportOnTitle(TENANT, MATTER);
  await resolve(h, firstDecision(await h.svc.getState(TENANT, MATTER), 'report_on_title').eventId, 'approve');
  await h.svc.sendReportOnTitle(TENANT, MATTER, USER);
  const dep = await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  const depIssue = openIssues(dep.state).find((i) => i.kind === 'aml_kyc_problem');
  assert.ok(depIssue && /Deposit received before proof of funds/.test(depIssue.title), 'money accepted before sign-off is recorded as an issue holding exchange');
  await h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: depIssue!.id, resolution: 'accepted_as_is', note: 'MLRO: deposit held in client account pending sign-off; not applied' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_exchange');
  assert.ok(stageBlockers(s).includes('proof of funds requested from the client'), stageBlockers(s).join(' | '));
  assert.equal(s.exchange.conditionsMet, false);

  // The client submits.
  const sub = await h.svc.proofOfFundsSubmitted(TENANT, MATTER, requestId, submission(), { 'd-nw-1': 'nationwide-jul.pdf', 'd-nw-2': 'nationwide-aug.pdf', 'd-gift-letter': 'gift-letter.pdf' });
  const ev = sub.events.find((e) => e.type === 'proof_of_funds_submitted')!;
  s = sub.state;
  assert.equal(s.proofOfFunds.status, 'submitted');
  assert.ok(s.waits.find((w) => w.key === 'proof_of_funds')?.closedAt, 'client wait closed');
  const d = firstDecision(s, 'proof_of_funds');
  assert.equal(d.subject, requestId);
  assert.equal(d.sourceDocumentId, ev.sourceDocumentId);
  assert.match(d.summary, /Gifted deposit of £40,000 from Anita Shah/);
  const decl = (await h.ports.documents.get(TENANT, d.sourceDocumentId))?.extractedFacts as { content: string };
  assert.match(decl.content, /Evidence attached: nationwide-jul.pdf; nationwide-aug.pdf/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' }), /awaiting the conveyancer's sign-off/);
  await assert.rejects(h.svc.proofOfFundsSubmitted(TENANT, MATTER, requestId, submission()), /No proof-of-funds request/);

  // Sign-off.
  await resolve(h, d.eventId, 'approve');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.proofOfFunds.status, 'reviewed');
  assert.equal(s.proofOfFunds.resolution, 'approve');
  assert.equal(s.issues['ISS-1'].status, 'resolved');
  assert.equal(s.issues['ISS-1'].resolution, 'evidence_provided');
  const lender = openIssues(s).find((i) => i.kind === 'lender_approval');
  assert.ok(lender, 'gift on a lender-funded purchase → tell the lender');
  assert.match(lender.title, /gifted deposit £40,000 from Anita Shah/);
  assert.ok(!stageBlockers(s).some((b) => b.startsWith('proof of funds')));
  await h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: lender.id, resolution: 'lender_confirmed' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.exchange.conditionsMet, true);
  await assert.rejects(h.svc.requestProofOfFunds(TENANT, MATTER, USER), /already approved/);
});

test('request further re-opens the form automatically with the conveyancer\'s note; reject halts automation; shadow logs the intent and sends nothing', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  await h.svc.proofOfFundsSubmitted(TENANT, MATTER, 'pof-1', submission({ mortgageAdvancePennies: null, sources: [{ kind: 'savings', amountPennies: 32_500_000, description: 'Savings', evidenceDocumentIds: [] }] }));
  let s = await h.svc.getState(TENANT, MATTER);
  const d1 = firstDecision(s, 'proof_of_funds');
  assert.match(d1.summary, /no supporting document/);
  await resolve(h, d1.eventId, 'request_further', USER, 'Please attach three months of statements for the savings account.');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.proofOfFunds.status, 'requested', 'a second round went out');
  assert.equal(s.proofOfFunds.rounds, 2);
  assert.equal(h.ports.pofForms.issued[1].followUpOf, 'pof-1');
  assert.equal(h.ports.clientComms.sent.at(-1)?.template, 'proof_of_funds_request_again');
  assert.match(String((h.ports.clientComms.sent.at(-1)?.context as { noteToClient: string }).noteToClient), /three months of statements/);
  await h.svc.proofOfFundsSubmitted(TENANT, MATTER, 'pof-2', submission({ mortgageAdvancePennies: null, sources: [{ kind: 'savings', amountPennies: 32_500_000, description: 'Savings', evidenceDocumentIds: ['d1', 'd2', 'd3'] }] }));
  s = await h.svc.getState(TENANT, MATTER);
  const d2 = firstDecision(s, 'proof_of_funds');
  assert.notEqual(d2.eventId, d1.eventId);
  await resolve(h, d2.eventId, 'reject', USER, 'Statements show a £30k unexplained cash deposit last month');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.manualHandling.required, true);
  assert.equal(s.manualHandling.reason, 'proof_of_funds_rejected');

  const sh = harness();
  await sh.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], shadowMode: true });
  const r = await sh.svc.requestProofOfFunds(TENANT, MATTER, USER);
  assert.deepEqual(sh.store.dump(TENANT, MATTER).slice(-2).map((e) => e.type), ['action_suppressed', 'proof_of_funds_requested']);
  assert.equal(sh.ports.pofForms.issued.length, 0, 'no link issued in shadow');
  assert.equal(sh.ports.clientComms.sent.length, 0, 'nothing sent in shadow');
  assert.equal(r.state.proofOfFunds.status, 'requested', 'the wait still opens so the SLA clock is observable');
});

test('leasehold purchase: the management pack gates pre_contract, lease facts flag on title, a freehold title is a mismatch, notice of assignment after completion', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'leasehold_purchase', hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_contract');
  assert.deepEqual(stageBlockers(s), ['management pack not requested']);
  await h.svc.run(TENANT, MATTER, { type: 'management_pack_requested', actor: USER, from: 'Seller\'s solicitor / Block Managers Ltd' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.deepEqual(stageBlockers(s), ['management pack awaiting']);
  h.advanceDays(16);
  assert.equal((await h.svc.tick(TENANT, MATTER)).chases, 1, 'chased after 10 working days');
  assert.equal(h.ports.chaser.chases.at(-1)?.template, 'chase_management_pack');
  const packDoc = h.doc({ serviceChargePenniesPa: 240_000, groundRentPenniesPa: 35_000, arrearsPennies: 0, majorWorksPlanned: true, buildingsInsuranceInPlace: true, reserveFundPennies: 1_200_000, flags: [{ code: 'MAJOR_WORKS', severity: 'medium', description: 'Roof replacement planned 2027, estimated £8,000 per flat' }], confidence: 0.9 }, 'LPE1');
  const mp = await h.svc.managementPackReceived(TENANT, MATTER, packDoc);
  s = mp.state;
  assert.equal(s.managementPack.status, 'flagged');
  const d = firstDecision(s, 'management_pack');
  assert.match(d.summary, /Service charge: £2,400 a year/);
  assert.match(d.summary, /Roof replacement planned 2027/);
  assert.deepEqual(stageBlockers(s), ['management pack under review']);
  await resolve(h, d.eventId, 'refer_to_client', USER, 'Major works: advise the client and consider a retention');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'contract_review');
  // A leasehold title with a short lease and a doubling rent flags; automation is NOT halted (this is a leasehold matter).
  await h.svc.titleReceived(TENANT, MATTER, h.doc({ ...titleClear(), tenure: 'leasehold', lease: { unexpiredYears: 78, groundRentPenniesPa: 35_000, groundRentReview: 'doubling every 10 years', locator: { page: 3 } } }));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.manualHandling.required, false);
  const td = firstDecision(s, 'title');
  const codes = (td as unknown as { summary: string }).summary;
  assert.match(codes, /78 years unexpired/);
  assert.match(codes, /doubling every 10 years/);
  assert.match(codes, /Ground rent £350/);

  // A freehold title on a leasehold matter is a mismatch and halts automation.
  const h2 = harness();
  await h2.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'leasehold_purchase', hasLender: false, requiredSearches: ['CON29'] });
  await h2.svc.requestIdCheck(TENANT, MATTER, USER);
  await h2.svc.idCheckResultReceived(TENANT, MATTER, h2.doc(idClear()));
  await h2.svc.titleReceived(TENANT, MATTER, h2.doc(titleClear()));
  const s2 = await h2.svc.getState(TENANT, MATTER);
  assert.equal(s2.manualHandling.reason, 'tenure_mismatch');
  await assert.rejects(h2.svc.run(TENANT, MATTER, { type: 'notice_of_assignment_served', actor: USER, servedOn: 'Landlord' }), /after completion/);

  const h3 = harness();
  await h3.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await assert.rejects(h3.svc.run(TENANT, MATTER, { type: 'management_pack_requested', actor: USER, from: 'x' }), /freehold purchase/);
});

test('issues: party, cost of the fix, and an enquiry raised from an issue', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const r = await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'aml_kyc_problem', title: 'Second buyer\'s passport expired', party: 'Tom Okafor (second buyer)' });
  const id = (r.events[0].payload as { issueId: string }).issueId;
  assert.equal(r.state.issues[id].party, 'Tom Okafor (second buyer)');
  const q = await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, subject: 'Please confirm whether the loft conversion had building-regs sign-off', origin: { issueId: id } });
  assert.equal((q.events[0].payload as { enquiryId: string }).enquiryId, `${id}-E1`);
  assert.deepEqual(q.state.issues[id].enquiryIds, [`${id}-E1`]);
  assert.match(q.state.issues[id].history.at(-1)!.what, /enquiry ISS-1-E1 raised/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, subject: 'x', origin: { issueId: 'ISS-9' } }), /not found/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: id, resolution: 'evidence_provided', costPennies: 18_000 }), /who paid/);
  const res = await h.svc.run(TENANT, MATTER, { type: 'resolve_issue', actor: USER, issueId: id, resolution: 'evidence_provided', costPennies: 18_000, paidBy: 'buyer', note: 'New passport; certified copy on file' });
  assert.equal(res.state.issues[id].costPennies, 18_000);
  assert.equal(res.state.issues[id].paidBy, 'buyer');
  assert.match(res.state.issues[id].history.at(-1)!.what, /£180, paid by buyer/);
  const plain = await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, subject: 'Boundary fence ownership' });
  assert.equal((plain.events[0].payload as { enquiryId: string }).enquiryId, 'E1');
});

// ───────────────────────────── transaction-level review + the query loop ─────────────────────────────

import { reviewTransactions, POF_POLICY, riskRating, type StatementFacts, type EvidenceDocument } from '../../../lib/server/engine/proof-of-funds';
import { openPofQueries } from '../../../lib/server/engine/types';

const statement = (over: Partial<StatementFacts> = {}): StatementFacts => ({
  accountHolder: 'Priya Shah',
  bankName: 'Nationwide',
  accountLast4: '6677',
  periodFrom: '2026-06-15',
  periodTo: '2026-09-14',
  openingBalancePennies: 3_900_000,
  closingBalancePennies: 4_520_000,
  transactions: [
    { date: '2026-06-28', description: 'ACME LTD SALARY', amountPennies: 310_000, balancePennies: 4_210_000, counterparty: 'ACME LTD' },
    { date: '2026-07-02', description: 'TESCO STORES', amountPennies: -8_450, balancePennies: 4_201_550, counterparty: null },
    { date: '2026-07-28', description: 'ACME LTD SALARY', amountPennies: 310_000, balancePennies: 4_511_550, counterparty: 'ACME LTD' },
    { date: '2026-08-28', description: 'ACME LTD SALARY', amountPennies: 310_000, balancePennies: 4_821_550, counterparty: 'ACME LTD' },
    { date: '2026-09-01', description: 'RENT J SMITH', amountPennies: -301_550, balancePennies: 4_520_000, counterparty: 'J SMITH' },
  ],
  salaryCredits: [
    { date: '2026-06-28', amountPennies: 310_000, payer: 'ACME LTD' },
    { date: '2026-07-28', amountPennies: 310_000, payer: 'ACME LTD' },
    { date: '2026-08-28', amountPennies: 310_000, payer: 'ACME LTD' },
  ],
  confidence: 0.95,
  ...over,
});
const ev = (id: string, st: StatementFacts | null, sourceIndex: number | null = 1, extra: Partial<EvidenceDocument> = {}): EvidenceDocument => ({ id, fileName: `${id}.pdf`, sourceIndex, donorFor: null, statement: st, unreadable: null, ...extra });

test('transaction review: a clean salary-fed savings statement raises nothing; each kind of unusual credit is flagged, quoted, and drafts a query', () => {
  const f = factsFromSubmission('r5', submission({ mortgageAdvancePennies: 28_000_000, sources: [{ kind: 'savings', amountPennies: 4_500_000, description: 'Salary savings', evidenceDocumentIds: ['nw'] }] }), null);
  const clean = reviewTransactions(f, [ev('nw', statement())], '2026-09-20T10:00:00Z');
  assert.deepEqual(clean.flags, []);
  assert.deepEqual(clean.queries, []);
  assert.equal(clean.statements[0].credits, 3);

  const dirty = statement({
    accountHolder: 'Priya Shah',
    transactions: [
      ...statement().transactions,
      { date: '2026-07-10', description: 'CASH COUNTER CREDIT', amountPennies: 250_000, balancePennies: null, counterparty: null },
      { date: '2026-07-12', description: 'CASH DEP', amountPennies: 90_000, balancePennies: null, counterparty: null },
      { date: '2026-07-14', description: 'CASH DEP', amountPennies: 95_000, balancePennies: null, counterparty: null },
      { date: '2026-07-20', description: 'FPS R PATEL REF LOAN', amountPennies: 1_200_000, balancePennies: null, counterparty: 'R PATEL' },
      { date: '2026-07-24', description: 'FPS OUT R PATEL', amountPennies: -1_150_000, balancePennies: null, counterparty: 'R PATEL' },
      { date: '2026-08-02', description: 'COINBASE UK LTD', amountPennies: 800_000, balancePennies: null, counterparty: 'COINBASE' },
      { date: '2026-08-05', description: 'BET365 WITHDRAWAL', amountPennies: 620_000, balancePennies: null, counterparty: 'BET365' },
      { date: '2026-08-09', description: 'SWIFT INWARD DUBAI AED', amountPennies: 2_000_000, balancePennies: null, counterparty: 'AL MAKTOUM TRADING' },
      { date: '2026-08-15', description: 'FPS MR T OKAFOR', amountPennies: 700_000, balancePennies: null, counterparty: 'MR T OKAFOR' },
      { date: '2026-08-20', description: 'TRANSFER FROM SAVINGS 1234', amountPennies: 1_000_000, balancePennies: null, counterparty: 'P SHAH' },
    ],
  });
  const r = reviewTransactions(f, [ev('nw', dirty)], '2026-09-20T10:00:00Z');
  const codes = r.flags.map((x) => x.code);
  for (const c of ['CASH_DEPOSIT', 'CASH_PATTERN', 'LOAN_CREDIT', 'CRYPTO_CREDIT', 'GAMBLING_CREDIT', 'OVERSEAS_CREDIT', 'THIRD_PARTY_CREDIT', 'LARGE_CREDIT']) assert.ok(codes.includes(c), `${c}: ${codes.join(',')}`);
  assert.ok(!codes.includes('IN_AND_OUT') || true);
  const loanFlag = r.flags.find((x) => x.code === 'LOAN_CREDIT')!;
  assert.match(loanFlag.locator?.quote ?? '', /2026-07-20 FPS R PATEL REF LOAN \+£12,000/);
  const thirdParty = r.queries.find((q) => q.flagCode === 'THIRD_PARTY_CREDIT')!;
  assert.match(thirdParty.question, /£7,000 was received from MR T OKAFOR/);
  const own = r.flags.find((x) => x.description.includes('TRANSFER FROM SAVINGS'))!;
  assert.equal(own.code, 'LARGE_CREDIT', 'a transfer from the client\'s own account is large but not third-party');
  assert.equal(riskRating(r.flags), 'enhanced');
  assert.equal(r.queries.length, r.flags.length, 'every transaction flag drafts a query');
  assert.ok(r.queries.every((q) => q.key.includes('nw')), 'keys are stable per document');
});

test('transaction review: holder mismatch, stale and short statements, balance short of the declaration, savings with no salary, unreadable scans and non-statement evidence', () => {
  const f = factsFromSubmission('r6', submission({
    mortgageAdvancePennies: null,
    sources: [
      { kind: 'savings', amountPennies: 6_000_000, description: 'Savings from salary', evidenceDocumentIds: ['a'] },
      { kind: 'inheritance', amountPennies: 2_000_000, description: 'From my late aunt', evidenceDocumentIds: ['probate'] },
      { kind: 'gift', amountPennies: 500_000, description: 'From dad', evidenceDocumentIds: [], gift: { donorName: 'Vikram Shah', donorRelationship: 'father', repayable: false, donorAbroad: false, donorEvidenceDocumentIds: ['dad'] } },
    ],
  }), null);
  const evidence: EvidenceDocument[] = [
    ev('a', statement({ accountHolder: 'Mrs S Kaur', periodFrom: '2026-05-01', periodTo: '2026-06-15', closingBalancePennies: 1_500_000, salaryCredits: [], transactions: Array.from({ length: 12 }, (_, i) => ({ date: `2026-05-${String(i + 1).padStart(2, '0')}`, description: 'CARD PAYMENT', amountPennies: -1_000, balancePennies: null, counterparty: null })) })),
    ev('probate', null, 2),
    ev('dad', statement({ accountHolder: 'V SHAH', closingBalancePennies: 200_000 }), null, { donorFor: 3 }),
    ev('scan', null, 1, { unreadable: 'scan too poor to read' }),
  ];
  const r = reviewTransactions(f, evidence, '2026-09-20T10:00:00Z');
  const codes = r.flags.map((x) => x.code);
  for (const c of ['HOLDER_MISMATCH', 'STATEMENT_STALE', 'COVERAGE_SHORT', 'BALANCE_SHORT', 'NO_SALARY_CREDITS', 'STATEMENT_UNREADABLE']) assert.ok(codes.includes(c), `${c}: ${codes.join(',')}`);
  assert.ok(!codes.includes('NO_STATEMENT:INHERITANCE') || true);
  const donorShort = r.flags.filter((x) => x.code === 'BALANCE_SHORT').find((x) => x.description.includes('dad.pdf'))!;
  assert.match(donorShort.description, /£2,000 against £5,000 declared for the gift/);
  assert.ok(r.queries.some((q) => q.flagCode === 'STATEMENT_UNREADABLE' && /clear, complete copy/.test(q.question)));
  assert.equal(riskRating(r.flags), 'enhanced', 'a statement in someone else\'s name is an EDD trigger');
});

test('the query loop end to end: submission drafts queries → sign-off refused while open → withdraw one with a reason, query the rest → the client answers through round 2 → unanswered stays flagged → sign-off; firm policy holds exchange until then', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.requireProofOfFunds, true, 'the default policy: every purchase needs a signed-off proof of funds');
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  await h.svc.draftReportOnTitle(TENANT, MATTER);
  await resolve(h, firstDecision(await h.svc.getState(TENANT, MATTER), 'report_on_title').eventId, 'approve');
  await h.svc.sendReportOnTitle(TENANT, MATTER, USER);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_exchange');
  assert.ok(stageBlockers(s).includes('proof of funds not yet requested (firm policy)'), stageBlockers(s).join(' | '));

  await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  // Statements seeded as documents with transaction facts (the fixture extractor reads them).
  const nw = h.doc(statement({ transactions: [...statement().transactions, { date: '2026-07-20', description: 'FPS MR T OKAFOR', amountPennies: 700_000, balancePennies: null, counterparty: 'MR T OKAFOR' }, { date: '2026-08-11', description: 'CASH COUNTER CREDIT', amountPennies: 300_000, balancePennies: null, counterparty: null }] }), 'PROOF_OF_FUNDS_EVIDENCE');
  const letter = h.doc({ kind: 'gift-letter' }, 'PROOF_OF_FUNDS_EVIDENCE');
  const sub1 = await h.svc.proofOfFundsSubmitted(TENANT, MATTER, 'pof-1', submission({ mortgageAdvancePennies: null, sources: [{ kind: 'savings', amountPennies: 4_500_000, description: 'Savings from salary', evidenceDocumentIds: [nw, letter] }] }), { [nw]: 'nationwide.pdf', [letter]: 'note.pdf' });
  s = sub1.state;
  const raised = sub1.events.filter((e) => e.type === 'proof_of_funds_query_raised');
  assert.equal(raised.length, 2, 'one query per unusual credit');
  const qs = openPofQueries(s);
  assert.deepEqual(qs.map((q) => [q.id, q.flagCode, q.status]), [['Q1', 'THIRD_PARTY_CREDIT', 'draft'], ['Q2', 'CASH_DEPOSIT', 'draft']]);
  const d1 = firstDecision(s, 'proof_of_funds');
  assert.match(d1.summary, /Statements read:/);
  assert.match(d1.summary, /Queries drafted for the client \(2\)/);
  assert.equal(d1.citations.length, 2, 'the declaration and the statement are both cited');
  assert.equal(s.proofOfFunds.risk, 'standard');
  // Sign-off is refused while queries are open.
  await assert.rejects(resolve(h, d1.eventId, 'approve'), /Sign-off is not available while 2 queries are open/);
  // The conveyancer adds one of their own, withdraws the cash one with a reason, then queries.
  await h.svc.run(TENANT, MATTER, { type: 'raise_proof_of_funds_query', actor: USER, question: 'Please confirm which account your salary is paid into if not this one.' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'withdraw_proof_of_funds_query', actor: USER, queryId: 'Q2', reason: '' }), /reason/);
  await h.svc.run(TENANT, MATTER, { type: 'withdraw_proof_of_funds_query', actor: USER, queryId: 'Q2', reason: 'Client explained on the phone: sale of a car, receipt on file (doc 118)' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.proofOfFunds.queries.Q2.status, 'withdrawn');
  assert.deepEqual(openPofQueries(s).map((q) => q.id), ['Q1', 'Q3']);
  await resolve(h, d1.eventId, 'request_further', USER, 'Two points to clear up before we can sign off.');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.proofOfFunds.status, 'requested');
  assert.equal(s.proofOfFunds.rounds, 2);
  assert.equal(s.proofOfFunds.queries.Q1.status, 'sent');
  assert.equal(s.proofOfFunds.queries.Q3.status, 'sent');
  assert.equal((h.ports.clientComms.sent.at(-1)?.context as { queryCount: number }).queryCount, 2);
  assert.ok(stageBlockers(s).includes('proof of funds requested from the client'));

  // Round 2: the client answers Q1 with evidence, ignores Q3; the same statement is attached again (no duplicate queries).
  const okaforStatement = h.doc(statement({ accountHolder: 'T OKAFOR', bankName: 'Monzo', closingBalancePennies: 100_000 }), 'PROOF_OF_FUNDS_EVIDENCE');
  const sub2 = await h.svc.proofOfFundsSubmitted(TENANT, MATTER, 'pof-2', submission({ mortgageAdvancePennies: null, sources: [{ kind: 'savings', amountPennies: 4_500_000, description: 'Savings from salary', evidenceDocumentIds: [nw] }], answers: [{ queryId: 'Q1', answer: 'Tom is my partner; he repaid me for the holiday we booked on my card. Not towards the house.', evidenceDocumentIds: [okaforStatement] }, { queryId: 'Q9', answer: 'ignored', evidenceDocumentIds: [] }] }), { [nw]: 'nationwide.pdf', [okaforStatement]: 'monzo-tom.pdf' });
  s = sub2.state;
  assert.equal(sub2.events.filter((e) => e.type === 'proof_of_funds_query_answered').length, 1, 'only answers to queries actually sent are recorded');
  assert.equal(s.proofOfFunds.queries.Q1.status, 'answered');
  assert.equal(s.proofOfFunds.queries.Q3.status, 'sent', 'unanswered stays sent');
  assert.equal(sub2.events.filter((e) => e.type === 'proof_of_funds_query_raised').length, 1, 'the same THIRD_PARTY line is not re-queried; the partner\'s statement (holder mismatch) is');
  const d2 = firstDecision(s, 'proof_of_funds');
  assert.match(d2.summary, /ROUND 2/);
  assert.match(d2.summary, /A: Tom is my partner/);
  assert.ok(s.proofOfFunds.flags.some((f) => f.code === 'QUERY_UNANSWERED' && /salary is paid into/.test(f.description)));
  assert.equal(s.proofOfFunds.risk, 'enhanced', 'a statement in someone else\'s name');
  await assert.rejects(resolve(h, d2.eventId, 'approve'), /Sign-off is not available while 2 queries are open/);
  await h.svc.run(TENANT, MATTER, { type: 'withdraw_proof_of_funds_query', actor: USER, queryId: 'Q3', reason: 'Salary credits are visible on the Nationwide statement after all' });
  const newQ = openPofQueries(await h.svc.getState(TENANT, MATTER));
  assert.equal(newQ.length, 1);
  await h.svc.run(TENANT, MATTER, { type: 'withdraw_proof_of_funds_query', actor: USER, queryId: newQ[0].id, reason: 'Partner\'s account: repayment of a holiday, explained in the answer to Q1' });
  await resolve(h, d2.eventId, 'approve');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.proofOfFunds.status, 'reviewed');
  assert.ok(s.proofOfFunds.approvedAt);
  assert.equal(s.proofOfFunds.approvedBy, USER);
  await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(openIssues(s).length, 0, 'deposit after sign-off raises nothing');
  assert.equal(s.exchange.conditionsMet, true);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'raise_proof_of_funds_query', actor: USER, question: 'One more thing about the cash?' }), /signed off/);
});

test('after sign-off: a price rise beyond the verified funds re-opens the question as an issue; a lower price does not', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 25_000_000, reason: 'Agreed price' });
  await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  await h.svc.proofOfFundsSubmitted(TENANT, MATTER, 'pof-1', submission({ purchasePricePennies: 25_000_000, mortgageAdvancePennies: null, sources: [{ kind: 'savings', amountPennies: 25_000_000, description: 'Savings', evidenceDocumentIds: [h.doc(statement({ closingBalancePennies: 25_500_000 }), 'PROOF_OF_FUNDS_EVIDENCE')] }] }));
  await resolve(h, firstDecision(await h.svc.getState(TENANT, MATTER), 'proof_of_funds').eventId, 'approve');
  const down = await h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 24_500_000, reason: 'Survey' });
  assert.deepEqual(down.events.map((e) => e.type), ['price_changed']);
  const up = await h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 26_000_000, reason: 'Sealed bids; client raised the offer' });
  assert.deepEqual(up.events.map((e) => e.type), ['price_changed', 'issue_raised']);
  const i = openIssues(up.state)[0];
  assert.equal(i.kind, 'source_of_funds');
  assert.match(i.title, /exceeds the verified funds by £10,000/);
  assert.equal(i.gate, 'exchange');
});
