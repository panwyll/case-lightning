/**
 * InTouch → CONVEYi, and back.
 *
 * Pure orchestration over three ports — the InTouch API, a mirror store (Postgres in
 * production, memory in tests) and the engine — so the whole flow is unit-tested against
 * MockInTouch:
 *
 *   InTouch case (instructed / active)  ──► mirror matter row ──► enrol in the engine
 *   the matter's primary client         ──► a matter_contact row
 *   each file in the matter's folder    ──► document row ──► the ordinary ingest path
 *     (the ID report and completed TA6/TA7/TA10 arrive this way: InTouch's API has no
 *      identity-check or form-answer resource, so they are read like any document)
 *   the engine's lifecycle              ──► the matching InTouch task completed (the client portal)
 *
 * Two triggers feed the same functions — webhooks (InTouch tells us: Form Completion,
 * Matter State Change, Task State Change) and polling with a watermark (we ask what
 * changed) — because the webhooks only cover some of what a client produces, and their
 * payload does not reliably say which case it is about. Both are idempotent: every upsert is keyed
 * on the InTouch id, and every engine command is one the machine would accept by hand.
 *
 * What this file will NOT do: decide anything. An identity check that comes back "refer"
 * does not become a judgement here — it becomes the same flagged decision a conveyancer
 * would get from any other provider, and a person resolves it.
 */
import { writeBackToInTouch, type InTouchWritebackStore } from './writeback';
import type { EngineService } from '../../engine/service';
import { routeClassification, runAction } from '../../engine/ingest';
import type { InTouchApi } from './client';
import type { DocumentClassification } from '../../engine/ports';
import type { InTouchCase, InTouchDocument, InTouchParty, InTouchSyncSummary, InTouchWebhookEvent } from './types';
import { milestoneFor } from './mapping';
import type { InTouchMilestone } from './endpoints';

export interface InTouchMirrorRef {
  matterId: string;
  intouchCaseId: string;
  /** The last milestone we pushed, so we never push the same one twice. */
  lastMilestone: string | null;
}

export interface InTouchMirrorStore {
  /** Upsert the matter row from InTouch's view of it. Returns whether we just created it. */
  upsertMatter(tenantId: string, c: InTouchCase, extras: { assignedTo: string | null; createdBy: string | null }): Promise<{ matterId: string; created: boolean }>;
  matterByCaseId(tenantId: string, intouchCaseId: string): Promise<InTouchMirrorRef | null>;
  /**
   * The one open InTouch-mirrored matter of this firm with a contact at this email, or
   * null when there is none OR more than one. Never a guess across several.
   */
  matterByContactEmail(tenantId: string, email: string): Promise<InTouchMirrorRef | null>;
  upsertContacts(tenantId: string, matterId: string, parties: InTouchParty[]): Promise<void>;
  /** Mirror a document. `fetchBytes` is called only when this store keeps bytes locally. */
  upsertDocument(tenantId: string, matterId: string, d: InTouchDocument, fetchBytes: () => Promise<{ bytes: Buffer; mimeType: string | null; fileName: string | null }>): Promise<{ documentId: string; created: boolean }>;
  /** Our user for InTouch's fee earner (matched by email), or null. */
  feeEarnerToUser(tenantId: string, fe: InTouchCase['feeEarner']): Promise<string | null>;
  /** Has this InTouch fact already been applied? Keyed on the InTouch resource id. */
  seen(tenantId: string, kind: 'identity_check' | 'form' | 'document' | 'milestone', externalId: string): Promise<boolean>;
  markSeen(tenantId: string, matterId: string, kind: 'identity_check' | 'form' | 'document' | 'milestone', externalId: string, detail?: string | null): Promise<void>;
  setMilestone(tenantId: string, matterId: string, milestone: string): Promise<void>;
  casesWatermark(tenantId: string): Promise<string | null>;
  setCasesWatermark(tenantId: string, iso: string): Promise<void>;
  /** Every mirrored case the engine has enrolled — polled on every sync, changed or not. */
  mirrors(tenantId: string): Promise<InTouchMirrorRef[]>;
  recordSync(tenantId: string, detail: InTouchSyncSummary): Promise<void>;
  milestonesEnabled(tenantId: string): Promise<boolean>;
  /** Write-back (writeback.ts); absent where the store cannot (older test stores). */
  writeback?: InTouchWritebackStore;
}

