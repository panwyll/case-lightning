# The case model: the design spec checked against the build

This document takes the fifteen points of the "conveyancing case model and read-only
visualisation" design spec one by one, says what the engine already did, what was changed
or added to meet the point, and what is deliberately different. The code it refers to is
`lib/server/engine/graph.ts` (the projections), `machine.ts` (what is enforced),
`issues.ts` (the taxonomy with behaviour), `sla.ts` (time), and the two views at
`/engine/<matterId>` (Readiness, Dependencies).

The one-sentence principle from the spec — *a coarse case lifecycle orchestrating several
concurrent state machines, connected by requirements and gates, with dynamically created
issues modifying a dependency graph* — is now literally what `caseGraph()` returns.

## 1 · Coarse case lifecycle, separate from the detailed work

**Built.** `lifecycle(state)` gives INSTRUCTED → PRE-EXCHANGE → READY TO EXCHANGE →
EXCHANGED → PRE-COMPLETION → COMPLETED → POST-COMPLETION → CLOSED, with ABORTED as the
exception state. READY TO EXCHANGE is a **derived gate state**, not a step a person moves
to: it reads true when every applying exchange requirement is satisfied. CLOSED is new
(`close_matter`: only after registration, the leasehold notice, and with no open issues).

**Deliberately different.** Underneath, the engine keeps its finer stages
(`pre_contract`, `contract_review`, `pre_exchange` inside PRE-EXCHANGE). They are not
"progress encoded in the state" in the sense the spec warns against — no
`SEARCHES_COMPLETE_AML_PENDING` — but they do sequence three things: searches, enquiries
and the offer resolve before the report on title is drafted; the report goes before the
deposit derives exchange conditions. That sequencing is what a conveyancer actually does
(the report summarises the searches), so it stays; the lifecycle hides it. If a firm's
practice differs, the phases can be collapsed without touching the workstreams or the
requirements — everything above the stage reads from `requirements()`, not from the stage.

## 2 · Concurrent workstreams, each with a small state machine

**Built.** `workstreams(state)` projects fourteen lanes — ID/AML, source of funds, title,
searches, enquiries, mortgage/lender, survey/physical condition, leasehold, contract,
deposit, chain, report on title, completion, registration — each with a status
(not started / in progress / awaiting / under review / blocked / at risk / complete /
n/a), a one-line detail, its open issues, pending decisions and waits. Ten of them are
the engine's own sub-flows with their event pairs (requested → returned/extracted →
cleared or flagged → reviewed; enquiries loop through "request further"). Three are new
in this round:

- **Survey / physical condition** (§7 below): `survey_received` → further investigation
  issues → `specialist_report_received` (loops) → awaiting client → client satisfied /
  renegotiating.
- **Contract**: approved → signed part held → exchanged (readiness milestones, advisory).
- **Chain**: described only by issues (the chain is coordination, not state the engine can
  observe), which is the spec's own suggestion.

The enquiries lane is the spec's example almost exactly: NOT_STARTED → RAISED →
AWAITING_REPLY (a wait with chase/escalation timers) → REPLY_RECEIVED → REVIEWING (a
decision) → SATISFIED, with "request further" creating the follow-up and looping. There is
no DRAFTING state: the engine records an enquiry when it is raised.

There is no combinatorial global state; the case state is the lifecycle plus the set of
lanes, and the gates below synchronise them.

## 3 · Gates that synchronise concurrent work, and "why is this not ready?"

**Built.** `requirements(state)` is the list of requirements per gate (exchange,
completion, registration, close), each with `applies`, `satisfied`, `satisfiedAt`,
`authority`, `humanConfirmationRequired`, and `blockedBy` — typed blockers (issue,
decision, wait, client decision, policy, fact) that trace exactly why. The exchange gate
requires: ID/AML passed, source of funds satisfactory, title satisfactory, searches
satisfactory, enquiries satisfied, valid mortgage offer, management pack reviewed
(leasehold), report on title approved and sent, client satisfied with the physical
condition (where a survey exists), no unresolved blocking issue, deposit confirmed,
contract signed (advisory), client authorises exchange (policy). `whyNot(state,
'exchange')` answers the spec's question in one line per requirement:

```
Valid mortgage offer: offer not yet received (or withdrawn)
No unresolved blocking issue: Survey defect: Client wants to renegotiate after the survey (open, warning)
Client satisfied with the physical condition: the client is renegotiating
```

