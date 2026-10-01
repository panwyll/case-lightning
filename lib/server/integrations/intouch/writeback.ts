/**
 * CONVEYi → InTouch: write-back, so InTouch stays the firm's system of record (docs/intouch-integration.md
 * "Writing back"). Two things, each off until the firm turns it on:
 *
 *   - documents: what CONVEYi files on a mirrored case (letters it generated, the proof-of-funds
 *     declaration, emails filed, the client's uploads to our forms) is filed on the InTouch case.
 *     Never drafts, internal working papers or raw bank data. A document uploaded is stamped with
 *     InTouch's id for it, so the next sync recognises it and never mirrors it back;
 *   - notes: one line on the InTouch case for each significant thing the engine records (stage
 *     moves, searches ordered, chases, client updates, enquiries, issues, exchange, completion).
 *
 * Same rules as milestones: only for a matter the engine runs, never in shadow mode; once per
 * document and per event (keyed in intouch_applied); a failure is retried by the next sync.
 */
import { NOTE_TYPES } from '../leap/writeback';
import type { InTouchApi } from './client';
import type { EngineEvent, MatterState } from '../../engine/types';

/** What InTouch is never sent: drafts, internal working papers, raw bank data. */
export const NOT_SENT_TO_INTOUCH: ReadonlySet<string> = new Set(['REPORT_ON_TITLE_DRAFT', 'PROPOSAL', 'ESCALATION_DOSSIER', 'DEADLINE_DOSSIER', 'BANK_DETAILS_NOTE', 'SANDBOX_EMAIL', 'OPEN_BANKING_ACCOUNT']);

/** One line per event for the InTouch case notes: LEAP's file-note wording, plus issues and the client's forms. */
export const INTOUCH_NOTE: Record<string, (p: Record<string, unknown>) => string> = {
  ...NOTE_TYPES,
  issue_raised: (p) => `Issue raised: ${String(p.title ?? '').replace(/\s*\[[a-z-]+:[^\]]*\]/g, '')}${p.gate && p.gate !== 'none' ? ` (holds ${p.gate})` : ''}`,
  issue_resolved: (p) => `Issue resolved (${String(p.resolution ?? '').replace(/_/g, ' ')})${p.note ? `: ${p.note}` : ''}`,
  proof_of_funds_submitted: () => 'Proof of funds submitted by the client',
  proof_of_funds_approved: () => 'Proof of funds signed off',
  deposit_received: () => 'Deposit received',
};

export interface InTouchWritebackStore {
  writebackOptions(tenantId: string): Promise<{ documents: boolean; notes: boolean }>;
  /** Documents on the matter not from InTouch and not yet sent, oldest first. */
  outgoingDocuments(tenantId: string, matterId: string): Promise<Array<{ id: string; fileName: string; docType: string | null }>>;
  documentBytes(tenantId: string, documentId: string): Promise<{ name: string; bytes: Buffer; contentType: string } | null>;
  /** Our document now exists in InTouch as `intouchId`. */
  documentSent(tenantId: string, matterId: string, documentId: string, intouchId: string): Promise<void>;
  /** The matter's events of the given types not yet noted, oldest first. */
  unnotedEvents(tenantId: string, matterId: string, types: string[]): Promise<EngineEvent[]>;
  eventNoted(tenantId: string, matterId: string, eventId: string): Promise<void>;
}

export async function writeBackToInTouch(api: InTouchApi, store: InTouchWritebackStore, tenantId: string, ref: { matterId: string; intouchCaseId: string }, state: MatterState | null, log: (m: string, d?: unknown) => void): Promise<{ documents: number; notes: number }> {
  const out = { documents: 0, notes: 0 };
  if (!state || !state.enrolled || state.shadowMode) return out;
  const opts = await store.writebackOptions(tenantId);
  if (opts.documents) {
    for (const d of (await store.outgoingDocuments(tenantId, ref.matterId)).filter((x) => !NOT_SENT_TO_INTOUCH.has(x.docType ?? ''))) {
      const file = await store.documentBytes(tenantId, d.id).catch(() => null);
      if (!file) continue;
      try {
        const { id } = await api.uploadDocument(ref.intouchCaseId, { fileName: file.name || d.fileName, mimeType: file.contentType, bytes: file.bytes, category: 'conveyi' });
        await store.documentSent(tenantId, ref.matterId, d.id, id);
        out.documents += 1;
      } catch (err) { log(`document ${d.id} not sent to InTouch (retried next sync)`, err); break; }
    }
  }
  if (opts.notes) {
    for (const e of await store.unnotedEvents(tenantId, ref.matterId, Object.keys(INTOUCH_NOTE))) {
      const line = INTOUCH_NOTE[e.type]?.(e.payload as Record<string, unknown>);
      if (!line) { await store.eventNoted(tenantId, ref.matterId, e.id); continue; }
      try {
        await api.addNote(ref.intouchCaseId, `CONVEYi · ${e.createdAt.slice(0, 16).replace('T', ' ')} · ${line}`);
        await store.eventNoted(tenantId, ref.matterId, e.id);
        out.notes += 1;
      } catch (err) { log(`note for event ${e.id} not sent to InTouch (retried next sync)`, err); break; }
    }
  }
  return out;
}
