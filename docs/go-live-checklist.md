# CaseLightning — Go-Live Checklist

Work top to bottom. Each item names the exact env var / code path so it's
verifiable, not aspirational. "Verify" items have a concrete check.

---

## 1. Environment & secrets (Vercel → Project → Settings → Environment Variables)

All read in [`lib/server/config.ts`](../lib/server/config.ts). Set for **Production**.

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

## 2. Stripe (feature `billing`)

Billing is gated lazily: `isPremiumTenant()` ([`lib/server/plan.ts`](../lib/server/plan.ts)) **returns `true` for everyone when `STRIPE_SECRET_KEY` is unset** (pilot mode). So until these are set, *premium gating is wide open*.

- [ ] `STRIPE_SECRET_KEY` — **live** key (`sk_live_…`, not test). This is the switch that turns gating on.
- [ ] `STRIPE_WEBHOOK_SECRET` — from the live webhook endpoint (`whsec_…`).
- [ ] `STRIPE_PRICE_STANDARD`, `STRIPE_PRICE_TEAM` — **live-mode** recurring price IDs. Test-mode IDs will 400 at checkout.
- [ ] `BILLING_CURRENCY` — `gbp`.
- [ ] `REFERRAL_COMMISSION_PENNIES` — confirm (default `5000` = £50/mo).
- [ ] Webhook endpoint created in Stripe → `https://<APP_URL>/api/v1/billing/webhook`, subscribed to at least: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`.
- [ ] **Verify**: a real test purchase on the live keys → `billing_account.plan` flips to `team`/`standard` and `status=active`; then confirm a Standard tenant is blocked from premium (auto-send rules, unlimited onboarding) and a Team tenant is allowed.
- [ ] Rotate any keys that were ever pasted into chat/logs/test deploys before going live.

---

## 3. Database & migrations

- [ ] Run **all** migrations against prod (`db/migrations/0xx_*.sql`). Prod creds aren't readable from the dev box — run via `npm run migrate` with prod `DATABASE_URL`, or paste into the Supabase SQL editor.
- [ ] Confirm the latest ones are applied: `021_doc_templates.sql` (doc packs) and `022_auto_triage_flag.sql` (auto-triage self-heal). Without 021 the Templates panel is empty; without 022 the subscription self-heal can't track intent.
- [ ] `select max(version)` (or your migration ledger) matches the highest file number.

---

## 4. Per-org isolation (multi-tenant gating) — verify, don't assume

The product is multi-tenant; one firm must never see another's matters or data.

- [ ] **Every matter access goes through `assertMatterAccess(user, matterId)`** ([`lib/server/guard.ts`](../lib/server/guard.ts)), which requires `matter.tenant_id = user.tenantId`. Spot-check that new routes added since the last review call it (grep `assertMatterAccess` vs routes under `app/api/v1/matters/[matterId]/`).
- [ ] **Every query is tenant-scoped.** Matching ([`matching.ts`](../lib/server/matching.ts)), RAG retrieval, documents, tasks, templates, triage — all filter `tenant_id = $1`. New `doc_template` queries are scoped (`tenant_id`), and the doc-pack route calls `assertMatterAccess`.
- [ ] **RAG can't leak across matters.** `retrieveMatterContext` filters `where tenant_id = $1 and matter_id = $2` before the vector search — context is matter-AND-tenant scoped, never the whole tenant. Cross-matter retrieval is blocked unless an explicit `x-cross-matter` header + approval token is present (`assertCrossMatterAllowed`).
- [ ] **Admin endpoints require `requireRole(['ADMIN'])`** and are tenant-scoped (templates, doc-templates, policies, users, rules).
- [ ] **Verify with two tenants**: as firm A, attempt to GET a firm-B matter id → expect "Matter not found or inaccessible"; confirm firm A's template/doc-pack list shows only firm A's templates.
- [ ] Self-address matching exclusion is live (a firm's own mailbox/domain is never a match signal) — see [`tenantSelfAddresses`](../lib/server/matching.ts).

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

### Controls already in place (verify still true)
- [ ] Email/document content is sent to models as **untrusted DATA, never instructions** (`SYSTEM_GUARD` prompt-injection defence) — reduces exfiltration-via-injection risk.
- [ ] Personal data is **tenant- and matter-scoped** end to end (see §4) — no model call mixes two firms' data.
- [ ] Per-call metering ([`usage_event`]) stores **token counts and cost, not message content** — confirm no raw PII is logged in `usage_event.metadata` or audit payloads.

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
