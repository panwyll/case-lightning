/**
 * Minimum viable context: what a conveyancer needs on screen to take one decision or
 * record one milestone from cold, without opening the file.
 *
 * It is deterministic — read from the case state, the event log and the matter record —
 * so it is instant, never wrong about a fact, and the same for everyone. What goes in is
 * decided per task (an AML result needs different facts from a CON29 flag or an exchange)
 * and per state (a leasehold adds the lease; a lender adds the offer and its expiry; a
 * near exchange adds the clock). The checks are the questions a careful conveyancer asks
 * for that task; they are prompts, not rules.
 */
import { profileOf } from './transactions';
import { whyNot, gate, type GateId } from './graph';
import { openIssues, openWaits, pendingDecisions, type DecisionState, type EngineEvent, type Flag, type IdCheckFacts, type MatterState, type Payloads, type SearchType } from './types';

export interface TaskContext {
  headline: string;
  /** The facts of this task, first: the enquiry and its reply, the offer and its conditions, the payee and the change. */
  task: Array<{ k: string; v: string; warn?: boolean }>;
  /** The case at a glance, trimmed to what this kind of task needs. */
  facts: Array<{ k: string; v: string }>;
  checks: string[];
  /**
   * The checks as the spine of the task: each one with what the file already says about it.
   * `ok` = the rules found nothing against it; `flag` = something to look at (the evidence says what);
   * `open` = only a person can answer it. Evidence lines cite the document they come from.
   */
  checklist: ChecklistItem[];
  /** The account of the file in plain lines, before any check: what was read, what it showed. Lines cite and link like evidence. */
  narrative: ChecklistItem['evidence'];
  /** One entry per document read, with what it is in a line and the lines worth looking at underneath (each payment, each gift receipt). */
  files: Array<{ documentId: string; title: string; summary: string; lines: ChecklistItem['evidence']; warn?: boolean }>;
  /** The checks the rules ran and passed, in words, for the collapsed "nothing to do" section. */
  passed: string[];
  /** Who put this in front of the firm, and when (the client's form, the provider's result). */
  submitted: { by: string; at: string | null } | null;
  history: Array<{ at: string; what: string }>;
  related: string[];
  unblocks: string | null;
}
export interface ChecklistItem {
  text: string;
  status: 'ok' | 'flag' | 'open';
  evidence: Array<{ text: string; documentId?: string | null; page?: number | null; quote?: string | null; /** Which occurrence of the quote in the document this line is (0 = first): three identical salary lines are three different places. */ quoteIndex?: number; warn?: boolean; /** One link per line the evidence rests on (each salary credit, each gift receipt): the label, and where it is. */ links?: Array<{ label: string; documentId: string; page?: number | null; quote?: string | null }> }>;
}
/** A bank statement as the pipeline read it, the parts the brief quotes (proof-of-funds.ts StatementFacts). */
export interface StatementFactsLite { accountHolder: string | null; periodFrom: string | null; periodTo: string | null; closingBalancePennies: number | null; transactions: Array<{ date: string; description: string; amountPennies: number; counterparty?: string | null }>; salaryCredits: Array<{ date: string; amountPennies: number; payer: string }> }

export interface MatterFacts {
  matterRef: string | null;
  propertyAddress: string | null;
  buyerNames?: string[] | null;
  sellerNames?: string[] | null;
  purchasePrice?: string | number | null;
  lender?: string | null;
  counterpartySolicitor?: string | null;
  counterpartyAgent?: string | null;
  exchangeTargetDate?: string | null;
  completionTargetDate?: string | null;
}

/** The read of the decision's source document: the ledger summary and any fact the page text could not confirm. */
export interface SourceReview { pages: number; read: number; withFacts: number; unreadable: number; unattested: number; complete: boolean; facts: number; verified: number; textLayer: boolean; unverified: Array<{ key: string; value: string; note: string | null }> }

export type ContextTarget =
  | { kind: 'decision'; decision: DecisionState }
  | { kind: 'command'; type: string; subject?: string | null };

const gbp = (p: number | null | undefined) => (p == null ? null : `£${Math.round(p / 100).toLocaleString('en-GB')}`);
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const daysUntil = (iso: string | null | undefined, now: Date) => (iso ? Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000) : null);
const pretty = (s: string) => s.replace(/_/g, ' ');
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const withClock = (iso: string | null | undefined, now: Date) => {
  const d = daysUntil(iso, now);
  return iso ? `${day(iso)}${d != null ? d < 0 ? ` (${-d} days ago)` : d === 0 ? ' (today)' : ` (${n(d, 'day')})` : ''}` : null;
};

const SEARCH_LABEL: Record<SearchType, string> = { LLC1: 'Local land charges (LLC1)', CON29: 'Local authority (CON29)', DRAINAGE_WATER: 'Drainage and water', ENVIRONMENTAL: 'Environmental', MINING: 'Coal mining (CON29M)', FLOOD: 'Flood risk', HIGHWAYS: 'Highways', PLANNING: 'Planning history', CHANCEL: 'Chancel repair' };
const SEARCH_CHECKS: Record<SearchType, string[]> = {
  LLC1: ['Financial charges, conservation area, listing, tree preservation orders: does the client know', 'Enforcement or planning contravention notices', 'Anything that breaches the lender handbook'],
  CON29: ['Planning history matches what the seller says was built, and when; building regulations sign-off for every alteration', 'Road and footpath adopted and maintained at public expense', 'Proposed road, rail or development schemes nearby', 'Contaminated land, radon and flooding entries', 'Does the flag change the price, the lender, or the advice'],
  DRAINAGE_WATER: ['Foul and surface water connected to the public sewer', 'A public sewer within 3m or under the building: build-over agreement', 'Water supply metered; no pending charges'],
  ENVIRONMENTAL: ['Flood risk, and whether insurance is available on ordinary terms', 'Contaminated land: past use and any remediation record', 'Subsidence, mining, landfill within the search radius', 'Whether the report recommends further action, and by whom'],
  CHANCEL: ['Whether liability is registered on the title', 'Whether an indemnity policy is the proportionate answer'],
  MINING: ['Past, present or planned coal mining beneath or near the property', 'Mine entries within 20 m', 'Subsidence claims and any Coal Authority damage notice'],
  FLOOD: ['River, surface water and groundwater risk bands', 'Whether insurance is available on ordinary terms (Flood Re)', 'Any flood defences the property depends on'],
  HIGHWAYS: ['Whether the road and footpath abutting the property are adopted', 'Any private road and who maintains it', 'Proposed road schemes'],
  PLANNING: ['Applications and decisions for the property and its neighbours', 'Consents for every alteration the seller disclosed', 'Enforcement action'],
};

const KIND_CHECKS: Record<string, string[]> = {
  id_check: ['Names on the ID match the instruction, the contract and the title exactly', 'Address on the proof of address matches the correspondence address', 'Document in date and not flagged as tampered', 'PEP or sanctions hit: escalate, never approve alone', 'Does the source of funds position change the risk'],
  enquiry: ['Does the reply answer the question actually asked', 'Is what it says backed by a document (certificate, consent, policy)', 'Does the answer create a new issue or a lender point', 'Further enquiry, indemnity, or report to the client: which is the right next step'],
  mortgage: ['Every special condition against the title and the searches', 'Offer expiry against the target exchange and completion dates', 'Advance, term and retention against the completion statement', 'Valuation against the price; any down-valuation', 'Lender handbook Part 2 requirements for this lender'],
  title: ['Registered proprietor is the seller named in the contract', 'Restrictions: whose consent or certificate is needed before registration', 'Charges to be discharged on completion, and the redemption position', "Covenants and easements: do they affect the client's intended use", 'Class of title; any caution or notice', 'Leasehold: term, ground rent and its review, forfeiture, consents'],
  report_on_title: ['Every search, enquiry and title point appears, with the advice', 'Mortgage conditions the client must meet', 'Dates and money: deposit, completion, retention', 'Plain English; nothing the client has not been told elsewhere'],
  proof_of_funds: ['Declared total covers price plus costs less mortgage', "Every source evidenced by statements in the client's name", 'Large or recent credits explained', "Gifts: donor identified, no repayment, donor's own funds", 'Higher-risk sources escalated, not signed off'],
  management_pack: ['Service charge, ground rent and arrears against the budget and the lease', 'Major works planned or levied', 'Buildings insurance in place and adequate', "Landlord's consents needed on assignment; any restriction on the title"],
  bank_details: ['Verify by a phone call to a number you already hold, or a Lawyer Checker match', 'Never confirm on the channel the details arrived on', 'Compare with any details held before: a change is the fraud signal', 'Pay nothing until this is resolved'],
  requisition: ['What HM Land Registry is asking for, exactly', 'The reply deadline and the priority period', 'Whether the answer needs the other side, the lender or the client'],
  escalation: ['What the handler decided and why they escalated', 'The same source they saw', 'Whether the position needs the client or the lender told'],
  proposal: ['Is this the right recipient and the right moment', 'Does anything on the case make this send unwise today'],
  auto_clear: ['Does the document say what the rule layer found', 'Anything the rules do not check that a person would notice'],
  note_actions: ['Does each proposed line say what the note actually says', 'Nothing recorded that the client did not say'],
};

