/** Client-side shapes of the engine API (mirrors lib/server/engine/types.ts without importing server code). */
export type Api = <T = unknown>(path: string, options?: RequestInit) => Promise<T>;

export interface Citation { documentId: string; label: string; locator?: { page?: number; section?: string; quote?: string } }

export interface DecisionRow {
  eventId: string;
  seq: number;
  matterId: string;
  matterRef: string | null;
  propertyAddress: string | null;
  stage: string;
  kind: string;
  subject: string | null;
  summary: string;
  sourceDocumentId: string;
  sourceLocator?: { page?: number; section?: string; quote?: string } | null;
  citations: Citation[];
  options: string[];
  createdAt: string;
  summarisedBy: string;
  status: 'pending' | 'actioned' | 'escalated';
  /** The task in a conveyancer's sentence (present when the list is scoped to one case). */
  what?: string | null;
  /** `proposal:<what it would send>` or the decision kind; and the chip in words (present when scoped to one case). */
  taskKind?: string;
  chip?: string;
  openedBy: string[];
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  resolution?: string | null;
  sourceOpenedByMe?: boolean;
  shadowMode?: boolean;
}

/** Addendum 3 §3: how the handler engaged with the source section (recorded on the resolving event). */
export interface Engagement { scrolledSource: boolean; dwellMs: number }

/** Addendum 3 §3: one queue row per matter. */
export interface QueueRow {
  matterId: string;
  transactionType?: TransactionType | null;
  matterRef: string | null;
  propertyAddress: string | null;
  stage: string;
  shadowMode: boolean;
  sandbox?: boolean;
  assignedTo: string | null;
  pendingCount: number;
  reviewCount: number;
  loggedCount: number;
  oldestPendingAt: string | null;
  openIssues: number;
  holdingIssues: number;
  targetCompletionDate: string | null;
  targetExchangeDate: string | null;
  manualHandling: boolean;
  updatedAt: string;
  openedAt?: string | null;
  completedAt?: string | null;
  endedAt?: string | null;
}

export interface MatterMeta { matterRef: string; propertyAddress: string; legacyStage?: string | null; shadowMode: boolean; assignedTo?: string | null; handler?: string | null; /** A scenario-library case: quarantined from every outward effect. */ sandbox?: boolean; sandboxScenario?: string | null; sandboxStep?: string | null; }

export interface TaskContextView {
  headline: string;
  task: Array<{ k: string; v: string; warn?: boolean }>;
  facts: Array<{ k: string; v: string }>;
  checks: string[];
  narrative?: Array<{ text: string; documentId?: string | null; page?: number | null; quote?: string | null; quoteIndex?: number; warn?: boolean }>;
  files?: Array<{ documentId: string; title: string; summary: string; warn?: boolean; lines: Array<{ text: string; documentId?: string | null; page?: number | null; quote?: string | null; quoteIndex?: number; warn?: boolean }> }>;
  passed?: string[];
  submitted?: { by: string; at: string | null } | null;
  checklist?: Array<{ text: string; status: 'ok' | 'flag' | 'open'; evidence: Array<{ text: string; documentId?: string | null; page?: number | null; quote?: string | null; warn?: boolean; links?: Array<{ label: string; documentId: string; page?: number | null; quote?: string | null }> }> }>;
  history: Array<{ at: string; what: string }>;
  related: string[];
  unblocks: string | null;
}

/** What a proposal would actually do: the exact message and recipient, the form, or the order. */
export type ProposalPreview =
  | { kind: 'message'; to: string; address: string | null; channel: 'whatsapp' | 'email' | 'draft' | 'none'; subject: string; body: string }
  | { kind: 'form'; to: string; address: string | null; channel: 'whatsapp' | 'email' | 'draft' | 'none'; subject: string; body: string; note: string | null }
  | { kind: 'action'; title: string; lines: string[] };

