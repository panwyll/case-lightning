/**
 * What the time is spent on (docs/epa-categories.md): named as the work, by who it is with, each with one obvious remedy.
 * The same list for the measurement phase (inbox, InTouch) and Analytics → Time, so every source maps onto it here and
 * nowhere else. Pure.
 */

export const EPA_KINDS = [
  // Red: needs no conveyancer.
  'client_chasers', 'other_side_chasers', 'lender_chasers', 'agent_chasers', 'third_party_chasers',
  'client_any_news', 'agent_status_requests', 'other_side_status_requests', 'lender_broker_status_requests',
  'client_updates', 'agent_updates', 'other_side_updates', 'lender_broker_updates',
  'resending_to_client', 'resending_to_others',
  'first_requests_client', 'first_requests_others',
  'sending_documents_client', 'sending_documents_others',
  'acknowledging', 'filing', 'recording_receipts', 'notes_and_outcomes', 'opening_the_case',
  'ordering_searches', 'land_registry_applications', 'sdlt_return', 'closing_the_file', 'failed_sends', 'unlocking_files',
  // Amber: needs an eye, not the conveyancer's time.
  'client_questions', 'arranging_dates', 'bank_details', 'requesting_funds', 'payments', 'checking_drafts', 'difficult_emails',
  // Green: only a conveyancer.
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
  client_chasers: red('Client Chasers', 'automate', 'Asking the client again for ID, forms, funds, signed documents or a decision'),
  other_side_chasers: red('Other Side Chasers', 'automate', "Asking the other side's solicitor again: contract pack, replies, transfer deed, completion information"),
  lender_chasers: red('Lender Chasers', 'automate', 'Redemption statements, offers, lender consent'),
  agent_chasers: red('Agent Chasers', 'automate', 'Memorandum of sale, buyer details, keys'),
  third_party_chasers: red('Third Party Chasers', 'delegate', 'Search providers, HM Land Registry, managing agents, brokers'),
  client_any_news: red('Client "Any News?"', 'prevent', 'The client asking how it is going'),
  agent_status_requests: red('Agent Status Requests', 'automate', 'The estate agent asking where the chain is'),
  other_side_status_requests: red('Other Side Status Requests', 'automate', 'The other solicitor asking where we are'),
  lender_broker_status_requests: red('Lender And Broker Status Requests', 'automate', 'The lender or broker asking how it is going'),
  client_updates: red('Client Updates', 'automate', 'Telling the client where it is, unprompted'),
  agent_updates: red('Agent Updates', 'automate', 'Telling the estate agent'),
  other_side_updates: red('Other Side Updates', 'automate', 'Telling the other solicitor where we are'),
  lender_broker_updates: red('Lender And Broker Updates', 'automate', 'Telling the lender or broker'),
  resending_to_client: red('Resending To The Client', 'prevent', '"I can\'t find the thing to sign": documents, links or forms sent again'),
  resending_to_others: red('Resending To Others', 'automate', 'A copy of something already sent, asked for again'),
  first_requests_client: red('First Requests To The Client', 'automate', 'Asking for ID, forms, funds or documents the first time'),
  first_requests_others: red('First Requests To Others', 'automate', 'Asking the other side, lender or agent for something the first time'),
  sending_documents_client: red('Sending Documents To The Client', 'automate', 'Signing packs, the contract to sign, the report on title'),
  sending_documents_others: red('Sending Documents To Others', 'automate', 'To the other side, the lender or a landlord'),
  acknowledging: red('Acknowledging', 'automate', '"Thanks, received", to anyone'),
  filing: red('Filing Emails And Documents', 'automate', 'Saving emails and documents to the case'),
  recording_receipts: red('Recording Receipts', 'automate', 'Logging that something arrived'),
  notes_and_outcomes: red('Notes And Outcomes', 'delegate', 'File notes, call notes, recording what was decided'),
  opening_the_case: red('Opening The Case', 'automate', 'Setting the case up and re-keying it between systems'),
  ordering_searches: red('Ordering Searches', 'automate', 'Placing and tracking searches'),
  land_registry_applications: red('Land Registry Applications', 'delegate', 'Filling in and submitting the application'),
  sdlt_return: red('SDLT Return', 'delegate', 'Completing and filing the return'),
  closing_the_file: red('Closing The File', 'automate', 'Archiving and final letters'),
  failed_sends: red('Failed Sends', 'delegate', 'An email that bounced or had no address, sent another way'),
  unlocking_files: red('Unlocking Files', 'delegate', 'Opening password-protected documents'),
  client_questions: amber('Client Questions', 'delegate', 'Answering a client question about the process or their case'),
  arranging_dates: amber('Arranging Dates And Calls', 'delegate', 'Completion dates across the chain, calls and appointments'),
  bank_details: amber('Bank Details', 'delegate', 'Verifying bank details by phone'),
  requesting_funds: amber('Requesting Completion Funds', 'delegate', 'The completion statement and funds request'),
  payments: amber('Payments', 'keep', 'Authorising and returning money'),
  checking_drafts: amber('Checking CONVEYi Drafts', 'automate', 'Reading a CONVEYi draft before it goes'),
  difficult_emails: amber('Difficult Emails', 'delegate', 'Upset clients, hostile other sides, complaints'),
  title_review: green('Title Review', 'The register, plan and title documents'),
  search_review: green('Search Review', 'Search results'),
  raising_enquiries: green('Raising Enquiries', 'Enquiries to the other side'),
  reviewing_replies: green('Reviewing Replies', 'Replies to enquiries'),
  contract_and_lease_review: green('Contract And Lease Review', 'The contract, the lease, the management pack'),
  mortgage_offer_review: green('Mortgage Offer Review', 'The offer and its conditions'),
  report_on_title: green('Report On Title', 'The report to the client'),
  id_and_source_of_funds: green('ID And Source Of Funds', 'The judgement on ID, AML and where the money comes from'),
  advising: green('Advising The Client', "Advice, the client's instructions and decisions"),
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
  legal_review: 'title_review', exchange_completion: 'exchange',
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
    case 'client_question': return 'client_questions';
    case 'legal_work': return 'legal_correspondence';
    // Received: the cause, not the time; read only for the measurement phase's counts.
    case 'update_request': return byParty('answer', p);
    case 'chaser_received': return p === 'client' ? 'client_any_news' : byParty('answer', p);
    case 'document_delivery': return 'filing';
    case 'question': return 'client_questions';
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
  if (kind === 'note_actions:email') return { kind: 'client_questions' };
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