const COMMAND_CHECKS: Record<string, string[]> = {
  contract_approved: ['Parties and price match the instruction and the memorandum of sale', 'Deposit amount and who holds it', 'Completion date and time; any conditional term', 'Special conditions and the fixtures list', 'Title number and plan match the official copy'],
  signed_contract_held: ['Every client signed; witnessed where the deed requires', "Undated, held to the other side's order or ours", 'Deposit funds cleared or their arrival dated'],
  deposit_received: ['Amount matches the contract', 'Cleared funds on client account', 'Source matches the proof of funds signed off'],
  contracts_exchanged: ["Client's authority recorded", 'Mortgage offer valid to completion; funds requested in time', 'Buildings insurance from exchange', 'Every gate item resolved or accepted in writing', 'Completion date agreed with the whole chain'],
  completion_statement_generated: ['Figures reconcile: price, deposit, advance, redemption, fees, SDLT', 'Retentions and apportionments', 'Sent to the client with the request for the balance'],
  funds_received: ['Amount matches the statement', 'From the expected account', 'Cleared, not merely credited'],
  completion_confirmed: ['Completion monies sent to verified details and receipt confirmed', 'Keys released; vacant possession', 'Redemption sent where due', 'The registration clock: SDLT 14 days, AP1 within the priority period'],
  mortgage_deed_executed: ['Every borrower signed; witnessed', 'Names exactly as on the offer', 'Undated until completion'],
  certificate_of_title_sent: ['Completion date matches the contract', 'Every offer condition satisfied or disclosed', 'Advance requested for the working day before completion where the lender needs it'],
  transfer_deed_executed: ['Every party signed; witnessed', 'Consideration and title number match the contract', 'Declaration of trust where tenants in common'],
  deed_of_trust_executed: ['Shares as instructed by both clients', 'Both signed; witnessed', 'Consistent with the TR1 declaration'],
  property_forms_received: ['Every question answered; nothing left blank', 'Answers consistent with the title and searches', 'Alterations: consents and certificates attached'],
  contract_pack_sent: ['Draft contract, official copies, plan, forms and any lease', 'Price, parties and title number correct', 'Special conditions reflect the instruction'],
  enquiry_replies_sent: ['Every enquiry answered or expressly declined', 'Replies from the client are in their words, not ours', 'Documents referred to are attached'],
  redemption_statement_received: ['Figure, daily rate and the date it is valid to', 'Early repayment charge included', 'Statement addressed to this account and property'],
  mortgage_redeemed: ['Amount matches the statement on the day', 'Sent to verified lender details', "Lender's confirmation received"],
  discharge_confirmed: ['DS1 or e-DS1 received and lodged', 'Charge removed from the register'],
  lender_consent_received: ['Consent covers this transfer and these parties', 'Conditions attached and who meets them'],
  sdlt_submitted: ['Return figures match the completion statement', 'Reliefs claimed and evidenced', 'UTRN and SDLT5 on file for HM Land Registry'],
  ap1_submitted: ['Within the priority period of the OS1', 'Every document HM Land Registry needs enclosed', 'Fee correct'],
  ap1_confirmed: ['Proprietor and charge as expected', 'Restrictions removed or as expected', 'Client sent the completed registration'],
  notice_of_assignment_served: ['Served on the party the lease names', 'Fee paid and receipted', 'Notice of charge where there is a lender'],
  client_decision_recorded: ["The client's own words, on a channel you can evidence", 'Everyone who must decide has decided', 'The decision is still open to them'],
};

/** Which gate a task bears on, for "what this unblocks". */
const GATE_FOR: Record<string, GateId> = {
  id_check: 'exchange', search: 'exchange', enquiry: 'exchange', mortgage: 'exchange', title: 'exchange', report_on_title: 'exchange', proof_of_funds: 'exchange', management_pack: 'exchange',
  contract_approved: 'exchange', signed_contract_held: 'exchange', deposit_received: 'exchange', property_forms_received: 'exchange', contract_pack_sent: 'exchange', enquiry_replies_sent: 'exchange', redemption_statement_received: 'exchange',
  contracts_exchanged: 'completion', completion_statement_generated: 'completion', funds_received: 'completion', mortgage_deed_executed: 'completion', certificate_of_title_sent: 'completion', transfer_deed_executed: 'completion', deed_of_trust_executed: 'completion', lender_consent_received: 'completion', bank_details: 'completion',
  completion_confirmed: 'registration', sdlt_submitted: 'registration', ap1_submitted: 'registration', ap1_confirmed: 'registration', mortgage_redeemed: 'registration', discharge_confirmed: 'registration', requisition: 'registration',
};

/** Event-type prefixes that belong to a decision kind's subject when the payload carries no id. */
const KIND_PREFIX: Record<string, string> = { id_check: 'id_check', mortgage: 'mortgage_offer', title: 'title', proof_of_funds: 'proof_of_funds', management_pack: 'management_pack', report_on_title: 'report_on_title', bank_details: 'bank_details', requisition: 'requisition' };

const flagWords = (flags: Array<{ code: string }>) => flags.map((f) => f.code.replace(/_/g, ' ').toLowerCase()).join(', ');

