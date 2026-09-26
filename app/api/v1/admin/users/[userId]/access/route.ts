import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';
import { getPersonAccess, setPersonAccess } from '@/lib/server/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const accessSchema = z.object({
  caseAccess: z.enum(['all', 'selected']),
  mailboxAccess: z.enum(['own', 'all', 'selected']),
  covers: z.array(z.string().uuid()).max(200).default([]),
  mailboxes: z.array(z.string().uuid()).max(200).default([]),
});

/** One colleague's access: which cases and which mailboxes. Admin only; audited. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    assertFeature('auth');
    const admin = await requireRole(['ADMIN']);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(await params);
    return ok(await getPersonAccess(admin.tenantId, userId));
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    assertFeature('auth');
    const admin = await requireRole(['ADMIN']);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(await params);
    const input = accessSchema.parse(await req.json());
    await setPersonAccess(admin.tenantId, userId, admin.userId, input);
    await writeAudit({ tenantId: admin.tenantId, actorUserId: admin.userId, actionType: 'ACCESS_CHANGED', actionStatus: 'SUCCESS', payload: { userId, ...input } }).catch(() => {});
    return ok(await getPersonAccess(admin.tenantId, userId));
  } catch (error) {
    return fail(error);
  }
}
