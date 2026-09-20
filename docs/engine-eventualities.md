# Eventualities: how a purchase really goes, and what the machine does about it

The state machine was specified for the happy path of a residential freehold purchase.
This document walks the ways a real matter departs from it — by transaction shape, by
stage, and across stages — and records for each: how a conveyancer acts, what the
machine does today, and where the gap was and how it was closed. It is the reference
the read-only map at `/engine/map` draws its "eventualities" panel from
(`lib/server/engine/spec.ts` → `EVENTUALITIES`).

Legend for the *Handling* column — **built**: the machine models it and it is tested in
`tests/unit/engine/eventualities.test.ts` or the lifecycle tests; **manual**: the machine
stops automation (`manual_handling_required`) and a person runs the matter from there;
**outside**: happens in the practice system (LEAP / CaseLightning) and does not need the
engine; **gap**: not modelled — design note given.

Several gaps recorded in the first edition (price renegotiation, survey findings,
down-valuations, gifted deposits, chains, funding shortfalls, completion-day failures)
have since been closed by the **issues layer** — see `docs/engine-issues.md`.

## 1 · Transaction shapes

| Shape | How the conveyancer acts | Handling | Notes |
|---|---|---|---|
| Cash purchase | No lender; no offer, no lender funds, no undertaking to lender; source-of-funds evidence matters more | **built** | `enrol.hasLender=false` → mortgage sub-flow `not_required`; `funds_requested` from `lender` refused; completion funds come from the client only. |
| Mortgage purchase | Offer must arrive, be checked (special conditions, retention, expiry) and be current at exchange; CML/UK Finance handbook duties to the lender; lender funds requested for completion | **built** | Offer sub-flow; expiry checked at extraction *and* by the deadline timer; withdrawal reopens the sub-flow and blocks exchange. |
| Chain (dependent sale) | Exchange is simultaneous up and down the chain; target dates move constantly; a collapse above or below aborts | **built / outside** | Target dates re-planned with `set_target_dates`; collapse → `abandon_matter(chain_collapsed)`. The chain itself (who is ready) is not modelled — it is a coordination problem the handler runs by phone. |
| No chain / first-time buyer | Faster; buyer often less experienced — more client questions | **built** | Client Q&A is guarded (component #5): only FAQ answers go out unreviewed. |
| Two or more buyers | Each buyer needs ID/AML and source-of-funds; joint ownership advice (joint tenants / tenants in common) is a report-on-title point | **gap (partial)** | One ID sub-flow per matter today. Design: key `idCheck` by party (`state.idChecks[partyId]`) and gate `instruction` on *all* parties; the ID provider port already takes a party. Until then, the second buyer's report is filed as a second ID document and the handler notes it on the first decision. |
| Company buyer / buy-to-let | Companies House checks, directors' ID, often lender special conditions; SDLT surcharge | **manual** (by policy) | `mark_manual_handling('company_buyer')` from the enrolment UI; extraction and searches still run. |
| Gifted deposit | Gift letter, donor ID and source of funds, lender must be told | **gap** | Not modelled. Design: a `gift_declared` event with donor party → an ID sub-flow for the donor and a lender-notification note; the report on title drafter should cite it. |
| Help to Buy ISA / Lifetime ISA | Bonus claim after exchange, before completion; funds arrive from the ISA provider | **gap** | Design: a third `fromRole` for `funds_requested` (`isa_provider`) and a wait with a short SLA. |
| New build | Reservation, developer's pack, long-stop dates, incentives disclosed to lender, retention for snagging, first registration | **manual** (by policy) | Out of v1 scope (spec 2.7). The searches/title sub-flows still apply once instructed; the handler runs the developer side. |
| Auction purchase | Legal pack pre-auction, exchange at the fall of the hammer, 28-day completion | **manual** | The order of events is inverted (exchange first). Not v1. |
| Shared ownership / Right to Buy / lease | Leasehold | **manual** | `title_extracted` with tenure ≠ freehold → `manual_handling_required(leasehold_unsupported)` automatically. |
| Probate seller | Grant of probate must be seen before exchange; delays | **built (as enquiry)** | Raised as an enquiry to the seller's solicitor; the chase/escalate timers do the rest. |
| Unrepresented seller | Extra care, ID of the seller, no undertakings possible | **manual** | Handler flags it; the machine's chase templates assume a solicitor on the other side. |
| Internal counterparty (both sides in the firm) | Ethical wall; same event pair as an external exchange | **built** | Addendum 1. |
| Related-party / transfer of equity | Not a purchase | **outside** | Not enrolled (enrolment policy). |

## 2 · Instruction stage

| Eventuality | How the conveyancer acts | Handling | Notes |
|---|---|---|---|
| ID check comes back "refer" (PEP, address mismatch) | Ask for more documents or an enhanced check; if unresolvable, decline to act | **built** | `id_check_flagged` decision: approve / request further / escalate / **reject** — reject halts automation (`id_check_rejected`). |
| ID check never comes back (client slow) | Chase the client, then escalate | **built** | `id_check` wait: chase at 3 wd, every 2, escalate at 7. |
| The firm ordered the ID check from LEAP / InfoTrack directly | The result lands in the file before the engine asked for it | **built** | `routeByHint` records `id_check_requested` (actor `external`, "arrived via LEAP") first so the log stays truthful. |
| Client care letter unsigned, no money on account | Do nothing chargeable | **outside** | A practice-management gate, not an engine gate; enrol when instructed. |
| Conflict check fails | Decline | **built** | `abandon_matter(conflict)`. Internal-counterparty conflicts (same handler both sides) are refused at the database (addendum 1). |
| Handler changes (holiday cover, leaver) | Reassign the file; the queue follows the assignee | **built** | `record_handler_change` puts it on the log; the matter row / LEAP responsible staff is the live assignment. |

## 3 · Pre-contract: searches, enquiries, mortgage offer

| Eventuality | How the conveyancer acts | Handling | Notes |
|---|---|---|---|
| Search result flags something (enforcement notice, road not adopted, flood zone) | Raise an enquiry, refer to the client, get an indemnity policy, or accept as standard | **built** | Options: approve / refer to client / request further (raises a tracked enquiry) / **indemnity** / escalate. |
| Search result unreadable (bad scan, wrong document) | Read it yourself | **built** | Extraction confidence < 0.85 → flagged with a "check the source" summary; never guessed. |
| Search result re-issued, or the lender requires searches under 6 months old at exchange | Re-order; a fresh result is a fresh review | **built** | `record_search_ordered` on a resolved search starts cycle 2; the re-ordered search gates `contract_review` and `pre_exchange` again and blocks exchange. |
| Search never comes back / provider down | Chase the provider; order elsewhere; record the order by hand | **built** | `search` wait (chase at 10 wd, escalate at 18); manual `record_search_ordered` fallback; InfoTrack outage does not stall the matter. |
| Extra searches needed (chancel, mining, highways, flood) | Order them | **built (partial)** | Only the types in `SEARCH_TYPES` are modelled; others are filed as documents and noted. Design: make `requiredSearches` extensible per tenant. |
| Personal vs official local search | Lender may insist on official | **outside** | Provider choice; same sub-flow. |
| Seller's replies partial / evasive | Raise further enquiries; go round again | **built** | `enquiry_reply_flagged` → request further raises `SEARCH-F1`-style follow-ups with origin; each is its own wait. |
| Seller refuses to answer | Advise the client; indemnity; walk away | **built** | `withdraw_enquiry(reason)` closes the wait (status `withdrawn` counts as resolved); or `abandon_matter`. |
| Replies arrive by email, portal, TA6/TA10 forms | File them | **built** | Classifier / LEAP hint → `enquiry_reply`; a reply that cannot be matched to exactly one open enquiry is *not* guessed — it is reported for a person to file with an explicit id. |
| Mortgage offer with special conditions (retention, works, insurance) | Check each; tell the client; sometimes renegotiate | **built** | `mortgage_condition_flagged` decision; standard boilerplate clears. |
| Offer expiry near the target exchange date | Ask the lender to extend / re-issue | **built** | Flagged at extraction if near; the deadline timer raises it once, 15 working days out, whatever the target date. |
| Offer withdrawn / lapsed (down-valuation, change of circumstances) | Get a new offer before exchange | **built** | `mortgage_offer_withdrawn` → status `awaiting`; exchange blocked; the next offer is judged afresh. |
| Lender changes | New offer from the new lender | **built** | Same as re-issue; the lender name is on the new offer's facts. |
| Cash purchase becomes a mortgage purchase (or vice versa) | Re-plan | **gap** | `hasLender` is fixed at enrolment. Design: `lender_status_changed` event that flips it and reopens/closes the mortgage sub-flow. |
| Price renegotiated (survey, down-valuation) | New memorandum of sale; SDLT recalculated; offer may change | **gap** | Price is not a machine fact (it lives in the practice system). Design: `price_changed` event feeding the report on title and the SDLT calculation. |
| Survey reveals defects | Renegotiate, further enquiries, or withdraw | **built (as enquiry)** | Survey is not a sub-flow (it is the client's); its consequences are enquiries or abandonment. |

## 4 · Contract review: title and the report on title

| Eventuality | How the conveyancer acts | Handling | Notes |
|---|---|---|---|
| Restriction, charge, covenant on the register | Consent, discharge undertaking, indemnity, or advise | **built** | `title_flagged` with the register entry cited; options include **indemnity**; request further raises an enquiry. |
| Title turns out leasehold / unknown tenure | Manual | **built** | Automatic `manual_handling_required`. |
| Boundary / plan discrepancies | Enquiry; possibly a statutory declaration | **built (as enquiry)** | |
| New information after the report was sent | Supplemental report | **manual** | `title_extracted` after `report_on_title_sent` is refused ("needs manual handling"): a re-review after the client has been advised is a person's job. |
| Report on title draft rejected by the handler | Re-draft | **built** | `report_on_title_rejected` → a new draft can be requested; the log keeps every draft. |
| Client questions after the report | Answer them | **built** | Guarded Q&A (#5): FAQ-only auto-answers; anything else to the handler. |

## 5 · Pre-exchange and exchange

| Eventuality | How the conveyancer acts | Handling | Notes |
|---|---|---|---|
| Deposit less than 10%, or held to order / by the agent | Agree in the contract | **outside** | `deposit_received` records receipt; amount is informational. |
| Simultaneous exchange and completion | Exchange and complete on the same day | **built** | `contracts_exchanged` with `completionDate` = today, then the completion commands. |
| Exchange deferred (chain, offer, client) | Re-plan | **built** | `set_target_dates`. |
| Gazumping / gazundering / chain collapse / client withdraws | Abortive | **built** | `abandon_matter` with the reason; waits close, timers stop, the matter leaves the queue; only corrections may follow. |
| Deposit funds late | Chase the client | **gap (partial)** | The `funds` wait covers completion funds, not the deposit. Design: open a `deposit` wait when the target exchange date is within 5 working days. |

## 6 · Exchanged → completion

| Eventuality | How the conveyancer acts | Handling | Notes |
|---|---|---|---|
| Completion date moved by agreement | Vary the contract | **built** | `change_completion_date` (after exchange only). |
| Notice to complete served (either side) | Ten working days to complete or lose the deposit / rescind | **built** | `notice_to_complete_served` is a decision citing the notice; the deadline timer raises it two working days out. |
| Lender funds late | Chase the lender; warn the other side | **built** | `funds` wait (chase at 2 wd, every 1, escalate at 4). |
| Client's balance short | Chase; delay | **gap (partial)** | Amounts are informational. Design: `completion_statement_generated` carries the expected balance; `funds_received` below it opens a shortfall decision. |
| Seller's solicitor's bank details "change" | Hard stop; verify out-of-band | **built** | Addendum 2. |
| Completion statement wrong | Regenerate | **built** | `completion_statement_generated` can be recorded again (last wins). |
| Keys / undertakings on the day | Phone calls | **outside** | |

## 7 · Post-completion

| Eventuality | How the conveyancer acts | Handling | Notes |
|---|---|---|---|
| SDLT return and payment within 14 days | File and pay | **built** | Deadline timer raises it 5 working days before the 14-day limit. |
| AP1 lodged; HMLR raises a requisition | Answer by the deadline or lose priority | **built** | `hmlr_requisition_received` → `requisition` decision citing the letter; blocks `ap1_confirmed`; deadline timer 5 wd out. |
| Registration slow (months) | Chase HMLR; expedite if there is a reason | **built** | `registration` wait (chase at 30 wd, escalate at 60). |
| OS1 priority period expiring before completion/registration | Re-search | **gap** | The OS1 date is not modelled. Design: `priority_search_made(expiresAt)` → deadline. |
| Lender / client notified of registration; file closed | Admin | **outside** | `ap1_confirmed` ends the matter. |

## 8 · Cross-cutting

| Eventuality | How the conveyancer acts | Handling | Notes |
|---|---|---|---|
| Documents arrive in any order (search before the ID check clears) | File them as they come | **built** | LEAP sync marks the document PENDING and retries every sync; the native app's ingest hook does the same through `routeByHint`. |
| Same document filed twice / re-issued version | Keep the latest | **built** | Idempotent on the provider/LEAP id; a re-issue is a new order cycle. |
| Mis-filed document (a survey classified as a search) | Correct it | **built** | Classification below 0.8 confidence is not acted on; a wrong action is corrected with `record_correction` (the log is never edited) and a re-order. |
| Something recorded in error | Compensate, never edit | **built** | `correction_recorded` with `causedByEventId` on the wrong event; the audit report lists corrections. |
| Backdating (the event happened days ago) | Record now, say when | **built (partial)** | Payloads carry the real date where it matters (`exchangedAt`, `completedAt`, `servedAt`); `createdAt` is always when the log heard. |
| Working days, bank holidays | Timers count working days in England & Wales | **built** | `working-days.ts`. |
| Shadow mode / trust levels | Watch before acting | **built** | Addendum 3. |
| Two firms' systems (LEAP, our own app) | Same engine, different backends | **built** | `lib/server/engine/backend.ts`. |

## What changed in the machine for this document

New commands (all people-recorded unless stated): `abandon_matter`, `set_target_dates`,
`change_completion_date`, `notice_to_complete_served`, `mortgage_offer_withdrawn`,
`withdraw_enquiry`, `hmlr_requisition_received`, `record_correction`,
`record_handler_change`; `raise_deadline_escalation` (timer). New events: one per
command plus `hmlr_requisition_responded`. New decision kind `requisition`; new option
`indemnity` for search and title decisions. New gates: re-ordered searches block
`contract_review`, `pre_exchange` and exchange itself; a withdrawn offer blocks exchange
and `exchange_conditions_met`; an open requisition blocks `ap1_confirmed`. New timers:
deadlines (`sla.ts → deadlineActions`) for offer expiry, SDLT, notice to complete and
requisition replies — raised once each, in time, with a dossier document as the source.

**Issues layer** (second edition, `docs/engine-issues.md`): commands `raise_issue`,
`update_issue`, `resolve_issue`, `withdraw_issue`, `mark_issue_fatal`,
`record_price_change`, `contract_approved`, `signed_contract_held`; events `issue_*`,
`price_changed`, `contract_approved`, `signed_contract_held`; an open issue holds exchange
or completion; resolutions with effects (price change, lender approval, offer reopened);
the `stale_issue` timer.
