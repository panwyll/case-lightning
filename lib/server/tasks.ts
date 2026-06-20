/**
 * Matter tasks — the "Jira in Excel" core.
 *
 * Postgres is the source of truth (fast, queryable, drives the board). Every
 * write also mirrors to the matter's Tracker.xlsx keyed by a stable `ref`, and
 * reads first reconcile hand edits made directly in Excel back into Postgres —
 * so the conveyancer can work in either surface. Excel edits win on read,
 * because that's where the human just typed.
 *
 * NOTE: the Excel side (graph.ts upsert/list) needs live verification against a
 * real workbook — the Graph workbook API shapes can't be exercised offline.
 */
import { query, queryOne } from './db';
import { listTrackerRows, upsertTrackerRowByRef } from './graph';
import type { SessionUser } from './types';

export interface MatterTask {
  id: string;
  ref: string;
  type: string;
  detail: string;
  assignee: string | null;
  assignee_user_id: string | null;
  due: string | null;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'NOTED';

const COLS = 'id, ref, type, detail, assignee, assignee_user_id, due, status, source, created_at, updated_at';

/** Map free-text Excel status (a human may type anything) onto our enum. */
function normaliseStatus(s: string): TaskStatus {
  const t = (s || '').trim().toLowerCase();
  if (/done|complete|closed|resolved/.test(t)) return 'DONE';
  if (/progress|wip|started|doing/.test(t)) return 'IN_PROGRESS';
  if (/noted|fyi/.test(t)) return 'NOTED';
  return 'OPEN';
}

/** Human-friendly status for the Excel cell. */
function statusDisplay(s: string): string {
  return s === 'IN_PROGRESS' ? 'In progress' : s.charAt(0) + s.slice(1).toLowerCase();
}

function dateStr(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

async function trackerItemId(tenantId: string, matterId: string): Promise<string | null> {
  const m = await queryOne<{ tracker_item_id: string | null }>(
    `select tracker_item_id from matter where id = $1 and tenant_id = $2`,
    [matterId, tenantId]
  );
  return m?.tracker_item_id ?? null;
}

/** Best-effort push of a task into the Excel tracker — never blocks the DB write. */
async function mirrorToExcel(user: SessionUser, matterId: string, task: MatterTask): Promise<void> {
  const itemId = await trackerItemId(user.tenantId, matterId);
  if (!itemId) return;
  try {
    await upsertTrackerRowByRef(user.userId, itemId, {
      ref: task.ref,
      date: dateStr(task.created_at),
      type: task.type,
      detail: task.detail,
      owner: task.assignee ?? '',
      due: dateStr(task.due),
      status: statusDisplay(task.status),
    });
    await query(`update matter_task set excel_synced_at = now() where id = $1`, [task.id]);
  } catch {
    /* a Graph hiccup must not lose the task — it's safe in Postgres, resync later */
  }
}

export async function listAssignees(tenantId: string): Promise<Array<{ id: string; email: string; display_name: string | null }>> {
  return query(
    `select id, email, display_name from app_user where tenant_id = $1 order by display_name nulls last, email`,
    [tenantId]
  );
}

/** Pull hand edits from Excel back into Postgres (Excel wins for known refs). */
export async function syncFromTracker(user: SessionUser, matterId: string): Promise<void> {
  const itemId = await trackerItemId(user.tenantId, matterId);
  if (!itemId) return;
  let rows: Awaited<ReturnType<typeof listTrackerRows>>;
  try {
    rows = await listTrackerRows(user.userId, itemId);
  } catch {
    return; // tracker unreadable (e.g. legacy without a Ref column yet) — skip silently
  }
  const tasks = await query<MatterTask>(`select ${COLS} from matter_task where matter_id = $1 and tenant_id = $2`, [matterId, user.tenantId]);
  const byRef = new Map(tasks.map((t) => [t.ref, t]));
  for (const r of rows) {
    if (!r.ref) continue; // hand-added row with no ref — left for a future "adopt" pass
    const t = byRef.get(r.ref);
    if (!t) continue; // unknown ref — don't import header/noise rows
    const status = r.status ? normaliseStatus(r.status) : t.status;
    const detail = r.detail || t.detail;
    const assignee = r.owner || t.assignee;
    const due = r.due ? dateStr(r.due) : dateStr(t.due);
    const changed =
      status !== t.status || detail !== t.detail || (assignee || '') !== (t.assignee || '') || due !== dateStr(t.due);
    if (changed) {
      await query(
        `update matter_task set status = $1, detail = $2, assignee = $3, due = nullif($4,'')::date, source = 'EXCEL', updated_at = now(), excel_synced_at = now() where id = $5`,
        [status, detail, assignee || null, due, t.id]
      );
    }
  }
}

export async function listTasks(user: SessionUser, matterId: string): Promise<MatterTask[]> {
  await syncFromTracker(user, matterId); // reconcile live Excel edits first
  return query<MatterTask>(
    `select ${COLS} from matter_task where matter_id = $1 and tenant_id = $2
     order by case status when 'OPEN' then 0 when 'IN_PROGRESS' then 1 when 'NOTED' then 2 else 3 end,
              due nulls last, created_at`,
    [matterId, user.tenantId]
  );
}

export async function createTask(
  user: SessionUser,
  matterId: string,
  input: {
    type?: string;
    detail: string;
    assignee?: string | null;
    assigneeUserId?: string | null;
    due?: string | null;
    status?: TaskStatus;
    source?: string;
  }
): Promise<MatterTask> {
  const cnt = await queryOne<{ n: number }>(`select count(*)::int as n from matter_task where matter_id = $1`, [matterId]);
  const ref = `T-${String((cnt?.n ?? 0) + 1).padStart(4, '0')}`;
  const task = await queryOne<MatterTask>(
    `insert into matter_task (tenant_id, matter_id, ref, type, detail, assignee, assignee_user_id, due, status, source, created_by)
     values ($1,$2,$3,$4,$5,$6,$7, nullif($8,'')::date, $9, $10, $11)
     returning ${COLS}`,
    [
      user.tenantId,
      matterId,
      ref,
      input.type ?? 'TASK',
      input.detail,
      input.assignee ?? null,
      input.assigneeUserId ?? null,
      input.due ?? '',
      input.status ?? 'OPEN',
      input.source ?? 'APP',
      user.userId,
    ]
  );
  await mirrorToExcel(user, matterId, task!);
  return task!;
}

export async function updateTask(
  user: SessionUser,
  matterId: string,
  taskId: string,
  patch: { type?: string; detail?: string; assignee?: string | null; assigneeUserId?: string | null; due?: string | null; status?: TaskStatus }
): Promise<MatterTask | null> {
  const task = await queryOne<MatterTask>(
    `update matter_task set
       type = coalesce($3, type),
       detail = coalesce($4, detail),
       assignee = coalesce($5, assignee),
       assignee_user_id = coalesce($6, assignee_user_id),
       due = coalesce(nullif($7,'')::date, due),
       status = coalesce($8, status),
       source = 'APP',
       updated_at = now()
     where id = $1 and matter_id = $2 and tenant_id = $9
     returning ${COLS}`,
    [taskId, matterId, patch.type ?? null, patch.detail ?? null, patch.assignee ?? null, patch.assigneeUserId ?? null, patch.due ?? null, patch.status ?? null, user.tenantId]
  );
  if (task) await mirrorToExcel(user, matterId, task);
  return task;
}
