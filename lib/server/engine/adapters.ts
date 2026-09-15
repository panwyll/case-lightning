/**
 * Production wiring for the engine: Postgres for the log and for documents, MOCKS for
 * everything that is not built yet. This file is the one place that says which
 * component is real. As #2–#5 land, swap the mock here and nothing else changes.
 *
 *   documents      → PgDocumentRepository        (real: the existing `document` table)
 *   event log      → PgEventStore                (real: migration 065)
 *   extractor      → ClaudeExtractor when ANTHROPIC_API_KEY is set (component #2, extraction.ts);
 *                    FixtureExtractor otherwise (reads document.extracted_facts)
 *   summariser     → ClaudeSummariser when a key is set (component #3, ai.ts); validated,
 *                    falls back to the deterministic template prose
 *   reportDrafter  → ClaudeReportDrafter when a key is set (component #3); TemplateReportDrafter otherwise
 *   searchProvider → InfoTrackSearchProvider when INFOTRACK_* is set (component #4); mock otherwise
 *   idCheckProvider→ InfoTrackIdCheckProvider when INFOTRACK_* is set (component #4); mock otherwise
 *   clientComms    → ProductionClientComms when WhatsApp/Resend/Graph is configured (component #5); mock otherwise
 *   chaser         → ProductionChaser (draft-by-default template chases from the fee-earner mailbox); mock otherwise
 */
import crypto from 'node:crypto';
import { query, queryOne } from '../db';
import { config } from '../config';
import { downloadDriveItem } from '../graph';
import { driveUserFor } from '../matter-drive';
import { FixtureExtractor, MockChaser, MockClientComms, MockIdCheckProvider, MockSearchProvider, TemplateReportDrafter, TemplateSummariser } from './mocks';
import type { DocumentClassification, DocumentClassifier, DocumentRef, DocumentRepository, EnginePorts } from './ports';
import { EngineService } from './service';
import { PgEventStore } from './store';
import { claudeLlm, type EngineDocumentInput } from './llm';
import { ClaudeExtractor, type DocumentBytesLoader, type DocumentFactsWriter } from './extraction';
import { ClaudeSummariser, ClaudeReportDrafter } from './ai';
import { infotrackConfigured, infotrackProviders } from '../integrations/infotrack-adapters';
import { chaser as productionChaser, clientComms as productionClientComms, commsConfigured } from '../comms/adapters';
import { runAsSystem } from '../db';
import { createTask } from '../tasks';
import { emitMatterEvent } from '../events';
import { resolveCounterparty } from './counterparty';
import type { LinkedMatterNotifier } from './ports';

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
}

/** Adapts the extractor's classify() to the DocumentClassifier port. */
class ClaudeClassifier implements DocumentClassifier {
  readonly name: string;
  constructor(private extractor: ClaudeExtractor) {
    this.name = `claude-classifier:${extractor.name}`;
  }
  async classify(doc: DocumentRef): Promise<DocumentClassification> {
    const c = await this.extractor.classify(doc);
    return {
      role: c.role,
      searchType: c.searchType === 'NONE' ? null : c.searchType,
      enquiryReferences: c.enquiryReferences,
      titleNumber: c.titleNumber || null,
      lender: c.lender || null,
      confidence: c.scanQuality === 'unreadable' ? 0 : c.confidence,
      reason: c.reason,
    };
  }
}

/** Real pipeline when a Claude key is present (or forced), otherwise the fixture stub. */
function chooseExtractor(): { extractor: EnginePorts['extractor']; classifier: DocumentClassifier | null } {
  const useClaude = config.engineExtractor === 'claude' || (config.engineExtractor === 'auto' && !!config.anthropicApiKey);
  if (!useClaude) return { extractor: new FixtureExtractor(), classifier: null };
  const ex = new ClaudeExtractor(claudeLlm(), new PgDocumentBytesLoader(), new PgDocumentFactsWriter(), { model: config.engineExtractModel, effort: 'high' });
  return { extractor: ex, classifier: new ClaudeClassifier(ex) };
}

/** Real AI layer (#3) when a Claude key is present (or forced), otherwise the deterministic templates. */
function chooseAi(log: (msg: string, detail?: unknown) => void): { summariser: EnginePorts['summariser']; reportDrafter: EnginePorts['reportDrafter'] } {
  const useClaude = config.engineAi === 'claude' || (config.engineAi === 'auto' && !!config.anthropicApiKey);
  if (!useClaude) return { summariser: new TemplateSummariser(), reportDrafter: new TemplateReportDrafter() };
  const llm = claudeLlm();
  return {
    summariser: new ClaudeSummariser(llm, new PgDocumentBytesLoader(), { model: config.engineDraftModel, effort: 'high', log }),
    reportDrafter: new ClaudeReportDrafter(llm, { model: config.engineDraftModel, effort: 'high', log }),
  };
}

