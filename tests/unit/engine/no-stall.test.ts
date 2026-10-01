/**
 * No case stops by itself. A firm that works only from the Tasks list — doing what is on it and
 * nothing else — and outside parties who answer what they are asked must carry every kind of
 * case from instruction to a closed file. At every point the case has something moving it: a
 * task on the list (a decision, a due step, an issue of ours) or someone it is waiting on who is
 * being chased. A point where there is neither, and the file is not closed, is a stall: a step
 * that only moves when someone goes looking for a button in the flowchart.
 *
 * The conveyancer here never opens the case: every action it takes is one the Tasks list offers.
 */
import { test } from 'node:test';
import { position } from '../../../lib/server/engine/money';
import assert from 'node:assert/strict';
import { EngineService } from '../../../lib/server/engine/service';
import { MemoryEventStore } from '../../../lib/server/engine/store';
import { mockPorts } from '../../../lib/server/engine/mocks';
import { dueSteps } from '../../../lib/server/engine/due';
import { stageBlockers } from '../../../lib/server/engine/machine';
import { ISSUE_KIND_SPEC, RESOLUTION_FIELDS } from '../../../lib/server/engine/issues';
import { SHAPE_SPEC } from '../../../lib/server/engine/shapes';
import { profileOf } from '../../../lib/server/engine/transactions';
import { openIssues, openWaits, surfacedDecisions, type MatterState, type TransactionType } from '../../../lib/server/engine/types';
import * as F from '../../../lib/server/engine/scenarios/fixtures';
import { TENANT, MATTER, USER, SENIOR } from './helpers';
import { contractClear } from './helpers';

const PRICE = 30_000_000, ADVANCE = 22_500_000;

type Case = { id: string; tt: TransactionType; enrol: Record<string, unknown>; flagged?: boolean };
const CASES: Case[] = [
  { id: 'freehold purchase, mortgage', tt: 'freehold_purchase', enrol: { hasLender: true, requireProofOfFunds: false, requireExchangeAuthority: true, requiredSearches: ['LLC1', 'CON29'] } },
  { id: 'freehold purchase, cash', tt: 'freehold_purchase', enrol: { hasLender: false, requireProofOfFunds: false, requireExchangeAuthority: false, requiredSearches: ['LLC1'] } },
  { id: 'joint freehold purchase, mortgage', tt: 'freehold_purchase', enrol: { hasLender: true, parties: 2, requireProofOfFunds: false, requireExchangeAuthority: false, requiredSearches: ['LLC1'] } },
  { id: 'leasehold purchase, mortgage', tt: 'leasehold_purchase', enrol: { hasLender: true, requireProofOfFunds: false, requireExchangeAuthority: false, requiredSearches: ['LLC1'] } },
  { id: 'freehold sale, existing mortgage', tt: 'freehold_sale', enrol: { hasLender: false, hasExistingMortgage: true, requireExchangeAuthority: false, requiredSearches: [] } },
  { id: 'freehold sale, no mortgage', tt: 'freehold_sale', enrol: { hasLender: false, hasExistingMortgage: false, requireExchangeAuthority: false, requiredSearches: [] } },
  { id: 'leasehold sale, existing mortgage', tt: 'leasehold_sale', enrol: { hasLender: false, hasExistingMortgage: true, requireExchangeAuthority: false, requiredSearches: [] } },
  { id: 'remortgage', tt: 'remortgage', enrol: { hasLender: true, hasExistingMortgage: true } },
  { id: 'transfer of equity', tt: 'transfer_of_equity', enrol: { hasLender: false, hasExistingMortgage: true, parties: 2, considerationPennies: 5_000_000 } },
  // Proof of funds on, and everything that can be flagged, flagged: the ID refers, a search is adverse, the title has a charge, the offer has special conditions.
  { id: 'freehold purchase, mortgage, proof of funds, everything flagged', tt: 'freehold_purchase', flagged: true, enrol: { hasLender: true, requireProofOfFunds: true, requireExchangeAuthority: true, requiredSearches: ['LLC1', 'CON29'] } },
  { id: 'leasehold purchase, mortgage, everything flagged', tt: 'leasehold_purchase', flagged: true, enrol: { hasLender: true, requireProofOfFunds: true, requireExchangeAuthority: false, requiredSearches: ['LLC1'] } },
  { id: 'freehold sale, everything flagged', tt: 'freehold_sale', flagged: true, enrol: { hasLender: false, hasExistingMortgage: true, requireExchangeAuthority: true, requiredSearches: [] } },
  { id: 'remortgage, everything flagged', tt: 'remortgage', flagged: true, enrol: { hasLender: true, hasExistingMortgage: true } },
  // Every case shape on the transaction it belongs to.
  ...(['company_buyer', 'buy_to_let', 'new_build', 'auction', 'lifetime_isa', 'help_to_buy_isa', 'second_charge', 'shared_ownership', 'unrepresented_counterparty', 'right_to_buy', 'flying_freehold', 'commonhold'] as const).map((shape) => ({ id: `freehold purchase, ${shape.replace(/_/g, ' ')}`, tt: 'freehold_purchase' as const, enrol: { hasLender: true, requireProofOfFunds: false, requireExchangeAuthority: false, requiredSearches: ['LLC1'], shapes: [shape] } })),
  { id: 'transfer of equity, court order', tt: 'transfer_of_equity', enrol: { hasLender: false, hasExistingMortgage: true, parties: 2, considerationPennies: 0, shapes: ['court_order_transfer'] } },
];