export function taskContext(input: { state: MatterState; matter: MatterFacts; events: EngineEvent[]; target: ContextTarget; now?: Date; review?: SourceReview | null; statementFacts?: Array<{ documentId: string; fileName: string | null; facts: StatementFactsLite }> | null; crosschecks?: Array<{ check: string; label: string; status: string; message: string }> | null }): TaskContext {
  const { state: s, matter: m, events, target } = input;
  const now = input.now ?? new Date();
  const p = profileOf(s.transactionType);
  const facts: TaskContext['facts'] = [];
  const add = (k: string, v: string | null | undefined) => { if (v) facts.push({ k, v }); };
  const task: TaskContext['task'] = [];
  const addT = (k: string, v: string | null | undefined, warn = false) => { if (v) task.push({ k, v, warn }); };
  const kind = target.kind === 'decision' ? target.decision.kind : target.type;
  const wantsTitle = /title|report_on_title|management_pack|mortgage|contract|exchange|transfer|deed/.test(kind);
  const wantsMoney = /proof_of_funds|bank_details|deposit|funds|completion|payment|redemption/.test(kind);
  const raised = target.kind === 'decision' ? events.find((e) => e.id === target.decision.eventId) ?? null : null;
  const flagLines = (flags: Flag[] | undefined) => (flags ?? []).map((f) => `${f.severity === 'high' ? '‼ ' : f.severity === 'medium' ? '! ' : ''}${f.description || f.code.replace(/_/g, ' ').toLowerCase()}`).join(' · ');
  const mask = (d: { sortCode: string; accountNumber: string; accountName: string; firmName: string | null }) => `${d.accountName}${d.firmName ? ` (${d.firmName})` : ''} · ${d.sortCode.replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3')} ····${d.accountNumber.slice(-4)}`;

  // ── The case at a glance: always ──
  const clients = p.side === 'seller' ? m.sellerNames : m.buyerNames;
  const others = p.side === 'seller' ? m.buyerNames : m.sellerNames;
  add('Client', clients?.filter(Boolean).join(' & ') || null);
  add(p.side === 'seller' ? 'Buyer' : p.side === 'buyer' ? 'Seller' : 'Other party', others?.filter(Boolean).join(' & ') || null);
  add('Transaction', p.label);
  const priceFromMatter = m.purchasePrice != null && m.purchasePrice !== '' ? Math.round(Number(String(m.purchasePrice).replace(/[£,\s]/g, '')) * 100) : null;
  add('Price', gbp(s.purchasePricePennies ?? (Number.isFinite(priceFromMatter) ? priceFromMatter : null)));
  add(p.counterparty.replace(/^./, (c) => c.toUpperCase()), m.counterpartySolicitor || null);
  add('Stage', pretty(s.stage).replace(/^./, (c) => c.toUpperCase()));
  // ── Dates: contractual once exchanged, targets before ──
  if (s.exchange.exchangedAt) {
    add('Exchanged', day(s.exchange.exchangedAt));
    add('Completion', withClock(s.exchange.completionDate, now));
  } else if (p.hasExchange) {
    add('Target exchange', withClock(s.targetExchangeDate ?? m.exchangeTargetDate, now));
    add('Target completion', day(s.targetCompletionDate ?? m.completionTargetDate));
  } else {
    add('Target completion', withClock(s.targetCompletionDate ?? m.completionTargetDate, now));
  }
  // ── Conditional: the lender and its offer, the lease, the money, open trouble ──
  if (s.hasLender) {
    const f = s.mortgage.facts;
    add('Lender', f?.lender ?? m.lender ?? null);
    if (f?.amountPennies) add('Advance', gbp(f.amountPennies));
    if (f?.expiryDate) add('Offer expires', withClock(f.expiryDate, now));
    else if (s.mortgage.status !== 'not_required') add('Mortgage offer', pretty(s.mortgage.status));
  }
  if (wantsTitle && s.title.facts?.titleNumber) add('Title', `${s.title.facts.titleNumber} · ${s.title.facts.tenure}`);
  if (wantsTitle && (p.tenure === 'leasehold' || s.title.facts?.tenure === 'leasehold')) {
    const l = s.title.facts?.lease;
    if (l?.unexpiredYears != null) add('Lease term left', n(l.unexpiredYears, 'year'));
    if (l?.groundRentPenniesPa != null) add('Ground rent', `${gbp(l.groundRentPenniesPa)} a year${l.groundRentReview ? ` · ${l.groundRentReview}` : ''}`);
    const mp = s.managementPack?.facts;
    if (mp?.serviceChargePenniesPa != null) add('Service charge', `${gbp(mp.serviceChargePenniesPa)} a year`);
    if (mp?.arrearsPennies) add('Arrears', gbp(mp.arrearsPennies));
  }
  if (wantsMoney && s.requireProofOfFunds && s.proofOfFunds.status !== 'not_started') add('Proof of funds', s.proofOfFunds.approvedAt ? 'signed off' : pretty(s.proofOfFunds.status));
  const issues = openIssues(s);
  if (issues.length) add('Open issues', issues.slice(0, 3).map((i) => i.title).join('; ') + (issues.length > 3 ? ` +${issues.length - 3}` : ''));

  // ── The task itself ──
  let headline = '';
  let checks: string[] = [];
  let subjectKey: string | null = null;
  let prefix: string | null = null;
  const gateId: GateId | null = GATE_FOR[target.kind === 'decision' ? target.decision.kind : target.type] ?? null;
  if (target.kind === 'decision') {
    const d = target.decision;
    subjectKey = d.subject ? d.subject.split(':').pop() ?? null : null;
    prefix = KIND_PREFIX[d.kind] ?? null;
    const rp = (raised?.payload ?? {}) as Record<string, unknown>;
    if (d.kind === 'search') {
      const st = subjectKey as SearchType;
      const sr = s.searches[st];
      const flags = (raised?.type === 'search_flagged' ? (rp as Payloads['search_flagged']).flags : sr?.flags) ?? [];
      headline = `${SEARCH_LABEL[st] ?? st} came back ${flags.length ? `with ${n(flags.length, 'point')}: ${flagWords(flags)}` : 'clear'}.`;
      addT('Search', SEARCH_LABEL[st] ?? st);
      addT('Ordered', day(sr?.orderedAt));
      addT('Returned', day(sr?.returnedAt));
      addT('Points', flagLines(flags), flags.some((f) => f.severity === 'high'));
      const sf = sr?.facts?.summaryFields ?? {};
      const keyEntries = Object.entries(sf).filter(([, v]) => v !== null && v !== '' && v !== false).slice(0, 6).map(([k, v]) => `${pretty(k)}: ${String(v)}`).join(' · ');
      addT('Key entries', keyEntries || null);
      if (sr && sr.cycle > 1) addT('Cycle', `re-ordered (cycle ${sr.cycle})`);
      checks = SEARCH_CHECKS[st] ?? [];
    } else if (d.kind === 'enquiry') {
      const q = s.enquiries[subjectKey ?? ''];
      const raisedEv = events.find((e) => e.type === 'enquiry_raised' && (e.payload as { enquiryId?: string }).enquiryId === subjectKey);
      const replyEv = [...events].reverse().find((e) => e.type === 'enquiry_reply_received' && (e.payload as { enquiryId?: string }).enquiryId === subjectKey);
      const rf = replyEv ? (replyEv.payload as Payloads['enquiry_reply_received']).facts : null;
      const origin = raisedEv ? (raisedEv.payload as Payloads['enquiry_raised']).origin : null;
      const flags = raised?.type === 'enquiry_reply_flagged' ? (rp as Payloads['enquiry_reply_flagged']).flags : [];
      headline = q ? `Reply to enquiry ${q.enquiryId}, ${q.subject}: ${rf?.status === 'partial' ? 'answers part of it' : rf?.status === 'refused' ? 'declines to answer' : rf?.status === 'unclear' ? 'is unclear' : rf?.status === 'answered' ? 'answers it' : 'needs reading'}.` : `Reply to enquiry ${subjectKey ?? ''}.`;
      addT('Enquiry', q ? `${q.enquiryId} · ${q.subject}` : subjectKey);
      addT('Raised', raisedEv ? `${day(raisedEv.createdAt)}${raisedEv.actor === 'system' ? ' by the rules' : ' by a person'}${origin?.issueId ? ` from issue ${origin.issueId}` : origin?.followUpOf ? ` as a follow-up to ${origin.followUpOf}` : ''}` : null);
      addT('Reply received', day(replyEv?.createdAt ?? q?.repliedAt));
      addT('Reply reads as', rf ? `${rf.status}${rf.confidence < 0.85 ? ` (read with ${Math.round(rf.confidence * 100)}% confidence)` : ''}` : null, rf?.status === 'refused' || rf?.status === 'unclear');
      addT('Points', flagLines(flags.length ? flags : rf?.issues), flags.some((f) => f.severity === 'high'));
      const others = Object.values(s.enquiries).filter((e) => e.enquiryId !== subjectKey && (e.status === 'raised' || e.status === 'flagged'));
      addT('Other enquiries open', others.length ? others.map((e) => `${e.enquiryId} ${e.status === 'flagged' ? '(reply in)' : '(awaiting reply)'}`).join(', ') : null);
      checks = KIND_CHECKS.enquiry;
    } else if (d.kind === 'mortgage') {
      const f = s.mortgage.facts;
      const flags = raised?.type === 'mortgage_condition_flagged' ? (rp as Payloads['mortgage_condition_flagged']).flags : [];
      const flagged = flags.length ? flags.length : (f?.conditions ?? []).filter((c) => !c.standard).length;
      headline = `${f?.lender ?? m.lender ?? 'The lender'}'s offer${f?.amountPennies ? ` of ${gbp(f.amountPennies)}` : ''}: ${n(flagged, 'point')} the rules could not clear.`;
      addT('Lender', f?.lender ?? m.lender ?? null);
      addT('Advance', gbp(f?.amountPennies));
      if (f?.expiryDate) {
        const te = s.targetExchangeDate ?? m.exchangeTargetDate;
        const dte = te ? Math.ceil((new Date(f.expiryDate).getTime() - new Date(te).getTime()) / 86_400_000) : null;
        addT('Expires', `${withClock(f.expiryDate, now)}${dte != null ? dte < 0 ? ` · ${-dte} days BEFORE target exchange` : ` · ${dte} days after target exchange` : ''}`, dte != null && dte < 28);
      }
      addT('Conditions flagged', flagLines(flags) || (f?.conditions ?? []).filter((c) => !c.standard).map((c) => c.text).join(' · ') || null, flags.some((x) => x.severity === 'high'));
      addT('Standard conditions cleared', f ? String(f.conditions.filter((c) => c.standard).length) : null);
      if (s.mortgage.status === 'awaiting' || s.mortgage.status === 'not_required') addT('Offer now', 'withdrawn or replaced since this was raised — check the current offer before deciding', true);
      checks = KIND_CHECKS.mortgage;
    } else if (d.kind === 'title') {
      const f = s.title.facts;
      const flags = raised?.type === 'title_flagged' ? (rp as Payloads['title_flagged']).flags : [];
      headline = f ? `Title ${f.titleNumber} (${f.tenure}): ${n(f.restrictions.length, 'restriction')}, ${n(f.charges.length, 'charge')}, ${n(f.covenants.length, 'covenant')}.` : 'The title needs a person.';
      addT('Title', f ? `${f.titleNumber} · ${f.tenure}${p.tenure !== 'any' && f.tenure !== 'unknown' && f.tenure !== p.tenure ? ` (instruction says ${p.tenure})` : ''}` : null, !!f && p.tenure !== 'any' && f.tenure !== 'unknown' && f.tenure !== p.tenure);
      addT('Restrictions', f?.restrictions.length ? f.restrictions.map((r) => r.text).join(' · ') : null);
      addT('Charges', f?.charges.length ? f.charges.map((r) => r.text).join(' · ') : null);
      addT('Covenants', f?.covenants.length ? f.covenants.map((r) => r.text).join(' · ') : null);
      if (f?.lease) addT('Lease', [f.lease.unexpiredYears != null ? `${f.lease.unexpiredYears} years left` : null, f.lease.groundRentPenniesPa != null ? `ground rent ${gbp(f.lease.groundRentPenniesPa)} a year` : null, f.lease.groundRentReview, f.lease.landlord ? `landlord ${f.lease.landlord}` : null].filter(Boolean).join(' · '), (f.lease.unexpiredYears ?? 99) < 85);
      addT('Points', flagLines(flags), flags.some((x) => x.severity === 'high'));
      checks = KIND_CHECKS.title;
    } else if (d.kind === 'id_check') {
      const f = raised?.type === 'id_check_flagged' ? (rp as Payloads['id_check_flagged']).facts : null;
      headline = `ID and AML check: ${f?.outcome ?? 'referred'}${f?.flags?.length ? ` — ${flagWords(f.flags)}` : ''}${f?.provider ? ` (${f.provider})` : ''}.`;
      addT('Provider', f?.provider ?? null);
      addT('Outcome', f?.outcome ?? null, f?.outcome === 'fail');
      addT('Points', flagLines(f?.flags), (f?.flags ?? []).some((x) => x.severity === 'high'));
      addT('Clients', (p.side === 'seller' ? m.sellerNames : m.buyerNames)?.filter(Boolean).join(' & ') || null);
      checks = KIND_CHECKS.id_check;
    } else if (d.kind === 'proof_of_funds') {
      const f = s.proofOfFunds.facts;
      headline = f ? `Declared ${gbp(f.totalDeclaredPennies)}${f.requiredPennies != null ? ` against ${gbp(f.requiredPennies)} needed` : ''}${f.shortfallPennies ? `; shortfall ${gbp(f.shortfallPennies)}` : ''}${f.giftedPennies ? `; ${gbp(f.giftedPennies)} gifted` : ''}.` : 'Proof of funds submitted.';
      addT('Declared by', f?.declarantName ?? null);
      addT('Needed', f?.requiredPennies != null ? `${gbp(f.requiredPennies)} (price ${gbp(f.purchasePricePennies)} less mortgage ${gbp(f.mortgageAdvancePennies ?? 0)})` : null);
      addT('Declared', gbp(f?.totalDeclaredPennies));
      addT('Shortfall', f?.shortfallPennies ? gbp(f.shortfallPennies) : null, !!f?.shortfallPennies);
      addT('Sources', f?.sources?.length ? f.sources.map((x) => `${pretty(x.kind)} ${gbp(x.amountPennies)}${x.gift ? ' (gift)' : ''}${x.overseas ? ' (overseas)' : ''}${x.evidenceCount ? '' : ' — no evidence'}`).join(' · ') : null);
      addT('Risk', s.proofOfFunds.risk ?? null, s.proofOfFunds.risk === 'enhanced');
      const oq = Object.values(s.proofOfFunds.queries ?? {}).filter((q) => q.status === 'draft' || q.status === 'sent');
      addT('Open queries', oq.length ? oq.map((q) => `${q.id} (${q.status})`).join(', ') : null, oq.length > 0);
      addT('Round', String(s.proofOfFunds.rounds || 1));
      checks = KIND_CHECKS.proof_of_funds;
    } else if (d.kind === 'bank_details') {
      const b = s.bankDetails[subjectKey ?? ''] ?? Object.values(s.bankDetails).find((x) => x.decisionEventId === d.eventId) ?? null;
      const prev = b?.supersedesId ? s.bankDetails[b.supersedesId] : null;
      headline = b ? `${prev ? 'Change of' : 'New'} bank details for ${pretty(b.payeeKind)}${b.payeeRef ? ` (${b.payeeRef})` : ''}, arrived by ${pretty(b.sourceChannel)}.` : d.summary.split('\n')[0].slice(0, 200);
      addT('Payee', b ? `${pretty(b.payeeKind)}${b.payeeRef ? ` · ${b.payeeRef}` : ''}` : null);
      addT('New details', b ? mask(b.details) : null);
      addT('Previously on file', prev ? `${mask(prev.details)} · ${prev.verifiedAt ? `verified ${day(prev.verifiedAt)}` : prev.status === 'superseded' ? 'never verified' : prev.status}` : b ? 'nothing for this payee' : null, !!prev);
      addT('Arrived by', b ? `${pretty(b.sourceChannel)} on ${day(b.recordedAt)}${b.recordedBy === 'external' ? ', from outside' : b.recordedBy === 'system' || b.recordedBy === 'ai' ? ', read by the engine' : ', recorded by a person'}` : null);
      addT('Payments due to this payee', b ? (b.payeeKind === 'seller_solicitor' && p.side === 'buyer' ? 'completion monies' : b.payeeKind === 'lender' ? 'redemption' : b.payeeKind === 'client' ? 'balance after completion' : 'none tracked') : null);
      checks = KIND_CHECKS.bank_details;
    } else if (d.kind === 'report_on_title') {
      const basedOn = raised?.type === 'report_on_title_drafted' ? (rp as Payloads['report_on_title_drafted']).basedOn : [];
      const pendingBits = [
        ...Object.values(s.enquiries).filter((e) => e.status === 'raised' || e.status === 'flagged').map((e) => `enquiry ${e.enquiryId}`),
        ...Object.values(s.searches).filter((x) => x.status === 'ordered' || x.status === 'flagged').map((x) => `${x.searchType} search`),
        ...(s.hasLender && s.mortgage.status !== 'cleared' && s.mortgage.status !== 'reviewed' ? ['mortgage offer'] : []),
        ...(s.requireProofOfFunds && !s.proofOfFunds.approvedAt ? ['proof of funds'] : []),
      ];
      headline = `Draft report on title from ${n(basedOn.length, 'source document')}${pendingBits.length ? `; ${n(pendingBits.length, 'thing')} still open that it cannot yet cover` : ''}.`;
      addT('Drafted', raised ? `${day(raised.createdAt)} by ${(rp as { model?: string }).model ?? 'the drafter'}` : null);
      addT('Based on', basedOn.length ? `${basedOn.length} documents (title, searches, replies filed to date)` : null);
      addT('Still open, not in the report', pendingBits.length ? pendingBits.join(', ') : null, pendingBits.length > 0);
      checks = KIND_CHECKS.report_on_title;
    } else if (d.kind === 'proposal') {
      const pr = s.proposals[d.eventId] ?? Object.values(s.proposals).find((x) => x.eventId === d.eventId) ?? null;
      const det = (pr?.detail ?? (rp as { detail?: Record<string, unknown> }).detail ?? {}) as Record<string, unknown>;
      const action = pr?.action ?? (rp as { action?: string }).action ?? d.subject ?? '';
      const to = (det.recipientRole as string) ?? (det.kind === 'proof_of_funds_request' || det.kind === 'id_check_request' ? 'client' : action === 'client_update' ? 'client' : null);
      const hasDetail = Object.keys(det).length > 0;
      headline = hasDetail
        ? `The engine wants to ${action === 'chase' ? `chase ${pretty(String(to ?? 'the party'))}` : action === 'acknowledgement' ? `acknowledge to ${pretty(String(to ?? 'the sender'))}` : action === 'search_order' ? `order the ${det.searchType ?? ''} search` : action === 'client_update' ? 'update the client' : pretty(action)}.`
        : `The engine proposed ${pretty(action)}: ${d.summary.split('\n')[0].slice(0, 160)}`;
      if (hasDetail) addT('Would send', action === 'chase' ? `chase for ${pretty(String(det.waitKey ?? ''))}${det.subject ? ` ${det.subject}` : ''}${det.template ? ` (${det.template})` : ''}` : action === 'acknowledgement' ? `acknowledgement of ${det.what ?? 'a delivery'}` : action === 'client_update' ? `client update: ${pretty(String(det.template ?? det.kind ?? ''))}` : action === 'search_order' ? `order for ${det.searchType} from ${det.provider ?? 'the provider'}` : pretty(action));
      addT('To', to ? pretty(String(to)) : null);
      if (action === 'chase') {
        const w = openWaits(s).find((x) => x.key === det.waitKey && (!det.subject || x.subject === det.subject));
        if (w) addT('Outstanding since', `${day(w.openedAt)}${w.chasesSentAt.length ? ` · chased ${w.chasesSentAt.length}× (last ${day(w.chasesSentAt[w.chasesSentAt.length - 1])})` : ' · not chased yet'}`);
      }
      addT('Proposed', day(pr?.proposedAt ?? raised?.createdAt));
      checks = KIND_CHECKS.proposal;
    } else if (d.kind === 'auto_clear') {
      const ac = raised?.type === 'auto_clear_review_raised' ? (rp as Payloads['auto_clear_review_raised']) : null;
      headline = `The rules cleared ${ac ? pretty(ac.subFlow) : pretty(d.subject ?? '')}${ac?.subject ? ` (${ac.subject.split(':').pop()})` : ''}; confirm or send it back.`;
      addT('Cleared', ac ? `${pretty(ac.subFlow)} · ${ac.subject.split(':').pop()}` : null);
      addT('Because', ac?.reasons?.length ? ac.reasons.join(' · ') : null);
      checks = KIND_CHECKS.auto_clear;
    } else if (d.kind === 'escalation') {
      const es = raised?.type === 'escalation_raised' ? (rp as Record<string, unknown>) : {};
      headline = `Escalated: ${pretty(String(es.waitKey ?? es.kind ?? d.subject ?? ''))}${es.subject ? ` ${es.subject}` : ''}.`;
      addT('Why', (es.reason as string) ?? d.summary.split('\n')[0]);
      const w = openWaits(s).find((x) => x.key === es.waitKey && (!es.subject || x.subject === es.subject));
      if (w) addT('Outstanding since', `${day(w.openedAt)} · chased ${w.chasesSentAt.length}×`, true);
      checks = KIND_CHECKS.escalation;
    } else {
      headline = d.summary.split('\n')[0].slice(0, 200);
      checks = KIND_CHECKS[d.kind] ?? [];
    }
  } else {
    subjectKey = target.subject ?? null;
    prefix = target.type.replace(/_(received|sent|executed|submitted|confirmed|generated|held|approved|exchanged|redeemed|served|recorded)$/, '');
    checks = COMMAND_CHECKS[target.type] ?? [];
    headline = `Recording ${pretty(target.type)} at ${pretty(s.stage)}.`;
  }

  // ── The read of the source: was every page read, and which facts the page text could not confirm ──
  const rv = input.review;
  if (rv && rv.pages > 0) {
    const bits = [`${rv.read} of ${rv.pages} page${rv.pages === 1 ? '' : 's'} read`];
    if (rv.withFacts) bits.push(`${rv.withFacts} with facts`);
    if (rv.unreadable) bits.push(`${rv.unreadable} unreadable`);
    if (rv.unattested) bits.push(`${rv.unattested} not attested`);
    if (!rv.textLayer) bits.push('no text layer, quotes unchecked');
    task.unshift({ k: 'Read', v: bits.join(' · '), warn: !rv.complete || rv.unreadable > 0 });
    if (rv.facts) task.push({ k: 'Facts checked', v: `${rv.verified} of ${rv.facts} quotes found on the page${rv.unverified.length ? ` · unconfirmed: ${rv.unverified.slice(0, 4).map((u) => `${u.key.split('.').slice(-1)[0]} (${u.note ?? 'no quote'})`).join(', ')}${rv.unverified.length > 4 ? ` +${rv.unverified.length - 4}` : ''}` : ''}`, warn: rv.verified < rv.facts && rv.textLayer });
  }

  // ── Cross-checks: documents that disagree with each other or the case record ──
  for (const c of (input.crosschecks ?? []).filter((x) => x.status === 'mismatch')) task.push({ k: 'Documents disagree', v: c.message, warn: true });

  // ── History: what already happened on this subject ──
  const touches = (e: EngineEvent) => {
    if (e.type === 'decision_source_opened') return false;
    const pl = e.payload as Record<string, unknown>;
    if (subjectKey && [pl.searchType, pl.enquiryId, pl.subject, pl.requestId, pl.bankDetailsId, pl.draftId].includes(subjectKey)) return true;
    return !!prefix && e.type.startsWith(prefix);
  };
  const who = (a: string) => (a === 'system' || a === 'ai' ? '' : a === 'external' ? ' · from outside' : ' · by a person');
  const history = events.filter(touches).slice(-8).map((e) => ({ at: e.createdAt, what: `${pretty(e.type)}${who(e.actor)}` }));

  // ── Related: the rest of the case that bears on this ──
  const related: string[] = [];
  if (s.hasLender && s.mortgage.facts?.expiryDate) { const d = daysUntil(s.mortgage.facts.expiryDate, now); if (d != null && d <= 30) related.push(d < 0 ? 'Mortgage offer has expired' : `Mortgage offer expires in ${n(d, 'day')}`); }
  if (!s.exchange.exchangedAt && p.hasExchange) { const d = daysUntil(s.targetExchangeDate ?? m.exchangeTargetDate, now); if (d != null && d <= 14) related.push(d < 0 ? 'Target exchange has passed' : `Target exchange in ${n(d, 'day')}`); }
  for (const dd of pendingDecisions(s)) {
    if (target.kind === 'decision' && dd.eventId === target.decision.eventId) continue;
    if (dd.kind === 'auto_clear' || dd.kind === 'proposal') continue;
    const subj = dd.subject ? dd.subject.split(':').pop() ?? '' : '';
    related.push(`Also waiting on you: ${pretty(dd.kind)}${subj && subj.length <= 16 ? ` ${subj}` : ''}`);
  }
  for (const w of openWaits(s)) related.push(`Waiting on ${pretty(w.key)}${w.subject && !/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(w.subject) ? ` ${w.subject}` : ''} since ${day(w.openedAt)}${w.chasesSentAt.length ? `, chased ${w.chasesSentAt.length}×` : ''}`);

  // ── What this unblocks ──
  let unblocks: string | null = null;
  if (gateId && s.enrolled) {
    const g = gate(s, gateId);
    // Everything else the gate needs: this task's own line is dropped, so the list is what remains after it.
    const noun = target.kind === 'command' ? target.type.split('_')[0].replace(/s$/, '') : null;
    const mine = (line: string) =>
      (subjectKey ? line.includes(`(${subjectKey})`) : false) ||
      (target.kind === 'decision' && line.includes(`${pretty(target.decision.kind)} decision pending`) && !line.includes('(')) ||
      (!!noun && line.toLowerCase().startsWith(noun));
    const tidy = (line: string) => line.replace(/\s*\((?:[a-z]+-)?[0-9a-f-]{20,}\)/g, '').replace(/\s+(?:[a-z]+-)?[0-9a-f]{8}-[0-9a-f-]{27,}/g, '').replace(/\s*\(chased 0×\)/g, '');
    const rest = whyNot(s, gateId).filter((line) => !mine(line)).map(tidy);
    unblocks = g.ready ? `${g.label}: ready.` : rest.length === 0 ? `This is the last thing before ${g.label.toLowerCase()}.` : `${g.label} still needs ${n(rest.length, 'other thing')}: ${rest.slice(0, 4).join('; ')}${rest.length > 4 ? '…' : ''}`;
  }

  const built = target.kind === 'decision' ? buildChecklist(s, target.decision, checks, raised, { crosschecks: input.crosschecks ?? [], review: input.review ?? null, statementFacts: input.statementFacts ?? [], matter: m, now }) : { checklist: checks.map((text) => ({ text, status: 'open' as const, evidence: [] })), narrative: [], files: [], passed: [], submitted: null };
  if (target.kind === 'decision' && target.decision.kind === 'proof_of_funds' && s.proofOfFunds.facts) {
    const f = s.proofOfFunds.facts;
    headline = f.sources.map((src) => `${gbp(src.amountPennies)} ${src.kind === 'gift' && src.gift ? `gift from ${src.gift.donorName}${src.gift.donorRelationship ? ` (${src.gift.donorRelationship})` : ''}` : pretty(src.kind).toLowerCase()}`).join(', ');
  }
  return { headline, task, facts, checks, checklist: built.checklist, narrative: built.narrative, files: built.files ?? [], passed: built.passed ?? [], submitted: built.submitted ?? null, history, related: related.slice(0, 6), unblocks };
}

