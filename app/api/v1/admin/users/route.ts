import { NextRequest } from 'next/server';
import { z } from 'zod';
import crypto from 'node:crypto';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { writeAudit } from '@/lib/server/audit';
import { requestSignInLink } from '@/lib/server/sign-in-links';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's people, developer accounts labelled. Accounts whose access was removed are gone. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const users = await query(
      `select u.id, u.email, u.display_name, u.role, u.created_at, u.is_developer,
              coalesce(a.display_name, a.email) as added_by_name
         from app_user u left join app_user a on a.id = u.added_by
        where u.tenant_id = $1 and u.access_removed_at is null
        order by u.is_developer, u.created_at asc`,
      [user.tenantId]
    );
    return ok({ users });
  } catch (error) {
    return fail(error);
  }
}

const Developer = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(120),
});

/**
 * Add a developer account for setting the firm up (migration 080): an admin account,
 * labelled as a developer, never offered as a handler, free, and removable in one step.
 * They sign in by emailed link, so they need no account in the firm's Microsoft tenant.
 *
 * Only the firm's own admins add or remove developers: a developer cannot bring in others.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const admin = await requireRole(['ADMIN']);
    const me = await queryOne<{ is_developer: boolean }>(`select is_developer from app_user where id = $1`, [admin.userId]);
    if (me?.is_developer) throw Object.assign(new Error('Only one of the firm\'s own admins can add a developer.'), { status: 403 });
    const input = Developer.parse(await req.json());

    const existing = await queryOne<{ id: string; is_developer: boolean; removed: boolean }>(
      `select id, is_developer, access_removed_at is not null as removed from app_user where tenant_id = $1 and lower(email) = $2`,
      [admin.tenantId, input.email]
    );
    if (existing && !existing.removed) {
      throw Object.assign(new Error(existing.is_developer ? 'That developer already has access.' : 'That address belongs to someone in the firm already.'), { status: 409 });
    }
    // Someone whose access was removed is let back in as a developer, on the same account,
    // so their earlier actions stay attributed to them.
    const row = existing
      ? await queryOne<{ id: string }>(
          `update app_user set role = 'ADMIN', is_developer = true, display_name = $3, added_by = $4, access_removed_at = null, access_removed_by = null
            where id = $1 and tenant_id = $2 returning id`,
          [existing.id, admin.tenantId, input.name, admin.userId]
        )
      : await queryOne<{ id: string }>(
          `insert into app_user (tenant_id, entra_object_id, email, display_name, role, is_developer, added_by)
           values ($1, $2, $3, $4, 'ADMIN', true, $5) returning id`,
          [admin.tenantId, `developer:${crypto.randomUUID()}`, input.email, input.name, admin.userId]
        );

    await writeAudit({ tenantId: admin.tenantId, actorUserId: admin.userId, actionType: 'DEVELOPER_ADDED', actionStatus: 'SUCCESS', payload: { userId: row!.id, email: input.email } });
    // Their way in: a one-time sign-in link by email.
    await requestSignInLink(input.email).catch(() => {});
    return ok({ user: { id: row!.id, email: input.email, display_name: input.name, role: 'ADMIN', is_developer: true } });
  } catch (error) {
    return fail(error);
  }
}
