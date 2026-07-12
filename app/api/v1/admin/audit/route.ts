import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { matterId, limit } = z
      .object({
        matterId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(Object.fromEntries(req.nextUrl.searchParams));

    // Join the actor (who) and matter (which case) so the log reads as a sentence,
    // not a bare action code. left joins so a system/tenant-level action still shows.
    const cols = `a.id, a.created_at, a.action_type, a.action_status, a.payload, a.matter_id,
                  coalesce(u.display_name, u.email) as actor_name, m.matter_ref`;
    const from = `from audit_log a
                  left join app_user u on u.id = a.actor_user_id
                  left join matter m on m.id = a.matter_id`;
    const rows = matterId
      ? await query(
          `select ${cols} ${from} where a.tenant_id = $1 and a.matter_id = $2 order by a.created_at desc limit $3`,
          [user.tenantId, matterId, limit]
        )
      : await query(`select ${cols} ${from} where a.tenant_id = $1 order by a.created_at desc limit $2`, [
          user.tenantId,
          limit,
        ]);
    return ok({ logs: rows });
  } catch (error) {
    return fail(error);
  }
}
