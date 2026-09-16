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
npm run migrate                # migrations ≤ 069 on the target database
npm run engine:demo            # seeds "Demo Conveyancing LLP": two handlers, three matters, real PDFs, pending decisions
```

The seed prints matter URLs and two session cookies (Alice, the buyer's handler; Bob, the
seller's handler on the linked matter). Open `/decisions` or `/engine/<matterId>` with the
`cl_session` cookie set. Without `ANTHROPIC_API_KEY` the seeded PDFs carry pre-extracted
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
