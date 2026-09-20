/**
 * Transaction types (docs/transaction-types.md): one machine, six profiles. Each type is run
 * end to end through the service so the profile-driven gates, refusals and stage spine are
 * exercised the way a conveyancer would hit them — not just asserted on a bare state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, idClear, titleClear, titleWithCharge, titleLeasehold, offerClear, type Harness } from './helpers';
import { stageBlockers } from '../../../lib/server/engine/machine';
import { caseGraph, lifecycle, requirements, workstreams, gate } from '../../../lib/server/engine/graph';
import { profileOf, TRANSACTION_PROFILES } from '../../../lib/server/engine/transactions';
import { TRANSACTION_TYPES } from '../../../lib/server/engine/types';

const sortCode = '401234';
const details = (n: string, name: string) => ({ sortCode, accountNumber: n, accountName: name, firmName: name });

/** Record bank details for a payee and verify them out-of-band (addendum 2), returning the record id. */
async function verifiedDetails(h: Harness, payeeKind: 'lender' | 'client' | 'firm_client_account' | 'seller_solicitor', account: string, name: string): Promise<string> {
  const r = await h.svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind, payeeRef: name, details: details(account, name), sourceChannel: 'letter', sourceDocumentId: h.doc({ content: `${name} bank letter` }) });
  const d = Object.values(r.state.decisions).find((x) => x.kind === 'bank_details' && x.status === 'pending')!;
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'verify', 'called back on the number on file', { method: 'phone_callback_known_number' });
  return (r.events[0].payload as { bankDetailsId: string }).bankDetailsId;
}

const stages = (h: Harness) => h.store.dump(TENANT, MATTER).filter((e) => e.type === 'stage_advanced').map((e) => (e.payload as { to: string }).to);

async function idCleared(h: Harness) {
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
}

test('profiles: every type has one; the sides agree with the helpers; a sale never carries the buyer-side policies', async () => {
  for (const t of TRANSACTION_TYPES) assert.equal(profileOf(t).type, t);
  assert.equal(profileOf(undefined).type, 'freehold_purchase', 'legacy matters without a type are freehold purchases');
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_sale', hasLender: true, hasExistingMortgage: true, requireProofOfFunds: true, requireExchangeAuthority: true });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.hasLender, false, 'a seller has no lender of ours');
  assert.equal(s.requireProofOfFunds, false, 'proof of funds is a purchase-side policy');
  assert.equal(s.requireExchangeAuthority, true, 'the client still authorises exchange on a sale');
  assert.deepEqual(s.requiredSearches, [], 'no searches on a sale by default');
  assert.equal(s.propertyForms.status, 'not_started');
  assert.equal(s.redemption.status, 'not_started');
  assert.equal(s.mortgage.status, 'not_required');
});

