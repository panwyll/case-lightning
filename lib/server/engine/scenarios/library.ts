/**
 * The scenario library: one scripted case per transaction type, driven through the real
 * engine on a sandbox matter (sandbox.ts) so a person can walk every stage of the
 * flowchart on the real screens. Each step is one thing that happens on a case; a run can
 * stop at any step, and the flagged variant takes the branch where the rules find something
 * and a person has to decide. Documents are fixture facts with a plain-text body marked as
 * sandbox material; Claude never reads them. Timers run on the real clock, so chases are
 * not part of a script.
 */
import type { EngineService } from '../service';
import type { CaseShape } from '../shapes';
import { openPofQueries, type DecisionKind, type DecisionOption, type TransactionType } from '../types';
import * as F from './fixtures';

export interface ScenarioContext {
  svc: EngineService;
  tenantId: string;
  matterId: string;
  userId: string;
  flagged: boolean;
  /** File a fixture document: typed facts the fixture extractor hands back, and a body the source pane shows. */
  doc(input: { docType: string; fileName: string; facts: unknown; body: string }): Promise<string>;
  /** Resolve the first pending decision of a kind the honest way (open the source, then choose). */
  resolve(kind: DecisionKind, option: DecisionOption, note?: string): Promise<void>;
  /** Record and verify bank details for a payee; returns the bankDetailsId. */
  verifiedDetails(payeeKind: 'lender' | 'client' | 'firm_client_account' | 'seller_solicitor', account: string, name: string): Promise<string>;
  run(cmd: Record<string, unknown>): Promise<void>;
  /** Approve the engine's own pending proposals (auto-clears, orders), as the person would at Propose. */
  settle(): Promise<void>;
}

export interface ScenarioStep {
  id: string;
  label: string;
  /** Only in the flagged run. */
  flaggedOnly?: boolean;
  /** Only in the clean run. */
  cleanOnly?: boolean;
  /** A person's decision of this kind: in stepping mode the script leaves it to the person under Tasks. */
  decision?: DecisionKind;
  run(ctx: ScenarioContext): Promise<void>;
}

export interface Scenario {
  id: string;
  label: string;
  transactionType: TransactionType;
  /** Shapes this scenario is enrolled with (the enrol step reads them). */
  shapes?: CaseShape[];
  hasLender: boolean;
  summary: string;
  steps: ScenarioStep[];
}

const step = (id: string, label: string, run: ScenarioStep['run'], opts: Partial<Pick<ScenarioStep, 'flaggedOnly' | 'cleanOnly' | 'decision'>> = {}): ScenarioStep => ({ id, label, run, ...opts });

// ── shared steps ──
const idCheck = (): ScenarioStep[] => [
  step('id_request', 'ID / AML check requested', async (c) => { await c.svc.requestIdCheck(c.tenantId, c.matterId, c.userId); }),
  step('id_result', 'ID / AML result received', async (c) => {
    const doc = await c.doc({ docType: 'ID_CHECK', fileName: 'id-check-result.txt', facts: c.flagged ? F.idRefer() : F.idClear(), body: F.body('ID / AML check result', c.flagged ? ['Outcome: REFER', 'Possible PEP match on one applicant'] : ['Outcome: CLEAR', 'Identity verified electronically; no PEP or sanctions match']) });
    await c.svc.idCheckResultReceived(c.tenantId, c.matterId, doc);
  }),
  step('id_decision', 'The referred ID check is decided by a person', async (c) => { await c.resolve('id_check', 'approve', 'PEP match reviewed: different date of birth; enhanced due diligence recorded.'); }, { flaggedOnly: true, decision: 'id_check' }),
];

const searches = (types: F.SearchTypeLike[]): ScenarioStep[] => [
  // At Propose the engine proposes each order rather than placing it; the sandbox records the orders as placed so the results can arrive.
  step('searches_ordered', 'Searches ordered', async (c) => {
    const s = await c.svc.getState(c.tenantId, c.matterId);
    for (const t of types) if (!s.searches[t]) await c.run({ type: 'record_search_ordered', searchType: t, provider: 'Sandbox search provider', reference: `SBX-${t}` });
  }),
  ...types.map((t) => step(`search_${t.toLowerCase()}`, `${t} search result returned`, async (c) => {
    const flagged = c.flagged && t === 'CON29';
    const doc = await c.doc({ docType: `SEARCH_${t}`, fileName: `${t}-search-result.txt`, facts: flagged ? F.searchFlagged(t) : F.searchClear(t), body: F.body(`${t} search result`, flagged ? ['3.7 Enforcement notice registered 2024 re: rear extension'] : ['No adverse entries', 'Road adopted and maintained at public expense']) });
    await c.svc.searchReturned(c.tenantId, c.matterId, t, doc);
  })),
  step('search_decision', 'The flagged CON29 is decided by a person', async (c) => { await c.resolve('search', 'approve', 'Enforcement notice relates to the previous owner; indemnity policy to be obtained.'); }, { flaggedOnly: true, decision: 'search' }),
];

