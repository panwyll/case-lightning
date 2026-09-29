import { assertEntitled } from '@/lib/server/plan';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { query, queryOne } from '@/lib/server/db';
import { requireWriter } from '@/lib/server/engine/http';
import { adoptStoredBlob } from '@/lib/server/blob-store';
import { UploadRoutingSchema, routeUpload } from '@/lib/server/engine/case-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** The browser has put the file into storage: record it as held, then route it like any upload. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    // A suspended firm (unpaid past its grace) can read its cases but not act on them.
    await assertEntitled(user.tenantId);
    requireWriter(user);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const body = UploadRoutingSchema.extend({ documentId: z.string().uuid() }).parse(await req.json());
    const doc = await queryOne<{ id: string }>(`select id from document where id = $1 and tenant_id = $2 and matter_id = $3 and source_type = 'ENGINE_UPLOAD'`, [body.documentId, user.tenantId, matterId]);
    if (!doc) return fail(Object.assign(new Error('Upload not found.'), { status: 404 }));
    const bytes = await adoptStoredBlob(user.tenantId, body.documentId);
    await query(`update document set hash_sha256 = $3, size_bytes = $4 where id = $1 and tenant_id = $2`, [body.documentId, user.tenantId, crypto.createHash('sha256').update(bytes).digest('hex'), bytes.length]);
    return ok(await routeUpload(user, matterId, body.documentId, body));
  } catch (error) {
    return fail(error);
  }
}
