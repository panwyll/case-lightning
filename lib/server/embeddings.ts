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

export async function embed(text: string): Promise<EmbedResult | null> {
  const input = text.replace(/\s+/g, ' ').trim().slice(0, 8000);
  if (!input) return null;

  if (config.embeddingsProvider === 'openai') {
    if (!config.openAiApiKey) return null;
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openAiApiKey}`,
      },
      body: JSON.stringify({ model: config.openAiEmbeddingModel, input }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status}`);
    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
      usage?: { total_tokens?: number };
    };
    const vector = json.data[0]?.embedding;
    if (!vector) return null;
    return { vector, tokens: json.usage?.total_tokens ?? 0, provider: 'openai', model: config.openAiEmbeddingModel };
  }

  // Voyage (default)
  if (!config.voyageApiKey) return null;
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.voyageApiKey}`,
    },
    body: JSON.stringify({ model: config.voyageModel, input, input_type: 'document' }),
  });
  if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status}`);
  const json = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
    usage?: { total_tokens?: number };
  };
  const vector = json.data[0]?.embedding;
  if (!vector) return null;
  return { vector, tokens: json.usage?.total_tokens ?? 0, provider: 'voyage', model: config.voyageModel };
}

export function embeddingLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}
