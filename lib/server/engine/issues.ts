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
import type { Stage } from './types';

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
  'valuation_issue',
  'lender_approval',
  // money
  'deposit_issue',
  'completion_funds_shortfall',
  'lender_funds_delayed',
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
  'other',
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** Which stage exit an open blocking issue holds. */
export type IssueGate = 'exchange' | 'completion' | 'none';

export const ISSUE_STATUSES = ['open', 'negotiating', 'resolved', 'withdrawn', 'fatal'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

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
  'condition_satisfied',
  'new_lender',
  'revaluation_upheld',
  'lender_confirmed',
  'chain_ready',
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
}

const PRE: Stage[] = ['pre_contract', 'contract_review', 'pre_exchange'];
const PRE_ALL: Stage[] = ['instruction', 'pre_contract', 'contract_review', 'pre_exchange'];
const POST_EX: Stage[] = ['exchanged', 'pre_completion'];

export const ISSUE_KIND_SPECS: IssueKindSpec[] = [
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
  { kind: 'search_delayed', group: 'searches', label: 'Search delayed', arisesFrom: 'a local authority running weeks behind, a provider outage, a search that has to be re-ordered for freshness', gate: 'exchange', stages: PRE, resolutions: ['received', 'indemnity_policy', 'dates_replanned', 'accepted_as_is', 'other'], note: 'Search indemnity insurance is the usual workaround when a council is slow and the lender allows it.', overlaps: 'the search wait timer chases at day 10 and escalates at day 18; raise the issue when the delay changes the plan (indemnity, new target dates)' },
  // ── enquiries ──
  { kind: 'enquiry_unanswered', group: 'enquiries', label: 'Enquiry unanswered', arisesFrom: 'the other side has gone quiet: the seller\'s solicitor has not replied, or has replied to everything but the one that matters', gate: 'exchange', stages: PRE, resolutions: ['received', 'accepted_as_is', 'other'], note: 'The "enquiry stalemate" is the forum staple: weeks of "we are waiting for our client".', overlaps: 'the enquiry wait timer chases at day 5 and escalates at day 15' },
  { kind: 'enquiry_unsatisfactory', group: 'enquiries', label: 'Unsatisfactory enquiry response', arisesFrom: '"the buyer must rely on their own survey / searches", a refusal to give a statement of truth, an executor who will not answer', gate: 'exchange', stages: PRE, resolutions: ['received', 'evidence_provided', 'indemnity_policy', 'price_reduced', 'accepted_as_is', 'other'], note: 'Executors and attorneys legitimately cannot answer TA6 questions; the client is advised and decides.', overlaps: 'the enquiry sub-flow flags partial / refused replies as a decision; "request further" raises a tracked follow-up' },
  // ── funds & AML ──
  { kind: 'source_of_funds', group: 'funds_aml', label: 'Source-of-funds evidence outstanding', arisesFrom: 'a gifted deposit not declared early, an inheritance, crypto or overseas funds, savings with no paper trail', gate: 'exchange', stages: PRE_ALL, resolutions: ['evidence_provided', 'other'], note: 'The single most common self-inflicted delay: the gift is mentioned late and the donor is elderly or abroad; the lender must be told of a gift too.' },
  { kind: 'aml_kyc_problem', group: 'funds_aml', label: 'AML / KYC problem', arisesFrom: 'a referred or failed electronic check, a PEP or sanctions hit, an ID that will not verify, a client abroad who cannot be met', gate: 'exchange', stages: PRE_ALL, resolutions: ['evidence_provided', 'accepted_as_is', 'other'], note: 'Enhanced due diligence is a compliance decision; the matter cannot progress to money moving without it.', overlaps: 'the ID/AML sub-flow flags the provider result as a decision; rejecting it halts automation' },
  // ── mortgage ──
  { kind: 'mortgage_offer_outstanding', group: 'mortgage', label: 'Mortgage offer outstanding', arisesFrom: 'the application is stuck: underwriting queries, a valuation not yet booked, a broker waiting on documents', gate: 'exchange', stages: PRE, resolutions: ['received', 'new_lender', 'dates_replanned', 'other'], note: 'Nothing exchanges without the offer; the chain waits.', overlaps: 'mortgage.status = awaiting already blocks pre_contract; the issue is where the handler records why' },
  { kind: 'mortgage_condition_outstanding', group: 'mortgage', label: 'Mortgage condition outstanding', arisesFrom: 'a special condition on the offer: a retention, works, an occupier\'s consent, an indemnity approval, insurance, proof of deposit', gate: 'exchange', stages: PRE, resolutions: ['condition_satisfied', 'retention_agreed', 'lender_confirmed', 'evidence_provided', 'other'], note: 'Exchange with an unsatisfied condition risks funds not being released on the day.', overlaps: 'the mortgage sub-flow flags each special condition as a decision' },
  { kind: 'mortgage_offer_expiring', group: 'mortgage', label: 'Mortgage offer expiring', arisesFrom: 'the offer\'s expiry date closing in on a matter that is not ready to exchange', gate: 'exchange', stages: PRE, resolutions: ['offer_extended', 'received', 'dates_replanned', 'new_lender', 'other'], note: 'Lenders extend once, sometimes twice, for a few weeks; a re-issue means re-underwriting on today\'s rates.', overlaps: 'the deadline timer raises this 15 working days out; the issue tracks the extension request' },
  { kind: 'mortgage_offer_expired', group: 'mortgage', label: 'Mortgage offer expired', arisesFrom: 'the offer lapsed before exchange', gate: 'exchange', stages: PRE, resolutions: ['received', 'new_lender', 'other'], note: 'A fresh application, valuation and offer; rates may have moved.', overlaps: 'record mortgage_offer_withdrawn (the sub-flow reopens and blocks exchange); the issue tracks the re-application' },
  { kind: 'valuation_issue', group: 'mortgage', label: 'Valuation issue', arisesFrom: 'a down-valuation below the agreed price, a valuer\'s retention or "further reports required" (roof, damp, timber), a nil valuation (spray foam, cladding, knotweed)', gate: 'exchange', stages: PRE, resolutions: ['price_reduced', 'buyer_covers_shortfall', 'new_lender', 'revaluation_upheld', 'specialist_report_clear', 'retention_agreed', 'accepted_as_is', 'other'], note: 'Options are renegotiate, make up the shortfall, a fresh valuation with another lender, or a challenge; a price change must be reported to the lender and can change the offer.' },
  { kind: 'lender_approval', group: 'mortgage', label: 'Lender approval needed', arisesFrom: 'anything the lender must be told: a price change, an indemnity policy, a retention, flood risk, a change of circumstances', gate: 'exchange', stages: PRE, resolutions: ['lender_confirmed', 'new_lender', 'other'], note: 'Raised automatically by the machine when a price change or an indemnity resolution needs the lender\'s confirmation; days to weeks in practice.' },
  // ── money ──
  { kind: 'deposit_issue', group: 'money', label: 'Deposit issue', arisesFrom: 'a deposit below 10%, a deposit funded by the sale in a chain, a deposit not yet in cleared funds, a gifted deposit not yet evidenced', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['deposit_agreed', 'funds_in_place', 'evidence_provided', 'other'], note: 'A reduced deposit needs the seller\'s agreement in the contract; a deposit "up the chain" is normal but must be agreed.' },
  { kind: 'completion_funds_shortfall', group: 'money', label: 'Completion funds shortfall', arisesFrom: 'the client balance is short of the completion statement: SDLT underestimated, a bonus or ISA not yet released, a sale proceeds shortfall in the chain', gate: 'completion', stages: ['pre_exchange', ...POST_EX], resolutions: ['funds_in_place', 'evidence_provided', 'other'], note: 'Before exchange it is a plan; after exchange it is a completion failure in waiting.' },
  { kind: 'lender_funds_delayed', group: 'money', label: 'Lender funds delayed', arisesFrom: 'the advance not released: the certificate of title sent late, a condition unsatisfied, the lender\'s cut-off missed', gate: 'completion', stages: POST_EX, resolutions: ['received', 'completed_late', 'other'], note: 'Most lenders need the COT 5 working days before completion; a late advance means late completion interest.', overlaps: 'the funds wait timer chases the lender from day 2' },
  // ── parties & chain ──
  { kind: 'chain_dependency', group: 'parties_chain', label: 'Chain dependency', arisesFrom: 'the top or bottom of the chain is not ready: their management pack, their enquiries, their buyer pulled out, their mortgage', gate: 'exchange', stages: ['contract_review', 'pre_exchange'], resolutions: ['chain_ready', 'dates_replanned', 'other'], note: 'Agents say "ready" a week before solicitors are; a link dropping out costs ~10 weeks; the collapse is often discovered on exchange day.' },
  { kind: 'seller_delay', group: 'parties_chain', label: 'Seller delay', arisesFrom: 'the seller has not returned the protocol forms, signed the contract, provided documents, or instructed their solicitor on a point', gate: 'exchange', stages: PRE, resolutions: ['received', 'dates_replanned', 'accepted_as_is', 'other'], note: 'The commonest reason a matter sits: nothing is technically wrong, someone is just not doing it.' },
  { kind: 'buyer_delay', group: 'parties_chain', label: 'Buyer delay', arisesFrom: 'our own client: survey not booked, documents not returned, the deposit not sent, the mortgage application not made', gate: 'exchange', stages: PRE_ALL, resolutions: ['received', 'dates_replanned', 'other'], note: 'Record it so the file shows who was waiting for whom.' },
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
  { kind: 'other', group: 'other', label: 'Other', arisesFrom: 'anything else the handler needs the matter to wait for', gate: 'exchange', stages: ['instruction', ...PRE, ...POST_EX], resolutions: [...ISSUE_RESOLUTIONS], note: '' },
];

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
  deed_or_declaration: 'deed or statutory declaration obtained',
  deed_of_variation: 'deed of variation completed',
  lease_extended: 'lease extended (or extension assigned)',
  restriction_complied: 'restriction complied with (certificate / consent)',
  document_reexecuted: 'document re-executed',
  received: 'received (the awaited thing arrived)',
  offer_extended: 'offer extended by the lender',
  condition_satisfied: 'condition satisfied',
  new_lender: 'new lender / fresh valuation',
  revaluation_upheld: 'valuation challenged and upheld',
  lender_confirmed: 'lender confirmed the offer stands',
  chain_ready: 'chain confirmed ready',
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
