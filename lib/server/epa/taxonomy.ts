/**
 * EPA's kinds of work and their RAG (docs/epa.md §1): one level above the Tasks list's chips. A chaser is a chaser whoever it
 * went to. Every source of time maps onto these kinds here and nowhere else. Pure.
 */

export const EPA_KINDS = [
  'chasing', 'being_chased', 'status_updates', 'any_news', 'requesting', 'sending_documents', 'acknowledging', 'admin',
  'client_questions', 'scheduling', 'checking_drafts', 'payments',
  'legal_review', 'advising', 'negotiating', 'exchange_completion',
  'not_counted',
] as const;
export type EpaKind = (typeof EPA_KINDS)[number];
export type Rag = 'red' | 'amber' | 'green' | 'none';

export const EPA_SPEC: Record<EpaKind, { label: string; rag: Rag; what: string }> = {
  chasing: { label: 'Chasing', rag: 'red', what: 'Asking again for something overdue' },
  being_chased: { label: 'Being Chased', rag: 'red', what: 'Dealing with someone chasing us' },
  status_updates: { label: 'Status Updates', rag: 'red', what: 'Telling someone where the case stands' },
  any_news: { label: '"Any News?" Replies', rag: 'red', what: 'Answering an update request' },
  requesting: { label: 'Requesting', rag: 'red', what: 'Asking for a document or information the first time' },
  sending_documents: { label: 'Sending Documents', rag: 'red', what: 'Sending a file or copy someone needs' },
  acknowledging: { label: 'Acknowledging', rag: 'red', what: 'Confirming something arrived' },
  admin: { label: 'Admin', rag: 'red', what: 'Recording receipts and outcomes, filing, data entry' },
  client_questions: { label: 'Client Questions', rag: 'amber', what: 'Answering a question about the process or the case' },
  scheduling: { label: 'Scheduling', rag: 'amber', what: 'Arranging calls, dates, completion logistics' },
  checking_drafts: { label: 'Checking Drafts', rag: 'amber', what: 'Reading what CONVEYi drafted before it goes' },
  payments: { label: 'Payments', rag: 'amber', what: 'Verifying bank details and authorising money' },
  legal_review: { label: 'Legal Review', rag: 'green', what: 'Title, searches, replies, contract, offer, report on title, ID and AML judgement' },
  advising: { label: 'Advising', rag: 'green', what: 'Advice to the client, their instructions and decisions' },
  negotiating: { label: 'Negotiating', rag: 'green', what: 'Points with the other side, enquiries raised and answered' },
  exchange_completion: { label: 'Exchange And Completion', rag: 'green', what: 'Exchanging, completing, and the money and undertakings around them' },
  not_counted: { label: 'Not Counted', rag: 'none', what: 'Colleagues; anything else' },
};

/** A kind of work, and (for Checking Drafts) what the draft was: the Pareto's action names the CONVEYi action behind it. */
export interface EpaWork { kind: EpaKind; of?: EpaKind | null; action?: string | null }

/** The baseline's email categories (workload/taxonomy.ts), sent and received. */
const FROM_BASELINE: Record<string, EpaKind> = {
  chaser: 'chasing', status_update: 'status_updates', update_reply: 'any_news', first_request: 'requesting', file_send: 'sending_documents', acknowledgement: 'acknowledging',
  scheduling: 'scheduling', client_question: 'client_questions', legal_work: 'legal_review', internal: 'not_counted', non_case: 'not_counted',
  update_request: 'any_news', chaser_received: 'being_chased', document_delivery: 'admin', question: 'client_questions', instruction: 'advising', enquiry: 'negotiating', other: 'not_counted',
};
export const fromBaselineCategory = (category: string | null | undefined): EpaKind => FROM_BASELINE[category ?? ''] ?? 'not_counted';

/** What a CONVEYi proposal is a draft of, by its action and kind (work.ts `proposal:<sub>`, and its chip). */
function draftOf(sub: string, chip: string): EpaKind {
  if (/acknowledg/i.test(sub) || /Acknowledgement/.test(chip)) return 'acknowledging';
  if (sub === 'chase') return /Request\b/.test(chip) ? 'requesting' : /^Letter To/i.test(chip) ? 'status_updates' : 'chasing';
  if (sub === 'id_check_request' || sub === 'proof_of_funds_request' || /Request\b/.test(chip)) return 'requesting';
  if (sub === 'signing_pack' || /Send .*Documents/.test(chip)) return 'sending_documents';
  if (sub === 'search_order') return 'admin';
  return 'status_updates';
}

/** A Tasks-list item (work.ts WorkItem: kind, chip) as a kind of work. */
export function fromTask(item: { kind: string | null; chip?: string | null }): EpaWork {
  const chip = (item.chip ?? '').replace(/^Manual Mode · /, '');
  if (!item.kind) return fromChip(chip);
  if (item.kind.startsWith('proposal:')) {
    const sub = item.kind.slice('proposal:'.length);
    // The draft's content is the conveyancer's own judgement: enquiries and advice are their work, not a check.
    if (sub === 'enquiry_draft') return { kind: 'negotiating' };
    if (sub === 'survey_advice') return { kind: 'advising' };
    return { kind: 'checking_drafts', of: draftOf(sub, chip), action: sub };
  }
  if (item.kind === 'note_actions:ack') return { kind: 'acknowledging' };
  if (item.kind === 'note_actions:email') return { kind: 'client_questions' };
  if (item.kind === 'bank_details') return { kind: 'payments' };
  if (item.kind === 'linked_case') return { kind: 'not_counted' };
  if (item.kind === 'step' || item.kind.startsWith('issue') || item.kind === 'issue') return fromChip(chip);
  // Every review the engine raises (a search, the title, the offer, the contract, ID, the report on title, an escalation).
  return { kind: 'legal_review' };
}

/** A step's or an issue's chip (the kind of work it is) as a kind of work. */
export function fromChip(chip: string): EpaWork {
  if (/^Record (Receipt|Outcome)|^Upload Documents|^File Return|^Submit Application|^Close (File|Case)|^Run Search|^Unsuccessful Send|^Unlock File/.test(chip)) return { kind: 'admin' };
  if (/^Authorise Payment|^Request Funds|^Return Money|^Verify Details/.test(chip)) return { kind: 'payments' };
  if (/^Send .*Documents/.test(chip)) return { kind: 'sending_documents' };
  if (/Request$/.test(chip)) return { kind: 'requesting' };
  if (/^Chase /.test(chip)) return { kind: 'chasing' };
  if (/^Reply To Enquiries|Enquiries$/.test(chip)) return { kind: 'negotiating' };
  if (/^Exchange Contracts|^Confirm Completion/.test(chip)) return { kind: 'exchange_completion' };
  // Document sign-off, drafting the report, resolving an issue, a referral: the conveyancer's judgement.
  return { kind: 'legal_review' };
}

/** An email read in the app, by triage's intent (triage.ts EmailIntent). */
export function fromEmailIntent(intent: string | null | undefined): EpaKind {
  switch (intent) {
    case 'CHASE': return 'being_chased';
    case 'STATUS_UPDATE': return 'admin';
    case 'DOCUMENT_DELIVERY': return 'admin';
    case 'ENQUIRY': return 'negotiating';
    case 'ACTION_REQUIRED': return 'client_questions';
    case 'ADMIN': return 'admin';
    default: return 'client_questions';
  }
}
