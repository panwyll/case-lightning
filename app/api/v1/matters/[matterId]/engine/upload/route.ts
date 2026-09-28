import { NextRequest } from 'next/server';
import { putBlob } from '@/lib/server/blob-store';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { requireWriter } from '@/lib/server/engine/http';
import { UploadRoutingSchema, createUploadDocument, routeUpload } from '@/lib/server/engine/case-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * File a document straight into the engine, the bytes in the request (small files; a large one
 * goes straight to storage through upload/start and upload/finish, past the web server's size cap).
 * `facts` is an optional pre-extracted payload for environments without a model key.
 */
const bodySchema = UploadRoutingSchema.extend({ base64: z.string().min(1) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    requireWriter(user);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const body = bodySchema.parse(await req.json());
    const bytes = Buffer.from(body.base64, 'base64');
    if (!bytes.length) throw Object.assign(new Error('Empty file.'), { status: 400 });
    if (bytes.length > 25 * 1024 * 1024) throw Object.assign(new Error('File too large (25 MB max).'), { status: 413 });
    const documentId = await createUploadDocument(user, matterId, body, bytes);
    await putBlob(user.tenantId, documentId, bytes, { mime: body.mimeType });
    return ok(await routeUpload(user, matterId, documentId, body));
  } catch (error) {
    return fail(error);
  }
}