`gate()` also returns the machine's own stage blockers next to the requirement view, so
the two can be checked against each other (the tests do), and each gate depends on the
ones before it.

## 4 · Unexpected problems as first-class issues, in a reusable taxonomy

**Built earlier; extended.** Forty-five kinds in eleven groups (docs/engine-issues.md),
covering every example in the spec's list. Unusual cases are chains of ordinary issues:
`raise_issue` takes `causedBy`, the survey chain sets it automatically (an electrician's
report recommending a structural check chains a new issue off the old one), and the
lender-approval issue carries `origin`. The graph draws these as DISCOVERED_BY edges and
the Dependencies view lists the chains. The spec's example — early occupation → freeholder
consent → title defect → delay → offer expiring — is representable today as
`third_party_consent` → `title_defect` (causedBy) → the timer's `mortgage_offer_expiring`.

## 5 · Issues carry behaviour

**Built.** Every kind now defines: group (category), default **severity**
(info/warning/critical), the **workstreams** it affects, the milestones it **threatens**
(exchange / completion / registration), the **standard actions** in order, the
**responsible party** (conveyancer, client, seller's side, lender, third party, MLRO),
the **escalation** period after which the timer raises the severity one step, plus the
existing gate effect, realistic resolutions and the arises-from / practice notes. The
spec's worked example is implemented literally: *mortgage offer expiring* — trigger:
expiry within 30 days; workstream: mortgage; severity: warning; threatens: exchange and
completion; actions: contact broker/lender, determine extension requirements; escalation:
critical at 14 days; resolution: extended / replacement offer received (the issue closes
itself when a different offer is on file or contracts exchange inside the offer).
Detection rules live in `sla.ts` (time) and `machine.ts` (facts from documents); an
instance carries its own severity, which a person or the timer can move.

## 6 · Time as a source of events

**Built.** `timedIssueActions(state, now)` in `sla.ts`, run first on every tick:

- mortgage offer VALID → EXPIRING (issue, warning, 30 days) → CRITICAL (14 days) →
  EXPIRED (the timer withdraws the offer — the sub-flow reopens and exchange is held — and
  raises the critical `mortgage_offer_expired` issue);
- a search or an enquiry past its escalation point becomes a `search_delayed` /
  `enquiry_unanswered` issue (informational: the wait already gates), and the timer
  closes it when the thing arrives;
- an issue nobody has touched for its kind's escalation period goes up a severity (a
  severity change is not "movement", so the stale clock keeps running).

These sit alongside the existing working-day chase and escalation timers, the deadline
timers (offer expiry dossier, SDLT, notice to complete, requisitions) and the stale-issue
timer. Undertakings and lease expiries are not modelled.

## 7 · Facts separated from judgements

**This was the design of the engine from the start** (deterministic rules decide what is a
fact; every judgement is a decision a person resolves) and the survey example from the
spec now runs end to end, as a test:

