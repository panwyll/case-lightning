import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { setInTouchConnectionMeta } from '@/lib/server/integrations/intouch/adapters';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Turn milestone updates to the client portal on or off.
 *
 * Its own route, and admin-only, because this is the one part of the connector that
 * writes to something a CLIENT sees. Flipping it is worth an audit row.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin changes what clients are sent.'), { status: 403 });
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await req.json());
    await setInTouchConnectionMeta(user.tenantId, { milestonesEnabled: enabled });
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'INTOUCH_MILESTONES_TOGGLED', actionStatus: 'SUCCESS', payload: { enabled } }).catch(() => {});
    return ok({ milestonesEnabled: enabled });
  } catch (error) {
    return fail(error);
  }
}
