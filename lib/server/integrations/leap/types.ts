/**
 * LEAP as the backend — the normalised shapes we work with.
 *
 * LEAP (leap.build) is the firm's practice management system: matters, cards
 * (contacts/parties), documents, tasks, file notes, calendar, accounting. In the
 * LEAP-backed deployment it is the source of truth for all of that; CONVEYi keeps the
 * proprietary spine — the event log, the machine, the rule layer, the decisions — and
 * treats LEAP as where matters and documents live.
 *
 * These are OUR shapes. LEAP's raw JSON is turned into them in mapping.ts (the single
 * seam that changes when a field name in LEAP's reference differs from what we assumed).
 */

export type LeapRegion = 'uk' | 'au' | 'us' | 'ca' | 'nz' | 'ie';

export interface LeapFirm {
  id: string;
  name: string;
  region: LeapRegion | null;
}

export interface LeapMatterType {
  id: string;
  name: string;
  /** LEAP groups matter types by area of law, e.g. "Conveyancing". */
  areaOfLaw: string | null;
}

export type LeapMatterStatus = 'open' | 'closed' | 'archived' | 'unknown';

export interface LeapMatter {
  id: string;
  /** The firm's own matter number as shown in LEAP (our `matter.firm_ref`). */
  number: string;
  description: string;
  status: LeapMatterStatus;
  matterType: LeapMatterType | null;
  /** The person responsible in LEAP (staff id + display name) — our assigned handler. */
  responsibleStaff: { id: string; name: string; email: string | null } | null;
  /** Property address for conveyancing matters (LEAP keeps it in matter details / tables). */
  propertyAddress: string | null;
  /** Key dates LEAP conveyancing matters carry. */
  exchangeDate: string | null;
  completionDate: string | null;
  purchasePrice: string | null;
  /** Any custom / matter-type-specific fields we did not model, kept for the mapping seam. */
  fields: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

/** LEAP's "card" = a person or organisation; a matter links cards with a role. */
export type LeapPartyRole = 'client' | 'other_side' | 'other_side_solicitor' | 'agent' | 'lender' | 'lender_solicitor' | 'our_firm' | 'other';

export interface LeapCard {
  id: string;
  type: 'person' | 'company' | 'unknown';
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  organisation: string | null;
}

export interface LeapMatterParty {
  card: LeapCard;
  role: LeapPartyRole;
  /** LEAP's own role label before we normalised it (kept for audit / mapping fixes). */
  rawRole: string;
}

export interface LeapDocument {
  id: string;
  matterId: string;
  name: string;
  /** e.g. "pdf", "docx" — LEAP's file extension / type. */
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** LEAP folder path inside the matter (e.g. "Searches"). */
  folder: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Who filed it in LEAP (staff) — null for documents that arrived through an integration. */
  createdBy: string | null;
  /** LEAP's own document type / precedent category, if present. */
  category: string | null;
}

export interface LeapTask {
  id: string;
  matterId: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  completed: boolean;
  assigneeStaffId: string | null;
  /** Our tag so we can find tasks we created (put in the description when LEAP has no external-ref field). */
  externalRef: string | null;
}

export interface LeapNote {
  id: string;
  matterId: string;
  body: string;
  createdAt: string;
  createdBy: string | null;
}

export type LeapWebhookEventType =
  | 'matter.created'
  | 'matter.updated'
  | 'matter.closed'
  | 'document.created'
  | 'document.updated'
  | 'card.updated'
  | 'task.updated'
  | 'unknown';

export interface LeapWebhookEvent {
  /** Provider event/delivery id (for idempotency); a body hash when LEAP supplies none. */
  id: string;
  type: LeapWebhookEventType;
  firmId: string | null;
  matterId: string | null;
  documentId: string | null;
  cardId: string | null;
  taskId: string | null;
  occurredAt: string | null;
  raw: unknown;
}

/** One paged read from LEAP. */
export interface LeapPage<T> {
  items: T[];
  /** Opaque cursor / next offset; null when this was the last page. */
  next: string | null;
}

export interface LeapListOptions {
  updatedSince?: string | null;
  cursor?: string | null;
  limit?: number;
}

/** OAuth tokens for one firm's connection (stored encrypted, see adapters.ts). */
export interface LeapTokens {
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms */
  expiresAt: number;
  scope: string | null;
}

export class LeapError extends Error {
  constructor(message: string, public status: number, public retryable = false, public detail?: unknown) {
    super(message);
    this.name = 'LeapError';
  }
}
