/**
 * Spec §2.8 success criteria, end to end against the in-memory store + mock ports:
 *   1. one freehold purchase runs instruction → post_completion with searches, enquiries
 *      and mortgage conditions flowing through the auto-clear/flag pattern;
 *   2. the current state is reconstructable from the event log alone (replay audit);
 *   3. no AI-drafted content reaches the client without a logged human approval;
 *   4. timers chase and escalate on working-day SLAs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../../../lib/server/engine/projection';
import { stageBlockers } from '../../../lib/server/engine/machine';
import { isUserActor, type EngineEvent } from '../../../lib/server/engine/types';
import { titleClear, harness, resolve, firstDecision, TENANT, MATTER, USER, idClear, searchClear, searchFlagged, searchLowConfidence, replyClear, replyPartial, offerSpecial, titleWithCharge } from './helpers';

test('full lifecycle: instruction → post_completion, with every decision cited, approved and replayable', async () => {
  const h = harness(new Date('2026-09-14T09:00:00Z'));
  const { svc, ports } = h;

  // ── instruction ──
  await svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: true, targetExchangeDate: '2026-12-01' });
  await svc.requestIdCheck(TENANT, MATTER, USER);
  assert.equal(ports.idCheckProvider.requests.length, 1);
  let r = await svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear(), 'ID_REPORT'));
  assert.equal(r.state.stage, 'pre_contract');

  // Stage entry auto-ordered every required search via the provider port (spec 2.4 step 1).
  let s = await svc.getState(TENANT, MATTER);
  assert.deepEqual(Object.keys(s.searches).sort(), ['CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL', 'LLC1']);
  assert.equal(ports.searchProvider.orders.length, 4);
  assert.ok(ports.clientComms.sent.some((m) => m.template === 'searches_ordered'));

  // ── pre_contract: searches ──
  await svc.searchReturned(TENANT, MATTER, 'LLC1', h.doc(searchClear('LLC1')));
  await svc.searchReturned(TENANT, MATTER, 'DRAINAGE_WATER', h.doc(searchClear('DRAINAGE_WATER')));
  s = await svc.getState(TENANT, MATTER);
  assert.equal(s.searches.LLC1.status, 'cleared');
  assert.ok(!ports.clientComms.sent.some((m) => m.template === 'searches_all_back'), 'not until they are all back');

  // A flagged CON29 → decision citing the PDF page/section.
  r = await svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchFlagged('CON29')));
  const con29Decision = Object.values(r.state.decisions).find((d) => d.kind === 'search' && d.subject === 'CON29')!;
  assert.equal(con29Decision.status, 'pending');
  assert.match(con29Decision.citations[0].label, /p\.4, 3\.7/);
  assert.ok(!ports.clientComms.sent.some((m) => /^search_back/.test(m.template)), 'no email per search');

  // An unreadable ENVIRONMENTAL → low confidence → decision, never a guess.
  r = await svc.searchReturned(TENANT, MATTER, 'ENVIRONMENTAL', h.doc(searchLowConfidence('ENVIRONMENTAL')));
  const envDecision = Object.values(r.state.decisions).find((d) => d.subject === 'ENVIRONMENTAL')!;
  assert.match(envDecision.summary, /LOW_EXTRACTION_CONFIDENCE|confidence/);

  // Handler works the feed: refer CON29 to client; approve environmental after reading it.
  await resolve(h, con29Decision.eventId, 'refer_to_client', USER, 'Client to confirm extension was regularised');
  await resolve(h, envDecision.eventId, 'approve', USER, 'Read the PDF — no contamination entries');

  // ── pre_contract: enquiries ──
  await svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'Boundary fence ownership' });
  await svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E2', subject: 'Building regs for 2019 boiler' });
  await svc.enquiryReplyReceived(TENANT, MATTER, 'E1', h.doc(replyClear('E1'), 'ENQUIRY_REPLY'));
  r = await svc.enquiryReplyReceived(TENANT, MATTER, 'E2', h.doc(replyPartial('E2'), 'ENQUIRY_REPLY'));
  const e2Decision = Object.values(r.state.decisions).find((d) => d.kind === 'enquiry' && d.subject === 'E2')!;
  r = await resolve(h, e2Decision.eventId, 'request_further', USER, 'Need the completion certificate');
  assert.ok(r.state.enquiries['E2-F1'], 'follow-up enquiry raised and tracked');
  await svc.enquiryReplyReceived(TENANT, MATTER, 'E2-F1', h.doc(replyClear('E2-F1'), 'ENQUIRY_REPLY'));

  // ── pre_contract: mortgage offer with a special condition ──
  r = await svc.mortgageOfferReceived(TENANT, MATTER, h.doc(offerSpecial(), 'MORTGAGE_OFFER'));
  const mDecision = Object.values(r.state.decisions).find((d) => d.kind === 'mortgage')!;
  assert.match(mDecision.summary, /Retention of £5,000/);
  assert.equal(r.state.stage, 'pre_contract');
  r = await resolve(h, mDecision.eventId, 'approve', USER, 'Retention agreed with client');
  assert.equal(r.state.stage, 'contract_review', 'all pre-contract gates resolved → contract_review');

  // ── contract_review: title with a charge → decision; then AI-drafted report needs approval ──
  r = await svc.titleReceived(TENANT, MATTER, h.doc(titleWithCharge(), 'TITLE_REGISTER'));
  const tDecision = Object.values(r.state.decisions).find((d) => d.kind === 'title')!;
  assert.match(tDecision.summary, /undertaking to discharge/);
  await resolve(h, tDecision.eventId, 'approve', USER, 'Undertaking received');

  // Title, searches and enquiries are resolved: the report is drafted without being asked, and waits for approval.
  r = { ...r, state: await svc.getState(TENANT, MATTER) };
  assert.equal(r.state.reportOnTitle.status, 'drafted');
  assert.equal((await svc.draftReportOnTitle(TENANT, MATTER)).events.length, 0, 'drafting again adds nothing');
  assert.equal((await h.store.listEvents(TENANT, MATTER)).find((e) => e.type === 'report_on_title_drafted')?.actor, 'ai');
  const rotDecision = Object.values(r.state.decisions).find((d) => d.kind === 'report_on_title')!;
  assert.ok(rotDecision.citations.length >= 5, 'the draft cites every source document it was built from');
  await assert.rejects(svc.sendReportOnTitle(TENANT, MATTER, USER), /not been approved/);
  assert.equal(ports.clientComms.reports.length, 0, 'nothing reached the client');
  await resolve(h, rotDecision.eventId, 'approve', USER);
  r = await svc.sendReportOnTitle(TENANT, MATTER, USER);
  assert.equal(ports.clientComms.reports.length, 1);
  assert.equal(r.state.stage, 'pre_exchange');

  // ── pre_exchange → exchanged ──
  r = await svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER, amountPennies: 3_500_000 });
  assert.equal(r.state.exchange.conditionsMet, true, 'conditions derived automatically once the deposit lands');
  r = await svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-11-27' });
  assert.equal(r.state.stage, 'exchanged');
  assert.ok(ports.clientComms.sent.some((m) => m.template === 'exchanged'));

  // ── pre_completion → completed ──
  r = await svc.run(TENANT, MATTER, { type: 'completion_statement_generated', actor: USER });
  assert.equal(r.state.stage, 'pre_completion');
  // The paper first: no completion without the transfer deed, and with a lender the mortgage deed and the certificate of title.
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /transfer deed \(TR1\) has not been executed/);
  await svc.run(TENANT, MATTER, { type: 'transfer_deed_executed', actor: USER, parties: ['Buyer'] });
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /mortgage deed has not been executed/);
  await svc.run(TENANT, MATTER, { type: 'mortgage_deed_executed', actor: USER, witnessed: true });
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /certificate of title has not been sent/);
  await svc.run(TENANT, MATTER, { type: 'certificate_of_title_sent', actor: USER });
  // Addendum 2: bank details are versioned hard-stops — ours (what the client pays into) and the seller's solicitor's (what we pay).
  const firm = await svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind: 'firm_client_account', payeeRef: 'Firm LLP client account', details: { sortCode: '401234', accountNumber: '12345678', accountName: 'Firm LLP Client Account', firmName: 'Firm LLP' }, sourceChannel: 'manual' });
  const firmDecision = Object.values(firm.state.decisions).find((d) => d.kind === 'bank_details' && d.status === 'pending')!;
  const firmId = firmDecision.subject!;
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'funds_requested', actor: USER, fromRole: 'lender', bankDetailsId: firmId }), /HARD STOP/);
  await svc.openDecisionSource(TENANT, MATTER, firmDecision.eventId, USER);
  await assert.rejects(svc.resolveDecision(TENANT, MATTER, firmDecision.eventId, USER, 'verify', null, { method: 'email_reply' }), /not verification/);
  await svc.resolveDecision(TENANT, MATTER, firmDecision.eventId, USER, 'verify', 'Matches the firm bank mandate', { method: 'in_person' });
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'funds_requested', actor: 'system', fromRole: 'lender', bankDetailsId: firmId }), /by a person/);
  await svc.run(TENANT, MATTER, { type: 'funds_requested', actor: USER, fromRole: 'lender', bankDetailsId: firmId });
  await svc.run(TENANT, MATTER, { type: 'funds_requested', actor: USER, fromRole: 'client', bankDetailsId: firmId });
  // The Lenders' Handbook's pre-completion checks, each refused until recorded.
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /bankruptcy search \(K16\)/);
  await svc.run(TENANT, MATTER, { type: 'bankruptcy_search_clear', actor: USER, subjects: ['Priya Shah'] });
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /No priority search \(OS1\)/);
  await svc.run(TENANT, MATTER, { type: 'priority_search_made', actor: USER, expiresAt: '2027-01-15' });
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /Buildings insurance has not been confirmed/);
  await svc.run(TENANT, MATTER, { type: 'buildings_insurance_confirmed', actor: USER, insurer: 'Aviva' });
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /Funds have not been received/);
  await svc.run(TENANT, MATTER, { type: 'funds_received', actor: USER, fromRole: 'lender' });
  r = await svc.run(TENANT, MATTER, { type: 'funds_received', actor: USER, fromRole: 'client' });
  assert.ok(r.state.completion.fundsReceivedAt);
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /No authorised completion payment/);
  const seller = await svc.recordBankDetails(TENANT, MATTER, { actor: 'external', payeeKind: 'seller_solicitor', payeeRef: 'Smith & Co', details: { sortCode: '201122', accountNumber: '87654321', accountName: 'Smith & Co Client Account', firmName: 'Smith & Co' }, sourceChannel: 'email', sourceDocumentId: h.doc({ content: 'Completion statement email from Smith & Co with client account details' }) });
  const sellerDecision = Object.values(seller.state.decisions).find((d) => d.kind === 'bank_details' && d.status === 'pending')!;
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: sellerDecision.subject!, purpose: 'completion_monies' }), /HARD STOP/);
  await svc.openDecisionSource(TENANT, MATTER, sellerDecision.eventId, USER);
  await assert.rejects(svc.resolveDecision(TENANT, MATTER, sellerDecision.eventId, USER, 'verify', 'they confirmed by email'), /verification method is required/);
  await assert.rejects(svc.resolveDecision(TENANT, MATTER, sellerDecision.eventId, USER, 'approve'), /not an option/);
  assert.equal((await svc.getState(TENANT, MATTER)).bankDetails[sellerDecision.subject!].status, 'unverified');
  await svc.resolveDecision(TENANT, MATTER, sellerDecision.eventId, USER, 'verify', 'Called Smith & Co on the number on the Law Society register', { method: 'phone_callback_known_number' });
  r = await svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: sellerDecision.subject!, amountPennies: 34_650_000, purpose: 'completion_monies' });
  assert.equal(r.state.payments[0].authorisedBy, USER);
  r = await svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER });
  assert.equal(r.state.stage, 'completed');

  // ── post_completion ──
  // HMLR needs the SDLT5 with the AP1: the return first, and the stage moves only when both are lodged.
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'ap1_submitted', actor: USER, reference: 'AP1-1' }), /SDLT return has not been filed/);
  r = await svc.run(TENANT, MATTER, { type: 'sdlt_submitted', actor: USER, reference: 'SDLT-1' });
  assert.equal(r.state.stage, 'completed');
  r = await svc.run(TENANT, MATTER, { type: 'ap1_submitted', actor: USER, reference: 'AP1-1' });
  assert.equal(r.state.stage, 'post_completion');
  r = await svc.run(TENANT, MATTER, { type: 'ap1_confirmed', actor: USER });
  assert.ok(r.state.postCompletion.ap1ConfirmedAt);
  assert.deepEqual(stageBlockers(r.state), ['matter complete']);
  assert.deepEqual(await h.store.listActiveMatters(TENANT), [], 'finished matters leave the timer sweep');

  // ── §2.8 (2): replay audit — state is a pure function of the log ──
  // (getState, not the last command's result: post-commit effects — the client update
  // for ap1_confirmed — append after the command returns, and they are in the log too.)
  const live = await svc.getState(TENANT, MATTER);
  const log: EngineEvent[] = h.store.dump(TENANT, MATTER);
  assert.deepEqual(log.map((e) => e.seq), log.map((_, i) => i + 1), 'gap-free sequence');
  const replayed = project(TENANT, MATTER, log);
  assert.deepEqual(replayed, live, 'replaying the log reproduces the live state exactly');
  assert.deepEqual(project(TENANT, MATTER, log), replayed, 'replay is deterministic');
  const shuffled = [...log].reverse();
  assert.notDeepEqual(project(TENANT, MATTER, shuffled), replayed, 'order matters — the log is the truth, not a bag of facts');

  // ── §2.8 (3): every _sent of AI content has a human _approved before it ──
  const sentIdx = log.findIndex((e) => e.type === 'report_on_title_sent');
  const approved = log.find((e) => e.type === 'report_on_title_approved');
  assert.ok(approved && log.indexOf(approved) < sentIdx);
  assert.ok(isUserActor(approved!.actor));
  assert.equal((log[sentIdx] as EngineEvent<'report_on_title_sent'>).payload.approvedEventId, approved!.id);

  // Every decision ever raised points at a source document, and every resolution was preceded by that user opening it.
  for (const d of Object.values(replayed.decisions)) {
    assert.ok(d.sourceDocumentId, `${d.kind} decision has a source`);
    assert.ok(d.citations.length > 0);
    if (d.resolvedBy) assert.ok(d.openedBy.includes(d.resolvedBy), `${d.kind} ${d.subject} resolved by someone who opened the source`);
  }
  // Addendum 2: every fraud-risk moment is queryable, and no payment used unverified details.
  const audit = (await import('../../../lib/server/engine/audit')).buildAuditReport(TENANT, MATTER, log, null);
  assert.deepEqual(audit.summary.bankDetailsHardStops, { flagged: 2, verified: 2, failed: 0, unresolved: 0 });
  assert.equal(audit.summary.paymentsAuthorisedWithoutVerifiedDetails, 0);
  // Stage moves are themselves logged, in order.
  assert.deepEqual(
    log.filter((e) => e.type === 'stage_advanced').map((e) => (e as EngineEvent<'stage_advanced'>).payload.to),
    ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion']
  );
});

test('timers: an unanswered search is chased at day 10 and escalated at day 18 with a citable dossier', async () => {
  const h = harness(new Date('2026-09-14T09:00:00Z')); // Monday
  const { svc, ports } = h;
  await svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['LLC1'] });
  await svc.requestIdCheck(TENANT, MATTER, USER);
  await svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  assert.equal((await svc.getState(TENANT, MATTER)).searches.LLC1.status, 'ordered');
  // The seller's solicitor sends the pack straight away, so the only clock running is the search's.
  await svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  await svc.run(TENANT, MATTER, { type: 'record_survey_plan', actor: USER, plan: 'none' });

  ports.setNow(new Date('2026-09-25T09:00:00Z')); // 9 working days
  assert.deepEqual(await svc.tickAll(TENANT), { matters: 1, chases: 0, escalations: 0 });
  ports.setNow(new Date('2026-09-28T09:00:00Z')); // 10 working days
  assert.deepEqual(await svc.tickAll(TENANT), { matters: 1, chases: 1, escalations: 0 });
  assert.equal(ports.chaser.chases[0].recipientRole, 'search_provider');
  assert.deepEqual(await svc.tick(TENANT, MATTER), { chases: 0, escalations: 0 }, 'same day: idempotent');

  ports.setNow(new Date('2026-10-08T09:00:00Z')); // 18 working days
  const t = await svc.tick(TENANT, MATTER);
  assert.equal(t.escalations, 1);
  const s = await svc.getState(TENANT, MATTER);
  const esc = Object.values(s.decisions).find((d) => d.kind === 'escalation')!;
  assert.equal(esc.status, 'pending');
  const dossier = await ports.documents.get(TENANT, esc.sourceDocumentId);
  assert.match((dossier?.extractedFacts as { content: string }).content, /ESCALATION DOSSIER/);
  assert.match(esc.summary, /chased 2×|chased 1×/);
  assert.deepEqual(await svc.tick(TENANT, MATTER), { chases: 0, escalations: 0 }, 'no second escalation while one is pending');

  // A senior resolves it (after opening the dossier) — then the search finally comes back and the wait closes.
  await resolve(h, esc.eventId, 'approve', USER, 'Provider confirms Friday');
  await svc.searchReturned(TENANT, MATTER, 'LLC1', h.doc(searchClear('LLC1')));
  ports.setNow(new Date('2026-12-01T09:00:00Z'));
  assert.deepEqual(await svc.tick(TENANT, MATTER), { chases: 0, escalations: 0 });
  const pending = await h.store.listPendingDecisions(TENANT);
  // With the search back, title, searches and enquiries are all resolved: the report on title drafted itself.
  assert.equal(pending.filter((d) => d.kind === 'report_on_title').length, 1, 'the report on title is drafted for approval');
  assert.equal(pending.filter((d) => d.kind !== 'auto_clear' && d.kind !== 'report_on_title').length, 0, 'nothing else waits on a person');
});

test('extraction failure never stalls the matter — it becomes a human decision', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['LLC1'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const noFacts = h.doc(null); // pipeline #2 produced nothing
  const r = await h.svc.searchReturned(TENANT, MATTER, 'LLC1', noFacts);
  assert.equal(r.state.searches.LLC1.status, 'flagged');
  const d = firstDecision(r.state);
  assert.equal(d.sourceDocumentId, noFacts);
  assert.match(d.summary, /LOW_EXTRACTION_CONFIDENCE|confidence/i);
});

test('no search provider connected: an ordered search comes straight back as a placeholder that says so, and the report on title then drafts itself', async () => {
  const { MockSearchProvider } = await import('../../../lib/server/engine/mocks');
  const h = harness();
  h.ports.searchProvider = new MockSearchProvider({ placeholders: true });
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29', 'DRAINAGE_WATER'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  let s = await h.svc.getState(TENANT, MATTER);
  for (const t of ['CON29', 'DRAINAGE_WATER'] as const) {
    assert.ok(['cleared', 'reviewed'].includes(s.searches[t].status), `${t} came back (${s.searches[t].status})`);
    const doc = await h.ports.documents.get(TENANT, s.searches[t].documentId!);
    assert.match((doc!.extractedFacts as { content: string }).content, /^PLACEHOLDER: .*\n\nNo search was carried out/);
  }
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.reportOnTitle.status, 'drafted', 'title, searches and enquiries resolved: the report drafted itself');
});

test('the report on title can go early as an interim report; once searches are in, a supplementary is due before exchange and drafts itself', async () => {
  const h = harness();
  const { svc } = h;
  await svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await svc.requestIdCheck(TENANT, MATTER, USER);
  await svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  let s = await svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_contract', 'the search is still out');
  await svc.draftReportOnTitle(TENANT, MATTER);
  s = await svc.getState(TENANT, MATTER);
  assert.equal(s.reportOnTitle.interim, true);
  const d = Object.values(s.decisions).find((x) => x.kind === 'report_on_title' && x.status === 'pending')!;
  await resolve(h, d.eventId, 'approve', USER);
  await svc.sendReportOnTitle(TENANT, MATTER, USER);
  assert.equal((await svc.getState(TENANT, MATTER)).reportOnTitle.status, 'sent');
  // The search comes back: everything is in, and the interim report is not the whole story.
  await svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  s = await svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'contract_review');
  assert.ok(s.reportOnTitle.interimSentAt, 'the interim report is remembered');
  assert.equal(s.reportOnTitle.status, 'drafted', 'the supplementary drafted itself');
  assert.equal(s.reportOnTitle.interim, false);
  const { stageBlockers } = await import('../../../lib/server/engine/machine');
  assert.ok(stageBlockers(s).some((b) => /report on title/.test(b)), 'exchange waits for the supplementary');
});

test('manual handling: a person marks steps complete by hand (note and evidence) and the case moves on them; automation stays paused', async () => {
  const h = harness();
  const { svc } = h;
  await svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await svc.run(TENANT, MATTER, { type: 'mark_manual_handling', actor: USER, reason: 'Unregistered land, handled by hand' } as never);
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'complete_step_manually', actor: 'system', step: 'id_check', note: 'x' }), /by a person/);
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'complete_step_manually', actor: USER, step: 'exchange', note: 'x' }), /cannot be marked complete by hand|is not a step/);
  await svc.run(TENANT, MATTER, { type: 'complete_step_manually', actor: USER, step: 'id_check', note: 'Passport seen in person, certified copy on file', documentIds: [] });
  let s = await svc.getState(TENANT, MATTER);
  assert.equal(s.idCheck.status, 'reviewed');
  assert.equal(s.stage, 'pre_contract', 'the ID step marked complete moves the case on');
  await svc.run(TENANT, MATTER, { type: 'complete_step_manually', actor: USER, step: 'search:CON29', note: 'Personal search from another provider', documentIds: [] });
  s = await svc.getState(TENANT, MATTER);
  assert.equal(s.searches.CON29.status, 'reviewed');
  assert.equal(s.manualSteps?.['search:CON29']?.note, 'Personal search from another provider');
});

test('in manual handling nothing stops firing, but whatever would have gone out on its own is proposed to a person instead (marked manual mode)', async () => {
  const h = harness();
  const { svc, ports } = h;
  await svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29', 'LLC1'] });
  await svc.run(TENANT, MATTER, { type: 'mark_manual_handling', actor: USER, reason: 'Handled by hand for now' } as never);
  await svc.run(TENANT, MATTER, { type: 'complete_step_manually', actor: USER, step: 'id_check', note: 'Seen in person' });
  const s = await svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_contract');
  assert.equal(ports.searchProvider.orders.length, 0, 'nothing ordered unasked');
  const proposed = Object.values(s.proposals).filter((p) => p.action === 'search_order' && p.status === 'pending');
  assert.deepEqual(proposed.map((p) => p.subject).sort(), ['CON29', 'LLC1'], 'both searches proposed');
  assert.ok(proposed.every((p) => (p.detail as { manualMode?: boolean }).manualMode), 'marked as manual mode');
});

test("an enquiry raised goes to the seller's solicitor, not only onto the record", async () => {
  const h = harness();
  const { svc, ports } = h;
  await svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: [] });
  await svc.requestIdCheck(TENANT, MATTER, USER);
  await svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, subject: '1. Please supply the FENSA certificate for the replacement windows.' } as never);
  const sent = (ports.chaser as unknown as { enquiriesSent: Array<{ text: string }> }).enquiriesSent;
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /FENSA certificate/);
});