test('freehold sale end to end: forms → pack → buyer\'s enquiries answered → redemption known → exchange → buyer\'s money → redemption authorised (hard stop) → completed → redeemed → balance to client → discharged → closed', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: true, requireExchangeAuthority: false });
  await idCleared(h);
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_contract');
  assert.match(stageBlockers(s).join(' | '), /property forms not requested/);
  assert.match(stageBlockers(s).join(' | '), /contract pack not sent/);
  assert.equal(lifecycle(s), 'pre_exchange');

  // The pack cannot go out before the forms and the title are in.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contract_pack_sent', actor: USER }), /property forms are not in/);
  // Buyer-side commands do not arise on a sale.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'request_lender_consent', actor: USER }), /does not apply to a freehold sale/);

  // Forms: a wait the timers chase (client SLA).
  await h.svc.run(TENANT, MATTER, { type: 'request_property_forms', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.waits.some((w) => w.key === 'property_forms' && w.closedAt === null));
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'request_property_forms', actor: USER }), /already been requested/);
  h.advanceDays(9);
  await h.svc.tick(TENANT, MATTER);
  assert.ok(h.ports.chaser.chases.some((c) => c.template === 'chase_property_forms' && c.recipientRole === 'client'), 'the client is chased for the forms');
  await h.svc.run(TENANT, MATTER, { type: 'property_forms_received', actor: USER, forms: ['TA6', 'TA10'] });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.propertyForms.status, 'received');
  assert.ok(s.waits.every((w) => w.key !== 'property_forms' || w.closedAt !== null), 'the wait closes');

  // Title with the seller's charge: flagged for a person (the charge is what we redeem).
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleWithCharge()));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.title.status, 'flagged');
  await resolve(h, firstDecision(s, 'title').eventId, 'approve', USER, 'registered charge — to be redeemed on completion');

  const pack = await h.svc.run(TENANT, MATTER, { type: 'contract_pack_sent', actor: USER });
  assert.ok((pack.events[0].payload as { includes: string[] }).includes.includes('TA6'));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_exchange', 'forms in, title resolved, pack out → nothing is owed until the buyer raises enquiries, so the file sits at pre-exchange');

  // The buyer's enquiries are replies we owe: they hold exchange whenever they arrive.
  await h.svc.run(TENANT, MATTER, { type: 'buyer_enquiries_received', actor: USER, enquiries: [{ question: 'Please confirm the boiler service history.' }, { id: 'BE-Boundary', question: 'Who maintains the rear fence?' }] });
  s = await h.svc.getState(TENANT, MATTER);
  assert.deepEqual(Object.keys(s.inboundEnquiries).sort(), ['BE-Boundary', 'BE1']);
  assert.match(stageBlockers(s).join(' | '), /2 enquiries from the buyer awaiting our reply/);
  assert.equal(gate(s, 'exchange').ready, false);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-11-27' }), /2 of the buyer's enquiries await our reply/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'enquiry_replies_sent', actor: 'system', enquiryIds: ['BE1'] }), /person/);
  await h.svc.run(TENANT, MATTER, { type: 'enquiry_replies_sent', actor: USER, enquiryIds: ['BE1'] });
  s = await h.svc.getState(TENANT, MATTER);
  assert.match(stageBlockers(s).join(' | '), /1 enquiry from the buyer awaiting our reply \(BE-Boundary\)/);
  await h.svc.run(TENANT, MATTER, { type: 'enquiry_replies_sent', actor: USER, enquiryIds: ['BE-Boundary'] });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_exchange');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'enquiry_replies_sent', actor: USER, enquiryIds: ['BE1'] }), /already replied/);

  // Exchange needs the redemption figure on a charged property.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-11-27' }), /redemption figure is not known/);
  assert.match(stageBlockers(s).join(' | '), /redemption statement not requested/);
  await h.svc.run(TENANT, MATTER, { type: 'request_redemption_statement', actor: USER, lender: 'Big Bank plc' });
  h.advanceDays(6);
  await h.svc.tick(TENANT, MATTER);
  assert.ok(h.ports.chaser.chases.some((c) => c.template === 'chase_redemption_statement' && c.recipientRole === 'lender'));
  await h.svc.run(TENANT, MATTER, { type: 'redemption_statement_received', actor: USER, redemptionPennies: 18_250_000, validUntil: '2026-11-30', dailyInterestPennies: 2_100 });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.redemption.status, 'received');
  assert.equal(s.exchange.conditionsMet, true, 'the seller-side exchange conditions derive automatically');
  assert.equal(gate(s, 'exchange').ready, true);
  await h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-11-27' });
  await h.svc.run(TENANT, MATTER, { type: 'completion_statement_generated', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_completion');

  // Money comes from the buyer's solicitor, not from a request of ours.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'funds_requested', actor: USER, fromRole: 'client', bankDetailsId: 'x' }), /does not apply to a freehold sale/);
  await h.svc.run(TENANT, MATTER, { type: 'funds_received', actor: USER, fromRole: 'buyer_solicitor', amountPennies: 42_500_000 });
  // Completion cannot be confirmed until the redemption payment is authorised against verified lender details.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /No authorised redemption payment/);
  const lenderDetails = await verifiedDetails(h, 'lender', '22223333', 'Big Bank plc');
  await h.svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'lender', bankDetailsId: lenderDetails, amountPennies: 18_250_000, purpose: 'other' });
  await h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'completed');
  assert.match(stageBlockers(s).join(' | '), /mortgage not yet recorded as redeemed/);
  assert.match(stageBlockers(s).join(' | '), /balance to the client not authorised/);

  // Redeem, then account to the client against verified client details.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'discharge_confirmed', actor: USER }), /discharge follows redemption/);
  await h.svc.run(TENANT, MATTER, { type: 'mortgage_redeemed', actor: USER });
  const clientDetails = await verifiedDetails(h, 'client', '44445555', 'Ms Client');
  await h.svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'client', bankDetailsId: clientDetails, amountPennies: 23_000_000, purpose: 'other' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'post_completion');
  assert.equal(lifecycle(s), 'post_completion');

  // No AP1 or SDLT on a sale; the file closes once the lender has discharged.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'ap1_submitted', actor: USER }), /the buyer's solicitor registers; we discharge/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'sdlt_submitted', actor: USER }), /does not apply to a freehold sale/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'close_matter', actor: USER }), /discharge is not yet confirmed/);
  await h.svc.run(TENANT, MATTER, { type: 'discharge_confirmed', actor: USER, reference: 'DS1-0099' });
  await h.svc.run(TENANT, MATTER, { type: 'close_matter', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.closedAt);
  assert.equal(lifecycle(s), 'closed');
  assert.deepEqual(stages(h), ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion']);

  // The projections read seller-side: seller lanes present, buyer lanes absent, the last gate renamed.
  const lanes = workstreams(s).map((w) => w.id);
  assert.ok(lanes.includes('property_forms') && lanes.includes('redemption') && lanes.includes('discharge'));
  assert.ok(!lanes.includes('source_of_funds') && !lanes.includes('searches') && !lanes.includes('report_on_title'));
  assert.equal(gate(s, 'registration').label, 'Redeemed, accounted and discharged');
  const reqIds = requirements(s).map((r) => r.id);
  assert.ok(reqIds.includes('buyer_enquiries_replied') && reqIds.includes('mortgage_redeemed') && reqIds.includes('balance_to_client'));
  assert.ok(!reqIds.includes('proof_of_funds') && !reqIds.includes('report_on_title'));
});

