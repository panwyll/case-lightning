/**
 * The state machine, described in code.
 *
 * Everything the read-only map (/engine/map) shows comes from here, and everything here
 * is either
imported from the machine (stages, event types, decision kinds and options,
 * SLA numbers, deadline leads, the user-command set, the trigger registry) or declared
 * next to it and checked against it by tests/unit/engine/spec.test.ts — so the picture
 * cannot drift from the code without a test going red.
 */
import { CASE_SHAPES, SHAPE_SPEC, type CaseShape } from './shapes';
import crypto from 'node:crypto';
import { DEFAULT_SLA, DEADLINE_LEAD, type DeadlineKind } from './sla';
import { OPTIONS_FOR, MIN_EXTRACTION_CONFIDENCE } from './rules';
import { USER_COMMANDS, type Command } from './machine';
import { DECISION_EVENT_TYPES, DECISION_KINDS, EVENT_TYPES, STAGES, SUB_FLOWS, TRANSACTION_TYPES, type DecisionKind, type DecisionOption, type EventType, type Stage, type SubFlow, type TransactionType, type WaitKey } from './types';
import { TRANSACTION_PROFILES, type TransactionProfile } from './transactions';
import { TRIGGERS, type TriggerSpec } from './triggers';
import { ISSUE_GROUPS, ISSUE_GROUP_LABEL, ISSUE_KIND_SPECS, ISSUE_RESOLUTIONS, RESOLUTION_LABEL, RESOLUTION_TITLE, RESOLUTION_FIELDS, RESOLUTION_EFFECT, NOTE_REQUIRED, FORMLESS_KINDS, ISSUE_CHIP, issueSteps, EVENTS_WITH_STEPS, type IssueStep, type ResolutionField, LENDER_NOTIFY_RESOLUTIONS, PRICE_RESOLUTIONS, REOPENS_OFFER, type IssueKindSpec, type IssueGroup, type IssueResolution } from './issues';
import { MIN_CLASSIFICATION_CONFIDENCE } from './ingest';

export type CommandType = Command['type'];
export type ActorKind = 'person' | 'automation' | 'either';

export interface StageSpec {
  id: Stage;
  label: string;
  purpose: string;
  /** What must be true to leave (mirrors stageBlockers). */
  gates: string[];
  /** Words a bare state's blockers must mention (spec test). */
  gateKeywords: string[];
  subflows: SubFlow[];
  /** Commands a person typically records here (informational; the command table is authoritative). */
  typical: CommandType[];
}

export interface SubflowSpec {
  id: SubFlow;
  label: string;
  stage: Stage | 'any';
  waitKey: WaitKey | null;
  /** The event pair pattern: how it starts, what the rule layer emits, how a person closes it. */
  start: EventType[];
  extracted: EventType | null;
  cleared: EventType | null;
  flagged: EventType | null;
  reviewed: EventType | null;
  decisionKind: DecisionKind | null;
  /** Plain-English rule: what auto-clears, what flags. */
  rule: string;
}

export interface CommandSpec {
  type: CommandType;
  actor: ActorKind;
  /** Stages in which it is accepted ('any' = whenever enrolled). */
  stages: Stage[] | 'any' | 'not_enrolled';
  emits: EventType[];
  description: string;
  /** From the eventualities research rather than the original spec. */
  eventuality?: boolean;
  /** From the issues research (docs/engine-issues.md). */
  issue?: boolean;
  /** Human-gated at the database (addendum 3 §1). */
  humanGated?: boolean;
  /** Hard stop when a bank-details decision is pending (addendum 2). */
  hardStop?: boolean;
  /** Transaction types the command applies to (absent = all; docs/transaction-types.md). */
  types?: TransactionType[];
}

export interface Invariant {
  id: string;
  title: string;
  rule: string;
  enforcedBy: string[];
}

export interface EventualitySpec {
  area: string;
  scenario: string;
  handling: 'built' | 'manual' | 'outside' | 'gap';
  mechanism: string;
}

export interface MachineSpec {
  version: string;
  generatedFrom: string;
  /** One machine, parameterised by profile (docs/transaction-types.md). */
  transactionTypes: TransactionProfile[];
  /** Enrolment shapes (shapes.ts): what a case can be beyond its type, and what each adds. */
  shapes: Array<{ id: CaseShape; label: string; sides: string[]; summary: string; issue: string; gate: string; fundsFrom: string | null }>;
  stages: StageSpec[];
  terminal: Array<{ id: string; label: string; how: string }>;
  subflows: SubflowSpec[];
  commands: CommandSpec[];
  events: Array<{ type: EventType; category: string; decision: boolean; humanGated: boolean }>;
  decisions: Array<{ kind: DecisionKind; label: string; options: DecisionOption[]; source: string }>;
  timers: {
    waits: Array<{ waitKey: WaitKey; chaseAfter: number; chaseEvery: number | null; escalateAfter: number; reEscalateAfter: number; recipientRole: string; template: string }>;
    deadlines: Array<{ kind: DeadlineKind; leadWorkingDays: number; description: string }>;
  };
  thresholds: { extractionConfidence: number; classificationConfidence: number };
  invariants: Invariant[];
  triggers: TriggerSpec[];
  eventualities: EventualitySpec[];
  /** The issues layer (docs/engine-issues.md): kinds by group, resolutions, and the effects the machine attaches. */
  issues: {
    groups: Array<{ id: IssueGroup; label: string }>;
    kinds: IssueKindSpec[];
    resolutions: Array<{ id: IssueResolution; label: string; title: string; fields: ResolutionField[]; noteRequired: boolean; effect: string | null; effects: string[] }>;
    staleAfterWorkingDays: number;
    formless: string[];
    chips: Record<string, string>;
    /** What a person does about each kind (issues.ts `issueSteps`), labels and recipients only. */
    steps: Record<string, Array<ReturnType<typeof stepView>>>;
    /** The same, acting for the seller. */
    sellerSteps: Record<string, Array<ReturnType<typeof stepView>>>;
    /** Steps of issues raised by an event with its own (issue.event). */
    eventSteps: Record<string, Array<ReturnType<typeof stepView>>>;
  };
}

export const STAGE_SPECS: StageSpec[] = [
  { id: 'instruction', label: 'Instruction', purpose: 'Client instructed; identity and AML established before anything is ordered.', gates: ['ID / AML check resolved (cleared by the rule layer, or reviewed by a person)'], gateKeywords: ['ID/AML'], subflows: ['id_check'], typical: ['enrol', 'request_id_check', 'mark_manual_handling'] },
  { id: 'pre_contract', label: 'Pre-contract', purpose: 'Searches ordered automatically on entry; enquiries raised; the mortgage offer checked; on a leasehold purchase, the management pack reviewed.', gates: ['every required search ordered and resolved', 'every enquiry replied and resolved (or withdrawn)', 'mortgage offer resolved (lender-funded purchases)', 'management pack reviewed (leasehold)'], gateKeywords: ['search'], subflows: ['search', 'enquiry', 'mortgage'], typical: ['raise_enquiry', 'record_search_ordered', 'search_returned', 'mortgage_offer_received', 'withdraw_enquiry', 'set_target_dates'] },
  { id: 'contract_review', label: 'Contract review', purpose: 'Title reviewed; the report on title drafted by AI, approved by a person, sent.', gates: ['title resolved', 'report on title sent (drafted → approved by a person → sent)', 'enquiries raised during review resolved', 'a re-ordered search resolved'], gateKeywords: ['title'], subflows: ['title', 'report_on_title'], typical: ['draft_report_on_title', 'record_report_on_title_sent', 'deposit_received'] },
  { id: 'pre_exchange', label: 'Pre-exchange', purpose: 'Deposit in; exchange conditions derived; contracts exchanged with a completion date.', gates: ['mortgage offer still current (not withdrawn)', 'no open issue holding exchange', 'proof of funds signed off (firm policy)', 'client satisfied with the physical condition where a survey is on file', 'client\'s authority to exchange (firm policy)', 'exchange conditions met (deposit received)', 'contracts exchanged'], gateKeywords: ['exchange'], subflows: [], typical: ['deposit_received', 'contracts_exchanged', 'mortgage_offer_withdrawn', 'record_bank_details'] },
  { id: 'exchanged', label: 'Exchanged', purpose: 'Bound. Completion statement generated.', gates: ['completion statement generated'], gateKeywords: ['completion statement'], subflows: [], typical: ['completion_statement_generated', 'change_completion_date', 'notice_to_complete_served'] },
  { id: 'pre_completion', label: 'Pre-completion', purpose: 'The deeds executed and the certificate of title sent; the advance and the client\'s balance in; the completion payment authorised by a person against verified bank details; completion confirmed.', gates: ['transfer deed executed', 'mortgage deed executed and certificate of title sent (lender-funded)', 'mortgage advance and the client\'s balance received', 'completion payment authorised against verified bank details by a person', 'no bank-details change pending (hard stop)', 'completion confirmed'], gateKeywords: ['transfer deed', 'mortgage advance', 'completion payment'], subflows: [], typical: ['funds_requested', 'funds_received', 'payment_authorised', 'completion_confirmed'] },
  { id: 'completed', label: 'Completed', purpose: 'SDLT within 14 days; AP1 lodged.', gates: ['SDLT or AP1 submitted'], gateKeywords: ['SDLT'], subflows: [], typical: ['sdlt_submitted', 'ap1_submitted'] },
  { id: 'post_completion', label: 'Post-completion', purpose: 'Registration at HM Land Registry; requisitions answered.', gates: ['HMLR requisitions answered', 'registration confirmed (terminal)'], gateKeywords: ['registration'], subflows: [], typical: ['hmlr_requisition_received', 'ap1_confirmed'] },
];

