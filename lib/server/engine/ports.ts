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
import type { DraftCheck, RegisterFact } from './draft-check';
import type { NoteActionDraft } from './notes';
import type { MessageParty, PropertyFormsFacts, Citation, DecisionKind, EngineEvent, EnquiryReplyFacts, Flag, IdCheckFacts, MatterState, MortgageOfferFacts, NoteKind, NoteSender, SignedDocument, SearchFacts, SearchType, SurveyFacts, TitleFacts, TitlePlanFacts, SupportingDocFacts, ContractFacts, LeaseFacts, ManagementPackFacts } from './types';
import type { SummaryOverride } from './machine';
import type { ProofOfFundsFacts, StatementFacts, TransactionReview, PayslipFacts, EvidenceKind } from './proof-of-funds';

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
  /** The fact register for a matter (every verified-or-not fact with its page and quote) and what the case record itself says; the drafter may use nothing else. */
  loadRegister?(tenantId: string, matterId: string): Promise<{ facts: RegisterFact[]; allowed: string[] }>;
  /** Keep the check of a drafted document against the register, for the reader. */
  writeDraftCheck?(tenantId: string, documentId: string, check: DraftCheck): Promise<void>;
}

/** Component #2. Every method returns typed facts WITH a confidence; the rule layer routes low confidence to a human. */
export interface DocumentExtractor {
  readonly name: string;
  extractSearch(doc: DocumentRef, searchType: SearchType): Promise<SearchFacts>;
  extractEnquiryReply(doc: DocumentRef, enquiryId: string): Promise<EnquiryReplyFacts | null>;
  extractMortgageOffer(doc: DocumentRef): Promise<MortgageOfferFacts>;
  extractTitle(doc: DocumentRef): Promise<TitleFacts>;
  /** A title plan (the map): optional, so an extractor without it files the plan unread. */
  extractTitlePlan?(doc: DocumentRef): Promise<TitlePlanFacts>;
  /** A supporting document (indemnity policy, permission, certificate, guarantee): optional, like the plan. */
  extractSupportingDocument?(doc: DocumentRef): Promise<SupportingDocFacts>;
  extractIdCheck(doc: DocumentRef): Promise<IdCheckFacts>;
  /** A contract read for its terms: parties, price, deposit, dates, conditions. Reviewed by a person; never approved by rule. */
  extractContract(doc: DocumentRef): Promise<ContractFacts>;
  /** The lease read for its terms (leasehold): term, rent and review, service charge, repairs, alienation, use, insurance, notices. */
  extractLease(doc: DocumentRef): Promise<LeaseFacts>;
  /** The LPE1 / management pack read for its answers: charges, arrears, works, insurance, fees, consents, disputes. */
  extractManagementPack(doc: DocumentRef): Promise<ManagementPackFacts>;
  /** Proof of funds: read a client-attached document as a bank statement, transaction by transaction. null = readable but not a statement (a gift letter, an ID). Throws when unreadable. */
  extractStatement(doc: DocumentRef): Promise<StatementFacts | null>;
  /** Proof of funds: the attached document read for what it is (statement, payslip, gift letter…). Readers without it are treated as statement-or-nothing. */
  extractEvidence?(doc: DocumentRef): Promise<{ kind: EvidenceKind; statement: StatementFacts | null; payslip: PayslipFacts | null }>;
  /** Case model §7: a survey / valuation / specialist report read for its recommendations (facts, never the client's view). */
  extractSurvey(doc: DocumentRef): Promise<SurveyFacts>;
  /** The seller's TA6 / TA7 / TA10 read answer by answer. */
  extractPropertyForms(doc: DocumentRef): Promise<PropertyFormsFacts>;
}

/**
 * Notes and call transcripts (docs/intake.md). Reads what a note appears to say and
 * proposes case actions. Everything it returns is validated against the note's own words
 * and the machine's command set before anyone sees it, and applied only on approval.
 */
