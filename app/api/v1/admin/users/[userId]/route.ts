import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    assertFeature('auth');
    const admin = await requireRole(['ADMIN']);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(await params);
    const { role } = z.object({ role: z.enum(['ADMIN', 'CONVEYANCER', 'ASSISTANT']) }).parse(await req.json());

    const target = await queryOne<{ role: string; is_developer: boolean }>(
      `select role, is_developer from app_user where id = $1 and tenant_id = $2 and access_removed_at is null`,
      [userId, admin.tenantId]
    );
    if (!target) return fail(new Error('User not found'));
    // A developer account is an admin account (135); it is removed, not demoted.
    if (target.is_developer) return fail(Object.assign(new Error('A developer account is always an admin. Remove their access instead.'), { status: 400 }));
    // Don't allow removing the firm's last admin. Developers don't count: the firm must
    // always keep an admin of its own.
    if (role !== 'ADMIN' && target.role === 'ADMIN') {
      const admins = await queryOne<{ n: string }>(
        `select count(*)::text as n from app_user where tenant_id = $1 and role = 'ADMIN' and not is_developer and access_removed_at is null`,
        [admin.tenantId]
      );
      if (Number(admins?.n ?? '0') <= 1) {
        return fail(new Error('Cannot remove the last admin — promote another admin first.'));
      }
    }

    const row = await queryOne<{ id: string; role: string }>(
      `update app_user set role = $1 where id = $2 and tenant_id = $3 returning id, role`,
      [role, userId, admin.tenantId]
    );
    if (!row) return fail(new Error('User not found'));

    await writeAudit({
      tenantId: admin.tenantId,
      actorUserId: admin.userId,
      actionType: 'USER_ROLE_CHANGED',
      actionStatus: 'SUCCESS',
      payload: { userId, role },
    });
    return ok({ user: row });
  } catch (error) {
    return fail(error);
  }
}
