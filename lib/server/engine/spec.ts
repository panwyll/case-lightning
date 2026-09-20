/**
 * The state machine, described in code.
 *
 * Everything the read-only map (/engine/map) shows comes from here, and everything here
 * is either imported from the machine (stages, event types, decision kinds and options,
 * SLA numbers, deadline leads, the user-command set, the trigger registry) or declared
 * next to it and checked against it by tests/unit/engine/spec.test.ts — so the picture
 * cannot drift from the code without a test going red.
 */
import crypto from 'node:crypto';
import { DEFAULT_SLA, DEADLINE_LEAD, type DeadlineKind } from './sla';
import { OPTIONS_FOR, MIN_EXTRACTION_CONFIDENCE } from './rules';
import { USER_COMMANDS, type Command } from './machine';
import { DECISION_EVENT_TYPES, DECISION_KINDS, EVENT_TYPES, STAGES, SUB_FLOWS, type DecisionKind, type DecisionOption, type EventType, type Stage, type SubFlow, type WaitKey } from './types';
import { TRIGGERS, type TriggerSpec } from './triggers';
import { ISSUE_GROUPS, ISSUE_GROUP_LABEL, ISSUE_KIND_SPECS, ISSUE_RESOLUTIONS, RESOLUTION_LABEL, LENDER_NOTIFY_RESOLUTIONS, PRICE_RESOLUTIONS, REOPENS_OFFER, type IssueKindSpec, type IssueGroup, type IssueResolution } from './issues';
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
    resolutions: Array<{ id: IssueResolution; label: string; effects: string[] }>;
    staleAfterWorkingDays: number;
  };
}

export const STAGE_SPECS: StageSpec[] = [
  { id: 'instruction', label: 'Instruction', purpose: 'Client instructed; identity and AML established before anything is ordered.', gates: ['ID / AML check resolved (cleared by the rule layer, or reviewed by a person)'], gateKeywords: ['ID/AML'], subflows: ['id_check'], typical: ['enrol', 'request_id_check', 'mark_manual_handling'] },
  { id: 'pre_contract', label: 'Pre-contract', purpose: 'Searches ordered automatically on entry; enquiries raised; the mortgage offer checked; on a leasehold purchase, the management pack reviewed.', gates: ['every required search ordered and resolved', 'every enquiry replied and resolved (or withdrawn)', 'mortgage offer resolved (lender-funded purchases)', 'management pack reviewed (leasehold)'], gateKeywords: ['search'], subflows: ['search', 'enquiry', 'mortgage'], typical: ['raise_enquiry', 'record_search_ordered', 'search_returned', 'mortgage_offer_received', 'withdraw_enquiry', 'set_target_dates'] },
  { id: 'contract_review', label: 'Contract review', purpose: 'Title reviewed; the report on title drafted by AI, approved by a person, sent.', gates: ['title resolved', 'report on title sent (drafted → approved by a person → sent)', 'enquiries raised during review resolved', 'a re-ordered search resolved'], gateKeywords: ['title'], subflows: ['title', 'report_on_title'], typical: ['draft_report_on_title', 'record_report_on_title_sent', 'deposit_received'] },
  { id: 'pre_exchange', label: 'Pre-exchange', purpose: 'Deposit in; exchange conditions derived; contracts exchanged with a completion date.', gates: ['mortgage offer still current (not withdrawn)', 'no open issue holding exchange', 'no proof-of-funds round in flight', 'exchange conditions met (deposit received)', 'contracts exchanged'], gateKeywords: ['exchange'], subflows: [], typical: ['deposit_received', 'contracts_exchanged', 'mortgage_offer_withdrawn', 'record_bank_details'] },
  { id: 'exchanged', label: 'Exchanged', purpose: 'Bound. Completion statement generated.', gates: ['completion statement generated'], gateKeywords: ['completion statement'], subflows: [], typical: ['completion_statement_generated', 'change_completion_date', 'notice_to_complete_served'] },
  { id: 'pre_completion', label: 'Pre-completion', purpose: 'Funds requested and received; the completion payment authorised by a person against verified bank details; completion confirmed.', gates: ['funds received', 'completion payment authorised against verified seller\'s-solicitor details', 'no bank-details change pending (hard stop)', 'completion confirmed'], gateKeywords: ['funds'], subflows: [], typical: ['funds_requested', 'funds_received', 'payment_authorised', 'completion_confirmed'] },
  { id: 'completed', label: 'Completed', purpose: 'SDLT within 14 days; AP1 lodged.', gates: ['SDLT or AP1 submitted'], gateKeywords: ['SDLT'], subflows: [], typical: ['sdlt_submitted', 'ap1_submitted'] },
  { id: 'post_completion', label: 'Post-completion', purpose: 'Registration at HM Land Registry; requisitions answered.', gates: ['HMLR requisitions answered', 'registration confirmed (terminal)'], gateKeywords: ['registration'], subflows: [], typical: ['hmlr_requisition_received', 'ap1_confirmed'] },
];

