/**
 * What the time is spent on (docs/epa-categories.md): named as the work done, by whom it is with, sending or answering, each
 * with one obvious remedy. Green moves the case on and only a conveyancer can do it; amber probably needs a conveyancer but
 * does not move the case on; red is time wasted.
 * The same list for the measurement phase (inbox, InTouch) and Analytics → Time, so every source maps onto it here and
 * nowhere else. Pure.
 */

export const EPA_KINDS = [
  // Red: time that neither needs a conveyancer nor moves the case on.
  'client_chasers', 'other_side_chasers', 'lender_chasers', 'agent_chasers', 'third_party_chasers',
  'client_any_news', 'agent_status_requests', 'other_side_status_requests', 'lender_broker_status_requests',
  'client_updates', 'agent_updates', 'other_side_updates', 'lender_broker_updates',
  'resending_to_client', 'resending_to_others',
  'first_requests_client', 'first_requests_others',
  'sending_documents_client', 'sending_documents_others',
  'acknowledging', 'filing', 'recording_receipts', 'notes_and_outcomes', 'opening_the_case',
  'ordering_searches', 'land_registry_applications', 'sdlt_return', 'closing_the_file', 'failed_sends', 'unlocking_files',
  'client_process_questions', 'arranging_dates', 'bank_details', 'requesting_funds', 'checking_drafts',
  // Amber: probably needs a conveyancer, but does not move the case on.
  'client_legal_questions', 'payments', 'difficult_emails',
  // Green: only a conveyancer can do it, and it moves the case on.
  'title_review', 'search_review', 'raising_enquiries', 'reviewing_replies', 'contract_and_lease_review', 'mortgage_offer_review',
  'report_on_title', 'id_and_source_of_funds', 'advising', 'negotiating', 'resolving_issues', 'drafting', 'legal_correspondence',
  'exchange', 'completion',
  'not_counted',
] as const;
export type EpaKind = (typeof EPA_KINDS)[number];
export type Rag = 'red' | 'amber' | 'green' | 'none';
/** What to do about it (docs/epa-categories.md, rule 2). */
export type Remedy = 'automate' | 'delegate' | 'prevent' | 'keep';

interface Spec { label: string; rag: Rag; remedy: Remedy; what: string }
const red = (label: string, remedy: Remedy, what: string): Spec => ({ label, rag: 'red', remedy, what });
const amber = (label: string, remedy: Remedy, what: string): Spec => ({ label, rag: 'amber', remedy, what });
const green = (label: string, what: string): Spec => ({ label, rag: 'green', remedy: 'keep', what });

