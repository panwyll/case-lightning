# CaseLightning — Go-Live Checklist

Work top to bottom. Each item names the exact env var / code path so it's
verifiable, not aspirational. "Verify" items have a concrete check.

---

## 1. Environment & secrets (Vercel → Project → Settings → Environment Variables)

All read in [`lib/server/config.ts`](../lib/server/config.ts). Set for **Production**.

> **Status:** prod `/api/v1/health` shows `db / auth / graph / ai` all green, so `DATABASE_URL`, `SESSION_JWT_SECRET`, the `AZURE_*` trio, and `ANTHROPIC_API_KEY` are present and the site is live on `APP_URL`. Not health-verifiable (confirm by hand): `APP_ENCRYPTION_KEY`, `GRAPH_SCOPES` contents, `VOYAGE_API_KEY`, `CRON_SECRET`, `INTERNAL_DASHBOARD_KEY`.

### Core
- [ ] `APP_URL` — the live HTTPS domain (e.g. `https://www.caselightning.co.uk`). Drives OAuth callback, Stripe return URLs, and the Graph notification URL. Must be public (not localhost) or auto-triage refuses to arm.
- [ ] `DATABASE_URL` — Supabase **pooler** connection string (pgvector needs pooling).
- [ ] `SESSION_JWT_SECRET` — long random string; signs the session token.
- [ ] `APP_ENCRYPTION_KEY` — AES key; encrypts per-user BYOK AI keys at rest. **If this changes, every stored BYOK key becomes undecryptable.**

### Microsoft Entra / Graph (feature `auth` + `graph`)
- [ ] `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
- [ ] `AZURE_REDIRECT_URI` — must exactly match the app registration's redirect URI and resolve under `APP_URL`.
- [ ] `GRAPH_SCOPES` — **set in Vercel, not just in code** (the env overrides the code default). Must include `Mail.ReadWrite MailboxSettings.ReadWrite Files.ReadWrite` plus `User.Read`; `offline_access` for refresh tokens. Adding a scope requires re-consent.
- [ ] Admin consent granted in Entra for the above (firms' IT may need to approve inbox watching, or auto-triage 403s).

### AI / embeddings
- [ ] `ANTHROPIC_API_KEY` — primary model provider. **Without it, the app fails over to Groq** (see GDPR §6 — different data processor).
- [ ] `VOYAGE_API_KEY` (or `OPENAI_API_KEY` + `EMBEDDINGS_PROVIDER=openai`) — RAG degrades to non-vector retrieval if absent. Confirm `EMBEDDING_DIM` matches the model (voyage-3-large = 1024).
- [ ] `ONEDRIVE_ROOT` — defaults to `CONVEYi`; set deliberately if you want a different root folder name.

### Ops
- [ ] `CRON_SECRET` — set, so the renew/referrals/onboarding crons reject unauthenticated calls. Vercel Cron sends it automatically as a Bearer token.
- [ ] `INTERNAL_DASHBOARD_KEY` — gates `/internal` analytics. Set to a strong secret.

---

## 2. Stripe (feature `billing`) — 3 tiers: plus / pro / enterprise

Gating is lazy: `getTenantPlan()` ([`lib/server/plan.ts`](../lib/server/plan.ts)) **grants enterprise to everyone when `STRIPE_SECRET_KEY` is unset** (pilot mode). With it set, gating is live: premium = pro|enterprise, team seats = enterprise, Pro is heavy-LLM usage-capped.

**Current state (test mode):** `billing:true` on prod — `STRIPE_SECRET_KEY` (test, rotated), `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_PLUS/PRO/ENTERPRISE` (test) all set; plan-detection verified against the real price IDs. Good enough to test the flow; **not** launch.

Done (test):
- [x] `STRIPE_SECRET_KEY` (test, rotated after exposure) + `STRIPE_WEBHOOK_SECRET` set → `billing:true`.
- [x] `STRIPE_PRICE_PLUS` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_ENTERPRISE` set (Production). Plan resolves by price ID (4/4 verified).
- [x] Webhook endpoint live + signature-enforced (probe returns 400 "missing signature", not 503).
- [x] `BILLING_CURRENCY=gbp`.