export const SUBFLOW_SPECS: SubflowSpec[] = [
  { id: 'id_check', label: 'ID / AML', stage: 'instruction', waitKey: 'id_check', start: ['id_check_requested'], extracted: null, cleared: 'id_check_cleared', flagged: 'id_check_flagged', reviewed: 'id_check_reviewed', decisionKind: 'id_check', rule: 'Provider outcome "clear" with no flags → clear; "refer"/"fail", any flag, or low extraction confidence → flag. Reject halts automation.' },
  { id: 'search', label: 'Searches', stage: 'pre_contract', waitKey: 'search', start: ['search_ordered', 'search_returned'], extracted: 'search_extracted', cleared: 'search_cleared', flagged: 'search_flagged', reviewed: 'search_reviewed', decisionKind: 'search', rule: 'Only info-severity entries → clear; any low/medium/high flag, or confidence below the threshold → flag. A resolved search may be re-ordered (new cycle).' },
  { id: 'enquiry', label: 'Enquiries', stage: 'pre_contract', waitKey: 'enquiry', start: ['enquiry_raised', 'enquiry_reply_received'], extracted: null, cleared: 'enquiry_reply_cleared', flagged: 'enquiry_reply_flagged', reviewed: 'enquiry_reply_reviewed', decisionKind: 'enquiry', rule: 'Reply "answered" with no issues → clear; partial/refused/issues → flag. "Request further" raises a tracked follow-up; a person may withdraw one.' },
  { id: 'mortgage', label: 'Mortgage offer', stage: 'pre_contract', waitKey: null, start: ['mortgage_offer_received'], extracted: 'mortgage_offer_extracted', cleared: 'mortgage_offer_cleared', flagged: 'mortgage_condition_flagged', reviewed: 'mortgage_condition_reviewed', decisionKind: 'mortgage', rule: 'Standard conditions only and expiry comfortably after the target exchange → clear; any special condition, near expiry, or low confidence → flag. Withdrawal reopens the sub-flow and blocks exchange.' },
  { id: 'title', label: 'Title', stage: 'contract_review', waitKey: null, start: ['title_extracted'], extracted: 'title_extracted', cleared: 'title_cleared', flagged: 'title_flagged', reviewed: 'title_reviewed', decisionKind: 'title', rule: 'Freehold with no restrictions, charges or covenants → clear; any entry → flag with the register section cited; non-freehold tenure → manual handling.' },
  { id: 'report_on_title', label: 'Report on title', stage: 'contract_review', waitKey: null, start: ['report_on_title_drafted'], extracted: null, cleared: null, flagged: 'report_on_title_drafted', reviewed: 'report_on_title_approved', decisionKind: 'report_on_title', rule: 'Always a decision: the AI draft is approved or rejected by a person; it is sent only after the approval event, and the database refuses a send without one.' },
  { id: 'proof_of_funds', label: 'Proof of funds', stage: 'any', waitKey: 'proof_of_funds', start: ['proof_of_funds_requested'], extracted: null, cleared: null, flagged: 'proof_of_funds_submitted', reviewed: 'proof_of_funds_reviewed', decisionKind: 'proof_of_funds', rule: 'Always a decision: the client\'s declaration is rule-checked (shortfall, unevidenced source, gift, repayable gift, higher-risk source, incomplete declarations) and briefed; the conveyancer signs off, asks for more (re-opens the form), escalates or rejects (manual handling). A round in flight holds exchange.' },
  { id: 'management_pack', label: 'Management pack (leasehold)', stage: 'pre_contract', waitKey: 'management_pack', start: ['management_pack_requested'], extracted: null, cleared: null, flagged: 'management_pack_received', reviewed: 'management_pack_reviewed', decisionKind: 'management_pack', rule: 'Leasehold only. Always a decision: the LPE1 is a set of client-advice points (service charge, ground rent, arrears, major works, insurance). Gates pre_contract on a leasehold purchase.' },
  { id: 'chase', label: 'Chasing & escalation', stage: 'any', waitKey: null, start: ['chase_sent'], extracted: null, cleared: null, flagged: 'escalation_raised', reviewed: 'escalation_resolved', decisionKind: 'escalation', rule: 'Working-day timers chase the party that owes us and escalate to a person with a dossier; deadlines we owe are raised once, in time.' },
];

