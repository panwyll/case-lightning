import { NextRequest } from 'next/server';
import { z } from 'zod';
import crypto from 'node:crypto';
import { ok, fail } from '@/lib/server/http';
import { query, queryOne, runAsSystem } from '@/lib/server/db';
import { openRequestByToken } from '@/lib/server/engine/pof-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 24;
const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp']);

const bodySchema = z.object({ fileName: z.string().min(1).max(200), mimeType: z.string().min(1).max(100), base64: z.string().min(1) });

/**
 * A client attaches evidence (statements, gift letter, donor ID) to their proof-of-funds
 * form. The file becomes an ordinary document on the matter (bytes in document_blob), tagged
 * to the request so the submission route can check every referenced id belongs to it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const body = bodySchema.parse(await req.json());
    if (!ALLOWED.has(body.mimeType)) throw Object.assign(new Error('Please attach a PDF or a photo (JPEG, PNG, HEIC).'), { status: 415 });
    const bytes = Buffer.from(body.base64, 'base64');
    if (!bytes.length) throw Object.assign(new Error('Empty file.'), { status: 400 });
    if (bytes.length > MAX_BYTES) throw Object.assign(new Error('File too large (15 MB max).'), { status: 413 });
    const doc = await runAsSystem(async () => {
      const pof = await openRequestByToken(token);
      if (!pof || pof.status !== 'requested') throw Object.assign(new Error('This link is not valid or has already been used.'), { status: 404 });
      const n = await queryOne<{ n: string }>(`select count(*)::text as n from document where storage_path like $1`, [`pof://${pof.id}/%`]);
      if (Number(n?.n ?? 0) >= MAX_FILES) throw Object.assign(new Error('Too many files on this form.'), { status: 429 });
      const safeName = body.fileName.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
      const row = await queryOne<{ id: string }>(
        `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type)
         values ($1,$2,'CLIENT_UPLOAD',$3,$4,$5,$6,$7,'PROOF_OF_FUNDS_EVIDENCE') returning id`,
        [pof.tenant_id, pof.matter_id, `pof://${pof.id}/${crypto.randomUUID()}/${safeName}`, safeName, body.mimeType, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex')]
      );
      await query(`insert into document_blob (document_id, tenant_id, bytes) values ($1,$2,$3)`, [row!.id, pof.tenant_id, bytes]);
      return { id: row!.id, fileName: safeName, size: bytes.length };
    });
    return ok(doc);
  } catch (error) {
    return fail(error);
  }
}
