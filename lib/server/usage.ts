/**
 * Per-call usage metering — the fact stream behind every analytics view.
 *
 * One row per metered operation (an AI generation, an embeddings call) capturing
 * who/what/which-model/how-many-tokens/how-much-it-cost/how-long-it-took. This is
 * the raw grain; the rollups and economics live in SQL views (009_analytics.sql)
 * consumed by an external BI tool.
 *
 * Metering is best-effort: a failed insert here must NEVER fail the user's
 * request, so every write is wrapped and swallowed (with a console warning).
 */
import { query } from './db';
import { aiCostUsd, embedCostUsd, type AiProvider, type EmbedProvider, type TokenUsage } from './pricing';

/** Stable feature taxonomy — one value per metered AI/embed operation. */
export type UsageFeature =
  | 'THREAD_SUMMARISE'
  | 'FACT_EXTRACT'
  | 'EMAIL_CLASSIFY'
  | 'DRAFT_REPLY'
  | 'DRAFT_UPDATE'
  | 'DOC_REVIEW'
  | 'DOC_FILL'
  | 'DOC_TEMPLATE_GEN'
  | 'MATTER_PROPOSE'
  | 'PLAYBOOK_SUGGEST'
  | 'EMBED';

export interface UsageContext {
  tenantId: string;
  userId?: string | null;
  matterId?: string | null;
  feature: UsageFeature;
  /** Optional correlation ids for precise journey stitching (gap-based otherwise). */
  sessionId?: string | null;
  requestId?: string | null;
}

interface RecordInput extends UsageContext {
  kind: 'AI' | 'EMBED';
  provider: string;
  model: string;
  tier?: string | null;
  input: TokenUsage;
  costUsd: number;
  priced: boolean;
  byok: boolean;
  status: 'SUCCESS' | 'FAILED';
  latencyMs?: number | null;
  meta?: Record<string, unknown>;
}

async function insertUsage(row: RecordInput): Promise<void> {
  try {
    await query(
      `insert into usage_event
        (tenant_id, actor_user_id, matter_id, event_type, kind, provider, model, tier,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, priced, byok, status, latency_ms, session_id, request_id, meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)`,
      [
        row.tenantId,
        row.userId ?? null,
        row.matterId ?? null,
        row.feature,
        row.kind,
        row.provider,
        row.model,
        row.tier ?? null,
        Math.round(row.input.inputTokens || 0),
        Math.round(row.input.outputTokens || 0),
        Math.round(row.input.cacheReadTokens || 0),
        Math.round(row.input.cacheWriteTokens || 0),
        row.costUsd,
        row.priced,
        row.byok,
        row.status,
        row.latencyMs ?? null,
        row.sessionId ?? null,
        row.requestId ?? null,
        JSON.stringify(row.meta ?? {}),
      ]
    );
  } catch (err) {
    // Never let metering break the product path.
    console.warn('[usage] failed to record usage_event:', (err as Error).message);
  }
}

/** Record an AI generation call. BYOK calls cost us nothing (user pays). */
export async function recordAiUsage(args: {
  ctx: UsageContext;
  provider: AiProvider;
  model: string;
  tier?: string | null;
  usage: TokenUsage;
  byok: boolean;
  status?: 'SUCCESS' | 'FAILED';
  latencyMs?: number | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const { costUsd, priced } = aiCostUsd(args.provider, args.model, args.usage);
  await insertUsage({
    ...args.ctx,
    kind: 'AI',
    provider: args.provider,
    model: args.model,
    tier: args.tier ?? null,
    input: args.usage,
    costUsd: args.byok ? 0 : costUsd,
    priced,
    byok: args.byok,
    status: args.status ?? 'SUCCESS',
    latencyMs: args.latencyMs ?? null,
    meta: args.meta,
  });
}

/** Record an embeddings call. Embeddings always use the firm's key (no BYOK). */
export async function recordEmbedUsage(args: {
  ctx: UsageContext;
  provider: EmbedProvider;
  model: string;
  tokens: number;
  latencyMs?: number | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const { costUsd, priced } = embedCostUsd(args.model, args.tokens);
  await insertUsage({
    ...args.ctx,
    feature: 'EMBED',
    kind: 'EMBED',
    provider: args.provider,
    model: args.model,
    input: { inputTokens: args.tokens, outputTokens: 0 },
    costUsd,
    priced,
    byok: false,
    status: 'SUCCESS',
    latencyMs: args.latencyMs ?? null,
    meta: args.meta,
  });
}
