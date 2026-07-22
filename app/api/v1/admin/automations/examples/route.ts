/** POST /api/v1/admin/automations/examples — seed the starter MANUAL automations (idempotent by name). */
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { DEFAULT_AUTOMATIONS, indexAutomation } from '@/lib/server/automations';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const added: string[] = [];
    for (const a of DEFAULT_AUTOMATIONS) {
      const exists = await queryOne<{ id: string }>(
        `select id from automation where tenant_id = $1 and name = $2`,
        [user.tenantId, a.name]
      );
      if (exists) continue;
      const row = await queryOne<{ id: string }>(
        `insert into automation (tenant_id, name, description, steps, trigger, created_by)
         values ($1,$2,$3,$4::jsonb,'MANUAL',$5) returning id`,
        [user.tenantId, a.name, a.description, JSON.stringify(a.steps), user.userId]
      );
      if (row) {
        await indexAutomation(user.tenantId, row.id, a.name, a.description);
        added.push(a.name);
      }
    }
    return ok({ added });
  } catch (error) {
    return fail(error);
  }
}
