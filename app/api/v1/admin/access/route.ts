import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';
import { addGrant, caseAccessMode, listGrants, removeGrant, setCaseAccessMode } from '@/lib/server/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's access rules: the case-access mode and every grant. Admin only; every change audited. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const [mode, grants] = await Promise.all([caseAccessMode(user.tenantId), listGrants(user.tenantId)]);
    return ok({ mode, grants });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { mode } = z.object({ mode: z.enum(['open', 'granted']) }).parse(await req.json());
    await setCaseAccessMode(user.tenantId, mode, user.userId);
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'ACCESS_MODE_CHANGED', actionStatus: 'SUCCESS', payload: { mode } }).catch(() => {});
    return ok({ mode });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const input = z
      .object({ granteeUserId: z.string().uuid(), kind: z.enum(['case', 'cover', 'mailbox']), matterId: z.string().uuid().nullish(), subjectUserId: z.string().uuid().nullish(), endsAt: z.string().max(40).nullish() })
      .parse(await req.json());
    const id = await addGrant(user.tenantId, user.userId, { ...input, endsAt: input.endsAt ? new Date(input.endsAt).toISOString() : null });
    await writeAudit({ tenantId: user.tenantId, matterId: input.matterId ?? null, actorUserId: user.userId, actionType: 'ACCESS_GRANTED', actionStatus: 'SUCCESS', payload: input }).catch(() => {});
    return ok({ id, grants: await listGrants(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const id = z.string().uuid().parse(req.nextUrl.searchParams.get('id'));
    await removeGrant(user.tenantId, id);
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'ACCESS_REVOKED', actionStatus: 'SUCCESS', payload: { id } }).catch(() => {});
    return ok({ grants: await listGrants(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}
