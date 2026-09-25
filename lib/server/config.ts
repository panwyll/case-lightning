/**
 * Central runtime config for the CaseLightning product backend.
 *
 * Unlike the original conveyancing-copilot config (which threw on startup for any
 * missing var), this is lazy + feature-scoped so the marketing site keeps building
 * and deploying on Vercel even when M365 / AI credentials are not yet set. Product
 * routes call `assertFeature(...)` and return a clean 503 if their dependencies are
 * missing, mirroring the pattern already used in app/api/waitlist/route.ts.
 */

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export const config = {
  appUrl: env('APP_URL') ?? env('NEXT_PUBLIC_APP_URL') ?? 'https://localhost:3000',

  // Backend database — a direct Postgres connection (Supabase pooler / DATABASE_URL).
  // Used for raw SQL incl. pgvector `<=>`, which supabase-js cannot express cleanly.
  // Falls back to the vars the Vercel↔Supabase integration already provisions, so
  // no separate DATABASE_URL needs setting in Vercel.
  databaseUrl: env('DATABASE_URL') ?? env('POSTGRES_URL') ?? env('POSTGRES_PRISMA_URL'),

  // Session + secret encryption
  sessionJwtSecret: env('SESSION_JWT_SECRET'),
  appEncryptionKey: env('APP_ENCRYPTION_KEY'),

  // Microsoft Entra (Azure AD) OAuth
  azureTenantId: env('AZURE_TENANT_ID'),
  azureClientId: env('AZURE_CLIENT_ID'),
  azureClientSecret: env('AZURE_CLIENT_SECRET'),
  azureRedirectUri:
    env('AZURE_REDIRECT_URI') ??
    `${env('APP_URL') ?? 'https://localhost:3000'}/api/v1/auth/callback`,
  // Least-privilege Graph scopes so admin consent is easier for firms' IT:
  //  - Mail.ReadWrite covers reading threads AND creating draft replies.
  //  - Mail.Send lets a *reviewed* draft be sent from the pane (admin-consented on the
  //    app reg, so safe to request).
  //  - !! DO NOT add a scope here (or to the Vercel GRAPH_SCOPES env) until the Azure
  //    app registration has that permission AND it's ADMIN-CONSENTED (green). Requesting
  //    an unconsented scope makes Entra reject the ENTIRE token exchange (AADSTS65001),
  //    taking down ALL Graph access — not just the new feature. Tasks.ReadWrite (the To
  //    Do sync) is HELD BACK for exactly this reason — it isn't on the app reg yet; add
  //    + consent it in Azure first, then re-add it here.
  //  - MailboxSettings.ReadWrite is required to manage the master category list
  //    (create/colour the Reply/Action/Delegate tags). Without it Outlook still
  //    lets us stamp category names onto a message via Mail.ReadWrite, but it
  //    auto-creates them colourless — so triage tags would show up with no colour.
  //  - Files.ReadWrite is the user's own OneDrive (the matter folder).
  //    We deliberately do NOT request Files.ReadWrite.All / Sites.ReadWrite.All —
  //    nothing touches other users' files or SharePoint sites (all /me/drive).
  //  - Team.ReadBasic.All + ChannelMessage.Send back the optional "post summary
  //    to Teams" feature only.
  graphScopes: (
    env('GRAPH_SCOPES') ??
    'User.Read Mail.ReadWrite Mail.Send MailboxSettings.ReadWrite Files.ReadWrite Team.ReadBasic.All ChannelMessage.Send'
  ).split(/\s+/),

  // AI — Claude, tiered by task so we don't pay Opus rates to label emails:
  //   draft  → Opus 4.8 (quality matters most on client-facing drafts)
  //   summarise/extract → Sonnet 4.6 (good balance)
  //   classify (triage) → Haiku 4.5 (fast + cheap; perfect for a label)
  anthropicApiKey: env('ANTHROPIC_API_KEY'),
  anthropicModel: env('ANTHROPIC_MODEL') ?? 'claude-opus-4-8',
  anthropicFastModel: env('ANTHROPIC_FAST_MODEL') ?? 'claude-sonnet-4-6',
  anthropicClassifyModel: env('ANTHROPIC_CLASSIFY_MODEL') ?? 'claude-haiku-4-5',

  // Conveyancing engine models. Extraction reads scanned PDFs and must be right —
  // it runs on the most capable tier; summaries/report drafts likewise (they are
  // reviewed by a person but the citations must be exact). Client Q&A is tightly
  // constrained to FAQ rephrasing so it runs at low effort on the same model.
  engineExtractModel: env('ENGINE_EXTRACT_MODEL') ?? 'claude-opus-5',
  engineDraftModel: env('ENGINE_DRAFT_MODEL') ?? 'claude-opus-5',
  engineQaModel: env('ENGINE_QA_MODEL') ?? 'claude-opus-5',
  // Which port implementations the engine wires (adapters.ts). Each is 'mock' until
  // its credentials are present; set explicitly to force one way or the other.
  engineExtractor: (env('ENGINE_EXTRACTOR') ?? 'auto') as 'auto' | 'claude' | 'fixture',
  engineAi: (env('ENGINE_AI') ?? 'auto') as 'auto' | 'claude' | 'template',
  engineComms: (env('ENGINE_COMMS') ?? 'auto') as 'auto' | 'real' | 'mock',

  // InfoTrack (searches, AML/ID, HMLR official copies) — component #4.
  infotrackBaseUrl: env('INFOTRACK_BASE_URL'),
  infotrackClientId: env('INFOTRACK_CLIENT_ID'),
  infotrackClientSecret: env('INFOTRACK_CLIENT_SECRET'),
  infotrackTokenUrl: env('INFOTRACK_TOKEN_URL'),
  infotrackWebhookSecret: env('INFOTRACK_WEBHOOK_SECRET'),

  // Client comms — component #5. WhatsApp via the Meta Cloud API; email via Resend.
  whatsappPhoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
  whatsappAccessToken: env('WHATSAPP_ACCESS_TOKEN'),
  whatsappVerifyToken: env('WHATSAPP_VERIFY_TOKEN'),
  whatsappAppSecret: env('WHATSAPP_APP_SECRET'),
  resendApiKey: env('RESEND_API_KEY'),
  resendFromEmail: env('RESEND_FROM_EMAIL'),
  // Third-party chases: 'draft' leaves an Outlook draft + worklist item for a human to
  // send (default, safest); 'send' sends the template chase automatically from the
  // matter's fee-earner mailbox (spec #5: automated template chases).
  /** Chases are the engine's job: sent when due. 'draft' leaves them in Outlook Drafts for a person instead. */
  chaseMode: (env('ENGINE_CHASE_MODE') ?? 'send') as 'draft' | 'send',
  /** Acknowledgements of things that arrive: sent at once (default) or not at all. */
  ackMode: (env('ENGINE_ACK_MODE') ?? 'send') as 'send' | 'off',

  // Groq failover (OpenAI-compatible). Used only when no Anthropic key is set —
  // a cheaper/faster stopgap; Anthropic is preferred for drafting quality.
  groqApiKey: env('GROQ_API_KEY'),
  groqModel: env('GROQ_MODEL') ?? 'llama-3.3-70b-versatile',
  groqFastModel: env('GROQ_FAST_MODEL') ?? 'llama-3.1-8b-instant',

  // Embeddings provider: 'voyage' (default) | 'openai'. Optional — RAG degrades
  // gracefully to non-vector retrieval when no embeddings key is configured.
  embeddingsProvider: (env('EMBEDDINGS_PROVIDER') ?? 'voyage') as 'voyage' | 'openai',
  voyageApiKey: env('VOYAGE_API_KEY'),
  voyageModel: env('VOYAGE_MODEL') ?? 'voyage-3-large',
  openAiApiKey: env('OPENAI_API_KEY'),
  openAiEmbeddingModel: env('OPENAI_EMBEDDING_MODEL') ?? 'text-embedding-3-large',
  // Vector dimension stored in kb_chunk.embedding. Must match the embeddings model.
  // voyage-3-large = 1024, text-embedding-3-large = 3072.
  embeddingDim: Number(env('EMBEDDING_DIM') ?? '1024'),

  // OneDrive layout — per-case folders live under this root in the user's drive.
  oneDriveRoot: env('ONEDRIVE_ROOT') ?? 'CONVEYi',

  allowedExternalDomains: (env('ALLOWED_EXTERNAL_DOMAINS') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),

  // Billing + referrals (Stripe)
  stripeSecretKey: env('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  // Usage-based billing: one metered recurring price — £100 per case. The price is
  // attached to a Stripe Billing Meter; we report one meter event per case the first
  // time CONVEYi does chargeable work on it (see lib/server/case-billing.ts). Stripe
  // sums the events and invoices monthly. Optional: when unset the checkout route 503s.
  stripePriceCase: env('STRIPE_PRICE_CASE'),
  // event_name of the Billing Meter the price above reads from (Stripe dashboard →
  // Billing → Meters). The meter must map customers by stripe_customer_id.
  stripeCaseMeterEvent: env('STRIPE_CASE_METER_EVENT') ?? 'conveyi_case',
  // Advertised price per case, in pennies. Display only — Stripe's price object is
  // the source of truth for what's charged; keep the two in step.
  casePricePennies: Number(env('CASE_PRICE_PENNIES') ?? '10000'),
  // Trial firms get the full product, but expensive AI work (doc fills, matter
  // reconciliation) is capped to a few attempts so they get a flavour without running
  // up cost — a trial case is never charged, so this is the only brake. Trial backlog/onboarding lookback is also clamped (days).
  trialExpensiveCap: Number(env('TRIAL_EXPENSIVE_CAP') ?? '3'),
  // How far back a trial's backlog scan may reach. This is the first thing a new firm
  // sees, so it has to surface REAL matters: 7 days was a demo, and a live conveyance
  // can easily go a fortnight without traffic. 30 days catches anything active while
  // still excluding a full historical backfill (that's what paying unlocks).
  trialLookbackDays: Number(env('TRIAL_LOOKBACK_DAYS') ?? '30'),
  // Length of the free trial, in days — used by BOTH trial routes. For the card-free
  // signup path (see getTenantBilling) we own the clock: the trial runs this many days
  // from tenant.created_at with no payment details. For a Stripe-managed trial it's
  // passed as subscription_data.trial_period_days at checkout and the subscription
  // webhook drives status trialing → active. 0 = no trial. NOTE: the /start-trial
  // funnel uses a hosted Stripe Payment Link, whose trial is set in the dashboard.
  //
  // 60 days while we're courting the first firms. A conveyance takes months, so a
  // fortnight never spanned enough of a real matter for anyone to judge it. Because the
  // card-free clock is computed from tenant.created_at rather than stored per tenant,
  // raising this EXTENDS EXISTING TENANTS TOO — which is the intent for now.
  trialDays: Number(env('TRIAL_DAYS') ?? '60'),
  // Emails a trial may process per month — trials get the full product but not full
  // volume. 0 = fall back to EMAIL_CAP.
  emailCapTrial: Number(env('EMAIL_CAP_TRIAL') ?? '200'),
  // Historical-import (backlog scan) is heavy, so cap it per calendar month.
  onboardingMonthlyCap: Number(env('ONBOARDING_MONTHLY_CAP') ?? '3'),
  // Minutes a drafted reply saves vs writing from scratch — used only for the clearly
  // labelled "estimated time saved" in the import-impact report. Tune via env.
  estimatedMinutesSavedPerReply: Number(env('ESTIMATED_MINUTES_SAVED_PER_REPLY') ?? '8'),
  // "Chase up": a matched, OPEN matter's thread becomes a chase when the firm sent the
  // last message and no reply has arrived within this many days. Tune via env.
  chaseSlaDays: Number(env('CHASE_SLA_DAYS') ?? '5'),
  // Monthly cap on emails the tool processes (triage/analyse) for a paying firm.
  // 0 = unlimited. Per-case pricing means volume is already paid for, so this is a
  // safety valve against runaway mailboxes, not a funnel lever.
  emailCap: Number(env('EMAIL_CAP') ?? '0'),
  // Recurring single-level referral commission — a share of what the *referred* firm
  // actually pays each invoice, capped. Commission = min(cap, rate × invoice).
  // Under per-case billing an invoice is £100 × cases that month, so a referred firm
  // that opens one case earns £25 and one that opens two or more earns the £50 cap.
  referralCommissionPennies: Number(env('REFERRAL_COMMISSION_PENNIES') ?? '5000'), // the cap (max)
  referralCommissionRate: Number(env('REFERRAL_COMMISSION_RATE') ?? '0.25'),
  billingCurrency: env('BILLING_CURRENCY') ?? 'gbp',

  // LEAP (leap.build) as the backend — phase 0/1. Hosts are configured, never derived:
  // LEAP's reference is registration-gated, so the region hosts are set once it is open.
  leapAuthBaseUrl: env('LEAP_AUTH_BASE_URL'),
  leapApiBaseUrl: env('LEAP_API_BASE_URL'),
  leapClientId: env('LEAP_CLIENT_ID'),
  leapClientSecret: env('LEAP_CLIENT_SECRET'),
  leapApiKey: env('LEAP_API_KEY'),
  leapWebhookSecret: env('LEAP_WEBHOOK_SECRET'),
  leapRegion: env('LEAP_REGION') ?? 'uk',
  leapRedirectUri: env('LEAP_REDIRECT_URI') ?? `${env('APP_URL') ?? 'https://localhost:3000'}/api/v1/integrations/leap/callback`,
  // Enrol LEAP matters in shadow mode first (addendum 3): observe before acting. Set to 'live' once a firm is promoted.
  leapEnrolMode: (env('LEAP_ENROL_MODE') ?? 'shadow') as 'shadow' | 'live',
  // Matter-type name patterns (regex, '|'-separated) that get enrolled. Default: purchases.
  leapEnrolPatterns: env('LEAP_ENROL_PATTERNS'),
  // Write engine conclusions back into LEAP as tasks + file notes (phase 1). 'auto' = on when connected.
  leapWriteback: (env('LEAP_WRITEBACK') ?? 'auto') as 'auto' | 'on' | 'off',
  // Upload engine-generated documents (report drafts, escalation dossiers) into the LEAP matter.
  leapUploadGenerated: (env('LEAP_UPLOAD_GENERATED') ?? '1') !== '0',

  // InTouch (docs/intouch-integration.md) — the client-facing half: onboarding, identity
  // checks, the forms the client completes, and the portal they watch. Hosts are
  // configured, never derived: the reference is registration-gated.
  intouchApiBaseUrl: env('INTOUCH_API_BASE_URL'),
  intouchAuthBaseUrl: env('INTOUCH_AUTH_BASE_URL'),
  intouchClientId: env('INTOUCH_CLIENT_ID'),
  intouchClientSecret: env('INTOUCH_CLIENT_SECRET'),
  intouchApiKey: env('INTOUCH_API_KEY'),
  intouchWebhookSecret: env('INTOUCH_WEBHOOK_SECRET'),
  // A firm's connection is server-to-server by default; switch to authorization_code if
  // InTouch requires a person to consent.
  intouchGrant: (env('INTOUCH_GRANT') ?? 'client_credentials') as 'client_credentials' | 'authorization_code',
  intouchRedirectUri: env('INTOUCH_REDIRECT_URI') ?? `${env('APP_URL') ?? 'https://localhost:3000'}/api/v1/integrations/intouch/callback`,
  // Pushing a milestone writes to something the CLIENT sees, so it is off until the firm
  // turns it on per connection; this is the kill switch for the whole estate.
  intouchMilestones: (env('INTOUCH_MILESTONES') ?? 'auto') as 'auto' | 'off',

  // Owner-only internal analytics dashboard. The /internal page and its metrics
  // API are gated by this shared key (independent of the Outlook/Entra session).
  internalDashboardKey: env('INTERNAL_DASHBOARD_KEY'),
};

export type FeatureKey = 'db' | 'auth' | 'graph' | 'ai' | 'billing' | 'leap';

const FEATURE_REQUIREMENTS: Record<FeatureKey, Array<[string, string | undefined]>> = {
  db: [['DATABASE_URL', config.databaseUrl]],
  auth: [
    ['DATABASE_URL', config.databaseUrl],
    ['SESSION_JWT_SECRET', config.sessionJwtSecret],
    ['AZURE_TENANT_ID', config.azureTenantId],
    ['AZURE_CLIENT_ID', config.azureClientId],
    ['AZURE_CLIENT_SECRET', config.azureClientSecret],
  ],
  graph: [
    ['AZURE_TENANT_ID', config.azureTenantId],
    ['AZURE_CLIENT_ID', config.azureClientId],
    ['AZURE_CLIENT_SECRET', config.azureClientSecret],
  ],
  ai: [['ANTHROPIC_API_KEY', config.anthropicApiKey]],
  billing: [
    ['DATABASE_URL', config.databaseUrl],
    ['STRIPE_SECRET_KEY', config.stripeSecretKey],
    ['STRIPE_WEBHOOK_SECRET', config.stripeWebhookSecret],
  ],
  leap: [
    ['DATABASE_URL', config.databaseUrl],
    ['APP_ENCRYPTION_KEY', config.appEncryptionKey],
    ['LEAP_AUTH_BASE_URL', config.leapAuthBaseUrl],
    ['LEAP_API_BASE_URL', config.leapApiBaseUrl],
    ['LEAP_CLIENT_ID', config.leapClientId],
    ['LEAP_CLIENT_SECRET', config.leapClientSecret],
  ],
};

/** Returns the list of missing env var names for a feature (empty = ready). */
export function missingFor(feature: FeatureKey): string[] {
  // AI is satisfied by either an Anthropic key (preferred) or a Groq failover key.
  if (feature === 'ai') {
    return config.anthropicApiKey || config.groqApiKey ? [] : ['ANTHROPIC_API_KEY (or GROQ_API_KEY)'];
  }
  return FEATURE_REQUIREMENTS[feature].filter(([, v]) => !v).map(([name]) => name);
}

export class FeatureUnavailableError extends Error {
  constructor(public feature: FeatureKey, public missing: string[]) {
    super(`Feature "${feature}" is not configured. Missing: ${missing.join(', ')}`);
    this.name = 'FeatureUnavailableError';
  }
}

/** Throws FeatureUnavailableError if a feature's env vars are not all present. */
export function assertFeature(feature: FeatureKey): void {
  const missing = missingFor(feature);
  if (missing.length) throw new FeatureUnavailableError(feature, missing);
}
