import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole, signSession, SESSION_COOKIE } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { writeAudit } from '@/lib/server/audit';
import { fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * View the app as a colleague. Admin only, same firm. The session becomes the
 * colleague's with the admin remembered as the actor, so everything the colleague
 * would see — their caseload, their tasks, the wall — is exactly what the admin sees.
 * Audited on entry and on return.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    assertFeature('auth');
    const admin = await requireRole(['ADMIN']);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(await params);
    if (userId === admin.userId) throw Object.assign(new Error('That is you.'), { status: 400 });
    const target = await queryOne<{ id: string; email: string }>(`select id, email from app_user where id = $1 and tenant_id = $2`, [userId, admin.tenantId]);
    if (!target) throw Object.assign(new Error('Colleague not found.'), { status: 404 });
    // The actor is the real admin even when already viewing as someone else.
    const actorId = admin.actor?.userId ?? admin.userId;
    const token = await signSession(target.id, actorId);
    await writeAudit({ tenantId: admin.tenantId, actorUserId: actorId, actionType: 'VIEW_AS_STARTED', actionStatus: 'SUCCESS', payload: { userId: target.id, email: target.email } }).catch(() => {});
    const res = NextResponse.json({ viewingAs: { userId: target.id, email: target.email }, token });
    res.cookies.set(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 60 * 60 * 8 });
    return res;
  } catch (error) {
    return fail(error);
  }
}
