/**
 * LEAP → CONVEYi: the sync (phase 0).
 *
 * Pure orchestration over three ports — the LEAP API, a mirror store (Postgres in
 * production, memory in tests) and the engine — so the whole flow is unit-tested
 * against MockLeap:
 *
 *   LEAP matter (open, conveyancing purchase)  ──► mirror matter row ──► enrol in the engine
 *   LEAP cards on the matter                   ──► matter_contact rows (roles normalised)
 *   LEAP document on an enrolled matter        ──► document row (bytes stay in LEAP) ──► ingest → engine
 *
 * Two triggers feed the same functions: webhooks (LEAP tells us) and polling with
 * watermarks (we ask LEAP what changed since last time), because webhook availability
 * per resource is one of the things the gated reference has to confirm. Both are
 * idempotent: every upsert is keyed on the LEAP id.
 *
 * Nothing here decides anything about the conveyance. The engine does that, on our
 * side, from the documents LEAP holds.
 */
import type { EngineService } from '../../engine/service';
import { routeClassification, runAction } from '../../engine/ingest';
import type { LeapApi } from './client';
import { DEFAULT_ENROL_PATTERNS, documentHint, isEnrollableMatterType, trackOf } from './mapping';
import type { LeapDocument, LeapMatter, LeapMatterParty, LeapWebhookEvent } from './types';
import { EXTERNAL, type SearchType } from '../../engine/types';

export interface MirrorMatterRef {
  matterId: string;
  leapMatterId: string;
  documentsSince: string | null;
}

export interface LeapMirrorStore {
  /** Upsert the matter row from LEAP's view of it. `assignedTo` is our user mapped from LEAP's responsible staff. */
  upsertMatter(tenantId: string, m: LeapMatter, extras: { assignedTo: string | null; track: 'PURCHASE' | 'SALE'; createdBy: string | null }): Promise<{ matterId: string; created: boolean; previousAssignedTo?: string | null }>;
  matterByLeapId(tenantId: string, leapMatterId: string): Promise<MirrorMatterRef | null>;
  closeMatter(tenantId: string, matterId: string): Promise<void>;
  upsertContacts(tenantId: string, matterId: string, parties: LeapMatterParty[]): Promise<void>;
  upsertDocument(tenantId: string, matterId: string, d: LeapDocument): Promise<{ documentId: string; created: boolean }>;
  /** Ingest bookkeeping: PENDING documents are retried on every sync of an enrolled matter. */
  markIngest(tenantId: string, documentId: string, status: IngestStatus, detail: string | null): Promise<void>;
  pendingIngests(tenantId: string, matterId: string): Promise<Array<{ documentId: string; hint: IngestHint; attempts: number }>>;
  /** Our user for LEAP's responsible staff member (matched by email), or null. */
  staffToUser(tenantId: string, staff: LeapMatter['responsibleStaff']): Promise<string | null>;
  setMattersWatermark(tenantId: string, iso: string): Promise<void>;
  setDocumentsWatermark(tenantId: string, matterId: string, iso: string): Promise<void>;
  mattersWatermark(tenantId: string): Promise<string | null>;
  /** Every mirrored matter the engine has enrolled (their documents are polled on every sync, changed or not). */
  enrolledMirrors(tenantId: string): Promise<MirrorMatterRef[]>;
  recordSync(tenantId: string, detail: SyncSummary): Promise<void>;
}

export interface EnrolPolicy {
  /** Matter-type name patterns that get enrolled (after the conveyancing/purchase guard in mapping.ts). */
  patterns: RegExp[];
  /** Enrol in shadow mode (addendum 3): the engine observes LEAP matters before it acts on them. */
  shadow: boolean;
  requiredSearches?: SearchType[];
}

export type IngestHint = ReturnType<typeof documentHint>;
export type IngestStatus = 'PENDING' | 'DONE' | 'SKIPPED';
/** What the ingest bridge reports back: taken by a sub-flow, nothing for the engine, or not yet (precondition). */
export type IngestResult = { status: IngestStatus; detail: string };
/** After this many attempts a PENDING document stops being retried (a person can file it from the panel). */
export const MAX_INGEST_ATTEMPTS = 20;