const STOP = new Set(['the', 'and', 'with', 'from', 'that', 'this', 'what', 'against', 'every', 'their', 'where', 'which', 'does', 'into', 'been', 'have', 'client', 'clients', 'lender', 'source', 'sources']);
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
const seeTail = (t: string) => t.replace(/\s*\((?:see|at) [^)]*\)\s*$/i, '');
const flagsOf = (raised: EngineEvent | null): Flag[] => {
  const p = (raised?.payload ?? {}) as { flags?: Flag[]; facts?: { flags?: Flag[]; issues?: Flag[]; conditions?: Array<{ code: string; text: string; standard?: boolean; locator?: Flag['locator'] }>; restrictions?: Array<{ code: string; text: string; locator?: Flag['locator'] }>; charges?: Array<{ code: string; text: string; locator?: Flag['locator'] }>; covenants?: Array<{ code: string; text: string; locator?: Flag['locator'] }> } };
  if (Array.isArray(p.flags) && p.flags.length) return p.flags;
  const f = p.facts;
  if (!f) return [];
  if (Array.isArray(f.flags) && f.flags.length) return f.flags;
  if (Array.isArray(f.issues) && f.issues.length) return f.issues;
  const out: Flag[] = [];
  for (const c of f.conditions ?? []) if (!c.standard) out.push({ code: c.code, severity: 'medium', description: c.text, locator: c.locator });
  for (const [label, arr] of [['restriction', f.restrictions], ['charge', f.charges], ['covenant', f.covenants]] as const) for (const e of arr ?? []) out.push({ code: e.code, severity: 'low', description: `${label}: ${e.text}`, locator: e.locator });
  return out;
};

