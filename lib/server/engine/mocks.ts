import type { StatementFacts } from './proof-of-funds';
/**
 * In-memory MOCK implementations of every port (see ports.ts). These are what the
 * engine runs against in unit tests and in a dev environment without InfoTrack,
 * WhatsApp or the extraction pipeline. Each one is clearly a stand-in:
 *
 *   - FixtureExtractor returns whatever facts were pre-loaded on the document
 *     (`document.extracted_facts`); it never reads a PDF. Component #2 replaces it.
 *   - TemplateSummariser returns null so the deterministic template prose is used.
 *     Component #3 replaces it with a Claude-backed one that cites the same sources.
 *   - TemplateReportDrafter assembles a plain report from cleared facts.
 *   - Mock providers/comms record what they were asked to do and return fake ids.
 */
import type { Citation, EnquiryReplyFacts, IdCheckFacts, MortgageOfferFacts, SearchFacts, SearchType, TitleFacts } from './types';
import type { ClientComms, DecisionSummariser, DocumentExtractor, DocumentRef, DocumentRepository, EnginePorts, IdCheckProvider, ReportDrafter, SearchProvider, ThirdPartyChaser, ProofOfFundsForms } from './ports';

export class MemoryDocumentRepository implements DocumentRepository {
  private docs = new Map<string, DocumentRef>();
  private n = 0;

  /** Test helper: register a document with pre-extracted facts (what pipeline #2 would have produced). */
  seed(input: Partial<DocumentRef> & { tenantId: string; matterId: string }): DocumentRef {
    const id = input.id ?? `doc-${++this.n}`;
    const doc: DocumentRef = {
      id,
      tenantId: input.tenantId,
      matterId: input.matterId,
      docType: input.docType ?? null,
      fileName: input.fileName ?? `${id}.pdf`,
      webUrl: input.webUrl ?? null,
      extractedFacts: input.extractedFacts ?? null,
      extractionConfidence: input.extractionConfidence ?? null,
    };
    this.docs.set(id, doc);
    return doc;
  }

  async get(tenantId: string, documentId: string): Promise<DocumentRef | null> {
    const d = this.docs.get(documentId);
    return d && d.tenantId === tenantId ? d : null;
  }

  async createGenerated(input: { tenantId: string; matterId: string; docType: string; fileName: string; content: string }): Promise<DocumentRef> {
    return this.seed({ tenantId: input.tenantId, matterId: input.matterId, docType: input.docType, fileName: input.fileName, extractedFacts: { content: input.content } });
  }

  all(): DocumentRef[] {
    return [...this.docs.values()];
  }
}

/** STUB for component #2: hands back the facts stored on the document. Throws when there are none — the service turns that into a low-confidence flag, never a guess. */
export class FixtureExtractor implements DocumentExtractor {
  readonly name = 'fixture-extractor (stub for pipeline #2)';
  private facts<T>(doc: DocumentRef, what: string): T {
    if (doc.extractedFacts == null) throw new Error(`No extracted ${what} facts on document ${doc.id} (pipeline #2 not built).`);
    return doc.extractedFacts as T;
  }
  async extractSearch(doc: DocumentRef, searchType: SearchType): Promise<SearchFacts> {
    const f = this.facts<SearchFacts>(doc, 'search');
    return { ...f, searchType: f.searchType ?? searchType };
  }
  async extractEnquiryReply(doc: DocumentRef, enquiryId: string): Promise<EnquiryReplyFacts | null> {
    if (doc.extractedFacts == null) return null;
    const f = doc.extractedFacts as EnquiryReplyFacts;
    return { ...f, enquiryId: f.enquiryId ?? enquiryId };
  }
  async extractMortgageOffer(doc: DocumentRef): Promise<MortgageOfferFacts> {
    return this.facts(doc, 'mortgage offer');
  }
  async extractTitle(doc: DocumentRef): Promise<TitleFacts> {
    return this.facts(doc, 'title');
  }
  async extractIdCheck(doc: DocumentRef): Promise<IdCheckFacts> {
    return this.facts(doc, 'ID check');
  }
  /** A seeded document with `transactions` is a statement; `{ unreadable: true }` throws; anything else is "not a statement". */
  async extractStatement(doc: DocumentRef): Promise<StatementFacts | null> {
    const f = doc.extractedFacts as { transactions?: unknown; unreadable?: unknown } | null;
    if (f?.unreadable) throw new Error('scan too poor to read');
    if (Array.isArray(f?.transactions)) return f as unknown as StatementFacts;
    return null;
  }
}

