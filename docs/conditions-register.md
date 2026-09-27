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
Handbook Part 1 (Part 2 is each lender's own answers); **MLR** = Money Laundering Regulations 2017;
**Protocol** = Law Society Conveyancing Protocol and the TA forms; **PG** = HM Land Registry
practice guide.

## 1 · Identity and parties

| Condition | What changes | Status | Source / note |
|---|---|---|---|
| One client | ID / AML check holds Instruction | **gated** | MLR reg. 28 |
| Two or more clients named at enrolment | each gets their own check; Instruction holds for all | **gated** | `partyChecks`; names beyond the first at enrol |
| A client added after enrolment | — | **gap** | no command adds a co-client later; re-enrol is refused. Design: `add_party` |
| Client acts through an attorney (LPA / general POA) | attorney's ID, the power seen and its scope checked; lender told | **gap** | Handbook 5.1 / PG 9; nothing captures "attorney" |
| Client is a company | Companies House, directors, PSCs, authority, company funds | **flagged** | shape `company_buyer` raises a checklist issue holding exchange; no per-director checks are keyed as parties |
| Client is a trust, charity, estate (executors) | trustees / executors identified; grant seen | **flagged** | sale side: `seller_capacity` issue holds exchange; purchase side: nothing |
| ID result is refer / PEP / sanctions | decision: approve / further / escalate / reject → manual | **gated** | provider flags feed the `id_check` decision |
| Client outside the UK / non-UK documents | enhanced verification (certified copies, video) | **flagged** (donors only) | `POF_GIFT_DONOR_ABROAD`; nothing for a client abroad |
| ID older than the firm's refresh period (long matter) | re-verify | **gap** | LSAG §6.14 ongoing monitoring |
| Name differs across documents (marriage, deed poll) | evidence of the change | **gap** | `crosscheck.ts` compares names across documents where it has them; no name-change step |
| Gift donor | own check; holds proof-of-funds sign-off | **gated** | LSAG §6.17.2.1 |
| Gift from a joint account | both holders are donors; both checked; both on the gift letter; both to the lender | **gated** | shipped 2026-09-27; declared on the form (`jointDonorName`) or caught on the statement (`JOINT_ACCOUNT_UNDECLARED`) |
| Client's own account held jointly with a non-buyer | the other holder is a contributor: checked, no-interest confirmation, lender told | **gated** | `jointHolderName`; same mechanism |
| Unrepresented other side | their ID, no undertakings possible | **gap** | manual; chase templates assume a solicitor |
| Occupier over 17 who is not a buyer | consent / deed of postponement for the lender | **gap** | Handbook 5.16; nothing captures occupiers |

## 2 · Source of funds

| Condition | What changes | Status | Source / note |
|---|---|---|---|
| Firm policy: sign-off before exchange | exchange holds while a round is in flight or unsigned | **gated** | `requireProofOfFunds` |
| Shortfall against price − advance | flagged; price not on file → cannot check | **flagged** | `POF_SHORTFALL`, `POF_PRICE_UNKNOWN` |
| Source with no evidence | flagged | **flagged** | `POF_NO_EVIDENCE:*` |
| Gift: repayable / donor abroad / no donor documents | flagged; repayable = a loan, lender must approve | **flagged** | `POF_GIFT_*` |
| Gift from a non-family donor (friend, employer) | many lenders refuse; must be reported to the lender | **gap** | Handbook 5.13 defines "family"; `donorRelationship` is free text and not read |
| Loan from family / employer / bridging | lender told, affordability | **flagged** | `POF_LOAN` |
| Higher-risk source: crypto, overseas, business income, loan | enhanced due diligence questions | **flagged** | `POF_HIGH_RISK:*`, risk rating `enhanced` |
| Unusual credits on a statement (cash, third party, in-and-out, gambling, crypto, overseas, round sums) | a query per line; sign-off refused while a query is open | **gated** | `reviewTransactions`; `QUERY_UNANSWERED` |
| Statement in another name / joint | flagged, queried | **flagged** | `HOLDER_MISMATCH`, `JOINT_ACCOUNT_UNDECLARED` |
| Statement stale / short / balance short / no salary | flagged, queried | **flagged** | |
| Deposit or completion money arrives before sign-off | issue `aml_kyc_problem` holds exchange | **gated** | |
| Price rises beyond the verified funds | issue `source_of_funds` re-opens | **gated** | |
| Money arrives from an account never seen in the evidence | must be traced | **gap** | `funds_received` records a role, not the sending account. Design: carry the remitter on the client-account credit and compare with the statements read |
| Source of **wealth** (how the client came to have it) | EDD cases | **gap** | LSAG §6.17.3; queries can ask, no schema |
| Cash purchase (no lender) | all the money is the client's: source of funds carries the whole risk | **flagged** | the flow is the same; nothing raises the rating for 100% own funds |
| Funds from the sale of another property | completion statement / memorandum; a chain | **flagged** | `sale_proceeds` evidence expectations only; no link to the sale matter |
| Third party pays our fees or the deposit directly | third-party payment risk | **gap** | LSAG §6.17.2; nothing on the ledger side |
| Two declarants (joint buyers) | each their own round | **declared** | one declarant per form; the second buyer's round is sent by hand |

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
| Second charge / Help to Buy equity loan / shared equity | a second lender with its own consent and deed | **gap** | |
| Lender's Part 2 specifics (search age, lease term minimum, insurer rating…) | vary per lender | **gap** | Part 2 is per lender; nothing per-lender is modelled |
| Incentives / cashback on a new build (disclosure of incentives form) | lender told | **flagged** | shape text only |
| Searches older than the lender's limit at exchange | re-order | **gated** | re-ordered searches gate exchange again |
| Indemnity policy taken | lender told | **gated** | `lender_approval` issue |
| Mortgage deed + certificate of title before completion | | **gated** | shipped 2026-09-27 |

## 4 · Searches, title, lease

| Condition | What changes | Status | Source / note |
|---|---|---|---|
| Search flags (enforcement, unadopted road, flood, contaminated land) | decision incl. indemnity / enquiry | **gated** | |
| Extra search types (mining, chancel already; flood, highways, HS2, radon) | | **gap** (partial) | `SEARCH_TYPES` fixed |
| Search unreadable | flagged, never guessed | **gated** | |
| Restriction / charge / covenant on the register | decision; issues `covenant_consent`, `title_defect` | **gated** | |
| Unregistered land | first registration; epitome of title | **gap** | |
| Leasehold: short term, ground rent, doubling, service charge, major works, s.20 | flagged on the title decision; pack gates pre-contract | **flagged** | lender minimum unexpired term (Part 2) not compared |
| Shared ownership / Right to Buy / commonhold / flying freehold | | **gap** | manual |
| Building Safety Act (relevant building, leaseholder deed of certificate, landlord's certificate) | lender needs it on a flat in a building over 11 m / 5 storeys | **gap** | LPE1 5th ed. asks; nothing reads it |
| Deed of covenant / licence to assign / restriction consent certificate needed on registration | | **flagged** | listed in the pack's fees; no post-completion step |
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
| SDLT: first-time-buyer relief, higher rates (additional property, company), non-resident surcharge, mixed use | the return and the sum | **gap** | `sdlt_submitted` records; nothing computes or checks the rate basis |
| Priority search (OS1) window | | **gap** | |
| Buildings insurance from exchange | Handbook 6.14 | **gap** | |

## 6 · Sale, remortgage, transfer of equity

| Condition | What changes | Status | Source / note |
|---|---|---|---|
| Property forms (TA6 / TA7 / TA10) chased | | **gated** | wait `property_forms` |
| TA6 answers read for issues (disputes, alterations without consent, Japanese knotweed) | | **declared** | facts recorded; no rule reads them |
| Probate / attorney / capacity of the seller | issue `seller_capacity` holds exchange | **gated** | |
| Redemption figure known before exchange; discharge before close | | **gated** | |
| Our client is also buying (linked sale and purchase) | one chain | **gap** | two matters; no link beyond chain issues |
| Remortgage: SDLT determination, old lender redeemed, new deed | | **gated** | |
| Transfer of equity: lender consent, deed by every party, consideration, deed of trust | | **gated** | |
| Transfer on divorce / court order (no consideration, SDLT exemption) | | **gap** | `sdlt_not_required` is a person's call with a reason; the order is not a document kind |
| Outgoing owner's independent advice | Handbook / undue influence | **gap** | |

## 7 · Where to get the rest of the kinks

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