export interface DecisionDetail {
  /** For a proposal: what it would actually send or do, exactly. */
  message?: ProposalPreview | null;
  /** Proof of funds: queries to the client still open. Signing off with any needs a reason, which withdraws them. */
  openQueries?: number;
  /** What a person needs to take this decision from cold (lib/server/engine/context.ts). */
  context: TaskContextView | null;
  decision: DecisionRow;
  matter: MatterMeta | null;
  raised: { seq: number; type: string; actor: string; createdAt: string; confidenceScore: number | null } | null;
  resolution: { eventId: string; type: string; by: string; at: string; option: string | null; note: string | null; engagement: Engagement | null; verification: { method: string; reference: string | null } | null } | null;
  escalation: { eventId: string; at: string } | null;
  opens: Array<{ by: string; at: string; documentId: string }>;
  people: Record<string, string>;
  shadowed: 'matter' | 'subflow' | null;
  source: SourceDoc | null;
  /** note_actions only: what the note appears to say, line by line, for the person to pick from. */
  noteActions: NoteActionsDetail | null;
}

export interface NoteActionView {
  id: string;
  kind: string;
  summary: string;
  quote: string;
  confidence: number;
  /** null = for information only; nothing would be recorded. */
  effect: string | null;
  /** What ticking it changes on the case, one change each. */
  changes?: string[];
  /** The command it would run (send_file_copy, raise_issue…). */
  command?: string | null;
}

export interface MessageFile { id: string; fileName: string; what: string }
export interface NoteActionsDetail {
  title?: string | null;
  noteId: string;
  noteKind: string;
  actions: NoteActionView[];
  /** Set once resolved: what actually landed, and anything the machine then refused. */
  applied: string[] | null;
  skipped: string[] | null;
  refused: Array<{ id: string; reason: string }>;
  /** The messages drafted from the case (the reply first, then anyone else who needs to hear), and once resolved, what was sent. */
  messages?: Array<{ id: string; to: string; purposes: string[]; subject: string; body: string; drafter: string; on: boolean; attach?: MessageFile[]; asAttachments?: boolean }>;
  messagesSent?: Array<{ id: string; to: string; subject: string; body: string; attach?: MessageFile[]; asAttachments?: boolean }> | null;
}

