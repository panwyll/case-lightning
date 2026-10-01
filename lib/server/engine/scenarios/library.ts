/**
 * The scenario library: one scripted case per transaction type, driven through the real
 * engine on a sandbox matter (sandbox.ts) so a person can walk every stage of the
 * flowchart on the real screens. Each step is one thing that happens on a case; a run can
 * stop at any step, and the flagged variant takes the branch where the rules find something
 * and a person has to decide. Documents are fixture facts with a plain-text body marked as
 * sandbox material; Claude never reads them. Timers run on the real clock, so chases are
 * not part of a script.
 */
import { ISSUE_KIND_SPEC } from '../issues';
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
  /** The client's other case in a chain (their sale, on a purchase): created the first time, the same case after. */
  companion(): Promise<ScenarioContext>;
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
  step('search_findings', "The enforcement entry investigated: the council confirms the notice was complied with", async (c) => {
    await resolveFindings(c, /search\)$/, { evidence_provided: "Council's letter confirming the 2024 enforcement notice was complied with and closed." });
  }, { flaggedOnly: true }),
];

/** Each issue a reading raised (findings.ts), dealt with the way a conveyancer would: the evidence on file for the outcome given. */
async function resolveFindings(c: ScenarioContext, title: RegExp, outcomes: Partial<Record<'evidence_provided' | 'lease_extended' | 'deed_of_variation' | 'restriction_complied', string>>) {
  const s = await c.svc.getState(c.tenantId, c.matterId);
  for (const i of Object.values(s.issues).filter((x) => x.finding && title.test(x.title) && (x.status === 'open' || x.status === 'negotiating'))) {
    const resolution = (Object.keys(outcomes) as Array<keyof typeof outcomes>).find((r) => ISSUE_KIND_SPEC[i.kind].resolutions.includes(r as never));
    if (!resolution) continue;
    const note = outcomes[resolution]!;
    if (resolution === 'lease_extended') { await c.run({ type: 'resolve_issue', issueId: i.id, resolution, note, details: { newTerm: '990 years from completion' } }); continue; }
    const evidence = await c.doc({ docType: 'SUPPORTING_DOCUMENT', fileName: `${resolution.replace(/_/g, '-')}.txt`, facts: { content: note }, body: note });
    await c.run({ type: 'resolve_issue', issueId: i.id, resolution, note, documentId: evidence });
  }
  // A deed of variation or an extension is reported to the lender (the engine raises that itself); the lender confirms.
  const after = await c.svc.getState(c.tenantId, c.matterId);
  for (const i of Object.values(after.issues).filter((x) => x.kind === 'lender_approval' && (x.status === 'open' || x.status === 'negotiating'))) await c.run({ type: 'resolve_issue', issueId: i.id, resolution: 'lender_confirmed', note: 'Lender content.' });
}

const mortgage = (): ScenarioStep[] => [
  step('offer', 'Mortgage offer received', async (c) => {
    const doc = await c.doc({ docType: 'MORTGAGE_OFFER', fileName: 'mortgage-offer.txt', facts: c.flagged ? F.offerSpecial() : F.offerClear(), body: F.body('Mortgage offer', ['Lender: Mock Building Society', 'Advance: £250,000.00', 'Offer expires: 1 March 2027', ...(c.flagged ? ['Special condition 4: retention of £5,000 pending roof repairs'] : [])]) });
    await c.svc.mortgageOfferReceived(c.tenantId, c.matterId, doc);
  }),
  step('offer_decision', 'The special condition is decided by a person', async (c) => { await c.resolve('mortgage', 'approve', 'Retention noted; roof quote obtained and reported to the lender.'); }, { flaggedOnly: true, decision: 'mortgage' }),
];

