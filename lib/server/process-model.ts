/**
 * THE canonical UK conveyancing process model — single source of truth.
 *
 * This is the code embodiment of docs/conveyancing-process-model.md. Everything that
 * encodes "the conveyancing process" imports from here, so there is ONE place to edit
 * the stages, the default task DAG and the email transition signals:
 *
 *   - stages.ts         → seeds the firm's editable pipeline from PROCESS_STAGES
 *   - workflow.ts       → seeds the default task DAG from DEFAULT_TASKS / DEFAULT_DEPS
 *   - stage-inference.ts→ advances a matter's stage using STAGE_ORDER + STAGE_SIGNALS
 *
 * The stage keys are the join between all three — a task template, a matter's current
 * stage, and a transition signal all speak the same STAGE_KEYS vocabulary. Firms then
 * rename/reorder/extend the seeded copy; this module is only the starting point.
 *
 * Per the doc (§ "the stage is a best-estimate, never a hard gate"), the stage is an
 * inferred position, not an enforced gate — the task DAG's prerequisites are the only
 * hard ordering.
 */

/** The 8-stage A–F spine (the doc's INSTRUCTION → POST_COMPLETION), key + display name. */
export const PROCESS_STAGES: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'INSTRUCTION', name: 'Instruction' },
  { key: 'CONTRACT_PACK', name: 'Contract pack' },
  { key: 'SEARCHES_ENQUIRIES', name: 'Searches & enquiries' },
  { key: 'REVIEW_SIGNING', name: 'Review & signing' },
  { key: 'EXCHANGE', name: 'Exchange' },
  { key: 'COMPLETION', name: 'Completion' },
  { key: 'POST_COMPLETION', name: 'Post-completion' },
];

/** Ordered stage keys — the spine's forward direction (used for forward-only inference). */
export const STAGE_ORDER: readonly string[] = PROCESS_STAGES.map((s) => s.key);

/**
 * Default conveyancing task DAG, seeded once (the firm edits from here). Laid out
 * left→right by stage (col), stacked within a stage (row). Deps encode the natural
 * order (review after request, exchange after signing…). Keys are internal seed ids,
 * only referenced by DEFAULT_DEPS.
 */
export const DEFAULT_TASKS: ReadonlyArray<{ key: string; stage: string; detail: string; col: number; row: number }> = [
  { key: 'ins_care', stage: 'INSTRUCTION', detail: 'Issue client care letter & fee estimate', col: 0, row: 0 },
  { key: 'ins_id', stage: 'INSTRUCTION', detail: 'Complete ID verification & AML checks', col: 0, row: 1 },
  { key: 'ins_funds', stage: 'INSTRUCTION', detail: 'Confirm source of funds', col: 0, row: 2 },
  { key: 'cp_request', stage: 'CONTRACT_PACK', detail: "Request contract pack from seller's solicitor", col: 1, row: 0 },
  { key: 'cp_review', stage: 'CONTRACT_PACK', detail: 'Review contract pack (contract, TA6, TA10, title)', col: 1, row: 1 },
  { key: 'se_order', stage: 'SEARCHES_ENQUIRIES', detail: 'Order property searches (local, drainage & water, environmental)', col: 2, row: 0 },
  { key: 'se_enquiries', stage: 'SEARCHES_ENQUIRIES', detail: "Raise pre-contract enquiries with seller's solicitor", col: 2, row: 1 },
  { key: 'se_review', stage: 'SEARCHES_ENQUIRIES', detail: 'Review search results & replies to enquiries', col: 2, row: 2 },
  { key: 'se_report', stage: 'SEARCHES_ENQUIRIES', detail: 'Report to client on searches, title & enquiries', col: 2, row: 3 },
  { key: 'rs_mortgage', stage: 'REVIEW_SIGNING', detail: 'Check mortgage offer & conditions', col: 3, row: 0 },
  { key: 'rs_send', stage: 'REVIEW_SIGNING', detail: 'Send contract & report to client for signature', col: 3, row: 1 },
  { key: 'rs_signed', stage: 'REVIEW_SIGNING', detail: 'Obtain signed contract & deposit funds', col: 3, row: 2 },
  { key: 'ex_date', stage: 'EXCHANGE', detail: 'Agree completion date with all parties', col: 4, row: 0 },
  { key: 'ex_exchange', stage: 'EXCHANGE', detail: 'Exchange contracts', col: 4, row: 1 },
  { key: 'co_statement', stage: 'COMPLETION', detail: 'Prepare completion statement & request funds from client', col: 5, row: 0 },
  { key: 'co_funds', stage: 'COMPLETION', detail: 'Request mortgage advance from lender', col: 5, row: 1 },
  { key: 'co_complete', stage: 'COMPLETION', detail: 'Complete the transaction', col: 5, row: 2 },
  { key: 'pc_sdlt', stage: 'POST_COMPLETION', detail: 'Submit SDLT return & pay tax', col: 6, row: 0 },
  { key: 'pc_register', stage: 'POST_COMPLETION', detail: 'Register title & charge at HM Land Registry', col: 6, row: 1 },
  { key: 'pc_letter', stage: 'POST_COMPLETION', detail: 'Send completion letter & title info to client', col: 6, row: 2 },
];

