/**
 * The playbook: what the system can detect (in an email, a document, or the passing of time)
 * and exactly what it does next. This is the catalogue a firm reviews rule by rule: approve it,
 * or propose different behaviour. A proposal changes nothing here; it is exported as a file for
 * a developer to build from.
 *
 * Each rule names the code that implements it. The maps at the bottom are checked by the
 * compiler and by tests/unit/engine/playbook.test.ts, so a new signal (a note command, a
 * document role, a timer, a deadline) cannot be added without a rule saying what it does.
 */
import crypto from 'node:crypto';
import { DEFAULT_SLA, DEADLINE_LEAD, type DeadlineKind } from './sla';
import { MORTGAGE_EXPIRY_CRITICAL_DAYS, MORTGAGE_EXPIRY_WARNING_DAYS } from './issues';
import type { NoteCommand, WaitKey } from './types';
import type { DocumentClassification } from './ports';

export type PlaybookSource = 'email' | 'document' | 'timer';
export interface PlaybookRule {
  id: string;
  source: PlaybookSource;
  /** What is detected, as a conveyancer would name it. */
  signal: string;
  /** How it is recognised. */
  detects: string;
  /** Who may trigger it, and what happens when someone else says it. */
  from?: string;
  /** What the system does, in order. */
  actions: string[];
  /** Who approves or decides. */
  decides: string;
  /** What it holds, if anything. */
  holds?: string;
  /** Where it is implemented. */
  code: string[];
}

const EMAIL_TASK = "A fee earner ticks the line on the case's \"From an email\" task; nothing applies until they do.";
const SENDS = (what: string) => `${what}: proposed for approval or sent automatically, per the firm's automation level.`;
const wd = (n: number) => `${n} working day${n === 1 ? '' : 's'}`;

