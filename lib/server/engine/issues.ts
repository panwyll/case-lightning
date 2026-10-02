/**
 * Issues: the things that go wrong on a real purchase and change what the matter needs
 * before it can move. The kind list is the practitioner's list (title, lease, planning,
 * searches, enquiries, funds/AML, mortgage, money, parties/chain, completion) built from
 * what buyers, sellers and conveyancers actually report (docs/engine-issues.md).
 *
 * An issue is not a sub-flow (nothing is ordered and extracted) and not a decision
 * (no AI summary of a source). It is a typed, person-raised situation with a lifecycle
 * (open → negotiating → resolved / withdrawn / fatal), a gate effect (which stage exit
 * it holds), a set of realistic resolutions, and effects on the rest of the machine
 * when it resolves (a price change, a lender that has to be told, an offer that has to
 * be re-issued). Everything is on the log like every other transition.
 *
 * Some kinds overlap with what the machine already does on its own (a delayed search is
 * chased by the search wait timer; an expiring offer is raised by the deadline timer).
 * They are still in the catalogue because a person needs a place to record that the
 * situation has become a problem for the plan — `overlaps` says what the machine already
 * covers so nothing is double-counted.
 */
import type { MessageParty, Stage } from './types';

export const ISSUE_GROUPS = ['title', 'leasehold', 'planning_regs', 'searches', 'enquiries', 'funds_aml', 'mortgage', 'money', 'parties_chain', 'property', 'completion', 'other'] as const;
export type IssueGroup = (typeof ISSUE_GROUPS)[number];
export const ISSUE_GROUP_LABEL: Record<IssueGroup, string> = {
  title: 'Title',
  leasehold: 'Leasehold',
  planning_regs: 'Planning & building regs',
  searches: 'Searches',
  enquiries: 'Enquiries',
  funds_aml: 'Source of funds & AML',
  mortgage: 'Mortgage',
  money: 'Deposit & completion money',
  parties_chain: 'Parties & chain',
  property: 'The property itself',
  completion: 'Completion',
  other: 'Other',
};

