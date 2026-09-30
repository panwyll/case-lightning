/**
 * Secure links to files sent to a client (migration 116, docs/spec/triggers.md). The email carries
 * a link; opening it asks for a six-digit code emailed to the client's address on the case. The
 * token and the code are stored hashed; codes expire in 15 minutes and allow five tries; a link
 * lasts 60 days. Every open and download is counted.
 */
import crypto from 'node:crypto';
import { Resend } from 'resend';
import { query, queryOne, runAsSystem } from './db';
import { config } from './config';
import { contactInfo } from './comms/adapters';

const hash = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
export const fileShareUrl = (token: string) => `${config.appUrl.replace(/\/$/, '')}/f/${token}`;
const CODE_MINUTES = 15;
const CODE_TRIES = 5;
const CODES_PER_HOUR = 5;
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

/** Where the code goes: the client's address(es) on the case, shown masked on the page. */
export async function codeRecipients(share: ShareRow): Promise<string[]> {
  const info = await contactInfo(share.tenant_id, share.matter_id);
  return info.clientEmails ?? (info.clientEmail ? [info.clientEmail] : []);
}
export const maskEmail = (e: string) => e.replace(/^(.)(.*)(.@.*)$/, (_m, a: string, mid: string, b: string) => `${a}${'•'.repeat(Math.min(6, mid.length))}${b}`);

/** Email a fresh six-digit code. Returns the code in development (no mail provider) so the flow can be walked. */
export async function sendCode(share: ShareRow): Promise<{ sentTo: string[]; devCode?: string }> {
  if (share.codes_sent >= CODES_PER_HOUR && share.code_sent_at && Date.now() - Date.parse(share.code_sent_at) < 3_600_000) throw Object.assign(new Error('Too many codes asked for. Try again in an hour, or call us.'), { status: 429 });
  const to = await codeRecipients(share);
  if (!to.length) throw Object.assign(new Error('We have no email address for you on file. Please call us.'), { status: 400 });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await runAsSystem(() => query(`update file_share set code_hash = $2, code_expires_at = now() + ($3 || ' minutes')::interval, code_attempts = 0, codes_sent = case when code_sent_at < now() - interval '1 hour' then 1 else codes_sent + 1 end, code_sent_at = now() where id = $1`, [share.id, hash(`${share.id}:${code}`), String(CODE_MINUTES)]));
  if (config.resendApiKey && config.resendFromEmail) {
    await new Resend(config.resendApiKey).emails.send({ from: config.resendFromEmail, to, subject: `Your code: ${code}`, text: `Your code to open your documents is ${code}.\n\nIt works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.` });
    return { sentTo: to.map(maskEmail) };
  }
  if (process.env.NODE_ENV === 'production') throw Object.assign(new Error('We could not send the code. Please call us.'), { status: 503 });
  return { sentTo: to.map(maskEmail), devCode: code };
}

/** Check a code: true opens the files (and records the first open). */
export async function verifyCode(share: ShareRow, code: string): Promise<boolean> {
  if (!share.code_hash || !share.code_expires_at || new Date(share.code_expires_at) < new Date()) throw Object.assign(new Error('That code has expired. Ask for a new one.'), { status: 400 });
  if (share.code_attempts >= CODE_TRIES) throw Object.assign(new Error('Too many wrong codes. Ask for a new one.'), { status: 429 });
  const good = crypto.timingSafeEqual(Buffer.from(hash(`${share.id}:${code.trim()}`)), Buffer.from(share.code_hash));
  await runAsSystem(() => good
    ? query(`update file_share set code_hash = null, code_attempts = 0, first_opened_at = coalesce(first_opened_at, now()), last_opened_at = now() where id = $1`, [share.id])
    : query(`update file_share set code_attempts = code_attempts + 1 where id = $1`, [share.id]));
  return good;
}

/** The browser's proof it entered the code: signed, for this share, for ACCESS_HOURS. */
const sign = (x: string) => crypto.createHmac('sha256', config.sessionJwtSecret ?? 'dev-only').update(x).digest('base64url');
export const accessCookieName = (shareId: string) => `fs_${shareId.slice(0, 8)}`;
export function accessCookie(shareId: string): string { const until = Date.now() + ACCESS_HOURS * 3_600_000; return `${until}.${sign(`${shareId}:${until}`)}`; }
export function hasAccess(shareId: string, value: string | undefined): boolean {
  const [until, sig] = (value ?? '').split('.');
  if (!until || !sig || Number(until) < Date.now()) return false;
  const want = sign(`${shareId}:${until}`);
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

export async function countDownload(shareId: string): Promise<void> {
  await runAsSystem(() => query(`update file_share set downloads = downloads + 1, last_opened_at = now() where id = $1`, [shareId])).catch(() => {});
}