const EMAIL: PlaybookRule[] = [
  { id: 'email.survey_decision', source: 'email', signal: 'Client decides after the survey', detects: 'The client says they are satisfied, want to renegotiate, want further checks, or are withdrawing.', from: 'Client only. From anyone else it becomes a request to the client to confirm.', actions: ["Records the client's decision on the property's condition.", 'Satisfied: the survey step is complete and releases its hold on exchange.', 'Further checks: the specialists are routed per the client\'s instruction (see Client instructs on specialists).', 'Renegotiate or withdraw: the survey step stays open for the fee earner.'], decides: EMAIL_TASK, holds: 'Exchange, until the client decides.', code: ['notes.ts senderPolicy', 'machine.ts client_decision_recorded', 'service.ts routeInvestigations'] },
  { id: 'email.specialist_instruction', source: 'email', signal: 'Client instructs on specialists', detects: 'The client says which further investigations to pursue, which evidence to ask the seller for, and which to waive.', from: 'Client only.', actions: ['Pursue: an enquiry asking the seller\'s solicitor for access for the named specialists is drafted.', 'Evidence: an enquiry asking for the existing reports and certificates is drafted.', 'Waive: the investigation is closed as the client\'s choice.', SENDS('Each enquiry')], decides: EMAIL_TASK, code: ['service.ts routeInvestigations', 'survey-review.ts evidenceEnquiry / accessEnquiry'] },
  { id: 'email.exchange_authority', source: 'email', signal: 'Client authorises exchange', detects: 'The client authorises exchange in writing.', from: 'Client only. From anyone else, the client is asked to confirm.', actions: ["Records the client's authority to exchange, satisfying that exchange requirement."], decides: EMAIL_TASK, code: ['notes.ts', 'machine.ts client_decision_recorded'] },
  { id: 'email.third_party_decision', source: 'email', signal: 'Someone reports a client decision', detects: 'An agent, the other side, a broker or anyone else says what the client has decided.', from: 'Anyone other than the client.', actions: ['Nothing is recorded.', SENDS('A message asking the client to confirm what was said, quoting it')], decides: EMAIL_TASK, code: ['notes.ts senderPolicy → confirm_with_client', 'templates.ts confirm_with_client'] },
  { id: 'email.dates', source: 'email', signal: 'Exchange or completion dates proposed', detects: 'A date is named for exchange or completion.', from: 'Anyone. A completion date from the client is also recorded as their agreement; from anyone else, the client is asked to confirm it.', actions: ["Sets the case's target exchange and completion dates.", 'Checks the dates against anyone recorded as away, and records a delay as context if they clash.'], decides: EMAIL_TASK, code: ['notes.ts senderPolicy', 'machine.ts set_target_dates', 'service.ts availability clash'] },
  { id: 'email.price_change', source: 'email', signal: 'Price renegotiated', detects: 'A new price or a reduction is stated (never a deposit, fee, retention or gift).', from: 'Anyone. If not the client, the client is asked to confirm the new terms.', actions: ['Records the new price.', 'Mortgage purchase: raises a lender approval issue for the lender to confirm the new price.'], decides: EMAIL_TASK, holds: 'Exchange, on a mortgage purchase, until the lender confirms.', code: ['notes.ts senderPolicy', 'machine.ts record_price_change'] },
  { id: 'email.availability', source: 'email', signal: 'Someone is away', detects: 'A period of absence with dates ("away 10 to 20 October", "back on the 20th").', from: 'The writer: client, seller\'s side, agent or lender. A stranger\'s absence is not recorded.', actions: ['Records the absence against that party.', 'No chase goes to them while they are away.', 'Client updates mention it; target dates inside it are flagged as context.'], decides: EMAIL_TASK, code: ['notes.ts senderPolicy', 'machine.ts record_availability', 'sla.ts / service.ts tick'] },
  { id: 'email.survey_plan', source: 'email', signal: 'Client\'s survey plan', detects: 'The client says a survey is booked (with its date) or that they are not having one.', from: 'Client only.', actions: ['Booked: no survey check-in before the date.', 'Not having one: recorded as the client\'s choice; the survey check-ins stop.'], decides: EMAIL_TASK, code: ['machine.ts record_survey_plan', 'sla.ts dueActions'] },
  { id: 'email.request_from_seller', source: 'email', signal: 'Client asks us to get something from the seller', detects: 'After our advice, the client says what they want from the seller\'s side: evidence, access, documents.', from: 'Client or a colleague only. From anyone else, nothing goes to the seller.', actions: ['One enquiry covering exactly what the client asked for is drafted to the seller\'s solicitor, editable before it goes.', SENDS('The enquiry')], decides: EMAIL_TASK, code: ['notes.ts senderPolicy', 'service.ts request_from_seller'] },
  { id: 'email.wait_over', source: 'email', signal: 'Chain ready, or a delay is over', detects: '"The chain is complete", "the replies have been sent" and similar.', from: 'Client, the other side or a colleague. An agent\'s word is information only.', actions: ['Closes the open chain or delay item.'], decides: EMAIL_TASK, code: ['notes.ts senderPolicy', 'machine.ts resolve_issue'] },
  { id: 'email.transaction_at_risk', source: 'email', signal: 'A party may be pulling out', detects: 'Pulling out, fallen through, chain collapsed, gazumping.', from: 'Anyone.', actions: ['Raises Transaction at risk.', SENDS("An enquiry asking the seller's solicitor to confirm by return whether their client is proceeding")], decides: EMAIL_TASK, holds: 'Exchange.', code: ['service.ts issue_raised effects'] },
  { id: 'email.mortgage_at_risk', source: 'email', signal: 'Mortgage may be at risk', detects: 'Job loss, a change of job or income, a lender reconsidering, an offer "in doubt".', from: 'Anyone.', actions: ['Raises Mortgage at risk.', `From the lender or broker: ${SENDS('a request to them to confirm whether the offer stands, and a note to the client')}`, `From anyone else: ${SENDS('a message asking the client what has changed, saying the lender must be told before exchange')}`], decides: EMAIL_TASK, holds: 'Exchange.', code: ['notes.ts senderPolicy', 'service.ts issue_raised effects'] },
  { id: 'email.survey_done', source: 'email', signal: 'Survey done, report not received', detects: 'The survey is said to be done and no report is attached.', from: 'Anyone.', actions: ['Raises Survey report outstanding.', SENDS('A message asking the client for the report')], decides: EMAIL_TASK, code: ['service.ts issue_raised effects'] },
  { id: 'email.gift', source: 'email', signal: 'Gift or loan towards the purchase', detects: 'Someone is giving or lending money towards the deposit or price.', from: 'Anyone.', actions: ['Raises a source-of-funds issue: the donor needs identifying and a gift letter; a loan must be disclosed to the lender.'], decides: EMAIL_TASK, holds: 'Exchange.', code: ['notes.ts RULES', 'ai.ts NOTE_INSTRUCTIONS'] },
  { id: 'email.name_change', source: 'email', signal: 'Client\'s name has changed', detects: 'Marriage, deed poll, "now known as".', from: 'Anyone.', actions: ['Raises a due-diligence refresh: evidence of the change is needed before the transfer and the lender documents.'], decides: EMAIL_TASK, holds: 'Exchange.', code: ['notes.ts RULES'] },
  { id: 'email.expected', source: 'email', signal: 'Something is said to be coming', detects: 'Replies, the pack, an offer, a search or management information "expected" or "due".', from: 'Anyone.', actions: ['Records it as awaited (seller delay, offer outstanding, search delayed or freeholder information outstanding); a seller delay is context only.'], decides: EMAIL_TASK, code: ['notes.ts expectedKind', 'issues.ts context kinds'] },
  { id: 'email.problem', source: 'email', signal: 'A problem mentioned in passing', detects: 'Boundary disputes, knotweed, subsidence, missing building regulations, leaks and similar.', from: 'Anyone.', actions: ['Raises an issue for the fee earner to classify; it holds nothing until they do.'], decides: EMAIL_TASK, code: ['notes.ts RULES', 'ai.ts NOTE_INSTRUCTIONS'] },
  { id: 'email.claimed_clear', source: 'email', signal: 'Someone says a check is done', detects: '"ID is done", "searches are back", "the offer is fine".', from: 'Anyone, including the client.', actions: ['Information only. ID/AML, source of funds, searches and the mortgage offer clear only on the document itself or by a fee earner.'], decides: 'No one: nothing is proposed.', code: ['ai.ts NOTE_INSTRUCTIONS', 'notes.ts validateNoteActions'] },
  { id: 'email.bank_details', source: 'email', signal: 'Bank details in an email', detects: 'A sort code and account number in the body.', from: 'Anyone.', actions: ['Records the details as unverified, arrived by email.', 'Raises a bank details decision; payments to that payee are refused until the details are verified by phone to a known number.'], decides: 'A fee earner verifies out of band and records how.', holds: 'Any payment to that payee.', code: ['files.ts bankDetailsIn', 'service.ts recordBankDetails'] },
  { id: 'email.unknown_sender', source: 'email', signal: 'Someone not on the case writes in', detects: 'The sender is not a known contact on the case.', from: 'Unknown senders.', actions: ['The email is filed and a person always sees it.', 'Raises Someone not on the file wrote in; nothing they say is acted on until the fee earner says who they are.'], decides: 'The fee earner sets who they are on the case.', code: ['service.ts recordNote (stranger)', 'files.ts senderRelation'] },
  { id: 'email.attachments', source: 'email', signal: 'Documents attached', detects: 'Any attachment on a filed email.', from: 'Anyone.', actions: ['Each file is filed to the case; an identical file already on the case is not filed twice.', 'Each is read as a document (see the document rules).', '"Attached" never raises an issue that the document is missing.'], decides: 'No one, for filing; the document rules apply to each.', code: ['files.ts fileEmailAttachments', 'service.ts recordNote (ARRIVAL_ISSUES)'] },
];

