/**
 * The client portal (migration 121, docs/spec/ui.md "Client portal"): one link per case for the
 * client. It opens with a code emailed to the client's address on the case (lib/server/access-code.ts)
 * and shows where things stand, what is waiting on them, and their documents: the files we have sent
 * them, and what they have given us. What they upload goes into the case like any other file.
 */
import crypto from 'node:crypto';
import { query, queryOne, runAsSystem } from './db';
import { config } from './config';
import { decryptSecret, encryptSecret } from './crypto';
import { putBlob } from './blob-store';
import { sendAccessCode, verifyAccessCode, accessCookieValue, cookieGrantsAccess, type CodeRow } from './access-code';

const hash = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
export const portalUrl = (token: string) => `${config.appUrl.replace(/\/$/, '')}/portal/${token}`;
/** A verified browser stays signed in to the portal for this long. */
export const PORTAL_HOURS = 24 * 7;
/** The hosting platform refuses a request body over 4.5 MB: the page shrinks photos to fit, and says so for anything larger. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const UPLOAD_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

export interface PortalRow extends CodeRow { token_enc: string; revoked_at: string | null; first_opened_at: string | null; last_opened_at: string | null; opens: number; uploads: number; created_at: string }

/** The case's live link, made the first time it is needed. Concurrent callers get the same one. */
export async function ensurePortal(tenantId: string, matterId: string): Promise<string> {
  const live = await queryOne<{ token_enc: string }>(`select token_enc from client_portal where tenant_id = $1 and matter_id = $2 and revoked_at is null`, [tenantId, matterId]);
  if (live) return portalUrl(decryptSecret(live.token_enc));
  const token = crypto.randomBytes(24).toString('base64url');
  await query(`insert into client_portal (tenant_id, matter_id, token_hash, token_enc) values ($1, $2, $3, $4) on conflict do nothing`, [tenantId, matterId, hash(token), encryptSecret(token)]);
  const now = await queryOne<{ token_enc: string }>(`select token_enc from client_portal where tenant_id = $1 and matter_id = $2 and revoked_at is null`, [tenantId, matterId]);
  return portalUrl(decryptSecret(now!.token_enc));
}

/** A new link; the old one stops working at once (a forwarded email, a shared computer). */
export async function resetPortal(tenantId: string, matterId: string): Promise<string> {
  await query(`update client_portal set revoked_at = now() where tenant_id = $1 and matter_id = $2 and revoked_at is null`, [tenantId, matterId]);
  return ensurePortal(tenantId, matterId);
}

/** For the conveyancer: the link and whether the client has used it. Null until one exists. */
export async function portalSummary(tenantId: string, matterId: string): Promise<{ url: string; createdAt: string; firstOpenedAt: string | null; lastOpenedAt: string | null; opens: number; uploads: number } | null> {
  const r = await queryOne<PortalRow>(`select * from client_portal where tenant_id = $1 and matter_id = $2 and revoked_at is null`, [tenantId, matterId]);
  return r ? { url: portalUrl(decryptSecret(r.token_enc)), createdAt: new Date(r.created_at).toISOString(), firstOpenedAt: r.first_opened_at ? new Date(r.first_opened_at).toISOString() : null, lastOpenedAt: r.last_opened_at ? new Date(r.last_opened_at).toISOString() : null, opens: r.opens, uploads: r.uploads } : null;
}

/** The live portal behind a link, or null (unknown or reset). */
export async function openPortal(token: string): Promise<PortalRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return runAsSystem(() => queryOne<PortalRow>(`select * from client_portal where token_hash = $1 and revoked_at is null`, [hash(token)]));
}

export const sendPortalCode = (row: PortalRow) => sendAccessCode('client_portal', row, 'your case');
export const verifyPortalCode = (row: PortalRow, code: string) => verifyAccessCode('client_portal', row, code);
export const portalCookieName = (id: string) => `cp_${id.slice(0, 8)}`;
export const portalCookie = (id: string) => accessCookieValue(id, PORTAL_HOURS);
export const portalAccess = (id: string, value: string | undefined) => cookieGrantsAccess(id, value);

export async function countPortalOpen(id: string): Promise<void> {
  await runAsSystem(() => query(`update client_portal set opens = opens + 1, last_opened_at = now() where id = $1`, [id])).catch(() => {});
}

export interface PortalDocument { id: string; name: string; at: string; from: 'us' | 'you' }

/**
 * The client's documents: every file we have sent them by secure link, and every file they have given
 * us through a form or the portal. Nothing else on the case (drafts, working papers, the other side's
 * papers) is listed, and only a listed file can be downloaded.
 */
export async function portalDocuments(row: { tenant_id: string; matter_id: string }): Promise<PortalDocument[]> {
  return runAsSystem(async () => {
    const sent = await query<{ id: string; name: string; at: Date }>(
      `select distinct on (u.id) u.id, u.name, s.created_at as at
         from file_share s, unnest(s.document_ids, s.file_names) as u(id, name)
         join document d on d.id = u.id and d.tenant_id = s.tenant_id
        where s.tenant_id = $1 and s.matter_id = $2
        order by u.id, s.created_at asc`,
      [row.tenant_id, row.matter_id]
    );
    const given = await query<{ id: string; name: string | null; at: Date }>(
      `select id, file_name as name, created_at as at from document
        where tenant_id = $1 and matter_id = $2 and source_type = 'CLIENT_UPLOAD' and coalesce(doc_type, '') <> 'OPEN_BANKING_ACCOUNT'
        order by created_at desc limit 200`,
      [row.tenant_id, row.matter_id]
    );
    return [
      ...sent.map((d) => ({ id: d.id, name: d.name, at: d.at.toISOString(), from: 'us' as const })),
      ...given.map((d) => ({ id: d.id, name: d.name ?? 'Document', at: d.at.toISOString(), from: 'you' as const })),
    ].sort((a, b) => b.at.localeCompare(a.at));
  });
}

/** A file the client gives us through the portal: an ordinary document on the case, its bytes kept, counted. */
export async function storePortalUpload(row: PortalRow, input: { fileName: string; mimeType: string; bytes: Buffer }): Promise<{ id: string; fileName: string }> {
  const safeName = input.fileName.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'Document';
  return runAsSystem(async () => {
    const recent = await queryOne<{ n: string }>(`select count(*)::text as n from document where matter_id = $1 and storage_path like 'portal://%' and created_at > now() - interval '1 day'`, [row.matter_id]);
    if (Number(recent?.n ?? 0) >= 60) throw Object.assign(new Error('That is a lot of files for one day. Please call us.'), { status: 429 });
    const doc = await queryOne<{ id: string }>(
      `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256)
       values ($1, $2, 'CLIENT_UPLOAD', $3, $4, $5, $6, $7) returning id`,
      [row.tenant_id, row.matter_id, `portal://${row.id}/${crypto.randomUUID()}/${safeName}`, safeName, input.mimeType, input.bytes.length, crypto.createHash('sha256').update(input.bytes).digest('hex')]
    );
    await putBlob(row.tenant_id, doc!.id, input.bytes);
    await query(`update client_portal set uploads = uploads + 1 where id = $1`, [row.id]);
    return { id: doc!.id, fileName: safeName };
  });
}
