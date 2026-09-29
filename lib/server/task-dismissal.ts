/**
 * Dismissing a task: it leaves the tray (the Tasks page, the case's Tasks tab and the counts) but
 * nothing about the case changes, and it can be restored from Dismissed. Before migration 113
 * there is no table: nothing is hidden and dismissing says so.
 */
import { query, queryOne } from './db';
import type { SessionUser } from './types';

export interface Dismissed { id: string; matterId: string; ref: string; title: string | null; dismissedAt: string; dismissedBy: string | null; matterRef: string | null; propertyAddress: string | null }

/** The live dismissals, keyed "matterId|ref". */
export async function dismissedRefs(tenantId: string, matterId: string | null = null): Promise<Set<string>> {
  const rows = await query<{ matter_id: string; ref: string }>(`select matter_id, ref from task_dismissal where tenant_id = $1 and restored_at is null and ($2::uuid is null or matter_id = $2::uuid)`, [tenantId, matterId]).catch(() => []);
  return new Set(rows.map((r) => `${r.matter_id}|${r.ref}`));
}

export async function listDismissed(tenantId: string, matterId: string | null = null): Promise<Dismissed[]> {
  return query<{ id: string; matter_id: string; ref: string; title: string | null; dismissed_at: string; who: string | null; matter_ref: string | null; property_address: string | null }>(
    `select d.id, d.matter_id, d.ref, d.title, d.dismissed_at::text, coalesce(u.display_name, u.email) as who, m.matter_ref, m.property_address
       from task_dismissal d left join app_user u on u.id = d.dismissed_by left join matter m on m.id = d.matter_id
      where d.tenant_id = $1 and d.restored_at is null and ($2::uuid is null or d.matter_id = $2::uuid)
      order by d.dismissed_at desc limit 200`,
    [tenantId, matterId]
  ).then((rows) => rows.map((r) => ({ id: r.id, matterId: r.matter_id, ref: r.ref, title: r.title, dismissedAt: r.dismissed_at, dismissedBy: r.who, matterRef: r.matter_ref, propertyAddress: r.property_address }))).catch(() => []);
}

export async function dismissTask(user: SessionUser, matterId: string, ref: string, title: string | null): Promise<{ id: string }> {
  const row = await queryOne<{ id: string }>(`insert into task_dismissal (tenant_id, matter_id, ref, title, dismissed_by) values ($1, $2, $3, $4, $5) returning id`, [user.tenantId, matterId, ref, title?.slice(0, 300) ?? null, user.userId]).catch((e: Error) => {
    if (/task_dismissal/.test(e.message)) throw Object.assign(new Error('Dismissing tasks needs migration 113.'), { status: 503 });
    throw e;
  });
  return { id: row!.id };
}

export async function restoreTask(user: SessionUser, id: string): Promise<void> {
  await query(`update task_dismissal set restored_at = now() where id = $1 and tenant_id = $2 and restored_at is null`, [id, user.tenantId]);
}