export interface InTouchSyncDeps {
  api: InTouchApi;
  store: InTouchMirrorStore;
  engine: EngineService;
  /** Whose name new matters are created under when InTouch has no matching fee earner. */
  systemUserId: string | null;
  log: (msg: string, detail?: unknown) => void;
  now?: () => Date;
}

/**
 * Did the machine refuse this because it does not belong on this matter, rather than
 * because something went wrong? That is a skip, not an error: a firm's sync summary
 * should go red for faults, not for the engine doing its job.
 */
function notApplicable(err: unknown): boolean {
  const m = err instanceof Error ? err.message : '';
  return /does not apply|is only valid at|not enrolled|manual handling/i.test(m);
}

const empty = (): InTouchSyncSummary => ({ cases: 0, created: 0, parties: 0, documents: 0, milestones: 0, skipped: 0, errors: [] });

/** A case worth mirroring: the client has actually instructed the firm. A quote has not. */
export function isEnrollableCase(c: InTouchCase): boolean {
  return c.status === 'instructed' || c.status === 'active';
}

/** One full sync pass for a firm. Safe to run on a schedule and after a webhook. */
export async function syncInTouch(deps: InTouchSyncDeps, tenantId: string, opts: { full?: boolean } = {}): Promise<InTouchSyncSummary> {
  const out = empty();
  const now = deps.now ?? (() => new Date());
  const since = opts.full ? null : await deps.store.casesWatermark(tenantId);
  const started = now().toISOString();

  // 1. Cases that are new or have changed.
  let cursor: string | null = null;
  do {
    const page = await deps.api.listCases({ cursor, updatedSince: since, limit: 100 });
    cursor = page.next;
    for (const c of page.items) {
      try {
        if (!isEnrollableCase(c)) {
          out.skipped += 1;
          continue;
        }
        out.cases += 1;
        const assignedTo = await deps.store.feeEarnerToUser(tenantId, c.feeEarner);
        const { matterId, created } = await deps.store.upsertMatter(tenantId, c, { assignedTo, createdBy: assignedTo ?? deps.systemUserId });
        if (created) out.created += 1;
        const parties = await deps.api.caseParties(c.id);
        if (parties.length) {
          await deps.store.upsertContacts(tenantId, matterId, parties);
          out.parties += parties.length;
        }
      } catch (err) {
        out.errors.push(`case ${c.id}: ${(err as Error).message}`);
      }
    }
  } while (cursor);

  // 2. Everything the client produced, on every mirrored case — not only the changed ones.
  //    A form completed at 2am on a case whose header never changed still has to land.
  for (const ref of await deps.store.mirrors(tenantId)) {
    try {
      await applyCaseFacts(deps, tenantId, ref, out);
      if (await deps.store.milestonesEnabled(tenantId)) await pushMilestone(deps, tenantId, ref, out);
      await pushWriteback(deps, tenantId, ref, out);
    } catch (err) {
      out.errors.push(`case ${ref.intouchCaseId}: ${(err as Error).message}`);
    }
  }

  await deps.store.setCasesWatermark(tenantId, started);
  await deps.store.recordSync(tenantId, out);
  return out;
}

/** Every file in the matter's folder, mirrored and read. Idempotent per InTouch id. */
export async function applyCaseFacts(deps: InTouchSyncDeps, tenantId: string, ref: InTouchMirrorRef, out: InTouchSyncSummary): Promise<void> {
  // ── every file in the matter's folder: the ID report, completed forms, the client's uploads ──
  let cursor: string | null = null;
  do {
    const page = await deps.api.listDocuments(ref.intouchCaseId, { cursor, limit: 100 });
    cursor = page.next;
    for (const d of page.items) {
      if (await deps.store.seen(tenantId, 'document', d.id)) continue;
      // What we filed there ourselves (write-back labels it CONVEYi) is never mirrored back.
      if ((d.category ?? '').toLowerCase() === 'conveyi') continue;
      try {
        const documentId = await mirrorDocument(deps, tenantId, ref, d);
        if (!documentId) continue;
        // The ordinary ingest path decides what the document is; InTouch's category is a
        // hint, never an instruction, and the engine's own state still vetoes it.
        // Failure is recorded, never fatal.
        const hint = hintFor(d);
        if (hint) {
          const state = await deps.engine.getState(tenantId, ref.matterId);
          const action = routeClassification(state, hint);
          await runAction(deps.engine, tenantId, ref.matterId, documentId, action).catch((err) => out.errors.push(`document ${d.id}: ${(err as Error).message}`));
        }
        await deps.store.markSeen(tenantId, ref.matterId, 'document', d.id, d.category);
        out.documents += 1;
      } catch (err) {
        out.errors.push(`document ${d.id}: ${(err as Error).message}`);
      }
    }
  } while (cursor);
}