export const SUBFLOW_SPECS: SubflowSpec[] = [
  { id: 'id_check', label: 'ID / AML', stage: 'instruction', waitKey: 'id_check', start: ['id_check_requested'], extracted: null, cleared: 'id_check_cleared', flagged: 'id_check_flagged', reviewed: 'id_check_reviewed', decisionKind: 'id_check', rule: 'Provider outcome "clear" with no flags → clear; "refer"/"fail", any flag, or low extraction confidence → flag. Reject halts automation.' },
  { id: 'search', label: 'Searches', stage: 'pre_contract', waitKey: 'search', start: ['search_ordered', 'search_returned'], extracted: 'search_extracted', cleared: 'search_cleared', flagged: 'search_flagged', reviewed: 'search_reviewed', decisionKind: 'search', rule: 'Only info-severity entries → clear; any low/medium/high flag, or confidence below the threshold → flag. A resolved search may be re-ordered (new cycle).' },
  { id: 'enquiry', label: 'Enquiries', stage: 'pre_contract', waitKey: 'enquiry', start: ['enquiry_raised', 'enquiry_reply_received'], extracted: null, cleared: 'enquiry_reply_cleared', flagged: 'enquiry_reply_flagged', reviewed: 'enquiry_reply_reviewed', decisionKind: 'enquiry', rule: 'Reply "answered" with no issues → clear; partial/refused/issues → flag. "Request further" raises a tracked follow-up; a person may withdraw one.' },
  { id: 'mortgage', label: 'Mortgage offer', stage: 'pre_contract', waitKey: null, start: ['mortgage_offer_received'], extracted: 'mortgage_offer_extracted', cleared: 'mortgage_offer_cleared', flagged: 'mortgage_condition_flagged', reviewed: 'mortgage_condition_reviewed', decisionKind: 'mortgage', rule: 'Standard conditions only and expiry comfortably after the target exchange → clear; any special condition, near expiry, or low confidence → flag. Withdrawal reopens the sub-flow and blocks exchange.' },
  { id: 'title', label: 'Title', stage: 'contract_review', waitKey: null, start: ['title_extracted', 'lease_extracted'], extracted: 'title_extracted', cleared: 'title_cleared', flagged: 'title_flagged', reviewed: 'title_reviewed', decisionKind: 'title', rule: 'Freehold with no restrictions, charges or covenants → clear; any entry → flag with the register section cited; non-freehold tenure → manual handling.' },
  { id: 'report_on_title', label: 'Report on title', stage: 'contract_review', waitKey: null, start: ['report_on_title_drafted'], extracted: null, cleared: null, flagged: 'report_on_title_drafted', reviewed: 'report_on_title_approved', decisionKind: 'report_on_title', rule: 'Always a decision: the AI draft is approved or rejected by a person; it is sent only after the approval event, and the database refuses a send without one.' },
  { id: 'proof_of_funds', label: 'Proof of funds', stage: 'any', waitKey: 'proof_of_funds', start: ['proof_of_funds_requested'], extracted: null, cleared: null, flagged: 'proof_of_funds_submitted', reviewed: 'proof_of_funds_reviewed', decisionKind: 'proof_of_funds', rule: 'Always a decision: the client\'s declaration is rule-checked (shortfall, unevidenced source, gift, repayable gift, higher-risk source, incomplete declarations) and briefed; the conveyancer signs off, asks for more (re-opens the form), escalates or rejects (manual handling). A round in flight holds exchange.' },
  { id: 'management_pack', label: 'Management pack (leasehold)', stage: 'pre_contract', waitKey: 'management_pack', start: ['management_pack_requested'], extracted: null, cleared: null, flagged: 'management_pack_received', reviewed: 'management_pack_reviewed', decisionKind: 'management_pack', rule: 'Leasehold only. Always a decision: the LPE1 is a set of client-advice points (service charge, ground rent, arrears, major works, insurance). Gates pre_contract on a leasehold purchase.' },
  { id: 'chase', label: 'Chasing & escalation', stage: 'any', waitKey: null, start: ['chase_sent'], extracted: null, cleared: null, flagged: 'escalation_raised', reviewed: 'escalation_resolved', decisionKind: 'escalation', rule: 'Working-day timers chase the party that owes us and escalate to a person with a dossier; deadlines we owe are raised once, in time.' },
];

