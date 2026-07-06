/**
 * GET /api/v1/admin/board — the oversight board's matters, in three piles:
 *   - active   (status OPEN/legacy)  → the stage columns
 *   - backlog  (status BACKLOG)      → "Up next": instructed but not started
 *   - done     (status CLOSED)       → "Completed": recent completions, capped so
 *                                       the pile never grows unbounded (doneTotal
 *                                       carries the full count)
 * MERGED matters never appear. ADMIN. The board is editable in-place — stage /
 * status / assignee / pile are all changed via PATCH /matters/[id].
 */
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BoardMatter {
  id: string;
  matterRef: string | null;
  propertyAddress: string | null;
  stage: string;
  status: string;
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

const DONE_LIMIT = 30;

const selectFor = (withTasks: boolean) => `
       select m.id,
              m.matter_ref           as "matterRef",
              m.property_address     as "propertyAddress",
              m.stage,
              coalesce(m.status, 'OPEN') as status,
              m.status_flag          as "statusFlag",
              m.exchange_target_date as "exchangeTargetDate",
              m.completion_target_date as "completionTargetDate",
              coalesce(u.display_name, u.email) as assignee,
              m.assigned_to          as "assignedTo",
              m.updated_at           as "updatedAt",
              m.stage_entered_at     as "stageEnteredAt"${
                withTasks
                  ? `,
              (select count(*)::int from matter_task t
                where t.matter_id = m.id and t.tenant_id = $1
                  and t.status in ('OPEN','IN_PROGRESS'))       as "openTasks",
              (select min(t.due) from matter_task t
                where t.matter_id = m.id and t.tenant_id = $1
                  and t.status in ('OPEN','IN_PROGRESS') and t.due is not null) as "nextDue"`
                  : ''
              }
         from matter m
         left join app_user u on u.id = m.assigned_to`;

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);

    const fetch = async (withTasks: boolean) => {
      // Live board: everything except completed and merged (BACKLOG rides along and
      // is split out client-side into the "Up next" pile).
      const live = await query<BoardMatter>(
        `${selectFor(withTasks)}
          where m.tenant_id = $1 and coalesce(m.status, 'OPEN') not in ('CLOSED', 'MERGED')
          order by m.updated_at desc`,
        [user.tenantId]
      );
      // Completed: most recent first, capped.
      const done = await query<BoardMatter>(
        `${selectFor(withTasks)}
          where m.tenant_id = $1 and m.status = 'CLOSED'
          order by m.updated_at desc
          limit ${DONE_LIMIT}`,
        [user.tenantId]
      );
      return [...live, ...done];
    };

    let matters: BoardMatter[];
    try {
      // With per-matter to-do signals for the card face: open task count + soonest due.
      matters = await fetch(true);
    } catch {
      // matter_task not present on this install — board still works without badges.
      matters = await fetch(false);
    }

    const doneTotal = Number(
      (
        await queryOne<{ n: string }>(
          `select count(*)::text as n from matter where tenant_id = $1 and status = 'CLOSED'`,
          [user.tenantId]
        )
      )?.n ?? '0'
    );

    return ok({ matters, doneTotal, doneShown: DONE_LIMIT });
  } catch (error) {
    return fail(error);
  }
}
