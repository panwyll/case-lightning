# CaseLightning

Case-aware AI email drafting and AI case management for UK conveyancers — **inside Outlook**. Zero install, no new portal: the work happens in Outlook, the per-case knowledge base is a OneDrive folder, and the live tracker is an Excel file. The user never leaves Microsoft 365.

This single Next.js app serves three things:

- **Marketing site** — the landing/waitlist pages (`/`, `/how-it-works`, `/pricing`, …).
- **Outlook add-in** — the taskpane at `/addin/taskpane` (sideload `public/addin/manifest.xml`).
- **Product API** — `/api/v1/*` route handlers (Microsoft Graph + Claude + Postgres/pgvector).

### Architecture at a glance

- **Backend (invisible to users):** Supabase Postgres + `pgvector` holds matter metadata, RAG vectors and an audit log. Accessed via `lib/server/*`.
- **User-facing storage:** each matter gets a OneDrive folder + `Tracker.xlsx`, written through Microsoft Graph.
- **Identity:** Microsoft Entra OAuth; JWT cookie session (`jose`). Strict tenant + matter isolation; every action is audited; replies are **draft-only — there is no send endpoint**.
- **AI:** Claude (`@anthropic-ai/sdk`, default `claude-opus-4-8`) for summarise / extract / draft via forced tool-use structured outputs. Embeddings are pluggable (Voyage default, OpenAI optional); RAG degrades gracefully when no embeddings key is set.

The product features are **feature-gated**: if their env vars aren't set, the marketing site still builds and deploys, and product routes return a clean `503` listing the missing variables (`GET /api/v1/health` shows which features are live).

### Product setup

1. **Database** — point `DATABASE_URL` at Supabase Postgres, then run migrations (enables `vector` + `pgcrypto`, creates all tables):
   ```bash
   npm run migrate
   ```
2. **Azure app registration** (single-tenant recommended). Redirect URI `${APP_URL}/api/v1/auth/callback`. Grant delegated Graph scopes: `User.Read`, `Mail.Read`, `Mail.ReadWrite`, `Files.ReadWrite`, optionally `Sites.ReadWrite.All`, `Team.ReadBasic.All`, `ChannelMessage.Send`. Admin-consent the tenant.
3. **Env** — copy `.env.example` → `.env.local` and fill `DATABASE_URL`, `SESSION_JWT_SECRET`, `APP_ENCRYPTION_KEY`, the `AZURE_*` values, `ANTHROPIC_API_KEY`, and (optionally) `VOYAGE_API_KEY`.
4. **Run with local HTTPS** (Office add-ins require HTTPS for sideloading):
   ```bash
   npm run dev:https   # serves https://localhost:3000
   ```
5. **Sideload** `public/addin/manifest.xml` in Outlook (web or desktop), open a message, and click **Open CaseLightning** in the ribbon. For production, replace every `https://localhost:3000` in the manifest with your Vercel domain.

### End-to-end flow (UAT)

Open a thread → **New matter** (a OneDrive folder + `Tracker.xlsx` appear in your OneDrive) → **Summarise** → **Extract facts** (tracker updates) → **Draft reply** (Claude) → **Create Outlook draft** (lands in Drafts, never sent) → **Save to matter** (email saved to the OneDrive folder).

## Deploying to Vercel

This repository uses **Next.js (App Router)** and is ready to deploy on Vercel.

### 1) Install dependencies

```bash
npm install
```

### 2) Run locally (optional)

```bash
npm run dev
```

### 3) Build locally (optional check)

```bash
npm run build
```

### 4) Deploy on Vercel

1. Import this repository in Vercel.
2. Keep the detected framework as **Next.js**.
3. Leave the default build command (`next build`) and output settings.
4. Deploy.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_STRIPE_PAYMENT_LINK` | **Yes** | Full Stripe Payment Link URL (e.g. `https://buy.stripe.com/xxxxx`). The `/start-trial` route redirects here, forwarding all UTM parameters so attribution is preserved in Stripe and GA4. |
| `NEXT_PUBLIC_GA_ID` | No | Google Analytics 4 measurement ID (e.g. `G-XXXXXXXXXX`). Enables CTA-click tracking and the `begin_trial` event fired just before the Stripe redirect. |

Set both variables in **Vercel → Project → Settings → Environment Variables**.

> The product backend needs additional variables (database, Azure/Entra, Claude, embeddings). See [`.env.example`](.env.example) and the **Product setup** section above.
