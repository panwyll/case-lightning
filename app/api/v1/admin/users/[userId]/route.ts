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
    const { role } = z.object({ role: z.enum(['ADMIN', 'CONVEYANCER', 'ASSISTANT', 'READ_ONLY']) }).parse(await req.json());

    // Don't allow removing the last admin in a tenant.
    if (role !== 'ADMIN') {
      const admins = await queryOne<{ n: string }>(
        `select count(*)::text as n from app_user where tenant_id = $1 and role = 'ADMIN'`,
        [admin.tenantId]
      );
      const target = await queryOne<{ role: string }>(`select role from app_user where id = $1 and tenant_id = $2`, [
        userId,
        admin.tenantId,
      ]);
      if (target?.role === 'ADMIN' && Number(admins?.n ?? '0') <= 1) {
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
