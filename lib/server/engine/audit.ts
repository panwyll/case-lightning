/**
 * Component #7 — audit / compliance on top of the event log.
 *
 * The log already gives attributable, timestamped, immutable history. This module adds
 * the three things a regulator or an insurer will actually ask for:
 *
 *   1. TAMPER EVIDENCE — a per-matter SHA-256 hash chain over canonical event content.
 *      `verifyChain()` proves nothing was altered, removed, reordered or inserted.
 *   2. REPLAY PROOF — `auditMatter()` re-projects the log and compares it with the
 *      cached read model, so a drifted projection is caught, not trusted.
 *   3. EXPORT — one JSON or CSV file per matter with every event, actor, source
 *      document, confidence, hash and the chain/replay verdicts.
 *
 * Everything here is pure except the exporter's store reads.
 */
import crypto from 'node:crypto';
import type { EngineEvent, MatterState, NewEvent } from './types';
import { project } from './projection';
import type { EventStore } from './store';

/** Stable JSON: sorted keys, no undefined, so the same event always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** The fields that are hashed. `id` is excluded (assigned by the store) so a re-import keeps the chain. */
export function hashableContent(e: Pick<EngineEvent, 'tenantId' | 'matterId' | 'seq' | 'type' | 'actor' | 'payload' | 'createdAt'> & { sourceDocumentId?: string | null; confidenceScore?: number | null; causedByEventId?: string | null }): string {
  return canonicalJson({
    tenantId: e.tenantId,
    matterId: e.matterId,
    seq: e.seq,
    type: e.type,
    actor: e.actor,
    payload: e.payload,
    sourceDocumentId: e.sourceDocumentId ?? null,
    confidenceScore: e.confidenceScore ?? null,
    causedByEventId: e.causedByEventId ?? null,
    createdAt: e.createdAt,
  });
}

export function eventHash(prevHash: string, e: Parameters<typeof hashableContent>[0]): string {
  return crypto.createHash('sha256').update(prevHash).update('\n').update(hashableContent(e)).digest('hex');
}

/** Assign prev_hash/hash to a batch being appended after `lastHash`. */
export function chainEvents<T extends NewEvent & { tenantId: string; matterId: string; seq: number; createdAt: string }>(lastHash: string, events: T[]): Array<T & { prevHash: string; hash: string }> {
  let prev = lastHash;
  return events.map((e) => {
    const hash = eventHash(prev, e);
    const out = { ...e, prevHash: prev, hash };
    prev = hash;
    return out;
  });
}

export interface ChainVerdict {
  ok: boolean;
  events: number;
  /** First seq whose hash does not match (or whose prev_hash is not the previous hash). */
  brokenAtSeq: number | null;
  reason: string | null;
}

/** Re-derive every hash from the content and compare. Gaps in seq are a break too. */
export function verifyChain(events: EngineEvent[]): ChainVerdict {
  let prev = '';
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i + 1) return { ok: false, events: events.length, brokenAtSeq: e.seq, reason: `sequence gap: expected ${i + 1}, found ${e.seq}` };
    if ((e.prevHash ?? '') !== prev) return { ok: false, events: events.length, brokenAtSeq: e.seq, reason: 'prev_hash does not match the previous event' };
    const expected = eventHash(prev, e);
    if (e.hash !== expected) return { ok: false, events: events.length, brokenAtSeq: e.seq, reason: 'content hash mismatch — the event was altered' };
    prev = expected;
  }
  return { ok: true, events: events.length, brokenAtSeq: null, reason: null };
}

export interface AuditReport {
  tenantId: string;
  matterId: string;
  generatedAt: string;
  chain: ChainVerdict;
  replay: { ok: boolean; detail: string };
  headHash: string | null;
  state: MatterState;
  events: EngineEvent[];
  /** Counts the compliance conversation starts with. */
  summary: {
    events: number;
    byActorKind: Record<'system' | 'ai' | 'external' | 'user', number>;
    decisions: number;
    /** Addendum 3 §2: assist-level reviews of auto-clears (advisory, non-blocking) included in `decisions`. */
    autoClearReviews: number;
    decisionsResolvedWithoutOpeningSource: number;
    aiSentWithoutApproval: number;
    stageMoves: number;
    /** Addendum requirement 4: correspondence events that crossed to an internal counterparty. */
    internalCounterpartyEvents: number;
    /** Addendum 2 §6: every fraud-risk moment and how it ended. */
    bankDetailsHardStops: { flagged: number; verified: number; failed: number; unresolved: number };
    paymentsAuthorisedWithoutVerifiedDetails: number;
  };
}

