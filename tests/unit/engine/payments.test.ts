/** Addendum 2 — payment verification: bank details are versioned hard-stops, verified only out-of-band, and gate every payment event. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentBankDetails, VERIFICATION_METHODS, REJECTED_VERIFICATION_METHODS } from '../../../lib/server/engine/types';
import { buildAuditReport } from '../../../lib/server/engine/audit';
import { harness, resolve, TENANT, MATTER, USER, SENIOR, idClear, searchClear, titleClear } from './helpers';

const sortCode = '401234';
const details = (n: string, name = 'Smith & Co Client Account') => ({ sortCode, accountNumber: n, accountName: name, firmName: 'Smith & Co' });

async function toPreCompletion(h: ReturnType<typeof harness>) {
  const { svc } = h;
  await svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await svc.requestIdCheck(TENANT, MATTER, USER);
  await svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  await svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  const r = await svc.draftReportOnTitle(TENANT, MATTER);
  const rot = Object.values(r.state.decisions).find((d) => d.kind === 'report_on_title')!;
  await resolve(h, rot.eventId, 'approve');
  await svc.sendReportOnTitle(TENANT, MATTER, USER);
  await svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  await svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-11-27' });
  await svc.run(TENANT, MATTER, { type: 'completion_statement_generated', actor: USER });
  assert.equal((await svc.getState(TENANT, MATTER)).stage, 'pre_completion');
}

test('§1/§4: first-time details and every change are recorded as new versions and each is a hard-stop decision', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false });
  const first = await h.svc.recordBankDetails(TENANT, MATTER, { actor: 'external', payeeKind: 'seller_solicitor', payeeRef: 'Smith & Co', details: details('11111111'), sourceChannel: 'email', sourceDocumentId: h.doc({ content: 'email 1' }) });
  assert.deepEqual(first.events.map((e) => e.type), ['bank_details_recorded', 'bank_details_change_flagged']);
  assert.equal((first.events[0].payload as { isChange: boolean }).isChange, false, 'first time is still flagged');
  const d1 = Object.values(first.state.decisions)[0];
  assert.equal(d1.kind, 'bank_details');
  assert.deepEqual(d1.options, ['verify', 'reject', 'escalate']);
  assert.match(d1.summary, /NEW BANK DETAILS/);
  assert.match(d1.summary, /reply on the channel the details arrived on is not verification/i);
  // a change: new row, old one superseded, previous shown masked
  const second = await h.svc.recordBankDetails(TENANT, MATTER, { actor: 'external', payeeKind: 'seller_solicitor', details: details('22222222'), sourceChannel: 'email', sourceDocumentId: h.doc({ content: 'email 2 — "please use our NEW account"' }) });
  const ids = Object.keys(second.state.bankDetails);
  assert.equal(ids.length, 2, 'never overwritten');
  const [a, b] = Object.values(second.state.bankDetails).sort((x, y) => x.recordedAt.localeCompare(y.recordedAt) || (x.id < y.id ? -1 : 1));
  assert.equal(a.status, 'superseded');
  assert.equal(b.status, 'unverified');
  assert.equal(b.supersedesId, a.id);
  assert.equal(currentBankDetails(second.state, 'seller_solicitor')?.id, b.id);
  const flagged = second.events.find((e) => e.type === 'bank_details_change_flagged')!.payload as { isChange: boolean; previous: string };
  assert.equal(flagged.isChange, true);
  assert.match(flagged.previous, /····1111/);
  // both channels look the same to the machine
  const third = await h.svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind: 'seller_solicitor', details: details('33333333'), sourceChannel: 'phone' });
  assert.equal(third.events[1].type, 'bank_details_change_flagged');
  // invalid formats never enter the log
  await assert.rejects(h.svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind: 'client', details: { sortCode: '12-34-56', accountNumber: '1', accountName: 'x', firmName: null }, sourceChannel: 'manual' }), /6 digits/);
});

test('§3: only out-of-band methods verify; same-channel confirmation, "approve" and missing methods are rejected as validation errors', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false });
  const r = await h.svc.recordBankDetails(TENANT, MATTER, { actor: 'external', payeeKind: 'seller_solicitor', details: details('11111111'), sourceChannel: 'email', sourceDocumentId: h.doc({ content: 'email' }) });
  const d = Object.values(r.state.decisions)[0];
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  for (const bad of REJECTED_VERIFICATION_METHODS) await assert.rejects(h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'verify', null, { method: bad }), /not verification/);
  await assert.rejects(h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'verify', null, { method: 'I rang them' }), /verification method is required/);
  await assert.rejects(h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'verify', null, { method: 'lawyer_checker_match' }), /needs its check reference/);
  await assert.rejects(h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve'), /not an option/);
  await assert.rejects(h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'refer_to_client'), /not an option/);
  const ok = await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'verify', 'LC ref matched prior conveyancing use', { method: 'lawyer_checker_match', reference: 'LC-2026-0917-4411' });
  assert.equal(ok.events[0].type, 'bank_details_verified');
  const b = ok.state.bankDetails[d.subject!];
  assert.equal(b.status, 'verified');
  assert.equal(b.verificationMethod, 'lawyer_checker_match');
  assert.equal(b.verificationRef, 'LC-2026-0917-4411');
  assert.equal(b.verifiedBy, USER);
  assert.ok((VERIFICATION_METHODS as readonly string[]).includes(b.verificationMethod!));
  // a failed verification is its own event and leaves the record unusable
  const r2 = await h.svc.recordBankDetails(TENANT, MATTER, { actor: 'external', payeeKind: 'seller_solicitor', details: details('22222222'), sourceChannel: 'email', sourceDocumentId: h.doc({ content: 'suspicious email' }) });
  const d2 = Object.values(r2.state.decisions).find((x) => x.status === 'pending')!;
  const fail = await resolve(h, d2.eventId, 'reject', USER, 'Callback: Smith & Co say they never sent this. Reported.');
  assert.equal(fail.events[0].type, 'bank_details_verification_failed');
  assert.equal(fail.state.bankDetails[d2.subject!].status, 'failed');
});

test('§2/§5: a pending change blocks payment events regardless of urgency; payments need a person and verified, current details', async () => {
  const h = harness();
  await toPreCompletion(h);
  const { svc } = h;
  // firm client account for incoming funds
  const f = await svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind: 'firm_client_account', details: details('99999999', 'Firm LLP Client'), sourceChannel: 'manual' });
  const fd = Object.values(f.state.decisions).find((d) => d.kind === 'bank_details' && d.status === 'pending')!;
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'funds_requested', actor: USER, fromRole: 'client', bankDetailsId: fd.subject! }), /HARD STOP/);
  await svc.openDecisionSource(TENANT, MATTER, fd.eventId, USER);
  await svc.resolveDecision(TENANT, MATTER, fd.eventId, USER, 'verify', null, { method: 'in_person' });
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'funds_requested', actor: 'ai', fromRole: 'client', bankDetailsId: fd.subject! }), /by a person/);
  await svc.run(TENANT, MATTER, { type: 'funds_requested', actor: USER, fromRole: 'client', bankDetailsId: fd.subject! });
  await svc.run(TENANT, MATTER, { type: 'funds_received', actor: USER, fromRole: 'client' });

  // seller's solicitor: verified details, then a last-minute change → everything stops
  const s1 = await svc.recordBankDetails(TENANT, MATTER, { actor: 'external', payeeKind: 'seller_solicitor', details: details('11111111'), sourceChannel: 'letter', sourceDocumentId: h.doc({ content: 'client care letter' }) });
  const sd1 = Object.values(s1.state.decisions).find((d) => d.kind === 'bank_details' && d.status === 'pending')!;
  await svc.openDecisionSource(TENANT, MATTER, sd1.eventId, USER);
  await svc.resolveDecision(TENANT, MATTER, sd1.eventId, USER, 'verify', null, { method: 'phone_callback_known_number' });
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: 'system', payeeKind: 'seller_solicitor', bankDetailsId: sd1.subject!, purpose: 'completion_monies' }), /by a person/);
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: fd.subject!, purpose: 'completion_monies' }), /belong to firm client account/);

  // "Friday afternoon": new details by email the day before completion
  const s2 = await svc.recordBankDetails(TENANT, MATTER, { actor: 'external', payeeKind: 'seller_solicitor', details: details('22222222'), sourceChannel: 'email', sourceDocumentId: h.doc({ content: 'URGENT: our account has changed, completion tomorrow' }) });
  const sd2 = Object.values(s2.state.decisions).find((d) => d.kind === 'bank_details' && d.status === 'pending')!;
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: sd1.subject!, purpose: 'completion_monies' }), /HARD STOP/);
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: sd2.subject!, purpose: 'completion_monies' }), /HARD STOP/);
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /HARD STOP/);
  assert.ok((await import('../../../lib/server/engine/machine')).stageBlockers(s2.state).some((b) => /hard stop/.test(b)));
  // callback reveals fraud → failed; the OLD verified record is superseded too, so nothing is payable until fresh details are verified
  await svc.openDecisionSource(TENANT, MATTER, sd2.eventId, USER);
  await svc.resolveDecision(TENANT, MATTER, sd2.eventId, USER, 'reject', 'Smith & Co confirm by callback: not their email. Fraud attempt logged.');
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: sd1.subject!, purpose: 'completion_monies' }), /superseded/);
  await assert.rejects(svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: sd2.subject!, purpose: 'completion_monies' }), /failed/);
  // re-confirmed genuine details, verified out-of-band → payment → completion
  const s3 = await svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind: 'seller_solicitor', details: details('11111111'), sourceChannel: 'phone' });
  const sd3 = Object.values(s3.state.decisions).find((d) => d.kind === 'bank_details' && d.status === 'pending')!;
  await svc.openDecisionSource(TENANT, MATTER, sd3.eventId, SENIOR);
  await svc.resolveDecision(TENANT, MATTER, sd3.eventId, SENIOR, 'verify', 'Callback to the number on file since instruction', { method: 'phone_callback_known_number' });
  const pay = await svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: sd3.subject!, amountPennies: 34_650_000, purpose: 'completion_monies' });
  assert.equal(pay.events[0].actor, USER);
  const done = await svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER });
  assert.equal(done.state.stage, 'completed');

  // §6: the whole fraud-risk history is queryable from the log
  const report = buildAuditReport(TENANT, MATTER, h.store.dump(TENANT, MATTER), null);
  assert.deepEqual(report.summary.bankDetailsHardStops, { flagged: 4, verified: 3, failed: 1, unresolved: 0 });
  assert.equal(report.summary.paymentsAuthorisedWithoutVerifiedDetails, 0);
  const log = h.store.dump(TENANT, MATTER);
  const kinds = log.filter((e) => e.type.startsWith('bank_details_')).map((e) => e.type);
  assert.ok(kinds.includes('bank_details_change_flagged') && kinds.includes('bank_details_verified') && kinds.includes('bank_details_verification_failed'));
});
