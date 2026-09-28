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
export async function moveBlobsToStorage(limit = 50, tenantId: string | null = null): Promise<{ moved: number; left: number }> {
  if (!storageConfigured()) return { moved: 0, left: 0 };
  const rows = await query<{ document_id: string; tenant_id: string; bytes: Buffer; mime: string | null }>(
    `select b.document_id, b.tenant_id, b.bytes, d.mime_type as mime from document_blob b join document d on d.id = b.document_id where b.bytes is not null and b.storage_path is null ${tenantId ? 'and b.tenant_id = $2' : ''} limit $1`,
    tenantId ? [limit, tenantId] : [limit]
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
  const left = await queryOne<{ n: string }>(`select count(*)::text as n from document_blob where bytes is not null and storage_path is null ${tenantId ? 'and tenant_id = $1' : ''}`, tenantId ? [tenantId] : []).then((x) => Number(x?.n ?? 0)).catch(() => 0);
  return { moved, left };
}

/** Files we hold only in a case's OneDrive folder (filed before we kept our own copy). */
const ONEDRIVE_ONLY = `from document d where d.tenant_id = $1 and d.graph_item_id is not null and d.superseded_at is null and not exists (select 1 from document_blob b where b.document_id = d.id)`;

/** Copy OneDrive-only files into storage (downloaded as the case's drive owner), so every file is ours to read. */
export async function copyDriveFilesToStorage(tenantId: string, limit = 20): Promise<{ copied: number; failed: number; left: number }> {
  if (!storageConfigured()) return { copied: 0, failed: 0, left: 0 };
  const { driveUserFor } = await import('./matter-drive');
  const { downloadDriveItem } = await import('./graph');
  const rows = await query<{ id: string; matter_id: string; graph_item_id: string; created_by: string | null; mime_type: string | null }>(`select d.id, d.matter_id, d.graph_item_id, d.created_by, d.mime_type ${ONEDRIVE_ONLY} order by d.created_at desc limit $2`, [tenantId, limit]);
  let copied = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const owner = await driveUserFor(tenantId, r.matter_id, r.created_by ?? '');
      if (!owner) throw new Error('no drive owner');
      const bytes = await downloadDriveItem(owner, r.graph_item_id);
      await putBlob(tenantId, r.id, bytes, { mime: r.mime_type });
      copied += 1;
    } catch (e) {
      failed += 1;
      console.warn('[blob] could not copy a OneDrive file to storage', r.id, (e as Error).message);
    }
  }
  const left = await queryOne<{ n: string }>(`select count(*)::text as n ${ONEDRIVE_ONLY}`, [tenantId]).then((x) => Number(x?.n ?? 0)).catch(() => 0);
  return { copied, failed, left };
}

/** Where this firm's files are held: in storage, still in the database, only in OneDrive. */
export async function storageCounts(tenantId: string): Promise<{ inStorage: number; inDatabase: number; oneDriveOnly: number; configured: boolean }> {
  const [a, b, c] = await Promise.all([
    queryOne<{ n: string }>(`select count(*)::text as n from document_blob where tenant_id = $1 and storage_path is not null`, [tenantId]),
    queryOne<{ n: string }>(`select count(*)::text as n from document_blob where tenant_id = $1 and bytes is not null and storage_path is null`, [tenantId]),
    queryOne<{ n: string }>(`select count(*)::text as n ${ONEDRIVE_ONLY}`, [tenantId]),
  ]);
  return { inStorage: Number(a?.n ?? 0), inDatabase: Number(b?.n ?? 0), oneDriveOnly: Number(c?.n ?? 0), configured: storageConfigured() };
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
