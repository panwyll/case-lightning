/**
 * POST /api/v1/matters/:matterId/files/attach-to-reply
 *   { fileId, fileName, mimeType?, conversationId }
 *
 * Attaches a OneDrive file from the matter folder to a reply on the thread —
 * reusing an existing draft reply if there is one, else creating a reply to the
 * most recent message. Never sends.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { attachFileToThreadReply } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ matterId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z
      .object({
        fileId: z.string().min(1),
        fileName: z.string().min(1),
        mimeType: z.string().optional(),
        conversationId: z.string().min(1),
      })
      .parse(await req.json());
    await assertMatterAccess(user, matterId);

    const r = await attachFileToThreadReply(user.userId, body.conversationId, body.fileId, body.fileName, body.mimeType ?? null);
    return ok({ webLink: r.webLink, reused: r.reused, fileName: body.fileName });
  } catch (error) {
    return fail(error);
  }
}