export const EPA_SPEC: Record<EpaKind, Spec> = {
  client_chasers: red('Sending Client Chasers', 'automate', 'Asking the client again for ID, forms, funds, signed documents or a decision'),
  other_side_chasers: red('Sending Other Side Chasers', 'automate', "Asking the other side's solicitor again for the contract pack, replies, the transfer deed or completion information"),
  lender_chasers: red('Sending Lender Chasers', 'automate', 'Asking a lender again for a redemption statement, an offer or consent'),
  agent_chasers: red('Sending Agent Chasers', 'automate', 'Asking the estate agent again for the memorandum of sale, buyer details or keys'),
  third_party_chasers: red('Sending Third Party Chasers', 'delegate', 'Asking search providers, HM Land Registry, managing agents or brokers again'),
  client_any_news: red('Answering Client Status Requests', 'prevent', 'Replying when the client asks how it is going'),
  agent_status_requests: red('Answering Agent Status Requests', 'automate', 'Replying when the estate agent asks where the chain is'),
  other_side_status_requests: red('Answering Other Side Status Requests', 'automate', 'Replying when the other solicitor asks where we are'),
  lender_broker_status_requests: red('Answering Lender And Broker Status Requests', 'automate', 'Replying when the lender or broker asks how it is going'),
  client_updates: red('Sending Proactive Client Updates', 'automate', 'Telling the client where the case is, before they ask'),
  agent_updates: red('Sending Proactive Agent Updates', 'automate', 'Telling the estate agent where the case is, before they ask'),
  other_side_updates: red('Sending Proactive Other Side Updates', 'automate', 'Telling the other solicitor where we are, before they ask'),
  lender_broker_updates: red('Sending Proactive Lender And Broker Updates', 'automate', 'Telling the lender or broker where the case is, before they ask'),
  resending_to_client: red('Resending Documents To The Client', 'prevent', '"I can\'t find the thing to sign": documents, links or forms sent again'),
  resending_to_others: red('Resending Documents To Others', 'automate', 'A copy of something already sent, asked for again by the other side, lender or agent'),
  first_requests_client: red('Asking The Client For Documents', 'automate', 'Asking for ID, forms, funds or documents for the first time'),
  first_requests_others: red('Asking Others For Documents', 'automate', 'Asking the other side, lender or agent for something for the first time'),
  sending_documents_client: red('Sending Documents To The Client', 'automate', 'Signing packs, the contract to sign, the report on title'),
  sending_documents_others: red('Sending Documents To Others', 'automate', 'Documents to the other side, the lender or a landlord'),
  acknowledging: red('Sending Acknowledgements', 'automate', '"Thanks, received", to anyone'),
  filing: red('Filing Emails And Documents', 'automate', 'Saving emails and documents to the case'),
  recording_receipts: red('Recording Receipts', 'automate', 'Logging on the case that something arrived'),
  notes_and_outcomes: red('Writing File Notes', 'delegate', 'File notes, call notes and recording what was decided'),
  opening_the_case: red('Opening The Case', 'automate', 'Setting the case up and re-keying it between systems'),
  ordering_searches: red('Ordering Searches', 'automate', 'Placing and tracking searches'),
  land_registry_applications: red('Submitting Land Registry Applications', 'delegate', 'Filling in and submitting the application, and its admin'),
  sdlt_return: red('Filing SDLT Returns', 'delegate', 'Completing and filing the return'),
  closing_the_file: red('Closing Files', 'automate', 'Archiving, final letters and closing the file'),
  failed_sends: red('Resending Failed Emails', 'delegate', 'An email that bounced or had no address, sent another way'),
  unlocking_files: red('Unlocking Protected Files', 'delegate', 'Opening password-protected documents'),
  client_process_questions: red('Answering Client Process Questions', 'prevent', '"What happens next?", "What is a TA6?": the same answer for every client'),
  arranging_dates: red('Arranging Completion Dates And Calls', 'delegate', 'Agreeing dates across the chain, booking calls and appointments'),
  bank_details: red('Verifying Bank Details', 'delegate', 'Phoning to confirm bank details on a number already held: an assistant can do it'),
  requesting_funds: red('Requesting Completion Funds', 'automate', 'The completion statement and the request for the money'),
  checking_drafts: red('Checking CONVEYi Drafts', 'automate', 'Reading a CONVEYi draft before it goes, where CONVEYi could send it'),
  client_legal_questions: amber('Answering Client Legal Questions', 'keep', "A legal question about the client's case: needs a conveyancer, does not move the case on"),
  payments: amber('Authorising Payments', 'keep', 'Signing off money out of the client account'),
  difficult_emails: amber('Handling Complaints And Difficult Emails', 'delegate', 'Upset clients, hostile other sides, complaints'),
  title_review: green('Title Review', 'The register, plan and title documents'),
  search_review: green('Search Review', 'Reading search results'),
  raising_enquiries: green('Raising Enquiries', 'Enquiries to the other side'),
  reviewing_replies: green('Reviewing Replies', 'Replies to enquiries'),
  contract_and_lease_review: green('Contract And Lease Review', 'The contract, the lease and the management pack'),
  mortgage_offer_review: green('Mortgage Offer Review', 'The offer and its conditions'),
  report_on_title: green('Report On Title', 'The report to the client'),
  id_and_source_of_funds: green('ID And Source Of Funds', 'The judgement on ID, AML and where the money comes from'),
  advising: green('Advising The Client', "Advice that moves the case: the client's instructions and decisions"),
  negotiating: green('Negotiating', 'Points with the other side'),
  resolving_issues: green('Resolving Issues', 'An issue on the case: a death, a defect, a dispute'),
  drafting: green('Drafting', 'Drafting a legal document'),
  legal_correspondence: green('Legal Correspondence', 'Email that is legal work: enquiries, replies, advice, contract points'),
  exchange: green('Exchange', 'Exchanging contracts'),
  completion: green('Completion', 'Completing, and the money and undertakings around it'),
  not_counted: { label: 'Not Counted', rag: 'none', remedy: 'keep', what: 'Colleagues; anything else' },
};

/** Kinds an earlier version stored (activity_span.kind), read as today's. */
export const LEGACY_KINDS: Record<string, EpaKind> = {
  chasing: 'client_chasers', being_chased: 'other_side_status_requests', status_updates: 'client_updates', any_news: 'client_any_news',
  requesting: 'first_requests_client', sending_documents: 'sending_documents_client', admin: 'filing', scheduling: 'arranging_dates',
  legal_review: 'title_review', exchange_completion: 'exchange', client_questions: 'client_legal_questions',
};
export const asKind = (k: string | null | undefined): EpaKind => ((EPA_KINDS as readonly string[]).includes(k ?? '') ? (k as EpaKind) : LEGACY_KINDS[k ?? ''] ?? 'not_counted');

