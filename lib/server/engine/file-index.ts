/**
 * The file index (Document Review Engine, part 7): every page of every read document is
 * searchable per matter, so "where does the lease say X" is answered with the document,
 * the page and the passage, and the fact register is queryable by key.
 *
 * Pages go into kb_chunk as source_kind DOCUMENT_PAGE (metadata: page, fileName, docType),
 * with an embedding when a key is configured and full-text search otherwise. Facts are
 * read straight from document_fact. Indexing is best-effort: a failure never fails a read.
 */
import { query } from '../db';
import { embed, embeddingLiteral, embeddingsConfigured } from '../embeddings';
import { recordEmbedUsage } from '../usage';
import type { DocumentRef } from './ports';
import type { PageTexts } from './review';

const KIND = 'DOCUMENT_PAGE';
const CHUNK = 1800;

export interface Passage { documentId: string; fileName: string | null; docType: string | null; page: number; text: string }
export interface FactHit { id: string; documentId: string; fileName: string | null; key: string; value: string; page: number | null; quote: string | null; verified: boolean }

function chunks(text: string): string[] {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const out: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(clean.length, i + CHUNK);
    if (end < clean.length) { const cut = clean.lastIndexOf('\n', end); if (cut > i + CHUNK / 2) end = cut; }
    out.push(clean.slice(i, end).trim());
    i = end;
  }
  return out.filter(Boolean);
}

/** Replace the index rows for this document with its current page text. */
export async function indexDocumentPages(doc: DocumentRef, texts: PageTexts): Promise<number> {
  await query(`delete from kb_chunk where tenant_id = $1 and source_kind = $2 and source_id = $3`, [doc.tenantId, KIND, doc.id]);
  const useVectors = embeddingsConfigured();
  let n = 0;
  for (let p = 0; p < texts.pages.length; p++) {
    for (const [part, text] of chunks(texts.pages[p] ?? '').entries()) {
      let vector: string | null = null;
      if (useVectors) {
        const startedAt = Date.now();
        const r = await embed(text).catch(() => null);
        if (r) {
          vector = embeddingLiteral(r.vector);
          await recordEmbedUsage({ ctx: { tenantId: doc.tenantId, matterId: doc.matterId, feature: 'EMBED' }, provider: r.provider, model: r.model, tokens: r.tokens, latencyMs: Date.now() - startedAt, meta: { op: 'upsert', sourceKind: KIND } }).catch(() => {});
        }
      }
      await query(
        `insert into kb_chunk (tenant_id, matter_id, source_kind, source_id, chunk_text, metadata, embedding) values ($1, $2, $3, $4, $5, $6::jsonb, $7::vector)`,
        [doc.tenantId, doc.matterId, KIND, doc.id, text, JSON.stringify({ page: p + 1, part, fileName: doc.fileName, docType: doc.docType, ocr: texts.ocr?.[p] ?? null }), vector]
      );
      n++;
    }
  }
  return n;
}

