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

    const rows = matterId
      ? await query(
          `select * from audit_log where tenant_id = $1 and matter_id = $2 order by created_at desc limit $3`,
          [user.tenantId, matterId, limit]
        )
      : await query(`select * from audit_log where tenant_id = $1 order by created_at desc limit $2`, [
          user.tenantId,
          limit,
        ]);
    return ok({ logs: rows });
  } catch (error) {
    return fail(error);
  }
}