Remaining for launch:
- [ ] **Swap test → live**: `sk_live_…`, a **live** webhook endpoint's `whsec_…`, and **live-mode** `price_…` IDs for all three tiers. (Test/live are separate worlds.)
- [ ] Webhook subscribed to: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `invoice.voided`, `invoice.marked_uncollectible`.
- [ ] **Configure the Stripe Billing Portal** (Settings → Billing): enable plan switching (add all 3 prices) + cancellation — powers the "Manage subscription" button.
- [ ] `PRO_HEAVY_LLM_MONTHLY_CAP` — confirm the Pro monthly heavy-LLM cap (default `300`).
- [ ] `REFERRAL_COMMISSION_PENNIES` — confirm (default `5000` = £50/mo).
- [ ] Add the three price vars to the **Preview** env too (only Production took; CLI quirk).
- [ ] **Verify with a test-card purchase** (`4242…`) → `billing_account.plan` = correct tier, `status=active`; Plus blocked from premium, Pro premium-but-single-seat + capped, Enterprise full.

---

## 3. Database & migrations

- [ ] Run **all** migrations against prod (`db/migrations/0xx_*.sql`). Prod creds aren't readable from the dev box — run via `npm run migrate` with prod `DATABASE_URL`, or paste into the Supabase SQL editor.
- [ ] Confirm the latest ones are applied: `021_doc_templates.sql` (doc packs), `022_auto_triage_flag.sql` (auto-triage self-heal), `023_three_tier_plans.sql` (plus/pro/enterprise remap). Without 021 the Templates panel is empty; without 022 self-heal can't track intent; without 023 old `standard`/`team` rows won't resolve to a tier.
- [ ] `select max(version)` (or your migration ledger) matches the highest file number.

---

## 4. Per-org isolation (multi-tenant gating) — verify, don't assume

The product is multi-tenant; one firm must never see another's matters or data.
**Code audit done 2026-06-23** (static; the two-tenant *runtime* test still needs prod).