export const COMMAND_SPECS: CommandSpec[] = [
  { type: 'enrol', actor: 'either', stages: 'not_enrolled', emits: ['matter_created', 'issue_raised', 'id_party_added'], description: 'Put a matter under the engine (lender?, required searches, target dates, counterparty type, shadow mode).' },
  { type: 'mark_manual_handling', actor: 'either', stages: 'any', emits: ['manual_handling_required'], description: 'Stop automation; a person runs the matter from here.' },
  { type: 'request_id_check', actor: 'either', stages: 'any', emits: ['id_check_requested'], description: 'Ask the ID provider (or record that the firm did) — for the first client, or for a named party (co-client, gift donor).' },
  { type: 'id_check_result', actor: 'automation', stages: 'any', emits: ['id_check_cleared', 'id_check_flagged', 'auto_clear_review_raised'], description: 'The provider\'s report, extracted and rule-checked.' },
  { type: 'record_search_ordered', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['search_ordered'], description: 'A search placed (automatically on pre_contract entry, or by hand; a resolved search may be re-ordered).' },
  { type: 'search_returned', actor: 'either', stages: 'any', emits: ['search_returned'], description: 'The result document is back.' },
  { type: 'search_extracted', actor: 'automation', stages: 'any', emits: ['search_extracted', 'search_cleared', 'search_flagged', 'auto_clear_review_raised', 'issue_raised'], description: 'Facts extracted from the result, rule-checked. The findings that change what the file needs each raise an issue of their own kind, once per case (findings.ts).' },
  { type: 'raise_enquiry', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['enquiry_raised'], description: 'An enquiry to the other side (external, or internal across the wall); may be raised from an open issue, which then tracks it.' },
  { type: 'enquiry_reply_received', actor: 'automation', stages: 'any', emits: ['enquiry_reply_received', 'enquiry_reply_cleared', 'enquiry_reply_flagged', 'auto_clear_review_raised'], description: 'A reply document, extracted and rule-checked.' },
  { type: 'mortgage_offer_received', actor: 'either', stages: 'any', emits: ['mortgage_offer_received'], description: 'The offer document is on file.' },
  { type: 'mortgage_offer_extracted', actor: 'automation', stages: 'any', emits: ['mortgage_offer_extracted', 'mortgage_offer_cleared', 'mortgage_condition_flagged', 'auto_clear_review_raised'], description: 'Conditions and expiry extracted, rule-checked.' },
  { type: 'lease_extracted', actor: 'automation', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['lease_extracted', 'title_cleared', 'title_flagged', 'auto_clear_review_raised', 'issue_raised'], description: 'The lease read: term, rent and review, service charge, repairs, alienation, use, insurance, notices; its flags go through the title decision. The findings that change what the file needs each raise an issue of their own kind, once per case (findings.ts).' },
  { type: 'title_extracted', actor: 'automation', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['title_extracted', 'title_cleared', 'title_flagged', 'auto_clear_review_raised', 'manual_handling_required', 'issue_raised'], description: 'Register entries extracted, rule-checked; non-freehold halts automation. The findings that change what the file needs each raise an issue of their own kind, once per case (findings.ts).' },
  { type: 'open_decision_source', actor: 'person', stages: 'any', emits: ['decision_source_opened'], description: 'The handler opened the cited source (precondition of resolving).' },
  { type: 'resolve_decision', actor: 'person', stages: 'any', emits: ['id_check_reviewed', 'search_reviewed', 'enquiry_reply_reviewed', 'mortgage_condition_reviewed', 'title_reviewed', 'report_on_title_approved', 'report_on_title_rejected', 'escalation_raised', 'escalation_resolved', 'bank_details_verified', 'bank_details_verification_failed', 'auto_clear_confirmed', 'hmlr_requisition_responded', 'enquiry_raised', 'manual_handling_required', 'proof_of_funds_reviewed', 'management_pack_reviewed', 'issue_resolved', 'issue_raised'], description: 'Choose an option (with a reason unless approving); may raise a follow-up enquiry, an escalation, or halt automation. Signing off proof of funds closes the source-of-funds issues it answers and tells the lender about a gift.' },
  { type: 'draft_report_on_title', actor: 'automation', stages: ['pre_contract', 'contract_review'], emits: ['report_on_title_drafted'], description: 'The AI drafts; the draft is a decision. In pre-contract it is an interim report (searches, enquiries or the offer still to come) and a supplementary one is due before exchange; in contract review it is the full report.' },
  { type: 'set_issue_severity', actor: 'either', stages: 'any', emits: ['issue_severity_changed'], description: 'Severity moved by a person, or by the timer as a deadline nears / an issue sits.', issue: true },
  { type: 'survey_received', actor: 'automation', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['survey_received', 'issue_raised'], description: 'The client\'s survey read for its recommendations (facts); each "further investigation" raises an issue holding exchange.' },
  { type: 'specialist_report_received', actor: 'automation', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['specialist_report_received', 'issue_resolved', 'issue_raised'], description: 'A specialist report read: "no further investigation" resolves the issue (a fact); a further recommendation chains a new issue (causedBy).' },
  { type: 'client_decision_recorded', actor: 'person', stages: 'any', emits: ['client_decision_recorded', 'issue_raised'], description: 'What only the client decides — satisfied with the physical condition, authority to exchange, accept a risk, accept terms — recorded by a person, never inferred. "Renegotiate" raises a survey_defect issue.' },
  { type: 'close_matter', actor: 'person', stages: ['post_completion'], emits: ['matter_closed'], description: 'File closed after registration (and, leasehold, the notice of assignment) with no open issues.' },
  { type: 'request_proof_of_funds', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['proof_of_funds_requested'], description: 'Issue the tokenised proof-of-funds form and send it to the client (recorded after the send; the client wait opens).' },
  { type: 'raise_proof_of_funds_query', actor: 'person', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['proof_of_funds_query_raised'], description: 'A person adds a query to the client about a transaction or a gap (the rules draft theirs at submission).' },
  { type: 'withdraw_proof_of_funds_query', actor: 'person', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['proof_of_funds_query_withdrawn'], description: 'A drafted query is not put, with the reason on the log ("considered and discounted").' },
  { type: 'proof_of_funds_submitted', actor: 'automation', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['proof_of_funds_query_answered', 'proof_of_funds_query_raised', 'proof_of_funds_submitted', 'id_party_added'], description: 'The client submitted: answers to the queries sent, statements read transaction by transaction, rule flags (declaration and transaction level) each drafting a query, the declaration document, the risk rating, and a decision for the conveyancer.' },
  { type: 'management_pack_requested', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['management_pack_requested'], description: 'Leasehold: the LPE1 requested from the seller\'s side / managing agent; the wait opens.' },
  { type: 'management_pack_received', actor: 'either', stages: 'any', emits: ['management_pack_received'], description: 'Leasehold: the pack arrived; always a decision citing it.' },
  { type: 'notice_of_assignment_served', actor: 'either', stages: ['completed', 'post_completion'], emits: ['notice_of_assignment_served'], description: 'Leasehold: notice of assignment / charge served on the landlord after completion.' },
  { type: 'record_report_on_title_sent', actor: 'person', stages: ['contract_review'], emits: ['report_on_title_sent'], description: 'Sent — only after the approval event, and the database checks that too.', humanGated: true },
  { type: 'deposit_received', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['deposit_received', 'exchange_conditions_met', 'issue_raised', 'issue_resolved'], description: 'Deposit in; at pre_exchange this derives exchange_conditions_met. Compared with the contract deposit: short → deposit_issue holding exchange, topped up by a further receipt.' },
  { type: 'contracts_exchanged', actor: 'either', stages: ['pre_exchange'], emits: ['contracts_exchanged', 'stage_advanced'], description: 'Exchange with a completion date; refused if the offer is withdrawn or a search is re-ordered.' },
  { type: 'completion_statement_generated', actor: 'either', stages: ['exchanged'], emits: ['completion_statement_generated', 'stage_advanced'], description: 'Statement produced (can be regenerated).' },
  { type: 'record_bank_details', actor: 'either', stages: 'any', emits: ['bank_details_recorded', 'bank_details_change_flagged'], description: 'Bank details arrive (any channel, first time or change) → always a hard-stop decision.' },
  { type: 'payment_authorised', actor: 'person', stages: ['pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['payment_authorised'], description: 'A person authorises a payment against the newest verified record.', humanGated: true, hardStop: true },
  { type: 'funds_requested', actor: 'person', stages: ['pre_completion'], emits: ['funds_requested'], description: 'Ask the lender / client for completion funds into our verified client account.', humanGated: true, hardStop: true },
  { type: 'funds_received', actor: 'either', stages: 'any', emits: ['funds_received', 'issue_raised', 'issue_resolved', 'refund_due'], description: 'Funds landed: checked against what was asked for (short → completion_funds_shortfall holding completion, cleared by a further receipt; over → a refund owed). Uncleared money cannot be paid out.' },
  { type: 'retention_released', actor: 'either', stages: ['completed', 'post_completion'], emits: ['retention_released'], description: "A lender's retention (agreed against a condition) released after completion: waited for and chased from completion, and the file closes only when it is in." },
  { type: 'formula_c_release_given', actor: 'person', stages: ['pre_exchange'], emits: ['formula_c_release_given'], description: 'Formula C Part I: our release until a time today; while it is live we are bound to exchange if called, and the price, the funding and the authority cannot change.' },
  { type: 'formula_c_release_lapsed', actor: 'person', stages: 'any', emits: ['formula_c_release_lapsed'], description: 'The release lapsed uncalled, or a link above failed to release: no contract; exchange is re-planned.' },
  { type: 'record_deal_event', actor: 'person', stages: 'any', emits: ['deal_event_recorded', 'issue_raised', 'client_decision_lapsed'], description: 'The deal before exchange: a contract race, a lock-out, a new-build reservation (its fee credited on the statement), a renegotiation (the authority lapses), a tenant in occupation, a transfer to a nominee or an extra person, a sale replaced by a buy-out between separating owners; each an issue with what to do.' },
  { type: 'record_property_event', actor: 'person', stages: 'any', emits: ['property_event_recorded', 'issue_raised'], description: 'The property damaged, or vacant possession not given: a critical issue with what the contract says (SCS 7.1) and the steps, holding exchange or completion.' },
  { type: 'final_bill_delivered', actor: 'person', stages: ['completed', 'post_completion'], emits: ['final_bill_delivered', 'refund_due'], description: 'The final bill delivered to the client after completion (any balance left and the interest on client money become money owed back): fees come from client money only after it, and the file closes only once it is sent (SRA Accounts Rules 4.3).' },
  { type: 'completion_payment_sent', actor: 'person', stages: ['pre_completion'], emits: ['completion_payment_sent'], description: 'The completion money sent to the seller\'s solicitor, with its CHAPS reference and time: a purchase completes only once it is recorded; completing after the contract day (or after 2pm on it) raises the late-completion compensation.' },
  { type: 'record_contributions', actor: 'person', stages: 'any', emits: ['contributions_recorded', 'issue_raised'], description: "What each co-owner puts in and the declaration of trust's model (fixed, ring-fenced, contribution, floating): each owner's share at purchase from the calculator; unequal money held as joint tenants raises co_ownership_advice (co-owners.ts)." },
  { type: 'ap1_cancelled', actor: 'person', stages: ['completed', 'post_completion'], emits: ['ap1_cancelled', 'issue_raised'], description: 'HM Land Registry cancelled the application: priority lost, a fresh search and a new AP1, the lender told; the AP1 step returns.' },
  { type: 'requisition_extended', actor: 'person', stages: ['completed', 'post_completion'], emits: ['requisition_extended'], description: 'More time agreed on a requisition that cannot be met by its date (awaiting a DS1, a certificate): the new date replaces the old.' },
  { type: 'register_checked', actor: 'person', stages: ['post_completion'], emits: ['register_checked', 'issue_raised'], description: 'The new register read after registration: something wrong becomes an issue to put right; an AP1 file closes only once it is checked.' },
  { type: 'seller_discharge_received', actor: 'either', stages: ['completed', 'post_completion'], emits: ['seller_discharge_received'], description: "On a purchase from a charged seller, their solicitor's DS1 under the undertaking: chased until it arrives, and the file does not close without it." },
  { type: 'record_chain_link', actor: 'person', stages: 'any', emits: ['chain_link_recorded'], description: 'A light record of each link further along the chain (who, ready / not ready / unknown), from agent or solicitor updates; shared with the other side only with the client\'s consent.' },
  { type: 'bankruptcy_search_entry', actor: 'person', stages: 'any', emits: ['bankruptcy_search_entry_found', 'issue_raised'], description: 'The K16 shows an entry against a borrower: a critical issue holding completion and the certificate of title until it is shown to be a namesake or the lender instructs.' },
  { type: 'record_completion_event', actor: 'person', stages: 'any', emits: ['completion_event_recorded', 'issue_raised'], description: 'What goes wrong on and around completion day (completion-events.ts): money sent to the wrong account, completion missed today, keys not released, the seller\'s solicitor not confirming, redemption money returned, our undertaking chased, a retention held under the contract; each an issue with what to do.' },
  { type: 'sdlt_amended', actor: 'person', stages: 'any', emits: ['sdlt_amended', 'refund_due', 'issue_raised'], description: 'An SDLT return amended: within 12 months by amendment, after that by an overpayment relief claim within four years; a refund is owed back to the client, extra tax asked for.' },
  { type: 'record_client_names', actor: 'either', stages: 'any', emits: ['client_names_recorded', 'id_party_added'], description: 'The clients named from the matter record, for a case enrolled without them: who is our client decides what a death, a bankruptcy or a signature means.' },
  { type: 'record_isa', actor: 'person', stages: 'any', emits: ['isa_recorded', 'issue_raised'], description: "An ISA's dates: a Lifetime ISA open under 12 months by completion is raised with the date it becomes usable; a Help to Buy ISA's closing date sets the bonus-claim deadline (12 months, and 1 December 2030)." },
  { type: 'add_shape', actor: 'person', stages: 'any', emits: ['shape_added', 'issue_raised', 'charge_found'], description: 'A case shape found after enrolment (an attorney who benefits, a vulnerable client, a related-party sale, a deputy, trustees): its checklist issue is raised as at enrolment, and any charge it brings is added (shapes.ts).' },
  { type: 'record_party_event', actor: 'person', stages: 'any', emits: ['party_event_recorded', 'issue_raised'], description: "Something happened to a person on the case (died, lost or doubtful capacity, bankrupt, someone else instructing, a confidence between joint clients, a co-owner who will not sign, ID refused, a complaint, asked to hide something from the lender, a gift withdrawn, uncontactable, moving firm, ceasing to act): the consequences before or after exchange as issues (who can instruct, sign and be paid; the lender told), and nothing more is sent to a client who has died (people.ts)." },
  { type: 'sar_made', actor: 'person', stages: 'any', emits: ['sar_made'], description: 'The MLRO has made a report and asked for consent: no money moves and nothing exchanges or completes for seven working days (deemed consent) or until the answer; the reason given anywhere is neutral (no tipping off).' },
  { type: 'daml_response', actor: 'person', stages: 'any', emits: ['daml_response_recorded'], description: 'Consent granted (the hold lifts) or refused (a 31-day moratorium).' },
  { type: 'record_sdlt_facts', actor: 'either', stages: 'any', emits: ['sdlt_facts_recorded', 'issue_raised'], description: "The buyers' SDLT answers: the basis is worked out from them with a reason for each part (sdlt-facts.ts); a changed estimate and a shape the answers contradict raise sdlt_basis issues." },
  { type: 'record_cgt_facts', actor: 'either', stages: 'any', emits: ['cgt_facts_recorded', 'issue_raised'], description: "The seller's two CGT answers: either 'no' raises a cgt_flag (tell the client about the 60-day report; never advice)." },
  { type: 'longstop_date_recorded', actor: 'person', stages: 'any', emits: ['longstop_date_recorded'], description: "A new build's long-stop date from the contract: the timer warns before it passes (dates.ts)." },
  { type: 'record_other_charge', actor: 'person', stages: 'any', emits: ['charge_found'], description: 'Another charge to redeem on a sale or remortgage (a second charge, a secured loan, a charging order); the title read adds them itself (charges.ts).' },
  { type: 'charge_statement_received', actor: 'either', stages: 'any', emits: ['charge_statement_received', 'issue_raised', 'issue_resolved'], description: "That charge's redemption figure: exchange waits for every figure; all of them against the price is the negative-equity check." },
  { type: 'charge_redeemed', actor: 'person', stages: ['completed', 'post_completion'], emits: ['charge_redeemed'], description: 'Paid off from the proceeds on completion; its discharge is chased until it arrives.' },
  { type: 'charge_discharged', actor: 'either', stages: ['completed', 'post_completion'], emits: ['charge_discharged'], description: 'The DS1 / release for that charge: the file closes only when every charge is off.' },
  { type: 'undertaking_given', actor: 'person', stages: ['exchanged', 'pre_completion'], emits: ['undertaking_given'], description: "Our undertaking to the buyer's solicitor to redeem every charge (the reply to their TA13); a charged sale does not complete without it." },
  { type: 'undertaking_discharged', actor: 'person', stages: ['completed', 'post_completion'], emits: ['undertaking_discharged'], description: "The discharges sent to the buyer's solicitor once every charge is off: the undertaking is done and the file can close." },
  { type: 'completion_information_received', actor: 'either', stages: ['pre_exchange', 'exchanged', 'pre_completion'], emits: ['completion_information_received'], description: "The seller's solicitor's replies to completion information (TA13): a purchase completes only with them, and with their undertaking to redeem where the seller's title is charged." },
  { type: 'funds_cleared', actor: 'person', stages: 'any', emits: ['funds_cleared'], description: 'Money credited but not cleared (a cheque, a held payment) has cleared; completion and the completion payment wait for it.' },
  { type: 'refund_paid', actor: 'person', stages: 'any', emits: ['refund_paid'], description: 'Money owed back (an overpayment, or everything held on a file that stopped) has been returned to the account it came from.' },
  { type: 'completion_confirmed', actor: 'either', stages: ['pre_completion'], emits: ['completion_confirmed', 'stage_advanced'], description: 'Completed — refused while a bank-details change is pending or the payment was not authorised.', hardStop: true },
  { type: 'sdlt_submitted', actor: 'either', stages: ['completed', 'post_completion'], emits: ['sdlt_submitted', 'stage_advanced'], description: 'SDLT return filed.' },
  { type: 'ap1_submitted', actor: 'either', stages: ['completed', 'post_completion'], emits: ['ap1_submitted', 'stage_advanced'], description: 'AP1 lodged; opens the registration wait.' },
  { type: 'ap1_confirmed', actor: 'either', stages: 'any', emits: ['ap1_confirmed'], description: 'Registered (terminal). Refused while a requisition is unanswered.' },
  { type: 'withdraw_proposal', actor: 'automation', stages: 'any', emits: ['action_rejected'], description: 'The system takes back a pending proposal that a better one replaced (one batched enquiry instead of twenty).' },
  { type: 'record_chase', actor: 'automation', stages: 'any', emits: ['chase_sent'], description: 'Timer: a template chase was sent (recorded only after the send).' },
  { type: 'record_acknowledgement', actor: 'automation', stages: 'any', emits: ['acknowledgement_sent'], description: 'Something arrived from the other side or the client and they were told so (recorded only after the send).' },
  { type: 'raise_escalation', actor: 'automation', stages: 'any', emits: ['escalation_raised'], description: 'Timer: a wait aged past its SLA → decision with the chase dossier.' },
  { type: 'record_client_update', actor: 'automation', stages: 'any', emits: ['client_update_sent'], description: 'A templated status update was sent to the client.' },
  { type: 'record_suppressed', actor: 'automation', stages: 'any', emits: ['action_suppressed'], description: 'Shadow mode: the intent, not the action.' },
  { type: 'set_shadow_mode', actor: 'person', stages: 'any', emits: ['shadow_mode_changed'], description: 'Admin switches shadow mode.' },
  // eventualities
  { type: 'abandon_matter', actor: 'person', stages: 'any', emits: ['matter_abandoned', 'refund_due'], description: 'Abortive: client withdrew, chain collapsed, gazumped… Waits close, timers stop, only corrections may follow. Money held is owed back where it came from (the ISA bonus to the ISA manager, the advance to the lender).', eventuality: true },
  { type: 'set_clients', actor: 'person', stages: 'any', emits: ['clients_updated', 'id_party_added'], description: 'The clients on the case, edited: a client added is identified in their own right; one removed takes an unfinished check with them. Signing and every client email follow the list.' },
  { type: 'set_target_dates', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['target_dates_changed'], description: 'Re-plan target exchange / completion before exchange.', eventuality: true },
  { type: 'change_completion_date', actor: 'either', stages: ['exchanged', 'pre_completion'], emits: ['completion_date_changed'], description: 'Move the contractual completion date after exchange.', eventuality: true },
  { type: 'notice_to_complete_served', actor: 'either', stages: ['exchanged', 'pre_completion'], emits: ['notice_to_complete_served'], description: 'Either side served notice: a decision citing the notice; the timer raises the deadline.', eventuality: true },
  { type: 'mortgage_offer_withdrawn', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange'], emits: ['mortgage_offer_withdrawn', 'issue_raised'], description: 'Offer withdrawn / lapsed before exchange: sub-flow reopens, exchange blocked.', eventuality: true },
  { type: 'withdraw_enquiry', actor: 'either', stages: 'any', emits: ['enquiry_withdrawn'], description: 'An enquiry no longer needed (indemnity, superseded).', eventuality: true },
  { type: 'hmlr_requisition_received', actor: 'either', stages: ['post_completion'], emits: ['hmlr_requisition_received'], description: 'HMLR requisition → decision citing the letter; blocks registration until answered.', eventuality: true },
  { type: 'record_correction', actor: 'person', stages: 'any', emits: ['correction_recorded'], description: 'The log is never edited: a compensating record against a wrong event (allowed after abandonment).', eventuality: true },
  { type: 'record_handler_change', actor: 'either', stages: 'any', emits: ['handler_changed'], description: 'Reassignment / holiday cover on the log.', eventuality: true },
  { type: 'raise_deadline_escalation', actor: 'automation', stages: 'any', emits: ['escalation_raised'], description: 'Timer: a deadline we owe (offer expiry, SDLT, notice to complete, requisition reply) or a stale issue, raised once, in time.', eventuality: true },
  // issues (docs/engine-issues.md)
  { type: 'raise_issue', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], emits: ['issue_raised'], description: 'Something is wrong (survey defect, down-valuation, missing building regs, chain, probate, gifted deposit…): a typed issue with a gate (holds exchange / completion / nothing).', issue: true },
  { type: 'update_issue', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], emits: ['issue_updated'], description: 'Progress: negotiating, a note, or a gate change (releasing a hold needs a note).', issue: true },
  { type: 'resolve_issue', actor: 'person', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], emits: ['issue_resolved', 'price_changed', 'issue_raised', 'mortgage_offer_withdrawn'], description: 'Resolved with one of the kind\'s realistic outcomes. A price reduction records price_changed; a price change / indemnity / retention on a lender-funded purchase raises a lender_approval issue; a new lender reopens the mortgage sub-flow.', issue: true },
  { type: 'withdraw_issue', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], emits: ['issue_withdrawn'], description: 'Raised in error / overtaken.', issue: true },
  { type: 'mark_issue_fatal', actor: 'person', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], emits: ['issue_fatal', 'matter_abandoned'], description: 'The issue ended the transaction: fatal + abandoned in one command, with the abandonment reason derived from the kind.', issue: true },
  { type: 'record_price_change', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['price_changed', 'issue_raised'], description: 'The agreed price (first record) or a renegotiated price before exchange; a change on a lender-funded purchase raises a lender_approval issue.', issue: true },
  { type: 'contract_approved', actor: 'either', stages: ['contract_review', 'pre_exchange'], emits: ['contract_approved'], description: 'Readiness milestone: the draft contract is approved as to form (advisory).', issue: true },
  { type: 'signed_contract_held', actor: 'either', stages: ['contract_review', 'pre_exchange'], emits: ['signed_contract_held'], description: 'Readiness milestone: the client\'s signed contract is on file (advisory).', issue: true },
  // notes and call transcripts (docs/intake.md)
  { type: 'set_signing_method', actor: 'person', stages: 'any', emits: ['signing_method_set'], description: 'Wet ink or electronic, for one deed on this case: the lender\'s rules, or the client\'s circumstances.', eventuality: true },
  { type: 'record_signing_pack_sent', actor: 'automation', stages: 'any', emits: ['signing_pack_sent'], description: 'The client was sent what they must sign and how; the wait on the signed documents starts.' },
  { type: 'record_signing_envelope', actor: 'automation', stages: 'any', emits: ['signing_envelope_sent'], description: 'A deed went out for electronic signature with the firm\'s signing provider.' },
  { type: 'resume_automation', actor: 'person', stages: 'any', emits: ['manual_handling_cleared'], description: 'A person resumes automation after a pause (a tenure mismatch, unregistered land, a rejected proof of funds), saying why.', eventuality: true },
  { type: 'set_funding', actor: 'person', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['funding_changed'], description: 'The buyer now has a mortgage, or is now buying without one: the mortgage step appears or goes, and nothing waits on an offer for a cash purchase.', eventuality: true },
  { type: 'record_survey_plan', actor: 'person', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['survey_plan_recorded'], description: 'The client\'s survey plan: not having one (their choice, recorded; they are no longer asked) or booked for a date (not asked again until after it).', eventuality: true },
  { type: 'record_chain_consent', actor: 'person', stages: 'any', emits: ['chain_consent_recorded'], description: "The client says we may (or may not) tell the other side about their own sale or purchase. Without it, updates to the other side never mention the client's chain.", eventuality: true },
  { type: 'set_file_delivery', actor: 'person', stages: 'any', emits: ['file_delivery_set'], description: 'How files reach this client: a secure link (the default) or attachments, when they ask for that (from an email, approved, or ticked on a reply).', eventuality: true },
  { type: 'record_client_progress', actor: 'person', stages: 'any', emits: ['wait_progress_reported'], description: 'Someone we are waiting on says it is done or on its way (from an email, approved): noted on the wait, which is not chased before the expected date. Nothing is cleared: the thing itself still has to arrive.', eventuality: true },
  { type: 'record_availability', actor: 'person', stages: 'any', emits: ['availability_recorded'], description: 'Someone on the case is away between two dates: chases to them wait, client updates say so, and target dates are checked against it.', eventuality: true },
  { type: 'record_note', actor: 'person', stages: 'any', emits: ['note_recorded'], description: 'File a note, a dictated note or a call transcript on the matter. It is evidence from the moment it lands, whatever the reading makes of it.' },
  { type: 'note_action_refused', actor: 'automation', stages: 'any', emits: ['note_action_refused'], description: 'A line a person approved that the machine then refused (a precondition was never there). Recorded so the note never claims something landed that did not.' },
  { type: 'note_extracted', actor: 'automation', stages: 'any', emits: ['note_extracted'], description: "What the note appears to say, as proposals. Each must quote the note verbatim and map to a command the machine already accepts, or it is dropped. Raises one decision for a person; nothing is applied until they approve." },
  // transaction types (docs/transaction-types.md)
  { type: 'request_property_forms', actor: 'either', stages: 'any', emits: ['property_forms_requested'], description: 'Sale: ask the client for the TA6 / TA10 (and TA7 on a leasehold); a wait the timers chase.', types: ['freehold_sale', 'leasehold_sale'] },
  { type: 'property_forms_received', actor: 'either', stages: 'any', emits: ['property_forms_received'], description: 'Sale: the completed forms are in (facts extracted where a document arrived).', types: ['freehold_sale', 'leasehold_sale'] },
  { type: 'contract_pack_sent', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['contract_pack_sent'], description: "Sale: draft contract, official copies, plan and forms out to the buyer's solicitor. Needs the forms and the title on file.", types: ['freehold_sale', 'leasehold_sale'] },
  { type: 'buyer_enquiries_received', actor: 'either', stages: 'any', emits: ['buyer_enquiries_received'], description: "Sale: the buyer's enquiries on the pack, numbered BE1…; each is a reply we owe (gates contract_review).", types: ['freehold_sale', 'leasehold_sale'] },
  { type: 'enquiry_replies_sent', actor: 'person', stages: 'any', emits: ['enquiry_replies_sent'], description: "Sale: replies went out under a person's name.", types: ['freehold_sale', 'leasehold_sale'] },
  { type: 'request_redemption_statement', actor: 'either', stages: 'any', emits: ['redemption_statement_requested'], description: 'Sale / remortgage with an existing charge: ask the lender for the redemption figure; a wait the timers chase.', types: ['freehold_sale', 'leasehold_sale', 'remortgage'] },
  { type: 'redemption_statement_received', actor: 'either', stages: 'any', emits: ['redemption_statement_received'], description: 'The redemption figure, its validity date and daily interest are on file.', types: ['freehold_sale', 'leasehold_sale', 'remortgage'] },
  { type: 'mortgage_redeemed', actor: 'either', stages: 'any', emits: ['mortgage_redeemed'], description: 'On or after completion, and only after a person authorised the payment to the lender against verified details (hard stop).', types: ['freehold_sale', 'leasehold_sale', 'remortgage'], hardStop: true },
  { type: 'discharge_confirmed', actor: 'either', stages: 'any', emits: ['discharge_confirmed'], description: "The lender's DS1 / e-DS1 is through and the charge is off the register.", types: ['freehold_sale', 'leasehold_sale', 'remortgage'] },
  { type: 'mortgage_deed_executed', actor: 'either', stages: 'any', emits: ['mortgage_deed_executed'], description: 'Lender-funded purchase / remortgage: the client signed the mortgage deed, witnessed. An unwitnessed deed is refused (raise a document-execution issue).', types: ['freehold_purchase', 'leasehold_purchase', 'remortgage'] },
  { type: 'add_party', actor: 'either', stages: 'any', emits: ['id_party_added'], description: 'A person to identify in their own right, added after enrolment: a co-client, a gift donor, an attorney, a director / PSC, an executor or trustee. Clients, attorneys, directors and executors hold Instruction and exchange until resolved; donors hold proof-of-funds sign-off.' },
  { type: 'seller_forms_received', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange'], emits: ['seller_forms_received', 'issue_raised'], description: "The seller's TA6 / TA7 / TA10 read answer by answer; each answer that changes what the file needs (a dispute, works without consent, flooding, knotweed, occupiers, a septic tank, a solar lease) is an issue cited to the page.", types: ['freehold_purchase', 'leasehold_purchase'] },
  { type: 'link_related_matter', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['related_matter_linked', 'issue_raised'], description: "Our client's linked sale or purchase: a chain_dependency issue holds exchange until the other matter can exchange too; the service checks the other file at exchange and clears the issue." },
  { type: 'undo_manual_step', actor: 'person', stages: 'any', emits: ['manual_step_undone'], description: 'A step marked complete by hand in error is taken back: the case is rebuilt as if it had never been marked (only in the stage it was done in).' },
  { type: 'reopen_step', actor: 'person', stages: 'any', emits: ['step_reopened', 'mortgage_offer_withdrawn'], description: 'A step that was done no longer holds (an offer expired, a price change voided the signed papers, a search went stale): outstanding again from now, with the reason; history kept. The mortgage reopens as a withdrawn offer.' },
  { type: 'complete_step_manually', actor: 'person', stages: 'any', emits: ['step_completed_manually'], description: 'Manual handling: a person marks a step complete by hand (what was done, and any supporting documents); it reads as reviewed and every gate accepts it. Exchange and completion keep their own forms.' },
  { type: 'unlink_related_matter', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['related_matter_unlinked', 'issue_withdrawn'], description: 'The linked sale or purchase is no longer part of the chain (linked in error, or it fell through): both sides are unlinked and their chain holds withdrawn.' },
  { type: 'record_lender_requirements', actor: 'either', stages: 'any', emits: ['lender_requirements_recorded'], description: "The lender's Part 2 answers that change a rule here: minimum unexpired lease term (the lease review compares), maximum search age at exchange (exchange refuses older searches), whether it accepts a non-family gift, whether it wants an EWS1." },
  { type: 'client_account_receipt', actor: 'either', stages: 'any', emits: ['client_account_receipt_recorded', 'issue_raised'], description: 'Money on client account outside the completion flow (our fees, the deposit, an unexpected credit): the sender is checked against everyone the file knows; a stranger raises an AML issue (fees hold nothing; the deposit holds exchange; completion money holds completion).' },
  { type: 'name_change_evidenced', actor: 'person', stages: 'any', emits: ['name_change_evidenced'], description: 'A documented change of name (marriage, deed poll, decree): the two names are one person to the cross-checks from here on.' },
  { type: 'buildings_insurance_confirmed', actor: 'either', stages: 'any', emits: ['buildings_insurance_confirmed'], description: "Buildings insurance in place from exchange on the lender's terms (Lenders' Handbook); required before completion on a lender-funded purchase.", types: ['freehold_purchase', 'leasehold_purchase', 'remortgage'] },
  { type: 'priority_search_made', actor: 'either', stages: 'any', emits: ['priority_search_made'], description: 'The OS1 / OS2 priority search made; completion must fall inside the priority period, and the deadline timer raises it two working days before it expires.', types: ['freehold_purchase', 'leasehold_purchase', 'remortgage', 'transfer_of_equity'] },
  { type: 'bankruptcy_search_clear', actor: 'either', stages: 'any', emits: ['bankruptcy_search_clear'], description: 'The K16 bankruptcy search against every borrower recorded as clear (a hit is an issue: bankruptcy_insolvency); required before completion on a lender-funded purchase.', types: ['freehold_purchase', 'leasehold_purchase', 'remortgage', 'transfer_of_equity'] },
  { type: 'certificate_of_title_sent', actor: 'person', stages: 'any', emits: ['certificate_of_title_sent'], description: "The solicitor's certificate to the lender requesting the advance; follows a resolved offer.", types: ['freehold_purchase', 'leasehold_purchase', 'remortgage'] },
  { type: 'request_lender_consent', actor: 'either', stages: 'any', emits: ['lender_consent_requested'], description: "Transfer of equity on a charged property: the lender's consent to the transfer (or a deed of substituted security); a wait the timers chase.", types: ['transfer_of_equity'] },
  { type: 'lender_consent_received', actor: 'either', stages: 'any', emits: ['lender_consent_received'], description: 'Consent and any conditions on file.', types: ['transfer_of_equity'] },
  { type: 'transfer_deed_executed', actor: 'either', stages: 'any', emits: ['transfer_deed_executed'], description: 'The TR1 / TP1 signed by every party, witnessed.', types: ['freehold_purchase', 'leasehold_purchase', 'transfer_of_equity'] },
  { type: 'deed_of_trust_executed', actor: 'either', stages: 'any', emits: ['deed_of_trust_executed'], description: 'Co-owners holding as tenants in common: the declaration of trust signed. Needs the ownership_basis client decision first; refused for joint tenants.', types: ['freehold_purchase', 'leasehold_purchase', 'transfer_of_equity'] },
  { type: 'sdlt_not_required', actor: 'person', stages: ['completed', 'post_completion'], emits: ['sdlt_not_required'], description: 'A person determines no SDLT return is due (e.g. a transfer of equity for no chargeable consideration), with the reason; unblocks AP1.', types: ['freehold_purchase', 'leasehold_purchase', 'remortgage', 'transfer_of_equity'] },
];

