/**
 * Eventualities (docs/engine-eventualities.md): the ways a real purchase departs from the
 * happy path, and what the machine does about each. Every scenario here is one a
 * conveyancer meets in an ordinary year.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageBlockers } from '../../../lib/server/engine/machine';
import { deadlineActions } from '../../../lib/server/engine/sla';
import { pendingDecisions, isFinished } from '../../../lib/server/engine/types';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, SENIOR, idClear, searchClear, searchFlagged, offerClear, titleClear, replyClear, titleWithCharge } from './helpers';

/** Drive a lender-funded matter to pre_exchange with everything cleared. */
async function toPreExchange(h: ReturnType<typeof harness>, opts: { expiry?: string } = {}) {
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: true, requiredSearches: ['CON29'], targetExchangeDate: '2026-11-20', targetCompletionDate: '2026-12-11' });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc({ ...offerClear(), expiryDate: opts.expiry ?? '2027-03-01' }));
  const mid = await h.svc.getState(TENANT, MATTER);
  const md = pendingDecisions(mid).find((d) => d.kind === 'mortgage');
  if (md) await resolve(h, md.eventId, 'approve', USER, 'Near-expiry noted; exchange planned within the offer period');
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  await h.svc.draftReportOnTitle(TENANT, MATTER);
  const rot = firstDecision(await h.svc.getState(TENANT, MATTER), 'report_on_title');
  await resolve(h, rot.eventId, 'approve');
  await h.svc.sendReportOnTitle(TENANT, MATTER, USER);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_exchange');
  return s;
}

test('abandonment: the client withdraws mid pre-contract — the matter closes to further commands, waits close, timers stop, corrections still allowed', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'Boundary' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'abandon_matter', actor: 'system', reason: 'client_withdrew' }), /person/);
  const r = await h.svc.run(TENANT, MATTER, { type: 'abandon_matter', actor: USER, reason: 'gazumped', detail: 'Seller accepted a higher offer via the agent' });
  assert.equal(r.events[0].type, 'matter_abandoned');
  assert.equal(r.state.abandoned?.stage, 'pre_contract');
  assert.ok(r.state.waits.every((w) => w.closedAt), 'every open wait closed');
  assert.deepEqual(stageBlockers(r.state), ['matter abandoned (gazumped)']);
  assert.equal(isFinished(r.state), true);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E2', subject: 'x' }), /abandoned/);
  await assert.rejects(h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29'))), /abandoned/);
  h.advanceDays(30);
  assert.deepEqual(await h.svc.tick(TENANT, MATTER), { chases: 0, escalations: 0 }, 'no chases on a dead matter');
  assert.equal((await h.store.listActiveMatters(TENANT)).length, 0, 'off the sweep');
  const c = await h.svc.run(TENANT, MATTER, { type: 'record_correction', actor: USER, aboutEventId: r.events[0].id, reason: 'Abandoned in error — the seller came back; a new matter was opened' });
  assert.equal(c.events[0].type, 'correction_recorded');
  assert.equal(c.state.corrections, 1);
});

test('search re-issue: a cleared search can be ordered again (lender freshness rule); the new cycle runs the full sub-flow', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.searches.CON29.status, 'cleared');
  assert.equal(s.searches.CON29.cycle, 1);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'search_returned', actor: 'external', searchType: 'CON29', documentId: h.doc(searchClear('CON29')) }), /not awaiting return/);
  const r = await h.svc.run(TENANT, MATTER, { type: 'record_search_ordered', actor: USER, searchType: 'CON29', provider: 'InfoTrack (re-ordered: lender requires searches < 6 months old)' });
  assert.equal((r.events[0].payload as { reissue: boolean }).reissue, true);
  s = r.state;
  assert.equal(s.searches.CON29.status, 'ordered');
  assert.equal(s.searches.CON29.cycle, 2);
  assert.ok(stageBlockers(s).some((b) => b.startsWith('CON29 search ordered')), 'the re-ordered search gates the stage again');
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchFlagged('CON29')));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.searches.CON29.status, 'flagged', 'the fresh result is judged on its own facts');
});

test('mortgage offer withdrawn before exchange: the sub-flow reopens, exchange is blocked until a new offer clears; the new offer is judged afresh', async () => {
  const h = harness();
  await toPreExchange(h);
  await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.exchange.conditionsMet, true);
  const r = await h.svc.run(TENANT, MATTER, { type: 'mortgage_offer_withdrawn', actor: USER, reason: 'Lender withdrew after a down-valuation' });
  assert.equal(r.state.mortgage.status, 'awaiting');
  assert.ok(stageBlockers(r.state)[0].startsWith('mortgage offer awaiting'));
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' }), /Cannot exchange: the mortgage offer is awaiting/);
  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc({ ...offerClear(), amountPennies: 24_000_000, expiryDate: '2027-04-01' }));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.mortgage.status, 'cleared');
  assert.equal(s.mortgage.facts?.amountPennies, 24_000_000, 'the re-issued offer is the one on file');
  const ex = await h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' });
  assert.equal(ex.state.stage, 'exchanged');
});

