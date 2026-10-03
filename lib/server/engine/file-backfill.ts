/**
 * Bringing a case's file index up to date before it is searched: documents filed before every page was
 * indexed (or before a kind's facts went on the register) are caught up the first time someone asks.
 *
 *   - facts: a document read as a kind whose facts the register did not hold (property forms, supporting
 *     documents, title plans, surveys, statements) is registered from the reading already stored: no
 *     model call, the same facts the engine acts on;
 *   - pages: a document with no pages in the index is indexed as it stands (OCR where it has no text).
 *
 * Bounded per call, so the first question on a large file is not held up for long; the rest follow.
 */
import { query } from '../db';
import { indexDocumentPages, indexIfUnindexed, UNSEARCHED } from './file-index';
import { buildReview, pageTextsWithOcr } from './review';
import type { DocumentRef } from './ports';

const REGISTERED_LATER = ['property_forms', 'supporting_document', 'title_plan', 'survey', 'statement'];

export async function catchUpFileIndex(
  tenantId: string,
  matterId: string,
  deps: { get: (id: string) => Promise<DocumentRef | null>; load: (doc: DocumentRef) => Promise<{ kind: 'pdf' | 'image' | 'text'; data: string } | null>; writeReview: (doc: DocumentRef, review: ReturnType<typeof buildReview>, extractor: string, texts?: Awaited<ReturnType<typeof pageTextsWithOcr>>) => Promise<void> },
  limit = 8
): Promise<{ registered: number; indexed: number }> {
  let registered = 0, indexed = 0;
  // A reading on file whose facts never reached the register.
  const unregistered = await query<{ id: string }>(
    `select d.id from document d
      where d.tenant_id = $1 and d.matter_id = $2 and d.superseded_at is null
        and split_part(d.extracted_facts->'_pipeline'->>'role', ':', 1) = any($3::text[])
        and not exists (select 1 from document_fact f where f.document_id = d.id)
      order by d.created_at desc limit $4`,
    [tenantId, matterId, REGISTERED_LATER, limit]
  ).catch(() => []);
  for (const { id } of unregistered) {
    const doc = await deps.get(id).catch(() => null);
    const stored = doc?.extractedFacts as { _pipeline?: { role?: string; model?: string }; facts?: unknown } | null;
    if (!doc || !stored?._pipeline?.role || stored.facts == null) continue;
    try {
      const input = await deps.load(doc);
      const texts = input ? await pageTextsWithOcr(input) : { pages: [], textLayer: false };
      await deps.writeReview(doc, buildReview({ role: stored._pipeline.role, facts: stored.facts, ledger: null, texts }), `backfill:${stored._pipeline.model ?? 'stored'}`, texts);
      registered++;
    } catch { /* the next ask tries again */ }
  }
  // Pages never indexed.
  const unindexed = await query<{ id: string }>(
    `select d.id from document d
      where d.tenant_id = $1 and d.matter_id = $2 and d.superseded_at is null and coalesce(d.doc_type, '') <> all($3::text[])
        and coalesce((d.extracted_facts->>'locked')::boolean, false) = false
        and not exists (select 1 from kb_chunk k where k.source_kind = 'DOCUMENT_PAGE' and k.source_id = d.id)
      order by d.created_at desc limit $4`,
    [tenantId, matterId, [...UNSEARCHED, 'FILE_NOTE'], limit]
  ).catch(() => []);
  for (const { id } of unindexed) {
    const doc = await deps.get(id).catch(() => null);
    if (!doc) continue;
    indexed += await indexIfUnindexed(doc, () => deps.load(doc)).catch(() => 0);
  }
  return { registered, indexed };
}

export { indexDocumentPages };
