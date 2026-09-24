/**
 * Ports — the interfaces the state machine needs from the rest of the system.
 *
 * Spec Part 1 lists eight build components; only #1 (the state machine) is real in
 * this phase. Everything the machine touches outside its own log goes through one of
 * these interfaces so the engine can be developed and tested in isolation, and so a
 * real InfoTrack client, a real extraction pipeline or a real WhatsApp sender can be
 * dropped in later without touching machine.ts. mocks.ts has the in-memory versions;
 * adapters.ts wires the production set (Postgres documents + mocks for the rest).
 *
 *   #2 extraction   → DocumentExtractor, DocumentRepository
 *   #3 AI reasoning → DecisionSummariser (prose only, never the verdict), ReportDrafter
 *   #4 integrations → SearchProvider, IdCheckProvider
 *   #5 client comms → ClientComms (status updates), ThirdPartyChaser (template chases)
 *   #6 dashboard    → the /api/v1/decisions routes read the log; no port needed
 *   #7 audit        → the event log itself
 *   #8 Outlook      → out of scope for this phase
 */
import type { NoteActionDraft } from './notes';
import type { Citation, DecisionKind, EngineEvent, EnquiryReplyFacts, Flag, IdCheckFacts, MatterState, MortgageOfferFacts, NoteKind, SearchFacts, SearchType, SurveyFacts, TitleFacts } from './types';
import type { SummaryOverride } from './machine';
import type { ProofOfFundsFacts, StatementFacts, TransactionReview } from './proof-of-funds';

/** What the engine knows about a document (a row in `document`, or an in-memory stand-in). */
export interface DocumentRef {
  id: string;
  tenantId: string;
  matterId: string;
  docType: string | null;
  fileName: string | null;
  webUrl: string | null;
  /** Typed facts already produced by the pipeline (#2), if any — see FixtureExtractor. */
  extractedFacts: unknown;
  extractionConfidence: number | null;
}

export interface DocumentRepository {
  get(tenantId: string, documentId: string): Promise<DocumentRef | null>;
  /** Persist an engine-generated artefact (a report draft, an escalation dossier) as a document so decisions can cite it. */
  createGenerated(input: { tenantId: string; matterId: string; docType: string; fileName: string; content: string; createdBy?: string | null }): Promise<DocumentRef>;
}

/** Component #2. Every method returns typed facts WITH a confidence; the rule layer routes low confidence to a human. */
export interface DocumentExtractor {
  readonly name: string;
  extractSearch(doc: DocumentRef, searchType: SearchType): Promise<SearchFacts>;
  extractEnquiryReply(doc: DocumentRef, enquiryId: string): Promise<EnquiryReplyFacts | null>;
  extractMortgageOffer(doc: DocumentRef): Promise<MortgageOfferFacts>;
  extractTitle(doc: DocumentRef): Promise<TitleFacts>;
  extractIdCheck(doc: DocumentRef): Promise<IdCheckFacts>;
  /** Proof of funds: read a client-attached document as a bank statement, transaction by transaction. null = readable but not a statement (a gift letter, an ID). Throws when unreadable. */
  extractStatement(doc: DocumentRef): Promise<StatementFacts | null>;
  /** Case model §7: a survey / valuation / specialist report read for its recommendations (facts, never the client's view). */
  extractSurvey(doc: DocumentRef): Promise<SurveyFacts>;
}

/**
 * Notes and call transcripts (docs/intake.md). Reads what a note appears to say and
 * proposes case actions. Everything it returns is validated against the note's own words
 * and the machine's command set before anyone sees it, and applied only on approval.
 */
export interface NoteExtractor {
  readonly name: string;
  extract(input: { tenantId: string; matterId: string; text: string; kind: NoteKind; caseLine?: string }): Promise<NoteActionDraft[]>;
}

/** Component #3 (reading/summarising). May improve the prose of a decision; may NOT change the verdict or the citations. */
export interface DecisionSummariser {
  readonly name: string;
  summarise(input: { kind: DecisionKind; subjectLabel: string; flags: Flag[]; source: DocumentRef; state: MatterState }): Promise<SummaryOverride | null>;
}

/** Proof of funds (docs/proof-of-funds.md): writes the briefing the conveyancer reads before signing off a client's declaration. Prose only; the flags stand. */
export interface ProofOfFundsSummariser {
  readonly name: string;
  summarise(input: { facts: ProofOfFundsFacts; flags: Flag[]; source: DocumentRef; state: MatterState; review?: TransactionReview | null; answers?: Array<{ queryId: string; answer: string; evidenceDocumentIds: string[] }> }): Promise<SummaryOverride | null>;
}

/** Proof of funds: issues the tokenised form link the client completes. Production stores a row and hashes the token; tests keep it in memory. */
export interface ProofOfFundsForms {
  readonly name: string;
  create(input: { tenantId: string; matterId: string; requestedBy: string; followUpOf?: string | null; noteToClient?: string | null }): Promise<{ requestId: string; formUrl: string }>;
}

/** Component #3 (drafting). Assembles the client-facing report on title from cleared facts. Always goes through a human approval decision. */
export interface ReportDrafter {
  readonly name: string;
  draft(input: { state: MatterState; documents: DocumentRef[] }): Promise<{ content: string; summary: string; citations: Citation[]; model: string; basedOn: string[] }>;
}

