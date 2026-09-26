/**
 * The case rules, as sentences a firm signs off: what the engine does on its own when
 * something happens on a case, what it holds, and who it tells. Each entry names the
 * code that enforces it, so the sentence and the behaviour cannot drift apart unnoticed:
 * change the constant, change the sentence.
 *
 * Verdict rules on documents (thresholds) are listed separately on the Rules page.
 */
import { MORTGAGE_EXPIRY_CRITICAL_DAYS, MORTGAGE_EXPIRY_WARNING_DAYS } from './issues';
import { DEADLINE_LEAD } from './sla';

export interface CaseRule {
  id: string;
  group: 'Instruction' | 'Money & AML' | 'Mortgage' | 'Searches & Enquiries' | 'Title' | 'Exchange' | 'Completion' | 'Registration' | 'Timers' | 'Safety';
  when: string;
  then: string;
  holds?: string;
  tells?: string;
  /** Where it lives, for the developer. */
  source: string;
}

export const CASE_RULES: CaseRule[] = [
  // ── Instruction ──
  { id: 'enrol_start', group: 'Instruction', when: 'A case is enrolled', then: 'The ID / AML check is requested from the provider for every client. On a purchase that needs one, the proof-of-funds form goes to the client.', tells: 'Client', source: 'service.ts effects(matter_created)' },
  { id: 'id_clear_advances', group: 'Instruction', when: 'The ID / AML result is clear', then: 'The case moves from instruction to pre-contract and every search on its list is ordered.', tells: 'Client (searches ordered)', source: 'machine.ts stageBlockers(instruction); service.ts effects(stage_advanced)' },
  { id: 'id_refer_or_fail', group: 'Instruction', when: 'The ID / AML result is referred or failed', then: 'A decision goes to a conveyancer with the provider report. A rejected check puts the case into manual handling; nothing automatic runs until a person clears it.', holds: 'Exchange', source: 'rules.ts evaluateIdCheck; machine.ts id_check resolution' },
  // ── Money & AML ──
  { id: 'pof_holds_exchange', group: 'Money & AML', when: 'Firm policy requires proof of funds', then: 'Exchange is held until a conveyancer signs off the declaration and statements. Sign-off is never automated.', holds: 'Exchange', source: 'machine.ts proofOfFundsHolds; graph.ts source_of_funds_satisfactory' },
  { id: 'pof_queries', group: 'Money & AML', when: 'The proof-of-funds form is submitted', then: 'The rules read the statements, rate the risk and draft a query to the client for each shortfall, gift, overseas source or large unexplained credit. Sign-off is refused while any query is open.', tells: 'Client (queries)', source: 'proof-of-funds.ts evaluateProofOfFunds, reviewTransactions' },
  { id: 'pof_reject_manual', group: 'Money & AML', when: 'A conveyancer rejects the proof of funds', then: 'The case goes into manual handling.', holds: 'Everything automatic', source: 'machine.ts proof_of_funds resolution' },
  { id: 'deposit_before_pof', group: 'Money & AML', when: 'A deposit arrives before proof of funds is signed off', then: 'An AML issue is raised on the case and stays open until a person resolves it.', holds: 'Exchange', source: 'machine.ts deposit_received' },
  { id: 'price_change', group: 'Money & AML', when: 'The price rises after proof of funds was signed off', then: 'The source-of-funds question is re-opened as an issue for the difference. A lower price does not.', holds: 'Exchange', source: 'machine.ts price_changed' },
  { id: 'bank_details_hard_stop', group: 'Money & AML', when: 'Bank details arrive or change, on any channel', then: 'They are recorded unverified and a hard-stop decision is raised. A change from details already held is flagged as the fraud signal. Only a phone call to a known number, a Lawyer Checker match, an in-person or a video confirmation can verify them; a reply on the same channel is refused.', holds: 'Every payment to that payee', source: 'machine.ts record_bank_details; types.ts VERIFICATION_METHODS' },
  { id: 'payments_by_person', group: 'Money & AML', when: 'Money is to go out', then: 'A person authorises it against verified details. The rules never move money.', holds: 'Completion, balance to the client, redemption', source: 'machine.ts payment_authorised; graph.ts payment_authorised, balance_to_client, redemption_authorised' },
  // ── Mortgage ──
  { id: 'offer_conditions', group: 'Mortgage', when: 'The mortgage offer is filed', then: 'Standard conditions clear by rule; special conditions, a retention or a down-valuation go to a conveyancer.', tells: 'Client (offer checked) once clear', source: 'rules.ts evaluateMortgageOffer' },
  { id: 'offer_expiring', group: 'Mortgage', when: `The offer is within ${MORTGAGE_EXPIRY_WARNING_DAYS} days of expiry and contracts are not exchanged`, then: `An issue is raised. At ${MORTGAGE_EXPIRY_CRITICAL_DAYS} days it becomes critical. ${DEADLINE_LEAD.mortgage_offer_expiry} working days before expiry a deadline escalation goes to the handler.`, tells: 'Handler', source: 'sla.ts timedIssueActions, deadlineActions' },
  { id: 'offer_expired', group: 'Mortgage', when: 'The offer expires before exchange', then: 'The offer is marked expired, the expiring issue closes and an expired-offer issue opens. Funding is incomplete until a new offer is filed and checked.', holds: 'Exchange', source: 'sla.ts timedIssueActions offer_expired; issues.ts mortgage_offer_expired' },
  // ── Searches & enquiries ──
  { id: 'searches_order', group: 'Searches & Enquiries', when: 'The case enters pre-contract', then: 'Every search on its list is ordered from the provider.', tells: 'Client (searches ordered)', source: 'service.ts effects(stage_advanced → pre_contract)' },
  { id: 'search_result', group: 'Searches & Enquiries', when: 'A search result arrives', then: 'It is read and rule-checked: clear, or a decision to a conveyancer with the flags cited to the page.', tells: 'Client (clear, or under review)', source: 'rules.ts evaluateSearch' },
  { id: 'search_delayed', group: 'Searches & Enquiries', when: 'A search is outstanding past its chase timer', then: 'An issue is raised on the case; it closes itself when the result arrives.', source: 'sla.ts timedIssueActions search-delayed' },
  { id: 'enquiry_reply', group: 'Searches & Enquiries', when: 'A reply to an enquiry arrives', then: 'The reply is acknowledged and rule-checked: a full answer clears; a partial, evasive or "not known" reply goes to a conveyancer.', tells: "Other side (acknowledgement)", source: 'rules.ts evaluateEnquiryReply; service.ts ACKNOWLEDGE' },
  { id: 'request_further', group: 'Searches & Enquiries', when: 'A conveyancer chooses "request further" on a search, reply, title or offer', then: 'A follow-up enquiry is raised and its wait is tracked and chased.', source: 'machine.ts resolveEvents request_further' },
  // ── Title ──
  { id: 'title_read', group: 'Title', when: 'Official copies are filed', then: 'Restrictions, charges to discharge and covenants go to a conveyancer; a clean title clears. A tenure that does not match the instruction, or cannot be read, puts the case into manual handling.', source: 'rules.ts evaluateTitle; machine.ts title_extracted' },
  { id: 'report_draft', group: 'Title', when: 'Title, searches and enquiries are resolved', then: 'The report on title is drafted from the file and put to a conveyancer to approve. Approval sends it and records it as sent.', tells: 'Client (report sent)', source: 'service.ts report drafter; machine.ts report_on_title' },
  // ── Exchange ──
  { id: 'exchange_gate', group: 'Exchange', when: 'Exchange is attempted', then: 'It is refused unless ID / AML passed, source of funds is signed off, enquiries are satisfied, the report on title has gone, the client is satisfied with the physical condition, the deposit is confirmed, the signed contract is held and the client has authorised exchange. On a sale, the property forms must be back.', holds: 'Exchange', source: 'graph.ts requirements(gate=exchange); machine.ts contracts_exchanged' },
  { id: 'issue_holds_gate', group: 'Exchange', when: 'An issue is open that threatens a gate', then: 'That gate is held until the issue is resolved or accepted by a person, with the resolution and its cost recorded.', holds: 'The gate the issue names', source: 'issues.ts ISSUE_KIND_SPEC threatens; graph.ts issueBlockers' },
  { id: 'exchanged_tells', group: 'Exchange', when: 'Contracts are exchanged', then: 'The completion date is fixed, the client and the agent are told, and completion work begins.', tells: 'Client, agent', source: 'service.ts CLIENT_UPDATE_TEMPLATES contracts_exchanged' },
  // ── Completion ──
  { id: 'completion_gate', group: 'Completion', when: 'Completion is attempted', then: 'It is refused unless contracts are exchanged, the completion statement is produced, the deeds are executed, the certificate of title has gone where there is a lender, every payment is authorised by a person and no issue holds completion.', holds: 'Completion', source: 'graph.ts requirements(gate=completion)' },
  { id: 'notice_to_complete', group: 'Completion', when: 'A notice to complete is served', then: `Its expiry is tracked; ${DEADLINE_LEAD.notice_to_complete} working days before it a deadline escalation goes to the handler.`, tells: 'Handler', source: 'sla.ts deadlineActions notice_to_complete' },
  { id: 'completed_tells', group: 'Completion', when: 'Completion is confirmed', then: 'The client is told and the SDLT and registration clocks start.', tells: 'Client', source: 'service.ts CLIENT_UPDATE_TEMPLATES completion_confirmed' },
  // ── Registration ──
  { id: 'sdlt_deadline', group: 'Registration', when: 'Completion has happened and SDLT is not filed', then: `The 14-day deadline is tracked; ${DEADLINE_LEAD.sdlt_filing} working days before it a deadline escalation goes to the handler.`, tells: 'Handler', source: 'sla.ts deadlineActions sdlt_filing' },
  { id: 'requisition_deadline', group: 'Registration', when: 'HM Land Registry raises a requisition', then: `A decision goes to a conveyancer and the reply deadline is tracked, escalating ${DEADLINE_LEAD.requisition_reply} working days before it.`, holds: 'Registration', source: 'sla.ts deadlineActions requisition_reply' },
  { id: 'registered_tells', group: 'Registration', when: 'Registration is confirmed', then: 'The client is told. The file can close once nothing is open.', tells: 'Client', source: 'service.ts CLIENT_UPDATE_TEMPLATES ap1_confirmed; graph.ts gate close' },
  // ── Timers ──
  { id: 'chase_timers', group: 'Timers', when: 'Something we are waiting for passes its chase timer', then: 'The party who owes it is chased on the template for that wait, then again on the repeat interval. The client is told we chased.', tells: 'The party; client', source: 'sla.ts dueActions; Timers section' },
  { id: 'escalate_timers', group: 'Timers', when: 'A wait passes its escalation timer', then: 'An escalation decision goes to the handler. If still waiting after it is dealt with, it escalates again on the re-escalation interval.', tells: 'Handler', source: 'sla.ts dueActions escalate' },
  { id: 'stale_issue', group: 'Timers', when: `An open issue is untouched for ${DEADLINE_LEAD.stale_issue} working days`, then: 'It is raised to the handler as an escalation. Touching it restarts the clock.', tells: 'Handler', source: 'sla.ts deadlineActions stale_issue' },
  { id: 'acknowledge', group: 'Timers', when: 'A party sends us something (replies, enquiries, a survey, forms, the offer, the proof-of-funds form)', then: 'They are acknowledged once, at once, so they never write to ask. One acknowledgement per party per delivery.', tells: 'The sender', source: 'service.ts ACKNOWLEDGE, ACK_WINDOW_MS' },
  // ── Safety ──
  { id: 'trust_levels', group: 'Safety', when: 'The engine is about to act unasked', then: 'The trust level for that action and subject decides: Propose puts it in Tasks with the reason and waits; Assist acts and asks a person to confirm what the rules cleared; Auto acts. Flagged documents and payments always come to a person.', source: 'types.ts levelFor; service.ts proposeUnless' },
  { id: 'low_confidence', group: 'Safety', when: 'A document is read with low confidence', then: 'It goes to a person. Nothing is guessed from a blurry scan.', source: 'rules.ts MIN_EXTRACTION_CONFIDENCE' },
  { id: 'decision_source', group: 'Safety', when: 'A person takes a decision', then: 'They must have opened the source document and dwelt on it; every decision other than approve needs a reason. The decision, the source and the reason are on the log.', source: 'DecisionPanel engagement gate; machine.ts resolve' },
  { id: 'manual_handling', group: 'Safety', when: 'A person takes a case over manually, or the engine cannot read the tenure', then: 'Automation pauses on that case. People can still record anything; the engine proposes nothing until it is released.', holds: 'Everything automatic', source: 'machine.ts mark_manual_handling; projection.ts manualHandling' },
  { id: 'single_writer', group: 'Safety', when: 'Two things try to change a case at the same moment', then: 'They are serialised: one wins, the other re-reads and retries. Two rules can never both act on stale state.', source: 'store.ts advisory lock, ConcurrencyError' },
];
