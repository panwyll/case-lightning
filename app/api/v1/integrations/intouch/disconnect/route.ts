import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { disconnectInTouch } from '@/lib/server/integrations/intouch/adapters';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stop reading from InTouch and stop pushing milestones, at once. What is already
 * mirrored stays on the matter — it is the firm's own case file, and deleting a client's
 * ID report because a connection was turned off would be its own kind of failure.
 */
export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin disconnects InTouch.'), { status: 403 });
    await disconnectInTouch(user.tenantId);
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'INTOUCH_DISCONNECTED', actionStatus: 'SUCCESS', payload: {} }).catch(() => {});
    return ok({ disconnected: true });
  } catch (error) {
    return fail(error);
  }
}
