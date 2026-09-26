import { NextResponse } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser, signSession, SESSION_COOKIE } from '@/lib/server/session';
import { writeAudit } from '@/lib/server/audit';
import { fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Back to the admin's own account. */
export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    if (!user.actor) throw Object.assign(new Error('Not viewing as anyone.'), { status: 400 });
    const token = await signSession(user.actor.userId);
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.actor.userId, actionType: 'VIEW_AS_ENDED', actionStatus: 'SUCCESS', payload: { userId: user.userId } }).catch(() => {});
    const res = NextResponse.json({ ok: true, token });
    res.cookies.set(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 60 * 60 * 24 * 7 });
    return res;
  } catch (error) {
    return fail(error);
  }
}