/**
 * The second check on an email the codified rule read as a pure acknowledgement: with the whole
 * conversation and what the case is waiting for, is it really one? Anything short of certain is false.
 */
export interface AcknowledgementChecker {
  readonly name: string;
  confirm(input: { tenantId: string; matterId: string; text: string; thread?: string; from?: NoteSender | null; caseLine?: string; open?: string[] }): Promise<{ acknowledgement: boolean; reason: string }>;
}

/** Words the reply to an email from the case facts; every point the writer made is answered. */
export interface EmailReplyDrafter {
  readonly name: string;
  draft(input: { tenantId: string; matterId: string; email: string; subject: string; from: NoteSender | null; firstName: string | null; lines: Array<{ kind: string; summary: string; quote: string }>; facts: string; now: string; /** Who this message goes to, and what it must do. Absent = the reply to the writer. */ to?: MessageParty; purposes?: string[]; /** "the buyer (Jo Smith)". */ weActFor?: string }): Promise<{ body: string } | null>;
}

export interface NoteExtractor {
  readonly name: string;
  extract(input: { tenantId: string; matterId: string; text: string; kind: NoteKind; caseLine?: string; from?: NoteSender | null; now?: string; attachments?: string[]; context?: string; /** What the case is waiting for from the writer, so "that's done" can name it. */ waits?: Array<{ waitKey: string; subject: string; label: string }> }): Promise<NoteActionDraft[]>;
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
  draft(input: { state: MatterState; documents: DocumentRef[]; register?: RegisterFact[] }): Promise<{ content: string; summary: string; citations: Citation[]; model: string; basedOn: string[] }>;
}

/** Component #4. Placing an order is I/O; the engine records `search_ordered` only after the provider accepts. */
export interface SearchProvider {
  readonly name: string;
  /** `provider`: who actually took the order, when the port routes per firm (InfoTrack on the firm's account, or the stand-in). */
  orderSearch(input: { tenantId: string; matterId: string; searchType: SearchType }): Promise<{ reference: string; provider?: string }>;
  /**
   * A stand-in provider (no search provider connected) hands back a placeholder result at once, so
   * a case is not held on searches nobody will ever send. It says on its face that no search was done.
   */
  placeholderResult?(input: { searchType: SearchType; reference: string; orderedAt: Date }): { fileName: string; content: string; facts: SearchFacts } | null;
}

export interface IdCheckProvider {
  readonly name: string;
  /** True when the provider emails the person their own link (so a chase can say where to look). */
  readonly sendsClientLink?: boolean;
  /** `link`: the person's own link to the check, when the provider gives one back — kept so a chase can send it again. */
  requestCheck(input: { tenantId: string; matterId: string; /** a named party beyond the first client (co-buyer, donor); absent = the first client */ party?: string | null; label?: string | null }): Promise<{ reference: string; link?: string | null; provider?: string }>;
  /** A provider routed per firm: how it reaches that firm's clients (null until the firm's account has been looked up). */
  forFirm?(tenantId: string): { sendsClientLink: boolean; label: string } | null;
}

/** Component #5, status updates only — the safe-to-automate half. Q&A is deliberately NOT a port here. */
/** A person's edit of a proposed message: what actually goes. */
export interface MessageOverride { subject?: string | null; body?: string | null }

export interface ClientComms {
  readonly name: string;
  sendStatusUpdate(input: { tenantId: string; matterId: string; template: string; context: Record<string, unknown>; override?: MessageOverride | null; attachments?: Array<{ name: string; bytes: Buffer; contentType: string }>; /** Files as a secure link (the default for files to a client). */ link?: { url: string; files: string[] } | null }): Promise<{ channel: 'email' | 'whatsapp' | 'mock'; messageId: string | null; /** where it went, for the case's record */ address?: string | null }>;
  /** Only ever called after assertCanSendReport passes — the engine, not the port, guards this. */
  sendReportOnTitle(input: { tenantId: string; matterId: string; draftDocument: DocumentRef; link?: { url: string; files: string[] } | null }): Promise<{ channel: string; messageId: string | null }>;
}

