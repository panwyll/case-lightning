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
  await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
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
