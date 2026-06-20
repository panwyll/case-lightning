/**
 * Model pricing — the source of truth for "how much did that call cost us".
 *
 * Rates are USD per 1,000,000 tokens. We bill in whatever currency the upstream
 * provider charges (USD for Anthropic/Groq/Voyage/OpenAI), so usage_event stores
 * a `cost_usd`; the GBP profit views convert via the tunable `analytics_param`
 * row `gbp_per_usd`. Keeping cost in the provider's native currency means a
 * historical event keeps its true cost even if the FX rate moves.
 *
 * When a model id isn't in the table we fall back to a sane default and flag it
 * (`priced: false` on the returned breakdown) so unknown-model spend is visible
 * rather than silently counted as zero.
 */

export type AiProvider = 'anthropic' | 'groq';
export type EmbedProvider = 'voyage' | 'openai';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface ModelRate {
  /** USD per 1M tokens. */
  input: number;
  output: number;
  /** Cache-read / cache-write per 1M tokens. Default to derived multiples of input. */
  cacheRead?: number;
  cacheWrite?: number;
}

// USD per 1M tokens. Kept in sync with platform.claude.com/docs/en/pricing.
// Cache read ≈ 0.1× input; cache write (5-min TTL) ≈ 1.25× input.
const ANTHROPIC_RATES: Record<string, ModelRate> = {
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

// Groq published rates (USD per 1M). Failover only; approximate and cheap.
const GROQ_RATES: Record<string, ModelRate> = {
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
};

// Embeddings: USD per 1M tokens (output side is n/a).
const EMBED_RATES: Record<string, number> = {
  'voyage-3-large': 0.18,
  'voyage-3': 0.06,
  'text-embedding-3-large': 0.13,
  'text-embedding-3-small': 0.02,
};

const DEFAULT_AI_RATE: ModelRate = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const DEFAULT_EMBED_RATE = 0.18;

export interface CostBreakdown {
  costUsd: number;
  /** False when the model id wasn't in the rate table (fell back to a default). */
  priced: boolean;
}

function rateFor(provider: AiProvider, model: string): { rate: ModelRate; priced: boolean } {
  const table = provider === 'anthropic' ? ANTHROPIC_RATES : GROQ_RATES;
  const rate = table[model];
  return rate ? { rate, priced: true } : { rate: DEFAULT_AI_RATE, priced: false };
}

/** Cost in USD of a single generation call. Cache tokens default to 0. */
export function aiCostUsd(provider: AiProvider, model: string, usage: TokenUsage): CostBreakdown {
  const { rate, priced } = rateFor(provider, model);
  const per = 1_000_000;
  const cacheRead = rate.cacheRead ?? rate.input * 0.1;
  const cacheWrite = rate.cacheWrite ?? rate.input * 1.25;
  const costUsd =
    (usage.inputTokens * rate.input +
      usage.outputTokens * rate.output +
      (usage.cacheReadTokens ?? 0) * cacheRead +
      (usage.cacheWriteTokens ?? 0) * cacheWrite) /
    per;
  return { costUsd, priced };
}

/** Cost in USD of an embeddings call (token count of the embedded text). */
export function embedCostUsd(model: string, tokens: number): CostBreakdown {
  const rate = EMBED_RATES[model];
  const priced = rate !== undefined;
  return { costUsd: (tokens * (rate ?? DEFAULT_EMBED_RATE)) / 1_000_000, priced };
}