test('sale: enquiries that arrive before the file moves on hold contract review; replies release it', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: false, requireExchangeAuthority: false });
  await idCleared(h);
  await h.svc.run(TENANT, MATTER, { type: 'request_property_forms', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'property_forms_received', actor: USER, forms: ['TA6', 'TA10'] });
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  // The pack and the first enquiries land in one sync (the pack was recorded late): the stage stops at contract review.
  await h.svc.run(TENANT, MATTER, { type: 'contract_pack_sent', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'buyer_enquiries_received', actor: USER, enquiries: [{ question: 'Q1' }] });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_exchange');
  assert.equal(s.exchange.conditionsMet, false, 'not derived while a reply is owed');
  await h.svc.run(TENANT, MATTER, { type: 'enquiry_replies_sent', actor: USER, enquiryIds: ['BE1'] });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.exchange.conditionsMet, true);
  // A second round after the conditions were derived still refuses exchange until answered.
  await h.svc.run(TENANT, MATTER, { type: 'buyer_enquiries_received', actor: USER, enquiries: [{ question: 'Q2' }] });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.inboundEnquiries.BE2.round, 2);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-11-27' }), /BE2/);
  assert.equal(gate(s, 'exchange').ready, false);
});

test('leasehold sale: the TA7 joins the forms, the management pack gates the pack, the lease tenure is expected, and no notice of assignment is needed to close', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'leasehold_sale', hasLender: false, hasExistingMortgage: false, requireExchangeAuthority: false });
  await idCleared(h);
  let s = await h.svc.getState(TENANT, MATTER);
  assert.match(stageBlockers(s).join(' | '), /management pack not requested/);
  const r = await h.svc.run(TENANT, MATTER, { type: 'request_property_forms', actor: USER });
  assert.deepEqual((r.events[0].payload as { forms: string[] }).forms, ['TA6', 'TA10', 'TA7']);
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleLeasehold()));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.title.status, 'flagged', 'the lease has not been read (no lease facts) — a person reviews; the tenure itself is as expected');
  assert.equal(s.manualHandling.required, false, 'no tenure mismatch: automation continues');
  assert.doesNotMatch(firstDecision(s, 'title').summary, /enrolled as freehold/);
  assert.deepEqual(profileOf('leasehold_sale').subflows.includes('management_pack'), true);
  assert.equal(TRANSACTION_PROFILES.leasehold_sale.registration, 'discharge_only');
});