/** A kind of work, and (for Checking CONVEYi Drafts) what the draft was and the CONVEYi action that sends it. */
export interface EpaWork { kind: EpaKind; of?: EpaKind | null; action?: string | null }

/** Who an email or a task is with. */
type Party = 'client' | 'other_side' | 'lender' | 'agent' | 'third_party' | null;
function partyOfRoles(roles: readonly string[] | null | undefined): Party {
  const r = new Set(roles ?? []);
  if (r.has('client')) return 'client';
  if (r.has('other_solicitor')) return 'other_side';
  if (r.has('lender') || r.has('broker')) return 'lender';
  if (r.has('estate_agent')) return 'agent';
  if (r.has('third_party')) return 'third_party';
  return null;
}
function partyOfChip(chip: string): Party {
  // The other side first: "The Seller's Side" and "Buyer's Solicitor" name a party, not our client.
  if (/solicitor|other side|seller's side|buyer's side/i.test(chip)) return 'other_side';
  if (/client|family|buyer\b|seller\b/i.test(chip)) return 'client';
  if (/lender|broker|bank/i.test(chip)) return 'lender';
  if (/agent/i.test(chip)) return 'agent';
  if (/third party|search|land registry|hmlr|managing/i.test(chip)) return 'third_party';
  return null;
}
const BY_PARTY = {
  chaser: { client: 'client_chasers', other_side: 'other_side_chasers', lender: 'lender_chasers', agent: 'agent_chasers', third_party: 'third_party_chasers' },
  update: { client: 'client_updates', other_side: 'other_side_updates', lender: 'lender_broker_updates', agent: 'agent_updates', third_party: 'other_side_updates' },
  answer: { client: 'client_any_news', other_side: 'other_side_status_requests', lender: 'lender_broker_status_requests', agent: 'agent_status_requests', third_party: 'other_side_status_requests' },
  request: { client: 'first_requests_client', other_side: 'first_requests_others', lender: 'first_requests_others', agent: 'first_requests_others', third_party: 'first_requests_others' },
  send: { client: 'sending_documents_client', other_side: 'sending_documents_others', lender: 'sending_documents_others', agent: 'sending_documents_others', third_party: 'sending_documents_others' },
} as const satisfies Record<string, Record<Exclude<Party, null>, EpaKind>>;
const DEFAULT_PARTY: Record<keyof typeof BY_PARTY, Exclude<Party, null>> = { chaser: 'client', update: 'client', answer: 'client', request: 'client', send: 'client' };
const byParty = (what: keyof typeof BY_PARTY, party: Party): EpaKind => BY_PARTY[what][party ?? DEFAULT_PARTY[what]];

/** A sent email from the mailbox scan (workload/taxonomy.ts categories), by who it went to. */
export function fromEmail(category: string | null | undefined, roles?: readonly string[] | null): EpaKind {
  const p = partyOfRoles(roles);
  switch (category) {
    case 'chaser': return byParty('chaser', p);
    case 'status_update': return byParty('update', p);
    case 'update_reply': return byParty('answer', p);
    case 'first_request': return byParty('request', p);
    case 'file_send': return byParty('send', p);
    case 'acknowledgement': return 'acknowledging';
    case 'scheduling': return 'arranging_dates';
    // The scan cannot yet tell a legal question from a status or process one: counted as legal, so the figure errs kind.
    case 'client_question': return 'client_legal_questions';
    case 'legal_work': return 'legal_correspondence';
    // Received: the cause, not the time; read only for the measurement phase's counts.
    case 'update_request': return byParty('answer', p);
    case 'chaser_received': return p === 'client' ? 'client_any_news' : byParty('answer', p);
    case 'document_delivery': return 'filing';
    case 'question': return 'client_legal_questions';
    case 'instruction': return 'advising';
    case 'enquiry': return 'reviewing_replies';
    default: return 'not_counted';
  }
}
/** @deprecated the role-less form: everything is read as if to the client. */
export const fromBaselineCategory = (category: string | null | undefined): EpaKind => fromEmail(category, null);

/** What a CONVEYi proposal is a draft of, from its action and its chip (who it is to). */
function draftOf(sub: string, chip: string): EpaKind {
  const p = partyOfChip(chip);
  if (/acknowledg/i.test(sub) || /Acknowledgement/.test(chip)) return 'acknowledging';
  if (sub === 'chase') return /Request\b/.test(chip) ? byParty('request', p) : /^Letter To|Update$/i.test(chip) ? byParty('update', p) : byParty('chaser', p);
  if (sub === 'id_check_request' || sub === 'proof_of_funds_request' || sub.endsWith('_request') || /Request\b/.test(chip)) return byParty('request', p);
  if (sub === 'signing_pack' || /Send .*Documents/.test(chip)) return byParty('send', p);
  if (sub === 'file_copy') return 'resending_to_client';
  if (sub === 'search_order') return 'ordering_searches';
  if (sub === 'counterparty_update') return byParty('update', p ?? 'other_side');
  return byParty('update', p);
}