/** Real InfoTrack providers (#4) when credentials are present; mocks otherwise. */
function chooseIntegrations(): { searchProvider: EnginePorts['searchProvider']; idCheckProvider: EnginePorts['idCheckProvider'] } {
  if (!infotrackConfigured()) return { searchProvider: new MockSearchProvider(), idCheckProvider: new MockIdCheckProvider() };
  const p = infotrackProviders();
  return { searchProvider: p.searchProvider, idCheckProvider: p.idCheckProvider };
}

/** Real client comms + chaser (#5) when any channel is configured (WhatsApp, Resend or Graph); mocks otherwise. */
function chooseComms(): { clientComms: EnginePorts['clientComms']; chaser: EnginePorts['chaser'] } {
  if (!commsConfigured()) return { clientComms: new MockClientComms(), chaser: new MockChaser() };
  return { clientComms: productionClientComms(), chaser: productionChaser() };
}

/** Delivers an enquiry to the linked matter's handler as inbound correspondence (a task + notification on THEIR matter). */
class PgLinkedMatterNotifier implements LinkedMatterNotifier {
  readonly name = 'linked-matter-notifier';
  async enquiryRaised(input: { tenantId: string; fromMatterId: string; enquiryId: string; subject: string }): Promise<void> {
    const cp = await resolveCounterparty(input.tenantId, input.fromMatterId);
    if (!cp || cp.type !== 'internal' || !cp.matterId) return;
    const other = cp.matterId;
    const from = await runAsSystem(() => queryOne<{ matter_ref: string; handler: string | null }>(`select m.matter_ref, coalesce(u.display_name, u.email) as handler from matter m left join app_user u on u.id = coalesce(m.assigned_to, m.created_by) where m.id = $1`, [input.fromMatterId]));
    const title = `Enquiry ${input.enquiryId} received from ${from?.handler ?? 'the buyer\'s handler'} (our ref ${from?.matter_ref ?? input.fromMatterId})`;
    await runAsSystem(async () => {
      const m = await queryOne<{ assigned_to: string | null; created_by: string }>(`select assigned_to, created_by from matter where id = $1 and tenant_id = $2`, [other, input.tenantId]);
      const handler = m?.assigned_to ?? m?.created_by;
      if (!handler) return;
      await createTask({ userId: handler, tenantId: input.tenantId, role: 'CONVEYANCER', email: '', displayName: null }, other, { type: 'ENQUIRY', detail: `${title}: ${input.subject}`, assigneeUserId: handler, source: 'ASSISTANT' }).catch(() => {});
      await emitMatterEvent({ tenantId: input.tenantId, matterId: other, eventType: 'LINKED_ENQUIRY_RECEIVED', title, details: `${input.subject}\n\nCounterparty type: internal (ethical wall). Reply by email as you would to an external firm; the reply is filed on the buyer's matter as a document.`, notify: { kind: 'EMAIL_TRIAGED', headline: title, did: 'Logged it on your matter', action: 'Reply to the enquiry', dedupKey: `linked-enquiry:${input.fromMatterId}:${input.enquiryId}` } });
    });
  }
}

let _ports: EnginePorts | null = null;
let _service: EngineService | null = null;

export function productionPorts(): EnginePorts {
  if (!_ports) {
    const log = (msg: string, detail?: unknown) => console.warn(`[engine] ${msg}`, detail instanceof Error ? detail.message : detail ?? '');
    const { extractor, classifier } = chooseExtractor();
    const { summariser, reportDrafter } = chooseAi(log);
    const { searchProvider, idCheckProvider } = chooseIntegrations();
    const { clientComms, chaser } = chooseComms();
    _ports = {
      linked: new PgLinkedMatterNotifier(),
      documents: new PgDocumentRepository(),
      extractor,
      classifier,
      summariser,
      reportDrafter,
      searchProvider,
      idCheckProvider,
      clientComms,
      chaser,
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      log,
    };
  }
  return _ports;
}

/** The singleton service the API routes and cron use. */
export function engine(): EngineService {
  if (!_service) _service = new EngineService(new PgEventStore(), productionPorts());
  return _service;
}