/** Drop a document's pages from the index (superseded or deleted). */
export async function unindexDocuments(tenantId: string, documentIds: string[]): Promise<void> {
  if (!documentIds.length) return;
  await query(`delete from kb_chunk where tenant_id = $1 and source_kind = $2 and source_id = any($3::uuid[])`, [tenantId, KIND, documentIds]).catch(() => {});
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'does', 'what', 'where', 'when', 'which', 'say', 'says', 'about', 'from', 'have', 'has', 'are', 'was', 'were', 'any', 'there', 'into', 'than', 'then', 'their', 'they', 'them', 'our', 'your', 'lease', 'document', 'file']);
export const searchTerms = (q: string): string[] => [...new Set(q.toLowerCase().replace(/[^a-z0-9£%.' -]+/g, ' ').split(/\s+/).map((t) => t.replace(/^[.'-]+|[.'-]+$/g, '')).filter((t) => t.length >= 3 && !STOP.has(t)))];

/** A window of the passage around the first matching term, for the results list. */
export function snippet(text: string, terms: string[], width = 240): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return text.slice(0, width).trim() + (text.length > width ? '…' : '');
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

/** Where the file says something: the best passages, by meaning when embeddings are on and by words otherwise. */
export async function findPassages(tenantId: string, matterId: string, question: string, limit = 8): Promise<Passage[]> {
  type Row = { source_id: string; chunk_text: string; metadata: { page?: number; fileName?: string | null; docType?: string | null } };
  const terms = searchTerms(question);
  const shape = (rows: Row[]): Passage[] => rows.map((r) => ({ documentId: r.source_id, fileName: r.metadata.fileName ?? null, docType: r.metadata.docType ?? null, page: Number(r.metadata.page ?? 0), text: snippet(r.chunk_text, terms) }));
  const live = `and exists (select 1 from document d where d.id = k.source_id and d.superseded_at is null)`;
  if (embeddingsConfigured()) {
    const startedAt = Date.now();
    const e = await embed(question).catch(() => null);
    if (e) {
      await recordEmbedUsage({ ctx: { tenantId, matterId, feature: 'EMBED' }, provider: e.provider, model: e.model, tokens: e.tokens, latencyMs: Date.now() - startedAt, meta: { op: 'retrieve', sourceKind: KIND } }).catch(() => {});
      const rows = await query<Row>(
        `select source_id, chunk_text, metadata from kb_chunk k where tenant_id = $1 and matter_id = $2 and source_kind = $3 and embedding is not null ${live} order by embedding <=> $4::vector limit $5`,
        [tenantId, matterId, KIND, embeddingLiteral(e.vector), limit]
      );
      if (rows.length) return shape(rows);
    }
  }
  if (!terms.length) return [];
  const rows = await query<Row>(
    `select source_id, chunk_text, metadata from kb_chunk k where tenant_id = $1 and matter_id = $2 and source_kind = $3 ${live} and to_tsvector('english', chunk_text) @@ plainto_tsquery('english', $4)
     order by ts_rank(to_tsvector('english', chunk_text), plainto_tsquery('english', $4)) desc limit $5`,
    [tenantId, matterId, KIND, terms.join(' '), limit]
  );
  if (rows.length) return shape(rows);
  // Last resort: any page holding every term as a plain substring.
  const like = await query<Row>(
    `select source_id, chunk_text, metadata from kb_chunk k where tenant_id = $1 and matter_id = $2 and source_kind = $3 ${live} and ${terms.map((_, i) => `chunk_text ilike $${i + 4}`).join(' and ')} limit $${terms.length + 4}`,
    [tenantId, matterId, KIND, ...terms.map((t) => `%${t}%`), limit]
  );
  return shape(like);
}

/** Facts on the register whose key or value carries any of the question's words; a `key` pattern (e.g. "offer." or "title.proprietor") narrows by key. */
export async function findFacts(tenantId: string, matterId: string, opts: { question?: string; key?: string; limit?: number }): Promise<FactHit[]> {
  const terms = opts.question ? searchTerms(opts.question) : [];
  if (!terms.length && !opts.key) return [];
  const params: unknown[] = [tenantId, matterId];
  const where: string[] = [];
  if (opts.key) { params.push(`${opts.key.replace(/[%_]/g, '\\$&')}%`); where.push(`f.key like $${params.length}`); }
  if (terms.length) {
    const ors = terms.map((t) => { params.push(`%${t}%`); return `(f.key ilike $${params.length} or f.value ilike $${params.length})`; });
    where.push(`(${ors.join(' or ')})`);
  }
  params.push(opts.limit ?? 20);
  const rows = await query<{ id: string; document_id: string; file_name: string | null; key: string; value: string; page: number | null; quote: string | null; verified: boolean }>(
    `select f.id, f.document_id, d.file_name, f.key, f.value, f.page, f.quote, f.verified from document_fact f join document d on d.id = f.document_id
     where f.tenant_id = $1 and f.matter_id = $2 and d.superseded_at is null and ${where.join(' and ')} order by f.key limit $${params.length}`,
    params
  );
  return rows.map((r) => ({ id: r.id, documentId: r.document_id, fileName: r.file_name, key: r.key, value: r.value, page: r.page, quote: r.quote, verified: r.verified }));
}

/** One question against the file: the facts that answer it and the passages that show it. */
export async function askFile(tenantId: string, matterId: string, question: string): Promise<{ facts: FactHit[]; passages: Passage[] }> {
  const [facts, passages] = await Promise.all([findFacts(tenantId, matterId, { question, limit: 12 }).catch(() => []), findPassages(tenantId, matterId, question).catch(() => [])]);
  return { facts, passages };
}
