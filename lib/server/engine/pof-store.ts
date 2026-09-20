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