/**
 * Tell the client portal where the case actually is.
 *
 * One way, and only forward: the engine is the truth, and a client who sees a case go
 * backwards loses confidence in everything else on the page. Nothing is pushed twice.
 */
export async function pushMilestone(deps: InTouchSyncDeps, tenantId: string, ref: InTouchMirrorRef, out: InTouchSyncSummary): Promise<void> {
  const view = await deps.engine.getState(tenantId, ref.matterId).catch(() => null);
  if (!view) return;
  // A matter the engine has not been asked to run knows nothing about where the case is,
  // and a matter the firm is still watching in shadow mode is not speaking yet. Neither
  // has any business telling a client anything.
  if (!view.enrolled || view.shadowMode) return;
  const { lifecycle } = await import('../../engine/graph');
  let m = milestoneFor(lifecycle(view));
  // The engine has no "reporting" phase — sending the report on title is a fact, not a
  // stage. It is the single most reassuring thing a client can see, so it wins over the
  // phase it happened in.
  if (m === 'enquiries_raised' && view.reportOnTitle?.sentAt) m = 'report_sent';
  if (!m) return;
  if (ref.lastMilestone === m) return;
  if (!isForward(ref.lastMilestone, m)) return;
  await deps.api.pushMilestone(ref.intouchCaseId, m);
  await deps.store.setMilestone(tenantId, ref.matterId, m);
  out.milestones += 1;
}

const ORDER: InTouchMilestone[] = ['instructed', 'searches_ordered', 'enquiries_raised', 'report_sent', 'ready_to_exchange', 'exchanged', 'completed'];
export function isForward(from: string | null, to: InTouchMilestone): boolean {
  if (!from) return true;
  const a = ORDER.indexOf(from as InTouchMilestone);
  const b = ORDER.indexOf(to);
  return b > a;
}

/**
 * A webhook is a POINTER. Re-read the case from InTouch; never trust the body.
 *
 *   matter_state_change           → mirror the matter and its parties, then its facts
 *   form_completion, task_state_change → the facts of the mirrored matter
 *
 * InTouch does not document a case id in the payload. When there is none, the person who
 * triggered it ("triggered.by.email") finds the matter — but only if they are a contact
 * on exactly ONE open InTouch-mirrored matter of this firm. Anything else is skipped and
 * the 15-minute poll picks it up. That is safe because nothing is taken from the body:
 * the worst a wrong pointer could do is re-read that matter's own InTouch data.
 */
export async function applyWebhook(deps: InTouchSyncDeps, tenantId: string, event: InTouchWebhookEvent): Promise<InTouchSyncSummary> {
  const out = empty();
  const known = event.type === 'matter_state_change' || event.type === 'form_completion' || event.type === 'task_state_change';
  if (!known) {
    out.skipped += 1;
    return out;
  }

  let ref: InTouchMirrorRef | null = null;
  let caseId = event.caseId;
  if (!caseId && event.triggeredByEmail) {
    ref = await deps.store.matterByContactEmail(tenantId, event.triggeredByEmail);
    caseId = ref?.intouchCaseId ?? null;
  }
  if (!caseId) {
    out.skipped += 1;
    return out;
  }

  if (event.type === 'matter_state_change') {
    const c = await deps.api.getCase(caseId);
    if (!c || !isEnrollableCase(c)) {
      out.skipped += 1;
      return out;
    }
    const assignedTo = await deps.store.feeEarnerToUser(tenantId, c.feeEarner);
    const { created } = await deps.store.upsertMatter(tenantId, c, { assignedTo, createdBy: assignedTo ?? deps.systemUserId });
    out.cases += 1;
    if (created) out.created += 1;
    ref = await deps.store.matterByCaseId(tenantId, c.id);
    if (!ref) return out;
    const parties = await deps.api.caseParties(c.id);
    if (parties.length) {
      await deps.store.upsertContacts(tenantId, ref.matterId, parties);
      out.parties += parties.length;
    }
  }

  ref ??= await deps.store.matterByCaseId(tenantId, caseId);
  if (!ref) {
    // The case is not mirrored yet — the next sync will pick it up.
    out.skipped += 1;
    return out;
  }
  await applyCaseFacts(deps, tenantId, ref, out);
  if (await deps.store.milestonesEnabled(tenantId)) await pushMilestone(deps, tenantId, ref, out);
  await pushWriteback(deps, tenantId, ref, out);
  return out;
}