/** Decision kinds on the Tasks list: the legal review each one is. */
const REVIEW: Record<string, EpaKind> = {
  search: 'search_review', title: 'title_review', enquiry: 'reviewing_replies', mortgage: 'mortgage_offer_review', contract: 'contract_and_lease_review',
  management_pack: 'contract_and_lease_review', lease: 'contract_and_lease_review', report_on_title: 'report_on_title', id_check: 'id_and_source_of_funds',
  proof_of_funds: 'id_and_source_of_funds', requisition: 'land_registry_applications', escalation: 'resolving_issues',
};

/** A Tasks-list item (work.ts WorkItem: kind, chip) as a kind of work. */
export function fromTask(item: { kind: string | null; chip?: string | null }): EpaWork {
  const chip = (item.chip ?? '').replace(/^Manual Mode · /, '');
  const kind = item.kind ?? '';
  if (kind.startsWith('proposal:')) {
    const sub = kind.slice('proposal:'.length);
    // The draft's content is the conveyancer's own judgement: enquiries and advice are their work, not a check.
    if (sub === 'enquiry_draft') return { kind: 'raising_enquiries' };
    if (sub === 'survey_advice') return { kind: 'advising' };
    return { kind: 'checking_drafts', of: draftOf(sub, chip), action: sub };
  }
  if (kind === 'auto_clear') return { kind: 'checking_drafts', of: null, action: 'auto_clear' };
  if (kind === 'note_actions:ack') return { kind: 'acknowledging' };
  if (kind === 'note_actions:email') return { kind: 'client_legal_questions' };
  if (kind === 'note_actions') return { kind: 'notes_and_outcomes' };
  if (kind === 'bank_details') return { kind: 'bank_details' };
  if (kind === 'linked_case') return { kind: 'not_counted' };
  if (REVIEW[kind]) return { kind: REVIEW[kind] };
  return fromChip(chip);
}

/** A step's or an issue's chip as a kind of work. Unknown chips are not counted rather than guessed. */
export function fromChip(chip: string): EpaWork {
  const k = ((): EpaKind => {
    if (/^Record Receipt/.test(chip)) return 'recording_receipts';
    if (/^Record Outcome/.test(chip)) return 'notes_and_outcomes';
    if (/^Upload Documents/.test(chip)) return 'filing';
    if (/^File Return/.test(chip)) return 'sdlt_return';
    if (/^Submit Application|^HM Land Registry/.test(chip)) return 'land_registry_applications';
    if (/^Close (File|Case)/.test(chip)) return 'closing_the_file';
    if (/^Run Search|^Search Order/.test(chip)) return 'ordering_searches';
    if (/^Unsuccessful Send/.test(chip)) return 'failed_sends';
    if (/^Unlock File/.test(chip)) return 'unlocking_files';
    if (/^Authorise Payment|^Return Money/.test(chip)) return 'payments';
    if (/^Request Funds/.test(chip)) return 'requesting_funds';
    if (/^Verify Details/.test(chip)) return 'bank_details';
    if (/^Send .*Documents/.test(chip)) return byParty('send', partyOfChip(chip.replace(/^Send /, '')));
    if (/^Chase /.test(chip)) return byParty('chaser', partyOfChip(chip.replace(/^Chase /, '')));
    if (/Chaser$/.test(chip)) return byParty('chaser', partyOfChip(chip));
    if (/Request$/.test(chip)) return byParty('request', partyOfChip(chip));
    if (/Update$/.test(chip)) return byParty('update', partyOfChip(chip));
    if (/^Reply To Enquiries/.test(chip)) return 'reviewing_replies';
    if (/Enquiries$/.test(chip)) return 'raising_enquiries';
    if (/^Exchange Contracts/.test(chip)) return 'exchange';
    if (/^Confirm Completion/.test(chip)) return 'completion';
    if (/^Client Advice/.test(chip)) return 'advising';
    if (/^Draft Document/.test(chip)) return 'drafting';
    if (/^Resolve Issue|^With A Partner/.test(chip)) return 'resolving_issues';
    if (/^Document Sign-Off/.test(chip)) return 'title_review';
    return 'not_counted';
  })();
  return { kind: k };
}
