/**
 * GET /api/v1/admin/board — the oversight board's matters, in two piles:
 *   - live (status OPEN/legacy) → the stage columns, work in flight
 *   - done (status CLOSED)      → "Completed": recent completions, capped so the
 *                                  pile never grows unbounded (doneTotal carries
 *                                  the full count)
 * MERGED matters never appear. ADMIN. The board is editable in-place — stage /
 * status / assignee / pile are all changed via PATCH /matters/[id].
 */
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';
import { boardSelect as selectFor, type BoardMatter } from '@/lib/server/board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DONE_LIMIT = 30;

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);

    const fetch = async (withTasks: boolean) => {
      // Live board: everything except completed and merged.
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
