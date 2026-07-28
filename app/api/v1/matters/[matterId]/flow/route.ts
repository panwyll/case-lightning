import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { query, queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * This matter's live position on the firm's Case Flow: the same stage/task DAG the admin
 * designed, plus each node's REAL state for this matter (done / open / blocked / not yet
 * reached). Read-only — the editable canvas is the template; this is the status mirror.
 *
 * Tasks are matched to nodes by matter_task.template_id. Anything without one (ad-hoc
 * tasks, or matters created before the workflow existed) comes back in `offFlow` so it
 * is visible rather than silently dropped.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = await params;
    await assertMatterAccess(user, matterId);

    const matter = await queryOne<{ id: string; matter_ref: string; property_address: string | null; stage: string | null }>(
      `select id, matter_ref, property_address, stage from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    if (!matter) throw new Error('Matter not found.');

    const [stages, templates, edges, tasks] = await Promise.all([
      query<{ key: string; name: string; sort_order: number }>(
        `select key, name, sort_order from matter_stage where tenant_id = $1 and active = true order by sort_order, name`,
        [user.tenantId]
      ).catch(() => []),
      // Degrade gracefully if the doc-node column (052) hasn't been applied.
      query<any>(
        `select id, stage, detail, node_kind, pos_x, pos_y, sort_order from task_template
          where tenant_id = $1 and active = true order by sort_order`,
        [user.tenantId]
      ).catch(() => []),
      query<{ from_template_id: string; to_template_id: string }>(
        `select from_template_id, to_template_id from task_template_edge where tenant_id = $1`,
        [user.tenantId]
      ).catch(() => []),
      query<any>(
        `select id, ref, detail, status, assignee, due, template_id, type
           from matter_task where matter_id = $1 and tenant_id = $2 order by created_at`,
        [matterId, user.tenantId]
      ).catch(() => []),
    ]);

    const byTemplate: Record<string, any> = {};
    const offFlow: any[] = [];
    for (const t of tasks) {
      if (t.template_id) byTemplate[t.template_id] = t;
      else offFlow.push(t);
    }

    // Stages the matter has already passed, so the UI can dim what's behind it.
    const order = stages.map((s) => s.key);
    const stageIdx = matter.stage ? order.indexOf(matter.stage) : -1;

    return ok({
      matter: { id: matter.id, matterRef: matter.matter_ref, propertyAddress: matter.property_address, stage: matter.stage },
      stages,
      stageIndex: stageIdx,
      templates,
      edges,
      byTemplate,
      offFlow,
    });
  } catch (error) {
    return fail(error);
  }
}
