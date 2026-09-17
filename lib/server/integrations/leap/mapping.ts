/**
 * The mapping seam: LEAP's raw JSON → our normalised shapes (types.ts), and our
 * domain → what we write back. Field names are read defensively (several candidate
 * keys, case-insensitive) because the reference could not be read: fix the candidate
 * lists here when a real payload disagrees, nothing else moves.
 *
 * Everything in this file is pure and unit-tested against fixtures.
 */
import type { LeapCard, LeapDocument, LeapMatter, LeapMatterParty, LeapMatterType, LeapNote, LeapPartyRole, LeapTask, LeapWebhookEvent, LeapWebhookEventType } from './types';

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
const num = (v: unknown): number | null => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const iso = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};
const day = (v: unknown): string | null => {
  const s = iso(v);
  return s ? s.slice(0, 10) : null;
};

export function toMatterType(raw: unknown): LeapMatterType | null {
  if (!raw) return null;
  if (typeof raw === 'string') return { id: raw, name: raw, areaOfLaw: null };
  const id = str(pick(raw, ['id', 'matterTypeId', 'typeId']));
  const name = str(pick(raw, ['name', 'matterTypeName', 'description', 'title']));
  if (!id && !name) return null;
  return { id: id ?? name!, name: name ?? id!, areaOfLaw: str(pick(raw, ['areaOfLaw', 'area', 'category', 'group'])) };
}

export function toMatter(raw: unknown): LeapMatter {
  const status = (str(pick(raw, ['status', 'state', 'matterStatus'])) ?? 'unknown').toLowerCase();
  const staff = pick(raw, ['responsibleStaff', 'personResponsible', 'responsible', 'staff', 'assignedTo']);
  const addressRaw = pick(raw, ['propertyAddress', 'property.address', 'property', 'address', 'fields.propertyAddress', 'customFields.propertyAddress']);
  const address = typeof addressRaw === 'object' && addressRaw ? formatAddress(addressRaw as Raw) : str(addressRaw);
  const fields = (pick(raw, ['fields', 'customFields', 'matterDetails', 'details']) as Raw | undefined) ?? {};
  return {
    id: str(pick(raw, ['id', 'matterId', 'matterID']))!,
    number: str(pick(raw, ['number', 'matterNumber', 'fileNumber', 'reference', 'ref'])) ?? str(pick(raw, ['id', 'matterId']))!,
    description: str(pick(raw, ['description', 'title', 'name', 'matterDescription'])) ?? '',
    status: status.startsWith('open') || status === 'active' || status === 'current' ? 'open' : status.startsWith('clos') || status === 'complete' || status === 'completed' ? 'closed' : status.startsWith('arch') ? 'archived' : 'unknown',
    matterType: toMatterType(pick(raw, ['matterType', 'type', 'matterTypeName'])),
    responsibleStaff: staff && typeof staff === 'object'
      ? { id: str(pick(staff, ['id', 'staffId', 'userId'])) ?? '', name: str(pick(staff, ['name', 'displayName', 'fullName'])) ?? '', email: str(pick(staff, ['email', 'emailAddress'])) }
      : staff ? { id: String(staff), name: String(staff), email: null } : null,
    propertyAddress: address,
    exchangeDate: day(pick(raw, ['exchangeDate', 'fields.exchangeDate', 'keyDates.exchange', 'dates.exchange'])),
    completionDate: day(pick(raw, ['completionDate', 'settlementDate', 'fields.completionDate', 'keyDates.completion', 'dates.completion'])),
    purchasePrice: str(pick(raw, ['purchasePrice', 'price', 'fields.purchasePrice', 'consideration'])),
    fields,
    createdAt: iso(pick(raw, ['createdAt', 'created', 'dateCreated', 'openedDate'])),
    updatedAt: iso(pick(raw, ['updatedAt', 'modified', 'lastModified', 'dateModified'])),
  };
}