/** Documents and notes back to InTouch, when the firm has them on (writeback.ts). */
async function pushWriteback(deps: InTouchSyncDeps, tenantId: string, ref: InTouchMirrorRef, out: InTouchSyncSummary): Promise<void> {
  if (!deps.store.writeback) return;
  const state = await deps.engine.getState(tenantId, ref.matterId).catch(() => null);
  const r = await writeBackToInTouch(deps.api, deps.store.writeback, tenantId, ref, state, deps.log);
  out.documentsOut = (out.documentsOut ?? 0) + r.documents;
  out.notesOut = (out.notesOut ?? 0) + r.notes;
}

// ───────────────────────────── helpers ─────────────────────────────

async function mirrorDocument(deps: InTouchSyncDeps, tenantId: string, ref: InTouchMirrorRef, d: InTouchDocument): Promise<string | null> {
  const { documentId: id } = await deps.store.upsertDocument(tenantId, ref.matterId, { ...d, caseId: ref.intouchCaseId }, () => deps.api.downloadDocument(d.id, ref.intouchCaseId));
  return id;
}

/**
 * InTouch's category → what the ingest pipeline should try to make of the document.
 * Only confident, unambiguous categories get a hint; everything else is filed and left
 * for the classifier or a person.
 */
export function hintFor(d: InTouchDocument): DocumentClassification | null {
  const c = `${d.category ?? ''} ${d.fileName}`.toLowerCase();
  const base = { searchType: null, enquiryReferences: [], titleNumber: null, lender: null, confidence: 0.75, reason: `InTouch category "${d.category ?? 'none'}", file "${d.fileName}"` };
  // A Thirdfort source-of-funds report is not the ID check: it is filed for the proof-of-funds review, never routed as one.
  if (/source[\s_-]?of[\s_-]?(funds|wealth)|\bsof\b|\bsow\b/.test(c)) return null;
  if (/id[\s_-]?report|identity|aml|kyc|thirdfort/.test(c)) return { ...base, role: 'id_check' };
  // A completed property information form, filed as a PDF in the matter's folder.
  if (/\bta[\s_-]?(6|7|10)\b|property[\s_-]?information|leasehold[\s_-]?information|fittings[\s_-]?(and|&)?[\s_-]?contents/.test(c)) return { ...base, role: 'property_forms' };
  if (/mortgage[\s_-]?offer|offer[\s_-]?of[\s_-]?loan/.test(c)) return { ...base, role: 'mortgage_offer' };
  if (/con29/.test(c)) return { ...base, role: 'search', searchType: 'CON29' };
  if (/llc1|local[\s_-]?authority/.test(c)) return { ...base, role: 'search', searchType: 'LLC1' };
  if (/water|drainage/.test(c)) return { ...base, role: 'search', searchType: 'DRAINAGE_WATER' };
  if (/environmental/.test(c)) return { ...base, role: 'search', searchType: 'ENVIRONMENTAL' };
  if (/title|register|official[\s_-]?copy/.test(c)) return { ...base, role: 'title' };
  if (/survey|valuation|homebuyer/.test(c)) return { ...base, role: 'survey' };
  if (/management[\s_-]?pack|lpe1/.test(c)) return { ...base, role: 'management_pack' };
  // A bank statement is proof-of-funds evidence, which has its own reviewed flow — it is
  // filed here and never routed as though the engine had asked for it.
  return null;
}