export interface SyncDeps {
  leap: LeapApi;
  store: LeapMirrorStore;
  engine: EngineService;
  /** Hand a mirrored document to the engine (classify → route → sub-flow). The hint is a prior from LEAP's folder/name. */
  ingest: (tenantId: string, matterId: string, documentId: string, hint: IngestHint) => Promise<IngestResult>;
  policy: EnrolPolicy;
  now: () => Date;
  log: (msg: string, detail?: unknown) => void;
}

export interface SyncSummary {
  at: string;
  matters: { seen: number; created: number; enrolled: number; closed: number };
  documents: { seen: number; created: number; ingested: number; pending: number; retried: number };
  contacts: number;
  errors: string[];
}

const emptySummary = (now: Date): SyncSummary => ({ at: now.toISOString(), matters: { seen: 0, created: 0, enrolled: 0, closed: 0 }, documents: { seen: 0, created: 0, ingested: 0, pending: 0, retried: 0 }, contacts: 0, errors: [] });

/** Poll LEAP for matters changed since the watermark (or everything when `full`). */
export async function syncMatters(deps: SyncDeps, tenantId: string, opts: { full?: boolean } = {}): Promise<SyncSummary> {
  const summary = emptySummary(deps.now());
  const since = opts.full ? null : await deps.store.mattersWatermark(tenantId);
  const startedAt = deps.now().toISOString();
  const visited = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await deps.leap.listMatters({ updatedSince: since, cursor });
    for (const m of page.items) {
      try {
        await syncOneMatter(deps, tenantId, m, summary);
        visited.add(m.id);
      } catch (err) {
        summary.errors.push(`matter ${m.number}: ${(err as Error).message}`);
        deps.log(`LEAP sync: matter ${m.number} failed`, err);
      }
    }
    cursor = page.next;
  } while (cursor);
  // A new document does not necessarily change the matter's own modified date in LEAP, and a
  // PENDING document needs retrying whatever LEAP says: poll every enrolled matter's documents
  // from its own watermark.
  for (const ref of await deps.store.enrolledMirrors(tenantId)) {
    if (visited.has(ref.leapMatterId)) continue;
    try {
      await syncDocuments(deps, tenantId, ref, summary);
    } catch (err) {
      summary.errors.push(`documents for ${ref.leapMatterId}: ${(err as Error).message}`);
      deps.log(`LEAP sync: documents for ${ref.leapMatterId} failed`, err);
    }
  }
  await deps.store.setMattersWatermark(tenantId, startedAt);
  await deps.store.recordSync(tenantId, summary);
  return summary;
}

/** Mirror one LEAP matter: row, parties, enrolment, documents. Idempotent. */
export async function syncOneMatter(deps: SyncDeps, tenantId: string, m: LeapMatter, summary: SyncSummary = emptySummary(deps.now())): Promise<{ matterId: string; enrolled: boolean }> {
  summary.matters.seen += 1;
  const assignedTo = await deps.store.staffToUser(tenantId, m.responsibleStaff);
  const { matterId, created, previousAssignedTo } = await deps.store.upsertMatter(tenantId, m, { assignedTo, track: trackOf(m.matterType), createdBy: assignedTo });
  if (created) summary.matters.created += 1;
  // Responsible staff changed in LEAP → handler_changed on the log (enrolled matters only).
  if (!created && assignedTo && previousAssignedTo !== undefined && previousAssignedTo !== assignedTo) {
    const st = await deps.engine.getState(tenantId, matterId);
    if (st.enrolled && st.handler !== assignedTo) await deps.engine.run(tenantId, matterId, { type: 'record_handler_change', actor: 'external', fromUserId: previousAssignedTo ?? null, toUserId: assignedTo, reason: 'responsible staff changed in LEAP' }).catch((err) => deps.log('handler change not recorded', err));
  }

  if (m.status !== 'open') {
    await deps.store.closeMatter(tenantId, matterId);
    summary.matters.closed += 1;
    return { matterId, enrolled: false };
  }

  const parties = await deps.leap.matterParties(m.id);
  await deps.store.upsertContacts(tenantId, matterId, parties);
  summary.contacts += parties.length;

  // Enrolment: only what the machine is built for (residential freehold purchase), once.
  let enrolled = false;
  const state = await deps.engine.getState(tenantId, matterId);
  if (!state.enrolled && isEnrollableMatterType(m.matterType, deps.policy.patterns)) {
    const hasLender = parties.some((p) => p.role === 'lender' || p.role === 'lender_solicitor');
    await deps.engine.run(tenantId, matterId, {
      type: 'enrol',
      actor: assignedTo ?? 'system',
      hasLender,
      requiredSearches: deps.policy.requiredSearches,
      targetExchangeDate: m.exchangeDate,
      targetCompletionDate: m.completionDate,
      counterpartyType: 'external',
      shadowMode: deps.policy.shadow,
    });
    enrolled = true;
    summary.matters.enrolled += 1;
  } else if (state.enrolled) enrolled = true;

  if (enrolled) await syncDocuments(deps, tenantId, { matterId, leapMatterId: m.id, documentsSince: (await deps.store.matterByLeapId(tenantId, m.id))?.documentsSince ?? null }, summary);
  return { matterId, enrolled };
}

