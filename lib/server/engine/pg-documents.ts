/**
 * Postgres-backed document access for the engine: the `document` table (+ the two
 * columns migration 065 adds for pipeline #2's output), bytes from OneDrive / document_blob,
 * and engine-generated artefacts. Both backends build on this; it imports nothing from
 * the engine wiring so there is no import cycle.
 */
import crypto from 'node:crypto';
import { query, queryOne } from '../db';
import { downloadDriveItem } from '../graph';
import { driveUserFor } from '../matter-drive';
import type { DocumentRef, DocumentRepository } from './ports';
import type { EngineDocumentInput } from './llm';
import type { DraftCheck, RegisterFact } from './draft-check';
import { indexDocumentPages } from './file-index';
import { loadCaseRecord } from './crosscheck-run';
import type { DocumentBytesLoader, DocumentFactsWriter } from './extraction';
import { diffRegister, type DocumentReview, type PageTexts } from './review';
import { runCrossChecks } from './crosscheck-run';

interface DocRow {
  id: string;
  tenant_id: string;
  matter_id: string;
  doc_type: string | null;
  file_name: string | null;
  web_url: string | null;
  extracted_facts: unknown;
  extraction_confidence: number | string | null;
}

const toRef = (r: DocRow): DocumentRef => ({
  id: r.id,
  tenantId: r.tenant_id,
  matterId: r.matter_id,
  docType: r.doc_type,
  fileName: r.file_name,
  webUrl: r.web_url,
  extractedFacts: r.extracted_facts ?? null,
  extractionConfidence: r.extraction_confidence === null ? null : Number(r.extraction_confidence),
});

/** The existing `document` table, plus the two columns migration 065 adds for pipeline #2's output. */
export class PgDocumentRepository implements DocumentRepository {
  async get(tenantId: string, documentId: string): Promise<DocumentRef | null> {
    const row = await queryOne<DocRow>(
      `select id, tenant_id, matter_id, doc_type, file_name, web_url, extracted_facts, extraction_confidence
         from document where id = $1 and tenant_id = $2`,
      [documentId, tenantId]
    );
    return row ? toRef(row) : null;
  }

  async createGenerated(input: { tenantId: string; matterId: string; docType: string; fileName: string; content: string; createdBy?: string | null }): Promise<DocumentRef> {
    const hash = crypto.createHash('sha256').update(input.content).digest('hex');
    const row = await queryOne<DocRow>(
      `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, extracted_facts, extraction_confidence, created_by)
       values ($1,$2,'ENGINE',$3,$4,'text/plain',$5,$6,$7,$8::jsonb,1,$9)
       returning id, tenant_id, matter_id, doc_type, file_name, web_url, extracted_facts, extraction_confidence`,
      [input.tenantId, input.matterId, `engine://${input.matterId}/${input.fileName}`, input.fileName, Buffer.byteLength(input.content), hash, input.docType, JSON.stringify({ content: input.content }), input.createdBy ?? null]
    );
    return toRef(row as DocRow);
  }

  async loadRegister(tenantId: string, matterId: string): Promise<{ facts: RegisterFact[]; allowed: string[] }> {
    const rows = await query<{ id: string; document_id: string; key: string; value: string; page: number | null; quote: string | null; file_name: string | null; doc_type: string | null }>(
      `select f.id, f.document_id, f.key, f.value, f.page, f.quote, d.file_name, d.doc_type from document_fact f join document d on d.id = f.document_id where f.tenant_id = $1 and f.matter_id = $2 and d.superseded_at is null and f.disputed_note is null`,
      [tenantId, matterId]
    );
    const record = await loadCaseRecord(tenantId, matterId).catch(() => null);
    const allowed = record ? [record.propertyAddress ?? '', record.purchasePricePennies != null ? `£${(record.purchasePricePennies / 100).toFixed(2)}` : '', ...record.buyerNames, ...record.sellerNames, record.lender ?? ''] : [];
    return { facts: rows.map((r) => ({ id: r.id, documentId: r.document_id, documentLabel: r.file_name ?? r.doc_type ?? r.document_id.slice(0, 8), key: r.key, value: r.value, page: r.page, quote: r.quote })), allowed: allowed.filter(Boolean) };
  }

  async writeDraftCheck(tenantId: string, documentId: string, check: DraftCheck): Promise<void> {
    await query(`update document set draft_check = $3::jsonb where id = $1 and tenant_id = $2`, [documentId, tenantId, JSON.stringify(check)]);
  }
}