test('remortgage end to end: no exchange — title, offer and redemption figure → deed executed (witnessed) and certificate sent → advance in → old lender paid against verified details → completed → AP1 → discharged and registered → closed', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'remortgage', hasLender: true, hasExistingMortgage: true });
  await idCleared(h);
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_contract');
  assert.equal(lifecycle(s), 'investigating');
  assert.equal(s.requireExchangeAuthority, false, 'nothing to authorise: no exchange');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'exchange_authority', decision: 'authorised' }), /no exchange to authorise/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'request_property_forms', actor: USER }), /does not apply to a remortgage/);
  const blockers = stageBlockers(s).join(' | ');
  assert.match(blockers, /title awaiting/);
  assert.match(blockers, /mortgage offer awaiting/);
  assert.match(blockers, /redemption statement not requested/);

  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc(offerClear()));
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleWithCharge()));
  s = await h.svc.getState(TENANT, MATTER);
  await resolve(h, firstDecision(s, 'title').eventId, 'approve', USER, 'existing charge to be redeemed from the advance');
  await h.svc.run(TENANT, MATTER, { type: 'request_redemption_statement', actor: USER, lender: 'Old Lender plc' });
  await h.svc.run(TENANT, MATTER, { type: 'redemption_statement_received', actor: USER, redemptionPennies: 12_000_000, validUntil: '2026-12-31' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_completion', 'no exchange phases: investigation → execution');
  assert.equal(lifecycle(s), 'investigating', 'the coarse view says READY TO COMPLETE only once the completion gate is clear');
  assert.deepEqual(stages(h), ['pre_contract', 'pre_completion']);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-11-27' }), /stage|exchange/i);

  // Execution: the deed must be witnessed; the certificate is a person's act.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'mortgage_deed_executed', actor: USER, witnessed: false }), /must be witnessed/);
  await h.svc.run(TENANT, MATTER, { type: 'mortgage_deed_executed', actor: USER, witnessed: true });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'certificate_of_title_sent', actor: 'system' }), /person/);
  await h.svc.run(TENANT, MATTER, { type: 'certificate_of_title_sent', actor: USER, completionDate: '2026-11-27' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /advance has not been received/);

  // The advance is requested to our verified client account and arrives; the old lender is paid against verified details.
  const ourAccount = await verifiedDetails(h, 'firm_client_account', '99990000', 'Firm client account');
  await h.svc.run(TENANT, MATTER, { type: 'funds_requested', actor: USER, fromRole: 'lender', bankDetailsId: ourAccount, amountPennies: 25_000_000 });
  await h.svc.run(TENANT, MATTER, { type: 'funds_received', actor: USER, fromRole: 'lender', amountPennies: 25_000_000 });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /No authorised redemption payment/);
  const oldLender = await verifiedDetails(h, 'lender', '12121212', 'Old Lender plc');
  await h.svc.run(TENANT, MATTER, { type: 'payment_authorised', actor: USER, payeeKind: 'lender', bankDetailsId: oldLender, amountPennies: 12_000_000, purpose: 'other' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(lifecycle(s), 'ready_to_complete');
  assert.equal(gate(s, 'completion').ready, true);
  await h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'completed');

  // Registration: the new charge goes on by AP1; SDLT does not arise, and a person says so.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'sdlt_not_required', actor: 'system', reason: 'no land transaction' }), /person/);
  await h.svc.run(TENANT, MATTER, { type: 'sdlt_not_required', actor: USER, reason: 'Remortgage: no chargeable land transaction.' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'sdlt_submitted', actor: USER }), /recorded as not required/);
  await h.svc.run(TENANT, MATTER, { type: 'mortgage_redeemed', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'ap1_submitted', actor: USER, reference: 'AP1-778' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'post_completion');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'close_matter', actor: USER }), /Registration is not confirmed/);
  await h.svc.run(TENANT, MATTER, { type: 'ap1_confirmed', actor: USER });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'close_matter', actor: USER }), /discharge is not yet confirmed/);
  await h.svc.run(TENANT, MATTER, { type: 'discharge_confirmed', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'close_matter', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.closedAt);
  assert.deepEqual(stages(h), ['pre_contract', 'pre_completion', 'completed', 'post_completion']);
  const g = caseGraph(s);
  assert.ok(!g.nodes.some((n) => n.id === 'gate:exchange'), 'no exchange gate in the dependency graph');
  const lanes = workstreams(s).map((w) => w.id);
  assert.ok(lanes.includes('redemption') && lanes.includes('mortgage') && !lanes.includes('enquiries') && !lanes.includes('deposit'));
});