const HUMAN_GATED_EVENTS: EventType[] = ['funds_requested', 'payment_authorised', 'report_on_title_sent'];

export const INVARIANTS: Invariant[] = [
  { id: 'replayable', title: 'Replayable', rule: 'project(log) reproduces the live state exactly; the audit verifies the hash chain and the replay.', enforcedBy: ['projection.ts', 'audit.ts', 'engine-audit CLI'] },
  { id: 'cites_source', title: 'Every decision cites a source', rule: 'A decision event without a document, a summary, a citation or an option is refused before it is written.', enforcedBy: ['machine.ts assertDecisionSpec'] },
  { id: 'source_before_verdict', title: 'Source before verdict', rule: 'Resolving needs decision_source_opened by the same person and scroll/dwell engagement; the server refuses (412) without both.', enforcedBy: ['machine.ts', 'decisions/[eventId]/resolve'] },
  { id: 'reason_required', title: 'A reason for anything but approve', rule: 'Non-approve options need a written reason stored on the resolving event.', enforcedBy: ['machine.ts'] },
  { id: 'human_gate', title: 'No payment or send by automation', rule: 'funds_requested, payment_authorised and report_on_title_sent need a human approver; the database trigger refuses otherwise, and the automation role cannot write them at all.', enforcedBy: ['migration 071 trigger + policy', 'runAsAutomation'] },
  { id: 'bank_details_hard_stop', title: 'Bank details are a hard stop', rule: 'Every set or change is a decision resolved only by out-of-band verification; payments are refused (423) while one is pending or against a superseded record.', enforcedBy: ['machine.ts assertPayableDetails', 'migration 070 trigger'] },
  { id: 'two_transition_kinds', title: 'Two kinds of transition only', rule: 'Actor is system, ai, external or a user id; anything ambiguous becomes a decision.', enforcedBy: ['types.ts Actor', 'machine.ts'] },
  { id: 'walled', title: 'Walled counterparties', rule: 'Internally-linked matters are separated by row-level security; the same enquiry event pair is used across the wall.', enforcedBy: ['migrations 068–069', 'counterparty.ts'] },
  { id: 'shadow', title: 'Propose before trusting', rule: 'Every action the engine takes on its own has a trust level per firm: propose (a person approves each one), assist (the mechanical goes unasked), auto. New firms start at propose for everything.', enforcedBy: ['service.ts suppressed()', 'store.ts surfacedDecisions'] },
  { id: 'truthful_log', title: 'The log only says what happened', rule: 'I/O is recorded after it succeeded; a result that arrives for a step nobody started records the start first (actor external); errors are corrections, never edits.', enforcedBy: ['service.ts', 'sync.ts routeByHint', 'record_correction'] },
  { id: 'abandoned_is_final', title: 'Abandoned is final', rule: 'After matter_abandoned nothing moves: waits close, timers stop, commands are refused, only corrections are accepted.', enforcedBy: ['machine.ts requireEnrolled'] },
  { id: 'issues_hold', title: 'An open issue holds its gate', rule: 'An open or negotiating issue gated on exchange blocks exchange_conditions_met, contracts_exchanged and the pre_exchange exit; one gated on completion blocks completion_confirmed. Everything else proceeds ("everything but exchange can go on"). Releasing a hold needs a note.', enforcedBy: ['machine.ts issuesGating', 'stageBlockers'] },
  { id: 'facts_not_judgements', title: 'Facts are automated, judgements are routed', rule: 'The machine records objective facts from documents (a report arrived, it recommends further investigation, a specialist finds nothing) and never infers a judgement: title / enquiries / AML satisfactory are a conveyancer\'s decision; satisfied with the property, accept a risk, authority to exchange are the client\'s, recorded by a person from their instruction.', enforcedBy: ['machine.ts client_decision_recorded (person only)', 'verdictEvents (decisions always human)', 'graph.ts requirement authority'] },
  { id: 'sof_scrutinised', title: 'Source of funds is scrutinised, not filed', rule: 'Every attached statement is read transaction by transaction; every unusual credit drafts a query; sign-off is refused while a query is open (send it, or withdraw it with a reason); a round in flight — and, by firm policy, an unsigned-off check — holds exchange; money accepted before sign-off raises an issue; a price rise beyond the verified funds re-opens the question.', enforcedBy: ['proof-of-funds.ts reviewTransactions', 'machine.ts proofOfFundsHolds', 'resolveEvents'] },
  { id: 'lender_told', title: 'The lender is told', rule: 'On a lender-funded purchase a price change, an indemnity policy or a retention automatically raises a lender_approval issue that holds exchange until the lender confirms.', enforcedBy: ['machine.ts lenderApprovalIssue'] },
];