/** What is moving the case now: tasks (ours) and waits (theirs, chased). */
function movers(s: MatterState, now: Date) {
  return {
    decisions: surfacedDecisions(s).filter((d) => d.status === 'pending'),
    due: dueSteps(s, now),
    issues: openIssues(s).filter((i) => !ISSUE_KIND_SPEC[i.kind]?.context),
    waits: openWaits(s),
  };
}

/** How the conveyancer answers a decision the first time it sees it: the default approves; an alternative is taken once, where offered, then approved when it comes back. */
type Policy = 'approve' | 'request_further' | 'reject' | 'escalate' | 'refer_to_client' | 'indemnity';

async function drive(c: Case, policy: Policy = 'approve') {
  const seen = new Set<string>();
  const store = new MemoryEventStore();
  const ports = mockPorts(new Date('2026-09-14T09:00:00Z'));
  const svc = new EngineService(store, ports);
  const log: string[] = [];
  const run = async (cmd: Record<string, unknown>) => { await svc.run(TENANT, MATTER, { actor: USER, ...cmd } as never); };
  const doc = (facts: unknown, docType = 'PDF') => ports.documents.seed({ tenantId: TENANT, matterId: MATTER, docType, extractedFacts: facts }).id;
  const state = () => svc.getState(TENANT, MATTER);
  const side = profileOf(c.tt).side;
  const buyer = side === 'buyer';

  await run({ type: 'enrol', transactionType: c.tt, targetExchangeDate: F.exchangeDate(), targetCompletionDate: F.completionDate(), ...c.enrol });
  if (c.tt.endsWith('_purchase')) await run({ type: 'record_price_change', toPennies: PRICE, reason: 'Agreed price' });

  /** Bank details the firm verifies when they arrive (a person's decision, on the list). */
  const verified = async (payeeKind: string): Promise<string> => {
    const s = await state();
    const have = Object.values(s.bankDetails).find((b) => b.payeeKind === payeeKind && b.status === 'verified');
    if (have) return have.id;
    const r = await svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind: payeeKind as never, payeeRef: payeeKind, details: { sortCode: '200000', accountNumber: String(10_000_000 + Math.floor(Math.random() * 89_999_999)), accountName: payeeKind, firmName: payeeKind }, sourceChannel: 'letter', sourceDocumentId: doc({ content: `${payeeKind} letter` }) });
    const d = Object.values(r.state.decisions).find((x) => x.kind === 'bank_details' && x.status === 'pending')!;
    await svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
    await svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'verify', 'called back', { method: 'phone_callback_known_number' });
    return (r.events[0].payload as { bankDetailsId: string }).bankDetailsId;
  };

  /** The conveyancer does one thing the Tasks list offers; outside parties answer one thing asked of them. Returns what was done, or null. */
  const act = async (s: MatterState, now: Date): Promise<string | null> => {
    const m = movers(s, now);
    // 1. A decision: approve (verify bank details, choose an option the decision offers).
    for (const d of m.decisions) {
      // Each redraft of the report is a new decision with a new id: it is the same thing to the conveyancer.
      // (so do proof-of-funds rounds and contract drafts: one round of the alternative, then the next is approved).
      const key = ['report_on_title', 'proof_of_funds', 'contract'].includes(d.kind) ? d.kind : `${d.kind}:${d.subject ?? ''}`;
      const alt = policy !== 'approve' && !seen.has(key) && d.options.includes(policy as never);
      seen.add(key);
      const option = alt ? policy : d.kind === 'bank_details' ? 'verify' : d.options.includes('approve' as never) ? 'approve' : d.options[0];
      // Whoever it is on the list of: an escalation's assignee, else the handler. Escalating names a senior.
      const by = d.assignedTo ?? USER;
      await svc.openDecisionSource(TENANT, MATTER, d.eventId, by);
      await svc.resolveDecision(TENANT, MATTER, d.eventId, by, option as never, 'done from the Tasks list', d.kind === 'bank_details' && option === 'verify' ? { method: 'phone_callback_known_number' } : null, null, null, null, option === 'escalate' ? (by === SENIOR ? USER : SENIOR) : null);
      return `decision ${d.kind}${d.subject ? ` (${d.subject})` : ''}: ${option}`;
    }
    // 2. A step due from us.
    for (const d of m.due) {
      const completion = s.exchange.completionDate ?? F.completionDate();
      const cmds: Record<string, () => Promise<unknown>> = {
        proof_of_funds_request: () => svc.requestProofOfFunds(TENANT, MATTER, USER),
        report_on_title_redraft: () => svc.draftReportOnTitle(TENANT, MATTER),
        official_copies: () => svc.titleReceived(TENANT, MATTER, doc(c.flagged ? F.titleWithCharge() : F.titleClear())),
        contract_pack: () => run({ type: 'contract_pack_sent' }),
        management_pack_sale: () => run({ type: 'management_pack_requested', from: 'Block Managers Ltd' }),
        contract_approved_sale: () => run({ type: 'contract_approved' }),
        contract_approve: () => run({ type: 'contract_approved' }),
        buyer_enquiries: () => run({ type: 'enquiry_replies_sent', enquiryIds: Object.values(s.inboundEnquiries ?? {}).filter((q) => !q.repliedAt).map((q) => q.id) }),
        exchange: () => run({ type: 'contracts_exchanged', completionDate: F.completionDate() }),
        completion_statement: () => run({ type: 'completion_statement_generated', documentId: doc({ content: 'statement' }) }),
        certificate_of_title: () => run({ type: 'certificate_of_title_sent', completionDate: completion }),
        bankruptcy_search: () => run({ type: 'bankruptcy_search_clear', subjects: s.partyNames?.length ? s.partyNames : ['Client'], documentId: doc({ content: 'K16' }) }),
        priority_search: () => run({ type: 'priority_search_made', expiresAt: F.completionDate(20), documentId: doc({ content: 'OS1' }) }),
        funds_request: async () => { const ours = await verified('firm_client_account'); const roles = [...profileOf(c.tt).fundsFrom, ...(s.shapes ?? []).map((sh) => SHAPE_SPEC[sh]?.fundsFrom).filter(Boolean)] as string[]; for (const from of roles.filter((f, i) => (f === 'client' || f === 'isa_provider') && roles.indexOf(f) === i).filter((f) => !s.waits.some((w) => w.key === 'funds' && w.subject === f))) await run({ type: 'funds_requested', fromRole: from as never, bankDetailsId: ours, ...(from === 'client' ? { amountPennies: PRICE - ((s.mortgage.facts as { amountPennies?: number } | null)?.amountPennies ?? (s.hasLender ? ADVANCE : 0)) } : {}) }); },
        advance_request: async () => run({ type: 'funds_requested', fromRole: 'lender', bankDetailsId: await verified('firm_client_account') }),
        completion_monies: () => run({ type: 'funds_received', fromRole: 'buyer_solicitor', amountPennies: PRICE }),
        consideration: () => run({ type: 'funds_received', fromRole: 'incoming_owner', amountPennies: 5_000_000 }),
        completion_payment: async () => run({ type: 'payment_authorised', payeeKind: 'seller_solicitor', bankDetailsId: await verified('seller_solicitor'), amountPennies: PRICE, purpose: 'completion_monies' }),
        redemption_payment: async () => run({ type: 'payment_authorised', payeeKind: 'lender', bankDetailsId: await verified('lender'), amountPennies: s.redemption.redemptionPennies ?? 1, purpose: 'other' }),
        completion: () => run({ type: 'completion_confirmed' }),
        balance_to_client: async () => run({ type: 'payment_authorised', payeeKind: 'client', bankDetailsId: await verified('client'), amountPennies: 1_000_000, purpose: 'other' }),
        mortgage_redeemed: () => run({ type: 'mortgage_redeemed' }),
        sdlt: () => run({ type: 'sdlt_submitted', reference: 'SDLT-1' }),
        ap1: () => run({ type: 'ap1_submitted' }),
        notice_of_assignment: () => run({ type: 'notice_of_assignment_served', servedOn: 'the landlord', reference: 'NOA-1' }),
        completion_payment_sent: () => run({ type: 'completion_payment_sent', reference: 'CHAPS-1' }),
        contributions: () => run({ type: 'record_contributions', model: 'CONTRIBUTION', contributions: (s.partyNames?.length ? s.partyNames : ['A', 'B']).map((n, i) => ({ party: n, pennies: (i + 1) * 1_000_000 })) }),
        register_check: () => run({ type: 'register_checked', lenderTold: true }),
        sdlt_facts: () => run({ type: 'record_sdlt_facts', mainResidence: true, anyEverOwned: true }),
        cgt_facts: () => run({ type: 'record_cgt_facts', mainResidenceThroughout: true, ukResident: true }),
        longstop_date: () => run({ type: 'longstop_date_recorded', date: F.completionDate(26) }),
        undertaking: () => run({ type: 'undertaking_given', to: "The buyer's solicitor", terms: 'To redeem every charge and send the discharges' }),
        completion_information: () => run({ type: 'completion_information_received', undertakingToRedeem: true, documentId: doc({ content: 'TA13 replies' }) }),
        undertaking_discharge: () => run({ type: 'undertaking_discharged' }),
        close_file: () => run({ type: 'close_matter' }),
      };
      // Money steps carry what they are about in the key (engine/money.ts).
      const [head, arg] = [d.key.slice(0, d.key.indexOf(':')), d.key.slice(d.key.indexOf(':') + 1)];
      const money: Record<string, () => Promise<unknown>> = {
        shortfall_request: async () => run({ type: 'funds_requested', fromRole: 'client', bankDetailsId: await verified('firm_client_account'), amountPennies: Number(arg) }),
        funds_cleared: () => run({ type: 'funds_cleared', receiptId: arg }),
        refund: () => run({ type: 'refund_paid', refundId: arg, reference: 'FPS-1' }),
        charge_statement: () => run({ type: 'charge_statement_received', chargeId: arg, redemptionPennies: 500_000, validUntil: F.completionDate(5) }),
        charge_redeemed: () => run({ type: 'charge_redeemed', chargeId: arg }),
      };
      const f = d.key.startsWith('resend:') ? () => svc.retryFailedAction(TENANT, MATTER, d.key.slice('resend:'.length), USER) : d.key.includes(':') ? money[head] : cmds[d.key];
      if (!f) throw new Error(`due step "${d.key}" has no action on the Tasks list`);
      await f();
      return `step ${d.key}`;
    }
    // 3. An issue of ours: resolved with an outcome its kind allows, with what the form asks for.
    for (const i of m.issues) {
      const spec = ISSUE_KIND_SPEC[i.kind];
      if (!['conveyancer', 'mlro'].includes(spec.responsible) && !(spec.responsible === 'seller_side' && side === 'seller') && !(i.resolveBy && i.resolveBy < now.toISOString().slice(0, 10))) continue;
      const resolution = spec.resolutions.find((r) => r !== 'other' && r !== 'accepted_as_is' && r !== 'price_reduced' && r !== 'new_lender') ?? 'other';
      const details: Record<string, unknown> = {};
      const cmd: Record<string, unknown> = { type: 'resolve_issue', issueId: i.id, resolution, note: 'Dealt with' };
      for (const fld of RESOLUTION_FIELDS[resolution]) {
        if (!fld.required) continue;
        if (fld.key === 'documentId') cmd.documentId = doc({ content: 'evidence' });
        else if (fld.key === 'cost') cmd.costPennies = 10_000;
        else if (fld.key === 'paidBy') cmd.paidBy = 'seller';
        else details[fld.key] = fld.type === 'date' ? F.completionDate() : fld.type === 'money' ? 100 : fld.type === 'confirm' ? true : 'x';
      }
      if (Object.keys(details).length) cmd.details = details;
      await run(cmd);
      return `issue ${i.kind} resolved (${resolution})`;
    }
    // 4. Someone we are waiting on answers.
    for (const w of m.waits) {
      const answer: Record<string, () => Promise<unknown>> = {
        id_check: () => svc.idCheckResultReceived(TENANT, MATTER, doc(c.flagged ? F.idRefer() : F.idClear()), w.subject || null),
        search: () => svc.searchReturned(TENANT, MATTER, w.subject as never, doc(c.flagged ? F.searchFlagged(w.subject as never) : F.searchClear(w.subject as never))),
        enquiry: () => svc.enquiryReplyReceived(TENANT, MATTER, w.subject, doc(F.replyClear(w.subject))),
        // The lender sends the simulator's advance, which may be short of the offer: the client is then asked for the rest and sends what was asked.
        funds: () => run({ type: 'funds_received', fromRole: w.subject, amountPennies: w.subject === 'lender' ? ADVANCE : position(s).shortfallPennies || (s.money?.requested?.[w.subject as 'client'] != null ? s.money.requested[w.subject as 'client']! - (s.money.received[w.subject as 'client'] ?? 0) : PRICE - ADVANCE) }),
        registration: () => run({ type: 'ap1_confirmed' }),
        management_pack: () => svc.managementPackReceived(TENANT, MATTER, doc(F.managementPack(false))),
        property_forms: () => svc.propertyFormsReceived(TENANT, MATTER, doc(F.propertyForms(false, c.tt.startsWith('leasehold')))),
        redemption: () => run({ type: 'redemption_statement_received', redemptionPennies: 12_000_000, validUntil: F.completionDate(5) }),
        lender_consent: () => run({ type: 'lender_consent_received', conditions: 'Outgoing borrower released' }),
        seller_discharge: () => run({ type: 'seller_discharge_received', reference: 'DS1' }),
        discharge: () => (w.subject ? run({ type: 'charge_discharged', chargeId: w.subject, reference: 'DS1' }) : run({ type: 'discharge_confirmed', reference: 'DS1' })),
        contract_pack: async () => {
          if (s.title.status === 'awaiting') await svc.titleReceived(TENANT, MATTER, doc(c.flagged ? F.titleWithCharge() : F.titleClear()));
          if (!s.readiness.contractDocumentId) await svc.contractReceived(TENANT, MATTER, doc(contractClear()));
          if (buyer && s.propertyForms.status !== 'received' && s.propertyForms.status !== 'not_required') await svc.propertyFormsReceived(TENANT, MATTER, doc(F.propertyForms(false, c.tt.startsWith('leasehold')))).catch(() => null);
          if (c.tt === 'leasehold_purchase') await svc.leaseReceived(TENANT, MATTER, doc(F.lease(false))).catch(() => null);
        },
        signed_documents: async () => {
          const signed = (d: string) => (d === 'contract' ? s.readiness.signedContractHeldAt : d === 'transfer' ? s.deeds.transferDeedAt : d === 'mortgage_deed' ? s.deeds.mortgageDeedAt : s.deeds.deedOfTrustAt);
          const d = s.signing.documents.find((x) => !signed(x));
          if (!d) throw new Error('signed_documents wait open with every deed signed');
          const cmd = d === 'contract' ? { type: 'signed_contract_held', documentId: doc({ content: 'signed contract' }) } : d === 'transfer' ? { type: 'transfer_deed_executed', parties: s.partyNames?.length ? s.partyNames : ['Client'] } : d === 'mortgage_deed' ? { type: 'mortgage_deed_executed', witnessed: true } : { type: 'deed_of_trust_executed', parties: s.partyNames, shares: '50/50' };
          await run(cmd);
        },
        transfer_deed: () => run({ type: 'transfer_deed_executed', parties: ['The seller'] }),
        mortgage_offer: () => svc.mortgageOfferReceived(TENANT, MATTER, doc(c.flagged ? F.offerSpecial() : F.offerClear())),
        survey: () => run({ type: 'record_survey_plan', plan: 'none' }),
        deposit: () => run({ type: 'deposit_received', amountPennies: PRICE / 10 }),
        client_decision: () => run({ type: 'client_decision_recorded', subject: w.subject, decision: w.subject === 'exchange_authority' ? 'authorised' : 'joint_tenants', note: 'Confirmed by the client in writing' }),
        insurance: () => run({ type: 'buildings_insurance_confirmed', insurer: 'Insurer plc', fromDate: F.exchangeDate() }),
        proof_of_funds: async () => {
          const balance = PRICE - (s.hasLender ? ADVANCE : 0);
          const st = doc(F.statement('The Buyer', balance), 'BANK_STATEMENT');
          const sub = F.pofSubmission(PRICE, s.hasLender ? ADVANCE : null, false, st, null, null);
          const open = (s.proofOfFunds.queries ? Object.values(s.proofOfFunds.queries) : []).filter((q) => q.status === 'sent');
          await svc.proofOfFundsSubmitted(TENANT, MATTER, s.proofOfFunds.requestId!, open.length ? { ...sub, round: 2, answers: open.map((q) => ({ queryId: q.id, answer: 'Explained and evidenced.', evidenceDocumentIds: [st] })) } : sub, { [st]: 'statement.txt' });
        },
        funds_isa: () => run({ type: 'funds_received', fromRole: 'isa_provider', amountPennies: 100_000 }),
      };
      const f = answer[w.key];
      if (!f) throw new Error(`wait "${w.key}" has no answer here`);
      await f();
      return `answered wait ${w.key}${w.subject ? ` (${w.subject})` : ''}`;
    }
    return null;
  };

  for (let i = 0; i < 300; i++) {
    const s = await state();
    if (s.closedAt) return { closed: true, log };
    const now = ports.now();
    let did: string | null;
    try { did = await act(s, now); }
    catch (err) { return { closed: false, log, stall: `at ${s.stage}: ${(err as Error).message}`, blockers: stageBlockers(s) }; }
    if (did) { log.push(`${s.stage}: ${did}`); continue; }
    // Nothing on the list and nothing waited on: give the timers a day (chases, expectations), then look again.
    ports.setNow(new Date(now.getTime() + 86_400_000));
    await svc.tick(TENANT, MATTER);
    const after = await state();
    const m = movers(after, ports.now());
    if (!m.decisions.length && !m.due.length && !m.issues.length && !m.waits.length && !after.closedAt) {
      return { closed: false, log, stall: `at ${after.stage}: nothing on the Tasks list and nothing being waited on`, blockers: stageBlockers(after) };
    }
  }
  return { closed: false, log, stall: 'ran 300 actions without closing', blockers: stageBlockers(await state()) };
}

for (const c of CASES) for (const policy of ['approve', 'request_further', 'reject', 'escalate', 'refer_to_client', 'indemnity'] as Policy[]) {
  test(`no stall: a ${c.id}${policy === 'approve' ? '' : ` (each decision first answered ${policy.replace(/_/g, ' ')})`} runs from instruction to a closed file on the Tasks list alone`, async () => {
    const r = await drive(c, policy);
    if (!r.closed && process.env.STALL_LOG) console.log(r.log.join('\n'));
    assert.ok(r.closed, `${c.id} stalled ${r.stall}\n  blockers: ${(r.blockers ?? []).join('; ') || '(none)'}\n  last: ${r.log.slice(-6).join(' | ')}`);
  });
}
