/**
 * Pluggable embeddings provider for RAG. Default is Voyage AI (Anthropic's
 * recommended embeddings partner); OpenAI is a drop-in alternative. Returns null
 * when no key is configured so retrieval can degrade gracefully to non-vector
 * context (matter facts + templates + recent thread) without breaking drafting.
 */
import { config } from './config';

export function embeddingsConfigured(): boolean {
  return config.embeddingsProvider === 'openai'
    ? Boolean(config.openAiApiKey)
    : Boolean(config.voyageApiKey);
}

export interface EmbedResult {
  vector: number[];
  /** Provider-reported token count (for usage metering); 0 if not reported. */
  tokens: number;
  provider: 'voyage' | 'openai';
  model: string;
}

/** What is being embedded: a passage to be found, or a question looking for one (Voyage embeds them differently). */
export type EmbedInputType = 'document' | 'query';

export async function embed(text: string, inputType: EmbedInputType = 'document'): Promise<EmbedResult | null> {
  const r = await embedMany([text], inputType);
  return r?.[0] ?? null;
}

/**
 * Several texts in one call (a document's chunks): one request per batch, not one per chunk.
 * Null when no provider is configured; the tokens are reported on the first result.
 */
export async function embedMany(texts: string[], inputType: EmbedInputType = 'document'): Promise<Array<EmbedResult | null> | null> {
  const inputs = texts.map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 8000));
  const live = inputs.map((s, i) => [s, i] as const).filter(([s]) => s);
  if (!live.length) return inputs.map(() => null);
  const out: Array<EmbedResult | null> = inputs.map(() => null);
  const BATCH = 64;
  for (let b = 0; b < live.length; b += BATCH) {
    const slice = live.slice(b, b + BATCH);
    const got = await embedBatch(slice.map(([s]) => s), inputType);
    if (!got) return null;
    slice.forEach(([, i], j) => { out[i] = got.vectors[j] ? { vector: got.vectors[j], tokens: j === 0 ? got.tokens : 0, provider: got.provider, model: got.model } : null; });
  }
  return out;
}

async function embedBatch(input: string[], inputType: EmbedInputType): Promise<{ vectors: number[][]; tokens: number; provider: 'voyage' | 'openai'; model: string } | null> {
  if (config.embeddingsProvider === 'openai') {
    if (!config.openAiApiKey) return null;
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
      // The column is vector(EMBEDDING_DIM): ask for that many dimensions (text-embedding-3 can shorten).
      body: JSON.stringify({ model: config.openAiEmbeddingModel, input, dimensions: config.embeddingDim }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status}`);
    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }>; usage?: { total_tokens?: number } };
    const vectors: number[][] = [];
    for (const d of json.data) vectors[d.index] = d.embedding;
    return { vectors, tokens: json.usage?.total_tokens ?? 0, provider: 'openai', model: config.openAiEmbeddingModel };
  }
  // Voyage (default)
  if (!config.voyageApiKey) return null;
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.voyageApiKey}` },
    body: JSON.stringify({ model: config.voyageModel, input, input_type: inputType }),
  });
  if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status}`);
  const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }>; usage?: { total_tokens?: number } };
  const vectors: number[][] = [];
  for (const d of json.data) vectors[d.index ?? vectors.length] = d.embedding;
  return { vectors, tokens: json.usage?.total_tokens ?? 0, provider: 'voyage', model: config.voyageModel };
}

export function embeddingLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}
