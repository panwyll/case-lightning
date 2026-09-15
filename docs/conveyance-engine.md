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
