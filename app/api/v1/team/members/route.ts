import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { hasTeamAccess } from '@/lib/server/plan';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The firm's colleagues, for the "assign to" picker. Readable by any signed-in member (the
 * admin/users endpoint is ADMIN-only and returns more). Returns just the whole firm — on a
 * single-seat firm that's only the one person, so the picker simply won't offer anyone else.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const team = await hasTeamAccess(user.tenantId).catch(() => false);
    const members = await query<{ id: string; display_name: string | null; email: string; role: string }>(
      `select id, display_name, email, role
         from app_user
        where tenant_id = $1 and role <> 'READ_ONLY'
        order by (id = $2) desc, coalesce(display_name, email) asc`,
      [user.tenantId, user.userId]
    );
    return ok({ team, members, me: user.userId });
  } catch (error) {
    return fail(error);
  }
}
