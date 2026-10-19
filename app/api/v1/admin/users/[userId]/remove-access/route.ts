import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Remove a developer's access (migration 135). Their session and any Outlook add-in token
 * stop working within the session cache's 15 seconds, and any unused sign-in link at once. The account is kept, not
 * deleted, so everything they did stays attributed to them in the history and audit log.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    assertFeature('auth');
    const admin = await requireRole(['ADMIN']);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(await params);
    const me = await queryOne<{ is_developer: boolean }>(`select is_developer from app_user where id = $1`, [admin.userId]);
    if (me?.is_developer && userId !== admin.userId) throw Object.assign(new Error('Only one of the firm\'s own admins can remove a developer.'), { status: 403 });
    const row = await queryOne<{ id: string; email: string }>(
      `update app_user set access_removed_at = now(), access_removed_by = $3, graph_access_token = null, graph_refresh_token = null
        where id = $1 and tenant_id = $2 and is_developer and access_removed_at is null returning id, email`,
      [userId, admin.tenantId, admin.userId]
    );
    if (!row) throw Object.assign(new Error('No developer with access by that id.'), { status: 404 });
    await writeAudit({ tenantId: admin.tenantId, actorUserId: admin.userId, actionType: 'DEVELOPER_ACCESS_REMOVED', actionStatus: 'SUCCESS', payload: { userId, email: row.email } });
    return ok({ removed: true });
  } catch (error) {
    return fail(error);
  }
}