export const ISSUE_KINDS = [
  // case shapes (shapes.ts): the shape's own checklist, raised at enrolment
  'company_buyer_checks',
  'buy_to_let_conditions',
  'new_build_pack',
  'auction_conditions',
  'isa_bonus',
  'second_charge_consent',
  'shared_ownership_terms',
  'unrepresented_counterparty',
  'court_order_transfer',
  'right_to_buy_terms',
  'flying_freehold',
  'commonhold_terms',
  // tax
  'sdlt_basis',
  // ongoing CDD
  'cdd_refresh',
  // building safety
  'building_safety',
  // title
  'title_defect',
  'title_restriction',
  'missing_easement',
  'restrictive_covenant',
  'boundary_discrepancy',
  'missing_consent',
  // leasehold (v1 runs freehold; leasehold matters go to manual handling but the issue is still recorded)
  'lease_defect',
  'short_lease',
  'service_charge_issue',
  'ground_rent_issue',
  'freeholder_info_outstanding',
  // planning & regs
  'planning_permission_missing',
  'building_regs_missing',
  // searches
  'search_adverse_entry',
  'search_delayed',
  'search_out_of_date',
  // enquiries
  'enquiry_unanswered',
  'enquiry_unsatisfactory',
  // funds & AML
  'source_of_funds',
  'aml_kyc_problem',
  // mortgage
  'mortgage_offer_outstanding',
  'mortgage_condition_outstanding',
  'mortgage_offer_expiring',
  'mortgage_offer_expired',
  'mortgage_offer_expiry_unknown',
  'valuation_issue',
  'lender_approval',
  // money
  'deposit_issue',
  'completion_funds_shortfall',
  'lender_funds_delayed',
  'redemption_statement_expired',
  // parties & chain
  'chain_dependency',
  'seller_delay',
  'buyer_delay',
  'third_party_consent',
  'document_execution_problem',
  'occupier_consent',
  'probate_issue',
  'power_of_attorney_issue',
  'bankruptcy_insolvency',
  // the property itself
  'survey_defect',
  'environmental_risk',
  'third_party_encumbrance',
  'document_missing',
  'disclosure_concern',
  // completion
  'completion_failure',
  // survey / physical condition
  'survey_further_investigation',
  // said in an email or a note, never established by it
  'survey_report_outstanding',
  'transaction_at_risk',
  // a fact the case rests on changed, and something built on it must be done again (consequences.ts)
  'client_change',
  // a term of the draft contract the client must be advised on before exchange (findings.ts)
  'contract_term',
  // the seller's CGT position: a flag for the client's accountant (sdlt-facts.ts)
  'cgt_flag',
  // co-owners whose money and ownership do not match (co-owners.ts)
  'co_ownership_advice',
  // the seller may not be who they say (Dreamvar / P&P v Owen White: findings.ts)
  'seller_identity_risk',
  // joint clients whose instructions diverge (parties.md 2.5-2.10)
  'joint_client_conflict',
  // a client's complaint, on its eight-week clock (parties.md 8.4)
  'complaint',
  // a client under 18 (parties.md 1.2)
  'minor_party',
  // trustees as the client (parties.md 1.9)
  'trust_client',
  // a charity buying or selling (parties.md 1.11)
  'charity_terms',
  // a vulnerable client (parties.md 1.15)
  'vulnerable_client',
  // a sale between related people or at an undervalue (parties.md 1.20, 1.21)
  'related_party',
  // an introducer paid a fee (parties.md 1.18)
  'referral_fee',
  'mortgage_at_risk',
  'unknown_correspondent',
  'document_revised',
  'document_mismatch',
  'file_locked',
  'send_failed',
  'other',
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** Which stage exit an open blocking issue holds. */
export type IssueGate = 'exchange' | 'completion' | 'none';

export const ISSUE_STATUSES = ['open', 'negotiating', 'resolved', 'withdrawn', 'fatal'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/** The workstreams an issue can affect (the case model's concurrent lanes, docs/case-model.md). */
export const WORKSTREAMS = ['id_aml', 'source_of_funds', 'title', 'searches', 'enquiries', 'mortgage', 'survey', 'leasehold', 'contract', 'deposit', 'chain', 'report_on_title', 'co_ownership', 'property_forms', 'redemption', 'lender_consent', 'completion', 'registration', 'discharge'] as const;
export type Workstream = (typeof WORKSTREAMS)[number];

export const RESPONSIBLE_PARTIES = ['conveyancer', 'client', 'seller_side', 'lender', 'third_party', 'mlro'] as const;
export type ResponsibleParty = (typeof RESPONSIBLE_PARTIES)[number];

export const ISSUE_RESOLUTIONS = [
  'price_reduced',
  'buyer_covers_shortfall',
  'retention_agreed',
  'works_before_exchange',
  'indemnity_policy',
  'regularisation_certificate',
  'retrospective_consent',
  'consent_obtained',
  'specialist_report_clear',
  'evidence_provided',
  'deed_or_declaration',
  'deed_of_variation',
  'lease_extended',
  'restriction_complied',
  'document_reexecuted',
  'received',
  'offer_extended',
  'expiry_recorded',
  'sent_another_way',
  'condition_satisfied',
  'new_lender',
  'revaluation_upheld',
  'lender_confirmed',
  'chain_ready',
  'proceeding_confirmed',
  'grant_obtained',
  'attorney_verified',
  'insolvency_cleared',
  'deposit_agreed',
  'funds_in_place',
  'completed_late',
  'dates_replanned',
  'accepted_as_is',
  'other',
] as const;
export type IssueResolution = (typeof ISSUE_RESOLUTIONS)[number];

export interface IssueKindSpec {
  kind: IssueKind;
  group: IssueGroup;
  label: string;
  /** Where it typically comes from (the trigger a handler is reacting to). */
  arisesFrom: string;
  /** Default gate effect when raised (a person may override). */
  gate: IssueGate;
  /** Stages in which it is normally raised (informational; any enrolled stage before completion is accepted). */
  stages: Stage[];
  /** Resolutions that make sense for this kind (the machine refuses others). */
  resolutions: IssueResolution[];
  /** What the research says happens. */
  note: string;
  /** What the machine already does about this situation without an issue being raised. */
  overlaps?: string;
  /** Context, not a problem to solve: who is running late and why. It holds nothing and makes no task; it is on the file and in answers to "any update?". */
  context?: boolean;
  /** Behaviour (docs/case-model.md §5): default severity, the workstreams affected, the milestones threatened, the standard actions, who owns the next step, when it escalates. */
  severity: IssueSeverity;
  workstreams: Workstream[];
  threatens: Array<'exchange' | 'completion' | 'registration'>;
  actions: string[];
  responsible: ResponsibleParty;
  /** After this many working days without movement the severity is raised one step by the timer (null = the generic stale rule only). */
  escalateAfterWorkingDays: number | null;
}

const PRE: Stage[] = ['pre_contract', 'contract_review', 'pre_exchange'];
const PRE_ALL: Stage[] = ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'];
const POST_EX: Stage[] = ['exchanged', 'pre_completion'];

const KIND_SPECS_BASE: Array<Omit<IssueKindSpec, 'severity' | 'workstreams' | 'threatens' | 'actions' | 'responsible' | 'escalateAfterWorkingDays'>> = [
  // ── title ──
  { kind: 'title_defect', group: 'title', label: 'Title defect / discrepancy', arisesFrom: 'the register: possessory or qualified title, a missing deed, an unregistered part, an undated or unsigned deed, a name that does not match', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['indemnity_policy', 'deed_or_declaration', 'evidence_provided', 'document_reexecuted', 'accepted_as_is', 'other'], note: 'Rectified by indemnity, a statutory declaration, a deed of grant or first registration; these are the gaps HM Land Registry later requisitions on.' },
  { kind: 'title_restriction', group: 'title', label: 'Restriction on title', arisesFrom: 'a Form A / B / L restriction in the proprietorship register (co-owners, a management company, a lender, a s.106 or overage restriction) whose terms must be complied with before the transfer registers', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['restriction_complied', 'consent_obtained', 'deed_or_declaration', 'indemnity_policy', 'accepted_as_is', 'other'], note: 'The certificate or consent the restriction demands is often in a third party\'s hands (management company, chargee) — a classic slow item; HMLR rejects the AP1 without it.', overlaps: 'the title sub-flow flags the entry as a decision; the issue tracks getting what the restriction demands' },
  { kind: 'missing_easement', group: 'title', label: 'Missing easement / right', arisesFrom: 'no right of way over a private road or shared drive, no right for services (drains, pipes) across a neighbour\'s land, a CON29 2.1 "not adopted" answer', gate: 'exchange', stages: PRE, resolutions: ['deed_or_declaration', 'indemnity_policy', 'evidence_provided', 'accepted_as_is', 'other'], note: 'A lender may find the title unacceptable without a legal right of access; a deed of grant from the neighbour or a 20-year statutory declaration fixes it, an indemnity insures it.' },
  { kind: 'restrictive_covenant', group: 'title', label: 'Restrictive covenant', arisesFrom: 'the charges register (no alterations without consent, use restrictions, a covenant already breached by the extension)', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['indemnity_policy', 'retrospective_consent', 'deed_of_variation', 'accepted_as_is', 'other'], note: 'The trap: once the covenantee is asked for retrospective consent, an indemnity policy is no longer available because they know. Decide the route before anyone writes to them.' },
  { kind: 'boundary_discrepancy', group: 'title', label: 'Boundary discrepancy', arisesFrom: 'the title plan against the survey / the fence line / the estate agent\'s particulars; a strip of land in a neighbour\'s title', gate: 'exchange', stages: PRE, resolutions: ['deed_or_declaration', 'evidence_provided', 'indemnity_policy', 'price_reduced', 'accepted_as_is', 'other'], note: 'Usually resolved by a statutory declaration or a determined-boundary application later; a lender will want the land the house sits on to be in the title.' },
  { kind: 'missing_consent', group: 'title', label: 'Missing consent', arisesFrom: 'works or a use that needed a third party\'s consent under the title (landlord, management company, covenantee, estate rentcharge owner) and got none', gate: 'exchange', stages: PRE, resolutions: ['consent_obtained', 'retrospective_consent', 'indemnity_policy', 'accepted_as_is', 'other'], note: 'Same indemnity-versus-approach choice as a covenant breach.' },
  // ── leasehold ──
  { kind: 'lease_defect', group: 'leasehold', label: 'Lease defect', arisesFrom: 'a defective lease: no forfeiture-on-insolvency protection, missing repairing or insurance provisions, no rights over common parts', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['deed_of_variation', 'indemnity_policy', 'lender_confirmed', 'accepted_as_is', 'other'], note: 'Lenders (UK Finance Handbook) list what a lease must contain; a deed of variation needs the landlord and every lender to sign.', overlaps: 'leasehold tenure puts the matter into manual handling in v1; the issue records the defect' },
  { kind: 'short_lease', group: 'leasehold', label: 'Short lease', arisesFrom: 'an unexpired term below the lender\'s minimum (typically 70–85 years at completion) or approaching 80 years (marriage value)', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['lease_extended', 'price_reduced', 'new_lender', 'lender_confirmed', 'accepted_as_is', 'other'], note: 'A statutory extension takes months; the common route is the seller serving the s.42 notice and assigning the benefit on completion.' },
  { kind: 'service_charge_issue', group: 'leasehold', label: 'Service charge issue', arisesFrom: 'arrears, a disputed demand, a large planned major works bill, an unclear reserve fund in the management pack', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['retention_agreed', 'price_reduced', 'evidence_provided', 'accepted_as_is', 'other'], note: 'Retention from the price for the next demand is the usual fix; arrears must be cleared before the landlord will register the assignment.' },
  { kind: 'ground_rent_issue', group: 'leasehold', label: 'Ground rent issue', arisesFrom: 'escalating (doubling) ground rent, rent above £250 / £1,000 in London (assured tenancy risk), arrears', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['deed_of_variation', 'indemnity_policy', 'lender_confirmed', 'price_reduced', 'accepted_as_is', 'other'], note: 'Many lenders refuse doubling rents; a deed of variation from the freeholder or a lender-approved indemnity is the route.' },
  { kind: 'freeholder_info_outstanding', group: 'leasehold', label: 'Freeholder / managing-agent information outstanding', arisesFrom: 'the LPE1 / management pack not yet supplied (fees unpaid, agent slow), missing accounts, insurance or fire-risk assessment', gate: 'exchange', stages: ['pre_contract', 'contract_review', 'pre_exchange'], resolutions: ['received', 'accepted_as_is', 'other'], note: 'The single most-cited leasehold delay: packs take 2–8 weeks and the seller must pay for them; chase early, in writing.' },
  // ── planning & regs ──
  { kind: 'planning_permission_missing', group: 'planning_regs', label: 'Planning permission missing', arisesFrom: 'works with no decision notice (extension, conversion, change of use), a CON29 3.7 enforcement entry, a TA6 answer that contradicts the survey', gate: 'exchange', stages: PRE, resolutions: ['indemnity_policy', 'retrospective_consent', 'evidence_provided', 'works_before_exchange', 'price_reduced', 'accepted_as_is', 'other'], note: 'Enforcement is time-limited (4 years / 10 years, now 10 for most breaches) — an indemnity is available only if the authority has not been approached.' },
  { kind: 'building_regs_missing', group: 'planning_regs', label: 'Building-regs approval missing', arisesFrom: 'an extension, loft, knocked-through wall, new boiler or windows with no completion certificate / FENSA / Gas Safe', gate: 'exchange', stages: PRE, resolutions: ['indemnity_policy', 'regularisation_certificate', 'evidence_provided', 'retention_agreed', 'price_reduced', 'accepted_as_is', 'other'], note: 'One of the most common hold-ups. Lenders accept an indemnity or a regularisation certificate, but some insist on regularisation for structural or recent work; an indemnity needs lender approval (days to weeks).' },
  // ── searches ──
  { kind: 'search_adverse_entry', group: 'searches', label: 'Search adverse entry', arisesFrom: 'a search result the client or lender needs to act on: flood risk, contaminated land, a road scheme, a chancel liability, a mining report, no public sewer connection', gate: 'exchange', stages: PRE, resolutions: ['evidence_provided', 'specialist_report_clear', 'indemnity_policy', 'lender_confirmed', 'price_reduced', 'accepted_as_is', 'other'], note: 'Flood risk must be reported to the lender, who may withdraw; insurability is the practical test.', overlaps: 'the search sub-flow raises the flag as a decision; the issue tracks what the decision started (a further report, the lender\'s view)' },
  { kind: 'search_delayed', group: 'searches', label: 'Search delayed', arisesFrom: 'a local authority running weeks behind, a provider outage, a search that has to be re-ordered for freshness', gate: 'none', stages: PRE, resolutions: ['received', 'indemnity_policy', 'dates_replanned', 'accepted_as_is', 'other'], note: 'Search indemnity insurance is the usual workaround when a council is slow and the lender allows it.', overlaps: 'the search wait timer chases at day 10 and escalates at day 18; raise the issue when the delay changes the plan (indemnity, new target dates)' },
  { kind: 'search_out_of_date', group: 'searches', label: 'Search out of date', arisesFrom: 'a search result older than the lender allows (usually six months) before exchange', gate: 'exchange', stages: PRE, resolutions: ['received', 'lender_confirmed', 'indemnity_policy', 'accepted_as_is', 'other'], note: 'Most lenders will not lend on searches over six months old at exchange; re-order (or update) them, or get the lender\'s agreement or a no-search indemnity.' },
  // ── enquiries ──
  { kind: 'enquiry_unanswered', group: 'enquiries', label: 'Enquiry unanswered', arisesFrom: 'the other side has gone quiet: the seller\'s solicitor has not replied, or has replied to everything but the one that matters', gate: 'none', stages: PRE, resolutions: ['received', 'accepted_as_is', 'other'], note: 'The "enquiry stalemate" is the forum staple: weeks of "we are waiting for our client".', overlaps: 'the enquiry wait timer chases at day 5 and escalates at day 15' },
  { kind: 'enquiry_unsatisfactory', group: 'enquiries', label: 'Unsatisfactory enquiry response', arisesFrom: '"the buyer must rely on their own survey / searches", a refusal to give a statement of truth, an executor who will not answer', gate: 'exchange', stages: PRE, resolutions: ['received', 'evidence_provided', 'indemnity_policy', 'price_reduced', 'accepted_as_is', 'other'], note: 'Executors and attorneys legitimately cannot answer TA6 questions; the client is advised and decides.', overlaps: 'the enquiry sub-flow flags partial / refused replies as a decision; "request further" raises a tracked follow-up' },
  // ── funds & AML ──
  { kind: 'source_of_funds', group: 'funds_aml', label: 'Source-of-funds evidence outstanding', arisesFrom: 'a gifted deposit not declared early, an inheritance, crypto or overseas funds, savings with no paper trail', gate: 'exchange', stages: PRE_ALL, resolutions: ['evidence_provided', 'other'], note: 'The single most common self-inflicted delay: the gift is mentioned late and the donor is elderly or abroad; the lender must be told of a gift too.' },
  { kind: 'aml_kyc_problem', group: 'funds_aml', label: 'AML / KYC problem', arisesFrom: 'a referred or failed electronic check, a PEP or sanctions hit, an ID that will not verify, a client abroad who cannot be met', gate: 'exchange', stages: PRE_ALL, resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'Enhanced due diligence is a compliance decision; the matter cannot progress to money moving without it.', overlaps: 'the ID/AML sub-flow flags the provider result as a decision; rejecting it halts automation' },
  // ── mortgage ──
  { kind: 'mortgage_offer_outstanding', group: 'mortgage', label: 'Mortgage offer outstanding', arisesFrom: 'the application is stuck: underwriting queries, a valuation not yet booked, a broker waiting on documents', gate: 'exchange', stages: PRE, resolutions: ['received', 'new_lender', 'dates_replanned', 'other'], note: 'Nothing exchanges without the offer; the chain waits.', overlaps: 'mortgage.status = awaiting already blocks pre_contract; the issue is where the handler records why' },
  { kind: 'mortgage_condition_outstanding', group: 'mortgage', label: 'Mortgage condition outstanding', arisesFrom: 'a special condition on the offer: a retention, works, an occupier\'s consent, an indemnity approval, insurance, proof of deposit', gate: 'exchange', stages: PRE, resolutions: ['condition_satisfied', 'retention_agreed', 'lender_confirmed', 'evidence_provided', 'other'], note: 'Exchange with an unsatisfied condition risks funds not being released on the day.', overlaps: 'the mortgage sub-flow flags each special condition as a decision' },
  { kind: 'mortgage_offer_expiring', group: 'mortgage', label: 'Mortgage offer expiring', arisesFrom: 'the offer\'s expiry date closing in on a matter that is not ready to exchange', gate: 'none', stages: PRE, resolutions: ['offer_extended', 'received', 'dates_replanned', 'new_lender', 'other'], note: 'Lenders extend once, sometimes twice, for a few weeks; a re-issue means re-underwriting on today\'s rates.', overlaps: 'the deadline timer raises this 15 working days out; the issue tracks the extension request' },
  { kind: 'mortgage_offer_expired', group: 'mortgage', label: 'Mortgage offer expired', arisesFrom: 'the offer lapsed before exchange', gate: 'exchange', stages: PRE, resolutions: ['received', 'new_lender', 'other'], note: 'A fresh application, valuation and offer; rates may have moved.', overlaps: 'record mortgage_offer_withdrawn (the sub-flow reopens and blocks exchange); the issue tracks the re-application' },
  { kind: 'mortgage_offer_expiry_unknown', group: 'mortgage', label: 'Offer expiry date not known', arisesFrom: 'a mortgage offer read without an expiry date: the expiry warnings cannot run until it is known', gate: 'none', stages: PRE, resolutions: ['expiry_recorded', 'other'], note: 'Most offers run three to six months from issue; the date is on the offer itself or the lender\'s portal.' },
  { kind: 'valuation_issue', group: 'mortgage', label: 'Valuation issue', arisesFrom: 'a down-valuation below the agreed price, a valuer\'s retention or "further reports required" (roof, damp, timber), a nil valuation (spray foam, cladding, knotweed)', gate: 'exchange', stages: PRE, resolutions: ['price_reduced', 'buyer_covers_shortfall', 'new_lender', 'revaluation_upheld', 'specialist_report_clear', 'retention_agreed', 'accepted_as_is', 'other'], note: 'Options are renegotiate, make up the shortfall, a fresh valuation with another lender, or a challenge; a price change must be reported to the lender and can change the offer.' },
  { kind: 'lender_approval', group: 'mortgage', label: 'Lender approval needed', arisesFrom: 'anything the lender must be told: a price change, an indemnity policy, a retention, flood risk, a change of circumstances', gate: 'exchange', stages: PRE, resolutions: ['lender_confirmed', 'new_lender', 'other'], note: 'Raised automatically by the machine when a price change or an indemnity resolution needs the lender\'s confirmation; days to weeks in practice.' },
  // ── money ──
  { kind: 'deposit_issue', group: 'money', label: 'Deposit issue', arisesFrom: 'a deposit below 10%, a deposit funded by the sale in a chain, a deposit not yet in cleared funds, a gifted deposit not yet evidenced', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['deposit_agreed', 'funds_in_place', 'evidence_provided', 'other'], note: 'A reduced deposit needs the seller\'s agreement in the contract; a deposit "up the chain" is normal but must be agreed.' },
  { kind: 'completion_funds_shortfall', group: 'money', label: 'Completion funds shortfall', arisesFrom: 'the client balance is short of the completion statement: SDLT underestimated, a bonus or ISA not yet released, a sale proceeds shortfall in the chain', gate: 'completion', stages: ['pre_exchange', ...POST_EX], resolutions: ['funds_in_place', 'evidence_provided', 'other'], note: 'Before exchange it is a plan; after exchange it is a completion failure in waiting.' },
  { kind: 'lender_funds_delayed', group: 'money', label: 'Lender funds delayed', arisesFrom: 'the advance not released: the certificate of title sent late, a condition unsatisfied, the lender\'s cut-off missed', gate: 'completion', stages: POST_EX, resolutions: ['received', 'completed_late', 'other'], note: 'Most lenders need the COT 5 working days before completion; a late advance means late completion interest.', overlaps: 'the funds wait timer chases the lender from day 2' },
  { kind: 'redemption_statement_expired', group: 'money', label: 'Redemption statement out of date', arisesFrom: 'the redemption statement is only good until a date that falls before completion', gate: 'completion', stages: ['pre_exchange', 'exchanged', 'pre_completion'], resolutions: ['received', 'other'], note: 'Redeeming on a stale figure leaves the mortgage undischarged (interest accrues daily); ask the lender for a statement dated for completion.' },
  // ── parties & chain ──
  { kind: 'chain_dependency', group: 'parties_chain', label: 'Chain dependency', arisesFrom: 'the top or bottom of the chain is not ready: their management pack, their enquiries, their buyer pulled out, their mortgage', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['chain_ready', 'dates_replanned', 'other'], note: 'Agents say "ready" a week before solicitors are; a link dropping out costs ~10 weeks; the collapse is often discovered on exchange day.' },
  { kind: 'seller_delay', context: true, group: 'parties_chain', label: 'Seller delay', arisesFrom: 'the seller has not returned the protocol forms, signed the contract, provided documents, or instructed their solicitor on a point', gate: 'none', stages: PRE, resolutions: ['received', 'dates_replanned', 'accepted_as_is', 'other'], note: 'The commonest reason a matter sits: nothing is technically wrong, someone is just not doing it.' },
  { kind: 'buyer_delay', context: true, group: 'parties_chain', label: 'Buyer delay', arisesFrom: 'our own client: survey not booked, documents not returned, the deposit not sent, the mortgage application not made', gate: 'none', stages: PRE_ALL, resolutions: ['received', 'dates_replanned', 'other'], note: 'Record it so the file shows who was waiting for whom.' },
  { kind: 'company_buyer_checks', group: 'funds_aml', label: 'Company buyer checks', arisesFrom: 'the buyer is a company (enrolment shape): Companies House, directors and PSCs, authority to buy, the company\'s source of funds', gate: 'exchange', stages: ['instruction', ...PRE], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'Treat every director and PSC as a client for identity; the company\'s own money is the source of funds.' },
  { kind: 'buy_to_let_conditions', group: 'mortgage', label: 'Buy-to-let conditions', arisesFrom: 'a buy-to-let purchase (enrolment shape): the offer\'s rental cover and letting conditions, a sitting tenancy, deposit protection, licensing', gate: 'exchange', stages: ['instruction', ...PRE], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'A sitting tenant needs the lender\'s consent and the tenancy papers before exchange; higher-rate SDLT applies.' },
  { kind: 'new_build_pack', group: 'property', label: 'New build pack', arisesFrom: 'a new build (enrolment shape): the developer\'s contract, warranty cover note, planning and building regulations, roads and sewers agreements, CIL, completion on notice', gate: 'exchange', stages: ['instruction', ...PRE], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'The developer sets the exchange deadline; the lender will not lend without the warranty.' },
  { kind: 'auction_conditions', group: 'other', label: 'Auction conditions', arisesFrom: 'an auction sale or purchase (enrolment shape): the legal pack, the special conditions, the deposit at the fall of the hammer, the completion deadline', gate: 'exchange', stages: ['instruction', ...PRE], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'The hammer is the exchange: everything the buyer needs to know is known before the auction or not at all.' },
  { kind: 'isa_bonus', group: 'money', label: 'ISA bonus', arisesFrom: 'a Lifetime ISA or Help to Buy ISA (enrolment shape): the declarations, the eligibility limits and the bonus paid to us by the ISA manager', gate: 'completion', stages: ['instruction', ...PRE, ...POST_EX], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'The ISA manager pays within 30 days of the declaration; the money is for completion, not the exchange deposit.' },
  { kind: 'third_party_consent', group: 'parties_chain', label: 'Third-party consent required', arisesFrom: 'a landlord\'s licence to assign, a management company\'s consent, a chargee\'s consent to a transfer, a Help to Buy redemption / consent, a shared-ownership provider', gate: 'exchange', stages: PRE, resolutions: ['consent_obtained', 'accepted_as_is', 'other'], note: 'Third parties work to their own clock and fee; a Help to Buy redemption needs a RICS valuation and 4–6 weeks.' },
  { kind: 'document_execution_problem', group: 'parties_chain', label: 'Document execution problem', arisesFrom: 'a deed signed but not witnessed, a witness who is a party, a wrong name, an electronic signature the other side or HMLR will not accept, a signatory abroad', gate: 'exchange', stages: ['contract_review', 'pre_exchange', ...POST_EX], resolutions: ['document_reexecuted', 'evidence_provided', 'other'], note: 'Re-execution is the only fix and takes as long as the post takes.' },
  { kind: 'occupier_consent', group: 'parties_chain', label: 'Occupier consent required', arisesFrom: 'an adult occupier (partner, adult child, lodger) who must sign a consent / deed of postponement for the lender', gate: 'exchange', stages: PRE, resolutions: ['consent_obtained', 'condition_satisfied', 'other'], note: 'A standard mortgage condition; the occupier is advised separately.' },
  { kind: 'probate_issue', group: 'parties_chain', label: 'Probate issue', arisesFrom: 'the grant not yet issued, executors not all signing, an intestacy, a sale by a personal representative before the grant', gate: 'exchange', stages: PRE, resolutions: ['grant_obtained', 'evidence_provided', 'other'], note: 'Everything but exchange can proceed before the grant; the grant itself can take 12 weeks to many months.' },
  { kind: 'power_of_attorney_issue', group: 'parties_chain', label: 'Power-of-attorney issue', arisesFrom: 'an LPA not registered, a donor whose capacity is in doubt, an attorney signing beyond their authority, an unregistered general power', gate: 'exchange', stages: PRE, resolutions: ['attorney_verified', 'evidence_provided', 'other'], note: 'HMLR and lenders want the registered LPA (or certified copy) and evidence it is still valid.' },
  { kind: 'bankruptcy_insolvency', group: 'parties_chain', label: 'Bankruptcy / insolvency issue', arisesFrom: 'a K16 bankruptcy search hit against the buyer, a seller with a bankruptcy restriction on the title, a company seller in liquidation', gate: 'exchange', stages: PRE, resolutions: ['insolvency_cleared', 'evidence_provided', 'other'], note: 'A hit against a borrower stops the lender; a trustee in bankruptcy must sign for an insolvent seller.' },
  // ── the property itself ──
  { kind: 'survey_defect', group: 'property', label: 'Survey defect', arisesFrom: 'the client\'s survey (damp, roof, subsidence, electrics, asbestos, timber, knotweed, spray foam)', gate: 'exchange', stages: PRE, resolutions: ['price_reduced', 'works_before_exchange', 'retention_agreed', 'specialist_report_clear', 'accepted_as_is', 'other'], note: 'Most renegotiations settle at 1–5% off; lenders may impose a retention (knotweed, spray foam); the seller may refuse and the buyer walks.' },
  { kind: 'environmental_risk', group: 'property', label: 'Environmental risk', arisesFrom: 'environmental / flood / mining / radon reports the client and lender must accept', gate: 'exchange', stages: PRE, resolutions: ['evidence_provided', 'lender_confirmed', 'specialist_report_clear', 'price_reduced', 'accepted_as_is', 'other'], note: 'Flood risk must be reported to the lender, who may withdraw; insurability is the practical test.' },
  { kind: 'third_party_encumbrance', group: 'property', label: 'Third-party arrangement', arisesFrom: 'a solar-panel roof lease, a septic tank (general binding rules), overage, a s.106, a rentcharge, a guarantee that must be assigned', gate: 'exchange', stages: PRE, resolutions: ['evidence_provided', 'lender_confirmed', 'works_before_exchange', 'indemnity_policy', 'accepted_as_is', 'other'], note: 'A solar lease must be assignable and lender-acceptable; a non-compliant septic tank must be replaced or the price reflect it.' },
  { kind: 'document_missing', group: 'property', label: 'Document missing', arisesFrom: 'FENSA / gas / electrical certificates, guarantees, the EPC, planning decision notices the seller cannot find', gate: 'exchange', stages: PRE, resolutions: ['received', 'evidence_provided', 'indemnity_policy', 'accepted_as_is', 'other'], note: 'Often ends in a cheap indemnity or acceptance; sometimes the first sign of a bigger regs problem.' },
  { kind: 'disclosure_concern', group: 'property', label: 'Disclosure concern', arisesFrom: 'TA6 answers that contradict the survey or searches, an undisclosed neighbour dispute, a complaint history, a death at the property', gate: 'exchange', stages: PRE, resolutions: ['evidence_provided', 'price_reduced', 'accepted_as_is', 'other'], note: 'Misrepresentation exposure after completion; further enquiries first, then advice.' },
  // ── completion ──
  { kind: 'completion_failure', group: 'completion', label: 'Completion failure', arisesFrom: 'lender funds late, the CHAPS cut-off missed, chain money not through, keys not released, a removal van on the drive and no money', gate: 'completion', stages: ['pre_completion'], resolutions: ['completed_late', 'funds_in_place', 'other'], note: 'Late-completion interest under the standard conditions; a notice to complete if it slips further.' },
  { kind: 'survey_report_outstanding', group: 'property', label: 'Survey done, report not on file', arisesFrom: 'the client or the agent says the survey has been carried out, but no report has been filed', gate: 'none', stages: PRE, resolutions: ['received', 'accepted_as_is', 'other'], note: 'Raised from an email or a note. The surveyor reports to the client, not to us: ask the client for it. Nothing about the physical condition is recorded until the report itself is on file and read.' },
  { kind: 'minor_party', group: 'parties_chain', label: "Client under 18", arisesFrom: "a date of birth on the ID, or the enrolment answer", gate: 'exchange', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], resolutions: ['evidence_provided', 'other'], note: "A minor cannot hold a legal estate: a transfer to them takes effect as a declaration of trust. Adults hold on trust for them, or the purchase waits." },
  { kind: 'trust_client', group: 'funds_aml', label: "Trust as client", arisesFrom: "trustees buying or selling", gate: 'exchange', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], resolutions: ['evidence_provided', 'other'], note: "Two or more trustees identified, the trust deed seen, the beneficial owners identified and the Trust Registration Service entry checked (MLR 2017 reg 30A)." },
  { kind: 'charity_terms', group: 'parties_chain', label: "Charity", arisesFrom: "a charity as seller or buyer", gate: 'exchange', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], resolutions: ['evidence_provided', 'other'], note: "Charities Act 2011 s.122 statements in the contract and transfer; on a sale the trustees' report from a qualified surveyor (s.119) and the best terms reasonably obtainable." },
  { kind: 'vulnerable_client', group: 'parties_chain', label: "Vulnerable client", arisesFrom: "age, illness, bereavement, language, someone else driving the transaction", gate: 'exchange', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: "Record the vulnerability and the adjustments (how we contact them, plain letters, seeing them alone, an interpreter); check for undue influence." },
  { kind: 'related_party', group: 'funds_aml', label: "Related-party sale", arisesFrom: "buyer and seller are family, employer and employee, landlord and tenant; or the price is under value", gate: 'exchange', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], resolutions: ['lender_confirmed', 'evidence_provided', 'accepted_as_is', 'other'], note: "Tell the lender (non-arm's-length; any gifted equity is the deposit); SDLT on what is actually given; independent advice for the seller where pressure is possible; at an undervalue, the insolvency risk if the seller goes bankrupt within five years (title insurance)." },
  { kind: 'referral_fee', group: 'other', label: "Referral fee", arisesFrom: "an agent, broker or introducer paid for the introduction", gate: 'exchange', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], resolutions: ['evidence_provided', 'other'], note: "The fee and who pays it disclosed to the client in writing before we act; the client's interests are not affected (SRA Code 5.1)." },
  { kind: 'complaint', group: 'other', label: 'Complaint', arisesFrom: 'a client says they are unhappy with the service, the cost or the outcome', gate: 'none', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'Acknowledge it, investigate under the firm\'s procedure and reply in writing within eight weeks; the final letter names the Legal Ombudsman and its time limits.' },
  { kind: 'joint_client_conflict', group: 'parties_chain', label: 'Joint clients disagree', arisesFrom: 'one joint client authorises exchange and another withdraws it, or they separate and want different things', gate: 'exchange', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'Joint clients have no confidentiality from each other. If their instructions cannot be reconciled we may have to stop acting for one or both (SRA Code 6.2); nothing exchanges until both instruct the same thing.' },
  { kind: 'seller_identity_risk', group: 'funds_aml', label: 'Seller identity risk', arisesFrom: "the register's red flags for seller impersonation: no mortgage, the owner's address elsewhere or abroad, owned for many years", gate: 'exchange', stages: ['pre_contract', 'contract_review', 'pre_exchange'], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: "Ask the seller's solicitor how they verified their client's identity and ownership (and check the firm on the SRA register); the buyer's firm is liable if the money goes to an impostor (Dreamvar)." },
  { kind: 'co_ownership_advice', group: 'parties_chain', label: 'Co-ownership advice', arisesFrom: 'buyers putting in unequal money but holding as joint tenants', gate: 'exchange', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'], resolutions: ['accepted_as_is', 'evidence_provided', 'other'], note: 'Joint tenants: the survivor takes all on a death, and on a split each is presumed to own half (Stack v Dowden). Advise tenants in common with a declaration of trust, or record that they have chosen joint tenancy knowing this.' },
  { kind: 'cgt_flag', group: 'other', label: 'Capital Gains Tax flag', arisesFrom: "the seller's answers: not their main home throughout, or not UK resident", gate: 'none', stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], resolutions: ['accepted_as_is', 'other'], note: 'Never advice and never a figure: tell the client in writing that a 60-day report and payment may be due and to speak to their accountant.' },
  { kind: 'contract_term', group: 'parties_chain', label: 'Contract term', arisesFrom: 'a special condition that changes the standard bargain: late-completion compensation excluded, a short notice to complete, no requisitions, the buyer relying on its own survey, a conditional contract, a sale "as seen"', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['deed_of_variation', 'lender_confirmed', 'accepted_as_is', 'other'], note: 'Ask for it to be amended or struck out; if it stays, advise the client in writing before they sign and tell the lender where it touches the security.' },
  { kind: 'client_change', group: 'parties_chain', label: 'Change to the clients', arisesFrom: 'a client added or taken off the case, before or after exchange: the contract and transfer parties, the lender, the funds and the tax all rest on who the clients are', gate: 'exchange', stages: ['instruction', ...PRE, ...POST_EX], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'Before exchange: amend the draft contract and the TR1, re-take instructions on how they will own it. After exchange: the contract binds every original buyer, so a change needs the seller\'s agreement (a deed of variation or assignment) and the lender\'s consent.' },
  { kind: 'transaction_at_risk', group: 'parties_chain', label: 'Transaction at risk', arisesFrom: 'someone says a party is pulling out, the chain has broken or the sale has fallen through', gate: 'exchange', stages: PRE, resolutions: ['proceeding_confirmed', 'chain_ready', 'dates_replanned', 'accepted_as_is', 'other'], note: 'Raised from an email or a note. Confirm with the solicitors, never on an agent\'s word alone. Abandoning the file is a separate, deliberate step a person takes.' },
  { kind: 'mortgage_at_risk', group: 'mortgage', label: 'Mortgage at risk', arisesFrom: 'a change in the client\'s circumstances (job, income, credit) or word that the lender is reconsidering', gate: 'exchange', stages: PRE, resolutions: ['lender_confirmed', 'new_lender', 'offer_extended', 'accepted_as_is', 'other'], note: 'Raised from an email or a note. A material change must be reported to the lender before exchange; exchanging on an offer that is about to be withdrawn is the classic disaster.' },
  { kind: 'document_revised', group: 'other', label: 'Revised document', arisesFrom: 'a new version of a document already read on the case (a revised contract, re-issued search, updated replies, an edited file in the case folder) that the system could not simply re-apply because that step had moved on', gate: 'none', stages: PRE, resolutions: ['accepted_as_is', 'evidence_provided', 'other'], note: 'Revisions are normal. The new version is filed, read and compared with the one it replaces; what changed is shown on the Documents tab. A person decides what the change means.' },
  { kind: 'unknown_correspondent', group: 'parties_chain', label: 'Someone not on the file wrote in', arisesFrom: 'an email on the case from an address the case does not know: a spouse, a relative, a new agent, a scammer', gate: 'none', stages: PRE, resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'Never buried: it is put to a person every time. Nothing they say counts as the client\'s until the client confirms it, and bank details from an unknown address are the classic fraud.' },
  { kind: 'survey_further_investigation', group: 'property', label: 'Further investigation recommended', arisesFrom: 'the survey (or a specialist report) recommends a further specialist investigation before exchange: damp, timber, drainage, structural, electrical, roof', gate: 'exchange', stages: PRE, resolutions: ['specialist_report_clear', 'accepted_as_is', 'price_reduced', 'retention_agreed', 'works_before_exchange', 'other'], note: 'Raised automatically from the survey facts, one per recommendation. A specialist report that finds nothing resolves it (a fact); the client\'s satisfaction with the property is a separate client decision.' },
  { kind: 'document_mismatch', group: 'other', label: 'Documents disagree', arisesFrom: 'the same fact (price, names, address, title number, lender, completion date) reading differently on two documents or against the case record', gate: 'exchange', stages: ['instruction', ...PRE, ...POST_EX], resolutions: [...ISSUE_RESOLUTIONS], note: 'A cross-check the register runs after every read; resolves itself when the documents agree again.' },
  { kind: 'second_charge_consent', group: 'mortgage', label: 'Second charge / equity loan', arisesFrom: 'an enrolment shape: a Help to Buy equity loan, a shared-equity or a second lender behind the first charge; the first lender must consent and the second charge is postponed', gate: 'completion', stages: ['instruction', ...PRE, ...POST_EX], resolutions: ['lender_confirmed', 'evidence_provided', 'other'], note: 'Both lenders\' consents, the deed of postponement and the second charge\'s own deed before completion; report the second loan under the first lender\'s instructions.' },
  { kind: 'shared_ownership_terms', group: 'leasehold', label: 'Shared ownership lease', arisesFrom: 'an enrolment shape: a housing association shared-ownership lease (the share bought, rent on the rest, staircasing, the nomination / pre-emption on sale, the lender\'s mortgagee protection clause)', gate: 'exchange', stages: ['instruction', ...PRE], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'The lease must be the model form with the mortgagee protection clause; the provider\'s approval of the buyer and of the lender; rent and service charge from completion.' },
  { kind: 'unrepresented_counterparty', group: 'parties_chain', label: 'Unrepresented other side', arisesFrom: 'an enrolment shape: the buyer or seller on the other side has no solicitor', gate: 'exchange', stages: ['instruction', ...PRE], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'No undertakings can be taken; identify the other party against their title (HMLR PG 67); the lender must be told; no advice may be given to them.' },
  { kind: 'court_order_transfer', group: 'parties_chain', label: 'Transfer under a court order', arisesFrom: 'an enrolment shape: a transfer of equity on divorce, dissolution or separation under a court order', gate: 'completion', stages: ['instruction', 'pre_contract', 'pre_completion'], resolutions: ['evidence_provided', 'lender_confirmed', 'accepted_as_is', 'other'], note: 'The sealed order on file; the lender releases the outgoing owner or a remortgage is needed; SDLT exemption recorded with its reason; independent advice for the outgoing owner.' },
  { kind: 'right_to_buy_terms', group: 'title', label: 'Right to Buy discount', arisesFrom: 'an enrolment shape: a property bought under the Right to Buy within the last five years (discount repayment charge) or ten years (right of first refusal to the landlord)', gate: 'exchange', stages: ['instruction', ...PRE], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'The discount is repaid on a sale within five years (tapering); within ten years the former landlord must be offered the property first; both appear as a charge and a restriction on the title.' },
  { kind: 'flying_freehold', group: 'title', label: 'Flying freehold', arisesFrom: 'an enrolment shape or the title: part of the property is over or under land in another title', gate: 'exchange', stages: ['instruction', ...PRE], resolutions: ['indemnity_policy', 'deed_or_declaration', 'lender_confirmed', 'accepted_as_is', 'other'], note: 'The lender\'s Part 2 usually sets a maximum proportion and requires mutual rights of support, protection and access, or an indemnity policy.' },
  { kind: 'commonhold_terms', group: 'title', label: 'Commonhold', arisesFrom: 'an enrolment shape: a commonhold unit with a commonhold community statement and association', gate: 'exchange', stages: ['instruction', ...PRE], resolutions: ['evidence_provided', 'lender_confirmed', 'accepted_as_is', 'other'], note: 'Few lenders lend on commonhold; the community statement, the association\'s accounts and the commonhold assessment take the place of the lease and the pack.' },
  { kind: 'sdlt_basis', group: 'money', label: 'SDLT basis', arisesFrom: 'the client\'s declaration at enrolment: first-time buyer relief, the higher rates for an additional property, the non-UK resident surcharge', gate: 'none', stages: ['instruction', ...PRE, ...POST_EX], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'Confirm the basis against the facts before the return; the client signs the return\'s declaration.' },
  { kind: 'cdd_refresh', group: 'funds_aml', label: 'CDD refresh due', arisesFrom: 'a client identified more than a year ago on a matter still open (LSAG 6.21 ongoing monitoring)', gate: 'none', stages: ['instruction', ...PRE, ...POST_EX], resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'Re-check the electronic verification, confirm the address, refresh sanctions and PEP screening; record it.' },
  { kind: 'building_safety', group: 'leasehold', label: 'Building Safety Act', arisesFrom: 'the management pack: a relevant building (11 m / 5 storeys) without a leaseholder deed of certificate or landlord\'s certificate, or with remediation outstanding', gate: 'exchange', stages: ['pre_contract', 'contract_review', 'pre_exchange'], resolutions: ['evidence_provided', 'lender_confirmed', 'accepted_as_is', 'other'], note: 'The lender will need the certificates (and possibly an EWS1) before it lends; the buyer inherits the leaseholder protections only if the certificate chain is intact.' },
  { kind: 'file_locked', group: 'other', label: 'Password-protected file', arisesFrom: 'a PDF that arrived password-protected (bank statements, ID scans, reports); the password usually comes separately, by email, text or phone', gate: 'none', stages: ['instruction', ...PRE, ...POST_EX], resolutions: ['evidence_provided', 'other'], note: 'Nothing can be read from it until it is unlocked; the unlocked copy is kept, the password is not.' },
  { kind: 'send_failed', group: 'other', label: 'Message could not be sent', arisesFrom: 'an email, WhatsApp message, form or order the engine or a person tried to send and the mailbox or provider refused (an expired Microsoft 365 connection, no address on the case, a provider outage)', gate: 'none', stages: ['instruction', ...PRE, ...POST_EX], resolutions: ['sent_another_way', 'evidence_provided', 'accepted_as_is', 'other'], note: 'Never silent: the failure is a task with the fix and the message to send by hand.' },
  { kind: 'other', group: 'other', label: 'Other', arisesFrom: 'anything else the handler needs the matter to wait for', gate: 'exchange', stages: ['instruction', ...PRE, ...POST_EX], resolutions: [...ISSUE_RESOLUTIONS], note: '' },
];