/** Component #4. Placing an order is I/O; the engine records `search_ordered` only after the provider accepts. */
export interface SearchProvider {
  readonly name: string;
  orderSearch(input: { tenantId: string; matterId: string; searchType: SearchType }): Promise<{ reference: string }>;
}

export interface IdCheckProvider {
  readonly name: string;
  requestCheck(input: { tenantId: string; matterId: string }): Promise<{ reference: string }>;
}

/** Component #5, status updates only — the safe-to-automate half. Q&A is deliberately NOT a port here. */
export interface ClientComms {
  readonly name: string;
  sendStatusUpdate(input: { tenantId: string; matterId: string; template: string; context: Record<string, unknown> }): Promise<{ channel: 'email' | 'whatsapp' | 'mock'; messageId: string | null }>;
  /** Only ever called after assertCanSendReport passes — the engine, not the port, guards this. */
  sendReportOnTitle(input: { tenantId: string; matterId: string; draftDocument: DocumentRef }): Promise<{ channel: string; messageId: string | null }>;
}

/** Component #5, third-party chases — template-based, timer-triggered, never AI-generated per message in v1. */
export interface ThirdPartyChaser {
  readonly name: string;
  sendChase(input: {
    tenantId: string;
    matterId: string;
    recipientRole: 'seller_solicitor' | 'search_provider' | 'lender' | 'client' | 'id_provider' | 'hmlr';
    template: string;
    context: Record<string, unknown>;
  }): Promise<{ channel: 'email' | 'whatsapp' | 'portal' | 'mock'; messageId: string | null }>;
  /**
   * A note to another party on the matter — the estate agent, today — that is news and
   * not a chase. Returns null when there is nobody to tell.
   */
  sendPartyNotice(input: {
    tenantId: string;
    matterId: string;
    recipientRole: 'estate_agent';
    template: string;
    context: Record<string, unknown>;
  }): Promise<{ channel: 'email' | 'mock'; messageId: string | null } | null>;
  /**
   * Tell whoever sent us something that it arrived. Returns null when there is nobody to
   * tell (no address on the matter) — then nothing is recorded either.
   */
  sendAcknowledgement(input: {
    tenantId: string;
    matterId: string;
    recipientRole: 'seller_solicitor' | 'client';
    what: string;
    forEventType: string;
  }): Promise<{ channel: 'email' | 'whatsapp' | 'portal' | 'mock'; messageId: string | null } | null>;
}

/** Component #2, front half: which sub-flow does an arriving document belong to? */
export interface DocumentClassifier {
  readonly name: string;
  classify(doc: DocumentRef): Promise<DocumentClassification>;
}

export interface DocumentClassification {
  role: 'search' | 'enquiry_reply' | 'mortgage_offer' | 'title' | 'id_check' | 'contract' | 'survey' | 'specialist_report' | 'management_pack' | 'other';
  searchType: SearchType | null;
  enquiryReferences: string[];
  titleNumber: string | null;
  lender: string | null;
  confidence: number;
  reason: string;
}

/**
 * Addendum requirement 3: when the counterparty is another matter in this firm, raising an
 * enquiry must produce the same enquiry_raised → enquiry_reply_received pair an external
 * exchange would, never a direct read of the other matter. This port delivers the
 * enquiry to the other side's handler like an incoming letter (a task + notification on
 * THEIR matter); the reply comes back through the normal document route.
 */
export interface LinkedMatterNotifier {
  readonly name: string;
  enquiryRaised(input: { tenantId: string; fromMatterId: string; enquiryId: string; subject: string }): Promise<void>;
}

export interface EnginePorts {
  /** Optional; only used when a matter's counterparty is internal. */
  linked?: LinkedMatterNotifier | null;
  documents: DocumentRepository;
  extractor: DocumentExtractor;
  /** Optional: without a classifier, documents must be ingested with an explicit role (the /ingest route). */
  classifier?: DocumentClassifier | null;
  summariser: DecisionSummariser;
  /** Optional: without it the deterministic briefing (proof-of-funds.ts templateBriefing) is used. */
  pofSummariser?: ProofOfFundsSummariser | null;
  /** Optional: without it request_proof_of_funds cannot be issued by the service (the route refuses with 501). */
  pofForms?: ProofOfFundsForms | null;
  reportDrafter: ReportDrafter;
  /** Optional: without it a note is filed as evidence and nothing is proposed from it. */
  noteExtractor?: NoteExtractor | null;
  searchProvider: SearchProvider;
  idCheckProvider: IdCheckProvider;
  clientComms: ClientComms;
  chaser: ThirdPartyChaser;
  /** Injectable clock so tests and replays are deterministic. */
  now: () => Date;
  /** Injectable id generator (uuid in prod; sequential in tests). */
  newId: () => string;
  /** Where non-fatal effect failures go (never thrown). */
  log: (msg: string, detail?: unknown) => void;
  /**
   * Addendum 3 §1: run a block as AUTOMATION (the engine's own post-commit effects, timers).
   * Production binds this to db.runAsAutomation, which switches the connection to the
   * conveyi_automation role so the database itself refuses any human-gated event written
   * from that block. Mocks run the block as-is.
   */
  asAutomation?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Post-commit observer: every command's committed events, after the effects. Used to
   * project the log into an external system of record (LEAP write-back). Runs as
   * automation; failures are logged, never thrown — the log is the truth, this is a view.
   */
  onEvents?: (input: { tenantId: string; matterId: string; events: EngineEvent[]; state: MatterState }) => Promise<void>;
}
