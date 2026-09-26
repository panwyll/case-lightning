# CONVEYi conveyancing engine — design & operator notes

The engine (`lib/server/engine/`) is the state machine that **runs** a residential
freehold purchase, buyer-side. It is the source of truth for where a matter is; the
AI layer, the dashboard and the chase-bot all read from and write to its event log.
This is the build of Part 2 of the CONVEYi spec; components #2–#8 exist as
clearly-marked ports + mocks so the machine can be developed and tested in isolation.

## Design principles (as built)

| Principle | Where it lives |
|---|---|
| The event log is the source of truth; state is a projection | `matter_event` (append-only, DB trigger forbids update/delete) → `projection.ts` |
| Every transition is automation **or** a flagged decision, nothing else | `machine.ts` — actor is `system`/`ai`/`external` or a user id; every `*_flagged`, `report_on_title_drafted` and `escalation_raised` carries a `DecisionSpec` |
| Every decision cites its source document | `DecisionSpec.sourceDocumentId` (non-null, DB-enforced on `matter_decision`) + `citations[]` |
| The human must open the source before resolving | `decision_source_opened` event; `resolve_decision` returns 412 otherwise |
| No AI content reaches a client without a logged human approval | `assertCanSendReport` — `report_on_title_sent` requires a prior `report_on_title_approved` by a user actor |
| Timers are first-class | `sla.ts` — working-day SLAs per wait; `chase_sent` / `escalation_raised` events |
| Low extraction confidence → human, never a guess | `rules.ts` `MIN_EXTRACTION_CONFIDENCE`; extractor failure = confidence 0 = flagged |
| Out of scope (leasehold) → manual handling, not half-automation | `manual_handling_required` halts stage advancement |

## Module map

```
lib/server/engine/
  types.ts        stages, event types, payloads, DecisionSpec, MatterState
  projection.ts   project(events) → MatterState   (pure reducer; the audit guarantee)
  rules.ts        facts → clear | flag            (deterministic; also template summaries)
  sla.ts          waits + clock → due chases/escalations (working days)
  working-days.ts England & Wales working-day arithmetic (bank holidays 2025–2027)
  machine.ts      decide(state, command) → events (pure; every invariant lives here)
  ports.ts        interfaces for components #2–#5
  mocks.ts        in-memory stand-ins for every port
  store.ts        EventStore: MemoryEventStore + PgEventStore (lock, seq, read models)
  service.ts      EngineService: lock → load → project → decide → append → effects
  adapters.ts     production wiring (Postgres + mocks) and the engine() singleton
  http.ts         zod schemas + role gates for the API routes
```

### The flow of one command

```
command ──► withMatterLock ──► load log ──► project ──► decide ──► append (seq check) ──► read models ──► commit
                                                                                                     │
                       post-commit effects (search orders, client updates) via ports ◄───────────────┘
                       each effect's OUTCOME is fed back as its own command → its own event
```

I/O happens **before** the event that records it: a search is `search_ordered` only
after the provider accepted, a chase is `chase_sent` only after the chaser sent it.
Effects are best-effort; a failed effect is logged and shows up as a stage blocker or is
picked up by the next tick — a stuck API never silently stalls a matter.

## Stages and gates

| Stage | Exit condition (`stageBlockers` in machine.ts) |
|---|---|
| `instruction` | ID/AML check cleared or reviewed |
| `pre_contract` | every required search cleared/reviewed · every enquiry cleared/reviewed · mortgage offer cleared/reviewed (if lender) |
| `contract_review` | title cleared/reviewed · report on title **sent** (drafted → approved by a person → sent) · no open enquiries |
| `pre_exchange` | `contracts_exchanged` (needs `exchange_conditions_met`, derived when the deposit lands) |
| `exchanged` | `completion_statement_generated` |
| `pre_completion` | `completion_confirmed` (needs all requested funds received) |
| `completed` | `sdlt_submitted` or `ap1_submitted` |
| `post_completion` | terminal; `ap1_confirmed` finishes the matter |

Stage moves are logged as `stage_advanced` events (never inferred). The legacy board
column `matter.stage` is mirrored forward-only from the engine.

