/**
 * Microsoft To Do spoke of the task sync (docs/two-way-sync-design.md).
 *
 * Postgres `matter_task` is the hub. Here we PUSH a task into the assignee's To Do
 * (their personal mailbox) and PULL their To Do edits back — the third surface next
 * to our views and the Excel tracker. Everything is best-effort and gated on the
 * Tasks.ReadWrite scope: with no consent every call is a silent no-op, so this is
 * dormant (and safe) until the firm re-consents.
 */
import { queryOne, query } from './db';
import { config } from './config';
import { ensureTodoList, upsertTodoTask, todoListDelta } from './graph';
import type { SessionUser } from './types';

const tasksScope = () => config.graphScopes.includes('Tasks.ReadWrite');

/** The user's CONVEYi To Do list id, creating + remembering it on first use. */
async function listIdFor(userId: string): Promise<string | null> {
  const row = await queryOne<{ todo_list_id: string | null }>(`select todo_list_id from app_user where id = $1`, [userId]);
  if (row?.todo_list_id) return row.todo_list_id;
  const listId = await ensureTodoList(userId);
  if (listId) await query(`update app_user set todo_list_id = $1 where id = $2`, [listId, userId]);
  return listId;
}

interface TaskLike {
  id: string;
  detail: string;
  status: string;
  due: string | null;
  assignee_user_id: string | null;
}

/**
 * Push a matter task into the assignee's To Do (or the actor's if unassigned). On a
 * reassignment we create a fresh To Do task in the new owner's list (the old one is
 * left as a harmless orphan for now). Never throws — the task is safe in Postgres.
 */
export async function mirrorTaskToTodo(user: SessionUser, matterId: string, task: TaskLike): Promise<void> {
  if (!tasksScope()) return;
  try {
    const targetUserId = task.assignee_user_id ?? user.userId;
    const listId = await listIdFor(targetUserId);
    if (!listId) return;

    const existing = await queryOne<{ todo_task_id: string | null; todo_user_id: string | null }>(
      `select todo_task_id, todo_user_id from matter_task where id = $1`,
      [task.id]
    );
    // Only reuse the To Do task id if it lives in THIS target's list.
    const existingId = existing?.todo_user_id === targetUserId ? existing?.todo_task_id ?? undefined : undefined;

    const mref = await queryOne<{ matter_ref: string | null }>(`select matter_ref from matter where id = $1`, [matterId]);
    const title = `${mref?.matter_ref ? mref.matter_ref + ' · ' : ''}${task.detail}`.slice(0, 250);

    const todoId = await upsertTodoTask(targetUserId, listId, { title, status: task.status, due: task.due }, existingId);
    if (todoId) {
      await query(`update matter_task set todo_task_id = $1, todo_user_id = $2, todo_synced_at = now() where id = $3`, [
        todoId,
        targetUserId,
        task.id,
      ]);
    }
  } catch {
    /* best-effort — re-pushes on the next edit */
  }
}

/**
 * End-of-import batch push: mirror every app-first task that hasn't reached To Do yet into the
 * importing user's To Do list, in one pass. Called once when an onboarding import completes, so a
 * bulk import doesn't fan out a Graph call per task mid-provision. Only touches tasks that target
 * THIS user (unassigned, or assigned to them) — we can't write to a colleague's mailbox from here.
 * No-op (and instant) without the Tasks.ReadWrite scope. Best-effort; returns how many it pushed.
 */
export async function flushUnsyncedTasksToTodo(user: SessionUser, opts: { max?: number } = {}): Promise<number> {
  if (!tasksScope()) return 0;
  const max = opts.max ?? 500;
  try {
    const rows = await query<TaskLike & { matter_id: string }>(
      `select id, matter_id, detail, status, due, assignee_user_id
         from matter_task
        where tenant_id = $1
          and todo_task_id is null
          and status in ('OPEN','IN_PROGRESS')
          and (assignee_user_id is null or assignee_user_id = $2)
        order by created_at asc
        limit $3`,
      [user.tenantId, user.userId, max]
    );
    let pushed = 0;
    for (const t of rows) {
      await mirrorTaskToTodo(user, t.matter_id, t);
      pushed += 1;
    }
    return pushed;
  } catch {
    return 0; // best-effort — the tasks are safe in Postgres, next edit re-pushes
  }
}

/**
 * Pull a user's To Do edits back into matter_task, keyed by todo_task_id. Applies a
 * status change only if the To Do task changed AFTER our last confirmed push
 * (last-write-wins, the same guard the Excel spoke uses), so our own echoes are
 * ignored. Stores the delta cursor for next time. Best-effort.
 */
export async function syncFromTodo(userId: string): Promise<void> {
  if (!tasksScope()) return;
  try {
    const u = await queryOne<{ todo_list_id: string | null; todo_delta_link: string | null }>(
      `select todo_list_id, todo_delta_link from app_user where id = $1`,
      [userId]
    );
    if (!u?.todo_list_id) return;

    const { tasks, deltaLink } = await todoListDelta(userId, u.todo_list_id, u.todo_delta_link);
    for (const t of tasks) {
      if (!t?.id) continue;
      const row = await queryOne<{ id: string; status: string; todo_synced_at: string | null }>(
        `select id, status, todo_synced_at from matter_task where todo_task_id = $1`,
        [t.id]
      );
      if (!row) continue; // a task the user made by hand in To Do — not ours to touch
      const changedAt = t.lastModifiedDateTime ? new Date(t.lastModifiedDateTime).getTime() : 0;
      const synced = row.todo_synced_at ? new Date(row.todo_synced_at).getTime() : 0;
      if (changedAt <= synced) continue; // our own push echoing back
      // Only take the two states a person actually sets in To Do; don't downgrade.
      const next = t.status === 'completed' ? 'DONE' : t.status === 'inProgress' ? 'IN_PROGRESS' : row.status;
      if (next !== row.status) {
        await query(`update matter_task set status = $1, source = 'TODO', updated_at = now(), todo_synced_at = now() where id = $2`, [next, row.id]);
      }
    }
    if (deltaLink) await query(`update app_user set todo_delta_link = $1 where id = $2`, [deltaLink, userId]);
  } catch {
    /* best-effort */
  }
}
