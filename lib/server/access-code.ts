/**
 * The emailed six-digit code that opens a client's link (a secure file link, the client portal).
 * The code goes to the client's address(es) on the case, is stored hashed, lasts 15 minutes, allows
 * five tries, and at most five are sent an hour. A browser that enters it gets a signed cookie for
 * that link. The tables carry the same code columns (file_share, client_portal).
 */
import crypto from 'node:crypto';
import { Resend } from 'resend';
import { query, runAsSystem } from './db';
import { config } from './config';
import { contactInfo } from './comms/adapters';

export type CodeTable = 'file_share' | 'client_portal';
export interface CodeRow { id: string; tenant_id: string; matter_id: string; code_hash: string | null; code_expires_at: string | null; code_attempts: number; codes_sent: number; code_sent_at: string | null }

const CODE_MINUTES = 15;
const CODE_TRIES = 5;
const CODES_PER_HOUR = 5;
const hash = (x: string) => crypto.createHash('sha256').update(x).digest('hex');

/** Where the code goes: the client's address(es) on the case, shown masked on the page. */
export async function codeRecipients(row: { tenant_id: string; matter_id: string }): Promise<string[]> {
  const info = await contactInfo(row.tenant_id, row.matter_id);
  return info.clientEmails ?? (info.clientEmail ? [info.clientEmail] : []);
}
export const maskEmail = (e: string) => e.replace(/^(.)(.*)(.@.*)$/, (_m, a: string, mid: string, b: string) => `${a}${'•'.repeat(Math.min(6, mid.length))}${b}`);

/** Email a fresh code. Returns it in development (no mail provider) so the flow can be walked. */
export async function sendAccessCode(table: CodeTable, row: CodeRow, what: string): Promise<{ sentTo: string[]; devCode?: string }> {
  if (row.codes_sent >= CODES_PER_HOUR && row.code_sent_at && Date.now() - Date.parse(row.code_sent_at) < 3_600_000) throw Object.assign(new Error('Too many codes asked for. Try again in an hour, or call us.'), { status: 429 });
  const to = await codeRecipients(row);
  if (!to.length) throw Object.assign(new Error('We have no email address for you on file. Please call us.'), { status: 400 });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await runAsSystem(() => query(`update ${table} set code_hash = $2, code_expires_at = now() + ($3 || ' minutes')::interval, code_attempts = 0, codes_sent = case when code_sent_at < now() - interval '1 hour' then 1 else codes_sent + 1 end, code_sent_at = now() where id = $1`, [row.id, hash(`${row.id}:${code}`), String(CODE_MINUTES)]));
  if (config.resendApiKey && config.resendFromEmail) {
    await new Resend(config.resendApiKey).emails.send({ from: config.resendFromEmail, to, subject: `Your code: ${code}`, text: `Your code to open ${what} is ${code}.\n\nIt works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.` });
    return { sentTo: to.map(maskEmail) };
  }
  if (process.env.NODE_ENV === 'production') throw Object.assign(new Error('We could not send the code. Please call us.'), { status: 503 });
  return { sentTo: to.map(maskEmail), devCode: code };
}

/** Check a code: true opens the link (and records the open). */
export async function verifyAccessCode(table: CodeTable, row: CodeRow, code: string): Promise<boolean> {
  if (!row.code_hash || !row.code_expires_at || new Date(row.code_expires_at) < new Date()) throw Object.assign(new Error('That code has expired. Ask for a new one.'), { status: 400 });
  if (row.code_attempts >= CODE_TRIES) throw Object.assign(new Error('Too many wrong codes. Ask for a new one.'), { status: 429 });
  const good = crypto.timingSafeEqual(Buffer.from(hash(`${row.id}:${code.trim()}`)), Buffer.from(row.code_hash));
  await runAsSystem(() => good
    ? query(`update ${table} set code_hash = null, code_attempts = 0, first_opened_at = coalesce(first_opened_at, now()), last_opened_at = now() where id = $1`, [row.id])
    : query(`update ${table} set code_attempts = code_attempts + 1 where id = $1`, [row.id]));
  return good;
}

/** The browser's proof it entered the code: signed, for this link, for `hours`. */
const sign = (x: string) => crypto.createHmac('sha256', config.sessionJwtSecret ?? 'dev-only').update(x).digest('base64url');
export function accessCookieValue(id: string, hours: number): string { const until = Date.now() + hours * 3_600_000; return `${until}.${sign(`${id}:${until}`)}`; }
export function cookieGrantsAccess(id: string, value: string | undefined): boolean {
  const [until, sig] = (value ?? '').split('.');
  if (!until || !sig || Number(until) < Date.now()) return false;
  const want = sign(`${id}:${until}`);
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}
