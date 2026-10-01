/**
 * Secure links to files sent to a client (migration 116, docs/spec/triggers.md). The email carries
 * a link; opening it asks for a six-digit code emailed to the client's address on the case. The
 * token and the code are stored hashed; codes expire in 15 minutes and allow five tries; a link
 * lasts 60 days. Every open and download is counted.
 */
import crypto from 'node:crypto';
import { query, queryOne, runAsSystem } from './db';
import { config } from './config';
import { accessCookieValue, cookieGrantsAccess, sendAccessCode, verifyAccessCode } from './access-code';

const hash = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
export const fileShareUrl = (token: string) => `${config.appUrl.replace(/\/$/, '')}/f/${token}`;
/** A verified browser keeps the files open for this long. */
export const ACCESS_HOURS = 24;

export interface ShareRow {
  id: string; tenant_id: string; matter_id: string; document_ids: string[]; file_names: string[];
  expires_at: string; code_hash: string | null; code_expires_at: string | null; code_attempts: number; codes_sent: number; code_sent_at: string | null;
  first_opened_at: string | null; downloads: number;
}

export class PgFileShares {
  readonly name = 'pg-file-shares';
  async create(input: { tenantId: string; matterId: string; files: Array<{ id: string; fileName: string }> }): Promise<{ url: string }> {
    const token = crypto.randomBytes(24).toString('base64url');
    await query(`insert into file_share (tenant_id, matter_id, token_hash, document_ids, file_names) values ($1, $2, $3, $4::uuid[], $5::text[])`, [input.tenantId, input.matterId, hash(token), input.files.map((f) => f.id), input.files.map((f) => f.fileName)]);
    return { url: fileShareUrl(token) };
  }
  async latest(tenantId: string, matterId: string): Promise<Array<{ id: string; fileName: string }>> {
    const r = await queryOne<{ document_ids: string[]; file_names: string[] }>(`select document_ids, file_names from file_share where tenant_id = $1 and matter_id = $2 order by created_at desc limit 1`, [tenantId, matterId]);
    return r ? r.document_ids.map((id, i) => ({ id, fileName: r.file_names[i] ?? 'Document' })) : [];
  }
}

/** The live share behind a link, or null (unknown or expired). */
export async function openShare(token: string): Promise<ShareRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return runAsSystem(async () => {
    const row = await queryOne<ShareRow>(`select * from file_share where token_hash = $1`, [hash(token)]);
    return row && new Date(row.expires_at) > new Date() ? row : null;
  });
}

export { codeRecipients, maskEmail } from './access-code';

/** Email a fresh six-digit code. Returns the code in development (no mail provider) so the flow can be walked. */
export const sendCode = (share: ShareRow) => sendAccessCode('file_share', share, 'your documents');
/** Check a code: true opens the files (and records the first open). */
export const verifyCode = (share: ShareRow, code: string) => verifyAccessCode('file_share', share, code);

/** The browser's proof it entered the code: signed, for this share, for ACCESS_HOURS. */
export const accessCookieName = (shareId: string) => `fs_${shareId.slice(0, 8)}`;
export const accessCookie = (shareId: string): string => accessCookieValue(shareId, ACCESS_HOURS);
export const hasAccess = (shareId: string, value: string | undefined): boolean => cookieGrantsAccess(shareId, value);

export async function countDownload(shareId: string): Promise<void> {
  await runAsSystem(() => query(`update file_share set downloads = downloads + 1, last_opened_at = now() where id = $1`, [shareId])).catch(() => {});
}