export function formatAddress(a: Raw): string | null {
  const parts = ['line1', 'addressLine1', 'street', 'line2', 'addressLine2', 'suburb', 'town', 'city', 'county', 'state', 'postcode', 'postalCode', 'zip']
    .map((k) => str(pick(a, [k])))
    .filter((x, i, arr): x is string => !!x && arr.indexOf(x) === i);
  return parts.length ? parts.join(', ') : str(pick(a, ['formatted', 'full', 'text', 'value']));
}

export function toCard(raw: unknown): LeapCard {
  const first = str(pick(raw, ['firstName', 'givenName', 'firstNames']));
  const last = str(pick(raw, ['lastName', 'surname', 'familyName']));
  const org = str(pick(raw, ['organisation', 'organization', 'companyName', 'firmName', 'company']));
  const type = (str(pick(raw, ['type', 'cardType', 'kind'])) ?? '').toLowerCase();
  const name = str(pick(raw, ['name', 'displayName', 'fullName'])) ?? [first, last].filter(Boolean).join(' ') ?? org ?? '';
  return {
    id: str(pick(raw, ['id', 'cardId', 'cardID']))!,
    type: type.includes('company') || type.includes('org') ? 'company' : type.includes('person') || first || last ? 'person' : 'unknown',
    name: name || org || '',
    firstName: first,
    lastName: last,
    email: str(pick(raw, ['email', 'emailAddress', 'emails.0', 'contact.email']))?.toLowerCase() ?? null,
    phone: str(pick(raw, ['phone', 'mobile', 'mobilePhone', 'phoneNumber', 'phones.0'])),
    organisation: org,
  };
}

/** LEAP's role labels are free text per matter type; normalise the conveyancing ones. */
export function normaliseRole(rawRole: string | null | undefined): LeapPartyRole {
  const r = (rawRole ?? '').toLowerCase();
  if (!r) return 'other';
  if (/lender|mortgagee|bank/.test(r) && /solicitor|lawyer|conveyancer/.test(r)) return 'lender_solicitor';
  if (/lender|mortgagee/.test(r)) return 'lender';
  if (/(other|opposing|counter)[- ]?(side|party)|vendor|seller|purchaser|buyer/.test(r) && /solicitor|lawyer|conveyancer|firm/.test(r)) return 'other_side_solicitor';
  if (/solicitor|conveyancer/.test(r) && /(other|opposing|counter)/.test(r)) return 'other_side_solicitor';
  if (/estate agent|agent/.test(r)) return 'agent';
  if (/^client$|our client|purchaser|buyer/.test(r)) return 'client';
  if (/vendor|seller|other side|opposing|counterpart/.test(r)) return 'other_side';
  if (/our firm|acting|fee earner|staff/.test(r)) return 'our_firm';
  return 'other';
}

export function toParty(raw: unknown): LeapMatterParty {
  const cardRaw = pick(raw, ['card', 'contact', 'party']) ?? raw;
  const rawRole = str(pick(raw, ['role', 'roleName', 'relationship', 'type', 'partyType'])) ?? '';
  return { card: toCard(cardRaw), role: normaliseRole(rawRole), rawRole };
}

export function toDocument(raw: unknown, matterId?: string | null): LeapDocument {
  const name = str(pick(raw, ['name', 'fileName', 'title', 'documentName'])) ?? 'document';
  const ext = str(pick(raw, ['extension', 'ext', 'fileExtension', 'type']))?.replace(/^\./, '').toLowerCase() ?? (name.includes('.') ? name.split('.').pop()!.toLowerCase() : null);
  return {
    id: str(pick(raw, ['id', 'documentId', 'documentID']))!,
    matterId: str(pick(raw, ['matterId', 'matter.id', 'matterID'])) ?? matterId ?? '',
    name,
    extension: ext,
    mimeType: str(pick(raw, ['mimeType', 'contentType', 'mediaType'])) ?? (ext === 'pdf' ? 'application/pdf' : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null),
    sizeBytes: num(pick(raw, ['size', 'sizeBytes', 'fileSize', 'length'])),
    folder: str(pick(raw, ['folder', 'folderName', 'path', 'folder.name'])),
    createdAt: iso(pick(raw, ['createdAt', 'created', 'dateCreated', 'uploadedAt'])),
    updatedAt: iso(pick(raw, ['updatedAt', 'modified', 'lastModified', 'dateModified'])),
    createdBy: str(pick(raw, ['createdBy', 'author', 'staffId', 'createdBy.id', 'createdBy.name'])),
    category: str(pick(raw, ['category', 'documentType', 'docType', 'precedentCategory'])),
  };
}