export const EVENTUALITIES: EventualitySpec[] = [
  { area: 'shape', scenario: 'Cash purchase', handling: 'built', mechanism: 'hasLender=false → no mortgage sub-flow, no lender funds' },
  { area: 'shape', scenario: 'Mortgage purchase', handling: 'built', mechanism: 'offer sub-flow; expiry deadline; withdrawal reopens and blocks exchange' },
  { area: 'shape', scenario: 'Chain', handling: 'built', mechanism: 'issue chain_not_ready holds exchange; set_target_dates; mark_issue_fatal → abandoned(chain_collapsed)' },
  { area: 'shape', scenario: 'Two or more buyers', handling: 'built', mechanism: 'every client named at enrolment beyond the first gets an ID / AML check of their own (partyChecks); Instruction holds until each is resolved' },
  { area: 'shape', scenario: 'Company buyer / buy-to-let', handling: 'built', mechanism: 'enrolment shapes company_buyer / buy_to_let: a checklist issue from day one holds exchange (Companies House, directors and PSCs, authority, company funds; BTL offer conditions, tenancy, licensing); ID / AML reads as the company and its people' },
  { area: 'shape', scenario: 'Gifted deposit / source of funds', handling: 'built', mechanism: 'proof-of-funds form → statements read line by line → flags draft queries → client answers → sign-off decision; a declared gift adds the donor as a party with their own ID / AML check, which holds sign-off; sign-off closes source_of_funds issues and tells the lender of a gift' },
  { area: 'shape', scenario: 'Unusual transactions on a statement (cash, third party, crypto, gambling, overseas, in-and-out)', handling: 'built', mechanism: 'reviewTransactions flags each line and drafts the query; QUERY_UNANSWERED keeps it open; risk rating enhanced' },
  { area: 'exchange', scenario: 'Deposit received before source of funds signed off', handling: 'built', mechanism: 'issue aml_kyc_problem raised automatically, holds exchange' },
  { area: 'pre_contract', scenario: 'Price rises beyond the verified funds', handling: 'built', mechanism: 'issue source_of_funds raised automatically on price_changed' },
  { area: 'shape', scenario: 'Help to Buy / Lifetime ISA', handling: 'built', mechanism: 'enrolment shapes lifetime_isa / help_to_buy_isa: isa_bonus issue holds completion (declarations, limits, the bonus); funds_requested / funds_received fromRole isa_provider; Request The ISA Bonus on the completion lane' },
  { area: 'shape', scenario: 'New build / auction', handling: 'built', mechanism: 'enrolment shapes new_build / auction: new_build_pack issue (warranty, planning, roads, CIL, completion on notice, the developer\'s deadline) or auction_conditions issue (legal pack, special conditions, deposit at the hammer, completion deadline) holds exchange; an auction needs no recorded exchange authority' },
  { area: 'shape', scenario: 'Leasehold', handling: 'built', mechanism: 'leasehold_purchase: management-pack sub-flow gates pre_contract; lease facts (short lease, ground rent, doubling) flagged on title; notice of assignment after completion; a tenure that does not match the enrolment halts automation' },
  { area: 'shape', scenario: 'Internal counterparty', handling: 'built', mechanism: 'ethical wall; same event pair' },
  { area: 'instruction', scenario: 'ID check refer / fail', handling: 'built', mechanism: 'id_check decision; reject halts automation' },
  { area: 'instruction', scenario: 'ID result ordered outside the engine', handling: 'built', mechanism: 'request recorded first, actor external' },
  { area: 'instruction', scenario: 'Conflict', handling: 'built', mechanism: 'abandon_matter(conflict); same-handler links refused at the DB' },
  { area: 'instruction', scenario: 'Handler change', handling: 'built', mechanism: 'record_handler_change' },
  { area: 'pre_contract', scenario: 'Search flags something', handling: 'built', mechanism: 'approve / refer / request further / indemnity / escalate' },
  { area: 'pre_contract', scenario: 'Search unreadable', handling: 'built', mechanism: 'confidence < threshold → flagged, never guessed' },
  { area: 'pre_contract', scenario: 'Search re-issued / lender freshness rule', handling: 'built', mechanism: 're-order a resolved search → new cycle; gates exchange again' },
  { area: 'pre_contract', scenario: 'Search never returns / provider down', handling: 'built', mechanism: 'search wait timers; manual order fallback' },
  { area: 'pre_contract', scenario: 'Extra search types', handling: 'gap', mechanism: 'design: tenant-extensible requiredSearches' },
  { area: 'pre_contract', scenario: 'Partial / evasive replies', handling: 'built', mechanism: 'request further → tracked follow-up' },
  { area: 'pre_contract', scenario: 'Seller refuses to answer', handling: 'built', mechanism: 'withdraw_enquiry or abandon' },
  { area: 'pre_contract', scenario: 'Reply cannot be matched to one enquiry', handling: 'built', mechanism: 'not guessed; reported to a person to file' },
  { area: 'pre_contract', scenario: 'Special conditions / retention', handling: 'built', mechanism: 'mortgage decision' },
  { area: 'pre_contract', scenario: 'Offer expiry near exchange', handling: 'built', mechanism: 'flag at extraction + deadline timer 15 wd out' },
  { area: 'pre_contract', scenario: 'Offer withdrawn / lender change', handling: 'built', mechanism: 'mortgage_offer_withdrawn; new offer judged afresh' },
  { area: 'pre_contract', scenario: 'Cash ↔ mortgage change', handling: 'gap', mechanism: 'design: lender_status_changed' },
  { area: 'pre_contract', scenario: 'Price renegotiated', handling: 'built', mechanism: 'resolve_issue(price_reduced) or record_price_change → price_changed; lender_approval issue on a lender-funded purchase' },
  { area: 'pre_contract', scenario: 'Survey finds a defect', handling: 'built', mechanism: 'issue survey_defect → price reduced / works / retention / specialist report / accepted' },
  { area: 'pre_contract', scenario: 'Down-valuation', handling: 'built', mechanism: 'issue valuation_issue → price reduced / buyer covers / new lender (reopens the offer) / challenge' },
  { area: 'pre_contract', scenario: 'Missing building regs / FENSA / planning', handling: 'built', mechanism: 'issues missing_building_regs, planning_breach, document_missing → indemnity (lender told) / regularisation / retrospective consent' },
  { area: 'pre_contract', scenario: 'Probate not granted / attorney / capacity', handling: 'built', mechanism: 'issues probate_issue / power_of_attorney_issue / bankruptcy_insolvency hold exchange (record_party_event raises them mid-case); everything else proceeds' },
  { area: 'pre_contract', scenario: 'Solar lease / septic tank / unadopted road', handling: 'built', mechanism: 'issues third_party_encumbrance, access_rights → evidence / lender confirmed / indemnity' },
  { area: 'pre_contract', scenario: 'Issue goes quiet for weeks', handling: 'built', mechanism: 'stale_issue timer: escalation after 10 working days without movement' },
  { area: 'contract_review', scenario: 'Restriction / charge / covenant', handling: 'built', mechanism: 'title decision incl. indemnity (lender_approval issue on a lender-funded purchase); issues covenant_consent, title_defect' },
  { area: 'contract_review', scenario: 'Ready to exchange?', handling: 'built', mechanism: 'readiness milestones contract_approved, signed_contract_held (advisory) + stage blockers' },
  { area: 'contract_review', scenario: 'New information after the report went', handling: 'manual', mechanism: 'title re-extraction refused after send' },
  { area: 'contract_review', scenario: 'Draft rejected', handling: 'built', mechanism: 'report_on_title_rejected → redraft' },
  { area: 'exchange', scenario: 'Simultaneous exchange and completion', handling: 'built', mechanism: 'exchange with completionDate = today' },
  { area: 'exchange', scenario: 'Exchange deferred', handling: 'built', mechanism: 'set_target_dates' },
  { area: 'exchange', scenario: 'Gazumped / withdrawn / chain collapse', handling: 'built', mechanism: 'abandon_matter' },
  { area: 'exchange', scenario: 'Deposit late / short', handling: 'built', mechanism: 'deposit_received is compared with the contract deposit: short → deposit_issue holding exchange, cleared by the top-up (machine.ts depositConsequences)' },
  { area: 'exchange', scenario: 'Issue proves fatal', handling: 'built', mechanism: 'mark_issue_fatal → issue_fatal + matter_abandoned' },
  { area: 'completion', scenario: 'Completion date moved', handling: 'built', mechanism: 'change_completion_date' },
  { area: 'completion', scenario: 'Notice to complete', handling: 'built', mechanism: 'decision + deadline timer 2 wd out' },
  { area: 'completion', scenario: 'Lender funds late', handling: 'built', mechanism: 'funds wait timers' },
  { area: 'completion', scenario: 'Client balance short', handling: 'built', mechanism: 'every receipt checked against what was asked for: short → completion_funds_shortfall (gate completion), cleared when the money arrives; over → a refund owed (money.ts)' },
  { area: 'completion', scenario: 'Completion fails on the day', handling: 'built', mechanism: 'issue completion_failure holds completion_confirmed → completed_late / funds_in_place; notice to complete if it slips' },
  { area: 'completion', scenario: 'Bank details "change"', handling: 'built', mechanism: 'addendum 2 hard stop' },
  { area: 'post_completion', scenario: 'SDLT within 14 days', handling: 'built', mechanism: 'deadline timer 5 wd out' },
  { area: 'post_completion', scenario: 'HMLR requisition', handling: 'built', mechanism: 'requisition decision; blocks ap1_confirmed; deadline timer' },
  { area: 'post_completion', scenario: 'Registration slow', handling: 'built', mechanism: 'registration wait timers' },
  { area: 'completion', scenario: 'OS1 priority expiring', handling: 'built', mechanism: 'priority_search_made(expiresAt); completion refused after expiry; deadline timer 2 working days before' },
  { area: 'completion', scenario: 'Bankruptcy search / buildings insurance before completion', handling: 'built', mechanism: 'bankruptcy_search_clear and buildings_insurance_confirmed gate completion_confirmed on a lender-funded purchase' },
  { area: 'completion', scenario: 'Completion money from an account never seen', handling: 'built', mechanism: 'funds_received.remitter compared with the declarant, the parties and every statement read → aml_kyc_problem holds completion' },
  { area: 'instruction', scenario: 'Attorney, company officers, executors, occupiers', handling: 'built', mechanism: 'named at enrolment (or add_party): each an ID / AML check of their own holding Instruction and exchange; a checklist issue for the power, the PSC register, the grant, the occupier consents' },
  { area: 'instruction', scenario: 'CDD older than a year on an open matter', handling: 'built', mechanism: 'timer raises cdd_refresh (holds nothing) — LSAG 6.21' },
  { area: 'shape', scenario: 'Non-family gift / cash purchase / source of wealth', handling: 'built', mechanism: 'POF_GIFT_NON_FAMILY, POF_CASH_PURCHASE flags; enhanced risk drafts one SOURCE_OF_WEALTH query' },
  { area: 'shape', scenario: 'Second charge, shared ownership, unrepresented other side, court-order transfer', handling: 'built', mechanism: 'enrolment shapes with a checklist issue holding the gate they threaten' },
  { area: 'pre_contract', scenario: "The seller's forms read for issues (TA6 / TA7)", handling: 'built', mechanism: 'seller_forms_received (purchase) and property_forms_received with facts (sale): property-forms.ts turns each material answer into a cited issue' },
  { area: 'shape', scenario: 'Linked sale and purchase (one client, one chain)', handling: 'built', mechanism: 'link_related_matter → chain_dependency holds exchange; the service checks the linked matter at exchange; sale proceeds without a linked sale are flagged on the proof of funds' },
  { area: 'shape', scenario: "Lender's Part 2 requirements", handling: 'built', mechanism: 'record_lender_requirements: minimum lease term compared on the lease review, maximum search age enforced at exchange, non-family gifts accepted or flagged' },
  { area: 'instruction', scenario: 'Two or more declarants on the proof of funds', handling: 'built', mechanism: 'coDeclarants on the form; a co-buyer who neither confirms nor declares is flagged (POF_MISSING_DECLARANT)' },
  { area: 'instruction', scenario: 'Name change across documents', handling: 'built', mechanism: 'name_change_evidenced: the alias is applied to the cross-checks' },
  { area: 'post_completion', scenario: 'SDLT: the sum on the declared basis', handling: 'built', mechanism: 'sdlt.ts computes the estimate from the price and the declared basis; on the completion statement and the SDLT deadline' },
  { area: 'shape', scenario: 'Right to Buy, flying freehold, commonhold', handling: 'built', mechanism: 'enrolment shapes with a checklist issue holding exchange' },
  { area: 'instruction', scenario: 'Third party pays our fees or the deposit', handling: 'built', mechanism: 'client_account_receipt: a remitter nobody on the file knows raises aml_kyc_problem' },
  { area: 'post_completion', scenario: 'SDLT: mixed use, linked transactions', handling: 'built', mechanism: 'sdlt.ts: non-residential rates for mixed use; linked consideration sets the rate on the aggregate and apportions' },
  { area: 'pre_contract', scenario: "Lender directory: Part 2 applied from the offer", handling: 'built', mechanism: 'lender_profile (migration 096) matched by lender name when the offer is read → record_lender_requirements' },
  { area: 'pre_contract', scenario: "TA6 answered \"not known\"", handling: 'built', mechanism: 'each such question is an enquiry proposed (trust level enquiry_draft); approved, it is raised' },
  { area: 'pre_contract', scenario: 'EPC missing on a sale; F / G on a buy-to-let purchase', handling: 'built', mechanism: 'property-forms.ts: document_missing on the sale; buy_to_let_conditions on the purchase (MEES)' },
  { area: 'contract_review', scenario: 'Unregistered land', handling: 'manual', mechanism: 'title_extracted with unregistered=true → manual_handling_required(unregistered_land)' },
  { area: 'contract_review', scenario: 'Building Safety Act certificates', handling: 'built', mechanism: 'management pack read for the relevant-building answer and the two certificates; missing ones raise building_safety holding exchange' },
  { area: 'cross', scenario: 'Documents in any order', handling: 'built', mechanism: 'PENDING ingest retry' },
  { area: 'cross', scenario: 'Duplicate / re-issued document', handling: 'built', mechanism: 'idempotent on provider id; re-issue = new cycle' },
  { area: 'cross', scenario: 'Something recorded in error', handling: 'built', mechanism: 'record_correction (compensating, never an edit)' },
  { area: 'cross', scenario: 'Bank holidays', handling: 'built', mechanism: 'E&W working-day calendar' },
  { area: 'cross', scenario: 'Two backends (LEAP / own app)', handling: 'built', mechanism: 'CaseBackend abstraction' },
];

