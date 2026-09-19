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
  matterRef: string | null;
  propertyAddress: string | null;
  stage: string;
  shadowMode: boolean;
  assignedTo: string | null;
  pendingCount: number;
  reviewCount: number;
  loggedCount: number;
  oldestPendingAt: string | null;
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
}

export type SubflowStatus = 'shadow' | 'assist' | 'autonomous';
export const SUB_FLOWS = ['id_check', 'search', 'enquiry', 'mortgage', 'title', 'report_on_title', 'chase'] as const;
export const SUBFLOW_LABEL: Record<string, string> = { id_check: 'ID / AML', search: 'Searches', enquiry: 'Enquiries', mortgage: 'Mortgage offer', title: 'Title', report_on_title: 'Report on title', chase: 'Chasing & escalation' };

/** Event types that carry a DecisionSpec (mirrors the server's DECISION_EVENT_TYPES). */
export const DECISION_EVENT_TYPES = new Set(['id_check_flagged', 'search_flagged', 'enquiry_reply_flagged', 'mortgage_condition_flagged', 'title_flagged', 'report_on_title_drafted', 'escalation_raised', 'bank_details_change_flagged', 'auto_clear_review_raised']);

export interface SourceDoc { id: string; fileName: string | null; webUrl: string | null; docType: string | null; content: string | null; rawUrl?: string | null }

export interface WaitRow { key: string; subject: string; openedAt: string; closedAt: string | null; chasesSentAt: string[]; escalations: Array<{ eventId: string; raisedAt: string; resolvedAt: string | null }> }

export interface EngineState {
  enrolled: boolean;
  transactionType: string | null;
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
  postCompletion: { sdltSubmittedAt: string | null; ap1SubmittedAt: string | null; ap1ConfirmedAt: string | null };
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

export interface EngineView { state: EngineState; blockers: string[]; waits: WaitRow[]; pendingDecisions: DecisionRow[]; surfacedDecisions?: DecisionRow[]; subflows?: Record<string, SubflowStatus>; matter?: MatterMeta | null }

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
};

export const VERIFICATION_METHOD_LABEL: Record<string, string> = {
  phone_callback_known_number: 'Phone call-back to a number already on file',
  lawyer_checker_match: 'Lawyer Checker (or equivalent) match — reference required',
  in_person: 'Confirmed in person',
  video_call_known_contact: 'Video call with a known contact',
};

export interface BankDetailsRow { id: string; payeeKind: string; payeeRef: string | null; details: { sortCode: string; accountNumber: string; accountName: string; firmName: string | null }; sourceChannel: string; status: string; recordedAt: string; verifiedAt: string | null; verifiedBy: string | null; verificationMethod: string | null; verificationRef: string | null; supersedesId: string | null }
export interface PaymentRow { eventId: string; payeeKind: string; bankDetailsId: string; amountPennies: number | null; purpose: string; authorisedBy: string; at: string }

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