test('dates: target dates re-planned before exchange; after exchange the contractual completion date moves; a notice to complete is a decision with a hard deadline', async () => {
  const h = harness();
  await toPreExchange(h);
  const t = await h.svc.run(TENANT, MATTER, { type: 'set_target_dates', actor: USER, targetExchangeDate: '2026-12-04', reason: 'Chain above not ready' });
  assert.equal(t.state.targetExchangeDate, '2026-12-04');
  assert.equal(t.state.targetCompletionDate, '2026-12-11', 'unchanged field kept');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'change_completion_date', actor: USER, completionDate: '2026-12-18' }), /not exchanged/);
  await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'set_target_dates', actor: USER, targetExchangeDate: '2027-01-01' }), /contractual/);
  const c = await h.svc.run(TENANT, MATTER, { type: 'change_completion_date', actor: USER, completionDate: '2026-12-18', reason: 'Agreed with the seller — removals' });
  assert.equal(c.state.exchange.completionDate, '2026-12-18');
  // The seller serves a notice to complete.
  const notice = h.doc({ content: 'NOTICE TO COMPLETE under Standard Condition 6.8' }, 'NOTICE');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'notice_to_complete_served', actor: USER, servedBy: 'seller', expiresAt: 'not a date', documentId: notice }), /valid expiry/);
  const n = await h.svc.run(TENANT, MATTER, { type: 'notice_to_complete_served', actor: USER, servedBy: 'seller', expiresAt: '2027-01-06', documentId: notice });
  assert.equal(n.state.noticeToComplete?.servedBy, 'seller');
  const d = firstDecision(n.state, 'escalation');
  assert.match(d.summary, /NOTICE TO COMPLETE served by the seller/);
  assert.equal(d.sourceDocumentId, notice);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'notice_to_complete_served', actor: USER, servedBy: 'buyer', expiresAt: '2027-01-06', documentId: notice }), /already on file/);
  // The timer raises the deadline once, 2 working days before expiry.
  h.ports.setNow(new Date('2027-01-04T09:00:00Z'));
  const acts = deadlineActions(n.state, h.ports.now());
  assert.deepEqual(acts.map((a) => a.kind), ['notice_to_complete']);
  const tick = await h.svc.tick(TENANT, MATTER);
  assert.equal(tick.escalations, 1);
  assert.deepEqual(await h.svc.tick(TENANT, MATTER), { chases: 0, escalations: 0 }, 'raised once');
  const dl = pendingDecisions(await h.svc.getState(TENANT, MATTER)).find((x) => x.subject === 'deadline:notice_to_complete:2027-01-06')!;
  assert.match(dl.summary, /expires on 2027-01-06/);
});

