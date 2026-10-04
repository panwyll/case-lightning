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

/** A page's text from its chunks in order, the overlap between neighbours taken out once. */
export function joinChunks(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    if (!out) { out = part; continue; }
    // The longest end of what we have that the next chunk starts with (chunks overlap by up to ~250 characters).
    let cut = 0;
    for (let n = Math.min(400, out.length, part.length); n >= 20; n--) if (out.endsWith(part.slice(0, n))) { cut = n; break; }
    out += (cut ? '' : '\n') + part.slice(cut);
  }
  return out;
}

/**
 * The pages a long scan's OCR budget did not reach (no text, no OCR result), read now: one document per
 * call, within `budgetMs`. The rest of its pages come back from the index, the new pages are OCR'd, its
 * quotes are checked again and its pages indexed again. Pages that still fail are marked tried (0%), so
 * they are not tried for ever.
 */
export async function ocrCatchUp(
  tenantId: string,
  matterId: string | null,
  deps: { get: (id: string) => Promise<DocumentRef | null>; load: (doc: DocumentRef) => Promise<{ kind: 'pdf' | 'image' | 'text'; data: string } | null>; writeReview: (doc: DocumentRef, review: ReturnType<typeof buildReview>, extractor: string, texts?: Awaited<ReturnType<typeof pageTextsWithOcr>>) => Promise<void> },
  budgetMs = 45_000
): Promise<{ documentId: string; pages: number } | null> {
  if (ocrRunning) return null; // one at a time per process: the list's refreshes must not start the same OCR twice
  ocrRunning = true;
  try { return await ocrCatchUpOnce(tenantId, matterId, deps, budgetMs); } finally { ocrRunning = false; }
}
let ocrRunning = false;

async function ocrCatchUpOnce(
  tenantId: string,
  matterId: string | null,
  deps: Parameters<typeof ocrCatchUp>[2],
  budgetMs: number
): Promise<{ documentId: string; pages: number } | null> {
  const pending = await query<{ document_id: string; pages: number[] }>(
    `select p.document_id, array_agg(p.page order by p.page) as pages
       from document_page p join document d on d.id = p.document_id
      where p.tenant_id = $1 and ($2::uuid is null or d.matter_id = $2) and d.superseded_at is null
        and p.text_chars <= 20 and p.ocr_confidence is null
        and (coalesce(d.mime_type, '') = 'application/pdf' or d.file_name ilike '%.pdf')
      group by p.document_id order by min(d.created_at) desc limit 1`,
    [tenantId, matterId]
  ).catch(() => []);
  const job = pending[0];
  if (!job) return null;
  const doc = await deps.get(job.document_id).catch(() => null);
  const stored = doc?.extractedFacts as { _pipeline?: { role?: string }; facts?: unknown } | null;
  const input = doc ? await deps.load(doc).catch(() => null) : null;
  const markTried = () => query(`update document_page set ocr_confidence = 0 where document_id = $1 and tenant_id = $2 and page = any($3::int[]) and ocr_confidence is null`, [job.document_id, tenantId, job.pages]).catch(() => {});
  if (!doc || !input || input.kind !== 'pdf' || !stored?._pipeline?.role || stored.facts == null) { await markTried(); return null; }
  // What the document already holds: its ledger and its pages' text (from the index).
  const [ledgerRows, chunkRows] = await Promise.all([
    query<{ page: number; verdict: string; ocr_confidence: number | null }>(`select page, verdict, ocr_confidence from document_page where document_id = $1 and tenant_id = $2 order by page`, [doc.id, tenantId]),
    query<{ chunk_text: string; page: number; part: number }>(`select chunk_text, (metadata->>'page')::int as page, coalesce((metadata->>'part')::int, 0) as part from kb_chunk where tenant_id = $1 and source_kind = 'DOCUMENT_PAGE' and source_id = $2 order by 2, 3`, [tenantId, doc.id]),
  ]);
  const count = ledgerRows.length;
  const byPage = new Map<number, string[]>();
  for (const c of chunkRows) byPage.set(c.page, [...(byPage.get(c.page) ?? []), c.chunk_text]);
  const pages = Array.from({ length: count }, (_, i) => joinChunks(byPage.get(i + 1) ?? []));
  const ocr: Array<number | null> = ledgerRows.map((r) => r.ocr_confidence);
  const { ocrPdfPages } = await import('./ocr');
  const read = await ocrPdfPages(Buffer.from(input.data, 'base64'), job.pages, { budgetMs }).catch(() => new Map());
  for (const [p, r] of read) { pages[p - 1] = r.text; ocr[p - 1] = r.confidence; }
  if (!read.size) { await markTried(); return null; }
  const texts = { pages, textLayer: pages.some((s) => s.replace(/\s+/g, '').length > 20), ocr };
  const ledger = ledgerRows.filter((r) => r.verdict !== 'unattested').map((r) => ({ page: r.page, verdict: r.verdict as 'facts' | 'nothing' | 'unreadable' }));
  await deps.writeReview(doc, buildReview({ role: stored._pipeline.role, facts: stored.facts, ledger, texts }), 'ocr-catch-up', texts);
  return { documentId: doc.id, pages: read.size };
}
