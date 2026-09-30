import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { emailThread } from '@/lib/server/email-thread';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A filed email as its conversation: the case's filed emails in the same thread plus the quoted history inside them, oldest first. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse({ documentId: req.nextUrl.searchParams.get('documentId') });
    await assertMatterAccess(user, matterId);
    const thread = await emailThread(user.tenantId, matterId, documentId);
    if (!thread) return ok({ error: 'Not an email on this case.' }, { status: 404 });
    return ok(thread);
  } catch (error) {
    return fail(error);
  }
}