/** Component #5, third-party chases — template-based, timer-triggered, never AI-generated per message in v1. */
export interface ThirdPartyChaser {
  readonly name: string;
  /** Our enquiries to the seller's solicitor, as raised (approved, or raised by a person): numbered, with our reference. */
  /** A first request to another party (the contract pack, a redemption statement, the lender's consent, the agent told of exchange): news or a request, not a chase. */
  sendRequest?(input: { tenantId: string; matterId: string; recipientRole: 'seller_solicitor' | 'lender' | 'estate_agent'; template: string; context: Record<string, unknown> }): Promise<{ channel: 'email' | 'mock'; messageId: string | null }>;
  sendEnquiries?(input: { tenantId: string; matterId: string; enquiryId: string; text: string }): Promise<{ channel: 'email' | 'mock'; messageId: string | null } | null>;
  /** A message a person approved, as written, to a party on the case (from an email's task). */
  sendMessage?(input: { tenantId: string; matterId: string; recipientRole: 'seller_solicitor' | 'estate_agent' | 'lender'; subject: string; body: string }): Promise<{ channel: 'email' | 'mock'; messageId: string | null }>;
  sendChase(input: {
    tenantId: string;
    matterId: string;
    recipientRole: 'seller_solicitor' | 'search_provider' | 'lender' | 'client' | 'id_provider' | 'hmlr';
    template: string;
    context: Record<string, unknown>;
    override?: MessageOverride | null;
  }): Promise<{ channel: 'email' | 'whatsapp' | 'portal' | 'mock'; messageId: string | null }>;
  /**
   * A note to another party on the matter — the estate agent, today — that is news and
   * not a chase. Returns null when there is nobody to tell.
   */
  sendPartyNotice(input: {
    tenantId: string;
    matterId: string;
    recipientRole: 'estate_agent' | 'lender';
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
    override?: MessageOverride | null;
  }): Promise<{ channel: 'email' | 'whatsapp' | 'portal' | 'mock'; messageId: string | null } | null>;
}

/** Component #2, front half: which sub-flow does an arriving document belong to? */
export interface DocumentClassifier {
  readonly name: string;
  classify(doc: DocumentRef): Promise<DocumentClassification>;
}