const mortgage = (): ScenarioStep[] => [
  step('offer', 'Mortgage offer received', async (c) => {
    const doc = await c.doc({ docType: 'MORTGAGE_OFFER', fileName: 'mortgage-offer.txt', facts: c.flagged ? F.offerSpecial() : F.offerClear(), body: F.body('Mortgage offer', ['Lender: Mock Building Society', 'Advance: £250,000.00', 'Offer expires: 1 March 2027', ...(c.flagged ? ['Special condition 4: retention of £5,000 pending roof repairs'] : [])]) });
    await c.svc.mortgageOfferReceived(c.tenantId, c.matterId, doc);
  }),
  step('offer_decision', 'The special condition is decided by a person', async (c) => { await c.resolve('mortgage', 'approve', 'Retention noted; roof quote obtained and reported to the lender.'); }, { flaggedOnly: true, decision: 'mortgage' }),
];

const title = (leasehold: boolean): ScenarioStep[] => [
  step('title', 'Official copies received', async (c) => {
    const facts = leasehold ? { ...F.titleClear(), tenure: 'leasehold' as const, ...(c.flagged ? { lease: F.leaseShort() } : {}) } : c.flagged ? F.titleWithCharge() : F.titleClear();
    const doc = await c.doc({ docType: 'TITLE', fileName: 'official-copy-of-the-register.txt', facts, body: F.body('Official copy of the register', ['Title number AB123456', `Tenure: ${leasehold ? 'leasehold' : 'freehold'}`, ...(c.flagged && !leasehold ? ['C1 Registered charge dated 12 May 2019 in favour of Big Bank plc'] : []), ...(c.flagged && leasehold ? ['Lease: 78 years unexpired; ground rent £350 a year doubling every 10 years'] : [])]) });
    await c.svc.titleReceived(c.tenantId, c.matterId, doc);
  }),
  step('title_decision', 'The title entries are decided by a person', async (c) => { await c.resolve('title', 'approve', leasehold ? 'Short lease and doubling rent reported to the client and lender; extension to be negotiated.' : 'Registered charge: undertaking to discharge on completion.'); }, { flaggedOnly: true, decision: 'title' }),
];

const enquiries = (): ScenarioStep[] => [
  step('enquiry_raise', 'Enquiries raised with the seller\'s solicitor', async (c) => {
    await c.run({ type: 'raise_enquiry', enquiryId: 'E1', subject: 'Please confirm the boiler service history and provide the last gas safety certificate.' });
    await c.run({ type: 'raise_enquiry', enquiryId: 'E2', subject: 'Please confirm who maintains the rear boundary fence.' });
  }),
  step('enquiry_replies', 'Replies to enquiries received', async (c) => {
    for (const id of ['E1', 'E2']) {
      const partial = c.flagged && id === 'E2';
      const doc = await c.doc({ docType: 'ENQUIRY_REPLY', fileName: `reply-${id}.txt`, facts: partial ? F.replyPartial(id) : F.replyClear(id), body: F.body(`Reply to enquiry ${id}`, [partial ? 'The seller does not know who maintains the fence.' : 'Answered in full; documents enclosed.']) });
      await c.svc.enquiryReplyReceived(c.tenantId, c.matterId, id, doc);
    }
  }),
  step('enquiry_decision', 'The partial reply is decided by a person', async (c) => { await c.resolve('enquiry', 'approve', 'Boundary responsibility accepted as unknown; client advised.'); }, { flaggedOnly: true, decision: 'enquiry' }),
];

const reportOnTitle = (): ScenarioStep[] => [
  step('report_draft', 'Report on title drafted', async (c) => { await c.svc.draftReportOnTitle(c.tenantId, c.matterId); }),
  step('report_approve', 'Report on title approved by a person', async (c) => { await c.resolve('report_on_title', 'approve', 'Checked against the register and the searches.'); }, { decision: 'report_on_title' }),
  step('report_send', 'Report on title sent to the client', async (c) => { await c.svc.sendReportOnTitle(c.tenantId, c.matterId, c.userId); }),
];

