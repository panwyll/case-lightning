import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { requireWriter } from '@/lib/server/engine/http';
import { resendClientMessage } from '@/lib/server/comms/resend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Send a message on the case's record again, exactly as it went. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ matterId: string; messageId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    requireWriter(user);
    const { matterId, messageId } = z.object({ matterId: z.string().uuid(), messageId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    return ok(await resendClientMessage(user.tenantId, matterId, messageId, user.userId));
  } catch (error) {
    return fail(error);
  }
}
