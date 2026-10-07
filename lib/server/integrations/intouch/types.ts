/**
 * InTouch — the normalised shapes we work with (docs/intouch-integration.md).
 *
 * InTouch is the CLIENT-facing half of a conveyancing firm's stack: the onboarding pack,
 * identity and source-of-funds checks, the property information forms the seller fills in
 * online, and the portal where the client and the estate agent watch the case move.
 *
 * What that makes it, for CONVEYi:
 *   • an INTAKE — a new instruction is a new matter;
 *   • a source of FACTS a client produced (an ID result, a completed TA6, an upload);
 *   • a DESTINATION for the truth — the engine knows where a case really is, and the
 *     client portal should say the same thing without anyone retyping it.
 *
 * It is never a source of decisions. Nothing InTouch sends changes the case by itself:
 * facts go through the engine's ordinary front door and are gated like any other.
 *
 * These are OUR shapes. InTouch's raw JSON becomes them in mapping.ts — the single seam
 * that changes when a field name in the real reference differs from what we assumed.
 */
import type { InTouchMilestone } from './endpoints';

export interface InTouchAccount {
  id: string;
  /** The firm as InTouch knows it. */
  name: string;
  reference: string | null;
}

export type InTouchCaseStatus = 'quote' | 'instructed' | 'active' | 'completed' | 'cancelled' | 'unknown';
export type InTouchTransactionSide = 'purchase' | 'sale' | 'remortgage' | 'transfer' | 'unknown';

export interface InTouchCase {
  id: string;
  /** InTouch's own case reference, shown to the client. */
  reference: string;
  status: InTouchCaseStatus;
  side: InTouchTransactionSide;
  tenure: 'freehold' | 'leasehold' | 'unknown';
  propertyAddress: string | null;
  postcode: string | null;
  pricePennies: number | null;
  /** The firm's fee earner, when InTouch carries one. */
  feeEarner: { id: string | null; name: string | null; email: string | null } | null;
  /** The firm's own matter reference, where the firm typed it into InTouch. */
  firmReference: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Anything we did not model, kept so the mapping seam never loses data. */
  fields: Record<string, unknown>;
}

export type InTouchPartyRole = 'client' | 'joint_client' | 'other_side' | 'other_side_solicitor' | 'estate_agent' | 'broker' | 'lender' | 'other';

export interface InTouchParty {
  id: string;
  caseId: string;
  role: InTouchPartyRole;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  isCompany: boolean;
}

/** A task on an InTouch matter. Completing the right one is how the client portal moves. */
export interface InTouchTask {
  id: string;
  name: string;
  completed: boolean;
}

export interface InTouchDocument {
  id: string;
  caseId: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** InTouch's own category (onboarding pack, id report, form, client upload…). */
  category: string | null;
  uploadedBy: 'client' | 'firm' | 'intouch' | 'unknown';
  createdAt: string | null;
}

export interface InTouchMilestoneUpdate {
  milestone: InTouchMilestone;
  /** One line for the client. Written by us, in the client register — never internal wording. */
  note?: string | null;
  at?: string | null;
}

export interface InTouchListOptions {
  /** The page to read (InTouch pages from 1), as a string so it rides the sync's cursor. */
  cursor?: string | null;
  limit?: number;
  /** Only things changed since this ISO timestamp — the incremental sync's watermark. InTouch has no
   *  such filter: the list is read newest-changed first and stops at the first older matter. */
  updatedSince?: string | null;
}

export interface InTouchPage<T> {
  items: T[];
  next: string | null;
}

export interface InTouchWebhookEvent {
  /** sha256 of the raw body: InTouch sends no delivery id, and its retries repeat the body. */
  id: string | null;
  /** Normalised: 'form_completion' | 'matter_state_change' | 'task_state_change' | anything else InTouch adds. */
  type: string;
  /** Not documented in the payload; read defensively from `data` when InTouch does include it. */
  caseId: string | null;
  /** The resource the event points AT. We re-read it; we never trust the body. */
  resourceId: string | null;
  /** The envelope's flat "triggered.by.email" — the fallback for finding the case. */
  triggeredByEmail: string | null;
  /** The envelope's `timestamp` (UTC ISO 8601). */
  occurredAt: string | null;
  receivedAt: string;
  raw: Record<string, unknown>;
}

export type InTouchConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

export interface InTouchConnectionRow {
  tenantId: string;
  accountId: string | null;
  accountName: string | null;
  status: InTouchConnectionStatus;
  statusDetail: string | null;
  /** The per-firm URL the admin pastes into InTouch (API Management > Webhooks). Null until credentials are saved. */
  webhookUrl: string | null;
  lastSyncAt: string | null;
  lastSyncDetail: InTouchSyncSummary | null;
  connectedAt: string | null;
  /** Whether milestones are pushed back to the client portal. Off until the firm says so. */
  milestonesEnabled: boolean;
  /** Write-back switches (writeback.ts): documents and case notes into InTouch. */
  documentsWriteback?: boolean;
  notesWriteback?: boolean;
}

export interface InTouchSyncSummary {
  cases: number;
  created: number;
  parties: number;
  documents: number;
  milestones: number;
  /** Written back to InTouch (when the firm has it on). */
  documentsOut?: number;
  notesOut?: number;
  skipped: number;
  errors: string[];
}

export class InTouchError extends Error {
  constructor(message: string, readonly status = 0, readonly retryable = false) {
    super(message);
    this.name = 'InTouchError';
  }
}
