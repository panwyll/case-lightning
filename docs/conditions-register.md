# Conditions register: what changes the process inside each sub-flow, and how far the engine goes

The scenario library (`docs/engine-eventualities.md`, `lib/server/engine/scenarios`) walks the
**spine** of each transaction type, clean and flagged. It does not walk every *condition* inside a
sub-flow — the things a conveyancer's checklist branches on ("cash purchase", "the gift comes
from a joint account", "the buyer is a company"). This register is that list, kept honest.
It is the backlog for the next round of sandbox scenarios and the first thing to check before
a firm is shown the tool.

Status, in decreasing strength:

| Status | Meaning |
|---|---|
| **gated** | the machine refuses or holds a gate until the condition is met; a scenario proves it |
| **flagged** | a person is told (a flag, an issue, a decision's text) and can act; nothing holds |
| **declared** | the enrol form or the client form captures it; nothing reads it |
| **gap** | not captured at all; a person has to know |

Sources: **LSAG** = Legal Sector Affinity Group AML guidance for the legal sector (HM Treasury
approved, April 2025 edition, `§` numbers are its); **Handbook** = UK Finance Mortgage Lenders'
Handbook Part 1, cited by topic because the text sits behind a login and its paragraph numbers
have moved between editions (Part 2 is each lender's own answers); **MLR** = Money Laundering Regulations 2017;
**Protocol** = Law Society Conveyancing Protocol and the TA forms; **PG** = HM Land Registry
practice guide.

## 1 · Identity and parties

| Condition | What changes | Status | Source / note |
|---|---|---|---|
| One client | ID / AML check holds Instruction | **gated** | MLR reg. 28 |
| Two or more clients named at enrolment | each gets their own check; Instruction holds for all | **gated** | `partyChecks`; names beyond the first at enrol |
| A client added after enrolment | their own check; holds Instruction and exchange | **gated** | `add_party` (any role) |
| Client acts through an attorney (LPA / general POA) | attorney identified in their own right (holds Instruction and exchange); a `power_of_attorney_issue` checklist holds exchange: the power, its scope, the client's written confirmation, the lender told | **gated** | LSAG 6.14.9; Handbook (powers of attorney); PG 9. `enrol.attorneys` |
| Client is a company | Companies House, directors, PSCs, authority, company funds | **gated** | shape `company_buyer` + `enrol.officers`: every director / PSC named is a party with their own check holding Instruction and exchange; the PSC-register discrepancy duty in the checklist (LSAG 6.14.11, 6.16) |
| Client is a trust, charity, estate (executors) | executors / trustees identified (at least two), grant or trust deed seen | **gated** | `enrol.executors`: each a party holding Instruction and exchange; a `probate_issue` checklist holds exchange (LSAG 6.14.16) |
| ID result is refer / PEP / sanctions | decision: approve / further / escalate / reject → manual | **gated** | provider flags feed the `id_check` decision |
| Client outside the UK / non-UK documents | enhanced verification (certified copies, video) | **flagged** (donors only) | `POF_GIFT_DONOR_ABROAD`; nothing for a client abroad |
| ID older than the firm's refresh period (long matter) | refresh EID&V, address, PEP / sanctions | **flagged** | the timer raises `cdd_refresh` a year after the first client's check resolved (LSAG 6.21); holds nothing |
| Name differs across documents (marriage, deed poll) | evidence of the change | **gated** | `name_change_evidenced` (a person, from the certificate): the alias is one person to the cross-checks; an undocumented difference stays a `document_mismatch` |
| Gift donor | own check; holds proof-of-funds sign-off | **gated** | LSAG §6.17.2.1 |
| Gift from a joint account | both holders are donors; both checked; both on the gift letter; both to the lender | **gated** | shipped 2026-09-27; declared on the form (`jointDonorName`) or caught on the statement (`JOINT_ACCOUNT_UNDECLARED`) |
| Client's own account held jointly with a non-buyer | the other holder is a contributor: checked, no-interest confirmation, lender told | **gated** | `jointHolderName`; same mechanism |
| Unrepresented other side | their ID against the title, no undertakings, lender told | **gated** | shape `unrepresented_counterparty` → issue holding exchange (PG 67); chase templates still assume a solicitor |
| Occupier over 17 who is not a buyer | consent / deed of postponement for the lender, with separate advice | **gated** | `enrol.occupiers` → `occupier_consent` issue holding exchange (Handbook: occupiers) |

## 2 · Source of funds

| Condition | What changes | Status | Source / note |
|---|---|---|---|
| Firm policy: sign-off before exchange | exchange holds while a round is in flight or unsigned | **gated** | `requireProofOfFunds` |
| Shortfall against price − advance | flagged; price not on file → cannot check | **flagged** | `POF_SHORTFALL`, `POF_PRICE_UNKNOWN` |
| Source with no evidence | flagged | **flagged** | `POF_NO_EVIDENCE:*` |
| Gift: repayable / donor abroad / no donor documents | flagged; repayable = a loan, lender must approve | **flagged** | `POF_GIFT_*` |
| Gift from a non-family donor (friend, employer) | many lenders refuse; must be reported to the lender | **flagged** | `POF_GIFT_NON_FAMILY` (high) when the relationship is not a close relation as the Handbook defines it |
| Loan from family / employer / bridging | lender told, affordability | **flagged** | `POF_LOAN` |
| Higher-risk source: crypto, overseas, business income, loan | enhanced due diligence questions | **flagged** | `POF_HIGH_RISK:*`, risk rating `enhanced` |
| Unusual credits on a statement (cash, third party, in-and-out, gambling, crypto, overseas, round sums) | a query per line; sign-off refused while a query is open | **gated** | `reviewTransactions`; `QUERY_UNANSWERED` |
| Statement in another name / joint | flagged, queried | **flagged** | `HOLDER_MISMATCH`, `JOINT_ACCOUNT_UNDECLARED` |
| Statement stale / short / balance short / no salary | flagged, queried | **flagged** | |
| Deposit or completion money arrives before sign-off | issue `aml_kyc_problem` holds exchange | **gated** | |
| Price rises beyond the verified funds | issue `source_of_funds` re-opens | **gated** | |
| Money arrives from an account never seen in the evidence | must be traced before completing | **gated** | `funds_received.remitter` compared with the declarant, every party and every statement read; a stranger raises `aml_kyc_problem` (critical) holding completion (LSAG 6.17.2; red flag 18.4) |
| Source of **wealth** (how the client came to have it) | EDD cases | **gated** | an `enhanced` rating drafts one `SOURCE_OF_WEALTH` query; it is sent or withdrawn with a reason before sign-off (LSAG 6.17.3, 6.18.3) |
| Cash purchase (no lender) | all the money is the client's: source of funds carries the whole risk | **flagged** | `POF_CASH_PURCHASE` (medium) on every declaration with no advance (LSAG 18.5.2) |
| Funds from the sale of another property | the linked sale exchanges with us; proceeds traced | **gated** | `link_related_matter`: the chain issue holds exchange, the service refuses exchange until the linked file can exchange and clears the issue when it can; sale proceeds with no linked sale are `POF_SALE_PROCEEDS_UNLINKED` |
| Third party pays our fees or the deposit directly | third-party payment risk | **gap** | LSAG §6.17.2; nothing on the ledger side |
| Two declarants (joint buyers) | each their own round, or each confirms the one declaration | **flagged** | co-buyers are ticked on the form (`coDeclarants`); a co-buyer who neither confirms nor declares is `POF_MISSING_DECLARANT` |

## 3 · Mortgage

| Condition | What changes | Status | Source / note |
|---|---|---|---|
| Cash purchase | no offer, no lender funds, no certificate of title | **gated** | `hasLender=false` |
| Offer with special conditions / retention | decision; retention raises a `lender_approval` issue | **gated** | |
| Offer expiry near exchange | flagged at extraction; deadline timer | **flagged** | |
| Offer withdrawn / lender changed | sub-flow reopens; exchange blocked | **gated** | |
| Cash ↔ mortgage after enrolment | — | **gap** | design: `lender_status_changed` |
| Names on the offer differ from the buyers | cross-check | **flagged** | `crosscheck.ts` where names are extracted |
| Buy-to-let product | rental cover, tenancy, licensing | **flagged** | shape checklist issue |
| Second charge / Help to Buy equity loan / shared equity | a second lender with its own consent and deed | **gated** | shape `second_charge` → `second_charge_consent` issue holding completion |
| Lender's Part 2 specifics (search age, lease term minimum, gifts, EWS1) | vary per lender | **gated** | `record_lender_requirements` on the matter: the lease review flags a term under the minimum, exchange refuses searches older than the limit, a non-family gift is accepted when the lender says so |
| Incentives / cashback on a new build (disclosure of incentives form) | lender told | **flagged** | shape text only |
| Searches older than the lender's limit at exchange | re-order | **gated** | re-ordered searches gate exchange again |
| Indemnity policy taken | lender told | **gated** | `lender_approval` issue |
| Mortgage deed + certificate of title before completion | | **gated** | shipped 2026-09-27 |

## 4 · Searches, title, lease

| Condition | What changes | Status | Source / note |
|---|---|---|---|
| Search flags (enforcement, unadopted road, flood, contaminated land) | decision incl. indemnity / enquiry | **gated** | |
| Extra search types | mining, flood, highways, planning history | **gated** | `SEARCH_TYPES` now carries MINING, FLOOD, HIGHWAYS, PLANNING with their checks; any of them can be a required search |
| Search unreadable | flagged, never guessed | **gated** | |
| Restriction / charge / covenant on the register | decision; issues `covenant_consent`, `title_defect` | **gated** | |
| Unregistered land | first registration; epitome of title | **manual** | `title_extracted` with `unregistered` → `manual_handling_required(unregistered_land)` |
| Leasehold: short term, ground rent, doubling, service charge, major works, s.20 | flagged on the title decision; pack gates pre-contract | **flagged** | lender minimum unexpired term (Part 2) not compared |
| Shared ownership | model lease, provider approval, rent, staircasing, nomination | **gated** | shape `shared_ownership` → `shared_ownership_terms` issue holding exchange |
| Right to Buy / commonhold / flying freehold | discount repayment and pre-emption; the community statement; the lender's limit and rights of support | **gated** | shapes `right_to_buy`, `commonhold`, `flying_freehold`, each a checklist issue holding exchange |
| Building Safety Act (relevant building, leaseholder deed of certificate, landlord's certificate) | lender needs it on a flat in a building over 11 m / 5 storeys | **gated** | the pack is read for the three answers; a relevant building missing a certificate raises `building_safety` holding exchange |
| Deed of covenant / licence to assign / restriction consent certificate needed on registration | | **flagged** | on completion of a leasehold purchase the pack's `consentsRequired` becomes a `missing_consent` issue ("After completion: …") that must be resolved before close |
| Notice of assignment / charge after completion | | **gated** | leasehold purchase |
| New information after the report on title went out | supplemental report | **manual** | refused; a person's job |

## 5 · Exchange and completion

| Condition | What changes | Status | Source / note |
|---|---|---|---|
| Deposit received; conditions met; client authority; no holding issue | exchange | **gated** | |
| Auction | exchange is the hammer; no client authority step | **gated** | shape `auction` |
| Deposit under 10% / held to order | contract term | **outside** | |
| Simultaneous exchange and completion | | **gated** | |
| Tenants in common → declaration of trust before completion | | **gated** | `ownership_basis` client decision |
| Transfer deed, mortgage deed, certificate, advance, client balance before completion | | **gated** | |
| Money from the client short of the statement | issue `funding_shortfall` | **gated** | |
| Bank details change | hard stop; out-of-band verification | **gated** | |
| Completion fails on the day / notice to complete | issue + decision + deadline | **gated** | |
| SDLT: first-time-buyer relief, higher rates (additional property, company), non-resident surcharge | the return and the sum | **flagged** | `sdlt.ts` computes the estimate on the declared basis (rates from April 2025) onto the completion statement, the SDLT deadline and the registration tile; the `sdlt_basis` issue lists what to check; mixed use and linked transactions stay a person's |
| Priority search (OS1) window | completion inside the period | **gated** | `priority_search_made(expiresAt)` required on a lender purchase; completion refused after expiry; deadline timer 2 working days before |
| Buildings insurance from exchange | on the lender's terms | **gated** | `buildings_insurance_confirmed` required before completion on a lender purchase (Handbook: insurance) |
| Bankruptcy search against every borrower | K16 before completion | **gated** | `bankruptcy_search_clear` required before completion on a lender purchase (Handbook: insolvency); a hit is a `bankruptcy_insolvency` issue |

## 6 · Sale, remortgage, transfer of equity

| Condition | What changes | Status | Source / note |
|---|---|---|---|
| Property forms (TA6 / TA7 / TA10) chased | | **gated** | wait `property_forms` |
| TA6 / TA7 answers read for issues | disputes, notices, works without consent, guarantees and insurance claims, flooding, knotweed, radon, occupiers, shared rights, septic tank, solar lease, boundaries, listed, leasehold arrears | **gated** | `property-forms.ts`: each material answer is an issue cited to the page, on the purchase (`seller_forms_received`) and on the sale (our client's forms); the issue's own gate holds |
| Probate / attorney / capacity of the seller | issue `seller_capacity` holds exchange | **gated** | |
| Redemption figure known before exchange; discharge before close | | **gated** | |
| Our client is also buying (linked sale and purchase) | one chain, simultaneous exchange | **gated** | `link_related_matter` on either side; see Source of funds |
| Remortgage: SDLT determination, old lender redeemed, new deed | | **gated** | |
| Transfer of equity: lender consent, deed by every party, consideration, deed of trust | | **gated** | |
| Transfer on divorce / court order (no consideration, SDLT exemption) | the sealed order, the lender's release, the exemption | **gated** | shape `court_order_transfer` → issue holding completion |
| Outgoing owner's independent advice | undue influence | **flagged** | on the `court_order_transfer` checklist; not captured on a plain transfer |

## 7 · Still open

After the second pass on 2026-09-27 (the whole-transaction one), what remains needs a source the engine does not have:

- **Third parties paying our fees**: no ledger side to the engine.
- **Linked transactions and mixed use for SDLT**: the estimate is for one dwelling on the declared basis.
- **Per-lender numbers the firm has not recorded**: `record_lender_requirements` is per matter; there is no lender directory.
- **Enquiries drafted from the TA6 gaps**: an answer of "not known" raises no enquiry yet; the issues do.
- **EPC and the seller's marketing duties**: recorded from the TA6 when stated, not chased.

## 8 · Where to get the rest of the kinks

The register above was built from the code and from the four sources it cites. The gaps it
lists are the ones those sources made obvious; the way to find the ones they did not is:

1. **Mine the rulebooks systematically, sub-flow by sub-flow.** LSAG Part 2 chapter 6
   (CDD, §6.17 source of funds), the Handbook Part 1 in section order (each numbered
   paragraph is a condition: 5.1 attorneys, 5.8 new build, 5.13 gifts, 5.14 sale by a
   lender, 5.16 occupiers, 6.14 insurance…), the Protocol's step list and the TA6 / TA7 /
   TA10 / LPE1 questions, and HMLR PGs 8, 19, 67, 73. Every paragraph either maps to a row
   here or is a new row. The Handbook Part 2 for the pilot firm's top five lenders adds the
   per-lender numbers.
2. **Read a firm's own checklists.** A CQS firm has a file-opening checklist, an AML
   matter risk assessment and a completion checklist. Their MLRO's policy (gift
   relationships they accept, cash limits, refresh periods) is `POF_POLICY` plus rows here.
3. **Run retired real files through the sandbox.** A closed file re-keyed as a scenario
   (dates shifted, names replaced) shows which conditions the engine did not ask about.
   That is the best test there is, and it needs no dummy data in real cases.
4. **Turn every row into a scenario variant.** A gap closes in the order *declared →
   flagged → gated*: capture it, tell a person, then hold the gate once a firm confirms the
   rule. `tests/unit/engine/scenarios.test.ts` proves each variant still closes.