export const TRUST_LEVELS = ['propose', 'assist', 'auto'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export const ENGINE_ACTION_LABEL: Record<string, string> = { acknowledgement: 'Acknowledge what arrives', chase: 'Chase the other side', client_update: 'Update the client', search_order: 'Order searches', auto_clear: 'Clear a document the rules pass', enquiry_draft: "Draft enquiries from the seller's forms", email_no_reply: 'Let acknowledgements go without a reply' };
export const SUB_FLOWS = ['id_check', 'search', 'enquiry', 'mortgage', 'title', 'report_on_title', 'chase'] as const;
export const SUBFLOW_LABEL: Record<string, string> = { id_check: 'ID / AML', search: 'Searches', enquiry: 'Enquiries', mortgage: 'Mortgage offer', title: 'Title', report_on_title: 'Report on title', chase: 'Chasing & escalation' };

/** Event types that carry a DecisionSpec (mirrors the server's DECISION_EVENT_TYPES). */
export const DECISION_EVENT_TYPES = new Set(['id_check_flagged', 'search_flagged', 'enquiry_reply_flagged', 'mortgage_condition_flagged', 'title_flagged', 'report_on_title_drafted', 'escalation_raised', 'bank_details_change_flagged', 'auto_clear_review_raised', 'note_extracted']);

export interface SourceDoc { id: string; fileName: string | null; webUrl: string | null; docType: string | null; content: string | null; rawUrl?: string | null; draftCheck?: DraftCheckView | null }
/** The check of a drafted document against the fact register (lib/server/engine/draft-check.ts). */
export interface DraftCheckView {
  sentences: Array<{ text: string; start: number; end: number; para?: number; factIds: string[]; struck: Array<{ text: string; kind: string; start: number; end: number }> }>;
  notFromFile: Array<{ text: string; kind: string; sentence: string }>;
  cited: Array<{ id: string; documentId: string; documentLabel: string; key: string; value: string; page: number | null; quote: string | null }>;
  summary: { sentences: number; claims: number; matched: number; struck: number; cited: number };
}

export interface WaitRow { key: string; subject: string; openedAt: string; openedBy?: string; closedAt: string | null; chasesSentAt: string[]; lastChasedBy?: string | null; escalations: Array<{ eventId: string; raisedAt: string; resolvedAt: string | null }>; /** When the timer chases next; null when no further chase is due. */ chase?: { dueDate: string; dueInWorkingDays: number; recipientRole: string; template: string; priorChases: number } | null }

export interface PofQueryRow {
  id: string;
  key: string;
  flagCode: string;
  documentId: string | null;
  transaction: { date: string; description: string; amountPennies: number } | null;
  question: string;
  raisedAt: string;
  raisedBy: string;
  status: 'draft' | 'sent' | 'answered' | 'withdrawn';
  sentAt: string | null;
  answer: string | null;
  answerEvidenceDocumentIds: string[];
  answeredAt: string | null;
}

export interface IssueRow {
  /** A further investigation: what the client said to do about it. */
  route?: 'evidence' | 'pursue' | 'waive' | null;
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  gate: 'exchange' | 'completion' | 'none';
  status: 'open' | 'negotiating' | 'resolved' | 'withdrawn' | 'fatal';
  raisedAt: string;
  raisedBy: string;
  raisedAtStage: string;
  updatedAt: string;
  sourceDocumentId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  origin: { issueId: string; resolution: string } | null;
  party: string | null;
  costPennies: number | null;
  paidBy: string | null;
  enquiryIds: string[];
  severity?: 'info' | 'warning' | 'critical';
  causedBy?: string | null;
  history: Array<{ at: string; by: string; what: string }>;
  /** When it should be sorted by (YYYY-MM-DD). */
  resolveBy?: string | null;
  details?: Record<string, string | number | boolean | null> | null;
  evidenceDocumentId?: string | null;
}
export interface ResolutionField { key: string; label: string; type: 'money' | 'date' | 'text' | 'lender' | 'document' | 'confirm' | 'payer' | 'channel'; required: boolean }

/** The issue catalogue as /engine/spec publishes it (kinds, groups, resolutions). */
export interface IssueCatalogue {
  groups: Array<{ id: string; label: string }>;
  kinds: Array<{ kind: string; group: string; label: string; severity?: 'info' | 'warning' | 'critical'; arisesFrom: string; gate: 'exchange' | 'completion' | 'none'; stages: string[]; resolutions: string[]; note: string; overlaps?: string; context?: boolean; escalateAfterWorkingDays?: number | null; responsible?: string }>;
  resolutions: Array<{ id: string; label: string; title?: string; fields?: ResolutionField[]; noteRequired?: boolean; effect?: string | null; effects: string[] }>;
  staleAfterWorkingDays: number;
  formless?: string[];
  chips?: Record<string, string>;
  steps?: Record<string, Array<{ id: string; kind: 'message' | 'dates' | 'negotiating' | 'fatal'; label: string; to?: string }>>;
  sellerSteps?: IssueCatalogue['steps'];
}

export type TransactionType = 'freehold_purchase' | 'leasehold_purchase' | 'freehold_sale' | 'leasehold_sale' | 'remortgage' | 'transfer_of_equity';
export const TRANSACTION_TYPES: TransactionType[] = ['freehold_purchase', 'leasehold_purchase', 'freehold_sale', 'leasehold_sale', 'remortgage', 'transfer_of_equity'];
export const TRANSACTION_LABEL: Record<TransactionType, string> = { freehold_purchase: 'Freehold Purchase', leasehold_purchase: 'Leasehold Purchase', freehold_sale: 'Freehold Sale', leasehold_sale: 'Leasehold Sale', remortgage: 'Remortgage', transfer_of_equity: 'Transfer Of Equity' };

/** The transaction profile as the engine route returns it (docs/transaction-types.md). */
export interface ProfileView {
  type: TransactionType;
  label: string;
  side: 'buyer' | 'seller' | 'owner';
  tenure: 'freehold' | 'leasehold' | 'any';
  hasExchange: boolean;
  stages: string[];
  stageLabels: Partial<Record<string, string>>;
  workstreams: string[];
  subflows: string[];
  defaultSearches: string[];
  counterparty: string;
  fundsFrom: Array<'lender' | 'client' | 'buyer_solicitor' | 'incoming_owner' | 'isa_provider'>;
  registration: 'ap1' | 'discharge_only' | 'none';
  note: string;
  lifecycle: string[];
  gates: string[];
}

export interface EngineState {
  matterId: string;
  tenantId?: string;
  enrolled: boolean;
  transactionType: TransactionType | null;
  parties?: number;
  hasExistingMortgage?: boolean;
  considerationPennies?: number | null;
  propertyForms?: { status: 'not_applicable' | 'not_started' | 'requested' | 'received'; forms: string[]; requestedAt: string | null; receivedAt: string | null; facts: Record<string, unknown> | null };
  contractPack?: { sentAt: string | null; requestedAt?: string | null };
  inboundEnquiries?: Record<string, { id: string; question: string; round: number; receivedAt: string; repliedAt: string | null }>;
  redemption?: { status: 'not_applicable' | 'not_started' | 'requested' | 'received' | 'redeemed' | 'discharged'; lender: string | null; redemptionPennies: number | null; validUntil: string | null; dailyInterestPennies: number | null; requestedAt: string | null; receivedAt: string | null; redeemedAt: string | null; dischargedAt: string | null };
  lenderConsent?: { status: 'not_applicable' | 'not_started' | 'requested' | 'received'; lender: string | null; conditions: string | null; requestedAt: string | null; receivedAt: string | null };
  deeds?: { mortgageDeedAt: string | null; certificateOfTitleAt: string | null; transferDeedAt: string | null; deedOfTrustAt: string | null };
  signing?: { packSentAt: string | null; documents: string[]; methods: Record<string, 'wet' | 'electronic'>; envelopes: Record<string, { provider: string; envelopeId: string; sentAt: string }> };
  partyNames?: string[];
  sdltNotRequiredAt?: string | null;
  hasLender: boolean;
  shapes?: string[];
  partyChecks?: Record<string, { party: string; label: string; role: 'buyer' | 'seller' | 'owner' | 'donor'; status: string; documentId: string | null }>;
  requiredSearches: string[];
  stage: string;
  stageHistory: Array<{ stage: string; at: string; seq: number }>;
  lastSeq: number;
  lastEventAt: string | null;
  manualHandling: { required: boolean; reason: string | null };
  idCheck: { status: string; requestedAt: string | null; documentId?: string | null };
  searches: Record<string, { searchType: string; status: string; orderedAt: string | null; returnedAt: string | null; flags: Array<{ code: string; severity: string; description: string }>; resolution: string | null; documentId?: string | null }>;
  enquiries: Record<string, { enquiryId: string; subject: string; origin?: { about?: string; purpose?: string } | null; status: string; raisedAt: string; repliedAt: string | null; resolution: string | null; documentId?: string | null }>;
  mortgage: { status: string; facts: { lender?: string } | null; documentId?: string | null };
  title: { status: string; facts: { titleNumber?: string; tenure?: string } | null; documentId?: string | null; lease?: { unexpiredYears?: number | null; groundRentPenniesPa?: number | null; demise?: string | null } | null; leaseDocumentId?: string | null };
  reportOnTitle: { status: string; draftId: string | null; approvedBy: string | null; sentAt: string | null; interim?: boolean; interimSentAt?: string | null };
  deposit: { received: boolean; at: string | null };
  exchange: { conditionsMet: boolean; exchangedAt: string | null; completionDate: string | null };
  sellerForms?: { receivedAt: string | null; forms: string[]; documentId: string | null; facts: unknown };
  relatedMatter?: { matterId: string; relation: 'sale' | 'purchase'; linkedAt: string } | null;
  manualSteps?: Record<string, { at: string; note: string; skipReason?: string | null }>;
  lenderRequirements?: { minUnexpiredYears: number | null; maxSearchAgeMonths: number | null; acceptsNonFamilyGift: boolean | null; requiresEws1: boolean | null; note: string | null; recordedAt: string } | null;
  preCompletion?: { insuranceConfirmedAt: string | null; insurer: string | null; prioritySearchAt: string | null; prioritySearchExpiresAt: string | null; bankruptcySearchAt: string | null };
  completion: { statementGeneratedAt: string | null; fundsRequestedAt: string | null; fundsReceivedAt: string | null; confirmedAt: string | null };
  postCompletion: { sdltSubmittedAt: string | null; ap1SubmittedAt: string | null; ap1ConfirmedAt: string | null; noticeOfAssignmentAt?: string | null };
  /** Issues layer (docs/engine-issues.md). */
  issues: Record<string, IssueRow>;
  purchasePricePennies: number | null;
  readiness: { contractApprovedAt: string | null; signedContractHeldAt: string | null; contractDocumentId?: string | null };
  requireProofOfFunds?: boolean;
  requireExchangeAuthority?: boolean;
  survey?: { status: string; plan?: { plan: 'none' | 'booked'; date: string | null; at: string } | null; reports: Array<{ eventId: string; documentId: string | null; surveyType: string; receivedAt: string; recommendations: number; furtherInvestigation: boolean; forIssueId: string | null; urgent?: number; legalPoints?: number; toInvestigate?: number; unread?: boolean }> };
  clientDecisions?: Partial<Record<string, { decision: string; at: string; by: string; note: string | null }>>;
  /** Notes and call transcripts (docs/intake.md). */
  notes?: Record<string, NoteRow>;
  closedAt?: string | null;
  proofOfFunds?: { status: 'not_started' | 'requested' | 'submitted' | 'reviewed'; requestId: string | null; requestedAt: string | null; submittedAt: string | null; documentId: string | null; decisionEventId: string | null; resolution: string | null; formUrl: string | null; channel?: string | null; sendError?: string | null; rounds: number; facts: { totalDeclaredPennies: number; requiredPennies: number | null; shortfallPennies: number | null; giftedPennies: number; sources: Array<{ kind: string; amountPennies: number }> } | null; risk?: 'standard' | 'enhanced' | null; flags?: Array<{ code: string; severity: string; description: string }>; statements?: Array<{ documentId: string; fileName: string | null; holder: string | null; from: string | null; to: string | null; transactions: number; credits: number; readable: boolean }>; queries?: Record<string, PofQueryRow>; approvedAt?: string | null };
  managementPack?: { status: string; requestedAt: string | null; documentId: string | null; decisionEventId: string | null };
  abandoned?: { at: string; reason: string; detail: string | null; stage: string } | null;
  decisions: Record<string, DecisionRow>;
  waits: WaitRow[];
  clientUpdatesSent: number;
  chasesSent: number;
  bankDetails: Record<string, BankDetailsRow>;
  payments: PaymentRow[];
  shadowMode: boolean;
  suppressed: number;
  targetCompletionDate: string | null;
  targetExchangeDate: string | null;
}

export interface NoteRow {
  id: string;
  kind: string;
  text: string;
  author: string;
  at: string;
  documentId: string | null;
  durationSeconds: number | null;
  actions: Array<{ id: string; kind: string; summary: string; quote: string; confidence: number; command: { type: string } | null }>;
  extractor: string | null;
  decisionEventId: string | null;
  status: 'proposed' | 'applied' | 'discarded' | 'no_actions';
  appliedActionIds: string[];
  refusedActions: Array<{ id: string; reason: string }>;
}

export interface CompletionField { key: string; label: string; kind: 'money' | 'date' | 'datetime' | 'text' | 'names'; required?: boolean; hint?: string }
export interface CompletionContract { label: string; documentRoles?: string[]; documentLabel?: string; documentRequired?: boolean; fields?: CompletionField[]; checklist?: Array<{ key: string; label: string }>; party?: { label: string }; effect: string }
export interface DocumentReviewSummary { pages: number; read: number; withFacts: number; unreadable: number; unattested: number; complete: boolean; facts: number; verified: number }
export interface CaseDocument {
  review?: DocumentReviewSummary | null; id: string; fileName: string | null; docType: string | null; webUrl: string | null; createdAt: string; emailFrom?: string | null; emailFromAddress?: string | null; emailSubject?: string | null }
/** The other half of the client's chain (lib/server/engine/open-case.ts chainView). */
export interface ChainView { matterId: string; relation: 'sale' | 'purchase'; matterRef: string | null; propertyAddress: string | null; readable: boolean; stage: string | null; exchangedAt: string | null; exchangeReady: boolean; holding: string[]; completionDate: string | null; targetCompletion: string | null; completedAt: string | null; abandoned: boolean }

/** A step waiting on us (lib/server/engine/due.ts). */
export interface DueStepRow { key: string; lane: string; title: string; detail?: string; dueDate?: string | null }
export interface EngineView { chain?: ChainView | null; sdlt?: { estimatePennies: number; scheme: string; basis: string; declared: boolean } | null; contracts?: Record<string, CompletionContract>; state: EngineState; profile?: ProfileView; lifecycle?: { id: string; label: string }; blockers: string[]; waits: WaitRow[]; pendingDecisions: DecisionRow[]; due?: DueStepRow[]; people?: Record<string, string>; documentCount?: number; surfacedDecisions?: DecisionRow[]; levels?: Record<string, TrustLevel>; matter?: MatterMeta | null }

export interface EngineEvent { id: string; seq: number; type: string; actor: string; payload: Record<string, unknown>; sourceDocumentId: string | null; confidenceScore: number | null; createdAt: string }

export const STAGES = ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'];

/** The short chip on a task row when the API did not send one. */
export const chipLabel = (kind: string): string => (kind === 'auto_clear' ? 'Auto-cleared' : (KIND_LABEL[kind] ?? pretty(kind)).split(' — ')[0]);
/**
 * Approvable from the row: anything the system sends or does from a standard template or a fixed action
 * (acknowledgements, updates, requests, chases, forms, the ID check, the signing pack, a search order).
 * Not what needs reading first: a document that arrived, or words a model wrote (enquiries, survey advice).
 */
const NEEDS_READING = new Set(['proposal:enquiry_draft', 'proposal:survey_advice']);
export const quickApprovable = (kind: string | null | undefined): boolean => !!kind && ((kind.startsWith('proposal:') && !NEEDS_READING.has(kind)) || kind === 'note_actions:ack');

export const KIND_LABEL: Record<string, string> = {
  issue: 'Issue',
  proposal: 'To send',
  search: 'Search result',
  enquiry: 'Enquiry reply',
  mortgage: 'Mortgage offer',
  title: 'Title register',
  id_check: 'ID / AML',
  report_on_title: 'Report on title — approve draft',
  contract: 'Contract — approve for signature',
  escalation: 'Escalation',
  bank_details: 'Bank details — verify out-of-band',
  auto_clear: 'Auto-clear review',
  requisition: 'HMLR requisition',
  proof_of_funds: 'Proof of funds — sign off',
  management_pack: 'Management pack (LPE1)',
  note_actions: 'Note or call — what to record',
};

export const VERIFICATION_METHOD_LABEL: Record<string, string> = {
  phone_callback_known_number: 'Phone call-back to a number already on file',
  lawyer_checker_match: 'Lawyer Checker (or equivalent) match — reference required',
  in_person: 'Confirmed in person',
  video_call_known_contact: 'Video call with a known contact',
};

export interface BankDetailsRow { id: string; payeeKind: string; payeeRef: string | null; details: { sortCode: string; accountNumber: string; accountName: string; firmName: string | null }; sourceChannel: string; status: string; recordedAt: string; verifiedAt: string | null; verifiedBy: string | null; verificationMethod: string | null; verificationRef: string | null; supersedesId: string | null }
export interface PaymentRow { eventId: string; payeeKind: string; bankDetailsId: string; amountPennies: number | null; purpose: string; authorisedBy: string; at: string }

/** Kind-specific wording where the generic label would mislead. */
export const OPTION_LABEL_BY_KIND: Record<string, Record<string, string>> = {
  proposal: { approve: 'Approve', reject: 'Decline' },
  proof_of_funds: { approve: 'Sign off — source of funds verified', request_further: 'Query the client (re-opens the form with the queries)' },
  management_pack: { request_further: 'Request further information from the managing agent' },
  contract: { approve: 'Approve the contract', request_further: "Send points to the seller's solicitor" },
  // Nothing on a decision is "rejected": a draft goes back for redraft, a bank-details check fails, a note's reading is discarded.
  report_on_title: { approve: 'Approve — send to the client', reject: 'Send back for redraft' },
  bank_details: { reject: 'Could not verify' },
  note_actions: { approve: 'Approve', reject: 'Decline' },
};
/** What each option does, for the button tooltip. */
export const OPTION_HELP: Record<string, string> = {
  approve: 'Records your approval. The item is treated as satisfactory and the case moves on.',
  refer_to_client: 'Records that the point goes to the client for their instructions. Needs a reason.',
  request_further: 'Raises a further search or enquiry and keeps this open until it comes back. Needs a reason.',
  escalate: 'Puts the same source in front of a senior as a new decision. Needs a reason.',
  reject: 'Needs a reason. A draft goes back for redraft; a bank-details check is recorded as failed (the hard stop stays); a proposal is declined and not performed.',
  verify: 'Records that the bank details were verified out of band, by the method you choose.',
  indemnity: 'Records that the risk is covered by an indemnity policy rather than resolved.',
};
export const OPTION_LABEL: Record<string, string> = {
  approve: 'Approve — Proceed As Standard',
  refer_to_client: 'Refer To Client',
  request_further: 'Request Further Search / Enquiry',
  escalate: 'Escalate To Senior',
  reject: 'Reject',
  verify: 'Verified Out-Of-Band',
  indemnity: 'Cover With An Indemnity Policy',
};

export const pretty = (s: string) => s.replace(/_/g, ' ');
// ── Caseload map + work list (docs/caseload-ux.md) ──────────────────────────
export type HealthBand = 'normal' | 'attention' | 'delayed' | 'blocked' | 'critical';
export const HEALTH_BANDS: HealthBand[] = ['normal', 'attention', 'delayed', 'blocked', 'critical'];
/** Green nothing waiting on us · blue waiting on us, on time · yellow others late · red we are late · black both, or in jeopardy. */
export const HEALTH_LABEL: Record<HealthBand, string> = { normal: 'On Track', attention: 'With Us', delayed: 'Delayed - Others', blocked: 'Delayed - Us', critical: 'Critical' };

export interface HealthReason {
  code: string;
  band: HealthBand;
  headline: string;
  why: string[];
  suggested: string | null;
  workstream: string | null;
  ref: { type: string; id: string };
  ageWorkingDays?: number;
  dueInWorkingDays?: number;
}
export interface CasePace { stage: string; inStage: number; expected: number; overrun: number }
export interface HealthCounts { waiting: number; chasesDue: number; blockingIssues: number; openIssues: number; decisions: number; deadlines: number }
export interface HealthSummary { band: HealthBand; headline: string | null; why: string[]; suggested: string | null; reasonCount: number; counts: HealthCounts; pace: CasePace }
export interface CaseHealth { band: HealthBand; reasons: HealthReason[]; pace: CasePace; counts: HealthCounts }

/** One matter on the caseload map. */
export interface CaseToken extends QueueRow {
  lifecycle: string;
  health: HealthSummary;
  dayOfCase: number;
  /** false = an open matter the engine is not running yet. It has no health to report. */
  tracked?: boolean;
  assignedToName?: string | null;
}
export interface CaseloadRollup { total: number; normal: number; attention: number; delayed: number; blocked: number; critical: number; stuck: number; needsSomeone: number; untracked?: number }

export type WorkBucket = 'do' | 'waiting' | 'escalate';
export interface WorkItem {
  needsAddress?: { role: string; who: string } | null;
  /** The case's health band (its colour), set on the Tasks list. */
  caseBand?: HealthBand;
  /** Set on the Tasks list: an assistant may do this one (else it is for a conveyancer). */
  assistantCan?: boolean;
  /** A locked file's task: the document its password opens. */
  documentId?: string | null;
  id: string;
  bucket: WorkBucket;
  matterId: string;
  matterRef: string | null;
  propertyAddress: string | null;
  /** The firm's clients on the matter. */
  clients?: string[];
  what: string;
  unblocks: string | null;
  actionOwner: string;
  responsibilityOwner: string | null;
  urgency: HealthBand;
  workstream: string | null;
  since: string | null;
  sinceWorkingDays: number | null;
  /** WAITING: who asked — a person's name once the API has resolved it, or system / ai / external. */
  openedBy?: string | null;
  /** The kind of thing it is (a decision kind, `proposal:<what it would send>`, or issue / wait). */
  kind?: string;
  /** The chip on the list, in words. */
  chip?: string;
  /** An issue's severity: its chip is red / amber / green. */
  severity?: 'info' | 'warning' | 'critical';
  slaWorkingDays: number | null;
  chaseInWorkingDays: number | null;
  chasesSent: number;
  mode: 'automatic' | 'needs_approval' | null;
  escalatesInWorkingDays: number | null;
  escalated: boolean;
  dueBy?: string | null;
  chaseDue?: boolean;
  ref: { type: string; id: string };
}

/** A stage's label for a given profile (the machine's phase names read differently on a sale or a remortgage). */
export const stageLabel = (stage: string, profile?: ProfileView | null): string => profile?.stageLabels?.[stage] ?? STAGE_LABEL[stage] ?? stage;
export const LIFECYCLE_LABEL: Record<string, string> = { instructed: 'Instructed', pre_exchange: 'Pre-Exchange', ready_to_exchange: 'Ready To Exchange', exchanged: 'Exchanged', pre_completion: 'Pre-Completion', investigating: 'Investigating', ready_to_complete: 'Ready To Complete', completed: 'Completed', post_completion: 'Post-Completion', closed: 'Closed', aborted: 'Aborted' };
export const STAGE_LABEL: Record<string, string> = { instruction: 'Instruction', pre_contract: 'Pre-Contract', contract_review: 'Contract Review', pre_exchange: 'Pre-Exchange', exchanged: 'Exchanged', pre_completion: 'Pre-Completion', completed: 'Completed', post_completion: 'Post-Completion' };
export const ago = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};
export const actorKind = (a: string) => (a === 'system' || a === 'ai' || a === 'external' ? a : 'person');
export const fmtWhen = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