const eventCategory = (t: EventType): string => {
  if (/^note_/.test(t)) return 'notes & calls';
  if (/^property_forms|^contract_pack|^buyer_enquiries|^enquiry_replies/.test(t)) return 'sale';
  if (/^redemption|^mortgage_redeemed|^discharge/.test(t)) return 'redemption';
  if (/^mortgage_deed|^certificate_of_title|^transfer_deed|^deed_of_trust/.test(t)) return 'deeds';
  if (/^lender_consent/.test(t)) return 'transfer of equity';
  if (/^id_check/.test(t)) return 'id_check';
  if (/^search/.test(t)) return 'search';
  if (/^enquiry/.test(t)) return 'enquiry';
  if (/^mortgage/.test(t)) return 'mortgage';
  if (/^title/.test(t)) return 'title';
  if (/^report_on_title/.test(t)) return 'report_on_title';
  if (/^bank_details|^payment|^funds/.test(t)) return 'payments';
  if (/chase|escalation|client_update/.test(t)) return 'timers & comms';
  if (/^decision_source|auto_clear/.test(t)) return 'decisions';
  if (/shadow|suppressed/.test(t)) return 'shadow';
  if (/^issue|price_changed|contract_approved|signed_contract/.test(t)) return 'issues';
  if (/^proof_of_funds/.test(t)) return 'proof_of_funds';
  if (/^survey|specialist_report|client_decision|matter_closed/.test(t)) return 'case model';
  if (/^management_pack|notice_of_assignment/.test(t)) return 'leasehold';
  if (/abandon|target_dates|completion_date|notice_to_complete|withdrawn|requisition|correction|handler/.test(t)) return 'eventualities';
  return 'lifecycle';
};

