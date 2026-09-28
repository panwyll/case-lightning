import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { requireWriter } from '@/lib/server/engine/http';
import { signedUploadUrl } from '@/lib/server/blob-store';
import { UploadRoutingSchema, createUploadDocument } from '@/lib/server/engine/case-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A large file: the document row now, and a one-time link the browser puts the file to directly
 * (so it never passes the web server's size cap). `uploadUrl` null: storage is not configured;
 * send it the ordinary way instead.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    requireWriter(user);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const body = UploadRoutingSchema.extend({ size: z.number().int().positive().max(100 * 1024 * 1024) }).parse(await req.json());
    const documentId = await createUploadDocument(user, matterId, body, null, body.size);
    const uploadUrl = await signedUploadUrl(user.tenantId, documentId).catch(() => null);
    if (!uploadUrl) {
      await query(`delete from document where id = $1 and tenant_id = $2`, [documentId, user.tenantId]).catch(() => {});
      return ok({ documentId: null, uploadUrl: null });
    }
    return ok({ documentId, uploadUrl });
  } catch (error) {
    return fail(error);
  }
}