Level 3 survey received → two recommendations for further investigation (a fact,
extracted) → two issues raised automatically → damp specialist's report: no evidence of
decay (a fact) → that issue resolved by the machine, `resolvedBy: system` →
electrician recommends a structural check (a fact) → a new issue chained → structural
engineer finds nothing → the survey lane reads AWAITING CLIENT → `client_decision_recorded
(physical_condition, satisfied)` by a **person** from the client's instruction → READY TO
EXCHANGE. The machine refuses `client_decision_recorded` from automation ("never
inferred"), and refuses "satisfied" while further investigation is outstanding.

## 8 · Every requirement defines its completion authority

**Built.** Each requirement carries `authority`: `system` (search received, ID cleared by
rule, deposit received, exchanged, completed, SDLT filed), `conveyancer` (title /
enquiries / source of funds / report on title / management pack / bank details /
requisitions), `client` (physical condition, authority to exchange) or `third_party`
(registration by HMLR), plus `humanConfirmationRequired`. The authority is derived from
what actually happened, not fixed: "title satisfactory" reads `system` when the rule layer
cleared the register and `conveyancer` when a person reviewed a flag.

Client decisions are a first-class command with a closed vocabulary
(`physical_condition`, `exchange_authority`, `accept_risk`, `accept_terms`,
`completion_date`), recorded on the log with the note and any evidence document. Two of
them gate exchange: satisfaction with the property (when a survey exists) and the client's
authority to exchange (firm policy `requireExchangeAuthority`, default on).

## 9 · State, event, task, requirement and issue kept distinct

**Built.** The log holds **events**; `project()` gives **state**; **decisions** are the
engine's tasks for a person (and are mirrored as native or LEAP tasks); **requirements**
are the new projection in `graph.ts`; **issues** are the typed layer. The spec's own
example maps directly: state `enquiries.E2 = raised`; event `enquiry_reply_received`
(from ingestion); automation extracts and rule-checks, producing `enquiry_reply_flagged`
with a decision; the conveyancer's task is that decision; the requirement "enquiries
satisfied" stays unsatisfied and names the decision in `blockedBy`; the title defect the
reply reveals is `raise_issue(title_defect, causedBy?)`, which blocks "title
satisfactory".

## 10 · Ingestion drives state where safe

**Built earlier; extended.** The classifier now recognises surveys, specialist reports
and management packs; the ingest router files a specialist report against the single open
further-investigation issue automatically and asks a person when there is more than one;
the extractor reads recommendations (with a "further investigation" flag per
recommendation) so the deterministic machine can move REPORT AWAITED → RECEIVED and raise
or resolve the issue, while AWAITING CLIENT CONFIRMATION stays until the client decides.
AI interprets; the rules transition.

## 11 · The case as a dependency graph

**Built.** `caseGraph(state)` returns nodes (case, gates, workstreams, requirements,
issues, decisions, waits, client decisions) and edges typed REQUIRES, BLOCKS, SATISFIES,
THREATENS, DEPENDS_ON, DISCOVERED_BY, RELATES_TO, RESOLVED_BY. The spec's examples hold:
`issue:title_defect —BLOCKS→ req:title_satisfactory ←REQUIRES— gate:exchange`;
`issue —THREATENS→ gate`; `ws:id_aml —SATISFIES→ req:id_aml_passed`. The UI diagrams are
projections of this graph, and the API returns it (`GET
/api/v1/matters/<id>/engine/graph`).

## 12 · Hierarchical sub-flow state machines

**Built.** Global rules apply at the case level: `abandon_matter` (seller withdraws, chain
collapse, gazumped…) and `close_matter` act on the whole matter; `manual_handling` pauses
automation across every lane; each sub-flow's own transitions are drawn once on the map
(`/engine/map` §2), not against every state.

## 13 · Two read-only projections

**Built.** `/engine/<matterId>` now opens on **Readiness** (the lifecycle strip; the case
health table — every workstream with COMPLETE / BLOCKED / AT RISK / UNDER REVIEW /
AWAITING and what it waits on; "Not ready to exchange because:" as a numbered list traced
to the blocker; the requirements table with who says so; "what needs to happen next" with
who and urgency) and **Dependencies** (gate ← requirements ← workstreams ← blockers, with
red blocks/threatens, green satisfies, purple discovered-by, and the issue chains listed).
Both are drawn from `/engine/graph`; nothing is dragged or maintained by hand. The Timeline
and Controls tabs remain.

## 14 · The happy path preserved

**Built earlier.** `machineSpec()` (`spec.ts`, drawn at `/engine/map`) is the canonical
model: stages, sub-flows, commands, events, decision kinds, timers, triggers, invariants,
issue catalogue. A matter is an instance that acquires issues, requirements (a survey makes
the physical-condition requirement apply; leasehold adds the management pack) and tasks
without the canonical model changing.

## 15 · The three questions

- **Where are we?** `lifecycle()` and `workstreams()`.
- **What is preventing us progressing?** `gate().unsatisfied` with `blockedBy`, and
  `whyNot()`.
- **What needs to happen next, and who has authority to say it has happened?**
  `nextActions()`: one line per blocker with who (conveyancer / client / seller's side /
  lender / third party / MLRO / system), what it unblocks, and urgency from the issue's
  severity.

## What is still not modelled, honestly

- **Undertakings and lease-expiry timers**, and **source of wealth** as its own enquiry.
- **Tasks as a first-class entity** beyond decisions: the engine emits decisions and the
  backends mirror them as tasks; ordinary to-dos (book the survey, send the client care
  letter) live in the practice system.
- **The finer stage spine** remains under the coarse lifecycle (§1).
- **DRAFTING** for enquiries, and per-buyer ID sub-flows (issues carry the party instead).
- The **thresholds** in issue behaviour (escalation days, 30/14-day offer warnings) are
  defaults for the head of conveyancing and the MLRO to tune.