/** Mirror the documents LEAP holds on an enrolled matter; new ones go to the engine. */
export async function syncDocuments(deps: SyncDeps, tenantId: string, ref: MirrorMatterRef, summary: SyncSummary = emptySummary(deps.now())): Promise<SyncSummary> {
  const startedAt = deps.now().toISOString();
  // First, anything the engine could not take last time (documents arrive in LEAP in any order).
  for (const p of await deps.store.pendingIngests(tenantId, ref.matterId)) {
    if (p.attempts >= MAX_INGEST_ATTEMPTS) continue;
    summary.documents.retried += 1;
    await ingestMirrored(deps, tenantId, ref.matterId, p.documentId, p.hint, summary);
  }
  let cursor: string | null = null;
  do {
    const page = await deps.leap.listDocuments(ref.leapMatterId, { updatedSince: ref.documentsSince, cursor });
    for (const d of page.items) {
      summary.documents.seen += 1;
      try {
        await mirrorDocument(deps, tenantId, ref.matterId, d, summary);
      } catch (err) {
        summary.errors.push(`document ${d.name}: ${(err as Error).message}`);
        deps.log(`LEAP sync: document ${d.name} failed`, err);
      }
    }
    cursor = page.next;
  } while (cursor);
  await deps.store.setDocumentsWatermark(tenantId, ref.matterId, startedAt);
  return summary;
}

async function mirrorDocument(deps: SyncDeps, tenantId: string, matterId: string, d: LeapDocument, summary: SyncSummary): Promise<{ documentId: string; created: boolean }> {
  const r = await deps.store.upsertDocument(tenantId, matterId, d);
  if (r.created) {
    summary.documents.created += 1;
    // Only a NEW document goes to the engine (a re-listed one was already handled, skipped or is pending retry).
    await ingestMirrored(deps, tenantId, matterId, r.documentId, documentHint(d), summary);
  }
  return r;
}

/** Hand a mirrored document to the engine and record the outcome; a precondition failure leaves it PENDING for the next sync. */
async function ingestMirrored(deps: SyncDeps, tenantId: string, matterId: string, documentId: string, hint: IngestHint, summary: SyncSummary): Promise<IngestResult> {
  let result: IngestResult;
  try {
    result = await deps.ingest(tenantId, matterId, documentId, hint);
  } catch (err) {
    // The engine said "not yet" (stage / sub-flow precondition) or the extractor failed: keep it for the next sync.
    result = { status: 'PENDING', detail: (err as Error).message };
  }
  await deps.store.markIngest(tenantId, documentId, result.status, result.detail);
  if (result.status === 'DONE') summary.documents.ingested += 1;
  else if (result.status === 'PENDING') summary.documents.pending += 1;
  return result;
}

export type WebhookOutcome = { status: 'PROCESSED' | 'IGNORED'; reason: string; matterId?: string; documentId?: string };