/** Test/dev helper: attach pipeline-#2-shaped facts to an existing document row. */
export async function setDocumentFacts(tenantId: string, documentId: string, facts: unknown, confidence: number): Promise<void> {
  await query(`update document set extracted_facts = $3::jsonb, extraction_confidence = $4 where id = $1 and tenant_id = $2`, [documentId, tenantId, JSON.stringify(facts), confidence]);
}

/**
 * Reads a document's bytes for the extractor. Engine-generated documents carry their
 * text inline; user files live in the matter's OneDrive folder (Graph, as the drive
 * owner); provider downloads that could not be uploaded to OneDrive sit in
 * document_blob (migration 066). Anything else is unreadable → the extractor fails →
 * the engine flags it for a human.
 */
export class PgDocumentBytesLoader implements DocumentBytesLoader {
  async load(doc: DocumentRef): Promise<EngineDocumentInput | null> {
    const inline = (doc.extractedFacts as { content?: string } | null)?.content;
    if (typeof inline === 'string' && inline.length) return { kind: 'text', data: inline, title: doc.fileName ?? undefined };
    const row = await queryOne<{ graph_item_id: string | null; mime_type: string | null; created_by: string | null; blob: Buffer | null }>(
      `select d.graph_item_id, d.mime_type, d.created_by, (select b.bytes from document_blob b where b.document_id = d.id) as blob
         from document d where d.id = $1 and d.tenant_id = $2`,
      [doc.id, doc.tenantId]
    ).catch(() => null);
    if (!row) return null;
    let bytes: Buffer | null = row.blob ?? null;
    if (!bytes && row.graph_item_id) {
      const owner = await driveUserFor(doc.tenantId, doc.matterId, row.created_by ?? '');
      if (!owner) return null;
      bytes = await downloadDriveItem(owner, row.graph_item_id);
    }
    if (!bytes) return null;
    const mime = row.mime_type ?? '';
    const name = doc.fileName ?? '';
    if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return { kind: 'pdf', data: bytes.toString('base64'), title: name || undefined };
    if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp)$/i.test(name)) return { kind: 'image', data: bytes.toString('base64'), mimeType: mime || 'image/jpeg', title: name || undefined };
    if (mime.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) return { kind: 'text', data: bytes.toString('utf8').slice(0, 200_000), title: name || undefined };
    return null; // .docx etc. — not read by the pipeline yet; the human handles it
  }
}

export class PgDocumentFactsWriter implements DocumentFactsWriter {
  async write(doc: DocumentRef, facts: unknown, confidence: number): Promise<void> {
    await query(`update document set extracted_facts = $3::jsonb, extraction_confidence = $4 where id = $1 and tenant_id = $2`, [doc.id, doc.tenantId, JSON.stringify(facts), confidence]);
  }
  /** Replace the ledger and this role's facts for the document (a re-read is a new projection, not an append), keep what changed since the last read, and index the pages. */
  async writeReview(doc: DocumentRef, review: DocumentReview, extractor: string, texts?: PageTexts): Promise<void> {
    const prev = await query<{ key: string; value: string; extractor: string | null; created_at: string }>(`select key, value, extractor, created_at from document_fact where document_id = $1 and tenant_id = $2 and role = $3`, [doc.id, doc.tenantId, review.role]);
    await query(`delete from document_page where document_id = $1 and tenant_id = $2`, [doc.id, doc.tenantId]);
    for (const pg of review.pages) await query(`insert into document_page (document_id, tenant_id, page, verdict, text_chars, ocr_confidence) values ($1, $2, $3, $4, $5, $6)`, [doc.id, doc.tenantId, pg.page, pg.verdict, pg.textChars, pg.ocr ?? null]);
    await query(`delete from document_fact where document_id = $1 and tenant_id = $2 and role = $3`, [doc.id, doc.tenantId, review.role]);
    for (const f of review.facts) await query(`insert into document_fact (document_id, tenant_id, matter_id, role, key, value, page, quote, confidence, verified, note, extractor) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [doc.id, doc.tenantId, doc.matterId, review.role, f.key, f.value, f.page, f.quote, f.confidence, f.verified, f.note, extractor]);
    if (prev.length) {
      const diff = diffRegister(prev, review.facts);
      await query(`update document set review_diff = $3::jsonb where id = $1 and tenant_id = $2`, [doc.id, doc.tenantId, JSON.stringify({ role: review.role, at: new Date().toISOString(), previousExtractor: prev[0].extractor, previousAt: prev[0].created_at, extractor, ...diff })]).catch(() => {});
    }
    if (texts) await indexDocumentPages(doc, texts).catch(() => {});
    await runCrossChecks(doc.tenantId, doc.matterId).catch(() => {});
  }
}

