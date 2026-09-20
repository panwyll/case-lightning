# Issues: what goes wrong on a real purchase, and what the machine does about it

The stage spine (instruction → pre-contract → contract review → pre-exchange → exchanged →
pre-completion → completed → post-completion) and its sub-flows describe the work that has
to happen. They do not describe what a conveyancer spends most of their week on: the
things that go wrong and change what the matter needs before it can move. A survey finds
damp and the price is renegotiated. The lender down-values. The loft conversion has no
building-regs certificate and the lender has to approve an indemnity policy. The seller's
onward purchase is not ready. Probate has not been granted. The deposit is a gift from a
parent abroad and nobody has the donor's ID. The money does not arrive by the CHAPS cut-off.

This document is the research behind the **issues layer** (`lib/server/engine/issues.ts`,
commands in `machine.ts`, tests in `tests/unit/engine/issues.test.ts`, the panel in
`app/shared/engine/IssuesPanel.tsx`, section 7 of `/engine/map`). It records, for each kind
of problem: where it comes from, what people report actually happens, what the realistic
ways out are, and what the machine now does. The kind list is the practitioner's list —
title, lease, planning and regs, searches, enquiries, source of funds and AML, mortgage,
money, parties and chain, the property itself, completion.

## How the research was done, honestly

The sandbox this was built in cannot fetch web pages (the egress proxy refuses
MoneySavingExpert, HomeOwners Alliance, the Law Society, the Property Law forums and the
rest with a 403). What follows is assembled from search-result summaries of those forums
and from the author's knowledge of English & Welsh residential conveyancing practice. Where
a number is quoted it is from a published source named in the text; everything else is
"what people say happens" and should be read as such. Nothing here was verified against a
live file. Before the layer is used on client matters, a conveyancer should read the kind
list and the resolutions and strike what is wrong — the catalogue is data, and a
kind's resolutions can be changed in one place.

Sources, by topic, that the summaries came from:

- **MoneySavingExpert "House buying, renting & selling" forum** — threads on enquiry
  stalemates ("we are waiting for our client"), refusals to accept an indemnity for missing
  building regs, lender approval of indemnity policies taking from a day to three-plus
  weeks, executors refusing to give a statement of truth, management packs taking two to
  eight weeks, chain collapses discovered on exchange day and the ~10 weeks they cost,
  probate taking twelve weeks to two years, down-valuations and the four ways out
  (renegotiate / make up the shortfall / new lender / challenge), the restrictive-covenant
  trap (asking for retrospective consent kills the indemnity route), unadopted roads and
  rights of way, solar-panel roof leases, gifted deposits and AML, completion-day money
  failures.
- **HomeOwners Alliance** — fall-through statistics (their 2025 figure: about a quarter of
  agreed sales fall through; the leading causes reported as mortgage problems, chain
  breaks and buyers changing their minds) and the "what to do when the survey finds
  something" guidance (renegotiations typically settle in the 1–5% range).
- **HM Land Registry** — requisition statistics (roughly one application in five attracts
  a requisition; well over half of avoidable delays are caused by errors in the
  application, non-compliant plans, missing restriction consents and execution defects).
- **Case law and rules referred to** — *Rosser v Pacifico* (TA6 misrepresentation);
  the Standard Conditions of Sale (5th edition): notice to complete makes time of the
  essence with ten working days to complete, late-completion interest at the contract
  rate; the UK Finance Mortgage Lenders' Handbook on what a lease must contain, minimum
  unexpired terms, indemnity insurance and reporting price changes and flood risk to the
  lender; the Leasehold Reform, Housing and Urban Development Act 1993 s.42 notice
  (statutory lease extension, assignable on completion); the Town and Country Planning
  Act enforcement time limits; the Lasting Powers of Attorney regime (registration with
  the Office of the Public Guardian).

## What an issue is, and is not

An **issue** is a typed, person-raised situation with:

- a **kind** from the catalogue (below), which fixes its default **gate** and its set of
  realistic **resolutions**;
