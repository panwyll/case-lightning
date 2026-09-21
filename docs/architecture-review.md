# Architecture review — the spec against the code

A section-by-section audit of the product architecture against what is actually in this
repository. Status is one of **BUILT**, **PARTIAL** or **ABSENT**, and "partial" always
says which half is missing. Nothing here is aspirational: every BUILT claim names the file
that does it and, where it matters, the test that holds it in place.

| § | Capability | Status |
|---|---|---|
| 1 | Coarse lifecycle + concurrent workstreams | **BUILT** |
| 2 | Requirements, gates, dependencies, "why can't this progress?" | **BUILT** |
| 3 | Issues as first-class primitives | **BUILT** |
| 4 | Events and evidence with provenance | **PARTIAL** |
| 5 | Email operating modes (Full / Assisted / LEAP-first) | **PARTIAL** |
| 6 | Mailbox delegation, paralegal triage | **PARTIAL** |
| 7 | Case-aware email drafting from the case model | **BUILT** |
| 8 | DO → WAITING → CHASE → ESCALATE | **BUILT** |
| 9 | Proactive stakeholder communication | **PARTIAL** |
| 10 | WhatsApp onto structured state | **BUILT** (status), **ABSENT** (decisions) |
| 11 | Calls: capture → transcript → structured events | **PARTIAL** |
| 12 | Link notes to matter, dictated, into the pipeline | **PARTIAL** |
| 13 | Unified information intake | **PARTIAL** |
| 14 | Document generation, four levels | **PARTIAL** (L1 + L4) |
| 15 | Canonical matter data | **PARTIAL** |
| 16 | Caseload map | **BUILT** |
| 17 | Case intelligence view | **BUILT** |
| 18 | Personal work view | **BUILT** |
| 19 | Morning / end-of-day operating model | **BUILT** |
| 20 | Human authority per requirement | **BUILT** |
| 21 | Auditability and safety | **BUILT** |
| 22 | Overall product experience | on the stated line |

---

## What is built

**§1 · §2 · §3 — the case model.** The coarse lifecycle is `LIFECYCLE` in
`engine/graph.ts`, with a no-exchange variant for remortgages and transfers of equity.
Concurrent workstreams (`workstreams()`) each carry their own status; there is no combined
mega-state anywhere. Gates are `requirements()` + `gate()`, each requirement knowing its
completion authority and exactly what blocks it, so `whyNot()` always answers "why can't
this progress?". Issues are 45 reusable primitives in `engine/issues.ts`, each with
severity, affected workstreams, what it threatens, standard actions, responsible party and
escalation clock — combinations, not bespoke workflow branches.

**§7 — drafting from the case model.** The drafter now leads with the engine's own account
of the matter. `renderForDrafting(caseBrief(state))` (`engine/brief.ts`) puts workstream
states, everything outstanding with its age and chase count, open issues, pending
decisions, dates and the client's recorded decisions at the top of the prompt, ahead of
the retrieved correspondence, and ends with "do not state anything about this matter that
is not above or in the thread". Retrieved chunks are what was *said*; the brief is what is
*true*.

**§8 · §18 — DO → WAITING → CHASE → ESCALATE.** `engine/work.ts` derives all four from
state, so no one grooms a task list. WAITING carries who owes it, when we asked, their
turnaround, the countdown, chases sent, when it escalates, and — separately — the
fee-earner accountable. The clock moves items: WAITING → CHASE when the chase falls due,
→ ESCALATE when chasing has failed or a date we owe is close.