const DOCUMENT: PlaybookRule[] = [
  { id: 'document.search', source: 'document', signal: 'Search result arrives', detects: 'A local authority, drainage, environmental or other search.', actions: ['Read for entries.', 'Informational entries only: cleared (confirmed by a fee earner unless the firm lets clears go automatically).', 'Any entry of note, or a low-confidence reading: put to the fee earner with the entries cited.'], decides: 'Fee earner, on anything flagged.', holds: 'The pre-contract stage, until every required search is resolved.', code: ['rules.ts evaluateSearch', 'service.ts searchReturned'] },
  { id: 'document.enquiry_reply', source: 'document', signal: 'Replies to enquiries arrive', detects: 'The seller\'s solicitor\'s replies, matched to the open enquiry.', actions: ['Full answer with nothing arising: cleared.', 'Partial, refused or raising something new: put to the fee earner, who can request further information.'], decides: 'Fee earner, on anything flagged.', holds: 'Contract review, until replies are resolved.', code: ['rules.ts evaluateEnquiryReply', 'ingest.ts'] },
  { id: 'document.mortgage_offer', source: 'document', signal: 'Mortgage offer arrives', detects: 'The lender\'s offer (ignored on a cash purchase).', actions: ['Read: amount, borrowers, property, special conditions, expiry.', 'Standard conditions and expiry well after the target exchange: cleared.', 'Non-standard conditions, expiry near or past, or a low-confidence reading: put to the fee earner.', 'Closes the mortgage check-ins with the client; the expiry date is watched from here.'], decides: 'Fee earner, on anything flagged.', holds: 'Exchange, until resolved.', code: ['rules.ts evaluateMortgageOffer', 'projection.ts mortgage_offer_received'] },
  { id: 'document.title', source: 'document', signal: 'Official copies arrive', detects: 'The register and title plan.', actions: ['Read: tenure, restrictions, charges, covenants.', 'Nothing of note: cleared.', 'Restrictions, charges or covenants of note: put to the fee earner.', 'Tenure not what the case expects: the case moves to manual handling.', 'Closes the wait on the contract pack (the chases stop).'], decides: 'Fee earner.', holds: 'Contract review; the report on title follows a resolved title.', code: ['rules.ts evaluateTitle', 'machine.ts title_extracted'] },
  { id: 'document.title_plan', source: 'document', signal: 'Title plan arrives', detects: 'The Land Registry title plan: the map, with no register entries.', actions: ['Read: its title number, what the red edging encloses, every other colour or marking and what it marks, any notes.', 'Shown on the title step beside the register; it never stands in for the register.', 'A title number that differs from the register (a second title, such as a shared drive) is flagged; so is any marking other than the red edging.'], decides: 'Fee earner, with the title.', code: ['extraction.ts extractTitlePlan', 'service.ts titlePlanReceived', 'context.ts title checklist'] },
  { id: 'document.supporting_document', source: 'document', signal: 'Supporting document arrives', detects: 'A document behind the seller\'s forms: an indemnity policy (sewer, lack of building regulations, restrictive covenant), a planning permission, a building regulations certificate, a guarantee, a gas, electrical or FENSA certificate.', actions: ['Read: what it is, what it covers, who issued it, its reference, dates and, for a policy, the limit and whether the cover passes to the buyer and their lender.', 'Shown on the title step with the register.', 'A policy whose cover is not said to pass to the buyer and lender, or with no limit stated, is flagged; a document naming a different property is flagged.', 'An open issue it may answer (works without consents, a missing certificate) gets a note pointing to it.'], decides: 'Fee earner, with the title.', code: ['extraction.ts extractSupportingDocument', 'service.ts supportingDocumentReceived', 'context.ts title checklist'] },
  { id: 'document.lease', source: 'document', signal: 'Lease arrives', detects: 'The lease on a leasehold matter.', actions: ['Read: unexpired term, ground rent and review, alienation.', 'A term below the lender\'s minimum, a short lease, doubling or high ground rent, or an absolute bar on assignment: flagged on the title decision.'], decides: 'Fee earner, with the title.', code: ['rules.ts evaluateLease'] },
  { id: 'document.id_check', source: 'document', signal: 'ID / AML result arrives', detects: "The provider's result.", actions: ['Clear with no flags: cleared.', 'Refer, fail, any flag or a low-confidence reading: put to the fee earner.', 'A rejection stops automation on the case.'], decides: 'Fee earner (the MLRO where the firm routes it).', holds: 'Instruction, until resolved.', code: ['rules.ts evaluateIdCheck'] },
  { id: 'document.contract', source: 'document', signal: 'Draft contract arrives', detects: 'The contract from the seller\'s solicitor.', actions: ['Read, and its points listed for the fee earner under Documents.'], decides: 'Fee earner.', code: ['service.ts contractReceived'] },
  { id: 'document.survey', source: 'document', signal: 'Survey report arrives', detects: "The client's survey.", actions: ['Read: urgent items, items to investigate, points for the legal adviser, valuation.', SENDS("A letter to the client in a conveyancer's voice: no advice on condition, an offer to ask the seller for evidence or arrange access, and a request for their decision"), 'Legal points: enquiries drafted to the seller\'s solicitor.', 'Closes the survey check-ins with the client.'], decides: 'The client, on how to proceed; the fee earner approves what is sent.', holds: 'Exchange, until the client decides.', code: ['service.ts surveyRecommendations', 'ai.ts ClaudeSurveyAdviser'] },
  { id: 'document.specialist_report', source: 'document', signal: 'Specialist report arrives', detects: 'A report on a further investigation (damp, structural, electrics…).', actions: ['Linked to the investigation it answers, for the client to weigh; it does not reopen a hold.'], decides: 'The client.', code: ['service.ts specialistReportReceived'] },
  { id: 'document.management_pack', source: 'document', signal: 'Management pack arrives', detects: 'The LPE1 or managing agent\'s pack on a leasehold purchase.', actions: ['Put to the fee earner: service charge, arrears, major works, insurance.'], decides: 'Fee earner.', holds: 'Pre-contract on a leasehold purchase, until reviewed.', code: ['service.ts managementPackReceived'] },
  { id: 'document.property_forms', source: 'document', signal: 'Property forms arrive', detects: 'TA6, TA10, TA7 or TA13.', actions: ['Read; disclosures raise issues: disputes, notices, works without consents, missing certificates.', 'On a sale, the contract pack can then go.'], decides: 'Fee earner, on each issue raised.', code: ['property-forms.ts', 'service.ts propertyFormsReceived'] },
  { id: 'document.revision', source: 'document', signal: 'A new version of a document arrives', detects: 'A document replacing one already on the case (same item or version key).', actions: ['Filed as a new version of the same document.', 'What changed between the readings is set out for the fee earner.'], decides: 'Fee earner.', code: ['files.ts supersedeAsVersion / surfaceRevision'] },
  { id: 'document.other', source: 'document', signal: 'Any other document', detects: 'A document the classifier cannot place, or placed with low confidence.', actions: ['Filed to the case and indexed for search; nothing else happens.'], decides: 'Fee earner, if it matters.', code: ['ingest.ts routeClassification'] },
];

