import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { query, queryOne } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A scan of something signed (a deed back by post): kept on the case as the record, not read by a
 * model (it is the document we sent, now signed). It is what a deed's signed step is gated on.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const b = z.object({ fileName: z.string().min(1).max(200), mimeType: z.string().max(100), base64: z.string().min(1), docType: z.string().max(40).default('SIGNED_DEED') }).parse(await req.json());
    if (!/^(application\/pdf|image\/(png|jpe?g|heic|webp))$/i.test(b.mimeType)) throw Object.assign(new Error('Upload a PDF or a photo of the signed document.'), { status: 400 });
    const bytes = Buffer.from(b.base64, 'base64');
    if (!bytes.length) throw Object.assign(new Error('Empty file.'), { status: 400 });
    if (bytes.length > 25 * 1024 * 1024) throw Object.assign(new Error('File too large (25 MB max).'), { status: 413 });
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const same = await queryOne<{ id: string; file_name: string | null; doc_type: string | null; created_at: string }>(`select id, file_name, doc_type, created_at::text from document where tenant_id = $1 and matter_id = $2 and hash_sha256 = $3 limit 1`, [user.tenantId, matterId, hash]);
    if (same) return ok({ document: { id: same.id, fileName: same.file_name, docType: same.doc_type, createdAt: same.created_at, webUrl: null } });
    const doc = await queryOne<{ id: string; created_at: string }>(
      `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, created_by)
       values ($1,$2,'SCAN_UPLOAD',$3,$4,$5,$6,$7,$8,$9) returning id, created_at::text`,
      [user.tenantId, matterId, `scan://${matterId}/${b.fileName}`, b.fileName, b.mimeType, bytes.length, hash, b.docType, user.userId]
    );
    await query(`insert into document_blob (document_id, tenant_id, bytes) values ($1,$2,$3)`, [doc!.id, user.tenantId, bytes]);
    return ok({ document: { id: doc!.id, fileName: b.fileName, docType: b.docType, createdAt: doc!.created_at, webUrl: null } });
  } catch (error) {
    return fail(error);
  }
}