/** Full audit of one matter: chain, replay vs the read model (if supplied), and the summary. */
export function buildAuditReport(tenantId: string, matterId: string, events: EngineEvent[], cachedState: MatterState | null, now = new Date()): AuditReport {
  const chain = verifyChain(events);
  const state = project(tenantId, matterId, events);
  const replay = cachedState
    ? canonicalJson(cachedState) === canonicalJson(state)
      ? { ok: true, detail: 'read model equals replayed state' }
      : { ok: false, detail: 'read model differs from replayed state — rebuild it from the log' }
    : { ok: true, detail: 'no read model supplied; state replayed from the log' };
  const byActorKind: Record<'system' | 'ai' | 'external' | 'user', number> = { system: 0, ai: 0, external: 0, user: 0 };
  for (const e of events) {
    const kind: 'system' | 'ai' | 'external' | 'user' = e.actor === 'system' ? 'system' : e.actor === 'ai' ? 'ai' : e.actor === 'external' ? 'external' : 'user';
    byActorKind[kind] += 1;
  }
  const decisions = Object.values(state.decisions);
  const approvals = new Set(events.filter((e) => e.type === 'report_on_title_approved').map((e) => e.id));
  const aiSentWithoutApproval = events.filter((e) => e.type === 'report_on_title_sent' && !approvals.has((e.payload as { approvedEventId: string }).approvedEventId)).length;
  return {
    tenantId,
    matterId,
    generatedAt: now.toISOString(),
    chain,
    replay,
    headHash: events.length ? events[events.length - 1].hash ?? null : null,
    state,
    events,
    summary: {
      events: events.length,
      byActorKind,
      decisions: decisions.length,
      autoClearReviews: decisions.filter((d) => d.kind === 'auto_clear').length,
      decisionsResolvedWithoutOpeningSource: decisions.filter((d) => d.resolvedBy && !d.openedBy.includes(d.resolvedBy)).length,
      aiSentWithoutApproval,
      stageMoves: events.filter((e) => e.type === 'stage_advanced').length,
      internalCounterpartyEvents: events.filter((e) => (e.payload as { counterpartyType?: string }).counterpartyType === 'internal').length,
      bankDetailsHardStops: {
        flagged: events.filter((e) => e.type === 'bank_details_change_flagged').length,
        verified: events.filter((e) => e.type === 'bank_details_verified').length,
        failed: events.filter((e) => e.type === 'bank_details_verification_failed').length,
        unresolved: decisions.filter((d) => d.kind === 'bank_details' && d.status === 'pending').length,
      },
      paymentsAuthorisedWithoutVerifiedDetails: state.payments.filter((p) => state.bankDetails[p.bankDetailsId]?.verifiedAt == null).length,
    },
  };
}

export async function auditMatter(store: EventStore, tenantId: string, matterId: string, cachedState: MatterState | null): Promise<AuditReport> {
  return buildAuditReport(tenantId, matterId, await store.listEvents(tenantId, matterId), cachedState);
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per event; the payload as JSON in the last column. */
export function auditCsv(report: AuditReport): string {
  const head = ['seq', 'created_at', 'type', 'actor', 'actor_kind', 'source_document_id', 'confidence', 'decision_kind', 'decision_status', 'prev_hash', 'hash', 'payload'];
  const rows = report.events.map((e) => {
    const d = report.state.decisions[e.id];
    return [e.seq, e.createdAt, e.type, e.actor, e.actor === 'system' || e.actor === 'ai' || e.actor === 'external' ? e.actor : 'user', e.sourceDocumentId ?? '', e.confidenceScore ?? '', d?.kind ?? '', d?.status ?? '', e.prevHash ?? '', e.hash ?? '', e.payload].map(csvCell).join(',');
  });
  const meta = [`# matter ${report.matterId} · generated ${report.generatedAt} · events ${report.summary.events} · internal-counterparty events ${report.summary.internalCounterpartyEvents} · chain ${report.chain.ok ? 'OK' : `BROKEN at seq ${report.chain.brokenAtSeq}: ${report.chain.reason}`} · replay ${report.replay.ok ? 'OK' : 'MISMATCH'} · head ${report.headHash ?? ''}`];
  return [...meta, head.join(','), ...rows].join('\n') + '\n';
}
