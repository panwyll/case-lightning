/**
 * Matter tasks — the "Jira in Excel" core.
 *
 * Postgres is the source of truth (fast, queryable, drives the board). Every
 * write also mirrors to the matter's Tracker.xlsx keyed by a stable `ref`, and
 * reads first reconcile hand edits made directly in Excel back into Postgres —
 * so the conveyancer can work in either surface.
 *
 * Concurrency: Microsoft Graph offers no per-row optimistic concurrency, so two
 * overlapping read-modify-writes could PATCH a stale Excel row index and clobber
 * the wrong task. All tracker read-modify-write for a matter is therefore
 * serialised behind a Postgres transaction-scoped advisory lock, and every DB
 * statement inside the lock runs on that SAME transaction client — so each op
 * holds exactly one pooled connection and can't deadlock the pool while it waits
 * on Graph. The Graph calls (Excel) carry no DB connection.
 *
 * NOTE: the Excel side (graph.ts upsert/list) still needs live verification —
 * the Graph workbook API shapes can't be exercised offline.
 */
import { query, queryOne, transaction } from './db';
import { listTrackerRows, upsertTrackerRowByRef, createDraftMessage } from './graph';
import { addDraftReady } from './worklist';
import { mirrorTaskToTodo, syncFromTodo } from './todo';
import type { SessionUser } from './types';

// Structural type for "something I can run SQL on" — satisfied by the
// transaction client (and the pool). Avoids importing pg's types here.
type DB = { query: <R = any>(text: string, params?: unknown[]) => Promise<{ rows: R[] }> };

async function withTrackerLock<T>(matterId: string, fn: (db: DB) => Promise<T>): Promise<T> {
  return transaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [matterId]);
    return fn(client as unknown as DB);
  });
}

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
  excel_synced_at: string | null;
}

export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'NOTED';

const COLS = 'id, ref, type, detail, assignee, assignee_user_id, due, status, source, created_at, updated_at, excel_synced_at';

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

async function trackerItemId(db: DB, tenantId: string, matterId: string): Promise<string | null> {
  const r = await db.query<{ tracker_item_id: string | null }>(
    `select tracker_item_id from matter where id = $1 and tenant_id = $2`,
    [matterId, tenantId]
  );
  return r.rows[0]?.tracker_item_id ?? null;
}

