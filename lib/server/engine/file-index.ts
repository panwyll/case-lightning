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
import { embedMany, embed, embeddingLiteral, embeddingsConfigured } from '../embeddings';
import { recordEmbedUsage } from '../usage';
import type { DocumentRef } from './ports';
import type { PageTexts } from './review';

const KIND = 'DOCUMENT_PAGE';
const CHUNK = 1800;
/** Carried from the end of one chunk to the start of the next, so a clause cut in two is whole in one of them. */
const OVERLAP = 250;

export interface Passage { documentId: string; fileName: string | null; docType: string | null; page: number; text: string; /** the whole chunk, for reading and answering */ full?: string }
export interface FactHit { id: string; documentId: string; fileName: string | null; key: string; value: string; page: number | null; quote: string | null; verified: boolean }

/** Where to cut near `at`: a paragraph, else a line, else a sentence end, else a space; never mid-word. */
function cutNear(text: string, from: number, at: number): number {
  const window = text.slice(from, at);
  for (const re of [/\n\n(?![\s\S]*\n\n)/, /\n(?![\s\S]*\n)/, /[.;:]\s(?![\s\S]*[.;:]\s)/, /\s(?![\s\S]*\s)/]) {
    const m = re.exec(window);
    if (m && m.index > (at - from) / 2) return from + m.index + m[0].length;
  }
  return at;
}

/** A page's text in chunks of about CHUNK characters, cut at natural breaks, each overlapping the last by OVERLAP. */
export function chunks(text: string): string[] {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= CHUNK) return [clean];
  const out: string[] = [];
  let i = 0;
  while (i < clean.length) {
    const end = i + CHUNK >= clean.length ? clean.length : cutNear(clean, i, i + CHUNK);
    out.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    // The next chunk starts OVERLAP back, at a word boundary.
    let next = Math.max(i + 1, end - OVERLAP);
    const sp = clean.indexOf(' ', next);
    if (sp > 0 && sp < end) next = sp + 1;
    i = next;
  }
  return out.filter(Boolean);
}

const ROLE_LABEL: Record<string, string> = {
  title: 'register of title', title_plan: 'title plan', contract: 'draft contract', lease: 'lease', mortgage: 'mortgage offer', search: 'search result', enquiry: 'replies to enquiries',
  survey: 'survey report', statement: 'bank statement', management_pack: 'management pack (LPE1)', property_forms: 'property information forms (TA6 / TA7 / TA10)',
  supporting_document: 'supporting document', id_check: 'ID / AML check',
};
/** What a document is, in words, from what the engine read it as (or the file type it was given). */
export function documentLabel(doc: Pick<DocumentRef, 'docType' | 'extractedFacts'>): string | null {
  const role = ((doc.extractedFacts as { _pipeline?: { role?: string } } | null)?._pipeline?.role ?? '').split(':')[0];
  if (role && ROLE_LABEL[role]) return ROLE_LABEL[role];
  const t = (doc.docType ?? '').toUpperCase();
  return t === 'EMAIL' ? 'email' : t && t !== 'EMAIL_ATTACHMENT' ? t.toLowerCase().replace(/_/g, ' ') : null;
}

/**
 * The line put before a chunk when it is embedded (contextual retrieval): which document, what it is,
 * which page. A passage that says "the Tenant shall repair" is found for "who repairs under the lease"
 * because its context says it is the lease.
 */
export function contextLine(doc: Pick<DocumentRef, 'fileName' | 'docType' | 'extractedFacts'>, page: number, pages: number): string {
  const what = documentLabel(doc);
  return `${doc.fileName ?? 'Document'}${what ? ` (${what})` : ''}, page ${page} of ${pages}.`;
}

