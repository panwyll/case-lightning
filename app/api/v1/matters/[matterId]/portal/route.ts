import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { writeAudit } from '@/lib/server/audit';
import { ensurePortal, portalSummary, resetPortal } from '@/lib/server/client-portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The case's client portal for the conveyancer: the link and whether the client has used it. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    return ok({ portal: await portalSummary(user.tenantId, matterId) });
  } catch (error) {
    return fail(error);
  }
}

/** `link`: the live link (made if there is none). `reset`: a new link; the old one stops working at once. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const { action } = z.object({ action: z.enum(['link', 'reset']) }).parse(await req.json());
    const url = action === 'reset' ? await resetPortal(user.tenantId, matterId) : await ensurePortal(user.tenantId, matterId);
    if (action === 'reset') await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, matterId, actionType: 'CLIENT_PORTAL_RESET', actionStatus: 'SUCCESS', payload: {} }).catch(() => {});
    return ok({ url, portal: await portalSummary(user.tenantId, matterId) });
  } catch (error) {
    return fail(error);
  }
}