export function toTask(raw: unknown, matterId?: string | null): LeapTask {
  const description = str(pick(raw, ['description', 'notes', 'details', 'body']));
  const completed = pick(raw, ['completed', 'isCompleted', 'done']);
  const status = (str(pick(raw, ['status'])) ?? '').toLowerCase();
  return {
    id: str(pick(raw, ['id', 'taskId']))!,
    matterId: str(pick(raw, ['matterId', 'matter.id'])) ?? matterId ?? '',
    title: str(pick(raw, ['title', 'subject', 'name', 'summary'])) ?? '',
    description,
    dueDate: day(pick(raw, ['dueDate', 'due', 'dueAt'])),
    completed: completed === true || completed === 'true' || status === 'completed' || status === 'done' || !!pick(raw, ['completedAt', 'completedDate']),
    assigneeStaffId: str(pick(raw, ['assigneeId', 'assignedTo', 'assignedToId', 'staffId', 'assignee.id'])),
    externalRef: str(pick(raw, ['externalRef', 'externalReference', 'reference'])) ?? extractExternalRef(description),
  };
}

/** Our tag inside a description when LEAP has no external-reference field. */
export const EXTERNAL_REF_PREFIX = 'conveyi:';
export function tagExternalRef(text: string, ref: string): string {
  return `${text}\n\n[${EXTERNAL_REF_PREFIX}${ref}]`;
}
export function extractExternalRef(text: string | null | undefined): string | null {
  const m = (text ?? '').match(/\[conveyi:([^\]\s]+)\]/);
  return m ? m[1] : null;
}

export function toNote(raw: unknown, matterId?: string | null): LeapNote {
  return {
    id: str(pick(raw, ['id', 'noteId']))!,
    matterId: str(pick(raw, ['matterId', 'matter.id'])) ?? matterId ?? '',
    body: str(pick(raw, ['body', 'text', 'content', 'note', 'description'])) ?? '',
    createdAt: iso(pick(raw, ['createdAt', 'created', 'dateCreated'])) ?? new Date(0).toISOString(),
    createdBy: str(pick(raw, ['createdBy', 'author', 'staffId', 'createdBy.name'])),
  };
}

const EVENT_TYPES: Array<[RegExp, LeapWebhookEventType]> = [
  [/matter.*(creat|new|open)/i, 'matter.created'],
  [/matter.*(clos|archiv)/i, 'matter.closed'],
  [/matter.*(updat|chang|modif)/i, 'matter.updated'],
  [/document.*(creat|new|add|upload)/i, 'document.created'],
  [/document.*(updat|chang|modif|version)/i, 'document.updated'],
  [/card.*(updat|chang|modif|creat)/i, 'card.updated'],
  [/task.*(updat|chang|complet|creat)/i, 'task.updated'],
];

export function toWebhookEvent(raw: unknown, fallbackId: string): LeapWebhookEvent {
  const typeRaw = str(pick(raw, ['type', 'eventType', 'event', 'topic', 'name'])) ?? '';
  const type = EVENT_TYPES.find(([re]) => re.test(typeRaw))?.[1] ?? 'unknown';
  const data = (pick(raw, ['data', 'payload', 'resource', 'object']) as Raw | undefined) ?? (raw as Raw);
  return {
    id: str(pick(raw, ['id', 'eventId', 'deliveryId', 'notificationId'])) ?? fallbackId,
    type,
    firmId: str(pick(raw, ['firmId', 'firm.id', 'tenantId', 'data.firmId'])),
    matterId: str(pick(data, ['matterId', 'matter.id', 'matterID'])) ?? (type.startsWith('matter') ? str(pick(data, ['id'])) : null),
    documentId: str(pick(data, ['documentId', 'document.id'])) ?? (type.startsWith('document') ? str(pick(data, ['id'])) : null),
    cardId: str(pick(data, ['cardId', 'card.id'])) ?? (type.startsWith('card') ? str(pick(data, ['id'])) : null),
    taskId: str(pick(data, ['taskId', 'task.id'])) ?? (type.startsWith('task') ? str(pick(data, ['id'])) : null),
    occurredAt: iso(pick(raw, ['occurredAt', 'timestamp', 'createdAt', 'time'])),
    raw,
  };
}