const sellerForms = (leasehold: boolean): ScenarioStep[] => [
  step('seller_forms', "The seller's property forms (TA6 / TA10) received with the contract pack and read", async (c) => {
    const facts = F.propertyForms(c.flagged, leasehold);
    const doc = await c.doc({ docType: 'PROPERTY_FORMS', fileName: 'ta6-property-information.txt', facts, body: F.body('TA6 property information form', ['Section 4 alterations: ' + (facts.answers?.alterations ?? 'none'), 'Section 7 Japanese knotweed: ' + (facts.answers?.japaneseKnotweed ? 'Yes' : 'No')]) });
    await c.svc.propertyFormsReceived(c.tenantId, c.matterId, doc);
  }),
  step('seller_forms_issues', "The TA6 issues resolved: consents obtained by indemnity, the knotweed guarantee on file", async (c) => {
    const s = await c.svc.getState(c.tenantId, c.matterId);
    for (const i of Object.values(s.issues).filter((i) => (i.title.startsWith('TA6:') || i.title.startsWith("Seller's forms:")) && (i.status === 'open' || i.status === 'negotiating'))) {
      const indemnity = i.kind === 'building_regs_missing';
      const evidence = await c.doc({ docType: 'SUPPORTING_DOCUMENT', fileName: indemnity ? 'building-regs-indemnity-policy.txt' : 'knotweed-guarantee.txt', facts: { content: indemnity ? 'Indemnity policy' : 'Guarantee' }, body: indemnity ? 'Building regulations indemnity policy\nInsurer: Mock Legal Indemnities\nPremium: £95' : 'Knotweed treatment plan and insurance-backed guarantee' });
      await c.run(indemnity
        ? { type: 'resolve_issue', issueId: i.id, resolution: 'indemnity_policy', note: 'Building regulations indemnity policy quoted and accepted by the lender.', costPennies: 9500, paidBy: 'seller', documentId: evidence, details: { insurer: 'Mock Legal Indemnities' } }
        : { type: 'resolve_issue', issueId: i.id, resolution: 'evidence_provided', note: 'Treatment plan and insurance-backed guarantee received; lender content.', documentId: evidence });
    }
    // An indemnity policy tells the lender (the engine raises that itself); the lender confirms.
    const after = await c.svc.getState(c.tenantId, c.matterId);
    for (const i of Object.values(after.issues).filter((i) => i.kind === 'lender_approval' && i.title.includes('TA6') && (i.status === 'open' || i.status === 'negotiating'))) {
      await c.run({ type: 'resolve_issue', issueId: i.id, resolution: 'lender_confirmed', note: 'Lender accepts the indemnity policy.' });
    }
  }, { flaggedOnly: true }),
];

const title = (leasehold: boolean): ScenarioStep[] => [
  step('title', 'Official copies received', async (c) => {
    const facts = leasehold ? { ...F.titleClear(), tenure: 'leasehold' as const, ...(c.flagged ? { lease: F.leaseShort() } : {}) } : c.flagged ? F.titleWithCharge() : F.titleClear();
    const doc = await c.doc({ docType: 'TITLE', fileName: 'official-copy-of-the-register.txt', facts, body: F.body('Official copy of the register', ['Title number AB123456', `Tenure: ${leasehold ? 'leasehold' : 'freehold'}`, ...(c.flagged && !leasehold ? ['C1 Registered charge dated 12 May 2019 in favour of Big Bank plc'] : []), ...(c.flagged && leasehold ? ['Lease: 78 years unexpired; ground rent £350 a year doubling every 10 years'] : [])]) });
    await c.svc.titleReceived(c.tenantId, c.matterId, doc);
  }),
  step('title_decision', 'The title entries are decided by a person', async (c) => { await c.resolve('title', 'approve', leasehold ? 'Short lease and doubling rent reported to the client and lender; extension to be negotiated.' : 'Registered charge: undertaking to discharge on completion.'); }, { flaggedOnly: true, decision: 'title' }),
  step('title_findings', leasehold ? 'The short lease extended and the ground rent varied before exchange' : 'The title entries dealt with', async (c) => {
    await resolveFindings(c, /./, { lease_extended: 'Seller served the statutory notice and the lease is extended to 990 years on completion; benefit assigned.', deed_of_variation: 'Landlord agreed a deed of variation fixing the ground rent at a peppercorn.', restriction_complied: 'Certificate of compliance obtained from the management company.', evidence_provided: 'Evidence on file.' });
  }, { flaggedOnly: true }),
];

