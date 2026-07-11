import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { cancelScheduledSend } from '@/lib/server/scheduledSend';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cancel a pending deferred send within its grace window. The Outlook draft is left in
 *  place so the user can still edit/send it manually. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { id } = z.object({ id: z.string().uuid() }).parse(await req.json());
    const cancelled = await cancelScheduledSend(user.tenantId, id);
    return ok({ cancelled });
  } catch (error) {
    return fail(error);
  }
}