// ───────────────────────────── our domain ← LEAP ─────────────────────────────

/** Which LEAP matters the engine runs: residential freehold purchases (the machine's scope), by matter-type name. */
export function isEnrollableMatterType(t: LeapMatterType | null, patterns: RegExp[] = DEFAULT_ENROL_PATTERNS): boolean {
  if (!t) return false;
  const hay = `${t.areaOfLaw ?? ''} ${t.name}`.toLowerCase();
  if (!/convey|purchase|sale|property/.test(hay)) return false;
  if (/lease/.test(hay)) return false; // leasehold is out of scope for v1 (manual handling)
  if (/\bsale\b|vendor|selling/.test(hay) && !/purchase/.test(hay)) return false;
  return patterns.some((p) => p.test(hay));
}
export const DEFAULT_ENROL_PATTERNS = [/purchase/, /buy/, /acquisition/];

/** Our matter `track` column from LEAP's matter type. */
export function trackOf(t: LeapMatterType | null): 'PURCHASE' | 'SALE' {
  const hay = `${t?.areaOfLaw ?? ''} ${t?.name ?? ''}`.toLowerCase();
  return /\bsale\b|vendor|selling|disposal/.test(hay) && !/purchase/.test(hay) ? 'SALE' : 'PURCHASE';
}

/** LEAP party roles → our matter_contact roles. */
export function contactRoleOf(role: LeapPartyRole): 'CLIENT' | 'OTHER_SIDE' | 'AGENT' | 'LENDER' | 'OUR_FIRM' | 'OTHER' {
  switch (role) {
    case 'client':
      return 'CLIENT';
    case 'other_side':
    case 'other_side_solicitor':
      return 'OTHER_SIDE';
    case 'agent':
      return 'AGENT';
    case 'lender':
    case 'lender_solicitor':
      return 'LENDER';
    case 'our_firm':
      return 'OUR_FIRM';
    default:
      return 'OTHER';
  }
}

/** Search-type hint from a LEAP document's name/folder, so the classifier has a strong prior (it still decides). */
export function documentHint(d: LeapDocument): { role: 'search' | 'enquiry_reply' | 'mortgage_offer' | 'title' | 'id_check' | null; searchType: string | null } {
  const hay = `${d.folder ?? ''} ${d.category ?? ''} ${d.name}`.toLowerCase();
  // Order matters: "CON29DW" (drainage & water) must not be read as the CON29 local search.
  if (/con29dw|drainage|water/.test(hay)) return { role: 'search', searchType: 'DRAINAGE_WATER' };
  if (/con29|local authority|local search/.test(hay)) return { role: 'search', searchType: 'CON29' };
  if (/llc1|land charges/.test(hay)) return { role: 'search', searchType: 'LLC1' };
  if (/environ|flood|groundsure|landmark/.test(hay)) return { role: 'search', searchType: 'ENVIRONMENTAL' };
  if (/chancel/.test(hay)) return { role: 'search', searchType: 'CHANCEL' };
  if (/mortgage offer|offer of advance|loan offer/.test(hay)) return { role: 'mortgage_offer', searchType: null };
  if (/official copy|register of title|title register|oc1|ocr/.test(hay)) return { role: 'title', searchType: null };
  if (/\baml\b|\bid[ -]?(check|report|verif)|identity|thirdfort|kyc|verif/.test(hay)) return { role: 'id_check', searchType: null };
  if (/enquir|replies|ta6|ta10|additional enq/.test(hay)) return { role: 'enquiry_reply', searchType: null };
  return { role: null, searchType: null };
}
