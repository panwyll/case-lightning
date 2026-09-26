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
  history: Array<{ at: string; what: string }>;
  related: string[];
  unblocks: string | null;
}

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

const SEARCH_LABEL: Record<SearchType, string> = { LLC1: 'Local land charges (LLC1)', CON29: 'Local authority (CON29)', DRAINAGE_WATER: 'Drainage and water', ENVIRONMENTAL: 'Environmental', CHANCEL: 'Chancel repair' };
const SEARCH_CHECKS: Record<SearchType, string[]> = {
  LLC1: ['Financial charges, conservation area, listing, tree preservation orders: does the client know', 'Enforcement or planning contravention notices', 'Anything that breaches the lender handbook'],
  CON29: ['Planning history matches what the seller says was built, and when; building regulations sign-off for every alteration', 'Road and footpath adopted and maintained at public expense', 'Proposed road, rail or development schemes nearby', 'Contaminated land, radon and flooding entries', 'Does the flag change the price, the lender, or the advice'],
  DRAINAGE_WATER: ['Foul and surface water connected to the public sewer', 'A public sewer within 3m or under the building: build-over agreement', 'Water supply metered; no pending charges'],
  ENVIRONMENTAL: ['Flood risk, and whether insurance is available on ordinary terms', 'Contaminated land: past use and any remediation record', 'Subsidence, mining, landfill within the search radius', 'Whether the report recommends further action, and by whom'],
  CHANCEL: ['Whether liability is registered on the title', 'Whether an indemnity policy is the proportionate answer'],
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

export function taskContext(input: { state: MatterState; matter: MatterFacts; events: EngineEvent[]; target: ContextTarget; now?: Date; review?: SourceReview | null }): TaskContext {
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
      headline = f ? `Declared ${gbp(f.totalDeclaredPennies)}${f.requiredPennies != null ? ` against ${gbp(f.requiredPennies)} needed` : ''}${f.shortfallPennies ? `; shortfall ${gbp(f.shortfallPennies)}` : ''}${f.giftedPennies ? `; ${gbp(f.giftedPennies)} gifted` : ''}${s.proofOfFunds.risk ? ` · ${s.proofOfFunds.risk} risk` : ''}.` : 'Proof of funds submitted.';
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

  return { headline, task, facts, checks, history, related: related.slice(0, 6), unblocks };
}