export const COMMAND_SPECS: CommandSpec[] = [
  { type: 'enrol', actor: 'either', stages: 'not_enrolled', emits: ['matter_created'], description: 'Put a matter under the engine (lender?, required searches, target dates, counterparty type, shadow mode).' },
  { type: 'mark_manual_handling', actor: 'either', stages: 'any', emits: ['manual_handling_required'], description: 'Stop automation; a person runs the matter from here.' },
  { type: 'request_id_check', actor: 'either', stages: 'any', emits: ['id_check_requested'], description: 'Ask the ID provider (or record that the firm did).' },
  { type: 'id_check_result', actor: 'automation', stages: 'any', emits: ['id_check_cleared', 'id_check_flagged', 'auto_clear_review_raised'], description: 'The provider\'s report, extracted and rule-checked.' },
  { type: 'record_search_ordered', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['search_ordered'], description: 'A search placed (automatically on pre_contract entry, or by hand; a resolved search may be re-ordered).' },
  { type: 'search_returned', actor: 'either', stages: 'any', emits: ['search_returned'], description: 'The result document is back.' },
  { type: 'search_extracted', actor: 'automation', stages: 'any', emits: ['search_extracted', 'search_cleared', 'search_flagged', 'auto_clear_review_raised'], description: 'Facts extracted from the result, rule-checked.' },
  { type: 'raise_enquiry', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['enquiry_raised'], description: 'An enquiry to the other side (external, or internal across the wall); may be raised from an open issue, which then tracks it.' },
  { type: 'enquiry_reply_received', actor: 'automation', stages: 'any', emits: ['enquiry_reply_received', 'enquiry_reply_cleared', 'enquiry_reply_flagged', 'auto_clear_review_raised'], description: 'A reply document, extracted and rule-checked.' },
  { type: 'mortgage_offer_received', actor: 'either', stages: 'any', emits: ['mortgage_offer_received'], description: 'The offer document is on file.' },
  { type: 'mortgage_offer_extracted', actor: 'automation', stages: 'any', emits: ['mortgage_offer_extracted', 'mortgage_offer_cleared', 'mortgage_condition_flagged', 'auto_clear_review_raised'], description: 'Conditions and expiry extracted, rule-checked.' },
  { type: 'title_extracted', actor: 'automation', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['title_extracted', 'title_cleared', 'title_flagged', 'auto_clear_review_raised', 'manual_handling_required'], description: 'Register entries extracted, rule-checked; non-freehold halts automation.' },
  { type: 'open_decision_source', actor: 'person', stages: 'any', emits: ['decision_source_opened'], description: 'The handler opened the cited source (precondition of resolving).' },
  { type: 'resolve_decision', actor: 'person', stages: 'any', emits: ['id_check_reviewed', 'search_reviewed', 'enquiry_reply_reviewed', 'mortgage_condition_reviewed', 'title_reviewed', 'report_on_title_approved', 'report_on_title_rejected', 'escalation_raised', 'escalation_resolved', 'bank_details_verified', 'bank_details_verification_failed', 'auto_clear_confirmed', 'hmlr_requisition_responded', 'enquiry_raised', 'manual_handling_required', 'proof_of_funds_reviewed', 'management_pack_reviewed', 'issue_resolved', 'issue_raised'], description: 'Choose an option (with a reason unless approving); may raise a follow-up enquiry, an escalation, or halt automation. Signing off proof of funds closes the source-of-funds issues it answers and tells the lender about a gift.' },
  { type: 'draft_report_on_title', actor: 'automation', stages: ['contract_review'], emits: ['report_on_title_drafted'], description: 'The AI drafts; the draft is a decision.' },
  { type: 'request_proof_of_funds', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['proof_of_funds_requested'], description: 'Issue the tokenised proof-of-funds form and send it to the client (recorded after the send; the client wait opens).' },
  { type: 'raise_proof_of_funds_query', actor: 'person', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['proof_of_funds_query_raised'], description: 'A person adds a query to the client about a transaction or a gap (the rules draft theirs at submission).' },
  { type: 'withdraw_proof_of_funds_query', actor: 'person', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['proof_of_funds_query_withdrawn'], description: 'A drafted query is not put, with the reason on the log ("considered and discounted").' },
  { type: 'proof_of_funds_submitted', actor: 'automation', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['proof_of_funds_query_answered', 'proof_of_funds_query_raised', 'proof_of_funds_submitted'], description: 'The client submitted: answers to the queries sent, statements read transaction by transaction, rule flags (declaration and transaction level) each drafting a query, the declaration document, the risk rating, and a decision for the conveyancer.' },
  { type: 'management_pack_requested', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['management_pack_requested'], description: 'Leasehold: the LPE1 requested from the seller\'s side / managing agent; the wait opens.' },
  { type: 'management_pack_received', actor: 'either', stages: 'any', emits: ['management_pack_received'], description: 'Leasehold: the pack arrived; always a decision citing it.' },
  { type: 'notice_of_assignment_served', actor: 'either', stages: ['completed', 'post_completion'], emits: ['notice_of_assignment_served'], description: 'Leasehold: notice of assignment / charge served on the landlord after completion.' },
  { type: 'record_report_on_title_sent', actor: 'person', stages: ['contract_review'], emits: ['report_on_title_sent'], description: 'Sent — only after the approval event, and the database checks that too.', humanGated: true },
  { type: 'deposit_received', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['deposit_received', 'exchange_conditions_met'], description: 'Deposit in; at pre_exchange this derives exchange_conditions_met.' },
  { type: 'contracts_exchanged', actor: 'either', stages: ['pre_exchange'], emits: ['contracts_exchanged', 'stage_advanced'], description: 'Exchange with a completion date; refused if the offer is withdrawn or a search is re-ordered.' },
  { type: 'completion_statement_generated', actor: 'either', stages: ['exchanged'], emits: ['completion_statement_generated', 'stage_advanced'], description: 'Statement produced (can be regenerated).' },
  { type: 'record_bank_details', actor: 'either', stages: 'any', emits: ['bank_details_recorded', 'bank_details_change_flagged'], description: 'Bank details arrive (any channel, first time or change) → always a hard-stop decision.' },
  { type: 'payment_authorised', actor: 'person', stages: ['pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], emits: ['payment_authorised'], description: 'A person authorises a payment against the newest verified record.', humanGated: true, hardStop: true },
  { type: 'funds_requested', actor: 'person', stages: ['pre_completion'], emits: ['funds_requested'], description: 'Ask the lender / client for completion funds into our verified client account.', humanGated: true, hardStop: true },
  { type: 'funds_received', actor: 'either', stages: 'any', emits: ['funds_received'], description: 'Funds landed.' },
  { type: 'completion_confirmed', actor: 'either', stages: ['pre_completion'], emits: ['completion_confirmed', 'stage_advanced'], description: 'Completed — refused while a bank-details change is pending or the payment was not authorised.', hardStop: true },
  { type: 'sdlt_submitted', actor: 'either', stages: ['completed', 'post_completion'], emits: ['sdlt_submitted', 'stage_advanced'], description: 'SDLT return filed.' },
  { type: 'ap1_submitted', actor: 'either', stages: ['completed', 'post_completion'], emits: ['ap1_submitted', 'stage_advanced'], description: 'AP1 lodged; opens the registration wait.' },
  { type: 'ap1_confirmed', actor: 'either', stages: 'any', emits: ['ap1_confirmed'], description: 'Registered (terminal). Refused while a requisition is unanswered.' },
  { type: 'record_chase', actor: 'automation', stages: 'any', emits: ['chase_sent'], description: 'Timer: a template chase was sent (recorded only after the send).' },
  { type: 'raise_escalation', actor: 'automation', stages: 'any', emits: ['escalation_raised'], description: 'Timer: a wait aged past its SLA → decision with the chase dossier.' },
  { type: 'record_client_update', actor: 'automation', stages: 'any', emits: ['client_update_sent'], description: 'A templated status update was sent to the client.' },
  { type: 'record_suppressed', actor: 'automation', stages: 'any', emits: ['action_suppressed'], description: 'Shadow mode: the intent, not the action.' },
  { type: 'set_shadow_mode', actor: 'person', stages: 'any', emits: ['shadow_mode_changed'], description: 'Admin switches shadow mode.' },
  // eventualities
  { type: 'abandon_matter', actor: 'person', stages: 'any', emits: ['matter_abandoned'], description: 'Abortive: client withdrew, chain collapsed, gazumped… Waits close, timers stop, only corrections may follow.', eventuality: true },
  { type: 'set_target_dates', actor: 'either', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], emits: ['target_dates_changed'], description: 'Re-plan target exchange / completion before exchange.', eventuality: true },
  { type: 'change_completion_date', actor: 'either', stages: ['exchanged', 'pre_completion'], emits: ['completion_date_changed'], description: 'Move the contractual completion date after exchange.', eventuality: true },
  { type: 'notice_to_complete_served', actor: 'either', stages: ['exchanged', 'pre_completion'], emits: ['notice_to_complete_served'], description: 'Either side served notice: a decision citing the notice; the timer raises the deadline.', eventuality: true },
  { type: 'mortgage_offer_withdrawn', actor: 'either', stages: ['pre_contract', 'contract_review', 'pre_exchange'], emits: ['mortgage_offer_withdrawn'], description: 'Offer withdrawn / lapsed before exchange: sub-flow reopens, exchange blocked.', eventuality: true },
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
  { id: 'shadow', title: 'Shadow before live', rule: 'A shadow matter or sub-flow is logged, never surfaced, never sent; conclusions are compared with the human record before promotion.', enforcedBy: ['service.ts suppressed()', 'store.ts surfacedDecisions'] },
  { id: 'truthful_log', title: 'The log only says what happened', rule: 'I/O is recorded after it succeeded; a result that arrives for a step nobody started records the start first (actor external); errors are corrections, never edits.', enforcedBy: ['service.ts', 'sync.ts routeByHint', 'record_correction'] },
  { id: 'abandoned_is_final', title: 'Abandoned is final', rule: 'After matter_abandoned nothing moves: waits close, timers stop, commands are refused, only corrections are accepted.', enforcedBy: ['machine.ts requireEnrolled'] },
  { id: 'issues_hold', title: 'An open issue holds its gate', rule: 'An open or negotiating issue gated on exchange blocks exchange_conditions_met, contracts_exchanged and the pre_exchange exit; one gated on completion blocks completion_confirmed. Everything else proceeds ("everything but exchange can go on"). Releasing a hold needs a note.', enforcedBy: ['machine.ts issuesGating', 'stageBlockers'] },
  { id: 'sof_scrutinised', title: 'Source of funds is scrutinised, not filed', rule: 'Every attached statement is read transaction by transaction; every unusual credit drafts a query; sign-off is refused while a query is open (send it, or withdraw it with a reason); a round in flight — and, by firm policy, an unsigned-off check — holds exchange; money accepted before sign-off raises an issue; a price rise beyond the verified funds re-opens the question.', enforcedBy: ['proof-of-funds.ts reviewTransactions', 'machine.ts proofOfFundsHolds', 'resolveEvents'] },
  { id: 'lender_told', title: 'The lender is told', rule: 'On a lender-funded purchase a price change, an indemnity policy or a retention automatically raises a lender_approval issue that holds exchange until the lender confirms.', enforcedBy: ['machine.ts lenderApprovalIssue'] },
];

export const EVENTUALITIES: EventualitySpec[] = [
  { area: 'shape', scenario: 'Cash purchase', handling: 'built', mechanism: 'hasLender=false → no mortgage sub-flow, no lender funds' },
  { area: 'shape', scenario: 'Mortgage purchase', handling: 'built', mechanism: 'offer sub-flow; expiry deadline; withdrawal reopens and blocks exchange' },
  { area: 'shape', scenario: 'Chain', handling: 'built', mechanism: 'issue chain_not_ready holds exchange; set_target_dates; mark_issue_fatal → abandoned(chain_collapsed)' },
  { area: 'shape', scenario: 'Two or more buyers', handling: 'built', mechanism: 'issues carry the party they concern; one ID sub-flow per matter still (design: idChecks keyed by party)' },
  { area: 'shape', scenario: 'Company buyer / buy-to-let', handling: 'manual', mechanism: 'mark_manual_handling by policy' },
  { area: 'shape', scenario: 'Gifted deposit / source of funds', handling: 'built', mechanism: 'proof-of-funds form → statements read line by line → flags draft queries → client answers → sign-off decision; sign-off closes source_of_funds issues and tells the lender of a gift' },
  { area: 'shape', scenario: 'Unusual transactions on a statement (cash, third party, crypto, gambling, overseas, in-and-out)', handling: 'built', mechanism: 'reviewTransactions flags each line and drafts the query; QUERY_UNANSWERED keeps it open; risk rating enhanced' },
  { area: 'exchange', scenario: 'Deposit received before source of funds signed off', handling: 'built', mechanism: 'issue aml_kyc_problem raised automatically, holds exchange' },
  { area: 'pre_contract', scenario: 'Price rises beyond the verified funds', handling: 'built', mechanism: 'issue source_of_funds raised automatically on price_changed' },
  { area: 'shape', scenario: 'Help to Buy / Lifetime ISA', handling: 'gap', mechanism: 'design: funds_requested fromRole isa_provider' },
  { area: 'shape', scenario: 'New build / auction', handling: 'manual', mechanism: 'out of v1 scope' },
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
  { area: 'pre_contract', scenario: 'Down-valuation', handling: 'built', mechanism: 'issue valuation_shortfall → price reduced / buyer covers / new lender (reopens the offer) / challenge' },
  { area: 'pre_contract', scenario: 'Missing building regs / FENSA / planning', handling: 'built', mechanism: 'issues missing_building_regs, planning_breach, document_missing → indemnity (lender told) / regularisation / retrospective consent' },
  { area: 'pre_contract', scenario: 'Probate not granted / attorney / capacity', handling: 'built', mechanism: 'issue seller_capacity holds exchange; everything else proceeds' },
  { area: 'pre_contract', scenario: 'Solar lease / septic tank / unadopted road', handling: 'built', mechanism: 'issues third_party_encumbrance, access_rights → evidence / lender confirmed / indemnity' },
  { area: 'pre_contract', scenario: 'Issue goes quiet for weeks', handling: 'built', mechanism: 'stale_issue timer: escalation after 10 working days without movement' },
  { area: 'contract_review', scenario: 'Restriction / charge / covenant', handling: 'built', mechanism: 'title decision incl. indemnity (lender_approval issue on a lender-funded purchase); issues covenant_consent, title_defect' },
  { area: 'contract_review', scenario: 'Ready to exchange?', handling: 'built', mechanism: 'readiness milestones contract_approved, signed_contract_held (advisory) + stage blockers' },
  { area: 'contract_review', scenario: 'New information after the report went', handling: 'manual', mechanism: 'title re-extraction refused after send' },
  { area: 'contract_review', scenario: 'Draft rejected', handling: 'built', mechanism: 'report_on_title_rejected → redraft' },
  { area: 'exchange', scenario: 'Simultaneous exchange and completion', handling: 'built', mechanism: 'exchange with completionDate = today' },
  { area: 'exchange', scenario: 'Exchange deferred', handling: 'built', mechanism: 'set_target_dates' },
  { area: 'exchange', scenario: 'Gazumped / withdrawn / chain collapse', handling: 'built', mechanism: 'abandon_matter' },
  { area: 'exchange', scenario: 'Deposit late / short', handling: 'built', mechanism: 'issue funding_shortfall → funds_in_place' },
  { area: 'exchange', scenario: 'Issue proves fatal', handling: 'built', mechanism: 'mark_issue_fatal → issue_fatal + matter_abandoned' },
  { area: 'completion', scenario: 'Completion date moved', handling: 'built', mechanism: 'change_completion_date' },
  { area: 'completion', scenario: 'Notice to complete', handling: 'built', mechanism: 'decision + deadline timer 2 wd out' },
  { area: 'completion', scenario: 'Lender funds late', handling: 'built', mechanism: 'funds wait timers' },
  { area: 'completion', scenario: 'Client balance short', handling: 'built', mechanism: 'issue funding_shortfall (gate completion) → funds_in_place' },
  { area: 'completion', scenario: 'Completion fails on the day', handling: 'built', mechanism: 'issue completion_failure holds completion_confirmed → completed_late / funds_in_place; notice to complete if it slips' },
  { area: 'completion', scenario: 'Bank details "change"', handling: 'built', mechanism: 'addendum 2 hard stop' },
  { area: 'post_completion', scenario: 'SDLT within 14 days', handling: 'built', mechanism: 'deadline timer 5 wd out' },
  { area: 'post_completion', scenario: 'HMLR requisition', handling: 'built', mechanism: 'requisition decision; blocks ap1_confirmed; deadline timer' },
  { area: 'post_completion', scenario: 'Registration slow', handling: 'built', mechanism: 'registration wait timers' },
  { area: 'post_completion', scenario: 'OS1 priority expiring', handling: 'gap', mechanism: 'design: priority_search_made(expiresAt)' },
  { area: 'cross', scenario: 'Documents in any order', handling: 'built', mechanism: 'PENDING ingest retry' },
  { area: 'cross', scenario: 'Duplicate / re-issued document', handling: 'built', mechanism: 'idempotent on provider id; re-issue = new cycle' },
  { area: 'cross', scenario: 'Something recorded in error', handling: 'built', mechanism: 'record_correction (compensating, never an edit)' },
  { area: 'cross', scenario: 'Bank holidays', handling: 'built', mechanism: 'E&W working-day calendar' },
  { area: 'cross', scenario: 'Two backends (LEAP / own app)', handling: 'built', mechanism: 'CaseBackend abstraction' },
];

const eventCategory = (t: EventType): string => {
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
  if (/^management_pack|notice_of_assignment/.test(t)) return 'leasehold';
  if (/abandon|target_dates|completion_date|notice_to_complete|withdrawn|requisition|correction|handler/.test(t)) return 'eventualities';
  return 'lifecycle';
};

export function machineSpec(): MachineSpec {
  const body: Omit<MachineSpec, 'version'> = {
    generatedFrom: 'lib/server/engine/spec.ts (checked against machine.ts, types.ts, rules.ts, sla.ts, triggers.ts by tests/unit/engine/spec.test.ts)',
    stages: STAGE_SPECS,
    terminal: [
      { id: 'registered', label: 'Registered', how: 'ap1_confirmed at post_completion' },
      { id: 'abandoned', label: 'Abandoned', how: 'abandon_matter from any stage before completion' },
      { id: 'manual', label: 'Manual handling', how: 'mark_manual_handling, ID rejected, or non-freehold title — automation stops, the log continues' },
    ],
    subflows: SUBFLOW_SPECS,
    commands: COMMAND_SPECS,
    events: EVENT_TYPES.map((t) => ({ type: t, category: eventCategory(t), decision: DECISION_EVENT_TYPES.includes(t), humanGated: HUMAN_GATED_EVENTS.includes(t) })),
    decisions: DECISION_KINDS.map((kind) => ({ kind, label: kind.replace(/_/g, ' '), options: OPTIONS_FOR[kind], source: SUBFLOW_SPECS.find((s) => s.decisionKind === kind)?.label ?? (kind === 'bank_details' ? 'the document the details arrived on' : kind === 'requisition' ? 'the HMLR requisition letter' : kind === 'auto_clear' ? 'the auto-cleared document' : kind === 'proof_of_funds' ? 'the client\'s declaration and its attachments' : kind === 'management_pack' ? 'the LPE1 / management pack' : 'the chase / deadline dossier') })),
    timers: {
      waits: (Object.keys(DEFAULT_SLA) as WaitKey[]).map((k) => ({ waitKey: k, chaseAfter: DEFAULT_SLA[k].chaseAfter, chaseEvery: DEFAULT_SLA[k].chaseEvery, escalateAfter: DEFAULT_SLA[k].escalateAfter, reEscalateAfter: DEFAULT_SLA[k].reEscalateAfter, recipientRole: DEFAULT_SLA[k].recipientRole, template: DEFAULT_SLA[k].template })),
      deadlines: (Object.keys(DEADLINE_LEAD) as DeadlineKind[]).map((kind) => ({ kind, leadWorkingDays: DEADLINE_LEAD[kind], description: { mortgage_offer_expiry: 'offer expiry before exchange', sdlt_filing: '14 days from completion', notice_to_complete: 'notice expiry', requisition_reply: 'HMLR reply-by date', stale_issue: 'an open issue with no movement (working days since last touched)' }[kind] })),
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
        effects: [
          ...(PRICE_RESOLUTIONS.has(id) ? ['records price_changed (new price required, before exchange only)'] : []),
          ...(LENDER_NOTIFY_RESOLUTIONS.has(id) ? ['lender-funded purchase: raises a lender_approval issue holding exchange'] : []),
          ...(REOPENS_OFFER.has(id) ? ['lender-funded purchase: records mortgage_offer_withdrawn (the sub-flow reopens)'] : []),
        ],
      })),
      staleAfterWorkingDays: DEADLINE_LEAD.stale_issue,
    },
  };
  const version = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { version, ...body };
}

export { STAGES, SUB_FLOWS, USER_COMMANDS };