const enquiries = (): ScenarioStep[] => [
  step('enquiry_raise', 'Enquiries raised with the seller\'s solicitor', async (c) => {
    await c.run({ type: 'raise_enquiry', enquiryId: 'E1', subject: 'Please confirm the boiler service history and provide the last gas safety certificate.' });
    await c.run({ type: 'raise_enquiry', enquiryId: 'E2', subject: 'Please confirm who maintains the rear boundary fence.' });
  }),
  step('enquiry_replies', 'Replies to enquiries received', async (c) => {
    // Every enquiry out, including the one the seller's forms drafted.
    const open = Object.values((await c.svc.getState(c.tenantId, c.matterId)).enquiries).filter((q) => q.status === 'raised').map((q) => q.enquiryId);
    for (const id of [...new Set(['E1', 'E2', ...open])]) {
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
    const statement = await c.doc({ docType: 'BANK_STATEMENT', fileName: 'savings-statement.txt', facts: F.statement('Sandbox Buyer', balance - gift), body: F.statementBody(F.statement('Sandbox Buyer', balance - gift)) });
    const donor = c.flagged ? await c.doc({ docType: 'BANK_STATEMENT', fileName: 'donor-statement.txt', facts: F.statement('Sandbox Donor & Sandbox Donor Two', gift), body: F.statementBody(F.statement('Sandbox Donor & Sandbox Donor Two', gift)) }) : null;
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
    const statement = await c.doc({ docType: 'BANK_STATEMENT', fileName: 'savings-statement-round-2.txt', facts: F.statement('Sandbox Buyer', balance - gift), body: F.statementBody(F.statement('Sandbox Buyer', balance - gift)) });
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

/** The contract, ready to exchange: the draft in the pack approved from its task, and our client's signed part back. */
const contractBuyer = (): ScenarioStep[] => [
  step('contract', 'The draft contract reviewed and approved for signature', async (c) => {
    let s = await c.svc.getState(c.tenantId, c.matterId);
    if (!s.readiness.contractDocumentId) {
      const doc = await c.doc({ docType: 'CONTRACT', fileName: 'draft-contract.txt', facts: F.contract(), body: F.body('Draft contract', ['Standard Conditions of Sale (5th edition)', 'Deposit 10%']) });
      await c.svc.contractReceived(c.tenantId, c.matterId, doc);
      s = await c.svc.getState(c.tenantId, c.matterId);
    }
    if (s.readiness.contractApprovedAt) return;
    if (Object.values(s.decisions).some((d) => d.kind === 'contract' && d.status === 'pending')) await c.resolve('contract', 'approve', 'Terms checked against the report on title; approved for signature.');
    else await c.run({ type: 'contract_approved' });
  }),
  step('contract_signed', "The client's signed contract comes back", async (c) => {
    const doc = await c.doc({ docType: 'SIGNED_CONTRACT', fileName: 'signed-contract.txt', facts: { content: 'signed contract' }, body: F.body('Contract', ['Signed by the buyer, undated']) });
    await c.run({ type: 'signed_contract_held', documentId: doc });
  }),
];
const contractSeller = (): ScenarioStep[] => [
  step('contract_approved', "The buyer's solicitor approves the contract", async (c) => { await c.run({ type: 'contract_approved' }); }),
  step('contract_signed', "The client's signed contract comes back", async (c) => {
    const doc = await c.doc({ docType: 'SIGNED_CONTRACT', fileName: 'signed-contract.txt', facts: { content: 'signed contract' }, body: F.body('Contract', ['Signed by the seller, undated']) });
    await c.run({ type: 'signed_contract_held', documentId: doc });
  }),
];

const exchangeBuyer = (price: number, deposit: number, advance: number | null): ScenarioStep[] => [
  ...contractBuyer(),
  step('deposit', 'Deposit received on client account', async (c) => { await c.run({ type: 'deposit_received', amountPennies: deposit }); }),
  step('authority', 'The client authorises exchange', async (c) => { await c.run({ type: 'client_decision_recorded', subject: 'exchange_authority', decision: 'authorised', note: 'Authority given by email after the report on title.' }); }),
  step('exchange', 'Contracts exchanged', async (c) => { await c.run({ type: 'contracts_exchanged', completionDate: F.completionDate() }); }),
  step('statement', 'Completion statement drafted and produced', async (c) => {
    const { documentId } = await c.svc.draftCompletionStatement(c.tenantId, c.matterId);
    await c.run({ type: 'completion_statement_generated', documentId, balancePennies: price - deposit - (advance ?? 0) });
  }),
  // The order lenders work to: the client's money in, the searches and insurance done, the deed signed; then the certificate of title, and the advance against it.
  step('balance', "The client's balance requested and received", async (c) => {
    const ours = await c.verifiedDetails('firm_client_account', '99990000', 'Firm client account');
    const balance = price - deposit - (advance ?? 0);
    await c.run({ type: 'funds_requested', fromRole: 'client', bankDetailsId: ours, amountPennies: balance });
    await c.run({ type: 'funds_received', fromRole: 'client', amountPennies: balance });
  }),
  step('pre_completion_checks', advance != null ? "Pre-completion checks: bankruptcy search clear, priority search made, buildings insurance confirmed" : 'Priority search (OS1) made', async (c) => {
    if (advance != null) {
      const k16 = await c.doc({ docType: 'SEARCH_RESULT', fileName: 'k16-bankruptcy-search.txt', facts: { content: 'sandbox K16' }, body: F.body('K16 bankruptcy search', ['Subject: Sandbox Buyer', 'Result: NO ENTRIES']) });
      await c.run({ type: 'bankruptcy_search_clear', subjects: ['Sandbox Buyer'], documentId: k16 });
    }
    const os1 = await c.doc({ docType: 'SEARCH_RESULT', fileName: 'os1-priority-search.txt', facts: { content: 'sandbox OS1' }, body: F.body('OS1 official search with priority', ['Title AB123456', `Priority expires ${F.completionDate(3)}`]) });
    await c.run({ type: 'priority_search_made', expiresAt: F.completionDate(3), documentId: os1 });
    if (advance != null) await c.run({ type: 'buildings_insurance_confirmed', insurer: 'Sandbox Insurance plc', fromDate: F.exchangeDate() });
  }),
  ...(advance != null ? [
    step('mortgage_deed', 'Mortgage deed executed and witnessed', async (c) => { await c.run({ type: 'mortgage_deed_executed', witnessed: true }); }),
    step('certificate', 'Certificate of title sent to the lender', async (c) => { await c.run({ type: 'certificate_of_title_sent', completionDate: F.completionDate() }); }),
    step('advance', 'Advance requested against the certificate and received', async (c) => {
      const st = await c.svc.getState(c.tenantId, c.matterId);
      const ours = Object.values(st.bankDetails).find((b) => b.payeeKind === 'firm_client_account' && b.status === 'verified')?.id ?? (await c.verifiedDetails('firm_client_account', '99990000', 'Firm client account'));
      await c.run({ type: 'funds_requested', fromRole: 'lender', bankDetailsId: ours, amountPennies: advance });
      await c.run({ type: 'funds_received', fromRole: 'lender', amountPennies: advance });
    }),
  ] : []),
  step('transfer_deed', 'Transfer deed (TR1) executed', async (c) => { await c.run({ type: 'transfer_deed_executed', parties: ['Sandbox Buyer'] }); }),
  step('pay_seller', 'Completion monies authorised against verified seller\'s-solicitor details', async (c) => {
    const theirs = await c.verifiedDetails('seller_solicitor', '11112222', 'Seller Solicitors LLP client account');
    await c.run({ type: 'payment_authorised', payeeKind: 'seller_solicitor', bankDetailsId: theirs, amountPennies: price - deposit, purpose: 'completion_monies' });
  }),
  step('money_sent', 'Completion money sent by CHAPS', async (c) => { await c.run({ type: 'completion_payment_sent', reference: 'CHAPS-SANDBOX-1' }); }),
  step('ta13', "The seller's solicitor's replies to completion information (TA13), with their undertaking to redeem", async (c) => {
    const doc = await c.doc({ docType: 'TA13', fileName: 'ta13-completion-information.txt', facts: { content: 'TA13 replies' }, body: F.body('Completion information and undertakings (TA13)', ["We undertake to redeem the charge in favour of the seller's lender and to send the DS1 on receipt."]) });
    await c.run({ type: 'completion_information_received', undertakingToRedeem: true, documentId: doc });
  }),
  step('complete', 'Completion confirmed', async (c) => { await c.run({ type: 'completion_confirmed' }); }),
  step('sdlt', 'SDLT return submitted', async (c) => { await c.run({ type: 'sdlt_submitted', reference: 'SDLT-SANDBOX-1' }); }),
  step('ap1', 'AP1 submitted to HM Land Registry', async (c) => { await c.run({ type: 'ap1_submitted', reference: 'AP1-SANDBOX-1' }); }),
  step('registered', 'Registration confirmed', async (c) => { await c.run({ type: 'ap1_confirmed' }); }),
  step('register_check', 'The new register checked; the seller\'s DS1 in where their title was charged', async (c) => {
    await c.run({ type: 'register_checked', lenderTold: true });
    const st = await c.svc.getState(c.tenantId, c.matterId);
    if (st.waits.some((w) => w.key === 'seller_discharge' && !w.closedAt)) await c.run({ type: 'seller_discharge_received', reference: 'DS1-SANDBOX' });
  }),
  step('landlord_consents', "What the landlord required on assignment is done (deed of covenant signed, certificate of compliance obtained)", async (c) => {
    const s = await c.svc.getState(c.tenantId, c.matterId);
    for (const i of Object.values(s.issues).filter((i) => i.kind === 'missing_consent' && i.title.startsWith('After completion:') && (i.status === 'open' || i.status === 'negotiating'))) {
      const cert = await c.doc({ docType: 'SUPPORTING_DOCUMENT', fileName: 'certificate-of-compliance.txt', facts: { content: 'Certificate of compliance' }, body: 'Certificate of compliance from the management company' });
      await c.run({ type: 'resolve_issue', issueId: i.id, resolution: 'consent_obtained', note: 'Deed of covenant signed at completion; certificate of compliance received from the management company and lodged with the AP1.', documentId: cert });
    }
  }),
  step('final_bill', 'The final bill sent to the client', async (c) => { if (!(await c.svc.getState(c.tenantId, c.matterId)).finalBill) await c.run({ type: 'final_bill_delivered', amountPennies: 150_000 }); }),
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
      ...sellerForms(false),
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
      step('pack_request', 'Management pack requested from the managing agent', async (c) => { const st = await c.svc.getState(c.tenantId, c.matterId); if (st.managementPack.status === 'not_started') await c.run({ type: 'management_pack_requested', from: 'Block Managers Ltd' }); }),
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
      ...sellerForms(true),
      ...enquiries(),
      ...reportOnTitle(),
      ...exchangeBuyer(PRICE, DEPOSIT, ADVANCE).filter((s) => s.id !== 'close'),
      step('notice', 'Notice of assignment served on the landlord', async (c) => { await c.run({ type: 'notice_of_assignment_served', servedOn: 'Block Managers Ltd for Mill Lane Freeholds Limited', reference: 'NOA-1' }); }),
      step('final_bill', 'The final bill sent to the client', async (c) => { if (!(await c.svc.getState(c.tenantId, c.matterId)).finalBill) await c.run({ type: 'final_bill_delivered', amountPennies: 150_000 }); }),
      step('close', 'Matter closed', async (c) => { await c.run({ type: 'close_matter' }); }),
    ],
  },
  {
    id: 'freehold_sale', label: 'Freehold Sale', transactionType: 'freehold_sale', hasLender: false,
    summary: 'A seller with a mortgage to redeem: property forms, the title, the contract pack, the buyer\'s enquiries, the redemption figure, exchange, completion, redemption and discharge.',
    steps: [
      step('enrol', 'Enrolled as a freehold sale with an existing mortgage', async (c) => { await c.run({ type: 'enrol', transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: true, requireExchangeAuthority: false, targetExchangeDate: F.exchangeDate(), targetCompletionDate: F.completionDate() }); }),
      ...idCheck(),
      step('forms_request', 'Property forms requested from the client', async (c) => { const st = await c.svc.getState(c.tenantId, c.matterId); if (st.propertyForms.status === 'not_started') await c.run({ type: 'request_property_forms' }); }),
      step('forms', 'Property forms received (TA6, TA10) and read for what must be disclosed', async (c) => {
        const facts = F.propertyForms(c.flagged);
        const doc = await c.doc({ docType: 'PROPERTY_FORMS', fileName: 'ta6-our-client.txt', facts, body: F.body('TA6 property information form', ['Completed by the seller']) });
        await c.svc.propertyFormsReceived(c.tenantId, c.matterId, doc);
      }),
      step('forms_issues', 'What the TA6 discloses is dealt with before the pack goes out', async (c) => {
        const s = await c.svc.getState(c.tenantId, c.matterId);
        for (const i of Object.values(s.issues).filter((i) => (i.title.startsWith('TA6:') || i.title.startsWith("Seller's forms:")) && (i.status === 'open' || i.status === 'negotiating'))) {
          const paper = await c.doc({ docType: 'SUPPORTING_DOCUMENT', fileName: `disclosure-${i.id}.txt`, facts: { content: 'Disclosure paperwork' }, body: `Paperwork for: ${i.title}` });
          await c.run({ type: 'resolve_issue', issueId: i.id, resolution: 'evidence_provided', note: 'Disclosed in full with the paperwork in the pack.', documentId: paper });
        }
      }, { flaggedOnly: true }),
      step('title', 'Official copies received (with the charge to redeem)', async (c) => {
        const doc = await c.doc({ docType: 'TITLE', fileName: 'official-copy-of-the-register.txt', facts: F.titleWithCharge(), body: F.body('Official copy of the register', ['Title number AB123456', 'Tenure: freehold', 'C1 Registered charge dated 12 May 2019 in favour of Big Bank plc']) });
        await c.svc.titleReceived(c.tenantId, c.matterId, doc);
      }),
      step('title_decision', 'The registered charge is decided by a person', async (c) => { await c.resolve('title', 'approve', 'Registered charge: to be redeemed on completion.'); }, { decision: 'title' }),
      step('pack', 'Contract pack sent to the buyer\'s solicitor', async (c) => { await c.run({ type: 'contract_pack_sent' }); }),
      step('buyer_enquiries', 'The buyer\'s enquiries received', async (c) => { await c.run({ type: 'buyer_enquiries_received', enquiries: [{ question: 'Please confirm the boiler service history.' }, { id: 'BE-Boundary', question: 'Who maintains the rear fence?' }] }); }),
      step('replies', 'Replies sent to the buyer\'s enquiries', async (c) => { await c.run({ type: 'enquiry_replies_sent', enquiryIds: ['BE1', 'BE-Boundary'] }); }),
      step('redemption_request', 'Redemption statement requested from the lender', async (c) => { const st = await c.svc.getState(c.tenantId, c.matterId); if (st.redemption.status === 'not_started') await c.run({ type: 'request_redemption_statement', lender: 'Big Bank plc' }); }),
      step('redemption', 'Redemption statement received', async (c) => { await c.run({ type: 'redemption_statement_received', redemptionPennies: 18_250_000, validUntil: F.completionDate(3), dailyInterestPennies: 2_100 }); }),
      ...contractSeller(),
      step('exchange', 'Contracts exchanged', async (c) => { await c.run({ type: 'contracts_exchanged', completionDate: F.completionDate() }); }),
      step('statement', 'Completion statement drafted and produced', async (c) => { const { documentId } = await c.svc.draftCompletionStatement(c.tenantId, c.matterId); await c.run({ type: 'completion_statement_generated', documentId }); }),
      step('transfer_deed', 'Transfer deed (TR1) executed by the seller', async (c) => { await c.run({ type: 'transfer_deed_executed', parties: ['Sandbox Seller'] }); }),
      step('undertaking', "Our undertaking to redeem given to the buyer's solicitor (reply to their TA13)", async (c) => { await c.run({ type: 'undertaking_given', to: "The buyer's solicitor", terms: 'To redeem the charge in favour of Big Bank plc from the completion money and send the DS1 on receipt.' }); }),
      step('funds', 'Completion monies received from the buyer\'s solicitor', async (c) => { await c.run({ type: 'funds_received', fromRole: 'buyer_solicitor', amountPennies: 42_500_000 }); }),
      step('redeem_pay', 'Redemption payment authorised against verified lender details', async (c) => { const lender = await c.verifiedDetails('lender', '22223333', 'Big Bank plc'); await c.run({ type: 'payment_authorised', payeeKind: 'lender', bankDetailsId: lender, amountPennies: 18_250_000, purpose: 'other' }); }),
      step('complete', 'Completion confirmed', async (c) => { await c.run({ type: 'completion_confirmed' }); }),
      step('redeemed', 'Mortgage redeemed', async (c) => { await c.run({ type: 'mortgage_redeemed' }); }),
      step('balance', 'Balance paid to the client against verified details', async (c) => { const client = await c.verifiedDetails('client', '44445555', 'Sandbox Seller'); await c.run({ type: 'payment_authorised', payeeKind: 'client', bankDetailsId: client, amountPennies: 23_000_000, purpose: 'other' }); }),
      step('discharge', 'Discharge confirmed', async (c) => { await c.run({ type: 'discharge_confirmed', reference: 'DS1-SANDBOX' }); }),
      step('undertaking_done', "The DS1 sent to the buyer's solicitor: our undertaking is done", async (c) => { await c.run({ type: 'undertaking_discharged' }); }),
      step('final_bill', 'The final bill sent to the client', async (c) => { if (!(await c.svc.getState(c.tenantId, c.matterId)).finalBill) await c.run({ type: 'final_bill_delivered', amountPennies: 150_000 }); }),
      step('close', 'Matter closed', async (c) => { await c.run({ type: 'close_matter' }); }),
    ],
  },
  {
    id: 'leasehold_sale', label: 'Leasehold Sale', transactionType: 'leasehold_sale', hasLender: false,
    summary: 'A flat sold: the TA7 joins the forms, the management pack is obtained for the buyer, the lease tenure is expected; redemption and discharge as on any sale.',
    steps: [
      step('enrol', 'Enrolled as a leasehold sale with an existing mortgage', async (c) => { await c.run({ type: 'enrol', transactionType: 'leasehold_sale', hasLender: false, hasExistingMortgage: true, requireExchangeAuthority: false, targetExchangeDate: F.exchangeDate(), targetCompletionDate: F.completionDate() }); }),
      ...idCheck(),
      step('forms_request', 'Property forms requested from the client', async (c) => { const st = await c.svc.getState(c.tenantId, c.matterId); if (st.propertyForms.status === 'not_started') await c.run({ type: 'request_property_forms' }); }),
      step('forms', 'Property forms received (TA6, TA7, TA10)', async (c) => { await c.run({ type: 'property_forms_received', forms: ['TA6', 'TA7', 'TA10'] }); }),
      step('pack_request', 'Management pack requested from the managing agent', async (c) => { const st = await c.svc.getState(c.tenantId, c.matterId); if (st.managementPack.status === 'not_started') await c.run({ type: 'management_pack_requested', from: 'Block Managers Ltd' }); }),
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
      step('redemption_request', 'Redemption statement requested', async (c) => { const st = await c.svc.getState(c.tenantId, c.matterId); if (st.redemption.status === 'not_started') await c.run({ type: 'request_redemption_statement', lender: 'Big Bank plc' }); }),
      step('redemption', 'Redemption statement received', async (c) => { await c.run({ type: 'redemption_statement_received', redemptionPennies: 9_000_000, validUntil: F.completionDate(3) }); }),
      ...contractSeller(),
      step('exchange', 'Contracts exchanged', async (c) => { await c.run({ type: 'contracts_exchanged', completionDate: F.completionDate() }); }),
      step('statement', 'Completion statement drafted and produced', async (c) => { const { documentId } = await c.svc.draftCompletionStatement(c.tenantId, c.matterId); await c.run({ type: 'completion_statement_generated', documentId }); }),
      step('transfer_deed', 'Transfer deed (TR1) executed by the seller', async (c) => { await c.run({ type: 'transfer_deed_executed', parties: ['Sandbox Seller'] }); }),
      step('undertaking', "Our undertaking to redeem given to the buyer's solicitor (reply to their TA13)", async (c) => { await c.run({ type: 'undertaking_given', to: "The buyer's solicitor", terms: 'To redeem the charge in favour of Big Bank plc from the completion money and send the DS1 on receipt.' }); }),
      step('funds', 'Completion monies received from the buyer\'s solicitor', async (c) => { await c.run({ type: 'funds_received', fromRole: 'buyer_solicitor', amountPennies: 28_000_000 }); }),
      step('redeem_pay', 'Redemption payment authorised', async (c) => { const lender = await c.verifiedDetails('lender', '22223333', 'Big Bank plc'); await c.run({ type: 'payment_authorised', payeeKind: 'lender', bankDetailsId: lender, amountPennies: 9_000_000, purpose: 'other' }); }),
      step('complete', 'Completion confirmed', async (c) => { await c.run({ type: 'completion_confirmed' }); }),
      step('redeemed', 'Mortgage redeemed', async (c) => { await c.run({ type: 'mortgage_redeemed' }); }),
      step('balance', 'Balance paid to the client', async (c) => { const client = await c.verifiedDetails('client', '44445555', 'Sandbox Seller'); await c.run({ type: 'payment_authorised', payeeKind: 'client', bankDetailsId: client, amountPennies: 18_000_000, purpose: 'other' }); }),
      step('discharge', 'Discharge confirmed', async (c) => { await c.run({ type: 'discharge_confirmed', reference: 'DS1-SANDBOX' }); }),
      step('undertaking_done', "The DS1 sent to the buyer's solicitor: our undertaking is done", async (c) => { await c.run({ type: 'undertaking_discharged' }); }),
      step('final_bill', 'The final bill sent to the client', async (c) => { if (!(await c.svc.getState(c.tenantId, c.matterId)).finalBill) await c.run({ type: 'final_bill_delivered', amountPennies: 150_000 }); }),
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
      step('redemption_request', 'Redemption statement requested from the old lender', async (c) => { const st = await c.svc.getState(c.tenantId, c.matterId); if (st.redemption.status === 'not_started') await c.run({ type: 'request_redemption_statement', lender: 'Old Lender plc' }); }),
      step('redemption', 'Redemption statement received', async (c) => { await c.run({ type: 'redemption_statement_received', redemptionPennies: 12_000_000, validUntil: F.completionDate(5) }); }),
      step('deed', 'Mortgage deed executed and witnessed', async (c) => { await c.run({ type: 'mortgage_deed_executed', witnessed: true }); }),
      step('pre_completion_checks', "The new lender's checks: bankruptcy search clear, priority search made, buildings insurance confirmed", async (c) => {
        await c.run({ type: 'bankruptcy_search_clear', subjects: ['Sandbox Owner'] });
        await c.run({ type: 'priority_search_made', expiresAt: F.completionDate(3) });
        await c.run({ type: 'buildings_insurance_confirmed', insurer: 'Sandbox Insurance plc' });
      }),
      step('certificate', 'Certificate of title sent to the new lender', async (c) => { await c.run({ type: 'certificate_of_title_sent', completionDate: F.completionDate() }); }),
      step('advance', 'Advance requested and received', async (c) => { const ours = await c.verifiedDetails('firm_client_account', '99990000', 'Firm client account'); await c.run({ type: 'funds_requested', fromRole: 'lender', bankDetailsId: ours, amountPennies: 25_000_000 }); await c.run({ type: 'funds_received', fromRole: 'lender', amountPennies: 25_000_000 }); }),
      step('redeem_pay', 'Old lender paid against verified details', async (c) => { const old = await c.verifiedDetails('lender', '12121212', 'Old Lender plc'); await c.run({ type: 'payment_authorised', payeeKind: 'lender', bankDetailsId: old, amountPennies: 12_000_000, purpose: 'other' }); }),
      step('complete', 'Completion confirmed', async (c) => { await c.run({ type: 'completion_confirmed' }); }),
      step('sdlt', 'SDLT recorded as not required', async (c) => { await c.run({ type: 'sdlt_not_required', reason: 'Remortgage: no chargeable land transaction.' }); }),
      step('redeemed', 'Old mortgage redeemed', async (c) => { await c.run({ type: 'mortgage_redeemed' }); }),
      step('ap1', 'AP1 submitted for the new charge', async (c) => { await c.run({ type: 'ap1_submitted', reference: 'AP1-SANDBOX-1' }); }),
      step('registered', 'Registration confirmed', async (c) => { await c.run({ type: 'ap1_confirmed' }); }),
      step('register_check', 'The new register checked; the seller\'s DS1 in where their title was charged', async (c) => {
    await c.run({ type: 'register_checked', lenderTold: true });
    const st = await c.svc.getState(c.tenantId, c.matterId);
    if (st.waits.some((w) => w.key === 'seller_discharge' && !w.closedAt)) await c.run({ type: 'seller_discharge_received', reference: 'DS1-SANDBOX' });
  }),
      step('discharge', 'Discharge of the old charge confirmed', async (c) => { await c.run({ type: 'discharge_confirmed' }); }),
      step('final_bill', 'The final bill sent to the client', async (c) => { if (!(await c.svc.getState(c.tenantId, c.matterId)).finalBill) await c.run({ type: 'final_bill_delivered', amountPennies: 150_000 }); }),
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
      step('consent_request', 'Lender\'s consent requested', async (c) => { const st = await c.svc.getState(c.tenantId, c.matterId); if (st.lenderConsent.status === 'not_started') await c.run({ type: 'request_lender_consent', lender: 'Big Bank plc' }); }),
      step('consent', 'Lender\'s consent received', async (c) => { await c.run({ type: 'lender_consent_received', conditions: 'Outgoing borrower released on completion; deed of substituted security.' }); }),
      step('basis', 'The clients decide how they hold', async (c) => { await c.run({ type: 'client_decision_recorded', subject: 'ownership_basis', decision: 'tenants_in_common_unequal', note: '70/30 reflecting contributions; advised separately.' }); }),
      step('transfer_deed', 'Transfer deed executed', async (c) => { await c.run({ type: 'transfer_deed_executed', parties: ['Sandbox Owner A', 'Sandbox Owner B'] }); }),
      step('trust_deed', 'Declaration of trust executed', async (c) => { await c.run({ type: 'deed_of_trust_executed', parties: ['Sandbox Owner A', 'Sandbox Owner B'], shares: '70/30' }); }),
      step('consideration', 'Consideration received from the incoming owner', async (c) => { await c.run({ type: 'funds_received', fromRole: 'incoming_owner', amountPennies: 5_000_000 }); }),
      step('complete', 'Completion confirmed', async (c) => { await c.run({ type: 'completion_confirmed' }); }),
      step('sdlt', 'SDLT return submitted', async (c) => { await c.run({ type: 'sdlt_submitted', reference: 'SDLT-SANDBOX-1' }); }),
      step('ap1', 'AP1 submitted', async (c) => { await c.run({ type: 'ap1_submitted', reference: 'AP1-SANDBOX-2' }); }),
      step('registered', 'Registration confirmed', async (c) => { await c.run({ type: 'ap1_confirmed' }); }),
      step('register_check', 'The new register checked; the seller\'s DS1 in where their title was charged', async (c) => {
    await c.run({ type: 'register_checked', lenderTold: true });
    const st = await c.svc.getState(c.tenantId, c.matterId);
    if (st.waits.some((w) => w.key === 'seller_discharge' && !w.closedAt)) await c.run({ type: 'seller_discharge_received', reference: 'DS1-SANDBOX' });
  }),
      step('final_bill', 'The final bill sent to the client', async (c) => { if (!(await c.svc.getState(c.tenantId, c.matterId)).finalBill) await c.run({ type: 'final_bill_delivered', amountPennies: 150_000 }); }),
      step('close', 'Matter closed', async (c) => { await c.run({ type: 'close_matter' }); }),
    ],
  },
];

export const scenarioById = (id: string): Scenario | null => SCENARIOS.find((s) => s.id === id) ?? null;
/** The steps a run performs, in order. */
export const stepsFor = (s: Scenario, flagged: boolean): ScenarioStep[] => s.steps.filter((st) => (flagged ? !st.cleanOnly : !st.flaggedOnly));

// ── a chain: one client selling their home and buying another, both with this firm ──
/** A step run on the client's sale (the companion case), and its own proposals approved like the purchase's. */
const onSale = (s: ScenarioStep): ScenarioStep => ({ ...s, id: `sale_${s.id}`, label: `Sale: ${s.label}`, decision: undefined, run: async (c) => { const sale = await c.companion(); await s.run(sale); await sale.settle(); } });
const saleSteps = SCENARIOS.find((x) => x.id === 'freehold_sale')!.steps;
const upTo = (steps: ScenarioStep[], id: string) => steps.slice(0, steps.findIndex((x) => x.id === id));
const from = (steps: ScenarioStep[], id: string) => steps.slice(steps.findIndex((x) => x.id === id));
const buyerExchange = exchangeBuyer(PRICE, DEPOSIT, ADVANCE).filter((x) => !x.id.startsWith('pof_') && x.id !== 'donor_id');

SCENARIOS.push({
  id: 'chain', label: 'Chain: Sale And Purchase', transactionType: 'freehold_purchase', hasLender: true,
  summary: "One client selling their home and buying another, both with us: the two cases linked, each holding exchange for the other, exchanged together on the same completion date, the sale completing first because its money funds the purchase.",
  steps: [
    // Both cases exist and are linked from the first step, as a firm acting on both sets them up.
    step('enrol', 'Purchase and sale enrolled for the same client, and linked as one chain', async (c) => {
      await c.run({ type: 'enrol', transactionType: 'freehold_purchase', hasLender: true, requireProofOfFunds: false, requireExchangeAuthority: true, requiredSearches: ['LLC1', 'CON29'] });
      const sale = await c.companion();
      await saleSteps[0].run(sale);
      await sale.settle();
      await c.svc.linkChain(c.tenantId, c.matterId, sale.matterId, c.userId);
    }),
    ...upTo(saleSteps, 'exchange').slice(1).map(onSale),
    ...idCheck(),
    ...searches(['LLC1', 'CON29']),
    ...mortgage(),
    ...title(false),
    ...sellerForms(false),
    ...enquiries(),
    ...reportOnTitle(),
    ...upTo(buyerExchange, 'exchange'),
    // The sale exchanges only once the purchase can; the purchase then exchanges on the same completion date.
    onSale(saleSteps.find((x) => x.id === 'exchange')!),
    ...from(buyerExchange, 'exchange').filter((x) => ['exchange'].includes(x.id)),
    // The sale completes first: its money funds the purchase.
    ...from(saleSteps, 'statement').map(onSale),
    ...from(buyerExchange, 'statement'),
  ],
});
