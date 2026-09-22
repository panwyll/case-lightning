/**
 * InTouch → CONVEYi, and back.
 *
 * Pure orchestration over three ports — the InTouch API, a mirror store (Postgres in
 * production, memory in tests) and the engine — so the whole flow is unit-tested against
 * MockInTouch:
 *
 *   InTouch case (instructed / active)  ──► mirror matter row ──► enrol in the engine
 *   parties on the case                 ──► matter_contact rows, roles normalised
 *   a completed identity check          ──► typed ID facts ──► the engine's id_check flow
 *   a completed TA6/TA7/TA10/TA13       ──► document + property_forms_received
 *   anything else the client uploaded   ──► document row ──► the ordinary ingest path
 *   the engine's lifecycle              ──► a milestone on the client portal
 *
 * Two triggers feed the same functions — webhooks (InTouch tells us) and polling with a
 * watermark (we ask what changed) — because per-resource webhook coverage is one of the
 * things the gated reference has to confirm. Both are idempotent: every upsert is keyed
 * on the InTouch id, and every engine command is one the machine would accept by hand.
 *
 * What this file will NOT do: decide anything. An identity check that comes back "refer"
 * does not become a judgement here — it becomes the same flagged decision a conveyancer
 * would get from any other provider, and a person resolves it.
 */
import type { EngineService } from '../../engine/service';
import { routeClassification, runAction } from '../../engine/ingest';
import type { InTouchApi } from './client';
import type { DocumentClassification } from '../../engine/ports';
import type { InTouchCase, InTouchDocument, InTouchForm, InTouchIdentityCheck, InTouchParty, InTouchSyncSummary, InTouchWebhookEvent } from './types';
import { milestoneFor } from './mapping';
import { EXTERNAL, type Flag, type IdCheckFacts } from '../../engine/types';
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

const empty = (): InTouchSyncSummary => ({ cases: 0, created: 0, parties: 0, identityChecks: 0, forms: 0, documents: 0, milestones: 0, skipped: 0, errors: [] });

/** A case worth mirroring: the client has actually instructed the firm. A quote has not. */
export function isEnrollableCase(c: InTouchCase): boolean {
  return c.status === 'instructed' || c.status === 'active';
}

/**
 * InTouch's outcome → the engine's typed ID facts.
 *
 * Confidence is 1 for a result InTouch states plainly, because there is nothing to read:
 * it is not an extraction from a PDF, it is a structured answer from the system that ran
 * the check. 'unknown' is the exception — an outcome we do not recognise must never look
 * like a pass, so it becomes a refer at zero confidence and a person picks it up.
 */
export function idFactsFrom(check: InTouchIdentityCheck): IdCheckFacts {
  const flags: Flag[] = check.flags.map((f) => ({ code: f.code, severity: f.severity, description: f.description }));
  if (check.outcome === 'clear') return { provider: check.provider ?? 'InTouch', outcome: 'clear', flags, confidence: 1 };
  if (check.outcome === 'fail') return { provider: check.provider ?? 'InTouch', outcome: 'fail', flags, confidence: 1 };
  if (check.outcome === 'refer') return { provider: check.provider ?? 'InTouch', outcome: 'refer', flags, confidence: 1 };
  return {
    provider: check.provider ?? 'InTouch',
    outcome: 'refer',
    flags: [...flags, { code: 'UNRECOGNISED_OUTCOME', severity: 'medium', description: `InTouch reported an outcome this system does not recognise ("${check.outcome}"). Read the report before relying on it.` }],
    confidence: 0,
  };
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
    } catch (err) {
      out.errors.push(`case ${ref.intouchCaseId}: ${(err as Error).message}`);
    }
  }

  await deps.store.setCasesWatermark(tenantId, started);
  await deps.store.recordSync(tenantId, out);
  return out;
}

