import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { listMessageAttachmentsMeta } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Attachment metadata (Graph ids) for an open message — used to pick a doc to review. */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const messageId = z.string().min(1).parse(req.nextUrl.searchParams.get('messageId'));

    const attachments = await listMessageAttachmentsMeta(user.userId, messageId);
    return ok({
      attachments: attachments.map((a: any) => ({
        id: a.id,
        name: a.name,
        contentType: a.contentType ?? null,
        size: a.size ?? null,
      })),
    });
  } catch (error) {
    return fail(error);
  }
}