type Ev = ChecklistItem['evidence'][number];
interface BuildExtras { crosschecks: Array<{ check: string; label: string; status: string; message: string }>; review: SourceReview | null; statementFacts: Array<{ documentId: string; fileName: string | null; facts: StatementFactsLite }>; matter: MatterFacts; now: Date }
const item = (text: string, status: ChecklistItem['status'], evidence: Ev[] = []): ChecklistItem => ({ text, status, evidence });
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '');
const monthName = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { month: 'short' });

/**
 * The checks with the evidence the file holds for each: what a careful paralegal would put in
 * front of the conveyancer, kind by kind, and nothing the form or the rules have already settled.
 */
type Built = { checklist: ChecklistItem[]; narrative: Ev[]; files?: TaskContext['files']; passed?: string[]; submitted?: TaskContext['submitted'] };
function buildChecklist(s: MatterState, d: DecisionState, checks: string[], raised: EngineEvent | null, x: BuildExtras): Built {
  const built = buildChecklistItems(s, d, checks, raised, x);
  return Array.isArray(built) ? { checklist: built, narrative: [] } : built;
}

function buildChecklistItems(s: MatterState, d: DecisionState, checks: string[], raised: EngineEvent | null, x: BuildExtras): ChecklistItem[] | Built {
  const docId = d.sourceDocumentId ?? null;
  const rp = (raised?.payload ?? {}) as Record<string, unknown>;
  const flagEv = (f: Flag, documentId: string | null = docId): Ev => ({ text: seeTail(f.description), documentId, page: f.locator?.page ?? null, quote: f.locator?.quote ?? f.locator?.section ?? null, warn: f.severity === 'high' || f.severity === 'medium' });
  const mismatch = (check: string) => x.crosschecks.find((c) => c.check === check && c.status === 'mismatch');

  if (d.kind === 'proof_of_funds' && s.proofOfFunds.facts) return pofChecklist(s, docId, x);

  if (d.kind === 'search') {
    const f = rp.facts as { flags?: Flag[] } | undefined;
    const flags = f?.flags ?? [];
    return attachFlags(checks, flags, docId, flags.length ? [] : [{ text: 'The search came back with nothing the rules flag' }]);
  }
  if (d.kind === 'enquiry') {
    const f = rp.facts as { enquiryId?: string; status?: string; issues?: Flag[] } | undefined;
    const q = f?.enquiryId ? s.enquiries[f.enquiryId] : null;
    const status = f?.status ?? 'unclear';
    const out: ChecklistItem[] = [
      item('The reply answers the question actually asked', status === 'answered' ? 'ok' : 'flag', [
        { text: `Asked: ${q?.subject ?? d.subject ?? 'the enquiry'}` },
        { text: `The reply ${status === 'answered' ? 'answers it' : status === 'partial' ? 'answers part of it' : status === 'refused' ? 'declines to answer' : 'is unclear'}`, documentId: docId, warn: status !== 'answered' },
        ...(f?.issues ?? []).map((fl) => flagEv(fl)),
      ]),
      ...checks.slice(1).map((t) => item(t, 'open')),
    ];
    return out;
  }
  if (d.kind === 'mortgage') {
    const f = s.mortgage.facts;
    const special = f?.conditions.filter((c) => !c.standard) ?? [];
    const standard = f?.conditions.filter((c) => c.standard).length ?? 0;
    const target = s.targetExchangeDate ?? x.matter.exchangeTargetDate ?? null;
    const daysLeft = f?.expiryDate ? Math.round((Date.parse(f.expiryDate) - x.now.getTime()) / 86_400_000) : null;
    const tight = f?.expiryDate && target ? Date.parse(f.expiryDate) < Date.parse(target) + 14 * 86_400_000 : false;
    const names = mismatch('buyer_names');
    return [
      item('Every special condition is something the file can meet', special.length ? 'flag' : 'ok', [
        ...(special.length ? special.map((c) => ({ text: `${c.code}: ${c.text}`, documentId: docId, page: c.locator?.page ?? null, quote: c.locator?.quote ?? c.text.slice(0, 80), warn: true })) : [{ text: 'No special conditions' }]),
        ...(standard ? [{ text: `${n(standard, 'standard condition')} the rules cleared (insurance, occupancy, the usual)` }] : []),
      ]),
      item('The offer is valid to completion', daysLeft != null && daysLeft < 0 ? 'flag' : tight ? 'flag' : daysLeft == null ? 'open' : 'ok', [
        { text: f?.expiryDate ? `Expires ${day(f.expiryDate)}${daysLeft != null ? ` (${daysLeft < 0 ? `${-daysLeft} days ago` : `in ${daysLeft} days`})` : ''}${target ? ` · target exchange ${day(target)}` : ' · no target exchange date set'}` : 'No expiry date read from the offer', warn: !!tight || (daysLeft != null && daysLeft < 0), documentId: docId },
      ]),
      item('Advance, lender and names match the instruction', names ? 'flag' : 'ok', [
        { text: `${f?.lender ?? 'Lender not read'}${f?.amountPennies ? ` · advance ${gbp(f.amountPennies)}` : ''}${s.purchasePricePennies && f?.amountPennies ? ` · ${pct(f.amountPennies, s.purchasePricePennies)} of the price` : ''}`, documentId: docId },
        ...(names ? [{ text: names.message, warn: true }] : []),
      ]),
      item('Valuation against the price; any down-valuation', 'open'),
    ];
  }
  if (d.kind === 'title') {
    const f = s.title.facts;
    const sellers = mismatch('seller_names');
    const entries = (label: string, arr: { code: string; text: string; locator?: { page?: number; quote?: string; section?: string } }[]): Ev[] => arr.map((e) => ({ text: `${e.code}: ${e.text}`, documentId: docId, page: e.locator?.page ?? null, quote: e.locator?.quote ?? e.text.slice(0, 80), warn: true }));
    const out: ChecklistItem[] = [
      item('The registered proprietor is the seller named in the contract', sellers ? 'flag' : x.crosschecks.some((c) => c.check === 'seller_names' && c.status === 'match') ? 'ok' : 'open', [
        { text: `${f?.titleNumber ?? 'Title'} · ${f?.tenure ?? 'tenure unknown'}${f?.unregistered ? ' · UNREGISTERED' : ''}`, documentId: docId },
        ...(sellers ? [{ text: sellers.message, warn: true }] : []),
      ]),
      item('Restrictions: whose consent or certificate is needed before registration', f?.restrictions.length ? 'flag' : 'ok', f?.restrictions.length ? entries('restriction', f.restrictions) : [{ text: 'No restriction on the proprietorship register' }]),
      item('Charges to be discharged on completion', f?.charges.length ? 'flag' : 'ok', f?.charges.length ? entries('charge', f.charges) : [{ text: 'No registered charge' }]),
      item("Covenants and easements: do they affect the client's use or the lender", f?.covenants.length ? 'flag' : 'ok', f?.covenants.length ? entries('covenant', f.covenants) : [{ text: 'No covenant or easement noted' }]),
    ];
    const l = f?.lease;
    if (l) {
      const lf = (l.flags ?? []).map((fl) => flagEv(fl, s.title.leaseDocumentId ?? docId));
      out.push(item('The lease: term, rent and its review, what the lender accepts', lf.length ? 'flag' : 'ok', [
        { text: `${l.unexpiredYears != null ? n(l.unexpiredYears, 'year') + ' unexpired' : 'term not read'}${l.groundRentPenniesPa != null ? ` · ground rent ${gbp(l.groundRentPenniesPa)} a year` : ''}${l.groundRentReview ? ` · ${l.groundRentReview}` : ''}${s.lenderRequirements?.minUnexpiredYears != null ? ` · lender minimum ${s.lenderRequirements.minUnexpiredYears} years` : ''}`, documentId: s.title.leaseDocumentId ?? docId, page: l.locator?.page ?? null },
        ...lf,
      ]));
    }
    return out;
  }
  if (d.kind === 'id_check') {
    const f = rp.facts as IdCheckFacts | undefined;
    const party = d.subject && s.partyChecks[d.subject] ? s.partyChecks[d.subject].label : x.matter.buyerNames?.[0] ?? x.matter.sellerNames?.[0] ?? 'the client';
    const names = mismatch('buyer_names') ?? mismatch('seller_names');
    return [
      item(`The check on ${party} came back ${f?.outcome ?? 'referred'}`, f?.outcome === 'clear' ? 'ok' : 'flag', [
        { text: `${f?.provider ?? 'provider'} · ${f?.outcome ?? 'referred'}`, documentId: docId },
        ...(f?.flags ?? []).map((fl) => flagEv(fl)),
      ]),
      item('Names on the ID match the instruction, the contract and the title exactly', names ? 'flag' : x.crosschecks.some((c) => /names/.test(c.check) && c.status === 'match') ? 'ok' : 'open', names ? [{ text: names.message, warn: true }] : []),
      item('Address on the proof of address matches the correspondence address', 'open'),
      item('Document in date and not flagged as tampered', 'open'),
      ...(f?.flags.some((fl) => /PEP|SANCTION/i.test(fl.code)) ? [item('PEP or sanctions hit: escalate, never approve alone', 'flag')] : []),
    ];
  }
  if (d.kind === 'management_pack') {
    const f = s.managementPack.facts;
    const bsa = f?.buildingSafety;
    return [
      item('Service charge, ground rent and arrears against the budget and the lease', f?.arrearsPennies ? 'flag' : f ? 'ok' : 'open', [
        { text: `Service charge ${gbp(f?.serviceChargePenniesPa) ?? 'not read'} a year${f?.serviceChargePeriod ? ` (${f.serviceChargePeriod})` : ''}${f?.serviceChargeProportion ? ` · proportion ${f.serviceChargeProportion}` : ''} · ground rent ${gbp(f?.groundRentPenniesPa) ?? 'not read'} a year · reserve fund ${gbp(f?.reserveFundPennies) ?? 'not stated'}`, documentId: docId },
        ...(f?.arrearsPennies ? [{ text: `Arrears on the account: ${gbp(f.arrearsPennies)}`, warn: true, documentId: docId }] : []),
      ]),
      item('Major works planned or levied', f?.majorWorksPlanned || f?.section20Notice ? 'flag' : 'ok', f?.majorWorksPlanned || f?.section20Notice ? [{ text: `${f?.majorWorks ?? 'Major works planned'}${f?.section20Notice ? ' · section 20 consultation under way' : ''}`, warn: true, documentId: docId }] : [{ text: 'None disclosed' }]),
      item('Buildings insurance in place and adequate', f?.buildingsInsuranceInPlace === false ? 'flag' : f?.buildingsInsuranceInPlace ? 'ok' : 'open', [{ text: f?.buildingsInsuranceInPlace ? `${f.insurer ?? 'Insurer not stated'}${f.insuredSumPennies ? ` · sum insured ${gbp(f.insuredSumPennies)}` : ''}${f.insuranceExpiryDate ? ` · to ${day(f.insuranceExpiryDate)}` : ''}` : f?.buildingsInsuranceInPlace === false ? 'The pack says NO insurance is in place' : 'Not stated', warn: f?.buildingsInsuranceInPlace === false, documentId: docId }]),
      item("Landlord's consents and fees on assignment; any restriction on the title", f?.consentsRequired ? 'flag' : 'ok', [
        { text: f?.consentsRequired ? `Required: ${f.consentsRequired}` : 'No consent required on assignment', documentId: docId, warn: !!f?.consentsRequired },
        ...(f?.fees ? [{ text: `Fees: ${[f.fees.noticeOfAssignmentPennies != null && `notice of assignment ${gbp(f.fees.noticeOfAssignmentPennies)}`, f.fees.noticeOfChargePennies != null && `notice of charge ${gbp(f.fees.noticeOfChargePennies)}`, f.fees.deedOfCovenantPennies != null && `deed of covenant ${gbp(f.fees.deedOfCovenantPennies)}`, f.fees.certificateOfCompliancePennies != null && `certificate of compliance ${gbp(f.fees.certificateOfCompliancePennies)}`, f.fees.other].filter(Boolean).join(', ') || 'none stated'}`, documentId: docId }] : []),
      ]),
      ...(f?.disputes ? [item('Disputes, breaches or forfeiture disclosed', 'flag', [{ text: f.disputes, warn: true, documentId: docId }])] : []),
      ...(bsa?.relevantBuilding ? [item('Building Safety Act: the certificates for a relevant building', bsa.leaseholderDeedOfCertificate === false || bsa.landlordCertificate === false ? 'flag' : 'ok', [{ text: `Leaseholder deed of certificate ${bsa.leaseholderDeedOfCertificate == null ? 'not stated' : bsa.leaseholderDeedOfCertificate ? 'given' : 'MISSING'} · landlord's certificate ${bsa.landlordCertificate == null ? 'not stated' : bsa.landlordCertificate ? 'given' : 'MISSING'}${bsa.remediation ? ` · ${bsa.remediation}` : ''}`, warn: bsa.leaseholderDeedOfCertificate === false || bsa.landlordCertificate === false, documentId: docId }])] : []),
    ];
  }
  if (d.kind === 'report_on_title') {
    const rv = x.review;
    const pendingBits = [
      ...Object.values(s.enquiries).filter((q) => q.status === 'raised' || q.status === 'flagged').map((q) => `enquiry ${q.enquiryId}`),
      ...Object.values(s.searches).filter((sr) => sr.status === 'ordered' || sr.status === 'flagged').map((sr) => `${sr.searchType} search`),
      ...(s.hasLender && s.mortgage.status !== 'cleared' && s.mortgage.status !== 'reviewed' ? ['mortgage offer'] : []),
      ...(s.requireProofOfFunds && !s.proofOfFunds.approvedAt ? ['proof of funds'] : []),
    ];
    return [
      item('Every figure and fact in the draft is backed by the file', rv?.facts ? (rv.unverified.length ? 'flag' : 'ok') : 'open', rv?.facts ? [
        { text: `${rv.verified} of ${n(rv.facts, 'quoted fact')} found on the page`, documentId: docId },
        ...rv.unverified.slice(0, 6).map((u) => ({ text: `Not found in the source: ${u.key} = ${u.value}`, warn: true })),
      ] : [{ text: 'The draft has not been checked against the register' }]),
      item('Nothing is reported that is still open', pendingBits.length ? 'flag' : 'ok', pendingBits.length ? [{ text: `Still open, not in the report: ${pendingBits.join(', ')}`, warn: true }] : [{ text: 'Every search, enquiry and title point is resolved' }]),
      item('Mortgage conditions the client must meet are in it', s.hasLender ? 'open' : 'ok', s.hasLender && s.mortgage.facts ? s.mortgage.facts.conditions.filter((c) => !c.standard).map((c) => ({ text: `${c.code}: ${c.text}` })) : []),
      item('Plain English; nothing the client has not been told elsewhere', 'open'),
    ];
  }
  if (d.kind === 'bank_details') {
    const b = Object.values(s.bankDetails).find((r) => r.sourceDocumentId === docId) ?? null;
    const prev = b ? Object.values(s.bankDetails).filter((r) => r.payeeKind === b.payeeKind && r.id !== b.id && r.status === 'verified').pop() ?? null : null;
    const maskd = (dd: { accountName: string; firmName: string | null; sortCode: string; accountNumber: string }) => `${dd.accountName}${dd.firmName ? ` (${dd.firmName})` : ''} · ${dd.sortCode.replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3')} · ****${dd.accountNumber.slice(-4)}`;
    return [
      item(prev ? 'A CHANGE of bank details: the fraud signal' : 'New bank details for this payee', prev ? 'flag' : 'open', [
        { text: `${b ? maskd(b.details) : 'Details not on the state'} · arrived by ${b ? pretty(b.sourceChannel) : 'unknown channel'}`, documentId: docId, warn: !!prev },
        ...(prev ? [{ text: `Previously verified: ${maskd(prev.details)}`, warn: true }] : []),
      ]),
      item('Verify by a phone call to a number you already hold, or a Lawyer Checker match', 'open'),
      item('Never confirm on the channel the details arrived on; pay nothing until this is resolved', 'open'),
    ];
  }
  if (d.kind === 'proposal') {
    const pr = Object.values(s.proposals).find((p) => p.eventId === d.eventId) ?? null;
    const det = (pr?.detail ?? {}) as Record<string, unknown>;
    const w = det.waitKey ? openWaits(s).find((ww) => ww.key === det.waitKey && (!det.subject || ww.subject === det.subject)) : null;
    return [
      item('Is this the right recipient and the right moment', 'open', [
        { text: d.summary.split('\n').filter(Boolean).slice(0, 3).join(' · ') },
        ...(w ? [{ text: `Outstanding since ${day(w.openedAt)}${w.chasesSentAt.length ? ` · chased ${w.chasesSentAt.length}× (last ${day(w.chasesSentAt[w.chasesSentAt.length - 1])})` : ' · not chased yet'}` }] : []),
      ]),
      item('Does anything on the case make this unwise today', openIssues(s).length ? 'flag' : 'ok', openIssues(s).slice(0, 4).map((i) => ({ text: `Open issue: ${i.title}`, warn: true }))),
    ];
  }
  if (d.kind === 'auto_clear') {
    const ac = raised?.type === 'auto_clear_review_raised' ? (rp as { subFlow?: string; subject?: string; reasons?: string[] }) : null;
    return [
      item('Does the document say what the rule layer found', 'open', [{ text: `${ac ? pretty(ac.subFlow ?? '') : pretty(d.subject ?? '')}${ac?.subject ? ` · ${ac.subject.split(':').pop()}` : ''}`, documentId: docId }, ...(ac?.reasons ?? []).map((r) => ({ text: r, documentId: docId }))]),
      item('Anything the rules do not check that a person would notice', 'open'),
    ];
  }
  // Escalations, requisitions, note actions and anything else: the summary's own lines under the kind's checks.
  const lines = d.summary.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^options:/i.test(l)).slice(0, 6);
  return [item(checks[0] ?? 'What was raised, and why', 'open', lines.map((l) => ({ text: seeTail(l), documentId: docId }))), ...checks.slice(1).map((t) => item(t, 'open'))];
}

