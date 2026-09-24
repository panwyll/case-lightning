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
}

export interface MatterMeta { matterRef: string; propertyAddress: string; legacyStage?: string | null; shadowMode: boolean; assignedTo?: string | null; handler?: string | null }

export interface DecisionDetail {
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
}

export interface NoteActionsDetail {
  noteId: string;
  noteKind: string;
  actions: NoteActionView[];
  /** Set once resolved: what actually landed, and anything the machine then refused. */
  applied: string[] | null;
  skipped: string[] | null;
  refused: Array<{ id: string; reason: string }>;
}

export type SubflowStatus = 'shadow' | 'assist' | 'autonomous';
export const SUB_FLOWS = ['id_check', 'search', 'enquiry', 'mortgage', 'title', 'report_on_title', 'chase'] as const;
export const SUBFLOW_LABEL: Record<string, string> = { id_check: 'ID / AML', search: 'Searches', enquiry: 'Enquiries', mortgage: 'Mortgage offer', title: 'Title', report_on_title: 'Report on title', chase: 'Chasing & escalation' };

/** Event types that carry a DecisionSpec (mirrors the server's DECISION_EVENT_TYPES). */
export const DECISION_EVENT_TYPES = new Set(['id_check_flagged', 'search_flagged', 'enquiry_reply_flagged', 'mortgage_condition_flagged', 'title_flagged', 'report_on_title_drafted', 'escalation_raised', 'bank_details_change_flagged', 'auto_clear_review_raised', 'note_extracted']);

export interface SourceDoc { id: string; fileName: string | null; webUrl: string | null; docType: string | null; content: string | null; rawUrl?: string | null }

export interface WaitRow { key: string; subject: string; openedAt: string; closedAt: string | null; chasesSentAt: string[]; escalations: Array<{ eventId: string; raisedAt: string; resolvedAt: string | null }> }

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
}

/** The issue catalogue as /engine/spec publishes it (kinds, groups, resolutions). */
export interface IssueCatalogue {
  groups: Array<{ id: string; label: string }>;
  kinds: Array<{ kind: string; group: string; label: string; arisesFrom: string; gate: 'exchange' | 'completion' | 'none'; stages: string[]; resolutions: string[]; note: string; overlaps?: string }>;
  resolutions: Array<{ id: string; label: string; effects: string[] }>;
  staleAfterWorkingDays: number;
}

export type TransactionType = 'freehold_purchase' | 'leasehold_purchase' | 'freehold_sale' | 'leasehold_sale' | 'remortgage' | 'transfer_of_equity';
export const TRANSACTION_TYPES: TransactionType[] = ['freehold_purchase', 'leasehold_purchase', 'freehold_sale', 'leasehold_sale', 'remortgage', 'transfer_of_equity'];
export const TRANSACTION_LABEL: Record<TransactionType, string> = { freehold_purchase: 'Freehold purchase', leasehold_purchase: 'Leasehold purchase', freehold_sale: 'Freehold sale', leasehold_sale: 'Leasehold sale', remortgage: 'Remortgage', transfer_of_equity: 'Transfer of equity' };

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
  fundsFrom: Array<'lender' | 'client' | 'buyer_solicitor' | 'incoming_owner'>;
  registration: 'ap1' | 'discharge_only' | 'none';
  note: string;
  lifecycle: string[];
  gates: string[];
}