const WAIT_SIGNAL: Record<WaitKey, string> = {
  id_check: 'ID check outstanding', search: 'Search result overdue', enquiry: 'Replies to enquiries overdue', funds: 'Completion funds not received', registration: 'Registration outstanding', proof_of_funds: 'Proof-of-funds form not returned', management_pack: 'Management pack overdue', property_forms: 'Property forms not returned', redemption: 'Redemption statement overdue', lender_consent: "Lender's consent outstanding", discharge: 'Discharge not confirmed', contract_pack: 'Contract pack overdue', signed_documents: 'Signed deeds not returned', mortgage_offer: 'Mortgage offer not yet issued', survey: 'No word on the survey', deposit: 'Deposit not received', client_decision: 'Client has not decided', insurance: 'Buildings insurance not evidenced',
};
const RECIPIENT: Record<string, string> = { seller_solicitor: "the other side's solicitor", search_provider: 'the search provider', lender: 'the lender', client: 'the client', id_provider: 'the client', hmlr: 'HM Land Registry' };

const TIMER: PlaybookRule[] = [
  { id: 'timer.offer_expiring', source: 'timer', signal: 'Mortgage offer about to expire', detects: `The offer expires within ${MORTGAGE_EXPIRY_WARNING_DAYS} days and contracts are not exchanged.`, actions: ['Raises Mortgage offer expiring: contact the broker or lender about an extension, or start a re-issue.', `Becomes critical at ${MORTGAGE_EXPIRY_CRITICAL_DAYS} days.`, 'Closes itself on exchange or when a new offer is on file.'], decides: 'Fee earner.', code: ['sla.ts timedIssueActions'] },
  { id: 'timer.offer_expired', source: 'timer', signal: 'Mortgage offer expired', detects: 'The expiry date has passed before exchange.', actions: ['The offer is marked withdrawn and the mortgage step reopens.', 'Raises Mortgage offer expired (critical): a fresh application, valuation and offer are needed.', 'The fee earner tells the chain the timetable has moved.'], decides: 'Fee earner.', holds: 'Exchange, until a new offer is resolved.', code: ['sla.ts timedIssueActions', 'machine.ts mortgage_offer_withdrawn'] },
  { id: 'timer.cdd_refresh', source: 'timer', signal: 'Client due diligence over a year old', detects: 'The client was identified more than a year ago on a matter still open.', actions: ['Raises a due-diligence refresh: re-verify, confirm the address, re-screen PEP and sanctions, record the review.'], decides: 'Fee earner.', code: ['sla.ts timedIssueActions'] },
  { id: 'timer.search_delayed', source: 'timer', signal: 'Search badly overdue', detects: `A search still outstanding at ${wd(DEFAULT_SLA.search.escalateAfter)}.`, actions: ['Raises Search delayed: consider indemnity if the lender allows, and re-plan the dates.', 'Closes itself when the result arrives.'], decides: 'Fee earner.', code: ['sla.ts timedIssueActions'] },
  { id: 'timer.enquiry_unanswered', source: 'timer', signal: 'Enquiry badly overdue', detects: `An enquiry unanswered at ${wd(DEFAULT_SLA.enquiry.escalateAfter)}.`, actions: ['Raises Enquiry unanswered: escalate through the agent and re-plan the dates.', 'Closes itself when the reply arrives.'], decides: 'Fee earner.', code: ['sla.ts timedIssueActions'] },
  { id: 'timer.stale_issue', source: 'timer', signal: 'An issue has not moved', detects: 'An open issue untouched for its type\'s escalation period.', actions: ['Its severity goes up one step (to critical at most).'], decides: 'No one: automatic.', code: ['sla.ts timedIssueActions'] },
  ...(Object.keys(DEADLINE_LEAD) as DeadlineKind[]).map((k): PlaybookRule => ({
    id: `timer.deadline.${k}`, source: 'timer', signal: ({ mortgage_offer_expiry: 'Offer expiry before exchange', certificate_of_title: 'Certificate of title due to the lender', sdlt_filing: 'SDLT return due', notice_to_complete: 'Notice to complete expiring', requisition_reply: 'HMLR requisition reply due', stale_issue: 'Issue with no movement', priority_period_expiry: 'OS1 priority period ending' } as Record<DeadlineKind, string>)[k],
    detects: `${wd(DEADLINE_LEAD[k])} before the date.`, actions: ['A deadline file note is created and the fee earner is alerted with it.'], decides: 'Fee earner.', code: ['sla.ts deadlineActions', 'service.ts tick'],
  })),
  ...(Object.keys(DEFAULT_SLA) as WaitKey[]).map((k): PlaybookRule => {
    const r = DEFAULT_SLA[k];
    return {
      id: `timer.chase.${k}`, source: 'timer', signal: WAIT_SIGNAL[k], detects: `No response ${wd(r.chaseAfter)} after we asked.`,
      actions: [SENDS(`A chase to ${RECIPIENT[r.recipientRole] ?? r.recipientRole.replace(/_/g, ' ')} restating what was asked for${r.chaseEvery ? `, repeated every ${wd(r.chaseEvery)}` : ''}`), `Escalated to the fee earner at ${wd(r.escalateAfter)}, then every ${wd(r.reEscalateAfter)}.`, 'No chase while the recipient is recorded as away.'],
      decides: 'Fee earner, on escalation.', code: ['sla.ts DEFAULT_SLA / dueActions', 'chase-content.ts'],
    };
  }),
];

