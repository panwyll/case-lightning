/**
 * The mapping seam: InTouch's raw JSON → our normalised shapes (types.ts), our domain →
 * what we send back, and the engine's lifecycle → the milestone a client understands.
 *
 * Field names are read defensively (several candidate keys, case-insensitive) because the
 * reference could not be read from the build environment: when a real payload disagrees,
 * fix the candidate list here and nothing else moves.
 *
 * Everything here is pure and unit-tested against fixtures.
 */
import { INTOUCH_FORM_CODES, type InTouchMilestone } from './endpoints';
import type { InTouchAccount, InTouchCase, InTouchCaseStatus, InTouchDocument, InTouchForm, InTouchIdentityCheck, InTouchIdOutcome, InTouchParty, InTouchPartyRole, InTouchTransactionSide, InTouchWebhookEvent } from './types';

type Raw = Record<string, unknown>;

/** Case-insensitive, dotted-path tolerant pick of the first present candidate key. */
export function pick(raw: unknown, keys: string[]): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  for (const key of keys) {
    const parts = key.split('.');
    let cur: unknown = raw;
    for (const part of parts) {
      if (!cur || typeof cur !== 'object') {
        cur = undefined;
        break;
      }
      const obj = cur as Raw;
      const found = Object.keys(obj).find((k) => k.toLowerCase() === part.toLowerCase());
      cur = found === undefined ? undefined : obj[found];
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1' || v === 'yes';
const iso = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};
const norm = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[\s-]+/g, '_');

/** Money arrives as "£425,000", "425000", 425000 or { amount, currency }. Pennies or null. */
export function toPennies(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object') return toPennies(pick(v, ['amount', 'value', 'pennies', 'gross']));
  const s = String(v).replace(/[£,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  // A whole-pound figure is far more likely than a fractional-penny one; a value with
  // decimals is pounds-and-pence. Either way the engine wants pennies.
  return Math.round(s.includes('.') ? n * 100 : n * 100);
}

export function toAccount(raw: unknown): InTouchAccount {
  return {
    id: str(pick(raw, ['id', 'accountId', 'organisationId', 'firmId'])) ?? '',
    name: str(pick(raw, ['name', 'accountName', 'organisationName', 'firmName'])) ?? 'InTouch account',
    reference: str(pick(raw, ['reference', 'ref', 'code'])),
  };
}

const CASE_STATUS: Record<string, InTouchCaseStatus> = {
  quote: 'quote', quoted: 'quote', lead: 'quote', enquiry: 'quote',
  instructed: 'instructed', instruction: 'instructed', onboarding: 'instructed', new: 'instructed',
  active: 'active', open: 'active', in_progress: 'active', live: 'active',
  completed: 'completed', complete: 'completed', closed: 'completed', exchanged: 'active',
  cancelled: 'cancelled', canceled: 'cancelled', aborted: 'cancelled', withdrawn: 'cancelled', abandoned: 'cancelled',
};

const SIDE: Record<string, InTouchTransactionSide> = {
  purchase: 'purchase', buying: 'purchase', buyer: 'purchase', buy: 'purchase',
  sale: 'sale', selling: 'sale', seller: 'sale', sell: 'sale', vendor: 'sale',
  remortgage: 'remortgage', refinance: 'remortgage',
  transfer: 'transfer', transfer_of_equity: 'transfer', toe: 'transfer',
};

export function toCase(raw: unknown): InTouchCase {
  const known = new Set(['id', 'caseid', 'reference', 'ref', 'status', 'state', 'type', 'casetype', 'transactiontype', 'side', 'tenure', 'address', 'propertyaddress', 'postcode', 'price', 'purchaseprice', 'saleprice', 'feeearner', 'assignedto', 'firmreference', 'matterreference', 'createdat', 'created', 'updatedat', 'updated']);
  const fields: Raw = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Raw)) if (!known.has(k.toLowerCase())) fields[k] = v;
  const fe = pick(raw, ['feeEarner', 'assignedTo', 'handler', 'conveyancer']);
  return {
    id: str(pick(raw, ['id', 'caseId', 'caseID'])) ?? '',
    reference: str(pick(raw, ['reference', 'ref', 'caseReference', 'caseRef'])) ?? '',
    status: CASE_STATUS[norm(pick(raw, ['status', 'state', 'caseStatus']))] ?? 'unknown',
    side: SIDE[norm(pick(raw, ['side', 'type', 'caseType', 'transactionType', 'matterType']))] ?? 'unknown',
    tenure: ((): 'freehold' | 'leasehold' | 'unknown' => {
      const t = norm(pick(raw, ['tenure', 'propertyTenure']));
      return t === 'freehold' || t === 'leasehold' ? t : 'unknown';
    })(),
    propertyAddress: str(pick(raw, ['propertyAddress', 'address', 'property.address', 'property.addressLine'])),
    postcode: str(pick(raw, ['postcode', 'property.postcode', 'postCode'])),
    pricePennies: toPennies(pick(raw, ['pricePennies', 'price', 'purchasePrice', 'salePrice', 'property.price', 'consideration'])),
    feeEarner: fe ? { id: str(pick(fe, ['id', 'staffId', 'userId'])), name: str(pick(fe, ['name', 'displayName', 'fullName'])), email: str(pick(fe, ['email', 'emailAddress'])) } : null,
    firmReference: str(pick(raw, ['firmReference', 'matterReference', 'externalReference', 'yourRef'])),
    createdAt: iso(pick(raw, ['createdAt', 'created', 'createdDate'])),
    updatedAt: iso(pick(raw, ['updatedAt', 'updated', 'modifiedAt', 'lastModified'])),
    fields,
  };
}