test('transfer of equity end to end: every party identified, lender\'s consent, the clients decide how they hold, declaration of trust for tenants in common, transfer deed, consideration in, SDLT, AP1 → registered → closed', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'transfer_of_equity', hasLender: false, hasExistingMortgage: true, parties: 2, considerationPennies: 5_000_000 });
  await idCleared(h);
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_contract');
  assert.equal(s.lenderConsent.status, 'not_started');
  let blockers = stageBlockers(s).join(' | ');
  assert.match(blockers, /lender's consent not requested/);
  assert.match(blockers, /basis of co-ownership not yet decided/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'request_redemption_statement', actor: USER }), /does not apply to a transfer of equity/);

  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleWithCharge()));
  s = await h.svc.getState(TENANT, MATTER);
  await resolve(h, firstDecision(s, 'title').eventId, 'approve', USER, 'charge stays; lender to consent');
  await h.svc.run(TENANT, MATTER, { type: 'request_lender_consent', actor: USER, lender: 'Big Bank plc' });
  h.advanceDays(9);
  await h.svc.tick(TENANT, MATTER);
  assert.ok(h.ports.chaser.chases.some((c) => c.template === 'chase_lender_consent'));
  await h.svc.run(TENANT, MATTER, { type: 'lender_consent_received', actor: USER, conditions: 'Outgoing borrower released on completion; deed of substituted security' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.lenderConsent.status, 'received');
  assert.equal(s.stage, 'pre_contract', 'the clients\' decision on co-ownership still holds the stage');

  // A declaration of trust needs the clients' decision first, and only for tenants in common.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'deed_of_trust_executed', actor: USER, parties: ['A', 'B'] }), /have not decided how they hold/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: 'system', subject: 'ownership_basis', decision: 'joint_tenants' }), /never inferred/);
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'ownership_basis', decision: 'tenants_in_common_unequal', note: '70/30 reflecting contributions; advised separately' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_completion');
  assert.equal(lifecycle(s), 'investigating');
  blockers = stageBlockers(s).join(' | ');
  assert.match(blockers, /transfer deed not executed/);
  assert.match(blockers, /declaration of trust not executed/);
  assert.match(blockers, /consideration not received/);
  const reqs = requirements(s);
  assert.ok(reqs.find((r) => r.id === 'deed_of_trust')?.applies);
  assert.equal(reqs.find((r) => r.id === 'ownership_basis_decided')?.satisfied, true);

  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /transfer deed has not been executed/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'transfer_deed_executed', actor: USER, parties: [] }), /Name the parties/);
  await h.svc.run(TENANT, MATTER, { type: 'transfer_deed_executed', actor: USER, parties: ['A', 'B'] });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /declaration of trust must be executed/);
  await h.svc.run(TENANT, MATTER, { type: 'deed_of_trust_executed', actor: USER, parties: ['A', 'B'], shares: '70/30' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER }), /consideration has not been received/);
  await h.svc.run(TENANT, MATTER, { type: 'funds_received', actor: USER, fromRole: 'incoming_owner', amountPennies: 5_000_000 });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(lifecycle(s), 'ready_to_complete');
  await h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'completed');
  assert.match(stageBlockers(s).join(' | '), /SDLT return not filed/);
  await h.svc.run(TENANT, MATTER, { type: 'sdlt_submitted', actor: USER, reference: 'SDLT-1' });
  await h.svc.run(TENANT, MATTER, { type: 'ap1_submitted', actor: USER, reference: 'AP1-2' });
  await h.svc.run(TENANT, MATTER, { type: 'ap1_confirmed', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'close_matter', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.closedAt);
  assert.deepEqual(stages(h), ['pre_contract', 'pre_completion', 'completed', 'post_completion']);
  const lanes = workstreams(s).map((w) => w.id);
  assert.ok(lanes.includes('lender_consent') && lanes.includes('co_ownership') && !lanes.includes('redemption'));
});

