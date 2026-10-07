/**
 * The mapping seam: InTouch's raw JSON → our normalised shapes (types.ts), our domain →
 * what we send back, and the engine's lifecycle → the milestone a client understands.
 *
 * Field names follow InTouch's Public Customer Matter API reference (Matter, MatterTask,
 * MatterFolderItemPublicModel, the response envelope). They are still read case-insensitively,
 * with the older candidate names behind them, because InTouch asks clients to parse
 * permissively; when a live payload disagrees, the fix is here and nothing else moves.
 *
 * Everything here is pure and unit-tested against fixtures.
 */
import crypto from 'node:crypto';
import { normaliseInTouchEvent, type InTouchMilestone } from './endpoints';
import { InTouchError, type InTouchCase, type InTouchCaseStatus, type InTouchDocument, type InTouchParty, type InTouchPartyRole, type InTouchTask, type InTouchTransactionSide, type InTouchWebhookEvent } from './types';

type Raw = Record<string, unknown>;

/**
 * Case-insensitive, dotted-path tolerant pick of the first present candidate key.
 *
 * A candidate is first tried as a literal key — InTouch's webhook envelope has flat keys
 * with dots in them ("triggered.by.email") — and only then as a path into nested objects.
 */
export function pick(raw: unknown, keys: string[]): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  for (const key of keys) {
    if (key.includes('.')) {
      const obj = raw as Raw;
      const direct = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
      const v = direct === undefined ? undefined : obj[direct];
      if (v !== undefined && v !== null && v !== '') return v;
    }
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

/**
 * InTouch's response envelope { success, message, errors, additionalData, data } → data.
 * success:false is InTouch refusing, with its own words; a body without the envelope is passed through.
 */
export function unwrap(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('success' in (body as Raw))) return body;
  const b = body as { success?: unknown; message?: unknown; errors?: unknown; data?: unknown };
  if (b.success === false) {
    const why = [str(b.message), ...(Array.isArray(b.errors) ? b.errors.map(String) : [])].filter(Boolean).join('; ');
    throw new InTouchError(`InTouch refused the request${why ? `: ${why}` : ''}.`, 422, false);
  }
  return b.data ?? null;
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

/**
 * A matter's state → ours. InTouch's state values are firm-configurable words, so they are
 * read by what they say: a quote is not a case, a cancelled or finished one is not live, and
 * any other named state is a live instruction.
 */
export function caseStatus(v: unknown): InTouchCaseStatus {
  const s = norm(v);
  if (!s) return 'unknown';
  if (CASE_STATUS[s]) return CASE_STATUS[s];
  if (/quote|lead|enquir|prospect|estimate/.test(s)) return 'quote';
  if (/cancel|abort|withdr|lost|declin|abandon|fall/.test(s)) return 'cancelled';
  if (/complet|archiv|closed|finish|registered/.test(s)) return 'completed';
  if (/instruct|onboard|new|welcome/.test(s)) return 'instructed';
  return 'active';
}

/** Purchase, sale, remortgage or transfer, from the matter's template name ("Freehold Purchase", "Sale & Purchase"…). */
export function sideFrom(v: unknown): InTouchTransactionSide {
  const s = norm(v);
  if (SIDE[s]) return SIDE[s];
  if (/transfer|equity|toe\b/.test(s)) return 'transfer';
  if (/remortgage|re_mortgage|refinanc/.test(s)) return 'remortgage';
  // "Sale & Purchase" is two cases for us; InTouch holds it as one matter. It mirrors as the purchase,
  // and the conveyancer links the sale (Case View → Chain).
  if (/purchas|buy/.test(s)) return 'purchase';
  if (/sale|sell|vendor/.test(s)) return 'sale';
  return 'unknown';
}

export function toCase(raw: unknown): InTouchCase {
  const known = new Set(['id', 'guid', 'caseid', 'reference', 'ref', 'status', 'state', 'type', 'templatename', 'templateguid', 'casetype', 'transactiontype', 'side', 'tenure', 'address', 'propertyaddress', 'addressline1', 'addressline2', 'addressline3', 'addressline4', 'postcode', 'price', 'purchaseprice', 'saleprice', 'feeearner', 'feeearnerfullname', 'feeearnerteamname', 'assignedto', 'firmreference', 'matterreference', 'createdat', 'createdon', 'created', 'updatedat', 'lastupdated', 'updated', 'primaryclientforename', 'primaryclientmiddlename', 'primaryclientsurname', 'primaryclientorganisation', 'primaryclientemail', 'primaryclientphone']);
  const fields: Raw = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Raw)) if (!known.has(k.toLowerCase())) fields[k] = v;
  const template = pick(raw, ['templateName', 'type', 'caseType', 'transactionType', 'matterType', 'side']);
  const lines = ['addressLine1', 'addressLine2', 'addressLine3', 'addressLine4'].map((k) => str(pick(raw, [k]))?.trim()).filter(Boolean) as string[];
  const postcode = str(pick(raw, ['postcode', 'property.postcode', 'postCode']));
  const address = lines.length ? [...lines, postcode].filter(Boolean).join(', ') : str(pick(raw, ['propertyAddress', 'address', 'property.address', 'property.addressLine']));
  const feName = str(pick(raw, ['feeEarnerFullName']));
  const fe = pick(raw, ['feeEarner', 'assignedTo', 'handler', 'conveyancer']);
  const tenure = norm(pick(raw, ['tenure', 'propertyTenure'])) || norm(template);
  return {
    id: str(pick(raw, ['guid', 'matterGuid', 'id', 'caseId'])) ?? '',
    reference: str(pick(raw, ['reference', 'ref', 'caseReference', 'itrCode'])) ?? '',
    status: caseStatus(pick(raw, ['state', 'status', 'caseStatus'])),
    side: sideFrom(template),
    tenure: /leasehold/.test(tenure) ? 'leasehold' : /freehold/.test(tenure) ? 'freehold' : 'unknown',
    propertyAddress: address,
    postcode,
    pricePennies: toPennies(pick(raw, ['pricePennies', 'price', 'purchasePrice', 'salePrice', 'property.price', 'consideration'])),
    feeEarner: feName ? { id: null, name: feName, email: null } : fe ? { id: str(pick(fe, ['id', 'staffId', 'userId'])), name: str(pick(fe, ['name', 'displayName', 'fullName'])), email: str(pick(fe, ['email', 'emailAddress'])) } : null,
    firmReference: str(pick(raw, ['firmReference', 'matterReference', 'externalReference', 'yourRef'])),
    createdAt: iso(pick(raw, ['createdOn', 'createdAt', 'created', 'createdDate'])),
    updatedAt: iso(pick(raw, ['lastUpdated', 'updatedAt', 'updated', 'modifiedAt', 'lastModified'])),
    fields,
  };
}