/** Behaviour per kind (docs/case-model.md §5). Severity / escalation / owner / actions are the MLRO's and the head of conveyancing's to tune. */
const BEHAVIOUR: Record<IssueKind, { severity: IssueSeverity; workstreams: Workstream[]; threatens: Array<'exchange' | 'completion' | 'registration'>; actions: string[]; responsible: ResponsibleParty; escalateAfterWorkingDays: number | null }> = {
  title_defect: { severity: 'warning', workstreams: ['title'], threatens: ['exchange', 'registration'], actions: ['Identify the defect precisely against the register', 'Decide the route: indemnity, rectification, statutory declaration, first registration', 'Raise the enquiry / request the deed', 'Report to the lender if the title is unacceptable'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  title_restriction: { severity: 'warning', workstreams: ['title'], threatens: ['exchange', 'registration'], actions: ['Read the restriction\'s terms', 'Request the certificate / consent the restriction demands', 'Chase the third party', 'Check the AP1 will not be rejected'], responsible: 'seller_side', escalateAfterWorkingDays: 10 },
  missing_easement: { severity: 'warning', workstreams: ['title'], threatens: ['exchange'], actions: ['Establish who owns the servient land', 'Request a deed of grant or a statutory declaration', 'Quote an indemnity policy', 'Report to the lender'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  restrictive_covenant: { severity: 'warning', workstreams: ['title'], threatens: ['exchange'], actions: ['Decide indemnity versus consent BEFORE anyone approaches the covenantee', 'Quote the indemnity', 'Report to the lender'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  boundary_discrepancy: { severity: 'warning', workstreams: ['title', 'survey'], threatens: ['exchange'], actions: ['Compare the title plan with the survey and the particulars', 'Raise the enquiry', 'Consider a statutory declaration or a determined-boundary application', 'Advise the client'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  missing_consent: { severity: 'warning', workstreams: ['title', 'leasehold'], threatens: ['exchange'], actions: ['Identify whose consent was needed', 'Decide indemnity versus retrospective consent', 'Request / quote'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  lease_defect: { severity: 'warning', workstreams: ['leasehold', 'title'], threatens: ['exchange'], actions: ['Check the lease against the UK Finance Handbook requirements', 'Request a deed of variation or quote an indemnity', 'Report to the lender'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  short_lease: { severity: 'critical', workstreams: ['leasehold', 'mortgage'], threatens: ['exchange'], actions: ['Confirm the unexpired term', 'Check the lender\'s minimum', 'Advise on a s.42 notice served by the seller and assigned on completion', 'Renegotiate if needed'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  service_charge_issue: { severity: 'warning', workstreams: ['leasehold'], threatens: ['exchange'], actions: ['Get the demands and accounts', 'Agree a retention for planned works', 'Confirm arrears are cleared before completion'], responsible: 'seller_side', escalateAfterWorkingDays: 10 },
  ground_rent_issue: { severity: 'warning', workstreams: ['leasehold', 'mortgage'], threatens: ['exchange'], actions: ['Read the review clause', 'Check lender acceptability', 'Request a deed of variation or quote an indemnity'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  freeholder_info_outstanding: { severity: 'warning', workstreams: ['leasehold'], threatens: ['exchange'], actions: ['Chase the seller\'s solicitor for the pack', 'Confirm the fee has been paid', 'Ask for the managing agent\'s expected date'], responsible: 'seller_side', escalateAfterWorkingDays: 10 },
  planning_permission_missing: { severity: 'warning', workstreams: ['searches', 'title'], threatens: ['exchange'], actions: ['Check the planning register', 'Establish the date of the works and the enforcement window', 'Decide indemnity versus retrospective consent BEFORE approaching the authority', 'Report to the lender'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  building_regs_missing: { severity: 'warning', workstreams: ['searches', 'survey'], threatens: ['exchange'], actions: ['Ask for the completion certificate / FENSA / Gas Safe', 'Quote an indemnity or a regularisation certificate', 'Report to the lender; some insist on regularisation'], responsible: 'seller_side', escalateAfterWorkingDays: 10 },
  search_adverse_entry: { severity: 'warning', workstreams: ['searches'], threatens: ['exchange'], actions: ['Read the entry against the property', 'Obtain a specialist report or an indemnity', 'Report to the lender where required (flood)', 'Advise the client'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  search_delayed: { severity: 'info', workstreams: ['searches'], threatens: ['exchange'], actions: ['Chase the provider / council', 'Consider search indemnity if the lender allows', 'Re-plan target dates'], responsible: 'third_party', escalateAfterWorkingDays: 5 },
  search_out_of_date: { severity: 'warning', workstreams: ['searches'], threatens: ['exchange'], actions: ['Re-order or update the search', 'Or get the lender\'s agreement / a no-search indemnity'], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  redemption_statement_expired: { severity: 'warning', workstreams: ['redemption'], threatens: ['completion'], actions: ['Ask the lender for a redemption statement dated for completion'], responsible: 'conveyancer', escalateAfterWorkingDays: 3 },
  enquiry_unanswered: { severity: 'info', workstreams: ['enquiries'], threatens: ['exchange'], actions: ['Chase the seller\'s solicitor in writing', 'Escalate to the agent', 'Re-plan target dates'], responsible: 'seller_side', escalateAfterWorkingDays: 5 },
  enquiry_unsatisfactory: { severity: 'warning', workstreams: ['enquiries'], threatens: ['exchange'], actions: ['Raise the further enquiry', 'Obtain the evidence another way (search, indemnity)', 'Advise the client and record their decision'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  source_of_funds: { severity: 'warning', workstreams: ['source_of_funds'], threatens: ['exchange'], actions: ['Send / re-send the proof-of-funds form', 'Query the unusual transactions', 'Record the MLRO\'s view for EDD cases'], responsible: 'client', escalateAfterWorkingDays: 5 },
  company_buyer_checks: { severity: 'warning', workstreams: ['id_aml', 'source_of_funds'], threatens: ['exchange'], actions: ['Companies House check and filing history', 'Identity of every director and PSC', 'Board resolution and signatories', 'The company\'s source of funds'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  buy_to_let_conditions: { severity: 'warning', workstreams: ['mortgage', 'contract'], threatens: ['exchange'], actions: ['Confirm the offer is a buy-to-let product and its conditions', 'Tenancy, deposit protection and right-to-rent papers for a sitting tenant', 'Licensing check with the council', 'Higher-rate SDLT on the statement'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  new_build_pack: { severity: 'warning', workstreams: ['contract', 'title'], threatens: ['exchange'], actions: ['Warranty cover note on file', 'Planning, building regulations, roads and sewers agreements, CIL', 'Long-stop date and completion-on-notice terms reported to the client and lender', 'Exchange by the developer\'s deadline'], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  auction_conditions: { severity: 'warning', workstreams: ['contract', 'searches', 'title'], threatens: ['exchange'], actions: ['Legal pack reviewed and reported before the auction', 'Special conditions, fees and premium explained to the client', 'Deposit and completion deadline diarised'], responsible: 'conveyancer', escalateAfterWorkingDays: 3 },
  isa_bonus: { severity: 'warning', workstreams: ['deposit', 'completion'], threatens: ['completion'], actions: ['Eligibility confirmed against the scheme limits', 'Investor declaration signed; conveyancer declaration or bonus claim sent', 'Bonus received on client account before completion'], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  aml_kyc_problem: { severity: 'critical', workstreams: ['id_aml'], threatens: ['exchange'], actions: ['Obtain the further identity evidence', 'Enhanced due diligence where required', 'MLRO decision; consider reporting obligations'], responsible: 'mlro', escalateAfterWorkingDays: 5 },
  mortgage_offer_outstanding: { severity: 'warning', workstreams: ['mortgage'], threatens: ['exchange'], actions: ['Chase the broker / lender', 'Establish what the underwriter is waiting for', 'Re-plan target dates'], responsible: 'client', escalateAfterWorkingDays: 5 },
  mortgage_condition_outstanding: { severity: 'warning', workstreams: ['mortgage'], threatens: ['exchange', 'completion'], actions: ['Satisfy the condition and report to the lender', 'Confirm the lender is content before exchange'], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  mortgage_offer_expiring: { severity: 'warning', workstreams: ['mortgage'], threatens: ['exchange', 'completion'], actions: ['Contact the broker / lender', 'Determine the extension requirements and timing', 'Plan exchange and completion inside the offer, or start a re-issue'], responsible: 'client', escalateAfterWorkingDays: 3 },
  mortgage_offer_expired: { severity: 'critical', workstreams: ['mortgage'], threatens: ['exchange', 'completion'], actions: ['Fresh application, valuation and offer', 'Tell the chain the timetable has moved'], responsible: 'client', escalateAfterWorkingDays: 3 },
  mortgage_offer_expiry_unknown: { severity: 'warning', workstreams: ['mortgage'], threatens: ['exchange', 'completion'], actions: ['Read the expiry date from the offer or the lender\'s portal', 'Record it'], responsible: 'conveyancer', escalateAfterWorkingDays: 3 },
  valuation_issue: { severity: 'warning', workstreams: ['mortgage', 'survey'], threatens: ['exchange'], actions: ['Get the valuation figure and the reason', 'Renegotiate, top up, challenge, or move lender', 'Report a price change to the lender'], responsible: 'client', escalateAfterWorkingDays: 5 },
  lender_approval: { severity: 'warning', workstreams: ['mortgage'], threatens: ['exchange'], actions: ['Report to the lender through the panel portal', 'Chase for confirmation the offer stands'], responsible: 'lender', escalateAfterWorkingDays: 5 },
  deposit_issue: { severity: 'warning', workstreams: ['deposit'], threatens: ['exchange'], actions: ['Agree a reduced deposit or a deposit up the chain in the contract', 'Confirm cleared funds before exchange'], responsible: 'client', escalateAfterWorkingDays: 5 },
  completion_funds_shortfall: { severity: 'critical', workstreams: ['completion', 'deposit'], threatens: ['completion'], actions: ['Recalculate the completion statement', 'Establish where the shortfall is coming from and evidence it', 'Warn the chain if completion may move'], responsible: 'client', escalateAfterWorkingDays: 2 },
  lender_funds_delayed: { severity: 'critical', workstreams: ['completion', 'mortgage'], threatens: ['completion'], actions: ['Chase the lender\'s completions team', 'Check the certificate of title and the conditions', 'Warn the seller\'s solicitor'], responsible: 'lender', escalateAfterWorkingDays: 1 },
  minor_party: { severity: 'critical', workstreams: ['contract'], threatens: ['exchange'], actions: ["Confirm the date of birth", "Restructure: adults take the legal title on trust for the minor, or wait", "Tell the lender (it will not lend to a minor)"], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  trust_client: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange'], actions: ["See the trust deed and the trustees' power to buy or sell", "Identify every trustee and the beneficial owners", "Check the Trust Registration Service entry"], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  charity_terms: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange'], actions: ["Check the charity's register entry and its power", "Get the s.119 surveyor's report (a sale)", "Put the s.122 statements in the contract and transfer"], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  vulnerable_client: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange'], actions: ["Record the adjustments agreed with the client", "See the client alone at least once and note it", "Check instructions are the client's own"], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  related_party: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange'], actions: ["Tell the lender and get its confirmation", "Record the real consideration for SDLT", "Advise on independent advice and the undervalue risk"], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  referral_fee: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange'], actions: ["Disclose the fee to the client in writing", "Record the client's acknowledgment"], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  complaint: { severity: 'warning', workstreams: ['contract'], threatens: ['completion'], actions: ['Acknowledge the complaint in writing', "Investigate under the firm's complaints procedure (a person not involved, where possible)", 'Reply in full within eight weeks, naming the Legal Ombudsman'], responsible: 'conveyancer', escalateAfterWorkingDays: 40 },
  joint_client_conflict: { severity: 'critical', workstreams: ['contract'], threatens: ['exchange', 'completion'], actions: ['Speak to each client: tell both what the other has said (no confidentiality between joint clients)', 'If they cannot agree, consider whether we can act for either (SRA Code 6.2)', 'Record both instructions in writing'], responsible: 'conveyancer', escalateAfterWorkingDays: 2 },
  seller_identity_risk: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange'], actions: ["Ask the seller's solicitor how they verified their client's identity and title (an enquiry)", "Check the seller's solicitor on the SRA register / Lawyer Checker", 'Record what was done before the deposit is sent'], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  co_ownership_advice: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange'], actions: ['Explain joint tenancy and tenancy in common to every buyer, separately if their interests differ', 'Offer a declaration of trust recording who put in what', 'Record their decision and the advice in writing'], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  cgt_flag: { severity: 'info', workstreams: ['completion'], threatens: ['completion'], actions: ['Tell the client in writing: a CGT report and payment may be due within 60 days of completion', 'Suggest they speak to their accountant now'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  contract_term: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange'], actions: ['Ask for the condition to be amended or struck out', 'If it stays, advise the client in writing before they sign', 'Tell the lender if it touches the security'], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  client_change: { severity: 'critical', workstreams: ['contract'], threatens: ['exchange', 'completion'], actions: ['Amend the draft contract and the transfer (TR1) to the new parties', 'Take instructions from every client on how they will own it', 'Agree the change with the other side (after exchange: a deed of variation or assignment)'], responsible: 'conveyancer', escalateAfterWorkingDays: 3 },
  chain_dependency: { severity: 'warning', workstreams: ['chain'], threatens: ['exchange', 'completion'], actions: ['Get the chain position from the agents', 'Confirm with the solicitors, not the agents', 'Re-plan target dates'], responsible: 'third_party', escalateAfterWorkingDays: 5 },
  seller_delay: { severity: 'info', workstreams: ['chain', 'enquiries'], threatens: ['exchange'], actions: ['Chase the seller\'s solicitor', 'Escalate via the agent'], responsible: 'seller_side', escalateAfterWorkingDays: 5 },
  buyer_delay: { severity: 'info', workstreams: ['chain'], threatens: ['exchange'], actions: ['Tell the client what is waiting on them and by when'], responsible: 'client', escalateAfterWorkingDays: 5 },
  third_party_consent: { severity: 'warning', workstreams: ['leasehold', 'title'], threatens: ['exchange'], actions: ['Apply for the consent with the fee', 'Chase the third party', 'Re-plan target dates'], responsible: 'third_party', escalateAfterWorkingDays: 10 },
  document_execution_problem: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange', 'completion', 'registration'], actions: ['Re-execute with a proper witness', 'Allow for the post'], responsible: 'client', escalateAfterWorkingDays: 3 },
  occupier_consent: { severity: 'warning', workstreams: ['mortgage'], threatens: ['exchange'], actions: ['Identify every adult occupier', 'Have the consent signed with separate advice'], responsible: 'client', escalateAfterWorkingDays: 5 },
  probate_issue: { severity: 'warning', workstreams: ['chain', 'title'], threatens: ['exchange'], actions: ['Confirm the grant has been applied for and the expected date', 'Progress everything else', 'Re-plan target dates'], responsible: 'seller_side', escalateAfterWorkingDays: 15 },
  power_of_attorney_issue: { severity: 'warning', workstreams: ['title', 'id_aml'], threatens: ['exchange', 'registration'], actions: ['Obtain the registered LPA / certified copy', 'Verify the attorney', 'Confirm the lender accepts'], responsible: 'seller_side', escalateAfterWorkingDays: 10 },
  bankruptcy_insolvency: { severity: 'critical', workstreams: ['id_aml', 'title'], threatens: ['exchange'], actions: ['Establish whether the hit is our client', 'Trustee\'s signature / discharge evidence', 'Report to the lender'], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  survey_defect: { severity: 'warning', workstreams: ['survey'], threatens: ['exchange'], actions: ['Get the surveyor\'s estimate', 'Renegotiate or agree works / retention', 'Record the client\'s decision'], responsible: 'client', escalateAfterWorkingDays: 5 },
  environmental_risk: { severity: 'warning', workstreams: ['searches'], threatens: ['exchange'], actions: ['Obtain the further report', 'Check insurability', 'Report to the lender'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  third_party_encumbrance: { severity: 'warning', workstreams: ['title', 'searches'], threatens: ['exchange'], actions: ['Get the agreement / lease', 'Check assignability and lender acceptability', 'Advise the client'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  document_missing: { severity: 'info', workstreams: ['enquiries'], threatens: ['exchange'], actions: ['Ask the seller', 'Quote an indemnity', 'Advise the client'], responsible: 'seller_side', escalateAfterWorkingDays: 10 },
  disclosure_concern: { severity: 'warning', workstreams: ['enquiries'], threatens: ['exchange'], actions: ['Raise the specific further enquiry', 'Advise the client on misrepresentation', 'Record the client\'s decision'], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  completion_failure: { severity: 'critical', workstreams: ['completion'], threatens: ['completion'], actions: ['Establish where the money is', 'Agree the new time / date with the other side', 'Calculate late-completion interest', 'Consider a notice to complete'], responsible: 'conveyancer', escalateAfterWorkingDays: 1 },
  survey_report_outstanding: { severity: 'info', workstreams: ['survey'], threatens: ['exchange'], actions: ['Ask the client for the report (the surveyor sends it to them, not to us)', 'File it when it arrives; it is read automatically', 'Record nothing about the physical condition until the report is on file'], responsible: 'client', escalateAfterWorkingDays: 5 },
  transaction_at_risk: { severity: 'critical', workstreams: ['chain'], threatens: ['exchange', 'completion'], actions: ['Confirm the position with the other side\'s solicitor, not the agent', 'Tell the client and record what they want to do', 'Stop incurring disbursements until it is clear', 'Abandon the file only as a deliberate step'], responsible: 'conveyancer', escalateAfterWorkingDays: 2 },
  mortgage_at_risk: { severity: 'warning', workstreams: ['mortgage'], threatens: ['exchange'], actions: ['Ask the client exactly what changed and when', 'Confirm with the broker whether the offer stands', 'Report the change to the lender if an offer is issued', 'Do not exchange until the lender confirms'], responsible: 'client', escalateAfterWorkingDays: 3 },
  document_revised: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange'], actions: ['Open the new version and read what changed (Documents: Since The Last Read)', 'Decide whether the change affects advice, enquiries or the report', 'Tell the client if it does'], responsible: 'conveyancer', escalateAfterWorkingDays: 3 },
  unknown_correspondent: { severity: 'info', workstreams: ['id_aml'], threatens: ['exchange'], actions: ['Work out who they are and set their role on the case contacts', 'Treat nothing they say as the client\'s until the client confirms it', 'Verify by phone before acting on any instruction or bank details from them'], responsible: 'conveyancer', escalateAfterWorkingDays: 3 },
  survey_further_investigation: { severity: 'warning', workstreams: ['survey'], threatens: ['exchange'], actions: ['Instruct the specialist named by the surveyor', 'File the report when it arrives (it is read automatically)', 'Put the outcome to the client'], responsible: 'client', escalateAfterWorkingDays: 10 },
  document_mismatch: { severity: 'warning', workstreams: ['contract'], threatens: ['exchange'], actions: ['Open both sources at the cited pages', 'Decide which is right and have the other corrected', 'Record the outcome'], responsible: 'conveyancer', escalateAfterWorkingDays: 5 },
  second_charge_consent: { severity: 'warning', workstreams: ['mortgage', 'completion'], threatens: ['completion'], actions: ['Report the second loan to the first lender', 'Obtain both consents and the deed of postponement', 'Second charge deed executed'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  shared_ownership_terms: { severity: 'warning', workstreams: ['leasehold', 'title'], threatens: ['exchange'], actions: ['Check the lease is the model form with the mortgagee protection clause', 'Provider\'s approval of the buyer and the lender', 'Advise on rent, staircasing and the resale nomination'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  unrepresented_counterparty: { severity: 'warning', workstreams: ['chain', 'id_aml'], threatens: ['exchange'], actions: ['Verify the other party against the title', 'Tell the lender', 'Plan for no undertakings on the day'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  right_to_buy_terms: { severity: 'warning', workstreams: ['title', 'completion'], threatens: ['exchange', 'completion'], actions: ['Find the discount repayment charge and the pre-emption restriction on the title', 'Work out the repayable discount at the completion date', 'Offer the property to the former landlord if inside ten years'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  flying_freehold: { severity: 'warning', workstreams: ['title', 'mortgage'], threatens: ['exchange'], actions: ['Measure the flying part against the lender\'s limit', 'Check the title for rights of support, protection and access', 'Quote an indemnity policy'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  commonhold_terms: { severity: 'warning', workstreams: ['title', 'mortgage'], threatens: ['exchange'], actions: ['Obtain the commonhold community statement and the association\'s accounts', 'Confirm the lender lends on commonhold'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  court_order_transfer: { severity: 'warning', workstreams: ['title', 'completion'], threatens: ['completion'], actions: ['Sealed copy of the order on file', "Lender's release of the outgoing owner, or a remortgage", 'sdlt_not_required recorded with the exemption', 'Independent advice for the outgoing owner'], responsible: 'conveyancer', escalateAfterWorkingDays: 10 },
  sdlt_basis: { severity: 'info', workstreams: ['completion'], threatens: ['registration'], actions: ['Check every buyer against the relief or surcharge conditions', 'Confirm the figure with the client before the return'], responsible: 'conveyancer', escalateAfterWorkingDays: null },
  cdd_refresh: { severity: 'info', workstreams: ['id_aml'], threatens: ['completion'], actions: ['Re-run electronic verification', 'Refresh PEP / sanctions screening', 'Record the review'], responsible: 'conveyancer', escalateAfterWorkingDays: null },
  building_safety: { severity: 'warning', workstreams: ['leasehold', 'mortgage'], threatens: ['exchange'], actions: ['Obtain the leaseholder deed of certificate and the landlord\'s certificate', 'Ask the lender what it requires (EWS1, remediation evidence)', 'Advise the client on the protections'], responsible: 'seller_side', escalateAfterWorkingDays: 10 },
  file_locked: { severity: 'warning', workstreams: [], threatens: [], actions: [], responsible: 'conveyancer', escalateAfterWorkingDays: 2 },
  send_failed: { severity: 'warning', workstreams: [], threatens: [], actions: [], responsible: 'conveyancer', escalateAfterWorkingDays: 2 },
  other: { severity: 'warning', workstreams: [], threatens: ['exchange'], actions: [], responsible: 'conveyancer', escalateAfterWorkingDays: null },
};

/** Kinds that are context: they never hold a gate or make a task. */
export const isContextKind = (kind: string): boolean => !!KIND_SPECS_BASE.find((k) => k.kind === kind && (k as { context?: boolean }).context);
export const ISSUE_KIND_SPECS: IssueKindSpec[] = KIND_SPECS_BASE.map((k) => ({ ...k, ...BEHAVIOUR[k.kind] }));

/** Time-based issues the timer raises itself (docs/case-model.md §6). */
export const MORTGAGE_EXPIRY_WARNING_DAYS = 30;
export const MORTGAGE_EXPIRY_CRITICAL_DAYS = 14;

export const ISSUE_KIND_SPEC: Record<IssueKind, IssueKindSpec> = Object.fromEntries(ISSUE_KIND_SPECS.map((s) => [s.kind, s])) as Record<IssueKind, IssueKindSpec>;

export const RESOLUTION_LABEL: Record<IssueResolution, string> = {
  price_reduced: 'price reduced',
  buyer_covers_shortfall: 'buyer makes up the shortfall',
  retention_agreed: 'retention agreed',
  works_before_exchange: 'works done by the seller before exchange',
  indemnity_policy: 'indemnity policy obtained',
  regularisation_certificate: 'regularisation certificate obtained',
  retrospective_consent: 'retrospective consent obtained',
  consent_obtained: 'consent obtained',
  specialist_report_clear: 'specialist report satisfactory',
  evidence_provided: 'evidence / documents provided',
  sent_another_way: 'sent another way (post, by hand or our own mailbox)',
  deed_or_declaration: 'deed or statutory declaration obtained',
  deed_of_variation: 'deed of variation completed',
  lease_extended: 'lease extended (or extension assigned)',
  restriction_complied: 'restriction complied with (certificate / consent)',
  document_reexecuted: 'document re-executed',
  received: 'received (the awaited thing arrived)',
  offer_extended: 'offer extended by the lender',
  expiry_recorded: 'offer expiry date recorded',
  condition_satisfied: 'condition satisfied',
  new_lender: 'new lender / fresh valuation',
  revaluation_upheld: 'valuation challenged and upheld',
  lender_confirmed: 'lender confirmed the offer stands',
  chain_ready: 'chain confirmed ready',
  proceeding_confirmed: 'the other side confirmed they are proceeding',
  grant_obtained: 'grant of probate obtained',
  attorney_verified: 'attorney\'s authority verified',
  insolvency_cleared: 'insolvency cleared (trustee / discharge / not our client)',
  deposit_agreed: 'deposit arrangement agreed in the contract',
  funds_in_place: 'funds in place',
  completed_late: 'completed late',
  dates_replanned: 'target dates re-planned',
  accepted_as_is: 'client accepts as is (advised in writing)',
  other: 'other (see note)',
};

/** Resolutions that change the price (the machine records price_changed). */
export const PRICE_RESOLUTIONS: ReadonlySet<IssueResolution> = new Set(['price_reduced']);
/** Resolutions a lender must be told about on a lender-funded purchase (the machine raises a lender_approval issue). */
export const LENDER_NOTIFY_RESOLUTIONS: ReadonlySet<IssueResolution> = new Set(['price_reduced', 'indemnity_policy', 'retention_agreed']);
/** Resolutions that reopen the mortgage sub-flow (the current offer no longer applies). */
export const REOPENS_OFFER: ReadonlySet<IssueResolution> = new Set(['new_lender']);

/** What abandonment reason an issue of this group implies when it proves fatal (a person may override). */
export const FATAL_ABANDON_REASON_BY_GROUP: Record<IssueGroup, 'client_withdrew' | 'seller_withdrew' | 'chain_collapsed' | 'gazumped' | 'survey' | 'finance_failed' | 'conflict' | 'other'> = {
  title: 'other',
  leasehold: 'other',
  planning_regs: 'survey',
  searches: 'survey',
  enquiries: 'other',
  funds_aml: 'finance_failed',
  mortgage: 'finance_failed',
  money: 'finance_failed',
  parties_chain: 'chain_collapsed',
  property: 'survey',
  completion: 'other',
  other: 'other',
};

/** The name of an outcome on a button or a picker. */
export const RESOLUTION_TITLE: Record<IssueResolution, string> = {
  price_reduced: 'Price Reduced',
  buyer_covers_shortfall: 'Buyer Covers The Shortfall',
  retention_agreed: 'Retention Agreed',
  works_before_exchange: 'Seller Did The Works',
  indemnity_policy: 'Indemnity Policy',
  regularisation_certificate: 'Regularisation Certificate',
  retrospective_consent: 'Retrospective Consent',
  consent_obtained: 'Consent Obtained',
  specialist_report_clear: 'Specialist Report Clear',
  evidence_provided: 'Evidence Provided',
  sent_another_way: 'Sent Another Way',
  deed_or_declaration: 'Deed Or Declaration',
  deed_of_variation: 'Deed Of Variation',
  lease_extended: 'Lease Extended',
  restriction_complied: 'Restriction Complied With',
  document_reexecuted: 'Document Re-Executed',
  received: 'Received',
  offer_extended: 'Offer Extended',
  expiry_recorded: 'Expiry Recorded',
  condition_satisfied: 'Condition Satisfied',
  new_lender: 'New Lender',
  revaluation_upheld: 'Valuation Upheld',
  lender_confirmed: 'Lender Confirmed',
  chain_ready: 'Chain Ready',
  proceeding_confirmed: 'They Are Proceeding',
  grant_obtained: 'Grant Obtained',
  attorney_verified: 'Attorney Verified',
  insolvency_cleared: 'Insolvency Cleared',
  deposit_agreed: 'Deposit Agreed',
  funds_in_place: 'Funds In Place',
  completed_late: 'Completed Late',
  dates_replanned: 'Dates Re-Planned',
  accepted_as_is: 'Accepted As Is',
  other: 'Other',
};

/**
 * What each outcome asks for when someone records it: the form differs by outcome, and the
 * machine refuses a person's resolution missing a required field. `cost` and `newPrice` land on
 * the issue's cost and the price; `paidBy` is who paid; everything else is kept on the event.
 * A `document` is a file on the case (picked, or uploaded there and then).
 */
export type ResolutionFieldType = 'money' | 'date' | 'text' | 'lender' | 'document' | 'confirm' | 'payer' | 'channel';
export interface ResolutionField { key: string; label: string; type: ResolutionFieldType; required: boolean }
const f = (key: string, label: string, type: ResolutionFieldType, required = true): ResolutionField => ({ key, label, type, required });
const PAYER = f('paidBy', 'Paid By', 'payer');
export const RESOLUTION_FIELDS: Record<IssueResolution, ResolutionField[]> = {
  price_reduced: [f('newPrice', 'New Price', 'money')],
  buyer_covers_shortfall: [f('cost', 'Shortfall', 'money')],
  retention_agreed: [f('cost', 'Retention', 'money'), f('releasedWhen', 'Released When', 'text'), PAYER],
  works_before_exchange: [f('works', 'Works Done', 'text'), f('documentId', 'Evidence', 'document', false), f('cost', 'Cost', 'money', false), f('paidBy', 'Paid By', 'payer', false)],
  indemnity_policy: [f('insurer', 'Insurer', 'text'), f('cost', 'Premium', 'money'), PAYER, f('documentId', 'Policy', 'document', false)],
  regularisation_certificate: [f('documentId', 'Certificate', 'document'), f('cost', 'Fee', 'money', false), f('paidBy', 'Paid By', 'payer', false)],
  retrospective_consent: [f('documentId', 'Consent', 'document'), f('cost', 'Fee', 'money', false), f('paidBy', 'Paid By', 'payer', false)],
  consent_obtained: [f('documentId', 'Consent', 'document'), f('cost', 'Fee', 'money', false), f('paidBy', 'Paid By', 'payer', false)],
  specialist_report_clear: [f('documentId', 'Report', 'document')],
  evidence_provided: [f('documentId', 'Evidence', 'document')],
  deed_or_declaration: [f('documentId', 'Deed Or Declaration', 'document'), f('cost', 'Cost', 'money', false), f('paidBy', 'Paid By', 'payer', false)],
  deed_of_variation: [f('documentId', 'Deed Of Variation', 'document'), f('cost', 'Cost', 'money', false), f('paidBy', 'Paid By', 'payer', false)],
  lease_extended: [f('newTerm', 'New Term', 'text'), f('cost', 'Premium', 'money', false), f('paidBy', 'Paid By', 'payer', false)],
  restriction_complied: [f('documentId', 'Certificate Or Consent', 'document')],
  document_reexecuted: [f('documentId', 'Re-Executed Document', 'document')],
  received: [f('documentId', 'What Arrived', 'document', false)],
  offer_extended: [f('newExpiry', 'New Expiry', 'date')],
  expiry_recorded: [f('newExpiry', 'Expiry Date', 'date')],
  sent_another_way: [f('how', 'How It Went', 'channel'), f('documentId', 'Copy Of What Was Sent', 'document', false)],
  condition_satisfied: [f('documentId', 'Evidence', 'document', false)],
  new_lender: [f('lender', 'New Lender', 'lender')],
  revaluation_upheld: [f('valuation', 'Valuation', 'money')],
  lender_confirmed: [f('documentId', "Lender's Confirmation", 'document', false)],
  chain_ready: [],
  proceeding_confirmed: [f('documentId', 'Their Confirmation', 'document', false)],
  grant_obtained: [f('documentId', 'Grant', 'document')],
  attorney_verified: [f('documentId', 'Registered LPA', 'document')],
  insolvency_cleared: [f('documentId', 'Evidence', 'document')],
  deposit_agreed: [f('deposit', 'Deposit Agreed', 'money')],
  funds_in_place: [f('documentId', 'Evidence', 'document', false)],
  completed_late: [],
  dates_replanned: [f('targetExchangeDate', 'Target Exchange', 'date', false), f('targetCompletionDate', 'Target Completion', 'date', false)],
  accepted_as_is: [f('advised', 'Client Advised In Writing', 'confirm')],
  other: [],
};
/** Kinds closed by their own action (Try Again, the password), not by the resolve form. */
export const FORMLESS_KINDS: ReadonlySet<IssueKind> = new Set(['file_locked']);
/** Outcomes whose note is required (the only record of what happened). */
export const NOTE_REQUIRED: ReadonlySet<IssueResolution> = new Set(['other', 'accepted_as_is']);
/** What recording the outcome does to the rest of the case, in a few words. */
export const RESOLUTION_EFFECT: Partial<Record<IssueResolution, string>> = {
  price_reduced: 'Updates the price',
  indemnity_policy: 'Adds a task to tell the lender',
  retention_agreed: 'Adds a task to tell the lender',
  new_lender: 'Sets the current offer aside',
  offer_extended: 'Moves the offer expiry',
  expiry_recorded: 'Sets the offer expiry',
  sent_another_way: 'Records it as sent, so the case moves on as if we had sent it',
  dates_replanned: 'Moves the target dates',
};
/** The working days an issue of this kind is given to be sorted, when nobody sets a date. */
export const resolveWithinWorkingDays = (kind: IssueKind): number => ISSUE_KIND_SPEC[kind]?.escalateAfterWorkingDays ?? 10;

/** A kind's name on a chip: short, Title Case. */
export const ISSUE_CHIP: Record<IssueKind, string> = {
  minor_party: "Minor", trust_client: "Trust", charity_terms: "Charity", vulnerable_client: "Vulnerable", related_party: "Related Party", referral_fee: "Referral Fee", client_change: 'Client Change', contract_term: 'Contract Term', cgt_flag: 'CGT Flag', co_ownership_advice: 'Co-Ownership', seller_identity_risk: 'Seller Identity', joint_client_conflict: 'Client Conflict', complaint: 'Complaint',
  company_buyer_checks: 'Company Buyer', buy_to_let_conditions: 'Buy To Let', new_build_pack: 'New Build', auction_conditions: 'Auction', isa_bonus: 'ISA Bonus',
  second_charge_consent: 'Second Charge', shared_ownership_terms: 'Shared Ownership', unrepresented_counterparty: 'Unrepresented', court_order_transfer: 'Court Order',
  right_to_buy_terms: 'Right To Buy', flying_freehold: 'Flying Freehold', commonhold_terms: 'Commonhold', sdlt_basis: 'SDLT', cdd_refresh: 'CDD Refresh',
  building_safety: 'Building Safety', title_defect: 'Title', title_restriction: 'Restriction', missing_easement: 'Easement', restrictive_covenant: 'Covenant',
  boundary_discrepancy: 'Boundary', missing_consent: 'Consent', lease_defect: 'Lease', short_lease: 'Short Lease', service_charge_issue: 'Service Charge',
  ground_rent_issue: 'Ground Rent', freeholder_info_outstanding: 'Management Pack', planning_permission_missing: 'Planning', building_regs_missing: 'Building Regs',
  search_adverse_entry: 'Search', search_delayed: 'Search Delayed', enquiry_unanswered: 'Enquiry', enquiry_unsatisfactory: 'Enquiry', source_of_funds: 'Source Of Funds',
  aml_kyc_problem: 'AML', mortgage_offer_outstanding: 'Mortgage Offer', mortgage_condition_outstanding: 'Mortgage Condition', mortgage_offer_expiring: 'Offer Expiring',
  mortgage_offer_expired: 'Offer Expired', mortgage_offer_expiry_unknown: 'Offer Expiry', search_out_of_date: 'Search Out Of Date', redemption_statement_expired: 'Redemption Statement', valuation_issue: 'Valuation', lender_approval: 'Tell The Lender', deposit_issue: 'Deposit',
  completion_funds_shortfall: 'Shortfall', lender_funds_delayed: 'Lender Funds', chain_dependency: 'Chain', seller_delay: 'Seller Delay', buyer_delay: 'Buyer Delay',
  third_party_consent: 'Consent', document_execution_problem: 'Signing', occupier_consent: 'Occupier', probate_issue: 'Probate', power_of_attorney_issue: 'Attorney',
  bankruptcy_insolvency: 'Insolvency', survey_defect: 'Survey', environmental_risk: 'Environmental', third_party_encumbrance: 'Encumbrance', document_missing: 'Missing Document',
  disclosure_concern: 'Disclosure', completion_failure: 'Completion', survey_further_investigation: 'Further Investigation', survey_report_outstanding: 'Survey Report',
  transaction_at_risk: 'At Risk', mortgage_at_risk: 'Mortgage At Risk', unknown_correspondent: 'Unknown Sender', document_revised: 'Revised Document',
  document_mismatch: 'Mismatch', file_locked: 'Locked File', send_failed: 'Unsuccessful', other: 'Issue',
};

/**
 * What a person does about an issue, from the issue itself (docs/spec/issues.md "Next steps"):
 * write to someone (drafted from the case, edited, sent, logged on the issue), agree new dates,
 * mark it negotiating, or say it has fallen through. Every issue has at least one, so the form is
 * never just an outcome picker.
 */
export type IssueStep =
  | { id: string; kind: 'message'; to: MessageParty; label: string; /** What the message must do (the drafter's brief). */ purpose: string; /** The same, as a sentence, when there is no drafter; `{issue}` is the issue's title. */ sentence: string }
  | { id: 'dates'; kind: 'dates'; label: string }
  | { id: 'negotiating'; kind: 'negotiating'; label: string }
  | { id: 'fatal'; kind: 'fatal'; label: string };

const msg = (to: MessageParty, label: string, purpose: string, sentence: string): IssueStep => ({ id: `msg:${to}:${label.toLowerCase().replace(/[^a-z]+/g, '_')}`, kind: 'message', to, label, purpose, sentence });
const ASK_OTHER_SIDE = msg('seller_solicitor', 'Write To The Other Side', 'Raise the issue with the other side and ask how and when they will resolve it', 'We write regarding {issue}. Please let us know how and when your client will resolve it.');
const UPDATE_CLIENT = msg('client', 'Update The Client', 'Tell the client about the issue plainly, what we are doing about it and when they will next hear from us', 'A point has come up on your transaction: {issue}. We are dealing with it and will update you as soon as we have more.');
const ASK_CLIENT = msg('client', 'Ask The Client', 'Tell the client about the point the buyer\'s side has raised and ask them for what we need to answer it', 'The buyer\'s solicitor has raised a point on your sale: {issue}. Please let us have what you have on this (any documents or information) so we can answer it.');
const TELL_OTHER_SIDE = msg('seller_solicitor', 'Update The Other Side', 'Tell the other side we are taking our client\'s instructions on the point and will come back to them', 'We write regarding {issue}. We are taking our client\'s instructions and will come back to you.');
const DATES: IssueStep = { id: 'dates', kind: 'dates', label: 'Agree New Dates' };
const NEGOTIATING: IssueStep = { id: 'negotiating', kind: 'negotiating', label: 'Mark Negotiating' };
const FATAL: IssueStep = { id: 'fatal', kind: 'fatal', label: 'It Has Fallen Through' };

const STEPS_BY_KIND: Partial<Record<IssueKind, IssueStep[]>> = {
  transaction_at_risk: [
    msg('seller_solicitor', 'Ask The Other Side Where Their Client Stands', "Ask the other side's solicitor to confirm in writing whether their client is still proceeding, and if so on what timescale", 'We have been told your client may not be proceeding. Please confirm in writing whether they are still proceeding and, if so, on what timescale.'),
    msg('client', 'Update The Client', 'Tell the client what we have been told, that we are confirming it with the other side\'s solicitor today, and that we will come back to them as soon as we hear; ask them not to incur further costs (such as a survey or mortgage fees) until it is clear', 'We have been told the other side may not be proceeding. We are confirming this with their solicitor today and will come back to you as soon as we hear. Please do not incur any further costs until it is clear.'),
    msg('estate_agent', 'Tell The Agent', 'Tell the estate agent what we have been told and ask what they know of the other party\'s position', 'We have been told the other party may not be proceeding. Please let us know what you know of their position.'),
    DATES, NEGOTIATING, FATAL,
  ],
  mortgage_at_risk: [
    msg('lender', 'Ask The Lender Or Broker', 'Ask the lender or broker whether the mortgage offer stands, and if not what is needed to reinstate it', 'Please confirm whether the mortgage offer on this purchase still stands and, if not, what is needed.'),
    msg('client', 'Ask The Client What Has Changed', 'Ask the client what has changed with their mortgage and whether they have another lender or broker in mind', 'We understand there may be a problem with your mortgage. Please let us know what has changed and whether you are looking at another lender.'),
    DATES, FATAL,
  ],
  mortgage_offer_expiring: [
    msg('lender', 'Ask The Lender For An Extension', 'Ask the lender or broker to extend the mortgage offer beyond the expected completion date', 'The mortgage offer expires before the expected completion date. Please extend it.'),
    msg('client', 'Tell The Client', 'Tell the client the offer expires before the expected completion date and that we have asked the lender to extend it', 'Your mortgage offer expires before the expected completion date; we have asked the lender to extend it.'),
    DATES,
  ],
  mortgage_offer_expired: [
    msg('lender', 'Ask The Lender For An Extension', 'Ask the lender or broker to extend or reissue the expired mortgage offer', 'The mortgage offer has expired. Please extend or reissue it.'),
    msg('client', 'Tell The Client', 'Tell the client the mortgage offer has expired, that we cannot complete on it, and that we have asked the lender to extend or reissue it', 'Your mortgage offer has expired and we cannot complete on it; we have asked the lender to extend or reissue it.'),
    DATES, FATAL,
  ],
  mortgage_offer_expiry_unknown: [
    msg('lender', 'Ask The Lender For The Expiry', 'Ask the lender or broker for the date the mortgage offer expires', 'Please confirm the date the mortgage offer expires.'),
  ],
  seller_delay: [
    msg('seller_solicitor', 'Ask For Their Timescale', "Ask the other side's solicitor for their client's realistic timescale to exchange and complete", "Please let us know your client's realistic timescale to exchange and complete."),
    UPDATE_CLIENT, DATES,
  ],
  buyer_delay: [
    msg('seller_solicitor', 'Ask For Their Timescale', "Ask the other side's solicitor for their client's realistic timescale to exchange and complete", "Please let us know your client's realistic timescale to exchange and complete."),
    UPDATE_CLIENT, DATES,
  ],
  chain_dependency: [
    msg('seller_solicitor', 'Ask Where The Chain Stands', "Ask the other side's solicitor where the rest of the chain stands and when it will be ready to exchange", 'Please let us know where the rest of the chain stands and when it will be ready to exchange.'),
    UPDATE_CLIENT, DATES, FATAL,
  ],
  completion_failure: [
    msg('seller_solicitor', 'Agree A New Completion Time', "Tell the other side's solicitor completion did not happen as agreed and ask to agree a new completion time", 'Completion has not taken place as agreed. Please contact us to agree a new completion time.'),
    msg('client', 'Tell The Client', 'Tell the client completion has been delayed, why, and what we are doing to agree a new time', 'Completion has been delayed; we are agreeing a new time with the other side and will confirm it to you.'),
    DATES,
  ],
  redemption_statement_expired: [
    msg('lender', 'Ask For A Fresh Statement', 'Ask the lender for a fresh redemption statement to the expected completion date', 'Please send a fresh redemption statement to the expected completion date.'),
  ],
  lender_funds_delayed: [
    msg('lender', 'Chase The Lender', 'Ask the lender when the mortgage advance will be released', 'Please confirm when the mortgage advance will be released.'),
    UPDATE_CLIENT,
  ],
  completion_funds_shortfall: [
    msg('client', 'Ask The Client For The Balance', 'Tell the client the amount still needed to complete and ask them to send it in cleared funds', 'We need the balance of funds to complete. Please send it in cleared funds.'),
  ],
};
const CLIENT_ONLY: ReadonlySet<IssueGroup> = new Set(['funds_aml']);
const NO_STEPS: ReadonlySet<IssueKind> = new Set(['file_locked', 'unknown_correspondent', 'send_failed', 'document_revised']);

/**
 * The next steps offered on an issue of this kind. Acting for the buyer, a problem with the property
 * is the other side's to answer; acting for the seller, it is our client's (we ask them, and tell the
 * other side we are on it).
 */
export function issueSteps(kind: IssueKind, side: 'buyer' | 'seller' = 'buyer'): IssueStep[] {
  const own = STEPS_BY_KIND[kind];
  if (own) return own;
  if (NO_STEPS.has(kind)) return [];
  const spec = ISSUE_KIND_SPEC[kind];
  if (!spec) return [];
  if (CLIENT_ONLY.has(spec.group)) return [UPDATE_CLIENT];
  if (spec.gate === 'none') return [UPDATE_CLIENT];
  return side === 'seller' ? [ASK_CLIENT, TELL_OTHER_SIDE, NEGOTIATING] : [ASK_OTHER_SIDE, UPDATE_CLIENT, NEGOTIATING];
}

/** Kinds a case has at most one of open at a time: a second report of the same thing is the same issue. */
const ONE_PER_CASE: ReadonlySet<IssueKind> = new Set<IssueKind>(['transaction_at_risk', 'mortgage_at_risk', 'mortgage_offer_expiring', 'mortgage_offer_expired', 'mortgage_offer_expiry_unknown', 'completion_failure', 'chain_dependency', 'seller_delay', 'buyer_delay', 'lender_funds_delayed', 'completion_funds_shortfall', 'redemption_statement_expired', 'survey_report_outstanding']);
const STOP = new Set(['the', 'and', 'for', 'with', 'not', 'yet', 'has', 'have', 'from', 'that', 'this', 'are', 'was', 'our', 'their', 'unless', 'client', 'reports', 'says']);
const words = (t: string) => new Set(t.toLowerCase().replace(/\[[^\]]*\]/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
/**
 * The open issue a new one would duplicate: the same kind, about the same party, and either a kind a
 * case has only one of (the deal at risk, the offer expiring) or the same problem in other words
 * (most of the meaningful words shared). Timer-keyed issues (`[key:…]` in the title) keep their own
 * idempotence and are never matched here.
 */
export function duplicateIssue<T extends { id: string; kind: IssueKind; title: string; party: string | null; status: string }>(issues: T[], kind: IssueKind, title: string, party: string | null = null): T | null {
  if (/\[[a-z-]+:[^\]]*\]/.test(title)) return null;
  const mine = words(title);
  for (const i of issues) {
    if (i.kind !== kind || (i.status !== 'open' && i.status !== 'negotiating') || (i.party ?? null) !== (party?.trim() || null) || /\[[a-z-]+:[^\]]*\]/.test(i.title)) continue;
    if (ONE_PER_CASE.has(kind)) return i;
    const theirs = words(i.title);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    const union = new Set([...mine, ...theirs]).size;
    if (union && shared / union >= 0.6) return i;
  }
  return null;
}
