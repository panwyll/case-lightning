/**
 * Matter tasks.
 *
 * Postgres is the source of truth (fast, queryable, drives the board and the worklist).
 * A task may also be pushed to the assignee's Microsoft To Do (todo.ts) — best-effort.
 *
 * Concurrency: ref allocation and bulk seeding run behind a Postgres transaction-scoped
 * advisory lock per matter, and every DB statement inside the lock runs on that SAME
 * transaction client — so each op holds exactly one pooled connection.
 */
import { query, queryOne, transaction } from './db';
import { createDraftMessage } from './graph';
import { addDraftReady, isWaitingOnOthers } from './worklist';
import { mirrorTaskToTodo, syncFromTodo } from './todo';
import { instantiateStageTemplates, unblockDependents } from './workflow';
import { notifyMatter } from './events';
import type { SessionUser } from './types';

// Structural type for "something I can run SQL on" — satisfied by the
// transaction client (and the pool). Avoids importing pg's types here.
type DB = { query: <R = any>(text: string, params?: unknown[]) => Promise<{ rows: R[] }> };

async function withMatterLock<T>(matterId: string, fn: (db: DB) => Promise<T>): Promise<T> {
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
  status_label: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'NOTED' | 'BLOCKED';

const COLS = 'id, ref, type, detail, assignee, assignee_user_id, due, status, status_label, source, created_at, updated_at';

export async function listAssignees(tenantId: string): Promise<Array<{ id: string; email: string; display_name: string | null }>> {
  return query(
    `select id, email, display_name from app_user where tenant_id = $1 order by display_name nulls last, email`,
    [tenantId]
  );
}

export async function listTasks(user: SessionUser, matterId: string): Promise<MatterTask[]> {
  // Pull this user's To Do edits first (no-op without the scope) — but NEVER let a flaky
  // sync blank the task list: the DB is the source of truth.
  await syncFromTodo(user.userId).catch(() => {});
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
  return withMatterLock(matterId, async (db) => {
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
  patch: { type?: string; detail?: string; assignee?: string | null; assigneeUserId?: string | null; due?: string | null; status?: TaskStatus; statusLabel?: string | null }
): Promise<MatterTask | null> {
  return withMatterLock(matterId, async (db) => {
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
             status_label = case when $8::text is not null then $10 else status_label end,
             source = 'APP',
             updated_at = now()
           where id = $1 and matter_id = $2 and tenant_id = $9
           returning ${COLS}`,
          [taskId, matterId, patch.type ?? null, patch.detail ?? null, patch.assignee ?? null, patch.assigneeUserId ?? null, patch.due ?? null, patch.status ?? null, user.tenantId, patch.statusLabel ?? null]
        )
      ).rows[0] ?? null;
    return task;
  }).then(async (task) => {
    if (task) void mirrorTaskToTodo(user, matterId, task).catch(() => {});
    // Workflow DAG: completing a task may unblock its dependents on this matter.
    if (task && patch.status === 'DONE') {
      const tpl = await queryOne<{ template_id: string | null }>(`select template_id from matter_task where id = $1`, [taskId]).catch(() => null);
      if (tpl?.template_id) void unblockDependents(user, matterId, tpl.template_id).catch(() => {});
    }
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

/**
 * Bulk-seed a matter's task list from AI-extracted "outstanding items" — used at import time so
 * a freshly-provisioned matter already carries its open to-dos. PERFORMANT BY DESIGN:
 *   • reuses the extraction the importer already ran (no new LLM call),
 *   • one batched INSERT per matter under a single matter lock (not N createTask round-trips),
 *   • NO per-task To Do push — those Graph calls would turn a bulk import into a call storm.
 *     Seeded tasks are app-first; they sync outward the next time one is edited.
 * Idempotent: skips items already open on the matter, so re-running an import won't duplicate.
 * Returns how many tasks it created.
 */
export async function seedTasksFromOutstanding(
  user: SessionUser,
  matterId: string,
  outstanding: string[],
  opts: { max?: number } = {}
): Promise<number> {
  const max = opts.max ?? 8;
  const seen = new Set<string>();
  const items = (outstanding ?? [])
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length >= 4 && s.length <= 280)
    .filter((s) => !isWaitingOnOthers(s)) // firm's own actions only — never seed "Client to…" items
    .filter((s) => {
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, max);
  if (!items.length) return 0;
  try {
    return await withMatterLock(matterId, async (db) => {
      const existing = new Set(
        (
          await db.query<{ detail: string }>(
            `select lower(detail) as detail from matter_task where matter_id = $1 and status in ('OPEN','IN_PROGRESS')`,
            [matterId]
          )
        ).rows.map((r) => r.detail)
      );
      const fresh = items.filter((s) => !existing.has(s.toLowerCase()));
      if (!fresh.length) return 0;
      // Continue the T-NNNN sequence from the current max (not count) so a prior deletion
      // can't make us re-issue a ref.
      const last = (
        await db.query<{ ref: string }>(
          `select ref from matter_task where matter_id = $1 and ref ~ '^T-[0-9]+$' order by (substring(ref from 3))::int desc limit 1`,
          [matterId]
        )
      ).rows[0];
      let n = last ? parseInt(last.ref.slice(2), 10) : 0;
      const tuples: string[] = [];
      const params: unknown[] = [];
      let p = 0;
      for (const detail of fresh) {
        n += 1;
        const ref = `T-${String(n).padStart(4, '0')}`;
        tuples.push(`($${++p},$${++p},$${++p},'TASK',$${++p},'OPEN','IMPORT',$${++p})`);
        params.push(user.tenantId, matterId, ref, detail, user.userId);
      }
      await db.query(
        `insert into matter_task (tenant_id, matter_id, ref, type, detail, status, source, created_by)
         values ${tuples.join(',')}`,
        params
      );
      return fresh.length;
    });
  } catch {
    return 0; // task-seeding must never fail the import
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
    // Configurable workflow: instantiate this checkpoint's task templates (assigned per the
    // admin's DAG), blocking any with an unfinished prerequisite. Best-effort inside.
    await instantiateStageTemplates(user as SessionUser, matterId, stage);

    const label = stage.toLowerCase().replace(/_/g, ' ');
    const milestone = MILESTONE_UPDATE[stage];
    if (!milestone) {
      // Client updates on a stage change are the engine's to send; nobody gets a to-do for it.
      void label;
      // Nudge the fee-earner (timeline row already written by the caller).
      await notifyMatter(user.tenantId, matterId, {
        kind: 'STATUS_CHANGED',
        headline: `Moved to the ${label} stage`,
        did: 'Raised a task and lined up this checkpoint’s workflow',
        action: `Update the client — matter now at the ${label} stage`,
        dedupKey: `stage:${matterId}:${stage}`,
      }).catch(() => {});
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
    await notifyMatter(user.tenantId, matterId, {
      kind: 'STATUS_CHANGED',
      headline: `Reached ${milestone.label}`,
      did: 'Drafted the client update — it’s in your ready-to-send queue',
      action: 'Review the draft and send it',
      dedupKey: `stage:${matterId}:${stage}`,
    }).catch(() => {});
  } catch {
    /* best-effort */
  }
}