/** The matter's primary client (the one person the API carries) as a party, or null when it has none. */
export function primaryClient(raw: unknown, caseId: string): InTouchParty | null {
  const first = str(pick(raw, ['primaryClientForename']))?.trim() || null;
  const middle = str(pick(raw, ['primaryClientMiddleName']))?.trim() || null;
  const last = str(pick(raw, ['primaryClientSurname']))?.trim() || null;
  const company = str(pick(raw, ['primaryClientOrganisation']))?.trim() || null;
  const email = str(pick(raw, ['primaryClientEmail']))?.trim() || null;
  if (!first && !last && !company && !email) return null;
  return {
    id: `${caseId}:primary`,
    caseId,
    role: 'client',
    name: [first, middle, last].filter(Boolean).join(' ') || company || email || 'Client',
    firstName: first,
    lastName: last,
    email,
    phone: str(pick(raw, ['primaryClientPhone']))?.trim() || null,
    company,
    isCompany: !first && !last && !!company,
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

/** Folder items that are records, not files: they are InTouch's own history, never mirrored as documents. */
const NOT_A_FILE = /^(email|note|phone_?call|call|sms|text|letter_?record)s?$/;

/**
 * A folder item (MatterFolderItemPublicModel) → our document, or null when it is not a file (an
 * email, note or phone-call record). Its name is the description, or a file name among its fields.
 */
export function toDocument(raw: unknown, caseId: string): InTouchDocument | null {
  const type = norm(pick(raw, ['type', 'itemType', 'kind']));
  if (type && NOT_A_FILE.test(type)) return null;
  const f = (pick(raw, ['fields']) as Raw | undefined) ?? {};
  const name = str(pick(f, ['fileName', 'filename', 'name', 'title'])) ?? str(pick(raw, ['fileName', 'name', 'description', 'title'])) ?? 'document';
  const by = norm(pick(f, ['uploadedBy', 'source', 'createdBy', 'origin']) ?? pick(raw, ['uploadedBy', 'source', 'origin', 'createdBy']));
  return {
    id: str(pick(raw, ['guid', 'id', 'documentId'])) ?? '',
    caseId,
    fileName: name,
    mimeType: str(pick(f, ['mimeType', 'contentType']) ?? pick(raw, ['mimeType', 'contentType', 'mime'])),
    sizeBytes: Number(pick(f, ['size', 'sizeBytes']) ?? pick(raw, ['sizeBytes', 'size', 'length']) ?? 0) || null,
    // The folder's own words for it (a label, the item type), the hint for what the reading should try.
    category: str(pick(f, ['label', 'label1', 'category', 'folder']) ?? pick(raw, ['category', 'documentType', 'folder'])) ?? (type || null),
    uploadedBy: by.includes('client') || by.includes('customer') ? 'client' : by.includes('firm') || by.includes('staff') || by.includes('user') ? 'firm' : by.includes('intouch') || by.includes('system') ? 'intouch' : 'unknown',
    createdAt: iso(pick(raw, ['createdOn', 'createdAt', 'uploadedAt', 'created'])),
  };
}

export function toTask(raw: unknown): InTouchTask {
  return {
    id: str(pick(raw, ['guid', 'id'])) ?? '',
    name: str(pick(raw, ['name', 'title'])) ?? '',
    completed: bool(pick(raw, ['isCompleted', 'completed'])) || /^complete/i.test(str(pick(raw, ['state'])) ?? ''),
  };
}

/**
 * The InTouch task that IS this milestone on the client portal: the first not-yet-completed task
 * whose name says it ("Searches ordered", "Exchange of contracts"…). A firm's task names vary, so
 * this reads words, never ids; and "exchange" never matches a "ready to exchange" task.
 */
const TASK_WORDS: Record<InTouchMilestone, RegExp> = {
  instructed: /\b(instruct|onboard|welcome|client care|engage)/i,
  searches_ordered: /\bsearch(es)?\b.*\b(order|appl|submit|request)|\b(order|appl)\w*\b.*\bsearch/i,
  enquiries_raised: /\benquir(y|ies)\b.*\b(raise|sent|issue)|\b(raise|sent)\w*\b.*\benquir/i,
  report_sent: /\breport\b.*\b(title|sent|client)|\btitle report\b/i,
  ready_to_exchange: /\bready\b.*\bexchang|\bexchang\w*\b.*\bready\b/i,
  exchanged: /\bexchang(e|ed)\b(?!.*\bready\b)/i,
  completed: /\bcomplet(ed|ion)\b(?!.*\b(information|statement|date)\b)/i,
};
export function taskForMilestone(m: InTouchMilestone, tasks: InTouchTask[]): InTouchTask | null {
  const re = TASK_WORDS[m];
  return tasks.find((t) => !t.completed && re.test(t.name) && !(m === 'exchanged' && TASK_WORDS.ready_to_exchange.test(t.name))) ?? null;
}

/** Plain text → the HTML InTouch's notes and emails take: escaped, line breaks kept. */
export function toHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string).replace(/\r?\n/g, '<br>');
}

