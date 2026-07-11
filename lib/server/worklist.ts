/**
 * The canonical taskpane worklist — the "what needs me today" list, source-agnostic and
 * independent of whether an email is open. Two buckets:
 *
 *   CHASE       — matters where the firm sent the last word and it's gone quiet
 *                 (derived live; see chase.ts / detectChases).
 *   DRAFT_READY — a reply OR a doc-received acknowledgement that CONVEYi has drafted into
 *                 Outlook Drafts and is waiting for the user to review & send (worklist_item
 *                 rows, populated at the draft-creation hooks — incl. portal/manual uploads via
 *                 processMatterFile, which have no inbound email).
 *
 * Everything is best-effort / guarded so a deploy before migration 035 can't break the
 * underlying draft creation or doc filing — the worklist just starts populating once it exists.
 */
import { query } from './db';
import { detectChases } from './chase';

// Backstop for pre-existing / mis-classified tasks: an item where we're waiting on another
// party ("Client to provide…", "Awaiting mortgage offer") is a status we chase, not our task.
export function isWaitingOnOthers(s: string): boolean {
  const t = (s ?? '').trim().toLowerCase();
  if (/^(firm|we |us |our |conveyancer|fee earner)/.test(t)) return false; // explicitly ours
  if (/^(await|awaiting|pending)\b/.test(t)) return true;
  return /^(the )?(client|buyer|seller|purchaser|vendor|applicant|borrower|lender|bank|building society|estate agent|agent|other side|counterpart|third part)[a-z' ]*\bto\b/.test(t);
}

export type WorklistKind = 'CHASE' | 'DRAFT_READY' | 'TASK';

export interface WorklistEntry {
  id: string; // worklist_item id for DRAFT_READY; the thread id for CHASE
  kind: WorklistKind;
  matterId: string;
  matterRef: string;
  propertyAddress: string | null;
  title: string;
  detail: string | null;
  ageDays: number;
  threadId?: string | null; // CHASE: the thread to snooze; DRAFT_READY: its thread if it's a reply
  graphMessageId?: string | null; // the ready draft to send (DRAFT_READY)
  keyDate?: string | null; // the matter's nearest exchange/completion target — drives urgency
  urgent?: boolean; // key date OR task due within a week: sorts to the very top
  due?: string | null; // TASK: the task's own due date (YYYY-MM-DD), if set
  stage?: string | null; // the matter's current stage — shown as the row's status
}

/** Add (or re-surface) a "ready to send" draft. Idempotent per (tenant, kind, dedupKey). */
export async function addDraftReady(input: {
  tenantId: string;
  matterId: string;
  dedupKey: string;
  title: string;
  detail?: string | null;
  threadId?: string | null;
  graphMessageId?: string | null;
}): Promise<void> {
  try {
    await query(
      `insert into worklist_item (tenant_id, matter_id, kind, dedup_key, title, detail, thread_id, graph_message_id)
       values ($1,$2,'DRAFT_READY',$3,$4,$5,$6,$7)
       on conflict (tenant_id, kind, dedup_key) do update
         set title = excluded.title, detail = excluded.detail,
             thread_id = excluded.thread_id, graph_message_id = excluded.graph_message_id,
             created_at = now(), done_at = null, snoozed_until = null`,
      [input.tenantId, input.matterId, input.dedupKey, input.title, input.detail ?? null, input.threadId ?? null, input.graphMessageId ?? null]
    );
  } catch {
    /* worklist_item not migrated yet — surfacing starts once 035 runs */
  }
}

/**
 * The merged worklist — chases + ready-to-send drafts, most overdue first.
 * `assignedToUserId` null = whole firm ("Team"); a user id = only their matters ("My worklist").
 */
export async function getWorklist(tenantId: string, assignedToUserId?: string | null): Promise<WorklistEntry[]> {
  const chases = await detectChases(tenantId, undefined, assignedToUserId);
  const chaseEntries: WorklistEntry[] = chases.map((c) => ({
    id: c.threadId,
    kind: 'CHASE',
    matterId: c.matterId,
    matterRef: c.matterRef,
    propertyAddress: c.propertyAddress,
    // Descriptive: who we're chasing + about what, e.g. "Chase Croft & Hargreaves — no reply".
    title: `Chase ${c.chaseTo ? c.chaseTo : 'for a reply'}`,
    detail: c.subject,
    ageDays: c.ageDays,
    threadId: c.threadId,
  }));

  let draftEntries: WorklistEntry[] = [];
  try {
    const rows = await query<{
      id: string;
      matter_id: string;
      matter_ref: string;
      property_address: string | null;
      title: string;
      detail: string | null;
      thread_id: string | null;
      created_at: string;
    }>(
      `select w.id, w.matter_id, w.title, w.detail, w.thread_id, w.graph_message_id, w.created_at,
              m.matter_ref, m.property_address
         from worklist_item w
         join matter m on m.id = w.matter_id
        where w.tenant_id = $1 and w.kind = 'DRAFT_READY'
          and w.done_at is null
          and coalesce(w.snoozed_until, to_timestamp(0)) < now()
          and m.status = 'OPEN'
          and ($2::uuid is null or m.assigned_to = $2::uuid)
        order by w.created_at asc`,
      [tenantId, assignedToUserId ?? null]
    );
    const now = Date.now();
    draftEntries = rows.map((r) => ({
      id: r.id,
      kind: 'DRAFT_READY',
      matterId: r.matter_id,
      matterRef: r.matter_ref,
      propertyAddress: r.property_address,
      title: r.title,
      detail: r.detail,
      ageDays: Math.floor((now - new Date(r.created_at).getTime()) / 86_400_000),
      threadId: r.thread_id,
      graphMessageId: (r as any).graph_message_id ?? null,
    }));
  } catch {
    /* not migrated yet */
  }

  // Open matter tasks — the matter's own to-do list, folded into the one plate view so
  // "what needs you" is genuinely everything, not just email. Best-effort; capped so a
  // pathological matter can't flood the queue.
  let taskEntries: WorklistEntry[] = [];
  try {
    const rows = await query<{
      id: string;
      matter_id: string;
      detail: string;
      due: string | null;
      created_at: string;
      matter_ref: string;
      property_address: string | null;
    }>(
      `select t.id, t.matter_id, t.detail, t.due, t.created_at, m.matter_ref, m.property_address
         from matter_task t
         join matter m on m.id = t.matter_id
        where t.tenant_id = $1
          and t.status in ('OPEN','IN_PROGRESS')
          and t.type <> 'EMAIL'
          and m.status = 'OPEN'
          and ($2::uuid is null or m.assigned_to = $2::uuid or t.assignee_user_id = $2::uuid)
        order by t.created_at asc
        limit 300`,
      [tenantId, assignedToUserId ?? null]
    );
    const now = Date.now();
    taskEntries = rows.filter((r) => !isWaitingOnOthers(r.detail)).map((r) => ({
      id: r.id,
      kind: 'TASK',
      matterId: r.matter_id,
      matterRef: r.matter_ref,
      propertyAddress: r.property_address,
      title: r.detail,
      detail: null,
      ageDays: Math.floor((now - new Date(r.created_at).getTime()) / 86_400_000),
      due: ((): string | null => {
        if (!r.due) return null;
        const t = new Date(r.due).getTime();
        return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
      })(),
    }));
  } catch {
    /* matter_task absent / not readable — worklist still works without tasks */
  }

  // Rank by urgency (the "here's your plate, in priority order" queue):
  //   1. anything with an exchange/completion target OR task due within a week — soonest first,
  //   2. overdue chases (oldest first),
  //   3. ready-to-send drafts (quick wins),
  //   4. open tasks, then everything else, oldest first.
  const entries = [...draftEntries, ...chaseEntries, ...taskEntries];
  const matterIds = [...new Set(entries.map((e) => e.matterId).filter(Boolean))];
  const keyDates: Record<string, number> = {};
  const stages: Record<string, string> = {};
  if (matterIds.length) {
    try {
      const rows = await query<{ id: string; d: string | null; stage: string | null }>(
        `select id, stage, least(coalesce(exchange_target_date, 'infinity'::date), coalesce(completion_target_date, 'infinity'::date)) as d
           from matter where tenant_id = $1 and id = any($2::uuid[])`,
        [tenantId, matterIds]
      );
      // Store only genuinely finite dates: 'infinity'::date comes back as the string
      // "infinity" OR the number Infinity depending on the driver — both yield a NON-finite
      // timestamp, which would later make new Date(kd).toISOString() throw "Invalid time value"
      // and take down the whole worklist. Guard with Number.isFinite, not a fragile regex.
      for (const r of rows) {
        if (r.stage) stages[r.id] = r.stage;
        if (!r.d) continue;
        const t = new Date(r.d as any).getTime();
        if (Number.isFinite(t)) keyDates[r.id] = t;
      }
    } catch {
      /* dates unreadable — fall back to age-only ranking */
    }
  }
  const now = Date.now();
  const DAY = 86_400_000;
  // The soonest hard deadline on an entry: the matter's exchange/completion target, or —
  // for a task — its own due date, whichever is nearer.
  const soonestMs = (e: WorklistEntry): number | undefined => {
    const kd = e.matterId ? keyDates[e.matterId] : undefined;
    const due = e.due ? new Date(e.due).getTime() : undefined;
    const vals = [kd, due].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? Math.min(...vals) : undefined;
  };
  const score = (e: WorklistEntry): number => {
    const soon = soonestMs(e);
    const daysToDeadline = soon !== undefined ? (soon - now) / DAY : Infinity;
    if (daysToDeadline <= 7) return daysToDeadline; // 0..7 — imminent deadline, soonest first
    if (e.kind === 'CHASE' && e.ageDays >= 5) return 100 - Math.min(e.ageDays, 60); // overdue chases
    if (e.kind === 'DRAFT_READY') return 200 - Math.min(e.ageDays, 60); // ready wins
    if (e.kind === 'TASK') return 250 - Math.min(e.ageDays, 60); // open to-dos
    return 300 - Math.min(e.ageDays, 60);
  };
  for (const e of entries) {
    if (e.matterId && stages[e.matterId]) e.stage = stages[e.matterId];
    const kd = e.matterId ? keyDates[e.matterId] : undefined;
    if (kd !== undefined && Number.isFinite(kd)) e.keyDate = new Date(kd).toISOString().slice(0, 10);
    const soon = soonestMs(e);
    if (soon !== undefined) e.urgent = (soon - now) / DAY <= 7;
  }
  return entries.sort((a, b) => score(a) - score(b));
}

/** Mark a DRAFT_READY item done (user dismissed / already sent). */
export async function dismissWorklistItem(tenantId: string, id: string): Promise<void> {
  await query(`update worklist_item set done_at = now() where tenant_id = $1 and id = $2`, [tenantId, id]).catch(() => {});
}

/** Snooze a DRAFT_READY item for `days`. */
export async function snoozeWorklistItem(tenantId: string, id: string, until: Date): Promise<void> {
  await query(`update worklist_item set snoozed_until = $3 where tenant_id = $1 and id = $2`, [tenantId, id, until.toISOString()]).catch(
    () => {}
  );
}

/** When a thread's reply has actually been SENT, clear its ready-to-send item (called by the chase sweep). */
export async function clearDraftReadyForThread(tenantId: string, threadId: string): Promise<void> {
  await query(
    `update worklist_item set done_at = now()
      where tenant_id = $1 and kind = 'DRAFT_READY' and thread_id = $2 and done_at is null`,
    [tenantId, threadId]
  ).catch(() => {});
}