/** STUB for component #3: no model; the machine's deterministic template prose stands. */
export class TemplateSummariser implements DecisionSummariser {
  readonly name = 'template';
  async summarise(): Promise<null> {
    return null;
  }
}

/** STUB for component #3 drafting: a plain-text report assembled from cleared facts, citing each source document. */
export class TemplateReportDrafter implements ReportDrafter {
  readonly name = 'template-report-drafter (stub for AI drafting #3)';
  async draft(input: { state: MatterState; documents: DocumentRef[] }) {
    const { state } = input;
    const docs = new Map(input.documents.map((d) => [d.id, d]));
    const citations: Citation[] = [];
    const lines: string[] = ['REPORT ON TITLE (DRAFT — requires conveyancer approval before sending)', ''];
    if (state.title.facts) {
      lines.push(`Title: ${state.title.facts.titleNumber} (${state.title.facts.tenure}).`);
      if (state.title.documentId) citations.push({ documentId: state.title.documentId, label: 'Official copy of the register' });
      for (const c of state.title.facts.covenants) lines.push(`  Covenant: ${c.text}`);
      for (const r of state.title.facts.restrictions) lines.push(`  Restriction: ${r.text}`);
    }
    lines.push('', 'Searches:');
    for (const sr of Object.values(state.searches)) {
      lines.push(`  ${sr.searchType}: ${sr.status}${sr.resolution ? ` (${sr.resolution})` : ''}${sr.flags.length ? ` — ${sr.flags.map((f) => f.description).join('; ')}` : ' — no issues'}`);
      if (sr.documentId) citations.push({ documentId: sr.documentId, label: `${sr.searchType} search result${docs.get(sr.documentId)?.fileName ? ` (${docs.get(sr.documentId)?.fileName})` : ''}` });
    }
    if (Object.keys(state.enquiries).length) {
      lines.push('', 'Enquiries:');
      for (const q of Object.values(state.enquiries)) {
        lines.push(`  ${q.enquiryId}: ${q.subject} — ${q.status}${q.resolution ? ` (${q.resolution})` : ''}`);
        if (q.documentId) citations.push({ documentId: q.documentId, label: `Reply to enquiry ${q.enquiryId}` });
      }
    }
    if (state.hasLender && state.mortgage.facts) {
      lines.push('', `Mortgage: offer from ${state.mortgage.facts.lender}, ${state.mortgage.facts.conditions.length} condition(s), status ${state.mortgage.status}.`);
      if (state.mortgage.documentId) citations.push({ documentId: state.mortgage.documentId, label: 'Mortgage offer' });
    }
    const content = lines.join('\n');
    return {
      content,
      summary: `Draft report on title assembled from ${citations.length} source document(s). Review every section against its source before approving; nothing is sent until you approve.`,
      citations,
      model: this.name,
      basedOn: citations.map((c) => c.documentId),
    };
  }
}

export class MockSearchProvider implements SearchProvider {
  readonly name = 'mock-search-provider (stub for InfoTrack #4)';
  orders: Array<{ matterId: string; searchType: SearchType; reference: string }> = [];
  async orderSearch(input: { matterId: string; searchType: SearchType }) {
    const reference = `MOCK-${input.searchType}-${this.orders.length + 1}`;
    this.orders.push({ matterId: input.matterId, searchType: input.searchType, reference });
    return { reference };
  }
}