/** Identity checks, forms and documents for one mirrored case. Idempotent per InTouch id. */
export async function applyCaseFacts(deps: InTouchSyncDeps, tenantId: string, ref: InTouchMirrorRef, out: InTouchSyncSummary): Promise<void> {
  // ── identity checks ──
  for (const check of await deps.api.identityChecks(ref.intouchCaseId)) {
    if (check.outcome === 'pending') continue; // nothing to record until it finishes
    if (await deps.store.seen(tenantId, 'identity_check', check.id)) continue;
    try {
      // A decision must cite something a person can open. InTouch's report is that thing;
      // without one the check is still recorded, against the case itself.
      const documentId = check.documentId ? await mirrorDocument(deps, tenantId, ref, check.documentId) : null;
      if (!documentId) {
        out.errors.push(`identity check ${check.id}: no report document to cite`);
        continue;
      }
      // The firm ordered this check from InTouch, not from here, so the engine has no
      // request open for it. Record the request first, as external, with InTouch named as
      // the provider: a result for a check nobody asked for would be a hole in the log.
      const state = await deps.engine.getState(tenantId, ref.matterId);
      if (state.idCheck.status === 'not_started') {
        await deps.engine.run(tenantId, ref.matterId, { type: 'request_id_check', actor: EXTERNAL, provider: check.provider ?? 'InTouch', reference: check.id });
      } else if (state.idCheck.status !== 'requested') {
        // Already resolved here: a second result is filed as evidence, never replayed
        // over a conclusion a person has already reached.
        await deps.store.markSeen(tenantId, ref.matterId, 'identity_check', check.id, `${check.outcome} (filed; the engine's ID check was already ${state.idCheck.status})`);
        continue;
      }
      await deps.engine.run(tenantId, ref.matterId, { type: 'id_check_result', actor: EXTERNAL, documentId, facts: idFactsFrom(check) });
      await deps.store.markSeen(tenantId, ref.matterId, 'identity_check', check.id, check.outcome);
      out.identityChecks += 1;
    } catch (err) {
      out.errors.push(`identity check ${check.id}: ${(err as Error).message}`);
    }
  }

  // ── completed property forms ──
  const completed = (await deps.api.forms(ref.intouchCaseId)).filter((f) => f.status === 'completed' && f.code);
  for (const form of completed) {
    if (await deps.store.seen(tenantId, 'form', form.id)) continue;
    try {
      const documentId = form.documentId ? await mirrorDocument(deps, tenantId, ref, form.documentId) : null;
      await deps.engine.run(tenantId, ref.matterId, {
        type: 'property_forms_received',
        actor: EXTERNAL,
        forms: [form.code],
        documentId,
        facts: { forms: [form.code], disclosures: disclosuresFrom(form), confidence: 1 },
      });
      await deps.store.markSeen(tenantId, ref.matterId, 'form', form.id, form.code);
      out.forms += 1;
    } catch (err) {
      // A TA6 on a purchase is not a fault — property forms are the seller's side, and
      // the machine is right to refuse it. Count it, say why once, and leave it unseen so
      // it lands by itself if the matter is later enrolled as the transaction it is.
      if (notApplicable(err)) {
        out.skipped += 1;
        deps.log(`form ${form.id} (${form.code}) does not apply to this matter`, (err as Error).message);
      } else {
        out.errors.push(`form ${form.id}: ${(err as Error).message}`);
      }
    }
  }

  // ── anything else the client uploaded ──
  let cursor: string | null = null;
  do {
    const page = await deps.api.listDocuments(ref.intouchCaseId, { cursor, limit: 100 });
    cursor = page.next;
    for (const d of page.items) {
      if (await deps.store.seen(tenantId, 'document', d.id)) continue;
      try {
        const documentId = await mirrorDocument(deps, tenantId, ref, d.id, d);
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
  await deps.api.pushMilestone(ref.intouchCaseId, m, null, null);
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

/** A webhook is a POINTER. Re-read the resource from InTouch; never trust the body. */
export async function applyWebhook(deps: InTouchSyncDeps, tenantId: string, event: InTouchWebhookEvent): Promise<InTouchSyncSummary> {
  const out = empty();
  if (!event.caseId) {
    out.skipped += 1;
    return out;
  }
  if (event.type === 'case.created' || event.type === 'case.updated') {
    const c = await deps.api.getCase(event.caseId);
    if (!c || !isEnrollableCase(c)) {
      out.skipped += 1;
      return out;
    }
    const assignedTo = await deps.store.feeEarnerToUser(tenantId, c.feeEarner);
    const { matterId, created } = await deps.store.upsertMatter(tenantId, c, { assignedTo, createdBy: assignedTo ?? deps.systemUserId });
    out.cases += 1;
    if (created) out.created += 1;
    const parties = await deps.api.caseParties(c.id);
    if (parties.length) {
      await deps.store.upsertContacts(tenantId, matterId, parties);
      out.parties += parties.length;
    }
    return out;
  }
  const ref = await deps.store.matterByCaseId(tenantId, event.caseId);
  if (!ref) {
    // The case is not mirrored yet — the next full sync will pick it up.
    out.skipped += 1;
    return out;
  }
  await applyCaseFacts(deps, tenantId, ref, out);
  if (await deps.store.milestonesEnabled(tenantId)) await pushMilestone(deps, tenantId, ref, out);
  return out;
}

// ───────────────────────────── helpers ─────────────────────────────

async function mirrorDocument(deps: InTouchSyncDeps, tenantId: string, ref: InTouchMirrorRef, documentId: string, known?: InTouchDocument): Promise<string | null> {
  const d = known ?? (await deps.api.getDocument(documentId));
  if (!d) return null;
  const { documentId: id } = await deps.store.upsertDocument(tenantId, ref.matterId, { ...d, caseId: ref.intouchCaseId }, () => deps.api.downloadDocument(documentId));
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
  if (/id[\s_-]?report|identity|aml/.test(c)) return { ...base, role: 'id_check' };
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

/**
 * A completed form's answers → disclosures worth flagging.
 *
 * Deliberately narrow: this is a client's own words on a web form, not a surveyor's
 * report. It raises what the form plainly says "yes" to, so the engine can hold it for a
 * person; it never interprets, and it never silently drops an answer it cannot read.
 */
export function disclosuresFrom(form: InTouchForm): Flag[] {
  const out: Flag[] = [];
  const yes = (v: unknown) => /^(yes|true|y)$/i.test(String(v ?? '').trim());
  const WATCH: Array<[RegExp, string, Flag['severity']]> = [
    [/dispute|complaint/i, 'DISPUTE_DISCLOSED', 'high'],
    [/japanese[\s_-]?knotweed|knotweed/i, 'KNOTWEED_DISCLOSED', 'high'],
    [/flood/i, 'FLOODING_DISCLOSED', 'high'],
    [/alteration|extension|conversion/i, 'ALTERATIONS_DISCLOSED', 'medium'],
    [/boundar/i, 'BOUNDARY_DISCLOSED', 'medium'],
    [/guarantee|warrant/i, 'GUARANTEE_DISCLOSED', 'low'],
    [/right[\s_-]?of[\s_-]?way|easement/i, 'RIGHTS_DISCLOSED', 'medium'],
  ];
  for (const [key, value] of Object.entries(form.answers ?? {})) {
    const hit = WATCH.find(([re]) => re.test(key));
    if (!hit) continue;
    const text = String(value ?? '').trim();
    if (!text || /^(no|false|n|none|n\/a)$/i.test(text)) continue;
    out.push({
      code: hit[1],
      severity: hit[2],
      description: `${form.code}: the client answered "${key}" with "${text.slice(0, 200)}"${yes(text) ? '' : ''}`,
      locator: { section: key, quote: text.slice(0, 200) },
    });
  }
  return out;
}
