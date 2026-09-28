/**
 * Where the files we hold ourselves live: Supabase Storage (bucket `case-documents`, private),
 * not the database. `document_blob` stays as the index of what we hold; a row carries either
 * the Storage path (every new file, and old ones once moved) or, before the move, the bytes.
 * Reading works from either, so nothing breaks mid-migration.
 */
import { query, queryOne } from './db';

const BUCKET = 'case-documents';
const url = () => (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? '';
export const storageConfigured = (): boolean => !!url() && !!key();
const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${key()}`, apikey: key(), ...extra });

let bucketReady: Promise<void> | null = null;
function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = fetch(`${url()}/storage/v1/bucket`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }) })
      .then(async (r) => {
        if (r.ok) return;
        const t = await r.text();
        if (!/already exists|Duplicate|409/i.test(`${r.status} ${t}`)) throw new Error(`Storage bucket could not be created: ${r.status} ${t.slice(0, 200)}`);
      })
      .catch((e) => { bucketReady = null; throw e; });
  }
  return bucketReady;
}

const pathOf = (tenantId: string, documentId: string) => `${tenantId}/${documentId}`;

async function upload(path: string, bytes: Buffer, mime: string): Promise<void> {
  await ensureBucket();
  const r = await fetch(`${url()}/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', headers: headers({ 'content-type': mime || 'application/octet-stream', 'x-upsert': 'true' }), body: new Uint8Array(bytes) });
  if (!r.ok) throw new Error(`Storage upload failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function download(path: string): Promise<Buffer | null> {
  const r = await fetch(`${url()}/storage/v1/object/${BUCKET}/${path}`, { headers: headers() });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`Storage download failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Keep a document's bytes. Storage when it is configured (the database only records where);
 * otherwise, as before, in the database. `replace` overwrites what is held (an unlocked copy).
 */
export async function putBlob(tenantId: string, documentId: string, bytes: Buffer, opts: { mime?: string | null; replace?: boolean } = {}): Promise<void> {
  if (storageConfigured()) {
    try {
      const path = pathOf(tenantId, documentId);
      await upload(path, bytes, opts.mime ?? 'application/octet-stream');
      await query(
        `insert into document_blob (document_id, tenant_id, bytes, storage_path, size_bytes) values ($1, $2, null, $3, $4)
         on conflict (document_id) do ${opts.replace ? 'update set bytes = null, storage_path = excluded.storage_path, size_bytes = excluded.size_bytes' : 'nothing'}`,
        [documentId, tenantId, path, bytes.length]
      );
      return;
    } catch (e) {
      // Storage down or not migrated (104): the bytes are not lost, they go where they always went.
      console.warn('[blob] storage write failed, keeping the bytes in the database', (e as Error).message);
    }
  }
  await query(
    `insert into document_blob (document_id, tenant_id, bytes) values ($1, $2, $3) on conflict (document_id) do ${opts.replace ? 'update set bytes = excluded.bytes' : 'nothing'}`,
    [documentId, tenantId, bytes]
  );
}

/** A document's bytes, wherever we hold them; null when we hold none (it lives in OneDrive or LEAP). */
export async function getBlob(tenantId: string, documentId: string): Promise<Buffer | null> {
  const row = await queryOne<{ bytes: Buffer | null; storage_path: string | null }>(`select bytes, storage_path from document_blob where document_id = $1 and tenant_id = $2`, [documentId, tenantId]).catch(async () =>
    // Before migration 104: no storage_path column.
    queryOne<{ bytes: Buffer | null; storage_path: string | null }>(`select bytes, null::text as storage_path from document_blob where document_id = $1 and tenant_id = $2`, [documentId, tenantId])
  );
  if (!row) return null;
  if (row.bytes) return row.bytes;
  if (row.storage_path && storageConfigured()) return download(row.storage_path);
  return null;
}

/** The move itself: files still held in the database go to Storage, a batch at a time. */
export async function moveBlobsToStorage(limit = 50): Promise<{ moved: number; left: number }> {
  if (!storageConfigured()) return { moved: 0, left: 0 };
  const rows = await query<{ document_id: string; tenant_id: string; bytes: Buffer; mime: string | null }>(
    `select b.document_id, b.tenant_id, b.bytes, d.mime_type as mime from document_blob b join document d on d.id = b.document_id where b.bytes is not null and b.storage_path is null limit $1`,
    [limit]
  );
  let moved = 0;
  for (const r of rows) {
    try {
      const path = pathOf(r.tenant_id, r.document_id);
      await upload(path, r.bytes, r.mime ?? 'application/octet-stream');
      // Only after the upload succeeded does the database let go of the bytes.
      await query(`update document_blob set storage_path = $2, size_bytes = $3, bytes = null where document_id = $1`, [r.document_id, path, r.bytes.length]);
      moved += 1;
    } catch (e) {
      console.warn('[blob] could not move a file to storage', r.document_id, (e as Error).message);
    }
  }
  const left = await queryOne<{ n: string }>(`select count(*)::text as n from document_blob where bytes is not null and storage_path is null`).then((x) => Number(x?.n ?? 0)).catch(() => 0);
  return { moved, left };
}

/**
 * A one-time link the browser uploads a file to directly (Supabase Storage signed upload), for a
 * file too large to pass through the web server (Vercel caps a request at 4.5 MB). Null when
 * Storage is not configured: the caller sends the bytes the old way.
 */
export async function signedUploadUrl(tenantId: string, documentId: string): Promise<string | null> {
  if (!storageConfigured()) return null;
  await ensureBucket();
  const path = pathOf(tenantId, documentId);
  const r = await fetch(`${url()}/storage/v1/object/upload/sign/${BUCKET}/${path}`, { method: 'POST', headers: headers({ 'content-type': 'application/json', 'x-upsert': 'true' }), body: '{}' });
  if (!r.ok) throw new Error(`Storage upload link failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { url?: string };
  if (!j.url) throw new Error('Storage returned no upload link.');
  return `${url()}/storage/v1${j.url}`;
}

/** A file the browser put straight into Storage: its bytes (for the hash and the reading), recorded as held. */
export async function adoptStoredBlob(tenantId: string, documentId: string): Promise<Buffer> {
  const path = pathOf(tenantId, documentId);
  const bytes = await download(path);
  if (!bytes) throw Object.assign(new Error('The upload did not arrive in storage.'), { status: 409 });
  await query(
    `insert into document_blob (document_id, tenant_id, bytes, storage_path, size_bytes) values ($1, $2, null, $3, $4)
     on conflict (document_id) do update set bytes = null, storage_path = excluded.storage_path, size_bytes = excluded.size_bytes`,
    [documentId, tenantId, path, bytes.length]
  );
  return bytes;
}