/** Prerequisite edges (from → to): `to` is BLOCKED until `from` is DONE. */
export const DEFAULT_DEPS: ReadonlyArray<[string, string]> = [
  ['cp_request', 'cp_review'],
  ['se_order', 'se_review'],
  ['se_enquiries', 'se_review'],
  ['se_review', 'se_report'],
  ['cp_review', 'rs_send'],
  ['se_report', 'rs_send'],
  ['rs_send', 'rs_signed'],
  ['rs_signed', 'ex_exchange'],
  ['ex_date', 'ex_exchange'],
  ['rs_mortgage', 'ex_exchange'],
  ['ex_exchange', 'co_complete'],
  ['co_statement', 'co_complete'],
  ['co_funds', 'co_complete'],
  ['co_complete', 'pc_sdlt'],
  ['pc_sdlt', 'pc_register'],
  ['co_complete', 'pc_letter'],
];

/**
 * Highest-signal email triggers per stage (purchase + sale tracks merged) — the
 * "Key state transitions" tables in the doc. `bigLeapOk` marks the unambiguous
 * milestones (exchange / completion) that may jump more than two stages at once.
 */
export const STAGE_SIGNALS: ReadonlyArray<{ stage: string; re: RegExp; label: string; bigLeapOk?: boolean }> = [
  {
    stage: 'CONTRACT_PACK',
    re: /\b(contract (pack|bundle|papers)|draft contract (enclosed|attached|herewith)|ta6\b|ta10\b|ta7\b|protocol (forms|documents)|lpe1)/i,
    label: 'Contract pack in play',
  },
  {
    stage: 'SEARCHES_ENQUIRIES',
    re: /\b(searches? (ordered|submitted|applied for|results?|received|back))\b|\b(local (authority )?search|llc1|con29|drainage (and water )?search|environmental search)\b|\benquiries (raised|attached|enclosed|herewith)|additional enquiries/i,
    label: 'Searches / enquiries underway',
  },
  {
    stage: 'REVIEW_SIGNING',
    re: /\b(report on title|mortgage offer (received|issued|enclosed)|signed (contract|documents?) (enclosed|attached|returned)|deposit (received|now held)|ready to exchange)\b/i,
    label: 'Review & signing',
  },
  {
    stage: 'EXCHANGE',
    re: /\b(contracts? (have been |now |were )?exchanged|exchange (of contracts? )?(took place|has taken place|confirmed|completed)|we (have )?exchanged)\b/i,
    label: 'Exchange confirmed',
    bigLeapOk: true,
  },
  {
    stage: 'COMPLETION',
    re: /\b(completion (has )?(taken place|occurred)|completion monies (received|sent)|completed today|keys (have been |can be )?released|legal completion)\b/i,
    label: 'Completion confirmed',
    bigLeapOk: true,
  },
  {
    stage: 'POST_COMPLETION',
    re: /\b(sdlt (return|paid|submitted)|stamp duty (return|paid)|ltt return|ap1\b|os1\b|land registry application|registration (lodged|submitted|pending|completed)|ds1\b|discharge (of mortgage|received))\b/i,
    label: 'Post-completion formalities',
  },
];