- [x] **Every matter access goes through `assertMatterAccess(user, matterId)`** ([`lib/server/guard.ts`](../lib/server/guard.ts)), which requires `matter.tenant_id = user.tenantId`. Audited: all 19 routes under `app/api/v1/matters/[matterId]/` call it.
- [x] **Every query is tenant-scoped.** Matching ([`matching.ts`](../lib/server/matching.ts)), RAG retrieval, documents, tasks, templates, triage — all filter `tenant_id = $1`. `doc_template` queries scoped; doc-pack route calls `assertMatterAccess`.
- [x] **RAG can't leak across matters.** `retrieveMatterContext` filters `where tenant_id = $1 and matter_id = $2` before the vector search — context is matter-AND-tenant scoped, never the whole tenant. Cross-matter retrieval is blocked unless an explicit `x-cross-matter` header + approval token is present (`assertCrossMatterAllowed`).
- [x] **Admin endpoints require `requireRole(['ADMIN'])`** — audited: all `app/api/v1/admin/*` user routes role-gate. (`admin/analytics/refresh` is a CRON endpoint, protected by `CRON_SECRET`, not a user route — correct.)
- [x] Self-address matching exclusion is live (a firm's own mailbox/domain is never a match signal) — see [`tenantSelfAddresses`](../lib/server/matching.ts).
- [ ] **Runtime verify with two tenants** (needs prod): as firm A, GET a firm-B matter id → expect "Matter not found or inaccessible"; confirm firm A's template/doc-pack list shows only firm A's templates.

### 4a. Postgres RLS / Supabase Data API exposure — **review before launch**

Tenant isolation today is enforced **in the application layer** (above): the app connects via one privileged pooled connection ([`db.ts`](../lib/server/db.ts)) and filters every query by `tenant_id`. There are **no RLS policies** and the app sets no per-request tenant context — so app queries don't rely on RLS, and that's fine *for the app's own path*.

The risk is the **other door**: a Supabase project auto-exposes every table over its Data API (PostgREST/GraphQL), gated only by **RLS + the anon key**. Tables created via raw-SQL migrations have **RLS disabled by default**, so if that API is reachable with the project's anon key, a third party could read/write every firm's rows directly — bypassing all the app-layer checks in §4.

- [ ] **Close the Data-API door** — do **one** of:
  - (a) Disable the Supabase Data API for the project (Settings → API), if nothing uses it; **or**
  - (b) Enable RLS with a **default-deny** policy on every table in the exposed schema (`alter table … enable row level security;` with no permissive policy), so the anon/`authenticated` roles get nothing and the only path to data stays the app's privileged server connection; **or**
  - (c) Move app tables into a schema PostgREST doesn't expose.
- [ ] **Verify the anon key isn't shipped to clients** — audited 2026-06-23: `supabase-js` is used **server-side only** with the secret key ([`waitlist`](../app/api/waitlist/route.ts), legacy [`health`](../app/api/health/route.ts)); no `NEXT_PUBLIC_SUPABASE_ANON_KEY` in any client bundle. Re-confirm none is added later. (`NEXT_PUBLIC_SUPABASE_URL` is just the project URL — not a secret, but it reveals the project ref, so the anon key must not be guessable/default-public with RLS off.)
- [ ] **Least-privilege DB role** — confirm `DATABASE_URL` connects as a role scoped to the app schema, not a cluster superuser.
- [ ] **Optional (post-launch hardening)**: true RLS enforcement *for the app too* would need a per-request tenant GUC — `SET LOCAL app.tenant_id = …` inside each transaction (compatible with the transaction pooler) plus policies keyed on `current_setting('app.tenant_id')`. Non-trivial with the current pooled raw-SQL design; treat as defense-in-depth after launch, not a blocker.

---

## 5. Auto-triage / Graph subscriptions / cron

- [ ] Auto-triage fires on receipt only with a live `graph_subscription`. It now **self-heals**: the taskpane re-arms on open and the daily cron recreates (not just renews) lapsed subscriptions for any opted-in user (`app_user.auto_triage_enabled`). See [`lib/server/subscriptions.ts`](../lib/server/subscriptions.ts).
- [ ] **Cron cadence**: `vercel.json` defines 3 daily crons. **Hobby caps at 2 best-effort crons** — on Hobby the renew cron may be skipped. The self-heal-on-open covers active users, but **go Pro at launch** so renewals run reliably for everyone (then confirm all 3 crons show "Ready" in the Vercel Cron tab).
- [ ] **Verify**: enable auto-triage, send a test email, confirm it's tagged/matched within ~1 min; then check the renew cron returns `{ healthy: n }`.

---

## 6. GDPR / data protection — where personal data flows

CaseLightning processes client personal data (names, addresses, email content,
documents). Know every point where it leaves your infrastructure.

### Where case info is injected into a model (sub-processors)
All of these send matter/email/document content to a third party — each needs a
DPA in place and an entry in your **Record of Processing Activities**:

- [ ] **Anthropic (Claude)** — every AI call funnels through `structured()` / `reviewDocument()` in [`lib/server/ai.ts`](../lib/server/ai.ts): `classifyEmail`, `summarizeThread`, `extractFacts`, `draftReply`, `draftUpdate`, `reviewDocument`, `proposeMatter`. Also the **doc-template `[[LLM prompt]]` fill** ([`doc-templates.ts`](../lib/server/doc-templates.ts)) sends matter variables to Claude. Confirm Anthropic zero-retention / commercial terms and DPA.
- [ ] **Groq (failover)** — if `ANTHROPIC_API_KEY` is unset, the same content goes to **Groq** (US, OpenAI-compatible). Either set the Anthropic key so failover never triggers in prod, **or** ensure Groq is a documented sub-processor with a DPA. Don't let the failover be an undisclosed processor.
- [ ] **Embeddings provider (Voyage or OpenAI)** — `embed()` sends chunk text (which includes personal data) to the embeddings API before storage in `kb_chunk`. Confirm DPA for whichever `EMBEDDINGS_PROVIDER` is set.
- [ ] **Microsoft Graph / OneDrive** — email + documents are read from and written to the *user's own* M365 tenant (least-privilege `/me/drive`, no cross-user/SharePoint scopes). This stays within the firm's own Microsoft tenant — good — but document it.
- [ ] **BYOK note**: when a user supplies their own Anthropic key, their data goes to *their* Anthropic account, not the firm's. Reflect this in the privacy notice.

### Controls already in place (audited 2026-06-23)
- [x] Email/document content is sent to models as **untrusted DATA, never instructions** (`SYSTEM_GUARD` prompt-injection defence in [`ai.ts`](../lib/server/ai.ts)) — reduces exfiltration-via-injection risk.
- [x] Personal data is **tenant- and matter-scoped** end to end (see §4) — no model call mixes two firms' data.
- [x] Per-call metering ([`usage_event`]) stores **token counts and cost, not message content**. Audited: `meta` only ever holds `{op, sourceKind}` / `{fileName}`; audit payloads carry IDs/categories only — no email or document body. Minor: `meta.fileName` and audit `toEmail` are identifiers (may contain a name/email) — acceptable for an audit trail, note in your ROPA.

### Policy / process
- [ ] DPA executed with each sub-processor above; sub-processor list published.
- [ ] Privacy notice / ROPA names Anthropic (+ Groq if applicable), the embeddings provider, Microsoft, Stripe, Supabase, Vercel.
- [ ] Data-residency: confirm acceptable regions (US LLM/embeddings processing) for UK firms, or restrict providers accordingly.
- [ ] Data-subject deletion path: deleting a matter cascades (`on delete cascade`) to identifiers, documents, kb_chunk, triage; confirm OneDrive files and any model-provider retention are addressed.
- [ ] Audit log (`audit_log`) and triage explainability retained per your retention policy.

---

## 7. Pre-launch smoke test (prod)

- [ ] Sign in via Entra end-to-end; `/me` returns the user.
- [ ] Create a matter → OneDrive folder + tracker provisioned.
- [ ] Receive a test client email → matched, tagged; a marketing email → **not** matched.
- [ ] Generate a doc-pack template into Case files.
- [ ] Complete a live Stripe checkout → plan/gating correct.
- [ ] `/internal` reachable only with `INTERNAL_DASHBOARD_KEY`.
- [ ] Error monitoring/logging in place (Vercel logs retained; alert on 5xx).

---

## 8. Outlook add-in store (AppSource / Microsoft commercial marketplace)

The add-in is distributed by submitting its manifest to **Partner Center →
Microsoft 365 and Copilot** (formerly Office Store / AppSource). Manifest source:
[`app/addin/manifest/route.ts`](../app/addin/manifest/route.ts) (dynamic) and the
checked-in [`public/addin/manifest.xml`](../public/addin/manifest.xml) (what you
upload). Keep the two in sync, and **keep `<Id>` constant forever** (changing it
orphans every install).

### 8a. Manifest must pass validation — code, no input needed
- [x] Manifest passes `npx office-addin-manifest validate` (schema, HTTPS, icons, source location). Re-run after any manifest edit.
- [x] Support URL resolves (was `/how-it-works` → 404; fixed to `/conveyi/how-it-works`). AppSource rejects unreachable support URLs.
- [x] Every functional URL is HTTPS on the production origin — audited: no localhost/preview `DefaultValue` URLs (the only `localhost` strings are in a dev-instructions comment; `http://schemas…` are XML namespaces, not links).
- [x] All five icon sizes (16/32/64/80/128) return 200 and are correct dimensions (verified against prod).
- [ ] `Version` is bumped on every resubmission (Store requires a higher version than the live one).
- [x] `AppDomains` — audited: the taskpane only navigates same-origin in-frame; OneDrive/account links open in a **new browser tab** (`_blank`), and Entra sign-in uses the Office dialog API — none require an AppDomain entry, so app-origin-only is correct.
- [ ] `Permissions` (`ReadWriteMailbox`) justified in the submission notes — it's a high scope; reviewers ask why (answer: read thread to draft, create draft replies, stamp categories).

### 8b. Required listing URLs — code (drafts done, needs your review)
- [x] **Privacy policy** page live at `/conveyi/privacy` (AppSource mandatory). **Needs legal review** — fill placeholders: legal entity, contact email, ICO reg no., address.
- [x] **Terms of use** page live at `/conveyi/terms` (AppSource mandatory). **Needs legal review.**
- [x] Privacy & Terms linked from the site footer.
- [ ] **Support contact**: dedicated support email/URL for the listing (currently SupportUrl → how-it-works). Decide a real support channel. *(needs your input)*

### 8c. Listing assets — partly done
- [x] **Store logo** 300×300 PNG generated from the brand SVG at [`public/addin/store-logo-300.png`](../public/addin/store-logo-300.png) (transparent, crisp). Swap if design wants a different mark.
- [ ] **Screenshots**: 1366×768 PNG, 1–10 of the add-in in Outlook. Requires the running add-in on a real mailbox. *(manual capture)*
- [ ] Short description (≤100 chars) and long description (listing copy) — approve wording.
- [ ] Optional promo video.
- [ ] Categories, search keywords, supported languages (en-GB).

### 8d. Partner Center account & identity — needs your input
- [ ] Microsoft **Partner Center** account enrolled in the commercial marketplace program (company verification, tax/payout profile — can take days).
- [ ] **Publisher domain verified** and the Entra app registration is **multi-tenant** (firms sign in from their own tenants).
- [ ] App registration redirect URIs include the production callback; admin-consent URL ready for firms whose IT locks down add-ins.
- [ ] Decide listing type: free / trial / paid-via-Microsoft. (Billing is currently via Stripe in-app, so the listing is likely "free to install, sign-in required".)

### 8e. Validation policies & certification — mixed
- [ ] Meets [Commercial marketplace certification policy 1140](https://learn.microsoft.com/legal/marketplace/certification-policies) (functionality, security, no broken links, working test account).
- [ ] Provide reviewer **test credentials** + clear test steps (how to reach a matched email, what to expect).
- [ ] Works on Outlook on the web + Windows + Mac (manifest already targets these). Decide whether to opt into **mobile** (would need a MobileFormFactor + a mobile-friendly taskpane).
- [ ] (Optional) Microsoft 365 Certification for enterprise trust — heavyweight security review; consider post-launch.