/** Best-effort push of a task into the Excel tracker — never blocks the DB write. */
async function mirrorToExcel(db: DB, user: SessionUser, matterId: string, task: MatterTask): Promise<void> {
  const itemId = await trackerItemId(db, user.tenantId, matterId);
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
    await db.query(`update matter_task set excel_synced_at = now() where id = $1`, [task.id]);
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

/**
 * Pull hand edits from Excel back into Postgres. Conflict policy: an app change
 * wins until we've confirmed it into Excel (updated_at <= excel_synced_at);
 * after that, a differing Excel cell is a human edit and wins. This both lets
 * the lawyer edit live in Excel AND stops a failed mirror from reverting a fresh
 * app change on the next read. Serialised per matter so it can't race a write.
 */
export async function syncFromTracker(user: SessionUser, matterId: string): Promise<void> {
  await withTrackerLock(matterId, async (db) => {
    const itemId = await trackerItemId(db, user.tenantId, matterId);
    if (!itemId) return;
    let rows: Awaited<ReturnType<typeof listTrackerRows>>;
    try {
      rows = await listTrackerRows(user.userId, itemId);
    } catch {
      return; // tracker unreadable (e.g. legacy without a Ref column yet) — skip silently
    }
    const tasks = (await db.query<MatterTask>(`select ${COLS} from matter_task where matter_id = $1 and tenant_id = $2`, [matterId, user.tenantId])).rows;
    const byRef = new Map(tasks.map((t) => [t.ref, t]));
    for (const r of rows) {
      if (!r.ref) continue; // hand-added row with no ref — left for a future "adopt" pass
      const t = byRef.get(r.ref);
      if (!t) continue; // unknown ref — don't import header/noise rows

      // App change not yet confirmed in Excel: don't let stale Excel clobber it —
      // re-push it forward instead (idempotent), then move on.
      const synced = t.excel_synced_at ? new Date(t.excel_synced_at).getTime() : 0;
      if (new Date(t.updated_at).getTime() > synced) {
        await mirrorToExcel(db, user, matterId, t);
        continue;
      }

      const status = r.status ? normaliseStatus(r.status) : t.status;
      const detail = r.detail || t.detail;
      const assignee = r.owner || t.assignee;
      const due = r.due ? dateStr(r.due) : dateStr(t.due);
      const changed =
        status !== t.status || detail !== t.detail || (assignee || '') !== (t.assignee || '') || due !== dateStr(t.due);
      if (changed) {
        await db.query(
          `update matter_task set status = $1, detail = $2, assignee = $3, due = nullif($4,'')::date, source = 'EXCEL', updated_at = now(), excel_synced_at = now() where id = $5`,
          [status, detail, assignee || null, due, t.id]
        );
      }
    }
  });
}

export async function listTasks(user: SessionUser, matterId: string): Promise<MatterTask[]> {
  await syncFromTracker(user, matterId); // reconcile live Excel edits first
  await syncFromTodo(user.userId).catch(() => {}); // then pull this user's To Do edits (no-op without the scope)
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
  return withTrackerLock(matterId, async (db) => {
    // Safe under the per-matter lock: no other create can interleave, so the ref
    // can't collide. Derive from max(ref) (not count) so a deletion can't make us
    // re-issue an existing T-NNNN.
    const last = (
      await db.query<{ ref: string }>(
        `select ref from matter_task where matter_id = $1 and ref ~ '^T-[0-9]+$' order by (substring(ref from 3))::int desc limit 1`,
        [matterId]
      )
    ).rows[0];
    const lastN = last ? parseInt(last.ref.slice(2), 10) : 0;
    const ref = `T-${String(lastN + 1).padStart(4, '0')}`;
    const task = (
      await db.query<MatterTask>(
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
      )
    ).rows[0];
    await mirrorToExcel(db, user, matterId, task);
    return task;
  }).then(async (task) => {
    // Push to the assignee's To Do outside the per-matter lock (a Graph call
    // shouldn't extend the lock hold). Best-effort; no-op without the scope.
    void mirrorTaskToTodo(user, matterId, task).catch(() => {});
    return task;
  });
}

export async function updateTask(
  user: SessionUser,
  matterId: string,
  taskId: string,
  patch: { type?: string; detail?: string; assignee?: string | null; assigneeUserId?: string | null; due?: string | null; status?: TaskStatus }
): Promise<MatterTask | null> {
  return withTrackerLock(matterId, async (db) => {
    const task =
      (
        await db.query<MatterTask>(
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
        )
      ).rows[0] ?? null;
    if (task) await mirrorToExcel(db, user, matterId, task);
    return task;
  }).then(async (task) => {
    if (task) void mirrorTaskToTodo(user, matterId, task).catch(() => {});
    return task;
  });
}

/**
 * Proactively raise a "you need to do this" task when something meaningful happens on a
 * matter — a stage moves, a substantive document lands. This is the assistant being on
 * top of things: the action shows up on the board / task list without anyone typing it.
 *
 * Deduped so we NEVER hammer: if an open task with the same detail already exists on the
 * matter, we skip. source='AUTO' marks it as CONVEYi-raised. Best-effort — a task-raise
 * must never break the thing that triggered it (a doc upload, a stage change).
 */
export async function autoActionTask(
  user: { userId: string; tenantId: string; email?: string; role?: string },
  matterId: string,
  detail: string
): Promise<void> {
  try {
    const dup = await query<{ id: string }>(
      `select id from matter_task where matter_id = $1 and tenant_id = $2 and detail = $3 and status in ('OPEN','IN_PROGRESS') limit 1`,
      [matterId, user.tenantId, detail]
    );
    if (dup.length) return;
    await createTask(user as SessionUser, matterId, { type: 'UPDATE', detail, source: 'AUTO', status: 'OPEN' });
  } catch {
    /* best-effort — never block the triggering action */
  }
}

// The "tell the client" milestones where CONVEYi pre-drafts the update itself (into the
// ready-to-send queue), rather than just raising a task. Templated (no LLM) so it's fast,
// predictable and cheap; blank recipient so the fee-earner reviews + addresses before Send.
const MILESTONE_UPDATE: Record<string, { subject: (ref: string) => string; body: (addr: string) => string; label: string }> = {
  EXCHANGE: {
    label: 'contracts exchanged',
    subject: (ref) => `${ref} — Contracts exchanged`,
    body: (addr) =>
      `<p>Dear Sir or Madam,</p><p>We are pleased to confirm that contracts have now been exchanged${addr ? ` on ${addr}` : ''}. ` +
      `The transaction is now legally binding. We will write again shortly with the arrangements for completion.</p><p>Kind regards</p>`,
  },
  COMPLETION: {
    label: 'completion',
    subject: (ref) => `${ref} — Completion`,
    body: (addr) =>
      `<p>Dear Sir or Madam,</p><p>We are pleased to confirm that completion has now taken place${addr ? ` on ${addr}` : ''}. ` +
      `We will attend to the post-completion formalities and revert with any further requirements.</p><p>Kind regards</p>`,
  },
};

/**
 * Called whenever a matter's stage advances (manual PATCH or email-driven). On a big
 * client-facing milestone (exchange/completion) CONVEYi drafts the update into the
 * ready-to-send queue — the fee-earner just reviews and hits Send. On other stage moves
 * it raises a lightweight task instead of drafting (so we don't email the client on every
 * internal step). Deduped, best-effort.
 */
export async function onStageAdvanced(
  user: { userId: string; tenantId: string; email?: string; role?: string },
  matterId: string,
  stage: string
): Promise<void> {
  try {
    const label = stage.toLowerCase().replace(/_/g, ' ');
    const milestone = MILESTONE_UPDATE[stage];
    if (!milestone) {
      await autoActionTask(user, matterId, `Update the client — matter now at the ${label} stage`);
      return;
    }
    const matter = await queryOne<{ matter_ref: string; property_address: string | null }>(
      `select matter_ref, property_address from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    if (!matter) return;
    const subject = milestone.subject(matter.matter_ref);
    const draft = await createDraftMessage(user.userId, subject, milestone.body(matter.property_address ?? '')).catch(() => null);
    await addDraftReady({
      tenantId: user.tenantId,
      matterId,
      dedupKey: `stage:${stage}`, // one per stage per matter — never re-drafts the same milestone
      title: `Update drafted — ${milestone.label}`,
      detail: subject,
      graphMessageId: (draft?.id as string) ?? null,
    });
  } catch {
    /* best-effort */
  }
}
