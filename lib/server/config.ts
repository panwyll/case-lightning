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
  //  - Mail.ReadWrite covers reading threads AND creating draft replies (no
  //    separate Mail.Read needed; there is no send scope — draft-only by design).
  //  - MailboxSettings.ReadWrite is required to manage the master category list
  //    (create/colour the Reply/Action/Delegate tags). Without it Outlook still
  //    lets us stamp category names onto a message via Mail.ReadWrite, but it
  //    auto-creates them colourless — so triage tags would show up with no colour.
  //  - Files.ReadWrite is the user's own OneDrive (matter folder + Excel tracker).
  //    We deliberately do NOT request Files.ReadWrite.All / Sites.ReadWrite.All —
  //    nothing touches other users' files or SharePoint sites (all /me/drive).
  //  - Team.ReadBasic.All + ChannelMessage.Send back the optional "post summary
  //    to Teams" feature only.
  graphScopes: (
    env('GRAPH_SCOPES') ??
    'User.Read Mail.ReadWrite MailboxSettings.ReadWrite Files.ReadWrite Team.ReadBasic.All ChannelMessage.Send'
  ).split(/\s+/),

  // AI — Claude, tiered by task so we don't pay Opus rates to label emails:
  //   draft  → Opus 4.8 (quality matters most on client-facing drafts)
  //   summarise/extract → Sonnet 4.6 (good balance)
  //   classify (triage) → Haiku 4.5 (fast + cheap; perfect for a label)
  anthropicApiKey: env('ANTHROPIC_API_KEY'),
  anthropicModel: env('ANTHROPIC_MODEL') ?? 'claude-opus-4-8',
  anthropicFastModel: env('ANTHROPIC_FAST_MODEL') ?? 'claude-sonnet-4-6',
  anthropicClassifyModel: env('ANTHROPIC_CLASSIFY_MODEL') ?? 'claude-haiku-4-5',

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
  // Recurring price IDs per plan — power in-app upgrade/downgrade (Checkout for new
  // subscribers, subscription-item swap for existing ones). Three tiers:
  //   plus       — entry; no premium AI/automation, single seat
  //   pro        — premium AI/automation, single seat, heavy-LLM usage capped
  //   enterprise — premium AI/automation + team (multi-seat), uncapped
  // Optional: when unset the checkout route 503s; plan changes still work via portal.
  stripePricePlus: env('STRIPE_PRICE_PLUS'),
  stripePricePro: env('STRIPE_PRICE_PRO'),
  stripePriceEnterprise: env('STRIPE_PRICE_ENTERPRISE'),
  // Pro tier is rate-limited on heavy LLM work (e.g. AI document generation). This
  // caps the number of heavy-LLM calls (DOC_FILL) a Pro tenant can make per calendar
  // month; Enterprise is uncapped. Tune without a deploy via env.
  proHeavyLlmMonthlyCap: Number(env('PRO_HEAVY_LLM_MONTHLY_CAP') ?? '300'),
  // Trial users get their chosen tier's features, but expensive AI work (doc fills,
  // matter reconciliation) is capped to a few attempts so they get a flavour without
  // running up cost. Trial backlog/onboarding lookback is also clamped (days).
  trialExpensiveCap: Number(env('TRIAL_EXPENSIVE_CAP') ?? '3'),
  trialLookbackDays: Number(env('TRIAL_LOOKBACK_DAYS') ?? '7'),
  // Historical-import (backlog scan) is heavy, so cap it per calendar month. Non-pro
  // gets fewer with an upsell; pro/enterprise get more.
  onboardingMonthlyCapFree: Number(env('ONBOARDING_MONTHLY_CAP_FREE') ?? '1'),
  onboardingMonthlyCapPremium: Number(env('ONBOARDING_MONTHLY_CAP_PREMIUM') ?? '3'),
  // Recurring single-level referral commission, in pennies (£50 = 5000).
  referralCommissionPennies: Number(env('REFERRAL_COMMISSION_PENNIES') ?? '5000'),
  billingCurrency: env('BILLING_CURRENCY') ?? 'gbp',

  // Owner-only internal analytics dashboard. The /internal page and its metrics
  // API are gated by this shared key (independent of the Outlook/Entra session).
  internalDashboardKey: env('INTERNAL_DASHBOARD_KEY'),
};

export type FeatureKey = 'db' | 'auth' | 'graph' | 'ai' | 'billing';

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