## The sub-flow pattern (spec 2.4), as implemented for each flow

| Flow | wait opens | external arrives | extraction | rule | auto-clear | flag (decision kind) | human resolution |
|---|---|---|---|---|---|---|---|
| ID/AML | `id_check_requested` | `idCheckResultReceived` | `extractIdCheck` | `evaluateIdCheck` | `id_check_cleared` | `id_check_flagged` (`id_check`) | `id_check_reviewed` |
| Searches | `search_ordered` | `searchReturned` → `search_returned` | `extractSearch` → `search_extracted` | `evaluateSearch` | `search_cleared` | `search_flagged` (`search`) | `search_reviewed` |
| Enquiries | `enquiry_raised` | `enquiryReplyReceived` → `enquiry_reply_received` | `extractEnquiryReply` | `evaluateEnquiryReply` | `enquiry_reply_cleared` | `enquiry_reply_flagged` (`enquiry`) | `enquiry_reply_reviewed` |
| Mortgage | — | `mortgageOfferReceived` → `mortgage_offer_received` | `extractMortgageOffer` → `mortgage_offer_extracted` | `evaluateMortgageOffer` | `mortgage_offer_cleared` | `mortgage_condition_flagged` (`mortgage`) | `mortgage_condition_reviewed` |
| Title | — | `titleReceived` | `extractTitle` → `title_extracted` | `evaluateTitle` | `title_cleared` | `title_flagged` (`title`) | `title_reviewed` |
| Report on title | — | `draftReportOnTitle` (AI drafts) | — | — | never | `report_on_title_drafted` (`report_on_title`) | `report_on_title_approved` / `_rejected`, then `sendReportOnTitle` → `report_on_title_sent` |
| Timers | any open wait | `tick()` | — | `dueActions` | `chase_sent` | `escalation_raised` (`escalation`) | `escalation_resolved` |

Decision options: `approve`, `refer_to_client`, `request_further` (raises a tracked
follow-up enquiry), `escalate` (queues a new `escalation` decision for a senior with the
same source; resolving it resolves the original), `reject` (ID check → manual handling;
report draft → redraft).

## SLA defaults (working days, England & Wales)

| wait | chase at | repeat every | escalate at | re-escalate after resolution |
|---|---|---|---|---|
| search | 10 | 3 | 18 | 5 |
| enquiry | 5 | 3 | 15 | 5 |
| id_check | 3 | 2 | 7 | 3 |
| funds | 2 | 1 | 4 | 2 |
| registration | 30 | 10 | 60 | 20 |

Override per firm in `engine_sla_override`. The sweep is `GET /api/v1/cron/engine-tick`
(Vercel cron, weekdays 06:30 UTC, `CRON_SECRET`). An escalation's source document is an
auto-generated chase dossier, so even timer decisions cite something the handler can read.

## API (component #6 reads these)

| Route | Purpose |
|---|---|
| `GET /api/v1/matters/:id/engine` | projected state, stage blockers, open waits, pending decisions |
| `POST /api/v1/matters/:id/engine` | a human command (`enrol`, `request_id_check`, `raise_enquiry`, `deposit_received`, `contracts_exchanged`, …, `draft_report_on_title`, `send_report_on_title`; manual fallbacks `record_search_ordered`) |
| `POST /api/v1/matters/:id/engine/ingest` | a document arrived for a sub-flow (`search` / `enquiry_reply` / `mortgage_offer` / `title` / `id_check`) |
| `GET /api/v1/matters/:id/engine/events` | the log |
| `GET /api/v1/decisions` | tenant-wide pending decisions (the feed) |
| `POST /api/v1/decisions/:eventId/open-source` | logs `decision_source_opened`, returns the document |
| `POST /api/v1/decisions/:eventId/resolve` | `{ option, note }`; 412 until the source was opened |
| `POST /api/v1/integrations/infotrack/webhook` | STUB (#4) — accepts an already-filed document id |

Roles: `READ_ONLY` can only read; `ASSISTANT` can issue commands and ingest; only
`CONVEYANCER`/`ADMIN` resolve decisions or send the report. A minimal feed UI is at `/decisions`.

## What is stubbed (and how to replace it)

Swap the implementation in `adapters.ts`; nothing else changes.

- **#2 extraction** — `FixtureExtractor` reads `document.extracted_facts` (jsonb, shaped as
  `SearchFacts` / `MortgageOfferFacts` / `TitleFacts` / `EnquiryReplyFacts` / `IdCheckFacts`)
  and throws when empty (→ confidence 0 → flagged). The real pipeline should write those
  columns with per-field confidence and the page/section locators the citations use.
