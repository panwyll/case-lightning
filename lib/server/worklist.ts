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

export type WorklistKind = 'CHASE' | 'DRAFT_READY';

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
    title: 'Chase — no reply yet',
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

  // Ready-to-send first (the fastest wins — the work is already done), then chases; oldest first within each.
  return [...draftEntries, ...chaseEntries];
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
