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
  sourceOpenedByMe?: boolean;
}

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
}

export interface EngineView { state: EngineState; blockers: string[]; waits: WaitRow[]; pendingDecisions: DecisionRow[] }

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
};

export const OPTION_LABEL: Record<string, string> = {
  approve: 'Approve — proceed as standard',
  refer_to_client: 'Refer to client',
  request_further: 'Request further search / enquiry',
  escalate: 'Escalate to senior',
  reject: 'Reject',
};

export const pretty = (s: string) => s.replace(/_/g, ' ');
export const fmtWhen = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