/**
 * InTouch's documented webhook envelope → our event.
 *
 *   { "event": "Form_Completion", "triggered.by.name": "…", "triggered.by.email": "…",
 *     "timestamp": "2020-01-03T17:01:23Z", "data": { …form fields… } }
 *
 * Only Form Completion's payload is documented, and it carries no case id; Matter State
 * Change and Task State Change are assumed to share the envelope. So the case id is read
 * defensively from `data` (and the envelope), and when there is none the sync falls back
 * to the person who triggered it. There is no delivery id, and InTouch's retries repeat
 * the body, so the event id is a hash of the raw body.
 */
export function toWebhookEvent(raw: unknown, rawBody?: string): InTouchWebhookEvent {
  const body = rawBody ?? JSON.stringify(raw ?? null);
  const data = pick(raw, ['data', 'payload']);
  const type = normaliseInTouchEvent(pick(raw, ['event', 'type', 'eventType']));
  const caseKeys = ['matterGuid', 'matter.guid', 'matter.matterGuid', 'matterId', 'matter.id', 'matter_id', 'caseId', 'case.id', 'case_id'];
  const caseId =
    str(pick(data, caseKeys)) ??
    str(pick(raw, caseKeys)) ??
    // A matter event's own `id` is the matter.
    (type === 'matter_state_change' ? str(pick(data, ['guid', 'id'])) : null);
  return {
    id: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
    type,
    caseId,
    resourceId: str(pick(data, ['matterTaskGuid', 'taskGuid', 'taskId', 'task.id', 'formGuid', 'formId', 'form.id', 'documentId', 'guid', 'id'])),
    triggeredByEmail: str(pick(raw, ['triggered.by.email', 'triggeredBy.email', 'triggered_by_email', 'triggeredByEmail']))?.trim().toLowerCase() || null,
    occurredAt: iso(pick(raw, ['timestamp', 'occurredAt'])),
    receivedAt: new Date().toISOString(),
    raw: raw && typeof raw === 'object' ? (raw as Raw) : {},
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