const proofOfFunds = (price: number, advance: number | null): ScenarioStep[] => [
  step('pof_request', 'Proof of funds requested from the client', async (c) => {
    // The engine sends the form itself when the ID check clears (trust level permitting); the script only asks when nothing has gone out.
    const s = await c.svc.getState(c.tenantId, c.matterId);
    if (s.proofOfFunds.status !== 'not_started') return;
    await c.svc.requestProofOfFunds(c.tenantId, c.matterId, c.userId, { noteToClient: 'Please attach three months of statements for each account.' });
  }),
  step('pof_submit', 'The client submits the proof-of-funds form', async (c) => {
    const s = await c.svc.getState(c.tenantId, c.matterId);
    if (!s.proofOfFunds.requestId) throw new Error('No proof-of-funds request on the case.');
    const balance = price - (advance ?? 0);
    const gift = c.flagged ? 4_000_000 : 0;
    const statement = await c.doc({ docType: 'BANK_STATEMENT', fileName: 'savings-statement.txt', facts: F.statement('Sandbox Buyer', balance - gift), body: F.body('Bank statement', ['Sandbox Savings Bank · Sandbox Buyer', 'Three months of salary credits', `Closing balance £${((balance - gift) / 100).toLocaleString('en-GB')}`]) });
    const donor = c.flagged ? await c.doc({ docType: 'BANK_STATEMENT', fileName: 'donor-statement.txt', facts: F.statement('Sandbox Donor & Sandbox Donor Two', gift), body: F.body('Bank statement', ['Sandbox Savings Bank · Sandbox Donor & Sandbox Donor Two (joint account)', `Closing balance £${(gift / 100).toLocaleString('en-GB')}`]) }) : null;
    const letter = c.flagged ? await c.doc({ docType: 'GIFT_LETTER', fileName: 'gift-letter.txt', facts: { content: 'sandbox gift letter' }, body: F.body('Gift letter', ['I, Sandbox Donor, gift £40,000 to my child. Not repayable. No interest in the property.']) }) : null;
    await c.svc.proofOfFundsSubmitted(c.tenantId, c.matterId, s.proofOfFunds.requestId, F.pofSubmission(price, advance, c.flagged, statement, donor, letter), { [statement]: 'savings-statement.txt', ...(donor ? { [donor]: 'donor-statement.txt' } : {}), ...(letter ? { [letter]: 'gift-letter.txt' } : {}) });
  }),
  step('pof_queries', 'Queries sent to the client and answered', async (c) => {
    const s = await c.svc.getState(c.tenantId, c.matterId);
    const open = openPofQueries(s).filter((q) => q.status === 'draft' || q.status === 'sent');
    if (!open.length) return;
    // The conveyancer asks for more: the sign-off decision is resolved with "request further", which re-opens the form with the queries on it (in stepping mode the person has already done this under Tasks).
    const { blockingDecisions } = await import('../types');
    if (blockingDecisions(s).some((d) => d.kind === 'proof_of_funds')) await c.resolve('proof_of_funds', 'request_further', 'Queries sent to the client with the form.');
    let after = await c.svc.getState(c.tenantId, c.matterId);
    if (after.proofOfFunds.status !== 'requested') { await c.svc.requestProofOfFunds(c.tenantId, c.matterId, c.userId, { followUpOf: s.proofOfFunds.requestId }); after = await c.svc.getState(c.tenantId, c.matterId); }
    const requestId = after.proofOfFunds.requestId;
    if (!requestId) throw new Error('No follow-up request id.');
    const balance = price - (advance ?? 0);
    const gift = c.flagged ? 4_000_000 : 0;
    const statement = await c.doc({ docType: 'BANK_STATEMENT', fileName: 'savings-statement-round-2.txt', facts: F.statement('Sandbox Buyer', balance - gift), body: F.body('Bank statement', ['Round 2']) });
    // Round 2 keeps what round 1 attached for the gift (as the client form does): the donors' statement, and the letter again.
    const donorDoc = s.proofOfFunds.facts?.sources.find((x) => x.kind === 'gift')?.gift?.donorEvidenceDocumentIds?.[0] ?? null;
    const letter = c.flagged ? await c.doc({ docType: 'GIFT_LETTER', fileName: 'gift-letter-signed-by-both.txt', facts: { content: 'sandbox gift letter' }, body: F.body('Gift letter', ['We, Sandbox Donor and Sandbox Donor Two, gift £40,000 from our joint account to our child. Not repayable. No interest in the property.']) }) : null;
    const sub = F.pofSubmission(price, advance, c.flagged, statement, donorDoc, letter);
    await c.svc.proofOfFundsSubmitted(c.tenantId, c.matterId, requestId, { ...sub, round: 2, answers: open.map((q) => ({ queryId: q.id, answer: 'Sandbox answer: explained and evidenced.', evidenceDocumentIds: [statement] })) }, { [statement]: 'savings-statement-round-2.txt', ...(donorDoc ? { [donorDoc]: 'donor-statement.txt' } : {}), ...(letter ? { [letter]: 'gift-letter-signed-by-both.txt' } : {}) });
  }),
  step('donor_id', 'The gift donors\' ID / AML results received (the gift comes from a joint account: both holders are donors)', async (c) => {
    const s = await c.svc.getState(c.tenantId, c.matterId);
    const donors = Object.values(s.partyChecks).filter((pc) => pc.role === 'donor');
    if (donors.length < 2) throw new Error(`The declared gift from a joint account should add both holders as donors; found ${donors.length}.`);
    for (const donor of donors) {
      if (donor.status === 'not_started') await c.run({ type: 'request_id_check', provider: 'sandbox-id', party: donor.party });
      const doc = await c.doc({ docType: 'ID_CHECK', fileName: `id-check-result-${donor.party.replace(/^donor:/, '')}.txt`, facts: F.idClear(), body: F.body('ID / AML check result — donor', [`Subject: ${donor.label}`, 'Outcome: CLEAR']) });
      await c.svc.idCheckResultReceived(c.tenantId, c.matterId, doc, donor.party);
    }
  }, { flaggedOnly: true }),
  step('pof_signoff', 'Proof of funds signed off by a person', async (c) => { await c.resolve('proof_of_funds', 'approve', c.flagged ? 'Gift evidenced: donor ID, letter and statements on file; lender told.' : 'Savings evidenced over the period.'); }, { decision: 'proof_of_funds' }),
  step('pof_lender', 'The lender confirms the gifted deposit', async (c) => {
    const s = await c.svc.getState(c.tenantId, c.matterId);
    for (const i of Object.values(s.issues).filter((i) => i.kind === 'lender_approval' && (i.status === 'open' || i.status === 'negotiating'))) {
      await c.run({ type: 'resolve_issue', issueId: i.id, resolution: 'lender_confirmed', note: 'Lender told of the gift; offer confirmed to stand.' });
    }
  }, { flaggedOnly: true }),
];