/** The part of the transaction each rule belongs to, in the order a case runs. */
export const PLAYBOOK_STAGES = ['Instruction', 'Source Of Funds', 'Searches', 'Title And Contract', 'Enquiries', 'Survey', 'Mortgage', 'Leasehold', 'Exchange', 'Signing And Completion', 'After Completion', 'Throughout'] as const;
export type PlaybookStage = (typeof PLAYBOOK_STAGES)[number];
const STAGE_OF: Record<string, PlaybookStage> = {
  'email.survey_decision': 'Survey', 'email.specialist_instruction': 'Survey', 'email.survey_plan': 'Survey', 'email.survey_done': 'Survey',
  'email.exchange_authority': 'Exchange', 'email.dates': 'Exchange', 'email.wait_over': 'Exchange', 'email.price_change': 'Exchange',
  'email.request_from_seller': 'Enquiries', 'email.mortgage_at_risk': 'Mortgage', 'email.gift': 'Source Of Funds', 'email.name_change': 'Instruction',
  'document.search': 'Searches', 'document.enquiry_reply': 'Enquiries', 'document.mortgage_offer': 'Mortgage', 'document.title': 'Title And Contract', 'document.title_plan': 'Title And Contract', 'document.supporting_document': 'Title And Contract', 'document.contract': 'Title And Contract', 'document.property_forms': 'Title And Contract',
  'document.lease': 'Leasehold', 'document.management_pack': 'Leasehold', 'document.id_check': 'Instruction', 'document.survey': 'Survey', 'document.specialist_report': 'Survey',
  'timer.offer_expiring': 'Mortgage', 'timer.offer_expired': 'Mortgage', 'timer.cdd_refresh': 'Instruction', 'timer.search_delayed': 'Searches', 'timer.enquiry_unanswered': 'Enquiries',
  'timer.deadline.mortgage_offer_expiry': 'Mortgage', 'timer.deadline.sdlt_filing': 'After Completion', 'timer.deadline.notice_to_complete': 'Signing And Completion', 'timer.deadline.requisition_reply': 'After Completion', 'timer.deadline.priority_period_expiry': 'Signing And Completion',
  'timer.chase.id_check': 'Instruction', 'timer.chase.proof_of_funds': 'Source Of Funds', 'timer.chase.search': 'Searches', 'timer.chase.enquiry': 'Enquiries', 'timer.chase.contract_pack': 'Title And Contract', 'timer.chase.property_forms': 'Title And Contract',
  'timer.chase.management_pack': 'Leasehold', 'timer.chase.mortgage_offer': 'Mortgage', 'timer.chase.lender_consent': 'Mortgage', 'timer.chase.survey': 'Survey', 'timer.chase.funds': 'Signing And Completion', 'timer.chase.redemption': 'Signing And Completion', 'timer.chase.signed_documents': 'Signing And Completion',
  'timer.chase.registration': 'After Completion', 'timer.chase.discharge': 'After Completion',
};
/** A rule's stage; anything not placed runs throughout the case. */
export const stageOf = (id: string): PlaybookStage => STAGE_OF[id] ?? 'Throughout';