/** The kind's checks with the decision's flags attached to the check they speak to; a flag that fits none is its own row. */
function attachFlags(checks: string[], flags: Flag[], docId: string | null, okEvidence: Ev[]): ChecklistItem[] {
  const items: ChecklistItem[] = checks.map((text) => ({ text, status: 'open' as const, evidence: [] as Ev[] }));
  const unplaced: Flag[] = [];
  for (const f of flags) {
    const fw = words(`${f.code.replace(/_/g, ' ')} ${f.description}`);
    let best = -1; let score = 0;
    items.forEach((it, i) => { const o = [...words(it.text)].filter((w) => fw.has(w)).length; if (o > score) { score = o; best = i; } });
    const ev: Ev = { text: seeTail(f.description), documentId: docId, page: f.locator?.page ?? null, quote: f.locator?.quote ?? f.locator?.section ?? null, warn: f.severity === 'high' || f.severity === 'medium' };
    if (best >= 0) { items[best].status = 'flag'; items[best].evidence.push(ev); } else unplaced.push(f);
  }
  for (const f of unplaced) items.unshift({ text: seeTail(f.description), status: 'flag', evidence: [{ text: `${f.severity} · ${f.code.replace(/_/g, ' ').toLowerCase()}`, documentId: docId, page: f.locator?.page ?? null, quote: f.locator?.quote ?? null, warn: f.severity === 'high' }] });
  if (!flags.length && items.length) { items[0].status = 'ok'; items[0].evidence.push(...okEvidence); }
  return items;
}