test('transfer of equity for no consideration and no charge: nothing to consent to, no money, SDLT recorded as not required by a person', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'transfer_of_equity', hasLender: false, hasExistingMortgage: false, parties: 2 });
  await idCleared(h);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'request_lender_consent', actor: USER }), /not charged/);
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'ownership_basis', decision: 'joint_tenants', note: 'married couple, joint tenants' });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'pre_completion');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'deed_of_trust_executed', actor: USER, parties: ['A', 'B'] }), /joint tenants/);
  assert.equal(requirements(s).find((r) => r.id === 'deed_of_trust')?.applies, false);
  await h.svc.run(TENANT, MATTER, { type: 'transfer_deed_executed', actor: USER, parties: ['A', 'B'] });
  await h.svc.run(TENANT, MATTER, { type: 'completion_confirmed', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'completed');
  assert.doesNotMatch(stageBlockers(s).join(' | '), /SDLT/, 'no consideration: SDLT does not gate');
  await h.svc.run(TENANT, MATTER, { type: 'sdlt_not_required', actor: USER, reason: 'Transfer for no chargeable consideration.' });
  await h.svc.run(TENANT, MATTER, { type: 'ap1_submitted', actor: USER });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.stage, 'post_completion');
  assert.ok(s.sdltNotRequiredAt);
});

test('joint purchase: the clients decide how they hold; a declaration of trust is refused for joint tenants and required for tenants in common; the mortgage deed and transfer deed are recorded (advisory on a purchase)', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_purchase', hasLender: true, parties: 2, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await idCleared(h);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'deed_of_trust_executed', actor: USER, parties: ['A', 'B'] }), /have not decided/);
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'ownership_basis', decision: 'joint_tenants', note: 'survivorship wanted' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'deed_of_trust_executed', actor: USER, parties: ['A', 'B'] }), /joint tenants/);
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(requirements(s).find((r) => r.id === 'deed_of_trust')?.applies, false);
  // Instructions change: tenants in common in unequal shares → the deed now applies.
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'ownership_basis', decision: 'tenants_in_common_unequal', note: 'parents contributing 40% for one buyer' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(requirements(s).find((r) => r.id === 'deed_of_trust')?.applies, true);
  assert.ok(workstreams(s).some((w) => w.id === 'co_ownership'));
  await h.svc.run(TENANT, MATTER, { type: 'deed_of_trust_executed', actor: USER, parties: ['A', 'B'], shares: '60/40' });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'deed_of_trust_executed', actor: USER, parties: ['A', 'B'] }), /already executed/);
  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc(offerClear()));
  await h.svc.run(TENANT, MATTER, { type: 'mortgage_deed_executed', actor: USER, witnessed: true });
  await h.svc.run(TENANT, MATTER, { type: 'transfer_deed_executed', actor: USER, parties: ['A', 'B'] });
  s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.deeds.deedOfTrustAt && s.deeds.mortgageDeedAt && s.deeds.transferDeedAt);
  const mortgageDeed = requirements(s).find((r) => r.id === 'mortgage_deed');
  assert.equal(mortgageDeed?.advisory, true, 'advisory on a purchase: the lender\'s deed is signed at the same time as the contract in practice');
  // Single-party purchase: no co-ownership decision arises.
  const h2 = harness();
  await h2.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'freehold_purchase', hasLender: false, parties: 1, requireProofOfFunds: false, requireExchangeAuthority: false });
  await assert.rejects(h2.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'ownership_basis', decision: 'joint_tenants', note: 'x' }), /Only one client/);
  await assert.rejects(h2.svc.run(TENANT, MATTER, { type: 'deed_of_trust_executed', actor: USER, parties: ['A'] }), /Only one client/);
});