export interface DocumentClassification {
  role: 'search' | 'enquiry_reply' | 'mortgage_offer' | 'title' | 'title_plan' | 'supporting_document' | 'id_check' | 'contract' | 'survey' | 'specialist_report' | 'management_pack' | 'lease' | 'property_forms' | 'hmlr_requisition' | 'other';
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

/**
 * Signing: sending the client what they must sign. Wet-ink deeds go as a letter from the fee
 * earner's mailbox with the deeds attached and the firm's postal address to return them to;
 * electronic ones go to the firm's signing provider (InfoTrack, InTouch, LEAP), which calls back
 * with the signed copy.
 */
export interface SigningPort {
  readonly name: string;
  /** The firm's provider ('none' = wet ink only) and whether this lender takes an e-signed mortgage deed (null: not known). */
  defaults(tenantId: string, lender: string | null): Promise<{ provider: string; lenderAcceptsDigital: boolean | null }>;
  /** `reminder`: a chase — the same letter again with the unsigned deeds re-attached; deeds already with the provider get no new envelope. `override`: a person's edit of the words. */
  sendPack(input: { tenantId: string; matterId: string; wet: SignedDocument[]; electronic: SignedDocument[]; signers: string[]; reminder?: { alreadyWithProvider: SignedDocument[] } | null; override?: { subject?: string | null; body?: string | null } | null }): Promise<{ channel: string; messageId: string | null; attached: string[]; envelopes: Array<{ document: SignedDocument; provider: string; envelopeId: string }>; fellBackToWet: SignedDocument[] }>;
}

export interface EnginePorts {
  /** Enrolment fires the ID / AML check and the proof-of-funds form unasked (subject to trust levels). Default on; flow fixtures turn it off to drive each step by hand. */
  autoStartOnEnrol?: boolean;
  /** Optional; only used when a matter's counterparty is internal. */
  linked?: LinkedMatterNotifier | null;
  /** Optional: the firm's lender directory; a mortgage offer naming a lender in it records that lender's requirements on the matter. */
  lenderDirectory?: { find(tenantId: string, lenderName: string): Promise<{ minUnexpiredYears: number | null; maxSearchAgeMonths: number | null; acceptsNonFamilyGift: boolean | null; acceptsLoanDeposit?: boolean | null; acceptsDonorAbroad?: boolean | null; requiresEws1: boolean | null; note: string | null } | null> } | null;
  documents: DocumentRepository;
  /** Optional: whether the firm is paid up (or in its grace period). A suspended firm's cases are not swept: nothing is chased or sent until they pay. */
  entitled?(tenantId: string): Promise<boolean>;
  /** Optional: a file on the case found by what someone calls it, and its bytes (a client asking for a copy). */
  /** Secure links to files for a client (migration 116): a link that opens with an emailed code; opens are counted. Absent = files go as attachments. */
  fileShares?: { create(input: { tenantId: string; matterId: string; files: Array<{ id: string; fileName: string }> }): Promise<{ url: string }>; /** The files of the last link sent on the case (what "the link won't open" is about). */ latest(tenantId: string, matterId: string): Promise<Array<{ id: string; fileName: string }>> } | null;
  files?: { find(tenantId: string, matterId: string, what: string): Promise<Array<{ id: string; fileName: string }>>; bytes(tenantId: string, id: string): Promise<{ name: string; bytes: Buffer; contentType: string } | null> };
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
  /** Optional: without it no email is ever treated as needing no reply (every one reaches a person). */
  ackChecker?: AcknowledgementChecker | null;
  /** Optional: without it the reply is assembled from the case facts (reply.ts templateReply). */
  replyDrafter?: EmailReplyDrafter | null;
  searchProvider: SearchProvider;
  idCheckProvider: IdCheckProvider;
  clientComms: ClientComms;
  /** The firm's reminder window for client updates, in hours (Rules > Timers); absent = the default. */
  clientReminderHours?(tenantId: string): Promise<number>;
  /** Optional: drafts the letter after the survey (a person reads and can edit it). Without it, the template letter. */
  /** Raw points (forms, survey) written up as the enquiries a conveyancer sends: merged, trimmed, the buyer's own points set aside. Null = use the points as they are. */
  enquiryWriter?: { write(input: { tenantId: string; matterId: string; points: string[]; source: 'forms' | 'survey' }): Promise<{ enquiries: string[]; notForTheSeller: string[] } | null> } | null;
  surveyAdviser?: { draft(input: { tenantId: string; matterId: string; facts: SurveyFacts; purchasePricePennies: number | null; freehold: boolean; hasLender: boolean; transactionLabel: string }): Promise<string | null> } | null;
  /** Optional: Outlook housekeeping; a completed case's mail folders move into Archive. */
  mailFolders?: { archiveCase(tenantId: string, matterId: string): Promise<number> } | null;
  /** Optional: sending the signing pack. Without it the pack is proposed and recorded by hand. */
  signing?: SigningPort | null;
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
  /** The inverse, for recording on the case that an automation effect failed: that note must land even when the automation role is what failed. */
  outsideAutomation?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The message a proposal would send, rendered exactly (to, subject, body), so a failed send can hand it to a person to send by hand. */
  messagePreview?: (tenantId: string, matterId: string, action: string, detail: Record<string, unknown>) => Promise<{ kind: string; to?: string; subject?: string; body?: string; title?: string } | null>;
  /**
   * Post-commit observer: every command's committed events, after the effects. Used to
   * project the log into an external system of record (LEAP write-back). Runs as
   * automation; failures are logged, never thrown — the log is the truth, this is a view.
   */
  onEvents?: (input: { tenantId: string; matterId: string; events: EngineEvent[]; state: MatterState }) => Promise<void>;
}
