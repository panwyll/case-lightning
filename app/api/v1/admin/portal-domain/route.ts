import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { writeAudit } from '@/lib/server/audit';
import { connectPortalDomain, portalDomainStatus, removePortalDomain } from '@/lib/server/portal-domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's own address for its clients' pages (lib/server/portal-domain.ts): where it stands, and the DNS record still to add. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    return ok(await portalDomainStatus(user.tenantId));
  } catch (error) {
    return fail(error);
  }
}

/** Use this address. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { domain } = z.object({ domain: z.string().trim().min(4).max(253) }).parse(await req.json());
    const status = await connectPortalDomain(user.tenantId, domain);
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'PORTAL_DOMAIN_SET', actionStatus: 'SUCCESS', payload: { domain: status.domain } }).catch(() => {});
    return ok(status);
  } catch (error) {
    return fail(error);
  }
}

/** Back to our address. */
export async function DELETE() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const status = await removePortalDomain(user.tenantId);
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'PORTAL_DOMAIN_REMOVED', actionStatus: 'SUCCESS', payload: {} }).catch(() => {});
    return ok(status);
  } catch (error) {
    return fail(error);
  }
}