/** LEAP told us something changed. Re-read the resource from LEAP (the payload is a pointer, never trusted for content). */
export async function handleLeapWebhook(deps: SyncDeps, tenantId: string, event: LeapWebhookEvent): Promise<WebhookOutcome> {
  const summary = emptySummary(deps.now());
  switch (event.type) {
    case 'matter.created':
    case 'matter.updated':
    case 'matter.closed':
    case 'card.updated': {
      if (!event.matterId) return { status: 'IGNORED', reason: `${event.type} without a matter id` };
      const m = await deps.leap.getMatter(event.matterId);
      if (!m) return { status: 'IGNORED', reason: 'matter not found in LEAP' };
      const r = await syncOneMatter(deps, tenantId, m, summary);
      await deps.store.recordSync(tenantId, summary);
      return { status: 'PROCESSED', reason: `${event.type}: ${r.enrolled ? 'enrolled' : 'mirrored'}`, matterId: r.matterId };
    }
    case 'document.created':
    case 'document.updated': {
      if (!event.documentId) return { status: 'IGNORED', reason: `${event.type} without a document id` };
      const d = await deps.leap.getDocument(event.documentId);
      if (!d) return { status: 'IGNORED', reason: 'document not found in LEAP' };
      let ref = await deps.store.matterByLeapId(tenantId, d.matterId);
      if (!ref) {
        // A document on a matter we have not seen: mirror the matter first (it may enrol and pull every document).
        const m = await deps.leap.getMatter(d.matterId);
        if (!m) return { status: 'IGNORED', reason: 'document\'s matter not found in LEAP' };
        const r = await syncOneMatter(deps, tenantId, m, summary);
        await deps.store.recordSync(tenantId, summary);
        return { status: 'PROCESSED', reason: `${event.type}: matter mirrored${r.enrolled ? ' and enrolled; documents pulled' : ' (not enrolled)'}`, matterId: r.matterId };
      }
      const state = await deps.engine.getState(tenantId, ref.matterId);
      if (!state.enrolled) {
        await deps.store.upsertDocument(tenantId, ref.matterId, d);
        return { status: 'IGNORED', reason: 'matter not enrolled in the engine; document mirrored only', matterId: ref.matterId };
      }
      const r = await mirrorDocument(deps, tenantId, ref.matterId, d, summary);
      await deps.store.recordSync(tenantId, summary);
      return { status: r.created ? 'PROCESSED' : 'IGNORED', reason: r.created ? 'document mirrored and handed to the engine' : 'document already mirrored', matterId: ref.matterId, documentId: r.documentId };
    }
    case 'task.updated':
      return { status: 'IGNORED', reason: 'task changes are not consumed (phase 1 writes tasks; it does not read them)' };
    default:
      return { status: 'IGNORED', reason: `unknown event type` };
  }
}

export const DEFAULT_ENROL_POLICY: EnrolPolicy = { patterns: DEFAULT_ENROL_PATTERNS, shadow: true };

/**
 * Route a mirrored document by LEAP's folder/file-name hint (no classifier, or the
 * classifier was unsure). LEAP is where the firm files what arrives, so a result can
 * land there for a step the engine never initiated: an ID report when the handler
 * ordered the check from LEAP/InfoTrack directly, a search the firm ordered by hand.
 * The log stays truthful — the request/order is recorded first, actor `external`,
 * provider "arrived via LEAP" — and then the document goes through the normal sub-flow.
 */
export async function routeByHint(svc: EngineService, tenantId: string, matterId: string, documentId: string, hint: IngestHint): Promise<IngestResult> {
  if (!hint.role) return { status: 'SKIPPED', detail: 'nothing for the engine in this document (no classifier, no hint from LEAP)' };
  let state = await svc.getState(tenantId, matterId);
  if (!state.enrolled) return { status: 'SKIPPED', detail: 'matter not enrolled' };
  if (hint.role === 'id_check' && state.idCheck.status === 'not_started') {
    await svc.run(tenantId, matterId, { type: 'request_id_check', actor: EXTERNAL, provider: 'arrived via LEAP', reference: null });
    state = await svc.getState(tenantId, matterId);
  }
  // Not yet: the sub-flow this document belongs to has not opened (a search result before pre_contract). Retry next sync.
  if (hint.role === 'search' && state.stage === 'instruction') return { status: 'PENDING', detail: 'search result before the matter reached pre_contract' };
  const action = routeClassification(state, { role: hint.role, searchType: (hint.searchType as SearchType | null) ?? null, enquiryReferences: [], titleNumber: null, lender: null, confidence: 0.85, reason: 'LEAP folder / file name' });
  if (action.kind === 'skip') return { status: /pending|awaiting|already|not awaiting/.test(action.reason) ? 'PENDING' : 'SKIPPED', detail: action.reason };
  await runAction(svc, tenantId, matterId, documentId, action);
  return { status: 'DONE', detail: `${action.kind} via LEAP hint (${hint.searchType ?? hint.role})` };
}