- a **gate**: which stage exit it holds while open — `exchange`, `completion`, or `none`
  (tracked, holds nothing). After exchange an exchange-gated kind holds completion instead,
  because exchange is history;
- a **lifecycle**: `open` → `negotiating` → `resolved` (with a resolution) | `withdrawn`
  (raised in error / overtaken) | `fatal` (it ended the transaction: the matter is
  abandoned in the same command, with the abandonment reason derived from the kind);
- a **source document** where there is one (the survey, the valuation, the TA6, the
  management pack), so the panel can open it;
- a **history** on the projection, and every transition on the immutable log
  (`issue_raised`, `issue_updated`, `issue_resolved`, `issue_withdrawn`, `issue_fatal`).

An issue is **not** a sub-flow: nothing is ordered, extracted or rule-checked. It is **not**
a decision: there is no AI summary of a source to approve or reject, and it does not sit
in the decisions queue. It is the thing a decision or a document *started* — the
renegotiation the survey flag led to, the lender approval the indemnity option needs —
and the place a handler records what everybody is waiting for.

Some kinds overlap with what the machine already does on its own: a delayed search is
chased by the search wait timer; an unanswered enquiry by the enquiry timer; an expiring
offer by the deadline timer; an outstanding offer already blocks pre-contract. They are in
the catalogue anyway, because "the council is eight weeks behind so we are buying search
indemnity and moving the target dates" is a plan change a person needs to record, and
the catalogue entry says what the machine already covers (`overlaps`) so nothing is
double-counted.

## The rule the layer enforces: everything but the gate proceeds

The forum consensus on probate ("everything but exchange can proceed before the grant")
is the general rule. An open issue holds exactly one thing — exchange, or completion —
and nothing else. Searches come back, the mortgage offer is judged, the title is reviewed,
the report on title is drafted, approved and sent, the deposit is recorded, all with the
issue open. Concretely:

- an open or negotiating issue gated on `exchange` blocks `exchange_conditions_met`
  (the derived milestone), `contracts_exchanged`, and the `pre_exchange` stage exit, and
  appears in the stage blockers as `issue: <label> — <title> (<status>)`;
- one gated on `completion` blocks `completion_confirmed` and the `pre_completion` exit;
- releasing a hold (`update_issue` with `gate: none`) needs a note saying why — the client
  accepts the risk in writing, the lender is content — because that note is the advice
  file;
- an issue nobody has touched for ten working days is raised to a person as an escalation
  with a dossier (`stale_issue` in `sla.ts → deadlineActions`), once per period of silence;
  any update restarts the clock. This is the machine's answer to the forum's commonest
  story: an issue that sits for weeks because each side thinks the other is dealing
  with it.

## Effects a resolution has on the rest of the machine

The layer is not just a list. Certain resolutions change facts elsewhere, and the
machine records those changes itself so they cannot be forgotten:

| Resolution | Effect |
| --- | --- |
| `price_reduced` | Needs the new agreed price; refused after exchange (the price is contractual). Records `price_changed`. |
| `price_reduced`, `indemnity_policy`, `retention_agreed` | On a lender-funded purchase before exchange, raises a **`lender_approval`** issue (actor `system`, origin = the resolved issue) that holds exchange until the lender confirms the offer stands (`lender_confirmed`) or the buyer moves lender (`new_lender`). The lender must be told of a price change, an indemnity policy on the title, or a retention — and forum experience is that this takes from a day to several weeks. |
| `new_lender` | On a lender-funded purchase before exchange, records `mortgage_offer_withdrawn`: the mortgage sub-flow reopens, exchange is blocked until the new offer is received and judged afresh. |
| `accepted_as_is`, `other` | Need a note: the advice given, or what actually happened. |

Two more doors into the same effects:

- choosing the **`indemnity`** option on a flagged search, title or enquiry decision on a
  lender-funded purchase raises the `lender_approval` issue automatically, citing the
  document the policy is to cover;