/** Replace the index rows for this document with its current page text: every chunk embedded with its context, in one batch. */
export async function indexDocumentPages(doc: DocumentRef, texts: PageTexts): Promise<number> {
  await query(`delete from kb_chunk where tenant_id = $1 and source_kind = $2 and source_id = $3`, [doc.tenantId, KIND, doc.id]);
  const rows: Array<{ page: number; part: number; text: string; context: string }> = [];
  for (let p = 0; p < texts.pages.length; p++) for (const [part, text] of chunks(texts.pages[p] ?? '').entries()) rows.push({ page: p + 1, part, text, context: contextLine(doc, p + 1, texts.pages.length) });
  if (!rows.length) return 0;
  let vectors: Array<string | null> = rows.map(() => null);
  if (embeddingsConfigured()) {
    const startedAt = Date.now();
    const got = await embedMany(rows.map((r) => `${r.context}\n${r.text}`), 'document').catch(() => null);
    if (got) {
      vectors = got.map((g) => (g ? embeddingLiteral(g.vector) : null));
      const tokens = got.reduce((n, g) => n + (g?.tokens ?? 0), 0);
      const first = got.find(Boolean);
      if (first) await recordEmbedUsage({ ctx: { tenantId: doc.tenantId, matterId: doc.matterId, feature: 'EMBED' }, provider: first.provider, model: first.model, tokens, latencyMs: Date.now() - startedAt, meta: { op: 'upsert', sourceKind: KIND, chunks: rows.length } }).catch(() => {});
    }
  }
  const role = ((doc.extractedFacts as { _pipeline?: { role?: string } } | null)?._pipeline?.role ?? null);
  // One insert for the lot.
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    values.push(doc.tenantId, doc.matterId, KIND, doc.id, r.text, JSON.stringify({ page: r.page, part: r.part, fileName: doc.fileName, docType: doc.docType, role, context: r.context, ocr: texts.ocr?.[r.page - 1] ?? null }), vectors[i]);
    const b = i * 7;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb, $${b + 7}::vector)`;
  });
  for (let i = 0; i < tuples.length; i += 200) {
    const part = tuples.slice(i, i + 200);
    const vals = values.slice(i * 7, (i + part.length) * 7);
    await query(`insert into kb_chunk (tenant_id, matter_id, source_kind, source_id, chunk_text, metadata, embedding) values ${part.map((tp, j) => tp.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) - i * 7}`)).join(', ')}`, vals);
  }
  return rows.length;
}

/** Never searched: bank details (verified out of band, not quoted back), our own proposals and dossiers, sandbox mail. */
export const UNSEARCHED: ReadonlySet<string> = new Set(['BANK_DETAILS_NOTE', 'PROPOSAL', 'ESCALATION_DOSSIER', 'DEADLINE_DOSSIER', 'SANDBOX_EMAIL']);

/**
 * A document the engine did not read (not recognised, below the confidence to route, a case not yet
 * enrolled, a letter or an email): its pages still go in the index, so Ask The File and the drafter
 * find them. Only when it has no pages indexed yet; a later read replaces them.
 */
export async function indexIfUnindexed(doc: DocumentRef, load: () => Promise<{ kind: 'pdf' | 'image' | 'text'; data: string } | null>): Promise<number> {
  if (UNSEARCHED.has((doc.docType ?? '').toUpperCase())) return 0;
  const has = await query<{ n: number }>(`select 1 as n from kb_chunk where tenant_id = $1 and source_kind = $2 and source_id = $3 limit 1`, [doc.tenantId, KIND, doc.id]);
  if (has.length) return 0;
  const input = await load();
  if (!input) return 0;
  const { pageTextsWithOcr } = await import('./review');
  return indexDocumentPages(doc, await pageTextsWithOcr(input));
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

type Row = { id: string; source_id: string; chunk_text: string; metadata: { page?: number; fileName?: string | null; docType?: string | null } };

/**
 * Reciprocal rank fusion: each list votes 1/(k + rank) for what it found. A passage both the words and
 * the meaning found rises; one only the meaning found still counts (k = 60, the usual constant).
 */
export function fuse<T extends { id: string }>(lists: T[][], k = 60): T[] {
  const score = new Map<string, number>();
  const item = new Map<string, T>();
  for (const list of lists) list.forEach((x, rank) => { score.set(x.id, (score.get(x.id) ?? 0) + 1 / (k + rank + 1)); if (!item.has(x.id)) item.set(x.id, x); });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => item.get(id)!);
}

/** The words of a question as an any-of full-text query, each a prefix ("repair" finds "repairs", "repairing"). */
export const anyOf = (terms: string[]): string => terms.map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 3).map((t) => `${t}:*`).join(' | ');