const ROLE: Record<string, InTouchPartyRole> = {
  client: 'client', buyer: 'client', seller: 'client', customer: 'client', applicant: 'client',
  joint_client: 'joint_client', joint_buyer: 'joint_client', joint_seller: 'joint_client', second_client: 'joint_client',
  other_side: 'other_side', counterparty: 'other_side',
  other_side_solicitor: 'other_side_solicitor', other_solicitor: 'other_side_solicitor', opposing_solicitor: 'other_side_solicitor', their_solicitor: 'other_side_solicitor',
  estate_agent: 'estate_agent', agent: 'estate_agent',
  broker: 'broker', mortgage_broker: 'broker', ifa: 'broker',
  lender: 'lender', mortgagee: 'lender',
};

export function toParty(raw: unknown, caseId: string): InTouchParty {
  const first = str(pick(raw, ['firstName', 'forename', 'givenName']));
  const last = str(pick(raw, ['lastName', 'surname', 'familyName']));
  const company = str(pick(raw, ['company', 'companyName', 'organisation', 'firm']));
  return {
    id: str(pick(raw, ['id', 'partyId', 'contactId'])) ?? '',
    caseId,
    role: ROLE[norm(pick(raw, ['role', 'type', 'partyRole', 'relationship']))] ?? 'other',
    name: str(pick(raw, ['name', 'fullName', 'displayName'])) ?? ([first, last].filter(Boolean).join(' ') || company || 'Unnamed'),
    firstName: first,
    lastName: last,
    email: str(pick(raw, ['email', 'emailAddress'])),
    phone: str(pick(raw, ['phone', 'mobile', 'telephone', 'phoneNumber'])),
    company,
    isCompany: bool(pick(raw, ['isCompany', 'isOrganisation'])) || (!first && !last && !!company),
  };
}

const OUTCOME: Record<string, InTouchIdOutcome> = {
  clear: 'clear', pass: 'clear', passed: 'clear', verified: 'clear', success: 'clear', ok: 'clear',
  refer: 'refer', referred: 'refer', review: 'refer', manual_review: 'refer', caution: 'refer',
  fail: 'fail', failed: 'fail', rejected: 'fail', declined: 'fail',
  pending: 'pending', in_progress: 'pending', awaiting: 'pending', requested: 'pending', sent: 'pending',
};

const SEVERITY = (v: unknown): 'info' | 'low' | 'medium' | 'high' => {
  const s = norm(v);
  return s === 'high' || s === 'critical' || s === 'severe' ? 'high' : s === 'medium' || s === 'moderate' ? 'medium' : s === 'low' ? 'low' : 'info';
};

export function toIdentityCheck(raw: unknown, caseId: string): InTouchIdentityCheck {
  const rawFlags = pick(raw, ['flags', 'alerts', 'warnings', 'matches', 'issues']);
  const flags = Array.isArray(rawFlags)
    ? rawFlags.map((f) => ({
        code: (str(pick(f, ['code', 'type', 'id'])) ?? 'FLAG').toUpperCase().replace(/[^A-Z0-9_]+/g, '_'),
        severity: SEVERITY(pick(f, ['severity', 'level', 'risk'])),
        description: str(pick(f, ['description', 'message', 'detail', 'text'])) ?? 'Flagged by the identity check',
      }))
    : [];
  const party = pick(raw, ['party', 'subject', 'person']);
  return {
    id: str(pick(raw, ['id', 'checkId', 'identityCheckId'])) ?? '',
    caseId,
    partyId: str(pick(raw, ['partyId', 'subjectId'])) ?? str(pick(party, ['id'])),
    partyName: str(pick(raw, ['partyName', 'subjectName'])) ?? str(pick(party, ['name', 'fullName'])),
    outcome: OUTCOME[norm(pick(raw, ['outcome', 'result', 'status', 'decision']))] ?? 'unknown',
    provider: str(pick(raw, ['provider', 'bureau', 'source', 'vendor'])),
    completedAt: iso(pick(raw, ['completedAt', 'completed', 'finishedAt', 'updatedAt'])),
    flags,
    documentId: str(pick(raw, ['documentId', 'reportDocumentId', 'report.id'])),
    raw: (raw && typeof raw === 'object' ? (raw as Raw) : {}),
  };
}