export class MockIdCheckProvider implements IdCheckProvider {
  readonly name = 'mock-id-provider (stub for AML/ID #4)';
  requests: string[] = [];
  async requestCheck(input: { matterId: string }) {
    this.requests.push(input.matterId);
    return { reference: `MOCK-ID-${this.requests.length}` };
  }
}

export class MockClientComms implements ClientComms {
  readonly name = 'mock-client-comms (stub for WhatsApp/email #5)';
  sent: Array<{ matterId: string; template: string; context: Record<string, unknown> }> = [];
  reports: Array<{ matterId: string; documentId: string }> = [];
  async sendStatusUpdate(input: { matterId: string; template: string; context: Record<string, unknown> }) {
    this.sent.push({ matterId: input.matterId, template: input.template, context: input.context });
    return { channel: 'mock' as const, messageId: `mock-msg-${this.sent.length}` };
  }
  async sendReportOnTitle(input: { matterId: string; draftDocument: DocumentRef }) {
    this.reports.push({ matterId: input.matterId, documentId: input.draftDocument.id });
    return { channel: 'mock', messageId: `mock-report-${this.reports.length}` };
  }
}

/** In-memory proof-of-funds form issuer: sequential ids, a fake link. */
export class MockProofOfFundsForms implements ProofOfFundsForms {
  readonly name = 'mock-pof-forms';
  issued: Array<{ requestId: string; matterId: string; followUpOf: string | null; noteToClient: string | null }> = [];
  async create(input: { tenantId: string; matterId: string; requestedBy: string; followUpOf?: string | null; noteToClient?: string | null }) {
    const requestId = `pof-${this.issued.length + 1}`;
    this.issued.push({ requestId, matterId: input.matterId, followUpOf: input.followUpOf ?? null, noteToClient: input.noteToClient ?? null });
    return { requestId, formUrl: `https://mock.local/pof/${requestId}` };
  }
}

export class MockChaser implements ThirdPartyChaser {
  readonly name = 'mock-chaser (stub for template chase emails #5)';
  chases: Array<{ matterId: string; recipientRole: string; template: string }> = [];
  async sendChase(input: { matterId: string; recipientRole: string; template: string }) {
    this.chases.push({ matterId: input.matterId, recipientRole: input.recipientRole, template: input.template });
    return { channel: 'mock' as const, messageId: `mock-chase-${this.chases.length}` };
  }
}

export interface MockPorts extends EnginePorts {
  documents: MemoryDocumentRepository;
  searchProvider: MockSearchProvider;
  idCheckProvider: MockIdCheckProvider;
  clientComms: MockClientComms;
  chaser: MockChaser;
  pofForms: MockProofOfFundsForms;
  /** Test helper: move the injected clock. */
  setNow(d: Date): void;
}

/** A complete mock port set with a controllable clock and sequential ids. */
export function mockPorts(start = new Date('2026-09-14T09:00:00Z')): MockPorts {
  let now = start;
  let n = 0;
  const logs: unknown[] = [];
  return {
    documents: new MemoryDocumentRepository(),
    extractor: new FixtureExtractor(),
    summariser: new TemplateSummariser(),
    reportDrafter: new TemplateReportDrafter(),
    searchProvider: new MockSearchProvider(),
    idCheckProvider: new MockIdCheckProvider(),
    clientComms: new MockClientComms(),
    chaser: new MockChaser(),
    pofForms: new MockProofOfFundsForms(),
    now: () => now,
    newId: () => `evt-${String(++n).padStart(4, '0')}`,
    log: (msg, detail) => logs.push([msg, detail]),
    setNow: (d) => {
      now = d;
    },
  };
}

// Re-exported so mocks.ts is self-contained for tests.
import type { MatterState } from './types';
export type { MatterState };
