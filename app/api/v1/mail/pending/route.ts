import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Tasks list's Pending: emails you filed whose reading is still running (the last half hour), and those finished in the
 * last two minutes, each as `task` (it made one on the case since) or `no_action`. Read-only; the list asks only while
 * something is pending.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const rows = await query<{ message_id: string; matter_id: string | null; subject: string | null; claimed_at: Date; finished_at: Date | null; made_task: boolean; address: string | null; ref: string | null }>(
      `select c.graph_message_id as message_id, c.matter_id, c.subject, c.claimed_at, c.finished_at, m.property_address as address, m.matter_ref as ref,
              exists (select 1 from task_record t where t.matter_id = c.matter_id and t.opened_at >= c.claimed_at - interval '5 seconds') as made_task
         from mail_filing_claim c left join matter m on m.id = c.matter_id
        where c.tenant_id = $1 and c.filed_by = $2 and c.claimed_at > now() - interval '30 minutes'
          and (c.finished_at is null or c.finished_at > now() - interval '2 minutes')
        order by c.claimed_at desc limit 20`,
      [user.tenantId, user.userId]
    ).catch(() => []);
    return ok({
      items: rows.map((r) => ({
        messageId: r.message_id, matterId: r.matter_id, subject: r.subject, address: r.address, ref: r.ref, claimedAt: r.claimed_at.toISOString(),
        state: !r.finished_at ? 'processing' : r.made_task ? 'task' : 'no_action',
      })),
    });
  } catch (e) {
    return fail(e);
  }
}
