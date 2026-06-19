import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const users = await query(
      `select id, email, display_name, role, created_at from app_user where tenant_id = $1 order by created_at asc`,
      [user.tenantId]
    );
    return ok({ users });
  } catch (error) {
    return fail(error);
  }
}