export function toForm(raw: unknown, caseId: string): InTouchForm {
  const slug = norm(pick(raw, ['code', 'type', 'formType', 'formCode', 'name']));
  const status = norm(pick(raw, ['status', 'state']));
  return {
    id: str(pick(raw, ['id', 'formId'])) ?? '',
    caseId,
    // InTouch's slug is translated to the engine's form code, or passed through in upper
    // case so an unrecognised form is still visible rather than silently dropped.
    code: INTOUCH_FORM_CODES[slug] ?? slug.toUpperCase().replace(/[^A-Z0-9]+/g, ''),
    status: status === 'completed' || status === 'complete' || status === 'submitted' ? 'completed' : status === 'in_progress' || status === 'started' || status === 'partial' ? 'in_progress' : status === 'requested' || status === 'sent' || status === 'pending' ? 'requested' : 'unknown',
    completedAt: iso(pick(raw, ['completedAt', 'submittedAt', 'completed'])),
    documentId: str(pick(raw, ['documentId', 'pdfDocumentId', 'document.id'])),
    answers: (pick(raw, ['answers', 'responses', 'data', 'fields']) as Raw) ?? {},
  };
}

export function toDocument(raw: unknown, caseId: string): InTouchDocument {
  const by = norm(pick(raw, ['uploadedBy', 'source', 'origin', 'createdBy']));
  return {
    id: str(pick(raw, ['id', 'documentId'])) ?? '',
    caseId,
    fileName: str(pick(raw, ['fileName', 'name', 'filename', 'title'])) ?? 'document',
    mimeType: str(pick(raw, ['mimeType', 'contentType', 'mime'])),
    sizeBytes: Number(pick(raw, ['sizeBytes', 'size', 'length']) ?? 0) || null,
    category: str(pick(raw, ['category', 'type', 'documentType', 'folder'])),
    uploadedBy: by.includes('client') || by.includes('customer') ? 'client' : by.includes('firm') || by.includes('staff') ? 'firm' : by.includes('intouch') || by.includes('system') ? 'intouch' : 'unknown',
    createdAt: iso(pick(raw, ['createdAt', 'uploadedAt', 'created'])),
  };
}

export function toWebhookEvent(raw: unknown, headers: Record<string, string> = {}): InTouchWebhookEvent {
  const data = pick(raw, ['data', 'payload', 'resource', 'body']) ?? raw;
  return {
    id: str(pick(raw, ['id', 'eventId', 'deliveryId'])) ?? str(headers['x-intouch-delivery']),
    type: norm(pick(raw, ['type', 'eventType', 'event', 'name'])).replace(/_/g, '.'),
    caseId: str(pick(data, ['caseId', 'case.id', 'caseID'])) ?? str(pick(raw, ['caseId'])),
    resourceId: str(pick(data, ['id', 'resourceId', 'documentId', 'formId', 'checkId', 'identityCheckId'])),
    receivedAt: new Date().toISOString(),
    raw: (raw && typeof raw === 'object' ? (raw as Raw) : {}),
  };
}

// ───────────────────────── our domain → InTouch ─────────────────────────

/**
 * The engine's lifecycle → the milestone a client and an estate agent understand.
 *
 * Deliberately coarser than the engine: a client does not need "contract review" and
 * "pre-exchange" as separate facts, and telling them so invites questions nobody has
 * time to answer. `null` means "nothing to say yet" — we do not push noise.
 */
export function milestoneFor(lifecycle: string): InTouchMilestone | null {
  // The engine's own vocabulary (engine/graph.ts Lifecycle). Anything not listed — a
  // closed or aborted matter — says nothing: a client portal is not where someone should
  // learn their purchase fell through.
  switch (lifecycle) {
    case 'instructed':
      return 'instructed';
    case 'investigating':
      return 'searches_ordered';
    case 'pre_exchange':
      return 'enquiries_raised';
    case 'ready_to_exchange':
    case 'ready_to_complete':
      return 'ready_to_exchange';
    case 'exchanged':
    case 'pre_completion':
      return 'exchanged';
    case 'completed':
    case 'post_completion':
      return 'completed';
    default:
      return null;
  }
}

/** The request body for pushing a milestone. Kept here so the shape changes in one place. */
export function milestoneBody(m: InTouchMilestone, note?: string | null, at?: string | null): Record<string, unknown> {
  return { milestone: m, note: note ?? undefined, occurredAt: at ?? new Date().toISOString() };
}