- **#3 AI** — `TemplateSummariser` returns null (deterministic prose is used).
  `TemplateReportDrafter` assembles a plain report. A Claude-backed summariser may replace
  the prose of a decision but *not* its verdict, citations or options (`buildDecision`).
- **#4 integrations** — `MockSearchProvider`, `MockIdCheckProvider`, the webhook stub.
- **#5 comms** — `MockClientComms` (status updates only), `MockChaser` (template chases).
  Client Q&A is intentionally not a port: it needs its own hard-blocked design.
- **#8 Outlook** — nothing; the `/decisions` page is the interim surface.

## Audit / replay

`replay(store, tenantId, matterId)` rebuilds state from the log alone;
`tests/unit/engine/lifecycle.test.ts` asserts `project(log)` equals the live state after a
full instruction → post_completion run, that the sequence is gap-free, that order matters,
and that every `_sent` is preceded by a user-actor `_approved`.

Run: `npm run test:unit` · `npm run typecheck` · migration: `npm run migrate` (065).

## Not in v1 (spec 2.7)

Leasehold (flagged for manual handling), chains across matters, a client portal, any
unapproved outbound AI content.

## Components #2–#8 (as built)

| # | Component | Where | Real when | Otherwise |
|---|---|---|---|---|
| 2 | Extraction pipeline | `engine/extraction.ts`, `engine/ingest.ts`, `engine/llm.ts` | `ANTHROPIC_API_KEY` (or `ENGINE_EXTRACTOR=claude`) | `FixtureExtractor` reads `document.extracted_facts` |
| 3 | AI reasoning (summaries, report drafts) | `engine/ai.ts` | `ANTHROPIC_API_KEY` (or `ENGINE_AI=claude`) | deterministic templates |
| 4 | InfoTrack (searches, ID/AML, official copies) | `integrations/infotrack*.ts`, webhook route | `INFOTRACK_BASE_URL/CLIENT_ID/CLIENT_SECRET` | mock providers; manual `record_search_ordered` |
| 5 | Client comms + guarded Q&A + chases | `comms/*`, WhatsApp webhook | `WHATSAPP_*`, `RESEND_*`, or Graph | mocks |
| 6 | Dashboard | `app/shared/engine/*`, `/decisions`, drawer Engine tab | always | — |
| 7 | Audit | `engine/audit.ts`, `/matters/:id/engine/audit`, `scripts/engine-audit.ts` | always | — |
| 8 | Outlook | taskpane "what needs me" feed | always | — |

Key guarantees added: extraction confidence is the minimum across fields and capped by scan
quality; the AI summary/report is validated (every flag explained, no invented figures, no
recommendation, every section cites a real document) or the template is used; every event
is in a per-matter SHA-256 hash chain (`verifyChain`); client Q&A is hard-blocked on
anything transaction-specific before any model runs.

## Addendum: internally-linked counterparties

The firm may act for the buyer on matter A and, via a **different** handler, for the seller
on matter B in the same chain — permitted only if the two are walled off as if they were
separate firms.