- **`record_price_change`** records the agreed price (first record: no lender effect) or
  a renegotiated price (lender-funded: `lender_approval` raised). The price is now a fact
  on the projection (`purchasePricePennies`) for the report on title, the completion
  statement and SDLT to use.

Two **readiness milestones** — `contract_approved` (the draft contract approved as to form)
and `signed_contract_held` (the client's signed contract on file) — are recorded as events
and shown as "ready to exchange?" but are deliberately **not gates**: firms differ on
whether they exchange on an undertaking to hold the signed part, and the machine should
not take that decision for them.

## The catalogue

The authoritative list is `ISSUE_KIND_SPECS` in `lib/server/engine/issues.ts`; the map at
`/engine/map` §7 renders it live. Summarised here by group. *Holds* is the default gate; a
person may override it when raising or later.

### Title

| Kind | Arises from | Holds | Ways out | What people report |
| --- | --- | --- | --- | --- |
| Title defect / discrepancy | possessory or qualified title, a missing deed, an unregistered part, an undated or unsigned deed, a name mismatch | exchange | indemnity; deed or statutory declaration; evidence; re-execution; accept | These are the gaps HMLR later requisitions on — fix them now or answer for them later. |
| Restriction on title | Form A / B / L restrictions: co-owners, management company, chargee, s.106, overage | exchange | comply (certificate / consent); deed; indemnity; accept | The certificate the restriction demands is in a third party's hands and slow; the AP1 is rejected without it. The title sub-flow flags the entry; the issue tracks getting the thing. |
| Missing easement / right | no right of way over a private road or shared drive; no right for services; CON29 2.1 "not adopted" | exchange | deed of grant; 20-year statutory declaration; indemnity; accept | A lender may find the title unacceptable without legal access; maintenance liability is a client-advice point. |
| Restrictive covenant | consent-to-alter covenants already breached by the extension | exchange | indemnity; retrospective consent; deed of variation; accept | **The trap**: once the covenantee is asked, an indemnity is no longer available. Decide the route before anyone writes to them. |
| Boundary discrepancy | title plan vs survey / fence / particulars; a strip in a neighbour's title | exchange | statutory declaration; evidence; indemnity; price; accept | Usually a declaration now and a determined-boundary application later. |
| Missing consent | works needing a third party's consent under the title (landlord, management company, rentcharge owner) | exchange | consent; retrospective consent; indemnity; accept | Same indemnity-versus-approach choice as a covenant. |

### Leasehold

v1 runs freehold purchases; a leasehold title puts the matter into manual handling. The
kinds are in the catalogue because the issue is still real and needs recording, and
because the leasehold flow is the obvious next transaction type.

| Kind | Arises from | Holds | Ways out | What people report |
| --- | --- | --- | --- | --- |
| Lease defect | no forfeiture-on-insolvency protection, missing repair / insurance provisions, no rights over common parts | exchange | deed of variation; indemnity; lender confirms; accept | The UK Finance Handbook lists what a lease must contain; a variation needs the landlord and every lender to sign. |
| Short lease | unexpired term below the lender's minimum (typically 70–85 years at completion), or approaching 80 years | exchange | lease extended (s.42 notice served and assigned); price; new lender; lender confirms; accept | A statutory extension takes months; the usual route is the seller serving the notice and assigning the benefit. |
| Service charge issue | arrears, a disputed demand, planned major works, an unclear reserve fund | exchange | retention; price; evidence; accept | Retention from the price for the next demand; arrears must be cleared before the landlord registers the assignment. |
| Ground rent issue | doubling rents; rent above the assured-tenancy thresholds; arrears | exchange | deed of variation; indemnity; lender confirms; price; accept | Many lenders refuse doubling rents. |
| Freeholder / managing-agent information outstanding | LPE1 / management pack not supplied; missing accounts, insurance, fire-risk assessment | exchange | received; accept | The single most-cited leasehold delay: two to eight weeks, seller pays; chase early, in writing. |

### Planning and building regulations

| Kind | Arises from | Holds | Ways out | What people report |
| --- | --- | --- | --- | --- |
| Planning permission missing | works with no decision notice; CON29 3.7 enforcement entry; TA6 contradicting the survey | exchange | indemnity; retrospective consent; evidence; works; price; accept | Enforcement is time-limited; an indemnity is available only if the authority has not been approached. |
| Building-regs approval missing | extension, loft, knocked-through wall, boiler or windows with no completion certificate / FENSA / Gas Safe | exchange | indemnity; regularisation certificate; evidence; retention; price; accept | One of the most common hold-ups. Lenders accept an indemnity or regularisation but some insist on regularisation for structural or recent work; lender approval of an indemnity takes days to weeks. Buyers' solicitors sometimes refuse an indemnity outright and the thread turns into a standoff. |

### Searches and enquiries

| Kind | Arises from | Holds | Ways out | Already covered by |
| --- | --- | --- | --- | --- |
| Search adverse entry | flood risk, contaminated land, a road scheme, chancel, mining, no public sewer | exchange | evidence; specialist report; indemnity; lender confirms; price; accept | the search sub-flow's decision; the issue tracks what the decision started |
| Search delayed | a council weeks behind, a provider outage, a freshness re-order | exchange | received; search indemnity; dates re-planned; accept | the search wait timer (chase day 10, escalate day 18) |
| Enquiry unanswered | the other side has gone quiet | exchange | received; accept | the enquiry wait timer (chase day 5, escalate day 15) |
| Unsatisfactory enquiry response | "rely on your own survey"; refusal of a statement of truth; an executor who cannot answer | exchange | received; evidence; indemnity; price; accept | the enquiry sub-flow flags partial / refused replies; "request further" raises a follow-up |

### Source of funds and AML

| Kind | Arises from | Holds | Ways out | What people report |
| --- | --- | --- | --- | --- |
| Source-of-funds evidence outstanding | a gift not declared early; inheritance, crypto, overseas funds; savings with no paper trail | exchange | evidence | The single most common self-inflicted delay: the gift is mentioned late and the donor is elderly or abroad; the lender must be told of a gift too. |
| AML / KYC problem | a referred or failed check, a PEP / sanctions hit, an ID that will not verify, a client abroad | exchange | evidence; accept (compliance decision) | The ID sub-flow flags the provider result; rejecting halts automation. Nothing moves money until enhanced due diligence is done. |

### Mortgage

| Kind | Arises from | Holds | Ways out | Already covered by / what people report |
| --- | --- | --- | --- | --- |
| Mortgage offer outstanding | underwriting queries, valuation not booked, broker waiting on documents | exchange | received; new lender; dates re-planned | `mortgage.status = awaiting` already blocks pre-contract; the issue records why |
| Mortgage condition outstanding | retention, works, occupier consent, indemnity approval, insurance, proof of deposit | exchange | condition satisfied; retention; lender confirms; evidence | the mortgage sub-flow flags each special condition; exchange with one unsatisfied risks no funds on the day |
| Mortgage offer expiring | expiry closing in on a matter not ready to exchange | exchange | extended; new offer; dates re-planned; new lender | the deadline timer 15 working days out; lenders extend once, sometimes twice |
| Mortgage offer expired | lapsed before exchange | exchange | new offer; new lender | record `mortgage_offer_withdrawn` (sub-flow reopens); the issue tracks the re-application |
| Valuation issue | down-valuation; a valuer's retention or "further reports"; a nil valuation (spray foam, cladding, knotweed) | exchange | price; buyer covers; new lender; challenge upheld; specialist report; retention; accept | Renegotiate, make up the shortfall, a fresh valuation elsewhere, or challenge; a price change is reported to the lender and can change the offer. |
| Lender approval needed | anything the lender must be told | exchange | lender confirms; new lender | **Raised by the machine** off a price change, indemnity or retention. |

### Deposit and completion money

| Kind | Arises from | Holds | Ways out | What people report |
| --- | --- | --- | --- | --- |
| Deposit issue | below 10%; funded up the chain; not in cleared funds; a gift not yet evidenced | exchange | deposit arrangement agreed; funds in place; evidence | A reduced deposit needs the seller's agreement in the contract. |
| Completion funds shortfall | client balance short: SDLT underestimated, a bonus or ISA not released, a chain shortfall | completion | funds in place; evidence | Before exchange a plan; after exchange a completion failure in waiting. |
| Lender funds delayed | COT sent late, a condition unsatisfied, the lender's cut-off missed | completion | received; completed late | Most lenders need the certificate of title five working days before completion; the funds wait timer chases from day 2. |

### Parties and chain

| Kind | Arises from | Holds | Ways out | What people report |
| --- | --- | --- | --- | --- |
| Chain dependency | top or bottom of the chain not ready | exchange | chain ready; dates re-planned | Agents say "ready" a week before solicitors are; a link dropping out costs ~10 weeks; the collapse is often found on exchange day. Fatal → abandoned (chain collapsed). |
| Seller delay | protocol forms, signed contract, documents, instructions not returned | exchange | received; dates re-planned; accept | The commonest reason a matter sits: nothing is wrong, someone is not doing it. |
| Buyer delay | our client: survey, documents, deposit, application | exchange | received; dates re-planned | Recorded so the file shows who was waiting for whom. |
| Third-party consent required | licence to assign, management company, chargee, Help to Buy redemption, shared-ownership provider | exchange | consent; accept | Third parties work to their own clock and fee; Help to Buy needs a RICS valuation and 4–6 weeks. |
| Document execution problem | unwitnessed deed, a party as witness, wrong name, an e-signature the other side or HMLR rejects, a signatory abroad | exchange (completion after exchange) | re-executed; evidence | Re-execution is the only fix and takes as long as the post. |
| Occupier consent required | an adult occupier who must sign a consent / deed of postponement | exchange | consent; condition satisfied | A standard mortgage condition; the occupier is advised separately. |
| Probate issue | grant not issued; executors not all signing; intestacy | exchange | grant obtained; evidence | Everything but exchange can proceed; the grant takes 12 weeks to many months. |
| Power-of-attorney issue | LPA unregistered; capacity in doubt; attorney beyond authority | exchange | attorney verified; evidence | HMLR and lenders want the registered LPA and evidence it is still valid. |
| Bankruptcy / insolvency issue | a K16 hit against the buyer; a bankruptcy restriction on the seller's title; a company seller in liquidation | exchange | insolvency cleared; evidence | A hit against a borrower stops the lender; a trustee must sign for an insolvent seller. |

### The property itself, and completion

| Kind | Arises from | Holds | Ways out | What people report |
| --- | --- | --- | --- | --- |
| Survey defect | damp, roof, subsidence, electrics, asbestos, timber, knotweed, spray foam | exchange | price; works before exchange; retention; specialist report; accept | Most renegotiations settle at 1–5% off; the seller may refuse and the buyer walks. Fatal → abandoned (survey). |
| Environmental risk | environmental / flood / mining / radon reports | exchange | evidence; lender confirms; specialist report; price; accept | Flood risk must be reported to the lender; insurability is the practical test. |
| Third-party arrangement | solar-panel roof lease, septic tank, overage, s.106, rentcharge, assignable guarantees | exchange | evidence; lender confirms; works; indemnity; accept | A solar lease must be assignable and lender-acceptable. |
| Document missing | FENSA / gas / electrical certificates, guarantees, EPC, decision notices | exchange | received; evidence; indemnity; accept | Often a cheap indemnity or acceptance; sometimes the first sign of a bigger regs problem. |
| Disclosure concern | TA6 contradicting the survey or searches; an undisclosed dispute | exchange | evidence; price; accept | Misrepresentation exposure after completion (*Rosser v Pacifico*): further enquiries first, then advice. |
| Completion failure | lender funds late, CHAPS cut-off missed, chain money not through, keys not released | completion | completed late; funds in place | Late-completion interest under the standard conditions; a notice to complete (ten working days, time of the essence) if it slips further. |
| Other | anything else | exchange | any | |

## Worked scenarios (each is a test)

1. **Survey → renegotiation → lender.** Agreed price recorded. The survey lands in
   pre-contract: damp and a roof at end of life. `raise_issue(survey_defect)`. Searches,
   the offer, title and the report on title all proceed; the matter reaches pre-exchange
   with the deposit in but `exchange_conditions_met` is *not* derived and
   `contracts_exchanged` is refused, naming the issue. The handler marks it negotiating
   ("client asked for £10k off"). Resolving with `grant_obtained` is refused (not a
   survey outcome); `price_reduced` without a price, or with a higher price, is refused;
   automation cannot resolve it. `price_reduced` at £315,000 records `price_changed` and
   raises `lender_approval` (system, origin = the survey issue), which now holds exchange.
   `lender_confirmed` releases it: `exchange_conditions_met` derives in the same command
   and exchange goes through.
2. **Down-valuation → new lender.** `valuation_issue` resolved `new_lender` records
   `mortgage_offer_withdrawn`; the sub-flow is `awaiting`, exchange is blocked; the new
   offer is judged afresh. Resolved `buyer_covers_shortfall` instead: no side effects.
3. **Missing building regs → indemnity.** Lender-funded: `indemnity_policy` raises
   `lender_approval`. Cash: it does not.
4. **Indemnity as a decision option.** Choosing `indemnity` on a flagged CON29 on a
   lender-funded matter raises `lender_approval` citing the search.
5. **Chain not ready.** Raised with the deposit already in and conditions met: exchange is
   refused. Releasing the hold needs a note; released, the issue stays open but holds
   nothing. Withdrawn issues cannot be resolved. Exchange proceeds.
6. **Fatal.** `mark_issue_fatal` on a chain issue emits `issue_fatal` + `matter_abandoned`
   (`chain_collapsed`) in one command; the matter is closed.
7. **After exchange.** Issues default to holding completion; `completion_confirmed` is
   refused while one holds; the price cannot be reduced; `completed_late` resolves a
   completion failure.
8. **Stale.** A gifted-deposit evidence issue untouched for eleven working days is raised
   once as an escalation with a dossier; a second tick does not repeat it; an update
   restarts the clock; a resolved issue is never stale.
9. **Readiness and price.** Milestones never gate; a renegotiated price on a lender-funded
   matter raises `lender_approval`.

## Second edition: what was added

- **Party**: an issue can say who it concerns (`party`, free text) for matters with more
  than one buyer or a named third party.
- **Cost of the fix**: `resolve_issue` takes `costPennies` and `paidBy` (buyer / seller /
  shared / lender / other), shown in the history and the closed list.
- **Enquiry from an issue**: `raise_enquiry` accepts `origin.issueId`; the enquiry id is
  derived (`ISS-3-E1`), the issue tracks its enquiries and its clock restarts.
- **Leasehold as a transaction type** (`leasehold_purchase`): the management pack (LPE1)
  sub-flow gates pre-contract (requested → chased from day 10 → received → always a
  decision); lease facts on the title (unexpired term, ground rent, review clause) flag
  short leases and doubling rents; a title whose tenure does not match the enrolment halts
  automation; notice of assignment is recorded after completion.
- **Proof of funds** (docs/proof-of-funds.md): sign-off resolves `source_of_funds` issues
  and raises `lender_approval` for a gift.

## What is still not modelled

- **Issue → enquiry reply**: the enquiry's reply resolves the enquiry, not the issue; the
  handler resolves the issue with what the reply established.
- **Leasehold extras**: the landlord's licence to assign and the deed of covenant are
  `third_party_consent` issues, not sub-flows; lease extension is an issue outcome, not a
  flow.
- **LEAP**: issues are engine state; they are written back to LEAP as file notes through
  the same `ConclusionSink` as everything else, and a LEAP task could raise one once the
  trigger is mapped (`triggers.ts`).
