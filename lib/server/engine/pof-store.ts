/**
 * Proof-of-funds requests (migration 073): the tokenised form rows. The token is the only
 * secret — it is stored hashed, the link carries the plain token, and a row is usable while
 * it is `requested` and unexpired. The engine log carries everything else.
 */
import crypto from 'node:crypto';
import { query, queryOne } from '../db';
import { config } from '../config';
import type { ProofOfFundsForms } from './ports';
import type { ProofOfFundsSubmission } from './proof-of-funds';

export interface PofRequestRow {
  id: string;
  tenant_id: string;
  matter_id: string;
  status: 'requested' | 'submitted' | 'expired' | 'cancelled';
  requested_by: string | null;
  requested_at: Date | string;
  expires_at: Date | string;
  follow_up_of: string | null;
  note_to_client: string | null;
  submitted_at: Date | string | null;
  submission: ProofOfFundsSubmission | null;
  document_id: string | null;
}

export const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
export const formUrlFor = (token: string): string => `${config.appUrl.replace(/\/$/, '')}/pof/${token}`;

export class PgProofOfFundsForms implements ProofOfFundsForms {
  readonly name = 'pg-pof-forms';
  async create(input: { tenantId: string; matterId: string; requestedBy: string; followUpOf?: string | null; noteToClient?: string | null }): Promise<{ requestId: string; formUrl: string }> {
    const token = crypto.randomBytes(24).toString('base64url');
    const requestedBy = /^[0-9a-f-]{36}$/i.test(input.requestedBy) ? input.requestedBy : null;
    const row = await queryOne<{ id: string }>(
      `insert into proof_of_funds_request (tenant_id, matter_id, token_hash, requested_by, follow_up_of, note_to_client)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [input.tenantId, input.matterId, hashToken(token), requestedBy, input.followUpOf && /^[0-9a-f-]{36}$/i.test(input.followUpOf) ? input.followUpOf : null, input.noteToClient ?? null]
    );
    return { requestId: row!.id, formUrl: formUrlFor(token) };
  }
}

/** The live request behind a token, or null (unknown, used, expired, cancelled). */
export async function openRequestByToken(token: string): Promise<PofRequestRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = await queryOne<PofRequestRow>(`select * from proof_of_funds_request where token_hash = $1`, [hashToken(token)]);
  if (!row) return null;
  if (row.status !== 'requested') return row; // caller shows "already submitted"
  if (new Date(row.expires_at) < new Date()) {
    await query(`update proof_of_funds_request set status = 'expired' where id = $1 and status = 'requested'`, [row.id]);
    return { ...row, status: 'expired' };
  }
  return row;
}

export async function markSubmitted(id: string, submission: ProofOfFundsSubmission, documentId: string | null): Promise<boolean> {
  const r = await query<{ id: string }>(`update proof_of_funds_request set status = 'submitted', submitted_at = now(), submission = $2::jsonb, document_id = $3 where id = $1 and status = 'requested' returning id`, [id, JSON.stringify(submission), documentId]);
  return r.length > 0;
}

export async function listRequests(tenantId: string, matterId: string): Promise<PofRequestRow[]> {
  return query<PofRequestRow>(`select * from proof_of_funds_request where tenant_id = $1 and matter_id = $2 order by requested_at desc`, [tenantId, matterId]);
}

/**
 * Read a submission the client has already made: every statement through the reader, the rules,
 * the briefing, the decision for the conveyancer. The form answered the client the moment the
 * submission was stored; this runs after, and again from the timer sweep if it did not finish
 * (a reader outage, a function cut short). A submission is read once: the machine refuses a second.
 */
export async function readSubmission(requestId: string): Promise<{ read: boolean; reason?: string }> {
  const { engine } = await import('./adapters');
  const { runAsAutomation, runAsSystem } = await import('../db');
  const { SYSTEM } = await import('./types');
  return runAsSystem(async () => {
    const req = await queryOne<PofRequestRow>(`select * from proof_of_funds_request where id = $1`, [requestId]);
    if (!req || req.status !== 'submitted' || !req.submission) return { read: false, reason: 'nothing to read' };
    if (req.document_id) return { read: true, reason: 'already read' };
    const sub = req.submission;
    const ids = Array.from(new Set([...sub.sources.flatMap((x) => [...x.evidenceDocumentIds, ...(x.gift?.donorEvidenceDocumentIds ?? [])]), ...(sub.answers ?? []).flatMap((a) => a.evidenceDocumentIds)]));
    const docs = ids.length ? await query<{ id: string; file_name: string | null }>(`select id, file_name from document where id = any($1::uuid[]) and matter_id = $2`, [ids, req.matter_id]) : [];
    const evidenceNames = Object.fromEntries(docs.map((d) => [d.id, d.file_name ?? d.id]));
    try {
      const run = await runAsAutomation(() => engine().proofOfFundsSubmitted(req.tenant_id, req.matter_id, req.id, sub, evidenceNames));
      const declaration = run.events.find((e) => e.type === 'proof_of_funds_submitted');
      await query(`update proof_of_funds_request set document_id = $2 where id = $1`, [req.id, declaration?.sourceDocumentId ?? null]);
      return { read: true };
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).trim();
      // The machine already has it (a first attempt got through before the function was cut short): record that and stop.
      if (/awaiting a submission/.test(reason)) {
        await query(`update proof_of_funds_request set document_id = coalesce(document_id, $2) where id = $1`, [req.id, req.id]).catch(() => {});
        return { read: true, reason: 'already in the case' };
      }
      // Never silent: the task says the client's answers are in but could not be read, and the sweep will try again.
      try {
        const svc = engine();
        const s = await svc.getState(req.tenant_id, req.matter_id);
        const title = "The client's proof-of-funds form is in but could not be read";
        if (s.enrolled && !Object.values(s.issues).some((i) => i.status === 'open' && i.title === title)) {
          await svc.run(req.tenant_id, req.matter_id, { type: 'raise_issue', actor: SYSTEM, kind: 'other', title, detail: `${reason}. The answers and files are safe on the case; the system tries again on its next sweep. If it keeps failing, open the files under Documents and review by hand.`, gate: 'none', severity: 'warning' });
        }
      } catch { /* logged below */ }
      console.error('[pof] submission could not be read', requestId, reason);
      return { read: false, reason };
    }
  });
}

/** Submissions stored but not yet read (older than a moment, so the after-response read has had its chance). */
export async function unreadSubmissions(olderThanSeconds = 90): Promise<string[]> {
  const rows = await query<{ id: string }>(`select id from proof_of_funds_request where status = 'submitted' and submission is not null and document_id is null and submitted_at < now() - ($1 || ' seconds')::interval order by submitted_at limit 20`, [String(Math.floor(olderThanSeconds))]).catch(() => []);
  return rows.map((r) => r.id);
}
