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
    const cols = `a.id, a.created_at, a.action_type, a.action_status, a.payload, a.matter_id, a.request_id, a.trace_id,
                  coalesce(u.display_name, u.email) as actor_name, coalesce(b.display_name, b.email) as acting_name, m.matter_ref`;
    const from = `from audit_log a
                  left join app_user u on u.id = a.actor_user_id
                  left join app_user b on b.id = a.acting_user_id
                  left join matter m on m.id = a.matter_id`;
    // The engine's own log joins the audit: what it proposed, what people approved or declined,
    // what moved, and every money or bank-details step. Read-only view; the event log stays canonical.
    const engineTypes = `('action_proposed','action_approved','action_rejected','action_failed','action_suppressed','auto_clear_proposed','auto_clear_review_raised','auto_clear_confirmed','stage_advanced','manual_handling_required','search_ordered','chase_sent','acknowledgement_sent','client_update_sent','escalation_raised','escalation_resolved','bank_details_recorded','bank_details_change_flagged','bank_details_verified','bank_details_verification_failed','payment_authorised')`;
    const ecols = `e.id, e.created_at, 'ENGINE_' || upper(e.type) as action_type,
                   case e.type when 'action_failed' then 'FAILED' when 'action_rejected' then 'BLOCKED' when 'action_suppressed' then 'BLOCKED' when 'bank_details_verification_failed' then 'FAILED' else 'SUCCESS' end as action_status,
                   e.payload, e.matter_id, null::text as request_id, null::text as trace_id,
                   case when e.actor = 'system' then 'Engine' when e.actor = 'ai' then 'AI' when e.actor = 'external' then 'External' else coalesce(u.display_name, u.email) end as actor_name,
                   null::text as acting_name, m.matter_ref`;
    const efrom = `from matter_event e
                   left join app_user u on u.id::text = e.actor
                   left join matter m on m.id = e.matter_id`;
    const ewhere = `(e.type in ${engineTypes} or (e.payload ? 'decisionEventId' and e.type <> 'decision_source_opened'))`;
    const rows = matterId
      ? await query(
          `select * from (
             select ${cols} ${from} where a.tenant_id = $1 and a.matter_id = $2
             union all
             select ${ecols} ${efrom} where e.tenant_id = $1 and e.matter_id = $2 and ${ewhere}
           ) x order by created_at desc limit $3`,
          [user.tenantId, matterId, limit]
        )
      : await query(
          `select * from (
             select ${cols} ${from} where a.tenant_id = $1
             union all
             select ${ecols} ${efrom} where e.tenant_id = $1 and ${ewhere}
           ) x order by created_at desc limit $2`,
          [user.tenantId, limit]
        );
    return ok({ logs: rows });
  } catch (error) {
    return fail(error);
  }
}
