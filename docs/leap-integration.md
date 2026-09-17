# LEAP as the backend

CONVEYi's phase 0/1 runs **on top of LEAP** (leap.build — the firm's practice management
system). LEAP keeps what it is good at and what firms already trust it with: matters,
cards (parties), documents, tasks, file notes, calendar, accounting. CONVEYi keeps the
proprietary spine and nothing else:

| Lives in LEAP (system of record) | Lives in CONVEYi (proprietary) |
|---|---|
| Matters, matter numbers, key dates, responsible staff | The immutable per-matter **event log** (hash-chained) and its projection |
| Cards and the parties on a matter | The **state machine**, the **rule layer**, SLA timers |
| Documents and their bytes | **Decisions** (summary + citations + options), the engagement gate, the human gate |
| Tasks and file notes (CONVEYi writes them) | Bank-details versions and the payment hard-stop; audit; shadow-mode comparison |

Nothing about the conveyance is decided in LEAP or by LEAP. LEAP is where the inputs
arrive and where the conclusions are shown.

## How the two connect

```
LEAP ──(webhook: pointer only)──► /api/v1/integrations/leap/webhook ──► re-read from LEAP ──► mirror ──► engine
LEAP ◄──(polling, watermarks)──── /api/v1/cron/leap-sync (every few minutes; the safety net under webhooks)
engine log ──(post-commit, automation role)──► LEAP tasks + file notes + DRAFT uploads   (write-back, phase 1)
decision panel ──(on demand)──► LEAP document download                                   (the source, inline)
```

* **Mirror, not copy.** A LEAP matter becomes a `matter` row with `leap_matter_id`
  (the engine's foreign key and the ethical wall's subject); its parties become
  `matter_contact` rows with `leap_card_id`; each document becomes a `document` row with
  `leap_document_id` and **no bytes** — the decision panel and the extractor fetch bytes
  from LEAP when needed (`LeapDocumentBytesLoader`, `/api/v1/documents/:id/raw`).
* **Enrolment policy.** Open LEAP matters whose matter type is a conveyancing
  purchase (freehold; leasehold and sales are mirrored but not enrolled) are enrolled in
  the engine — in **shadow mode** by default (`LEAP_ENROL_MODE=shadow`), so the engine
  observes the firm's real matters before it acts on any (addendum 3 §2). Promote with
  `LEAP_ENROL_MODE=live` or per matter from the comparison view. `LEAP_ENROL_PATTERNS`
  narrows by matter-type name.
* **Any order, no loss.** Documents reach LEAP in whatever order the firm files them.
  One the engine cannot take yet (a search result before the ID check has cleared) is
  mirrored and marked `PENDING`, and retried on every sync until it is taken or a person
  files it. The incremental sync polls every enrolled matter's documents from a
  per-matter watermark, not only matters LEAP reports as changed.
* **Documents → engine.** With a Claude key the classifier decides; without one, or when
  it is unsure, LEAP's folder and file name are a strong enough prior to route a search
  result, an offer, a title or an ID report (`documentHint`). When a result lands in LEAP
  for a step the engine never initiated (the handler ordered the check from LEAP), the
  request is recorded first, actor `external`, provider "arrived via LEAP" — the log stays
  truthful (`routeByHint`).
* **Write-back (phase 1).** Every committed command's events are projected into the
  LEAP matter as automation: a surfaced decision → a LEAP task (with the link into the
  decision panel, assigned to the responsible staff); its resolution → task completed +
  a file note (option, reason, who, sources); stage moves, orders, chases, client
  updates, sends → one-line file notes. Idempotent per event (`leap_writeback`).
  **Never on a shadow matter** — its conclusions stay on our side for the comparison.
  Engine-generated documents (report **DRAFT**, escalation dossier) are uploaded into a
  `CONVEYi` folder in the matter, clearly labelled, so the decision cites a document
  that exists in the firm's file (`LEAP_UPLOAD_GENERATED=0` keeps them local).
* **Enforcement still holds.** Webhooks, the sync and the write-back all run under
  `runAsAutomation` (the `conveyi_automation` role): nothing that comes from LEAP can
  write a payment or a send event. The human gate (addendum 3 §1) is unchanged.

## What is assumed, and where to fix it

LEAP's API reference (developer.leap.build → console.leap.build) is registration-gated
and was not readable from the build environment. The integration is therefore built so
that every LEAP-specific assumption is in one of two files:

| Assumption | File | Confirm against the reference |
|---|---|---|
| OAuth 2.0 authorization-code flow (+ PKCE), `/oauth/authorize`, `/oauth/token`, refresh tokens | `endpoints.ts`, `client.ts` | paths, PKCE required or ignored, scope names |
| `x-api-key` header on every request | `endpoints.ts` | header name / whether the key goes in the token request too |
| Resource paths: `/api/v1/matters`, `/matters/{id}/cards`, `/matters/{id}/documents` (+ multipart upload), `/documents/{id}/download`, `/matters/{id}/tasks`, `/tasks/{id}`, `/matters/{id}/notes`, `/mattertypes`, `/firm`, `/webhooks` | `endpoints.ts` | exact paths and verbs; whether file notes / tasks are writable through the API |
| Pagination: `limit` + `offset`/`cursor`, `updatedSince`; list bodies as an array or `{ items|data|results|value, next|total }` | `client.ts` (`page()`) | parameter names, envelope |
| Field names for matters, cards, documents, tasks, notes (read defensively from several candidates) | `mapping.ts` | one fixture per resource from a real payload, added to `tests/unit/integrations/leap.test.ts` |
| Webhooks: JSON `{ id, eventType, data: { matterId, documentId, … } }`, HMAC-SHA256 in `x-leap-signature`, delivery id in `x-leap-delivery` | `endpoints.ts`, `client.ts` | event names, signature scheme, which resources emit; the polling sync covers the gaps |
| Region hosts | env (`LEAP_AUTH_BASE_URL`, `LEAP_API_BASE_URL`) | none invented |

The mock (`lib/server/integrations/leap/mock.ts`) serves exactly the map above, so the
HTTP client is exercised end to end today; when a real payload disagrees, change the
candidate keys or the path once, re-run the tests against the mock, re-run against LEAP.

## Setup

1. Run `db/supabase/engine-one-shot-4.sql` (migration 072).
2. Register the app in the LEAP developer console; set `LEAP_AUTH_BASE_URL`,
   `LEAP_API_BASE_URL`, `LEAP_CLIENT_ID`, `LEAP_CLIENT_SECRET`, `LEAP_API_KEY`,
   `LEAP_WEBHOOK_SECRET`, `LEAP_REGION` (label), and the redirect URI
   `<APP_URL>/api/v1/integrations/leap/callback`. `APP_ENCRYPTION_KEY` must be set (tokens
   are stored encrypted).
3. An admin opens `/integrations/leap` → **Connect LEAP** (OAuth). The callback records
   the firm, subscribes the webhook (if LEAP accepts it) and runs a full sync.
4. Schedule `GET /api/v1/cron/leap-sync` (Bearer `CRON_SECRET`) every 5–15 minutes.
5. Watch `/engine/shadow` (rollout board) and each matter's comparison view; promote
   sub-flows and matters out of shadow on the evidence.

Without LEAP credentials, `npm run leap:mock` starts a stand-in LEAP on
`http://127.0.0.1:4010` (pre-seeded firm, OAuth that redirects straight back, signed
webhooks). Point the env vars at it and the whole flow runs locally. The Playwright walkthrough
in `docs/demo/` shows it: `15-leap-not-connected`, `16-leap-connected-synced` (OAuth
round trip, first full sync: five matters mirrored, the two freehold purchases enrolled,
four documents mirrored with bytes left in LEAP), `17-leap-queue`,
`18-leap-timeline-14-oak-street`, `19-leap-decision-source-from-leap` (the source PDF
rendered inline straight from LEAP), `20-leap-timeline-searches-taken` (the search
results LEAP already held, retried once the ID check cleared), `21-leap-con29-decision`
(resolved → LEAP task completed + file note with the reason and sources),
`22-leap-webhook-document-arrived` (a document filed in LEAP → signed webhook → engine).
Without `ANTHROPIC_API_KEY` the mirrored PDFs are unreadable to the fixture extractor, so
every result is flagged "0% confidence — check the source" rather than auto-cleared; with
a key the same PDFs go through the real pipeline.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Read-only: connect, mirror matters/parties/documents, enrol purchases in shadow, feed LEAP documents to the engine, decisions in CONVEYi's queue | built (over the mock; endpoint map to confirm) |
| 1 | Write-back: tasks, file notes, DRAFT uploads; promote sub-flows out of shadow | built (over the mock) |
| 2 | Correspondence through LEAP (chases, client updates and the report on title sent from the LEAP matter so the firm's file is complete); LEAP calendar for key dates; matter status field mapping | not started — needs the reference for LEAP's correspondence/email resources |
