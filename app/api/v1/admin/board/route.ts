/**
 * GET /api/v1/admin/board — every live matter with the fields the oversight board
 * needs (stage, health, owner, key dates). ADMIN. Closed matters excluded. The board is
 * editable in-place — stage/status/assignee are changed via PATCH /matters/[id].
 */
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BoardMatter {
  id: string;
  matterRef: string | null;
  propertyAddress: string | null;
  stage: string;
  statusFlag: string;
  exchangeTargetDate: string | null;
  completionTargetDate: string | null;
  assignee: string | null;
  assignedTo: string | null;
  updatedAt: string;
  stageEnteredAt: string;
  openTasks?: number;
  nextDue?: string | null;
}

const BASE_SELECT = `
       select m.id,
              m.matter_ref           as "matterRef",
              m.property_address     as "propertyAddress",
              m.stage,
              m.status_flag          as "statusFlag",
              m.exchange_target_date as "exchangeTargetDate",
              m.completion_target_date as "completionTargetDate",
              coalesce(u.display_name, u.email) as assignee,
              m.assigned_to          as "assignedTo",
              m.updated_at           as "updatedAt",
              m.stage_entered_at     as "stageEnteredAt"`;

const BASE_FROM = `
         from matter m
         left join app_user u on u.id = m.assigned_to
        where m.tenant_id = $1 and coalesce(m.status, 'ACTIVE') <> 'CLOSED'
        order by m.updated_at desc`;

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    let matters: BoardMatter[];
    try {
      // With per-matter to-do signals for the card face: open task count + soonest due.
      matters = await query<BoardMatter>(
        `${BASE_SELECT},
              (select count(*)::int from matter_task t
                where t.matter_id = m.id and t.tenant_id = $1
                  and t.status in ('OPEN','IN_PROGRESS'))       as "openTasks",
              (select min(t.due) from matter_task t
                where t.matter_id = m.id and t.tenant_id = $1
                  and t.status in ('OPEN','IN_PROGRESS') and t.due is not null) as "nextDue"
         ${BASE_FROM}`,
        [user.tenantId]
      );
    } catch {
      // matter_task not present on this install — board still works without badges.
      matters = await query<BoardMatter>(`${BASE_SELECT} ${BASE_FROM}`, [user.tenantId]);
    }
    return ok({ matters });
  } catch (error) {
    return fail(error);
  }
}
