/**
 * Production wiring for the engine: Postgres for the log and for documents, MOCKS for
 * everything that is not built yet. This file is the one place that says which
 * component is real. As #2–#5 land, swap the mock here and nothing else changes.
 *
 *   documents      → PgDocumentRepository        (real: the existing `document` table)
 *   event log      → PgEventStore                (real: migration 065)
 *   extractor      → FixtureExtractor            (STUB #2 — reads document.extracted_facts)
 *   summariser     → TemplateSummariser          (STUB #3 — deterministic prose)
 *   reportDrafter  → TemplateReportDrafter       (STUB #3)
 *   searchProvider → MockSearchProvider          (STUB #4 — InfoTrack)
 *   idCheckProvider→ MockIdCheckProvider         (STUB #4 — AML/ID)
 *   clientComms    → MockClientComms             (STUB #5 — WhatsApp/email status updates)
 *   chaser         → MockChaser                  (STUB #5 — template chase emails)
 */
import crypto from 'node:crypto';
import { query, queryOne } from '../db';
import { FixtureExtractor, MockChaser, MockClientComms, MockIdCheckProvider, MockSearchProvider, TemplateReportDrafter, TemplateSummariser } from './mocks';
import type { DocumentRef, DocumentRepository, EnginePorts } from './ports';
import { EngineService } from './service';
import { PgEventStore } from './store';

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
}

/** Test/dev helper: attach pipeline-#2-shaped facts to an existing document row. */
export async function setDocumentFacts(tenantId: string, documentId: string, facts: unknown, confidence: number): Promise<void> {
  await query(`update document set extracted_facts = $3::jsonb, extraction_confidence = $4 where id = $1 and tenant_id = $2`, [documentId, tenantId, JSON.stringify(facts), confidence]);
}

let _ports: EnginePorts | null = null;
let _service: EngineService | null = null;

export function productionPorts(): EnginePorts {
  if (!_ports) {
    _ports = {
      documents: new PgDocumentRepository(),
      extractor: new FixtureExtractor(),
      summariser: new TemplateSummariser(),
      reportDrafter: new TemplateReportDrafter(),
      searchProvider: new MockSearchProvider(),
      idCheckProvider: new MockIdCheckProvider(),
      clientComms: new MockClientComms(),
      chaser: new MockChaser(),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      log: (msg, detail) => console.warn(`[engine] ${msg}`, detail instanceof Error ? detail.message : detail ?? ''),
    };
  }
  return _ports;
}

/** The singleton service the API routes and cron use. */
export function engine(): EngineService {
  if (!_service) _service = new EngineService(new PgEventStore(), productionPorts());
  return _service;
}