/**
 * Proof of funds, as a paralegal would put it to the conveyancer: the money in one line, then
 * the account of what was read — each statement, each salary payment, the gift arriving, how
 * many transactions were looked at and that none stand out — and only then anything that
 * actually needs a decision, each named for what it is. Nothing the form settled is repeated.
 */
function pofChecklist(s: MatterState, docId: string | null, x: BuildExtras): Built {
  const f = s.proofOfFunds.facts!;
  const flags = s.proofOfFunds.flags ?? [];
  const has = (re: RegExp) => flags.filter((fl) => re.test(fl.code));
  const qs = Object.values(s.proofOfFunds.queries ?? {});
  const queryFor = (code: string) => qs.filter((q) => q.flagCode === code);
  const stById = new Map(x.statementFacts.map((st) => [st.documentId, st]));
  const stmts = s.proofOfFunds.statements ?? [];
  const flagEv = (fl: Flag): Ev => {
    const file = fl.locator?.section?.split(' · ')[0];
    const st = stmts.find((ss) => ss.fileName === file);
    return { text: seeTail(fl.description), documentId: st?.documentId ?? docId, page: fl.locator?.page ?? null, quote: fl.locator?.quote?.replace(/^\d{4}-\d{2}-\d{2}\s+/, '').replace(/\s+[+−-]£[\d,.]+$/, '') ?? fl.locator?.section ?? null, warn: fl.severity === 'high' || fl.severity === 'medium' };
  };
  const total = f.totalDeclaredPennies;
  const items: ChecklistItem[] = [];
  const narrative: Ev[] = [];

  // The money, source by source, with its share.
  for (const src of f.sources) narrative.push({ text: `${gbp(src.amountPennies)} ${src.kind === 'gift' && src.gift ? `gifted by ${src.gift.donorName} (${src.gift.donorRelationship})` : pretty(src.kind).toLowerCase()}${f.sources.length > 1 ? ` — ${pct(src.amountPennies, total)}` : ''}${src.description && src.kind !== 'gift' ? `, ${src.description.replace(/^\w/, (c) => c.toLowerCase())}` : ''}${src.evidenceCount ? '' : ' — nothing attached'}`, warn: src.evidenceCount === 0, documentId: docId });

  // Each statement as a file of its own: what it is in a line, and underneath the payments and receipts worth a look.
  let txCount = 0;
  const donors = f.sources.filter((src) => src.gift).map((src) => src.gift!.donorName);
  const files: TaskContext['files'] = [];
  const txFlags = has(/^(LARGE_CREDIT|THIRD_PARTY_CREDIT|CASH_DEPOSIT|CASH_PATTERN|IN_AND_OUT|CRYPTO_CREDIT|GAMBLING_CREDIT|OVERSEAS_CREDIT|LOAN_CREDIT|BALANCE_JUMP)/);
  const srcFlags = has(/^(POF_NO_EVIDENCE|NO_STATEMENT|HOLDER_MISMATCH|JOINT_ACCOUNT_UNDECLARED|STATEMENT_STALE|STATEMENT_UNREADABLE|COVERAGE_SHORT|BALANCE_SHORT|NO_SALARY_CREDITS)/);
  const fileOf = (fl: Flag) => stmts.find((ss) => ss.fileName === fl.locator?.section?.split(' · ')[0])?.documentId ?? null;
  for (const st of stmts) {
    const facts = stById.get(st.documentId)?.facts ?? null;
    const lines = facts?.transactions.length ?? st.transactions;
    txCount += lines;
    const fl: Ev[] = [];
    if (facts?.salaryCredits?.length) {
      const payers = [...new Set(facts.salaryCredits.map((c) => c.payer))];
      fl.push({ text: `Salary from ${payers.join(', ')}` });
      const ordered = [...facts.transactions];
      for (const c of [...facts.salaryCredits].sort((a, b) => ordered.findIndex((t) => t.date === a.date && t.amountPennies === a.amountPennies) - ordered.findIndex((t) => t.date === b.date && t.amountPennies === b.amountPennies))) {
        const t = facts.transactions.find((tt) => tt.date === c.date && tt.amountPennies === c.amountPennies);
        const quote = t?.description ?? c.payer;
        const idx = t ? ordered.filter((tt) => tt.description === t.description).findIndex((tt) => tt === t) : 0;
        fl.push({ text: `  ${day(c.date)} · ${gbp(c.amountPennies)}`, documentId: st.documentId, quote, quoteIndex: Math.max(0, idx) });
      }
    }
    if (facts) {
      const giftIn = facts.transactions.filter((t) => t.amountPennies > 0 && donors.some((dn) => { const surname = dn.trim().toLowerCase().split(/\s+/).pop() ?? ''; return surname.length > 2 && !!t.counterparty && t.counterparty.toLowerCase().includes(surname); }));
      for (const t of giftIn) fl.push({ text: `Gift received ${day(t.date)} · ${gbp(t.amountPennies)} from ${t.counterparty}`, documentId: st.documentId, quote: t.description });
    }
    const mine = [...txFlags, ...srcFlags].filter((x2) => fileOf(x2) === st.documentId);
    for (const x2 of mine) fl.push(flagEv(x2));
    files.push({
      documentId: st.documentId,
      title: st.fileName ?? 'Statement',
      summary: st.readable ? `Bank statement, ${st.holder ?? 'holder not read'}, ${st.from && st.to ? `${day(st.from)} to ${day(st.to)}, ` : ''}${n(lines, 'transaction')}${st.closingPennies != null ? `, closing balance ${gbp(st.closingPennies)}` : ''}${mine.length ? ` · ${n(mine.length, 'point')}` : ''}` : 'Could not be read as a statement',
      lines: fl,
      warn: !st.readable || mine.length > 0,
    });
  }
  // What the rules ran and found nothing on: the collapsed "nothing to do" list, in words.
  const raisedCodes = new Set(flags.map((fl) => fl.code.split(':')[0]));
  const RULES: Array<[string, string]> = [
    ['CASH_DEPOSIT', 'No cash deposits'], ['CASH_PATTERN', 'No pattern of cash paid in'], ['THIRD_PARTY_CREDIT', 'No credits from third parties'], ['LARGE_CREDIT', 'No large credits other than salary'],
    ['IN_AND_OUT', 'No money in and straight out again'], ['CRYPTO_CREDIT', 'No cryptoasset credits'], ['GAMBLING_CREDIT', 'No gambling credits'], ['OVERSEAS_CREDIT', 'No credits from overseas'], ['LOAN_CREDIT', 'No loan credits'], ['BALANCE_JUMP', 'No unexplained jump in the balance'],
    ['HOLDER_MISMATCH', "Every statement is in the client's name"], ['JOINT_ACCOUNT_UNDECLARED', 'No undeclared joint account holder'], ['STATEMENT_STALE', 'Statements are current'], ['COVERAGE_SHORT', 'The period is covered'], ['BALANCE_SHORT', 'Balances cover what was declared'], ['NO_SALARY_CREDITS', 'Salary is visible where savings come from salary'],
    ['POF_SHORTFALL', 'The total covers the balance to find'], ['POF_NO_EVIDENCE', 'Every source has a document'], ['POF_DECLARATION_INCOMPLETE', 'All three declarations confirmed'], ['POF_MISSING_DECLARANT', 'Every buyer stands behind the declaration'],
  ];
  const applicable = stmts.some((st) => st.readable);
  const passed = RULES.filter(([code]) => !raisedCodes.has(code) && (applicable || /^POF_/.test(code))).map(([, text]) => text);
  if (!applicable) narrative.push({ text: 'No statement could be read: nothing has been checked line by line.', warn: true });
  const submitted = { by: f.declarantName, at: s.proofOfFunds.submittedAt };
  void txCount;

  // Only what needs a decision, each named for what it is.
  if (f.requiredPennies == null) items.push(item('The price is not on the file, so the total was not checked against the balance', 'open', [{ text: `Declared ${gbp(total)}` }]));
  else if ((f.shortfallPennies ?? 0) > 0) items.push(item(`Short by ${gbp(f.shortfallPennies)}: ${gbp(total)} declared against ${gbp(f.requiredPennies)} to find`, 'flag', [{ text: `Price ${gbp(f.purchasePricePennies)}${f.mortgageAdvancePennies ? ` less mortgage ${gbp(f.mortgageAdvancePennies)}` : ''}`, warn: true, documentId: docId }]));
  for (const fl of srcFlags) items.push(item(seeTail(fl.description), 'flag', []));
  if (txFlags.length) {
    for (const fl of txFlags) {
      const q = queryFor(fl.code.split(':')[0]);
      const answered = q.some((qq) => qq.status === 'answered' || qq.status === 'withdrawn');
      items.push(item(seeTail(fl.description), answered ? 'open' : 'flag', [
        { text: 'The line', documentId: flagEv(fl).documentId, page: flagEv(fl).page, quote: flagEv(fl).quote },
        ...q.map((qq): Ev => ({ text: qq.status === 'answered' ? `Client: ${(qq.answer ?? '').slice(0, 240)}` : qq.status === 'sent' ? 'Asked; no answer yet' : qq.status === 'withdrawn' ? 'Query withdrawn with a reason' : 'Query drafted, not sent', warn: qq.status === 'sent' || qq.status === 'draft' })),
      ]));
    }
  }
  const gifts = f.sources.filter((src) => src.kind === 'gift' && src.gift);
  if (gifts.length || has(/^POF_LOAN/).length) {
    const donorChecks = Object.values(s.partyChecks ?? {}).filter((pc) => pc.role === 'donor');
    const gflags = has(/^POF_(GIFT|LOAN)/).filter((fl) => fl.code !== 'POF_GIFT');
    const lenderIssue = Object.values(s.issues).find((i) => i.kind === 'lender_approval' && /gift/i.test(i.title));
    const outstanding = donorChecks.filter((pc) => pc.status !== 'cleared' && pc.status !== 'reviewed');
    const g = gifts[0]?.gift;
    const title = gifts.length ? `Gift of ${gbp(gifts.reduce((a, b) => a + b.amountPennies, 0))} from ${gifts.map((gg) => gg.gift!.donorName).join(' and ')}: ${[outstanding.length ? `${outstanding.length === 1 ? 'donor ID check' : 'donor ID checks'} outstanding` : 'donors identified', s.hasLender ? (lenderIssue?.status === 'resolved' ? 'lender told' : 'lender to be told') : null, g?.repayable ? 'REPAYABLE' : null].filter(Boolean).join(', ')}` : 'A loan forms part of the funds';
    const ev: Ev[] = [
      ...gifts.map((gg): Ev => ({ text: `${gg.gift!.donorAbroad ? 'Donor abroad · ' : ''}${gg.gift!.jointDonorName ? `joint account with ${gg.gift!.jointDonorName} · ` : ''}${gg.evidenceCount ? n(gg.evidenceCount, 'donor document') : 'no donor documents'}`, documentId: docId, warn: gg.evidenceCount === 0 })),
      ...gflags.map(flagEv),
      ...donorChecks.map((pc): Ev => ({ text: `${pc.label}: ID / AML ${pc.status === 'cleared' || pc.status === 'reviewed' ? 'done' : pc.status.replace(/_/g, ' ')}`, warn: pc.status !== 'cleared' && pc.status !== 'reviewed', documentId: pc.documentId })),
    ];
    items.push(item(title, ev.some((e) => e.warn) ? 'flag' : 'open', ev));
  }
  const claimed = new Set(items.flatMap((i) => [i.text, ...i.evidence.map((e) => e.text)]));
  const rest = flags.filter((fl) => !claimed.has(seeTail(fl.description)) && !/^(QUERY_UNANSWERED|POF_GIFT|POF_SHORTFALL|POF_PRICE_UNKNOWN|POF_CASH_PURCHASE)$/.test(fl.code) && !/^POF_HIGH_RISK/.test(fl.code) && !srcFlags.includes(fl) && !txFlags.includes(fl));
  for (const fl of rest) items.push(item(seeTail(fl.description), 'flag', []));
  const sow = queryFor('SOURCE_OF_WEALTH');
  if (sow.length && !sow.some((q) => q.status === 'answered' || q.status === 'withdrawn')) items.push(item('Source of wealth not yet answered', 'flag', sow.map((q): Ev => ({ text: q.status === 'sent' ? 'Asked; no answer yet' : 'Query drafted, not sent', warn: true }))));
  else if (sow.some((q) => q.status === 'answered')) narrative.push({ text: `Source of wealth, in the client's words: ${(sow.find((q) => q.status === 'answered')!.answer ?? '').slice(0, 240)}` });
  const unanswered = qs.filter((q) => q.status === 'sent' && q.flagCode !== 'SOURCE_OF_WEALTH' && !txFlags.some((fl) => fl.code.split(':')[0] === q.flagCode));
  if (unanswered.length) items.push(item(`${n(unanswered.length, 'query')} with the client, not yet answered`, 'flag', unanswered.map((q) => ({ text: q.question.slice(0, 160), warn: true }))));
  const decl = has(/^POF_(DECLARATION_INCOMPLETE|MISSING_DECLARANT|NO_SOURCES|SALE_PROCEEDS_UNLINKED)$/);
  for (const fl of decl) items.push(item(seeTail(fl.description), 'flag', []));
  return { checklist: items, narrative, files, passed, submitted };
}