| Requirement | Implementation |
|---|---|
| 1. Counterparty is a resolver | `matter.counterparty_ref` (`{kind:'external',…}` or `{kind:'internal', matterId}`), `resolveCounterparty()` returns one `Counterparty` shape (name, email, type). Comms, chases and the engine only see that. |
| 2. Hard wall at the data layer | Migration 068: `engine_wall_check()` raises `42501` when `app.user_id` is the handler of the linked counterparty; RLS (`FORCE`) on `matter` and every table holding confidential facts. `lib/server/db.ts` binds the signed-in user per request (`set_config('app.user_id', …, true)` inside a transaction) — no shared function or admin screen can read across. `GET /api/v1/health` reports `wallEnforced` (the DB role must not have BYPASSRLS). |
| 3. No silent shortcuts | An enquiry to an internal counterparty emits the same `enquiry_raised` → `enquiry_reply_received` pair; delivery is via `LinkedMatterNotifier` (a task + notification on the other handler's matter), the reply comes back as a filed document. The other matter's state is never read (unit-tested). |
| 4. Audit flag | `counterpartyType: 'internal' \| 'external'` on `matter_created`, `enquiry_raised`, `enquiry_reply_received` and counterparty `chase_sent`; indexed; counted in the audit report (`internalCounterpartyEvents`). |
| 5. Never one handler both sides | `assertNoSharedHandler` / `assertCanAssign` in the app (409 with a clear message), plus DB triggers on `matter_link` insert and on `matter.assigned_to` update (`23514`). Consent exceptions are handled outside the system by design. |

Set a counterparty with `POST /api/v1/matters/:id/counterparty` (`{kind:'external', name, email, firm}` or `{kind:'internal', matterId, chainRef}`); read the resolved contact with `GET`.

## Demo

```bash
npm run migrate                # migrations ≤ 071 on the target database
npm run engine:demo            # seeds "Demo Conveyancing LLP": two handlers, four matters (one in shadow mode), real PDFs, pending decisions
```

The seed prints matter URLs and two session cookies (Alice, the buyer's handler; Bob, the
seller's handler on the linked matter). Open `/decisions` (the queue), `/engine/<matterId>`
(the timeline), `/decisions/<eventId>` (a decision panel), `/engine/<matterId>/shadow` (the
comparison view) or `/engine/shadow` (the rollout board) with the `cl_session` cookie set.

Screenshots from the Playwright walkthrough are in `docs/demo/`:
`01-queue`, `02-timeline-14-oak-street`, `03-decision-panel-locked` (actions disabled until
the source has been read), `04-decision-panel-unlocked`, `05-decision-panel-reason` (a
non-approve action asks for a reason), `06-decision-resolved-readonly`,
`07-bank-details-hard-stop`, `08-report-on-title-panel`, `09-7-mill-lane-report-sent`,
`10-shadow-timeline` (the non-dismissable banner, every "not performed" intent),
`11-shadow-decision-not-actionable`, `12-shadow-comparison`, `13-rollout-board`,
`14-bob-walled-off`. Without `ANTHROPIC_API_KEY` the seeded PDFs carry pre-extracted
facts and everything else runs on mocks (`ENGINE_COMMS=mock` keeps comms off Graph);
with a key, the same PDFs go through the real extractor when filed via the Engine tab's
"File a document into the engine" control or `POST /matters/:id/engine/upload`.

Wall semantics after migration 069: tenant-wide lists silently exclude a handler's walled
counterparty matter; a targeted read (`assertMatterAccess`, any `/matters/:id/*` route)
is refused with 403 from a database-raised `42501`; writes to a walled row fail RLS.
The request's user is bound to every query by `lib/server/db.ts` from the session
cookie/bearer token — no route has to remember to do it.

## Addendum 2: payment verification — bank-detail change hard-stop

| Requirement | Implementation |
|---|---|
| 1. Versioned bank details | `bank_details_recorded` events → `state.bankDetails` (never overwritten; a new record supersedes the previous one) and the append-only `payee_bank_details` read model (migration 070, trigger refuses in-place changes to the details). |
| 2. Every set/change is a hard-stop | `record_bank_details` always emits `bank_details_change_flagged` — a `bank_details` decision citing the document the details arrived on. While it is pending, `funds_requested`, `payment_authorised` and `completion_confirmed` are refused with **423 HARD STOP**, whatever the channel or urgency. There is no configuration to relax it. |
| 3. Out-of-band verification | The decision's options are `verify` / `reject` / `escalate` — no `approve`. `verify` requires a `verification.method` from `VERIFICATION_METHODS` (`phone_callback_known_number`, `lawyer_checker_match` + reference, `in_person`, `video_call_known_contact`); anything in `REJECTED_VERIFICATION_METHODS` (`same_channel_reply`, `email_reply`, …) or unknown is a 400 from the machine, and the DB trigger refuses any other method string. |
| 4. First-time details = same scrutiny | `isChange:false` records are flagged identically. |
| 5. No payment by AI alone | `funds_requested` and `payment_authorised` require a user actor (403 otherwise) and a `bankDetailsId` that is the newest, verified record for that payee; `completion_confirmed` requires a prior `payment_authorised` against details that are still current and verified. The route additionally requires a CONVEYANCER/ADMIN. |
| 6. Queryable record | `bank_details_change_flagged` / `bank_details_verified` / `bank_details_verification_failed` are distinct event types; the audit report counts flagged/verified/failed/unresolved and `paymentsAuthorisedWithoutVerifiedDetails` (always 0 by construction). |

UI: the decision card for a bank-details change is red-striped and its **Verified out-of-band** button unlocks only after the source is opened *and* a method is chosen; the Engine panel lists every version with status and lets the handler record new details (creating the hard-stop) and authorise the completion payment only from verified records.

## Addendum 3: enforcement not instruction, shadow-mode rollout, the dashboard

### §1 Schema-level enforcement (migration 071, `db/supabase/engine-one-shot-3.sql`)

| Rule | Where it is enforced |
|---|---|
| A payment-triggering event (`funds_requested`, `payment_authorised`) or an outbound-AI-content event (`report_on_title_sent`) needs a human approver. | Trigger `matter_event_human_gate` on `matter_event`: the row is refused (`23514`) unless `payload.approvedBy` is an `app_user` of the same tenant; `report_on_title_sent` must also cite a `report_on_title_approved` event on the same matter **written by that same user**. The machine stamps `approvedBy` from the acting user, so a correct write passes; a write that "forgets" cannot exist. |
| No AI or automation path may write those events at all. | NOLOGIN role `conveyi_automation` + a RESTRICTIVE insert policy on `matter_event` keyed on `current_user`. Every automation context — cron (`/api/v1/cron/engine-tick`), the InfoTrack and WhatsApp webhooks, document ingestion, the engine's own post-commit effects and timer sweep — runs inside `runAsAutomation()` (`lib/server/db.ts`), which issues `SET LOCAL ROLE conveyi_automation` on the transaction. From there the gated types are refused (`42501`) even with a perfectly valid `approvedBy`. Human request pathways stay on the app role. The policy is deliberately *not* `TO conveyi_automation`: a policy targeted at a role also binds every role that inherits membership of it, which would lock the app role itself out. |
| Success criterion 2.8. | `tests/integration/human-gate.test.ts` attempts every path against a real Postgres: the machine with `system`/`ai` actors; raw SQL with a null, missing, non-uuid, unknown and other-tenant `approvedBy`; `report_on_title_sent` with no / a non-existent / another user's approval event; the automation role with a valid approver; the engine's own `withMatterLock → append` path inside the automation context. All refused. The positive control (a human-approved row from the human pathway) is accepted and rolled back. |

| Everything else critical is a person's (migration 079). | Trigger `matter_event_money_and_people_gate`: **bank details verified / verification failed, contracts exchanged, completion confirmed and a client's decision** need a person in the firm as their actor. From the automation role the first four are refused outright; a client decision is accepted only when it cites the `note_actions_applied` event a person approved it in, written by that same person. **`funds_requested` and `payment_authorised` must name bank details on the matter verified out of band.** |
| Bank details are never verified by automation. | Trigger on `payee_bank_details`: the automation role can record details only as unverified (they stop payments until a person checks them) and can never set the verification. |
| Contact details are not rewritten by automation. | Trigger on `matter_contact`: the automation role can add a contact (with no role, unless it comes from LEAP or InTouch) but cannot delete one, change an email, change a phone number on file, or change a role a person set. LEAP / InTouch may update the contacts they supplied, and adopt ones first seen on email. |
| Migration 079's rules, attacked. | `tests/integration/critical-changes.test.ts`: each change from the automation role and with non-person actors, all refused; positive controls (a person verifying, exchanging and paying to verified details; a note-approved client decision) accepted. |

`EnginePorts.asAutomation` is the seam: production binds it to `runAsAutomation`; the mocks run the block as-is, and a unit test asserts effects and the timer sweep run inside it.

### §2 Trust levels: propose, assist, auto

Every action the engine takes on its own has a trust level, per firm and per action
(`engine_action_level`, migration 082). The actions are acknowledgements, chases, client
updates, search orders and auto-clears. A person asking for something (an ID check, the
proof-of-funds form, sending the approved report) is never gated: their click is the approval.

* **propose** — the engine asks first. The intent becomes a decision of kind `proposal`
  (`action_proposed`) in Tasks, citing a generated dossier of exactly what would be sent or
  ordered, with the options approve / reject. Approving appends `action_approved` and the
  service performs the action the same way the unasked path would (`perform()`); rejecting
  appends `action_rejected` with the reason and keeps that action quiet for a few days so the
  timer does not re-ask daily. An auto-clear at propose is held: `auto_clear_proposed` carries
  the clear itself, unapplied, and approving the review emits it. **Every firm starts at
  propose for every action.**
* **assist** — acknowledgements, chases and search orders go out unasked; client updates are
  still proposed; auto-clears happen and are put in front of a person afterwards as a
  non-blocking `auto_clear_review_raised` to confirm.
* **auto** — everything proceeds and auto-clears are silent. Flagged decisions and the
  human-gated events (payments, report on title, exchange, completion) are a person's at every level.

Promotion is earned per action: the trust levels page (`/engine/shadow`, admins) shows each
action's level beside how many of its proposals were approved and rejected, and
`PUT /admin/engine/subflows` changes a level (audited). Shadow mode — observe only, hide
everything — is gone: its events (`action_suppressed`, `shadow_mode_changed`) remain in old
logs and still replay, but nothing emits them and nothing is hidden from a person any more.

### §3 The dashboard (`/decisions`, `/engine/:matterId`, `/decisions/:eventId`)

* **Queue** (`GET /engine/queue`): one row per matter assigned to the handler (`all=1` for seniors/admins): address, reference, engine stage, a pending badge counting only surfaced *blocking* decisions (auto-clear reviews shown separately in muted text), the age of the oldest pending decision, target completion date. Sort: oldest pending decision (default) or target completion date. Click → timeline.
* **Timeline**: header with address, reference, handler, current stage, what blocks the next stage, and on a shadow matter a sticky, non-dismissable banner. Events newest first, grouped by day. Plain events are one muted line (time · type · actor kind, `#seq`) that expands to the raw event JSON; suppressed intents are marked "not performed". Decision events are cards — kind · subject, the first line of the summary, a status badge — clickable whether pending or resolved. A Controls tab keeps the operational panel (commands, uploads, bank details).
* **Decision panel**: a fixed three-part vertical layout.
  1. The AI summary with inline citation markers `[n]` attached to the line that references each citation (unplaced citations listed beneath); clicking one jumps the source to the cited page (PDF `#page=`) or the highlighted passage (text).
  2. The source, **rendered inline and visible without a click**, auto-scrolled to the decision's locator and highlighted. Opening the panel on a pending decision logs `decision_source_opened` (the source is on screen), which is the machine's precondition for resolving.
  3. The action row, built from the decision's options. Anything other than approve/verify asks for a free-text reason, required, stored on the resolving event (`note`); the machine refuses a non-approve action without one (400).
  * **Engagement gate**: no action is enabled until the handler has scrolled the source section or dwelt on it while it is in view (8 s in the UI). The engagement (`scrolledSource`, `dwellMs`) is sent with the resolution, recorded on the resolving event, and checked again server-side — `POST /decisions/:id/resolve` returns 412 without it (`assertEngaged`, 5 s floor), so the gate holds even if the UI is bypassed.
  * Resolved decisions open read-only: the option, reason, who, when, verification method, engagement, who opened the source, and a link to the escalation it raised if any. Shadow decisions open with a "not actionable" notice and no actions.

## The machine as data: `/engine/map`

`lib/server/engine/spec.ts` describes the machine — stages and their gates, the sub-flow
pattern per sub-flow, every command with its actor and accepted stages, every event
type, decision kinds and options, wait and deadline timers, invariants, triggers and the
eventualities matrix. It is built from the machine's own tables where they exist
(`STAGES`, `EVENT_TYPES`, `DECISION_KINDS`, `OPTIONS_FOR`, `DEFAULT_SLA`, `DEADLINE_LEAD`,
`USER_COMMANDS`, `TRIGGERS`) and declared next to the code where they do not; and
`tests/unit/engine/spec.test.ts` checks the declared parts against the machine's
behaviour (bare-state blockers per stage, the stage spine reached in order by running
the machine, stage-bound commands refused elsewhere, options per kind, SLA numbers).
`GET /api/v1/engine/spec` serves it; `/engine/map` draws it, read-only, with a version
stamp (a hash of the spec) so a screenshot can be tied to a build. The page is the
reference: if it disagrees with the code, a test is red.

## Eventualities

`docs/engine-eventualities.md` walks how a conveyancer really acts on a freehold
purchase — by transaction shape, by stage and across stages — and records what the
machine does about each (built / manual / outside / gap). The research added ten
commands (`abandon_matter`, `set_target_dates`, `change_completion_date`,
`notice_to_complete_served`, `mortgage_offer_withdrawn`, `withdraw_enquiry`,
`hmlr_requisition_received`, `record_correction`, `record_handler_change`,
`raise_deadline_escalation`), a `requisition` decision kind, an `indemnity` option for
search and title decisions, gates for re-ordered searches and withdrawn offers, and the
deadline timers (`sla.ts → deadlineActions`: offer expiry, SDLT, notice to complete,
requisition reply). Tests: `tests/unit/engine/eventualities.test.ts`.

## Backends: our own app or LEAP

`lib/server/engine/backend.ts` is the seam between the engine and the practice system:

| | NativeBackend (`lib/server/backends/native.ts`) | LeapBackend (`lib/server/backends/leap.ts`) |
|---|---|---|
| Matter rows | CaseLightning `matter` (created in the app, imported from CSV, or inferred from mail) | mirrored from LEAP, keyed by `leap_matter_id` |
| Document bytes | OneDrive (Graph) or `document_blob` | fetched from LEAP on demand |
| Generated documents (drafts, dossiers) | `document` row + `document_blob` | uploaded into a `CONVEYi` folder in the LEAP matter, labelled DRAFT |
| Where conclusions show | `matter_task` (type DECISION, source ENGINE, assigned to the handler, with the panel link) + `matter_timeline_event` | LEAP tasks + file notes (`leap_writeback`) |
| Assignment | `matter.assigned_to`; PATCH puts `handler_changed` on the log | LEAP responsible staff; the sync puts `handler_changed` on the log |
| Triggers | email attachments, OneDrive, uploads, InfoTrack, WhatsApp, the panel, the taskpane, cron | LEAP webhooks + polling sync, InfoTrack, the panel, cron |

`productionPorts()` composes the engine's ports from `backend()`: LEAP when configured
(or injected for tests), otherwise native. Nothing in `machine.ts`, `projection.ts`,
`rules.ts` or `sla.ts` knows which is in use; the decision panel, queue, timeline and
audit are identical on both. `setBackend()` swaps it for tests.

## Triggers

`lib/server/engine/triggers.ts` is the registry of every way something reaches the
engine — for both backends — with what it feeds (ingest, command, sync, comms), what it
can reach, where it lands in the code, and whether it is built. A trigger never decides
anything: it files a document, issues a command, or syncs the mirror; the engine's
answer is the same whichever door it came through. The map's section 5 lists them;
three LEAP triggers are marked planned (task completed in LEAP, key dates from the LEAP
calendar, correspondence filed in LEAP) pending the API reference.