test('deadlines we owe: mortgage offer expiry before exchange and the 14-day SDLT window are raised in time, once each', async () => {
  const h = harness();
  await toPreExchange(h, { expiry: '2026-10-05' });
  h.ports.setNow(new Date('2026-09-14T09:00:00Z')); // 15 working days before 5 Oct
  let acts = deadlineActions(await h.svc.getState(TENANT, MATTER), h.ports.now());
  assert.deepEqual(acts.map((a) => a.kind), ['mortgage_offer_expiry']);
  assert.equal((await h.svc.tick(TENANT, MATTER)).escalations, 1);
  assert.equal((await h.svc.tick(TENANT, MATTER)).escalations, 0, 'once');
  const s = await h.svc.getState(TENANT, MATTER);
  const esc = pendingDecisions(s).find((d) => d.subject === 'deadline:mortgage_offer_expiry:2026-10-05')!;
  assert.match(esc.summary, /expires on 2026-10-05 and contracts are not exchanged/);
  // Exchange and complete; the SDLT deadline runs from completion.
  await resolve(h, esc.eventId, 'approve', SENIOR, 'Extension requested from lender');
  await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-10-02' });
  await h.svc.run(TENANT, MATTER, { type: 'completion_statement_generated', actor: USER });
  // Bank details + payment (addendum 2) so completion can be confirmed.
  const firm = await h.svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind: 'firm_client_account', details: { sortCode: '401234', accountNumber: '00112233', accountName: 'Client A/C', firmName: null }, sourceChannel: 'manual' });
  await h.svc.openDecisionSource(TENANT, MATTER, firstDecision(firm.state, 'bank_details').eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, firstDecision(firm.state, 'bank_details').eventId, USER, 'verify', 'mandate', { method: 'in_person' });
  const sol = await h.svc.recordBankDetails(TENANT, MATTER, { actor: 'external', payeeKind: 'seller_solicitor', details: { sortCode: '309876', accountNumber: '55667788', accountName: 'Greenfield Client', firmName: 'Greenfield' }, sourceChannel: 'letter' });
  const sd = firstDecision(sol.state, 'bank_details');
  await h.svc.openDecisionSource(TENANT, MATTER, sd.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, sd.eventId, USER, 'verify', 'call-back', { method: 'phone_callback_known_number' });
  const st = await h.svc.getState(TENANT, MATTER);
  const firmId = Object.values(st.bankDetails).find((b) => b.payeeKind === 'firm_client_account')!.id;
  const solId = Object.values(st.bankDetails).find((b) => b.payeeKind === 'seller_solicitor')!.id;
  await h.svc.run(TENANT, MATTER, { type: 'funds_requested', actor: USER, fromRole: 'lender', bankDetailsId: firmId });
  await h.svc.run(TENANT, MATTER, { type: 'funds_received', actor: USER, fromRole: 'lender' });
  await h.svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: solId, purpose: 'completion_monies' });
  h.ports.setNow(new Date('2026-10-02T14:00:00Z'));
  const done = await h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER });
  assert.equal(done.state.stage, 'completed');
  h.ports.setNow(new Date('2026-10-12T09:00:00Z')); // 4 working days before 16 Oct
  acts = deadlineActions(await h.svc.getState(TENANT, MATTER), h.ports.now());
  assert.deepEqual(acts.map((a) => [a.kind, a.dueDate]), [['sdlt_filing', '2026-10-16']]);
  assert.equal((await h.svc.tick(TENANT, MATTER)).escalations, 1);
  await h.svc.run(TENANT, MATTER, { type: 'sdlt_submitted', actor: USER, reference: 'SDLT-1' });
  assert.deepEqual(deadlineActions(await h.svc.getState(TENANT, MATTER), h.ports.now()), [], 'filed → no deadline');
});

test('enquiries: one the handler no longer needs is withdrawn (wait closes, stage unblocks); an indemnity policy is a recorded way to resolve a flagged search or title', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'Building regs for the extension' });
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E2', subject: 'Fence ownership' });
  const r = await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchFlagged('CON29')));
  const d = firstDecision(r.state, 'search');
  assert.ok(d.options.includes('indemnity'));
  const res = await resolve(h, d.eventId, 'indemnity', USER, 'Enforcement notice risk covered by a planning indemnity policy at the seller\'s cost');
  assert.equal(res.state.searches.CON29.status, 'reviewed');
  assert.equal(res.state.searches.CON29.resolution, 'indemnity');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'withdraw_enquiry', actor: USER, enquiryId: 'E1', reason: '' }), /reason/);
  const w = await h.svc.run(TENANT, MATTER, { type: 'withdraw_enquiry', actor: USER, enquiryId: 'E1', reason: 'Covered by the indemnity policy' });
  assert.equal(w.state.enquiries.E1.status, 'withdrawn');
  assert.ok(w.state.waits.find((x) => x.key === 'enquiry' && x.subject === 'E1')!.closedAt);
  assert.ok(!stageBlockers(w.state).some((b) => b.includes('E1')));
  await h.svc.enquiryReplyReceived(TENANT, MATTER, 'E2', h.doc(replyClear('E2')));
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'contract_review', 'withdrawn + cleared → gate opens');
  // Title with a charge → indemnity is offered there too.
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleWithCharge()));
  const td = firstDecision(await h.svc.getState(TENANT, MATTER), 'title');
  assert.ok(td.options.includes('indemnity'));
});