**§9 · §10 — the client hears from us without asking.** A chase to a third party now pairs
with a client update ("we are still waiting for the seller's solicitor… we chased them
again today… there is nothing you need to do"), once per matter per day, never when the
person being chased is the client, and never while an issue holds the matter. And "any
update?" is answered from the case itself — `clientStatusAnswer()` composes what is
complete, who we are waiting on, when we last chased and when we chase next, entirely
deterministically. **No model writes that answer**, and it refuses outright — fetching a
person instead — whenever the case holds a gate-blocking issue, a critical issue, a
payment hard stop, or reads blocked/critical. A reassuring automated summary is exactly
the wrong thing to send on a case with a live legal problem.

**§16 · §17 · §19 — the surfaces.** `/cases` is the caseload as houses on paper; a matter
opens on case intelligence; `/today` is the operating model — every active matter is
evaluated and what comes back is `200 active · 23 need you today · 7 at risk · 170
progressing`, three disjoint groups that add up, plus the prioritised list. `?end=1` is
the wind-down: what is still open, what the timers will chase tomorrow, which dates land
this week.

**§20 · §21 — authority and audit.** Every requirement declares who may satisfy it
(`authority`, `humanConfirmationRequired`). The event log is append-only *at the database*
(a trigger refuses DELETE), hash-chained, and three events cannot be written without a
named human approver. Shadow mode records what the engine would have done without doing
it. "Observed" and "determined" are different events.

---

## What is partial, and precisely which half

**§4 — provenance.** Every engine event carries its source document, confidence and actor,
and a decision cannot be resolved without opening the source. What is missing is the other
input types: a call transcript, an internal note or a WhatsApp message does not yet
*become* an engine event, so "why does CONVEYi think this?" can always be answered for a
document and not yet for a conversation.

**§5 — operating modes.** All three modes exist as machinery but none exists as a named,
per-tenant setting. LEAP-first is real (`backends/leap.ts`, selected by
`leapBackendActive()`) but env-driven and global. Assisted filing is real (manual file-email
routes) but is not modelled as a mode; the only toggle is per-user `auto_triage_enabled`.
A firm that refuses mailbox access can be served today, but by configuration rather than by
choosing a mode.

**§6 — paralegal triage.** Triage, matching and filing exist. What is missing is the last
step of the spec's sentence: once an email is associated with a matter, its *content* does
not become engine events. Documents do; the email itself does not.

**§9 — stakeholders beyond the client.** Agents, brokers and other stakeholders have no
approved update path, and there is no policy object expressing who may receive what. The
suppression that exists is per-sub-flow trust plus shadow mode, not a disclosure policy.

**§11 · §12 · §13 — intake.** Calls are better served than the spec assumes: record →
Whisper transcript → summary → assign to matter → OneDrive + RAG + timeline, with audio
deliberately not retained. The gap is the last hop: nothing extracts
`CLIENT_SURVEY_SATISFIED`, `MORTGAGE_UPDATE_EXPECTED: Friday` or "chase the seller's
solicitor tomorrow" into the case model. Typed or dictated **internal notes have no API at
all** — the only note-shaped object is a call note. So the unified intake picture is real
for documents, and aspirational for calls, notes, email bodies and WhatsApp.

**§14 — document generation.** Level 1 (static merge over a 14-key allow-list) and level 4
(`[[AI section]]`, premium-gated) exist. Levels 2 and 3 — conditional approved sections and
data-driven documents built from case facts, search results and title data — do not. The
AI pass is also given only those same 14 flat variables, so it cannot yet write about the
case it is documenting.

**§15 — canonical matter data.** `caseBrief()` is now the single read model for everything
the *engine* knows, and three features share it. But the matter row, `matter_summary.facts`
and the engine state are still three places a fact can live, and the drafter reads all
three.

---

## What I would do next, in this order

1. **Notes and call transcripts into the engine (§11–13).** The highest-value missing
   piece, and the one the rest leans on. A typed or dictated note gets an API, lands as
   evidence, and an extractor proposes engine events — the client's decision, a commitment
   with a date, a task — which a person approves. That single pipeline then serves calls,
   notes and eventually email bodies, and closes the §4 provenance gap.
2. **Document generation levels 2 and 3 (§14).** Conditional approved sections driven by
   case facts, and data-driven reports fed from the brief rather than 14 flat strings.
   Largely deterministic engineering, and it removes the biggest remaining manual chunk of
   a conveyancer's day.
3. **Operating modes as a real setting (§5).** Name the three, make them per-tenant, and
   show the firm which one it is in. Mostly consolidation of things that already exist,
   but it is what an InfoSec review will ask about.
4. **A communication policy object (§9).** Who may receive what, on which events, and
   whether sending is automatic. Today that judgement is spread across template choice,
   sub-flow trust and shadow mode.
5. **WhatsApp decisions (§10).** Collecting a simple client decision over the channel that
   already answers them, retained as an event with the message as evidence.

## The claim to test, not assume

The spec is right to flag it: "one conveyancer can safely run 200 matters" is a hypothesis.
What the product can now show is the arithmetic behind it — `/today` reports how many of
the caseload actually needed a person on a given day, and the event log records what the
engine did unaided. Running a firm in shadow mode for a month would produce a real number
instead of a claim.