const exchangeBuyer = (price: number, deposit: number, advance: number | null): ScenarioStep[] => [
  step('deposit', 'Deposit received on client account', async (c) => { await c.run({ type: 'deposit_received', amountPennies: deposit }); }),
  step('authority', 'The client authorises exchange', async (c) => { await c.run({ type: 'client_decision_recorded', subject: 'exchange_authority', decision: 'authorised', note: 'Authority given by email after the report on title.' }); }),
  step('exchange', 'Contracts exchanged', async (c) => { await c.run({ type: 'contracts_exchanged', completionDate: F.completionDate() }); }),
  step('statement', 'Completion statement drafted and produced', async (c) => {
    const { documentId } = await c.svc.draftCompletionStatement(c.tenantId, c.matterId);
    await c.run({ type: 'completion_statement_generated', documentId });
  }),
  ...(advance != null ? [
    step('mortgage_deed', 'Mortgage deed executed and witnessed', async (c) => { await c.run({ type: 'mortgage_deed_executed', witnessed: true }); }),
    step('certificate', 'Certificate of title sent to the lender', async (c) => { await c.run({ type: 'certificate_of_title_sent', completionDate: F.completionDate() }); }),
  ] : []),
  step('transfer_deed', 'Transfer deed (TR1) executed', async (c) => { await c.run({ type: 'transfer_deed_executed', parties: ['Sandbox Buyer'] }); }),
  step('funds', advance != null ? 'Advance and the client\'s balance requested and received' : 'The client\'s balance requested and received', async (c) => {
    const ours = await c.verifiedDetails('firm_client_account', '99990000', 'Firm client account');
    const balance = price - deposit - (advance ?? 0);
    if (advance != null) {
      await c.run({ type: 'funds_requested', fromRole: 'lender', bankDetailsId: ours, amountPennies: advance });
      await c.run({ type: 'funds_received', fromRole: 'lender', amountPennies: advance });
    }
    await c.run({ type: 'funds_requested', fromRole: 'client', bankDetailsId: ours, amountPennies: balance });
    await c.run({ type: 'funds_received', fromRole: 'client', amountPennies: balance });
  }),
  step('pay_seller', 'Completion monies authorised against verified seller\'s-solicitor details', async (c) => {
    const theirs = await c.verifiedDetails('seller_solicitor', '11112222', 'Seller Solicitors LLP client account');
    await c.run({ type: 'payment_authorised', payeeKind: 'seller_solicitor', bankDetailsId: theirs, amountPennies: price - deposit, purpose: 'completion_monies' });
  }),
  step('complete', 'Completion confirmed', async (c) => { await c.run({ type: 'completion_confirmed' }); }),
  step('sdlt', 'SDLT return submitted', async (c) => { await c.run({ type: 'sdlt_submitted', reference: 'SDLT-SANDBOX-1' }); }),
  step('ap1', 'AP1 submitted to HM Land Registry', async (c) => { await c.run({ type: 'ap1_submitted', reference: 'AP1-SANDBOX-1' }); }),
  step('registered', 'Registration confirmed', async (c) => { await c.run({ type: 'ap1_confirmed' }); }),
  step('close', 'Matter closed', async (c) => { await c.run({ type: 'close_matter' }); }),
];

const PRICE = 38_500_000;
const DEPOSIT = 3_850_000;
const ADVANCE = 25_000_000;