/** What the form needs: a message's brief stays on the server (it drafts there); an action or outcome goes as it is. */
const stepView = (x: IssueStep) => (x.kind === 'message' ? { id: x.id, kind: x.kind, label: x.label, to: x.to } : x);

export function machineSpec(): MachineSpec {
  const body: Omit<MachineSpec, 'version'> = {
    generatedFrom: 'lib/server/engine/spec.ts (checked against machine.ts, types.ts, rules.ts, sla.ts, triggers.ts, transactions.ts by tests/unit/engine/spec.test.ts)',
    transactionTypes: TRANSACTION_TYPES.map((t) => TRANSACTION_PROFILES[t]),
    shapes: CASE_SHAPES.map((id) => ({ id, label: SHAPE_SPEC[id].label, sides: SHAPE_SPEC[id].sides, summary: SHAPE_SPEC[id].summary, issue: SHAPE_SPEC[id].issue.title, gate: SHAPE_SPEC[id].issue.gate, fundsFrom: SHAPE_SPEC[id].fundsFrom ?? null })),
    stages: STAGE_SPECS,
    terminal: [
      { id: 'registered', label: 'Registered', how: 'ap1_confirmed at post_completion (purchase, remortgage, transfer of equity)' },
      { id: 'closed', label: 'Closed', how: 'close_matter with no open issues: after registration (leasehold purchase: notice of assignment served), or on a sale after redemption is discharged and the balance accounted to the client' },
      { id: 'abandoned', label: 'Abandoned', how: 'abandon_matter from any stage before completion' },
      { id: 'manual', label: 'Manual handling', how: "mark_manual_handling, ID rejected, or a title whose tenure is not the profile's — automation stops, the log continues" },
    ],
    subflows: SUBFLOW_SPECS,
    commands: COMMAND_SPECS,
    events: EVENT_TYPES.map((t) => ({ type: t, category: eventCategory(t), decision: DECISION_EVENT_TYPES.includes(t), humanGated: HUMAN_GATED_EVENTS.includes(t) })),
    decisions: DECISION_KINDS.map((kind) => ({ kind, label: kind.replace(/_/g, ' '), options: OPTIONS_FOR[kind], source: SUBFLOW_SPECS.find((s) => s.decisionKind === kind)?.label ?? (kind === 'bank_details' ? 'the document the details arrived on' : kind === 'requisition' ? 'the HMLR requisition letter' : kind === 'auto_clear' ? 'the auto-cleared document' : kind === 'proof_of_funds' ? 'the client\'s declaration and its attachments' : kind === 'management_pack' ? 'the LPE1 / management pack' : kind === 'note_actions' ? 'the note or call transcript it was read from' : 'the chase / deadline dossier') })),
    timers: {
      waits: (Object.keys(DEFAULT_SLA) as WaitKey[]).map((k) => ({ waitKey: k, chaseAfter: DEFAULT_SLA[k].chaseAfter, chaseEvery: DEFAULT_SLA[k].chaseEvery, escalateAfter: DEFAULT_SLA[k].escalateAfter, reEscalateAfter: DEFAULT_SLA[k].reEscalateAfter, recipientRole: DEFAULT_SLA[k].recipientRole, template: DEFAULT_SLA[k].template })),
      deadlines: (Object.keys(DEADLINE_LEAD) as DeadlineKind[]).map((kind) => ({ kind, leadWorkingDays: DEADLINE_LEAD[kind], description: ({ mortgage_offer_expiry: 'offer expiry before exchange', sdlt_filing: '14 days from completion', notice_to_complete: 'notice expiry', requisition_reply: 'HMLR reply-by date', stale_issue: 'an open issue with no movement (working days since last touched)', certificate_of_title: 'certificate of title to the lender, 5 working days before completion', priority_period_expiry: 'the OS1 priority period ending before completion', first_registration: 'first registration within two months of completing a purchase of unregistered land', lisa_window: 'a Lifetime ISA bonus used within 90 days of receipt, or returned to the ISA manager', auction_completion: 'an auction purchase completes 20 working days after the auction', longstop_date: "a new build's long-stop date", sdlt_refund: 'the three-year window to reclaim the higher rates once the old main home sells', nrs_refund: 'the two-year window to reclaim the non-resident surcharge once a buyer is UK resident', advance_due: 'the mortgage advance not in the working day before completion', redemption_payment: 'the redemption not sent on completion day', sdlt_overdue: 'the SDLT / LTT return past its filing date (penalty running)', final_inspection: "a new build's final inspection, asked for 10 working days before completion", target_exchange: 'the target exchange date coming up or passed without exchange' } satisfies Record<DeadlineKind, string>)[kind] })),
    },
    thresholds: { extractionConfidence: MIN_EXTRACTION_CONFIDENCE, classificationConfidence: MIN_CLASSIFICATION_CONFIDENCE },
    invariants: INVARIANTS,
    triggers: TRIGGERS,
    eventualities: EVENTUALITIES,
    issues: {
      groups: ISSUE_GROUPS.map((id) => ({ id, label: ISSUE_GROUP_LABEL[id] })),
      kinds: ISSUE_KIND_SPECS,
      resolutions: ISSUE_RESOLUTIONS.map((id) => ({
        id,
        label: RESOLUTION_LABEL[id],
        title: RESOLUTION_TITLE[id],
        fields: RESOLUTION_FIELDS[id],
        noteRequired: NOTE_REQUIRED.has(id),
        effect: RESOLUTION_EFFECT[id] ?? null,
        effects: [
          ...(PRICE_RESOLUTIONS.has(id) ? ['records price_changed (new price required, before exchange only)'] : []),
          ...(LENDER_NOTIFY_RESOLUTIONS.has(id) ? ['lender-funded purchase: raises a lender_approval issue holding exchange'] : []),
          ...(REOPENS_OFFER.has(id) ? ['lender-funded purchase: records mortgage_offer_withdrawn (the sub-flow reopens)'] : []),
        ],
      })),
      staleAfterWorkingDays: DEADLINE_LEAD.stale_issue,
      formless: [...FORMLESS_KINDS],
      chips: ISSUE_CHIP,
      steps: Object.fromEntries(ISSUE_KIND_SPECS.map((k) => [k.kind, issueSteps(k.kind, 'buyer').map(stepView)])),
      sellerSteps: Object.fromEntries(ISSUE_KIND_SPECS.map((k) => [k.kind, issueSteps(k.kind, 'seller').map(stepView)])),
      eventSteps: Object.fromEntries(EVENTS_WITH_STEPS.map((e) => [e, issueSteps('other', 'buyer', e).map(stepView)])),
    },
  };
  const version = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { version, ...body };
}

export { STAGES, SUB_FLOWS, USER_COMMANDS };
