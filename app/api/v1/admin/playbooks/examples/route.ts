/** POST /api/v1/admin/playbooks/examples — seed the starter workflows (idempotent by name). */
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { DEFAULT_PLAYBOOKS, indexPlaybook } from '@/lib/server/playbooks';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const added: string[] = [];
    for (const pb of DEFAULT_PLAYBOOKS) {
      const exists = await queryOne<{ id: string }>(
        `select id from playbook where tenant_id = $1 and name = $2`,
        [user.tenantId, pb.name]
      );
      if (exists) continue;
      const row = await queryOne<{ id: string }>(
        `insert into playbook (tenant_id, name, description, steps, created_by)
         values ($1,$2,$3,$4::jsonb,$5) returning id`,
        [user.tenantId, pb.name, pb.description, JSON.stringify(pb.steps), user.userId]
      );
      if (row) {
        await indexPlaybook(user.tenantId, row.id, pb.name, pb.description);
        added.push(pb.name);
      }
    }
    return ok({ added });
  } catch (error) {
    return fail(error);
  }
}