export const PLAYBOOK: PlaybookRule[] = [...EMAIL, ...DOCUMENT, ...TIMER];

/** Every note command maps to the rules that describe it (the compiler insists on all of them). */
export const NOTE_COMMAND_RULES: Record<NoteCommand['type'], string[]> = {
  client_decision_recorded: ['email.survey_decision', 'email.specialist_instruction', 'email.exchange_authority'],
  confirm_with_client: ['email.third_party_decision'],
  set_target_dates: ['email.dates'],
  record_price_change: ['email.price_change'],
  resolve_issue: ['email.wait_over'],
  request_from_seller: ['email.request_from_seller'],
  record_availability: ['email.availability'],
  record_survey_plan: ['email.survey_plan'],
  raise_issue: ['email.transaction_at_risk', 'email.mortgage_at_risk', 'email.survey_done', 'email.gift', 'email.name_change', 'email.expected', 'email.problem'],
};
/** Every document role maps to its rule. */
export const DOCUMENT_ROLE_RULES: Record<DocumentClassification['role'], string> = {
  search: 'document.search', enquiry_reply: 'document.enquiry_reply', mortgage_offer: 'document.mortgage_offer', title: 'document.title', title_plan: 'document.title_plan', supporting_document: 'document.supporting_document', id_check: 'document.id_check', contract: 'document.contract', survey: 'document.survey', specialist_report: 'document.specialist_report', management_pack: 'document.management_pack', lease: 'document.lease', property_forms: 'document.property_forms', other: 'document.other',
};

export const ruleHash = (r: PlaybookRule): string => crypto.createHash('sha256').update(JSON.stringify([r.signal, r.detects, r.from ?? '', r.actions, r.decides, r.holds ?? ''])).digest('hex').slice(0, 16);
export const SOURCE_LABEL: Record<PlaybookSource, string> = { email: 'From Email', document: 'From Documents', timer: 'From Timers' };
