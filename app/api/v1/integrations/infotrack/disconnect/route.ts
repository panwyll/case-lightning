import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { markInfoTrack } from '@/lib/server/integrations/infotrack-adapters';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stop ordering on the firm's InfoTrack account, at once: new searches fall back to placeholders
 * and ID checks to our own request. Results of orders already placed are still accepted (they are
 * paid for). The saved details stay, so reconnecting is one click.
 */
export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin disconnects InfoTrack.'), { status: 403 });
    await markInfoTrack(user.tenantId, 'DISCONNECTED', 'Disconnected by the firm');
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'INFOTRACK_DISCONNECTED', actionStatus: 'SUCCESS', payload: {} }).catch(() => {});
    return ok({ disconnected: true });
  } catch (error) {
    return fail(error);
  }
}
