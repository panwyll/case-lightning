/**
 * GET /api/v1/admin/board — every live matter with the fields the oversight board
 * needs (stage, health, owner, key dates). Read-only; ADMIN. Closed matters excluded.
 */
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
    const matters = await query<{
      id: string;
      matterRef: string | null;
      propertyAddress: string | null;
      stage: string;
      statusFlag: string;
      exchangeTargetDate: string | null;
      completionTargetDate: string | null;
      assignee: string | null;
      updatedAt: string;
    }>(
      `select m.id,
              m.matter_ref           as "matterRef",
              m.property_address     as "propertyAddress",
              m.stage,
              m.status_flag          as "statusFlag",
              m.exchange_target_date as "exchangeTargetDate",
              m.completion_target_date as "completionTargetDate",
              coalesce(u.display_name, u.email) as assignee,
              m.updated_at           as "updatedAt"
         from matter m
         left join app_user u on u.id = m.assigned_to
        where m.tenant_id = $1 and coalesce(m.status, 'ACTIVE') <> 'CLOSED'
        order by m.updated_at desc`,
      [user.tenantId]
    );
    return ok({ matters });
  } catch (error) {
    return fail(error);
  }
}