export const SCENARIOS: Scenario[] = [
  {
    id: 'freehold_purchase', label: 'Freehold Purchase', transactionType: 'freehold_purchase', hasLender: true,
    summary: 'A buyer with a mortgage: ID, four searches, the offer, the title, enquiries, the report on title, exchange, completion, SDLT and registration.',
    steps: [
      step('enrol', 'Enrolled as a freehold purchase with a lender', async (c) => { await c.run({ type: 'enrol', transactionType: 'freehold_purchase', hasLender: true, requireProofOfFunds: true, requireExchangeAuthority: true, requiredSearches: ['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL'], targetExchangeDate: F.exchangeDate(), targetCompletionDate: F.completionDate() }); await c.run({ type: 'record_price_change', toPennies: PRICE, reason: 'Agreed price per memorandum of sale' }); }),
      ...idCheck(),
      ...proofOfFunds(PRICE, ADVANCE),
      ...searches(['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL']),
      ...mortgage(),
      ...title(false),
      ...enquiries(),
      ...reportOnTitle(),
      ...exchangeBuyer(PRICE, DEPOSIT, ADVANCE),
    ],
  },
  {
    id: 'leasehold_purchase', label: 'Leasehold Purchase', transactionType: 'leasehold_purchase', hasLender: true,
    summary: 'A flat with a mortgage: the management pack and the lease join the purchase; notice of assignment after completion.',
    steps: [
      step('enrol', 'Enrolled as a leasehold purchase with a lender', async (c) => { await c.run({ type: 'enrol', transactionType: 'leasehold_purchase', hasLender: true, requireProofOfFunds: true, requireExchangeAuthority: true, requiredSearches: ['LLC1', 'CON29'], targetExchangeDate: F.exchangeDate(), targetCompletionDate: F.completionDate() }); await c.run({ type: 'record_price_change', toPennies: PRICE, reason: 'Agreed price per memorandum of sale' }); }),
      ...idCheck(),
      ...proofOfFunds(PRICE, ADVANCE),
      ...searches(['LLC1', 'CON29']),
      step('pack_request', 'Management pack requested from the managing agent', async (c) => { await c.run({ type: 'management_pack_requested', from: 'Block Managers Ltd' }); }),
      step('pack', 'Management pack (LPE1) received and read', async (c) => {
        const doc = await c.doc({ docType: 'MANAGEMENT_PACK', fileName: 'LPE1-management-pack.txt', facts: F.managementPack(c.flagged), body: F.body('Leasehold information (LPE1)', ['Service charge £2,400 a year (1 April 2026 to 31 March 2027)', 'Ground rent £350 a year', 'Reserve fund £12,000', ...(c.flagged ? ['Major works: roof renewal 2027, estimated £48,000; section 20 consultation started'] : ['No major works planned']), 'Buildings insurance in place with Aviva to 28 February 2027']) });
        await c.svc.managementPackReceived(c.tenantId, c.matterId, doc);
      }),
      step('pack_decision', 'The management pack is decided by a person', async (c) => { await c.resolve('management_pack', c.flagged ? 'refer_to_client' : 'approve', c.flagged ? 'Major works: client advised; retention to be negotiated.' : 'Pack in order.'); }, { decision: 'management_pack' }),
      step('lease', 'The lease received and read', async (c) => {
        const doc = await c.doc({ docType: 'LEASE', fileName: 'lease.txt', facts: F.lease(c.flagged), body: F.body('Lease', ['Term: 125 years from 1 January 1998', c.flagged ? 'Rent: £350 a year, doubling every 10 years' : 'Rent: £250 a year, fixed', 'Lessee repairs the interior; lessor repairs the structure and roof', 'Not to assign without the lessor\'s prior written consent, not to be unreasonably withheld']) });
        await c.svc.leaseReceived(c.tenantId, c.matterId, doc);
      }),
      step('lease_decision', 'The lease terms are decided by a person', async (c) => { await c.resolve('title', 'approve', 'Doubling rent: deed of variation to be obtained; lender content.'); }, { flaggedOnly: true, decision: 'title' }),
      ...mortgage(),
      ...title(true),
      ...enquiries(),
      ...reportOnTitle(),
      ...exchangeBuyer(PRICE, DEPOSIT, ADVANCE).filter((s) => s.id !== 'close'),
      step('notice', 'Notice of assignment served on the landlord', async (c) => { await c.run({ type: 'notice_of_assignment_served', servedOn: 'Block Managers Ltd for Mill Lane Freeholds Limited', reference: 'NOA-1' }); }),
      step('close', 'Matter closed', async (c) => { await c.run({ type: 'close_matter' }); }),
    ],
  },
  {
    id: 'freehold_sale', label: 'Freehold Sale', transactionType: 'freehold_sale', hasLender: false,
    summary: 'A seller with a mortgage to redeem: property forms, the title, the contract pack, the buyer\'s enquiries, the redemption figure, exchange, completion, redemption and discharge.',
    steps: [
      step('enrol', 'Enrolled as a freehold sale with an existing mortgage', async (c) => { await c.run({ type: 'enrol', transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: true, requireExchangeAuthority: false, targetExchangeDate: F.exchangeDate(), targetCompletionDate: F.completionDate() }); }),
      ...idCheck(),
      step('forms_request', 'Property forms requested from the client', async (c) => { await c.run({ type: 'request_property_forms' }); }),
      step('forms', 'Property forms received (TA6, TA10)', async (c) => { await c.run({ type: 'property_forms_received', forms: ['TA6', 'TA10'] }); }),
      step('title', 'Official copies received (with the charge to redeem)', async (c) => {
        const doc = await c.doc({ docType: 'TITLE', fileName: 'official-copy-of-the-register.txt', facts: F.titleWithCharge(), body: F.body('Official copy of the register', ['Title number AB123456', 'Tenure: freehold', 'C1 Registered charge dated 12 May 2019 in favour of Big Bank plc']) });
        await c.svc.titleReceived(c.tenantId, c.matterId, doc);
      }),
      step('title_decision', 'The registered charge is decided by a person', async (c) => { await c.resolve('title', 'approve', 'Registered charge: to be redeemed on completion.'); }, { decision: 'title' }),
      step('pack', 'Contract pack sent to the buyer\'s solicitor', async (c) => { await c.run({ type: 'contract_pack_sent' }); }),
      step('buyer_enquiries', 'The buyer\'s enquiries received', async (c) => { await c.run({ type: 'buyer_enquiries_received', enquiries: [{ question: 'Please confirm the boiler service history.' }, { id: 'BE-Boundary', question: 'Who maintains the rear fence?' }] }); }),
      step('replies', 'Replies sent to the buyer\'s enquiries', async (c) => { await c.run({ type: 'enquiry_replies_sent', enquiryIds: ['BE1', 'BE-Boundary'] }); }),
      step('redemption_request', 'Redemption statement requested from the lender', async (c) => { await c.run({ type: 'request_redemption_statement', lender: 'Big Bank plc' }); }),
      step('redemption', 'Redemption statement received', async (c) => { await c.run({ type: 'redemption_statement_received', redemptionPennies: 18_250_000, validUntil: F.completionDate(3), dailyInterestPennies: 2_100 }); }),
      step('exchange', 'Contracts exchanged', async (c) => { await c.run({ type: 'contracts_exchanged', completionDate: F.completionDate() }); }),
      step('statement', 'Completion statement drafted and produced', async (c) => { const { documentId } = await c.svc.draftCompletionStatement(c.tenantId, c.matterId); await c.run({ type: 'completion_statement_generated', documentId }); }),
      step('transfer_deed', 'Transfer deed (TR1) executed by the seller', async (c) => { await c.run({ type: 'transfer_deed_executed', parties: ['Sandbox Seller'] }); }),
      step('funds', 'Completion monies received from the buyer\'s solicitor', async (c) => { await c.run({ type: 'funds_received', fromRole: 'buyer_solicitor', amountPennies: 42_500_000 }); }),
      step('redeem_pay', 'Redemption payment authorised against verified lender details', async (c) => { const lender = await c.verifiedDetails('lender', '22223333', 'Big Bank plc'); await c.run({ type: 'payment_authorised', payeeKind: 'lender', bankDetailsId: lender, amountPennies: 18_250_000, purpose: 'other' }); }),
      step('complete', 'Completion confirmed', async (c) => { await c.run({ type: 'completion_confirmed' }); }),
      step('redeemed', 'Mortgage redeemed', async (c) => { await c.run({ type: 'mortgage_redeemed' }); }),
      step('balance', 'Balance paid to the client against verified details', async (c) => { const client = await c.verifiedDetails('client', '44445555', 'Sandbox Seller'); await c.run({ type: 'payment_authorised', payeeKind: 'client', bankDetailsId: client, amountPennies: 23_000_000, purpose: 'other' }); }),
      step('discharge', 'Discharge confirmed', async (c) => { await c.run({ type: 'discharge_confirmed', reference: 'DS1-SANDBOX' }); }),
      step('close', 'Matter closed', async (c) => { await c.run({ type: 'close_matter' }); }),
    ],
  },
  {
    id: 'leasehold_sale', label: 'Leasehold Sale', transactionType: 'leasehold_sale', hasLender: false,
    summary: 'A flat sold: the TA7 joins the forms, the management pack is obtained for the buyer, the lease tenure is expected; redemption and discharge as on any sale.',
    steps: [
      step('enrol', 'Enrolled as a leasehold sale with an existing mortgage', async (c) => { await c.run({ type: 'enrol', transactionType: 'leasehold_sale', hasLender: false, hasExistingMortgage: true, requireExchangeAuthority: false, targetExchangeDate: F.exchangeDate(), targetCompletionDate: F.completionDate() }); }),
      ...idCheck(),
      step('forms_request', 'Property forms requested from the client', async (c) => { await c.run({ type: 'request_property_forms' }); }),
      step('forms', 'Property forms received (TA6, TA7, TA10)', async (c) => { await c.run({ type: 'property_forms_received', forms: ['TA6', 'TA7', 'TA10'] }); }),
      step('pack_request', 'Management pack requested from the managing agent', async (c) => { await c.run({ type: 'management_pack_requested', from: 'Block Managers Ltd' }); }),
      step('pack', 'Management pack received', async (c) => {
        const doc = await c.doc({ docType: 'MANAGEMENT_PACK', fileName: 'LPE1-management-pack.txt', facts: F.managementPack(false), body: F.body('Leasehold information (LPE1)', ['Service charge £2,400 a year', 'Ground rent £250 a year', 'No major works planned', 'Buildings insurance in place']) });
        await c.svc.managementPackReceived(c.tenantId, c.matterId, doc);
      }),
      step('pack_decision', 'The management pack is decided by a person', async (c) => { await c.resolve('management_pack', 'approve', 'Pack in order for the buyer.'); }, { decision: 'management_pack' }),
      step('title', 'Official copies received (leasehold, with the charge)', async (c) => {
        const doc = await c.doc({ docType: 'TITLE', fileName: 'official-copy-of-the-register.txt', facts: { ...F.titleWithCharge(), tenure: 'leasehold' as const }, body: F.body('Official copy of the register', ['Title number AB123456', 'Tenure: leasehold', 'C1 Registered charge dated 12 May 2019 in favour of Big Bank plc']) });
        await c.svc.titleReceived(c.tenantId, c.matterId, doc);
      }),
      step('title_decision', 'The registered charge is decided by a person', async (c) => { await c.resolve('title', 'approve', 'Registered charge: to be redeemed on completion.'); }, { decision: 'title' }),
      step('pack_sent', 'Contract pack sent to the buyer\'s solicitor', async (c) => { await c.run({ type: 'contract_pack_sent' }); }),
      step('redemption_request', 'Redemption statement requested', async (c) => { await c.run({ type: 'request_redemption_statement', lender: 'Big Bank plc' }); }),
      step('redemption', 'Redemption statement received', async (c) => { await c.run({ type: 'redemption_statement_received', redemptionPennies: 9_000_000, validUntil: F.completionDate(3) }); }),
      step('exchange', 'Contracts exchanged', async (c) => { await c.run({ type: 'contracts_exchanged', completionDate: F.completionDate() }); }),
      step('statement', 'Completion statement drafted and produced', async (c) => { const { documentId } = await c.svc.draftCompletionStatement(c.tenantId, c.matterId); await c.run({ type: 'completion_statement_generated', documentId }); }),
      step('transfer_deed', 'Transfer deed (TR1) executed by the seller', async (c) => { await c.run({ type: 'transfer_deed_executed', parties: ['Sandbox Seller'] }); }),
      step('funds', 'Completion monies received from the buyer\'s solicitor', async (c) => { await c.run({ type: 'funds_received', fromRole: 'buyer_solicitor', amountPennies: 28_000_000 }); }),
      step('redeem_pay', 'Redemption payment authorised', async (c) => { const lender = await c.verifiedDetails('lender', '22223333', 'Big Bank plc'); await c.run({ type: 'payment_authorised', payeeKind: 'lender', bankDetailsId: lender, amountPennies: 9_000_000, purpose: 'other' }); }),
      step('complete', 'Completion confirmed', async (c) => { await c.run({ type: 'completion_confirmed' }); }),
      step('redeemed', 'Mortgage redeemed', async (c) => { await c.run({ type: 'mortgage_redeemed' }); }),
      step('balance', 'Balance paid to the client', async (c) => { const client = await c.verifiedDetails('client', '44445555', 'Sandbox Seller'); await c.run({ type: 'payment_authorised', payeeKind: 'client', bankDetailsId: client, amountPennies: 18_000_000, purpose: 'other' }); }),
      step('discharge', 'Discharge confirmed', async (c) => { await c.run({ type: 'discharge_confirmed', reference: 'DS1-SANDBOX' }); }),
      step('close', 'Matter closed', async (c) => { await c.run({ type: 'close_matter' }); }),
    ],
  },
  {
    id: 'remortgage', label: 'Remortgage', transactionType: 'remortgage', hasLender: true,
    summary: 'No exchange: the title, the new offer and the redemption figure, then the deed, the certificate, the advance, the old lender paid, AP1 and discharge.',
    steps: [
      step('enrol', 'Enrolled as a remortgage', async (c) => { await c.run({ type: 'enrol', transactionType: 'remortgage', hasLender: true, hasExistingMortgage: true }); }),
      ...idCheck(),
      ...mortgage(),
      step('title', 'Official copies received (with the charge to redeem)', async (c) => {
        const doc = await c.doc({ docType: 'TITLE', fileName: 'official-copy-of-the-register.txt', facts: F.titleWithCharge(), body: F.body('Official copy of the register', ['Title number AB123456', 'Tenure: freehold', 'C1 Registered charge dated 12 May 2019 in favour of Old Lender plc']) });
        await c.svc.titleReceived(c.tenantId, c.matterId, doc);
      }),
      step('title_decision', 'The existing charge is decided by a person', async (c) => { await c.resolve('title', 'approve', 'Existing charge to be redeemed from the advance.'); }, { decision: 'title' }),
      step('redemption_request', 'Redemption statement requested from the old lender', async (c) => { await c.run({ type: 'request_redemption_statement', lender: 'Old Lender plc' }); }),
      step('redemption', 'Redemption statement received', async (c) => { await c.run({ type: 'redemption_statement_received', redemptionPennies: 12_000_000, validUntil: F.completionDate(5) }); }),
      step('deed', 'Mortgage deed executed and witnessed', async (c) => { await c.run({ type: 'mortgage_deed_executed', witnessed: true }); }),
      step('certificate', 'Certificate of title sent to the new lender', async (c) => { await c.run({ type: 'certificate_of_title_sent', completionDate: F.completionDate() }); }),
      step('advance', 'Advance requested and received', async (c) => { const ours = await c.verifiedDetails('firm_client_account', '99990000', 'Firm client account'); await c.run({ type: 'funds_requested', fromRole: 'lender', bankDetailsId: ours, amountPennies: 25_000_000 }); await c.run({ type: 'funds_received', fromRole: 'lender', amountPennies: 25_000_000 }); }),
      step('redeem_pay', 'Old lender paid against verified details', async (c) => { const old = await c.verifiedDetails('lender', '12121212', 'Old Lender plc'); await c.run({ type: 'payment_authorised', payeeKind: 'lender', bankDetailsId: old, amountPennies: 12_000_000, purpose: 'other' }); }),
      step('complete', 'Completion confirmed', async (c) => { await c.run({ type: 'completion_confirmed' }); }),
      step('sdlt', 'SDLT recorded as not required', async (c) => { await c.run({ type: 'sdlt_not_required', reason: 'Remortgage: no chargeable land transaction.' }); }),
      step('redeemed', 'Old mortgage redeemed', async (c) => { await c.run({ type: 'mortgage_redeemed' }); }),
      step('ap1', 'AP1 submitted for the new charge', async (c) => { await c.run({ type: 'ap1_submitted', reference: 'AP1-SANDBOX-1' }); }),
      step('registered', 'Registration confirmed', async (c) => { await c.run({ type: 'ap1_confirmed' }); }),
      step('discharge', 'Discharge of the old charge confirmed', async (c) => { await c.run({ type: 'discharge_confirmed' }); }),
      step('close', 'Matter closed', async (c) => { await c.run({ type: 'close_matter' }); }),
    ],
  },
  {
    id: 'transfer_of_equity', label: 'Transfer Of Equity', transactionType: 'transfer_of_equity', hasLender: false,
    summary: 'Two owners, a charged property: every party identified, the lender\'s consent, the clients decide how they hold, the deeds, the consideration, SDLT and AP1.',
    steps: [
      step('enrol', 'Enrolled as a transfer of equity with two parties and a charge', async (c) => { await c.run({ type: 'enrol', transactionType: 'transfer_of_equity', hasLender: false, hasExistingMortgage: true, parties: 2, considerationPennies: 5_000_000 }); }),
      ...idCheck(),
      step('title', 'Official copies received (with the charge)', async (c) => {
        const doc = await c.doc({ docType: 'TITLE', fileName: 'official-copy-of-the-register.txt', facts: F.titleWithCharge(), body: F.body('Official copy of the register', ['Title number AB123456', 'Tenure: freehold', 'C1 Registered charge dated 12 May 2019 in favour of Big Bank plc']) });
        await c.svc.titleReceived(c.tenantId, c.matterId, doc);
      }),
      step('title_decision', 'The charge is decided by a person', async (c) => { await c.resolve('title', 'approve', 'Charge stays; lender to consent.'); }, { decision: 'title' }),
      step('consent_request', 'Lender\'s consent requested', async (c) => { await c.run({ type: 'request_lender_consent', lender: 'Big Bank plc' }); }),
      step('consent', 'Lender\'s consent received', async (c) => { await c.run({ type: 'lender_consent_received', conditions: 'Outgoing borrower released on completion; deed of substituted security.' }); }),
      step('basis', 'The clients decide how they hold', async (c) => { await c.run({ type: 'client_decision_recorded', subject: 'ownership_basis', decision: 'tenants_in_common_unequal', note: '70/30 reflecting contributions; advised separately.' }); }),
      step('transfer_deed', 'Transfer deed executed', async (c) => { await c.run({ type: 'transfer_deed_executed', parties: ['Sandbox Owner A', 'Sandbox Owner B'] }); }),
      step('trust_deed', 'Declaration of trust executed', async (c) => { await c.run({ type: 'deed_of_trust_executed', parties: ['Sandbox Owner A', 'Sandbox Owner B'], shares: '70/30' }); }),
      step('consideration', 'Consideration received from the incoming owner', async (c) => { await c.run({ type: 'funds_received', fromRole: 'incoming_owner', amountPennies: 5_000_000 }); }),
      step('complete', 'Completion confirmed', async (c) => { await c.run({ type: 'completion_confirmed' }); }),
      step('sdlt', 'SDLT return submitted', async (c) => { await c.run({ type: 'sdlt_submitted', reference: 'SDLT-SANDBOX-1' }); }),
      step('ap1', 'AP1 submitted', async (c) => { await c.run({ type: 'ap1_submitted', reference: 'AP1-SANDBOX-2' }); }),
      step('registered', 'Registration confirmed', async (c) => { await c.run({ type: 'ap1_confirmed' }); }),
      step('close', 'Matter closed', async (c) => { await c.run({ type: 'close_matter' }); }),
    ],
  },
];

export const scenarioById = (id: string): Scenario | null => SCENARIOS.find((s) => s.id === id) ?? null;
/** The steps a run performs, in order. */
export const stepsFor = (s: Scenario, flagged: boolean): ScenarioStep[] => s.steps.filter((st) => (flagged ? !st.cleanOnly : !st.flaggedOnly));
