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
import { DeterministicNoteReader } from './notes';
import { FixtureExtractor, MockChaser, MockClientComms, MockIdCheckProvider, MockSearchProvider, TemplateReportDrafter, TemplateSummariser } from './mocks';
import type { DocumentClassification, DocumentClassifier, DocumentRef, DocumentRepository, EnginePorts } from './ports';
import { EngineService } from './service';
import { PgEventStore } from './store';
import { claudeLlm, type EngineDocumentInput } from './llm';
import { ClaudeExtractor, type DocumentBytesLoader, type DocumentFactsWriter } from './extraction';
import { ClaudeSummariser, ClaudeReportDrafter, ClaudeProofOfFundsSummariser, ClaudeNoteReader } from './ai';
import { PgProofOfFundsForms } from './pof-store';
import { infotrackConfigured, infotrackProviders } from '../integrations/infotrack-adapters';
import { chaser as productionChaser, clientComms as productionClientComms, commsConfigured } from '../comms/adapters';
import { runAsSystem, runAsAutomation } from '../db';
import { createTask } from '../tasks';
import { emitMatterEvent } from '../events';
import { resolveCounterparty } from './counterparty';
import type { LinkedMatterNotifier } from './ports';
import { leapBackendActive } from '../integrations/leap/adapters';
import type { CaseBackend } from './backend';
import { nativeBackend } from '../backends/native';
import { leapBackend } from '../backends/leap';
import { PgDocumentBytesLoader, PgDocumentFactsWriter, PgDocumentRepository, setDocumentFacts } from './pg-documents';
export { PgDocumentBytesLoader, PgDocumentFactsWriter, PgDocumentRepository, setDocumentFacts };

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

let _backend: CaseBackend | null = null;
/**
 * The case backend in use: LEAP when configured (or injected for tests/demos), otherwise
 * CaseLightning's own tables. Everything backend-specific the engine touches — document
 * bytes, generated-document filing, where conclusions are shown — comes from here.
 */
export function backend(): CaseBackend {
  if (!_backend) {
    _backend = leapBackendActive() ? leapBackend() : nativeBackend((t) => engine().levels(t));
  }
  return _backend;
}
/** Test/demo hook: swap the backend (and reset the ports built from it). */
export function setBackend(b: CaseBackend | null): void {
  _backend = b;
  _ports = null;
  _service = null;
}

/** Where document bytes come from: the backend decides (LEAP download, or OneDrive / document_blob). */
export function documentBytesLoader(): DocumentBytesLoader {
  return backend().bytes;
}

/** Real pipeline when a Claude key is present (or forced), otherwise the fixture stub. */
function chooseExtractor(): { extractor: EnginePorts['extractor']; classifier: DocumentClassifier | null } {
  const useClaude = config.engineExtractor === 'claude' || (config.engineExtractor === 'auto' && !!config.anthropicApiKey);
  if (!useClaude) return { extractor: new FixtureExtractor(), classifier: null };
  const ex = new ClaudeExtractor(claudeLlm(), documentBytesLoader(), new PgDocumentFactsWriter(), { model: config.engineExtractModel, effort: 'high' });
  return { extractor: ex, classifier: new ClaudeClassifier(ex) };
}

/** Real AI layer (#3) when a Claude key is present (or forced), otherwise the deterministic templates. */
function chooseAi(log: (msg: string, detail?: unknown) => void): { summariser: EnginePorts['summariser']; reportDrafter: EnginePorts['reportDrafter']; pofSummariser: EnginePorts['pofSummariser']; noteExtractor: EnginePorts['noteExtractor'] } {
  const useClaude = config.engineAi === 'claude' || (config.engineAi === 'auto' && !!config.anthropicApiKey);
  // The deterministic reader is the floor, not a stub: with no key it still lifts the
  // handful of unmistakable lines out of a note, and with a key it catches the failures.
  const floor = new DeterministicNoteReader();
  if (!useClaude) return { summariser: new TemplateSummariser(), reportDrafter: new TemplateReportDrafter(), pofSummariser: null, noteExtractor: floor };
  const llm = claudeLlm();
  return {
    summariser: new ClaudeSummariser(llm, documentBytesLoader(), { model: config.engineDraftModel, effort: 'high', log }),
    reportDrafter: new ClaudeReportDrafter(llm, { model: config.engineDraftModel, effort: 'high', log }),
    pofSummariser: new ClaudeProofOfFundsSummariser(llm, documentBytesLoader(), { model: config.engineDraftModel, effort: 'high', log }),
    noteExtractor: new ClaudeNoteReader(llm, { model: config.engineDraftModel, effort: 'medium', log, fallback: floor }),
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
  const useReal = config.engineComms === 'real' || (config.engineComms === 'auto' && commsConfigured());
  if (!useReal) return { clientComms: new MockClientComms(), chaser: new MockChaser() };
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
    const { summariser, reportDrafter, pofSummariser, noteExtractor } = chooseAi(log);
    const { searchProvider, idCheckProvider } = chooseIntegrations();
    const { clientComms, chaser } = chooseComms();
    // The backend (CaseLightning's own tables, or LEAP) supplies the document store and
    // the conclusion sink; the engine is the same either way.
    const be = backend();
    _ports = {
      linked: new PgLinkedMatterNotifier(),
      documents: be.documents,
      onEvents: be.conclusions ? (input) => be.conclusions!.onEvents(input) : undefined,
      extractor,
      classifier,
      summariser,
      pofSummariser,
      noteExtractor,
      pofForms: new PgProofOfFundsForms(),
      reportDrafter,
      searchProvider,
      idCheckProvider,
      clientComms,
      chaser,
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      asAutomation: runAsAutomation,
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