/**
 * Where the file says something, by hybrid search: the words (full-text, any of them, ranked by how
 * closely they sit together) and the meaning (embeddings, when a provider is set), fused. `rerank`
 * then puts the candidates in order of relevance to the question and drops the ones that do not help.
 */
export async function findPassages(tenantId: string, matterId: string, question: string, limit = 8, opts: { rerank?: (question: string, candidates: Passage[]) => Promise<Passage[]> } = {}): Promise<Passage[]> {
  const terms = searchTerms(question);
  const pool = Math.max(limit * 3, 24);
  const live = `and exists (select 1 from document d where d.id = k.source_id and d.superseded_at is null)`;
  const byWords = async (): Promise<Row[]> => {
    const tsq = anyOf(terms);
    if (!tsq) return [];
    return query<Row>(
      // The kind written out, not a parameter: the full-text index is partial on it (migration 094) and a parameter hides that from the planner.
      `select id, source_id, chunk_text, metadata from kb_chunk k where tenant_id = $1 and matter_id = $2 and source_kind = 'DOCUMENT_PAGE' ${live} and to_tsvector('english', chunk_text) @@ to_tsquery('english', $3)
       order by ts_rank_cd(to_tsvector('english', chunk_text), to_tsquery('english', $3), 32) desc limit $4`,
      [tenantId, matterId, tsq, pool]
    ).catch(() => []);
  };
  const byMeaning = async (): Promise<Row[]> => {
    if (!embeddingsConfigured()) return [];
    const startedAt = Date.now();
    const e = await embed(question, 'query').catch(() => null);
    if (!e) return [];
    await recordEmbedUsage({ ctx: { tenantId, matterId, feature: 'EMBED' }, provider: e.provider, model: e.model, tokens: e.tokens, latencyMs: Date.now() - startedAt, meta: { op: 'retrieve', sourceKind: KIND } }).catch(() => {});
    return query<Row>(
      `select id, source_id, chunk_text, metadata from kb_chunk k where tenant_id = $1 and matter_id = $2 and source_kind = $3 and embedding is not null ${live} order by embedding <=> $4::vector limit $5`,
      [tenantId, matterId, KIND, embeddingLiteral(e.vector), pool]
    ).catch(() => []);
  };
  const [words, meaning] = await Promise.all([byWords(), byMeaning()]);
  let rows = fuse([words, meaning]);
  // Nothing either way: any page holding every word as written (a reference, a postcode the stemmer mangles).
  if (!rows.length && terms.length) {
    rows = await query<Row>(
      `select id, source_id, chunk_text, metadata from kb_chunk k where tenant_id = $1 and matter_id = $2 and source_kind = $3 ${live} and ${terms.map((_, i) => `chunk_text ilike $${i + 4}`).join(' and ')} limit $${terms.length + 4}`,
      [tenantId, matterId, KIND, ...terms.map((t) => `%${t}%`), pool]
    ).catch(() => []);
  }
  const candidates: Passage[] = rows.slice(0, pool).map((r) => ({ documentId: r.source_id, fileName: r.metadata.fileName ?? null, docType: r.metadata.docType ?? null, page: Number(r.metadata.page ?? 0), text: snippet(r.chunk_text, terms), full: r.chunk_text }));
  if (opts.rerank && candidates.length > 1) {
    const ranked = await opts.rerank(question, candidates).catch(() => null);
    if (ranked) return ranked.slice(0, limit);
  }
  return candidates.slice(0, limit);
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
     where f.tenant_id = $1 and f.matter_id = $2 and d.superseded_at is null and ${where.join(' and ')}
     order by ${terms.length ? `(${terms.map((_, i) => `(case when f.key ilike $${i + 3 + (opts.key ? 1 : 0)} or f.value ilike $${i + 3 + (opts.key ? 1 : 0)} then 1 else 0 end)`).join(' + ')}) desc, ` : ''}f.verified desc, f.key limit $${params.length}`,
    params
  );
  return rows.map((r) => ({ id: r.id, documentId: r.document_id, fileName: r.file_name, key: r.key, value: r.value, page: r.page, quote: r.quote, verified: r.verified }));
}
