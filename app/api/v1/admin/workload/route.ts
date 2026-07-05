import { assertFeature, config } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WorkloadRow {
  id: string | null; // null = the "Unassigned" bucket
  name: string;
  role: string | null;
  open_matters: number;
  needs_attention: number;
  overdue_chases: number;
  drafts_waiting: number;
}

/**
 * Person-centric admin view: for each fee-earner (plus an "Unassigned" bucket), their open
 * matters, how many need attention, overdue chases, and drafts waiting to send. The
 * supervising-partner "who's overloaded / whose cases are slipping" dashboard. ADMIN only.
 *
 * The chase/draft counts read email_thread (migration 033) and worklist_item (035); the whole
 * query is guarded so a firm that hasn't applied those yet still gets matter counts.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const admin = await requireRole(['ADMIN']);
    const sla = String(config.chaseSlaDays);

    // Per-person and unassigned in one pass: group matters by assignee, left-joined to the
    // chase/draft signals. `who` is the user id, or null for the unassigned bucket.
    const full = `
      with m as (
        select id, assigned_to as who from matter
         where tenant_id = $1 and status = 'OPEN'
      )
      select u.id, coalesce(u.display_name, u.email) as name, u.role,
             count(distinct m.id)::int as open_matters,
             count(distinct mm.id) filter (where mm.status_flag in ('NEEDS_ATTENTION','BLOCKED'))::int as needs_attention,
             count(distinct t.id) filter (
               where t.chase_awaiting_since is not null
                 and t.chase_awaiting_since < now() - ($2 || ' days')::interval
                 and coalesce(t.chase_snoozed_until, to_timestamp(0)) < now())::int as overdue_chases,
             count(distinct w.id) filter (
               where w.kind = 'DRAFT_READY' and w.done_at is null
                 and coalesce(w.snoozed_until, to_timestamp(0)) < now())::int as drafts_waiting
        from app_user u
        left join m on m.who = u.id
        left join matter mm on mm.id = m.id
        left join email_thread t on t.matter_id = m.id and t.tenant_id = $1
        left join worklist_item w on w.matter_id = m.id and w.tenant_id = $1
       where u.tenant_id = $1 and u.role <> 'READ_ONLY'
       group by u.id, name, u.role
      union all
      select null as id, 'Unassigned' as name, null as role,
             count(distinct m.id)::int,
             count(distinct mm.id) filter (where mm.status_flag in ('NEEDS_ATTENTION','BLOCKED'))::int,
             count(distinct t.id) filter (
               where t.chase_awaiting_since is not null
                 and t.chase_awaiting_since < now() - ($2 || ' days')::interval
                 and coalesce(t.chase_snoozed_until, to_timestamp(0)) < now())::int,
             count(distinct w.id) filter (
               where w.kind = 'DRAFT_READY' and w.done_at is null
                 and coalesce(w.snoozed_until, to_timestamp(0)) < now())::int
        from matter mm
        join m on m.id = mm.id and m.who is null
        left join email_thread t on t.matter_id = mm.id and t.tenant_id = $1
        left join worklist_item w on w.matter_id = mm.id and w.tenant_id = $1
       where mm.tenant_id = $1
      order by open_matters desc, name asc`;

    let rows: WorkloadRow[];
    try {
      rows = await query<WorkloadRow>(full, [admin.tenantId, sla]);
    } catch {
      // email_thread chase cols / worklist_item not migrated → matter counts only.
      rows = await query<WorkloadRow>(
        `select u.id, coalesce(u.display_name, u.email) as name, u.role,
                count(*) filter (where m.id is not null)::int as open_matters,
                count(*) filter (where m.status_flag in ('NEEDS_ATTENTION','BLOCKED'))::int as needs_attention,
                0 as overdue_chases, 0 as drafts_waiting
           from app_user u
           left join matter m on m.assigned_to = u.id and m.tenant_id = $1 and m.status = 'OPEN'
          where u.tenant_id = $1 and u.role <> 'READ_ONLY'
          group by u.id, name, u.role
          order by open_matters desc, name asc`,
        [admin.tenantId]
      );
    }
    return ok({ workload: rows.filter((r) => r.open_matters > 0 || r.id !== null) });
  } catch (error) {
    return fail(error);
  }
}
