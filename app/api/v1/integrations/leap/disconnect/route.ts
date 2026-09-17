import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { disconnectLeap } from '@/lib/server/integrations/leap/adapters';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Drop the tokens (admins). Mirrored matters stay; nothing is deleted. */
export async function POST() {
  try {
    assertFeature('db');
    const user = await requireRole(['ADMIN']);
    await disconnectLeap(user.tenantId, `disconnected by ${user.email}`);
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'LEAP_DISCONNECTED', actionStatus: 'SUCCESS', payload: {} }).catch(() => {});
    return ok({ disconnected: true });
  } catch (error) {
    return fail(error);
  }
}
