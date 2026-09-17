import { assertFeature, missingFor } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { leapBackendActive, leapConnection } from '@/lib/server/integrations/leap/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Connection state, what was mirrored, and what the last sync did. */
export async function GET() {
  try {
    assertFeature('db');
    const user = await requireUser();
    const conn = await leapConnection(user.tenantId).catch(() => null);
    const counts = await query<{ matters: string; enrolled: string; shadow: string; documents: string; contacts: string; tasks: string; notes: string }>(
      `select
         (select count(*) from matter m where m.tenant_id = $1 and m.leap_matter_id is not null) as matters,
         (select count(*) from matter m join matter_engine_state s on s.matter_id = m.id where m.tenant_id = $1 and m.leap_matter_id is not null) as enrolled,
         (select count(*) from matter m where m.tenant_id = $1 and m.leap_matter_id is not null and m.shadow_mode) as shadow,
         (select count(*) from document d where d.tenant_id = $1 and d.leap_document_id is not null) as documents,
         (select count(*) from matter_contact c where c.tenant_id = $1 and c.leap_card_id is not null) as contacts,
         (select count(*) from leap_writeback w where w.tenant_id = $1 and w.kind = 'task') as tasks,
         (select count(*) from leap_writeback w where w.tenant_id = $1 and w.kind = 'note') as notes`,
      [user.tenantId]
    ).catch(() => []);
    const recent = await query<{ id: string; matter_ref: string; property_address: string; leap_matter_id: string; leap_synced_at: Date | null; shadow_mode: boolean | null; stage: string | null }>(
      `select m.id, m.matter_ref, m.property_address, m.leap_matter_id, m.leap_synced_at, m.shadow_mode, s.stage
         from matter m left join matter_engine_state s on s.matter_id = m.id
        where m.tenant_id = $1 and m.leap_matter_id is not null order by m.leap_synced_at desc nulls last limit 50`,
      [user.tenantId]
    ).catch(() => []);
    const c = counts[0];
    return ok({
      configured: leapBackendActive(),
      missing: missingFor('leap'),
      connection: conn,
      counts: c ? { matters: Number(c.matters), enrolled: Number(c.enrolled), shadow: Number(c.shadow), documents: Number(c.documents), contacts: Number(c.contacts), tasks: Number(c.tasks), notes: Number(c.notes) } : null,
      matters: recent.map((r) => ({ matterId: r.id, matterRef: r.matter_ref, propertyAddress: r.property_address, leapMatterId: r.leap_matter_id, syncedAt: r.leap_synced_at?.toISOString() ?? null, shadowMode: !!r.shadow_mode, stage: r.stage })),
    });
  } catch (error) {
    return fail(error);
  }
}