export interface EngineState {
  enrolled: boolean;
  transactionType: TransactionType | null;
  parties?: number;
  hasExistingMortgage?: boolean;
  considerationPennies?: number | null;
  propertyForms?: { status: 'not_applicable' | 'not_started' | 'requested' | 'received'; forms: string[]; requestedAt: string | null; receivedAt: string | null; facts: Record<string, unknown> | null };
  contractPack?: { sentAt: string | null };
  inboundEnquiries?: Record<string, { id: string; question: string; round: number; receivedAt: string; repliedAt: string | null }>;
  redemption?: { status: 'not_applicable' | 'not_started' | 'requested' | 'received' | 'redeemed' | 'discharged'; lender: string | null; redemptionPennies: number | null; validUntil: string | null; dailyInterestPennies: number | null; requestedAt: string | null; receivedAt: string | null; redeemedAt: string | null; dischargedAt: string | null };
  lenderConsent?: { status: 'not_applicable' | 'not_started' | 'requested' | 'received'; lender: string | null; conditions: string | null; requestedAt: string | null; receivedAt: string | null };
  deeds?: { mortgageDeedAt: string | null; certificateOfTitleAt: string | null; transferDeedAt: string | null; deedOfTrustAt: string | null };
  sdltNotRequiredAt?: string | null;
  hasLender: boolean;
  requiredSearches: string[];
  stage: string;
  stageHistory: Array<{ stage: string; at: string; seq: number }>;
  lastSeq: number;
  lastEventAt: string | null;
  manualHandling: { required: boolean; reason: string | null };
  idCheck: { status: string; requestedAt: string | null };
  searches: Record<string, { searchType: string; status: string; orderedAt: string | null; returnedAt: string | null; flags: Array<{ code: string; severity: string; description: string }>; resolution: string | null }>;
  enquiries: Record<string, { enquiryId: string; subject: string; status: string; raisedAt: string; repliedAt: string | null; resolution: string | null }>;
  mortgage: { status: string; facts: { lender?: string } | null };
  title: { status: string; facts: { titleNumber?: string; tenure?: string } | null };
  reportOnTitle: { status: string; draftId: string | null; approvedBy: string | null; sentAt: string | null };
  deposit: { received: boolean; at: string | null };
  exchange: { conditionsMet: boolean; exchangedAt: string | null; completionDate: string | null };
  completion: { statementGeneratedAt: string | null; fundsRequestedAt: string | null; fundsReceivedAt: string | null; confirmedAt: string | null };
  postCompletion: { sdltSubmittedAt: string | null; ap1SubmittedAt: string | null; ap1ConfirmedAt: string | null; noticeOfAssignmentAt?: string | null };
  /** Issues layer (docs/engine-issues.md). */
  issues: Record<string, IssueRow>;
  purchasePricePennies: number | null;
  readiness: { contractApprovedAt: string | null; signedContractHeldAt: string | null };
  requireProofOfFunds?: boolean;
  requireExchangeAuthority?: boolean;
  survey?: { status: string; reports: Array<{ eventId: string; documentId: string | null; surveyType: string; receivedAt: string; recommendations: number; furtherInvestigation: boolean; forIssueId: string | null }> };
  clientDecisions?: Partial<Record<string, { decision: string; at: string; by: string; note: string | null }>>;
  /** Notes and call transcripts (docs/intake.md). */
  notes?: Record<string, NoteRow>;
  closedAt?: string | null;
  proofOfFunds?: { status: 'not_started' | 'requested' | 'submitted' | 'reviewed'; requestId: string | null; requestedAt: string | null; submittedAt: string | null; documentId: string | null; decisionEventId: string | null; resolution: string | null; formUrl: string | null; rounds: number; facts: { totalDeclaredPennies: number; requiredPennies: number | null; shortfallPennies: number | null; giftedPennies: number; sources: Array<{ kind: string; amountPennies: number }> } | null; risk?: 'standard' | 'enhanced' | null; flags?: Array<{ code: string; severity: string; description: string }>; statements?: Array<{ documentId: string; fileName: string | null; holder: string | null; from: string | null; to: string | null; transactions: number; credits: number; readable: boolean }>; queries?: Record<string, PofQueryRow>; approvedAt?: string | null };
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

export interface EngineView { state: EngineState; profile?: ProfileView; lifecycle?: { id: string; label: string }; blockers: string[]; waits: WaitRow[]; pendingDecisions: DecisionRow[]; surfacedDecisions?: DecisionRow[]; subflows?: Record<string, SubflowStatus>; matter?: MatterMeta | null }

export interface EngineEvent { id: string; seq: number; type: string; actor: string; payload: Record<string, unknown>; sourceDocumentId: string | null; confidenceScore: number | null; createdAt: string }

export const STAGES = ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'];

export const KIND_LABEL: Record<string, string> = {
  search: 'Search result',
  enquiry: 'Enquiry reply',
  mortgage: 'Mortgage offer',
  title: 'Title register',
  id_check: 'ID / AML',
  report_on_title: 'Report on title — approve draft',
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
  proof_of_funds: { approve: 'Sign off — source of funds verified', request_further: 'Query the client (re-opens the form with the queries)', reject: 'Reject — stop automation (consider a report)' },
  management_pack: { request_further: 'Request further information from the managing agent' },
};
export const OPTION_LABEL: Record<string, string> = {
  approve: 'Approve — proceed as standard',
  refer_to_client: 'Refer to client',
  request_further: 'Request further search / enquiry',
  escalate: 'Escalate to senior',
  reject: 'Reject',
  verify: 'Verified out-of-band',
  indemnity: 'Cover with an indemnity policy',
};

export const pretty = (s: string) => s.replace(/_/g, ' ');
// ── Caseload map + work list (docs/caseload-ux.md) ──────────────────────────
export type HealthBand = 'normal' | 'attention' | 'delayed' | 'blocked' | 'critical';
export const HEALTH_BANDS: HealthBand[] = ['normal', 'attention', 'delayed', 'blocked', 'critical'];
export const HEALTH_LABEL: Record<HealthBand, string> = { normal: 'On track', attention: 'Needs attention', delayed: 'Delayed', blocked: 'Blocked', critical: 'Critical' };

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
}
export interface CaseloadRollup { total: number; normal: number; attention: number; delayed: number; blocked: number; critical: number; stuck: number; needsSomeone: number; untracked?: number }

export type WorkBucket = 'do' | 'waiting' | 'escalate';
export interface WorkItem {
  id: string;
  bucket: WorkBucket;
  matterId: string;
  matterRef: string | null;
  propertyAddress: string | null;
  what: string;
  unblocks: string | null;
  actionOwner: string;
  responsibilityOwner: string | null;
  urgency: HealthBand;
  workstream: string | null;
  since: string | null;
  sinceWorkingDays: number | null;
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
export const LIFECYCLE_LABEL: Record<string, string> = { instructed: 'Instructed', pre_exchange: 'Pre-exchange', ready_to_exchange: 'Ready to exchange', exchanged: 'Exchanged', pre_completion: 'Pre-completion', investigating: 'Investigating', ready_to_complete: 'Ready to complete', completed: 'Completed', post_completion: 'Post-completion', closed: 'Closed', aborted: 'Aborted' };
export const STAGE_LABEL: Record<string, string> = { instruction: 'Instruction', pre_contract: 'Pre-contract', contract_review: 'Contract review', pre_exchange: 'Pre-exchange', exchanged: 'Exchanged', pre_completion: 'Pre-completion', completed: 'Completed', post_completion: 'Post-completion' };
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
