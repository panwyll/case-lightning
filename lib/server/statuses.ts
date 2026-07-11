/**
 * Firm-customisable task statuses. A status has a `kind` (OPEN | IN_PROGRESS | DONE) that all
 * logic keys off (worklist filtering, DAG unblock in workflow.ts), and a `name` the firm chooses.
 * matter_task stores the canonical `status` (= kind) plus a `status_label` (the custom name), so
 * no existing query changes — custom statuses are labels-with-a-kind. Guarded/idempotent.
 */
import { query, queryOne } from './db';
import type { SessionUser } from './types';

export type StatusKind = 'OPEN' | 'IN_PROGRESS' | 'DONE';
export interface TaskStatusRow {
  id: string;
  name: string;
  kind: StatusKind;
  color: string | null;
  sort_order: number;
  active: boolean;
}

const DEFAULTS: Array<{ name: string; kind: StatusKind; color: string }> = [
  { name: 'Open', kind: 'OPEN', color: '#64748b' },
  { name: 'In progress', kind: 'IN_PROGRESS', color: '#d97706' },
  { name: 'Done', kind: 'DONE', color: '#16a34a' },
];

export async function ensureDefaultStatuses(tenantId: string): Promise<void> {
  try {
    const t = await queryOne<{ statuses_seeded: boolean }>(`select statuses_seeded from tenant where id = $1`, [tenantId]).catch(() => null);
    if (t?.statuses_seeded) return;
    const n = await queryOne<{ n: number }>(`select count(*)::int as n from task_status where tenant_id = $1`, [tenantId]).catch(() => ({ n: 0 }));
    if ((n?.n ?? 0) === 0) {
      let order = 0;
      for (const d of DEFAULTS) {
        await query(
          `insert into task_status (tenant_id, name, kind, color, sort_order) values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, name) do nothing`,
          [tenantId, d.name, d.kind, d.color, order++]
        ).catch(() => {});
      }
    }
    await query(`update tenant set statuses_seeded = true where id = $1`, [tenantId]).catch(() => {});
  } catch {
    /* best-effort */
  }
}

export async function listStatuses(tenantId: string): Promise<TaskStatusRow[]> {
  try {
    return await query<TaskStatusRow>(
      `select id, name, kind, color, sort_order, active from task_status where tenant_id = $1 and active = true order by sort_order, name`,
      [tenantId]
    );
  } catch {
    return []; // not migrated — callers fall back to the built-in Open/In progress/Done
  }
}

export async function saveStatus(
  user: SessionUser,
  input: { id?: string | null; name: string; kind: StatusKind; color?: string | null; sortOrder?: number; active?: boolean }
): Promise<TaskStatusRow> {
  const vals = [user.tenantId, input.name.trim(), input.kind, input.color ?? null, input.sortOrder ?? 0, input.active ?? true];
  if (input.id) {
    const row = await queryOne<TaskStatusRow>(
      `update task_status set name=$2, kind=$3, color=$4, sort_order=$5, active=$6 where id=$7 and tenant_id=$1
       returning id, name, kind, color, sort_order, active`,
      [...vals, input.id]
    );
    return row!;
  }
  const row = await queryOne<TaskStatusRow>(
    `insert into task_status (tenant_id, name, kind, color, sort_order, active) values ($1,$2,$3,$4,$5,$6)
     on conflict (tenant_id, name) do update set kind=excluded.kind, color=excluded.color, active=excluded.active
     returning id, name, kind, color, sort_order, active`,
    vals
  );
  return row!;
}

export async function deleteStatus(user: SessionUser, id: string): Promise<void> {
  await query(`delete from task_status where id = $1 and tenant_id = $2`, [id, user.tenantId]);
}