test('post-completion: an HMLR requisition is a decision citing the letter, blocks the registration gate until answered, and has a reply deadline the timer watches', async () => {
  const h = harness();
  await toPreExchange(h);
  await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'hmlr_requisition_received', actor: 'external', documentId: h.doc(null), deadline: '2027-01-20' }), /No AP1/);
  // Fast-forward through completion via the log directly (the payment path is covered elsewhere).
  const s0 = await h.svc.getState(TENANT, MATTER);
  void s0;
  const h2 = harness();
  await h2.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await h2.svc.requestIdCheck(TENANT, MATTER, USER);
  await h2.svc.idCheckResultReceived(TENANT, MATTER, h2.doc(idClear()));
  await h2.svc.searchReturned(TENANT, MATTER, 'CON29', h2.doc(searchClear('CON29')));
  await h2.svc.titleReceived(TENANT, MATTER, h2.doc(titleClear()));
  await h2.svc.draftReportOnTitle(TENANT, MATTER);
  await resolve(h2, firstDecision(await h2.svc.getState(TENANT, MATTER), 'report_on_title').eventId, 'approve');
  await h2.svc.sendReportOnTitle(TENANT, MATTER, USER);
  await h2.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  await h2.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' });
  await h2.svc.run(TENANT, MATTER, { type: 'completion_statement_generated', actor: USER });
  const firm = await h2.svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind: 'firm_client_account', details: { sortCode: '401234', accountNumber: '00112233', accountName: 'Client A/C', firmName: null }, sourceChannel: 'manual' });
  const fd = firstDecision(firm.state, 'bank_details');
  await h2.svc.openDecisionSource(TENANT, MATTER, fd.eventId, USER);
  await h2.svc.resolveDecision(TENANT, MATTER, fd.eventId, USER, 'verify', 'mandate', { method: 'in_person' });
  const sol = await h2.svc.recordBankDetails(TENANT, MATTER, { actor: 'external', payeeKind: 'seller_solicitor', details: { sortCode: '309876', accountNumber: '55667788', accountName: 'Greenfield Client', firmName: 'Greenfield' }, sourceChannel: 'letter' });
  const sd = firstDecision(sol.state, 'bank_details');
  await h2.svc.openDecisionSource(TENANT, MATTER, sd.eventId, USER);
  await h2.svc.resolveDecision(TENANT, MATTER, sd.eventId, USER, 'verify', 'call-back', { method: 'phone_callback_known_number' });
  const st = await h2.svc.getState(TENANT, MATTER);
  const firmId = Object.values(st.bankDetails).find((b) => b.payeeKind === 'firm_client_account')!.id;
  const solId = Object.values(st.bankDetails).find((b) => b.payeeKind === 'seller_solicitor')!.id;
  await h2.svc.run(TENANT, MATTER, { type: 'funds_requested', actor: USER, fromRole: 'client', bankDetailsId: firmId });
  await h2.svc.run(TENANT, MATTER, { type: 'funds_received', actor: USER, fromRole: 'client' });
  await h2.svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: solId, purpose: 'completion_monies' });
  await h2.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER });
  await h2.svc.run(TENANT, MATTER, { type: 'sdlt_submitted', actor: USER });
  await h2.svc.run(TENANT, MATTER, { type: 'ap1_submitted', actor: USER, reference: 'AP1-77' });
  let s = await h2.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'post_completion');
  const letter = h2.doc({ content: 'Requisition: please supply a certified copy of the deed of variation dated 3 May 2019.' }, 'HMLR_REQUISITION');
  const r = await h2.svc.run(TENANT, MATTER, { type: 'hmlr_requisition_received', actor: 'external', documentId: letter, reference: 'REQ/AP1-77/1', deadline: '2027-01-20' });
  s = r.state;
  assert.deepEqual(stageBlockers(s), ['HMLR requisition outstanding', 'awaiting HMLR registration']);
  const d = firstDecision(s, 'requisition');
  assert.equal(d.sourceDocumentId, letter);
  assert.deepEqual(d.options, ['approve', 'escalate']);
  await assert.rejects(h2.svc.run(TENANT, MATTER, { type: 'ap1_confirmed', actor: 'external' }), /requisition is still unanswered/);
  h2.ports.setNow(new Date('2027-01-14T09:00:00Z'));
  assert.deepEqual(deadlineActions(s, h2.ports.now()).map((a) => a.kind), ['requisition_reply']);
  const answered = await resolve(h2, d.eventId, 'approve', USER, 'Certified copy sent via the portal');
  assert.equal(answered.events[0].type, 'hmlr_requisition_responded');
  assert.ok(answered.state.postCompletion.requisitions[0].respondedAt);
  assert.deepEqual(stageBlockers(answered.state), ['awaiting HMLR registration']);
  assert.deepEqual(deadlineActions(answered.state, h2.ports.now()), []);
});

test('handler change is on the log (holiday cover, reassignment); a person can record a correction against any earlier event', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false });
  const r = await h.svc.run(TENANT, MATTER, { type: 'record_handler_change', actor: USER, fromUserId: USER, toUserId: SENIOR, reason: 'Annual leave cover' });
  assert.equal(r.state.handler, SENIOR);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'record_handler_change', actor: USER, fromUserId: null, toUserId: SENIOR }), /already/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'record_correction', actor: 'system', aboutEventId: r.events[0].id, reason: 'x' }), /people/);
  const c = await h.svc.run(TENANT, MATTER, { type: 'record_correction', actor: SENIOR, aboutEventId: r.events[0].id, reason: 'Cover ended 3 days early' });
  assert.equal(c.events[0].causedByEventId, r.events[0].id);
});
